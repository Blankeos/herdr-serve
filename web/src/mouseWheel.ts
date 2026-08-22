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
