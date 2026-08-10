/** P-003 diligence: what does the harness's actual Chrome launch command line look like
 * TODAY, under the current (possibly-since-modified) foundry-launcher.js/playwright.config.cjs?
 * Reads chrome://version's own "Command Line" field (ground truth) rather than trusting the
 * args array we passed, since Playwright/Chrome may inject flags we never asked for. No Foundry
 * boot needed — this only concerns the browser process itself.
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const TMP_PROFILE = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile-launchargs-check');

const context = await chromium.launchPersistentContext(TMP_PROFILE, {
  channel: 'chrome', headless: false, viewport: { width: 800, height: 600 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = context.pages()[0] || (await context.newPage());

await page.goto('chrome://version', { waitUntil: 'domcontentloaded' });
const commandLine = await page.evaluate(() => {
  const el = document.querySelector('#command_line');
  return el ? el.textContent.trim() : null;
});

const hwInfo = await page.evaluate(() => ({
  hardwareConcurrency: navigator.hardwareConcurrency,
  userAgent: navigator.userAgent
}));

console.log('[launch-args] command line:', commandLine);
console.log('[launch-args] hardwareConcurrency:', hwInfo.hardwareConcurrency);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 'check-launch-args-result.json'),
  JSON.stringify({ commandLine, hwInfo, capturedAt: new Date().toISOString() }, null, 2)
);

await context.close();
fs.rmSync(TMP_PROFILE, { recursive: true, force: true });
console.log('[launch-args] done');
