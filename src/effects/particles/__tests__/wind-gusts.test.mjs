/**
 * The WIND_GUSTS declaration is DATA, so it is proven valid in Node today —
 * before the ribbon engine renders a single trail. A malformed declaration is a
 * red test, not a blank screen discovered live. Wind Gusts is a SEPARATE effect
 * from the wind diagnostic particles (a real atmospheric dressing effect, not a
 * debug cloud), so these assertions also pin the differences that matter: a
 * weather.* namespace, a bounded active-trail range, a real flow-energy gate,
 * and a ring length the geometry/kernel both depend on.
 */
import { WIND_GUSTS as WG } from '../wind-gusts.js';
import { validateParticleSystem } from '../particle-system-schema.js';

export function run(t) {
  {
    const r = validateParticleSystem(WG);
    t.ok(`WIND_GUSTS validates against the schema${r.ok ? '' : ' — ' + r.errors.join('; ')}`, r.ok === true);
  }

  t.ok('WIND_GUSTS is namespaced under weather.* (a real effect, not diagnostic.*)', WG.id === 'weather.windGusts');
  t.ok('WIND_GUSTS is a DIFFERENT system from the diagnostic particles', WG.id !== 'diagnostic.windParticles');
  t.ok('WIND_GUSTS rides the wind field, declared as a read', WG.reads.includes('res:wind'));
  t.ok(
    'WIND_GUSTS samples wind through the door (smartWind behavior), not private noise',
    WG.behaviors.some((b) => b.type === 'smartWind')
  );

  // The ladder must be a real ladder (schema also checks; pinned here too).
  t.ok(
    'WIND_GUSTS tiers are contiguous from 0',
    WG.tiers.every((tier, i) => tier.n === i)
  );
  t.ok('WIND_GUSTS declares a tier 0 (absent) plus ribbon rungs above', WG.tiers.length >= 2);

  // Arena capacity the arena can actually reserve.
  t.ok('WIND_GUSTS reserves a positive, bounded capacity', WG.params.capacity > 0 && WG.params.capacity <= 1_000_000);

  // Ring length: the geometry vertex count AND the kernel's history stride both
  // read this, so it must be an integer >= 2 (a ribbon needs at least a head and
  // a tail) and no larger than the arena would make wasteful.
  t.ok('WIND_GUSTS declares an integer segments >= 2', Number.isInteger(WG.params.segments) && WG.params.segments >= 2);

  // "A few, more when windier": a real active-trail range, both positive, min <=
  // max, and max within capacity (else the count uniform would exceed drawable
  // instances).
  t.ok(
    'WIND_GUSTS declares a real active-trail range (0 < minTrails <= maxTrails)',
    WG.params.minTrails > 0 && WG.params.maxTrails >= WG.params.minTrails
  );
  t.ok('WIND_GUSTS maxTrails fits inside the reserved capacity', WG.params.maxTrails <= WG.params.capacity);

  // The flow-energy VISIBILITY gate — the whole "only where the flow is fast"
  // behaviour. A real smoothstep band: 0 <= flowLo < flowHi.
  t.ok(
    'WIND_GUSTS declares a real flow-energy gate band (0 <= flowLo < flowHi)',
    WG.params.flowLo >= 0 && WG.params.flowHi > WG.params.flowLo
  );

  // Ribbon look: a positive width and an opacity ceiling in (0, 1].
  t.ok('WIND_GUSTS declares a positive ribbon widthPx', WG.params.widthPx > 0);
  t.ok('WIND_GUSTS declares an opacityMax in (0, 1]', WG.params.opacityMax > 0 && WG.params.opacityMax <= 1);
  t.ok(
    'WIND_GUSTS declares a 3-channel colorRGB',
    Array.isArray(WG.params.colorRGB) && WG.params.colorRGB.length === 3
  );

  // Shared physics knobs, same meaning as the diagnostic particles.
  t.ok('WIND_GUSTS declares a positive windGain', WG.params.windGain > 0);
  t.ok('WIND_GUSTS declares an outdoorGaleBoost above 1 (a real speed-up)', WG.params.outdoorGaleBoost > 1);
  t.ok('WIND_GUSTS declares a positive accelToMaxSeconds', WG.params.accelToMaxSeconds > 0);

  // Lifespan with non-overlapping fade windows (2 x fadeMs <= lifeMs).
  t.ok('WIND_GUSTS declares a positive lifeMs', WG.params.lifeMs > 0);
  t.ok('WIND_GUSTS declares a positive fadeMs', WG.params.fadeMs > 0);
  t.ok('WIND_GUSTS fade windows cannot overlap (2 x fadeMs <= lifeMs)', WG.params.fadeMs * 2 <= WG.params.lifeMs);

  // Respawn bias needs at least one candidate.
  t.ok(
    'WIND_GUSTS declares an integer respawnCandidates >= 1',
    Number.isInteger(WG.params.respawnCandidates) && WG.params.respawnCandidates >= 1
  );

  // windStructureGain/doorChaosBoost are GONE (2026-07-22, THE RETHINK —
  // docs/planning/Wind-Rethink.md §4): the wall-relaxation and door-proximity
  // chaos wobble they tuned are both deleted, not just untested — pin their
  // absence so a stray re-add doesn't silently resurrect a dead mechanism.
  t.ok(
    'WIND_GUSTS no longer declares windStructureGain or doorChaosBoost (both mechanisms deleted)',
    !('windStructureGain' in WG.params) && !('doorChaosBoost' in WG.params)
  );
}
