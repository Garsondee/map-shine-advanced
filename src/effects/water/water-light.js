/**
 * WATER TIER 3 — SUN + SKY SPECULAR (`docs/planning/Water.md` §6, rung 3).
 *
 * The ladder's own words for this rung: "GGX specular + Fresnel-weighted sky
 * reflection from the sky handle. No new bandwidth." That last clause is load
 * bearing and shapes everything below: no lamp glint, no `buf:scene.illum`
 * read, no `buf:scene.attr` occlusion. Tiers 0-2 already draw as two meshes
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

/** Water's own Fresnel-at-normal-incidence, from its IOR (~1.33) — see the
 * header for why this is NOT specular's 0.04 general-dielectric average. */
export const WATER_F0 = 0.02;

/** Same fp16 GGX-denominator guard as `specular-material.js#MIN_ROUGHNESS`,
 * same value, same reason — see the header. */
export const WATER_MIN_ROUGHNESS = 0.089;

export const WATER_TIER3_SUN_GLINT = 1;
export const WATER_TIER3_SKY_SHEEN = 1;

/** 0 = a rough, scattered highlight; 1 = a tight mirror disc. Calm water
 * defaults near-mirror; a choppy sea is an author choice, not a forced one — a
 * later rung (tier 7, `sim`) is what makes the surface itself choppy, and this
 * dial stays independent of it. */
export const WATER_TIER3_GLOSSINESS = 0.92;

/** THE EYE HEIGHT, as a multiple of the VISIBLE WIDTH — never world px. Same
 * quantity, same reasoning, and the same default as
 * `specular-render.js#SPECULAR_DEFAULT_VIEWER_HEIGHT`: an absolute height
 * makes the angular spread — and therefore the sweep — vanish as the author
 * zooms in, at exactly the moment they are looking closest at the highlight.
 * Owned independently rather than shared with shine's own setting: this is a
 * LOOK parameter each effect's author tunes separately, not a graph resource
 * two consumers must agree on (unlike `uViewRect`, which IS shared, below). */
export const WATER_TIER3_VIEWER_HEIGHT = 1.5;

/** How strongly a CLEAR sky brightens toward the sun's own azimuth, as a
 * fraction. Not a param — see `specular-render.js#SKY_DIRECTIONAL`'s identical
 * reasoning: an overcast dome has no azimuthal structure for a reflection to
 * find, and `sky-access.js` already drives the key's strength to zero under
 * cloud, so nothing extra needs to know about weather. */
const SKY_DIRECTIONAL = 0.6;

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
 * @returns {{reflection:*, setViewCentre:(x:number,y:number)=>void,
 *   setSky:(sky:object)=>void, setGlossiness:(v:number)=>void,
 *   setViewerHeight:(v:number)=>void, setSunGlint:(v:number)=>void,
 *   setSkySheen:(v:number)=>void, outdoorsGateCompiled:boolean}}
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
}) {
  const { vec2, vec3, float, uniform, clamp, max, dot, normalize, sqrt, mix } = TSL;

  const uViewCentre = uniform(vec2(0, 0));
  const uViewerHeight = uniform(float(viewerHeight));
  const uGlossiness = uniform(float(glossiness));
  const uSunGlint = uniform(float(sunGlint));
  const uSkySheen = uniform(float(skySheen));
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
  const nDotV = clamp(viewDir.z, 0, 1);

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
    const nDotL = clamp(lightDir.z, 0, 1);
    const vDotH = clamp(dot(viewDir, halfVec), 0, 1);
    const brdf = ggx(halfVec.z).mul(visibility(nDotL)).mul(nDotL);
    return schlick(vDotH).mul(brdf).mul(radiance);
  }

  // ── THE SUN DISC — this is what carries the sweep as the camera pans;
  // Fresnel alone barely moves under a near-normal-incidence top-down view,
  // but the lobe is sharp, so a small change in N·H is a large change in
  // brightness (the exact finding `docs/planning/Specular.md` §4.1 records).
  const sunSpec = lobe(uKeyDir, uKeyColor.mul(uKeyStrength)).mul(uSunGlint);

  // THE SKY DOME. `R.xy = −V.xy` exactly for a flat N, so `reflect()` is not
  // called — it would be the same two negations under a different name. The
  // dot is deliberately NOT normalised: near the screen centre the eye looks
  // straight down, `R.xy → 0`, and the azimuthal preference genuinely
  // vanishes — normalising would manufacture a direction out of nothing there.
  const reflectXY = vec2(viewDir.x.negate(), viewDir.y.negate());
  const domeGradient = max(
    float(1).add(dot(reflectXY, vec2(uKeyDir.x, uKeyDir.y)).mul(float(SKY_DIRECTIONAL)).mul(uKeyStrength)),
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
    /** For the debug report — whether the outdoors branch is real on this
     * scene or compiled to the indoors constant. */
    outdoorsGateCompiled: !!outdoorsNode,
  };
}
