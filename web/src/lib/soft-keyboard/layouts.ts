import type { SoftKeyDef, SoftKeyId, SoftKeyboardLayout } from "./types";

const letter = (ch: string, upper = false): SoftKeyDef => ({
  kind: "char",
  value: upper ? ch.toUpperCase() : ch,
  label: upper ? ch.toUpperCase() : ch,
});

const spacer = (
  flex = 0.5,
  opts?: { alias?: string; actionAlias?: SoftKeyId },
): SoftKeyDef => ({
  kind: "spacer",
  flex,
  ...(opts?.alias ? { alias: opts.alias } : {}),
  ...(opts?.actionAlias ? { actionAlias: opts.actionAlias } : {}),
});

/**
 * Z-row: slight optical gap between ⇧–Z and M–⌫ (not a full half-key).
 * 1.3 + 0.2 + 7×1 + 0.2 + 1.3 = 10 — matches Q-row width.
 * Spacers alias to the action so the gap still taps.
 */
const SHIFT: SoftKeyDef = {
  kind: "action",
  id: "shift",
  label: "shift",
  flex: 1.3,
  className: "sk-mod sk-shift",
};
const BACKSPACE: SoftKeyDef = {
  kind: "action",
  id: "backspace",
  label: "backspace",
  flex: 1.3,
  className: "sk-mod sk-backspace",
};

const zRow = (upper: boolean): SoftKeyDef[] => [
  SHIFT,
  spacer(0.2, { actionAlias: "shift" }),
  ..."zxcvbnm".split("").map((c) => letter(c, upper)),
  spacer(0.2, { actionAlias: "backspace" }),
  BACKSPACE,
];

/** 123 · space · . · return — period is a slim key. */
const bottomMain = (left: SoftKeyDef): SoftKeyDef[] => [
  left,
  { kind: "action", id: "space", label: "space", flex: 5.0, className: "sk-space" },
  { kind: "char", label: ".", value: ".", flex: 0.7, className: "sk-mod sk-period" },
  { kind: "action", id: "return", label: "return", flex: 1.5, className: "sk-return" },
];

/** Emoji left + mic right — own row under 123/space/./return. */
export const ACCESSORY_ROW: SoftKeyDef[] = [
  { kind: "action", id: "emoji", label: "emoji", flex: 1, className: "sk-mod sk-emoji sk-accessory-key" },
  spacer(8),
  { kind: "action", id: "mic", label: "mic", flex: 1, className: "sk-mod sk-mic sk-accessory-key" },
];

const LETTERS: SoftKeyDef[][] = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"].map((c) => letter(c)),
  [spacer(0.5, { alias: "a" }), ..."asdfghjkl".split("").map((c) => letter(c)), spacer(0.5, { alias: "l" })],
  zRow(false),
  bottomMain({ kind: "action", id: "numbers", label: "123", flex: 1.2, className: "sk-mod" }),
  ACCESSORY_ROW,
];

const SHIFTED: SoftKeyDef[][] = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"].map((c) => letter(c, true)),
  [spacer(0.5, { alias: "A" }), ..."asdfghjkl".split("").map((c) => letter(c, true)), spacer(0.5, { alias: "L" })],
  zRow(true),
  bottomMain({ kind: "action", id: "numbers", label: "123", flex: 1.2, className: "sk-mod" }),
  ACCESSORY_ROW,
];

const NUMBERS: SoftKeyDef[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((c) => letter(c)),
  ["-", "/", ":", ";", "(", ")", "$", "&", "@", '"'].map((c) => letter(c)),
  [
    { kind: "action", id: "symbols", label: "#+=", flex: 1.5, className: "sk-mod" },
    ...[".", ",", "?", "!", "'"].map((c) => letter(c)),
    BACKSPACE,
  ],
  bottomMain({ kind: "action", id: "letters", label: "ABC", flex: 1.2, className: "sk-mod" }),
  ACCESSORY_ROW,
];

const SYMBOLS: SoftKeyDef[][] = [
  ["[", "]", "{", "}", "#", "%", "^", "*", "+", "="].map((c) => letter(c)),
  ["_", "\\", "|", "~", "<", ">", "€", "£", "¥", "•"].map((c) => letter(c)),
  [
    { kind: "action", id: "numbers", label: "123", flex: 1.5, className: "sk-mod" },
    ...[".", ",", "?", "!", "'"].map((c) => letter(c)),
    BACKSPACE,
  ],
  bottomMain({ kind: "action", id: "letters", label: "ABC", flex: 1.2, className: "sk-mod" }),
  ACCESSORY_ROW,
];

export function layoutRows(layout: SoftKeyboardLayout): SoftKeyDef[][] {
  switch (layout) {
    case "shifted":
      return SHIFTED;
    case "numbers":
      return NUMBERS;
    case "symbols":
      return SYMBOLS;
    case "letters":
    default:
      return LETTERS;
  }
}
