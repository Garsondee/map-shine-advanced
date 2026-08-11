/** V4-Testament S1.6 — STAGE 1's BENCH GATE.
 *
 * Same-session flag-off/flag-on A/B of `perf-run-full` on First Floor (the real
 * two-floors-stacked case, same reasoning as S1.5's own pixel-diff). The plan's gate is
 * stated in GPU milliseconds (`geometry.worldDraw` 26.6 → ≤ 8ms) — but every perf-run-full
 * capture this session has `zones[].gpuMs === null` despite `method.gpu === 'timestamp-query'`
 * (docs/planning/Moonshot.md's own "Instrument note, honestly recorded", ~line 636; flagged
 * again as a separate follow-up task, not fixed here). This script reports GPU ms if the
 * instrument ever produces it, but does NOT block on it — CPU-side zone timing
 * (`cpuMs.meanMs`), captured same-session/same-content/same-resolution, is the honest
 * fallback signal, not a silent substitute pretending to be the GPU number the plan named.
 *
 * The historical "26.6ms" baseline itself predates the current Mansion Redux re-import
 * (Moonshot.md ~line 616: "new baseline for THIS content, not directly comparable") — so a
 * same-session A/B against TODAY's content is the methodologically sound comparison
 * regardless; chasing an exact resolution/viewport match to a stale number would prove
 * nothing real.
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import {
  bestEffortLogin,
  waitForGameReady,
  waitForCanvasReady,
  waitForMapShineReady,
  unpauseIfPaused,
  waitForSceneSettled,
} from '../../playwright/map-shine-utils.js';

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`));

const cdp = await context.newCDPSession(page);
await cdp.send('Network.clearBrowserCache');

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();
await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
await bestEffortLogin(page);
await waitForGameReady(page);
await waitForCanvasReady(page);
await waitForMapShineReady(page);
await unpauseIfPaused(page);

async function waitForMapArtLoaded(timeoutMs) {
  const start = Date.now();
  for (;;) {
    const st = await page.evaluate(async () => {
      try {
        const raw = await window.MapShine?.debug?.runReport?.('loading-screen-state');
        const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          showing: r?.showing !== false,
          complete: r?.current?.complete === true,
          error: r?.current?.error ?? null,
        };
      } catch (e) {
        return { showing: true, error: null };
      }
    });
    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return;
    if (Date.now() - start > timeoutMs)
      throw new Error(`Map art did not finish loading after ${Math.round((Date.now() - start) / 1000)}s`);
    await page.waitForTimeout(1000);
  }
}
console.log('[s1-bench] waiting for real map art…');
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'ground floor' });

const clicked = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('*')).filter(
    (el) => el.children.length === 0 && el.textContent?.trim() === 'First Floor'
  );
  if (!els.length) return { ok: false, reason: 'no "First Floor" control found' };
  els[0].click();
  return { ok: true };
});
console.log('[s1-bench] floor switch:', JSON.stringify(clicked));
if (!clicked.ok) throw new Error(clicked.reason);
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'first floor' });

const floorInfo = await page.evaluate(() => ({ id: canvas?.level?.id ?? null, name: canvas?.level?.name ?? null }));
console.log('[s1-bench] floor at time of measurement:', JSON.stringify(floorInfo));

async function runPerfCapture(label) {
  console.log(`[s1-bench] triggering perf-run-full (${label}) — this drives a camera path, ~2-4 minutes...`);
  const t0 = Date.now();
  const result = await page.evaluate(async () => {
    const action = window.MapShine?.debug?.actions?.get('perf-run-full');
    if (!action) return { ok: false, reason: 'perf-run-full action not found in registry' };
    try {
      const r = await action.fn();
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, reason: `action threw: ${e?.message ?? e}` };
    }
  });
  const elapsedS = Math.round((Date.now() - t0) / 1000);
  console.log(`[s1-bench] (${label}) action completed after ${elapsedS}s, ok=${result.ok}`);
  if (!result.ok) throw new Error(`perf-run-full (${label}) failed: ${JSON.stringify(result)}`);
  return { elapsedS, report: result.result };
}

function extractZone(report, id) {
  const z = (report?.zones || []).find((zz) => zz.id === id);
  if (!z) return null;
  return {
    cpuMeanMs: z.cpuMs?.meanMs ?? null,
    cpuMaxMs: z.cpuMs?.maxMs ?? null,
    gpuMeanMs: z.gpuMs?.meanMs ?? null,
    drawCalls: z.drawCalls ?? null,
    triangles: z.triangles ?? null,
  };
}

// ⚠️ FORCE THE FLAG OFF EXPLICITLY — NEVER ASSUME THE BOOT DEFAULT IS OFF
// (countersign fix, 2026-08-11): S1.7 flipped `earlyZComposition`'s default to
// TRUE, so "just capture whatever boot gave us" would silently diff ON against
// ON and pass vacuously. Record the initial state and restore THAT at the end
// — hardcoding `false` there has the mirror bug.
const initialFlag = await page.evaluate(() => window.MapShine?.getEarlyZComposition?.()?.earlyZComposition ?? null);
console.log('[s1-bench] initial flag state at boot:', JSON.stringify(initialFlag));
await page.evaluate(() => window.MapShine?.setEarlyZComposition?.(false));
// Same next-residency-pass mechanics as the ON flip below: nudge one, settle.
await page.mouse.wheel(0, -40);
await page.waitForTimeout(600);
await page.mouse.wheel(0, 40);
await waitForSceneSettled(page, { label: 'after forcing flag OFF' });

// FLAG OFF — baseline, today's shipping behaviour.
const off = await runPerfCapture('flag OFF');

// FLAG ON.
const flip = await page.evaluate(() => {
  const fn = window.MapShine?.setEarlyZComposition;
  if (typeof fn !== 'function') return { ok: false, reason: 'MapShine.setEarlyZComposition not found' };
  return { ok: true, result: fn(true) };
});
console.log('[s1-bench] flag ON:', JSON.stringify(flip));
if (!flip.ok) {
  console.error('[s1-bench] FAILED to flip the flag — aborting');
  await context.close();
  process.exit(1);
}
await page.mouse.wheel(0, -40);
await page.waitForTimeout(600);
await page.mouse.wheel(0, 40);
await waitForSceneSettled(page, { label: 'after flag flip' });
const stateOn = await page.evaluate(() => window.MapShine?.getEarlyZComposition?.());
console.log('[s1-bench] flag state + NON-VACUITY before ON capture:', JSON.stringify(stateOn));

const on = await runPerfCapture('flag ON');

// RESTORE THE INITIAL STATE (Law 3) — whatever boot gave us, not a hardcoded
// value that goes stale the next time the default changes.
await page.evaluate((v) => window.MapShine?.setEarlyZComposition?.(v === true), initialFlag);

const ZONE_IDS = ['geometry.worldDraw', 'geometry.depthDraw', 'geometry.depthRenderCall', 'geometry.doorDraw'];
const comparison = {};
for (const id of ZONE_IDS) {
  const offZ = extractZone(off.report, id);
  const onZ = extractZone(on.report, id);
  comparison[id] = {
    off: offZ,
    on: onZ,
    cpuMeanRatio: offZ?.cpuMeanMs && onZ?.cpuMeanMs ? +(onZ.cpuMeanMs / offZ.cpuMeanMs).toFixed(3) : null,
  };
}

const gpuAvailable = off.report?.method?.gpu === 'timestamp-query' && on.report?.method?.gpu === 'timestamp-query';
const worldDrawGpuOff = comparison['geometry.worldDraw']?.off?.gpuMeanMs;
const worldDrawGpuOn = comparison['geometry.worldDraw']?.on?.gpuMeanMs;
const gpuGateResult =
  gpuAvailable && worldDrawGpuOff != null && worldDrawGpuOn != null
    ? {
        worldDrawGpuOffMs: worldDrawGpuOff,
        worldDrawGpuOnMs: worldDrawGpuOn,
        gateThresholdMs: 8,
        gatePass: worldDrawGpuOn <= 8,
        speedup: worldDrawGpuOff / worldDrawGpuOn,
      }
    : {
        note:
          'GPU ms unavailable this run (method.gpu off=' +
          (off.report?.method?.gpu ?? 'null') +
          ' on=' +
          (on.report?.method?.gpu ?? 'null') +
          "). This is the SAME instrument gap Moonshot.md already flags — see this script's own header. " +
          'The plan\'s literal "GPU <=8ms" gate cannot be confirmed from this run; CPU-side comparison below is the honest fallback.',
      };

const summary = {
  floorInfo,
  offElapsedS: off.elapsedS,
  onElapsedS: on.elapsedS,
  nonVacuity: stateOn,
  zoneComparison: comparison,
  gpuGateResult,
  verdict:
    gpuGateResult.gatePass === true
      ? `GATE PASS — geometry.worldDraw GPU ${gpuGateResult.worldDrawGpuOnMs}ms <= 8ms (${gpuGateResult.speedup.toFixed(2)}x speedup from ${gpuGateResult.worldDrawGpuOffMs}ms)`
      : gpuGateResult.gatePass === false
        ? `GATE FAIL — geometry.worldDraw GPU ${gpuGateResult.worldDrawGpuOnMs}ms > 8ms threshold`
        : 'GATE UNCONFIRMED — GPU ms unavailable this run; see gpuGateResult.note and zoneComparison for CPU-side signal',
};
console.log('[s1-bench] VERDICT:', JSON.stringify(summary, null, 2));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 'stage1-earlyz-bench-result.json'),
  JSON.stringify(
    {
      summary,
      offReport: off.report,
      onReport: on.report,
      consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 60),
    },
    null,
    2
  )
);
console.log('[s1-bench] wrote stage1-earlyz-bench-result.json');

await context.close();
