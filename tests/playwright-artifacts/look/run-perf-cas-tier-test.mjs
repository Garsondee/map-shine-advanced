/** CAS performance-tier live test (V4-Testament Stage 0). Albedo clarity sharpening (AMD
 * FidelityFX CAS, commit 18bef7f) only changes behavior on the 'performance'/'low' profile
 * tiers — 'standard' (default)/'quality'/'extreme' are byte-identical to before that commit.
 * The `performanceProfile` client setting carries NO requiresReload flag, so this flips it
 * live and re-runs the same perf-run-full capture used for the 'standard' baseline, then
 * restores 'standard' afterward so nothing is left in a non-default state.
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import { bestEffortLogin, waitForGameReady, waitForCanvasReady, waitForMapShineReady, unpauseIfPaused } from '../../playwright/map-shine-utils.js';

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');

const TIER = process.argv[2] || 'performance';

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = context.pages()[0] || (await context.newPage());
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
await page.waitForTimeout(5000);

const before = await page.evaluate(() => window.game.settings.get('map-shine-advanced', 'performanceProfile'));
console.log(`[cas-test] profile BEFORE: ${before}`);

const setResult = await page.evaluate(async (tier) => {
  try {
    await window.game.settings.set('map-shine-advanced', 'performanceProfile', tier);
    return { ok: true, readBack: window.game.settings.get('map-shine-advanced', 'performanceProfile') };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}, TIER);
console.log(`[cas-test] set to "${TIER}":`, JSON.stringify(setResult));
if (!setResult.ok || setResult.readBack !== TIER) {
  console.error('[cas-test] FAILED to set profile — aborting');
  await context.close();
  process.exit(1);
}

// Let the live setting change propagate (effect-cascade re-resolves on next relevant tick)
// before profiling — no reload needed per the setting's own descriptor (no requiresReload).
await page.waitForTimeout(3000);

const floorInfo = await page.evaluate(() => ({ id: canvas?.level?.id ?? null, name: canvas?.level?.name ?? null }));
console.log('[cas-test] floor at time of measurement:', JSON.stringify(floorInfo));

console.log(`[cas-test] running perf-run-full on "${TIER}" tier (~2-4 minutes)...`);
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
console.log(`[cas-test] action completed after ${elapsedS}s, ok=${result.ok}`);

// Restore the default tier so nothing is left non-standard (Law 3: standard stays default).
const restore = await page.evaluate(async () => {
  await window.game.settings.set('map-shine-advanced', 'performanceProfile', 'standard');
  return window.game.settings.get('map-shine-advanced', 'performanceProfile');
});
console.log('[cas-test] restored profile to:', restore);

if (!result.ok) {
  console.error('[cas-test] perf-run-full FAILED:', JSON.stringify(result));
  fs.writeFileSync(path.join(OUT_DIR, `perf-run-full-${TIER}-FAILED.json`), JSON.stringify({ result, consoleLines }, null, 2));
  await context.close();
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, `perf-run-full-result-${TIER}.json`),
  JSON.stringify({ tier: TIER, profileBefore: before, floorInfo, elapsedS, result: result.result, consoleErrors: consoleLines.filter(l => /error/i.test(l)) }, null, 2)
);
console.log(`[cas-test] full result written to perf-run-full-result-${TIER}.json`);

await context.close();
