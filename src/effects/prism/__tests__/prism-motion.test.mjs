/**
 * Node verification for effects/prism/prism-motion.js — the pure facet/glint/
 * dispersion maths, mirroring lens-motion.test.mjs's own job: plain numbers
 * in, plain numbers out, no THREE required.
 */
import {
  hash2,
  cellJitter,
  computeVoronoiFacet,
  computeFacetTimePhase,
  computeFacetUv,
  blendFacetSlope,
  computeGlintAmount,
  computeChromaticOffsets,
  PRISM_PARALLAX_SCALE,
  PRISM_MAX_TIER,
  PRISM_DEFAULT_TIER,
  prismTierPlan,
} from '../prism-motion.js';

export function run(t) {
  const { ok } = t;

  // ── hash2 — deterministic, bounded, and NOT a constant function ─────────
  {
    const a = hash2(1.3, 4.7);
    const b = hash2(1.3, 4.7);
    ok('hash2 is deterministic for the same input', a.x === b.x && a.y === b.y);
    ok('hash2 stays in [0,1)', a.x >= 0 && a.x < 1 && a.y >= 0 && a.y < 1);
    const c = hash2(2.9, 0.1);
    ok('hash2 genuinely varies across inputs (not a constant)', a.x !== c.x || a.y !== c.y);
  }

  // ── cellJitter — bounded, and animates with time ─────────────────────────
  {
    const frozen = cellJitter(3, -2, 0);
    ok('cellJitter stays in [0,1] at phase 0', frozen.x >= 0 && frozen.x <= 1 && frozen.y >= 0 && frozen.y <= 1);
    const later = cellJitter(3, -2, 1.234);
    ok(
      'cellJitter moves as the phase advances (it is animated, not frozen)',
      frozen.x !== later.x || frozen.y !== later.y
    );
    const same = cellJitter(3, -2, 0);
    ok(
      'cellJitter is a pure function of (cell, phase) — same inputs, same output',
      frozen.x === same.x && frozen.y === same.y
    );
  }

  // ── computeVoronoiFacet — the field itself ────────────────────────────────
  {
    const facet = computeVoronoiFacet(4.2, -1.7, 0.5);
    ok(
      'distSq is non-negative and bounded below the 3x3 search`s own worst case (8.0)',
      facet.distSq >= 0 && facet.distSq < 8
    );
    ok('slope is a real, finite 2D vector', Number.isFinite(facet.slopeX) && Number.isFinite(facet.slopeY));
    const shifted = computeVoronoiFacet(4.2 + 50, -1.7, 0.5);
    ok(
      'the field is not a global constant — a distant coordinate reads a different cell',
      facet.slopeX !== shifted.slopeX || facet.slopeY !== shifted.slopeY
    );
    // A fragment sitting exactly at its own cell`s jittered point has the
    // shortest possible distance to it — sanity-check the search actually
    // finds a genuinely nearby candidate rather than always picking (0,0).
    const cellX = 10;
    const cellY = 10;
    const jitter = cellJitter(cellX, cellY, 0.5);
    const onPoint = computeVoronoiFacet(cellX + jitter.x, cellY + jitter.y, 0.5);
    ok('sampling exactly at a jittered point finds it at ~zero distance', onPoint.distSq < 1e-6);
  }

  // ── computeFacetTimePhase — `facetAnimate` freezes the CLOCK, not just motion ──
  {
    ok(
      'facetAnimate:false always reads phase 0, regardless of elapsed time',
      computeFacetTimePhase(999, 2, false) === 0
    );
    ok('facetAnimate:true scales elapsed time by speed', computeFacetTimePhase(10, 2, true) === 20);
    ok(
      'a negative/garbage elapsed time reads as 0 rather than propagating NaN',
      computeFacetTimePhase(-5, 2, true) === 0
    );
  }

  // ── computeFacetUv — parallax scale is V2's own literal ──────────────────
  ok('PRISM_PARALLAX_SCALE is V2`s own literal (0.0001)', PRISM_PARALLAX_SCALE === 0.0001);
  {
    const noParallax = computeFacetUv({
      u: 0.5,
      v: 0.5,
      facetScale: 100,
      cameraOffsetX: 500,
      cameraOffsetY: 500,
      parallaxStrength: 0,
    });
    ok('zero parallax strength ignores the camera offset entirely', noParallax.u === 50 && noParallax.v === 50);
    const withParallax = computeFacetUv({
      u: 0.5,
      v: 0.5,
      facetScale: 100,
      cameraOffsetX: 500,
      cameraOffsetY: 500,
      parallaxStrength: 2,
    });
    ok(
      'a real parallax strength shifts the facet UV',
      withParallax.u !== noParallax.u || withParallax.v !== noParallax.v
    );
    const expectedDx = 500 * PRISM_PARALLAX_SCALE * 2;
    ok('the shift matches V2`s own formula exactly', Math.abs(withParallax.u - (0.5 + expectedDx) * 100) < 1e-9);
  }

  // ── blendFacetSlope — facetSoftness dials facet → glass ──────────────────
  {
    const facet = { slopeX: 1, slopeY: 0 };
    const glass = { slopeX: 0, slopeY: 1 };
    ok(
      'softness 0 is the facet slope untouched',
      JSON.stringify(blendFacetSlope(facet, glass, 0)) === JSON.stringify({ slopeX: 1, slopeY: 0 })
    );
    ok(
      'softness 1 is fully the glass fallback',
      JSON.stringify(blendFacetSlope(facet, glass, 1)) === JSON.stringify({ slopeX: 0, slopeY: 1 })
    );
    const mid = blendFacetSlope(facet, glass, 0.5);
    ok(
      'softness 0.5 is genuinely between the two',
      Math.abs(mid.slopeX - 0.5) < 1e-9 && Math.abs(mid.slopeY - 0.5) < 1e-9
    );
  }

  // ── computeGlintAmount — smoothstep-gated alignment ───────────────────────
  {
    // At t=0, V2's own light direction is (sin(0), cos(0)) = (0, 1).
    const aligned = computeGlintAmount({ slopeX: 0, slopeY: 1, elapsedSec: 0, glintThreshold: 0.1 });
    ok('a slope pointing exactly at the light direction glints near-fully', aligned > 0.9);
    const opposed = computeGlintAmount({ slopeX: 0, slopeY: -1, elapsedSec: 0, glintThreshold: 0.1 });
    ok('a slope pointing directly AWAY from the light does not glint', opposed === 0);
    ok('glint amount never exceeds [0,1]', aligned <= 1 && opposed >= 0);
    const higherThreshold = computeGlintAmount({ slopeX: 0.1, slopeY: 1, elapsedSec: 0, glintThreshold: 0.9 });
    const lowerThreshold = computeGlintAmount({ slopeX: 0.1, slopeY: 1, elapsedSec: 0, glintThreshold: 0.1 });
    ok('raising the threshold never makes an off-axis facet glint MORE', higherThreshold <= lowerThreshold);
  }

  // ── computeChromaticOffsets — V2's own red-furthest/blue-least split ─────
  {
    const offsets = computeChromaticOffsets({ slopeX: 1, slopeY: 0, intensity: 1, spread: 0.5 });
    ok('red bends furthest', offsets.r.x > offsets.g.x);
    ok('blue bends least', offsets.b.x < offsets.g.x);
    ok('green sits at the un-split centre (slope * distAmt exactly)', offsets.g.x === 1 * 0.01);
    ok(
      'all three share the same slope DIRECTION (only magnitude differs)',
      offsets.r.y === 0 && offsets.g.y === 0 && offsets.b.y === 0
    );
    const noSpread = computeChromaticOffsets({ slopeX: 1, slopeY: 0, intensity: 1, spread: 0 });
    ok(
      'zero spread collapses all three channels to the same offset (colour-neutral)',
      noSpread.r.x === noSpread.g.x && noSpread.g.x === noSpread.b.x
    );
    const zeroIntensity = computeChromaticOffsets({ slopeX: 1, slopeY: 0, intensity: 0, spread: 0.9 });
    ok(
      'zero intensity offsets everything to (0,0) regardless of spread',
      zeroIntensity.r.x === 0 && zeroIntensity.g.x === 0 && zeroIntensity.b.x === 0
    );
  }

  // ── prismTierPlan — the gate a live profile change actually branches on ──
  {
    const p0 = prismTierPlan(0);
    ok(
      'tier 0: nothing above the mask gate is enabled',
      !p0.facetsEnabled && !p0.glintEnabled && !p0.dispersionEnabled
    );
    const p1 = prismTierPlan(1);
    ok('tier 1: facets on, glint/dispersion not yet', p1.facetsEnabled && !p1.glintEnabled && !p1.dispersionEnabled);
    const p2 = prismTierPlan(2);
    ok('tier 2: facets + glint on, dispersion not yet', p2.facetsEnabled && p2.glintEnabled && !p2.dispersionEnabled);
    const p3 = prismTierPlan(PRISM_MAX_TIER);
    ok('tier 3 (max): all three on', p3.facetsEnabled && p3.glintEnabled && p3.dispersionEnabled);
    ok(
      'non-finite input falls back to PRISM_DEFAULT_TIER, not NaN',
      prismTierPlan(undefined).tier === PRISM_DEFAULT_TIER
    );
    ok(
      'PRISM_DEFAULT_TIER is the full ladder (the one profile that affords Prism at all affords every rung)',
      PRISM_DEFAULT_TIER === PRISM_MAX_TIER
    );
    ok('clamps above the max', prismTierPlan(99).tier === PRISM_MAX_TIER);
    ok('clamps below zero', prismTierPlan(-3).tier === 0);
  }
}
