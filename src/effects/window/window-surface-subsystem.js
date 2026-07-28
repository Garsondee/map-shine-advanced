/**
 * WINDOW LIGHT'S SURFACE — the mesh, its own scene, the mask and the AABB
 * crop.
 *
 * `window-render.js` builds the material; this owns its lifetime and the
 * per-frame push. It follows `specular-surface-subsystem.js`'s shape closely,
 * and the places it deliberately does not are worth knowing.
 *
 * ============================================================================
 * ITS OWN SCENE, NOT THE MAIN ONE
 * ============================================================================
 * This effect draws into `buf:scene.illum`, inside `light.accumulate`,
 * alongside the ambient fill, region darkness and point lights — all of which
 * already render into that target from their OWN dedicated scenes
 * (`point-light-pool.js`'s two scenes are the precedent). So this gets a
 * `THREE.Scene` of its own too, rendered by `runLightAccumulatePass` right
 * after the point-light MAX-blend, guarded by the same `autoClearColor=false`
 * sequence that pass already uses.
 *
 * ============================================================================
 * NO ILLUM SAMPLE, UNLIKE SPECULAR
 * ============================================================================
 * `specular-surface-subsystem.js` takes `illumTexture` because its pass draws
 * AFTER illumination is finished, and multiplies by it. This effect draws
 * WHILE illumination is being assembled — it is one of the terms being
 * assembled — so it takes no illum input at all. See `window-render.js`'s own
 * header for why that also means it never touches `buf:scene.color`.
 *
 * ============================================================================
 * ⚠️ THE AABB COMES FROM THE FILE, NOT FROM A GRID
 * ============================================================================
 * Effects.md Law 6: cost scales with COVERED pixels. The bounds come from
 * `vt/mask-image.js`'s own pass over the decoded file, measured by MAX of RGB
 * rather than by red — a blue-painted light source has `r = 0` and measuring
 * by red would crop it out of existence. Identical reasoning to specular's.
 *
 * @module effects/window/window-surface-subsystem
 */

import { createLogger } from '../../core/log.js';
import { buildWindowSurfaceMaterial, WINDOW_MASK_IMAGE_SCALE } from './window-render.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';

const log = createLogger('WindowSurface');

/** Padding on the measured AABB, world px. Mirrors `SPECULAR_BOUNDS_PAD_PX`:
 * the mask uploads at `WINDOW_MASK_IMAGE_SCALE`, so the outermost painted
 * texel covers a couple of world px the bounds arithmetic rounds off; a small
 * pad means a cookie can never be clipped by its own crop. */
const WINDOW_BOUNDS_PAD_PX = 8;

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported.
 * @param {(floorIndex: number) => string|null} args.getWindowMaskUrl
 * @param {(floorIndex: number) => object|null} args.getWindowMaskRect
 * @param {(opts: object) => Promise<object|null>} args.loadMaskImage
 * @param {(data: Uint8Array, w: number, h: number, filter: string) => *} args.createMaskTexture -
 *   the literal `new THREE.DataTexture(...)`, writable only in `vt/`.
 * @param {*} [args.attrTexture] - `buf:scene.attr`; null compiles the floor
 *   gate out.
 * @param {*} args.uViewRect - envLight's OWN view-rect uniform, shared rather
 *   than duplicated.
 * @param {*} [args.cloudFactorNode] - see `window-render.js`'s header. Passed
 *   straight through; `null` until `world/cloud-field.js` exists.
 * @param {() => object} [args.getWindowRenderState] - the look/enable seam.
 * @returns {{scene: *, sync: Function, hasContent: Function, getStatus: Function, dispose: Function}}
 */
export function createWindowSurfaceSubsystem({
  THREE,
  getWindowMaskUrl,
  getWindowMaskRect,
  loadMaskImage,
  createMaskTexture,
  attrTexture = null,
  uViewRect,
  cloudFactorNode = null,
  getWindowRenderState,
}) {
  // ⚠️ `seams/viewer-wired` exists because water shipped exactly this shape
  // DECLARED, defaulted, consumed and never passed — every control dead,
  // every test green (`feedback_seam_default_hides_unwired`).
  getWindowRenderState ??= () => ({ enabled: true, params: {}, debugChannel: 0 });

  /** A dedicated scene — see the header. */
  const scene = new THREE.Scene();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  geometry.setIndex(Array.from(QUAD_INDICES));

  /** 1×1 placeholder until the real file decodes. The mesh stays hidden until
   * then, so it is never sampled — `mesh.visible` IS the gate, JS-side. */
  let maskTexture = createMaskTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, 'linear');
  let maskInfo = null;
  let loadedUrl = null;
  let loadedFloor = -1;
  let loading = false;
  /** The world AABB of what is actually painted, or null while unknown. */
  let contentBoundsWorld = null;
  let enabled = true;
  let lastParamsKey = '';
  /** Which debug intermediate is on screen — 0 = the effect as it ships. */
  let debugChannel = 0;
  let loadedMaskRect = null;
  let loadedContentBoundsUv = null;
  let paddedBoundsUv = null;

  const surface = buildWindowSurfaceMaterial({
    THREE,
    maskTexture,
    attrTexture,
    uViewRect,
    cloudFactorNode,
  });

  // ONE MESH, ADDITIVE.
  const mesh = new THREE.Mesh(geometry, surface.windowMaterial);
  mesh.frustumCulled = false; // world-space; the camera rect moves every frame
  mesh.visible = false; // until the mask AND its rect land
  scene.add(mesh);

  /** The ONE place visibility is decided, so the conditions cannot drift
   * apart across the call sites that each learn about one of them. Also owns
   * the DEBUG SWAP, exactly as specular's does. */
  function refreshVisibility() {
    mesh.visible = enabled && !!loadedUrl && !!contentBoundsWorld;
    mesh.material = debugChannel > 0 ? surface.debugMaterial : surface.windowMaterial;
  }

  /**
   * Load the floor's authored window file, crop the quad to whatever is
   * painted in it. Async and idempotent; the mesh stays hidden until it
   * lands, which needs no shader-side fallback.
   * @param {number} floorIndex
   */
  function ensureMaskImage(floorIndex) {
    const url = getWindowMaskUrl(floorIndex);
    // Keyed on floor AS WELL AS url: two floors can legitimately share a file
    // path in a scene built by duplication, and re-reading the rect on a
    // floor switch is what keeps the mapping right when they do.
    if (!url || loading || (url === loadedUrl && floorIndex === loadedFloor)) return;
    loading = true;
    const requestedFloor = floorIndex;
    loadMaskImage({ url, scale: WINDOW_MASK_IMAGE_SCALE, channels: 'rgb' })
      .then((loaded) => {
        loading = false;
        if (!loaded) return; // already logged loudly by the loader
        const rect = getWindowMaskRect(requestedFloor);
        if (!rect) {
          log.error(`window mask loaded for floor ${requestedFloor} but the authority served no rect — hidden`);
          return;
        }
        maskTexture?.dispose?.();
        maskTexture = loaded.texture;
        surface.setMaskTexture(loaded.texture);
        surface.setFloorIndex(requestedFloor);
        loadedUrl = url;
        loadedFloor = requestedFloor;
        loadedMaskRect = rect;
        loadedContentBoundsUv = loaded.contentBounds ?? null;
        contentBoundsWorld = toWorldBounds(loaded.contentBounds, rect);
        // THE MASK LOOKUP'S ONLY INPUT, derived from the SAME world bounds the
        // quad is cropped to rather than from `contentBounds` directly — so
        // the AABB pad is carried automatically and the two can never
        // disagree about where the quad's edges are.
        paddedBoundsUv = toUvBounds(contentBoundsWorld, rect);
        if (paddedBoundsUv) surface.setMaskUvBounds(paddedBoundsUv);
        maskInfo = {
          url,
          uploaded: `${loaded.width}x${loaded.height}`,
          native: `${loaded.nativeWidth}x${loaded.nativeHeight}`,
          mb: +(loaded.bytes / (1024 * 1024)).toFixed(1),
          // A file with window light painted edge to edge is legitimate and
          // reports the full rect; a file reporting NOTHING painted is the
          // case worth seeing, because the mesh then stays hidden and "no
          // light" would otherwise look identical to "effect broken".
          painted: contentBoundsWorld ? 'yes' : 'NOTHING PAINTED',
        };
        cropGeometry();
        refreshVisibility();
      })
      .catch((err) => {
        loading = false;
        log.error('window mask image load rejected —', err);
      });
  }

  /**
   * The PADDED world AABB back into mask-UV space — the exact inverse of
   * `toWorldBounds`, and the only thing the shader's mask lookup consumes.
   * @param {object|null} world @param {object} rect @returns {object|null}
   */
  function toUvBounds(world, rect) {
    if (!world) return null;
    const w = rect.maxX - rect.minX;
    const h = rect.maxY - rect.minY;
    if (!(Math.abs(w) > 1e-6 && Math.abs(h) > 1e-6)) return null;
    return {
      minU: (world.minX - rect.minX) / w,
      minV: (world.minY - rect.minY) / h,
      maxU: (world.maxX - rect.minX) / w,
      maxV: (world.maxY - rect.minY) / h,
    };
  }

  /** UV-space content bounds × the mask's world rect → a padded world AABB.
   * @param {object|null} b @param {object} rect @returns {object|null} */
  function toWorldBounds(b, rect) {
    if (!b) return null;
    const w = rect.maxX - rect.minX;
    const h = rect.maxY - rect.minY;
    return {
      minX: rect.minX + b.minU * w - WINDOW_BOUNDS_PAD_PX,
      minY: rect.minY + b.minV * h - WINDOW_BOUNDS_PAD_PX,
      maxX: rect.minX + b.maxU * w + WINDOW_BOUNDS_PAD_PX,
      maxY: rect.minY + b.maxV * h + WINDOW_BOUNDS_PAD_PX,
    };
  }

  /** Rewrite the shared quad to the painted AABB. */
  function cropGeometry() {
    const b = contentBoundsWorld;
    if (!b) return;
    const positions = buildQuadPositions([
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY },
      { x: b.minX, y: b.maxY },
    ]);
    const posAttr = geometry.getAttribute('position');
    if (posAttr && posAttr.array.length === positions.length) {
      posAttr.array.set(positions);
      // Same buffer, new contents. ⚠️ `BufferAttribute` has NO `dispose()` and
      // `setAttribute` is a bare assignment, so replacing the attribute leaks
      // its native GPU buffer (`reference_bufferattribute_no_dispose_trap`).
      posAttr.needsUpdate = true;
    } else {
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    }
  }

  /**
   * Per-frame, called from `runLightAccumulatePass` after the point-light
   * MAX-blend.
   * @param {number} floorIndex - the VIEWED floor.
   */
  function sync(floorIndex) {
    ensureMaskImage(floorIndex);

    // THE LOOK PARAMS. A string compare against cached uniform writes, and
    // NOT gated on any load generation: a slider drag changes no texture and
    // produces no reload.
    const state = getWindowRenderState();
    const p = state.params ?? {};
    const key = [state.enabled ? 1 : 0, state.debugChannel ?? 0, p.strength, p.contrast].join('|');
    if (key !== lastParamsKey) {
      lastParamsKey = key;
      if (Number.isFinite(p.strength)) surface.setStrength(p.strength);
      if (Number.isFinite(p.contrast)) surface.setContrast(p.contrast);
      debugChannel = Number.isFinite(state.debugChannel) ? Math.max(0, Math.round(state.debugChannel)) : 0;
      surface.setDebugChannel(debugChannel);
      enabled = state.enabled !== false;
    }
    refreshVisibility();
  }

  return {
    /** The dedicated scene `runLightAccumulatePass` renders. */
    scene,
    sync,
    /** True when there is genuinely something to draw — lets the pass take a
     * true JS early-return rather than issuing a render call for a hidden
     * mesh (Effects.md Law 4: gating by uniform is not gating). */
    hasContent: () => mesh.visible,
    getStatus() {
      return {
        visible: mesh.visible,
        debugChannel,
        enabled,
        floor: loadedFloor,
        bounds: contentBoundsWorld,
        maskImage: maskInfo ?? 'not loaded',
        floorGate: surface.floorGateCompiled,
        contentBoundsUv: loadedContentBoundsUv,
        maskUvBounds: paddedBoundsUv,
        maskRect: loadedMaskRect,
      };
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      surface.windowMaterial?.dispose?.();
      surface.debugMaterial?.dispose?.();
      maskTexture?.dispose?.();
    },
  };
}
