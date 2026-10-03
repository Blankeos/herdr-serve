import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { keepHardwareCursorVisible, markHardwareCursorHost } from "./hardware-cursor";

let TerminalClass: typeof import("@xterm/xterm").Terminal;
beforeAll(async () => {
  // xterm probes canvas color support at import time; these parser tests do
  // not need a renderer and jsdom has no canvas implementation.
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  try {
    TerminalClass = (await import("@xterm/xterm")).Terminal;
  } finally {
    canvas.mockRestore();
  }
});

let term: Terminal | undefined;
afterEach(() => {
  term?.dispose();
  vi.restoreAllMocks();
});

function setup() {
  term = new TerminalClass({ cols: 20, rows: 4, allowProposedApi: true });
  return term;
}

function write(term: Terminal, data: string) {
  return new Promise<void>((resolve) => term.write(data, resolve));
}

// These are the two gates used by xterm 6's DOM cursor renderer. Inspect them
// only in tests; production initializes via supported VT sequences, not _core.
function cursorState(term: Terminal) {
  return (term as unknown as {
    _core: { coreService: { isCursorInitialized: boolean; isCursorHidden: boolean } };
  })._core.coreService;
}

// Same envelope as Herder's BlitEncoder, including the final cursor anchor.
function frame(row: number, col: number, visible: boolean, cells = "") {
  return `\x1b[?2026h\x1b[?25l${cells}\x1b[${row};${col}H\x1b[?25${visible ? "h" : "l"}\x1b[?2026l`;
}

describe("hardware caret in unfocused frame streams", () => {
  it("initializes without focus and waits for the host to show the caret", async () => {
    const term = setup();
    const focus = vi.spyOn(term, "focus");
    const onData = vi.fn();
    term.onData(onData);
    expect(cursorState(term).isCursorInitialized).toBe(false);

    keepHardwareCursorVisible(term);
    await write(term, "\x1b[0m"); // Drain the asynchronous initialization write.

    expect(cursorState(term).isCursorInitialized).toBe(true);
    expect(cursorState(term).isCursorHidden).toBe(true);
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.active.cursorX).toBe(0);
    expect(term.buffer.active.cursorY).toBe(0);
    expect(term.options.cursorInactiveStyle).toBe("block");
    expect(focus).not.toHaveBeenCalled();
    expect(onData).not.toHaveBeenCalled();
  });

  it("renders the first frame's caret and follows cursor-only updates", async () => {
    const term = setup();
    keepHardwareCursorVisible(term);
    await write(term, frame(2, 8, true, "\x1b[2;1Hprompt>"));

    expect(cursorState(term).isCursorInitialized).toBe(true);
    expect(cursorState(term).isCursorHidden).toBe(false);
    expect(term.buffer.active.cursorX).toBe(7);
    expect(term.buffer.active.cursorY).toBe(1);
    expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("prompt>");

    await write(term, frame(2, 4, true));
    expect(term.buffer.active.cursorX).toBe(3);
    expect(cursorState(term).isCursorHidden).toBe(false);
  });

  it("respects hidden cursors and restores them on the next visible frame", async () => {
    const term = setup();
    keepHardwareCursorVisible(term);
    await write(term, frame(2, 8, true));
    await write(term, frame(4, 20, false));
    expect(cursorState(term).isCursorHidden).toBe(true);

    term.resize(30, 6);
    await write(term, frame(3, 9, true));
    expect(cursorState(term).isCursorInitialized).toBe(true);
    expect(cursorState(term).isCursorHidden).toBe(false);
    expect(term.buffer.active.cursorX).toBe(8);
    expect(term.buffer.active.cursorY).toBe(2);
  });

  it("tags the host without requiring focus or a host element", () => {
    const host = document.createElement("div");
    markHardwareCursorHost(host);
    expect(host.classList.contains("hw-cursor-visible")).toBe(true);
    expect(() => markHardwareCursorHost(undefined)).not.toThrow();
  });

  it("does not reflow painted frames into local history after sidebar resizing", async () => {
    const term = setup();
    keepHardwareCursorVisible(term);
    const paint = () => frame(4, 1, true, Array.from({ length: 4 }, (_, i) =>
      `\x1b[${i + 1};1H${String(i).repeat(term.cols)}`).join(""));
    await write(term, paint());
    for (const [cols, rows] of [[40, 4], [20, 3], [40, 4], [20, 4]]) {
      term.resize(cols, rows);
      await write(term, paint());
      expect(term.buffer.active.type).toBe("alternate");
      expect(term.buffer.active.baseY).toBe(0);
      expect(term.buffer.active.viewportY).toBe(0);
      expect(term.buffer.active.length).toBe(rows);
    }
  });
});
