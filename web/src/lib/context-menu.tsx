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
  trigger: HTMLElement | null;
} | null;

const [menu, setMenu] = createSignal<MenuState>(null);

const LONG_PRESS_MS = 480;
const MOVE_CANCEL_PX = 10;

export function closeContextMenu() {
  setMenu(null);
}

function showMenu(x: number, y: number, items: ContextMenuItem[], trigger: HTMLElement | null) {
  if (!items.length) return;
  const pad = 8;
  const menuW = 180;
  const menuH = items.length * 36 + 12;
  x = Math.max(pad, Math.min(x, window.innerWidth - menuW - pad));
  y = Math.max(pad, Math.min(y, window.innerHeight - menuH - pad));
  setMenu({ x, y, items, trigger });
}

export function openContextMenu(e: MouseEvent, items: ContextMenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  const trigger = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const rect = trigger?.getBoundingClientRect();
  const keyboard = e.clientX === 0 && e.clientY === 0;
  showMenu(keyboard ? rect?.left ?? 0 : e.clientX, keyboard ? rect?.bottom ?? 0 : e.clientY, items, trigger);
}

/** Hold with touch, mouse or pen; quick clicks still perform the usual action. */
export function contextMenuBind(
  items: () => ContextMenuItem[],
  onClick: (e: MouseEvent) => void,
) {
  let timer: number | undefined;
  let stopTracking: (() => void) | undefined;
  let stopClickGuard: (() => void) | undefined;

  const clear = () => {
    window.clearTimeout(timer);
    timer = undefined;
    stopTracking?.();
    stopTracking = undefined;
  };

  // The release click may land on the new backdrop/menu rather than the tab.
  // Block it in capture phase, but allow the next deliberate press immediately.
  const guardReleaseClick = () => {
    stopClickGuard?.();
    let expiry: number | undefined;
    const remove = () => {
      window.clearTimeout(expiry);
      window.removeEventListener("click", click, true);
      window.removeEventListener("pointerdown", remove, true);
      window.removeEventListener("pointerup", released, true);
      window.removeEventListener("pointercancel", remove, true);
      stopClickGuard = undefined;
    };
    const click = (event: MouseEvent) => {
      if (event.detail === 0) return; // Keyboard activation is not a release click.
      event.preventDefault();
      event.stopImmediatePropagation();
      remove();
    };
    const released = () => { expiry = window.setTimeout(remove, 800); };
    window.addEventListener("click", click, true);
    window.addEventListener("pointerdown", remove, true);
    window.addEventListener("pointerup", released, true);
    window.addEventListener("pointercancel", remove, true);
    stopClickGuard = remove;
  };

  onCleanup(() => {
    clear();
    stopClickGuard?.();
  });

  return {
    "data-context-menu-trigger": "",
    "aria-haspopup": "menu" as const,
    onClick,
    onMouseDown: (e: MouseEvent) => {
      if (e.button !== 0) return;
      // A hold must not start a selection that can extend across the page.
      // Keep button focus and the eventual click, but cancel native selection.
      e.preventDefault();
      (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    },
    onContextMenu: (e: MouseEvent) => {
      clear();
      openContextMenu(e, items());
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
      e.preventDefault();
      e.stopPropagation();
      clear();
      const trigger = e.currentTarget as HTMLElement;
      const rect = trigger.getBoundingClientRect();
      showMenu(rect.left, rect.bottom, items(), trigger);
    },
    onPointerDown: (e: PointerEvent) => {
      clear();
      if (e.button !== 0 || !e.isPrimary) return;
      const trigger = e.currentTarget as HTMLElement;
      const { clientX: x, clientY: y, pointerId } = e;
      const move = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        if (Math.hypot(event.clientX - x, event.clientY - y) > MOVE_CANCEL_PX) clear();
      };
      const end = (event: PointerEvent) => {
        if (event.pointerId === pointerId) clear();
      };
      // Track outside the trigger too, including multi-touch, scrolling and blur.
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
      window.addEventListener("pointerdown", clear, true);
      window.addEventListener("scroll", clear, true);
      window.addEventListener("blur", clear);
      stopTracking = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", end, true);
        window.removeEventListener("pointercancel", end, true);
        window.removeEventListener("pointerdown", clear, true);
        window.removeEventListener("scroll", clear, true);
        window.removeEventListener("blur", clear);
      };
      timer = window.setTimeout(() => {
        timer = undefined;
        if (!trigger.isConnected) { clear(); return; }
        const actions = items();
        if (!actions.length) { clear(); return; }
        guardReleaseClick();
        showMenu(x, y, actions, trigger);
      }, LONG_PRESS_MS);
    },
  };
}

export function ContextMenuHost(): JSX.Element {
  createEffect(() => {
    const m = menu();
    if (!m) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
      }
    };
    const onScroll = () => closeContextMenu();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      if (m.trigger?.isConnected) m.trigger.focus({ preventScroll: true });
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
            aria-label="Actions"
            tabindex="-1"
            ref={(el) => queueMicrotask(() => {
              if (el.isConnected) (el.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? el).focus({ preventScroll: true });
            })}
            style={{ left: `${m().x}px`, top: `${m().y}px` }}
            onKeyDown={(e) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
              e.preventDefault();
              const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
              if (!buttons.length) return;
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1
                : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next].focus();
            }}
          >
            <For each={m().items}>
              {(item) => (
                <button
                  type="button"
                  role="menuitem"
                  tabindex="-1"
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
