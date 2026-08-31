/**
 * THE REFRACTION CAPTURE SUBSYSTEM — water tier 5's own private copy of a
 * finished scene buffer, bounded to water's own on-screen rect
 * (`docs/holy/Water-Testament.md` §2.5, Law 6 — `docs/planning/Effects.md`).
 *
 * ⚠️ TWO THINGS BELOW ARE NOW HISTORICAL, NOT CURRENT (2026-08-23) — kept
 * because the REASONING still explains real decisions elsewhere, but read
 * `vt-pan-viewer.js#runWaterRefractionCapturePass`'s own header for the
 * CURRENT shape: (1) "one frame of latency" — the self-capture fix (same
 * day) made the draw a separate step in the SAME pass as this capture, so
 * it is genuinely zero-frame-stale now, not one; (2) "`buf:scene.color`" —
 * the CALLER (`vt-pan-viewer.js`) now passes `sceneLit.texture`, not
 * `sceneColor.texture`, as `tick()`'s own `sceneColorTexture` argument (kept
 * that name here — this module itself is agnostic to WHICH finished buffer
 * it is handed, it only cares that whichever one it is has already finished
 * writing for the frame). Live-reported, real bug: capturing the PRE-
 * lighting `sceneColor` meant refraction showed the riverbed as it looked
 * BEFORE shadows/lighting were applied at all, visually erasing shadow
 * wherever it was visible — fixed by capturing `sceneLit` (post-lighting)
 * instead, the same buffer this subsystem's OWN "escape hatch" reasoning
 * below already argues for wanting "a FINISHED frame's colour".
 *

 * ============================================================================
 * WHY THIS EXISTS AT ALL — THE SAME-PASS PROBLEM
 * ============================================================================
 * Water's own drawable (tiers 0-4) renders INSIDE `runGeometryWorldPass`, the
 * very pass that WRITES `buf:scene.color` — sampling a target the same pass
 * is writing is undefined behaviour on both backends (the identical reasoning
 * `water-render.js` already documents for `buf:scene.attr`). Refraction NEEDS
 * a dependent read of `buf:scene.color` (offset by the wave slope), so it
 * cannot happen inside water's own drawable at all. This subsystem is the
 * escape hatch every screen-space-reflection technique ships with: capture a
 * FINISHED frame's colour into a separate buffer, and let the NEXT frame's
 * drawable read that — one frame of latency, industry-accepted (the
 * Testament's own words: "SSR ships this way everywhere").
 *
 * ============================================================================
 * WHY WORLD-ANCHORED, NOT SCREEN-ANCHORED — NO "CAMERA DELTA" MATH NEEDED
 * ============================================================================
 * The obvious screen-space-reflection shape reprojects a SCREEN position by a
 * camera-delta vector. This subsystem sidesteps that arithmetic entirely by
 * remembering the WORLD rect its own texture corresponds to
 * (`capturedRect`, exposed as a getter) rather than a screen offset. A
 * texel's world position never moves; only the mapping from world position to
 * THIS texture's own UV space needs to survive the camera panning between the
 * capture frame and the frame that reads it — and that mapping is the same
 * one `water-sim.js`'s own step material already uses for its rect-local grid
 * (`uv0.x * rectWidthPx`), just inverted. The consumer (`water-render.js`
 * tier 5) does the actual reprojection: given ITS OWN current-frame
 * `positionWorld`, remap through `capturedRect` to sample this texture — no
 * delta, no velocity buffer, just two rects.
 *
 * ============================================================================
 * WHY THE CAPTURED REGION IS THE INTERSECTION OF BODY RECT AND VIEW RECT
 * ============================================================================
 * `buf:scene.color` only holds valid pixels for what the CURRENT camera view
 * actually rendered — reading outside it returns whatever the previous
 * frame's content at that screen pixel was, not water. So the region this
 * subsystem captures is `waterBody.getRect()` (this floor's own water,
 * world px) intersected with the CURRENT view rect (world px, the same
 * `viewToWorldRect` result `vt-pan-viewer.js` already computes for tier 3's
 * synthesised eye). An empty intersection (water fully off-screen this frame)
 * skips the capture — the texture and `capturedRect` simply keep their last
 * valid values, a one-frame-stale read exactly like any other camera-jump
 * transient in this family.
 *
 * ============================================================================
 * WHY THE TARGET IS SIZED TO THE REGION, NOT A FIXED SCREEN-SIZED BUFFER
 * ============================================================================
 * Law 6: "cost scales with COVERED pixels, not screen pixels... rendered as
 * geometry bounded to their mask's region, or scissored/stencilled to it."
 * `effects/specular/specular-surface-subsystem.js` is this codebase's own
 * precedent for the first half of that sentence — bounding the DRAW
 * GEOMETRY/TARGET to the region, not a full-screen quad with a scissor test.
 * This subsystem follows the same shape: the target's own pixel dimensions
 * ARE the (half-resolution) region size, rounded UP to {@link BUCKET_PX} so
 * the camera panning by a few pixels every frame does not force a
 * reallocation every single frame — the content mapping (`uv()` across
 * whatever the target's real current size is) is exact regardless of how
 * much the bucket over-provisions.
 *
 * ============================================================================
 * WHY THE GPU CALLS ARE INJECTED
 * ============================================================================
 * Same reasoning as `water-flow-subsystem.js` §2 and `water-sim-subsystem.js`
 * — `renderer-state/graph-only` and `gpu/textures-in-vt-only` allow the
 * literal calls only inside `vt/`.
 *
 * @module effects/water/water-refraction-subsystem
 */

/** Target dimensions round UP to this — see this module's header, "WHY THE TARGET IS SIZED TO THE REGION". */
export const WATER_REFRACTION_BUCKET_PX = 64;

/** The downsample factor against a 1:1 screen-pixel capture — "half-res" per the Testament's own tier-5 plan. */
export const WATER_REFRACTION_DOWNSAMPLE = 2;

/** A hard ceiling on the capture target's own dimensions — water's rect can be huge (a whole river); the captured REGION still tracks the view intersection, this just stops one runaway allocation. Comfortably above any real drawing buffer at the downsample factor above. */
export const WATER_REFRACTION_MAX_DIM_PX = 2048;

/**
 * @param {number} value @param {number} bucket
 * @returns {number} `value` rounded up to the next multiple of `bucket`, minimum one bucket.
 */
function roundUpToBucket(value, bucket) {
  return Math.max(bucket, Math.ceil(value / bucket) * bucket);
}

/**
 * The world-rect intersection of the water body and the current view, or
 * `null` if they do not overlap (water is fully off-screen this frame).
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bodyRect
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} viewRect
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
 */
export function intersectRects(bodyRect, viewRect) {
  const minX = Math.max(bodyRect.minX, viewRect.minX);
  const minY = Math.max(bodyRect.minY, viewRect.minY);
  const maxX = Math.min(bodyRect.maxX, viewRect.maxX);
  const maxY = Math.min(bodyRect.maxY, viewRect.maxY);
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * The capture target's own pixel dimensions for a given world-space region,
 * at the downsample factor and bucket rounding this module declares —
 * exported so the subsystem's own `ensureTarget` and its test can agree on
 * the same arithmetic without either re-deriving it independently.
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} regionRect - world px.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} viewRect - world px, the CURRENT view.
 * @param {number} deviceW @param {number} deviceH - device px of the buffer
 *   `tick`'s own `sceneColorTexture` arg is ITSELF sized to — in
 *   `vt-pan-viewer.js` that is the INTERNAL tier (`internalW`/`internalH`,
 *   what `sceneLit` is actually rendered at), never the CSS `canvasW`/
 *   `canvasH` (a real bug, live from the first wiring commit through
 *   2026-08-27: silently under-sized this capture by ~1/pixelRatio) and
 *   never the PRESENT tier `drawBufW`/`drawBufH` either — the render-scale
 *   governor can make PRESENT larger than what the sampled texture actually
 *   holds, which would size this capture above the source data's own
 *   density for zero quality gain, exactly when the governor is trying to
 *   claw GPU time back.
 * @returns {{width:number, height:number}}
 */
export function computeCaptureTargetSize(regionRect, viewRect, deviceW, deviceH) {
  const viewSpanX = Math.max(1e-6, viewRect.maxX - viewRect.minX);
  const viewSpanY = Math.max(1e-6, viewRect.maxY - viewRect.minY);
  const pxPerWorldX = deviceW / viewSpanX;
  const pxPerWorldY = deviceH / viewSpanY;
  const rawW = ((regionRect.maxX - regionRect.minX) * pxPerWorldX) / WATER_REFRACTION_DOWNSAMPLE;
  const rawH = ((regionRect.maxY - regionRect.minY) * pxPerWorldY) / WATER_REFRACTION_DOWNSAMPLE;
  const width = Math.min(WATER_REFRACTION_MAX_DIM_PX, roundUpToBucket(rawW, WATER_REFRACTION_BUCKET_PX));
  const height = Math.min(WATER_REFRACTION_MAX_DIM_PX, roundUpToBucket(rawH, WATER_REFRACTION_BUCKET_PX));
  return { width, height };
}

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {{create: Function, dispose: Function}} args.allocator - `graph/three-allocator.js`.
 * @param {(target: *, quad: *) => void} args.renderWaterPass - the literal
 *   save/bind/render/restore triplet, defined in `vt/` (this module's own
 *   header) — the SAME injected primitive `water-sim-subsystem.js` receives.
 * @returns {{
 *   texture: *|null,
 *   capturedRect: {minX:number,minY:number,maxX:number,maxY:number}|null,
 *   width: number|null,
 *   height: number|null,
 *   tick: (args: {bodyRect: object|null, viewRect: object, deviceW: number, deviceH: number, sceneColorTexture: *|null}) => void,
 *   getStatus: () => object,
 *   dispose: () => void,
 * }}
 */
export function createWaterRefractionSubsystem({ THREE, allocator, renderWaterPass }) {
  const { uniform, vec2, vec4, texture, uv, clamp, float } = THREE.TSL;

  /** The rect THIS frame's `uv()` maps across, on the TARGET side — set before every render. */
  const uRegionMin = uniform(vec2(0, 0));
  const uRegionSize = uniform(vec2(1, 1));
  /** The rect `sceneColorTexture` itself covers this frame (the current view) — the SOURCE side. */
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
    captureRt = allocator.create('water.refraction.capture', {
      resolvedW: width,
      resolvedH: height,
      // Screen-derived (a fraction of the drawing buffer, never the world) —
      // `graph/three-allocator.js`'s own law for exactly this shape.
      screenSized: true,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      // BILINEAR: this texture is read back at a DIFFERENT resolution (full
      // water-render.js screen density) than it was written at (half) — the
      // same "genuinely different resolution" case `water-sim.js`'s own
      // header names for its own smooth-texel reconstruction.
      filter: 'linear',
      depth: false,
    });
    sizeKey = key;
    return true;
  }

  function rebuildMaterial(sceneColorTexture) {
    disposeMaterial();
    const material = new THREE.NodeMaterial();
    // For each TARGET texel (uv() spans this target's own [0,1]), find the
    // world position it represents (uRegionMin/Size), then find where THAT
    // world position sits inside the SOURCE texture's own view (uViewMin/
    // Size) — the one remap this whole subsystem exists to make available to
    // next frame's water-render.js tier 5, done once here instead of once per
    // refracted fragment.
    const uv0 = uv();
    const worldXY = uRegionMin.add(uv0.mul(uRegionSize));
    const sourceUv = clamp(worldXY.sub(uViewMin).div(uViewSize), 0, 1);
    material.fragmentNode = vec4(texture(sceneColorTexture, sourceUv).rgb, float(1));
    quad = new THREE.QuadMesh(material);
    boundSceneColorTexture = sceneColorTexture;
    rebuilds++;
  }

  /**
   * THE PER-FRAME ENTRY POINT. Must run AFTER `runGeometryWorldPass` has
   * finished writing `buf:scene.color` for THIS frame — see this module's
   * header. Deliberately does nothing (leaves the last valid capture in
   * place) when there is no water body, no scene-color texture yet, or the
   * body/view intersection is empty.
   */
  function tick({ bodyRect, viewRect, deviceW, deviceH, sceneColorTexture }) {
    ticks++;
    if (!bodyRect || !sceneColorTexture || !(deviceW > 0) || !(deviceH > 0)) {
      lastStatus = !bodyRect ? 'no water body rect for this floor' : 'waiting on scene.color';
      return;
    }
    const region = intersectRects(bodyRect, viewRect);
    if (!region) {
      lastStatus = 'water fully off-screen this frame — capture skipped';
      return;
    }
    const { width, height } = computeCaptureTargetSize(region, viewRect, deviceW, deviceH);
    ensureTarget(width, height);
    if (!quad || sceneColorTexture !== boundSceneColorTexture) rebuildMaterial(sceneColorTexture);

    uRegionMin.value.set(region.minX, region.minY);
    uRegionSize.value.set(Math.max(1e-6, region.maxX - region.minX), Math.max(1e-6, region.maxY - region.minY));
    uViewMin.value.set(viewRect.minX, viewRect.minY);
    uViewSize.value.set(Math.max(1e-6, viewRect.maxX - viewRect.minX), Math.max(1e-6, viewRect.maxY - viewRect.minY));

    renderWaterPass(captureRt, quad);
    capturedRect = region;
    captures++;
    lastStatus = 'ok';
  }

  return {
    /** The most recently captured colour, or `null` before the first successful capture. */
    get texture() {
      return captureRt ? captureRt.texture : null;
    },
    /** The world rect `texture`'s own UV space maps across — `null` until the first successful capture. Consumed by `water-render.js` tier 5 to reproject its OWN current-frame world position into this texture, with no camera-delta math needed (this module's own header). */
    get capturedRect() {
      return capturedRect;
    },
    /** The capture target's own texel dimensions — `null` until the first
     * allocation, same contract as `texture`/`capturedRect` above. Feeds
     * `water-render.js#setCapturedTexSize`'s chromatic-fringe texel pitch;
     * same reasoning as `water-sim-subsystem.js`'s own `width`/`height`
     * getters, which this pair mirrors exactly. */
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
