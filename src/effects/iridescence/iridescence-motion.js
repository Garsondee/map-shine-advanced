/**
 * IRIDESCENCE MOTION — the pure math behind mask reading, the two noise
 * flavours, the phase field and the spectral cosine palette
 * (mythica-machina-press#136).
 *
 * Every function here is a straight, verified transcription of V2's own real
 * arithmetic (`legacy/compositor-v2/effects/IridescenceEffectV2.js`, recovered
 * from git history at `c328c9bd~1`) — the sibling module to `prism-motion.js`,
 * built the same night for the identical reason (a V2 suffix effect the
 * current engine never got). No THREE, no `canvas`/`game` — plain numbers in,
 * plain numbers out, so this whole file is directly Node-testable
 * (CONVENTIONS §4): the MATHS lives here as stateless functions,
 * `iridescence-render.js` transcribes the IDENTICAL formulas into TSL
 * node-graph form for the GPU.
 *
 * ============================================================================
 * THE ONE REAL DEPARTURE FROM V2 — LIGHT REACTIVITY VIA `buf:scene.illum`
 * ============================================================================
 * V2 re-implemented its own per-light loop (position/colour/radius/falloff
 * arrays fed as uniforms, `MAX_LIGHTS = 64`) because V2 had no shared
 * illumination buffer of its own. This engine already has one:
 * `buf:scene.illum` (`graph/passes.js#light.accumulate`), the SAME buffer
 * `surface.response`'s own note describes reading for its own light-reactive
 * direction trick. Sampling it at this surface's own screen position is the
 * simpler, more idiomatic replacement for V2's whole per-light-array
 * mechanism — real light reactivity (bright near a lamp, dim in shadow,
 * tinted by lamp colour) for a fraction of the code and no new light-feeding
 * infrastructure. `computeLitFactor` below is the CPU-testable half of that
 * read; `iridescence-render.js` does the actual `texture(illumTexture)`
 * sample. A genuine per-light system (V2's own MAX_LIGHTS loop, reproduced
 * faithfully) is a real, separate, bigger undertaking — noted as a follow-up,
 * not attempted here.
 *
 * @module effects/iridescence/iridescence-motion
 */

/** @param {number} v @returns {number} */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** @param {number} x @param {number} lo @param {number} hi @returns {number} `smoothstep(lo, hi, x)`, GLSL's own formula. */
function smoothstep(lo, hi, x) {
  if (hi <= lo) return x < lo ? 0 : 1;
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}

/**
 * V2's own `hash(vec2 p)` (`IridescenceEffectV2.js#_getFragmentShader`'s own
 * `hash`), transcribed exactly: one dot product through the same sine/scale
 * trick every hash-based noise in this codebase uses (`prism-motion.js#hash2`'s
 * own sibling, one dimension down — this one returns a single scalar, not a
 * pair, matching V2's own single-value `hash()`).
 *
 * @param {number} x @param {number} y
 * @returns {number} in [0, 1).
 */
export function hash(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * `noiseScale` is authored as a 0..1 UI value (`IRIDESCENCE_PARAMS
 * .noiseScale`) and mapped internally to a genuinely different shader
 * frequency PER noise flavour — V2's own `_mapNoiseScale(uiNoise, noiseType)`,
 * transcribed exactly (an exponential ramp between each flavour's own
 * min/max, so the 0..1 slider always covers a musically-useful range whether
 * the author is dialling in the smooth "Liquid" field or the grainy
 * "Glitter" one).
 *
 * @param {number} uiNoise - 0..1.
 * @param {number} noiseType - 0 (Liquid, smooth) or 1 (Glitter, grainy).
 * @returns {number} the actual frequency multiplier fed to the noise field.
 */
export function mapNoiseScale(uiNoise, noiseType) {
  const t = clamp01(Number.isFinite(uiNoise) ? uiNoise : 0);
  if (Number(noiseType) === 0) {
    const minScale = 0.002;
    const maxScale = 0.05;
    return minScale * Math.pow(maxScale / minScale, t);
  }
  const minScale = 0.5;
  const maxScale = 5.0;
  return minScale * Math.pow(maxScale / minScale, t);
}

/**
 * THE MASK READ — V2's own deliberate `max(luminance, peak-channel) * alpha`
 * (`IridescenceEffectV2.js`'s own comment, verbatim: "Do NOT use a separate
 * alpha-only branch that sets rawMask=a when RGB≈0 -- opaque black padding
 * would read full strength while painted props (non-black RGB) went through
 * luminance and looked inverted vs padding"). Unlike `prism`'s own mask read
 * (`prism-render.js`'s own `maskLuma`, RGB-only — Prism's loader drops
 * nothing but never needed alpha either), Iridescence genuinely needs the
 * mask's OWN alpha channel: `scene/mask-catalog.js`'s `iridescence` kind is
 * loaded the identical `channels: 'rgb'` way Prism's is (`vt/mask-image.js`'s
 * own `'rgb'` mode uploads all FOUR bytes, alpha included, despite the name —
 * see that module's own header), so the alpha this function reads is real
 * authored data, not a stub.
 *
 * @param {object} args
 * @param {number} args.r @param {number} args.g @param {number} args.b - 0..1.
 * @param {number} args.a - 0..1.
 * @param {number} args.maskThreshold
 * @param {boolean} args.invertMask
 * @returns {number} `maskVal`, 0..1 — the smoothstep-gated presence used to
 *   scale everything downstream.
 */
export function computeMaskPresence({ r, g, b, a, maskThreshold, invertMask }) {
  const lum = clamp01(0.299 * r + 0.587 * g + 0.114 * b);
  const peak = Math.max(r, g, b);
  const rgbBright = Math.max(lum, peak);
  const t = invertMask ? 1 - rgbBright : rgbBright;
  const rawMask = t * clamp01(Number.isFinite(a) ? a : 0);
  return smoothstep(clamp01(Number.isFinite(maskThreshold) ? maskThreshold : 0), 1, rawMask);
}

/**
 * NOISE FLAVOUR 0 — "Liquid" — V2's own smooth two-octave sine field, rotated
 * by the golden angle so the two octaves never align into a visible grid
 * (`IridescenceEffectV2.js`'s own `else` branch of the noise `if`).
 *
 * @param {number} worldX @param {number} worldY - `positionWorld.xy`, unscaled.
 * @param {number} noiseScale - already through `mapNoiseScale`.
 * @returns {number} `randomOffset`, roughly in [-2.25, 2.25] (V2's own
 *   unbounded-but-small range — never clamped, matching the source exactly).
 */
export function computeLiquidNoise(worldX, worldY, noiseScale) {
  const wx = worldX * noiseScale;
  const wy = worldY * noiseScale;
  const PHI = 1.61803398875;
  const cosPhi = Math.cos(PHI);
  const sinPhi = Math.sin(PHI);
  const rx = cosPhi * wx - sinPhi * wy;
  const ry = sinPhi * wx + cosPhi * wy;
  const n1 = Math.sin(rx) * Math.cos(ry);
  const n2 = Math.sin(2.7 * rx + 1.3) * Math.cos(2.7 * ry - 0.7);
  return (n1 + 0.5 * n2) * 1.5;
}

/**
 * NOISE FLAVOUR 1 — "Glitter" — V2's own per-grid-cell hash jitter
 * (`IridescenceEffectV2.js`'s own `if (uNoiseType > 0.5)` branch): a blocky,
 * faceted sparkle rather than the Liquid flavour's continuous, oily field.
 *
 * @param {number} worldX @param {number} worldY - `positionWorld.xy`, unscaled.
 * @param {number} noiseScale - already through `mapNoiseScale`.
 * @returns {number} `randomOffset`, in [0, 1).
 */
export function computeGlitterNoise(worldX, worldY, noiseScale) {
  const gridX = Math.floor(worldX * noiseScale);
  const gridY = Math.floor(worldY * noiseScale);
  const jitterX = hash(gridX + 13.1, gridY + 13.1);
  const jitterY = hash(gridX + 91.7, gridY + 91.7);
  return hash(gridX + jitterX, gridY + jitterY);
}

/**
 * Dispatches to the flavour `noiseType` selects. Kept as a real function
 * (rather than inlined at each call site) so both the Node test suite and
 * `iridescence-render.js`'s own header can point at ONE place that states
 * "0 is Liquid, 1 is Glitter" — see `iridescence-render.js`'s own doc for why
 * the TSL side treats this as a JS-TIME branch (a genuinely different graph
 * shape, mirroring `prism-render.js#facetAnimate`'s identical reasoning),
 * never a live uniform mix of both formulas at once.
 *
 * @param {number} worldX @param {number} worldY
 * @param {number} noiseScale
 * @param {number} noiseType - 0 or 1.
 * @returns {number}
 */
export function computeNoiseOffset(worldX, worldY, noiseScale, noiseType) {
  return Number(noiseType) === 0
    ? computeLiquidNoise(worldX, worldY, noiseScale)
    : computeGlitterNoise(worldX, worldY, noiseScale);
}

/**
 * THE PHASE FIELD — V2's own sum of five independent terms
 * (`IridescenceEffectV2.js#_getFragmentShader`'s own `main`): a directional
 * screen-space sweep, the noise flavour above, the mask's own distortion
 * contribution, a flowing clock term, and camera parallax.
 *
 * `screenU`/`screenV` here are NOT V2's own `gl_FragCoord/uResolution` device
 * pixels — this engine substitutes the SAME world-position-derived
 * screen-space UV every other depth-authority/illum consumer in this codebase
 * already uses (`prism-render.js`'s own occlusion gate, `specular-render.js`'s
 * own `illumSample` read), 0..1 across the current view rect. A genuinely
 * equivalent "where on screen is this fragment" signal, in the units this
 * renderer already standardises on rather than V2's own device-pixel one.
 *
 * `cameraOffsetX/Y` are the camera's OWN absolute world-space centre — V2's
 * own `uCameraOffset.value.set(camera.position.x, camera.position.y)`
 * (`IridescenceEffectV2.js#render`), an ABSOLUTE position, not a per-frame
 * delta (unlike `prism-motion.js#computeFacetUv`'s own `cameraOffsetX/Y`,
 * which Prism's own facet-shift-parallax genuinely needed as a delta). This
 * effect's own parallax term is a plain additive scalar (`(x+y)*0.001*
 * strength`), so the absolute camera centre this engine's own pan-viewer
 * already tracks (`view.centerXPx/centerYPx`) plugs in directly — a more
 * faithful port than reinventing V2's own semantics as a delta the way Prism
 * had to.
 *
 * `angleDeg` is authored in DEGREES (V2's own 0-360 UI convention,
 * `IRIDESCENCE_PARAMS.angleDeg`) and converted to radians right here — the same
 * "keep the value in the authored unit, convert at the point of use"
 * convention `iridescence-render.js`'s own `angleRad` mirrors in TSL.
 *
 * @param {object} args
 * @param {number} args.screenU @param {number} args.screenV - 0..1.
 * @param {number} args.angleDeg - degrees, 0..360.
 * @param {number} args.randomOffset - `computeNoiseOffset`'s own output.
 * @param {number} args.maskVal - `computeMaskPresence`'s own output.
 * @param {number} args.distortionStrength
 * @param {number} args.elapsedSec
 * @param {number} args.flowSpeed
 * @param {number} args.cameraOffsetX @param {number} args.cameraOffsetY
 * @param {number} args.parallaxStrength
 * @returns {number} `phase`, unbounded.
 */
export function computePhase({
  screenU,
  screenV,
  angleDeg,
  randomOffset,
  maskVal,
  distortionStrength,
  elapsedSec,
  flowSpeed,
  cameraOffsetX,
  cameraOffsetY,
  parallaxStrength,
}) {
  const angle = (Number.isFinite(angleDeg) ? angleDeg : 0) * (Math.PI / 180);
  const diagonalSweep = screenU * Math.cos(angle) + screenV * Math.sin(angle);
  const t = Number.isFinite(elapsedSec) && elapsedSec > 0 ? elapsedSec : 0;
  const parallaxTerm =
    ((Number.isFinite(cameraOffsetX) ? cameraOffsetX : 0) + (Number.isFinite(cameraOffsetY) ? cameraOffsetY : 0)) *
    0.001 *
    (Number.isFinite(parallaxStrength) ? parallaxStrength : 0);
  return (
    diagonalSweep +
    randomOffset +
    maskVal * (Number.isFinite(distortionStrength) ? distortionStrength : 0) +
    t * (Number.isFinite(flowSpeed) ? flowSpeed : 0) +
    parallaxTerm
  );
}

/**
 * THE RAINBOW — V2's own classic Inigo-Quilez-style cosine palette
 * (`IridescenceEffectV2.js`'s own `rainbowColor` line): one scalar phase in,
 * a smoothly cycling RGB out. The `(0, 2, 4)` constant spacing evenly around
 * the colour wheel is the whole trick — not authored, not looked up, purely
 * arithmetic.
 *
 * @param {number} phase - `computePhase`'s own output.
 * @param {number} colorCycleSpeed
 * @param {number} phaseMult
 * @returns {{r: number, g: number, b: number}} each in [0, 1].
 */
export function computeRainbowColor(phase, colorCycleSpeed, phaseMult) {
  const colorPhase = phase * (Number.isFinite(colorCycleSpeed) ? colorCycleSpeed : 0);
  const k = colorPhase * 6.28 * (Number.isFinite(phaseMult) ? phaseMult : 0);
  return {
    r: 0.5 + 0.5 * Math.cos(k),
    g: 0.5 + 0.5 * Math.cos(k + 2.0),
    b: 0.5 + 0.5 * Math.cos(k + 4.0),
  };
}

/**
 * LIGHT REACTIVITY — see this module's own header for the `buf:scene.illum`
 * decision. V2's own `litFactor = mix(lightLuma, 1.0, ignoreDarkness)`
 * (`IridescenceEffectV2.js`'s own final block), unchanged: `ignoreDarkness`
 * still dials between "fully obeys the buffer's own luma" (0) and "ignores
 * darkness entirely, always full brightness" (1). Only WHERE `lightLuma`
 * comes from changed — V2 summed its own ambient+point-light terms and took
 * their luma; this reads it straight off `buf:scene.illum`
 * (`iridescence-render.js`'s own `texture(illumTexture)` sample), which
 * already carries Foundry's ambient/point-light/darkness mix.
 *
 * @param {number} illumLuma - the luma of the sampled `buf:scene.illum` texel.
 * @param {number} ignoreDarkness
 * @returns {number} `litFactor`, the multiplier the rainbow colour is scaled by.
 */
export function computeLitFactor(illumLuma, ignoreDarkness) {
  const luma = Number.isFinite(illumLuma) ? illumLuma : 0;
  const ignore = clamp01(Number.isFinite(ignoreDarkness) ? ignoreDarkness : 0);
  return luma + (1 - luma) * ignore;
}

/** How many performance-cascade rungs this effect declares (0..2, `iridescence.js#IRIDESCENCE.tiers`). */
export const IRIDESCENCE_MAX_TIER = 2;

/**
 * `resolveEffectTier(IRIDESCENCE, {profile: DEFAULT_PERFORMANCE_PROFILE})`'s
 * own fallback — mirrors `prism-motion.js#PRISM_DEFAULT_TIER`'s own reasoning
 * exactly: every rung above tier 0 is gated `'quality'` or higher
 * (`iridescence.js#IRIDESCENCE.tiers`) and the manifest itself only turns on
 * at `'extreme'` (`IRIDESCENCE.enabledFromProfile`), so the one profile that
 * can ever resolve this effect at all already affords every rung.
 */
export const IRIDESCENCE_DEFAULT_TIER = IRIDESCENCE_MAX_TIER;

/**
 * The tier ladder, as a plan a builder can branch on — mirrors
 * `prismTierPlan`'s own shape exactly, one rung shorter (Iridescence has no
 * separate "glint" concept — V2's own look is a single continuous phase
 * field, not a directional highlight, so there is no third rung to split out).
 *
 * @param {number} tier
 * @returns {{tier: number, flowEnabled: boolean, lightReactiveEnabled: boolean}}
 */
export function iridescenceTierPlan(tier) {
  const t = Number.isFinite(tier)
    ? Math.max(0, Math.min(IRIDESCENCE_MAX_TIER, Math.floor(tier)))
    : IRIDESCENCE_DEFAULT_TIER;
  return {
    tier: t,
    flowEnabled: t >= 1,
    lightReactiveEnabled: t >= 2,
  };
}
