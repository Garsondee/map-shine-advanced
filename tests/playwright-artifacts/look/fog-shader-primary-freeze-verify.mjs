/** Bug #18 live gate — "selecting a token shows a frozen, screen-locked
 * second copy of the map inside explored fog" (docs/planning/Bug-Tracker.md
 * #18, memory `keyhole-fog-shader-primary-texture-freeze`).
 *
 * Root cause (source-verified, not guessed): MSA's old single-lever
 * suppression (`canvas.environment.renderable = false`) stopped
 * `canvas.primary`'s own `CachedContainer#render()` from ever running, which
 * froze `canvas.primary.renderTexture` solid — and Foundry's own fog-of-war
 * shader unconditionally samples that exact texture for its "explored, not
 * currently visible" zone. The fix (`canvas-compositing.js`, 2026-08-13)
 * splits the suppression: `canvas.primary.renderable` stays `true` (cache
 * keeps refreshing every frame) while only `canvas.primary.sprite.renderable`
 * is set `false` (screen output suppressed) — plus `canvas.effects.renderable
 * = false` directly (no cache to protect there).
 *
 * THE DECISIVE CHECK is not a screenshot — it's whether
 * `canvas.primary.renderTexture`'s own CONTENT changes when the camera pans.
 * Frozen ⇒ identical before/after regardless of camera movement (the bug).
 * Live ⇒ different content after a real pan (the fix). Screenshots are a
 * secondary, best-effort visual record for a human to actually look at
 * (feedback_verification_ground_truth) — not the gate itself.
 *
 * Non-vacuity guard, same discipline as every other rung-4 script in this
 * directory (s2-15, stage1-earlyz, ...): the pan must be PROVEN to have
 * actually moved `canvas.stage.pivot` before a "no diff" result means
 * anything. A camera that never moved would make "0 diff" look like a pass
 * when it proves nothing.
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

const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const LABEL = 'fog-shader-primary-freeze';

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
await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
await bestEffortLogin(page);
await waitForGameReady(page);
await waitForCanvasReady(page);
await waitForMapShineReady(page);
await unpauseIfPaused(page);

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
    if (Date.now() - start > timeoutMs) throw new Error(`Map art did not finish loading after ${Math.round((Date.now() - start) / 1000)}s`);
    await page.waitForTimeout(1000);
  }
}
console.log(`[${LABEL}] waiting for real map art…`);
await waitForMapArtLoaded(600000);
await waitForSceneSettled(page, { label: 'ground floor' });

async function twoFrames() {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// ---------------------------------------------------------------------------
// STEP 1 — the suppression mechanism itself: confirm the NEW two-lever shape
// is actually what's live, not assumed from reading the source.
// ---------------------------------------------------------------------------
const mechanism = await page.evaluate(() => {
  const report = window.MapShine?.debug?.runReport ? window.MapShine.debug.runReport('interface-seam') : null;
  return {
    report,
    primaryRenderable: window.canvas?.primary?.renderable ?? null,
    primarySpriteRenderable: window.canvas?.primary?.sprite?.renderable ?? null,
    effectsRenderable: window.canvas?.effects?.renderable ?? null,
  };
});
console.log(`[${LABEL}] mechanism state:`, JSON.stringify(mechanism, null, 2));

// ---------------------------------------------------------------------------
// STEP 2 — THE DECISIVE CHECK: does canvas.primary.renderTexture content
// change when the camera pans, or is it frozen?
// ---------------------------------------------------------------------------
async function samplePrimaryTexture() {
  return page.evaluate(() => {
    const tex = window.canvas?.primary?.renderTexture;
    const renderer = window.canvas?.app?.renderer;
    if (!tex) return { ok: false, reason: 'no canvas.primary.renderTexture' };
    if (!renderer?.extract) return { ok: false, reason: 'no renderer.extract plugin' };
    try {
      const pixels = renderer.extract.pixels(tex);
      let checksum = 0;
      for (let i = 0; i < pixels.length; i += 97) checksum = (checksum + pixels[i]) >>> 0;
      const w = tex.width;
      const h = tex.height;
      const mid = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
      return {
        ok: true,
        width: w,
        height: h,
        length: pixels.length,
        checksum,
        centerPixel: [pixels[mid], pixels[mid + 1], pixels[mid + 2], pixels[mid + 3]],
      };
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e) };
    }
  });
}

async function readCamera() {
  return page.evaluate(() => {
    const s = window.canvas?.stage;
    return { x: s?.pivot?.x ?? null, y: s?.pivot?.y ?? null, scale: s?.scale?.x ?? null };
  });
}

const dims = await page.evaluate(() => {
  const d = window.canvas?.dimensions;
  return { sceneWidth: d?.sceneWidth ?? null, sceneHeight: d?.sceneHeight ?? null, sceneX: d?.sceneX ?? null, sceneY: d?.sceneY ?? null };
});
console.log(`[${LABEL}] scene dimensions:`, JSON.stringify(dims));

const cameraBefore = await readCamera();
const sampleBefore = await samplePrimaryTexture();
console.log(`[${LABEL}] camera before pan:`, JSON.stringify(cameraBefore));
console.log(`[${LABEL}] primary texture sample before pan:`, JSON.stringify(sampleBefore));

// Pan to a genuinely different part of the scene — a large fraction of scene
// width/height away from wherever we started, clamped inside the scene rect
// so this is a realistic camera move, not an out-of-bounds edge case.
const panTarget = await page.evaluate((camBefore) => {
  const d = window.canvas.dimensions;
  const targetX = d.sceneX + d.sceneWidth * 0.75;
  const targetY = d.sceneY + d.sceneHeight * 0.75;
  window.canvas.pan({ x: targetX, y: targetY });
  return { x: targetX, y: targetY };
}, cameraBefore);
await twoFrames();
await page.waitForTimeout(300); // let residency/streaming catch up to the new view

const cameraAfter = await readCamera();
const sampleAfter = await samplePrimaryTexture();
console.log(`[${LABEL}] pan target:`, JSON.stringify(panTarget));
console.log(`[${LABEL}] camera after pan:`, JSON.stringify(cameraAfter));
console.log(`[${LABEL}] primary texture sample after pan:`, JSON.stringify(sampleAfter));

const cameraGenuinelyMoved =
  cameraBefore.x !== null && cameraAfter.x !== null &&
  (Math.abs(cameraAfter.x - cameraBefore.x) > 1 || Math.abs(cameraAfter.y - cameraBefore.y) > 1);

const textureContentChanged =
  sampleBefore.ok && sampleAfter.ok &&
  (sampleBefore.checksum !== sampleAfter.checksum || JSON.stringify(sampleBefore.centerPixel) !== JSON.stringify(sampleAfter.centerPixel));

const decisiveVerdict = !cameraGenuinelyMoved
  ? 'VACUOUS — the camera never actually moved (canvas.pan had no measurable effect); this proves nothing about the freeze'
  : !sampleBefore.ok || !sampleAfter.ok
    ? `INCONCLUSIVE — could not sample canvas.primary.renderTexture (${sampleBefore.reason || sampleAfter.reason})`
    : textureContentChanged
      ? 'PASS — canvas.primary.renderTexture content CHANGED after a real camera pan: the cache is live, not frozen'
      : 'FAIL — canvas.primary.renderTexture content is IDENTICAL after a real camera pan: still frozen, the bug is not fixed';
console.log(`[${LABEL}] DECISIVE VERDICT: ${decisiveVerdict}`);

// ---------------------------------------------------------------------------
// STEP 3 — best-effort visual record: control a token (forces
// canvas.visibility.visible=true, the condition the bug needs to show at
// all), screenshot, pan again, screenshot. For a human to actually look at —
// not itself a pass/fail gate (a screenshot diff can't safely tell "ghost"
// from "legitimately different content after a real pan").
// ---------------------------------------------------------------------------
let visualStep = { attempted: false };
try {
  const tokenInfo = await page.evaluate(async () => {
    const placeables = window.canvas?.tokens?.placeables ?? [];
    if (!placeables.length) return { found: false };
    const token = placeables[0];
    const originalSight = foundry.utils.deepClone(token.document.sight);
    if (!(token.document.sight?.range > 0)) {
      await token.document.update({ sight: { enabled: true, range: 60 } });
    }
    await token.control({ releaseOthers: true });
    return { found: true, tokenId: token.id, name: token.name, originalSight };
  });
  visualStep.attempted = true;
  visualStep.tokenInfo = tokenInfo;

  if (tokenInfo.found) {
    // Give vision/fog a moment to initialize and commit.
    await page.waitForTimeout(500);
    await twoFrames();
    const visibilityState = await page.evaluate(() => ({
      visible: window.canvas?.visibility?.visible ?? null,
      activeVisionSources: Array.from(window.canvas?.effects?.visionSources ?? []).filter((s) => s?.active).length,
    }));
    visualStep.visibilityState = visibilityState;
    console.log(`[${LABEL}] visibility state with token controlled:`, JSON.stringify(visibilityState));

    await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-token-controlled-view1.png`) });
    await page
      .locator('canvas#msa-vt-pan-viewer-canvas')
      .screenshot({ path: path.join(OUT_DIR, `${LABEL}-token-controlled-view1-msa-canvas.png`) })
      .catch(() => {});

    // Pan again, further, with the token still controlled and fog now live.
    await page.evaluate((camBefore) => {
      const d = window.canvas.dimensions;
      window.canvas.pan({ x: d.sceneX + d.sceneWidth * 0.3, y: d.sceneY + d.sceneHeight * 0.3 });
    }, cameraAfter);
    await twoFrames();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-token-controlled-view2-panned.png`) });
    await page
      .locator('canvas#msa-vt-pan-viewer-canvas')
      .screenshot({ path: path.join(OUT_DIR, `${LABEL}-token-controlled-view2-panned-msa-canvas.png`) })
      .catch(() => {});

    // Restore: release control, restore original sight config (Law 3 — never
    // leave world state mutated by a verification script).
    await page.evaluate(async (info) => {
      const token = window.canvas?.tokens?.placeables?.find((t) => t.id === info.tokenId);
      if (!token) return;
      token.release();
      await token.document.update({ sight: info.originalSight });
    }, tokenInfo);
  }
} catch (e) {
  visualStep.error = String(e?.message ?? e);
  console.log(`[${LABEL}] visual step error (non-fatal, mechanism check above is the real gate):`, visualStep.error);
}

// Restore camera to where we started, for tidiness.
await page.evaluate((cam) => {
  if (cam.x !== null) window.canvas.pan({ x: cam.x, y: cam.y, scale: cam.scale ?? undefined });
}, cameraBefore);

// ---------------------------------------------------------------------------
// STEP 4 — perf sanity: fps post-fix, for comparison against the harness's
// own known baseline (memory reference_live_foundry_harness: 67fps, Mansion
// both floors, 1920x1080, 2026-08-10) — not a true A/B (that would require
// re-running the OLD code), but a real number, not an assumption.
// ---------------------------------------------------------------------------
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
console.log(`[${LABEL}] post-fix fps (60-tick, current view): ${fps}`);

const summary = {
  label: LABEL,
  capturedAt: new Date().toISOString(),
  mechanism,
  dims,
  cameraBefore,
  cameraAfter,
  panTarget,
  sampleBefore,
  sampleAfter,
  cameraGenuinelyMoved,
  textureContentChanged,
  decisiveVerdict,
  visualStep,
  postFixFps: fps,
  consoleErrors: consoleLines.filter((l) => /error/i.test(l)).slice(0, 40),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-result.json`), JSON.stringify(summary, null, 2));
console.log(`[${LABEL}] wrote ${LABEL}-result.json + screenshots to ${OUT_DIR}`);

await context.close();
await launcher.stop();
