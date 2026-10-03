import { afterEach, describe, expect, it, vi } from "vitest";
import { guardMobilePageScroll } from "./mobile-scroll-guard";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = "";
});

function touch(target: Element, type: string, x: number, y: number, count = 1, id = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: Array.from({ length: count }, (_, i) => ({
    identifier: id + i, clientX: x, clientY: y,
  })) });
  target.dispatchEvent(event);
  return event;
}
function setup(className = "", overflow?: "x" | "y") {
  const element = document.createElement("div");
  element.className = className;
  if (overflow) {
    element.style[overflow === "y" ? "overflowY" : "overflowX"] = "auto";
    Object.defineProperties(element, {
      scrollHeight: { value: 500 }, clientHeight: { value: 100 },
      scrollWidth: { value: 500 }, clientWidth: { value: 100 },
    });
  }
  const child = document.createElement("button");
  element.append(child);
  document.body.append(element);
  let enabled = true;
  cleanup = guardMobilePageScroll(() => enabled);
  const start = (x = 100, y = 200) => touch(child, "touchstart", x, y);
  const move = (x = 100, y = 190) => touch(child, "touchmove", x, y);
  return { element, child, start, move, setEnabled: (value: boolean) => { enabled = value; } };
}

describe("mobile page scroll guard", () => {
  it("blocks the first tiny terminal drag but preserves the app's gesture handlers", () => {
    const { element, start, move } = setup("term", "y");
    element.scrollTop = 100; // Even xterm's scrollport must not steal the gesture.
    const terminalMove = vi.fn();
    element.addEventListener("touchmove", terminalMove);
    start();
    expect(move(100, 199).defaultPrevented).toBe(true);
    expect(terminalMove).toHaveBeenCalledOnce();
    expect(element.scrollTop).toBe(100);
  });
  it("blocks vertical chrome drags without blocking taps", () => {
    const { start, move } = setup("dock");
    expect(start().defaultPrevented).toBe(false);
    expect(move().defaultPrevented).toBe(true);
  });
  it("lets a scrollable sheet/list consume gestures inside its bounds", () => {
    const { element, start, move } = setup("sheet-body", "y");
    element.scrollTop = 100;
    start();
    expect(move().defaultPrevented).toBe(false);
    expect(element.scrollTop).toBe(100); // Browser, not the guard, performs scrolling.
  });
  it("blocks chaining past top/bottom and permits reversing direction", () => {
    const { element, start, move } = setup("sidebar-scroll", "y");
    element.scrollTop = 0;
    start();
    expect(move(100, 210).defaultPrevented).toBe(true);
    expect(element.scrollTop).toBe(0);
    expect(move(100, 200).defaultPrevented).toBe(false);
    element.scrollTop = 400;
    expect(move(100, 190).defaultPrevented).toBe(true);
    expect(element.scrollTop).toBe(400);
  });
  it("consumes the remaining distance before an edge without overscrolling", () => {
    const { element, start, move } = setup("dialog-panel", "y");
    element.scrollTop = 395;
    start();
    expect(move(100, 180).defaultPrevented).toBe(true);
    expect(element.scrollTop).toBe(400);
  });
  it("keeps horizontal keybar scrolling but blocks vertical page panning", () => {
    const { element, start, move } = setup("keybar-scroll", "x");
    element.scrollLeft = 100;
    start();
    expect(move(80, 200).defaultPrevented).toBe(false);
    expect(move(80, 180).defaultPrevented).toBe(true);
    element.scrollLeft = 400;
    expect(move(60, 180).defaultPrevented).toBe(true);
  });
  it("does not mistake hidden overflow or an unscrollable area for a scrollport", () => {
    const { element, start, move } = setup("shell", "y");
    element.style.overflowY = "hidden";
    element.scrollTop = 100;
    start();
    expect(move().defaultPrevented).toBe(true);
  });
  it("does not clamp a parent scrollport when a nested one can consume the move", () => {
    const { element, child } = setup("sheet-body", "y");
    const nested = document.createElement("div");
    nested.style.overflowY = "auto";
    Object.defineProperties(nested, { scrollHeight: { value: 200 }, clientHeight: { value: 50 } });
    nested.scrollTop = 50;
    element.append(nested);
    nested.append(child);
    element.scrollTop = 400;
    touch(child, "touchstart", 100, 200);
    expect(touch(child, "touchmove", 100, 190).defaultPrevented).toBe(false);
  });
  it("does not guard desktop or multi-touch gestures", () => {
    const { child, start, move, setEnabled } = setup();
    setEnabled(false);
    start();
    expect(move().defaultPrevented).toBe(false);
    setEnabled(true);
    touch(child, "touchstart", 100, 200, 2);
    expect(touch(child, "touchmove", 100, 180, 2).defaultPrevented).toBe(false);
  });
  it("resets on end/cancel and removes listeners on cleanup", () => {
    const { child, start, move } = setup();
    start();
    touch(child, "touchcancel", 100, 200, 0);
    expect(move().defaultPrevented).toBe(false);
    start();
    touch(child, "touchend", 100, 200, 0);
    expect(move().defaultPrevented).toBe(false);
    start();
    cleanup!(); cleanup = undefined;
    expect(move().defaultPrevented).toBe(false);
  });
});
