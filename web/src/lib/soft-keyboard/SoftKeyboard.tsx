import { createEffect, onCleanup } from "solid-js";
import { createDomSoftKeyboard, type DomSoftKeyboard } from "./dom-keyboard";
import type { SoftKeyboardProps } from "./types";
import "./soft-keyboard.css";

/**
 * Thin Solid host for the pure-DOM soft keyboard.
 * All press/layout work stays off the VDOM — only open/mic/handlers sync in.
 */
export default function SoftKeyboard(props: SoftKeyboardProps) {
  let kb: DomSoftKeyboard | undefined;

  const attach = (el: HTMLDivElement) => {
    if (kb || !el) return;
    kb = createDomSoftKeyboard({
      onInsert: (t) => props.onInsert(t),
      onBackspace: () => props.onBackspace(),
      onReturn: () => props.onReturn(),
      onEmoji: () => props.onEmoji?.(),
      onMicToggle: () => props.onMicToggle?.(),
      onPaste: () => props.onPaste?.(),
      micActive: props.micActive,
      className: props.class,
    });
    kb.setOpen(props.open);
    kb.setMicActive(Boolean(props.micActive));
    el.appendChild(kb.root);
  };

  onCleanup(() => {
    kb?.destroy();
    kb = undefined;
  });

  createEffect(() => {
    // Track props every update; no-op until attach() has created kb.
    const open = props.open;
    const mic = Boolean(props.micActive);
    // Re-bind handlers so closures always see latest App callbacks.
    props.onInsert;
    props.onBackspace;
    props.onReturn;
    props.onEmoji;
    props.onMicToggle;
    props.onPaste;
    if (!kb) return;
    kb.setHandlers({
      onInsert: (t) => props.onInsert(t),
      onBackspace: () => props.onBackspace(),
      onReturn: () => props.onReturn(),
      onEmoji: () => props.onEmoji?.(),
      onMicToggle: () => props.onMicToggle?.(),
      onPaste: () => props.onPaste?.(),
    });
    kb.setOpen(open);
    kb.setMicActive(mic);
  });

  return <div class="sk-host" ref={attach} style={{ display: "contents" }} />;
}
