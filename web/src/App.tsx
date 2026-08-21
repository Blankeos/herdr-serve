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
import { type Agent, listAgents } from "./api";

function wsURL(termID: string, cols: number, rows: number): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const q = new URLSearchParams({
    id: termID,
    cols: String(cols),
    rows: String(rows),
  });
  return `${proto}//${location.host}/ws/term?${q}`;
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
}

export default function App() {
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selected, setSelected] = createSignal(""); // terminal_id
  const [error, setError] = createSignal("");
  const [conn, setConn] = createSignal<"idle" | "connecting" | "live" | "dead">(
    "idle",
  );
  const [termReady, setTermReady] = createSignal(false);

  let termHost: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let touchScrollAcc = 0;

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

  const sendScroll = (lines: number) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || lines === 0) return;
    socket.send(JSON.stringify({ type: "terminal.scroll", lines }));
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

  const refit = () => {
    fit?.fit();
    if (term) sendResize(term.cols, term.rows);
  };

  onMount(() => {
    term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.15,
      theme: {
        background: "#101010",
        foreground: "#e8e8e8",
        cursor: "#6c8ed8",
        selectionBackground: "#3a3a3a",
      },
      scrollback: 5000,
      allowProposedApi: true,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost!);
    prepareMobileInput(term);
    fit.fit();
    setTermReady(true);

    // Native / Bluetooth keyboard → PTY
    term.onData((data) => sendRaw(data));

    // Desktop wheel → remote TUI scroll
    term.attachCustomWheelEventHandler((ev) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      const lines =
        Math.sign(ev.deltaY) *
        Math.min(8, Math.max(1, Math.ceil(Math.abs(ev.deltaY) / 40)));
      sendScroll(lines);
      return true;
    });

    // Touch drag → remote TUI scroll (phones don't always synthesize wheel)
    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return;
      touchScrollAcc = 0;
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      // Only treat as scroll when the remote app isn't eating mouse-drag;
      // a one-finger vertical drag scrolls the TUI.
      const touch = ev.touches[0];
      // Use movement via changedTouches delta stored on element
      const prev = (termHost as HTMLDivElement & { _ty?: number })._ty;
      (termHost as HTMLDivElement & { _ty?: number })._ty = touch.clientY;
      if (prev === undefined) return;
      const dy = prev - touch.clientY;
      touchScrollAcc += dy;
      const linePx = 18;
      if (Math.abs(touchScrollAcc) >= linePx) {
        const lines = Math.trunc(touchScrollAcc / linePx);
        touchScrollAcc -= lines * linePx;
        sendScroll(lines);
        ev.preventDefault();
      }
    };
    const onTouchEnd = () => {
      (termHost as HTMLDivElement & { _ty?: number })._ty = undefined;
      touchScrollAcc = 0;
      // Summon native keyboard on tap / after gesture
      term?.focus();
    };

    termHost!.addEventListener("touchstart", onTouchStart, { passive: true });
    termHost!.addEventListener("touchmove", onTouchMove, { passive: false });
    termHost!.addEventListener("touchend", onTouchEnd, { passive: true });

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
        <div class="brand">herdr-serve</div>
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
                <span class="dot" data-status={a.agent_status} />
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
        <Show when={!agents().length}>
          <div class="empty">No agents — start one in Herder.</div>
        </Show>
      </nav>

      <div class="term-wrap">
        <div class="term" ref={termHost} />
      </div>

      <Show when={error()}>
        <div class="error">{error()}</div>
      </Show>
    </div>
  );
}
