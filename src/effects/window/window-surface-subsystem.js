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
  WINDOW_DEFAULT_TIER,
} from './window-render.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';
import { computeSeedOffset } from './window-glass.js';
import { WINDOW_DEFAULT_AMBIENT_CEILING, WINDOW_ALPHA_EPSILON } from './window-cookie.js';
import {
  createWindowRain,
  resolveRainFrame,
  rainKindWeight,
  stepWindowWetness,
  WINDOW_RAIN_DEFAULTS,
  RAIN_TUNE,
} from './window-rain.js';
import { deriveWindowRainField, buildWindowPresenceGrid, RAIN_FIELD_DEFAULT_EASE_PX } from './window-rain-field.js';
import { windFlowVector } from '../../world/index.js';

const log = createLogger('WindowSurface');

/** The first ladder rung that compiles rain on the glass (the `glass` rung and up; the bare `cookie` rung does not). */
const WINDOW_RAIN_MIN_TIER = 1;

/** Rain's clocks wrap here, in sim seconds (about 28 hours). float32 keeps its sub-millisecond phase well inside it. */
const RAIN_CLOCK_WRAP_SEC = 100000;

/** The longest frame step the sliding drops' clock will take, so a stalled tab cannot teleport every drop. */
const RAIN_SLIDE_DT_MAX_SEC = 0.25;
const RAIN_WIND_SHIFT_WRAP_PX = 1048576;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The brightest gated value in a decoded RGBA8 mask: the peak channel times alpha (alpha under the epsilon counts as
 * 1, exactly as the shader's `sampleCookieAt` does), 0..1. The "rain only in the brightest" dial is relative to it.
 * 1 when there is no data, so the fade then compares against full white.
 * @param {ArrayLike<number>|null|undefined} data
 */
export function computeMaskPeak01(data) {
  if (!data || data.length < 4) return 1;
  let best = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3] / 255;
    const v = Math.max(data[i], data[i + 1], data[i + 2]) * (a < WINDOW_ALPHA_EPSILON ? 1 : a);
    if (v > best) best = v;
  }
  return best > 0 ? best / 255 : 1;
}

/**
 * The author's rain dials, resolved from the render state's params with the effect's own defaults standing in for
 * anything missing (a Node harness passes `params: {}`).
 * @param {object} p
 */
function resolveRainLook(p) {
  const D = WINDOW_RAIN_DEFAULTS;
  const n = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    response: n(p.rainResponse, D.response),
    dropScalePx: n(p.rainDropScalePx, D.dropScalePx),
    splatDensity: n(p.rainSplatDensity, D.splatDensity),
    refraction: n(p.rainRefraction, D.refraction),
    caustic: n(p.rainCaustic, D.caustic),
    rimDarken: n(p.rainRimDarken, D.rimDarken),
    sliders: n(p.rainSliders, D.sliders),
    slideSpeed: n(p.rainSlideSpeed, D.slideSpeed),
    trail: n(p.rainTrail, D.trail),
    projectionStretch: n(p.rainProjectionStretch, D.projectionStretch),
    windwardBias: n(p.rainWindwardBias, D.windwardBias),
    sheeting: n(p.rainSheeting, D.sheeting),
    lingerSec: n(p.rainLingerSec, D.lingerSec),
    maskFloorPct: n(p.rainMaskFloorPct, D.maskFloorPct),
    cornerEasePx: n(p.rainCornerEasePx, RAIN_FIELD_DEFAULT_EASE_PX),
  };
}

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
 * THREE's `Material.side` numeric constants, decoded for `getStatus()`'s own
 * diagnostic report. Hardcoded rather than read off an injected `THREE`
 * (this file's own header: "injected, never imported") — these three values
 * (FrontSide/BackSide/DoubleSide = 0/1/2) have been stable across every
 * three.js release this project has ever vendored, and a status accessor
 * has no THREE reference in scope outside the factory closure to read them
 * from symbolically.
 */
const WINDOW_MATERIAL_SIDE_NAMES = Object.freeze({ 0: 'front', 1: 'back', 2: 'double' });

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
 * @param {*} [args.depthFlagsTexture] - `buf:scene.depth`'s COLOUR attachment;
 *   null compiles the tile-restrict-light exemption out, falling back to the
 *   bare rank gate — see `window-render.js#buildWindowSurfaceMaterial`'s own
 *   "THE FLOOR GATE" section (mythica-machina-press#538 live-test follow-up).
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
 * @param {*} [args.cloudOvercastNode] - see `window-render.js`'s header, "THE
 *   OVERCAST MOOD". Passed straight through.
 * @param {*} [args.cloudOvercastEdgeWidenNode] - see `window-render.js`'s
 *   header. Passed straight through.
 * @param {*} [args.cloudOvercastContrastSoftenNode] - see `window-render.js`'s
 *   header. Passed straight through.
 * @param {*} [args.cloudOvercastMinStrengthNode] - see `window-render.js`'s
 *   header. Passed straight through.
 * @param {*} [args.cloudNoonBoostNode] - see `window-render.js`'s header.
 *   Passed straight through.
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
 * @param {() => (object|null)} [args.getEnv] - a GETTER for the viewer's env snapshot (`world/environment.js`), for
 *   the rain: `weather.precip01`/`precipKind`/`precipMixWeight`, `time.tMs`/`dtSec`, `wind.*`. A getter for the same
 *   reason as `getEnvSun`: the viewer REASSIGNS its snapshot every frame. `null` means a dry, still day.
 * @param {(floorIndex: number) => ({spec: object, data: Uint8Array, version: number}|null)} [args.getWindowOutdoorsGrid]
 *   - `window-seams.js#getWindowOutdoorsGrid`: the floor's `_Outdoors` grid, from which the rain's "which way is down
 *   the pane" field is derived (only when it first rains). `null` means windows get splashes and no running drops.
 * @param {*} [args.profiler] - so `sync()` can bracket its own per-frame cost
 *   (`light.windowSync` — perf-instrumentation-audit-2026-08-12: this ran
 *   with zero profiler coverage despite pushing a per-frame depth-authority
 *   query and a ~17-field dirty-check key, the SAME shape
 *   `specularSurface.sync()`'s own zone already covers). `beginById`/
 *   `endById` (the string form, not vt-pan-viewer.js's own pre-resolved `Z`
 *   table): this subsystem is constructed independently of that table, same
 *   reasoning as `specular-surface-subsystem.js`'s own `profiler` param.
 * @returns {{scene: *, sync: Function, hasContent: Function, getStatus: Function, dispose: Function}}
 */
export function createWindowSurfaceSubsystem({
  THREE,
  getWindowMaskUrl,
  getWindowMaskRect,
  loadMaskImage,
  createMaskTexture,
  depthTexture = null,
  depthFlagsTexture = null,
  resolveExpectedDepth,
  uViewRect,
  cloudFactorNode = null,
  cloudOvercastNode = null,
  cloudOvercastEdgeWidenNode = null,
  cloudOvercastContrastSoftenNode = null,
  cloudOvercastMinStrengthNode = null,
  cloudNoonBoostNode = null,
  getWindowRenderState,
  getEnvSun,
  getAmbientCeilingRgb,
  getEnv,
  getWindowOutdoorsGrid,
  profiler = null,
}) {
  // ⚠️ `seams/viewer-wired` exists because water shipped exactly this shape
  // DECLARED, defaulted, consumed and never passed — every control dead,
  // every test green (`feedback_seam_default_hides_unwired`).
  getWindowRenderState ??= () => ({ enabled: true, params: {}, debugChannel: 0 });
  getEnvSun ??= () => null;
  getAmbientCeilingRgb ??= () => null;
  getEnv ??= () => null;
  getWindowOutdoorsGrid ??= () => null;
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
  // POOL HEALTH (cache-completeness pass, 2026-08-12) — the mask RELOAD gate
  // (`ensureMaskImage`'s own url+floor equality check below): a hit is the
  // same url+floor already loaded (skip); a miss is a genuinely new load
  // kicked off. `loading` (mid-flight) is NEITHER — no cache decision was
  // possible yet, same "not ready" doctrine mask-authority.js's own
  // bakeRuns/bakeSkips uses for !scene.gridSpec.
  let maskReloadHits = 0;
  let maskReloadMisses = 0;

  // ── RAIN ON THE GLASS ─────────────────────────────────────────────────────
  // Declared BEFORE `buildSurfaceForTier` runs for the first time below: that call builds the rain handle, which
  // needs the neutral flow textures, and a `let` read before its declaration is a TDZ error.
  /** How wet the glass is, 0..1: rises in rain, lingers after it (`stepWindowWetness`). */
  let wet01 = 0;
  /** Sim seconds integrated against the CURRENT slide speed: a speed that multiplied absolute time would
   * teleport every running drop each time the rain intensity moved. */
  let slideClock = 0;
  /** The wind's drift of the running water, world px, integrated the same way (a change of wind changes the speed
   * it drifts at, never where the pattern is). Wrapped far away: one pop every ~2 h of full wind. */
  const windShift = [0, 0];
  let lastRainTMs = null;
  let rainLookKey = '';
  let rainReport = { rain01: 0, wet01: 0, presence: 0 };
  /** The window mask's decoded pixels (RGBA; the SAME array the texture wraps, never mutated) - what the flow
   * field pools window presence from. */
  let maskPixels = null;
  /** The brightest gated value (peak channel x alpha, 0..1) anywhere in the loaded mask: the "brightest only" rain's unit. */
  let maskPeak01 = 1;
  /** Neutral 1x1 flow textures (confidence 0: splats only) until a field is derived. */
  let neutralDirs = null;
  let neutralAux = null;
  /** The derived flow field's uploaded form, and the inputs it was derived from. */
  const rainFlow = {
    dirsTex: null,
    auxTex: null,
    w: 0,
    h: 0,
    rect: null,
    source: null,
    derived: false,
    litCells: 0,
    levels: 0,
    /** How many times a derivation actually ran (the field is only re-derived when its inputs change). */
    attempts: 0,
  };

  function ensureNeutralFlowTextures() {
    if (neutralDirs) return;
    neutralDirs = createMaskTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, 'linear');
    // kappa 0 (splats only, no running drops), gate 255 (the rain runs everywhere there is window light)
    neutralAux = createMaskTexture(new Uint8Array([0, 0, 128, 255]), 1, 1, 'linear');
  }

  /** A fresh rain handle (one per built surface: a tier rebuild makes a new material and so a new handle). */
  function createRainHandle() {
    ensureNeutralFlowTextures();
    const { max, float } = THREE.TSL;
    return createWindowRain({
      THREE,
      flowDirsTexture: neutralDirs,
      flowAuxTexture: neutralAux,
      // World px across the view, from the same view-rect uniform the floor gate maps screen UV with.
      viewSpanNode: max(uViewRect.z.sub(uViewRect.x), float(1)),
    });
  }

  /**
   * Rebuilds the whole material for a new ladder rung — closes over the
   * subsystem's OWN current `maskTexture` rather than taking it as a
   * parameter, so a rebuild triggered by a tier change always reflects
   * whatever is CURRENTLY loaded. Mirrors specular-surface-subsystem.js's
   * own `buildSurfaceForTier` (Effects.md Law 4: `glass` is a JS-time branch
   * baked into the compiled shader graph, not a value a uniform can flip).
   * @param {number} tier
   */
  function buildSurfaceForTier(tier) {
    return buildWindowSurfaceMaterial({
      THREE,
      // A JS-time branch like `glass`: below the glass rung no rain node is ever constructed.
      rain: tier >= WINDOW_RAIN_MIN_TIER ? createRainHandle() : null,
      maskTexture,
      depthTexture,
      depthFlagsTexture,
      uViewRect,
      cloudFactorNode,
      cloudOvercastNode,
      cloudOvercastEdgeWidenNode,
      cloudOvercastContrastSoftenNode,
      cloudOvercastMinStrengthNode,
      cloudNoonBoostNode,
      // Every floor's window mesh stays visible for as long as that floor
      // exists in the scene (see this file's own header), not just while it is
      // the VIEWED floor — so on a multi-floor map, every hidden floor was
      // paying the full five-tap glass/dispersion/caustic chain per fragment
      // only to have the per-pixel floor gate zero it right afterward.
      // `gateGlass` (window-render.js, built 2026-08-12) skips that
      // computation entirely wherever the gate has already decided a fragment
      // is invisible — provably lossless (the gated-off value is the same
      // zero vector the ungated path already produced there), off by default
      // in the builder itself pending a live look. Opted in HERE, at the one
      // real production wiring point, because a live GPU capture on a 3-floor
      // scene (2026-08-25, Town River Bridge) measured window light at 5.5x
      // its own declared budget with exactly two floors' worth of window
      // meshes simultaneously visible — the live-look confirmation is still
      // outstanding, but the math cannot make this look different on screen.
      gateGlass: true,
      // TIER 1 ('glass') — wired 2026-08-29. See window-render.js's own
      // ladder header for the full account.
      glass: tier >= 1,
    });
  }

  /** The ladder rung the CURRENT `surface` was actually built for. */
  let builtForTier = WINDOW_DEFAULT_TIER;
  let surface = buildSurfaceForTier(builtForTier);

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
   *
   * ============================================================================
   * ⚠️ IN-APP PAINTED MASKS: EVALUATED 2026-08-31, DELIBERATELY NOT WIRED
   * ============================================================================
   * Same verdict, and largely the same reasoning, as `specular-surface-
   * subsystem.js#ensureMaskImage` — read that note for the long form. In
   * brief: `getWindowMaskUrl` is file-discovery only, so a mask painted with
   * the in-app brush never reaches this subsystem, `refreshVisibility` above
   * gates on `!!loadedUrl`, and the mesh silently stays hidden.
   *
   * Window is the WORST of the four candidates to grid-feed, because colour is
   * not decoration here, it is the payload. The catalog's own meaning for this
   * kind is *"a hand-painted INTERIOR light cookie… read as GLASS: value = how
   * much light lands here, hue+saturation = what colour it becomes. NOT an
   * aperture to project through — the mask already IS the light"*, and
   * `window-render.js` splits exactly that apart (`tint = s.rgb.div(value)`).
   * The authority's derived grid carries the R channel alone
   * (`mask-catalog.js#extractionPlanFor`) and the brush can only author a
   * single coverage byte anyway (`scene/paint-mask.js`), so a painted window
   * mask has no hue to recover — every stained-glass cookie would come out
   * white. Resolution compounds it (a cookie is an EDGE, and `MASK_GRID_MAX_DIM`
   * is 512), but the channel loss alone settles it.
   *
   * Wiring this needs a colour-capable brush first. Until then the Painter
   * department's own tile says this effect reads the file only, rather than
   * showing a success toast over a save that renders nothing.
   *
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
        maskPixels = null;
        rainFlow.source = null;
        refreshVisibility();
      }
      return;
    }
    // Keyed on floor AS WELL AS url: two floors can legitimately share a file
    // path in a scene built by duplication, and re-reading the rect on a
    // floor switch is what keeps the mapping right when they do.
    if (loading) return;
    if (url === loadedUrl && floorIndex === loadedFloor) {
      maskReloadHits += 1;
      return;
    }
    maskReloadMisses += 1;
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
        // Keep the decoded pixels (the texture wraps this very array, so it costs nothing) for the rain's flow field,
        // and forget any field derived from the previous mask.
        maskPixels = loaded.data ? { data: loaded.data, width: loaded.width, height: loaded.height } : null;
        maskPeak01 = computeMaskPeak01(maskPixels?.data);
        rainFlow.source = null;
        loadedContentBoundsUv = loaded.contentBounds ?? null;
        contentBoundsWorld = toWorldBounds(loaded.contentBounds, rect);
        // THE MASK LOOKUP'S ONLY INPUT, derived from the SAME world bounds the
        // quad is cropped to rather than from `contentBounds` directly — so
        // the AABB pad is carried automatically and the two can never
        // disagree about where the quad's edges are.
        paddedBoundsUv = toUvBounds(contentBoundsWorld, rect);
        if (paddedBoundsUv) {
          surface.setMaskUvBounds(paddedBoundsUv);
          pushUvPerWorldPx();
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

  /**
   * UV-space content bounds × the mask's world rect → a padded world AABB,
   * CLAMPED to the rect itself.
   *
   * ⚠️ THE CLAMP IS THE FIX FOR A LIVE BRIGHT RIM AT THE MAP EDGE — the SAME
   * bug `specular-surface-subsystem.js#toWorldBounds` was fixed for, and the
   * same class `water-body-subsystem.js` names in its own pad comment. Its
   * report (specular, same day): *"even though it's in a dark room it has a
   * border where the specular is very bright and illuminated… a thin band
   * around the edge of the map."*
   *
   * `WINDOW_BOUNDS_PAD_PX` exists so a cookie near the painted content's edge
   * is never clipped by the crop. But when the paint reaches the mask file's
   * OWN edge — a window at the map border, or a tile surface whose whole file
   * is the mask (`window-tile-surface-subsystem.js`) — the pad pushes the world
   * AABB PAST the rect, so `toUvBounds` returns `minU < 0` / `maxU > 1`. The
   * shader's `maskUv` then leaves `0..1` over that whole outer band
   * (`window-render.js`'s `mix(uMaskUvBounds, …)`), the mask texture's
   * `ClampToEdgeWrapping` repeats the edge texel across it, `presence` reads
   * that texel's own strength, and the cookie paints a solid lit strip around
   * the map edge. The invariant this file's own test asserts — *"the bounds
   * stay inside the file, so the sample can never leave the texture"* — was
   * only ever true for content that happened to sit far enough inside the file.
   *
   * Clamping HERE, rather than in the shader, keeps the rule in one place and
   * cannot shrink a real cookie: the quad becomes the padded box INTERSECTED
   * with the map, so the pad is kept everywhere there is map left to pad into
   * (its entire purpose) and simply has nothing to add at the border, where
   * there is no mask content beyond to protect. The only thing past the rect is
   * off-map, where the mask has no paint and the cookie has nothing to show.
   *
   * @param {object|null} b @param {object} rect @returns {object|null} */
  function toWorldBounds(b, rect) {
    if (!b) return null;
    const w = rect.maxX - rect.minX;
    const h = rect.maxY - rect.minY;
    return {
      minX: Math.max(rect.minX, rect.minX + b.minU * w - WINDOW_BOUNDS_PAD_PX),
      minY: Math.max(rect.minY, rect.minY + b.minV * h - WINDOW_BOUNDS_PAD_PX),
      maxX: Math.min(rect.maxX, rect.minX + b.maxU * w + WINDOW_BOUNDS_PAD_PX),
      maxY: Math.min(rect.maxY, rect.minY + b.maxV * h + WINDOW_BOUNDS_PAD_PX),
    };
  }

  /**
   * THE REFRACTION'S OWN WORLD→UV CONVERSION, pushed onto the CURRENT
   * `surface` from the SAME two cached boxes `toUvBounds`/`ensureMaskImage`
   * already computed — never re-derived a second way, so the shader's
   * px-to-UV step and the quad's own crop cannot drift apart, including in
   * V's direction (`feedback_y_flip_recurring_risk`: both are
   * `(world − min) / span` with no flip). Extracted 2026-08-29 so a tier
   * rebuild (below) can re-push this onto the FRESH material exactly the way
   * `ensureMaskImage`'s own mask-load callback already does — a single
   * formula, two call sites, rather than two copies that could disagree.
   * No-ops while no mask has loaded yet (both inputs null).
   */
  function pushUvPerWorldPx() {
    if (!paddedBoundsUv || !contentBoundsWorld) return;
    const worldW = contentBoundsWorld.maxX - contentBoundsWorld.minX;
    const worldH = contentBoundsWorld.maxY - contentBoundsWorld.minY;
    surface.setUvPerWorldPx(
      Math.abs(worldW) > 1e-6 ? (paddedBoundsUv.maxU - paddedBoundsUv.minU) / worldW : 0,
      Math.abs(worldH) > 1e-6 ? (paddedBoundsUv.maxV - paddedBoundsUv.minV) / worldH : 0
    );
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

  /** Point the CURRENT rain handle at whatever flow field is derived (or at the neutral one). */
  function pushRainFlowToSurface() {
    const rain = surface.rain;
    if (!rain) return;
    if (rainFlow.derived && rainFlow.dirsTex) {
      rain.setFlow({ dirsTexture: rainFlow.dirsTex, auxTexture: rainFlow.auxTex, rect: rainFlow.rect });
    } else {
      ensureNeutralFlowTextures();
      rain.setFlow({ dirsTexture: neutralDirs, auxTexture: neutralAux, rect: null });
    }
  }

  /**
   * Upload a derived flow field, rewriting the existing textures IN PLACE when the grid is the same size: a new
   * texture object is a new binding and every consumer rebuilds (the lesson of the wind bake), and the field is
   * re-derived whenever the author nudges Corner blend.
   * @param {object|null} field
   */
  function uploadRainFlow(field) {
    if (!field) {
      rainFlow.derived = false;
      rainFlow.litCells = 0;
      rainFlow.levels = 0;
      pushRainFlowToSurface();
      return;
    }
    const { w, h } = field.spec;
    if (!rainFlow.dirsTex || rainFlow.w !== w || rainFlow.h !== h) {
      rainFlow.dirsTex?.dispose?.();
      rainFlow.auxTex?.dispose?.();
      rainFlow.dirsTex = createMaskTexture(field.dirs, w, h, 'linear');
      rainFlow.auxTex = createMaskTexture(field.aux, w, h, 'linear');
      rainFlow.w = w;
      rainFlow.h = h;
    } else {
      rainFlow.dirsTex.image.data.set(field.dirs);
      rainFlow.dirsTex.needsUpdate = true;
      rainFlow.auxTex.image.data.set(field.aux);
      rainFlow.auxTex.needsUpdate = true;
    }
    rainFlow.rect = { x: field.spec.x, y: field.spec.y, width: field.spec.width, height: field.spec.height };
    rainFlow.derived = true;
    rainFlow.litCells = field.stats.litCells;
    rainFlow.levels = field.stats.levels;
    pushRainFlowToSurface();
    log.info(
      `rain field derived: ${w}x${h} grid, ${field.stats.litCells} lit cells, ${field.stats.directionalCells} run toward a wall, ${field.stats.skylightCells} skylight, ${field.stats.levels} facet level(s)`
    );
  }

  /**
   * Derive the "which way is down the pane" field - only once it has started to rain (a dry session never pays
   * for it) and only when what it is derived from has changed: the `_Outdoors` product version, the window mask's
   * pixels, the floor, or the author's Corner blend.
   * @param {number} floorIndex @param {ReturnType<typeof resolveRainLook>} look
   */
  function ensureRainFlow(floorIndex, look) {
    if (!maskPixels || !loadedMaskRect) return;
    const outdoors = getWindowOutdoorsGrid(floorIndex);
    const src = rainFlow.source;
    if (
      src &&
      src.floor === floorIndex &&
      src.version === (outdoors ? outdoors.version : -1) &&
      src.maskData === maskPixels.data &&
      src.ease === look.cornerEasePx
    ) {
      return;
    }
    rainFlow.attempts += 1;
    rainFlow.source = {
      floor: floorIndex,
      version: outdoors ? outdoors.version : -1,
      maskData: maskPixels.data,
      ease: look.cornerEasePx,
    };
    // With no `_Outdoors` there is no wall to run toward, but the field still gates the rain to the lit area, so it
    // is derived on a grid laid over the window mask's own rect.
    const rectW = loadedMaskRect.maxX - loadedMaskRect.minX;
    const rectH = loadedMaskRect.maxY - loadedMaskRect.minY;
    const longSide = Math.max(rectW, rectH);
    const spec = outdoors
      ? outdoors.spec
      : {
          x: loadedMaskRect.minX,
          y: loadedMaskRect.minY,
          width: rectW,
          height: rectH,
          w: Math.max(2, Math.round((256 * rectW) / longSide)),
          h: Math.max(2, Math.round((256 * rectH) / longSide)),
        };
    const presence = buildWindowPresenceGrid({
      data: maskPixels.data,
      width: maskPixels.width,
      height: maskPixels.height,
      rect: loadedMaskRect,
      spec,
    });
    const field = presence ? deriveWindowRainField({ outdoors, spec, presence, easePx: look.cornerEasePx }) : null;
    uploadRainFlow(field);
  }

  /**
   * The rain, once per frame: the author's dials, the weather resolved to what the shader reads, the two clocks,
   * and (when it is raining) the flow field. Only uniforms are written - rain never rebuilds the material.
   * @param {number} floorIndex @param {object} state - the render state.
   */
  function syncRain(floorIndex, state) {
    const rain = surface.rain;
    if (!rain) return;
    const look = resolveRainLook(state.params ?? {});
    const lookKey = [
      look.dropScalePx,
      look.refraction,
      look.caustic,
      look.rimDarken,
      look.trail,
      look.projectionStretch,
      look.maskFloorPct,
    ].join('|');
    if (lookKey !== rainLookKey) {
      rainLookKey = lookKey;
      rain.setLook(look);
    }
    rain.setMaskPeak(maskPeak01);

    const env = getEnv();
    const weather = env?.weather;
    const rain01 = clamp01(
      (Number.isFinite(weather?.precip01) ? weather.precip01 : 0) *
        rainKindWeight(weather?.precipKind, weather?.precipMixWeight) *
        look.response
    );
    const tMs = Number.isFinite(env?.time?.tMs) ? env.time.tMs : null;
    // The frame step: the clock's own `dtSec`, or zero when this floor has already seen this frame's time (every
    // floor syncs once per frame against the same snapshot, and a repeat must not integrate twice).
    let dtSec = Number.isFinite(env?.time?.dtSec) ? env.time.dtSec : 0;
    if (tMs !== null && tMs === lastRainTMs) dtSec = 0;
    lastRainTMs = tMs;

    wet01 = stepWindowWetness(wet01, rain01, dtSec, look.lingerSec);
    const wind = env?.wind;
    const frame = resolveRainFrame({
      rain01,
      wet01,
      look,
      windSpeed01: Number.isFinite(wind?.speed01) ? wind.speed01 : 0,
      gust01: Number.isFinite(wind?.gustiness01) ? wind.gustiness01 : 0,
    });
    slideClock =
      (slideClock + Math.min(Math.max(dtSec, 0), RAIN_SLIDE_DT_MAX_SEC) * frame.slideSpeedMul) % RAIN_CLOCK_WRAP_SEC;
    const flow = windFlowVector(wind?.directionDeg);
    const driftPx = Math.min(Math.max(dtSec, 0), RAIN_SLIDE_DT_MAX_SEC) * frame.windPush * RAIN_TUNE.windDriftPx;
    windShift[0] = (windShift[0] + flow.x * driftPx) % RAIN_WIND_SHIFT_WRAP_PX;
    windShift[1] = (windShift[1] + flow.y * driftPx) % RAIN_WIND_SHIFT_WRAP_PX;
    rain.setFrame(frame, {
      windShift,
      clock: tMs === null ? 0 : (tMs / 1000) % RAIN_CLOCK_WRAP_SEC,
      slideClock,
      windFlow: [flow.x, flow.y],
    });
    rainReport = { rain01, wet01, presence: frame.presence };
    if (frame.presence) ensureRainFlow(floorIndex, look);
  }

  /**
   * Per-frame, called from `runLightAccumulatePass` after the point-light
   * MAX-blend.
   * @param {number} floorIndex - the VIEWED floor.
   */
  function sync(floorIndex) {
    profiler?.beginById('light.windowSync');
    try {
      syncUnguarded(floorIndex);
    } finally {
      profiler?.endById('light.windowSync');
    }
  }

  /** The real body of `sync()`, split out so the zone bracket above can wrap
   * it with a try/finally without indenting the whole function — a thrown
   * error must still close the bracket, or every later frame's measurement
   * is poisoned by one that never re-opens (frame-profiler.js's own
   * `unbalancedBrackets` anomaly). */
  function syncUnguarded(floorIndex) {
    // THE TIER — read FIRST, so a rebuild (if needed) happens before anything
    // else touches `surface` this frame. See `buildSurfaceForTier`'s own
    // header for why a full rebuild, not a uniform, is what a tier change
    // requires.
    const state = getWindowRenderState();
    const resolvedTier = Number.isFinite(state.perfTier) ? state.perfTier : WINDOW_DEFAULT_TIER;
    if (resolvedTier !== builtForTier) {
      const prev = surface;
      surface = buildSurfaceForTier(resolvedTier);
      prev.windowMaterial?.dispose?.();
      prev.debugMaterial?.dispose?.();
      builtForTier = resolvedTier;
      // A FRESH material starts at ITS OWN constructor defaults — re-push
      // the crop bounds and the refraction's own world→UV ratio (both
      // normally set ONCE, on mask load, never every sync()), or a tier
      // rebuild AFTER a mask has already loaded would silently sample the
      // whole 0..1 UV range instead of the painted content box. No-ops
      // correctly while no mask has loaded yet.
      if (paddedBoundsUv) surface.setMaskUvBounds(paddedBoundsUv);
      pushUvPerWorldPx();
      // The fresh handle starts neutral: hand it the flow textures already derived, and make the look re-push.
      pushRainFlowToSurface();
      rainLookKey = '';
      // Force every cached value below to re-push onto the FRESH material —
      // it starts back at its constructor defaults, and the key-based cache
      // below exists to skip REDUNDANT writes, not the first write to a new
      // object.
      lastParamsKey = '';
    }

    ensureMaskImage(floorIndex);
    syncRain(floorIndex, state);

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
    // produces no reload. (`state` was already fetched above, for the tier
    // check — reused here rather than a second `getWindowRenderState()` call.)
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
    /**
     * FLOOR-PREPARE HOOK (2026-08-16, live author report: switching up a
     * floor, "a second later the _Windows effect pops into view"). Starts the
     * SAME mask fetch `sync()` would, but on its own, deliberately WITHOUT the
     * rest of `sync()`'s per-frame work (`resolveExpectedDepth`/
     * `setExpectedDepth`, which reads `depthAuthority.rankOf(...)` for
     * whichever floor is passed).
     *
     * That distinction is load-bearing, not cosmetic. `vt-pan-viewer.js#
     * prepareFloor` calls this for the TARGET floor while `view.floorIndex`
     * still points at the floor genuinely on screen — depth authority has not
     * been rebuilt for the target floor yet (that happens at COMMIT, inside
     * the residency pass `prepareFloor` deliberately does not run early; see
     * its own header for why). Calling the full `sync()` here would ask
     * depth authority to rank a floor it does not know about yet and push
     * whatever it returned onto this floor's own quad — harmless today only
     * because the quad is not drawn until `view.floorIndex` actually matches,
     * but it is a wrong value sitting in real state for no reason, and this
     * effect already lists two live bugs that started exactly there
     * (`ensureMaskImage`'s own header, and the depth-authority-gate comment a
     * few lines above it). `ensureMaskImage` has no such dependency — it
     * only reads `getWindowMaskUrl(floorIndex)`, a scene-wide catalog lookup,
     * unrelated to which floor is currently viewed — so calling it alone is
     * the narrowest fix that actually closes the gap.
     *
     * Idempotent and safe to call before this floor's OWN subsystem instance
     * would otherwise have been constructed — `getWindowSurfaceForFloor`
     * lazily builds it either way, and constructing floor N's instance here
     * does not touch floor M's (a SEPARATE Map entry — this effect is
     * per-floor by construction, unlike specular's single shared instance,
     * which is why THIS effect gets this hook and specular does not).
     */
    prefetchMask: ensureMaskImage,
    /** True when there is genuinely something to draw — lets the pass take a
     * true JS early-return rather than issuing a render call for a hidden
     * mesh (Effects.md Law 4: gating by uniform is not gating). */
    hasContent: () => mesh.visible,
    /**
     * SCENE READINESS (vt/settle.js probe `windowMaskLoad`) — is a cookie-mask
     * fetch in flight right now? See water-surface-subsystem's own copy of this
     * accessor for why `loading` is the safe thing to gate on.
     */
    isLoadingMask: () => loading,
    getStatus() {
      return {
        visible: mesh.visible,
        debugChannel,
        // THE TIER GATE'S OWN HONESTY CHECK (`feedback_instruments_must_not_
        // lie`), mirroring water-surface-subsystem.js's own field exactly —
        // `perfTier` on the registration's `getRenderState()` is what the
        // cascade RESOLVED; this is what the LIVE material actually compiled
        // with (`windowTierPlan`, read inside `buildSurfaceForTier` above).
        // They can disagree for at most one `sync()` between a resolve and
        // its rebuild; agreeing every other frame is the proof the
        // rebuild-on-tier-change wiring (2026-08-29) is actually running,
        // not just resolved-and-reported the way it was before that fix.
        perfTier: builtForTier,
        enabled,
        floor: loadedFloor,
        bounds: contentBoundsWorld,
        maskImage: maskInfo ?? 'not loaded',
        floorGate: surface.floorGateCompiled,
        contentBoundsUv: loadedContentBoundsUv,
        maskUvBounds: paddedBoundsUv,
        maskRect: loadedMaskRect,
        ambientCeiling,
        // RAIN ON THE GLASS, reported every time rather than behind a console call: is it compiled at this rung,
        // is the glass wet, and did the flow field (which way is down) derive. `flow.derived: false` while it
        // rains means windows are getting splashes only - no _Outdoors, no pool inside a building, or no mask yet.
        rain: {
          compiled: !!surface.rain,
          ...rainReport,
          // The uniforms as actually pushed (is the clock moving? is the slide clock?), for a live report.
          uniforms: surface.rain ? surface.rain.snapshot() : null,
          flow: {
            attempts: rainFlow.attempts,
            derived: rainFlow.derived,
            grid: `${rainFlow.w}x${rainFlow.h}`,
            litCells: rainFlow.litCells,
            levels: rainFlow.levels,
          },
        },
        /** POOL HEALTH — see maskReloadHits' own declaration for the exact
         * hit/miss doctrine. */
        maskReloadGate: { hits: maskReloadHits, misses: maskReloadMisses },
        // SCENE COMPOSITION (2026-08-12) — added to chase a real, still-open
        // finding: the perf report's own `light.drawWindowLight` zone reads
        // ~4 GPU draw calls per `renderer.render(windowSurface.scene, ...)`
        // call, where "ONE MESH, ADDITIVE" (this file's own header, above)
        // predicts 1. Static reading already ruled out `DoubleSide` causing a
        // second internal pass and the profiler's draw-counter itself
        // double-counting (both checked directly against three's vendored
        // source). Reported here, every time, rather than gated behind a
        // console call, so the NEXT `perf-run-full` answers the question from
        // data instead of needing a live session — see
        // `perf-report.js`'s `window-surface-composition` finding, which
        // reads exactly this field and flags it when `sceneChildCount` is
        // not exactly 1 for a visible floor.
        sceneChildCount: scene.children.length,
        sceneChildren: scene.children.map((child) => ({
          type: child.type,
          visible: child.visible,
          // Indexed triangle count (QUAD_INDICES: 6 indices = 2 triangles),
          // not vertex count — a shared/indexed mesh's vertex count does not
          // equal its real triangle count, and this quad is indexed.
          triangles: child.geometry?.index
            ? child.geometry.index.count / 3
            : (child.geometry?.attributes?.position?.count ?? null),
          material: child.material
            ? {
                type: child.material.type,
                // THREE's numeric side constants (FrontSide:0, BackSide:1,
                // DoubleSide:2) decoded here so a reader of the JSON report
                // does not have to hold three's own enum in their head.
                side: WINDOW_MATERIAL_SIDE_NAMES[child.material.side] ?? child.material.side,
                transparent: child.material.transparent,
                visible: child.material.visible,
              }
            : null,
        })),
      };
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      surface.windowMaterial?.dispose?.();
      surface.debugMaterial?.dispose?.();
      maskTexture?.dispose?.();
      rainFlow.dirsTex?.dispose?.();
      rainFlow.auxTex?.dispose?.();
      neutralDirs?.dispose?.();
      neutralAux?.dispose?.();
    },
  };
}
