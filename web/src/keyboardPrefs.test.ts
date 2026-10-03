import { afterEach, describe, expect, it, vi } from "vitest";
import { loadKeyboardMode, saveKeyboardMode } from "./keyboardPrefs";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("keyboard preference", () => {
  it("defaults to native for new browsers and unknown saved values", () => {
    expect(loadKeyboardMode()).toBe("native");
    localStorage.setItem("herdr.keyboardMode", "invalid");
    expect(loadKeyboardMode()).toBe("native");
  });
  it("persists either mode", () => {
    saveKeyboardMode("simulated");
    expect(loadKeyboardMode()).toBe("simulated");
    saveKeyboardMode("native");
    expect(loadKeyboardMode()).toBe("native");
  });
  it("tolerates unavailable storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadKeyboardMode()).toBe("native");
    expect(() => saveKeyboardMode("simulated")).not.toThrow();
  });
});
