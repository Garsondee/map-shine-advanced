/**
 * PLAYER-LIGHT PERMISSIONS — where the GM's scene-scoped "which player-
 * carried light modes are allowed here" allowance AND the "how dark is night,
 * really" darkness-realism lever are STORED (mythica-machina-press#77,
 * mythica-machina-press#577).
 *
 * Both live on ONE scene flag (never a world setting — the author's own ask
 * on #77 was explicitly PER SCENE, not per world: a vault crawl might forbid
 * every personal light, a moonlit road might invite them). Same shape as
 * `sky-persistence.js`'s scene half: a `scene.getFlag`/`setFlag` pair, a
 * `Hooks.on('updateScene', ...)` watcher filtered to the active scene, and
 * GM-write-only writes that report `{ok:false, reason}` rather than throwing
 * (Foundry itself rejects a non-GM's `setFlag` — a player nudging a control
 * they can't actually see, since the Remote is GM-only, should never be
 * possible, but the write path stays honest about the rule regardless).
 *
 * #577's `darknessRealism01` rides the SAME flag object rather than a second
 * one — the GM's own "how dark is night" question and "which lights are
 * allowed to compensate for that" are one editing surface in the Remote
 * (player-light-board.js), and a GM flipping scenes should get both restored
 * together, atomically, not as two independent round-trips that could land
 * out of order.
 *
 * @module foundry/player-light-permissions
 */

/** The module namespace this flag lives under — matches every other
 * scene-flag store in this codebase (sky/fade/wind/effect-param). */
export const PLAYER_LIGHT_NAMESPACE = 'map-shine-advanced';
/** The scene flag's own key. */
export const PLAYER_LIGHT_PERMISSIONS_FLAG = 'playerLightPermissions';

/** Every mode key #77 defines, Stage-1-rendered or not — the allowance list
 * covers all six so Stage 2's vision-mode grades need no schema change when
 * they land; only Torch/Flashlight's OWN render code exists yet. */
export const PLAYER_LIGHT_MODE_KEYS = Object.freeze([
  'torch',
  'flashlight',
  'nightVision',
  'lowLight',
  'infravision',
  'activeInfravision',
]);

/**
 * The defaults an unconfigured scene reads as — installing this feature must
 * change nothing about a scene nobody has touched yet, the same "opt-in
 * changes nothing visible until edited" posture `sky-persistence.js#
 * setSceneSkyOverride`'s own doc names. All six modes allowed, players free
 * to choose, darkness realism at 0 (today's Foundry-parity floor —
 * `vt-pan-viewer.js#setDarknessRealism`'s own documented default).
 * @returns {{modes: Record<string, boolean>, playersCanChooseMode: boolean, darknessRealism01: number}}
 */
export function defaultPlayerLightPermissions() {
  const modes = {};
  for (const key of PLAYER_LIGHT_MODE_KEYS) modes[key] = true;
  return { modes, playersCanChooseMode: true, darknessRealism01: 0 };
}

/**
 * Merge a possibly-partial, possibly-corrupt stored value onto the defaults —
 * PURE, so a stale/hand-edited flag (a missing `modes` key, an old scene from
 * before a mode existed, a non-boolean sneaking in from a bad write) always
 * resolves to something render-safe rather than propagating `undefined` into
 * a UI toggle or a light-source filter. Every field is defended independently
 * so a corrupt `darknessRealism01` doesn't also take `modes` down with it.
 * @param {object|null|undefined} stored
 * @returns {{modes: Record<string, boolean>, playersCanChooseMode: boolean, darknessRealism01: number}}
 */
export function resolvePlayerLightPermissions(stored) {
  const defaults = defaultPlayerLightPermissions();
  const modes = { ...defaults.modes };
  const storedModes = stored?.modes;
  if (storedModes && typeof storedModes === 'object') {
    for (const key of PLAYER_LIGHT_MODE_KEYS) {
      if (typeof storedModes[key] === 'boolean') modes[key] = storedModes[key];
    }
  }
  const playersCanChooseMode =
    typeof stored?.playersCanChooseMode === 'boolean' ? stored.playersCanChooseMode : defaults.playersCanChooseMode;
  const rawRealism = Number(stored?.darknessRealism01);
  const darknessRealism01 = Number.isFinite(rawRealism)
    ? Math.min(1, Math.max(0, rawRealism))
    : defaults.darknessRealism01;
  return { modes, playersCanChooseMode, darknessRealism01 };
}

/**
 * Read the active scene's player-light permissions, already resolved against
 * the defaults (never a raw, possibly-partial stored object).
 * @returns {{permissions: {modes: Record<string, boolean>, playersCanChooseMode: boolean, darknessRealism01: number}, sceneId: string|null, reason: string|null}}
 */
export function readScenePlayerLightPermissions() {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) {
      return { permissions: defaultPlayerLightPermissions(), sceneId: null, reason: 'no active scene' };
    }
    const raw = scene.getFlag(PLAYER_LIGHT_NAMESPACE, PLAYER_LIGHT_PERMISSIONS_FLAG) ?? null;
    return { permissions: resolvePlayerLightPermissions(raw), sceneId: scene.id ?? null, reason: null };
  } catch (err) {
    return {
      permissions: defaultPlayerLightPermissions(),
      sceneId: null,
      reason: `reading scene player-light permissions failed: ${err?.message ?? err}`,
    };
  }
}

/**
 * Merge-patch the active scene's player-light permissions. GM-only (Foundry's
 * rule — `scene.setFlag` rejects a non-GM). Merges atop the CURRENTLY STORED
 * value (not the resolved defaults) so a patch touching only `darknessRealism01`
 * never has to also re-specify every mode's own allowance.
 * @param {{modes?: Record<string, boolean>, playersCanChooseMode?: boolean, darknessRealism01?: number}} patch
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeScenePlayerLightPermissions(patch) {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { ok: false, reason: 'no active scene to write to' };
    const current = scene.getFlag(PLAYER_LIGHT_NAMESPACE, PLAYER_LIGHT_PERMISSIONS_FLAG) ?? null;
    const merged = resolvePlayerLightPermissions({
      ...current,
      ...(patch ?? {}),
      modes: { ...(current?.modes ?? {}), ...(patch?.modes ?? {}) },
    });
    await scene.setFlag(PLAYER_LIGHT_NAMESPACE, PLAYER_LIGHT_PERMISSIONS_FLAG, merged);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing scene player-light permissions failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * Watch for a change to this flag on the ACTIVE scene — mirrors
 * `sky-persistence.js#watchSceneSky`'s exact shape (a second GM's edit, or
 * this client's own write echoing back, both reach here the same way).
 * @param {() => void} onChange
 * @returns {() => void} unsubscribe.
 */
export function watchScenePlayerLightPermissions(onChange) {
  if (typeof onChange !== 'function' || typeof Hooks === 'undefined') return () => {};
  const id = Hooks.on('updateScene', (doc, change) => {
    try {
      const activeId = typeof canvas !== 'undefined' ? (canvas?.scene?.id ?? null) : null;
      if (!activeId || doc?.id !== activeId) return;
      if (
        !change?.flags?.[PLAYER_LIGHT_NAMESPACE] ||
        !(PLAYER_LIGHT_PERMISSIONS_FLAG in change.flags[PLAYER_LIGHT_NAMESPACE])
      )
        return;
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
