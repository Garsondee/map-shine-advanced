/**
 * STORYBOOK CLOUDS — clouds that belong over painted maps (author, 2026-11-03: *"distinct clouds with spaces
 * between them instead of the current grey slime ... a sort of bulbous fisheye like bulge ... guess how Crosshead
 * would render clouds, the colorations they'd use at different times of day. Bonus points for making the clouds
 * have real depth."*).
 *
 * ============================================================================
 * ONE FIELD, NOT A BUNDLE OF BALLOONS (round 5, 2026-11-03)
 * ============================================================================
 * Rounds 1-4 built each cloud from seventeen ray-cast ellipsoids in its own grid cell, with three torn trails
 * pasted on behind. Seen live, the author's verdict: *"All clouds are the same shape, you get no conditions where
 * two clouds combine or split apart. The trails behind them are at all different angles instead of ones informed
 * by the wind, the trails don't actually move or animate or evolve ... I can still see at the interface two
 * completely different looking and feeling materials. Cloud shapes are still just a series of balloons attached
 * in a bundle together"* — with five aerial photos of fair-weather cumulus over the sea as the target: defined
 * but not cartoonish, irregular gaps of every size.
 *
 * So the clouds are now ONE continuous field (`coreAt`), thresholded:
 *   - CLUSTERS — a slow, very low-frequency noise that crowds the sky in places and opens it in others: the
 *     irregular gaps, from a sliver between two clouds to an open stretch of sea.
 *   - BODY — a domain-warped fBm: every cloud a different shape, at every size, with scraps round the edges.
 *   - BILLOWS — rounded Worley lumps riding on the body: the cauliflower tops, as relief, not as balloons
 *     (they push the body's height up and down; they never make a silhouette of their own).
 *   - EVOLUTION — the warp, clusters and body slide slowly against each other and against the drift, so clouds
 *     bulge, pinch, merge and split as they cross the table; nothing pops in at an edge (there is no edge: the
 *     field is everywhere, and the old domain-edge shrink that made clouds "grow into the frame" is gone).
 *   - WISPS — the thin, translucent part of the SAME field: the field sampled upwind (where the cloud has been)
 *     and torn into wind-aligned streaks that stream along the wind faster than the clouds drift. They point
 *     where the wind points, they move, and they are the cloud's own thin edge, not a second material.
 *
 * ============================================================================
 * REAL DEPTH — the deck is cast to the scene eye
 * ============================================================================
 * Every pixel casts the ray from its ground point up to the shared scene eye (`scene/scene-eye.js`) and reads the
 * field where that ray crosses the deck — then again at the height of the cloud's own top surface there (a
 * one-step relief cast), so thick tops shift against their thin edges as the view pans, and the wisps (lower)
 * slide against the heads. Shading comes from the field's own height: the slope toward the light, plus a
 * self-shadow sample a little way toward it (the grey-blue shade a tall billow throws on its neighbour).
 *
 * ============================================================================
 * THE DOME — the whole deck curves over the play area
 * ============================================================================
 * The deck's height follows a dome centred on the board (`dome(c) = 1 − ρ²`), highest over the middle; seen from
 * the scene eye the middle is magnified more than the rim, a barrel bulge that reads as a sky arching over the
 * table. Deck height is a FRACTION OF THE EYE HEIGHT (the eye rises as the view pulls back), so the bulge and the
 * parallax hold at every zoom. A view-centred fisheye (`lens`) adds to it.
 *
 * The ground shadow reads the SAME field ({@link buildStorybookShadowNode}), so a cloud and its shadow agree.
 *
 * Pure TSL builders with TSL injected, plus pure JS (palette, deck resolution) for the CPU side and the tests.
 * No THREE import, no state.
 *
 * @module effects/clouds/storybook-clouds
 */

/**
 * The field's shape constants (cloud units: 1 = the deck's `spacing`, about the width of a large cloud).
 * Tuned in the shader lab against the author's reference photos (`tools/shader-lab/storybook-cloud-lab.js`).
 */
export const STORYBOOK_FIELD = Object.freeze({
  /** Domain-warp frequency (its strength is the Twist dial). */
  warpFreq: 0.6,
  /** fBm body frequency at Shape detail 1. */
  bodyFreq: 0.7,
  /** Two scales of rounded puffs (Worley) on the outline at Puff size / Cauliflower puffs 1. */
  puffFreq: 2.0,
  puffAmp: 0.6,
  puff2Freq: 4.6,
  puff2Amp: 0.34,
  /** The base shape's remap above the threshold, in core units (below it is the Scrap reach dial). */
  baseRise: 0.3,
  /** Core units over which a cloud's top rises from its edge to its crown (the shadow march's height). */
  domeRise: 1.1,
  /** The cheap core's mean offset from the full one (the puffs' mean, which the cheap core leaves out). */
  cheapOffset: 0.1,
  /** Where the wisps sample the cloud they trail from: this far upwind, in cloud units. */
  wispNear: 0.12,
  wispFar: 0.3,
  /** Wisp layer depth below the deck, in thicknesses. */
  wispDrop: 0.15,
  /** Evolution speed, cloud units per second at Evolve 1 (warp; the body and clusters move at fractions). */
  evolve: 0.005,
  /** How fast the wisps stream along the wind relative to the evolution. */
  wispStream: 2.2,
  /** The sun-shadow march: sample distances toward the sun (cloud units at Shadow reach 1) and weights. Near
   * samples shade a cloud's own lumps; far ones are other clouds' shadows cast across it. */
  shadowSteps: Object.freeze([0.03, 0.07, 0.14, 0.26, 0.45]),
  shadowWeights: Object.freeze([0.6, 0.8, 1, 1, 0.9]),
});

/**
 * The full field's value at given coverage fractions — measured in the lab (`variant: 'cov'`, 3 × 480×270 px at zoom 0.25,
 * ~75 cloud units across; re-measure with `StorybookDriver.calibrate()` whenever the field's constants change): `threshold(fill)` is the field value with `fill` of the sky above it. Monotone.
 * [coverage fraction, threshold]
 */
export const STORYBOOK_CORE_QUANTILES = Object.freeze([
  [0, 1.8],
  [0.0093, 1.2],
  [0.0326, 1],
  [0.0545, 0.9],
  [0.0845, 0.8],
  [0.1244, 0.7],
  [0.1744, 0.6],
  [0.235, 0.5],
  [0.3033, 0.4],
  [0.3775, 0.3],
  [0.456, 0.2],
  [0.5388, 0.1],
  [0.6204, 0],
  [0.6976, -0.1],
  [0.7672, -0.2],
  [0.8278, -0.3],
  [0.8781, -0.4],
  [0.9454, -0.6],
  [0.9803, -0.8],
  [1, -1.4],
]);

/** The threshold that leaves `fill` of the sky covered (piecewise-linear in the measured quantiles). */
export function storybookThreshold(fill) {
  const f = clamp01(Number.isFinite(fill) ? fill : 0);
  const q = STORYBOOK_CORE_QUANTILES;
  let i = 0;
  while (i < q.length - 2 && f > q[i + 1][0]) i++;
  const t = (f - q[i][0]) / (q[i + 1][0] - q[i][0]);
  return q[i][1] + (q[i + 1][1] - q[i][1]) * clamp01(t);
}

// ---------------------------------------------------------------------------
// THE PALETTE — Crosshead's colours by the hour
// ---------------------------------------------------------------------------

/**
 * Keyframes by sun elevation, one track for the rising sun and one for the setting sun (the sun model is
 * symmetric about noon, so elevation alone cannot tell dawn from dusk — `world/sun.js#computeSun`'s `rising`).
 * Dawn leans cool (pearl, rose, lilac); dusk leans hot (apricot, coral, magenta). Shadows never go grey: they
 * go periwinkle by day, mauve at golden hour, indigo after sunset — the same cool-shadow habit the snow map's
 * lilac shadows show. Ink is a deep version of the shadow, never black. The three tones step about a quarter
 * of the value range apart (highlight ~98%, body ~80%, shadow ~58% by day) — the steps Crosshead's boulders
 * use; closer steps read as one flat white blob from a zoomed-out view.
 *
 * sRGB hex, blended in sRGB (a perceptual blend: a linear-space mix of coral into indigo goes muddy halfway)
 * and converted to linear at the end, because the tops composite into the linear scene buffer.
 */
export const STORYBOOK_PALETTE_KEYS = Object.freeze({
  rising: Object.freeze([
    { elev: -18, hi: '#8b9bc6', body: '#46527c', shadow: '#232a4c', ink: '#0e1226', rim: '#b4c4ec' },
    { elev: -9, hi: '#a8b2dc', body: '#646ea2', shadow: '#363c6c', ink: '#171932', rim: '#c8c4ec' },
    { elev: -3, hi: '#f8c8cc', body: '#be8eaf', shadow: '#625d92', ink: '#2a2442', rim: '#ffd8d0' },
    { elev: 2, hi: '#ffe2c2', body: '#ddb4b4', shadow: '#7f7ca8', ink: '#352e4e', rim: '#ffe8c6' },
    { elev: 10, hi: '#fff3e0', body: '#cbc3da', shadow: '#7f7cad', ink: '#2c2946', rim: '#fff5dc' },
    { elev: 28, hi: '#fffaf0', body: '#c4cee2', shadow: '#7d8cb6', ink: '#262d4a', rim: '#ffffff' },
  ]),
  setting: Object.freeze([
    { elev: -18, hi: '#8b9bc6', body: '#46527c', shadow: '#232a4c', ink: '#0e1226', rim: '#b4c4ec' },
    { elev: -9, hi: '#ada3d6', body: '#625f98', shadow: '#332f66', ink: '#17142e', rim: '#d8b8e0' },
    { elev: -3, hi: '#ffb08e', body: '#b77a8e', shadow: '#5a4c7c', ink: '#241833', rim: '#ffb67e' },
    { elev: 2, hi: '#ffdca0', body: '#e2ab8c', shadow: '#8a7392', ink: '#432536', rim: '#ffe28e' },
    { elev: 10, hi: '#fff1d4', body: '#dbc9b6', shadow: '#94809f', ink: '#362a40', rim: '#ffebba' },
    { elev: 28, hi: '#fffaf0', body: '#c4cee2', shadow: '#7d8cb6', ink: '#262d4a', rim: '#ffffff' },
  ]),
});

/** Storm tones, mixed in as cover/rain rise: heavy slate bodies, bruised violet undersides. */
const STORM_TONES = Object.freeze({
  hi: '#d4d8e0',
  body: '#8c93a4',
  shadow: '#464a66',
  ink: '#1a1c2e',
  rim: '#e9ecf4',
});

const PALETTE_SLOTS = Object.freeze(['hi', 'body', 'shadow', 'ink', 'rim']);

function hexToSrgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  const n = m ? parseInt(m[1], 16) : 0x808080;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth01 = (x) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * The palette for one sun and sky.
 * @param {{elevationDeg:number, rising?:boolean}} sun - `world/sun.js#computeSun`'s result (only these two read).
 * @param {{cover01?:number, precip01?:number}} [sky]
 * @returns {{hi:number[], body:number[], shadow:number[], ink:number[], rim:number[], storm01:number}} linear RGB.
 */
export function storybookPalette(sun, sky = {}) {
  const elev = Number.isFinite(sun?.elevationDeg) ? sun.elevationDeg : 30;
  const keys = sun?.rising ? STORYBOOK_PALETTE_KEYS.rising : STORYBOOK_PALETTE_KEYS.setting;
  let i = 0;
  while (i < keys.length - 2 && elev > keys[i + 1].elev) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const t = smooth01((elev - a.elev) / (b.elev - a.elev));
  const cover = clamp01(Number.isFinite(sky.cover01) ? sky.cover01 : 0);
  const precip = clamp01(Number.isFinite(sky.precip01) ? sky.precip01 : 0);
  // Storm weight: heavy cover starts to bruise the clouds, rain finishes the job. Never past 0.85 — a storm
  // cloud keeps the hour's colour in its highlights (a red storm sunset is the best sky there is).
  const storm01 = Math.min(0.85, smooth01((cover - 0.55) / 0.4) * 0.55 + precip * 0.5);
  // Night dims the storm tones with everything else: the storm keyframe is a DAY colour.
  const dayish = smooth01((elev + 6) / 14);
  const out = { storm01 };
  for (const slot of PALETTE_SLOTS) {
    const ca = hexToSrgb01(a[slot]);
    const cb = hexToSrgb01(b[slot]);
    const cs = hexToSrgb01(STORM_TONES[slot]);
    const rgb = [0, 1, 2].map((k) => {
      const hour = lerp(ca[k], cb[k], t);
      const storm = cs[k] * lerp(0.35, 1, dayish);
      // Multiply-ish storm blend in the highlights keeps their hue (see storm01's note); a straight mix below.
      const mixed =
        slot === 'hi' || slot === 'rim' ? lerp(hour, Math.min(hour, storm), storm01) : lerp(hour, storm, storm01);
      return srgbToLinear(clamp01(mixed));
    });
    out[slot] = rgb;
  }
  return out;
}

/**
 * The light the clouds are SHADED by — the sun's own bearing, its elevation held between 6° and 38°. Above 38° a
 * noon sun would light every billow flat from straight above; below 6° it would put the whole deck in shadow. In
 * between it is the REAL sun: at golden hour it rakes in low, so one side of every cloud blazes and the other falls
 * into shade, and the shadow march (see the tops) throws long shadows across neighbouring clouds. (Rounds 1-6
 * held it at 30-38°, which could never be dramatic.) After dusk the moon takes over from the opposite bearing.
 * @param {{x:number,y:number}} dirToSunXY - unit, `marchDirectionToSun` (sky-access `key.dirX/dirY`).
 * @param {number} elevationDeg
 * @returns {number[]} unit [x, y, z].
 */
export function storybookLight(dirToSunXY, elevationDeg) {
  const dx = Number.isFinite(dirToSunXY?.x) ? dirToSunXY.x : 1;
  const dy = Number.isFinite(dirToSunXY?.y) ? dirToSunXY.y : 0;
  const elev = Number.isFinite(elevationDeg) ? elevationDeg : 30;
  const night = smooth01((-3 - elev) / 8);
  const sunE = (Math.max(STORYBOOK_LIGHT_MIN_DEG, Math.min(38, elev)) * Math.PI) / 180;
  const moonE = (38 * Math.PI) / 180;
  const sx = dx * Math.cos(sunE);
  const sy = dy * Math.cos(sunE);
  const sz = Math.sin(sunE);
  const mx = -dx * Math.cos(moonE);
  const my = -dy * Math.cos(moonE);
  const mz = Math.sin(moonE);
  const v = [lerp(sx, mx, night), lerp(sy, my, night), lerp(sz, mz, night)];
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** The lowest the shading light goes (degrees). */
export const STORYBOOK_LIGHT_MIN_DEG = 6;

// ---------------------------------------------------------------------------
// COVER → HOW MUCH SKY IS CLOUD
// ---------------------------------------------------------------------------

/**
 * The share of the sky under cloud, and a size multiplier, for a cover value. Exactly 0 at cover 0 (a provable
 * no-op — the same promise `coverThreshold` makes for the realistic field). A few clouds with wide open sea
 * between them at low cover (the reference photos sit near 0.3); a crowded sky, still with gaps, near overcast.
 * @param {number} cover01
 * @returns {{fill:number, size:number}}
 */
export function storybookDensity(cover01) {
  const c = clamp01(Number.isFinite(cover01) ? cover01 : 0);
  if (c <= 0) return { fill: 0, size: 0 };
  // (Capped at 0.58: past that the decks above and below add the cover, and the main deck keeps gaps to see them —
  // at 0.7 a full sky was one white sheet with the other decks lost in it.)
  return { fill: Math.min(0.58, 0.74 * c ** 1.25), size: lerp(0.85, 1.12, smooth01(c)) };
}

// ---------------------------------------------------------------------------
// THE DECK, PER FRAME (CPU)
// ---------------------------------------------------------------------------

/** The Cloud Tops card's storybook dials, defaults (mirrors `cloud-tops.js`'s schema). */
export const STORYBOOK_DECK_DEFAULTS = Object.freeze({
  // Layer
  storybookSize: 1.15,
  storybookSpacing: 0.48,
  storybookHeight: 0.12,
  storybookBulge: 0.5,
  storybookEvolve: 1,
  storybookShadowDensity: 0.85,
  // Shape
  storybookCluster: 1.1,
  storybookWarp: 0.15,
  storybookShapeDetail: 1,
  storybookPuffs: 1,
  storybookPuffSize: 1,
  // Edges & scraps
  storybookErosion: 0.42,
  storybookScrapReach: 0.2,
  storybookScrapThinning: 1.15,
  storybookScrapSoftness: 0.3,
  storybookFraySize: 1,
  storybookSwirl: 0.12,
  storybookEdgeDensity: 3.2,
  storybookBreakup: 0.75,
  // Mist & wisps
  storybookMist: 0.1,
  storybookTails: 1,
  // Light
  storybookAbsorb: 1.1,
  storybookPowder: 0.55,
  storybookGlow: 1,
  storybookSelfShadow: 1,
  storybookDepth: 3,
  storybookShadowReach: 1,
  storybookAmbient: 1,
  storybookContrast: 1,
  storybookBrush: 0.5,
  // Golden hour
  storybookDrama: 1,
  storybookLitSide: 1,
  storybookShadeSide: 1,
  storybookRim: 0.45,
  // Layers
  storybookLowHeight: 0.55,
  storybookLowSize: 0.6,
  storybookLowPace: 0.75,
  storybookLowAmount: 0.6,
  storybookLowOpacity: 1,
  storybookLowShear: -10,
  storybookHighHeight: 1.45,
  storybookHighSize: 0.75,
  storybookHighPace: 1.6,
  storybookHighAmount: 0.6,
  storybookHighOpacity: 1,
  storybookHighShear: 18,
});

/**
 * Everything the storybook uniforms need for one frame. Pure: the viewer calls it once per frame, the tests
 * call it directly.
 *
 * @param {object} a
 * @param {number} a.cover01
 * @param {number} a.scalePx - the weather preset's own cloud scale; nudges the cloud size gently.
 * @param {number} [a.anisotropy] - the active recipe's along-wind stretch (cirrus ≈ 4): elongates clouds.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} a.board - the scene rect.
 * @param {boolean} a.tableOn
 * @param {number} a.eyeHeight - the scene eye's height (world px).
 * @param {object} [a.params] - the card's resolved params (missing keys take {@link STORYBOOK_DECK_DEFAULTS}).
 */
export function resolveStorybookDeck({ cover01, scalePx, anisotropy = 1, board, tableOn, eyeHeight, params = {} }) {
  const p = (k) => (Number.isFinite(params?.[k]) ? params[k] : STORYBOOK_DECK_DEFAULTS[k]);
  const w = Math.max(1, (board?.maxX ?? 1) - (board?.minX ?? 0));
  const h = Math.max(1, (board?.maxY ?? 1) - (board?.minY ?? 0));
  const side = Math.min(w, h);
  const scaleNudge = Math.max(
    0.75,
    Math.min(1.4, ((Number.isFinite(scalePx) && scalePx > 0 ? scalePx : 1100) / 1100) ** 0.25)
  );
  const { fill, size } = storybookDensity(cover01);
  // The cloud scale: Size sets it (one cloud unit ≈ a large cloud's width).
  const spacing = Math.max(
    120,
    0.22 * side * scaleNudge * Math.max(0.2, p('storybookSize')) * Math.max(0.5, size || 1)
  );
  // Thickness of a full cloud (world px): the relief cast and the light read it.
  const radius = spacing * 0.32;
  const H = Math.max(1, Number.isFinite(eyeHeight) ? eyeHeight : 4 * side);
  // The highest top (dome + a full cloud's thickness) stays under 82% of the eye.
  let base = Math.max(0, p('storybookHeight')) * H;
  let dome = Math.max(0, p('storybookBulge')) * 0.36 * H;
  const ceiling = 0.82 * H;
  if (base + dome + radius > ceiling) {
    const k = Math.max(0, ceiling - radius) / Math.max(1, base + dome);
    base *= k;
    dome *= k;
  }
  const cx = ((board?.minX ?? 0) + (board?.maxX ?? w)) / 2;
  const cy = ((board?.minY ?? 0) + (board?.maxY ?? h)) / 2;
  const pad = 0;
  const elong = Math.max(0, Math.min(1.4, ((Number.isFinite(anisotropy) ? anisotropy : 1) - 1) * 0.4));
  return {
    spacing,
    radius,
    fill,
    threshold: fill > 0 ? storybookThreshold(fill) : 9,
    // Spacing now sets the GAPS: the cluster noise's frequency (a bigger Spacing = bigger crowds and bigger
    // open stretches between them).
    clusterFreq: (0.16 * 0.48) / Math.max(0.05, p('storybookSpacing')),
    elong,
    baseHeight: base,
    domeHeight: dome,
    domeCentre: [cx, cy],
    domeRadius: 0.5 * Math.hypot(w, h) * 1.1,
    // (0.18 squeezed clouds at the view's edge into vertical drips; the dome carries most of the bulge.)
    lens: Math.max(0, p('storybookBulge')) * 0.09,
    domain: [(board?.minX ?? 0) - pad, (board?.minY ?? 0) - pad, (board?.maxX ?? w) + pad, (board?.maxY ?? h) + pad],
    domainFade: 1,
    clipToBoard: !tableOn,
    brush: Math.max(0, p('storybookBrush')),
    shadowDensity: Math.max(0, p('storybookShadowDensity')),
    tails: Math.max(0, p('storybookTails')),
    evolve: Math.max(0, p('storybookEvolve')),
    // The look dials, packed as the shader reads them (see `createStorybookUniforms`).
    shape: [p('storybookCluster'), p('storybookWarp'), p('storybookShapeDetail'), p('storybookPuffs')].map((v) =>
      Math.max(0, v)
    ),
    shape2: [p('storybookPuffSize'), p('storybookSwirl'), p('storybookFraySize'), p('storybookBreakup')].map((v) =>
      Math.max(0, v)
    ),
    edge: [
      p('storybookErosion'),
      p('storybookScrapThinning'),
      p('storybookScrapReach'),
      p('storybookScrapSoftness'),
    ].map((v) => Math.max(0, v)),
    light1: [p('storybookAbsorb'), p('storybookPowder'), p('storybookGlow'), p('storybookSelfShadow')].map((v) =>
      Math.max(0, v)
    ),
    light2: [p('storybookShadowReach'), p('storybookDrama'), p('storybookLitSide'), p('storybookShadeSide')].map((v) =>
      Math.max(0, v)
    ),
    light3: [p('storybookAmbient'), p('storybookRim'), p('storybookContrast'), p('storybookMist')].map((v) =>
      Math.max(0, v)
    ),
    edgeDensity: Math.max(0.05, p('storybookEdgeDensity')),
    depth: Math.max(0.1, p('storybookDepth')),
    layLow: [p('storybookLowHeight'), p('storybookLowSize'), p('storybookLowPace'), p('storybookLowAmount')].map((v) =>
      Math.max(0, v)
    ),
    layHigh: [p('storybookHighHeight'), p('storybookHighSize'), p('storybookHighPace'), p('storybookHighAmount')].map(
      (v) => Math.max(0, v)
    ),
    layOp: [
      Math.max(0, p('storybookLowOpacity')),
      Math.max(0, p('storybookHighOpacity')),
      (p('storybookLowShear') * Math.PI) / 180,
      (p('storybookHighShear') * Math.PI) / 180,
    ],
    // Decks drawn: the main one alone when both others are switched off (Amount or Opacity 0), else all three.
    layers:
      (p('storybookLowAmount') > 0 && p('storybookLowOpacity') > 0) ||
      (p('storybookHighAmount') > 0 && p('storybookHighOpacity') > 0)
        ? 3
        : 1,
    cover: Math.max(0, Math.min(1, Number.isFinite(cover01) ? cover01 : 0)),
  };
}

// ---------------------------------------------------------------------------
// UNIFORMS
// ---------------------------------------------------------------------------

/**
 * The storybook deck's uniforms. Drift and wind direction are NOT here: they are the shared cloud field's own
 * (`world/cloud-field.js#createCloudUniforms`'s `drift`/`windDir`), so the deck drifts with exactly the wind and
 * speed the realistic one would.
 * @param {object} TSL
 */
export function createStorybookUniforms(TSL) {
  const { uniform, vec2, vec3, vec4, float } = TSL;
  return {
    /** spacing (cloud scale, world px), thickness (world px), fill, elong */
    deck: uniform(vec4(3000, 900, 0, 0)),
    /** baseHeight, domeHeight, domeRadius, time (s) */
    deck2: uniform(vec4(1500, 1500, 5000, 0)),
    /** threshold, evolve (dial), cluster frequency, unused */
    field: uniform(vec4(9, 1, 0.3, 0)),
    domeCentre: uniform(vec2(0, 0)),
    /** minX, minY, maxX, maxY (kept for the viewer; the field has no edge) */
    domain: uniform(vec4(-1e9, -1e9, 1e9, 1e9)),
    /** domainFade (px, unused), clipToBoard (0/1), shadowDensity, cover01 */
    domain2: uniform(vec4(1, 0, 0.85, 0)),
    board: uniform(vec4(-1e9, -1e9, 1e9, 1e9)),
    eye: uniform(vec3(0, 0, 10000)),
    light: uniform(vec3(0.5, 0.3, 0.8)),
    /** edge density (opacity per unit density), cloud depth (light), unused x2 */
    style: uniform(vec4(3.2, 3, 0, 0)),
    /** THE LOOK DIALS (round 7): cluster, twist, shape detail, puffs */
    shape: uniform(vec4(1.1, 0.15, 1, 1)),
    /** puff size, swirl, fray size, inner break-up */
    shape2: uniform(vec4(1, 0.12, 1, 0.75)),
    /** erosion, scrap thinning, scrap reach, scrap softness */
    edge: uniform(vec4(0.42, 1.15, 0.2, 0.3)),
    /** absorption, powder, inner glow, self-shadow */
    light1: uniform(vec4(1.1, 0.55, 1, 1)),
    /** shadow reach, golden-hour drama, sunlit side, shade side */
    light2: uniform(vec4(1, 1, 1, 1)),
    /** ambient, silver lining, contrast, mist */
    light3: uniform(vec4(1, 0.45, 1, 0.1)),
    /** LAYERS (round 8). Low deck: height (× the main deck's), cloud scale, pace, amount */
    layLow: uniform(vec4(0.55, 0.6, 0.75, 0.6)),
    /** High deck: height, cloud scale, pace, amount */
    layHigh: uniform(vec4(1.45, 0.75, 1.6, 0.6)),
    /** low opacity, high opacity, low bearing (rad), high bearing (rad) */
    layOp: uniform(vec4(0.9, 0.8, -0.17, 0.31)),
    /** deck count (1 = main only, 3 = all), unused x3 — a uniform so the loop is never unrolled */
    layOn: uniform(vec4(3, 0, 0, 0)),
    /** brush, footprint (world px per screen px), fisheye lens, tails (wisp amount) */
    style2: uniform(vec4(1, 4, 0, 1)),
    hi: uniform(vec3(1, 0.98, 0.94)),
    body: uniform(vec3(0.76, 0.8, 0.86)),
    shadow: uniform(vec3(0.33, 0.39, 0.56)),
    ink: uniform(vec3(0.04, 0.06, 0.12)),
    rim: uniform(vec3(1, 1, 1)),
    opacity: uniform(float(1)),
  };
}

/**
 * Push one frame. `deck` is {@link resolveStorybookDeck}'s result; `palette` {@link storybookPalette}'s.
 * @param {object} u @param {object} a
 */
export function pushStorybookUniforms(u, { deck, palette, light, eye, board, footprintPx, timeSec = 0, evolve }) {
  u.deck.value.set(deck.spacing, deck.radius, deck.fill, deck.elong);
  u.deck2.value.set(deck.baseHeight, deck.domeHeight, deck.domeRadius, timeSec);
  u.field.value.set(
    deck.threshold ?? 9,
    Number.isFinite(evolve) ? evolve : (deck.evolve ?? 1),
    deck.clusterFreq ?? 0.3,
    0
  );
  u.domeCentre.value.set(deck.domeCentre[0], deck.domeCentre[1]);
  u.domain.value.set(...deck.domain);
  u.domain2.value.set(deck.domainFade, deck.clipToBoard ? 1 : 0, deck.shadowDensity, deck.cover ?? 0);
  if (board) u.board.value.set(board.minX, board.minY, board.maxX, board.maxY);
  if (eye) u.eye.value.set(eye.x, eye.y, Math.max(1, eye.height));
  if (light) u.light.value.set(light[0], light[1], light[2]);
  u.style.value.set(deck.edgeDensity ?? 3.2, deck.depth ?? 3, 0, 0);
  for (const k of ['shape', 'shape2', 'edge', 'light1', 'light2', 'light3', 'layLow', 'layHigh', 'layOp']) {
    if (deck[k]) u[k].value.set(...deck[k]);
  }
  u.layOn.value.set(deck.layers ?? 3, 0, 0, 0);
  u.style2.value.set(deck.brush, Math.max(1e-3, footprintPx || 1), deck.lens ?? 0, deck.tails ?? 1);
  if (palette) {
    u.hi.value.set(...palette.hi);
    u.body.value.set(...palette.body);
    u.shadow.value.set(...palette.shadow);
    u.ink.value.set(...palette.ink);
    u.rim.value.set(...palette.rim);
  }
}

// ---------------------------------------------------------------------------
// THE FIELD (TSL) — shared by the tops and the shadow
// ---------------------------------------------------------------------------

/**
 * The cumulus field at world point `P` (on the deck), as nodes.
 * @param {object} TSL
 * @param {object} u
 * @param {{drift:*, dir:*, S?:*, thr?:*, seed?:*, pace?:*}} wind - the layer: its drift and wind direction, and
 *   optionally its own cloud scale, threshold, seed and evolve pace (the main layer leaves them to the uniforms).
 * @param {*} P - vec2 node, world px.
 * @param {{billows?:boolean, octaves?:number}} [o] - a cheap core (no billows, one octave) for scouting and the
 *   wisps' upwind samples; its mean sits `STORYBOOK_FIELD.cheapOffset` below the full one.
 * @returns {{core:*, cells:*, cluster:*}}
 */
function coreAt(TSL, u, wind, P, { billows = true, octaves = 2 } = {}) {
  const { float, vec2, dot, max, mx_noise_float, mx_fractal_noise_float, mx_worley_noise_float } = TSL;
  const F = STORYBOOK_FIELD;
  const S = wind.S ?? u.deck.x;
  const q0 = P.sub(wind.drift)
    .div(S)
    .add(wind.seed ? vec2(wind.seed.mul(37.1), wind.seed.mul(-23.7)) : vec2(0, 0));
  // Long clouds (the cirrus-ish recipes): squash along the wind. A projection, not a rotation, so a wind that
  // swings never swings the whole sky about the origin (at elong 0 it is exactly q0).
  const a = wind.dir;
  const q = q0.sub(a.mul(dot(q0, a).mul(u.deck.w.div(float(1).add(u.deck.w)))));
  const tau = u.deck2.w
    .mul(u.field.y)
    .mul(F.evolve)
    .mul(wind.pace ?? float(1));
  const ev = vec2(tau, tau.mul(-0.7));
  // CLUSTERS: crowded sky here, open sea there.
  const cluster = mx_noise_float(q.mul(u.field.z).add(vec2(3.1, 7.3)).add(ev.mul(0.35)));
  // WARP, evolving: the lumps bulge, pinch, merge and split.
  const qw = q.mul(F.warpFreq).add(ev);
  const w = vec2(mx_noise_float(qw.add(vec2(11.7, 2.3))), mx_noise_float(qw.add(vec2(5.9, 17.1))));
  const qb = q.add(w.mul(u.shape.y));
  const body = mx_fractal_noise_float(qb.mul(u.shape.z.mul(F.bodyFreq)).add(ev.mul(0.6)), octaves, 2.07, 0.5, 1);
  let core = body.add(cluster.mul(u.shape.x));
  if (billows) {
    // PUFFS: rounded lumps at two scales on the outline — high on a Worley feature point, low in the crease.
    const pf = u.shape2.x.div(max(u.shape.z, float(0.2))).mul(u.shape.z);
    const c1 = mx_worley_noise_float(qb.mul(pf.mul(F.puffFreq)).sub(ev.mul(1.4)));
    const c2 = mx_worley_noise_float(qb.mul(pf.mul(F.puff2Freq)).add(vec2(4.1, 9.3)).sub(ev.mul(2.1)));
    core = core
      .add(float(1).sub(c1.mul(c1)).sub(0.75).mul(u.shape.w.mul(F.puffAmp)))
      .add(float(1).sub(c2.mul(c2)).sub(0.75).mul(u.shape.w.mul(F.puff2Amp)));
  } else {
    core = core.add(float(F.cheapOffset));
  }
  return { core, cluster, qb, w, ev, thr: wind.thr ?? u.field.x };
}

/**
 * EROSION DETAIL (round 6, after Schneider's *Real-time Volumetric Cloudscapes of Horizon Zero Dawn*, SIGGRAPH
 * 2015): three octaves of INVERTED Worley (packed billows), its coordinates swirled by the same warp that shapes
 * the cloud (Schneider swirls his with curl noise). Never added to a cloud — SUBTRACTED from its edges (see
 * `densityOf`), so the edge frays into tufts and wisps while the core stays whole. ~0..1.
 */
function detailAt(TSL, u, c, lite = false) {
  const { float, vec2, mx_worley_noise_float } = TSL;
  const qd = c.qb.add(c.w.mul(u.shape2.y));
  const f = u.shape2.z.mul(9);
  const w1 = mx_worley_noise_float(qd.mul(f).sub(c.ev.mul(2.0)));
  if (lite) {
    // The side decks: one Worley and one Perlin octave (the full six tripled the shader: 85 s to compile).
    const perL = TSL.mx_noise_float(qd.mul(f.mul(0.7)).add(vec2(9.1, 3.3)))
      .mul(0.5)
      .add(0.5);
    return TSL.clamp(perL.mul(0.55).add(float(1).sub(w1).mul(0.45)), 0, 1);
  }
  const w2 = mx_worley_noise_float(qd.mul(f.mul(2.03)).add(vec2(5.3, 1.7)).sub(c.ev.mul(3.1)));
  const w3 = mx_worley_noise_float(qd.mul(f.mul(4.11)).add(vec2(2.2, 8.8)).sub(c.ev.mul(4.3)));
  const wor = float(1).sub(w1).mul(0.625).add(float(1).sub(w2).mul(0.25)).add(float(1).sub(w3).mul(0.125));
  // PERLIN-WORLEY (Schneider): Perlin keeps it connected, Worley adds the billows. Worley alone read as cobblestones.
  const per = TSL.mx_fractal_noise_float(qd.mul(f.mul(0.7)).add(vec2(9.1, 3.3)), 3, 2.1, 0.5, 1)
    .mul(0.5)
    .add(0.5);
  return TSL.clamp(per.mul(0.55).add(wor.mul(0.45)), 0, 1);
}

/** Schneider's remap: `v` from [lo, hi] onto [0, 1], clamped. */
function remap01(TSL, v, lo, hi) {
  return TSL.clamp(v.sub(lo).div(TSL.max(hi.sub(lo), TSL.float(1e-4))), 0, 1);
}

/** The base shape 0..1 from a core value: 0 at Scrap reach below the threshold, 1 a little above it. */
function baseOf(TSL, u, core, thr = u.field.x) {
  return remap01(TSL, core, thr.sub(u.edge.z), thr.add(STORYBOOK_FIELD.baseRise));
}

/** A cloud's TOP HEIGHT 0..1 (of its thickness) from a core value: a broad dome rising over ~1 core unit, for the
 * shadow march. (`baseOf` saturates a short way inside every edge, so a march on it saw flat-topped plateaus that
 * could never shade themselves — round 7's first golden hour came out flat salmon.) */
function heightOf(TSL, u, core, thr = u.field.x) {
  return remap01(TSL, core, thr.sub(u.edge.z), thr.add(STORYBOOK_FIELD.domeRise));
}

/**
 * DENSITY 0..1 at a field sample: the base shape remapped above the threshold, then ERODED by the detail —
 * `remap(base, detail·E, 1)`. Where the base is thick the erosion barely touches it; where it thins toward the
 * edge the detail eats it into tufts. At the thinnest the detail is used INVERTED (Schneider: "If you invert the
 * Worley noise at the base of the clouds you get some nice whispy shapes").
 */
function densityOf(TSL, u, c, detail, tuft) {
  const { float, mix } = TSL;
  const base = baseOf(TSL, u, c.core, c.thr);
  // In the thin skirt the contrast-stretched tufts erode it, so whole scraps survive (the soft detail there ate
  // the skirt evenly away and left no fragments).
  const body = TSL.smoothstep(float(0.35), float(0.6), base);
  const d = mix(float(1).sub(tuft), detail, body);
  // The erosion DEEPENS with distance from the cloud (author, round 6: fragments "need to start thick near their
  // parent clouds and then quickly become more sparse"): deep in the body only the shallowest bites; out in the
  // thin skirt only the strongest billows survive, as scraps. One continuous density — a separate fragment band
  // left a seam (a ring of nothing) between a cloud and its scraps.
  const reach = TSL.smoothstep(float(0), float(0.75), base);
  const depth = mix(u.edge.y, u.edge.x, reach);
  const e = d.mul(depth);
  // A scrap that survives is a whole small cloud, not a ghost: in the skirt the density ramps to full over a short
  // span above the erosion (to 1 it left every scrap a faint 15% smudge; over 0.12 it cut them out crisp).
  return remap01(TSL, base, e, mix(e.add(u.edge.w.max(0.02)), float(1), body));
}

/**
 * LAYERS (round 8, author: *"introduce layers of clouds at different heights ... improve the look at high 'Cloud'
 * values and add some parallax to the camera movement and some different paces"*). Three decks — LOW (0), MAIN
 * (1), HIGH (2) — each its own height (so each slides at its own rate as the view pans: real parallax), cloud
 * scale, wind pace and bearing (wind shear: the high deck runs faster and veers), seed, and share of the cover
 * (a deck's threshold sits above the main one's, and comes down as cover rises). The main deck is exactly the
 * single deck of rounds 1-7.
 * @param {object} TSL @param {object} u @param {{drift:*, dir:*}} wind @param {*} lf - float node, 0/1/2.
 */
function layerOf(TSL, u, wind, lf) {
  const { float, vec2, select, mix, clamp, cos, sin } = TSL;
  const isLow = lf.lessThan(float(0.5));
  const isHigh = lf.greaterThan(float(1.5));
  const pick = (lo, hi, main) => select(isLow, lo, select(isHigh, hi, float(main)));
  const hMul = pick(u.layLow.x, u.layHigh.x, 1);
  const sMul = pick(u.layLow.y, u.layHigh.y, 1);
  const pace = pick(u.layLow.z, u.layHigh.z, 1);
  const amount = pick(u.layLow.w, u.layHigh.w, 1);
  const opacity = pick(u.layOp.x, u.layOp.y, 1);
  const ang = pick(u.layOp.z, u.layOp.w, 0);
  // Its own pace and bearing: the shared drift, scaled and turned (shear between decks).
  const dr = wind.drift.mul(pace);
  const ca = cos(ang);
  const sa = sin(ang);
  const drift = vec2(dr.x.mul(ca).sub(dr.y.mul(sa)), dr.x.mul(sa).add(dr.y.mul(ca)));
  // Its share of the cover: a deck at Amount 1 matches the main deck at full cover and thins away below it.
  const cover = u.domain2.w;
  const off = mix(float(1.3), float(0.12), clamp(cover.mul(amount), 0, 1)).mul(
    select(isLow.or(isHigh), float(1), float(0))
  );
  return {
    drift,
    dir: wind.dir,
    S: u.deck.x.mul(sMul),
    thr: u.field.x.add(off),
    seed: lf,
    pace,
    hMul,
    opacity: opacity.mul(select(amount.greaterThan(float(0.001)), float(1), float(0))),
    isMain: lf.greaterThan(float(0.5)).and(lf.lessThan(float(1.5))),
  };
}

/**
 * The lit storybook cloud tops for one ground pixel.
 *
 * @param {object} TSL
 * @param {object} args
 * @param {*} args.groundXY - vec2 node, the ground point under this pixel (`positionWorld.xy` on the tops quad).
 * @param {object} args.u - {@link createStorybookUniforms}.
 * @param {{drift:*, dir:*}} args.wind - the shared cloud field's `drift` (vec2, world px) and `windDir` (unit vec2).
 * @param {*} [args.visibility] - float node multiplied into alpha (e.g. the floors-above gate).
 * @param {number[]} [args.decks] - which decks this material draws (0 low, 1 main + its wisps, 2 high); default
 *   all three. The viewer gives each deck its OWN material (three small shaders compile far faster than one big
 *   one — FXC's cost grows faster than the shader), drawn low → main → high so they composite in order.
 * @returns {{rgb:*, alpha:*}} rgb is straight (not premultiplied); composite with NormalBlending.
 */
export function buildStorybookCloudNode(
  TSL,
  { groundXY, u, wind, visibility = null, debug = null, layered = true, decks = null }
) {
  const { Fn, If, float, vec2, vec3, max, min, clamp, smoothstep, mix, normalize, dot, length, step } = TSL;
  const { mx_fractal_noise_float, mx_noise_float } = TSL;
  const F = STORYBOOK_FIELD;
  const out = Fn(() => {
    // THE FISHEYE: a barrel warp of the deck about the view centre, on top of the world dome below.
    const fromEye = groundXY.sub(u.eye.xy);
    const r2 = dot(fromEye, fromEye).div(max(u.eye.z.mul(u.eye.z).mul(0.25), float(1)));
    const lensXY = u.eye.xy.add(fromEye.mul(float(1).add(u.style2.z.mul(r2)))).toVar('sbLens');
    const G = vec3(lensXY.x, lensXY.y, float(0));
    const D = normalize(u.eye.sub(G)).toVar('sbD');
    const invDz = float(1)
      .div(max(D.z, float(0.05)))
      .toVar('sbInvDz');
    const at = (z) => lensXY.add(D.xy.mul(z.mul(invDz)));
    const zDeck = storybookDeckHeightNode(TSL, {
      xy: lensXY,
      base: u.deck2.x,
      dome: u.deck2.y,
      centre: u.domeCentre,
      radius: u.deck2.z,
    }).toVar('sbZ');
    const S = u.deck.x;
    const T = u.deck.y;
    const thr = u.field.x;
    const L = u.light;
    const lLen = max(length(L.xy), float(1e-3));
    const lxy = L.xy.div(lLen);

    // ── THE WISPS (back layer) — the field's thin, wind-torn edge ─────────────
    // (Built only into the material that draws the main deck — the wisps belong to it.)
    const wisps = () => {
      const zW = zDeck.sub(T.mul(F.wispDrop)).max(float(0));
      const Pw = at(zW).toVar('sbPw');
      const a = wind.dir;
      const thrC = thr;
      const g1 = coreAt(TSL, u, wind, Pw.add(a.mul(S.mul(F.wispNear))), { billows: false, octaves: 1 }).core;
      const g2 = coreAt(TSL, u, wind, Pw.add(a.mul(S.mul(F.wispFar))), { billows: false, octaves: 1 }).core;
      const g0 = coreAt(TSL, u, wind, Pw, { billows: false, octaves: 1 }).core;
      const halo = max(
        max(smoothstep(thrC.sub(0.14), thrC.add(0.02), g0), smoothstep(thrC.sub(0.16), thrC.add(0.04), g1).mul(0.8)),
        smoothstep(thrC.sub(0.16), thrC.add(0.04), g2).mul(0.5)
      );
      // Streaks in the wind's own frame, streaming along it faster than the clouds drift.
      const qw = Pw.sub(wind.drift).div(S);
      const across = dot(qw, vec2(a.y.negate(), a.x));
      const along = dot(qw, a).add(u.deck2.w.mul(u.field.y).mul(F.evolve * F.wispStream));
      const st = mx_fractal_noise_float(vec2(along.mul(0.6), across.mul(2.2)), 2, 2.1, 0.5, 1);
      const wispA = halo
        .mul(smoothstep(float(-0.2), float(0.45), st))
        .mul(clamp(u.style2.w, 0, 2))
        .mul(0.26)
        .clamp(0, 1);
      const wispC = mix(u.body, u.hi, float(0.35));
      return { wispA, wispC };
    };

    // ── THE CLOUDS — three decks, back to front (low, main, high), each a density field lit like a volume ──
    // Straight-line, NOT a Loop over decks: a uniform-bound loop around this body took 84 s to compile in the lab
    // (2026-11-03) against ~17 s for one deck; three straight-line decks, the side two lit by a lighter march, cost
    // a fraction of that. Each deck is skipped at run time when it is off or this pixel is clear sky.
    const accC = vec3(0, 0, 0).toVar('sbAccC');
    const accA = float(0).toVar('sbAccA');
    const dbg = vec3(0, 0, 0).toVar('sbDbg');
    const tanE = L.z.div(lLen);
    // GOLDEN-HOUR DRAMA: 0 with the sun above ~30°, 1 below ~10° (scaled by the dial). It lengthens the shadow
    // march and pushes the lit and shaded sides apart.
    const drama = float(1)
      .sub(smoothstep(float(0.17), float(0.5), L.z))
      .mul(u.light2.y)
      .toVar('sbDrama');
    const shadeDeck = (li, full) => {
      const lf = float(li);
      const lay = layerOf(TSL, u, wind, lf);
      const Sl = lay.S;
      const thrL = lay.thr;
      const Tl = T.mul(lay.S.div(S));
      // Its own height: higher decks sit nearer the eye, so they swell and slide faster as the view pans.
      const zL = min(zDeck.mul(lay.hMul), u.eye.z.mul(0.82)).toVar(`sbZL${li}`);
      const P0 = at(zL).toVar(`sbP0${li}`);
      const scoutC = coreAt(TSL, u, lay, P0, { billows: false, octaves: 1 });
      const scout = scoutC.core.toVar(`sbScout${li}`);
      const coreC = vec3(0, 0, 0).toVar(`sbCoreC${li}`);
      const coreA = float(0).toVar(`sbCoreA${li}`);
      If(
        scout
          .greaterThan(thrL.sub(0.6))
          .and(lay.opacity.greaterThan(float(0.001)))
          .and(u.layOn.x.greaterThan(float(li === 1 ? -1 : 1.5))),
        () => {
          // The side decks are drawn from the scout's own cheap field (one octave, no puffs; the lite erosion detail
          // frays its outline), one shadow step, no facing sample: three full-quality decks took 85 s to compile
          // in the lab, and FXC's cost grows faster than the shader does.
          const c1 = full ? coreAt(TSL, u, lay, P0) : scoutC;
          const detail = detailAt(TSL, u, c1, !full);
          // Contrast-stretched copy for the INSIDE and the light (the raw mix sits in ~0.4..0.7, too flat to break a
          // cloud's inside up); the raw one erodes the body's edge (stretched, it cut a flat camouflage print), the
          // stretched one only the thin skirt beyond it, into scraps.
          const tuft = smoothstep(float(0.3), float(0.75), detail);
          const dens = densityOf(TSL, u, c1, detail, tuft).toVar(`sbDens${li}`);
          // The INSIDE breaks up too (Inner break-up): the same billows ride across the whole cloud as density, so
          // light and powder find tufts everywhere (author: "inside ... more painterly fluffy broken up").
          const brk = u.shape2.w;
          dens.assign(dens.mul(tuft.mul(brk).add(float(1.2).sub(brk))).clamp(0, 1));
          // MIST: a diffuse, undefined veil round and between the clouds (thin enough to see the ground through).
          const mist = smoothstep(thrL.sub(0.5), thrL.add(0.15), c1.core).mul(detail.mul(0.5).add(0.5)).mul(u.light3.w);

          // ── LIGHT ────────────────────────────────────────────────────────────
          // THE SHADOW MARCH (2.5-D): step toward the sun; at each step the sun's ray has risen by
          // distance·tan(elev) above this cloud's top; anything there standing TALLER than the ray blocks it. Near
          // steps catch a cloud's own billows (self-shadow), far steps its neighbours (cascaded shadows). A low sun
          // climbs slowly, so its shadows reach far — the long dramatic shadows of dusk and dawn.
          // Measured on the SAME cheap field as the samples (the full field's puffs sit higher on average, so a
          // cloud's own top always cleared its sunward samples and nothing ever shaded).
          const h0 = heightOf(TSL, u, scout, thrL);
          // Cloud depth: how tall the clouds stand in the light (a taller dome shades more of its own far side).
          const Td = Tl.mul(u.style.y);
          const top0 = h0.mul(Td);
          const reach = Sl.mul(u.light2.x).mul(float(1).add(drama.mul(1.5)));
          const occ = float(0).toVar(`sbOcc${li}`);
          // The side decks march two steps (their own lumps, and one neighbour), the main deck all five.
          const steps = full ? F.shadowSteps.map((k, i) => [k, F.shadowWeights[i]]) : [[0.12, 3]];
          let firstB = null;
          steps.forEach(([k, wgt]) => {
            const d = reach.mul(k);
            const b = heightOf(
              TSL,
              u,
              coreAt(TSL, u, lay, P0.add(lxy.mul(d)), { billows: false, octaves: 1 }).core,
              thrL
            );
            if (!firstB) firstB = b;
            const ray = top0.add(d.mul(tanE));
            occ.assign(occ.add(smoothstep(ray.sub(Td.mul(0.02)), ray.add(Td.mul(0.12)), b.mul(Td)).mul(wgt)));
          });
          // THE DECK ABOVE shades this one: where this point's ray to the sun crosses the next deck up, is there
          // cloud? (The low deck lies in the main deck's shadow, the main deck in the high deck's.)
          if (li < 2) {
            const up = layerOf(TSL, u, wind, float(li + 1));
            const zUp = min(zDeck.mul(up.hMul), u.eye.z.mul(0.82));
            const run = zUp
              .sub(zL)
              .max(float(0))
              .div(max(tanE, float(0.08)))
              .min(Sl.mul(3));
            const above = coreAt(TSL, u, up, at(zUp).add(lxy.mul(run)), { billows: false, octaves: 1 }).core;
            occ.assign(occ.add(smoothstep(up.thr.sub(0.05), up.thr.add(0.35), above).mul(up.opacity).mul(1.6)));
          }
          // Which way this bit of cloud faces: thinner toward the sun = its sunward flank (blazes at golden hour).
          // (The side decks reuse their first march sample: one field evaluation fewer.)
          const b1 = full
            ? heightOf(
                TSL,
                u,
                coreAt(TSL, u, lay, P0.add(lxy.mul(Sl.mul(0.12))), { billows: false, octaves: 1 }).core,
                thrL
              )
            : firstB;
          const facing = clamp(h0.sub(b1).mul(5), -1, 1);
          if (debug && li === 1) dbg.assign(vec3(occ.div(4), facing.mul(0.5).add(0.5), h0));
          const depth = occ
            .mul(u.light1.w)
            .mul(u.light1.x)
            .add(dens.mul(0.4))
            .add(float(1).sub(tuft).mul(1.2).mul(brk.div(0.75)));
          // MULTIPLE SCATTERING, approximated by octaves (Wrenninge; skygl, Nubis): each octave lets light through
          // more easily at half the energy, so thick cloud glows softly from inside instead of going flat grey.
          // (A low sun lets less light wander round inside: the shade side must be able to go properly deep.)
          const glow = u.light1.z.mul(float(1).sub(drama.mul(0.35)).max(0.2));
          const beer = TSL.exp(depth.negate())
            .add(TSL.exp(depth.mul(-0.4)).mul(glow.mul(0.5)))
            .add(TSL.exp(depth.mul(-0.16)).mul(glow.mul(0.25)))
            .div(glow.mul(0.75).add(1));
          // POWDER: the edges facing the light lose energy, the dense middle gathers it.
          const powder = float(1).sub(TSL.exp(dens.mul(-2.2)));
          const sunRaw = beer.mul(mix(float(1), powder, u.light1.y));
          // The sunward flank blazes, more so the lower the sun.
          const sunLit = sunRaw.mul(float(1).add(facing.max(0).mul(u.light2.z).mul(drama.mul(0.9).add(0.15))));
          // Contrast about the middle tone.
          const sun = clamp(sunLit.sub(0.5).mul(u.light3.z).add(0.5), 0, 1.4);
          // Ambient: the shade tone in thin cloud, the body tone where it is thick; the Ambient dial lifts or sinks it.
          const ambBase = mix(mix(u.body, u.shadow, float(0.25)), u.body, smoothstep(float(0), float(0.8), dens));
          const ambK = u.light3.x;
          const amb0 = mix(u.shadow, ambBase, clamp(ambK, 0, 1)).mul(max(ambK, float(1)));
          // THE SPLIT (golden hour): the march's own shadow decides the shade side directly — the side away from a
          // low sun, and every cloud lying in a taller neighbour's (or a higher deck's) shadow — and it sinks into
          // the cool shadow tone.
          const occN = clamp(occ.div(2.5), 0, 1);
          const shadeK = clamp(occN.mul(drama.add(0.25)).mul(u.light2.w).mul(1.1), 0, 0.92);
          const amb = mix(amb0, u.shadow.mul(0.8), shadeK);
          const col = mix(amb, u.hi, smoothstep(float(0.05), float(1.0), sun)).toVar(`sbCol${li}`);
          col.assign(mix(col, u.shadow.mul(0.72), shadeK.mul(0.75)));
          // ...and the flank facing the sun, out of every shadow, blazes in the hour's warm light.
          const blaze = facing.max(0).mul(float(1).sub(occN)).mul(u.light2.z).mul(drama).mul(0.55);
          col.assign(mix(col, u.rim.mul(1.12), clamp(blaze, 0, 0.85)));
          // SILVER LINING: thin cloud on the sunward flank, backlit — strongest in a low sun.
          const lining = float(1)
            .sub(smoothstep(float(0), float(0.45), dens))
            .mul(facing.max(0))
            .mul(u.light3.y)
            .mul(drama.add(0.3));
          col.assign(mix(col, u.rim, clamp(lining, 0, 1)));
          // A little broken colour, so it sits with painted art (Brush).
          const bp = P0.div(Sl.mul(0.06));
          const dab = mx_noise_float(vec2(bp.x.add(5.3), bp.y));
          col.assign(col.mul(float(1).add(dab.mul(0.05).mul(u.style2.x))));
          // OPACITY from optical thickness: thin cloud is see-through — the soft, fluffy edge is the volume's own.
          const aCloud = float(1).sub(TSL.exp(dens.mul(u.style.x.negate())));
          const aMist = mist.mul(float(1).sub(aCloud));
          const mistC = mix(u.body, u.hi, float(0.5));
          coreC.assign(
            col
              .mul(aCloud)
              .add(mistC.mul(aMist))
              .div(max(aCloud.add(aMist), float(1e-4)))
          );
          coreA.assign(aCloud.add(aMist).mul(lay.opacity));
        }
      );
      // Back to front, premultiplied "over".
      accC.assign(coreC.mul(coreA).add(accC.mul(float(1).sub(coreA))));
      accA.assign(coreA.add(accA.mul(float(1).sub(coreA))));
    };
    // Back to front: the low deck, the wisps (they belong to the main deck, just under it), the main deck, the
    // high deck. The side decks only when the card has them on.
    const want = decks ?? (layered ? [0, 1, 2] : [1]);
    if (want.includes(0)) shadeDeck(0, false);
    if (want.includes(1)) {
      const { wispA, wispC } = wisps();
      accC.assign(wispC.mul(wispA).add(accC.mul(float(1).sub(wispA))));
      accA.assign(wispA.add(accA.mul(float(1).sub(wispA))));
      shadeDeck(1, true);
    }
    if (want.includes(2)) shadeDeck(2, false);
    const rgb = accC.div(max(accA, float(1e-4)));

    // The padding rule without a Table: no cloud over the scene padding.
    const bd = u.board;
    const inBoard = step(bd.x, groundXY.x)
      .mul(step(groundXY.x, bd.z))
      .mul(step(bd.y, groundXY.y))
      .mul(step(groundXY.y, bd.w));
    const boardGate = mix(float(1), inBoard, u.domain2.y);
    if (debug) return TSL.vec4(dbg, float(1));
    let alpha = accA
      .mul(boardGate)
      .mul(u.opacity)
      .mul(step(float(1e-4), u.deck.z));
    if (visibility) alpha = alpha.mul(visibility);
    return TSL.vec4(rgb, clamp(alpha, 0, 1));
  })();
  return { rgb: out.xyz, alpha: out.w };
}

/**
 * THE STORYBOOK GROUND SHADOW — how much sun survives the deck at a ground point, 1 = full sun. The drop-in for
 * `world/cloud-field.js#buildCloudGroundVisNode` in the shared cloud-shadow cache pass. The same field the tops
 * draw (two octaves: a shadow is softer than the cloud), offset the world-fixed way every other shadow is.
 *
 * @param {object} TSL
 * @param {object} args
 * @param {*} args.worldXY - vec2 node, the ground point.
 * @param {object} args.u - {@link createStorybookUniforms}.
 * @param {{drift:*, dir:*}} args.wind
 * @param {*} args.offset - vec2 node, world px, cloud → shadow (`uCloudOffset`).
 * @param {*} args.blur - float node, the shadow's soft edge as a fraction of a cloud's size.
 * @param {*} args.fillShare - float node, `fill/(key+fill)` — the deepest a cloud shadow may go.
 * @returns {*} float node, 0..1.
 */
export function buildStorybookShadowNode(TSL, { worldXY, u, wind, offset, blur, fillShare }) {
  const { Fn, float, max, smoothstep, mix, step } = TSL;
  return Fn(() => {
    // Every deck casts (round 8): the higher a deck, the further its shadow falls from it. Transmittances multiply.
    const trans = float(1).toVar('sbsTrans');
    for (const li of [0, 1, 2]) {
      const lay = layerOf(TSL, u, wind, float(li));
      const p = worldXY.sub(offset.mul(lay.hMul));
      const c = coreAt(TSL, u, lay, p, li === 1 ? { octaves: 2 } : { billows: false, octaves: 1 });
      // 2026-11-08 author: shadows softer / more blurred. Was soft = blur*0.5 over [-soft/2, soft]; now twice the
      // reach on both edges, so the penumbra is ~2.7x wider.
      const soft = max(blur.mul(1.0), float(0.06));
      const on = li === 1 ? float(1) : step(float(1.5), u.layOn.x);
      const cov = smoothstep(soft.negate().mul(0.8), soft, c.core.sub(lay.thr)).mul(lay.opacity).mul(on);
      trans.assign(trans.mul(float(1).sub(cov.mul(0.85))));
    }
    const cov = float(1)
      .sub(trans)
      .div(0.85)
      .clamp(0, 1)
      .mul(step(float(1e-4), u.deck.z));
    return mix(float(1), fillShare, cov.mul(u.domain2.z));
  })();
}

// ---------------------------------------------------------------------------
// FOR THE RAIN (2026-11-03) — where the deck is, and how much cloud is over a point
// ---------------------------------------------------------------------------

/**
 * The deck's base height (world px) over a deck point — the dome every storybook pixel casts to
 * (`buildStorybookCloudNode`'s `zDeck`). Rain is born here (`precip-runtime.js#setCloudDeck`), so a drop starts
 * at the very height the cloud above it is drawn at. CPU twin: {@link storybookDeckHeightAt}.
 *
 * @param {object} TSL
 * @param {{xy:*, base:*, dome:*, centre:*, radius:*}} a - float/vec2 nodes: `deck2.x`, `deck2.y`, `domeCentre`,
 *   `deck2.z` in the storybook uniforms.
 */
export function storybookDeckHeightNode(TSL, { xy, base, dome, centre, radius }) {
  const { float, min, max, dot } = TSL;
  const rel = xy.sub(centre).div(max(radius, float(1)));
  return base.add(dome.mul(float(1).sub(min(dot(rel, rel), float(1.7))))).max(float(0));
}

/**
 * {@link storybookDeckHeightNode} on the CPU, for the tests and the lab.
 * @param {{baseHeight:number, domeHeight:number, domeCentre:number[], domeRadius:number}} deck
 * @param {number} x @param {number} y
 */
export function storybookDeckHeightAt(deck, x, y) {
  const r = Math.max(1, deck.domeRadius);
  const dx = (x - deck.domeCentre[0]) / r;
  const dy = (y - deck.domeCentre[1]) / r;
  return Math.max(0, deck.baseHeight + deck.domeHeight * (1 - Math.min(dx * dx + dy * dy, 1.7)));
}

/**
 * HOW MUCH CLOUD IS STRAIGHT ABOVE `worldXY` — the cloud's top height 0..1 of its full thickness (`heightOf`, the
 * remap the shadow march reads): 0 out past the scraps, rising through the edge, 1 deep in a thick core. 0
 * everywhere while the deck holds no cloud.
 *
 * No sun offset (that is the shadow's) and no eye parallax (that is the tops'): rain falls DOWN from the deck,
 * so the cloud over a point is the one whose drops land near it. The same two-octave field the shadow cache
 * reads, so a rain shaft and the shadow it walks beside come from one cloud.
 *
 * @param {object} TSL
 * @param {{worldXY:*, u:object, wind:{drift:*, dir:*}}} a
 * @returns {*} float node, 0..1.
 */
export function buildStorybookCloudDepthNode(TSL, { worldXY, u, wind }) {
  const { Fn, float, step } = TSL;
  return Fn(() => {
    const c = coreAt(TSL, u, wind, worldXY, { octaves: 2 });
    return heightOf(TSL, u, c.core).mul(step(float(1e-4), u.deck.z));
  })();
}
