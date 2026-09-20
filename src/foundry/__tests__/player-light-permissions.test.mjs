/**
 * Node verification for foundry/player-light-permissions.js. Only the pure
 * defaults/merge (`defaultPlayerLightPermissions`, `resolvePlayerLightPermissions`)
 * are testable here — `readScenePlayerLightPermissions`/
 * `writeScenePlayerLightPermissions`/`watchScenePlayerLightPermissions` all
 * touch live `canvas.scene`/`Hooks`, browser-only, same split every other
 * live reader in this zone follows (see `sky-persistence.js`'s own sibling
 * test, or the lack of one, for the same reason).
 */
import {
  defaultPlayerLightPermissions,
  resolvePlayerLightPermissions,
  PLAYER_LIGHT_MODE_KEYS,
} from '../player-light-permissions.js';

export function run(t) {
  const { ok } = t;

  // ---- defaults: an unconfigured scene must change nothing visible --------
  const defaults = defaultPlayerLightPermissions();
  ok(
    'every declared mode key defaults to allowed',
    PLAYER_LIGHT_MODE_KEYS.every((k) => defaults.modes[k] === true)
  );
  ok('players can choose their own mode by default', defaults.playersCanChooseMode === true);
  ok('darkness realism defaults to 0 (Foundry parity)', defaults.darknessRealism01 === 0);

  // ---- resolvePlayerLightPermissions: absent/null storage -----------------
  ok('null resolves to the defaults', JSON.stringify(resolvePlayerLightPermissions(null)) === JSON.stringify(defaults));
  ok(
    'undefined resolves to the defaults',
    JSON.stringify(resolvePlayerLightPermissions(undefined)) === JSON.stringify(defaults)
  );

  // ---- a partial, real-world patch ------------------------------------
  {
    const resolved = resolvePlayerLightPermissions({ modes: { torch: false } });
    ok('an explicit false is honored', resolved.modes.torch === false);
    ok('an unmentioned mode still defaults true', resolved.modes.flashlight === true);
    ok('playersCanChooseMode still defaults true when absent', resolved.playersCanChooseMode === true);
  }

  // ---- corrupt/legacy data never propagates undefined ----------------
  {
    const resolved = resolvePlayerLightPermissions({
      modes: { torch: 'yes', flashlight: 1, nightVision: false }, // non-boolean junk + one real value
      darknessRealism01: 'not a number',
    });
    ok('a non-boolean stored mode value is ignored, defaulting true', resolved.modes.torch === true);
    ok('a non-boolean truthy stored mode value is ignored, defaulting true', resolved.modes.flashlight === true);
    ok('a real boolean stored value is honored', resolved.modes.nightVision === false);
    ok('a non-numeric darknessRealism01 falls back to the default (0)', resolved.darknessRealism01 === 0);
  }

  // ---- darknessRealism01 is clamped to [0,1] ---------------------------
  ok(
    'darknessRealism01 clamps above 1',
    resolvePlayerLightPermissions({ darknessRealism01: 5 }).darknessRealism01 === 1
  );
  ok(
    'darknessRealism01 clamps below 0',
    resolvePlayerLightPermissions({ darknessRealism01: -5 }).darknessRealism01 === 0
  );
  ok(
    'darknessRealism01 passes a legitimate mid-range value through unchanged',
    resolvePlayerLightPermissions({ darknessRealism01: 0.6 }).darknessRealism01 === 0.6
  );

  // ---- a totally unrelated stray key on `modes` is ignored, not stored -----
  {
    const resolved = resolvePlayerLightPermissions({ modes: { torch: true, someStaleKeyFromAnOldBuild: true } });
    ok('a stray/unknown mode key is dropped, not carried through', !('someStaleKeyFromAnOldBuild' in resolved.modes));
  }
}
