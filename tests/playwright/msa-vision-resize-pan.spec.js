/**
 * ONE-OFF LIVE DIAGNOSTIC — does resize/pan/zoom break the vision gate?
 *
 * Author, 2026-08-15, after the union-vs-intersection fix shipped: *"I select
 * the character. No black fog of war appears, my token can see everything.
 * That's broken. I pan the camera and or zoom in and out, then the whole
 * scene goes black in it's entirety."*
 *
 * Found while chasing this: `visionMask.renderTarget` (screenSized: true) was
 * never in `reallocateScreenSizedTargets()`'s resize-dispatch list, unlike
 * every other screen-sized target — so a window resize would leave it frozen
 * at whatever size existed when the viewer first constructed. Fixed in
 * `vision-mask-render.js` (new `resize()` method) + `vt-pan-viewer.js` (one
 * new call in `reallocateScreenSizedTargets()`).
 *
 * This spec exists because that fix explains a RESIZE-triggered blackout, but
 * the author also reported a plain PAN doing it — and a pure camera pan does
 * NOT touch `canvasW`/`canvasH`, so it would not reach that code path at all.
 * Rather than theorise further, this measures the reveal fraction
 * (`visibilityGrid`) at each step: before touching the camera, after a PURE
 * pan, after a real browser resize, and after a zoom — so "pan alone" and
 * "resize" are tested as two independent, separately falsifiable hypotheses
 * instead of one bundled guess.
 *
 * Throwaway harness for THIS investigation. Delete once the author confirms.
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

/** Reveal fraction + mask rasteriser health, sampled the same way each time. */
async function readRevealState(page) {
  return page.evaluate(async () => {
    const out = {};
    try {
      const raw = await window.MapShine?.debug?.runReport?.('vt-pan-viewer-diagnostics');
      const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
      out.visionMask = r?.visionMask ?? null;
    } catch (e) {
      out.visionMask = { error: String(e) };
    }
    try {
      const canvas = window.canvas;
      const vis = canvas?.visibility;
      const rect = canvas?.dimensions?.sceneRect;
      out.visibilityGrid = null;
      if (rect && vis?.testVisibility) {
        let visibleCount = 0;
        let total = 0;
        for (let i = 1; i <= 6; i++) {
          for (let j = 1; j <= 6; j++) {
            const px = rect.x + (rect.width * i) / 7;
            const py = rect.y + (rect.height * j) / 7;
            let v = null;
            try {
              v = vis.testVisibility({ x: px, y: py, elevation: 0 }, { tolerance: 0 });
            } catch (e) {
              v = `threw: ${e}`;
            }
            total++;
            if (v === true) visibleCount++;
          }
        }
        out.visibilityGrid = { visibleCount, total };
      }
      out.stage = { x: canvas?.stage?.pivot?.x ?? null, y: canvas?.stage?.pivot?.y ?? null, scale: canvas?.stage?.scale?.x ?? null };
      out.drawBuf = window.MapShine?.debug?.getVisionMaskInfo ? window.MapShine.debug.getVisionMaskInfo() : null;
    } catch (e) {
      out.error = String(e);
    }
    return out;
  });
}

test('does a pure pan, a real resize, or a zoom break the vision gate?', async () => {
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
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${String(e).slice(0, 300)}`));

  const launcher = new FoundryLauncher({ headless: true });
  await launcher.start();

  const timeline = [];

  try {
    await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
    await bestEffortLogin(page);
    await waitForGameReady(page);
    await ensureActiveScene(page);
    await waitForCanvasReady(page);
    await waitForMapShineReady(page);
    await unpauseIfPaused(page);
    await waitForSceneSettled(page, { timeoutMs: 150000, label: 'vision-resize-pan' });

    await page.evaluate(() => window.MapShine?.setSunHour?.(12));
    await page.waitForTimeout(2000);

    const created = await page.evaluate(async () => {
      const rect = window.canvas.dimensions.sceneRect;
      const x = Math.round(rect.x + rect.width * 0.5);
      const y = Math.round(rect.y + rect.height * 0.5);
      const stale = window.canvas.scene.tokens.filter((t) => t.name === 'MSA Resize Probe').map((t) => t.id);
      if (stale.length) await window.canvas.scene.deleteEmbeddedDocuments('Token', stale);
      const [doc] = await window.canvas.scene.createEmbeddedDocuments('Token', [
        {
          name: 'MSA Resize Probe',
          x,
          y,
          width: 1,
          height: 1,
          sight: { enabled: true, range: 0 },
          texture: { src: 'icons/svg/mystery-man.svg' },
        },
      ]);
      return { id: doc?.id, x, y };
    });
    console.log(`[resize-pan] created token ${created.id} at (${created.x}, ${created.y})`);
    await page.waitForTimeout(1000);

    const controlled = await page.evaluate((id) => {
      const tok = window.canvas.tokens.get(id);
      if (!tok) return { ok: false };
      tok.control({ releaseOthers: true });
      window.canvas.perception.update({ refreshLighting: true, refreshVision: true });
      window.canvas.pan({ x: tok.document.x, y: tok.document.y, scale: 1 });
      return { ok: true };
    }, created.id);
    console.log(`[resize-pan] control: ${JSON.stringify(controlled)}`);
    await page.waitForTimeout(2500);

    // ── STEP 0: baseline, camera centred on the token, untouched ──────────
    const s0 = await readRevealState(page);
    timeline.push({ step: 'baseline (centred on token)', ...s0 });
    console.log(`[resize-pan] STEP0 baseline: visible=${s0.visibilityGrid?.visibleCount}/${s0.visibilityGrid?.total} mask=${JSON.stringify(s0.visionMask)}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'resize-pan-0-baseline.png') });

    // ── STEP 1: a PURE pan — camera translation only, canvas size untouched ─
    await page.evaluate((id) => {
      const tok = window.canvas.tokens.get(id);
      window.canvas.pan({ x: tok.document.x + 800, y: tok.document.y + 400, scale: 1 });
    }, created.id);
    await page.waitForTimeout(1500);
    const s1 = await readRevealState(page);
    timeline.push({ step: 'pure pan (+800,+400), no resize', ...s1 });
    console.log(`[resize-pan] STEP1 pure pan: visible=${s1.visibilityGrid?.visibleCount}/${s1.visibilityGrid?.total} mask=${JSON.stringify(s1.visionMask)}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'resize-pan-1-pan.png') });

    // pan back over the token before the next steps, so any effect is
    // attributable to what THAT step does, not to the camera being elsewhere.
    await page.evaluate((id) => {
      const tok = window.canvas.tokens.get(id);
      window.canvas.pan({ x: tok.document.x, y: tok.document.y, scale: 1 });
    }, created.id);
    await page.waitForTimeout(1000);

    // ── STEP 2: a ZOOM — scale change only, canvas size untouched ──────────
    await page.evaluate((id) => {
      const tok = window.canvas.tokens.get(id);
      window.canvas.pan({ x: tok.document.x, y: tok.document.y, scale: 2 });
    }, created.id);
    await page.waitForTimeout(1500);
    const s2 = await readRevealState(page);
    timeline.push({ step: 'zoom to scale=2, no resize', ...s2 });
    console.log(`[resize-pan] STEP2 zoom: visible=${s2.visibilityGrid?.visibleCount}/${s2.visibilityGrid?.total} mask=${JSON.stringify(s2.visionMask)}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'resize-pan-2-zoom.png') });

    await page.evaluate((id) => {
      const tok = window.canvas.tokens.get(id);
      window.canvas.pan({ x: tok.document.x, y: tok.document.y, scale: 1 });
    }, created.id);
    await page.waitForTimeout(1000);

    // ── STEP 3: a REAL browser window resize — this is what the fix targets ─
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.waitForTimeout(2000);
    const s3 = await readRevealState(page);
    timeline.push({ step: 'browser resized 1600x900 -> 1200x700', ...s3 });
    console.log(`[resize-pan] STEP3 resize down: visible=${s3.visibilityGrid?.visibleCount}/${s3.visibilityGrid?.total} mask=${JSON.stringify(s3.visionMask)}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'resize-pan-3-resized-down.png') });

    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(2000);
    const s4 = await readRevealState(page);
    timeline.push({ step: 'browser resized back 1200x700 -> 1600x900', ...s4 });
    console.log(`[resize-pan] STEP4 resize back: visible=${s4.visibilityGrid?.visibleCount}/${s4.visibilityGrid?.total} mask=${JSON.stringify(s4.visionMask)}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'resize-pan-4-resized-back.png') });

    // ── STEP 5: pan AFTER the resize — does the resize leave pan broken? ───
    await page.evaluate((id) => {
      const tok = window.canvas.tokens.get(id);
      window.canvas.pan({ x: tok.document.x - 600, y: tok.document.y - 300, scale: 1 });
    }, created.id);
    await page.waitForTimeout(1500);
    const s5 = await readRevealState(page);
    timeline.push({ step: 'pan after resize round-trip', ...s5 });
    console.log(`[resize-pan] STEP5 pan-after-resize: visible=${s5.visibilityGrid?.visibleCount}/${s5.visibilityGrid?.total} mask=${JSON.stringify(s5.visionMask)}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'resize-pan-5-pan-after-resize.png') });

    await page.evaluate(async (id) => {
      try {
        await window.canvas.scene.deleteEmbeddedDocuments('Token', [id]);
      } catch (_) {}
    }, created.id);

    fs.writeFileSync(
      path.join(OUT_DIR, 'resize-pan.json'),
      JSON.stringify({ capturedAt: new Date().toISOString(), created, timeline, consoleErrors }, null, 2)
    );
    console.log(`[resize-pan] wrote ${path.join(OUT_DIR, 'resize-pan.json')}`);
  } finally {
    await context.close().catch(() => {});
    await launcher.stop();
  }
});
