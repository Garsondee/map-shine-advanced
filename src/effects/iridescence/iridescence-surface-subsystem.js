/**
 * IRIDESCENCE'S SURFACE — one mesh PER MASKED TILE (mythica-machina-press#136).
 *
 * ============================================================================
 * WHY THIS MIRRORS `prism-surface-subsystem.js`, MINUS THE SHARED CAPTURE
 * ============================================================================
 * Iridescence v1 is a TILE population (`iridescence-seams.js`'s own header):
 * any number of masked tiles simultaneously visible, each its own shape, each
 * its own mesh — the identical cardinality `prism-surface-subsystem.js`/
 * `specular-tile-surface-subsystem.js` already solved. This subsystem follows
 * their shape: an `entries` Map keyed by item id, one `THREE.Mesh` per entry,
 * added to a single shared `scene`, reconciled once per `sync()` call
 * (seen-vs-stale-prune).
 *
 * UNLIKE Prism, Iridescence needs no shared "what's behind the glass" scene
 * capture: its own dependent read is `buf:scene.illum`, a plain, already-
 * finished target by the time the `surface` stage runs (`light.accumulate`
 * runs earlier in the same frame) — see `iridescence-render.js`'s own header
 * for the full account. So `sync()` here takes no `capture` argument at all;
 * `illumTexture`/`depthTexture` are constructor-time, shared, and never
 * re-pointed per sync (they do not change identity frame to frame the way a
 * fresh capture texture does).
 *
 * A material rebuild is needed on a TIER change (Law 4 — a genuinely
 * different graph) exactly like Prism's own `rebuildEntryMaterials`, but
 * ALSO on a `noiseType` change: `iridescence-render.js`'s own header explains
 * why the two noise flavours are a JS-time branch, not a live uniform, so
 * flipping the author's "Liquid"/"Glitter" toggle is a rebuild, not a
 * re-point, the identical shape a tier change already is.
 *
 * @module effects/iridescence/iridescence-surface-subsystem
 */

import { createLogger } from '../../core/log.js';
import { buildIridescenceSurfaceMaterial } from './iridescence-render.js';
import { IRIDESCENCE_DEFAULT_TIER, mapNoiseScale } from './iridescence-motion.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';

const log = createLogger('IridescenceSurface');

/** Have any of the four corners actually moved? Byte-for-byte
 * `prism-surface-subsystem.js#cornersMoved`'s own helper. */
function cornersMoved(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return true;
  }
  return false;
}

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported.
 * @param {(opts: object) => Promise<object|null>} args.loadMaskImage
 * @param {*} [args.illumTexture] - `buf:scene.illum`, shared/constant for the
 *   lifetime of this subsystem (unlike Prism's per-frame capture, this
 *   texture's own IDENTITY never changes — only its contents do, which a
 *   `texture()` node already tracks with no re-point needed).
 * @param {*} [args.depthTexture] - `buf:scene.depth`.
 * @param {*} [args.uViewRect] - the SHARED view-rect uniform node (`envLight
 *   .uViewRect`) — see `buildIridescenceSurfaceMaterial`'s own doc.
 * @param {(itemId: string) => number} [args.resolveExpectedDepth] - this
 *   TILE's own depth-authority rank, mirroring `createPrismSurfaceSubsystem`'s
 *   identical per-item composition.
 * @param {() => object} [args.getIridescenceRenderState] - `{enabled, params,
 *   perfTier}` — the same effect-wide cascade readout every other registered
 *   effect exposes (`boot.js#getIridescenceRenderState`).
 * @param {*} [args.profiler]
 * @returns {{scene: *, sync: (items: Array<object>) => void, pushTime: (timeSec:number) => void,
 *   hasContent: () => boolean, isLoadingMask: () => boolean, getStatus: () => object, dispose: () => void}}
 */
export function createIridescenceSurfaceSubsystem({
  THREE,
  loadMaskImage,
  illumTexture = null,
  depthTexture = null,
  uViewRect = null,
  resolveExpectedDepth,
  getIridescenceRenderState,
  profiler = null,
}) {
  resolveExpectedDepth ??= () => 0;
  getIridescenceRenderState ??= () => ({ enabled: false, params: null });

  const scene = new THREE.Scene();
  const failedUrls = new Set();
  /** One entry per masked TILE, keyed by item id. */
  const entries = new Map();
  let syncs = 0;
  let enabled = false;

  function refreshVisibility() {
    for (const e of entries.values()) {
      if (e.mesh) e.mesh.visible = enabled && !!e.loadedUrl;
    }
  }

  function resolveTier(state) {
    const t = state.perfTier;
    return Number.isFinite(t) ? t : IRIDESCENCE_DEFAULT_TIER;
  }

  /** `IRIDESCENCE_PARAMS.noiseType` is an `enum` ('liquid'/'glitter', schema
   * convention — a string, not V2's own raw 0/1) — mapped here to the JS-time
   * 0/1 `buildIridescenceSurfaceMaterial#noiseType` argument actually wants. */
  function resolveNoiseType(p) {
    return p.noiseType === 'glitter' ? 1 : 0;
  }

  function disposeMesh(entry) {
    if (entry.mesh) scene.remove(entry.mesh);
    entry.built?.material?.dispose?.();
    entry.geometry?.dispose?.();
    entry.mesh = null;
    entry.geometry = null;
    entry.built = null;
  }

  function disposeEntry(entry) {
    disposeMesh(entry);
    entry.maskTexture?.dispose?.();
    entry.maskTexture = null;
  }

  /** Builds (or rebuilds) ONE entry's material for a given tier/noiseType —
   * mirrors `prism-surface-subsystem.js#buildSurfaceForEntry`. */
  function buildSurfaceForEntry(entry, tier, noiseType) {
    return buildIridescenceSurfaceMaterial({
      THREE,
      maskTexture: entry.maskTexture,
      illumTexture,
      depthTexture,
      uViewRect,
      expectedDepth: resolveExpectedDepth(entry.id),
      noiseType,
      tier,
    });
  }

  /** Load one item's mask and build its mesh. */
  async function loadAndBuild(item, tier, noiseType) {
    const entry = entries.get(item.id);
    if (!entry || entry.loading) return;
    entry.loading = true;
    try {
      const loaded = await loadMaskImage({ url: item.url, channels: 'rgb' });
      if (!loaded) {
        if (!failedUrls.has(item.url)) {
          failedUrls.add(item.url);
          log.error(`iridescence mask failed to load for tile ${item.id}: ${item.url}`);
        }
        return;
      }
      if (entries.get(item.id) !== entry || entry.url !== item.url) return;

      entry.maskTexture?.dispose?.();
      entry.maskTexture = loaded.texture;
      entry.builtForTier = tier;
      entry.builtForNoiseType = noiseType;
      disposeMesh(entry);
      entry.built = buildSurfaceForEntry(entry, tier, noiseType);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
      geometry.setIndex(Array.from(QUAD_INDICES));
      geometry.setAttribute('position', new THREE.BufferAttribute(buildQuadPositions(entry.corners), 3));
      geometry.computeBoundingSphere();
      entry.geometry = geometry;

      entry.mesh = new THREE.Mesh(geometry, entry.built.material);
      entry.mesh.name = `IridescenceTile_${entry.id}`;
      entry.mesh.frustumCulled = false;
      entry.mesh.visible = false;
      scene.add(entry.mesh);

      entry.loadedUrl = item.url;
      log.info(`iridescence mask attached to tile ${item.id}: ${item.url}`);
    } finally {
      entry.loading = false;
      refreshVisibility();
    }
  }

  /** Rebuild ONLY the material for a tier/noiseType change — mirrors
   * `prism-surface-subsystem.js#rebuildEntryMaterials`: a tier or noiseType is
   * a JS-time branch INSIDE the builder (Law 4), so a change compiles a
   * genuinely different graph and needs a genuinely new material, never a
   * live uniform toggle on the existing one. */
  function rebuildEntryMaterials(entry, tier, noiseType) {
    const prev = entry.built;
    entry.built = buildSurfaceForEntry(entry, tier, noiseType);
    if (entry.mesh) entry.mesh.material = entry.built.material;
    prev?.material?.dispose?.();
    entry.builtForTier = tier;
    entry.builtForNoiseType = noiseType;
  }

  /**
   * @param {Array<{id:string, url:string, corners:Array<{x:number,y:number}>, renderOrder:number|null}>} items -
   *   `iridescence-seams.js#getIridescenceMaskItems`'s own return shape for
   *   the CURRENT floor — the caller's own responsibility to have already
   *   early-returned before calling this at all when `items.length === 0`
   *   (Effects.md Law 4 — see `runSurfaceIridescencePass`'s own gate).
   */
  // mythica-machina-press#136 — self-bracketed the same way `prism-surface-
  // subsystem.js#sync` is: the real per-tile-item cost (mesh/material
  // reconciliation, the per-frame param push) lives here, not at the call
  // site, so the zone has to be entered here too.
  function sync(items) {
    profiler?.beginById('surface.iridescenceSync');
    try {
      syncUnguarded(items);
    } finally {
      profiler?.endById('surface.iridescenceSync');
    }
  }

  function syncUnguarded(items) {
    syncs++;
    const state = getIridescenceRenderState();
    enabled = state.enabled === true;
    const resolvedTier = resolveTier(state);
    const p = state.params ?? {};
    const noiseType = resolveNoiseType(p);

    const seen = new Set();
    if (enabled) {
      for (const item of items ?? []) {
        seen.add(item.id);
        let entry = entries.get(item.id);
        if (!entry) {
          entry = {
            id: item.id,
            // `null`, NOT `item.url` — mirrors `prism-surface-subsystem.js`'s
            // own identical sentinel comment.
            url: null,
            corners: item.corners,
            renderOrder: item.renderOrder,
            loading: false,
            loadedUrl: null,
            maskTexture: null,
            builtForTier: null,
            builtForNoiseType: null,
            geometry: null,
            mesh: null,
            built: null,
          };
          entries.set(item.id, entry);
        }

        if (entry.url !== item.url) {
          entry.url = item.url;
          entry.corners = item.corners;
          entry.loadedUrl = null;
          disposeEntry(entry);
          loadAndBuild(item, resolvedTier, noiseType);
        } else if (entry.mesh && cornersMoved(entry.corners, item.corners)) {
          entry.corners = item.corners;
          const pos = entry.geometry.getAttribute('position');
          const buf = buildQuadPositions(item.corners);
          for (let i = 0; i < buf.length; i++) pos.array[i] = buf[i];
          pos.needsUpdate = true;
          entry.geometry.computeBoundingSphere();
        }

        if (typeof item.renderOrder === 'number') entry.renderOrder = item.renderOrder;

        if (entry.built && (entry.builtForTier !== resolvedTier || entry.builtForNoiseType !== noiseType)) {
          rebuildEntryMaterials(entry, resolvedTier, noiseType);
        }

        if (!entry.built) continue;
        const b = entry.built;

        // ── THE EXPECTED DEPTH — re-resolved every sync (a tile's own rank
        // can change as other items are added/removed/reordered). ─────────
        b.uniforms.uExpectedDepth.value = resolveExpectedDepth(entry.id);

        // ── THE LOOK PARAMS — one shared cascade readout, pushed onto
        // every live entry, mirrors `prism-surface-subsystem.js`'s own
        // identical "look params, effect-wide" block. ──────────────────────
        if (Number.isFinite(p.maskThreshold)) b.uniforms.uMaskThreshold.value = p.maskThreshold;
        b.uniforms.uInvertMask.value = p.invertMask ? 1 : 0;
        if (Number.isFinite(p.alpha)) b.uniforms.uAlpha.value = p.alpha;
        if (Number.isFinite(p.intensity)) b.uniforms.uIntensity.value = p.intensity;
        if (Number.isFinite(p.distortionStrength)) b.uniforms.uDistortionStrength.value = p.distortionStrength;
        if (Number.isFinite(p.noiseScale)) {
          // The 0..1 UI value is mapped to the flavour's own actual
          // frequency HERE, at the push site — `iridescence-motion.js
          // #mapNoiseScale`'s own doc — never baked into the schema default,
          // so a live slider drag re-maps every frame against the CURRENT
          // noiseType.
          b.uniforms.uNoiseScale.value = mapNoiseScale(p.noiseScale, noiseType);
        }
        if (Number.isFinite(p.flowSpeed)) b.uniforms.uFlowSpeed.value = p.flowSpeed;
        if (Number.isFinite(p.phaseMult)) b.uniforms.uPhaseMult.value = p.phaseMult;
        if (Number.isFinite(p.colorCycleSpeed)) b.uniforms.uColorCycleSpeed.value = p.colorCycleSpeed;
        if (Number.isFinite(p.angleDeg)) b.uniforms.uAngle.value = p.angleDeg;
        if (Number.isFinite(p.parallaxStrength)) b.uniforms.uParallaxStrength.value = p.parallaxStrength;
        if (Number.isFinite(p.ignoreDarkness)) b.uniforms.uIgnoreDarkness.value = p.ignoreDarkness;
      }
    }

    for (const [id, entry] of entries) {
      if (seen.has(id)) continue;
      disposeEntry(entry);
      entries.delete(id);
    }
    refreshVisibility();
  }

  /** Pushed once per frame from the SAME clock/camera-centre every other
   * effect in this renderer shares — see `runSurfaceIridescencePass`'s own
   * call site. Cheap enough (N uniform writes, no branch) to run
   * unconditionally whenever `sync()` above already found at least one live
   * entry. `cameraCenter` is the camera's OWN absolute world-space centre,
   * NOT a delta — see `iridescence-motion.js#computePhase`'s own doc for why. */
  function pushTimeAndCamera(timeSec, cameraCenter) {
    for (const entry of entries.values()) {
      if (!entry.built) continue;
      entry.built.uniforms.uTimeSec.value = timeSec;
      entry.built.uniforms.uCameraOffset.value.set(cameraCenter?.x ?? 0, cameraCenter?.y ?? 0);
    }
  }

  return {
    scene,
    sync,
    pushTimeAndCamera,
    hasContent: () => {
      for (const e of entries.values()) if (e.mesh?.visible) return true;
      return false;
    },
    isLoadingMask: () => {
      for (const e of entries.values()) if (e.loading) return true;
      return false;
    },
    getStatus() {
      return {
        enabled,
        syncs,
        maskedTileCount: entries.size,
        items: [...entries.values()].map((e) => ({
          id: e.id,
          url: e.loadedUrl,
          loading: e.loading,
          meshInScene: !!e.mesh,
          visible: !!e.mesh && e.mesh.visible,
          perfTier: e.builtForTier,
        })),
        failedUrls: [...failedUrls],
      };
    },
    dispose() {
      for (const entry of entries.values()) disposeEntry(entry);
      entries.clear();
      profiler = null;
    },
  };
}
