/**
 * FLUID's SURFACE — the mesh, its material, the high-resolution mask, and the
 * bake that turns one into the other.
 *
 * `fluid-render.js` builds the material; this owns the mesh's lifetime and the
 * chain that feeds it. It follows `water-surface-subsystem.js` exactly, for the
 * same three dividends its header lists: the mesh goes into the MAIN `scene`,
 * so painter's-algorithm occlusion, the `gAttr = vec4(0)` contract and the
 * absence of any extra render call all come for free.
 *
 * ============================================================================
 * THE CHAIN, END TO END — THIS IS THE PART THAT WAS MISSING
 * ============================================================================
 * Phases 1–2 built every piece of this and connected none of them, which is
 * exactly the `feedback_seam_default_hides_unwired` shape: a seam declared,
 * defaulted, consumed and never passed renders perfectly, reports healthy and
 * does nothing. The chain now runs:
 *
 *   the mask FILE  ──loadMaskImage──▶  bytes + a texture
 *          bytes   ──extractTubeNet──▶ components, geodesic arc length, profiles
 *            net   ──buildFluidPack──▶ one RGBA buffer
 *           pack   ──createPackTexture──▶ a texture the material samples
 *        texture   ──buildFluidSurfaceMaterial──▶ pixels
 *
 * The mask is fetched ONCE per url and its bytes are reused for the bake, so
 * there is no second decode: `vt/mask-image.js` already had the array in hand
 * and now returns it.
 *
 * ⚠️ **CONSTRUCT THIS AFTER `scene` EXISTS** — trap #4 of
 * `VT-Pan-Viewer-Extraction.md`, hit three times by the instinct to put code
 * next to its siblings. `scene` is a `const` in its temporal dead zone until
 * its own line runs; taking it as an explicit argument makes the ordering a
 * caller-visible requirement rather than an invisible one.
 *
 * ============================================================================
 * WHY THE BAKE TRIGGER IS THE MASK **URL**, AND WHY THERE IS ONLY ONE
 * ============================================================================
 * A previous draft shipped a second module (`fluid-bake.js`) that polled the
 * mask authority's VERSION integer and rebaked on a change — the shape water's
 * body pack uses. Correction #2 then moved the extractor onto the mask FILE,
 * and a file has no version to poll; the two triggers coexisted for exactly one
 * commit before this header was written.
 *
 * That is `feedback_mode_forks_silently_drop_features`, which this project has
 * watched go wrong three times and resolved each time by DELETING THE LOSING
 * FORK. So the version-polling module is gone and the url is the only trigger.
 * It is also the stronger one: a url changes on a floor or scene change and at
 * no other time, so "bakes do not track frames" — Phase 2's exit criterion —
 * holds BY CONSTRUCTION rather than by a comparison that has to be got right.
 * `getStatus()` still reports `bakes` against `syncs` so it can be SEEN to hold.
 *
 * @module effects/fluid/fluid-surface-subsystem
 */

import { createLogger } from '../../core/log.js';
import { buildFluidSurfaceMaterial } from './fluid-render.js';
import { extractTubeNet } from './fluid-net.js';
import { buildFluidPack, FLUID_PACK_MAX_DIM } from './fluid-pack.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';

const log = createLogger('FluidSurface');

/**
 * Render order. Above the floor background (always index 0 of the sorted list)
 * and below tokens, tiles and roofs.
 *
 * ⚠️ **0.6, i.e. just ABOVE water's 0.5, and this is the ADD half only.** The
 * design's authored placement (`Fluid.md` §5.6) is that ABSORPTION goes UNDER
 * the tile albedo — V2's "under the texture" look, where the art carries the
 * glass and the effect carries what is inside it — while EMISSION goes OVER,
 * because a highlight on glass is physically on top of it. This module draws
 * only the emissive half today, so it sits above, which is correct for what it
 * is and NOT a quiet abandonment of the under-art rule. The multiply half is
 * the next rung and it draws below.
 *
 * Fractional on purpose: `sortByLayer` owns the integers, so fluid claims none
 * and cannot collide with one. A real LayerKey is the honest fix and is a
 * deferred rung, the same caveat water and the door leaves carry.
 */
const FLUID_RENDER_ORDER = 0.6;

/** Padding on the tubes' measured AABB, world px — enough that the mesh never
 * clips its own antialiased silhouette or the glow spilling past it. */
const FLUID_BOUNDS_PAD_PX = 48;

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported.
 * @param {*} args.scene - the MAIN scene. Must already exist (see header).
 * @param {(floorIndex: number) => string|null} args.getFluidMaskUrl - the
 *   resolved floor's authored fluid file. Null = no mask, which keeps the
 *   surface hidden rather than drawing something invented.
 * @param {(url: string) => Promise<object|null>} args.loadMaskImage -
 *   `vt/mask-image.js`'s loader, injected for the directory-wall reason.
 * @param {(data: Uint16Array|Float32Array, w: number, h: number) => *} args.createPackTexture -
 *   the literal `new THREE.DataTexture(...)`, defined in `vt/`
 *   (`gpu/textures-in-vt-only`).
 * @param {() => {minX:number,minY:number,maxX:number,maxY:number}} args.getSceneRect -
 *   the world rect the mask file covers.
 * @param {() => {enabled: boolean, params: object}} [args.getFluidRenderState]
 * @param {*} args.timeMsNode - THE SHARED CLOCK, for the shader.
 * @returns {{sync: (floorIndex: number) => void, getStatus: () => object, dispose: () => void}}
 */
export function createFluidSurfaceSubsystem({
  THREE,
  scene,
  getFluidMaskUrl,
  loadMaskImage,
  createPackTexture,
  getSceneRect,
  getFluidRenderState,
  timeMsNode,
}) {
  // ⚠️ NO DEFAULT that fakes a wired seam. `feedback_seam_default_hides_unwired`
  // is the wall here: water shipped `getWaterRenderState` declared, defaulted
  // and never passed, and the ONLY symptom was that every control silently did
  // nothing while all 4,137 tests passed. An absent seam is reported, loudly,
  // once — not papered over with a plausible default.
  let seamWarned = false;
  function renderState() {
    if (typeof getFluidRenderState === 'function') return getFluidRenderState();
    if (!seamWarned) {
      seamWarned = true;
      log.error(
        'getFluidRenderState was not passed — every fluid control will do nothing. This is a WIRING ' +
          'fault in boot.js, not a missing feature (feedback_seam_default_hides_unwired).'
      );
    }
    return { enabled: true, params: {} };
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  geometry.setIndex(Array.from(QUAD_INDICES));

  /** A 1×1 empty pack until the real one bakes. Never sampled — `mesh.visible`
   * is the gate, JS-side, so the shader needs no "do I have data yet" uniform
   * (`tsl/no-uniform-gates`). */
  let packTexture = createPackTexture(new Float32Array([0, 0, 0, 0]), 1, 1);
  let maskTexture = null;
  let loadedUrl = null;
  let loading = false;
  let bounds = null;
  let net = null;
  let pack = null;
  let lastParamsKey = '';
  let enabled = true;
  let built = null;
  /** Accounting the deleted `fluid-bake.js` used to own — kept because the
   * exit criterion has to be VISIBLE, not merely true. */
  let syncs = 0;
  let bakes = 0;
  /** @type {any} */
  let mesh = null;

  function refreshVisibility() {
    if (mesh) mesh.visible = enabled && !!bounds && !!loadedUrl && !!net && net.tubeCount > 0;
  }

  /**
   * Fetch the mask, run the whole bake, and build (or re-point) the material.
   * @param {string} url
   */
  async function loadAndBake(url) {
    loading = true;
    try {
      const image = await loadMaskImage(url);
      if (!image || !image.data) {
        log.error(`fluid mask failed to load: ${url}`);
        return;
      }
      // Guard the await gap: a floor switch during the fetch would otherwise
      // bake the old floor's mask over the new one's. `feedback_plausible_
      // diagnosis_rots` names the await gap as where this class of bug lives.
      if (url !== loadedUrl) return;

      maskTexture = image.texture;
      const rect = getSceneRect();
      const rectW = rect.maxX - rect.minX;
      const rectH = rect.maxY - rect.minY;

      // The extractor runs on the FILE's pixels (Fluid.md correction #2 — the
      // ≤512 derivation grid merges tubes a tube's width apart), capped at the
      // pack resolution so the bake stays bounded on a huge mask.
      const scale = Math.min(1, FLUID_PACK_MAX_DIM / Math.max(image.width, image.height));
      const grid = downsample(image.data, image.width, image.height, scale, rectW, rectH, rect);

      // NOT TIMED HERE, deliberately. `time/one-clock` is a ratcheted rule and
      // a wall-clock read inside an effect is exactly what it bans; the shared
      // clock cannot substitute, because it only advances per FRAME and this
      // bake is synchronous inside one callback, so it would report 0.0 ms
      // forever — a lying instrument, which is worse than no instrument
      // (`feedback_instruments_must_not_lie`). The cost IS known and recorded:
      // ~365 ms for twelve tubes at full pack resolution, measured in Node in
      // `fluid-net.js`'s own header. If it ever needs watching live, that is a
      // profiler's job and `diag/` is where clock reads are permitted.
      net = extractTubeNet({ grid });
      pack = buildFluidPack({ net });
      bakes++;

      for (const w of net.warnings) log.warn(`bake: ${w}`);
      if (net.tubeCount > 0 && pack.maxTubeWidthTexels < 4) {
        log.warn(
          `widest tube is only ${pack.maxTubeWidthTexels.toFixed(1)} pack texels across. Below ~4 the ` +
            'cross-section gradient collapses and tubes shade flat; below ~2 adjacent tubes merge into ' +
            'one flow. Paint wider tubes or raise FLUID_PACK_MAX_DIM.'
        );
      }

      packTexture = createPackTexture(pack.data, pack.width, pack.height);

      // Crop the mesh to the tubes' AABB — Law 6: cost scales with COVERED
      // pixels, not screen pixels. A fullscreen quad for tubes covering 2% of
      // the view is an O(screen) violation wearing a disguise.
      bounds = tubeBounds(net, rect, FLUID_BOUNDS_PAD_PX);
      if (!bounds) {
        log.warn(`fluid mask has no tubes after extraction: ${url}`);
        refreshVisibility();
        return;
      }

      buildMesh(rect);
      log.info(`fluid baked: ${net.tubeCount} tube(s), widest ${pack.maxTubeWidthTexels.toFixed(1)} pack texels`);
    } finally {
      loading = false;
      refreshVisibility();
    }
  }

  /** @param {{minX:number,minY:number,maxX:number,maxY:number}} rect */
  function buildMesh(rect) {
    if (mesh) {
      scene.remove(mesh);
      built?.material?.dispose?.();
      mesh = null;
    }
    const p = renderState().params ?? {};
    built = buildFluidSurfaceMaterial({
      THREE,
      maskTexture,
      maskRect: rect,
      packTexture,
      packRect: rect,
      timeMsNode,
      ...pickParams(p),
    });
    // FOUR CORNERS, counter-clockwise — `buildQuadPositions` takes a corner
    // LIST and throws on anything else, which is what caught the first draft
    // handing it the AABB rect directly. Same order water uses; the winding has
    // to match `QUAD_INDICES` or the quad is inside-out (and `DoubleSide` on the
    // material would hide that rather than fix it).
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        buildQuadPositions([
          { x: bounds.minX, y: bounds.minY },
          { x: bounds.maxX, y: bounds.minY },
          { x: bounds.maxX, y: bounds.maxY },
          { x: bounds.minX, y: bounds.maxY },
        ]),
        3
      )
    );
    geometry.attributes.position.needsUpdate = true;
    geometry.computeBoundingSphere();
    mesh = new THREE.Mesh(geometry, built.material);
    mesh.name = 'FluidSurface';
    mesh.renderOrder = FLUID_RENDER_ORDER;
    mesh.frustumCulled = false;
    scene.add(mesh);
    lastParamsKey = '';
    refreshVisibility();
  }

  /** Only the keys the material takes, so an unknown param cannot ride in. */
  function pickParams(p) {
    const out = {};
    if (Array.isArray(p.tint)) out.tint = p.tint;
    if (Number.isFinite(p.glow)) out.glow = p.glow;
    if (Number.isFinite(p.speedPx)) out.speedPx = p.speedPx;
    if (Number.isFinite(p.slugCount)) out.slugCount = p.slugCount;
    if (Number.isFinite(p.slugWidth)) out.slugWidth = p.slugWidth;
    if (Number.isFinite(p.iridescence)) out.iridescence = p.iridescence;
    if (Number.isFinite(p.opacity)) out.opacity = p.opacity;
    return out;
  }

  /**
   * Per-frame. Cheap to call: one string compare when nothing changed.
   * @param {number} floorIndex
   */
  function sync(floorIndex) {
    syncs++;
    const state = renderState();
    enabled = state.enabled !== false;

    const url = getFluidMaskUrl(floorIndex);
    if (url !== loadedUrl && !loading) {
      loadedUrl = url;
      net = null;
      pack = null;
      bounds = null;
      refreshVisibility();
      if (url) loadAndBake(url);
    }

    if (!built) return;
    const p = state.params ?? {};
    const key = JSON.stringify([p.tint, p.glow, p.speedPx, p.slugCount, p.slugWidth, p.iridescence, p.opacity]);
    if (key === lastParamsKey) {
      refreshVisibility();
      return;
    }
    lastParamsKey = key;
    const u = built.uniforms;
    if (Array.isArray(p.tint)) u.uTint.value.set(p.tint[0], p.tint[1], p.tint[2]);
    if (Number.isFinite(p.glow)) u.uGlow.value = p.glow;
    if (Number.isFinite(p.speedPx)) u.uSpeedPx.value = p.speedPx;
    if (Number.isFinite(p.slugCount)) u.uSlugCount.value = p.slugCount;
    if (Number.isFinite(p.slugWidth)) u.uSlugWidth.value = p.slugWidth;
    if (Number.isFinite(p.iridescence)) u.uIridescence.value = p.iridescence;
    if (Number.isFinite(p.opacity)) u.uOpacity.value = p.opacity;
    refreshVisibility();
  }

  function getStatus() {
    return {
      enabled,
      // THE EXIT CRITERION, as two numbers a reader can compare at a glance.
      syncs,
      bakes,
      bakesPerThousandSyncs: syncs > 0 ? Number(((bakes / syncs) * 1000).toFixed(2)) : 0,
      hasMask: !!loadedUrl,
      maskUrl: loadedUrl,
      loading,
      meshVisible: !!mesh && mesh.visible,
      tubeCount: net ? net.tubeCount : 0,
      maxTubeWidthTexels: pack ? pack.maxTubeWidthTexels : 0,
      packSize: pack ? `${pack.width}x${pack.height}` : null,
      bounds,
      warnings: net ? net.warnings : [],
      tubes: net
        ? net.tubes.map((t) => ({
            id: t.id,
            lengthPx: Math.round(t.lengthPx),
            orientedBy: t.orientedBy,
            hintCorrelation: Number(t.hintCorrelation.toFixed(3)),
            maxRadiusPx: Math.round(t.maxRadiusPx),
            offPathFraction: Number(t.offPathFraction.toFixed(3)),
          }))
        : [],
    };
  }

  function dispose() {
    if (mesh) scene.remove(mesh);
    built?.material?.dispose?.();
    geometry.dispose();
    mesh = null;
  }

  return { sync, getStatus, dispose };
}

/**
 * Box-downsample the mask's R bytes to at most `FLUID_PACK_MAX_DIM` on the long
 * side, wrapped as the `{spec, data}` grid `extractTubeNet` takes.
 *
 * ⚠️ **MAX, not mean.** A mean would let a thin tube fade below the presence
 * threshold as it is downsampled and vanish entirely; taking the max of the
 * source texels keeps a one-pixel-wide painted tube present at every scale,
 * which is the whole point of running the extractor here rather than on the
 * derivation grid.
 *
 * ⚠️ **Row 0 is the image's TOP** (`flipY: false`, the world-quad convention
 * every tile in this renderer uses), and the grid's V therefore runs the same
 * way as the texture's. Getting this wrong flips the tubes vertically —
 * `feedback_y_flip_recurring_risk`, this repo's named recurring bug class, and
 * the reason the mapping is stated here rather than assumed.
 */
export function downsample(src, srcW, srcH, scale, rectW, rectH, rect) {
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const data = new Uint8Array(w * h);
  const sx = srcW / w;
  const sy = srcH / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(srcH, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(srcW, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let m = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const v = src[yy * srcW + xx];
          if (v > m) m = v;
        }
      }
      data[y * w + x] = m;
    }
  }
  return {
    spec: { x: rect.minX, y: rect.minY, width: rectW, height: rectH, w, h, texelW: rectW / w, texelH: rectH / h },
    data,
  };
}

/** The tubes' world AABB, padded — the crop that keeps this O(covered). */
export function tubeBounds(net, rect, padPx) {
  const { w, h } = net.spec;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < net.tubeIdByTexel.length; i++) {
    if (net.tubeIdByTexel[i] === 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  const spanX = rect.maxX - rect.minX;
  const spanY = rect.maxY - rect.minY;
  return {
    minX: rect.minX + (minX / w) * spanX - padPx,
    maxX: rect.minX + ((maxX + 1) / w) * spanX + padPx,
    minY: rect.minY + (minY / h) * spanY - padPx,
    maxY: rect.minY + ((maxY + 1) / h) * spanY + padPx,
  };
}
