/** SGR mouse button codes (xterm CoreMouseButton). */
export type SgrButton = 0 | 1 | 2; // left | middle | right

export type SgrAction = "down" | "up" | "move";

/**
 * Encode one SGR mouse report.
 * Press/move → `CSI < Pb ; Px ; Py M`
 * Release → `CSI < Pb ; Px ; Py m`
 * Move adds +32 to the button code (xterm convention).
 */
export function encodeSgrMouse(
  action: SgrAction,
  button: SgrButton,
  col: number,
  row: number,
): string {
  const c = Math.max(1, Math.floor(col));
  const r = Math.max(1, Math.floor(row));
  const pb = button + (action === "move" ? 32 : 0);
  const final = action === "up" ? "m" : "M";
  return `\x1b[<${pb};${c};${r}${final}`;
}

/** Left-button press + release at a cell (tap / click). */
export function encodeSgrClick(col: number, row: number): string {
  return (
    encodeSgrMouse("down", 0, col, row) + encodeSgrMouse("up", 0, col, row)
  );
}

/** Encode a single SGR mouse wheel event (btn 64 up / 65 down). */
export function encodeSgrWheel(
  direction: "up" | "down",
  col: number,
  row: number,
): string {
  const btn = direction === "up" ? 64 : 65;
  return `\x1b[<${btn};${col};${row}M`;
}

/** Repeat an SGR wheel sequence `lines` times (clamped to 1..8). */
export function encodeSgrWheelLines(
  direction: "up" | "down",
  col: number,
  row: number,
  lines: number,
): string {
  const n = Math.max(1, Math.min(8, Math.floor(lines) || 1));
  const once = encodeSgrWheel(direction, col, row);
  return once.repeat(n);
}

/** Map viewport coords → 1-based terminal cell. */
export function clientToCell(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  cols: number,
  rows: number,
): { col: number; row: number } {
  const cellW = rect.width / Math.max(1, cols);
  const cellH = rect.height / Math.max(1, rows);
  const col = Math.max(
    1,
    Math.min(cols, Math.floor((clientX - rect.left) / cellW) + 1),
  );
  const row = Math.max(
    1,
    Math.min(rows, Math.floor((clientY - rect.top) / cellH) + 1),
  );
  return { col, row };
}
