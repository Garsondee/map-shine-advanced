/**
 * @fileoverview SceneRectScissor — projects the inner scene rectangle's
 * four corners from **Three world space** (ground plane at `groundZ`,
 * same convention as `SceneComposer` / base plane) through the active
 * camera into drawing-buffer pixels, then takes the pixel AABB for
 * `gl.scissor`.
 *
 * **Why not canvas-fixed pixels?** A rectangle fixed in framebuffer
 * space stays put when you pan; the 3D map moves underneath it — so the
 * cull region slides relative to the tiles (looks like parallax). World
 * projection makes the scissor **track the authored scene bounds on screen**
 * as the camera moves.
 *
 * Goal: have **zero** fragment-shader work happen in the padded zone or
 * the outer black region beyond the scene rect. Scissor is the most
 * total mechanism — fragments outside the rect are discarded by the
 * rasterizer before the fragment shader is even scheduled.
 *
 * Usage (pseudocode):
 *
 *   const scissor = getSceneRectScissor();
 *   scissor.update(renderer, camera);          // once per frame — camera required for world projection
 *   withSceneScissor(renderer, () => {         // wrap any pass
 *     effect.render(...);
 *   });
 *
 * Passes that legitimately need to write outside the scene rect (the
 * final blit-to-screen, MaskDebugOverlayPass, mask-coordinate-frame
 * passes) MUST stay outside the wrapper. Those call sites already
 * defensively `setScissorTest(false)` to neutralize any stale scissor
 * state, which is exactly the behavior we want.
 *
 * Allow-list (intentionally NOT wrapped — verified Apr 2026):
 *
 *   1. `FloorCompositor._blitToScreen`
 *      - Disables scissor explicitly via `setScissorTest(false)`
 *      - Then does an *unscissored* full clear of the default
 *        framebuffer to opaque black so the outer-rect area is clean
 *      - Then re-scissors the actual `renderer.render(blit)` call so it
 *        only writes the inner-rect pixels (so the outer area stays at
 *        the cleared black). The blit's clear-then-scissored-render
 *        pattern is what makes the whole pipeline visually correct.
 *
 *   2. `MaskDebugOverlayPass.renderComposite`
 *      - Disables scissor explicitly. Its shader handles `inScene`
 *        internally so it can show the underlying scene unmodified
 *        outside the inner rect.
 *
 *   3. `GpuSceneMaskCompositor.composeFloor` and other mask compositor
 *      passes — these write to mask textures whose UV [0,1] = scene
 *      rect (NOT screen-space). A screen-space scissor would clip the
 *      wrong region. The mask compositor runs from a separate code
 *      path and never sees `withSceneScissor`.
 *
 *   4. Cloud / overhead-shadow / building-shadow / painted-shadow
 *      capture passes (`CloudEffectV2.render`, `OverheadShadowsEffectV2`,
 *      `BuildingShadowsEffectV2`, `PaintedShadowEffectV2`) — these
 *      render to scene-rect-coord-frame mask RTs as well. Run early in
 *      the frame, intentionally unscissored.
 *
 *   5. `BloomEffectV2.render` — wraps `THREE.UnrealBloomPass` which
 *      internally binds a mip-pyramid of progressively smaller RTs.
 *      A screen-space scissor rect would be wrong for those sub-RTs
 *      (and degenerate at the smallest mips). Bloom samples its input
 *      at full UV; we mitigate by pre-clearing the input pool RTs to
 *      opaque black so bloom never reads driver-uninitialized memory
 *      in the outer-rect area.
 *
 *   6. `FloorCompositor._renderLateWorldOverlay` and
 *      `_renderPixiUiOverlay` — interactive UI elements (door icons,
 *      HUD) that may legitimately appear in the padded zone.
 *
 *   7. `CloudEffectV2.blitCloudTops` — final cloud-top blit after the
 *      late overlay. Atmospheric, intentionally outside the scene rect.
 *
 * @module compositor-v2/SceneRectScissor
 */

import { getGlobalFrameState } from '../core/frame-state.js';

/** Treat anything < 1 px as no scissor. */
const MIN_SCISSOR_PX = 1;

/**
 * Read the inner sceneRect from Foundry's `canvas.dimensions`. Falls back
 * to the dimensions object itself for older / reduced shapes.
 *
 * @returns {{ x: number, y: number, w: number, h: number, sceneH: number, sceneW: number }|null}
 *   Foundry coords (top-left origin, Y down). `sceneW`/`sceneH` are the
 *   canvas dims used for Y-axis flip into Three world space.
 */
function readSceneRectFoundry() {
  let dims = null;
  try {
    dims = globalThis.canvas?.dimensions ?? null;
  } catch (_) {
    dims = null;
  }
  if (!dims) return null;

  const sr = dims.sceneRect ?? dims;
  const x = Number(sr?.x ?? dims.sceneX ?? 0);
  const y = Number(sr?.y ?? dims.sceneY ?? 0);
  const w = Number(sr?.width ?? dims.sceneWidth ?? dims.width ?? 0);
  const h = Number(sr?.height ?? dims.sceneHeight ?? dims.height ?? 0);

  const canvasW = Number(dims.width ?? w);
  const canvasH = Number(dims.height ?? h);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return null;
  }
  if (w < MIN_SCISSOR_PX || h < MIN_SCISSOR_PX) return null;

  return {
    x, y, w, h,
    sceneW: Number.isFinite(canvasW) && canvasW > 0 ? canvasW : w,
    sceneH: Number.isFinite(canvasH) && canvasH > 0 ? canvasH : h,
  };
}

/**
 * Prefer {@link SceneComposer} `foundrySceneData` so scene rect + world
 * height match `worldY = worldHeight - foundryY` exactly (same as base
 * plane). Fallback: `canvas.dimensions`.
 *
 * @returns {{
 *   sceneX: number, sceneY: number, sceneW: number, sceneH: number,
 *   worldHeight: number, worldWidth: number,
 * }|null}
 */
function readSceneGeometryForScissor() {
  try {
    const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? null;
    if (fd && Number(fd.height) > 0 && Number(fd.width) > 0) {
      const sceneX = Number(fd.sceneX ?? 0);
      const sceneY = Number(fd.sceneY ?? 0);
      const sceneW = Number(fd.sceneWidth ?? fd.width ?? 0);
      const sceneH = Number(fd.sceneHeight ?? fd.height ?? 0);
      const worldH = Number(fd.height);
      const worldW = Number(fd.width);
      if (
        Number.isFinite(sceneX) &&
        Number.isFinite(sceneY) &&
        Number.isFinite(sceneW) &&
        Number.isFinite(sceneH) &&
        Number.isFinite(worldH) &&
        Number.isFinite(worldW) &&
        sceneW >= MIN_SCISSOR_PX &&
        sceneH >= MIN_SCISSOR_PX &&
        worldH > 0 &&
        worldW > 0
      ) {
        return { sceneX, sceneY, sceneW, sceneH, worldHeight: worldH, worldWidth: worldW };
      }
    }
  } catch (_) {}
  const sr = readSceneRectFoundry();
  if (!sr) return null;
  return {
    sceneX: sr.x,
    sceneY: sr.y,
    sceneW: sr.w,
    sceneH: sr.h,
    worldHeight: sr.sceneH,
    worldWidth: sr.sceneW,
  };
}

/** Canonical ground plane Z when composer not ready (`composer.js`). */
const CANONICAL_GROUND_Z = 1000;

function resolveGroundZForScissor() {
  try {
    const sc = window.MapShine?.sceneComposer ?? null;
    if (sc) {
      const g = Number(sc.groundZ);
      if (Number.isFinite(g)) return g;
      const z = Number(sc.basePlaneMesh?.position?.z);
      if (Number.isFinite(z)) return z;
    }
  } catch (_) {}
  return CANONICAL_GROUND_Z;
}

/**
 * Fallback only: map Foundry sceneRect to renderer logical pixels without
 * camera (does **not** track panning — useful if projection fails).
 *
 * @param {{ x: number, y: number, w: number, h: number, sceneW: number, sceneH: number }} sr
 * @param {number} bufW
 * @param {number} bufH
 * @returns {{ x: number, y: number, w: number, h: number }|null}
 */
function foundrySceneRectToDrawingBufferScissor(sr, bufW, bufH) {
  const canvasW = sr.sceneW;
  const canvasH = sr.sceneH;
  if (!Number.isFinite(canvasW) || !Number.isFinite(canvasH) || canvasW <= 0 || canvasH <= 0) {
    return null;
  }
  if (bufW < MIN_SCISSOR_PX || bufH < MIN_SCISSOR_PX) return null;

  const scaleX = bufW / canvasW;
  const scaleY = bufH / canvasH;

  const sx = sr.x;
  const sy = sr.y;
  const sw = sr.w;
  const sh = sr.h;

  const x = Math.floor(sx * scaleX);
  const right = Math.ceil((sx + sw) * scaleX);
  const w = Math.max(0, right - x);

  const bottomInset = canvasH - sy - sh;
  const topInset = canvasH - sy;
  const y = Math.floor(bottomInset * scaleY);
  const topGl = Math.ceil(topInset * scaleY);
  const h = Math.max(0, topGl - y);

  return { x, y, w, h };
}

/**
 * Project the inner scene rect on the ground plane through `camera`;
 * return an AABB in **renderer logical pixels** (same space as
 * `WebGLRenderer.getSize` / `setScissor` — Three multiplies by
 * `pixelRatio` internally before `gl.scissor`).
 *
 * Uses the same Foundry→world Y rule as {@link SceneComposer}:
 * `worldY = worldHeight - foundryY` at constant Z = `groundZ`.
 *
 * @param {typeof window.THREE} THREE
 * @param {THREE.Camera} camera
 * @param {NonNullable<ReturnType<typeof readSceneGeometryForScissor>>} geom
 * @param {number} groundZ
 * @param {number} bufW
 * @param {number} bufH
 * @param {THREE.Vector3[]} corners - four reusable corners
 * @returns {{ x: number, y: number, w: number, h: number }|null}
 */
function worldSceneRectToScissorPixels(THREE, camera, geom, groundZ, bufW, bufH, corners) {
  if (!THREE || !camera || !geom || !corners || corners.length < 4) return null;

  const wh = geom.worldHeight;
  const gx = geom.sceneX;
  const gy = geom.sceneY;
  const gw = geom.sceneW;
  const gh = geom.sceneH;

  const worldYTop = wh - gy;
  const worldYBot = wh - gy - gh;

  corners[0].set(gx, worldYBot, groundZ);
  corners[1].set(gx + gw, worldYBot, groundZ);
  corners[2].set(gx + gw, worldYTop, groundZ);
  corners[3].set(gx, worldYTop, groundZ);

  let nMinX = Infinity;
  let nMinY = Infinity;
  let nMaxX = -Infinity;
  let nMaxY = -Infinity;
  let projected = 0;

  for (let i = 0; i < 4; i++) {
    const v = corners[i];
    v.project(camera);
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) continue;
    if (v.z < -1 || v.z > 1) continue;

    if (v.x < nMinX) nMinX = v.x;
    if (v.y < nMinY) nMinY = v.y;
    if (v.x > nMaxX) nMaxX = v.x;
    if (v.y > nMaxY) nMaxY = v.y;
    projected += 1;
  }

  if (projected < 2 || !Number.isFinite(nMinX)) return null;

  const pxMinX = (nMinX * 0.5 + 0.5) * bufW;
  const pxMaxX = (nMaxX * 0.5 + 0.5) * bufW;
  const pxMinY = (nMinY * 0.5 + 0.5) * bufH;
  const pxMaxY = (nMaxY * 0.5 + 0.5) * bufH;

  let x = Math.floor(Math.min(pxMinX, pxMaxX));
  let y = Math.floor(Math.min(pxMinY, pxMaxY));
  let w = Math.ceil(Math.max(pxMinX, pxMaxX) - x);
  let h = Math.ceil(Math.max(pxMinY, pxMaxY) - y);

  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > bufW) w = bufW - x;
  if (y + h > bufH) h = bufH - y;

  if (w < MIN_SCISSOR_PX || h < MIN_SCISSOR_PX) return null;

  return { x, y, w, h };
}

/**
 * Centralized scissor service. One singleton owned by the compositor.
 *
 * Holds:
 *   - `current`: the AABB in **renderer logical pixels** (origin bottom-left;
 *     matches `setScissor`, which scales by `pixelRatio` for GL).
 *   - `valid`:   whether the AABB is non-degenerate and worth scissoring.
 *   - `frameId`: monotonically increasing token for cache invalidation.
 */
export class SceneRectScissor {
  constructor() {
    this.current = { x: 0, y: 0, w: 0, h: 0 };
    this.valid = false;
    this.frameId = 0;

    /** @type {THREE.Vector2|null} */
    this._tmpRendererSize = null;
    /** @type {number|null} */
    this._lastHash = null;

    /** Ground-plane corners for `Vector3.project` (reused). */
    this._cornersWorld = null;
  }

  /**
   * Recompute the drawing-buffer scissor: **world-project** the inner
   * scene rect (primary). Falls back to canvas-space mapping only if
   * projection fails or there is no camera.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} [camera]
   * @returns {boolean} `true` when a valid scissor rect is available.
   */
  update(renderer, camera) {
    const THREE = window.THREE;
    if (!THREE || !renderer) {
      this.valid = false;
      this._publishInvalid('noRendererOrThree');
      return false;
    }

    // Update camera matrices BEFORE building hash to avoid stale cache.
    if (camera) {
      try {
        if (typeof camera.updateProjectionMatrix === 'function') {
          camera.updateProjectionMatrix();
        }
        if (typeof camera.updateMatrixWorld === 'function') {
          camera.updateMatrixWorld();
        }
      } catch (_) {
        // Projection path can still fail and fall back safely.
      }
    }

    const geom = readSceneGeometryForScissor();
    if (!geom) {
      this.valid = false;
      this._publishInvalid('noGeometry');
      return false;
    }

    // Must match `renderer.setScissor`: Three stores scissor in **logical**
    // (CSS) pixels and multiplies by pixelRatio for GL. NDC from
    // `Vector3.project` maps linearly to that same logical width/height.
    let bufW = 0;
    let bufH = 0;
    try {
      const v2 = (this._tmpRendererSize ??= new THREE.Vector2());
      if (typeof renderer.getSize === 'function') {
        renderer.getSize(v2);
        bufW = Math.max(0, Math.floor(v2.x || 0));
        bufH = Math.max(0, Math.floor(v2.y || 0));
      }
    } catch (_) {
      bufW = 0;
      bufH = 0;
    }
    if (bufW < MIN_SCISSOR_PX || bufH < MIN_SCISSOR_PX) {
      this.valid = false;
      this._publishInvalid('invalidRendererSize');
      return false;
    }

    const groundZ = resolveGroundZForScissor();

    const hash = this._buildHash(geom, bufW, bufH, groundZ, camera);
    if (hash === this._lastHash && this.valid) return true;

    if (!this._cornersWorld) {
      this._cornersWorld = [
        new THREE.Vector3(),
        new THREE.Vector3(),
        new THREE.Vector3(),
        new THREE.Vector3(),
      ];
    }

    let mode = 'worldProject';
    let raw = (camera)
      ? worldSceneRectToScissorPixels(
        THREE,
        camera,
        geom,
        groundZ,
        bufW,
        bufH,
        this._cornersWorld,
      )
      : null;

    if (!raw) {
      const sr = readSceneRectFoundry();
      if (sr) {
        raw = foundrySceneRectToDrawingBufferScissor(sr, bufW, bufH);
        mode = raw ? 'canvasSpaceFallback' : 'none';
      }
    }

    if (!raw) {
      this.valid = false;
      this._lastHash = hash;
      this._publishInvalid('noRawScissor');
      return false;
    }

    const { x, y, w, h } = raw;

    // Skip scissor if it covers the full renderer (no benefit, adds state churn).
    if (x <= 0 && y <= 0 && w >= bufW && h >= bufH) {
      this.valid = false;
      this._lastHash = hash;
      this._publishInvalid('fullScreenNoScissor');
      return false;
    }

    this.current.x = x;
    this.current.y = y;
    this.current.w = w;
    this.current.h = h;
    this.valid = true;
    this.frameId += 1;
    this._lastHash = hash;

    // Mirror into the global FrameState so any consumer that already
    // reads from there sees the latest scissor rect without taking a
    // dependency on this module.
    try {
      const fs = getGlobalFrameState();
      if (fs) {
        if (!fs.sceneScissorPx) {
          fs.sceneScissorPx = { x: 0, y: 0, w: 0, h: 0 };
        }
        fs.sceneScissorPx.x = x;
        fs.sceneScissorPx.y = y;
        fs.sceneScissorPx.w = w;
        fs.sceneScissorPx.h = h;
        fs.sceneScissorValid = true;
        fs.sceneScissorFrameId = this.frameId;
      }
    } catch (_) {}

    // Mirror onto MapShine globals for console / health probes, in line
    // with the existing `__v2*` diagnostic surface.
    // Only fetch drawing buffer size when diagnostics are actually being written.
    let drawBufW = 0;
    let drawBufH = 0;
    try {
      if (typeof renderer.getDrawingBufferSize === 'function') {
        const v2 = (this._tmpRendererSize ??= new THREE.Vector2());
        renderer.getDrawingBufferSize(v2);
        drawBufW = Math.max(0, Math.floor(v2.x || 0));
        drawBufH = Math.max(0, Math.floor(v2.y || 0));
      }
    } catch (_) {}
    try {
      const ms = (typeof window !== 'undefined') ? window.MapShine : null;
      if (ms) {
        ms.__v2SceneScissor = {
          enabled: true,
          valid: true,
          mode,
          rect: { x, y, w, h },
          renderSize: { w: bufW, h: bufH },
          drawingBufferSize: { w: drawBufW, h: drawBufH },
          groundZ,
          worldHeight: geom.worldHeight,
          sceneRect: {
            x: geom.sceneX,
            y: geom.sceneY,
            w: geom.sceneW,
            h: geom.sceneH,
          },
          frameId: this.frameId,
        };
      }
    } catch (_) {}

    return true;
  }

  /**
   * Mark the scissor rect as invalid (e.g. before a frame in which the
   * compositor decides to disable scissor entirely).
   */
  invalidate() {
    this.valid = false;
    this._lastHash = null;
    this._publishInvalid('explicitInvalidate');
  }

  /**
   * @returns {{x:number,y:number,w:number,h:number}|null}
   */
  getRect() {
    if (!this.valid) return null;
    return {
      x: this.current.x,
      y: this.current.y,
      w: this.current.w,
      h: this.current.h,
    };
  }

  _hashMatrix(hash, elements) {
    if (!elements || elements.length < 16) return hash;
    for (let i = 0; i < 16; i++) {
      hash = (hash * 31 + Math.round(elements[i] * 1e3)) | 0;
    }
    return hash;
  }

  _buildHash(geom, bufW, bufH, groundZ, camera) {
    let hash = 17;
    hash = (hash * 31 + bufW) | 0;
    hash = (hash * 31 + bufH) | 0;
    hash = (hash * 31 + Math.round(groundZ * 1e3)) | 0;
    hash = (hash * 31 + (geom.sceneX | 0)) | 0;
    hash = (hash * 31 + (geom.sceneY | 0)) | 0;
    hash = (hash * 31 + (geom.sceneW | 0)) | 0;
    hash = (hash * 31 + (geom.sceneH | 0)) | 0;
    hash = (hash * 31 + (geom.worldHeight | 0)) | 0;
    hash = (hash * 31 + (geom.worldWidth | 0)) | 0;
    const pm = camera?.projectionMatrix?.elements;
    const vm = camera?.matrixWorldInverse?.elements;
    hash = this._hashMatrix(hash, pm);
    hash = this._hashMatrix(hash, vm);
    return hash;
  }

  _publishInvalid(reason = 'invalid') {
    try {
      const fs = getGlobalFrameState();
      if (fs) {
        fs.sceneScissorValid = false;
        fs.sceneScissorFrameId = this.frameId;
      }
    } catch (_) {}
    try {
      const ms = (typeof window !== 'undefined') ? window.MapShine : null;
      if (ms) {
        ms.__v2SceneScissor = {
          enabled: isSceneScissorEnabled(),
          valid: false,
          reason,
          rect: null,
          frameId: this.frameId,
        };
      }
    } catch (_) {}
  }
}

/** @type {SceneRectScissor|null} */
let _global = null;

/**
 * Module-level singleton — the compositor owns the only `update()`
 * call site; everything else just reads.
 */
export function getSceneRectScissor() {
  if (!_global) _global = new SceneRectScissor();
  return _global;
}

/**
 * Global kill switch (debug / fallback). When false, `withSceneScissor`
 * becomes a passthrough — useful when a regression appears and we want
 * to confirm scissor is the cause without redeploying.
 *
 * Toggle from console: `MapShine.sceneScissorEnabled = false`.
 */
export function isSceneScissorEnabled() {
  try {
    const v = window?.MapShine?.sceneScissorEnabled;
    if (v === false) return false;
  } catch (_) {}
  return true;
}

/**
 * Wrap a render callback so that all GL draws inside it are clipped
 * to the current sceneRect AABB. Saves and restores prior scissor
 * state so the wrapper is composable with the existing defensive
 * `setScissorTest(false)` patterns elsewhere.
 *
 * If the scissor rect is unavailable (no canvas, scene off-screen,
 * disabled) the callback runs unwrapped — never silently dropped.
 *
 * @template T
 * @param {THREE.WebGLRenderer} renderer
 * @param {() => T} fn
 * @returns {T}
 */
export function withSceneScissor(renderer, fn) {
  if (typeof fn !== 'function') return undefined;
  if (!renderer) return fn();
  if (!isSceneScissorEnabled()) return fn();

  const scissor = getSceneRectScissor();
  if (!scissor.valid) return fn();

  const prevTest = (typeof renderer.getScissorTest === 'function')
    ? renderer.getScissorTest()
    : null;

  let hasPrevRect = false;
  let prevX = 0;
  let prevY = 0;
  let prevW = 0;
  let prevH = 0;
  try {
    if (typeof renderer.getScissor === 'function') {
      const THREE = window.THREE;
      if (THREE) {
        const tmpPrevScissor = (withSceneScissor._tmpPrevScissor ??= new THREE.Vector4());
        renderer.getScissor(tmpPrevScissor);
        prevX = tmpPrevScissor.x;
        prevY = tmpPrevScissor.y;
        prevW = tmpPrevScissor.z;
        prevH = tmpPrevScissor.w;
        hasPrevRect = true;
      }
    }
  } catch (_) {}

  try {
    if (typeof renderer.setScissor === 'function') {
      renderer.setScissor(scissor.current.x, scissor.current.y, scissor.current.w, scissor.current.h);
    }
    if (typeof renderer.setScissorTest === 'function') {
      renderer.setScissorTest(true);
    }
    return fn();
  } finally {
    try {
      if (hasPrevRect && typeof renderer.setScissor === 'function') {
        renderer.setScissor(prevX, prevY, prevW, prevH);
      }
    } catch (_) {}
    try {
      if (prevTest != null && typeof renderer.setScissorTest === 'function') {
        renderer.setScissorTest(prevTest);
      } else if (prevTest == null && typeof renderer.setScissorTest === 'function') {
        // Best-effort default: leave scissor disabled if we couldn't
        // read the prior state, since most of the codebase treats
        // "scissor off" as the safe baseline (see _blitToScreen).
        renderer.setScissorTest(false);
      }
    } catch (_) {}
  }
}

/**
 * Inverse of `withSceneScissor`: temporarily disables scissor for the
 * duration of the callback and restores prior state on exit. Use this
 * when nested inside a scissored region to run a pass that internally
 * binds smaller render targets (e.g. UnrealBloomPass mip pyramid) where
 * a screen-space scissor rect would be wrong.
 *
 * @template T
 * @param {THREE.WebGLRenderer} renderer
 * @param {() => T} fn
 * @returns {T}
 */
export function withoutSceneScissor(renderer, fn) {
  if (typeof fn !== 'function') return undefined;
  if (!renderer) return fn();

  const prevTest = (typeof renderer.getScissorTest === 'function')
    ? renderer.getScissorTest()
    : null;

  if (prevTest !== true) return fn(); // already off — no-op fast path

  try {
    if (typeof renderer.setScissorTest === 'function') {
      renderer.setScissorTest(false);
    }
    return fn();
  } finally {
    try {
      if (typeof renderer.setScissorTest === 'function') {
        renderer.setScissorTest(true);
      }
    } catch (_) {}
  }
}

/**
 * Lightweight diagnostics hook for console / health probes.
 * @returns {{
 *   enabled: boolean,
 *   valid: boolean,
 *   rect: {x:number,y:number,w:number,h:number}|null,
 *   frameId: number
 * }}
 */
export function getSceneScissorDiag() {
  const s = getSceneRectScissor();
  return {
    enabled: isSceneScissorEnabled(),
    valid: s.valid,
    rect: s.getRect(),
    frameId: s.frameId,
  };
}
