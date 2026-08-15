/**
 * ONE-OFF LIVE DIAGNOSTIC — does the Global Illumination write-back actually
 * flip `canvas.environment.globalLightSource.active` (the REAL boolean
 * `CanvasVisibility#testVisibility`/`testInsideLight` gate on), and does it
 * stay OFF at midnight and off-window darkness the same way it does today?
 *
 * Root cause (see `foundry/scene-environment.js#deriveGlobalLightWindow`'s
 * own header): `publishSceneDarkness` (shipped 2026-08-15) keeps
 * `environment.darknessLevel` tracking MSA's sun model, but
 * `environment.globalLight.enabled` is a SEPARATE gate, schema-default
 * `false`, that a darkness-level fix alone can never flip — confirmed via the
 * actual bench Mansion scene export, `environment.globalLight.enabled` was
 * `false` there. This is why a token standing outside at noon still could not
 * see without a personal light or a nearby real light source even after that
 * fix. This spec drives the real module in a real browser against the real
 * bench world, moves the sun with `MapShine.setSunHour` (the same function
 * the astrolabe calls), and reads back what Foundry itself is holding —
 * instead of trusting the derivation from source reading alone.
 *
 * Mirrors `msa-darkness-writeback.spec.js`'s own proven scaffold exactly
 * (same login/ready/settle sequence, same pitfalls already paid for there —
 * `runReport` is async AND returns a JSON string, not an object).
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
const PROFILE_DIR =
  process.env.MSA_LOOK_PROFILE || path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');

test.setTimeout(300000);

async function readState(page) {
  return page.evaluate(async () => {
    let diag = null;
    try {
      const raw = await window.MapShine?.debug?.runReport?.('vt-pan-viewer-diagnostics');
      diag = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      diag = { error: String(e) };
    }

    // Independently derive a point that should be INSIDE a real
    // adjustDarknessLevel region (probe a small grid across its first
    // shape's own bounding box, verified with the region's OWN testPoint —
    // never assumed), and a point far in the scene rect's corner, which for
    // a building authored with grounds/padding around it is very likely
    // genuine outdoor space. Both best-effort: absence never fails the test,
    // it just leaves that field null rather than fabricating a coordinate.
    let indoorProbePoint = null;
    let indoorProbeRegionId = null;
    try {
      const regions = [...(window.canvas?.scene?.regions ?? [])].filter((r) =>
        [...(r.behaviors ?? [])].some((b) => b.type === 'adjustDarknessLevel' && !b.disabled)
      );
      outer: for (const region of regions) {
        const shape = region.shapes?.[0];
        if (!shape) continue;
        const b = region.bounds ?? null;
        if (!b) continue;
        const steps = 6;
        for (let i = 1; i < steps; i++) {
          for (let j = 1; j < steps; j++) {
            const px = b.x + (b.width * i) / steps;
            const py = b.y + (b.height * j) / steps;
            if (region.testPoint?.({ x: px, y: py, elevation: (region.elevation?.bottom ?? 0) + 1 })) {
              indoorProbePoint = { x: px, y: py, elevation: (region.elevation?.bottom ?? 0) + 1 };
              indoorProbeRegionId = region.id;
              break outer;
            }
          }
        }
      }
    } catch (_) {
      /* best-effort only */
    }

    let outdoorProbePoint = null;
    try {
      const rect = window.canvas?.dimensions?.sceneRect;
      if (rect) {
        // 2% inset from the corner — inside the scene bounds, but about as
        // far from a centered building footprint as this rect allows.
        outdoorProbePoint = { x: rect.x + rect.width * 0.02, y: rect.y + rect.height * 0.02, elevation: 0 };
      }
    } catch (_) {
      /* best-effort only */
    }

    const testInsideLight = (pt) => {
      if (!pt) return null;
      try {
        return window.canvas?.effects?.testInsideLight?.(pt) ?? null;
      } catch (e) {
        return `threw: ${e}`;
      }
    };

    // Isolate WHICH mechanism a true testInsideLight actually came from —
    // the global window (what this fix controls) vs. a real, ordinary light
    // fixture's own radius (completely independent of this fix; the mansion
    // has ~50 placed lights, plausibly one is just near the probe point).
    const diagnoseMechanism = (pt) => {
      if (!pt) return null;
      try {
        const g = window.canvas?.environment?.globalLightSource;
        const darknessLevel = window.canvas?.effects?.getDarknessLevel?.(pt) ?? null;
        const viaGlobalWindow =
          !!g?.active &&
          darknessLevel !== null &&
          darknessLevel >= g.data.darkness.min &&
          darknessLevel <= g.data.darkness.max;
        let viaRealLight = false;
        let realLightMatches = [];
        for (const ls of window.canvas?.effects?.lightSources ?? []) {
          if (!ls.active || ls === g) continue;
          try {
            if (ls.testPoint?.(pt)) {
              viaRealLight = true;
              realLightMatches.push(ls.object?.id ?? ls.sourceId ?? 'unknown');
            }
          } catch (_) {
            /* skip a source that throws on testPoint */
          }
        }
        return {
          darknessLevel,
          globalWindow: g?.data?.darkness ?? null,
          viaGlobalWindow,
          viaRealLight,
          realLightMatches,
        };
      } catch (e) {
        return { error: String(e) };
      }
    };

    return {
      foundryGlobalLightEnabled: window.canvas?.scene?.environment?.globalLight?.enabled ?? null,
      foundryGlobalLightWindow: window.canvas?.scene?.environment?.globalLight?.darkness ?? null,
      globalLightSourceActive: window.canvas?.environment?.globalLightSource?.active ?? null,
      foundryDarknessLevel: window.canvas?.scene?.environment?.darknessLevel ?? null,
      envSnapshot: diag?.envSnapshot ?? null,
      indoorProbePoint,
      indoorProbeRegionId,
      outdoorProbePoint,
      indoorTestInsideLight: testInsideLight(indoorProbePoint),
      outdoorTestInsideLight: testInsideLight(outdoorProbePoint),
      indoorMechanism: diagnoseMechanism(indoorProbePoint),
      outdoorMechanism: diagnoseMechanism(outdoorProbePoint),
    };
  });
}

test('does the Global Illumination write-back flip globalLightSource.active, and only where it should?', async () => {
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
      `[globalLight] ${label}: enabled=${st.foundryGlobalLightEnabled} window=${JSON.stringify(st.foundryGlobalLightWindow)} ` +
        `active=${st.globalLightSourceActive} darkness=${st.foundryDarknessLevel} ` +
        `minRegionFloor=${st.envSnapshot?.minDarknessRegionFloor ?? 'n/a'} ` +
        `published=${JSON.stringify(st.envSnapshot?.publishedGlobalLightWindow ?? null)} ` +
        `publishOk=${st.envSnapshot?.globalLightPublish?.ok ?? 'n/a'} ` +
        `outdoorProbe=${JSON.stringify(st.outdoorProbePoint)}->${st.outdoorTestInsideLight} mech=${JSON.stringify(st.outdoorMechanism)} ` +
        `indoorProbe=${JSON.stringify(st.indoorProbePoint)}->${st.indoorTestInsideLight} mech=${JSON.stringify(st.indoorMechanism)}`
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
    await waitForSceneSettled(page, { timeoutMs: 150000, label: 'global-light-test' });

    const loopReady = await page
      .waitForFunction(
        async () => {
          try {
            const raw = await window.MapShine?.debug?.runReport?.('vt-pan-viewer-diagnostics');
            const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (r?.envSnapshot?.available !== true) return false;
            window.__globalLightTestStableReads = (window.__globalLightTestStableReads || 0) + 1;
            return window.__globalLightTestStableReads >= 5;
          } catch (_) {
            window.__globalLightTestStableReads = 0;
            return false;
          }
        },
        { timeout: 30000, polling: 200 }
      )
      .then(() => true)
      .catch(() => false);
    console.log(`[globalLight] env snapshot stably live: ${loopReady}`);

    await record('startup (whatever hour the scene loaded at)');

    // NOON — the exact reported scenario: darkness01 should be ~0, and IF the
    // bench scene has a protective region, globalLightSource.active should
    // now be true (closing the reported gap) while still false indoors.
    await page.evaluate(() => window.MapShine?.setSunHour?.(12));
    await page.waitForTimeout(2000); // > both the darkness AND the change-only window-publish path
    await record('after setSunHour(12) + 2s');

    // MIDNIGHT — darkness01 -> 1, well outside the derived window (~0.48).
    // globalLightSource.active must go back to false: this is the check that
    // the fix does NOT just blanket-enable vision, only the safe slice of it.
    await page.evaluate(() => window.MapShine?.setSunHour?.(0));
    await page.waitForTimeout(2000);
    await record('after setSunHour(0) + 2s');

    // Back to noon — proves this tracks the sun continuously, not a one-shot.
    await page.evaluate(() => window.MapShine?.setSunHour?.(12));
    await page.waitForTimeout(2000);
    await record('after setSunHour(12) again + 2s');

    const summary = {
      capturedAt: new Date().toISOString(),
      loopReady,
      timeline,
      consoleErrors: consoleErrors.slice(0, 40),
    };
    fs.writeFileSync(path.join(OUT_DIR, 'global-light-writeback.json'), JSON.stringify(summary, null, 2));
    console.log(`[globalLight] wrote ${path.join(OUT_DIR, 'global-light-writeback.json')}`);
  } finally {
    await context.close().catch(() => {});
    await launcher.stop();
  }
});
