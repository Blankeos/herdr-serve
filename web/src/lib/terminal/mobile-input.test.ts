import { describe, expect, it } from "vitest";
import { prepareTerminalInput } from "./mobile-input";

describe("terminal mobile input", () => {
  it("allows native input without changing xterm's cursor geometry", () => {
    const textarea = document.createElement("textarea");
    textarea.style.left = "42px";
    textarea.style.top = "60px";
    prepareTerminalInput(textarea, "native");
    expect(textarea.readOnly).toBe(false);
    expect(textarea.inputMode).toBe("text");
    expect(textarea.style.left).toBe("42px");
    expect(textarea.style.top).toBe("60px");
    expect(textarea.style.pointerEvents).toBe("none");
    expect(textarea.style.fontSize).toBe("16px");
  });
  it("suppresses IME in simulated mode and restores it when switching back", () => {
    const textarea = document.createElement("textarea");
    prepareTerminalInput(textarea, "simulated");
    expect(textarea.readOnly).toBe(true);
    expect(textarea.inputMode).toBe("none");
    prepareTerminalInput(textarea, "native");
    expect(textarea.readOnly).toBe(false);
    expect(textarea.inputMode).toBe("text");
  });
});
