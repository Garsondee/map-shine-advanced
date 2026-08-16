/**
 * THE ARCHETYPE TABLE (docs/planning/Weather-Manager.md §3.2).
 *
 * What is proven here:
 *   - the table is a genuinely CLOSED, frozen list with no malformed rows;
 *   - every row is DISTINGUISHABLE from every other, so `matchArchetype` can
 *     never light two buttons or the wrong one;
 *   - unknown ids fail OPEN to clear and SAY SO (never storm-lock a scene);
 *   - the label is derived from the axes, so it cannot describe a sky that is
 *     no longer there.
 */
import {
  WEATHER_ARCHETYPES,
  WEATHER_ARCHETYPE_IDS,
  DEFAULT_ARCHETYPE_ID,
  CUSTOM_PRESET,
  resolveArchetype,
  isApplicableArchetype,
  matchArchetype,
  ARCHETYPE_OWNED_AXES,
} from '../weather-data.js';
import { createWeatherManager, WEATHER_AXES, WEATHER_AXIS_NAMES, DEFAULT_PRESET } from '../weather.js';

export function run(t) {
  // ---- the table's own shape --------------------------------------------------
  {
    t.ok(
      'the table is frozen, rows and all',
      Object.isFrozen(WEATHER_ARCHETYPES) && Object.isFrozen(WEATHER_ARCHETYPES[0])
    );
    t.ok('ids are unique', new Set(WEATHER_ARCHETYPE_IDS).size === WEATHER_ARCHETYPE_IDS.length);
    t.ok('clear is the fallback and it is in the table', WEATHER_ARCHETYPE_IDS.includes(DEFAULT_ARCHETYPE_ID));
    t.ok(
      'every row carries id/label/icon/blurb/axes',
      WEATHER_ARCHETYPES.every((a) => a.id && a.label && a.icon && a.blurb && a.axes)
    );
    t.ok(
      'every row sets EVERY archetype-owned axis — a partial row would leave the sky half-changed',
      WEATHER_ARCHETYPES.every((a) => ARCHETYPE_OWNED_AXES.every((n) => Number.isFinite(a.axes[n])))
    );
    t.ok(
      'every axis value is inside that axis’s declared range',
      WEATHER_ARCHETYPES.every((a) =>
        ARCHETYPE_OWNED_AXES.every((n) => a.axes[n] >= WEATHER_AXES[n].min && a.axes[n] <= WEATHER_AXES[n].max)
      )
    );
    // ⚠️ AN ARCHETYPE IS A SKY, NOT A CLIMATE — so it deliberately does NOT set
    // `temperature01`. Weather-Manager.md §3.2's own note on the `snow` row
    // says it: *"precipKind derives `snow` from temperature — no separate
    // archetype table for winter"*. A `steady-rain` row that also forced the
    // map warm would make the shelf overwrite the biome's climate every click,
    // and picking `snow` in a desert would silently freeze it.
    t.ok(
      'no row sets temperature01 — that is climate, and the shelf must not overwrite it',
      WEATHER_ARCHETYPES.every((a) => a.axes.temperature01 === undefined)
    );
    t.ok(
      'ARCHETYPE_OWNED_AXES is a real subset of the axis table, not a stale copy',
      ARCHETYPE_OWNED_AXES.every((n) => WEATHER_AXIS_NAMES.includes(n)) &&
        ARCHETYPE_OWNED_AXES.length < WEATHER_AXIS_NAMES.length
    );
    // ⭐ THE PAYOFF: the wet rows actually carry precipitation, so a shelf click
    // rains rather than only greying the sky.
    t.ok(
      'the wet archetypes carry real precipitation',
      WEATHER_ARCHETYPES.find((a) => a.id === 'steady-rain').axes.precip01 > 0.5 &&
        WEATHER_ARCHETYPES.find((a) => a.id === 'thunderstorm').axes.precip01 > 0.7 &&
        WEATHER_ARCHETYPES.find((a) => a.id === 'drizzle').axes.precip01 > 0
    );
    t.ok(
      'and the dry ones carry none — a clear sky must not drizzle',
      ['clear', 'streaks', 'high-veil', 'fair-cumulus', 'mackerel', 'broken', 'overcast', 'gale', 'fog'].every(
        (id) => WEATHER_ARCHETYPES.find((a) => a.id === id).axes.precip01 === 0
      )
    );
    t.ok(
      'drizzle is genuinely lighter than steady rain, which is lighter than a thunderstorm',
      WEATHER_ARCHETYPES.find((a) => a.id === 'drizzle').axes.precip01 <
        WEATHER_ARCHETYPES.find((a) => a.id === 'steady-rain').axes.precip01 &&
        WEATHER_ARCHETYPES.find((a) => a.id === 'steady-rain').axes.precip01 <
          WEATHER_ARCHETYPES.find((a) => a.id === 'thunderstorm').axes.precip01
    );
    t.ok('no row is called `custom` — that is a label, not a sky', !WEATHER_ARCHETYPE_IDS.includes(CUSTOM_PRESET));
  }

  // ---- ⭐ every row is distinguishable ------------------------------------------
  // If two rows matched within tolerance, the shelf would light the wrong button
  // and `matchArchetype` would be picking by table order rather than by fact.
  {
    const collisions = [];
    for (const a of WEATHER_ARCHETYPES) {
      const matched = matchArchetype(a.axes);
      if (matched !== a.id) collisions.push(`${a.id}->${matched}`);
    }
    t.ok(`every archetype matches ITSELF (collisions: ${collisions.join(',') || 'none'})`, collisions.length === 0);
  }

  // ---- the shelf's ordering is information, not decoration ---------------------
  // Left-to-right = how much sky is in the way, so a GM scans by severity.
  {
    t.ok('the shelf starts at clear', WEATHER_ARCHETYPE_IDS[0] === 'clear');
    const cover = (id) => WEATHER_ARCHETYPES.find((a) => a.id === id).axes.cloudCover01;
    t.ok('clear really is the least cloud', cover('clear') === 0);
    t.ok('rain is heavier than fair', cover('steady-rain') > cover('fair-cumulus'));
    t.ok(
      'broken sits in the dramatic middle band (contrast peaks near 0.5-0.65)',
      cover('broken') >= 0.5 && cover('broken') <= 0.7
    );
  }

  // ---- resolve: fail OPEN, and say so ------------------------------------------
  {
    const good = resolveArchetype('overcast');
    t.ok('a known id resolves', good.ok === true && good.archetype.id === 'overcast');
    t.ok('...with no reason attached', good.reason === null);

    const bad = resolveArchetype('hurricane-of-frogs');
    t.ok('an unknown id FAILS OPEN to clear — never storm-locks a scene', bad.archetype.id === 'clear');
    t.ok('...but reports ok:false', bad.ok === false);
    t.ok('...and names the actual id in the reason', String(bad.reason).includes('hurricane-of-frogs'));

    t.ok(
      'null/undefined/garbage all fail open',
      resolveArchetype(null).archetype.id === 'clear' &&
        resolveArchetype(undefined).archetype.id === 'clear' &&
        resolveArchetype(42).archetype.id === 'clear'
    );
    t.ok(
      '`custom` is refused with its own explanation',
      resolveArchetype(CUSTOM_PRESET).ok === false && String(resolveArchetype(CUSTOM_PRESET).reason).includes('label')
    );

    t.ok('isApplicableArchetype accepts real ids', isApplicableArchetype('fog') === true);
    t.ok('...and rejects custom', isApplicableArchetype(CUSTOM_PRESET) === false);
    t.ok('...and rejects nonsense', isApplicableArchetype('nope') === false && isApplicableArchetype(null) === false);
  }

  // ---- matchArchetype ------------------------------------------------------------
  {
    t.ok(
      'a hand-tuned sky between rows is `custom`',
      matchArchetype({ cloudCover01: 0.47, cloudType01: 0.12, cloudAltitudePx: 1234, cloudScalePx: 987 }) ===
        CUSTOM_PRESET
    );
    t.ok(
      'garbage input is `custom`, not a crash',
      matchArchetype(null) === CUSTOM_PRESET && matchArchetype('nope') === CUSTOM_PRESET
    );
    t.ok('a missing axis cannot accidentally match', matchArchetype({ cloudCover01: 0 }) === CUSTOM_PRESET);

    // Round-tripping through JSON must not lose a sky's name.
    const clear = WEATHER_ARCHETYPES[0].axes;
    t.ok('a JSON round-trip still matches its row', matchArchetype(JSON.parse(JSON.stringify(clear))) === 'clear');
  }

  // ---- ⭐ the manager: the label is DERIVED, never remembered ---------------------
  {
    const mgr = createWeatherManager();
    t.ok('a fresh manager already knows it is clear', mgr.read().preset === DEFAULT_PRESET);

    const res = mgr.applyArchetype('overcast');
    t.ok('applyArchetype reports ok', res.ok === true && res.preset === 'overcast');
    t.ok(
      '...sets every axis as a TARGET',
      mgr.read().targets.cloudCover01 === 0.95 && mgr.read().targets.cloudAltitudePx === 700
    );
    t.ok('...and eases rather than jumping', mgr.read().state.cloudCover01 === 0 && mgr.read().settling === true);

    // The one that matters: hand-editing away from the row renames the sky.
    mgr.setTargets({ cloudCover01: 0.2 });
    t.ok('⭐ a hand edit off the row makes the label `custom` — it cannot lie', mgr.read().preset === CUSTOM_PRESET);
    t.ok('...and the snapshot carries the honest label', mgr.toSnapshotWeather().preset === CUSTOM_PRESET);

    // And editing back onto a row re-adopts its name.
    mgr.applyArchetype('fog');
    t.ok('applying another archetype renames it again', mgr.read().preset === 'fog');
    mgr.setTargets({ cloudCover01: WEATHER_ARCHETYPES.find((a) => a.id === 'fog').axes.cloudCover01 });
    t.ok('...and a no-op edit keeps the name', mgr.read().preset === 'fog');

    t.ok('there is deliberately no setPreset to make it lie', typeof mgr.setPreset === 'undefined');
  }

  // ---- applyArchetype: immediate (scene load) vs eased (a GM click) --------------
  {
    const load = createWeatherManager();
    load.applyArchetype('steady-rain', { immediate: true });
    t.ok('immediate lands the state at once', load.read().state.cloudCover01 === 1);
    t.ok('...and reports settled', load.read().settling === false);
    t.ok('...with the right label', load.read().preset === 'steady-rain');

    const click = createWeatherManager();
    click.applyArchetype('steady-rain');
    t.ok(
      'a click leaves the state behind to ease',
      click.read().state.cloudCover01 === 0 && click.read().targets.cloudCover01 === 1
    );
  }

  // ---- an unknown id at the manager level is still safe --------------------------
  {
    const mgr = createWeatherManager();
    mgr.applyArchetype('fog');
    const res = mgr.applyArchetype('not-a-sky');
    t.ok('a bad id reports ok:false', res.ok === false);
    t.ok('...and leaves the scene CLEAR rather than stuck under fog', mgr.read().targets.cloudCover01 === 0);
    t.ok('...with the reason preserved for a status report', String(res.reason).includes('not-a-sky'));
  }
}
