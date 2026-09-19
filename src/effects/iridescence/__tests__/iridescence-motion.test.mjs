/**
 * Node verification for effects/iridescence/iridescence-motion.js — the pure
 * mask/noise/phase/palette maths, mirroring prism-motion.test.mjs's own job:
 * plain numbers in, plain numbers out, no THREE required.
 */
import {
  hash,
  mapNoiseScale,
  computeMaskPresence,
  computeLiquidNoise,
  computeGlitterNoise,
  computeNoiseOffset,
  computePhase,
  computeRainbowColor,
  computeLitFactor,
  IRIDESCENCE_MAX_TIER,
  IRIDESCENCE_DEFAULT_TIER,
  iridescenceTierPlan,
} from '../iridescence-motion.js';

export function run(t) {
  const { ok } = t;

  // ── hash — deterministic, bounded, and NOT a constant function ──────────
  {
    const a = hash(1.3, 4.7);
    const b = hash(1.3, 4.7);
    ok('hash is deterministic for the same input', a === b);
    ok('hash stays in [0,1)', a >= 0 && a < 1);
    const c = hash(2.9, 0.1);
    ok('hash genuinely varies across inputs (not a constant)', a !== c);
  }

  // ── mapNoiseScale — V2's own exponential ramp, per flavour ──────────────
  {
    const loLiquid = mapNoiseScale(0, 0);
    const hiLiquid = mapNoiseScale(1, 0);
    ok(
      'liquid noise scale spans V2`s own [0.002, 0.05] range',
      Math.abs(loLiquid - 0.002) < 1e-9 && Math.abs(hiLiquid - 0.05) < 1e-9
    );
    const loGlitter = mapNoiseScale(0, 1);
    const hiGlitter = mapNoiseScale(1, 1);
    ok(
      'glitter noise scale spans V2`s own [0.5, 5.0] range',
      Math.abs(loGlitter - 0.5) < 1e-9 && Math.abs(hiGlitter - 5.0) < 1e-9
    );
    ok(
      'mid-slider is strictly between the two ends (an exponential ramp, not linear-then-clamped)',
      mapNoiseScale(0.5, 0) > loLiquid && mapNoiseScale(0.5, 0) < hiLiquid
    );
    ok('an out-of-range UI value clamps into [0,1] first rather than propagating', mapNoiseScale(5, 0) === hiLiquid);
  }

  // ── computeMaskPresence — V2's own max(luma,peak)*alpha, never alpha-only ──
  {
    ok(
      'a fully opaque white mask above threshold reads full presence',
      computeMaskPresence({ r: 1, g: 1, b: 1, a: 1, maskThreshold: 0.4, invertMask: false }) > 0.99
    );
    ok(
      'zero alpha (nothing painted here) reads zero presence regardless of RGB',
      computeMaskPresence({ r: 1, g: 1, b: 1, a: 0, maskThreshold: 0.1, invertMask: false }) === 0
    );
    ok(
      'a saturated, non-black colour (e.g. pure blue) still reads real presence via PEAK, not luma alone',
      computeMaskPresence({ r: 0, g: 0, b: 1, a: 1, maskThreshold: 0.5, invertMask: false }) > 0.4
    );
    const normal = computeMaskPresence({ r: 0.9, g: 0.9, b: 0.9, a: 1, maskThreshold: 0.4, invertMask: false });
    const inverted = computeMaskPresence({ r: 0.9, g: 0.9, b: 0.9, a: 1, maskThreshold: 0.4, invertMask: true });
    ok('invertMask genuinely flips a bright mask toward absence', inverted < normal);
  }

  // ── computeLiquidNoise / computeGlitterNoise — two genuinely different fields ──
  {
    const a = computeLiquidNoise(10, 20, 0.02);
    const b = computeLiquidNoise(10, 20, 0.02);
    ok('liquid noise is a pure function of its inputs', a === b);
    const c = computeLiquidNoise(500, 20, 0.02);
    ok('liquid noise varies across world position (not a constant field)', a !== c);

    const g1 = computeGlitterNoise(10, 20, 1);
    ok('glitter noise stays in [0,1)', g1 >= 0 && g1 < 1);
    const g2 = computeGlitterNoise(11, 20, 1);
    ok('glitter noise varies across grid cells', g1 !== g2);

    ok(
      'computeNoiseOffset dispatches 0 to Liquid',
      computeNoiseOffset(10, 20, 0.02, 0) === computeLiquidNoise(10, 20, 0.02)
    );
    ok(
      'computeNoiseOffset dispatches 1 to Glitter',
      computeNoiseOffset(10, 20, 1, 1) === computeGlitterNoise(10, 20, 1)
    );
  }

  // ── computePhase — V2's own five-term sum, angle authored in degrees ─────
  {
    const base = computePhase({
      screenU: 0.5,
      screenV: 0.5,
      angleDeg: 0,
      randomOffset: 0,
      maskVal: 0,
      distortionStrength: 0,
      elapsedSec: 0,
      flowSpeed: 0,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      parallaxStrength: 0,
    });
    ok(
      'with every term zeroed, phase is exactly the diagonal sweep at angle 0 (screenU*1 + screenV*0)',
      Math.abs(base - 0.5) < 1e-9
    );
    const withFlow = computePhase({
      screenU: 0.5,
      screenV: 0.5,
      angleDeg: 0,
      randomOffset: 0,
      maskVal: 0,
      distortionStrength: 0,
      elapsedSec: 10,
      flowSpeed: 2,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      parallaxStrength: 0,
    });
    ok('the flow term advances the phase over time', withFlow > base);
    const withParallax = computePhase({
      screenU: 0.5,
      screenV: 0.5,
      angleDeg: 0,
      randomOffset: 0,
      maskVal: 0,
      distortionStrength: 0,
      elapsedSec: 0,
      flowSpeed: 0,
      cameraOffsetX: 1000,
      cameraOffsetY: 0,
      parallaxStrength: 2,
    });
    ok(
      'the parallax term matches V2`s own (x+y)*0.001*strength formula exactly',
      Math.abs(withParallax - (base + 1000 * 0.001 * 2)) < 1e-9
    );
    const at90 = computePhase({
      screenU: 1,
      screenV: 0,
      angleDeg: 90,
      randomOffset: 0,
      maskVal: 0,
      distortionStrength: 0,
      elapsedSec: 0,
      flowSpeed: 0,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      parallaxStrength: 0,
    });
    ok(
      'a 90 degree angle rotates the sweep onto screenV (cos(90)=0, sin(90)=1, screenV=0 here)',
      Math.abs(at90) < 1e-9
    );
  }

  // ── computeRainbowColor — V2's own Inigo-Quilez cosine palette ───────────
  {
    const c0 = computeRainbowColor(0, 1, 1);
    ok('phase 0 reads V2`s own fixed base colour (0.5 + 0.5*cos(0|2|4))', Math.abs(c0.r - 1) < 1e-9);
    ok(
      'every channel stays in [0,1]',
      [c0.r, c0.g, c0.b].every((v) => v >= 0 && v <= 1)
    );
    const c1 = computeRainbowColor(0.5, 1, 1);
    ok('a different phase reads a genuinely different colour', c1.r !== c0.r || c1.g !== c0.g || c1.b !== c0.b);
    ok(
      'the three channels are evenly spaced around the colour wheel (0,2,4), never equal for a generic phase',
      !(c1.r === c1.g && c1.g === c1.b)
    );
  }

  // ── computeLitFactor — V2's own mix(luma, 1, ignoreDarkness) ─────────────
  {
    ok('ignoreDarkness 0 fully obeys a dark buffer (near-black stays near-black)', computeLitFactor(0.1, 0) === 0.1);
    ok('ignoreDarkness 1 ignores darkness entirely (always full brightness)', computeLitFactor(0.1, 1) === 1);
    const mid = computeLitFactor(0.2, 0.5);
    ok('ignoreDarkness 0.5 sits genuinely between the two', mid > 0.2 && mid < 1);
    ok('a bright illum sample passes through unclamped-down at ignoreDarkness 0', computeLitFactor(1.4, 0) === 1.4);
  }

  // ── iridescenceTierPlan — the gate a live profile change actually branches on ──
  {
    const p0 = iridescenceTierPlan(0);
    ok('tier 0: nothing above the mask gate is enabled', !p0.flowEnabled && !p0.lightReactiveEnabled);
    const p1 = iridescenceTierPlan(1);
    ok('tier 1: flow on, light reactivity not yet', p1.flowEnabled && !p1.lightReactiveEnabled);
    const p2 = iridescenceTierPlan(IRIDESCENCE_MAX_TIER);
    ok('tier 2 (max): both on', p2.flowEnabled && p2.lightReactiveEnabled);
    ok(
      'non-finite input falls back to IRIDESCENCE_DEFAULT_TIER, not NaN',
      iridescenceTierPlan(undefined).tier === IRIDESCENCE_DEFAULT_TIER
    );
    ok(
      'IRIDESCENCE_DEFAULT_TIER is the full ladder (the one profile that affords Iridescence at all affords every rung)',
      IRIDESCENCE_DEFAULT_TIER === IRIDESCENCE_MAX_TIER
    );
    ok('clamps above the max', iridescenceTierPlan(99).tier === IRIDESCENCE_MAX_TIER);
    ok('clamps below zero', iridescenceTierPlan(-3).tier === 0);
  }
}
