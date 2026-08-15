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
 * @returns {boolean}
 */
export function decideRevealed({
  insideLos,
  insideLightPolygon,
  distance,
  sightRadius,
  lightRadius,
  illumination,
  blinded = false,
  threshold = REVEAL_ILLUMINATION_THRESHOLD,
}) {
  // Walls first: nothing outside line of sight is ever revealed, by any route.
  if (!insideLos) return false;
  // A blinded source reveals nothing at all — Foundry's own `!blinded` guard.
  if (blinded) return false;

  const d = Number.isFinite(distance) ? distance : Infinity;

  // basicSight — illumination-INDEPENDENT. This is darkvision; gating it on
  // brightness would delete the feature from every creature that has it.
  const sr = Number.isFinite(sightRadius) ? sightRadius : sightRadius === Infinity ? Infinity : 0;
  if (sr > 0 && d <= sr) return true;

  // lightPerception — bounded by its own radius (Infinity by default), and
  // gated on ACTUAL brightness rather than Foundry's binary in-a-light-polygon.
  if (!insideLightPolygon) return false;
  const lr = lightRadius === Infinity ? Infinity : Number.isFinite(lightRadius) ? lightRadius : 0;
  if (!(lr > 0) || d > lr) return false;
  const lum = Number.isFinite(illumination) ? illumination : 0;
  return lum >= threshold;
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
