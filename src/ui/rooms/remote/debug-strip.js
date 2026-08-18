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
 * @param {{onProbe?: () => void, onExport?: () => void}} ctx
 * @returns {{update: (snapshot: {fpsText: string, msText: string,
 *   vramText: string, sparkHistory: Array<{ratio: number|null, level: string}>}
 *   |null|undefined) => void}} boot.js's own heartbeat calls `update` every
 *   ~250ms alongside `MapShine.debug.updatePerfStrip`, the SAME dual-dispatch
 *   shape `remoteAstrolabe.update`/`astrolabe.update` already use side by
 *   side. A falsy `snapshot` (before the heartbeat's first tick) is a no-op.
 */
export function renderDebugStrip(container, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-debug-strip';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Debug equipment');

  const tag = document.createElement('span');
  tag.className = 'msa-debug-tag';
  tag.innerHTML = `${iconMarkup('flask')}DEBUG`;

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

  const spacer = document.createElement('span');
  spacer.className = 'msa-debug-spacer';

  const hudBtn = plannedDbtn(
    'HUD',
    'Perf HUD — per-zone frame costs over the map',
    'diag/perf-hud.js is real but only reachable through the old debug panel today — a standalone open() for a new room is a real, scoped follow-up, not built this round.'
  );
  const probeBtn = dbtn('probe', 'Pixel probe — click 3 map points, sample the compositor', () => ctx.onProbe?.());
  const exportBtn = dbtn('export', 'Export everything — the flight-recorder bundle', () => ctx.onExport?.());

  wrap.append(tag, spark, fpsStat, msStat, vramStat, spacer, hudBtn, probeBtn, exportBtn);
  container.appendChild(wrap);

  function update(snapshot) {
    if (!snapshot) return;
    fpsStat.innerHTML = `fps <b>${snapshot.fpsText ?? '—'}</b>`;
    msStat.innerHTML = `<b>${snapshot.msText ?? '—'}</b>ms`;
    vramStat.innerHTML = `vram <b>${snapshot.vramText ?? '—'}</b>`;
    const hist = snapshot.sparkHistory ?? [];
    for (let i = 0; i < SPARK_N; i++) {
      const sample = hist[i];
      const bar = bars[i];
      const pct = Number.isFinite(sample?.ratio) ? Math.max(6, Math.min(100, sample.ratio * 100)) : 6;
      bar.style.height = `${pct.toFixed(0)}%`;
      bar.className = sample?.level === 'critical' ? 'bad' : sample?.level === 'warn' ? 'warn' : '';
    }
  }

  return { update };
}
