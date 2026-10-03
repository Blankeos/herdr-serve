import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "./api";
import {
  loadSelectedTerminal,
  resolveInitialTerminal,
  saveSelectedTerminal,
} from "./terminalSelection";

function agent(id: string, focused = false, kind = "codex"): Agent {
  return {
    terminal_id: id,
    pane_id: `pane-${id}`,
    focused,
    agent: kind,
  } as Agent;
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("terminal selection persistence", () => {
  it("starts without a remembered terminal", () => {
    expect(loadSelectedTerminal()).toBe("");
  });

  it("restores the last selection after refresh instead of the first or focused agent", () => {
    const first = agent("first", true);
    const last = agent("last");
    saveSelectedTerminal("first");
    saveSelectedTerminal("last");
    expect(resolveInitialTerminal([first, last], null, loadSelectedTerminal())).toBe(last);
  });

  it("clears memory when the selected terminal is explicitly closed", () => {
    saveSelectedTerminal("closed");
    saveSelectedTerminal("");
    expect(loadSelectedTerminal()).toBe("");
  });

  it("tolerates disabled storage when reading", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    expect(loadSelectedTerminal()).toBe("");
  });

  it("tolerates quota errors when saving", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    expect(() => saveSelectedTerminal("last")).not.toThrow();
  });

  it("tolerates disabled storage when clearing", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    expect(() => saveSelectedTerminal("")).not.toThrow();
  });
});

describe("initial terminal resolution", () => {
  it("waits for the agent list on a first visit", () => {
    expect(resolveInitialTerminal(null, [], "")).toBeUndefined();
  });

  it("uses the focused agent on a first visit without waiting for panes", () => {
    const focused = agent("focused", true);
    expect(resolveInitialTerminal([agent("first"), focused], null, "")).toBe(focused);
  });

  it("uses the first agent when none is focused", () => {
    const first = agent("first");
    expect(resolveInitialTerminal([first, agent("second")], null, "")).toBe(first);
  });

  it("recognizes a remembered pane ID and returns its current terminal", () => {
    const last = agent("last");
    expect(resolveInitialTerminal([last], [], "pane-last")).toBe(last);
  });

  it("supports agents that only have a pane ID", () => {
    const pane = { ...agent("last"), terminal_id: "" };
    expect(resolveInitialTerminal([pane], [], "pane-last")).toBe(pane);
  });

  it("waits for panes rather than replacing a remembered shell with an agent", () => {
    const agents = [agent("first", true)];
    const shell = agent("shell", false, "");
    expect(resolveInitialTerminal(agents, null, "shell")).toBeUndefined();
    expect(resolveInitialTerminal(agents, [shell], "shell")).toBe(shell);
  });

  it("waits for agents when panes arrive first", () => {
    const last = agent("last");
    expect(resolveInitialTerminal(null, [], "last")).toBeUndefined();
    expect(resolveInitialTerminal([agent("first"), last], [], "last")).toBe(last);
  });

  it("can restore a shell when panes arrive first", () => {
    const shell = agent("shell", false, "");
    expect(resolveInitialTerminal(null, [shell], "shell")).toBe(shell);
  });

  it("falls back to the focused agent if the saved terminal no longer exists", () => {
    const focused = agent("focused", true);
    expect(resolveInitialTerminal([agent("first"), focused], [], "deleted")).toBe(focused);
  });

  it("falls back to the first agent if the saved terminal is gone and none is focused", () => {
    const first = agent("first");
    expect(resolveInitialTerminal([first], [], "deleted")).toBe(first);
  });

  it("returns no selection when the saved terminal is gone and there are no agents", () => {
    expect(resolveInitialTerminal([], [], "deleted")).toBeNull();
  });
});
