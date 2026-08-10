/** Live-verifies the camera-path 30fps render cap (author-requested, 2026-08-10:
 * "I record at 30 fps... limit rendering to 30 fps... while the camera path tool
 * is running"). Drives the REAL "🎥 Camera Path" panel end-to-end (Generate preset
 * -> Play -> Stop) rather than reaching for an internal function directly, because
 * that panel IS the feature the author will actually click when recording.
 *
 * fps is read from MSA's own ground-truth frame-gap instrument (hitchStats on the
 * 'vt-pan-viewer-diagnostics' report), NOT an independent requestAnimationFrame
 * counter — a rAF counter run from this script would only measure display refresh
 * ticks, which keep firing at native rate regardless of the cap (renderFrame's
 * early-return happens INSIDE the callback; it doesn't stop the callback itself
 * from being scheduled). frameGapAvgMs is only pushed to on frames that pass the
 * early-return, so it directly reflects the capped rate.
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
page.on('dialog', (d) => d.accept()); // the Generate button's window.confirm(), if a path is already loaded
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`));

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();
await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
await bestEffortLogin(page);
await waitForGameReady(page);
await waitForCanvasReady(page);
await waitForMapShineReady(page);
await unpauseIfPaused(page);

async function readFps(label) {
  const r = await page.evaluate(() => window.MapShine.debug.reports.get('vt-pan-viewer-diagnostics').fn());
  const hs = r?.hitchStats ?? {};
  const out = {
    avgMs: hs.frameGapAvgMs ?? null,
    fps: hs.frameGapAvgMs ? Math.round((1000 / hs.frameGapAvgMs) * 10) / 10 : null,
    sampleCount: hs.frameGapSampleCount ?? 0,
    maxMs: hs.frameGapMaxMs ?? null,
    hitchCount: hs.hitchCount ?? 0,
  };
  console.log(`[verify-cap] ${label}:`, JSON.stringify(out));
  return out;
}

// FIRST RUN (2026-08-10) sampled baseline after only a 13s settle on a COLD
// cache (fresh server, fresh browser profile IndexedDB) and got fps:1.8,
// sampleCount:15, maxMs:3925 — that is real Foundry asset-streaming pop-in
// noise, not steady-state rendering (this project's own established lesson:
// "give Foundry a lot more time to breathe before you quit what you are
// doing"). The SAME run's post-stop sample, taken ~31s after ready, was
// clean (fps:47.6, sampleCount:300 i.e. a FULL window, maxMs:125) — so 30s
// is used here as a settle floor, on what is now a warm cache (same
// persistent Chrome profile dir → same IndexedDB decode cache) from that
// run, plus the server itself has been up and streaming since then too.
console.log('[verify-cap] settling before baseline sample (30s — real-scene streaming needs real time)...');
await page.waitForTimeout(30000);
const baseline = await readFps('baseline (uncapped, no camera path)');

console.log('[verify-cap] opening the Camera Path panel...');
await page.evaluate(() => window.MapShine.debug.actions.get('camera-path-open').fn());
await page.waitForTimeout(500);

const genBtn = page.locator('#msa-camera-path-dialog button', { hasText: 'Generate' });
await genBtn.click();
await page.waitForTimeout(500);
const statusAfterGenerate = await page.evaluate(
  () => document.querySelector('#msa-camera-path-dialog')?.textContent?.slice(-200) ?? null
);
console.log('[verify-cap] panel status after Generate:', statusAfterGenerate);

console.log('[verify-cap] clicking Play...');
const playBtn = page.locator('#msa-camera-path-dialog button', { hasText: 'Play' });
await playBtn.click();

// Let the rolling 300-sample gap window fully flush pre-playback (uncapped)
// frames — at a 30fps cap that's ~10s to replace all 300 with capped samples.
// 14s (up from the first run's 10s) for margin: the "full" preset sweeps
// through areas that may still trigger a genuine streaming hitch even on a
// warm cache, and that noise should be a smaller fraction of a longer window.
await page.waitForTimeout(14000);
const capped = await readFps('capped (mid camera-path playback)');

console.log('[verify-cap] stopping playback (native DOM click — panel is display:none mid-playback by design)...');
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('#msa-camera-path-dialog button')].find((b) =>
    b.textContent.includes('Stop')
  );
  btn?.click();
});
await page.waitForTimeout(1000);

console.log('[verify-cap] settling after stop before final sample...');
await page.waitForTimeout(8000);
const after = await readFps('after stop (should return to uncapped)');

const verdict = {
  cappedNearTarget: capped.fps !== null && capped.fps <= 32 && capped.fps >= 24,
  cappedSlowerThanBaseline: capped.fps !== null && baseline.fps !== null && capped.fps < baseline.fps,
  recoveredAfterStop: after.fps !== null && baseline.fps !== null && after.fps > capped.fps,
};
console.log('[verify-cap] verdict:', JSON.stringify(verdict));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 'verify-camera-path-fps-cap-result.json'),
  JSON.stringify(
    { baseline, capped, after, verdict, consoleErrors: consoleLines.filter((l) => /error/i.test(l)) },
    null,
    2
  )
);
console.log('[verify-cap] result written to verify-camera-path-fps-cap-result.json');

await context.close();
