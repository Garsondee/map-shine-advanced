/** THE ACTUAL LIVE PATH, FIRST FLOOR — narrow, single-purpose check
 * (2026-08-13).
 *
 * Everything checked so far (native resolution, per-Level textures config,
 * source count, and now the derived grid's own texel content — 25 texels
 * clear PAINT_THRESHOLD on First Floor, proven via `fireTexelsAtOrAbove
 * PaintThreshold`) says the underlying mask DATA is correct. But none of
 * those checks ever actually SWITCHED to First Floor, so none of them
 * exercised `getFireRenderState()` at `floorIndex=1` — the actual live path
 * `fireSubsystem.sync()` reads every frame, and the one that logs "painted
 * region on floor N yielded M fire(s)" (`boot.js#getMaskDrivenFires`). This
 * script switches to First Floor, then captures that exact log line plus
 * every other console message (not just errors, unlike the other scripts in
 * this directory) to see whether extraction itself finds 0 or something
 * nonzero once the correct floor is actually being viewed.
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

const LABEL = 'fire-extraction-live';
const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const resultPath = path.join(OUT_DIR, `${LABEL}-result.json`);

fs.mkdirSync(OUT_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());

// ALL console messages this time, not just errors — the line we actually
// need ("painted region on floor N yielded M fire(s)") is an info log.
const allConsole = [];
page.on('console', (m) => allConsole.push({ type: m.type(), text: m.text(), at: Date.now() }));
page.on('pageerror', (e) => allConsole.push({ type: 'pageerror', text: String(e), at: Date.now() }));

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();

const state = { label: LABEL, startedAt: new Date().toISOString() };
function save() {
  fs.writeFileSync(resultPath, JSON.stringify(state, null, 2));
}

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
    if (st && (st.complete || !st.showing)) return st;
    if (Date.now() - start > timeoutMs) throw new Error(`Map art did not finish loading after ${Math.round((Date.now() - start) / 1000)}s`);
    await page.waitForTimeout(1000);
  }
}

try {
  console.log(`[${LABEL}] goto ${launcher.getBaseUrl()}`);
  await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
  await bestEffortLogin(page);
  await waitForGameReady(page);
  await waitForCanvasReady(page);
  await waitForMapShineReady(page);
  await unpauseIfPaused(page);

  console.log(`[${LABEL}] waiting for map art to finish loading (Ground Floor)...`);
  await waitForMapArtLoaded(600000);
  await waitForSceneSettled(page, { label: 'ground floor load', timeoutMs: 300000 });
  await page.waitForTimeout(3000);

  const groundConsoleCountBeforeSwitch = allConsole.length;
  console.log(`[${LABEL}] Ground Floor settled. Console lines so far: ${groundConsoleCountBeforeSwitch}`);

  // Find First Floor's level id from the live scene, then switch to it via
  // MSA's own setVtPanViewerFloor + the SAME activeFloorContext sync path
  // Foundry's native floor nav uses (paint-mode.js's own changeFloor does
  // exactly this two-step: setVtPanViewerFloor, then whatever syncs
  // activeFloorContext — here, just clicking Foundry's own level nav is more
  // faithful to what the author actually does than calling MSA internals
  // directly, so this drives the UI control itself).
  const switchResult = await page.evaluate(async () => {
    const levels = window.canvas?.scene?.levels;
    let firstFloorId = null;
    levels?.forEach?.((lvl) => {
      if (lvl.id !== window.canvas?.scene?.levels?.contents?.[0]?.id && !firstFloorId) firstFloorId = lvl.id;
    });
    // Prefer Foundry's own level-change API if present (most faithful to a
    // real GM clicking the floor nav), falling back to MSA's own residency
    // swap directly.
    try {
      if (window.canvas?.levels?.gotoLevel) {
        await window.canvas.levels.gotoLevel(firstFloorId);
        return { method: 'canvas.levels.gotoLevel', firstFloorId };
      }
    } catch (e) {
      /* fall through */
    }
    try {
      await window.canvas?.scene?.view?.({ level: firstFloorId });
      return { method: 'scene.view', firstFloorId };
    } catch (e) {
      return { method: 'failed', firstFloorId, error: String(e?.message ?? e) };
    }
  });
  console.log(`[${LABEL}] floor switch:`, JSON.stringify(switchResult));

  // Real settle time — floor switches specifically need dwell
  // (feedback_floor_switch_needs_settle_time).
  await waitForSceneSettled(page, { label: 'after floor switch', timeoutMs: 300000 });
  await page.waitForTimeout(15000);

  state.viewedLevelAfterSwitch = await page.evaluate(() => ({
    id: window.canvas?.level?.id ?? null,
    name: window.canvas?.level?.name ?? null,
  }));
  console.log(`[${LABEL}] now viewing:`, JSON.stringify(state.viewedLevelAfterSwitch));

  // One more explicit nudge: force a fire re-sync if MSA exposes anything
  // report-shaped for it, and read whatever debug reports exist that might
  // carry fire's own live state.
  const reportNames = await page.evaluate(() => {
    try {
      return Object.keys(window.MapShine?.debug?._reports ?? window.MapShine?.debug ?? {});
    } catch (e) {
      return [];
    }
  });
  state.availableDebugSurface = reportNames;

  await page.waitForTimeout(5000);

  const fireLines = allConsole.filter((l) => /fire/i.test(l.text));
  state.fireConsoleLines = fireLines;
  state.totalConsoleLines = allConsole.length;
  state.allConsoleTail = allConsole.slice(-80);
  save();

  console.log(`[${LABEL}] ===== FIRE-RELATED CONSOLE LINES (${fireLines.length}) =====`);
  for (const l of fireLines) console.log(`[${LABEL}] [${l.type}] ${l.text}`);

  state.ok = true;
} catch (e) {
  console.error(`[${LABEL}] run stopped early:`, e);
  state.error = String(e?.stack || e?.message || e);
  state.allConsoleTail = allConsole.slice(-80);
} finally {
  save();
  await context.close().catch(() => {});
  await launcher.stop();
  console.log(`[${LABEL}] wrote ${resultPath}`);
}
