/*
   Drag-and-Drop API – Usage Guide
   =========================================================================

   Edge drop indicators (list sorting):
     - Pass `allowedEdges={['top','bottom']}` (or left/right) on `DraggableItem`
     - Render `<DropIndicator gap="…"/>` inside a `position: relative` child
     - `onDrop` receives `closestEdge` — use `getReorderDestinationIndex` for index

   1.  Wrap your tree once with `DragAndDropProvider`.
       - `instanceId`               : unique string for this provider
       - `onDrop`                   : (payload) => void – receives the drop

       Example:
         <DragAndDropProvider
           instanceId="board-1"
           onDrop={({ sourceId, targetId, sourceData, targetData, closestEdge }) => {
             moveCard(sourceId, targetId);
           }}
         >
           <Board/>
         </DragAndDropProvider>

   2.  Make something draggable → `DraggableItem`
       - `id`                       : unique within this provider
       - `type`                     : string, defaults to "item"
       - `data`                     : any serialisable payload you need back
       - `allowedEdges`             : Edge[] — enables closest-edge hitbox
       - `children`                 : render prop (state, ref, closestEdge) => JSX
            * `state()`             : 'idle' | 'dragging' | 'over'
            * `ref(el)`             : attach the DOM node
            * `closestEdge()`       : Edge | null (when allowedEdges set)

       Example:
         <DraggableItem id={card.id} data={card} allowedEdges={['top', 'bottom']}>
           {(state, ref) => (
             <div ref={ref} class={`relative ${state() === 'dragging' ? 'opacity-50' : ''}`}>
               {card.title}
               <DropIndicator gap="8px" />
             </div>
           )}
         </DraggableItem>

   3.  Make something accept drops → `Droppable`
       - `id`                       : unique within this provider
       - `type`                     : string | string[], defaults to "item"
       - `data`                     : any payload you want back when you
                                      look up the target in `onDrop`
       - `canDrop(sourceData)`      : optional guard
       - `allowedEdges`             : Edge[] — same as DraggableItem
       - `children`                 : same render prop signature as above

       Example:
         <Droppable id={column.id} data={column} canDrop={() => true}>
           {(state, ref) => (
             <div ref={ref} class={state() === 'over' ? 'bg-blue-100' : ''}>
               {cards}
             </div>
           )}
         </Droppable>

         4.  Cross-provider drops
             - Use separate providers (with different `instanceId`s) when you need
               to distinguish between different logical containers (e.g., different
               Trello boards or separate applications).
             - For moving items between lists within the same container (e.g., columns
               on the same Trello board), use a single provider with multiple
               `DraggableItem` and `Droppable` components.
             - When using the same provider, `sourceInstanceId` and `targetInstanceId`
               will be identical, but you can distinguish lists using the `data` prop
               of the source and target components.
             - The current setup supports both scenarios: same-provider moves (where
               you handle logic using the `data` props) and cross-provider drops
               (where you handle logic using both the `data` props and instance IDs).
               - YES, It's possible to perform cross-list (same provider) swapping,
                 sorting, or moving with this setup. In the `onDrop` callback, you'll
                 receive both the source and target data objects. These objects are exactly
                 what you passed in via the `data` props of the `DraggableItem` and
                 `Droppable` components. This means if you need to track which list an
                 item belongs to, you should include that information in the `data` prop
                 when creating your components.

               Example: When creating a card in a specific column, you might pass:
                 <DraggableItem id={card.id} data={{ ...card, listId: column.id }}>

               Then in your `onDrop` handler, you can access both the item data and
               list identifier to properly handle the move between lists within the
               same provider.

      ```

   5.  Registry
       - Automatically populated on mount/unmount – you never touch it.
       - Used internally to look up full `data` objects after a drop.

   6.  TypeScript
       - Everything is typed; the render-prop generics infer the correct
         signatures.  No casts needed.

   That's it—compose as many `DraggableItem` and `Droppable` components as
   you like; the provider handles the rest.
 */

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine"
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter"
import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge"
import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/types"
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type FlowProps,
  type JSX,
  onCleanup,
  useContext,
} from "solid-js"

/* ---------- 1. Context ---------- */

export type OnDropEvent = {
  /** Closest edge of the drop target (when `allowedEdges` is set). */
  closestEdge: Edge | null
  sourceId: string | number
  targetId: string | number
  /** Never typesafe, there's no way to infer from internal items. Make sure to cast. */
  sourceData: any
  /** Never typesafe, there's no way to infer from internal items. Make sure to cast. */
  targetData: any
  /** Mostly no point, it's the same anyway as instanceId anyway. Just for debugging. */
  sourceInstanceId: string | null
  /** Mostly no point, it's the same anyway as instanceId anyway. Just for debugging. */
  targetInstanceId: string | null
}

export type OnDropHandler = (event: OnDropEvent) => void

type DragAndDropContextValue = {
  /** Unique identifier for this drag-and-drop instance. */
  instanceId: string
  /**
   * In-memory lookup registry for all draggable and droppable components in this provider.
   * The registry serves as a central reference that maps component IDs to their full data payloads.
   * During drag operations, only minimal source data (like IDs) is transferred for performance.
   * When a drop occurs, the registry is used to retrieve the complete data objects associated
   * with both the source (dragged item) and target (drop location) using their respective IDs.
   * This ensures the consumer's `onDrop` callback receives the complete contextual information
   * needed to properly handle the drag-and-drop operation.
   */
  registry: Map<string | number, { id: string | number; data: any }>
}

const DragAndDropContext = createContext<DragAndDropContextValue>()

/** Closest edge under the pointer for the nearest `DraggableItem`/`Droppable`. */
export const ClosestEdgeContext = createContext<Accessor<Edge | null> | undefined>()

export const useDragAndDropContext = () => {
  const ctx = useContext(DragAndDropContext)
  if (!ctx) throw new Error("useDragAndDropContext must be used within <DragAndDropProvider>")
  return ctx
}

export const useClosestEdge = (): Accessor<Edge | null> => {
  const edge = useContext(ClosestEdgeContext)
  if (!edge) return () => null
  return edge
}

type DragAndDropProviderProps = {
  /** Unique identifier for this drag-and-drop instance. */
  instanceId?: string
  onDrop?: OnDropHandler
  onDropTargetChange?: OnDropHandler
}

export const DragAndDropProvider = (props: FlowProps<DragAndDropProviderProps>) => {
  const instanceId = createMemo(
    () => props.instanceId ?? `draginstance-${Math.random().toString(36).substring(2, 9)}`
  )

  const registry = new Map<string | number, { id: string | number; data: any }>()

  createEffect(() => {
    onCleanup(
      monitorForElements({
        canMonitor: ({ source }) => {
          const s = source.data as { instanceId: string }
          return s.instanceId === instanceId()
        },
        onDropTargetChange: ({ source, location }) => {
          if (!props.onDropTargetChange) return
          const target = location.current.dropTargets[0]
          if (!target) return

          const sourceId = (source.data as { id: string | number }).id
          const targetId = (target.data as { id: string | number }).id

          if (sourceId === undefined || targetId === undefined) return

          const sourceEntry = registry.get(sourceId)
          const targetEntry = registry.get(targetId)

          const closestEdge = extractClosestEdge(target.data)
          props.onDropTargetChange({
            sourceId,
            targetId,
            sourceData: sourceEntry?.data,
            targetData: targetEntry?.data,
            sourceInstanceId: (source.data as { instanceId: string }).instanceId,
            targetInstanceId: instanceId(),
            closestEdge,
          })
        },
        onDrop: ({ source, location }) => {
          const target = location.current.dropTargets[0]
          if (!target) return

          const sourceId = (source.data as { id: string | number }).id
          const targetId = (target.data as { id: string | number }).id

          if (sourceId === undefined || targetId === undefined) return

          const sourceEntry = registry.get(sourceId)
          const targetEntry = registry.get(targetId)

          const closestEdge = extractClosestEdge(target.data)
          props.onDrop?.({
            sourceId,
            targetId,
            sourceData: sourceEntry?.data,
            targetData: targetEntry?.data,
            sourceInstanceId: (source.data as { instanceId: string }).instanceId,
            targetInstanceId: instanceId(),
            closestEdge,
          })
        },
      })
    )
  })

  const contextValue: DragAndDropContextValue = {
    // Does not need to change on mount.
    // eslint-disable-next-line solid/reactivity
    instanceId: instanceId(),
    registry: registry,
  }

  return (
    <DragAndDropContext.Provider value={contextValue}>{props.children}</DragAndDropContext.Provider>
  )
}

/* ---------- 2. Building Blocks ---------- */

export type DragState = "idle" | "dragging" | "over"

type ItemChildren = (
  state: Accessor<DragState>,
  ref: (el: HTMLElement) => void,
  closestEdge: Accessor<Edge | null>,
  /** Optional drag handle — when set, only this element starts drags (scroll elsewhere works). */
  handleRef: (el: HTMLElement | null) => void
) => JSX.Element

/**
 * DraggableItem is both `draggable()` and `dropTargetForElements()`, just for simplicity
 * so we don't need to neste Draggable and Droppable at once.
 * dropTargetForElements is enabled by default, but can be disabled.
 */
export const DraggableItem = (props: {
  id: string | number
  type?: string
  data?: any
  dropTargetType?: string | string[]
  dropTargetCanDrop?: (sourceData: any) => boolean
  /** @defaultValue true */
  enableDropTarget?: boolean
  /**
   * When set, attaches hitbox closest-edge data and tracks it for `<DropIndicator />`.
   * Typical list sorting: `['top','bottom']` or `['left','right']`.
   */
  allowedEdges?: Edge[]
  children: ItemChildren
}) => {
  const [state, setState] = createSignal<DragState>("idle")
  const [closestEdge, setClosestEdge] = createSignal<Edge | null>(null)
  const [dragHandle, setDragHandle] = createSignal<HTMLElement | null>(null)
  let ref!: HTMLElement
  const { instanceId, registry } = useDragAndDropContext()

  createEffect(() => {
    registry.set(props.id, { id: props.id, data: props.data })
    onCleanup(() => registry.delete(props.id))
  })

  createEffect(() => {
    const handle = dragHandle()
    onCleanup(
      combine(
        draggable({
          element: ref,
          ...(handle ? { dragHandle: handle } : {}),
          getInitialData: () => ({
            id: props.id,
            type: props.type || "item",
            instanceId,
            data: props.data,
          }),
          onDragStart: () => setState("dragging"),
          onDrag: () => setState("dragging"),
          onDrop: () => setState("idle"),
        }),
        // Exactly like Droppable.
        ...(props.enableDropTarget !== false
          ? [
              dropTargetForElements({
                element: ref,
                getData: ({ input, element }) => {
                  const data = { id: props.id }
                  const edges = props.allowedEdges
                  if (!edges?.length) return data
                  return attachClosestEdge(data, {
                    input,
                    element,
                    allowedEdges: edges,
                  })
                },
                getIsSticky: () => true,
                canDrop: ({ source }) => {
                  const s = source.data as {
                    id: string | number
                    type: string
                    instanceId: string
                    data: any
                  }
                  if (s.instanceId !== instanceId) return false

                  const types = Array.isArray(props.dropTargetType)
                    ? props.dropTargetType
                    : [props.dropTargetType || "item"]
                  if (!types.includes(s.type)) return false

                  if (props.dropTargetCanDrop) return props.dropTargetCanDrop(s.data)
                  return true
                },
                onDragEnter: ({ self, source }) => {
                  setState("over")
                  if (!props.allowedEdges?.length) return
                  const sourceId = (source.data as { id: string | number }).id
                  if (sourceId === props.id) {
                    setClosestEdge(null)
                    return
                  }
                  setClosestEdge(extractClosestEdge(self.data))
                },
                onDrag: ({ self, source }) => {
                  if (!props.allowedEdges?.length) return
                  const sourceId = (source.data as { id: string | number }).id
                  if (sourceId === props.id) {
                    setClosestEdge(null)
                    return
                  }
                  setClosestEdge(extractClosestEdge(self.data))
                },
                onDragLeave: () => {
                  setState("idle")
                  setClosestEdge(null)
                },
                onDrop: () => {
                  setState("idle")
                  setClosestEdge(null)
                },
              }),
            ]
          : [])
      )
    )
  })

  const setRef = (el: HTMLElement) => {
    ref = el
  }

  return (
    <ClosestEdgeContext.Provider value={closestEdge}>
      {props.children(state, setRef, closestEdge, setDragHandle)}
    </ClosestEdgeContext.Provider>
  )
}

/** Droppable is only `dropTargetForElements()`, useful for areas where an item can be dragged into. */
export const Droppable = (props: {
  id: string | number
  type?: string | string[]
  data?: any
  canDrop?: (sourceData: any) => boolean
  allowedEdges?: Edge[]
  children: ItemChildren
}) => {
  const [state, setState] = createSignal<DragState>("idle")
  const [closestEdge, setClosestEdge] = createSignal<Edge | null>(null)
  let ref!: HTMLElement
  const { instanceId, registry } = useDragAndDropContext()
  const noopHandleRef = (_el: HTMLElement | null) => {}

  createEffect(() => {
    registry.set(props.id, { id: props.id, data: props.data })
    onCleanup(() => registry.delete(props.id))
  })

  createEffect(() => {
    onCleanup(
      combine(
        dropTargetForElements({
          element: ref,
          getData: ({ input, element }) => {
            const data = { id: props.id }
            const edges = props.allowedEdges
            if (!edges?.length) return data
            return attachClosestEdge(data, {
              input,
              element,
              allowedEdges: edges,
            })
          },
          getIsSticky: () => true,
          canDrop: ({ source }) => {
            const s = source.data as {
              id: string | number
              type: string
              instanceId: string
              data: any
            }
            if (s.instanceId !== instanceId) return false

            const types = Array.isArray(props.type) ? props.type : [props.type || "item"]
            if (!types.includes(s.type)) return false

            if (props.canDrop) return props.canDrop(s.data)
            return true
          },
          onDragEnter: ({ self }) => {
            setState("over")
            if (props.allowedEdges?.length) {
              setClosestEdge(extractClosestEdge(self.data))
            }
          },
          onDrag: ({ self }) => {
            if (props.allowedEdges?.length) {
              setClosestEdge(extractClosestEdge(self.data))
            }
          },
          onDragLeave: () => {
            setState("idle")
            setClosestEdge(null)
          },
          onDrop: () => {
            setState("idle")
            setClosestEdge(null)
          },
        })
      )
    )
  })

  const setRef = (el: HTMLElement) => {
    ref = el
  }

  return (
    <ClosestEdgeContext.Provider value={closestEdge}>
      {props.children(state, setRef, closestEdge, noopHandleRef)}
    </ClosestEdgeContext.Provider>
  )
}

/* ---------- 3. Auto-scroll helper ---------- */
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element"

type AutoScrollOptions = {
  canScroll?: (args: { source: any }) => boolean
}

export const useAutoScroll = (opts?: AutoScrollOptions) => {
  let ref: HTMLElement

  createEffect(() => {
    const { canScroll = () => true } = opts ?? { canScroll: () => true }
    if (!ref) return

    onCleanup(
      autoScrollForElements({
        element: ref,
        canScroll: canScroll,
      })
    )
  })

  return (el: HTMLElement) => {
    ref = el
  }
}

export type { Edge }
