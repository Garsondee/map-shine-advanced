/**
 * PARALLAX'S SUBSYSTEM — moves the meshes the world pass already draws. No shader, no texture, no
 * pipeline: a drawable's vertices are baked in world px with an identity transform, and "scaled by
 * `s` about the eye" is the mesh transform `position.xy = eye·(1 − s)`, `scale.xy = s`. The viewer
 * owns exactly three calls: `update` (once a frame, before the pass plan), then `placeItem` for each
 * colour mesh and `placeProxy` for each of its depth twins (they share one geometry, so the twin finds
 * its colour mesh's scale by that geometry — colour, `buf:scene.depth` and the early-Z prepass can
 * never disagree about where a layer is).
 *
 * @module effects/parallax/parallax-subsystem
 */

import { PARALLAX_PARAMS } from './parallax.js';
import { createFloorGlide, edgeShadeLadder, resolveParallaxFrame } from './parallax-model.js';

const DEFAULTS = Object.fromEntries(Object.entries(PARALLAX_PARAMS).map(([k, d]) => [k, d.default]));

/** A scale this close to 1 is treated as 1: no need to move a mesh a hair. */
const EPS = 1e-5;

/**
 * @param {object} [args]
 * @param {number} [args.fovDeg] - the Table's perspective (so the rim and the layers share one eye).
 */
export function createParallaxSubsystem({ fovDeg = 45 } = {}) {
  const glide = createFloorGlide();
  /** colour-mesh geometry → the scale this frame gave it, for its depth twins. */
  const byGeometry = new Map();
  /** This frame's blended layers, (renderOrder, edge-shadow share), for the Table's shadow ladder. */
  const shades = [];
  /** meshes this subsystem has moved, so turning off (or a scale back to 1) puts them back. */
  const moved = new WeakSet();
  let frame = null;
  let eye = { x: 0, y: 0 };
  let on = false;
  let lastFloorPos = 0;
  /** The last frame's inputs, so a transition can ask "what would floor A look like from floor B". */
  let lastParams = null;
  let lastCtx = null;

  function place(mesh, s) {
    if (!mesh) return;
    if (Math.abs(s - 1) < EPS) {
      if (moved.has(mesh)) {
        mesh.position.x = 0;
        mesh.position.y = 0;
        mesh.scale.x = 1;
        mesh.scale.y = 1;
        moved.delete(mesh);
      }
      return;
    }
    const k = 1 - s;
    mesh.position.x = eye.x * k;
    mesh.position.y = eye.y * k;
    mesh.scale.x = s;
    mesh.scale.y = s;
    moved.add(mesh);
  }

  return {
    /**
     * Feed one frame. Returns the resolved frame (or null when off) so the viewer can hand the Table
     * and the culling margin the same heights.
     * @param {object} a
     * @param {boolean} a.enabled
     * @param {object|null} a.params
     * @param {Array} a.floors - `getActiveSceneFloors`' floors.
     * @param {number} a.floorIndex - the viewer's integer viewed floor.
     * @param {number} a.nowMs - a wall clock (the glide is presentation pacing, not sim time).
     * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} a.viewRect
     * @param {{width:number,height:number}|null} a.sceneRect
     * @param {number} [a.fovDeg] - the Table's perspective card value, so the rim and the layers share one eye.
     * @param {number} [a.extraTopAbove] - the tallest canopy's height above the highest floor (feet), if any.
     * @param {number} [a.tableTopPx] - the Table's own top height (px) when the stack is fitted to it.
     * @param {boolean} [a.snap] - jump to `floorIndex` with no glide (a scene change).
     */
    update({
      enabled,
      params,
      floors,
      floorIndex,
      nowMs,
      viewRect,
      sceneRect,
      fovDeg: fov = fovDeg,
      extraTopAbove,
      tableTopPx,
      snap = false,
    }) {
      byGeometry.clear();
      shades.length = 0;
      if (snap) glide.settle(floorIndex);
      const dur = params?.glideSec ?? DEFAULTS.glideSec;
      lastFloorPos = glide.step(floorIndex, nowMs, dur);
      if (!enabled || !viewRect || !sceneRect || !Array.isArray(floors) || floors.length === 0) {
        on = false;
        frame = null;
        return null;
      }
      const ctx = {
        floors,
        floorPos: lastFloorPos,
        boardMinSidePx: Math.min(sceneRect.width, sceneRect.height),
        halfSpanPx: (viewRect.maxY - viewRect.minY) / 2,
        fovDeg: fov,
        extraTopAbove,
        canopyFt: extraTopAbove,
        tableTopPx,
      };
      const f = resolveParallaxFrame(params, DEFAULTS, ctx);
      lastParams = params;
      lastCtx = ctx;
      on = f.enabled;
      frame = on ? f : null;
      eye = { x: (viewRect.minX + viewRect.maxX) / 2, y: (viewRect.minY + viewRect.maxY) / 2 };
      return frame;
    },
    isOn: () => on,
    /** The glide's current fractional floor (what DoF and the Table read). */
    floorPos: () => lastFloorPos,
    isGliding: () => glide.active(),
    /** Skip the glide: the next `update` adopts its floor outright. */
    snapNext: () => glide.settle(lastFloorPos),
    /** The scale a layer at `elevation` gets this frame (1 when off). */
    scaleAt: (elevation) => (on ? frame.scaleOf(elevation) : 1),
    /**
     * How big floor `fromIndex`'s plane looks from floor `toIndex` (1 = the same size; below 1 = it has
     * receded, above 1 = it has risen toward the eye). The floor-change transition uses it to move the
     * outgoing view's still the way the old floor would move. Null when off.
     * @param {number} fromIndex @param {number} toIndex
     */
    stepScale(fromIndex, toIndex) {
      if (!on || !lastCtx) return null;
      const f = resolveParallaxFrame(lastParams, DEFAULTS, { ...lastCtx, floorPos: toIndex });
      const s = f.scaleOf(f.floorBase(fromIndex));
      return Number.isFinite(s) ? s : null;
    },
    /** The smallest scale any layer gets this frame (1 when off). */
    lowestScale: () => (on ? Math.min(1, frame.lowestScale) : 1),
    frame: () => frame,
    /** Move a colour mesh to the scale of `elevation`; remember it for its depth twins. Returns the scale. */
    placeItem(mesh, elevation) {
      const s = on ? frame.scaleOf(elevation) : 1;
      place(mesh, s);
      if (mesh?.geometry && Math.abs(s - 1) >= EPS) byGeometry.set(mesh.geometry, s);
      // Only blended layers can take a step of the shadow between them: three draws every opaque mesh
      // before any blended one, so an opaque layer always sits under the whole shadow.
      if (on && mesh?.visible !== false && mesh?.material?.transparent === true && Number.isFinite(mesh.renderOrder))
        shades.push({ order: mesh.renderOrder, shade: frame.edgeShadeOf(elevation) });
      return s;
    },
    /**
     * The Table's edge-shadow ladder for this frame (`parallax-model.js#edgeShadeLadder`): the steps to
     * draw between the layers, and the share the final shadow keeps. No steps and a share of 1 when off.
     * Read after every `placeItem` of the frame.
     */
    edgeShade: () => (on ? edgeShadeLadder(shades, frame.treeShade) : { steps: [], last: 1 }),
    /** Move a mesh to an explicit scale (a layer whose elevation the caller already resolved). */
    placeScale(mesh, s) {
      place(mesh, on ? s : 1);
    },
    /** A depth twin: same geometry as a colour mesh, so the same scale; unmoved when that mesh is. */
    placeProxy(mesh) {
      if (!mesh) return;
      place(mesh, on ? (byGeometry.get(mesh.geometry) ?? 1) : 1);
    },
    info: () => ({
      on,
      floorPos: lastFloorPos,
      gliding: glide.active(),
      eyeHeightPx: frame?.eyeH ?? 0,
      topHeightPx: frame?.topHeight ?? 0,
      lift: frame?.lift ?? 1,
      bottomDepthPx: frame?.bottomDepth ?? 0,
      moved: byGeometry.size,
    }),
  };
}
