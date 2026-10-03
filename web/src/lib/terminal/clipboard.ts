/** Try native Paste synchronously while the tap still has user activation. */
export async function pasteClipboardText(
  send: (text: string) => void,
  requestNativePaste: () => boolean,
  unavailable: () => void,
): Promise<void> {
  if (requestNativePaste()) return;
  if (!navigator.clipboard?.readText) {
    unavailable();
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text) send(text);
    else unavailable();
  } catch {
    unavailable();
  }
}

/**
 * Safari's legacy paste command can show its own confirmation, including on
 * some HTTP origins. Keep an editable, in-viewport target alive while that
 * native prompt is pending. No modal or text-entry UI of our own.
 */
export function createNativePaste(host: HTMLElement) {
  let disposePending: (() => void) | undefined;
  return {
    request(send: (text: string) => void): boolean {
      disposePending?.();
      const previous = document.activeElement as HTMLElement | null;
      const target = document.createElement("textarea");
      target.setAttribute("aria-label", "Native clipboard paste target");
      target.inputMode = "none"; // Don't replace the simulated keyboard with IME.
      target.setAttribute("autocomplete", "off");
      target.setAttribute("autocapitalize", "none");
      target.spellcheck = false;
      target.style.cssText = "position:absolute;left:12px;bottom:56px;width:16px;height:16px;opacity:0.01;font-size:16px;pointer-events:none;";
      let completed = false;
      let timer: number | undefined;
      const dispose = () => {
        if (timer !== undefined) window.clearTimeout(timer);
        const restore = document.activeElement === target;
        target.remove();
        if (disposePending === dispose) disposePending = undefined;
        if (restore && previous?.isConnected) previous.focus({ preventScroll: true });
      };
      const deliver = (text: string) => {
        if (completed) return;
        completed = true;
        dispose();
        if (text) send(text);
      };
      target.addEventListener("paste", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        deliver(event.clipboardData?.getData("text/plain") ?? "");
      });
      target.addEventListener("input", (event) => {
        if ((event as InputEvent).inputType === "insertFromPaste") deliver(target.value);
      });
      host.append(target);
      disposePending = dispose;
      target.focus({ preventScroll: true });
      let accepted = false;
      try {
        accepted = Boolean(document.execCommand?.("paste"));
      } catch {
        // Unsupported / blocked native paste; the caller can try Clipboard API.
      }
      if (completed) return true; // Synchronous paste may return false afterward.
      if (!accepted) {
        dispose();
        return false;
      }
      target.addEventListener("blur", () => { queueMicrotask(dispose); }, { once: true });
      timer = window.setTimeout(dispose, 30000); // User can cancel the OS prompt.
      return true;
    },
    dispose() { disposePending?.(); },
  };
}
