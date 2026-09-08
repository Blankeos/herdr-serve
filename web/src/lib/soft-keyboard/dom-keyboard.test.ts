import { afterEach, describe, expect, it, vi } from "vitest";
import { createDomSoftKeyboard, type DomSoftKeyboard } from "./dom-keyboard";

let keyboard: DomSoftKeyboard;
afterEach(() => {
  keyboard?.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(pointer = true) {
  vi.useFakeTimers();
  vi.stubGlobal("PointerEvent", pointer ? MouseEvent : undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = Number(this.dataset.skCol ?? 0) * 32;
    const top = Number(this.dataset.skRow ?? 0) * 50;
    return { left, right: left + 30, top, bottom: top + 45, width: 30, height: 45, x: left, y: top, toJSON() {} };
  });
  const onInsert = vi.fn();
  const onBackspace = vi.fn();
  keyboard = createDomSoftKeyboard({ onInsert, onBackspace, onReturn: vi.fn() });
  document.body.append(keyboard.root);
  keyboard.root.setPointerCapture = vi.fn();
  keyboard.root.hasPointerCapture = () => false;
  keyboard.setOpen(true);
  return { onInsert, onBackspace };
}

function point(key: string) {
  const el = keyboard.root.querySelector<HTMLElement>(`[data-sk-char="${key}"]`) ?? keyboard.root.querySelector<HTMLElement>(`.sk-${key}`)!;
  const r = el.getBoundingClientRect();
  return { clientX: r.left + 15, clientY: r.top + 20 };
}
function pointer(type: string, id: number, key: string) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...point(key), button: 0 });
  Object.defineProperty(event, "pointerId", { value: id });
  keyboard.root.dispatchEvent(event);
}
function touch(type: string, id: number, key: string) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "changedTouches", { value: [{ identifier: id, ...point(key) }] });
  keyboard.root.dispatchEvent(event);
}
function tap(key: string, id = 1) {
  pointer("pointerdown", id, key);
  pointer("pointerup", id, key);
}

describe("soft keyboard input reliability", () => {
  it("accepts immediate typing and fast repeated/adjacent letters without a quiet window", () => {
    const { onInsert } = setup();
    const text = "qwweerrttyyhello".repeat(20);
    for (const key of text) tap(key);
    expect(onInsert.mock.calls.flat().join("")).toBe(text);
  });
  it("tracks overlapping adjacent fingers independently", () => {
    const { onInsert } = setup();
    pointer("pointerdown", 1, "q");
    pointer("pointerdown", 2, "w");
    pointer("pointerup", 1, "q");
    pointer("pointerup", 2, "w");
    expect(onInsert.mock.calls.flat().join("")).toBe("qw");
  });
  it("ignores compatibility touch/click events and duplicate releases", () => {
    const { onInsert } = setup();
    pointer("pointerdown", 1, "q");
    touch("touchstart", 99, "q");
    pointer("pointerup", 1, "q");
    touch("touchend", 99, "q");
    pointer("pointerup", 1, "q");
    keyboard.root.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, ...point("q") }));
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("q");
  });
  it("does not commit cancelled, lost-capture, or untracked contacts", () => {
    const { onInsert } = setup();
    pointer("pointerup", 3, "q");
    for (const type of ["pointercancel", "lostpointercapture"]) {
      pointer("pointerdown", 1, "q");
      pointer(type, 1, "q");
      pointer("pointerup", 1, "q");
    }
    expect(onInsert).not.toHaveBeenCalled();
    tap("q");
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("q");
  });
  it("preserves slide selection", () => {
    const { onInsert } = setup();
    pointer("pointerdown", 1, "q");
    pointer("pointermove", 1, "w");
    pointer("pointerup", 1, "w");
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("w");
  });
  it("deletes once per fast backspace tap and stops repeat after cancellation", () => {
    const { onBackspace } = setup();
    tap("backspace");
    tap("backspace");
    expect(onBackspace).toHaveBeenCalledTimes(2);
    pointer("pointerdown", 1, "backspace");
    vi.advanceTimersByTime(600);
    expect(onBackspace.mock.calls.length).toBeGreaterThan(3);
    pointer("pointercancel", 1, "backspace");
    const count = onBackspace.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(onBackspace).toHaveBeenCalledTimes(count);
  });
  it("supports rapid touch-only fallback without recovering phantom releases", () => {
    const { onInsert } = setup(false);
    for (const key of "qqww") {
      touch("touchstart", 1, key);
      touch("touchend", 1, key);
    }
    touch("touchend", 9, "q");
    touch("touchstart", 2, "q");
    touch("touchcancel", 2, "q");
    expect(onInsert.mock.calls.flat().join("")).toBe("qqww");
  });
  it("supports accessible button activation without coordinates", () => {
    const { onInsert } = setup();
    keyboard.root.querySelector<HTMLElement>('[data-sk-char="q"]')!.click();
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("q");
  });
});
