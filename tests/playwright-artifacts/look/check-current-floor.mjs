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
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  // Foundry's real API: canvas.scene.levels is a Levels collection with a documented
  // `.current`/`.viewed` accessor on the Level SCHEMA in v14 — read every plausible shape
  // rather than guess one, so this never again silently returns null.
  const scene = canvas?.scene;
  const levelsCollection = scene?.levels;
  const candidates = {
    'canvas.level?.id': canvas?.level?.id ?? null,
    'canvas.level?.name': canvas?.level?.name ?? null,
    'scene.levels.viewed': levelsCollection?.viewed?.name ?? levelsCollection?.viewed ?? null,
    'scene.levels.current': levelsCollection?.current?.name ?? levelsCollection?.current ?? null,
  };
  // MSA's own boot log format was "active ... at floor N" — read its live diagnostics too.
  const vt = window.MapShine?.debug?.getVtPanViewerDiagnostics?.() ?? null;
  return { candidates, vtDiagnosticsAvailable: !!window.MapShine?.debug?.getVtPanViewerDiagnostics, vt };
});
console.log(JSON.stringify(info, null, 2));
await context.close();
