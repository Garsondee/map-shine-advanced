/** gateGlass verification capture — ONE load, time frozen, First Floor.
 *
 * `gateGlass` is a MATERIAL-CONSTRUCTION-time parameter (window-render.js),
 * not a live-flippable flag like `earlyZComposition` — so unlike
 * stage1-earlyz-pixel-diff.mjs this cannot diff within one session. Run this
 * once per source state (gateGlass hardcoded true/false in
 * window-surface-subsystem.js at capture time) and diff the two saved PNGs
 * afterwards with diff-window-canvas.mjs.
 *
 * Time is frozen before capture for the same reason as the Stage 1 precedent:
 * candles/fire/water/wind all animate, and an animated pixel differs between
 * two SEPARATE loads for reasons that have nothing to do with this flag.
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import {
  bestEffortLogin,
  waitForGameReady,
  waitForCanvasReady,
  waitForMapShineReady,
  unpauseIfPaused,
  waitForSceneSettled,
} from '../../playwright/map-shine-utils.js';

const LABEL = process.argv[2];
if (!LABEL) {
  console.error('usage: node capture-window-canvas.mjs <label>');
  process.exit(1);
}

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`));

const cdp = await context.newCDPSession(page);
await cdp.send('Network.clearBrowserCache');

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();
await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
await bestEffortLogin(page);
await waitForGameReady(page);
await waitForCanvasReady(page);
await waitForMapShineReady(page);
await unpauseIfPaused(page);

async function waitForMapArtLoaded(timeoutMs) {
  const start = Date.now();
  for (;;) {
    const st = await page.evaluate(async () => {
      try {
        const raw = await window.MapShine?.debug?.runReport?.('loading-screen-state');
        const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return { showing: r?.showing !== false, complete: r?.current?.complete === true, error: r?.current?.error ?? null };
      } catch (e) {
        return { showing: true, error: null };
      }
    });
    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Map art did not finish loading after ${Math.round((Date.now() - start) / 1000)}s`);
    await page.waitForTimeout(1000);
  }
}
console.log(`[${LABEL}] waiting for real map art…`);
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'ground floor' });

// FIRST FLOOR — two floors stacked, Ground's window light genuinely occluded
// where the upper floor is solid. This is the case gateGlass exists for.
const clicked = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('*')).filter(
    (el) => el.children.length === 0 && el.textContent?.trim() === 'First Floor'
  );
  if (!els.length) return { ok: false, reason: 'no "First Floor" control found' };
  els[0].click();
  return { ok: true };
});
console.log(`[${LABEL}] floor switch:`, JSON.stringify(clicked));
if (!clicked.ok) throw new Error(clicked.reason);
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'first floor' });

// FREEZE TIME — see this file's header.
const frozen = await page.evaluate(() => {
  try {
    window.MapShine?.setTimeRate?.(0);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
});
console.log(`[${LABEL}] time freeze:`, JSON.stringify(frozen));
await page.waitForTimeout(2000);

// Zoom out a little and pan toward the mansion's window-heavy exterior wall
// so a real cookie is actually in frame, not just interior rooms.
await page.mouse.wheel(0, 300);
await page.waitForTimeout(600);
await waitForSceneSettled(page, { label: 'after zoom' });

const windowDiag = await page.evaluate(() => {
  try {
    return window.MapShine?.getVtPanViewerDiagnostics?.()?.windowLight ?? null;
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
});
console.log(`[${LABEL}] windowLight diagnostics:`, JSON.stringify(windowDiag));

await page
  .locator('canvas#msa-vt-pan-viewer-canvas')
  .screenshot({ path: path.join(OUT_DIR, `${LABEL}-frozen-canvas.png`) });
await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-frozen-viewport.png`) });

fs.writeFileSync(
  path.join(OUT_DIR, `${LABEL}-frozen-result.json`),
  JSON.stringify(
    {
      label: LABEL,
      windowDiag,
      consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 40),
    },
    null,
    2
  )
);
console.log(`[${LABEL}] wrote ${LABEL}-frozen-canvas.png + result.json`);

await context.close();
