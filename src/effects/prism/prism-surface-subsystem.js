/**
 * PRISM'S SURFACE — one mesh PER MASKED TILE (mythica-machina-press#137).
 *
 * ============================================================================
 * WHY THIS MIRRORS `specular-tile-surface-subsystem.js`, NOT
 * `water-refraction-subsystem.js`
 * ============================================================================
 * Prism v1 is a TILE population (`prism-seams.js`'s own header): any number
 * of masked tiles simultaneously visible, each its own shape, each its own
 * mesh — the identical cardinality `specular-tile-surface-subsystem.js`/
 * `fluid-surface-subsystem.js` already solved. This subsystem follows their
 * shape: an `entries` Map keyed by item id, one `THREE.Mesh` per entry, added
 * to a single shared `scene`, reconciled once per `sync()` call (seen-vs-
 * stale-prune).
 *
 * The one genuine difference: every OTHER tile-mounted effect in this
 * codebase loads its OWN per-item texture and stops there. Prism's tier-3
 * dispersion also needs a SHARED "what's behind the glass" texture — one
 * scene capture (`prism-refraction-subsystem.js`), covering every active
 * tile's own union rect, sampled by EVERY entry's own material. That texture
 * (plus the world rect its UV space maps across, `capturedRect`) is handed
 * to `sync()` each frame and re-pointed onto every live entry's own
 * `behindTexNodes` — the identical "re-point every one together" contract
 * `water-render.js#capturedTexNodes` already documents, just fanned out
 * across N per-tile materials instead of one shared one.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY NOT HERE
 * ============================================================================
 * No per-item islands (V2/Specular's own facet-parallax-by-connected-region
 * bake) — Prism's OWN facets are already procedural and need no baked pack.
 * No tile-motion wiring (`buildTileMotionPositionNode`/`buildTileMotionMaskUvNode`,
 * `specular-tile-surface-subsystem.js`'s own header) — a real, mechanical,
 * later addition (a spinning gem tracking its own tile motion), not attempted
 * in this pass. No `buf:scene.illum` read — Prism's own light response is the
 * facet/glint model in `prism-render.js`, not a lamp-direction read.
 *
 * @module effects/prism/prism-surface-subsystem
 */

import { createLogger } from '../../core/log.js';
import { buildPrismSurfaceMaterial } from './prism-render.js';
import { PRISM_DEFAULT_TIER } from './prism-motion.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';

const log = createLogger('PrismSurface');

/** Have any of the four corners actually moved? Byte-for-byte
 * `specular-tile-surface-subsystem.js#cornersMoved`'s own helper. */
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
 * @param {*} [args.depthTexture] - `buf:scene.depth`.
 * @param {*} [args.uViewRect] - the SHARED view-rect uniform node (`envLight
 *   .uViewRect`) — see `buildPrismSurfaceMaterial`'s own doc for why this is
 *   a node, never a plain rect.
 * @param {(itemId: string) => number} [args.resolveExpectedDepth] - this
 *   TILE's own depth-authority rank, mirroring `specular-tile-surface-
 *   subsystem.js`'s identical per-item composition.
 * @param {() => object} [args.getPrismRenderState] - `{enabled, params,
 *   perfTier}` — the same effect-wide cascade readout every other registered
 *   effect exposes (`boot.js#getPrismRenderState`).
 * @param {*} [args.profiler]
 * @returns {{scene: *, sync: (items: Array<object>, capture: {behindTexture: *, capturedRect: object, capturedTexSize: object}) => void,
 *   hasContent: () => boolean, isLoadingMask: () => boolean, getStatus: () => object, dispose: () => void}}
 */
export function createPrismSurfaceSubsystem({
  THREE,
  loadMaskImage,
  depthTexture = null,
  uViewRect = null,
  resolveExpectedDepth,
  getPrismRenderState,
  profiler = null,
}) {
  resolveExpectedDepth ??= () => 0;
  getPrismRenderState ??= () => ({ enabled: false, params: null });

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
    return Number.isFinite(t) ? t : PRISM_DEFAULT_TIER;
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

  /** Builds (or rebuilds) ONE entry's material for a given tier/facetAnimate
   * — mirrors `specular-tile-surface-subsystem.js#buildSurfaceForEntry`. */
  function buildSurfaceForEntry(entry, tier, facetAnimate) {
    return buildPrismSurfaceMaterial({
      THREE,
      maskTexture: entry.maskTexture,
      behindTexture: entry.behindTexture,
      depthTexture,
      uViewRect,
      capturedRect: entry.capturedRect,
      capturedTexSize: entry.capturedTexSize,
      expectedDepth: resolveExpectedDepth(entry.id),
      facetAnimate,
      tier,
    });
  }

  /** Load one item's mask and build its mesh. */
  async function loadAndBuild(item, tier, facetAnimate, capture) {
    const entry = entries.get(item.id);
    if (!entry || entry.loading) return;
    entry.loading = true;
    try {
      const loaded = await loadMaskImage({ url: item.url, channels: 'rgb' });
      if (!loaded) {
        if (!failedUrls.has(item.url)) {
          failedUrls.add(item.url);
          log.error(`prism mask failed to load for tile ${item.id}: ${item.url}`);
        }
        return;
      }
      if (entries.get(item.id) !== entry || entry.url !== item.url) return;

      entry.maskTexture?.dispose?.();
      entry.maskTexture = loaded.texture;
      entry.behindTexture = capture.behindTexture;
      entry.capturedRect = capture.capturedRect;
      entry.capturedTexSize = capture.capturedTexSize;
      entry.builtForTier = tier;
      entry.builtForFacetAnimate = facetAnimate;
      disposeMesh(entry);
      entry.built = buildSurfaceForEntry(entry, tier, facetAnimate);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
      geometry.setIndex(Array.from(QUAD_INDICES));
      geometry.setAttribute('position', new THREE.BufferAttribute(buildQuadPositions(entry.corners), 3));
      geometry.computeBoundingSphere();
      entry.geometry = geometry;

      entry.mesh = new THREE.Mesh(geometry, entry.built.material);
      entry.mesh.name = `PrismTile_${entry.id}`;
      entry.mesh.frustumCulled = false;
      entry.mesh.visible = false;
      scene.add(entry.mesh);

      entry.loadedUrl = item.url;
      log.info(`prism mask attached to tile ${item.id}: ${item.url}`);
    } finally {
      entry.loading = false;
      refreshVisibility();
    }
  }

  /** Rebuild ONLY the material for a tier/facetAnimate change — mirrors
   * `specular-tile-surface-subsystem.js#rebuildEntryMaterials`: a tier (or
   * `facetAnimate`) is a JS-time branch INSIDE the builder (Law 4), so a
   * change compiles a genuinely different graph and needs a genuinely new
   * material, never a live uniform toggle on the existing one. */
  function rebuildEntryMaterials(entry, tier, facetAnimate) {
    const prev = entry.built;
    entry.built = buildSurfaceForEntry(entry, tier, facetAnimate);
    if (entry.mesh) entry.mesh.material = entry.built.material;
    prev?.material?.dispose?.();
    entry.builtForTier = tier;
    entry.builtForFacetAnimate = facetAnimate;
  }

  /**
   * @param {Array<{id:string, url:string, corners:Array<{x:number,y:number}>, renderOrder:number|null}>} items -
   *   `prism-seams.js#getPrismMaskItems`'s own return shape for the CURRENT
   *   floor — the caller's own responsibility to have already early-returned
   *   before calling this at all when `items.length === 0` (Effects.md Law 4
   *   — see `vt-pan-viewer.js#runSurfacePrismPass`'s own gate).
   * @param {{behindTexture: *, capturedRect: object, capturedTexSize: object}} capture -
   *   `prism-refraction-subsystem.js`'s own current output — a REAL texture
   *   and a real (if possibly stale-by-one-frame, see that module's header)
   *   rect, never null: the caller ticks the capture BEFORE calling this.
   */
  // mythica-machina-press#137 — self-bracketed the same way `specular-tile-
  // surface-subsystem.js#sync` is: the real per-tile-item cost (mesh/material
  // reconciliation, the shared-capture re-point, the per-frame param push)
  // lives here, not at the call site, so the zone has to be entered here too.
  function sync(items, capture) {
    profiler?.beginById('surface.prismSync');
    try {
      syncUnguarded(items, capture);
    } finally {
      profiler?.endById('surface.prismSync');
    }
  }

  function syncUnguarded(items, capture) {
    syncs++;
    const state = getPrismRenderState();
    enabled = state.enabled === true;
    const resolvedTier = resolveTier(state);
    const p = state.params ?? {};
    const facetAnimate = p.facetAnimate !== false;

    const seen = new Set();
    if (enabled) {
      for (const item of items ?? []) {
        seen.add(item.id);
        let entry = entries.get(item.id);
        if (!entry) {
          entry = {
            id: item.id,
            // `null`, NOT `item.url` — the very next branch is `entry.url !==
            // item.url`, and this sentinel is what makes it fire for a
            // brand-new entry (mirrors `specular-tile-surface-subsystem.js`'s
            // own identical comment).
            url: null,
            corners: item.corners,
            renderOrder: item.renderOrder,
            loading: false,
            loadedUrl: null,
            maskTexture: null,
            behindTexture: null,
            capturedRect: null,
            capturedTexSize: null,
            builtForTier: null,
            builtForFacetAnimate: null,
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
          loadAndBuild(item, resolvedTier, facetAnimate, capture);
        } else if (entry.mesh && cornersMoved(entry.corners, item.corners)) {
          entry.corners = item.corners;
          const pos = entry.geometry.getAttribute('position');
          const buf = buildQuadPositions(item.corners);
          for (let i = 0; i < buf.length; i++) pos.array[i] = buf[i];
          pos.needsUpdate = true;
          entry.geometry.computeBoundingSphere();
        }

        if (typeof item.renderOrder === 'number') entry.renderOrder = item.renderOrder;

        if (entry.built && (entry.builtForTier !== resolvedTier || entry.builtForFacetAnimate !== facetAnimate)) {
          rebuildEntryMaterials(entry, resolvedTier, facetAnimate);
        }

        if (!entry.built) continue;
        const b = entry.built;

        // ── THE SHARED CAPTURE — re-pointed onto EVERY live entry, every
        // sync, the identical "re-point every one together" contract
        // `water-render.js#capturedTexNodes` documents for its own single
        // material, fanned out across N here. ─────────────────────────────
        if (capture.behindTexture && b.behindTexNodes.length > 0) {
          for (const node of b.behindTexNodes) node.value = capture.behindTexture;
        }
        if (capture.capturedRect) {
          const r = capture.capturedRect;
          b.uniforms.uCapturedRect.value.set(r.minX, r.minY, r.maxX, r.maxY);
        }
        if (capture.capturedTexSize) {
          b.uniforms.uCapturedTexelUv.value.set(
            1 / Math.max(1, capture.capturedTexSize.width),
            1 / Math.max(1, capture.capturedTexSize.height)
          );
        }

        // ── THE EXPECTED DEPTH — re-resolved every sync (a tile's own rank
        // can change as other items are added/removed/reordered). ─────────
        b.uniforms.uExpectedDepth.value = resolveExpectedDepth(entry.id);

        // ── THE LOOK PARAMS — one shared cascade readout, pushed onto
        // every live entry, mirrors `specular-tile-surface-subsystem.js`'s
        // own identical "look params, effect-wide" block. ──────────────────
        if (Number.isFinite(p.maskThreshold)) b.uniforms.uMaskThreshold.value = p.maskThreshold;
        if (Number.isFinite(p.opacity)) b.uniforms.uOpacity.value = p.opacity;
        if (Number.isFinite(p.brightness)) b.uniforms.uBrightness.value = p.brightness;
        if (Number.isFinite(p.maskTintStrength)) b.uniforms.uMaskTintStrength.value = p.maskTintStrength;
        if (Number.isFinite(p.facetScale)) b.uniforms.uFacetScale.value = p.facetScale;
        if (Number.isFinite(p.facetSpeed)) b.uniforms.uFacetSpeed.value = p.facetSpeed;
        if (Number.isFinite(p.facetSoftness)) b.uniforms.uFacetSoftness.value = p.facetSoftness;
        if (Number.isFinite(p.parallaxStrength)) b.uniforms.uParallaxStrength.value = p.parallaxStrength;
        if (Number.isFinite(p.glintStrength)) b.uniforms.uGlintStrength.value = p.glintStrength;
        if (Number.isFinite(p.glintThreshold)) b.uniforms.uGlintThreshold.value = p.glintThreshold;
        if (Number.isFinite(p.intensity)) b.uniforms.uIntensity.value = p.intensity;
        if (Number.isFinite(p.spread)) b.uniforms.uSpread.value = p.spread;
      }
    }

    for (const [id, entry] of entries) {
      if (seen.has(id)) continue;
      disposeEntry(entry);
      entries.delete(id);
    }
    refreshVisibility();
  }

  /** Pushed once per frame from the SAME clock/camera-offset every other
   * effect in this renderer shares — see `runSurfacePrismPass`'s own call
   * site. Cheap enough (N uniform writes, no branch) to run unconditionally
   * whenever `sync()` above already found at least one live entry. */
  function pushTimeAndParallax(timeSec, cameraOffsetPx) {
    for (const entry of entries.values()) {
      if (!entry.built) continue;
      entry.built.uniforms.uTimeSec.value = timeSec;
      entry.built.uniforms.uCameraOffsetPx.value.set(cameraOffsetPx?.x ?? 0, cameraOffsetPx?.y ?? 0);
    }
  }

  return {
    scene,
    sync,
    pushTimeAndParallax,
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
