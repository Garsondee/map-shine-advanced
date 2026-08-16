/**
 * SKY SETTINGS — per-world by default, per-scene by opt-in.
 *
 * The precedence assertions matter more than they look: V2 had "seven homes per
 * weather value" with per-field precedence nobody could hold in their head, and
 * the cure here is that there are exactly TWO possible answers and the resolve
 * says which one it gave.
 */
import { resolveSky, applySkyEdit, normalizeSky, DEFAULT_SKY } from '../sky-settings.js';
import { WEATHER_AXIS_NAMES } from '../weather.js';
import { ARCHETYPE_OWNED_AXES } from '../weather-data.js';

export function run(t) {
  // ---- ⭐ WEATHER MUST SURVIVE A REFRESH (author-requested persistence) -------
  //
  // The store is a THIRD hand-maintained list of "what a weather is" (after the
  // axis table and the env snapshot), and it forgot the P1 axes: a shelf click
  // survived a reload because the archetype id carries its own precip, while a
  // hand-set shower or a cold map evaporated. The last assertion is the real
  // guard — it checks against `WEATHER_AXIS_NAMES` rather than a fourth copy of
  // the list, so the next axis added without wiring fails HERE.
  {
    const round = normalizeSky({ todHour: 3.5, precip01: 0.7, temperature01: 0.12, precipKindAuthored: 'snow' });
    t.ok('⭐ precip01 round-trips', round.precip01 === 0.7);
    t.ok('⭐ temperature01 round-trips — the ONLY thing that remembers a wintry map', round.temperature01 === 0.12);
    t.ok('⭐ the authored precip kind round-trips', round.precipKindAuthored === 'snow');
    t.ok('todHour still round-trips', round.todHour === 3.5);
    t.ok(
      'a defaulted sky is dry and temperate',
      normalizeSky({}).precip01 === 0 && normalizeSky({}).temperature01 === 0.55
    );
    t.ok(
      'an unknown stored kind fails open to auto, never storm-locking a species',
      normalizeSky({ precipKindAuthored: 'sleeeet' }).precipKindAuthored === 'auto'
    );
    t.ok(
      'out-of-range values clamp rather than reaching a uniform',
      normalizeSky({ precip01: 9 }).precip01 === 1 && normalizeSky({ temperature01: -3 }).temperature01 === 0
    );
    // ⚠️ THE INVARIANT IS "HAS A RESTORE PATH", NOT "IS IN THE STORE" — a first
    // cut asserted the latter and correctly fired on `cloudType01`/
    // `cloudAltitudePx`/`cloudScalePx`, which are ARCHETYPE-OWNED: the store
    // keeps the row's ID and `applyArchetype` restores all four cloud axes from
    // it, so storing them again would be the two-authorities bug
    // `DEFAULT_SKY.weatherArchetype` already warns about. Every axis must have
    // exactly one way home; this checks that none has NONE.
    const stranded = WEATHER_AXIS_NAMES.filter(
      (n) => normalizeSky({})[n] === undefined && !ARCHETYPE_OWNED_AXES.includes(n)
    );
    t.ok(
      `⭐ every WEATHER_AXES axis has a restore path — stored or archetype-owned (stranded: ${stranded.join(',') || 'none'})`,
      stranded.length === 0
    );
    t.ok(
      '...and the two that are NEITHER cloud-shape nor archetype-owned are the ones the store had to grow',
      normalizeSky({}).temperature01 !== undefined && !ARCHETYPE_OWNED_AXES.includes('temperature01')
    );
  }

  const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

  // ---- the default: one sky for the campaign -------------------------------
  {
    const r = resolveSky({});
    t.ok('with nothing stored, the world sky answers', r.source === 'world');
    t.ok('and it is the neutral default', r.sky.todHour === DEFAULT_SKY.todHour && r.sky.realism01 === 0);
    t.ok('the scene is not overriding', r.sceneOverrides === false);
    t.ok('the result is frozen', Object.isFrozen(r) && Object.isFrozen(r.sky));
  }

  {
    const world = { todHour: 21, cloudCover01: 0.8, realism01: 1 };
    const r = resolveSky({ world });
    t.ok('a world sky is used by every scene', r.sky.todHour === 21 && close(r.sky.cloudCover01, 0.8));
  }

  {
    // The load-bearing one: a scene's stored block is IGNORED until the toggle
    // is on. Otherwise an old experiment left on a scene would silently
    // override the campaign sky forever, with no visible cause.
    const world = { todHour: 12 };
    const scene = { todHour: 3, cloudCover01: 1 };
    const off = resolveSky({ world, scene, sceneOverrides: false });
    t.ok('a scene block with the toggle OFF is ignored entirely', off.sky.todHour === 12 && off.sky.cloudCover01 === 0);
    t.ok('and reports the world as its source', off.source === 'world');

    const on = resolveSky({ world, scene, sceneOverrides: true });
    t.ok('with the toggle ON the scene wins', on.sky.todHour === 3 && close(on.sky.cloudCover01, 1));
    t.ok('and says so', on.source === 'scene' && on.sceneOverrides === true);
  }

  {
    // Enabling the override must not visibly change anything until something is
    // actually edited — a scene that snapped to a hardcoded noon the moment you
    // ticked the box would look like a bug, not like an opt-in.
    const world = { todHour: 19.5, cloudCover01: 0.6, realism01: 1, mode: 'synced' };
    const before = resolveSky({ world });
    const after = resolveSky({ world, scene: {}, sceneOverrides: true });
    t.ok(
      'enabling the override inherits the world sky exactly',
      JSON.stringify(before.sky) === JSON.stringify(after.sky)
    );
    t.ok('...but the scope has genuinely changed', before.source === 'world' && after.source === 'scene');
  }

  {
    // A partial scene block layers over the world's values, so a scene that
    // only wants its own HOUR keeps the campaign's weather.
    const world = { todHour: 12, cloudCover01: 0.9, realism01: 1 };
    const r = resolveSky({ world, scene: { todHour: 2 }, sceneOverrides: true });
    t.ok('a partial scene block keeps the world weather', close(r.sky.cloudCover01, 0.9));
    t.ok('while owning its own hour', r.sky.todHour === 2);
  }

  // ---- edits go to whichever scope is in force ------------------------------
  {
    const world = { todHour: 12, realism01: 1 };
    const toWorld = applySkyEdit({ world }, { todHour: 8 });
    t.ok('with no override, an edit targets the WORLD', toWorld.target === 'world');
    t.ok('and carries the whole block, not a diff', toWorld.sky.realism01 === 1 && toWorld.sky.todHour === 8);

    const toScene = applySkyEdit({ world, scene: { cloudCover01: 0.5 }, sceneOverrides: true }, { todHour: 8 });
    t.ok('with the override on, the SAME edit targets the scene', toScene.target === 'scene');
    t.ok('and preserves what the scene already had', close(toScene.sky.cloudCover01, 0.5));
    t.ok('...and what it inherited', toScene.sky.realism01 === 1);
  }

  {
    const r = applySkyEdit({}, { cloudCover01: 5, todHour: -3 });
    t.ok('an edit is normalised on the way in — cloud clamps', r.sky.cloudCover01 === 1);
    t.ok('...and the hour wraps', r.sky.todHour === 21);
  }

  // ---- normalisation: one bad field must not discard a scene's work --------
  {
    const messy = normalizeSky({
      mode: 'nonsense',
      todHour: 'quarter past',
      rateHoursPerMinute: 1e9,
      cloudCover01: -4,
      realism01: null,
    });
    t.ok('an unknown mode falls back', messy.mode === 'aesthetic');
    t.ok('a non-numeric hour falls back to noon', messy.todHour === 12);
    t.ok('an absurd rate clamps', messy.rateHoursPerMinute === 60);
    t.ok('a negative cloud clamps', messy.cloudCover01 === 0);
    t.ok('a null realism falls back to PARITY, never to the model', messy.realism01 === 0);
  }

  {
    // Field-independent fallback: one corrupt value must not take the rest with
    // it. A scene losing its authored 19:30 dusk because someone hand-edited a
    // cloud value into a string would be a real loss of the author's work.
    const partlyBroken = normalizeSky({ todHour: 19.5, cloudCover01: 'very' });
    t.ok('the good field survives a bad neighbour', close(partlyBroken.todHour, 19.5));
    t.ok('and the bad one falls back alone', partlyBroken.cloudCover01 === 0);
  }

  {
    t.ok(
      'garbage input yields the full default block',
      JSON.stringify(normalizeSky(42)) === JSON.stringify(DEFAULT_SKY)
    );
    t.ok('as does nothing at all', JSON.stringify(normalizeSky()) === JSON.stringify(DEFAULT_SKY));
    t.ok('the block is frozen', Object.isFrozen(normalizeSky({})));
  }

  {
    // The default that protects the Foundry-parity property. If this ever flips,
    // every existing scene changes appearance on upgrade.
    t.ok('realism defaults to 0 — exact Foundry parity', DEFAULT_SKY.realism01 === 0);
    t.ok('and time does not drift by default', DEFAULT_SKY.rateHoursPerMinute === 0);
    t.ok('the env GRADE ships neutral too', DEFAULT_SKY.gradeEnvStrength === 0);
  }

  {
    // The env-grade strength rides the SAME per-world/per-scene resolution as
    // the sky. (The ARTISTIC grade is a separate effect now — one home, not a
    // second `lookPreset` field here.)
    const world = { gradeEnvStrength: 0.6 };
    const off = resolveSky({ world });
    t.ok('the world env grade is used by every scene', close(off.sky.gradeEnvStrength, 0.6));

    const on = resolveSky({ world, scene: { gradeEnvStrength: 0.9 }, sceneOverrides: true });
    t.ok('a scene can override the env grade strength', close(on.sky.gradeEnvStrength, 0.9));

    const edit = applySkyEdit({ world }, { gradeEnvStrength: 0.3 });
    t.ok(
      'a grade edit targets the world with no override',
      edit.target === 'world' && close(edit.sky.gradeEnvStrength, 0.3)
    );

    const messy = normalizeSky({ gradeEnvStrength: 5 });
    t.ok('an out-of-range env strength clamps', messy.gradeEnvStrength === 1);
  }

  // ---- THE NAMED SKY (weather manager slice 2) --------------------------------
  // `weatherArchetype` and `cloudCover01` are NOT two copies of one fact —
  // exactly one is authoritative at a time. These pin that contract, because the
  // failure mode if it slips is a scene that reloads claiming to be `overcast`
  // while sitting at cover 0.2.
  {
    t.ok('a fresh sky is `clear`, matching DEFAULT_WEATHER', DEFAULT_SKY.weatherArchetype === 'clear');

    t.ok(
      'a real archetype id survives normalisation',
      normalizeSky({ weatherArchetype: 'thunderstorm' }).weatherArchetype === 'thunderstorm'
    );
    t.ok(
      '`custom` is a legal stored value — it is the one state cover must describe',
      normalizeSky({ weatherArchetype: 'custom' }).weatherArchetype === 'custom'
    );

    // Fail OPEN at the STORAGE boundary, so a bad value never reaches the
    // manager at all — a scene stored by a future version with a sky this build
    // does not know must open, not storm-lock.
    t.ok(
      'an unknown id falls back to clear',
      normalizeSky({ weatherArchetype: 'hurricane-of-frogs' }).weatherArchetype === 'clear'
    );
    t.ok(
      '...as do non-strings',
      normalizeSky({ weatherArchetype: 42 }).weatherArchetype === 'clear' &&
        normalizeSky({ weatherArchetype: null }).weatherArchetype === 'clear'
    );

    // One corrupt field must not discard the rest of an authored sky.
    const partial = normalizeSky({ weatherArchetype: 'nope', todHour: 19.5, cloudCover01: 0.4 });
    t.ok(
      'a bad archetype leaves the hour and cover intact',
      partial.todHour === 19.5 && close(partial.cloudCover01, 0.4)
    );

    // It rides the SAME world/scene precedence as everything else here.
    const scoped = resolveSky({
      world: { weatherArchetype: 'fog' },
      scene: { weatherArchetype: 'gale' },
      sceneOverrides: true,
    });
    t.ok('a scene can own its own sky name', scoped.sky.weatherArchetype === 'gale');
    t.ok(
      '...and inherits the world sky when it does not',
      resolveSky({ world: { weatherArchetype: 'fog' } }).sky.weatherArchetype === 'fog'
    );

    const edit = applySkyEdit({ world: {} }, { weatherArchetype: 'snow' });
    t.ok(
      'an archetype edit targets the world with no override',
      edit.target === 'world' && edit.sky.weatherArchetype === 'snow'
    );
  }

  // ---- THE ALMANAC'S OWN FIELDS (weather manager slice 3 UI) --------------------
  {
    t.ok(
      'a fresh sky is director mode with no biome',
      DEFAULT_SKY.weatherMode === 'director' && DEFAULT_SKY.weatherBiome === null
    );

    t.ok('a real mode survives normalisation', normalizeSky({ weatherMode: 'almanac' }).weatherMode === 'almanac');
    t.ok('an unknown mode falls back to director', normalizeSky({ weatherMode: 'chaos' }).weatherMode === 'director');

    t.ok('a real biome id survives normalisation', normalizeSky({ weatherBiome: 'desert' }).weatherBiome === 'desert');
    t.ok(
      '`null` is a LEGAL stored value — no biome chosen is honest, not an error',
      normalizeSky({ weatherBiome: null }).weatherBiome === null
    );
    t.ok(
      'an unknown biome id fails open to null, never keeps a fake/stale climate',
      normalizeSky({ weatherBiome: 'atlantis' }).weatherBiome === null
    );
    t.ok('undefined also resolves to no biome', normalizeSky({}).weatherBiome === null);

    t.ok('volatility clamps to the max', normalizeSky({ weatherVolatility: 999 }).weatherVolatility === 4);
    t.ok('volatility clamps to the min', normalizeSky({ weatherVolatility: 0.001 }).weatherVolatility === 0.25);
    t.ok('a garbage volatility falls back to 1', normalizeSky({ weatherVolatility: 'fast' }).weatherVolatility === 1);

    // One corrupt Almanac field must not discard the rest of an authored sky —
    // same independent-fallback contract every other field here already has.
    const partial = normalizeSky({ weatherMode: 'nonsense', weatherBiome: 'desert', weatherVolatility: 2 });
    t.ok(
      'a bad mode leaves biome and volatility intact',
      partial.weatherMode === 'director' && partial.weatherBiome === 'desert' && partial.weatherVolatility === 2
    );

    // Rides the SAME world/scene precedence as everything else.
    const scoped = resolveSky({
      world: { weatherMode: 'almanac', weatherBiome: 'desert' },
      scene: { weatherMode: 'almanac', weatherBiome: 'boreal-tundra' },
      sceneOverrides: true,
    });
    t.ok('a scene can walk a different climate than the world', scoped.sky.weatherBiome === 'boreal-tundra');
    t.ok(
      '...and inherits the world climate when it does not',
      resolveSky({ world: { weatherMode: 'almanac', weatherBiome: 'desert' } }).sky.weatherBiome === 'desert'
    );

    const edit = applySkyEdit({ world: {} }, { weatherMode: 'almanac', weatherBiome: 'tropical-monsoon' });
    t.ok(
      'an Almanac edit targets the world with no override, and both fields land together',
      edit.target === 'world' && edit.sky.weatherMode === 'almanac' && edit.sky.weatherBiome === 'tropical-monsoon'
    );
  }
}
