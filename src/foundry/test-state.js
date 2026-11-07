/**
 * foundry/test-state.js — the Foundry half of the parity digest (mmp-f0k.2).
 *
 * Reads the Foundry facts `diag/state-digest.js` fingerprints: the viewed scene and level,
 * world time and pause, the scene's light documents, every MSA effect's GM switch, this
 * client's user and performance profile, and the camera. Read-only; never throws (a
 * missing piece reads as null, so a client mid-load still produces a digest that says so).
 *
 * @module foundry/test-state
 */

const MODULE_ID = 'map-shine-advanced';

/** @returns {object} raw Foundry facts for buildStateDigest */
export function readFoundryTestState() {
  const game = globalThis.game;
  const canvas = globalThis.canvas;
  const scene = canvas?.scene ?? null;
  const gmSwitches = {};
  try {
    for (const key of game?.settings?.settings?.keys?.() ?? []) {
      const m = /^map-shine-advanced\.(.+)\.gmEnable$/.exec(key);
      if (m) gmSwitches[m[1]] = game.settings.get(MODULE_ID, `${m[1]}.gmEnable`);
    }
  } catch {
    // a setting not registered yet: leave it out rather than fail the digest
  }
  let profile = null;
  try {
    profile = game?.settings?.get?.(MODULE_ID, 'performanceProfile') ?? null;
  } catch {
    profile = null;
  }
  const stage = canvas?.stage ?? null;
  return {
    msaVersion: game?.modules?.get?.(MODULE_ID)?.version ?? null,
    sceneId: scene?.id ?? null,
    levelId: scene ? (canvas?.level?.id ?? null) : null,
    worldTime: game?.time?.worldTime ?? null,
    paused: game?.paused ?? null,
    lights: (scene?.lights?.contents ?? []).map((l) => ({
      id: l.id,
      x: l.x,
      y: l.y,
      hidden: l.hidden,
      config: l.config,
    })),
    effectsEnabled: gmSwitches,
    user: game?.user?.name ?? null,
    isGM: game?.user?.isGM ?? null,
    profile,
    camera: stage ? { x: stage.pivot.x, y: stage.pivot.y, scale: stage.scale.x } : null,
  };
}
