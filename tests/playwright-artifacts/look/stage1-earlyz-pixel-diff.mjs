/** V4-Testament S1.5 — STAGE 1's PIXEL-DIFF GATE.
 *
 * Captures the SAME scene, SAME camera, SAME session with `earlyZComposition`
 * OFF then ON, and diffs the module's own canvas pixel-for-pixel. The flag is
 * live-flippable precisely so this comparison is one session at one camera
 * position: two separate loads would differ by residency/streaming state and
 * could never prove identity.
 *
 * WHAT "PASS" MEANS, stated before the numbers arrive: interior regions must be
 * BYTE-STABLE (an unblended draw of alpha≡1 art is arithmetically identical to
 * today's blended one — that is the whole basis of the interior certification),
 * and any residual difference must be confined to blended boundary texels.
 * A diff that is large, or spread across the frame, is a FAILURE, not a
 * tolerance to widen.
 *
 * Time is frozen first (`MapShine.setTimeRate(0)`): fire, candles, water and
 * wind all animate, and an animated pixel differs between two captures taken
 * seconds apart for reasons that have nothing to do with this flag.
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

// One-time cache clear: src/ was just edited this session (see the identical
// note in stage0-cpu-mystery-probe.mjs for why a session-long cache disable
// hangs Foundry's own boot on this unbundled codebase).
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
console.log('[s1-diff] waiting for real map art…');
await waitForMapArtLoaded(600000);
// The loading screen clearing is NOT the map being on screen — that gap is the
// whole reason vt/settle.js exists. Wait on real outstanding work instead of a
// guessed sleep: fast on a warm cache, honest (and self-diagnosing) on a cold one.
await waitForSceneSettled(page, { label: 'ground floor' });

// SWITCH TO THE UPPER FLOOR BEFORE MEASURING ANYTHING.
// The scene opens on Ground Floor — the BOTTOM floor, with nothing above it to
// occlude it. An occlusion optimisation tested there is barely exercised: every
// interior fragment passes EqualDepth because nothing covers it, so a
// byte-identical diff would be true but nearly meaningless. First Floor is the
// real case (and §5's own benchmark regime): two floors stacked, Ground's art
// visible beneath and genuinely occluded where the upper floor is solid.
if (process.env.S1_FLOOR !== 'ground') {
  const clicked = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && el.textContent?.trim() === 'First Floor'
    );
    if (!els.length) return { ok: false, reason: 'no "First Floor" control found' };
    els[0].click();
    return { ok: true };
  });
  console.log('[s1-diff] floor switch:', JSON.stringify(clicked));
  if (!clicked.ok) throw new Error(clicked.reason);
  await waitForMapArtLoaded(600000);
  // A cleared loading screen is NOT a settled floor — DOF calibration and
  // residency pop-in continue well past it (feedback_floor_switch_needs_settle_time,
  // learned by misreading a 3s screenshot). This used to be a blind 45s dwell;
  // it is now the real signal, which both finishes sooner on a warm cache and
  // refuses to proceed early on a cold one.
  await waitForSceneSettled(page, { label: 'first floor' });
}

// FREEZE TIME — see this file's header.
const frozen = await page.evaluate(() => {
  try {
    window.MapShine?.setTimeRate?.(0);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
});
console.log('[s1-diff] time freeze:', JSON.stringify(frozen));
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
  console.log(`[s1-diff] captured ${label}: ${data.w}x${data.h}`);
  return data;
}

const floorInfo = await page.evaluate(() => ({ id: canvas?.level?.id ?? null, name: canvas?.level?.name ?? null }));
console.log('[s1-diff] floor:', JSON.stringify(floorInfo));

const before = await grabCanvas('flag OFF');
await page
  .locator('canvas#msa-vt-pan-viewer-canvas')
  .screenshot({ path: path.join(OUT_DIR, 'stage1-earlyz-OFF.png') })
  .catch(() => {});

const flip = await page.evaluate(() => {
  const fn = window.MapShine?.setEarlyZComposition;
  if (typeof fn !== 'function') return { ok: false, reason: 'MapShine.setEarlyZComposition not found' };
  return { ok: true, result: fn(true) };
});
console.log('[s1-diff] flag ON:', JSON.stringify(flip));
if (!flip.ok) {
  console.error('[s1-diff] FAILED to flip the flag — aborting');
  await context.close();
  process.exit(1);
}
// The flag takes effect on the next residency pass; nudge the view so one is
// scheduled promptly, then let it settle.
await page.mouse.wheel(0, -40);
await page.waitForTimeout(600);
await page.mouse.wheel(0, 40);
// The nudge schedules a residency pass; wait for it to actually complete and
// the picture to go quiet again before capturing the second frame.
await waitForSceneSettled(page, { label: 'after flag flip' });

const after = await grabCanvas('flag ON');
await page
  .locator('canvas#msa-vt-pan-viewer-canvas')
  .screenshot({ path: path.join(OUT_DIR, 'stage1-earlyz-ON.png') })
  .catch(() => {});

// NON-VACUITY — read BEFORE celebrating any diff number. `tiles.interior === 0`
// means no tile ever entered the early-Z path, so a byte-identical frame proves
// only that nothing happened. See getEarlyZComposition's own doc.
const state = await page.evaluate(() => window.MapShine?.getEarlyZComposition?.());
console.log('[s1-diff] flag state + NON-VACUITY at capture:', JSON.stringify(state));
const stateOff = { note: 'captured after restore below' };

// Restore the default so nothing is left in a non-default state (Law 3).
await page.evaluate(() => window.MapShine?.setEarlyZComposition?.(false));

if (before.w !== after.w || before.h !== after.h) {
  console.error(`[s1-diff] size mismatch ${before.w}x${before.h} vs ${after.w}x${after.h} — cannot diff`);
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
  flagStateAtCapture: state,
  // The gate is BOTH conditions, never the diff alone.
  verdict:
    (state?.tiles?.interior ?? 0) > 0 && (state?.prepassMeshes ?? 0) > 0
      ? differing === 0
        ? 'PASS — byte-identical AND the early-Z path genuinely ran'
        : `DIFFERS — ${differing} px; inspect the diffmap before judging`
      : 'VACUOUS — no interior tiles and/or no prepass meshes; this diff proves NOTHING',
  stateOff,
};
console.log('[s1-diff] VERDICT:', JSON.stringify(summary, null, 2));

// A visible diff map — where the differences are matters far more than how
// many there are (scattered edges = boundary texels; solid regions = a bug).
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
fs.writeFileSync(path.join(OUT_DIR, 'stage1-earlyz-diffmap.png'), Buffer.from(heatPng));
fs.writeFileSync(
  path.join(OUT_DIR, 'stage1-earlyz-pixel-diff-result.json'),
  JSON.stringify({ summary, consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 40) }, null, 2)
);
console.log('[s1-diff] wrote stage1-earlyz-pixel-diff-result.json + diffmap');

await context.close();
