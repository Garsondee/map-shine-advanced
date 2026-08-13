/** FIRE + CANDLE, GROUND vs FIRST FLOOR — live verification.
 *
 * Two open questions from the author (2026-08-13):
 *   1. Candle flame SPRITES were just migrated off the old per-floor-relative
 *      occlusion gate (buf:scene.attr) onto the depth-authority gate
 *      (buf:scene.depth) that lightning/point-lights/specular already use
 *      cross-floor. Node-verified only so far — does it actually work LIVE,
 *      especially on the First Floor where it was reported broken?
 *   2. Fire flames/embers/smoke were reported as NOT APPEARING AT ALL on the
 *      First Floor, even though `_Fire` art is painted on both floors
 *      (mythica-machina-mansion-Ground_Fire.webp AND -First-Floor_Fire.webp
 *      both exist on disk). The live fire particle engine
 *      (fire-particle-runtime.js) has NO occlusion/depth gate at all, so it
 *      cannot be wrongly hiding fire — if fire is absent, the leading
 *      hypothesis is that fire descriptors never reach the render pipeline
 *      for floorIndex 1 (a floor-scoping bug), not a gate bug.
 *
 * THE FLOOR SWITCH: uses Foundry's own native, public API —
 * `canvas.scene.view({level: <levelId>})` (client/documents/scene.mjs) — the
 * exact call `SceneNavigation`'s own "View Level" list item makes
 * (applications/ui/scene-navigation.mjs:367). This lands on boot.js's
 * `canvasReady` same-scene branch, which is the ONLY path that correctly
 * calls `updateActiveFloorContext` + `refreshDoors` + `setVtPanViewerFloor`
 * together — i.e. the real production floor-switch path, not a debug
 * shortcut that might paper over the very bug under test.
 *
 * SETTLE TIME: `waitForSceneSettled`'s event-driven wait can report "settled"
 * while a first-frame shader/pipeline compile for newly-visible content is
 * still queued (author's own finding, 2026-08-12, `perf-run-full`'s
 * FLOOR_CHANGE_SETTLE_BUFFER_MS) — so a fixed 15s buffer is chained on top,
 * never in place of it.
 *
 * DIAGNOSTICS CAPTURED PER FLOOR:
 *   - a clean viewport screenshot + a cropped msa-canvas screenshot
 *   - an "anchor view" screenshot (MSA's own `map-shine-anchor-view` scene-
 *     control toggle — every candle/lightning anchor shown as a pin,
 *     regardless of whether its sprite is rendering) so a pin with no flame
 *     next to it is directly visible
 *   - the `mask-authority` report (scene/mask-authority-report.js): its
 *     per-floor `authored.fire` field says whether the `_Fire` mask was
 *     actually DISCOVERED for that floor (a tail of the matched URL) or is
 *     sitting at `default(0)` (not found) — this is the direct answer to
 *     "did discovery succeed for First-Floor's mask specifically"
 *   - every console line mentioning "fire" or "candle" (case-insensitive),
 *     WITH their structured args — `getMaskDrivenFires`/`getFireSpawnCloud`
 *     both log `fire: painted region on floor N yielded M fire(s)` with
 *     positions on every real extraction, so this either shows the
 *     extraction running for floor 1 or shows it never happened
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

const LABEL = 'fc-floor';
const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const resultPath = path.join(OUT_DIR, `${LABEL}-result.json`);
const FLOOR_CHANGE_SETTLE_BUFFER_MS = 15000; // mirrors perf-run-full's own margin, boot.js

fs.mkdirSync(OUT_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());

// ALL console levels, not just errors — the fire extraction trace prints via
// log.info (-> console.log), and that trace is the whole point of this run.
const consoleLines = [];
page.on('console', (m) => {
  const entry = { type: m.type(), text: m.text().slice(0, 500), at: Date.now() };
  consoleLines.push(entry);
  // Best-effort structured args (fire's own log line passes a positions array
  // as a SEPARATE console arg, not string-interpolated) — never let a
  // JSHandle serialization failure take down the run.
  Promise.all(m.args().map((a) => a.jsonValue().catch(() => '<unserializable>')))
    .then((args) => {
      entry.args = args;
    })
    .catch(() => {});
});
page.on('pageerror', (e) => consoleLines.push({ type: 'pageerror', text: String(e).slice(0, 500), at: Date.now() }));

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();

const state = { label: LABEL, startedAt: new Date().toISOString(), floors: {} };
function save() {
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        ...state,
        fireCandleConsoleLines: consoleLines.filter((l) => /fire|candle/i.test(l.text)).slice(0, 200),
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
  for (;;) {
    const st = await page.evaluate(async () => {
      try {
        const raw = await window.MapShine?.debug?.runReport?.('loading-screen-state');
        const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          showing: r?.showing !== false,
          complete: r?.current?.complete === true,
          error: r?.current?.error ?? null,
          phase: (r?.currentPhases || []).filter((p) => p.endMs === null).map((p) => p.phase)[0] ?? null,
        };
      } catch (e) {
        return { showing: true, error: null };
      }
    });
    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return st;
    if (Date.now() - start > timeoutMs)
      throw new Error(`Map art did not finish loading after ${Math.round((Date.now() - start) / 1000)}s (phase=${st?.phase})`);
    await page.waitForTimeout(1000);
  }
}

async function getSceneState() {
  return page.evaluate(() => ({
    msaVersion: window.MapShine?.version ?? null,
    sceneName: window.canvas?.scene?.name ?? null,
    viewedLevelId: window.canvas?.level?.id ?? null,
    viewedLevelName: window.canvas?.level?.name ?? null,
    levels: (window.canvas?.scene?.levels ?? []).map?.((l) => ({
      id: l.id,
      name: l.name,
      bottom: l.elevation?.bottom ?? null,
      top: l.elevation?.top ?? null,
      background: (l.background?.src || '').split('/').pop() || null,
    })) ?? null,
  }));
}

async function getReport(id) {
  return page.evaluate(async (reportId) => {
    try {
      const r = await window.MapShine?.debug?.runReport?.(reportId);
      return typeof r === 'string' ? JSON.parse(r) : r;
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }, id);
}

const shot = (name) =>
  page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-${name}.png`) }).catch((e) => {
    consoleLines.push({ type: 'screenshot-failed', text: `${name}: ${String(e)}`, at: Date.now() });
  });
const shotCanvas = (name) =>
  page
    .locator('canvas#msa-vt-pan-viewer-canvas')
    .screenshot({ path: path.join(OUT_DIR, `${LABEL}-${name}.png`) })
    .catch((e) => {
      consoleLines.push({ type: 'screenshot-failed', text: `${name}: ${String(e)}`, at: Date.now() });
    });

/** Toggle MSA's own "MSA Anchor View" scene-control tool — every candle/
 * lightning anchor shown as a pin, on the CURRENTLY viewed floor
 * (foundry/scene-controls-button.js, ui/anchor-view-mode.js). Calling the
 * tool's own stored `onChange` directly is exactly what a real click
 * dispatches, without depending on the scene-controls DOM layout. */
async function setAnchorView(on) {
  return page.evaluate((nextActive) => {
    const tool = window.ui?.controls?.controls?.tokens?.tools?.['map-shine-anchor-view'];
    if (!tool) return { ok: false, reason: 'anchor-view tool not registered (GM only, or controls not ready)' };
    tool.onChange(null, nextActive);
    return { ok: true, active: window.MapShine?.__anchorViewMode?.isActive?.() ?? null };
  }, on);
}

/** Every anchor marker pin currently on screen, read straight off the DOM
 * (position: fixed divs with the exact title text anchor-view-mode.js sets —
 * verified against that file's own makeIconEl/paintEnabledState). Screen
 * coordinates only; converted to world coordinates via Foundry's own
 * canvas.canvasCoordinatesFromClient for the close-up pan below. */
async function readAnchorMarkers() {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('div')).filter(
      (el) => el.title && /right-click to turn (on|off)/i.test(el.title)
    );
    return nodes.map((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height * 0.15; // icon is translated (-50%,-85%) — the anchor POINT is near the bottom tip
      let world = null;
      try {
        world = window.canvas?.canvasCoordinatesFromClient?.({ x: cx, y: cy }) ?? null;
      } catch (_) {}
      return { icon: el.textContent, screen: { x: Math.round(cx), y: Math.round(cy) }, world, enabledLooking: el.style.opacity !== '0.4' };
    });
  });
}

async function captureFloor(key, { panToFirstMarker }) {
  const floorState = {};
  floorState.sceneState = await getSceneState();
  save();

  await shot(`${key}-viewport`);
  await shotCanvas(`${key}-msa-canvas`);

  const anchorOn = await setAnchorView(true);
  floorState.anchorViewToggle = anchorOn;
  await page.waitForTimeout(1500); // marker loop populates over a couple of rAF ticks
  const markers = await readAnchorMarkers();
  floorState.anchorMarkers = markers;
  await shot(`${key}-anchors`);

  if (panToFirstMarker && markers.length && markers[0].world) {
    const target = markers[0].world;
    await page.evaluate((p) => window.canvas.animatePan({ x: p.x, y: p.y, scale: 2.2, duration: 400 }), target);
    await page.waitForTimeout(900);
    await shot(`${key}-closeup-marker0`);
    floorState.closeupTarget = target;
  }

  await setAnchorView(false);

  floorState.maskAuthority = await getReport('mask-authority');
  floorState.loadingScreenState = await getReport('loading-screen-state');

  state.floors[key] = floorState;
  save();
  return floorState;
}

try {
  console.log(`[${LABEL}] goto ${launcher.getBaseUrl()}`);
  await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
  await bestEffortLogin(page);
  await waitForGameReady(page);
  await waitForCanvasReady(page);
  await waitForMapShineReady(page);
  await unpauseIfPaused(page);

  const gpu = await page.evaluate(async () => {
    if (typeof navigator.gpu === 'undefined') return { hasGpu: false };
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return { hasGpu: true, adapter: false };
    return { hasGpu: true, adapter: true, vendor: a.info?.vendor ?? null, architecture: a.info?.architecture ?? null };
  });
  state.gpu = gpu;
  console.log(`[${LABEL}] gpu:`, JSON.stringify(gpu));
  save();

  console.log(`[${LABEL}] waiting for map art to finish loading (cold BC compression can be ~50s)...`);
  const loadState = await waitForMapArtLoaded(600000);
  state.mapArtLoadMs = loadState.elapsedMs ?? null;
  console.log(`[${LABEL}] map art loaded`);

  await waitForSceneSettled(page, { label: 'ground initial', timeoutMs: 300000 });
  await page.waitForTimeout(10000); // residency / effect warm-up dwell, matches msa-look.spec.js's own SETTLE_SECONDS posture

  console.log(`[${LABEL}] capturing GROUND floor...`);
  const ground = await captureFloor('ground', { panToFirstMarker: true });
  console.log(
    `[${LABEL}] ground: viewedLevel=${ground.sceneState.viewedLevelName} fire.authored=` +
      JSON.stringify(ground.maskAuthority?.floors?.find((f) => f.index === ground.sceneState.levels?.findIndex?.((l) => l.id === ground.sceneState.viewedLevelId))?.authored?.fire)
  );

  // ---- THE FLOOR SWITCH — Foundry's own native, public API -----------------
  const levels = ground.sceneState.levels ?? [];
  console.log(`[${LABEL}] levels on this scene:`, JSON.stringify(levels));
  const firstFloor =
    levels.find((l) => /first/i.test(l.name || '')) ?? levels.find((l) => l.id !== ground.sceneState.viewedLevelId);
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

  if (switchResult.viewedLevelId !== firstFloor.id) {
    console.warn(`[${LABEL}] WARNING: canvas.level did not update synchronously to the target level — polling...`);
  }

  // canvasReady's MSA-side handler is fire-and-forget (Hooks does not await
  // it) — wait for the settle tracker, THEN a fixed buffer on top, exactly
  // like perf-run-full's own FLOOR_CHANGE_SETTLE_BUFFER_MS.
  await waitForSceneSettled(page, { label: 'first-floor switch', timeoutMs: 300000 });
  console.log(`[${LABEL}] settled — waiting an additional ${FLOOR_CHANGE_SETTLE_BUFFER_MS}ms floor-change buffer...`);
  await page.waitForTimeout(FLOOR_CHANGE_SETTLE_BUFFER_MS);

  console.log(`[${LABEL}] capturing FIRST FLOOR...`);
  const first = await captureFloor('first-floor', { panToFirstMarker: true });
  console.log(`[${LABEL}] first-floor: viewedLevel=${first.sceneState.viewedLevelName}`);

  // The direct answer to "did _Fire mask discovery succeed for First-Floor":
  const ffRow = first.maskAuthority?.floors?.find((f) => f.id === firstFloor.id || f.name === firstFloor.name);
  const groundRow = ground.maskAuthority?.floors?.find((f) => f.id === ground.sceneState.viewedLevelId);
  state.fireMaskComparison = {
    ground: groundRow ? { index: groundRow.index, name: groundRow.name, authoredFire: groundRow.authored?.fire } : null,
    firstFloor: ffRow ? { index: ffRow.index, name: ffRow.name, authoredFire: ffRow.authored?.fire } : null,
  };
  console.log(`[${LABEL}] fire mask comparison:`, JSON.stringify(state.fireMaskComparison, null, 2));

  state.ok = true;
  console.log(`[${LABEL}] DONE.`);
} catch (e) {
  console.error(`[${LABEL}] run stopped early:`, e);
  state.error = String(e?.stack || e?.message || e);
} finally {
  save();
  await context.close().catch(() => {});
  await launcher.stop();
  console.log(`[${LABEL}] wrote ${resultPath}`);
}
