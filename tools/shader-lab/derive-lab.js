/**
 * SHADER LAB — page wiring for THE DERIVATION BENCH.
 *
 * Same pattern as `fixture-lab.js`: its own module, its own canvas, its own
 * panel, and a second independent `change` listener on the shared `#effect`
 * `<select>`. `lab.js` is untouched.
 *
 * @module tools/shader-lab/derive-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createDeriveBench } from './bench-derive.js';
import FIXTURE from './fixtures/tower-bridge.js';

const statusEl = document.getElementById('deriveStatus');
const log = (msg) => {
  console.log('[derive-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createDeriveBench({ THREE, log });
window.deriveBench = bench;

async function runSelected() {
  const name = document.getElementById('deriveScenario').value;
  log(`running derive scenario '${name}'…`);
  const report = await contract.run('derive', name, {});
  const s = report.summary ?? {};
  log(
    `REPORT ${report.runId}\n` +
      `  ok=${report.ok}  pass=${s.pass} fail=${s.fail} UNMEASURED=${s.UNMEASURED}  (${report.timing?.totalMs}ms)\n` +
      report.checks.map((c) => `    ${c.status.padEnd(10)} ${c.id} = ${JSON.stringify(c.measured)}`).join('\n')
  );
  return report;
}

/** Pull one named channel out of a floor's derived products. */
function channelOf(product, name) {
  if (!product) return null;
  if (name in product.casterChannels) return product.casterChannels[name];
  return product[name] ?? null;
}

async function deriveAndShow() {
  const floorId = document.getElementById('deriveFloor').value;
  const channel = document.getElementById('deriveChannel').value;
  log(`deriving (this decodes the real art alpha for every floor)…`);
  const { products } = await bench.derive();
  const fx = FIXTURE.floors.find((f) => f.id === floorId);
  const p = products.find((x) => x.index === fx.index);
  const grid = channelOf(p, channel);
  if (!grid) {
    log(`no channel '${channel}' on floor ${floorId}`);
    return;
  }
  bench.paintGrid(grid, `${channel} — ${fx.label} (floor ${fx.index}), via the REAL deriveFloorProducts`);
  log(
    `${floorId}/${channel}: grid ${grid.w}x${grid.h}  maxCasterHeightPx=${p.completeness.maxCasterHeightPx}  ` +
      `skyReachItems=[${p.completeness.skyReachItemIds}]  overheadItems=[${p.completeness.overheadItemIds}]`
  );
}

function wire() {
  const floorSel = document.getElementById('deriveFloor');
  for (const f of FIXTURE.floors) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = `${f.label} (index ${f.index})`;
    floorSel.appendChild(opt);
  }
  floorSel.value = 'underground';

  const scenSel = document.getElementById('deriveScenario');
  for (const name of bench.scenarios.keys()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    scenSel.appendChild(opt);
  }

  document.getElementById('deriveRun').addEventListener('click', () => runSelected());
  document.getElementById('deriveShow').addEventListener('click', () => deriveAndShow());

  const effectSelect = document.getElementById('effect');
  const deriveLeft = document.getElementById('deriveLeft');
  const derivePanel = document.getElementById('derivePanel');
  const applyEffectVisibility = (value) => {
    const isDerive = value === 'derive';
    if (deriveLeft) deriveLeft.style.display = isDerive ? '' : 'none';
    if (derivePanel) derivePanel.style.display = isDerive ? '' : 'none';
    if (isDerive) {
      const sunPanel = document.getElementById('sunPanel');
      const specPanel = document.getElementById('specPanel');
      if (sunPanel) sunPanel.style.display = 'none';
      if (specPanel) specPanel.style.display = 'none';
    }
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  log('derive bench ready — window.lab.run("derive", "multi-floor-bands")');
}

wire();
