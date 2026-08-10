/** V4-Testament Stage 0 A/B: maskNode discard force-off. `material.maskNode` is
 * baked into each material's compiled shader graph at BUILD time (three's own
 * NodeMaterial#setupDiffuseColor null-checks it once during pipeline setup), so
 * arming `MapShine.setDebugForceMaskNodeOff(true)` only matters if materials are
 * (re)built AFTER it's set — this script arms it, then reloads the page so every
 * material is built fresh with the flag already on, before capturing.
 *
 * WRONG PIXELS EXPECTED (Testament's own words: "measurement only") — a fragment
 * whose true higher-ranked occluder would normally discard it instead draws, so
 * over-drawn-but-covered layers can show through. Never left armed after this run.
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

// See stage0-cpu-mystery-probe.mjs's identical, longer comment: a ONE-TIME cache clear (not
// setCacheDisabled left on for the session — that hung game.ready past 90s on this unbundled,
// many-file codebase) forces this load fresh so the reload below picks up
// setDebugForceMaskNodeOff for real instead of a pre-edit module.
const cdp = await context.newCDPSession(page);
await cdp.send('Network.clearBrowserCache');

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

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();
await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
await bestEffortLogin(page);
await waitForGameReady(page);
await waitForCanvasReady(page);
await waitForMapShineReady(page);
await unpauseIfPaused(page);
// waitForMapShineReady only confirms the MODULE booted, not that the real map art finished
// decoding — see stage0-cpu-mystery-probe.mjs's identical comment.
console.log('[masknode-ab] waiting for real map art to finish loading (pre-flag baseline load)...');
await waitForMapArtLoaded(600000);
await page.waitForTimeout(3000);

console.log('[masknode-ab] arming setDebugForceMaskNodeOff(true), then reloading so materials rebuild with it on...');
const armResult = await page.evaluate(() => {
  const fn = window.MapShine?.setDebugForceMaskNodeOff;
  if (typeof fn !== 'function') return { ok: false, reason: 'MapShine.setDebugForceMaskNodeOff not found' };
  fn(true);
  return { ok: true };
});
console.log('[masknode-ab] arm result:', JSON.stringify(armResult));
if (!armResult.ok) {
  console.error('[masknode-ab] FAILED to arm — aborting');
  await context.close();
  process.exit(1);
}

// Reload so ensureItemLoaded's material-build path runs fresh with the flag on.
await page.reload({ waitUntil: 'domcontentloaded' });
await bestEffortLogin(page);
await waitForGameReady(page);
await waitForCanvasReady(page);
await waitForMapShineReady(page);
await unpauseIfPaused(page);
console.log('[masknode-ab] waiting for real map art to finish loading (post-reload, flag armed)...');
await waitForMapArtLoaded(600000);

// Re-arm after reload — the flag lives in the viewer closure, torn down on reload.
const rearmResult = await page.evaluate(() => {
  const fn = window.MapShine?.setDebugForceMaskNodeOff;
  if (typeof fn !== 'function') return { ok: false, reason: 'MapShine.setDebugForceMaskNodeOff not found after reload' };
  fn(true);
  return { ok: true, readBack: true };
});
console.log('[masknode-ab] re-armed after reload:', JSON.stringify(rearmResult));
if (!rearmResult.ok) {
  console.error('[masknode-ab] FAILED to re-arm after reload — aborting');
  await context.close();
  process.exit(1);
}
await page.waitForTimeout(8000);

const floorInfo = await page.evaluate(() => ({ id: canvas?.level?.id ?? null, name: canvas?.level?.name ?? null }));
console.log('[masknode-ab] floor at time of measurement:', JSON.stringify(floorInfo));

await page.screenshot({ path: path.join(OUT_DIR, 'stage0-masknode-off-viewport.png') });
const msaCanvas = page.locator('canvas#msa-vt-pan-viewer-canvas');
if (await msaCanvas.count()) {
  await msaCanvas.screenshot({ path: path.join(OUT_DIR, 'stage0-masknode-off-canvas.png') }).catch(() => {});
}

console.log('[masknode-ab] running perf-run-full with maskNode discard OFF (~2-4 minutes)...');
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
console.log(`[masknode-ab] action completed after ${elapsedS}s, ok=${result.ok}`);

if (!result.ok) {
  console.error('[masknode-ab] perf-run-full FAILED:', JSON.stringify(result));
  fs.writeFileSync(path.join(OUT_DIR, 'stage0-masknode-off-FAILED.json'), JSON.stringify({ result, consoleLines }, null, 2));
  await context.close();
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 'stage0-masknode-off-result.json'),
  JSON.stringify({ floorInfo, elapsedS, result: result.result, consoleErrors: consoleLines.filter(l => /error/i.test(l)) }, null, 2)
);
console.log('[masknode-ab] full result written to stage0-masknode-off-result.json');
console.log('[masknode-ab] IMPORTANT: closing browser now WITHOUT disarming — the flag dies with this context (never persisted), but the next unrelated session should still reload fresh to be certain.');

await context.close();
