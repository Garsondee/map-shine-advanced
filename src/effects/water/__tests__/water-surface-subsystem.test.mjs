/**
 * water-surface-subsystem.test.mjs — currently just `resolveGatedWaterTier`,
 * the safety-slide tier gate `sync()` applies before ever asking
 * `buildWaterSurfaceMaterial` for a material. NOT a general test of this
 * subsystem file (a real, pre-existing coverage gap — `createWaterSurfaceSubsystem`
 * itself needs a real scene/mask/THREE harness this file doesn't attempt to
 * build). This one function is pulled out and pinned because it is
 * genuinely safety-critical: it is the one thing standing between a live
 * session and tier 5's own live-reported self-capture feedback bug
 * (`WATER_TIER5_DISABLED_PENDING_SELF_CAPTURE_FIX`, water-render.js).
 *
 * Asserts CONDITIONALLY on the flag's own current value rather than
 * hardcoding "must always clamp" — so this test stays correct (and still
 * exercises something real) on the day that flag flips back to `false`,
 * rather than becoming a stale, misleading failure the moment the real
 * architecture fix ships.
 */
import { resolveGatedWaterTier } from '../water-surface-subsystem.js';
import { WATER_TIER5_DISABLED_PENDING_SELF_CAPTURE_FIX as GATED } from '../water-render.js';

export function run(t) {
  t.ok(
    'tiers below 5 always pass through unchanged',
    [0, 1, 2, 3, 4].every((n) => resolveGatedWaterTier(n) === n)
  );

  if (GATED) {
    t.ok('tier 5 clamps to 4 while the safety slide is on', resolveGatedWaterTier(5) === 4);
    t.ok('an out-of-range tier above 5 ALSO clamps to 4 — the gate is >=5, not ===5', resolveGatedWaterTier(99) === 4);
  } else {
    t.ok('tier 5 passes through unchanged once the safety slide is off', resolveGatedWaterTier(5) === 5);
    t.ok(
      'an out-of-range tier above 5 is left for buildWaterSurfaceMaterial to report honestly',
      resolveGatedWaterTier(99) === 99
    );
  }
}
