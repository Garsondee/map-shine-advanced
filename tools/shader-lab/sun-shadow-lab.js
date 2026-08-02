/**
 * SHADER LAB — page wiring for THE SUN-SHADOW BENCH.
 *
 * Same pattern as `derive-lab.js`: its own module, its own canvas, its own
 * panel, and a second independent `change` listener on the shared `#effect`
 * `<select>`. `lab.js` is untouched.
 *
 * ⚠️ DRIVES `layer-smear-real-floor` — THE CURRENT MODEL
 * (`docs/planning/Sun-Shadows-Layer-Smear.md`). An earlier version of this
 * file wired the "Run" button to the OLD `real-floor-march-vs-smear`
 * scenario (march + the retired averaged-mean smear) and was never updated
 * when the layer-smear model shipped — so every click was silently still
 * exercising deprecated code with a KNOWN, already-diagnosed bug
 * (`feedback_receiver_height_is_not_caster_height`). Found 2026-08-02 when
 * the author's live report of a floor-mixing artifact turned out to need
 * checking against the wrong scenario before it could mean anything. If you
 * are about to add a second scenario option here, wire it explicitly and
 * name which model it drives in the button label — a button whose label
 * says one thing and whose click handler does another is exactly this bug.
 *
 * @module tools/shader-lab/sun-shadow-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createSunShadowBench } from './bench-sun-shadow.js';
import FIXTURE from './fixtures/tower-bridge.js';

const statusEl = document.getElementById('sunShadowStatus');
const log = (msg) => {
  console.log('[sun-shadow-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createSunShadowBench({ THREE, log });
window.sunShadowBench = bench;

function readRange(id) {
  return Number(document.getElementById(id).value);
}

async function runSelected() {
  const floorId = document.getElementById('sunShadowFloor').value;
  const tier = Number(document.getElementById('sunShadowTier').value);
  const params = {
    floorId,
    tier,
    azimuthDeg: readRange('sunShadowAzimuth'),
    elevationDeg: readRange('sunShadowElevation'),
    wallHeightPx: readRange('sunShadowWallHeight'),
    overheadHeightPx: readRange('sunShadowOverheadHeight'),
    aboveHeightPx: readRange('sunShadowAboveHeight'),
    strengths: [
      readRange('sunShadowWallStrength'),
      readRange('sunShadowOverheadStrength'),
      readRange('sunShadowAboveStrength'),
      0.95,
    ],
    depthRadiusPx: [0, 0, readRange('sunShadowAboveDepth'), readRange('sunShadowHigherDepth')],
    falloffExp: readRange('sunShadowFalloffExp'),
    softnessMul: readRange('sunShadowSoftness'),
    basePx: readRange('sunShadowBase'),
    tipBlurMul: readRange('sunShadowTipBlur'),
  };
  log(
    `running layer-smear-real-floor on '${floorId}' (tier ${tier}, az=${params.azimuthDeg} el=${params.elevationDeg})…`
  );
  const report = await contract.run('sun-shadow', 'layer-smear-real-floor', { params });
  const s = report.summary ?? {};
  log(
    `REPORT ${report.runId}\n` +
      `  ok=${report.ok}  calibration=${report.calibration}  pass=${s.pass} fail=${s.fail} UNMEASURED=${s.UNMEASURED}  (${report.timing?.totalMs}ms)\n` +
      report.checks.map((c) => `    ${c.status.padEnd(10)} ${c.id} = ${JSON.stringify(c.measured)}`).join('\n')
  );
  const legend = document.getElementById('sunShadowLegend');
  if (legend && report.stats) {
    const law = report.stats.law ?? {};
    legend.textContent =
      `layer smear — ${report.inputs?.floorId ?? floorId} floor, tier ${tier}, ${report.stats.fieldDim ?? '?'}px field   ` +
      `holes: ${report.stats.holes}   THE LAW worst rise: ${law.worstRise ?? '?'}` +
      (law.worstAt ? ` at world(${law.worstAt.wx}, ${law.worstAt.wy})` : '');
  }
  return report;
}

function wire() {
  const floorSel = document.getElementById('sunShadowFloor');
  for (const f of FIXTURE.floors) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = `${f.label} (index ${f.index})`;
    floorSel.appendChild(opt);
  }
  // Lowest floor first — the one the author is actively looking at.
  floorSel.value = FIXTURE.floors[0]?.id ?? 'underground';

  const wireRange = (id, valId) => {
    const input = document.getElementById(id);
    const out = document.getElementById(valId);
    const show = () => {
      if (out) out.textContent = input.value;
    };
    input.addEventListener('input', show);
    show();
  };
  for (const [id, valId] of [
    ['sunShadowAzimuth', 'sunShadowAzimuthVal'],
    ['sunShadowElevation', 'sunShadowElevationVal'],
    ['sunShadowWallHeight', 'sunShadowWallHeightVal'],
    ['sunShadowOverheadHeight', 'sunShadowOverheadHeightVal'],
    ['sunShadowAboveHeight', 'sunShadowAboveHeightVal'],
    ['sunShadowWallStrength', 'sunShadowWallStrengthVal'],
    ['sunShadowOverheadStrength', 'sunShadowOverheadStrengthVal'],
    ['sunShadowAboveStrength', 'sunShadowAboveStrengthVal'],
    ['sunShadowAboveDepth', 'sunShadowAboveDepthVal'],
    ['sunShadowHigherDepth', 'sunShadowHigherDepthVal'],
    ['sunShadowFalloffExp', 'sunShadowFalloffExpVal'],
    ['sunShadowSoftness', 'sunShadowSoftnessVal'],
    ['sunShadowBase', 'sunShadowBaseVal'],
    ['sunShadowTipBlur', 'sunShadowTipBlurVal'],
  ]) {
    wireRange(id, valId);
  }

  document.getElementById('sunShadowRun').addEventListener('click', () => runSelected());

  const effectSelect = document.getElementById('effect');
  const sunShadowLeft = document.getElementById('sunShadowLeft');
  const sunShadowPanel = document.getElementById('sunShadowPanel');
  const applyEffectVisibility = (value) => {
    const isSunShadow = value === 'sun-shadow';
    if (sunShadowLeft) sunShadowLeft.style.display = isSunShadow ? '' : 'none';
    if (sunShadowPanel) sunShadowPanel.style.display = isSunShadow ? '' : 'none';
    if (isSunShadow) {
      const sunPanel = document.getElementById('sunPanel');
      const specPanel = document.getElementById('specPanel');
      if (sunPanel) sunPanel.style.display = 'none';
      if (specPanel) specPanel.style.display = 'none';
    }
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  log('sun-shadow bench ready — window.lab.run("sun-shadow", "layer-smear-real-floor")');
}

wire();
