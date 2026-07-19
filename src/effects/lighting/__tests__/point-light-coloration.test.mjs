/**
 * Node verification for effects/lighting/point-light-coloration.js.
 *
 * Only `computeColorationAlpha` is pure/testable here. `buildPointLight
 * ColorationMaterial` builds TSL and is browser-only (verified live via the
 * debug panel / an A/B screenshot vs Foundry, not a mocked THREE —
 * CONVENTIONS.md §4).
 */
import { computeColorationAlpha } from '../point-light-coloration.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok } = t;

  ok('technique 0 (Legacy): alpha squared', near(computeColorationAlpha(0.5, 0), 0.25));
  ok('technique 0 at alpha=1 stays 1', near(computeColorationAlpha(1, 0), 1));
  for (const technique of [4, 5, 6, 9]) {
    ok(
      `technique ${technique} (burn/invert): alpha passes through unscaled`,
      near(computeColorationAlpha(0.7, technique), 0.7)
    );
  }
  ok('technique 1 (Adaptive Luminance, the LightData default): alpha*2', near(computeColorationAlpha(0.5, 1), 1));
  ok(
    'technique 2 (an "everything else" technique): alpha*2, same bucket as 1',
    near(computeColorationAlpha(0.3, 2), 0.6)
  );
  ok(
    'technique 100/101 (attenuation variants) also land in the alpha*2 bucket',
    near(computeColorationAlpha(0.4, 100), 0.8)
  );
  ok('alpha clamps into [0,1] before the remap', near(computeColorationAlpha(1.7, 1), 2));
  ok('non-finite alpha reads as the LightData default (0.5), never NaN', near(computeColorationAlpha(NaN, 1), 1));
  ok('negative alpha clamps to 0', near(computeColorationAlpha(-0.5, 1), 0));
}
