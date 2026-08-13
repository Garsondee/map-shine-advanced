/** CLEAN (no debug-overlay) close-ups — follow-up to fire-candle-first-floor-
 * verify.mjs. That run's anchor-marker overlay dominated the close-up shots,
 * making it impossible to tell whether a REAL flame sprite was rendering
 * underneath the debug pin. This pans to known world coordinates with NO
 * overlay active:
 *   - a Ground-floor painted fire (world 7816,5848 — console-confirmed
 *     "mask:205_121", one of 5 real extractions on floor 0)
 *   - several First-Floor candle anchors (world coords read back from the
 *     previous run's anchorMarkers dump)
 *   - the one real (but faint) painted region on First-Floor's own _Fire
 *     mask, world ~(8500,4800) — confirmed via direct pixel analysis of
 *     mythica-machina-mansion-First-Floor_Fire.webp (peak 234/255, ~235 raw
 *     pixels >200, vs Ground's 9625) — extraction yields 0 fires for floor 1,
 *     so this shot is expected to show nothing, which is itself the point.
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

const LABEL = 'clean';
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

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();

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
    if (Date.now() - start > timeoutMs) throw new Error('map art timeout');
    await page.waitForTimeout(1000);
  }
}

async function panAndShoot(name, x, y, scale) {
  await page.evaluate((p) => window.canvas.animatePan({ x: p.x, y: p.y, scale: p.scale, duration: 400 }), { x, y, scale });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-${name}.png`) }).catch(() => {});
}

try {
  await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
  await bestEffortLogin(page);
  await waitForGameReady(page);
  await waitForCanvasReady(page);
  await waitForMapShineReady(page);
  await unpauseIfPaused(page);
  console.log(`[${LABEL}] waiting for map art...`);
  await waitForMapArtLoaded(600000);
  await waitForSceneSettled(page, { label: 'ground initial', timeoutMs: 300000 });
  await page.waitForTimeout(6000);

  console.log(`[${LABEL}] GROUND floor — panning to a known real painted fire (7816,5848)...`);
  await panAndShoot('ground-fire-mask205_121', 7816, 5848, 2.5);
  await panAndShoot('ground-fire-mask205_121-wide', 7816, 5848, 1.0);

  // ---- switch to First Floor (native API, same as the prior verified run) --
  const levels = await page.evaluate(() =>
    (window.canvas?.scene?.levels ?? []).map?.((l) => ({ id: l.id, name: l.name })) ?? []
  );
  const firstFloor = levels.find((l) => /first/i.test(l.name || ''));
  if (!firstFloor) throw new Error(`no First Floor level found among ${JSON.stringify(levels)}`);
  console.log(`[${LABEL}] switching to ${JSON.stringify(firstFloor)}...`);
  await page.evaluate((id) => window.canvas.scene.view({ level: id }), firstFloor.id);
  await waitForSceneSettled(page, { label: 'first floor', timeoutMs: 300000 });
  await page.waitForTimeout(15000);

  const viewedNow = await page.evaluate(() => ({ id: window.canvas?.level?.id, name: window.canvas?.level?.name }));
  console.log(`[${LABEL}] now viewing:`, JSON.stringify(viewedNow));

  // Known First-Floor candle anchor world coords (from the previous run's
  // anchorMarkers dump, fc-floor-result.json's "first-floor" section) —
  // spread across different rooms for coverage.
  const candleSpots = [
    { name: 'candleA', x: 7525.8, y: 10685.7 },
    { name: 'candleB', x: 9338.1, y: 10831.6 },
    { name: 'candleC', x: 8635.8, y: 10913.4 },
    { name: 'candleD', x: 11026.7, y: 11078.9 },
  ];
  for (const spot of candleSpots) {
    console.log(`[${LABEL}] FIRST FLOOR — panning to ${spot.name} (${spot.x},${spot.y}), CLEAN (no overlay)...`);
    await panAndShoot(`firstfloor-${spot.name}`, spot.x, spot.y, 2.5);
  }

  // The one real-but-faint painted spot on First-Floor's own _Fire mask
  // (confirmed via direct pixel read of the .webp: peak 234/255, tiny vs
  // Ground's blobs) — extraction found 0 fires; this shot documents what
  // (if anything) is visible there.
  console.log(`[${LABEL}] FIRST FLOOR — panning to the one real _Fire paint spot (~8500,4800)...`);
  await panAndShoot('firstfloor-fire-paintspot', 8500, 4800, 2.0);
  await panAndShoot('firstfloor-fire-paintspot-wide', 8500, 4800, 0.8);

  // A wide, un-panned overview for good measure.
  await page.evaluate(() => window.canvas.animatePan({ scale: 0.5, duration: 300 }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-firstfloor-wide-overview.png`) }).catch(() => {});

  console.log(`[${LABEL}] DONE.`);
} catch (e) {
  console.error(`[${LABEL}] failed:`, e);
} finally {
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-console.json`), JSON.stringify(consoleLines, null, 2));
  await context.close().catch(() => {});
  await launcher.stop();
}
