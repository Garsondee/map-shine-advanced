/**
 * light-shape.test.mjs — THE LIGHT SHAPE (2026-11-01): the natural point-light falloff
 * Foundry's flat disc blends toward, and the shipped default kept equal to the Colour
 * Grade's own `lightSoftness` default (two homes for one number, so a test holds them).
 * The node is built with the real vendored TSL so the port is proven to construct; the
 * pixels were measured on the light bench in a real Foundry scene.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  naturalFalloff,
  buildNaturalFalloffNode,
  NATURAL_FALLOFF_PEAK,
  DEFAULT_POINT_LIGHT_SOFTNESS,
  setPointLightSoftness,
} from '../point-light-illumination.js';
import { GRADE_LOOK_PARAMS } from '../../grade/grade.js';
import { BLOOM_PARAMS } from '../../bloom.js';
import { LOOK_REST_SOFTNESS, LOOK_REST_GLOW_DAY, STARTER_LOOKS } from '../../../core/looks-schema.js';

export function run(t) {
  t.ok('the core is the peak', Math.abs(naturalFalloff(0) - NATURAL_FALLOFF_PEAK) < 1e-12);
  t.ok('the core runs brighter than the floor (HDR)', naturalFalloff(0) > 1);
  t.ok('exactly dark at the dim edge', naturalFalloff(1) === 0);
  t.ok('dark past the edge too', naturalFalloff(1.4) === 0);
  let mono = true;
  for (let d = 0; d < 1; d += 0.01) if (naturalFalloff(d + 0.01) > naturalFalloff(d) + 1e-12) mono = false;
  t.ok('falls monotonically', mono);
  t.ok('half strength well inside the radius (a pool, not a disc)', naturalFalloff(0.75) < NATURAL_FALLOFF_PEAK * 0.5);
  t.ok('still a real glow at three quarters', naturalFalloff(0.75) > 0.25);
  t.ok('a gentle core: never far above white', NATURAL_FALLOFF_PEAK <= 1.25);
  t.ok(
    'the shipped default matches the Colour Grade default',
    GRADE_LOOK_PARAMS.lightSoftness.default === DEFAULT_POINT_LIGHT_SOFTNESS
  );
  t.ok(
    'starter Looks use the natural shape, and only with the roll-off that keeps it clean',
    LOOK_REST_SOFTNESS === 1 &&
      STARTER_LOOKS.every(
        (l) => l.values['grade.lightSoftness'] !== 1 || ['rolloff', 'aces'].includes(l.values['grade.toneMapping'])
      )
  );
  t.ok('...and to the shipped lamp glow in daylight', LOOK_REST_GLOW_DAY === GRADE_LOOK_PARAMS.lightGlowDay.default);
  const restBloom = STARTER_LOOKS.filter((l) => l.values['bloom.dayThreshold'] === BLOOM_PARAMS.dayThreshold.default);
  t.ok('...and most to the shipped bloom daylight floor', restBloom.length >= STARTER_LOOKS.length / 2);
  let built = false;
  try {
    built = !!buildNaturalFalloffNode(THREE.TSL, THREE.TSL.float(0.5));
  } catch (_) {
    built = false;
  }
  t.ok('the TSL node constructs', built);
  setPointLightSoftness(2);
  setPointLightSoftness(Number.NaN);
  t.ok('setting junk before any build is harmless', true);
  setPointLightSoftness(DEFAULT_POINT_LIGHT_SOFTNESS);
}
