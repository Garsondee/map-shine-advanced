/**
 * SHADER LAB — page wiring for the Albedo Clarity (CAS sharpen) bench.
 *
 * Same pattern as `block-compress-lab.js`: its own module, its own panel, and
 * a second independent `change` listener on the shared `#effect` `<select>`.
 * `lab.js` is untouched. No view canvas — like `block-compress`, this bench
 * is pixel-comparison-driven, not something that wants a persistent on-screen
 * render (comparison PNGs save as artifacts instead, per AGENTS.md rule 4).
 *
 * @module tools/shader-lab/albedo-clarity-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createAlbedoClarityBench } from './bench-albedo-clarity.js';

const statusEl = document.getElementById('albedoClarityStatus');
const log = (msg) => {
  console.log('[albedo-clarity-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createAlbedoClarityBench({ THREE, log });
window.albedoClarityBench = bench;

async function runSelected() {
  const name = document.getElementById('albedoClarityScenario').value;
  log(`running albedo-clarity scenario '${name}'…`);
  const report = await contract.run('albedo-clarity', name, {});
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
  const scenSel = document.getElementById('albedoClarityScenario');
  if (scenSel) {
    for (const name of bench.scenarios.keys()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      scenSel.appendChild(opt);
    }
  }
  document.getElementById('albedoClarityRun')?.addEventListener('click', () => runSelected());

  const effectSelect = document.getElementById('effect');
  const panel = document.getElementById('albedoClarityPanel');
  const applyEffectVisibility = (value) => {
    const mine = value === 'albedo-clarity';
    if (panel) panel.style.display = mine ? '' : 'none';
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  log('albedo-clarity bench ready — window.lab.run("albedo-clarity", "does-sharpening-amplify-bc1-noise")');
}

wire();
