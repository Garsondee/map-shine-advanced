/**
 * APERTURE GOBO — the TSL transcription of `aperture-gobo.js`. THREE is
 * INJECTED, never imported. Read that module's header first — this file
 * assumes its vocabulary and mirrors its functions line-for-line; the CPU
 * twin is the spec, this is the port.
 *
 * ============================================================================
 * WHERE THIS LANDS — round 10 (2026-08-04): PART OF THE LIGHT'S OWN
 * MAX-BLEND, NOT A SEPARATE PASS
 * ============================================================================
 * Nine earlier rounds this same session tried the pattern as a SEPARATE
 * pass, drawn after `point-light-illumination.js`'s own material had already
 * MAX-blended into the shared buffer — first multiplying ONE light's own
 * falloff (design 1, structurally could only brighten, never darken below
 * ambient), then a genuine MULTIPLY pass with no floor (design 2, could
 * crush bright daytime ambient toward black), then blending toward
 * `backgroundFloor` with a visibility gate on top (design 3, this file's own
 * `buildApertureShadowMaterial` — DELETED this round). Design 3's own fatal
 * flaw, found live: `mix(backgroundFloor, dst, strengthed)` at a blocked
 * fragment collapses to EXACTLY `backgroundFloor`, no matter how `dst` (the
 * ALREADY-fully-composited scene — daylight, every other light, this
 * light's own corona) got to be bright. A live screenshot with the effect
 * toggled off showed a light's own wedge crossing a building's own cast
 * shadow with NO extra darkening — ordinary MAX behaviour; with the effect
 * on, the SAME wedge grew a visibly darker rim, because the separate pass
 * had no way to tell "this fragment is bright because of daylight" from
 * "this fragment is bright because of THIS light" — it just dragged
 * whatever was there down to this light's own local floor. Author: "parts
 * of the effect which darken should never be able to survive a direct
 * illumination from any other source... treat the effect as a type of
 * illumination but carefully mix it into the existing illumination."
 *
 * THE FIX: `buildApertureGoboTerm` below is now called DIRECTLY from
 * `point-light-illumination.js` and `point-light-coloration.js`, multiplying
 * its result into each material's own falloff/depth term BEFORE that
 * material's SINGLE MAX-blend draw — see `point-light-illumination.js`'s own
 * "THE GOBO IS PART OF THIS LIGHT'S OWN FALLOFF" header for the full
 * reasoning. This file no longer owns a compositing pass at all — it owns
 * only the PATTERN (the mullion/frame geometry math below), consumed by
 * whichever material needs it. The visibility-gate machinery design 3 grew
 * over rounds 1-8 (`aperture-gobo.js#computeApertureShadowVisibility`,
 * `VISIBILITY_SATURATION_RATIO`) is retired alongside it — MAX-blending
 * against a correctly-computed `backgroundFloor` gives the identical "don't
 * show when this light isn't dominant" property for free, which is why that
 * gate needed seven rounds to approximate from OUTSIDE the MAX-blend
 * hierarchy and MAX-blending gives it for free from inside.
 *
 * `docs/planning/Aperture-Gobo.md` §13 has the full nine-round designs 1-3
 * history in detail, for the record.
 *
 * ============================================================================
 * DESIGN 4 — MULLIONS AS BLOCKERS, NOT A PROJECTED IMAGE (2026-08-03)
 * ============================================================================
 * This part is UNCHANGED by round 10 — it's about WHAT the pattern computes,
 * orthogonal to WHERE it's consumed. `aperture-gobo.js`'s own "DESIGN 4"
 * header has the full derivation; the short version: Foundry's own
 * wall-clipped light polygon (`light.shapePoints`, confirmed against the
 * vendored `clockwise-sweep.mjs` source) already bounds a light's mesh to
 * the correct beam shape through a `light:PROXIMITY` window — so this file
 * never computes that outer shape at all. What's left is genuinely simple: a
 * vertical mullion blocks a fixed ANGULAR sliver (compared directly in
 * wall-space `sW`, no magnification — an angle doesn't need rescaling into
 * floor-space to be compared against another angle); a horizontal mullion
 * (or sill/head) blocks a RADIAL band, found by inverting
 * `z = h*(1-a/(a+x))` ONCE per boundary rather than computing a continuous
 * per-fragment height. No Jacobian, no `MAX_MAGNIFICATION`, no periodic grid
 * line — a plain JS `for` loop over each axis's OWN small, known-at-
 * build-time mullion count, the SAME unroll discipline `apertureCount`
 * itself already uses (see §6.0's landmine note below — this is still no
 * `Loop`, no `uniformArray`).
 *
 * `cols`/`rows` are GRAPH-BUILD-TIME JS integers (like `apertureCount`), NOT
 * live TSL uniforms. They control an UNROLL COUNT (how many mullion bands
 * get baked into the graph), not merely a value inside an already-fixed
 * structure, so they cannot safely stay uniforms without reaching for a TSL
 * `Loop`/`uniformArray` — exactly the landmine class
 * `feedback_tsl_select_chain_strands_vars` already burned this codebase
 * once. `cols`/`rows` changing value — whether from a live "Pane target
 * width/height" edit or simply a light's own aperture wall changing length
 * (round 11, 2026-08-04 — see `point-light-pool.js`'s own "PROCEDURAL PANE
 * COUNT" comment) — triggers a material rebuild (`point-light-pool.js`'s own
 * rebuild-key check) instead of a live uniform write — cheap, and the same
 * mechanism every OTHER structural param (`falloffModel`, `animationType`,
 * `apertureCount` itself) already uses.
 *
 * ============================================================================
 * ⚠️ §6.0 THE LANDMINE — READ THIS BEFORE TOUCHING THE MATH BELOW
 * ============================================================================
 * `point-light-illumination.js` still carries ONE fully-built, never-enabled
 * term — `edgeSoftFactor`, an analytic polygon SDF via a TSL `Loop` over a
 * `uniformArray`. Wiring it into that file's `combinedFalloff` was tried live
 * once and turned the WHOLE SCENE BLACK, all 79 active lights included, for a
 * cause never root-caused. That file's own header names the likely culprit
 * class: `Loop`/`uniformArray`/`Fn`-fold constructs have an independent
 * precedent in this codebase for exactly this failure shape
 * (`feedback_tsl_select_chain_strands_vars` — a fold that compiled to real
 * branches and stranded shared variables, blacking out 12 of 20 outputs).
 *
 * THIS MODULE DELIBERATELY USES NONE OF THAT MACHINERY. Aperture count,
 * `cols`, and `rows` are all small and known at graph-BUILD time (JS
 * integers, part of the material's own rebuild key) — so every fan-out below
 * (apertures, vertical mullions, horizontal mullions) is a plain JS `for`
 * loop that UNROLLS into straight-line arithmetic, the same shape
 * `layer-smear-render.js`'s own 32-station march already uses safely. No
 * `Loop`, no `uniformArray`, no uniform-bounded iteration, no `select()`
 * FOLD (the running max/anyApplicable accumulation below is `select()` used
 * as a per-iteration ternary on a scalar, never chained across branches the
 * way the stranded-variable trap needs). Still a live A/B question, not a
 * coin flip, if this reproduces a black screen — but nothing here matches
 * the known failure's own shape.
 *
 * @module effects/lighting/aperture-gobo-render
 */

import {
  APERTURE_GOBO_DEFAULTS,
  SOFT_NEAR_PX,
  SOFT_CURVE,
  SOFT_FAR_PX_BASE,
  REACH_SOFT_FAR_PX_BASE,
  DIM_RADIUS_FADE_START,
  MAX_MULLIONS_PER_AXIS,
  MAX_PANE_BREAK_CHANCE,
  BLOB_WARP_SCALE_PX,
  FACET_WEDGE_COUNT,
  GRIME_PATCH_SCALE_PX,
  GRIME_GRIT_SCALE_PX,
  CRACK_WIDTH_PX,
} from './aperture-gobo.js';
import { simplexFloat, fbmFloat, voronoiFloat } from './animations/tsl-noise-toolkit.js';

/**
 * A small, deterministic 2D hash — the TSL port of `aperture-gobo.js#
 * computeApertureHash2`, line-for-line (SAME constants, so the two are
 * provably the same function, not just similarly-shaped ones). Local to
 * this module (not exported) — every consumer of it lives in
 * `buildApertureGoboTerm` below.
 * @param {*} TSL @param {*} x @param {*} y - TSL float nodes.
 * @returns {*} a TSL float node, `[0,1)`.
 */
function tslHash2(TSL, x, y) {
  const { sin, fract, float } = TSL;
  return fract(sin(x.mul(float(12.9898)).add(y.mul(float(78.233)))).mul(float(43758.5453)));
}

/** Hard cap on apertures evaluated per light — matches `findAperturesForLight`'s
 * own default and, unlike `MAX_LIGHT_EDGES`, is not merely a buffer size: it
 * is the graph-build-time unroll count, so a light with `apertureCount`
 * apertures pays for exactly that many, never a fixed worst case. */
export const MAX_APERTURES_PER_LIGHT = APERTURE_GOBO_DEFAULTS.maxAperturesPerLight;

/**
 * Build the SHARED (one-per-pool, not one-per-light) generator + softness
 * uniforms every light's aperture term reads. Created ONCE by `point-light-
 * pool.js` at pool-construction time and threaded into every light's
 * illumination/coloration material build — the SAME sharing discipline
 * `uGlobalTimeMs` already uses, for the same reason: these are EFFECT-level
 * params (window geometry, softness), not per-light data.
 *
 * ⚠️ NO `uCols`/`uRows` here — they are GRAPH-BUILD-TIME JS integers, passed
 * directly into `buildApertureGoboTerm`, not shared uniforms — see this
 * module's own "DESIGN 4" header for why a live uniform can't safely control
 * an unroll count.
 *
 * `uStrength` is applied by the CALLER (each material mixes the combined
 * node toward 1 by `1-uStrength` before using it as its own falloff/depth
 * multiplier), not inside `buildApertureGoboTerm` itself — kept out of the
 * per-aperture math because it is a single, effect-wide dial with nothing
 * aperture-specific about it.
 *
 * @param {*} THREE
 * @param {typeof APERTURE_GOBO_DEFAULTS} [defaults]
 * @returns {{uSillPx:*, uHeadPx:*, uFrame:*, uMullion:*, uWallThicknessPx:*, uGlassQuality:*, uDistortionPx:*, uGrimeAmount:*, uSoftFarPx:*, uReachSoftFarPx:*, uEdgeSuppressPercent:*, uDimRadiusFadeStartPercent:*, uDimRadiusFadeEndPercent:*, uStrength:*}}
 */
export function createApertureGoboSharedUniforms(THREE, defaults = APERTURE_GOBO_DEFAULTS) {
  const { uniform, float } = THREE.TSL;
  return {
    uSillPx: uniform(float(defaults.sillPx)),
    uHeadPx: uniform(float(defaults.headPx)),
    uFrame: uniform(float(defaults.frame)),
    uMullion: uniform(float(defaults.mullion)),
    // THE REVEAL (round 12) — `computeApertureRevealNarrowing`'s own input.
    // 0 = disabled, byte-identical spoke gate to pre-round-12.
    uWallThicknessPx: uniform(float(defaults.wallThicknessPx ?? 0)),
    // GLASS QUALITY & GRIME (round 13) — `computeApertureGlassWarpOffset`/
    // `computeApertureGrimeFactor`'s own inputs. `uDistortionPx=0` or
    // `uGrimeAmount=0` are each an EXACT no-op through their own formula,
    // same discipline as `uWallThicknessPx` above.
    uGlassQuality: uniform(float(defaults.glassQuality ?? 0.5)),
    uDistortionPx: uniform(float(defaults.distortionPx ?? 0)),
    uGrimeAmount: uniform(float(defaults.grimeAmount ?? 0)),
    uSoftFarPx: uniform(float(SOFT_FAR_PX_BASE * defaults.softness)),
    // THE REACH BLUR (round 15) — `aperture-gobo.js#REACH_SOFT_FAR_PX_BASE`'s
    // own header. Scaled by the SAME `softness` dial as `uSoftFarPx` above,
    // so raising it grows both the near-field contrast-preserving curve AND
    // this far-field diffusion curve together, one slider.
    uReachSoftFarPx: uniform(float(REACH_SOFT_FAR_PX_BASE * defaults.softness)),
    // EDGE SUPPRESSION (round 17, rebuilt as a PERCENTAGE round 19) —
    // `aperture-gobo.js#APERTURE_GOBO_DEFAULTS`'s own header. 0 by
    // default — an EXACT no-op, opt-in.
    uEdgeSuppressPercent: uniform(float(defaults.edgeSuppressPercent ?? 0)),
    // DIM-RADIUS SUPPRESSION, round 18 — TWO independent percentage
    // anchors (`aperture-gobo.js#APERTURE_GOBO_DEFAULTS`'s own "DIM-RADIUS
    // SUPPRESSION, ROUND 18" header), replacing round 17's single
    // auto-anchored-to-the-edge fraction. Both default to 100 (a
    // zero-width band exactly at the true edge — an exact no-op).
    uDimRadiusFadeStartPercent: uniform(float(defaults.dimRadiusFadeStartPercent ?? 100)),
    uDimRadiusFadeEndPercent: uniform(float(defaults.dimRadiusFadeEndPercent ?? 100)),
    uStrength: uniform(float(defaults.strength)),
  };
}

/**
 * Clamp a live `cols`/`rows` value to a safe, small, non-negative integer —
 * the SAME clamp `aperture-gobo.js#computeApertureSpokeGate`/
 * `computeApertureArcGate` apply on the CPU side, mirrored here so a value
 * above `MAX_MULLIONS_PER_AXIS` can never unroll past it. Since round 11
 * (2026-08-04) `cols`/`rows` are DERIVED per-light from real `wallLen`/
 * `(headPx-sillPx)` (`point-light-pool.js`'s own "PROCEDURAL PANE COUNT"
 * comment), not read straight from a schema param — a sufficiently long
 * wall or small target pane size is exactly the kind of derived value that
 * could exceed this cap without this clamp, so it stays load-bearing.
 * @param {number} n @returns {number}
 */
function clampMullionCount(n) {
  return Math.max(0, Math.min(MAX_MULLIONS_PER_AXIS, Math.floor(Number.isFinite(n) ? n : 0)));
}

/**
 * Build ONE light's aperture-gobo TERM — a scalar node, 0..1, 1 = unmodulated
 * (fail-open). Returns `null` when `apertureCount` is 0 — a graph-build-time
 * JS branch (`tsl/no-uniform-gates`), so a windowless light (the overwhelming
 * common case) compiles NONE of this in and pays literally nothing.
 *
 * Consumers (round 10, 2026-08-04): `point-light-illumination.js` and
 * `point-light-coloration.js` each call this directly and multiply `.node`
 * into their OWN falloff/depth term, before their own single MAX-blend
 * draw — see this module's own "WHERE THIS LANDS" header for why. A
 * standalone debug visualization (`point-light-pool.js`'s
 * `apertureShadowDebugMesh`) also calls this directly, purely to render the
 * raw pattern as an opaque greyscale overlay.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.positionWorldXY - `positionWorld.xy` — the real fragment
 *   world position.
 * @param {*} args.dist - the light's own `length(positionLocal.xy)` —
 *   ALREADY, for free, "fraction of the way from the light's centre to its
 *   dim radius". Passed in rather than recomputed.
 * @param {number} args.apertureCount - 0..MAX_APERTURES_PER_LIGHT, resolved
 *   on the CPU by `aperture-gobo.js#findAperturesForLight` for THIS light.
 *   Graph-build-time: changes to this value are a material REBUILD key in
 *   `point-light-pool.js`, exactly like `falloffModel`/`animationType`.
 * @param {number} args.cols - GRAPH-BUILD-TIME vertical-mullion count (design
 *   4 — this module's own header explains why it's no longer a uniform).
 * @param {number} args.rows - GRAPH-BUILD-TIME horizontal-mullion count.
 * @param {{uSillPx:*, uHeadPx:*, uFrame:*, uMullion:*, uWallThicknessPx:*, uSoftFarPx:*}} args.shared -
 *   `createApertureGoboSharedUniforms`'s own return, SHARED across every
 *   light in the pool.
 * @returns {{node:*, anyApplicable:*, uLampHeight:*, apertures: Array<{uA:*, uDir:*, uNrm:*, uSLAWallLen:*}>}|null}
 *   `node` is the combined 0..1 gobo scalar; `uLampHeight` and each
 *   aperture's four uniforms are what the caller (`point-light-pool.js`)
 *   writes every frame from the CPU-resolved `findAperturesForLight` result.
 */
export function buildApertureGoboTerm({ THREE, positionWorldXY, dist, apertureCount, cols, rows, shared }) {
  if (!(apertureCount > 0)) return null;
  const count = Math.min(Math.floor(apertureCount), MAX_APERTURES_PER_LIGHT);
  const colsN = clampMullionCount(cols);
  const rowsN = clampMullionCount(rows);
  const { uniform, float, vec2, vec3, max, min, dot, clamp, smoothstep, select, cos, sin, atan, fract } = THREE.TSL;

  const uLampHeight = uniform(float(APERTURE_GOBO_DEFAULTS.defaultLampHeightPx));

  const apertures = [];
  let runningMax = float(0);
  let anyApplicable = float(0);

  for (let k = 0; k < count; k++) {
    const uA = uniform(vec2(0, 0));
    const uDir = uniform(vec2(1, 0));
    const uNrm = uniform(vec2(0, 1));
    // Packed (sL, a, wallLen) — three per-aperture scalars sharing one vec3
    // uniform rather than three separate ones, mirroring this codebase's own
    // preference for grouping related per-instance scalars.
    const uSLAWallLen = uniform(vec3(0, 10, 1));
    apertures.push({ uA, uDir, uNrm, uSLAWallLen });

    const sL = uSLAWallLen.x;
    const a = uSLAWallLen.y;
    const wallLen = uSLAWallLen.z;

    // ---- THE INVERSE PROJECTION (aperture-gobo.js#projectFloorPointToWindow) ----
    // `z` is GONE (design 4) — no per-fragment height computation exists any
    // more; a horizontal mullion is resolved via `computeApertureRowBoundaryX`
    // below instead, working directly in floor-space `x`.
    const rel = positionWorldXY.sub(uA).toVar(`apGoboRel${k}`);
    const s = dot(rel, uDir).toVar(`apGoboS${k}`);
    const x = dot(rel, uNrm).toVar(`apGoboX${k}`);
    const applicable = x.greaterThan(float(0));
    // Guarded denominator: every lane always evaluates (there is no branch),
    // including inapplicable ones (x<=0) — `max(x, epsilon)` keeps `inv`
    // finite there too, so `applicable` alone (not this arithmetic) decides
    // whether the lane's result is ever USED.
    const denom = a.add(max(x, float(1e-6)));
    const inv = a.div(denom).toVar(`apGoboInv${k}`);
    const sW = sL.add(s.sub(sL).mul(inv)).toVar(`apGoboSW${k}`);
    // `z` — THIS fragment's own position on the window-plane's HEIGHT axis
    // (aperture-gobo.js#computeApertureHeightFromX, the FORWARD of
    // computeApertureRowBoundaryX above — round 13 needs an actual `z`, not
    // just a row-BOUNDARY inversion, to place a fragment on the glass's own
    // `(sW,z)` plane for the pane index / warp / grime / crack math below).
    // Same branchless epsilon-guard idiom as `inv`'s own denominator.
    const z = uLampHeight
      .mul(x)
      .div(max(a.add(x), float(1e-6)))
      .toVar(`apGoboZ${k}`);

    // ---- PANE INDEX (aperture-gobo.js#computeAperturePaneIndex, round 13,
    // moved earlier in round 14 — the facet warp below now needs a pane's
    // own CENTRE too, not just grime/cracks further down) ---- which PANE
    // (not mullion) this fragment falls inside, from the UNWARPED `(sW,z)`
    // — a pane's own identity doesn't move with the glass's own optical
    // distortion. `colsN`/`rowsN` may legitimately be 0 (`colsN<2` needs no
    // special case for the MULLION loop above, since it just runs zero
    // times) — but 0 would divide-by-zero HERE, a divisor this section
    // introduces, so `paneCols`/`paneRows` floor at 1 for indexing purposes
    // only, JS-side, graph-build-time, free.
    const paneCols = Math.max(colsN, 1);
    const paneRows = Math.max(rowsN, 1);
    const colIndexF = clamp(sW.div(wallLen).mul(paneCols).floor(), float(0), float(paneCols - 1));
    const rowSpan = max(shared.uHeadPx.sub(shared.uSillPx), float(1e-3));
    const rowIndexF = clamp(z.sub(shared.uSillPx).div(rowSpan).mul(paneRows).floor(), float(0), float(paneRows - 1));
    const paneWidthPx = wallLen.div(paneCols);
    const paneHeightPx = rowSpan.div(paneRows);
    const paneCentreSW = colIndexF.add(0.5).mul(paneWidthPx);
    const paneCentreZ = shared.uSillPx.add(rowIndexF.add(0.5).mul(paneHeightPx));

    // ---- GLASS QUALITY WARP (aperture-gobo.js#computeApertureGlassWarpOffset,
    // round 13; FACETED kernel redesigned round 14 — the author, on the
    // original random-per-cell version: "I have presented an image [a real
    // beveled stained-glass panel]... in a simple enough manner to look like
    // medieval decoration", i.e. ORDERED, not shattered) ---- perturbs `sW`
    // (NOT `z`/`x` — the spoke/mullion axis is this pattern's own DOMINANT
    // visual feature; warping only it is a named simplification, not a
    // silent one) BEFORE the spoke gate below, so the mullion pattern
    // itself reads as seen through distorted glass. Sampled at the
    // UNWARPED `(sW,z)` — a real point ON the glass, not a moving target.
    // Two kernels blended by `uGlassQuality`, mirroring the CPU twin's own
    // two-kernel blend exactly:
    //   - BLOB (`quality->0`): a smooth Perlin sample (`simplexFloat`,
    //     `tsl-noise-toolkit.js`) at `(sW,z)/BLOB_WARP_SCALE_PX` — a
    //     continuously-varying, wavy warp ("old, uneven blown glass").
    //   - FACETED (`quality->1`): `aperture-gobo.js#computeApertureFacetWedgeValue`'s
    //     own TSL port — `(sW,z)` relative to ITS OWN PANE'S centre,
    //     divided into `FACET_WEDGE_COUNT` angular wedges via `atan(z,sW)`
    //     (the SAME 2-arg atan2 convention `tsl-noise-toolkit.js#pie` already
    //     uses), alternating a constant offset by wedge PARITY — an ORDERED
    //     sunburst/medallion, not a random hash. `fract(wedgeIndex*0.5)`
    //     reads 0 for an even index, 0.5 for odd — a parity test with no
    //     `mod()` needed (unconfirmed in this TSL build), thresholded at
    //     0.25. The SAME `+π` shift (not a `mod`-based wrap) as the CPU
    //     twin — see that function's own header for why the two sides must
    //     use the LITERAL same formula, not merely equivalent ones.
    const warpSamplePos = vec2(sW.div(float(BLOB_WARP_SCALE_PX)), z.div(float(BLOB_WARP_SCALE_PX)));
    const blobNoise = simplexFloat(THREE.TSL, warpSamplePos);
    const localSW = sW.sub(paneCentreSW);
    const localZ = z.sub(paneCentreZ);
    const facetAngle = atan(localZ, localSW);
    const facetShiftedAngle = facetAngle.add(float(Math.PI));
    const facetWedgeIndex = min(
      float(FACET_WEDGE_COUNT - 1),
      facetShiftedAngle
        .div(float(Math.PI * 2))
        .mul(float(FACET_WEDGE_COUNT))
        .floor()
    );
    const facetValue = select(fract(facetWedgeIndex.mul(0.5)).greaterThan(float(0.25)), float(0), float(1));
    const blobOffset = blobNoise.mul(shared.uDistortionPx);
    const facetOffset = facetValue.mul(2).sub(1).mul(shared.uDistortionPx);
    const warpOffset = blobOffset.mul(float(1).sub(shared.uGlassQuality)).add(facetOffset.mul(shared.uGlassQuality));
    const warpedSW = sW.add(warpOffset).toVar(`apGoboWarpedSW${k}`);

    // ---- THE REVEAL (aperture-gobo.js#computeApertureRevealNarrowing,
    // round 12) ---- `a` is already clamped `>= MIN_WALL_DISTANCE_PX` on the
    // CPU side (`orientApertureToLight`) before ever reaching this uniform,
    // so dividing by it directly here is safe, no epsilon guard needed
    // (mirrors every OTHER direct use of `a` in this function). Branchless
    // by construction, not by an added guard: `uWallThicknessPx==0` makes
    // `revealRaw` exactly 0 regardless of `tanTheta`, so "disabled" falls out
    // of the arithmetic itself rather than a separate select().
    const centre = wallLen.mul(0.5);
    const tanTheta = sL.sub(centre).div(a);
    const revealRaw = shared.uWallThicknessPx.mul(tanTheta.abs());
    const reveal = min(revealRaw, max(centre.sub(float(1e-3)), float(0)));
    const loExtra = select(tanTheta.greaterThan(float(0)), reveal, float(0));
    const hiExtra = select(tanTheta.lessThan(float(0)), reveal, float(0));

    // ---- THE SPOKE GATE (aperture-gobo.js#computeApertureSpokeGate) ----
    // Positive = open glass, negative = blocked (frame casing or a mullion
    // bar). Two DIFFERENT interval shapes on purpose — the frame's open
    // region is INSIDE [frame, wallLen-frame]; a mullion bar's open region is
    // OUTSIDE its own [lo,hi] span (see the CPU twin's own header for why
    // using the wrong shape for either would silently invert its sense).
    // `colsN < 2` needs no special case: the loop below runs zero times.
    // `frame` widens asymmetrically by the reveal above — `loExtra`/
    // `hiExtra` are 0/0 whenever the reveal is disabled or the light stands
    // dead-centre, byte-identical to the pre-round-12 symmetric formula.
    // `warpedSW` (not bare `sW`) — round 13's glass-quality warp, computed
    // above; `warpOffset==0` (distortionPx=0) makes this byte-identical to
    // pre-round-13 too.
    let spokeGate = min(
      warpedSW.sub(shared.uFrame.add(loExtra)),
      wallLen.sub(shared.uFrame.add(hiExtra)).sub(warpedSW)
    );
    for (let colK = 1; colK < colsN; colK++) {
      const center = wallLen.mul(colK / colsN);
      const lo = center.sub(shared.uMullion.div(2));
      const hi = center.add(shared.uMullion.div(2));
      spokeGate = min(spokeGate, max(lo.sub(warpedSW), warpedSW.sub(hi)));
    }
    spokeGate = spokeGate.toVar(`apGoboSpokeGate${k}`);

    // ---- THE ARC GATE (aperture-gobo.js#computeApertureArcGate /
    // computeApertureRowBoundaryX) ---- Same positive-open convention, one
    // dimension over, in floor-space `x`. `rowBoundaryX(z)` inverts
    // `z = h*(1-a/(a+x))` for `x` — guarded exactly like `inv`'s own
    // denominator above: when `h<=z` (this height is at/above the lamp,
    // never reached at any finite x), `max(h-z, epsilon)` floors the
    // denominator at a tiny positive value, so the division produces a
    // GENUINELY HUGE (not NaN/Inf) floor-space `x` — the same branchless
    // "large sentinel" idiom this file already uses, not a new one.
    const rowBoundaryX = (zVal) => a.mul(zVal).div(max(uLampHeight.sub(zVal), float(1e-6)));
    const xSill = rowBoundaryX(shared.uSillPx);
    const xHead = rowBoundaryX(shared.uHeadPx);
    let arcGate = min(x.sub(xSill), xHead.sub(x));
    for (let rowJ = 1; rowJ < rowsN; rowJ++) {
      const zj = shared.uSillPx.add(shared.uHeadPx.sub(shared.uSillPx).mul(rowJ / rowsN));
      const xLo = rowBoundaryX(zj.sub(shared.uMullion.div(2)));
      const xHi = rowBoundaryX(zj.add(shared.uMullion.div(2)));
      arcGate = min(arcGate, max(xLo.sub(x), x.sub(xHi)));
    }
    arcGate = arcGate.toVar(`apGoboArcGate${k}`);

    // ---- THE BLUR LAW (aperture-gobo.js#computeApertureSoftPx) — `dist` is
    // the light's OWN dist01, free. ----
    const t01 = clamp(dist, float(0), float(1));
    const soft = float(SOFT_NEAR_PX).add(shared.uSoftFarPx.sub(float(SOFT_NEAR_PX)).mul(t01.pow(float(SOFT_CURVE))));
    // ---- THE CONTRAST FLOOR (aperture-gobo.js#computeApertureGoboTerm's own
    // "THE CONTRAST FLOOR" header — found live, first look at design 4: blur
    // wide enough to swallow a bar whole reads as "no pattern at all", not
    // "a soft pattern"). Never let blur grow past half the thinnest feature
    // it would otherwise erase — `min(mullion,frame)` for the spoke axis,
    // `mullion` for the arc axis. ----
    const spokeSoftNear = min(soft, max(min(shared.uMullion, shared.uFrame).div(2), float(0.5)));
    const arcSoftNear = min(soft, max(shared.uMullion.div(2), float(0.5)));
    // ---- THE REACH BLUR (aperture-gobo.js#REACH_SOFT_FAR_PX_BASE, round 15)
    // ---- a SECOND, independent blur-width contributor, keyed on `x/xHead`
    // (how far THIS fragment sits through the aperture's own geometric
    // depth) rather than `dist01` — see that constant's own header for the
    // live-diagnosed reason `dist01` alone left the arc gate's own sill/head
    // boundary reading as a hard, un-blurred wall regardless of attenuation.
    // `max` against the contrast-preserving values above, NOT a replacement
    // of them: near the window (`reachT->0`) this contributes ~0 and the
    // existing, already-confirmed-live near field is unchanged; far into the
    // beam it grows past the small contrast floor and dominates, on BOTH
    // axes — the deliberate "the ENTIRE effect" reading, not just the arc
    // axis where the diagnosis was made.
    const reachT = clamp(x.div(max(xHead, float(1e-3))), float(0), float(1));
    const reachSoft = shared.uReachSoftFarPx.mul(reachT.pow(float(SOFT_CURVE)));
    const spokeSoft = max(spokeSoftNear, reachSoft);
    const arcSoft = max(arcSoftNear, reachSoft);
    const spokeOpen = smoothstep(spokeSoft.negate(), spokeSoft, spokeGate);
    const arcOpen = smoothstep(arcSoft.negate(), arcSoft, arcGate);
    const gobo = min(spokeOpen, arcOpen);

    // ---- GRIME (aperture-gobo.js#computeApertureGrimeFactor, round 13) ----
    // darkens the glass a ray already passed the mullion/frame test through
    // — grime dirties the GLASS, it doesn't move where the mullions/frame
    // ARE, so this multiplies `gobo` rather than joining the gate math
    // above. Sampled at the UNWARPED `(sW,z)` — grime sits ON the glass
    // surface, it doesn't refract with it (same reasoning as the warp
    // sampling itself, opposite conclusion). Two noise LAYERS, mirroring
    // the CPU twin's own 70/30 patch/grit weighting exactly: large soft
    // PATCHES (`fbmFloat`, 2 octaves — fewer than the toolkit's own default
    // 4, deliberately coarser so it reads as patches, not fine noise)
    // dominate; a finer cellular GRIT (`voronoiFloat`) layer adds texture.
    // Branchless: `uGrimeAmount==0` makes `grimeFactor` exactly 1 through
    // the arithmetic itself (`1 - dirt*0 === 1`), no select() needed.
    const grimeSamplePos = vec2(sW.div(float(GRIME_PATCH_SCALE_PX)), z.div(float(GRIME_PATCH_SCALE_PX)));
    const gritSamplePos = vec2(sW.div(float(GRIME_GRIT_SCALE_PX)), z.div(float(GRIME_GRIT_SCALE_PX)));
    const fbmValue = fbmFloat(THREE.TSL, grimeSamplePos, { octaves: 2 });
    const worleyValue = voronoiFloat(THREE.TSL, gritSamplePos, 1);
    const patch = clamp(fbmValue.mul(0.5).add(0.5), float(0), float(1));
    const grit = clamp(worleyValue, float(0), float(1));
    const dirt01 = min(float(1), patch.mul(0.7).add(grit.mul(0.3)));
    const grimeFactor = float(1).sub(dirt01.mul(shared.uGrimeAmount));
    const grimedGobo = gobo.mul(grimeFactor);

    // ---- BROKEN PANES (aperture-gobo.js#computeAperturePaneIsBroken +
    // computeAperturePaneCrackGeometry, round 13) ---- ALWAYS evaluated
    // (branchless — this module's own §6.0 landmine header), gated to 0 by
    // `isBrokenMask` when this pane isn't one of the unlucky few — the SAME
    // "everything evaluates, applicability gates the USE" discipline this
    // function already uses for `applicable` itself. Pane index/centre
    // (`colIndexF`/`rowIndexF`/`paneWidthPx`/`paneHeightPx`/`paneCentreSW`/
    // `paneCentreZ`) already computed above, alongside the facet warp — ONE
    // pane-index derivation now, not two. Hashes mirror `aperture-gobo.js#
    // computeAperturePaneCrackGeometry`/`computeApertureCrackLineOpenness`
    // line-for-line, sampled at the UNWARPED `(sW,z)` — a crack's own shape
    // doesn't move with the glass's own optical distortion.
    const breakRoll = tslHash2(THREE.TSL, colIndexF.add(0.5), rowIndexF.add(0.5));
    const isBrokenMask = select(
      breakRoll.lessThan(shared.uGrimeAmount.mul(float(MAX_PANE_BREAK_CHANCE))),
      float(1),
      float(0)
    );
    const originHashX = tslHash2(THREE.TSL, colIndexF.add(3.1), rowIndexF.add(7.9));
    const originHashY = tslHash2(THREE.TSL, colIndexF.add(17.3), rowIndexF.add(91.7));
    const originSW = paneCentreSW.add(originHashX.mul(2).sub(1).mul(paneWidthPx).mul(0.3));
    const originZ = paneCentreZ.add(originHashY.mul(2).sub(1).mul(paneHeightPx).mul(0.3));
    let crackOpen = float(0);
    for (let i = 0; i < 2; i++) {
      const angleHash = tslHash2(THREE.TSL, colIndexF.add(127.1 + i * 41.0), rowIndexF.add(311.7 + i * 57.0));
      const lengthHash = tslHash2(THREE.TSL, colIndexF.add(269.5 + i * 13.0), rowIndexF.add(183.3 + i * 29.0));
      const angle = angleHash.mul(Math.PI * 2);
      const lengthPx = max(paneWidthPx, paneHeightPx).mul(lengthHash.mul(0.35).add(0.35));
      const dirX = cos(angle);
      const dirZ = sin(angle);
      const dx = sW.sub(originSW);
      const dz = z.sub(originZ);
      const along = dx.mul(dirX).add(dz.mul(dirZ));
      const perp = dx.mul(dirZ).sub(dz.mul(dirX)).abs();
      const withinLength = along.abs().lessThan(lengthPx);
      const lineOpen = select(withinLength, max(float(0), float(1).sub(perp.div(float(CRACK_WIDTH_PX)))), float(0));
      crackOpen = max(crackOpen, lineOpen);
    }
    const brokenPaneGobo = max(grimedGobo, crackOpen.mul(isBrokenMask));

    // ---- THE DIM-RADIUS FADE (aperture-gobo.js#DIM_RADIUS_FADE_START,
    // round 12) ---- pull the pattern's own contrast back toward neutral (1)
    // before the light's hard MESH boundary at t01==1 (`point-light-
    // illumination.js#triangulateLightFan` — a real geometric edge no shader
    // term can blur directly), so nothing visible collides with it. Applied
    // LAST, to the FULLY-composed `brokenPaneGobo` (mullion pattern + grime
    // + cracks) — everything fades together near the light's own edge, not
    // just the base pattern.
    const dimRadiusFade = smoothstep(float(DIM_RADIUS_FADE_START), float(1), t01);
    const fadedGobo = brokenPaneGobo.add(float(1).sub(brokenPaneGobo).mul(dimRadiusFade));

    // ---- EDGE SUPPRESSION (aperture-gobo.js#computeApertureGoboTerm's own
    // "EDGE SUPPRESSION" header, round 17) ---- a DIRECT, GUARANTEED, opt-in
    // darkening toward TRUE ZERO near this aperture's own outer edges, on
    // TOP of (never instead of) everything above. `select()` used as a
    // per-fragment ternary on a scalar (this file's own §6.0 header: safe,
    // NOT the `Loop`/`uniformArray` landmine class) guarantees an EXACT 1
    // (no-op) when a knob is 0 — `smoothstep` with `edge0===edge1` is
    // undefined behaviour on some GPU/driver combinations (real division by
    // zero, not merely "close to a no-op"), so the disabled case is a
    // genuine branch on the KNOB, never a `max(knob, epsilon)` fudge that
    // would leave a knob at 0 producing a near-instant (not exactly absent)
    // step right at a feature's own edge.
    const frameOnlyGate = min(
      warpedSW.sub(shared.uFrame.add(loExtra)),
      wallLen.sub(shared.uFrame.add(hiExtra)).sub(warpedSW)
    );
    const sillHeadOnlyGate = min(x.sub(xSill), xHead.sub(x));
    // PERCENTAGE, round 19 (aperture-gobo.js#computeApertureGoboTerm's own
    // "EDGE SUPPRESSION" header has the exact formula) — TWO axes, each
    // normalized against its OWN natural span, not one shared px value.
    const edgeSuppressDisabled = shared.uEdgeSuppressPercent.lessThanEqual(float(0));
    const pct = min(float(1), shared.uEdgeSuppressPercent.div(100));
    const spokeHalfSpan = max(wallLen.mul(0.5).sub(shared.uFrame), float(1e-3));
    const frameSuppressWidthPx = max(pct.mul(spokeHalfSpan), float(1e-3));
    const rawFrameSuppress = smoothstep(float(0), frameSuppressWidthPx, frameOnlyGate);
    const frameSuppress = select(edgeSuppressDisabled, float(1), rawFrameSuppress);
    // The arc axis's own span (`xHead-xSill`) is only meaningful when the
    // head is genuinely reachable — `uLampHeight<=uHeadPx` is the SAME
    // "unreachable head" condition `computeApertureRowBoundaryX`'s own
    // CPU twin guards with `Number.isFinite(xHead)` (there via literal
    // `Infinity`; here via `rowBoundaryX`'s own "huge sentinel, never
    // actual Infinity" idiom already established in this file — a select()
    // on the SAME underlying condition keeps the two ports in agreement
    // rather than letting the sentinel's own huge-but-finite magnitude
    // silently over-suppress this axis).
    const headUnreachable = uLampHeight.lessThanEqual(shared.uHeadPx);
    const arcSpan = max(xHead.sub(xSill), float(1e-3));
    const sillHeadSuppressWidthPx = max(pct.mul(arcSpan), float(1e-3));
    const rawSillHeadSuppress = smoothstep(float(0), sillHeadSuppressWidthPx, sillHeadOnlyGate);
    const sillHeadSuppress = select(edgeSuppressDisabled.or(headUnreachable), float(1), rawSillHeadSuppress);
    const windowEdgeSuppress = min(frameSuppress, sillHeadSuppress);
    // DIM-RADIUS SUPPRESSION, round 18 (aperture-gobo.js#computeApertureGoboTerm's
    // own "DIM-RADIUS SUPPRESSION, round 18" comment has the full story) —
    // TWO independent percentage anchors, sorted (not assumed-ordered) so
    // entering them either way round produces the identical gradient.
    // Disabled (equal anchors, the 100/100 default) is a genuine `select()`
    // branch on the SORTED fractions, same GLSL-UB-avoidance discipline as
    // `windowEdgeSuppress` above.
    const startFracRaw = shared.uDimRadiusFadeStartPercent;
    const endFracRaw = shared.uDimRadiusFadeEndPercent;
    const loFrac = max(float(0), min(startFracRaw, endFracRaw).div(100));
    const hiFrac = min(float(1), max(startFracRaw, endFracRaw).div(100));
    const rawDimRadiusSuppress = float(1).sub(smoothstep(loFrac, max(hiFrac, loFrac.add(float(1e-6))), t01));
    const dimRadiusSuppress = select(hiFrac.lessThanEqual(loFrac), float(1), rawDimRadiusSuppress);
    const suppressedGobo = fadedGobo.mul(windowEdgeSuppress).mul(dimRadiusSuppress);

    // ---- THE COMBINE (aperture-gobo.js#computeApertureGoboForLight) — a
    // per-iteration `select()` ternary accumulated into a running scalar,
    // NOT a branch fold — see this module's own §6.0 header.
    runningMax = max(runningMax, select(applicable, suppressedGobo, float(0)));
    anyApplicable = max(anyApplicable, select(applicable, float(1), float(0)));
  }

  const combined = select(anyApplicable.greaterThan(float(0.5)), runningMax, float(1));
  // Exposed separately from `combined` (which is already 1 wherever this is
  // false) specifically for standalone debug visualization — it needs to
  // tell "genuinely unmodulated" apart from "no window reaches this
  // fragment at all" so it can show the pattern ONLY where it exists.
  const anyApplicableOut = anyApplicable.greaterThan(float(0.5));

  return { node: combined, anyApplicable: anyApplicableOut, uLampHeight, apertures };
}
