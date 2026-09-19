/**
 * WIND PERSISTENCE — where the live wind ambient (direction + strength) is
 * STORED, so a GM's drag on the astrolabe's wind dial (or a commit through
 * the Wind popover / the Sky Light channel's wind-strength slider) reaches
 * every OTHER connected client, not just the one that dragged it.
 *
 * mythica-machina-press#541 (found during the #288 GM-player sync audit,
 * under the #287 umbrella): every other scene/weather axis a GM can dial —
 * mode, biome, archetype, volatility, realism, temperature, precip — is
 * persisted and synced through `sky-persistence.js`. Wind ambient
 * (`windDirectionDeg`/`windSpeed01`, `boot.js#MapShine.setWind`) was the one
 * exception, living in bare module-level `let`s with no Foundry-synced store
 * at all: a GM's drag updated their OWN client's particles/fire/
 * precipitation/vegetation and nothing else, forever, with no error.
 *
 * #541's own design call (option 2 of the two it named): wind gets its OWN
 * small, parallel SCENE flag, narrowly scoped to exactly these two values —
 * NOT a third axis bolted onto `world/sky-settings.js#DEFAULT_SKY`. That
 * option was explicitly rejected: wind is not a weather axis (`boot.js`'s own
 * `onWindSpeed01Commit` wiring: "wind is not a weather axis and must never
 * stamp weatherArchetype:'custom'"), and widening the sky schema for it would
 * touch `normalizeSky`/`resolveSky`/`applySkyEdit` — and every one of their
 * own tests — for a value that has nothing to do with time-of-day or
 * precipitation. A narrow, additive, easy-to-reshape-later file is the same
 * kind of small piece this codebase has previously built straight from a
 * documented, reasoned design call rather than waiting on a second round of
 * formal sign-off first (#389's own history), so long as it stays small,
 * additive, and cheap to adjust if the shape turns out wrong.
 *
 * SCENE-scoped only — no world-level wind. Wind is a live-dialed, table/
 * session condition tied to the scene being played, the SAME reasoning
 * `fade-persistence.js`'s own header gives for having no world-level fade:
 * "a SESSION/table thing... unlike sky, there is no world-level [store]
 * here." A campaign-wide "default wind" is not a concept this bug asked for.
 *
 * The naming and posture still mirror `sky-persistence.js` exactly —
 * `readSceneX`/`writeSceneX`/`watchSceneX`, GM-only writes reporting
 * `{ok:false, reason}` rather than throwing, a `null` read meaning "nothing
 * stored" kept distinguishable from a real stored zero
 * (feedback_instruments_must_not_lie) — it is simply the ONE-store
 * (scene-only) shape `fade-persistence.js`/`effect-param-persistence.js`/
 * `cues-persistence.js` already use, not sky's own world+scene pair.
 *
 * ⚠️ WRITES ARE GM-ONLY, and that is Foundry's rule, not ours — `scene.
 * setFlag` rejects a non-GM. A player nudging a wind control they should
 * never see should see their OWN view unchanged and nothing thrown, never a
 * silently-dropped edit or an exception in the console.
 *
 * @module foundry/wind-persistence
 */

/** The module namespace this scene flag lives under. */
const WIND_NAMESPACE = 'map-shine-advanced';
/** The scene flag's key — `{directionDeg, speed01}`, the whole pair. */
const SCENE_WIND_FLAG = 'wind';

/**
 * Read the active scene's own wind ambient.
 * @returns {{wind: {directionDeg: number, speed01: number}|null, reason: string|null}}
 *   `wind: null` means "nothing stored yet" (or no active scene, or a read
 *   error) — the caller keeps whatever it already has in memory, which is a
 *   different thing from "stored as {directionDeg:0, speed01:0}" and stays
 *   distinguishable (feedback_instruments_must_not_lie).
 */
export function readSceneWind() {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { wind: null, reason: 'no active scene' };
    return { wind: scene.getFlag(WIND_NAMESPACE, SCENE_WIND_FLAG) ?? null, reason: null };
  } catch (err) {
    return { wind: null, reason: `reading the scene wind failed: ${err?.message ?? err}` };
  }
}

/**
 * Write the active scene's own wind ambient. GM-only.
 * @param {{directionDeg: number, speed01: number}} wind - the COMPLETE pair;
 *   callers merge onto their own current values first (`MapShine.setWind`'s
 *   own shape — the same "apply locally, then persist the whole resolved
 *   value" rule `boot.js#editSky` already follows for sky), never a partial
 *   patch here.
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeSceneWind(wind) {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { ok: false, reason: 'no active scene to write to' };
    await scene.setFlag(WIND_NAMESPACE, SCENE_WIND_FLAG, wind);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing the scene wind failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * Watch for another client's write to this scene's wind flag, so a second
 * GM's (or the same GM's second device's) edit reaches this one — mirrors
 * `sky-persistence.js#watchSceneSky` exactly, filtered to the active scene
 * and this module's own flag key.
 * @param {() => void} onChange
 * @returns {() => void} unsubscribe.
 */
export function watchSceneWind(onChange) {
  if (typeof onChange !== 'function' || typeof Hooks === 'undefined') return () => {};
  const id = Hooks.on('updateScene', (doc, change) => {
    try {
      const activeId = typeof canvas !== 'undefined' ? (canvas?.scene?.id ?? null) : null;
      if (!activeId || doc?.id !== activeId) return;
      if (!change?.flags?.[WIND_NAMESPACE] || !(SCENE_WIND_FLAG in change.flags[WIND_NAMESPACE])) return;
      onChange();
    } catch (err) {
      void err; // a mid-teardown update; nothing to recover
    }
  });
  return () => {
    try {
      Hooks.off('updateScene', id);
    } catch (err) {
      void err;
    }
  };
}
