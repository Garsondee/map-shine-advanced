// LIVE VERIFICATION for the decode-pool.js `_sourceCache` unbounded-growth fix (2026-08-12).
//
// Standalone script (same pattern as relaunch-world.mjs), not a `test()` spec, because this
// drives a deliberately unusual sequence — visit scene A, create + visit a genuinely distinct
// scene B, revisit A — that the existing msa-look.spec.js has no reason to do.
//
// What it proves, live, that the Node suite (decode-primitives.test.mjs / pixi-proxy-textures
// .test.mjs) cannot: real fetch()+createImageBitmap()+close() through the real pinned-refcount
// path, with real async timing, with no thrown "closed ImageBitmap" error, and a revisited scene
// that still renders (not a black/broken floor).
//
// Usage:
//   node tests/playwright-artifacts/look/eviction-verify.mjs
//
// Reads `pinnedSources` (decode-pool.js's getDecodeStats(), surfaced via the existing
// 'vt-pan-viewer-diagnostics' debug report) at each step:
//   1. baseline (mansion, 2 floors)              -> expect 2
//   2. after switching to a 2nd, distinct scene   -> expect 1 (mansion's 2 released, door's 1 pinned)
//   3. after switching BACK to the mansion        -> expect 2 again (re-fetched, not stuck at 0/3)
// A run against the pre-fix code (releaseSourceBitmap with no caller) would show step 2 as 3, not
// 1 — nothing ever released. That comparison is the whole point of this script.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import {
  bestEffortLogin,
  waitForGameReady,
  waitForCanvasReady,
  waitForMapShineReady,
  ensureActiveScene,
  unpauseIfPaused,
  waitForSceneSettled,
} from '../../playwright/map-shine-utils.js';

const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
// A DEDICATED profile dir, not the shared `chrome-profile` msa-look.spec.js uses — a leftover
// Chrome process from an unrelated earlier session was found still holding that directory's
// lock (confirmed via its command line: same --user-data-dir, a stale automation artifact, not
// the author's own browser). Using a separate directory here sidesteps that conflict entirely
// rather than requiring any process to be killed. Cost: no warm BC-compression cache on the
// first run of this script (cold mansion load is ~50s+ slower) — acceptable for a one-off check.
const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile-eviction-verify');
const DOOR_ASSET =
  'modules/map-shine-advanced/mansion_example_map/mythica-machina-mansion-redux/assets/crosshead_golden_door_01.webp';

async function decodeStats(page) {
  return page.evaluate(async () => {
    const raw = await window.MapShine?.debug?.runReport?.('vt-pan-viewer-diagnostics');
    const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return r?.decodeStats ?? null;
  });
}

async function loadingComplete(page) {
  return page.evaluate(async () => {
    const raw = await window.MapShine?.debug?.runReport?.('loading-screen-state');
    const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { showing: r?.showing !== false, complete: r?.current?.complete === true, error: r?.current?.error ?? null };
  });
}

async function waitForLoadingScreenClear(page, timeoutMs = 120000) {
  const start = Date.now();
  for (;;) {
    const st = await loadingComplete(page);
    if (st.error) throw new Error(`loading screen reported an error: ${JSON.stringify(st.error)}`);
    if (st.complete || !st.showing) return st;
    if (Date.now() - start > timeoutMs) throw new Error(`loading screen never cleared after ${timeoutMs}ms`);
    await page.waitForTimeout(500);
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const log = [];
  const record = (msg) => {
    console.log(msg);
    log.push(msg);
  };

  if (!process.env.FOUNDRY_USER_NAME && !process.env.FOUNDRY_USER_ID) process.env.FOUNDRY_USER_NAME = 'Bench';

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1600, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = context.pages()[0] || (await context.newPage());
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 500));
  });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${String(e).slice(0, 500)}`));

  const launcher = new FoundryLauncher({ headless: true });
  await launcher.start();

  const result = { steps: [], consoleErrors: [], ok: false };

  try {
    await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
    await bestEffortLogin(page);
    await waitForGameReady(page);
    await ensureActiveScene(page);
    await waitForCanvasReady(page);
    await waitForMapShineReady(page);
    await unpauseIfPaused(page);
    await waitForLoadingScreenClear(page, 600000);
    await waitForSceneSettled(page, { label: 'mansion (baseline)' });
    await page.waitForTimeout(3000);

    const mansionId = await page.evaluate(() => window.canvas?.scene?.id ?? null);
    const mansionName = await page.evaluate(() => window.canvas?.scene?.name ?? null);
    const baseline = await decodeStats(page);
    record(`[step 1] baseline scene="${mansionName}" pinnedSources=${baseline?.pinnedSources} awaitingRelease=${baseline?.pinnedSourcesAwaitingRelease}`);
    result.steps.push({ step: 'baseline', sceneName: mansionName, decodeStats: baseline });

    // --- create a genuinely distinct 2nd scene, pointed at a small already-served
    // image that is NOT one of the mansion's own floor URLs. ---------------------
    const created = await page.evaluate(async (src) => {
      try {
        const doc = await Scene.create({ name: 'MSA Eviction Verify (temp)', background: { src } });
        return { ok: true, id: doc.id };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    }, DOOR_ASSET);
    if (!created.ok) throw new Error(`Scene.create failed: ${created.error}`);
    record(`[setup] created temp scene id=${created.id}`);

    const activated = await page.evaluate(async (id) => {
      try {
        const doc = game.scenes.get(id);
        await doc.activate();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    }, created.id);
    if (!activated.ok) throw new Error(`activating temp scene failed: ${activated.error}`);

    await waitForCanvasReady(page);
    await waitForLoadingScreenClear(page, 120000);
    await waitForSceneSettled(page, { label: 'temp scene', timeoutMs: 120000 });
    await page.waitForTimeout(3000);

    const afterSwitch = await decodeStats(page);
    record(`[step 2] after switching to temp scene: pinnedSources=${afterSwitch?.pinnedSources} awaitingRelease=${afterSwitch?.pinnedSourcesAwaitingRelease}`);
    result.steps.push({ step: 'after-switch-to-temp-scene', decodeStats: afterSwitch });

    // --- switch back to the mansion; confirm it re-fetches (bounded, not stuck) AND
    // still renders (the black-floor regression check). ---------------------------
    const backOk = await page.evaluate(async (id) => {
      try {
        await game.scenes.get(id).activate();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    }, mansionId);
    if (!backOk.ok) throw new Error(`re-activating mansion failed: ${backOk.error}`);

    await waitForCanvasReady(page);
    await waitForLoadingScreenClear(page, 600000);
    await waitForSceneSettled(page, { label: 'mansion (revisit)' });
    await page.waitForTimeout(3000);

    const afterRevisit = await decodeStats(page);
    record(`[step 3] after revisiting mansion: pinnedSources=${afterRevisit?.pinnedSources} awaitingRelease=${afterRevisit?.pinnedSourcesAwaitingRelease}`);
    result.steps.push({ step: 'after-revisit-mansion', decodeStats: afterRevisit });

    const canvasEl = page.locator('canvas#msa-vt-pan-viewer-canvas');
    if (await canvasEl.count()) {
      await canvasEl.screenshot({ path: path.join(OUT_DIR, 'eviction-verify-revisit.png') }).catch(() => {});
      record('[step 3] screenshot written: eviction-verify-revisit.png (visual black-floor check)');
    }

    // Sample a handful of pixels from the MSA canvas to catch an all-black/all-transparent
    // revisit programmatically, not just by eyeballing the PNG.
    const pixelCheck = await page.evaluate(() => {
      const c = document.querySelector('canvas#msa-vt-pan-viewer-canvas');
      if (!c) return { ok: false, reason: 'no msa canvas element found' };
      try {
        const off = document.createElement('canvas');
        off.width = c.width;
        off.height = c.height;
        const ctx = off.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const { data } = ctx.getImageData(0, 0, off.width, off.height);
        let nonBlack = 0;
        const samples = 400;
        const step = Math.max(1, Math.floor(data.length / 4 / samples));
        let checked = 0;
        for (let i = 0; i < data.length; i += step * 4) {
          checked++;
          if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) nonBlack++;
        }
        return { ok: true, checked, nonBlack, fraction: checked ? nonBlack / checked : 0 };
      } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) };
      }
    });
    record(`[step 3] pixel check: ${JSON.stringify(pixelCheck)}`);
    result.pixelCheck = pixelCheck;

    // --- cleanup: delete the temp scene so the bench world stays tidy. -----------
    const deleted = await page.evaluate(async (id) => {
      try {
        await game.scenes.get(id)?.delete();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    }, created.id);
    record(`[cleanup] deleted temp scene: ${JSON.stringify(deleted)}`);

    result.consoleErrors = consoleErrors.slice(0, 40);
    result.ok = true;
    result.verdict = {
      baselinePinned: baseline?.pinnedSources ?? null,
      afterSwitchPinned: afterSwitch?.pinnedSources ?? null,
      afterRevisitPinned: afterRevisit?.pinnedSources ?? null,
      grewUnboundedAcrossTwoScenes: (afterSwitch?.pinnedSources ?? 0) > (baseline?.pinnedSources ?? 0),
      revisitBounded: (afterRevisit?.pinnedSources ?? -1) === (baseline?.pinnedSources ?? -2),
      canvasRendersNonBlack: pixelCheck.ok && pixelCheck.fraction > 0.1,
    };
    record(`[verdict] ${JSON.stringify(result.verdict, null, 2)}`);
  } catch (err) {
    result.ok = false;
    result.error = String(err?.message ?? err);
    record(`[FAILED] ${result.error}`);
    console.log(err?.stack || err);
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, 'eviction-verify.json'), JSON.stringify(result, null, 2));
    await context.close().catch(() => {});
    await launcher.stop();
  }

  process.exit(result.ok ? 0 : 1);
}

main();
