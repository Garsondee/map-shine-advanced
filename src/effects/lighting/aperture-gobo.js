/**
 * APERTURE GOBO — a procedural window pattern, shaped by one point light and
 * cast through a Foundry wall's own aperture. `docs/planning/Aperture-Gobo.md`
 * is the design this implements; read it first — this file assumes its
 * vocabulary (wall-plane `s`/`x`, the light's own frame) without re-deriving
 * it.
 *
 * ============================================================================
 * DESIGN 4 — MULLIONS AS BLOCKERS, NOT A PROJECTED IMAGE (REWRITTEN 2026-08-03)
 * ============================================================================
 * Designs 1-3 (still the live history in `docs/planning/Aperture-Gobo.md`
 * §13, and in `aperture-gobo-render.js`'s own header) fixed WHERE the effect
 * blends and WHEN it's visible. This rewrite replaces WHAT it computes.
 *
 * The old model treated the whole pattern as a single continuous image,
 * authored in a virtual window-plane `(s_w, z)` coordinate, projected onto
 * the floor via an inverse map and rescaled per-axis by a Jacobian
 * (`magAlong`/`magPerp`) so a window-space distance could be compared against
 * a floor-space blur radius. That Jacobian is exact but UNBOUNDED — an
 * ordinary torch-to-window distance already sends it into the tens, which is
 * why `MAX_MAGNIFICATION` existed at all — and even capped, five live rounds
 * never once produced a pattern that read as a clean pane grid, only smeared
 * fields and misaligned blobs.
 *
 * The author's own reframing (verified against the vendored Foundry source
 * before acting on it, not assumed): `light.shapePoints` (`foundry/scene-
 * lights.js`) is Foundry's OWN wall-clipped polygon, and `Edge#applyThreshold`
 * (`clockwise-sweep.mjs`) confirms a `light:PROXIMITY` wall is genuinely
 * passable to a light source within `threshold.light` of it — which an
 * interior lamp near its own window always is. So the beam's OUTER shape
 * (bounded by the solid walls either side of the window) is not something
 * this file has ever needed to compute: Foundry's own polygon sweep already
 * produces it, for free, before this effect's mesh is even built. What
 * remains is genuinely simple: punch mullion-shaped NOTCHES into a beam whose
 * outer boundary was never this file's problem to solve.
 *
 * THE NEW MODEL — every vertical mullion is an ANGULAR blocker; every
 * horizontal mullion (plus sill/head) is a RADIAL one:
 *   - A vertical bar at wall-position `s` subtends a FIXED angular sliver
 *     from the light, at every distance — a floor point is blocked by it iff
 *     its own inverse-projected `sW` (unchanged formula, see
 *     `projectFloorPointToWindow`) falls inside that bar's own `[lo,hi]`
 *     SPAN, compared directly in WALL-SPACE units. No Jacobian: the
 *     comparison never leaves window-space, so there is nothing to magnify.
 *   - A horizontal bar at window-height `z` corresponds to ONE floor distance
 *     `x` (`z` depends on `x` alone — not on lateral position at all, an
 *     exact separability the old Jacobian's own zero `dz/ds` term already
 *     proved) — invert `z = h*(1-a/(a+x))` ONCE per boundary (sill, each
 *     internal row, head — a handful of values, not a per-fragment SDF) to
 *     get a floor-space `x` threshold, then compare a point's own `x`
 *     directly against it.
 *   - Combine every gate (frame, each vertical band, sill, head, each
 *     horizontal band) via `min` in a consistent "positive = open" sign
 *     convention, SEPARATELY per axis, THEN smoothstep each axis's own
 *     combined gate in ITS OWN natural unit (`computeApertureSoftPx`,
 *     UNCHANGED — the author's own blur law survives this rewrite intact),
 *     THEN take `min` of the two already-normalised [0,1] "openness"
 *     fractions. Blur only ever compares like units to like; there is no
 *     "does the blur band exceed the magnified bar width" failure mode left,
 *     because nothing is magnified.
 *
 * DELETED, not kept alongside the new code: `MAX_MAGNIFICATION`,
 * `computeApertureMagnification` (the whole Jacobian), `distanceToNearestGridLine`,
 * `apertureWindowSdfParts`, `apertureWindowSdf`, `apertureFloorSdf`. Their
 * replacement is smaller. `projectFloorPointToWindow` survives with `z`
 * removed from its return (no per-fragment height computation exists
 * anymore); `forwardProjectWindowPointToFloor` survives adapted to the same
 * `sW`-only shape, still solely for the brute-force round-trip test.
 *
 * A DELIBERATE, REASONED BEHAVIOUR CHANGE, not an oversight: designs 1-3
 * treated "lamp height at or below the window's sill" as `applicable:false`
 * (fail open — this aperture excluded from the combine, as if it weren't
 * there). This rewrite reads it as `applicable:true, gobo->0` instead — a
 * lamp that physically cannot clear its own windowsill genuinely lets NO
 * light escape that window, which is a real, meaningful DARK render, not
 * "pretend this window doesn't exist." It also falls out of the general
 * `x_sill = Infinity` math with no special case, rather than needing one.
 * `feedback_gate_polarity_must_fail_open` is about robustness to MISSING or
 * BROKEN data, not about how to render a valid, deliberately-authored
 * geometric configuration — a real lamp at a real height below a real sill
 * is neither missing nor broken.
 *
 * ============================================================================
 * WHY THIS FILE HAS NO THREE, NO TSL, NO FOUNDRY
 * ============================================================================
 * Pure arithmetic, Node-testable today — `aperture-gobo-render.js` is this
 * file's line-for-line TSL transcription, and `__tests__/aperture-gobo.
 * test.mjs` diffs the two ways of asking the same question (a brute-FORWARD
 * ray trace vs. this file's inverse map) against each other, per
 * `feedback_smooth_output_hides_ported_bugs` — a smooth picture is not
 * evidence; a diff against an independent derivation is.
 *
 * @module effects/lighting/aperture-gobo
 */

/** Effect-level generator + softness defaults — the single source of truth
 * the params schema quotes, mirroring `WINDOW_DEFAULT_STRENGTH`'s own
 * pattern. `sillPx`/`headPx` are DELIBERATELY independent of `sun-shadows.js`
 * `wallHeightPx` (a named simplification, not a silent one — a future rung
 * could couple the two for a single "how tall are my walls" authority; tier 0
 * ships its own small, self-contained pair rather than a cross-effect
 * runtime dependency this task's scope does not cover). */
export const APERTURE_GOBO_DEFAULTS = Object.freeze({
  strength: 1, // 0 = gobo term fully neutral (mix toward 1); 1 = full effect. See aperture-gobo-render.js's own uStrength.
  // `cols`/`rows` REMOVED (round 11, 2026-08-04) — a fixed pane COUNT made a
  // wide window's panes absurdly wide and a narrow window's absurdly narrow;
  // the author's own ask was "make the number of panes procedural and based
  // on the length of the wall... so it would easily accommodate different
  // amounts of panes that would keep it looking logical." Replaced by a
  // TARGET pane size — `point-light-pool.js`'s own per-light derivation
  // divides each light's real `wallLen` (`cols`) and `(headPx-sillPx)`
  // (`rows`) by these, then rounds and clamps to `[1, MAX_MULLIONS_PER_AXIS]`
  // — see that file's own "PROCEDURAL PANE COUNT" header. 80 is a plain,
  // roughly-square target; specific scenes will naturally deviate from
  // square as wallLen/height ratios vary, which is the point.
  paneWidthPx: 80,
  paneHeightPx: 35,
  // WIDENED from 6/4 (round 11, 2026-08-04), together with `SOFT_FAR_PX_BASE`
  // (below) — the author's own ask for a real, visible distance-blur needed
  // more room than the OLD thickness left: the contrast-floor cap
  // (`computeApertureGoboTerm`'s own `min(mullion,frame)/2`) that keeps a
  // mullion's own centre genuinely black scaled with these two, so at 6/4 it
  // topped out at 2px — barely distinguishable from a hard edge, and far
  // below the (uncapped-in-practice) 48px `SOFT_FAR_PX_BASE` used to imply.
  // 8/6 raises that ceiling to 3px, still a modest bar width, not a re-author
  // of the mullion/frame look the author already confirmed live. See
  // `SOFT_NEAR_PX`/`SOFT_FAR_PX_BASE`'s own header for the other half of
  // this fix.
  frame: 12,
  mullion: 14,
  // NEW (round 12, 2026-08-04) — `computeApertureRevealNarrowing`'s own
  // input. 0 = disabled (byte-identical to pre-round-12 behaviour, a
  // perfectly symmetric aperture regardless of where the light stands). 16
  // is a modest, plausible stone/wood wall thickness at this scene's own
  // pixel scale — comparable to `frame`(8) doubled, not a dramatic embrasure.
  wallThicknessPx: 67,
  // RAISED from 0 (round 11, 2026-08-04) — the author, live, on a real
  // scene: "There would be a darker space near the window because that
  // would be sheltered from the light." A sill of 0 spills light right to
  // the wall's own foot, physically implying the window's glass reaches the
  // floor; 30 leaves a real, visible gap the light never reaches at all
  // (the effect's own radial-arc gate, `computeApertureArcGate`, is a hard
  // boundary below `sillPx` — nothing soft-blurs across it, matching a
  // genuinely sheltered strip, not just a dimmer one).
  sillPx: 105,
  headPx: 220,
  softness: 1.63, // multiplies SOFT_FAR_PX_BASE — the ONE exposed softness knob, mirroring sun-shadows' softnessBias
  // MUST stay meaningfully ABOVE headPx (found live, 2026-08-03 — see
  // `computeApertureRowBoundaryX`'s own header for the geometry): a window
  // height z is only ever visible on the floor at a finite distance when
  // z < h, and the distance blows up as z approaches h. The OLD default (40)
  // sat BELOW headPx(220) entirely, so every row boundary past the sill —
  // both internal row mullions AND the head itself — was geometrically
  // unreachable at ANY floor distance, on EVERY design since the first one:
  // not a design-4 regression, a parameter mismatch that every earlier round
  // never surfaced because a different, more dominant bug always got found
  // first. 280 keeps the light comfortably "taller" than the window it's
  // lighting, so the row nearest the sill reads within ~0.4x the light's own
  // distance from the wall and the head within ~3.7x — both well inside an
  // ordinary light's own dim radius.
  defaultLampHeightPx: 280,
  minLampHeightPx: 8,
  maxAperturesPerLight: 4,
  // ROUND 14 (2026-08-04) — a real live bug: "lights which are large and
  // outdoors and no where near any actual windows are being cut off at
  // strange angles." Root cause: `findAperturesForLight`'s ONLY distance
  // filter was `light.radius` itself — for a genuinely large light (exactly
  // "large and outdoor"), that swept in ANY `light:PROXIMITY` wall ANYWHERE
  // within it, however far, however unrelated to an actual window near this
  // light — a GM may use PROXIMITY sensing for fences/hedges/gates that
  // were never meant to cast a window pattern at all. Once wrongly
  // assigned, the `applicable` (interior/exterior) test alone is a HARD
  // wedge cutoff, independent of distance — a false-positive aperture, near
  // OR far, always produces a visible cut. Fix: cap the search at a
  // realistic "this is basically where I stand" distance, INDEPENDENT of
  // the light's own radius (`Math.min(light.radius, maxApertureDistancePx)`
  // — `findAperturesForLight`'s own new 4th parameter). 400 is a few grid
  // squares at typical scene scale — generous for a lamp set back from its
  // own window, nowhere near "reaches across an outdoor map".
  maxApertureDistancePx: 400,
  // GLASS QUALITY & GRIME (round 13, 2026-08-04) — "have some fun with it."
  // 0.5 default: neither pure blob nor pure faceted, so the FIRST look at
  // this feature shows both kernels' own character at once, rather than
  // hiding one entirely behind the other's default.
  glassQuality: 0,
  // A real but modest warp — comparable to `mullion`(6)/`frame`(8), so the
  // pattern reads as "through old glass", not "smeared beyond recognition".
  distortionPx: 5,
  // Visible but not overwhelming by default ("Default new features ON" —
  // never require a console command to see a new thing — without making a
  // first look read as a bug).
  grimeAmount: 0.35,
  // EDGE SUPPRESSION (round 17, 2026-08-04) — a DIRECT, GUARANTEED manual
  // override, not another attempt at automatically deriving the "right"
  // amount. Round 16's own live report — a real screenshot, full
  // attenuation, still a hard-looking edge right at the light's own dim
  // radius — could not be reproduced across a wide sweep of bench
  // configurations (default/high softness, default/boosted luminosity,
  // pre/post real bloom, the light's own radius as the binding edge rather
  // than the window's). The author, after that: *"your test itself may be
  // flawed because it's not reflected in what things look like in
  // Foundry... give me good effective controls to softly darken from all
  // edges and I'll tune it myself."* `edgeSuppressPercent` is exactly that
  // for the window's own outer boundary — opt-in (0 = OFF, byte-identical
  // to every round before this one), DARKENING (not merely neutralising
  // the pattern, the way `DIM_RADIUS_FADE_START` already does),
  // independent of whatever Foundry's own attenuation curve is or isn't
  // doing.
  //
  // REBUILT AS A PERCENTAGE, round 19 (2026-08-04) — this shipped round 17
  // as `edgeSuppressPx`, a raw scene-px width, EXACTLY the scale-invariance
  // bug round 18 already found and fixed for the dim-radius control: the
  // author, generalising that lesson explicitly — *"lights can be all
  // sorts of sizes, so you need to only use percentages everywhere to make
  // this work"* — a fixed 20px band is a huge fraction of a small window's
  // own opening and an imperceptible sliver of a large one. Normalized
  // against THIS window's own natural spans (`computeApertureGoboTerm`'s
  // own "EDGE SUPPRESSION" header has the exact formula: `wallLen/2-frame`
  // for the spoke axis, `xHead-xSill` for the arc axis — TWO different
  // axes, each suppressed proportionally to its OWN span, not one shared
  // px value forced onto both), so the SAME percentage produces a
  // proportional band on any window, any scene scale. 15 approximates the
  // author's own prior 20px setting on a typical multi-pane window at this
  // effect's own default scale — NOT a guaranteed match on every window,
  // since the whole point of this change is that it no longer stays fixed
  // in px; worth a live re-check now that the unit itself has changed.
  edgeSuppressPercent: 15,
  // DIM-RADIUS SUPPRESSION, ROUND 18 (2026-08-04) — a real REDESIGN, not an
  // addition: the round-17 single `dimRadiusSuppressFraction` knob always
  // anchored its OWN outer end exactly at `dist01==1` (the true edge),
  // exposing only the band's WIDTH. The author's own next report — full
  // suppression, still no visible change at the reported edge — plus a
  // direct, explicit ask: *"I need controls based on the percentage of the
  // overall size of the light. So I should be able to set that a fade
  // starts at 100% of the dim radius and ends at 80%... a suppression
  // gradient starting at the edge and working inwards... until the
  // suppression fades out at 20% of the way towards the light at the
  // centre."* Two independent percentages of the light's own dim radius
  // (`dist01 * 100`), not one auto-anchored fraction — the author can now
  // pull the OUTER anchor in from 100% too (e.g. "fade from 90% to 70%"),
  // something the old single-fraction design could never express at all.
  // Both default to 100 — a ZERO-WIDTH band sitting exactly at the true
  // edge is the natural "off" state (see `computeApertureGoboTerm`'s own
  // "DIM-RADIUS SUPPRESSION" header for why this is a genuine no-op, not
  // an approximate one), matching `edgeSuppressPercent`'s own opt-in-at-0
  // discipline in this domain's own unit.
  // Live-tuned by the author to 0/58 (round 18) — per this formula's own
  // sorted-anchor design, this is NOT "fade starts at the edge" the way the
  // author's own original 100/80 example was: with the lower anchor at 0,
  // full brightness holds only exactly at the light's own centre
  // (dist01=0), and the light is ALREADY fully suppressed by 58% of the
  // way to the true edge, staying fully dark for the remaining 42% — a much
  // more aggressive vignette than the "just soften the last 20%" example
  // that motivated this control, not a "the same idea, different numbers"
  // reading of it. Shipped as asked (live visual tuning outranks this
  // file's own theorising about what a number "should" mean) — flagged
  // here in case it is not the intended shape.
  dimRadiusFadeStartPercent: 0,
  dimRadiusFadeEndPercent: 58,
});

/** Distance-to-dim-radius blur law constants — module constants, NOT params
 * (the "not a knob" doctrine `sun-shadows.js`'s own header states and this
 * design mirrors deliberately: window geometry is ART, exposed generously;
 * blur PHYSICS is a model, exposed as one bias).
 *
 * RESCALED (round 11, 2026-08-04) — the author's own ask: "a nice cheap but
 * effective blur that increases further away from the window... it should
 * start fairly blurred." `SOFT_FAR_PX_BASE` was STILL 48 from the deleted
 * magnification system (this file's own "THE CONTRAST FLOOR" header on
 * `computeApertureGoboTerm` already named this as unfinished business: "was
 * never rescaled for design 4's un-magnified feature widths"). At the
 * default `mullion`/`frame`, the contrast-floor cap
 * (`min(mullion,frame)/2`, `computeApertureGoboTerm`'s own guard against a
 * mullion's centre losing its true-black reading — load-bearing, NOT
 * loosened here) tops out at 3px — meaning 48 was reachable only in the
 * outer-most sliver of a light's own dim radius before the cap clamped
 * everything else flat, making the "increases with distance" law nearly
 * invisible in practice, exactly as measured: the old near(1)/far(48) curve
 * crosses the 2px-cap that shipped with the OLD mullion(4)/frame(6) at
 * dist01 ≈ 0.06 — 94% of a light's reach spent capped flat, not growing.
 *
 * Both fixed together, not just one: `mullion`/`frame` (`APERTURE_GOBO_
 * DEFAULTS`, below) widened slightly (4->6, 6->8) to raise that cap to 3px —
 * a real but modest change to bar thickness, not a re-author of the look the
 * author already confirmed live — and `SOFT_FAR_PX_BASE` brought down to
 * MATCH the new cap instead of overshooting it 16x, so the curve's own
 * shape (near->far, eased by `SOFT_CURVE`) is what the fragment actually
 * sees across the WHOLE dist01 range, not a value the cap was silently
 * substituting for almost the entire time. `SOFT_NEAR_PX` raised from 1 to 2
 * (out of the new 3px ceiling) for "start fairly blurred" — visibly soft at
 * the light's own centre, not knife-edged, while still leaving room to grow
 * toward the far cap. The cap itself (`computeApertureGoboTerm`'s own
 * `Math.min(soft, cap)`) is UNTOUCHED and stays the real ceiling — raising
 * `softness` above 1 (the schema's own live dial, up to 4x) can still push
 * the curve's own far value past 3px, and the cap is exactly what keeps
 * THAT case from ever eating a mullion's true-black centre. */
export const SOFT_NEAR_PX = 2;
export const SOFT_FAR_PX_BASE = 3;
export const SOFT_CURVE = 1.5;

/** THE REACH BLUR — round 15 (2026-08-04), two live reports that turned out
 * to share ONE root cause. Author: (1) *"I wish I could make the entire
 * effect much more diffused and blurred after the shapes are created and
 * progressively so further away from the window"*; (2) *"the window light
 * illumination doesn't moderate itself by the attenuation slider correctly.
 * It's always acting as if attenuation was 0... it should be fading out
 * softly towards the bright and dim radius like the light normally would."*
 *
 * DIAGNOSED, not guessed (a Node probe against the real CPU math, both
 * `atten=0` and `atten=0.7` fed through `combinedFalloff`, before touching
 * any code): with a light whose configured radius genuinely reaches far past
 * its own window, `dist01` (the light-centre-relative fraction this file's
 * OTHER blur law, `computeApertureSoftPx`, already keys off) never gets
 * anywhere near 1 before `computeApertureArcGate`'s own `xHead` boundary —
 * a HARD, un-blurred wall in floor-space `x` (`aperture.a` and the window's
 * own `headPx`/lamp `h` are all this needs; the light's radius and
 * attenuation never enter into it) — blocks the beam outright. Measured: at
 * `atten=0.0`, `0.3`, AND `0.7` alike, brightness sat flat near 1.0 out to
 * `x≈530`, then fell to exactly 0 by `x≈570` — attenuation changed NOTHING
 * about that cliff's shape, because the cliff was never attenuation's
 * boundary to shape. The existing `min(mullion,frame)/2`-ish "contrast
 * floor" (this function's own header above) caps the blur width used on
 * THAT boundary too (it's part of the same combined `arcGate`), at a fixed
 * few px REGARDLESS of how far into the room `x` has grown — which is
 * exactly why raising the schema's own `softness` slider (already tried
 * live, per the author's own screenshot, at its 4x max) barely moved
 * anything: the raw curve's far value was already being clamped away by
 * that same small cap for nearly the entire visible beam.
 *
 * THE FIX: a SECOND blur-width contributor, independent of `dist01` and
 * NOT feature-width-capped, keyed on `x / xHeadReach` — "how far through
 * THIS aperture's own natural geometric depth (wall to the window's head-
 * height reach) has this fragment travelled" — 0 right at the window (byte-
 * similar to today, the already-confirmed-live near field untouched), 1 at
 * the beam's own far edge. Scale-invariant by construction: it tracks the
 * window's OWN reach, not the light's configured radius, so it softens the
 * SAME cliff whether the light's radius is small (where `dist01` alone
 * would already have handled it) or, as measured above, enormous (where
 * `dist01` alone never gets the chance to). Combined with the EXISTING
 * `dist01`-driven value via `Math.max` (`computeApertureGoboTerm`, below) —
 * whichever growth signal is more relevant at a given fragment wins; neither
 * is weakened. `REACH_SOFT_FAR_PX_BASE` reuses the exact 48px constant
 * designs 1-3's own (deleted) `SOFT_FAR_PX_BASE` used — that number was
 * WRONG for the job it had THEN (flattening mullions it was supposed to
 * only soften the edge of — this file's own "THE CONTRAST FLOOR" header has
 * that whole story) but is the RIGHT number for the job it has NOW: a
 * genuinely visible, "much more diffused" glow at range, scaled by the
 * SAME `softness` dial the mullion-preserving curve already uses, so both
 * requests are served by tuning ONE existing slider.
 *
 * Applying this uniformly to BOTH axes (spoke AND arc), not just the arc
 * axis where the diagnosis was made, is the deliberate reading of "the
 * ENTIRE effect" — mullions melt into the same diffuse glow the outer sill/
 * head boundary does, at the SAME rate, rather than individually-tuned
 * per-axis behaviour the author never asked for. */
export const REACH_SOFT_FAR_PX_BASE = 48;

/**
 * THE REACH BLUR's own growth curve — `REACH_SOFT_FAR_PX_BASE`'s own header
 * has the full derivation. Reuses `SOFT_CURVE` (not a fresh exponent) so
 * both blur laws share one "starts gentle, accelerates" shape.
 *
 * @param {number} x - floor-space px from the wall (`projectFloorPointToWindow`'s own `x`).
 * @param {number} xHeadReach - THIS aperture's own geometric reach limit
 *   (`computeApertureRowBoundaryX({a, h, z: headPx})`) — the beam's own far
 *   edge, in the SAME floor-space `x` unit. Non-finite or `<=0` (a
 *   degenerate/unreachable window) reads as "no reach signal", 0.
 * @param {number} [reachSoftFarPx] - defaults to `REACH_SOFT_FAR_PX_BASE`.
 * @returns {number} the reach-driven blur half-width, px, `[0, reachSoftFarPx]`.
 */
export function computeApertureReachSoftPx(x, xHeadReach, reachSoftFarPx) {
  const far = Number.isFinite(reachSoftFarPx) ? reachSoftFarPx : REACH_SOFT_FAR_PX_BASE;
  if (!(Number.isFinite(xHeadReach) && xHeadReach > 0) || !Number.isFinite(x)) return 0;
  const t = Math.min(1, Math.max(0, x / xHeadReach));
  return far * Math.pow(t, SOFT_CURVE);
}

/** THE DIM-RADIUS FADE — round 12 (2026-08-04), the author's own next ask
 * straight after the round-10 live confirmation: *"it's possible for the
 * effect to hit the dim radius edge which becomes an instant cut off hard
 * line."* The light's own MESH is a hard triangle-fan boundary at
 * `dist01==1` (`point-light-illumination.js#triangulateLightFan` — a real
 * geometric edge, not a shader term, so nothing here can blur it directly).
 * What CAN move is where the gobo PATTERN's own contrast lives relative to
 * that edge: fading `gobo` back toward `1` (fully neutral — whatever the
 * light's own un-patterned falloff would already show, which Foundry's own
 * attenuation curve already fades smoothly) over the LAST fraction of a
 * light's reach means the pattern's own visible contrast is gone well
 * BEFORE the mesh boundary, so nothing collides with it. Module constant,
 * not a param — this is model, not art, same "not a knob" doctrine as
 * `SOFT_NEAR_PX` above. */
export const DIM_RADIUS_FADE_START = 0.75;

/** A lamp standing exactly in the wall's own plane (`a = 0`) is a genuine
 * division-by-zero; clamped here, once, so every caller downstream is safe
 * by construction rather than by remembering to guard it themselves. */
export const MIN_WALL_DISTANCE_PX = 1;

/** Hard cap on mullion bars unrolled per axis, per aperture. `cols`/`rows`
 * are GRAPH-BUILD-TIME integers in the render file (part of the material's
 * own rebuild key, exactly like `apertureCount` already is) — never live
 * uniforms — specifically so the per-mullion loop stays a plain JS `for`
 * that unrolls into straight-line arithmetic, not a TSL `Loop`/`uniformArray`
 * (`feedback_tsl_select_chain_strands_vars`'s own landmine class). Since
 * round 11 (2026-08-04) `cols`/`rows` are no longer a schema param directly —
 * they're DERIVED per-light from real `wallLen`/`(headPx-sillPx)` divided by
 * the "Pane target width/height" params (`point-light-pool.js`'s own
 * "PROCEDURAL PANE COUNT" comment) — so this constant is now the clamp on
 * THAT derivation's own output, a real ceiling a very long wall or a very
 * small target size could otherwise exceed, not a silent truncation of it. */
export const MAX_MULLIONS_PER_AXIS = 8;

/**
 * The wall's own local frame: unit direction A->B, and a unit normal (an
 * arbitrary perpendicular — `orientApertureToLight` is what fixes its sign
 * per-light). Pure geometry, no light involved yet. UNCHANGED by design 4.
 *
 * `B` (round 2026-08-12, perf-audit) rides along for free — `findAperturesForLight`'s
 * own assignment-pass loop needs both endpoints (`distancePointToSegment`,
 * `computeAngularWidthFromLight`) and used to rebuild `{x:seg.x1,y:seg.y1}`/
 * `{x:seg.x2,y:seg.y2}` itself every call; returning `B` here lets that loop
 * reuse THIS object instead, one fewer pair of throwaway allocations per
 * (light, wall).
 *
 * @param {{x1:number,y1:number,x2:number,y2:number}} wall
 * @returns {{A:{x:number,y:number}, B:{x:number,y:number}, dir:{x:number,y:number}, nrm:{x:number,y:number}, wallLen:number}|null}
 *   `null` for a degenerate (zero-length, or non-finite) wall segment.
 */
export function computeWallFrame(wall) {
  if (!wall) return null;
  const { x1, y1, x2, y2 } = wall;
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return null;
  const dir = { x: dx / len, y: dy / len };
  const nrm = { x: -dir.y, y: dir.x };
  return { A: { x: x1, y: y1 }, B: { x: x2, y: y2 }, dir, nrm, wallLen: len };
}

/**
 * Orient a wall's frame to ONE light: flip `nrm` (if needed) so the light
 * sits on the negative side, and derive the light's own projection `sL`
 * along the wall and its clamped perpendicular distance `a`. Two different
 * lights on opposite sides of the SAME wall get opposite `nrm` — this is
 * fundamentally per-(light,wall) data, computed once at assignment time,
 * never re-derived per fragment. UNCHANGED by design 4.
 *
 * @param {{A:{x:number,y:number}, dir:{x:number,y:number}, nrm:{x:number,y:number}, wallLen:number}} frame
 * @param {{x:number,y:number}} light
 * @returns {{A:{x:number,y:number}, dir:{x:number,y:number}, nrm:{x:number,y:number}, wallLen:number, sL:number, a:number}}
 */
export function orientApertureToLight(frame, light) {
  const rel = { x: light.x - frame.A.x, y: light.y - frame.A.y };
  const sL = rel.x * frame.dir.x + rel.y * frame.dir.y;
  const a0 = rel.x * frame.nrm.x + rel.y * frame.nrm.y; // dot(L-A, nrm) with the RAW (unflipped) normal
  // Choose nrm so dot(L-A, nrm) < 0 — i.e. a = -dot(...) > 0, the light on
  // the frame's negative side, per this module's own header convention.
  const flip = a0 > 0;
  const nrm = flip ? { x: -frame.nrm.x, y: -frame.nrm.y } : frame.nrm;
  const aRaw = flip ? a0 : -a0;
  const a = Math.max(aRaw, MIN_WALL_DISTANCE_PX);
  return { A: frame.A, dir: frame.dir, nrm, wallLen: frame.wallLen, sL, a };
}

/**
 * Shortest distance from a point to a line SEGMENT (not the infinite line) —
 * the assignment pass's own "does this wall sit near this light" test.
 * UNCHANGED by design 4.
 *
 * @param {{x:number,y:number}} P
 * @param {{x:number,y:number}} A
 * @param {{x:number,y:number}} B
 * @returns {number}
 */
export function distancePointToSegment(P, A, B) {
  const ex = B.x - A.x;
  const ey = B.y - A.y;
  const wx = P.x - A.x;
  const wy = P.y - A.y;
  const eDotE = Math.max(ex * ex + ey * ey, 1e-12);
  const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / eDotE));
  const cx = wx - ex * t;
  const cy = wy - ey * t;
  return Math.hypot(cx, cy);
}

/**
 * The angle a wall segment subtends as seen from a light — the assignment
 * pass's ranking key (`docs/planning/Aperture-Gobo.md` §2.2: "ordered by
 * angular width as seen from the light, keep the widest N"). UNCHANGED by
 * design 4.
 *
 * @param {{x:number,y:number}} light
 * @param {{x:number,y:number}} A
 * @param {{x:number,y:number}} B
 * @returns {number} radians, [0, PI]. 0 for a degenerate (light ON a vertex).
 */
export function computeAngularWidthFromLight(light, A, B) {
  const ax = A.x - light.x;
  const ay = A.y - light.y;
  const bx = B.x - light.x;
  const by = B.y - light.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (!(la > 1e-6) || !(lb > 1e-6)) return 0;
  const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
  return Math.acos(cos);
}

/**
 * THE ASSIGNMENT PASS — which of a scene's aperture walls belong to THIS
 * light. A cheap CPU heuristic (proximity + angular-width ranking), not a
 * second visibility solve: Foundry's own wall-clipped fan is still the sole
 * authority for WHERE a light's mesh draws at all — this only decides which
 * nearby apertures are worth the per-fragment cost of evaluating. UNCHANGED
 * by design 4.
 *
 * `maxAperturesPerLight` is a CAP, so the drop count is always reported
 * (`feedback_silent_cap_corrupts_hard_boundary`) — never silently truncated
 * with no trace.
 *
 * `maxApertureDistancePx` (round 14, 2026-08-04, a real live bug — this
 * function's own EXPORT header has the full story) — the search radius is
 * `Math.min(light.radius, maxApertureDistancePx)`, NOT `light.radius`
 * alone. `light.radius` answers "how far does this light's OWN glow reach",
 * a question about the LIGHT; this answers "how far away can a wall still
 * plausibly be THIS light's own window", a question about the WALL — a
 * large light legitimately reaching far across an outdoor map does not
 * mean every `light:PROXIMITY` wall inside that reach is somehow its own
 * window. Once wrongly assigned, `applicable` alone (interior/exterior) is
 * a HARD wedge cutoff independent of distance, so a false-positive
 * assignment is never merely "a subtle far-away effect" — it is always a
 * visible cut, near or far.
 *
 * @param {{x:number,y:number,radius:number}} light
 * @param {Array<{x1:number,y1:number,x2:number,y2:number,aperture:boolean}>} wallSegments
 * @param {number} maxAperturesPerLight
 * @param {number} [maxApertureDistancePx] - defaults to `APERTURE_GOBO_DEFAULTS.maxApertureDistancePx`.
 * @param {Array<object>} [wallFrames] - perf seam (2026-08-12): `wallSegments`
 *   is STATIC geometry (only createWall/updateWall/deleteWall touch it — a
 *   GM-editing-cadence event, not a frame-cadence one), but this function
 *   runs once per LIGHT, every frame — without this, `computeWallFrame`'s own
 *   hypot+divides+allocations were being redone, identically, for every
 *   (light, wall) pair, every frame, for walls that hadn't moved since the
 *   scene loaded. When provided, MUST be a `computeWallFrame(...)` result
 *   PARALLEL to `wallSegments` by index (`point-light-pool.js`'s own
 *   `apertureSegCache.frames`, built alongside `apertureSegCache.segments` at
 *   the exact same rebuild, is the one real caller) — `wallFrames[i]` is
 *   trusted for `wallSegments[i]` with no re-validation. Absent (every test/
 *   bench call site) falls back to computing it inline, byte-identical to
 *   before this parameter existed.
 * @returns {{apertures: object[], totalFound: number, dropped: number}}
 *   `apertures` — oriented aperture frames (`orientApertureToLight`'s own
 *   shape), widest-angle first, capped at `maxAperturesPerLight`.
 */
export function findAperturesForLight(
  light,
  wallSegments,
  maxAperturesPerLight,
  maxApertureDistancePx = APERTURE_GOBO_DEFAULTS.maxApertureDistancePx,
  wallFrames = null
) {
  const cap = Number.isFinite(maxAperturesPerLight) && maxAperturesPerLight > 0 ? Math.floor(maxAperturesPerLight) : 0;
  const searchDistance = Math.max(
    0,
    Math.min(light.radius, Number.isFinite(maxApertureDistancePx) ? maxApertureDistancePx : Infinity)
  );
  const candidates = [];
  const segs = wallSegments ?? [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg?.aperture) continue;
    const frame = wallFrames ? wallFrames[i] : computeWallFrame(seg);
    if (!frame) continue;
    // `frame.A`/`frame.B` reused directly rather than rebuilt from
    // `seg.x1/y1/x2/y2` — the SAME points `computeWallFrame` already made.
    const { A, B } = frame;
    if (distancePointToSegment(light, A, B) > searchDistance) continue;
    // `oriented` is a scratch object nothing else references yet — mutating
    // it in place and pushing IT (never a spread-copy) skips one allocation
    // per candidate; `aperture.A`/`B`/`dir`/`nrm` are read-only from here on
    // (`point-light-pool.js`'s own per-frame uniform writer only ever calls
    // `.set(src.A.x, src.A.y)` on THEIR OWN uniform value, never on `src`
    // itself), so sharing `frame`'s own sub-objects across every light that
    // scans this wall is safe.
    const oriented = orientApertureToLight(frame, light);
    oriented.angularWidth = computeAngularWidthFromLight(light, A, B);
    candidates.push(oriented);
  }
  candidates.sort((p, q) => q.angularWidth - p.angularWidth);
  const apertures = candidates.slice(0, cap);
  return { apertures, totalFound: candidates.length, dropped: Math.max(0, candidates.length - apertures.length) };
}

/**
 * The lamp's own height `h` (world px above its receiving floor). TIER 0
 * SCOPE, named rather than silent: this always resolves to
 * `params.defaultLampHeightPx` — Foundry's per-light `elevation` field is NOT
 * read yet. UNCHANGED by design 4.
 *
 * @param {object} light - unused today; kept as a parameter so a future
 *   elevation-aware caller is a signature-compatible change, not a new one.
 * @param {{defaultLampHeightPx:number, minLampHeightPx:number}} params
 * @returns {number}
 */
export function resolveLampHeight(light, params) {
  const raw = Number.isFinite(params?.defaultLampHeightPx)
    ? params.defaultLampHeightPx
    : APERTURE_GOBO_DEFAULTS.defaultLampHeightPx;
  const min = Number.isFinite(params?.minLampHeightPx)
    ? params.minLampHeightPx
    : APERTURE_GOBO_DEFAULTS.minLampHeightPx;
  return Math.max(min, raw);
}

/**
 * PROCEDURAL PANE COUNT (round 11, 2026-08-04) — derive ONE light's own
 * `cols`/`rows` from its real aperture `wallLen` and the window's own
 * sill-to-head span, each divided by a TARGET pane size, rounded and clamped
 * to `[1, MAX_MULLIONS_PER_AXIS]`. The author's own ask: "make the number of
 * panes procedural and based on the length of the wall... so it would easily
 * accommodate different amounts of panes that would keep it looking
 * logical" — a fixed pane COUNT made a wide window's panes absurdly wide and
 * a narrow window's absurdly narrow; a fixed target pane SIZE self-scales.
 *
 * Pure, small, and imported by BOTH `point-light-pool.js` (production,
 * per-light, per-frame) and `bench-aperture-gobo.js` (the shader-lab bench)
 * — one shared derivation the two can never quietly drift apart from,
 * rather than the bench hand-rolling its own copy of a rounding/clamping
 * formula that only production actually ships.
 *
 * @param {object} args
 * @param {number} [args.wallLen] - the assigned aperture's own real wall
 *   length (`findAperturesForLight`'s own per-aperture `wallLen`). Absent
 *   (a light with no aperture this frame) falls back to `paneWidthPx`
 *   itself, which resolves to exactly 1 pane — stable every frame, so a
 *   windowless light can never itself trigger a material rebuild here.
 * @param {number} args.sillPx
 * @param {number} args.headPx
 * @param {number} args.paneWidthPx
 * @param {number} args.paneHeightPx
 * @param {{cols:number,rows:number}} [out] - perf seam (2026-08-12): this
 *   runs once per light, per frame, in `point-light-pool.js#update`'s hot
 *   loop. When provided, `out` is written in place and returned instead of
 *   allocating a fresh `{cols,rows}` — the caller owns `out`'s lifetime (a
 *   single pool-scope scratch object, reused across every light THIS frame,
 *   the same "hoist the container, `.clear()`/overwrite don't reallocate"
 *   discipline `update()`'s own `seen`/`illumBatchGroups` scratch already
 *   follows), safe because `cols`/`rows` are read into plain numbers by the
 *   caller before the next light's call overwrites them. Absent (every test/
 *   bench call site) returns a fresh object, byte-identical to before this
 *   parameter existed.
 * @returns {{cols: number, rows: number}}
 */
export function deriveApertureGoboPaneCount({ wallLen, sillPx, headPx, paneWidthPx, paneHeightPx }, out) {
  const safePaneWidthPx = Math.max(Number.isFinite(paneWidthPx) ? paneWidthPx : APERTURE_GOBO_DEFAULTS.paneWidthPx, 1);
  const safePaneHeightPx = Math.max(
    Number.isFinite(paneHeightPx) ? paneHeightPx : APERTURE_GOBO_DEFAULTS.paneHeightPx,
    1
  );
  const effectiveWallLen = Number.isFinite(wallLen) ? wallLen : safePaneWidthPx;
  const spanPx = Math.max(
    (Number.isFinite(headPx) ? headPx : APERTURE_GOBO_DEFAULTS.headPx) -
      (Number.isFinite(sillPx) ? sillPx : APERTURE_GOBO_DEFAULTS.sillPx),
    0
  );
  const cols = Math.min(Math.max(Math.round(effectiveWallLen / safePaneWidthPx), 1), MAX_MULLIONS_PER_AXIS);
  const rows = Math.min(Math.max(Math.round(spanPx / safePaneHeightPx), 1), MAX_MULLIONS_PER_AXIS);
  if (out) {
    out.cols = cols;
    out.rows = rows;
    return out;
  }
  return { cols, rows };
}

/**
 * THE INVERSE PROJECTION — ground point -> window-space lateral coordinate
 * `sW`. The well-conditioned direction: one divide, no singularity for any
 * `a > 0`. `z` is GONE from this return (design 4's own header) — no
 * per-fragment height computation exists anymore; a horizontal mullion's
 * position is resolved once, per boundary, by `computeApertureRowBoundaryX`
 * instead, working directly in floor-space `x`.
 *
 * @param {{x:number,y:number}} P - world-space floor point.
 * @param {{A:{x:number,y:number}, dir:{x:number,y:number}, nrm:{x:number,y:number}, sL:number, a:number}} aperture
 * @returns {{sW:number, s:number, x:number, inv:number}|null}
 *   `null` when `P` is not on the exterior side of this wall (`x <= 0`) — NOT
 *   an error, just "this aperture has nothing to say about this point."
 */
export function projectFloorPointToWindow(P, aperture) {
  const rel = { x: P.x - aperture.A.x, y: P.y - aperture.A.y };
  const s = rel.x * aperture.dir.x + rel.y * aperture.dir.y;
  const x = rel.x * aperture.nrm.x + rel.y * aperture.nrm.y;
  if (!(x > 0)) return null;
  const inv = aperture.a / (aperture.a + x);
  const sW = aperture.sL + (s - aperture.sL) * inv;
  return { sW, s, x, inv };
}

/**
 * THE FORWARD PROJECTION — window-space `sW`, AT a chosen floor-space `x` ->
 * the floor point that inverse-projects back to it. Exists SOLELY so
 * `__tests__/aperture-gobo.test.mjs` can brute-force-verify
 * `projectFloorPointToWindow` against an independently-derived formula: pick
 * a random `(sW, x)`, project forward, then invert and check the round trip,
 * per `feedback_smooth_output_hides_ported_bugs`. Simpler than design 1-3's
 * own forward map (no `z`/`h` at all — `sW` and `x` are already the two
 * floor-space unknowns, so "forward" here is just reconstructing `s` from
 * `sW` and handing `x` straight back).
 *
 * @param {number} sW @param {number} x - must be > 0 (exterior side).
 * @param {{A:{x:number,y:number}, dir:{x:number,y:number}, nrm:{x:number,y:number}, sL:number, a:number}} aperture
 * @returns {{P:{x:number,y:number}, s:number}|null} `null` when `x <= 0`.
 */
export function forwardProjectWindowPointToFloor(sW, x, aperture) {
  if (!(x > 0)) return null;
  const inv = aperture.a / (aperture.a + x);
  const s = aperture.sL + (sW - aperture.sL) / inv;
  const P = {
    x: aperture.A.x + s * aperture.dir.x + x * aperture.nrm.x,
    y: aperture.A.y + s * aperture.dir.y + x * aperture.nrm.y,
  };
  return { P, s };
}

/**
 * THE ROW-BOUNDARY INVERSION — window-height `z` -> the ONE floor-space
 * distance `x` (from the wall, along the light's own perpendicular) at which
 * a ray from the light through height `z` on the window crosses the ground.
 * `z` depends on `x` ALONE (design 4's own header: the old Jacobian's own
 * `dz/ds == 0` term already proved this separability), so inverting it once
 * per boundary — sill, each internal row mullion, head — replaces design
 * 1-3's whole per-fragment `z` computation.
 *
 * Derived from `z = h*(1 - a/(a+x))`, solved for `x`:
 *   `a/(a+x) = 1 - z/h`  =>  `x = a*z/(h-z)`
 *
 * @param {object} args @param {number} args.a @param {number} args.h @param {number} args.z
 * @returns {number} floor px from the wall. `Infinity` when `z >= h` — that
 *   height is at or above the lamp's own, so no ray from the lamp through it
 *   ever reaches the ground at any finite distance (the lamp's own height
 *   never gets "seen" through the TOP of a window it stands below the top
 *   of — see this module's own header for why this is a real geometric fact,
 *   not a missing case).
 *
 *   `h > z` STRICTLY (not `h - z` merely nonzero) is not itself enough to
 *   keep the division well-behaved: `h`/`z` are both author-tunable schema
 *   values (`defaultLampHeightPx`, `headPx`, ...), and this module's own
 *   header already documents one live round where they landed close enough
 *   to matter (`headPx` needing to stay "meaningfully ABOVE" `defaultLampHeightPx`).
 *   A denominator that floats arbitrarily close to 0 without ever hitting the
 *   `!(h > z)` branch returns a huge-but-uncontrolled finite `x`, not the
 *   deliberate `Infinity` sentinel above — `Math.max(h - z, 1e-6)` floors it
 *   at the SAME epsilon `aperture-gobo-render.js`'s own TSL twin already uses
 *   for this identical division (`rowBoundaryX`'s own `max(uLampHeight.sub(zVal),
 *   float(1e-6))`) — this was the one place the CPU "spec" and its GPU
 *   transcription had quietly diverged.
 */
export function computeApertureRowBoundaryX({ a, h, z }) {
  if (!(h > z)) return Infinity;
  return (a * z) / Math.max(h - z, 1e-6);
}

/**
 * THE FORWARD of `computeApertureRowBoundaryX` — floor-space distance `x` ->
 * the ONE window-height `z` a ray from the lamp through `(x, ground)`
 * corresponds to. Algebraically the same relation (`z = h*(1-a/(a+x))`,
 * rearranged to `h*x/(a+x)`), just solved for the other unknown — round 13
 * (2026-08-04) needs `z` at a REAL floor point to place that point on the
 * glass's own (sW, z) plane, for the pane index and the glass-quality warp
 * below; `computeApertureRowBoundaryX` only ever needed the reverse.
 *
 * @param {object} args @param {number} args.a @param {number} args.h @param {number} args.x
 * @returns {number} `0` for `x<=0` or `a<=0` (never negative, never NaN).
 */
export function computeApertureHeightFromX({ a, h, x }) {
  if (!(x > 0) || !(a > 0) || !(h > 0)) return 0;
  return (h * x) / (a + x);
}

/**
 * THE REVEAL — round 12 (2026-08-04), the `wallThickness` deferred rung
 * (`effects/aperture-gobo.js`'s own `deferredRungs`, "A thick wall's reveal
 * narrows the aperture at oblique angles by w·tanθ — what stops a beam
 * looking painted-on when the lamp sits well off to one side") now BUILT.
 * The author's own follow-up ask, same message as the round-10 live
 * confirmation: soften the two lateral edges of a window's own light wedge,
 * which are genuinely Foundry's wall-clipped light-POLYGON boundary (a hard
 * mesh edge no shader term can blur directly — confirmed by reading
 * `point-light-illumination.js#triangulateLightFan` and `foundry/scene-
 * lights.js` before writing this). The fix doesn't touch that mesh edge at
 * all: it darkens the gobo pattern INSIDE the wedge, near whichever lateral
 * edge the wall's own reveal would physically shadow, so the visible
 * transition happens BEFORE the mesh boundary, inside territory the
 * existing frame-gate blur (THE CONTRAST FLOOR, `computeApertureGoboTerm`'s
 * own header) already softens — no new blur machinery needed, only a new
 * INPUT to the one that already exists.
 *
 * `θ` is the light's own incidence angle off the wall's normal — approximated
 * cheaply (not ray-traced through the tunnel) as `atan((sL - wallLen/2) / a)`,
 * the tangent of the angle from the aperture's own centreline to the light.
 * A light dead-centre (`sL == wallLen/2`) sees a fully symmetric opening
 * (`θ=0`, no narrowing either side) — a light off to one side sees the FAR
 * jamb eat into the opening on the side away from its own lean, the familiar
 * "can't see the far corner of a deep window from beside it" effect.
 * `Math.min(..., centre - 1e-3)` keeps the narrowing from ever inverting the
 * aperture (eating past its own centreline) at a grazing angle.
 *
 * @param {{sL:number, a:number, wallLen:number, wallThicknessPx:number}} p
 * @returns {{loExtra:number, hiExtra:number}} extra px to add to the frame
 *   gate's own `frame` bound on the low-sW / high-sW side respectively — at
 *   most one is ever nonzero.
 */
export function computeApertureRevealNarrowing(p) {
  const w = Number.isFinite(p.wallThicknessPx) ? Math.max(p.wallThicknessPx, 0) : 0;
  if (w <= 0 || !Number.isFinite(p.sL) || !(Number.isFinite(p.a) && p.a > 0)) {
    return { loExtra: 0, hiExtra: 0 };
  }
  const wallLen = Math.max(p.wallLen, 1e-3);
  const centre = wallLen / 2;
  const tanTheta = (p.sL - centre) / p.a;
  if (tanTheta === 0) return { loExtra: 0, hiExtra: 0 };
  const reveal = Math.min(w * Math.abs(tanTheta), Math.max(centre - 1e-3, 0));
  return tanTheta > 0 ? { loExtra: reveal, hiExtra: 0 } : { loExtra: 0, hiExtra: reveal };
}

/**
 * THE SPOKE GATE — vertical mullions plus the outer frame, combined as ONE
 * signed value in `sW` (wall-space px): POSITIVE = open glass, NEGATIVE =
 * blocked (frame casing or a mullion bar). Two DIFFERENT interval-SDF shapes,
 * because the frame's open region is INSIDE `[frame, wallLen-frame]` while a
 * mullion bar's open region is OUTSIDE its own `[lo,hi]` span — using the
 * wrong shape for either would silently invert its own sense:
 *   `insideOpen(v,lo,hi)  = min(v-lo, hi-v)`   — positive INSIDE [lo,hi]
 *   `outsideOpen(v,lo,hi) = max(lo-v, v-hi)`   — positive OUTSIDE [lo,hi]
 * Combined via `min` across every gate (frame + every internal mullion) — a
 * point reads open only if it clears ALL of them, the standard "intersection
 * of open regions" `min` already gives when every contributor uses the SAME
 * positive-means-open sign.
 *
 * `cols < 2` needs no special case: the loop below runs zero times, and the
 * frame gate alone is the answer — a genuine simplification design 1-3's own
 * `dVert = cols>=2 ? ... : Infinity` guard needed and this doesn't.
 *
 * `frame` itself is widened asymmetrically by `computeApertureRevealNarrowing`
 * (round 12) — `sL`/`a`/`wallThicknessPx` are OPTIONAL; absent (or
 * `wallThicknessPx<=0`) resolves to zero narrowing either side, byte-
 * identical to the pre-round-12 formula.
 *
 * @param {number} sW
 * @param {{wallLen:number, cols:number, mullion:number, frame:number, sL?:number, a?:number, wallThicknessPx?:number}} p
 * @returns {number} signed, wall-space px.
 */
export function computeApertureSpokeGate(sW, p) {
  const wallLen = Math.max(p.wallLen, 1e-3);
  const reveal = computeApertureRevealNarrowing({ sL: p.sL, a: p.a, wallLen, wallThicknessPx: p.wallThicknessPx });
  let gate = Math.min(sW - (p.frame + reveal.loExtra), wallLen - (p.frame + reveal.hiExtra) - sW);
  const cols = Math.max(0, Math.min(MAX_MULLIONS_PER_AXIS, Math.floor(Number.isFinite(p.cols) ? p.cols : 0)));
  for (let k = 1; k < cols; k++) {
    const center = (k * wallLen) / cols;
    const lo = center - p.mullion / 2;
    const hi = center + p.mullion / 2;
    gate = Math.min(gate, Math.max(lo - sW, sW - hi));
  }
  return gate;
}

/**
 * THE ARC GATE — horizontal mullions plus sill/head, combined as ONE signed
 * value in `x` (floor-space px, distance from the wall): POSITIVE = open,
 * NEGATIVE = blocked. Mirrors `computeApertureSpokeGate` exactly, one
 * dimension over, using `computeApertureRowBoundaryX` to convert each
 * window-height boundary into the ONE floor-space `x` it corresponds to
 * before comparing.
 *
 * Sill and head are each a HALF-OPEN gate (open only below/above one
 * boundary, not between two) — `x - xSill` (positive beyond the sill) and
 * `xHead - x` (positive before the head) are the natural degenerate case of
 * `outsideOpen` with one bound sent to infinity, so they need no special
 * function of their own. When `xSill = Infinity` (lamp at or below the
 * sill), `x - Infinity` is `-Infinity` for every finite `x` — everything
 * reads as blocked, correctly (this module's own header explains why that is
 * the intended reading, not a bug).
 *
 * @param {number} x
 * @param {{a:number, h:number, sillPx:number, headPx:number, rows:number, mullion:number}} p
 * @returns {number} signed, floor-space px.
 */
export function computeApertureArcGate(x, p) {
  const xSill = computeApertureRowBoundaryX({ a: p.a, h: p.h, z: p.sillPx });
  const xHead = computeApertureRowBoundaryX({ a: p.a, h: p.h, z: p.headPx });
  let gate = Math.min(x - xSill, xHead - x);
  const rows = Math.max(0, Math.min(MAX_MULLIONS_PER_AXIS, Math.floor(Number.isFinite(p.rows) ? p.rows : 0)));
  for (let j = 1; j < rows; j++) {
    const zj = p.sillPx + (j * (p.headPx - p.sillPx)) / rows;
    const xLo = computeApertureRowBoundaryX({ a: p.a, h: p.h, z: zj - p.mullion / 2 });
    const xHi = computeApertureRowBoundaryX({ a: p.a, h: p.h, z: zj + p.mullion / 2 });
    gate = Math.min(gate, Math.max(xLo - x, x - xHi));
  }
  return gate;
}

/**
 * THE FRAME-ONLY GATE — round 17 (2026-08-04), `edgeSuppressPercent`'s own
 * header. The SAME first line `computeApertureSpokeGate` opens with (its
 * own frame boundary, reveal-widened, BEFORE the mullion loop), pulled out
 * on its own: edge suppression darkens near the window's own OUTER edge
 * specifically, not near an internal mullion (which the ordinary gobo
 * pattern already darkens on its own — suppressing there too would double
 * up on a feature already handled).
 *
 * @param {number} sW
 * @param {{wallLen:number, frame:number, loExtra?:number, hiExtra?:number}} p
 * @returns {number} signed, wall-space px — positive = away from the frame.
 */
export function computeApertureFrameOnlyGate(sW, p) {
  const wallLen = Math.max(p.wallLen, 1e-3);
  const loExtra = Number.isFinite(p.loExtra) ? p.loExtra : 0;
  const hiExtra = Number.isFinite(p.hiExtra) ? p.hiExtra : 0;
  return Math.min(sW - (p.frame + loExtra), wallLen - (p.frame + hiExtra) - sW);
}

/**
 * THE SILL/HEAD-ONLY GATE — `computeApertureFrameOnlyGate`'s own header,
 * one axis over: `computeApertureArcGate`'s own first line, before its
 * mullion loop.
 *
 * @param {number} x @param {number} xSill @param {number} xHead
 * @returns {number} signed, floor-space px.
 */
export function computeApertureSillHeadOnlyGate(x, xSill, xHead) {
  return Math.min(x - xSill, xHead - x);
}

/**
 * THE BLUR LAW — the author's own rule ("modify the amount of blur the
 * further it is from the centre of the light to the edge of the dim
 * radius"), and nothing more than that rule: `dist01` is already, for FREE,
 * "fraction of the way from centre to the dim radius" (it is the SAME `dist`
 * `point-light-illumination.js` already computes as its very first line).
 * The RAW curve itself is unchanged by design 4 — `computeApertureGoboTerm`
 * (below) is what changed, capping this value per-axis before use (see its
 * own header, "THE CONTRAST FLOOR", for why the raw curve alone is not
 * enough any more).
 *
 * @param {number} dist01 - 0 at the light's own centre, 1 at its dim radius.
 * @param {number} softFarPx
 * @returns {number} the softening half-width.
 */
export function computeApertureSoftPx(dist01, softFarPx) {
  const t = Math.min(1, Math.max(0, Number.isFinite(dist01) ? dist01 : 0));
  const far = Number.isFinite(softFarPx) ? softFarPx : SOFT_FAR_PX_BASE;
  return SOFT_NEAR_PX + (far - SOFT_NEAR_PX) * Math.pow(t, SOFT_CURVE);
}

const smoothstep01 = (edge0, edge1, v) => {
  if (edge0 === edge1) return v < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * ONE aperture's contribution at ONE floor point. `applicable:false` (P is on
 * the interior side of THIS wall) must be excluded from any combine — see
 * `computeApertureGoboForLight`. A lamp that cannot clear its own sill is
 * STILL `applicable:true` (this module's own header explains why that
 * changed from designs 1-3) — it just reads fully dark.
 *
 * ============================================================================
 * THE CONTRAST FLOOR — found live, 2026-08-03, the FIRST look at design 4
 * ============================================================================
 * Design 4 kept §5's blur law numerically unchanged (`SOFT_FAR_PX_BASE = 48`)
 * — but that constant was calibrated for designs 1-3, where a thin mullion's
 * FLOOR-projected width had already been scaled up by the (now-deleted)
 * Jacobian, up to `MAX_MAGNIFICATION` (10x), before blur was compared against
 * it. Design 4 compares blur directly against the mullion's OWN, un-magnified
 * width (typically a few px) — so the SAME 48px blur constant, unchanged,
 * now dwarfs the feature it's meant to be softening the EDGE of. Reported
 * live as "no evidence of it working at all" — measured, not assumed: with
 * the schema's own defaults (mullion=4, frame=6), a mullion's own CENTRE
 * read `gobo=0.415` at `dist01=0.5` (barely darker than fully open) instead
 * of the ~0 a "dark bar" implies, and never dropped below ~0.42 anywhere
 * past roughly a third of the way to the light's own dim radius — the blur
 * was not softening the pattern's edges, it was erasing the pattern.
 *
 * FIX: cap the blur width used for EACH axis's own smoothstep at half that
 * axis's thinnest relevant feature — `min(mullion, frame)` for the spoke
 * axis, `mullion` for the arc axis (sill/head are one-sided boundaries, not
 * thin bars, so they are not vulnerable to this same failure). This
 * GUARANTEES a bar's own centre reaches the smoothstep's true zero-crossing
 * (`gobo == 0` exactly) regardless of `dist01` — blur can still soften an
 * EDGE, growing right up to that cap as `dist01` rises (the author's own
 * rule, preserved), but can never grow wide enough to swallow the feature
 * whose edge it is softening. `computeApertureSoftPx`'s own raw curve is
 * unchanged; this caps its OUTPUT, per axis, before it reaches `smoothstep01`.
 *
 * @param {{x:number,y:number}} P
 * @param {object} aperture
 * @param {number} h
 * @param {number} dist01
 * @param {{wallLen:number, cols:number, rows:number, frame:number, mullion:number, sillPx:number, headPx:number, softFarPx:number, reachSoftFarPx?:number, wallThicknessPx?:number, edgeSuppressPercent?:number, dimRadiusFadeStartPercent?:number, dimRadiusFadeEndPercent?:number}} windowParams
 * @param {number} [extraSpokeOffsetPx=0] - round 13 (2026-08-04): ADDED to
 *   `sW` before the spoke gate, the seam `computeApertureGlassWarpOffset`
 *   (below) feeds a nonzero value through — a glass-quality warp is "the
 *   mullion pattern itself looks distorted," which is exactly what shifting
 *   ITS OWN input coordinate produces, no new gate math needed. Zero-default:
 *   every caller/test that predates round 13 is byte-identical.
 * @returns {{applicable:boolean, gobo:number}}
 */
export function computeApertureGoboTerm(P, aperture, h, dist01, windowParams, extraSpokeOffsetPx = 0) {
  const proj = projectFloorPointToWindow(P, aperture);
  if (!proj) return { applicable: false, gobo: 1 };

  const soft = computeApertureSoftPx(dist01, windowParams.softFarPx);
  const warpedSW = proj.sW + (Number.isFinite(extraSpokeOffsetPx) ? extraSpokeOffsetPx : 0);
  const spokeGate = computeApertureSpokeGate(warpedSW, {
    wallLen: windowParams.wallLen,
    cols: windowParams.cols,
    mullion: windowParams.mullion,
    frame: windowParams.frame,
    // THE REVEAL (round 12) — sL/a come from THIS aperture, not windowParams
    // (which is shared shape/blur data, the same object every aperture on
    // this light reuses) — see computeApertureRevealNarrowing's own header.
    sL: aperture.sL,
    a: aperture.a,
    wallThicknessPx: windowParams.wallThicknessPx,
  });
  const arcGate = computeApertureArcGate(proj.x, {
    a: aperture.a,
    h,
    sillPx: windowParams.sillPx,
    headPx: windowParams.headPx,
    rows: windowParams.rows,
    mullion: windowParams.mullion,
  });
  // THE CONTRAST FLOOR (this function's own header) — never let blur grow
  // wider than half the thinnest feature it would otherwise swallow whole.
  const spokeSoftNear = Math.min(soft, Math.max(Math.min(windowParams.mullion, windowParams.frame) / 2, 0.5));
  const arcSoftNear = Math.min(soft, Math.max(windowParams.mullion / 2, 0.5));
  // THE REACH BLUR (`REACH_SOFT_FAR_PX_BASE`'s own header) — a SECOND,
  // independent growth signal, keyed on how far THIS fragment sits through
  // the aperture's own geometric depth (wall to the window-head's reach
  // limit), not on `dist01`. `Math.max` against the contrast-preserving
  // value above: near the window this is ~0 and the existing near-field
  // behaviour (already confirmed live) wins unchanged; far into the beam it
  // grows past the small contrast floor and dominates, genuinely diffusing
  // the whole pattern — including the sill/head boundary itself, which is
  // what turns that boundary's own former hard cliff into a real, visible
  // fade.
  const xHeadReach = computeApertureRowBoundaryX({ a: aperture.a, h, z: windowParams.headPx });
  const reachSoft = computeApertureReachSoftPx(proj.x, xHeadReach, windowParams.reachSoftFarPx);
  const spokeSoft = Math.max(spokeSoftNear, reachSoft);
  const arcSoft = Math.max(arcSoftNear, reachSoft);
  const spokeOpen = smoothstep01(-spokeSoft, spokeSoft, spokeGate);
  const arcOpen = smoothstep01(-arcSoft, arcSoft, arcGate);
  const gobo = Math.min(spokeOpen, arcOpen);
  // THE DIM-RADIUS FADE (this module's own DIM_RADIUS_FADE_START header) —
  // pull the pattern's own contrast back toward neutral (1) before the
  // light's hard mesh boundary at dist01==1, so nothing visible collides
  // with that edge. An AFFINE blend (`gobo*(1-t)+t`), so applying it here,
  // per aperture, is provably identical to applying it once after
  // `computeApertureGoboForLight`'s own max-combine — max commutes with any
  // positive-slope affine transform of every input by the SAME t.
  const t = smoothstep01(DIM_RADIUS_FADE_START, 1, Number.isFinite(dist01) ? dist01 : 0);
  const fadedGobo = gobo + (1 - gobo) * t;

  // ============================================================================
  // EDGE SUPPRESSION — round 17/18/19 (2026-08-04), `edgeSuppressPercent`/
  // `dimRadiusFadeStartPercent`/`dimRadiusFadeEndPercent`'s own header
  // (`APERTURE_GOBO_DEFAULTS`, above) has the full story: a DIRECT,
  // GUARANTEED, opt-in darkening toward TRUE ZERO near any of this
  // aperture's own outer edges, on top of (never instead of) everything
  // above. Deliberately DARKENS (multiplies toward 0), not neutralises the
  // way `DIM_RADIUS_FADE_START` does above — the two compose cleanly in
  // either order: near the dim radius, the pattern has already washed out
  // to neutral (`fadedGobo≈1`) and THIS term is what actually pulls the
  // final brightness down to true black there, independent of whatever
  // Foundry's own attenuation curve is or isn't doing on a given machine.
  //
  // PERCENTAGE, round 19 — TWO axes, normalized SEPARATELY against their
  // OWN natural span, not one shared px value: the spoke axis's own
  // half-span is `wallLen/2 - frame` (the open half-width past the frame,
  // the largest value `frameDistPx` can ever take), the arc axis's own
  // span is `xHead - xSill` (this aperture's own geometric depth,
  // identical to `REACH_SOFT_FAR_PX_BASE`'s own reference quantity).
  // Neither axis's own width leaks into the other's — a wide, short window
  // and a narrow, tall one suppress proportionally on EACH axis, not
  // averaged into one number that would be wrong for both.
  // ============================================================================
  let windowEdgeSuppress = 1;
  if (Number.isFinite(windowParams.edgeSuppressPercent) && windowParams.edgeSuppressPercent > 0) {
    const xSill = computeApertureRowBoundaryX({ a: aperture.a, h, z: windowParams.sillPx });
    const xHead = computeApertureRowBoundaryX({ a: aperture.a, h, z: windowParams.headPx });
    const reveal = computeApertureRevealNarrowing({
      sL: aperture.sL,
      a: aperture.a,
      wallLen: windowParams.wallLen,
      wallThicknessPx: windowParams.wallThicknessPx,
    });
    const frameDistPx = computeApertureFrameOnlyGate(warpedSW, {
      wallLen: windowParams.wallLen,
      frame: windowParams.frame,
      loExtra: reveal.loExtra,
      hiExtra: reveal.hiExtra,
    });
    const sillHeadDistPx = computeApertureSillHeadOnlyGate(proj.x, xSill, xHead);
    const pct = Math.min(100, windowParams.edgeSuppressPercent) / 100;
    const spokeHalfSpan = Math.max(windowParams.wallLen / 2 - windowParams.frame, 1e-3);
    const frameSuppressWidthPx = Math.max(pct * spokeHalfSpan, 1e-3);
    const frameSuppress = smoothstep01(0, frameSuppressWidthPx, frameDistPx);
    // The arc axis's own span (`xHead - xSill`) is only meaningful when BOTH
    // boundaries are finite — `xHead === Infinity` is a real, common,
    // non-degenerate state (the window's own head is geometrically
    // unreachable at this lamp height, i.e. "no head limit at all", NOT "no
    // light reaches here" — `computeApertureRowBoundaryX`'s own header has
    // the geometry), so there is no finite depth to suppress a fraction OF;
    // this axis simply has no outer edge to soften in that configuration.
    const sillHeadSuppress =
      Number.isFinite(xHead) && Number.isFinite(xSill)
        ? smoothstep01(0, Math.max(pct * Math.max(xHead - xSill, 1e-3), 1e-3), sillHeadDistPx)
        : 1;
    windowEdgeSuppress = Math.min(frameSuppress, sillHeadSuppress);
  }

  // DIM-RADIUS SUPPRESSION, round 18 — TWO independent percentages of the
  // light's own dim radius (`dist01*100`), not one auto-anchored fraction
  // (round 17's own `dimRadiusSuppressFraction`, retired — see
  // `APERTURE_GOBO_DEFAULTS`'s own "DIM-RADIUS SUPPRESSION, ROUND 18"
  // header for the author's own exact ask this replaces it with). Sorted
  // rather than assumed-ordered — `startPercent`/`endPercent` name WHICH
  // ANCHOR is which conceptually ("start" = where suppression is
  // strongest, "end" = where it fades away, matching the author's own
  // words), not which is numerically larger, so entering them either way
  // round produces the same gradient. Equal (or non-finite) anchors are a
  // genuine, exact no-op — `dist01` never exceeds `[0,1]` in practice (the
  // light's own mesh terminates at `dist01==1`), so a ZERO-WIDTH band
  // sitting at the default 100/100 (both map to `dist01==1`, the true
  // edge) is never crossed by any rendered fragment, matching this
  // function's own established "0/default = costs nothing, changes
  // nothing" discipline in this new unit.
  let dimRadiusSuppress = 1;
  const startPct = Number.isFinite(windowParams.dimRadiusFadeStartPercent)
    ? windowParams.dimRadiusFadeStartPercent
    : 100;
  const endPct = Number.isFinite(windowParams.dimRadiusFadeEndPercent) ? windowParams.dimRadiusFadeEndPercent : 100;
  const loFrac = Math.max(0, Math.min(startPct, endPct) / 100);
  const hiFrac = Math.min(1, Math.max(startPct, endPct) / 100);
  if (hiFrac > loFrac) {
    dimRadiusSuppress = 1 - smoothstep01(loFrac, hiFrac, Number.isFinite(dist01) ? dist01 : 0);
  }

  return { applicable: true, gobo: fadedGobo * windowEdgeSuppress * dimRadiusSuppress };
}

/**
 * THE LIGHT-LEVEL COMBINE — `max` over every APPLICABLE aperture
 * (`docs/planning/Aperture-Gobo.md` §6.1: alternative light paths are a
 * union, never a product — a product would double-shadow a pixel lit through
 * two windows). `applicable:false` apertures are EXCLUDED from the combine
 * entirely, never folded in as a neutral 1 — an earlier draft of this
 * reasoning tried "inapplicable reads as 1, max as normal" and it is
 * actually WRONG: with two+ apertures per light, a point genuinely lit
 * (and mullion-shadowed) through window B, but on the interior side of
 * window A's own infinite line, would let A's neutral 1 win the max over
 * B's real, darker value — erasing a real shadow the moment a second window
 * exists on the same light. The fix is a real "no opinion" exclusion, not a
 * neutral value fed into the same reduction. UNCHANGED by design 4.
 *
 * A light with ZERO applicable apertures at this point (by far the common
 * case — most of a room's own floor is not being viewed "through" any
 * window) reads as 1, fully unmodulated — fail-open,
 * `feedback_gate_polarity_must_fail_open`.
 *
 * @param {{x:number,y:number}} P
 * @param {object[]} apertures - this light's own oriented apertures (`findAperturesForLight`).
 * @param {number} h
 * @param {number} dist01
 * @param {object} windowParams
 * @returns {number} 0..1, 1 = unmodulated.
 */
export function computeApertureGoboForLight(P, apertures, h, dist01, windowParams) {
  if (!apertures || apertures.length === 0) return 1;
  let anyApplicable = false;
  let runningMax = 0;
  for (const aperture of apertures) {
    const { applicable, gobo } = computeApertureGoboTerm(P, aperture, h, dist01, windowParams);
    if (!applicable) continue;
    anyApplicable = true;
    if (gobo > runningMax) runningMax = gobo;
  }
  return anyApplicable ? runningMax : 1;
}

// ============================================================================
// GLASS QUALITY & GRIME — round 13 (2026-08-04)
// ============================================================================
// The author, "have some fun with it": (1) medieval glass was often either
// cheap rounded/blob-like panes or, for quality work, angled cut/faceted
// glass — "a slight refraction and RGB shift... a slider to swap between"
// the two; (2) "lots of grime where lots of different types of noise could
// combine", plus occasional broken panes, both under ONE amount slider.
//
// SPLIT DELIBERATELY from `computeApertureGoboTerm` above, not folded into
// it: every function below takes NOISE/HASH VALUES as plain-number inputs
// (`blobNoise`, `fbmValue`, `worleyValue`, ...) rather than sampling noise
// itself — this file is pure CPU arithmetic with NO THREE/TSL (its own
// header's standing rule), and this codebase's own noise toolkit
// (`animations/tsl-noise-toolkit.js` — MaterialX-backed `mx_noise_float`/
// `mx_fractal_noise_float`/`mx_worley_noise_float`) is GPU-only, no CPU
// twin, matching how every OTHER noise-driven animation in this codebase
// already treats it (trusted, vendored, un-reimplemented). What CAN and
// DOES stay CPU-testable here is everything noise FEEDS INTO: the pane
// index a floor point falls in, the hash a "which panes are broken"
// decision is made from, the blend/combine formulas, and the crack
// geometry — `aperture-gobo-render.js`'s own TSL port supplies the REAL
// noise values these functions consume, mirroring the "CPU twin is the
// spec" discipline this file already follows for `computeApertureGoboTerm`
// itself, one level up: the noise SAMPLING is untested (trusted vendored
// GPU code); the LOGIC around it is.
//
// `computeApertureGoboTerm` itself gained exactly ONE new, zero-default
// parameter (`extraSpokeOffsetPx`) rather than being rewritten — every
// EXISTING call site and test is byte-identical (offset 0 is a no-op); the
// glass warp below is what supplies a NONZERO offset when a caller wants it.
// Grime darkening and cracks are OUTSIDE `computeApertureGoboTerm` entirely
// — they scale/override its own returned `gobo`, the same "small satellite
// function, composed by the caller" shape as everything else in this file.

/** Hard cap on how many of a light's own panes can ever be "broken" at
 * `grimeAmount=1` — kept well under 1 so a fully grimy window still reads
 * as a real (if neglected) window, not a wall with no glass left in it. */
export const MAX_PANE_BREAK_CHANCE = 0.25;

/** Noise sample scale for the BLOB warp kernel, in scene px — large relative
 * to a typical pane (`paneWidthPx` defaults to 80), so one pane sees roughly
 * a single smooth wave, not a busy ripple — "old, uneven blown glass". */
export const BLOB_WARP_SCALE_PX = 60;

/** How many angular WEDGES the faceted kernel divides one pane into, radiating
 * from that pane's own centre — round 14 (2026-08-04), replacing the
 * original random-per-cell version (`computeApertureFacetWedgeValue`'s own
 * header has the full story). 8 reads as a genuine cut-glass medallion —
 * enough wedges to look deliberate, few enough that each is still a real,
 * legible facet, not a busy noise field. Not a knob — window GEOMETRY
 * (`glassQuality`/`distortionPx`) is exposed, this is closer to the blur
 * law's own "model, not art" constants. */
export const FACET_WEDGE_COUNT = 8;

/** Noise sample scales for grime's own two noise LAYERS
 * (`computeApertureGrimeFactor`'s own header) — large soft PATCHES, a finer
 * cellular GRIT on top. Deliberately DIFFERENT from the glass-warp scales
 * above: grime and warp are unrelated phenomena (dirt sitting ON the glass
 * vs. the glass's own optical shape) and sampling them at the same
 * frequency would make them read as the same pattern doing two jobs. */
export const GRIME_PATCH_SCALE_PX = 35;
export const GRIME_GRIT_SCALE_PX = 9;

/** Perpendicular half-width of a crack LINE before it fades to closed, in
 * scene px — deliberately thin (comparable to `mullion`'s own default 6). */
export const CRACK_WIDTH_PX = 1.5;

/**
 * A small, deterministic 2D hash — SAME formula as this codebase's own
 * established `hash12` idiom (`specular-pattern.js`), reused rather than
 * reinvented so this file's hash and the render file's TSL port are the
 * SAME well-worn constants, not a fresh, unverified pair. Small integer
 * inputs (pane indices, a handful of fixed salts) stay far inside the range
 * that keeps `sin()` well-conditioned — see `feedback_raw_seed_into_noise_
 * coordinate` for what happens when a hash/noise input is allowed to grow
 * unbounded instead (a DIFFERENT function, `mx_noise_float`, but the same
 * class of trap: keep hash/noise COORDINATES small by construction).
 *
 * @param {number} x @param {number} y
 * @returns {number} `[0, 1)`, deterministic for the same `(x,y)`.
 */
export function computeApertureHash2(x, y) {
  const xs = Number.isFinite(x) ? x : 0;
  const ys = Number.isFinite(y) ? y : 0;
  const s = Math.sin(xs * 12.9898 + ys * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Which PANE (not mullion) a window-plane point `(sW, z)` falls inside —
 * the same `floor(sW * cols / wallLen)` / `floor((z-sillPx) * rows / span)`
 * a mullion's own centre position (`k*wallLen/cols`, `sillPx + j*span/rows`
 * in `computeApertureSpokeGate`/`computeApertureArcGate`) already implies,
 * just read off directly rather than re-derived per caller. Stable and
 * INTEGER — the natural seed for `computeApertureHash2` (a "which pane is
 * this" decision must return the SAME pane every frame, not a fresh roll).
 *
 * @param {object} args
 * @param {number} args.sW @param {number} args.z
 * @param {number} args.wallLen @param {number} args.cols @param {number} args.rows
 * @param {number} args.sillPx @param {number} args.headPx
 * @returns {{colIndex: number, rowIndex: number}} both clamped to `[0, cols-1]`/`[0, rows-1]`.
 */
export function computeAperturePaneIndex({ sW, z, wallLen, cols, rows, sillPx, headPx }) {
  const wl = Math.max(Number.isFinite(wallLen) ? wallLen : 1, 1e-3);
  const c = Math.max(1, Math.floor(Number.isFinite(cols) ? cols : 1));
  const r = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 1));
  const colIndex = Math.min(c - 1, Math.max(0, Math.floor(((Number.isFinite(sW) ? sW : 0) / wl) * c)));
  const span = Math.max((Number.isFinite(headPx) ? headPx : 1) - (Number.isFinite(sillPx) ? sillPx : 0), 1e-3);
  const rowIndex = Math.min(
    r - 1,
    Math.max(0, Math.floor((((Number.isFinite(z) ? z : 0) - (Number.isFinite(sillPx) ? sillPx : 0)) / span) * r))
  );
  return { colIndex, rowIndex };
}

/**
 * A pane's own faceted "cut glass" bevel — round 14 (2026-08-04), replacing
 * a random-per-cell hash offset. The author, after seeing the original: *"I
 * have presented an image [a real leaded/beveled stained-glass panel] showing
 * you the absolute most extreme end of what I have in mind... in a simple
 * enough manner to look like medieval decoration."* The ORIGINAL faceted
 * kernel (`computeApertureHash2` over a quantized grid) genuinely read as
 * SHATTERED — chaotic, no two neighbouring cells related — where real cut/
 * beveled glass is the opposite: an ORDERED, SYMMETRIC pattern radiating
 * from a real centre, each facet a deliberate, legible cut, not a random
 * jump. This divides ONE pane into `FACET_WEDGE_COUNT` angular wedges
 * around ITS OWN centre (`atan2(localZ, localSW)`, where `local*` are
 * ALREADY relative to that centre — the caller's job, matching
 * `computeAperturePaneIndex`'s own pane-centre derivation) and alternates a
 * value by wedge PARITY — a simple, deterministic sunburst/medallion, not a
 * noise field. "Simple enough" by deliberate choice: no second ring, no
 * per-wedge jitter — the decorative DIRECTION the reference photo points
 * at, not a literal attempt at its own ornate diamond medallion.
 *
 * @param {object} args
 * @param {number} args.localSW @param {number} args.localZ - THIS point's
 *   own `(sW,z)`, relative to its pane's own centre (i.e. already
 *   `sW - paneCentreSW`, `z - paneCentreZ`).
 * @param {number} [args.wedgeCount] - defaults to `FACET_WEDGE_COUNT`.
 * @returns {number} `0` or `1` — alternates by wedge parity, the SAME
 *   `[0,1)`-shaped value `computeApertureGlassWarpOffset`'s own `facetValue`
 *   parameter already expected from the retired hash-based version.
 */
export function computeApertureFacetWedgeValue({ localSW, localZ, wedgeCount = FACET_WEDGE_COUNT }) {
  const wedges = Math.max(1, Math.floor(Number.isFinite(wedgeCount) ? wedgeCount : FACET_WEDGE_COUNT));
  const angle = Math.atan2(Number.isFinite(localZ) ? localZ : 0, Number.isFinite(localSW) ? localSW : 0);
  // `atan2` already returns `(-π,π]` — a plain `+π` shift lands that in
  // `(0,2π]`, deliberately chosen over a `((angle%2π)+2π)%2π` wrap: this
  // ONE-STEP shift is what `aperture-gobo-render.js`'s own TSL port uses
  // too (no `mod`-equivalent needed), so CPU and TSL land the SAME raw
  // angle in the SAME wedge — "line-for-line port" only holds if both sides
  // use the literal same formula, not two normalizations that merely agree
  // on being "a" valid wrap. WHERE wedge 0 starts is an arbitrary rotation
  // either way — this pattern has no canonical "up".
  const twoPi = Math.PI * 2;
  const shiftedAngle = angle + Math.PI;
  const wedgeIndex = Math.min(wedges - 1, Math.floor((shiftedAngle / twoPi) * wedges));
  return wedgeIndex % 2 === 0 ? 1 : 0;
}

/**
 * ONE fragment's own spoke-axis (`sW`) offset from "Glass quality" —
 * `computeApertureGlassWarpOffset`'s own two kernels, blended:
 *   - BLOB (`quality->0`): `blobNoise` (a smooth Perlin/simplex sample,
 *     roughly `[-1,1]`, taken at `(sW,z)/BLOB_WARP_SCALE_PX` by the caller)
 *     scaled straight to px — a continuously-varying, wavy warp.
 *   - FACETED (`quality->1`): `facetValue` (`computeApertureFacetWedgeValue`,
 *     round 14 — an ORDERED angular-wedge parity, not a random hash)
 *     remapped `[0,1)` -> `[-1,1)` then scaled to px — ONE constant offset
 *     per wedge, a hard jump at each wedge boundary instead of a smooth
 *     curve — a symmetric medallion, "cut glass", not a shattered one.
 * Both kernels share the SAME output range (`±distortionPx`) so the blend
 * is a genuine crossfade in magnitude, not just in character.
 *
 * @param {object} args
 * @param {number} args.blobNoise @param {number} args.facetValue
 * @param {number} args.quality - `[0,1]`, 0=blob, 1=faceted.
 * @param {number} args.distortionPx - overall warp magnitude, scene px.
 * @returns {number} a signed px offset, added to `sW` before the spoke gate.
 */
export function computeApertureGlassWarpOffset({ blobNoise, facetValue, quality, distortionPx }) {
  const q = Math.min(1, Math.max(0, Number.isFinite(quality) ? quality : 0));
  const d = Number.isFinite(distortionPx) ? distortionPx : 0;
  const blob = (Number.isFinite(blobNoise) ? blobNoise : 0) * d;
  const facet = ((Number.isFinite(facetValue) ? facetValue : 0.5) * 2 - 1) * d;
  return blob * (1 - q) + facet * q;
}

/**
 * "Grime" — a `[0,1]` DARKENING multiplier applied to an already-computed
 * `gobo` (`finalGobo = gobo * computeApertureGrimeFactor(...)`), never
 * folded inside `computeApertureGoboTerm` itself: grime dirties the GLASS
 * a ray already passed the mullion/frame test through, it doesn't move
 * where the mullions/frame ARE. Two noise LAYERS combined, per the
 * author's own "lots of different types of noise" ask — large soft PATCHES
 * (`fbmValue`, roughly `[-1,1]`) dominate, a finer cellular GRIT layer
 * (`worleyValue`, a Worley distance metric, small near cell centres) adds
 * texture on top, weighted 70/30 so the patches read first and the grit
 * reads as detail, not noise-over-noise mush.
 *
 * @param {object} args
 * @param {number} args.fbmValue @param {number} args.worleyValue
 * @param {number} args.grimeAmount - `[0,1]`, the ONE exposed slider; 0 is
 *   an EXACT no-op (`=== 1`, not just close), same "the off state costs
 *   nothing and looks like nothing" discipline `strength`/`softness` follow.
 * @returns {number} `[grimeAmount ? 1-dirt01*grimeAmount : 1, 1]`.
 */
export function computeApertureGrimeFactor({ fbmValue, worleyValue, grimeAmount }) {
  const g = Math.min(1, Math.max(0, Number.isFinite(grimeAmount) ? grimeAmount : 0));
  if (g <= 0) return 1;
  const patch = Math.min(1, Math.max(0, (Number.isFinite(fbmValue) ? fbmValue : 0) * 0.5 + 0.5));
  const grit = Math.min(1, Math.max(0, Number.isFinite(worleyValue) ? worleyValue : 0));
  const dirt01 = Math.min(1, patch * 0.7 + grit * 0.3);
  return 1 - dirt01 * g;
}

/**
 * Is THIS pane broken? One `computeApertureHash2` roll per pane, salted so
 * it never collides with any OTHER per-pane draw (the crack geometry below
 * draws several more from the SAME `(colIndex,rowIndex)`, each its own
 * salt — `specular-render.js`'s own `anisotropicBlob` already establishes
 * this "one cell, several independently-salted hashes" idiom in this
 * codebase). Chance scales linearly with `grimeAmount` up to
 * `MAX_PANE_BREAK_CHANCE` — a filthy window plausibly has a cracked pane or
 * two; a spotless one (`grimeAmount=0`) never does (`0 * anything === 0`,
 * an exact, not approximate, no-op).
 *
 * @param {object} args
 * @param {number} args.colIndex @param {number} args.rowIndex
 * @param {number} args.grimeAmount - `[0,1]`.
 * @returns {boolean}
 */
export function computeAperturePaneIsBroken({ colIndex, rowIndex, grimeAmount }) {
  const g = Math.min(1, Math.max(0, Number.isFinite(grimeAmount) ? grimeAmount : 0));
  if (g <= 0) return false;
  const roll = computeApertureHash2((colIndex || 0) + 0.5, (rowIndex || 0) + 0.5);
  return roll < g * MAX_PANE_BREAK_CHANCE;
}

/**
 * ONE broken pane's own crack geometry — TWO line descriptors, hashed
 * (deterministically, per `(colIndex,rowIndex)`) rather than random-per-
 * frame, so a cracked pane holds the SAME crack every frame instead of
 * flickering. Each line's own origin is pulled toward the pane's own
 * centre (a real fracture epicentre reads more convincing than one pinned
 * to a corner), spanning a genuine fraction of the pane so the crack is
 * visible without one line swallowing the whole pane.
 *
 * @param {object} args
 * @param {number} args.colIndex @param {number} args.rowIndex
 * @param {number} args.paneWidthPx - THIS pane's own width, scene px.
 * @param {number} args.paneHeightPx - THIS pane's own height, scene px.
 * @returns {{originOffsetSW:number, originOffsetZ:number, angle:number, lengthPx:number}[]}
 *   length 2 — `originOffsetSW`/`originOffsetZ` are relative to the pane's
 *   OWN centre (the caller adds the pane's real centre `sW`/`z`).
 */
export function computeAperturePaneCrackGeometry({ colIndex, rowIndex, paneWidthPx, paneHeightPx }) {
  const cx = colIndex || 0;
  const cy = rowIndex || 0;
  const w = Math.max(Number.isFinite(paneWidthPx) ? paneWidthPx : 0, 0);
  const h = Math.max(Number.isFinite(paneHeightPx) ? paneHeightPx : 0, 0);
  const lines = [];
  // Distinct additive salts per draw, mirroring `specular-render.js`'s own
  // `anisotropicBlob` idiom — one cell, several independently-salted hashes.
  const originHashX = computeApertureHash2(cx + 3.1, cy + 7.9);
  const originHashY = computeApertureHash2(cx + 17.3, cy + 91.7);
  const originOffsetSW = (originHashX * 2 - 1) * w * 0.3;
  const originOffsetZ = (originHashY * 2 - 1) * h * 0.3;
  for (let i = 0; i < 2; i++) {
    const angleHash = computeApertureHash2(cx + 127.1 + i * 41.0, cy + 311.7 + i * 57.0);
    const lengthHash = computeApertureHash2(cx + 269.5 + i * 13.0, cy + 183.3 + i * 29.0);
    lines.push({
      originOffsetSW,
      originOffsetZ,
      angle: angleHash * Math.PI * 2,
      lengthPx: Math.max(w, h) * (0.35 + lengthHash * 0.35),
    });
  }
  return lines;
}

/**
 * ONE crack line's own openness contribution at a window-plane point
 * `(sW, z)` — perpendicular distance from the infinite line through
 * `(originSW, originZ)` at `angle`, hard-cut past `lengthPx` along it,
 * triangular falloff across `CRACK_WIDTH_PX` (never smoothstep — a crack
 * is a THIN gap, not a soft-shadowed edge; a broken pane's edge is real
 * glass ending, not a blurred boundary).
 *
 * @param {object} args
 * @param {number} args.sW @param {number} args.z
 * @param {number} args.originSW @param {number} args.originZ
 * @param {number} args.angle @param {number} args.lengthPx
 * @returns {number} `[0,1]`, 1 at the line's own centre.
 */
export function computeApertureCrackLineOpenness({ sW, z, originSW, originZ, angle, lengthPx }) {
  const dx = (Number.isFinite(sW) ? sW : 0) - (Number.isFinite(originSW) ? originSW : 0);
  const dz = (Number.isFinite(z) ? z : 0) - (Number.isFinite(originZ) ? originZ : 0);
  const dirX = Math.cos(angle);
  const dirZ = Math.sin(angle);
  const along = dx * dirX + dz * dirZ;
  if (Math.abs(along) > Math.max(lengthPx, 0)) return 0;
  const perp = Math.abs(dx * dirZ - dz * dirX);
  return Math.max(0, 1 - perp / CRACK_WIDTH_PX);
}

// THE VISIBILITY GATE — RETIRED (round 10, 2026-08-04). Rounds 1-8 lived
// here: `apertureLuminance`, `VISIBILITY_SATURATION_RATIO` (calibrated
// 3 → 1.5 → 1.2 across rounds 1/2/7), and `computeApertureShadowVisibility`
// (comparing this light's own peak illumination against ambient, gating a
// SEPARATE post-process shadow pass). That whole pass is gone —
// `aperture-gobo-render.js#buildApertureGoboTerm`'s own result now multiplies
// directly into `point-light-illumination.js`/`point-light-coloration.js`'s
// own falloff, before each material's single MAX-blend draw. MAX-blending
// against a correctly-computed `backgroundFloor` gives the identical
// "don't show when this light isn't dominant" property for free — a light
// too weak to matter simply loses the MAX contest against whatever else is
// already there, no separate gate needed. See `point-light-illumination.js`'s
// own "THE GOBO IS PART OF THIS LIGHT'S OWN FALLOFF" header for the
// live-found reason this gate existed in the first place could not actually
// be fixed from outside the MAX-blend hierarchy, and
// `docs/planning/Aperture-Gobo.md` §13 for the full eight-round history of
// this gate's own calibration, kept for the record.
