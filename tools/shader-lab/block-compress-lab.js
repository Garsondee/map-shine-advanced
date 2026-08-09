/**
 * SHADER LAB — page wiring for the BC1/BC7 hardware-parity bench.
 *
 * Same pattern as `scene-depth-lab.js`: its own module, its own panel, and a
 * second independent `change` listener on the shared `#effect` `<select>`.
 * `lab.js` is untouched.
 *
 * @module tools/shader-lab/block-compress-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createBlockCompressBench } from './bench-block-compress.js';

const statusEl = document.getElementById('blockCompressStatus');
const log = (msg) => {
  console.log('[block-compress-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createBlockCompressBench({ THREE, log });
window.blockCompressBench = bench;

async function runSelected() {
  const name = document.getElementById('blockCompressScenario').value;
  log(`running block-compress scenario '${name}'…`);
  const report = await contract.run('block-compress', name, {});
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
  const scenSel = document.getElementById('blockCompressScenario');
  if (scenSel) {
    for (const name of bench.scenarios.keys()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      scenSel.appendChild(opt);
    }
  }
  document.getElementById('blockCompressRun')?.addEventListener('click', () => runSelected());

  const effectSelect = document.getElementById('effect');
  const panel = document.getElementById('blockCompressPanel');
  const applyEffectVisibility = (value) => {
    const mine = value === 'block-compress';
    if (panel) panel.style.display = mine ? '' : 'none';
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  log('block-compress bench ready — window.lab.run("block-compress", "mode7-matches-hardware")');
}

wire();
