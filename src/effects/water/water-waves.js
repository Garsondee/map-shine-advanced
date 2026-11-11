/**
 * THE ONE WAVE SYSTEM (2026-11-10, mmp-78u.30.9 — Ingram: "Ideally the caustics, wave shape and the light shafts would
 * all be from a single connected system working together on the GPU ... this would obviously need to change the
 * specular which should be driven by the normal of the waves ... use the actual wind texture, don't make things up ...
 * Completely replace the older version of water with this one and make it on by default.")
 *
 * ONE SOURCE OF TRUTH, per viewer: a wind-wave SPECTRUM — WAVE_COUNT sine components on a lattice that tiles every
 * WAVE_TILE_PX — whose HEIGHTS follow the wind (fetch-limited JONSWAP peak, Mitsuyasu spreading, total slope scaled to
 * Cox & Munk's measured sea-surface statistics). Every frame:
 *
 *   1. BAKE   the spectrum into two tiling textures (wind sea, ripples): height, slope x, slope y, curvature.
 *   2. SPLAT  the caustics: a photon grid over the view refracts the real sun (Snell) through the baked surface down to
 *             the bed at WAVE_SLICES_M depths; each cell lands with brightness = the area it had ÷ the area it lands on.
 *             The bright net is wherever the waves focus light, and nowhere else.
 *
 * and the water material reads the same textures through {@link createWaterWaveSystem}'s node builders:
 *   `surfaceAt`  the normal (specular, refraction, glint), wave height (crest foam);
 *   `causticAt`  the bed light at its real depth;
 *   `shaftsAt`   light scattered in the column: the slices marched down to the bed along the refracted sun run.
 *
 * THE REAL WIND: both bands are scaled per pixel by the viewer's wind STRENGTH texture (the baked wind field: gusts,
 * walls, shelter, the 3-D air) ÷ the scene's own strength: ripples follow the local air at once (ratio^1.5, cat's paws
 * and glassy lees), the wind sea gently (ratio^0.5).
 *
 * WHY A FIXED SET: the components (lattice wavenumbers, directions, phases) are chosen ONCE per seed, spread log-evenly
 * in length and evenly round the compass; only their AMPLITUDES follow the wind (speed, bearing, fetch). A wind change
 * then reshapes the sea smoothly instead of swapping one set of waves for another. Phases are integrated on the CPU in
 * double precision (ω·dt plus the current's k·v·dt), wrapped, so neither long sessions nor slider moves jump.
 *
 * Measured in the shader lab (`tools/shader-lab/wave-lab.html`, 1280×720): bake ~0.4 ms, five slices ~0.8 ms.
 * Evaluating the sines per splat vertex instead cost 715 ms a frame (memory: wave-lab-one-system-2026-11-10).
 *
 * @module effects/water/water-waves
 */

/** Tile of the wave pattern, world px (the lattice repeats on it). */
export const WAVE_TILE_PX = 1024;
/** Components in the fixed set. */
export const WAVE_COUNT = 96;
/** Bake resolution of each band texture (2.7 px a texel at the tile size). */
export const WAVE_BAKE_RES = 384;
/** Bake resolution of the ripple band: one texel per world px of the tile (the finest waves drawn are ~40 px). */
export const WAVE_RIPPLE_BAKE_RES = 1024;
/** The second ripple read's scale (2^(−1/3), irrational): its tile never lines up with the first. */
export const WAVE_RIPPLE_SCALE2 = Math.pow(2, -1 / 3);
/** The ripple band is read on the plane turned by this angle (tan irrational), so the bands never share a period. */
export const WAVE_RIPPLE_ROT = Math.atan(Math.SQRT1_2);
/**
 * THE WIND SHAPES THE RIPPLES (2026-11-10, Ingram: "I would have thought that waves would elongate as they get pushed by
 * the wind ... it doesn't effect their shape or speed of movement"). The ripple band is baked ONCE, running toward +x of
 * its own plane with a narrow spread (`WAVE_RIPPLE_SPREAD_S`: long crests), and read turned to `WAVE_RIPPLE_BINS` fixed
 * bearings round the compass (offset by `WAVE_RIPPLE_ROT`, so no bearing shares the wind sea's lattice). Each pixel blends
 * the three bearings nearest ITS OWN wind (the wind texture's direction): in a steady breeze one bearing — long crests
 * across the wind; in light, confused air all three — a short criss-cross chop; turning gusts swing the crests with them.
 */
export const WAVE_RIPPLE_BINS = 8;
/** The canonical ripple bake's directional spread, cos^2s(Δ/2) (s = 6: half the energy within ±16°). */
export const WAVE_RIPPLE_SPREAD_S = 6;
/** Each bearing reads the bake at its own scale (irrational ratios) so neighbouring bearings never share a period. */
export const WAVE_RIPPLE_BIN_SCALES = Object.freeze([1, Math.pow(2, -1 / 6), Math.pow(2, -1 / 3)]);
/** How sharply the blend narrows onto the wind's own bearing: exponent s at a calm and at a strong wind (m/s). */
export const WAVE_RIPPLE_BIN_S_CALM = 0.3;
export const WAVE_RIPPLE_BIN_S_WINDY = 10;
export const WAVE_RIPPLE_BIN_WINDY_MS = 10;
/**
 * THE SURFACE DRIFTS WITH THE WIND (2026-11-10, Ingram: "the white lines progress at the same rate in low and high
 * wind"). A wave's own speed is set by its length (c = √(g/k)) — the wind cannot hurry a given wave — but the wind drags
 * the top of the water along at ~3% of its speed (wind drift + Stokes drift), and everything on it rides that: the
 * ripple pattern, foam, flecks. Per pixel, from the wind texture, integrated on the GPU (`driftRT`).
 */
export const WAVE_DRIFT_SHARE = 0.03;
/**
 * THE FLOW CARRIES THE PATTERN, THE WIND MIXES IN (2026-11-10, Ingram: "I think the caustics might still only be pushed by
 * the wind, not the flow. Ideally flow should always be a lot stronger than the wind effect, but both effects should mix").
 * They were: the wind sea's every wave marched downwind at its own phase speed (~90-225 px/s, three to seven times a
 * river's ~30 px/s) and rode one compass current, the same in a river bend as in a closed pond; only the small ripples
 * read the solved current. Now NO wave marches by itself: alternate components of both bands run their phases forward
 * and backward (`waveBoilSign`), so the surface still boils and shimmers in place, and every bit of travel comes from one
 * per-texel drift (`driftRT`) = the LOCAL current + a downwind wind travel: `WAVE_WIND_TRAVEL_SHARE` of the sea's peak
 * phase speed on still water, but where the water runs never more than `WAVE_WIND_IN_FLOW_RATIO` of the current itself. Still water moves with the
 * wind (faster in a stronger wind); a river moves with the river, the wind leaning on it a little.
 */
export const WAVE_WIND_TRAVEL_SHARE = 0.4;
/** Where the water runs, the wind's travel is this share of the CURRENT's speed (flow "a lot stronger", both mixed). */
export const WAVE_WIND_IN_FLOW_RATIO = 0.35;
/** Normalised current (1 = the free stream) where the water starts to count as flowing, and where it fully does
 * (MEASURED, Lab · River: river reaches run 0.1-0.35, rapids ~1, a closed pond exactly 0). */
export const WAVE_FLOWING_LO = 0;
export const WAVE_FLOWING_HI = 0.12;
/** ±1: which way component `i` runs its phase. Alternating, so the field boils in place with no net travel. */
export function waveBoilSign(i) {
  return i % 2 === 0 ? 1 : -1;
}
/**
 * CPU twin of the drift's velocity (world px/s) — what the shader's `driftQuad` integrates.
 * @param {object} o
 * @param {number[]} o.currentPx - the local current, world px/s
 * @param {number[]} o.windDir - unit, toward
 * @param {number} o.windRatio - local wind ÷ scene wind (gusts, shelter), 0..2
 * @param {number} o.peakSpeedPx - the wind sea's peak phase speed, world px/s (0 at a calm)
 * @param {number} o.flowSpeedPx - world px/s a normalised current of 1 stands for
 * @param {number} [o.share] - `WAVE_WIND_TRAVEL_SHARE`
 * @returns {{vx:number, vy:number, windPx:number, flowing:number}}
 */
export function wavePatternVelocity({
  currentPx,
  windDir,
  windRatio,
  peakSpeedPx,
  flowSpeedPx,
  share = WAVE_WIND_TRAVEL_SHARE,
}) {
  const cur = Math.hypot(currentPx[0], currentPx[1]) / Math.max(flowSpeedPx, 1e-3);
  const t = Math.min(1, Math.max(0, (cur - WAVE_FLOWING_LO) / (WAVE_FLOWING_HI - WAVE_FLOWING_LO)));
  const flowing = t * t * (3 - 2 * t);
  const still = Math.max(0, peakSpeedPx) * share * Math.min(2, Math.max(0, windRatio));
  const windPx = still + (Math.min(still, WAVE_WIND_IN_FLOW_RATIO * cur * flowSpeedPx) - still) * flowing;
  return { vx: currentPx[0] + windDir[0] * windPx, vy: currentPx[1] + windDir[1] * windPx, windPx, flowing };
}
/** Flow-map cycle, seconds: each of two phases integrates its drift for one cycle, then restarts unseen. */
export const WAVE_FLOW_CYCLE_SEC = 2;
/**
 * ⚠️ THE DRIFT MUST NOT CRUSH THE PATTERN (2026-11-10, mmp-78u.30.18 — Ingram, Lab · River rapids: "The distortions are
 * creating extremely strong over strong lines and breaking points, the caustics are being crushed and swirled ... The
 * edges of the river show comb like gaps"). MEASURED with the live instruments (`tune({debugView})`): over the rapids
 * the drift stretched the pattern to double or worse almost everywhere, and the field showed ~25 px squares (256 texels
 * over the whole scene) that tear into combs at the banks. A pattern carried for a whole cycle by a current that changes
 * from texel to texel round a rock is sheared by (Δv per px) × cycle. So: the current the drift reads is blurred over
 * `WAVE_DRIFT_BLUR_TEXELS`, its speed is softly capped at `WAVE_DRIFT_SPEED_CAP_PX` (the water still runs that fast; its
 * pattern need not travel at it), the field is twice as fine, the cycle is 2 s, and the caustics are splatted from the
 * surface read at `WAVE_CAUSTIC_DRIFT_SHARE` of the drift — the bed's light distorts less than the surface over it.
 */
export const WAVE_DRIFT_BLUR_TEXELS = 1.5;
export const WAVE_DRIFT_SPEED_CAP_PX = 80;
export const WAVE_CAUSTIC_DRIFT_SHARE = 0.4;
/** Drift field resolution (over the wind texture's rect). */
export const WAVE_DRIFT_RES = 512;
/**
 * WIND-SHAPED CRESTS: in a real wind sea the downwind face is steep and the crests are sharp, the troughs broad. Applied
 * to the summed surface: the slope down the wind's face is steepened (`WAVE_CREST_LEAN`), the up-wind back eased, and
 * slopes near crests sharpened (`WAVE_CREST_SHARP`), both growing with the local wind from a breeze to `WAVE_CREST_FULL_MS`.
 */
export const WAVE_CREST_LEAN = 0.35;
export const WAVE_CREST_SHARP = 0.4;
export const WAVE_CREST_FULL_MS = 14;
/** Depth slices the caustics are splatted at, metres (log spaced). */
export const WAVE_SLICES_M = Object.freeze([0.15, 0.4, 0.9, 1.8, 3.5]);
/** Caustic slice resolution (each covers the view). */
export const WAVE_CAUSTIC_RES = 1536;
/** The caustic atlas redraws every this-many frames while the view is still (1 = every frame). */
export const WAVE_ATLAS_EVERY = 2;
/** Photon grid cells across the view (and down, scaled by aspect) — ~3 px at a 1280 px wide view. */
export const WAVE_SPLAT_CELLS = 900;
/** Margin round the view the photon grid also covers, as a fraction of the view (refraction carries light in). */
export const WAVE_SPLAT_MARGIN = 0.22;
/** Share of the measured slope variance drawn as geometry; the rest roughens the glint (lab: 0.6 over-focuses). */
export const WAVE_RESOLVED_SLOPE = 0.2;
/** The Surface chop dial's value at which the drawn sea matches the measured one (= `WATER_TIER3_CHOP`, pinned by a test). */
export const WAVE_CHOP_REFERENCE = 0.31;
/** Shortest drawn wave, as a multiple of the peak wavenumber (shorter ones become glint roughness). */
export const WAVE_DRAW_KP_MULT = 40;
/** Water's index of refraction. */
export const WAVE_IOR = 1.333;
/** Metres of water at mask white with the Depth dial at its default (for caustic slices). */
export const WAVE_DEPTH_M_AT_WHITE = 2.5;
/** Bed caustics read at most about this depth (m), eased in: deeper nets fold into double lines. */
export const WAVE_CAUSTIC_DEPTH_CAP_M = 0.9;
/** Size of the caustic-strength patches, metres (low frequency). */
export const WAVE_CAUSTIC_MASK_SCALE_M = 22;
/** Patch drift as a share of the wind speed. */
export const WAVE_CAUSTIC_MASK_DRIFT = 0.12;
/** Caustic strength in the weakest and strongest patches (the overall level is lowered: peak < 1). */
export const WAVE_CAUSTIC_MASK_FLOOR = 0.3;
export const WAVE_CAUSTIC_MASK_PEAK = 0.9;
/**
 * Mip level the bed reads its caustic slices at. ⚠️ BEADED LINES (2026-11-10): long wind crests focus the sun into long
 * focal lines thinner than a photon cell (~3 px); their splat triangles go sub-pixel and the lines came out dotted. A
 * read a fraction of a level up joins the beads into a line (the mean is kept: mips average).
 */
export const WAVE_CAUSTIC_LOD = 0;
/** The brightest one photon cell may focus (× flat water): a fold's near-zero-area triangle otherwise spikes. */
export const WAVE_SPLAT_MAX = 60;
/** Caustic contrast: gain on the deviation from flat water's light (see `contrastOf`). */
export const WAVE_CAUSTIC_CONTRAST = 1.7;
/** Width of the shaft glow's softening cross, metres (a pool of light, not a line). */
export const WAVE_SHAFT_SOFT_M = 0.45;
/** (unused: the shafts no longer read mips) Mip level the shafts read the slices at (blur ≈ 2^lod texels: wide enough that the march's steps merge, no echoes). */
export const WAVE_SHAFT_LOD = 4;
/** The darkest a spread caustic cell gets, × flat water's direct light. */
export const WAVE_CAUSTIC_FLOOR = 0.12;
/** Shortest and longest component wavelengths in the fixed set, metres. */
export const WAVE_MIN_LEN_M = 0.22;
export const WAVE_MAX_LEN_M = 14;

const G = 9.81;
const TAU_RHO = 7.3e-5;
/** The arc either side of +x the canonical ripples are drawn over (cos^12(60°/2) = 0.18: the spread's tail is kept). */
const RIPPLE_HALF_ARC = Math.PI / 3;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** m/s for MSA's wind dial (world/wind-scale.js: 0.1 = 7 m/s, 0.2 = 14, 0.3 = 21), duplicated here as a pure fn. */
export function waveWindMetresPerSecond(wind01, metresPerSecondForSpeed01) {
  const ms = metresPerSecondForSpeed01 ? metresPerSecondForSpeed01(Math.max(0, wind01 || 0)) : (wind01 || 0) * 70;
  // 0 is a real calm (glass); above 30 m/s the sea's spectrum is fully developed beyond anything a map shows
  return Math.max(0, Math.min(30, ms));
}

/**
 * The fixed component set: lattice wavenumbers spread log-evenly in length and evenly round the compass, random
 * phases. Pure.
 * @param {{seed?: number, pxPerM?: number, count?: number, tilePx?: number}} o
 * @returns {Array<{n:number, m:number, kx:number, ky:number, k:number, theta:number, ph:number, dArea:number}>}
 *   k in rad/m; kx/ky in rad/px; dArea = the k-space area (rad²/m²) each component stands for.
 */
export function buildWaveSet({ seed = 7, pxPerM = 100 / 1.524, count = WAVE_COUNT, tilePx = WAVE_TILE_PX } = {}) {
  const tileM = tilePx / pxPerM;
  const dk = (2 * Math.PI) / tileM;
  const kMin = Math.max(dk, (2 * Math.PI) / WAVE_MAX_LEN_M);
  const kMax = (2 * Math.PI) / WAVE_MIN_LEN_M;
  const ln = Math.log(kMax / kMin);
  const r = rng(seed);
  const used = new Set();
  const out = [];
  for (let i = 0; i < count; i++) {
    // stratified in log-k and in angle so the set covers the plane evenly
    const u = (i + r()) / count;
    const k0 = kMin * Math.exp(ln * u);
    // the pure ripples are baked CANONICAL (toward +x, narrow spread: see `WAVE_RIPPLE_BINS`), so they are drawn only
    // within ±`RIPPLE_HALF_ARC` of +x — every one of them then carries energy, instead of a handful out of the circle
    const canon = waveRippleWeight(k0) >= 1;
    const th0 = canon ? (r() - 0.5) * 2 * RIPPLE_HALF_ARC : r() * Math.PI * 2;
    let n = Math.round((k0 * Math.cos(th0)) / dk);
    let m = Math.round((k0 * Math.sin(th0)) / dk);
    if (!n && !m) n = 1;
    let guard = 0;
    while (used.has(`${n},${m}`) && guard++ < 20) {
      n += r() < 0.5 ? 1 : -1;
      if (!n && !m) m = 1;
    }
    used.add(`${n},${m}`);
    const kxm = n * dk;
    const kym = m * dk;
    const k = Math.hypot(kxm, kym);
    out.push({
      n,
      m,
      kx: kxm / pxPerM,
      ky: kym / pxPerM,
      k,
      theta: Math.atan2(kym, kxm),
      ph: r() * Math.PI * 2,
      // proposal density per k-space area: 1 / (k² · ln(kMax/kMin) · arc) per component (arc = the angle drawn over)
      dArea: (k * k * ln * (canon ? 2 * RIPPLE_HALF_ARC : 2 * Math.PI)) / count,
    });
  }
  // ascending wavenumber: each band's bake loops over only its own index range (`waveBandRanges`)
  return out.sort((a, b) => a.k - b.k);
}

/**
 * The index ranges of a (sorted) set each band can hold: the wind sea [0, seaEnd), the ripples [rippleStart, count).
 * The bands overlap only across the split's smooth crossover. Pure.
 */
export function waveBandRanges(set) {
  let seaEnd = 0;
  while (seaEnd < set.length && waveRippleWeight(set[seaEnd].k) < 1) seaEnd++;
  let rippleStart = set.length;
  while (rippleStart > 0 && waveRippleWeight(set[rippleStart - 1].k) > 0) rippleStart--;
  return { seaEnd, rippleStart };
}

/** Cox & Munk's measured total mean-square slope of the sea surface at a wind (m/s). */
export function coxMunkSlopeVar(U) {
  return 0.0005 + 0.00512 * Math.max(0, U);
}

/** The wind at which the drawn sea is pinned to `WAVE_RESOLVED_SLOPE` of Cox & Munk (the look tuned in Foundry, 7 m/s). */
export const WAVE_REFERENCE_WIND_MS = 7;
/** Wavelength (m) splitting the wind sea (longer: built over the fetch, follows the scene's wind slowly) from the
 *  ripples (shorter: raised by the air right overhead, follow the local wind texture at once). */
export const WAVE_RIPPLE_SPLIT_M = 1.2;
/** The drawn sea always reaches waves this short (m), however long the peak: a gale's sea is not four big blobs. */
export const WAVE_DRAW_MIN_CUT_M = 0.5;
/** Seconds the wind sea takes to follow a change of the scene's wind (real seas build and decay; no snaps). */
export const WAVE_SEA_RESPONSE_SEC = 4;

/** JONSWAP peak for a wind and fetch: ω_p (rad/s), α, k_p (rad/m). Pure. */
export function wavePeak(U, fetchM) {
  const u = Math.max(0.3, U);
  const gF = (G * Math.max(1, fetchM)) / (u * u);
  let wp = 2 * Math.PI * 3.5 * (G / u) * Math.pow(gF, -0.33);
  wp = Math.max(wp, (0.855 * G) / u); // never beyond a fully developed sea
  return { wp, alpha: 0.076 * Math.pow(gF, -0.22), kp: (wp * wp) / G };
}

/** S(ω)·dω/dk at wavenumber k (rad/m): the omnidirectional wavenumber spectrum, m³. Pure. */
function spectrumK(k, wp, alpha) {
  const w = Math.sqrt(G * k + TAU_RHO * k ** 3);
  const sig = w <= wp ? 0.07 : 0.09;
  const rr = Math.exp(-((w - wp) ** 2) / (2 * sig * sig * wp * wp));
  const S = ((alpha * G * G) / w ** 5) * Math.exp(-1.25 * (wp / w) ** 4) * 3.3 ** rr;
  const dwdk = (G + 3 * TAU_RHO * k * k) / (2 * w);
  return { Sk: S * dwdk, w };
}

/**
 * The CALIBRATION of a sea (2026-11-10): the factor that makes the WHOLE continuous spectrum (every wave from the
 * longest to 4 mm capillaries) carry exactly Cox & Munk's measured slope. JONSWAP's α is fitted to heights, not slopes;
 * this pins it to the measured surface. Pure.
 */
export function waveSlopeCalibration(U, fetchM) {
  const { wp, alpha } = wavePeak(U, fetchM);
  const k0 = 0.02;
  const k1 = (2 * Math.PI) / 0.004;
  const N = 600;
  const dl = Math.log(k1 / k0) / N;
  let sv = 0;
  for (let i = 0; i < N; i++) {
    const k = k0 * Math.exp((i + 0.5) * dl);
    sv += k * k * spectrumK(k, wp, alpha).Sk * k * dl; // ∫ k² S(k) dk, dk = k·dln k
  }
  return sv > 0 ? coxMunkSlopeVar(U) / sv : 0;
}

/**
 * The weight of each of the `WAVE_RIPPLE_BINS` ripple bearings for a local wind bearing (radians, world) and blend
 * exponent `s` — the pure mirror of the shader's `ripplesAt` (three nearest bearings, cos^2s(Δ/2), windowed to 0 at ±1.5
 * bins, Σw² = 1). Pure.
 * @returns {number[]} one weight per bearing index 0..BINS−1
 */
export function waveRippleBinWeights(ang, s) {
  const BIN = (2 * Math.PI) / WAVE_RIPPLE_BINS;
  const out = new Array(WAVE_RIPPLE_BINS).fill(0);
  const c = Math.floor((ang - WAVE_RIPPLE_ROT) / BIN + 0.5);
  let w2 = 0;
  const ws = [];
  for (const j of [-1, 0, 1]) {
    const b = c + j;
    const d = Math.abs(ang - (b * BIN + WAVE_RIPPLE_ROT));
    const t = Math.min(1, Math.max(0, (d - BIN * 1.5) / (BIN * 1.0 - BIN * 1.5)));
    const w = Math.pow(Math.cos(d / 2), 2 * s) * t * t * (3 - 2 * t);
    ws.push([((b % WAVE_RIPPLE_BINS) + WAVE_RIPPLE_BINS) % WAVE_RIPPLE_BINS, w]);
    w2 += w * w;
  }
  const n = Math.sqrt(Math.max(w2, 1e-6));
  for (const [bm, w] of ws) out[bm] += w / n;
  return out;
}

/** The ripple band's weight (0 = wind sea, 1 = ripple) for a wavenumber (rad/m). Pure. */
export function waveRippleWeight(k) {
  return smooth01(Math.log(k / ((2 * Math.PI) / WAVE_RIPPLE_SPLIT_M)) + 0.5);
}

/**
 * The ripples' response to the LOCAL wind (m/s), relative to the reference wind they are baked at. Cox & Munk's slope
 * grows linearly with the wind (amplitude ∝ √U), and below the capillary onset (~0.5–2.5 m/s, cat's paws) the water
 * stays glassy: no air, no ripples. Mirrored in the shader (`localGains`). Pure.
 */
export function waveRippleGain(U) {
  const u = Math.min(30, Math.max(0, U));
  return smooth01((u - 0.5) / 2) * Math.sqrt(u / WAVE_REFERENCE_WIND_MS);
}

/**
 * Physical amplitudes (m², per component) of one band of the sea for a wind, before the drawing gain. Pure.
 * @param {'sea'|'ripple'|'all'} band
 */
function bandA2(set, { U, towardRad, fetchM, band, spreadS = null }) {
  const { wp, alpha, kp } = wavePeak(U, fetchM);
  const cal = waveSlopeCalibration(U, fetchM);
  // THE VISIBLE SEA IS THE PEAK'S (2026-11-10, Ingram in Foundry: "The frequency looks too high ... the waves are too
  // small"). The slope spectrum is nearly flat per octave, so drawn as-is the finest ripples carry as much slope as the
  // swell and the eye reads only them. Waves shorter than ~a ninth of the peak taper off; their slope goes to the glint
  // roughness. ⚠️ But never cut longer than WAVE_DRAW_MIN_CUT_M (2026-11-10, Ingram at full wind: "very low resolution
  // and look odd"): a gale's peak is 9 m long, and cut at 9·k_p only a handful of long waves were left to draw.
  const kCut = Math.max(WAVE_DRAW_KP_MULT * kp, (2 * Math.PI) / WAVE_DRAW_MIN_CUT_M);
  return set.map((c) => {
    const { Sk, w } = spectrumK(c.k, wp, alpha);
    const s = spreadS ?? Math.max(1, Math.min(20, 11.5 * Math.pow(w / wp, w > wp ? -2.5 : 5)));
    // cos^2s(Δ/2), normalised to integrate to 1 round the circle (Longuet-Higgins): Γ(s+1)/(2√π Γ(s+½))
    const norm = Math.exp(lgamma(s + 1) - lgamma(s + 0.5)) / (2 * Math.sqrt(Math.PI));
    const D = norm * Math.pow(Math.abs(Math.cos((c.theta - towardRad) / 2)), 2 * s);
    const Fk = (Sk * D) / c.k;
    const taper = Math.exp(-((c.k / kCut) ** 2));
    const r = waveRippleWeight(c.k);
    const bw = band === 'all' ? 1 : band === 'ripple' ? r : 1 - r;
    return 2 * Fk * c.dArea * cal * taper * bw;
  });
}

const slopeVarOf = (set, a2) => a2.reduce((acc, x, i) => acc + (x * set[i].k * set[i].k) / 2, 0);

/**
 * The sea for a wind: amplitudes (px) for the fixed set, plus the numbers worth reporting. Pure.
 *
 * ⚠️ PHYSICAL, NOT RENORMALISED (2026-11-10, Ingram: "The water looks very strange at 0 wind and looks wierd
 * transitioning into lower speeds" / "very low resolution and look odd when wind is at full 100"). The first cut
 * rescaled the drawn set to a fixed share of Cox & Munk at EVERY wind. At a calm the real peak is shorter than the
 * set's shortest wave, so that rescale blew a sliver of spectral tail up into big nonsense waves; at a gale it poured
 * all the slope into the few longest waves. Now each band is the real calibrated spectrum, and ONE drawing gain is
 * fixed at the reference wind (7 m/s, the look tuned in Foundry): a calm draws almost nothing (glass, its slope all
 * glint), a gale draws what its sea really holds between 14 m and half a metre.
 *
 * @param {ReturnType<typeof buildWaveSet>} set
 * @param {{windMs:number, towardRad:number, fetchM:number, pxPerM:number, resolved?:number}} o - `windMs` = the
 *   scene's wind (the WIND SEA's); `towardRad` = the direction the wind blows TOWARD, as a math angle in world px axes
 *   (y down). The RIPPLE band is baked at {@link WAVE_REFERENCE_WIND_MS} and scaled per pixel by the local wind
 *   ({@link waveRippleGain}).
 */
export function waveAmplitudes(
  set,
  { windMs, towardRad, fetchM, pxPerM, resolved = WAVE_RESOLVED_SLOPE, rippleSpread = WAVE_RIPPLE_SPREAD_S }
) {
  const U = Math.max(0, windMs || 0);
  const F = Math.max(1, fetchM);
  const Uref = WAVE_REFERENCE_WIND_MS;
  // the drawing gain: at the reference wind the whole drawn sea carries `resolved` of Cox & Munk
  // (the reference counts the ripples as they are drawn: canonical, so the gain does not depend on the wind's bearing)
  const refVar =
    slopeVarOf(set, bandA2(set, { U: Uref, towardRad, fetchM: F, band: 'sea' })) +
    slopeVarOf(set, bandA2(set, { U: Uref, towardRad: 0, fetchM: F, band: 'ripple', spreadS: rippleSpread }));
  const gain2 = refVar > 0 ? (coxMunkSlopeVar(Uref) * resolved) / refVar : 0;
  // no air, no wind sea: below ~1 m/s the water is glass (the spectrum's own tail would leave a faint ghost)
  const calm = smooth01((U - 0.3) / 0.9);
  const seaA2 = bandA2(set, { U: Math.max(0.3, U), towardRad, fetchM: F, band: 'sea' }).map((x) => x * gain2 * calm);
  // the ripple band is CANONICAL: baked running toward +x of its own plane with a narrow spread; the shader turns it to
  // each pixel's own wind (`WAVE_RIPPLE_BINS`). Its slope budget is the reference sea's ripple share (same gain).
  const ripA2 = bandA2(set, { U: Uref, towardRad: 0, fetchM: F, band: 'ripple', spreadS: rippleSpread }).map(
    (x) => x * gain2
  );
  const { wp, kp } = wavePeak(Math.max(0.3, U), F);
  const rg = waveRippleGain(U);
  const drawnVar = slopeVarOf(set, seaA2) + slopeVarOf(set, ripA2) * rg * rg;
  const ampsSea = seaA2.map((x) => Math.sqrt(Math.max(0, x)));
  const ampsRip = ripA2.map((x) => Math.sqrt(Math.max(0, x)));
  const hsM =
    4 *
    Math.sqrt(ampsSea.reduce((a, s) => a + (s * s) / 2, 0) + ampsRip.reduce((a, s) => a + (s * s * rg * rg) / 2, 0));
  return {
    U,
    peakOmega: wp,
    peakWavelengthM: (2 * Math.PI) / kp,
    peakPeriodSec: (2 * Math.PI) / wp,
    hsM,
    hsPx: hsM * pxPerM,
    /** Share of Cox & Munk drawn as geometry at this wind (the rest is glint roughness). */
    drawnShare: drawnVar / coxMunkSlopeVar(U),
    glintRoughness: Math.sqrt(Math.max(0.0004, coxMunkSlopeVar(U) - drawnVar)),
    /** Per component: the wind-sea amplitude (px) at this wind, and the ripple amplitude (px) at the reference wind. */
    ampsSea: ampsSea.map((a) => a * pxPerM),
    ampsRipple: ampsRip.map((a) => a * pxPerM),
    omegas: set.map((c) => Math.sqrt(G * c.k + TAU_RHO * c.k ** 3)),
  };
}

function smooth01(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** ln Γ(x), Lanczos — enough for the spreading normaliser. */
function lgamma(x) {
  const c = [
    76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155, 0.001208650973866179,
    -0.5395239384953e-5,
  ];
  let y = x;
  const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -t + Math.log((2.5066282746310007 * ser) / x);
}

/**
 * How far the wind blows over open water here, metres: the water's extent, or OPEN SEA when the water runs off the
 * scene's edge (a map's coastline is a window onto a sea, not a pond). Pure.
 * @param {{bounds:{minX:number,minY:number,maxX:number,maxY:number}|null, sceneRect?:object|null, pxPerM:number}} o
 */
export function waveFetchMetres({ bounds, sceneRect = null, pxPerM }) {
  if (!bounds) return 50;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / Math.max(1e-3, pxPerM);
  if (sceneRect) {
    const tol = 8;
    const touches =
      bounds.minX <= sceneRect.minX + tol ||
      bounds.minY <= sceneRect.minY + tol ||
      bounds.maxX >= sceneRect.maxX - tol ||
      bounds.maxY >= sceneRect.maxY - tol;
    if (touches && span > 30) return 2000;
  }
  return Math.min(2000, Math.max(3, span));
}

/**
 * Where the caustic slices and the photon grid sit for a view, WORLD-LOCKED (2026-11-10, the pan crawl): the slices'
 * origin snapped to whole texels, the grid's to whole cells, both sizes set by the view's span alone. A pure pan then
 * lands every photon on the same world point and into the same world texel as the frame before. Pure.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} v
 * @returns {{view:number[], grid:number[]}} each [minX, minY, spanX, spanY] in world px
 */
export function waveViewLayout(v) {
  // spans rounded to 1/16 px: maxX − minX carries float dust that changes as the camera moves, and a cell size off by
  // one ulp lets the "locked" lattice drift across a long pan
  const spanX = Math.max(1, Math.round((v.maxX - v.minX) * 16) / 16);
  const spanY = Math.max(1, Math.round((v.maxY - v.minY) * 16) / 16);
  const tx = spanX / WAVE_CAUSTIC_RES;
  const ty = spanY / WAVE_CAUSTIC_RES;
  const vx = Math.floor(v.minX / tx) * tx;
  const vy = Math.floor(v.minY / ty) * ty;
  const cellsY = Math.round(WAVE_SPLAT_CELLS * 0.6);
  const gx = (spanX * (1 + 2 * WAVE_SPLAT_MARGIN)) / WAVE_SPLAT_CELLS;
  const gy = (spanY * (1 + 2 * WAVE_SPLAT_MARGIN)) / cellsY;
  const x0 = Math.floor((v.minX - spanX * WAVE_SPLAT_MARGIN) / gx) * gx;
  const y0 = Math.floor((v.minY - spanY * WAVE_SPLAT_MARGIN) / gy) * gy;
  // spans exact (vertex spacing = one cell, texel = one snapped step); the snap costs at most one cell/texel of margin
  return {
    view: [vx, vy, spanX, spanY],
    grid: [x0, y0, gx * WAVE_SPLAT_CELLS, gy * cellsY],
  };
}

/**
 * The per-viewer GPU wave system.
 * @param {object} o
 * @param {*} o.THREE
 * @param {() => ({texture:*, uRect:*}|null)} [o.getWindStrengthField] - the viewer's per-frame wind strength texture.
 * @param {(speed01Node:*) => *} [o.windStrength01Node] - `world/wind-field.js#windStrength01Node` bound to TSL.
 * @param {(speed01:number) => number} [o.metresPerSecondForSpeed01]
 * @param {number} [o.seed]
 */
export function createWaterWaveSystem({
  THREE,
  getWindStrengthField = null,
  getFlowField = null,
  windStrength01Node = null,
  metresPerSecondForSpeed01 = null,
  seed = 7,
}) {
  const TSL = THREE.TSL;
  const {
    Fn,
    Loop,
    uniform,
    float,
    int,
    vec2,
    vec3,
    vec4,
    ivec2,
    textureLoad,
    texture,
    uv,
    sin,
    cos,
    normalize,
    refract,
    varying,
    dFdx,
    dFdy,
    abs,
    max,
    min,
    clamp,
    pow,
    mix,
    exp,
    log,
    smoothstep,
    mx_fractal_noise_float,
    atan,
    fract,
    floor,
    mod,
    sqrt,
    dot,
    length,
  } = TSL;
  const K = WAVE_COUNT;

  let pxPerM = 100 / 1.524;
  let set = buildWaveSet({ seed, pxPerM });
  const phase = new Float64Array(K);
  const phaseR = new Float64Array(K); // the ripple band's own (its waves run in the turned frame, the current differs)
  for (let i = 0; i < K; i++) phase[i] = phaseR[i] = set[i].ph;
  let sea = null;
  let seaKey = '';
  let seaMs = null;
  let flowT = 0.25; // flow-map cycles (both phases mid-weight at the start)
  let driftRectKey = '';
  /** Session-only overrides for tuning in Foundry (`MapShine.tuneWaterWaves({contrast: 1})`); a reload forgets them. */
  const tune = {};

  // component data: row 0 = (kx, ky, wind-sea amp, ω), row 1 = (phase, ripple amp at the reference wind, ripple phase, 0)
  const compData = new Float32Array(K * 2 * 4);
  const compTex = new THREE.DataTexture(compData, K, 2, THREE.RGBAFormat, THREE.FloatType);
  compTex.minFilter = THREE.NearestFilter;
  compTex.magFilter = THREE.NearestFilter;
  compTex.needsUpdate = true;

  const uSun = uniform(new THREE.Vector3(0, 0, 1)); // toward the sun
  const uDepthPx = uniform(100);
  // minX, minY, spanX, spanY (world px) the caustic slices cover — origin snapped to whole texels (see `update`)
  const uView = uniform(new THREE.Vector4(0, 0, 1280, 720));
  // minX, minY, spanX, spanY (world px) of the photon grid — origin snapped to whole cells (see `update`)
  const uGrid = uniform(new THREE.Vector4(0, 0, 1280, 720));
  const uSeaMs = uniform(7); // the wind sea's wind (the scene's, smoothed), m/s
  const uMaxMs = uniform(metresPerSecondForSpeed01 ? metresPerSecondForSpeed01(1) : 70); // the dial's top, m/s
  const uContrast = uniform(1); // caustic contrast round flat water's light (see `causticAt`)
  // shaft tuning (defaults are the shipped look; `tune()` overrides them live): blur level, brightness, shading
  const uShaftSoftM = uniform(WAVE_SHAFT_SOFT_M); // width of the shaft glow's blur, metres
  const uShaftGain = uniform(1);
  const uMaskTime = uniform(0); // slow evolution of the patches, noise units
  const uRunAlign = uniform(0); // slice alignment along the sun run (1 = physical; tuning/proof only)
  const uShaftShade = uniform(1);
  const uLocalWind = uniform(1); // 0 = ignore local gusts (uniform sea), 1 = real
  const uSlopeGain = uniform(1);
  const uHsPx = uniform(1);
  const uGlintRough = uniform(0.15);
  const uFieldOk = uniform(0); // 1 once a wind strength texture exists
  const uPxPerM = uniform(pxPerM);
  const uSceneFlow = uniform(new THREE.Vector2(0, 0)); // the scene's wind as a flow vector, dial units (world px axes)
  const uSceneDir = uniform(new THREE.Vector2(1, 0)); // its unit bearing (toward)
  const uCurrentPx = uniform(new THREE.Vector2(0, 0)); // the water's own current, world px/s (the fallback, global)
  const uFlowRect = uniform(new THREE.Vector4(0, 0, 1, 1)); // the solved flow field's world rect
  const uFlowOk = uniform(0); // 1 once a flow field is bound
  const uFlowSpeedPx = uniform(70); // world px/s a normalised flow of 1 stands for
  const flowTexNodes = [];
  const uFlowT = uniform(0); // flow-map cycles elapsed (sim clock); phase A = fract(t), phase B = fract(t + ½)
  const uDriftDt = uniform(0); // sim seconds this frame (0 while paused)
  const uDriftReset = uniform(new THREE.Vector2(0, 0)); // 1 = that phase restarts its drift this frame
  const uCrestLean = uniform(WAVE_CREST_LEAN);
  const uCrestSharp = uniform(WAVE_CREST_SHARP);
  const uDebugView = uniform(0); // lab instrument the water draws instead of itself (1 drift grid, 2 shear, 3 normals; `tune({debugView})`)
  const uWindTravelPx = uniform(0); // the wind's share of the pattern's travel in still water, world px/s (CPU, per frame)
  const uBinWindyS = uniform(WAVE_RIPPLE_BIN_S_WINDY);
  const uSliceLod = uniform(WAVE_CAUSTIC_LOD);
  const uSplatMax = uniform(WAVE_SPLAT_MAX);

  // ── bake: one band = its own index range of the (sorted) set, its own amplitude row ──
  const uSeaEnd = uniform(K, 'int');
  const uRippleStart = uniform(0, 'int');
  const setRanges = () => {
    const r = waveBandRanges(set);
    uSeaEnd.value = r.seaEnd;
    uRippleStart.value = r.rippleStart;
  };
  setRanges();
  const bandAt = (p, band) => {
    const h = float(0).toVar();
    const sx = float(0).toVar();
    const sy = float(0).toVar();
    const lap = float(0).toVar();
    const range = band === 1 ? { start: uRippleStart, end: int(K) } : { start: int(0), end: uSeaEnd };
    Loop({ ...range, type: 'int', condition: '<' }, ({ i }) => {
      const c = textureLoad(compTex, ivec2(i, int(0)));
      const e = textureLoad(compTex, ivec2(i, int(1)));
      const ph = c.x
        .mul(p.x)
        .add(c.y.mul(p.y))
        .add(band === 1 ? e.z : e.x);
      const cs = cos(ph);
      const sn = sin(ph);
      const a = band === 1 ? e.y : c.z;
      h.addAssign(a.mul(cs));
      sx.addAssign(a.mul(c.x).mul(sn).negate());
      sy.addAssign(a.mul(c.y).mul(sn).negate());
      lap.addAssign(
        a
          .mul(c.x.mul(c.x).add(c.y.mul(c.y)))
          .mul(cs)
          .negate()
      );
    });
    return vec4(h, sx, sy, lap);
  };
  const makeRT = (w, h, wrap, mips = false, format = THREE.RGBAFormat) => {
    const t = new THREE.RenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format,
      depthBuffer: false,
      generateMipmaps: mips,
    });
    t.texture.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    t.texture.magFilter = THREE.LinearFilter;
    t.texture.colorSpace = THREE.NoColorSpace;
    if (wrap) {
      t.texture.wrapS = THREE.RepeatWrapping;
      t.texture.wrapT = THREE.RepeatWrapping;
    }
    t.texture.generateMipmaps = mips;
    return t;
  };
  // ⚠️ RESOLUTION (2026-11-10, Ingram: "they look very low resolution"): the ripples are the finest thing drawn (down to
  // ~0.4 m = 40 px), and at 384² over the 1024 px tile one texel was 2.7 world px — magnified at a close zoom it smeared.
  // The ripple band now bakes at one texel per world px; the wind sea (waves of metres) stays coarse, it is smooth.
  const bandRT = [makeRT(WAVE_BAKE_RES, WAVE_BAKE_RES, true), makeRT(WAVE_RIPPLE_BAKE_RES, WAVE_RIPPLE_BAKE_RES, true)];
  const bandQuad = [0, 1].map((b) => {
    const m = new THREE.NodeMaterial();
    m.fragmentNode = Fn(() => bandAt(uv().mul(float(WAVE_TILE_PX)), b))();
    return new THREE.QuadMesh(m);
  });

  // ── THE LOCAL WIND, in real m/s (2026-11-10, Ingram: "It's time to properly connect the wind texture to this") ──
  // The texture's G is the wind field's own speed here (gusts, lulls, walls, building lee, the 3-D air) in dial units;
  // × the dial's top = m/s. The first cut read strength ÷ the scene dial's strength — a ratio that divided by ~0 at a
  // calm dial. Now the ripples answer the air overhead directly (`waveRippleGain`, Cox & Munk + the capillary onset:
  // cat's paws in a breeze, glass in the lee), and the wind sea — built over the whole fetch — only leans on it.
  const placeholderWind = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  placeholderWind.needsUpdate = true;
  const windTexNodes = [];
  const uWindRect = uniform(new THREE.Vector4(0, 0, 1, 1));
  const localGains = (p) => {
    const span = vec2(max(uWindRect.z.sub(uWindRect.x), float(1)), max(uWindRect.w.sub(uWindRect.y), float(1)));
    const wuv = clamp(p.sub(vec2(uWindRect.x, uWindRect.y)).div(span), float(0.001), float(0.999));
    const node = texture(placeholderWind, wuv);
    windTexNodes.push(node);
    const uTex = node.g.mul(uMaxMs);
    // Wind ripple dial: 0 = the whole water feels the scene's wind, 1 = the real local air, >1 exaggerates it
    const U = max(uSeaMs.add(uTex.sub(uSeaMs).mul(uLocalWind.mul(uFieldOk))), float(0));
    const ripOnset = smoothstep(float(0.5), float(2.5), U);
    const gRip = ripOnset.mul(pow(min(U, float(30)).div(float(WAVE_REFERENCE_WIND_MS)), float(0.5)));
    // the wind sea leans on the local air only gently (shelter calms it a little), and not at all near a calm
    const lean = clamp(pow(U.div(max(uSeaMs, float(0.5))), float(0.5)), float(0.4), float(1.25));
    const gSea = mix(float(1), lean, smoothstep(float(1), float(3), uSeaMs));
    // THE LOCAL BEARING (B, A: the wind field's own flow vector here, dial units, world px axes): the lee's eddies, the
    // funnels between buildings, a gust's swing. A whisker of the scene's bearing keeps it defined in dead air.
    const dir = normalize(mix(uSceneFlow, node.ba, min(uLocalWind.mul(uFieldOk), float(1))).add(uSceneDir.mul(0.004)));
    return { gSea, gRip, U, dir };
  };

  // ── THE DRIFT FIELD (flow map): per texel of the wind texture's rect, each of two phases integrates the surface drift
  // (WAVE_DRIFT_SHARE × the local wind, + the current) on the sim clock for one cycle, then restarts while its weight is
  // 0. Integrated per texel, not v·t: a gust that rises mid-cycle does not throw the pattern back. Ping-pong, 256².
  const driftRT = [0, 1].map(() => makeRT(WAVE_DRIFT_RES, WAVE_DRIFT_RES, false));
  let driftRead = 0;
  const driftPrevNode = texture(driftRT[1].texture, uv());
  const driftPassWind = texture(placeholderWind, uv());
  windTexNodes.push(driftPassWind);
  const driftQuad = (() => {
    const m = new THREE.NodeMaterial();
    m.fragmentNode = Fn(() => {
      const local = mix(uSceneFlow, driftPassWind.ba, min(uLocalWind.mul(uFieldOk), float(1)));
      // THE LOCAL CURRENT (2026-11-10, Lab · River): the solved flow field at this texel (`water-flow-potential.js`) -
      // the river's own bends, the rapids' squeeze, the stillness of a closed pond - times the author's flow speed.
      // Without a flow field yet (or a floor with none) it falls back to the one global current.
      const wp = vec2(uWindRect.x, uWindRect.y).add(
        uv().mul(vec2(uWindRect.z.sub(uWindRect.x), uWindRect.w.sub(uWindRect.y)))
      );
      const fspan = vec2(max(uFlowRect.z.sub(uFlowRect.x), float(1)), max(uFlowRect.w.sub(uFlowRect.y), float(1)));
      // blurred over a 3x3 of taps `WAVE_DRIFT_BLUR_TEXELS` drift texels apart (see `WAVE_DRIFT_BLUR_TEXELS`)
      const texelW = vec2(uWindRect.z.sub(uWindRect.x), uWindRect.w.sub(uWindRect.y))
        .div(float(WAVE_DRIFT_RES))
        .mul(float(WAVE_DRIFT_BLUR_TEXELS));
      // weighted by WATER (the pack's A is solidity): a tap inside a rock or the bank holds no current and must not pull
      // the water beside it toward a standstill — that seam was the last ring of shear round every rock
      let flowSum = vec2(0, 0);
      let wSum = float(0);
      for (const oy of [-1, 0, 1]) {
        for (const ox of [-1, 0, 1]) {
          const w = ((ox === 0 ? 2 : 1) * (oy === 0 ? 2 : 1)) / 16;
          const tuv = clamp(
            wp.add(vec2(ox, oy).mul(texelW)).sub(vec2(uFlowRect.x, uFlowRect.y)).div(fspan),
            vec2(0.001, 0.001),
            vec2(0.999, 0.999)
          );
          const fn = texture(placeholderWind, tuv);
          flowTexNodes.push(fn);
          const ww = float(w).mul(float(1).sub(clamp(fn.w, float(0), float(1))));
          flowSum = flowSum.add(vec2(fn.x, fn.y).mul(ww));
          wSum = wSum.add(ww);
        }
      }
      const rawCurrent = mix(uCurrentPx, flowSum.div(max(wSum, float(1e-3))).mul(uFlowSpeedPx), uFlowOk);
      // soft speed cap: s / sqrt(1 + (s/cap)^2)
      const rawLen = length(rawCurrent);
      const currentHere = rawCurrent.div(sqrt(float(1).add(rawLen.div(float(WAVE_DRIFT_SPEED_CAP_PX)).pow(2))));
      // the wind's travel (`WAVE_WIND_TRAVEL_SHARE`, twin: `wavePatternVelocity`): downwind along the local air, scaled by
      // its gusts and shelter against the scene's wind, and shrunk where the water itself runs
      const localLen = length(local);
      const ratio = clamp(localLen.div(max(length(uSceneFlow), float(0.02))), float(0), float(2));
      const curN = length(currentHere).div(max(uFlowSpeedPx, float(1e-3)));
      const flowing = smoothstep(float(WAVE_FLOWING_LO), float(WAVE_FLOWING_HI), curN);
      const still = uWindTravelPx.mul(ratio);
      const windPx = mix(still, min(still, length(currentHere).mul(float(WAVE_WIND_IN_FLOW_RATIO))), flowing);
      const v = local
        .div(max(localLen, float(1e-4)))
        .mul(windPx)
        .add(currentHere);
      const prev = driftPrevNode;
      const keep = vec4(
        float(1).sub(uDriftReset.x),
        float(1).sub(uDriftReset.x),
        float(1).sub(uDriftReset.y),
        float(1).sub(uDriftReset.y)
      );
      return prev.mul(keep).add(vec4(v.x, v.y, v.x, v.y).mul(uDriftDt));
    })();
    return new THREE.QuadMesh(m);
  })();
  const driftReadNodes = [];
  /** vec4(phase A offset, phase B offset), world px: how far the surface has drifted here since each phase restarted. */
  const driftAt = (p) => {
    const span = vec2(max(uWindRect.z.sub(uWindRect.x), float(1)), max(uWindRect.w.sub(uWindRect.y), float(1)));
    const wuv = clamp(p.sub(vec2(uWindRect.x, uWindRect.y)).div(span), float(0.001), float(0.999));
    const n = texture(driftRT[0].texture, wuv);
    driftReadNodes.push(n);
    return n;
  };

  /**
   * One read of the canonical ripple bake turned to bearing `alpha` (its waves then run toward alpha) at `scale`,
   * shifted by `shift` in the bake plane: vec4(h, ∂h/∂x, ∂h/∂y, curvature) in world axes.
   */
  const rippleRead = (p, alpha, scale, shift) => {
    const ca = cos(alpha);
    const sa = sin(alpha);
    // q = s·R(−α)·p + shift: a bake wave toward +x shows in the world toward α
    const q = vec2(p.x.mul(ca).add(p.y.mul(sa)), p.y.mul(ca).sub(p.x.mul(sa)))
      .mul(scale)
      .add(shift);
    const t = texture(bandRT[1].texture, q.div(float(WAVE_TILE_PX)));
    // ∂h/∂p = s·R(α)·∂h/∂q; curvature × s²
    const hx = t.y.mul(scale);
    const hy = t.z.mul(scale);
    return vec4(t.x, hx.mul(ca).sub(hy.mul(sa)), hx.mul(sa).add(hy.mul(ca)), t.w.mul(scale).mul(scale));
  };
  const BIN = (2 * Math.PI) / WAVE_RIPPLE_BINS;
  /**
   * The ripples for a wind bearing (radians, world): the three fixed bearings nearest it, each weighted by how far it
   * lies off the wind (cos^2s(Δ/2), `sBins` narrowing with the wind's strength) and windowed to 0 at ±1.5 bins so the
   * triple can change hands seamlessly. Summed at Σw² = 1: the ripples' height variance holds however many bearings mix.
   * Each bearing has its own scale (2^(−k/24), all different) and offset, so no two ever share a period.
   */
  const ripplesAt = (p, ang, sBins, shift) => {
    const c = floor(ang.sub(WAVE_RIPPLE_ROT).div(BIN).add(0.5));
    let acc = vec4(0, 0, 0, 0);
    let w2 = float(0);
    for (const j of [-1, 0, 1]) {
      const b = c.add(j);
      const alpha = b.mul(BIN).add(WAVE_RIPPLE_ROT);
      const d = abs(ang.sub(alpha));
      const w = pow(cos(d.mul(0.5)), sBins.mul(2)).mul(smoothstep(float(BIN * 1.5), float(BIN * 1.0), d));
      const bm = mod(b.add(WAVE_RIPPLE_BINS * 100), WAVE_RIPPLE_BINS); // 0..7, the same bearing every turn round
      const scale = pow(float(2), mod(bm.mul(3), WAVE_RIPPLE_BINS).negate().div(24));
      acc = acc.add(rippleRead(p, alpha, scale, shift.add(vec2(bm.mul(173.13), bm.mul(-91.71)))).mul(w));
      w2 = w2.add(w.mul(w));
    }
    return acc.div(sqrt(max(w2, float(1e-6))));
  };

  /**
   * THE surface at a world point: vec4(height px, slope x, slope y, curvature /px), local wind applied.
   *
   * ⚠️ NO VISIBLE TILE (2026-11-10, Ingram: "it looks like a pattern not water seen from above"). Both bands repeat on
   * the same 1024 px tile, so the sum repeated every ~10 m. The ripple band is read on a ROTATED copy of the plane
   * (`WAVE_RIPPLE_ROT`, an angle whose tangent is irrational): the two bands' lattices never line up again, the sum
   * never repeats. Its slopes are turned back into world axes (`rippleRead`).
   */
  const surfaceAt = (p, driftShare = null) => {
    const g = localGains(p);
    // ⚠️ NO REPEAT AT LOW WIND (2026-11-10, Ingram: "when you lower wind strength you can clearly see an echoing
    // repeating pattern"). In a light air the ripples are all there is, and one read of their 1024 px tile repeats every
    // ~10 m. A second read of the same band at an irrational scale (`WAVE_RIPPLE_SCALE2`: its waves 1.26× longer, same
    // direction) never shares a period with the first; the two are summed at 1/√2 each, so the height variance holds.
    //
    // ⚠️ THE WIND SHAPES AND CARRIES THEM (2026-11-10, see `WAVE_RIPPLE_BINS`, `WAVE_DRIFT_SHARE`). The ripples are read
    // turned to the LOCAL wind's bearing (three fixed bearings blended, narrowing as the wind strengthens: long crests
    // in a steady wind, a criss-cross in light air), and carried by the surface drift — two flow-map phases, each a
    // DIFFERENT patch of the bake (not a shifted copy: a cross-fade of shifted copies is an echo), cross-faded as one
    // restarts. Their Σw² = 1 keeps the height variance through the fade. The second patch's offset and every bearing's
    // own scale replace the old second read at `WAVE_RIPPLE_SCALE2`: no two reads share a period.
    const ang = atan(g.dir.y, g.dir.x);
    const sBins = mix(
      float(WAVE_RIPPLE_BIN_S_CALM),
      uBinWindyS,
      smoothstep(float(1.5), float(WAVE_RIPPLE_BIN_WINDY_MS), g.U)
    );
    const dr = driftShare === null ? driftAt(p) : driftAt(p).mul(float(driftShare));
    const fa = fract(uFlowT);
    const fb = fract(uFlowT.add(0.5));
    const wA = float(1).sub(abs(float(1).sub(fa.mul(2))));
    const wB = float(1).sub(abs(float(1).sub(fb.mul(2))));
    const rA = ripplesAt(p.sub(dr.xy), ang, sBins, vec2(0, 0));
    const rB = ripplesAt(p.sub(dr.zw), ang, sBins, vec2(311.7, 529.3));
    const ripW = rA
      .mul(wA)
      .add(rB.mul(wB))
      .div(sqrt(max(wA.mul(wA).add(wB.mul(wB)), float(1e-4))));
    // THE WIND SEA RIDES THE SAME DRIFT (`WAVE_WIND_TRAVEL_SHARE`): two phases, phase B on a different patch of the
    // tile (a cross-fade of shifted copies of one patch would echo), Σw² = 1
    const seaA = texture(bandRT[0].texture, p.sub(dr.xy).div(float(WAVE_TILE_PX)));
    const seaB = texture(bandRT[0].texture, p.sub(dr.zw).add(vec2(437.3, 211.9)).div(float(WAVE_TILE_PX)));
    const sea = seaA
      .mul(wA)
      .add(seaB.mul(wB))
      .div(sqrt(max(wA.mul(wA).add(wB.mul(wB)), float(1e-4))));
    const s = sea.mul(g.gSea).add(ripW.mul(g.gRip));
    // WIND-SHAPED CRESTS (`WAVE_CREST_LEAN`, `WAVE_CREST_SHARP`): the face falling downwind steepens and the back eases;
    // slopes near a crest sharpen, near a trough flatten. Shading-only (the slopes, not the heights).
    const crest = smoothstep(float(2), float(WAVE_CREST_FULL_MS), g.U);
    const sl = vec2(s.y, s.z);
    const sw = dot(sl, g.dir);
    const sgn = sw.div(sqrt(sw.mul(sw).add(0.0004))); // soft sign: −1 on the downwind (falling) face
    const leanF = float(1).sub(sgn.mul(crest).mul(uCrestLean));
    const hRef = max(uHsPx.div(max(uSlopeGain, float(0.1))).mul(0.25), float(0.05));
    const sharpF = float(1).add(clamp(s.x.div(hRef), float(-1), float(1)).mul(crest).mul(uCrestSharp));
    const sl2 = sl.add(g.dir.mul(sw.mul(leanF).sub(sw))).mul(sharpF);
    return vec4(s.x, sl2.x, sl2.y, s.w).mul(vec4(1, uSlopeGain, uSlopeGain, uSlopeGain));
  };

  /**
   * world px → the caustic slices' texture uv (v = 0 at the slice's TOP row, world y grows down the texture).
   *
   * ⚠️ THE NORTH/SOUTH MIRROR (2026-11-10, Ingram: "it's broken in the vertical axis moving the camera north and
   * south, but it's fully working east / west"). This used to be `1 − …` in v and was used for BOTH the splat's vertex
   * position and the read. But the two do not share a convention: the splat camera (`top = 1`) rasterises y = 1 into
   * the target's TOP row, while a WebGPU read of v = 1 samples its BOTTOM row (WGSL `isFlipY()` is false — vendored
   * three, `setupUV`). Every slice was mirrored about the view's centre line: right east/west, but north/south the
   * caustics and shafts slid at twice the ground's speed and their two depths read as an echo. (WebGL flips render
   * target reads, which is why the WebGL shader lab looked right and Foundry did not.) Now the read is plain v and
   * the splat writes at 1 − v (`splatYOf`), which lands on the same row under both backends.
   */
  const uvW = (p) => vec2(p.x.sub(uView.x).div(uView.z), p.y.sub(uView.y).div(uView.w));

  // ── splat: photon grid over the view (+ margin) → one slice per depth ──
  // mipmapped: the shafts read a blurred level (see `shaftsAt`)
  // one channel (light only): half the memory of RGBA at 1.5× the resolution
  // ⚠️ ONE ATLAS, NOT FIVE TARGETS (2026-11-10): the water's main shader sat at exactly 16 sampled textures — WebGPU's
  // per-stage minimum — and the drift field made 17 (the pipeline failed and the water vanished). The slices now sit side
  // by side in one texture (x only: full-height viewports, so no backend y-flip can touch them), one binding for all five.
  const NSL = WAVE_SLICES_M.length;
  const caustAtlas = makeRT(WAVE_CAUSTIC_RES * NSL, WAVE_CAUSTIC_RES, false, true, THREE.RedFormat);
  const cellsY = Math.round(WAVE_SPLAT_CELLS * 0.6);
  const geo = new THREE.PlaneGeometry(1, 1, WAVE_SPLAT_CELLS, cellsY);
  const splat = new THREE.MeshBasicNodeMaterial();
  {
    // ⚠️ WORLD-LOCKED PHOTONS (2026-11-10, Ingram: "the panning of the camera causes things to move in a strange
    // fashion"). The grid used to be laid over the VIEW: on a pan every photon sampled the surface somewhere new, and
    // each caustic line — narrower than a cell — was re-drawn from different samples every frame and crawled. `uGrid`'s
    // origin now steps in whole cells (and the slices' in whole texels), so a pan only adds and drops rows at the edges.
    const g = uv();
    const pS = vec2(uGrid.x.add(g.x.mul(uGrid.z)), uGrid.y.add(g.y.mul(uGrid.w)));
    const wS = surfaceAt(pS, WAVE_CAUSTIC_DRIFT_SHARE);
    const nS = normalize(vec3(wS.y.negate(), wS.z.negate(), float(1)));
    const R = refract(uSun.negate(), nS, float(1 / WAVE_IOR));
    const q = pS.add(R.xy.mul(uDepthPx.div(max(R.z.negate(), float(0.05)))));
    const qUv = uvW(q);
    splat.positionNode = vec3(qUv.x, float(1).sub(qUv.y), float(0)); // see `uvW`: y = 1 − v is v's row
    const vP = varying(pS);
    const vQ = varying(q);
    const area = (v) =>
      abs(
        dFdx(v)
          .x.mul(dFdy(v).y)
          .sub(dFdx(v).y.mul(dFdy(v).x))
      );
    const inten = clamp(area(vP).div(max(area(vQ), float(1e-6))), float(0), uSplatMax);
    splat.colorNode = vec4(inten, inten, inten, float(1));
  }
  // src + dst, NOT `AdditiveBlending` (SrcAlpha·src): the slices are one-channel and a factor reading alpha from a
  // target with none fails the pipeline (the caustics went dark, 2026-11-10)
  splat.blending = THREE.CustomBlending;
  splat.blendEquation = THREE.AddEquation;
  splat.blendSrc = THREE.OneFactor;
  splat.blendDst = THREE.OneFactor;
  splat.blendSrcAlpha = THREE.OneFactor;
  splat.blendDstAlpha = THREE.OneFactor;
  splat.transparent = true;
  splat.depthTest = false;
  splat.depthWrite = false;
  splat.side = THREE.DoubleSide;
  const splatMesh = new THREE.Mesh(geo, splat);
  splatMesh.frustumCulled = false;
  const splatScene = new THREE.Scene();
  splatScene.add(splatMesh);
  const splatCam = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);

  const lds = WAVE_SLICES_M.map((d) => Math.log(d));
  // ⚠️ DEEP CAUSTICS BLUR (2026-11-10, Docklands at a breeze: the deep slices read as white/black blotches — std 2.2,
  // spikes of 160 — and the water went milky). A deep bed sees each line through more water: the sun's disc, forward
  // scattering and the photon grid's own spacing all widen it. Each slice is read at a mip level growing with its depth
  // (mips keep the mean, so the energy stays put), so deep water shows soft pools of light and shade, shallow water
  // the sharp net.
  const sliceLod = () => uSliceLod;
  // slice i's uv in the atlas; `edge` keeps a blurred read from reaching across into its neighbour
  const atlasUv = (i, p, edge) => {
    const u = clamp(uvW(p), float(edge), float(1 - edge));
    return vec2(u.x.add(i).div(NSL), u.y);
  };
  const sliceTex = (i, p) => texture(caustAtlas.texture, atlasUv(i, p, 0.0005)).level(sliceLod(i)).r;
  /**
   * A slice blurred to ~2^lod texels — for the shafts, which are diffuse light in the column, not sharp lines.
   *
   * ⚠️ SMOOTH, NOT SQUARES (2026-11-10, Docklands: the harbour read as soft teal BLOCKS 20–40 px wide). One bilinear
   * read of mip 4 magnifies a 96-texel-wide image across the view, and bilinear shows its grid as soft squares. The
   * level is read with a cubic B-spline (four bilinear taps, the standard trick): the same blur, C² smooth.
   */
  const sliceSoft = (i, p, lod) => {
    const L = typeof lod === 'number' ? lod : WAVE_SHAFT_LOD;
    const size = WAVE_CAUSTIC_RES / 2 ** L; // the slice's width in texels at this level
    const u = clamp(uvW(p), float((2 ** L + 1) / WAVE_CAUSTIC_RES), float(1 - (2 ** L + 1) / WAVE_CAUSTIC_RES));
    const tc = u.mul(size).sub(0.5);
    const f = fract(tc);
    const b = tc.sub(f);
    const g = float(1).sub(f);
    const w0 = g.mul(g).mul(g).div(6);
    const w1 = float(2 / 3).sub(f.mul(f).mul(float(2).sub(f)).mul(0.5));
    const w2 = float(2 / 3).sub(g.mul(g).mul(float(1).add(f)).mul(0.5));
    const w3 = f.mul(f).mul(f).div(6);
    const s0 = w0.add(w1);
    const s1 = w2.add(w3);
    const t0 = b.sub(1).add(w1.div(s0)).add(0.5).div(size);
    const t1 = b.add(1).add(w3.div(s1)).add(0.5).div(size);
    const at = (x, y) => texture(caustAtlas.texture, vec2(x.add(i).div(NSL), y)).level(float(L)).r;
    return at(t0.x, t0.y)
      .mul(s0.x.mul(s0.y))
      .add(at(t1.x, t0.y).mul(s1.x.mul(s0.y)))
      .add(at(t0.x, t1.y).mul(s0.x.mul(s1.y)))
      .add(at(t1.x, t1.y).mul(s1.x.mul(s1.y)));
  };
  /** Caustic intensity at a bed point and depth (1 = flat water's own light; >1 focused, <1 spread). */
  /**
   * ⚠️ DOUBLE LINES AT A LOW SUN (2026-11-10, Ingram: "you should see echos"). The net at depth z is the surface's
   * focus carried down-sun by the refracted ray, z·tan θ (`sunRunPx` per metre). Blending two neighbouring slices at
   * a bed between them (0.9 m and 1.8 m) laid two copies of every line ~50 px apart. Each slice is now read shifted
   * BACK by its own run to the bed's depth (sampled at p − run·(z_i − depth)), so neighbouring slices line up on one
   * net and the blend only morphs the focus between them. MEASURED: it did not sharpen the net (gradient energy 4.45
   * vs 4.57 without), so `uRunAlign` defaults to 0; kept as a tuning hook.
   */
  const sunRunPx = () => {
    const Rs = refract(uSun.negate(), vec3(0, 0, 1), float(1 / WAVE_IOR));
    return Rs.xy
      .div(max(Rs.z.negate(), float(0.2)))
      .mul(uPxPerM)
      .mul(uRunAlign);
  };
  const causticRaw = (p, depthM, lod = null) => {
    const run = sunRunPx();
    const ld = log(max(depthM, float(0.05)));
    let acc = float(0);
    let wsum = float(0);
    for (let i = 0; i < lds.length; i++) {
      const lo = i > 0 ? lds[i - 1] : lds[i] - 3;
      const hi = i < lds.length - 1 ? lds[i + 1] : lds[i] + 3;
      const below = float(lds[i] - lo);
      const above = float(hi - lds[i]);
      // ⚠️ A NARROW CROSS-FADE (2026-11-10): each slice is a DIFFERENT net (the focus evolves with depth), so a linear
      // blend between two laid two nets over each other — a double, echoing web. Weights are sharpened so most of the
      // bed reads one slice and the change happens in a short band (measured sharpest in the Foundry lab).
      const wi = smoothstep(
        float(0.3),
        float(0.7),
        clamp(float(1).sub(abs(ld.sub(lds[i])).div(ld.lessThan(lds[i]).select(below, above))), float(0), float(1))
      );
      const pi = p.add(run.mul(float(WAVE_SLICES_M[i]).sub(depthM)));
      acc = acc.add((lod ? sliceSoft(i, pi, lod) : sliceTex(i, pi)).mul(wi));
      wsum = wsum.add(wi);
    }
    const c = acc.div(max(wsum, float(1e-4)));
    // beyond the deepest slice the many waves blur each other out: ease to the flat level by ~2× its depth
    const far = smoothstep(
      float(WAVE_SLICES_M[WAVE_SLICES_M.length - 1]),
      float(WAVE_SLICES_M[WAVE_SLICES_M.length - 1] * 2.2),
      depthM
    );
    return mix(c, float(1), far);
  };
  // ⚠️ SMOOTH EVERYWHERE (2026-11-10, Ingram: "smoother on the left and breaks into double lines on the right away from
  // the 'beach'. Smoother all around is better."). Past ~1 m the waves fold the light over itself and the net breaks into
  // doubled lines. The bed reads its caustic at a depth capped at `WAVE_CAUSTIC_DEPTH_CAP_M` (eased in, so the shallows
  // are unchanged): deep water shows the same clean net as the beach, while depth still reads through absorption.
  const causticDepth = (d) =>
    min(
      d,
      float(WAVE_CAUSTIC_DEPTH_CAP_M)
        .mul(float(1).sub(exp(d.negate().div(float(WAVE_CAUSTIC_DEPTH_CAP_M)))))
        .add(d.mul(0.02))
    );
  const causticAt = (p, depthM) => contrastOf(causticRaw(p, causticDepth(depthM)));
  /**
   * THE CAUSTICS' STRENGTH ACROSS THE WATER (2026-11-10, Ingram: "there isn't an even strength of caustics across the
   * entire body of water ... a low frequency noise that moves across the map with wind speed and direction ... and
   * also by lowering the amount of caustics over the entire screen"). 0..1: soft patches tens of metres wide, carried
   * with the surface's own drift (the local current and the wind), floored so no water
   * goes fully dead, and capped below 1 (the overall reduction). Multiplies the bed's caustic deviation and the shafts.
   */
  const causticMaskAt = (p) => {
    // (2026-11-10) carried by the surface's own drift - the local current and the wind - not by the wind alone. Two
    // phases of the same field shifted a little: a plain linear blend (a variance-preserving one would make it breathe).
    const dr = driftAt(p);
    const wA = float(1).sub(abs(float(1).sub(fract(uFlowT).mul(2))));
    const at = (o) => {
      const q = p.sub(o).div(float(WAVE_CAUSTIC_MASK_SCALE_M).mul(uPxPerM));
      return mx_fractal_noise_float(vec3(q.x, q.y, uMaskTime), 2, 2.0, 0.5);
    };
    const n = at(dr.xy)
      .mul(wA)
      .add(at(dr.zw).mul(float(1).sub(wA)));
    return mix(float(WAVE_CAUSTIC_MASK_FLOOR), float(WAVE_CAUSTIC_MASK_PEAK), smoothstep(float(-0.25), float(0.35), n));
  };
  /**
   * CONTRAST ROUND THE MEAN (2026-11-10, Ingram: "the goal is to create contrast by having some caustic regions get
   * darker even in full light so that caustics and shafts can stand out"). A gain on the deviation from flat water's
   * light (1): the mean — the light the bed gets — is kept, the spread cells fall dark and the lines brighten. The
   * physical net is low-contrast in shallow water (the waves' focus lies deeper), so it reads as a faint shimmer; this
   * is the look's lever, as a painter would push it. Never below `WAVE_CAUSTIC_FLOOR` (no pitch-black holes).
   */
  const contrastOf = (c) => max(float(1).add(c.sub(1).mul(uContrast)), float(WAVE_CAUSTIC_FLOOR));
  /**
   * THE LIGHT IN THE COLUMN above a bed point, seen from straight above: one soft read of the caustic field at the
   * column's middle depth. Returns `light` (vec3: the focused excess, filtered in and out by `sigma` per metre and ×
   * the column's length, × the sun's colour later) and `deviation` (signed: + focused, − spread; the water's own
   * in-scatter is multiplied by 1 + this, so the column has dark lanes as well as bright ones, the mean kept).
   *
   * ⚠️ ONE TAP, NOT A MARCH (2026-11-10, Ingram: "show a huge number of echos so it looks like a pattern"). The net at
   * depth z is the surface's focus shifted down-sun by z·tan θ — at a low sun ~0.8 m per metre of depth. Any sum of
   * discrete depths (the old march: 5 slices × 4 steps) is a stack of SHIFTED COPIES of the net, ~70–140 px apart in
   * deep water, far wider than any blur can merge: the echoes. One read at mid-depth is one copy: it sits offset from
   * the bed's own net by half the run — the parallax between the glow in the water and the light on the bed, which
   * reads as depth instead of as a repeat.
   */
  const shaftsAt = (p, depthM, sigma) => {
    const Rs = refract(uSun.negate(), vec3(0, 0, 1), float(1 / WAVE_IOR));
    const cosT = max(Rs.z.negate(), float(0.2));
    const zMid = clamp(depthM.mul(0.5), float(WAVE_SLICES_M[0]), float(WAVE_SLICES_M[WAVE_SLICES_M.length - 2]));
    // ⚠️ THE SAME READ AS THE BED (2026-11-10, Ingram: "when I pan vertically ... the white lines, very very strong").
    // The first one-tap version read the slices through its own mip path and, panning vertically, lagged the world by
    // ~2 frames (20 px at 10 px/frame; the bed's own read, measured the same way, did not). It is now `causticRaw` —
    // the very read the bed uses, proven world-locked — at the column's mid-depth, softened by a 5-tap cross a
    // fraction of a metre wide, so the glow is pools of light, not a second net of lines.
    // ONE soft read (a mip of the slices) at mid-depth, slice runs aligned like the bed's (`causticRaw`)
    const c = causticRaw(p, zMid, float(WAVE_SHAFT_LOD));
    const d = c.sub(1).mul(uContrast);
    const att = exp(sigma.negate().mul(zMid).mul(float(1).div(cosT).add(1)));
    const column = min(depthM, float(3)); // metres of lit water under the eye
    const light = att.mul(d.max(0)).mul(column);
    return {
      light: light.mul(uShaftGain),
      deviation: d
        .mul(att.y)
        .mul(smoothstep(float(0.1), float(0.6), depthM))
        .mul(uShaftShade),
    };
  };

  function setWindTexture(field) {
    const tex = field?.texture ?? null;
    uFieldOk.value = tex ? 1 : 0;
    const t = tex ?? placeholderWind;
    for (const n of windTexNodes) if (n.value !== t) n.value = t;
    if (field?.uRect?.value) uWindRect.value.copy(field.uRect.value);
    // the drift field lives on the wind texture's rect: a regrid (or the texture arriving) restarts both phases once
    const key =
      uWindRect.value
        .toArray()
        .map((x) => Math.round(x))
        .join(',') + (tex ? '' : '~');
    if (key !== driftRectKey) {
      driftRectKey = key;
      uDriftReset.value.set(1, 1);
    }
  }

  /**
   * Per frame, CPU side.
   * @param {object} o
   * @param {number} o.dtSec - sim seconds since last frame (0 while paused: the sea stops).
   * @param {number} o.wind01 - the scene's wind dial.
   * @param {number} o.windDeg - bearing the wind blows TOWARD (world/wind-bake.js#windFlowVector).
   * @param {number} o.fetchM
   * @param {number} [o.pxPerM]
   * @param {number[]} o.sunDir - unit, toward the sun ([x, y, up]).
   * @param {{minX:number,minY:number,maxX:number,maxY:number}} o.viewRect
   * @param {number[]} [o.flowPx] - the current, world px/s (the sea rides it).
   * @param {number} [o.timeScale] - 1 = real wave speed.
   * @param {number} [o.slopeGain] - 1 = the measured sea.
   * @param {number} [o.localWind] - 0..1, how much local gusts and shelter shape the sea.
   */
  function update(o) {
    updates++;
    if (Number.isFinite(o.pxPerM) && o.pxPerM > 1 && Math.abs(o.pxPerM - pxPerM) > 1e-3) {
      pxPerM = o.pxPerM;
      set = buildWaveSet({ seed, pxPerM });
      for (let i = 0; i < K; i++) phase[i] = phaseR[i] = set[i].ph;
      setRanges();
      seaKey = '';
    }
    const dt = Math.max(0, Math.min(0.25, o.dtSec || 0));
    // the scene's wind as real m/s (0 = calm: glass), and the wind sea easing toward it like a real sea builds/decays
    const targetMs = waveWindMetresPerSecond(o.wind01, metresPerSecondForSpeed01);
    if (seaMs === null) seaMs = targetMs;
    else seaMs += (targetMs - seaMs) * (1 - Math.exp(-dt / WAVE_SEA_RESPONSE_SEC));
    if (Math.abs(seaMs - targetMs) < 0.01) seaMs = targetMs;
    const wr = ((o.windDeg || 0) * Math.PI) / 180;
    const towardRad = Math.atan2(-Math.cos(wr), Math.sin(wr));
    const key = `${seaMs.toFixed(2)}|${towardRad.toFixed(3)}|${Math.round(o.fetchM || 0)}`;
    if (key !== seaKey) {
      sea = waveAmplitudes(set, {
        windMs: seaMs,
        towardRad,
        fetchM: o.fetchM || 50,
        pxPerM,
        rippleRot: WAVE_RIPPLE_ROT,
      });
      seaKey = key;
    }
    const ts = Number.isFinite(o.timeScale) ? o.timeScale : 1;
    // the fallback current (no solved flow field yet): carried by the drift like the local one, never a phase Doppler
    const fx = o.flowPx?.[0] ?? 0;
    const fy = o.flowPx?.[1] ?? 0;
    for (let i = 0; i < K; i++) {
      const c = set[i];
      // BOIL, NOT MARCH (`WAVE_WIND_TRAVEL_SHARE`): alternate components run forward and backward, so the surface evolves
      // in place; the drift field carries it (current + wind)
      const sgn = waveBoilSign(i);
      phase[i] -= sea.omegas[i] * ts * sgn * dt;
      phase[i] -= Math.floor(phase[i] / (2 * Math.PI)) * 2 * Math.PI;
      phaseR[i] -= sea.omegas[i] * ts * sgn * dt;
      phaseR[i] -= Math.floor(phaseR[i] / (2 * Math.PI)) * 2 * Math.PI;
      compData[i * 4] = c.kx;
      compData[i * 4 + 1] = c.ky;
      compData[i * 4 + 2] = sea.ampsSea[i];
      compData[i * 4 + 3] = sea.omegas[i];
      compData[(K + i) * 4] = phase[i];
      compData[(K + i) * 4 + 2] = phaseR[i];
      compData[(K + i) * 4 + 1] = sea.ampsRipple[i];
    }
    compTex.needsUpdate = true;
    const s = o.sunDir ?? [0, 0, 1];
    uSun.value.set(s[0], s[1], Math.max(0.02, s[2]));
    uSun.value.normalize();
    const v = o.viewRect;
    if (v) {
      const g = waveViewLayout(v);
      uView.value.set(g.view[0], g.view[1], g.view[2], g.view[3]);
      uGrid.value.set(g.grid[0], g.grid[1], g.grid[2], g.grid[3]);
    }
    uPxPerM.value = pxPerM;
    uSeaMs.value = seaMs;
    // the scene's wind as a flow vector (dial units: what the wind texture's B, A hold) — where there is no texture
    const sceneSpeed01 = Math.max(0, o.wind01 || 0);
    uSceneDir.value.set(Math.cos(towardRad), Math.sin(towardRad));
    uSceneFlow.value.set(Math.cos(towardRad) * sceneSpeed01, Math.sin(towardRad) * sceneSpeed01);
    uCurrentPx.value.set(fx, fy);
    // the flow map's clock: each phase restarts its drift as its weight passes through 0
    const t0 = flowT;
    flowT += dt / WAVE_FLOW_CYCLE_SEC;
    const wrapped = (a, b) => Math.floor(b) > Math.floor(a);
    uDriftReset.value.set(wrapped(t0, flowT) ? 1 : 0, wrapped(t0 + 0.5, flowT + 0.5) ? 1 : 0);
    if (updates === 1) uDriftReset.value.set(1, 1); // the targets start undefined
    if (flowT > 1e4) flowT -= 1e4; // keep fract() precise in float32 (an integer step: no phase change)
    uFlowT.value = flowT;
    uDriftDt.value = dt;
    // the caustic patches ride the same drift as the surface (`causticMaskAt`) and slowly change shape
    uMaskTime.value += dt * 0.03;
    // the wind's travel in still water: a share of the wind sea's peak phase speed (0 at a calm)
    const cPeak =
      sea.peakPeriodSec > 0 && Number.isFinite(sea.peakWavelengthM / sea.peakPeriodSec)
        ? sea.peakWavelengthM / sea.peakPeriodSec
        : 0;
    const travelShare = Number.isFinite(tune.windTravel) ? tune.windTravel : WAVE_WIND_TRAVEL_SHARE;
    uWindTravelPx.value = cPeak * pxPerM * travelShare * Math.min(1, seaMs / 0.5);
    if (metresPerSecondForSpeed01) uMaxMs.value = metresPerSecondForSpeed01(1);
    uLocalWind.value = Number.isFinite(o.localWind) ? o.localWind : 1;
    uSlopeGain.value = Number.isFinite(o.slopeGain) ? o.slopeGain : 1;
    uShaftSoftM.value = Number.isFinite(tune.shaftSoft) ? tune.shaftSoft : WAVE_SHAFT_SOFT_M;
    uShaftGain.value = Number.isFinite(tune.shaftGain) ? tune.shaftGain : 1;
    uRunAlign.value = Number.isFinite(tune.runAlign) ? tune.runAlign : 0;
    uShaftShade.value = Number.isFinite(tune.shaftShade) ? tune.shaftShade : 1;
    if (Number.isFinite(tune.slopeGain)) uSlopeGain.value = tune.slopeGain;
    uCrestLean.value = Number.isFinite(tune.crestLean) ? tune.crestLean : WAVE_CREST_LEAN;
    uCrestSharp.value = Number.isFinite(tune.crestSharp) ? tune.crestSharp : WAVE_CREST_SHARP;
    uBinWindyS.value = Number.isFinite(tune.binWindyS) ? tune.binWindyS : WAVE_RIPPLE_BIN_S_WINDY;
    uDebugView.value = Number.isFinite(tune.debugView) ? tune.debugView : 0;
    uSliceLod.value = Number.isFinite(tune.sliceLod) ? tune.sliceLod : WAVE_CAUSTIC_LOD;
    uSplatMax.value = Number.isFinite(tune.splatMax) ? tune.splatMax : WAVE_SPLAT_MAX;
    uContrast.value = Number.isFinite(tune.contrast)
      ? tune.contrast
      : Number.isFinite(o.contrast)
        ? Math.max(0, o.contrast)
        : WAVE_CAUSTIC_CONTRAST;
    uHsPx.value = Math.max(0.5, sea.hsPx * uSlopeGain.value);
    uGlintRough.value = Math.max(0.02, sea.glintRoughness);
    if (getWindStrengthField) setWindTexture(getWindStrengthField());
    // the solved flow: bound when it exists (a new floor or a rebake changes the texture: re-point every node together)
    const ff = getFlowField?.() ?? null;
    uFlowOk.value = ff?.texture ? 1 : 0;
    if (ff?.texture) {
      for (const n of flowTexNodes) if (n.value !== ff.texture) n.value = ff.texture;
      if (ff.rect) uFlowRect.value.set(ff.rect.minX, ff.rect.minY, ff.rect.maxX, ff.rect.maxY);
    }
    if (Number.isFinite(o.flowSpeedPx)) uFlowSpeedPx.value = o.flowSpeedPx;
  }

  let renders = 0;
  let updates = 0;
  const atlasView = uView.value.clone();
  /** Per frame, GPU side: bake both bands, then splat every slice. */
  function render(renderer) {
    renders++;
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    // the drift field first (the splat below reads the surface): read one, write the other, then point every reader
    // at the fresh one
    const write = 1 - driftRead;
    driftPrevNode.value = driftRT[driftRead].texture;
    renderer.setRenderTarget(driftRT[write]);
    driftQuad.render(renderer);
    driftRead = write;
    for (const n of driftReadNodes) n.value = driftRT[driftRead].texture;
    for (let b = 0; b < 2; b++) {
      renderer.setRenderTarget(bandRT[b]);
      bandQuad[b].render(renderer);
    }
    // the slices: one clear of the whole atlas, then each slice into its own full-height viewport; mips built once,
    // after the last
    // ⚠️ the GPU texture's mip count is fixed when it is first created from `generateMipmaps`: it must be on for the
    // first frame (off, the atlas was made with one level and every `.level()` read — the shafts' blur — fell to 0)
    // PERF (2026-11-11 sweep): the five 1536 px caustic slices are the dearest part of this pass and the caustics only
    // drift slowly, so with the view still the atlas refreshes every `atlasEvery`th frame (default 2) and the other
    // frames reuse it. A moving view (the atlas is laid out in view space) or the first frames always redraw.
    const every = Math.max(1, Math.round(Number.isFinite(tune.atlasEvery) ? tune.atlasEvery : WAVE_ATLAS_EVERY));
    const vk = uView.value;
    const still = atlasView.equals(vk);
    atlasView.copy(vk);
    if (renders > 2 && every > 1 && still && renders % every !== 0) {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAuto;
      return;
    }
    caustAtlas.viewport.set(0, 0, WAVE_CAUSTIC_RES * NSL, WAVE_CAUSTIC_RES);
    caustAtlas.texture.generateMipmaps = renders <= 1;
    renderer.setRenderTarget(caustAtlas);
    renderer.setClearColor?.(0x000000, 0);
    renderer.clear();
    for (let i = 0; i < NSL; i++) {
      uDepthPx.value = WAVE_SLICES_M[i] * pxPerM;
      caustAtlas.viewport.set(i * WAVE_CAUSTIC_RES, 0, WAVE_CAUSTIC_RES, WAVE_CAUSTIC_RES);
      caustAtlas.texture.generateMipmaps = i === NSL - 1 || renders <= 1;
      renderer.render(splatScene, splatCam);
    }
    caustAtlas.viewport.set(0, 0, WAVE_CAUSTIC_RES * NSL, WAVE_CAUSTIC_RES);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
  }

  function dispose() {
    for (const t of [...bandRT, caustAtlas, ...driftRT]) t.dispose();
    for (const q of bandQuad) q.material.dispose();
    driftQuad.material.dispose();
    splat.dispose();
    geo.dispose();
    compTex.dispose();
    placeholderWind.dispose();
  }

  return {
    update,
    render,
    dispose,
    /** Tuning overrides: `{contrast}`; `null` drops one. Returns what is set. */
    tune(o = {}) {
      for (const [k, v] of Object.entries(o)) {
        if (v === null) delete tune[k];
        else tune[k] = v;
      }
      return { ...tune };
    },
    /** Node builders for the water material (each call adds texture taps). */
    surfaceAt,
    /** Debug instruments (2026-11-10): the drift (vec4: phase A, phase B offsets, world px) and the flow-map clock. */
    driftAt,
    uFlowT,
    uDebugView,
    causticMaskAt,
    causticAt,
    shaftsAt,
    uHsPx,
    uGlintRough,
    uSun,
    /** For reports and tests. */
    info: () =>
      sea
        ? {
            windMs: +sea.U.toFixed(1),
            peakWavelengthM: +sea.peakWavelengthM.toFixed(2),
            peakPeriodSec: +sea.peakPeriodSec.toFixed(2),
            hsM: +sea.hsM.toFixed(3),
            drawnShare: +sea.drawnShare.toFixed(3),
            glintRoughness: +sea.glintRoughness.toFixed(3),
            pxPerM: +pxPerM.toFixed(2),
          }
        : null,
    /**
     * THE INSTRUMENT (2026-11-10): read every texture back and report its numbers — band heights/slopes, each caustic
     * slice's mean (1 = flat water), spread and peak — plus the inputs. `MapShine.readWaterWaves()`.
     */
    async readStats(renderer) {
      const stat = async (rt, ch = 0, x0 = 0, wIn = null) => {
        const w = wIn ?? rt.width;
        const h = rt.height;
        const px = await renderer.readRenderTargetPixelsAsync(rt, x0, 0, w, h);
        const f = px instanceof Uint16Array ? (i) => THREE.DataUtils.fromHalfFloat(px[i]) : (i) => px[i];
        let n = 0,
          sum = 0,
          sum2 = 0,
          mn = Infinity,
          mx = -Infinity;
        const nch = Math.max(1, Math.round(px.length / (w * h)));
        if (ch >= nch) return null;
        for (let i = ch; i < px.length; i += nch * 7) {
          const v = f(i);
          if (!Number.isFinite(v)) continue;
          n++;
          sum += v;
          sum2 += v * v;
          mn = Math.min(mn, v);
          mx = Math.max(mx, v);
        }
        const mean = sum / Math.max(1, n);
        return {
          mean: +mean.toFixed(4),
          std: +Math.sqrt(Math.max(0, sum2 / Math.max(1, n) - mean * mean)).toFixed(4),
          min: +mn.toFixed(4),
          max: +mx.toFixed(4),
        };
      };
      return {
        renders,
        updates,
        sea: sea ? { ...this.info() } : null,
        sun: uSun.value.toArray().map((x) => +x.toFixed(3)),
        view: uView.value.toArray().map((x) => Math.round(x)),
        windRect: uWindRect.value.toArray().map((x) => Math.round(x)),
        windFieldBound: uFieldOk.value,
        slopeGain: uSlopeGain.value,
        hsPx: +uHsPx.value.toFixed(2),
        bandSea: { height: await stat(bandRT[0], 0), slopeX: await stat(bandRT[0], 1) },
        bandRipple: { height: await stat(bandRT[1], 0), slopeX: await stat(bandRT[1], 1) },
        // world px each flow-map phase has drifted (x of A, x of B) — grows with the wind, restarts every cycle
        flowT: +uFlowT.value.toFixed(3),
        // the wind texture itself: G = speed (dial), B, A = the flow vector (dial units, world px axes)
        windTex: await (async () => {
          const rt = getWindStrengthField?.()?.rt;
          if (!rt || !rt.isRenderTarget) return null;
          return { speed: await stat(rt, 1), flowX: await stat(rt, 2), flowY: await stat(rt, 3) };
        })(),
        sceneFlow: uSceneFlow.value.toArray().map((x) => +x.toFixed(3)),
        currentPx: uCurrentPx.value.toArray().map((x) => +x.toFixed(1)),
        // lab probe: the drift (px since each phase restarted) at world points, `tune({driftPoints: [[x, y], ...]})`
        driftPoints: await (async () => {
          const pts = tune.driftPoints;
          if (!Array.isArray(pts) || !pts.length) return null;
          const rt = driftRT[driftRead];
          const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height);
          const f = px instanceof Uint16Array ? (i) => THREE.DataUtils.fromHalfFloat(px[i]) : (i) => px[i];
          const r = uWindRect.value;
          return pts.map(([x, y]) => {
            const tx = Math.min(rt.width - 1, Math.max(0, Math.floor(((x - r.x) / Math.max(1, r.z - r.x)) * rt.width)));
            const ty = Math.min(
              rt.height - 1,
              Math.max(0, Math.floor(((y - r.y) / Math.max(1, r.w - r.y)) * rt.height))
            );
            const o = (ty * rt.width + tx) * 4;
            return {
              x,
              y,
              ax: +f(o).toFixed(1),
              ay: +f(o + 1).toFixed(1),
              bx: +f(o + 2).toFixed(1),
              by: +f(o + 3).toFixed(1),
            };
          });
        })(),
        driftAx: await stat(driftRT[driftRead], 0),
        driftAy: await stat(driftRT[driftRead], 1),
        driftBx: await stat(driftRT[driftRead], 2),
        caustics: await Promise.all(
          WAVE_SLICES_M.map(async (d, i) => ({
            depthM: d,
            ...(await stat(caustAtlas, 0, i * WAVE_CAUSTIC_RES, WAVE_CAUSTIC_RES)),
          }))
        ),
      };
    },
    get textures() {
      return { bands: bandRT.map((t) => t.texture), caustics: caustAtlas.texture };
    },
  };
}
