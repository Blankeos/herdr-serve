import {
  BACKSPACE_FILL,
  BACKSPACE_OUTLINE,
  CAPS_FILL,
  EMOJI,
  MIC,
  SHIFT_FILL,
  SHIFT_OUTLINE,
} from "./icons";
import { layoutRows } from "./layouts";
import type {
  SoftKeyDef,
  SoftKeyId,
  SoftKeyboardHandlers,
  SoftKeyboardLayout,
} from "./types";

const REPEAT_DELAY_MS = 420;
const REPEAT_EVERY_MS = 55;

export type DomSoftKeyboardOptions = SoftKeyboardHandlers & {
  className?: string;
  micActive?: boolean;
};

export type DomSoftKeyboard = {
  root: HTMLElement;
  setOpen: (open: boolean) => void;
  setMicActive: (active: boolean) => void;
  setHandlers: (handlers: SoftKeyboardHandlers) => void;
  destroy: () => void;
};

/**
 * Pure-DOM iOS soft keyboard. No framework VDOM — only host callbacks.
 * Presses resolve against live layout state so rAF-deferred rebuilds
 * never drop or mis-case fast multi-taps.
 */
export function createDomSoftKeyboard(
  opts: DomSoftKeyboardOptions = {
    onInsert: () => {},
    onBackspace: () => {},
    onReturn: () => {},
  },
): DomSoftKeyboard {
  let handlers: SoftKeyboardHandlers = {
    onInsert: opts.onInsert,
    onBackspace: opts.onBackspace,
    onReturn: opts.onReturn,
    onEmoji: opts.onEmoji,
    onMicToggle: opts.onMicToggle,
    onPaste: opts.onPaste,
  };

  let layout: SoftKeyboardLayout = "letters";
  let shiftLatched = false;
  let micActive = Boolean(opts.micActive);
  let open = false;

  let repeatTimer: number | undefined;
  let repeatEvery: number | undefined;
  let ghostEl: HTMLElement | null = null;
  let renderRaf = 0;
  let destroyed = false;
  /** Row/col stamped on each button; resolves against live `layout`. */
  let pressedEl: HTMLElement | null = null;

  const root = document.createElement("div");
  root.className = `soft-keyboard${opts.className ? ` ${opts.className}` : ""}`;
  root.hidden = true;
  root.setAttribute("aria-hidden", "true");

  const rowsEl = document.createElement("div");
  rowsEl.className = "sk-rows";
  root.appendChild(rowsEl);

  const homeBar = document.createElement("div");
  homeBar.className = "sk-home-bar";
  homeBar.setAttribute("aria-hidden", "true");
  root.appendChild(homeBar);

  const clearRepeat = () => {
    if (repeatTimer !== undefined) {
      clearTimeout(repeatTimer);
      repeatTimer = undefined;
    }
    if (repeatEvery !== undefined) {
      clearInterval(repeatEvery);
      repeatEvery = undefined;
    }
  };

  const clearGhost = () => {
    if (ghostEl) {
      ghostEl.classList.remove("sk-pressed");
      if (ghostEl.classList.contains("sk-backspace")) setBackspaceIcon(ghostEl, false);
      ghostEl = null;
    }
  };

  /** Coalesce layout rebuilds so fast taps never race a DOM swap. */
  const scheduleRender = () => {
    if (renderRaf || destroyed) return;
    renderRaf = window.requestAnimationFrame(() => {
      renderRaf = 0;
      if (!destroyed) render();
    });
  };

  const afterChar = () => {
    if (layout === "shifted" && !shiftLatched) {
      layout = "letters";
      scheduleRender();
    }
  };

  const keyAt = (row: number, col: number): SoftKeyDef | null => {
    const rows = layoutRows(layout);
    return rows[row]?.[col] ?? null;
  };

  const findCharButton = (value: string): HTMLElement | null => {
    const target = value.toLowerCase();
    const buttons = rowsEl.querySelectorAll<HTMLElement>("button.sk-key[data-sk-char]");
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i]!;
      if ((b.dataset.skChar ?? "").toLowerCase() === target) return b;
    }
    return null;
  };

  const runAction = (id: SoftKeyId) => {
    switch (id) {
      case "space":
        handlers.onInsert(" ");
        afterChar();
        break;
      case "return":
        handlers.onReturn();
        break;
      case "backspace":
        handlers.onBackspace();
        break;
      case "shift":
        if (layout === "shifted") {
          if (shiftLatched) {
            shiftLatched = false;
            layout = "letters";
          } else {
            shiftLatched = true;
          }
        } else {
          shiftLatched = false;
          layout = "shifted";
        }
        scheduleRender();
        break;
      case "numbers":
        shiftLatched = false;
        layout = "numbers";
        scheduleRender();
        break;
      case "symbols":
        shiftLatched = false;
        layout = "symbols";
        scheduleRender();
        break;
      case "letters":
        shiftLatched = false;
        layout = "letters";
        scheduleRender();
        break;
      case "emoji":
        handlers.onEmoji?.();
        break;
      case "mic":
        handlers.onMicToggle?.();
        break;
      case "paste":
        handlers.onPaste?.();
        break;
      default:
        break;
    }
  };

  const pressKey = (key: SoftKeyDef) => {
    if (key.kind === "spacer") {
      if (key.actionAlias) {
        runAction(key.actionAlias);
        return;
      }
      if (key.alias) {
        // Alias always inserts against live letters/shifted casing.
        const ch =
          layout === "shifted" ? key.alias.toUpperCase() : key.alias.toLowerCase();
        handlers.onInsert(ch);
        afterChar();
      }
      return;
    }
    if (key.kind === "char") {
      handlers.onInsert(key.value);
      afterChar();
      return;
    }
    runAction(key.id);
  };

  const onPointerDown = (ev: PointerEvent, el: HTMLElement) => {
    // Keep focus off native IME. Capture so highlight clears even if finger slides.
    ev.preventDefault();
    try {
      el.setPointerCapture?.(ev.pointerId);
    } catch {
      /* ignore — some browsers throw if pointer already gone */
    }

    const row = Number(el.dataset.skRow);
    const col = Number(el.dataset.skCol);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    const key = keyAt(row, col);
    if (!key) return;

    pressedEl = el;
    el.classList.add("sk-pressed");

    if (key.kind === "spacer" && key.alias) {
      clearGhost();
      ghostEl = findCharButton(key.alias);
      ghostEl?.classList.add("sk-pressed");
    }
    if (key.kind === "spacer" && key.actionAlias) {
      clearGhost();
      ghostEl = rowsEl.querySelector<HTMLElement>(
        `button.sk-${key.actionAlias === "backspace" ? "backspace" : key.actionAlias}`,
      );
      ghostEl?.classList.add("sk-pressed");
      if (key.actionAlias === "backspace" && ghostEl) setBackspaceIcon(ghostEl, true);
    }

    // Backspace fills while held — no resize, just outline → solid.
    if (key.kind === "action" && key.id === "backspace") {
      setBackspaceIcon(el, true);
    }

    // Fire insert BEFORE any layout rebuild so fast taps never wait on DOM.
    pressKey(key);

    const isBackspace =
      (key.kind === "action" && key.id === "backspace") ||
      (key.kind === "spacer" && key.actionAlias === "backspace");
    if (isBackspace) {
      clearRepeat();
      repeatTimer = window.setTimeout(() => {
        repeatEvery = window.setInterval(() => handlers.onBackspace(), REPEAT_EVERY_MS);
      }, REPEAT_DELAY_MS);
    }
  };

  const onPointerEnd = (el: HTMLElement) => {
    el.classList.remove("sk-pressed");
    if (el.classList.contains("sk-backspace")) setBackspaceIcon(el, false);
    if (pressedEl === el) pressedEl = null;
    clearGhost();
    clearRepeat();
  };

  const labelHtml = (key: SoftKeyDef): string => {
    if (key.kind === "spacer") return "";
    if (key.kind === "action") {
      switch (key.id) {
        case "shift":
          // Idle outline · one-shot filled · caps = broken ⇪ filled.
          if (shiftLatched) return CAPS_FILL;
          if (layout === "shifted") return SHIFT_FILL;
          return SHIFT_OUTLINE;
        case "backspace":
          return BACKSPACE_OUTLINE;
        case "emoji":
          return EMOJI;
        case "mic":
          return MIC;
        default:
          break;
      }
    }
    return escapeHtml(key.label);
  };

  const setBackspaceIcon = (el: HTMLElement, filled: boolean) => {
    const label = el.querySelector(".sk-label");
    if (label) label.innerHTML = filled ? BACKSPACE_FILL : BACKSPACE_OUTLINE;
  };

  const bindPress = (el: HTMLElement) => {
    el.addEventListener("pointerdown", (e) => onPointerDown(e, el));
    el.addEventListener("pointerup", () => onPointerEnd(el));
    el.addEventListener("pointercancel", () => onPointerEnd(el));
    el.addEventListener("lostpointercapture", () => onPointerEnd(el));
  };

  const render = () => {
    clearRepeat();
    clearGhost();
    pressedEl = null;
    const rows = layoutRows(layout);
    // Rebuild rows with DocumentFragment — no framework diffing.
    const frag = document.createDocumentFragment();
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      const rowEl = document.createElement("div");
      const isAccessory = row.some(
        (k) => k.kind === "action" && (k.id === "emoji" || k.id === "mic"),
      );
      rowEl.className = isAccessory ? "sk-row sk-row-accessory" : "sk-row";
      for (let c = 0; c < row.length; c++) {
        const key = row[c]!;
        if (key.kind === "spacer") {
          if (key.alias || key.actionAlias) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sk-spacer sk-spacer-hit";
            btn.style.flex = String(key.flex ?? 0.5);
            btn.dataset.skRow = String(r);
            btn.dataset.skCol = String(c);
            btn.setAttribute(
              "aria-label",
              key.alias ?? key.actionAlias ?? "spacer",
            );
            bindPress(btn);
            rowEl.appendChild(btn);
          } else {
            const sp = document.createElement("div");
            sp.className = "sk-spacer";
            sp.style.flex = String(key.flex ?? 0.5);
            sp.setAttribute("aria-hidden", "true");
            rowEl.appendChild(sp);
          }
          continue;
        }

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `sk-key${key.className ? ` ${key.className}` : ""}`;
        btn.style.flex = String(key.flex ?? 1);
        btn.dataset.skRow = String(r);
        btn.dataset.skCol = String(c);
        btn.setAttribute(
          "aria-label",
          key.kind === "action" ? key.id : key.label,
        );
        if (key.kind === "char") btn.dataset.skChar = key.value;

        if (
          key.kind === "action" &&
          key.id === "shift" &&
          (layout === "shifted" || shiftLatched)
        ) {
          btn.classList.add("sk-active");
        }
        if (key.kind === "action" && key.id === "mic" && micActive) {
          btn.classList.add("sk-active");
        }

        const label = document.createElement("span");
        label.className = "sk-label";
        label.innerHTML = labelHtml(key);
        btn.appendChild(label);

        bindPress(btn);
        rowEl.appendChild(btn);
      }
      frag.appendChild(rowEl);
    }
    rowsEl.replaceChildren(frag);
    root.classList.toggle("mic-on", micActive);
  };

  render();

  return {
    root,
    setOpen(next) {
      open = next;
      root.hidden = !open;
      root.setAttribute("aria-hidden", open ? "false" : "true");
      if (!open) {
        clearRepeat();
        clearGhost();
      }
    },
    setMicActive(active) {
      if (micActive === active) return;
      micActive = active;
      root.classList.toggle("mic-on", micActive);
      const micBtn = rowsEl.querySelector<HTMLElement>("button.sk-mic");
      if (micBtn) {
        micBtn.classList.toggle("sk-active", micActive);
        const icon = micBtn.querySelector(".sk-mic-icon");
        icon?.classList.toggle("active", micActive);
      }
    },
    setHandlers(next) {
      handlers = { ...handlers, ...next };
    },
    destroy() {
      destroyed = true;
      if (renderRaf) {
        cancelAnimationFrame(renderRaf);
        renderRaf = 0;
      }
      clearRepeat();
      clearGhost();
      root.remove();
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
