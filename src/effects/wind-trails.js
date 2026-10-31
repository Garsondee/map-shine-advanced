/**
 * WIND TRAILS — sleek white strokes that show the scene's wind.
 *
 * The author, 2026-10-27: *"Create a new particle effect, the goal of which is to
 * create 'wind trails' which help to visualize the scenes wind speeds. These need
 * to be sleek white tapered fat lines which swirl in pleasing ways and which only
 * appear for a second or two at most."*
 *
 * WHAT IT IS: a population of short-lived ribbons whose heads ride the SHARED
 * wind field at its REAL speed (`world/wind-field.js#windFieldPxPerSecPerUnit`) —
 * the same air the wind overlay draws, gusts and turbulence included — so a
 * trail is literally a puff of that air made visible. Each one is born
 * downwind-straight, curls one way as it ages (`swirl`), thins as it fades, and
 * is gone within a second or two. They only appear where the local wind is
 * faster than `minSpeedMps`, so a calm map is clean, a breeze shows the odd
 * stroke, and a gale fills with them; and because the field is gated by
 * geometry, they stream around buildings and into open doorways rather than
 * through walls.
 *
 * THE LOOK IS ANIME WIND LINES (author, 2026-10-27, after the first lab cut:
 * *"Those lines aren't tapered at both ends, they are overlapping, we need much
 * more sparse. Think anime wind lines."*): a FEW thin strokes on screen at once,
 * each long, pointed at both ends, sweeping with the wind and hooking into a
 * loop as it fades — not a field of them.
 *
 * WHY NOT A NEW ENGINE: `effects/particles/gust-runtime.js` already threads a
 * ribbon through a ring of recent head positions and reads the wind through the
 * one handle. A trail is that engine in a different costume — a spindle profile
 * (fat body, pointed both ends), a curl, a fixed-clock history (length in
 * seconds of path, not frames) and normal blending so white reads as white on a
 * bright map. Those are declaration params; the engine's header lists them.
 *
 * Pure data + one builder. No THREE, no Foundry — Node-tested.
 *
 * @module effects/wind-trails
 */

/** The effect's Studio parameters. */
export const WIND_TRAILS_PARAMS = Object.freeze({
  density: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.05,
    default: 0.35, // author's own default, 2026-10-31
    category: 'Look',
    label: 'Density',
    help: 'How many trails at a given wind speed. More wind always means more trails; this scales the lot.',
  },
  widthPx: {
    type: 'float',
    min: 2,
    max: 24,
    step: 0.5,
    default: 8, // author's own default, 2026-10-31
    category: 'Look',
    label: 'Thickness',
    help: 'The fattest point of a trail, in map pixels. Trails taper to a point at both ends.',
  },
  sizeVariation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.8,
    // Author, 2026-10-31: "Include a much wider variety of trail sizes".
    category: 'Look',
    label: 'Size variation',
    help: 'How much trails differ in size. 0 makes every trail the Thickness and Length above; 1 ranges from under half to over twice that, big trails both longer and fatter.',
  },
  lengthSec: {
    type: 'float',
    min: 0.1,
    max: 1.2,
    step: 0.01,
    default: 0.2, // author's own default, 2026-10-27
    category: 'Look',
    label: 'Length',
    help: 'How much of its path a trail shows, in seconds. Faster wind makes the same setting longer on the map.',
  },
  swirl: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1.2, // author's own default, 2026-10-31
    // Up to 1: how many trails loop (half of them at 1). Past 1: more turns per
    // loop. Loops are always WHOLE turns, so a trail leaves its loop along the
    // wind (`particles/trail-swirl.js`).
    category: 'Look',
    label: 'Swirl',
    help: 'Up to 1, how many trails loop (about half at 1); above 1, looping trails turn more times. Every loop is whole, so trails run with the wind before and after it. 0 keeps every trail straight.',
  },
  swirlVariation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.7,
    // Author, 2026-10-31: "Ideally I'd need a new 'swirl variation' slider as
    // they all have the same exact swirl … make the swirls less perfect."
    category: 'Look',
    label: 'Swirl variation',
    help: 'How different each swirl is: loop size, when it happens, how many turns and how lopsided it is. Non-looping trails get a gentle S-bend. 0 makes every swirl the same round loop.',
  },
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5, // author's own default, 2026-10-31
    category: 'Look',
    label: 'Opacity',
    help: 'How solid the trails are at their strongest.',
  },
  lifeSec: {
    type: 'float',
    min: 0.5,
    max: 2.5,
    step: 0.05,
    default: 1.55, // author's own default, 2026-10-31
    category: 'Timing',
    label: 'Lifetime',
    help: 'Average seconds a trail lives, from fade-in to gone. Each varies a little around this.',
  },
  minSpeedMps: {
    type: 'float',
    min: 0,
    max: 30,
    step: 0.5,
    default: 5,
    category: 'Timing',
    label: 'Appears above (m/s)',
    help: 'Local wind speed below which no trails show. 5 m/s is a gentle-to-moderate breeze; 17 m/s a gale.',
  },
  color: {
    type: 'color',
    space: 'srgb',
    default: '#ffffff',
    category: 'Look',
    label: 'Colour',
    help: 'Trail colour.',
  },
});

/**
 * The manifest. `enabledFromProfile: 'low'` — a few hundred ribbon vertices and
 * one small compute pass; it is the one wind effect whose whole job is to make
 * the wind legible, so it is on wherever there is wind to show.
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const WIND_TRAILS = Object.freeze({
  id: 'windTrails',
  title: 'Wind Trails',
  visualWeight: 0.4,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'none',
    why: 'Builds its compute kernels and ribbon material on first enable (the shared ribbon engine), synchronously inside a frame — covered by settle.js’s global pipeline-growth and frame-steadiness criteria, not a per-effect probe (a calm scene never builds it, and a "built yet" flag would fail closed).',
  }),
  params: WIND_TRAILS_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'trails',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.03 }),
      adds: 'curling, tapered wind strokes riding the shared wind field at its real speed',
    }),
  ]),
});

/** Parse '#rrggbb' to linear-ish 0..1 RGB (sRGB channels as authored). */
function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** How many head positions a trail remembers (the history ring). */
export const WIND_TRAILS_SEGMENTS = 64;

/**
 * How many points a trail is DRAWN through, by graphics profile. The ribbon is a
 * Catmull-Rom spline through the remembered positions, so more points means a
 * smoother curve where a far or fast head left sparse recordings. Standard is
 * the long-standing 64; `extreme` is dense enough that no stroke reads angular.
 * Cost is a few thousand extra vertices at most (≤12 live trails).
 */
export const WIND_TRAILS_MESH_SEGMENTS = Object.freeze({
  low: 24,
  performance: 40,
  standard: 64,
  quality: 128,
  extreme: 320,
});

/**
 * The strip point count for a performance profile. An unknown profile reads as
 * standard (same fallback as `profileRank`).
 * @param {string} [profile]
 * @returns {number}
 */
export function windTrailsMeshSegments(profile) {
  return WIND_TRAILS_MESH_SEGMENTS[profile] ?? WIND_TRAILS_MESH_SEGMENTS.standard;
}

/**
 * The particle-system declaration the ribbon engine builds from — the
 * construction-time shape. Live changes after that go through the engine's
 * `setLook` ({@link windTrailsLook}).
 * @param {object} [params] - resolved WIND_TRAILS_PARAMS values.
 * @param {string} [profile] - the performance profile; sets how many points the
 *   line is drawn through. Fixed for the engine's life (it sizes the geometry).
 */
export function buildWindTrailsSystem(params = {}, profile) {
  const v = (k) => (Number.isFinite(params[k]) ? params[k] : WIND_TRAILS_PARAMS[k].default);
  const lifeMs = v('lifeSec') * 1000;
  return {
    id: 'weather.windTrails',
    visualWeight: WIND_TRAILS.visualWeight,
    emitter: { shape: 'circle' },
    behaviors: [{ type: 'smartWind', params: { gain: 1 } }, { type: 'sizeOverLife' }, { type: 'colorOverLife' }],
    spawn: { kind: 'area' },
    reads: ['res:wind'],
    tiers: [{ n: 0 }, { n: 1 }],
    params: {
      capacity: 48,
      segments: WIND_TRAILS_SEGMENTS,
      meshSegments: windTrailsMeshSegments(profile),
      // A dead calm shows nothing; a hurricane only ~a dozen. SPARSE is the look:
      // anime wind lines are a handful on screen, never a field of them.
      minTrails: 0,
      maxTrails: 12,
      gateLoMps: v('minSpeedMps'),
      gateHiMps: v('minSpeedMps') * 1.8 + 1,
      widthPx: v('widthPx'),
      opacityMax: v('opacity'),
      colorRGB: hexToRgb01(params.color ?? WIND_TRAILS_PARAMS.color.default),
      // The air's own velocity, followed closely — a trail is that air.
      windGain: 1,
      accelToMaxSeconds: 0.25,
      lifeMs,
      fadeMs: Math.min(450, lifeMs / 3),
      lifeJitter: 0.35,
      // Purely random rebirth — biasing toward the windiest spot bunched the
      // few trails into the same gust; sparse means spread out.
      respawnCandidates: 1,
      // The costume (see gust-runtime.js's 2026-10-27 header).
      profile: 'spindle',
      swirl: v('swirl'),
      swirlVariation: v('swirlVariation'),
      sizeVariation: v('sizeVariation'),
      segmentSec: v('lengthSec') / WIND_TRAILS_SEGMENTS,
      // …but never longer on the map than this (a hurricane's 0.3 s of path is
      // 10 m; a trail reads as a stroke, not a lane marking).
      maxLengthM: 8,
      blending: 'normal',
    },
  };
}

/**
 * The engine `setLook` payload for resolved params — every live control.
 * @param {object} [params]
 */
export function windTrailsLook(params = {}) {
  const v = (k) => (Number.isFinite(params[k]) ? params[k] : WIND_TRAILS_PARAMS[k].default);
  return {
    density: v('density'),
    widthPx: v('widthPx'),
    opacity: v('opacity'),
    swirl: v('swirl'),
    swirlVariation: v('swirlVariation'),
    sizeVariation: v('sizeVariation'),
    lifeSec: v('lifeSec'),
    lengthSec: v('lengthSec'),
    minSpeedMps: v('minSpeedMps'),
    colorRGB: hexToRgb01(params.color ?? WIND_TRAILS_PARAMS.color.default),
  };
}
