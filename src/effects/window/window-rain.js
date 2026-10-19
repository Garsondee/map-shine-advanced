/**
 * RAIN ON WINDOW LIGHT — the drops. The model in plain JS (the CPU twin, asserted
 * in Node) and its TSL transcription, side by side in one file so they cannot
 * drift. THREE is INJECTED, never imported.
 *
 * ============================================================================
 * WHAT THE EFFECT IS, AND WHAT IT IS NOT
 * ============================================================================
 * The window mask is the light that has already landed on the floor. Rain does
 * not move a sunbeam — but drops on the pane DO lens it: each bead of water
 * bends the light behind it, focuses a bright spot, and darkens its own rim. So
 * this module returns two things per fragment, in the floor's world pixels:
 *
 *   offsetPx  where to read the cookie from instead (a lens: pulls the sample
 *             toward the drop's centre), added to the glass warp in window-render
 *   gain      a brightness multiplier (focus spot, dark rim, thin wet streaks,
 *             and in a storm a slowly moving sheet of water)
 *
 * Both are EXACTLY (0, 0) and 1 when `presence` is 0 (a dry pane), so the dry
 * picture is byte-identical to before this existed.
 *
 * ============================================================================
 * THREE KINDS OF WATER, ONE PER REGIME
 * ============================================================================
 *   SPLATS   every fragment sits in a world-aligned cell; each cell hosts at
 *            most one drop per "cycle". A drop is born with an impact ring
 *            (a crown, ~0.12 s), settles into a round bead that slowly shrinks,
 *            and fades. How many cells are alive is the rain amount; a lingering
 *            `wet` share keeps beads on the glass after the rain stops. A
 *            world-aligned lattice needs no direction, so it cannot tear.
 *   SLIDERS  beads that run down the pane. For a facet direction d (see
 *            `window-rain-field.js`) the frame is rigid: u across, v along d.
 *            Columns of drops stick, then slide, then stick (stick-slip), each
 *            leaving a thin beaded trail. v increases TOWARD the wall (the sill).
 *            A pool near a corner has two facets, A and B; this evaluates the
 *            second frame only where the blend weight w is strictly between 0
 *            and 1 and cross-fades them. No lattice is ever rotated per pixel.
 *   SHEET    in a storm, a slow low-frequency film of water (variable dimming
 *            of 5-16%, a little wobble), advected along d.
 *
 * Time is two clocks pushed from JS: `clock` (sim seconds) and `slideClock`
 * (sim seconds integrated against the CURRENT slide speed). A speed that
 * multiplied absolute time inside the shader would teleport every drop each time
 * the rain intensity changed.
 *
 * `uRainPresence` is a runtime branch on "is there any rain or wet glass at all"
 * - weather changes live and the material is never rebuilt for it, so unlike a
 * feature tier this cannot be decided when the graph is built. Whether rain exists
 * in the shader AT ALL is a JS-time decision (the caller passes the handle or
 * not), which is what `tsl/no-uniform-gates` actually asks for.
 *
 * @module effects/window/window-rain
 */

/** Every tuned constant, shared by the JS twin and the shader. Change one place. */
export const RAIN_TUNE = Object.freeze({
  // splats: FOUR interleaved lattices of world-aligned cells, all nearly the same size (rain on glass is fairly
  // uniform: the author asked for the size of the small drops with a little variation). Slightly different cell sizes
  // keep the four lattices from lining up. Each drop's radius is log-uniform over a factor of ~1.6.
  octScale: [0.85, 1, 1.15, 1.3],
  octSeed: [11, 53, 97, 131],
  cellMul: 5,
  periodMin: 1.2,
  periodSpan: 1.6,
  jitter: 0.4,
  radiusMin: 0.16,
  radiusLog: 0.47,
  // high-frequency noise that breaks a drop up: edge wobble, speckle in its focus, a ragged crown
  noiseFreq: 3.5,
  noiseEdge: 0.3,
  noiseSpeckle: 0.45,
  noiseLens: 0.3,
  growSec: 0.1,
  impactSec: 0.12,
  aliveSoft: 0.08,
  lensK: 1.6,
  causticK: 0.9,
  rimK: 0.55,
  coreShift: 0.22,
  coreSigma: 0.4,
  stretchMax: 1.4,
  impactRingGain: 0.55,
  impactRipple: 0.3,
  // sliders
  colWidthMul: 4,
  colPeriodMul: 6.75,
  stepFrac: 0.6,
  cycleSec: 1.6,
  meander: 0.12,
  headMin: 0.196,
  headSpan: 0.15,
  headStretch: 0.9,
  // motion smear: heads elongate and trails lengthen as the run speed rises to `rateRef`
  headBlur: 1.4,
  trailSpeedGain: 1.2,
  rateRef: 15,
  trailLenMul: 1.47,
  trailWidthMul: 0.3,
  // The grid carries 4x the heads of the old one (columns 1.5x as many, 2.67x as many heads per column) at the
  // old speed and trail length in px. `runBoost*` set how many of those slots are filled: Calm = 1.5x the old
  // running count at no wind, Gale = 4x at full wind. `beadWindCut` thins the stationary beads at full wind.
  runGrid: 4,
  runBoostCalm: 1.5,
  runBoostGale: 4,
  beadWindCut: 0.35,
  // sheet
  sheetScaleMul: 100,
  sheetSpeedPx: 5,
  sheetDim: 0.16,
  sheetWobblePx: 3,
  sheetGust: 0.4,
  sheetGustHz: 2.3,
  // wind carries the running water: px/s the whole film drifts at full wind
  windDriftPx: 140,
  // how much of a bead's smear follows gravity (toward the wall) against the wind
  gravitySmear: 0.8,
  // wind exposure
  windLee: 0.05,
  windWind: 1.6,
  windBase: 0.35,
  windGain: 1.3,
  // limits
  maxOffsetPx: 24,
  maxGain: 2,
  // a drop fades out as its on-screen radius falls through lodLo..lodHi px (screen px = world px * 1920 / viewSpan)
  lodRefPx: 1920,
  lodLo: 0.3,
  lodHi: 0.8,
});

/** Look defaults, mirroring `WINDOW_PARAMS.rain*` (window.js quotes these). */
export const WINDOW_RAIN_DEFAULTS = Object.freeze({
  // 2026-10-19 author's Studio export (was 1 / 1.2 / 1 / 1 / 0.8 / 0.35 / 0.7 / 1 / 0.6 / 0.35 / 0.6 / 0.6 / 40)
  response: 2,
  dropScalePx: 4.9,
  splatDensity: 2,
  refraction: 0.99,
  caustic: 1.81,
  rimDarken: 0.2,
  sliders: 1,
  slideSpeed: 0.99,
  trail: 1,
  projectionStretch: 1,
  windwardBias: 1,
  sheeting: 1,
  lingerSec: 40,
});

// ═══════════════════════════════════════════════════════════════════════════
// THE JS TWIN
// ═══════════════════════════════════════════════════════════════════════════

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;

const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const modp = (x, m) => x - m * Math.floor(x / m);

/**
 * A 32-bit integer hash of four int32 inputs (a murmur-style finaliser). EVERY operation is exact: `Math.imul`
 * here and a wrapping u32 multiply in the shader give the same bits, so the CPU twin and the GPU agree to the last
 * bit, and every player's GPU draws the SAME drops.
 *
 * It replaced a float "sine-free" hash. That one looked fine but could not serve as an oracle: its last multiply is
 * of two numbers near 1e2 (about 2e4 in float32, where the spacing is 2e-3), so the GPU's hash differed from the
 * twin's by ~3e-3, and a bead's cycle index (floor of clock / period, the period itself a hash) then flipped in
 * ~8% of cells by t = 100 s. Parity could only ever be statistical; now it is exact.
 *
 * @param {number} a @param {number} b @param {number} c @param {number} d - integers (taken as int32)
 * @returns {number} uint32
 */
export function hashU32(a, b, c, d) {
  let h =
    Math.imul(a | 0, 0x9e3779b1) ^
    Math.imul(b | 0, 0x85ebca77) ^
    Math.imul(c | 0, 0xc2b2ae3d) ^
    Math.imul(d | 0, 0x27d4eb2f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The top 24 bits as a float in [0, 1): exactly representable in float32, so the shader's value is this one. */
const unit24 = (h) => (h >>> 8) / 16777216;

/**
 * Two independent uniform numbers for the same four integers.
 * @returns {[number, number]}
 */
export function hash2(a, b, c, d) {
  return [unit24(hashU32(a, b, c, d)), unit24(hashU32(a, b, c, (d + 0x632be5ab) | 0))];
}

/**
 * What kind of falling water counts as rain on glass. `precipMixWeight` is the
 * COLD share (1 = all snow), so sleet is partly rain and everything else is none.
 * @param {string} kind @param {number} mixWeight @returns {number} 0..1
 */
export function rainKindWeight(kind, mixWeight) {
  if (kind === 'rain') return 1;
  if (kind === 'sleet') return clamp01(1 - (Number.isFinite(mixWeight) ? mixWeight : 0));
  return 0;
}

/**
 * The glass's own wetness: rises in ~8 s of rain, then lingers `lingerSec`
 * (an e-fold time) after it stops, never below what the current rain holds.
 * (`env.weather.wetness01` is a dead field - nothing writes it.)
 * @param {number} wet01 @param {number} rain01 @param {number} dtSec @param {number} lingerSec
 * @returns {number}
 */
export function stepWindowWetness(wet01, rain01, dtSec, lingerSec) {
  const dt = clamp(Number.isFinite(dtSec) ? dtSec : 0, 0, 5);
  const wet = clamp01(Number.isFinite(wet01) ? wet01 : 0);
  const target = clamp01(rain01 * 1.6);
  if (target > wet) return wet + (target - wet) * (1 - Math.exp(-dt / 8));
  const linger = Math.max(1, Number.isFinite(lingerSec) ? lingerSec : WINDOW_RAIN_DEFAULTS.lingerSec);
  return Math.max(target, wet * Math.exp(-dt / linger));
}

/**
 * Weather and the author's dials, resolved to the numbers the shader reads.
 * Pure: the subsystem calls this once per frame and pushes the result.
 *
 * @param {object} a
 * @param {number} a.rain01 - precipitation of the right kind, already x response.
 * @param {number} a.wet01
 * @param {object} a.look - `WINDOW_RAIN_DEFAULTS` shape.
 * @param {number} [a.windSpeed01]
 * @param {number} [a.gust01] - wind gustiness; flickers the storm sheet.
 * @returns {{cover:number, live:number, impact:number, slider:number, sheet:number, gust:number, dim:number, windBias:number, presence:number, slideSpeedMul:number}}
 */
export function resolveRainFrame({ rain01, wet01, look, windSpeed01 = 0, gust01 = 0 }) {
  const rain = clamp01(rain01);
  const wet = clamp01(wet01);
  const dens = Math.max(0, look.splatDensity);
  const windPush = clamp01(windSpeed01);
  const cover = clamp01(1.0 * Math.pow(rain, 0.85) * dens + 0.26 * wet * dens) * (1 - RAIN_TUNE.beadWindCut * windPush);
  // coverage of the 4x finer run grid: the old coverage x boost/grid, so the running count is `boost` x the old one
  const runBoost = lerp(RAIN_TUNE.runBoostCalm, RAIN_TUNE.runBoostGale, windPush);
  const slider =
    (clamp01(look.sliders * 1.4 * smoothstep(0.08, 0.7, Math.max(rain, 0.6 * wet))) * runBoost) / RAIN_TUNE.runGrid;
  const sheet = clamp01(smoothstep(0.55, 1, rain) * look.sheeting);
  return {
    cover,
    live: lerp(0.9, 0.6, rain),
    // the fraction of each slip cycle a run drop sits still: a drizzle drop mostly sticks, a storm drop runs
    stick: lerp(0.55, 0.12, rain),
    impact: smoothstep(0.02, 0.15, rain),
    slider,
    sheet,
    gust: clamp01(gust01),
    dim: 1 - 0.1 * Math.max(rain, 0.6 * wet),
    windBias: windPush * clamp01(look.windwardBias),
    // how hard the wind pushes the water (0..1), whatever the author's windward dial says
    windPush,
    presence: cover > 0.002 || slider > 0.002 || sheet > 0.002 ? 1 : 0,
    // gravity: ten times what it was (a storm's drops run at ~200 px/s)
    slideSpeedMul: 10 * lerp(0.55, 1.5, rain) * Math.max(0, look.slideSpeed),
  };
}

/** How exposed a facet is to the wind-driven rain: windward streams with water, leeward stays nearly dry. */
export function windExposure(dirX, dirY, windFlowX, windFlowY, windBias, kappa) {
  const raw = clamp(
    RAIN_TUNE.windBase - RAIN_TUNE.windGain * (windFlowX * dirX + windFlowY * dirY),
    RAIN_TUNE.windLee,
    RAIN_TUNE.windWind
  );
  return lerp(1, lerp(1, raw, windBias), kappa);
}

const TAU = Math.PI * 2;

/**
 * One layer of splats and beads.
 * @returns {{ox:number, oy:number, gain:number}}
 */
export function evalSplatLayer({ x, y, octave, clock, frame, look, ddx, ddy, paneH, exposure, lod = 1 }) {
  const T = RAIN_TUNE;
  const cellPx = look.dropScalePx * T.octScale[octave] * T.cellMul;
  const seed = T.octSeed[octave];
  const qx = x / cellPx;
  const qy = y / cellPx;
  const cx = Math.floor(qx);
  const cy = Math.floor(qy);
  const fx = qx - cx;
  const fy = qy - cy;
  const h1 = hash2(cx, cy, 0, seed * 4 + 1);
  const period = T.periodMin + T.periodSpan * h1[0];
  const age01 = (clock + h1[1] * period) / period;
  const k = Math.floor(age01);
  const a = age01 - k;
  const tAge = a * period;
  const kw = modp(k, 61) | 0;
  const h2 = hash2(cx, cy, kw, seed * 4 + 2);
  const h3 = hash2(cx, cy, kw, seed * 4 + 3);

  const cover = clamp01(frame.cover * exposure * lerp(0.75, 1.25, paneH));
  const alive = 1 - smoothstep(cover - T.aliveSoft, cover, h2[0]);
  const life = a / frame.live;
  const lifeFade = 1 - smoothstep(0.65, 1, life);
  const vis = alive * lifeFade * (1 - (life >= 1 ? 1 : 0)) * lod;
  if (!(vis > 0.001)) return { ox: 0, oy: 0, gain: 1 };

  const r0 = T.radiusMin * Math.exp(T.radiusLog * h2[1]);
  const grow = smoothstep(0, T.growSec, tAge);
  const r = r0 * (0.55 + 0.45 * grow) * (1 - 0.3 * clamp01(life));

  let dx = fx - (0.5 + (h3[0] - 0.5) * T.jitter);
  let dy = fy - (0.5 + (h3[1] - 0.5) * T.jitter);
  // Elongate along the flow: shrink the along-flow coordinate.
  const stretch = 1 / (1 + T.stretchMax * look.projectionStretch) - 1;
  const along = dx * ddx + dy * ddy;
  dx += ddx * along * stretch;
  dy += ddy * along * stretch;
  // High-frequency noise, in the drop's OWN coordinates (units of its radius), breaks it up: a ragged edge, speckle in
  // the bright focus, a lens that is not perfectly smooth. Per cycle (h3 changes), so every drop is different.
  const nx = dx / r0 + h3[0] * 37;
  const ny = dy / r0 + h3[1] * 41;
  const n1 = 2 * vnoise(nx * T.noiseFreq, ny * T.noiseFreq, seed) - 1;
  const n2 = 2 * vnoise(nx * T.noiseFreq * 2.3 + 11, ny * T.noiseFreq * 2.3 + 5, seed + 1) - 1;
  const dist = Math.hypot(dx, dy) * (1 + T.noiseEdge * n1);
  const dn = dist / r;

  // The bead: a convex lens that pulls the sample toward its centre, a bright focus
  // displaced away from the wall, and a dark rim.
  const bead = 1 - smoothstep(0.92, 1.08, dn);
  const lens = clamp01(1 - dn * dn);
  const sx = dx + ddx * T.coreShift * r;
  const sy = dy + ddy * T.coreShift * r;
  const sig = T.coreSigma * r;
  const core = Math.exp(-(sx * sx + sy * sy) / (sig * sig)) * (1 + T.noiseSpeckle * n2);
  const ring = smoothstep(0.55, 0.85, dn) * (1 - smoothstep(0.92, 1.05, dn));
  const beadGain = 1 + bead * (look.caustic * T.causticK * core - look.rimDarken * T.rimK * ring);
  const lensPx = -cellPx * T.lensK * look.refraction * lens * bead * (1 + T.noiseLens * n2);
  let ox = dx * lensPx;
  let oy = dy * lensPx;

  // The impact: a crown ring that expands and fades, with a 5- and 6-lobed wobble.
  const impEnv = (1 - smoothstep(0, T.impactSec, tAge)) * frame.impact;
  const invD = 1 / (dist + 1e-5);
  const zx = dx * invD;
  const zy = dy * invD;
  const z2x = zx * zx - zy * zy;
  const z2y = 2 * zx * zy;
  const z4x = z2x * z2x - z2y * z2y;
  const z4y = 2 * z2x * z2y;
  const z5x = z4x * zx - z4y * zy;
  const z5y = z4x * zy + z4y * zx;
  const z6x = z4x * z2x - z4y * z2y;
  const z6y = z4x * z2y + z4y * z2x;
  const p1 = TAU * h3[1];
  const p2 = TAU * h2[1];
  const wob = 0.62 * (z5x * Math.cos(p1) - z5y * Math.sin(p1)) + 0.38 * (z6x * Math.cos(p2) - z6y * Math.sin(p2));
  const ringR = r0 * (0.6 + 1.2 * smoothstep(0, T.impactSec, tAge)) * (1 + 0.16 * wob + 0.25 * n1);
  const ringW = 0.35 * r0 + 0.01;
  const ringProfile = Math.exp(-(((dist - ringR) / ringW) ** 2));
  const impGain = 1 + T.impactRingGain * impEnv * ringProfile;
  const ripple = cellPx * T.impactRipple * r0 * impEnv * ringProfile;
  ox += zx * ripple;
  oy += zy * ripple;

  return { ox: ox * vis, oy: oy * vis, gain: 1 + vis * (beadGain * impGain - 1) };
}

/**
 * Smooth value noise in [0, 1): the integer hash at the four lattice corners, smoothstep-interpolated. Exact twin of
 * `vnoiseT` (the hashes are bit-exact; only the final float blend can differ, by ~1e-7).
 */
export function vnoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = unit24(hashU32(ix, iy, seed, 7));
  const b = unit24(hashU32(ix + 1, iy, seed, 7));
  const c = unit24(hashU32(ix, iy + 1, seed, 7));
  const d = unit24(hashU32(ix + 1, iy + 1, seed, 7));
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

/** The wet streak function of a sheet of water: smooth bands, no noise table, so the twin is exact. */
export function filmField(u, v) {
  return (
    0.5 +
    0.25 * Math.sin(1.7 * u + 0.9 * Math.sin(0.8 * v + 1.3)) +
    0.25 * Math.sin(0.6 * u - 1.1 * v + 2 * Math.sin(0.4 * u))
  );
}

/**
 * Everything that lives in ONE rigid facet frame: the sliding columns and the sheet.
 * @returns {{ox:number, oy:number, gain:number}}
 */
export function evalFacetFrame({
  x,
  y,
  dx: dX,
  dy: dY,
  clock,
  slideClock,
  frame,
  look,
  paneH,
  exposure,
  kappa,
  pxPerWorld = 1,
}) {
  const T = RAIN_TUNE;
  const nX = -dY;
  const nY = dX;
  // The facet's identity, as two integers (its direction to 1/50): two facets get different columns of drops.
  const fsx = Math.round(dX * 50);
  const fsy = Math.round(dY * 50);
  const u0 = x * nX + y * nY;
  const v = x * dX + y * dY;
  let ox = 0;
  let oy = 0;
  let gain = 1;

  // ── sliders ───────────────────────────────────────────────────────────────
  const colW = look.dropScalePx * T.colWidthMul;
  const coverCol = clamp01(frame.slider * exposure * kappa);
  if (coverCol > 0.001) {
    const u = u0 / colW;
    const col = Math.floor(u);
    const uf = u - col - 0.5;
    const hc = hash2(col, fsx, fsy, 101);
    const hd = hash2(col, fsx, fsy, 202);
    const active = 1 - smoothstep(coverCol - T.aliveSoft, coverCol, hc[0]);
    const Lc = colW * T.colPeriodMul * (0.8 + 0.5 * hd[0]);
    const off = hd[1] * Lc;
    const speedCol = 0.7 + 0.6 * hc[1];
    const ts = (slideClock * speedCol) / T.cycleSec + hd[0] * 37;
    const cyc = Math.floor(ts);
    const slide = smoothstep(frame.stick, 1, ts - cyc);
    // how fast the water is running, 0..1: smears the head and lengthens its trail
    const speedNorm = clamp01(frame.slideSpeedMul / T.rateRef);
    const phi = (cyc + slide) * T.stepFrac * Lc;
    const sRel = (v - off - phi) / Lc;
    const vh = off + Math.ceil(sRel) * Lc + phi;
    const dv = v - vh; // (-Lc, 0]: the head AHEAD of this pixel has already passed it
    const behind = dv + Lc < -dv;
    const dvHead = behind ? dv + Lc : dv;
    const vHead = v - dvHead;
    const kM = 0.021 + 0.01 * hd[0];
    const phM = TAU * hc[1];
    const m = (vv) => T.meander * Math.sin(vv * kM + phM);
    const ucHead = m(vHead);
    const ucTrail = m(v);
    const rh = colW * (T.headMin + T.headSpan * hc[1]) * (1 + 0.5 * (1 - paneH) * (1 - paneH));
    const rhv = rh * (1 + T.headStretch * look.projectionStretch + T.headBlur * speedNorm);
    const act = active * smoothstep(T.lodLo, T.lodHi, rh * pxPerWorld);
    const ex = ((uf - ucHead) * colW) / rh;
    const ey = dvHead / rhv;
    const hn1 = 2 * vnoise(ex * T.noiseFreq + hc[0] * 41, ey * T.noiseFreq + hd[1] * 43, 202) - 1;
    const hn2 = 2 * vnoise(ex * T.noiseFreq * 2.3 + 7, ey * T.noiseFreq * 2.3 + 3, 203) - 1;
    const dn = Math.hypot(ex, ey) * (1 + T.noiseEdge * hn1);
    const bead = 1 - smoothstep(0.92, 1.08, dn);
    const lens = clamp01(1 - dn * dn);
    const core =
      Math.exp(-(ex * ex + (ey + T.coreShift * 1.3) ** 2) / (T.coreSigma * T.coreSigma)) * (1 + T.noiseSpeckle * hn2);
    const ring = smoothstep(0.55, 0.85, dn) * (1 - smoothstep(0.92, 1.05, dn));
    const headGain = 1 + bead * (look.caustic * T.causticK * core - look.rimDarken * T.rimK * ring);
    const lensK = -T.lensK * look.refraction * lens * bead;
    const offU = ex * rh * lensK;
    const offV = ey * rhv * lensK;
    // The trail: behind the head, thin, beaded, drawing the sample toward its axis.
    const trailLen = look.trail * T.trailLenMul * Lc * (1 + T.trailSpeedGain * speedNorm);
    const tr = trailLen > 1e-3 ? 1 - smoothstep(0, trailLen, -dv) : 0;
    const latPx = (uf - ucTrail) * colW;
    const wT = rh * T.trailWidthMul * (0.75 + 0.5 * (0.5 + 0.5 * Math.sin(dv * 0.12 + TAU * hc[0])));
    const tbreak = clamp01(0.4 + 1.2 * vnoise(dv * 0.25 + hc[0] * 50, latPx * 0.6, 303));
    const tmask = tr * (1 - smoothstep(0.5 * wT, wT, Math.abs(latPx))) * tbreak;
    const offT = -Math.sign(latPx) * Math.min(Math.abs(latPx), wT) * 0.5 * look.refraction * tmask;
    const trailGain = 1 - 0.14 * look.rimDarken * tmask;
    const sliderOffU = offU + offT;
    ox += act * (nX * sliderOffU + dX * offV);
    oy += act * (nY * sliderOffU + dY * offV);
    gain *= 1 + act * (headGain * trailGain - 1);
  }

  // ── the sheet (storm) ─────────────────────────────────────────────────────
  if (frame.sheet > 0.001) {
    const sf = look.dropScalePx * T.sheetScaleMul;
    const film = filmField(u0 / sf, (v - slideClock * T.sheetSpeedPx) / (sf * 2.4));
    const film01 = smoothstep(0.25, 0.85, film);
    const sheet = frame.sheet * Math.max(0, 1 + T.sheetGust * frame.gust * Math.sin(clock * T.sheetGustHz));
    gain *= 1 - T.sheetDim * sheet * film01;
    const wob = (film - 0.5) * T.sheetWobblePx * sheet;
    ox += nX * wob;
    oy += nY * wob;
  }
  return { ox, oy, gain };
}

/** No flow knowledge: splats only, in world orientation. */
export const NO_FLOW = Object.freeze({ px: 0, py: 0, qx: 0, qy: 0, mix: 0, kappa: 0, h: 0.5, gate: 1 });

const unitOrDown = (vx, vy) => {
  const l = Math.hypot(vx, vy);
  return l > 1e-4 ? [vx / l, vy / l] : [0, 1];
};

/**
 * The whole effect at one world pixel - what the shader returns, in plain JS.
 *
 * @param {object} a
 * @param {number} a.x @param {number} a.y - world px.
 * @param {ReturnType<typeof resolveRainFrame> & {windFlowX?:number, windFlowY?:number}} a.frame
 * @param {typeof WINDOW_RAIN_DEFAULTS} a.look
 * @param {number} a.clock - sim seconds.
 * @param {number} a.slideClock - sim seconds integrated against the slide speed.
 * @param {{ax:number,ay:number,bx:number,by:number,w:number,kappa:number,h:number}|null} [a.flow]
 * @param {number} [a.viewSpanPx] - world px across the view; a drop fades out as its on-screen radius shrinks (0 = no fade).
 * @param {number} [a.windShiftX] @param {number} [a.windShiftY] - the wind's integrated drift of the running water, world px.
 * @returns {{offsetX:number, offsetY:number, gain:number}}
 */
export function evalWindowRainPixel({
  x,
  y,
  frame,
  look,
  clock,
  slideClock,
  flow = null,
  viewSpanPx = 0,
  windShiftX = 0,
  windShiftY = 0,
}) {
  if (!(frame.presence > 0.5)) return { offsetX: 0, offsetY: 0, gain: 1 };
  const T = RAIN_TUNE;
  const f = flow ?? NO_FLOW;
  if (!((f.gate ?? 1) > 0.01)) return { offsetX: 0, offsetY: 0, gain: 1 };
  const kappa = f.kappa > 0.01 ? f.kappa : 0;
  const mixS = f.mix;
  const paneH = kappa > 0 ? f.h : 0.5;
  const [bdx, bdy] = unitOrDown(f.px * (1 - mixS) + f.qx * mixS, f.py * (1 - mixS) + f.qy * mixS);
  const exposure =
    kappa > 0 ? windExposure(bdx, bdy, frame.windFlowX ?? 0, frame.windFlowY ?? 0, frame.windBias, kappa) : 1;
  const pxPerWorld = viewSpanPx > 0 ? T.lodRefPx / viewSpanPx : 1;
  // Gravity and wind together: a bead smears along the SUM of "toward the wall" and "where the wind blows".
  const wpush = frame.windPush ?? 0;
  let smx = bdx * kappa * T.gravitySmear + (frame.windFlowX ?? 0) * wpush;
  let smy = bdy * kappa * T.gravitySmear + (frame.windFlowY ?? 0) * wpush;
  const sml = Math.hypot(smx, smy);
  if (sml > 1) {
    smx /= sml;
    smy /= sml;
  }

  let ox = 0;
  let oy = 0;
  let gain = 1;

  // four octaves of splats; the along-flow stretch of a bead grows with the wall-ness
  for (let o = 0; o < 4; o++) {
    const lod = smoothstep(T.lodLo, T.lodHi, look.dropScalePx * T.octScale[o] * pxPerWorld);
    const s = evalSplatLayer({
      x,
      y,
      octave: o,
      clock,
      frame,
      look,
      ddx: smx,
      ddy: smy,
      paneH,
      exposure,
      lod,
    });
    ox += s.ox;
    oy += s.oy;
    gain *= s.gain;
  }

  // The rigid facet frames P (nearest level) and S. Without a direction the sheet still runs, in a world-down frame.
  const [pdx, pdy] = kappa > 0 ? unitOrDown(f.px, f.py) : [0, 1];
  const [sdx, sdy] = kappa > 0 ? unitOrDown(f.qx, f.qy) : [0, 1];
  // the running water is carried by the wind: its whole lattice drifts (an integrated shift, so a change of wind
  // changes the drift speed, never the pattern)
  const common = {
    x: x - windShiftX,
    y: y - windShiftY,
    slideClock,
    frame,
    look,
    paneH,
    exposure,
    kappa,
    clock,
    pxPerWorld,
  };
  if (mixS < 0.999) {
    const A = evalFacetFrame({ ...common, dx: pdx, dy: pdy });
    const wa = 1 - mixS;
    ox += A.ox * wa;
    oy += A.oy * wa;
    gain *= 1 + (A.gain - 1) * wa;
  }
  if (mixS > 0.001) {
    const B = evalFacetFrame({ ...common, dx: sdx, dy: sdy });
    ox += B.ox * mixS;
    oy += B.oy * mixS;
    gain *= 1 + (B.gain - 1) * mixS;
  }

  const len = Math.hypot(ox, oy);
  const scale = len > T.maxOffsetPx ? T.maxOffsetPx / len : 1;
  return {
    offsetX: ox * scale,
    offsetY: oy * scale,
    gain: clamp(gain * frame.dim, 0, T.maxGain),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE TSL TRANSCRIPTION — line for line the twin above, in shader nodes.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the rain handle: its uniforms, its setters, and `build()`, which
 * constructs the shader nodes. `build()` may be called more than once (the glass
 * cookie is built ungated for the debug material and again, deferred, inside the
 * gated `Fn`), and every call constructs its own nodes; the uniforms are shared.
 *
 * @param {object} args
 * @param {*} args.THREE - injected, never imported.
 * @param {*} args.flowDirsTexture - the `dirs` texture of `window-rain-field.js` (a 1x1 neutral one until a field lands).
 * @param {*} args.flowAuxTexture - the `aux` texture.
 * @param {*} [args.viewSpanNode] - world px across the view; fades the small detail out when zoomed far out.
 * @returns {{build: Function, setLook: Function, setFrame: Function, setFlow: Function, flowTexNodeCount: Function}}
 */
export function createWindowRain({ THREE, flowDirsTexture, flowAuxTexture, viewSpanNode = null }) {
  const TSL = THREE.TSL;
  const {
    float,
    int,
    uint,
    vec2,
    vec3,
    uniform,
    texture,
    positionWorld,
    Fn,
    If,
    select,
    mix,
    clamp,
    smoothstep,
    step,
    floor,
    ceil,
    mod,
    sin,
    cos,
    exp,
    abs,
    sign,
    dot,
    length,
    max,
    min,
  } = TSL;
  const T = RAIN_TUNE;
  const D = WINDOW_RAIN_DEFAULTS;
  const F = (x) => float(x);
  const sat = (x) => clamp(x, 0, 1);

  // ── the look: the author's dials ─────────────────────────────────────────
  const uScale = uniform(float(D.dropScalePx));
  const uRefract = uniform(float(D.refraction));
  const uCaustic = uniform(float(D.caustic));
  const uRim = uniform(float(D.rimDarken));
  const uTrail = uniform(float(D.trail));
  const uStretch = uniform(float(D.projectionStretch));
  // ── the weather, resolved by `resolveRainFrame` ──────────────────────────
  const uPresence = uniform(float(0));
  const uCover = uniform(float(0));
  const uStick = uniform(float(0.5));
  const uRate = uniform(float(1));
  const uWindPush = uniform(float(0));
  /** The wind's integrated drift of the running water, world px (CPU-integrated: see `evalWindowRainPixel`). */
  const uWindShift = uniform(vec2(0, 0));
  const uLive = uniform(float(0.9));
  const uImpact = uniform(float(0));
  const uSlider = uniform(float(0));
  const uSheet = uniform(float(0));
  const uGust = uniform(float(0));
  const uDim = uniform(float(1));
  const uWindBias = uniform(float(0));
  const uWindFlow = uniform(vec2(0, 1));
  const uClock = uniform(float(0));
  const uSlideClock = uniform(float(0));
  /** The flow field's world rect as (minX, minY, 1/width, 1/height); all zero until a field lands. */
  const uFlowRect = uniform(TSL.vec4(0, 0, 0, 0));

  // ⚠️ Same trap as the mask taps in window-render: the gated build constructs its texture nodes LATER, deferred
  // inside a TSL Fn, so a node built after `setFlow` must start from the CURRENT textures, not the construction-time
  // ones. `liveDirs`/`liveAux` are what `fetchFlow` reads.
  let liveDirs = flowDirsTexture;
  let liveAux = flowAuxTexture;
  const flowTexNodes = [];

  // ── the integer hash: `hashU32` in u32 nodes. Wrapping multiplies, so it is bit-exact against the twin. ─────
  const U = (n) => uint(n);
  const hashUT = (a, b, c, d) => {
    let h = U(a)
      .mul(U(0x9e3779b1))
      .bitXor(U(b).mul(U(0x85ebca77)))
      .bitXor(U(c).mul(U(0xc2b2ae3d)))
      .bitXor(U(d).mul(U(0x27d4eb2f)));
    h = h.bitXor(h.shiftRight(U(16))).mul(U(0x7feb352d));
    h = h.bitXor(h.shiftRight(U(15))).mul(U(0x846ca68b));
    return h.bitXor(h.shiftRight(U(16)));
  };
  const unit24T = (h) => float(h.shiftRight(U(8))).div(16777216);
  /** Smooth value noise in [0, 1) - `vnoise`. */
  const vnoiseT = (x, y, seed) => {
    const x0 = floor(x);
    const y0 = floor(y);
    const fx = x.sub(x0);
    const fy = y.sub(y0);
    const sx = fx.mul(fx).mul(F(3).sub(fx.mul(2)));
    const sy = fy.mul(fy).mul(F(3).sub(fy.mul(2)));
    const ix = int(x0);
    const iy = int(y0);
    const hv = (i, j) => unit24T(hashUT(i, j, seed, 7));
    return mix(mix(hv(ix, iy), hv(ix.add(1), iy), sx), mix(hv(ix, iy.add(1)), hv(ix.add(1), iy.add(1)), sx), sy);
  };
  const hash2T = (a, b, c, d) => vec2(unit24T(hashUT(a, b, c, d)), unit24T(hashUT(a, b, c, U(d).add(U(0x632be5ab)))));

  /** The flow fetch: both facets, the blend weight, the confidence and the pane height. */
  const fetchFlow = (P) => {
    const uvF = P.sub(uFlowRect.xy).mul(uFlowRect.zw);
    const d = texture(liveDirs, uvF);
    const a = texture(liveAux, uvF);
    flowTexNodes.push(d, a);
    const ds = d.toVar();
    const as = a.toVar();
    return {
      P: vec2(ds.r, ds.g).mul(2).sub(1),
      S: vec2(ds.b, ds.a).mul(2).sub(1),
      mix: as.r,
      kappa: as.g,
      h: as.b,
      gate: as.a,
    };
  };

  const unitOrDownT = (v) => {
    const l = length(v);
    return select(l.greaterThan(1e-4), v.div(max(l, F(1e-4))), vec2(0, 1));
  };

  /** One octave of splats and beads - `evalSplatLayer`. */
  const splatLayerT = (P, octave, dd, paneH, exposure, lod) => {
    const cellPx = uScale.mul(T.octScale[octave] * T.cellMul);
    const seed = T.octSeed[octave];
    const q = P.div(cellPx);
    const cell = floor(q);
    const fr = q.sub(cell);
    const cx = int(cell.x);
    const cy = int(cell.y);
    const h1 = hash2T(cx, cy, 0, seed * 4 + 1);
    const period = F(T.periodMin).add(h1.x.mul(T.periodSpan));
    const age01 = uClock.add(h1.y.mul(period)).div(period);
    const k = floor(age01);
    const a = age01.sub(k);
    const tAge = a.mul(period);
    const kw = int(mod(k, F(61)));
    const h2 = hash2T(cx, cy, kw, seed * 4 + 2);
    const h3 = hash2T(cx, cy, kw, seed * 4 + 3);

    const cover = sat(uCover.mul(exposure).mul(mix(F(0.75), F(1.25), paneH)));
    const alive = F(1).sub(smoothstep(cover.sub(T.aliveSoft), cover, h2.x));
    const life = a.div(uLive);
    const lifeFade = F(1).sub(smoothstep(F(0.65), F(1), life));
    const vis = alive
      .mul(lifeFade)
      .mul(F(1).sub(step(F(1), life)))
      .mul(lod);

    const outOff = vec2(0, 0).toVar();
    const outGain = F(1).toVar();
    If(vis.greaterThan(0.001), () => {
      const r0 = exp(h2.y.mul(T.radiusLog)).mul(T.radiusMin);
      const grow = smoothstep(F(0), F(T.growSec), tAge);
      const r = r0.mul(F(0.55).add(grow.mul(0.45))).mul(F(1).sub(sat(life).mul(0.3)));

      let d = vec2(fr.x.sub(h3.x.sub(0.5).mul(T.jitter).add(0.5)), fr.y.sub(h3.y.sub(0.5).mul(T.jitter).add(0.5)));
      const stretch = F(1)
        .div(F(1).add(uStretch.mul(T.stretchMax)))
        .sub(1);
      const along = dot(d, dd);
      d = d.add(dd.mul(along.mul(stretch)));
      const nx = d.x.div(r0).add(h3.x.mul(37));
      const ny = d.y.div(r0).add(h3.y.mul(41));
      const n1 = vnoiseT(nx.mul(T.noiseFreq), ny.mul(T.noiseFreq), seed).mul(2).sub(1);
      const n2 = vnoiseT(nx.mul(T.noiseFreq * 2.3).add(11), ny.mul(T.noiseFreq * 2.3).add(5), seed + 1)
        .mul(2)
        .sub(1);
      const dist = length(d).mul(F(1).add(n1.mul(T.noiseEdge)));
      const dn = dist.div(r);

      const bead = F(1).sub(smoothstep(F(0.92), F(1.08), dn));
      const lens = sat(F(1).sub(dn.mul(dn)));
      const sc = d.add(dd.mul(r.mul(T.coreShift)));
      const sig = r.mul(T.coreSigma);
      const core = exp(sc.x.mul(sc.x).add(sc.y.mul(sc.y)).div(sig.mul(sig)).negate()).mul(
        F(1).add(n2.mul(T.noiseSpeckle))
      );
      const ring = smoothstep(F(0.55), F(0.85), dn).mul(F(1).sub(smoothstep(F(0.92), F(1.05), dn)));
      const beadGain = F(1).add(bead.mul(uCaustic.mul(T.causticK).mul(core).sub(uRim.mul(T.rimK).mul(ring))));
      const lensPx = uRefract
        .mul(lens)
        .mul(bead)
        .mul(cellPx)
        .mul(-T.lensK)
        .mul(F(1).add(n2.mul(T.noiseLens)));
      const off = d.mul(lensPx).toVar();

      const impEnv = F(1)
        .sub(smoothstep(F(0), F(T.impactSec), tAge))
        .mul(uImpact);
      const zz = d.div(dist.add(1e-5));
      const z2 = vec2(zz.x.mul(zz.x).sub(zz.y.mul(zz.y)), zz.x.mul(zz.y).mul(2));
      const z4 = vec2(z2.x.mul(z2.x).sub(z2.y.mul(z2.y)), z2.x.mul(z2.y).mul(2));
      const z5 = vec2(z4.x.mul(zz.x).sub(z4.y.mul(zz.y)), z4.x.mul(zz.y).add(z4.y.mul(zz.x)));
      const z6 = vec2(z4.x.mul(z2.x).sub(z4.y.mul(z2.y)), z4.x.mul(z2.y).add(z4.y.mul(z2.x)));
      const p1 = h3.y.mul(TAU);
      const p2 = h2.y.mul(TAU);
      const wob = F(0.62)
        .mul(z5.x.mul(cos(p1)).sub(z5.y.mul(sin(p1))))
        .add(F(0.38).mul(z6.x.mul(cos(p2)).sub(z6.y.mul(sin(p2)))));
      const ringR = r0
        .mul(F(0.6).add(smoothstep(F(0), F(T.impactSec), tAge).mul(1.2)))
        .mul(F(1).add(wob.mul(0.16)).add(n1.mul(0.25)));
      const ringW = r0.mul(0.35).add(0.01);
      const rp = dist.sub(ringR).div(ringW);
      const ringProfile = exp(rp.mul(rp).negate());
      const impGain = F(1).add(impEnv.mul(ringProfile).mul(T.impactRingGain));
      const ripple = impEnv.mul(ringProfile).mul(r0).mul(cellPx).mul(T.impactRipple);
      off.addAssign(zz.mul(ripple));

      outOff.assign(off.mul(vis));
      outGain.assign(F(1).add(vis.mul(beadGain.mul(impGain).sub(1))));
    });
    return { off: outOff, gain: outGain };
  };

  /** Everything in one rigid facet frame - `evalFacetFrame`. */
  const facetFrameT = (P, dir, paneH, exposure, kappa, pxPerWorld) => {
    const dX = dir.x;
    const dY = dir.y;
    const nX = dY.negate();
    const nY = dX;
    const fsx = int(floor(dX.mul(50).add(0.5)));
    const fsy = int(floor(dY.mul(50).add(0.5)));
    const u0 = P.x.mul(nX).add(P.y.mul(nY));
    const v = P.x.mul(dX).add(P.y.mul(dY));
    const off = vec2(0, 0).toVar();
    const gain = F(1).toVar();

    // ── sliders ─────────────────────────────────────────────────────────────
    const colW = uScale.mul(T.colWidthMul);
    const coverCol = sat(uSlider.mul(exposure).mul(kappa));
    If(coverCol.greaterThan(0.001), () => {
      const u = u0.div(colW);
      const col = floor(u);
      const uf = u.sub(col).sub(0.5);
      const colI = int(col);
      const hc = hash2T(colI, fsx, fsy, 101);
      const hd = hash2T(colI, fsx, fsy, 202);
      const active = F(1).sub(smoothstep(coverCol.sub(T.aliveSoft), coverCol, hc.x));
      const Lc = colW.mul(T.colPeriodMul).mul(F(0.8).add(hd.x.mul(0.5)));
      const offc = hd.y.mul(Lc);
      const speedCol = F(0.7).add(hc.y.mul(0.6));
      const ts = uSlideClock.mul(speedCol).div(T.cycleSec).add(hd.x.mul(37));
      const cyc = floor(ts);
      const slide = smoothstep(uStick, F(1), ts.sub(cyc));
      const speedNorm = sat(uRate.div(T.rateRef));
      const phi = cyc.add(slide).mul(T.stepFrac).mul(Lc);
      const sRel = v.sub(offc).sub(phi).div(Lc);
      const vh = offc.add(ceil(sRel).mul(Lc)).add(phi);
      const dv = v.sub(vh);
      const behind = F(1).sub(step(dv.negate(), dv.add(Lc)));
      const dvHead = dv.add(Lc.mul(behind));
      const vHead = v.sub(dvHead);
      const kM = F(0.021).add(hd.x.mul(0.01));
      const phM = hc.y.mul(TAU);
      const ucHead = sin(vHead.mul(kM).add(phM)).mul(T.meander);
      const ucTrail = sin(v.mul(kM).add(phM)).mul(T.meander);
      const oneMinusH = F(1).sub(paneH);
      const rh = colW.mul(F(T.headMin).add(hc.y.mul(T.headSpan))).mul(F(1).add(oneMinusH.mul(oneMinusH).mul(0.5)));
      const rhv = rh.mul(F(1).add(uStretch.mul(T.headStretch)).add(speedNorm.mul(T.headBlur)));
      const act = active.mul(smoothstep(F(T.lodLo), F(T.lodHi), rh.mul(pxPerWorld)));
      const ex = uf.sub(ucHead).mul(colW).div(rh);
      const ey = dvHead.div(rhv);
      const hn1 = vnoiseT(ex.mul(T.noiseFreq).add(hc.x.mul(41)), ey.mul(T.noiseFreq).add(hd.y.mul(43)), 202)
        .mul(2)
        .sub(1);
      const hn2 = vnoiseT(ex.mul(T.noiseFreq * 2.3).add(7), ey.mul(T.noiseFreq * 2.3).add(3), 203)
        .mul(2)
        .sub(1);
      const dn = length(vec2(ex, ey)).mul(F(1).add(hn1.mul(T.noiseEdge)));
      const bead = F(1).sub(smoothstep(F(0.92), F(1.08), dn));
      const lens = sat(F(1).sub(dn.mul(dn)));
      const eyc = ey.add(T.coreShift * 1.3);
      const core = exp(
        ex
          .mul(ex)
          .add(eyc.mul(eyc))
          .div(T.coreSigma * T.coreSigma)
          .negate()
      ).mul(F(1).add(hn2.mul(T.noiseSpeckle)));
      const ring = smoothstep(F(0.55), F(0.85), dn).mul(F(1).sub(smoothstep(F(0.92), F(1.05), dn)));
      const headGain = F(1).add(bead.mul(uCaustic.mul(T.causticK).mul(core).sub(uRim.mul(T.rimK).mul(ring))));
      const lensK = uRefract.mul(lens).mul(bead).mul(-T.lensK);
      const offU = ex.mul(rh).mul(lensK);
      const offV = ey.mul(rhv).mul(lensK);
      const trailLen = uTrail
        .mul(T.trailLenMul)
        .mul(Lc)
        .mul(F(1).add(speedNorm.mul(T.trailSpeedGain)));
      const tr = select(
        trailLen.greaterThan(1e-3),
        F(1).sub(smoothstep(F(0), max(trailLen, F(1e-3)), dv.negate())),
        F(0)
      );
      const latPx = uf.sub(ucTrail).mul(colW);
      const wT = rh.mul(T.trailWidthMul).mul(
        F(0.75).add(
          sin(dv.mul(0.12).add(hc.x.mul(TAU)))
            .mul(0.5)
            .add(0.5)
            .mul(0.5)
        )
      );
      const tbreak = sat(
        vnoiseT(dv.mul(0.25).add(hc.x.mul(50)), latPx.mul(0.6), 303)
          .mul(1.2)
          .add(0.4)
      );
      const tmask = tr.mul(F(1).sub(smoothstep(wT.mul(0.5), wT, abs(latPx)))).mul(tbreak);
      const offT = sign(latPx)
        .negate()
        .mul(min(abs(latPx), wT))
        .mul(0.5)
        .mul(uRefract)
        .mul(tmask);
      const trailGain = F(1).sub(uRim.mul(0.14).mul(tmask));
      const sliderOffU = offU.add(offT);
      off.addAssign(vec2(nX.mul(sliderOffU).add(dX.mul(offV)), nY.mul(sliderOffU).add(dY.mul(offV))).mul(act));
      gain.mulAssign(F(1).add(act.mul(headGain.mul(trailGain).sub(1))));
    });

    // ── the sheet (storm) ───────────────────────────────────────────────────
    If(uSheet.greaterThan(0.001), () => {
      const sf = uScale.mul(T.sheetScaleMul);
      const fu = u0.div(sf);
      const fv = v.sub(uSlideClock.mul(T.sheetSpeedPx)).div(sf.mul(2.4));
      const film = F(0.5)
        .add(sin(fu.mul(1.7).add(sin(fv.mul(0.8).add(1.3)).mul(0.9))).mul(0.25))
        .add(
          sin(
            fu
              .mul(0.6)
              .sub(fv.mul(1.1))
              .add(sin(fu.mul(0.4)).mul(2))
          ).mul(0.25)
        );
      const film01 = smoothstep(F(0.25), F(0.85), film);
      const sheet = uSheet.mul(max(F(0), F(1).add(uGust.mul(T.sheetGust).mul(sin(uClock.mul(T.sheetGustHz))))));
      gain.mulAssign(F(1).sub(sheet.mul(film01).mul(T.sheetDim)));
      const wob = film.sub(0.5).mul(T.sheetWobblePx).mul(sheet);
      off.addAssign(vec2(nX.mul(wob), nY.mul(wob)));
    });
    return { off, gain };
  };

  /**
   * Construct the nodes. Everything is inside one `Fn` so its `If()`s are real branches whatever context the
   * caller is in (an `If` outside an `Fn` is a silent no-op).
   * @returns {{offsetPx: *, gain: *, debugFlow: *, debugAux: *, debugDrops: *}}
   */
  function build() {
    const body = Fn(() => {
      const P = positionWorld.xy;
      const result = vec3(0, 0, 1).toVar();
      const fl = fetchFlow(P);
      If(uPresence.greaterThan(0.5).and(fl.gate.greaterThan(0.01)), () => {
        const kappa = select(fl.kappa.greaterThan(0.01), fl.kappa, F(0));
        const paneH = select(kappa.greaterThan(0), fl.h, F(0.5));
        const bdir = unitOrDownT(mix(fl.P, fl.S, fl.mix));
        // gravity and wind together: a bead smears along the sum of "toward the wall" and "where the wind blows"
        const smearRaw = bdir.mul(kappa.mul(T.gravitySmear)).add(uWindFlow.mul(uWindPush));
        const dd = smearRaw.mul(min(F(1), F(1).div(max(length(smearRaw), F(1e-4)))));
        const dirA = select(kappa.greaterThan(0), unitOrDownT(fl.P), vec2(0, 1));
        const dirB = select(kappa.greaterThan(0), unitOrDownT(fl.S), vec2(0, 1));
        const rawExp = clamp(F(T.windBase).sub(dot(uWindFlow, bdir).mul(T.windGain)), T.windLee, T.windWind);
        const exposure = select(kappa.greaterThan(0), mix(F(1), mix(F(1), rawExp, uWindBias), kappa), F(1));
        const pxPerWorld = viewSpanNode ? F(T.lodRefPx).div(max(viewSpanNode, F(1))) : F(1);

        const off = vec2(0, 0).toVar();
        const gain = F(1).toVar();
        for (let o = 0; o < 4; o++) {
          const lod = smoothstep(F(T.lodLo), F(T.lodHi), uScale.mul(T.octScale[o]).mul(pxPerWorld));
          const s = splatLayerT(P, o, dd, paneH, exposure, lod);
          off.addAssign(s.off);
          gain.mulAssign(s.gain);
        }

        const Pw = P.sub(uWindShift);
        const wa = F(1).sub(fl.mix);
        If(fl.mix.lessThan(0.999), () => {
          const A = facetFrameT(Pw, dirA, paneH, exposure, kappa, pxPerWorld);
          off.addAssign(A.off.mul(wa));
          gain.mulAssign(F(1).add(A.gain.sub(1).mul(wa)));
        });
        If(fl.mix.greaterThan(0.001), () => {
          const B = facetFrameT(Pw, dirB, paneH, exposure, kappa, pxPerWorld);
          off.addAssign(B.off.mul(fl.mix));
          gain.mulAssign(F(1).add(B.gain.sub(1).mul(fl.mix)));
        });

        const len = length(off);
        const scale = min(F(1), F(T.maxOffsetPx).div(max(len, F(1e-4))));
        result.assign(vec3(off.x.mul(scale), off.y.mul(scale), clamp(gain.mul(uDim), 0, T.maxGain)));
      });
      return result;
    });
    const packed = body().toVar();

    // The instrument's two views, built from their own fetch so they read the flow even while the pane is dry.
    const flowView = Fn(() => {
      const fl = fetchFlow(positionWorld.xy);
      const dir = unitOrDownT(mix(fl.P, fl.S, fl.mix));
      const k = select(fl.kappa.greaterThan(0.01), F(1), F(0));
      return vec3(dir.x.mul(0.5).add(0.5), dir.y.mul(0.5).add(0.5), fl.h).mul(k);
    })();
    const auxView = Fn(() => {
      const fl = fetchFlow(positionWorld.xy);
      return vec3(fl.mix, fl.kappa, fl.h);
    })();
    return {
      offsetPx: vec2(packed.x, packed.y),
      gain: packed.z,
      debugFlow: flowView,
      debugAux: auxView,
      debugDrops: vec3(
        packed.z.mul(0.5),
        packed.x.div(2 * T.maxOffsetPx).add(0.5),
        packed.y.div(2 * T.maxOffsetPx).add(0.5)
      ),
    };
  }

  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    build,
    /** The author's dials. @param {Partial<typeof WINDOW_RAIN_DEFAULTS>} look */
    setLook(look = {}) {
      uScale.value = Math.max(0.5, num(look.dropScalePx, D.dropScalePx));
      uRefract.value = Math.max(0, num(look.refraction, D.refraction));
      uCaustic.value = Math.max(0, num(look.caustic, D.caustic));
      uRim.value = clamp01(num(look.rimDarken, D.rimDarken));
      uTrail.value = clamp01(num(look.trail, D.trail));
      uStretch.value = clamp01(num(look.projectionStretch, D.projectionStretch));
    },
    /**
     * The weather, once per frame. `frame` is `resolveRainFrame`'s result.
     * @param {ReturnType<typeof resolveRainFrame>} frame
     * @param {{clock:number, slideClock:number, windFlow?: readonly number[]}} clocks
     */
    setFrame(frame, clocks) {
      uPresence.value = frame.presence ? 1 : 0;
      uCover.value = num(frame.cover, 0);
      uStick.value = num(frame.stick, 0.5);
      uRate.value = num(frame.slideSpeedMul, 1);
      uWindPush.value = num(frame.windPush, 0);
      uLive.value = Math.max(0.05, num(frame.live, 0.9));
      uImpact.value = num(frame.impact, 0);
      uSlider.value = num(frame.slider, 0);
      uSheet.value = num(frame.sheet, 0);
      uGust.value = num(frame.gust, 0);
      uDim.value = num(frame.dim, 1);
      uWindBias.value = num(frame.windBias, 0);
      const wf = Array.isArray(clocks.windFlow) ? clocks.windFlow : [0, 1];
      uWindFlow.value.set(num(wf[0], 0), num(wf[1], 1));
      uClock.value = num(clocks.clock, 0);
      uSlideClock.value = num(clocks.slideClock, 0);
      const ws = Array.isArray(clocks.windShift) ? clocks.windShift : [0, 0];
      uWindShift.value.set(num(ws[0], 0), num(ws[1], 0));
    },
    /**
     * The flow field's textures and world rect. Updates every texture node already built AND the textures later
     * builds start from (see `liveDirs`).
     * @param {{dirsTexture:*, auxTexture:*, rect:{x:number,y:number,width:number,height:number}|null}} f
     */
    setFlow({ dirsTexture, auxTexture, rect }) {
      liveDirs = dirsTexture;
      liveAux = auxTexture;
      for (let i = 0; i < flowTexNodes.length; i += 2) {
        flowTexNodes[i].value = dirsTexture;
        flowTexNodes[i + 1].value = auxTexture;
      }
      if (rect && rect.width > 0 && rect.height > 0) {
        uFlowRect.value.set(rect.x, rect.y, 1 / rect.width, 1 / rect.height);
      } else {
        uFlowRect.value.set(0, 0, 0, 0);
      }
    },
    /** TEST/DIAGNOSTIC: how many flow texture nodes exist, so a test can prove `setFlow` reaches all of them. */
    flowTexNodeCount: () => flowTexNodes.length,
    /** TEST/DIAGNOSTIC: every uniform's current value as plain numbers. */
    snapshot: () => ({
      scale: uScale.value,
      refract: uRefract.value,
      caustic: uCaustic.value,
      rim: uRim.value,
      trail: uTrail.value,
      stretch: uStretch.value,
      presence: uPresence.value,
      cover: uCover.value,
      stick: uStick.value,
      rate: uRate.value,
      windPush: uWindPush.value,
      windShift: [uWindShift.value.x, uWindShift.value.y],
      live: uLive.value,
      impact: uImpact.value,
      slider: uSlider.value,
      sheet: uSheet.value,
      gust: uGust.value,
      dim: uDim.value,
      windBias: uWindBias.value,
      windFlow: [uWindFlow.value.x, uWindFlow.value.y],
      clock: uClock.value,
      slideClock: uSlideClock.value,
      flowRect: [uFlowRect.value.x, uFlowRect.value.y, uFlowRect.value.z, uFlowRect.value.w],
    }),
  };
}
