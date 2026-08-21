import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import Keyboard from "simple-keyboard";
import "simple-keyboard/build/css/index.css";
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { type Agent, listAgents } from "./api";

/** Map simple-keyboard buttons → bytes for the PTY. */
const KEY_BYTES: Record<string, string> = {
  "{enter}": "\r",
  "{bksp}": "\x7f",
  "{tab}": "\t",
  "{space}": " ",
  "{esc}": "\x1b",
  "{up}": "\x1b[A",
  "{down}": "\x1b[B",
  "{right}": "\x1b[C",
  "{left}": "\x1b[D",
};

function wsURL(termID: string, cols: number, rows: number): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const q = new URLSearchParams({
    id: termID,
    cols: String(cols),
    rows: String(rows),
  });
  return `${proto}//${location.host}/ws/term?${q}`;
}

export default function App() {
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selected, setSelected] = createSignal(""); // terminal_id
  const [error, setError] = createSignal("");
  const [conn, setConn] = createSignal<"idle" | "connecting" | "live" | "dead">(
    "idle",
  );
  const [kbOpen, setKbOpen] = createSignal(true);
  const [termReady, setTermReady] = createSignal(false);

  let termHost: HTMLDivElement | undefined;
  let kbHost: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let keyboard: Keyboard | undefined;
  let socket: WebSocket | undefined;
  let shift = false;
  let layoutName = "default";
  let reconnectTimer: number | undefined;

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
      // text frames: ignore pongs / control
    };

    ws.onerror = () => {
      setError("relay error");
    };

    ws.onclose = () => {
      setConn("dead");
      socket = undefined;
      // Auto-reconnect if still selected
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
    fit.fit();
    setTermReady(true);

    // Physical / bluetooth keyboard → PTY
    term.onData((data) => sendRaw(data));

    // Wheel scroll → herdr terminal.scroll
    term.attachCustomWheelEventHandler((ev) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      const lines = Math.sign(ev.deltaY) * Math.min(5, Math.ceil(Math.abs(ev.deltaY) / 40));
      if (lines !== 0) {
        socket.send(JSON.stringify({ type: "terminal.scroll", lines }));
      }
      return true; // prevent xterm local scroll fighting relay
    });

    const onResize = () => {
      fit?.fit();
      if (term) sendResize(term.cols, term.rows);
    };
    window.addEventListener("resize", onResize);

    keyboard = new Keyboard(kbHost!, {
      theme: "hg-theme-default herdr-kb",
      layoutName: "default",
      display: {
        "{bksp}": "⌫",
        "{enter}": "↵",
        "{shift}": "⇧",
        "{space}": "space",
        "{esc}": "esc",
        "{numbers}": "123",
        "{abc}": "ABC",
        "{default}": "ABC",
        "{up}": "↑",
        "{down}": "↓",
        "{left}": "←",
        "{right}": "→",
        "{ctrlc}": "⌃C",
        "{tab}": "tab",
      },
      layout: {
        default: [
          "q w e r t y u i o p",
          "a s d f g h j k l",
          "{shift} z x c v b n m {bksp}",
          "{numbers} {esc} {ctrlc} {space} {enter}",
        ],
        shift: [
          "Q W E R T Y U I O P",
          "A S D F G H J K L",
          "{shift} Z X C V B N M {bksp}",
          "{numbers} {esc} {ctrlc} {space} {enter}",
        ],
        numbers: [
          "1 2 3 4 5 6 7 8 9 0",
          "- / : ; ( ) $ & @ \"",
          "{abc} . , ? ! ' {bksp}",
          "{default} {left} {up} {down} {right} {enter}",
        ],
      },
      buttonTheme: [
        {
          class: "hg-action",
          buttons: "{enter} {bksp} {shift} {numbers} {abc} {default} {esc} {ctrlc}",
        },
      ],
      onKeyPress: (button: string) => onKbKey(button),
      preventMouseDownDefault: true,
      stopMouseDownPropagation: true,
      useMouseEvents: true,
      useTouchEvents: true,
    });

    void refreshAgents();
    const poll = setInterval(() => void refreshAgents(), 2500);

    onCleanup(() => {
      clearInterval(poll);
      window.removeEventListener("resize", onResize);
      disconnect();
      keyboard?.destroy();
      term?.dispose();
    });
  });

  // Reconnect when selection changes (after xterm is mounted)
  createEffect(() => {
    const id = selected();
    if (id && termReady()) connect(id);
  });

  createEffect(() => {
    kbOpen();
    queueMicrotask(() => {
      fit?.fit();
      if (term) sendResize(term.cols, term.rows);
    });
  });

  const onKbKey = (button: string) => {
    if (button === "{shift}") {
      shift = !shift;
      layoutName = shift ? "shift" : "default";
      keyboard?.setOptions({ layoutName });
      return;
    }
    if (button === "{numbers}") {
      layoutName = "numbers";
      keyboard?.setOptions({ layoutName });
      return;
    }
    if (button === "{abc}" || button === "{default}") {
      shift = false;
      layoutName = "default";
      keyboard?.setOptions({ layoutName });
      return;
    }
    if (button === "{ctrlc}") {
      sendRaw("\x03");
      return;
    }

    const mapped = KEY_BYTES[button];
    if (mapped !== undefined) {
      sendRaw(mapped);
      return;
    }
    if (button.length === 1) {
      sendRaw(button);
      if (shift) {
        shift = false;
        layoutName = "default";
        keyboard?.setOptions({ layoutName });
      }
    }
  };

  const current = () =>
    agents().find(
      (a) => a.terminal_id === selected() || a.pane_id === selected(),
    );

  return (
    <div class="app" classList={{ "kb-open": kbOpen() }}>
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
                classList={{ active: id === selected() }}
                onClick={() => setSelected(id)}
              >
                <span class="dot" data-status={a.agent_status} />
                <span class="meta">
                  <span class="name">{a.terminal_title_stripped || a.agent}</span>
                  <span class="id">
                    {a.agent} · {a.pane_id}
                  </span>
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

      <div class="actions">
        <button type="button" class="btn" onClick={() => sendRaw("y")}>
          Approve (y)
        </button>
        <button type="button" class="btn danger" onClick={() => sendRaw("\x1b")}>
          Esc
        </button>
        <button type="button" class="btn" onClick={() => setKbOpen((v) => !v)}>
          {kbOpen() ? "Hide KB" : "Show KB"}
        </button>
      </div>

      <div class="kb-wrap" classList={{ hidden: !kbOpen() }}>
        <div class="simple-keyboard" ref={kbHost} />
      </div>
    </div>
  );
}
