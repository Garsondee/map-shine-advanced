/**
 * WINDOW LIGHT — the cookie, in TSL. THREE is INJECTED, never imported.
 *
 * `window-cookie.js` is the maths in plain JS, asserted in Node; this is its
 * transcription, drawn as a bounded quad and ADDED onto `buf:scene.illum` —
 * the SAME buffer the ambient fill, region darkness and point lights already
 * accumulate into (`vt-pan-viewer.js#runLightAccumulatePass`), not
 * `buf:scene.color`/`scene.lit`. That is a real structural difference from
 * `specular-render.js`, which this module's shape otherwise mirrors closely:
 * this pass draws BEFORE the illumination is finished being composed, so it
 * needs no `illumTexture` input at all — it CONTRIBUTES to illum rather than
 * reading it.
 *
 * ============================================================================
 * ⚠️ THIS ADDS. IT NEVER TOUCHES COMPOSED SCENE COLOUR.
 * ============================================================================
 * `docs/planning/Windows.md` §2.2/§3.2: V2 folded its window glow into the lit
 * scene TWICE — once correctly (`totalIllumination += winIllum`) and once as
 * an additive haze on the ALREADY-LIT pixel (`litColor += winHueLit × spill`),
 * which flattens the art it is meant to be lighting. That second half is the
 * SAME mistake water's in-scatter term made and the sky's deleted "veil" made
 * — three effects in this codebase, one bug. This module only ever produces a
 * term that gets ADDED to `buf:scene.illum`; there is no second draw, no
 * spill, and no `scene.lit` write anywhere in this file.
 *
 * ============================================================================
 * THE MASK IS NOT AN APERTURE — READ `window-cookie.js`'S HEADER FIRST
 * ============================================================================
 * There is no aperture geometry here: no wall, no sill, no "which side is
 * outside". The author has already painted where the light lands, how
 * strong, and what colour — this shader reads exactly that, cropped to the
 * mask's own AABB and gated to the viewed floor. Nothing here derives a beam.
 *
 * ============================================================================
 * ⚠️ THE CLOUD FACTOR IS A SEAM, NOT A FEATURE — READ THIS BEFORE ADDING ONE
 * ============================================================================
 * `world/cloud-field.js` (`docs/planning/Windows.md` §4) does not exist yet.
 * `cloudFactorNode` is how its eventual per-fragment 0..1 sample plugs in
 * without touching anything else in this shader: pass a real node once the
 * field is built, and the constant-1 default below simply stops being
 * reached. This is deliberately NOT a uniform toggle (`tsl/no-uniform-gates`
 * forbids exactly that shape) and deliberately NOT a `WINDOW_PARAMS` entry
 * yet (`params/no-dead-controls` would fail the build on a control with no
 * consumer) — it is a JS-level injection point, the same idiom
 * `buildOutdoorsGate` uses in `specular-render.js`.
 *
 * @module effects/window/window-render
 */

import {
  WINDOW_PRESENCE_EDGE0,
  WINDOW_PRESENCE_EDGE1,
  WINDOW_ALPHA_EPSILON,
  WINDOW_SHOULDER_K,
} from './window-cookie.js';
import { WINDOW_DEBUG_CHANNELS, WINDOW_DEBUG_BOOST } from './window.js';
import { buildDebugChannelColor } from '../debug-channel-select.js';
import { hexToRgb01 } from '../candle-flame-geometry.js';
import {
  GLASS_SAMPLE_EPSILON,
  GLASS_CAUSTIC_DARK_RATIO,
  GLASS_DISPERSION_SPREAD,
  GLASS_CURVATURE_GAIN,
} from './window-glass.js';
import { simplexFloat, rotate2d } from '../lighting/animations/tsl-noise-toolkit.js';

/**
 * Fraction of the authored file's resolution to upload for this shader's own
 * mask read. Mirrors `SPECULAR_MASK_IMAGE_SCALE` for the same reason: `'rgb'`
 * mode uploads RGBA, four bytes per texel, so half resolution costs roughly
 * what water's single-byte upload costs at full resolution.
 */
export const WINDOW_MASK_IMAGE_SCALE = 0.5;

/** Defaults, mirroring `WINDOW_PARAMS` — the single source of truth for the
 * values; the schema quotes them. A change lands in both or neither. */
export const WINDOW_DEFAULT_STRENGTH = 1.25;
export const WINDOW_DEFAULT_CONTRAST = 1;
/** Hex source for the two daylight keyframes — mirrors `WINDOW_PARAMS.dawnDuskTint`/
 * `.nightTint`'s own `default`. Decoded once here rather than per frame; noon has
 * no colour of its own — it is the neutral (1,1,1) this effect falls back to. */
export const WINDOW_DEFAULT_DAWN_DUSK_TINT_HEX = '#ff8a3d';
export const WINDOW_DEFAULT_NIGHT_TINT_HEX = '#5c7cff';
export const WINDOW_DEFAULT_DAWN_DUSK_TINT_RGB = hexToRgb01(WINDOW_DEFAULT_DAWN_DUSK_TINT_HEX);
export const WINDOW_DEFAULT_NIGHT_TINT_RGB = hexToRgb01(WINDOW_DEFAULT_NIGHT_TINT_HEX);

/** The glass defaults, mirroring `WINDOW_PARAMS`'s own `Glass` category. */
export const WINDOW_DEFAULT_GLASS_WARP_PX = 60;
export const WINDOW_DEFAULT_GLASS_DISPERSION = 1;
export const WINDOW_DEFAULT_GLASS_SCALE = 400;
export const WINDOW_DEFAULT_GLASS_DETAIL = 1;
export const WINDOW_DEFAULT_GLASS_STRIATION = 0;
export const WINDOW_DEFAULT_GLASS_STRIATION_ANGLE = 0;
export const WINDOW_DEFAULT_GLASS_CAUSTIC_STRENGTH = 2;
export const WINDOW_DEFAULT_GLASS_CAUSTIC_SHARPNESS = 6;

/**
 * How far the second octave's frequency sits above the first, and how much
 * amplitude it carries at `glassDetail = 1`.
 *
 * ⚠️ TWO HAND-ROLLED OCTAVES, NOT `fbmFloat` — and the reason is that
 * `glassDetail` has to be a LIVE slider. `mx_fractal_noise_float`'s octave
 * count is consumed by a JS-time loop when the graph is built, so it can only
 * ever be a construction-time constant: driving it from a uniform is not a
 * thing the node supports, and exposing it as one would mean rebuilding the
 * material on every drag of the slider. Summing two explicit
 * `simplexFloat` samples and CROSSFADING the second one's amplitude from a
 * uniform gives a continuous 0..1 detail control that costs no rebuild, at
 * the price of the octave structure being written out here rather than
 * delegated. `2.7`, not `2`, because an exactly-doubled frequency lines its
 * own lattice up with the first octave's and leaves a faint grid readable in
 * the caustic; an irrational-ish ratio does not.
 */
export const GLASS_OCTAVE2_FREQ = 2.7;
export const GLASS_OCTAVE2_AMP = 0.5;

/**
 * How far `glassStriation = 1` stretches the field along the draw-line axis.
 * At 4 the lumps read as unmistakable parallel drawn streaks while still
 * being lumps; beyond about 6 they degenerate into flat bands with no
 * cross-axis structure left for the gradient to bite on, and the warp
 * collapses to a 1-D smear.
 */
export const GLASS_STRIATION_STRETCH = 4;

/**
 * DEBUG-CHANNEL NORMALISATION ONLY — neither of these touches the render.
 * The height field's own bound (octave 1 is ±1, octave 2 adds ±`GLASS_
 * OCTAVE2_AMP`), and a fixed world-px reference for the offset channel. The
 * offset one is deliberately NOT `glassWarpPx`: see that channel's own note.
 */
export const GLASS_DEBUG_HEIGHT_RANGE = 1 + GLASS_OCTAVE2_AMP;
export const GLASS_DEBUG_OFFSET_REF_PX = 20;

/**
 * Build the window-light material.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.maskTexture - the authored `_Window` file, RGBA, RAW bytes.
 *   ⚠️ Uploaded `NoColorSpace`, matching `_Specular`'s convention — a "50%
 *   grey" texel means 0.5, not 0.21.
 * @param {*} [args.depthTexture] - `buf:scene.depth`'s DEPTH attachment (a
 *   `THREE.DepthTexture`); null compiles the floor gate OUT entirely (a
 *   JS-time branch, never a uniform × 0) — see "THE FLOOR GATE" below for
 *   the depth-authority gate this replaced `attrTexture` with (2026-08-05),
 *   mirroring `specular-render.js`'s own STAGE 3 migration.
 * @param {*} args.uViewRect - envLight's OWN view-rect uniform, shared rather
 *   than duplicated: two rects on different cadences is how two consumers of
 *   one frame stop agreeing where a world point is.
 * @param {*} [args.cloudFactorNode] - see this module's header. A TSL node
 *   evaluating 0..1 (1 = no cloud shadow), or `null`/omitted for the constant
 *   1 this effect ships with until `world/cloud-field.js` exists.
 * @param {boolean} [args.glass] - build the refraction/dispersion/caustic
 *   subgraph at all. A JS-TIME branch: `false` constructs none of it, so the
 *   compiled shader shrinks by five noise taps and two mask taps rather than
 *   multiplying them by a zero (`tsl/no-uniform-gates`). Defaults ON — the
 *   author's `glassWarpPx = 0` is the runtime off switch, and it is exact.
 * @returns {object} the material plus its setters.
 */
export function buildWindowSurfaceMaterial({
  THREE,
  maskTexture,
  depthTexture = null,
  uViewRect,
  cloudFactorNode = null,
  strength = WINDOW_DEFAULT_STRENGTH,
  contrast = WINDOW_DEFAULT_CONTRAST,
  glass = true,
}) {
  const TSL = THREE.TSL;
  const { texture, uv, vec2, vec3, vec4, float, uniform, positionWorld, smoothstep, step, clamp, max, abs, sign, mix } =
    TSL;

  const uStrength = uniform(float(strength));
  const uContrast = uniform(float(contrast));

  // ── THE GLASS (effects/window/window-glass.js holds the model) ────────────
  const uGlassWarpPx = uniform(float(WINDOW_DEFAULT_GLASS_WARP_PX));
  const uGlassDispersion = uniform(float(WINDOW_DEFAULT_GLASS_DISPERSION));
  const uGlassScale = uniform(float(WINDOW_DEFAULT_GLASS_SCALE));
  const uGlassDetail = uniform(float(WINDOW_DEFAULT_GLASS_DETAIL));
  const uGlassStriation = uniform(float(WINDOW_DEFAULT_GLASS_STRIATION));
  const uGlassStriationAngle = uniform(float(WINDOW_DEFAULT_GLASS_STRIATION_ANGLE));
  const uGlassCausticStrength = uniform(float(WINDOW_DEFAULT_GLASS_CAUSTIC_STRENGTH));
  const uGlassCausticSharpness = uniform(float(WINDOW_DEFAULT_GLASS_CAUSTIC_SHARPNESS));
  /** The hashed, BOUNDED seed offset — `window-glass.js#computeSeedOffset`
   * does the hashing on the CPU precisely so a raw seed never reaches a noise
   * coordinate (`feedback_raw_seed_into_noise_coordinate`). */
  const uGlassSeedOffset = uniform(vec2(0, 0));
  /**
   * MASK-UV PER WORLD PIXEL. The refraction is derived in WORLD space (so the
   * lumps keep their size and stay put as the camera pans) but has to be
   * spent as a MASK-UV offset, and only the subsystem knows the conversion —
   * it owns both the world AABB and the UV bounds. Pushed as one uniform
   * rather than re-derived here from `uMaskUvBounds`, because the world span
   * is not in this shader at all and inventing it would be a second, silently
   * divergent copy of a mapping the subsystem already computes
   * (`window-surface-subsystem.js#setUvPerWorldPx` derives it from the SAME
   * two rects `toUvBounds` uses, so the two cannot disagree — including about
   * which way V runs, `feedback_y_flip_recurring_risk`).
   */
  const uUvPerWorldPx = uniform(vec2(0, 0));

  /**
   * The astrolabe-driven recolour, already resolved to a flat RGB by
   * `window-surface-subsystem.js#sync` — night→dawn/dusk→noon(neutral) folded
   * down to one lerp result there (the same "compute once in JS, push a
   * uniform" idiom `sky-access.js` uses for its own dayFactor01/twilight01
   * chain), so this is a plain per-fragment multiply, no mix() here at all.
   * (1,1,1) is the fallback/noon value — "the sun setter never reached this
   * material" and "it is noon" are indistinguishable on purpose, both neutral.
   *
   * ⚠️ APPLIED LAST — AFTER THE GLASS, AFTER THE CAUSTIC, AFTER THE HIGHLIGHT
   * SHOULDER. Author directive (2026-08-05): the RGB split has to be what
   * gets tinted, not one ingredient folded in early and then reshaped by
   * everything downstream of it. Order of operations, in full, and why:
   *
   *   1. THE GLASS builds `cookie` — the RGB-DISPERSED result, three
   *      independently-refracted taps. This is "what colour is the light
   *      after the pane bent it" and has nothing to do with the time of day.
   *   2. THE CAUSTIC (`causticGain`) multiplies in — a real brightness
   *      variation from the SAME glass, so it belongs with the light's own
   *      formation, not with the tint.
   *   3. `uStrength`/coverage/cloud, then THE HIGHLIGHT SHOULDER — the
   *      exposure step. It has to see the TRUE, untinted peak: if the tint
   *      were multiplied in earlier, an orange dusk (which dims blue) would
   *      lower the measured peak and make the shoulder compress LESS, so a
   *      cookie's own clipping behaviour would depend on the hour — two
   *      unrelated effects entangled through the compression maths.
   *   4. ONLY THEN does `uDaylightTint` apply — see `cookieLight`'s own
   *      comment where the actual multiply happens, right before this
   *      material's `colorNode`.
   *
   * Getting this backwards does not look broken so much as SUBTLY WRONG: the
   * picture still updates with the clock, tints still show up, and the bug is
   * "the glass reads slightly different at each hour beyond the tint itself"
   * — exactly the class of error this codebase's memory calls a smooth,
   * plausible output masking a wrong model.
   */
  const uDaylightTint = uniform(vec3(1, 1, 1));
  /** The crop's extent in mask-UV space. THE ENTIRE mask lookup. */
  const uMaskUvBounds = uniform(vec4(0, 0, 1, 1));
  /** `computeTieSafeExpectedDepth`'s result for THIS quad's own background
   * item's rank (`depth-authority.js#rankOf`), pushed by `setExpectedDepth`
   * on the SAME cadence `setFloorIndex` used to have (a floor change) — the
   * exact shape `specular-render.js`'s own `uExpectedDepth` uses. Defaults
   * to 0: with the depth texture cleared to the far plane (1) until the
   * first real depth pass runs, `depthHere(1) >= uExpectedDepth(0)` always
   * holds, so an unwired/not-yet-synced caller fails OPEN (the cookie draws)
   * — the same posture `uFloorIndex01` never had to think about because
   * JS-time-compiling the gate out entirely was doing that job instead. See
   * "THE FLOOR GATE" below. */
  const uExpectedDepth = uniform(float(0));

  // ── THE MASK UV — the quad's own `uv()`, remapped by the crop ────────────
  // Same reasoning as specular-render.js's own note: `uv()` cannot exceed
  // 0..1, so this lookup cannot leave the texture, correct by construction.
  const maskUv = vec2(
    mix(uMaskUvBounds.x, uMaskUvBounds.z, uv().x),
    mix(uMaskUvBounds.y, uMaskUvBounds.w, uv().y)
  ).toVar('winMaskUv');

  /**
   * THE MASK TAPS. One `texture()` node per dispersion tap — see
   * `sampleCookieAt` below on why they can never be one shared node, and
   * `setMaskTexture` on why the list matters.
   */
  const maskTexNodes = [];

  /**
   * THE DECODE — the transcription of `decodeWindowMask`. With the glass on
   * this runs once per colour channel, because each one arrives from its own
   * place on the mask; with it off, once.
   *
   * ⚠️ EACH TAP GETS ITS OWN `texture()` NODE, NEVER ONE NODE REUSED WITH
   * THREE UVs. A `texture()` node binds its coordinate at construction;
   * feeding a second UV into the same node silently samples the first
   * (`feedback_shared_texture_node_carries_the_wrong_uv`). The nodes are
   * collected so `setMaskTexture` can update ALL of them — updating only the
   * first would leave two thirds of the light sampling the 1×1 placeholder
   * forever, and the cookie would render in a plausible partial colour.
   */
  const sampleCookieAt = (uvNode, label) => {
    const texNode = texture(maskTexture, uvNode);
    maskTexNodes.push(texNode);
    const s = texNode.toVar(`${label}Sample`);
    const value = max(max(s.r, s.g), s.b).toVar(`${label}Value`);
    const alpha = clamp(s.a, 0, 1);
    // The alpha-missing fallback: a greyscale `_Window` with no alpha channel
    // is the common authoring case and would otherwise decode to pure black.
    const effectiveAlpha = alpha.lessThan(float(WINDOW_ALPHA_EPSILON)).select(float(1), alpha);
    const gated = value.mul(effectiveAlpha).toVar(`${label}Gated`);
    const presence = smoothstep(float(WINDOW_PRESENCE_EDGE0), float(WINDOW_PRESENCE_EDGE1), gated).toVar(
      `${label}Presence`
    );
    const level = clamp(gated, 0, 1)
      .pow(max(uContrast, float(0.001)))
      .toVar(`${label}Level`);
    // Re-normalised so the tint carries `level` as its own peak — a naive
    // `rgb × level` would darken saturated paint twice, once for being dark
    // and once for being coloured (see window-cookie.js's own header).
    const tint = s.rgb.div(max(value, float(1e-4))).toVar(`${label}Tint`);
    return { sample: s, presence, level, tint, cookie: tint.mul(level).toVar(`${label}Cookie`) };
  };

  // ═══════════════════════════════════════════════════════════════════════
  // THE GLASS — `window-glass.js` transcribed. Read that module's header for
  // the model; this is only its evaluation.
  // ═══════════════════════════════════════════════════════════════════════
  // ⚠️ `glass` IS A JS-TIME BRANCH, NOT A UNIFORM. Everything below — five
  // noise taps, two extra mask taps, the whole caustic chain — is simply NOT
  // CONSTRUCTED when it is false, so the compiled shader genuinely shrinks
  // (Effects.md Law 4 / `tsl/no-uniform-gates`: "if turning it off does not
  // SHRINK the compiled shader, it is not off"). The same idiom `depthTexture`
  // uses for the floor gate further down.
  //
  // ⚠️ It is deliberately NOT wired to a manifest tier YET, and that is an
  // honest gap rather than an oversight: a perf tier has to be able to CHANGE
  // at runtime, and nothing in this effect rebuilds its material when the
  // profile moves (specular carries that machinery; this does not). Declaring
  // a `fromProfile` rung that no rebuild honours would be a manifest claiming
  // more than exists — see `deferredRungs.glassPerfGate`. Today the author's
  // own `glassWarpPx = 0` is the off switch, and it is exact.
  // ⚠️ WORLD SPACE, NOT UV. The lumps are a property of the PANE, so they
  // must keep their size and their place while the camera moves and
  // regardless of the mask file's own aspect ratio. A field sampled in UV
  // would stretch with the mask and swim under a pan — the same class of
  // mistake as sampling a screen buffer with a world UV
  // (`feedback_shared_texture_node_carries_the_wrong_uv`), one layer up.
  /** The centre tap — the honest single representative for the diagnostic
   * channels whose question predates the glass (mask/presence/level/tint). */
  let tapG;
  /** The cookie, per channel, presence already folded in. */
  let cookie;
  /** The focusing multiplier; a literal 1 with the glass compiled out. */
  let causticGain = float(1);
  // Neutral diagnostics for the glass channels when there is no glass — flat
  // mid-grey, which is exactly what their reading guides say "off" looks like.
  let debugGlassHeight = vec3(0.5, 0.5, 0.5);
  let debugGlassOffset = vec3(0.5, 0.5, 0.5);

  if (glass) {
    const glassScaleSafe = max(uGlassScale, float(1));
    const striationAngleRad = uGlassStriationAngle.mul(float(Math.PI / 180)).toVar('winGlassAngle');
    // THE STRIATIONS, FOR FREE. Compressing the sample coordinate on one axis
    // ELONGATES the features along it — so the cylinder-glass draw lines cost
    // one divide, not a second noise layer.
    const striationStretch = float(1)
      .add(uGlassStriation.mul(float(GLASS_STRIATION_STRETCH)))
      .toVar('winGlassStretch');
    const fieldBase = rotate2d(TSL, positionWorld.xy.div(glassScaleSafe), striationAngleRad);
    const fieldP = vec2(fieldBase.x.div(striationStretch), fieldBase.y).add(uGlassSeedOffset).toVar('winGlassP');

    /**
     * ONE tap of the thickness field — two octaves, the second crossfaded by
     * `glassDetail` (see `GLASS_OCTAVE2_FREQ`'s own note on why this is not
     * `fbmFloat`). The second octave is offset by an arbitrary constant so it
     * does not share the first's lattice origin.
     * @param {number} offX @param {number} offY - in FIELD units, not px.
     */
    const heightAt = (offX, offY) => {
      const p = offX === 0 && offY === 0 ? fieldP : fieldP.add(vec2(float(offX), float(offY)));
      const octave1 = simplexFloat(TSL, p);
      const octave2 = simplexFloat(TSL, p.mul(float(GLASS_OCTAVE2_FREQ)).add(vec2(float(31.4), float(17.9))));
      return octave1.add(octave2.mul(uGlassDetail).mul(float(GLASS_OCTAVE2_AMP)));
    };

    // FIVE TAPS, TWO DERIVATIVES. The centre is needed only by the curvature,
    // the neighbours by both — which is what makes the caustic nearly free
    // once the warp has been paid for (window-glass.js#computeGlassField).
    const hC = heightAt(0, 0).toVar('winGlassHC');
    const hL = heightAt(-GLASS_SAMPLE_EPSILON, 0).toVar('winGlassHL');
    const hR = heightAt(GLASS_SAMPLE_EPSILON, 0).toVar('winGlassHR');
    const hD = heightAt(0, -GLASS_SAMPLE_EPSILON).toVar('winGlassHD');
    const hU = heightAt(0, GLASS_SAMPLE_EPSILON).toVar('winGlassHU');

    // `computeGlassField`, line for line — neither divided by ε, see its header.
    const gradFieldX = hR.sub(hL).div(float(2));
    const gradFieldY = hU.sub(hD).div(float(2));
    const curvature = hR.add(hL).add(hD).add(hU).div(float(4)).sub(hC).toVar('winGlassCurv');

    // ── BACK TO WORLD SPACE ────────────────────────────────────────────────
    // The field was sampled through a rotate-then-stretch, so the gradient
    // that came out is in the GLASS's frame, not the world's. A gradient
    // transforms by the TRANSPOSE of that map (`∇_p = Mᵀ ∇_q`), which here
    // is: undo the stretch on the same axis it was applied to, then rotate
    // back.
    //
    // Skipping this would not look broken — it would look like the light
    // always slides a little along the draw lines, an error that reads as a
    // stylistic choice rather than as a bug, which is exactly the kind this
    // codebase has paid for before. Six ALU ops to be actually right.
    const gradWorld = rotate2d(
      TSL,
      vec2(gradFieldX.div(striationStretch), gradFieldY),
      striationAngleRad.mul(float(-1))
    ).toVar('winGlassGrad');

    // ── THE DISPERSION — one deflection, three magnitudes ──────────────────
    // `computeChannelOffsetPx` × `computeDispersionScales`, folded: green
    // rides the base offset and red/blue sit symmetrically either side of it,
    // so turning the split up separates the channels rather than sliding the
    // whole cookie. World px → mask UV through the subsystem's conversion.
    const baseOffsetPx = gradWorld.mul(uGlassWarpPx).toVar('winGlassOffsetPx');
    const baseOffsetUv = baseOffsetPx.mul(uUvPerWorldPx).toVar('winGlassOffsetUv');
    const dispersionK = uGlassDispersion.mul(float(GLASS_DISPERSION_SPREAD)).toVar('winGlassDispK');

    const tapR = sampleCookieAt(maskUv.add(baseOffsetUv.mul(float(1).sub(dispersionK))), 'winR');
    tapG = sampleCookieAt(maskUv.add(baseOffsetUv), 'winG');
    const tapB = sampleCookieAt(maskUv.add(baseOffsetUv.mul(float(1).add(dispersionK))), 'winB');

    // ⚠️ PRESENCE IS PER-CHANNEL, AND THAT IS THE WHOLE PRISM. Taking a
    // single shared silhouette would keep the cookie's EDGE monochrome and
    // confine the colour split to its interior — which is where there is
    // least to see, because the interior is usually flat paint. The fringe
    // belongs on the edge: that is where a real pane throws its rainbow.
    cookie = vec3(
      tapR.cookie.r.mul(tapR.presence),
      tapG.cookie.g.mul(tapG.presence),
      tapB.cookie.b.mul(tapB.presence)
    ).toVar('winCookie');

    // ── THE CAUSTIC — `computeCausticGain`, transcribed ───────────────────
    // The JS twin early-returns an exact 1 at strength 0; this needs no
    // branch to match it, because both terms below are multiplied by the
    // strength and vanish with it.
    // ⚠️ `GLASS_CURVATURE_GAIN` is load-bearing, not a tuning nicety: without
    // it the convergence sits near 0.05 and the shaping power annihilates it.
    // Measured on this very bench — see that constant's own header.
    //
    // ⚠️ SOFT saturation, never `clamp()` — `softSaturate` transcribed. With a
    // hard clamp the caustic rendered as a near-binary stencil, because the
    // field's tail runs far past 1 after the gain and every bit of it flattened
    // onto the bound. `x / (1 + |x|)`, the same compressor shape the highlight
    // shoulder below uses.
    const convScaled = curvature.mul(float(-GLASS_CURVATURE_GAIN)).toVar('winGlassConvRaw');
    const convergence = convScaled.div(float(1).add(abs(convScaled))).toVar('winGlassConv');
    const sharpness = max(uGlassCausticSharpness, float(0.5));
    // ONE power on the MAGNITUDE, sign reattached — shaping only the bright
    // side is what made turning the caustic up dim the whole cookie.
    const shaped = abs(convergence).pow(sharpness).mul(sign(convergence)).toVar('winGlassShaped');
    causticGain = max(
      float(0),
      float(1)
        .add(uGlassCausticStrength.mul(max(shaped, float(0))))
        .sub(uGlassCausticStrength.mul(float(GLASS_CAUSTIC_DARK_RATIO)).mul(max(shaped.mul(float(-1)), float(0))))
    ).toVar('winCaustic');

    // The field itself, remapped to grey. `GLASS_DEBUG_HEIGHT_RANGE` is the
    // field's own bound, so a lump reaches white rather than clipping halfway.
    debugGlassHeight = vec3(1, 1, 1).mul(hC.div(float(2 * GLASS_DEBUG_HEIGHT_RANGE)).add(float(0.5)));
    // Normalised against a FIXED px reference, not against `glassWarpPx` —
    // dividing by the live slider would renormalise the picture as it moved,
    // and the channel could then never show "the warp is off" (flat grey),
    // which is the single most useful thing it has to say.
    debugGlassOffset = vec3(
      baseOffsetPx.x.div(float(2 * GLASS_DEBUG_OFFSET_REF_PX)).add(float(0.5)),
      baseOffsetPx.y.div(float(2 * GLASS_DEBUG_OFFSET_REF_PX)).add(float(0.5)),
      float(0.5)
    );
  } else {
    // NO GLASS: one tap, monochrome presence — byte-for-byte the pre-glass
    // effect, and a visibly smaller compiled shader.
    tapG = sampleCookieAt(maskUv, 'win');
    cookie = tapG.cookie.mul(tapG.presence).toVar('winCookie');
  }

  // ── THE CAUSTIC ONLY, HERE — see this module's header on `uDaylightTint`
  // for why the astrolabe tint is NOT folded in at this point any more. The
  // caustic stays: it is a real brightness variation from the glass itself
  // (light physically concentrating on the thick spots) and has to go through
  // the highlight shoulder below like any other magnitude the cookie can
  // blow out with — same reasoning as `uStrength`/`coverage`/`cloudFactor`,
  // all multiplied in before the shoulder for the identical reason.
  const cookieTinted = cookie.mul(causticGain).toVar('winCookieTinted');

  // ── THE FLOOR GATE — THE DEPTH AUTHORITY (2026-08-05) ────────────────────
  // A JS-time branch: with no depth texture the whole lookup is compiled OUT
  // rather than multiplied by a one (`tsl/no-uniform-gates`), the same
  // posture the old `attrTexture`-gated version had. Screen UV comes from
  // `positionWorld` mapped through the SAME view rect the geometry pass
  // wrote `buf:scene.depth` against — the exact mapping specular's floor
  // gate already uses, so the two agree about where a world point lands on
  // screen without a second derivation.
  const viewSpanX = max(uViewRect.z.sub(uViewRect.x), float(1)).toVar('winViewSpanX');
  const viewSpanY = max(uViewRect.w.sub(uViewRect.y), float(1));
  const screenU = positionWorld.x.sub(uViewRect.x).div(viewSpanX);
  const screenV = positionWorld.y.sub(uViewRect.y).div(viewSpanY);
  const screenUv = vec2(clamp(screenU, 0, 1), clamp(screenV, 0, 1)).toVar('winScreenUv');

  // `step(edge, x) = x >= edge ? 1 : 0`, so `step(uExpectedDepth, depthHere)`
  // reads "is the stored depth at this pixel AT OR ABOVE my own rank" — 1
  // unless something ranked strictly higher (a Tile, a roof, the floor
  // above) is drawn over it — the same single ordinal comparison
  // `specular-render.js`'s own floor gate collapsed its old two-mechanism
  // `buf:scene.attr` check into. This is a genuine behaviour change from the
  // old `floorMatch`: that gate could only ever tell two FLOORS apart (both
  // a same-floor background and a same-floor Tile drawn over it carried the
  // identical floor-index byte), so a Tile sitting on its own floor's window
  // cookie never occluded it. Rank captures BOTH cases in one comparison —
  // exactly the "punch a hole the same way the eye does" doctrine this
  // effect's own header already commits to — so a Tile now correctly blocks
  // the cookie it sits on top of, where before it did not.
  let visibility01 = float(1);
  let debugFloorGate = vec3(1, 1, 0);
  if (depthTexture) {
    const depthHere = texture(depthTexture, screenUv).toVar('winDepthHere');
    const notOccluded = step(uExpectedDepth, depthHere).toVar('winNotOccluded');
    visibility01 = notOccluded;
    debugFloorGate = vec3(notOccluded, depthHere, uExpectedDepth);
  }

  // COVERAGE IS NOW THE FLOOR GATE ALONE. Presence used to be folded in here,
  // but it became per-channel the moment each colour got its own tap (see
  // `cookie` above), so it now rides inside the cookie itself. The floor gate
  // stays monochrome and shared, correctly: which floor a texel belongs to is
  // a screen-space fact about the map, not a property of a wavelength.
  const coverage = visibility01.toVar('winCoverage');

  // ── THE CLOUD SEAM — see this module's header ────────────────────────────
  const cloudFactor = (cloudFactorNode ?? float(1)).toVar('winCloudFactor');

  // ── THE COMPOSITE — this ADDS onto buf:scene.illum. Nothing here touches
  // composed scene colour (see this module's header). ─────────────────────
  const rawLight = cookieTinted.mul(uStrength).mul(coverage).mul(cloudFactor).toVar('winRawLight');

  // ── THE HIGHLIGHT SHOULDER — the transcription of
  // `window-cookie.js#shoulderedContribution`. Shapes on the PEAK channel and
  // rescales all three by the SAME ratio, so hue/saturation survive
  // compression — see that function's own header for why this exists at all
  // (found live: a large cookie over bright architectural art washed out to
  // a flat, textureless white disc) and why it shapes the peak rather than
  // each channel independently (per-channel compression desaturates a
  // saturated cookie exactly where it is brightest).
  const rawPeak = max(max(rawLight.r, rawLight.g), rawLight.b).toVar('winRawPeak');
  const rawPeakSafe = max(rawPeak, float(1e-5));
  const shapedPeak = rawPeakSafe.div(float(1).add(rawPeakSafe.mul(float(WINDOW_SHOULDER_K))));
  const shoulderScale = shapedPeak.div(rawPeakSafe);
  const shoulderedLight = rawLight.mul(shoulderScale).toVar('winShouldered');

  // ── THE DAYLIGHT TINT — LAST, AFTER THE SHOULDER, ON PURPOSE ─────────────
  // See `uDaylightTint`'s own declaration for the full reasoning; the short
  // version: the shoulder's whole job is to correctly expose the RAW light
  // this window actually receives — the glass's warp, its prism split, its
  // caustic — and the astrolabe tint is not part of that light at all, it is
  // a colour grade laid over the finished result (dusk staining a whole room
  // orange, not one particular photon). Multiplying it in BEFORE the shoulder
  // would let it change what the shoulder sees as "the peak": an orange tint
  // dims the blue channel, which lowers the measured peak, which makes the
  // shoulder compress LESS — so how hard a bright cookie gets compressed
  // would depend on the time of day, an entanglement between two effects
  // that have no business influencing each other's exposure math. Multiplying
  // it in AFTER means the shoulder always sees and shapes the same raw light
  // regardless of the hour, and the tint only ever recolours the result.
  //
  // A plain multiply, not a mix: the JS side already folded the astrolabe's
  // dayFactor01/twilight01 into this ONE colour, so noon lands on (1,1,1)
  // (no-op) by construction, not by an extra "amount" knob here.
  const cookieLight = shoulderedLight.mul(uDaylightTint).toVar('winFinal');

  /** @param {*} material */
  function configureShared(material) {
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    // ⚠️ A negative scale (Foundry's horizontal-flip convention) reverses the
    // effective winding and FrontSide would cull the quad as a backface —
    // visible in every JS status field and invisible on screen
    // (`feedback_doubleside_invisible_to_status_reports`).
    material.side = THREE.DoubleSide;
  }

  // ADDITIVE ONLY — buf:scene.illum is accumulated by ambient fill (overwrite),
  // region darkness (overwrite within footprint) and point lights (MAX), then
  // this draws AFTER all three: One/One on colour, and destination alpha left
  // EXACTLY as it was (Zero·src + One·dst is the identity), matching
  // specular's own alpha discipline — this pass has no opinion about
  // whatever convention illum's alpha carries.
  const windowMaterial = new THREE.NodeMaterial();
  windowMaterial.colorNode = vec4(cookieLight, 1);
  configureShared(windowMaterial);
  windowMaterial.blending = THREE.CustomBlending;
  windowMaterial.blendEquation = THREE.AddEquation;
  windowMaterial.blendSrc = THREE.OneFactor;
  windowMaterial.blendDst = THREE.OneFactor;
  windowMaterial.blendEquationAlpha = THREE.AddEquation;
  windowMaterial.blendSrcAlpha = THREE.ZeroFactor;
  windowMaterial.blendDstAlpha = THREE.OneFactor;

  // ── THE INSTRUMENT — a second material no mesh draws until asked ────────
  // `window.js#WINDOW_DEBUG_CHANNELS` holds the why and the reading guide.
  const uDebugChannel = uniform(float(0));
  // The mask/presence/level/tint channels show the GREEN (undispersed) tap —
  // it is the one that lands on the base deflection, so it is the honest
  // single representative of a decode that is now three decodes. Their
  // reading guides in `window.js` say so.
  const debugNodes = {
    quad: vec3(1, 0, 1),
    mask: tapG.sample.rgb,
    presence: vec3(tapG.presence, tapG.presence, tapG.presence),
    level: vec3(tapG.level, tapG.level, tapG.level),
    tint: tapG.tint,
    floorGate: debugFloorGate,
    daylightTint: uDaylightTint,
    glassHeight: debugGlassHeight,
    glassOffset: debugGlassOffset,
    // Mid-grey IS 1.0 — so "no focusing anywhere" reads as a flat grey field
    // rather than as a black one that could be confused with a dead channel.
    caustic: vec3(1, 1, 1).mul(causticGain.mul(float(0.5))),
    rawLight: rawLight.mul(float(WINDOW_DEBUG_BOOST)),
    final: cookieLight.mul(float(WINDOW_DEBUG_BOOST)),
  };
  // ⚠️ ARITHMETIC, NOT `select()`. This shared the specular selector's exact
  // shape and therefore its exact defect — every channel's maths inside its own
  // WGSL branch, so a `.toVar()` assigned in one branch reads as zero in all the
  // others. Window's channels have never been live-read, so this was caught
  // before it cost anything rather than after; `effects/debug-channel-select.js`
  // carries the dumped shader that proves the mechanism.
  const debugColor = buildDebugChannelColor(TSL, {
    channels: WINDOW_DEBUG_CHANNELS,
    nodes: debugNodes,
    uDebugChannel,
    label: 'window',
  });
  const debugMaterial = new THREE.NodeMaterial();
  debugMaterial.colorNode = vec4(debugColor, 1);
  configureShared(debugMaterial);
  // OPAQUE where the effect ADDS: a diagnostic whose "this is zero" answer
  // rendered as *nothing added* would reproduce the ambiguity it removes.
  debugMaterial.blending = THREE.CustomBlending;
  debugMaterial.blendEquation = THREE.AddEquation;
  debugMaterial.blendSrc = THREE.OneFactor;
  debugMaterial.blendDst = THREE.ZeroFactor;
  debugMaterial.blendEquationAlpha = THREE.AddEquation;
  debugMaterial.blendSrcAlpha = THREE.OneFactor;
  debugMaterial.blendDstAlpha = THREE.ZeroFactor;

  return {
    windowMaterial,
    debugMaterial,
    maskTexNodes,
    /** THE ONE DOOR onto the mask texture — ALL THREE dispersion taps, never
     * just the first (see `sampleCookieAt`'s own warning). */
    setMaskTexture(tex) {
      for (const node of maskTexNodes) node.value = tex;
    },
    /** The crop's extent in MASK-UV space — the entire mask lookup.
     * @param {{minU:number,minV:number,maxU:number,maxV:number}} b */
    setMaskUvBounds(b) {
      uMaskUvBounds.value.set(b.minU, b.minV, b.maxU, b.maxV);
    },
    /**
     * `computeTieSafeExpectedDepth(rank, maxRank)` for THIS quad's own
     * background item's rank, on the SAME cadence the old floor index used
     * (the subsystem's own `sync()`, whenever the viewed floor changes) —
     * see `uExpectedDepth`'s own declaration above. @param {number} depth */
    setExpectedDepth(depth) {
      uExpectedDepth.value = Number.isFinite(depth) ? depth : 0;
    },
    setStrength(v2) {
      uStrength.value = Math.max(0, v2);
    },
    setContrast(v2) {
      uContrast.value = Math.max(0.001, v2);
    },
    /** The resolved (already time-of-day-mixed) RGB — see `uDaylightTint`'s
     * own doc. `[1,1,1]`/anything malformed falls back to neutral, never NaN
     * (`feedback_raw_seed_into_noise_coordinate`'s same "never feed the GPU an
     * unvalidated number" lesson, one layer up). @param {readonly number[]} rgb */
    setDaylightTint(rgb) {
      const [r, g, b] = Array.isArray(rgb) && rgb.length === 3 ? rgb : [1, 1, 1];
      uDaylightTint.value.set(Number.isFinite(r) ? r : 1, Number.isFinite(g) ? g : 1, Number.isFinite(b) ? b : 1);
    },

    /**
     * THE GLASS, in one call — the subsystem resolves every one of these from
     * `WINDOW_PARAMS` and pushes them together, so a partial update can never
     * leave the pane half-described.
     *
     * ⚠️ `seedOffset` arrives ALREADY HASHED, from
     * `window-glass.js#computeSeedOffset`. Do not pass a raw seed here — that
     * is the named bug (`feedback_raw_seed_into_noise_coordinate`), and this
     * setter cannot tell the two apart.
     *
     * @param {object} g
     */
    setGlass(g = {}) {
      const num = (x, fallback) => (Number.isFinite(x) ? x : fallback);
      uGlassWarpPx.value = Math.max(0, num(g.warpPx, WINDOW_DEFAULT_GLASS_WARP_PX));
      uGlassDispersion.value = Math.min(1, Math.max(0, num(g.dispersion, WINDOW_DEFAULT_GLASS_DISPERSION)));
      uGlassScale.value = Math.max(1, num(g.scale, WINDOW_DEFAULT_GLASS_SCALE));
      uGlassDetail.value = Math.min(1, Math.max(0, num(g.detail, WINDOW_DEFAULT_GLASS_DETAIL)));
      uGlassStriation.value = Math.min(1, Math.max(0, num(g.striation, WINDOW_DEFAULT_GLASS_STRIATION)));
      uGlassStriationAngle.value = num(g.striationAngleDeg, WINDOW_DEFAULT_GLASS_STRIATION_ANGLE);
      uGlassCausticStrength.value = Math.max(0, num(g.causticStrength, WINDOW_DEFAULT_GLASS_CAUSTIC_STRENGTH));
      uGlassCausticSharpness.value = Math.max(0.5, num(g.causticSharpness, WINDOW_DEFAULT_GLASS_CAUSTIC_SHARPNESS));
      const off = g.seedOffset;
      uGlassSeedOffset.value.set(
        Array.isArray(off) && Number.isFinite(off[0]) ? off[0] : 0,
        Array.isArray(off) && Number.isFinite(off[1]) ? off[1] : 0
      );
    },

    /**
     * MASK-UV PER WORLD PIXEL — see `uUvPerWorldPx`'s own doc. Zero disables
     * the refraction by construction (a zero-size crop cannot be sampled
     * meaningfully), which is the correct behaviour before the mask lands.
     * @param {number} uPerPx @param {number} vPerPx
     */
    setUvPerWorldPx(uPerPx, vPerPx) {
      uUvPerWorldPx.value.set(Number.isFinite(uPerPx) ? uPerPx : 0, Number.isFinite(vPerPx) ? vPerPx : 0);
    },
    /** Which intermediate `debugMaterial` shows. 0 = off; the CALLER makes 0
     * free by DETACHING the material rather than leaving it attached. */
    setDebugChannel(n) {
      uDebugChannel.value = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    },
    floorGateCompiled: !!depthTexture,
  };
}
