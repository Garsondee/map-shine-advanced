/**
 * WINDOW RAIN LAB - page wiring for `bench-window-rain.js`.
 *
 * Two ways in, deliberately:
 *   - SCENARIOS, through the contract, for the assertions (`window.lab.run`).
 *   - LIVE SLIDERS, for the eye. This is a LOOK feature; a pass/fail list cannot
 *     say whether it reads as rain on a window pane or as noise, and only the
 *     first is worth shipping.
 *
 * The dial sliders are generated from the effect's own `WINDOW_PARAMS` (the
 * `Rain` category), so a dial added to the effect appears here with no edit.
 *
 * @module tools/shader-lab/window-rain-lab
 */

import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createWindowRainBench } from './bench-window-rain.js';
import { WINDOW_PARAMS } from '../../src/effects/window/window.js';

const statusEl = document.getElementById('windowRainStatus');
const log = (msg) => {
  console.log('[window-rain-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createWindowRainBench({ THREE, log });
window.windowRainBench = bench;

/** The weather the sliders drive. `key` indexes `bench.state` directly. */
const WEATHER = [
  { key: 'rain01', label: 'Rain', min: 0, max: 1, step: 0.01 },
  { key: 'wet01', label: 'Glass wetness', min: 0, max: 1, step: 0.01 },
  { key: 'clock', label: 'Time (s)', min: 0, max: 200, step: 0.05 },
  { key: 'slideClock', label: 'Slide clock (s)', min: 0, max: 200, step: 0.05 },
  { key: 'windSpeed01', label: 'Wind speed', min: 0, max: 1, step: 0.01 },
  { key: 'windDirDeg', label: 'Wind bearing (deg)', min: 0, max: 359, step: 1 },
  { key: 'gust01', label: 'Gustiness', min: 0, max: 1, step: 0.01 },
];

/** The `Rain` category of `WINDOW_PARAMS`, keyed to the bench's `look` object. */
const DIALS = Object.entries(WINDOW_PARAMS)
  .filter(([, p]) => p.category === 'Rain')
  .map(([key, p]) => ({
    key,
    // `rainDropScalePx` -> `dropScalePx`, `rainCornerEasePx` -> bench `easePx` (a flow-field input, not a uniform)
    look: key === 'rainCornerEasePx' ? null : key.charAt(4).toLowerCase() + key.slice(5),
    label: p.label,
    min: p.min,
    max: p.max,
    step: p.step,
    value: p.default,
    help: p.help,
  }));

let refreshQueued = false;
/** Coalesce drags into one render - a slider fires far faster than a WebGPU frame round-trips. */
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

function slider(host, { label, min, max, step, value, title }, onInput) {
  const wrap = document.createElement('label');
  if (title) wrap.title = title;
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const val = document.createElement('span');
  val.textContent = String(value);
  val.style.color = '#8f8';
  input.addEventListener('input', () => {
    val.textContent = input.value;
    onInput(Number(input.value));
  });
  wrap.append(name, input, val);
  host.appendChild(wrap);
  return { input, val };
}

const weatherSliders = {};
function buildWeather(host) {
  for (const w of WEATHER) {
    weatherSliders[w.key] = slider(host, { ...w, value: bench.state[w.key] }, (v) => {
      bench.state[w.key] = v;
      queueRefresh();
    });
  }
}

function buildDials(host) {
  for (const d of DIALS) {
    slider(host, { ...d, title: d.help }, (v) => {
      if (d.look) bench.state.look[d.look] = v;
      else bench.setEase(v);
      queueRefresh();
    });
  }
}

function buildChannels(host) {
  const sel = document.createElement('select');
  for (const c of bench.channels) {
    const opt = document.createElement('option');
    opt.value = String(c.n);
    opt.textContent = c.label;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    bench.state.debugChannel = Number(sel.value);
    const ch = bench.channels.find((c) => c.n === bench.state.debugChannel);
    if (ch?.reads) log(`ch ${ch.n} - ${ch.reads}`);
    queueRefresh();
  });
  host.appendChild(sel);
}

let playing = false;
let lastTick = 0;
function playLoop(now) {
  if (!playing) return;
  const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0;
  lastTick = now;
  bench.state.clock += dt;
  bench.state.slideClock += dt * (0.55 + 0.95 * bench.state.rain01);
  weatherSliders.clock.input.value = String(bench.state.clock % 200);
  weatherSliders.slideClock.input.value = String(bench.state.slideClock % 200);
  bench
    .refresh()
    .catch((err) => log(`play failed: ${err.message}`))
    .finally(() => requestAnimationFrame(playLoop));
}

async function runSelected() {
  const name = document.getElementById('windowRainScenario').value;
  log(`running window-rain scenario '${name}'...`);
  const report = await contract.run('window-rain', name, {});
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
  const scenSel = document.getElementById('windowRainScenario');
  for (const name of bench.scenarios.keys()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    scenSel.appendChild(opt);
  }
  document.getElementById('windowRainRun').addEventListener('click', () => runSelected());
  document.getElementById('windowRainDraw').addEventListener('click', () => queueRefresh());
  document.getElementById('windowRainPlay').addEventListener('click', (e) => {
    playing = !playing;
    e.target.textContent = playing ? 'Pause' : 'Play';
    lastTick = 0;
    if (playing) requestAnimationFrame(playLoop);
  });
  document.getElementById('windowRainTier').addEventListener('change', (e) => {
    bench.state.glass = e.target.value === 'glass';
    queueRefresh();
  });
  buildWeather(document.getElementById('windowRainWeather'));
  buildDials(document.getElementById('windowRainDials'));
  buildChannels(document.getElementById('windowRainChannel'));
  queueRefresh();
  log('window-rain bench ready - window.lab.run("window-rain", "twin-parity")');
}

wire();
