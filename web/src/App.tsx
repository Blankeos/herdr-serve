import { FitAddon } from "@xterm/addon-fit";
import { DragGesture } from "@use-gesture/vanilla";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  type Agent,
  type Workspace,
  authLogin,
  authStatus,
  clearToken,
  createAgent,
  getToken,
  listAgents,
  listWorkspaces,
  setToken,
} from "./api";
import {
  type KeyChord,
  type Shortcut,
  type ShortcutConfig,
  chordFromEvent,
  createEmptyShortcut,
  defaultConfig,
  exportConfig,
  formatChord,
  formatChords,
  importConfig,
  loadConfig,
  saveConfig,
  shortcutToBytes,
  suggestLabel,
} from "./shortcuts";
import { loadScrollMode, saveScrollMode, scrollKeyBytes, type ScrollMode } from "./scrollPrefs";
import { encodeSgrClick, encodeSgrWheelLines } from "./mouseWheel";
import { ProjectFavicon } from "./ProjectFavicon";
import { IconSettings, IconCaretDown, IconKeyboard } from "./icons";
import {
  SoftKeyboard,
  createDictation,
  speechSupported,
} from "./lib/soft-keyboard";

const SIDEBAR_W = 272;
const UNGROUPED = "ungrouped";
const MOBILE_MQ = "(max-width: 767.98px)";

const AGENT_KINDS = [
  { id: "crabcode", label: "crabcode" },
  { id: "claude", label: "claude" },
  { id: "codex", label: "codex" },
  { id: "pi", label: "pi" },
  { id: "gemini", label: "gemini" },
  { id: "cursor", label: "cursor" },
  { id: "opencode", label: "opencode" },
] as const;

function wsURL(termID: string, cols: number, rows: number): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const q = new URLSearchParams({
    id: termID,
    cols: String(cols),
    rows: String(rows),
  });
  const token = getToken();
  if (token) q.set("token", token);
  return `${proto}//${location.host}/ws/term?${q}`;
}

/**
 * Durable terminal input queue (module-scoped).
 * Soft-keyboard taps must NEVER silently vanish across WS reconnect gaps —
 * old sendRaw() returned early when readyState !== OPEN.
 */
let liveSocket: WebSocket | undefined;
let outboundBuf = "";
let outboundFlushScheduled = false;
let outboundRetryTimer: number | undefined;

function setLiveSocket(ws: WebSocket | undefined) {
  liveSocket = ws;
  if (ws && ws.readyState === WebSocket.OPEN) flushOutbound(true);
}

function scheduleOutboundRetry() {
  if (outboundRetryTimer !== undefined) return;
  outboundRetryTimer = window.setTimeout(() => {
    outboundRetryTimer = undefined;
    flushOutbound(true);
  }, 50);
}

function flushOutbound(fromRetry = false) {
  outboundFlushScheduled = false;
  if (!outboundBuf) return;
  const ws = liveSocket;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // Keep buffer; retry until socket is live again.
    scheduleOutboundRetry();
    return;
  }
  const t = outboundBuf;
  outboundBuf = "";
  try {
    ws.send(JSON.stringify({ type: "terminal.input", text: t }));
  } catch {
    // Put bytes back and retry — never drop soft-kb / typed input.
    outboundBuf = t + outboundBuf;
    scheduleOutboundRetry();
    return;
  }
  if (outboundBuf) {
    if (fromRetry) scheduleOutboundRetry();
    else {
      outboundFlushScheduled = true;
      queueMicrotask(() => flushOutbound());
    }
  }
}

/** Enqueue text for the live terminal; coalesces + survives reconnects. */
function enqueueTerminalInput(text: string) {
  if (!text) return;
  outboundBuf += text;
  if (outboundFlushScheduled) return;
  outboundFlushScheduled = true;
  queueMicrotask(() => flushOutbound());
}

/** Soft-kb path — same durable queue. */
const queueSoftInsert = enqueueTerminalInput;
const flushSoftInsert = () => flushOutbound(true);

function mouseTrackingOn(term: Terminal | undefined): boolean {
  if (!term) return false;
  // Public API — reliable across xterm builds.
  try {
    if (term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== "none") {
      return true;
    }
  } catch {
    /* fall through */
  }
  // Private fallback (property is `coreMouseService`, not `_coreMouseService`).
  const core = (
    term as unknown as {
      _core?: {
        coreMouseService?: {
          areMouseEventsActive?: boolean;
          activeProtocol?: string;
        };
      };
    }
  )._core;
  const mouse = core?.coreMouseService;
  if (!mouse) return false;
  if (typeof mouse.areMouseEventsActive === "boolean") {
    return mouse.areMouseEventsActive;
  }
  const proto = mouse.activeProtocol;
  return Boolean(proto && proto !== "NONE");
}

function prepareMobileInput(term: Terminal) {
  const ta = term.textarea;
  if (!ta) return;
  ta.setAttribute("autocomplete", "off");
  ta.setAttribute("autocorrect", "off");
  ta.setAttribute("autocapitalize", "none");
  ta.setAttribute("spellcheck", "false");
  ta.setAttribute("enterkeyhint", "enter");
  ta.setAttribute("inputmode", "none");
  ta.setAttribute("readonly", "true");
  // Soft keyboard owns mobile input — never open the native IME.
  // Keep the helper textarea out of the mouse hit path so wheel /
  // scrollbar / TUI mouse clicks reach the canvas.
  ta.style.left = "-9999px";
  ta.style.top = "0";
  ta.style.width = "0";
  ta.style.height = "0";
  ta.style.opacity = "0";
  ta.style.caretColor = "transparent";
  ta.style.pointerEvents = "none";
}

export default function App() {
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selected, setSelected] = createSignal(""); // terminal_id
  const [error, setError] = createSignal("");
  const [conn, setConn] = createSignal<
    "idle" | "connecting" | "live" | "dead" | "detached"
  >("idle");
  const [termReady, setTermReady] = createSignal(false);

  const [workspaces, setWorkspaces] = createSignal<Workspace[]>([]);
  const [createKind, setCreateKind] = createSignal("crabcode");
  const [createLabel, setCreateLabel] = createSignal("crabcode");
  const [creating, setCreating] = createSignal(false);
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [drawerDragging, setDrawerDragging] = createSignal(false);
  const [drawerX, setDrawerX] = createSignal(0);
  const [isMobile, setIsMobile] = createSignal(
    typeof window !== "undefined" ? window.matchMedia(MOBILE_MQ).matches : false,
  );
  const [expandedIds, setExpandedIds] = createSignal<Record<string, boolean>>({});
  const [inlineCreateId, setInlineCreateId] = createSignal("");
  const [expandedSeeded, setExpandedSeeded] = createSignal(false);

  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [settingsTab, setSettingsTab] = createSignal<"general" | "shortcuts">(
    "general",
  );
  const [scrollMode, setScrollMode] = createSignal<ScrollMode>(loadScrollMode());
  const [shortcutConfig, setShortcutConfig] = createSignal<ShortcutConfig>(
    loadConfig(),
  );
  const [draftShortcuts, setDraftShortcuts] = createSignal<Shortcut[]>([]);
  const [editingId, setEditingId] = createSignal("");
  const [editLabel, setEditLabel] = createSignal("");
  const [editChords, setEditChords] = createSignal<KeyChord[]>([]);
  const [modCtrl, setModCtrl] = createSignal(false);
  const [modAlt, setModAlt] = createSignal(false);
  const [modShift, setModShift] = createSignal(false);
  const [modMeta, setModMeta] = createSignal(false);
  const [listening, setListening] = createSignal(false);
  const [importText, setImportText] = createSignal("");
  const [settingsMsg, setSettingsMsg] = createSignal("");
  const [exportText, setExportText] = createSignal("");
  const [softKbOpen, setSoftKbOpen] = createSignal(false);
  const [micActive, setMicActive] = createSignal(false);
  const [authRequired, setAuthRequired] = createSignal(false);
  const [authReady, setAuthReady] = createSignal(false);
  const [password, setPassword] = createSignal("");
  const [authError, setAuthError] = createSignal("");
  const [authBusy, setAuthBusy] = createSignal(false);

  let termHost: HTMLDivElement | undefined;
  let dictation: ReturnType<typeof createDictation> | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let activeTermID = "";
  let reconnectAttempt = 0;
  let takeoverStolenCount = 0;
  let touchScrollAcc = 0;
  let suppressClickFocus = false;
  let listenTarget: HTMLInputElement | undefined;

  const unlock = async (e?: Event) => {
    e?.preventDefault();
    if (authBusy()) return;
    setAuthBusy(true);
    setAuthError("");
    try {
      const res = await authLogin(password());
      setToken(res.token || "");
      setAuthRequired(false);
      setPassword("");
      void refreshAgents();
      void refreshWorkspaces();
    } catch (err) {
      clearToken();
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const bootstrapAuth = async () => {
    try {
      const status = await authStatus();
      if (!status.required) {
        setAuthRequired(false);
        setAuthReady(true);
        return;
      }
      const token = getToken();
      if (token) {
        try {
          await listAgents();
          setAuthRequired(false);
          setAuthReady(true);
          return;
        } catch {
          clearToken();
        }
      }
      setAuthRequired(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAuthRequired(false);
    } finally {
      setAuthReady(true);
    }
  };

  const sendRaw = (data: string) => {
    // Always enqueue — never silently drop when WS is reconnecting.
    enqueueTerminalInput(data);
  };

  const sendBytes = (data: string) => {
    // Binary-ish control sequences: still text-safe via base64, but also
    // go through the durable path once OPEN; if offline, convert to text
    // enqueue is wrong for raw bytes — keep immediate send + short retry.
    const payload = JSON.stringify({
      type: "terminal.input",
      bytes: btoa(data),
    });
    const trySend = () => {
      const ws = liveSocket ?? socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        window.setTimeout(trySend, 50);
        return;
      }
      try {
        ws.send(payload);
      } catch {
        window.setTimeout(trySend, 50);
      }
    };
    trySend();
  };

  const sendResize = (cols: number, rows: number) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "terminal.resize",
        cols,
        rows,
      }),
    );
  };

  const sendHostScroll = (
    direction: "up" | "down",
    lines: number,
    source: "wheel" | "page_key" | "scrollbar" = "wheel",
  ) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const n = Math.max(1, Math.abs(Math.trunc(lines)));
    socket.send(
      JSON.stringify({
        type: "terminal.scroll",
        direction,
        lines: n,
        source,
      }),
    );
  };

  const cellAt = (clientX?: number, clientY?: number) => {
    if (!term) return { col: 1, row: 1 };
    let col = Math.max(1, Math.floor(term.cols / 2));
    let row = Math.max(1, Math.floor(term.rows / 2));
    if (clientX == null || clientY == null) return { col, row };

    // Prefer the screen element + real cell metrics (handles padding / DPI).
    const core = (
      term as unknown as {
        _core?: {
          screenElement?: HTMLElement;
          _renderService?: {
            dimensions?: {
              css?: { cell?: { width: number; height: number } };
            };
          };
        };
      }
    )._core;
    const screen =
      core?.screenElement ??
      (term.element?.querySelector(".xterm-screen") as HTMLElement | null) ??
      term.element;
    if (!screen) return { col, row };
    const rect = screen.getBoundingClientRect();
    const cellW =
      core?._renderService?.dimensions?.css?.cell?.width ||
      rect.width / Math.max(1, term.cols);
    const cellH =
      core?._renderService?.dimensions?.css?.cell?.height ||
      rect.height / Math.max(1, term.rows);
    col = Math.max(
      1,
      Math.min(term.cols, Math.floor((clientX - rect.left) / cellW) + 1),
    );
    row = Math.max(
      1,
      Math.min(term.rows, Math.floor((clientY - rect.top) / cellH) + 1),
    );
    return { col, row };
  };

  /**
   * Send SGR left-click (press+release) into the pane.
   * Always send — herdr clears DECSET mouse modes before frames reach
   * xterm, so `term.modes.mouseTrackingMode` stays "none" and can't gate us.
   * TUIs that enabled mouse on their PTY still consume these reports.
   */
  const sendMouseClick = (clientX: number, clientY: number) => {
    if (!term || !socket || socket.readyState !== WebSocket.OPEN) return false;
    const { col, row } = cellAt(clientX, clientY);
    sendBytes(encodeSgrClick(col, row));
    return true;
  };

  const sendScroll = (
    direction: "up" | "down",
    lines: number,
    clientX?: number,
    clientY?: number,
  ) => {
    if (!term || !socket || socket.readyState !== WebSocket.OPEN) return;
    const n = Math.max(1, Math.min(8, Math.abs(Math.trunc(lines)) || 1));
    const mode = scrollMode();
    const tracking = mouseTrackingOn(term);
    const useMouse = mode === "mouse" || (mode === "auto" && tracking);
    const useKeys = mode === "keys";

    if (useKeys) {
      const bytes = scrollKeyBytes(direction).repeat(n);
      sendBytes(bytes);
      return;
    }
    if (useMouse) {
      const { col, row } = cellAt(clientX, clientY);
      sendBytes(encodeSgrWheelLines(direction, col, row, n));
      return;
    }
    sendHostScroll(direction, n, "wheel");
  };

  const disconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    activeTermID = "";
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      socket = undefined;
    }
    setLiveSocket(undefined);
    setConn("idle");
  };

  const connect = (termID: string) => {
    if (!term || !termID) return;
    // Already live/connecting to this agent — don't tear down a healthy stream.
    if (
      activeTermID === termID &&
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    disconnect();
    activeTermID = termID;

    const cols = term.cols || 80;
    const rows = term.rows || 24;
    setConn("connecting");
    setError("");
    // Do NOT term.reset() here: clearing the buffer on every agent switch makes
    // the TUI look like it hard-refreshed even when the stream is fine. Keep the
    // previous frame until the new takeover writes.

    const ws = new WebSocket(wsURL(termID, cols, rows));
    ws.binaryType = "arraybuffer";
    socket = ws;

    ws.onopen = () => {
      reconnectAttempt = 0;
      takeoverStolenCount = 0;
      setLiveSocket(ws);
      setConn("live");
      setError("");
      // Flush any soft-kb / typed input that landed during reconnect.
      flushOutbound(true);
      // Size already goes out via the WS URL / takeover args. An immediate
      // terminal.resize forces a full TUI redraw on every agent switch.
    };

    ws.onmessage = (ev) => {
      if (!term) return;
      if (typeof ev.data === "string") {
        // Text frames are relay control messages. Ignore for status — a list
        // exec during stream teardown/switch hitches panes.
        return;
      }
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
        return;
      }
    };

    ws.onerror = () => {
      setError("relay error");
    };

    ws.onclose = (ev) => {
      if (liveSocket === ws) setLiveSocket(undefined);
      socket = undefined;
      if (selected() !== termID || activeTermID !== termID) {
        setConn("dead");
        return;
      }
      // Another client (often Crabcode) stole the attach. Auto-reconnecting
      // just fights it in a dead↔live loop with "terminal attach taken over".
      const reason = (ev.reason || "").toLowerCase();
      const takenOver =
        reason.includes("taken over") || reason.includes("attach taken");
      if (takenOver || ev.code === 1000 && reason.includes("detach")) {
        setConn("detached");
        setError(
          "Terminal attach taken over by another client (e.g. Crabcode). Click Reclaim to take it back.",
        );
        return;
      }
      setConn("dead");
      reconnectAttempt = Math.min(reconnectAttempt + 1, 6);
      const delay = Math.min(1000 * 2 ** (reconnectAttempt - 1), 15000);
      reconnectTimer = window.setTimeout(() => connect(termID), delay);
    };
  };

  const reclaimTerminal = () => {
    const id = selected();
    if (!id) return;
    setError("");
    reconnectAttempt = 0;
    takeoverStolenCount += 1;
    // Force a fresh takeover even if we think we're already on this id.
    activeTermID = "";
    // If Crabcode immediately steals again, a tiny delay reduces thrash.
    const delay = Math.min(150 * takeoverStolenCount, 800);
    window.setTimeout(() => connect(id), delay);
  };

  // Signatures cover only fields the UI renders. `last_output_at` is a live
  // timestamp that changes on every poll while agents produce output — if it
  // participated in change detection, <For> (keyed by reference) would rebuild
  // every sidebar row each cycle: favicon <img> remounts → letter-avatar flash
  // → the "lags out, then refreshes" jitter every 2.5s.
  const agentSig = (a: Agent) =>
    JSON.stringify([
      a.terminal_id,
      a.pane_id,
      a.workspace_id,
      a.tab_id,
      a.agent,
      a.agent_status,
      a.focused,
      a.cwd,
      a.foreground_cwd,
      a.terminal_title,
      a.terminal_title_stripped,
    ]);

  const workspaceSig = (w: Workspace) =>
    JSON.stringify([
      w.workspace_id,
      w.label,
      w.number,
      w.focused,
      w.agent_status,
      w.active_tab_id,
      w.pane_count,
      w.tab_count,
      w.cwd,
      w.path,
    ]);

  // Reconcile by stable signature: reuse the previous item reference whenever
  // its rendered fields are unchanged so Solid's <For> keeps the existing DOM.
  const reconcile = <T,>(prev: T[], next: T[], sig: (v: T) => string): T[] => {
    if (prev.length !== next.length) return next;
    let identical = true;
    const out = next.map((n, i) => {
      const p = prev[i];
      if (p && sig(p) === sig(n)) return p;
      identical = false;
      return n;
    });
    return identical ? prev : out;
  };

  // refresh* returns true when it actually wrote new data, which drives the
  // adaptive poll cadence (fast while things change, slower at rest).
  let agentsInFlight = false;
  let agentsFails = 0;
  const refreshAgents = async (silent = false): Promise<boolean> => {
    if (agentsInFlight) return false;
    agentsInFlight = true;
    let changed = false;
    try {
      const list = await listAgents();
      agentsFails = 0;
      // Only write when data actually changed — keeps For rows stable so the
      // sidebar doesn't tear down/rebuild (favicon flash, scroll jump) each poll.
      setAgents((prev) => {
        const next = reconcile(prev, list, agentSig);
        changed = next !== prev;
        return next;
      });
      if (!selected() && list.length) {
        const focused = list.find((a) => a.focused) ?? list[0];
        setSelected(focused.terminal_id || focused.pane_id);
      }
    } catch (e) {
      // Keep last-good list on transient poll failures; surface error only
      // after repeated failures so the banner doesn't flash the layout.
      if (!silent || ++agentsFails >= 3) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      agentsInFlight = false;
    }
    return changed;
  };

  // Status queries exec `herdr` server-side, and those execs measurably
  // disturb the terminal takeover stream (tmux serializes them). So there is
  // NO background polling: refreshes are event-driven only (open drawer,
  // select agent, ws lifecycle, terminal.closed, tab visible, create/delete).
  // This helper coalesces bursts of those triggers into single round-trips.
  let statusRefreshTimer: number | undefined;
  let statusRefreshLast = 0;
  const scheduleStatusRefresh = (delayMs = 0) => {
    if (statusRefreshTimer !== undefined) return;
    const elapsed = Date.now() - statusRefreshLast;
    const wait = Math.max(delayMs, 1200 - elapsed);
    statusRefreshTimer = window.setTimeout(async () => {
      statusRefreshTimer = undefined;
      statusRefreshLast = Date.now();
      await Promise.all([refreshAgents(true), refreshWorkspaces(true)]);
    }, Math.max(0, wait));
  };

  let wsInFlight = false;
  let wsFails = 0;
  const refreshWorkspaces = async (silent = false): Promise<boolean> => {
    if (wsInFlight) return false;
    wsInFlight = true;
    let changed = false;
    try {
      const list = await listWorkspaces();
      wsFails = 0;
      setWorkspaces((prev) => {
        const next = reconcile(prev, list, workspaceSig);
        changed = next !== prev;
        return next;
      });
    } catch (e) {
      if (!silent || ++wsFails >= 3) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      wsInFlight = false;
    }
    return changed;
  };

  const agentId = (a: Agent) => a.terminal_id || a.pane_id;

  const agentLabel = (a: Agent) => {
    const title = (a.terminal_title_stripped || "").trim();
    if (title && title.toLowerCase() !== a.agent.toLowerCase()) return title;
    return a.agent;
  };

  const agentCwd = (a: Agent | undefined): string => {
    if (!a) return "";
    return (a.foreground_cwd || a.cwd || "").trim();
  };

  type WsGroup = {
    id: string;
    label: string;
    focused: boolean;
    cwd: string;
    agents: Agent[];
  };

  // Groups are the <For> items of the workspace list: they must keep stable
  // references across polls or every workspace block (agent rows, favicon
  // <img>, inline create form state) is destroyed and recreated each cycle.
  let lastGroups: WsGroup[] = [];
  const groupSig = (g: WsGroup) =>
    JSON.stringify([g.id, g.label, g.focused, g.cwd, g.agents.map(agentSig)]);

  const workspaceGroups = createMemo<WsGroup[]>(() => {
    const ws = workspaces();
    const ag = agents();
    const known = new Set(ws.map((w) => w.workspace_id));
    const groups = ws.map((w) => {
      const agentsIn = ag.filter((a) => a.workspace_id === w.workspace_id);
      const fromWs = (w.cwd || w.path || "").trim();
      const fromAgent = agentsIn.map(agentCwd).find(Boolean) || "";
      return {
        id: w.workspace_id,
        label: w.label || w.workspace_id,
        focused: !!w.focused,
        cwd: fromWs || fromAgent,
        agents: agentsIn,
      };
    });
    const orphans = ag.filter((a) => !a.workspace_id || !known.has(a.workspace_id));
    if (orphans.length) {
      groups.push({
        id: UNGROUPED,
        label: "Ungrouped",
        focused: false,
        cwd: orphans.map(agentCwd).find(Boolean) || "",
        agents: orphans,
      });
    }
    let identical = true;
    const merged = groups.map((g, i) => {
      const p = lastGroups[i];
      if (p && groupSig(p) === groupSig(g)) return p;
      identical = false;
      return g;
    });
    lastGroups = identical ? lastGroups : merged;
    return lastGroups;
  });

  const closeDrawer = () => {
    setDrawerOpen(false);
    setDrawerDragging(false);
    setDrawerX(0);
  };

  const openDrawer = () => {
    setDrawerOpen(true);
    setDrawerDragging(false);
    setDrawerX(SIDEBAR_W);
  };

  const selectAgent = (id: string) => {
    setSelected(id);
    // No status refresh here: selection highlight is client-side, and a
    // refresh execs `herdr` right as the new takeover stream connects.
    if (isMobile()) closeDrawer();
  };

  const toggleWorkspace = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const openInlineCreate = (workspaceId: string, e?: Event) => {
    e?.stopPropagation();
    if (workspaceId === UNGROUPED) return;
    setInlineCreateId(workspaceId);
    setExpandedIds((prev) => ({ ...prev, [workspaceId]: true }));
    setCreateKind("crabcode");
    setCreateLabel("crabcode");
    setError("");
  };

  const cancelInlineCreate = () => setInlineCreateId("");

  const submitCreate = async (workspaceId: string) => {
    if (!workspaceId || workspaceId === UNGROUPED || creating()) return;
    setCreating(true);
    setError("");
    try {
      const kind = createKind() || "crabcode";
      const res = await createAgent({
        workspace_id: workspaceId,
        kind,
        label: createLabel().trim() || kind,
        focus: true,
      });
      setInlineCreateId("");
      // One coalesced refresh instead of 8× parallel list execs that hitch
      // every live stream. Optimistically select the new terminal immediately.
      if (res.terminal_id) selectAgent(res.terminal_id);
      scheduleStatusRefresh(400);
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 500));
        await Promise.all([refreshAgents(true), refreshWorkspaces(true)]);
        const id = res.terminal_id;
        if (id && agents().some((a) => a.terminal_id === id)) {
          selectAgent(id);
          break;
        }
        if (res.pane_id) {
          const match = agents().find((a) => a.pane_id === res.pane_id);
          if (match) {
            selectAgent(match.terminal_id || match.pane_id);
            break;
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const persistShortcuts = (cfg: ShortcutConfig) => {
    saveConfig(cfg);
    setShortcutConfig(cfg);
  };

  const openSettings = () => {
    const cfg = loadConfig();
    setShortcutConfig(cfg);
    setDraftShortcuts(cfg.shortcuts.map((s) => ({ ...s, chords: s.chords.map((c) => ({ ...c })) })));
    setEditingId("");
    setEditLabel("");
    setEditChords([]);
    setModCtrl(false);
    setModAlt(false);
    setModShift(false);
    setModMeta(false);
    setListening(false);
    setImportText("");
    setExportText(exportConfig(cfg));
    setSettingsMsg("");
    setSettingsTab("general");
    setSettingsOpen(true);
  };

  const updateScrollMode = (mode: ScrollMode) => {
    setScrollMode(mode);
    saveScrollMode(mode);
  };

  const closeSettings = () => {
    setListening(false);
    setSettingsOpen(false);
  };

  const startEdit = (s: Shortcut) => {
    setEditingId(s.id);
    setEditLabel(s.label);
    setEditChords(s.chords.map((c) => ({ ...c })));
    setListening(false);
    setSettingsMsg("");
  };

  const startAdd = () => {
    const blank = createEmptyShortcut();
    setEditingId(blank.id);
    setEditLabel("");
    setEditChords([]);
    setListening(false);
    setSettingsMsg("");
  };

  const cancelEdit = () => {
    setEditingId("");
    setEditLabel("");
    setEditChords([]);
    setListening(false);
  };

  const applyMods = (c: KeyChord): KeyChord => ({
    ...c,
    ctrl: c.ctrl || modCtrl(),
    alt: c.alt || modAlt(),
    shift: c.shift || modShift(),
    meta: c.meta || modMeta(),
  });

  const addChord = (c: KeyChord) => {
    const next = applyMods(c);
    const updated = [...editChords(), next];
    setEditChords(updated);
    if (!editLabel().trim()) setEditLabel(suggestLabel(updated));
    setListening(false);
    setModCtrl(false);
    setModAlt(false);
    setModShift(false);
    setModMeta(false);
  };

  const onListenKey = (e: KeyboardEvent) => {
    if (!listening()) return;
    e.preventDefault();
    e.stopPropagation();
    const chord = chordFromEvent(e);
    if (!chord) return;
    addChord(chord);
  };

  const saveEdit = () => {
    const chords = editChords();
    if (!chords.length) {
      setSettingsMsg("Capture at least one key / combination.");
      return;
    }
    const label = editLabel().trim() || suggestLabel(chords);
    const id = editingId();
    const next: Shortcut = { id, label, chords: chords.map((c) => ({ ...c })) };
    setDraftShortcuts((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx >= 0) {
        const copy = prev.slice();
        copy[idx] = next;
        return copy;
      }
      return [...prev, next];
    });
    cancelEdit();
    setSettingsMsg("");
  };

  const removeDraft = (id: string) => {
    setDraftShortcuts((prev) => prev.filter((s) => s.id !== id));
    if (editingId() === id) cancelEdit();
  };

  const moveDraft = (id: string, dir: -1 | 1) => {
    setDraftShortcuts((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx < 0) return prev;
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const copy = prev.slice();
      const tmp = copy[idx];
      copy[idx] = copy[j];
      copy[j] = tmp;
      return copy;
    });
  };

  const saveSettings = () => {
    const cfg: ShortcutConfig = { version: 1, shortcuts: draftShortcuts() };
    persistShortcuts(cfg);
    setExportText(exportConfig(cfg));
    setSettingsMsg("Saved to this browser.");
    cancelEdit();
  };

  const resetDefaults = () => {
    const cfg = defaultConfig();
    setDraftShortcuts(cfg.shortcuts.map((s) => ({ ...s, chords: s.chords.map((c) => ({ ...c })) })));
    cancelEdit();
    setSettingsMsg("Restored defaults (not saved yet).");
  };

  const doImport = () => {
    try {
      const cfg = importConfig(importText());
      setDraftShortcuts(cfg.shortcuts.map((s) => ({ ...s, chords: s.chords.map((c) => ({ ...c })) })));
      setExportText(exportConfig(cfg));
      cancelEdit();
      setSettingsMsg(`Imported ${cfg.shortcuts.length} shortcut(s). Save to keep.`);
    } catch (e) {
      setSettingsMsg(e instanceof Error ? e.message : "Import failed");
    }
  };

  const copyExport = async () => {
    const text = exportConfig({ version: 1, shortcuts: draftShortcuts() });
    setExportText(text);
    try {
      await navigator.clipboard.writeText(text);
      setSettingsMsg("Copied JSON to clipboard.");
    } catch {
      setSettingsMsg("Copy failed — select the export box and copy manually.");
    }
  };

  const fireShortcut = (s: Shortcut) => {
    const bytes = shortcutToBytes(s);
    if (!bytes) return;
    sendRaw(bytes);
  };

  // Soft-kb → durable outbound queue (survives WS reconnect gaps).
  const softInsert = (text: string) => queueSoftInsert(text);

  const softBackspace = () => {
    if (outboundBuf) flushSoftInsert();
    enqueueTerminalInput("\x7f");
  };
  const softReturn = () => {
    if (outboundBuf) flushSoftInsert();
    enqueueTerminalInput("\r");
  };

  const softPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) softInsert(text);
    } catch {
      setError("Clipboard paste blocked — allow paste permission");
      window.setTimeout(() => setError(""), 2500);
    }
  };

  const softMicToggle = () => {
    if (!dictation) {
      if (!speechSupported()) {
        setError("Voice typing unavailable in this browser");
        window.setTimeout(() => setError(""), 2500);
        return;
      }
      dictation = createDictation({
        onInsert: (t) => softInsert(t.endsWith(" ") ? t : `${t} `),
        onActiveChange: setMicActive,
        onError: (msg) => {
          setError(`Mic: ${msg}`);
          window.setTimeout(() => setError(""), 2500);
        },
      });
    }
    dictation.toggle();
  };

  const jumpScroll = (edge: "top" | "bottom") => {
    if (!term) return;
    const dir = edge === "bottom" ? "down" : "up";
    // 1) Local xterm viewport (normal buffer / local scrollback).
    try {
      if (edge === "bottom") term.scrollToBottom();
      else {
        term.scrollToLine(0);
        // Fallback: scroll by full buffer height upward.
        const y = term.buffer.active.viewportY;
        if (y > 0) term.scrollLines(-y);
      }
    } catch {
      /* ignore */
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // 2) TUI alt-screen: flood SGR wheel (most agents honor mouse scroll).
    const col = Math.max(1, Math.floor(term.cols / 2));
    const row = Math.max(1, Math.floor(term.rows / 2));
    sendBytes(encodeSgrWheelLines(dir, col, row, 8).repeat(40));
    // 3) Ctrl+Home / Ctrl+End — jump extremes in many TUIs.
    sendRaw(edge === "bottom" ? "\x1b[1;5F" : "\x1b[1;5H");
    // 4) PageUp / PageDown burst.
    sendRaw((edge === "bottom" ? "\x1b[6~" : "\x1b[5~").repeat(16));
    // 5) Host scrollback + configured scroll mode.
    sendHostScroll(dir, 2000, "page_key");
    for (let i = 0; i < 16; i++) sendScroll(dir, 8);
  };

  const openSoftKeyboard = () => {
    if (!isMobile()) return;
    setSoftKbOpen(true);
    // Never focus xterm textarea — that opens native IME.
    try {
      term?.blur();
      (document.activeElement as HTMLElement | null)?.blur?.();
    } catch {
      /* ignore */
    }
  };

  const closeSoftKeyboard = () => {
    setSoftKbOpen(false);
    dictation?.stop();
  };

  let lastSentCols = 0;
  let lastSentRows = 0;
  let lastHostW = 0;
  let lastHostH = 0;
  const refit = () => {
    if (!term || !termHost) return;
    const rect = termHost.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    // visualViewport scroll/resize fires constantly on mobile; skip no-op fits
    // because fitAddon.fit() itself re-renders the terminal canvas.
    if (w === lastHostW && h === lastHostH && lastSentCols > 0) return;
    lastHostW = w;
    lastHostH = h;
    fit?.fit();
    const cols = term.cols;
    const rows = term.rows;
    // Skip no-op resizes — herdr/tmux redraws the whole TUI on every resize.
    if (cols === lastSentCols && rows === lastSentRows) return;
    lastSentCols = cols;
    lastSentRows = rows;
    sendResize(cols, rows);
  };

  onMount(() => {
    term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.0,
      letterSpacing: 0,
      theme: {
        background: "#101010",
        foreground: "#e8e8e8",
        cursor: "#6c8ed8",
        selectionBackground: "#3a3a3a",
      },
      scrollback: 5000,
      allowProposedApi: true,
      // Let xterm synthesize mouse reports when the app enables mouse mode
      // (crabcode / TUIs). Combined with not overlaying the textarea, this
      // makes scrollbar thumb + click targets work.
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost!);
    prepareMobileInput(term);
    fit.fit();
    setTermReady(true);

    // Native / Bluetooth keyboard → PTY
    term.onData((data) => sendRaw(data));

    // Desktop / trackpad wheel → sendScroll (mouse reports / keys / host).
    // Always handle when connected so Claude/opencode mouse mode still scrolls.
    let wheelAcc = 0;
    term.attachCustomWheelEventHandler((ev) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      ev.preventDefault();
      wheelAcc += ev.deltaY;
      const line = Math.sign(wheelAcc) * Math.floor(Math.abs(wheelAcc) / 40);
      if (line === 0) return true;
      wheelAcc -= line * 40;
      sendScroll(line < 0 ? "up" : "down", Math.abs(line), ev.clientX, ev.clientY);
      return true;
    });

    // Touch: intentional vertical drag → scroll; otherwise → SGR click.
    // Soft keyboard opens only via the toolbar shortcut — never on tap.
    // Finger jitter (~10–20px) must NOT count as scroll or clicks get eaten.
    // Fast swipe → momentum (macOS-like fling) after finger-up.
    type TouchMeta = {
      ty: number;
      sx: number;
      sy: number;
      scrolling: boolean;
      /** Recent samples for release velocity (px/ms). Finger-up → content down. */
      samples: { t: number; y: number }[];
      lastX: number;
      lastY: number;
    };
    const hostTouch = termHost as HTMLDivElement & { _tm?: TouchMeta };
    const lineHeightPx = () =>
      Math.max(14, term?.rows ? termHost!.clientHeight / term.rows : 18);
    // Need ~1.5 rows of movement before we treat the gesture as a scroll.
    const scrollArmPx = () => Math.max(28, lineHeightPx() * 1.5);

    // --- momentum / fling (mobile) -----------------------------------------
    // Tunables (vibe later): friction, min release speed, max lines/frame.
    const FLING_FRICTION = 0.0035; // 1/ms exponential decay
    const FLING_MIN_V = 0.35; // px/ms to start a fling
    const FLING_STOP_V = 0.05; // px/ms to stop
    const FLING_MAX_LINES = 6; // per rAF tick
    let flingRaf = 0;
    let flingVel = 0; // px/ms, same sign as touchScrollAcc (finger up → +)
    let flingAcc = 0;
    let flingLastT = 0;
    let flingX = 0;
    let flingY = 0;
    const stopFling = () => {
      if (flingRaf) cancelAnimationFrame(flingRaf);
      flingRaf = 0;
      flingVel = 0;
      flingAcc = 0;
    };
    const flingTick = (now: number) => {
      if (!flingRaf) return;
      const dt = Math.min(32, Math.max(0, now - flingLastT));
      flingLastT = now;
      if (dt <= 0) {
        flingRaf = requestAnimationFrame(flingTick);
        return;
      }
      // v *= e^(-friction * dt)
      flingVel *= Math.exp(-FLING_FRICTION * dt);
      if (Math.abs(flingVel) < FLING_STOP_V) {
        stopFling();
        return;
      }
      flingAcc += flingVel * dt;
      const linePx = lineHeightPx();
      if (Math.abs(flingAcc) >= linePx) {
        let lines = Math.trunc(flingAcc / linePx);
        flingAcc -= lines * linePx;
        if (Math.abs(lines) > FLING_MAX_LINES) {
          lines = Math.sign(lines) * FLING_MAX_LINES;
        }
        sendScroll(
          lines > 0 ? "down" : "up",
          Math.abs(lines),
          flingX,
          flingY,
        );
      }
      flingRaf = requestAnimationFrame(flingTick);
    };
    const startFling = (velPxPerMs: number, x: number, y: number) => {
      stopFling();
      if (Math.abs(velPxPerMs) < FLING_MIN_V) return;
      // Cap absurd flicks (~3px/ms ≈ very fast swipe).
      flingVel = Math.max(-3, Math.min(3, velPxPerMs));
      flingAcc = 0;
      flingX = x;
      flingY = y;
      flingLastT = performance.now();
      flingRaf = requestAnimationFrame(flingTick);
    };
    const releaseVelocity = (samples: { t: number; y: number }[]): number => {
      if (samples.length < 2) return 0;
      const last = samples[samples.length - 1]!;
      // Look back ~80ms for a stable estimate.
      let first = samples[0]!;
      for (let i = samples.length - 2; i >= 0; i--) {
        const s = samples[i]!;
        if (last.t - s.t >= 80) {
          first = s;
          break;
        }
        first = s;
      }
      const dt = last.t - first.t;
      if (dt < 8) return 0;
      // Finger-up (y decreases) → positive (scroll down), match touchScrollAcc.
      return (first.y - last.y) / dt;
    };

    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return;
      stopFling(); // grab the content — kill leftover momentum
      touchScrollAcc = 0;
      suppressClickFocus = false;
      const t = ev.touches[0];
      const now = performance.now();
      hostTouch._tm = {
        ty: t.clientY,
        sx: t.clientX,
        sy: t.clientY,
        scrolling: false,
        samples: [{ t: now, y: t.clientY }],
        lastX: t.clientX,
        lastY: t.clientY,
      };
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      const touch = ev.touches[0];
      const meta = hostTouch._tm;
      if (!meta) return;
      const prev = meta.ty;
      meta.ty = touch.clientY;
      meta.lastX = touch.clientX;
      meta.lastY = touch.clientY;
      const now = performance.now();
      meta.samples.push({ t: now, y: touch.clientY });
      while (meta.samples.length > 8 || (meta.samples[0] && now - meta.samples[0].t > 120)) {
        meta.samples.shift();
      }
      const fromStart = Math.abs(touch.clientY - meta.sy);
      if (!meta.scrolling) {
        if (fromStart < scrollArmPx()) return; // still a tap (jitter)
        meta.scrolling = true;
        suppressClickFocus = true;
        touchScrollAcc = meta.sy - touch.clientY; // catch up from start
      } else {
        touchScrollAcc += prev - touch.clientY;
      }
      const linePx = lineHeightPx();
      if (Math.abs(touchScrollAcc) >= linePx) {
        const lines = Math.trunc(touchScrollAcc / linePx);
        touchScrollAcc -= lines * linePx;
        sendScroll(
          lines > 0 ? "down" : "up",
          Math.abs(lines),
          touch.clientX,
          touch.clientY,
        );
        ev.preventDefault();
      }
    };
    // iOS synthesizes mouseup after touchend — ignore briefly.
    let ignoreMouseUntil = 0;

    const onTouchEnd = (ev: TouchEvent) => {
      const meta = hostTouch._tm;
      // Click at finger-down cell — more accurate than release after drift.
      const x = meta?.sx ?? ev.changedTouches[0]?.clientX ?? 0;
      const y = meta?.sy ?? ev.changedTouches[0]?.clientY ?? 0;
      const wasScroll = meta?.scrolling || suppressClickFocus;
      const flingX0 = meta?.lastX ?? x;
      const flingY0 = meta?.lastY ?? y;
      const vel = meta ? releaseVelocity(meta.samples) : 0;
      hostTouch._tm = undefined;
      touchScrollAcc = 0;
      ignoreMouseUntil = performance.now() + 450;
      suppressClickFocus = false;
      if (wasScroll) {
        startFling(vel, flingX0, flingY0);
        return;
      }
      if (drawerOpen()) return;
      if (sendMouseClick(x, y)) {
        ev.preventDefault();
      } else if (!isMobile()) {
        term?.focus();
      }
    };

    // Herdr strips DECSET, so xterm never synthesizes clicks — we always do.
    // Mobile: ignore synthetic mouseup after touchend (already handled there).
    const onMouseUp = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      if (isMobile()) {
        if (performance.now() < ignoreMouseUntil) return;
        if (!drawerOpen() && !suppressClickFocus) {
          sendMouseClick(ev.clientX, ev.clientY);
        }
        return;
      }
      if (!suppressClickFocus && !drawerOpen()) {
        sendMouseClick(ev.clientX, ev.clientY);
      }
      term?.focus();
    };

    const onTouchCancel = () => {
      stopFling();
      hostTouch._tm = undefined;
      touchScrollAcc = 0;
      suppressClickFocus = false;
    };

    termHost!.addEventListener("touchstart", onTouchStart, { passive: true });
    termHost!.addEventListener("touchmove", onTouchMove, { passive: false });
    termHost!.addEventListener("touchend", onTouchEnd, { passive: false });
    termHost!.addEventListener("touchcancel", onTouchCancel, { passive: true });
    termHost!.addEventListener("mouseup", onMouseUp);

    const onResize = () => refit();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);

    void bootstrapAuth().then(() => {
      if (!authRequired()) {
        void refreshAgents();
        void refreshWorkspaces();
      }
    });
    // No background polling and no visibility/drawer auto-refresh. Status
    // queries exec herdr and hitch the takeover stream; refresh only after
    // explicit create/delete (and initial load above).

    const mq = window.matchMedia(MOBILE_MQ);
    const onMq = () => {
      const mobile = mq.matches;
      setIsMobile(mobile);
      if (!mobile) closeDrawer();
    };
    onMq();
    mq.addEventListener("change", onMq);

    const gesture = new DragGesture(
      document.documentElement,
      ({
        active,
        movement: [mx],
        velocity: [vx],
        direction: [dx],
        cancel,
        event,
        intentional,
      }) => {
        if (!mq.matches || settingsOpen()) {
          cancel();
          return;
        }
        const target = event?.target as Element | null;
        if (
          target?.closest(
            ".sidebar, .sheet, .sheet-backdrop, .inline-create, .soft-keyboard, .dock, input, textarea, select",
          )
        ) {
          cancel();
          return;
        }

        const open = drawerOpen();
        // Closed: only drag right opens. Open: any horizontal updates position.
        if (!open && mx < 0) {
          cancel();
          return;
        }
        if (!intentional) return;

        const start = open ? SIDEBAR_W : 0;
        const next = Math.max(0, Math.min(SIDEBAR_W, start + mx));

        if (active) {
          // Don't open soft kb from the same gesture that dragged the drawer.
          suppressClickFocus = true;
          setDrawerDragging(true);
          setDrawerX(next);
          return;
        }

        setDrawerDragging(false);
        const flickOpen = vx > 0.45 && dx > 0;
        const flickClose = vx > 0.45 && dx < 0;
        if (open) {
          if (flickClose || next < SIDEBAR_W * 0.6) closeDrawer();
          else openDrawer();
        } else if (flickOpen || next > SIDEBAR_W * 0.4) {
          openDrawer();
        } else {
          closeDrawer();
        }
      },
      {
        axis: "x",
        filterTaps: true,
        threshold: 12,
        pointer: { touch: true },
        eventOptions: { passive: true },
      },
    );

    // Extra iOS guard: pinch / gesture zoom on chrome UI.
    const blockGesture = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", blockGesture, {
      passive: false,
    } as AddEventListenerOptions);
    document.addEventListener("gesturechange", blockGesture, {
      passive: false,
    } as AddEventListenerOptions);

    onCleanup(() => {
      stopFling();
      if (statusRefreshTimer !== undefined) clearTimeout(statusRefreshTimer);
      mq.removeEventListener("change", onMq);
      gesture.destroy();
      dictation?.stop();
      document.removeEventListener("gesturestart", blockGesture);
      document.removeEventListener("gesturechange", blockGesture);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
      termHost?.removeEventListener("touchstart", onTouchStart);
      termHost?.removeEventListener("touchmove", onTouchMove);
      termHost?.removeEventListener("touchend", onTouchEnd);
      termHost?.removeEventListener("touchcancel", onTouchCancel);
      termHost?.removeEventListener("mouseup", onMouseUp);
      disconnect();
      term?.dispose();
    });
  });

  createEffect(() => {
    // Drawer open → dismiss soft kb so it doesn't fight the sidebar.
    if (drawerOpen()) closeSoftKeyboard();
  });

  createEffect(() => {
    // Desktop resize → soft kb off.
    if (!isMobile()) closeSoftKeyboard();
  });

  createEffect(() => {
    // Soft keyboard is in-flow — reflow xterm when it opens/closes.
    softKbOpen();
    queueMicrotask(() => {
      lastHostW = 0;
      lastHostH = 0;
      refit();
    });
  });

  createEffect(() => {
    const id = selected();
    if (!authReady() || authRequired()) {
      disconnect();
      return;
    }
    if (id && termReady()) connect(id);
  });

  createEffect(() => {
    const groups = workspaceGroups();
    const sel = selected();
    const selectedWs =
      agents().find((a) => agentId(a) === sel)?.workspace_id || "";
    setExpandedIds((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const g of groups) {
        if (g.focused || g.id === selectedWs || g.agents.some((a) => agentId(a) === sel)) {
          if (!next[g.id]) {
            next[g.id] = true;
            changed = true;
          }
        }
      }
      if (!expandedSeeded() && groups.length) {
        for (const g of groups) {
          if (next[g.id] === undefined) next[g.id] = !!g.focused;
        }
        setExpandedSeeded(true);
        changed = true;
      }
      return changed ? next : prev;
    });
  });

  const current = () =>
    agents().find(
      (a) => a.terminal_id === selected() || a.pane_id === selected(),
    );

  const shellStyle = () =>
    drawerDragging()
      ? { "--drawer-x": `${drawerX()}px` }
      : undefined;

  return (
    <div class="app">
      <Show when={authReady() && authRequired()}>
        <div class="auth-overlay" role="dialog" aria-modal="true" aria-label="Password">
          <form class="auth-panel" onSubmit={unlock}>
            <h1 class="auth-title">Unlock herdr-serve</h1>
            <p class="auth-copy">Enter the password set when starting the server.</p>
            <div class="auth-row">
              <input
                class="auth-input"
                type="password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                autocomplete="current-password"
                placeholder="password"
                autofocus
              />
              <button class="auth-submit" type="submit" disabled={authBusy()}>
                Unlock
              </button>
            </div>
            <div class="auth-error">{authError()}</div>
          </form>
        </div>
      </Show>
      <div
        class="shell"
        classList={{
          "drawer-open": drawerOpen(),
          dragging: drawerDragging(),
        }}
        style={shellStyle() as Record<string, string> | undefined}
      >
        <aside class="sidebar" aria-label="Workspaces">
          <div class="sidebar-brand">
            <div class="sidebar-brand-title">herdr-serve</div>
            <div class="sidebar-brand-sub">workspaces</div>
          </div>
          <div class="sidebar-scroll">
            <For each={workspaceGroups()}>
              {(g) => {
                const open = () => !!expandedIds()[g.id];
                return (
                  <div class="workspace" classList={{ open: open() }}>
                    <div class="workspace-header">
                      <button
                        type="button"
                        class="workspace-toggle"
                        onClick={() => toggleWorkspace(g.id)}
                      >
                        <span class="workspace-chevron" aria-hidden="true">
                          <IconCaretDown class="workspace-chevron-icon" />
                        </span>
                        <Show when={g.cwd}>
                          <ProjectFavicon cwd={g.cwd} label={g.label} />
                        </Show>
                        <span class="workspace-name">{g.label}</span>
                        <span class="workspace-count">{g.agents.length}</span>
                      </button>
                      <Show when={g.id !== UNGROUPED}>
                        <button
                          type="button"
                          class="workspace-add"
                          aria-label={`New agent in ${g.label}`}
                          onClick={(e) => openInlineCreate(g.id, e)}
                        >
                          +
                        </button>
                      </Show>
                    </div>
                    <Show when={open()}>
                      <div class="workspace-body">
                        <For each={g.agents}>
                          {(a) => {
                            const id = agentId(a);
                            return (
                              <button
                                type="button"
                                class="agent-row"
                                classList={{ active: id === selected() }}
                                onClick={() => selectAgent(id)}
                              >
                                <span class="dot-wrap">
                                  <span class="dot" data-status={a.agent_status} />
                                  <Show when={a.agent_status === "working"}>
                                    <span class="dot-ping" />
                                  </Show>
                                </span>
                                <span class="agent-row-name">{agentLabel(a)}</span>
                              </button>
                            );
                          }}
                        </For>
                        <Show when={inlineCreateId() === g.id}>
                          <div class="inline-create">
                            <div class="kind-row">
                              <For each={[...AGENT_KINDS]}>
                                {(k) => (
                                  <button
                                    type="button"
                                    class="kind"
                                    classList={{ active: createKind() === k.id }}
                                    onClick={() => {
                                      setCreateKind(k.id);
                                      if (
                                        !createLabel() ||
                                        AGENT_KINDS.some((x) => x.id === createLabel())
                                      ) {
                                        setCreateLabel(k.id);
                                      }
                                    }}
                                  >
                                    {k.label}
                                  </button>
                                )}
                              </For>
                            </div>
                            <input
                              type="text"
                              value={createLabel()}
                              placeholder={createKind()}
                              onInput={(e) => setCreateLabel(e.currentTarget.value)}
                            />
                            <div class="inline-create-actions">
                              <button
                                type="button"
                                class="sheet-secondary"
                                onClick={() => cancelInlineCreate()}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                class="sheet-primary"
                                disabled={creating()}
                                onClick={() => void submitCreate(g.id)}
                              >
                                {creating() ? "Creating…" : "Create"}
                              </button>
                            </div>
                          </div>
                        </Show>
                        <Show when={!g.agents.length && inlineCreateId() !== g.id}>
                          <div class="empty-inline">No agents</div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={!workspaceGroups().length}>
              <div class="empty-inline">No workspaces yet.</div>
            </Show>
          </div>
          <div class="sidebar-footer">
            <button type="button" class="sidebar-settings-btn" onClick={() => openSettings()}>
              <IconSettings class="sidebar-settings-icon" />
              <span>Settings</span>
            </button>
          </div>
        </aside>

        <div
          class="scrim"
          onClick={() => closeDrawer()}
          aria-hidden={drawerOpen() ? "false" : "true"}
        />

        <div class="main main-shift">
          <header class="topbar">
            <button
              type="button"
              class="menu-btn"
              aria-label="Open sidebar"
              onClick={() => (drawerOpen() ? closeDrawer() : openDrawer())}
            >
              ☰
            </button>
            <div class="top-right">
              <span class="conn" data-conn={conn()}>
                {conn()}
              </span>
              <Show when={conn() === "detached" || conn() === "dead"}>
                <button
                  type="button"
                  class="reclaim-btn"
                  onClick={() => reclaimTerminal()}
                >
                  Reclaim
                </button>
              </Show>
              <Show when={current()}>
                {(a) => (
                  <div class="status" data-status={a().agent_status}>
                    {a().agent_status}
                  </div>
                )}
              </Show>
            </div>
          </header>

          <Show when={error()}>
            <div class="error">{error()}</div>
          </Show>

          <div class="term-wrap">
            <div class="term" ref={termHost} />
          </div>

          <nav class="dock" aria-label="Shortcut keys">
            <div class="keybar-scroll">
              <Show when={isMobile()}>
                <button
                  type="button"
                  class="keychip keychip-icon"
                  classList={{ active: softKbOpen() }}
                  title="Toggle on-screen keyboard"
                  aria-label="Toggle on-screen keyboard"
                  onClick={() =>
                    softKbOpen() ? closeSoftKeyboard() : openSoftKeyboard()
                  }
                >
                  <IconKeyboard class="keychip-svg" />
                </button>
                <button
                  type="button"
                  class="keychip"
                  title="Paste from clipboard"
                  disabled={!selected() || conn() !== "live"}
                  onClick={() => void softPaste()}
                >
                  Paste
                </button>
                <button
                  type="button"
                  class="keychip jump"
                  title="Scroll to top"
                  disabled={!selected()}
                  onClick={() => jumpScroll("top")}
                >
                  ↑ Top
                </button>
                <button
                  type="button"
                  class="keychip jump"
                  title="Scroll to bottom"
                  disabled={!selected()}
                  onClick={() => jumpScroll("bottom")}
                >
                  ↓ Bottom
                </button>
              </Show>
              <For each={shortcutConfig().shortcuts}>
                {(s) => (
                  <button
                    type="button"
                    class="keychip"
                    title={formatChords(s.chords)}
                    disabled={!selected() || conn() !== "live"}
                    onClick={() => fireShortcut(s)}
                  >
                    {s.label}
                  </button>
                )}
              </For>
              <Show when={!shortcutConfig().shortcuts.length}>
                <button type="button" class="keychip muted" onClick={() => openSettings()}>
                  Add shortcuts…
                </button>
              </Show>
            </div>
          </nav>

          <SoftKeyboard
            open={softKbOpen()}
            micActive={micActive()}
            onInsert={softInsert}
            onBackspace={softBackspace}
            onReturn={softReturn}
            onMicToggle={softMicToggle}
            onPaste={() => void softPaste()}
            onEmoji={() => softInsert("🙂")}
          />
        </div>
      </div>

      <Show when={settingsOpen()}>
        <div class="sheet-backdrop" onClick={() => closeSettings()} />
        <div class="sheet sheet-tall" role="dialog" aria-label="Settings">
          <div class="sheet-head">
            <div class="sheet-title">Settings</div>
            <button type="button" class="sheet-close" onClick={() => closeSettings()}>
              Close
            </button>
          </div>

          <div class="sheet-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              class="sheet-tab"
              classList={{ active: settingsTab() === "general" }}
              aria-selected={settingsTab() === "general"}
              onClick={() => setSettingsTab("general")}
            >
              General
            </button>
            <button
              type="button"
              role="tab"
              class="sheet-tab"
              classList={{ active: settingsTab() === "shortcuts" }}
              aria-selected={settingsTab() === "shortcuts"}
              onClick={() => setSettingsTab("shortcuts")}
            >
              Shortcuts
            </button>
          </div>

          <Show when={settingsTab() === "general"}>
            <div class="settings-general">
              <label class="field">
                <span>Scroll mode</span>
                <select
                  value={scrollMode()}
                  onChange={(e) => updateScrollMode(e.currentTarget.value as ScrollMode)}
                >
                  <option value="auto">Auto</option>
                  <option value="host">Host scrollback</option>
                  <option value="mouse">Mouse reports</option>
                  <option value="keys">Key chords (Ctrl-X K/J)</option>
                </select>
              </label>
              <p class="sheet-help">
                Auto uses mouse reports when a TUI enables mouse tracking (Claude, opencode),
                otherwise falls back to host scrollback. Mouse reports and key chords always
                send those inputs; host always scrolls the terminal buffer.
              </p>
            </div>
          </Show>

          <Show when={settingsTab() === "shortcuts"}>
          <p class="sheet-help">
            Keys appear in the footer bar. Stored in this browser’s localStorage — export JSON to
            copy to another phone.
          </p>

          <div class="shortcut-list">
            <For each={draftShortcuts()}>
              {(s) => (
                <div class="shortcut-row" classList={{ editing: editingId() === s.id }}>
                  <div class="shortcut-main">
                    <div class="shortcut-label">{s.label}</div>
                    <div class="shortcut-chords">{formatChords(s.chords)}</div>
                  </div>
                  <div class="shortcut-actions">
                    <button type="button" class="mini" onClick={() => moveDraft(s.id, -1)} title="Move left">
                      ←
                    </button>
                    <button type="button" class="mini" onClick={() => moveDraft(s.id, 1)} title="Move right">
                      →
                    </button>
                    <button type="button" class="mini" onClick={() => startEdit(s)}>
                      Edit
                    </button>
                    <button type="button" class="mini danger" onClick={() => removeDraft(s.id)}>
                      Del
                    </button>
                  </div>
                </div>
              )}
            </For>
            <Show when={!draftShortcuts().length}>
              <div class="empty-inline">No shortcuts yet.</div>
            </Show>
          </div>

          <Show
            when={editingId()}
            fallback={
              <button type="button" class="sheet-secondary" onClick={() => startAdd()}>
                + Add shortcut
              </button>
            }
          >
            <div class="editor">
              <label class="field">
                <span>Button label</span>
                <input
                  type="text"
                  value={editLabel()}
                  placeholder={suggestLabel(editChords()) || "Ctrl+X"}
                  onInput={(e) => setEditLabel(e.currentTarget.value)}
                />
              </label>

              <div class="field">
                <span>Modifiers (sticky for next key)</span>
                <div class="mod-row">
                  <button
                    type="button"
                    class="mod"
                    classList={{ active: modCtrl() }}
                    onClick={() => setModCtrl((v) => !v)}
                  >
                    Ctrl
                  </button>
                  <button
                    type="button"
                    class="mod"
                    classList={{ active: modAlt() }}
                    onClick={() => setModAlt((v) => !v)}
                  >
                    Alt
                  </button>
                  <button
                    type="button"
                    class="mod"
                    classList={{ active: modShift() }}
                    onClick={() => setModShift((v) => !v)}
                  >
                    Shift
                  </button>
                  <button
                    type="button"
                    class="mod"
                    classList={{ active: modMeta() }}
                    onClick={() => setModMeta((v) => !v)}
                  >
                    Meta
                  </button>
                </div>
              </div>

              <div class="field">
                <span>Sequence</span>
                <div class="chord-chips">
                  <For each={editChords()}>
                    {(c, i) => (
                      <button
                        type="button"
                        class="chord-chip"
                        title="Remove"
                        onClick={() =>
                          setEditChords((prev) => prev.filter((_, idx) => idx !== i()))
                        }
                      >
                        {formatChord(c)} ×
                      </button>
                    )}
                  </For>
                  <Show when={!editChords().length}>
                    <span class="muted-inline">No keys yet</span>
                  </Show>
                </div>
              </div>

              <div class="listen-row">
                <button
                  type="button"
                  class="sheet-secondary"
                  classList={{ listening: listening() }}
                  onClick={() => {
                    setListening(true);
                    queueMicrotask(() => listenTarget?.focus());
                  }}
                >
                  {listening() ? "Listening… tap a key" : "Listen for key"}
                </button>
                <input
                  ref={(el) => {
                    listenTarget = el;
                  }}
                  class="listen-trap"
                  type="text"
                  inputmode="none"
                  autocomplete="off"
                  autocorrect="off"
                  spellcheck={false}
                  aria-label="Key capture"
                  value=""
                  onKeyDown={onListenKey}
                  onBlur={() => {
                    // Keep listening flag until a chord is captured or cancelled
                  }}
                />
                <div class="quick-keys">
                  <For
                    each={[
                      "Escape",
                      "Enter",
                      "Tab",
                      "Backspace",
                      "ArrowUp",
                      "ArrowDown",
                      "ArrowLeft",
                      "ArrowRight",
                    ]}
                  >
                    {(k) => (
                      <button
                        type="button"
                        class="mini"
                        onClick={() => addChord({ key: k })}
                      >
                        {formatChord({ key: k })}
                      </button>
                    )}
                  </For>
                </div>
                <div class="letter-grid" aria-label="Letters and digits">
                  <For
                    each={"abcdefghijklmnopqrstuvwxyz0123456789".split("")}
                  >
                    {(k) => (
                      <button
                        type="button"
                        class="mini letter"
                        onClick={() => addChord({ key: k })}
                      >
                        {k.toUpperCase()}
                      </button>
                    )}
                  </For>
                  <For each={["[", "]", "\\", "-", "=", "/", "?", " "]}>
                    {(k) => (
                      <button
                        type="button"
                        class="mini letter"
                        onClick={() => addChord({ key: k })}
                      >
                        {k === " " ? "Spc" : k}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <p class="sheet-help tight">
                Tip: for Ctrl+X then M, listen (or sticky Ctrl + X), then listen again for M.
              </p>

              <div class="editor-actions">
                <button type="button" class="sheet-secondary" onClick={() => cancelEdit()}>
                  Cancel
                </button>
                <button type="button" class="sheet-primary" onClick={() => saveEdit()}>
                  Apply
                </button>
              </div>
            </div>
          </Show>

          <div class="settings-actions">
            <button type="button" class="sheet-primary" onClick={() => saveSettings()}>
              Save
            </button>
            <button type="button" class="sheet-secondary" onClick={() => resetDefaults()}>
              Reset defaults
            </button>
          </div>

          <Show when={settingsMsg()}>
            <div class="settings-msg">{settingsMsg()}</div>
          </Show>

          <details class="io">
            <summary>Import / Export</summary>
            <label class="field">
              <span>Export JSON</span>
              <textarea
                rows={5}
                readonly
                value={exportText() || exportConfig({ version: 1, shortcuts: draftShortcuts() })}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" class="sheet-secondary" onClick={() => void copyExport()}>
                Copy JSON
              </button>
            </label>
            <label class="field">
              <span>Import JSON</span>
              <textarea
                rows={5}
                value={importText()}
                placeholder='{"version":1,"shortcuts":[...]}'
                onInput={(e) => setImportText(e.currentTarget.value)}
              />
              <button type="button" class="sheet-secondary" onClick={() => doImport()}>
                Import
              </button>
            </label>
          </details>
          </Show>
        </div>
      </Show>
    </div>
  );
}
