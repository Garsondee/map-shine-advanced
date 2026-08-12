/** Live-checks MapShine.getGeometryComposition() (Testament Track B.1) against the real
 * bench Mansion — confirms it returns real, non-empty numbers, not just that it doesn't throw.
 */
import path from 'node:path';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import { bestEffortLogin, waitForGameReady, waitForCanvasReady, waitForMapShineReady, unpauseIfPaused } from '../../playwright/map-shine-utils.js';

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';

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

// getVtPanViewerSceneSettle is the project's own "what's still outstanding"
// tracker (used by boot.js's own waitForSceneSettled) — poll it directly
// instead of a blind extra sleep, same discipline as everywhere else this
// session.
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
console.log('[verify-geometry-composition] settle:', JSON.stringify(settle));

const result = await page.evaluate(() => {
  const fn = window.MapShine?.getGeometryComposition;
  const drawListFn = window.MapShine?.getDrawListIds;
  if (typeof fn !== 'function') return { ok: false, reason: 'MapShine.getGeometryComposition not found' };
  try {
    return {
      ok: true,
      result: fn(),
      drawListLength: typeof drawListFn === 'function' ? drawListFn()?.length ?? null : 'no-fn',
    };
  } catch (e) {
    return { ok: false, reason: `threw: ${e?.message ?? e}`, stack: e?.stack };
  }
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  console.error('[verify-geometry-composition] FAILED');
  console.error('console lines:', consoleLines.filter((l) => /error/i.test(l)).join('\n'));
  await context.close();
  process.exit(1);
}

const r = result.result;
const sane =
  r &&
  Array.isArray(r.byKind) &&
  r.byKind.length > 0 &&
  typeof r.totalTriangles === 'number' &&
  r.totalTriangles > 0 &&
  typeof r.totalItems === 'number' &&
  r.totalItems > 0;

console.log(`\n[verify-geometry-composition] sane=${sane} byKind.length=${r?.byKind?.length} totalTriangles=${r?.totalTriangles} totalItems=${r?.totalItems}`);

await context.close();
process.exit(sane ? 0 : 1);
