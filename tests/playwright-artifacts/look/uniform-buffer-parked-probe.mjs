/** PARKED-CAMERA PROBE for the uniform-buffer-growth finding (perf report,
 * 2026-08-12/13) — the report's own suggested test: "re-run a window with the
 * camera parked so no new content streams in. If the ratio holds with a
 * static view, it is per-frame allocation, not content."
 *
 * Loads the scene, settles, then does NOT touch the camera at all — just
 * polls MapShine.getPipelineStats() (programs/geometries/textures/
 * uniformBuffers, straight off renderer.info.memory) at fixed intervals
 * while the render loop runs on its own (candle flicker, fire particles,
 * point-light per-frame uniform pushes — all real ambient work, zero new
 * residency).
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import { bestEffortLogin, waitForGameReady, waitForCanvasReady, waitForMapShineReady, unpauseIfPaused } from '../../playwright/map-shine-utils.js';

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const SAMPLE_COUNT = 13; // ~60s at 5s intervals
const SAMPLE_INTERVAL_MS = 5000;

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = context.pages()[0] || (await context.newPage());

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();
await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
await bestEffortLogin(page);
await waitForGameReady(page);
await waitForCanvasReady(page);
await waitForMapShineReady(page);
await unpauseIfPaused(page);
await page.waitForTimeout(8000);

// Settle before the FIRST sample too, same discipline as perf-run-full's own
// settleFrames — a cold-start shader compile burst would otherwise look like
// "growth" that has nothing to do with steady-state behavior.
const settle = await page.evaluate(async () => {
  const readSettle = window.MapShine?.getSceneSettle;
  if (typeof readSettle !== 'function') return { polled: false };
  const deadline = Date.now() + 30000;
  let last = null;
  while (Date.now() < deadline) {
    last = readSettle();
    if (last?.settled) return { polled: true, settled: true, last };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { polled: true, settled: false, last };
});
console.log('[uniform-buffer-probe] settle:', JSON.stringify(settle));

const samples = [];
for (let i = 0; i < SAMPLE_COUNT; i++) {
  const sample = await page.evaluate(() => {
    const stats = window.MapShine?.getPipelineStats?.() ?? null;
    return { atMs: Date.now(), stats };
  });
  samples.push(sample);
  console.log(`[uniform-buffer-probe] sample ${i}: uniformBuffers=${sample.stats?.uniformBuffers} programs=${sample.stats?.programs} geometries=${sample.stats?.geometries} textures=${sample.stats?.textures}`);
  if (i < SAMPLE_COUNT - 1) await page.waitForTimeout(SAMPLE_INTERVAL_MS);
}

fs.writeFileSync(path.join(OUT_DIR, 'uniform-buffer-parked-probe-result.json'), JSON.stringify({ settle, samples }, null, 2));
console.log('[uniform-buffer-probe] written to uniform-buffer-parked-probe-result.json');

const first = samples[0]?.stats?.uniformBuffers;
const last = samples[samples.length - 1]?.stats?.uniformBuffers;
console.log(`[uniform-buffer-probe] first=${first} last=${last} delta=${last - first} ratio=${(last / first).toFixed(2)}`);

await context.close();
