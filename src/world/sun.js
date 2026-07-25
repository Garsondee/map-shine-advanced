/**
 * THE ONE SUN — sun position/character derived from time-of-day, in one place.
 *
 * V2 computed sun-from-time in AT LEAST EIGHT places (the shadow system's own
 * `SunDirection.js`, `time.js`, `ThreeLightSource`, inline effect math…), and
 * fifteen files held sun state — so shadows could point one way while specular
 * glints answered to a different sky, BY CONSTRUCTION (docs/planning/Environment.md
 * §0.2). Worse, the roof-drip system never derived its screen→world mapping at
 * all and VOTED between four candidates at runtime — the feature that "never
 * reliably worked" (memory: feedback_probed_constants_vs_derived).
 *
 * The rule this module embodies: **a constant is DERIVED once and asserted in a
 * Node test — never probed, never re-derived per consumer.** The `env/one-sun`
 * tripwire fails the build if sun terms appear anywhere else.
 *
 * THE MODEL — cinematic plausibility over physical simulation (V2's own
 * WeatherController doctrine line, kept on purpose). This is stage lighting for
 * a top-down map, not an ephemeris:
 *
 *   elevation(h) = maxElevation · cos(2π · (h − 12) / 24)
 *     → noon: max. midnight: −max. 06:00 and 18:00: exactly 0 (the horizon).
 *   azimuth(h) = noonAzimuth + (h − 12) · 15°/hour
 *     → the real Earth rate; 06:00 = east (90°), noon = south (180°), 18:00 = west (270°).
 *
 * Continuous everywhere (no branch at sunrise to pop a shadow direction), and
 * lining up with the ToD anchor hours (0/6/12/18) the author already tunes by.
 *
 * @module world/sun
 */

/** @typedef {{maxElevationDeg?: number, noonAzimuthDeg?: number, fullDarkElevationDeg?: number}} SunConfig */

export const DEFAULT_SUN_CONFIG = Object.freeze({
  /** Peak elevation at noon. 60° reads as "high sun" without top-down shadows vanishing. */
  maxElevationDeg: 60,
  /** Noon azimuth. 180° = south — northern-hemisphere stage convention. */
  noonAzimuthDeg: 180,
  /**
   * The elevation at which the SKY finally goes fully dark — the end of
   * astronomical twilight, −18° in the real world, and the author's *"darkness
   * to hit 1 at a point after dusk and before dawn"*.
   *
   * This is a genuinely different question from "has the sun set". Direct sun
   * dies at 0°, but the sky dome stays lit far below that; treating them as one
   * number is why a scene snapped to full night the instant the sun touched the
   * horizon. `dayFactor01` answers the first question, `skyFactor01` the second.
   */
  fullDarkElevationDeg: -18,
});

/**
 * THE SECTIONS OF THE SKY — the author's *"break up the clock into sections"*,
 * keyed to sun ELEVATION rather than to clock hours.
 *
 * That distinction is the whole design. V2's time-of-day system was eight
 * hand-placed HOUR anchors (`legacy/core/tod-timeline.js`), and the sun was
 * computed separately — so the anchors and the sun could, and did, disagree
 * about when dusk was. Deriving the sections from elevation means:
 *
 *   - the ring arcs on the astrolabe are computed FROM the sun model
 *     (`phaseBoundaryHours`), so a boundary can never drift out of sync;
 *   - changing `maxElevationDeg` moves the sections automatically;
 *   - if latitude/season ever land, the sections follow for free.
 *
 * The boundaries are the real civil/nautical/astronomical twilight definitions
 * — not invented numbers — so the vocabulary matches what a cinematographer or
 * a photographer already means by "blue hour" and "golden hour".
 *
 * Ordered darkest-first; each entry owns elevations UP TO its `maxElevationDeg`.
 * @type {ReadonlyArray<Readonly<{key: string, label: string, maxElevationDeg: number}>>}
 */
export const SKY_PHASES = Object.freeze([
  Object.freeze({ key: 'night', label: 'Night', maxElevationDeg: -18 }),
  Object.freeze({ key: 'astronomical', label: 'Astronomical twilight', maxElevationDeg: -12 }),
  Object.freeze({ key: 'nautical', label: 'Nautical twilight', maxElevationDeg: -6 }),
  Object.freeze({ key: 'civil', label: 'Blue hour', maxElevationDeg: 0 }),
  Object.freeze({ key: 'golden', label: 'Golden hour', maxElevationDeg: 6 }),
  Object.freeze({ key: 'day', label: 'Day', maxElevationDeg: Infinity }),
]);

/**
 * Where and what the sun is at `todHour`. Pure; returns a frozen value.
 *
 * @param {number} todHour - 0..24 (any finite number is normalised into range).
 * @param {SunConfig} [config]
 * @returns {Readonly<{
 *   todHour: number,
 *   elevationDeg: number,
 *   azimuthDeg: number,
 *   aboveHorizon: boolean,
 *   dayFactor01: number,
 *   skyFactor01: number,
 *   twilight01: number,
 *   phase: string,
 *   rising: boolean,
 * }>}
 */
export function computeSun(todHour, config = DEFAULT_SUN_CONFIG) {
  const cfg = { ...DEFAULT_SUN_CONFIG, ...config };
  const h = normalizeHour(todHour);

  const elevationDeg = cfg.maxElevationDeg * Math.cos((2 * Math.PI * (h - 12)) / 24);
  const azimuthDeg = wrapDeg(cfg.noonAzimuthDeg + (h - 12) * 15);

  // How "day" it is, 0..1 — eased across civil twilight (−6°) to clear sun
  // (+10°), so lighting fades in rather than snapping at the horizon. This is
  // the DIRECT SUN's own strength: the key light, and what shadows key from.
  const dayFactor01 = smoothstep01((elevationDeg + 6) / 16);

  // How lit the SKY DOME is, 0..1 — a separate, much longer tail than the sun's
  // own. The sky is still bright well after the sun has set and does not go
  // genuinely black until astronomical twilight ends (`fullDarkElevationDeg`).
  //
  // THIS is what darkness derives from (world/environment.js), which is what
  // makes the author's *"darkness hits 1 at a point after dusk and before
  // dawn"* true: at the default −18°/60° that lands near 19:10 and 04:50,
  // rather than at the 18:23/05:38 the direct-sun curve alone would give.
  // Keeping the two curves separate is also what lets the blue hour exist at
  // all — a window where the sun contributes nothing but the sky still does.
  const skyFactor01 = smoothstep01((elevationDeg - cfg.fullDarkElevationDeg) / (0 - cfg.fullDarkElevationDeg));

  // How "golden hour" it is, 0..1 — peaks when the sun sits ON the horizon and
  // fades within ±12°. Warmth/long-shadow looks key from this, day or dusk.
  const twilight01 = clamp01(1 - Math.abs(elevationDeg) / 12);

  return Object.freeze({
    todHour: h,
    elevationDeg,
    azimuthDeg,
    aboveHorizon: elevationDeg > 0,
    dayFactor01,
    skyFactor01,
    twilight01,
    /** The named section of the sky (see SKY_PHASES). */
    phase: phaseAtElevation(elevationDeg).key,
    /** True while the sun is climbing — what tells dawn from dusk at the SAME
     * elevation. The model is symmetric about noon, so this is the only thing
     * that distinguishes them, and a consumer that forgets it will label an
     * 05:00 blue hour "dusk". */
    rising: h > 0 && h < 12,
  });
}

/**
 * Which section of the sky an elevation falls in. Pure lookup over SKY_PHASES.
 * @param {number} elevationDeg
 * @returns {Readonly<{key: string, label: string, maxElevationDeg: number}>}
 */
export function phaseAtElevation(elevationDeg) {
  const e = Number(elevationDeg);
  if (!Number.isFinite(e)) return SKY_PHASES[SKY_PHASES.length - 1];
  for (const p of SKY_PHASES) {
    if (e < p.maxElevationDeg) return p;
  }
  return SKY_PHASES[SKY_PHASES.length - 1];
}

/**
 * The CLOCK HOURS at which each sky section begins and ends, derived by
 * inverting the elevation curve. This is what the astrolabe draws its ring arcs
 * from — so the arcs are a VIEW of the sun model, never a second, hand-placed
 * copy of it that can drift (V2's eight hour-anchors were exactly that copy).
 *
 * Inverting `elev = maxElev·cos(2π(h−12)/24)` gives `h = 12 ± (12/π)·acos(E/maxElev)`,
 * i.e. every elevation between trough and peak happens TWICE a day — once
 * climbing, once falling — so most sections come back as a PAIR of arcs, one at
 * dawn and one at dusk.
 *
 * A boundary the sun never reaches is CLAMPED to the extreme it lies beyond,
 * not dropped: a boundary below the trough means the section runs through
 * midnight, one above the peak means it runs through noon. Dropping instead of
 * clamping is what a first cut did, and on a shallow sun (`maxElevationDeg: 5`,
 * where −18° and +6° are both unreachable) it returned NO sections at all —
 * a blank ring for a sun that is perfectly well-defined all day. A section the
 * sun genuinely never enters is still omitted entirely, which is the honest
 * answer and is not the same thing.
 *
 * @param {SunConfig} [config]
 * @returns {Array<{key: string, label: string, startHour: number, endHour: number}>}
 *   Sections in clock order starting at 00:00. A section that wraps midnight is
 *   returned with `startHour > endHour` — the caller draws it as two arcs.
 */
export function phaseBoundaryHours(config = DEFAULT_SUN_CONFIG) {
  const cfg = { ...DEFAULT_SUN_CONFIG, ...config };
  const peak = cfg.maxElevationDeg;

  /**
   * The rising-side (00:00→12:00) hour at which the sun passes `elev`, clamped
   * to midnight below the trough and noon above the peak — see the essay above.
   */
  const risingHourAt = (elev) => {
    if (elev <= -peak) return 0;
    if (elev >= peak) return 12;
    return 12 - (12 / Math.PI) * Math.acos(elev / peak);
  };

  const out = [];
  const add = (phase, startHour, endHour) => out.push({ key: phase.key, label: phase.label, startHour, endHour });

  for (let i = 0; i < SKY_PHASES.length; i++) {
    const phase = SKY_PHASES[i];
    // A section owns elevations from where the previous one stopped up to its
    // own ceiling. The first starts at −∞, the last ends at +∞.
    const hStart = risingHourAt(i === 0 ? -Infinity : SKY_PHASES[i - 1].maxElevationDeg);
    const hEnd = risingHourAt(phase.maxElevationDeg);

    if (hEnd - hStart < 1e-9) continue; // the sun never enters this section

    if (hStart <= 0 && hEnd >= 12)
      add(phase, 0, 24); // the sun never leaves it either
    else if (hStart <= 0)
      add(phase, 24 - hEnd, hEnd); // contains midnight — one wrapping arc
    else if (hEnd >= 12)
      add(phase, hStart, 24 - hStart); // contains noon — one arc
    else {
      add(phase, hStart, hEnd); // dawn side
      add(phase, 24 - hEnd, 24 - hStart); // dusk side
    }
  }
  return out.sort((a, b) => a.startHour - b.startHour);
}

/** @param {number} hour @returns {number} 0..24, tolerant of any finite input */
export function normalizeHour(hour) {
  const n = Number(hour);
  if (!Number.isFinite(n)) return 12; // a broken input reads as noon, LOUDLY neutral — never NaN downstream
  return ((n % 24) + 24) % 24;
}

/** @param {number} deg @returns {number} 0..360 */
function wrapDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/** @param {number} x @returns {number} */
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

/** Hermite smoothstep on a pre-scaled 0..1 input. */
function smoothstep01(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}
