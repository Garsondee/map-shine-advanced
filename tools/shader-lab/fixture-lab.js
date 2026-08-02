/**
 * SHADER LAB — page wiring for THE FIXTURE BENCH, and the install point for
 * the agent contract (`contract.js`).
 *
 * ============================================================================
 * WHY THIS IS A SEPARATE FILE AND NOT AN EDIT TO `lab.js`
 * ============================================================================
 * `lab.js` is 37 KB, owns the sun bench and the specular bench's wiring, and is
 * frequently being edited by another session while this one runs. The lightning
 * driver already established the safe pattern for adding a bench to the shared
 * page: a SECOND, independent `change` listener on the same `<select>`, its own
 * canvas, its own panel. DOM listeners on one element never collide, so a new
 * bench costs `lab.js` zero lines. This follows that pattern exactly.
 *
 * It also installs `window.lab` (the agent contract). Doing it here rather than
 * in `lab.js` keeps the same property: the contract can land, and benches can
 * register with it, without the god-file of the lab needing to know.
 *
 * @module tools/shader-lab/fixture-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createFixtureBench } from './bench-fixture.js';
import FIXTURE, { EXPLORE_SCALE } from './fixtures/tower-bridge.js';

const statusEl = document.getElementById('fixtureStatus');
const log = (msg) => {
  console.log('[fixture-lab]', msg);
  if (!statusEl) return;
  statusEl.textContent += `\n${msg}`;
  statusEl.scrollTop = statusEl.scrollHeight;
};

const contract = installContract();
const bench = createFixtureBench({ THREE, log });
window.fixtureBench = bench;

/** Fill the kind dropdown with only the kinds this floor actually has. */
function refreshKinds() {
  const floorId = document.getElementById('fixtureFloor').value;
  const kindSel = document.getElementById('fixtureKind');
  const available = FIXTURE.maskFiles.filter((e) => e.floorId === floorId);
  const previous = kindSel.value;
  kindSel.innerHTML = '';
  for (const e of available) {
    const opt = document.createElement('option');
    opt.value = e.kind;
    opt.textContent = `${e.kind}  (${e.channels})`;
    kindSel.appendChild(opt);
  }
  if (available.some((e) => e.kind === previous)) kindSel.value = previous;
}

function heldReadout() {
  const el = document.getElementById('fixtureHeld');
  if (el) el.textContent = `${bench.getHeldMegabytes()} MB held`;
}

async function loadAndShow() {
  const floorId = document.getElementById('fixtureFloor').value;
  const kind = document.getElementById('fixtureKind').value;
  const scale = Number(document.getElementById('fixtureScale').value);
  const entry = bench.entryFor(floorId, kind);
  if (!entry) {
    log(`no ${kind} mask on floor ${floorId}`);
    return;
  }
  log(`loading ${entry.file} at scale ${scale}…`);
  const rec = await bench.loadOne(entry, scale);
  if (!rec) {
    log(`FAILED to load ${entry.file}`);
    return;
  }
  bench.paint(rec);
  bench.setLegend(rec);
  heldReadout();
}

async function runSelectedScenario() {
  const name = document.getElementById('fixtureScenario').value;
  const scale = Number(document.getElementById('fixtureScale').value);
  log(`running scenario '${name}' at scale ${scale}…`);
  const report = await contract.run('fixture', name, { params: { scale } });
  const s = report.summary ?? {};
  log(
    `REPORT ${report.runId}\n` +
      `  ok=${report.ok}  pass=${s.pass} fail=${s.fail} UNMEASURED=${s.UNMEASURED}  (${report.timing?.totalMs}ms)\n` +
      report.checks
        .map((c) => `    ${c.status.padEnd(10)} ${c.id}${c.measured !== null ? `  measured=${JSON.stringify(c.measured)}` : ''}`)
        .join('\n') +
      (report.persistedTo ? `\n  saved -> ${report.persistedTo}` : `\n  NOT PERSISTED: ${report.persistError ?? 'unknown'}`)
  );
  heldReadout();
  return report;
}

function wire() {
  const floorSel = document.getElementById('fixtureFloor');
  for (const f of FIXTURE.floors) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = `${f.label} (index ${f.index})`;
    floorSel.appendChild(opt);
  }
  floorSel.value = 'middle';
  refreshKinds();
  floorSel.addEventListener('change', refreshKinds);

  const scenSel = document.getElementById('fixtureScenario');
  for (const name of bench.scenarios.keys()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    scenSel.appendChild(opt);
  }

  document.getElementById('fixtureLoad').addEventListener('click', () => loadAndShow());
  document.getElementById('fixtureRun').addEventListener('click', () => runSelectedScenario());
  document.getElementById('fixtureRelease').addEventListener('click', () => {
    bench.releaseAll();
    heldReadout();
  });

  // ── Second, independent listener on the shared <select> (see this file's
  // header). Only ever SETS 'none' on panels `lab.js` owns, never restores
  // them — `lab.js`'s own listener always re-shows `sunPanel` on any change,
  // so doing nothing in the not-fixture branch is what keeps the two from
  // fighting over the same style property. ──
  const effectSelect = document.getElementById('effect');
  const fixtureLeft = document.getElementById('fixtureLeft');
  const fixturePanel = document.getElementById('fixturePanel');
  const applyEffectVisibility = (value) => {
    const isFixture = value === 'fixture';
    if (fixtureLeft) fixtureLeft.style.display = isFixture ? '' : 'none';
    if (fixturePanel) fixturePanel.style.display = isFixture ? '' : 'none';
    if (isFixture) {
      const sunPanel = document.getElementById('sunPanel');
      const specPanel = document.getElementById('specPanel');
      if (sunPanel) sunPanel.style.display = 'none';
      if (specPanel) specPanel.style.display = 'none';
    }
  };
  effectSelect?.addEventListener('change', (e) => applyEffectVisibility(e.target.value));
  applyEffectVisibility(effectSelect?.value ?? 'sun-shadow');

  log(
    `fixture bench ready — ${FIXTURE.maskFiles.length} mask files, ${FIXTURE.floors.length} floors, ` +
      `native ${FIXTURE.native.width}x${FIXTURE.native.height}, explore scale ${EXPLORE_SCALE}.\n` +
      `agent door: window.lab.describe() / window.lab.run('fixture', '<scenario>')`
  );
}

wire();
