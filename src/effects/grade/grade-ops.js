/**
 * THE GRADE PRIMITIVE — one colour-grade function, and the ONLY place grade
 * maths lives. `docs/planning/Grade.md` is the design; this is its core.
 *
 * ============================================================================
 * WHY ONE FUNCTION (the 112-uniform lesson)
 * ============================================================================
 *
 * V2 had 112 distinct grade uniforms across THREE parallel families
 * (`uCc*`, `uContext*`, `uAtmosphere*`), each independently implementing
 * exposure/contrast/saturation/tint/gamma, plus the same knobs bleeding into
 * water, foam, fog and distortion. Three colourists undoing each other.
 *
 * The cure is not a better manager; it is that there is exactly ONE grade
 * function, and every "CC" in the whole system — the automatic atmosphere
 * grade, the author's look, a preset thumbnail — is this function with
 * different DATA. Never a new class, never a new uniform family. The
 * `grade/one-stack` tripwire makes any other declaration of these terms a build
 * failure, so the sprawl cannot reform.
 *
 * ============================================================================
 * THE DESATURATION A LIGHT CAN'T DO (Grade.md §2)
 * ============================================================================
 *
 * The saturation term pulls each pixel toward its OWN luminance
 * (`mix(vec3(L), c, sat)`), which is LUMINANCE-PRESERVING:
 * `luminance(result) === luminance(c)` identically. So it drains colour without
 * touching brightness — and brightness is what the lights and `darkness01` own.
 * The grade owns chroma and tone; the lights own level; they act on orthogonal
 * axes and therefore cannot fight. This is the whole reason the cloud
 * desaturation belongs here and not in the sky light (a light can only add or
 * multiply colour — it cannot pull chroma out). The property is asserted, not
 * asserted-in-prose, in `__tests__/grade-ops.test.mjs`.
 *
 * ============================================================================
 * PURE, WITH TSL PASSED IN (CONVENTIONS §4)
 * ============================================================================
 *
 * `applyGrade` and the resolvers are plain JS (Node-tested, and usable for a
 * CPU preview of a preset without a frame). `buildGradeNode` takes THREE.TSL as
 * an argument rather than importing it, so this module stays importable from
 * Node — the same discipline `world/wind-field.js` keeps. The TSL path mirrors
 * the JS path op-for-op, in the same fixed order, so a preview and the frame
 * agree by construction.
 *
 * @module effects/grade/grade-ops
 */

/** Rec.709 luminance weights. Used for the luminance-preserving saturation. */
export const LUMA = Object.freeze([0.2126, 0.7152, 0.0722]);

/** Linear mid-grey — the pivot contrast rotates around (≈0.46 sRGB). */
export const CONTRAST_PIVOT = 0.18;

/**
 * THE IDENTITY GRADE — every field at its no-op value. A partial params object
 * is filled from this, so a grade that sets only `saturation` leaves everything
 * else exactly as it was. This is also what the artistic grade defaults to, so
 * an un-authored scene is pixel-unchanged (the Foundry-parity guarantee).
 */
export const IDENTITY_GRADE = Object.freeze({
  exposure: 0, // stops; 0 = ×1
  contrast: 1, // around CONTRAST_PIVOT; 1 = unchanged
  saturation: 1, // luminance-preserving; 1 = unchanged, 0 = greyscale
  vibrance: 0, // boosts LOW-saturation pixels more than already-saturated ones; 0 = off
  temperature: 0, // warm(+) / cool(−)
  tint: 0, // magenta(+) / green(−)
  lift: Object.freeze([0, 0, 0]), // black point, per channel (split-tone shadows)
  gamma: Object.freeze([1, 1, 1]), // mids power, per channel
  gain: Object.freeze([1, 1, 1]), // white point, per channel (split-tone highlights)
  // THE STYLE OPS (2026-11-01, for the Remote's Looks — "removing everything but one
  // colour", tinted monochromes). Each is a no-op at its default value.
  spotAmount: 0, // 0..1 — how far every hue EXCEPT the kept one drains to grey
  spotHue: 0, // degrees, the kept hue (0 red, 120 green, 240 blue)
  spotWidth: 40, // degrees either side of spotHue that stay coloured
  colourise: 0, // 0..1 — blend toward a tinted monochrome (sepia, cyanotype...)
  colouriseColor: Object.freeze([0.55, 0.36, 0.17]), // the tint, linear RGB (a sepia brown)
  colouriseHold: 0.18, // linear luminance the tint holds up to before easing to white (COLOURISE_PIVOT)
  colouriseKeepLamps: 0, // 0..1 — where lamps shine, the wash steps back (lamplight stays its own colour)
  exposureInside: 0, // stops, under roofs (where _Outdoors is black) — author, 2026-11-01
  exposureOutside: 0, // stops, under the sky (where _Outdoors is white)
});

/**
 * ZONE EXPOSURE (author, 2026-11-01: "individual exposure controls for interior and
 * exterior"): the multiplier for a pixel that is `outdoors01` outdoors — interiors
 * and exteriors exposed separately, blended across the mask's soft edge. The
 * present pass samples the same _Outdoors gate the environmental grade uses; a
 * scene with no mask is treated as all exterior.
 * @param {number} outdoors01 @param {number} inside - stops @param {number} outside - stops
 */
export function zoneExposureMul(outdoors01, inside, outside) {
  const t = Math.min(1, Math.max(0, Number(outdoors01)));
  const stops = (Number(inside) || 0) * (1 - t) + (Number(outside) || 0) * t;
  return Math.pow(2, stops);
}

/** Lamp glow (the coloration buffer, sRGB-magnitude) at which "keep lamps" starts / is full. */
export const LAMP_GLOW_EDGES = Object.freeze([0.02, 0.2]);

/** The kept-hue window's soft edge, as a share of `spotWidth` (inner part fully kept). */
export const SPOT_EDGE_INNER = 0.5;
/** Linear mid-grey the colourise duotone pivots on: below it the tint darkens to black,
 * above it the tint fades toward white, so brightness is kept and highlights never clip. */
export const COLOURISE_PIVOT = 0.18;

/**
 * The hue of a linear-RGB colour, in degrees [0, 360), on the opponent axes
 * (red 0, green ~120, blue ~240) — the SAME formula `buildGradeNode` uses, so the
 * CPU mirror and the shader keep the same hue for the same pixel.
 * @param {readonly number[]} c @returns {{hue: number, chroma: number}}
 */
export function opponentHue(c) {
  const a = c[0] - 0.5 * (c[1] + c[2]);
  const b = 0.8660254 * (c[1] - c[2]);
  const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { hue, chroma: Math.hypot(a, b) };
}

/** smoothstep, scalar. */
function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

/**
 * How much of the kept hue a pixel of hue `hue` keeps (1 = fully coloured, 0 = drained).
 * @param {number} hue @param {number} keepHue @param {number} width - degrees
 */
export function spotKeep(hue, keepHue, width) {
  const d = Math.abs(((((hue - keepHue) % 360) + 540) % 360) - 180); // 0..180
  const w = Math.max(1, Number(width) || 1);
  return 1 - smooth(w * SPOT_EDGE_INNER, w, d);
}

// ===========================================================================
// THE LIGHT LOOK — a separate CC for the LIGHTING (author, 2026-11-01: "an
// improvement to the lighting system which allows that to be changed too as
// part of the Looks system. Basically a separate set of CC for lighting").
// ===========================================================================
//
// The artistic grade colours the FINISHED frame — painted art and light alike.
// These four act on the LIGHT alone, where the lighting composite multiplies it
// into the art (effects/lighting/environmental-light.js:
// `lit = OETF(albedo) × illum + coloration`), so the art keeps its own colours
// while the light that falls on it changes: every lamp burning white in a red
// world, a scene lit by sickly green light, lights dimmed to embers. Still ONE
// grade: the knobs live in the Colour Grade's schema and the maths lives here,
// next to the rest of it (the grade/one-stack rule).

/** The light look at rest: every op a no-op. */
export const IDENTITY_LIGHT_LOOK = Object.freeze({
  lightLevel: 1, // × the light's strength
  lightSaturation: 1, // 0 = every light white, 1 = as authored, 2 = richer
  lightTint: Object.freeze([1, 1, 1]), // × the light's colour, linear RGB
  lightGlow: 1, // × the point lights' coloured glow (the coloration layer)
});

/**
 * Apply the light look to one illumination value and one coloration value (the
 * CPU mirror of {@link buildLightLookNodes}).
 * @param {readonly number[]} illum - the light falling on a pixel (sRGB-magnitude multiplier)
 * @param {readonly number[]} coloration - the point lights' added glow there
 * @param {object} [params] - a partial light look; missing fields are identity
 * @returns {{illum: number[], coloration: number[]}}
 */
export function applyLightLook(illum, coloration, params) {
  const p = { ...IDENTITY_LIGHT_LOOK, ...(params || {}) };
  const level = Number.isFinite(Number(p.lightLevel)) ? Number(p.lightLevel) : 1;
  const sat = Number.isFinite(Number(p.lightSaturation)) ? Number(p.lightSaturation) : 1;
  const glow = Number.isFinite(Number(p.lightGlow)) ? Number(p.lightGlow) : 1;
  const tint = p.lightTint || IDENTITY_LIGHT_LOOK.lightTint;
  const shape = (c, k) => {
    const L = luminance(c);
    return [0, 1, 2].map((i) => (L + (c[i] - L) * sat) * tint[i] * k);
  };
  return { illum: shape(illum, level), coloration: shape(coloration, glow) };
}

/**
 * The light look as nodes. `u` = uniform nodes `{lightLevel, lightSaturation,
 * lightTint(vec3), lightGlow}`; identity values make both outputs exactly their
 * inputs (×1, mix to itself), so a scene with no light look is unchanged.
 * @param {*} TSL @param {*} illumNode - vec3 @param {*} colorationNode - vec3 @param {object} u
 * @returns {{illum: *, coloration: *}}
 */
export function buildLightLookNodes(TSL, illumNode, colorationNode, u) {
  const { vec3, mix, dot } = TSL;
  const shape = (c, k) => {
    const L = dot(c, vec3(LUMA[0], LUMA[1], LUMA[2]));
    return mix(vec3(L), c, u.lightSaturation).mul(u.lightTint).mul(k);
  };
  return { illum: shape(illumNode, u.lightLevel), coloration: shape(colorationNode, u.lightGlow) };
}

/**
 * The vignette's darkening at a screen uv (0..1 each axis): 1 in the middle,
 * falling to `1 - amount` in the corners. Spatial, so it lives in the present
 * pass (grade-present.js) — this is its CPU mirror for previews and tests.
 * @param {number} u @param {number} v @param {number} amount @returns {number}
 */
export function vignetteFactor(u, v, amount) {
  const d = Math.hypot(u - 0.5, v - 0.5) * Math.SQRT2; // 0 centre .. 1 corner
  return 1 - Math.min(1, Math.max(0, Number(amount) || 0)) * smooth(0.45, 1.05, d);
}

/**
 * The selectable tone-mapping curves — the HDR→display response. All are
 * built-in TSL `Fn`s in the vendored three (three.webgpu.js), so this is an
 * enum → `THREE.TSL[fnName]` lookup, never a hand-rolled curve. `'none'` skips
 * it (the present pass's own hue-preserving rolloff stays in charge) and is
 * the Look grade's default (2026-08-31: the author wants the most basic
 * option to be the default, so a film response is something a user picks
 * rather than something already applied). `'neutral'` is the mildest actual
 * curve on offer — AgX's base curve (no "punchy" look pass on top, unlike
 * Blender's AgX) reads flat/desaturated on this content without an added
 * contrast/saturation boost (Grade.md §10 fork).
 * @type {Readonly<Record<string,string|null>>}
 */
export const TONE_MAP_FNS = Object.freeze({
  none: null,
  agx: 'agxToneMapping',
  aces: 'acesFilmicToneMapping',
  neutral: 'neutralToneMapping',
  reinhard: 'reinhardToneMapping',
  cineon: 'cineonToneMapping',
});

/** The tone-map option keys, for an `enum` param's choices. */
export const TONE_MAP_NAMES = Object.freeze(Object.keys(TONE_MAP_FNS));

/** @param {number} x @returns {number} */
function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
/** @param {number} a @param {number} b @param {number} t @returns {number} */
function lerp(a, b, t) {
  return a + (b - a) * t;
}
/** @param {readonly number[]} c @returns {number} */
export function luminance(c) {
  return LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
}

/**
 * White-balance multiplier from temperature/tint. Warm boosts red and cuts
 * blue; magenta cuts green. Gentle coefficients — a look tool, not a
 * colorimetric transform (the "cinematic plausibility" doctrine `world/sun.js`
 * states, applied to colour). Identity at `(0, 0)`.
 * @param {number} temperature @param {number} tint @returns {[number,number,number]}
 */
export function whiteBalanceMul(temperature, tint) {
  const t = Number(temperature) || 0;
  const g = Number(tint) || 0;
  return [1 + t * 0.2, 1 - g * 0.2, 1 - t * 0.2];
}

/**
 * Apply the grade to one linear-RGB colour. The fixed op order (exposure →
 * white balance → lift/gamma/gain → contrast → saturation) is the same the TSL
 * path uses; grade ops do NOT commute, so this order is the contract.
 *
 * @param {readonly number[]} rgb - linear RGB.
 * @param {object} [params] - a partial grade; missing fields take IDENTITY_GRADE.
 * @returns {[number,number,number]}
 */
export function applyGrade(rgb, params) {
  const p = { ...IDENTITY_GRADE, ...(params || {}) };
  const lift = p.lift || IDENTITY_GRADE.lift;
  const gamma = p.gamma || IDENTITY_GRADE.gamma;
  const gain = p.gain || IDENTITY_GRADE.gain;

  const ev = Math.pow(2, Number(p.exposure) || 0);
  const wb = whiteBalanceMul(p.temperature, p.tint);
  const con = Number.isFinite(Number(p.contrast)) ? Number(p.contrast) : 1;
  const sat = Number.isFinite(Number(p.saturation)) ? Number(p.saturation) : 1;

  const c = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let x = rgb[i] * ev * wb[i]; // exposure + white balance
    // lift/gain = black/white point (slope+offset), then gamma on the mids.
    x = x * (Number(gain[i]) || 1) + (Number(lift[i]) || 0) * (1 - x);
    x = Math.pow(Math.max(0, x), 1 / (Number(gamma[i]) || 1));
    x = (x - CONTRAST_PIVOT) * con + CONTRAST_PIVOT; // contrast around pivot
    c[i] = x;
  }

  // Saturation, luminance-preserving — the desaturation that a light cannot do
  // (see the header). Grade.md §2.
  const L = luminance(c);
  let r = L + (c[0] - L) * sat;
  let g = L + (c[1] - L) * sat;
  let b = L + (c[2] - L) * sat;

  // VIBRANCE LAST — a saturation that boosts LOW-saturation pixels more than
  // already-vivid ones (protects skies and skin from going radioactive). Also
  // luminance-preserving: it mixes around the luminance, scaled by how UNsaturated
  // the pixel already is.
  const vib = Number.isFinite(Number(p.vibrance)) ? Number(p.vibrance) : 0;
  if (vib !== 0) {
    const chroma = Math.hypot(r - L, g - L, b - L);
    const sat01 = Math.min(1, chroma * 2.5); // rough current-saturation measure
    const boost = 1 + vib * (1 - sat01);
    r = L + (r - L) * boost;
    g = L + (g - L) * boost;
    b = L + (b - L) * boost;
  }

  // SPOT COLOUR — every hue but one drains to grey (luminance-preserving, like
  // saturation). The kept hue gets a little extra chroma so it reads as THE colour.
  const spot = Math.min(1, Math.max(0, Number(p.spotAmount) || 0));
  if (spot > 0) {
    const { hue } = opponentHue([r, g, b]);
    const keep = spotKeep(hue, Number(p.spotHue) || 0, p.spotWidth ?? IDENTITY_GRADE.spotWidth);
    const s = 1 - spot * (1 - keep) + 0.25 * spot * keep;
    r = L + (r - L) * s;
    g = L + (g - L) * s;
    b = L + (b - L) * s;
  }

  // COLOURISE — blend toward a tinted monochrome of the same luminance: the tint
  // at mid-grey, darkening to black below, easing toward white above (so a bright
  // pixel never clips to a saturated blob). See COLOURISE_PIVOT.
  // KEEP LAMPS — where a lamp's glow lands (`p.lampGlow`, the coloration buffer at
  // this pixel; the shader samples it), the wash steps back, so lamplight keeps
  // its own colour in a tinted world (the author's red-fog reference: one lamp
  // burning white). Absent glow = no effect.
  const glow = Array.isArray(p.lampGlow) ? Math.max(...p.lampGlow) : 0;
  const keepLamps =
    Math.min(1, Math.max(0, Number(p.colouriseKeepLamps) || 0)) * smooth(LAMP_GLOW_EDGES[0], LAMP_GLOW_EDGES[1], glow);
  const col = Math.min(1, Math.max(0, Number(p.colourise) || 0)) * (1 - keepLamps);
  if (col > 0) {
    const tc = p.colouriseColor || IDENTITY_GRADE.colouriseColor;
    // VALUE-preserving, not luminance-preserving: the tint's brightest channel takes
    // the pixel's own brightness. A luminance match would push a pure red far past 1
    // and flatten every mid-tone to the same clipped red; this keeps the ramp from
    // black through deep red to bright red that the author's red-fog reference has.
    const peak = Math.max(1e-4, tc[0], tc[1], tc[2]);
    // HOLD — where the tint stops and white takes over. Low (0.18) is a print-like
    // sepia; high (~0.8) keeps a whole foggy frame blood red and lets only real
    // light sources (HDR, above 1) burn white (author's red-fog reference, 2026-11-01).
    const hold = Math.max(0.02, Number(p.colouriseHold) || COLOURISE_PIVOT);
    const Lp = Math.max(0, L);
    const toWhite = Math.min(1, Math.max(0, 1 - hold / Math.max(Lp, 1e-4)));
    const mono = [0, 1, 2].map((i) => {
      const tinted = (tc[i] / peak) * Lp;
      return tinted + (Lp - tinted) * toWhite;
    });
    r = r + (mono[0] - r) * col;
    g = g + (mono[1] - g) * col;
    b = b + (mono[2] - b) * col;
  }
  return [r, g, b];
}

/** Blend a grade toward identity by `strength` (0 = no-op, 1 = full). Used by
 * the env-grade strength lever so it ships neutral and dials up. Scalars lerp;
 * per-channel arrays lerp toward their identity. */
export function scaleGradeToIdentity(params, strength) {
  const s = clamp01(strength);
  const p = { ...IDENTITY_GRADE, ...(params || {}) };
  const id = IDENTITY_GRADE;
  const arr = (a, b) => [lerp(a[0], b[0], s), lerp(a[1], b[1], s), lerp(a[2], b[2], s)];
  return {
    exposure: lerp(id.exposure, p.exposure, s),
    contrast: lerp(id.contrast, p.contrast, s),
    saturation: lerp(id.saturation, p.saturation, s),
    vibrance: lerp(id.vibrance, p.vibrance, s),
    temperature: lerp(id.temperature, p.temperature, s),
    tint: lerp(id.tint, p.tint, s),
    lift: arr(id.lift, p.lift || id.lift),
    gamma: arr(id.gamma, p.gamma || id.gamma),
    gain: arr(id.gain, p.gain || id.gain),
  };
}

// ===========================================================================
// THE ENVIRONMENTAL GRADE — f(env), the automatic atmosphere look.
// ===========================================================================

/**
 * The env-grade response curve. Authorable defaults; the VALUE each frame comes
 * from time+weather, so a GM sets the world's hour and cloud, never "40%
 * desaturated now". Tuned so the grade owns CHROMA and TONE and leaves HUE to
 * the sky light — no double-count of warmth.
 */
export const DEFAULT_ENV_GRADE_CONFIG = Object.freeze({
  /** Saturation at full clear day — a touch vivid. */
  daySaturation: 1.12,
  /** Saturation deep at night — muted toward moonlight. */
  nightSaturation: 0.8,
  /** How hard full overcast drains saturation (the cloud fix). */
  cloudDesaturation: 0.55,
  /** How much full overcast flattens contrast — DAYTIME ONLY (weighted by
   * `dayFactor01` below); see that weighting's own comment at its call site
   * for why. */
  cloudFlatten: 0.28,
  /** Slight cool the grade adds under cloud (temperature units, negative). */
  cloudCool: 0.25,
  /** Slight cool at deep night. */
  nightCool: 0.15,
  /** A gentle exposure trim under heavy overcast (stops, negative = dimmer).
   * Applied at every hour, day or night — `cloudNightDarken` below is the
   * ADDITIONAL night-specific term. */
  cloudExposure: -0.1,
  /** ⚠️ REAL BUG, author's report (2026-09-10): "night + full cloud makes it
   * look grey and it ends up looking actually brighter and 'foggy' instead
   * of darker." Root cause was `cloudFlatten` above, applied with no regard
   * for time of day: contrast rotates around `CONTRAST_PIVOT` (0.18 linear,
   * ≈0.46 sRGB — a moderately BRIGHT value), and REDUCING contrast pulls
   * whatever the scene actually is TOWARD that pivot — correct for an
   * overcast DAY (the sun scattered into one big diffuse source, genuinely
   * flatter but still brightly lit overall), wrong for an overcast NIGHT
   * (there is barely any light to begin with, so pulling near-black toward
   * 0.18 linear LIFTS it substantially — measured, not guessed: a linear
   * 0.01 night pixel at the daytime `contrast=0.72` (cloud=1) lands around
   * 0.058, nearly 6× brighter, which is exactly "brighter and foggy" instead
   * of the requested "even darker"). Two independent fixes, not one bigger
   * knob: `cloudFlatten` above is now WEIGHTED BY `dayFactor01` at its call
   * site (fades to a no-op at night, so contrast can never lift a night
   * scene's blacks), and THIS is the author's other explicit ask — "night +
   * cloud should mean even darker" — a genuinely darkening EXPOSURE term
   * (never a contrast pivot, so it can only ever multiply toward black, not
   * lift toward grey), active ONLY at night (weighted by `1 - dayFactor01`
   * at its call site) and stacking with `cloudExposure` above. `1.1` stops
   * is a deliberately strong default (2^-1.1 ≈ 0.47× brightness at full
   * night + full cloud, on top of the small -0.1 baseline) — "even darker"
   * was the author's own emphasis, not a subtle nudge. */
  cloudNightDarken: 1.1,
});

/**
 * Resolve the environmental grade params for a frame, from the env snapshot.
 * ONE params struct (ToD and weather combined on the CPU), pushed as uniforms;
 * the GPU applies it once. Pure.
 *
 * @param {object} env - the env snapshot (`env.sun`, `env.weather`).
 * @param {object} [config]
 * @returns {object} grade params (pre-strength; the caller scales by the lever).
 */
export function resolveEnvGrade(env, config = DEFAULT_ENV_GRADE_CONFIG) {
  const cfg = { ...DEFAULT_ENV_GRADE_CONFIG, ...(config || {}) };
  const sun = env?.sun || {};
  const day = clamp01(sun.dayFactor01 ?? 1);
  const cloud = clamp01(env?.weather?.cloudCover01 ?? 0);

  // ToD owns saturation depth (vivid day → muted night); the sky light owns hue.
  const todSat = lerp(cfg.nightSaturation, cfg.daySaturation, day);
  // Weather owns the big desaturation + the flatten (the "flatter, cooler,
  // dimmer" Environment.md §2.3 always specified for overcast). Desaturation
  // is luminance-PRESERVING (this file's own header) so it never needs the
  // day-weighting contrast does below — draining colour from an already-dark
  // night pixel leaves it exactly as dark, just monochrome, which is correct.
  const weatherSat = 1 - cfg.cloudDesaturation * cloud;
  // ⚠️ DAY-WEIGHTED — see `cloudFlatten`'s own doc for the bug this fixes.
  // Fades to a hard no-op at night (contrast stays 1, never lifting a dark
  // scene's blacks toward CONTRAST_PIVOT), unchanged at day (identical to
  // the value this always computed before this fix).
  const cloudFlattenNow = cfg.cloudFlatten * cloud * day;
  // ⚠️ NIGHT-ONLY — see `cloudNightDarken`'s own doc. Fades to a hard no-op
  // at day (this term never touches the already-approved daytime overcast
  // look), strongest at a fully clouded, fully dark night.
  const cloudNightDarkenNow = cfg.cloudNightDarken * cloud * (1 - day);

  return {
    exposure: cfg.cloudExposure * cloud - cloudNightDarkenNow,
    contrast: 1 - cloudFlattenNow,
    saturation: todSat * weatherSat,
    temperature: -(cfg.cloudCool * cloud + cfg.nightCool * (1 - day)),
    tint: 0,
    lift: [0, 0, 0],
    gamma: [1, 1, 1],
    gain: [1, 1, 1],
  };
}

// ===========================================================================
// ATMOSPHERIC HAZE — aerial perspective, expressed in the ONE grade primitive.
// ===========================================================================

/**
 * Haze tuning. Authorable defaults, same posture as `DEFAULT_ENV_GRADE_CONFIG`.
 *
 * THE MODEL (Hoffman & Preetham 2002, the standard real-time aerial
 * perspective; Koschmieder's visibility law is the same idea): light from the
 * ground reaches the eye through a column of air that both REMOVES some of it
 * (extinction, Beer–Lambert `T = exp(-β·d)`) and ADDS some scattered sun/sky
 * light of its own (airlight): `C = C₀·T + L_air·(1 − T)`. Three visible
 * consequences, all of which fall out of that one line:
 *   - contrast drops (every pixel is pulled toward the same airlight colour);
 *   - saturation drops (the airlight is nearly neutral);
 *   - the shift is COLOURED: dry, clear air scatters by Rayleigh/small-particle
 *     physics (blue airlight, and blue is also the channel extinguished most,
 *     so the ground behind it warms very slightly), while humid/cloudy air
 *     scatters by Mie (large droplets, all wavelengths alike → white-grey
 *     airlight, no channel preference).
 *
 * THE DISTANCE is the camera's height: the same "zooming out is rising"
 * model `cloud-shade.js#cloudTopsGate` uses, so the optical path length is
 * proportional to the view WIDTH (world px). Below `startWidthPx` — normal
 * play zoom — the column is too short to matter and the haze is exactly zero.
 */
export const DEFAULT_HAZE_CONFIG = Object.freeze({
  /** View width (world px) below which there is no haze at all — play zoom. */
  startWidthPx: 2500,
  /** Width of one "optical unit" (world px): `d = (width - start) / this`. */
  refWidthPx: 10000,
  /** Extinction per optical unit in perfectly clear air. Non-zero by design:
   * the author wants haze "present even at cloud cover 0". */
  betaClear: 0.09,
  /** Extra extinction per optical unit at full cloud cover (humid, Mie-heavy
   * air; haze is far thicker under cloud than under a clear sky). */
  betaCloud: 0.24,
  /** Hard ceiling on the veil (1 − T), whatever the zoom — never a flat wash. */
  maxVeil: 0.55,
  /** Per-channel extinction weights in clear (Rayleigh-ish) air; cloud cover
   * blends these toward [1,1,1] (Mie is wavelength-neutral). */
  clearChannelWeights: Object.freeze([0.82, 1, 1.22]),
  /** Airlight colour, clear air: bluish, ~unit luminance. */
  clearAirlight: Object.freeze([0.82, 0.98, 1.28]),
  /** Airlight colour, overcast: neutral. */
  cloudAirlight: Object.freeze([1, 1, 1]),
  /** Airlight LEVEL (linear, scene-referred) at midday: roughly the brightness
   * of a lit daytime ground pixel, so the veil lifts darks and lowers brights
   * toward a believable sky-ish grey rather than toward white or black. */
  airlightLevel: 0.36,
  /** Under full overcast the sky (and its airlight) is dimmer by this much. */
  cloudAirlightDim: 0.15,
  /** Night keeps this fraction of the daytime airlight LEVEL (moonlit haze is
   * dark, and a bright night haze is the "foggy grey night" bug the env grade
   * already fixed once — see `DEFAULT_ENV_GRADE_CONFIG.cloudNightDarken`). */
  nightAirlight: 0.1,
  /** Night keeps this fraction of the daytime veil, so a lamp isn't dimmed
   * by a daylight-strength column of air. */
  nightVeil: 0.25,
});

/**
 * Resolve the haze for one frame as a per-channel affine map `x → x·T + A·(1−T)`
 * written in the grade primitive's own `lift`/`gain` terms (`x·gain +
 * lift·(1 − x)` ≡ `x·(gain − lift) + lift`, so `gain − lift = T` and
 * `lift = A·(1 − T)`). NO new uniform, NO new shader term — haze is the grade
 * primitive's existing lift/gain with different DATA, which is the entire
 * point of `grade/one-stack`. Pure.
 *
 * @param {object} env - the env snapshot (`env.sun`, `env.weather`).
 * @param {number} viewWidthWorldPx - the current view's width in world px.
 *   Non-finite / <= 0 (no measurement) means NO haze (fails clear, like the
 *   cloud tops fail asleep: a missing measurement must not veil the map).
 * @param {object} [config]
 * @returns {{lift: number[], gain: number[], veil: number[]}} `veil` = `1 − T`
 *   per channel (0 = no haze), for diagnostics/tests.
 */
export function resolveHazeGrade(env, viewWidthWorldPx, config = DEFAULT_HAZE_CONFIG) {
  const cfg = { ...DEFAULT_HAZE_CONFIG, ...(config || {}) };
  const day = clamp01(env?.sun?.dayFactor01 ?? 1);
  const cloud = clamp01(env?.weather?.cloudCover01 ?? 0);
  const width = Number(viewWidthWorldPx);
  const d = Number.isFinite(width) && width > 0 ? Math.max(0, width - cfg.startWidthPx) / cfg.refWidthPx : 0;
  if (d <= 0) return { lift: [0, 0, 0], gain: [1, 1, 1], veil: [0, 0, 0] };

  const beta = cfg.betaClear + cfg.betaCloud * cloud;
  const dayVeil = lerp(cfg.nightVeil, 1, day);
  const level = cfg.airlightLevel * lerp(cfg.nightAirlight, 1, day) * (1 - cfg.cloudAirlightDim * cloud);

  const lift = [0, 0, 0];
  const gain = [1, 1, 1];
  const veil = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const w = lerp(cfg.clearChannelWeights[i], 1, cloud); // Rayleigh → Mie
    const transmittance = Math.exp(-beta * w * d); // Beer–Lambert
    const v = Math.min(cfg.maxVeil, (1 - transmittance) * dayVeil);
    const airlight = level * lerp(cfg.clearAirlight[i], cfg.cloudAirlight[i], cloud);
    veil[i] = v;
    lift[i] = airlight * v;
    gain[i] = 1 - v + lift[i];
  }
  return { lift, gain, veil };
}

/**
 * Lay a haze map (from {@link resolveHazeGrade}) over a resolved grade's own
 * lift/gain, so the haze composes with — never replaces — whatever lift/gain
 * the grade already carries. Both are per-channel affine maps
 * (`x → a·x + b`, `a = gain − lift`, `b = lift`); the haze is applied AFTER
 * the grade's own, so `a = aH·a0` and `b = aH·b0 + bH`. Returns a new grade.
 * @param {object} grade @param {{lift:number[], gain:number[]}} haze @returns {object}
 */
export function applyHazeToGrade(grade, haze) {
  const lift0 = grade?.lift || IDENTITY_GRADE.lift;
  const gain0 = grade?.gain || IDENTITY_GRADE.gain;
  const lift = [0, 0, 0];
  const gain = [1, 1, 1];
  for (let i = 0; i < 3; i++) {
    const a0 = gain0[i] - lift0[i];
    const b0 = lift0[i];
    const aH = haze.gain[i] - haze.lift[i];
    const bH = haze.lift[i];
    const a = aH * a0;
    const b = aH * b0 + bH;
    lift[i] = b;
    gain[i] = a + b;
  }
  return { ...grade, lift, gain };
}

// ===========================================================================
// THE TSL PATH — mirrors applyGrade op-for-op, in the same order.
// ===========================================================================

/**
 * Build the grade as a TSL node. Same maths, same order as `applyGrade` for the
 * primary ops (so the shader and a CPU preview agree by construction), plus the
 * optional whole-frame TAIL — tone map + 3D LUT — that only the artistic (Look)
 * scope applies (Grade.md §11, §13: a filmic curve twice is a double-transform
 * bug, so the tail is placement-gated to the final scope). TSL is passed IN.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {*} colorNode - vec3 linear-RGB input.
 * @param {object} u - uniform NODES: `{exposure, contrast, saturation, vibrance,
 *   temperature, tint, lift(vec3), gamma(vec3), gain(vec3)}`. Identity-valued
 *   uniforms make the primary a provable no-op.
 * @param {object} [tail] - the whole-frame display tail, Look scope only:
 * @param {string} [tail.toneMapping] - a `TONE_MAP_FNS` key; `'none'`/absent skips it.
 * @param {*} [tail.lutTexture] - a 3D LUT texture node, or null (skips the LUT).
 * @param {*} [tail.lutStrength] - float node 0..1; 0 makes the LUT a no-op.
 * @returns {*} vec3 graded colour (linear, ready for the canvas sRGB encode).
 */
export function buildGradeNode(TSL, colorNode, u, tail) {
  const { vec3, float, max, pow, mix, dot } = TSL;

  // exposure (stops → linear) + white balance, per channel.
  const ev = pow(float(2), u.exposure);
  const t = u.temperature;
  const g = u.tint;
  const wb = vec3(float(1).add(t.mul(0.2)), float(1).sub(g.mul(0.2)), float(1).sub(t.mul(0.2)));
  let c = colorNode.mul(ev).mul(wb);

  // lift/gain (black/white point) then gamma (mids), per channel.
  c = c.mul(u.gain).add(u.lift.mul(vec3(1).sub(c)));
  c = pow(max(c, vec3(0)), vec3(1).div(u.gamma));

  // contrast around the linear pivot.
  const pivot = float(CONTRAST_PIVOT);
  c = c.sub(pivot).mul(u.contrast).add(pivot);

  // saturation, luminance-preserving.
  let L = dot(c, vec3(LUMA[0], LUMA[1], LUMA[2]));
  c = mix(vec3(L), c, u.saturation);

  // vibrance — luminance-preserving, boosts UNsaturated pixels more (matches
  // applyGrade's JS). `u.vibrance` may be absent for the env-grade uniforms
  // (which predate vibrance); guard so those callers are byte-identical.
  if (u.vibrance) {
    L = dot(c, vec3(LUMA[0], LUMA[1], LUMA[2]));
    const chroma = c.sub(vec3(L)).length();
    const sat01 = chroma.mul(2.5).clamp(0, 1);
    const boost = float(1).add(u.vibrance.mul(float(1).sub(sat01)));
    c = mix(vec3(L), c, boost);
  }

  // SPOT COLOUR + COLOURISE — mirrors applyGrade's JS op for op. Only the artistic
  // scope builds these uniforms (grade-present.js), so the env grade's node is
  // byte-identical without them.
  if (u.spotAmount) {
    const { atan, abs, smoothstep, sin, cos } = TSL;
    L = dot(c, vec3(LUMA[0], LUMA[1], LUMA[2]));
    const oa = c.x.sub(c.y.add(c.z).mul(0.5));
    const ob = c.y.sub(c.z).mul(0.8660254);
    const hueRad = atan(ob, oa);
    const keepRad = u.spotHue.mul(Math.PI / 180);
    const diff = abs(atan(sin(hueRad.sub(keepRad)), cos(hueRad.sub(keepRad)))).mul(180 / Math.PI);
    const width = max(u.spotWidth, float(1));
    const keep = float(1).sub(smoothstep(width.mul(SPOT_EDGE_INNER), width, diff));
    const s = float(1)
      .sub(u.spotAmount.mul(float(1).sub(keep)))
      .add(u.spotAmount.mul(keep).mul(0.25));
    c = mix(vec3(L), c, s);
  }
  if (u.colourise) {
    L = dot(c, vec3(LUMA[0], LUMA[1], LUMA[2]));
    const tc = u.colouriseColor;
    const peak = max(max(tc.x, tc.y), max(tc.z, float(1e-4)));
    const hold = max(u.colouriseHold, float(0.02));
    const Lp = max(L, float(0));
    const toWhite = float(1)
      .sub(hold.div(max(Lp, float(1e-4))))
      .clamp(0, 1);
    const tinted = tc.div(peak).mul(Lp);
    const mono = mix(tinted, vec3(Lp), toWhite);
    // KEEP LAMPS — see applyGrade. `tail.lampGlow` is the coloration buffer sampled
    // at this pixel (grade-present.js); without it the wash is everywhere.
    let wash = u.colourise;
    if (tail?.lampGlow && u.colouriseKeepLamps) {
      const g = tail.lampGlow;
      const gMax = max(max(g.x, g.y), g.z);
      wash = wash.mul(
        float(1).sub(
          u.colouriseKeepLamps.mul(TSL.smoothstep(float(LAMP_GLOW_EDGES[0]), float(LAMP_GLOW_EDGES[1]), gMax))
        )
      );
    }
    c = mix(c, mono, wash);
  }

  // --- THE TAIL: tone map → 3D LUT (Look scope only) ----------------------
  if (tail) {
    const fnName = TONE_MAP_FNS[tail.toneMapping];
    if (fnName && typeof TSL[fnName] === 'function') {
      // Three's tone-map Fns take (color, exposure); the grade already spent its
      // own exposure above, so tone-map exposure is 1. Output is display-referred.
      c = TSL[fnName](c, float(1));
    }
    if (tail.lutTexture) {
      // The LUT is authored in a display (sRGB) space, so bracket it: encode to
      // sRGB, sample, decode back to the linear the canvas will re-encode
      // (Grade.md §12). Clamp into the cube's [0,1] domain first. `.mix` toward
      // the LUT by strength; 0 = untouched.
      //
      // `tail.lutTexture` is ALREADY a built texture node (grade-present.js
      // constructs it once via `TSL.texture3D(lutTexture)` so the sampler
      // compiles once, not per-frame) — sample it with `.sample(uv)`, do NOT
      // call `texture3D()` on it again. A node has no `.isTexture`, so
      // re-wrapping it throws three's "expects a valid instance of
      // THREE.Texture()" NodeError on every single build (confirmed live —
      // this was shipping broken, present-pass-fatal, every session).
      const inSrgb = TSL.sRGBTransferOETF(c.clamp(0, 1));
      const sampled = tail.lutTexture.sample(inSrgb).rgb;
      const outLinear = TSL.sRGBTransferEOTF(sampled);
      c = mix(c, outLinear, tail.lutStrength ?? float(0));
    }
  }

  return c;
}

// ===========================================================================
// PRESETS — named looks, as DATA (Grade.md §6). A preset is just params.
// ===========================================================================

/**
 * Named artistic-grade looks. Intent ported from V2's scene presets, values
 * re-tuned for this pipeline (the same "reference only, do not port the
 * numbers" rule the v2 param docs carry). `'none'` is the identity.
 * @type {Record<string, object>}
 */
export const GRADE_PRESETS = Object.freeze({
  none: {},
  cinematic: { contrast: 1.12, saturation: 1.05, lift: [0.0, 0.008, 0.02], gain: [1.04, 1.0, 0.96] },
  noir: { saturation: 0.0, contrast: 1.3 },
  spotRed: { spotAmount: 1, spotHue: 0, spotWidth: 40, contrast: 1.15 },
  sepia: { colourise: 0.85, colouriseColor: [0.55, 0.36, 0.17], contrast: 1.05 },
  warmCozy: { temperature: 0.35, saturation: 1.08, gain: [1.05, 1.0, 0.95] },
  coldHorror: { temperature: -0.4, saturation: 0.7, contrast: 1.1, lift: [0.0, 0.01, 0.03] },
  goldenGlow: { temperature: 0.25, saturation: 1.12, gain: [1.06, 1.02, 0.94], lift: [0.02, 0.01, 0.0] },
  overcastMood: { saturation: 0.72, contrast: 0.9, temperature: -0.15 },
});

/** @param {string} name @returns {object} the preset params, or identity. */
export function gradePreset(name) {
  return { ...IDENTITY_GRADE, ...(GRADE_PRESETS[name] || {}) };
}
