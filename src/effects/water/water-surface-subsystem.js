/**
 * WATER TIER 0's SURFACE — the mesh, its material, and the high-resolution
 * mask that actually draws its shoreline (`docs/planning/Water.md` §6).
 *
 * `water-render.js` builds the material; this owns the mesh's lifetime, crops
 * it to the water's AABB, and loads the mask image. Extracted from
 * `vt-pan-viewer.js` 2026-07-26 the moment it crossed that file's frozen
 * budget — the standing directive is to split as prep, never to loosen the cap
 * (`feedback_ratchet_proactive_not_reactive`). It follows the door-graphics
 * subsystem's shape exactly, which is not a coincidence: a door and a water
 * surface are the same KIND of thing, an opaque-ish lit map element drawn into
 * `buf:scene.color` before lighting.
 *
 * ============================================================================
 * THE MESH GOES INTO THE MAIN `scene`, AND THAT BUYS THREE THINGS
 * ============================================================================
 *  1. OCCLUSION FOR FREE. This renderer paints by `scene/layer-order.js`'s
 *     painter's algorithm, so upper-floor art, decks and roofs draw OVER water
 *     with their own alpha and their holes let it through. That IS "the punch"
 *     — see `water-render.js` for why the planned `buf:scene.attr` read is both
 *     unnecessary and unsafe.
 *  2. THE `gAttr = vec4(0)` CONTRACT FOR FREE. `runGeometryWorldPass` renders
 *     `scene` under the renderer-global zero-attr MRT, which is exactly what
 *     B0-3 requires of a transparent: water READS attributes, never writes them.
 *  3. No extra render call, no extra target, no extra pass wiring.
 *
 * RENDER ORDER 0.5 puts it immediately above the floor background (always index
 * 0 of the sorted list — the bottom of the elevation/sortLayer sort) and below
 * every token, tile and roof, which are 1..N-1. Fractional on purpose:
 * `sortByLayer` owns the integers, so water claims no index and cannot collide
 * with one. A real LayerKey for water is the honest fix and is a deferred rung,
 * the same caveat the door leaves carry.
 *
 * ============================================================================
 * ⚠️ CONSTRUCT THIS AFTER `scene` EXISTS — TRAP #4
 * ============================================================================
 * The caller must build this where `scene` is already initialized. A first
 * draft built the mesh beside water's OTHER wiring ~3,400 lines earlier in
 * `startVtPanViewer()` and threw `Cannot access 'scene' before initialization`
 * on every load — `scene` is a `const` in its temporal dead zone until its own
 * line runs. That is trap #4 of `VT-Pan-Viewer-Extraction.md`, hit three times
 * now by the same instinct ("put the code next to its siblings"). Taking
 * `scene` as an explicit argument is what makes the ordering a caller-visible
 * requirement instead of an invisible one.
 *
 * @module effects/water/water-surface-subsystem
 */

import { createLogger } from '../../core/log.js';
import { buildWaterSurfaceMaterial, WATER_DEFAULT_TIER } from './water-render.js';
import { waterKeyLightDirection } from './water-light.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';

const log = createLogger('WaterSurface');

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported.
 * @param {*} args.scene - the MAIN scene. Must already exist (see header).
 * @param {object} args.waterBody - `createWaterBodySubsystem()`'s handle.
 * @param {(floorIndex: number) => string|null} args.getWaterMaskUrl - boot's
 *   seam onto the RESOLVED floor's `_Water` file. Null = no hi-res mask, which
 *   keeps the surface hidden rather than falling back to a blocky SDF edge.
 * @param {(data: Uint8Array, w: number, h: number, filter: string) => *} args.createMaskTexture -
 *   the literal `new THREE.DataTexture(...)`, defined in `vt/` (trap #5).
 * @param {(url: string) => Promise<object|null>} args.loadMaskImage -
 *   `vt/mask-image.js`'s loader, injected for the same directory-wall reason.
 * @param {*} [args.uViewRect] - envLight's shared view-rect uniform, for tier
 *   3's synthesised eye — the identical object `specular-surface-subsystem.js`
 *   receives, so the two never disagree about where a world point lands.
 * @param {*} [args.uOutdoorsRect] @param {*} [args.outdoorsTexNode] - envLight's
 *   outdoors rect/texture, shared the same way.
 * @param {Function} [args.buildOutdoorsGate] - the world-space gate builder
 *   (`buildWorldSpaceOutdoorsGate`), injected so this module never re-writes
 *   "world XY → mask UV → sample".
 * @param {() => object|null} [args.getSkyHandle] - `effects/sky-access.js`'s
 *   handle for THIS frame. The ONE description of the outdoor light; this
 *   module never touches the hour (`env/one-sun`).
 * @returns {{sync: (floorIndex: number, viewRect?: object|null) => void,
 *   getStatus: () => object, dispose: () => void}}
 */
export function createWaterSurfaceSubsystem({
  THREE,
  scene,
  waterBody,
  getWaterMaskUrl,
  createMaskTexture,
  loadMaskImage,
  getWaterRenderState,
  timeMsNode,
  uViewRect,
  uOutdoorsRect,
  outdoorsTexNode,
  buildOutdoorsGate,
  getSkyHandle,
}) {
  // Default-off shape matching every other effect seam: an un-wired caller
  // (the torture fixture) renders exactly as it did before water existed.
  getWaterRenderState ??= () => ({ enabled: true, params: {} });
  getSkyHandle ??= () => null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  geometry.setIndex(Array.from(QUAD_INDICES));

  /** A 1×1 all-zero (no water) placeholder until the real mask decodes. The
   * mesh stays hidden until then, so this is never actually sampled — which is
   * why the shader needs no "do I have a mask yet" uniform gate
   * (`tsl/no-uniform-gates`): `mesh.visible` is the gate, JS-side. */
  let maskTexture = createMaskTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, 'linear');
  let maskInfo = null;
  let loadedUrl = null;
  let loading = false;
  /** The bake generation the geometry was cropped for (-1 = never). */
  let builtForBake = -1;
  /** The resolved-params signature last pushed, so a quiet frame is one string
   * compare rather than three uniform writes. */
  let lastParamsKey = '';
  /** The sky signature last pushed — mirrors `specular-surface-subsystem.js`'s
   * own `lastSkyKey`, and for the same reason: the sky only changes when the
   * clock or the weather does, unlike the eye, which moves every pan. */
  let lastSkyKey = '';
  let enabled = true;
  /** THE PERFORMANCE TIER THE CURRENT MATERIALS WERE BUILT AT (Effects.md Law
   * 4 — a tier is a JS `if` at graph-BUILD time, so a tier CHANGE means a new
   * node graph, which means new materials, never a live uniform toggle on the
   * existing ones). Mirrors candle flame's own `candleFlameQuality` +
   * rebuild-on-change pattern (`vt-pan-viewer.js`). Seeded at the default so
   * the FIRST build (below, before any `sync()` has resolved a real tier)
   * shows today's shipped look, same reasoning as `WATER_DEFAULT_TIER` itself. */
  let builtForTier = WATER_DEFAULT_TIER;

  /** The ONE place visibility is decided, so the three conditions can never
   * drift apart across the call sites that each learn about one of them —
   * and, since tier 1, so the two meshes can never drift apart either. Half a
   * water surface (absorption with no in-scatter, or the reverse) is a far
   * worse failure than none, and it would look like a shader bug. */
  function refreshVisibility() {
    const show = enabled && !!waterBody.getWaterBounds() && !!loadedUrl;
    for (const m of meshes) m.visible = show;
  }

  /** Build (or, called again from `sync`, REBUILD) the two tier-gated
   * materials. Reads `waterBody`/`maskTexture` live at call time rather than
   * closing over a snapshot, so a rebuild triggered by a tier change always
   * reflects the CURRENT bake and mask, not whatever was current when the
   * subsystem was constructed. */
  function buildSurfaceForTier(tier) {
    return buildWaterSurfaceMaterial({
      THREE,
      maskTexture,
      maskRect: waterBody.getRect(),
      // TIER 1's wet band reads the SDF. The body texture is null until the
      // first bake allocates the targets, and the material only samples it
      // (from tier 1 up) once the mesh is visible — which requires a
      // completed bake — so a null here is never sampled. `sync` re-points it
      // every bake regardless.
      bodyTexture: waterBody.texture,
      bodyRect: waterBody.getRect(),
      // TIER 2's field travels with THE SHARED CLOCK, handed down rather than
      // sampled — `time/one-clock` names water as the effect that broke this in
      // V2 by reading `performance.now()` in eight independent places. A null
      // here (the torture fixture) yields a still surface, never a private clock.
      timeMsNode,
      // TIER 3 — see `water-light.js`. All four are envLight's own shared state,
      // the identical objects `specular-surface-subsystem.js` receives.
      uViewRect,
      uOutdoorsRect,
      outdoorsTexNode,
      buildOutdoorsGate,
      tier,
    });
  }

  let surface = buildSurfaceForTier(builtForTier);
  // TWO meshes over ONE geometry — water is a multiply THEN an add, and blend
  // state is per-material (see `water-render.js`'s header for why one alpha
  // blend cannot be both). They share the geometry object, so the AABB crop
  // below still writes exactly one position buffer.
  //
  // 0.5 / 0.51 — fractional on purpose, since `sortByLayer` owns the integers:
  // both sit above the floor background (0) and below every token and roof
  // (1..N-1), and absorption strictly precedes in-scatter. The order matters
  // less than it looks (multiply and add commute over a bed) but it is the
  // physical order and it costs nothing to be right.
  const meshes = [
    Object.assign(new THREE.Mesh(geometry, surface.absorbMaterial), { renderOrder: 0.5 }),
    Object.assign(new THREE.Mesh(geometry, surface.inscatterMaterial), { renderOrder: 0.51 }),
  ];
  for (const m of meshes) {
    m.frustumCulled = false; // world-space; the camera rect moves every frame
    m.visible = false; // until BOTH a bake and the hi-res mask land
    scene.add(m);
  }

  /**
   * THE SHORELINE'S ACTUAL SOURCE. Loads the resolved floor's `_Water` file at
   * `MASK_IMAGE_SCALE` and hands it to the material.
   *
   * This replaced thresholding the SDF — see `water-render.js`'s header for why
   * three earlier fixes at the SDF layer could not work. Async and idempotent:
   * the mesh stays hidden until the texture lands, a fraction of a second after
   * the bake, which needs no shader-side fallback path.
   */
  function ensureMaskImage(floorIndex) {
    const url = getWaterMaskUrl(floorIndex);
    if (!url || url === loadedUrl || loading) return;
    loading = true;
    loadMaskImage(url)
      .then((loaded) => {
        loading = false;
        if (!loaded) return; // already logged loudly by the loader
        maskTexture?.dispose?.();
        maskTexture = loaded.texture;
        maskInfo = {
          url,
          uploaded: `${loaded.width}x${loaded.height}`,
          native: `${loaded.nativeWidth}x${loaded.nativeHeight}`,
          mb: +(loaded.bytes / (1024 * 1024)).toFixed(1),
        };
        loadedUrl = url;
        surface.maskTexNode.value = loaded.texture;
        // The mask file is placed exactly like the level background it rides
        // with, which is the same rect the derivation grid covers — verified
        // live (both read 2700,1350→13350,6300 on the author's scene).
        surface.setMaskRect(waterBody.getRect());
        refreshVisibility();
      })
      .catch((err) => {
        loading = false;
        log.error('water mask image load rejected —', err);
      });
  }

  /**
   * Per-frame, called right after `waterBody.maybeBake`. Gated on the SAME bake
   * generation, so a quiet frame is one integer compare and the geometry is
   * re-cropped only when the flood actually produced something new.
   * @param {number} floorIndex - the VIEWED floor; the body pack resolves the
   *   borrow itself, and `getWaterMaskUrl` is asked for the RESOLVED one.
   * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} [viewRect] -
   *   the camera's world rect, for tier 3's synthesised eye position. Optional:
   *   a caller that never passes it just never moves the eye, which is a
   *   correct (if static) tier-3 render rather than a crash.
   */
  function sync(floorIndex, viewRect) {
    ensureMaskImage(floorIndex);

    // THE LOOK/TIER STATE — fetched ONCE, at the top, because the tier-rebuild
    // check right below must run BEFORE anything calls a setter on `surface`:
    // a rebuilt surface is a brand-new object, and every setter further down
    // (setViewCentre, setSky, the param pushes) must land on IT, not on the
    // one that is about to be disposed.
    const state = getWaterRenderState();

    // THE TIER GATE (Effects.md Law 4). A resolved tier different from what
    // the CURRENT materials were built at means a DIFFERENT node graph —
    // fewer (or more) texture fetches, a smaller (or larger) compiled shader.
    // Rebuilding is the only way to actually change the compiled shader; a
    // uniform cannot (Law 4's own test — water-render.js's header). Mirrors
    // candle flame's material rebuild on a quality-tier change.
    const resolvedTier = Number.isFinite(state.perfTier) ? state.perfTier : WATER_DEFAULT_TIER;
    if (resolvedTier !== builtForTier) {
      const prev = surface;
      surface = buildSurfaceForTier(resolvedTier);
      meshes[0].material = surface.absorbMaterial;
      meshes[1].material = surface.inscatterMaterial;
      prev.absorbMaterial?.dispose?.(); // free the superseded materials on a tier change
      prev.inscatterMaterial?.dispose?.();
      builtForTier = resolvedTier;
      // Force every cached value below to re-push onto the FRESH material — it
      // starts back at its constructor defaults, and the key-based caches
      // below exist to skip REDUNDANT writes, not the first write to a new
      // object.
      lastParamsKey = '';
      lastSkyKey = '';
    }

    // THE EYE. Pushed every frame and NEVER gated on anything — mirrors
    // `specular-surface-subsystem.js`'s identical reasoning: this is the whole
    // reason the sun-glint moves when the author pans, so a cached-key skip
    // here would silently make it static
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
          keyDir: waterKeyLightDirection(sky.key),
          keyColor: sky.key.colorRgb ?? [1, 1, 1],
          keyStrength: sky.key.strength ?? 0,
          fillColor: sky.fill?.colorRgb ?? [1, 1, 1],
          fillStrength: sky.fill?.strength ?? 0,
        });
      }
    }

    // THE LOOK PARAMS, pushed every frame. Cheap (three uniform writes against
    // a cached key) and it must NOT ride the bake gate below: a slider drag
    // changes no geometry and produces no new bake, so gating these on the
    // bake generation would make every control in the panel do nothing until
    // the mask happened to change — which is exactly the residency-sync bug
    // class this codebase has already paid for once
    // (`feedback_residency_sync_vs_render_loop`). `state` was already fetched
    // at the top of this function, ahead of the tier gate.
    const p = state.params ?? {};
    const key = [
      state.enabled ? 1 : 0,
      p.tint,
      p.opacity,
      p.shorelineDepth,
      p.absorption,
      p.depthScalePx,
      p.inscatter,
      p.foam,
      p.flowSpeedPx,
      p.flowAngleDeg,
      p.waveScalePx,
      p.wetBandPx,
      p.wetStrength,
      p.sunGlint,
      p.skySheen,
      p.glossiness,
      p.viewerHeight,
    ].join('|');
    if (key !== lastParamsKey) {
      lastParamsKey = key;
      if (Array.isArray(p.tint)) surface.setTint(p.tint);
      if (Number.isFinite(p.opacity)) surface.setOpacity(p.opacity);
      if (Number.isFinite(p.shorelineDepth)) surface.setShorelineDepth(p.shorelineDepth);
      if (Number.isFinite(p.absorption)) surface.setAbsorption(p.absorption);
      if (Number.isFinite(p.depthScalePx)) surface.setDepthScalePx(p.depthScalePx);
      if (Number.isFinite(p.inscatter)) surface.setInscatter(p.inscatter);
      if (Number.isFinite(p.foam)) surface.setFoam(p.foam);
      if (Number.isFinite(p.flowSpeedPx)) surface.setFlowSpeedPx(p.flowSpeedPx);
      if (Number.isFinite(p.flowAngleDeg)) surface.setFlowAngleDeg(p.flowAngleDeg);
      if (Number.isFinite(p.waveScalePx)) surface.setWaveScalePx(p.waveScalePx);
      if (Number.isFinite(p.wetBandPx)) surface.setWetBandPx(p.wetBandPx);
      if (Number.isFinite(p.wetStrength)) surface.setWetStrength(p.wetStrength);
      if (Number.isFinite(p.sunGlint)) surface.setSunGlint(p.sunGlint);
      if (Number.isFinite(p.skySheen)) surface.setSkySheen(p.skySheen);
      if (Number.isFinite(p.glossiness)) surface.setGlossiness(p.glossiness);
      if (Number.isFinite(p.viewerHeight)) surface.setViewerHeight(p.viewerHeight);
      enabled = state.enabled !== false;
      refreshVisibility();
    }

    if (builtForBake === waterBody.bakeGeneration) return;
    builtForBake = waterBody.bakeGeneration;
    const bounds = waterBody.getWaterBounds();
    refreshVisibility();
    if (!bounds) return;
    surface.setMaskRect(waterBody.getRect());
    // TIER 1's wet band samples the SDF — re-point it every bake, since a
    // regrid recreates the target and the old texture would go stale.
    // `bodyTexNode` is `null` below tier 1 (never sampled there — see
    // water-render.js's header), so this is guarded rather than assumed.
    if (waterBody.texture && surface.bodyTexNode) surface.bodyTexNode.value = waterBody.texture;
    surface.setBodyRect(waterBody.getRect());
    const positions = buildQuadPositions([
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
      { x: bounds.minX, y: bounds.maxY },
    ]);
    const posAttr = geometry.getAttribute('position');
    if (posAttr && posAttr.array.length === positions.length) {
      posAttr.array.set(positions);
      posAttr.needsUpdate = true; // same buffer, new contents (BufferAttribute has no dispose)
    } else {
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    }
  }

  return {
    sync,
    /** For the `water-body` report — merged into the body pack's own status. */
    getStatus() {
      return {
        visible: meshes[0].visible,
        // Both, listed: tier 1 made water two draws, and "the multiply is
        // showing but the add is not" is a state the old single number could
        // not have reported.
        renderOrder: meshes.map((m) => m.renderOrder).join(' + '),
        builtForBake,
        // THE TIER GATE'S OWN HONESTY CHECK (`feedback_instruments_must_not_
        // lie`) — `perfTier` is what the cascade RESOLVED; `builtForTier` is
        // what the live materials actually compiled with `if (activeTier >=
        // N)` (water-render.js). They can disagree for at most one `sync()`
        // between a resolve and its rebuild; agreeing every other frame is
        // the proof the rebuild-on-change wiring is actually running.
        perfTier: builtForTier,
        bounds: waterBody.getWaterBounds(),
        // `null` means the hi-res mask has not loaded, and the surface is
        // therefore hidden BY DESIGN — the SDF is not asked to draw the edge
        // any more, so there is nothing to fall back to. `uploaded` vs
        // `native` shows MASK_IMAGE_SCALE actually applied; if `uploaded` ever
        // reads about the same as the derivation grid (~512), the hi-res path
        // is not running and the old blocky look is back.
        maskImage: maskInfo ?? 'not loaded',
        // `false` means every pixel takes tier 3's indoors path (zero sun/sky
        // reflection) regardless of what the map looks like — silent on
        // screen, never guessed at.
        outdoorsGate: surface.outdoorsGateCompiled,
      };
    },
    dispose() {
      for (const m of meshes) scene.remove(m);
      geometry.dispose(); // shared by both meshes — disposed once, not per mesh
      surface.absorbMaterial?.dispose?.();
      surface.inscatterMaterial?.dispose?.();
      maskTexture?.dispose?.();
    },
  };
}
