import { For } from "solid-js";
import "./shortcut-keyboard.css";

type Keycap = { key: string; label?: string; width?: number };
const chars = (text: string): Keycap[] => text.split("").map(key => ({ key }));
const ROWS: Keycap[][] = [
  [...chars("`1234567890-="), { key: "Backspace", label: "⌫", width: 2 }],
  [{ key: "Tab", width: 1.5 }, ...chars("qwertyuiop[]"), { key: "\\", width: 1.5 }],
  [...chars("asdfghjkl;'"), { key: "Enter", label: "Return ↵", width: 2.25 }],
  chars("zxcvbnm,./"),
];

export function ShortcutKeyboard(props: { onKey: (key: string) => void }) {
  const keycap = (cap: Keycap) => (
    <button type="button" class="shortcut-keycap" style={{ flex: `${cap.width ?? 1} 0 0` }}
      aria-label={cap.key === " " ? "Space" : cap.key.length === 1 ? cap.key.toUpperCase() : cap.key}
      title={cap.key === " " ? "Space" : cap.key}
      onClick={() => props.onKey(cap.key)}>
      {cap.label ?? cap.key.toUpperCase()}
    </button>
  );
  return (
    <div class="shortcut-keyboard-scroll" role="group" aria-label="Shortcut keyboard">
      <div class="shortcut-keyboard">
        <div class="shortcut-keyboard-row shortcut-keyboard-utility">
          {keycap({ key: "Escape", label: "Esc" })}
          <span class="shortcut-keyboard-gap" aria-hidden="true" />
          {keycap({ key: "?" })}
          <For each={["Home", "End", "PageUp", "PageDown", "Delete"]}>{key => keycap({ key, label: ({ PageUp: "PgUp", PageDown: "PgDn", Delete: "Del" } as Record<string, string>)[key] ?? key })}</For>
        </div>
        <For each={ROWS}>{(row, index) => (
          <div class="shortcut-keyboard-row">
            {index() === 2 && <span class="shortcut-keyboard-spacer" style={{ flex: "1.75 0 0" }} aria-hidden="true">Caps</span>}
            {index() === 3 && <span class="shortcut-keyboard-spacer" style={{ flex: "2.25 0 0" }} aria-hidden="true">Shift</span>}
            <For each={row}>{keycap}</For>
            {index() === 3 && <span class="shortcut-keyboard-spacer" style={{ flex: "2.75 0 0" }} aria-hidden="true">Shift</span>}
          </div>
        )}</For>
        <div class="shortcut-keyboard-bottom">
          <span class="shortcut-keyboard-gap" aria-hidden="true" />
          {keycap({ key: " ", label: "Space", width: 6 })}
          <span class="shortcut-keyboard-gap" aria-hidden="true" />
          <div class="shortcut-keyboard-arrows">
            {keycap({ key: "ArrowUp", label: "↑" })}
            {keycap({ key: "ArrowLeft", label: "←" })}
            {keycap({ key: "ArrowDown", label: "↓" })}
            {keycap({ key: "ArrowRight", label: "→" })}
          </div>
        </div>
      </div>
    </div>
  );
}
