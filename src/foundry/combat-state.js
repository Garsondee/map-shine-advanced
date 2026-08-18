/**
 * THE COMBAT-STATE READER — the one place `game.combat` is read, for the Pen's
 * "combat holds the pen" gate (Almanac Testament §6.5: *"While an encounter
 * runs, core itself advances 6 s/round under pf2e; gestures are disabled..."*).
 *
 * `game.combat?.started` is the exact property this project has already
 * verified from a real source — not this project's own code, but PF2E's own
 * shipped bundle, read during the Almanac Testament's A0 research and still
 * sitting in this session's own receipts: `Hooks.on("updateWorldTime",
 * async(_total,diff)=>{game.combat?.started||game.pf2e.effectTracker.refresh(
 * ...)` (pf2e.mjs, quoted in `docs/holy/Almanac-Testament.md` §3.2). Reusing a
 * property PF2E itself gates real behaviour on is a stronger receipt than
 * this project could produce by reading Foundry core alone.
 *
 * A snapshot reader only, no watcher — the Pen checks combat state at the
 * moment of a gesture (`time-authority.js#advance`), which needs a point-in-
 * time answer, not a subscription. Nothing in this Testament stage needs a
 * live "combat just started" push; adding one on spec would be exactly the
 * unrequested-feature drift this project's own doctrine warns against.
 *
 * @module foundry/combat-state
 */

/**
 * Is an encounter currently running?
 *
 * `game.combat == null` (no encounter at all) is a CONFIRMED, ordinary
 * answer — `active: false, source: 'game'` — not a read failure. Only an
 * unreadable/unexpected shape or a throw defaults to `source: 'default'`,
 * and even then to `active: false` (the PERMISSIVE side): the sibling
 * reader `readGamePaused` in `game-time.js` chose the same direction on
 * its own read failure, and for the same reason its own comment gives —
 * *"a false 'paused' would freeze every effect with no visible cause,
 * which is a far worse failure than a pause that quietly does not take."*
 * Here: a Pen gesture that goes through once, unexpectedly, during a combat
 * state this reader failed to see is a smaller failure than an astrolabe
 * that goes permanently unresponsive the moment `game.combat` is ever
 * momentarily unreadable, with no visible cause on the control.
 *
 * @returns {{active: boolean, source: 'game'|'default', reason: string|null}}
 */
export function readCombatActive() {
  try {
    if (typeof game === 'undefined' || !game) {
      return { active: false, source: 'default', reason: 'game is not available yet' };
    }
    const combat = game.combat;
    if (combat == null) {
      return { active: false, source: 'game', reason: null };
    }
    if (typeof combat.started !== 'boolean') {
      return { active: false, source: 'default', reason: 'game.combat.started was not a boolean' };
    }
    return { active: combat.started, source: 'game', reason: null };
  } catch (err) {
    return { active: false, source: 'default', reason: `reading game.combat threw: ${err?.message ?? err}` };
  }
}
