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
});

/**
 * The selectable tone-mapping curves — the HDR→display response. All are
 * built-in TSL `Fn`s in the vendored three (three.webgpu.js), so this is an
 * enum → `THREE.TSL[fnName]` lookup, never a hand-rolled curve. `'none'` skips
 * it (the present pass's own hue-preserving rolloff stays in charge). `'neutral'`
 * is the author's chosen default for the Look grade — AgX's base curve (no
 * "punchy" look pass on top, unlike Blender's AgX) reads flat/desaturated on
 * this content without an added contrast/saturation boost (Grade.md §10 fork).
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
  /** How much full overcast flattens contrast. */
  cloudFlatten: 0.28,
  /** Slight cool the grade adds under cloud (temperature units, negative). */
  cloudCool: 0.25,
  /** Slight cool at deep night. */
  nightCool: 0.15,
  /** A gentle exposure trim under heavy overcast (stops, negative = dimmer). */
  cloudExposure: -0.1,
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
  // dimmer" Environment.md §2.3 always specified for overcast).
  const weatherSat = 1 - cfg.cloudDesaturation * cloud;

  return {
    exposure: cfg.cloudExposure * cloud,
    contrast: 1 - cfg.cloudFlatten * cloud,
    saturation: todSat * weatherSat,
    temperature: -(cfg.cloudCool * cloud + cfg.nightCool * (1 - day)),
    tint: 0,
    lift: [0, 0, 0],
    gamma: [1, 1, 1],
    gain: [1, 1, 1],
  };
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
  warmCozy: { temperature: 0.35, saturation: 1.08, gain: [1.05, 1.0, 0.95] },
  coldHorror: { temperature: -0.4, saturation: 0.7, contrast: 1.1, lift: [0.0, 0.01, 0.03] },
  goldenGlow: { temperature: 0.25, saturation: 1.12, gain: [1.06, 1.02, 0.94], lift: [0.02, 0.01, 0.0] },
  overcastMood: { saturation: 0.72, contrast: 0.9, temperature: -0.15 },
});

/** @param {string} name @returns {object} the preset params, or identity. */
export function gradePreset(name) {
  return { ...IDENTITY_GRADE, ...(GRADE_PRESETS[name] || {}) };
}
