/** Triggers MSA's own built-in "Performance Report" action (perf-run-full) — a real,
 * instrumented per-zone CPU+GPU profile that drives a camera path over the actual scene for
 * ~2-4 minutes, rather than a raw rAF fps count. This is Stage-0-grade measurement: it
 * produces zones[], vram, taxonomy, and findings[] — a genuine pass census + hitch signal,
 * not a rough number. Writes the full JSON report to disk when done.
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

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();
await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
await bestEffortLogin(page);
await waitForGameReady(page);
await waitForCanvasReady(page);
await waitForMapShineReady(page);
await unpauseIfPaused(page);
await page.waitForTimeout(8000);

const floorInfo = await page.evaluate(() => ({ id: canvas?.level?.id ?? null, name: canvas?.level?.name ?? null }));
console.log('[perf-run] floor at time of measurement:', JSON.stringify(floorInfo));

console.log('[perf-run] triggering perf-run-full (this drives a camera path, ~2-4 minutes)...');
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
console.log(`[perf-run] action completed after ${elapsedS}s, ok=${result.ok}`);

if (!result.ok) {
  console.error('[perf-run] FAILED:', JSON.stringify(result));
  fs.writeFileSync(path.join(OUT_DIR, 'perf-run-full-FAILED.json'), JSON.stringify({ result, consoleLines }, null, 2));
  await context.close();
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'perf-run-full-result.json'), JSON.stringify({ floorInfo, elapsedS, result: result.result, consoleErrors: consoleLines.filter(l => /error/i.test(l)) }, null, 2));
console.log('[perf-run] full result written to perf-run-full-result.json');

await context.close();
