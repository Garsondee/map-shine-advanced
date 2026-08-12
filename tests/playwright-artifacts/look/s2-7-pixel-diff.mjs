/** V4-Testament S2.7 — STAGE 2's PIXEL-DIFF GATE.
 *
 * Captures the SAME scene, SAME camera, SAME session with `pointLightBatching`
 * OFF then ON, and diffs the module's own canvas pixel-for-pixel. The flag is
 * live-flippable precisely so this comparison is one session at one camera
 * position: two separate loads would differ by residency/streaming state and
 * could never prove identity (same reasoning as S1.5's
 * stage1-earlyz-pixel-diff.mjs, which this script is modeled on).
 *
 * WHAT "PASS" MEANS, stated before the numbers arrive: Point-Light-Batching-
 * Design.md §4 is explicit — parity is STRUCTURAL (one shared shading core
 * feeding both the per-light and batched materials), so this gate stays
 * `exact`. Any diff is a bug. The ONLY lawful relaxation is §4's own named
 * contingency (constant-attribute interpolation wobble, ≤1/255 max delta,
 * zero pixels ≥2/255) and it requires the failing-check evidence AND the
 * author's explicit sign-off recorded in the Testament — this script does
 * not self-invoke that relaxation, it only reports the raw numbers.
 *
 * Unlike `earlyZComposition`, `pointLightBatching` needs no residency-pass
 * nudge to take effect — `point-light-pool.js#update()` reads the flag fresh
 * every frame (see `setPointLightBatching`'s own doc comment in
 * vt-pan-viewer.js) — so this script just waits a few frames after flipping
 * instead of nudging the camera to schedule a residency pass.
 *
 * Time is frozen first (`MapShine.setTimeRate(0)`): candle/fire/lightning
 * animation is GPU-side (uGlobalTimeMs + per-light seeds — design doc §3.4),
 * and darkness-window membership drifts with the same clock (37/50 census
 * lights carry an activation window) — an unfrozen capture could show a
 * membership flip between the two shots for reasons that have nothing to do
 * with this flag.
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
console.log('[s2-7-diff] waiting for real map art…');
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'ground floor' });

// ⚠️ FORCE THE FLAG OFF EXPLICITLY — NEVER ASSUME THE BOOT DEFAULT
// (same countersign-fix discipline S1.5/S1.6 learned the hard way). Initial
// state is recorded and restored at the end, never a hardcoded value.
const initialFlag = await page.evaluate(() => window.MapShine?.getPointLightBatching?.()?.pointLightBatching ?? null);
console.log('[s2-7-diff] initial flag state at boot:', JSON.stringify(initialFlag));
await page.evaluate(() => window.MapShine?.setPointLightBatching?.(false));
await page.waitForTimeout(300);

// FREEZE TIME — see this file's header.
const frozen = await page.evaluate(() => {
  try {
    window.MapShine?.setTimeRate?.(0);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
});
console.log('[s2-7-diff] time freeze:', JSON.stringify(frozen));
await page.waitForTimeout(2000);

/** Read the module's own canvas back as raw RGBA through a 2D copy — the
 * pixels the player would actually see, not a re-render. */
async function grabCanvas(label) {
  const data = await page.evaluate(async () => {
    const c = document.querySelector('canvas#msa-vt-pan-viewer-canvas');
    if (!c) return null;
    const bmp = await createImageBitmap(c);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, off.width, off.height);
    return { w: off.width, h: off.height, bytes: Array.from(img.data) };
  });
  if (!data) throw new Error(`no MSA canvas found for ${label}`);
  console.log(`[s2-7-diff] captured ${label}: ${data.w}x${data.h}`);
  return data;
}

const floorInfo = await page.evaluate(() => ({ id: canvas?.level?.id ?? null, name: canvas?.level?.name ?? null }));
console.log('[s2-7-diff] floor:', JSON.stringify(floorInfo));

async function readPoolStats() {
  return page.evaluate(() => window.MapShine?.getPointLightMeshPoolStats?.() ?? null);
}

const poolsOff = await readPoolStats();
const before = await grabCanvas('flag OFF');
await page
  .locator('canvas#msa-vt-pan-viewer-canvas')
  .screenshot({ path: path.join(OUT_DIR, 's2-7-pointlightbatch-OFF.png') })
  .catch(() => {});

const flip = await page.evaluate(() => {
  const fn = window.MapShine?.setPointLightBatching;
  if (typeof fn !== 'function') return { ok: false, reason: 'MapShine.setPointLightBatching not found' };
  return { ok: true, result: fn(true) };
});
console.log('[s2-7-diff] flag ON:', JSON.stringify(flip));
if (!flip.ok) {
  console.error('[s2-7-diff] FAILED to flip the flag — aborting');
  await context.close();
  process.exit(1);
}
// No residency nudge needed (see header) — a few frames is enough for
// point-light-pool.js#update() to pick the new flag up and rebuild buckets.
await page.waitForTimeout(500);
await waitForSceneSettled(page, { label: 'after flag flip' });

const poolsOn = await readPoolStats();
const after = await grabCanvas('flag ON');
await page
  .locator('canvas#msa-vt-pan-viewer-canvas')
  .screenshot({ path: path.join(OUT_DIR, 's2-7-pointlightbatch-ON.png') })
  .catch(() => {});

// NON-VACUITY — read BEFORE celebrating any diff number. Zero admitted
// lights (`illumBuckets.size === 0 && colorBuckets.size === 0`) means the
// batching path never actually ran, so a byte-identical frame would prove
// only that nothing happened (same doctrine as S1.5's `tiles.interior`
// check).
const admittedBuckets = (poolsOn?.illumBuckets?.size ?? 0) + (poolsOn?.colorBuckets?.size ?? 0);
console.log('[s2-7-diff] pool stats OFF:', JSON.stringify(poolsOff));
console.log('[s2-7-diff] pool stats ON:', JSON.stringify(poolsOn));

// Restore the INITIAL state — never a hardcoded value (Law 3).
await page.evaluate((v) => window.MapShine?.setPointLightBatching?.(v === true), initialFlag);

if (before.w !== after.w || before.h !== after.h) {
  console.error(`[s2-7-diff] size mismatch ${before.w}x${before.h} vs ${after.w}x${after.h} — cannot diff`);
  await context.close();
  process.exit(1);
}

let differing = 0;
let maxChannelDelta = 0;
let sumDelta = 0;
const heat = new Uint8Array(before.w * before.h);
for (let p = 0, i = 0; p < heat.length; p++, i += 4) {
  let d = 0;
  for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(before.bytes[i + c] - after.bytes[i + c]));
  if (d > 0) {
    differing++;
    sumDelta += d;
    if (d > maxChannelDelta) maxChannelDelta = d;
    heat[p] = Math.min(255, d * 8);
  }
}
const total = heat.length;
const summary = {
  floorInfo,
  size: `${before.w}x${before.h}`,
  totalPixels: total,
  differingPixels: differing,
  differingPercent: +((differing / total) * 100).toFixed(4),
  maxChannelDelta,
  meanDeltaOverDiffering: differing ? +(sumDelta / differing).toFixed(2) : 0,
  poolStatsOff: poolsOff,
  poolStatsOn: poolsOn,
  admittedBuckets,
  // The gate is BOTH conditions, never the diff alone.
  verdict:
    admittedBuckets > 0
      ? differing === 0
        ? 'PASS — byte-identical AND the batched path genuinely admitted lights'
        : `DIFFERS — ${differing} px; inspect the diffmap before judging (design doc §4 relaxation is NOT self-applied here)`
      : 'VACUOUS — zero admitted buckets; this diff proves NOTHING',
};
console.log('[s2-7-diff] VERDICT:', JSON.stringify(summary, null, 2));

const heatPng = await page.evaluate(
  async ({ w, h, heatArr }) => {
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let p = 0, i = 0; p < heatArr.length; p++, i += 4) {
      img.data[i] = heatArr[p];
      img.data[i + 1] = heatArr[p] ? 0 : 0;
      img.data[i + 2] = heatArr[p] ? 0 : 0;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await off.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    return Array.from(buf);
  },
  { w: before.w, h: before.h, heatArr: Array.from(heat) }
);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 's2-7-pointlightbatch-diffmap.png'), Buffer.from(heatPng));
fs.writeFileSync(
  path.join(OUT_DIR, 's2-7-pixel-diff-result.json'),
  JSON.stringify({ summary, consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 40) }, null, 2)
);
console.log('[s2-7-diff] wrote s2-7-pixel-diff-result.json + diffmap');

await context.close();
