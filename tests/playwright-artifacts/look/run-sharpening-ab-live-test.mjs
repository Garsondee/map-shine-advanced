/** LIVE VALIDATION of the sharpening structural A/B (Part 4b) — the first-ever
 * real run of the restart-based measurement. Also screenshots the new
 * "Sharpening" Make-panel card as visual proof of Part 2/3.
 *
 * Usage: node tests/playwright-artifacts/look/run-sharpening-ab-live-test.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import { bestEffortLogin, waitForGameReady, waitForCanvasReady, waitForMapShineReady, unpauseIfPaused } from '../../playwright/map-shine-utils.js';

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
  channel: 'chrome', headless: false, viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = context.pages()[0] || (await context.newPage());
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 400)}`));

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();

try {
  await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
  await bestEffortLogin(page);
  await waitForGameReady(page);
  await waitForCanvasReady(page);
  await waitForMapShineReady(page);
  await unpauseIfPaused(page);

  console.log('[sharpening-ab-live] waiting for map art...');
  await waitForMapArtLoaded(page, LOAD_TIMEOUT_MS);
  console.log('[sharpening-ab-live] loaded — settling 15s');
  await page.waitForTimeout(15000);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- Part 1: open the Make panel, screenshot the Sharpening card. ----
  const panelResult = await page.evaluate(async () => {
    window.MapShine.debug.showPanel?.();
    await new Promise((r) => setTimeout(r, 200));
    // No public zone-switch API — click the rail button directly, same as a
    // real user would (debug-panel.js's own rail buttons carry data-zone).
    const railBtn = document.querySelector('[data-zone="workshop"]');
    if (railBtn) railBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    const card = document.querySelector('[data-msa-effect="albedoClarity"]');
    if (card) card.open = true;
    return { panelVisible: window.MapShine.debug.isPanelVisible?.() ?? null, railBtnFound: !!railBtn, cardFound: !!card };
  });
  console.log('[sharpening-ab-live] panel/card:', JSON.stringify(panelResult));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, 'sharpening-card-make-panel.png') });

  // ---- Part 2: confirm the toggle actually works (instant, uniform-level). ----
  const toggleCheck = await page.evaluate(async () => {
    const before = window.MapShine.getAlbedoClarity();
    window.MapShine.setAlbedoClarity({ enabled: false });
    await new Promise((r) => setTimeout(r, 100));
    const off = window.MapShine.getAlbedoClarity();
    window.MapShine.setAlbedoClarity({ enabled: true });
    const restored = window.MapShine.getAlbedoClarity();
    return { before, off, restored };
  });
  console.log('[sharpening-ab-live] toggle check:', JSON.stringify(toggleCheck));

  // ---- Part 3: THE REAL TEST — enable the kill switch and run perf-run-full. ----
  const setResult = await page.evaluate(() => window.MapShine.setSharpeningAbEnabled(true));
  console.log('[sharpening-ab-live] kill switch:', JSON.stringify(setResult));

  console.log('[sharpening-ab-live] running perf-run-full WITH the sharpening A/B enabled (this will be slow)...');
  const t0 = Date.now();
  const result = await page.evaluate(async () => {
    const action = window.MapShine?.debug?.actions?.get('perf-run-full');
    if (!action) return { ok: false, reason: 'perf-run-full action not found' };
    try {
      const r = await action.fn();
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, reason: `action threw: ${e?.message ?? e}\n${e?.stack ?? ''}` };
    }
  });
  const elapsedS = Math.round((Date.now() - t0) / 1000);
  console.log(`[sharpening-ab-live] perf-run-full finished after ${elapsedS}s, ok=${result.ok}`);

  fs.writeFileSync(
    path.join(OUT_DIR, 'sharpening-ab-live-result.json'),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        elapsedS,
        panelResult,
        toggleCheck,
        setResult,
        ok: result.ok,
        reason: result.reason ?? null,
        sharpeningAB: result.result?.sharpeningAB ?? null,
        consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 60),
      },
      null,
      2
    )
  );
  console.log('[sharpening-ab-live] wrote sharpening-ab-live-result.json');
} finally {
  await context.close().catch(() => {});
  await launcher.stop();
}
