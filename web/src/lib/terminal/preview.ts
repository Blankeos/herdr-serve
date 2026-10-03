import type { Terminal } from "@xterm/xterm";

/** A visual-only snapshot of xterm's DOM renderer, not another attachment.
 * Keep its renderer classes and inline styles so ANSI colors, backgrounds,
 * glyph geometry and emphasis survive the pan without parsing terminal text.
 */
export function terminalPreview(term: Pick<Terminal, "element">): HTMLElement | null {
  if (!term.element) return null;
  const snapshot = term.element.cloneNode(true) as HTMLElement;
  snapshot.setAttribute("aria-hidden", "true");
  snapshot.inert = true;
  // Helpers contain input and measurement targets, not visible terminal output.
  snapshot.querySelectorAll(".xterm-helpers, .xterm-accessibility, .live-region").forEach(el => el.remove());
  snapshot.querySelectorAll("[id], [tabindex]").forEach(el => {
    el.removeAttribute("id");
    el.removeAttribute("tabindex");
  });
  return snapshot;
}
