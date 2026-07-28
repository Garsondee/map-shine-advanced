/**
 * src/diag/ verification. Pure logic only — the probe's DIAGNOSIS is testable
 * under Node even though the render it diagnoses is not.
 *
 * Run: `node src/diag/__tests__/run-tests.mjs`
 */
import { run as runOrientationProbe } from './orientation-probe.test.mjs';
import { run as runFlightRecorder } from './flight-recorder.test.mjs';
import { run as runPixelProbe } from './pixel-probe.test.mjs';
import { run as runMarkerOverlay } from './marker-overlay.test.mjs';
import { run as runGpuProbe } from './gpu-probe.test.mjs';
import { run as runPerfLab } from './perf-lab.test.mjs';
import { run as runPerfZones } from './perf-zones.test.mjs';
import { run as runPerfReport } from './perf-report.test.mjs';
import { run as runVramInventory } from './vram-inventory.test.mjs';
import { run as runFrameProfiler } from './frame-profiler.test.mjs';
import { run as runGpuZoneTimer } from './gpu-zone-timer.test.mjs';
import { run as runPerfSession } from './perf-session.test.mjs';
import { run as runPerfHud } from './perf-hud.test.mjs';
import { run as runWindFieldOverlay } from './wind-field-overlay.test.mjs';
import { run as runWindProbe } from './wind-probe.test.mjs';
import { run as runEffectControls } from './effect-controls.test.mjs';

let passed = 0;
let failed = 0;
const fails = [];

const t = {
  ok(name, cond) {
    if (cond) {
      passed++;
    } else {
      failed++;
      fails.push(name);
      console.error('  FAIL:', name);
    }
  },
};

const suites = [
  ['orientation-probe', runOrientationProbe],
  ['flight-recorder', runFlightRecorder],
  ['pixel-probe', runPixelProbe],
  ['marker-overlay', runMarkerOverlay],
  ['gpu-probe', runGpuProbe],
  ['perf-lab', runPerfLab],
  ['perf-zones', runPerfZones],
  ['perf-report', runPerfReport],
  ['vram-inventory', runVramInventory],
  ['frame-profiler', runFrameProfiler],
  ['gpu-zone-timer', runGpuZoneTimer],
  ['perf-session', runPerfSession],
  ['perf-hud', runPerfHud],
  ['wind-field-overlay', runWindFieldOverlay],
  ['wind-probe', runWindProbe],
  ['effect-controls', runEffectControls],
];

for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : `${failed - before} FAILED`}`);
}

console.log(`\nsrc/diag verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
