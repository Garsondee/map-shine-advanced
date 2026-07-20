/**
 * PAINT ADAPTER — the live Foundry facts the in-app painter needs, isolated in
 * foundry/ where `canvas.`/`game.`/`PIXI` access is legal (adapter-only) and
 * nowhere else. The ui/ painter calls THROUGH here so no Foundry/PIXI global
 * leaks into ui/, and — the load-bearing reason — so screen↔world uses
 * Foundry's OWN authoritative stage transform instead of a hand-derived mapping
 * (the Y-flip bug class this project keeps paying for; feedback_y_flip_recurring_risk).
 *
 * ⚠ NOT YET LIVE-VERIFIED. The client-px↔world transforms use PIXI 7.4.3 idioms
 * (`renderer.events.mapPositionToPoint` + `stage.toLocal/toGlobal`, resolution-
 * corrected). Correct in shape; the exact resolution/offset handling is THE
 * first thing to confirm live — paint a dot, check it lands under the cursor.
 *
 * @module foundry/paint-adapter
 */

import { getActiveSceneFloors } from './active-scene-source.js';

const MODULE_ID = 'map-shine-advanced';
const PAINT_FLAG = 'paintedMasks';

/** The active, drawn canvas, or null when no scene is ready. */
function activeCanvas() {
  const c = globalThis.canvas;
  return c && c.ready && c.dimensions ? c : null;
}

/**
 * Live paint context: the scene rect (world = Foundry canvas space), the two
 * transforms, and `boardElement` — Foundry's OWN `<canvas>` (`c.app.view`,
 * DOM id `board`) — or `{ ready: false }` when no scene is up.
 *
 * `boardElement` exists so a caller can tell "the pointer is over the map"
 * from "the pointer is over some UI panel" with ONE positive check
 * (`event.target === ctx.boardElement`) instead of a hand-maintained list of
 * panels to exclude (toolbar, debug panel, Foundry's own sidebar/hotbar…) —
 * exactly the disease `masks/authority-only` and friends exist to prevent
 * elsewhere in this project: an allowlist of the one true thing beats a
 * denylist that silently misses the next panel. `event.target` is computed by
 * REAL hit-testing at dispatch time regardless of which phase intercepts it,
 * so this check is reliable even from a window-level capture-phase listener.
 *
 * `floorCount`/`viewedFloorIndex` come from the SAME reader `boot.js` uses to
 * start the 3D viewer (`getActiveSceneFloors` + Foundry's own public
 * `canvas.level` getter) — so the painter's Floor stepper can clamp to the
 * scene's REAL floor count instead of a guessed range, and can open already
 * on whatever floor is currently being viewed.
 *
 * @returns {{ready:false}|{ready:true, sceneRect:{x:number,y:number,width:number,height:number},
 *   boardElement: (Element|null), floorCount:number, viewedFloorIndex:number,
 *   screenToWorld:(cx:number,cy:number)=>{x:number,y:number},
 *   worldToClient:(wx:number,wy:number)=>{x:number,y:number},
 *   snapWorld:(wx:number,wy:number)=>{x:number,y:number}}}
 */
export function readPaintContext() {
  const c = activeCanvas();
  if (!c) return { ready: false };
  const PIXI = globalThis.PIXI;
  const r = c.dimensions.sceneRect;
  const view = c.app?.view;

  // Mirrors boot.js's resolveFloorDescriptor exactly (same "no floors ->
  // floor 0" and "unmatched level id -> floor 0" fallbacks) — one scene, one
  // floor-resolution rule, read twice rather than reinvented.
  const floorsResult = getActiveSceneFloors(c.scene ?? null);
  const floors = floorsResult.ok ? floorsResult.floors : [];
  const floorCount = Math.max(1, floors.length);
  const viewedLevelId = c.level?.id ?? null;
  const viewedIdx = viewedLevelId ? floors.findIndex((f) => f.id === viewedLevelId) : -1;
  const viewedFloorIndex = viewedIdx >= 0 ? viewedIdx : 0;

  const clientToGlobal = (clientX, clientY) => {
    const p = new PIXI.Point();
    const events = c.app?.renderer?.events;
    if (events && typeof events.mapPositionToPoint === 'function') {
      events.mapPositionToPoint(p, clientX, clientY);
    } else {
      // Fallback (pre-events-API): logical px relative to the canvas, matching
      // what mapPositionToPoint returns above — the stage transform is in logical
      // px, so this must NOT scale by resolution.
      const b = view.getBoundingClientRect();
      p.set(clientX - b.left, clientY - b.top);
    }
    return p;
  };

  return {
    ready: true,
    sceneRect: { x: r.x, y: r.y, width: r.width, height: r.height },
    boardElement: view ?? null,
    floorCount,
    viewedFloorIndex,
    screenToWorld: (clientX, clientY) => {
      const w = c.stage.toLocal(clientToGlobal(clientX, clientY));
      return { x: w.x, y: w.y };
    },
    worldToClient: (wx, wy) => {
      // toGlobal returns LOGICAL (CSS) px — the same space toLocal consumes and
      // mapPositionToPoint produces, NOT renderer px. Dividing by resolution here
      // (the original bug) halved the preview toward the top-left on a 2× display.
      const g = c.stage.toGlobal(new PIXI.Point(wx, wy));
      const b = view.getBoundingClientRect();
      return { x: b.left + g.x, y: b.top + g.y };
    },
    // Snap a world point to the scene grid at 4× resolution — a 4×4 lattice of
    // snap points per grid square (Shapes-and-Regions.md §4.3, author decision).
    // Uses Foundry's OWN grid snapper (grid-origin- and grid-type-aware) when
    // available; falls back to a manual quarter-cell round from the grid size.
    snapWorld: (wx, wy) => {
      const grid = c.grid;
      const modes = globalThis.CONST?.GRID_SNAPPING_MODES;
      if (grid && typeof grid.getSnappedPoint === 'function' && modes) {
        const p = grid.getSnappedPoint({ x: wx, y: wy }, { mode: modes.VERTEX, resolution: 4 });
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
      }
      const q = (grid?.size || 100) / 4;
      return { x: Math.round(wx / q) * q, y: Math.round(wy / q) * q };
    },
  };
}

/**
 * Persist the painted-mask payload to the active scene's flags (Mode A embed —
 * travels inside an adventure automatically; Authoring-and-Distribution.md §3).
 * @param {object} payload
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function savePaintedMasks(payload) {
  const c = activeCanvas();
  if (!c || !c.scene) return { ok: false, reason: 'no active scene' };
  await c.scene.setFlag(MODULE_ID, PAINT_FLAG, payload);
  return { ok: true };
}

/** Read the painted-mask payload from the active scene's flags (or null). */
export function loadPaintedMasks() {
  const c = activeCanvas();
  if (!c || !c.scene) return null;
  return c.scene.getFlag(MODULE_ID, PAINT_FLAG) ?? null;
}
