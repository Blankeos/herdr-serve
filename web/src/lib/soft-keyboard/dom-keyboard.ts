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
  let micActive = Boolean(opts.micActive);
  let open = false;

  let repeatTimer: number | undefined;
  let repeatEvery: number | undefined;
  let renderRaf = 0;
  let renderPending = false;
  let hitCacheRaf = 0;
  let destroyed = false;

  const active = new Map<number, ActivePress>();
  /**
   * Cross-event dedupe (pointer ↔ touch ↔ click).
   * iOS sometimes delivers only one of touchstart / pointerdown / click for a
   * sequential tap — we accept whichever arrives first and ignore duplicates.
   */
  let lastBeginX = 0;
  let lastBeginY = 0;
  let lastBeginAt = 0;
  let lastCommitKey: SoftKeyDef | null = null;
  let lastCommitAt = 0;
  let lastCommitX = 0;
  let lastCommitY = 0;
  let lastTouchEndX = 0;
  let lastTouchEndY = 0;
  let lastTouchEndAt = 0;
  let hitCache: KeyHit[] = [];
  let hitCacheAt = 0;
  let nextSyntheticId = -1;

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
    if (active.size > 0) return;
    if (renderRaf) return;
    renderRaf = window.requestAnimationFrame(() => {
      renderRaf = 0;
      if (destroyed || active.size > 0) return;
      if (renderPending) render();
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
        afterChar();
      }
      return;
    }
    if (key.kind === "char") {
      handlers.onInsert(key.value);
      afterChar();
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

  /** True if another event stream already began a press at roughly this point. */
  const recentlyBeganNear = (x: number, y: number): boolean => {
    const dt = performance.now() - lastBeginAt;
    // iOS pointer/touch twins can arrive 40–80ms apart on fast taps.
    if (dt < 0 || dt > 90) return false;
    const dx = x - lastBeginX;
    const dy = y - lastBeginY;
    return dx * dx + dy * dy < 36 * 36;
  };

  /** Start tracking a finger — highlight only (except backspace). */
  const beginPress = (id: number, el: HTMLElement, x: number, y: number) => {
    if (active.has(id)) return;
    // Same physical tap arriving via a second event type (touch + pointer).
    if (recentlyBeganNear(x, y)) return;
    // Already tracking this tap under a different id — don't start a twin.
    if (findActiveNear(x, y) !== null) return;

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
    lastBeginX = x;
    lastBeginY = y;
    lastBeginAt = performance.now();

    if (backspace) {
      handlers.onBackspace();
      // Stamp as committed NOW — backspace fires on press, not release.
      // Without this, touchend recovery thinks the tap was missed → double ⌫.
      lastCommitKey = key;
      lastCommitAt = performance.now();
      lastCommitX = x;
      lastCommitY = y;
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
      lastCommitKey = key;
      lastCommitAt = performance.now();
      lastCommitX = x;
      lastCommitY = y;
      if (active.size === 1) armBackspaceRepeat();
    }
  };

  /** Same physical tap already committed nearby (pointer+touch double fire). */
  const recentlyCommittedNear = (x: number, y: number, windowMs = 120): boolean => {
    const dt = performance.now() - lastCommitAt;
    if (dt < 0 || dt > windowMs) return false;
    const dx = x - lastCommitX;
    const dy = y - lastCommitY;
    return dx * dx + dy * dy < 36 * 36;
  };

  const endPress = (id: number, commit: boolean, x?: number, y?: number) => {
    const press = active.get(id);
    if (!press) return;
    active.delete(id);

    clearVisual(press);

    if (commit && !press.cancelled) {
      const key = press.lastGoodKey ?? press.key;
      const cx = x ?? lastBeginX;
      const cy = y ?? lastBeginY;
      // Position-based dedupe — NOT key identity. After ⇧, the same physical
      // tap can resolve as C then c once shift unlatches; key-id dedupe fails.
      if (!recentlyCommittedNear(cx, cy)) {
        commitKey(key);
        lastCommitKey = key;
        lastCommitAt = performance.now();
        lastCommitX = cx;
        lastCommitY = cy;
      }
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

  /** Ghost click from previous touchend — same spot, shortly after. */
  const isGhostFromPrevKey = (x: number, y: number): boolean => {
    const dt = performance.now() - lastTouchEndAt;
    if (dt < 0 || dt > 350) return false;
    const dx = x - lastTouchEndX;
    const dy = y - lastTouchEndY;
    return dx * dx + dy * dy < 22 * 22;
  };

  /**
   * Find an active press near (x,y) — used so pointerup can end a press that
   * began as touchstart (different id spaces) and vice versa.
   */
  const findActiveNear = (x: number, y: number): number | null => {
    let bestId: number | null = null;
    let best = Infinity;
    for (const [id, press] of active) {
      const r = press.el.getBoundingClientRect();
      const cx = (r.left + r.right) * 0.5;
      const cy = (r.top + r.bottom) * 0.5;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < best) {
        best = d;
        bestId = id;
      }
    }
    return best < 60 * 60 ? bestId : null;
  };

  const onTouchStart = (ev: TouchEvent) => {
    // No preventDefault on touchstart — sequential tap reliability.
    // touch-action:none on keys blocks scroll. Still PD on move.
    if (!hitCache.length) rebuildHitCache();

    for (let i = 0; i < ev.changedTouches.length; i++) {
      const t = ev.changedTouches[i]!;
      // Already handled by pointerdown for this physical tap.
      if (recentlyBeganNear(t.clientX, t.clientY)) continue;
      if (recentlyCommittedNear(t.clientX, t.clientY)) continue;
      const el = hitKeyEl(t.clientX, t.clientY);
      if (el) beginPress(t.identifier, el, t.clientX, t.clientY);
    }
  };

  const onTouchMove = (ev: TouchEvent) => {
    if (ev.cancelable) ev.preventDefault();
    for (let i = 0; i < ev.changedTouches.length; i++) {
      const t = ev.changedTouches[i]!;
      const id = active.has(t.identifier)
        ? t.identifier
        : findActiveNear(t.clientX, t.clientY);
      if (id !== null) movePress(id, t.clientX, t.clientY);
    }
  };

  const onTouchEnd = (ev: TouchEvent) => {
    // No preventDefault — sequential tap reliability.
    for (let i = 0; i < ev.changedTouches.length; i++) {
      const t = ev.changedTouches[i]!;
      lastTouchEndX = t.clientX;
      lastTouchEndY = t.clientY;
      lastTouchEndAt = performance.now();

      const id: number | null = active.has(t.identifier)
        ? t.identifier
        : findActiveNear(t.clientX, t.clientY);

      if (id === null) {
        // Recovery ONLY if nothing already committed this physical tap.
        // Dual pointer+touch was producing Cc / double-⌫ via this path.
        if (recentlyCommittedNear(t.clientX, t.clientY)) continue;
        if (recentlyBeganNear(t.clientX, t.clientY)) continue;
        const el = hitKeyEl(t.clientX, t.clientY);
        if (el) {
          beginPress(t.identifier, el, t.clientX, t.clientY);
          endPress(t.identifier, true, t.clientX, t.clientY);
        }
        continue;
      }
      movePress(id, t.clientX, t.clientY, { allowCancel: false });
      endPress(id, true, t.clientX, t.clientY);
    }
  };

  const onPointerDown = (ev: PointerEvent) => {
    // Accept all pointerTypes; beginPress / recentlyBeganNear dedupe vs touch.
    if (isGhostFromPrevKey(ev.clientX, ev.clientY) && active.size === 0) {
      if (ev.cancelable) ev.preventDefault();
      return;
    }
    if (recentlyCommittedNear(ev.clientX, ev.clientY)) {
      if (ev.cancelable) ev.preventDefault();
      return;
    }
    if (!hitCache.length) rebuildHitCache();
    const el = hitKeyEl(ev.clientX, ev.clientY);
    if (el) beginPress(ev.pointerId, el, ev.clientX, ev.clientY);
  };

  const onPointerMove = (ev: PointerEvent) => {
    const id = active.has(ev.pointerId)
      ? ev.pointerId
      : findActiveNear(ev.clientX, ev.clientY);
    if (id === null) return;
    if (ev.cancelable) ev.preventDefault();
    movePress(id, ev.clientX, ev.clientY);
  };

  const onPointerEnd = (ev: PointerEvent) => {
    const id = active.has(ev.pointerId)
      ? ev.pointerId
      : findActiveNear(ev.clientX, ev.clientY);
    if (id === null) return;
    movePress(id, ev.clientX, ev.clientY, { allowCancel: false });
    endPress(id, true, ev.clientX, ev.clientY);
  };

  /**
   * Last-resort: iOS sometimes delivers only a click for a sequential tap
   * when touchstart was dropped.
   */
  const onClick = (ev: MouseEvent) => {
    if (isGhostFromPrevKey(ev.clientX, ev.clientY)) {
      ev.preventDefault();
      return;
    }
    if (findActiveNear(ev.clientX, ev.clientY) !== null) return;
    if (recentlyBeganNear(ev.clientX, ev.clientY)) return;
    if (recentlyCommittedNear(ev.clientX, ev.clientY, 200)) {
      ev.preventDefault();
      return;
    }

    if (!hitCache.length) rebuildHitCache();
    const el = hitKeyEl(ev.clientX, ev.clientY);
    if (!el) return;
    const id = nextSyntheticId--;
    beginPress(id, el, ev.clientX, ev.clientY);
    endPress(id, true, ev.clientX, ev.clientY);
    ev.preventDefault();
  };

  const touchOpts: AddEventListenerOptions = { passive: false, capture: true };
  root.addEventListener("touchstart", onTouchStart, touchOpts);
  root.addEventListener("touchmove", onTouchMove, touchOpts);
  root.addEventListener("touchend", onTouchEnd, touchOpts);
  root.addEventListener("touchcancel", onTouchEnd, touchOpts);
  root.addEventListener("pointerdown", onPointerDown, { capture: true });
  root.addEventListener("pointermove", onPointerMove, { capture: true });
  root.addEventListener("pointerup", onPointerEnd, { capture: true });
  root.addEventListener("pointercancel", onPointerEnd, { capture: true });
  root.addEventListener("click", onClick, { capture: true });

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
        rowEl.appendChild(btn);
      }
      frag.appendChild(rowEl);
    }
    rowsEl.replaceChildren(frag);
    root.classList.toggle("mic-on", micActive);
    scheduleHitCache();
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
      } else {
        scheduleHitCache();
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
