/**
 * THE SUN-SHADOW SUBSYSTEM — building + overhead + sky-reach + sky-occlusion,
 * as one owned unit. Extraction step 1 of `docs/planning/VT-Pan-Viewer-
 * Extraction.md` (2026-07-25): the first subsystem pulled out of
 * `vt-pan-viewer.js`'s 10,484-line `startVtPanViewer()`, chosen because it is
 * newest, best-understood, and already had a pure core (`sun-occlusion.js`) +
 * a render module (`sun-occlusion-render.js`) + its own status report — the
 * fewest closure dependencies of anything in that file.
 *
 * ============================================================================
 * THE RULE THIS FOLLOWS (Extraction plan §1)
 * ============================================================================
 *
 * "A subsystem is not extracted while it still reads closure state. No
 * explicit parameter list = it did not happen." Every input this module needs
 * is named below — nothing is reached for from an enclosing scope, because
 * there is no enclosing scope; this is its own module.
 *
 * ⚠️ TWO INPUTS ARE REASSIGNED ELSEWHERE and are taken as GETTERS, not values
 * (Extraction plan trap #1 — the exact class of bug `wind-access.js` and
 * `feedback_residency_sync_vs_render_loop` both name): `shadowHandle` is
 * rebuilt whenever the sky changes; `envLight` does not exist yet at the
 * moment this subsystem is constructed (see §2 below). A getter captured now
 * and called only later, once the real value is guaranteed to exist, is safe;
 * capturing the value itself would freeze it at construction time.
 *
 * ============================================================================
 * §2 — WHY `envLight` IS A GETTER, NOT A CONSTRUCTOR VALUE
 * ============================================================================
 *
 * `buildEnvironmentalLightMaterials` (environmental-light.js) needs THIS
 * subsystem's `texture` as one of ITS OWN construction params — so this
 * subsystem must exist BEFORE `envLight` does. But `bakeCasterTexture` (below)
 * needs to call `envLight.setSunShadowRect(...)` on every rebake. A plain
 * `envLight` parameter captured at construction would be `undefined` (or throw
 * a TDZ ReferenceError for a `const` not yet initialized — the EXACT crash
 * class this project hit live on 2026-07-24 with `SUN_SHADOW_FIELD_DIM`).
 *
 * The fix: `getEnvLight: () => envLight`, a closure written in the CALLER's
 * own scope where `envLight` is a `const` declared moments later. It is only
 * ever INVOKED from inside `bakeCasterTexture`, which only ever runs via
 * `maybeBake()`, which only ever runs from the frame loop — by which time the
 * caller's synchronous setup (including the `const envLight = ...` line) has
 * long finished. The one-time INITIAL push of the placeholder rect (what the
 * original inline code did synchronously, right after building envLight) stays
 * the CALLER's own explicit responsibility — see this module's own usage
 * example below — because doing it from inside this factory would require
 * calling `getEnvLight()` before `envLight` exists, which is exactly the crash
 * this design avoids.
 *
 * ============================================================================
 * §3 — WHY THE ACTUAL GPU CALLS ARE INJECTED, NOT MADE HERE
 * ============================================================================
 *
 * The first draft of this module called `renderer.setRenderTarget(...)` and
 * `new THREE.DataTexture(...)` directly — and `verify-structure.mjs` correctly
 * rejected both: `renderer-state/graph-only` allows `.setRenderTarget(` only
 * inside `vt/`, `graph/`, `diag/`; `gpu/textures-in-vt-only` allows
 * `new ...Texture(` only inside `vt/`. Both walls exist for the exact reason
 * this extraction is happening — V2 scattered these calls across dozens of
 * files and nobody could reason about ownership. Moving this code to
 * `effects/lighting/` does not get a pass just because it USED to live inside
 * `vt/vt-pan-viewer.js`.
 *
 * The fix is the same shape as `getCasterHeightField`/`getSunShadowRenderState`
 * below: the two literal GPU-touching operations are CALLBACKS the caller
 * defines (so the literal `.setRenderTarget(`/`new ...Texture(` text stays
 * inside `vt-pan-viewer.js`, the one place in the codebase both walls already
 * sanction), and this module only decides WHEN to invoke them and WITH WHAT
 * DATA — `renderSunShadowPass(target, quad)` and `createCasterTexture(data, w,
 * h)`. This is the frame-graph pattern the walls themselves prescribe ("A pass
 * declares reads/writes and is HANDED a target") applied a step early, before
 * an actual frame graph exists.
 *
 * ============================================================================
 * USAGE (the shape the caller's own two-phase construction takes)
 * ============================================================================
 *
 *   function renderSunShadowPass(target, quad) {
 *     const prev = renderer.getRenderTarget();
 *     renderer.setRenderTarget(target);   // NOT `.target` — see §3 and the
 *     quad.render(renderer);              // module's own bakeSunShadowField.
 *     renderer.setRenderTarget(prev);
 *   }
 *   function createSunShadowCasterTexture(data, w, h) {
 *     const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
 *     tex.minFilter = tex.magFilter = THREE.LinearFilter;
 *     tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
 *     tex.needsUpdate = true;
 *     return tex;
 *   }
 *   const sunShadows = createSunShadowSubsystem({
 *     THREE, allocator, dimensions,
 *     getCasterHeightField, getSunShadowRenderState, getMaskAuthorityVersion,
 *     getShadowHandle: () => shadowHandle,
 *     getEnvLight: () => envLight,
 *     renderSunShadowPass,
 *     createCasterTexture: createSunShadowCasterTexture,
 *   });
 *   const envLight = buildEnvironmentalLightMaterials({
 *     ..., sunShadowTexture: sunShadows.texture,
 *   });
 *   envLight.setOutdoorsRect(outdoorsRect);
 *   envLight.setSunShadowRect(sunShadows.getRect());   // the one-time initial push
 *
 *   // Per frame (light.accumulate, exactly where the inline call used to be):
 *   sunShadows.maybeBake(view?.floorIndex ?? 0);
 *
 *   // Per-light material build (point-light-illumination.js):
 *   sunShadowTexture: sunShadows.texture, uSunShadowRect: envLight.uSunShadowRect,
 *
 *   // Diagnostics:
 *   sunShadows: { compiled: envLight.sunShadowCompiled, ...sunShadows.getStatus() },
 *
 *   // Teardown (its own entry in disposeActive's list — see Extraction plan trap #3):
 *   sunShadows.dispose();
 *
 * ============================================================================
 * A LEAK THIS EXTRACTION FIXES, FOUND WHILE MOVING THE CODE
 * ============================================================================
 *
 * Neither `sunShadowRt` nor `sunShadowBake.material` had ANY registered
 * dispose call anywhere in `vt-pan-viewer.js` — every Stop/Restart cycle
 * leaked one 1024² RGBA8 render target and one NodeMaterial. Not found by
 * looking for it; found because giving the subsystem an honest `dispose()`
 * made the absence visible. `dispose()` below is the fix; the CALLER must
 * still wire it into the existing teardown (this module cannot reach into
 * `disposeActive`'s registration list itself — see the Extraction plan's own
 * "not a rewrite" rule: wiring the call is a one-line follow-up, not bundled
 * silently into this move).
 *
 * @module effects/lighting/sun-shadow-subsystem
 */

import { buildSunShadowBakeMaterial } from './sun-occlusion-render.js';
import { resolveSunMarch, sunNeedsRebake } from './sun-occlusion.js';
import { buildSunShadowDebugMaterial, sunShadowDebugPaints } from './sun-shadow-debug.js';

/**
 * The baked shadow field's resolution. A fixed square in WORLD space, so its
 * cost is O(1) in map size — a 12000px map and a 2000px map both get exactly
 * this many texels (Keyhole.md §0's cost law). 1024 across a typical 8000px
 * map is ~8px/texel — finer than the caster data itself (`vt/coarse-alpha.js`
 * caps items at 512 a side), so raising this alone buys nothing; the lever for
 * a crisper contact edge is the alpha grid.
 */
export const SUN_SHADOW_FIELD_DIM = 1024;

/** Samples per march ray. Quality, never reach — the step length derives from
 * the field's own tallest caster, so more steps means fewer missed thin
 * casters over the SAME distance. 24 (down from 32, 2026-07-24): the
 * dawn/dusk length cap makes the span much shorter at low sun, so 24 steps
 * over the capped span are FINER than 32 were over the uncapped one. */
export const SUN_SHADOW_MARCH_STEPS = 24;

/** How far the sun must move before the field is re-marched. Without this a
 * running day clock re-bakes every frame — exactly the cost model this design
 * exists to avoid; half a degree is invisible and turns sixty bakes a second
 * into a few a minute. */
export const SUN_SHADOW_QUANTIZE_DEG = 0.5;

/** The minimum feather at the contact point, px — no shadow is a perfect
 * cutout, not even where it meets the wall casting it. */
export const SUN_SHADOW_BASE_PENUMBRA_PX = 3;

/** Default width of the map-edge ramp (the author's own suggested cure for the
 * shadow gap at the scene boundary — see `buildSunShadowBakeMaterial`). */
export const SUN_SHADOW_EDGE_BAND_PX = 384;

/**
 * Build the subsystem. See this module's own header for the two-phase
 * construction `getEnvLight` requires and §3 for why the two GPU-touching
 * operations are callbacks rather than direct calls.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.allocator - `graph/three-allocator.js`'s instance.
 * @param {{sceneRect: object}} args.dimensions
 * @param {(floorIndex: number) => object|null} args.getCasterHeightField -
 *   boot's seam (`scene/sky-reach-access.js` behind it).
 * @param {() => {enabled: boolean, params: object}} args.getSunShadowRenderState
 * @param {(() => number)|null} [args.getMaskAuthorityVersion]
 * @param {() => {atmosphere: object}} args.getShadowHandle - LIVE getter; see header.
 * @param {() => {setSunShadowRect: Function}} args.getEnvLight - LIVE getter; see header.
 * @param {(target: *, quad: *) => void} args.renderSunShadowPass - the literal
 *   save/bind/render/restore triplet, defined in `vt/` (see §3).
 * @param {(data: Uint8Array, w: number, h: number) => *} args.createCasterTexture -
 *   the literal `new THREE.DataTexture(...)` + filter setup, defined in `vt/`.
 * @returns {{
 *   texture: *,
 *   getRect: () => {minX:number,minY:number,maxX:number,maxY:number},
 *   maybeBake: (floorIndex: number) => void,
 *   getStatus: () => object,
 *   dispose: () => void,
 * }}
 */
export function createSunShadowSubsystem({
  THREE,
  allocator,
  dimensions,
  getCasterHeightField,
  getSunShadowRenderState,
  getMaskAuthorityVersion,
  getShadowHandle,
  getEnvLight,
  renderSunShadowPass,
  createCasterTexture,
}) {
  // ── STATE (was 11 viewer-closure locals; now this module's own) ─────────
  //
  // A 1×1 EMPTY caster height field — no casters, and (critically) a receiver
  // gate of ZERO, so the march is a provable no-op before any real field is
  // baked. Deliberately NOT white (which would read as "a 2048px building on
  // every texel" — the whole map in shadow from frame one, the exact black-
  // screen-by-construction class `keyhole-grade-engine-built` already named
  // once for the LUT tail). A placeholder whose failure mode is invisible
  // beats one whose failure mode is a black screen.
  let casterTexture = createCasterTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  let casterRect = { ...dimensions.sceneRect };
  /** The tallest caster in the current field, px — sizes the march's reach. */
  let casterMaxHeightPx = 0;
  /** The last bake's inputs + outcome, verbatim, for the status report. */
  let lastSunShadowBake = null;
  /** The sun the live field was baked for (null = never baked). */
  let bakedSun = null;
  /** The version of the caster field the live texture was built from. */
  let casterFieldVersion = -1;
  /** The floor the live caster field belongs to. */
  let casterFieldFloor = -1;
  let lastCasterBakeResult = null;
  let lastSunShadowParamsKey = '';

  // TWO textures, both SCENE-SPACE (world-aligned, camera-independent):
  //   `casterTexture` — the height field, uploaded from the mask authority's
  //                     derived channels (R coverAbove, G overhead, B
  //                     sky-reach, A the `_Outdoors` receiver).
  //   `sunShadowRt`   — the marched result, sampled once per frame by the
  //                     ambient fill AND per-fragment by every point light.
  // Neither is re-made per frame. The march runs only when the QUANTISED sun
  // moves, the masks change, or the floor changes — panning and zooming are
  // free, which is why a 24-step march is affordable here and never was in V2
  // (which re-marched a view-aligned target every frame).
  const sunShadowRt = allocator.create('scene.sunShadow', {
    resolvedW: SUN_SHADOW_FIELD_DIM,
    resolvedH: SUN_SHADOW_FIELD_DIM,
    // NOT screenSized: a fixed square in WORLD space, O(1) in map size — a
    // 12000px map and a 2000px map both get exactly this. Under the 2048
    // world-res cap, so no `allowWorldScale` exception is claimed.
    screenSized: false,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    filter: 'linear',
    depth: false,
  });

  const sunShadowBake = buildSunShadowBakeMaterial({
    THREE,
    casterTexture,
    steps: SUN_SHADOW_MARCH_STEPS,
  });
  const sunShadowQuad = new THREE.QuadMesh(sunShadowBake.material);

  // THE DEBUG VIEW, built LAZILY on first use (sun-shadow-debug.js). Two
  // reasons, both load-bearing: it needs `envLight`'s uniforms, which do not
  // exist while this factory runs (see §2), and a player who never opens the
  // dropdown should never compile a second fullscreen material for it.
  /** @type {{material: *, setView: Function, setCasterTexture: Function}|null} */
  let debug = null;
  let debugQuad = null;
  let debugViewId = 'off';
  function ensureDebug() {
    if (debug) return debug;
    const env = getEnvLight();
    debug = buildSunShadowDebugMaterial({
      THREE,
      shadowTexture: sunShadowRt.texture,
      casterTexture,
      // SHARED uniforms, never copies — the debug view must frame the picture
      // exactly as the render it is diagnosing does, or it is diagnosing
      // something else (Extraction plan trap #2).
      uViewRect: env.uViewRect,
      uShadowRect: env.uSunShadowRect,
    });
    debugQuad = new THREE.QuadMesh(debug.material);
    debug.setView(debugViewId);
    return debug;
  }

  /**
   * Upload a floor's occluder height field as one RGBA texture.
   *
   * THE PACKING: R = coverAbove (sky-occlusion's own input — "is anything
   * solid directly overhead"), G = overhead height, B = sky-reach height, A =
   * the floor's raw `_Outdoors` (the receiver gate, so the test costs no
   * second fetch). Building height is NOT a channel — it is
   * `buildingHeightPx × (1 − outdoors)`, recomputed in-shader from A, since
   * storing it would be pure redundancy.
   *
   * @param {number} floorIndex
   * @returns {object} the outcome, verbatim, for the status report.
   */
  function bakeCasterTexture(floorIndex) {
    let field = null;
    try {
      field = getCasterHeightField(floorIndex);
    } catch (err) {
      return { ok: false, floorIndex, reason: String(err?.message ?? err) };
    }
    const channels = field?.channels;
    const gateGrid = field?.outdoors;
    if (!channels?.height?.spec || !gateGrid?.data) {
      return { ok: false, floorIndex, reason: 'no caster height field for this floor' };
    }
    const spec = channels.height.spec;
    const { w, h } = spec;
    if (!(w > 0 && h > 0)) return { ok: false, floorIndex, reason: `degenerate grid ${w}x${h}` };

    const data = new Uint8Array(w * h * 4);
    let maxByte = 0;
    let coveredTexels = 0;
    for (let i = 0; i < w * h; i++) {
      const height = channels.height.data[i] ?? 0;
      const overhead = channels.coverOverhead?.data[i] ?? 0;
      const building = channels.coverBuilding.data[i] ?? 0;
      // ⚠️ R IS SKY-REACH ONLY (2026-07-26) — NOT `coverFloating`, which also
      // folded in this FLOOR'S OWN overhead items. `d = 0` reads R raw, with no
      // march, as "something solid stands directly over THIS PIXEL" — genuinely
      // true for an upper FLOOR's structure (that art is not drawn at this
      // pixel; the ground beneath it stays visible and honestly darkened). For
      // an overhead item on the SAME floor, this pixel's only visible content
      // IS the item's own opaque art — there is no separate, visible "ground
      // beneath" to darken, so a same-floor item shading itself was pure
      // self-shadowing: a lantern-on-a-plinth prop read its own footprint as
      // "something floating overhead" and painted a false, self-inflicted
      // shadow through its own sprite (docs/planning/Sun-Shadows-Rethink.md §4b).
      // Overhead's coverage/height still march-cast normally below via B/G —
      // only the zero-distance self-check excludes it.
      data[i * 4 + 0] = channels.coverSkyReach?.data[i] ?? 0;
      data[i * 4 + 1] = height;
      data[i * 4 + 2] = building > overhead ? building : overhead;
      data[i * 4 + 3] = gateGrid.data[i] ?? 255;
      if (height > maxByte) maxByte = height;
      if (data[i * 4 + 0] > 0 || data[i * 4 + 2] > 0) coveredTexels++;
    }

    // `createCasterTexture` is the caller's callback (see §3) — LINEAR
    // filtering so a silhouette edge is a ramp rather than a staircase of
    // mask texels, which the march's contact-hardening depends on.
    const tex = createCasterTexture(data, w, h);

    casterTexture?.dispose();
    casterTexture = tex;
    sunShadowBake.casterTexNode.value = tex;
    debug?.setCasterTexture(tex);
    casterRect = { x: spec.x, y: spec.y, width: spec.width, height: spec.height };
    // The G channel now carries EVERY producer's height including the authored
    // building one (mask-derive.js merges them), so this is the whole field's
    // reach in one read — no second `Math.max` against a param that the field
    // may or may not have actually used.
    casterMaxHeightPx = (maxByte / 255) * (field.scalePx ?? 0);
    const rect = {
      minX: casterRect.x,
      minY: casterRect.y,
      maxX: casterRect.x + casterRect.width,
      maxY: casterRect.y + casterRect.height,
    };
    sunShadowBake.setRect(rect);
    sunShadowBake.setField({ heightScalePx: field.scalePx ?? 0 });
    getEnvLight().setSunShadowRect(rect);
    // A new field invalidates whatever was marched from the old one.
    bakedSun = null;
    return {
      ok: true,
      floorIndex,
      cols: w,
      rows: h,
      maxCasterHeightPx: Math.round(casterMaxHeightPx),
      // ⚠️ READ THESE TWO TOGETHER. Casters present with a max height of ZERO is
      // the silent failure that hid sky-reach: a floor with no declared
      // `bottomElevation` gives every caster height 0, and every count stays
      // healthy while the field casts nothing. `caster-coverage` vs
      // `caster-height` in the debug dropdown is the same test, by eye.
      coveredTexels,
      coveredPct: +((coveredTexels / (w * h)) * 100).toFixed(1),
      completeness: field.completeness ?? null,
      rect,
    };
  }

  /**
   * Run the march into `scene.sunShadow`. Cheap to CALL and expensive to RUN,
   * which is why every caller goes through `maybeBake` instead.
   * @param {string} reason - what triggered this, verbatim, for the report.
   */
  function bakeSunShadowField(reason) {
    const state = getSunShadowRenderState();
    const atmosphere = getShadowHandle().atmosphere;
    const params = state.params ?? {};
    // A DISABLED effect, or a field with nothing in it, bakes WHITE — an
    // explicit, provable "no shadow anywhere" rather than a stale field left
    // multiplying the ambient forever. (The pass cannot simply be skipped:
    // the ambient fill always samples this texture now, so "off" has to be a
    // written value, not an unwritten one — the same correctness gotcha the
    // UI-shadow hit when it stopped having a draw to skip.)
    const active = state.enabled && casterMaxHeightPx > 0;
    const resolved = resolveSunMarch({
      azimuthDeg: atmosphere.azimuthDeg,
      elevationDeg: atmosphere.elevationDeg,
      maxCasterHeightPx: active ? casterMaxHeightPx : 0,
      steps: SUN_SHADOW_MARCH_STEPS,
      // THE LENGTH CONTROLS — global scale + dawn/dusk cap, both folded into
      // the ONE effective tangent resolveSunMarch computes, so the shorter
      // span also means smaller steps (finer, and cheaper).
      lengthScale: params.lengthScale ?? 1,
      maxLengthMul: params.dawnDuskLength ?? 0,
    });
    sunShadowBake.setSun(atmosphere.azimuthDeg, atmosphere.elevationDeg, resolved);
    sunShadowBake.setLook({
      strength01: active ? Math.max(0, Math.min(1, params.strength01 ?? 1)) * atmosphere.strengthMul : 0,
      softnessMul: atmosphere.softnessMul * Math.max(0.05, params.softnessBias ?? 1),
      basePx: SUN_SHADOW_BASE_PENUMBRA_PX,
    });
    sunShadowBake.setEdgeBandPx(params.edgeBandPx ?? SUN_SHADOW_EDGE_BAND_PX);

    // The literal save/bind/render/restore triplet lives in `vt/` (§3) — this
    // module only decides WHEN it needs to run.
    renderSunShadowPass(sunShadowRt, sunShadowQuad);

    bakedSun = { azimuthDeg: atmosphere.azimuthDeg, elevationDeg: atmosphere.elevationDeg };
    lastSunShadowBake = {
      reason,
      enabled: !!state.enabled,
      active,
      sun: { ...bakedSun },
      maxCasterHeightPx: Math.round(casterMaxHeightPx),
      steps: SUN_SHADOW_MARCH_STEPS,
      fieldDim: SUN_SHADOW_FIELD_DIM,
      marchSpanPx: Math.round(resolved.spanPx),
      softnessMul: +(atmosphere.softnessMul * Math.max(0.05, params.softnessBias ?? 1)).toFixed(3),
    };
    return lastSunShadowBake;
  }

  /**
   * The per-frame question, kept as cheap as it sounds: has anything that
   * ACTUALLY changes the shadows changed?
   *
   * ⚠️ Must be called from the FRAME LOOP, never from a residency-triggered
   * function. A uniform sync placed inside a residency pass only updates on
   * pan/zoom — the exact bug that made vegetation's own sliders do nothing
   * until the camera moved (`feedback_residency_sync_vs_render_loop`). The sun
   * moving is not a camera event, so a camera-gated rebake would be silently
   * frozen at dawn.
   *
   * @param {number} floorIndex
   */
  function maybeBake(floorIndex) {
    const version = getMaskAuthorityVersion ? getMaskAuthorityVersion() : casterFieldVersion;
    if (version !== casterFieldVersion || floorIndex !== casterFieldFloor) {
      casterFieldVersion = version;
      casterFieldFloor = floorIndex;
      lastCasterBakeResult = bakeCasterTexture(floorIndex);
    }
    const state = getSunShadowRenderState();
    const paramsKey = JSON.stringify(state.params ?? {}) + (state.enabled ? '|on' : '|off');
    const paramsChanged = paramsKey !== lastSunShadowParamsKey;
    if (paramsChanged) lastSunShadowParamsKey = paramsKey;
    if (paramsChanged || sunNeedsRebake(bakedSun, getShadowHandle().atmosphere, SUN_SHADOW_QUANTIZE_DEG)) {
      bakeSunShadowField(paramsChanged ? 'param' : bakedSun ? 'sun' : 'first');
    }
  }

  return {
    /** The marched field's texture — shared by the ambient fill (via
     * `envLight`, which took this at ITS OWN construction) and every point
     * light's per-fragment sample (`point-light-illumination.js`). */
    texture: sunShadowRt.texture,
    /** The world rect `texture` currently covers. The caller pushes this into
     * `envLight.setSunShadowRect` ONCE, right after building envLight (see
     * this module's own header) — subsequent pushes happen internally, from
     * `bakeCasterTexture`, on every real rebake. */
    getRect() {
      return {
        minX: casterRect.x,
        minY: casterRect.y,
        maxX: casterRect.x + casterRect.width,
        maxY: casterRect.y + casterRect.height,
      };
    },
    /** Which floor `texture`'s field currently holds DATA for — set by the
     * most recent `maybeBake`, even on a call that skipped an actual rebake
     * (the field's existing content is still correctly attributed to this
     * floor in that case). The caller pushes this into
     * `envLight.setSunShadowFloorIndex` every frame, right after `maybeBake`,
     * so the ambient fill can refuse to apply this field to a DIFFERENT
     * floor's own content drawn in the same multi-floor frame (KNOWN-REMAINING
     * gap in `Sun-Shadows-Rethink.md` §5 — this is that fix's data source). -1
     * before the first bake ever runs, which correctly matches no real floor.
     */
    getBakedFloorIndex() {
      return casterFieldFloor;
    },
    maybeBake,
    /**
     * The fullscreen debug quad to draw INSTEAD of the present pass, or null
     * when the view is `off` (the normal case, and the only cost is this
     * comparison). The viewer draws it — this module never touches the
     * renderer (§3).
     * @param {string} viewId - the `debugView` param's current value.
     */
    getDebugQuad(viewId) {
      if (!sunShadowDebugPaints(viewId)) return null;
      ensureDebug();
      if (viewId !== debugViewId) {
        debugViewId = viewId;
        debug.setView(viewId);
      }
      return debugQuad;
    },
    /** For `boot.js`'s "Sun shadows" report. `compiled` is NOT included — it
     * is a property of `envLight`'s own shader graph, not this subsystem; the
     * caller merges it in (see this module's own USAGE example). */
    getStatus() {
      return {
        caster: lastCasterBakeResult ?? 'never baked',
        lastBake: lastSunShadowBake ?? 'never marched',
        fieldDim: SUN_SHADOW_FIELD_DIM,
        steps: SUN_SHADOW_MARCH_STEPS,
      };
    },
    /** Tear down this subsystem's OWN GPU state. Found while extracting this
     * module: neither `sunShadowRt` nor `sunShadowBake.material` had ANY
     * registered dispose call before this — a real leak, on every
     * Stop/Restart cycle. NOT `sunShadowQuad.geometry` — `QuadMesh` shares
     * ONE module-level `QuadGeometry` across every `QuadMesh` in the process
     * (three.webgpu.js), so disposing it would break every other fullscreen
     * pass. The CALLER must still wire this into the existing teardown
     * registration (`disposeActive`'s list) — this module cannot reach it.
     */
    dispose() {
      allocator.dispose(sunShadowRt);
      sunShadowBake.material?.dispose?.();
      debug?.material?.dispose?.();
      casterTexture?.dispose?.();
    },
  };
}
