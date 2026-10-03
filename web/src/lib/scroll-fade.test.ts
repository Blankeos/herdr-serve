// @vitest-environment jsdom
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollFade } from "./scroll-fade";

const FADE = "var(--scroll-fade-size, 24px)";
const FLAT = "0px";

let disposeRoot: (() => void) | undefined;

afterEach(() => {
  disposeRoot?.();
  disposeRoot = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function mockVertical(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop = 0) {
  Object.defineProperties(el, {
    scrollHeight: { value: scrollHeight, configurable: true },
    clientHeight: { value: clientHeight, configurable: true },
  });
  el.scrollTop = scrollTop;
}

function mockHorizontal(el: HTMLElement, scrollWidth: number, clientWidth: number, scrollLeft = 0) {
  Object.defineProperties(el, {
    scrollWidth: { value: scrollWidth, configurable: true },
    clientWidth: { value: clientWidth, configurable: true },
  });
  el.scrollLeft = scrollLeft;
}

function mount(axis: "vertical" | "horizontal", setup?: (el: HTMLElement) => void) {
  const el = document.createElement("div");
  el.append(document.createElement("span"), document.createElement("span"));
  setup?.(el);
  document.body.append(el);
  createRoot((dispose) => {
    disposeRoot = dispose;
    scrollFade(el, () => axis);
  });
  return el;
}

const startOf = (el: HTMLElement) => el.style.getPropertyValue("--scroll-fade-start");
const endOf = (el: HTMLElement) => el.style.getPropertyValue("--scroll-fade-end");

// Double rAF: the directive schedules one frame; MutationObserver and Solid
// effects settle in microtasks first, so two frames guarantee the measure ran.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  await Promise.resolve();
}

function installFakeRO() {
  const triggers: (() => void)[] = [];
  const instances: {
    callback: ResizeObserverCallback;
    observe: ReturnType<typeof vi.fn>;
    unobserve: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  class FakeRO {
    callback: ResizeObserverCallback;
    observe = vi.fn((_target: Element) => {});
    unobserve = vi.fn((_target: Element) => {});
    disconnect = vi.fn(() => {});
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      instances.push(this as unknown as (typeof instances)[number]);
      triggers.push(() => callback([], this as unknown as ResizeObserver));
    }
  }
  vi.stubGlobal("ResizeObserver", FakeRO);
  return {
    instances,
    trigger: () => triggers.forEach((run) => run()),
  };
}

describe("scroll fade directive", () => {
  it("marks vertical overflow with start flat and end faded at the top", async () => {
    const el = mount("vertical", (target) => mockVertical(target, 300, 100, 0));
    await flush();
    expect(el.classList.contains("scroll-fade")).toBe(true);
    expect(el.getAttribute("data-scroll-axis")).toBe("vertical");
    expect(startOf(el)).toBe(FLAT);
    expect(endOf(el)).toBe(FADE);
  });

  it("fades both vertical ends in the middle and only the start at the bottom", async () => {
    const el = mount("vertical", (target) => mockVertical(target, 300, 100, 0));
    await flush();

    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
    await flush();
    expect(startOf(el)).toBe(FADE);
    expect(endOf(el)).toBe(FADE);

    el.scrollTop = 200;
    el.dispatchEvent(new Event("scroll"));
    await flush();
    expect(startOf(el)).toBe(FADE);
    expect(endOf(el)).toBe(FLAT);
  });

  it("tracks horizontal scroll from left through middle to right", async () => {
    const el = mount("horizontal", (target) => mockHorizontal(target, 300, 100, 0));
    await flush();
    expect(el.getAttribute("data-scroll-axis")).toBe("horizontal");
    expect(startOf(el)).toBe(FLAT);
    expect(endOf(el)).toBe(FADE);

    el.scrollLeft = 100;
    el.dispatchEvent(new Event("scroll"));
    await flush();
    expect(startOf(el)).toBe(FADE);
    expect(endOf(el)).toBe(FADE);

    el.scrollLeft = 200;
    el.dispatchEvent(new Event("scroll"));
    await flush();
    expect(startOf(el)).toBe(FADE);
    expect(endOf(el)).toBe(FLAT);
  });

  it("shows no fade when nothing overflows, vertical and horizontal", async () => {
    const vertical = mount("vertical", (target) => mockVertical(target, 100, 100, 0));
    await flush();
    expect(startOf(vertical)).toBe(FLAT);
    expect(endOf(vertical)).toBe(FLAT);
    disposeRoot?.();
    disposeRoot = undefined;
    document.body.innerHTML = "";

    const horizontal = mount("horizontal", (target) => mockHorizontal(target, 100, 100, 0));
    await flush();
    expect(startOf(horizontal)).toBe(FLAT);
    expect(endOf(horizontal)).toBe(FLAT);
  });

  it("coalesces rapid scroll events into one frame", async () => {
    const el = mount("vertical", (target) => mockVertical(target, 300, 100, 0));
    await flush();
    expect(endOf(el)).toBe(FADE);

    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
    el.scrollTop = 200;
    el.dispatchEvent(new Event("scroll"));
    await flush();
    expect(startOf(el)).toBe(FADE);
    expect(endOf(el)).toBe(FLAT);
  });

  it("updates on ResizeObserver viewport and child size changes", async () => {
    const { instances, trigger } = installFakeRO();
    const el = mount("vertical", (target) => mockVertical(target, 100, 100, 0));
    await flush();
    expect(startOf(el)).toBe(FLAT);
    expect(endOf(el)).toBe(FLAT);

    // Viewport observes itself plus direct content children.
    expect(instances).toHaveLength(1);
    expect(instances[0].observe).toHaveBeenCalledWith(el);
    expect(instances[0].observe.mock.calls.length).toBeGreaterThanOrEqual(3);

    mockVertical(el, 300, 100, 0);
    trigger();
    await flush();
    expect(startOf(el)).toBe(FLAT);
    expect(endOf(el)).toBe(FADE);
  });

  it("updates on dynamic list changes observed by MutationObserver", async () => {
    installFakeRO();
    const el = mount("vertical", (target) => mockVertical(target, 100, 100, 0));
    await flush();
    expect(endOf(el)).toBe(FLAT);

    // Simulate a list growing: new row plus taller scroll height.
    el.append(document.createElement("span"));
    mockVertical(el, 300, 100, 0);
    await flush();
    expect(startOf(el)).toBe(FLAT);
    expect(endOf(el)).toBe(FADE);
  });

  it("cleans up listeners, observers, frame, class and CSS vars", async () => {
    const { instances, trigger } = installFakeRO();
    const el = mount("vertical", (target) => mockVertical(target, 300, 100, 0));
    await flush();
    expect(endOf(el)).toBe(FADE);

    disposeRoot?.();
    disposeRoot = undefined;

    expect(el.classList.contains("scroll-fade")).toBe(false);
    expect(el.getAttribute("data-scroll-axis")).toBeNull();
    expect(startOf(el)).toBe("");
    expect(endOf(el)).toBe("");
    expect(instances[0].disconnect).toHaveBeenCalled();

    // Post-cleanup activity must not restore fades.
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
    trigger();
    el.append(document.createElement("span"));
    await flush();
    expect(el.classList.contains("scroll-fade")).toBe(false);
    expect(startOf(el)).toBe("");
    expect(endOf(el)).toBe("");
  });

  it("cancels a pending frame on immediate dispose", async () => {
    installFakeRO();
    const el = document.createElement("div");
    el.append(document.createElement("span"));
    mockVertical(el, 300, 100, 0);
    document.body.append(el);
    createRoot((dispose) => {
      disposeRoot = dispose;
      scrollFade(el, () => "vertical");
      // Dispose before the initial animation frame runs.
      dispose();
    });
    disposeRoot = undefined;
    await flush();
    expect(el.classList.contains("scroll-fade")).toBe(false);
    expect(startOf(el)).toBe("");
    expect(endOf(el)).toBe("");
  });

  it("works without ResizeObserver in the test environment", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const el = mount("vertical", (target) => mockVertical(target, 300, 100, 0));
    await flush();
    expect(startOf(el)).toBe(FLAT);
    expect(endOf(el)).toBe(FADE);

    el.scrollTop = 200;
    el.dispatchEvent(new Event("scroll"));
    await flush();
    expect(startOf(el)).toBe(FADE);
    expect(endOf(el)).toBe(FLAT);
  });
});
