/**
 * FLUID's SURFACE — one mesh PER MASKED ITEM, its material, its mask and its
 * baked tube pack.
 *
 * ============================================================================
 * ⚠️ FLUID IS A PER-ITEM EFFECT. THIS IS THE BUG THAT MADE IT RENDER NOTHING.
 * ============================================================================
 * The first two drafts asked the mask authority for a FLOOR's mask —
 * `authoredStatus(levelId, 'fluid')` — because that is what `water-seams.js`
 * and `specular-seams.js` do. Both of those are LEVEL-BACKGROUND effects: a
 * river and a metal floor are painted into the level's own art, so the
 * floor-keyed door is the right one for them.
 *
 * **Glass tubes are not.** The author's map paints them on an **overhead
 * tile**, and `authoredStatus`'s own doc says exactly what it is — *"a
 * convenience wrapper for the single most common case, this LEVEL's own
 * BACKGROUND file"*. A tile's mask is not reachable through it, so the seam
 * returned null, the mesh never became visible, and nothing errored anywhere.
 * V2 knew this: `FluidEffectV2` walked `canvas.scene.tiles.contents` and
 * probed each tile's own art. So did the project's own standing decision —
 * `keyhole-mask-any-item-decision`: *every mask attaches to ANY item — tile,
 * level background, or level foreground, symmetrically, for EVERY effect.*
 *
 * The door for that is `authoredStatusForItem(itemId, kind)`. This subsystem
 * therefore keeps a mesh PER MASKED ITEM rather than one per floor, and each
 * mesh is the item's OWN QUAD — which is also why the material samples
 * `uv()` instead of mapping a world rect: the mask covers exactly that quad,
 * the same way the item's albedo does, and a ROTATED tile comes out right for
 * free (a rect has no rotation, so the previous version could not have handled
 * one at all, silently).
 *
 * ============================================================================
 * THE CHAIN, END TO END
 * ============================================================================
 *   masked ITEMS  ──getFluidMaskItems──▶ [{id, url, placement}]
 *   the mask FILE ──loadMaskImage──▶     bytes + a texture
 *          bytes  ──extractTubeNet──▶    components, geodesic arc length, profiles
 *            net  ──buildFluidPack──▶    one RGBA buffer
 *           pack  ──createPackTexture──▶ a texture the materials sample
 *            net  ──buildSim (below)──▶  a ping-pong SIM per item: the profile
 *                                         texture (baked once), the pump
 *                                         texture (rewritten every tick), the
 *                                         advect material (`fluid-sim.js`)
 *        texture  ──buildFluidSurfaceMaterials──▶ TWO meshes (absorb, emit),
 *          + sim                                  reading the sim's CURRENT
 *                                                  ping-pong half as `phi`
 *
 * ⚠️ **CONSTRUCT THIS AFTER `scene` EXISTS** — trap #4 of
 * `VT-Pan-Viewer-Extraction.md`. `scene` is a `const` in its temporal dead zone
 * until its own line runs; taking it as an explicit argument makes the ordering
 * a caller-visible requirement rather than an invisible one.
 *
 * THE BAKE TRIGGER IS THE MASK URL, and it is the only one. A previous draft
 * also shipped a version-polling module; two triggers for one bake is
 * `feedback_mode_forks_silently_drop_features`, so the loser was deleted. A url
 * changes on a scene or item change and at no other time, so "bakes do not
 * track frames" holds by construction — `getStatus()` reports `bakes` against
 * `syncs` so it can be SEEN to hold.
 *
 * ============================================================================
 * WHY THE ACTUAL GPU RENDER CALLS ARE NOT IN THIS FILE
 * ============================================================================
 * `renderer-state/graph-only` (`tools/verify-structure.mjs`) walls
 * `.setRenderTarget(`/`.clear(` to `graph/`, `vt/`, `diag/` — this file lives
 * under `effects/fluid/` and may not contain either call, on the same
 * "V2: 452 setRenderTarget sites across 60 files" reasoning that wall exists
 * for at all. `prepareSimTick(nowMs, dtSec)` therefore does every JS-side step
 * (rewrite the pump texture, re-point `prevTexNodes`/`stateTexNodes`, decide
 * what "current" means after this tick) and hands back a small, declarative
 * job list — `{clears, advects}` — for `vt-pan-viewer.js`'s own `tickFluidSim`
 * to actually render, mirroring `world/wind-sim-gpu.js`'s identical split
 * (that file builds materials and takes textures as args; `vt-pan-viewer.js`'s
 * `tickWindSim` does the `renderer.setRenderTarget`/`quad.render` calls).
 *
 * @module effects/fluid/fluid-surface-subsystem
 */

import { createLogger } from '../../core/log.js';
import { buildFluidSurfaceMaterials } from './fluid-render.js';
import { extractTubeNet, FLUID_PROFILE_SAMPLES } from './fluid-net.js';
import { buildFluidPack, FLUID_PACK_MAX_DIM } from './fluid-pack.js';
import {
  buildFluidAdvectMaterial,
  buildFluidProfileBuffer,
  writeFluidTubeConstantsBuffer,
  computeFluidLengthQScale,
} from './fluid-sim.js';
import { fluidPumpPersonality } from './fluid-pump.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';

const log = createLogger('FluidSurface');

/**
 * Render order — both fluid passes sit in the same reserved fractional band
 * water and the candle flame already use: `scene/layer-order.js#sortByLayer`
 * stamps the floor background at index 0 and every real item (a tile, a
 * token) at an INTEGER index ≥ 1, so anything in the open interval `(0, 1)`
 * is guaranteed, by construction, to draw after the background and before
 * every item — no per-tile lookup needed. Both constants below stay well
 * inside that band.
 *
 * ⚠️ **CORRECTED 2026-07-27.** This file's own comment used to claim the
 * emissive pass draws "over" the masked tile's art. It does not — see
 * `fluid-render.js`'s header for the full account of that mistake and why the
 * actual number (< 1) was already correct despite the wrong story about it.
 * ABSORB draws first (the lower value), EMIT second, so the emissive glow is
 * never itself darkened by the absorption term it is paired with — that
 * ordering is between the two fluid passes, not between fluid and the tile.
 */
const FLUID_RENDER_ORDER_ABSORB = 0.59;
const FLUID_RENDER_ORDER_EMIT = 0.6;

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported.
 * @param {*} args.scene - the MAIN scene. Must already exist (see header).
 * @param {(floorIndex: number) => Array<{id: string, url: string, corners: Array<{x:number,y:number}>}>} args.getFluidMaskItems -
 *   every item VISIBLE ON THIS FLOOR that has its own authored fluid mask, with
 *   the world-space corners of its quad. Empty array = nothing painted, which
 *   is silently correct (fluid is not a `required` kind).
 * @param {(url: string) => Promise<object|null>} args.loadMaskImage -
 *   `vt/mask-image.js`'s loader, injected for the directory-wall reason.
 * @param {(data: Float32Array, w: number, h: number) => *} args.createPackTexture -
 *   the literal `new THREE.DataTexture(...)`, defined in `vt/`. Reused for the
 *   sim's own profile/pump textures too (same shape: upload a Float32Array as
 *   an RGBA float DataTexture) — no separate seam for what is the same recipe.
 * @param {(name: string, width: number, height: number) => *} args.createSimRenderTarget -
 *   the literal `allocator.create(name, desc)`, defined in `vt/` for the same
 *   directory-wall reason as `createPackTexture` (`gpu/allocator-only`). One
 *   call per ping/pong half, per masked item.
 * @param {(rt: *) => void} args.disposeSimRenderTarget - `allocator.dispose(rt)`.
 * @param {() => {enabled: boolean, params: object}} [args.getFluidRenderState]
 * @param {*} args.timeMsNode - THE SHARED CLOCK.
 * @returns {{sync: (floorIndex: number) => void, prepareSimTick: (nowMs: number, dtSec: number) => {clears: Array<*>, advects: Array<{quad: *, destRT: *}>}, getStatus: () => object, dispose: () => void}}
 */
export function createFluidSurfaceSubsystem({
  THREE,
  scene,
  getFluidMaskItems,
  loadMaskImage,
  createPackTexture,
  createSimRenderTarget,
  disposeSimRenderTarget,
  getFluidRenderState,
  timeMsNode,
}) {
  // ⚠️ NO DEFAULT that fakes a wired seam. `feedback_seam_default_hides_unwired`:
  // water shipped its render-state seam declared, defaulted and never passed,
  // and the ONLY symptom was that every control silently did nothing while all
  // 4,137 tests passed. An absent seam is reported loudly, once.
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

  /** One entry per masked item, keyed by item id. */
  const entries = new Map();
  let enabled = true;
  let syncs = 0;
  let bakes = 0;
  let lastParamsKey = '';
  /** Every url that failed, so a broken file is reported ONCE not every frame. */
  const failedUrls = new Set();

  function refreshVisibility() {
    for (const e of entries.values()) {
      // Both meshes share one fate — they are the same liquid, two blend
      // equations of it — so one flag drives both.
      const visible = enabled && !!e.net && e.net.tubeCount > 0;
      if (e.absorbMesh) e.absorbMesh.visible = visible;
      if (e.emitMesh) e.emitMesh.visible = visible;
    }
  }

  /**
   * Load one item's mask, bake its tube net, and build its mesh.
   * @param {{id: string, url: string, corners: Array<{x:number,y:number}>}} item
   */
  async function loadAndBake(item) {
    const entry = entries.get(item.id);
    if (!entry || entry.loading) return;
    entry.loading = true;
    try {
      const image = await loadMaskImage(item.url);
      if (!image || !image.data) {
        if (!failedUrls.has(item.url)) {
          failedUrls.add(item.url);
          log.error(`fluid mask failed to load for item ${item.id}: ${item.url}`);
        }
        return;
      }
      // Guard the await gap: a scene change during the fetch would otherwise
      // bake a mask for an item that is no longer here.
      if (entries.get(item.id) !== entry || entry.url !== item.url) return;

      // The extractor runs on the FILE's pixels (`Fluid.md` correction #2 — the
      // ≤512 derivation grid merges tubes a tube's width apart), capped at the
      // pack resolution so a huge mask stays bounded.
      //
      // The grid's `spec` carries the item's own world extent purely so texel
      // sizes are in WORLD px — arc length, radius and cross-section are all
      // world-space quantities and would otherwise be measured in texels, which
      // would make flow speed depend on mask resolution.
      const scale = Math.min(1, FLUID_PACK_MAX_DIM / Math.max(image.width, image.height));
      const spanX = Math.max(...item.corners.map((c) => c.x)) - Math.min(...item.corners.map((c) => c.x));
      const spanY = Math.max(...item.corners.map((c) => c.y)) - Math.min(...item.corners.map((c) => c.y));
      const grid = downsample(image.data, image.width, image.height, scale, spanX, spanY);

      entry.net = extractTubeNet({ grid });
      entry.pack = buildFluidPack({ net: entry.net });
      bakes++;

      for (const w of entry.net.warnings) log.warn(`bake (item ${item.id}): ${w}`);
      if (entry.net.tubeCount === 0) {
        log.warn(
          `fluid mask for item ${item.id} produced NO tubes. The mask's RED channel is what counts — ` +
            'presence is `r > 0` (see the `fluid` kind in scene/mask-catalog.js). A mask painted purely ' +
            'in green or blue, or one whose tubes are thinner than a few texels, extracts to nothing.'
        );
        return;
      }
      if (entry.pack.maxTubeWidthTexels < 4) {
        log.warn(
          `item ${item.id}: widest tube is only ${entry.pack.maxTubeWidthTexels.toFixed(1)} pack texels ` +
            'across. Below ~4 the cross-section gradient collapses and tubes shade flat; below ~2 ' +
            'adjacent tubes merge into one flow.'
        );
      }

      entry.packTexture = createPackTexture(entry.pack.data, entry.pack.width, entry.pack.height);
      buildSim(entry);
      buildMesh(entry, image.texture);
      log.info(
        `fluid baked item ${item.id}: ${entry.net.tubeCount} tube(s), widest ` +
          `${entry.pack.maxTubeWidthTexels.toFixed(1)} pack texels`
      );
    } finally {
      entry.loading = false;
      refreshVisibility();
    }
  }

  /**
   * Build one item's SIM: the ping-pong state pair, the static profile
   * texture, the per-tick pump texture, and the advect material — everything
   * `fluid-render.js`'s dependent read needs a `stateTexture` for. Called
   * BEFORE `buildMesh` (which passes `entry.simPingRT.texture` as that
   * `stateTexture`), so a fresh bake never hands the render material a null.
   *
   * Sized `FLUID_PROFILE_SAMPLES x tubeCount` — the SAME resolution
   * `extractTubeNet` baked every tube's own profile arrays at, `fluid-net.js`'s
   * own default (this subsystem never overrides it), so the sim's bins line up
   * with the profile 1:1 with no resampling.
   */
  function buildSim(entry) {
    disposeSim(entry);
    const tubeCount = entry.net.tubeCount;
    if (tubeCount === 0) return; // nothing to transport — buildMesh hides it anyway

    const w = FLUID_PROFILE_SAMPLES;
    const h = tubeCount;
    entry.simTubeCount = tubeCount;
    entry.simPingRT = createSimRenderTarget(`fluid.sim.ping.${entry.id}`, w, h);
    entry.simPongRT = createSimRenderTarget(`fluid.sim.pong.${entry.id}`, w, h);
    entry.simPingIsCurrent = true;
    // Fresh GPU memory is UNDEFINED content, and a NaN entering the sim would
    // propagate through every subsequent multiply/interpolate forever — the
    // exact reason wind's own regrid path clears its fresh RTs explicitly
    // before the first tick ever samples them. The actual `renderer.clear()`
    // call is walled to `vt/` (this file's own header), so this only RAISES
    // the flag; `prepareSimTick` below is what turns it into a real clear.
    entry.simNeedsClear = true;

    entry.simProfileTexture = createPackTexture(buildFluidProfileBuffer(entry.net.tubes, w), w, h);
    // Personalities are derived ONCE per bake from each tube's stable INDEX
    // (`fluidPumpPersonality`'s own contract) — recomputing them every tick
    // would be eight wasted `hash01` calls per tube per frame for an answer
    // that cannot change until the next bake.
    entry.simPersonalities = Array.from({ length: tubeCount }, (_, k) => fluidPumpPersonality(k));
    // Per-tube flow-rate scale — baked once, same reuse discipline as
    // personalities above. `computeFluidLengthQScale`'s own header names the
    // bug this fixes: `FLUID_PUMP_BASE_Q` alone was validated only against
    // small synthetic test tubes and read as over 1,200 seconds to cross a
    // real author's actual (much wider, much longer) tube — this scale is
    // what makes THIS tube's own traversal time land near
    // `FLUID_TARGET_TRAVERSAL_SECONDS` regardless of its absolute size.
    entry.simQScales = entry.net.tubes.map((t) => computeFluidLengthQScale(t));
    // RGBA stride (see fluid-sim.js's own header for why): tick zero's content
    // is never sampled (prepareSimTick always writes fresh values before the
    // first render), so an all-zero initial buffer is fine.
    entry.simPumpTexture = createPackTexture(new Float32Array(tubeCount * 4), 1, tubeCount);

    entry.simAdvect = buildFluidAdvectMaterial({
      THREE,
      prevStateTexture: entry.simPingRT.texture,
      profileTexture: entry.simProfileTexture,
      pumpTexture: entry.simPumpTexture,
    });
  }

  /** Tear down one item's sim resources — the render-target pair, the two
   * upload textures, and the advect material. Called from `disposeMesh` (the
   * two share a lifecycle: a rebake invalidates both, together) and does
   * nothing if the sim was never built (a zero-tube mask). */
  function disposeSim(entry) {
    if (entry.simPingRT) disposeSimRenderTarget(entry.simPingRT);
    if (entry.simPongRT) disposeSimRenderTarget(entry.simPongRT);
    entry.simProfileTexture?.dispose?.();
    entry.simPumpTexture?.dispose?.();
    entry.simAdvect?.material?.dispose?.();
    entry.simPingRT = null;
    entry.simPongRT = null;
    entry.simProfileTexture = null;
    entry.simPumpTexture = null;
    entry.simAdvect = null;
    entry.simPersonalities = null;
    entry.simQScales = null;
    entry.simTubeCount = 0;
    entry.simNeedsClear = false;
    entry.simPingIsCurrent = true;
  }

  /**
   * Build BOTH meshes for one item, sharing ONE geometry — they are the same
   * quad, drawn twice with two different blend equations, never two different
   * shapes that could drift apart.
   */
  function buildMesh(entry, maskTexture) {
    disposeMesh(entry);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
    geometry.setIndex(Array.from(QUAD_INDICES));
    // The ITEM'S OWN QUAD — four corners, in the item's own winding, exactly as
    // its albedo mesh is built. `buildQuadPositions` takes a corner LIST and
    // throws on anything else, which is what caught an earlier draft handing it
    // an AABB rect.
    geometry.setAttribute('position', new THREE.BufferAttribute(buildQuadPositions(entry.corners), 3));
    geometry.computeBoundingSphere();

    // `entry.simPingRT` always exists by the time this runs: `loadAndBake`
    // calls `buildSim` immediately before `buildMesh` (never the reverse), and
    // a zero-tube mask returns before ever reaching this function at all (see
    // `loadAndBake`'s own `tubeCount === 0` early return).
    entry.built = buildFluidSurfaceMaterials({
      THREE,
      maskTexture,
      packTexture: entry.packTexture,
      stateTexture: entry.simPingRT.texture,
      tubeCount: entry.simTubeCount,
      timeMsNode,
      ...pickParams(renderState().params ?? {}),
    });
    entry.geometry = geometry;

    entry.absorbMesh = new THREE.Mesh(geometry, entry.built.absorbMaterial);
    entry.absorbMesh.name = `FluidAbsorb_${entry.id}`;
    entry.absorbMesh.renderOrder = FLUID_RENDER_ORDER_ABSORB;
    entry.absorbMesh.frustumCulled = false;

    entry.emitMesh = new THREE.Mesh(geometry, entry.built.emitMaterial);
    entry.emitMesh.name = `FluidEmit_${entry.id}`;
    entry.emitMesh.renderOrder = FLUID_RENDER_ORDER_EMIT;
    entry.emitMesh.frustumCulled = false;

    scene.add(entry.absorbMesh);
    scene.add(entry.emitMesh);
    lastParamsKey = '';
    refreshVisibility();
  }

  /** Mesh/material teardown ONLY — deliberately NOT the sim. `buildMesh` calls
   * this on itself first (to clear a stale PREVIOUS mesh before building the
   * new one), and by the time it runs, `buildSim` has usually already built
   * the CURRENT sim moments earlier (`loadAndBake`'s own ordering) — disposing
   * the sim here too would destroy resources `buildMesh` is about to read.
   * External callers that mean "this item is really gone" want `disposeEntry`
   * below, not this. */
  function disposeMesh(entry) {
    if (entry.absorbMesh) scene.remove(entry.absorbMesh);
    if (entry.emitMesh) scene.remove(entry.emitMesh);
    entry.built?.absorbMaterial?.dispose?.();
    entry.built?.emitMaterial?.dispose?.();
    entry.geometry?.dispose?.();
    entry.absorbMesh = null;
    entry.emitMesh = null;
    entry.geometry = null;
    entry.built = null;
  }

  /** The mesh AND the sim — a rebake or a departing item invalidates both
   * together (the sim's profile/pump textures are baked from the SAME tube
   * net the mesh's pack texture is). */
  function disposeEntry(entry) {
    disposeSim(entry);
    disposeMesh(entry);
  }

  /** Only the keys the material takes, so an unknown param cannot ride in.
   * `flowSpeed` IS here (tier `structure` reads it too, for τ's own drift
   * rate — `fluid-render.js`'s own JSDoc explains why) as WELL AS being
   * read separately in `prepareSimTick` below to scale the pump's `Q` — a
   * genuinely dual-use param, not a duplicate seam. */
  function pickParams(p) {
    const out = {};
    if (Array.isArray(p.tint)) out.tint = p.tint;
    if (Number.isFinite(p.glow)) out.glow = p.glow;
    if (Number.isFinite(p.iridescence)) out.iridescence = p.iridescence;
    if (Number.isFinite(p.opacity)) out.opacity = p.opacity;
    if (Number.isFinite(p.flowSpeed)) out.flowSpeed = p.flowSpeed;
    if (Number.isFinite(p.structure)) out.structure = p.structure;
    return out;
  }

  /**
   * Per-frame. Cheap to call: the common case is one array walk and one string
   * compare.
   * @param {number} floorIndex
   */
  function sync(floorIndex) {
    syncs++;
    const state = renderState();
    enabled = state.enabled !== false;

    const items = getFluidMaskItems(floorIndex) ?? [];
    const seen = new Set();
    for (const item of items) {
      seen.add(item.id);
      let entry = entries.get(item.id);
      if (!entry) {
        entry = {
          id: item.id,
          url: null,
          corners: item.corners,
          net: null,
          pack: null,
          absorbMesh: null,
          emitMesh: null,
          loading: false,
          // THE SIM — populated by buildSim, torn down by disposeSim. Listed
          // explicitly here (rather than left to appear dynamically) so this
          // object literal stays the one place a reader sees an entry's whole
          // shape.
          simPingRT: null,
          simPongRT: null,
          simPingIsCurrent: true,
          simNeedsClear: false,
          simProfileTexture: null,
          simPumpTexture: null,
          simPersonalities: null,
          simQScales: null,
          simAdvect: null,
          simTubeCount: 0,
        };
        entries.set(item.id, entry);
      }
      if (entry.url !== item.url) {
        entry.url = item.url;
        entry.corners = item.corners;
        entry.net = null;
        entry.pack = null;
        disposeEntry(entry);
        loadAndBake(item);
      } else if (entry.emitMesh && cornersMoved(entry.corners, item.corners)) {
        // The tile was dragged, rotated or resized: move the quad rather than
        // rebaking — the mask and its tube net are unchanged, only where they sit.
        entry.corners = item.corners;
        const pos = entry.geometry.getAttribute('position');
        const buf = buildQuadPositions(item.corners);
        for (let i = 0; i < buf.length; i++) pos.array[i] = buf[i];
        pos.needsUpdate = true;
        entry.geometry.computeBoundingSphere();
      }
    }
    // An item that left this floor (or the scene) takes its mesh with it.
    for (const [id, entry] of entries) {
      if (seen.has(id)) continue;
      disposeEntry(entry);
      entries.delete(id);
    }

    const p = state.params ?? {};
    // `flowSpeed` IS in this key now (tier `structure`'s own `uFlowSpeed`
    // uniform, `fluid-render.js`) — it is ALSO read fresh every tick in
    // `prepareSimTick` below to scale the pump's `Q`, a genuinely separate
    // JS-side use of the SAME param value, not a duplicate of this write.
    const key = JSON.stringify([p.tint, p.glow, p.iridescence, p.opacity, p.flowSpeed, p.structure]);
    if (key !== lastParamsKey) {
      lastParamsKey = key;
      for (const entry of entries.values()) {
        if (!entry.built) continue;
        // ONE uniforms set, shared by construction: `buildFluidSurfaceMaterials`
        // builds both materials from the SAME uniform() nodes (mirrors water's
        // absorbMaterial/inscatterMaterial, which also share theirs) — so a
        // single write here already reaches both the absorb and emit passes.
        // There is no second loop to keep in sync and nothing that can drift.
        const u = entry.built.uniforms;
        if (Array.isArray(p.tint)) u.uTint.value.set(p.tint[0], p.tint[1], p.tint[2]);
        if (Number.isFinite(p.glow)) u.uGlow.value = p.glow;
        if (Number.isFinite(p.iridescence)) u.uIridescence.value = p.iridescence;
        if (Number.isFinite(p.opacity)) u.uOpacity.value = p.opacity;
        if (Number.isFinite(p.flowSpeed)) u.uFlowSpeed.value = p.flowSpeed;
        if (Number.isFinite(p.structure)) u.uStructure.value = p.structure;
      }
    }
    refreshVisibility();
  }

  /**
   * ALL the JS-side sim work for one tick, for EVERY masked item at once —
   * write each entry's pump texture, decide what "current" means after this
   * tick, re-point every re-pointable node. Returns a small job list for
   * `vt-pan-viewer.js`'s own `tickFluidSim` to actually RENDER (this file may
   * not call `.setRenderTarget()` itself — see this module's own header).
   *
   * Skipped entirely while disabled: a hidden mesh has nothing to show for a
   * tick's cost either way (mirrors `tickWindSim`'s own thaw/freeze early-out).
   *
   * @param {number} nowMs - THE SHARED sim clock, never a private one.
   * @param {number} dtSec
   * @returns {{clears: Array<*>, advects: Array<{quad: *, destRT: *}>}}
   */
  function prepareSimTick(nowMs, dtSec) {
    const clears = [];
    const advects = [];
    if (!enabled) return { clears, advects };

    const flowSpeedRaw = Number(renderState().params?.flowSpeed);
    const flowSpeed = Number.isFinite(flowSpeedRaw) ? Math.max(0, flowSpeedRaw) : 1;

    for (const entry of entries.values()) {
      if (!entry.simAdvect || !entry.net || entry.net.tubeCount === 0) continue;

      // The pump buffer is rewritten in place every tick — the SAME Float32Array
      // the texture was built from, never a fresh allocation
      // (`writeFluidTubeConstantsBuffer`'s own doc: "written in place so a
      // caller can reuse the same typed array... without a fresh allocation").
      // `simQScales` is the per-tube, bake-time fix for "this tube's own
      // geometry is nothing like the fixture Q was tuned against"
      // (`computeFluidLengthQScale`'s own header) — `flowSpeed` below is a
      // SEPARATE, live, uniform-across-tubes multiplier on top of it.
      writeFluidTubeConstantsBuffer(
        entry.simPumpTexture.image.data,
        nowMs,
        entry.net.tubes,
        entry.simPersonalities,
        entry.simQScales
      );
      if (flowSpeed !== 1) {
        // Scaling Q by the SAME factor `dtSec` would achieve is the smallest
        // possible hook for a live "flow speed" control: `v = Q/A`, so
        // multiplying Q here scales every tube's advection velocity uniformly
        // without touching `fluid-pump.js`'s own already-tested arithmetic.
        const data = entry.simPumpTexture.image.data;
        for (let row = 0; row < entry.net.tubes.length; row++) data[row * 4] *= flowSpeed;
      }
      entry.simPumpTexture.needsUpdate = true;

      if (entry.simNeedsClear) {
        // Skip advection entirely THIS tick — both RTs are about to be zeroed,
        // so there is nothing valid to backtrace INTO yet. The mesh reads a
        // clean, empty tube for one tick (imperceptible) rather than risk any
        // same-pass ordering assumption between "clear" and "render into".
        clears.push(entry.simPingRT, entry.simPongRT);
        entry.simNeedsClear = false;
      } else {
        const currentRT = entry.simPingIsCurrent ? entry.simPingRT : entry.simPongRT;
        const otherRT = entry.simPingIsCurrent ? entry.simPongRT : entry.simPingRT;
        entry.simAdvect.uDtSec.value = dtSec;
        for (const n of entry.simAdvect.prevTexNodes) n.value = currentRT.texture;
        advects.push({ quad: entry.simAdvect.quad, destRT: otherRT });
        entry.simPingIsCurrent = otherRT === entry.simPingRT;
      }

      // Re-point the RENDER material's own reads to whichever RT will hold
      // the CURRENT state once the caller actually performs the render(s)
      // above — mirrors `fluid-sim.js`'s own `prevTexNodes` re-pointing
      // exactly, and covers BOTH samples (`fill` and the meniscus's
      // `fillAhead`), never just the first (see `fluid-render.js`'s own
      // `stateTexNodes` doc for why a single node here would be a live bug).
      if (entry.built?.stateTexNodes) {
        const nextCurrentRT = entry.simPingIsCurrent ? entry.simPingRT : entry.simPongRT;
        for (const n of entry.built.stateTexNodes) n.value = nextCurrentRT.texture;
      }
    }
    return { clears, advects };
  }

  /**
   * The report. Written to answer "why do I see nothing" WITHOUT another round
   * trip — every link in the chain reports its own state, so the first null
   * names itself (`keyhole-debug-panel`: tell the author which report to click).
   */
  function getStatus() {
    return {
      enabled,
      syncs,
      bakes,
      // Zero masked items with tubes painted on the map means the LOOKUP is
      // wrong, not the shader. That distinction cost two rounds.
      maskedItemCount: entries.size,
      items: [...entries.values()].map((e) => ({
        id: e.id,
        url: e.url,
        loading: e.loading,
        // Both meshes are built/removed together (see buildMesh/disposeMesh),
        // so checking one stands for both.
        meshInScene: !!e.absorbMesh && !!e.emitMesh,
        visible: !!e.emitMesh && e.emitMesh.visible,
        tubeCount: e.net ? e.net.tubeCount : 0,
        maxTubeWidthTexels: e.pack ? Number(e.pack.maxTubeWidthTexels.toFixed(2)) : 0,
        packSize: e.pack ? `${e.pack.width}x${e.pack.height}` : null,
        // THE SIM's own link in the chain — named separately from `meshInScene`
        // on purpose: a mesh can be in-scene and visible while its sim failed
        // to build (a zero-tube mask, or an allocator throw), which would
        // otherwise read as "working" right up until someone asks why the
        // goo never moves.
        simBuilt: !!e.simAdvect,
        simPingIsCurrent: e.simPingIsCurrent,
        simAwaitingFirstClear: !!e.simNeedsClear,
        warnings: e.net ? e.net.warnings : [],
        tubes: e.net
          ? e.net.tubes.map((t) => ({
              id: t.id,
              lengthPx: Math.round(t.lengthPx),
              orientedBy: t.orientedBy,
              hintCorrelation: Number(t.hintCorrelation.toFixed(3)),
              maxRadiusPx: Math.round(t.maxRadiusPx),
            }))
          : [],
      })),
      failedUrls: [...failedUrls],
    };
  }

  function dispose() {
    for (const entry of entries.values()) disposeEntry(entry);
    entries.clear();
  }

  return { sync, prepareSimTick, getStatus, dispose };
}

/** Have any of the four corners actually moved? */
function cornersMoved(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return true;
  }
  return false;
}

/**
 * Box-downsample the mask's R bytes to at most `FLUID_PACK_MAX_DIM` on the long
 * side, wrapped as the `{spec, data}` grid `extractTubeNet` takes.
 *
 * ⚠️ **MAX, not mean.** A mean would let a thin tube fade below the presence
 * threshold as it is downsampled and vanish entirely; taking the max of the
 * source texels keeps a one-pixel-wide painted tube present at every scale,
 * which is the whole point of running the extractor on the file rather than on
 * the derivation grid.
 *
 * ⚠️ **Row 0 is the image's TOP** (`flipY: false`, the world-quad convention
 * every item in this renderer uses), so the grid's rows run the same way as the
 * texture's and the pack lines up with the mask texel for texel. Getting this
 * wrong flips the tubes — `feedback_y_flip_recurring_risk`, this repo's named
 * recurring bug class, which is why the mapping is stated rather than assumed.
 *
 * `worldW`/`worldH` are the ITEM's extent, so every derived length is in world
 * px rather than texels — otherwise flow speed would depend on mask resolution.
 */
export function downsample(src, srcW, srcH, scale, worldW, worldH) {
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
    spec: { x: 0, y: 0, width: worldW, height: worldH, w, h, texelW: worldW / w, texelH: worldH / h },
    data,
  };
}
