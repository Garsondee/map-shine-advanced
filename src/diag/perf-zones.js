/**
 * perf-zones.js — THE ZONE TAXONOMY, as data.
 *
 * A "zone" is a named bracket around a piece of per-frame work that the profiler
 * can time independently. This file declares the sub-pass zones and nothing else:
 * pure data, pure validators, zero imports. The report brain, the profiler and
 * the HUD all read it; none of them owns it.
 *
 * ============================================================================
 * WHY THIS IS DATA AND NOT A PILE OF STRING LITERALS AT THE CALL SITES
 * ============================================================================
 *
 * The same reason `graph/passes.js` declares the pass list as data: a taxonomy
 * that lives only as literals sprinkled through `vt-pan-viewer.js` cannot be
 * validated, cannot be enumerated for a HUD, and cannot tell you that a zone you
 * are reporting on no longer has a call site. Declared here, every one of those
 * becomes a Node test.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY *NOT* HERE (read before adding to this list)
 * ============================================================================
 *
 * PASS-LEVEL ZONES ARE DERIVED, NEVER DECLARED. `runPassPlan` hands the profiler
 * each live pass id from `framePlan.ids`, and the profiler synthesises
 * `pass.<id>` on the fly ({@link PASS_ZONE_PREFIX}). Writing the seven current
 * pass ids into this file would create a SECOND hand-kept copy of the frame
 * order — exactly the drift `graph/passes.js` exists to prevent, and the thing
 * this repo has already paid for three times over (mode forks, hand-kept health
 * models, the harvest manifest). A pass going live later is instrumented free.
 *
 * NO LINE NUMBERS IN THE `site` FIELD. They rot the instant anyone edits above
 * them — proven inside this very session: a nine-line comment correction in
 * `vt-pan-viewer.js` shifted every line after it by nine, invalidating a fresh
 * set of citations minutes after they were written. Function names are
 * greppable and survive edits; line numbers are a lie with a timestamp.
 *
 * ============================================================================
 * THE FIELDS
 * ============================================================================
 *
 * `kind` — what the zone CONTAINS, which decides what can honestly be reported:
 *   'cpu'  — no draw calls inside. `gpuMs` is null BY DECLARATION, not by
 *            failure to measure. The report must render those two differently:
 *            "this zone has no GPU work" is a fact, "we could not measure it"
 *            is a gap (feedback_instruments_must_not_lie).
 *   'gpu'  — wraps one or more `renderer.render()` / quad draws. Both the CPU
 *            encode cost and the GPU execution cost are meaningful.
 *   'both' — substantial CPU work AND draws, worth reporting as two numbers.
 *
 * `cadence` — how often it runs, which decides how it may be SUMMARISED:
 *   'steady'      — every frame. A median is meaningful.
 *   'conditional' — every frame the feature is on. A median over frames where it
 *                   ran is meaningful; a median over all frames is not.
 *   'bake'        — rarely, on a version/mask change. A median is ~always 0 and
 *                   is a LIE. Report occurrence rate + peak + amortised.
 *   'event'       — off the render loop entirely (residency, decode, upload).
 *                   Same treatment as 'bake', plus it must never be summed into
 *                   a frame total.
 *
 * `detail` — measured always, but collapsed in the default report unless it is
 * significant. Two clock reads are cheap; a 52-row table nobody reads is not.
 * Measure generously, report selectively.
 *
 * `ownerEffectId` — the effect manifest id this zone's cost belongs to, or null
 * for engine work owned by no single effect. See {@link EFFECT_ZONING} for the
 * effects that CANNOT be fully attributed this way and why.
 *
 * @module diag/perf-zones
 */

/** Prefix for the pass-level zones the profiler synthesises from `framePlan.ids`. */
export const PASS_ZONE_PREFIX = 'pass.';

/** @type {ReadonlyArray<'cpu'|'gpu'|'both'>} */
export const ZONE_KINDS = Object.freeze(['cpu', 'gpu', 'both']);

/** @type {ReadonlyArray<'steady'|'conditional'|'bake'|'event'>} */
export const ZONE_CADENCES = Object.freeze(['steady', 'conditional', 'bake', 'event']);

/** Cadences whose cost is NOT a per-frame cost — a median over all frames misreports them. */
export const SPARSE_CADENCES = Object.freeze(['bake', 'event']);

/**
 * The frame budget the report renders verdicts against. 8.33 ms = 120 Hz, which
 * is what `diag/perf-lab.js`'s sweep UI already judges against — one number, so
 * two instruments cannot disagree about what "over budget" means.
 */
export const FRAME_BUDGET_MS = 8.33;

/**
 * Per-pass budgets (ms), keyed to REAL pass ids from `graph/passes.js`.
 *
 * The shape is harvested from the deleted `graph/v3-perf.js`; the keys are not.
 * That file's table was keyed to `streaming`/`unifiedGeometry`/`effects` —
 * stage names matching nothing in this codebase's own `STAGES` — so every lookup
 * silently fell through to a default and the "budget" was decorative. Keys here
 * are validated against the live pass list by `validateZoneTaxonomy`.
 *
 * These are TARGETS TO BE REVISED AGAINST MEASUREMENT. The point is that a
 * number exists to compare against, not that the number is currently right.
 * @type {Record<string, number>}
 */
export const PASS_BUDGETS_MS = Object.freeze({
  'masks.occlusion': 0.4,
  'geometry.world': 1.6,
  'light.accumulate': 2.6,
  'surface.response': 1.0,
  'surface.particles': 0.5,
  'post.bloom': 1.2,
  'present.composite': 0.6,
});

/** Budget for a pass not in {@link PASS_BUDGETS_MS} (a newly-live pass defaults strict). */
export const DEFAULT_PASS_BUDGET_MS = 0.5;

/**
 * @typedef {object} ZoneDecl
 * @property {string} id             stable, dotted, `<stage-ish>.<what>`
 * @property {string} label          human, for the HUD and the report
 * @property {string} stage          a `STAGES` entry from graph/passes.js
 * @property {string|null} pass      the enclosing live pass id, or null if pre-plan/off-loop
 * @property {string|null} ownerEffectId  effect manifest id, or null for engine work
 * @property {'cpu'|'gpu'|'both'} kind
 * @property {'steady'|'conditional'|'bake'|'event'} cadence
 * @property {boolean} detail        collapse in the default report unless significant
 * @property {string} site           the FUNCTION that runs it — greppable, unlike a line number
 */

/**
 * Every zone, in rough frame order. Order here is presentational only — the
 * profiler indexes by id and the report sorts by measured cost.
 * @type {ReadonlyArray<ZoneDecl>}
 */
export const ZONES = Object.freeze(
  [
    // ---- frame stage: pre-plan CPU ticks in renderFrame ----------------------
    z('tick.continuousInputs', 'Input easing', 'frame', null, null, 'cpu', 'steady', true, 'updateContinuousInputs'),
    z('tick.tokenSync', 'Token placement sync', 'frame', null, null, 'cpu', 'steady', false, 'syncTokenPlacements'),
    z('tick.doorSync', 'Door graphics sync', 'frame', null, 'doorGraphics', 'cpu', 'steady', false, 'syncDoorGraphics'),
    z('tick.envSnapshot', 'Environment snapshot', 'frame', null, null, 'cpu', 'steady', true, 'updateEnvSnapshot'),
    z(
      'tick.windRebakePoll',
      'Wind rebake poll',
      'frame',
      null,
      null,
      'cpu',
      'bake',
      true,
      'pollMaskAuthorityForWindRebake'
    ),
    z('tick.camera', 'Camera derive', 'frame', null, null, 'cpu', 'steady', true, 'updateCamera'),

    // ---- sims stage: out of framePlan's range, driven directly ---------------
    z('sims.wind', 'Wind sim', 'sims', null, null, 'both', 'conditional', false, 'tickWindSim'),
    z('sims.fluid', 'Fluid sim', 'sims', null, 'fluid', 'both', 'conditional', false, 'tickFluidSim'),
    z(
      'sims.particlesDust',
      'Dust particle step',
      'sims',
      null,
      null,
      'both',
      'conditional',
      false,
      'particleEngine.step'
    ),
    z('sims.particlesGusts', 'Gust ribbon step', 'sims', null, null, 'both', 'conditional', false, 'gustEngine.step'),

    // ---- masks.occlusion -----------------------------------------------------
    z(
      'masks.occlusionSync',
      'Occlusion disc reconcile',
      'masks',
      'masks.occlusion',
      null,
      'cpu',
      'steady',
      true,
      'runMaskOcclusionPass'
    ),
    z(
      'masks.occlusionDraw',
      'Occlusion mask draw',
      'masks',
      'masks.occlusion',
      null,
      'gpu',
      'steady',
      false,
      'runMaskOcclusionPass'
    ),

    // ---- geometry.world ------------------------------------------------------
    z(
      'geometry.worldDraw',
      'World scene draw',
      'geometry',
      'geometry.world',
      null,
      'gpu',
      'steady',
      false,
      'runGeometryWorldPass'
    ),
    z(
      'geometry.doorDraw',
      'Door graphics draw',
      'geometry',
      'geometry.world',
      'doorGraphics',
      'gpu',
      'conditional',
      false,
      'renderDoorGraphicsInto'
    ),

    // ---- light.accumulate: ten CPU syncs and seven draws in ONE plan pass -----
    // This is the whole reason pass-level timing alone is not enough.
    z(
      'light.ambient',
      'Ambient + global floor',
      'lighting',
      'light.accumulate',
      null,
      'cpu',
      'steady',
      true,
      'runLightAccumulatePass'
    ),
    z(
      'light.sunShadowBake',
      'Sun shadow bake',
      'lighting',
      'light.accumulate',
      'sunShadows',
      'both',
      'bake',
      false,
      'sunShadows.maybeBake'
    ),
    z(
      'light.waterBodyBake',
      'Water body pack bake',
      'lighting',
      'light.accumulate',
      'water',
      'both',
      'bake',
      false,
      'waterBody.maybeBake'
    ),
    z(
      'light.waterSurfaceSync',
      'Water surface sync',
      'lighting',
      'light.accumulate',
      'water',
      'cpu',
      'steady',
      true,
      'waterSurface.sync'
    ),
    z(
      'light.fluidSurfaceSync',
      'Fluid surface sync',
      'lighting',
      'light.accumulate',
      'fluid',
      'cpu',
      'steady',
      true,
      'fluidSurface.sync'
    ),
    z(
      'light.regionSetup',
      'Darkness region read',
      'lighting',
      'light.accumulate',
      null,
      'cpu',
      'steady',
      false,
      'readElevationFilteredDarknessRegions'
    ),
    z(
      'light.pointLightUpdate',
      'Point light pool update',
      'lighting',
      'light.accumulate',
      null,
      'cpu',
      'steady',
      false,
      'pointLights.update'
    ),
    z(
      'light.candleSync',
      'Candle flame sync',
      'lighting',
      'light.accumulate',
      'candleFlame',
      'cpu',
      'conditional',
      true,
      'updateCandleFlame'
    ),
    z(
      'light.lightningSync',
      'Lightning sync',
      'lighting',
      'light.accumulate',
      'lightning',
      'cpu',
      'conditional',
      true,
      'lightningSubsystem.sync'
    ),
    z(
      'light.vegetationSync',
      'Vegetation motion sync',
      'lighting',
      'light.accumulate',
      'vegetation',
      'cpu',
      'steady',
      false,
      'syncAllVegetationMotionForFrame'
    ),
    z(
      'light.windOverlaySync',
      'Wind overlay sync',
      'lighting',
      'light.accumulate',
      null,
      'cpu',
      'conditional',
      true,
      'updateWindFieldOverlay'
    ),
    z(
      'light.uiShadowStamps',
      'UI shadow stamps',
      'lighting',
      'light.accumulate',
      'uiWindowShadow',
      'cpu',
      'steady',
      false,
      'updateUiShadowStamps'
    ),
    z(
      'light.drawIllum',
      'Illumination fill',
      'lighting',
      'light.accumulate',
      null,
      'gpu',
      'steady',
      false,
      'illumQuad.render'
    ),
    z(
      'light.drawRegions',
      'Darkness region draw',
      'lighting',
      'light.accumulate',
      null,
      'gpu',
      'conditional',
      false,
      'runLightAccumulatePass'
    ),
    z(
      'light.drawPointLights',
      'Point light draw',
      'lighting',
      'light.accumulate',
      null,
      'gpu',
      'steady',
      false,
      'pointLights.lightScene'
    ),
    z(
      'light.drawWindowLight',
      'Window light draw',
      'lighting',
      'light.accumulate',
      'window',
      'gpu',
      'conditional',
      false,
      'windowSurface.scene'
    ),
    z(
      'light.drawColoration',
      'Coloration draw',
      'lighting',
      'light.accumulate',
      null,
      'gpu',
      'steady',
      false,
      'pointLights.colorationScene'
    ),
    z(
      'light.drawComposite',
      'Lit composite',
      'lighting',
      'light.accumulate',
      null,
      'gpu',
      'steady',
      false,
      'compositeQuad.render'
    ),
    z(
      'light.drawCandleFlame',
      'Candle flame draw',
      'lighting',
      'light.accumulate',
      'candleFlame',
      'gpu',
      'conditional',
      false,
      'candleFlameScene'
    ),
    z(
      'light.drawLightning',
      'Lightning bolt draw',
      'lighting',
      'light.accumulate',
      'lightning',
      'gpu',
      'conditional',
      false,
      'lightningSubsystem.scene'
    ),
    z(
      'light.drawWindOverlay',
      'Wind overlay draw',
      'lighting',
      'light.accumulate',
      null,
      'gpu',
      'conditional',
      true,
      'windOverlayScene'
    ),

    // ---- surface stage -------------------------------------------------------
    z(
      'surface.specularDraw',
      'Specular response',
      'surface',
      'surface.response',
      'specular',
      'gpu',
      'conditional',
      false,
      'runSurfaceResponsePass'
    ),
    z(
      'surface.drawDust',
      'Dust particle draw',
      'surface',
      'surface.particles',
      null,
      'gpu',
      'conditional',
      false,
      'particleEngine.scene'
    ),
    z(
      'surface.drawGusts',
      'Gust ribbon draw',
      'surface',
      'surface.particles',
      null,
      'gpu',
      'conditional',
      false,
      'gustEngine.scene'
    ),

    // ---- post.bloom: 11 draws, 5 zones. A mip chain is ONE decision, not four.
    z(
      'bloom.uniformPush',
      'Bloom uniform push',
      'post',
      'post.bloom',
      'bloom',
      'cpu',
      'conditional',
      true,
      'runPostBloomPass'
    ),
    z(
      'bloom.bright',
      'Bloom bright pass',
      'post',
      'post.bloom',
      'bloom',
      'gpu',
      'conditional',
      false,
      'bloomBrightQuad.render'
    ),
    z(
      'bloom.downsample',
      'Bloom downsample chain',
      'post',
      'post.bloom',
      'bloom',
      'gpu',
      'conditional',
      false,
      'bloomDownQuad.render'
    ),
    z(
      'bloom.upsampleCore',
      'Bloom upsample (core)',
      'post',
      'post.bloom',
      'bloom',
      'gpu',
      'conditional',
      false,
      'bloomUpQuad.render'
    ),
    z(
      'bloom.upsampleAtmo',
      'Bloom upsample (atmosphere)',
      'post',
      'post.bloom',
      'bloom',
      'gpu',
      'conditional',
      false,
      'bloomUpQuad.render'
    ),
    z(
      'bloom.composite',
      'Bloom composite',
      'post',
      'post.bloom',
      'bloom',
      'gpu',
      'conditional',
      false,
      'bloomCompositeQuad.render'
    ),

    // ---- present -------------------------------------------------------------
    // ownerEffectId is null on purpose: the blit happens whether or not `grade`
    // is on — grade folds INTO this shader rather than adding a pass. See
    // EFFECT_ZONING.grade.
    z(
      'present.blit',
      'Present composite',
      'present',
      'present.composite',
      null,
      'gpu',
      'steady',
      false,
      'runPresentCompositePass'
    ),

    // ---- residency: off the render loop. NEVER summed into a frame total. -----
    z('residency.pass', 'Residency update', 'residency', null, null, 'cpu', 'event', false, 'scheduleResidencyUpdate'),
    z('residency.decode', 'Page decode', 'residency', null, null, 'cpu', 'event', false, 'requestDecodeUpload'),
    z('residency.upload', 'Page upload', 'residency', null, null, 'cpu', 'event', false, 'requestDecodeUpload'),
  ].map(Object.freeze)
);

/**
 * Effects whose cost CANNOT be fully attributed to zones, and the reason — so
 * the report can print the reason instead of a zero.
 *
 * This is the honest half of "the performance cost of every effect". An effect
 * that draws inside a scene somebody else renders has no bracket of its own; the
 * only instrument that can see it is the off/on sweep. Saying so is the whole
 * difference between a breakdown and a guess.
 *
 * `coverage`: 'full' — every cost site is a zone.
 *             'partial' — some sites are zoned, at least one is not.
 *             'none' — no zone can isolate it; sweep-only.
 * @type {Readonly<Record<string, {coverage:'full'|'partial'|'none', why:string}>>}
 */
export const EFFECT_ZONING = Object.freeze({
  grade: Object.freeze({
    coverage: 'none',
    why: 'Folded into the present composite shader (gradePresent) rather than adding a pass, so present.blit costs the same whether grade is on or off. Sweep-only.',
  }),
  vegetation: Object.freeze({
    coverage: 'partial',
    why: "Its per-frame uniform sync is zoned (light.vegetationSync), but the meshes draw inside geometry.world's shared scene in the one flat sort list — no render call of its own to bracket.",
  }),
  water: Object.freeze({
    coverage: 'partial',
    why: 'The JFA body bake and the surface sync are zoned, but the tier-0 surface is a drawable at renderOrder 0.5 inside geometry.world (surface.water is still a seam), so its draw cost cannot be separated.',
  }),
  uiWindowShadow: Object.freeze({
    coverage: 'full',
    why: 'Uniform push only — it has no draw call at all by design (the v6 perf fix removed the extra pass), so light.uiShadowStamps IS its entire cost.',
  }),
});

/** id -> ZoneDecl. Built once. */
const BY_ID = new Map(ZONES.map((zone) => [zone.id, zone]));
/** id -> dense integer index, so the hot path never hashes a string. */
const INDEX_BY_ID = new Map(ZONES.map((zone, i) => [zone.id, i]));

/** @param {string} id @returns {ZoneDecl|null} */
export function zoneById(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Dense index for the profiler's typed-array accumulators. `-1` for an unknown
 * id — the caller decides whether that is a throw or a counted anomaly; this
 * function does not guess.
 * @param {string} id @returns {number}
 */
export function zoneIndexOf(id) {
  const i = INDEX_BY_ID.get(id);
  return i === undefined ? -1 : i;
}

/** Zones enclosed by a given live pass id, in declaration order. */
export function zonesForPass(passId) {
  return ZONES.filter((zone) => zone.pass === passId);
}

/** True for a cadence whose cost must never be summarised as a per-frame median. */
export function isSparseCadence(cadence) {
  return SPARSE_CADENCES.includes(cadence);
}

/**
 * Validate the taxonomy against the live pass graph and effect registry.
 *
 * Injected rather than imported so this module stays dependency-free and the
 * test supplies the real `PASSES`/`STAGES` from `graph/index.js` — the same
 * injection posture every other instrument here uses.
 *
 * @param {ReadonlyArray<ZoneDecl>} zones
 * @param {{passIds: string[], stages: string[], effectIds: string[]}} live
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateZoneTaxonomy(zones, { passIds = [], stages = [], effectIds = [] } = {}) {
  const errors = [];
  const seen = new Set();
  const passSet = new Set(passIds);
  const stageSet = new Set(stages);
  const effectSet = new Set(effectIds);

  for (const zone of zones) {
    const at = `zone '${zone?.id ?? '(missing id)'}'`;
    if (!zone || typeof zone.id !== 'string' || zone.id.length === 0) {
      errors.push(`${at}: id must be a non-empty string`);
      continue;
    }
    if (seen.has(zone.id)) errors.push(`${at}: duplicate id`);
    seen.add(zone.id);

    if (zone.id.startsWith(PASS_ZONE_PREFIX)) {
      errors.push(
        `${at}: ids may not start with '${PASS_ZONE_PREFIX}' — that namespace belongs to the pass-level ` +
          `zones derived from framePlan.ids at runtime. Declaring one here would be a second hand-kept ` +
          `copy of the frame order (see this file's header).`
      );
    }
    if (typeof zone.label !== 'string' || zone.label.length === 0) errors.push(`${at}: label required`);
    if (typeof zone.site !== 'string' || zone.site.length === 0) errors.push(`${at}: site required`);
    if (/:\d+/.test(zone.site)) {
      errors.push(`${at}: site '${zone.site}' looks like a line number. Name the FUNCTION — line numbers rot.`);
    }
    if (!ZONE_KINDS.includes(zone.kind)) errors.push(`${at}: kind '${zone.kind}' not one of ${ZONE_KINDS.join('|')}`);
    if (!ZONE_CADENCES.includes(zone.cadence)) {
      errors.push(`${at}: cadence '${zone.cadence}' not one of ${ZONE_CADENCES.join('|')}`);
    }
    if (typeof zone.detail !== 'boolean') errors.push(`${at}: detail must be a boolean`);

    if (stageSet.size > 0 && !stageSet.has(zone.stage)) {
      errors.push(`${at}: stage '${zone.stage}' is not a STAGES entry in graph/passes.js`);
    }
    if (zone.pass !== null) {
      if (passSet.size > 0 && !passSet.has(zone.pass)) {
        errors.push(`${at}: pass '${zone.pass}' is not a live pass id in graph/passes.js`);
      }
    }
    if (zone.ownerEffectId !== null && effectSet.size > 0 && !effectSet.has(zone.ownerEffectId)) {
      errors.push(`${at}: ownerEffectId '${zone.ownerEffectId}' is not a registered effect manifest id`);
    }
    // A 'cpu' zone reporting GPU time would be reporting something it declared
    // it does not contain. Caught here rather than left to the report.
    if (zone.kind === 'cpu' && zone.pass === null && zone.stage === 'post') {
      errors.push(`${at}: a cpu-only zone in the post stage with no enclosing pass is almost certainly a typo`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate {@link EFFECT_ZONING} against the taxonomy: a 'full' claim must have
 * at least one zone, and a 'none' claim must have none. An entry that drifts out
 * of step with the zones is a report that confidently explains an absence that
 * is no longer there.
 */
export function validateEffectZoning(zoning, zones) {
  const errors = [];
  const owned = new Set(zones.map((zone) => zone.ownerEffectId).filter(Boolean));
  for (const [id, decl] of Object.entries(zoning)) {
    if (!['full', 'partial', 'none'].includes(decl.coverage)) {
      errors.push(`EFFECT_ZONING['${id}']: coverage '${decl.coverage}' not one of full|partial|none`);
    }
    if (typeof decl.why !== 'string' || decl.why.length < 40) {
      errors.push(`EFFECT_ZONING['${id}']: 'why' must actually explain — a reader hits this instead of a number`);
    }
    if (decl.coverage === 'none' && owned.has(id)) {
      errors.push(`EFFECT_ZONING['${id}']: claims coverage 'none' but owns at least one zone`);
    }
    if (decl.coverage !== 'none' && !owned.has(id)) {
      errors.push(`EFFECT_ZONING['${id}']: claims coverage '${decl.coverage}' but owns no zone`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Terse constructor so the table above reads as a table. */
function z(id, label, stage, pass, ownerEffectId, kind, cadence, detail, site) {
  return { id, label, stage, pass, ownerEffectId, kind, cadence, detail, site };
}
