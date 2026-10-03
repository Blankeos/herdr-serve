import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStatusRefresh, STATUS_REFRESH_INTERVAL_MS } from "./status-refresh";

let stop: (() => void) | undefined;
let visibility: DocumentVisibilityState;
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
};
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("status refresh", () => {
  it("keeps refreshing without terminal events or browser reloads", async () => {
    let serverStatus = "working";
    let displayedStatus = "";
    const refresh = vi.fn(async () => { displayedStatus = serverStatus; });
    stop = startStatusRefresh(refresh);
    await flush();
    expect(displayedStatus).toBe("working");
    serverStatus = "blocked";
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_INTERVAL_MS);
    expect(displayedStatus).toBe("blocked");
    serverStatus = "done";
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_INTERVAL_MS);
    expect(displayedStatus).toBe("done");
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("does not schedule another poll if the page hides during a request", async () => {
    let resolve!: () => void;
    const refresh = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    stop = startStatusRefresh(refresh);
    setVisibility("hidden");
    resolve();
    await vi.advanceTimersByTimeAsync(60000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden and immediately catches up when visible", async () => {
    const refresh = vi.fn(async () => {});
    stop = startStatusRefresh(refresh);
    await flush();
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60000);
    expect(refresh).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("does not fetch when started in a hidden page", async () => {
    visibility = "hidden";
    const refresh = vi.fn(async () => {});
    stop = startStatusRefresh(refresh);
    await vi.advanceTimersByTimeAsync(60000);
    expect(refresh).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("never overlaps slow requests, including resume events", async () => {
    let resolve!: () => void;
    const refresh = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    stop = startStatusRefresh(refresh);
    await vi.advanceTimersByTimeAsync(10000);
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("pageshow"));
    setVisibility("hidden");
    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
    resolve();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("retries after rejected refreshes", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    stop = startStatusRefresh(refresh);
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("refreshes immediately after network or bfcache recovery", async () => {
    const refresh = vi.fn(async () => {});
    stop = startStatusRefresh(refresh);
    await flush();
    window.dispatchEvent(new Event("online"));
    expect(refresh).toHaveBeenCalledTimes(2);
    await flush();
    window.dispatchEvent(new Event("pageshow"));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("cleans up timers and listeners", async () => {
    const refresh = vi.fn(async () => {});
    stop = startStatusRefresh(refresh);
    await flush();
    stop();
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("pageshow"));
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(60000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not restart after disposal during a request", async () => {
    let resolve!: () => void;
    const refresh = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    stop = startStatusRefresh(refresh);
    stop();
    resolve();
    await vi.advanceTimersByTimeAsync(60000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
