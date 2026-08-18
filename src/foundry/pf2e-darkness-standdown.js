/**
 * THE PF2E DARKNESS STAND-DOWN — Almanac Testament §6.4: entering `almanac`
 * posture on a scene where PF2E's own World Clock is driving darkness must
 * end with exactly ONE darkness writer (MSA's, already LIVE — see
 * `foundry/scene-environment.js#publishSceneDarkness`), never two silently
 * fighting, and never a silent flag flip either. This file is the detect
 * half AND the (separately called, GM-gated) write half of that flow.
 *
 * ============================================================================
 * THE READ — mirrors PF2E's OWN `Scene#darknessSyncedToTime` getter exactly
 * ============================================================================
 *
 * Receipted against the shipped `pf2e.mjs` (Almanac Testament §3.2):
 * `get darknessSyncedToTime(){return this.flags.pf2e.syncDarkness==="enabled"
 * ||this.flags.pf2e.syncDarkness==="default"&&game.pf2e.settings.worldClock
 * .syncDarkness}` — a per-scene flag (`'enabled'|'disabled'|'default'`) that
 * WINS outright when it says `'enabled'`/`'disabled'`, and only falls back to
 * the world-level `pf2e.worldClock.syncDarkness` setting when the scene has
 * not opinion of its own (`'default'`, or simply absent). This module
 * reproduces that exact precedence — not a guess at PF2E's intent, the same
 * logic, read from the same source `calendar-install.js` already trusts for
 * `pf2e.worldClock`.
 *
 * ============================================================================
 * THE WRITE — the one legal way to silence it
 * ============================================================================
 *
 * `standDownPf2eDarknessSync` sets the SCENE flag to `'disabled'` — an
 * explicit per-scene override that wins regardless of the world setting,
 * exactly the lever the Testament names (§6.4: *"sets `flags.pf2e.
 * syncDarkness = 'disabled'` on that scene"*). It NEVER fires from the read
 * function above, or from anywhere inside this module — it is a separate,
 * deliberately-called, GM-gated function, which is what makes it the
 * "consent" gesture rather than an automatic reaction.
 *
 * @module foundry/pf2e-darkness-standdown
 */
import { readIsGM } from './scene-vision.js';
import { readSetting } from './settings-adapter.js';

const PF2E_NAMESPACE = 'pf2e';
const DARKNESS_FLAG = 'syncDarkness';

/** @returns {object|null} the live, ready scene — or null, never throws. */
function activeScene() {
  const c = globalThis.canvas;
  return c && c.ready && c.scene ? c.scene : null;
}

/**
 * THE PURE PRECEDENCE RULE, split out so the actual DECISION is Node-tested
 * rather than only ever exercised by hoping a live Foundry read happens to
 * combine correctly. Mirrors PF2E's own getter exactly (this module's header
 * has the receipt).
 * @param {'enabled'|'disabled'|'default'|null|undefined} sceneFlagValue
 * @param {boolean} worldSyncDarkness
 * @returns {boolean}
 */
export function isPf2eDarknessSyncActive(sceneFlagValue, worldSyncDarkness) {
  return sceneFlagValue === 'enabled' || ((sceneFlagValue ?? 'default') === 'default' && worldSyncDarkness === true);
}

/**
 * Is pf2e's own darkness-sync effectively active on the CURRENT scene right
 * now? Never throws. A missing scene or an inactive pf2e system are both
 * ordinary, confirmed answers (`active: false`), not failures — only an
 * actual read exception is reported as one.
 *
 * @returns {{ok: true, active: boolean, pf2eActive: boolean, sceneFlagValue: 'enabled'|'disabled'|'default'|null}|{ok: false, reason: string}}
 */
export function readPf2eDarknessSyncStatus() {
  try {
    if (typeof game === 'undefined' || game?.system?.id !== 'pf2e') {
      return { ok: true, active: false, pf2eActive: false, sceneFlagValue: null };
    }
    const scene = activeScene();
    if (!scene) {
      return { ok: true, active: false, pf2eActive: true, sceneFlagValue: null };
    }
    const sceneFlagValue = scene.getFlag?.(PF2E_NAMESPACE, DARKNESS_FLAG) ?? 'default';
    let worldSyncDarkness = false;
    try {
      worldSyncDarkness = readSetting(PF2E_NAMESPACE, 'worldClock')?.syncDarkness === true;
    } catch {
      worldSyncDarkness = false; // pf2e's own setting genuinely unreadable — treat as off, never crash the read
    }
    return {
      ok: true,
      active: isPf2eDarknessSyncActive(sceneFlagValue, worldSyncDarkness),
      pf2eActive: true,
      sceneFlagValue,
    };
  } catch (err) {
    return { ok: false, reason: `reading pf2e darkness sync status threw: ${err?.message ?? err}` };
  }
}

/**
 * Stand down pf2e's darkness sync on the CURRENT scene. GM-gated; the
 * caller (the diagnostic report's registered action, or a future Remote
 * consent dialog) supplies the "the GM deliberately clicked this" part —
 * this function supplies the "and it is safe/allowed" part.
 *
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function standDownPf2eDarknessSync() {
  if (!readIsGM()) {
    return { ok: false, reason: 'only a GM may stand down pf2e darkness sync' };
  }
  const scene = activeScene();
  if (!scene) {
    return { ok: false, reason: 'no active scene' };
  }
  try {
    await scene.setFlag(PF2E_NAMESPACE, DARKNESS_FLAG, 'disabled');
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `scene.setFlag threw: ${err?.message ?? err}` };
  }
}
