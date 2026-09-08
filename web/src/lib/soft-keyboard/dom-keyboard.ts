import {
  BACKSPACE_FILL,
  BACKSPACE_OUTLINE,
  CAPS_FILL,
  EMOJI,
  MIC,
  SHIFT_FILL,
  SHIFT_OUTLINE,
} from "./icons";
import { isAutoReturnPunct, layoutRows } from "./layouts";
import type {
  SoftKeyDef,
  SoftKeyId,
  SoftKeyboardHandlers,
  SoftKeyboardLayout,
} from "./types";

const REPEAT_DELAY_MS = 420;
const REPEAT_EVERY_MS = 55;
/** Second ⇧ tap within this window enables caps; a slower re-tap dismisses shift. */
const SHIFT_DOUBLE_TAP_MS = 350;

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

type ActivePress = {
  el: HTMLElement;
  key: SoftKeyDef;
  ghost: HTMLElement | null;
  /** Backspace already fired its initial delete for this finger. */
  backspaceArmed: boolean;
  /** Finger slid off the keyboard — release commits nothing. */
  cancelled: boolean;
  /** Last key we successfully highlighted — used if touchend jitters off-key. */
  lastGoodKey: SoftKeyDef;
  lastGoodEl: HTMLElement;
};

type KeyHit = {
  el: HTMLElement;
  row: number;
  col: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

/**
 * Pure-DOM iOS soft keyboard — Apple slide-to-select feel.
 *
 * Letter / mod keys:
 *   touchstart → highlight only
 *   touchmove  → highlight follows thumb (c→v, j→k)
 *   touchend   → commit the key under the finger
 *
 * Backspace is the exception (Apple-like):
 *   fires on press + hold-repeat while finger stays on ⌫
 *   sliding off cancels repeat; releasing on another key commits that key
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
  let lastShiftTapAt = 0;
  let micActive = Boolean(opts.micActive);
  let open = false;

  let repeatTimer: number | undefined;
  let repeatEvery: number | undefined;
  let renderRaf = 0;
  let renderPending = false;
  let hitCacheRaf = 0;
  let destroyed = false;

  const active = new Map<number, ActivePress>();
  // Never mix pointer and touch ID spaces or dedupe by time/distance.
  const usePointerEvents = typeof window.PointerEvent === "function";
  let hitCache: KeyHit[] = [];
  let hitCacheAt = 0;

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

  const setBackspaceIcon = (el: HTMLElement, filled: boolean) => {
    const label = el.querySelector(".sk-label");
    if (label) label.innerHTML = filled ? BACKSPACE_FILL : BACKSPACE_OUTLINE;
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

  const findActionButton = (id: SoftKeyId): HTMLElement | null => {
    const cls = id === "backspace" ? "sk-backspace" : `sk-${id}`;
    return rowsEl.querySelector<HTMLElement>(`button.${cls}`);
  };

  const isBackspaceKey = (key: SoftKeyDef): boolean =>
    (key.kind === "action" && key.id === "backspace") ||
    (key.kind === "spacer" && key.actionAlias === "backspace");

  const rebuildHitCache = () => {
    if (destroyed || root.hidden) {
      hitCache = [];
      return;
    }
    const nodes = rowsEl.querySelectorAll<HTMLElement>(
      "button.sk-key, button.sk-spacer-hit",
    );
    const next: KeyHit[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i]!;
      const row = Number(el.dataset.skRow);
      const col = Number(el.dataset.skCol);
      if (!Number.isFinite(row) || !Number.isFinite(col)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      next.push({
        el,
        row,
        col,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      });
    }
    hitCache = next;
    hitCacheAt = performance.now();
  };

  const scheduleHitCache = () => {
    if (hitCacheRaf || destroyed) return;
    hitCacheRaf = window.requestAnimationFrame(() => {
      hitCacheRaf = 0;
      rebuildHitCache();
    });
  };

  const scheduleRender = () => {
    if (destroyed) return;
    renderPending = true;
    // Defer while a finger is down so slide-to-type never swaps under the thumb.
    if (active.size > 0) return;
    // Idle: render synchronously for native-instant layer switches.
    // rAF-only rendering left a one-frame window where fast sequential taps
    // hit-tested against the previous layer's rects (123 → ABC double-type).
    render();
  };

  /**
   * Native post-insert layer policy.
   * - Shifted one-shot (not caps) always unlatches to letters.
   * - Numbers/symbols auto-return to ABC only for iOS punct set
   *   (".", ",", "?", "!", "'") — e.g. 123 → ' → ABC to keep typing words.
   *   Digits, "-/:;()$&@\"", "[ ]{ }#%^ *+= _\|~<>€£¥•", space, and return
   *   stay on their layer.
   */
  const afterCharInsert = (value: string) => {
    if (layout === "shifted" && !shiftLatched) {
      layout = "letters";
      scheduleRender();
      return;
    }
    if (
      (layout === "numbers" || layout === "symbols") &&
      isAutoReturnPunct(value)
    ) {
      shiftLatched = false;
      layout = "letters";
      scheduleRender();
    }
  };

  const keyAt = (row: number, col: number): SoftKeyDef | null => {
    const rows = layoutRows(layout);
    return rows[row]?.[col] ?? null;
  };

  const runAction = (id: SoftKeyId) => {
    switch (id) {
      case "space":
        handlers.onInsert(" ");
        afterCharInsert(" ");
        break;
      case "return":
        handlers.onReturn();
        break;
      case "backspace":
        handlers.onBackspace();
        break;
      case "shift":
        {
          const now = performance.now();
          const doubleTap = now - lastShiftTapAt < SHIFT_DOUBLE_TAP_MS;
          lastShiftTapAt = now;
          if (layout === "shifted") {
            if (shiftLatched) {
              // Caps on → tap turns caps off.
              shiftLatched = false;
              layout = "letters";
            } else if (doubleTap) {
              // Fast re-tap while shifted → caps lock (stays shifted).
              shiftLatched = true;
            } else {
              // Slow re-tap while shifted → dismiss shift (native).
              shiftLatched = false;
              layout = "letters";
            }
          } else if (layout === "letters") {
            shiftLatched = false;
            layout = "shifted";
          } else {
            // No ⇧ key on 123/#+= layers; ignore stray shift actions.
            break;
          }
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

  /** Commit the key under the finger (touchend). */
  const commitKey = (key: SoftKeyDef) => {
    if (key.kind === "spacer") {
      if (key.actionAlias) {
        // Backspace already fired on press — don't double-delete on release.
        if (key.actionAlias === "backspace") return;
        runAction(key.actionAlias);
        return;
      }
      if (key.alias) {
        const ch =
          layout === "shifted" ? key.alias.toUpperCase() : key.alias.toLowerCase();
        handlers.onInsert(ch);
        afterCharInsert(ch);
      }
      return;
    }
    if (key.kind === "char") {
      handlers.onInsert(key.value);
      afterCharInsert(key.value);
      return;
    }
    if (key.id === "backspace") return; // already handled on press
    runAction(key.id);
  };

  /** Spatial hit-test against cached key rects. Nearest-center fallback. */
  const hitKeyEl = (x: number, y: number, softPad = 28): HTMLElement | null => {
    if (!hitCache.length || performance.now() - hitCacheAt > 2000) {
      rebuildHitCache();
    }

    let inside: KeyHit | null = null;
    let nearest: KeyHit | null = null;
    let nearestDist = Infinity;

    for (let i = 0; i < hitCache.length; i++) {
      const h = hitCache[i]!;
      if (x >= h.left && x < h.right && y >= h.top && y < h.bottom) {
        inside = h;
        break;
      }
      const cx = (h.left + h.right) * 0.5;
      const cy = (h.top + h.bottom) * 0.5;
      const dx = x - cx;
      const dy = y - cy;
      const d = dx * dx + dy * dy;
      if (d < nearestDist) {
        nearestDist = d;
        nearest = h;
      }
    }

    if (inside) return inside.el;

    if (nearest && softPad > 0) {
      if (
        x >= nearest.left - softPad &&
        x <= nearest.right + softPad &&
        y >= nearest.top - softPad &&
        y <= nearest.bottom + softPad
      ) {
        return nearest.el;
      }
    }
    return null;
  };

  const clearVisual = (press: ActivePress) => {
    press.el.classList.remove("sk-pressed");
    if (press.el.classList.contains("sk-backspace")) setBackspaceIcon(press.el, false);
    if (press.ghost) {
      press.ghost.classList.remove("sk-pressed");
      if (press.ghost.classList.contains("sk-backspace")) {
        setBackspaceIcon(press.ghost, false);
      }
    }
  };

  const applyVisual = (el: HTMLElement, key: SoftKeyDef): HTMLElement | null => {
    el.classList.add("sk-pressed");
    let ghost: HTMLElement | null = null;
    if (key.kind === "spacer" && key.alias) {
      ghost = findCharButton(key.alias);
      ghost?.classList.add("sk-pressed");
    }
    if (key.kind === "spacer" && key.actionAlias) {
      ghost = findActionButton(key.actionAlias);
      ghost?.classList.add("sk-pressed");
      if (key.actionAlias === "backspace" && ghost) setBackspaceIcon(ghost, true);
    }
    if (key.kind === "action" && key.id === "backspace") {
      setBackspaceIcon(el, true);
    }
    return ghost;
  };

  const armBackspaceRepeat = () => {
    clearRepeat();
    // Initial delete already fired by caller.
    repeatTimer = window.setTimeout(() => {
      repeatEvery = window.setInterval(() => handlers.onBackspace(), REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
  };

  const resolveKey = (el: HTMLElement): SoftKeyDef | null => {
    const row = Number(el.dataset.skRow);
    const col = Number(el.dataset.skCol);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
    return keyAt(row, col);
  };

  /** Track each contact independently, including overlapping adjacent taps. */
  const beginPress = (id: number, el: HTMLElement) => {
    if (active.has(id)) return;
    const key = resolveKey(el);
    if (!key) return;

    const ghost = applyVisual(el, key);
    const backspace = isBackspaceKey(key);
    active.set(id, {
      el,
      key,
      ghost,
      backspaceArmed: backspace,
      cancelled: false,
      lastGoodKey: key,
      lastGoodEl: el,
    });
    if (backspace) {
      handlers.onBackspace();
      if (active.size === 1) armBackspaceRepeat();
    }
  };

  /** Slide highlight to whatever key is under this finger now. */
  const movePress = (
    id: number,
    x: number,
    y: number,
    opts?: { allowCancel?: boolean },
  ) => {
    const press = active.get(id);
    if (!press) return;
    const allowCancel = opts?.allowCancel !== false;

    // During a slide, use a tighter pad so we don't sticky-hop too early.
    const el = hitKeyEl(x, y, 10);
    if (!el) {
      if (!allowCancel) {
        // touchend jitter — keep lastGood highlight/key for commit.
        return;
      }
      // Finger slid off keyboard during move — clear highlight, don't commit.
      clearVisual(press);
      press.cancelled = true;
      press.ghost = null;
      press.backspaceArmed = false;
      clearRepeat();
      return;
    }

    if (el === press.el && !press.cancelled) return; // same key

    const key = resolveKey(el);
    if (!key) return;

    clearVisual(press);
    const ghost = applyVisual(el, key);
    const wasBackspace = press.backspaceArmed;
    const nowBackspace = isBackspaceKey(key);

    press.el = el;
    press.key = key;
    press.ghost = ghost;
    press.cancelled = false;
    press.lastGoodKey = key;
    press.lastGoodEl = el;

    if (wasBackspace && !nowBackspace) {
      clearRepeat();
      press.backspaceArmed = false;
    } else if (!wasBackspace && nowBackspace) {
      // Slid onto backspace — fire once + arm repeat (Apple-ish).
      handlers.onBackspace();
      press.backspaceArmed = true;
      if (active.size === 1) armBackspaceRepeat();
    }
  };

  const endPress = (id: number, commit: boolean) => {
    const press = active.get(id);
    if (!press) return;
    active.delete(id);

    clearVisual(press);

    if (commit && !press.cancelled) {
      commitKey(press.lastGoodKey);
    }

    if (active.size === 0) {
      clearRepeat();
      if (renderPending) scheduleRender();
    } else {
      let anyBs = false;
      for (const p of active.values()) {
        if (p.backspaceArmed) {
          anyBs = true;
          break;
        }
      }
      if (!anyBs) clearRepeat();
    }
  };

  const onTouchStart = (ev: TouchEvent) => {
    if (!open) return;
    if (ev.cancelable) ev.preventDefault();
    for (const t of Array.from(ev.changedTouches)) {
      const el = hitKeyEl(t.clientX, t.clientY);
      if (el) beginPress(t.identifier, el);
    }
  };

  const onTouchMove = (ev: TouchEvent) => {
    if (ev.cancelable) ev.preventDefault();
    for (const t of Array.from(ev.changedTouches)) {
      movePress(t.identifier, t.clientX, t.clientY);
    }
  };

  const onTouchEnd = (ev: TouchEvent) => {
    if (ev.cancelable) ev.preventDefault();
    for (const t of Array.from(ev.changedTouches)) {
      if (ev.type === "touchend") {
        movePress(t.identifier, t.clientX, t.clientY, { allowCancel: false });
      }
      endPress(t.identifier, ev.type === "touchend");
    }
  };

  const onPointerDown = (ev: PointerEvent) => {
    if (!open || ev.button !== 0) return;
    // Avoid focusing buttons/xterm and opening the native keyboard.
    if (ev.cancelable) ev.preventDefault();
    const el = hitKeyEl(ev.clientX, ev.clientY);
    if (!el) return;
    // Capture on the stable root, not keys replaced during layer changes.
    root.setPointerCapture(ev.pointerId);
    beginPress(ev.pointerId, el);
  };

  const onPointerMove = (ev: PointerEvent) => {
    if (!active.has(ev.pointerId)) return;
    if (ev.cancelable) ev.preventDefault();
    movePress(ev.pointerId, ev.clientX, ev.clientY);
  };

  const onPointerEnd = (ev: PointerEvent) => {
    if (!active.has(ev.pointerId)) return;
    const commit = ev.type === "pointerup";
    if (commit) {
      movePress(ev.pointerId, ev.clientX, ev.clientY, { allowCancel: false });
    }
    endPress(ev.pointerId, commit);
    if (root.hasPointerCapture(ev.pointerId)) root.releasePointerCapture(ev.pointerId);
  };

  const onClick = (ev: MouseEvent) => {
    ev.preventDefault();
    // Physical clicks are already handled above. Keep keyboard/AT activation,
    // which has detail=0 and targets a button rather than screen coordinates.
    if (!open || ev.detail !== 0) return;
    const el = (ev.target as Element).closest<HTMLElement>("button[data-sk-row]");
    if (!el || !root.contains(el)) return;
    const key = resolveKey(el);
    if (!key) return;
    if (isBackspaceKey(key)) handlers.onBackspace();
    else commitKey(key);
  };

  const touchOpts: AddEventListenerOptions = { passive: false, capture: true };
  if (usePointerEvents) {
    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("pointermove", onPointerMove, true);
    root.addEventListener("pointerup", onPointerEnd, true);
    root.addEventListener("pointercancel", onPointerEnd, true);
    root.addEventListener("lostpointercapture", onPointerEnd, true);
  } else {
    root.addEventListener("touchstart", onTouchStart, touchOpts);
    root.addEventListener("touchmove", onTouchMove, touchOpts);
    root.addEventListener("touchend", onTouchEnd, touchOpts);
    root.addEventListener("touchcancel", onTouchEnd, touchOpts);
  }
  root.addEventListener("click", onClick, true);

  const onViewport = () => scheduleHitCache();
  window.addEventListener("resize", onViewport);
  window.addEventListener("orientationchange", onViewport);
  window.visualViewport?.addEventListener("resize", onViewport);
  window.visualViewport?.addEventListener("scroll", onViewport);

  const labelHtml = (key: SoftKeyDef): string => {
    if (key.kind === "spacer") return "";
    if (key.kind === "action") {
      switch (key.id) {
        case "shift":
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

  const render = () => {
    if (active.size > 0) {
      renderPending = true;
      return;
    }
    renderPending = false;
    clearRepeat();
    const rows = layoutRows(layout);
    const frag = document.createDocumentFragment();
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      // Percentage slots include key padding, keeping edge keys and gaps
      // identical even when the punctuation row has fewer key faces.
      const weight = (key: SoftKeyDef) => key.flex ?? (key.kind === "spacer" ? 0.5 : 1);
      const totalWeight = row.reduce((sum, key) => sum + weight(key), 0);
      const slotFlex = (key: SoftKeyDef) => `0 0 ${(weight(key) / totalWeight) * 100}%`;
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
            btn.style.flex = slotFlex(key);
            btn.dataset.skRow = String(r);
            btn.dataset.skCol = String(c);
            btn.setAttribute(
              "aria-label",
              key.alias ?? key.actionAlias ?? "spacer",
            );
            rowEl.appendChild(btn);
          } else {
            const sp = document.createElement("div");
            sp.className = "sk-spacer";
            sp.style.flex = slotFlex(key);
            sp.setAttribute("aria-hidden", "true");
            rowEl.appendChild(sp);
          }
          continue;
        }

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `sk-key${key.className ? ` ${key.className}` : ""}`;
        btn.style.flex = slotFlex(key);
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
        rowEl.appendChild(btn);
      }
      frag.appendChild(rowEl);
    }
    rowsEl.replaceChildren(frag);
    root.classList.toggle("mic-on", micActive);
    // Rebuild hit rects synchronously so the next sequential tap (often
    // <16ms later on iOS) hit-tests the fresh layer, not the previous one.
    // rAF-only refresh left 123→ABC fast-typing hitting stale numbers rects.
    if (!root.hidden) rebuildHitCache();
    else hitCache = [];
  };

  render();

  return {
    root,
    setOpen(next) {
      open = next;
      root.hidden = !open;
      root.setAttribute("aria-hidden", open ? "false" : "true");
      if (!open) {
        for (const id of [...active.keys()]) endPress(id, false);
        clearRepeat();
        hitCache = [];
        // Native dismiss clears one-shot shift only; caps (latched) survives.
        if (layout === "shifted" && !shiftLatched) {
          layout = "letters";
          renderPending = true;
        }
        // A dismissed shift gesture never carries into the next session.
        lastShiftTapAt = 0;
      } else {
        // Native open always starts on ABC, never on a stale 123/#+= layer.
        // Preserve letters/shifted/caps as-is; only numbers/symbols reset.
        if (layout === "numbers" || layout === "symbols") {
          layout = "letters";
          shiftLatched = false;
          lastShiftTapAt = 0;
          // Render now (no active presses while closed) so first tap rects
          // are ABC rects, not leftover numbers rects.
          if (active.size === 0) render();
          else renderPending = true;
        }
        if (!renderPending) scheduleHitCache();
      }
    },
    setMicActive(activeMic) {
      if (micActive === activeMic) return;
      micActive = activeMic;
      root.classList.toggle("mic-on", micActive);
      const micBtn = rowsEl.querySelector<HTMLElement>("button.sk-mic");
      if (micBtn) micBtn.classList.toggle("sk-active", micActive);
    },
    setHandlers(next) {
      handlers = { ...handlers, ...next };
    },
    destroy() {
      destroyed = true;
      if (renderRaf) cancelAnimationFrame(renderRaf);
      if (hitCacheRaf) cancelAnimationFrame(hitCacheRaf);
      for (const id of [...active.keys()]) endPress(id, false);
      clearRepeat();
      root.removeEventListener("touchstart", onTouchStart, true);
      root.removeEventListener("touchmove", onTouchMove, true);
      root.removeEventListener("touchend", onTouchEnd, true);
      root.removeEventListener("touchcancel", onTouchEnd, true);
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("pointermove", onPointerMove, true);
      root.removeEventListener("pointerup", onPointerEnd, true);
      root.removeEventListener("pointercancel", onPointerEnd, true);
      root.removeEventListener("lostpointercapture", onPointerEnd, true);
      root.removeEventListener("click", onClick, true);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("orientationchange", onViewport);
      window.visualViewport?.removeEventListener("resize", onViewport);
      window.visualViewport?.removeEventListener("scroll", onViewport);
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
