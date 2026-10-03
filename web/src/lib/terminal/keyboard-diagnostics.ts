const EVENT_TYPES = ["keydown", "keypress", "keyup", "beforeinput", "input", "compositionstart", "compositionend", "focus", "blur", "selectionchange"];

/** Opt-in, bounded metadata trace. Never record key characters, input data or text. */
export function createKeyboardDiagnostics(textarea: HTMLTextAreaElement) {
  let entries: Record<string, unknown>[] = [];
  let started = 0;
  let timer: number | undefined;
  const capture = (event: Event) => {
    if (event.target !== textarea && event.type !== "selectionchange") return;
    if (entries.length >= 500) return;
    const key = event instanceof KeyboardEvent ? event : undefined;
    const input = event instanceof InputEvent ? event : undefined;
    const rect = textarea.getBoundingClientRect();
    const entry: Record<string, unknown> = {
      ms: Math.round(performance.now() - started), type: event.type,
      key: key ? (key.key === "Backspace" || key.key === "Unidentified" ? key.key : "other") : undefined,
      code: key ? (key.keyCode === 8 || key.keyCode === 229 ? key.keyCode : "other") : undefined,
      repeat: key?.repeat, inputType: input?.inputType, composing: input?.isComposing ?? key?.isComposing,
      prevented: event.defaultPrevented, length: textarea.value.length,
      selection: [textarea.selectionStart, textarea.selectionEnd],
      focused: document.activeElement === textarea, readOnly: textarea.readOnly, inputMode: textarea.inputMode,
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
    };
    entries.push(entry);
    queueMicrotask(() => { entry.preventedAfter = event.defaultPrevented; });
  };
  const stop = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    for (const type of EVENT_TYPES) document.removeEventListener(type, capture, true);
  };
  return {
    start() {
      stop(); entries = []; started = performance.now();
      for (const type of EVENT_TYPES) document.addEventListener(type, capture, true);
      timer = window.setTimeout(stop, 20000);
    },
    download() {
      stop();
      const url = URL.createObjectURL(new Blob([JSON.stringify({ userAgent: navigator.userAgent, entries }, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = "herdr-keyboard-diagnostics.json"; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    stop,
  };
}
