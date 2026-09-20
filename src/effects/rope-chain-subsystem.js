/**
 * ROPE & CHAIN — THE CPU SUBSYSTEM (Phase 2, mythica-machina-press#1). Owns
 * every rope/chain SOURCE's own independent lifecycle: its 1x1 ping/pong/
 * publish spring-state render targets, its ribbon geometry/material/mesh,
 * and the per-sync/per-tick uniform + geometry refresh. Mirrors the SHAPE of
 * `lightning-subsystem.js` (explicit injected-dependency factory function,
 * `{sync, tick/dispose}`-style return) and `vegetation-shadow-subsystem.js`
 * (no closure-captured viewer state — every input is named in this factory's
 * own destructured argument, per that file's own "a subsystem is not
 * extracted while it still reads closure state" rule) — but deliberately
 * NOT their POOLING. Read on before changing this file's own Map-of-
 * instances shape.
 *
 * ============================================================================
 * PER-INSTANCE, NOT POOLED — A DELIBERATE, SCOPED EXCEPTION
 * ============================================================================
 * See `rope-chain-spring-gpu.js`'s own header for the full argument;
 * summarized here because it drives this file's entire shape. Lightning
 * pools its strands into one draw call because its per-vertex envelope is a
 * PURE function of `(spawnMs, seed, now)`, baked once — no persistent GPU
 * state feeds back frame-to-frame. Vegetation pools its clumps because they
 * form a dense, REGULAR grid covering a whole scene, with per-cell state
 * looked up by simple arithmetic from world position. Rope & Chain is
 * neither: each span sits at an ARBITRARY GM-placed position (not a grid)
 * AND needs genuine persistent per-instance spring state fed back every
 * frame (the whole point of the ping-pong integrator). Pooling that would
 * require either a second "probe positions" data texture keyed by instance,
 * or per-instance scissor-rendering into sub-regions of one shared texture —
 * both unprecedented techniques in this codebase and pure risk for zero real
 * benefit, because the realistic instance count for this effect (decorative
 * props — chandelier chains, bridge cables, prison chains) is single digits
 * to perhaps a few dozen at the extreme, not the hundreds/thousands
 * lightning strands or vegetation clumps must handle. So: every rope/chain
 * SOURCE gets its own independent `BufferGeometry`, its own `Mesh`, its own
 * material instance, and its own tiny 1x1-texel ping/pong/publish
 * render-target trio, tracked in the `instances` Map below, keyed by
 * `linkId`.
 *
 * ============================================================================
 * WHY THIS NEEDS NO EFFECT-REGISTRY MANIFEST, NO STUDIO CARD, NO
 * `graph/passes.js` ENTRY (checked directly, not assumed)
 * ============================================================================
 * `scene/anchor-catalog.js`'s `ropeChain` kind already declares
 * `effectId: 'ropeChain'` (Phase 1) — `anchor-authority.js#anchorsForEffect`
 * resolves purely off that catalog entry, with NO dependency on
 * `effects/registry.js`/`effect-manifest.js` at all. `boot.js`'s own comment
 * on the `wind` Studio card states the general fact directly: "a Studio card
 * needs no manifest to exist (the two registries are independent —
 * DOOR_GRAPHICS is the opposite proof, a manifest with no card)." So there
 * is nothing gating this effect's anchors behind a manifest.
 *
 * Rendering itself needs no `graph/passes.js` entry either: every instance's
 * `mesh` is added directly to the viewer's ONE shared `scene`
 * (`vegetation-shadow-subsystem.js`'s own `attachTileShadow` does the exact
 * same `scene.add(mesh)`, confirmed by reading it), which
 * `vt-pan-viewer.js#runGeometryWorldPass` already draws unconditionally,
 * every frame, via a plain `renderer.render(scene, camera)` — a pass that
 * exists regardless of any effect's registration status. Lightning is the
 * one effect that DOES need an extra explicit draw call
 * (`renderer.render(lightningSubsystem.scene, camera)`, vt-pan-viewer.js),
 * but only because it owns a SEPARATE always-on-top additive-glow scene, not
 * because the registry requires it — Rope & Chain is an ordinary opaque
 * prop and needs no such thing.
 *
 * Net finding: Phase 2 ships a fully rendering effect with NO
 * `effects/rope-chain.js` manifest file at all. If Phase 3 needs one (for a
 * Studio card, `enabledFromProfile`, or a params schema), that is new,
 * additive work — nothing here depends on one existing first.
 *
 * ============================================================================
 * WHY THE ACTUAL GPU RENDER CALLS ARE INJECTED, NOT MADE HERE (caught live by
 * `npm run verify:structure`, not assumed — see the fix's own commit)
 * ============================================================================
 * A first draft of this file called `renderer.setRenderTarget(...)` directly
 * inside `tick()`/instance creation, and `verify-structure.mjs` correctly
 * rejected it: `renderer-state/graph-only` allows `.setRenderTarget(` only
 * inside `vt/`/`graph/`/`diag/` — living in `effects/` buys no exemption
 * (`sun-shadow-subsystem.js`'s own §3 documents the identical fix at length;
 * `water-body-subsystem.js`/`water-refraction-subsystem.js`/
 * `prism-refraction-subsystem.js` all follow it too). The fix is the same
 * shape: the literal GPU-touching operation is a CALLBACK the caller injects
 * — `renderRopeChainPass(target, quad)` — and this module only decides WHEN
 * to invoke it and WITH WHAT quad. `vt-pan-viewer.js` passes its own existing
 * `renderSunShadowPass` function for this (reused VERBATIM, not copied — it
 * is a plain save/bind/render/restore triplet with nothing sun-specific in
 * it, the same "one generic primitive, many locally-named call sites" reuse
 * `renderWaterPass`/`renderPrismCapturePass` already are), aliased at the
 * call site under this effect's own parameter name.
 *
 * The corollary: this file never needs `renderer` itself, only the one
 * injected callback — there is no `renderer.getRenderTarget()`/`.clear()`
 * dance here either (see {@link import('./rope-chain-spring-gpu.js').buildRopeChainSpringZeroMaterial}'s
 * own doc for how a freshly allocated target is zero-filled through the SAME
 * injected callback instead).
 *
 * ============================================================================
 * KNOWN, HONEST GAP — NO DEPTH-AUTHORITY OCCLUSION THIS PHASE
 * ============================================================================
 * Unlike lightning/candle, this material never wires the depth-authority
 * gate (`lighting/point-light-illumination.js#buildDepthHeightGateNode`) —
 * the Phase 2 brief scoped shadow-casting to Phase 3 and never asked for
 * elevation-based occlusion either, so a rope drawn on one floor will not
 * correctly fade behind a higher floor's opaque content the way lightning's
 * bolt does. `groupRopeChainAnchorsIntoSources` already carries `elevation`
 * (read by `getRopeChainAnchors` in boot.js, mirroring
 * `getLightningRenderState`'s own `resolveAnchorElevationWorldUnits` call)
 * for exactly this purpose, unused by this phase — a straightforward Phase 3
 * follow-up, not a redesign.
 *
 * @module effects/rope-chain-subsystem
 */

import { createLogger } from '../core/log.js';
import {
  groupRopeChainAnchorsIntoSources,
  buildRopeChainRibbonArrays,
  computeRopeChainWindProbes,
  ROPE_CHAIN_PRESETS,
} from './rope-chain-geometry.js';
import { hexToRgb01 } from './lightning-geometry.js';
import {
  buildRopeChainSpringMaterials,
  buildRopeChainSpringZeroMaterial,
  ROPE_CHAIN_SPRING_MAX_DT_SEC,
} from './rope-chain-spring-gpu.js';
import { buildRopeChainGeometry, refillRopeChainGeometry, buildRopeChainMaterial } from './rope-chain-render.js';

const log = createLogger('RopeChain');

/**
 * Samples per span, for EVERY instance (a build-time constant, not a live
 * param — mirrors lightning's own `LIGHTNING_MAX_POINTS_PER_STRAND`
 * posture). A smooth parabolic-sag + 2-mode-sine curve needs far fewer
 * points than lightning's jagged fractal path (96) to read as smooth; 32 is
 * generous for a curve this simple, at negligible cost even at this effect's
 * upper realistic bound of a few dozen instances (32 points x 2 verts = 64
 * verts/instance).
 */
const ROPE_CHAIN_POINTS_PER_SPAN = 32;

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported (the bloom split's rule).
 * @param {*} args.scene - the viewer's one `THREE.Scene`. Every instance's
 *   mesh is added here ONCE, at creation, and removed on teardown — see this
 *   file's own "WHY THIS NEEDS NO ... graph/passes.js ENTRY" header for why
 *   that alone is enough to get it drawn every frame.
 * @param {*} args.allocator - ThreeAllocator, the one door to a
 *   RenderTarget (`gpu/allocator-only`). Several existing
 *   `effects/*-subsystem.js` files already call `allocator.create`/
 *   `.dispose` directly (water refraction/prism refraction subsystems,
 *   verified as REAL call sites, not just comments) — this file follows
 *   that same, already-established precedent rather than inventing a new
 *   one.
 * @param {(target:*, quad:*) => void} args.renderRopeChainPass - the
 *   injected GPU-touching callback (see this file's own "WHY THE ACTUAL GPU
 *   RENDER CALLS ARE INJECTED" header) — `vt-pan-viewer.js`'s own
 *   `renderSunShadowPass`, reused verbatim under this effect's own
 *   parameter name. Used for the integrate pass, the publish pass, AND the
 *   allocate-time zero-fill (via {@link
 *   import('./rope-chain-spring-gpu.js').buildRopeChainSpringZeroMaterial}'s
 *   quad) — one primitive, three uses.
 * @param {*} args.uGlobalTimeMs - the shared animation-clock TSL uniform
 *   node (a plain value — `const`, never reassigned — same posture
 *   `createLightningSubsystem`'s own `uGlobalTimeMs` param takes).
 * @param {() => object} args.getWindHandle - ⚠️ A GETTER, not a value — the
 *   SAME "getters vs values" pattern `vt-pan-viewer.js` already uses for
 *   every other consumer of its reassignable `windHandle` local
 *   (point-light pool, fire subsystem: `getWindHandle: () => windHandle`),
 *   because `windHandle` is reassigned on every wind rebake and a plain
 *   value would freeze this effect at whatever wind existed the moment it
 *   was constructed. Called fresh wherever the live handle (and its
 *   `.version`) is needed.
 * @param {() => Array<object>} args.getRopeChainAnchors - boot's data seam
 *   (`boot.js#getRopeChainAnchors`), mirroring `getLightningRenderState`'s
 *   own per-anchor shape (`{id, x, y, params, elevation}`) but returning the
 *   bare anchor ARRAY, not an `{enabled, params, anchors}` envelope — Rope &
 *   Chain has no effectRegistry manifest yet (see this file's own header),
 *   so there is no cascade-resolved enable flag to project; the presence of
 *   a complete start+end anchor pair IS this effect's own on/off switch.
 *   Default-empty (via the `??=` at the `startVtPanViewer` call site) means
 *   an un-wired caller renders no ropes.
 * @returns {{sync:()=>void, tick:(nowMs:number, dtSec:number)=>void, dispose:()=>void}}
 */
export function createRopeChainSubsystem({
  THREE,
  scene,
  allocator,
  renderRopeChainPass,
  uGlobalTimeMs,
  getWindHandle,
  getRopeChainAnchors,
}) {
  /** @type {Map<string, object>} linkId -> InstanceRecord */
  const instances = new Map();

  // ONE shared, stateless zero-fill quad for every instance's own allocate-
  // time zero-fill — see buildRopeChainSpringZeroMaterial's own doc for why
  // this exists instead of a direct renderer.clear() call.
  const zeroFill = buildRopeChainSpringZeroMaterial({ THREE });

  function describeSpringRT() {
    return {
      resolvedW: 1,
      resolvedH: 1,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      filter: 'nearest', // a 1x1 texture has no neighbour to blend against
      depth: false,
    };
  }

  /** Zero-fill freshly allocated render targets — fresh GPU memory is
   * UNDEFINED content, and a NaN bit-pattern here would multiply through
   * every subsequent tick forever (same reasoning
   * `vt-pan-viewer.js#ensureVegetationSpringGrid`'s own regrid clear
   * carries). Achieved by rendering the shared zero quad through the SAME
   * injected `renderRopeChainPass`, never a direct `renderer.clear()` —
   * see this file's own "WHY THE ACTUAL GPU RENDER CALLS ARE INJECTED"
   * header. */
  function zeroFillTargets(rts) {
    for (const rt of rts) renderRopeChainPass(rt, zeroFill.quad);
  }

  /** (Re)build an instance's spring materials from its CURRENT `rec.source`
   * — called at instance creation and again whenever the live wind handle
   * has been reassigned (see `tick`'s own version check). Disposes any
   * previous materials first (a no-op the first time, `rec.springMaterials`
   * starts null). Freshly-built uniforms already carry the CORRECT probe/
   * perpendicular values (baked in at construction from `rec.source`'s
   * current start/end) — no separate `updateProbeUniforms` call needed
   * right after this. */
  function buildSpringMaterialsFor(rec) {
    const { perpX, perpY, probeAX, probeAY, probeBX, probeBY } = computeRopeChainWindProbes(rec.source);
    const windHandle = getWindHandle();
    rec.springMaterials?.dispose();
    rec.springMaterials = buildRopeChainSpringMaterials({
      THREE,
      initialStateTexture: rec.pingRT.texture,
      publishTexture: rec.pingRT.texture,
      windHandle,
      time: uGlobalTimeMs,
      probeAWorld: { x: probeAX, y: probeAY },
      probeBWorld: { x: probeBX, y: probeBY },
      perpDir: { x: perpX, y: perpY },
    });
    rec.springMaterialsWindVersion = windHandle.version;
  }

  /** Push `ROPE_CHAIN_PRESETS[preset]` + `windAffected` onto the spring
   * integrator's own uniforms — pure uniform writes, no geometry/material
   * rebuild, safe to call on every sync/rebuild alike. */
  function applyPhysicsUniforms(rec) {
    const preset = ROPE_CHAIN_PRESETS[rec.source.preset] ?? ROPE_CHAIN_PRESETS.rope;
    rec.springMaterials.integrate.uModeStiffness.value = preset.modeStiffness;
    rec.springMaterials.integrate.uModeDamping.value = preset.modeDamping;
    // preset.windCoupling * source.windAffected, folded together ONCE here,
    // on the CPU — see rope-chain-spring-gpu.js's own doc for why the GPU
    // integrator takes one already-combined uniform rather than
    // multiplying twice per fragment for no benefit.
    rec.springMaterials.integrate.uEffectiveWindCoupling.value = preset.windCoupling * num(rec.source.windAffected, 1);
  }

  /** Push thickness/taper/colour onto the ribbon material's own uniforms —
   * pure uniform writes; `thicknessPx`/`color` are never baked into the
   * geometry (only sagPx and the endpoints are — see `bakedShapeChanged`). */
  function applyRenderUniforms(rec) {
    const preset = ROPE_CHAIN_PRESETS[rec.source.preset] ?? ROPE_CHAIN_PRESETS.rope;
    rec.uniforms.uThicknessPx.value = num(rec.source.thicknessPx, 20);
    rec.uniforms.uTaper.value = preset.taper;
    const [r, g, b] = hexToRgb01(rec.source.color);
    rec.uniforms.uColor.value.set(r, g, b);
  }

  /** Re-point the spring integrator's own probe/perpendicular uniforms at a
   * (possibly dragged) source's CURRENT start/end — a live uniform update,
   * never a rebuild. Cheap enough (see `computeRopeChainWindProbes`'s own
   * doc) to call unconditionally on every `updateInstance`, rather than only
   * when the endpoints provably moved. */
  function updateProbeUniforms(rec) {
    const { perpX, perpY, probeAX, probeAY, probeBX, probeBY } = computeRopeChainWindProbes(rec.source);
    rec.springMaterials.integrate.uProbeA.value.set(probeAX, probeAY);
    rec.springMaterials.integrate.uProbeB.value.set(probeBX, probeBY);
    rec.springMaterials.integrate.uPerpDir.value.set(perpX, perpY);
  }

  /** Whether `buildRopeChainRibbonArrays` would bake a DIFFERENT shape for
   * this source than it did last sync — the ONLY fields that feed the baked
   * `positions`/`prevPos`/`nextPos` arrays (`rope-chain-geometry.js#
   * buildRopeChainRibbonArrays` reads exactly `startX/startY/endX/endY/
   * sagPx` and nothing else from a source). `preset`/`thicknessPx`/
   * `windAffected`/`color` are deliberately NOT checked here — they only
   * ever drive uniforms (`applyPhysicsUniforms`/`applyRenderUniforms`),
   * never the baked arrays, so changing them alone must never trigger a
   * geometry rebuild. */
  function bakedShapeChanged(oldSource, newSource) {
    return (
      oldSource.startX !== newSource.startX ||
      oldSource.startY !== newSource.startY ||
      oldSource.endX !== newSource.endX ||
      oldSource.endY !== newSource.endY ||
      oldSource.sagPx !== newSource.sagPx
    );
  }

  /** Re-bake this instance's ribbon geometry in place — a fresh
   * `buildRopeChainRibbonArrays([rec.source], ...)` call (the SAME
   * ZERO-callback used at creation: live modal sway is added in the vertex
   * shader, never baked — see `rope-chain-render.js`'s own header) refilled
   * into the EXISTING BufferGeometry via `refillRopeChainGeometry`. Vertex/
   * index COUNT never changes for a given instance (always exactly
   * `ROPE_CHAIN_POINTS_PER_SPAN` points), so this is always a cheap in-place
   * `.array.set()`, never a reallocation. */
  function refillGeometryFor(rec) {
    const arrays = buildRopeChainRibbonArrays([rec.source], ROPE_CHAIN_POINTS_PER_SPAN, () => 0);
    refillRopeChainGeometry(THREE, rec.geometry, arrays);
  }

  /** A `linkId` newly present in `sources` — allocate its trio, bake its
   * geometry, build its material, add its mesh to `scene`. */
  function buildInstance(source) {
    const pingRT = allocator.create(`ropeChain.${source.linkId}.ping`, describeSpringRT());
    const pongRT = allocator.create(`ropeChain.${source.linkId}.pong`, describeSpringRT());
    const publishRT = allocator.create(`ropeChain.${source.linkId}.publish`, describeSpringRT());
    zeroFillTargets([pingRT, pongRT, publishRT]);

    // The ZERO-callback here is deliberate and important: this bakes the
    // SAG-ONLY base shape. Live modal sway is added dynamically in the
    // vertex shader (rope-chain-render.js), NOT baked into this array.
    const arrays = buildRopeChainRibbonArrays([source], ROPE_CHAIN_POINTS_PER_SPAN, () => 0);
    const geometry = buildRopeChainGeometry(THREE, arrays);
    const renderBundle = buildRopeChainMaterial({
      THREE,
      pointsPerSpan: ROPE_CHAIN_POINTS_PER_SPAN,
      publishTexture: publishRT.texture,
    });
    const mesh = new THREE.Mesh(geometry, renderBundle.material);
    // World-space, camera bounds vary per frame — same posture lightning's
    // own strand mesh takes for the identical reason.
    mesh.frustumCulled = false;
    scene.add(mesh);

    const rec = {
      linkId: source.linkId,
      source,
      pingRT,
      pongRT,
      publishRT,
      pingIsCurrent: true,
      springMaterials: null,
      springMaterialsWindVersion: -1,
      geometry,
      mesh,
      material: renderBundle.material,
      uniforms: renderBundle.uniforms,
    };
    buildSpringMaterialsFor(rec);
    applyPhysicsUniforms(rec);
    applyRenderUniforms(rec);
    return rec;
  }

  /** A `linkId` present in both the Map and this sync's `sources` — update
   * IN PLACE. Never rebuilds the RTs/material/mesh (which would reset the
   * live spring state to rest every time a GM nudges an unrelated slider) —
   * only the geometry (if the baked shape changed) and uniforms refresh. */
  function updateInstance(rec, source) {
    const shapeChanged = bakedShapeChanged(rec.source, source);
    rec.source = source;
    if (shapeChanged) refillGeometryFor(rec);
    updateProbeUniforms(rec);
    applyPhysicsUniforms(rec);
    applyRenderUniforms(rec);
  }

  /** A `linkId` no longer present in `sources` — tear down its mesh/
   * geometry/material/spring materials and release its render targets.
   * `allocator.dispose(rt)` is this codebase's one release convention
   * (`graph/three-allocator.js` has no separate `release`) — confirmed by
   * grepping every other `effects/*-subsystem.js` file's own teardown path
   * before writing this. */
  function destroyInstance(rec) {
    try {
      scene.remove(rec.mesh);
      rec.geometry.dispose();
      rec.material.dispose();
      rec.springMaterials?.dispose();
      allocator.dispose(rec.pingRT);
      allocator.dispose(rec.pongRT);
      allocator.dispose(rec.publishRT);
    } catch (err) {
      log.error('rope/chain instance dispose failed — GPU buffers may leak until renderer.dispose():', err);
    }
  }

  /**
   * Per-frame (or per-resolve — whatever cadence the caller uses; the
   * viewer calls this once per frame, mirroring `lightningSubsystem.sync()`'s
   * own cadence). Re-derives `sources` from `getRopeChainAnchors()` +
   * `groupRopeChainAnchorsIntoSources`, unconditionally — the SAME posture
   * `lightning-subsystem.js#syncLightning` already takes (no "skip if the
   * anchor array is unchanged" optimization there either); cheap at this
   * effect's realistic scale (a handful of instances), not worth the extra
   * bookkeeping to avoid.
   */
  function sync() {
    const anchors = getRopeChainAnchors();
    const { sources } = groupRopeChainAnchorsIntoSources(Array.isArray(anchors) ? anchors : []);
    const liveLinkIds = new Set(sources.map((s) => s.linkId));

    for (const [linkId, rec] of instances) {
      if (!liveLinkIds.has(linkId)) {
        destroyInstance(rec);
        instances.delete(linkId);
      }
    }

    for (const source of sources) {
      const existing = instances.get(source.linkId);
      if (existing) updateInstance(existing, source);
      else instances.set(source.linkId, buildInstance(source));
    }
  }

  /**
   * Per-frame: the ping-pong-drive for every live instance's own
   * independent spring trio — `tickVegetationSpring`'s exact shape (set
   * `uDtSec` clamped to `ROPE_CHAIN_SPRING_MAX_DT_SEC`, render the integrate
   * pass into the "other" RT, swap current/other, render the publish pass
   * from the new current into the dedicated publish RT), one instance at a
   * time in a loop — the direct cost of this effect's per-instance-not-
   * pooled decision (N tiny renders instead of 1-2 pooled ones), fine at
   * this effect's realistic scale. MUST run after this frame's wind field is
   * fresh (the SAME "AFTER tickWindSim" ordering `tickVegetationSpring`'s
   * own call site requires) — enforced by the call site in
   * `vt-pan-viewer.js`, not by this function.
   *
   * @param {number} nowMs @param {number} dtSec
   */
  function tick(nowMs, dtSec) {
    if (instances.size === 0) return;
    const dt = Math.min(Math.max(0, dtSec), ROPE_CHAIN_SPRING_MAX_DT_SEC);
    const windHandle = getWindHandle();

    for (const rec of instances.values()) {
      // Rebuild this instance's spring materials whenever the wind handle
      // has been reassigned (a scene-wide rebake) — same "cheap enough to
      // check every tick" posture `tickVegetationSpring` takes for its own
      // single shared material, applied per-instance here. Without this, a
      // rope built before a live wind rebake (a door opening, an
      // ambient-dial change — see `bakeWindField`'s own 5 rebake reasons)
      // would sample a dead field forever.
      if (rec.springMaterialsWindVersion !== windHandle.version) {
        buildSpringMaterialsFor(rec);
        applyPhysicsUniforms(rec);
      }

      const sm = rec.springMaterials;
      sm.integrate.uDtSec.value = dt;

      let currentRT = rec.pingIsCurrent ? rec.pingRT : rec.pongRT;
      let otherRT = rec.pingIsCurrent ? rec.pongRT : rec.pingRT;

      // Each renderRopeChainPass call saves/binds/renders/restores the
      // renderer's own target on its own (renderSunShadowPass's own body) —
      // no outer save/restore needed here, unlike a raw setRenderTarget
      // loop would have required.
      for (const n of sm.integrate.prevTexNodes) n.value = currentRT.texture;
      renderRopeChainPass(otherRT, sm.integrate.quad);
      [currentRT, otherRT] = [otherRT, currentRT];

      sm.publish.sourceTexNode.value = currentRT.texture;
      renderRopeChainPass(rec.publishRT, sm.publish.quad);

      rec.pingIsCurrent = currentRT === rec.pingRT;
    }
  }

  /** Tear down every live instance plus the shared zero-fill material —
   * mirrors `disposeLightning`'s own "safe whether or not anything was ever
   * built" posture. Not wired into any automatic scene-unload path today
   * (no established convention to hook — `vegetation-shadow-subsystem.js`'s
   * own header records the identical gap for its meshes); provided for
   * symmetry with every other subsystem's own `dispose()`, and for a future
   * Studio "Stop/Restart" control (Phase 3) to call. */
  function dispose() {
    for (const rec of instances.values()) destroyInstance(rec);
    instances.clear();
    zeroFill.material.dispose();
  }

  return { sync, tick, dispose };
}
