import { afterEach, describe, expect, it } from "vitest";
import { STORAGE_KEY, chordToBytes, defaultConfig, loadConfig, saveConfig, shortcutToBytes } from "./shortcuts";

afterEach(() => localStorage.removeItem(STORAGE_KEY));

describe("Shift+Enter default", () => {
  it("replaces plain Enter in new configurations", () => {
    const defaults = defaultConfig().shortcuts;
    const enter = defaults.find(s => s.id === "shift-enter")!;
    expect(enter.label).toBe("Shift+Enter");
    expect(enter.chords).toEqual([{ shift: true, key: "Enter" }]);
    expect(defaults.some(s => s.id === "enter")).toBe(false);
    expect(shortcutToBytes(enter)).toBe("\x1b[13;2u");
    expect(loadConfig()).toEqual(defaultConfig());
  });

  it("keeps native Return distinct from Shift+Enter", () => {
    expect(chordToBytes({ key: "Enter" })).toBe("\r");
    expect(chordToBytes({ key: "Enter", shift: true })).toBe("\x1b[13;2u");
  });

  it("does not overwrite saved shortcut lists", () => {
    saveConfig({ version: 1, shortcuts: [{ id: "enter", label: "My Return", chords: [{ key: "Enter" }] }] });
    expect(loadConfig().shortcuts.map(s => s.label)).toEqual(["My Return"]);
  });
});
