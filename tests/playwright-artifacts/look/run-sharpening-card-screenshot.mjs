/** Fast, visual-only follow-up: the live A/B run confirmed the Sharpening
 * card exists in the DOM (cardFound:true) but the full-panel screenshot cut
 * off before reaching it (order:91, below Bloom, off the visible fold).
 * This scrolls the card into view and shoots it directly — no perf-run-full,
 * no restarts, just proof the card renders correctly with real values.
 *
 * Usage: node tests/playwright-artifacts/look/run-sharpening-card-screenshot.mjs
 */
import path from 'node:path';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import {
  bestEffortLogin,
  waitForGameReady,
  waitForCanvasReady,
  waitForMapShineReady,
  unpauseIfPaused,
} from '../../playwright/map-shine-utils.js';

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const LOAD_TIMEOUT_MS = 600000;

async function waitForMapArtLoaded(page, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const st = await page.evaluate(async () => {
      try {
        const raw = await window.MapShine?.debug?.runReport?.('loading-screen-state');
        const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return { showing: r?.showing !== false, complete: r?.current?.complete === true, error: r?.current?.error ?? null };
      } catch (e) {
        return { showing: true, title: `report-failed: ${String(e)}` };
      }
    });
    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return st;
    if (Date.now() - start > timeoutMs) throw new Error(`Map art did not finish loading after ${timeoutMs}ms`);
    await page.waitForTimeout(1000);
  }
}

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();

try {
  await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
  await bestEffortLogin(page);
  await waitForGameReady(page);
  await waitForCanvasReady(page);
  await waitForMapShineReady(page);
  await unpauseIfPaused(page);

  console.log('[sharpening-card-shot] waiting for map art...');
  await waitForMapArtLoaded(page, LOAD_TIMEOUT_MS);
  console.log('[sharpening-card-shot] loaded — settling 8s');
  await page.waitForTimeout(8000);

  const setupResult = await page.evaluate(async () => {
    window.MapShine.debug.showPanel?.();
    await new Promise((r) => setTimeout(r, 200));
    const railBtn = document.querySelector('[data-zone="workshop"]');
    if (railBtn) railBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    const card = document.querySelector('[data-msa-effect="albedoClarity"]');
    if (!card) return { cardFound: false };
    card.open = true;
    card.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 300));
    return {
      cardFound: true,
      cardHTML_length: card.outerHTML.length,
      cardText: card.innerText.slice(0, 500),
    };
  });
  console.log('[sharpening-card-shot] setup:', JSON.stringify(setupResult));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT_DIR, 'sharpening-card-scrolled.png') });
  console.log('[sharpening-card-shot] wrote sharpening-card-scrolled.png');
} finally {
  await context.close().catch(() => {});
  await launcher.stop();
}
