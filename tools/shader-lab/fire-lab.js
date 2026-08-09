/**
 * SHADER LAB — page wiring for THE FIRE BENCH (rung 1).
 *
 * Its own module, own canvas, own panel, and a second independent `change`
 * listener on the shared `#effect` select — the pattern `fixture-lab.js`
 * established and AGENTS.md §5 requires. `lab.js` costs zero lines.
 *
 * ⚠️ This bench builds its OWN WebGPURenderer with `trackTimestamp: true`.
 * That flag is constructor-only in the vendored three, so it cannot borrow
 * another bench's renderer and arm it afterwards.
 *
 * @module tools/shader-lab/fire-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createFireBench } from './bench-fire.js';

const statusEl = document.getElementById('fireStatus');
const log = (msg) => {
  console.log('[fire-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createFireBench({ THREE, log });
window.fireBench = bench;

function setLegend(text) {
  const el = document.getElementById('fireLegend');
  if (el) el.textContent = text;
}

async function runSelected() {
  const name = document.getElementById('fireScenario').value;
  log(`running fire scenario '${name}' — this renders ${'~'}400 timed frames, give it a moment…`);
  setLegend(`running '${name}'…`);
  const report = await contract.run('fire', name, {});
  const s = report.summary ?? {};
  log(
    `REPORT ${report.runId}\n` +
      `  ok=${report.ok}  pass=${s.pass} fail=${s.fail} UNMEASURED=${s.UNMEASURED}  (${report.timing?.totalMs}ms)\n` +
      report.checks
        .map((c) => `    ${c.status.padEnd(10)} ${c.id}${c.measured !== null ? ` = ${JSON.stringify(c.measured)}` : ''}`)
        .join('\n') +
      (report.stats?.verdict ? `\n  VERDICT: ${report.stats.verdict}` : '') +
      (report.stats?.msPerMpxPerLatticeHash
        ? `\n  measured ms/Mpx per lattice hash: ${report.stats.msPerMpxPerLatticeHash}`
        : '') +
      (report.persistedTo ? `\n  saved -> ${report.persistedTo}` : `\n  NOT PERSISTED: ${report.persistError ?? 'unknown'}`)
  );
  setLegend(
    report.stats?.verdict
      ? `fbmFloat, live third coordinate, 3 octaves — VERDICT ${report.stats.verdict}`
      : `scenario '${name}' complete`
  );
  return report;
}

function wire() {
  const scenSel = document.getElementById('fireScenario');
  for (const name of bench.scenarios.keys()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    scenSel.appendChild(opt);
  }
  document.getElementById('fireRun').addEventListener('click', () => runSelected());

  // Second, independent listener on the shared <select>. Only ever SETS 'none'
  // on panels `lab.js` owns — never restores them, because `lab.js`'s own
  // listener re-shows `sunPanel` on any change. See fixture-lab.js's header.
  const effectSelect = document.getElementById('effect');
  const firePanel = document.getElementById('firePanel');
  const applyEffectVisibility = (value) => {
    const isFire = value === 'fire';
    if (firePanel) firePanel.style.display = isFire ? '' : 'none';
    if (isFire) {
      const sunPanel = document.getElementById('sunPanel');
      const specPanel = document.getElementById('specPanel');
      if (sunPanel) sunPanel.style.display = 'none';
      if (specPanel) specPanel.style.display = 'none';
    }
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  setLegend('no probe rendered yet');
  log(
    `fire bench ready — measures the real fbmFloat at 1024², 8 evaluations/fragment.\n` +
      `window.lab.run('fire', 'noise-fold-ab')  ← run this FIRST; it gates every slice count in the design\n` +
      `window.lab.run('fire', 'octave-cost-curve')`
  );
}

wire();
