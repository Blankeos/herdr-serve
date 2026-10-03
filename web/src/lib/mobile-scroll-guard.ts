type TouchPosition = { id: number; x: number; y: number; target: Element };

/**
 * Safari can pan the outer page with IME open even with overflow:hidden. Cancel
 * only gestures that cannot be consumed inside the fixed mobile shell. Do not
 * stop propagation: terminal scrolling and page/dock gestures still need them.
 */
export function guardMobilePageScroll(enabled: () => boolean): () => void {
  let previous: TouchPosition | undefined;

  const start = (event: TouchEvent) => {
    previous = undefined;
    if (!enabled() || event.touches.length !== 1 || !(event.target instanceof Element)) return;
    const touch = event.touches[0];
    previous = { id: touch.identifier, x: touch.clientX, y: touch.clientY, target: event.target };
  };
  const reset = () => { previous = undefined; };
  const move = (event: TouchEvent) => {
    if (!enabled() || event.touches.length !== 1) {
      reset();
      return;
    }
    const touch = event.touches[0];
    const last = previous;
    if (!last || last.id !== touch.identifier) return;
    const dx = last.x - touch.clientX;
    const dy = last.y - touch.clientY;
    previous = { ...last, x: touch.clientX, y: touch.clientY };
    if (event.defaultPrevented || !event.cancelable || (!dx && !dy)) return;

    // xterm's viewport looks like a scrollport, but the app owns its gestures
    // (PTY wheel reports / host scrollback / momentum), not the browser.
    const terminalGesture = Boolean(last.target.closest(".term"));
    if (!terminalGesture) {
      const vertical = Math.abs(dy) >= Math.abs(dx);
      const delta = vertical ? dy : dx;
      for (let element: Element | null = last.target;
        element && element !== document.body && element !== document.documentElement;
        element = element.parentElement) {
        const style = getComputedStyle(element);
        const overflow = vertical ? style.overflowY : style.overflowX;
        if (!/^(auto|scroll|overlay)$/.test(overflow)) continue;
        const max = vertical
          ? element.scrollHeight - element.clientHeight
          : element.scrollWidth - element.clientWidth;
        if (max <= 0) continue;
        const position = vertical ? element.scrollTop : element.scrollLeft;
        const next = position + delta;
        if (next >= 0 && next <= max) return; // Native inner scrolling.

        // Consume the last few pixels without chaining/bouncing at the edge.
        event.preventDefault();
        if (vertical) element.scrollTop = Math.max(0, Math.min(max, next));
        else element.scrollLeft = Math.max(0, Math.min(max, next));
        return;
      }
    }
    event.preventDefault(); // Chrome, terminal, or a non-scrollable area.
  };

  document.addEventListener("touchstart", start, { capture: true, passive: true });
  document.addEventListener("touchmove", move, { capture: true, passive: false });
  document.addEventListener("touchend", reset, true);
  document.addEventListener("touchcancel", reset, true);
  return () => {
    reset();
    document.removeEventListener("touchstart", start, true);
    document.removeEventListener("touchmove", move, true);
    document.removeEventListener("touchend", reset, true);
    document.removeEventListener("touchcancel", reset, true);
  };
}
