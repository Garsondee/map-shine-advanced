/**
 * THE REFRACTION CAPTURE SUBSYSTEM, FOR PRISM — a per-frame private copy of a
 * finished scene buffer, bounded to the UNION of every currently-active
 * Prism tile's own rect (mythica-machina-press#137).
 *
 * ============================================================================
 * WHY THIS ADAPTS `water-refraction-subsystem.js` RATHER THAN COPYING ITS MATH
 * ============================================================================
 * This module's whole reason to exist is the SAME one water's own subsystem
 * states: a drawable rendering inside `runGeometryWorldPass` cannot sample the
 * very buffer that pass is still writing, so a dependent read of the finished
 * frame needs a separate capture, one pass later (`graph/passes.js#
 * surface.prism`'s own note has the full account). The RECT arithmetic that
 * capture needs — intersect a region against the current view, size a target
 * to the region at a bounded downsample, round up to a bucket so panning a
 * few pixels a frame does not reallocate every frame — is exactly generic
 * rect math with no water-specific content in it at all, so this module
 * REUSES `intersectRects`/`computeCaptureTargetSize` from `water-refraction-
 * subsystem.js` directly (an established, already-precedented cross-effect
 * import in this codebase — `specular-islands.js` imports from
 * `fluid/fluid-net.js`, `environmental-light.js` imports from
 * `fluid/fluid-render.js`) rather than re-deriving or duplicating it.
 *
 * ============================================================================
 * WHY A UNION RECT, NOT ONE BODY — THE ONE REAL DEPARTURE FROM WATER'S SHAPE
 * ============================================================================
 * Water has ONE body per floor (`waterBody.getRect()`); Prism can have MANY
 * disjoint tiles on one floor (a gem here, a stained-glass window across the
 * room) — there is no single "the" rect to capture. `unionRectOfItemCorners`
 * below takes the bounding-box union of every active tile's own resolved
 * quad corners (`prism-seams.js#getPrismMaskItems`'s own `corners` field) and
 * captures THAT one region. The accepted cost, stated plainly rather than
 * engineered around: two Prism tiles far apart on the same floor capture (and
 * pay for) the dead space between them too — correct, bounded by the SAME
 * `PRISM_REFRACTION_MAX_DIM_PX` ceiling water's own subsystem already
 * enforces, and a reasonable trade for a v1 whose target case (Effects.md's
 * own "ship the common case, document the rest") is a handful of gems/panes
 * per floor, not a scene tiled edge-to-edge in prism tiles. A smarter
 * per-cluster or per-item capture is a real, separate optimisation for a day
 * this proves too coarse in practice — not attempted here.
 *
 * ============================================================================
 * WHY THE GPU CALLS ARE INJECTED
 * ============================================================================
 * Same reasoning as `water-refraction-subsystem.js`'s own §2 — `renderer-
 * state/graph-only` and `gpu/textures-in-vt-only` allow the literal calls
 * only inside `vt/`.
 *
 * @module effects/prism/prism-refraction-subsystem
 */

import { intersectRects, computeCaptureTargetSize } from '../water/water-refraction-subsystem.js';

// Re-exported so a caller (and this module's own tests) never has to reach
// into `water/` for arithmetic this module depends on just as directly.
export { intersectRects, computeCaptureTargetSize };

/** Target dimensions round UP to this — see `water-refraction-subsystem.js`'s own header, "WHY THE TARGET IS SIZED TO THE REGION". Same value as water's own: no reason for the two ceilings to differ. */
export const PRISM_REFRACTION_BUCKET_PX = 64;

/** The downsample factor against a 1:1 screen-pixel capture. Prism's own dependent-read tier (`prism.js#PRISM.tiers[3]`) is priced the same C5 class as water's tier 5 — matching its downsample keeps the two comparable rather than inventing a second, unmeasured number. */
export const PRISM_REFRACTION_DOWNSAMPLE = 2;

/** A hard ceiling on the capture target's own dimensions — see `water-refraction-subsystem.js`'s own doc; identical reasoning, a union of many small tiles could otherwise still request an unreasonably large target if they were scattered across most of the view. */
export const PRISM_REFRACTION_MAX_DIM_PX = 2048;

/**
 * The bounding-box union of every item's own resolved quad corners — this
 * module's own one real departure from water's shape (this file's own header
 * has the full account). `null` for an empty list (no active Prism tile this
 * frame — the capture should skip, same "nothing to capture" contract
 * `tick`'s own `bodyRect` check already has for water).
 *
 * @param {Array<{corners: Array<{x:number,y:number}>}>} items - `prism-seams.js#getPrismMaskItems`'s own return shape (only `corners` is read).
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
 */
export function unionRectOfItemCorners(items) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const item of items ?? []) {
    for (const corner of item?.corners ?? []) {
      if (!Number.isFinite(corner?.x) || !Number.isFinite(corner?.y)) continue;
      any = true;
      if (corner.x < minX) minX = corner.x;
      if (corner.y < minY) minY = corner.y;
      if (corner.x > maxX) maxX = corner.x;
      if (corner.y > maxY) maxY = corner.y;
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

/**
 * @param {number} value @param {number} bucket
 * @returns {number} `value` rounded up to the next multiple of `bucket`, minimum one bucket.
 */
function roundUpToBucket(value, bucket) {
  return Math.max(bucket, Math.ceil(value / bucket) * bucket);
}

/**
 * The capture target's own pixel dimensions for a given world-space region —
 * this module's own downsample/bucket/ceiling constants, otherwise identical
 * arithmetic to `computeCaptureTargetSize` (re-exported above). Kept as its
 * own named function (rather than calling the re-exported one with these
 * constants closed over) so a reader sees Prism's OWN numbers used, not an
 * implicit borrow — the two behave identically only because both effects
 * chose the same downsample/bucket/ceiling, not because they share a formula
 * that could not vary.
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} regionRect
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} viewRect
 * @param {number} deviceW @param {number} deviceH
 * @returns {{width:number, height:number}}
 */
export function computePrismCaptureTargetSize(regionRect, viewRect, deviceW, deviceH) {
  const viewSpanX = Math.max(1e-6, viewRect.maxX - viewRect.minX);
  const viewSpanY = Math.max(1e-6, viewRect.maxY - viewRect.minY);
  const pxPerWorldX = deviceW / viewSpanX;
  const pxPerWorldY = deviceH / viewSpanY;
  const rawW = ((regionRect.maxX - regionRect.minX) * pxPerWorldX) / PRISM_REFRACTION_DOWNSAMPLE;
  const rawH = ((regionRect.maxY - regionRect.minY) * pxPerWorldY) / PRISM_REFRACTION_DOWNSAMPLE;
  const width = Math.min(PRISM_REFRACTION_MAX_DIM_PX, roundUpToBucket(rawW, PRISM_REFRACTION_BUCKET_PX));
  const height = Math.min(PRISM_REFRACTION_MAX_DIM_PX, roundUpToBucket(rawH, PRISM_REFRACTION_BUCKET_PX));
  return { width, height };
}

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {{create: Function, dispose: Function}} args.allocator - `graph/three-allocator.js`.
 * @param {(target: *, quad: *) => void} args.renderPrismCapturePass - the
 *   literal save/bind/render/restore triplet, defined in `vt/` (this
 *   module's own header) — the SAME injected primitive
 *   `water-refraction-subsystem.js`'s own `renderWaterPass` is.
 * @returns {{
 *   texture: *|null,
 *   capturedRect: {minX:number,minY:number,maxX:number,maxY:number}|null,
 *   width: number|null,
 *   height: number|null,
 *   tick: (args: {items: Array<object>, viewRect: object, deviceW: number, deviceH: number, sceneColorTexture: *|null}) => void,
 *   getStatus: () => object,
 *   dispose: () => void,
 * }}
 */
export function createPrismRefractionSubsystem({ THREE, allocator, renderPrismCapturePass }) {
  const { uniform, vec2, vec4, texture, uv, clamp, float } = THREE.TSL;

  const uRegionMin = uniform(vec2(0, 0));
  const uRegionSize = uniform(vec2(1, 1));
  const uViewMin = uniform(vec2(0, 0));
  const uViewSize = uniform(vec2(1, 1));

  let captureRt = null;
  let sizeKey = '';
  let quad = null;
  let boundSceneColorTexture = null;

  let capturedRect = null;
  let ticks = 0;
  let captures = 0;
  let rebuilds = 0;
  let lastStatus = 'never ticked';

  function disposeTarget() {
    allocator.dispose(captureRt);
    captureRt = null;
    sizeKey = '';
  }

  function disposeMaterial() {
    quad?.material?.dispose?.();
    quad = null;
    boundSceneColorTexture = null;
  }

  /** @returns {boolean} true if a (re)allocation happened. */
  function ensureTarget(width, height) {
    const key = `${width}x${height}`;
    if (key === sizeKey) return false;
    disposeTarget();
    captureRt = allocator.create('prism.refraction.capture', {
      resolvedW: width,
      resolvedH: height,
      screenSized: true,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      // BILINEAR: read back at a different resolution than written, same
      // reasoning `water-refraction-subsystem.js#ensureTarget` states.
      filter: 'linear',
      depth: false,
    });
    sizeKey = key;
    return true;
  }

  function rebuildMaterial(sceneColorTexture) {
    disposeMaterial();
    const material = new THREE.NodeMaterial();
    const uv0 = uv();
    const worldXY = uRegionMin.add(uv0.mul(uRegionSize));
    const sourceUv = clamp(worldXY.sub(uViewMin).div(uViewSize), 0, 1);
    material.fragmentNode = vec4(texture(sceneColorTexture, sourceUv).rgb, float(1));
    quad = new THREE.QuadMesh(material);
    boundSceneColorTexture = sceneColorTexture;
    rebuilds++;
  }

  /**
   * THE PER-FRAME ENTRY POINT. Must run AFTER `runGeometryWorldPass`/
   * `light.accumulate` have finished writing this frame's finished scene
   * colour — see this module's header. Deliberately does nothing (leaves the
   * last valid capture in place) when there are no active Prism tiles this
   * frame, no scene-colour texture yet, or the union/view intersection is
   * empty.
   */
  function tick({ items, viewRect, deviceW, deviceH, sceneColorTexture }) {
    ticks++;
    const bodyRect = unionRectOfItemCorners(items);
    if (!bodyRect || !sceneColorTexture || !(deviceW > 0) || !(deviceH > 0)) {
      lastStatus = !bodyRect ? 'no active Prism tile this frame' : 'waiting on scene colour';
      return;
    }
    const region = intersectRects(bodyRect, viewRect);
    if (!region) {
      lastStatus = 'every active Prism tile is off-screen this frame — capture skipped';
      return;
    }
    const { width, height } = computePrismCaptureTargetSize(region, viewRect, deviceW, deviceH);
    ensureTarget(width, height);
    if (!quad || sceneColorTexture !== boundSceneColorTexture) rebuildMaterial(sceneColorTexture);

    uRegionMin.value.set(region.minX, region.minY);
    uRegionSize.value.set(Math.max(1e-6, region.maxX - region.minX), Math.max(1e-6, region.maxY - region.minY));
    uViewMin.value.set(viewRect.minX, viewRect.minY);
    uViewSize.value.set(Math.max(1e-6, viewRect.maxX - viewRect.minX), Math.max(1e-6, viewRect.maxY - viewRect.minY));

    renderPrismCapturePass(captureRt, quad);
    capturedRect = region;
    captures++;
    lastStatus = 'ok';
  }

  return {
    get texture() {
      return captureRt ? captureRt.texture : null;
    },
    get capturedRect() {
      return capturedRect;
    },
    get width() {
      return captureRt ? captureRt.width : null;
    },
    get height() {
      return captureRt ? captureRt.height : null;
    },
    tick,
    getStatus() {
      return { ticks, captures, rebuilds, grid: sizeKey || 'not allocated', lastStatus };
    },
    dispose() {
      disposeMaterial();
      disposeTarget();
      capturedRect = null;
      ticks = 0;
      captures = 0;
      rebuilds = 0;
      lastStatus = 'disposed';
    },
  };
}
