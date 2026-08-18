/**
 * `readCombatActive` has no pure sub-piece to extract (unlike `game-time.js`'s
 * `deriveHourFromComponents`) — it is Foundry-touching throughout, so it is
 * Node-tested only as far as CONVENTIONS.md §4 says a live-verified module
 * legitimately can be: the "no Foundry" branch, which is the REAL, exercised
 * behaviour in this Node environment (no `game` global exists here), and the
 * exact scenario the torture fixture hits running without Foundry at all.
 */
import { readCombatActive } from '../combat-state.js';

export function run(t) {
  t.ok(
    'never throws with no Foundry globals present',
    (() => {
      try {
        readCombatActive();
        return true;
      } catch {
        return false;
      }
    })()
  );

  const r = readCombatActive();
  t.ok('with no game global, reads active:false (the permissive default)', r.active === false);
  t.ok(
    '...and says WHY, honestly, rather than a bare false',
    r.source === 'default' && typeof r.reason === 'string' && r.reason.length > 0
  );
}
