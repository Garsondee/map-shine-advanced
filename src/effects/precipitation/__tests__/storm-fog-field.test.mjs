/**
 * THE STORM-FOG FIELD's constants (mythica-machina-press#34/#314).
 *
 * ⚠️ SAME HONEST LIMIT `squall-field.test.mjs` STATES FOR ITSELF: the field
 * itself is browser-only TSL (`buildStormFogField` returns a node graph, not
 * a number) — Node can only reach what is plain JS, which here is the
 * exported constants' own shape. Real verification of the picture they
 * produce needs a render, not this suite (`tools/shader-lab`).
 */
import {
  MIST_FREQ,
  MIST_WARP_STRENGTH,
  MIST_CALM_DRIFT_PX_PER_SEC,
  MIST_WIND_DRIFT_PX_PER_SEC,
  MIST_WIND_THIN_FLOOR,
} from '../storm-fog-field.js';

export function run(t) {
  // "flat mist" (Precipitation.md §3.4 / curtain-render.js's own rule) means
  // UNBANDED — this field must carry no anisotropy/direction-stretch knob at
  // all, unlike the squall field's `CELL_ANISOTROPY`. Asserted by absence:
  // there is nothing here to assert IS isotropic beyond the shape of the
  // export list itself, so the constants below are checked for sane ranges
  // instead of a stretch factor that must never exist.
  t.ok('the base wavelength is a large, slow-varying scale', MIST_FREQ > 0 && MIST_FREQ < 0.01);
  t.ok(
    'the domain warp is present but not overwhelming (< 1x the base scale)',
    MIST_WARP_STRENGTH > 0 && MIST_WARP_STRENGTH < 1
  );

  // Mist creeps even at a dead calm (buoyant/diffusive, not blown) — the calm
  // floor must be nonzero, and a real gale must add a visibly larger drift on
  // top of it rather than merely nudging it.
  t.ok('mist drifts even at zero wind', MIST_CALM_DRIFT_PX_PER_SEC > 0);
  t.ok(
    '⭐ a full gale drifts it substantially faster than a dead calm',
    MIST_WIND_DRIFT_PX_PER_SEC > MIST_CALM_DRIFT_PX_PER_SEC * 2
  );

  // ⭐ #314: "thinning or clearing as wind speed rises" — short of fully
  // clearing (a floor > 0), so "windy" reads as thinner fog, never as
  // "the fog axis silently stopped existing".
  t.ok('wind thins the fog but never fully clears it', MIST_WIND_THIN_FLOOR > 0 && MIST_WIND_THIN_FLOOR < 1);
}
