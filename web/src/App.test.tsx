import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";
import type { Agent, Workspace } from "./api";

vi.mock("./api", async (original) => ({
  ...await original<typeof import("./api")>(),
  authStatus: vi.fn(async () => ({ required: false })),
  listAgents: vi.fn(),
  listPanes: vi.fn(),
  listWorkspaces: vi.fn(),
  focusTab: vi.fn(async () => ({})),
  createTab: vi.fn(),
}));
let refreshStatus: (() => Promise<unknown>) | undefined;
vi.mock("./lib/status-refresh", () => ({
  startStatusRefresh: (refresh: () => Promise<unknown>) => {
    refreshStatus = refresh;
    return () => {};
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    textarea = document.createElement("textarea");
    open(host: HTMLElement) { host.append(this.textarea); }
    loadAddon() {}
    write() {}
    onData() {}
    attachCustomWheelEventHandler() {}
    focus() {}
    blur() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

class TestSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: TestSocket[] = [];
  readyState = 0;
  close = vi.fn(() => { this.readyState = 3; });
  send = vi.fn();
  constructor(public url: string) { TestSocket.instances.push(this); }
}

function pane(id: string, workspace: string, kind = "codex"): Agent {
  return {
    terminal_id: id, pane_id: `pane-${id}`, workspace_id: workspace,
    tab_id: `tab-${id}`, agent: kind, agent_status: kind ? "working" : "unknown",
    focused: false, cwd: `/projects/${workspace}`, terminal_title_stripped: id,
  };
}
const agentA = pane("agent-a", "a");
const agentB = pane("agent-b", "b");
const shellA = pane("shell-a", "a", "");
const spaces = [
  { workspace_id: "a", label: "Space A", focused: true },
  { workspace_id: "b", label: "Space B", focused: false },
] as Workspace[];
let dispose: (() => void) | undefined;
let mobile = false;
let mediaChanged: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mobile = false;
  TestSocket.instances = [];
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return mobile; },
    addEventListener(_type: string, listener: () => void) { mediaChanged = listener; },
    removeEventListener() {},
  }));
  vi.mocked(api.listAgents).mockResolvedValue([agentA, agentB]);
  vi.mocked(api.listPanes).mockResolvedValue([agentA, agentB, shellA]);
  vi.mocked(api.listWorkspaces).mockResolvedValue(spaces);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function mount() {
  dispose = render(() => <App />, document.body);
  await vi.waitFor(() => expect(document.querySelector(".topbar-context")?.textContent).toContain("agent-a"));
}
function button(label: string) {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
function selectAgentB() {
  const row = Array.from(document.querySelectorAll<HTMLButtonElement>(".agent-row"))
    .find((element) => element.textContent?.includes("agent-b"))!;
  row.click();
}
function currentSocket() { return TestSocket.instances.at(-1)!; }
function currentId() { return new URL(currentSocket().url).searchParams.get("id"); }
const title = () => document.querySelector(".main .topbar-title")?.textContent;

for (const layout of ["desktop", "mobile"] as const) {
  describe(`${layout} Agents / Terminals`, () => {
    beforeEach(() => { mobile = layout === "mobile"; });

    it("keeps an empty space empty rather than displaying another space's terminal", async () => {
      await mount();
      button("Show terminals").click();
      await vi.waitFor(() => expect(currentId()).toBe("shell-a"));
      const shellSocket = currentSocket();
      if (layout === "desktop") {
        expect(title()).toBe("Terminals");
        expect(document.querySelector(".main .topbar-add")?.getAttribute("aria-label")).toBe("New shell");
        expect(document.querySelector(".main .status")).toBeNull();
      } else {
        expect(title()).toBe("Agents");
        expect(document.querySelector(".right-topbar .topbar-title")?.textContent).toBe("Terminals");
      }

      selectAgentB();
      expect(title()).toBe("Agents");
      expect(button("Show terminals")).not.toBeNull();
      expect(currentId()).toBe("agent-b");
      const agentSocket = currentSocket();
      button("Show terminals").click();
      await vi.waitFor(() => expect(document.querySelector(".terminal-empty h1")?.textContent).toBe("No terminals yet"));
      expect(document.querySelectorAll(".term-chip:not(.term-chip-add)")).toHaveLength(0);
      expect(document.querySelector<HTMLElement>(".term")?.style.visibility).toBe("hidden");
      expect(agentSocket.close).toHaveBeenCalled();
      expect(shellSocket.close).toHaveBeenCalled();
      expect(localStorage.getItem("herdr_serve_selected_terminal")).toBeNull();

      // Polling must not restore a focused agent while the empty peer is open.
      await refreshStatus?.();
      expect(document.querySelector(".terminal-empty h1")?.textContent).toBe("No terminals yet");
      expect(localStorage.getItem("herdr_serve_selected_terminal")).toBeNull();
      button("Show agents").click();
      expect(currentId()).toBe("agent-b");
      expect(document.querySelector(".terminal-empty")).toBeNull();
    });

    it("creates the first shell in the empty space, not the backend-focused space", async () => {
      await mount();
      selectAgentB();
      button("Show terminals").click();
      const shellB = pane("shell-b", "b", "");
      vi.mocked(api.createTab).mockResolvedValue({ ok: true, workspace_id: "b", terminal_id: "shell-b", pane_id: "pane-shell-b", tab_id: "tab-shell-b" });
      vi.mocked(api.listPanes).mockResolvedValue([agentA, agentB, shellA, shellB]);
      document.querySelector<HTMLButtonElement>(".terminal-empty button")!.click();
      await vi.waitFor(() => expect(currentId()).toBe("shell-b"));
      expect(api.createTab).toHaveBeenCalledWith({ workspace_id: "b", focus: true });
      expect(document.querySelector(".shell")?.classList.contains("right-open")).toBe(true);
      expect(document.querySelector(".terminal-empty")).toBeNull();
      await vi.waitFor(() => expect(document.querySelector(".term-chip.active")?.textContent).toBe("shell-b"));
      button("Show agents").click();
      expect(currentId()).toBe("agent-b");
    });

    it("does not let a delayed pane refresh switch back to the old space", async () => {
      await mount();
      let resolvePanes!: (panes: Agent[]) => void;
      vi.mocked(api.listPanes).mockReturnValueOnce(new Promise((resolve) => { resolvePanes = resolve; }));
      button("Show terminals").click();
      selectAgentB();
      button("Show terminals").click();
      resolvePanes([agentA, agentB, shellA]);
      await vi.waitFor(() => expect(document.querySelector(".terminal-empty h1")?.textContent).toBe("No terminals yet"));
      expect(document.querySelectorAll(".term-chip:not(.term-chip-add)")).toHaveLength(0);
      expect(localStorage.getItem("herdr_serve_selected_terminal")).toBeNull();
    });

    it("does not steal focus when shell creation finishes after switching spaces", async () => {
      await mount();
      button("Show terminals").click();
      let resolveCreation!: (response: api.CreateTabResponse) => void;
      vi.mocked(api.createTab).mockReturnValueOnce(new Promise((resolve) => { resolveCreation = resolve; }));
      document.querySelector<HTMLButtonElement>(".term-chip-add")!.click();
      selectAgentB();
      resolveCreation({ ok: true, workspace_id: "a", terminal_id: "new-shell-a", pane_id: "new-pane-a", tab_id: "new-tab-a" });
      await vi.waitFor(() => expect(api.listPanes).toHaveBeenCalledTimes(3));
      expect(currentId()).toBe("agent-b");
      expect(title()).toBe("Agents");
      expect(localStorage.getItem("herdr_serve_selected_terminal")).toBe("agent-b");
    });
  });
}

it("restores a remembered shell with the desktop Terminals header", async () => {
  localStorage.setItem("herdr_serve_selected_terminal", "shell-a");
  dispose = render(() => <App />, document.body);
  await vi.waitFor(() => expect(title()).toBe("Terminals"));
  expect(currentId()).toBe("shell-a");
  expect(button("Show agents")).not.toBeNull();
});

it("returns to the agent when opening the mobile sidebar from Terminals", async () => {
  mobile = true;
  await mount();
  button("Show terminals").click();
  document.querySelector<HTMLButtonElement>(".main .sidebar-toggle button")!.click();
  expect(currentId()).toBe("agent-a");
  expect(document.querySelector(".shell")?.classList.contains("right-open")).toBe(false);
});

it("preserves the Terminals page when resizing from mobile to desktop", async () => {
  mobile = true;
  await mount();
  button("Show terminals").click();
  await vi.waitFor(() => expect(currentId()).toBe("shell-a"));
  mobile = false;
  mediaChanged?.();
  expect(title()).toBe("Terminals");
  expect(currentId()).toBe("shell-a");
  expect(button("Show agents")).not.toBeNull();
});
