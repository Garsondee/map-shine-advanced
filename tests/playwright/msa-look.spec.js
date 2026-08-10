/**
 * "LOOK AT THE SCENE" — the live-verification harness.
 *
 * WHY THIS EXISTS. The shader lab runs real shaders on real WebGPU with no Foundry, and it is
 * still the fastest way to iterate on shader logic — but the author's own verdict (2026-08-10)
 * is that it "often doesn't translate 100% accurately". Everything the lab cannot see lives in
 * the gap between it and production: real 12,000px BC-compressed art, real residency, real
 * multi-floor scene levels, real Foundry documents, real pass ordering. This spec closes that
 * gap by driving the REAL module, in a REAL browser, on the REAL GPU, against a REAL world —
 * and writing PNGs an assistant (or the author) can actually look at.
 *
 * It asserts almost nothing on purpose. It is an instrument, not a gate: its job is to produce
 * honest artifacts plus a machine-readable summary. Verdicts on how the scene LOOKS remain the
 * author's — a screenshot is evidence, never a promotion to LIVE.
 *
 * OUTPUT (tests/playwright-artifacts/look/):
 *   <label>-viewport.png   what the whole window shows
 *   <label>-msa-canvas.png just the module's own canvas, cropped
 *   <label>.json           fps, adapter, floor state, console errors, MSA report data
 *
 * USAGE:
 *   npx playwright test tests/playwright/msa-look.spec.js
 *   MSA_LOOK_SECONDS=20 MSA_LOOK_REPORTS=perf-profile,vt-pan-viewer-layers npx playwright test ...
 *
 * Set FOUNDRY_BASE_URL to point at an already-running Foundry instead of launching one; the
 * launcher also auto-attaches if the port is already serving, so an open Foundry is reused
 * rather than fought with over its data-directory lock.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, chromium } = require('@playwright/test');
const { FoundryLauncher } = require('./foundry-launcher');
const {
  bestEffortLogin,
  waitForGameReady,
  waitForCanvasReady,
  waitForMapShineReady,
  ensureActiveScene,
  unpauseIfPaused
} = require('./map-shine-utils');

// Log in as a DEDICATED bench user, not the human's Gamemaster. Foundry allows one session
// per user and its join dropdown omits users who are already connected — so when the author
// (or a debugging browser tab) is signed in as Gamemaster, the dropdown is empty, no user can
// be selected, and the run stalls on the join screen until it times out. A separate GM-role
// "Bench" user lets a capture run while a human is still looking at the same world.
// Override with FOUNDRY_USER_NAME; create the user once with:
//   await User.create({ name: "Bench", role: 4 })
if (!process.env.FOUNDRY_USER_NAME && !process.env.FOUNDRY_USER_ID) {
  process.env.FOUNDRY_USER_NAME = 'Bench';
}

const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');

/**
 * A PERSISTENT Chrome profile, not Playwright's usual throwaway one.
 *
 * MSA compresses each 12,000px layer to BC1/BC7 in a worker and caches the result in
 * IndexedDB (validated against a live ETag/Last-Modified HEAD, so a stale entry cannot serve
 * wrong art). Measured on the mansion, cold: the `art` phase alone runs ~50 SECONDS. A fresh
 * profile per run throws that cache away every single time, which would make every capture pay
 * the cold cost and would drown any real change in compression noise. This directory keeps the
 * cache; delete it to force a genuine cold-start measurement.
 */
const PROFILE_DIR = process.env.MSA_LOOK_PROFILE
  || path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');

const LABEL = process.env.MSA_LOOK_LABEL || 'mansion';
/** Extra dwell AFTER the loading screen clears, to let residency and effects settle. */
const SETTLE_SECONDS = Number(process.env.MSA_LOOK_SECONDS || 8);
/** Cold BC compression is minutes-scale on a 12,000px map, so this ceiling is generous. */
const LOAD_TIMEOUT_MS = Number(process.env.MSA_LOOK_LOAD_TIMEOUT_MS || 600000);
const VIEWPORT = {
  width: Number(process.env.PERF_VIEWPORT_W || 1920),
  height: Number(process.env.PERF_VIEWPORT_H || 1080)
};
const REPORTS = (process.env.MSA_LOOK_REPORTS || 'perf-profile,loading-screen-state')
  .split(',').map((s) => s.trim()).filter(Boolean);

test.setTimeout(LOAD_TIMEOUT_MS + 180000);

/**
 * Block until MSA's own loading screen reports it is finished — the real signal that art has
 * decoded, compressed and drawn, replacing a fixed sleep that cannot know any of that.
 *
 * Also fails loudly on the specific trap that ate 705 seconds during bring-up: a browser
 * window that is not compositing never runs `requestAnimationFrame`, so the load parks in the
 * `firstFrame` phase forever. That is an artifact of the viewer, not a bug in the module, and
 * it must never be reported as a hang in MSA.
 */
async function waitForMapArtLoaded(page, timeoutMs) {
  const start = Date.now();
  let lastLog = 0;

  for (;;) {
    const st = await page.evaluate(async () => {
      try {
        const raw = await window.MapShine?.debug?.runReport?.('loading-screen-state');
        const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          showing: r?.showing !== false,
          title: r?.current?.title ?? null,
          elapsedMs: r?.current?.elapsedMs ?? null,
          complete: r?.current?.complete === true,
          error: r?.current?.error ?? null,
          phase: (r?.currentPhases || []).filter((p) => p.endMs === null).map((p) => p.phase)[0] ?? null
        };
      } catch (e) {
        return { showing: true, title: `report-failed: ${String(e)}` };
      }
    });

    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return st;

    const waited = Date.now() - start;
    if (waited > timeoutMs) {
      const hint = st?.phase === 'firstFrame'
        ? ' — stuck in the "firstFrame" phase, which means requestAnimationFrame is not running: '
          + 'the browser window is almost certainly not compositing (minimised, hidden, or headless '
          + 'without a GPU). This is a harness problem, NOT an MSA hang.'
        : '';
      throw new Error(`Map art did not finish loading after ${Math.round(waited / 1000)}s `
        + `(phase=${st?.phase} title="${st?.title}")${hint}`);
    }

    if (waited - lastLog > 10000) {
      lastLog = waited;
      try {
        console.log(`[look] loading... ${Math.round(waited / 1000)}s phase=${st?.phase} "${st?.title}"`);
      } catch (_) {}
    }
    await page.waitForTimeout(1000);
  }
}

test('look at the MSA scene and capture evidence', async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // Own the browser lifecycle rather than using the `page` fixture: a persistent context is
  // the only way to keep the BC cache (see PROFILE_DIR), and `channel: 'chrome'` + headed is
  // the only configuration on this machine that yields a real WebGPU device (see
  // playwright.config.cjs for the full probe results).
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: VIEWPORT,
    args: ['--no-first-run', '--no-default-browser-check']
  });
  const page = context.pages()[0] || await context.newPage();

  // Console errors are collected from the very first navigation — a shader or boot failure
  // announces itself here long before it is visible in a screenshot.
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 500));
  });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${String(e).slice(0, 500)}`));

  const launcher = new FoundryLauncher({ headless: true });
  await launcher.start();

  try {
    await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
    await bestEffortLogin(page);
    await waitForGameReady(page);
    await ensureActiveScene(page);
    await waitForCanvasReady(page);
    await waitForMapShineReady(page);
    await unpauseIfPaused(page);

    // Confirm the GPU is REAL before believing any pixel or any millisecond. A software or
    // absent adapter still renders *something*, so this is recorded next to the numbers
    // rather than assumed.
    const gpu = await page.evaluate(async () => {
      if (typeof navigator.gpu === 'undefined') return { hasGpu: false };
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!a) return { hasGpu: true, adapter: false };
      return {
        hasGpu: true,
        adapter: true,
        vendor: a.info?.vendor ?? null,
        architecture: a.info?.architecture ?? null,
        maxTextureDimension2D: a.limits?.maxTextureDimension2D ?? null,
        maxBufferSize: a.limits?.maxBufferSize ?? null
      };
    });
    expect(gpu.adapter, 'a real WebGPU adapter is required or nothing below means anything').toBe(true);

    // Wait for the ART, not for a stopwatch. Screenshotting or timing before this returns
    // captures MSA's loading screen and reports its frame rate as if it were the map's —
    // which is exactly what a fixed 12s sleep did during bring-up, yielding a triumphant and
    // completely meaningless "122 fps".
    const loadState = await waitForMapArtLoaded(page, LOAD_TIMEOUT_MS);
    console.log(`[look] map art loaded after ${Math.round((loadState.elapsedMs || 0) / 1000)}s`);

    // Then a short dwell so residency streaming and effect warm-up settle before measuring.
    await page.waitForTimeout(SETTLE_SECONDS * 1000);

    // Measure frame rate from the page itself rather than trusting a profiler that may be
    // disarmed: 60 raw rAF ticks, wall-clock timed.
    const fps = await page.evaluate(() => new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      const tick = () => {
        frames += 1;
        if (frames >= 60) resolve(Math.round((frames * 1000) / (performance.now() - t0)));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));

    const sceneState = await page.evaluate(() => ({
      msaVersion: window.MapShine?.version ?? null,
      scene: window.canvas?.scene?.name ?? null,
      sceneSize: window.canvas?.scene ? `${canvas.scene.width}x${canvas.scene.height}` : null,
      levels: (window.canvas?.scene?.levels ?? []).map((l) => ({
        name: l.name,
        bottom: l.elevation?.bottom ?? null,
        background: (l.background?.src || '').split('/').pop() || null
      })),
      canvas: (() => {
        const c = document.querySelector('canvas#msa-vt-pan-viewer-canvas');
        return c ? { width: c.width, height: c.height } : null;
      })(),
      devicePixelRatio: window.devicePixelRatio
    }));

    // MSA's own reports — the same instruments that produced the numbers in
    // docs/planning/Moonshot.md, captured here without a human pressing the button.
    const reports = {};
    for (const id of REPORTS) {
      reports[id] = await page.evaluate(async (reportId) => {
        try {
          const r = await window.MapShine?.debug?.runReport?.(reportId);
          return typeof r === 'string' ? r.slice(0, 20000) : r;
        } catch (e) {
          return { error: String(e) };
        }
      }, id);
    }

    await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-viewport.png`) });
    const msaCanvas = page.locator('canvas#msa-vt-pan-viewer-canvas');
    if (await msaCanvas.count()) {
      await msaCanvas.screenshot({ path: path.join(OUT_DIR, `${LABEL}-msa-canvas.png`) }).catch(() => {});
    }

    const summary = {
      label: LABEL,
      capturedAt: new Date().toISOString(),
      baseUrl: launcher.getBaseUrl(),
      attachedToExistingServer: launcher.attached === true,
      settleSeconds: SETTLE_SECONDS,
      mapArtLoadMs: loadState.elapsedMs ?? null,
      profileDir: PROFILE_DIR,
      fps,
      gpu,
      scene: sceneState,
      consoleErrors: consoleErrors.slice(0, 40),
      reports
    };
    fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.json`), JSON.stringify(summary, null, 2));

    console.log(`[look] fps=${fps} gpu=${gpu.vendor}/${gpu.architecture} scene="${sceneState.scene}" `
      + `floors=${sceneState.levels.length} errors=${consoleErrors.length}`);
    console.log(`[look] artifacts written to ${OUT_DIR}`);
  } finally {
    await context.close().catch(() => {});
    await launcher.stop();
  }
});
