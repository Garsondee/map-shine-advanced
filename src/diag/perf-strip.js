/**
 * perf-strip.js — the always-on performance/VRAM strip at the top of the
 * control panel (docs/planning/Keyhole.md Track 3 item 8, "VRAM headroom
 * tripwire"). Folded in from boot.js's old standalone bottom-right HUD
 * 2026-08-05, author's brief: it belongs "inside the main panel, at the top,"
 * concise, collapsible to just FPS, and framed as a WARNING STATION — FPS and
 * VRAM read as health bars (how much of the display's own refresh rate is
 * actually landing, how much VRAM headroom is left before the device-loss
 * wall), not raw numbers the author has to interpret.
 *
 * Split the same way perf-hud.js is: `buildPerfStripModel` is pure
 * arithmetic (Node-tested below), `createPerfStrip` is the DOM half
 * (browser-verified only, CONVENTIONS.md §4 — don't fake a DOM to force a
 * Node test).
 *
 * @module diag/perf-strip
 */

const MB = 1024 * 1024;

/** @param {number} v @returns {number|null} */
function clamp01(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
}

// The SAME tripwire thresholds vram-inventory.js already uses for its own
// verdict (<15% headroom = critical, <30% = tight) — shared by every bar here
// that guards a HARD CEILING (VRAM against the device-loss wall, JS heap
// against OOM): cross it and the session crashes, so headroom can stay
// generous right up until it doesn't.
export const HEALTH_WARN_RATIO = 0.3;
export const HEALTH_CRITICAL_RATIO = 0.15;

// FPS has no crash wall to guard — it degrades smoothly, and people FEEL a
// frame-rate deficit long before it reaches VRAM-critical proportions. 38 of
// 60fps (the screenshot this strip replaced) is a genuinely rough-feeling 37%
// deficit; grading it on the 15/30% ceiling-headroom scale above would still
// paint it green. So FPS gets its own, stricter perceptual thresholds.
export const FPS_WARN_RATIO = 0.85;
export const FPS_CRITICAL_RATIO = 0.6;

/**
 * @param {number|null} ratio - 0..1, HIGHER is healthier (headroom/rate
 *   remaining, never raw usage) — every caller below normalizes to that
 *   direction before this is called.
 * @param {{warn?:number, critical?:number}} [thresholds] - defaults to the
 *   hard-ceiling pair; pass FPS_WARN_RATIO/FPS_CRITICAL_RATIO for the FPS bar.
 */
export function healthLevel(ratio, { warn = HEALTH_WARN_RATIO, critical = HEALTH_CRITICAL_RATIO } = {}) {
  if (!Number.isFinite(ratio)) return 'unknown';
  if (ratio < critical) return 'critical';
  if (ratio < warn) return 'warn';
  return 'ok';
}

// Browsers expose no monitor-refresh-rate API. The standard proxy — used by
// boot.js's heartbeat loop to compute `bestGapMs` — is the smallest frame gap
// ever observed on an otherwise-trivial render loop: it only takes ONE
// uncongested frame, ever, to see it. Snapped to the nearest common rate so a
// noisy 143.6Hz reading displays as the 144Hz it almost certainly is; outside
// that tolerance the raw (rounded) measurement is trusted rather than forced
// onto the wrong shelf — an unusual display should not get silently mislabeled.
const COMMON_REFRESH_HZ = [30, 60, 75, 90, 120, 144, 165, 175, 180, 200, 240, 360];
export function snapRefreshHz(measuredHz) {
  if (!Number.isFinite(measuredHz) || measuredHz <= 0) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const hz of COMMON_REFRESH_HZ) {
    const delta = Math.abs(hz - measuredHz);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = hz;
    }
  }
  return bestDelta / best < 0.04 ? best : Math.round(measuredHz);
}

/** @param {number} n @returns {string} "812", "1.2K", "3.4M" — glanceable, never a wall of digits. */
export function formatCount(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

function fmtNum(v, dp = 0) {
  return Number.isFinite(v) ? v.toFixed(dp) : '—';
}
function fmtMb(v) {
  return Number.isFinite(v) ? `${Math.round(v)}MB` : '—';
}

/**
 * FPS bar model. `bestGapMs` is the all-time-minimum frame gap the heartbeat
 * loop has observed — see boot.js's own doc for why minimum-not-average is
 * the honest refresh-rate proxy. `recentWorstMs` (the current rolling
 * window's own worst gap) drives the separate hitch flag: the bar shows
 * ongoing health, the hitch flag calls out a recent spike the average alone
 * would smooth away.
 */
function buildFpsBar({ fps, bestGapMs, recentWorstMs, hitchThresholdMs = 50 } = {}) {
  const refreshHz = Number.isFinite(bestGapMs) && bestGapMs > 0 ? snapRefreshHz(1000 / bestGapMs) : null;
  const ratio = refreshHz ? clamp01(fps / refreshHz) : null;
  const hitching = Number.isFinite(recentWorstMs) && recentWorstMs > hitchThresholdMs;
  return {
    ratio,
    level: healthLevel(ratio, { warn: FPS_WARN_RATIO, critical: FPS_CRITICAL_RATIO }),
    valueText: refreshHz ? `${fmtNum(fps)}/${refreshHz}fps` : `${fmtNum(fps)}fps`,
    hitching,
    hitchText: hitching ? `hitch ${fmtNum(recentWorstMs)}ms` : null,
  };
}

/**
 * VRAM bar model, straight off vram-inventory.js's own `headroomFraction`/
 * `verdict` — no thresholds re-derived here, this only reshapes it for the bar.
 */
function buildVramBar(vram) {
  const ratio = clamp01(vram?.headroomFraction ?? null);
  const level =
    vram?.verdict === 'critical'
      ? 'critical'
      : vram?.verdict === 'tight'
        ? 'warn'
        : vram?.verdict === 'ok'
          ? 'ok'
          : 'unknown';
  return {
    ratio,
    level,
    valueText: Number.isFinite(vram?.estimatedTotalMb)
      ? `${fmtMb(vram.estimatedTotalMb)}/${fmtMb(vram.ceilingMb)}`
      : '—',
    labelText: vram?.verdict ?? 'unknown',
  };
}

/**
 * JS heap bar model — Chrome-only (`performance.memory`). Returns `null`
 * (genuinely absent, not "unknown") when the API doesn't exist, so the strip
 * can omit the row entirely rather than show a permanently-empty bar.
 */
function buildHeapBar({ heapUsedBytes, heapLimitBytes } = {}) {
  if (!Number.isFinite(heapUsedBytes) || !Number.isFinite(heapLimitBytes) || heapLimitBytes <= 0) return null;
  const ratio = clamp01(1 - heapUsedBytes / heapLimitBytes);
  return { ratio, level: healthLevel(ratio), valueText: `${fmtMb(heapUsedBytes / MB)}/${fmtMb(heapLimitBytes / MB)}` };
}

/**
 * The whole strip's view model, from the raw facts boot.js's heartbeat loop
 * gathers each tick. Pure — every threshold and format lives here so it has
 * exactly one Node-tested home (CONVENTIONS.md §4), and the DOM half below
 * only paints whatever this returns.
 *
 * @param {object} stats
 * @param {number} stats.fps
 * @param {number} stats.avgGapMs
 * @param {number} stats.recentWorstMs
 * @param {number} stats.allTimeWorstMs
 * @param {number|null} stats.bestGapMs
 * @param {object|null} stats.vt - getVtPanViewerDiagnostics() result
 * @param {object|null} stats.vram - buildVramInventory() result
 * @param {number|null} stats.heapUsedBytes
 * @param {number|null} stats.heapLimitBytes
 * @param {{drawCalls:number,triangles:number}|null} stats.renderInfo
 * @param {string} [stats.backend] - 'webgpu' | 'webgl2' | 'unknown'
 * @param {string} [stats.version]
 */
export function buildPerfStripModel(stats = {}) {
  const fps = buildFpsBar(stats);
  const vram = buildVramBar(stats.vram);
  const heap = buildHeapBar(stats);

  const detailLines = [
    `frame ${fmtNum(stats.avgGapMs, 1)}ms avg · worst ${fmtNum(stats.recentWorstMs)}ms · all-time ${fmtNum(stats.allTimeWorstMs)}ms`,
  ];
  if (stats.vt?.active) {
    const c = stats.vt.cacheStats ?? {};
    detailLines.push(
      `VT ${stats.vt.renderMode ?? '?'} · ${stats.vt.itemsLoaded ?? 0} items · mip ${stats.vt.mip?.requested ?? '?'}`,
      `pages ${c.residentPages ?? '?'}/${c.capacityPages ?? '?'} · miss ${c.misses ?? 0} · evict ${c.evictions ?? 0}`
    );
  } else {
    detailLines.push('VT: not running');
  }
  if (stats.renderInfo) {
    detailLines.push(
      `draw calls ${formatCount(stats.renderInfo.drawCalls)} · tris ${formatCount(stats.renderInfo.triangles)}`
    );
  }

  // Silent 99% of the time — a WARNING STATION says nothing while healthy and
  // speaks up only when something's actually degraded, per the author's own
  // "too fussy > too lenient" posture applied in reverse: routine facts (the
  // Three version, "WebGPU" when it's just... running) stay off-screen, but a
  // silent fallback to WebGL2 is exactly the kind of quiet degradation this
  // strip exists to surface.
  const warnings = [];
  if (stats.backend && stats.backend !== 'webgpu') {
    warnings.push(
      `⚠ ${stats.backend === 'webgl2' ? 'WebGL2 fallback' : 'unknown renderer backend'} — WebGPU is unavailable`
    );
  }

  return { fps, vram, heap, detailLines, warnings, versionText: stats.version ? `v${stats.version}` : null };
}

// ============================================================================
// THE DOM HALF — browser-only, verified live (CONVENTIONS.md §4)
// ============================================================================

const LEVEL_COLOR = { ok: '#8fe3a8', warn: '#ffc478', critical: '#ffb4b4', unknown: '#7f97ba' };

/** One labelled health bar: a short caption, a fill track, a value readout — all three tinted by level. */
function makeBar(labelText) {
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px' });

  const label = document.createElement('span');
  label.textContent = labelText;
  Object.assign(label.style, {
    fontSize: '9px',
    letterSpacing: '0.5px',
    color: '#7f97ba',
    fontWeight: '600',
    width: '28px',
    flex: 'none',
  });

  const track = document.createElement('div');
  Object.assign(track.style, {
    flex: '1',
    minWidth: '50px',
    height: '7px',
    background: 'rgba(10,14,22,0.7)',
    borderRadius: '4px',
    overflow: 'hidden',
    border: '1px solid rgba(143,214,255,0.14)',
  });
  const fill = document.createElement('div');
  Object.assign(fill.style, {
    height: '100%',
    width: '0%',
    background: LEVEL_COLOR.unknown,
    transition: 'width .2s ease, background-color .2s ease',
  });
  track.appendChild(fill);

  const value = document.createElement('span');
  Object.assign(value.style, {
    fontSize: '11px',
    fontWeight: '700',
    minWidth: '88px',
    textAlign: 'right',
    flex: 'none',
    color: LEVEL_COLOR.unknown,
  });

  row.append(label, track, value);

  return {
    el: row,
    /** @param {{ratio:number|null, level:string, valueText:string}} bar */
    set(bar) {
      const color = LEVEL_COLOR[bar?.level] ?? LEVEL_COLOR.unknown;
      const ratio = Number.isFinite(bar?.ratio) ? bar.ratio : 0;
      fill.style.width = `${ratio * 100}%`;
      fill.style.background = color;
      value.style.color = color;
      value.textContent = bar?.valueText ?? '—';
    },
  };
}

/**
 * Build the strip. Returns `{ el, update(stats) }` — `el` mounts once, at the
 * top of the control panel (above the zone rail, so it renders regardless of
 * which zone is active and survives the panel's own Minimize, which only
 * hides the rail+body row below it); `update` is called every ~250ms from
 * boot.js's heartbeat loop with the same raw-stats shape `buildPerfStripModel`
 * documents.
 *
 * Two rows by default (FPS, VRAM) — "nearly zero space" per the author's
 * brief — with a chevron that opens a detail block for everything else
 * (JS heap, frame-gap breakdown, VT atlas/page-cache, draw calls, a fallback-
 * backend warning). Starts collapsed, same default the old "▾ more" door had.
 */
export function createPerfStrip() {
  const root = document.createElement('div');
  root.id = 'msa-perf-strip';
  Object.assign(root.style, {
    padding: '8px 10px',
    borderBottom: '1px solid rgba(143,214,255,0.16)',
    fontFamily: 'ui-monospace, Consolas, monospace',
  });

  const barsCol = document.createElement('div');
  Object.assign(barsCol.style, { flex: '1', display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '0' });

  const fpsBar = makeBar('FPS');
  const vramBar = makeBar('VRAM');
  barsCol.append(fpsBar.el, vramBar.el);

  const hitchBadge = document.createElement('span');
  Object.assign(hitchBadge.style, { fontSize: '9px', color: LEVEL_COLOR.critical, display: 'none' });
  fpsBar.el.appendChild(hitchBadge);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = '▾';
  toggle.title = 'More performance detail';
  Object.assign(toggle.style, {
    pointerEvents: 'auto',
    alignSelf: 'center',
    background: 'transparent',
    border: 'none',
    color: '#8fd6ff',
    opacity: '0.7',
    cursor: 'pointer',
    fontSize: '12px',
    padding: '0 2px',
  });

  const topRow = document.createElement('div');
  Object.assign(topRow.style, { display: 'flex', alignItems: 'stretch', gap: '6px' });
  topRow.append(barsCol, toggle);

  // Rare, so it costs no space while nothing's wrong (see buildPerfStripModel's
  // own comment on why this stays silent by default).
  const warnRow = document.createElement('div');
  Object.assign(warnRow.style, { fontSize: '10px', color: LEVEL_COLOR.critical, marginTop: '3px', display: 'none' });

  const detail = document.createElement('div');
  Object.assign(detail.style, {
    marginTop: '5px',
    paddingTop: '5px',
    borderTop: '1px solid rgba(143,214,255,0.10)',
    fontSize: '10px',
    lineHeight: '1.5',
    opacity: '0.85',
    display: 'none',
  });

  // THE PERFORMANCE CENTER — every profiling tool (boot.js's registerAction/
  // registerReport/registerPanel entries declaring `{ zone: 'performance' }`,
  // routed here by debug-panel.js's renderPerformanceCenter) lands in this one
  // box. It is the whole reason `detail` is "allowed to grow a lot bigger when
  // extended" (author, 2026-08-06) rather than staying a few text lines: a
  // sweep result table or a tier-comparison ranking is real content, not
  // clutter, and it has nowhere else to go now that the Lab's scattered
  // buttons and the two floating overlays (perf-lab.js, perf-hud.js) are gone.
  // Bounded + scrollable rather than truly unbounded — a report can be long,
  // and letting it push the whole panel off the top of a screen anchored by
  // `bottom` (boot.js's heartbeat host) would be a worse trade than a scrollbar.
  const toolsHead = document.createElement('div');
  Object.assign(toolsHead.style, {
    fontSize: '9px',
    letterSpacing: '1.4px',
    textTransform: 'uppercase',
    color: '#7f97ba',
    fontWeight: '600',
    margin: '2px 0 4px',
  });
  toolsHead.textContent = 'Performance center';
  const toolsWrap = document.createElement('div');
  Object.assign(toolsWrap.style, { maxHeight: '55vh', overflowY: 'auto', paddingRight: '2px' });
  const toolsSection = document.createElement('div');
  Object.assign(toolsSection.style, {
    marginBottom: '8px',
    paddingBottom: '8px',
    borderBottom: '1px solid rgba(143,214,255,0.10)',
  });
  toolsSection.append(toolsHead, toolsWrap);

  const heapBarWrap = document.createElement('div');
  heapBarWrap.style.marginBottom = '4px';
  const heapBar = makeBar('HEAP');
  heapBarWrap.appendChild(heapBar.el);
  const detailText = document.createElement('div');
  detail.append(toolsSection, heapBarWrap, detailText);

  root.append(topRow, warnRow, detail);

  let expanded = false;
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    detail.style.display = expanded ? 'block' : 'none';
    toggle.textContent = expanded ? '▴' : '▾';
  });
  // The header's own drag handle sits right above this; without this a click on
  // the toggle could be swallowed the same way headerBtn's pointerdown guards
  // against it (debug-panel.js) — cheap insurance even though this strip isn't
  // itself a drag handle.
  toggle.addEventListener('pointerdown', (e) => e.stopPropagation());

  function update(stats) {
    const model = buildPerfStripModel(stats);
    fpsBar.set(model.fps);
    vramBar.set(model.vram);
    hitchBadge.style.display = model.fps.hitching ? 'inline' : 'none';
    hitchBadge.textContent = model.fps.hitchText ? `⚠ ${model.fps.hitchText}` : '';

    if (model.heap) {
      heapBarWrap.style.display = 'block';
      heapBar.set(model.heap);
    } else {
      heapBarWrap.style.display = 'none';
    }

    detailText.innerHTML = [...model.detailLines, model.versionText].filter(Boolean).join('<br>');

    if (model.warnings.length) {
      warnRow.style.display = 'block';
      warnRow.innerHTML = model.warnings.join('<br>');
    } else {
      warnRow.style.display = 'none';
    }
  }

  /**
   * Mount the Performance Center's live DOM — rebuilt and handed over fresh by
   * debug-panel.js's `renderPerformanceCenter` on every registration/refresh,
   * same contract `bodyEl` already has for a rail zone. Replaces the previous
   * contents wholesale; nothing here diffs against the old tree because
   * nothing here is expensive enough to need it (a handful of buttons + at
   * most two small embedded panels).
   * @param {HTMLElement} el
   */
  function setTools(el) {
    toolsWrap.replaceChildren(el);
  }

  return { el: root, update, setTools };
}
