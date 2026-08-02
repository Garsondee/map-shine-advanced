/**
 * SHADER LAB — page wiring for THE COMPOSITE BENCH (rung 3).
 *
 * Same convention as `fixture-lab.js` and `derive-lab.js`: its own module, its
 * own canvas, its own panel, a second independent listener on the shared
 * `#effect` select. `lab.js` untouched.
 *
 * @module tools/shader-lab/composite-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createCompositeBench } from './bench-composite.js';

const statusEl = document.getElementById('compositeStatus');
const log = (msg) => {
  console.log('[composite-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createCompositeBench({ THREE, log });
window.compositeBench = bench;

async function runSelected() {
  const name = document.getElementById('compositeScenario').value;
  log(`running composite scenario '${name}'…`);
  const report = await contract.run('composite', name, {});
  const s = report.summary ?? {};
  log(
    `REPORT ${report.runId}\n` +
      `  ok=${report.ok}  pass=${s.pass} fail=${s.fail} UNMEASURED=${s.UNMEASURED}  (${report.timing?.totalMs}ms)\n` +
      report.checks.map((c) => `    ${c.status.padEnd(10)} ${c.id} = ${JSON.stringify(c.measured)}`).join('\n')
  );
  return report;
}

async function probeOnce() {
  const a = Number(document.getElementById('compAlbedo').value);
  const i = Number(document.getElementById('compIllum').value);
  const c = Number(document.getElementById('compColoration').value);
  const got = await bench.compositeOnce(a, i, c);
  const want = bench.gammaComposite(a, i, c);
  const naive = bench.linearComposite(a, i, c);
  log(
    `probe albedo=${a} illum=${i} coloration=${c}\n` +
      `  GPU        = ${got.r.toFixed(5)}\n` +
      `  gamma model= ${want.toFixed(5)}  (Δ ${Math.abs(got.r - want).toExponential(2)})\n` +
      `  linear model=${naive.toFixed(5)}  (the model that would be WRONG)`
  );
  await bench.paintSweep();
}

function wireRange(id, decimals) {
  const el = document.getElementById(id);
  const valEl = document.getElementById(`${id}Val`);
  const show = () => {
    if (valEl) valEl.textContent = Number(el.value).toFixed(decimals);
  };
  show();
  el.addEventListener('input', show);
}

function wire() {
  const scenSel = document.getElementById('compositeScenario');
  for (const name of bench.scenarios.keys()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    scenSel.appendChild(opt);
  }
  wireRange('compAlbedo', 3);
  wireRange('compIllum', 3);
  wireRange('compColoration', 3);
  document.getElementById('compositeRun').addEventListener('click', () => runSelected());
  document.getElementById('compositeProbe').addEventListener('click', () => probeOnce());

  const effectSelect = document.getElementById('effect');
  const compositeLeft = document.getElementById('compositeLeft');
  const compositePanel = document.getElementById('compositePanel');
  const applyEffectVisibility = (value) => {
    const isComposite = value === 'composite';
    if (compositeLeft) compositeLeft.style.display = isComposite ? '' : 'none';
    if (compositePanel) compositePanel.style.display = isComposite ? '' : 'none';
    if (isComposite) {
      const sunPanel = document.getElementById('sunPanel');
      const specPanel = document.getElementById('specPanel');
      if (sunPanel) sunPanel.style.display = 'none';
      if (specPanel) specPanel.style.display = 'none';
    }
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  log('composite bench ready (renderer is created lazily on first run) — window.lab.run("composite", "noon-is-a-no-op")');
}

wire();
