import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenuHost, closeContextMenu, contextMenuBind } from "./context-menu";

let dispose: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  closeContextMenu();
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function setup(disabled = false) {
  const select = vi.fn();
  const remove = vi.fn();
  dispose = render(() => {
    const binding = contextMenuBind(() => [{ label: "Delete", danger: true, disabled, onSelect: remove }], select);
    return <><button id="tab" {...binding}>Agent or terminal</button><ContextMenuHost /></>;
  }, document.body);
  const tab = document.querySelector<HTMLButtonElement>("#tab")!;
  return { tab, select, remove };
}

// jsdom has no PointerEvent constructor; populate pointer fields on a MouseEvent.
function pointer(target: EventTarget, type: string, overrides: Partial<PointerEvent> = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 80, button: overrides.button ?? 0 });
  for (const [key, value] of Object.entries({ pointerId: 1, pointerType: "touch", isPrimary: true, ...overrides })) {
    Object.defineProperty(event, key, { value });
  }
  target.dispatchEvent(event);
  return event;
}

function click(target: EventTarget, detail = 1) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, detail });
  target.dispatchEvent(event);
  return event;
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const action = () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;

describe("context menu hold gesture", () => {
  it("blocks native mouse selection while preserving focus and normal clicks", () => {
    const { tab, select } = setup();
    expect(tab.hasAttribute("data-context-menu-trigger")).toBe(true);
    const down = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    tab.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tab);
    click(tab);
    expect(select).toHaveBeenCalledOnce();
    const rightDown = new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true });
    tab.dispatchEvent(rightDown);
    expect(rightDown.defaultPrevented).toBe(false);
  });

  it.each(["touch", "mouse", "pen"])("opens after holding with %s without selecting the tab", pointerType => {
    const { tab, select } = setup();
    pointer(tab, "pointerdown", { pointerType });
    vi.advanceTimersByTime(479);
    expect(menu()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(action().textContent).toBe("Delete");
    expect(select).not.toHaveBeenCalled();
  });

  it("preserves quick taps and normal keyboard clicks", () => {
    const { tab, select } = setup();
    pointer(tab, "pointerdown");
    vi.advanceTimersByTime(100);
    pointer(tab, "pointerup");
    click(tab);
    vi.advanceTimersByTime(500);
    click(tab, 0);
    expect(select).toHaveBeenCalledTimes(2);
    expect(menu()).toBeNull();
  });

  it.each(["pointermove", "pointercancel", "scroll", "blur", "pointerdown"])("cancels the hold on %s, including outside the trigger", type => {
    const { tab } = setup();
    pointer(tab, "pointerdown");
    if (type.startsWith("pointer")) {
      pointer(document.body, type, type === "pointerdown" ? { pointerId: 2, isPrimary: false } : { clientX: 120 });
    } else window.dispatchEvent(new Event(type));
    vi.advanceTimersByTime(500);
    expect(menu()).toBeNull();
  });

  it("allows small finger movement but ignores secondary buttons and non-primary pointers", () => {
    const { tab } = setup();
    pointer(tab, "pointerdown", { button: 2 });
    vi.advanceTimersByTime(500);
    expect(menu()).toBeNull();
    pointer(tab, "pointerdown", { isPrimary: false });
    vi.advanceTimersByTime(500);
    expect(menu()).toBeNull();
    pointer(tab, "pointerdown");
    pointer(tab, "pointermove", { clientX: 104, clientY: 83 });
    vi.advanceTimersByTime(500);
    expect(menu()).not.toBeNull();
  });

  it.each(["tab", "backdrop", "delete"])("blocks the hold's release click on the %s, then allows a deliberate Delete", target => {
    const { tab, select, remove } = setup();
    pointer(tab, "pointerdown");
    vi.advanceTimersByTime(500);
    const releaseTarget = target === "tab" ? tab : target === "delete" ? action() : document.querySelector(".ctx-backdrop")!;
    pointer(releaseTarget, "pointerup");
    expect(click(releaseTarget).defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    pointer(action(), "pointerdown");
    pointer(action(), "pointerup");
    click(action());
    expect(remove).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it("allows the next deliberate press even when no release click is generated", () => {
    const { tab, remove } = setup();
    pointer(tab, "pointerdown");
    vi.advanceTimersByTime(500);
    pointer(tab, "pointerup");
    pointer(action(), "pointerdown");
    click(action());
    expect(remove).toHaveBeenCalledOnce();
  });

  it("expires release protection when the browser never generates a click", () => {
    const { tab, remove } = setup();
    pointer(tab, "pointerdown");
    vi.advanceTimersByTime(500);
    pointer(tab, "pointerup");
    vi.advanceTimersByTime(800);
    expect(vi.getTimerCount()).toBe(0);
    click(action());
    expect(remove).toHaveBeenCalledOnce();
  });

  it("does not consume a click if no menu actions are available", () => {
    const select = vi.fn();
    dispose = render(() => {
      const binding = contextMenuBind(() => [], select);
      return <><button {...binding}>No actions</button><ContextMenuHost /></>;
    }, document.body);
    const tab = document.querySelector("button")!;
    pointer(tab, "pointerdown");
    vi.advanceTimersByTime(500);
    pointer(tab, "pointerup");
    click(tab);
    expect(menu()).toBeNull();
    expect(select).toHaveBeenCalledOnce();
  });

  it("supports right-click, keyboard opening, focus and Escape", async () => {
    const { tab, select } = setup();
    tab.focus();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 80 });
    tab.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(menu()?.style.top).toBe("80px");
    await Promise.resolve();
    expect(document.activeElement).toBe(action());
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(tab);
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    expect(menu()).not.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("cannot activate disabled Delete actions", () => {
    const { tab, remove } = setup(true);
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    action().click();
    expect(remove).not.toHaveBeenCalled();
  });

  it("cleans up a pending hold when its owner is disposed", () => {
    const { tab } = setup();
    pointer(tab, "pointerdown");
    dispose!();
    dispose = undefined;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(500);
    expect(menu()).toBeNull();
  });
});
