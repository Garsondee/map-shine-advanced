/**
 * Shader Lab driver — THE SPECULAR / SHINE BENCH's page wiring, plus the one
 * shared WebGPU renderer this file builds for it. `docs/planning/Shader-Lab.md`
 * has the full design and rationale.
 *
 * ============================================================================
 * WHAT THIS FILE USED TO ALSO BE (2026-08-02)
 * ============================================================================
 * Before the layer-smear model shipped, this file ALSO built the production
 * sun-shadow bake material directly (`buildSunShadowBakeMaterial` from
 * `sun-occlusion-render.js`) plus a lab-only averaged-mean smear prototype,
 * fed both a hand-authored synthetic caster texture, and exposed a
 * `window.shaderLab` pixel-query API for comparing them — the ORIGINAL
 * rung-1 bench, before `bench-sun-shadow.js`'s real-data "rung 3" approach
 * existed. Both the march and the old smear are retired
 * (`docs/planning/Sun-Shadows-Layer-Smear.md` §8); the CURRENT model's own
 * lab lives in `bench-sun-shadow.js` / `sun-shadow-lab.js`, driving the
 * `sun-shadow` effect and the `#sunShadowPanel`/`#sunShadowLeft` DOM.
 *
 * This file's `#view`/`#profile`/`#legend`/`#status` canvas group
 * (`#sunLeft`) is SHARED with the specular bench below — `bench-specular.js`
 * has no canvas of its own — which is why it stays wired here rather than
 * being deleted along with the sun-specific class that used to own it. See
 * `view-visibility.js`'s own `VIEW_BY_EFFECT` map.
 *
 * @module tools/shader-lab/lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { createSpecularBench } from './bench-specular.js';
import { SPECULAR_DEBUG_CHANNELS } from '../../src/effects/specular/specular.js';

const statusEl = document.getElementById('status');
const log = (msg) => {
  console.log('[shader-lab]', msg);
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

// ---------------------------------------------------------------------------
// THE SPECULAR BENCH — page wiring. Every control writes state, then
// re-renders, repaints and re-legends, so the pane always describes what is
// currently on it without needing narration.
// ---------------------------------------------------------------------------
let spec = null;

async function specRefresh() {
  if (!spec) return;
  await spec.render();
  await spec.paint(document.getElementById('view'));
  // ⚠️ THE BRIGHTEST ROW, NOT THE MIDDLE ONE. A scenario with several separate
  // objects (`mixed`) has an AABB whose midline can pass cleanly BETWEEN them,
  // and a dead-flat profile there reads as "the effect is doing nothing" when
  // it is in fact drawing four metals a few hundred px away. Picking the row
  // with the most signal makes the plot answer the question it is on screen to
  // answer — the shimmer's own range along a line through real metal.
  const pts = await spec.profileBrightestRow({ steps: 140 });
  paintPointsToProfile(pts);
  const st = spec.getStatus();
  const ch = SPECULAR_DEBUG_CHANNELS.find((c) => c.n === st.debugChannel);
  document.getElementById('legend').textContent =
    `SHINE bench — mask=${st.scenario}  depth=${st.depthPreset}  channel=${ch ? `${ch.n} ${ch.id}` : '0 (the effect)'}\n` +
    `illum=${st.illum} darknessFloor=${st.darknessFloor} outdoors=${st.outdoors} baseSceneLit=${st.baseScene}\n` +
    `strength=${st.strength} shimmerGain=${st.shimmerGain} saturation=${st.saturation} zoom=${st.zoom} t=${(st.timeMs / 1000).toFixed(1)}s\n` +
    `islands=${st.islandReport ? `${st.islandReport.islands} (pre-cluster ${st.islandReport.preClusterComponents}, dropped ${st.islandReport.droppedSmall})` : 'n/a'}  ` +
    `gates: outdoors=${st.outdoorsGateCompiled} floor=${st.floorGateCompiled}\n` +
    `profile: min=${Math.min(...pts.map((p) => p.vis)).toFixed(4)} max=${Math.max(...pts.map((p) => p.vis)).toFixed(4)}`;
}

window.labSpecRefresh = specRefresh;

/** Draws an already-sampled points array as a line plot on `#profile`. */
function paintPointsToProfile(pts) {
  const canvas = document.getElementById('profile');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const peak = Math.max(1e-4, ...pts.map((p) => p.vis));
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#333';
  ctx.beginPath();
  ctx.moveTo(0, h - 1);
  ctx.lineTo(w, h - 1);
  ctx.moveTo(0, 1);
  ctx.lineTo(w, 1);
  ctx.stroke();
  ctx.strokeStyle = '#6cf';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const px = (i / (pts.length - 1)) * w;
    const py = h - 1 - (p.vis / peak) * (h - 2);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.fillStyle = '#8cf';
  ctx.font = '10px monospace';
  ctx.fillText(`peak ${peak.toFixed(4)}`, 4, 12);
}

function wireSpecRange(id, key, decimals, transform) {
  const el = document.getElementById(id);
  const valEl = document.getElementById(`${id}Val`);
  const show = () => {
    if (valEl) valEl.textContent = Number(el.value).toFixed(decimals);
  };
  show();
  el.addEventListener('input', () => {
    spec.state[key] = transform ? transform(Number(el.value)) : Number(el.value);
    show();
    specRefresh();
  });
}

function wireSpecularPanel() {
  const chSel = document.getElementById('specChannel');
  for (const c of SPECULAR_DEBUG_CHANNELS) {
    const opt = document.createElement('option');
    opt.value = String(c.n);
    opt.textContent = c.label;
    chSel.appendChild(opt);
  }
  chSel.addEventListener('change', () => {
    spec.state.debugChannel = Number(chSel.value);
    specRefresh();
  });
  document.getElementById('specScenario').addEventListener('change', (e) => {
    spec.applyScenario(e.target.value);
    specRefresh();
  });
  document.getElementById('specDepth').addEventListener('change', (e) => {
    spec.state.depthPreset = e.target.value;
    specRefresh();
  });
  wireSpecRange('specIllum', 'illum', 2);
  wireSpecRange('specFloor', 'darknessFloor', 2);
  wireSpecRange('specOutdoors', 'outdoors', 2);
  wireSpecRange('specBase', 'baseScene', 2);
  wireSpecRange('specStrength', 'strength', 2);
  wireSpecRange('specGain', 'shimmerGain', 1);
  wireSpecRange('specSat', 'saturation', 2);
  wireSpecRange('specZoom', 'zoom', 2);
  wireSpecRange('specTime', 'timeMs', 1, (v) => v * 1000);
  document.getElementById('specLadder').addEventListener('click', async () => {
    log('running gate ladder…');
    const r = await spec.gateLadder();
    log(
      `LADDER (${r.scenario}, depth=${r.depth}, illum=${r.illum})\n` +
        r.rows.map((x) => `  ${String(x.n).padStart(2)} ${x.id.padEnd(12)} max=${x.max} mean=${x.mean}${x.DEAD ? '   <<< DEAD' : ''}`).join('\n') +
        `\n  => ${r.verdict}`
    );
    await specRefresh();
  });
  document.getElementById('specVis').addEventListener('click', async () => {
    const r = await spec.visibilityReport();
    log(
      `VISIBILITY: base=${r.baseScene} offMetal=${r.offMetal} onMetal mean=${r.onMetalMean} peak=${r.onMetalPeak} min=${r.onMetalMin}\n` +
        `  post-tonemap base=${r.postToneMap.base} peak=${r.postToneMap.peak} -> screenContrast=${r.screenContrast}`
    );
    await specRefresh();
  });
}

document.getElementById('effect').addEventListener('change', async (e) => {
  const isSpec = e.target.value === 'specular';
  const specPanel = document.getElementById('specPanel');
  if (specPanel) specPanel.style.display = isSpec ? '' : 'none';
  if (isSpec) await specRefresh();
});

(async () => {
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  await renderer.init();
  log(`renderer backend: ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
  spec = createSpecularBench({ THREE, renderer, log });
  window.specularBench = spec;
  wireSpecularPanel();
  await spec.selfTest();
  log('specular bench ready (window.specularBench)');
})().catch((err) => log(`INIT FAILED: ${err.stack || err.message}`));
