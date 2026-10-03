import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/** Font metrics can change without a host resize. Fit using the current cell
 * dimensions, and only notify the PTY when its actual geometry changes. */
export function createTerminalFitter(
  term: Pick<Terminal, "cols" | "rows">,
  fit: Pick<FitAddon, "fit">,
  sendResize: (cols: number, rows: number) => void,
): () => void {
  let lastCols = 0;
  let lastRows = 0;
  return () => {
    // FitAddon already avoids clearing/rendering when dimensions are identical.
    fit.fit();
    if (term.cols === lastCols && term.rows === lastRows) return;
    lastCols = term.cols;
    lastRows = term.rows;
    sendResize(lastCols, lastRows);
  };
}

/** Observe both host geometry and xterm's rendered cell geometry. This repairs
 * rows that would otherwise overflow the dock after delayed font measurement. */
export function observeTerminalFit(host: HTMLElement, refit: () => void): () => void {
  const observer = new ResizeObserver(refit);
  observer.observe(host);
  const screen = host.querySelector(".xterm-screen");
  if (screen) observer.observe(screen);
  return () => observer.disconnect();
}
