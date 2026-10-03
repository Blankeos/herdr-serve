import { afterEach, describe, expect, it, vi } from "vitest";
import { installNativeBackspace } from "./native-backspace";
import { installNativeReplacement } from "./native-replacement";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function setup(mobile = false) {
  const host = document.createElement("div");
  const textarea = document.createElement("textarea");
  textarea.inputMode = "text";
  host.append(textarea);
  document.body.append(host);
  let enabled = true;
  let terminalText = "";
  const send = vi.fn((data: string) => {
    for (const char of data) {
      terminalText = char === "\x7f" ? Array.from(terminalText).slice(0, -1).join("") : terminalText + char;
    }
  });
  // Model xterm 6: insertText is forwarded wholesale; 229 schedules a diff.
  const xtermInput = vi.fn((input: Event) => {
    const event = input as InputEvent;
    if (event.inputType === "insertText" && event.data) send(event.data);
  });
  const xtermKey = vi.fn((event: KeyboardEvent) => {
    if (event.keyCode !== 229) return;
    const old = textarea.value;
    setTimeout(() => { if (textarea.value !== old) send(textarea.value.replace(old, "")); }, 0);
  });
  textarea.addEventListener("input", xtermInput, true);
  textarea.addEventListener("keydown", xtermKey, true);
  const stopReplacement = installNativeReplacement(textarea, () => enabled, send);
  const stopBackspace = mobile ? installNativeBackspace(textarea, () => enabled, send) : undefined;
  cleanup = () => { stopReplacement(); stopBackspace?.(); };
  textarea.focus();
  return { textarea, send, xtermInput, xtermKey, text: () => terminalText, setEnabled: (value: boolean) => { enabled = value; } };
}

function edit(textarea: HTMLTextAreaElement, data: string, start = textarea.value.length, end = start,
  inputType = "insertText", options: InputEventInit = {}) {
  textarea.setSelectionRange(start, end);
  const before = new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true, ...options });
  textarea.dispatchEvent(before);
  if (before.defaultPrevented) return before;
  textarea.value = textarea.value.slice(0, start) + data + textarea.value.slice(end);
  textarea.setSelectionRange(start + data.length, start + data.length);
  textarea.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true, ...options }));
  return before;
}

describe("native dictation replacements", () => {
  it.each([false, true])("reconciles 'Can we add' revisions without duplication (mobile=%s)", (mobile) => {
    const { textarea, send, text, xtermInput } = setup(mobile);
    const start = textarea.value.length; // Mobile's deletion reservoir is local-only.
    edit(textarea, "C");
    for (const revision of ["Ca", "Can", "Can we", "can we add", "Can we add"]) {
      const before = edit(textarea, revision, start, textarea.value.length, "insertText", { cancelable: false });
      expect(before.defaultPrevented).toBe(false);
      expect(text()).toBe(revision);
    }
    expect(text()).toBe("Can we add");
    expect(xtermInput).toHaveBeenCalledOnce();
    expect(send.mock.calls.some(([data]) => data.includes("x "))).toBe(false);
  });

  it("doesn't send a completed transcript again when Safari repeats the replacement", () => {
    const { textarea, send, text } = setup();
    edit(textarea, "Can we add");
    send.mockClear();
    edit(textarea, "Can we add", 0, textarea.value.length);
    expect(send).not.toHaveBeenCalled();
    expect(text()).toBe("Can we add");
  });

  it("supports corrections, shorter revisions, and selected words with preserved suffixes", () => {
    const { textarea, text } = setup();
    edit(textarea, "Can we add please");
    edit(textarea, "remove", 7, 10, "insertReplacementText");
    expect(text()).toBe("Can we remove please");
    edit(textarea, "Can we add", 0, textarea.value.length);
    expect(text()).toBe("Can we add");
  });

  it.each(["insertFromDictation", "insertFromVoice", "insertReplacementText"])("forwards %s insertions once", (inputType) => {
    const { textarea, send, text, xtermInput } = setup();
    edit(textarea, "Can we add", 0, 0, inputType);
    expect(send).toHaveBeenCalledExactlyOnceWith("Can we add");
    expect(xtermInput).not.toHaveBeenCalled();
    expect(text()).toBe("Can we add");
  });

  it("uses the actual edit when input.data is null and leaves native selection untouched", () => {
    const { textarea, send, text } = setup();
    edit(textarea, "Can");
    textarea.setSelectionRange(0, 3);
    textarea.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", bubbles: true }));
    textarea.value = "Can we add";
    textarea.setSelectionRange(10, 10);
    const value = vi.spyOn(textarea, "value", "set");
    const select = vi.spyOn(textarea, "setSelectionRange");
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: null, bubbles: true }));
    expect(send).toHaveBeenLastCalledWith(" we add");
    expect(text()).toBe("Can we add");
    expect(value).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    value.mockRestore(); select.mockRestore();
  });

  it("doesn't split surrogate pairs when a correction changes an emoji", () => {
    const { textarea, send, text } = setup();
    edit(textarea, "😀");
    edit(textarea, "😃", 0, 2);
    expect(send).toHaveBeenLastCalledWith("\x7f😃");
    expect(text()).toBe("😃");
  });

  it("blocks xterm's deferred 229 diff without canceling the native edit", () => {
    vi.useFakeTimers();
    const { textarea, send, text, xtermKey } = setup();
    const key = new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 229, bubbles: true, cancelable: true });
    textarea.dispatchEvent(key);
    edit(textarea, "C");
    edit(textarea, "Can we add", 0, 1);
    vi.runAllTimers();
    expect(key.defaultPrevented).toBe(false);
    expect(xtermKey).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(text()).toBe("Can we add");
  });

  it("leaves ordinary typing, repeated words, hardware keys, and paste to xterm", () => {
    const { textarea, xtermInput, xtermKey, text } = setup();
    edit(textarea, "Can");
    edit(textarea, " can");
    edit(textarea, "paste", textarea.value.length, textarea.value.length, "insertFromPaste");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
    expect(xtermInput).toHaveBeenCalledTimes(3);
    expect(xtermKey).toHaveBeenCalledOnce();
    expect(text()).toBe("Can can");
  });

  it("leaves actual IME compositions to xterm", () => {
    const { textarea, xtermInput, xtermKey } = setup();
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 229, bubbles: true }));
    edit(textarea, "か", 0, 0, "insertCompositionText", { isComposing: true });
    edit(textarea, "かな", 0, 1, "insertText", { isComposing: true });
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    expect(xtermInput).toHaveBeenCalledTimes(2);
    expect(xtermKey).toHaveBeenCalledOnce();
  });

  it("doesn't send anything before a native edit actually completes", () => {
    const { textarea, send } = setup();
    edit(textarea, "Can");
    send.mockClear();
    textarea.addEventListener("beforeinput", (event) => event.preventDefault(), { once: true });
    edit(textarea, "Can we add", 0, 3);
    expect(send).not.toHaveBeenCalled();
    edit(textarea, " we add"); // Subsequent normal input must not use a stale pending replacement.
    expect(send).toHaveBeenCalledExactlyOnceWith(" we add");
  });

  it.each(["disabled", "readonly", "simulated"])("doesn't intercept %s input", (mode) => {
    const { textarea, setEnabled, xtermInput } = setup();
    if (mode === "disabled") setEnabled(false);
    if (mode === "readonly") textarea.readOnly = true;
    if (mode === "simulated") textarea.inputMode = "none";
    edit(textarea, "Can");
    edit(textarea, "Can we add", 0, 3);
    expect(xtermInput).toHaveBeenCalledTimes(2);
  });

  it("resets pending edits on blur and removes all listeners on cleanup", () => {
    const { textarea, send, xtermInput } = setup();
    edit(textarea, "Can");
    textarea.setSelectionRange(0, 3);
    textarea.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", bubbles: true }));
    textarea.blur();
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: " next", bubbles: true }));
    expect(send).toHaveBeenLastCalledWith(" next");
    cleanup!(); cleanup = undefined;
    edit(textarea, "Can we add", 0, 3);
    expect(xtermInput).toHaveBeenCalledTimes(3);
  });
});
