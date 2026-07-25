/**
 * SKY SETTINGS — per-world by default, per-scene by opt-in.
 *
 * The precedence assertions matter more than they look: V2 had "seven homes per
 * weather value" with per-field precedence nobody could hold in their head, and
 * the cure here is that there are exactly TWO possible answers and the resolve
 * says which one it gave.
 */
import { resolveSky, applySkyEdit, normalizeSky, DEFAULT_SKY } from '../sky-settings.js';

export function run(t) {
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
}
