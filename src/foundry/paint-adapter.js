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

const MODULE_ID = 'map-shine-advanced';
const PAINT_FLAG = 'paintedMasks';

/** The active, drawn canvas, or null when no scene is ready. */
function activeCanvas() {
  const c = globalThis.canvas;
  return c && c.ready && c.dimensions ? c : null;
}

/**
 * Live paint context: the scene rect (world = Foundry canvas space) and the
 * two transforms, or `{ ready: false }` when no scene is up.
 * @returns {{ready:false}|{ready:true, sceneRect:{x:number,y:number,width:number,height:number},
 *   screenToWorld:(cx:number,cy:number)=>{x:number,y:number},
 *   worldToClient:(wx:number,wy:number)=>{x:number,y:number}}}
 */
export function readPaintContext() {
  const c = activeCanvas();
  if (!c) return { ready: false };
  const PIXI = globalThis.PIXI;
  const r = c.dimensions.sceneRect;
  const view = c.app?.view;

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
