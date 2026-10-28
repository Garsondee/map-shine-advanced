/**
 * THE SCENE EYE — the one pretend camera every depth effect in this module agrees on (author, 2026-10-28:
 * *"unify perspective across the entire module to agree with a single version of 3D perspective which
 * matches this new layer parallax system and also the 3D table … for things like particles … cloud tops
 * … hanging above the table in the perspective"*).
 *
 * The viewer's camera is orthographic. Depth is faked, everywhere, with one law: a thing `h` world px
 * above the viewed plane is drawn scaled about the view centre by
 *
 *     s = H / (H − h)
 *
 * where `H` is the eye's height. Before this module the law was written six times with six different
 * eyes — fire at 1000 px, critters at 1000 px, roof drips at 2250 px, rain at 1.125 × the view span,
 * billows at 3 half-widths, cloud tops at 0.077 view widths — and the eye's CENTRE came from whichever
 * rect a subsystem happened to be handed (often the scene-clamped one, so rain converged on the wrong
 * point whenever the view hung past the map's edge).
 *
 * NOW: the eye sits over the centre of the TRUE view rect, at the height a pinhole camera with the
 * Table's Perspective field of view needs to frame that view (`sceneEyeHeight`). The Table's rim and
 * walls, Parallax's floors and canopies, the clouds, the rain and every critter are drawn by that one eye.
 * An effect's own "perspective" dial no longer moves a private camera: it scales how TALL that effect's
 * things are drawn against the shared eye (`D/k` with height `h` is exactly `D` with height `k·h`), so
 * each keeps its author-tuned look while all of them now answer to one Perspective control and one
 * centre.
 *
 * Pure: no THREE, no Foundry. Node-tested.
 *
 * @module scene/scene-eye
 */

/** The Table card's default Perspective (degrees) — the eye's field of view when nothing says otherwise. */
export const SCENE_EYE_DEFAULT_FOV_DEG = 45;

/** The eye height every constant-camera effect (fire, critters, drips) was tuned against. */
export const REFERENCE_EYE_PX = 1000;

/**
 * The eye height, in world px, that frames a view whose vertical half-span is `halfSpanPx` with a
 * vertical field of view of `fovDeg`. Zooming in lowers the eye (the same depth shows more strongly up
 * close, as with a real camera); a narrower field of view raises it (flatter).
 * @param {number} halfSpanPx
 * @param {number} [fovDeg]
 */
export function sceneEyeHeight(halfSpanPx, fovDeg = SCENE_EYE_DEFAULT_FOV_DEG) {
  const fov = Number.isFinite(fovDeg) ? fovDeg : SCENE_EYE_DEFAULT_FOV_DEG;
  const half = (Math.max(1, Math.min(170, fov)) * Math.PI) / 360;
  return Math.max(1, Number.isFinite(halfSpanPx) ? halfSpanPx : 1) / Math.tan(half);
}

/**
 * The frame's eye from the TRUE (unclamped) view rect: over its centre, at `sceneEyeHeight`.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null|undefined} viewRect
 * @param {number} [fovDeg]
 * @returns {{x:number, y:number, height:number, fovDeg:number}|null} null without a usable rect.
 */
export function resolveSceneEye(viewRect, fovDeg = SCENE_EYE_DEFAULT_FOV_DEG) {
  if (!viewRect) return null;
  const { minX, minY, maxX, maxY } = viewRect;
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || !(maxY > minY) || !(maxX > minX)) return null;
  const fov = Number.isFinite(fovDeg) ? Math.max(1, Math.min(170, fovDeg)) : SCENE_EYE_DEFAULT_FOV_DEG;
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    height: sceneEyeHeight((maxY - minY) / 2, fov),
    fovDeg: fov,
  };
}

/**
 * The law itself: the on-screen scale of something `h` px above the viewed plane, seen by an eye
 * `eyeHeight` px up. Heights are clamped short of the eye (`maxFrac` of it), so nothing is ever drawn
 * through the camera.
 * @param {number} h
 * @param {number} eyeHeight
 * @param {number} [maxFrac]
 */
export function eyeScale(h, eyeHeight, maxFrac = 0.75) {
  if (!(eyeHeight > 0) || !Number.isFinite(h)) return 1;
  const hc = Math.min(h, eyeHeight * maxFrac);
  return eyeHeight / (eyeHeight - hc);
}

/**
 * An effect tuned against a private camera of height `oldCameraPx` that was CONSTANT (fire, critters, drips),
 * expressed against the shared eye: the camera that keeps the effect's ratio to a 1000 px reference eye
 * (the height those effects were all tuned at). At a view where the shared eye is 1000 px up it is
 * exactly the old camera; zoomed in it strengthens and zoomed out it flattens, together with the Table
 * and the floors.
 * @param {number} oldCameraPx @param {number} eyeHeight
 */
export function eyeCameraForFixed(oldCameraPx, eyeHeight) {
  if (!(eyeHeight > 0)) return oldCameraPx;
  return Math.max(1, oldCameraPx * (eyeHeight / REFERENCE_EYE_PX));
}

// ── THE LAYER SCALE, PER PIXEL ──────────────────────────────────────────────────────────────────
// Parallax lifts a layer by scaling its mesh about the eye. The screen-space passes (the sun's
// building shadows, the cloud shadow) read their fields at the pixel's on-screen spot, so a lifted
// canopy or roof slid UNDER its shadows as the view panned: the shadow stayed with the ground while
// the layer rode above it (the author, 2026-10-28: "cloud shadows and building shadows are offset
// by an amount that helps sell the parallax"). `buf:scene.depth`'s colour attachment carries the top
// layer at every pixel, and its G byte was unused: each depth proxy writes its own mesh scale there
// (`vt/scene-depth.js`), and a screen pass reads it back to look its fields up where the layer
// really is (`liftedLookupNode`).

/** ln(scale) one side of the byte reaches: 0.8 … 1.25 covers every layer the subtle defaults make. */
export const LAYER_SCALE_LN_SPAN = Math.log(1.25);
/** The byte that means "scale 1" exactly, so an unlifted layer reads back with no drift at all. */
const LAYER_SCALE_ONE01 = 128 / 255;
/** Below this the byte was never written (clear colour 0): read as scale 1. */
const LAYER_SCALE_UNSET01 = 0.5 / 255;

/** A scale → the 0..1 value written to the byte (never 0, which means "unset"). @param {number} s */
export function encodeLayerScale01(s) {
  const ln = s > 0 && Number.isFinite(s) ? Math.log(s) : 0;
  return Math.min(1, Math.max(1 / 255, LAYER_SCALE_ONE01 + ln / (2 * LAYER_SCALE_LN_SPAN)));
}

/** The byte's 0..1 value → the scale (1 for an unset byte). @param {number} g */
export function decodeLayerScale01(g) {
  if (!(g >= LAYER_SCALE_UNSET01)) return 1;
  return Math.exp((g - LAYER_SCALE_ONE01) * 2 * LAYER_SCALE_LN_SPAN);
}

/** {@link encodeLayerScale01} as TSL. THREE's TSL is injected. @param {*} TSL @param {*} s - float node. */
export function layerScaleEncodeNode(TSL, s) {
  const { float, log } = TSL;
  return float(LAYER_SCALE_ONE01)
    .add(log(s.max(float(1e-4))).div(float(2 * LAYER_SCALE_LN_SPAN)))
    .clamp(1 / 255, 1);
}

/** {@link decodeLayerScale01} as TSL. @param {*} TSL @param {*} g - float node (the byte, 0..1). */
export function layerScaleDecodeNode(TSL, g) {
  const { float, exp, select } = TSL;
  const s = exp(g.sub(float(LAYER_SCALE_ONE01)).mul(float(2 * LAYER_SCALE_LN_SPAN)));
  return select(g.lessThan(float(LAYER_SCALE_UNSET01)), float(1), s);
}

/**
 * Where a screen pass should look a ground field up for a pixel that shows a layer of scale `s`:
 * back to the layer's own place on the map (`eye + (p − eye)/s`), then — for a RAISED layer, `h`
 * px up — toward the sun by `throw·h` (`throwPerPx` is the shadow's ground throw per px of caster
 * height, pointing away from the sun): a canopy stands up into the shadow of a wall, so it is only
 * in the part of that shadow a caster TALLER than it throws, the part nearer the wall. Floors that
 * sank (s < 1) keep their own plane and get no throw.
 * @param {*} TSL
 * @param {{xy:*, eye:*, eyeHeight:*, s:*, throwPerPx:*}} a - vec2 / vec2 / float / float / vec2 nodes.
 * @returns {*} vec2 node, world px.
 */
export function liftedLookupNode(TSL, { xy, eye, eyeHeight, s, throwPerPx }) {
  const { float, max } = TSL;
  const own = eye.add(xy.sub(eye).div(s.max(float(1e-4))));
  const h = max(float(0), eyeHeight.mul(float(1).sub(float(1).div(s.max(float(1e-4))))));
  return own.sub(throwPerPx.mul(h));
}

/** {@link liftedLookupNode} in plain JS, for tests and the CPU side. */
export function liftedLookup(xy, eye, eyeHeight, s, throwPerPx) {
  const k = s > 1e-4 ? s : 1e-4;
  const h = Math.max(0, eyeHeight * (1 - 1 / k));
  return {
    x: eye.x + (xy.x - eye.x) / k - throwPerPx.x * h,
    y: eye.y + (xy.y - eye.y) / k - throwPerPx.y * h,
  };
}
