import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  type Agent,
  type Workspace,
  createAgent,
  listAgents,
  listWorkspaces,
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
  return `${proto}//${location.host}/ws/term?${q}`;
}

function mouseTrackingOn(term: Terminal | undefined): boolean {
  if (!term) return false;
  const core = (
    term as unknown as {
      _core?: {
        _coreMouseService?: {
          areMouseEventsActive?: boolean;
          activeProtocol?: string;
        };
      };
    }
  )._core;
  const mouse = core?._coreMouseService;
  if (!mouse) return false;
  if (typeof mouse.areMouseEventsActive === "boolean") {
    return mouse.areMouseEventsActive;
  }
  return Boolean(mouse.activeProtocol);
}

function prepareMobileInput(term: Terminal) {
  const ta = term.textarea;
  if (!ta) return;
  ta.setAttribute("autocomplete", "off");
  ta.setAttribute("autocorrect", "off");
  ta.setAttribute("autocapitalize", "none");
  ta.setAttribute("spellcheck", "false");
  ta.setAttribute("enterkeyhint", "send");
  ta.setAttribute("inputmode", "text");
  // Keep the helper textarea out of the mouse hit path so wheel /
  // scrollbar / TUI mouse clicks reach the canvas. Focus is still
  // granted via term.focus() on intentional taps.
  ta.style.left = "-9999px";
  ta.style.top = "0";
  ta.style.width = "0";
  ta.style.height = "0";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
}

export default function App() {
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selected, setSelected] = createSignal(""); // terminal_id
  const [error, setError] = createSignal("");
  const [conn, setConn] = createSignal<"idle" | "connecting" | "live" | "dead">(
    "idle",
  );
  const [termReady, setTermReady] = createSignal(false);

  const [createOpen, setCreateOpen] = createSignal(false);
  const [workspaces, setWorkspaces] = createSignal<Workspace[]>([]);
  const [createWorkspace, setCreateWorkspace] = createSignal("");
  const [createKind, setCreateKind] = createSignal("crabcode");
  const [createLabel, setCreateLabel] = createSignal("");
  const [createCwd, setCreateCwd] = createSignal("");
  const [creating, setCreating] = createSignal(false);

  const [settingsOpen, setSettingsOpen] = createSignal(false);
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

  let termHost: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let touchScrollAcc = 0;
  let suppressClickFocus = false;
  let listenTarget: HTMLInputElement | undefined;

  const sendRaw = (data: string) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "terminal.input",
        text: data,
      }),
    );
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

  const sendScroll = (
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

  const disconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
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
    setConn("idle");
  };

  const connect = (termID: string) => {
    disconnect();
    if (!term || !termID) return;

    const cols = term.cols || 80;
    const rows = term.rows || 24;
    setConn("connecting");
    setError("");
    term.reset();

    const ws = new WebSocket(wsURL(termID, cols, rows));
    ws.binaryType = "arraybuffer";
    socket = ws;

    ws.onopen = () => {
      setConn("live");
      sendResize(term!.cols, term!.rows);
    };

    ws.onmessage = (ev) => {
      if (!term) return;
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
        return;
      }
    };

    ws.onerror = () => {
      setError("relay error");
    };

    ws.onclose = () => {
      setConn("dead");
      socket = undefined;
      if (selected() === termID) {
        reconnectTimer = window.setTimeout(() => connect(termID), 1200);
      }
    };
  };

  const refreshAgents = async () => {
    try {
      const list = await listAgents();
      setAgents(list);
      if (!selected() && list.length) {
        const focused = list.find((a) => a.focused) ?? list[0];
        setSelected(focused.terminal_id || focused.pane_id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openCreate = async () => {
    setError("");
    setCreateOpen(true);
    try {
      const list = await listWorkspaces();
      setWorkspaces(list);
      const preferred =
        list.find((w) => w.focused)?.workspace_id ||
        list[0]?.workspace_id ||
        "";
      setCreateWorkspace(preferred);
      if (!createKind()) setCreateKind("crabcode");
      if (!createLabel()) setCreateLabel("crabcode");
      // Seed cwd from currently selected agent when available.
      const cur = current();
      if (cur && !createCwd()) {
        setCreateCwd(cur.foreground_cwd || cur.cwd || "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submitCreate = async () => {
    if (!createWorkspace() || creating()) return;
    setCreating(true);
    setError("");
    try {
      const kind = createKind() || "crabcode";
      const res = await createAgent({
        workspace_id: createWorkspace(),
        kind,
        label: createLabel() || kind,
        cwd: createCwd() || undefined,
        focus: true,
      });
      setCreateOpen(false);
      // Poll briefly until the new agent appears in agent list.
      for (let i = 0; i < 8; i++) {
        await refreshAgents();
        const id = res.terminal_id;
        if (id && agents().some((a) => a.terminal_id === id)) {
          setSelected(id);
          break;
        }
        if (res.pane_id) {
          const match = agents().find((a) => a.pane_id === res.pane_id);
          if (match) {
            setSelected(match.terminal_id || match.pane_id);
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      if (res.terminal_id) setSelected(res.terminal_id);
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
    setSettingsOpen(true);
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

  const refit = () => {
    fit?.fit();
    if (term) sendResize(term.cols, term.rows);
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

    // Desktop wheel:
    // - If the remote app has mouse tracking enabled, let xterm emit mouse
    //   reports through onData (don't intercept).
    // - Otherwise translate to herdr host scrollback (direction + lines).
    term.attachCustomWheelEventHandler((ev) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      // When mouse protocol is active, return false so xterm sends CSI mouse
      // reports through onData (scrollbar thumb / app scroll work).
      if (mouseTrackingOn(term)) return false;

      const abs = Math.min(12, Math.max(1, Math.ceil(Math.abs(ev.deltaY) / 40)));
      const direction = ev.deltaY < 0 ? "up" : "down";
      sendScroll(direction, abs, "wheel");
      return true;
    });

    // Touch vertical drag → host/app scroll when mouse mode is off.
    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return;
      touchScrollAcc = 0;
      suppressClickFocus = false;
      (termHost as HTMLDivElement & { _ty?: number })._ty = ev.touches[0].clientY;
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (mouseTrackingOn(term)) return;

      const touch = ev.touches[0];
      const prev = (termHost as HTMLDivElement & { _ty?: number })._ty;
      (termHost as HTMLDivElement & { _ty?: number })._ty = touch.clientY;
      if (prev === undefined) return;
      const dy = prev - touch.clientY;
      touchScrollAcc += dy;
      const linePx = Math.max(12, term?.rows ? termHost!.clientHeight / term.rows : 16);
      if (Math.abs(touchScrollAcc) >= linePx) {
        const lines = Math.trunc(touchScrollAcc / linePx);
        touchScrollAcc -= lines * linePx;
        sendScroll(lines > 0 ? "down" : "up", Math.abs(lines), "wheel");
        suppressClickFocus = true;
        ev.preventDefault();
      }
    };
    const onTouchEnd = () => {
      (termHost as HTMLDivElement & { _ty?: number })._ty = undefined;
      touchScrollAcc = 0;
      if (!suppressClickFocus) {
        // Summon native keyboard on tap
        term?.focus();
      }
      suppressClickFocus = false;
    };

    // Mouse click into empty area / after gesture: focus for typing
    const onMouseUp = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      // Don't steal focus if user interacted with scrollbar-ish right edge
      // (xterm scrollbar is ~10px). Still focus on normal clicks.
      term?.focus();
    };

    termHost!.addEventListener("touchstart", onTouchStart, { passive: true });
    termHost!.addEventListener("touchmove", onTouchMove, { passive: false });
    termHost!.addEventListener("touchend", onTouchEnd, { passive: true });
    termHost!.addEventListener("mouseup", onMouseUp);

    const onResize = () => refit();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);

    void refreshAgents();
    const poll = setInterval(() => void refreshAgents(), 2500);

    onCleanup(() => {
      clearInterval(poll);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
      termHost?.removeEventListener("touchstart", onTouchStart);
      termHost?.removeEventListener("touchmove", onTouchMove);
      termHost?.removeEventListener("touchend", onTouchEnd);
      termHost?.removeEventListener("mouseup", onMouseUp);
      disconnect();
      term?.dispose();
    });
  });

  createEffect(() => {
    const id = selected();
    if (id && termReady()) connect(id);
  });

  const current = () =>
    agents().find(
      (a) => a.terminal_id === selected() || a.pane_id === selected(),
    );

  const agentLabel = (a: Agent) => {
    const title = (a.terminal_title_stripped || "").trim();
    if (title && title.toLowerCase() !== a.agent.toLowerCase()) return title;
    return a.agent;
  };

  return (
    <div class="app">
      <header class="top">
        <div class="brand-row">
          <div class="brand">herdr-serve</div>
          <button
            type="button"
            class="icon-btn"
            aria-label="Shortcut settings"
            title="Shortcuts"
            onClick={() => openSettings()}
          >
            ⚙
          </button>
        </div>
        <div class="top-right">
          <span class="conn" data-conn={conn()}>
            {conn()}
          </span>
          <Show when={current()}>
            {(a) => (
              <div class="status" data-status={a().agent_status}>
                {a().agent_status}
              </div>
            )}
          </Show>
        </div>
      </header>

      <nav class="agents">
        <For each={agents()}>
          {(a) => {
            const id = a.terminal_id || a.pane_id;
            return (
              <button
                type="button"
                class="agent"
                data-status={a.agent_status}
                classList={{ active: id === selected() }}
                onClick={() => setSelected(id)}
              >
                <span class="dot-wrap">
                  <span class="dot" data-status={a.agent_status} />
                  <Show when={a.agent_status === "working"}>
                    <span class="dot-ping" />
                  </Show>
                </span>
                <span class="name">{agentLabel(a)}</span>
                <span class="meta">
                  <span class="state" data-status={a.agent_status}>
                    {a.agent_status}
                  </span>
                  <span class="pane">{a.pane_id}</span>
                </span>
              </button>
            );
          }}
        </For>
        <button type="button" class="agent add" onClick={() => void openCreate()}>
          <span class="plus">+</span>
          <span class="name">New agent</span>
          <span class="meta">
            <span class="state">create</span>
          </span>
        </button>
        <Show when={!agents().length}>
          <div class="empty">No agents yet — tap + to create one.</div>
        </Show>
      </nav>

      <div class="term-wrap">
        <div class="term" ref={termHost} />
        <Show when={error()}>
          <div class="error">{error()}</div>
        </Show>
      </div>

      <footer class="keybar" aria-label="Shortcut keys">
        <div class="keybar-scroll">
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
      </footer>

      <Show when={createOpen()}>
        <div class="sheet-backdrop" onClick={() => setCreateOpen(false)} />
        <div class="sheet" role="dialog" aria-label="Create agent">
          <div class="sheet-head">
            <div class="sheet-title">New agent</div>
            <button type="button" class="sheet-close" onClick={() => setCreateOpen(false)}>
              Close
            </button>
          </div>

          <label class="field">
            <span>Workspace</span>
            <select
              value={createWorkspace()}
              onChange={(e) => setCreateWorkspace(e.currentTarget.value)}
            >
              <For each={workspaces()}>
                {(w) => (
                  <option value={w.workspace_id}>
                    {w.label || w.workspace_id}
                    {w.focused ? " · focused" : ""}
                  </option>
                )}
              </For>
            </select>
          </label>

          <label class="field">
            <span>Agent</span>
            <div class="kind-row">
              <For each={[...AGENT_KINDS]}>
                {(k) => (
                  <button
                    type="button"
                    class="kind"
                    classList={{ active: createKind() === k.id }}
                    onClick={() => {
                      setCreateKind(k.id);
                      if (!createLabel() || AGENT_KINDS.some((x) => x.id === createLabel())) {
                        setCreateLabel(k.id);
                      }
                    }}
                  >
                    {k.label}
                  </button>
                )}
              </For>
            </div>
          </label>

          <label class="field">
            <span>Tab label</span>
            <input
              type="text"
              value={createLabel()}
              placeholder={createKind()}
              onInput={(e) => setCreateLabel(e.currentTarget.value)}
            />
          </label>

          <label class="field">
            <span>Working directory (optional)</span>
            <input
              type="text"
              value={createCwd()}
              placeholder="/path/to/project"
              onInput={(e) => setCreateCwd(e.currentTarget.value)}
            />
          </label>

          <button
            type="button"
            class="sheet-primary"
            disabled={!createWorkspace() || creating()}
            onClick={() => void submitCreate()}
          >
            {creating() ? "Creating…" : `Create ${createKind()}`}
          </button>
        </div>
      </Show>

      <Show when={settingsOpen()}>
        <div class="sheet-backdrop" onClick={() => closeSettings()} />
        <div class="sheet sheet-tall" role="dialog" aria-label="Shortcut settings">
          <div class="sheet-head">
            <div class="sheet-title">Shortcuts</div>
            <button type="button" class="sheet-close" onClick={() => closeSettings()}>
              Close
            </button>
          </div>

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
        </div>
      </Show>
    </div>
  );
}
