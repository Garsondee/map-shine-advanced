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
  /** The silhouette's soft edge, in core units (before the screen-px AA floor). Defined, not cut. */
  edge: 0.035,
  /** Core units over which a cloud's broad dome rises from its edge to its crown. */
  domeRise: 0.55,
  /** Domain-warp strength (cloud units) and frequency: irregular, never taffy (0.6 smeared every cloud). */
  warp: 0.15,
  warpFreq: 0.6,
  /** fBm body frequency. */
  bodyFreq: 0.7,
  /** Two scales of rounded puffs (Worley): frequency and strength. They make the cauliflower edge AND the
   * lumps the light reads inside. */
  puffFreq: 2.0,
  puffAmp: 0.6,
  puff2Freq: 4.6,
  puff2Amp: 0.34,
  puff3Freq: 9.5,
  puff3Amp: 0.07,
  /** Cluster strength (how much the crowded/open regions decide where clouds may be). */
  clusterAmp: 1.1,
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
});

/**
 * The full field's value at given coverage fractions — measured in the lab (`variant: 'cov'`, 3 × 480×270 px at zoom 0.25,
 * ~75 cloud units across; re-measure with `StorybookDriver.calibrate()` whenever the field's constants change): `threshold(fill)` is the field value with `fill` of the sky above it. Monotone.
 * [coverage fraction, threshold]
 */
export const STORYBOOK_CORE_QUANTILES = Object.freeze([
  [0, 1.8],
  [0.0102, 1.2],
  [0.0348, 1],
  [0.0575, 0.9],
  [0.0887, 0.8],
  [0.1298, 0.7],
  [0.181, 0.6],
  [0.2429, 0.5],
  [0.3118, 0.4],
  [0.3866, 0.3],
  [0.4659, 0.2],
  [0.5488, 0.1],
  [0.6297, 0],
  [0.7065, -0.1],
  [0.7747, -0.2],
  [0.8344, -0.3],
  [0.8832, -0.4],
  [0.9484, -0.6],
  [0.9815, -0.8],
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
 * The light the clouds are SHADED by — not the sun itself. A storybook light always rakes: the sun's own
 * bearing, but its elevation held between 30° and 38° so the cel bands always fall across the lobes (a noon sun
 * straight down would light every lobe flat; a sun on the horizon would put every lobe in shadow). After dusk the
 * moon takes over from the opposite bearing.
 * @param {{x:number,y:number}} dirToSunXY - unit, `marchDirectionToSun` (sky-access `key.dirX/dirY`).
 * @param {number} elevationDeg
 * @returns {number[]} unit [x, y, z].
 */
export function storybookLight(dirToSunXY, elevationDeg) {
  const dx = Number.isFinite(dirToSunXY?.x) ? dirToSunXY.x : 1;
  const dy = Number.isFinite(dirToSunXY?.y) ? dirToSunXY.y : 0;
  const elev = Number.isFinite(elevationDeg) ? elevationDeg : 30;
  const night = smooth01((-3 - elev) / 8);
  const sunE = (Math.max(30, Math.min(38, elev)) * Math.PI) / 180;
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
  return { fill: Math.min(0.85, 0.74 * c ** 1.25), size: lerp(0.85, 1.12, smooth01(c)) };
}

// ---------------------------------------------------------------------------
// THE DECK, PER FRAME (CPU)
// ---------------------------------------------------------------------------

/** The Cloud Tops card's storybook dials, defaults (mirrors `cloud-tops.js`'s schema). */
export const STORYBOOK_DECK_DEFAULTS = Object.freeze({
  storybookSpacing: 0.48,
  storybookSize: 1.15,
  storybookHeight: 0.12,
  storybookBulge: 0.5,
  storybookDomain: 0.55,
  storybookLine: 2.4,
  storybookInk: 0,
  storybookRim: 0.45,
  storybookBands: 0.07,
  storybookBrush: 0.5,
  storybookShadowDensity: 0.85,
  storybookTails: 1,
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
  const pad = tableOn ? Math.max(0, p('storybookDomain')) * side : 0;
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
    domainFade: tableOn ? spacing * 0.6 : 1,
    clipToBoard: !tableOn,
    line: Math.max(0, p('storybookLine')),
    ink: Math.max(0, p('storybookInk')),
    rim: Math.max(0, p('storybookRim')),
    bands: Math.max(0.002, p('storybookBands')),
    brush: Math.max(0, p('storybookBrush')),
    shadowDensity: Math.max(0, p('storybookShadowDensity')),
    tails: Math.max(0, p('storybookTails')),
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
    /** line (unused), ink (unused), rim, bands (shading softness) */
    style: uniform(vec4(2.4, 0, 0.45, 0.07)),
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
export function pushStorybookUniforms(u, { deck, palette, light, eye, board, footprintPx, timeSec = 0, evolve = 1 }) {
  u.deck.value.set(deck.spacing, deck.radius, deck.fill, deck.elong);
  u.deck2.value.set(deck.baseHeight, deck.domeHeight, deck.domeRadius, timeSec);
  u.field.value.set(deck.threshold ?? 9, evolve, deck.clusterFreq ?? 0.3, 0);
  u.domeCentre.value.set(deck.domeCentre[0], deck.domeCentre[1]);
  u.domain.value.set(...deck.domain);
  u.domain2.value.set(deck.domainFade, deck.clipToBoard ? 1 : 0, deck.shadowDensity, deck.cover ?? 0);
  if (board) u.board.value.set(board.minX, board.minY, board.maxX, board.maxY);
  if (eye) u.eye.value.set(eye.x, eye.y, Math.max(1, eye.height));
  if (light) u.light.value.set(light[0], light[1], light[2]);
  u.style.value.set(deck.line, deck.ink, deck.rim, deck.bands);
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
 * SOFT LUMPS — a sum of round Gaussian bumps, one per jittered cell (3x3 neighbourhood): rounded hills that
 * merge smoothly where they meet. What the LIGHT reads inside a cloud (round cauliflower lumps of every size),
 * never a silhouette — the outline comes from the field, so this can never make a bundle of balloons.
 * Worley (`1 − F1²`) has a kink on every cell border and lit kinks drew cracked rock; |Perlin| drew worm-like
 * folds (brain coral). Returns ~0..1.
 * @param {object} TSL @param {*} p - vec2 node, in lump cells.
 */
function softLumps(TSL, p) {
  const { float, vec2, floor, fract, sin, dot, exp } = TSL;
  const i = floor(p);
  const f = fract(p);
  let sum = float(0);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = i.add(vec2(dx, dy));
      const o = fract(sin(vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)))).mul(43758.5453));
      const r = vec2(dx, dy).add(o.mul(0.8).add(0.1)).sub(f);
      sum = sum.add(exp(dot(r, r).mul(-3.6)));
    }
  }
  return float(1).sub(exp(sum.mul(-1.25)));
}

/**
 * The cumulus field at world point `P` (on the deck), as nodes.
 * @param {object} TSL
 * @param {object} u
 * @param {{drift:*, dir:*}} wind
 * @param {*} P - vec2 node, world px.
 * @param {{billows?:boolean, octaves?:number}} [o] - a cheap core (no billows, one octave) for scouting and the
 *   wisps' upwind samples; its mean sits `STORYBOOK_FIELD.cheapOffset` below the full one.
 * @returns {{core:*, cells:*, cluster:*}}
 */
function coreAt(TSL, u, wind, P, { billows = true, octaves = 2 } = {}) {
  const { float, vec2, dot, mx_noise_float, mx_fractal_noise_float, mx_worley_noise_float } = TSL;
  const F = STORYBOOK_FIELD;
  const q0 = P.sub(wind.drift).div(u.deck.x);
  // Long clouds (the cirrus-ish recipes): squash along the wind. A projection, not a rotation, so a wind that
  // swings never swings the whole sky about the origin (at elong 0 it is exactly q0).
  const a = wind.dir;
  const q = q0.sub(a.mul(dot(q0, a).mul(u.deck.w.div(float(1).add(u.deck.w)))));
  const tau = u.deck2.w.mul(u.field.y).mul(F.evolve);
  const ev = vec2(tau, tau.mul(-0.7));
  // CLUSTERS: crowded sky here, open sea there.
  const cluster = mx_noise_float(q.mul(u.field.z).add(vec2(3.1, 7.3)).add(ev.mul(0.35)));
  // WARP, evolving: the lumps bulge, pinch, merge and split.
  const qw = q.mul(F.warpFreq).add(ev);
  const w = vec2(mx_noise_float(qw.add(vec2(11.7, 2.3))), mx_noise_float(qw.add(vec2(5.9, 17.1))));
  const qb = q.add(w.mul(F.warp));
  const body = mx_fractal_noise_float(qb.mul(F.bodyFreq).add(ev.mul(0.6)), octaves, 2.07, 0.5, 1);
  let core = body.add(cluster.mul(F.clusterAmp));
  // The SMOOTH field (no Worley): what the light reads. Every Worley cell border is a kink, and a lit kink is a
  // hard crack line (round 5f drew cracked rock); the Worley puffs only shape the outline.
  let smooth = core.add(float(F.cheapOffset));
  let puff = float(0.5);
  if (billows) {
    // PUFFS: rounded lumps at two scales — high on a Worley feature point, low in the crease between.
    const c1 = mx_worley_noise_float(qb.mul(F.puffFreq).sub(ev.mul(1.4)));
    const c2 = mx_worley_noise_float(qb.mul(F.puff2Freq).add(vec2(4.1, 9.3)).sub(ev.mul(2.1)));
    const c3 = mx_worley_noise_float(qb.mul(F.puff3Freq).add(vec2(7.7, 1.9)).sub(ev.mul(3.0)));
    const p1 = float(1).sub(c1.mul(c1));
    const p2 = float(1).sub(c2.mul(c2));
    const p3 = float(1).sub(c3.mul(c3));
    core = core.add(p1.sub(0.75).mul(F.puffAmp)).add(p2.sub(0.75).mul(F.puff2Amp)).add(p3.sub(0.75).mul(F.puff3Amp));
    // What the LIGHT reads: smooth lumps (Perlin) mixed with a little of the Worley puffs. Worley alone has a
    // kink on every cell border, and the light drew each kink as a hard ridge (an ice sculpture, not a cloud);
    // the finest Worley scale only bumps the outline (inside, it read as crumpled paper).
    const s1 = mx_noise_float(
      qb
        .mul(F.puffFreq * 0.9)
        .add(vec2(2.9, 8.1))
        .sub(ev.mul(1.2))
    );
    const s2 = mx_noise_float(
      qb
        .mul(F.puff2Freq * 0.8)
        .add(vec2(6.3, 4.4))
        .sub(ev.mul(1.8))
    );
    // Rounded lumps at two sizes (soft Gaussian bumps, nudged by a smooth noise so they never sit on a grid).
    const b1 = softLumps(
      TSL,
      qb
        .mul(F.puffFreq * 1.7)
        .add(s1.mul(0.35))
        .sub(ev.mul(1.2))
    );
    const b2 = softLumps(
      TSL,
      qb
        .mul(F.puff2Freq * 1.6)
        .add(vec2(6.3, 4.4))
        .add(s2.mul(0.35))
        .sub(ev.mul(1.8))
    );
    puff = b1.mul(0.78).add(b2.mul(0.22));
    smooth = smooth.add(b1.sub(0.4).mul(0.14)).add(b2.sub(0.4).mul(0.04));
  } else {
    core = core.add(float(F.cheapOffset));
  }
  return { core, smooth, puff, cluster };
}

/** Coverage 0..1 of a core value against the threshold, over `w` core units (the silhouette). */
function edgeOf(TSL, u, core, w) {
  return TSL.smoothstep(TSL.float(0), w, core.sub(u.field.x));
}

/** The cloud's top surface height, 0..1 of its thickness: a broad dome from edge to crown, with the puffs riding
 * on it (so the light finds lumps inside the cloud, not one plateau). */
function heightOf(TSL, u, c) {
  const { smoothstep, float } = TSL;
  const dome = smoothstep(float(-0.08), float(STORYBOOK_FIELD.domeRise), c.smooth.sub(u.field.x));
  return dome.mul(c.puff.mul(0.6).add(0.4));
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
 * @returns {{rgb:*, alpha:*}} rgb is straight (not premultiplied); composite with NormalBlending.
 */
export function buildStorybookCloudNode(TSL, { groundXY, u, wind, visibility = null }) {
  const { Fn, If, float, vec2, vec3, max, min, abs, clamp, smoothstep, mix, normalize, dot, length, step, select } =
    TSL;
  const { mx_fractal_noise_float, mx_noise_float, dFdx, dFdy } = TSL;
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
    const rel0 = lensXY.sub(u.domeCentre).div(max(u.deck2.z, float(1)));
    const zDeck = u.deck2.x
      .add(u.deck2.y.mul(float(1).sub(min(dot(rel0, rel0), float(1.7)))))
      .max(float(0))
      .toVar('sbZ');
    const S = u.deck.x;
    const T = u.deck.y;
    const thr = u.field.x;
    const L = u.light;
    const lLen = max(length(L.xy), float(1e-3));
    const lxy = L.xy.div(lLen);
    // Screen-px floor for the silhouette's soft edge, in core units (the field changes ~3 core units per cloud unit).
    const aaW = max(float(F.edge), u.style2.y.div(S).mul(3));

    // ── THE WISPS (back layer) — the field's thin, wind-torn edge ─────────────
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

    // ── THE CLOUD (front layer) ────────────────────────────────────────────
    const P0 = at(zDeck).toVar('sbP0');
    const scout = coreAt(TSL, u, wind, P0, { billows: false, octaves: 1 }).core;
    // Inside the scout's If: only the field itself. Everything that takes a screen-space derivative runs after
    // it, in uniform control flow (a derivative inside a divergent branch is undefined). Outside every cloud's
    // reach these stay at their defaults, which is fully transparent.
    const h1 = float(0).toVar('sbH1');
    const puffV = float(0.5).toVar('sbPuff');
    const edgeV = float(0).toVar('sbEdge');
    const coreV = float(-1).toVar('sbCoreV');
    const occ = float(0).toVar('sbOcc');
    If(scout.greaterThan(thr.sub(0.5)), () => {
      const c1 = coreAt(TSL, u, wind, P0);
      h1.assign(heightOf(TSL, u, c1));
      puffV.assign(c1.puff);
      edgeV.assign(edgeOf(TSL, u, c1.core, aaW));
      coreV.assign(c1.core.sub(thr));
      // SELF-SHADOW: a taller billow a little way sunward shades this one.
      const dS = S.mul(0.14);
      const hS = heightOf(TSL, u, coreAt(TSL, u, wind, P0.add(lxy.mul(dS)), { octaves: 1 }));
      occ.assign(
        smoothstep(
          float(-0.05).mul(T),
          T.mul(0.35),
          hS
            .sub(h1)
            .mul(T)
            .sub(dS.mul(L.z.div(lLen)))
        )
      );
    });
    // THE SURFACE'S SLOPE from screen-space derivatives of its height (a 2x2 solve against the deck point's own
    // derivatives — the fisheye and the dome make the screen→deck map non-uniform). The full 2-D gradient at no
    // extra field evaluation; the one-sided sunward difference it replaces drew streaks along the light.
    const dPx = dFdx(P0);
    const dPy = dFdy(P0);
    const dhx = dFdx(h1);
    const dhy = dFdy(h1);
    const det = dPx.x.mul(dPy.y).sub(dPx.y.mul(dPy.x));
    const detS = select(abs(det).lessThan(float(1e-6)), float(1e-6), det);
    const grad = vec2(dhx.mul(dPy.y).sub(dhy.mul(dPx.y)), dPx.x.mul(dhy).sub(dPy.x.mul(dhx)))
      .div(detS)
      .mul(T.mul(0.8));
    const N = normalize(vec3(grad.negate(), float(1)));
    const ndl = dot(N, L);
    const lit = clamp(ndl.mul(0.95).add(0.02), 0, 1).mul(float(1).sub(occ.mul(0.6)));
    const soft = u.style.w.mul(2).add(0.05);
    // White where the puffs face the light, the body tone as they turn away, the cool shadow tone where they
    // face away or something shades them — the round, sculpted read of the photos.
    const col = mix(u.shadow, u.body, smoothstep(float(0.1), float(0.5).add(soft), lit)).toVar('sbCol');
    col.assign(mix(col, u.hi, smoothstep(float(0.55).sub(soft), float(0.9), lit)));
    const crease = float(1)
      .sub(smoothstep(float(0.35), float(0.62), puffV))
      .mul(smoothstep(float(0.05), float(0.4), h1));
    col.assign(mix(col, u.shadow, crease.mul(0.35)));
    // A thin edge is the wisps' own colour, so the head melts into its wisps with no seam.
    col.assign(mix(wispC, col, smoothstep(float(0), float(0.3), h1)));
    // A little broken colour, so it sits with painted art (Brush).
    const bp = P0.div(S.mul(0.08));
    const dab = mx_noise_float(vec2(bp.x.add(5.3), bp.y));
    col.assign(col.mul(float(1).add(dab.mul(0.04).mul(u.style2.x))));
    const coreC = col;
    // FLUFFY, not cut: the thin rim is part see-through (the sea shows through a cumulus's edge in every
    // reference photo), and a fine noise frays the last stretch of it into tufts.
    const fp = P0.div(S.mul(0.07));
    const fray = mx_noise_float(vec2(fp.x.add(13.1), fp.y))
      .mul(0.5)
      .add(0.5);
    const rim = smoothstep(float(0.02), float(0.2), coreV);
    const coreA = edgeV.mul(mix(fray.mul(0.55).add(0.1), float(1), rim));

    // Back to front, premultiplied: wisps, then the cloud.
    const accC = wispC.mul(wispA).toVar('sbAccC');
    const accA = wispA.toVar('sbAccA');
    accC.assign(coreC.mul(coreA).add(accC.mul(float(1).sub(coreA))));
    accA.assign(coreA.add(accA.mul(float(1).sub(coreA))));
    const rgb = accC.div(max(accA, float(1e-4)));

    // The padding rule without a Table: no cloud over the scene padding.
    const bd = u.board;
    const inBoard = step(bd.x, groundXY.x)
      .mul(step(groundXY.x, bd.z))
      .mul(step(bd.y, groundXY.y))
      .mul(step(groundXY.y, bd.w));
    const boardGate = mix(float(1), inBoard, u.domain2.y);
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
    const p = worldXY.sub(offset);
    const c = coreAt(TSL, u, wind, p, { octaves: 2 });
    const soft = max(blur.mul(0.5), float(0.04));
    const cov = smoothstep(soft.negate().mul(0.5), soft, c.core.sub(u.field.x)).mul(step(float(1e-4), u.deck.z));
    return mix(float(1), fillShare, cov.mul(u.domain2.z));
  })();
}
