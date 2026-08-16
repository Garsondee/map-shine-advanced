/**
 * SHADER LAB — page wiring for THE PRECIPITATION BENCH.
 *
 * Its own module, own canvas, own panel, and a second independent `change`
 * listener on the shared `#effect` select — the pattern `fixture-lab.js`
 * established and AGENTS.md §5 requires. `lab.js` costs zero lines.
 *
 * ⚠️ THE DRIVER IS BUILT LAZILY, on first selection of the Precipitation
 * effect. Every bench that builds its own `WebGPURenderer` at module load
 * costs a real device and a real canvas on EVERY page load, for every author
 * who only wanted to look at shadows. Lightning/candle/fire each pay that;
 * this one does not, and the difference is measurable on a page that now
 * carries sixteen benches.
 *
 * @module tools/shader-lab/precip-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createPrecipBench } from './bench-precip.js';
import { PRECIP_SPECIES_IDS } from '../../src/effects/precipitation/precip-species.js';

const statusEl = document.getElementById('precipStatus');
const log = (msg) => {
  console.log('[precip-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createPrecipBench({ THREE, log });
contract.registerBench(bench);
window.precipBench = bench;
/** The driver itself, for `javascript_tool`-driven tuning: `window.precip.set({fallSlant01: 0.9})`. */
window.precip = bench.driver;

let initPromise = null;
function ensureInit() {
  if (initPromise) return initPromise;
  const canvas = document.getElementById('precipView');
  if (!canvas) {
    log('ERROR: #precipView canvas is missing from index.html');
    return Promise.resolve();
  }
  log('initialising WebGPU renderer + both species engines…');
  initPromise = bench.driver
    .init(canvas)
    .then(() => {
      log(
        `ready. Species: ${PRECIP_SPECIES_IDS.join(', ')}.\n` +
          `Drive it live:  window.precip.set({ precip01: 0.9, fallSlant01: 0.8 })\n` +
          `Switch species: window.precip.setSpecies('snow')\n` +
          `Step time by hand (works even when this pane is not displayed):\n` +
          `                window.precip.advance(16)\n` +
          `Scenarios:      await window.lab.run('precip', 'law5-clear-day-draws-nothing')\n` +
          `                await window.lab.run('precip', 'intensity-ramps-density')\n` +
          `                await window.lab.run('precip', 'species-matrix')\n` +
          `                await window.lab.run('precip', 'full-capacity-compiles')`
      );
      syncControlsFromState();
    })
    .catch((err) => {
      log(`INIT FAILED: ${err?.message ?? err}`);
      console.error(err);
    });
  return initPromise;
}

/** Wire one range input to a driver state key, with a live numeric readout. */
function wireRange(inputId, valueId, key, { scale = 1, digits = 2 } = {}) {
  const input = document.getElementById(inputId);
  const out = document.getElementById(valueId);
  if (!input) return;
  const apply = () => {
    const v = Number(input.value) * scale;
    if (out) out.textContent = v.toFixed(digits);
    bench.driver.set({ [key]: v });
  };
  input.addEventListener('input', apply);
  // Seed the readout without pushing state — the driver may not exist yet.
  if (out) out.textContent = (Number(input.value) * scale).toFixed(digits);
}

/** Push the driver's own state back into the controls, after init. */
function syncControlsFromState() {
  const s = bench.driver.state;
  const pairs = [
    ['precipPrecip', 'precipPrecipVal', s.precip01, 2],
    ['precipStorm', 'precipStormVal', s.stormActivity01, 2],
    ['precipDay', 'precipDayVal', s.dayFactor01, 2],
    ['precipFlash', 'precipFlashVal', s.flash01, 2],
    ['precipWindSpeed', 'precipWindSpeedVal', s.windSpeed01, 2],
    ['precipWindDir', 'precipWindDirVal', s.windDirDeg, 0],
    ['precipSize', 'precipSizeVal', s.sizeScale, 2],
    ['precipSlant', 'precipSlantVal', s.fallSlant01, 2],
    ['precipSlantDir', 'precipSlantDirVal', s.slantDirDeg, 0],
    ['precipSplay', 'precipSplayVal', s.parallaxStreak01, 2],
    ['precipStreak', 'precipStreakVal', s.streakScale, 2],
    ['precipChaos', 'precipChaosVal', s.chaosScale, 2],
    ['precipCamH', 'precipCamHVal', s.cameraHeight, 0],
    ['precipZoom', 'precipZoomVal', s.zoom, 2],
    // ⭐ THE ARRIVAL (P2)
    ['precipSplashRate', 'precipSplashRateVal', s.splashRateScale, 2],
    ['precipSplashSize', 'precipSplashSizeVal', s.splashSizeScale, 2],
    ['precipSplashAlpha', 'precipSplashAlphaVal', s.splashAlphaScale, 2],
    ['precipSplashPeak', 'precipSplashPeakVal', s.splashPeakBoost, 2],
    ['precipSplashSmear', 'precipSplashSmearVal', s.splashSmearGain, 2],
  ];
  for (const [inputId, valId, value, digits] of pairs) {
    const input = document.getElementById(inputId);
    const out = document.getElementById(valId);
    if (input) input.value = String(value);
    if (out) out.textContent = Number(value).toFixed(digits);
  }
}

function wire() {
  // Species picker
  const speciesSel = document.getElementById('precipSpecies');
  if (speciesSel) {
    for (const id of PRECIP_SPECIES_IDS) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      speciesSel.appendChild(opt);
    }
    speciesSel.addEventListener('change', (e) => bench.driver.setSpecies(e.target.value));
  }

  // Scenario picker + run
  const scenSel = document.getElementById('precipScenario');
  if (scenSel) {
    for (const name of bench.scenarios.keys()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      scenSel.appendChild(opt);
    }
  }
  document.getElementById('precipRun')?.addEventListener('click', async () => {
    await ensureInit();
    const name = scenSel?.value;
    log(`running '${name}'…`);
    const report = await contract.run('precip', name, {});
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
  });

  // ── THE AXES (weather-manager-owned in production) ──
  wireRange('precipPrecip', 'precipPrecipVal', 'precip01');
  wireRange('precipStorm', 'precipStormVal', 'stormActivity01');
  wireRange('precipDay', 'precipDayVal', 'dayFactor01');
  wireRange('precipFlash', 'precipFlashVal', 'flash01');
  wireRange('precipWindSpeed', 'precipWindSpeedVal', 'windSpeed01');
  wireRange('precipWindDir', 'precipWindDirVal', 'windDirDeg', { digits: 0 });

  // ── THE LOOK DIALS (effect-owned) ──
  wireRange('precipSize', 'precipSizeVal', 'sizeScale');
  wireRange('precipSlant', 'precipSlantVal', 'fallSlant01');
  wireRange('precipSlantDir', 'precipSlantDirVal', 'slantDirDeg', { digits: 0 });
  wireRange('precipSplay', 'precipSplayVal', 'parallaxStreak01');
  wireRange('precipStreak', 'precipStreakVal', 'streakScale');
  wireRange('precipChaos', 'precipChaosVal', 'chaosScale');
  wireRange('precipCamH', 'precipCamHVal', 'cameraHeight', { digits: 0 });
  wireRange('precipZoom', 'precipZoomVal', 'zoom');

  // ── THE ARRIVAL (P2) — splash dials + the two layer isolators ──
  wireRange('precipSplashRate', 'precipSplashRateVal', 'splashRateScale');
  wireRange('precipSplashSize', 'precipSplashSizeVal', 'splashSizeScale');
  wireRange('precipSplashAlpha', 'precipSplashAlphaVal', 'splashAlphaScale');
  wireRange('precipSplashPeak', 'precipSplashPeakVal', 'splashPeakBoost');
  wireRange('precipSplashSmear', 'precipSplashSmearVal', 'splashSmearGain');
  document.getElementById('precipShowFall')?.addEventListener('change', (e) => {
    bench.driver.set({ fall: e.target.checked });
  });
  document.getElementById('precipShowArrival')?.addEventListener('change', (e) => {
    bench.driver.set({ arrival: e.target.checked });
  });

  document.getElementById('precipPaused')?.addEventListener('change', (e) => {
    bench.driver.set({ paused: e.target.checked });
  });
  document.getElementById('precipSkyGate')?.addEventListener('change', (e) => {
    bench.driver.set({ skyGate: e.target.checked });
  });
  document.getElementById('precipStep')?.addEventListener('click', () => {
    // One 16ms step by hand — the virtual clock's whole point, and the way to
    // inspect a single frame without the pane needing to be displayed.
    bench.driver.advance(16);
    bench.driver._updateLegend();
  });

  // Second, independent listener on the shared <select>. Only ever SETS 'none'
  // on panels `lab.js` owns — never restores them, because `lab.js`'s own
  // listener re-shows `sunPanel` on any change. See fixture-lab.js's header.
  const effectSelect = document.getElementById('effect');
  const panel = document.getElementById('precipPanel');
  const applyEffectVisibility = (value) => {
    const isPrecip = value === 'precip';
    if (panel) panel.style.display = isPrecip ? '' : 'none';
    if (isPrecip) {
      const sunPanel = document.getElementById('sunPanel');
      const specPanel = document.getElementById('specPanel');
      if (sunPanel) sunPanel.style.display = 'none';
      if (specPanel) specPanel.style.display = 'none';
      void ensureInit();
    }
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  log('precipitation bench registered — select "Precipitation" to build its renderer.');
}

wire();
