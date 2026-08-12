/** Candle light-source clustering cache — byte-identical gate.
 *
 * Verifies the 2026-08-12 perf change (memoizing `buildCandleLightSources`'
 * clustering output in `point-light-pool.js`, plus the `getCandleRenderState`
 * anchors-array cache it rides on in `boot.js`) against production's ACTUAL
 * candle rendering. Modeled directly on `s2-1-capture.mjs` (same rigor: real
 * map-art load wait, First Floor — 207 candle anchors + 50 Foundry lights,
 * S2.0 census — freeze time so flicker/wind animation can't differ between
 * two runs seconds apart for reasons unrelated to the change, non-vacuity via
 * `vt-pan-viewer-diagnostics`'s own `pointLights` report field).
 *
 * No flag exists for this change (it's a pure always-active-path cache, not
 * a toggle), so "before" and "after" are two separate process runs against
 * two different git states of boot.js / point-light-pool.js /
 * anchor-authority.js — same shape as S2.1's own gate for the identical
 * reason (a refactor of the SAME code path, not an A/B flip).
 *
 * usage: node tests/playwright-artifacts/look/candle-cache-capture.mjs <baseline|after>
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

const label = process.argv[2];
if (label !== 'baseline' && label !== 'after') {
  console.error('usage: node candle-cache-capture.mjs <baseline|after>');
  process.exit(1);
}

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

// One-time cache clear — src/ is being edited across these two runs (same
// reasoning as s2-1-capture.mjs's own identical note).
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
console.log(`[candle-cache-capture:${label}] waiting for real map art…`);
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'ground floor' });

// FIRST FLOOR — candles (207 anchors) and Foundry lights (50) both present,
// exercising the exact `point-light-pool.js#update()` path the cache sits in.
const clicked = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('*')).filter(
    (el) => el.children.length === 0 && el.textContent?.trim() === 'First Floor'
  );
  if (!els.length) return { ok: false, reason: 'no "First Floor" control found' };
  els[0].click();
  return { ok: true };
});
console.log(`[candle-cache-capture:${label}] floor switch:`, JSON.stringify(clicked));
if (!clicked.ok) throw new Error(clicked.reason);
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'first floor' });

// FREEZE TIME — see this file's header.
const frozen = await page.evaluate(() => {
  try {
    window.MapShine?.setTimeRate?.(0);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
});
console.log(`[candle-cache-capture:${label}] time freeze:`, JSON.stringify(frozen));
await page.waitForTimeout(2000);

// A SECOND settle window AFTER the freeze — specifically to exercise the
// cache across several distinct frames while genuinely nothing about the
// candles changes (the exact steady-state condition the cache optimizes),
// not just a single-frame snapshot.
await page.waitForTimeout(1500);

async function grabCanvas() {
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
  if (!data) throw new Error('no MSA canvas found');
  console.log(`[candle-cache-capture:${label}] captured: ${data.w}x${data.h}`);
  return data;
}

const floorInfo = await page.evaluate(() => ({ id: canvas?.level?.id ?? null, name: canvas?.level?.name ?? null }));
const diagnostics = await page.evaluate(async () => {
  const raw = await window.MapShine?.debug?.runReport?.('vt-pan-viewer-diagnostics');
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
});
const pointLights = diagnostics?.pointLights ?? { available: false };
console.log(`[candle-cache-capture:${label}] pointLights (non-vacuity):`, JSON.stringify(pointLights));

const frame = await grabCanvas();
await page
  .locator('canvas#msa-vt-pan-viewer-canvas')
  .screenshot({ path: path.join(OUT_DIR, `candle-cache-${label}.png`) })
  .catch(() => {});

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, `candle-cache-${label}.json`),
  JSON.stringify({
    label,
    capturedAt: Date.now(),
    floorInfo,
    pointLights,
    w: frame.w,
    h: frame.h,
    bytes: frame.bytes,
    consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 40),
  })
);
console.log(`[candle-cache-capture:${label}] wrote candle-cache-${label}.json (${frame.w}x${frame.h})`);

await context.close();
