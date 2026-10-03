import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeyboardDiagnostics } from "./keyboard-diagnostics";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ""; });
describe("keyboard diagnostics", () => {
  it("records bounded metadata without typed text, input data or clipboard contents", async () => {
    vi.useFakeTimers();
    let report: Blob | undefined;
    vi.stubGlobal("URL", { createObjectURL: (blob: Blob) => { report = blob; return "blob:test"; }, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const ta = document.createElement("textarea"); document.body.append(ta);
    ta.value = "secret clipboard";
    const diagnostics = createKeyboardDiagnostics(ta);
    diagnostics.start();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "s", keyCode: 83, bubbles: true }));
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "secret data", bubbles: true }));
    vi.advanceTimersByTime(20001);
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "later", bubbles: true }));
    diagnostics.download();
    vi.useRealTimers();
    const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsText(report!); });
    expect(text).not.toContain("secret");
    const entries = JSON.parse(text).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].key).toBe("other");
    expect(entries[0].code).toBe("other");
    diagnostics.stop();
    vi.unstubAllGlobals();
  });
});
