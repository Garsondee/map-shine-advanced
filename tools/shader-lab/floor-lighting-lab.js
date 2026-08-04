/**
 * SHADER LAB — page wiring for THE MULTI-FLOOR LIGHTING BENCH.
 *
 * Same pattern as `derive-lab.js`/`fixture-lab.js`: its own module, its own
 * canvas, its own panel, and a second independent `change` listener on the
 * shared `#effect` `<select>`. `lab.js` is untouched (it is large and another
 * session is often editing it).
 *
 * @module tools/shader-lab/floor-lighting-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createFloorLightingBench } from './bench-floor-lighting.js';

const statusEl = document.getElementById('floorLightStatus');
const log = (msg) => {
  console.log('[floor-lighting-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createFloorLightingBench({ THREE, log });
window.floorLightingBench = bench;

async function runSelected() {
  const name = document.getElementById('floorLightScenario').value;
  log(`running floor-lighting scenario '${name}'…`);
  const report = await contract.run('floor-lighting', name, {});
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
  const scenSel = document.getElementById('floorLightScenario');
  if (scenSel) {
    for (const name of bench.scenarios.keys()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      scenSel.appendChild(opt);
    }
  }
  document.getElementById('floorLightRun')?.addEventListener('click', () => runSelected());

  const effectSelect = document.getElementById('effect');
  const left = document.getElementById('floorLightLeft');
  const panel = document.getElementById('floorLightPanel');
  const applyEffectVisibility = (value) => {
    const mine = value === 'floor-lighting';
    if (left) left.style.display = mine ? '' : 'none';
    if (panel) panel.style.display = mine ? '' : 'none';
    if (mine) {
      for (const id of ['sunPanel', 'specPanel', 'derivePanel', 'deriveLeft']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      }
    }
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  log('floor-lighting bench ready — window.lab.run("floor-lighting", "gate-reads-the-attr-buffer")');
}

wire();
