/** V4-Testament Stage 0 A/B: blending force-off on fully-opaque colour-pass
 * layers. `MapShine.setDebugForceOpaqueBlendOff(true)` mutates already-built
 * materials LIVE on the next residency pass (gated on the engine's own
 * `alwaysOpaque` signal — same one `buildSceneDepthWriterMaterial` already
 * trusts), so no reload is needed: perf-run-full's own camera pan naturally
 * drives residency passes well before real measurement begins. Expected to be
 * VISUALLY LOSSLESS for genuinely always-opaque layers (blending is a
 * mathematical no-op at alpha≡1) — the screenshot is a correctness check on
 * that claim, not just a courtesy.
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
// many-file codebase) forces this load fresh so it sees setDebugForceOpaqueBlendOff for real
// instead of a pre-edit module.
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
// waitForMapShineReady only confirms the MODULE booted, not that the real map art finished
// decoding — see stage0-cpu-mystery-probe.mjs's identical comment.
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
console.log('[blend-ab] waiting for real map art to finish loading...');
await waitForMapArtLoaded(600000);
await page.waitForTimeout(5000);

const floorInfo = await page.evaluate(() => ({ id: canvas?.level?.id ?? null, name: canvas?.level?.name ?? null }));
console.log('[blend-ab] floor at time of measurement:', JSON.stringify(floorInfo));

// BEFORE screenshot, flag still off — the visual baseline to diff against.
const msaCanvas = page.locator('canvas#msa-vt-pan-viewer-canvas');
if (await msaCanvas.count()) {
  await msaCanvas.screenshot({ path: path.join(OUT_DIR, 'stage0-blend-off-BEFORE-canvas.png') }).catch(() => {});
}

const armResult = await page.evaluate(() => {
  const fn = window.MapShine?.setDebugForceOpaqueBlendOff;
  if (typeof fn !== 'function') return { ok: false, reason: 'MapShine.setDebugForceOpaqueBlendOff not found' };
  fn(true);
  return { ok: true };
});
console.log('[blend-ab] armed:', JSON.stringify(armResult));
if (!armResult.ok) {
  console.error('[blend-ab] FAILED to arm — aborting');
  await context.close();
  process.exit(1);
}

// Force at least one residency pass so the mutation actually lands before the
// screenshot/capture below (a real camera nudge, not just a wait — residency
// reconciles on view change).
await page.mouse.wheel(0, -50);
await page.waitForTimeout(500);
await page.mouse.wheel(0, 50);
await page.waitForTimeout(3000);

if (await msaCanvas.count()) {
  await msaCanvas.screenshot({ path: path.join(OUT_DIR, 'stage0-blend-off-AFTER-canvas.png') }).catch(() => {});
}

console.log('[blend-ab] running perf-run-full with opaque-layer blending OFF (~2-4 minutes)...');
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
console.log(`[blend-ab] action completed after ${elapsedS}s, ok=${result.ok}`);

// Disarm before closing (this context's viewer instance only — nothing persisted).
await page.evaluate(() => window.MapShine?.setDebugForceOpaqueBlendOff?.(false));

if (!result.ok) {
  console.error('[blend-ab] perf-run-full FAILED:', JSON.stringify(result));
  fs.writeFileSync(path.join(OUT_DIR, 'stage0-blend-off-FAILED.json'), JSON.stringify({ result, consoleLines }, null, 2));
  await context.close();
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 'stage0-blend-off-result.json'),
  JSON.stringify({ floorInfo, elapsedS, result: result.result, consoleErrors: consoleLines.filter(l => /error/i.test(l)) }, null, 2)
);
console.log('[blend-ab] full result written to stage0-blend-off-result.json');

await context.close();
