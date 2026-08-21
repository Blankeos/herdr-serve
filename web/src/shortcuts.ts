/** Configurable mobile shortcut bar — stored in localStorage, import/exportable. */

export type KeyChord = {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  /** KeyboardEvent.key (e.g. "c", "Escape", "ArrowUp", "Enter") */
  key: string;
};

export type Shortcut = {
  id: string;
  /** Button label shown in the footer */
  label: string;
  /** One or more chords sent in order (e.g. Ctrl+X then M) */
  chords: KeyChord[];
};

export type ShortcutConfig = {
  version: 1;
  shortcuts: Shortcut[];
};

export const STORAGE_KEY = "herdr-serve.shortcuts.v1";

export const DEFAULT_SHORTCUTS: Shortcut[] = [
  { id: "ctrl-c", label: "Ctrl+C", chords: [{ ctrl: true, key: "c" }] },
  { id: "ctrl-d", label: "Ctrl+D", chords: [{ ctrl: true, key: "d" }] },
  { id: "esc", label: "Esc", chords: [{ key: "Escape" }] },
  { id: "enter", label: "Enter", chords: [{ key: "Enter" }] },
  { id: "up", label: "↑", chords: [{ key: "ArrowUp" }] },
  { id: "down", label: "↓", chords: [{ key: "ArrowDown" }] },
  { id: "left", label: "←", chords: [{ key: "ArrowLeft" }] },
  { id: "right", label: "→", chords: [{ key: "ArrowRight" }] },
];

export function defaultConfig(): ShortcutConfig {
  return { version: 1, shortcuts: DEFAULT_SHORTCUTS.map((s) => ({ ...s, chords: s.chords.map((c) => ({ ...c })) })) };
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptyShortcut(): Shortcut {
  return { id: newId(), label: "", chords: [] };
}

function isChord(v: unknown): v is KeyChord {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.key === "string" && c.key.length > 0;
}

function isShortcut(v: unknown): v is Shortcut {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.label === "string" &&
    Array.isArray(s.chords) &&
    s.chords.every(isChord)
  );
}

export function normalizeConfig(raw: unknown): ShortcutConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.shortcuts)
    ? o.shortcuts
    : Array.isArray(raw)
      ? raw
      : null;
  if (!list) return null;
  const shortcuts = list.filter(isShortcut).map((s) => ({
    id: s.id || newId(),
    label: s.label || formatChords(s.chords),
    chords: s.chords.map((c) => ({
      ctrl: Boolean(c.ctrl),
      alt: Boolean(c.alt),
      shift: Boolean(c.shift),
      meta: Boolean(c.meta),
      key: c.key,
    })),
  }));
  return { version: 1, shortcuts };
}

export function loadConfig(): ShortcutConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    const parsed = normalizeConfig(JSON.parse(raw));
    return parsed ?? defaultConfig();
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config: ShortcutConfig): void {
  const normalized = normalizeConfig(config) ?? defaultConfig();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

export function exportConfig(config: ShortcutConfig): string {
  const normalized = normalizeConfig(config) ?? defaultConfig();
  return JSON.stringify(normalized, null, 2);
}

export function importConfig(text: string): ShortcutConfig {
  const parsed = normalizeConfig(JSON.parse(text));
  if (!parsed) throw new Error("Invalid shortcut config");
  return parsed;
}

/** Pretty-print a chord for labels / settings list. */
export function formatChord(c: KeyChord): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  if (c.meta) parts.push("Meta");
  parts.push(displayKey(c.key));
  return parts.join("+");
}

export function formatChords(chords: KeyChord[]): string {
  if (!chords.length) return "(empty)";
  return chords.map(formatChord).join(" then ");
}

function displayKey(key: string): string {
  switch (key) {
    case " ":
    case "Spacebar":
      return "Space";
    case "Escape":
      return "Esc";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    case "Enter":
      return "Enter";
    case "Tab":
      return "Tab";
    case "Backspace":
      return "Backspace";
    case "Delete":
      return "Del";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/** Build a KeyChord from a KeyboardEvent (ignores pure modifier presses). */
export function chordFromEvent(e: KeyboardEvent): KeyChord | null {
  const key = e.key;
  if (
    key === "Control" ||
    key === "Alt" ||
    key === "Shift" ||
    key === "Meta" ||
    key === "OS"
  ) {
    return null;
  }
  return {
    ctrl: e.ctrlKey || e.key === "Control",
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey,
    key: normalizeEventKey(e),
  };
}

function normalizeEventKey(e: KeyboardEvent): string {
  if (e.key === " ") return " ";
  // Prefer stable names for letters when modifiers are held
  if (e.key.length === 1) {
    return e.key.toLowerCase();
  }
  return e.key;
}

/**
 * Convert a chord to the bytes a terminal expects.
 * Matches typical xterm / VT behavior for common keys.
 */
export function chordToBytes(c: KeyChord): string {
  const key = c.key;

  // Ctrl + letter / symbol
  if (c.ctrl && !c.alt && !c.meta) {
    if (key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) {
        // @ A-Z [ \ ] ^ _
        return String.fromCharCode(code - 64);
      }
      if (code >= 97 && code <= 122) {
        return String.fromCharCode(code - 96);
      }
    }
    if (key === " ") return "\x00";
    if (key === "[") return "\x1b";
    if (key === "\\") return "\x1c";
    if (key === "]") return "\x1d";
    if (key === "^" || key === "6") return "\x1e";
    if (key === "_" || key === "-" || key === "/") return "\x1f";
    if (key === "?") return "\x7f";
  }

  // Alt / Meta → ESC prefix (common terminal convention)
  if ((c.alt || c.meta) && !c.ctrl) {
    const base = chordToBytes({ ...c, alt: false, meta: false });
    return "\x1b" + base;
  }

  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return c.shift ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "Backspace":
      return "\x7f";
    case "Delete":
      return "\x1b[3~";
    case "ArrowUp":
      return c.shift ? "\x1b[1;2A" : "\x1b[A";
    case "ArrowDown":
      return c.shift ? "\x1b[1;2B" : "\x1b[B";
    case "ArrowRight":
      return c.shift ? "\x1b[1;2C" : "\x1b[C";
    case "ArrowLeft":
      return c.shift ? "\x1b[1;2D" : "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case " ":
      return " ";
    default:
      if (key.length === 1) {
        if (c.shift) return key.toUpperCase();
        return key;
      }
      // Function keys F1–F12
      if (/^F([1-9]|1[0-2])$/.test(key)) {
        const n = Number(key.slice(1));
        const map: Record<number, string> = {
          1: "\x1bOP",
          2: "\x1bOQ",
          3: "\x1bOR",
          4: "\x1bOS",
          5: "\x1b[15~",
          6: "\x1b[17~",
          7: "\x1b[18~",
          8: "\x1b[19~",
          9: "\x1b[20~",
          10: "\x1b[21~",
          11: "\x1b[23~",
          12: "\x1b[24~",
        };
        return map[n] ?? "";
      }
      return "";
  }
}

export function shortcutToBytes(s: Shortcut): string {
  return s.chords.map(chordToBytes).join("");
}

export function suggestLabel(chords: KeyChord[]): string {
  return formatChords(chords);
}
