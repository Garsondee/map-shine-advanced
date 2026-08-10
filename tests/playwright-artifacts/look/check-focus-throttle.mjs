/** Does Playwright's browser window run backgrounded/throttled relative to a normal, focused
 * Chrome window? Checks document focus/visibility state directly, and measures rAF cadence
 * with vs. without an explicit bringToFront() — the cheapest, most direct test of Ingram's
 * hypothesis before trusting any Stage-0 performance number captured through this harness.
 */
import path from 'node:path';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import { bestEffortLogin, waitForGameReady, waitForCanvasReady, waitForMapShineReady } from '../../playwright/map-shine-utils.js';

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, viewport: { width: 3840, height: 2160 },
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
await page.waitForTimeout(5000);

async function measureFps(seconds) {
  return page.evaluate((secs) => new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames += 1;
      if (performance.now() - t0 >= secs * 1000) {
        resolve({ frames, ms: performance.now() - t0, fps: Math.round((frames * 1000) / (performance.now() - t0)) });
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), seconds);
}

const focusStateBefore = await page.evaluate(() => ({
  hasFocus: document.hasFocus(),
  visibilityState: document.visibilityState,
  hidden: document.hidden
}));
console.log('[throttle] focus state BEFORE bringToFront:', JSON.stringify(focusStateBefore));

const fpsBefore = await measureFps(5);
console.log('[throttle] fps BEFORE explicit bringToFront:', JSON.stringify(fpsBefore));

await page.bringToFront();
await page.waitForTimeout(1000);

const focusStateAfter = await page.evaluate(() => ({
  hasFocus: document.hasFocus(),
  visibilityState: document.visibilityState,
  hidden: document.hidden
}));
console.log('[throttle] focus state AFTER bringToFront:', JSON.stringify(focusStateAfter));

const fpsAfter = await measureFps(5);
console.log('[throttle] fps AFTER explicit bringToFront:', JSON.stringify(fpsAfter));

// Click directly on the canvas too — some browsers only grant "real" input/animation
// priority to a window that has received actual OS-level focus via a click, not just CDP's
// bringToFront (which only guarantees tab-level, not always OS window-level, focus).
await page.mouse.click(1920, 1080);
await page.waitForTimeout(1000);
const focusStateAfterClick = await page.evaluate(() => ({
  hasFocus: document.hasFocus(),
  visibilityState: document.visibilityState,
  hidden: document.hidden
}));
console.log('[throttle] focus state AFTER click:', JSON.stringify(focusStateAfterClick));
const fpsAfterClick = await measureFps(5);
console.log('[throttle] fps AFTER click:', JSON.stringify(fpsAfterClick));

await context.close();
