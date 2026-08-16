/**
 * ONE-OFF LIVE DIAGNOSTIC — the dim explored-zone slice, and specifically the
 * one property that matters more than the look: a DECOY token sitting in an
 * area the player explored and then left must NEVER appear in the dim
 * "remembered map" view, even faintly. `captureMapOnlySnapshot()` (vt-pan-
 * viewer.js) excludes token/vegetationOverlay meshes from the scene it draws
 * from — this spec is what actually proves that holds live, not just reads
 * true in the source.
 *
 * Sequence: control a token (A) near a decoy token (B, never controlled —
 * standing in for "a monster"). Let exploration + the throttled snapshot
 * publish catch up. Move A far away so NEITHER position is currently visible.
 * Screenshot the now-dim area B sits in: the floor/wall art should be
 * visible, dim, and B's own sprite must not be.
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

async function readVisionMaskInfo(page) {
  return page.evaluate(async () => {
    try {
      const raw = await window.MapShine?.debug?.runReport?.('vt-pan-viewer-diagnostics');
      const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return r?.visionMask ?? null;
    } catch (e) {
      return { error: String(e) };
    }
  });
}

test('does a decoy token ever appear in the dim explored-but-not-visible zone?', async () => {
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

  try {
    await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
    await bestEffortLogin(page);
    await waitForGameReady(page);
    await ensureActiveScene(page);
    await waitForCanvasReady(page);
    await waitForMapShineReady(page);
    await unpauseIfPaused(page);
    await waitForSceneSettled(page, { timeoutMs: 150000, label: 'vision-explored-dim' });

    await page.evaluate(() => window.MapShine?.setSunHour?.(12));
    await page.waitForTimeout(1000);

    // ── CREATE A (controlled) AND B (decoy, never controlled) ────────────
    // Both near each other so a real light/sight radius covers both.
    const created = await page.evaluate(async () => {
      const rect = window.canvas.dimensions.sceneRect;
      const ax = Math.round(rect.x + rect.width * 0.5);
      const ay = Math.round(rect.y + rect.height * 0.5);
      const bx = ax + 150;
      const by = ay;
      const stale = window.canvas.scene.tokens
        .filter((t) => t.name === 'MSA Dim Probe A' || t.name === 'MSA Dim Probe B')
        .map((t) => t.id);
      if (stale.length) await window.canvas.scene.deleteEmbeddedDocuments('Token', stale);
      const [docA, docB] = await window.canvas.scene.createEmbeddedDocuments('Token', [
        {
          name: 'MSA Dim Probe A',
          x: ax,
          y: ay,
          width: 1,
          height: 1,
          sight: { enabled: true, range: 0 },
          texture: { src: 'icons/svg/mystery-man.svg' },
        },
        {
          name: 'MSA Dim Probe B',
          x: bx,
          y: by,
          width: 1,
          height: 1,
          sight: { enabled: false, range: 0 },
          // A bright, saturated colour tint so a decoy sprite (if it leaked)
          // is unmistakable in a screenshot, not a subtle shape to eyeball.
          texture: { src: 'icons/svg/hazard.svg', tint: '#ff00ff' },
        },
      ]);
      return { aId: docA?.id, bId: docB?.id, ax, ay, bx, by };
    });
    console.log(`[dim] created A=${created.aId} @(${created.ax},${created.ay}) B=${created.bId} @(${created.bx},${created.by})`);
    await page.waitForTimeout(500);

    // ── CONTROL A, CENTRE CAMERA SO BOTH A AND B ARE ON-SCREEN ────────────
    await page.evaluate(
      ({ aId, ax, ay }) => {
        const tok = window.canvas.tokens.get(aId);
        tok.control({ releaseOthers: true });
        window.canvas.perception.update({ refreshLighting: true, refreshVision: true });
        window.canvas.pan({ x: ax, y: ay, scale: 1 });
      },
      { aId: created.aId, ax: created.ax, ay: created.ay }
    );

    // Let exploration accumulate AND the throttled snapshot publish catch up
    // (SNAPSHOT_PUBLISH_INTERVAL_MS=250) — the pixel-probe itself only fires
    // every 10th tick (~2.5s), so this waits comfortably past that, not just
    // past the first publish.
    await page.waitForTimeout(4000);

    const beforeInfo = await readVisionMaskInfo(page);
    console.log(`[dim] BEFORE moving away: ${JSON.stringify(beforeInfo)}`);
    console.log(
      `[dim] snapshotPixelProbe (should be BRIGHT — this is Clara's own current, currently-revealed spot): ${JSON.stringify(beforeInfo?.snapshotPixelProbe)}`
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'dim-0-before-live.png') });

    // ── MOVE A FAR AWAY — neither A's nor B's old position is visible now ──
    const rectAway = await page.evaluate(() => {
      const rect = window.canvas.dimensions.sceneRect;
      return { x: Math.round(rect.x + rect.width * 0.05), y: Math.round(rect.y + rect.height * 0.95) };
    });
    await page.evaluate(
      async ({ aId, x, y }) => {
        const tok = window.canvas.tokens.get(aId);
        await tok.document.update({ x, y, animate: false });
        window.canvas.perception.update({ refreshLighting: true, refreshVision: true });
        window.canvas.pan({ x, y, scale: 1 });
      },
      { aId: created.aId, ...rectAway }
    );
    // Longer than before — the PREVIOUS run's "after" probe sampled a
    // position close to A's OLD spot, not the new one, consistent with
    // catching the token still mid-move. animate:false above should make
    // that moot, but keep the wider margin anyway: this also needs the
    // pixel-probe's OWN 10-tick cadence to land on the NEW position, not
    // just the token to have physically arrived.
    await page.waitForTimeout(3000);

    // Pan the CAMERA back to where B is, WITHOUT moving A back — B's area
    // should now be explored-but-not-currently-visible: dim, and B-free.
    await page.evaluate(
      ({ bx, by }) => window.canvas.pan({ x: bx, y: by, scale: 1 }),
      { bx: created.bx, by: created.by }
    );
    await page.waitForTimeout(1500);

    const afterInfo = await readVisionMaskInfo(page);
    console.log(`[dim] AFTER moving away, camera back on B's old spot: ${JSON.stringify(afterInfo)}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'dim-1-after-moved-away.png') });

    // Zoom in tight on B's last-known screen position for a clear close-up.
    await page.evaluate(({ bx, by }) => window.canvas.pan({ x: bx, y: by, scale: 2.5 }), {
      bx: created.bx,
      by: created.by,
    });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT_DIR, 'dim-2-zoomed-on-decoy-spot.png') });

    await page.evaluate(async (ids) => {
      try {
        await window.canvas.scene.deleteEmbeddedDocuments('Token', ids);
      } catch (_) {}
    }, [created.aId, created.bId]);

    fs.writeFileSync(
      path.join(OUT_DIR, 'dim-explored.json'),
      JSON.stringify({ capturedAt: new Date().toISOString(), created, beforeInfo, afterInfo, consoleErrors }, null, 2)
    );
    console.log(`[dim] wrote ${path.join(OUT_DIR, 'dim-explored.json')}`);
    console.log(`[dim] consoleErrors: ${JSON.stringify(consoleErrors)}`);
  } finally {
    await context.close().catch(() => {});
    await launcher.stop();
  }
});
