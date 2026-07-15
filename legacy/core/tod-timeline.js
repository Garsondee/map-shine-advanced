/**
 * @fileoverview Shared time-of-day timeline evaluation (8-anchor smooth blend).
 * Used by Window Light and available for Color Correction refactor.
 * @module core/tod-timeline
 */

/** Per-channel RGB multiply for timeline tints (1 = neutral). */
export const TOD_TINT_MIN = 0;
export const TOD_TINT_MAX = 3;
export const TOD_TINT_NEUTRAL = 1;

export const TOD_ANCHOR_COUNT = 8;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export const clamp = (value, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
};

/**
 * @param {number} hour
 * @returns {number}
 */
export const wrapHour24 = (hour) => {
  const n = Number(hour);
  const h = Number.isFinite(n) ? n : 0;
  return ((h % 24) + 24) % 24;
};

/**
 * @param {number} t
 * @returns {number}
 */
export const smooth01 = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @param {{ r?: number, g?: number, b?: number }|null|undefined} a
 * @param {{ r?: number, g?: number, b?: number }|null|undefined} b
 * @param {number} t
 * @returns {{ r: number, g: number, b: number }}
 */
export const lerpColor = (a, b, t) => ({
  r: lerp(Number(a?.r) || 0, Number(b?.r) || 0, t),
  g: lerp(Number(a?.g) || 0, Number(b?.g) || 0, t),
  b: lerp(Number(a?.b) || 0, Number(b?.b) || 0, t),
});

/**
 * @param {*} value
 * @returns {{ r: number, g: number, b: number }}
 */
export const normalizeTintMultiplier = (value) => {
  if (value == null || typeof value !== 'object') {
    return { r: TOD_TINT_NEUTRAL, g: TOD_TINT_NEUTRAL, b: TOD_TINT_NEUTRAL };
  }
  let r = Number(value.r);
  let g = Number(value.g);
  let b = Number(value.b);
  if (!Number.isFinite(r)) r = TOD_TINT_NEUTRAL;
  if (!Number.isFinite(g)) g = TOD_TINT_NEUTRAL;
  if (!Number.isFinite(b)) b = TOD_TINT_NEUTRAL;

  const maxc = Math.max(r, g, b);
  if (maxc > TOD_TINT_MAX && maxc <= 255) {
    r /= 255;
    g /= 255;
    b /= 255;
  }

  return {
    r: clamp(r, TOD_TINT_MIN, TOD_TINT_MAX),
    g: clamp(g, TOD_TINT_MIN, TOD_TINT_MAX),
    b: clamp(b, TOD_TINT_MIN, TOD_TINT_MAX),
  };
};

/**
 * @param {object} [overrides]
 * @returns {{ exposure: number, saturation: number, tintColor: { r: number, g: number, b: number }, intensityScale: number }}
 */
export const makeTodGrade = (overrides = {}) => ({
  exposure: 0.0,
  saturation: 1.0,
  tintColor: { r: TOD_TINT_NEUTRAL, g: TOD_TINT_NEUTRAL, b: TOD_TINT_NEUTRAL },
  intensityScale: 1.0,
  ...overrides,
});

/**
 * @param {*} value
 * @returns {boolean}
 */
export const isTimelineEnabledParam = (value) =>
  value !== false && value !== 0 && value !== '0' && value !== 'false';

/**
 * Neutral grade when timeline is disabled.
 * @returns {{ exposure: number, saturation: number, tintColor: { r: number, g: number, b: number }, intensityScale: number }}
 */
export const neutralTodGrade = () => makeTodGrade();

/**
 * Smoothly blend eight clock anchors around the 24h cycle (including midnight wrap).
 *
 * @param {number} hourRaw
 * @param {Array<{ hour: number, grade: { exposure?: number, saturation?: number, tintColor?: object, intensityScale?: number } }>} anchors
 * @returns {{ exposure: number, saturation: number, tintColor: { r: number, g: number, b: number }, intensityScale: number }}
 */
export function evaluateTodTimeline(hourRaw, anchors) {
  const hour = wrapHour24(hourRaw);
  const list = (Array.isArray(anchors) ? anchors : [])
    .map((a) => ({
      hour: wrapHour24(a?.hour),
      grade: makeTodGrade({
        exposure: a?.grade?.exposure ?? 0,
        saturation: a?.grade?.saturation ?? 1,
        tintColor: normalizeTintMultiplier(a?.grade?.tintColor),
        intensityScale: a?.grade?.intensityScale ?? 1,
      }),
    }))
    .sort((a, b) => a.hour - b.hour);

  if (list.length === 0) return neutralTodGrade();
  if (list.length === 1) return { ...list[0].grade, tintColor: { ...list[0].grade.tintColor } };

  let prev = list[list.length - 1];
  let next = list[0];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    const b = list[(i + 1) % list.length];
    const bHour = i === list.length - 1 ? b.hour + 24 : b.hour;
    const h = hour < a.hour ? hour + 24 : hour;
    if (h >= a.hour && h <= bHour) {
      prev = a;
      next = b;
      break;
    }
  }

  const prevHour = prev.hour;
  const nextHour = next.hour <= prevHour ? next.hour + 24 : next.hour;
  const sampleHour = hour < prevHour ? hour + 24 : hour;
  const span = Math.max(0.0001, nextHour - prevHour);
  const t = smooth01((sampleHour - prevHour) / span);

  const pg = prev.grade;
  const ng = next.grade;

  return {
    exposure: lerp(pg.exposure, ng.exposure, t),
    saturation: lerp(pg.saturation, ng.saturation, t),
    tintColor: lerpColor(pg.tintColor, ng.tintColor, t),
    intensityScale: lerp(pg.intensityScale, ng.intensityScale, t),
  };
}
