/**
 * WATER TIER 3 — SUN + SKY SPECULAR (`docs/planning/Water.md` §6, rung 3).
 *
 * ============================================================================
 * ⚠️ THIS RUNG SHIPPED INVISIBLE AND WAS MEASURED, NOT GUESSED — 2026-07-29
 * ============================================================================
 * Read this before touching anything below it, because the code was *correct
 * physics producing nothing*, which is the hardest shape to spot by reading.
 *
 * A CPU twin (`waterTier3Cpu`, at the bottom of this file, and the brightness
 * bands in `__tests__/water-light.test.mjs`) measured what this rung actually
 * puts into `buf:scene.color`, in the units the screen uses. Against the same
 * bands `Specular.md` §10 established — **0.008 invisible · 0.05 a sheen · 0.3
 * unmistakable** — as shipped it measured:
 *
 *   · sun glint  1e-6 … 1e-3   (up to ten THOUSAND times below visible)
 *   · sky sheen  0.0084, spatially CONSTANT (1.1x swing across the whole view)
 *
 * A flat, invisible wash. Two decisions caused it, and neither is wrong alone
 * — they are wrong TOGETHER, because they belong to different models:
 *
 *   1. **`glossiness` 0.92** — `alpha = 0.0079`, thirty times tighter than
 *      Cox & Munk's measured DEAD CALM sea surface. A polish real water never
 *      reaches at any wind speed.
 *   2. **A flat `N = (0,0,1)`**, spelled as `.z` swizzles rather than as a
 *      vector, so it never looked like an assumption at all.
 *
 * A BRDF's roughness IS a surface's statistical slope distribution. Claiming
 * "polished mirror" AND "perfectly flat" says the surface has no slope at any
 * scale — so the sun's mirror locus collapses to one exact point, and measured,
 * that point sits **1.7 to 11.2 screen half-widths outside the view** at every
 * sun elevation below ~75°. There was nothing on screen to see, at any setting
 * of any slider, and no amount of gain would have changed that: the pixels that
 * could have been bright were not in the frame.
 *
 * **The fix is the split this rung always implied.** `water-field.js` already
 * computed a wave field and threw its third channel away; its own header even
 * promised the slope would *"arrive in rung 3 with the shading that makes it
 * mean something."* It now does. So:
 *
 *   · the RESOLVED slope is a real per-pixel normal from the wave field, and
 *   · `glossiness` carries only the UNRESOLVED microstructure below it
 *     (capillary ripple), which is what a roughness is for.
 *
 * Measured at that pair, sun 60°: p99 brightness **0.0084 → 0.196**, with ~5%
 * of the surface sparkling. Mostly-dark water with bright moving specks — what
 * overhead sun glitter actually looks like, and a thing a flat plane cannot do.
 *
 * ⚠️ **DO NOT "SIMPLIFY" `dot(normalNode, x)` BACK TO `x.z`.** They are the
 * same expression when `N = (0,0,1)` and that identity is precisely how this
 * bug hid: every `.z` read as ordinary code while silently asserting the
 * surface was flat.
 *
 * ============================================================================
 *
 * The ladder's own words for this rung: "GGX specular + Fresnel-weighted sky
 * reflection from the sky handle. No new bandwidth." That last clause is load
 * bearing and shapes everything below: no lamp glint, no `buf:scene.illum`
 * read, no `buf:scene.attr` occlusion. The wave normal keeps that promise — it
 * rides the fetch `water-field.js` was already making, so the fix cost no new
 * bandwidth either.
 *
 * Tiers 0-2 already draw as two meshes
 * inside `geometry.world`'s own flat paint-order sort (`water-render.js`'s
 * header), which is what makes them free to occlude and free to draw — tier 3
 * stays exactly there rather than moving to its own post-lighting scene, by
 * reading ONLY things that are already available at that pass's time: the sky
 * handle (pure JS values, no buffer) and the world-space `_Outdoors` mask
 * (a static authored texture, not a render target with pass-ordering
 * constraints). `effects/specular/` needed a second scene and explicit
 * `buf:scene.attr` occlusion specifically BECAUSE it reads `buf:scene.illum`,
 * which does not exist until `light.accumulate` has run — water tier 3
 * deliberately does not ask for that, and inherits water's existing free
 * occlusion by staying out of that trade entirely.
 *
 * ============================================================================
 * THE PHYSICS IS SHINE'S OWN, TRANSCRIBED INDEPENDENTLY — NOT IMPORTED
 * ============================================================================
 * `effects/specular/specular-render.js` already proved this exact shape live:
 * a flat N=(0,0,1) surface, a synthesised eye at a height expressed as a RATIO
 * of the visible width (never world px — an absolute height makes the sweep
 * vanish as the author zooms in, which reads as "the effect is subtle" rather
 * than as a bug), one GGX+Smith+Schlick lobe for the sun disc, and a Fresnel
 * term for the sky dome. Water.md's own design invariant states it plainly:
 * "ONE GGX — never a second 'highlights' stack that could never agree."
 *
 * This file is nonetheless a SEPARATE transcription, not an import of
 * specular's TSL closures, for two reasons: those closures are private to
 * `buildSpecularSurfaceMaterial` (not exported — confirmed by grep), and
 * `effects/specular/` is itself uncommitted, unverified work-in-progress
 * ("NEVER COMPILED ON A GPU" per its own build note) at the moment this rung
 * is written. Depending on an in-flight, unproven module — or editing it to
 * export what water would need — is a heavier and riskier change than this
 * rung asks for. The formulas below are copied by hand from the live
 * `specular-render.js` source, not re-derived, for a specific reason: this
 * codebase's own memory names an exact bug class here (`sky-access`'s key
 * direction sat 90°-and-mirrored wrong for its entire life under a comment
 * claiming it agreed with the shadows) and re-deriving sun-direction trig from
 * scratch risks repeating precisely that. The one function most exposed to
 * that risk, `waterKeyLightDirection`, is a byte-for-byte match of
 * `specular-material.js#keyLightDirection`.
 *
 * A shared GGX/Fresnel module is the honest long-term fix once specular's own
 * work is committed and stable — recorded here rather than silently deferred.
 *
 * ============================================================================
 * WHY WATER'S OWN F0, NOT SPECULAR'S
 * ============================================================================
 * `specular-material.js`'s own comment on `DIELECTRIC_F0 = 0.04` states the
 * per-material values directly: "water 0.02, glass 0.04, most stone/plastic
 * 0.04-0.05" — 0.04 is the general-purpose average specular needs because its
 * mask can paint anything; water is always water, so it gets water's own
 * number rather than the average. `WATER_MIN_ROUGHNESS` is copied at the SAME
 * value as specular's, deliberately: that floor exists to stop the GGX
 * denominator collapsing to `Inf` on a `HalfFloatType` target (`Inf × 0` is
 * `NaN` downstream), which is a fact about fp16 arithmetic, not an opinion
 * about any one material — the same number is correct here for the same
 * reason, not a coincidence worth "fixing" into a different value.
 *
 * ============================================================================
 * WHY THE REFLECTION IS NEVER TINTED BY THE WATER'S OWN COLOUR
 * ============================================================================
 * A mirror reflection off a dielectric surface is not coloured by the medium
 * beneath it — that is why a lake reflects a blue sky as blue and an orange
 * sunset as orange, regardless of the water's own body colour underneath. Only
 * a CONDUCTOR's F0 takes on the surface's own hue (specular's metalness mix
 * does exactly that for painted metal). Water has no metalness channel and no
 * decode step here at all: F0 is a single neutral constant, and the returned
 * colour rides entirely on the sky handle's own key/fill colours.
 *
 * THREE is INJECTED, never imported.
 *
 * @module effects/water/water-light
 */

// INTRA-ZONE, and an IMPORT rather than an injected seam — deliberately, and
// the two halves of that choice have different reasons. Importing at all:
// `Water.md` §7 has listed "sun occlusion → `buf:scene.vis`" as one of water's
// seven handles since the design was written, and there must be exactly ONE
// implementation of "world XY → shadow-field UV → sample" (this project has
// already paid for two copies of a screen↔world mapping drifting apart). Not
// injecting it, the way `buildOutdoorsGate` is: an injected seam that nobody
// wires renders perfectly on its default and every downstream control is dead
// (`feedback_seam_default_hides_unwired`, which is exactly how water's own
// render-state seam shipped inert once already). An import cannot be unwired.
// The module is 100 lines, imports nothing itself, and takes TSL as an
// argument — nothing about importing it costs what injection was buying.
import { buildWorldSpaceSunVisibilityNode } from '../lighting/sun-occlusion-render.js';

/** Water's own Fresnel-at-normal-incidence, from its IOR (~1.33) — see the
 * header for why this is NOT specular's 0.04 general-dielectric average. */
export const WATER_F0 = 0.02;

/** Same fp16 GGX-denominator guard as `specular-material.js#MIN_ROUGHNESS`,
 * same value, same reason — see the header. */
export const WATER_MIN_ROUGHNESS = 0.089;

export const WATER_TIER3_SUN_GLINT = 2;
export const WATER_TIER3_SKY_SHEEN = 0.54;

/**
 * 0 = a rough, scattered highlight; 1 = a tight mirror disc.
 *
 * ⚠️ **0.755, DOWN FROM 0.92 — AND 0.92 IS MOST OF WHY THIS RUNG WAS INVISIBLE
 * (measured 2026-07-29).** The old value was chosen as "calm water defaults
 * near-mirror", which sounds right and is not: a BRDF's roughness is not a mood,
 * it is the surface's own statistical SLOPE DISTRIBUTION. Against Cox & Munk's
 * measured sea-surface statistics (`water-field.js#WATER_TIER3_CHOP` carries the
 * formula), 0.92 implies `alpha = 0.0079` — **thirty times tighter than DEAD
 * CALM water**, a polish real water does not reach at any wind speed.
 *
 * What that cost: a lobe that narrow only fires where the half-vector lands
 * almost exactly on the normal, and with the flat normal this rung also shipped
 * with, that locus sits **1.7 to 11.2 screen half-widths off the edge of the
 * view** at every sun elevation below ~75°. The measured sun term was 1e-6 to
 * 1e-3 against an invisible-threshold of 0.008 — three orders of magnitude of
 * nothing, on a term that is supposed to be the rung's whole point.
 *
 * 0.755 gives `alpha = 0.06`, the microstructure BELOW the wave field's own
 * scale (capillary ripple). That split is the point: the RESOLVED slope is now
 * a real per-pixel normal from `water-field.js`, and this constant carries only
 * what is too fine to resolve. Measured at that pair, sun 60°: p99 brightness
 * 0.0084 → 0.196, with ~5% of the surface sparkling — mostly-dark water with
 * bright moving specks, which is what overhead sun glitter actually looks like.
 *
 * ⚠️ TWO PLACES STORE THIS NUMBER — here and `WATER_PARAMS.glossiness.default`
 * (`water.js`), which is what a scene actually ships with. A Node test pins
 * them equal; specular shipped that exact drift once (`SPECULAR_DEFAULT_
 * SHIMMER_GAIN`) and it is why the test exists.
 *
 * ⚠️ LOWERED 0.911→0.91 (2026-08-24, author's own live tuning pass) — a
 * DELIBERATE step back from the derived ceiling (`WATER_PARAMS.glossiness.max`
 * stays `1 − WATER_MIN_ROUGHNESS`, unmoved — that is a physical fact about
 * the roughness formula, not an author preference). The shipped default
 * used to sit EXACTLY at that ceiling (`water-light.test.mjs` once pinned
 * `WATER_TIER3_GLOSSINESS === WATER_PARAMS.glossiness.max` for exactly that
 * reason); it no longer does, on purpose — the author's new default leaves
 * a hair of the slider's own top end still meaningfully reachable above it,
 * where the old default consumed the whole thing.
 */
export const WATER_TIER3_GLOSSINESS = 0.91;

/** THE EYE HEIGHT, as a multiple of the VISIBLE WIDTH — never world px. Same
 * quantity, same reasoning, and the same default as
 * `specular-render.js#SPECULAR_DEFAULT_VIEWER_HEIGHT`: an absolute height
 * makes the angular spread — and therefore the sweep — vanish as the author
 * zooms in, at exactly the moment they are looking closest at the highlight.
 * Owned independently rather than shared with shine's own setting: this is a
 * LOOK parameter each effect's author tunes separately, not a graph resource
 * two consumers must agree on (unlike `uViewRect`, which IS shared, below). */
export const WATER_TIER3_VIEWER_HEIGHT = 1;

/** How strongly a CLEAR sky brightens toward the sun's own azimuth, as a
 * fraction. Not a param — see `specular-render.js#SKY_DIRECTIONAL`'s identical
 * reasoning: an overcast dome has no azimuthal structure for a reflection to
 * find, and `sky-access.js` already drives the key's strength to zero under
 * cloud, so nothing extra needs to know about weather. */
const SKY_DIRECTIONAL = 0.6;

/**
 * HOW COMPLETELY A CAST SHADOW PUTS OUT THE SUN GLINT, 0..1. Default **1** —
 * fully — because that is the physics and it is what the author asked for.
 *
 * Author, 2026-08-16: *"Sun glint needs to be defeated by shadows, in fact we
 * need to adjust the presentation of water with shadows in general."*
 *
 * ⚠️ **THE GLINT IS A MIRROR IMAGE OF THE SUN, NOT A BRIGHTNESS.** Everything
 * else water emits is albedo, and albedo in shadow is handled downstream for
 * free: water draws into `buf:scene.color` BEFORE lighting, so
 * `environmental-light.js` multiplies the whole pass by an ambient fill that
 * already carries `sunVis`. That is why this was not obviously missing — the
 * glint WAS being attenuated, by the same ~0.12..1 factor as the ground beside
 * it. But a specular lobe at `alpha = 0.06` routinely reaches ten times the
 * buffer's white point, and 10 × 0.3 is still blown out: the highlight visibly
 * survived shadows it should not exist inside at all
 * (`feedback_saturated_curve_cannot_transmit_variation`). An occluded surface
 * cannot reflect a sun it cannot see, at any ambient level, so the sun term
 * needs its OWN full gate rather than a share of the ambient's.
 *
 * ⚠️ A KNOWN, DELIBERATE DOUBLE-COUNT, stated rather than hidden: because this
 * rung's output is treated as albedo by the pass that lights it, a gated glint
 * is multiplied by `sunVis` twice — once here, once in the ambient fill. At
 * full sun (`sunVis = 1`) that is exactly a no-op, and in full shadow both
 * factors want zero, so the error lives only in the penumbra, where it makes
 * the glint fade a little early. The alternative is moving tier 3 out to a
 * post-lighting scene of its own, which is precisely the trade
 * `water-render.js`'s header rejects (it would cost water its free paint-order
 * occlusion). Correct-looking and cheap beats exactly-right and structural,
 * here, and the number is one slider away for an author who disagrees.
 */
export const WATER_TIER3_SHADOW_RESPONSE = 1;

/**
 * How much of the SKY sheen a cast shadow takes with it. Not a param, and much
 * smaller than the sun's own gate, because it answers a different question: a
 * point in a building's shadow still sees most of the sky dome — that is what
 * makes shadows blue rather than black — so a sheen that vanished with the sun
 * would be wrong in the other direction. What it genuinely loses is the sun's
 * own aureole, the bright patch of sky AROUND the disc, which is what
 * `SKY_DIRECTIONAL` models. 0.5 leaves the isotropic dome reflecting and takes
 * half the directional part, applied through `shadowResponse` like the glint so
 * one slider still governs the whole shadow behaviour.
 */
const SKY_SHEEN_SHADOW_SHARE = 0.5;

/**
 * The KEY LIGHT's unit 3-vector, from a surface toward the sun — a byte-for-
 * byte copy of `specular-material.js#keyLightDirection`. See the header for
 * why this is copied rather than re-derived: this exact conversion has a
 * documented history of sign/axis bugs in this codebase, and matching the
 * already-live formula is what avoids repeating one.
 *
 * @param {{dirX: number, dirY: number, elevationDeg: number}} key
 * @returns {number[]} a unit 3-vector.
 */
export function waterKeyLightDirection(key) {
  const el = ((Number(key?.elevationDeg) || 0) * Math.PI) / 180;
  const c = Math.cos(el);
  const s = Math.sin(el);
  const x = (Number(key?.dirX) || 0) * c;
  const y = (Number(key?.dirY) || 0) * c;
  const len = Math.hypot(x, y, s);
  return len > 1e-6 ? [x / len, y / len, s / len] : [0, 0, 1];
}

/**
 * Build tier 3's sky/sun reflection term.
 *
 * @param {object} args
 * @param {*} args.TSL - `THREE.TSL`, injected.
 * @param {*} args.positionWorld - the fragment's world-position node.
 * @param {*} args.uViewRect - envLight's OWN vec4 view-rect uniform, shared
 *   rather than duplicated — the identical reasoning `specular-render.js`
 *   states for the same parameter: two rects updated on different cadences is
 *   how the screen→world mapping drifts between two consumers of one frame.
 * @param {*} [args.uOutdoorsRect] @param {*} [args.outdoorsTexNode] - envLight's
 *   outdoors rect/texture, shared the same way.
 * @param {(TSL: *, args: object) => *} [args.buildOutdoorsGate] - the world-
 *   space gate builder, injected so this module never re-writes "world XY →
 *   mask UV → sample" (there is exactly ONE copy, in `environmental-light.js`).
 *   Absent (the un-wired/torture-fixture shape) compiles the whole reflection
 *   to a safe zero rather than throwing — `seams/viewer-wired`'s own posture.
 * @param {number} [args.glossiness]
 * @param {number} [args.viewerHeight]
 * @param {number} [args.sunGlint]
 * @param {number} [args.skySheen]
 * @param {number} [args.shadowResponse] - how completely a cast shadow puts the
 *   sun glint out ({@link WATER_TIER3_SHADOW_RESPONSE}).
 * @param {*} [args.sunShadowTexture] - the sun-shadow field for the floor this
 *   water sits on (`sun-shadow-subsystem.js`'s per-floor slots). Absent/null
 *   compiles the whole gate OUT — a JS-time branch, Effects.md Law 4 — which is
 *   exactly the pre-2026-08-16 behaviour: a glint that shines inside buildings.
 * @param {*} [args.slopeXY] - a vec2 node: the surface's own gradient
 *   (rise/run) from `water-field.js`. **This is what makes the rung visible at
 *   all** — see the header. Absent yields the flat `N = (0,0,1)` this module
 *   shipped with until 2026-07-29, kept ONLY so an un-wired caller degrades to
 *   the old look rather than throwing.
 * @returns {{reflection:*, setViewCentre:(x:number,y:number)=>void,
 *   setSky:(sky:object)=>void, setGlossiness:(v:number)=>void,
 *   setViewerHeight:(v:number)=>void, setSunGlint:(v:number)=>void,
 *   setSkySheen:(v:number)=>void, outdoorsGateCompiled:boolean,
 *   normalCompiled:boolean}}
 */
export function buildWaterSpecular({
  TSL,
  positionWorld,
  uViewRect,
  uOutdoorsRect,
  outdoorsTexNode,
  buildOutdoorsGate,
  glossiness = WATER_TIER3_GLOSSINESS,
  viewerHeight = WATER_TIER3_VIEWER_HEIGHT,
  sunGlint = WATER_TIER3_SUN_GLINT,
  skySheen = WATER_TIER3_SKY_SHEEN,
  shadowResponse = WATER_TIER3_SHADOW_RESPONSE,
  sunShadowTexture = null,
  slopeXY = null,
}) {
  const { vec2, vec3, vec4, float, uniform, texture, clamp, max, dot, normalize, sqrt, mix } = TSL;

  const uViewCentre = uniform(vec2(0, 0));
  const uViewerHeight = uniform(float(viewerHeight));
  const uGlossiness = uniform(float(glossiness));
  const uSunGlint = uniform(float(sunGlint));
  const uSkySheen = uniform(float(skySheen));
  const uShadowResponse = uniform(float(shadowResponse));
  /** The KEY LIGHT's unit 3-vector, assembled ONCE in JS from the sky handle
   * (`waterKeyLightDirection`), never from the hour — `env/one-sun`. */
  const uKeyDir = uniform(vec3(0, 0, 1));
  const uKeyColor = uniform(vec3(1, 1, 1));
  const uKeyStrength = uniform(float(0));
  const uFillColor = uniform(vec3(1, 1, 1));
  const uFillStrength = uniform(float(0));

  // ── THE SYNTHESISED EYE — identical construction to specular's own ───────
  // Only viewSpanX feeds the eye height; unlike specular this file has no
  // screen-UV mapping to derive (no illum/attr read here — see the header),
  // so there is no viewSpanY to compute.
  const viewSpanX = max(uViewRect.z.sub(uViewRect.x), float(1));
  const eye = vec3(uViewCentre.x, uViewCentre.y, viewSpanX.mul(uViewerHeight));
  const viewDir = normalize(eye.sub(vec3(positionWorld.x, positionWorld.y, float(0))));

  // ── THE SURFACE NORMAL ───────────────────────────────────────────────────
  // A slope `(dz/dx, dz/dy)` becomes the normal `normalize(-dz/dx, -dz/dy, 1)`
  // — the standard height-field relation, negated because the normal leans
  // AWAY from the direction the surface rises.
  //
  // ⚠️ EVERY `.z` SWIZZLE BELOW USED TO BE THIS VECTOR, HARDCODED TO (0,0,1).
  // `viewDir.z` IS `dot(N, viewDir)` when `N = (0,0,1)`, and likewise for the
  // half-vector and the light — which is why the flat version read as correct
  // code and measured as an invisible rung. They are `dot()` calls now, so the
  // normal is a real input rather than an assumption baked into a swizzle.
  const normalNode = slopeXY ? normalize(vec3(slopeXY.x.negate(), slopeXY.y.negate(), float(1))) : vec3(0, 0, 1);
  const nDotV = clamp(dot(normalNode, viewDir), 0, 1);

  // ROUGHNESS, from ONE global glossiness dial rather than a decoded material
  // channel — water has no per-texel material mask at this rung, only depth
  // and presence. Floored the same way specular floors its own.
  const roughness = clamp(float(1).sub(uGlossiness), float(WATER_MIN_ROUGHNESS), float(1));
  const alpha = roughness.mul(roughness);
  const alphaSq = max(alpha.mul(alpha), float(1e-8));

  const f0 = vec3(WATER_F0, WATER_F0, WATER_F0);

  /** Schlick, per channel. @param {*} cosTheta @returns {*} */
  function schlick(cosTheta) {
    const c = clamp(float(1).sub(cosTheta), 0, 1);
    const c2 = c.mul(c);
    const c5 = c2.mul(c2).mul(c);
    return f0.add(vec3(1, 1, 1).sub(f0).mul(c5));
  }

  /** GGX / Trowbridge-Reitz, `α²` numerator form. @param {*} nDotH @returns {*} */
  function ggx(nDotH) {
    const c = clamp(nDotH, 0, 1);
    const d = c
      .mul(c)
      .mul(alphaSq.sub(float(1)))
      .add(float(1));
    return alphaSq.div(max(d.mul(d).mul(float(Math.PI)), float(1e-8)));
  }

  /** Height-correlated Smith visibility. @param {*} nDotL @returns {*} */
  function visibility(nDotL) {
    const l = max(clamp(nDotL, 0, 1), float(1e-4));
    const v = max(nDotV, float(1e-4));
    const a2 = alphaSq;
    const one = float(1).sub(a2);
    const gv = l.mul(sqrt(v.mul(v).mul(one).add(a2)));
    const gl = v.mul(sqrt(l.mul(l).mul(one).add(a2)));
    return float(0.5).div(max(gv.add(gl), float(1e-6)));
  }

  /** One analytic light → its specular contribution. @param {*} lightDir
   * @param {*} radiance @returns {*} */
  function lobe(lightDir, radiance) {
    const halfVec = normalize(lightDir.add(viewDir));
    // `dot(N, ·)`, not `·.z` — see `normalNode` above. At a flat normal these
    // are the same expression, which is exactly why the bug survived review.
    const nDotL = clamp(dot(normalNode, lightDir), 0, 1);
    const vDotH = clamp(dot(viewDir, halfVec), 0, 1);
    const brdf = ggx(dot(normalNode, halfVec)).mul(visibility(nDotL)).mul(nDotL);
    return schlick(vDotH).mul(brdf).mul(radiance);
  }

  // ── THE CAST-SHADOW GATE (2026-08-16) ────────────────────────────────────
  // A JS-time branch on the field texture (Effects.md Law 4): no field, no
  // lookup in the compiled shader at all, and the rung renders exactly as it
  // did before shadows reached water.
  //
  // `uSunShadowMix` is NOT a tier gate wearing a uniform (`tsl/no-uniform-
  // gates`) — it answers a question a compiled shader genuinely cannot: "is a
  // field bound for the floor this water is on RIGHT NOW". The slots are
  // per-floor and reassigned by a residency pass at runtime, so the caller
  // re-points this material's texture node at whichever slot currently matches
  // and drops the mix to 0 on the frames when none does. Fail direction is
  // deliberate and is the opposite of the depth gate's: **no shadow data must
  // read as FULL SUN, never as full shadow** — an unresolved floor that went
  // dark would put a black river on screen, which is a far worse failure than a
  // glint that briefly outstays a shadow (`feedback_gate_polarity_must_fail_
  // open`).
  const sunShadowTexNode = sunShadowTexture ? texture(sunShadowTexture) : null;
  const uSunShadowRect = uniform(vec4(0, 0, 1, 1));
  const uSunShadowMix = uniform(float(0));
  const shadowVis = buildWorldSpaceSunVisibilityNode(TSL, {
    worldX: positionWorld.x,
    worldY: positionWorld.y,
    uShadowRect: uSunShadowRect,
    shadowTexNode: sunShadowTexNode,
  });
  // 1 = this pixel sees the sun. `mix(1, field, bound)` folds the "is a field
  // bound" question and the field itself into one expression with no branch.
  const sunVis = shadowVis ? mix(float(1), clamp(shadowVis, 0, 1), uSunShadowMix) : float(1);
  // `shadowResponse` interpolates between "shadows are ignored" (0, the
  // pre-2026-08-16 look) and "a shadow puts the glint out completely" (1).
  const sunShadowFactor = mix(float(1), sunVis, uShadowResponse);

  // ── THE SUN DISC — this is what carries the sweep as the camera pans;
  // Fresnel alone barely moves under a near-normal-incidence top-down view,
  // but the lobe is sharp, so a small change in N·H is a large change in
  // brightness (the exact finding `docs/planning/Specular.md` §4.1 records).
  //
  // ⚠️ GATED BY THE CAST SHADOW, at FULL strength — a surface cannot mirror a
  // sun it cannot see. See `WATER_TIER3_SHADOW_RESPONSE` for why the ambient
  // fill's own `sunVis` (which this term was already riding, downstream) was
  // never enough: a lobe that reaches ten times the buffer's white point is
  // still blown out after a 0.3× ambient.
  const sunSpec = lobe(uKeyDir, uKeyColor.mul(uKeyStrength)).mul(uSunGlint).mul(sunShadowFactor);

  // THE SKY DOME. The reflection vector is `R = 2(N·V)N − V`.
  //
  // ⚠️ This used to be written `R.xy = −V.xy`, with a comment explaining that
  // `reflect()` "would be the same two negations under a different name" — TRUE
  // for a flat `N`, and one more place the flat-normal assumption had quietly
  // hardened into an identity. With a real wave normal the two differ, and the
  // shortcut would leave the sky reflection pointing somewhere the surface is
  // not facing. Substituting `N = (0,0,1)` still collapses this to exactly the
  // old two negations, so the flat case is unchanged bit for bit.
  //
  // The dot below is deliberately NOT normalised: near the screen centre the
  // eye looks straight down, `R.xy → 0`, and the azimuthal preference genuinely
  // vanishes — normalising would manufacture a direction out of nothing there.
  const reflectFull = normalNode.mul(dot(normalNode, viewDir).mul(float(2))).sub(viewDir);
  const reflectXY = vec2(reflectFull.x, reflectFull.y);
  //
  // ⚠️ THE AUREOLE IS SHADOWED; THE DOME IS NOT. The `1 +` is the isotropic
  // dome — the sky a point sees in every direction, which a building's shadow
  // barely touches (it is why shadows are blue and not black) — and the term
  // added to it is the bright patch of sky AROUND the sun's own disc, which a
  // building DOES block along with the disc itself. So the shadow factor rides
  // the directional term only, at `SKY_SHEEN_SHADOW_SHARE` of its strength.
  // Gating the whole sheen would have made shadowed water read as a hole.
  const aureoleShadow = mix(float(1), sunShadowFactor, float(SKY_SHEEN_SHADOW_SHARE));
  const domeGradient = max(
    float(1).add(
      dot(reflectXY, vec2(uKeyDir.x, uKeyDir.y)).mul(float(SKY_DIRECTIONAL)).mul(uKeyStrength).mul(aureoleShadow)
    ),
    float(0)
  );
  const skySpec = schlick(nDotV).mul(uFillColor).mul(uFillStrength).mul(domeGradient).mul(uSkySheen);

  // ── OUTDOORS ONLY — no lamp term at this rung (the ladder's "no new
  // bandwidth"). A null gate (un-wired caller) or a null sample (no authored
  // `_Outdoors` mask) both read as fully indoors, matching how `packFloorAttr`
  // treats an unauthored floor the same way.
  const outdoorsNode =
    typeof buildOutdoorsGate === 'function' ? buildOutdoorsGate(TSL, { uOutdoorsRect, outdoorsTexNode }) : null;
  const outdoors = outdoorsNode ?? float(0);
  const reflection = mix(vec3(0, 0, 0), sunSpec.add(skySpec), outdoors);

  return {
    reflection,
    /** The camera's world rect centre — pushed per frame, never gated (this is
     * the whole reason the highlight moves as the author pans). */
    setViewCentre(cx, cy) {
      uViewCentre.value.set(cx, cy);
    },
    /**
     * The whole sky, in one call — see `specular-render.js#setSky`'s identical
     * reasoning: key direction/colour/strength and dome colour/strength are
     * ONE description of ONE afternoon, and six separate setters is how a
     * consumer ends up mixing a sunset key with a noon dome.
     * @param {{keyDir: number[], keyColor: readonly number[], keyStrength: number,
     *   fillColor: readonly number[], fillStrength: number}} sky
     */
    setSky(sky) {
      uKeyDir.value.set(sky.keyDir[0], sky.keyDir[1], sky.keyDir[2]);
      uKeyColor.value.set(sky.keyColor[0], sky.keyColor[1], sky.keyColor[2]);
      uKeyStrength.value = sky.keyStrength;
      uFillColor.value.set(sky.fillColor[0], sky.fillColor[1], sky.fillColor[2]);
      uFillStrength.value = sky.fillStrength;
    },
    setGlossiness(v) {
      uGlossiness.value = Math.min(1, Math.max(0, v));
    },
    setViewerHeight(v) {
      // Floored well above zero: a zero-height eye sits ON the water plane,
      // every view vector goes horizontal, and every N·V collapses to 0.
      uViewerHeight.value = Math.max(0.05, v);
    },
    setSunGlint(v) {
      uSunGlint.value = v;
    },
    setSkySheen(v) {
      uSkySheen.value = v;
    },
    /** WATER_PARAMS `shadowResponse`. Clamped to 0..1: above 1 the `mix` would
     * extrapolate past full darkness into a NEGATIVE glint, which subtracts
     * light from the water and reads as a black smear rather than as a shadow.
     * @param {number} v */
    setShadowResponse(v) {
      uShadowResponse.value = Math.min(1, Math.max(0, Number.isFinite(v) ? v : WATER_TIER3_SHADOW_RESPONSE));
    },
    /** The world rect the currently-bound sun-shadow slot covers. Pushed by the
     * caller whenever the slot it borrows changes — never derived here, because
     * the SLOT is what moves, and only the caller knows which one it took.
     * @param {{minX:number,minY:number,maxX:number,maxY:number}} r */
    setSunShadowRect(r) {
      uSunShadowRect.value.set(r.minX, r.minY, r.maxX, r.maxY);
    },
    /** 1 when a real field is bound for this water's own floor, 0 when none is.
     * See the gate's own comment for why 0 must mean FULL SUN: this water's
     * floor may simply have no baked slot this frame, and a river that went
     * black on a residency reshuffle is a far worse failure than a glint that
     * outstays its shadow for a frame. @param {number} v */
    setSunShadowMix(v) {
      uSunShadowMix.value = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
    },
    /** The field's texture node, so the caller can re-point `.value` at
     * whichever per-floor slot matches. `null` when the gate compiled out. */
    sunShadowTexNode,
    /** For the debug report — whether the outdoors branch is real on this
     * scene or compiled to the indoors constant. */
    outdoorsGateCompiled: !!outdoorsNode,
    /** For the debug report — `false` means no cast shadow can reach the glint
     * on this scene, which fails SILENTLY: the water keeps sparkling inside a
     * building's shadow and every other status field reads healthy. */
    sunShadowCompiled: !!shadowVis,
    /** For the debug report — whether a REAL wave normal reached this rung, or
     * it compiled the flat `(0,0,1)` fallback. `false` here means the rung is
     * back in its measured-invisible configuration, which is silent on screen
     * (it does not fail, it just returns a flat 0.0084 wash) and is exactly the
     * state that went unnoticed for three days. */
    normalCompiled: !!slopeXY,
  };
}

/**
 * ============================================================================
 * THE CPU TWIN — the instrument whose absence let this rung ship invisible
 * ============================================================================
 *
 * A line-for-line transcription of `buildWaterSpecular`'s maths above, in plain
 * JS, so the one question that actually mattered — *what number does this put
 * on the screen?* — is answerable in Node instead of only by an author
 * reloading Foundry and squinting at a river.
 *
 * ⚠️ **THIS IS A DELIBERATE, MANAGED FORK, AND THE ONLY KIND THIS CODEBASE
 * ALLOWS.** `feedback_mode_forks_silently_drop_features` says two
 * implementations of one thing WILL drift. The mitigations, both real:
 *   · it shares the module's OWN exported constants (`WATER_F0`,
 *     `WATER_MIN_ROUGHNESS`, `SKY_DIRECTIONAL`) rather than copying values, so
 *     a constant can only ever change in both places at once;
 *   · `__tests__/water-light.test.mjs` asserts the flat-normal case reproduces
 *     the exact measured pre-fix numbers, so if the TSL above is edited without
 *     this following, the pinned regression values are what catch it.
 *
 * Why a twin at all, rather than trusting the shader: `feedback_smooth_output_
 * hides_ported_bugs` — a wrong specular term does not render as an error, it
 * renders as *slightly duller water*, forever. And `feedback_measure_the_output_
 * not_the_equation`: every formula in this file was already correct when it
 * measured 1e-6. Correctness of the equation was never the question.
 *
 * @param {object} a
 * @param {number} a.px @param {number} a.py - world position of the fragment.
 * @param {number} [a.viewCentreX] @param {number} [a.viewCentreY]
 * @param {number} [a.viewSpanX] - the view's world width (sets the eye height).
 * @param {number} [a.viewerHeight] - eye height as a MULTIPLE of viewSpanX.
 * @param {number} [a.glossiness]
 * @param {number} [a.sunGlint] @param {number} [a.skySheen]
 * @param {number[]} a.keyDir - unit 3-vector toward the sun (`waterKeyLightDirection`).
 * @param {number} a.keyStrength @param {number} [a.fillStrength]
 * @param {number[]} [a.slope] - `[dz/dx, dz/dy]`. Omit for the flat-normal
 *   (pre-fix) behaviour.
 * @param {number} [a.sunVis] - the baked sun-shadow field's value here, 1 = full
 *   sun. Defaults to 1, so every measurement taken before shadows reached this
 *   rung (and every pinned regression value in `water-light.test.mjs`) means
 *   exactly what it always meant.
 * @param {number} [a.shadowResponse] - {@link WATER_TIER3_SHADOW_RESPONSE}.
 * @returns {{sun: number, sky: number, total: number, nDotV: number}} scene-
 *   colour units, the same 0..1-ish scale `buf:scene.color` carries.
 */
export function waterTier3Cpu({
  px,
  py,
  viewCentreX = 0,
  viewCentreY = 0,
  viewSpanX = 4000,
  viewerHeight = WATER_TIER3_VIEWER_HEIGHT,
  glossiness = WATER_TIER3_GLOSSINESS,
  sunGlint = WATER_TIER3_SUN_GLINT,
  skySheen = WATER_TIER3_SKY_SHEEN,
  shadowResponse = WATER_TIER3_SHADOW_RESPONSE,
  sunVis = 1,
  keyDir,
  keyStrength,
  fillStrength = 0,
  slope = null,
}) {
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const unit = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const dot3 = (a2, b) => a2[0] * b[0] + a2[1] * b[1] + a2[2] * b[2];

  // The synthesised eye, and the normal — mirroring the two blocks above.
  const eye = [viewCentreX, viewCentreY, Math.max(viewSpanX, 1) * viewerHeight];
  const V = unit([eye[0] - px, eye[1] - py, eye[2]]);
  const N = slope ? unit([-slope[0], -slope[1], 1]) : [0, 0, 1];
  const nDotV = clamp01(dot3(N, V));

  const roughness = Math.min(1, Math.max(WATER_MIN_ROUGHNESS, 1 - glossiness));
  const alpha = roughness * roughness;
  const alphaSq = Math.max(alpha * alpha, 1e-8);

  const schlick = (cosTheta) => {
    const c = clamp01(1 - cosTheta);
    return WATER_F0 + (1 - WATER_F0) * c * c * c * c * c;
  };
  const ggx = (nDotH) => {
    const c = clamp01(nDotH);
    const d = c * c * (alphaSq - 1) + 1;
    return alphaSq / Math.max(d * d * Math.PI, 1e-8);
  };
  const visibility = (nDotL) => {
    const l = Math.max(clamp01(nDotL), 1e-4);
    const v = Math.max(nDotV, 1e-4);
    const one = 1 - alphaSq;
    const gv = l * Math.sqrt(v * v * one + alphaSq);
    const gl = v * Math.sqrt(l * l * one + alphaSq);
    return 0.5 / Math.max(gv + gl, 1e-6);
  };

  // THE CAST-SHADOW GATE, transcribed from the TSL block of the same name —
  // `mix(1, sunVis, response)`, spelled out in plain arithmetic.
  const response = Math.min(1, Math.max(0, shadowResponse));
  const sunShadowFactor = 1 + (clamp01(sunVis) - 1) * response;

  const H = unit([keyDir[0] + V[0], keyDir[1] + V[1], keyDir[2] + V[2]]);
  const nDotL = clamp01(dot3(N, keyDir));
  const brdf = ggx(dot3(N, H)) * visibility(nDotL) * nDotL;
  const sun = schlick(clamp01(dot3(V, H))) * brdf * keyStrength * sunGlint * sunShadowFactor;

  // `R = 2(N·V)N − V`, then the un-normalised azimuthal preference.
  const nv2 = 2 * dot3(N, V);
  const R = [N[0] * nv2 - V[0], N[1] * nv2 - V[1], N[2] * nv2 - V[2]];
  // The aureole — and only the aureole — carries the shadow. See the TSL twin.
  const aureoleShadow = 1 + (sunShadowFactor - 1) * SKY_SHEEN_SHADOW_SHARE;
  const domeGradient = Math.max(
    1 + (R[0] * keyDir[0] + R[1] * keyDir[1]) * SKY_DIRECTIONAL * keyStrength * aureoleShadow,
    0
  );
  const sky = schlick(nDotV) * fillStrength * domeGradient * skySheen;

  return { sun, sky, total: sun + sky, nDotV };
}
