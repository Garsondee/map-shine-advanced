/**
 * SHADER LAB — page wiring for THE WATER BENCH (Water-Testament W0).
 *
 * Its own module, own canvas, own panel, and a second independent `change`
 * listener on the shared `#effect` select — the pattern `fixture-lab.js`
 * established and `tools/shader-lab/AGENTS.md` §5 requires. `lab.js` costs
 * zero lines.
 *
 * ⚠️ THE RENDERER IS BUILT LAZILY, on first selection of the Water effect —
 * `precip-lab.js`'s own reasoning applies unchanged: a WebGPU device per bench
 * per page load is a real cost this page cannot keep affording as it grows.
 * `registerWaterAdapter()` below registers a THIN, renderer-free wrapper with
 * the contract at module load (so `window.lab.describe()` always lists
 * `'water'`), and the wrapper builds the real bench on first `runScenario`.
 *
 * @module tools/shader-lab/water-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createWaterBench } from './bench-water.js';
import { WATER_DEBUG_CHANNELS } from '../../src/effects/water/water.js';

const statusEl = document.getElementById('waterStatus');
const log = (msg) => {
  console.log('[water-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();

/** @type {object|null} the real bench, once built. */
let bench = null;
let initPromise = null;

/** Build the WebGPU renderer + the real bench, once. Idempotent. */
function ensureInit() {
  if (initPromise) return initPromise;
  log('initialising WebGPU renderer + the real water bake pipeline…');
  initPromise = (async () => {
    const renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    log(`renderer backend: ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
    bench = createWaterBench({ THREE, renderer, log });
    window.waterBench = bench;
    await bench.selfTest();
    log(
      'water bench ready (window.waterBench).\n' +
        'Drive it live:  window.waterBench.state.debugChannel = 14; await window.waterBench.render()\n' +
        'Gate ladder:    await window.waterBench.gateLadder()\n' +
        "Scenarios:      await window.lab.run('water', 'shore-foam-has-real-coverage')"
    );
    wireChannelSelect();
    syncControlsFromState();
    await refresh();
  })().catch((err) => {
    log(`INIT FAILED: ${err?.message ?? err}`);
    console.error(err);
  });
  return initPromise;
}

/** Register a wrapper NOW (module load), so `window.lab.describe()` always
 * lists 'water' — the contract's whole reason to exist is never having to
 * read source to find out what's there, and that should not depend on
 * whether anyone has clicked the effect picker yet. */
function registerWaterAdapter() {
  // A placeholder scenario table so `describe()` reports real names before
  // the renderer exists — filled from the real bench's own Map once it
  // builds (scenarios never change between rebuilds, so copying references
  // over is exact, not a guess).
  const scenarioNames = [
    'river-bake-produces-real-sdf',
    'tier4-gate-ladder-no-dead-term',
    'shore-foam-has-real-coverage',
  ];
  const placeholderScenarios = new Map(scenarioNames.map((n) => [n, { name: n }]));
  contract.registerBench({
    name: 'water',
    title: 'Water — shore foam instrument (Water-Testament W0)',
    rung: 4,
    summary: 'Real buildWaterSurfaceMaterial + the real JFA body-pack bake, against a synthetic bend+island river.',
    get scenarios() {
      return bench ? bench.scenarios : placeholderScenarios;
    },
    checkIds: scenarioNames,
    ready: () => bench !== null,
    async runScenario(scenario, ctx) {
      await ensureInit();
      if (!bench) throw new Error('water bench failed to initialise — see #waterStatus');
      const real = bench.scenarios.get(scenario.name);
      if (!real) throw new Error(`scenario '${scenario.name}' vanished between describe() and run()`);
      return bench.runScenario(real, ctx);
    },
  });
}

async function refresh() {
  if (!bench) return;
  await bench.render();
  const canvas = document.getElementById('waterView');
  if (canvas) await bench.paint(canvas);
  const pts = await bench.profileAcrossPool({ steps: 200 });
  paintPointsToProfile(pts);
  const st = bench.getStatus();
  const ch = WATER_DEBUG_CHANNELS.find((c) => c.n === st.debugChannel);
  const legend = document.getElementById('waterLegend');
  if (legend) {
    legend.textContent =
      `WATER bench — tier=${st.tier}  channel=${ch ? `${ch.n} ${ch.id}` : '0 (the effect)'}\n` +
      `flow=${st.flowSpeedPx}px/s @ ${st.flowAngleDeg}°  chop=${st.chop}  foam=${st.foam}  swash=${st.swashFoam} break=${st.breakFoam}\n` +
      `absorption=${st.absorption} depthScalePx=${st.depthScalePx} opacity=${st.opacity} caustics=${st.caustics}\n` +
      `bake: ${st.floodGrid} grid, ${st.jfaSteps} JFA rounds  gates: outdoors=${st.outdoorsGateCompiled} normal=${st.normalCompiled}`;
  }
}
window.labWaterRefresh = refresh;

function paintPointsToProfile(pts) {
  const canvas = document.getElementById('waterProfile');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const peak = Math.max(1e-4, ...pts.map((p) => p.vis));
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#333';
  ctx.beginPath();
  ctx.moveTo(0, h - 1);
  ctx.lineTo(w, h - 1);
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
  ctx.fillText(`peak ${peak.toFixed(4)} — scanline crosses both banks + the island`, 4, 12);
}

function wireChannelSelect() {
  const sel = document.getElementById('waterChannel');
  if (!sel || sel.options.length) return; // already wired (ensureInit can be re-entered)
  for (const c of WATER_DEBUG_CHANNELS) {
    const opt = document.createElement('option');
    opt.value = String(c.n);
    opt.textContent = c.label;
    opt.title = c.reads;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    bench.state.debugChannel = Number(sel.value);
    refresh();
  });
}

/** One range input → one bench state key, with a live numeric readout. */
function wireRange(inputId, valueId, key, { digits = 2 } = {}) {
  const input = document.getElementById(inputId);
  const out = document.getElementById(valueId);
  if (!input) return;
  const apply = () => {
    const v = Number(input.value);
    if (out) out.textContent = v.toFixed(digits);
    if (bench) {
      bench.state[key] = v;
      refresh();
    }
  };
  input.addEventListener('input', apply);
  if (out) out.textContent = Number(input.value).toFixed(digits);
}

function syncControlsFromState() {
  if (!bench) return;
  const s = bench.state;
  const pairs = [
    ['waterOpacity', 'waterOpacityVal', s.opacity, 2],
    ['waterAbsorption', 'waterAbsorptionVal', s.absorption, 2],
    ['waterDepthScale', 'waterDepthScaleVal', s.depthScalePx, 0],
    ['waterFoam', 'waterFoamVal', s.foam, 2],
    ['waterFlowSpeed', 'waterFlowSpeedVal', s.flowSpeedPx, 0],
    ['waterFlowAngle', 'waterFlowAngleVal', s.flowAngleDeg, 0],
    ['waterChop', 'waterChopVal', s.chop, 2],
    ['waterSwashFoam', 'waterSwashFoamVal', s.swashFoam, 2],
    ['waterBreakFoam', 'waterBreakFoamVal', s.breakFoam, 2],
    ['waterCaustics', 'waterCausticsVal', s.caustics, 2],
    ['waterZoom', 'waterZoomVal', s.zoom, 2],
    ['waterTime', 'waterTimeVal', s.timeMs / 1000, 1],
  ];
  for (const [inputId, valId, value, digits] of pairs) {
    const input = document.getElementById(inputId);
    const out = document.getElementById(valId);
    if (input) input.value = String(value);
    if (out) out.textContent = Number(value).toFixed(digits);
  }
}

function wire() {
  wireRange('waterOpacity', 'waterOpacityVal', 'opacity');
  wireRange('waterAbsorption', 'waterAbsorptionVal', 'absorption');
  wireRange('waterDepthScale', 'waterDepthScaleVal', 'depthScalePx', { digits: 0 });
  wireRange('waterFoam', 'waterFoamVal', 'foam');
  wireRange('waterFlowSpeed', 'waterFlowSpeedVal', 'flowSpeedPx', { digits: 0 });
  wireRange('waterFlowAngle', 'waterFlowAngleVal', 'flowAngleDeg', { digits: 0 });
  wireRange('waterChop', 'waterChopVal', 'chop');
  wireRange('waterSwashFoam', 'waterSwashFoamVal', 'swashFoam');
  wireRange('waterBreakFoam', 'waterBreakFoamVal', 'breakFoam');
  wireRange('waterCaustics', 'waterCausticsVal', 'caustics');
  wireRange('waterZoom', 'waterZoomVal', 'zoom');
  wireRange('waterTime', 'waterTimeVal', 'timeMs', { digits: 1 });

  document.getElementById('waterLadder')?.addEventListener('click', async () => {
    await ensureInit();
    log('running gate ladder…');
    const r = await bench.gateLadder();
    log(
      `LADDER (tier ${r.tier})\n` +
        r.rows
          .map(
            (x) =>
              `  ${String(x.n).padStart(2)} ${x.id.padEnd(14)} ${x.kind.padEnd(9)} max=${x.max ?? '—'} mean=${x.mean ?? '—'} p99=${x.p99 ?? '—'} cov=${x.coveragePct ?? '—'}%${x.DEAD ? '   <<< DEAD' : ''}`
          )
          .join('\n') +
        `\n  => ${r.verdict}`
    );
    await refresh();
  });

  const scenSel = document.getElementById('waterScenario');
  document.getElementById('waterRun')?.addEventListener('click', async () => {
    await ensureInit();
    const name = scenSel?.value || 'shore-foam-has-real-coverage';
    log(`running '${name}'…`);
    const report = await contract.run('water', name, {});
    const s = report.summary ?? {};
    log(
      `REPORT ${report.runId}\n` +
        `  ok=${report.ok}  pass=${s.pass} fail=${s.fail} UNMEASURED=${s.UNMEASURED}  (${report.timing?.totalMs}ms)\n` +
        (report.error ? `  ERROR: ${report.error}\n` : '') +
        (report.checks ?? [])
          .map(
            (c) => `    ${c.status.padEnd(10)} ${c.id}${c.measured !== null ? ` = ${JSON.stringify(c.measured)}` : ''}`
          )
          .join('\n') +
        (report.persistedTo ? `\n  saved -> ${report.persistedTo}` : '')
    );
    await refresh();
  });

  // Second, independent listener on the shared <select>. Only ever SETS
  // 'none' on panels this file does not own — `lab.js`'s own listener
  // re-shows `specPanel` on any change, so this never has to restore it.
  const effectSelect = document.getElementById('effect');
  const panel = document.getElementById('waterPanel');
  const applyEffectVisibility = (value) => {
    const isWater = value === 'water';
    if (panel) panel.style.display = isWater ? '' : 'none';
    if (isWater) {
      const specPanel = document.getElementById('specPanel');
      if (specPanel) specPanel.style.display = 'none';
      void ensureInit();
    }
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  log('water bench registered — select "Water" to build its renderer and run the real JFA bake.');
}

registerWaterAdapter();
wire();
