/** V4-Testament Stage 0: "the 7.7ms CPU mystery" migration experiment. Arms
 * `MapShine.setDebugFirstRenderProbe(true)` (a dummy 1-triangle render() inserted
 * immediately before the depth pass, see runSceneDepthPass's own comment in
 * vt-pan-viewer.js), then runs the real perf-run-full capture. Reads back BOTH
 * the new `geometry.debugFirstRenderProbe` zone and the existing
 * `geometry.depthRenderCall` zone from the SAME report — no separate baseline
 * run needed, since the question is "which of these two costs the ~7.7ms",
 * answered by comparing two zones inside one capture.
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import { bestEffortLogin, waitForGameReady, waitForCanvasReady, waitForMapShineReady, unpauseIfPaused } from '../../playwright/map-shine-utils.js';

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = context.pages()[0] || (await context.newPage());
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`));

// This persistent profile caches ES modules across runs (that's WHY it's persistent — see the
// BC-cache comment at the top of msa-look.spec.js). src/vt/vt-pan-viewer.js was JUST edited this
// session to add the debug flags this script needs; without a fresh fetch, the browser can
// silently keep serving the pre-edit module (the exact "stale ES module" trap
// reference_shader_lab_tool already documents for the shader lab's own navigate()).
// ⚠️ ONE-TIME clear, NOT `Network.setCacheDisabled` left on for the session — this is an
// unbundled, many-file ES-module codebase, and Foundry loads MSA's entire module during its OWN
// boot (before game.ready). Leaving caching off for the whole session was tried first and hung
// game.ready past 90s: hundreds of module fetches queued behind Chrome's per-origin connection
// limit instead of resolving instantly from cache. A one-time clear forces THIS load fresh, then
// lets normal caching resume for the flood of requests that follow.
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
// waitForMapShineReady only confirms the MODULE booted (MapShine.__keyholeBooted) — NOT that the
// real 12,000px map art finished decoding (msa-look.spec.js's own waitForMapArtLoaded exists
// specifically because those are two different things). Wait on the real loading-screen signal
// too, same as msa-look.spec.js, so this script never races ahead of what's actually on screen.
async function waitForMapArtLoaded(timeoutMs) {
  const start = Date.now();
  for (;;) {
    const st = await page.evaluate(async () => {
      try {
        const raw = await window.MapShine?.debug?.runReport?.('loading-screen-state');
        const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return { showing: r?.showing !== false, complete: r?.current?.complete === true, error: r?.current?.error ?? null };
      } catch (e) {
        return { showing: true, error: null };
      }
    });
    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Map art did not finish loading after ${Math.round((Date.now() - start) / 1000)}s`);
    await page.waitForTimeout(1000);
  }
}
console.log('[cpu-mystery] waiting for real map art to finish loading...');
await waitForMapArtLoaded(600000);
console.log('[cpu-mystery] map art loaded — settling before measurement...');
await page.waitForTimeout(8000);

const floorInfo = await page.evaluate(() => ({ id: canvas?.level?.id ?? null, name: canvas?.level?.name ?? null }));
console.log('[cpu-mystery] floor at time of measurement:', JSON.stringify(floorInfo));

const armResult = await page.evaluate(() => {
  const fn = window.MapShine?.setDebugFirstRenderProbe;
  if (typeof fn !== 'function') {
    return {
      ok: false,
      reason: 'MapShine.setDebugFirstRenderProbe not found',
      diagnostic: {
        hasMapShine: typeof window.MapShine,
        keyholeBooted: window.MapShine?.__keyholeBooted,
        version: window.MapShine?.version,
        hasSetGpuProbe: typeof window.MapShine?.setGpuProbe,
        hasSetGpuZoneTimer: typeof window.MapShine?.setGpuZoneTimer,
        allKeys: Object.keys(window.MapShine || {}).sort(),
      },
    };
  }
  fn(true);
  return { ok: true };
});
console.log('[cpu-mystery] armed debugFirstRenderProbe:', JSON.stringify(armResult, null, 2));
if (!armResult.ok) {
  console.error('[cpu-mystery] FAILED to arm probe — aborting');
  await context.close();
  process.exit(1);
}
await page.waitForTimeout(1000);

console.log('[cpu-mystery] running perf-run-full with the probe armed (~2-4 minutes)...');
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
console.log(`[cpu-mystery] action completed after ${elapsedS}s, ok=${result.ok}`);

// Disarm so the world isn't left in a debug state.
await page.evaluate(() => window.MapShine?.setDebugFirstRenderProbe?.(false));

if (!result.ok) {
  console.error('[cpu-mystery] perf-run-full FAILED:', JSON.stringify(result));
  fs.writeFileSync(path.join(OUT_DIR, 'stage0-cpu-mystery-FAILED.json'), JSON.stringify({ result, consoleLines }, null, 2));
  await context.close();
  process.exit(1);
}

const zones = result.result?.zones ?? [];
const probeZone = zones.find((z) => z.id === 'geometry.debugFirstRenderProbe') ?? null;
const depthRenderCallZone = zones.find((z) => z.id === 'geometry.depthRenderCall') ?? null;
const masksOcclusionDrawZone = zones.find((z) => z.id === 'masks.occlusionDraw') ?? null;
const summary = { probeZone, depthRenderCallZone, masksOcclusionDrawZone };
console.log('[cpu-mystery] VERDICT — probe vs depthRenderCall vs masks.occlusionDraw:', JSON.stringify(summary, null, 2));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 'stage0-cpu-mystery-result.json'),
  JSON.stringify({ floorInfo, elapsedS, summary, result: result.result, consoleErrors: consoleLines.filter(l => /error/i.test(l)) }, null, 2)
);
console.log('[cpu-mystery] full result written to stage0-cpu-mystery-result.json');

await context.close();
