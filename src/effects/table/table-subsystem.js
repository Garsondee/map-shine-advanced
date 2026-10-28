/**
 * TABLE'S SUBSYSTEM — the two world-pass meshes, their per-frame feed, and the
 * "the padding is not fog" term the vision gate needs. The viewer owns exactly
 * three calls into this: `create` (before the vision gate quads are built),
 * `attach(scene)` (once the world scene exists) and `update(...)` (each frame).
 *
 * WHY A SECOND JOB, THE REVEAL: for a player the vision gate multiplies the
 * frame by a mask that is black wherever no sight fan lands, and a scene's
 * padding is exactly that. A table nobody can see is no table, so while the
 * Table is on, every pixel outside the scene rect counts as revealed
 * (`revealedOutsideScene`, handed to the gate, the explored-dim quad and the
 * present's fog hold). What the player sees there is only what MSA draws:
 * the velvet, tiles, and the tokens `foundry/off-board-privacy.js` lets through.
 *
 * @module effects/table/table-subsystem
 */

import { resolveTableFrame, tableEffectsRect } from './table-model.js';
import {
  createTableUniforms,
  applyTableFrame,
  buildTableMaterials,
  buildTableShadeStepMaterial,
  buildTableTrace,
} from './table-render.js';

/** Floor sorts below the floor art (index 0); the overlay above every sorted item. */
const FLOOR_RENDER_ORDER = -1;
const OVERLAY_RENDER_ORDER = 1e6;
/** Board-shadow steps drawn between raised layers (`parallax-model.js#edgeShadeLadder`'s `maxSteps`). */
const SHADE_STEPS = 3;
/** The planes overshoot the view a touch, so TAA jitter never uncovers an edge. */
const VIEW_OVERSHOOT = 1.04;

/**
 * @param {object} args
 * @param {*} args.THREE - the three namespace (TSL on `.TSL`).
 * @param {(m:*, why:string) => *} args.markCompileDeferrable
 * @param {*} args.uViewRect - the shared (minX, minY, maxX, maxY) world-px view uniform.
 */
export function createTableSubsystem({ THREE, markCompileDeferrable, uViewRect }) {
  const TSL = THREE.TSL;
  const { uniform, vec4, float, mix } = TSL;

  const u = createTableUniforms(TSL);
  const { floor, overlay } = buildTableMaterials(THREE, u, markCompileDeferrable);
  const plane = new THREE.PlaneGeometry(1, 1);
  const floorMesh = new THREE.Mesh(plane, floor);
  const overlayMesh = new THREE.Mesh(plane, overlay);
  floorMesh.renderOrder = FLOOR_RENDER_ORDER;
  overlayMesh.renderOrder = OVERLAY_RENDER_ORDER;
  // THE SHADOW STEPS: the board shadow split between raised layers, so a canopy keeps less of it
  // than the floor beneath. Hidden unless Parallax hands a ladder; each has its own (from, to).
  const steps = [];
  for (let i = 0; i < SHADE_STEPS; i++) {
    const fromTo = uniform(TSL.vec2(1, 1));
    const material = buildTableShadeStepMaterial(THREE, u, fromTo, markCompileDeferrable);
    steps.push({ mesh: new THREE.Mesh(plane, material), material, fromTo });
  }
  const all = [floorMesh, overlayMesh, ...steps.map((s) => s.mesh)];
  for (const m of all) {
    m.frustumCulled = false; // world-space; the camera rect moves every frame
    m.visible = false;
    m.name = 'table';
  }

  // The reveal. Its own two uniforms, read by every fog consumer through one node.
  const uRevealRect = uniform(vec4(0, 0, 1, 1));
  const uRevealOn = uniform(float(0));
  /**
   * `true` outside the scene rect while the Table is on. `screenUV` is the
   * frame's screen UV (y = 0 at the top, the same convention as `uViewRect`).
   * @param {*} screenUV
   */
  function revealedOutsideScene(screenUV) {
    const world = TSL.vec2(mix(uViewRect.x, uViewRect.z, screenUV.x), mix(uViewRect.y, uViewRect.w, screenUV.y));
    const inside = world.x
      .greaterThanEqual(uRevealRect.x)
      .and(world.x.lessThanEqual(uRevealRect.z))
      .and(world.y.greaterThanEqual(uRevealRect.y))
      .and(world.y.lessThanEqual(uRevealRect.w));
    return uRevealOn.greaterThan(0.5).and(inside.not());
  }

  /**
   * THE LENS GUARD — keeps the Lens effect's barrel warp off the table. The lens samples the
   * finished frame at a radially warped UV, which bows the straight brass rim. The frame it
   * reads already holds the table drawn STRAIGHT, so: wherever the (unwarped) pixel is table,
   * sample at the plain UV; wherever it is board, keep the warp but clamp the warped position
   * back inside the board, so the warp can never drag velvet or rim in over the board's edge
   * (the board's own edge then follows the straight rim instead of bowing away from it).
   * Costs one trace (arithmetic only) in the lens shader; with the Table off it is a pass-through.
   * @param {*} uvNode - the pixel's plain screen UV.
   * @param {*} warpedUv - the lens's warped UV for the same pixel.
   */
  function lensGuard(uvNode, warpedUv) {
    const { vec2, max, clamp, smoothstep } = TSL;
    const toWorld = (c) => vec2(mix(uViewRect.x, uViewRect.z, c.x), mix(uViewRect.y, uViewRect.w, c.y));
    const toUv = (w) => w.sub(uViewRect.xy).div(uViewRect.zw.sub(uViewRect.xy));
    const tr = buildTableTrace(TSL, { worldXY: toWorld(uvNode), u });
    const isTable = smoothstep(tr.aa.negate(), tr.aa, max(tr.dp, tr.dq));
    const inset = u.seams.z.mul(1.5);
    const board = toUv(clamp(toWorld(warpedUv), u.rect.xy.add(inset), u.rect.zw.sub(inset)));
    return mix(warpedUv, mix(board, uvNode, isTable), uRevealOn);
  }

  let attachedTo = null;
  let last = { on: false };

  return {
    meshes: { floor: floorMesh, overlay: overlayMesh, steps: steps.map((s) => s.mesh) },
    revealedOutsideScene,
    lensGuard,
    /** @param {*} scene */
    attach(scene) {
      if (attachedTo === scene) return;
      for (const m of all) scene.add(m);
      attachedTo = scene;
    },
    /**
     * Feed one frame.
     * @param {object} a
     * @param {boolean} a.enabled
     * @param {object|null} a.params - the card's resolved params.
     * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} a.viewRect - the frame's world rect.
     * @param {{x:number,y:number,width:number,height:number}|null} a.sceneRect
     * @param {{width:number,height:number}|null} [a.canvasSize] - the padded canvas (the table's outer edge); defaults to the scene rect plus its own padding.
     * @param {number} a.drawHeightPx - height of the target the world pass draws into, in pixels.
     * @param {{topHeightPx:number, floorDepthPx:number}|null} [a.stack] - the parallax stack's heights: the table top
     *   rises to clear the highest floor, and the recess is dug down to the lowest one.
     * @param {{steps:Array<{order:number,from:number,to:number}>, last:number}|null} [a.shade] - the parallax
     *   board-shadow ladder: steps drawn between raised layers, and the share the overlay keeps.
     */
    update({ enabled, params, viewRect, sceneRect, canvasSize = null, drawHeightPx, stack = null, shade = null }) {
      const on = !!enabled && !!sceneRect && !!viewRect && sceneRect.width > 0 && sceneRect.height > 0;
      floorMesh.visible = overlayMesh.visible = on;
      uRevealOn.value = on ? 1 : 0;
      const ladder = on && shade && Array.isArray(shade.steps) ? shade.steps : [];
      u.shade.value.x = on && shade && Number.isFinite(shade.last) ? shade.last : 1;
      // The shadow reaches across the overhang only while parallax has a ladder (raised layers on show).
      u.shade.value.y = on && shade && ladder.length > 0 ? 1 : 0;
      for (let i = 0; i < steps.length; i++) {
        const st = ladder[i];
        steps[i].mesh.visible = !!st;
        if (!st) continue;
        steps[i].mesh.renderOrder = st.order;
        steps[i].fromTo.value.set(st.from, st.to);
      }
      const rect = sceneRect
        ? {
            minX: sceneRect.x,
            minY: sceneRect.y,
            maxX: sceneRect.x + sceneRect.width,
            maxY: sceneRect.y + sceneRect.height,
          }
        : null;
      if (!on) {
        last = { on: false, effectsRect: rect };
        return;
      }
      const w = viewRect.maxX - viewRect.minX;
      const h = viewRect.maxY - viewRect.minY;
      const cx = (viewRect.minX + viewRect.maxX) / 2;
      const cy = (viewRect.minY + viewRect.maxY) / 2;
      for (const m of all) {
        m.position.set(cx, cy, 0);
        m.scale.set(w * VIEW_OVERSHOOT, h * VIEW_OVERSHOOT, 1);
      }
      const frame = resolveTableFrame(params, {
        boardMinSidePx: Math.min(sceneRect.width, sceneRect.height),
        halfSpanPx: h / 2,
        eye: { x: cx, y: cy },
        topHeightPx: stack?.topHeightPx,
        floorDepthPx: stack?.floorDepthPx,
      });
      applyTableFrame(u, frame, {
        rect,
        outer: canvasSize ? { minX: 0, minY: 0, maxX: canvasSize.width, maxY: canvasSize.height } : null,
        padX: sceneRect.x,
        padY: sceneRect.y,
        worldPerPx: h / Math.max(1, drawHeightPx),
      });
      // The effects reach out to the brass's inner edge while parallax raises layers over the wall;
      // the fog's "padding is revealed" rule starts there too, so an overhang is never left unfogged.
      const effectsRect = tableEffectsRect(
        rect,
        { x: cx, y: cy },
        frame.eye[2],
        stack?.topHeightPx > 0 ? frame.eye[3] : 0
      );
      uRevealRect.value.set(effectsRect.minX, effectsRect.minY, effectsRect.maxX, effectsRect.maxY);
      last = {
        on: true,
        eyeHeightPx: frame.eye[2],
        depthPx: frame.eye[3],
        floorDepthPx: frame.floorDepth,
        rimPx: frame.rimW,
        shadeSteps: ladder.length,
        shadeLast: u.shade.value.x,
        effectsRect,
      };
    },
    info: () => ({ ...last, attached: !!attachedTo }),
    /**
     * Where the scene's effects (fog, lighting, cloud and sun shadow, rain) must reach this frame, as
     * min/max world px: the board, widened to the brass's inner edge while parallax raises layers out
     * over the recess wall (`table-model.js#tableEffectsRect`). Null before the first frame with a scene.
     */
    effectsRect: () => last.effectsRect ?? null,
    dispose() {
      for (const m of all) attachedTo?.remove(m);
      attachedTo = null;
      plane.dispose();
      floor.dispose();
      overlay.dispose();
      for (const s of steps) s.material.dispose();
    },
  };
}
