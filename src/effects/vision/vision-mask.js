/**
 * THE VISION MASK — slice 2 of "MSA owns vision/fog" (Testament Pillar 11,
 * `docs/planning/Vision-Fog-Ownership.md`). The PURE half: the reveal rule
 * itself, and the mesh-pool reconciliation that will drive its rasterisation.
 *
 * ⚠️ THIS FILE IS THE RULES, AND THE RULES ARE PLAYER-FACING INFORMATION.
 * Testament Law 7: *"Vision/fog is never cached, baked, or approximated…
 * player-facing information gating is sacred."* Everything here is therefore
 * pure and Node-tested — `decideRevealed` is the CPU TWIN of the shader that
 * will consume it, not a restatement of it, so a future change to the shader
 * that diverges from the intended rule fails here rather than silently
 * showing a player something they should not see.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE REVEAL RULE, and why it is shaped like this
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   revealed = insideLOS
 *              AND NOT blinded
 *              AND ( withinSightRadius            // basicSight
 *                    OR (insideLightPolygon AND lit) )   // lightPerception
 *
 * Each clause is a faithful port of a REAL Foundry mechanism, not a design
 * choice (`client/canvas/groups/visibility.mjs#refreshVisibility`,
 * `client/canvas/perception/detection-mode.mjs`):
 *
 * - **`insideLOS`** — Foundry's own wall sweep, CONSUMED as a polygon and
 *   never re-derived. This is the clause that keeps MSA compatible with every
 *   game system: PF2e's rules-based vision, darkness sources, elevation and
 *   wall sense types have all already been applied by the time we see it.
 * - **`blinded`** — Foundry drops a blinded source from its light mask
 *   entirely (`refreshVisibility`'s `!blinded` guard). A blinded token must
 *   not reveal through its own polygons.
 * - **`withinSightRadius`** — `basicSight` is ILLUMINATION-INDEPENDENT by
 *   design: a token sees this far in pitch darkness. That is what darkvision
 *   IS, so this clause must never be gated on brightness.
 * - **`insideLightPolygon AND lit`** — `lightPerception`. Foundry asks "is
 *   this point inside some light source's polygon"; MSA instead asks "is this
 *   pixel actually bright", because MSA already computes that per pixel and
 *   Foundry cannot see it. THAT SUBSTITUTION IS THE WHOLE POINT OF THIS
 *   BUILD — see §3 of the planning doc, and the author's own pixel probe
 *   (MSA illum 0.933 on ground Foundry considered unrevealed).
 *
 * ⚠️ THE SUBSTITUTION IS STRICTLY RICHER THAN FOUNDRY'S MODEL, SO IT CANNOT
 * BE A PERFECT PORT AT THE EDGES. Foundry's test is binary (inside a light
 * polygon or not); ours is a brightness comparison, which additionally
 * respects shadow, time of day, and darkness regions per pixel. Divergence is
 * therefore EXPECTED where a light polygon covers a pixel that is genuinely
 * dark — and there, ours is the answer the author asked for ("really dark
 * outdoor areas should actually block vision"). Any OTHER divergence is a
 * parity bug. `REVEAL_ILLUMINATION_THRESHOLD` is a rules-visible number, not
 * a taste knob: it is deliberately low so the common cases match Foundry.
 *
 * @module effects/vision/vision-mask
 */

/**
 * How bright a pixel must be for light-perception to reveal it, 0..1 against
 * MSA's own illumination buffer.
 *
 * ⚠️ CALIBRATED AGAINST REAL MEASUREMENTS, not picked. From the author's own
 * pixel probe on the reported scene: open ground in noon daylight read
 * `illum` **0.933–0.945**, and a point inside a torch's bright radius read
 * **1.0**. MSA's night/darkness floor sits far below both. 0.08 therefore
 * sits comfortably under every genuinely-lit case while staying above an
 * unlit night floor, so "lit" means lit rather than "not perfectly black".
 *
 * Deliberately NOT zero: at zero every pixel inside the LOS polygon reveals,
 * which is the universal-reveal behaviour the author explicitly rejected
 * ("we don't want to universally reveal everything outdoors").
 */
export const REVEAL_ILLUMINATION_THRESHOLD = 0.08;

/**
 * THE NIGHT FLOOR (two-client QA pass, 2026-11-11, mmp-tye.1). The 0.08 above assumed the unlit night floor
 * "sits far below" it. Measured on an open map at darkness 0.9 the unlit ground reads `illum` 0.19 with no
 * moonlight and 0.26-0.45 with it (ambient + sky fill + moon share one buffer), so with unlimited light
 * perception and no walls EVERY pixel passed and a player saw the whole map at night while Foundry itself
 * said it was dark. At night, light-perception must see only pixels that are brighter than any unlit floor:
 * above the highest unlit value measured (0.45), with margin.
 *
 * Costs the outer fringe of a light's dim radius (it fades into the floor), and only ever shows a player
 * LESS - the fail-safe direction. Global illumination ON means the ambient IS lit (Foundry parity), so
 * the floor is off then, and the ramp keeps dusk and day exactly as calibrated.
 */
export const NIGHT_REVEAL_FLOOR = 0.55;
/** Scene darkness at which the night floor starts to apply, and where it is fully on. */
export const NIGHT_REVEAL_DARKNESS_FROM = 0.5;
export const NIGHT_REVEAL_DARKNESS_TO = 0.7;

/**
 * The extra illumination floor light-perception needs this frame. Pure; the viewer feeds it to the reveal
 * shader's shared uniform and `decideRevealed` takes the same number, so CPU and GPU cannot disagree.
 * @param {object} args
 * @param {number} args.darkness01 - the scene's darkness, 0 (day) to 1 (night).
 * @param {number} [args.globalLightFloorMax=0] - the global-illumination floor's brightest channel; > 0 means
 *   Foundry's global light is lighting the ambient, which therefore counts as lit.
 * @returns {number} 0 (no extra floor) .. NIGHT_REVEAL_FLOOR
 */
export function nightRevealFloor({ darkness01, globalLightFloorMax = 0 } = {}) {
  if (Number.isFinite(globalLightFloorMax) && globalLightFloorMax > 0.001) return 0;
  const d = Number.isFinite(darkness01) ? darkness01 : 0;
  const t = Math.min(
    1,
    Math.max(0, (d - NIGHT_REVEAL_DARKNESS_FROM) / (NIGHT_REVEAL_DARKNESS_TO - NIGHT_REVEAL_DARKNESS_FROM))
  );
  return NIGHT_REVEAL_FLOOR * t;
}

/**
 * How brightly the "explored, not currently visible" memory zone shows —
 * 0..1, multiplying the remembered map-only colour (`vision-mask-render.js`'s
 * `exploredSnapshotTarget`). A taste knob, not a rules-visible number the way
 * `REVEAL_ILLUMINATION_THRESHOLD` is: it never changes what a player CAN see,
 * only how brightly the memory of what they already saw is rendered. Picked
 * to read clearly as "remembered, not live" without going so dark the map
 * layout becomes illegible — Foundry's own default explored-fog alpha sits
 * in the same neighbourhood.
 */
export const EXPLORED_DIM_FACTOR = 0.35;

/**
 * A literal, hand-bumped string identifying which cut of the reveal RULE is
 * live — mirrors `boot.js`'s own `probeBuildTag` convention (the pixel
 * probe's "is my fix even loaded" fix). Bumped every time `decideRevealed`'s
 * actual logic changes, and reported from BOTH `foundry/vision-diagnostics.js`
 * and the viewer's `getVisionMaskInfo` so the two can never silently drift
 * into reporting two different tags for the SAME running build
 * (`feedback_one_field_two_registries`'s own shape, avoided by having exactly
 * ONE definition both readers import rather than two hand-typed copies).
 *
 * Exists because a report proving "the rasteriser is running" (pool size,
 * mesh count) is NOT the same claim as "the CURRENT gate logic is running" —
 * the rasteriser's own numbers look identical whether the gate material
 * unions or intersects its inputs, and ES modules cache aggressively enough
 * that "I just refreshed and retested" is not reliable proof of which build
 * actually executed.
 */
export const VISION_GATE_BUILD_TAG = 'r2-union-not-intersection-2026-08-15';

/**
 * THE CPU TWIN of the reveal shader. Pure, total, and the single definition
 * of the rule — see this module's header for each clause's Foundry origin.
 *
 * @param {object} args
 * @param {boolean} args.insideLos - is the pixel inside this source's wall-swept LOS polygon?
 * @param {boolean} args.insideLightPolygon - inside its light-perception polygon?
 * @param {number} args.distance - world-space distance from the source origin to the pixel.
 * @param {number} args.sightRadius - `basicSight` radius in the same units (0 = none).
 * @param {number} args.lightRadius - `lightPerception` radius; `Infinity` is legitimate and common.
 * @param {number} args.illumination - MSA's own 0..1 brightness at this pixel.
 * @param {boolean} [args.blinded=false]
 * @param {number} [args.threshold=REVEAL_ILLUMINATION_THRESHOLD]
 * @param {number} [args.nightFloor=0] - `nightRevealFloor(...)` for this frame: a pixel outside every lit shape
 *   must be brighter than this to count as lit.
 * @param {boolean} [args.insideLitShape=true] - inside an active light source's shape (mask A); `true` by default
 *   so a caller that has no light geometry keeps the rule as it was calibrated.
 * @returns {boolean}
 */
export function decideRevealed({
  insideSightPolygon,
  insideLightPolygon,
  illumination,
  blinded = false,
  threshold = REVEAL_ILLUMINATION_THRESHOLD,
  nightFloor = 0,
  insideLitShape = true,
}) {
  // A blinded source reveals nothing at all — Foundry's own `!blinded` guard.
  if (blinded) return false;

  // ⚠️ THE TWO POLYGONS ARE UNIONED, **NOT** INTERSECTED — and getting this
  // backwards is what made the first live build black out the entire map.
  //
  // Both polygons are ALREADY wall-clipped by Foundry's own sweep, and each is
  // ALREADY bounded by its own radius. There is no third, separate
  // "line of sight" polygon to intersect them against:
  //   `visionSource.shape` is the FOV, bounded by `sight.range`
  //   `visionSource.light` is light perception, bounded by `lightRadius`
  // Foundry composites them as `vision.sight ∪ (vision.light ∩ mask)`
  // (`CanvasVisibility#refreshVisibility`), so this must too.
  //
  // The bug that proved it: a token with NO darkvision has `sight.range = 0`,
  // and `PointEffectSource#_getPolygonConfiguration` builds its polygon at
  // `radius: 0` — so `.shape` is a DEGENERATE speck the size of the token.
  // ANDing against that revealed only the token's own square and blacked out
  // the whole scene, which is exactly what the author saw.
  if (insideSightPolygon) return true; // darkvision: illumination-INDEPENDENT

  // lightPerception: the polygon is already range- and wall-limited, so the
  // only extra question is whether the pixel is actually bright.
  if (!insideLightPolygon) return false;
  const lum = Number.isFinite(illumination) ? illumination : 0;
  // Bright enough, AND lit: inside a light source's shape (Foundry's own geometric answer, mask A) or brighter
  // than the night floor (lights MSA draws that Foundry has no source for). By day / with global light the
  // floor is 0, so the second clause is true and this is the rule exactly as it was calibrated.
  if (!(lum >= threshold)) return false;
  return insideLitShape === true || lum >= (Number.isFinite(nightFloor) ? nightFloor : 0);
}

/**
 * Decide which per-source meshes to create, keep and drop for this frame.
 *
 * ⚠️ EXISTS BECAUSE A POOL THAT ONLY EVER GROWS IS A GPU LEAK, and vision
 * sources churn constantly — every token selection, every movement, every
 * `refreshVision` recreates them. `drop` is what the caller disposes;
 * returning it (rather than letting the caller diff) keeps the "what happened
 * to the meshes I am no longer drawing" question answerable in one place.
 *
 * Order of `keep`/`create` follows the incoming source order so the caller's
 * draw order is stable frame to frame — an unstable order is what made
 * vegetation flicker once already (`keyhole-depth-authority-design`).
 *
 * @param {Array<{sourceId: string}>} sources - this frame's live vision sources.
 * @param {Iterable<string>} existingKeys - keys currently held in the pool.
 * @returns {{create: string[], keep: string[], drop: string[]}}
 */
export function reconcileVisionMeshPool(sources, existingKeys) {
  const existing = new Set(existingKeys ?? []);
  const create = [];
  const keep = [];
  const seen = new Set();
  for (const s of Array.isArray(sources) ? sources : []) {
    const id = s?.sourceId;
    if (typeof id !== 'string' || id.length === 0) continue;
    // A duplicate id in one frame must not produce two meshes for one source
    // (and must not have the second occurrence silently "drop" the first).
    if (seen.has(id)) continue;
    seen.add(id);
    if (existing.has(id)) keep.push(id);
    else create.push(id);
  }
  const drop = [];
  for (const id of existing) if (!seen.has(id)) drop.push(id);
  return { create, keep, drop };
}

/**
 * Should MSA's fog gate the view at all this frame, and with what sources?
 *
 * ⚠️ THE FAIL-CLOSED HALF IS THE POINT. If the vision read FAILED (as opposed
 * to legitimately returning zero sources), a non-GM must NOT be handed an
 * ungated view — that is a secrets leak, mission priority #2. A GM, by
 * contrast, is exactly who Foundry itself shows everything to when nothing is
 * selected (`CanvasVisibility#refresh`), so for them "no sources" means "no
 * fog" and that is correct, not a leak.
 *
 * @param {object} args
 * @param {number} args.sourceCount @param {boolean} args.isGM
 * @param {boolean} args.readFailed - the reader reported it could not read.
 * @returns {{gate: boolean, reason: string}}
 */
export function decideFogGating({ sourceCount, isGM, readFailed }) {
  if (readFailed && !isGM) {
    return { gate: true, reason: 'vision read FAILED for a non-GM — gating closed rather than risk revealing the map' };
  }
  if (sourceCount > 0) return { gate: true, reason: 'active vision sources present' };
  if (!isGM) return { gate: true, reason: 'non-GM with no vision source — never an unguarded view' };
  return { gate: false, reason: 'GM with no controlled vision source — Foundry shows everything here too' };
}
