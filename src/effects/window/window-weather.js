/**
 * WINDOW WEATHER — the outside world played DRAMATICALLY through window light.
 *
 * The author, 2026-10-27, looking at the Mansion greenhouse still glowing under
 * 90% cloud and rain: *"It should better reflect the state of the outside world.
 * I still want light indoors during rainstorms and high cloud, I just want it to
 * be dramatic smaller amounts of window light at full strength and not just
 * reduce it to zero or lower the contrast to the point of making it look less
 * exciting. We're going for dramatic, never dull."* — and: *"add a darkening
 * effect to the _Windows light which darkens where the current rain shader
 * brightens ... moving waves of darkness"*.
 *
 * ⚠️ WHY THE OLD OVERCAST RESPONSE COULD NOT DO THIS. It dimmed the light
 * BEFORE the highlight shoulder (`window-render.js`), and a white `_Window` mask
 * drives the raw light far past the shoulder's ceiling — so a 90% cut moved the
 * visible result by perhaps a third. Its other half flattened the cookie's
 * contrast and softened its edge, which is exactly the "less exciting" the
 * author rejects. This gain is applied AFTER the shoulder (a grade on the
 * finished light, like the daylight tint), so a 0.1 here is a real 0.1.
 *
 * TWO TERMS, MULTIPLIED:
 *
 *   SUN BREAKS (cloud). Under heavy cloud the light does not fade evenly — it
 *   comes through the BREAKS. A drifting break field (riding the cloud deck's
 *   own drift offset, so breaks move with the clouds) is thresholded by cover:
 *   a clear sky passes everything, 70% cover leaves about half the window lit,
 *   90% leaves small patches — each at FULL strength — over a dim fill. That is
 *   the "dramatic smaller amounts at full strength".
 *
 *   STORM WAVES (rain). The rain's own bright waves are the wind field's gust
 *   envelope (`world/wind-field.js#computeGustEnvelope` — the torrent layer
 *   surges on `smoothstep(0.75, 1.6, gust)` and the curtain's squall bands are
 *   the same fronts). This reads the identical envelope at the window's world
 *   position with the identical shaping, so a wave of lashing rain crossing the
 *   courtyard is a wave of darkness crossing the room, in step, at the wind's
 *   real speed.
 *
 * Pure TSL builder; TSL is passed in. No THREE import, no Foundry.
 *
 * @module effects/window/window-weather
 */

import { computeGustEnvelope } from '../../world/index.js';

/** Defaults for the dials (mirrored by `window.js#WINDOW_PARAMS`). */
export const WINDOW_WEATHER_DEFAULTS = Object.freeze({
  /** Light left outside the breaks at FULL overcast (0 = black, 1 = no breaks). */
  breakFill: 1, // 2026-10-27 author's Studio export (was 0.1) — breaks off by default
  /** Size of a sun break, metres. */
  breakSizeM: 20, // 2026-10-27 author's Studio export (was 16)
  /** How dark a passing rain wave makes window light at full rain (0..1). */
  stormDarken: 0.16,
  /** Rain-wave response (the 'Rain waves' section). */
  stormBaseDarken: 0.3,
  waveThreshold: 0.75,
  waveSoftness: 0.85,
  waveFloor: 0.03,
  waveTint: Object.freeze([0x8f / 255, 0xa6 / 255, 0xc8 / 255]),
  waveTintAmount: 0.5,
  leadGlow: 0,
  startPrecip: 0.15,
  fullPrecip: 0.85,
  snowShare: 0.7,
  /** How much harder the window light leans golden with the sun low (0 = the base lean only). Colour, never level. */
  goldenBoost: 2, // 2026-10-27 author's Studio export (was 0.9)
  /** Scales the whole dawn/dusk/night colour lean (1 = as authored, 0 = none). */
  tintAmount: 0.7,
  /** How much of the outdoor light's own colour reaches the window (1 = all, 0 = brightness only). */
  outdoorHue: 0.7,
});

/** The rain darkening that applies everywhere at full rain, before any wave. */
export const WINDOW_STORM_BASE_DARKEN = WINDOW_WEATHER_DEFAULTS.stormBaseDarken;

/**
 * Cover → break threshold, in standardised-noise units. Below ~30% cover the
 * threshold is so low every fragment passes; the curve is shaped so 70% cover
 * keeps about half the light and 90% about a sixth. Exported for the test.
 * @param {number} overcast01 @returns {number}
 */
export function windowBreakThreshold(overcast01) {
  const c = Math.min(1, Math.max(0, Number(overcast01) || 0));
  return -2.5 + 4.1 * Math.pow(c, 1.5);
}

/**
 * How golden the light is — strongest with the sun just above the horizon,
 * zero at noon and at night. From the sun's own `twilight01` (1 at the horizon)
 * and `dayFactor01` (0 below −6°, 1 above +10°). Pure.
 * @param {{twilight01?: number, dayFactor01?: number}} sun @returns {number} 0..1
 */
export function windowGolden01(sun) {
  const t = Number.isFinite(sun?.twilight01) ? sun.twilight01 : 0;
  const d = Number.isFinite(sun?.dayFactor01) ? sun.dayFactor01 : 1;
  return Math.min(1, 2.2 * t * d);
}

/** Rec.709 luminance — the same weights `sky-access.js#luminance` uses. */
const luma = (rgb) => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;

/**
 * How far the window's own dawn/dusk/night colour rotates the outdoor light's
 * hue, before and at the golden peak. A HUE share, never a level: see
 * {@link windowDaylightTint}.
 */
export const WINDOW_TINT_SHARE = 0.35;
/** Extra share per unit of `goldenBoost` at the golden peak, and the cap. */
export const WINDOW_GOLDEN_SHARE = 0.15;
export const WINDOW_TINT_SHARE_MAX = 0.8;
/** The golden lean, scaled 20% down (author, 2026-10-28) — see {@link windowDaylightTint}. */
export const WINDOW_GOLDEN_EFFECT_SCALE = 0.8;

/**
 * THE DAYLIGHT TINT — night → golden → noon (neutral), the same nested lerp
 * both window subsystems always used, now returned as a UNIT-LUMINANCE hue.
 *
 * ⚠️ IT USED TO BRIGHTEN, AND THAT WAS THE GOLDEN-HOUR BLOW-OUT. `goldenBoost`
 * (the author's default 2) multiplied the finished light by up to 3× at the
 * golden peak, on top of an outdoor golden grade that already ran the red
 * channel at ~1.65× — the Mansion greenhouse went white-orange (author,
 * 2026-10-27: *"at golden hour it becomes extremely bright in the greenhouse,
 * far too bright"*). The window's brightness is now owned by the OUTDOOR light
 * it lets in ({@link windowTargetLight}); this only says which way that light
 * leans, and `goldenBoost` pushes the lean harder through the golden hour.
 *
 * @param {{dawnDusk: number[], night: number[], twilight01: number, dayFactor01: number, goldenBoost?: number}} a
 * @returns {number[]} rgb with luminance 1 (neutral `[1,1,1]` at noon).
 */
export function windowDaylightTint({ dawnDusk, night, twilight01, dayFactor01, goldenBoost = 0, tintAmount = 1 }) {
  const lerp = (a, b, t) => {
    const k = Math.min(1, Math.max(0, Number(t) || 0));
    return a.map((v, i) => v + (b[i] - v) * k);
  };
  // × WINDOW_GOLDEN_EFFECT_SCALE: the author's "about 20% less strong" (2026-10-28), on the effect so it reaches
  // saved Golden-hour-boost values too — the same scale the outdoor grade takes (`sky-access.js#GOLDEN_EFFECT_SCALE`).
  const golden01 = windowGolden01({ twilight01, dayFactor01 }) * WINDOW_GOLDEN_EFFECT_SCALE;
  // ⚠️ The plain chain washed the gold out: with the sun 4° up `dayFactor01` is
  // already ~0.7, so the light was 70% back to white at the very hour it should
  // be most golden. Golden light now HOLDS its colour — the whitening is held
  // back by up to 75% while the sun is low.
  const whiten = (Number(dayFactor01) || 0) * (1 - 0.75 * golden01);
  const tint = lerp(lerp(night, dawnDusk, twilight01), [1, 1, 1], whiten);
  const l = luma(tint);
  const unit = l > 1e-6 ? tint.map((v) => v / l) : [1, 1, 1];
  // `tintAmount` scales the whole lean (author, 2026-10-27: golden hour "far too
  // red and I can't see any way to lower that" — `goldenBoost` 0 still left 35%).
  const amount = Number.isFinite(tintAmount) ? Math.max(0, tintAmount) : 1;
  const share = Math.min(
    1,
    amount *
      Math.min(
        WINDOW_TINT_SHARE_MAX,
        WINDOW_TINT_SHARE + WINDOW_GOLDEN_SHARE * Math.max(0, Number(goldenBoost) || 0) * golden01
      )
  );
  // Both endpoints have luminance 1 and luminance is linear, so the mix does too.
  return lerp([1, 1, 1], unit, share);
}

/**
 * How bright a FULLY painted `_Window` texel is relative to the outdoor ground
 * beside it (the card's 'Brightness vs outdoors'). Author, 2026-10-27, on the
 * Mansion greenhouse: *"it should end up roughly the same brightness as the
 * outdoors around it, neither much darker nor brighter."* 1.1 = a touch of
 * glare off the glass.
 */
export const WINDOW_OUTDOOR_MATCH_DEFAULT = 2;

/**
 * How fast painted coverage saturates: `fill = 1 − exp(−rate · raw)`. With the
 * default strength (1.5) a white texel lands at 0.95 — all but the full outdoor
 * light — and a mid-grey one at ~0.78, so the painted falloff still reads.
 */
export const WINDOW_FILL_RATE = 2;

/**
 * Painted light → how much of the outdoors this texel lets in, 0..1. The CPU
 * twin of the shader's fill curve (`window-render.js`). @param {number} raw
 */
export function windowFill01(raw) {
  const x = Math.max(0, Number(raw) || 0);
  return 1 - Math.exp(-WINDOW_FILL_RATE * x);
}

/**
 * THE LIGHT A WINDOW LETS IN — the outdoor light (`outdoorRgb`: the ambient fill
 * times the sky's colour, plus the moon — exactly what the open ground beside
 * the building is lit by), leaning toward the window's own hue but with the
 * outdoor LUMINANCE kept, times the 'Brightness vs outdoors' match.
 *
 * Renormalised because the outdoor light is already golden at golden hour and
 * the window hue is golden too: their raw product would compound the red
 * channel past where the ground beside it sits. Pure.
 *
 * @param {{outdoorRgb: number[], hueRgb?: number[], outdoorMatch?: number}} a
 * @returns {number[]}
 */
export function windowTargetLight({
  outdoorRgb,
  hueRgb = [1, 1, 1],
  outdoorMatch = WINDOW_OUTDOOR_MATCH_DEFAULT,
  outdoorHue = 1,
}) {
  const raw = (Array.isArray(outdoorRgb) && outdoorRgb.length === 3 ? outdoorRgb : [0, 0, 0]).map((v) =>
    Number.isFinite(v) ? Math.max(0, v) : 0
  );
  // How much of the outdoor light's OWN colour comes through (1 = all, 0 = just
  // its brightness as neutral grey). At golden hour that colour is already a
  // red-heavy grade, which the window hue then leans on again.
  const keep = Number.isFinite(outdoorHue) ? Math.min(1, Math.max(0, outdoorHue)) : 1;
  const grey = luma(raw);
  const out = raw.map((v) => grey + (v - grey) * keep);
  const hue = Array.isArray(hueRgb) && hueRgb.length === 3 && hueRgb.every(Number.isFinite) ? hueRgb : [1, 1, 1];
  const match = Number.isFinite(outdoorMatch) ? Math.max(0, outdoorMatch) : WINDOW_OUTDOOR_MATCH_DEFAULT;
  const product = out.map((v, i) => v * Math.max(0, hue[i]));
  const lp = luma(product);
  const k = lp > 1e-6 ? (luma(out) / lp) * match : match;
  return product.map((v) => v * k);
}

/**
 * What a window ADDS to the illumination buffer: it pulls the interior from the
 * indoor light (`indoorRgb`, the ambient fill indoors) toward the light it lets
 * in, by how much it lets in. Signed — the illum buffer is half-float, so a
 * window under a storm wave or a darker-than-indoors sky really does darken the
 * room toward the outdoors, which is the whole point. The CPU twin of the
 * shader's composite. Pure.
 *
 * @param {{fill01: number, targetRgb: number[], indoorRgb: number[]}} a @returns {number[]}
 */
export function windowLightDelta({ fill01, targetRgb, indoorRgb }) {
  const f = Math.min(1, Math.max(0, Number(fill01) || 0));
  return targetRgb.map((t, i) => f * (t - indoorRgb[i]));
}

/**
 * Build the weather gain node, 0..1, multiplied into the finished window light.
 *
 * @param {*} TSL
 * @param {object} a
 * @param {*} a.worldXY - vec2, world px of the fragment.
 * @param {*} a.timeMs - the shared clock.
 * @param {{directionDeg:*, speed01:*, gustiness01?:*, pixelsPerMetre?:*, advection?:object}} a.wind - the wind
 *   handle's ambient nodes, `advection` included (`world/wind-field.js#createWindAdvectionUniforms`).
 * @param {*} a.cloudOffset - vec2, the cloud deck's drift offset (world px).
 * @param {*} a.overcast01 - float node, cloud cover.
 * @param {*} a.rain01 - float node, how hard it is raining (0 = dry).
 * @param {*} a.pixelsPerMetre - float node.
 * @param {{breakFill:*, breakSizeM:*, stormDarken:*}} a.dials - float nodes.
 * @returns {*} vec3 node — a gain and a colour shift, multiplied into the finished light.
 */
export function buildWindowWeatherGainNode(
  TSL,
  { worldXY, timeMs, wind, cloudOffset, overcast01, rain01, pixelsPerMetre, dials }
) {
  const { float, vec2, vec3, clamp, smoothstep, mix, pow, max, mx_noise_float: perlin } = TSL;
  // Optional dials (the Rain waves section) fall back to the module defaults,
  // so an older caller passing only the first three still builds.
  const D = WINDOW_WEATHER_DEFAULTS;
  const dial = (k) => dials[k] ?? float(D[k]);

  // ── SUN BREAKS ──
  const c = clamp(overcast01, float(0), float(1));
  const sizePx = dials.breakSizeM.mul(pixelsPerMetre).max(float(1));
  const p = worldXY.sub(cloudOffset).div(sizePx);
  // A slow churn on top of the drift, so a break opens and closes rather than
  // only sliding past.
  const churn = timeMs.mul(float(0.001 * 0.03));
  const n = perlin(vec2(p.x, p.y.add(churn)))
    .mul(float(0.65))
    .add(perlin(vec2(p.x.mul(2.3).add(17.1), p.y.mul(2.3).sub(churn.mul(1.7)).add(5.3))).mul(float(0.35)));
  const z = n.div(float(0.3));
  const threshold = float(-2.5).add(pow(c, float(1.5)).mul(float(4.1)));
  const inBreak = smoothstep(threshold, threshold.add(float(0.35)), z);
  // The fill only deepens once the sky is genuinely heavy — light cloud leaves
  // the window alone rather than greying it.
  const fill = mix(float(1), clamp(dials.breakFill, float(0), float(1)), smoothstep(float(0.3), float(0.9), c));
  const breaks = mix(fill, float(1), inBreak);

  // ── STORM WAVES ──
  const gust = computeGustEnvelope(TSL, {
    centerXY: worldXY,
    time: timeMs,
    directionDeg: wind.directionDeg,
    gustiness01: wind.gustiness01 ?? float(1),
    speed01: wind.speed01,
    pixelsPerMetre,
    // The fronts' INTEGRATED travel. Without it a wind fade slid them by
    // `t · dSpeed/dt` and this darkness strobed — the 2026-10-27 report.
    advection: wind.advection,
  });
  // THE SAME SHAPING the torrent layer surges by (torrent-field.js), so the
  // darkness lands exactly where the rain brightens.
  // (Defaults 0.75 → 0.75 + 0.85 = 1.6 — the torrent's own shaping.)
  const thr = dial('waveThreshold');
  const wave = smoothstep(thr, thr.add(max(dial('waveSoftness'), float(0.01))), gust);
  const r = clamp(rain01, float(0), float(1));
  const darken = r.mul(dial('stormBaseDarken').add(wave.mul(clamp(dials.stormDarken, float(0), float(1)))));
  // The bright moment BEFORE a squall: a band just under the threshold.
  const lead = smoothstep(thr.sub(float(0.3)), thr, gust)
    .mul(float(1).sub(wave))
    .mul(r)
    .mul(dial('leadGlow'));
  const storm = clamp(float(1).sub(darken).add(lead), clamp(dial('waveFloor'), float(0), float(1)), float(2));
  // Inside a wave the light shifts toward the storm colour.
  const tint = mix(vec3(1, 1, 1), dials.waveTint ?? vec3(...D.waveTint), wave.mul(r).mul(dial('waveTintAmount')));

  return tint.mul(breaks.mul(storm));
}
