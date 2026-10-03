import { afterEach, describe, expect, it, vi } from "vitest";
import { installNativeBackspace } from "./native-backspace";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function setup() {
  const host = document.createElement("div");
  const textarea = document.createElement("textarea");
  textarea.inputMode = "text";
  host.append(textarea);
  document.body.append(host);
  let enabled = true;
  const send = vi.fn();
  // Model xterm's existing capture listener which normally cancels Backspace.
  const xtermKey = vi.fn((event: KeyboardEvent) => {
    if (event.key === "Backspace") event.preventDefault();
  });
  const xtermInput = vi.fn();
  textarea.addEventListener("keydown", xtermKey, true);
  textarea.addEventListener("input", xtermInput, true);
  cleanup = installNativeBackspace(textarea, () => enabled, send);
  textarea.focus();
  return { textarea, send, xtermKey, xtermInput, setEnabled: (value: boolean) => { enabled = value; } };
}

function deletion(textarea: HTMLTextAreaElement, composing = false, before = true) {
  if (before) textarea.dispatchEvent(new InputEvent("beforeinput", {
    inputType: "deleteContentBackward", bubbles: true, cancelable: true, isComposing: composing,
  }));
  // jsdom doesn't perform the browser's native editing action.
  const end = textarea.selectionStart;
  textarea.value = textarea.value.slice(0, Math.max(0, end - 1)) + textarea.value.slice(textarea.selectionEnd);
  textarea.setSelectionRange(Math.max(0, end - 1), Math.max(0, end - 1));
  textarea.dispatchEvent(new InputEvent("input", {
    inputType: "deleteContentBackward", bubbles: true, isComposing: composing,
  }));
}

const key = (textarea: HTMLTextAreaElement, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: "Backspace", keyCode: 8, bubbles: true, cancelable: true, ...options });
  textarea.dispatchEvent(event);
  return event;
};

describe("native Backspace", () => {
  it("doesn't cancel keydown or double-send the first deletion", () => {
    const { textarea, send, xtermKey, xtermInput } = setup();
    expect(textarea.value.length).toBeGreaterThan(0);
    expect(key(textarea).defaultPrevented).toBe(false);
    expect(xtermKey).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    deletion(textarea);
    expect(send).toHaveBeenCalledExactlyOnceWith("\x7f");
    expect(xtermInput).not.toHaveBeenCalled();
  });

  it("forwards all held-key deletion ticks without running out of helper text", () => {
    const { textarea, send } = setup();
    key(textarea);
    const initialLength = textarea.value.length;
    for (let i = 0; i < 200; i++) deletion(textarea);
    expect(textarea.value.length).toBe(initialLength - 200);
    expect(send).toHaveBeenCalledTimes(200);
    expect(send.mock.calls.every(([data]) => data === "\x7f")).toBe(true);
    expect(textarea.value.length).toBeGreaterThan(0);
    expect(textarea.selectionStart).toBe(textarea.value.length);
  });

  it("keeps keyCode-229 deferred textarea diffs from duplicating deletion", () => {
    vi.useFakeTimers();
    const { textarea, send } = setup();
    textarea.value = "hello";
    textarea.setSelectionRange(5, 5);
    textarea.addEventListener("keydown", () => {
      const old = textarea.value;
      setTimeout(() => {
        if (textarea.value !== old) send("duplicate");
      }, 0);
    }, true);
    key(textarea, { key: "Unidentified", keyCode: 229 });
    deletion(textarea);
    vi.runAllTimers();
    expect(send).toHaveBeenCalledExactlyOnceWith("\x7f");
    expect(textarea.value).toBe("hell");
  });

  it("handles keyboards that emit deletion input without beforeinput", async () => {
    const { textarea, send } = setup();
    textarea.value = "x";
    textarea.setSelectionRange(1, 1);
    deletion(textarea, false, false);
    expect(send).toHaveBeenCalledExactlyOnceWith("\x7f");
    expect(textarea.value).toBe("");
    await Promise.resolve();
    expect(textarea.value.length).toBeGreaterThan(0);
  });

  it("doesn't rewrite native value or selection while handling a deletion", () => {
    const { textarea, send } = setup();
    textarea.value = "hello";
    textarea.setSelectionRange(5, 5);
    textarea.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "deleteContentBackward", bubbles: true, cancelable: true,
    }));
    textarea.value = "hell"; // Native browser edit.
    textarea.setSelectionRange(4, 4);
    const select = vi.spyOn(textarea, "setSelectionRange");
    const value = vi.spyOn(textarea, "value", "set");
    textarea.dispatchEvent(new InputEvent("input", {
      inputType: "deleteContentBackward", bubbles: true,
    }));
    expect(select).not.toHaveBeenCalled();
    expect(value).not.toHaveBeenCalled();
    expect(textarea.value).toBe("hell");
    expect(send).toHaveBeenCalledExactlyOnceWith("\x7f");
    select.mockRestore(); value.mockRestore();
  });

  it("passes 229 insertion input to xterm instead of its deferred diff", () => {
    const { textarea, send, xtermKey, xtermInput } = setup();
    key(textarea, { key: "Unidentified", keyCode: 229 });
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "a", bubbles: true }));
    expect(xtermKey).not.toHaveBeenCalled();
    expect(xtermInput).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("doesn't re-seed after blur or cleanup while a microtask is pending", async () => {
    const { textarea } = setup();
    textarea.value = "x";
    textarea.setSelectionRange(1, 1);
    deletion(textarea);
    textarea.blur();
    await Promise.resolve();
    expect(textarea.value).toBe("");
    textarea.focus();
    textarea.value = "x";
    textarea.setSelectionRange(1, 1);
    deletion(textarea);
    cleanup!(); cleanup = undefined;
    await Promise.resolve();
    expect(textarea.value).toBe("");
  });

  it("forwards iOS accelerated backward deletion types but not forward deletes", () => {
    const { textarea, send } = setup();
    for (const inputType of ["deleteWordBackward", "deleteSoftLineBackward", "deleteHardLineBackward", "deleteContentForward"]) {
      textarea.dispatchEvent(new InputEvent("input", { inputType, bubbles: true }));
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.every(([data]) => data === "\x7f")).toBe(true);
  });

  it("leaves modified Backspace and other keys to xterm", () => {
    const { textarea, send, xtermKey } = setup();
    for (const modifier of ["ctrlKey", "altKey", "metaKey", "shiftKey"]) key(textarea, { [modifier]: true });
    key(textarea, { key: "Enter", keyCode: 13 });
    expect(xtermKey).toHaveBeenCalledTimes(5);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not forward deletions while composing", () => {
    const { textarea, send, xtermKey, xtermInput } = setup();
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    key(textarea);
    deletion(textarea);
    expect(send).not.toHaveBeenCalled();
    expect(xtermKey).toHaveBeenCalledOnce();
    expect(xtermInput).toHaveBeenCalledOnce();
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    deletion(textarea, true);
    expect(send).not.toHaveBeenCalled();
    deletion(textarea);
    expect(send).toHaveBeenCalledExactlyOnceWith("\x7f");
  });

  it("does nothing on desktop, simulated mode, or read-only inputs", () => {
    const { textarea, send, setEnabled, xtermKey, xtermInput } = setup();
    setEnabled(false);
    key(textarea);
    deletion(textarea);
    setEnabled(true);
    textarea.readOnly = true;
    key(textarea);
    deletion(textarea);
    textarea.readOnly = false;
    textarea.inputMode = "none";
    key(textarea);
    deletion(textarea);
    expect(send).not.toHaveBeenCalled();
    expect(xtermKey).toHaveBeenCalledTimes(3);
    expect(xtermInput).toHaveBeenCalledTimes(3);
  });

  it("doesn't intercept normal text input or send the seed to the terminal", () => {
    const { textarea, send, xtermInput } = setup();
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "a", bubbles: true }));
    expect(send).not.toHaveBeenCalled();
    expect(xtermInput).toHaveBeenCalledOnce();
  });

  it("removes listeners and owned seed on cleanup", () => {
    const { textarea, send, xtermKey } = setup();
    cleanup!();
    cleanup = undefined;
    expect(textarea.value).toBe("");
    expect(key(textarea).defaultPrevented).toBe(true);
    deletion(textarea);
    expect(send).not.toHaveBeenCalled();
    expect(xtermKey).toHaveBeenCalledOnce();
  });
});
