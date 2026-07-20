/**
 * THE CPU DRIVERS — the non-shader half of Foundry's animated lights
 * (docs/planning/Light-Parity.md §5's last build-order item;
 * docs/reference/foundry-v14-light-animations-audit.md is the per-animation
 * implementation reference this module is a prerequisite for).
 *
 * Verified against `base-light-source.mjs`/`rendered-effect-source.mjs`
 * directly (not the summary table): Foundry drives an animated light with
 * exactly FOUR CPU functions. Three are pure per-frame math (ported here,
 * verbatim); the fourth (`animateSoundPulse`, reads `game.audio` band
 * levels) is a genuinely different dependency class — deferred, not built
 * here (see registry.js's own header for the `reactivepulse` deferral).
 *
 *   animateTime        — the shared base clock EVERY animation uses to seed
 *                         its own `time` uniform. `computeAnimationTime` below.
 *   animateFlickering  — torch's flicker: a CPU `SmoothNoise` generator
 *                         jitters `brightnessPulse`/`ratio`. `SmoothNoise` +
 *                         `computeFlickerUniforms` below.
 *   animatePulse       — pulse's breathing: a pure cosine wave, no noise
 *                         object needed. `computePulseUniforms` below.
 *   animateSoundPulse  — NOT built here (needs `game.audio`).
 *
 * WHY THIS IS CPU-SIDE, NOT A SHADER TERM: this project's own established
 * pattern (point-light-illumination.js's `uRatio`/`uAttenuationEased`/
 * `uExposure`) is "compute the exact scalar on the CPU once per light per
 * frame, hand the shader a plain uniform" — these three functions extend
 * that same pattern rather than inventing a GPU-noise equivalent. A real,
 * practical win falls out of it for free: `ratio` is ALREADY a mutable
 * per-light uniform written fresh every frame in vt-pan-viewer.js's
 * updatePointLightMeshes — for a flicker/pulse-driven light, the caller
 * just writes the JITTERED ratio into that same uniform instead of
 * `light.ratio`. The illumination/coloration shaders never need to know.
 *
 * THE ONE CLOCK: every function here takes `tMs` as a parameter rather than
 * reading a clock itself — `tools/verify-structure.mjs`'s `time/one-clock`
 * wall forbids a new `performance.now()`/`Date.now()` anywhere outside
 * core/frame-clock.js (+diag/). The caller hands in `env.time.tMs` (the
 * frame's already-ticked frame-clock snapshot), exactly like every other
 * per-frame value this pass already consumes.
 *
 * @module effects/lighting/animations/light-animation-clock
 */

/**
 * Foundry's shared animation clock (`animateTime`, `base-light-source.mjs`/
 * `rendered-effect-source.mjs`, both identical): `time = (speed * t) / 5000
 * + seed`, `t` negated first when `reverse`. `seed` desyncs identical
 * lights — read live off Foundry's own `source.animation.seed`
 * (foundry/scene-lights.js#deriveAnimationSnapshot), never invented here.
 *
 * @param {object} args
 * @param {number} args.speedRaw - LightData.animation.speed, 0..10.
 * @param {boolean} args.reverse - LightData.animation.reverse.
 * @param {number} args.tMs - the frame's `env.time.tMs` (core/frame-clock.js).
 * @param {number} args.seed - the light's own animation seed.
 * @returns {number} `time`, the phase argument every animation's fragment
 *   body (and the flicker/pulse drivers below) reads.
 */
export function computeAnimationTime({ speedRaw, reverse, tMs, seed }) {
  const t = reverse ? -tMs : tMs;
  return (speedRaw * t) / 5000 + seed;
}

/**
 * A faithful, Node-testable port of Foundry's `client/canvas/animation/
 * smooth-noise.mjs` — a smooth 1D value-noise generator over a FIXED table
 * of pre-generated random references, interpolated by a cubic smoothstep of
 * the (scaled) input's fractional part. Stateful only in that table (built
 * once at construction); `generate(x)` is otherwise a pure function of `x`.
 *
 * `randomSource` is injected (defaults to `Math.random`) purely so tests can
 * assert exact `generate()` output against a deterministic table — matches
 * this codebase's "pure by injection" convention (core/frame-clock.js's own
 * `now` parameter is the precedent).
 */
export class SmoothNoise {
  /**
   * @param {object} [options]
   * @param {number} [options.amplitude=1] - output range is [0, amplitude].
   * @param {number} [options.scale=1] - input `x` scale factor.
   * @param {number} [options.maxReferences=256] - table size; MUST be a
   *   power of 2 (Foundry's own constraint — the table index is derived via
   *   bitmask, not modulo).
   * @param {() => number} [randomSource] - injected RNG, [0,1).
   */
  constructor({ amplitude = 1, scale = 1, maxReferences = 256 } = {}, randomSource = Math.random) {
    this.amplitude = amplitude;
    this.scale = scale;
    if (!Number.isInteger(maxReferences) || maxReferences <= 0 || (maxReferences & (maxReferences - 1)) !== 0) {
      throw new Error('SmoothNoise maxReferences must be a positive power-of-2 integer.');
    }
    this._maxReferences = maxReferences;
    this._references = [];
    for (let i = 0; i < maxReferences; i++) this._references.push(randomSource());
  }

  get amplitude() {
    return this._amplitude;
  }
  set amplitude(amplitude) {
    if (!Number.isFinite(amplitude) || amplitude === 0) {
      throw new Error('SmoothNoise amplitude must be a finite non-zero number.');
    }
    this._amplitude = amplitude;
  }

  get scale() {
    return this._scale;
  }
  set scale(scale) {
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new Error('SmoothNoise scale must be a finite positive number.');
    }
    this._scale = scale;
  }

  /**
   * @param {number} x - any finite number.
   * @returns {number} the smoothed noise value, in [0, this.amplitude].
   */
  generate(x) {
    const scaledX = x * this._scale;
    const xFloor = Math.floor(scaledX);
    const t = scaledX - xFloor;
    const tSmooth = t * t * (3 - 2 * t);
    // Bitmask, not modulo — matches Foundry exactly, and is safe for
    // negative xFloor under JS's ToInt32 two's-complement `&` semantics
    // (verified: (-1) & (maxReferences-1) === maxReferences-1, the correct
    // "wrap to a valid table index" result, identical in Node and browser).
    const i0 = xFloor & (this._maxReferences - 1);
    const i1 = (i0 + 1) & (this._maxReferences - 1);
    const y = this._references[i0] + (this._references[i1] - this._references[i0]) * tSmooth;
    return y * this._amplitude;
  }
}

/**
 * Foundry's `animateFlickering` (torch/flame/siren's shared driver
 * PRIMITIVE), verbatim (`base-light-source.mjs`): `amplitude = amplification
 * * 0.45`, `n = noise.generate(time)`, `brightnessPulse = 0.55 + n`,
 * `ratio = ratio*0.9 + n*0.222`. Both illumination AND coloration read the
 * SAME `brightnessPulse` — Foundry assigns it to both channels' uniforms
 * from one computation, so the caller should do the same (one call per
 * light per frame, not one per channel).
 *
 * `amplification` is a REQUIRED, EXPLICIT parameter (default `1`, matching
 * `animateFlickering`'s own JS default) rather than derived from
 * `intensityRaw` in here — verified against source
 * (docs/reference/foundry-v14-light-animations-audit.md §1.3): Foundry's
 * `animateTorch` wraps this primitive with `amplification: intensity/5`
 * (torch, siren), but `flame`'s registry entry calls `animateFlickering`
 * DIRECTLY with no override, so flame's flicker amplitude is FIXED at `1`
 * (`0.45` after the `*0.45`) regardless of the light's intensity slider —
 * a real, easy-to-miss divergence between two animations sharing this same
 * driver. Callers (the registry entries for torch/siren vs flame) decide
 * which formula applies; see registry.js's own `flickerAmplification` field.
 *
 * @param {object} args
 * @param {number} args.time - this light's `computeAnimationTime` result.
 * @param {number} [args.amplification=1] - noise amplification/dampening;
 *   `intensityRaw/5` for torch/siren (`animateTorch`'s own formula), a fixed
 *   `1` for flame (its registry entry never overrides it).
 * @param {number} args.ratio - the light's own (un-jittered) `bright/radius`.
 * @param {SmoothNoise} args.noise - this light's OWN cached noise generator
 *   (one instance per light, constructed once on first appearance — see
 *   this module's header for why it must never be recreated per-frame).
 * @returns {{brightnessPulse: number, ratio: number}}
 */
export function computeFlickerUniforms({ time, amplification = 1, ratio, noise }) {
  const amplitude = amplification * 0.45;
  if (noise.amplitude !== amplitude) noise.amplitude = amplitude;
  const n = noise.generate(time);
  return {
    brightnessPulse: 0.55 + n,
    ratio: ratio * 0.9 + n * 0.222,
  };
}

/**
 * Foundry's `animatePulse` driver, verbatim (`base-light-source.mjs`):
 * `i = (10-intensity)*0.1`, `w = 0.5*(cos(time*2.5)+1)`,
 * `wave(a,b,w) = (a-b)*w + b`; coloration reads `pulse = wave(1.2, i, w)`,
 * illumination reads `ratio = wave(ratio, ratio*i, w)`. Pure — no noise
 * object needed (unlike flicker).
 *
 * @param {object} args
 * @param {number} args.time - this light's `computeAnimationTime` result.
 * @param {number} args.intensityRaw - LightData.animation.intensity, 1..10.
 * @param {number} args.ratio - the light's own (un-jittered) `bright/radius`.
 * @returns {{pulse: number, ratio: number}}
 */
export function computePulseUniforms({ time, intensityRaw, ratio }) {
  const i = (10 - intensityRaw) * 0.1;
  const w = 0.5 * (Math.cos(time * 2.5) + 1);
  const wave = (a, b, ww) => (a - b) * ww + b;
  return {
    pulse: wave(1.2, i, w),
    ratio: wave(ratio, ratio * i, w),
  };
}
