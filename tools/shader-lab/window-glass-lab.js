/**
 * WINDOW GLASS LAB — page wiring for `bench-window-glass.js`.
 *
 * Two ways in, deliberately:
 *   - SCENARIOS, through the contract, for the assertions (`window.lab.run`).
 *   - LIVE SLIDERS, for the eye. This is a LOOK feature; a pass/fail list
 *     cannot tell you whether a pane reads as hand-blown glass or as a
 *     chromatic-aberration filter, and only the second one is worth shipping.
 *
 * The sliders are generated from one table rather than hand-written into
 * `index.html` — the panel then cannot drift out of sync with the bench's own
 * state object, which is the same reason the effect's real UI is generated
 * from `WINDOW_PARAMS` instead of hand-built.
 *
 * @module tools/shader-lab/window-glass-lab
 */

import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createWindowGlassBench } from './bench-window-glass.js';
import { WINDOW_DEBUG_CHANNELS } from '../../src/effects/window/window.js';

const statusEl = document.getElementById('windowGlassStatus');
const log = (msg) => {
  console.log('[window-glass-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createWindowGlassBench({ THREE, log });
window.windowGlassBench = bench;

/**
 * The knobs, mirroring `WINDOW_PARAMS`'s own `Glass` category (plus the two
 * Look controls that interact with it). `key` indexes `bench.state` directly.
 */
const SLIDERS = [
  { key: 'glassWarpPx', label: 'Glass thickness (px)', min: 0, max: 60, step: 0.5 },
  { key: 'glassDispersion', label: 'Prism split', min: 0, max: 1, step: 0.01 },
  { key: 'glassScale', label: 'Blob size (px)', min: 8, max: 400, step: 1 },
  { key: 'glassDetail', label: 'Fine detail', min: 0, max: 1, step: 0.01 },
  { key: 'glassStriation', label: 'Draw lines', min: 0, max: 1, step: 0.01 },
  { key: 'glassStriationAngle', label: 'Draw-line angle (°)', min: 0, max: 180, step: 1 },
  { key: 'glassCausticStrength', label: 'Caustic highlight', min: 0, max: 2, step: 0.01 },
  { key: 'glassCausticSharpness', label: 'Caustic tightness', min: 0.5, max: 6, step: 0.1 },
  { key: 'glassSeed', label: 'Pattern seed', min: 0, max: 999, step: 1 },
  { key: 'strength', label: 'Window light', min: 0, max: 3, step: 0.01 },
  { key: 'contrast', label: 'Patch contrast', min: 0.25, max: 4, step: 0.01 },
];

let refreshQueued = false;
/** Coalesce drags into one render — a slider fires far faster than a WebGPU
 * frame round-trips, and queueing every event would run the device behind. */
function queueRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(async () => {
    refreshQueued = false;
    try {
      await bench.refresh();
    } catch (err) {
      log(`refresh failed: ${err.message}`);
    }
  });
}

function buildSliders(host) {
  for (const s of SLIDERS) {
    const wrap = document.createElement('label');
    wrap.style.display = 'block';
    const name = document.createElement('span');
    name.textContent = `${s.label} `;
    const val = document.createElement('span');
    val.textContent = String(bench.state[s.key]);
    val.style.color = '#8f8';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String(s.step);
    input.value = String(bench.state[s.key]);
    input.style.width = '100%';
    input.addEventListener('input', () => {
      bench.state[s.key] = Number(input.value);
      val.textContent = input.value;
      queueRefresh();
    });
    wrap.append(name, val, input);
    host.appendChild(wrap);
  }

  // THE DEBUG CHANNELS — read straight off the effect's own declaration, so a
  // channel added in `window.js` appears here with no edit to this file.
  const chWrap = document.createElement('label');
  chWrap.style.display = 'block';
  chWrap.textContent = 'Debug channel ';
  const chSel = document.createElement('select');
  for (const c of WINDOW_DEBUG_CHANNELS) {
    const opt = document.createElement('option');
    opt.value = String(c.n);
    opt.textContent = c.label;
    chSel.appendChild(opt);
  }
  chSel.addEventListener('change', () => {
    bench.state.debugChannel = Number(chSel.value);
    const ch = WINDOW_DEBUG_CHANNELS.find((c) => c.n === bench.state.debugChannel);
    if (ch?.reads) log(`ch ${ch.n} — ${ch.reads}`);
    queueRefresh();
  });
  chWrap.appendChild(chSel);
  host.appendChild(chWrap);
}

async function runSelected() {
  const name = document.getElementById('windowGlassScenario').value;
  log(`running window-glass scenario '${name}'…`);
  const report = await contract.run('window-glass', name, {});
  const s = report.summary ?? {};
  log(
    `REPORT ${report.runId}\n` +
      `  ok=${report.ok}  pass=${s.pass} fail=${s.fail} UNMEASURED=${s.UNMEASURED}  (${report.timing?.totalMs}ms)\n` +
      (report.error ? `  ERROR ${report.error}\n` : '') +
      (report.checks ?? []).map((c) => `    ${c.status.padEnd(10)} ${c.id} = ${JSON.stringify(c.measured)}`).join('\n')
  );
  return report;
}

function wire() {
  const scenSel = document.getElementById('windowGlassScenario');
  if (scenSel) {
    for (const name of bench.scenarios.keys()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      scenSel.appendChild(opt);
    }
  }
  document.getElementById('windowGlassRun')?.addEventListener('click', () => runSelected());
  document.getElementById('windowGlassDraw')?.addEventListener('click', () => queueRefresh());

  const sliderHost = document.getElementById('windowGlassSliders');
  if (sliderHost) buildSliders(sliderHost);

  const effectSelect = document.getElementById('effect');
  const panel = document.getElementById('windowGlassPanel');
  const applyPanelVisibility = (value) => {
    if (panel) panel.style.display = value === 'window-glass' ? '' : 'none';
    // Draw once on arrival, so picking the effect shows a picture rather than
    // an empty black canvas waiting for a slider to be touched.
    if (value === 'window-glass') queueRefresh();
  };
  effectSelect?.addEventListener('change', (e) => applyPanelVisibility(e.target.value));
  applyPanelVisibility(effectSelect?.value ?? 'sun-shadow');

  log('window-glass bench ready — window.lab.run("window-glass", "prism-splits-red-from-blue")');
}

wire();
