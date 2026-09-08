import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/types"
import { createMemo, type JSX, Show, useContext } from "solid-js"
import { ClosestEdgeContext } from "./drag-and-drop"
import "./drop-indicator.css"

type Orientation = "horizontal" | "vertical"
type LineType = "terminal" | "no-terminal" | "terminal-no-bleed"

const edgeToOrientationMap: Record<Edge, Orientation> = {
  top: "horizontal",
  bottom: "horizontal",
  left: "vertical",
  right: "vertical",
}

const lineStartFrom: Record<LineType, (indent: string) => string> = {
  // half terminal outside, half inside — line starts after the inner half
  terminal: (indent) => `calc(var(--terminal-radius) + ${indent})`,
  // full terminal inside — line starts after the diameter
  "terminal-no-bleed": (indent) => `calc(var(--terminal-diameter) + ${indent})`,
  "no-terminal": (indent) => indent,
}

export type DropIndicatorProps = {
  /** Override; otherwise reads closest edge from parent `DraggableItem`. */
  edge?: Edge | null
  /** Gap between items — offsets the line into the middle of the gap. */
  gap?: string
  /** Shift the line along the main axis (e.g. indent under nested items). */
  indent?: string
  /**
   * - `terminal` (default): hollow circle, half bleeding out of the item
   * - `terminal-no-bleed`: hollow circle fully inside the item
   * - `no-terminal`: full-width line only
   */
  type?: LineType
  strokeWidth?: string
  strokeColor?: string
  class?: string
  style?: JSX.CSSProperties
}

/**
 * Solid port of Atlassian `react-drop-indicator` Line (default: `terminal`).
 * Parent must be `position: relative`.
 *
 * @see https://atlassian.design/components/pragmatic-drag-and-drop/optional-packages/react-drop-indicator/about#edge
 */
export function DropIndicator(props: DropIndicatorProps) {
  const closestEdgeFromContext = useContext(ClosestEdgeContext)
  const edge = createMemo(() => props.edge ?? closestEdgeFromContext?.() ?? null)

  return (
    <Show when={edge()}>
      {(activeEdge) => {
        const strokeWidth = () => props.strokeWidth ?? "2px"
        const strokeColor = () => props.strokeColor ?? "var(--accent)"
        const gap = () => props.gap ?? "0px"
        const indent = () => props.indent ?? "0px"
        const type = () => props.type ?? "terminal"
        const orientation = () => edgeToOrientationMap[activeEdge()]
        const e = () => activeEdge()

        return (
          <div
            aria-hidden
            data-drop-indicator
            data-edge={e()}
            data-orientation={orientation()}
            class={props.class}
            style={{
              "--stroke-color": strokeColor(),
              "--stroke-width": strokeWidth(),
              "--main-axis-offset": `calc(-0.5 * (${gap()} + ${strokeWidth()}))`,
              "--line-main-axis-start": lineStartFrom[type()](indent()),
              "--terminal-display": type() === "no-terminal" ? "none" : "block",
              "--terminal-diameter": `calc(${strokeWidth()} * 4)`,
              "--terminal-radius": "calc(var(--terminal-diameter) / 2)",
              "--terminal-main-axis-start": "calc(-1 * var(--terminal-diameter))",
              "--terminal-cross-axis-offset":
                "calc((var(--stroke-width) - var(--terminal-diameter)) / 2)",
              ...props.style,
            }}
          />
        )
      }}
    </Show>
  )
}
