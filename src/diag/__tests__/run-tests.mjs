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
import { run as runCacheReport } from './cache-report.test.mjs';
import { run as runPerfStructuralAB } from './perf-structural-ab.test.mjs';
import { run as runPerfSharpeningAB } from './perf-sharpening-ab.test.mjs';
import { run as runPerfShaderVariantAB } from './perf-shader-variant-ab.test.mjs';
import { run as runVramInventory } from './vram-inventory.test.mjs';
import { run as runFrameProfiler } from './frame-profiler.test.mjs';
import { run as runGpuZoneTimer } from './gpu-zone-timer.test.mjs';
import { run as runPerfSession } from './perf-session.test.mjs';
import { run as runPerfHud } from './perf-hud.test.mjs';
import { run as runPerfStrip } from './perf-strip.test.mjs';
import { run as runWindFieldOverlay } from './wind-field-overlay.test.mjs';
import { run as runWindProbe } from './wind-probe.test.mjs';
import { run as runEffectControls } from './effect-controls.test.mjs';
import { run as runSettingsPanel } from './settings-panel.test.mjs';
import { run as runRenderFallback } from './render-fallback.test.mjs';
import { run as runShaderRebuildProbe } from './shader-rebuild-probe.test.mjs';
import { run as runPipelineRebuildProbe } from './pipeline-rebuild-probe.test.mjs';
import { run as runReckoningReport } from './reckoning-report.test.mjs';
import { run as runParamReadHealth } from './param-read-health.test.mjs';
import { run as runUiPerf } from './ui-perf.test.mjs';

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
  ['cache-report', runCacheReport],
  ['perf-structural-ab', runPerfStructuralAB],
  ['perf-sharpening-ab', runPerfSharpeningAB],
  ['perf-shader-variant-ab', runPerfShaderVariantAB],
  ['vram-inventory', runVramInventory],
  ['frame-profiler', runFrameProfiler],
  ['gpu-zone-timer', runGpuZoneTimer],
  ['perf-session', runPerfSession],
  ['perf-hud', runPerfHud],
  ['perf-strip', runPerfStrip],
  ['wind-field-overlay', runWindFieldOverlay],
  ['wind-probe', runWindProbe],
  ['effect-controls', runEffectControls],
  ['settings-panel', runSettingsPanel],
  ['render-fallback', runRenderFallback],
  ['shader-rebuild-probe', runShaderRebuildProbe],
  ['pipeline-rebuild-probe', runPipelineRebuildProbe],
  ['reckoning-report', runReckoningReport],
  ['param-read-health', runParamReadHealth],
  ['ui-perf', runUiPerf],
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
