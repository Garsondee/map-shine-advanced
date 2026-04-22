/**
 * @fileoverview User-facing loading status for V3 shader warmup.
 *
 * A small fixed-position DOM overlay that subscribes to a
 * {@link V3ShaderWarmupCoordinator} and renders the current stage + progress.
 * Two render flavours share one implementation:
 *
 *   - **Toast** (`fast` mode): a compact bottom-left card. Non-blocking;
 *     the scene is already interactive behind it and it fades out when
 *     either `interactive-ready` (no optional stages) or `fully-warm`
 *     is reached.
 *   - **Gated overlay** (`gated` mode): a centered semi-opaque panel. Still
 *     pointer-event transparent (Foundry's HUD stays operable), but
 *     visually occupies the viewport to communicate that interaction is
 *     pending until the bar clears.
 *
 * The overlay never touches the renderer or the scene — it reads entirely
 * from snapshots emitted by {@link V3ShaderWarmupCoordinator#onUpdate}.
 *
 * @module v3/V3LoadingStatusOverlay
 */

/**
 * @typedef {import("./V3ShaderWarmupCoordinator.js").V3WarmupSnapshot} V3WarmupSnapshot
 * @typedef {import("./V3ShaderWarmupCoordinator.js").V3ShaderWarmupCoordinator} V3ShaderWarmupCoordinator
 */

const FADE_OUT_DELAY_MS = 650;
const FADE_OUT_DURATION_MS = 260;

export class V3LoadingStatusOverlay {
  /**
   * @param {{
   *   getCoordinator: () => (V3ShaderWarmupCoordinator | null),
   *   getMode?: () => ("fast" | "gated" | "auto"),
   *   warn?: (...args: any[]) => void,
   * }} deps
   */
  constructor(deps) {
    this._getCoordinator = typeof deps?.getCoordinator === "function"
      ? deps.getCoordinator
      : () => null;
    this._getMode = typeof deps?.getMode === "function"
      ? deps.getMode
      : () => "auto";
    this._warn = typeof deps?.warn === "function" ? deps.warn : () => {};

    /** @type {HTMLElement|null} */ this._root = null;
    /** @type {HTMLElement|null} */ this._bar = null;
    /** @type {HTMLElement|null} */ this._title = null;
    /** @type {HTMLElement|null} */ this._label = null;
    /** @type {HTMLElement|null} */ this._sub = null;
    /** @type {(() => void) | null} */ this._unsub = null;
    /** @type {ReturnType<typeof setTimeout> | null} */ this._fadeTimer = null;
    /** @type {boolean} */ this._mounted = false;
    /** @type {"fast" | "gated"} */ this._activeVariant = "fast";
  }

  /**
   * Attach to the coordinator and insert the DOM node. Idempotent.
   */
  mount() {
    if (this._mounted) return;
    const doc = globalThis.document;
    if (!doc?.body) return;

    const coord = this._getCoordinator();
    if (!coord) return;

    const variant = this._resolveVariant(coord.snapshot());
    this._activeVariant = variant;
    this._root = buildRoot(doc, variant);
    this._title = this._root.querySelector("[data-v3-warmup-title]");
    this._label = this._root.querySelector("[data-v3-warmup-label]");
    this._bar = this._root.querySelector("[data-v3-warmup-bar]");
    this._sub = this._root.querySelector("[data-v3-warmup-sub]");

    doc.body.appendChild(this._root);

    try {
      requestAnimationFrame(() => {
        if (!this._root) return;
        this._root.style.opacity = "1";
        this._root.style.transform = "translateY(0) scale(1)";
      });
    } catch (_) {
      this._root.style.opacity = "1";
    }

    this._unsub = coord.onUpdate((snap) => this._render(snap));
    this._mounted = true;
    this._render(coord.snapshot());
  }

  /**
   * @param {V3WarmupSnapshot} snap
   * @returns {"fast" | "gated"}
   */
  _resolveVariant(snap) {
    const explicit = this._getMode();
    if (explicit === "fast" || explicit === "gated") return explicit;
    return snap.resolvedMode === "gated" ? "gated" : "fast";
  }

  /**
   * @param {V3WarmupSnapshot} snap
   */
  _render(snap) {
    if (!this._root || !snap) return;

    const tierKey = snap.state === "optional" || snap.state === "fully-warm"
      ? "optional"
      : "core";
    const tierProgress = snap.progress[tierKey] ?? snap.progress.core;
    const fraction = snap.state === "fully-warm"
      ? 1
      : Math.max(0, Math.min(1, Number(tierProgress?.fraction ?? 0)));

    if (this._bar) {
      this._bar.style.width = `${Math.round(fraction * 100)}%`;
    }

    if (this._title) {
      this._title.textContent = titleForState(snap.state);
    }

    if (this._label) {
      this._label.textContent = labelForSnapshot(snap);
    }

    if (this._sub) {
      this._sub.textContent = subForSnapshot(snap, tierKey);
    }

    if (isTerminalState(snap.state) && (tierKey === "optional" || snap.progress.optional.total === 0)) {
      this._scheduleFadeOut();
    }
  }

  _scheduleFadeOut() {
    if (this._fadeTimer || !this._root) return;
    this._fadeTimer = setTimeout(() => {
      this._fadeTimer = null;
      if (!this._root) return;
      this._root.style.opacity = "0";
      this._root.style.transform = this._activeVariant === "gated"
        ? "translateY(0) scale(0.98)"
        : "translateY(6px) scale(1)";
      setTimeout(() => this.unmount(), FADE_OUT_DURATION_MS);
    }, FADE_OUT_DELAY_MS);
  }

  /**
   * Detach from the coordinator and remove the DOM node. Safe to call
   * repeatedly.
   */
  unmount() {
    if (this._unsub) {
      try { this._unsub(); } catch (_) {}
      this._unsub = null;
    }
    if (this._fadeTimer) {
      try { clearTimeout(this._fadeTimer); } catch (_) {}
      this._fadeTimer = null;
    }
    if (this._root?.parentElement) {
      try {
        this._root.parentElement.removeChild(this._root);
      } catch (_) {}
    }
    this._root = null;
    this._bar = null;
    this._title = null;
    this._label = null;
    this._sub = null;
    this._mounted = false;
  }
}

/**
 * @param {Document} doc
 * @param {"fast" | "gated"} variant
 * @returns {HTMLElement}
 */
function buildRoot(doc, variant) {
  const root = doc.createElement("div");
  root.className = `v3-warmup-overlay v3-warmup-overlay--${variant}`;
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");

  const base = `
    position: fixed;
    font-family: var(--font-primary, "Signika", "Segoe UI", sans-serif);
    color: #ececec;
    background: rgba(14, 16, 22, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(4px);
    z-index: 1600;
    pointer-events: none;
    opacity: 0;
    transition: opacity 220ms ease, transform 220ms ease;
  `;

  if (variant === "gated") {
    root.style.cssText = `${base}
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%) scale(0.98);
      transform-origin: center;
      min-width: 320px;
      max-width: 440px;
      padding: 18px 22px;
      border-radius: 12px;
      font-size: 13px;
    `;
    // Re-anchor because cssText overwrote transform.
    root.style.transform = "translate(-50%, -50%) scale(0.98)";
  } else {
    root.style.cssText = `${base}
      left: 14px;
      bottom: 14px;
      min-width: 264px;
      max-width: 360px;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 12px;
      transform: translateY(6px) scale(1);
      transform-origin: bottom left;
    `;
  }

  const title = doc.createElement("div");
  title.setAttribute("data-v3-warmup-title", "");
  title.style.cssText = "font-weight:600;letter-spacing:0.02em;margin-bottom:4px;";
  title.textContent = "Map Shine V3";
  root.appendChild(title);

  const label = doc.createElement("div");
  label.setAttribute("data-v3-warmup-label", "");
  label.style.cssText = "opacity:0.88;margin-bottom:8px;min-height:1.15em;";
  label.textContent = "Preparing…";
  root.appendChild(label);

  const barWrap = doc.createElement("div");
  barWrap.style.cssText =
    "height:6px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden;";
  const bar = doc.createElement("div");
  bar.setAttribute("data-v3-warmup-bar", "");
  bar.style.cssText =
    "height:100%;width:0%;background:linear-gradient(90deg,#4fa3ff,#b27bff);transition:width 180ms ease;";
  barWrap.appendChild(bar);
  root.appendChild(barWrap);

  const sub = doc.createElement("div");
  sub.setAttribute("data-v3-warmup-sub", "");
  sub.style.cssText = "margin-top:6px;opacity:0.6;font-size:11px;";
  sub.textContent = "";
  root.appendChild(sub);

  return root;
}

/**
 * @param {V3WarmupSnapshot["state"]} state
 */
function titleForState(state) {
  switch (state) {
    case "loading-resources": return "Map Shine V3 — loading resources";
    case "core": return "Map Shine V3 — warming core shaders";
    case "optional": return "Map Shine V3 — warming effect shaders";
    case "interactive-ready": return "Map Shine V3 — interactive";
    case "fully-warm": return "Map Shine V3 — ready";
    case "cancelled": return "Map Shine V3 — warmup cancelled";
    default: return "Map Shine V3";
  }
}

/**
 * @param {V3WarmupSnapshot} snap
 */
function labelForSnapshot(snap) {
  if (snap.currentStage) return snap.currentStage.label;
  switch (snap.state) {
    case "loading-resources": return "Loading textures and masks…";
    case "interactive-ready":
      return snap.progress.optional.total > 0
        ? "Core pipeline ready — warming effects in background."
        : "Core pipeline ready.";
    case "fully-warm": return "All shader programs compiled.";
    case "core": return "Compiling core shaders…";
    case "optional": return "Compiling optional shaders…";
    case "cancelled": return "Warmup cancelled.";
    default: return "Preparing…";
  }
}

/**
 * @param {V3WarmupSnapshot} snap
 * @param {"core" | "optional"} tierKey
 */
function subForSnapshot(snap, tierKey) {
  const tier = snap.progress[tierKey];
  const tierLabel = tierKey === "optional" ? "Optional effects" : "Core pipeline";
  const parts = [];
  if (tier && tier.total > 0) {
    parts.push(`${tierLabel}: ${tier.done}/${tier.total}`);
  } else {
    parts.push(tierLabel);
  }
  if (Number.isFinite(Number(snap.coreDurationMs))) {
    parts.push(`core ${Math.round(Number(snap.coreDurationMs))}ms`);
  }
  if (snap.state === "fully-warm" && Number.isFinite(Number(snap.fullyWarmDurationMs))) {
    parts.push(`total ${Math.round(Number(snap.fullyWarmDurationMs))}ms`);
  }
  return parts.join(" · ");
}

/**
 * @param {V3WarmupSnapshot["state"]} state
 */
function isTerminalState(state) {
  return state === "fully-warm" || state === "interactive-ready" || state === "cancelled";
}
