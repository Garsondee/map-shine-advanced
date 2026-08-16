/** Albedo Clarity (CAS sharpen) visual look test — captures the SAME real view at
 * several sharpening states in one loaded session, for a direct on/off/tuned
 * comparison (avoids paying the cold BC-compress cost more than once). Companion
 * to `run-perf-cas-tier-test.mjs` (same pattern, driving MapShine's real console
 * API from Playwright) but for LOOK, not perf.
 *
 * Usage: node tests/playwright-artifacts/look/run-albedo-clarity-look-test.mjs
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

/** Same polling shape as msa-look.spec.js's own waitForMapArtLoaded — the real
 * "art has decoded, compressed and drawn" signal, not a fixed sleep. */
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
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`));

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();

try {
  await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
  await bestEffortLogin(page);
  await waitForGameReady(page);
  await waitForCanvasReady(page);
  await waitForMapShineReady(page);
  await unpauseIfPaused(page);

  console.log('[clarity-look] waiting for map art to finish loading...');
  await waitForMapArtLoaded(page, LOAD_TIMEOUT_MS);
  console.log('[clarity-look] map art loaded — settling 15s before the first capture');
  await page.waitForTimeout(15000); // real dwell, not a placeholder — floor-switch-settle-time trap

  fs.mkdirSync(OUT_DIR, { recursive: true });

  /** One capture: apply a clarity state, dwell, screenshot the MSA canvas + full viewport. */
  async function capture(label, clarityArgs) {
    const applied = await page.evaluate((args) => window.MapShine.setAlbedoClarity(args), clarityArgs);
    console.log(`[clarity-look] applied ${label}:`, JSON.stringify(applied));
    await page.waitForTimeout(3000); // uniform write is instant on screen; this is just render settle
    await page.screenshot({ path: path.join(OUT_DIR, `clarity-${label}-viewport.png`) });
    const canvas = page.locator('canvas#msa-vt-pan-viewer-canvas');
    if (await canvas.count()) {
      await canvas.screenshot({ path: path.join(OUT_DIR, `clarity-${label}-canvas.png`) }).catch(() => {});
    }
    return applied;
  }

  const results = {};
  results.shipped = await capture('shipped-default', { sharpness: 0.22, gateLo: 1.0, gateHi: 1.8, farLo: 6.0, farHi: 16.0, farFloor: 0.35, enabled: true });
  results.off = await capture('off', { enabled: false });
  results.high = await capture('high-0.4', { enabled: true, sharpness: 0.4 });
  // Restore shipped default so the session isn't left in a non-default state.
  await capture('restored', { sharpness: 0.22, gateLo: 1.0, gateHi: 1.8, farLo: 6.0, farHi: 16.0, farFloor: 0.35, enabled: true });

  // ZOOM OUT to the "certain zoom levels" band the ringing complaint points
  // at (gateHi=1.8 to farLo=6.0, always-full-strength). scale~=0.2 puts a
  // native-res texel at ~5 screen texels/pixel — comfortably inside that
  // band, just short of the far roll-off. Real Foundry pan API, not a PIXI
  // internals poke (keyhole-input-model-decision: Foundry owns the camera).
  const zoomInfo = await page.evaluate(async () => {
    const before = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
    await canvas.animatePan({ scale: 0.2, duration: 0 });
    return { before, after: { scale: canvas.stage.scale.x } };
  });
  console.log('[clarity-look] zoomed out:', JSON.stringify(zoomInfo));
  await page.waitForTimeout(8000); // residency/mip settle after a real zoom change, not a placeholder

  results.zoomedOutShipped = await capture('zoomed-out-shipped', { sharpness: 0.22, gateLo: 1.0, gateHi: 1.8, farLo: 6.0, farHi: 16.0, farFloor: 0.35, enabled: true });
  results.zoomedOutOff = await capture('zoomed-out-off', { enabled: false });
  results.zoomedOutHigh = await capture('zoomed-out-high-0.4', { enabled: true, sharpness: 0.4 });
  await capture('zoomed-out-restored', { sharpness: 0.22, gateLo: 1.0, gateHi: 1.8, farLo: 6.0, farHi: 16.0, farFloor: 0.35, enabled: true });

  const sceneState = await page.evaluate(() => ({
    scene: window.canvas?.scene?.name ?? null,
    sceneSize: window.canvas?.scene ? `${canvas.scene.width}x${canvas.scene.height}` : null,
    devicePixelRatio: window.devicePixelRatio,
  }));

  fs.writeFileSync(
    path.join(OUT_DIR, 'clarity-look-summary.json'),
    JSON.stringify({ capturedAt: new Date().toISOString(), scene: sceneState, results, consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 40) }, null, 2)
  );
  console.log('[clarity-look] artifacts written to', OUT_DIR);
} finally {
  await context.close().catch(() => {});
  await launcher.stop();
}
