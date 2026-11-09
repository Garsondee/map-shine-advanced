/**
 * FIRE — THE BILLOW MODEL (2026-10-20). Pure maths, no THREE, no TSL, Node-tested.
 *
 * ============================================================================
 * WHY THE FLAME IS BUILT THIS WAY
 * ============================================================================
 *
 * The author's own painted campfires (`Camp_Fire_01..06`, Mythica Machina - Campsites) are the gold standard,
 * and they are NOT soft additive glow. Looked at closely they are a handful of rounded, overlapping DAUBS —
 * deep orange outermost, amber, yellow, a pale cream core — with a lobed, cloud-like edge, a curled tongue
 * where wind has caught them, a scatter of tiny orange flecks flying off, and a faint halo. Every tone is a
 * smaller lobed blob inside the last. The previous fire (four soft bird's-eye sprite archetypes, additive)
 * could never read that way: additive blending dissolves the lobes into one bright haze.
 *
 * So the flame here is a PLUME OF BILLOWS. Each billow is a little sphere with a 3D position (x, y, height),
 * a radius and a temperature. Billows are born hot at the fuel bed, rise, swell, spread outward, cool and
 * shrink to nothing — a thermal plume — while a few chained billows curl out as licking TONGUES, tiny elongated
 * flecks are flung off, and big slow billows of smoke rise above it all. Nothing here is integrated: every
 * billow is a CLOSED-FORM function of the clock (`age = fract((t + phase) / period)`), so a billow can never be
 * flung away by a wind spike, a frame hitch cannot desync the fire, any instant can be rendered on its own
 * (the lab scrubs time), and the same function is the test oracle and the thing that is drawn.
 *
 * The billows are not drawn as sprites. They are SPLATTED into a density field and the field is CONTOURED
 * (`fire-billow-render.js`): overlapping billows merge into one lobed body with cusps between them, the cream
 * core is simply where the density is highest, a dying fire shrinks smoothly toward its coals when the contour
 * level rises, and nothing ever pops. The metaball merge is the look; the particles are the motion.
 *
 * ============================================================================
 * HEIGHT AND THE CAMERA
 * ============================================================================
 *
 * MSA looks straight down through an orthographic camera, so height shows only as parallax: a billow `h` above
 * the ground is `M(h) = D / (D − h)` times larger and displaced that much further from the view centre — what
 * V2's perspective camera did, and what the previous engine already applied per particle. Applied here at emit
 * time. A true SIDE view (`projection: 'side'`) maps (x, height) instead of (x, y); the lab uses it to judge the
 * plume's profile, and it is the same billows.
 *
 * ============================================================================
 * TWO FIRES IN ONE EFFECT
 * ============================================================================
 *
 * One scalar, `outdoor01` (open sky / open to wind), blends two characters. A hearth (0) is low, steady and
 * contained: slow breathing, short stubby tongues, little smoke, and an occasional DRAFT that leans and dips it.
 * A bonfire (1) is tall, wild and fast: long tongues, torn flecks, a big smoke column, and it takes the real wind
 * at full strength — at a hurricane the flame lies down and streams. A hearth whose room opens to a strong wind
 * gets that wind through the same openness gate the rest of the engine uses, so it becomes a bonfire's flame
 * by degrees, never by a switch.
 *
 * @module effects/fire/fire-billow-geometry
 */

// ─────────────────────────────────────────────────────────────────────────────
// SMALL MATHS
// ─────────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;

/** @param {number} v @param {number} lo @param {number} hi */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  if (!(e1 > e0)) return x >= e1 ? 1 : 0;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * Integer hash (lowbias32) — wrapping u32 multiplies, so it is BIT-EXACT between JS and a shader that does the
 * same ops, unlike a `fract(sin(x) * 43758)` float hash, whose last multiply differs by ~1e-3 between float32 and
 * float64 and flips `floor(clock / period)` in a few percent of cells (the window-rain bench measured exactly
 * that). Everything random about a billow comes from here.
 * @param {number} x any integer (wrapped to u32)
 * @returns {number} u32
 */
export function hashU32(x) {
  x = Math.imul((x >>> 0) ^ ((x >>> 0) >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
/** Two- and three-key hashes into [0,1). */
export function hash01(a, b = 0, c = 0) {
  const h = hashU32(
    Math.imul(a | 0, 0x9e3779b1) ^ hashU32(Math.imul(b | 0, 0x85ebca6b) + Math.imul(c | 0, 0xc2b2ae35))
  );
  return h / 4294967296;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PALETTE — measured from the author's art, 2026-10-20
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The flame ramp, hottest first, `t` = temperature 1 → 0. Measured (k-means + luminance-quantile centroids over
 * 14,239 flame pixels) from `Camp_Fire_01/03/04/05/06`: the whole flame is ONE hue band (mean 36°, 20–54°) at
 * saturation 0.85 — it only steps in lightness, cream to deep orange. There is no red and no white in the
 * painted flame; the two stops below `0.2` are for a DYING fire (a cooling flame walks down into coal reds),
 * extrapolated, not measured.
 *
 * ⚠️ sRGB hex as painted. The shader decodes to linear (the frame the flame is drawn into, `scene.lit`, is linear
 * and the canvas re-encodes it) so the flame DISPLAYS as these exact colours. The previous fire fed these
 * straight in as linear and so displayed pale pastel (#FDBA35 became ~#FEDF8E) — part of why it did not read as
 * the painted fire.
 */
export const BILLOW_FLAME_RAMP = Object.freeze([
  Object.freeze({ t: 1.0, hex: '#fede70', role: 'cream core' }),
  Object.freeze({ t: 0.8, hex: '#fdbf3f', role: 'yellow-orange' }),
  Object.freeze({ t: 0.6, hex: '#fba218', role: 'amber' }),
  Object.freeze({ t: 0.4, hex: '#f98e0b', role: 'orange' }),
  Object.freeze({ t: 0.22, hex: '#e27b13', role: 'deep orange rim / crease' }),
  Object.freeze({ t: 0.1, hex: '#b8480f', role: 'dying: rust' }),
  Object.freeze({ t: 0.0, hex: '#6e2208', role: 'dying: coal red' }),
]);

/**
 * Smoke, lit-to-shadow, measured from the painted thermic-lance plumes (Big Bank): WARM white to warm grey, never
 * neutral or blue. `lit` is the peach the smoke goes where the fire lights its underside.
 */
export const BILLOW_SMOKE_RAMP = Object.freeze({
  lit: '#edd2b6',
  highlight: '#f8f0e6',
  mid: '#d5cbc7',
  shade: '#aa9f9b',
  deep: '#89766f',
  /**
   * The two colours smoke is BROKEN into (2026-11-03, painterly pass): a painter never lays one grey, they dab a warm peach
   * and a dusty mauve side by side and let the eye mix them. Both sit at the ramp's own values, so they shift the hue, not the
   * brightness, and both stay warm (red above blue): the painted maps' smoke is never neutral or blue.
   */
  // (2026-11-03 v2: the first pair, peach + mauve, went muddy pink on a brown floor; these are the author's own cream and
  // stone grey, read off the walls and paving of her map)
  dabWarm: '#e9e0d0',
  dabCool: '#9d9893',
  /** the soot a wood fire adds on top (kept subtle: the art's smoke is pale). */
  soot: '#5a4a44',
  /** the line round every billow and the darkest shade of a sooty column: a warm near-black, so the smoke reads on ANY floor. */
  ink: '#352a28',
  /** the shaded flank of a dense billow: dark enough to stand off a bright map, still warm. */
  charcoal: '#6a5c56',
});

/** The fleck colours (measured): the colours of the little sparks scattered over the art. */
export const BILLOW_FLECK_HEX = Object.freeze(['#f7ab39', '#f29419', '#db8013']);

/** The scorch left under a fire (measured): rust-brown, low value. */
export const BILLOW_SCORCH_HEX = Object.freeze(['#603826', '#4c2e21', '#432c21']);

// ─────────────────────────────────────────────────────────────────────────────
// THE TUNABLES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every constant of the model in one frozen object, so the lab can override any of them for a sweep
 * (`emitFireLobes(..., tune)` merges over this) and a test can pin them. Units: fractions of the fire's radius
 * `R` unless a name says otherwise; times in seconds.
 */
export const BILLOW_TUNE = Object.freeze({
  // ── budget (lobes per fire at quality 1) ──
  tongueMin: 0,
  tongueMax: 14,
  tongueLobes: 7,
  fleckBase: 5,
  fleckPerR: 0.07,
  smokeBase: 48,
  smokePerR: 0.35,
  // ── body billows ──
  bodyRadius: 0.66, // plume radius, × R
  bodyLifeMul: 1.1, // × each layer's own cycle
  bodyHeight: 3.0, // flame-tip height, × R (a hearth burns lower, a bonfire stands up)
  // ── tongues ──
  tongueLength: 0.45, // × plume radius
  tongueLobe: 0.4,
  tongueLife: 1.9,
  tongueCurl: 8,
  // ── flecks ──
  fleckLife: 0.8,
  fleckSpeed: 1.6,
  fleckSize: 0.15,
  // ── spit embers: heavy chunks that arc out of the fire, land and smoulder where they fall ──
  spitBase: 2.5,
  spitPerR: 0.03,
  spitLife: 24, // seconds per slot: a flight, then the smoulder
  spitSize: 0.075, // × plume radius
  spitRange: 2.6, // × plume radius of the throw (calm); the wind carries them further
  // ── smoke ──
  // (2026-11-03, author: "a lot bigger and longer as a trail... too thin": roughly twice the life, twice the climb, 1.6x the
  // billow, and 1.45x the billows so the longer column stays one body)
  // (v3, author: "still far too short": twice the climb again, a longer life, and ~1.7x the billows to keep the column whole)
  smokeLife: 13,
  smokeRise: 20, // × R at an open fire (R of a 50 px fire: a smaller fire's plume is relatively taller, see `Rs`)
  smokeSize: 0.92,
  smokeStart: 1.2, // a billow is born this fraction of its full width...
  smokeGrow: 1.6, // ...and grows by this much more as it climbs (a plume SHOULD outgrow its fire)
  smokeWave: 0.55, // × plume radius: how far the whole column meanders as one ribbon in still air (the puffs share one wave)
  // (v3) how much wider an old billow spreads as it dies, thinning as it goes: smoke DISSOLVES, it does not go out puff by puff
  smokeSpread: 2.8,
  massRise: 6, // × the mass's radius: how far a burning building's column climbs
  // THE SMOKE'S CAMERA (v3, author: "no real perspective... at 0 wind it's still flat and heading north, not UPWARDS"). Smoke is
  // seen from the 3/4 view the painted art is drawn in, AND by a real perspective camera: it climbs up the page (`smokeLift` per
  // unit of height above the flame) while it swells toward the viewer and leans out from the middle of the view, so a column is a
  // CONE that widens as it rises, not a flat ribbon. The billow camera is `BILLOW_CAMERA_PER_EYE` (2.2) eyes high; dividing by
  // `smokePerspective` brings it down to the scene's own eye at 2.2 (what walls and canopies use). Higher = a nearer camera.
  smokePerspective: 1.5,
  smokeLift: 2.4,
  smokeDrift: 9.0, // the author's "Smoke wind drift x" dial rides on this: the drift is the bent-over plume's x (smokeDrift / 9)
  // ── wind ──
  leanLength: 2.6, // × plume radius, at full lean
  leanCurve: 1.05,
  leanStreak: 5,
  windShear: 1.8, // extra downwind shear of every flame lobe, x its height x the lean (a gale lays the whole body over, not just the tip)
  windFlatten: 0.6, // how much of its height a flame loses at full lean (the wind presses it down)
  smokeStreak: 3.5, // how far smoke is stretched along the wind at full lean (a plume is a streamer in a gale)
  smokeGrainScale: 2.2, // the size of the smoke's shared grain, x the plume radius (2026-11-08; see `stampSmokeGrain`)
  // ── weather ──
  rainShrink: 0.62, // how much of its size a fully rained-on flame loses
  // ── camera ──
  cameraHeight: 1000,
});

/**
 * The body's three nested rings of billows (see `emitFireLobes`). `rho` is the ring's radius range and `rad` the
 * billow radius, both × the plume radius; `heat` the temperature range; `z` the height range as a fraction of the
 * body height; `life` the cycle in seconds; `swirl` how far a billow turns while it lives. `count` is per fire at
 * R = 50 (it scales gently with size).
 */
const BODY_LAYERS = Object.freeze([
  // the crown: a few billows that rise out of the core and cool as they climb — the flame's tip, soft, not a finger
  Object.freeze({
    count: 3,
    rho: [0.0, 0.3],
    rad: 0.4,
    life: 1.25,
    heat: [0.7, 0.92],
    z: [0.4, 0.8],
    swirl: 0.5,
    weight: 1.0,
  }),
  Object.freeze({
    count: 5,
    rho: [0.0, 0.25],
    rad: 0.5,
    life: 1.0,
    heat: [0.85, 1.0],
    z: [0.12, 0.4],
    swirl: 0.6,
    weight: 1.15,
  }),
  Object.freeze({
    count: 8,
    rho: [0.22, 0.62],
    rad: 0.55,
    life: 1.5,
    heat: [0.5, 0.78],
    z: [0.1, 0.35],
    swirl: 0.9,
    weight: 1.0,
  }),
  Object.freeze({
    count: 12,
    rho: [0.4, 0.62],
    rad: 0.46,
    life: 2.0,
    heat: [0.16, 0.44],
    z: [0.03, 0.2],
    swirl: 1.1,
    weight: 0.95,
  }),
  // the satellites: small quick scallops on the edge, the painted flame's fine ragged detail
  Object.freeze({
    count: 10,
    rho: [0.62, 0.95],
    rad: 0.2,
    life: 0.8,
    heat: [0.1, 0.34],
    z: [0.05, 0.4],
    swirl: 1.6,
    weight: 0.9,
  }),
]);

/** The heart: billows that NEVER respawn (a fire's body has no hole in it), just orbit the fuel and breathe. */
const HEART = Object.freeze({ count: 3, orbit: 0.1, rad: 0.6, heat: 0.92, z: 0.1, weight: 1.1 });

// ─────────────────────────────────────────────────────────────────────────────
// THE LOBE RECORD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Floats per lobe: four vec4 attributes. A = (x, y, radius, strength), B = (heat, stretch, dirX, dirY), C = (kind, tone, across,
 * z), D = (seed, outdoor clip, 0, 0). `seed` (2026-11-06, mmp-9un.6) is a smoke puff's own 0..1 random, constant for its whole life, so the
 * painterly grain is drawn in the puff's own frame and travels with it instead of sitting still on the map.
 */
export const LOBE_STRIDE = 16;
export const KIND_FLAME = 0;
export const KIND_SMOKE = 1;
export const KIND_COAL = 2;

/** Pool offsets inside one lobe's record, for readers. */
export const LOBE = Object.freeze({
  X: 0,
  Y: 1,
  R: 2,
  STRENGTH: 3,
  HEAT: 4,
  STRETCH: 5,
  DIRX: 6,
  DIRY: 7,
  KIND: 8,
  TONE: 9,
});

// ─────────────────────────────────────────────────────────────────────────────
// FIRE-LEVEL QUANTITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE PLUME'S OWN RISE SPEED, m/s (2026-11-09, mmp-vm1.1.6). A buoyant plume bends over until its slope is its rise speed
 * over the wind (Briggs, *Plume Rise*, 1969: the bent-over plume), and a ~1 m campfire's plume climbs ~2.5-3.7 m/s a few
 * metres up (McCaffrey 1979). The drawn plume climbs in slow motion (`smokeRise` over `smokeLife`), so it drifts in the SAME
 * slow motion: its angle from upright is atan(U / FIRE_PLUME_RISE_MPS) whatever the stylised speeds (Ingram, live,
 * 2026-11-09: the smoke "doesn't respond to wind very accurately" — at 10.5 m/s it rose almost straight up the page).
 */
export const FIRE_PLUME_RISE_MPS = 3;
/** The same for a burning building's column: megawatts, a much stiffer plume. */
export const MASS_PLUME_RISE_MPS = 6;
/** With no air speed given (old callers, tests), a wind push of 1 is read as this many m/s (a gale). */
export const LEGACY_FULL_WIND_MPS = 20;

/**
 * How fast a plume climbs in a wind, against still air (0..1): a bent-over plume's rise in time goes as U^-1/3 (Briggs's
 * "2/3 law", dh = 1.6 F^(1/3) x^(2/3) / U with x = U t). A gale lays the smoke along the ground; it does not stop it rising.
 * @param {number} windMps @param {number} [riseMps]
 */
export function plumeRiseRate(windMps, riseMps = FIRE_PLUME_RISE_MPS) {
  const u = Math.max(0, Number(windMps) || 0);
  return Math.pow(1 + u / Math.max(0.1, riseMps), -1 / 3);
}

/**
 * The drawn plume's middle sits lower and nearer the fire than its mean billow's path (the young billows by the base are
 * the densest), so steady air leaned it atan(U / 3.9 m/s), not atan(U / 3): measured offline over 200 frames of a 45 px fire
 * at 2.5-17.5 m/s (1.25-1.4x). This brings the drawn plume onto the bent-over plume (`__tests__`: "the smoke leans
 * atan(U / FIRE_PLUME_RISE_MPS)").
 */
const PLUME_DRIFT_CAL = 1.3;

/**
 * THE FLAME'S TILT IN A WIND, deg from upright (2026-11-09, mmp-vm1.1.6): the AGA flame-tilt correlation (SFPE Handbook,
 * pool fires), cos(tilt) = sqrt(u_c / U) above the fire's own characteristic speed u_c, upright below it. u_c grows as the
 * cube root of the fire's size (u_c = (g Q / (rho c_p T D))^(1/3) with Q ~ D^2): ~0.8 m/s for a 0.9 m campfire, ~0.3 for a
 * candle, ~1.2 for a 3 m bonfire. Ingram, live: flames "don't respond to wind very well" — they tilted 16 deg at 10.5 m/s.
 * @param {number} windMps @param {number} [diameterM=0.9]
 */
export function flameTiltDeg(windMps, diameterM = 0.9) {
  const u = Math.max(0, Number(windMps) || 0);
  const uc = 0.8 * Math.cbrt(Math.max(0.02, Number(diameterM) || 0.9) / 0.9);
  if (u <= uc) return 0;
  return (Math.acos(Math.sqrt(uc / u)) * 180) / Math.PI;
}

/**
 * The billow flame's drawn tilt (deg from upright: its flame lobes' weighted middle with the 3/4 lift undone) at
 * lean01 = 0, 0.1, ... 1 — measured on a 45 px fire; `__tests__/fire-billow-geometry.test.mjs` re-measures it, so a change
 * to the flame's shape that moves it fails a test instead of quietly mis-leaning every fire.
 */
export const FLAME_TILT_AT_LEAN = Object.freeze([0, 12.4, 24.9, 36.1, 45.8, 54.2, 61.4, 67.3, 72.2, 76.1, 79.3]);

/** The lean01 that draws a tilt of `deg` ({@link FLAME_TILT_AT_LEAN} inverted; past its last row, full lean). */
export function leanForTilt(deg) {
  const d = Math.max(0, Number(deg) || 0);
  const T = FLAME_TILT_AT_LEAN;
  for (let i = 1; i < T.length; i++) {
    if (d <= T[i]) return (i - 1 + (d - T[i - 1]) / (T[i] - T[i - 1])) / (T.length - 1);
  }
  return 1;
}

/** Scratch samples for the air path (one thread; never held across calls). */
const AIR_A = { t: 0, wx: 0, wy: 0, R: 0, dirX: 0, dirY: 0, lean01: 0 };
const AIR_B = { t: 0, wx: 0, wy: 0, R: 0, dirX: 0, dirY: 0, lean01: 0 };

/**
 * The air a fire's smoke rides: its path (`fire-air-path.js`: each puff reads where its own air went since it was born) or,
 * for callers without one, steady air `U` m/s along `(dx, dy)`, slowed by the plume's rise rate. Returns `{now, at(tb)}`.
 * @param {object|null} airPath @param {number} U @param {number} dx @param {number} dy @param {number} riseMps @param {number} t
 */
function smokeAir(airPath, U, dx, dy, riseMps, t) {
  if (airPath) {
    return { now: airPath.head, at: (tb) => airPath.at(tb, AIR_A) };
  }
  const r = plumeRiseRate(U, riseMps);
  const vx = dx * U * r;
  const vy = dy * U * r;
  const steady = (tq, o) => {
    o.t = tq;
    o.wx = vx * tq;
    o.wy = vy * tq;
    o.R = r * tq;
    o.dirX = dx;
    o.dirY = dy;
    o.lean01 = 0;
    return o;
  };
  return { now: steady(t, AIR_B), at: (tb) => steady(tb, AIR_A) };
}

/** Lean gain: quiet at the bottom of the wind dial, decisive at the top (the shape `fireLeanGain01` uses). */
export function billowLeanGain(motion01) {
  const m = clamp01(motion01);
  return (m * (1 + 2 * m)) / 3;
}

/**
 * The breathing of the whole fire: three incommensurate harmonics around 1, so it never reads as a sine. This
 * is the same chaos-sum `firePuffEnvelope` rides, so the light (which already follows that envelope's rate) and
 * the billows breathe together.
 * @param {number} tSec @param {number} puffHz @param {number} amp @param {number} seed
 * @returns {number} ~ 1 ± amp
 */
export function billowPulse(tSec, puffHz, amp, seed = 0) {
  const p = tSec * puffHz + seed * 0.37;
  const chaos =
    0.55 * Math.sin(TAU * p) + 0.3 * Math.sin(TAU * (p * 1.73 + 0.37)) + 0.15 * Math.sin(TAU * (p * 2.91 + 0.11));
  return Math.max(0.2, 1 + amp * chaos);
}

/**
 * A DRAFT: an occasional soft puff of moving air in a sealed room, as a wind-motion 0..1 and a direction. A
 * handful of incommensurate slow pulses thresholded so it is mostly 0 and now and then rises, with a fresh
 * random direction each time. Closed-form (a function of the clock and the seed), so the CPU light and any
 * number of draws agree.
 * @param {number} tSec @param {number} seed @param {number} amp the strongest draft, 0..1 wind motion
 * @returns {{motion01:number, angle:number}}
 */
export function billowDraft(tSec, seed, amp) {
  const s = (seed % 97) * 0.113;
  const slow = 0.5 + 0.34 * Math.sin(tSec * 0.31 + s) + 0.26 * Math.sin(tSec * 0.77 + s * 1.7 + 1.9);
  const gust = smoothstep(0.7, 0.98, slow);
  const epoch = Math.floor(tSec / 5.3 + s);
  return { motion01: gust * amp, angle: hash01(epoch, seed, 7) * TAU };
}

/**
 * Everything a fire needs that follows from its size. Mirrors `fireScaleChain` (which it is built on in the
 * engine) but takes the already-derived numbers so this module stays dependency-free.
 * @param {object} f a fire descriptor (see `emitFireLobes`)
 */
function fireSizes(f, tune) {
  const R = Math.max(4, f.radius);
  const out = clamp01(f.outdoor01 ?? 1);
  const turb = clamp01(f.turb01 ?? 1);
  const heightGain = f.heightGain ?? 1;
  const intensity = clamp(f.intensity ?? 1, 0, 2);
  const iPow = 0.55 + 0.45 * Math.pow(Math.max(0.05, intensity), 0.7);
  return {
    R,
    out,
    turb,
    iPow,
    plume: R * tune.bodyRadius * (f.sizeMul ?? 1),
    // a hearth burns low and squat, a bonfire stands up
    height: R * tune.bodyHeight * (0.7 + 0.75 * out) * heightGain * iPow * (f.heightMul ?? 1),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the weather and the fire's own vitality do to the flame, as one place. `power` is 0 (dead) .. 1 (full).
 * Rain and gale make the whole flame SMALLER, COOLER and THINNER rather than dimming random lobes (the author's
 * "barely surviving"), and a fire with no vitality is its coals alone.
 * @param {number} vitality01 @param {number} stress01
 */
export function billowPower(vitality01, stress01) {
  return clamp01(vitality01) * (1 - 0.85 * clamp01(stress01));
}

/**
 * @typedef {object} BillowFire
 * @property {number} x @property {number} y world px of the fuel bed.
 * @property {number} radius R, world px (half the painted diameter).
 * @property {number} seed integer; every random of this fire hangs off it.
 * @property {number} [intensity=1] 0..2
 * @property {number} [outdoor01=1] 0 hearth .. 1 open air (sky exposure blended with wind openness).
 * @property {number} [turb01=1] `fireScaleChain().turb01` — laminar to turbulent.
 * @property {number} [puffHz=1.6] `fireScaleChain().puffHz`
 * @property {number} [flickerAmp=0.3] `fireScaleChain().flickerAmp`
 * @property {number} [heightGain=1] fuel's `heightGain`
 * @property {number} [windX=0] @property {number} [windY=0] unit vector the wind blows TOWARD (world px, +y down).
 * @property {number} [windMotion01=0] the local push, 0..1, openness already applied.
 * @property {number} [windMps] the air at the fire, m/s (with no `airPath`: steady air; absent: `windMotion01` x 20).
 * @property {number} [lean01] the flame's lean 0..1 from the air's real speed (the engine's); absent: the push's curve.
 * @property {object|null} [airPath] the air's path at this fire (`fire-air-path.js`): smoke rides it, spit embers are thrown
 *   with it. The engine folds its draft into it, so with a path the draft below is off.
 * @property {number} [stress01=0] weather stress (`fireWeatherStress01`).
 * @property {number} [vitality01=1] the fire's slow state (1 burning, 0 out).
 * @property {number} [smokeMul=1] smoke amount (the author's dial × fuel).
 * @property {number} [sootiness01=0] how black this fire's smoke is (0 pale .. 1 charcoal): a big mass of burning building is dark.
 * @property {number} [spawnCount=0] @property {Float32Array|null} [spawn] packed spawn points (x, y, brightness, jitter).
 * @property {number} [spawnStride=4]
 */

/**
 * @typedef {object} BillowEnv
 * @property {number} tSec the fire clock (`nowMs * 0.001 * motionSpeed`).
 * @property {number} [camX=0] @property {number} [camY=0] the view centre (world px) for parallax.
 * @property {number} [cameraHeight=1000] D.
 * @property {number} [parallax=1] how much of the perspective to apply (0 flat).
 * @property {number} [tilt=0.45] screen-up per unit of height — the 3/4 view the painted art is drawn in (see `project`).
 * @property {'top'|'side'} [projection='top']
 * @property {number} [groundY=0] side view: the screen y of the ground.
 * @property {number} [sideScale=1]
 * @property {number} [quality=1] 0.3..1 scales the lobe budgets.
 * @property {number} [animSpeed=1]
 */

/** No flame piece is ever rooted farther than this many radii from its fire's centre, whatever the painted points say. */
const BASE_REACH = 1.15;

/**
 * Pull one spawn point for a lobe (or a disc fallback), returning [x, y, brightness].
 *
 * ⚠️ THE ROOT IS HELD WITHIN `BASE_REACH` RADII OF THE CENTRE. A stray painted point (one that is really part of another
 * fire's paint) used to root a tongue or a billow far from the flame, where it stood alone in the air as a detached
 * teardrop. The engine now hands each flame only its own blob's points (`fire-billow-engine.js#ownPoints`); this is the
 * second wall: a flame is one body, so nothing of it may grow from farther out than the body is wide.
 */
export function basePoint(f, R, h1, h2, h3, pull, scratch) {
  const n = f.spawnCount | 0;
  if (n > 0 && f.spawn) {
    const stride = f.spawnStride ?? 4;
    const i = Math.min(n - 1, Math.floor(h1 * n));
    const px = f.spawn[i * stride];
    const py = f.spawn[i * stride + 1];
    const b = f.spawn[i * stride + 2];
    const jr = f.spawn[i * stride + 3] || 0;
    const a = h2 * TAU;
    const r = jr * Math.sqrt(h3);
    // pull toward the fire's own centre: the painted shape sets the footprint, the flame stays one body
    let bx = lerp(px + Math.cos(a) * r, f.x, pull);
    let by = lerp(py + Math.sin(a) * r, f.y, pull);
    const reach = Math.max(R, 1) * BASE_REACH;
    const dx = bx - f.x;
    const dy = by - f.y;
    const d = Math.hypot(dx, dy);
    if (d > reach) {
      bx = f.x + (dx / d) * reach;
      by = f.y + (dy / d) * reach;
    }
    scratch[0] = bx;
    scratch[1] = by;
    scratch[2] = b;
    return scratch;
  }
  // no painted footprint (an anchor fire): a disc, held in by the same pull the painted points get
  const a = h2 * TAU;
  const r = R * 0.5 * Math.sqrt(h3) * (1 - 0.7 * pull);
  scratch[0] = f.x + Math.cos(a) * r;
  scratch[1] = f.y + Math.sin(a) * r;
  scratch[2] = 1;
  return scratch;
}

/**
 * The camera: ground-plane position + height → where it lands in the picture, and its magnification.
 * `D` overrides the camera height (the smoke's own, nearer camera); `tiltZ` is how much of the height the 3/4 tilt lifts
 * (smoke is tilted only as high as the flame it leaves: above that it rises toward the camera, not up the page).
 */
function project(env, x, y, z, out, D = env.cameraHeight ?? BILLOW_TUNE.cameraHeight, tiltZ = z) {
  if (env.projection === 'side') {
    out[0] = x;
    out[1] = (env.groundY ?? 0) - z * (env.sideScale ?? 1);
    out[2] = 1;
    return out;
  }
  const par = env.parallax ?? 1;
  const hh = Math.min(clamp(z, 0, D * 0.6) * par, D * 0.6);
  const M = D / (D - hh);
  const cx = env.camX ?? 0;
  const cy = env.camY ?? 0;
  // ⚠️ TILT: the painted fires are drawn in the 3/4 view every top-down RPG map uses — a flame rises UP THE PAGE,
  // not toward the camera — and the author asked for exactly that ("at wind 0 ... move upwards to give a sense of
  // depth and 3D"). MSA's camera is orthographic and straight down, so the tilt is faked per billow: height lifts
  // the picture up the screen by `tilt` per unit, on top of the perspective parallax.
  out[0] = cx + (x - cx) * M;
  out[1] = cy + (y - cy) * M - tiltZ * (env.tilt ?? 0.45);
  out[2] = M;
  return out;
}

/**
 * THE SMOKE'S SHARED GRAIN FRAME (2026-11-08 — Ingram: the smoke's grain was "pinned to camera movement" and "a tall thin
 * noise where a larger, more even and less predictable pattern would be better").
 *
 * Every puff of one column draws ONE pattern, so where puffs overlap they agree and the pattern survives. (Each puff drawing a
 * pattern of its own was tried: dozens overlap in a plume, their patterns average away, and the veil came out blank.) The
 * pattern is laid in the camera-free frame (ground position, lifted up the page by the tilt, no perspective) and scrolls at the
 * column's mean speed, so it rises and drifts with the smoke; the shared S-wave is taken out so it meanders with the column.
 * The puff's offset into that frame is measured from its own centre, so a pan or a zoom (which moves and swells the puff on
 * the screen) carries the pattern with the puff instead of leaving it behind.
 *
 * Writes the lobe's spare slots: 12 = the pattern's scale (world px per pattern unit), 14..15 = where this puff's centre sits
 * in the pattern (pattern units). Flame and coal lobes leave them 0.
 *
 * @param {Float32Array} buf @param {number} o the lobe's first float
 * @param {number} gx @param {number} gy the puff's ground position with the column's shared sway taken out, world px
 * @param {number} tiltZ the height the tilt lifts it by (as `project` is given it) @param {number} tilt `env.tilt`
 * @param {number} frameX @param {number} frameY where the column's frame has moved to by now, world px: the air's travel and
 *   the mean billow's lift up the page over its rise time (2026-11-09: it was a mean speed x the clock, so any change in the
 *   wind re-dealt the whole pattern at once and the grain slid against the wind — mmp-9un.5)
 * @param {number} scale world px per pattern unit (> 0)
 */
function stampSmokeGrain(buf, o, gx, gy, tiltZ, tilt, frameX, frameY, scale) {
  const s = Math.max(1, scale);
  buf[o + 12] = s;
  buf[o + 14] = (gx - frameX) / s;
  buf[o + 15] = (gy - tiltZ * tilt - frameY) / s;
}

/** The smoke's camera height: the billow camera brought down to the scene's eye (see `smokePerspective`). */
function smokeCameraHeight(env, tune) {
  return (env.cameraHeight ?? BILLOW_TUNE.cameraHeight) / Math.max(0.5, tune.smokePerspective ?? 1);
}

/**
 * Write one fire's lobes at the clock `env.tSec`.
 *
 * @param {Float32Array} out the flame + coal instance buffer (smoke goes here too unless `outSmoke` is given).
 * @param {number} start the lobe index to start writing at.
 * @param {BillowFire} f
 * @param {BillowEnv} env
 * @param {object} [tuneOverride]
 * @param {Float32Array|null} [outSmoke] a separate buffer for the smoke lobes (the renderer splats them into their own field).
 * @param {number} [startSmoke=0] the smoke lobe index to start writing at.
 * @returns {{count:number, flame:number, smoke:number, coal:number}} lobes written (`count` = in `out`; `smoke` = in `outSmoke`).
 */
export function emitFireLobes(out, start, f, env, tuneOverride, outSmoke = null, startSmoke = 0) {
  const tune = tuneOverride ? { ...BILLOW_TUNE, ...tuneOverride } : BILLOW_TUNE;
  const sz = fireSizes(f, tune);
  const { R, out: outdoor, turb, plume, height } = sz;
  // THE OUTDOOR CLIP (2026-11-06, mmp-9un.4): an outdoor fire's lobes are told so, and draw nothing over indoor ground (the
  // splat reads _Outdoors where it lands), so a column leaning up the page over a wall never shows inside the building
  const outdoorClip = clamp01((outdoor - 0.4) / 0.2);
  const q = clamp(env.quality ?? 1, 0.2, 1);
  const anim = Math.max(0.05, env.animSpeed ?? 1);
  const t = env.tSec * anim;
  const seed = (f.seed | 0) >>> 0;

  const vit = clamp01(f.vitality01 ?? 1);
  const stress = clamp01(f.stress01 ?? 0);
  const power = billowPower(vit, stress);
  // (a gale makes the flame smaller, not its smoke any less: it spreads the smoke, it does not put it out)
  const smokePower = billowPower(vit, 0.3 * stress);
  // size, count and heat all follow the one power number: the flame as a WHOLE gets smaller, thinner and cooler
  // ⚠️ FLOORS LOWERED 0.3 → 0.15, 0.5 → 0.35 (2026-10-21, author: a stressed flame "doesn't seem to get much weaker
  // in the wind... especially very high wind"). These three floors are NOT the sprite era's count/opacity floors
  // (`FLAME_GUTTER_COUNT_FLOOR` etc., below) — those were already pushed back up twice after "too strong" live
  // complaints and are untouched. This is the billow's own, separate, never-live-tuned floor on the drawn body's
  // own size/height/colour; still never zero (a flame always keeps SOME presence — "barely surviving", not gone).
  const sizeMul = 0.15 + 0.85 * Math.pow(power, 0.75);
  const heightMul = 0.15 + 0.85 * Math.pow(power, 0.85);
  const thin = Math.pow(smoothstep(0.015, 0.65, power), 0.7);
  const cool = 0.35 + 0.65 * Math.pow(power, 0.8);
  const rainDamp = 1 - clamp01(f.rain01 ?? 0) * tune.rainShrink * 0.5;

  const pulse = billowPulse(t, (f.puffHz ?? 1.6) * (0.8 + 0.5 * outdoor), (f.flickerAmp ?? 0.3) * 0.55, seed);

  // ── wind: the real wind, plus a draft in still air ──
  // (with an air path the engine has already folded its draft into the air and the lean; this draft is the old callers')
  const airPath = f.airPath ?? null;
  let wx = f.windX ?? 0;
  let wy = f.windY ?? 0;
  let m = clamp01(f.windMotion01 ?? 0);
  const draftAmp = airPath ? 0 : 0.22 * (f.draft ?? 1) * (1 - outdoor) * (1 - m);
  if (draftAmp > 1e-3) {
    const d = billowDraft(t, seed, draftAmp);
    if (d.motion01 > 1e-3) {
      const wm = Math.hypot(wx, wy);
      // blend the draft into whatever wind there is
      const dx = Math.cos(d.angle) * d.motion01;
      const dy = Math.sin(d.angle) * d.motion01;
      const ex = wx * m + dx;
      const ey = wy * m + dy;
      const em = Math.hypot(ex, ey);
      if (em > 1e-4) {
        wx = ex / em;
        wy = ey / em;
        m = clamp01(em);
      } else if (wm <= 0) {
        m = 0;
      }
    }
  }
  // the lean: the engine's physical one (`lean01`: the flame's tilt in this air), or the push's own curve for old callers
  const leanG = Number.isFinite(f.lean01) ? clamp01(f.lean01) : billowLeanGain(m);
  const windLen = Math.hypot(wx, wy) || 1;
  const wdx = wx / windLen;
  const wdy = wy / windLen;
  const windAng = Math.atan2(wdy, wdx);

  const proj = [0, 0, 1];
  const base = [0, 0, 1];
  const smokeD = smokeCameraHeight(env, tune);
  let n = start;
  let ns = startSmoke;
  let flameCount = 0;
  let smokeCount = 0;
  let coalCount = 0;
  let lastX = 0;
  let lastY = 0;
  let lastR = 0;
  // `stretch` is the old area-preserving elongation; a chain lobe passes its own `along` and `across` instead
  // (long and as wide as before: a tongue should not thin as it is stretched along its own path).
  const put = (
    x,
    y,
    z,
    radius,
    strength,
    heat,
    stretch,
    dx,
    dy,
    kind,
    tone,
    along = null,
    across = null,
    seed01 = 0
  ) => {
    if (kind === KIND_FLAME && leanG > 0.01) {
      // the wind lays the whole body over: shear downwind with height, and press the flame down
      const shear = tune.windShear * leanG * z;
      x += wdx * shear;
      y += wdy * shear;
      z *= 1 - tune.windFlatten * leanG;
    }
    // smoke is seen by the nearer camera, and tilted up the page (the flame tilts as the flame; smoke above it by `smokeLift`)
    if (kind === KIND_SMOKE)
      project(env, x, y, z, proj, smokeD, Math.min(z, height) + Math.max(0, z - height) * tune.smokeLift);
    else project(env, x, y, z, proj);
    const M = proj[2];
    const toSmoke = kind === KIND_SMOKE && outSmoke !== null;
    const buf = toSmoke ? outSmoke : out;
    const o = (toSmoke ? ns : n) * LOBE_STRIDE;
    buf[o] = proj[0];
    buf[o + 1] = proj[1];
    buf[o + 2] = radius * M;
    buf[o + 3] = strength;
    buf[o + 4] = heat;
    const st = Math.max(1, stretch);
    buf[o + 5] = along === null ? Math.sqrt(st) : along;
    buf[o + 6] = dx;
    buf[o + 7] = dy;
    buf[o + 8] = kind;
    buf[o + 9] = tone;
    buf[o + 10] = across === null ? 1 / Math.sqrt(st) : across;
    buf[o + 11] = z;
    buf[o + 12] = seed01;
    buf[o + 13] = outdoorClip;
    buf[o + 14] = 0;
    buf[o + 15] = 0;
    lastX = proj[0];
    lastY = proj[1];
    lastR = radius * M;
    if (toSmoke) ns++;
    else n++;
    if (kind === KIND_SMOKE) smokeCount++;
    else if (kind === KIND_COAL) coalCount++;
    else flameCount++;
  };

  // ───────────────────────────── THE COAL BED ─────────────────────────────
  // Soft footprints the renderer carves into cracked glowing cells. They carry only WHERE the bed is and HOW HOT: a
  // burning fire shows the bed round its edge and under the flame; a dying fire is the bed alone, going from orange
  // through rust to coal red over the (much longer) life of `coal01`.
  const coalHeat = clamp01(f.coal01 ?? 0.35 + 0.65 * vit);
  if (coalHeat > 0.01) {
    const nCoal = Math.max(4, Math.round(12 * (0.7 + 0.3 * Math.min(2, R / 50)) * q));
    for (let i = 0; i < nCoal; i++) {
      const id = seed * 131 + i * 19 + 22000;
      const r1 = hash01(id, 0, 51);
      const r2 = hash01(id, 0, 52);
      const r3 = hash01(id, 0, 53);
      const drift = t * (0.15 + 0.2 * r3);
      const th = r1 * TAU + drift;
      const rho = plume * (0.1 + 0.9 * Math.sqrt(r2)) * 0.8;
      const rad = plume * (0.42 + 0.22 * r3);
      const x = f.x + Math.cos(th) * rho;
      const y = f.y + Math.sin(th) * rho;
      put(x, y, 0, rad, 1, coalHeat * (0.75 + 0.25 * r1), 1, 1, 0, KIND_COAL, 0);
    }
  }

  // ───────────────────────────── BODY BILLOWS: THREE NESTED LAYERS ─────────────────────────────
  // The painted flame is lobes inside lobes: a ring of big outer daubs that makes the lobed outline, a middle ring
  // inside it, and a few small hot ones at the heart. Each layer is its own set of billows on its own rhythm, so the
  // outline boils slowly while the core flickers fast. Tone follows temperature (hot = inner), so the nesting of the
  // colour bands falls out of the layers.
  const bodyNorm = 1;
  const bodyScale = (0.72 + 0.28 * Math.min(2, R / 50)) * q;
  const heightBody = height * 0.5;
  // the heart first: continuous, so the body is always one filled mass
  for (let i = 0; i < HEART.count; i++) {
    const id = seed * 131 + i * 3 + 777;
    if (hash01(id, 3, 90) > thin) continue;
    const ph = hash01(id, 1, 2) * TAU;
    const w = 0.55 + 0.4 * hash01(id, 2, 3);
    const x = f.x + Math.cos(t * w + ph) * plume * HEART.orbit + wdx * leanG * plume * 0.25;
    const y = f.y + Math.sin(t * w * 1.17 + ph) * plume * HEART.orbit + wdy * leanG * plume * 0.25;
    const z = heightBody * HEART.z * (0.8 + 0.4 * Math.sin(t * 1.9 + ph));
    const rad = plume * HEART.rad * pulse * sizeMul * rainDamp * (0.94 + 0.06 * Math.sin(t * 2.3 + ph * 2));
    put(x, y, z, rad, HEART.weight, HEART.heat * cool, 1 + tune.leanStreak * leanG * 0.3, wdx, wdy, KIND_FLAME, 0.1);
  }
  for (let li = 0; li < BODY_LAYERS.length; li++) {
    const L = BODY_LAYERS[li];
    const count = Math.max(2, Math.round(L.count * bodyScale));
    const rot = (hash01(seed, li, 5) < 0.5 ? -1 : 1) * 0.16 * t * (1 + 0.6 * outdoor);
    for (let i = 0; i < count; i++) {
      const id = seed * 131 + li * 977 + i * 7 + 1;
      if (hash01(id, 3, 91) > thin) continue;
      const P = (L.life * tune.bodyLifeMul * (0.8 + 0.4 * hash01(id, 0, 1))) / (1 + 0.28 * outdoor);
      const u = t / P + hash01(id, 1, 2);
      const cyc = Math.floor(u);
      const a = u - cyc;
      const r1 = hash01(id, cyc, 11);
      const r2 = hash01(id, cyc, 12);
      const r3 = hash01(id, cyc, 13);
      const r4 = hash01(id, cyc, 14);
      const r5 = hash01(id, cyc, 15);
      const r6 = hash01(id, cyc, 16);
      const envR = smoothstep(0, 0.3, a) * (1 - smoothstep(0.68, 1, a));
      if (envR < 0.004) continue;
      basePoint(f, R, r1, r2, r3, 0.82, base);
      const bright = base[2];
      // spread evenly round the ring, a fresh sector each cycle, the whole ring slowly turning
      const th = TAU * ((i + (r2 - 0.5) * 0.9) / count) + rot + L.swirl * (a - 0.5) * 0.7;
      const rho = plume * lerp(L.rho[0], L.rho[1], r3) * (0.92 + 0.16 * envR);
      const z = heightBody * lerp(L.z[0], L.z[1], Math.pow(a, 0.8)) * (0.8 + 0.4 * r5) * (0.55 + 0.45 * bright);
      const wob = plume * 0.06;
      const wph = t * (1.3 / P) * TAU + r6 * TAU;
      const lean = leanG * tune.leanLength * plume * Math.pow(a, tune.leanCurve) * (0.35 + (0.65 * li) / 2);
      const x = base[0] + Math.cos(th) * rho + Math.sin(wph) * wob + wdx * lean;
      const y = base[1] + Math.sin(th) * rho + Math.cos(wph * 0.83) * wob + wdy * lean;
      const rad =
        plume * L.rad * (0.5 + 0.5 * envR) * Math.pow(envR, 0.45) * pulse * sizeMul * rainDamp * (0.8 + 0.4 * r4);
      const heat = lerp(L.heat[0], L.heat[1], r4) * (1 - 0.3 * a) * cool;
      put(x, y, z, rad, L.weight * bodyNorm, heat, 1 + tune.leanStreak * leanG * a, wdx, wdy, KIND_FLAME, a);
    }
  }

  // ───────────────────────────── TONGUES ─────────────────────────────
  // A tongue is a STREAM of billows, not a bent rod that grows and shrinks. Each billow is thrown out of the tongue's root on
  // its own clock, flies outward and slows, is bent upward by the heat (toward the wind in a gale), sways sideways more the
  // older it gets, swells and cools; then past ~60% of its life it TEARS into two fragments that drift apart and rise on
  // their own while they fade. The heading the stream is thrown at wanders with time (a slow double sine), so billows
  // thrown a moment apart fly different ways: the tongue snakes and re-forms instead of keeping one shape.
  // tongue 0 is the flame's own TIP: always there, standing tallest, reaching little sideways.
  // (fractional, 2026-11-09: the newest tongue fades in and out as the air changes instead of popping in whole — mmp-9un.5)
  const nTongueF = 1 + lerp(tune.tongueMin, tune.tongueMax, clamp01(turb * (0.15 + 0.5 * outdoor) + 0.9 * leanG)) * q;
  const nTongue = Math.ceil(nTongueF - 1e-6);
  const M = tune.tongueLobes;
  for (let k = 0; k < nTongue; k++) {
    const id = seed * 131 + k * 13 + 5000;
    if (hash01(id, 3, 92) > thin) continue;
    const primary = k === 0;
    const kFade = primary ? 1 : clamp01(nTongueF - k);
    // the root hops slowly; the stream keeps its place meanwhile
    const ur = t / (5 + 4 * hash01(id, 0, 1)) + hash01(id, 1, 2);
    const rc = Math.floor(ur);
    basePoint(f, R, hash01(id, rc, 21), hash01(id, rc, 22), hash01(id, rc, 23), 0.55, base);
    const rootX = base[0];
    const rootY = base[1];
    const phi = hash01(id, 5, 27) * TAU;
    const psiCalm = -Math.PI / 2 + (hash01(id, rc, 24) - 0.5) * 2.2;
    const r5 = hash01(id, rc, 25);
    // a hearth's tongues are short and stubby, a bonfire's long; the horizontal reach is modest, the HEIGHT is the point
    const reach0 =
      plume *
      tune.tongueLength *
      (primary ? 0.25 + 0.9 * leanG : (0.45 + 0.5 * r5) * (0.35 + 0.35 * outdoor + 0.9 * leanG)) *
      heightMul;
    const topZ0 = height * heightMul * (primary ? 0.75 + 0.25 * r5 : 0.4 + 0.3 * r5);
    const lt0 = (tune.tongueLife * (0.8 + 0.6 * hash01(id, 0, 3))) / (1 + 0.3 * outdoor);
    for (let j = 0; j < M; j++) {
      const idj = id * 17 + j * 101;
      const lt = lt0 * (0.75 + 0.5 * hash01(idj, 0, 1));
      const u = t / lt + (j + 0.5 * hash01(idj, 1, 2)) / M;
      const cyc = Math.floor(u);
      const a = u - cyc;
      const te = t - a * lt; // when this billow was thrown
      const wander = 0.6 * Math.sin(te * 0.9 + phi) + 0.4 * Math.sin(te * 2.1 + phi * 1.7);
      const psi = psiCalm + wander * tune.tongueCurl * 0.18;
      // heading: its own throw, laid toward the wind, and bent upward by the heat as it ages (calm air)
      const lam = clamp01(leanG * (0.25 + 1.2 * a));
      const up = 0.55 * smoothstep(0.25, 1, a) * (1 - leanG);
      let hx = (Math.cos(psi) * (1 - lam) + wdx * lam) * (1 - up);
      let hy = (Math.sin(psi) * (1 - lam) + wdy * lam) * (1 - up) - up;
      const hl = Math.hypot(hx, hy) || 1;
      hx /= hl;
      hy /= hl;
      const dist = reach0 * (1 - (1 - a) * (1 - a));
      const sway = Math.sin(a * TAU * 1.15 + phi + j) * reach0 * 0.22 * a * (0.5 + 0.5 * turb);
      const x = rootX + hx * dist - hy * sway;
      const y = rootY + hy * dist + hx * sway;
      const z = topZ0 * Math.pow(a, 0.85) * (1 - 0.55 * leanG * a) + height * 0.08;
      const grow = smoothstep(0, 0.18, a);
      const tear = 1 - smoothstep(0.58, 0.9, a);
      const swell = Math.pow(grow, 0.6) * (1 - 0.35 * a);
      const rad = plume * tune.tongueLobe * (primary ? 1.25 : 1) * swell * tear * pulse * sizeMul * rainDamp;
      const heat = (0.85 - 0.55 * a) * (1 - 0.3 * a) * cool;
      put(
        x,
        y,
        z,
        rad,
        0.95 * (1 - 0.3 * a) * kFade,
        heat,
        1 + 1.8 * Math.pow(1 - a, 1.5),
        hx,
        hy,
        KIND_FLAME,
        lerp(a, 1, 0.3)
      );
      // THE TEAR: two fragments leave the billow, fly apart across its heading and rise on their own, fading
      if (a > 0.58 && hash01(idj, cyc, 31) > 0.35) {
        const bk = (a - 0.58) / 0.42;
        const baseRad =
          plume * tune.tongueLobe * (primary ? 1.25 : 1) * Math.pow(grow, 0.6) * pulse * sizeMul * rainDamp;
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          const sp = plume * 0.6 * bk * (0.6 + 0.8 * hash01(idj, cyc, 32 + sgn));
          const fx = x - hy * sgn * sp + wdx * leanG * bk * plume * 0.7;
          const fy = y + hx * sgn * sp + wdy * leanG * bk * plume * 0.7;
          const fz = z + bk * height * 0.4 * (0.6 + 0.8 * hash01(idj, cyc, 34 + sgn));
          const fr = baseRad * 0.5 * Math.pow(1 - bk, 0.9) * smoothstep(0, 0.12, bk + 0.1);
          if (fr > 0.2)
            put(
              fx,
              fy,
              fz,
              fr,
              0.9 * (1 - 0.6 * bk) * kFade,
              (0.5 - 0.3 * bk) * cool,
              1 + 1.2 * (1 - bk),
              hx,
              hy,
              KIND_FLAME,
              1
            );
        }
      }
    }
  }

  // ───────────────────────────── FLECKS ─────────────────────────────
  const nFleck = Math.round((tune.fleckBase + tune.fleckPerR * R) * q * (0.35 + 0.65 * outdoor));
  for (let i = 0; i < nFleck; i++) {
    const id = seed * 131 + i * 11 + 9000;
    if (hash01(id, 3, 93) > thin) continue;
    // (a FIXED life: one that followed the wind re-dealt every fleck's age whenever the wind changed — mmp-9un.5)
    const P = tune.fleckLife * (0.55 + 0.9 * hash01(id, 0, 1));
    const u = t / P + hash01(id, 1, 2);
    const cyc = Math.floor(u);
    const a = u - cyc;
    const r2 = hash01(id, cyc, 32);
    const r3 = hash01(id, cyc, 33);
    const r4 = hash01(id, cyc, 34);
    const r5 = hash01(id, cyc, 35);
    const r6 = hash01(id, cyc, 36);
    const fade = smoothstep(0, 0.06, a) * (1 - smoothstep(0.55, 1, a));
    if (fade < 0.01) continue;
    const rho0 = plume * (0.35 + 0.55 * r2);
    // wind tears flecks downwind
    const th0 = lerp(r3 * TAU, windAng, clamp01(0.45 * leanG * 1.5));
    const ox = f.x + Math.cos(th0) * rho0;
    const oy = f.y + Math.sin(th0) * rho0;
    const thv = th0 + (r4 - 0.5) * 0.9;
    const speed = plume * tune.fleckSpeed * (0.55 + 0.9 * r5) * (1 + 1.8 * m);
    const dist = speed * P * (a - 0.35 * a * a);
    const x = ox + Math.cos(thv) * dist + wdx * leanG * plume * 1.6 * a;
    const y = oy + Math.sin(thv) * dist + wdy * leanG * plume * 1.6 * a;
    const z = height * heightMul * (0.5 + 1.2 * r6) * Math.pow(a, 0.7);
    const rad =
      plume * tune.fleckSize * (0.6 + 0.8 * r5) * Math.pow(1 - a, 0.8) * smoothstep(0, 0.08, a) * (0.5 + 0.5 * sizeMul);
    const stretch = 1 + 2.6 * (1 - a) * (0.5 + 0.5 * r5) * (1 + m);
    const dxv = Math.cos(thv) * 0.8 + wdx * 0.6 * leanG;
    const dyv = Math.sin(thv) * 0.8 + wdy * 0.6 * leanG;
    const dl2 = Math.hypot(dxv, dyv) || 1;
    // a fleck is ONE flat tone: low heat and modest strength keep it in the amber band
    put(x, y, z, rad, 1.25 * fade, (0.55 - 0.25 * a) * cool, stretch, dxv / dl2, dyv / dl2, KIND_FLAME, a);
  }

  // ───────────────────────────── SPIT EMBERS ─────────────────────────────
  // The heavy kind, not the spiralling sparks (those are the ember engine's, and untouched): chunks of burning wood the
  // fire spits out. Each slot's life is one long cycle: a short parabolic FLIGHT from the fuel bed, then it LIES where it
  // landed and cools, cream-yellow to orange to rust to coal red to nothing, over most of the cycle. Rain hisses them out
  // sooner; wind makes them flare. They are tiny flame-kind lobes, so they take their colour from the flame ramp for
  // free, and being in the field they get the same glow.
  const spitHeat = clamp01(f.coal01 ?? 0.35 + 0.65 * vit);
  const nSpit = Math.round(
    (tune.spitBase + tune.spitPerR * R) *
      q *
      (0.25 + 0.75 * outdoor) *
      (f.spitMul ?? 1) *
      Math.pow(Math.max(power, 0.02), 0.5) *
      (0.4 + 0.6 * spitHeat)
  );
  for (let i = 0; i < nSpit; i++) {
    const id = seed * 131 + i * 23 + 31000;
    const P = tune.spitLife * (0.6 + 0.8 * hash01(id, 0, 1));
    const u = t / P + hash01(id, 1, 2);
    const cyc = Math.floor(u);
    const a = u - cyc;
    const r1 = hash01(id, cyc, 61);
    const r2 = hash01(id, cyc, 62);
    const r3 = hash01(id, cyc, 63);
    const r4 = hash01(id, cyc, 64);
    const r5 = hash01(id, cyc, 65);
    const r6 = hash01(id, cyc, 66);
    const flightT = 0.45 + 0.5 * r1;
    const sec = a * P;
    const fa = sec / flightT; // 0..1 in the air, past 1 once down
    // thrown with the air AT ITS THROW (mmp-9un.5): an ember lying on the ground stays where it fell when the wind turns
    let throwAng = windAng;
    let throwLean = leanG;
    if (airPath) {
      const sa = airPath.at(t - sec, AIR_B);
      if (sa.dirX !== 0 || sa.dirY !== 0) throwAng = Math.atan2(sa.dirY, sa.dirX);
      throwLean = clamp01(sa.lean01);
    }
    const th = lerp(r2 * TAU, throwAng, clamp01(0.5 * throwLean * 1.6));
    const range = plume * tune.spitRange * (0.45 + 0.9 * r3) * (1 + 1.1 * throwLean);
    const flown = fa < 1 ? 1 - (1 - fa) * (1 - fa) : 1;
    const skid = fa > 1 ? 0.08 * (1 - Math.exp(-(sec - flightT) / 1.4)) : 0;
    const dist = range * (flown + skid);
    const base0 = basePoint(f, R, r4, r5, r6, 0.9, base);
    const x = base0[0] + Math.cos(th) * dist;
    const y = base0[1] + Math.sin(th) * dist;
    const z = fa < 1 ? 4 * height * (0.35 + 0.35 * r4) * fa * (1 - fa) : 0;
    const smoulder = P * 0.78 * (1 - 0.55 * clamp01(f.rain01 ?? 0));
    const lying = Math.max(0, sec - flightT);
    let T = fa < 1 ? 0.95 : 0.9 * Math.pow(Math.max(0, 1 - lying / smoulder), 1.6);
    // an ember breathes, and a gust makes it flare
    T *= 0.86 + 0.14 * Math.sin(t * (3 + 4 * r5) + r6 * TAU);
    T = clamp01(T + 0.12 * m * (0.5 + 0.5 * Math.sin(t * 2.7 + r6 * TAU)));
    const live = fa < 1 ? 1 : 1 - smoothstep(smoulder * 0.9, smoulder * 1.05, lying);
    if (live < 0.02 || T < 0.005) continue;
    const rad =
      plume * tune.spitSize * (0.7 + 0.6 * r5) * (fa < 1 ? 1.0 : 0.9 + 0.1 * T) * live * smoothstep(0, 0.04, a);
    const dxv = Math.cos(th);
    const dyv = Math.sin(th);
    put(x, y, z, rad, 1.35, T, fa < 1 ? 1 + 1.1 * (1 - fa) : 1, dxv, dyv, KIND_FLAME, 0.5);
  }

  // ───────────────────────────── SMOKE ─────────────────────────────
  const smokeRef = (tune.smokeBase + tune.smokePerR * R) * q * (f.smokeMul ?? 1);
  // a hearth's smoke is drawn up the flue: thin and low; a bonfire's is a column. A doused fire smokes MORE (steam).
  // wet = steam: rain on a hot fire. Burning smoke follows the fire's power; a smouldering bed gives a thin wisp, no more.
  const wet = clamp01(clamp01(f.rain01 ?? 0) * (0.35 + 0.65 * (1 - power)) * (0.3 + 0.7 * coalHeat));
  // rain beats smoke down fast: a shower leaves a thin steam wisp, not a column
  const rainKill = 1 - 0.95 * smoothstep(0.03, 0.45, clamp01(f.rain01 ?? 0));
  const smokeAmt =
    (0.26 + 0.74 * outdoor) * ((0.12 * coalHeat + 0.88 * Math.pow(smokePower, 0.8)) * rainKill + 0.12 * wet);
  const nSmoke = Math.max(0, Math.round(smokeRef * smokeAmt));
  // THE COLUMN'S MEAN PATH (2026-11-08): the frame the smoke's shared grain scrolls in (`stampSmokeGrain`). The mean billow:
  // the loop's own climb, drift and life with every per-billow random at its middle, and no S-wave (taken out per billow).
  const RsG = Math.sqrt(Math.max(R, 1) * 50);
  // ⚠️ THE SMOKE IS CARRIED BY ITS AIR (2026-11-09, mmp-9un.5 + mmp-vm1.1.6). Each billow used to be placed from the wind of
  // THIS frame times its age, its life stretched with the wind, and the column's grain scrolled at "this frame's speed x the
  // clock": so any change in the air (a gust, the local air turning, a sealed room's draft coming and going) swung the whole
  // column round its base at once, re-dealt every billow's age (the smoke raced up and down its own path) and jumped the
  // grain (Ingram, live: smoke "rushes back and forth", "reversing direction", its noise "moves in a way that doesn't match
  // the wind"). Now a billow's life is fixed, its drift is how far ITS air has travelled since it was born (`airPath`, kept
  // by the engine), its climb runs on rise time (a plume climbs slower in a wind), and the grain rides the same air: a gust
  // bends the newest smoke and the column curls. The drawn plume climbs `zTopMean` in `PMean` (slow motion), so it drifts in
  // the same slow motion, `pxPerAirM` world px per metre of air: it leans atan(U / FIRE_PLUME_RISE_MPS) from upright.
  const zTopMean = RsG * tune.smokeRise * (0.35 + 0.65 * outdoor) * (0.6 + 0.4 * sz.iPow);
  const PMean = tune.smokeLife * 1.05 * (0.55 + 0.45 * outdoor);
  // (x the author's "Smoke wind drift" dial: 1 = the bent-over plume, 0 = the smoke stands up in any wind)
  const pxPerAirM =
    (zTopMean / PMean / FIRE_PLUME_RISE_MPS) * PLUME_DRIFT_CAL * Math.max(0, tune.smokeDrift / BILLOW_TUNE.smokeDrift);
  const calmAir = wx === 0 && wy === 0;
  const air = smokeAir(
    airPath,
    Number.isFinite(f.windMps) ? Math.max(0, f.windMps) : m * LEGACY_FULL_WIND_MPS,
    calmAir ? 0 : wdx,
    calmAir ? 0 : wdy,
    FIRE_PLUME_RISE_MPS,
    t
  );
  const nowWx = air.now.wx;
  const nowWy = air.now.wy;
  const nowR = air.now.R;
  const smokeTiltZ = (z) => Math.min(z, height) + Math.max(0, z - height) * tune.smokeLift;
  // the column's frame for its shared grain: carried by the air, and lifted up the page at the mean billow's rate per second of
  // rise time — so a puff keeps its own patch of the pattern for its whole life, whatever the air does
  const liftAt = (ar) => smokeTiltZ(height * 0.55 + zTopMean * Math.pow(ar, 0.9)) * (env.tilt ?? 0.45);
  const vLiftR = (liftAt(0.7) - liftAt(0.2)) / (0.5 * PMean);
  const frameX = pxPerAirM * nowWx;
  const frameY = pxPerAirM * nowWy - vLiftR * nowR;
  const smokeGrainS = plume * (tune.smokeGrainScale ?? 2.2);
  // the Wind lab's smoke meter: the drift's weighted middle on the ground (before the camera), from the fuel bed
  let smokeGX = 0;
  let smokeGY = 0;
  let smokeGW = 0;
  let smokeGZ = 0;
  for (let i = 0; i < nSmoke; i++) {
    const id = seed * 131 + i * 17 + 14000;
    // (a FIXED life: see above. The longer trail in a gale is the air carrying it further, not a longer life.)
    const P = tune.smokeLife * (0.7 + 0.7 * hash01(id, 0, 1)) * (0.55 + 0.45 * outdoor);
    const u = t / P + hash01(id, 1, 2);
    const cyc = Math.floor(u);
    const a = u - cyc;
    const r1 = hash01(id, cyc, 41);
    const r2 = hash01(id, cyc, 42);
    const r3 = hash01(id, cyc, 43);
    const r4 = hash01(id, cyc, 44);
    const r6 = hash01(id, cyc, 46);
    const r7 = hash01(id, cyc, 47);
    // (v2: the billow keeps its size and most of its strength to the end of its life and only fades over the last fifth;
    // fading strength from 70% of the life dropped the upper half under the silhouette, so a long plume drew short)
    // (v3, author: "the smoke disappears in units instead of fading out and spreading out": an old billow SPREADS, wider and
    // thinner at once, so its smoke is shared out over more and more air until there is nothing left to see; the renderer
    // turns density into opacity smoothly, so no billow is ever cut off at an edge)
    // (and it is born at body size almost at once: a slow fade-in left a string of small beads between the flame and its column)
    const envGrow = smoothstep(0.0, 0.14, a);
    const envS = envGrow * (1 - smoothstep(0.72, 1, a));
    if (envS < 0.01) continue;
    const spread = 1 + tune.smokeSpread * Math.pow(smoothstep(0.3, 1, a), 1.4);
    basePoint(f, R, r1, r2, r3, 0.75, base);
    // smoke is born ABOVE the flame body and climbs from there, thin at first
    // (a gale blows smoke along the ground rather than up: at full wind it climbs half as high and drifts the whole way)
    // THE PLUME'S SCALE IS NOT THE FIRE'S (v2, author: "the smoke is very short" on a brazier): a plume's height and drift go
    // with the square root of the fire's size, so a small brazier still sends up a column several flames tall and a bonfire's
    // does not reach off the map. `Rs` = R for a 50 px fire.
    const Rs = Math.sqrt(Math.max(R, 1) * 50);
    const zTop = Rs * tune.smokeRise * (0.35 + 0.65 * outdoor) * (0.75 + 0.5 * r4) * (0.6 + 0.4 * sz.iPow);
    // where its air has carried it since it was born, and how long it has had to climb (rise time: slower in a wind)
    const birth = air.at(t - a * P);
    const dWx = nowWx - birth.wx;
    const dWy = nowWy - birth.wy;
    const ar = clamp01((nowR - birth.R) / P);
    // (v2: born at 55% of the flame's height, not 75%, so the column grows out of the fire instead of floating above it)
    const z = height * 0.55 + zTop * Math.pow(ar, 0.9);
    // THE COLUMN IS ONE RIBBON (2026-11-03): every billow shares one travelling wave (its phase is the climb, `a`, and the clock),
    // so the whole column S-curves and meanders together instead of each puff wobbling alone into a fuzzy cloud. The wave
    // swings across the wind in a breeze (a streamer flutters sideways) and round a slowly turning bearing in still air. Each
    // billow adds only a small scatter that widens as it climbs, so the column thickens without coming apart.
    const waveTurn = seed * 0.0137 + t * 0.045;
    const wvx = (1 - leanG) * Math.cos(waveTurn) - leanG * wdy;
    const wvy = (1 - leanG) * Math.sin(waveTurn) + leanG * wdx;
    const wave =
      plume *
      tune.smokeWave *
      Math.pow(a, 0.9) *
      (1 - 0.5 * leanG) *
      Math.sin(t * 0.55 - a * 3.4 + (seed % 628) * 0.01);
    const sway = wvx * wave + plume * 0.5 * (r6 - 0.5) * a;
    const swayY = wvy * wave + plume * 0.5 * (r7 - 0.5) * a;
    // a sealed room's smoke goes nowhere in particular: it just rises and fades
    // (v3: the lift and the swell both happen in `put`'s camera, so the billow's ground position is just the fire's and the air's)
    const x = base[0] + sway + dWx * pxPerAirM;
    const y = base[1] + swayY + dWy * pxPerAirM;
    // a plume SHOULD outgrow its fire: small and dense at the base, billowing wide as it climbs, and wider still as it dies
    const rad =
      plume *
      tune.smokeSize *
      (tune.smokeStart + tune.smokeGrow * Math.pow(a, 0.85)) *
      Math.pow(envGrow, 0.5) *
      Math.sqrt(Rs / Math.max(R, 1)) *
      spread *
      (0.85 + 0.35 * r3);
    const tone = clamp01(a * 1.05 + 0.08 * r2);
    // the lobe's `heat` slot is the smoke's colour channel: + is steam (rain turns it white), - is soot (a sooty fuel, or a whole
    // burning building, makes it black)
    const soot = clamp01(f.sootiness01 ?? 0) * (1 - wet);
    put(
      x,
      y,
      z,
      rad,
      ((0.62 + 0.5 * smokeAmt) * Math.pow(envS, 0.55) * (0.85 + 0.3 * r3)) / (spread * spread),
      wet - soot,
      1 + tune.smokeStreak * leanG * Math.pow(a, 0.7),
      wdx,
      wdy,
      KIND_SMOKE,
      tone,
      null,
      null,
      r1
    );
    // its place in the column's shared grain: its ground position without the S-wave, so the grain meanders with the column
    stampSmokeGrain(
      outSmoke !== null ? outSmoke : out,
      ((outSmoke !== null ? ns : n) - 1) * LOBE_STRIDE,
      x - wvx * wave,
      y - wvy * wave,
      smokeTiltZ(z),
      env.tilt ?? 0.45,
      frameX,
      frameY,
      smokeGrainS
    );
    const sbuf = outSmoke !== null ? outSmoke : out;
    const so = ((outSmoke !== null ? ns : n) - 1) * LOBE_STRIDE;
    const sw = Math.max(0, sbuf[so + 3]) * sbuf[so + 2] * sbuf[so + 2];
    smokeGX += (x - f.x) * sw;
    smokeGY += (y - f.y) * sw;
    smokeGZ += z * sw;
    smokeGW += sw;
  }

  return {
    count: n - start,
    flame: flameCount,
    smoke: smokeCount,
    coal: coalCount,
    // the Wind lab's smoke meter (mmp-9un.5): where the drift sits, and where the column's grain frame has moved to
    smokeGX: smokeGW > 0 ? smokeGX / smokeGW : null,
    smokeGY: smokeGW > 0 ? smokeGY / smokeGW : null,
    smokeZ: smokeGW > 0 ? smokeGZ / smokeGW : null,
    flameH: height,
    grainX: frameX,
    grainY: frameY,
  };
}

/** The most billows one burning mass's column ever writes (the engine reserves this many before it asks for one). */
export const MASS_SMOKE_MAX = 48;

/**
 * @typedef {object} BillowMass
 * @property {number} x @property {number} y world px: the middle of the whole burning mass.
 * @property {number} radius the whole mass's radius, world px.
 * @property {number} [baseZ=0] height the column starts at (the flames' tops).
 * @property {number} seed
 * @property {number} [lit01=1] the fraction of the mass that is burning (a spreading fire is partly lit).
 * @property {number} [vitality01=1] @property {number} [coal01] @property {number} [stress01=0] @property {number} [rain01=0]
 * @property {number} [outdoor01=1] @property {number} [windX=0] @property {number} [windY=0] @property {number} [windMotion01=0]
 * @property {number} [windMps] @property {number} [lean01] @property {object|null} [airPath] as a fire's (see `BillowFire`)
 * @property {number} [smokeMul=1] @property {number} [sootiness01=0.5]
 */

/**
 * ONE column of smoke for a whole burning mass (a roof, a building). The flames of a split fire each make only a wisp (the
 * engine turns their smoke down); the mass as a whole makes THIS: a few big billows rising from its middle, growing as they
 * climb, dark with soot, leaning with the wind and thinning out above. From above it rises toward the camera (v3: it used
 * to be slid up the page). Same lobe format as a flame's smoke, drawn into the same field.
 *
 * @param {Float32Array} out the smoke lobe buffer @param {number} start the lobe index to write at
 * @param {BillowMass} m @param {BillowEnv} env @param {object} [tuneOverride]
 * @returns {{count:number}} lobes written
 */
export function emitMassSmoke(out, start, m, env, tuneOverride) {
  const tune = tuneOverride ? { ...BILLOW_TUNE, ...tuneOverride } : BILLOW_TUNE;
  const q = clamp(env.quality ?? 1, 0.2, 1);
  const t = env.tSec * Math.max(0.05, env.animSpeed ?? 1);
  const Rm = Math.max(8, m.radius);
  const seed = (m.seed | 0) >>> 0;
  const lit = clamp01(m.lit01 ?? 1);
  const vit = clamp01(m.vitality01 ?? 1);
  const power = billowPower(vit, clamp01(m.stress01 ?? 0));
  const smokePower = billowPower(vit, 0.3 * clamp01(m.stress01 ?? 0));
  const outdoor = clamp01(m.outdoor01 ?? 1);
  const outdoorClip = clamp01((outdoor - 0.4) / 0.2); // see emitFireLobes
  const coalHeat = clamp01(m.coal01 ?? 0.35 + 0.65 * vit);
  const wet = clamp01(clamp01(m.rain01 ?? 0) * (0.35 + 0.65 * (1 - power)) * (0.3 + 0.7 * coalHeat));
  // the same smoke amount as one flame's (a hearth's goes up the flue, rain makes steam), times how much of the mass burns
  const rainKill = 1 - 0.95 * smoothstep(0.03, 0.45, clamp01(m.rain01 ?? 0));
  const amt =
    (0.26 + 0.74 * outdoor) * ((0.12 * coalHeat + 0.88 * Math.pow(smokePower, 0.8)) * rainKill + 0.12 * wet) * lit;
  // a weak column (a dying fire, a soaked roof) is made of smaller, lower puffs, not of a few big balls
  const weak = Math.min(1, amt);
  const sizeK = 0.55 + 0.45 * Math.pow(weak, 0.6);
  const count = Math.min(
    MASS_SMOKE_MAX,
    Math.round(clamp(14 + Rm / 12, 14, 36) * q * (m.smokeMul ?? 1) * Math.min(1.4, amt * 1.3))
  );
  const wx = m.windX ?? 0;
  const wy = m.windY ?? 0;
  const wl = Math.hypot(wx, wy) || 1;
  const wdx = wx / wl;
  const wdy = wy / wl;
  const leanG = Number.isFinite(m.lean01) ? clamp01(m.lean01) : billowLeanGain(clamp01(m.windMotion01 ?? 0));
  const baseZ = m.baseZ ?? 0;
  const soot = clamp01(m.sootiness01 ?? 0.5) * (1 - wet);
  const smokeD = smokeCameraHeight(env, tune);
  const proj = [0, 0, 1];
  // THE COLUMN RIDES ITS AIR, like a campfire's (see `emitFireLobes`, mmp-9un.5): fixed lives, drift = how far its air has gone
  // since each billow was born, climb on rise time; a building's plume is stiffer (MASS_PLUME_RISE_MPS)
  const PMass = tune.smokeLife * 1.7 * (0.55 + 0.45 * outdoor);
  const climbMean = Rm * (tune.massRise ?? 1.6) * (0.35 + 0.65 * outdoor) * (0.6 + 0.4 * weak);
  const pxPerAirM =
    (climbMean / PMass / MASS_PLUME_RISE_MPS) * PLUME_DRIFT_CAL * Math.max(0, tune.smokeDrift / BILLOW_TUNE.smokeDrift);
  const calmAir = wx === 0 && wy === 0;
  const air = smokeAir(
    m.airPath ?? null,
    Number.isFinite(m.windMps) ? Math.max(0, m.windMps) : clamp01(m.windMotion01 ?? 0) * LEGACY_FULL_WIND_MPS,
    calmAir ? 0 : wdx,
    calmAir ? 0 : wdy,
    MASS_PLUME_RISE_MPS,
    t
  );
  const nowWx = air.now.wx;
  const nowWy = air.now.wy;
  const nowR = air.now.R;
  // the column's frame for its shared grain (`stampSmokeGrain`): carried by the air, lifted at the mean billow's rate
  const vLiftR =
    (climbMean * (Math.pow(0.7, 0.9) - Math.pow(0.2, 0.9)) * tune.smokeLift * (env.tilt ?? 0.45)) / (0.5 * PMass);
  const frameX = pxPerAirM * nowWx;
  const frameY = pxPerAirM * nowWy - vLiftR * nowR;
  const massGrainS = Rm * 0.5 * (tune.smokeGrainScale ?? 2.2);
  let n = start;
  for (let i = 0; i < count; i++) {
    const id = seed * 131 + i * 29 + 41000;
    // a column climbs slowly: this is a big thing, not a puff
    const P = tune.smokeLife * 1.7 * (0.8 + 0.4 * hash01(id, 0, 1)) * (0.55 + 0.45 * outdoor);
    // evenly spread phases (a regular puff-puff-puff, not clumps), each with its own small jitter
    const u = t / P + (i + 0.35 * hash01(id, 1, 2)) / Math.max(1, count);
    const cyc = Math.floor(u);
    const a = u - cyc;
    const r1 = hash01(id, cyc, 71);
    const r2 = hash01(id, cyc, 72);
    const r3 = hash01(id, cyc, 73);
    const r4 = hash01(id, cyc, 74);
    const envS = smoothstep(0.04, 0.3, a) * (1 - smoothstep(0.72, 1, a));
    if (envS < 0.01) continue;
    // (v3: the column dissolves the way a campfire's does, each billow spreading and thinning as it dies)
    const spread = 1 + tune.smokeSpread * 0.7 * Math.pow(smoothstep(0.3, 1, a), 1.4);
    const ang = r1 * TAU;
    // (smoke comes off the whole roof and gathers into one column as it climbs)
    const rho = Rm * 0.4 * Math.sqrt(r2) * (1 - 0.5 * a);
    // (a gale flattens the column too: it climbs slower on rise time and drifts the whole way)
    const birth = air.at(t - a * P);
    const ar = clamp01((nowR - birth.R) / P);
    const climb =
      Rm *
      (tune.massRise ?? 1.6) *
      (0.35 + 0.65 * outdoor) *
      (0.82 + 0.36 * r4) *
      Math.pow(ar, 0.9) *
      (0.6 + 0.4 * weak);
    const z = baseZ + climb;
    const driftX = (nowWx - birth.wx) * pxPerAirM;
    const driftY = (nowWy - birth.wy) * pxPerAirM;
    // (the column is an S, not a pole: it sways more the higher it is, slowly, whatever the wind)
    const bend = Math.sin(t * 0.27 + a * 2.6 + hash01(seed, 9, 9) * TAU) * Rm * 0.16 * Math.pow(a, 0.8);
    const x = m.x + Math.cos(ang) * rho + Math.sin(t * 0.5 + r3 * TAU) * Rm * 0.05 * a + bend + driftX;
    const y = m.y + Math.sin(ang) * rho + Math.cos(t * 0.4 + r4 * TAU) * Rm * 0.04 * a + driftY;
    // (0.2 -> 0.5 -> 0.62, 2026-11-03: the campfire's smoke grew 1.6x and 2.5x the climb; the burning roof's column stays the bigger of the two)
    const rad = Rm * 0.62 * sizeK * (0.4 + 1.5 * Math.pow(a, 0.8)) * Math.pow(envS, 0.5) * spread * (0.8 + 0.45 * r3);
    const strength = ((0.55 + 0.45 * Math.min(1, amt)) * Math.pow(envS, 0.55) * (0.85 + 0.3 * r3)) / (spread * spread);
    // (the lower half of the column is still lit by the fire, the upper greys and darkens)
    const tone = clamp01(Math.pow(a, 1.3) * 1.05 + 0.08 * r2);
    // (v3: seen by the smoke's own camera, tilted up the page by `smokeLift` per unit of height above the flame tops)
    project(env, x, y, z, proj, smokeD, Math.min(z, baseZ) + Math.max(0, z - baseZ) * tune.smokeLift);
    const o = n * LOBE_STRIDE;
    out[o] = proj[0];
    out[o + 1] = proj[1];
    out[o + 2] = rad * proj[2];
    out[o + 3] = strength;
    out[o + 4] = wet - soot * (0.5 + 0.5 * a);
    out[o + 5] = 1 + tune.smokeStreak * 0.5 * leanG * a;
    out[o + 6] = wdx;
    out[o + 7] = wdy;
    out[o + 8] = KIND_SMOKE;
    out[o + 9] = tone;
    out[o + 10] = 1 / (1 + tune.smokeStreak * 0.25 * leanG * a);
    out[o + 11] = z;
    out[o + 13] = outdoorClip;
    // its place in the column's shared grain (`stampSmokeGrain`): its ground position without the column's bend
    stampSmokeGrain(
      out,
      o,
      x - bend,
      y,
      Math.min(z, baseZ) + Math.max(0, z - baseZ) * tune.smokeLift,
      env.tilt ?? 0.45,
      frameX,
      frameY,
      massGrainS
    );
    n++;
  }
  return { count: n - start };
}

/** An upper bound on the lobes one fire can emit — what a buffer must hold per fire. */
export function maxLobesPerFire(R, tuneOverride) {
  const tune = tuneOverride ? { ...BILLOW_TUNE, ...tuneOverride } : BILLOW_TUNE;
  const body = BODY_LAYERS.reduce((n, L) => n + Math.ceil(L.count * (0.72 + 0.28 * Math.min(2, R / 50))), 0);
  return (
    Math.ceil(body) +
    Math.ceil(tune.tongueMax * tune.tongueLobes * 2.4) +
    Math.ceil(tune.fleckBase + tune.fleckPerR * R) +
    Math.ceil(tune.spitBase + tune.spitPerR * R) * 3 +
    20 +
    Math.ceil((tune.smokeBase + tune.smokePerR * R) * 2.2) +
    8
  );
}
