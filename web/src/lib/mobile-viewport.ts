import { guardMobilePageScroll } from "./mobile-scroll-guard";

const MOBILE_MQ = "(max-width: 767.98px)";
const KEYBOARD_THRESHOLD = 120;

/**
 * Size the mobile shell to the *visible* viewport, not 100dvh or an estimated
 * keyboard height. Safari reports keyboard geometry late and may pan the
 * visual viewport. Follow both values; the dock stays in the shell's flex flow.
 */
export function trackMobileViewport(onChange: (keyboardOpen: boolean) => void): () => void {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const media = window.matchMedia(MOBILE_MQ);
  let baselineWidth = window.innerWidth;
  let baselineHeight = window.innerHeight;
  let frame: number | undefined;
  const timers = new Set<number>();
  const stopScrollGuard = guardMobilePageScroll(() => media.matches);

  const textInputFocused = () => {
    const active = document.activeElement;
    return (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
      && !active.readOnly && !active.disabled && active.inputMode !== "none";
  };

  const clearStyles = () => {
    root.classList.remove("mobile-viewport", "native-keyboard-open");
    root.style.removeProperty("--app-viewport-height");
    root.style.removeProperty("--app-viewport-top");
  };

  const update = () => {
    frame = undefined;
    if (!media.matches) {
      clearStyles();
      baselineWidth = window.innerWidth;
      baselineHeight = window.innerHeight;
      onChange(false);
      return;
    }
    // Ignore pinch zoom rather than mistaking it for an on-screen keyboard.
    if (viewport && Math.abs(viewport.scale - 1) > 0.05) return;
    const height = viewport?.height ?? window.innerHeight;
    if (height <= 0) return;
    if (baselineWidth !== window.innerWidth) {
      baselineWidth = window.innerWidth;
      baselineHeight = window.innerHeight;
    } else if (!textInputFocused()) {
      baselineHeight = Math.max(window.innerHeight, height);
    } else {
      baselineHeight = Math.max(baselineHeight, window.innerHeight, height);
    }
    const keyboardOpen = textInputFocused() && baselineHeight - height > KEYBOARD_THRESHOLD;
    root.classList.add("mobile-viewport");
    root.classList.toggle("native-keyboard-open", keyboardOpen);
    root.style.setProperty("--app-viewport-height", `${Math.floor(height)}px`);
    root.style.setProperty("--app-viewport-top", `${Math.max(0, viewport?.offsetTop ?? 0)}px`);
    onChange(keyboardOpen);
  };

  const schedule = () => {
    if (frame === undefined) frame = window.requestAnimationFrame(update);
  };
  const settle = () => {
    schedule();
    // Bounded rechecks catch iOS's delayed animation/accessory-bar updates.
    // Never guess a keyboard size or continuously poll.
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
    for (const delay of [50, 150, 300, 600, 1000]) {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        schedule();
      }, delay);
      timers.add(timer);
    }
  };
  update();
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  window.addEventListener("resize", settle);
  window.addEventListener("orientationchange", settle);
  document.addEventListener("focusin", settle);
  document.addEventListener("focusout", settle);
  document.addEventListener("visibilitychange", settle);
  media.addEventListener("change", settle);

  return () => {
    stopScrollGuard();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    for (const timer of timers) window.clearTimeout(timer);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", settle);
    window.removeEventListener("orientationchange", settle);
    document.removeEventListener("focusin", settle);
    document.removeEventListener("focusout", settle);
    document.removeEventListener("visibilitychange", settle);
    media.removeEventListener("change", settle);
    clearStyles();
  };
}
