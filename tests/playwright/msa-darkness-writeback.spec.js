/**
 * ONE-OFF LIVE DIAGNOSTIC — does MSA's darkness write-back actually reach
 * `canvas.scene.environment.darknessLevel`?
 *
 * Author-reported, twice: "the actual 'scene darkness' value doesn't change
 * when time of day changes." A static-analysis fix already shipped (the
 * publish throttle was reading SIM time, which freezes on pause) and the
 * report is that it is STILL broken. This drives the real module, in a real
 * browser, against the real bench world, sets the sun hour directly
 * (`MapShine.setSunHour`, the same function the astrolabe calls), and reads
 * back `canvas.scene.environment.darknessLevel` plus the viewer's own
 * `envSnapshot` diagnostics — instead of guessing again from source alone.
 *
 * Deliberately skips the BC-compression art-load wait (`waitForMapArtLoaded`)
 * that `msa-look.spec.js` needs for a screenshot: this only needs the render
 * loop ticking, not the art fully streamed in, and `envSnapshot.available`
 * becoming true is itself proof the loop is alive.
 *
 * Not a permanent regression test — a throwaway harness for THIS
 * investigation. Delete once the bug is closed and confirmed live by the
 * author's own eyes.
 */

const fs = require('fs');
const path = require('path');
const { test, chromium } = require('@playwright/test');
const { FoundryLauncher } = require('./foundry-launcher');
const {
  bestEffortLogin,
  waitForGameReady,
  waitForCanvasReady,
  waitForMapShineReady,
  ensureActiveScene,
  unpauseIfPaused,
  waitForSceneSettled,
} = require('./map-shine-utils');

if (!process.env.FOUNDRY_USER_NAME && !process.env.FOUNDRY_USER_ID) {
  process.env.FOUNDRY_USER_NAME = 'Bench';
}

const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const PROFILE_DIR = process.env.MSA_LOOK_PROFILE || path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');

test.setTimeout(300000);

async function readState(page) {
  return page.evaluate(async () => {
    // ⚠️ `runReport` IS ASYNC (an unawaited call hands Playwright's evaluate a
    // live Promise embedded in the return object, which hangs the whole call)
    // AND IT RETURNS A JSON STRING, NOT THE OBJECT (debug-panel.js#runReport:
    // `JSON.stringify(result, null, 2)`, for the debug panel's own copy-to-
    // clipboard button) — msa-look.spec.js's own reader already knows this
    // ("typeof r === 'string' ? r.slice(...) : r"); this test's first two runs
    // did not, so `envSnapshot` silently read `undefined` off a string every
    // single time despite the underlying mechanism working correctly.
    let diag = null;
    try {
      const raw = await window.MapShine?.debug?.runReport?.('vt-pan-viewer-diagnostics');
      diag = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      diag = { error: String(e) };
    }
    return {
      foundryDarknessLevel: window.canvas?.scene?.environment?.darknessLevel ?? null,
      canvasDarknessLevel: window.canvas?.darknessLevel ?? null,
      // THE PERSISTED value — what the Scene Configuration sheet's Darkness
      // Level field reads (scene-config.mjs's own `context.source`, which is
      // `document.toObject()`/`_source` — the database-backed value, never the
      // live runtime one `canvas.environment.initialize()` mutates). If this
      // stays 0 while `foundryDarknessLevel` above moves, that is the whole
      // explanation for "I checked scene darkness and it's still 0": the GM is
      // very likely looking at THIS number, not that one.
      persistedDarknessLevel: window.canvas?.scene?._source?.environment?.darknessLevel ?? null,
      persistedDarknessLevelViaToObject: window.canvas?.scene?.toObject?.()?.environment?.darknessLevel ?? null,
      envSnapshot: diag?.envSnapshot ?? null,
    };
  });
}

test('does the darkness write-back reach canvas.scene.environment.darknessLevel?', async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

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

  const timeline = [];
  const record = async (label) => {
    const st = await readState(page);
    timeline.push({ label, at: new Date().toISOString(), ...st });
    console.log(
      `[darkness] ${label}: foundry=${st.foundryDarknessLevel} canvas=${st.canvasDarknessLevel} ` +
        `persisted=${st.persistedDarknessLevel} persistedViaToObject=${st.persistedDarknessLevelViaToObject} ` +
        `env.darkness01=${st.envSnapshot?.env?.darkness01 ?? 'n/a'} ` +
        `published=${st.envSnapshot?.publishedDarkness01 ?? 'n/a'} attempts=${st.envSnapshot?.darknessPublishAttempts ?? 'n/a'} ` +
        `publishOk=${st.envSnapshot?.darknessPublish?.ok ?? 'n/a'} publishReason=${st.envSnapshot?.darknessPublish?.reason ?? 'n/a'} ` +
        `foundryDarkness01(reported)=${st.envSnapshot?.foundryDarkness01 ?? 'n/a'} available=${st.envSnapshot?.available}`
    );
    return st;
  };

  try {
    await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
    await bestEffortLogin(page);
    await waitForGameReady(page);
    await ensureActiveScene(page);
    await waitForCanvasReady(page);
    await waitForMapShineReady(page);
    await unpauseIfPaused(page);

    // ⚠️ `waitForMapShineReady` alone is NOT enough — the first run of this
    // script proved it: `envSnapshot.available` flickered true once and then
    // reported `_active` as null moments later ("viewer not started"), which
    // means a scene/floor rebuild was still in flight underneath the "ready"
    // signal. `waitForSceneSettled` polls MSA's own real outstanding-work
    // counters instead of a coarse booted-flag, and is what the existing
    // harness uses for exactly this reason (map-shine-utils.js's own header).
    await waitForSceneSettled(page, { timeoutMs: 150000, label: 'darkness-test' });

    // Now REQUIRE several consecutive live reads, not just one, before
    // trusting the viewer is stable enough to run the actual experiment on.
    const loopReady = await page.waitForFunction(
      async () => {
        try {
          const raw = await window.MapShine?.debug?.runReport?.('vt-pan-viewer-diagnostics');
          const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (r?.envSnapshot?.available !== true) return false;
          window.__darknessTestStableReads = (window.__darknessTestStableReads || 0) + 1;
          return window.__darknessTestStableReads >= 5;
        } catch (_) {
          window.__darknessTestStableReads = 0;
          return false;
        }
      },
      { timeout: 30000, polling: 200 }
    ).then(() => true).catch(() => false);
    console.log(`[darkness] env snapshot stably live: ${loopReady}`);

    await record('startup (whatever hour the scene loaded at)');

    // NOON — a clean, unambiguous "should be near-zero darkness" baseline.
    const noonResult = await page.evaluate(() => window.MapShine?.setSunHour?.(12));
    console.log(`[darkness] setSunHour(12) -> ${JSON.stringify(noonResult)}`);
    await page.waitForTimeout(1500); // > the 250ms publish throttle interval, several times over
    await record('after setSunHour(12) + 1.5s');

    // MIDNIGHT — the author's own exact test.
    const midnightResult = await page.evaluate(() => window.MapShine?.setSunHour?.(0));
    console.log(`[darkness] setSunHour(0) -> ${JSON.stringify(midnightResult)}`);
    await page.waitForTimeout(300);
    await record('after setSunHour(0) + 0.3s (first publish window)');
    await page.waitForTimeout(1500);
    await record('after setSunHour(0) + 1.8s total');

    // Back to noon — proves it is not a one-way ratchet (the exact V2 disaster
    // shape this investigation is checking for).
    await page.evaluate(() => window.MapShine?.setSunHour?.(12));
    await page.waitForTimeout(1500);
    await record('after setSunHour(12) again + 1.5s (does it come back down?)');

    const summary = {
      capturedAt: new Date().toISOString(),
      loopReady,
      timeline,
      consoleErrors: consoleErrors.slice(0, 40),
    };
    fs.writeFileSync(path.join(OUT_DIR, 'darkness-writeback.json'), JSON.stringify(summary, null, 2));
    console.log(`[darkness] wrote ${path.join(OUT_DIR, 'darkness-writeback.json')}`);
  } finally {
    await context.close().catch(() => {});
    await launcher.stop();
  }
});
