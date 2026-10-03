const INSERTIONS = new Set(["insertText", "insertReplacementText", "insertFromDictation", "insertFromVoice"]);

/**
 * Apple dictation revises its transcript using insertText over a selected range,
 * without composition events. xterm sends each revision as another append.
 * Observe the native edit and reconcile only the changed tail before xterm's
 * input listener runs. Never cancel the edit or rewrite the OS's helper buffer.
 */
export function installNativeReplacement(
  textarea: HTMLTextAreaElement,
  enabled: () => boolean,
  send: (data: string) => void,
): () => void {
  const host = textarea.parentElement!;
  let composing = false;
  let pending: { value: string; start: number; inputType: string } | undefined;
  const active = () => enabled() && !textarea.readOnly && textarea.inputMode !== "none";
  const reset = () => { pending = undefined; };
  const onCompositionStart = () => { composing = true; reset(); };
  const onCompositionEnd = () => { composing = false; reset(); };
  const onBlur = () => { composing = false; reset(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== textarea || !active() || composing || event.isComposing) return;
    reset();
    // Otherwise xterm's CompositionHelper schedules an additional textarea diff
    // for 229. Native input events already handle these non-composition edits.
    if (event.keyCode === 229 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.stopImmediatePropagation();
    }
  };
  const onBeforeInput = (event: InputEvent) => {
    if (event.target !== textarea) return;
    reset();
    if (!active() || composing || event.isComposing || event.defaultPrevented
      || !INSERTIONS.has(event.inputType)) return;
    // Ordinary insertText with a collapsed selection belongs to xterm. The
    // other insertion types are not supported by xterm's input handler at all.
    if (event.inputType === "insertText" && textarea.selectionStart === textarea.selectionEnd) return;
    pending = { value: textarea.value, start: textarea.selectionStart, inputType: event.inputType };
  };
  const onInput = (event: InputEvent) => {
    if (event.target !== textarea) return;
    const edit = pending;
    reset();
    if (!edit || !active() || composing || event.isComposing || event.inputType !== edit.inputType) return;
    event.stopImmediatePropagation();
    // Use the actual textarea mutation, not ev.data (which can be null or a
    // repeated full transcript). Preserve suffix text and avoid resending the
    // unchanged prefix. Code points keep surrogate pairs intact.
    const oldTail = Array.from(edit.value.slice(edit.start));
    const newTail = Array.from(textarea.value.slice(edit.start));
    let shared = 0;
    while (shared < oldTail.length && shared < newTail.length && oldTail[shared] === newTail[shared]) shared++;
    const data = "\x7f".repeat(oldTail.length - shared) + newTail.slice(shared).join("");
    if (data) send(data);
  };

  // Parent capture runs ahead of xterm's capture listeners on the textarea.
  host.addEventListener("keydown", onKeyDown, true);
  host.addEventListener("beforeinput", onBeforeInput as EventListener, true);
  host.addEventListener("input", onInput as EventListener, true);
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);
  textarea.addEventListener("blur", onBlur);
  return () => {
    reset();
    host.removeEventListener("keydown", onKeyDown, true);
    host.removeEventListener("beforeinput", onBeforeInput as EventListener, true);
    host.removeEventListener("input", onInput as EventListener, true);
    textarea.removeEventListener("compositionstart", onCompositionStart);
    textarea.removeEventListener("compositionend", onCompositionEnd);
    textarea.removeEventListener("blur", onBlur);
  };
}
