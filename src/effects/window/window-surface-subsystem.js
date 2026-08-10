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
import {
  buildWindowSurfaceMaterial,
  WINDOW_MASK_IMAGE_SCALE,
  WINDOW_DEFAULT_DAWN_DUSK_TINT_RGB,
  WINDOW_DEFAULT_NIGHT_TINT_RGB,
} from './window-render.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';
import { computeSeedOffset } from './window-glass.js';
import { WINDOW_DEFAULT_AMBIENT_CEILING } from './window-cookie.js';

const log = createLogger('WindowSurface');

/** Padding on the measured AABB, world px. Mirrors `SPECULAR_BOUNDS_PAD_PX`:
 * the mask uploads at `WINDOW_MASK_IMAGE_SCALE`, so the outermost painted
 * texel covers a couple of world px the bounds arithmetic rounds off; a small
 * pad means a cookie can never be clipped by its own crop. */
const WINDOW_BOUNDS_PAD_PX = 8;

/**
 * A → B → C over one 0..1 signal each, the SAME nested-two-stop idiom
 * `sky-access.js#createSkyHandle` uses for its own dayFactor01/twilight01
 * fill colour (night→twilight→day) — computed here in plain JS, once per
 * frame, rather than as TSL node maths, because the inputs are three scalars
 * and the whole point is to push ONE resolved uniform, not re-derive a lerp
 * per fragment.
 * @param {readonly number[]} a @param {readonly number[]} b @param {number} t
 * @returns {number[]}
 */
function lerpRgb(a, b, t) {
  const s = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported.
 * @param {(floorIndex: number) => string|null} args.getWindowMaskUrl
 * @param {(floorIndex: number) => object|null} args.getWindowMaskRect
 * @param {(opts: object) => Promise<object|null>} args.loadMaskImage
 * @param {(data: Uint8Array, w: number, h: number, filter: string) => *} args.createMaskTexture -
 *   the literal `new THREE.DataTexture(...)`, writable only in `vt/`.
 * @param {*} [args.depthTexture] - `buf:scene.depth`'s DEPTH attachment; null
 *   compiles the floor gate out. Replaces `attrTexture` (2026-08-05),
 *   mirroring `specular-surface-subsystem.js`'s own STAGE 3 migration.
 * @param {(floorIndex: number) => number} [args.resolveExpectedDepth] - given
 *   the VIEWED floor, returns `computeTieSafeExpectedDepth` for THIS quad's
 *   OWN background item's rank. Composed in `vt-pan-viewer.js` from
 *   `depthAuthority.rankOf` + `getWindowBackgroundItemId`, the SAME shape
 *   `specular-surface-subsystem.js`'s own `resolveExpectedDepth` already
 *   proved — this subsystem never touches `depthAuthority` directly. Called
 *   every frame from `sync`, never cached: a floor's own background item can
 *   change RANK whenever the depth authority rebuilds (a residency pass, a
 *   pan, any item added or removed), not just on a floor switch — see that
 *   call site's own comment.
 * @param {*} args.uViewRect - envLight's OWN view-rect uniform, shared rather
 *   than duplicated.
 * @param {*} [args.cloudFactorNode] - see `window-render.js`'s header. Passed
 *   straight through; `null` until `world/cloud-field.js` exists.
 * @param {() => object} [args.getWindowRenderState] - the look/enable seam.
 * @param {() => object|null} [args.getEnvSun] - `world/sun.js#computeSun`'s
 *   own return value, as a GETTER (not a captured value) — the same reason
 *   specular's `getSkyHandle` is one: the viewer REASSIGNS its env snapshot
 *   every frame, so capturing it here would pin whatever sun existed at
 *   construction and the daylight tint would never move.
 * @param {() => (readonly number[]|null)} [args.getAmbientCeilingRgb] - a
 *   GETTER for the current outside-ambient colour (`vt-pan-viewer.js`'s own
 *   `lastAmbientColors.background`, raised by any active global light) —
 *   the same reasoning as `getEnvSun`: that value is REASSIGNED every
 *   `runLightAccumulatePass()` call, so capturing it here would freeze the
 *   window-light ceiling at whatever the sky looked like at construction.
 *   `null`/malformed falls back to `WINDOW_DEFAULT_AMBIENT_CEILING` — see
 *   `window-render.js#uAmbientCeiling`'s own doc.
 * @returns {{scene: *, sync: Function, hasContent: Function, getStatus: Function, dispose: Function}}
 */
export function createWindowSurfaceSubsystem({
  THREE,
  getWindowMaskUrl,
  getWindowMaskRect,
  loadMaskImage,
  createMaskTexture,
  depthTexture = null,
  resolveExpectedDepth,
  uViewRect,
  cloudFactorNode = null,
  getWindowRenderState,
  getEnvSun,
  getAmbientCeilingRgb,
}) {
  // ⚠️ `seams/viewer-wired` exists because water shipped exactly this shape
  // DECLARED, defaulted, consumed and never passed — every control dead,
  // every test green (`feedback_seam_default_hides_unwired`).
  getWindowRenderState ??= () => ({ enabled: true, params: {}, debugChannel: 0 });
  getEnvSun ??= () => null;
  getAmbientCeilingRgb ??= () => null;
  resolveExpectedDepth ??= () => 0;

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
  /** The last-resolved outside-ambient ceiling — see `getAmbientCeilingRgb`'s
   * own doc and `window-render.js#uAmbientCeiling`. Tracked here (mirroring
   * `debugChannel`/`enabled`) purely so `getStatus()` can report the live
   * number for the debug report, the same reason those are tracked. */
  let ambientCeiling = WINDOW_DEFAULT_AMBIENT_CEILING;
  let loadedMaskRect = null;
  let loadedContentBoundsUv = null;
  let paddedBoundsUv = null;

  const surface = buildWindowSurfaceMaterial({
    THREE,
    maskTexture,
    depthTexture,
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
    // ⚠️ THE VIEWED FLOOR HAS NO MASK OF ITS OWN — clear whatever an EARLIER
    // floor left behind, rather than leaving it up. Mirrors specular-surface-
    // subsystem.js's own live-found fix (2026-08-03): without this branch, a
    // stale quad's `contentBoundsWorld` stays set, the mesh stays visible,
    // and the depth-authority gate (2026-08-05) is left comparing a STALE
    // `uExpectedDepth` (this quad's own background rank from whatever floor
    // last loaded) against the CURRENT floor's real stored depth — which can
    // fail OPEN (the old floor's cookie bleeding onto a lower floor that
    // genuinely ranks below it) rather than the old exact-floor-index gate's
    // reliable fail-CLOSED. Hiding the mesh here is the honest state: no
    // `_Window` is authored for what is actually on screen.
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
    // path in a scene built by duplication, and re-reading the rect on a
    // floor switch is what keeps the mapping right when they do.
    if (loading || (url === loadedUrl && floorIndex === loadedFloor)) return;
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
        if (paddedBoundsUv) {
          surface.setMaskUvBounds(paddedBoundsUv);
          // THE REFRACTION'S OWN WORLD→UV CONVERSION, derived from the SAME
          // two boxes the bounds came from rather than from the mask rect
          // directly — so the shader's px-to-UV step and the quad's own crop
          // cannot drift apart, including in V's direction
          // (`feedback_y_flip_recurring_risk`: both are `(world − min) / span`
          // with no flip, and deriving the ratio from the already-computed
          // pair is what keeps that true if either ever changes).
          const worldW = contentBoundsWorld.maxX - contentBoundsWorld.minX;
          const worldH = contentBoundsWorld.maxY - contentBoundsWorld.minY;
          surface.setUvPerWorldPx(
            Math.abs(worldW) > 1e-6 ? (paddedBoundsUv.maxU - paddedBoundsUv.minU) / worldW : 0,
            Math.abs(worldH) > 1e-6 ? (paddedBoundsUv.maxV - paddedBoundsUv.minV) / worldH : 0
          );
        }
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

    // THE EXPECTED DEPTH (2026-08-05). Pushed every frame and NEVER gated on
    // a cached key, unlike the old `uFloorIndex01` (a static property of
    // whichever mask happened to load, set once in `ensureMaskImage`'s own
    // `.then()`): this quad's own background item can change RANK whenever
    // the depth authority rebuilds — a residency pass, a pan, any item added
    // or removed — the exact staleness class the vegetation flicker fix and
    // specular's own STAGE 3 migration already found and fixed for other
    // consumers. Harmless to call even while the mesh is hidden (no mask
    // loaded yet, or `depthTexture` was never wired) — it only ever writes a
    // uniform `setExpectedDepth` owns clamping for.
    surface.setExpectedDepth(resolveExpectedDepth(floorIndex));

    // THE LOOK PARAMS. A string compare against cached uniform writes, and
    // NOT gated on any load generation: a slider drag changes no texture and
    // produces no reload.
    const state = getWindowRenderState();
    const p = state.params ?? {};
    // THE DAYLIGHT SIGNAL — the astrolabe's own sun, read every sync() (it is
    // what makes the tint move at all) but folded into the SAME cached-key
    // gate as the rest of the look params, rounded, so a static clock (paused,
    // or no env snapshot yet) writes the uniform once and then leaves it alone.
    const sun = getEnvSun();
    const dayFactor01 = Number.isFinite(sun?.dayFactor01) ? sun.dayFactor01 : 1;
    const twilight01 = Number.isFinite(sun?.twilight01) ? sun.twilight01 : 0;
    // THE OUTSIDE-AMBIENT CEILING — same "read every sync(), fold into the
    // cached key" idiom as dayFactor01/twilight01 above: this genuinely
    // changes continuously as day turns to night, but only needs a real
    // uniform WRITE when the resolved number actually moves.
    const rawAmbientRgb = getAmbientCeilingRgb();
    ambientCeiling =
      Array.isArray(rawAmbientRgb) && rawAmbientRgb.length === 3 && rawAmbientRgb.every(Number.isFinite)
        ? Math.max(rawAmbientRgb[0], rawAmbientRgb[1], rawAmbientRgb[2], 0)
        : WINDOW_DEFAULT_AMBIENT_CEILING;
    const key = [
      state.enabled ? 1 : 0,
      state.debugChannel ?? 0,
      p.strength,
      p.contrast,
      p.dawnDuskTint,
      p.nightTint,
      dayFactor01.toFixed(4),
      twilight01.toFixed(4),
      ambientCeiling.toFixed(4),
      p.glassWarpPx,
      p.glassDispersion,
      p.glassScale,
      p.glassDetail,
      p.glassStriation,
      p.glassStriationAngle,
      p.glassCausticStrength,
      p.glassCausticSharpness,
      p.glassSeed,
    ].join('|');
    if (key !== lastParamsKey) {
      lastParamsKey = key;
      if (Number.isFinite(p.strength)) surface.setStrength(p.strength);
      if (Number.isFinite(p.contrast)) surface.setContrast(p.contrast);
      surface.setAmbientCeiling(ambientCeiling);
      // THE GLASS — pushed as one object so the pane is never half-described.
      // The seed is hashed HERE, on the CPU, so a raw seed can never reach a
      // noise coordinate (`feedback_raw_seed_into_noise_coordinate`).
      const seedOffset = computeSeedOffset(p.glassSeed);
      surface.setGlass({
        warpPx: p.glassWarpPx,
        dispersion: p.glassDispersion,
        scale: p.glassScale,
        detail: p.glassDetail,
        striation: p.glassStriation,
        striationAngleDeg: p.glassStriationAngle,
        causticStrength: p.glassCausticStrength,
        causticSharpness: p.glassCausticSharpness,
        seedOffset: [seedOffset.ox, seedOffset.oy],
      });
      // NIGHT → dawn/dusk → NOON (neutral) — the exact nested-lerp shape
      // `sky-access.js`'s own fill-hue chain uses over the same two signals.
      const dawnDusk = Array.isArray(p.dawnDuskTint) ? p.dawnDuskTint : WINDOW_DEFAULT_DAWN_DUSK_TINT_RGB;
      const night = Array.isArray(p.nightTint) ? p.nightTint : WINDOW_DEFAULT_NIGHT_TINT_RGB;
      const nightToTwilight = lerpRgb(night, dawnDusk, twilight01);
      surface.setDaylightTint(lerpRgb(nightToTwilight, [1, 1, 1], dayFactor01));
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
        ambientCeiling,
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
