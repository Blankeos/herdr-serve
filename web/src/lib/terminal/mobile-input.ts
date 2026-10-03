import type { KeyboardMode } from "../../keyboardPrefs";

/** Keep xterm's IME/input handling, but don't put its textarea over TUI clicks. */
export function prepareTerminalInput(textarea: HTMLTextAreaElement, mode: KeyboardMode): void {
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "none");
  textarea.setAttribute("spellcheck", "false");
  textarea.setAttribute("enterkeyhint", "enter");
  textarea.setAttribute("inputmode", mode === "native" ? "text" : "none");
  textarea.readOnly = mode === "simulated";

  // Don't move it offscreen: focusing an offscreen input makes Safari pan the
  // page. xterm owns its cursor-relative left/top/size; keep that geometry.
  textarea.style.opacity = "0";
  textarea.style.caretColor = "transparent";
  textarea.style.pointerEvents = "none";
  textarea.style.fontSize = "16px"; // Avoid iOS focus zoom.
}
