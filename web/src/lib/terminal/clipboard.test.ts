import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativePaste, pasteClipboardText } from "./clipboard";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.(); cleanup = undefined;
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  document.body.innerHTML = "";
});
describe("terminal clipboard", () => {
  it("requests native paste before awaiting or accessing Clipboard API", async () => {
    const read = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { readText: read } });
    const send = vi.fn(), unavailable = vi.fn(), native = vi.fn(() => true);
    const result = pasteClipboardText(send, native, unavailable);
    expect(native).toHaveBeenCalledOnce();
    await result;
    expect(read).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
  });
  it("reads text directly when the native command is unsupported", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: vi.fn().mockResolvedValue("hello\nworld") } });
    const send = vi.fn(), unavailable = vi.fn();
    await pasteClipboardText(send, () => false, unavailable);
    expect(send).toHaveBeenCalledExactlyOnceWith("hello\nworld");
    expect(unavailable).not.toHaveBeenCalled();
  });
  it.each([undefined, { readText: vi.fn().mockRejectedValue(new Error("denied")) }, { readText: vi.fn().mockResolvedValue("") }])(
    "reports unavailable clipboard instead of opening a custom dialog", async clipboard => {
      vi.stubGlobal("navigator", { clipboard });
      const send = vi.fn(), unavailable = vi.fn();
      await pasteClipboardText(send, () => false, unavailable);
      expect(unavailable).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
    },
  );
});

function setup(command: () => boolean) {
  const previous = document.createElement("button");
  const host = document.createElement("div");
  document.body.append(previous, host); previous.focus();
  Object.defineProperty(document, "execCommand", { configurable: true, value: command });
  const native = createNativePaste(host);
  cleanup = () => { native.dispose(); delete (document as Partial<Document>).execCommand; };
  const send = vi.fn();
  return { previous, host, native, send };
}
function paste(target: Element, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  target.dispatchEvent(event);
  return event;
}
describe("native paste target", () => {
  it("waits for native confirmation, sends exactly once and restores focus", () => {
    const { previous, host, native, send } = setup(() => true);
    expect(native.request(send)).toBe(true);
    const target = host.querySelector("textarea")!;
    expect(target.readOnly).toBe(false);
    expect(target.inputMode).toBe("none");
    expect(target.style.width).toBe("16px");
    expect(document.activeElement).toBe(target);
    expect(paste(target, "copied\ntext").defaultPrevented).toBe(true);
    paste(target, "duplicate");
    expect(send).toHaveBeenCalledExactlyOnceWith("copied\ntext");
    expect(host.childElementCount).toBe(0);
    expect(document.activeElement).toBe(previous);
  });
  it("handles synchronous paste even if execCommand returns false", () => {
    const { native, send } = setup(() => { paste(document.activeElement!, "sync"); return false; });
    expect(native.request(send)).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith("sync");
  });
  it("cleans up when native paste is unsupported", () => {
    const { native, host, previous, send } = setup(() => false);
    expect(native.request(send)).toBe(false);
    expect(host.childElementCount).toBe(0);
    expect(document.activeElement).toBe(previous);
    expect(send).not.toHaveBeenCalled();
  });
  it("supports insertFromPaste without a paste event", () => {
    const { native, host, send } = setup(() => true);
    native.request(send);
    const target = host.querySelector("textarea")!;
    target.value = "input fallback";
    target.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", bubbles: true }));
    expect(send).toHaveBeenCalledExactlyOnceWith("input fallback");
    expect(host.childElementCount).toBe(0);
  });
  it("cancels pending prompts without sending or stealing another input's focus", () => {
    vi.useFakeTimers();
    const { native, host, send } = setup(() => true);
    native.request(send);
    const other = document.createElement("input"); document.body.append(other); other.focus();
    vi.advanceTimersByTime(30001);
    expect(host.childElementCount).toBe(0);
    expect(document.activeElement).toBe(other);
    expect(send).not.toHaveBeenCalled();
  });
});
