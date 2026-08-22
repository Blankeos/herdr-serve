export type SoftKeyboardLayout = "letters" | "shifted" | "numbers" | "symbols";

export type SoftKeyId =
  | "shift"
  | "backspace"
  | "numbers"
  | "letters"
  | "symbols"
  | "emoji"
  | "mic"
  | "paste"
  | "space"
  | "return"
  | "globe";

export type SoftKeyDef =
  | { kind: "char"; label: string; value: string; flex?: number; className?: string }
  | { kind: "action"; id: SoftKeyId; label: string; flex?: number; className?: string }
  /**
   * Visual inset only.
   * - `alias`: taps insert that char (A/L hit expand).
   * - `actionAlias`: taps fire that action id (⇧–Z / M–⌫ gaps).
   */
  | { kind: "spacer"; flex?: number; alias?: string; actionAlias?: SoftKeyId };

export type SoftKeyboardHandlers = {
  onInsert: (text: string) => void;
  onBackspace: () => void;
  onReturn: () => void;
  onEmoji?: () => void;
  onMicToggle?: () => void;
  onPaste?: () => void;
};

export type SoftKeyboardProps = SoftKeyboardHandlers & {
  open: boolean;
  micActive?: boolean;
  class?: string;
};
