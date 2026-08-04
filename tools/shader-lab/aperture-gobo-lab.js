/**
 * SHADER LAB — page wiring for THE APERTURE GOBO BENCH.
 *
 * Same pattern as `floor-lighting-lab.js`/`derive-lab.js`: its own module,
 * its own canvas, its own panel, and a second independent `change` listener
 * on the shared `#effect` `<select>`. `lab.js` is untouched.
 *
 * @module tools/shader-lab/aperture-gobo-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createApertureGoboBench } from './bench-aperture-gobo.js';

const statusEl = document.getElementById('apertureGoboStatus');
const log = (msg) => {
  console.log('[aperture-gobo-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createApertureGoboBench({ THREE, log });
window.apertureGoboBench = bench;

async function runSelected() {
  const name = document.getElementById('apertureGoboScenario').value;
  log(`running aperture-gobo scenario '${name}'…`);
  const report = await contract.run('aperture-gobo', name, {});
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
  const scenSel = document.getElementById('apertureGoboScenario');
  if (scenSel) {
    for (const name of bench.scenarios.keys()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      scenSel.appendChild(opt);
    }
  }
  document.getElementById('apertureGoboRun')?.addEventListener('click', () => runSelected());

  const effectSelect = document.getElementById('effect');
  const panel = document.getElementById('apertureGoboPanel');
  const applyPanelVisibility = (value) => {
    if (panel) panel.style.display = value === 'aperture-gobo' ? '' : 'none';
  };
  effectSelect?.addEventListener('change', (e) => applyPanelVisibility(e.target.value));
  applyPanelVisibility(effectSelect?.value ?? 'sun-shadow');

  log(
    'aperture-gobo bench ready — window.lab.run("aperture-gobo", "night-clear-pattern") or ' +
      'window.lab.run("aperture-gobo", "night-clear-pattern", {params:{apParams:{...}, darkness01:0.95}})'
  );
}

wire();
