/**
 * SHINE'S SURFACE — the TSL materials tiers 0-2 draw (`docs/planning/Specular.md`).
 *
 * `specular-material.js` is the maths, in plain JS, asserted in Node. This is
 * its transcription, line for line. THREE is INJECTED, never imported.
 *
 * ============================================================================
 * ⚠️ THIS IS A PASS, NOT A DRAWABLE — AND IT IS THE FIRST ONE THAT IS
 * ============================================================================
 * Water's tier-0 surface is a mesh inside `geometry.world`'s own flat sort
 * list, which buys it occlusion for free (upper art paints over it) and the
 * zero-attr MRT contract for free. Shine cannot take that deal: it reads
 * `buf:scene.illum`, which does not EXIST until `light.accumulate` has run, and
 * sampling a target the pass you are inside is still writing is undefined
 * behaviour on both backends. So these meshes live in their own scene, drawn in
 * the `surface` stage, into `scene.lit`, after the lighting composite.
 *
 * Three consequences, each of which is a decision rather than an accident:
 *
 *  1. **NO `mrtNode`, deliberately.** Water's absorb mesh MUST override `attr`
 *     to `vec4(1)` because it draws while the renderer-global attr MRT is bound
 *     and `attr × 0` would erase the floor attributes under every water pixel
 *     (`feedback_blend_neutral_element_is_per_blend`). `runGeometryWorldPass`
 *     saves/sets/RESTORES that MRT, and `scene.lit` is a single-attachment
 *     target, so by the time this pass runs there is no attr attachment to
 *     protect. Setting an `mrtNode` here would be actively harmful: `MRTNode`
 *     matches its keys against the bound target's texture NAMES, and a key with
 *     no match yields an EMPTY output struct — no fragment output at all. The
 *     candle flame, the particles and bloom all draw into `scene.lit` with no
 *     `mrtNode` for exactly this reason. The trap was checked, not skipped.
 *  2. **Occlusion must be explicit**, since paint order no longer supplies it.
 *     `buf:scene.attr`'s R (floor index) and A (solidity) do that job — see
 *     `buildFloorGate` below.
 *  3. **⚠️ KNOWN GAP: tokens do not occlude the shine.** `buf:scene.attr` is
 *     written by the floor ART only — every overlay (tokens, doors, water,
 *     Case-2 vegetation) writes the safe `vec4(0)` no-op, so a token standing
 *     on a gold inlay leaves the attributes underneath it untouched and the
 *     highlight draws over the token. V2 solved this with a dedicated
 *     screen-space token mask (`uHasTokenMask` in its own shader); MSA has no
 *     equivalent buffer yet (`buf:occlusion`'s G channel is token DISCS for
 *     roof fade, far too coarse to stand in). Named here rather than
 *     discovered later; it is a rung, not a mystery.
 *
 * ============================================================================
 * ⚠️ THE HALF-VECTOR IS SYNTHESISED, AND SAYING SO IS THE POINT
 * ============================================================================
 * The camera is `OrthographicCamera`. With a flat map that makes V constant, N
 * constant, and therefore `N·H` a single number for the entire screen — there
 * is no angular variation to recover, only some to INVENT. This file invents
 * it, by treating the eye as sitting at a finite height above the view centre
 * (`uViewerHeight`), and that is honest rather than sneaky:
 *
 *   The reason a real miniature's shield glints as you lean over a table is
 *   precisely that your eye is a metre above a half-metre map, not at infinity.
 *   A VTT presents a top-down view of a space that is meant to feel physical;
 *   rendering it orthographically is the compromise, and restoring a plausible
 *   eye position INSIDE the shading gives back what the projection deleted.
 *
 * At a large `viewerHeight` this degrades continuously to the flat, static
 * behaviour V2 had — the parameter spans "V2's look" to "strongly swept" with
 * no branch anywhere.
 *
 * @module effects/specular/specular-render
 */

import {
  SPECULAR_PRESENCE_EDGE0,
  SPECULAR_PRESENCE_EDGE1,
  DIELECTRIC_F0,
  MIN_ROUGHNESS,
  METAL_DIFFUSE_SHARE,
} from './specular-material.js';
import {
  SUN_IRRADIANCE_RATIO,
  LAMP_IRRADIANCE_SCALE,
  SOURCE_ANGULAR_ALPHA,
  RELIEF_BASELINE_PX,
  RELIEF_MAX_SLOPE,
} from './specular-lobes.js';

/**
 * Fraction of the `_Specular` file's native resolution to upload.
 *
 * **Half, where water uploads at full — and the difference is a byte budget,
 * not an opinion about crispness.** `vt/mask-image.js`'s `'rgb'` mode uploads
 * `RGBAFormat`, four bytes per texel against water's one, so half resolution
 * here costs the SAME memory as full resolution there (~13 MB on the author's
 * 10,650 × 4,950 map, against ~53 MB at full). At half res a texel is ~2 world
 * px, and that module's own header already establishes that ~2 world px is
 * comfortably under one screen pixel at the reported play zoom.
 *
 * A one-number change if a thin gold trim line ever visibly softens.
 */
export const SPECULAR_MASK_IMAGE_SCALE = 0.5;

/** Defaults, mirroring `SPECULAR_PARAMS`. These are the single source of truth
 * for the values; the schema quotes them. A change lands in both or neither. */
export const SPECULAR_DEFAULT_STRENGTH = 1;
export const SPECULAR_DEFAULT_POLISH = 0;
export const SPECULAR_DEFAULT_METAL_RESPONSE = 0.85;
/**
 * THE EYE HEIGHT, as a multiple of the VISIBLE WIDTH — never world px.
 *
 * ⚠️ **An absolute height is the wrong quantity, and the failure is silent.**
 * With a fixed height in world px, the angular spread across the view is
 * `atan((visibleWidth/2) / height)` — so zooming IN shrinks it toward zero. The
 * highlight would sweep convincingly on a whole-map overview and go completely
 * static the instant anyone zoomed in on the metal, which is precisely when
 * they are looking at it. Nothing about that reads as a bug on screen; it reads
 * as "the effect is subtle at this zoom".
 *
 * Expressed as a ratio, the FIELD OF VIEW is fixed instead of the altitude —
 * what a real camera does — and the sweep is present at every zoom. 1.5 puts
 * the screen edge ~18° off-axis, which is enough to move a GGX lobe visibly
 * (the lobe is sharp, so a small change in `N·H` is a large change in
 * brightness) without the highlight swimming faster than the map underneath it.
 */
export const SPECULAR_DEFAULT_VIEWER_HEIGHT = 1.5;
export const SPECULAR_DEFAULT_SUN_GLINT = 1;
export const SPECULAR_DEFAULT_SKY_SHEEN = 1;
export const SPECULAR_DEFAULT_LAMP_GLINT = 1;
export const SPECULAR_DEFAULT_LAMP_HEIGHT = 0.55;
/**
 * TIER 2 — the indoor AMBIENT floor's strength. Defaults ON (1, mirroring
 * `SPECULAR_DEFAULT_SKY_SHEEN`'s outdoor twin): without it a room lit only by
 * ambient/global fill — no lamp placed close enough to the metal to create a
 * local `illum` gradient — measured to EXACTLY 0, regardless of the mask, the
 * material, or how bright the room actually was. See `specular-lobes.js`'s
 * `ambient` term for the fix and the measurement.
 */
export const SPECULAR_DEFAULT_AMBIENT_SHEEN = 1;
/**
 * TIER 3 — how strongly the map art's own painted luminance gradient tilts the
 * surface normal. 1.2 turns a typical cobble/plank edge into ~10-15 degrees of
 * slope, which is enough to swing a pixel into and out of the sun's lobe.
 */
export const SPECULAR_DEFAULT_RELIEF = 1.2;

/**
 * How strongly a CLEAR sky brightens toward the sun's own azimuth, as a
 * fraction. Not a param: it is a statement about how skies work, not a look
 * control — the same call `water-field.js` makes for `WATER_BANK_INFLUENCE`.
 *
 * An overcast dome is uniform and has no azimuthal structure for a reflection
 * to find, which is exactly why everything looks matte under cloud; the term is
 * therefore weighted by the key's own strength, which `sky-access.js` already
 * drives to zero with `cloudCover01`. Nothing extra needs to know about weather.
 */
export const SKY_DIRECTIONAL = 0.6;

/**
 * The baseline, in WORLD px, over which `buf:scene.illum` is differenced to
 * find which way the nearest lamp is (`docs/planning/Specular.md` §4.3).
 *
 * ⚠️ **WORLD px, converted through the view rect — NOT `dFdx`.** Two reasons,
 * and the second is the one that bites:
 *
 *  1. A screen-space derivative changes meaning with zoom, so a highlight would
 *     swing as the author scrolled the wheel. Everything spatial in this
 *     renderer is normalised through `worldPxPerScreenPx` for the same reason.
 *  2. `buf:scene.illum` has genuinely HARD edges — a point light is Foundry's
 *     own wall-clipped polygon, and a darkness Region overwrites its footprint
 *     with a discard-outside analytic shape test. A one-pixel derivative across
 *     a wall boundary reports a gradient of enormous magnitude pointing
 *     perpendicular to the WALL rather than at any light. A wide baseline
 *     averages over that; the clamp below bounds what survives.
 *
 * 24 px is ~a quarter of a default grid square: wide enough to be a smooth
 * read of a light's falloff, narrow enough to resolve two lamps in one room.
 */
export const ILLUM_GRADIENT_PX = 24;

/**
 * The gradient magnitude at which the lamp lobe reaches full strength, in
 * illumination-luminance per baseline.
 *
 * This is what makes "uniform ambient light casts no directional highlight"
 * true BY CONSTRUCTION rather than by a special case: under a flat ambient
 * fill, or inside a light's own flat bright core, the gradient really is zero
 * and the lobe really does vanish. Both are the physically correct answer, and
 * neither needed a branch (`docs/planning/Specular.md` §4.3's table).
 */
export const ILLUM_GRADIENT_GATE = 0.015;

/** Ceiling on the gradient magnitude the gate may see — the wall-edge spike
 * guard from `ILLUM_GRADIENT_PX`'s note 2. The DIRECTION is normalised and so
 * is unaffected; this bounds only how much a discontinuity can shout. */
export const ILLUM_GRADIENT_CLAMP = 0.35;

/**
 * Build the tier 0-2 materials.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.maskTexture - the `_Specular` file at authored resolution,
 *   RGBA, raw sRGB bytes (`vt/mask-image.js` with `channels: 'rgb'`). A 1×1
 *   all-zero placeholder is fine at construction: the caller keeps the meshes
 *   hidden until the real one arrives, so there is no shader gate and no
 *   fallback path (`tsl/no-uniform-gates`).
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} args.maskRect -
 *   the world rect `maskTexture` covers.
 * @param {*} args.illumTexture - `buf:scene.illum`.
 * @param {*} [args.attrTexture] - `buf:scene.attr` (MRT attachment 1 of
 *   `scene.color`). Null compiles the floor gate OUT entirely — a JS-time
 *   branch, never a uniform multiplied by zero.
 * @param {*} args.uViewRect - envLight's OWN vec4 view-rect uniform, shared
 *   rather than duplicated: two rects updated on different cadences is how the
 *   screen→world mapping drifts between two consumers of the same frame.
 * @param {*} args.uOutdoorsRect - envLight's outdoors rect uniform.
 * @param {*} args.outdoorsTexNode - envLight's outdoors texture node.
 * @param {(TSL: *, args: object) => *} args.buildOutdoorsGate - the world-space
 *   gate builder, injected so this module never re-writes "world XY → mask UV →
 *   sample" (there is exactly ONE copy of that, in environmental-light.js).
 * @returns {object} the two materials plus setters.
 */
export function buildSpecularSurfaceMaterial({
  THREE,
  maskTexture,
  maskRect,
  illumTexture,
  albedoTexture,
  attrTexture = null,
  uViewRect,
  uOutdoorsRect,
  outdoorsTexNode,
  buildOutdoorsGate,
  strength = SPECULAR_DEFAULT_STRENGTH,
  polish = SPECULAR_DEFAULT_POLISH,
  metalResponse = SPECULAR_DEFAULT_METAL_RESPONSE,
  relief = SPECULAR_DEFAULT_RELIEF,
  viewerHeight = SPECULAR_DEFAULT_VIEWER_HEIGHT,
  sunGlint = SPECULAR_DEFAULT_SUN_GLINT,
  skySheen = SPECULAR_DEFAULT_SKY_SHEEN,
  lampGlint = SPECULAR_DEFAULT_LAMP_GLINT,
  lampHeight = SPECULAR_DEFAULT_LAMP_HEIGHT,
  ambientSheen = SPECULAR_DEFAULT_AMBIENT_SHEEN,
}) {
  const TSL = THREE.TSL;
  const {
    texture,
    vec2,
    vec3,
    vec4,
    float,
    uniform,
    positionWorld,
    smoothstep,
    clamp,
    max,
    min,
    abs,
    dot,
    normalize,
    length,
    mix,
    cos,
    sin,
    sqrt,
    exp2,
    sRGBTransferEOTF,
  } = TSL;
  // NOTE: `mrt` is deliberately NOT destructured — see the header's point 1.
  // An `mrtNode` on these materials would be actively harmful, not merely
  // unnecessary, and not importing the symbol is the cheapest way to make a
  // future edit reach for the header before reaching for the API.

  const uMaskRect = uniform(vec4(maskRect.minX, maskRect.minY, maskRect.maxX, maskRect.maxY));
  const uStrength = uniform(float(strength));
  const uPolish = uniform(float(polish));
  const uMetalness = uniform(float(metalResponse));
  const uViewCentre = uniform(vec2(0, 0));
  /** THE EYE HEIGHT, AS A MULTIPLE OF THE VISIBLE WIDTH — not world px. See
   * `SPECULAR_DEFAULT_VIEWER_HEIGHT` for why an absolute height is the wrong
   * quantity here. */
  const uViewerHeight = uniform(float(viewerHeight));
  const uSunGlint = uniform(float(sunGlint));
  const uSkySheen = uniform(float(skySheen));
  const uLampGlint = uniform(float(lampGlint));
  const uLampHeight = uniform(float(lampHeight));
  /** TIER 2 correction (2026-07-26) — the indoor AMBIENT floor. See the
   * `ambientSpec` block below for the finding this fixes. */
  const uAmbientSheen = uniform(float(ambientSheen));
  /** The KEY LIGHT's unit 3-vector, from a surface toward the sun. Assembled
   * ONCE in JS from the sky handle (`specular-material.js#keyLightDirection`),
   * never from the hour: `env/one-sun`. */
  const uKeyDir = uniform(vec3(0, 0, 1));
  const uKeyColor = uniform(vec3(1, 1, 1));
  const uKeyStrength = uniform(float(0));
  const uFillColor = uniform(vec3(1, 1, 1));
  const uFillStrength = uniform(float(0));
  /** This quad's own floor, as `index / 255` — the value `buf:scene.attr`'s R
   * carries for the art that owns a pixel. */
  const uFloorIndex01 = uniform(float(0));
  /** TIER 3 — how strongly the map art's own painted relief tilts the normal. */
  const uRelief = uniform(float(relief));

  // ── WORLD → MASK UV ──────────────────────────────────────────────────────
  // `positionWorld`, not `uv()`: the mesh is cropped to the metal's own AABB
  // (Law 6) while the mask always covers the whole level-background rect, so
  // the quad's own UVs would be right only by coincidence. Deriving from world
  // position makes the two independent — the crop can tighten without the
  // sampling silently shifting. Water's own note, and the same trap.
  const maskU = positionWorld.x.sub(uMaskRect.x).div(uMaskRect.z.sub(uMaskRect.x));
  const maskV = positionWorld.y.sub(uMaskRect.y).div(uMaskRect.w.sub(uMaskRect.y));
  const maskTexNode = texture(maskTexture, vec2(clamp(maskU, 0, 1), clamp(maskV, 0, 1)));

  // ── TIER 1: THE MATERIAL DECODE ──────────────────────────────────────────
  // The transcription of `decodeSpecularMaterial`. Every constant is imported
  // from the module the Node tests assert against, so the shader and the twin
  // cannot drift on a number — only on the arrangement, which is what reading
  // them side by side is for.
  const m = maskTexNode.rgb.toVar('specMask');
  const value = max(max(m.r, m.g), m.b).toVar('specValue');
  const safeValue = max(value, float(1e-5));

  const presence = smoothstep(float(SPECULAR_PRESENCE_EDGE0), float(SPECULAR_PRESENCE_EDGE1), value).toVar(
    'specPresence'
  );
  // ⚠️ METALNESS IS A UNIFORM × VALUE, **NEVER THE MASK'S SATURATION**. Reading
  // it off saturation shipped an effect that only worked on gold: steel, iron,
  // pewter, silver and chrome are all GREY, all landed at F0 = 0.04, and a 4%
  // reflector seen from directly above returns nothing (measured: 0.016 of
  // scene brightness). The `× value` half is the other half of that correction —
  // without it dark paint out-shone polished paint five to one, because a rough
  // broad lobe catches an off-mirror sun that a polished razor lobe misses.
  // `specular-material.js`'s header has both accounts in full.
  const metalness = clamp(uMetalness.mul(value), 0, 1).toVar('specMetal');

  // `polish` shifts the whole map's roughness without repainting. Floored at
  // MIN_ROUGHNESS — see that constant's own note: at zero the GGX denominator
  // collapses to `Inf` on an fp16 target, and `Inf × 0` downstream is `NaN`.
  const roughness = clamp(float(1).sub(value).sub(uPolish), float(MIN_ROUGHNESS), float(1)).toVar('specRough');
  const alpha = roughness.mul(roughness).toVar('specAlpha');

  // THE HUE AT FULL BRIGHTNESS, LINEARISED — glTF's baseColor→F0 step. The
  // divide by `value` is what separates hue from polish, so a dark copper is
  // not punished twice (once with a dark F0, once with a high roughness).
  const hueSrgb = min(m.div(safeValue), vec3(1, 1, 1));
  const f0 = mix(vec3(DIELECTRIC_F0, DIELECTRIC_F0, DIELECTRIC_F0), sRGBTransferEOTF(hueSrgb), metalness).toVar(
    'specF0'
  );

  // ── TIER 2: THE SYNTHESISED VIEW ─────────────────────────────────────────
  // N is (0,0,1) everywhere at this rung — the map is flat and there is no
  // normal map by directive. That is not a placeholder to feel bad about: it
  // makes `N·V = V.z`, `N·H = H.z` and `N·L = L.z` EXACTLY, so the whole BRDF
  // below is a handful of swizzles rather than three dot products. Tier 6
  // (`relief`) replaces N with the albedo gradient and the same expressions
  // become real dots; nothing else about the arrangement changes.
  // ⚠️ THE EYE HEIGHT IS RELATIVE TO WHAT IS ON SCREEN, and getting this wrong
  // is silent: with an ABSOLUTE height the angular spread across the view
  // collapses as the author zooms IN, so the highlight would sweep beautifully
  // on a whole-map overview and go completely static the moment anyone zoomed
  // in on the metal — the exact opposite of when you want to see it. Scaling by
  // the visible width fixes the field of view instead of the altitude, which is
  // what a real camera does and what keeps the effect present at every zoom.
  const viewSpanX = max(uViewRect.z.sub(uViewRect.x), float(1)).toVar('specViewSpanX');
  const viewSpanY = max(uViewRect.w.sub(uViewRect.y), float(1));
  const eye = vec3(uViewCentre.x, uViewCentre.y, viewSpanX.mul(uViewerHeight));
  const viewDir = normalize(eye.sub(vec3(positionWorld.x, positionWorld.y, float(0)))).toVar('specV');
  // ── WORLD → SCREEN UV ────────────────────────────────────────────────────
  // The exact inverse of `buildOutdoorsGate`'s own screen→world mapping
  // (`world = mix(rect.xy, rect.zw, uv)`), so the two provably agree about
  // where a world point lands on screen. A fullscreen quad's `uv()` is both
  // the texture coordinate of a screen-sized target and that mapping's input,
  // which is what makes this a valid coordinate for sampling illum/attr.
  // (`viewSpanX`/`viewSpanY` are hoisted above, with the eye — the eye height
  // is derived from the same span, and computing it twice is how two things
  // that must agree stop agreeing.)
  const screenU = positionWorld.x.sub(uViewRect.x).div(viewSpanX);
  const screenV = positionWorld.y.sub(uViewRect.y).div(viewSpanY);
  const screenUv = vec2(clamp(screenU, 0, 1), clamp(screenV, 0, 1));

  // ── THE TWO SCREEN-SPACE TEXTURE NODES ───────────────────────────────────
  // ⚠️ **DECLARED HERE, ABOVE THEIR FIRST USE, AND THAT PLACEMENT IS THE FIX
  // FOR A LIVE CRASH (2026-07-26): `ReferenceError: Cannot access
  // 'albedoTexNode' before initialization`.** When tier 3 landed, the relief
  // block moved UP to sit above the lobes — but these two `const`s stayed where
  // the lamp lobe had left them, ~150 lines below, and a `const` is in its
  // temporal dead zone until its own line RUNS. `artLumaAt` closed over
  // `albedoTexNode` and was called immediately, so the viewer threw on startup
  // and the whole renderer fell back to Foundry.
  //
  // That is trap #4 of `VT-Pan-Viewer-Extraction.md` in a new costume, and the
  // lesson is the same one it records: **moving a consumer up is also moving it
  // above its producer.** No test could see it — every suite here is pure
  // arithmetic, and the TDZ only exists when the builder actually runs.
  //
  // NO baked uv on either node, deliberately: each is read at several
  // coordinates (the fragment's own, plus four gradient taps), and `.sample(uv)`
  // on a bare `texture(t)` is the pattern
  // `environmental-light.js#sampleOutdoorsAtWorldXY` already proves out. Baking
  // a uv in and then calling `.sample()` with a different one would be relying
  // on override behaviour nothing in this codebase exercises.
  //
  // The texture OBJECTS are captured once and never re-pointed, which is correct
  // rather than an oversight: `RenderTarget#setSize` mutates its textures IN
  // PLACE (verified against the vendored source — see the resize handler in
  // `vt-pan-viewer.js`), so a screen-size change keeps these references valid.
  // Bloom's composite makes the identical call for the same reason.
  const albedoTexNode = texture(albedoTexture);
  const illumTexNode = texture(illumTexture);

  // ── TIER 3: RELIEF — THE ART IS THE HEIGHT FIELD ─────────────────
  // ⚠️ **THIS RUNG IS WHY THE EFFECT IS VISIBLE AT ALL, and it was originally
  // designed as rung SIX.** With a flat +Z normal, `N·H` is one number for the
  // whole screen (this effect's §1.2 proof), so tiers 0-2 could only ever paint
  // a spatially FLAT wash — measured at 0.39 of scene brightness everywhere, with
  // no highlight anywhere. Tilting the same pixel's normal toward the mirror
  // angle takes it to 6.3. That sixteen-fold swing IS a highlight; on a flat map
  // there is no other source of one.
  //
  // It sat at rung 6 because it was costed as a C4 VT read of the albedo pack.
  // That was simply wrong: `buf:scene.color` is the un-lit composite the geometry
  // pass already produced, so this is a C3 graph read — the same class as tier 2,
  // and therefore always eligible to sit here under Law 3.
  //
  // The artist has already painted every cobble, plank, rivet and fold,
  // INCLUDING its lighting, so the luminance gradient of the map art is an
  // excellent slope proxy — and a better one than a generated normal map, since
  // it is the relief the artist intended. This is what lets the effect keep the
  // author's "no normal map" directive without losing structure.
  const reliefEpsU = float(RELIEF_BASELINE_PX).div(viewSpanX);
  const reliefEpsV = float(RELIEF_BASELINE_PX).div(viewSpanY);
  /** Rec.709 luminance of the UN-LIT map art at a screen-UV offset. Un-lit on
   * purpose: the lit buffer would fold this pass's own illumination back into
   * its own slope estimate. @param {*} du @param {*} dv @returns {*} */
  const artLumaAt = (du, dv) =>
    dot(
      albedoTexNode.sample(vec2(clamp(screenU.add(du), 0, 1), clamp(screenV.add(dv), 0, 1))).rgb,
      vec3(0.2126, 0.7152, 0.0722)
    );
  // A fixed WORLD baseline, so zooming out shrinks it below a screen pixel, all
  // four taps land in one texel, the gradient goes to zero and the relief fades
  // cleanly back to the flat tier-2 look. Detail you cannot see should not be
  // shaded, let alone aliased — and this costs nothing, because it is what the
  // sampling does anyway.
  const artGrad = vec2(
    artLumaAt(reliefEpsU, float(0)).sub(artLumaAt(reliefEpsU.negate(), float(0))),
    artLumaAt(float(0), reliefEpsV).sub(artLumaAt(float(0), reliefEpsV.negate()))
  );
  const slopeRaw = artGrad.negate().mul(uRelief);
  // Clamped: a hard art boundary (a tile outline, a wall edge) has an enormous
  // gradient and would tip the normal past the horizon, where `N·L` flips sign.
  const slopeLen = length(slopeRaw);
  const slope = slopeRaw.mul(min(float(RELIEF_MAX_SLOPE), slopeLen).div(max(slopeLen, float(1e-5))));
  const normal = normalize(vec3(slope.x, slope.y, float(1))).toVar('specN');

  const nDotV = clamp(dot(normal, viewDir), 0, 1).toVar('specNdotV');

  /** Schlick, per channel. @param {*} f @param {*} cosTheta @returns {*} */
  function schlick(f, cosTheta) {
    const c = clamp(float(1).sub(cosTheta), 0, 1);
    const c2 = c.mul(c);
    const c5 = c2.mul(c2).mul(c);
    return f.add(vec3(1, 1, 1).sub(f).mul(c5));
  }

  // α², materialised ONCE: it is read by both `ggx` and `visibility`, and each
  // of those is called twice (sun lobe + lamp lobe), so leaving it as a
  // re-referenced expression would compile FOUR multiplies where one will do.
  // Effects.md authoring rule 2. The `max` also carries the fp16 guard —
  // `MIN_ROUGHNESS` already keeps α off zero, and this is the belt to that
  // brace, so a NaN cannot reach an additive blend from either direction.
  // ⚠️ THE SOURCE'S ANGULAR SIZE, not the material's roughness. A delta light on
  // a polished surface produces a razor-thin contour — measured at 0.1 across the
  // whole map and 191 on a one-pixel locus: blown out, aliased, and invisible in
  // every other pixel. Real metal escapes that by being CURVED so the locus
  // sweeps across it; a flat map has no curvature to sweep with. Widening alpha
  // is the standard area-light treatment and needs NO energy normalisation,
  // since GGX's own D is already normalised — it REDISTRIBUTES (peak /150, tail
  // x120) rather than adding. Only PUNCTUAL lobes get this; the dome is already
  // as wide as a source can be. See `specular-lobes.js#SOURCE_ANGULAR_ALPHA`.
  const lobeAlpha = min(alpha.add(float(SOURCE_ANGULAR_ALPHA)), float(1)).toVar('specLobeAlpha');
  const alphaSq = max(lobeAlpha.mul(lobeAlpha), float(1e-8)).toVar('specAlphaSq');

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
    // Real dots now, not swizzles: tier 3 gave the normal something to say.
    const nDotL = clamp(dot(normal, lightDir), 0, 1);
    const vDotH = clamp(dot(viewDir, halfVec), 0, 1);
    const brdf = ggx(dot(normal, halfVec)).mul(visibility(nDotL)).mul(nDotL);
    return schlick(f0, vDotH).mul(brdf).mul(radiance);
  }

  // ── OUTDOORS: the sun disc + the sky dome ────────────────────────────────
  // x SUN_IRRADIANCE_RATIO — the sky handle reports key/fill as COMPOSITION
  // weights, not radiometry, and a BRDF asks for irradiance. See that constant
  // for the derivation, including why the right number is not the one the
  // physical ratio looks like.
  const sunSpec = lobe(uKeyDir, uKeyColor.mul(uKeyStrength).mul(float(SUN_IRRADIANCE_RATIO))).mul(uSunGlint);

  // THE DOME. A uniform hemisphere has no structure for roughness to blur —
  // which is precisely why everything looks matte under overcast — so the
  // split-sum approximation collapses to Fresnel times the dome's radiance.
  // On a CLEAR sky the dome is not uniform: it brightens toward the sun, so
  // the reflection picks up an azimuthal gradient. `R.xy = −V.xy` exactly, for
  // a flat N, which is why `reflect()` is not called here — it would be the
  // same two negations wearing a function name.
  //
  // The dot is deliberately NOT normalised. Near the screen centre the eye
  // looks straight down, `R.xy → 0`, and the azimuthal preference genuinely
  // vanishes — normalising would manufacture a direction out of nothing there
  // and divide by zero doing it.
  const reflectXY = vec2(viewDir.x.negate(), viewDir.y.negate());
  const domeGradient = max(
    float(1).add(dot(reflectXY, vec2(uKeyDir.x, uKeyDir.y)).mul(float(SKY_DIRECTIONAL)).mul(uKeyStrength)),
    float(0)
  );
  // THE SPLIT-SUM ENVIRONMENT BRDF (Karis, the analytic "Mobile" fit) rather
  // than a bare `schlick(f0, N·V)`. A rough surface does not reflect a uniform
  // environment by its normal-incidence Fresnel: its microfacets present a
  // spread of angles, and the correct integral accounts both for the grazing
  // gain and for the single-scatter energy a rough lobe LOSES. Measured, it
  // comes out slightly DIMMER than bare Schlick on a rough dielectric — a
  // useful negative result, since it ruled out "the dome integral is wrong" as
  // the explanation for the invisible pass and left the flat normal with
  // nowhere to hide.
  const envR = clamp(roughness, 0, 1);
  const envRx = float(1).sub(envR);
  const envRy = envR.mul(float(-0.0275)).add(float(0.0425));
  const envRz = envR.mul(float(-0.572)).add(float(1.04));
  const envRw = envR.mul(float(0.022)).sub(float(0.04));
  const envA004 = min(envRx.mul(envRx), exp2(nDotV.mul(float(-9.28))))
    .mul(envRx)
    .add(envRy);
  const envScale = envA004.mul(float(-1.04)).add(envRz);
  const envBias = envA004.mul(float(1.04)).add(envRw);
  const domeReflectance = f0.mul(envScale).add(envBias);
  const skySpec = domeReflectance.mul(uFillColor).mul(uFillStrength).mul(domeGradient).mul(uSkySheen);

  // Both texture nodes are declared with the screen UV, far above — see the
  // TDZ crash note there for why they may not drift back down here.
  const illumHere = illumTexNode.sample(screenUv).rgb.toVar('specIllum');

  // ── INDOORS: ∇illum POINTS AT THE LAMP ───────────────────────────────────
  // For a source at p, illumination is `I·f(r)` with f decreasing, so
  // `∇illum = I·f'(r)·(x−p)/r` and `f' < 0` — the gradient points FROM the
  // fragment TOWARD the source. One buffer already in the graph yields a
  // per-pixel light direction for whichever source dominates here, with no
  // light list, no loop, and no second light system. Indoors there is no sky
  // to reflect (the ceiling is not rendered), so the lamps are the entire
  // environment; see `docs/planning/Specular.md` §4.
  const gradEpsU = float(ILLUM_GRADIENT_PX).div(viewSpanX);
  const gradEpsV = float(ILLUM_GRADIENT_PX).div(viewSpanY);
  /** Rec.709 luminance of illum at a screen-UV offset. @param {*} du @param {*} dv @returns {*} */
  const illumLumaAt = (du, dv) =>
    dot(
      illumTexNode.sample(vec2(clamp(screenU.add(du), 0, 1), clamp(screenV.add(dv), 0, 1))).rgb,
      vec3(0.2126, 0.7152, 0.0722)
    );
  const gradient = vec2(
    illumLumaAt(gradEpsU, float(0)).sub(illumLumaAt(gradEpsU.negate(), float(0))),
    illumLumaAt(float(0), gradEpsV).sub(illumLumaAt(float(0), gradEpsV.negate()))
  ).toVar('specIllumGrad');
  const gradientLen = length(gradient).toVar('specGradLen');

  // The lamp's elevation above the floor, as an angle: 0 = grazing streaks
  // across a flagstone hall, 1 = tight pools under each sconce. The Z floor is
  // load bearing — at `lampHeight = 0` AND a zero gradient the vector would be
  // (0,0,0) and `normalize` would return NaN, which on an additive pass paints
  // a permanent black hole rather than nothing.
  const lampTheta = uLampHeight.mul(float(Math.PI / 2));
  const lampZ = max(sin(lampTheta), float(0.08));
  // `.toVar()` because it is referenced twice below, and TSL is a GRAPH: a
  // re-reference re-evaluates unless it is materialised. Effects.md authoring
  // rule 2 calls this out as the single easiest accidental 2× cost.
  const lampXY = cos(lampTheta).toVar('specLampXY');
  const gradientDir = gradient.div(max(gradientLen, float(1e-5)));
  const lampDir = normalize(vec3(gradientDir.x.mul(lampXY), gradientDir.y.mul(lampXY), lampZ));
  // Clamped BEFORE the gate so a wall-clip discontinuity cannot shout; the
  // direction is normalised above and is unaffected either way.
  const lampGate = smoothstep(float(0), float(ILLUM_GRADIENT_GATE), min(gradientLen, float(ILLUM_GRADIENT_CLAMP)));
  // × LAMP_IRRADIANCE_SCALE — `illum` is a 0..1 LEVEL, not irradiance, exactly
  // as `key.strength` is. Without it indoor metal measured 7× dimmer than
  // outdoor metal, which was two units meeting in one equation, not physics.
  const lampSpec = lobe(lampDir, illumHere.mul(float(LAMP_IRRADIANCE_SCALE)))
    .mul(uLampGlint)
    .mul(lampGate);

  // ⚠️ THE TERM THAT WAS MISSING, AND THE REASON A GOLD ASTROLABE SHOWED
  // NOTHING (found live, 2026-07-26). Everything above this point is the
  // DIRECTIONAL lamp lobe, gated on the MAGNITUDE of illum's gradient — and a
  // room lit by nothing but ambient/global fill, with no lamp close enough to
  // the metal to create a local gradient, has `gradientLen ≈ 0` EVERYWHERE.
  // So the entire indoor branch measured to EXACTLY 0, regardless of the
  // mask, the material, or how bright the room actually was — `illum` can be
  // 0.6 and the composite was still 0 (measured in `specular-lobes.test.mjs`).
  //
  // `domeReflectance` above already answers "how much does a rough/smooth F0
  // surface reflect of a uniformly-lit environment this bright", for the sky.
  // A room's ambient fill IS such an environment, and `illumHere` (already
  // fetched, already unit-converted by `LAMP_IRRADIANCE_SCALE`) is exactly the
  // "how bright is it here" scalar that same integral wants — so this reuses
  // `domeReflectance` VERBATIM rather than re-deriving it: `N·V` and
  // `roughness` are the same geometric/material quantities regardless of
  // outdoors/indoors, so a second evaluation would be pure duplicated cost
  // (Effects.md authoring rule 6, hoist shared terms).
  //
  // UNGATED by `lampGate`, deliberately: a shiny surface in a lit room shows a
  // flat sheen even with nothing nearby to catch a sharp highlight FROM,
  // exactly as real metal does under diffuse light. The directional lamp lobe
  // above is additive ON TOP when a gradient exists, never a replacement.
  const ambientSpec = domeReflectance.mul(illumHere).mul(float(LAMP_IRRADIANCE_SCALE)).mul(uAmbientSheen);
  const indoorSpec = ambientSpec.add(lampSpec);

  // ── THE SPLIT ────────────────────────────────────────────────────────────
  // Mixed, never switched: a covered porch has to cross smoothly. The gate is
  // the SAME world-space outdoors read `buf:scene.attr`'s G channel uses —
  // injected, so "world XY → mask UV → sample" still exists exactly once.
  // A null node means no outdoors mask at all, which reads as INDOORS, exactly
  // as `packFloorAttr` chooses for the same input: a floor with no authored
  // mask is legitimately all-indoors, and the loud failure for a genuinely
  // missing REQUIRED mask belongs to the authority, not to a shader default.
  const outdoorsNode = buildOutdoorsGate(TSL, { uOutdoorsRect, outdoorsTexNode });
  const outdoors = outdoorsNode ?? float(0);
  const lobes = mix(indoorSpec, sunSpec.add(skySpec), outdoors);

  // ── THE FLOOR GATE — correctness, and it never rides the ladder ──────────
  // A JS-time branch: with no attr texture the whole lookup is compiled OUT
  // rather than multiplied by a one (`tsl/no-uniform-gates`).
  //
  // `attr.r` is the floor index of whatever art is TOPMOST at this pixel, so
  // `attr.r == myFloor` is exactly "is my metal actually visible here" — a roof
  // drawn over it has already overwritten R with the roof's own floor. Adjacent
  // floors are 1/255 apart, so the band is a fraction of that.
  //
  // `attr.a` (solidity) is the second half and it is not optional: the buffer's
  // clear value is the renderer's ordinary (0,0,0,0), so "floor 0" and "nothing
  // drawn here at all" are indistinguishable in R alone. `vt/scene-attr.js`'s
  // own KNOWN GAP note names this and prescribes exactly this test.
  let visibility01 = float(1);
  if (attrTexture) {
    const attrHere = texture(attrTexture, screenUv);
    const floorMatch = float(1).sub(smoothstep(float(0.4 / 255), float(0.9 / 255), abs(attrHere.r.sub(uFloorIndex01))));
    const anythingDrawn = smoothstep(float(0), float(0.15), attrHere.a);
    visibility01 = floorMatch.mul(anythingDrawn);
  }

  const coverage = presence.mul(visibility01).toVar('specCoverage');

  // ── SHARED MATERIAL STATE ────────────────────────────────────────────────
  // Split out so the two materials cannot drift on the settings that make them
  // agree about WHERE they are — which is every setting except the blend. Half
  // a shine pass (suppression with no highlight) would look like a shader bug.
  /** @param {*} material */
  function configureShared(material) {
    material.transparent = true;
    // The painter's-algorithm contract every drawable in this renderer shares
    // (`scene/layer-order.js`): ascending renderOrder IS the layering, so depth
    // testing would only fight it, and this pass must never occlude by depth.
    material.depthTest = false;
    material.depthWrite = false;
    // ⚠️ EVERY world-space quad in this renderer sets this. A negative scale
    // (Foundry's horizontal-flip convention) mirrors the corners and reverses
    // the effective winding, and FrontSide would cull the quad as a backface —
    // visible in every JS-side status field and invisible on screen, because
    // face culling is a GPU-side fact bookkeeping cannot see
    // (`feedback_doubleside_invisible_to_status_reports`).
    material.side = THREE.DoubleSide;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendEquationAlpha = THREE.AddEquation;
    // DESTINATION ALPHA IS LEFT ALONE BY BOTH PASSES. `scene.lit`'s alpha is
    // the level-composite coverage the floor stack is assembled with, and
    // neither "this metal reflects" nor "this metal has no diffuse" is a
    // statement about coverage. `Zero·src + One·dst` is the identity on it.
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
  }

  // ── MESH 1: THE DIFFUSE KNOCK-DOWN (multiply) ────────────────────────────
  // A conductor has almost no diffuse albedo: real gold is a gold REFLECTION
  // and essentially nothing else, not a yellow surface plus a highlight. V2
  // could only ever ADD, because it was an overlay mesh with no way to modify
  // the tile beneath it; this pass declares `modifies: buf:scene.color` and can
  // do the physical thing (`docs/planning/Specular.md` §2.4).
  //
  // ⚠️ GATED ON `metalness`, and that is what keeps the compatibility claim
  // TRUE rather than approximate: a desaturated V2-era mask decodes to exactly
  // zero metalness (asserted in Node), suppresses exactly nothing, and behaves
  // as the pure additive dielectric V2 drew. `metalResponse: 0` reproduces that
  // for a coloured mask too — the documented "give me the old look back" knob.
  //
  // Scaled by `saturate(strength)` so taking the master to 0 removes the whole
  // effect rather than leaving a dark patch where the highlight used to be.
  const suppression = metalness
    .mul(coverage)
    .mul(float(METAL_DIFFUSE_SHARE))
    .mul(clamp(uStrength, 0, 1))
    .toVar('specSuppress');
  const suppressMaterial = new THREE.NodeMaterial();
  suppressMaterial.colorNode = vec4(vec3(1, 1, 1).sub(vec3(suppression, suppression, suppression)), 1);
  configureShared(suppressMaterial);
  suppressMaterial.blendSrc = THREE.ZeroFactor;
  suppressMaterial.blendDst = THREE.SrcColorFactor;

  // ── MESH 2: THE HIGHLIGHTS (add) ─────────────────────────────────────────
  const specularMaterial = new THREE.NodeMaterial();
  specularMaterial.colorNode = vec4(lobes.mul(coverage).mul(uStrength), 1);
  configureShared(specularMaterial);
  specularMaterial.blendSrc = THREE.OneFactor;
  specularMaterial.blendDst = THREE.OneFactor;

  return {
    suppressMaterial,
    specularMaterial,
    maskTexNode,
    setMaskRect(r) {
      uMaskRect.value.set(r.minX, r.minY, r.maxX, r.maxY);
    },
    /** The camera's world rect centre — the eye's XY. Pushed per frame. */
    setViewCentre(cx, cy) {
      uViewCentre.value.set(cx, cy);
    },
    /** This quad's floor, for the `buf:scene.attr` visibility gate. */
    setFloorIndex(index) {
      uFloorIndex01.value = (Number.isFinite(index) ? Math.max(0, Math.min(255, index)) : 0) / 255;
    },
    /**
     * The whole sky, in one call — key direction/colour/strength and dome
     * colour/strength together, because they are ONE description of ONE
     * afternoon. Splitting them into six setters is how a consumer ends up
     * with a sunset-coloured key over a noon dome.
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
    setStrength(v) {
      uStrength.value = v;
    },
    setPolish(v) {
      uPolish.value = v;
    },
    setMetalResponse(v) {
      uMetalness.value = v;
    },
    setRelief(v) {
      uRelief.value = Math.max(0, v);
    },
    setViewerHeight(v) {
      // Floored well above zero: a zero-height eye sits ON the map plane, every
      // view vector goes horizontal, and every `N·V` collapses to 0.
      uViewerHeight.value = Math.max(0.05, v);
    },
    setSunGlint(v) {
      uSunGlint.value = v;
    },
    setSkySheen(v) {
      uSkySheen.value = v;
    },
    setLampGlint(v) {
      uLampGlint.value = v;
    },
    setLampHeight(v) {
      uLampHeight.value = Math.min(1, Math.max(0, v));
    },
    setAmbientSheen(v) {
      uAmbientSheen.value = v;
    },
    /** For the debug report — whether the outdoors branch is real on this
     * scene or compiled to the indoors constant. */
    outdoorsGateCompiled: !!outdoorsNode,
    floorGateCompiled: !!attrTexture,
  };
}
