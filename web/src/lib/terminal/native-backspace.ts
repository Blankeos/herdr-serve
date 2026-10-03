// This is local helper text, never terminal input. Ordinary spaced characters
// give WebKit real deletion boundaries; an all-ZWS run can be deleted as one
// invisible unit. A reservoir avoids resetting Safari's selection on each tick.
const DELETE_SEED = "x ".repeat(2048);
const BACKWARD_DELETIONS = new Set([
  "deleteContentBackward", "deleteWordBackward", "deleteSoftLineBackward", "deleteHardLineBackward",
]);

/**
 * xterm cancels Backspace keydown, which can stop iOS hold-to-delete. Let plain
 * mobile Backspace edit the helper textarea and send DEL on native input events.
 * Don't restore value/selection after deletion: that can reset native autorepeat.
 */
export function installNativeBackspace(
  textarea: HTMLTextAreaElement,
  enabled: () => boolean,
  send: (data: string) => void,
): () => void {
  // Run before xterm's capture listeners without touching its private internals.
  const host = textarea.parentElement!;
  let composing = false;
  let disposed = false;
  const active = () => enabled() && !textarea.readOnly && textarea.inputMode !== "none";
  const seed = () => {
    if (disposed || !active() || composing || textarea.value) return;
    textarea.value = DELETE_SEED;
    textarea.setSelectionRange(DELETE_SEED.length, DELETE_SEED.length);
  };
  const onFocus = () => { seed(); };
  const onBlur = () => { composing = false; };
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => { composing = false; };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== textarea || !active() || composing || event.isComposing
      || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const backspace = event.key === "Backspace" || event.keyCode === 8;
    // Mobile IMEs can report deletions as Unidentified/229. xterm schedules a
    // textarea diff for 229 which would duplicate our input-event deletion (or
    // send the helper buffer). Input/composition events handle that path instead.
    if (!backspace && event.keyCode !== 229) return;
    if (backspace) seed();
    // Never preventDefault or send here: let the OS perform its editing action.
    event.stopImmediatePropagation();
  };
  const onBeforeInput = (event: InputEvent) => {
    if (event.target !== textarea || !active() || composing || event.isComposing
      || event.defaultPrevented || !BACKWARD_DELETIONS.has(event.inputType)) return;
    seed();
  };
  const onInput = (event: InputEvent) => {
    if (event.target !== textarea || !active() || composing || event.isComposing
      || !BACKWARD_DELETIONS.has(event.inputType)) return;
    event.stopImmediatePropagation();
    send("\x7f");
    // Only replenish when exhausted, after the native edit has completed.
    // In the normal repeat path this does not touch value or selection at all.
    queueMicrotask(() => {
      if (document.activeElement === textarea) seed();
    });
  };

  host.addEventListener("keydown", onKeyDown, true);
  host.addEventListener("beforeinput", onBeforeInput as EventListener, true);
  host.addEventListener("input", onInput as EventListener, true);
  textarea.addEventListener("focus", onFocus);
  textarea.addEventListener("blur", onBlur);
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);
  if (document.activeElement === textarea) onFocus();

  return () => {
    disposed = true;
    host.removeEventListener("keydown", onKeyDown, true);
    host.removeEventListener("beforeinput", onBeforeInput as EventListener, true);
    host.removeEventListener("input", onInput as EventListener, true);
    textarea.removeEventListener("focus", onFocus);
    textarea.removeEventListener("blur", onBlur);
    textarea.removeEventListener("compositionstart", onCompositionStart);
    textarea.removeEventListener("compositionend", onCompositionEnd);
    if (textarea.value === DELETE_SEED) textarea.value = "";
  };
}
