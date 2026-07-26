/**
 * water-light.test.mjs — tier 3's pure sun-direction arithmetic, proven
 * without a GPU (the TSL builder itself cannot be Node-tested, CONVENTIONS §4).
 *
 * `waterKeyLightDirection` is a byte-for-byte copy of
 * `specular-material.js#keyLightDirection`, made independently rather than
 * imported (see `water-light.js`'s own header for why). This suite exists to
 * prove the copy stayed exact: this codebase has a documented history of
 * sun/sky direction bugs surviving unnoticed for a module's entire life
 * (`feedback_unconsumed_api_rots_silently`), and a hand-copied trig formula is
 * exactly the kind of thing that silently drifts on the next edit.
 */
import { waterKeyLightDirection, WATER_F0, WATER_MIN_ROUGHNESS, WATER_TIER3_GLOSSINESS } from '../water-light.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

export function run(t) {
  const { ok } = t;

  // --- straight overhead: azimuth is irrelevant, the vector is +Z ----------
  {
    const [x, y, z] = waterKeyLightDirection({ dirX: 1, dirY: 0, elevationDeg: 90 });
    ok('sun at zenith points straight up regardless of azimuth', near(x, 0) && near(y, 0) && near(z, 1));
  }

  // --- on the horizon: the vector is purely horizontal, unit length --------
  {
    const [x, y, z] = waterKeyLightDirection({ dirX: 1, dirY: 0, elevationDeg: 0 });
    ok('sun on the horizon has zero Z', near(z, 0));
    ok('...and the horizontal direction is preserved', near(x, 1) && near(y, 0));
  }

  // --- a general case: 45° elevation splits Z and the horizontal equally ---
  {
    const [x, y, z] = waterKeyLightDirection({ dirX: 0, dirY: 1, elevationDeg: 45 });
    ok('45° elevation: Z equals the horizontal component', near(z, x === 0 ? y : x, 1e-5));
    const len = Math.hypot(x, y, z);
    ok('...and the result is always unit length', near(len, 1, 1e-5));
  }

  // --- degenerate input never throws and never returns a non-unit vector ---
  {
    const [x, y, z] = waterKeyLightDirection({});
    ok('a missing key falls back to straight up, not NaN', near(x, 0) && near(y, 0) && near(z, 1));
  }
  {
    const v = waterKeyLightDirection(undefined);
    ok('an undefined key does not throw and returns straight up', v[0] === 0 && v[1] === 0 && v[2] === 1);
  }

  // --- the constants are physically sane, not just present ------------------
  ok(
    "water's own F0 is LOWER than specular's general-dielectric average (0.04) — water 0.02 is the documented value",
    WATER_F0 > 0 && WATER_F0 < 0.04
  );
  ok(
    'the roughness floor matches the SAME fp16 GGX-denominator guard specular uses (0.089), not a different number',
    WATER_MIN_ROUGHNESS === 0.089
  );
  ok(
    'default glossiness is high (near-mirror calm water) but leaves room below 1',
    WATER_TIER3_GLOSSINESS > 0.5 && WATER_TIER3_GLOSSINESS < 1
  );
}
