/**
 * STORYBOOK CLOUDS — clouds drawn the way the maps are painted (author, 2026-11-03: *"we have a mismatch
 * between the realistic rendering of our clouds and the cartoony/painterly style of the maps. How can we make
 * our clouds more exaggerated, almost caricatured? ... distinct clouds with spaces between them instead of the
 * current grey slime ... a sort of bulbous fisheye like bulge ... guess how Crosshead would render clouds, the
 * colorations they'd use at different times of day. Bonus points for making the clouds have real depth."*).
 *
 * ============================================================================
 * WHAT THE MAPS ASKED FOR (read off ten maps' albedo, 2026-11-03)
 * ============================================================================
 * Crosshead paints every round thing — boulders, tree canopies, snow-laden pines — the same way:
 *   - a BOLD, slightly warm dark INK outline, and thinner ink lines where one lobe sits over another;
 *   - THREE FLAT TONES with soft painted transitions (shadow, body, a lighter inset "plateau" shifted toward
 *     the light), never a smooth airbrushed gradient — the highlight on a boulder is a SHAPE, not a falloff;
 *   - shadows that turn COOL and violet (the snow map's shadows are lilac-blue, never grey), lights that stay
 *     warm and creamy;
 *   - a fine paper/brush grain over everything, and a soft dark airbrushed halo on the ground beneath.
 * A storybook cloud is that vocabulary applied to a cumulus: a cluster of round LOBES, inked, cel-shaded in
 * three tones by a light that always rakes nicely, its palette turning with the hour.
 *
 * ============================================================================
 * REAL DEPTH: THE LOBES ARE RAY-CAST, NOT PAINTED ON
 * ============================================================================
 * Each cloud is ~11 squashed spheres (ellipsoids) hung in 3-D above the table. Every pixel casts the ray from
 * its ground point up to the shared scene eye (`scene/scene-eye.js` — the one camera the Table, Parallax and
 * every depth effect agree on) and intersects it with the lobes. So the clouds have true parallax as the view
 * pans, a higher lobe really does hide a lower one, the normal is the exact sphere normal (cel bands land
 * where a painter would put them), and a lobe really does shadow the lobe down-sun of it (a second ray, from
 * the hit point toward the light).
 *
 * ============================================================================
 * THE DOME — the whole deck curves over the play area
 * ============================================================================
 * The deck is not flat: its height follows a dome centred on the board (`dome(c) = 1 − ρ²`, ρ the distance
 * from the board's centre over the dome radius), highest over the middle and sinking past the edges. Seen
 * through the scene eye, the high middle is magnified more than the low rim — a barrel/fisheye bulge that
 * reads as a sky arching over the table. It is world-fixed (the board's centre), not tied to the camera, so
 * it behaves like a sky and not like a lens.
 *
 * Deck height is a FRACTION OF THE EYE HEIGHT, not a fixed number of world px: the eye rises as the view pulls
 * back (`sceneEyeHeight`), and a deck at a fixed altitude would flatten to nothing at exactly the zoom where
 * the tops appear. A fraction keeps the bulge and the parallax the same strength at every zoom.
 *
 * ============================================================================
 * DISTINCT CLOUDS WITH GAPS — a jittered grid, one cloud per cell at most
 * ============================================================================
 * The deck is a grid of cells `spacing` world px apart, drifting with the shared cloud drift. A cell holds a
 * cloud when its hash falls under `fill` (from cover). A cloud's whole footprint stays inside its own cell,
 * so (a) neighbours can never merge into a sheet — there is always sky between them — and (b) a pixel only
 * ever has to test the 2×2 cells nearest the point where its ray crosses the deck. The ground shadow reads the
 * SAME clouds ({@link buildStorybookShadowNode}), so a cloud and its shadow can never disagree.
 *
 * Pure TSL builders with TSL injected, plus pure JS (palette, deck resolution) for the CPU side and the tests.
 * No THREE import, no state.
 *
 * @module effects/clouds/storybook-clouds
 */

/** Lobes per cloud: one crown, six inner masses, and ten small bumps that scallop the edge (the scalloped
 * silhouette is the single most "Crosshead" thing about a canopy, and about these clouds). */
export const STORYBOOK_LOBES = 17;

/** How far a cloud may reach from its centre, as a fraction of the cell spacing. The centre is jittered up to
 * {@link STORYBOOK_JITTER}/2 of a cell and perspective slides the ray up to ~0.09 cell across the clouds'
 * thickness at the screen's edge — 0.33 keeps all of it inside the 2×2 cells a pixel tests. A cloud's radius
 * is capped per cloud from this and its own stretch (a long cloud is a narrow one). */
export const STORYBOOK_MAX_REACH_FRAC = 0.33;

/** The farthest lobe edge, in cloud radii, before stretch (edge bumps at up to 0.88 R, radius up to 0.36 R, plus
 * the ragged-edge noise). */
const STORYBOOK_REACH_RADII = 1.3;

/** A cloud's radius ceiling as a fraction of the cell spacing, for an unstretched cloud. */
export const STORYBOOK_MAX_RADIUS_FRAC = STORYBOOK_MAX_REACH_FRAC / STORYBOOK_REACH_RADII;

/** How far (fraction of a cell) a cloud's centre may wander from its cell's centre. */
export const STORYBOOK_JITTER = 0.16;

/** Ellipsoid squash: a lobe's vertical radius over its horizontal one. A cumulus billow is flatter than a ball. */
export const STORYBOOK_SQUASH = 0.72;

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
    { elev: 2, hi: '#ffdcb6', body: '#e3a7a6', shadow: '#7c72a8', ink: '#352e4e', rim: '#ffe8c6' },
    { elev: 10, hi: '#fff3e0', body: '#cbc3da', shadow: '#7f7cad', ink: '#2c2946', rim: '#fff5dc' },
    { elev: 28, hi: '#fffaf0', body: '#c4cee2', shadow: '#7d8cb6', ink: '#262d4a', rim: '#ffffff' },
  ]),
  setting: Object.freeze([
    { elev: -18, hi: '#8b9bc6', body: '#46527c', shadow: '#232a4c', ink: '#0e1226', rim: '#b4c4ec' },
    { elev: -9, hi: '#ada3d6', body: '#625f98', shadow: '#332f66', ink: '#17142e', rim: '#d8b8e0' },
    { elev: -3, hi: '#ffa27e', body: '#bd5f82', shadow: '#4f3f78', ink: '#241833', rim: '#ffb67e' },
    { elev: 2, hi: '#ffd482', body: '#ec9566', shadow: '#965a72', ink: '#432536', rim: '#ffe28e' },
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
      const mixed = slot === 'hi' || slot === 'rim' ? lerp(hour, Math.min(hour, storm), storm01) : lerp(hour, storm, storm01);
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
// COVER → HOW MANY CLOUDS, HOW BIG
// ---------------------------------------------------------------------------

/**
 * The share of cells that hold a cloud, and the size multiplier, for a cover value. Exactly 0 at cover 0 (a
 * provable no-op — the same promise `coverThreshold` makes for the realistic field). A few fat fair-weather
 * clouds at low cover; a crowded sky (still with sky between) near overcast.
 * @param {number} cover01
 * @returns {{fill:number, size:number}}
 */
export function storybookDensity(cover01) {
  const c = clamp01(Number.isFinite(cover01) ? cover01 : 0);
  if (c <= 0) return { fill: 0, size: 0 };
  return { fill: Math.min(1, 0.12 + c * 1.05), size: lerp(0.78, 1.1, smooth01(c)) };
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
 * @param {number} a.scalePx - the weather preset's own cloud scale; nudges spacing gently, so a
 *   preset's "big clouds" still reads bigger without one preset's 350 px and another's 6000 px swinging the
 *   storybook deck by 17×.
 * @param {number} [a.anisotropy] - the active recipe's along-wind stretch (cirrus ≈ 4): elongates clouds.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} a.board - the scene rect.
 * @param {boolean} a.tableOn - the deck spreads over the whole table when the Table is on.
 * @param {number} a.eyeHeight - the scene eye's height (world px).
 * @param {object} [a.params] - the card's resolved params (missing keys take {@link STORYBOOK_DECK_DEFAULTS}).
 */
export function resolveStorybookDeck({ cover01, scalePx, anisotropy = 1, board, tableOn, eyeHeight, params = {} }) {
  const p = (k) => (Number.isFinite(params?.[k]) ? params[k] : STORYBOOK_DECK_DEFAULTS[k]);
  const w = Math.max(1, (board?.maxX ?? 1) - (board?.minX ?? 0));
  const h = Math.max(1, (board?.maxY ?? 1) - (board?.minY ?? 0));
  const side = Math.min(w, h);
  const scaleNudge = Math.max(0.75, Math.min(1.4, ((Number.isFinite(scalePx) && scalePx > 0 ? scalePx : 1100) / 1100) ** 0.25));
  const spacing = Math.max(200, p('storybookSpacing') * side * scaleNudge);
  const { fill, size } = storybookDensity(cover01);
  const radius = spacing * Math.min(STORYBOOK_MAX_RADIUS_FRAC, 0.24 * size * Math.max(0.25, p('storybookSize')));
  const H = Math.max(1, Number.isFinite(eyeHeight) ? eyeHeight : 4 * side);
  // The crown of the highest cloud (dome top + its tallest lobe) stays under 82% of the eye, so the nearest
  // cloud is magnified at most ~5.5× and nothing is ever drawn through the camera.
  let base = Math.max(0, p('storybookHeight')) * H;
  let dome = Math.max(0, p('storybookBulge')) * 0.36 * H;
  const crown = radius * (0.5 + 0.66 * STORYBOOK_SQUASH);
  const ceiling = 0.82 * H;
  if (base + dome + crown > ceiling) {
    const k = Math.max(0, ceiling - crown) / Math.max(1, base + dome);
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
    elong,
    baseHeight: base,
    domeHeight: dome,
    domeCentre: [cx, cy],
    domeRadius: 0.5 * Math.hypot(w, h) * 1.1,
    // The fisheye's barrel strength, on the same Bulge dial as the dome (one "how much does it bulge" control).
    lens: Math.max(0, p('storybookBulge')) * 0.18,
    domain: [(board?.minX ?? 0) - pad, (board?.minY ?? 0) - pad, (board?.maxX ?? w) + pad, (board?.maxY ?? h) + pad],
    domainFade: tableOn ? spacing * 0.6 : 1,
    // Inside the board only (no Table): clouds are clipped to the board per pixel — the padding rule
    // (2026-10-27) — and nothing hangs over the scene padding.
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
 * (`world/cloud-field.js#createCloudUniforms`'s `drift`/`windDir`), so the storybook deck drifts with exactly
 * the wind and speed the realistic one would.
 * @param {object} TSL
 */
export function createStorybookUniforms(TSL) {
  const { uniform, vec2, vec3, vec4, float } = TSL;
  return {
    /** spacing, radius, fill, elong */
    deck: uniform(vec4(3000, 600, 0, 0)),
    /** baseHeight, domeHeight, domeRadius, morph time (s) */
    deck2: uniform(vec4(1500, 1500, 5000, 0)),
    domeCentre: uniform(vec2(0, 0)),
    /** minX, minY, maxX, maxY — where clouds may live */
    domain: uniform(vec4(-1e9, -1e9, 1e9, 1e9)),
    /** domainFade (px), clipToBoard (0/1), shadowDensity, cover01 */
    domain2: uniform(vec4(1, 0, 0.85, 0)),
    board: uniform(vec4(-1e9, -1e9, 1e9, 1e9)),
    eye: uniform(vec3(0, 0, 10000)),
    light: uniform(vec3(0.5, 0.3, 0.8)),
    /** line (screen px), ink, rim, bands */
    style: uniform(vec4(2.4, 0, 0.45, 0.07)),
    /** brush, footprint (world px per screen px), fisheye lens, tails */
    style2: uniform(vec4(1, 4, 0, 0)),
    hi: uniform(vec3(1, 0.98, 0.94)),
    body: uniform(vec3(0.76, 0.8, 0.86)),
    shadow: uniform(vec3(0.33, 0.39, 0.56)),
    ink: uniform(vec3(0.04, 0.06, 0.12)),
    rim: uniform(vec3(1, 1, 1)),
    opacity: uniform(float(1)),
    /** LOOP COUNTS as a uniform, never constants: head cells, lobes, trail cells, trails. A constant-bound loop
     * is fully unrolled by the D3D compiler (FXC — Chrome's WebGL on Windows, and Dawn's WebGPU there too), and
     * this shader's nested loops unrolled lost the device in the lab (2026-11-03). Never written after this. */
    loops: uniform(vec4(4, STORYBOOK_LOBES, 9, STORYBOOK_TRAILS.length)),
  };
}

/**
 * Push one frame. `deck` is {@link resolveStorybookDeck}'s result; `palette` {@link storybookPalette}'s.
 * @param {object} u @param {object} a
 */
export function pushStorybookUniforms(u, { deck, palette, light, eye, board, footprintPx, timeSec = 0 }) {
  u.deck.value.set(deck.spacing, deck.radius, deck.fill, deck.elong);
  u.deck2.value.set(deck.baseHeight, deck.domeHeight, deck.domeRadius, timeSec);
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
// THE CLOUDS THEMSELVES (TSL) — shared by the tops and the shadow
// ---------------------------------------------------------------------------

/** One 0..1 hash per (cell, salt). `fract(sin)` is plenty for a few hundred cells near the origin. */
function hash3(TSL, cell, salt) {
  const { fract, sin, dot, vec3, float } = TSL;
  return fract(sin(dot(vec3(cell.x, cell.y, float(salt)), vec3(127.1, 311.7, 74.7))).mul(43758.5453));
}

function hashLobe(TSL, cell, li, salt) {
  const { fract, sin, dot, vec3, float } = TSL;
  return fract(sin(dot(vec3(cell.x, cell.y, li.mul(float(1.618)).add(float(salt))), vec3(269.5, 183.3, 246.1))).mul(43758.5453));
}

/**
 * A cell's cloud, as nodes: does it exist, where is it, how big, which way does it lie, how high is it, and how
 * strongly is it faded by the domain edge. Inlined at each use (cheap ALU; the loops are real loops).
 */
function cloudOf(TSL, u, wind, cell) {
  const { float, vec2, vec3, smoothstep, mix, clamp, max, min, cos, sin, dot, sqrt, select, mx_noise_float } = TSL;
  const spacing = u.deck.x;
  const h0 = hash3(TSL, cell, 0.37);
  // REGIONS (2026-11-03, author: "varying shapes and sizes with varying sizes of gap between them"): a slow noise
  // over the grid gathers clouds into clusters (more cells filled, bigger clouds) and opens wide clear stretches
  // elsewhere, so the gaps are never one even spacing.
  const region = mx_noise_float(vec2(cell.x.mul(0.31).add(2.2), cell.y.mul(0.31).add(7.7)));
  const fillHere = clamp(u.deck.z.mul(float(1).add(region.mul(0.9))), 0, 1);
  const sizeHere = float(1).add(region.mul(0.3));
  // Lie along the wind, ±35°.
  const yaw = hash3(TSL, cell, 4.41).sub(0.5).mul(1.2);
  const cy = cos(yaw);
  const sy = sin(yaw);
  const along = vec2(wind.dir.x.mul(cy).sub(wind.dir.y.mul(sy)), wind.dir.x.mul(sy).add(wind.dir.y.mul(cy)));
  const across = vec2(along.y.negate(), along.x);
  // Every cloud its own shape: round puffs to long loaves, longer still for streaky types (`deck.w`).
  const stretch = float(1).add(hash3(TSL, cell, 5.03).mul(float(0.4).add(u.deck.w)));
  // Size varies cloud to cloud, and a long cloud is a narrower one so its reach stays inside the cell.
  const cap = spacing.mul(STORYBOOK_MAX_REACH_FRAC / STORYBOOK_REACH_RADII).div(stretch);
  const R0 = min(u.deck.y.mul(sqrt(hash3(TSL, cell, 3.17)).mul(0.65).add(0.35)).mul(sizeHere), cap);
  // A small cloud leaves slack in its cell, and spends it wandering: neighbours drift close or far apart.
  const slack = max(spacing.mul(STORYBOOK_MAX_REACH_FRAC).sub(R0.mul(STORYBOOK_REACH_RADII).mul(stretch)), float(0)).div(spacing);
  const jit = slack.mul(1.6).add(STORYBOOK_JITTER);
  const jx = hash3(TSL, cell, 1.91).sub(0.5).mul(jit);
  const jy = hash3(TSL, cell, 2.73).sub(0.5).mul(jit);
  const centre = cell.add(vec2(0.5, 0.5)).add(vec2(jx, jy)).mul(spacing).add(wind.drift);
  // The dome: high over the board's middle, sinking past its edge (never below 6% of the base height).
  const rel = centre.sub(u.domeCentre).div(max(u.deck2.z, float(1)));
  const dome = float(1).sub(min(dot(rel, rel), float(1.7)));
  const z = max(u.deck2.x.add(u.deck2.y.mul(dome)), u.deck2.x.mul(0.06));
  // Domain fade by the cloud's own centre — a whole cloud fades, never a cut-off half.
  const d = u.domain;
  const inset = min(min(centre.x.sub(d.x), d.z.sub(centre.x)), min(centre.y.sub(d.y), d.w.sub(centre.y)));
  const edgeFade = smoothstep(float(0), max(u.domain2.x, float(1)), inset);
  // A cloud near the domain's edge SHRINKS away (a puff dissolving) and only fades in its last third — a
  // half-transparent cartoon cloud reads as a grey ghost, not as a cloud far away.
  // FRAGMENTS: some empty cells hold a small torn scrap of cloud instead (the reference's little shards between
  // the big heads) - variety of size is half of what reads as depth. None at cover 0.
  const fragShare = min(u.domain2.w.mul(4), float(1)).mul(0.3);
  const isFrag = h0.greaterThanEqual(fillHere);
  const R = R0.mul(mix(float(0.3), float(1), edgeFade)).mul(select(isFrag, float(0.32), float(1)));
  const fade = smoothstep(float(0), float(0.35), edgeFade);
  const exists = h0.lessThan(fillHere.add(fragShare)).and(fade.greaterThan(float(0.001)));
  return { exists, centre, R, along, across, stretch, z, fade, seed: h0 };
}

/**
 * Lobe `li` of a cloud: world centre (vec3) and horizontal radius.
 *   - li 0, the CROWN: the biggest, highest lobe, nudged off-centre so the mass is lopsided like a real heap.
 *   - li 1-6, INNER MASSES: big overlapping lobes round the crown at uneven angles and distances — the
 *     cauliflower's main bumps. Their creases with the crown are the interior ink lines.
 *   - li 7-16, EDGE BUMPS: ten small low lobes round an uneven ellipse — the scalloped silhouette Crosshead
 *     gives every canopy. One in six is left out, so the scallops are irregular and no two clouds match.
 * Lobes breathe slowly (±6% radius) so a still cloud is never a sticker.
 */
function lobeOf(TSL, u, cloud, cell, li) {
  const { float, vec3, mix, step, cos, sin } = TSL;
  const inner = step(float(0.5), li).mul(float(1).sub(step(float(6.5), li)));
  const edge = step(float(6.5), li);
  const crown = float(1).sub(inner).sub(edge);
  const h1 = hashLobe(TSL, cell, li, 0.11);
  const h2 = hashLobe(TSL, cell, li, 0.53);
  const h3 = hashLobe(TSL, cell, li, 0.97);
  const h4 = hashLobe(TSL, cell, li, 1.39);
  const spin = cloud.seed.mul(float(6.283));
  // Evenly spaced angles plus jitter (a golden-angle spiral clumped lobes on one side and read as popcorn).
  // Wide jitter (2026-11-03, author: "a bit more chaotic ... less cute"): no lobe sits where a pattern expects it.
  const innerAng = li.sub(1).mul(float(Math.PI / 3)).add(h1.sub(0.5).mul(float(1.3)));
  const edgeAng = li.sub(7).mul(float(Math.PI / 5)).add(h1.sub(0.5).mul(float(0.9)));
  const ang = inner.mul(innerAng).add(edge.mul(edgeAng)).add(crown.mul(h1.mul(float(6.283)))).add(spin);
  // The edge ellipse wobbles twice round (a bean, a kidney, a heap) — per cloud, from its seed.
  const wob = sin(ang.mul(float(2)).add(cloud.seed.mul(float(17.0)))).mul(float(0.1)).add(h4.sub(0.5).mul(float(0.12)));
  const rho = crown
    .mul(mix(float(0.0), float(0.24), h2))
    .add(inner.mul(mix(float(0.3), float(0.46), h2)))
    .add(edge.mul(mix(float(0.6), float(0.72), h2).add(wob)));
  const kept = float(1).sub(edge.mul(step(h4, float(0.17))));
  const breathe = float(1).add(sin(u.deck2.w.mul(float(0.35)).add(li.mul(float(1.7))).add(h3.mul(float(6.283)))).mul(float(0.06)));
  const rUnit = crown
    .mul(mix(float(0.44), float(0.52), h3))
    .add(inner.mul(mix(float(0.33), float(0.45), h3)))
    .add(edge.mul(mix(float(0.15), float(0.36), h3.mul(h3))));
  const zUnit = crown
    .mul(float(0.46))
    .add(inner.mul(mix(float(0.12), float(0.4), h4)))
    .add(edge.mul(mix(float(-0.04), float(0.1), h4)));
  // Lobes spread along the cloud's long axis, and the lobes themselves fatten with it, so a long cloud stays
  // one body instead of pulling apart into beads.
  const lx = rho.mul(cos(ang)).mul(cloud.stretch);
  const ly = rho.mul(sin(ang));
  const xy = cloud.centre.add(cloud.along.mul(lx.mul(cloud.R))).add(cloud.across.mul(ly.mul(cloud.R)));
  const r = rUnit.mul(cloud.R).mul(breathe).mul(kept).mul(cloud.stretch.sqrt());
  return { C: vec3(xy.x, xy.y, cloud.z.add(zUnit.mul(cloud.R))), r };
}

/**
 * THE TRAILS (2026-11-03, author: "adding lots of trails at different low opacities ... the trails sometimes
 * develop chunks missing out of them ... clouds and trails melt into each other"). Three per cloud, each its own
 * length, width, side offset, opacity, tone and HEIGHT (the farther, lower ones are paler and slide less as the
 * view pans). Each is a long torn comet trailing upwind (the main one also leads a short way downwind): a broad
 * body thinning to its tip, edges torn by axis-stretched noise, split into several points near the tip, and
 * bitten by rounded chunks (cellular noise). The main trail grows out of the head's UNDER-MASS — a ragged pad in
 * the shadow tone under and behind the head — so a cloud and its trail are one form. Evaluated in 2-D at `xy`
 * in the trail's own plane. JS-time `k` picks the trail (the parameters are constants per trail).
 * Returns vec4(trail coverage, light streak, under-mass coverage, 0).
 */
export const STORYBOOK_TRAILS = Object.freeze([
  Object.freeze({ len: [2.4, 4.2], width: 1.2, side: 0, opacity: 0.75, drop: 0.25, tone: 0.3, front: true }),
  Object.freeze({ len: [1.6, 3.2], width: 0.8, side: 0.55, opacity: 0.5, drop: 0.42, tone: 0.45, front: false }),
  Object.freeze({ len: [2.6, 4.4], width: 0.6, side: -0.6, opacity: 0.36, drop: 0.6, tone: 0.62, front: false }),
]);

/** One parameter of trail `kf` (a float node 0..2), from the table — a select chain, so the trail loop can be a
 * real loop over `kf` instead of three pasted copies of the trail. */
export function trailParam(TSL, kf, pick) {
  const { float, select } = TSL;
  const v = STORYBOOK_TRAILS.map((t) => float(pick(t)));
  return select(kf.lessThan(float(0.5)), v[0], select(kf.lessThan(float(1.5)), v[1], v[2]));
}

function trailOf(TSL, u, cloud, cell, xy, kf) {
  const { float, vec2, vec3, vec4, mix, clamp, min, max, abs, pow, length, smoothstep, select, dot, step } = TSL;
  const { mx_noise_float, mx_worley_noise_float } = TSL;
  const P = (pick) => trailParam(TSL, kf, pick);
  const isMain = float(1).sub(step(float(0.5), kf));
  const R = max(cloud.R, float(1));
  const rel = xy.sub(cloud.centre);
  const sAx = dot(rel, cloud.along).div(R);
  const aAx = dot(rel, cloud.across).div(R);
  const hT = hashLobe(TSL, cell, kf, 6.13);
  const hB = hashLobe(TSL, cell, kf, 6.71);
  const hS = hashLobe(TSL, cell, kf, 7.9);
  const tails = u.style2.w.mul(mix(float(0.55), float(1.3), u.domain2.w));
  const Lb = min(mix(P((t) => t.len[0]), P((t) => t.len[1]), hT).mul(tails), u.deck.x.mul(0.8).div(R)).max(float(0.2));
  const behind = sAx.lessThan(float(0));
  // Only the main trail leads downwind; the others have no front (t past the tip there).
  const Lf = mix(float(0.45), float(1.1), hB).mul(tails).max(float(0.1));
  const tFront = select(isMain.greaterThan(float(0.5)), sAx.div(Lf), float(2));
  const t = clamp(select(behind, sAx.negate().div(Lb), tFront), 0, 1.3);
  const bend = hB.sub(0.5).mul(1.6);
  const side = P((t) => t.side).mul(hS.mul(0.8).add(0.6));
  const centre = side.add(select(behind, bend, bend.mul(-0.5)).mul(t).mul(t));
  const off = aAx.sub(centre);
  const w = pow(float(1).sub(min(t, float(1))), float(1.05)).mul(P((t) => t.width));
  const sd = cloud.seed.add(kf.mul(0.37));
  const nA = mx_noise_float(vec2(sAx.mul(0.7).add(sd.mul(13.7)), off.mul(3.2).add(sd.mul(29.3))));
  const split = mx_noise_float(vec2(sAx.mul(0.35).add(sd.mul(5.3)).add(9.1), off.mul(2.4).add(sd.mul(11.9))));
  // (A finer second tear noise was cut for compile time — 2026-11-03, the bites carry the detail now.)
  const ragged = w.mul(float(0.62).add(nA.mul(0.75)));
  const gap = smoothstep(float(0.05), float(0.35), split).mul(smoothstep(float(0.25), float(0.75), t));
  // CHUNKS MISSING: rounded bites (cellular noise, F1 distance) taken out of the trail's body past its root.
  // 2-D cellular noise (a 3x3 search) — the 3-D one searches 27 cells and the D3D compiler unrolls the search.
  const wor = mx_worley_noise_float(vec2(sAx.mul(1.15).add(sd.mul(31.0)), off.mul(2.7).add(sd.mul(17.0))), 1);
  // (1 − smoothstep, never a reversed smoothstep: e0 > e1 is undefined in GLSL/WGSL and carved the whole trail.)
  const bite = float(1).sub(smoothstep(float(0.15), float(0.34), wor)).mul(smoothstep(float(0.12), float(0.38), t));
  const edge = ragged.sub(abs(off)).sub(gap.mul(w).mul(0.9)).sub(bite.mul(w).mul(1.4));
  const cov = smoothstep(float(0), float(0.05), edge).mul(float(1).sub(smoothstep(float(0.95), float(1.15), t)));
  const streak = smoothstep(float(0.1), float(0.45), nA).mul(smoothstep(float(0.04), float(0.2), edge));
  // The UNDER-MASS (main trail only): an ellipse a little upwind of the head and wider than it, its rim torn by
  // the same noise. The main trail's root (width 1.2 R) starts inside it and runs out past it, so the two join
  // without a seam and the trail's broad body still shows.
  const eU = length(vec2(sAx.add(0.2).div(cloud.stretch.mul(0.95)), aAx.div(0.82)));
  const edgeU = float(1).sub(eU).add(nA.mul(0.16)).add(split.mul(0.1));
  const under = smoothstep(float(0), float(0.08), edgeU).mul(isMain);
  return vec4(max(cov, under), streak, under, float(0));
}

/** How far (cloud radii) any trail can reach from its cloud's centre: the trail pass's bounding test. */
function tailReach(TSL, u, cloud) {
  const { float, min, max, mix } = TSL;
  const tails = u.style2.w.mul(mix(float(0.55), float(1.3), u.domain2.w));
  return min(float(4.4).mul(tails), u.deck.x.mul(0.8).div(max(cloud.R, float(1)))).add(2.4);
}

/**
 * THE BACK SHEET: as cover climbs past half, a streaky translucent layer of cloud along the wind fills in
 * beneath the distinct clouds (the layered bands at the foot of the reference) - at cover 1 it carries most of
 * the sky, still torn with gaps. Exactly nothing below half cover. Drifts at 0.8x the deck (it is further
 * away: slower, and lower, so it slides less as the view pans - depth by motion as well as by size).
 * @returns {*} coverage 0..1.
 */
function sheetAt(TSL, u, wind, xy) {
  const { float, vec2, vec3, mix, max, min, smoothstep, dot, sqrt, mx_fractal_noise_float, mx_noise_float } = TSL;
  const amount = smoothstep(float(0.5), float(1.0), u.domain2.w);
  const q = xy.sub(wind.drift.mul(0.8));
  const perp = vec2(wind.dir.y.negate(), wind.dir.x);
  const along0 = dot(q, wind.dir).div(max(u.deck.x.mul(1.4), float(1)));
  const across0 = dot(q, perp).div(max(u.deck.x.mul(0.32), float(1)));
  // Domain-warped, so the bands meander and break like piled stratocumulus rather than ruled slashes.
  // Four noise octaves in all (was nine): the sheet alone cost ~4 s of cold compile in the D3D path.
  const wv = mx_noise_float(vec2(along0.mul(0.6).add(2.7), across0.mul(0.25)));
  const along = along0.add(wv.mul(0.8));
  const across = across0.add(wv.mul(1.1));
  const n = mx_fractal_noise_float(vec2(along.add(4.4), across), 2, 2, 0.5, 1)
    .mul(0.65)
    .add(mx_noise_float(vec2(along.mul(0.35).add(9.2), across.mul(0.2))).mul(0.5));
  const thr = mix(float(0.7), float(0.05), amount);
  const d = u.domain;
  const inset = min(min(xy.x.sub(d.x), d.z.sub(xy.x)), min(xy.y.sub(d.y), d.w.sub(xy.y)));
  const fade = smoothstep(float(0), max(u.domain2.x.mul(1.5), float(1)), inset);
  return smoothstep(thr, thr.add(0.3), n).mul(sqrt(amount)).mul(fade);
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
  const {
    Fn,
    Loop,
    If,
    float,
    int,
    vec2,
    vec3,
    floor,
    sqrt,
    max,
    min,
    clamp,
    smoothstep,
    mix,
    normalize,
    dot,
    length,
    select,
    step,
    mx_noise_float,
  } = TSL;
  const SQ = STORYBOOK_SQUASH;
  const N = STORYBOOK_LOBES;
  const out = Fn(() => {
    // THE FISHEYE: a barrel warp of the deck about the eye (the view centre) — the middle of the view swells,
    // the rim is gathered in — on top of the world dome below. `style2.z` = 0 is the identity.
    const fromEye = groundXY.sub(u.eye.xy);
    const r2 = dot(fromEye, fromEye).div(max(u.eye.z.mul(u.eye.z).mul(0.25), float(1)));
    const lensXY = u.eye.xy.add(fromEye.mul(float(1).add(u.style2.z.mul(r2))));
    const G = vec3(lensXY.x, lensXY.y, float(0));
    const D = normalize(u.eye.sub(G)).toVar('sbD');
    const Ds = vec3(D.x, D.y, D.z.div(float(SQ))).toVar('sbDs');
    const aa = dot(Ds, Ds).toVar('sbA');
    // Where does this ray cross the deck? (its dome height at the ground point, plus half a crown.)
    const rel0 = lensXY.sub(u.domeCentre).div(max(u.deck2.z, float(1)));
    const zLook = u.deck2.x
      .add(u.deck2.y.mul(float(1).sub(min(dot(rel0, rel0), float(1.7)))))
      .add(u.deck.y.mul(float(0.3)))
      .max(float(0));
    const Pm = lensXY.add(D.xy.mul(zLook.div(max(D.z, float(0.05)))));
    const cellBase = floor(Pm.sub(wind.drift).div(u.deck.x).sub(vec2(0.5, 0.5))).toVar('sbCellBase');

    const bestT = float(-1).toVar('sbBestT');
    const secondT = float(-1).toVar('sbSecondT');
    const bestEdge = float(0).toVar('sbBestEdge');
    const bestC = vec3(0, 0, 0).toVar('sbBestC');
    const bestR = float(1).toVar('sbBestR');
    const bestCell = vec2(0, 0).toVar('sbBestCell');
    const bestLobe = float(0).toVar('sbBestLobe');
    const bestCloudZ = float(0).toVar('sbBestCloudZ');
    const bestCloudR = float(1).toVar('sbBestCloudR');
    const bestFade = float(1).toVar('sbBestFade');
    const sdfMin = float(1e9).toVar('sbSdf');
    const sdfFade = float(0).toVar('sbSdfFade');

    Loop({ start: 0, end: u.loops.x, type: 'int', name: 'sbc' }, ({ sbc }) => {
      const ci = float(sbc);
      const cell = cellBase.add(vec2(ci.sub(floor(ci.mul(0.5)).mul(2)), floor(ci.mul(0.5)))).toVar('sbCell');
      const cloud = cloudOf(TSL, u, wind, cell);
      // BOUNDING TEST before seventeen ray casts: where the ray crosses this cloud's mid-height, is it within the
      // cloud's reach (plus the ray's drift across the cloud's own thickness, plus an AA margin)? Most pixels
      // are sky between clouds and stop here.
      const tMid = cloud.z.add(cloud.R.mul(0.3)).div(max(D.z, float(0.05)));
      const across0 = G.xy.add(D.xy.mul(tMid)).sub(cloud.centre);
      const slope = length(D.xy).div(max(D.z, float(0.05)));
      const reach = cloud.R.mul(float(STORYBOOK_REACH_RADII).mul(cloud.stretch).add(0.15)).add(cloud.R.mul(0.6).mul(slope));
      If(cloud.exists.and(length(across0).lessThan(reach.add(u.deck.y.mul(0.08)).add(u.style2.y.mul(float(6)).mul(2)))), () => {
        Loop({ start: 0, end: u.loops.y, type: 'int', name: 'sbl' }, ({ sbl }) => {
          const li = float(sbl);
          const lobe = lobeOf(TSL, u, cloud, cell, li);
          const Cs = vec3(lobe.C.x, lobe.C.y, lobe.C.z.div(float(SQ)));
          const oc = G.sub(Cs);
          const b = dot(oc, Ds);
          const cc = dot(oc, oc).sub(lobe.r.mul(lobe.r));
          const disc = b.mul(b).sub(aa.mul(cc));
          const perp = sqrt(max(dot(oc, oc).sub(b.mul(b).div(aa)), float(0)));
          const edge = lobe.r.sub(perp);
          If(lobe.r.greaterThan(float(0.5)), () => {
            If(edge.negate().lessThan(sdfMin), () => {
              sdfMin.assign(edge.negate());
              sdfFade.assign(cloud.fade);
            });
            If(disc.greaterThan(float(0)), () => {
              const tFar = b.negate().add(sqrt(disc)).div(aa);
              If(tFar.greaterThan(bestT), () => {
                secondT.assign(bestT);
                bestT.assign(tFar);
                bestEdge.assign(edge);
                bestC.assign(lobe.C);
                bestR.assign(lobe.r);
                bestCell.assign(cell);
                bestLobe.assign(li);
                bestCloudZ.assign(cloud.z);
                bestCloudR.assign(cloud.R);
                bestFade.assign(cloud.fade);
              }).ElseIf(tFar.greaterThan(secondT), () => {
                secondT.assign(tFar);
              });
            });
          });
        });
      });
    });

    const hit = bestT.greaterThan(float(0));
    const P = G.add(D.mul(max(bestT, float(0)))).toVar('sbP');
    const rel = P.sub(bestC);
    const lobeN = normalize(vec3(rel.x, rel.y, rel.z.div(float(SQ * SQ))));
    // BIG FORM FIRST: a painter shades the whole heap as one rounded mass, then lets the lobes ride on it. The
    // lobe's own normal blended with the normal of one ellipsoid round the whole cloud — without it every
    // edge bump wore its own highlight and the cloud read as a string of pearls.
    const cloud = cloudOf(TSL, u, wind, bestCell);
    const relM = P.sub(vec3(cloud.centre.x, cloud.centre.y, cloud.z));
    const ma = cloud.R.mul(0.9).mul(cloud.stretch);
    const mb = cloud.R.mul(0.9);
    const mc = cloud.R.mul(0.62);
    const gA = dot(relM.xy, cloud.along).div(ma.mul(ma));
    const gB = dot(relM.xy, cloud.across).div(mb.mul(mb));
    const massN = normalize(vec3(cloud.along.mul(gA).add(cloud.across.mul(gB)), relM.z.div(mc.mul(mc))));
    const N0 = normalize(mix(lobeN, massN, float(0.55))).toVar('sbN');
    const L = u.light;

    // THE LOBE SHADOW — a second ray from the hit point toward the light, against the hit cloud's other lobes.
    const occl = float(0).toVar('sbOccl');
    If(hit, () => {
      const Ps = vec3(P.x, P.y, P.z.div(float(SQ)));
      const Ls = vec3(L.x, L.y, L.z.div(float(SQ)));
      const aL = dot(Ls, Ls);
      Loop({ start: 0, end: u.loops.y, type: 'int', name: 'sbs' }, ({ sbs }) => {
        const li = float(sbs);
        If(li.notEqual(bestLobe), () => {
          const lobe = lobeOf(TSL, u, cloud, bestCell, li);
          const Cs = vec3(lobe.C.x, lobe.C.y, lobe.C.z.div(float(SQ)));
          const oc = Ps.sub(Cs);
          const b = dot(oc, Ls);
          const perp = sqrt(max(dot(oc, oc).sub(b.mul(b).div(aL)), float(0)));
          // Ahead of us along the light (b < 0) and the ray passes inside the lobe: a soft-edged occluder.
          const o = float(1).sub(smoothstep(lobe.r.mul(0.72), lobe.r.mul(1.02), perp)).mul(step(b, float(0)));
          occl.assign(max(occl, o.mul(step(float(0.5), lobe.r))));
        });
      });
    });

    // ── CEL SHADING ──────────────────────────────────────────────────────────
    const ndl = dot(N0, L);
    const lit = clamp(ndl.add(0.22).div(1.22), 0, 1).mul(float(1).sub(occl.mul(0.78)));
    // Hand-painted band edges: the thresholds wobble with a lobe-scale noise, so a band edge reads as a brush
    // stroke and not as a contour line.
    const brushP = P.xy.div(max(bestR.mul(0.42), float(1)));
    const brush = mx_noise_float(vec2(brushP.x.add(bestLobe.mul(3.1)), brushP.y.add(bestCell.x.mul(0.37)))).mul(0.2).mul(u.style2.x);
    const fine = mx_noise_float(vec2(brushP.x.mul(3.7).add(11.3), brushP.y.mul(3.7))).mul(0.08).mul(u.style2.x);
    const tone = lit.add(brush).add(fine);
    const s = u.style.w;
    // The thresholds sit at the 20% and 65% quantiles of `lit` over a cloud-shaped ellipsoid under the 30-38°
    // storybook light (measured, 2026-11-03): about a fifth shadow, a third light, the rest body — the split
    // Crosshead's boulders show. A wider light range swung the split from 20% to 55% highlight.
    const toShadow = smoothstep(float(0.3).sub(s), float(0.3).add(s), tone);
    const toHi = smoothstep(float(0.7).sub(s), float(0.7).add(s), tone);
    const col = mix(u.shadow, u.body, toShadow).toVar('sbCol');
    col.assign(mix(col, u.hi, toHi));
    // BROKEN COLOUR (impressionist): dabs of the neighbouring tones laid into each band, so a band is never one
    // flat fill — light flecks in the body, body flecks in the light, a little shadow colour in the body.
    const dab = mx_noise_float(vec2(brushP.x.mul(2.2).add(bestLobe.mul(1.7)).add(5.3), brushP.y.mul(2.2)));
    const dabUp = smoothstep(float(0.18), float(0.5), dab).mul(0.45).mul(u.style2.x).clamp(0, 1);
    const dabDown = float(1).sub(smoothstep(float(-0.5), float(-0.18), dab)).mul(0.35).mul(u.style2.x).clamp(0, 1);
    col.assign(mix(col, mix(u.body, u.hi, toShadow), dabUp));
    col.assign(mix(col, mix(u.shadow, u.body, toHi), dabDown));

    // Low lobes sit in the cloud's own shade (an ambient-occlusion cue that makes the crown stand up).
    const hRel = P.z.sub(bestCloudZ).div(max(bestCloudR, float(1)));
    const ao = float(1).sub(smoothstep(float(0.02), float(0.42), hRel));
    col.assign(mix(col, u.shadow, ao.mul(0.32)));

    // Line widths in WORLD px at the lobe's height: a screen px there is `footprint / M`, M = H / (H − z).
    const M = u.eye.z.div(max(u.eye.z.sub(bestC.z), u.eye.z.mul(0.05)));
    const px = u.style2.y.div(M);
    const lw = px.mul(u.style.x);

    // RAGGED EDGES: the silhouette and every lobe rim pushed in and out by a two-scale noise, so an edge reads
    // as a loaded brush dragged round the form rather than a compass circle. Shared by ink, rim and coverage.
    const ragP = G.xy.div(max(u.deck.y.mul(0.16), float(1)));
    const ragN = mx_noise_float(vec2(ragP.x.add(31.7), ragP.y))
      .mul(0.7)
      .add(mx_noise_float(vec2(ragP.x.mul(3.1).add(17.2), ragP.y.mul(3.1))).mul(0.3));
    const rag = ragN.mul(u.deck.y.mul(0.07)).mul(u.style2.x);
    const edgeR = bestEdge.add(rag);
    const sdfR = sdfMin.sub(rag);

    // The crease between two lobes: the front surface and the one behind it meet (their ray distances agree).
    const dt = select(secondT.greaterThan(float(0)), bestT.sub(secondT), float(1e9));
    const cavity = float(1).sub(smoothstep(float(0), bestR.mul(0.18), dt));
    col.assign(mix(col, u.shadow, cavity.mul(0.4)));

    // The silver lining, painted: a thin light band just inside the ink on the lit side of each lobe.
    const nxy = normalize(N0.xy.add(vec2(1e-5, 1e-5)));
    const lxy = normalize(L.xy.add(vec2(1e-5, 1e-5)));
    const facing = clamp(dot(nxy, lxy).mul(1.4).sub(0.15), 0, 1);
    const rimBand = smoothstep(lw.mul(0.9), lw.mul(1.5), edgeR).mul(float(1).sub(smoothstep(lw.mul(1.9), lw.mul(4.2), edgeR)));
    col.assign(mix(col, u.rim, rimBand.mul(facing).mul(u.style.z)));

    // INK: each lobe's own rim, plus the creases. A little pressure wobble so the line breathes.
    const press = mx_noise_float(vec2(P.x.div(bestR.mul(0.25).max(1)).add(3.7), P.y.div(bestR.mul(0.25).max(1)))).mul(0.25).add(1);
    // Interior lines are thinner than the outline and break here and there, as a brush lifts; the outline itself
    // fades in and out too (a serious comic's line, not a sticker's).
    const lift = smoothstep(float(-0.25), float(0.2), mx_noise_float(vec2(brushP.x.mul(1.3).add(7.9), brushP.y.mul(1.3))));
    const inkRim = float(1).sub(smoothstep(lw.mul(0.45).mul(press), lw.mul(1.0).mul(press), edgeR)).mul(mix(float(0.4), float(1), lift));
    const inkCrease = float(1).sub(smoothstep(lw.mul(0.15), lw.mul(0.7), dt.mul(0.5))).mul(0.75).mul(lift);
    const ink = clamp(max(inkRim, inkCrease).mul(u.style.y), 0, 1);
    col.assign(mix(col, u.ink, ink));

    // Paper grain, the same fine texture the maps carry.
    const grainP = groundXY.div(max(u.style2.y.mul(2.5), float(0.5)));
    const grain = mx_noise_float(vec2(grainP.x.add(23.1), grainP.y)).mul(0.035).mul(u.style2.x);
    col.assign(col.mul(float(1).add(grain)));

    // COVERAGE: inside the union of lobes, antialiased over about one screen px. A pixel just outside every
    // lobe (no hit) but inside the AA band is pure ink — the outline's own outer edge.
    // Feathered, not cut: the edge softens over a few screen px, dithered by the paper grain.
    const aaW = px.mul(float(0.8).add(u.style2.x.mul(1.6))).max(float(0.5));
    const cover = float(1).sub(smoothstep(aaW.negate(), aaW, sdfR.add(grain.mul(aaW).mul(8))));
    // No ink round the AA band any more (author: "The ink outline is probably not needed"): the band takes the
    // head's own light tone.
    const headRgb = select(hit, col, mix(u.body, u.hi, float(0.6)));
    const fade = select(hit, bestFade, sdfFade);
    const headA = cover.mul(fade);

    // THE TRAILS + UNDER-MASSES (middle layers): 3x3 cells (a trail reaches past its own cell). Each trail is
    // tested in its own plane below its head, where THIS pixel's ray crosses that height, so trails at
    // different heights slide against each other and against the heads as the view pans. Farthest first.
    const trailC = vec3(0, 0, 0).toVar('sbTrailC');
    const trailA = float(0).toVar('sbTrailA');
    const underA = float(0).toVar('sbUnderA');
    const q3 = Pm.sub(wind.drift).div(u.deck.x);
    const base3 = floor(q3).sub(vec2(1, 1)).toVar('sbTailBase');
    If(u.style2.w.greaterThan(float(0.001)), () => {
      // ONE flat loop over (cell, trail) pairs, not a trail loop nested in a cell loop: the nested form cost the
      // D3D compiler far more (measured, 2026-11-03). Trails run farthest-first within each cell.
      Loop({ start: 0, end: u.loops.z.mul(u.loops.w), type: 'int', name: 'sbt' }, ({ sbt }) => {
        const idx = float(sbt);
        const ci = floor(idx.div(u.loops.w));
        const kf = u.loops.w.sub(1).sub(idx.sub(ci.mul(u.loops.w)));
        const ty = floor(ci.div(3));
        const cell = base3.add(vec2(ci.sub(ty.mul(3)), ty));
        const cloud = cloudOf(TSL, u, wind, cell);
        const P0 = G.xy.add(D.xy.mul(cloud.z.div(max(D.z, float(0.05)))));
        If(cloud.exists.and(length(P0.sub(cloud.centre)).lessThan(tailReach(TSL, u, cloud).mul(cloud.R).mul(cloud.stretch))), () => {
          {
            const zt = cloud.z.sub(cloud.R.mul(trailParam(TSL, kf, (t) => t.drop))).max(float(0));
            const Pt = G.xy.add(D.xy.mul(zt.div(max(D.z, float(0.05)))));
            const tr = trailOf(TSL, u, cloud, cell, Pt, kf);
            const a = tr.x
              .sub(tr.z)
              .max(0)
              .mul(trailParam(TSL, kf, (t) => t.opacity))
              .mul(cloud.fade)
              .mul(TSL.clamp(u.style2.w, 0, 1));
            const c = mix(mix(u.body, u.hi, trailParam(TSL, kf, (t) => t.tone)), u.hi, tr.y.mul(0.8));
            trailC.assign(c.mul(a).add(trailC.mul(float(1).sub(a))));
            trailA.assign(a.add(trailA.mul(float(1).sub(a))));
            underA.assign(max(underA, tr.z.mul(cloud.fade)));
          }
        });
      });
    });

    // THE BACK SHEET (back layer), lower still.
    const zs = u.deck2.x.mul(0.7);
    const Ps = G.xy.add(D.xy.mul(zs.div(max(D.z, float(0.05)))));
    const sheet = sheetAt(TSL, u, wind, Ps);

    // Back to front, premultiplied "over": the sheet, the trails, the under-masses, the heads. The under-mass
    // is the head's own shadow tone, nearly opaque, so the head's feathered edge melts into it, and it into the
    // main trail, instead of a white ball stuck onto a streak.
    const sheetA = sheet.mul(0.5);
    const sheetC = mix(u.body, u.hi, float(0.3));
    const accC = sheetC.mul(sheetA).toVar('sbAccC');
    const accA = sheetA.toVar('sbAccA');
    accC.assign(trailC.add(accC.mul(float(1).sub(trailA))));
    accA.assign(trailA.add(accA.mul(float(1).sub(trailA))));
    const underK = underA.mul(0.88);
    const underC = mix(u.body, u.shadow, float(0.22));
    accC.assign(underC.mul(underK).add(accC.mul(float(1).sub(underK))));
    accA.assign(underK.add(accA.mul(float(1).sub(underK))));
    accC.assign(headRgb.mul(headA).add(accC.mul(float(1).sub(headA))));
    accA.assign(headA.add(accA.mul(float(1).sub(headA))));
    const rgb = accC.div(max(accA, float(1e-4)));

    // The padding rule without a Table: no cloud over the scene padding (the ground under the pixel decides).
    const bd = u.board;
    const inBoard = step(bd.x, groundXY.x).mul(step(groundXY.x, bd.z)).mul(step(bd.y, groundXY.y)).mul(step(groundXY.y, bd.w));
    const boardGate = mix(float(1), inBoard, u.domain2.y);
    let alpha = accA.mul(boardGate).mul(u.opacity);
    if (visibility) alpha = alpha.mul(visibility);
    return TSL.vec4(rgb, clamp(alpha, 0, 1));
  })();
  return { rgb: out.xyz, alpha: out.w };
}

/**
 * THE STORYBOOK GROUND SHADOW — how much sun survives the storybook deck at a ground point, 1 = full sun. The
 * drop-in for `world/cloud-field.js#buildCloudGroundVisNode` in the shared cloud-shadow cache pass, so every
 * consumer (ambient fill, window, water, every point light's floor) sees the same clouds the tops draw.
 *
 * Painterly, not physical: each lobe throws a flat, soft-edged disc (Crosshead's airbrushed ground halos),
 * stretched along the sun's bearing as the sun drops so a low sun still drags the shadow out. The offset is the
 * world-fixed one every other shadow uses (`projectShadowOffset` at the weather deck's own altitude), never the
 * eye-relative storybook height — a shadow is a fact about the ground and must not slide when the camera zooms.
 *
 * @param {object} TSL
 * @param {object} args
 * @param {*} args.worldXY - vec2 node, the ground point.
 * @param {object} args.u - {@link createStorybookUniforms}.
 * @param {{drift:*, dir:*}} args.wind
 * @param {*} args.offset - vec2 node, world px, cloud → shadow (`uCloudOffset`).
 * @param {*} args.blur - float node, the shadow's soft edge as a fraction of a cloud's radius.
 * @param {*} args.fillShare - float node, `fill/(key+fill)` — the deepest a cloud shadow may go.
 * @returns {*} float node, 0..1.
 */
export function buildStorybookShadowNode(TSL, { worldXY, u, wind, offset, blur, fillShare }) {
  const { Fn, Loop, If, float, vec2, floor, max, min, smoothstep, mix, normalize, dot, length } = TSL;
  const N = STORYBOOK_LOBES;
  return Fn(() => {
    const p = worldXY.sub(offset).toVar('sbsP');
    const cellBase = floor(p.sub(wind.drift).div(u.deck.x).sub(vec2(0.5, 0.5))).toVar('sbsCellBase');
    const offLen = length(offset);
    const od = normalize(offset.add(vec2(1e-3, 0)));
    const op = vec2(od.y.negate(), od.x);
    const sdf = float(1e9).toVar('sbsSdf');
    const fadeAt = float(0).toVar('sbsFade');
    const softAt = float(1).toVar('sbsSoft');
    Loop({ start: 0, end: u.loops.x, type: 'int', name: 'sbsc' }, ({ sbsc }) => {
      const ci = float(sbsc);
      const cell = cellBase.add(vec2(ci.sub(floor(ci.mul(0.5)).mul(2)), floor(ci.mul(0.5)))).toVar('sbsCell');
      const cloud = cloudOf(TSL, u, wind, cell);
      const reachS = cloud.R.mul(float(STORYBOOK_REACH_RADII).mul(cloud.stretch).add(0.15)).mul(2.3).add(max(cloud.R.mul(blur), float(2)));
      If(cloud.exists.and(length(p.sub(cloud.centre)).lessThan(reachS)), () => {
        // A low sun drags the shadow out along its bearing, up to 2.2× (the realistic shadow's streak, in shape).
        const stretch = min(float(1).add(offLen.div(max(cloud.R, float(1))).mul(0.18)), float(2.2));
        Loop({ start: 0, end: u.loops.y, type: 'int', name: 'sbsl' }, ({ sbsl }) => {
          const lobe = lobeOf(TSL, u, cloud, cell, float(sbsl));
          const v = p.sub(lobe.C.xy);
          const d = length(vec2(dot(v, od).div(stretch), dot(v, op))).sub(lobe.r.mul(0.94));
          If(d.lessThan(sdf).and(lobe.r.greaterThan(float(0.5))), () => {
            sdf.assign(d);
            fadeAt.assign(cloud.fade);
            softAt.assign(max(cloud.R.mul(blur), float(2)));
          });
        });
      });
    });
    const headCov = float(1).sub(smoothstep(softAt.negate(), softAt, sdf)).mul(fadeAt);
    // Tails and the back sheet cast lighter shadows (they are thinner cloud), from the same shapes the tops draw.
    const tailCov = float(0).toVar('sbsTail');
    const base3 = floor(p.sub(wind.drift).div(u.deck.x)).sub(vec2(1, 1)).toVar('sbsTailBase');
    If(u.style2.w.greaterThan(float(0.001)), () => {
      Loop({ start: 0, end: u.loops.z, type: 'int', name: 'sbst' }, ({ sbst }) => {
        const ti = float(sbst);
        const ty = floor(ti.div(3));
        const cell = base3.add(vec2(ti.sub(ty.mul(3)), ty));
        const cloud = cloudOf(TSL, u, wind, cell);
        If(cloud.exists.and(length(p.sub(cloud.centre)).lessThan(tailReach(TSL, u, cloud).mul(cloud.R).mul(cloud.stretch))), () => {
          tailCov.assign(max(tailCov, trailOf(TSL, u, cloud, cell, p, float(0)).x.mul(cloud.fade)));
        });
      });
    });
    const cov = max(max(headCov, tailCov.mul(0.5)), sheetAt(TSL, u, wind, p).mul(0.35));
    return mix(float(1), fillShare, cov.mul(u.domain2.z));
  })();
}
