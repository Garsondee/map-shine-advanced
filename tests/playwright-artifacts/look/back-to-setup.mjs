import path from 'node:path';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import { bestEffortLogin, waitForGameReady } from '../../playwright/map-shine-utils.js';

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, viewport: { width: 1600, height: 900 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = context.pages()[0] || (await context.newPage());
const launcher = new FoundryLauncher({ headless: true });
await launcher.start();
await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
await bestEffortLogin(page);
await waitForGameReady(page);

// Open the Game Settings sidebar tab (gear icon) where "Return to Setup" lives for a GM.
const settingsTab = await page.$('a[data-tab="settings"], [data-tooltip="Game Settings"], .settings-icon, a[data-tab="settings"]');
console.log('[setup] settings tab found:', !!settingsTab);
if (settingsTab) await settingsTab.click();
await page.waitForTimeout(500);

const clicked = await page.evaluate(() => {
  const candidates = Array.from(document.querySelectorAll('button, a')).filter((el) =>
    /return to setup/i.test(el.textContent || '')
  );
  if (!candidates.length) return { ok: false, reason: 'no Return to Setup control found', bodyTextSample: document.body.innerText.slice(0, 500) };
  candidates[0].click();
  return { ok: true };
});
console.log('[setup] click result:', JSON.stringify(clicked));

// Foundry typically confirms a world-teardown action with a dialog ("Yes"/"Confirm").
await page.waitForTimeout(800);
const confirmClicked = await page.evaluate(() => {
  const candidates = Array.from(document.querySelectorAll('button')).filter((el) =>
    /^(yes|confirm|ok)\b/i.test((el.textContent || '').trim())
  );
  if (!candidates.length) return { ok: false, reason: 'no confirm dialog button found (may not have needed one)' };
  candidates[0].click();
  return { ok: true, label: candidates[0].textContent.trim() };
});
console.log('[setup] confirm-dialog click result:', JSON.stringify(confirmClicked));

await page.waitForTimeout(5000);
console.log('[setup] current url after click:', page.url());
await context.close();
