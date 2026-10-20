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
  const h = hashU32(Math.imul(a | 0, 0x9e3779b1) ^ hashU32(Math.imul(b | 0, 0x85ebca6b) + Math.imul(c | 0, 0xc2b2ae35)));
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
  /** the soot a wood fire adds on top (kept subtle: the art's smoke is pale). */
  soot: '#5a4a44',
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
  tongueMax: 4,
  tongueLobes: 5,
  fleckBase: 5,
  fleckPerR: 0.07,
  smokeBase: 7,
  smokePerR: 0.1,
  // ── body billows ──
  bodyRadius: 0.625, // plume radius, × R
  bodyLifeMul: 1.0, // × each layer's own cycle
  bodyHeight: 1.255, // flame-tip height, × R (a hearth burns lower, a bonfire stands up)
  // ── tongues ──
  tongueLength: 0.55, // × plume radius
  tongueLobe: 0.72,
  tongueLife: 1.9,
  tongueCurl: 3.2,
  // ── flecks ──
  fleckLife: 0.8,
  fleckSpeed: 2.2,
  fleckSize: 0.06,
  // ── smoke ──
  smokeLife: 3.6,
  smokeRise: 2.6, // × R at an open fire
  smokeSize: 0.5,
  smokeDrift: 5.0, // × R of downwind drift at a full gale
  // ── wind ──
  leanLength: 2.6, // × plume radius, at full lean
  leanCurve: 1.5,
  leanStreak: 1.6,
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
  Object.freeze({ count: 3, rho: [0.0, 0.3], rad: 0.4, life: 1.25, heat: [0.7, 0.92], z: [0.4, 0.8], swirl: 0.5, weight: 1.0 }),
  Object.freeze({ count: 5, rho: [0.0, 0.25], rad: 0.5, life: 1.0, heat: [0.85, 1.0], z: [0.12, 0.4], swirl: 0.6, weight: 1.15 }),
  Object.freeze({ count: 8, rho: [0.22, 0.62], rad: 0.55, life: 1.5, heat: [0.5, 0.78], z: [0.1, 0.35], swirl: 0.9, weight: 1.0 }),
  Object.freeze({ count: 12, rho: [0.4, 0.62], rad: 0.46, life: 2.0, heat: [0.16, 0.44], z: [0.03, 0.2], swirl: 1.1, weight: 0.95 }),
  // the satellites: small quick scallops on the edge, the painted flame's fine ragged detail
  Object.freeze({ count: 10, rho: [0.62, 0.95], rad: 0.2, life: 0.8, heat: [0.1, 0.34], z: [0.05, 0.4], swirl: 1.6, weight: 0.9 }),
]);

/** The heart: billows that NEVER respawn (a fire's body has no hole in it), just orbit the fuel and breathe. */
const HEART = Object.freeze({ count: 3, orbit: 0.1, rad: 0.6, heat: 0.92, z: 0.1, weight: 1.1 });

// ─────────────────────────────────────────────────────────────────────────────
// THE LOBE RECORD
// ─────────────────────────────────────────────────────────────────────────────

/** Floats per lobe: three vec4 attributes. A = (x, y, radius, strength), B = (heat, stretch, dirX, dirY), C = (kind, tone, 0, 0). */
export const LOBE_STRIDE = 12;
export const KIND_FLAME = 0;
export const KIND_SMOKE = 1;

/** Pool offsets inside one lobe's record, for readers. */
export const LOBE = Object.freeze({ X: 0, Y: 1, R: 2, STRENGTH: 3, HEAT: 4, STRETCH: 5, DIRX: 6, DIRY: 7, KIND: 8, TONE: 9 });

// ─────────────────────────────────────────────────────────────────────────────
// FIRE-LEVEL QUANTITIES
// ─────────────────────────────────────────────────────────────────────────────

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
  const chaos = 0.55 * Math.sin(TAU * p) + 0.3 * Math.sin(TAU * (p * 1.73 + 0.37)) + 0.15 * Math.sin(TAU * (p * 2.91 + 0.11));
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
  return clamp01(vitality01) * (1 - 0.72 * clamp01(stress01));
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
 * @property {number} [stress01=0] weather stress (`fireWeatherStress01`).
 * @property {number} [vitality01=1] the fire's slow state (1 burning, 0 out).
 * @property {number} [smokeMul=1] smoke amount (the author's dial × fuel).
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

/** Pull one spawn point for a lobe (or a disc fallback), returning [x, y, brightness]. */
function basePoint(f, R, h1, h2, h3, pull, scratch) {
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
    scratch[0] = lerp(px + Math.cos(a) * r, f.x, pull);
    scratch[1] = lerp(py + Math.sin(a) * r, f.y, pull);
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

/** The camera: ground-plane position + height → where it lands in the picture, and its magnification. */
function project(env, x, y, z, out) {
  if (env.projection === 'side') {
    out[0] = x;
    out[1] = (env.groundY ?? 0) - z * (env.sideScale ?? 1);
    out[2] = 1;
    return out;
  }
  const D = env.cameraHeight ?? BILLOW_TUNE.cameraHeight;
  const par = env.parallax ?? 1;
  const hh = clamp(z, 0, D * 0.6) * par;
  const M = D / (D - hh);
  const cx = env.camX ?? 0;
  const cy = env.camY ?? 0;
  // ⚠️ TILT: the painted fires are drawn in the 3/4 view every top-down RPG map uses — a flame rises UP THE PAGE,
  // not toward the camera — and the author asked for exactly that ("at wind 0 ... move upwards to give a sense of
  // depth and 3D"). MSA's camera is orthographic and straight down, so the tilt is faked per billow: height lifts
  // the picture up the screen by `tilt` per unit, on top of the perspective parallax.
  out[0] = cx + (x - cx) * M;
  out[1] = cy + (y - cy) * M - z * (env.tilt ?? 0.45);
  out[2] = M;
  return out;
}

/**
 * Write one fire's lobes at the clock `env.tSec`.
 *
 * @param {Float32Array} out the instance buffer.
 * @param {number} start the lobe index to start writing at.
 * @param {BillowFire} f
 * @param {BillowEnv} env
 * @param {object} [tuneOverride]
 * @returns {{count:number, flame:number, smoke:number}} lobes written.
 */
export function emitFireLobes(out, start, f, env, tuneOverride) {
  const tune = tuneOverride ? { ...BILLOW_TUNE, ...tuneOverride } : BILLOW_TUNE;
  const sz = fireSizes(f, tune);
  const { R, out: outdoor, turb, plume, height } = sz;
  const q = clamp(env.quality ?? 1, 0.2, 1);
  const anim = Math.max(0.05, env.animSpeed ?? 1);
  const t = env.tSec * anim;
  const seed = (f.seed | 0) >>> 0;

  const vit = clamp01(f.vitality01 ?? 1);
  const stress = clamp01(f.stress01 ?? 0);
  const power = billowPower(vit, stress);
  // size, count and heat all follow the one power number: the flame as a WHOLE gets smaller, thinner and cooler
  const sizeMul = 0.3 + 0.7 * Math.pow(power, 0.75);
  const heightMul = 0.3 + 0.7 * Math.pow(power, 0.85);
  const thin = Math.pow(smoothstep(0.015, 0.65, power), 0.7);
  const cool = 0.5 + 0.5 * Math.pow(power, 0.8);
  const rainDamp = 1 - clamp01(f.rain01 ?? 0) * tune.rainShrink * 0.5;

  const pulse = billowPulse(t, (f.puffHz ?? 1.6) * (0.8 + 0.5 * outdoor), (f.flickerAmp ?? 0.3) * 0.55, seed);

  // ── wind: the real wind, plus a draft in still air ──
  let wx = f.windX ?? 0;
  let wy = f.windY ?? 0;
  let m = clamp01(f.windMotion01 ?? 0);
  const draftAmp = 0.22 * (1 - outdoor) * (1 - m);
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
  const leanG = billowLeanGain(m);
  const windLen = Math.hypot(wx, wy) || 1;
  const wdx = wx / windLen;
  const wdy = wy / windLen;
  const windAng = Math.atan2(wdy, wdx);

  const proj = [0, 0, 1];
  const base = [0, 0, 1];
  let n = start;
  let flameCount = 0;
  let smokeCount = 0;
  const put = (x, y, z, radius, strength, heat, stretch, dx, dy, kind, tone) => {
    project(env, x, y, z, proj);
    const M = proj[2];
    const o = n * LOBE_STRIDE;
    out[o] = proj[0];
    out[o + 1] = proj[1];
    out[o + 2] = radius * M;
    out[o + 3] = strength;
    out[o + 4] = heat;
    out[o + 5] = stretch;
    out[o + 6] = dx;
    out[o + 7] = dy;
    out[o + 8] = kind;
    out[o + 9] = tone;
    out[o + 10] = z;
    out[o + 11] = 0;
    n++;
    if (kind === KIND_SMOKE) smokeCount++;
    else flameCount++;
  };

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
      const lean = leanG * tune.leanLength * plume * Math.pow(a, tune.leanCurve) * (0.35 + 0.65 * li / 2);
      const x = base[0] + Math.cos(th) * rho + Math.sin(wph) * wob + wdx * lean;
      const y = base[1] + Math.sin(th) * rho + Math.cos(wph * 0.83) * wob + wdy * lean;
      const rad = plume * L.rad * (0.5 + 0.5 * envR) * Math.pow(envR, 0.45) * pulse * sizeMul * rainDamp * (0.8 + 0.4 * r4);
      const heat = lerp(L.heat[0], L.heat[1], r4) * (1 - 0.3 * a) * cool;
      put(x, y, z, rad, L.weight * bodyNorm, heat, 1 + tune.leanStreak * leanG * a, wdx, wdy, KIND_FLAME, a);
    }
  }

  // ───────────────────────────── TONGUES ─────────────────────────────
  // Chains of billows that lick out and up from the body and curl at the tip. In the 3/4 picture they rise up the
  // page; from the side they are the tall, tapering, bent shapes a flame is.
  const nTongue = Math.round(lerp(tune.tongueMin, tune.tongueMax, clamp01(turb * (0.15 + 0.5 * outdoor) + 0.9 * leanG)) * q);
  const M = tune.tongueLobes;
  for (let k = 0; k < nTongue; k++) {
    const id = seed * 131 + k * 13 + 5000;
    if (hash01(id, 3, 92) > thin) continue;
    const P = (tune.tongueLife * (0.8 + 0.6 * hash01(id, 0, 1))) / (1 + 0.3 * outdoor);
    const u = t / P + hash01(id, 1, 2);
    const cyc = Math.floor(u);
    const a = u - cyc;
    const r1 = hash01(id, cyc, 21);
    const r2 = hash01(id, cyc, 22);
    const r3 = hash01(id, cyc, 23);
    const r4 = hash01(id, cyc, 24);
    const r5 = hash01(id, cyc, 25);
    const r6 = hash01(id, cyc, 26);
    basePoint(f, R, r1, r2, r3, 0.55, base);
    const envT = smoothstep(0, 0.26, a) * (1 - smoothstep(0.55, 1, a));
    if (envT < 0.01) continue;
    // outward from the fire's centre, with jitter; a base on the centre picks any direction
        // calm air: licks rise up the page (a hanging tongue reads as a drip); wind takes them downwind
    const psi0 = lerp(-Math.PI / 2 + (r4 - 0.5) * 2.2, windAng, clamp01(leanG * 2.2));
    // a hearth's tongues are short and stubby, a bonfire's long; the horizontal reach is modest, the HEIGHT is the point
    const reach = plume * tune.tongueLength * (0.45 + 0.5 * r5) * (0.35 + 0.35 * outdoor + 0.9 * leanG) * Math.pow(envT, 0.9) * heightMul;
    const curl = (r6 - 0.5) * 2 * tune.tongueCurl;
    const dl = reach / M;
    let px = base[0];
    let py = base[1];
    const tipTaper = 0.45 + 0.55 * (1 - a);
    const topZ = height * heightMul * (0.4 + 0.3 * r5) * (0.55 + 0.45 * Math.pow(envT, 0.7));
    for (let j = 0; j < M; j++) {
      const s = (j + 0.5) / M;
      // heading: the tongue's own curl, bending toward the wind more the further out it goes
      const lam = clamp01(leanG * (0.25 + 1.4 * s));
      const psi = psi0 + curl * s * s;
      let hx = Math.cos(psi) * (1 - lam) + wdx * lam;
      let hy = Math.sin(psi) * (1 - lam) + wdy * lam;
      const hl = Math.hypot(hx, hy) || 1;
      hx /= hl;
      hy /= hl;
      px += hx * dl;
      py += hy * dl;
      // wind also lays the tongue over: height falls as the lean rises
      const z = topZ * Math.pow(s, 0.85) * (1 - 0.55 * leanG * s) + height * 0.08;
      const rad = plume * tune.tongueLobe * Math.pow(1 - 0.62 * s, 1.1) * Math.pow(envT, 0.5) * pulse * sizeMul * rainDamp * tipTaper;
      const heat = (0.85 - 0.5 * s) * (1 - 0.3 * a) * cool;
      put(px, py, z, rad, 0.95, heat, 1 + 0.5 * s, hx, hy, KIND_FLAME, lerp(a, 1, s * 0.5));
    }
  }

  // ───────────────────────────── FLECKS ─────────────────────────────
  const nFleck = Math.round((tune.fleckBase + tune.fleckPerR * R) * q * (0.35 + 0.65 * outdoor));
  for (let i = 0; i < nFleck; i++) {
    const id = seed * 131 + i * 11 + 9000;
    if (hash01(id, 3, 93) > thin) continue;
    const P = (tune.fleckLife * (0.55 + 0.9 * hash01(id, 0, 1))) / (1 + 0.5 * m);
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
    const rad = plume * tune.fleckSize * (0.6 + 0.8 * r5) * Math.pow(1 - a, 0.8) * smoothstep(0, 0.08, a) * (0.5 + 0.5 * sizeMul);
    const stretch = 1 + 2.6 * (1 - a) * (0.5 + 0.5 * r5) * (1 + m);
    const dxv = Math.cos(thv) * 0.8 + wdx * 0.6 * leanG;
    const dyv = Math.sin(thv) * 0.8 + wdy * 0.6 * leanG;
    const dl2 = Math.hypot(dxv, dyv) || 1;
    // a fleck is ONE flat tone: low heat and modest strength keep it in the amber band
    put(x, y, z, rad, 1.25 * fade, (0.55 - 0.25 * a) * cool, stretch, dxv / dl2, dyv / dl2, KIND_FLAME, a);
  }

  // ───────────────────────────── SMOKE ─────────────────────────────
  const smokeRef = (tune.smokeBase + tune.smokePerR * R) * q * (f.smokeMul ?? 1);
  // a hearth's smoke is drawn up the flue: thin and low; a bonfire's is a column. A doused fire smokes MORE (steam).
  const wet = clamp01((1 - power) * (f.vitality01 > 0.02 ? 1 : 0.6) + clamp01(f.rain01 ?? 0) * 0.5);
  const smokeAmt = (0.18 + 0.82 * outdoor) * (0.45 + 0.55 * Math.min(1, power + wet * 0.8));
  const nSmoke = Math.max(0, Math.round(smokeRef * smokeAmt));
  for (let i = 0; i < nSmoke; i++) {
    const id = seed * 131 + i * 17 + 14000;
    const P = tune.smokeLife * (0.7 + 0.7 * hash01(id, 0, 1)) * (0.55 + 0.45 * outdoor);
    const u = t / P + hash01(id, 1, 2);
    const cyc = Math.floor(u);
    const a = u - cyc;
    const r1 = hash01(id, cyc, 41);
    const r2 = hash01(id, cyc, 42);
    const r3 = hash01(id, cyc, 43);
    const r4 = hash01(id, cyc, 44);
    const r5 = hash01(id, cyc, 45);
    const envS = smoothstep(0.04, 0.3, a) * (1 - smoothstep(0.62, 1, a));
    if (envS < 0.01) continue;
    basePoint(f, R, r1, r2, r3, 0.75, base);
    // smoke is born ABOVE the flame body and climbs from there, thin at first
    const zTop = R * tune.smokeRise * (0.35 + 0.65 * outdoor) * (0.75 + 0.5 * r4) * (0.6 + 0.4 * sz.iPow);
    const z = height * 0.75 + zTop * Math.pow(a, 0.9);
    const sway = plume * 0.5 * Math.sin(((t * 0.9) / P) * TAU * 0.5 + r5 * TAU) * a;
    const swayY = plume * 0.4 * Math.cos(((t * 0.7) / P) * TAU * 0.5 + r4 * TAU) * a;
    const drift = R * tune.smokeDrift * (0.15 + 0.85 * leanG) * (0.12 + Math.pow(a, 1.3));
    // a sealed room's smoke goes nowhere in particular: it just rises and fades
    const x = base[0] + sway + wdx * drift;
    const y = base[1] + swayY + wdy * drift;
    const rad = plume * tune.smokeSize * (0.55 + 1.15 * a) * Math.pow(envS, 0.6) * (0.85 + 0.35 * r3);
    const tone = clamp01(a * 1.05 + 0.08 * r2);
    put(x, y, z, rad, (0.5 + 0.5 * smokeAmt) * Math.pow(envS, 0.55) * (0.85 + 0.3 * r3), wet, 1 + 0.5 * leanG * a, wdx, wdy, KIND_SMOKE, tone);
  }

  return { count: n - start, flame: flameCount, smoke: smokeCount };
}

/** An upper bound on the lobes one fire can emit — what a buffer must hold per fire. */
export function maxLobesPerFire(R, tuneOverride) {
  const tune = tuneOverride ? { ...BILLOW_TUNE, ...tuneOverride } : BILLOW_TUNE;
  const body = BODY_LAYERS.reduce((n, L) => n + Math.ceil(L.count * (0.72 + 0.28 * Math.min(2, R / 50))), 0);
  return Math.ceil(body) + tune.tongueMax * tune.tongueLobes + Math.ceil(tune.fleckBase + tune.fleckPerR * R) + Math.ceil((tune.smokeBase + tune.smokePerR * R) * 2.2) + 8;
}
