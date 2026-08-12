/**
 * SHINE'S SURFACE — the mesh, its own scene, the mask, the island pack and the
 * AABB crop.
 *
 * `specular-render.js` builds the materials; this owns their lifetime and the
 * per-frame push. It follows `water-surface-subsystem.js`'s shape closely, and
 * the two places it deliberately does not are both worth knowing.
 *
 * ============================================================================
 * ITS OWN SCENE, NOT THE MAIN ONE — AND THAT COSTS SOMETHING REAL
 * ============================================================================
 * Water's surface joins the main `scene` and gets three dividends free:
 * occlusion by paint order, the zero-attr MRT contract, and no extra render
 * call. Shine cannot take any of them, because it reads `buf:scene.illum` and
 * that does not exist until `light.accumulate` has run. So it gets its own
 * `THREE.Scene`, drawn by `runSurfaceResponsePass` into `scene.lit` — the same
 * arrangement `point-light-pool.js` uses for its two dedicated scenes, and for
 * the same reason. The cost is that occlusion becomes explicit work.
 *
 * ============================================================================
 * ONE MESH, NOT TWO (2026-07-27)
 * ============================================================================
 * A diffuse knock-down used to draw beside the shine, so a conductor could
 * suppress the map art it replaces. It is gone. V2 had no such pass and looked
 * right without one; the multiply cost a second material, a second draw and
 * another way to half-fail — suppression drawing with no highlight reads as a
 * shader bug rather than as a missing mask. Recorded as a deferred rung.
 *
 * ============================================================================
 * ⚠️ THE AABB COMES FROM THE FILE, NOT FROM A GRID
 * ============================================================================
 * Effects.md Law 6: cost scales with COVERED pixels, and metal covers a few
 * percent of a typical map. The bounds come from `vt/mask-image.js`'s own pass
 * over the decoded file, measured by MAX of RGB rather than by red — a
 * blue-painted steel object has `r = 0` and measuring by red would crop it out
 * of existence.
 *
 * @module effects/specular/specular-surface-subsystem
 */

import { createLogger } from '../../core/log.js';
import {
  buildSpecularSurfaceMaterial,
  SPECULAR_MASK_IMAGE_SCALE,
  SPECULAR_DEFAULT_ISLAND_SPREAD,
} from './specular-render.js';
import { keyLightDirection, describeSpecularMapping } from './specular-material.js';
import { buildSpecularIslandPack } from './specular-islands.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';

const log = createLogger('SpecularSurface');

/** Padding on the measured AABB, world px. The mask uploads at
 * `SPECULAR_MASK_IMAGE_SCALE`, so the outermost painted texel covers a couple
 * of world px the bounds arithmetic rounds off; a small pad means a highlight
 * can never be clipped by its own crop. */
const SPECULAR_BOUNDS_PAD_PX = 8;

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported.
 * @param {(floorIndex: number) => string|null} args.getSpecularMaskUrl
 * @param {(floorIndex: number) => object|null} args.getSpecularMaskRect
 * @param {(opts: object) => Promise<object|null>} args.loadMaskImage
 * @param {(data: Uint8Array, w: number, h: number, filter: string) => *} args.createMaskTexture -
 *   the literal `new THREE.DataTexture(...)`, writable only in `vt/`.
 * @param {(data: Float32Array, w: number, h: number) => *} args.createPackTexture -
 *   the island pack's own uploader. ⚠️ MUST use NearestFilter — see `bakeIslandPack`.
 * @param {*} args.illumTexture - `buf:scene.illum`.
 * @param {*} [args.depthTexture] - `buf:scene.depth`'s DEPTH attachment; null
 *   compiles the floor gate out. STAGE 3 (2026-08-05) — replaces `attrTexture`.
 * @param {(floorIndex: number) => number} [args.resolveExpectedDepth] - given
 *   the VIEWED floor, returns `computeTieSafeExpectedDepth` for THIS quad's
 *   OWN background item's rank. Composed in `vt-pan-viewer.js` from
 *   `depthAuthority.rankOf` + `getSpecularBackgroundItemId`, the SAME shape
 *   `point-light-pool.js`'s own `resolveExpectedDepth` callback already
 *   proved — this subsystem never touches `depthAuthority` directly. Called
 *   every frame from `sync`, never cached: see that call site's own comment
 *   for why a floor's own rank is not the static quantity `uFloorIndex01`
 *   used to be.
 * @param {*} args.uViewRect @param {*} args.uOutdoorsRect @param {*} args.outdoorsTexNode
 * @param {Function} args.buildOutdoorsGate
 * @param {*} args.timeMsNode - THE shared clock (`uGlobalTimeMs`), never a private one.
 * @param {() => object} [args.getSpecularRenderState] - the look/enable seam.
 * @param {() => object|null} [args.getSkyHandle] - the sun's azimuth, for the
 *   outdoor grain bias. The ONE description of the outdoor light.
 * @returns {{scene: *, sync: Function, getStatus: Function, dispose: Function}}
 */
export function createSpecularSurfaceSubsystem({
  THREE,
  getSpecularMaskUrl,
  getSpecularMaskRect,
  loadMaskImage,
  createMaskTexture,
  createPackTexture,
  illumTexture,
  depthTexture = null,
  resolveExpectedDepth,
  uViewRect,
  uOutdoorsRect,
  outdoorsTexNode,
  buildOutdoorsGate,
  timeMsNode,
  getSpecularRenderState,
  getSkyHandle,
  // The island-pack bake (buildSpecularIslandPack — a connected-component
  // labelling pass over up to 512x512 texels) is triggered from INSIDE this
  // subsystem (a mask-load continuation, or a live islandSpread change), never
  // from a synchronous call site in vt-pan-viewer.js the way water's bake is
  // — so unlike every other zone in this codebase, there is no outside call
  // to bracket. `profiler` lets bakeIslandPack bracket itself instead
  // (perf-zone-coverage-audit, 2026-08-06: this bake ran with zero profiler
  // coverage despite firing on every mask load and every islandSpread drag).
  // `beginById`/`endById` (the string form, not `Z`'s pre-resolved integer
  // form): this subsystem is constructed BEFORE vt-pan-viewer.js's own `Z`
  // lookup table exists, and a bake is rare enough that resolving the id by
  // string on each call — exactly frame-profiler.js's documented "cold call
  // sites" use case — costs nothing worth avoiding.
  profiler = null,
}) {
  // ⚠️ `seams/viewer-wired` exists because water shipped exactly this shape
  // DECLARED, defaulted, consumed and never passed — every control dead, every
  // test green (`feedback_seam_default_hides_unwired`).
  getSpecularRenderState ??= () => ({ enabled: true, params: {} });
  getSkyHandle ??= () => null;
  resolveExpectedDepth ??= () => 0;

  /** A dedicated scene — see the header. */
  const scene = new THREE.Scene();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  geometry.setIndex(Array.from(QUAD_INDICES));

  /** 1×1 placeholders until the real files decode. The mesh stays hidden until
   * then, so neither is ever sampled — which is why the shader needs no "do I
   * have a mask yet" uniform gate (`tsl/no-uniform-gates`): `mesh.visible` IS
   * the gate, JS-side. The pack's placeholder is `(1, 0)` — the GLOBAL parallax
   * — because a zero there would freeze the pattern solid, which looks exactly
   * like the effect having died. */
  let maskTexture = createMaskTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, 'linear');
  let islandPackTexture = createPackTexture(new Uint8Array([191, 128, 0, 0]), 1, 1);
  let maskInfo = null;
  let islandInfo = null;
  /** Mirrors the value last pushed to `surface.setIslandBakeStatus`, so the
   * JS-side report can be cross-checked against what channel 6 is actually
   * showing without needing GPU access. 0 = never baked. */
  let islandBakeStatus = 0;
  let loadedUrl = null;
  let loadedFloor = -1;
  let loading = false;
  /** The world AABB of what is actually painted, or null while unknown. */
  let contentBoundsWorld = null;
  let enabled = true;
  let lastParamsKey = '';
  let lastSkyKey = '';
  /** Which debug intermediate is on screen — 0 = the effect as it ships. */
  let debugChannel = 0;
  let loadedMaskRect = null;
  let loadedContentBoundsUv = null;
  /** The crop's extent in mask-UV space — the ENTIRE mask lookup. */
  let paddedBoundsUv = null;
  let lastViewRect = null;
  /** The decoded mask bytes, held only until the pack is baked from them.
   * Released immediately after: a full-resolution RGBA buffer is tens of MB and
   * nothing needs it once the labels are packed. */
  let pendingBytes = null;
  // BAKE-COUNT HEALTH (cache-completeness pass, 2026-08-12) — bakeIslandPack
  // has no internal skip branch of its own (the `!pendingBytes` guard just
  // below is a one-time "no mask loaded yet" startup gate, never cleared
  // again after the first load — see `pendingBytes`' own comment — so
  // counting it as an ongoing hit would be a fabrication). Its TWO call
  // sites (a mask-load continuation vs. a live islandSpread drag) have
  // incomparable upstream gating, so — same doctrine as
  // vt-pan-viewer.js's bakeWindField — this is a MISSES-only lifetime tally,
  // not a hits/misses pair.
  let islandPackBakeCount = 0;
  /** The author's island spread, so a slider change can rebake. Bootstrap
   * value only — overwritten by the first real sync below; imported rather
   * than hand-typed so it can never silently drift from the shipped default
   * (found unwired to ANY consumer, ROUND 18, 2026-08-03 — declared,
   * exported, and used by nothing until this line). */
  let islandSpread = SPECULAR_DEFAULT_ISLAND_SPREAD;

  const surface = buildSpecularSurfaceMaterial({
    THREE,
    maskTexture,
    islandPackTexture,
    illumTexture,
    depthTexture,
    uViewRect,
    uOutdoorsRect,
    outdoorsTexNode,
    buildOutdoorsGate,
    timeMsNode,
  });

  // ONE MESH, ADDITIVE — see the header for why the multiply pass is gone.
  const mesh = new THREE.Mesh(geometry, surface.specularMaterial);
  mesh.frustumCulled = false; // world-space; the camera rect moves every frame
  mesh.visible = false; // until the mask AND its rect land
  scene.add(mesh);

  /**
   * The ONE place visibility is decided, so the conditions cannot drift apart
   * across the call sites that each learn about one of them.
   *
   * It also owns the DEBUG SWAP: at a non-zero channel the mesh draws
   * `debugMaterial` OPAQUE instead of the additive shine. At channel 0 that
   * material is attached to nothing, which is what makes the instrument
   * genuinely free rather than merely cheap.
   */
  function refreshVisibility() {
    mesh.visible = enabled && !!loadedUrl && !!contentBoundsWorld;
    mesh.material = debugChannel > 0 ? surface.debugMaterial : surface.specularMaterial;
  }

  /**
   * Label the mask's connected regions and upload their parallax.
   *
   * ⚠️ **NearestFilter, and it is not a preference.** Interpolating parallax
   * vectors across an island boundary produces a motion that belongs to neither
   * island, in a band around every object — the same reasoning that makes
   * water's jump-flood ping-pong targets nearest. `createPackTexture` owns that
   * choice; this comment is here because the consequence is invisible until
   * someone changes it.
   *
   * Baked from the bytes rather than re-fetched: `loadMaskImage` already
   * decoded the file, and a second decode of a 10k-wide PNG to answer a
   * question the first decode could have answered is pure latency.
   *
   * @param {number} spread
   */
  function bakeIslandPack(spread) {
    if (!pendingBytes) return;
    islandPackBakeCount += 1;
    profiler?.beginById('surface.specularIslandBake');
    try {
      const pack = buildSpecularIslandPack({
        rgba: pendingBytes.data,
        width: pendingBytes.width,
        height: pendingBytes.height,
        spread,
      });
      islandPackTexture?.dispose?.();
      islandPackTexture = createPackTexture(pack.data, pack.w, pack.h);
      surface.setIslandPackTexture(islandPackTexture);
      // Debug channel 6's own status — set ONLY on a successful bake, so a
      // THROW below (caught further down) leaves it at whatever it already
      // was rather than claiming success: never-baked stays 0, a re-bake that
      // fails after an earlier good one keeps reporting the LAST good state
      // rather than silently reverting to "never baked".
      islandBakeStatus = pack.islandCount > 0 ? 2 : 1;
      surface.setIslandBakeStatus(islandBakeStatus);
      islandInfo = {
        grid: `${pack.w}x${pack.h}`,
        // The same two numbers UNFORMATTED, because `grid` is a display string
        // and `getStatus().coverage` needs to divide by the real grid area.
        // Added 2026-07-28 rather than parsing the string back out — a consumer
        // that re-parses a formatted field is one rename away from silently
        // reading null (`feedback_read_the_producer_never_invent_its_shape`,
        // which this very field caught me committing again).
        gridW: pack.w,
        gridH: pack.h,
        islands: pack.islandCount,
        droppedSmall: pack.droppedSmall,
        // A file whose metal labels to ZERO islands still renders — every texel
        // takes the global parallax — so this number is the difference between
        // "per-object motion is working" and "it silently degraded to V2's
        // one-frame-for-everything", which is invisible on screen.
        labelledTexels: pack.labelledTexels,
        // BEFORE the merge step ran — the gap between this and
        // `islands + droppedSmall` is how many separate specks clustering
        // joined together. Live-diagnosed 2026-07-27: a scatter of coin-sized
        // detail a texel or two apart is individually sub-threshold and was
        // being dropped in full, reporting `islands: 0` with no bake error at
        // all — this number is what makes that distinguishable from "there
        // really was nothing to find" without guessing.
        preClusterComponents: pack.preClusterComponents,
        estimatedPerIslandGridFraction: pack.estimatedPerIslandGridFraction,
      };
    } catch (err) {
      // Loud, and the effect still draws: the pack's placeholder is the global
      // parallax, so a failed bake costs per-object variety and nothing else.
      log.error('specular island pack bake failed — falling back to global parallax:', err);
    } finally {
      profiler?.endById('surface.specularIslandBake');
    }
  }

  /**
   * Load the floor's authored specular file, crop the quad to whatever is
   * painted in it, and bake the island pack. Async and idempotent; the mesh
   * stays hidden until it lands, which needs no shader-side fallback.
   * @param {number} floorIndex
   */
  function ensureMaskImage(floorIndex) {
    const url = getSpecularMaskUrl(floorIndex);
    // ⚠️ THE VIEWED FLOOR HAS NO MASK OF ITS OWN — clear whatever an EARLIER
    // floor left behind, rather than leaving it up. Live bug, 2026-08-03: this
    // subsystem tracks exactly ONE floor's quad (its geometry, its mask), set
    // only when a NEW mask successfully loads. Without this branch, switching
    // to a floor with no `_Specular` authored left the PREVIOUS floor's quad
    // fully intact — visible, still sampling its own real mask (so
    // `mask`/`tint`/`presence` keep reading real, plausible values, since
    // floors share the same x,y footprint), gated by whatever rank THAT
    // floor's background item happened to resolve to — no longer this floor's
    // own background, once `resolveExpectedDepth` is fed the NEW `floorIndex`
    // (STAGE 3, 2026-08-05 — the same rank comparison that used to be
    // `floorMatch` reading 0 under the old `attrTexture` gate). `strength` at
    // any value would change nothing either way, which is indistinguishable
    // from the effect being dead. Hiding the mesh here is the honest state: no
    // `_Specular` is authored for what is actually on screen via the
    // background-image path.
    if (!url) {
      if (loadedUrl !== null || contentBoundsWorld !== null) {
        loadedUrl = null;
        loadedFloor = -1;
        contentBoundsWorld = null;
        paddedBoundsUv = null;
        refreshVisibility();
      }
      return;
    }
    // Keyed on floor AS WELL AS url: two floors can legitimately share a file
    // path in a scene built by duplication, and re-reading the rect on a floor
    // switch is what keeps the mapping right when they do.
    if (loading || (url === loadedUrl && floorIndex === loadedFloor)) return;
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
        surface.setMaskTexture(loaded.texture);
        loadedUrl = url;
        loadedFloor = requestedFloor;
        loadedMaskRect = rect;
        loadedContentBoundsUv = loaded.contentBounds ?? null;
        contentBoundsWorld = toWorldBounds(loaded.contentBounds, rect);
        // THE MASK LOOKUP'S ONLY INPUT, derived from the SAME world bounds the
        // quad is cropped to rather than from `contentBounds` directly — so the
        // AABB pad is carried automatically and the two can never disagree
        // about where the quad's edges are.
        paddedBoundsUv = toUvBounds(contentBoundsWorld, rect);
        if (paddedBoundsUv) surface.setMaskUvBounds(paddedBoundsUv);
        pendingBytes = loaded.data ? { data: loaded.data, width: loaded.width, height: loaded.height } : null;
        bakeIslandPack(islandSpread);
        maskInfo = {
          url,
          uploaded: `${loaded.width}x${loaded.height}`,
          native: `${loaded.nativeWidth}x${loaded.nativeHeight}`,
          mb: +(loaded.bytes / (1024 * 1024)).toFixed(1),
          // A file with metal painted edge to edge is legitimate and reports
          // the full rect; a file reporting NOTHING painted is the case worth
          // seeing, because the mesh then stays hidden and "no shine" would
          // otherwise look identical to "effect broken".
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

  /**
   * The PADDED world AABB back into mask-UV space — the exact inverse of
   * `toWorldBounds`, and the only thing the shader's mask lookup consumes.
   *
   * Taking the round trip rather than returning `contentBounds` unchanged is
   * the point: `toWorldBounds` adds the pad, so the quad is slightly LARGER
   * than the painted content, and handing the shader the unpadded bounds would
   * sample the mask slightly zoomed-in — every glint shifted by a few world px,
   * an error that looks like nothing and is impossible to unsee once found.
   *
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
      // its native GPU buffer (`reference_bufferattribute_no_dispose_trap`).
      posAttr.needsUpdate = true;
    } else {
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    }
  }

  /**
   * Per-frame, called from `runSurfaceResponsePass` BEFORE the draw.
   * @param {number} floorIndex - the VIEWED floor.
   * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} viewRect
   */
  function sync(floorIndex, viewRect) {
    ensureMaskImage(floorIndex);

    // THE EXPECTED DEPTH — STAGE 3 (2026-08-05). Pushed every frame and NEVER
    // gated on a cached key, unlike the old `uFloorIndex01` (a static property
    // of whichever mask happened to load, set once in `ensureMaskImage`'s own
    // `.then()`): this quad's own background item can change RANK whenever
    // the depth authority rebuilds — a residency pass, a pan, any item added
    // or removed — the exact staleness class the vegetation flicker fix
    // (2026-08-05, `docs/planning/Depth-Buffer.md` §9h) already found and
    // fixed for a different consumer. Harmless to call even while the mesh is
    // hidden (no mask loaded yet, or `depthTexture` was never wired) — it
    // only ever writes a uniform `setExpectedDepth` owns clamping for.
    surface.setExpectedDepth(resolveExpectedDepth(floorIndex));

    // THE CAMERA. Pushed every frame and NEVER gated on a cached key: this is
    // the whole reason the shimmer moves when the author pans, so a skip here
    // would silently restore a painted-on look
    // (`feedback_residency_sync_vs_render_loop`, the same class).
    if (viewRect) {
      surface.setViewCentre((viewRect.minX + viewRect.maxX) / 2, (viewRect.minY + viewRect.maxY) / 2);
      lastViewRect = viewRect;
    }

    // THE SUN'S AZIMUTH — one unit vector, the only route its direction has
    // into this effect. Cached on a key because it moves with the clock, not
    // with the camera.
    const sky = getSkyHandle();
    if (sky?.key) {
      const skyKey = `${sky.version}|${sky.key.azimuthDeg}|${sky.key.elevationDeg}`;
      if (skyKey !== lastSkyKey) {
        lastSkyKey = skyKey;
        const dir = keyLightDirection(sky.key);
        surface.setSunDir(dir[0], dir[1]);
      }
    }

    // THE LOOK PARAMS. A string compare against cached uniform writes, and NOT
    // gated on any load generation: a slider drag changes no texture and
    // produces no reload, so gating these on the mask would make every control
    // in the panel do nothing.
    const state = getSpecularRenderState();
    const p = state.params ?? {};
    const layerParams = state.layers ?? [];
    const key = [
      state.enabled ? 1 : 0,
      state.debugChannel ?? 0,
      p.strength,
      p.saturation,
      p.shimmerGain,
      p.patternScalePx,
      p.lightFloor,
      p.parallaxStrength,
      p.islandSpread,
      p.driftSpeed,
      p.pulse,
      p.sunBias,
      p.sheenCeiling,
      p.glintCeiling,
      p.incidentSteepness,
      // ⚠️ EVERY param pushed below MUST also appear in this key. It is an
      // early-out cache: a param missing here is one whose changes are simply
      // never applied after the first frame, with no error anywhere.
      p.incidentKnee,
      p.kneeSoftness,
      p.incidentGain,
      p.flickerAmount,
      p.flickerSpeed,
      p.flickerScalePx,
      p.flickerRoughness,
      JSON.stringify(layerParams),
    ].join('|');
    if (key === lastParamsKey) return;
    lastParamsKey = key;

    if (Number.isFinite(p.strength)) surface.setStrength(p.strength);
    if (Number.isFinite(p.saturation)) surface.setSaturation(p.saturation);
    if (Number.isFinite(p.shimmerGain)) surface.setShimmerGain(p.shimmerGain);
    if (Number.isFinite(p.patternScalePx)) surface.setPatternScale(p.patternScalePx);
    if (Number.isFinite(p.lightFloor)) surface.setLightFloor(p.lightFloor);
    if (Number.isFinite(p.parallaxStrength)) surface.setParallaxStrength(p.parallaxStrength);
    if (Number.isFinite(p.driftSpeed)) surface.setDriftSpeed(p.driftSpeed);
    if (Number.isFinite(p.sheenCeiling)) surface.setSheenCeiling(p.sheenCeiling);
    if (Number.isFinite(p.glintCeiling)) surface.setGlintCeiling(p.glintCeiling);
    if (Number.isFinite(p.incidentSteepness)) surface.setIncidentSteepness(p.incidentSteepness);
    if (Number.isFinite(p.incidentKnee)) surface.setIncidentKnee(p.incidentKnee);
    if (Number.isFinite(p.kneeSoftness)) surface.setKneeSoftness(p.kneeSoftness);
    if (Number.isFinite(p.incidentGain)) surface.setIncidentGain(p.incidentGain);
    if (Number.isFinite(p.flickerAmount)) surface.setFlickerAmount(p.flickerAmount);
    if (Number.isFinite(p.flickerSpeed)) surface.setFlickerSpeed(p.flickerSpeed);
    if (Number.isFinite(p.flickerScalePx)) surface.setFlickerScalePx(p.flickerScalePx);
    if (Number.isFinite(p.flickerRoughness)) surface.setFlickerRoughness(p.flickerRoughness);
    if (Number.isFinite(p.pulse)) surface.setPulse(p.pulse);
    if (Number.isFinite(p.sunBias)) surface.setSunBias(p.sunBias);

    for (let i = 0; i < layerParams.length; i++) {
      const L = layerParams[i] ?? {};
      if (Number.isFinite(L.density)) surface.setLayerDensity(i, L.density);
      if (Number.isFinite(L.grainAngleDeg)) surface.setLayerGrainAngle(i, L.grainAngleDeg);
      if (Number.isFinite(L.streak)) surface.setLayerStreak(i, L.streak);
      if (Number.isFinite(L.softness)) surface.setLayerSoftness(i, L.softness);
      if (Number.isFinite(L.rowSpacing)) surface.setLayerRowSpacing(i, L.rowSpacing);
      if (Number.isFinite(L.contrast)) surface.setLayerContrast(i, L.contrast);
      if (Number.isFinite(L.strength)) surface.setLayerStrength(i, L.strength);
      if (Number.isFinite(L.parallaxDepth)) surface.setLayerParallaxDepth(i, L.parallaxDepth);
    }

    // ⚠️ `islandSpread` is the ONE param that costs a REBAKE rather than a
    // uniform write — the hashed parallax is resolved on the CPU, per island,
    // and lives in the pack. Guarded on an actual change so dragging any OTHER
    // slider does not relabel the map: the params key above fires on all of
    // them together.
    if (Number.isFinite(p.islandSpread) && p.islandSpread !== islandSpread) {
      islandSpread = p.islandSpread;
      bakeIslandPack(islandSpread);
    }

    debugChannel = Number.isFinite(state.debugChannel) ? Math.max(0, Math.round(state.debugChannel)) : 0;
    surface.setDebugChannel(debugChannel);
    enabled = state.enabled !== false;
    refreshVisibility();
  }

  return {
    /** The dedicated scene `runSurfaceResponsePass` renders. */
    scene,
    sync,
    /** Thin passthrough to `surface.setDarknessFloor` — see that setter's own
     * doc. Called from `runLightAccumulatePass`, not from `sync`, because
     * that is where the floor value is already computed for
     * `uRegionDarknessColor`; a second derivation here would be how the two
     * drift. @param {number} r @param {number} g @param {number} b */
    setDarknessFloor: (r, g, b) => surface.setDarknessFloor(r, g, b),
    /** True when there is genuinely something to draw — lets the pass take a
     * true JS early-return rather than issuing a render call for a hidden mesh
     * (Effects.md Law 4: gating by uniform is not gating). */
    hasContent: () => mesh.visible,
    getStatus() {
      return {
        visible: mesh.visible,
        // Non-zero means the author is looking at a DIAGNOSTIC, not at the
        // effect — reported so a channel can never be silently left on and then
        // mistaken for a rendering bug.
        debugChannel,
        enabled,
        floor: loadedFloor,
        bounds: contentBoundsWorld,
        maskImage: maskInfo ?? 'not loaded',
        /** The per-object motion's own report. `islands: 0` means every texel
         * fell back to the global parallax — the effect still draws, and looks
         * exactly like V2's one-frame-for-everything, which is invisible on
         * screen and worth stating. */
        islandPack: islandInfo ?? 'not baked',
        /** Mirrors debug channel 6's own diagnostic exactly — 0 magenta
         * (never baked), 1 amber (baked, zero islands), 2 (real islands, the
         * hue-per-object picture). Cross-checkable against the shader without
         * GPU access. */
        islandBakeStatus,
        /** BAKE-COUNT HEALTH — see islandPackBakeCount's own declaration for
         * why this is a lifetime tally, not a hits/misses pair. */
        islandPackBakeCount,
        /**
         * ⚠️ THE NUMBER THAT DECIDES WHETHER THE AABB CROP IS DOING ITS JOB
         * (2026-07-28, the performance audit).
         *
         * This pass costs ~3 ms, ~5x its declared budget, and its per-pixel
         * shader is genuinely heavy — a 3x3x3 = 27-cell 3D Worley plus a 3D
         * Perlin plus three shimmer layers (9 hashes, 3 sin, 3 cos, 3 exp).
         * ⚠️ Measured at three layers (2026-07-28); doubled to six Round 19
         * (2026-08-03) — the per-pixel cost is now heavier still (18 hashes,
         * 6 sin, 6 cos, 6 exp for the layer lattice alone), not re-measured.
         * With that per-pixel cost fixed, TOTAL cost is decided almost entirely
         * by COVERED PIXELS, which is exactly what `cropGeometry` exists to
         * minimise (this module's own header: "Effects.md Law 6: cost scales
         * with COVERED pixels, and metal covers a few percent of a typical
         * map").
         *
         * But an AABB is only as tight as the paint is CLUSTERED. A brass door
         * alone crops beautifully. A brass door in one corner and a coin pile
         * in the opposite corner produce an AABB covering most of the map while
         * `paintedFraction` stays at a few percent — every pixel in between
         * paying the full 27-cell shader to be multiplied by a `presence` of
         * zero. Those two cases are INDISTINGUISHABLE from the cost alone and
         * are told apart only by comparing these two numbers.
         *
         * READ IT AS: `paintedFraction` is how much metal there really is;
         * `aabbFractionOfItem` is how much of the item the pass actually shades.
         * They should be close. A large ratio between them (`cropWasteRatio`)
         * is wasted fill, and is the case for per-island geometry rather than
         * one AABB quad — the island labels needed to build it are already
         * computed during the pack bake.
         *
         * Derived from numbers both producers already return, so this costs
         * nothing per frame and is computed only when the report is read.
         */
        coverage: (() => {
          const painted =
            islandInfo && Number.isFinite(islandInfo.labelledTexels) && islandInfo.gridW > 0 && islandInfo.gridH > 0
              ? islandInfo.labelledTexels / (islandInfo.gridW * islandInfo.gridH)
              : null;
          const b = loadedContentBoundsUv;
          // UV bounds are a fraction of the ITEM, so their area IS the fraction
          // of the item the cropped quad covers.
          const aabb =
            b && Number.isFinite(b.minU) ? Math.max(0, b.maxU - b.minU) * Math.max(0, b.maxV - b.minV) : null;
          // The REAL answer to "is per-island geometry worth building", not a
          // guessed threshold. See specular-islands.js's own header on
          // `estimatedPerIslandGridFraction` for why it uses the true-painted
          // criterion (matching how `aabb` above is computed) rather than the
          // clustered or dilated footprints the same bake also produces.
          const perIsland =
            islandInfo && Number.isFinite(islandInfo.estimatedPerIslandGridFraction)
              ? islandInfo.estimatedPerIslandGridFraction
              : null;
          const islandWinRatio =
            perIsland !== null && aabb !== null && perIsland > 0 ? Math.round((aabb / perIsland) * 10) / 10 : null;
          return {
            paintedFraction: painted === null ? null : Math.round(painted * 10000) / 10000,
            aabbFractionOfItem: aabb === null ? null : Math.round(aabb * 10000) / 10000,
            cropWasteRatio:
              painted !== null && aabb !== null && painted > 0 ? Math.round((aabb / painted) * 10) / 10 : null,
            estimatedPerIslandFractionOfItem: perIsland === null ? null : Math.round(perIsland * 10000) / 10000,
            estimatedIslandWinRatio: islandWinRatio,
            note:
              'paintedFraction = metal texels / mask grid; aabbFractionOfItem = what the CURRENT single cropped ' +
              'quad actually shades; estimatedPerIslandFractionOfItem = what separate per-island quads would ' +
              'shade instead (a bake-time estimate from the label grid — see docs/planning/Performance-Insights.md ' +
              '§3 — NOT YET BUILT for rendering). estimatedIslandWinRatio (aabbFractionOfItem over that) is the ' +
              'real, computed upper bound on the win from building it — ignores the small per-draw-call overhead ' +
              'of N quads vs 1, which is cheap next to fill on this GPU-bound pass. cropWasteRatio ' +
              '(aabbFractionOfItem / paintedFraction) is the CRUDER older signal, kept as a sanity check; ' +
              'estimatedIslandWinRatio is the number that actually answers "is per-island worth it". A null ' +
              'means the pack has not baked yet, not that coverage is zero.',
          };
        })(),
        outdoorsGate: surface.outdoorsGateCompiled,
        floorGate: surface.floorGateCompiled,
        contentBoundsUv: loadedContentBoundsUv,
        maskUvBounds: paddedBoundsUv,
        mapping: describeSpecularMapping({
          maskRect: loadedMaskRect,
          quadWorld: contentBoundsWorld,
          viewRect: lastViewRect,
        }),
      };
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      surface.specularMaterial?.dispose?.();
      // The debug material too — built eagerly whether or not a channel was
      // ever picked, so "nobody used it" is not a reason to leave it.
      surface.debugMaterial?.dispose?.();
      maskTexture?.dispose?.();
      islandPackTexture?.dispose?.();
      pendingBytes = null;
    },
  };
}
