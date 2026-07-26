/**
 * SHINE'S SURFACE — the two meshes, their own scene, the high-resolution mask,
 * and the AABB crop (`docs/planning/Specular.md` §4.5, §6).
 *
 * `specular-render.js` builds the materials; this owns their lifetime and the
 * per-frame push. It follows `water-surface-subsystem.js`'s shape closely, and
 * the ONE place it deliberately does not is the important one:
 *
 * ============================================================================
 * ITS OWN SCENE, NOT THE MAIN ONE — AND THAT COSTS SOMETHING REAL
 * ============================================================================
 * Water's surface joins the main `scene` and gets three dividends for free:
 * occlusion by paint order, the zero-attr MRT contract, and no extra render
 * call. Shine cannot take any of them, because it reads `buf:scene.illum` and
 * that does not exist until `light.accumulate` has run. So it gets its own
 * `THREE.Scene`, drawn by `runSurfaceResponsePass` into `scene.lit` — the same
 * arrangement `point-light-pool.js` already uses for its two dedicated scenes,
 * and for the same reason (a pass whose draws must not be filtered out of, or
 * into, the world's flat sort list).
 *
 * The cost is that occlusion becomes explicit work: the floor gate in
 * `specular-render.js` reads `buf:scene.attr` to answer "is my metal actually
 * visible here", and tokens — which never write attributes — remain a named
 * gap. See that module's header point 3.
 *
 * ============================================================================
 * ⚠️ THE AABB COMES FROM THE FILE, NOT FROM A GRID
 * ============================================================================
 * Effects.md Law 6: cost scales with COVERED pixels, and metal covers a few
 * percent of a typical map. Water measures its AABB from the coarse derivation
 * grid because its jump flood already walks that grid. Nothing here floods
 * anything at tiers 0-2, so the bounds come from `vt/mask-image.js`'s own
 * single pass over the decoded file — measured while it is repacking the texels
 * it is already holding, by MAX of RGB rather than by red, because a
 * blue-painted steel object has `r = 0` and measuring by red would crop it out
 * of existence.
 *
 * @module effects/specular/specular-surface-subsystem
 */

import { createLogger } from '../../core/log.js';
import { buildSpecularSurfaceMaterial, SPECULAR_MASK_IMAGE_SCALE } from './specular-render.js';
import { keyLightDirection } from './specular-material.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';

const log = createLogger('SpecularSurface');

/** Padding on the measured AABB, world px. The mask is uploaded at
 * `SPECULAR_MASK_IMAGE_SCALE`, so the outermost painted texel covers up to a
 * couple of world px that the bounds arithmetic rounds off; a small pad means a
 * highlight can never be clipped by its own crop. Cheap — a few px on a bound
 * that is otherwise saving 95% of the screen. */
const SPECULAR_BOUNDS_PAD_PX = 8;

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported.
 * @param {(floorIndex: number) => string|null} args.getSpecularMaskUrl - boot's
 *   seam onto the floor's authored `_Specular` file. Null = no mask, which
 *   keeps the meshes hidden; there is nothing to fall back to and nothing that
 *   should be invented.
 * @param {(floorIndex: number) => object|null} args.getSpecularMaskRect - the
 *   world rect the authored file covers (the mask authority's grid spec).
 * @param {(opts: object) => Promise<object|null>} args.loadMaskImage -
 *   `vt/mask-image.js`'s loader, injected for the directory-wall reason every
 *   other effect injects it for (`gpu/textures-in-vt-only`).
 * @param {(data: Uint8Array, w: number, h: number, filter: string) => *} args.createMaskTexture -
 *   the literal `new THREE.DataTexture(...)`, which may only be written in `vt/`.
 * @param {*} args.illumTexture - `buf:scene.illum`.
 * @param {*} args.albedoTexture - `buf:scene.color`, the UN-LIT composite. Tier
 *   3 reads its luminance gradient as the map art's own painted relief.
 * @param {*} [args.attrTexture] - `buf:scene.attr`; null compiles the floor gate out.
 * @param {*} args.uViewRect @param {*} args.uOutdoorsRect @param {*} args.outdoorsTexNode
 * @param {Function} args.buildOutdoorsGate
 * @param {() => object} [args.getSpecularRenderState] - the look/enable seam.
 * @param {() => object|null} [args.getSkyHandle] - `effects/sky-access.js`'s
 *   handle for THIS frame. The ONE description of the outdoor light; this
 *   module never touches the hour (`env/one-sun`).
 * @returns {{scene: *, sync: Function, getStatus: Function, dispose: Function}}
 */
export function createSpecularSurfaceSubsystem({
  THREE,
  getSpecularMaskUrl,
  getSpecularMaskRect,
  loadMaskImage,
  createMaskTexture,
  illumTexture,
  albedoTexture,
  attrTexture = null,
  uViewRect,
  uOutdoorsRect,
  outdoorsTexNode,
  buildOutdoorsGate,
  getSpecularRenderState,
  getSkyHandle,
}) {
  // Default-off shape matching every other effect seam: an un-wired caller (the
  // torture fixture) still renders, with the render module's own defaults.
  // ⚠️ `seams/viewer-wired` exists because water shipped exactly this shape
  // DECLARED, defaulted, consumed and never passed — every control dead, every
  // test green (`feedback_seam_default_hides_unwired`).
  getSpecularRenderState ??= () => ({ enabled: true, params: {} });
  getSkyHandle ??= () => null;

  /** A dedicated scene — see the header. */
  const scene = new THREE.Scene();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  geometry.setIndex(Array.from(QUAD_INDICES));

  /** A 1×1 all-zero (no metal) placeholder until the real mask decodes. The
   * meshes stay hidden until then, so this is never actually sampled — which is
   * why the shader needs no "do I have a mask yet" uniform gate
   * (`tsl/no-uniform-gates`): `mesh.visible` is the gate, JS-side. */
  let maskTexture = createMaskTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, 'linear');
  let maskInfo = null;
  let loadedUrl = null;
  let loadedFloor = -1;
  let loading = false;
  /** The world AABB of what is actually painted, or null while unknown. */
  let contentBoundsWorld = null;
  let enabled = true;
  let lastParamsKey = '';
  let lastSkyKey = '';

  const surface = buildSpecularSurfaceMaterial({
    THREE,
    maskTexture,
    // A unit rect until the real one arrives with the mask; the meshes are
    // hidden until then, so nothing samples through it.
    maskRect: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    illumTexture,
    albedoTexture,
    attrTexture,
    uViewRect,
    uOutdoorsRect,
    outdoorsTexNode,
    buildOutdoorsGate,
  });

  // TWO meshes over ONE geometry — the diffuse knock-down is a MULTIPLY and the
  // highlights are an ADD, and blend state is per-material (see
  // `specular-render.js`'s header for why one alpha cannot be both). They share
  // the geometry object, so the AABB crop below writes exactly one position
  // buffer. Suppression strictly precedes the highlight: that is the physical
  // order (a conductor has no diffuse to begin with, THEN it reflects), and
  // although multiply and add commute over a destination it costs nothing to
  // be right.
  const meshes = [
    Object.assign(new THREE.Mesh(geometry, surface.suppressMaterial), { renderOrder: 0 }),
    Object.assign(new THREE.Mesh(geometry, surface.specularMaterial), { renderOrder: 1 }),
  ];
  for (const m of meshes) {
    m.frustumCulled = false; // world-space; the camera rect moves every frame
    m.visible = false; // until the mask AND its rect land
    scene.add(m);
  }

  /** The ONE place visibility is decided, so the conditions cannot drift apart
   * across the call sites that each learn about one of them — and so the two
   * meshes can never drift apart either. Half a shine pass (suppression with no
   * highlight) is a far worse failure than none, and it would read as a shader
   * bug rather than as a missing mask. */
  function refreshVisibility() {
    const show = enabled && !!loadedUrl && !!contentBoundsWorld;
    for (const m of meshes) m.visible = show;
  }

  /**
   * Load the floor's `_Specular` file at `SPECULAR_MASK_IMAGE_SCALE`, in RGB,
   * and crop the quad to whatever is painted in it. Async and idempotent; the
   * meshes stay hidden until it lands, which needs no shader-side fallback.
   * @param {number} floorIndex
   */
  function ensureMaskImage(floorIndex) {
    const url = getSpecularMaskUrl(floorIndex);
    // Keyed on floor AS WELL AS url: two floors can legitimately share a
    // `_Specular` file path in a scene built by duplication, and re-reading the
    // rect on a floor switch is what keeps the mapping right when they do.
    if (!url || loading || (url === loadedUrl && floorIndex === loadedFloor)) return;
    loading = true;
    const requestedFloor = floorIndex;
    loadMaskImage({ url, scale: SPECULAR_MASK_IMAGE_SCALE, channels: 'rgb' })
      .then((loaded) => {
        loading = false;
        if (!loaded) return; // already logged loudly by the loader
        const rect = getSpecularMaskRect(requestedFloor);
        if (!rect) {
          log.error(`specular mask loaded for floor ${requestedFloor} but the authority served no rect — hidden`);
          return;
        }
        maskTexture?.dispose?.();
        maskTexture = loaded.texture;
        surface.maskTexNode.value = loaded.texture;
        surface.setMaskRect(rect);
        surface.setFloorIndex(requestedFloor);
        loadedUrl = url;
        loadedFloor = requestedFloor;
        contentBoundsWorld = toWorldBounds(loaded.contentBounds, rect);
        maskInfo = {
          url,
          uploaded: `${loaded.width}x${loaded.height}`,
          native: `${loaded.nativeWidth}x${loaded.nativeHeight}`,
          mb: +(loaded.bytes / (1024 * 1024)).toFixed(1),
          // A file with metal painted edge to edge is legitimate and reports
          // the full rect; a file that reports NOTHING painted is the case
          // worth seeing in the report, because the meshes then stay hidden and
          // "no shine" would otherwise look identical to "effect broken".
          painted: contentBoundsWorld ? 'yes' : 'NOTHING PAINTED',
        };
        cropGeometry();
        refreshVisibility();
      })
      .catch((err) => {
        loading = false;
        log.error('specular mask image load rejected —', err);
      });
  }

  /** UV-space content bounds × the mask's world rect → a padded world AABB.
   * @param {object|null} b @param {object} rect @returns {object|null} */
  function toWorldBounds(b, rect) {
    if (!b) return null;
    const w = rect.maxX - rect.minX;
    const h = rect.maxY - rect.minY;
    return {
      minX: rect.minX + b.minU * w - SPECULAR_BOUNDS_PAD_PX,
      minY: rect.minY + b.minV * h - SPECULAR_BOUNDS_PAD_PX,
      maxX: rect.minX + b.maxU * w + SPECULAR_BOUNDS_PAD_PX,
      maxY: rect.minY + b.maxV * h + SPECULAR_BOUNDS_PAD_PX,
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
      // its native GPU buffer — the exact device-loss bug the point-light pool
      // paid for (`reference_bufferattribute_no_dispose_trap`).
      posAttr.needsUpdate = true;
    } else {
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    }
  }

  /**
   * Per-frame. Called from `runSurfaceResponsePass` BEFORE the draw.
   *
   * @param {number} floorIndex - the VIEWED floor.
   * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} viewRect -
   *   the camera's world rect, for the synthesised eye position.
   */
  function sync(floorIndex, viewRect) {
    ensureMaskImage(floorIndex);

    // THE EYE. Pushed every frame and NEVER gated on anything: this is the
    // whole reason a highlight moves when the author pans, so a cached-key
    // skip here would silently restore V2's static look
    // (`feedback_residency_sync_vs_render_loop`, the same class).
    if (viewRect) {
      surface.setViewCentre((viewRect.minX + viewRect.maxX) / 2, (viewRect.minY + viewRect.maxY) / 2);
    }

    // THE SKY, as ONE description of ONE afternoon. Cached on a key because it
    // only changes when the clock or the weather does, unlike the eye.
    const sky = getSkyHandle();
    if (sky?.key) {
      const skyKey = `${sky.version}|${sky.key.azimuthDeg}|${sky.key.elevationDeg}|${sky.key.strength}|${sky.fill?.strength}`;
      if (skyKey !== lastSkyKey) {
        lastSkyKey = skyKey;
        surface.setSky({
          keyDir: keyLightDirection(sky.key),
          keyColor: sky.key.colorRgb ?? [1, 1, 1],
          keyStrength: sky.key.strength ?? 0,
          fillColor: sky.fill?.colorRgb ?? [1, 1, 1],
          fillStrength: sky.fill?.strength ?? 0,
        });
      }
    }

    // THE LOOK PARAMS. Cheap (a string compare against cached uniform writes)
    // and, like water's, NOT gated on any load generation: a slider drag
    // changes no texture and produces no reload, so gating these on the mask
    // would make every control in the panel do nothing.
    const state = getSpecularRenderState();
    const p = state.params ?? {};
    const key = [
      state.enabled ? 1 : 0,
      p.strength,
      p.polish,
      p.metalResponse,
      p.viewerHeight,
      p.relief,
      p.sunGlint,
      p.skySheen,
      p.lampGlint,
      p.lampHeight,
      p.ambientSheen,
    ].join('|');
    if (key !== lastParamsKey) {
      lastParamsKey = key;
      if (Number.isFinite(p.strength)) surface.setStrength(p.strength);
      if (Number.isFinite(p.polish)) surface.setPolish(p.polish);
      if (Number.isFinite(p.metalResponse)) surface.setMetalResponse(p.metalResponse);
      if (Number.isFinite(p.viewerHeight)) surface.setViewerHeight(p.viewerHeight);
      if (Number.isFinite(p.relief)) surface.setRelief(p.relief);
      if (Number.isFinite(p.sunGlint)) surface.setSunGlint(p.sunGlint);
      if (Number.isFinite(p.skySheen)) surface.setSkySheen(p.skySheen);
      if (Number.isFinite(p.lampGlint)) surface.setLampGlint(p.lampGlint);
      if (Number.isFinite(p.lampHeight)) surface.setLampHeight(p.lampHeight);
      if (Number.isFinite(p.ambientSheen)) surface.setAmbientSheen(p.ambientSheen);
      enabled = state.enabled !== false;
      refreshVisibility();
    }
  }

  return {
    /** The dedicated scene `runSurfaceResponsePass` renders. */
    scene,
    sync,
    /** True when there is genuinely something to draw — lets the pass take a
     * true JS early-return rather than issuing a render call for two hidden
     * meshes (Effects.md Law 4: gating by uniform is not gating). */
    hasContent: () => meshes[0].visible,
    getStatus() {
      return {
        visible: meshes[0].visible,
        enabled,
        floor: loadedFloor,
        bounds: contentBoundsWorld,
        // `null`/'not loaded' means no authored `_Specular` for this floor, so
        // the effect is inert BY DESIGN rather than broken — the distinction
        // the report exists to make.
        maskImage: maskInfo ?? 'not loaded',
        // Which branches actually COMPILED. `outdoorsGate: false` means every
        // pixel takes the indoor path regardless of what the map looks like,
        // and `floorGate: false` means metal will draw over upper-floor roofs —
        // both are silent on screen and neither should be guessed at.
        outdoorsGate: surface.outdoorsGateCompiled,
        floorGate: surface.floorGateCompiled,
      };
    },
    dispose() {
      for (const m of meshes) scene.remove(m);
      geometry.dispose(); // shared by both meshes — disposed once, not per mesh
      surface.suppressMaterial?.dispose?.();
      surface.specularMaterial?.dispose?.();
      maskTexture?.dispose?.();
    },
  };
}
