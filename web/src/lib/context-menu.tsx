import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";

export type ContextMenuItem = {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

type MenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
} | null;

const [menu, setMenu] = createSignal<MenuState>(null);

const LONG_PRESS_MS = 480;
const MOVE_CANCEL_PX = 10;

export function closeContextMenu() {
  setMenu(null);
}

export function openContextMenu(
  e: MouseEvent | TouchEvent | PointerEvent,
  items: ContextMenuItem[],
) {
  if (!items.length) return;
  e.preventDefault();
  e.stopPropagation();

  let x = 0;
  let y = 0;
  if ("clientX" in e && typeof e.clientX === "number" && e.clientX !== 0) {
    x = e.clientX;
    y = e.clientY;
  } else if ("touches" in e && e.touches[0]) {
    x = e.touches[0].clientX;
    y = e.touches[0].clientY;
  } else if ("changedTouches" in e && e.changedTouches[0]) {
    x = e.changedTouches[0].clientX;
    y = e.changedTouches[0].clientY;
  }

  const pad = 8;
  const w = typeof window !== "undefined" ? window.innerWidth : 320;
  const h = typeof window !== "undefined" ? window.innerHeight : 480;
  const menuW = 180;
  const menuH = items.length * 36 + 12;
  x = Math.min(Math.max(pad, x), w - menuW - pad);
  y = Math.min(Math.max(pad, y), h - menuH - pad);
  setMenu({ x, y, items });
}

/** Desktop right-click + mobile long-press handlers for an element. */
export function contextMenuBind(items: () => ContextMenuItem[]): {
  onContextMenu: (e: MouseEvent) => void;
  onTouchStart: (e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: (e: TouchEvent) => void;
  onTouchCancel: () => void;
  onPointerDown?: (e: PointerEvent) => void;
} {
  let timer: number | undefined;
  let startX = 0;
  let startY = 0;
  let armed = false;

  const clear = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    armed = false;
  };

  return {
    onContextMenu: (e: MouseEvent) => {
      openContextMenu(e, items());
    },
    onTouchStart: (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      armed = true;
      clear();
      timer = window.setTimeout(() => {
        if (!armed) return;
        openContextMenu(e, items());
        armed = false;
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e: TouchEvent) => {
      if (!armed || !e.touches[0]) return;
      const t = e.touches[0];
      if (
        Math.abs(t.clientX - startX) > MOVE_CANCEL_PX ||
        Math.abs(t.clientY - startY) > MOVE_CANCEL_PX
      ) {
        clear();
      }
    },
    onTouchEnd: () => clear(),
    onTouchCancel: () => clear(),
  };
}

export function ContextMenuHost(): JSX.Element {
  createEffect(() => {
    const m = menu();
    if (!m) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    const onScroll = () => closeContextMenu();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    });
  });

  return (
    <Show when={menu()}>
      {(m) => (
        <Portal>
          <div
            class="ctx-backdrop"
            onClick={() => closeContextMenu()}
            onContextMenu={(e) => {
              e.preventDefault();
              closeContextMenu();
            }}
          />
          <div
            class="ctx-menu"
            role="menu"
            style={{ left: `${m().x}px`, top: `${m().y}px` }}
          >
            <For each={m().items}>
              {(item) => (
                <button
                  type="button"
                  role="menuitem"
                  class="ctx-item"
                  classList={{ danger: !!item.danger }}
                  disabled={item.disabled}
                  onClick={() => {
                    closeContextMenu();
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
        </Portal>
      )}
    </Show>
  );
}
