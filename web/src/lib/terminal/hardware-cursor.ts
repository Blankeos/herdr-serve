import type { Terminal } from "@xterm/xterm";
import "./hardware-cursor.css";

export const HARDWARE_CURSOR_COLOR = "#6c8ed8";

/**
 * Initialize the hardware caret once, after open and before any remote frames.
 *
 * Herder sends painted ANSI frames (CUP + DECTCEM), not the child's original
 * alternate-screen entry. In xterm 6, cursor positioning/showing alone does not
 * initialize the cursor: that normally happens on focus or keyboard input.
 * Mobile deliberately does neither when using our soft keyboard.
 *
 * Enter/leave a blank alternate buffer to initialize it through supported VT
 * sequences, without focusing the textarea (which would open the native IME).
 * Keep it hidden until Herder supplies the first frame's position/visibility.
 * This must NOT run again after frames arrive: it clears the alternate buffer.
 */
export function keepHardwareCursorVisible(term: Terminal): void {
  term.options.cursorStyle = "block";
  term.options.cursorInactiveStyle = "block";
  term.options.cursorBlink = true;
  term.write("\x1b[?1047h\x1b[?1047l\x1b[?25l");
}

/** Tag the terminal host so the CSS fallback can target it explicitly. */
export function markHardwareCursorHost(host: HTMLElement | null | undefined): void {
  host?.classList.add("hw-cursor-visible");
}
