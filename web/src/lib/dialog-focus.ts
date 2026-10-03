/** Contain keyboard focus while a modal is open and restore its trigger on close. */
export function manageDialogFocus(
  panel: HTMLElement,
  dismiss: () => void,
  options: { focusInput?: boolean } = {},
): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
  ));
  // Focus the panel on mobile: focusing an input summons the native keyboard.
  // preventScroll alone does not suppress it, and focus events aren't cancelable.
  const initial = options.focusInput === false
    ? panel
    : panel.querySelector<HTMLElement>("input:not(:disabled)") ?? panel;
  initial.focus({ preventScroll: true });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
    } else if (event.key === "Tab") {
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
      } else if (event.shiftKey && (document.activeElement === panel || document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener("keydown", onKey);
  return () => {
    document.removeEventListener("keydown", onKey);
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
}
