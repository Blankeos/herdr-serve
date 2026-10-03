import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutKeyboard } from "./ShortcutKeyboard";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ""; });

describe("ShortcutKeyboard", () => {
  it("uses QWERTY rows and an inverted-T arrow cluster", () => {
    dispose = render(() => <ShortcutKeyboard onKey={() => {}} />, document.body);
    const rows = [...document.querySelectorAll(".shortcut-keyboard-row")];
    expect([...rows[1].querySelectorAll("button")].map(b => b.title).join("")).toBe("`1234567890-=Backspace");
    expect([...rows[2].querySelectorAll("button")].map(b => b.title).join("")).toBe("Tabqwertyuiop[]\\");
    expect([...rows[3].querySelectorAll("button")].map(b => b.title).join("")).toBe("asdfghjkl;'Enter");
    expect([...document.querySelectorAll<HTMLButtonElement>(".shortcut-keyboard-arrows button")].map(b => b.title)).toEqual(["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"]);
    expect(document.querySelector(".mod")).toBeNull();
  });

  it("sends key values through the existing chord handler", () => {
    const onKey = vi.fn();
    dispose = render(() => <ShortcutKeyboard onKey={onKey} />, document.body);
    for (const title of ["q", "Enter", "Space", "Backspace", "?", "ArrowUp"]) {
      document.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!.click();
    }
    expect(onKey.mock.calls.map(([key]) => key)).toEqual(["q", "Enter", " ", "Backspace", "?", "ArrowUp"]);
    expect(document.querySelectorAll("button:not([type=button])")).toHaveLength(0);
  });
});
