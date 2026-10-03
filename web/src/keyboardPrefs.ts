export type KeyboardMode = "native" | "simulated";

const KEYBOARD_MODE_KEY = "herdr.keyboardMode";

export function loadKeyboardMode(): KeyboardMode {
  try {
    if (localStorage.getItem(KEYBOARD_MODE_KEY) === "simulated") return "simulated";
  } catch {
    // Private browsing / blocked storage must not prevent native input.
  }
  return "native";
}

export function saveKeyboardMode(mode: KeyboardMode): void {
  try {
    localStorage.setItem(KEYBOARD_MODE_KEY, mode);
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
}
