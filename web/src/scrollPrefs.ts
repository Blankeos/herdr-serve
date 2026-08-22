export type ScrollMode = "auto" | "host" | "mouse" | "keys";

const SCROLL_MODE_KEY = "herdr.scrollMode";
const DEFAULT_SCROLL_MODE: ScrollMode = "auto";

/** Hardcoded key chords for keys mode (Ctrl-X then K/J). */
const SCROLL_KEY_BYTES = {
  up: "\x18k",
  down: "\x18j",
} as const;

const VALID_MODES = new Set<ScrollMode>(["auto", "host", "mouse", "keys"]);

export function loadScrollMode(): ScrollMode {
  try {
    const raw = localStorage.getItem(SCROLL_MODE_KEY);
    if (raw && VALID_MODES.has(raw as ScrollMode)) {
      return raw as ScrollMode;
    }
  } catch {
    // ignore storage failures
  }
  return DEFAULT_SCROLL_MODE;
}

export function saveScrollMode(mode: ScrollMode): void {
  try {
    localStorage.setItem(SCROLL_MODE_KEY, mode);
  } catch {
    // ignore storage failures
  }
}

export function scrollKeyBytes(direction: "up" | "down"): string {
  return SCROLL_KEY_BYTES[direction];
}
