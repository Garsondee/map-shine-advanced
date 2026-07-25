/**
 * THE ANIMATION CLOCK — GPU-side (2026-07-20 rewrite; the author's own
 * direction: "we're looking for WebGPU performance in this module, let's
 * not leave any CPU stuff in if we can avoid it"). Every animated light's
 * `time`/flicker-noise/pulse-wave used to be computed on the CPU every
 * frame (a JS function call + a `SmoothNoise` table lookup PER LIGHT PER
 * FRAME) and written into uniforms — this module now builds the SAME
 * formulas as TSL node graphs instead, computed on the GPU inside each
 * light's own shader. The CPU's remaining job shrinks to what's genuinely
 * unavoidable: reading Foundry's per-light animation config
 * (foundry/scene-lights.js) and the one real clock read
 * (core/frame-clock.js's `performance.now()` — nothing but JS can read a
 * wall clock) — both real, structural CPU work, not left in by omission.
 *
 * Foundry drives an animated light with four CPU functions
 * (docs/reference/foundry-v14-light-animations-audit.md §1.3); three are
 * pure per-frame math and have a GPU-node equivalent below. The fourth
 * (`animateSoundPulse`, reads `game.audio` band levels) genuinely CANNOT
 * move to the GPU — audio analysis is a CPU/JS API with no WebGPU
 * equivalent — so it stays deferred (registry.js's own `reactivepulse`
 * entry, `KNOWN_DEFERRED_ANIMATIONS`), exactly the "unavoidable CPU stuff
 * is fine" case.
 *
 * NOISE SUBSTITUTION (same reasoning as tsl-noise-toolkit.js's own
 * header): `buildFlickerNode` uses `mx_noise_float` (the exported Perlin
 * node — see its own inline note on why NOT `mx_perlin_noise_float`) in
 * place of Foundry's own CPU `SmoothNoise` table — porting `SmoothNoise` itself
 * into a GPU-sampled `uniformArray` was considered and rejected: it would
 * need a per-light lookup TABLE (`MAX_LIGHT_EDGES`-style fixed-capacity
 * uniform array, one per light) just to reproduce a value-noise algorithm
 * a single built-in GPU node already does more simply and without any new
 * per-light memory footprint. Same low-risk substitution already applied
 * throughout this animation set — Foundry's own animations are per-light
 * random-seeded, so bit-exact noise was never the parity target.
 *
 * @module effects/lighting/animations/light-animation-clock
 */

/**
 * Foundry's shared animation clock (`animateTime`), computed entirely
 * in-shader: `time = speed * reverseSign * globalTimeMs / 5000 + seed`.
 * `reverseSign` (+1/-1) is the one place a boolean Foundry field
 * (`animation.reverse`) gets turned into a GPU-friendly scalar — a single
 * CPU-side ternary at read time (foundry/scene-lights.js), about as
 * minimal as "unavoidable" gets, matching the author's own "unavoidable
 * CPU stuff is fine."
 *
 * @param {*} TSL
 * @param {object} args
 * @param {*} args.uSpeedRaw - per-light uniform, LightData.animation.speed (0..10).
 * @param {*} args.uReverseSign - per-light uniform, +1 or -1.
 * @param {*} args.uSeed - per-light uniform, the light's own animation seed.
 * @param {*} args.uGlobalTimeMs - the ONE shared uniform (not per-light),
 *   written once per frame from `env.time.tMs` (core/frame-clock.js — the
 *   one clock; see this module's own header).
 * @returns {*} a float TSL node — `time`, the phase argument every
 *   animation's fragment body reads.
 */
export function buildAnimationTimeNode(TSL, { uSpeedRaw, uReverseSign, uSeed, uGlobalTimeMs }) {
  const { float } = TSL;
  return uSpeedRaw.mul(uReverseSign).mul(uGlobalTimeMs).div(float(5000)).add(uSeed);
}

/**
 * Foundry's `animateFlickering` (torch/flame/siren/candleFlicker's shared
 * driver primitive), computed in-shader: `amplitude = amplification*0.45`,
 * `n ≈ noise(time) remapped to [0,amplitude]`, `brightnessPulse = 0.55+n`.
 * `amplification` is a TSL node the caller builds (torch/siren:
 * `uIntensityRaw/5`; flame: a fixed `float(1)`) — same per-animation
 * divergence as before, now expressed as a node instead of a JS number
 * (registry.js's own `flickerAmplification` field still documents which
 * formula applies to which animation).
 *
 * @param {*} TSL
 * @param {object} args
 * @param {*} args.time - this light's `buildAnimationTimeNode` result.
 * @param {*} args.amplification - a float TSL node.
 * @returns {{n: *, brightnessPulse: *}} `n` alone (for the ratio-jitter
 *   formula, which needs it separately), and the combined `brightnessPulse`.
 */
export function buildFlickerNode(TSL, { time, amplification }) {
  // mx_noise_float — NOT mx_perlin_noise_float: the vendored three.webgpu.js
  // (r185) defines `mx_perlin_noise_float` internally but does NOT export it
  // on the TSL namespace (a live `perlinNoise is not a function` crash caught
  // this, 2026-07-20 — the earlier "verified present" audit note was wrong,
  // it confirmed the internal var, not the public export). `mx_noise_float`
  // IS exported and is exactly `mx_perlin_noise_float(p) * 1 + 0` at its
  // amplitude=1/pivot=0 defaults — same Perlin field, same [-1,1] range.
  const { float, vec2, mx_noise_float: perlinNoise } = TSL;
  const amplitude = amplification.mul(float(0.45));
  // mx_noise_float ~ [-1,1]; remap to Foundry's own SmoothNoise
  // output range [0, amplitude]. The `vec2(time, 0)` sample position keeps
  // this a 1D-shaped noise (matching SmoothNoise's own 1D signature) while
  // still using the vendored 2D-capable primitive.
  const raw = perlinNoise(vec2(time, float(0)));
  const n = raw.add(float(1)).mul(float(0.5)).mul(amplitude);
  return { n, brightnessPulse: float(0.55).add(n) };
}

/**
 * `ratio = baseRatio*0.9 + n*0.222` — the flicker's own ratio-jitter term,
 * a small enough formula to keep as a one-line helper rather than folding
 * into `buildFlickerNode` (coloration never needs it, only illumination's
 * switchColor-band rebuild does — see point-light-illumination.js's own
 * `computeSwitchColorBand`).
 * @param {*} TSL @param {*} baseRatio - the light's own unjittered ratio. @param {*} n - from `buildFlickerNode`.
 * @returns {*} a float TSL node.
 */
export function buildFlickerRatioNode(TSL, baseRatio, n) {
  const { float } = TSL;
  return baseRatio.mul(float(0.9)).add(n.mul(float(0.222)));
}

/**
 * Foundry's `animatePulse` driver, computed in-shader: `i =
 * (10-intensity)*0.1`, `w = 0.5*(cos(time*2.5)+1)`, `wave(a,b) =
 * (a-b)*w+b`. Coloration reads `pulse = wave(1.2, i)`; illumination reads
 * `ratio = wave(baseRatio, baseRatio*i)`.
 *
 * @param {*} TSL
 * @param {object} args
 * @param {*} args.time @param {*} args.uIntensityRaw @param {*} args.baseRatio
 * @returns {{pulse: *, ratio: *}}
 */
export function buildPulseNode(TSL, { time, uIntensityRaw, baseRatio }) {
  const { float, cos } = TSL;
  const i = float(10).sub(uIntensityRaw).mul(float(0.1));
  const w = float(0.5).mul(cos(time.mul(float(2.5))).add(float(1)));
  const wave = (a, b) => a.sub(b).mul(w).add(b);
  return {
    pulse: wave(float(1.2), i),
    ratio: wave(baseRatio, baseRatio.mul(i)),
  };
}
