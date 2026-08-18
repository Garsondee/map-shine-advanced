/**
 * The precedence rule PF2E's own `Scene#darknessSyncedToTime` getter uses,
 * reproduced and Node-tested — the receipt is in the module's own header.
 * Plus the one branch of `readPf2eDarknessSyncStatus` this Node environment
 * actually exercises (no `game` global at all), same discipline as
 * `combat-state.test.mjs`.
 */
import { isPf2eDarknessSyncActive, readPf2eDarknessSyncStatus } from '../pf2e-darkness-standdown.js';

export function run(t) {
  // ---- the pure precedence rule --------------------------------------------
  t.ok("scene 'enabled' wins outright, world setting off", isPf2eDarknessSyncActive('enabled', false) === true);
  t.ok("scene 'enabled' wins outright, world setting on too", isPf2eDarknessSyncActive('enabled', true) === true);
  t.ok(
    "scene 'disabled' wins outright even if the world setting is on",
    isPf2eDarknessSyncActive('disabled', true) === false
  );
  t.ok("scene 'default' + world ON -> active", isPf2eDarknessSyncActive('default', true) === true);
  t.ok("scene 'default' + world OFF -> inactive", isPf2eDarknessSyncActive('default', false) === false);
  t.ok('an absent scene flag behaves exactly like "default"', isPf2eDarknessSyncActive(undefined, true) === true);
  t.ok('null also behaves like "default"', isPf2eDarknessSyncActive(null, false) === false);
  t.ok('a non-boolean "world setting" never reads as true', isPf2eDarknessSyncActive('default', 'yes') === false);

  // ---- the no-Foundry branch (the real behaviour in this environment) -----
  t.ok(
    'never throws with no Foundry globals present',
    (() => {
      try {
        readPf2eDarknessSyncStatus();
        return true;
      } catch {
        return false;
      }
    })()
  );
  const r = readPf2eDarknessSyncStatus();
  t.ok(
    'with no game global, reports pf2e as not active (an honest, confirmed answer)',
    r.ok === true && r.pf2eActive === false && r.active === false
  );
}
