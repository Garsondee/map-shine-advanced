/**
 * ONE-OFF LIVE DIAGNOSTIC — THE REPORTED BUG, MEASURED AT ITS OWN OUTPUT.
 *
 * Author, 2026-08-15, after a first fix attempt: *"I have a token, outside,
 * scene darkness is 0, time of day is noon and the only area that is visible
 * when I select them is a point light nearby, not the majority of the scene
 * which they should be able to see."*
 *
 * ⚠️ WHY THIS EXISTS SEPARATELY FROM `msa-global-light-writeback.spec.js`:
 * that spec measured `canvas.effects.testInsideLight(point)` and called the
 * bug fixed. `testInsideLight` is an INPUT to Foundry's vision decision, not
 * the thing that decides what a controlled token actually reveals — the
 * revealed area is drawn by `CanvasVisibility#refreshVisibility`, where the
 * lit layer (`vision.light`, which includes the global-light shape) is
 * MASKED by `vision.light.mask`, which is only fed by (a) each active vision
 * source's own light-perception polygon, gated on `visionSource.lightRadius
 * > 0`, and (b) light sources with `data.vision === true`. A scene can
 * therefore have `testInsideLight → true` everywhere outdoors while a
 * controlled token still reveals nothing but a vision-providing point light —
 * exactly the reported symptom. Measuring the equation instead of the output
 * is a named lesson in this project (`feedback_measure_the_output_not_the_
 * equation`); this spec is the correction.
 *
 * The bench scene ships NO tokens (the export bridge deliberately excludes
 * them — `reference_scene_export_import_bridge`), which is precisely why the
 * earlier spec could not have caught this. So this one CREATES a token
 * outdoors, CONTROLS it, and reads the real vision state + screenshots what
 * the token actually sees.
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

/** Read the full vision picture — every gate between "it is noon" and "the token sees". */
async function readVisionState(page) {
  return page.evaluate(async () => {
    const out = {};
    // THE NEW `token-vision` REPORT — validated here so it can never ship as a
    // diagnostic that throws or reports nonsense on a real scene.
    try {
      const raw = await window.MapShine?.debug?.runReport?.('token-vision');
      out.tokenVisionReport = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      out.tokenVisionReport = { error: String(e) };
    }
    try {
      const canvas = window.canvas;
      const env = canvas?.environment;
      const gls = env?.globalLightSource;

      out.scene = {
        tokenVision: canvas?.scene?.tokenVision ?? null,
        darknessLevel: canvas?.scene?.environment?.darknessLevel ?? null,
        globalLightDoc: canvas?.scene?.environment?.globalLight
          ? {
              enabled: canvas.scene.environment.globalLight.enabled,
              darkness: canvas.scene.environment.globalLight.darkness,
            }
          : null,
      };

      // THE GLOBAL LIGHT SOURCE — active is the real gate; shape having real
      // area is the second (a disabled source computes a ZERO-RADIUS polygon,
      // so "active" alone does not prove it can draw anything).
      out.globalLight = gls
        ? {
            active: gls.active,
            disabled: gls.data?.disabled ?? null,
            suppressed: gls.suppressed ?? null,
            darknessWindow: gls.data?.darkness ?? null,
            liveDarkness: env?.darknessLevel ?? null,
            shapePoints: gls.shape?.points?.length ?? null,
            radius: gls.radius ?? null,
            // MSA's own derived inputs, straight from the viewer report — so a
            // "why is the window that value" question is answerable from this
            // one artifact instead of a second investigation.
            minRegionFloor: await (async () => {
              try {
                const raw = await window.MapShine?.debug?.runReport?.('vt-pan-viewer-diagnostics');
                const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return r?.envSnapshot?.minDarknessRegionFloor ?? null;
              } catch {
                return null;
              }
            })(),
            // Does the window admit the CURRENT darkness? This is the exact
            // test #refreshDynamicIllumination runs before drawing the shape.
            windowAdmitsNow:
              gls.data?.darkness && Number.isFinite(env?.darknessLevel)
                ? env.darknessLevel >= gls.data.darkness.min && env.darknessLevel <= gls.data.darkness.max
                : null,
          }
        : null;

      // THE VISIBILITY GROUP's own live containers.
      const vis = canvas?.visibility;
      out.visibility = {
        initialized: vis?.initialized ?? null,
        visible: vis?.visible ?? null,
        tokenVision: vis?.tokenVision ?? null,
        globalContainerVisible: vis?.vision?.light?.global?.visible ?? null,
        globalMeshCount: vis?.vision?.light?.global?.meshes?.children?.length ?? null,
      };

      // EVERY ACTIVE VISION SOURCE — lightRadius > 0 is what puts the token's
      // own light-perception polygon into `vision.light.mask`; at 0, EVERY lit
      // area (global light included) is masked away for that token.
      out.visionSources = [];
      for (const vs of canvas?.effects?.visionSources ?? []) {
        out.visionSources.push({
          sourceId: vs.sourceId,
          active: vs.active,
          hasActiveLayer: vs.hasActiveLayer,
          isBlinded: vs.isBlinded,
          blinded: vs.blinded ? { ...vs.blinded } : null,
          radius: vs.radius,
          lightRadius: vs.lightRadius,
          lightPolygonPoints: vs.light?.points?.length ?? null,
          losPoints: vs.shape?.points?.length ?? null,
        });
      }

      // THE CONTROLLED TOKEN's own authored config — the other half of the
      // question (a token with lightPerception disabled can never see lit area).
      const tok = canvas?.tokens?.controlled?.[0] ?? null;
      out.controlledToken = tok
        ? {
            id: tok.id,
            name: tok.document?.name,
            x: tok.document?.x,
            y: tok.document?.y,
            elevation: tok.document?.elevation,
            sight: tok.document?.sight ? { ...tok.document.sight } : null,
            detectionModes: JSON.parse(JSON.stringify(tok.document?.detectionModes ?? {})),
            lightPerceptionRange: tok.lightPerceptionRange,
            sightRange: tok.sightRange,
          }
        : null;

      // Lights flagged "provides vision" — these draw STRAIGHT into
      // vision.light.mask, which is why one of them can be the ONLY thing a
      // token reveals when its own light-perception polygon is missing.
      out.visionProvidingLights = [];
      for (const ls of canvas?.effects?.lightSources ?? []) {
        if (ls?.data?.vision && ls.active) {
          out.visionProvidingLights.push({ sourceId: ls.sourceId, radius: ls.radius });
        }
      }

      // THE ACTUAL OUTPUT: can the scene's own visibility test see a far
      // outdoor point? Sampled on a coarse grid across the scene rect so a
      // single unlucky coordinate cannot decide the verdict.
      const rect = canvas?.dimensions?.sceneRect;
      out.visibilityGrid = null;
      if (rect && vis?.testVisibility) {
        let visibleCount = 0;
        let total = 0;
        const samples = [];
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
            if (samples.length < 8) samples.push({ x: Math.round(px), y: Math.round(py), visible: v });
          }
        }
        out.visibilityGrid = { visibleCount, total, samples };
      }
    } catch (e) {
      out.error = String(e);
    }
    return out;
  });
}

test('what does a controlled token OUTSIDE at noon actually reveal?', async () => {
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
    await waitForSceneSettled(page, { timeoutMs: 150000, label: 'token-vision' });

    // Noon, and give the publish throttle room to fire.
    await page.evaluate(() => window.MapShine?.setSunHour?.(12));
    await page.waitForTimeout(2000);

    // ── CREATE A TOKEN OUTDOORS ──────────────────────────────────────────
    // Placed at a scene-rect corner inset, the same coordinate family the
    // earlier spec independently established as genuine outdoor space.
    const created = await page.evaluate(async () => {
      const rect = window.canvas.dimensions.sceneRect;
      const x = Math.round(rect.x + rect.width * 0.06);
      const y = Math.round(rect.y + rect.height * 0.06);
      // Clean up any token this spec left behind on a previous run, so the
      // scene never accumulates and a stale token can never be the one that
      // gets controlled.
      const stale = window.canvas.scene.tokens.filter((t) => t.name === 'MSA Vision Probe').map((t) => t.id);
      if (stale.length) await window.canvas.scene.deleteEmbeddedDocuments('Token', stale);
      const [doc] = await window.canvas.scene.createEmbeddedDocuments('Token', [
        {
          name: 'MSA Vision Probe',
          x,
          y,
          width: 1,
          height: 1,
          // sight.range 0 = no personal unaided sight; the token must rely on
          // light perception, which is exactly the reported scenario.
          sight: { enabled: true, range: 0 },
          texture: { src: 'icons/svg/mystery-man.svg' },
        },
      ]);
      return { id: doc?.id, x, y };
    });
    console.log(`[vision] created token ${created.id} at (${created.x}, ${created.y})`);

    await page.waitForTimeout(1500);

    // ── CONTROL IT (this is what "when I select them" means) ─────────────
    const controlled = await page.evaluate((id) => {
      const tok = window.canvas.tokens.get(id);
      if (!tok) return { ok: false, reason: 'token placeable not found' };
      tok.control({ releaseOthers: true });
      window.canvas.perception.update({ refreshLighting: true, refreshVision: true });
      return { ok: true, controlled: window.canvas.tokens.controlled.length };
    }, created.id);
    console.log(`[vision] control: ${JSON.stringify(controlled)}`);

    await page.waitForTimeout(2500);

    const state = await readVisionState(page);
    timeline.push({ label: 'noon, token controlled, regions as authored', ...state });
    console.log(
      `[vision] AS AUTHORED: globalActive=${state.globalLight?.active} window=${JSON.stringify(state.globalLight?.darknessWindow)} ` +
        `visible=${state.visibilityGrid?.visibleCount}/${state.visibilityGrid?.total}`
    );
    console.log('[vision] token-vision REPORT verdict: ' + JSON.stringify(state.tokenVisionReport?.verdict, null, 2));
    console.log(
      '[vision] token-vision REPORT visionSources: ' + JSON.stringify(state.tokenVisionReport?.visionSources) +
        ' | controlled: ' + JSON.stringify(state.tokenVisionReport?.controlledTokens?.map((t) => ({
          detectionModesIsArray: t.detectionModesIsArray,
          lightPerceptionPresent: t.lightPerceptionPresent,
          lightPerceptionRange: t.lightPerceptionRange,
        })))
    );

    await page.screenshot({ path: path.join(OUT_DIR, 'token-vision-noon.png') });

    // ── THE DECISIVE CASE: A SCENE WITH NO DARKNESS REGIONS ──────────────
    // This is almost certainly the author's own scene, and it is exactly what
    // the FIRST cut of this fix got wrong: with no region to derive a floor
    // from, it returned {enabled:false} and did nothing at all — reproducing
    // the reported bug verbatim. Temporarily disabling every
    // adjustDarknessLevel behavior simulates that scene shape on the bench.
    // Restored in the same run, unconditionally, below.
    const disabledBehaviorIds = await page.evaluate(async () => {
      const ids = [];
      for (const region of window.canvas.scene.regions) {
        for (const b of region.behaviors) {
          if (b.type === 'adjustDarknessLevel' && !b.disabled) {
            await b.update({ disabled: true });
            ids.push({ regionId: region.id, behaviorId: b.id });
          }
        }
      }
      return ids;
    });
    console.log(`[vision] temporarily disabled ${disabledBehaviorIds.length} adjustDarknessLevel behavior(s)`);

    try {
      await page.waitForTimeout(3000); // let the publish throttle notice the change
      const noRegionState = await readVisionState(page);
      timeline.push({ label: 'noon, token controlled, NO darkness regions', ...noRegionState });
      console.log(
        `[vision] NO REGIONS: globalActive=${noRegionState.globalLight?.active} ` +
          `window=${JSON.stringify(noRegionState.globalLight?.darknessWindow)} ` +
          `minRegionFloor=${JSON.stringify(noRegionState.globalLight?.minRegionFloor)} ` +
          `visible=${noRegionState.visibilityGrid?.visibleCount}/${noRegionState.visibilityGrid?.total}`
      );
      await page.screenshot({ path: path.join(OUT_DIR, 'token-vision-noon-no-regions.png') });
    } finally {
      // RESTORE — the bench scene must never be left altered by a diagnostic.
      const restored = await page.evaluate(async (ids) => {
        let n = 0;
        for (const { regionId, behaviorId } of ids) {
          const region = window.canvas.scene.regions.get(regionId);
          const b = region?.behaviors?.get(behaviorId);
          if (b) {
            await b.update({ disabled: false });
            n++;
          }
        }
        return n;
      }, disabledBehaviorIds);
      console.log(`[vision] restored ${restored}/${disabledBehaviorIds.length} behavior(s)`);
    }

    // ── CLEAN UP: never leave a probe token in the bench scene ───────────
    await page.evaluate(async (id) => {
      try {
        await window.canvas.scene.deleteEmbeddedDocuments('Token', [id]);
      } catch (_) {
        /* best effort */
      }
    }, created.id);

    fs.writeFileSync(
      path.join(OUT_DIR, 'token-vision-noon.json'),
      JSON.stringify({ capturedAt: new Date().toISOString(), created, timeline, consoleErrors }, null, 2)
    );
    console.log(`[vision] wrote ${path.join(OUT_DIR, 'token-vision-noon.json')}`);
  } finally {
    await context.close().catch(() => {});
    await launcher.stop();
  }
});
