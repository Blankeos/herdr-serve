import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalFitter, observeTerminalFit } from "./fit";

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("terminal fitting", () => {
  it("refits after cell metrics change even when host dimensions stay the same", () => {
    const term = { cols: 80, rows: 24 };
    const fit = { fit: vi.fn() };
    const sendResize = vi.fn();
    const refit = createTerminalFitter(term, fit, sendResize);
    refit();
    fit.fit.mockImplementationOnce(() => { term.rows = 21; });
    refit();
    expect(fit.fit).toHaveBeenCalledTimes(2);
    expect(sendResize.mock.calls).toEqual([[80, 24], [80, 21]]);
  });

  it("does not send redundant PTY resizes on viewport/renderer events", () => {
    const term = { cols: 80, rows: 24 };
    const fit = { fit: vi.fn() };
    const sendResize = vi.fn();
    const refit = createTerminalFitter(term, fit, sendResize);
    refit(); refit(); refit();
    expect(sendResize).toHaveBeenCalledTimes(1);
    term.cols = 120;
    refit();
    term.cols = 80;
    refit();
    expect(sendResize.mock.calls).toEqual([[80, 24], [120, 24], [80, 24]]);
  });

  it("observes rendered screen changes as well as host changes and cleans up", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    let notify: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { notify = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const host = document.createElement("div");
    host.innerHTML = '<div class="xterm-screen"></div>';
    const refit = vi.fn();
    const stop = observeTerminalFit(host, refit);
    expect(observe.mock.calls).toEqual([[host], [host.firstElementChild]]);
    notify?.();
    expect(refit).toHaveBeenCalledTimes(1);
    stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
