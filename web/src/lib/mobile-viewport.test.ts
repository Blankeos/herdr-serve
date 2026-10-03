import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackMobileViewport } from "./mobile-viewport";

let cleanup: (() => void) | undefined;
let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
let media: EventTarget & { matches: boolean };
const root = document.documentElement;
const flush = () => vi.advanceTimersByTime(20);
const resize = (height: number, offsetTop = 0) => {
  viewport.height = height;
  viewport.offsetTop = offsetTop;
  viewport.dispatchEvent(new Event("resize"));
  flush();
};
const focusInput = () => {
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  return input;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("innerWidth", 390);
  viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("matchMedia", () => media);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mobile viewport", () => {
  it("follows visible height and Safari pan while native input is focused", () => {
    const changed = vi.fn();
    cleanup = trackMobileViewport(changed);
    focusInput();
    resize(480, 70);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("480px");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("70px");
    expect(changed).toHaveBeenLastCalledWith(true);
    expect(root.classList.contains("native-keyboard-open")).toBe(true);
    resize(800);
    expect(changed).toHaveBeenLastCalledWith(false);
  });
  it("sizes to small browser chrome changes without calling them a keyboard", () => {
    const changed = vi.fn();
    cleanup = trackMobileViewport(changed);
    focusInput();
    resize(730);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("730px");
    expect(changed).toHaveBeenLastCalledWith(false);
  });
  it("catches delayed iOS geometry even when no resize event is delivered", () => {
    cleanup = trackMobileViewport(vi.fn());
    focusInput();
    flush();
    viewport.height = 470;
    vi.advanceTimersByTime(650);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("470px");
    expect(root.classList.contains("native-keyboard-open")).toBe(true);
  });
  it("resets the baseline on rotation and ignores pinch zoom", () => {
    const changed = vi.fn();
    cleanup = trackMobileViewport(changed);
    focusInput();
    resize(480);
    vi.stubGlobal("innerWidth", 844);
    vi.stubGlobal("innerHeight", 390);
    resize(390);
    expect(changed).toHaveBeenLastCalledWith(false);
    viewport.scale = 2;
    resize(195);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("390px");
  });
  it("handles layout-resizing browsers and restores height after blur", () => {
    cleanup = trackMobileViewport(vi.fn());
    const input = focusInput();
    vi.stubGlobal("innerHeight", 480);
    resize(480);
    expect(root.classList.contains("native-keyboard-open")).toBe(true);
    input.blur();
    vi.stubGlobal("innerHeight", 800);
    resize(800);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("800px");
    expect(root.classList.contains("native-keyboard-open")).toBe(false);
  });
  it("falls back to innerHeight and cleans up events, frames and timers", () => {
    vi.stubGlobal("visualViewport", undefined);
    const changed = vi.fn();
    cleanup = trackMobileViewport(changed);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("800px");
    focusInput();
    cleanup();
    cleanup = undefined;
    changed.mockClear();
    vi.advanceTimersByTime(1200);
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(changed).not.toHaveBeenCalled();
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("");
    expect(root.classList.contains("mobile-viewport")).toBe(false);
  });
  it("clears mobile layout when switching to desktop", () => {
    cleanup = trackMobileViewport(vi.fn());
    media.matches = false;
    media.dispatchEvent(new Event("change"));
    flush();
    expect(root.classList.contains("mobile-viewport")).toBe(false);
  });
});
