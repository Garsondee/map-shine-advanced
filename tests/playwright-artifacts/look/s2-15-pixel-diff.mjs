/** V4-Testament S2.15 — the DEDICATED TARGET + BLIT infrastructure's own
 * live gate (Performance-Audit-2026-08.md §3.1's MRT-merge plan).
 *
 * Modeled directly on `s2-7-pixel-diff.mjs` (same flag-flip-in-one-session
 * reasoning: two separate loads would differ by residency/streaming state
 * and could never prove identity). The one thing that differs from S2.7's
 * own shape: S2.15 has NO real content behind its flag yet —
 * `pointLights.mergedScene` stays permanently empty until S2.16 wires real
 * bucket membership into it — so "0 pixels differ" is EXPECTED, not a
 * surprise. The point of this gate is proving that expectation for real,
 * against the LIVE integration in vt-pan-viewer.js (the shader-lab bench
 * already proved the underlying target/zero-quad/blit MECHANISM in
 * isolation, against the same production functions — this gate is the next
 * rung up: did the actual wiring in the live render loop call them
 * correctly, in the right sequence, with no typo/reference bug hiding
 * behind a green bench).
 *
 * NON-VACUITY is therefore NOT "did batching admit lights" (S2.7's own
 * check) — it is `MapShine.getPointLightMrtMerge().drawCount`, a counter
 * incremented once per frame inside the flag-gated block itself (vt-pan-
 * viewer.js). A byte-identical canvas with drawCount stuck at 0 would prove
 * only that the `if` block never ran at all, not that the new code is
 * correctly inert — this counter is what tells the two apart.
 *
 * Time is frozen first, same reasoning as S2.7: candle/fire/lightning
 * animation and darkness-window membership are both GPU/clock-driven, and
 * an unfrozen capture could show a difference between the two shots for
 * reasons that have nothing to do with this flag.
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
console.log('[s2-15-diff] waiting for real map art…');
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'ground floor' });

// ⚠️ FORCE THE FLAG OFF EXPLICITLY — NEVER ASSUME THE BOOT DEFAULT
// (same countersign-fix discipline S1.5/S1.6/S2.7 learned the hard way).
// Initial state is recorded and restored at the end, never a hardcoded value.
const initialFlag = await page.evaluate(() => window.MapShine?.getPointLightMrtMerge?.()?.pointLightMrtMerge ?? null);
console.log('[s2-15-diff] initial flag state at boot:', JSON.stringify(initialFlag));
await page.evaluate(() => window.MapShine?.setPointLightMrtMerge?.(false));
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
console.log('[s2-15-diff] time freeze:', JSON.stringify(frozen));
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
  console.log(`[s2-15-diff] captured ${label}: ${data.w}x${data.h}`);
  return data;
}

const floorInfo = await page.evaluate(() => ({ id: canvas?.level?.id ?? null, name: canvas?.level?.name ?? null }));
console.log('[s2-15-diff] floor:', JSON.stringify(floorInfo));

async function readMrtMergeStats() {
  return page.evaluate(() => window.MapShine?.getPointLightMrtMerge?.() ?? null);
}
async function readRenderTargets() {
  return page.evaluate(() => window.MapShine?.getRenderTargets?.() ?? null);
}

const statsOff = await readMrtMergeStats();
const before = await grabCanvas('flag OFF');
await page
  .locator('canvas#msa-vt-pan-viewer-canvas')
  .screenshot({ path: path.join(OUT_DIR, 's2-15-pointlightmrtmerge-OFF.png') })
  .catch(() => {});

const flip = await page.evaluate(() => {
  const fn = window.MapShine?.setPointLightMrtMerge;
  if (typeof fn !== 'function') return { ok: false, reason: 'MapShine.setPointLightMrtMerge not found' };
  return { ok: true, result: fn(true) };
});
console.log('[s2-15-diff] flag ON:', JSON.stringify(flip));
if (!flip.ok) {
  console.error('[s2-15-diff] FAILED to flip the flag — aborting');
  await context.close();
  process.exit(1);
}
// No residency nudge needed — the new call sites read the closure variable
// fresh every frame, same as pointLightBatching's own flag.
await page.waitForTimeout(500);
await waitForSceneSettled(page, { label: 'after flag flip' });

const statsOn = await readMrtMergeStats();
const renderTargetsOn = await readRenderTargets();
const after = await grabCanvas('flag ON');
await page
  .locator('canvas#msa-vt-pan-viewer-canvas')
  .screenshot({ path: path.join(OUT_DIR, 's2-15-pointlightmrtmerge-ON.png') })
  .catch(() => {});

// NON-VACUITY — read BEFORE celebrating any diff number. See this file's
// own header for why `drawCount`, not a pixel/pool signal, is the right
// check for THIS stage specifically.
console.log('[s2-15-diff] mrt-merge stats OFF:', JSON.stringify(statsOff));
console.log('[s2-15-diff] mrt-merge stats ON:', JSON.stringify(statsOn));
const mergedTarget = renderTargetsOn?.find?.((rt) => rt?.name === 'v3:scene.pointLightMerged') ?? null;
console.log('[s2-15-diff] scene.pointLightMerged target (flag ON):', JSON.stringify(mergedTarget));

// Restore the INITIAL state — never a hardcoded value (Law 3).
await page.evaluate((v) => window.MapShine?.setPointLightMrtMerge?.(v === true), initialFlag);

if (before.w !== after.w || before.h !== after.h) {
  console.error(`[s2-15-diff] size mismatch ${before.w}x${before.h} vs ${after.w}x${after.h} — cannot diff`);
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
const nonVacuous = (statsOn?.drawCount ?? 0) > 0 && statsOff?.drawCount === 0 && !!mergedTarget;
const summary = {
  floorInfo,
  size: `${before.w}x${before.h}`,
  totalPixels: total,
  differingPixels: differing,
  differingPercent: +((differing / total) * 100).toFixed(4),
  maxChannelDelta,
  meanDeltaOverDiffering: differing ? +(sumDelta / differing).toFixed(2) : 0,
  statsOff,
  statsOn,
  mergedTarget,
  nonVacuous,
  // The gate is BOTH conditions, never the diff alone — same posture S2.7's
  // own verdict line takes, just with a different non-vacuity signal (see
  // this file's own header for why `drawCount`, not admitted buckets, is
  // the right one for a stage with no real content behind its flag yet).
  verdict:
    nonVacuous
      ? differing === 0
        ? 'PASS — byte-identical AND the new produce+blit code path genuinely ran every frame (drawCount > 0)'
        : `DIFFERS — ${differing} px; inspect the diffmap before judging (this stage expects EXACTLY 0)`
      : 'VACUOUS — drawCount stayed 0 (or the target never allocated) with the flag ON; this diff proves NOTHING',
};
console.log('[s2-15-diff] VERDICT:', JSON.stringify(summary, null, 2));

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
fs.writeFileSync(path.join(OUT_DIR, 's2-15-pointlightmrtmerge-diffmap.png'), Buffer.from(heatPng));
fs.writeFileSync(
  path.join(OUT_DIR, 's2-15-pixel-diff-result.json'),
  JSON.stringify({ summary, consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 40) }, null, 2)
);
console.log('[s2-15-diff] wrote s2-15-pixel-diff-result.json + diffmap');

await context.close();
