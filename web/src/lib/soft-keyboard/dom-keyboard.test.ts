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
  const geometry = { x: 0, y: 0, width: 390 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const col = Number(this.dataset.skCol ?? 0);
    const siblings = Array.from(this.parentElement?.children ?? []) as HTMLElement[];
    const precedingWidth = siblings.slice(0, col).reduce((sum, el) => sum + parseFloat(el.style.flexBasis || "0"), 0);
    const left = geometry.x + precedingWidth / 100 * geometry.width;
    const top = geometry.y + Number(this.dataset.skRow ?? 0) * 53;
    const width = this.hidden ? 0 : this.dataset.skRow === undefined ? geometry.width : parseFloat(this.style.flexBasis) / 100 * geometry.width;
    const height = this.hidden ? 0 : this.dataset.skRow === undefined ? 265 : 53;
    return { left, right: left + width, top, bottom: top + height, width, height, x: left, y: top, toJSON() {} };
  });
  const onInsert = vi.fn();
  const onBackspace = vi.fn();
  keyboard = createDomSoftKeyboard({ onInsert, onBackspace, onReturn: vi.fn() });
  document.body.append(keyboard.root);
  keyboard.root.setPointerCapture = vi.fn();
  keyboard.root.hasPointerCapture = () => false;
  keyboard.setOpen(true);
  return { onInsert, onBackspace, geometry };
}

function button(key: string) {
  const buttons = Array.from(keyboard.root.querySelectorAll<HTMLElement>("button:not([hidden])"));
  const el = buttons.find(el => el.dataset.skChar?.toLowerCase() === key.toLowerCase())
    ?? buttons.find(el => el.classList.contains("sk-key") && el.getAttribute("aria-label") === key);
  if (!el) throw new Error(`Key not found: ${key}`);
  return el;
}
function point(key: string) {
  const r = button(key).getBoundingClientRect();
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
}
function pointerAt(type: string, id: number, coords: ReturnType<typeof point>, target: HTMLElement = keyboard.root) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...coords, button: 0 });
  Object.defineProperty(event, "pointerId", { value: id });
  target.dispatchEvent(event);
}
function pointer(type: string, id: number, key: string) {
  pointerAt(type, id, point(key));
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

  it.each(["touch", "mouse", "pen", "touch-source"])("ignores zero-detail physical clicks from %s", source => {
    const { onInsert } = setup();
    tap("q");
    const event = new MouseEvent("click", { bubbles: true, detail: 0 });
    if (source === "touch-source") {
      Object.defineProperty(event, "sourceCapabilities", { value: { firesTouchEvents: true } });
    } else {
      Object.defineProperty(event, "pointerType", { value: source });
    }
    button("q").dispatchEvent(event);
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

  it("keeps the next touch target connected when one-shot Shift resets (Carlo, not Crlo)", () => {
    const { onInsert } = setup();
    tap("shift");
    const a = button("a");
    const coords = point("a");
    tap("c");
    // Browsers can hit-test/queue the next contact before the previous up is handled.
    pointerAt("pointerdown", 2, coords, a);
    pointerAt("pointerup", 2, coords, a);
    for (const key of "rlo") tap(key);
    expect(onInsert.mock.calls.flat().join("")).toBe("Carlo");
    expect(button("a")).toBe(a);
  });

  it.each([true, false])("handles rolling Shift → C → a with either event stream (pointer=%s)", usePointer => {
    const { onInsert } = setup(usePointer);
    const event = (phase: "down" | "up", id: number, key: string) => usePointer
      ? pointer(`pointer${phase}`, id, key)
      : touch(phase === "down" ? "touchstart" : "touchend", id, key);
    event("down", 1, "shift");
    event("down", 2, "c");
    event("up", 1, "shift");
    event("down", 3, "a");
    event("up", 2, "c");
    event("up", 3, "a");
    for (const key of "rlo") {
      event("down", 4, key);
      event("up", 4, key);
    }
    expect(onInsert.mock.calls.flat().join("")).toBe("Carlo");
  });

  it("commits overlapping letters in press order, even if fingers lift in reverse order", () => {
    const { onInsert } = setup();
    pointer("pointerdown", 1, "q");
    pointer("pointerdown", 2, "w");
    pointer("pointerup", 2, "w");
    pointer("pointerup", 1, "q");
    expect(onInsert.mock.calls.flat().join("")).toBe("qw");
  });

  it("does not leave Shift on when the letter lifts before the Shift finger", () => {
    const { onInsert } = setup();
    pointer("pointerdown", 1, "shift");
    tap("c", 2);
    pointer("pointerup", 1, "shift");
    for (const key of "arlo") tap(key);
    expect(onInsert.mock.calls.flat().join("")).toBe("Carlo");
  });

  it("resolves the new layer when a letter overlaps the 123 switch", () => {
    const { onInsert } = setup();
    const coords = point("q");
    const modifier = point("numbers");
    pointer("pointerdown", 1, "numbers");
    pointerAt("pointerdown", 2, coords);
    pointerAt("pointerup", 2, coords);
    pointerAt("pointerup", 1, modifier);
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("1");
  });

  it("ignores capture transferring from a key to the keyboard root", () => {
    const { onInsert } = setup();
    const q = button("q");
    pointerAt("pointerdown", 1, point("q"), q);
    pointerAt("lostpointercapture", 1, point("q"), q);
    pointer("pointerup", 1, "q");
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("q");
  });

  it("stops held backspace as soon as another key starts, without deleting new text", () => {
    const { onInsert, onBackspace } = setup();
    pointer("pointerdown", 1, "backspace");
    tap("a", 2);
    vi.advanceTimersByTime(1000);
    pointer("pointerup", 1, "backspace");
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("a");
    expect(onBackspace).toHaveBeenCalledTimes(1);
  });

  it("refreshes hitboxes immediately after the keyboard moves or resizes", () => {
    const { onInsert, geometry } = setup();
    tap("c");
    geometry.x = 40;
    geometry.y = 80;
    geometry.width = 430;
    tap("a");
    expect(onInsert.mock.calls.flat().join("")).toBe("ca");
  });

  it("does not reset the numeric layer on redundant setOpen(true) updates", () => {
    setup();
    tap("numbers");
    const one = button("1");
    keyboard.setOpen(true);
    expect(button("1")).toBe(one);
  });

  it("renders cleared one-shot Shift when the keyboard is reopened", () => {
    setup();
    tap("shift");
    keyboard.setOpen(false);
    keyboard.setOpen(true);
    expect(button("a").dataset.skChar).toBe("a");
    expect(button("shift").classList.contains("sk-active")).toBe(false);
  });

  it("preserves the semantic action of accessible clicks across a layer change", () => {
    const { onInsert, onBackspace } = setup();
    tap("numbers");
    pointer("pointerdown", 1, "'");
    button("backspace").click();
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("'");
    expect(onBackspace).toHaveBeenCalledTimes(1);
  });

  it.each(["close", "destroy"])("never restarts repeat when a backspace callback triggers %s", action => {
    const { onBackspace } = setup();
    onBackspace.mockImplementation(() => action === "close" ? keyboard.setOpen(false) : keyboard.destroy());
    pointer("pointerdown", 1, "backspace");
    vi.advanceTimersByTime(1000);
    expect(onBackspace).toHaveBeenCalledTimes(1);
  });

  it.each(["close", "destroy"])("clears active contacts and repeat on %s", action => {
    const { onInsert, onBackspace } = setup();
    const coords = point("backspace");
    pointer("pointerdown", 1, "backspace");
    if (action === "close") keyboard.setOpen(false);
    else keyboard.destroy();
    pointerAt("pointerup", 1, coords, document.body);
    vi.advanceTimersByTime(1000);
    expect(onBackspace).toHaveBeenCalledTimes(1);
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("handles pointer capture failure without losing the release outside the root", () => {
    const { onInsert } = setup();
    keyboard.root.setPointerCapture = () => { throw new DOMException("No active pointer", "NotFoundError"); };
    pointer("pointerdown", 1, "q");
    pointerAt("pointerup", 1, point("q"), document.body);
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("q");
  });

  it("preserves single-finger slide cancellation and re-entry", () => {
    const { onInsert } = setup();
    const outside = { clientX: -100, clientY: -100 };
    pointer("pointerdown", 1, "q");
    pointerAt("pointermove", 1, outside);
    pointerAt("pointerup", 1, outside);
    expect(onInsert).not.toHaveBeenCalled();
    pointer("pointerdown", 2, "q");
    pointerAt("pointermove", 2, outside);
    pointer("pointermove", 2, "w");
    pointer("pointerup", 2, "w");
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("w");
  });

  it("locks an older selection on rollover, ignoring its later moves and releases", () => {
    const { onInsert } = setup();
    pointer("pointerdown", 1, "q");
    pointer("pointermove", 1, "w");
    pointer("pointerdown", 2, "e");
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("w");
    pointer("pointermove", 1, "r");
    pointer("pointerup", 1, "r");
    pointer("pointerup", 2, "e");
    expect(onInsert.mock.calls.flat().join("")).toBe("we");
  });

  it("retains the highlight for a second finger on the same key", () => {
    const { onInsert } = setup();
    pointer("pointerdown", 1, "q");
    pointer("pointerdown", 2, "q");
    pointer("pointerup", 1, "q");
    expect(button("q").classList.contains("sk-pressed")).toBe(true);
    pointer("pointerup", 2, "q");
    expect(button("q").classList.contains("sk-pressed")).toBe(false);
    expect(onInsert.mock.calls.flat().join("")).toBe("qq");
  });

  it("supports caps lock, slow Shift dismissal, and fresh one-shot capitalization", () => {
    const { onInsert } = setup();
    tap("shift");
    vi.advanceTimersByTime(100);
    tap("shift");
    for (const key of "carlo") tap(key);
    expect(onInsert.mock.calls.flat().join("")).toBe("CARLO");
    tap("shift");
    tap("a");
    tap("shift");
    vi.advanceTimersByTime(400);
    tap("shift");
    tap("a");
    tap("shift");
    tap("c");
    tap("a");
    expect(onInsert.mock.calls.flat().join("")).toBe("CARLOaaCa");
  });

  it("keeps numbers/symbols usable and returns from apostrophe without losing the next letter", () => {
    const { onInsert } = setup();
    tap("numbers");
    for (const key of "12.") tap(key);
    tap("symbols");
    tap("#");
    const apostrophe = point("'");
    pointerAt("pointerdown", 1, apostrophe);
    const aSlot = point("\\");
    aSlot.clientX -= 5; // Inside A after ABC returns, not exactly on the A/S border.
    pointerAt("pointerdown", 2, aSlot);
    pointerAt("pointerup", 1, apostrophe);
    pointerAt("pointerup", 2, aSlot);
    expect(onInsert.mock.calls.flat().join("")).toBe("12.#'a");
  });

  it("does not consume unrelated touch events in the legacy fallback", () => {
    setup(false);
    const event = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "changedTouches", { value: [{ identifier: 99, ...point("q") }] });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("preserves Carlo across 100 deterministic two-thumb timing variations", () => {
    const { onInsert } = setup();
    let seed = 42;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const keys = ["shift", ..."carlo"];
    for (let run = 0; run < 100; run++) {
      const contacts = new Map<number, ReturnType<typeof point>>();
      let next = 0;
      while (next < keys.length || contacts.size) {
        if (next < keys.length && (contacts.size === 0 || contacts.size < 2 && random() < 0.6)) {
          const id = contacts.has(1) ? 2 : 1;
          const coords = point(keys[next++]);
          contacts.set(id, coords);
          pointerAt("pointerdown", id, coords);
        } else {
          const id = [...contacts.keys()][Math.floor(random() * contacts.size)];
          pointerAt("pointerup", id, contacts.get(id)!);
          contacts.delete(id);
        }
        vi.advanceTimersByTime(Math.floor(random() * 25));
      }
    }
    expect(onInsert.mock.calls.flat().join("")).toBe("Carlo".repeat(100));
  });
});
