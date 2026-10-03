import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgents, listPanes, listWorkspaces } from "./api";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("status requests", () => {
  it.each([
    ["/api/agents", listAgents, { agents: [{ agent_status: "blocked" }] }],
    ["/api/workspaces", listWorkspaces, { workspaces: [{ label: "project" }] }],
    ["/api/panes", listPanes, { panes: [{ pane_id: "p1" }] }],
  ] as const)("reads fresh metadata from %s", async (path, load, body) => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetch);
    const result = await load();
    expect(result).toEqual(Object.values(body)[0]);
    expect(fetch).toHaveBeenCalledWith(path, expect.objectContaining({
      cache: "no-store", signal: expect.any(AbortSignal),
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts stalled reads and allows the next refresh to recover", async () => {
    const fetch = vi.fn().mockImplementationOnce((_path, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    ).mockResolvedValue({ ok: true, json: async () => ({ agents: [{ agent_status: "done" }] }) });
    vi.stubGlobal("fetch", fetch);
    const request = listAgents();
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10000);
    await rejection;
    expect(await listAgents()).toEqual([{ agent_status: "done" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replace last-good data with an empty list when the body stalls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_path, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    })));
    const rejection = expect(listAgents()).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the deadline on API errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, json: async () => ({ error: "snapshot failed" }),
    }));
    await expect(listAgents()).rejects.toThrow("snapshot failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
