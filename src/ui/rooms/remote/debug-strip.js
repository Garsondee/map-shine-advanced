/**
 * ui/rooms/remote/debug-strip.js — THE DEBUG ROW (2026-08-18 fix; author
 * report: "no performance section"). Ported from the mock's own `#debugStrip`
 * ("equipment, not product chrome" — same dashed-border language as the old
 * panel's `.dbg` class). The mock's OWN tooltips already mark HUD/probe/
 * export "(planned)" and label the vram figure "Mock value — the real strip
 * reads the VRAM ledger" — this file is that real strip, not a re-guess of
 * the mock's own placeholder numbers.
 *
 * fps/ms/vram and the sparkline are REAL: `diag/perf-strip.js#buildPerfStripModel`
 * (already the old debug panel's own model builder, reused whole, not
 * reimplemented) shapes the SAME heartbeat stats boot.js already computes
 * every ~250ms. `update(snapshot)` is PUSHED a fresh snapshot each tick —
 * boot.js's `bootHeartbeat()` is a standalone top-level function with no
 * lexical access to `install()`'s own locals, so this follows
 * `remoteAstrolabe.update(payload)`'s own push shape rather than a
 * `getSnapshot()` pull a shared closure variable can't actually back here.
 * This file only ever renders what it's handed, never computes health
 * itself.
 *
 * `probe`/`export` call real, already-shipping `MapShine.*` diagnostics
 * (armPixelProbe, flight.export) — genuinely wired, not stubs. `HUD` stays
 * honestly `planned`: `diag/perf-hud.js#createPerfHud` is real but reachable
 * only through the old debug panel's `registerPanel` mechanism today: no
 * standalone "open as its own floating panel" entry point exists yet for a
 * new room to call into — a real, scoped, named follow-up, matching the
 * mock's own tooltip rather than overreaching past it.
 *
 * @module ui/rooms/remote/debug-strip
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';

const SPARK_N = 24;

/** @param {string} hex @returns {[number,number,number]} */
function hexToRgb(hex) {
  const h = (hex ?? '').trim().replace('#', '');
  const full = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h;
  const n = parseInt(full, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [127, 151, 186];
}
/** @param {[number,number,number]} a @param {[number,number,number]} b @param {number} t 0..1 */
function lerpRgb(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

/**
 * fps → a themed colour, blended continuously (2026-08-18 fix; author's own
 * explicit spec: "green above 60fps... yellow above 35fps... below 25fps
 * red... blend between these"). Reads the LIVE `--ok`/`--warn`/`--fail`
 * LANTERN tokens (not hardcoded hex), so the sparkline stays theme-correct
 * across all four themes like everything else in this room — deliberately
 * its OWN model, not `perf-strip.js`'s shared `healthLevel` (which grades
 * fps as a fraction of THIS display's own detected refresh rate — the right
 * call for the old panel's one bar summarizing overall session health, not
 * for a fixed, display-agnostic scale across 24 history samples).
 * @param {[number,number,number]} ok @param {[number,number,number]} warn
 * @param {[number,number,number]} fail @param {number} fps
 * @returns {string} `rgb(r,g,b)`
 */
function fpsBlendColor(ok, warn, fail, fps) {
  if (!Number.isFinite(fps)) return `rgb(${ok.join(',')})`;
  let rgb;
  if (fps >= 60) rgb = ok;
  else if (fps >= 35) rgb = lerpRgb(warn, ok, (fps - 35) / 25);
  else if (fps >= 25) rgb = lerpRgb(fail, warn, (fps - 25) / 10);
  else rgb = fail;
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function dbtn(text, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msa-debug-btn';
  btn.textContent = text;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

function plannedDbtn(text, title, plannedReason) {
  const btn = dbtn(text, `${title} — ${plannedReason}`, () => {});
  btn.classList.add('msa-planned');
  return btn;
}

/**
 * @param {HTMLElement} container
 * @param {{onProbe?: () => void, onExport?: () => void,
 *   buildPerfSweepButton?: () => HTMLElement|null}} ctx
 * @returns {{update: (snapshot: {fpsText: string, msText: string,
 *   vramText: string, sparkHistory: Array<{ratio: number|null, level: string}>}
 *   |null|undefined) => void}} boot.js's own heartbeat calls `update` every
 *   ~250ms with a fresh snapshot (the old panel's own equivalent call,
 *   `MapShine.debug.updatePerfStrip`, was deleted along with that panel —
 *   UI parity plan, phase 7b; this is the sole surviving display now).
 *   A falsy `snapshot` (before the heartbeat's first tick) is a no-op.
 */
export function renderDebugStrip(container, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-debug-strip';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Debug equipment');

  // ---- THE ACCORDION, round 2 (2026-08-27, author RE-testing this exact
  // round's own first pass: "I liked seeing the performance monitoring
  // ticks, those were nice to see all the time and I don't want them
  // hidden. The same goes for the basic FPS/VRAM... I just want a SMALL
  // performance sweep button... and a small pixel probe button to be
  // available at all time along with the VRAM/FPS information and display
  // — but also the ability to fold it open for future debug buttons").
  // Round 1 collapsed fps/ms/vram/sparkline into the accordion body along
  // with HUD/export — too much: those four are exactly the "nice to see all
  // the time" readout, not "a library of debug buttons." Corrected shape:
  // PRIMARY (probe + perf sweep, buttons only) sits directly above a SECOND
  // always-visible row (the stats), and ONLY HUD/export — genuinely
  // occasional tools — collapse into the accordion body. The accordion
  // itself stays, for the SAME "room to grow" reason round 1 built it.
  const primaryRow = document.createElement('div');
  primaryRow.className = 'msa-debug-primary';

  const tag = document.createElement('span');
  tag.className = 'msa-debug-tag';
  tag.innerHTML = `${iconMarkup('flask')}DEBUG`;

  const probeBtn = dbtn('probe', 'Pixel probe — click 3 map points, sample the compositor', () => ctx.onProbe?.());
  // The full performance sweep — a REAL registered action (boot.js's own
  // 'perf-run-full', ~5min single floor/20+min multi-floor), reached
  // through MapShine.debug.buildActionButton so it gets the SAME status-
  // text/error-handling/clipboard-copy every other registered action
  // already has, for free, rather than a second hand-rolled version of
  // that UX. `null` (debugPanel not installed yet, or the action somehow
  // isn't registered) falls back to an honest planned stub rather than a
  // silently missing button.
  const perfBtn =
    ctx.buildPerfSweepButton?.() ??
    plannedDbtn(
      'perf sweep',
      'Full performance report',
      'The debug panel has not installed yet, or perf-run-full is not registered.'
    );
  perfBtn.classList.add('msa-debug-btn');
  // buildActionButton's own button (debug-panel-controls.js#makeButton) sets
  // font/padding/background/border/color as INLINE styles, which beat any
  // external class rule by specificity regardless of class order — adding
  // .msa-debug-btn alone was never going to shrink this (2026-08-27 fix,
  // author: "the current button text is huge"). Clearing the inline
  // declarations lets .msa-debug-btn's own CSS apply instead, matching
  // probeBtn's look exactly rather than a bespoke smaller-but-still-
  // different size.
  Object.assign(perfBtn.style, {
    font: '',
    fontWeight: '',
    padding: '',
    background: '',
    border: '',
    borderRadius: '',
    color: '',
  });
  // Round 2 (author: "performance report button text is stupid long") — the
  // registered action's OWN label is deliberately the long, honest one
  // ('🔬 Performance Report (this scene, CPU + GPU + every tier, ~5 min
  // single floor, 20+ min multi-floor)', boot.js's own 'perf-run-full')
  // because Studio's Lab tab renders that exact same label in a row with
  // real room for it. This compact strip has none — swap the DISPLAYED text
  // only (the click still runs the real 'perf-run-full' action either way;
  // only makeRunnable's own textContent is being overwritten here, not the
  // registry), and move the full wording to `title` so it's one hover away
  // instead of gone.
  if (perfBtn.textContent && perfBtn.textContent.length > 'perf sweep'.length) {
    perfBtn.title = perfBtn.textContent;
    perfBtn.textContent = 'perf sweep';
  }

  const accordionToggle = document.createElement('button');
  accordionToggle.type = 'button';
  accordionToggle.className = 'msa-debug-more';
  accordionToggle.setAttribute('aria-expanded', 'false');
  accordionToggle.title = 'More debug tools';
  accordionToggle.innerHTML = iconMarkup('chev');

  primaryRow.append(tag, probeBtn, perfBtn, accordionToggle);

  // ---- THE STATS ROW — always visible, NOT part of the collapsible body
  // (round 2 correction, see this section's own header above). Sits as its
  // own row directly under primaryRow, still inside `wrap` but outside
  // `body`, so it renders unconditionally regardless of the accordion's
  // open/closed state.
  const spark = document.createElement('span');
  spark.className = 'msa-debug-spark';
  spark.title = 'FPS health, recent samples';
  const bars = [];
  for (let i = 0; i < SPARK_N; i++) {
    const bar = document.createElement('i');
    spark.appendChild(bar);
    bars.push(bar);
  }

  const fpsStat = document.createElement('span');
  fpsStat.className = 'msa-debug-stat';
  fpsStat.innerHTML = 'fps <b>—</b>';
  const msStat = document.createElement('span');
  msStat.className = 'msa-debug-stat';
  msStat.innerHTML = '<b>—</b>ms';
  const vramStat = document.createElement('span');
  vramStat.className = 'msa-debug-stat';
  vramStat.innerHTML = 'vram <b>—</b>';

  const statsRow = document.createElement('div');
  statsRow.className = 'msa-debug-stats-row';
  statsRow.append(spark, fpsStat, msStat, vramStat);

  // ---- THE ACCORDION BODY — genuinely occasional tools only (HUD/export).
  const body = document.createElement('div');
  body.className = 'msa-debug-more-body';
  body.hidden = true;
  accordionToggle.addEventListener('click', () => {
    const expanded = accordionToggle.getAttribute('aria-expanded') === 'true';
    accordionToggle.setAttribute('aria-expanded', String(!expanded));
    body.hidden = expanded;
  });

  const hudBtn = plannedDbtn(
    'HUD',
    'Perf HUD — per-zone frame costs over the map',
    'diag/perf-hud.js is real but only reachable through the old debug panel today — a standalone open() for a new room is a real, scoped follow-up, not built this round.'
  );
  const exportBtn = dbtn('export', 'Export everything — the flight-recorder bundle', () => ctx.onExport?.());
  const moreBtnsRow = document.createElement('div');
  moreBtnsRow.className = 'msa-debug-more-btns';
  moreBtnsRow.append(hudBtn, exportBtn);

  body.append(moreBtnsRow);

  wrap.append(primaryRow, statsRow, body);
  container.appendChild(wrap);

  function update(snapshot) {
    if (!snapshot) return;
    fpsStat.innerHTML = `fps <b>${snapshot.fpsText ?? '—'}</b>`;
    msStat.innerHTML = `<b>${snapshot.msText ?? '—'}</b>ms`;
    vramStat.innerHTML = `vram <b>${snapshot.vramText ?? '—'}</b>`;
    const hist = snapshot.sparkHistory ?? [];
    // Read the LIVE theme tokens once per update, not once per bar (24x)
    // (2026-08-18 fix — see fpsBlendColor's own doc for why this needs to
    // be its own absolute-fps model rather than perf-strip.js's shared
    // refresh-rate-relative one).
    const rootStyle = getComputedStyle(document.documentElement);
    const ok = hexToRgb(rootStyle.getPropertyValue('--ok'));
    const warn = hexToRgb(rootStyle.getPropertyValue('--warn'));
    const fail = hexToRgb(rootStyle.getPropertyValue('--fail'));
    for (let i = 0; i < SPARK_N; i++) {
      const sample = hist[i];
      const bar = bars[i];
      const pct = Number.isFinite(sample?.ratio) ? Math.max(6, Math.min(100, sample.ratio * 100)) : 6;
      bar.style.height = `${pct.toFixed(0)}%`;
      bar.style.background = fpsBlendColor(ok, warn, fail, sample?.fps);
    }
  }

  return { update };
}
