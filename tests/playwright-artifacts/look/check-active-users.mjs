import path from 'node:path';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import { bestEffortLogin, waitForGameReady } from '../../playwright/map-shine-utils.js';

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile-usercheck');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, viewport: { width: 800, height: 600 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = context.pages()[0] || (await context.newPage());
const launcher = new FoundryLauncher({ headless: true });
await launcher.start();
await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
await bestEffortLogin(page);
await waitForGameReady(page);

const users = await page.evaluate(() => window.game.users.contents.map((u) => ({
  name: u.name, id: u.id, role: u.role, active: u.active
})));
console.log(JSON.stringify(users, null, 2));
await context.close();
