/** LEVEL TEXTURE PLACEMENT, BOTH FLOORS — narrow, single-purpose check
 * (2026-08-13).
 *
 * Question: the author proved byte-identical `_Fire` mask content works on
 * Ground and fails on First Floor. Since compositePackedTexels/the alpha gate
 * is a pure function of the BYTES (never the floor index), an identical-bytes/
 * different-floor result rules alpha out entirely — the divergence has to be
 * something genuinely tied to FLOOR IDENTITY. `computeLevelTexturePlacement`
 * (foundry/scene-geometry.js) fits each Level's OWN native pixel size into the
 * ONE shared scene-wide sceneRect, using that Level's OWN `textures` config
 * (anchorX/anchorY/offsetX/offsetY/fit/scaleX/scaleY/rotation) — a per-Level
 * override that could legitimately differ between Ground and First Floor even
 * though both source images are confirmed (offline, via parseImageDimensions)
 * to be the identical 12000x12000 native resolution. This script dumps BOTH
 * Levels' raw `textures` config directly from the live scene document to
 * confirm or rule this out.
 *
 * Deliberately minimal: one fresh load, one console.evaluate, no floor
 * switching, no screenshots.
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

const LABEL = 'fire-level-placement';
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

const consoleLines = [];
page.on('console', (m) => consoleLines.push({ type: m.type(), text: m.text().slice(0, 500), at: Date.now() }));
page.on('pageerror', (e) => consoleLines.push({ type: 'pageerror', text: String(e).slice(0, 500), at: Date.now() }));

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
        return {
          showing: r?.showing !== false,
          complete: r?.current?.complete === true,
          error: r?.current?.error ?? null,
        };
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

  console.log(`[${LABEL}] waiting for map art to finish loading...`);
  await waitForMapArtLoaded(600000);
  console.log(`[${LABEL}] map art loaded`);
  await waitForSceneSettled(page, { label: 'fresh load', timeoutMs: 300000 });
  await page.waitForTimeout(3000);

  // Dump every Level document's raw shape — textures config, background art
  // reference, elevation — plus the scene's own dimensions/sceneRect and grid
  // size, straight from the live document, no MSA involvement at all.
  const dump = await page.evaluate(() => {
    const scene = window.canvas?.scene;
    const levels = scene?.levels ?? scene?.getEmbeddedCollection?.('Level') ?? null;
    const levelRows = [];
    if (levels?.forEach) {
      levels.forEach((lvl) => {
        const d = lvl.toObject ? lvl.toObject() : lvl;
        levelRows.push({
          id: d.id ?? d._id,
          name: d.name,
          elevation: d.elevation,
          background: d.background ?? null,
          foreground: d.foreground ?? null,
          textures: d.textures ?? d.background?.textures ?? null,
          raw: d,
        });
      });
    }
    return {
      sceneId: scene?.id ?? null,
      sceneWidth: scene?.width ?? null,
      sceneHeight: scene?.height ?? null,
      scenePadding: scene?.padding ?? null,
      grid: scene?.grid ?? null,
      levelCount: levelRows.length,
      levels: levelRows,
    };
  });
  state.dump = dump;
  save();

  console.log(`[${LABEL}] ===== LEVELS =====`);
  console.log(JSON.stringify(dump, null, 2));

  state.ok = true;
} catch (e) {
  console.error(`[${LABEL}] run stopped early:`, e);
  state.error = String(e?.stack || e?.message || e);
} finally {
  state.consoleErrorCount = consoleLines.filter((l) => l.type === 'error' || l.type === 'pageerror').length;
  state.consoleErrors = consoleLines.filter((l) => l.type === 'error' || l.type === 'pageerror').slice(0, 40);
  save();
  await context.close().catch(() => {});
  await launcher.stop();
  console.log(`[${LABEL}] wrote ${resultPath}`);
}
