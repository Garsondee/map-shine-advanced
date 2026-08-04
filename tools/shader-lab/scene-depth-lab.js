/**
 * SHADER LAB — page wiring for THE DEPTH AUTHORITY'S GPU HALF.
 *
 * Same pattern as `floor-lighting-lab.js`/`derive-lab.js`: its own module, its
 * own canvas, its own panel, and a second independent `change` listener on
 * the shared `#effect` `<select>`. `lab.js` is untouched.
 *
 * @module tools/shader-lab/scene-depth-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createSceneDepthBench } from './bench-scene-depth.js';

const statusEl = document.getElementById('sceneDepthStatus');
const log = (msg) => {
  console.log('[scene-depth-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createSceneDepthBench({ THREE, log });
window.sceneDepthBench = bench;

async function runSelected() {
  const name = document.getElementById('sceneDepthScenario').value;
  log(`running scene-depth scenario '${name}'…`);
  const report = await contract.run('scene-depth', name, {});
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
  const scenSel = document.getElementById('sceneDepthScenario');
  if (scenSel) {
    for (const name of bench.scenarios.keys()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      scenSel.appendChild(opt);
    }
  }
  document.getElementById('sceneDepthRun')?.addEventListener('click', () => runSelected());

  const effectSelect = document.getElementById('effect');
  const left = document.getElementById('sceneDepthLeft');
  const panel = document.getElementById('sceneDepthPanel');
  const applyEffectVisibility = (value) => {
    const mine = value === 'scene-depth';
    if (left) left.style.display = mine ? '' : 'none';
    if (panel) panel.style.display = mine ? '' : 'none';
    if (mine) {
      for (const id of ['sunPanel', 'specPanel', 'derivePanel', 'deriveLeft', 'floorLightLeft', 'floorLightPanel']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      }
    }
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  log('scene-depth bench ready — window.lab.run("scene-depth", "order-independence")');
}

wire();
