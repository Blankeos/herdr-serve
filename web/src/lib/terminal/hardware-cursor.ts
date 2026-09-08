/**
 * Mobile hardware-cursor helper (owned terminal file).
 *
 * Root cause: App opens the soft keyboard WITHOUT focusing xterm's helper
 * textarea (focusing would pop the native IME). xterm therefore stays
 * blurred and renders its `cursorInactiveStyle` ("outline" by default) — a
 * 1px hollow box that is nearly invisible on phones. Hardware/Bluetooth
 * keyboard users are hit hardest: they type blind with no solid block.
 *
 * This module is the canonical fix alongside the fallback rule in
 * `soft-keyboard.css` (which is always loaded). Preferred integration:
 *
 * ```ts
 * import { keepHardwareCursorVisible } from "./lib/terminal/hardware-cursor";
 * import "./lib/terminal/hardware-cursor.css";
 * // after `term.open(...)`:
 * keepHardwareCursorVisible(term);
 * // and in the Terminal constructor:
 * // new Terminal({ cursorBlink: true, cursorStyle: "block",
 * //                  cursorInactiveStyle: "block", ... })
 * ```
 *
 * Keeping this out of App.tsx/styles.css per ownership rules; App owners
 * should wire the import + constructor options (see report).
 */
import type { Terminal } from "@xterm/xterm";
import "./hardware-cursor.css";

export const HARDWARE_CURSOR_COLOR = "#6c8ed8";

/** Force a solid, blinking block cursor even while xterm is blurred. */
export function keepHardwareCursorVisible(term: Terminal): void {
  try {
    term.options.cursorStyle = "block";
    // The actual fix: blurred xterm uses this style instead of hollow outline.
    term.options.cursorInactiveStyle = "block";
    term.options.cursorBlink = true;
    term.refresh(0, term.rows - 1);
  } catch {
    /* ignore — terminal not yet opened */
  }
}

/** Tag the terminal host so the CSS fallback can target it explicitly. */
export function markHardwareCursorHost(host: HTMLElement | null | undefined): void {
  if (!host) return;
  try {
    host.classList.add("hw-cursor-visible");
  } catch {
    /* ignore */
  }
}
