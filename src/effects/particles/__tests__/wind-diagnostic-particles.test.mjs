/**
 * The WIND_DIAGNOSTIC_PARTICLES declaration is DATA, so it is proven valid in
 * Node today — before the engine renders a single mote. A malformed first
 * system is a red test, not a blank screen discovered live (the posture the
 * schema/arena/wind-contributor all already take). Renamed from `dust.js`/
 * `DUST` (2026-07-22) — this is a debug-only wind visualization, not the
 * mansion's future ambient-dust dressing effect.
 */
import { WIND_DIAGNOSTIC_PARTICLES as WDP } from '../wind-diagnostic-particles.js';
import { validateParticleSystem } from '../particle-system-schema.js';

export function run(t) {
  {
    const r = validateParticleSystem(WDP);
    t.ok(
      `WIND_DIAGNOSTIC_PARTICLES validates against the schema${r.ok ? '' : ' — ' + r.errors.join('; ')}`,
      r.ok === true
    );
  }

  t.ok(
    'WIND_DIAGNOSTIC_PARTICLES id is namespaced under diagnostic.*, not weather.*',
    WDP.id === 'diagnostic.windParticles'
  );
  t.ok('WIND_DIAGNOSTIC_PARTICLES rides the wind field, declared as a read', WDP.reads.includes('res:wind'));
  t.ok(
    'WIND_DIAGNOSTIC_PARTICLES samples wind through the door (smartWind behavior), not private noise',
    WDP.behaviors.some((b) => b.type === 'smartWind')
  );

  // The ladder must be a real ladder (schema also checks this, but the first
  // system is the one whose tier-0 specialness is easiest to get wrong).
  t.ok(
    'WIND_DIAGNOSTIC_PARTICLES tiers are contiguous from 0',
    WDP.tiers.every((tier, i) => tier.n === i)
  );
  t.ok('WIND_DIAGNOSTIC_PARTICLES declares a tier 0 (the cheap stand-in) plus mote rungs above', WDP.tiers.length >= 2);

  // Params are the author's taste, carried as data for the engine to read as
  // uniforms — a sane capacity the arena can actually reserve.
  t.ok(
    'WIND_DIAGNOSTIC_PARTICLES reserves a positive, bounded capacity',
    WDP.params.capacity > 0 && WDP.params.capacity <= 1_000_000
  );
  t.ok('WIND_DIAGNOSTIC_PARTICLES declares a positive windGain', WDP.params.windGain > 0);

  // Random size + opacity (2026-07-22): a real range, min < max, opacityMax
  // at the author's own explicit ceiling ("opacity 80% at max").
  t.ok(
    'WIND_DIAGNOSTIC_PARTICLES declares a real size range (min < max, both positive)',
    WDP.params.sizeMinPx > 0 && WDP.params.sizeMaxPx > WDP.params.sizeMinPx
  );
  t.ok(
    'WIND_DIAGNOSTIC_PARTICLES declares a real opacity range (min < max, both in 0..1)',
    WDP.params.opacityMin >= 0 && WDP.params.opacityMax > WDP.params.opacityMin && WDP.params.opacityMax <= 1
  );
  t.ok('WIND_DIAGNOSTIC_PARTICLES opacityMax is 80% as requested', WDP.params.opacityMax === 0.8);

  // The lifespan rung (2026-07-22): a 6s life with 2s fades at both ends, so
  // the fade windows can never overlap — a life shorter than 2×fade would dip
  // below full opacity in the steady middle, which is not "fade at both ends".
  t.ok('WIND_DIAGNOSTIC_PARTICLES declares a positive lifeMs', WDP.params.lifeMs > 0);
  t.ok('WIND_DIAGNOSTIC_PARTICLES declares a positive fadeMs', WDP.params.fadeMs > 0);
  t.ok(
    'WIND_DIAGNOSTIC_PARTICLES fade windows cannot overlap (2 x fadeMs <= lifeMs)',
    WDP.params.fadeMs * 2 <= WDP.params.lifeMs
  );
  t.ok('WIND_DIAGNOSTIC_PARTICLES lifeMs is 6 seconds as requested', WDP.params.lifeMs === 6000);
  t.ok('WIND_DIAGNOSTIC_PARTICLES fadeMs is 2 seconds as requested', WDP.params.fadeMs === 2000);

  // Real-unit wind speed + acceleration (2026-07-22): no more windSpeedScale
  // (superseded by particle-runtime.js's GALE_MPS calibration, which needs
  // pxPerMeter — a runtime-only value, not something this DATA declaration
  // carries). outdoorSpeedBoost now defaults to a no-op (1) since the base
  // scale is physically real.
  t.ok('WIND_DIAGNOSTIC_PARTICLES no longer declares the superseded windSpeedScale', !('windSpeedScale' in WDP.params));
  t.ok(
    'WIND_DIAGNOSTIC_PARTICLES neutralizes outdoorSpeedBoost by default (1 = no-op)',
    WDP.params.outdoorSpeedBoost === 1
  );
  t.ok('WIND_DIAGNOSTIC_PARTICLES declares a positive accelToMaxSeconds', WDP.params.accelToMaxSeconds > 0);

  // Coherent/chaotic split (item 28, 2026-07-22, replaces fix-20's
  // indoorStillness): a sheltered position gates the compass-heading push
  // toward 0 and BOOSTS the undirected noise/drift terms instead, so this
  // param is a boost factor now, not a damping fraction.
  t.ok('WIND_DIAGNOSTIC_PARTICLES no longer declares the retired indoorStillness', !('indoorStillness' in WDP.params));
  t.ok('WIND_DIAGNOSTIC_PARTICLES declares a positive indoorChaosBoost', WDP.params.indoorChaosBoost > 0);

  // Item 29 tuning (2026-07-22): indoor chaos halved (4 -> 2), and a new
  // outdoorGaleBoost (2) that speeds the coherent/outdoor push WITHOUT
  // touching the chaos term — so it must be a real >1 multiplier to mean
  // anything, and indoorChaosBoost must be the halved value the author asked
  // for.
  t.ok('WIND_DIAGNOSTIC_PARTICLES indoorChaosBoost was halved to 2 (item 29)', WDP.params.indoorChaosBoost === 2);
  t.ok(
    'WIND_DIAGNOSTIC_PARTICLES declares an outdoorGaleBoost above 1 (a real speed-up, not a no-op)',
    WDP.params.outdoorGaleBoost > 1
  );
  t.ok('WIND_DIAGNOSTIC_PARTICLES outdoorGaleBoost is 2x as requested', WDP.params.outdoorGaleBoost === 2);

  // Stall-death: built, then REVERTED same day — author-confirmed live it
  // killed every particle (spawns at velocity 0, then genuinely spends real
  // time ramping up once acceleration landed, misread as "stalled"). See
  // particle-runtime.js's checklist item 25.
  t.ok('WIND_DIAGNOSTIC_PARTICLES no longer declares the reverted deathSpeedMps', !('deathSpeedMps' in WDP.params));
  t.ok(
    'WIND_DIAGNOSTIC_PARTICLES no longer declares the reverted deathAgeMultiplier',
    !('deathAgeMultiplier' in WDP.params)
  );

  // windStructureGain/doorChaosBoost are GONE (2026-07-22, THE RETHINK —
  // docs/planning/Wind-Rethink.md §4): the wall-relaxation and door-proximity
  // chaos wobble they tuned are both deleted, not just untested — pin their
  // absence so a stray re-add doesn't silently resurrect a dead mechanism.
  t.ok(
    'WIND_DIAGNOSTIC_PARTICLES no longer declares windStructureGain or doorChaosBoost (both mechanisms deleted)',
    !('windStructureGain' in WDP.params) && !('doorChaosBoost' in WDP.params)
  );
}
