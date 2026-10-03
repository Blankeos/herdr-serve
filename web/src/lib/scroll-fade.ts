import { createEffect, onCleanup, type Accessor } from "solid-js";

export type ScrollFadeAxis = "vertical" | "horizontal";

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      scrollFade: ScrollFadeAxis;
    }
  }
}

const FADE = "var(--scroll-fade-size, 24px)";
const FLAT = "0px";

/**
 * Reusable scroll fade directive. Tints `--scroll-fade-start` / `--scroll-fade-end`
 * to `0px` at a reachable edge and to the fade size where overflow hides content.
 * Measures only the element itself (never the document) and coalesces all
 * triggers through one animation frame to avoid resize loops.
 */
export function scrollFade(element: HTMLElement, axis: Accessor<ScrollFadeAxis>): void {
  element.classList.add("scroll-fade");
  element.dataset.scrollAxis = axis();

  let frame: number | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let mutationObserver: MutationObserver | undefined;
  let disposed = false;

  const measure = () => {
    frame = undefined;
    const horizontal = axis() === "horizontal";
    element.dataset.scrollAxis = horizontal ? "horizontal" : "vertical";

    let startHidden = false;
    let endHidden = false;
    if (horizontal) {
      const max = element.scrollWidth - element.clientWidth;
      if (max > 0) {
        startHidden = element.scrollLeft > 1;
        endHidden = element.scrollLeft < max - 1;
      }
    } else {
      const max = element.scrollHeight - element.clientHeight;
      if (max > 0) {
        startHidden = element.scrollTop > 1;
        endHidden = element.scrollTop < max - 1;
      }
    }

    element.style.setProperty("--scroll-fade-start", startHidden ? FADE : FLAT);
    element.style.setProperty("--scroll-fade-end", endHidden ? FADE : FLAT);
  };

  const schedule = () => {
    if (disposed || frame !== undefined) return;
    if (typeof window.requestAnimationFrame === "function") {
      frame = window.requestAnimationFrame(measure);
    } else {
      frame = window.setTimeout(measure, 0) as unknown as number;
    }
  };

  const onScroll = () => schedule();
  element.addEventListener("scroll", onScroll, { passive: true });

  const observeViewportAndChildren = () => {
    if (!resizeObserver) return;
    resizeObserver.disconnect();
    resizeObserver.observe(element);
    for (const child of Array.from(element.children)) {
      resizeObserver.observe(child as Element);
    }
  };

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(schedule);
    observeViewportAndChildren();
  }

  if (typeof MutationObserver !== "undefined") {
    mutationObserver = new MutationObserver(() => {
      // Dynamic list changes: watch new rows and re-measure once.
      observeViewportAndChildren();
      schedule();
    });
    mutationObserver.observe(element, { childList: true, subtree: true });
  }

  // Keep data-scroll-axis and fades in sync if the axis signal changes.
  createEffect(() => {
    const next = axis();
    if (element.dataset.scrollAxis !== next) {
      element.dataset.scrollAxis = next;
      schedule();
    }
  });

  schedule();

  onCleanup(() => {
    disposed = true;
    element.removeEventListener("scroll", onScroll);
    if (frame !== undefined) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
      } else {
        window.clearTimeout(frame);
      }
      frame = undefined;
    }
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    mutationObserver?.disconnect();
    mutationObserver = undefined;
    element.classList.remove("scroll-fade");
    element.removeAttribute("data-scroll-axis");
    element.style.removeProperty("--scroll-fade-start");
    element.style.removeProperty("--scroll-fade-end");
  });
}
