import path from 'node:path';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, viewport: { width: 1600, height: 900 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = context.pages()[0] || (await context.newPage());
const launcher = new FoundryLauncher({ headless: true });
await launcher.start();
await page.goto(`${launcher.getBaseUrl()}/setup`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

const worldsSeen = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-package-id], .package.world, li.world')).map((el) => ({
    id: el.dataset?.packageId ?? null,
    text: el.textContent?.trim().slice(0, 80) ?? null
  }))
);
console.log('[relaunch] worlds visible on setup screen:', JSON.stringify(worldsSeen, null, 2));

const launched = await page.evaluate(() => {
  // Foundry's world list entries carry a "Launch World" button; find it inside the
  // msa-bench-world card specifically, falling back to any single world card if only one exists.
  const cards = Array.from(document.querySelectorAll('.world, [data-package-id]'));
  const target = cards.find((c) => /msa.?bench/i.test(c.textContent || '')) || cards[0];
  if (!target) return { ok: false, reason: 'no world card found on setup screen' };
  const launchBtn = target.querySelector('button, a.control, [data-action="worldLaunch"], [data-action="launch"]')
    || Array.from(target.querySelectorAll('button, a')).find((b) => /launch|play/i.test(b.textContent || ''));
  if (!launchBtn) return { ok: false, reason: 'world card found but no launch control inside it', cardText: target.textContent?.trim().slice(0, 200) };
  launchBtn.click();
  return { ok: true, cardText: target.textContent?.trim().slice(0, 200) };
});
console.log('[relaunch] launch click result:', JSON.stringify(launched, null, 2));

await page.waitForTimeout(3000);
console.log('[relaunch] url after launch click:', page.url());
await context.close();
