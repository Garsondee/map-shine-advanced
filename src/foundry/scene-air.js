/**
 * foundry/scene-air.js — the scene's facts for the 3-D air (2026-11-09, Lab · Air).
 *
 * Two MAP FACTS live in the scene's MSA flags (never taste, so never part of a Look or a preset):
 *   - `air`      — true: this scene runs the 3-D air (the lab sets it; a GM can set it on any scene);
 *   - `airRoofs` — [{x, y, w, h, heightM}] in SCENE px (from the scene rect's top-left, padding excluded): how tall the
 *                  roofed buildings are. Absent = every roof is the default height (`world/air-grid.js`).
 *
 * @module foundry/scene-air
 */
const MODULE_ID = 'map-shine-advanced';

/**
 * Pure: the flags and the scene rect's origin → the air's facts in WORLD px.
 * @param {object|null|undefined} msaFlags - `scene.flags['map-shine-advanced']`.
 * @param {number} sceneX @param {number} sceneY
 * @returns {{enabled: boolean|null, roofs: Array<{x:number,y:number,w:number,h:number,heightM:number}>}}
 */
export function parseSceneAirFacts(msaFlags, sceneX = 0, sceneY = 0) {
  const f = msaFlags && typeof msaFlags === 'object' ? msaFlags : {};
  const enabled = f.air === true ? true : f.air === false ? false : null;
  const roofs = [];
  for (const r of Array.isArray(f.airRoofs) ? f.airRoofs : []) {
    const ok =
      r && [r.x, r.y, r.w, r.h, r.heightM].every((v) => Number.isFinite(v)) && r.w > 0 && r.h > 0 && r.heightM > 0;
    if (ok) roofs.push({ x: r.x + sceneX, y: r.y + sceneY, w: r.w, h: r.h, heightM: r.heightM });
  }
  const d = Number(f.airDraftiness);
  return { enabled, roofs, draftiness01: Number.isFinite(d) ? Math.min(1, Math.max(0, d)) : null };
}

/** The viewed scene's air facts (never throws: no scene reads as "no facts"). */
export function readSceneAirFacts() {
  try {
    const scene = globalThis.canvas?.scene;
    const d = globalThis.canvas?.dimensions;
    return parseSceneAirFacts(scene?.flags?.[MODULE_ID], d?.sceneX ?? 0, d?.sceneY ?? 0);
  } catch {
    return { enabled: null, roofs: [], draftiness01: null };
  }
}
