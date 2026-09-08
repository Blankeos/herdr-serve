import { For, Show, createSignal, onCleanup, type JSX } from "solid-js";

export type SortableItem = { id: string };

type DragState = {
  id: string;
  from: number;
  over: number;
  edge: "before" | "after";
};

/**
 * Vertical sortable list with immediate pointer drag from a handle.
 * Avoids native HTML5 DnD long-press delay on mobile.
 */
export function SortableList<T extends SortableItem>(props: {
  items: () => T[];
  onReorder: (from: number, to: number) => void;
  children: (args: {
    item: T;
    index: () => number;
    isDragging: () => boolean;
    isDropBefore: () => boolean;
    isDropAfter: () => boolean;
    handleProps: {
      class: string;
      onPointerDown: (e: PointerEvent) => void;
      title: string;
      "aria-hidden": true;
    };
  }) => JSX.Element;
}): JSX.Element {
  const [drag, setDrag] = createSignal<DragState | null>(null);
  let listEl: HTMLDivElement | undefined;
  let live: DragState | null = null;

  const clear = () => {
    live = null;
    setDrag(null);
  };

  const indexFromPoint = (
    clientY: number,
  ): { index: number; edge: "before" | "after" } | null => {
    if (!listEl) return null;
    const rows = Array.from(
      listEl.querySelectorAll<HTMLElement>("[data-sortable-id]"),
    );
    if (!rows.length) return null;

    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top) return { index: i, edge: "before" };
      if (clientY <= rect.bottom) {
        const mid = rect.top + rect.height / 2;
        return { index: i, edge: clientY < mid ? "before" : "after" };
      }
    }
    return { index: rows.length - 1, edge: "after" };
  };

  const finishIndex = (from: number, over: number, edge: "before" | "after") => {
    let to = edge === "after" ? over + 1 : over;
    if (from < to) to -= 1;
    return to;
  };

  const onPointerDown = (e: PointerEvent, id: string) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.stopPropagation();

    const items = props.items();
    const from = items.findIndex((it) => it.id === id);
    if (from < 0) return;

    const pointerId = e.pointerId;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture?.(pointerId);

    live = { id, from, over: from, edge: "before" };
    setDrag(live);

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const hit = indexFromPoint(ev.clientY);
      if (!hit || !live) return;
      if (live.over === hit.index && live.edge === hit.edge) return;
      live = { ...live, over: hit.index, edge: hit.edge };
      setDrag(live);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      handle.releasePointerCapture?.(pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);

      const d = live;
      clear();
      if (!d) return;
      const to = finishIndex(d.from, d.over, d.edge);
      if (to !== d.from) props.onReorder(d.from, to);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  onCleanup(clear);

  return (
    <div class="shortcut-list" ref={(el) => (listEl = el)}>
      <For each={props.items()}>
        {(item, index) =>
          props.children({
            item,
            index,
            isDragging: () => drag()?.id === item.id,
            isDropBefore: () => {
              const cur = drag();
              return (
                !!cur &&
                cur.id !== item.id &&
                cur.over === index() &&
                cur.edge === "before"
              );
            },
            isDropAfter: () => {
              const cur = drag();
              return (
                !!cur &&
                cur.id !== item.id &&
                cur.over === index() &&
                cur.edge === "after"
              );
            },
            handleProps: {
              class: "shortcut-handle",
              title: "Drag to reorder",
              "aria-hidden": true,
              onPointerDown: (e) => onPointerDown(e, item.id),
            },
          })
        }
      </For>
      <Show when={!props.items().length}>
        <div class="empty-inline">No shortcuts yet.</div>
      </Show>
    </div>
  );
}
