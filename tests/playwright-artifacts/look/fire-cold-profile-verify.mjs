/** FIRST-FLOOR `_Fire` MASK — GENUINELY COLD PROFILE verification (2026-08-13).
 *
 * WHY THIS SCRIPT EXISTS. Every previous check of the First-Floor `_Fire`
 * byte-swap (`fire-first-floor-swap-verify.mjs`, `mask-authority-fresh-fire-check.mjs`)
 * reused the SAME persistent Chrome profile directory
 * (`tests/playwright-artifacts/chrome-profile`) that this harness deliberately
 * keeps warm across runs to skip the ~50s cold BC-compression cost
 * (see `reference_live_foundry_harness.md`, trap 6). That profile's IndexedDB
 * holds MSA's PACKED-PAGE decode cache: `_Fire` is not decoded standalone —
 * it is decoded together with `_Shadow` and `_Outdoors` into one combined
 * RGBA texture (`acquirePackedPages` in `src/vt/decode-pool.js`), keyed by a
 * PURELY STRUCTURAL `packId` (`packed://${ownerId}/ShadowOutdoorsFire` —
 * item id + fixed layer name, no content hash, no mtime). So a "fresh reload"
 * that keeps the profile can still serve a packed page decoded long before
 * today's file swap and never recomposited since — the reload looks fresh,
 * the cache is not.
 *
 * THIS RUN IS DIFFERENT: `tests/playwright-artifacts/chrome-profile` was
 * deleted immediately before this script ran (227MB removed), so IndexedDB
 * starts genuinely empty and `acquirePackedPages` cannot hit `getPageBlob()`
 * for anything — every packed page, for every floor, must be decoded fresh
 * from the CURRENT on-disk `_Fire.webp` bytes.
 *
 * Deliberately minimal per the task: no network sniffing, no screenshots —
 * those questions were already answered (server confirmed serving the
 * correct swapped bytes in `fire-swap-result.json`). This script's only job
 * is the "painted region on floor N yielded M fire(s)" console lines, for
 * both floors, from a genuinely cold profile.
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

const LABEL = 'fire-cold-profile';
const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const resultPath = path.join(OUT_DIR, `${LABEL}-result.json`);
const FLOOR_CHANGE_SETTLE_BUFFER_MS = 15000; // mirrors fire-first-floor-swap-verify.mjs

fs.mkdirSync(OUT_DIR, { recursive: true });

// Confirm the profile really is gone (empty/absent) before we trust anything below.
const profileExistedBefore = fs.existsSync(PROFILE_DIR);
console.log(`[${LABEL}] PROFILE_DIR=${PROFILE_DIR} existed-before-launch=${profileExistedBefore}`);

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

const state = { label: LABEL, startedAt: new Date().toISOString(), profileExistedBefore };
function save() {
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        ...state,
        fireConsoleLines: consoleLines.filter((l) => /fire/i.test(l.text)).slice(0, 300),
        consoleErrors: consoleLines.filter((l) => l.type === 'error' || l.type === 'pageerror').slice(0, 60),
        totalConsoleLines: consoleLines.length,
      },
      null,
      2
    )
  );
}

async function waitForMapArtLoaded(timeoutMs) {
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
          elapsedMs: r?.current?.elapsedMs ?? null,
          phase: (r?.currentPhases || []).filter((p) => p.endMs === null).map((p) => p.phase)[0] ?? null,
        };
      } catch (e) {
        return { showing: true, error: null };
      }
    });
    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return st;
    const waited = Date.now() - start;
    if (waited > timeoutMs)
      throw new Error(`Map art did not finish loading after ${Math.round(waited / 1000)}s (phase=${st?.phase})`);
    if (waited - lastLog > 10000) {
      lastLog = waited;
      console.log(`[${LABEL}] loading... ${Math.round(waited / 1000)}s phase=${st?.phase}`);
    }
    await page.waitForTimeout(1000);
  }
}

async function getSceneState() {
  return page.evaluate(() => ({
    msaVersion: window.MapShine?.version ?? null,
    sceneName: window.canvas?.scene?.name ?? null,
    viewedLevelId: window.canvas?.level?.id ?? null,
    viewedLevelName: window.canvas?.level?.name ?? null,
    levels:
      (window.canvas?.scene?.levels ?? []).map?.((l) => ({
        id: l.id,
        name: l.name,
        bottom: l.elevation?.bottom ?? null,
        top: l.elevation?.top ?? null,
      })) ?? null,
  }));
}

function extractYieldLine(text) {
  const m = /painted region on floor (\d+) yielded (\d+) fire\(s\)/.exec(text);
  if (!m) return null;
  return { floorIndex: Number(m[1]), count: Number(m[2]) };
}

try {
  console.log(`[${LABEL}] goto ${launcher.getBaseUrl()} (attached=${launcher.attached === true})`);
  await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
  await bestEffortLogin(page);
  await waitForGameReady(page);
  await waitForCanvasReady(page);
  await waitForMapShineReady(page);
  await unpauseIfPaused(page);

  console.log(`[${LABEL}] waiting for map art to finish loading (GENUINELY cold profile — expect real BC compression, do not rush)...`);
  const loadState = await waitForMapArtLoaded(600000);
  state.mapArtLoadMs = loadState.elapsedMs ?? null;
  console.log(`[${LABEL}] map art loaded after ${Math.round((loadState.elapsedMs || 0) / 1000)}s`);

  await waitForSceneSettled(page, { label: 'cold initial load', timeoutMs: 300000 });
  await page.waitForTimeout(10000); // residency / effect warm-up dwell, same as prior scripts

  state.sceneStateInitial = await getSceneState();
  console.log(`[${LABEL}] initial viewedLevel=${state.sceneStateInitial.viewedLevelName}`);
  save();

  const floor0Lines = consoleLines.filter((l) => extractYieldLine(l.text)?.floorIndex === 0);
  const floor1LinesPreSwitch = consoleLines.filter((l) => extractYieldLine(l.text)?.floorIndex === 1);
  console.log(`[${LABEL}] floor-0 yield lines (pre-switch): ${floor0Lines.length}`, floor0Lines.map((l) => l.text));
  console.log(`[${LABEL}] floor-1 yield lines (pre-switch, if boot computes all floors eagerly): ${floor1LinesPreSwitch.length}`, floor1LinesPreSwitch.map((l) => l.text));

  // ---- THE FLOOR SWITCH — Foundry's own native, public API -----------------
  const levels = state.sceneStateInitial.levels ?? [];
  console.log(`[${LABEL}] levels on this scene:`, JSON.stringify(levels));
  const firstFloor =
    levels.find((l) => /first/i.test(l.name || '')) ?? levels.find((l) => l.id !== state.sceneStateInitial.viewedLevelId);
  if (!firstFloor) throw new Error(`Could not identify a "First Floor" level among: ${JSON.stringify(levels)}`);
  state.firstFloorLevel = firstFloor;
  console.log(`[${LABEL}] switching to level id=${firstFloor.id} name="${firstFloor.name}" via canvas.scene.view()...`);

  const switchResult = await page.evaluate(async (levelId) => {
    await window.canvas.scene.view({ level: levelId });
    return { viewedLevelId: window.canvas?.level?.id ?? null, viewedLevelName: window.canvas?.level?.name ?? null };
  }, firstFloor.id);
  console.log(`[${LABEL}] switch call returned:`, JSON.stringify(switchResult));
  state.switchResult = switchResult;
  save();

  await waitForSceneSettled(page, { label: 'first-floor switch', timeoutMs: 300000 });
  console.log(`[${LABEL}] settled — waiting an additional ${FLOOR_CHANGE_SETTLE_BUFFER_MS}ms floor-change buffer...`);
  await page.waitForTimeout(FLOOR_CHANGE_SETTLE_BUFFER_MS);

  state.sceneStateFirstFloor = await getSceneState();
  console.log(`[${LABEL}] now viewing: ${state.sceneStateFirstFloor.viewedLevelName}`);
  save();

  // ---- THE CRUX: re-scan ALL console lines seen so far for both floors ------
  const allFloor0Lines = consoleLines.filter((l) => extractYieldLine(l.text)?.floorIndex === 0);
  const allFloor1Lines = consoleLines.filter((l) => extractYieldLine(l.text)?.floorIndex === 1);
  console.log(`[${LABEL}] FINAL floor-0 yield lines:`, JSON.stringify(allFloor0Lines.map((l) => l.text)));
  console.log(`[${LABEL}] FINAL floor-1 yield lines:`, JSON.stringify(allFloor1Lines.map((l) => l.text)));

  const lastFloor0Line = allFloor0Lines[allFloor0Lines.length - 1] ?? null;
  const lastFloor1Line = allFloor1Lines[allFloor1Lines.length - 1] ?? null;
  const floor0Info = lastFloor0Line ? extractYieldLine(lastFloor0Line.text) : null;
  const floor1Info = lastFloor1Line ? extractYieldLine(lastFloor1Line.text) : null;

  state.floor0FireCount = floor0Info?.count ?? null;
  state.floor0RawLine = lastFloor0Line?.text ?? null;
  state.floor1FireCount = floor1Info?.count ?? null;
  state.floor1RawLine = lastFloor1Line?.text ?? null;

  console.log(`[${LABEL}] ===== VERDICT =====`);
  console.log(`[${LABEL}] *** FLOOR 0 (Ground) FIRE COUNT: ${state.floor0FireCount === null ? 'NO LINE SEEN' : state.floor0FireCount} ***`);
  console.log(`[${LABEL}] *** FLOOR 1 (First Floor) FIRE COUNT: ${state.floor1FireCount === null ? 'NO LINE SEEN' : state.floor1FireCount} ***`);
  save();

  state.ok = true;
  console.log(`[${LABEL}] DONE.`);
} catch (e) {
  console.error(`[${LABEL}] run stopped early:`, e);
  state.error = String(e?.stack || e?.message || e);
} finally {
  await page.waitForTimeout(500).catch(() => {});
  save();
  await context.close().catch(() => {});
  await launcher.stop();
  console.log(`[${LABEL}] wrote ${resultPath}`);
}
