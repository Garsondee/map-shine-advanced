/** Switch to Ground Floor (Foundry's native level control) and capture the MSA canvas. */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from './foundry-launcher.js';
import { bestEffortLogin, waitForGameReady, waitForCanvasReady, waitForMapShineReady } from './map-shine-utils.js';

const PROFILE_DIR = process.env.MSA_LOOK_PROFILE
  || path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
if (!process.env.FOUNDRY_USER_NAME && !process.env.FOUNDRY_USER_ID) process.env.FOUNDRY_USER_NAME = 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');

/** Mirrors msa-look.spec.js's waitForMapArtLoaded — a floor switch re-triggers the same streaming loading screen. */
async function waitForMapArtLoaded(page, timeoutMs = 120000) {
  const start = Date.now();
  let lastLog = 0;
  for (;;) {
    const st = await page.evaluate(async () => {
      try {
        const raw = await window.MapShine?.debug?.runReport?.('loading-screen-state');
        const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          showing: r?.showing !== false,
          complete: r?.current?.complete === true,
          error: r?.current?.error ?? null,
          title: r?.current?.title ?? null
        };
      } catch (e) { return { showing: true, title: `report-failed: ${String(e)}` }; }
    });
    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return st;
    const waited = Date.now() - start;
    if (waited > timeoutMs) throw new Error(`map art did not finish loading after ${timeoutMs}ms (title="${st?.title}")`);
    if (waited - lastLog > 10000) {
      lastLog = waited;
      console.log(`[floor] still loading... ${Math.round(waited / 1000)}s showing=${st?.showing} title="${st?.title}"`);
    }
    await page.waitForTimeout(1000);
  }
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome', headless: false, viewport: { width: 3840, height: 2160 },
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

    const before = await page.evaluate(() => canvas.scene?.levels?.viewed?.name ?? null);
    console.log('[floor] currently viewed level before click:', before);

    // The scene's own initialLevel is defaultLevel0000 (Ground Floor), so the default view
    // (and the earlier msa-look.spec.js capture) is already Ground Floor — First Floor is
    // the one still missing a real screenshot.
    const TARGET_FLOOR_TEXT = 'First Floor';
    const clicked = await page.evaluate((targetText) => {
      const els = Array.from(document.querySelectorAll('*')).filter(
        (el) => el.children.length === 0 && el.textContent?.trim() === targetText
      );
      if (!els.length) return { ok: false, reason: `no element with exact text "${targetText}" found` };
      els[0].click();
      return { ok: true };
    }, TARGET_FLOOR_TEXT);
    console.log('[floor] click attempt:', JSON.stringify(clicked));
    if (!clicked.ok) throw new Error(clicked.reason);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const loadState = await waitForMapArtLoaded(page, 600000);
    console.log('[floor] loading-screen cleared:', JSON.stringify(loadState));
    // loading-screen-state clearing is NOT the end of settling — DOF focal-plane calibration
    // and other pop-in continue after it (feedback_floor_switch_needs_settle_time.md, caught
    // live 2026-08-10 by screenshotting a floor switch after only 3s and misreading soft DOF
    // as a broken texture swap). Dwell generously.
    // Take a SEQUENCE of snapshots at increasing cumulative dwell times, in ONE session,
    // instead of guessing a single number and re-paying the ~15s cold-boot cost per guess.
    const marks = [10, 30, 60, 120]; // cumulative seconds since the floor-switch click
    let elapsed = 0;
    for (const mark of marks) {
      await page.waitForTimeout((mark - elapsed) * 1000);
      elapsed = mark;
      const canvasEl = await page.$('canvas#msa-vt-pan-viewer-canvas');
      if (canvasEl) await canvasEl.screenshot({ path: path.join(OUT_DIR, `mansion-redux-4k-first-floor-t${mark}s.png`) });
      console.log(`[floor] snapshot at +${mark}s written`);
    }
    const after = await page.evaluate(() => canvas.scene?.levels?.viewed?.name ?? null);
    console.log('[floor] currently viewed level after click:', after);

    // Check the ACTUAL renderer/device state directly rather than inferring it from a
    // canvas-only screenshot — MSA's documented safety slide intentionally stops drawing to
    // its own canvas and falls back to Foundry's on device loss (boot.js "device lost —
    // restored Foundry's own art"), which would legitimately look black in a
    // canvas#msa-vt-pan-viewer-canvas-only capture while the browser's full viewport still
    // shows real (Foundry-rendered) content on a different layer.
    const liveState = await page.evaluate(async () => {
      let gpuAlive = null;
      try {
        const a = await navigator.gpu?.requestAdapter?.();
        gpuAlive = !!a;
      } catch (e) { gpuAlive = `error: ${e}`; }
      return {
        keyholeBooted: window.MapShine?.__keyholeBooted ?? null,
        stage: window.MapShine?.__stage ?? null,
        gpuAdapterStillAvailable: gpuAlive,
        msaCanvasExists: !!document.querySelector('canvas#msa-vt-pan-viewer-canvas'),
        msaCanvasVisible: (() => {
          const el = document.querySelector('canvas#msa-vt-pan-viewer-canvas');
          if (!el) return null;
          const s = getComputedStyle(el);
          return { display: s.display, visibility: s.visibility, opacity: s.opacity, width: el.width, height: el.height };
        })()
      };
    });
    console.log('[floor] live renderer state:', JSON.stringify(liveState, null, 2));

    const deviceLostLines = consoleLines.filter((l) => /device.?lost/i.test(l));
    console.log('[floor] device-lost console lines:', JSON.stringify(deviceLostLines, null, 2));
    console.log('[floor] last 15 console lines total:', JSON.stringify(consoleLines.slice(-15), null, 2));

    await page.screenshot({ path: path.join(OUT_DIR, 'mansion-redux-4k-first-floor-viewport-final.png') });
    console.log('[floor] final full-viewport screenshot written');
  } finally {
    await context.close();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
