/**
 * SHADER LAB — page wiring for THE BLEND BENCH (rung 3).
 *
 * No canvas: this bench measures blend algebra and MRT behaviour, both of which
 * are numbers rather than pictures. It gets a status pane and a run button, and
 * everything else goes through `window.lab.run('blend', …)`.
 *
 * @module tools/shader-lab/blend-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createBlendBench } from './bench-blend.js';

const statusEl = document.getElementById('blendStatus');
const log = (msg) => {
  console.log('[blend-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createBlendBench({ THREE, log });
window.blendBench = bench;

async function runSelected() {
  const name = document.getElementById('blendScenario').value;
  log(`running blend scenario '${name}'…`);
  const report = await contract.run('blend', name, {});
  const s = report.summary ?? {};
  log(
    `REPORT ${report.runId}\n` +
      `  ok=${report.ok}  pass=${s.pass} fail=${s.fail} UNMEASURED=${s.UNMEASURED}  (${report.timing?.totalMs}ms)\n` +
      report.checks.map((c) => `    ${c.status.padEnd(10)} ${c.id} = ${JSON.stringify(c.measured)}`).join('\n')
  );
  return report;
}

function wire() {
  const scenSel = document.getElementById('blendScenario');
  for (const name of bench.scenarios.keys()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    scenSel.appendChild(opt);
  }
  document.getElementById('blendRun').addEventListener('click', () => runSelected());

  const effectSelect = document.getElementById('effect');
  const blendLeft = document.getElementById('blendLeft');
  const blendPanel = document.getElementById('blendPanel');
  const applyEffectVisibility = (value) => {
    const isBlend = value === 'blend';
    if (blendLeft) blendLeft.style.display = isBlend ? '' : 'none';
    if (blendPanel) blendPanel.style.display = isBlend ? '' : 'none';
    if (isBlend) {
      const sunPanel = document.getElementById('sunPanel');
      const specPanel = document.getElementById('specPanel');
      if (sunPanel) sunPanel.style.display = 'none';
      if (specPanel) specPanel.style.display = 'none';
    }
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  log(
    `blend bench ready — ${bench.BLENDS.length} production blend modes.\n` +
      `window.lab.run('blend', 'neutral-element-per-blend' | 'mrt-attachment-shares-the-blend')`
  );
}

wire();
