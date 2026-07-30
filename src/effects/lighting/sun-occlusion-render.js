/**
 * SUN OCCLUSION, ON THE GPU — the TSL transcription of `sun-occlusion.js`.
 *
 * BROWSER-ONLY (builds TSL; verified live against real Foundry data, never a
 * mocked THREE — CONVENTIONS.md §4, the same split `buildUiShadowVisibility` and
 * `buildPointLightIlluminationMaterial` already draw). Every number this shader
 * uses comes from the pure module next door, which IS Node-tested; what lives
 * here is the fetch pattern and the loop, nothing original.
 *
 * ============================================================================
 * TWO MATERIALS, AND WHY THE EXPENSIVE ONE ALMOST NEVER RUNS
 * ============================================================================
 *
 * 1. {@link buildSunShadowBakeMaterial} — the march. Writes a SCENE-SPACE
 *    (world-aligned) visibility field: how much sun reaches each world texel.
 *    It is camera-independent, so panning and zooming cost NOTHING, and it is
 *    re-run only when the quantised sun moves, the masks change, or the floor
 *    changes (`sunNeedsRebake`). V2 re-marched a VIEW-aligned target every
 *    single frame, through five stages owned by three other systems — that is
 *    the cost model this replaces, and the reason a 32-step march is affordable
 *    here when it never was there.
 *
 * 2. {@link buildSunVisibilityNode} — the read. One clamped texture fetch,
 *    folded into the ambient-fill shader that already runs. That is the entire
 *    per-frame cost of every cast shadow in the scene.
 *
 * ⚠️ THE PLACEMENT RULE, stated because a future session WILL be tempted to
 * "unify" it with the UI-window shadow: this multiplies the AMBIENT FILL, before
 * the point lights accumulate. The UI shadow multiplies in the COMPOSITE, after
 * them. Both are correct, for opposite reasons — the UI shadow is a decorative
 * key over the whole picture, while this gates ONE light (the sun) and nothing
 * else. Moving this after the lights would make a torch standing inside a
 * building's shadow read DIMMER than the same torch outside it: the
 * `DynamicLightShadowLift` bug, in mirror image, rebuilt by accident. The author
 * stated the model independently on 2026-07-24 — *"passive light is the sunlight
 * which cannot overpower these shadows because it's the light that produces
 * these shadows, then 'active' lights are ones brought in afterwards which
 * overpower these shadows"* — and MAX-after-multiply is exactly that sentence.
 *
 * ============================================================================
 * THREE LIVE FIXES (2026-07-24, author's own first-look report)
 * ============================================================================
 *
 * 1. **The receiver gate is SHARPENED**, not read raw — a bright halo was
 *    hugging every building because the coarse `_Outdoors` grid blurs a wall's
 *    true edge across roughly a texel, and that blur was multiplying the
 *    shadow's strength right where contact-hardening says it should be
 *    strongest. See `GATE_SHARPEN_LOW`/`HIGH` in `sun-occlusion.js`.
 * 2. **The march is a thin CONE, not a single ray** — `LATERAL_TAPS` samples
 *    spread perpendicular to the sun, by a distance that GROWS with `d` (the
 *    same `PENUMBRA_PER_PX` already governing front-back softness, applied to
 *    the other axis of the same physical phenomenon). This is what makes a
 *    silhouette's SIDE edges soften and widen with distance instead of staying
 *    pixel-perfect at the coarse field's own native resolution.
 *
 *    ⚠️ EACH TAP IS MIP-FILTERED, NOT A NAIVE POINT SAMPLE (2026-07-30 — see
 *    §4 below). A point sample at a THIN caster (a wall-mounted lamp bracket)
 *    either lands squarely on it (100% coverage) or entirely misses it (0%) —
 *    there is no in-between, so a bracket a few world px wide reads as either
 *    a full-strength shadow or none at all depending on exactly where each tap
 *    happens to fall, never the honest, faint, partial shadow its own small
 *    silhouette actually casts. `LATERAL_TAPS` widens the cone but does not fix
 *    this: three OR seven point samples across a bracket narrower than the
 *    gap between them still finds it in at most one of them. Each tap now
 *    reads the caster field PRE-FILTERED (an explicit mip level sized to that
 *    tap's own footprint), which is the correct box-average over whatever area
 *    that tap actually represents — a thin object contributes its true,
 *    small, partial coverage instead of an all-or-nothing coin flip, at ANY
 *    distance, with no extra taps required to "get lucky" and land on it.
 * 3. **A point light's floor is no longer flat** — every point light's
 *    material samples THIS field per-fragment (`point-light-illumination.js`,
 *    "SUN-SHADOW ATTENUATION") so its background floor matches the shadowed
 *    ambient at each pixel, instead of erasing the shadow across its whole
 *    dim radius. Two earlier per-light-scalar attempts flipped the whole
 *    light hard-edged as the sun swept the light's origin; the field is the
 *    only correct sample space.
 *
 * ============================================================================
 * §4 — THE MIP-BASED CONE (2026-07-30, author live: a wall-mounted lamp's
 * thin overhead bracket cast a shadow "much darker much larger… than they
 * actually deserve to be", and asked directly for a resolution-independent
 * smearing model — big buildings reliably dark and long-throwing, small
 * details softer, less noticeable, and naturally vanishing at low sun where
 * a real object's shadow would be too diffuse to resolve)
 * ============================================================================
 *
 * WHAT WAS WRONG WITH POINT-SAMPLING A CONE. §3's original fix widened the
 * march into `LATERAL_TAPS` point samples spread across the cone's width —
 * correct in SPIRIT (a wider cone should read more of the silhouette's true
 * footprint), wrong in EXECUTION for anything narrower than the gap between
 * taps: a point sample either lands inside the caster (reads its full byte)
 * or outside it (reads zero), with nothing between. A 2000px wall is many
 * taps wide at every station, so this never showed; a 20px bracket is
 * narrower than a SINGLE tap's own footprint past a few march steps, so its
 * occlusion quantised to whichever of {0%, 33%, 67%, 100%} happened to land
 * on it — exactly the "much darker… than they deserve" the author reported,
 * and unrelated to the self-shadow-guard inversion §3.5 (below) also fixes.
 *
 * THE FIX is what a real optical penumbra already does: average over the
 * cone's actual footprint, not sample a few points inside it and hope one
 * hits. A GPU's mip chain already computes exactly this average, at every
 * power-of-two scale, once, when the texture is created — reading it at an
 * EXPLICIT level sized to a tap's own footprint (`log2(footprintPx /
 * texelPx)`) is one fetch that returns the correct box-filtered coverage over
 * that whole footprint, at ANY width, with no quantisation and no extra
 * samples. A church spire averages to ~1.0 at any reasonable mip (it is wide
 * relative to a texel even at the field's own native resolution) and stays
 * fully dark; a lamp bracket averages toward a small, genuinely partial value
 * once the footprint being read is wider than the bracket itself — which
 * happens naturally as `d` grows, exactly the "smaller elements soften and
 * vanish with distance" behaviour asked for, and it falls out of one
 * `log2` rather than a second, disagreeing size-based rule.
 *
 * WHY THIS ALSO EXPLAINS DAWN/DUSK FOR FREE. At low sun `PENUMBRA_PER_PX ×
 * distance` grows large fast (the march reaches much further), so the cone's
 * footprint at any given station is wide — the mip level requested climbs,
 * and fine detail dissolves into the same box average a real, near-grazing
 * sun's huge angular penumbra would produce. At noon the cone stays narrow
 * for its whole (short) reach, the requested mip stays near native
 * resolution, and the same bracket casts the sharp, present, "makes sense at
 * noon" shadow the author asked for — one mechanism, both ends of the day,
 * no separate dusk-specific knob.
 *
 * TWO FETCHES PER TAP, DELIBERATELY, NOT ONE AT A SHARED LOD. Mipping blurs
 * EVERY channel of the packed RGBA texture together — height (G) included.
 * Averaging height would let a tall, thin caster's own reach quietly shorten
 * as its neighbourhood's mostly-zero surroundings pull the mip average down,
 * which is a geometry error `over = h − rayHeight` must never absorb. So the
 * height/self-match read stays pinned to `.level(0)` (bit-exact, as before);
 * only the COVERAGE read that decides how dark the tap's contribution is
 * takes the computed mip level. Twice the fetches of one shared-LOD read, but
 * still fewer total texture instructions than adding taps would cost, and the
 * one that must stay geometrically exact does.
 *
 * @module effects/lighting/sun-occlusion-render
 */

import {
  DEFAULT_MARCH_STEPS,
  DEFAULT_LATERAL_TAPS,
  PENUMBRA_PER_PX,
  GATE_SHARPEN_LOW,
  GATE_SHARPEN_HIGH,
} from './sun-occlusion.js';

/**
 * Build the height-field march. Renders a fullscreen quad over a scene-space
 * target whose UV maps linearly onto `casterRect` (the world rect the height
 * field covers) — so `uv()` IS the world position, and no camera is involved.
 *
 * THE HEIGHT FIELD'S PACKING (ROUND SEVEN, 2026-07-30 — sun-shadow-subsystem.js
 * `bakeCasterTexture`'s own header has the repack, sun-occlusion.js's own
 * header has the physics): R = sky-reach coverage ALONE, G = FLOATING height
 * (overhead ∪ sky-reach, byte over `uHeightScalePx` — buildings EXCLUDED), B =
 * FLOATING coverage (overhead ∪ sky-reach), A = the `_Outdoors` receiver gate.
 *
 * BUILDING IS NOT A CHANNEL. A building is a COLUMN with ONE scene-wide
 * height (`uBuildingHeightPx`, a uniform, never sampled per texel); its
 * per-texel COVERAGE (indoors-ness) is recomputed in-shader from A —
 * `1 − outdoors` — rather than stored a second time. The march runs TWO
 * independent tests per station now, not one: a COLUMN test for buildings
 * (unchanged physics since the self-shadow-guard rounds) and a BAND test for
 * everything floating (a thin caster blocks only near the one distance where
 * the ray's own height crosses it, not everywhere beneath it — see
 * sun-occlusion.js's own "BUILDINGS ARE COLUMNS; EVERYTHING ELSE IS A SLAB"
 * header for the full physical argument and the measured bug it replaces: a
 * thin overhead bracket modelled as a column cast a shadow measured at
 * fourteen times its true length).
 *
 * THE ISOLATION TOGGLES ARE NOT HERE. They are applied when the field is BAKED
 * (the disabled producer's channel is never written), so turning one off removes
 * real work instead of multiplying by a zero the shader still pays to fetch —
 * `tsl/no-uniform-gates`, and the reason no `uEnable*` uniform appears below.
 *
 * @param {object} args
 * @param {*} args.THREE - the renderer namespace (carries `.TSL`).
 * @param {*} args.casterTexture - the packed height field (RGBA8).
 * @param {number} [args.steps] - march sample count.
 * @param {number} [args.lateralTaps] - how many samples spread PERPENDICULAR to
 *   the sun at each station (the cone's width). Both this and `steps` come from
 *   the performance profile's rung (`sun-occlusion.js#sunShadowTierPlan`), which
 *   is why they are build-time arguments rather than uniforms: the two loops
 *   below are unrolled, so changing either means a new material — the caller
 *   rebuilds one, rarely, when the profile moves.
 * @returns {{
 *   material: *,
 *   setSun: (azimuthDeg: number, elevationDeg: number) => void,
 *   setField: (args: {heightScalePx: number, maxCasterHeightPx: number, casterGridDimPx?: number, buildingHeightPx?: number}) => void,
 *   setLook: (args: {strength01: number, softnessMul: number, basePx: number}) => void,
 *   setRect: (rect: {minX:number, minY:number, maxX:number, maxY:number}) => void,
 *   setEdgeBandPx: (px: number) => void,
 *   casterTexNode: *,
 * }}
 */
export function buildSunShadowBakeMaterial({
  THREE,
  casterTexture,
  steps = DEFAULT_MARCH_STEPS,
  lateralTaps = DEFAULT_LATERAL_TAPS,
}) {
  const { uniform, texture, uv, vec2, vec3, vec4, float, max, min, abs, step, log2, smoothstep, Fn } = THREE.TSL;

  const LATERAL_TAPS = Number.isFinite(lateralTaps) ? Math.max(1, Math.floor(lateralTaps)) : DEFAULT_LATERAL_TAPS;
  const MARCH_STEPS = Number.isFinite(steps) ? Math.max(1, Math.floor(steps)) : DEFAULT_MARCH_STEPS;
  /** §4's per-tap footprint divisor — a single tap (LATERAL_TAPS===1) is
   * responsible for the WHOLE cone width (divisor 1, footprint = 2×spread);
   * N>1 taps are evenly spaced across it, so each is responsible for the GAP
   * between neighbours (divisor N−1). Computing this from LATERAL_TAPS at
   * shader-build time, not as a runtime node, is what keeps a higher-tier
   * tap count meaningfully FINER instead of every tap converging on an
   * identical, whole-cone-wide blur. */
  const TAP_SPACING_DIVISOR = LATERAL_TAPS > 1 ? LATERAL_TAPS - 1 : 1;

  const casterTexNode = texture(casterTexture);
  /** (dirToSunX, dirToSunY, tanElevation, stepPx) — everything the loop needs
   * about the sky, resolved on the CPU once per bake. A shader that recomputed
   * `tan()` per texel would be paying for a value that is constant across the
   * entire draw. */
  const uSun = uniform(vec4(0, -1, 1, 8));
  /** (heightScalePx, strength01, softnessMul, basePenumbraPx). */
  const uLook = uniform(vec4(2048, 1, 1, 2));
  /** The world rect this field covers: (minX, minY, maxX, maxY). */
  const uRect = uniform(vec4(0, 0, 1, 1));
  /** Width of the map-edge ramp, in world px. */
  const uEdgeBandPx = uniform(float(0));
  /** ⚠️ THE CASTER TEXTURE'S OWN RESOLUTION — NOT the bake's output `fieldDim`
   * (found live, 2026-07-30: a Quality-tier horizontal banding artefact plus an
   * Extreme-tier shadow rendering in the visibly WRONG place, both traced back
   * to this one uniform). §4's LOD math needs to know how many world px ONE
   * TEXEL of the CASTER TEXTURE spans, to pick a mip level sized to a tap's
   * footprint — and that texture's resolution is `casterGridDim`
   * (`sun-occlusion.js`'s tier axis, `mask-derive.js#deriveFloorProducts`'s
   * `casterGridSpec`), a SEPARATE, independently-tiered number from `fieldDim`
   * (the OUTPUT bake target this material renders INTO). Before `casterGridDim`
   * existed the two happened to sit in a roughly constant ratio (the caster
   * grid was always the shared 512, `fieldDim` a clean multiple-ish of it), so
   * feeding this uniform from `fieldDim` was a mild, constant one-mip-level
   * error nobody noticed. Once a tier's `casterGridDim` and `fieldDim` stopped
   * sharing a clean power-of-two ratio (Quality: 1024 vs 768; Extreme: 1280 vs
   * 1024), the requested LOD became badly wrong instead of mildly wrong — a
   * fractional, texture-chain-misaligned level rather than an off-by-one clean
   * one, which is what produced the banding and the corrupted-looking sample.
   * Kept as a uniform (not a shader-build constant) because it changes on
   * every real bake (`sun-shadow-subsystem.js#bakeCasterTexture`), which
   * uploads a brand new caster texture at whatever resolution the ACTIVE tier
   * asked for. Defaults to today's shipped 512 (`casterGridDim` at
   * `SUN_SHADOW_DEFAULT_TIER`), not `fieldDim`'s 1024 — this axis was ALWAYS
   * conceptually distinct, the default now says so too. */
  const uCasterGridDim = uniform(float(512));
  /** ROUND SEVEN: the scene-wide building height, world px — the COLUMN test's
   * only height input, since a building's height is never sampled per texel
   * (see this function's own header). 0 = no buildings active this bake, which
   * makes the column term compile-time-cheap to fall to nothing at every
   * station (`buildingOver` saturates negative), never a guess. */
  const uBuildingHeightPx = uniform(float(0));

  /** Mip level requested when a footprint (in world px) is narrower than one
   * field texel: 0, native resolution — there is nothing coarser to ask for
   * that would still be a genuine average rather than upsampling noise. */
  const MIN_LOD = 0;
  /** Ceiling on the requested LOD — a texture's own mip chain tops out at
   * `log2(dimension)`, and asking for anything past that either clamps
   * silently (harmless) or is undefined on some backends (not worth risking
   * for a value the math would otherwise never produce short of a request
   * spanning the entire field several times over). */
  const MAX_LOD = 11;

  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;

  material.fragmentNode = Fn(() => {
    const rectSize = vec2(uRect.z.sub(uRect.x), uRect.w.sub(uRect.y));
    // uv().y = 0 is the rect's minY, matching `MaskGrid`'s "row 0 = minY" and a
    // DataTexture's default flipY:false. Three spaces, one direction — the same
    // derivation `environmental-light.js#buildOutdoorsGate` writes out at
    // length, and the reason there is no flip anywhere in this file.
    const world = vec2(uRect.x, uRect.y).add(uv().mul(rectSize));

    const dir = vec2(uSun.x, uSun.y);
    // The direction PERPENDICULAR to the sun — a 90° rotation of a unit vector
    // is itself unit length, so this needs no separate normalize. Used below to
    // widen the march into a thin CONE rather than a single ray (the lateral
    // soft-edge fix).
    const perp = vec2(dir.y.negate(), dir.x);
    const tanElev = uSun.z;
    const stepPx = uSun.w;
    const heightScalePx = uLook.x;
    const strength = uLook.y;
    const softnessMul = uLook.z;
    const basePx = uLook.w;

    // THE RECEIVER GATE, read at THIS texel: the `_Outdoors` white — SHARPENED
    // (2026-07-24, author live report: "brighter area next to the actual
    // building… shadow should be strongest next to the building"). The raw
    // value is the coarse grid's own box-blurred read, which straddles a wall's
    // true edge over roughly a texel; sharpening collapses that ambiguous band
    // so the shadow reaches full strength immediately outside a wall instead of
    // ramping up over tens of world px. See sun-occlusion.js's own header for
    // why this targets the SHADOW's reading only, not the shared mask.
    const here = casterTexNode.sample(uv());
    const gate = smoothstep(float(GATE_SHARPEN_LOW), float(GATE_SHARPEN_HIGH), here.a);

    // THE PACKING (ROUND SEVEN — this function's own header has the physics):
    //   R = SKY-REACH coverage ONLY — a DIFFERENT floor's structure, art this
    //       floor never draws at this pixel, so d=0 darkens a genuinely
    //       separate, still-visible ground.
    //   G = FLOATING height (overhead ∪ sky-reach), byte over `heightScalePx`,
    //       never alpha-scaled. BUILDING EXCLUDED — a building's height is the
    //       `uBuildingHeightPx` uniform below, never a sampled byte.
    //   B = FLOATING coverage (overhead ∪ sky-reach). Building excluded here
    //       too — its coverage is `1 − A`, read directly where needed.
    //   A = the receiver gate (raw outdoors) — ALSO the per-texel building
    //       coverage input (`1 − A`), so building needs no channel of its own.
    const floatingHeightAt = (packed) => packed.g.mul(heightScalePx);
    const floatingCoverageAt = (packed) => packed.b;
    const buildingCoverageAt = (packed) => float(1).sub(packed.a);

    // ⚠️ d = 0 — THE STATION THAT WAS MISSING, then OVER-WIDENED (both
    // 2026-07-26). Starting the loop at i = 1 meant the field was never asked
    // "is something standing over ME", which is the entire question under a
    // bridge — fixed by reading R here, at zero march distance. But R first
    // shipped as `max(overhead, skyReach)`, and an OVERHEAD item lives on
    // THIS SAME floor: its own opaque art IS the only thing ever visible at
    // its own footprint (Foundry elevation is a draw-order key, not a spatial
    // offset — a raised tile's sprite and the floor "beneath" it occupy the
    // identical (x,y)). So a balcony/lantern-plinth read its own footprint as
    // "something floating overhead" and painted a shadow through its own
    // sprite (docs/planning/Sun-Shadows-Rethink.md §4b). R is sky-reach only
    // now — a genuinely different floor, whose art is NOT drawn here, so
    // darkening this pixel darkens real, visible ground, never a caster's own
    // surface. Overhead still marches normally via B.
    const occlusion = here.r.toVar();

    // ⚠️ ROUND TWO, 2026-07-28 (author: building AND overhead shadows both
    // render on top of the very overhead tile producing them) — the d=0 fix
    // above only ever excluded R at the EXACT starting texel. Coverage
    // elsewhere was never excluded at all, at ANY station — so a caster wider
    // than a few march steps in the sun's direction reads its OWN body again
    // at i=1, i=2… for as long as the ray is still crossing its own footprint,
    // and it is (by definition) always at least as tall there as itself. A
    // flat item shadows its own downstream half out to its own natural throw
    // distance (height / tan(elevation)) — exactly self-shadowing, just not
    // at d=0, so the earlier fix never touched it.
    //
    // Fix (ROUND SIX, generalised by ROUND SEVEN into two independent floors —
    // one per physical model): a station only counts as a genuinely NEW
    // blocker if it clears not just the ray's height at that distance, but
    // ALSO this RECEIVER's own height at d=0, read once here and reused by
    // both sub-tests below. `receiverBuildingHeight` uses the SAME 0.5
    // classification threshold the exterior gate uses (mask-derive.js
    // `OVERHEAD_EXTERIOR_THRESHOLD`'s own precedent) — "indoors" is binary,
    // there is no partial building floor to speak of; `step` returns exactly
    // 0 or 1, never an in-between value `uBuildingHeightPx` would scale into
    // a fictional partial-height floor.
    const receiverFloatingHeight = floatingHeightAt(here);
    const receiverBuildingHeight = step(float(0.5), buildingCoverageAt(here)).mul(uBuildingHeightPx);

    // §4's texel size, in world px — the one fact the LOD math needs beyond
    // what `uRect` already gives it. `rectSize` is not generally square (a
    // scene's own aspect ratio), so this takes the LARGER axis: a texel that
    // is honestly bigger on one axis than the LOD assumes reads slightly too
    // SHARP there, never blurs a caster it shouldn't — the safe direction to
    // be wrong in, versus the alternative (the smaller axis) which would
    // under-blur nothing but could over-blur the tighter axis.
    const texelWorldPx = max(rectSize.x, rectSize.y).div(uCasterGridDim);

    for (let i = 1; i <= MARCH_STEPS; i++) {
      const d = stepPx.mul(float(i));
      const at = world.add(dir.mul(d));
      // CONTACT HARDENING (front-back): the feather widens with distance
      // travelled, so the same wall is a knife edge where it meets the ground
      // and a smudge at the tip. `softnessMul` carries cloud + night from
      // effects/shadow-access.js.
      const feather = max(basePx.add(d.mul(float(PENUMBRA_PER_PX))).mul(softnessMul), float(1e-3));
      // LATERAL SOFTENING (2026-07-24, author: "the furthest away edge of the
      // shadow could do with being more blurred... the edges of a building
      // shadow are currently pixel perfect lines... blur the shadow to make it
      // more diffuse the further away from the building and to make edges less
      // perfect"). A single ray only ever asks "is THIS exact line blocked?",
      // so a caster's SILHOUETTE (its edge PERPENDICULAR to the sun, not its
      // front-back depth) inherits nothing but the coarse field's own native
      // texel blur — visually near-hard. Sampling a few points spread
      // sideways, with a spread that GROWS with `d` (the SAME physical
      // reasoning `marchPenumbraPx` already applies to the front-back axis —
      // a small light source's angular size blurs a penumbra equally in every
      // direction, not just toward/away from it), turns the ray into a thin
      // CONE: near the wall the cone is narrow (crisp silhouette), far from it
      // the cone has fanned out enough to average across the true edge (soft,
      // diffuse silhouette) — exactly the "more diffuse the further away"
      // asked for, from the SAME constant already governing front-back
      // softness, not a second, disagreeing blur radius.
      const spread = d.mul(float(PENUMBRA_PER_PX)).mul(softnessMul);
      // §4 — ONE mip level per STATION, shared by every tap at this distance.
      // A tap's own footprint is the GAP between adjacent taps (how much of
      // the cone's width it alone is responsible for averaging), not the
      // cone's full width — otherwise raising LATERAL_TAPS would stop buying
      // anything (every tap would read the same fully-cone-wide blur and
      // converge on an identical value). `TAP_SPACING_DIVISOR` is a shader-
      // BUILD-time constant (LATERAL_TAPS is), so this is one multiply and one
      // log2 per station, not per tap.
      const tapFootprintPx = spread.mul(float(2 / TAP_SPACING_DIVISOR));
      const tapLod = max(float(MIN_LOD), min(float(MAX_LOD), log2(max(tapFootprintPx.div(texelWorldPx), float(1)))));
      const rayHeight = d.mul(tanElev);
      // ⚠️ THE MARCH'S OWN RESOLUTION FLOORS EVERY FEATHER (Round Seven,
      // sun-occlusion.js's own header has the full proof) — between two
      // consecutive stations the ray's height changes by `stepPx·tanElev`, so
      // a crossing/tip tolerance narrower than that can fall entirely in the
      // gap between two samples and miss a real crossing outright (measured
      // live: a dawn/dusk-shortened, steep effective sun over a thin overhead
      // caster produced a shadow that vanished into the cracks almost
      // everywhere). Flooring both sub-tests' tolerance at the march's own
      // per-step height delta guarantees the two stations bracketing a true
      // crossing/tip cannot both miss it. A no-op wherever the march is
      // already fine relative to the sun angle.
      const marchFeather = max(feather, stepPx.mul(tanElev));
      let stepOcclusion = float(0);
      for (let lt = 0; lt < LATERAL_TAPS; lt++) {
        const tapT = LATERAL_TAPS === 1 ? 0 : -1 + (2 * lt) / (LATERAL_TAPS - 1);
        const tapAt = tapT === 0 ? at : at.add(perp.mul(spread.mul(float(tapT))));
        // World → field UV, clamped: a sample off the map reads the nearest
        // edge rather than wrapping in a caster from the opposite side.
        const tapUvRaw = tapAt.sub(vec2(uRect.x, uRect.y)).div(rectSize);
        const sampleUv = vec2(tapUvRaw.x.clamp(0, 1), tapUvRaw.y.clamp(0, 1));
        // TWO FETCHES, DELIBERATELY (§4's own header has the full reasoning):
        // the SHARP one feeds the geometric height/self-match test, which
        // must never absorb a thin caster's reach into its surroundings'
        // average; the MIP'D one feeds only how dark this tap's contribution
        // is, which is exactly what a pre-filtered box average should decide.
        const packedSharp = casterTexNode.sample(sampleUv).level(float(0));
        // TWO FETCHES, DELIBERATELY (§4's own header has the full reasoning):
        // the SHARP one feeds the geometric height/self-match test, which
        // must never absorb a thin caster's reach into its surroundings'
        // average; the MIP'D one feeds only how dark this tap's contribution
        // is, which is exactly what a pre-filtered box average should decide.
        // ⚠️ RESTORED 2026-07-30 — a mip-bypass experiment (pin this to level 0
        // too) was tried and made NO visible difference to either live symptom
        // (Quality banding, Extreme ghosting), which RULES OUT the caster
        // texture's own sampling/mip chain as the cause. Reverted rather than
        // left in place, so this experiment (lateral-tap isolation, below)
        // tests exactly one variable at a time.
        const packedBlurred = casterTexNode.sample(sampleUv).level(tapLod);

        // ---- BUILDING: COLUMN physics, unchanged since Round Six. ---------
        // A blocker occupies EVERY height from 0 up to `uBuildingHeightPx`, so
        // it blocks for every distance where the ray — floored at the
        // receiver's own building height, so a building cannot shadow its own
        // interior — hasn't yet climbed above it. Coverage (indoors-ness) is
        // read from the BLURRED sample: it scales darkness the same way
        // floating coverage does, never a geometric quantity that needs
        // sharpness.
        const buildingOver = uBuildingHeightPx.sub(max(rayHeight, receiverBuildingHeight));
        const buildingBlocked = buildingCoverageAt(packedBlurred).mul(smoothstep(float(0), marchFeather, buildingOver));

        // ---- FLOATING: BAND physics (Round Seven). -------------------------
        // A thin caster occupies only a narrow band AT its own height, so it
        // blocks only near the ONE distance where the ray's height crosses
        // that band — not everywhere beneath it, the way a column does.
        // `heightGate` is what keeps a wide slab from shadowing itself:
        // nothing at the SAME height as the receiver's own floating surface is
        // taller than it, so no part of a uniform canopy can ever count as "a
        // new blocker" for a receiver standing on that same canopy — the
        // bleed-ghost immunity Round Six found, generalised past a single
        // unconditional floor. Height stays SHARP (geometric); coverage stays
        // BLURRED (darkness).
        const stationFloatingHeight = floatingHeightAt(packedSharp);
        const heightGate = smoothstep(float(0), marchFeather, stationFloatingHeight.sub(receiverFloatingHeight));
        const crossingOver = marchFeather.sub(abs(stationFloatingHeight.sub(rayHeight)));
        const floatingBlocked = floatingCoverageAt(packedBlurred)
          .mul(heightGate)
          .mul(smoothstep(float(0), marchFeather, crossingOver));

        stepOcclusion = stepOcclusion.add(max(buildingBlocked, floatingBlocked));
      }
      stepOcclusion = stepOcclusion.div(float(LATERAL_TAPS));
      // MAX, not accumulate, ACROSS STEPS: the deepest blocked station along
      // the ray decides, once. A sum would darken a shadow in proportion to how
      // many march steps happened to land inside the same wall, which is a
      // resolution artefact, not light. (The lateral taps within ONE station
      // DO average, above — that average is what makes the silhouette soft;
      // it is a different axis from this MAX, not the same knob twice.)
      occlusion.assign(max(occlusion, stepOcclusion));
    }

    // THE MAP-EDGE RAMP (author, 2026-07-24: *"avoid producing a gap in the
    // shadow as it moves around the edge of the scene… a gradient at the edge"*).
    // A caster just outside the scene rect does not exist in any of our data, so
    // the shadow it should throw INTO the map cannot be computed — but a shadow
    // field that simply stops at a straight line reads as a rendering fault,
    // while one that eases out over a band reads as distance haze.
    const dEdge = min(min(world.x.sub(uRect.x), uRect.z.sub(world.x)), min(world.y.sub(uRect.y), uRect.w.sub(world.y)));
    const ramp = smoothstep(float(0), max(uEdgeBandPx, float(1e-3)), dEdge);

    // ⚠️ THE `skyOcclusion` TERM IS GONE (2026-07-26). It existed because the
    // march skipped `d = 0` and therefore could never darken the ground under a
    // bridge — so a whole second mechanism, with its OWN strength knob, was
    // bolted on beside it. Two darkness scales for one shadow is precisely the
    // author's "the shadows have different opacities", and the compounding of
    // the two against a darkness Region is what made the result "a mess". The
    // march now answers the question itself, once, at one strength.
    const vis = float(1).sub(occlusion.mul(strength).mul(gate).mul(ramp));
    // Stored in RGB (not just R) so the field is readable as a greyscale image
    // in the debug layer cycler — a shadow field you can LOOK at is the
    // difference between "sky-reach is broken" and "sky-reach has no casters".
    return vec4(vec3(vis, vis, vis), float(1));
  })();

  return {
    material,
    casterTexNode,
    /**
     * @param {number} azimuthDeg @param {number} elevationDeg
     * @param {{dirX:number, dirY:number, tanElev:number, stepPx:number}} resolved -
     *   computed by the CALLER through `sun-occlusion.js`'s pure functions, so
     *   the CPU and GPU cannot end up with two ideas of where the sun is.
     */
    setSun(azimuthDeg, elevationDeg, resolved) {
      uSun.value.set(resolved.dirX, resolved.dirY, resolved.tanElev, resolved.stepPx);
    },
    setField({ heightScalePx, casterGridDimPx, buildingHeightPx }) {
      uLook.value.x = heightScalePx;
      // Optional — omitted by callers that haven't adopted §4's LOD math yet
      // (none should exist, but this stays a no-op rather than writing NaN
      // over a working uniform if one ever does). ⚠️ THIS IS THE CASTER
      // TEXTURE'S OWN resolution (`uCasterGridDim`'s header has the full
      // reasoning) — NOT the bake target's `fieldDim`. A caller that passes
      // the wrong one silently mis-sizes every mip request, which is exactly
      // the bug this parameter was renamed to stop being possible to make by
      // accident.
      if (Number.isFinite(casterGridDimPx) && casterGridDimPx > 0) uCasterGridDim.value = casterGridDimPx;
      // Optional, same reason: 0/absent correctly compiles the column term to
      // a no-op (`uBuildingHeightPx` defaults to 0) rather than writing NaN.
      if (Number.isFinite(buildingHeightPx) && buildingHeightPx >= 0) uBuildingHeightPx.value = buildingHeightPx;
    },
    setLook({ strength01, softnessMul, basePx }) {
      uLook.value.y = strength01;
      uLook.value.z = softnessMul;
      uLook.value.w = basePx;
    },
    setRect(rect) {
      uRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
    },
    setEdgeBandPx(px) {
      uEdgeBandPx.value = px > 0 ? px : 0;
    },
  };
}

/**
 * THE READ — a scalar 0..1 sun-visibility node for a fullscreen pass, sampled at
 * the world position under this screen pixel.
 *
 * Deliberately takes the CALLER's `uViewRect` (the camera's world rect) rather
 * than building its own: `environmental-light.js` already owns that uniform and
 * updates it once per frame beside `setAmbient`. A second copy is precisely how
 * the outdoors gate and the shadow field would end up covering different halves
 * of the map — the drift `buildOutdoorsGate` exists to prevent, one buffer over.
 *
 * Returns `null` when no field texture is supplied, so the whole lookup is
 * compiled OUT rather than multiplied by a one (`tsl/no-uniform-gates`, and the
 * same JS-time-branch shape the sky gate uses).
 *
 * @param {*} TSL - THREE.TSL.
 * @param {object} args
 * @param {*} args.uViewRect - vec4 uniform, the camera world rect.
 * @param {*} args.uShadowRect - vec4 uniform, the rect the shadow field covers.
 * @param {*} args.shadowTexNode - the baked field's texture node, or null.
 * @returns {*|null} scalar node, 1 = full sun.
 */
export function buildSunVisibilityNode(TSL, { uViewRect, uShadowRect, shadowTexNode }) {
  if (!shadowTexNode) return null;
  const { uv, vec2, mix } = TSL;
  const worldX = mix(uViewRect.x, uViewRect.z, uv().x);
  const worldY = mix(uViewRect.y, uViewRect.w, uv().y);
  const u = worldX.sub(uShadowRect.x).div(uShadowRect.z.sub(uShadowRect.x));
  const v = worldY.sub(uShadowRect.y).div(uShadowRect.w.sub(uShadowRect.y));
  return shadowTexNode.sample(vec2(u.clamp(0, 1), v.clamp(0, 1))).r;
}
