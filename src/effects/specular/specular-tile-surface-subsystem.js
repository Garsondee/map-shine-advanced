/**
 * SHINE'S PER-TILE SURFACE — one mesh PER MASKED TILE, ADDED beside
 * `specular-surface-subsystem.js`'s existing floor-level population, never
 * instead of it (mythica-machina-press#538/#539).
 *
 * ============================================================================
 * WHY A SEPARATE SUBSYSTEM, NOT A CHANGE TO THE FLOOR ONE
 * ============================================================================
 * `specular-surface-subsystem.js` is a SINGLE SHARED instance for the whole
 * scene — one mesh, cropped to the mask file's own painted AABB in WORLD
 * space, reloaded whenever the viewed floor changes (its own header: "ONE
 * MESH, NOT TWO"). That cardinality is right for "the floor's own metal" —
 * there is exactly one viewed floor at a time — and wrong for tiles, which
 * are a genuinely per-item population: a scene can have any number of
 * masked tiles simultaneously visible, each its own shape, each potentially
 * under its own live tile-motion. See `window-tile-surface-subsystem.js`'s
 * own header for the identical reasoning (Window's floor population is
 * ALSO the wrong shape for a tile, for a slightly different reason — one
 * subsystem per floor rather than one shared — but the conclusion is the
 * same either way: tiles need their own per-item population).
 *
 * This subsystem follows `fluid-surface-subsystem.js`'s own shape instead:
 * ONE mesh PER MASKED ITEM, and that mesh IS the item's own quad — corners
 * from `getSpecularMaskItems`, sampled at plain `uv()` (no crop, for the
 * same reason `window-tile-surface-subsystem.js` has none: the mask file
 * IS the tile's own extent, nothing to crop away).
 *
 * `buildSpecularSurfaceMaterial` (`specular-render.js`) is REUSED unchanged
 * — same shimmer layers, same per-island parallax, same sun-bias grain, same
 * incident-light response — so a tile-attached shine looks and behaves like
 * the shipped effect. Only the GEOMETRY and the two new optional parameters
 * (`positionNode`/`maskUvNode`) differ from the floor path. That includes
 * the ISLAND PACK: each entry bakes its OWN, from its OWN mask's bytes,
 * exactly the same bake `bakeIslandPack` runs for the floor's mesh — a
 * tile-attached shine gets real per-object parallax variety too, not the
 * global placeholder.
 *
 * ============================================================================
 * TILE-MOTION (mythica-machina-press#539)
 * ============================================================================
 * See `window-tile-surface-subsystem.js`'s own header — identical mechanism,
 * identical reasoning: `getItemTileMotion(item)` resolves the tile's own
 * live uniform bag, both `positionNode` and the mask's own UV node are wired
 * unconditionally whenever a bag exists, and a changed bag reference
 * triggers a materials-only rebuild (mirrors a tier change).
 *
 * @module effects/specular/specular-tile-surface-subsystem
 */

import { createLogger } from '../../core/log.js';
import {
  buildSpecularSurfaceMaterial,
  SPECULAR_MASK_IMAGE_SCALE,
  SPECULAR_DEFAULT_ISLAND_SPREAD,
  SPECULAR_DEFAULT_TIER,
} from './specular-render.js';
import { keyLightDirection } from './specular-material.js';
import { buildSpecularIslandPack } from './specular-islands.js';
import { buildTileMotionPositionNode, buildTileMotionMaskUvNode } from '../tile-motion-nodes.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';

const log = createLogger('SpecularTileSurface');

/** Have any of the four corners actually moved? Mirrors
 * `fluid-surface-subsystem.js`'s own helper of the same name and contract. */
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
 * @param {(floorIndex: number) => Array<{id: string, url: string, corners: Array<{x:number,y:number}>, renderOrder: number|null}>} args.getSpecularMaskItems -
 *   every TILE visible on this floor with its own authored `_Specular` file
 *   — see `specular-seams.js#getSpecularMaskItems`'s own header for why this
 *   is TILE-ONLY (level hosts stay on `specular-surface-subsystem.js`'s door).
 * @param {(opts: object) => Promise<object|null>} args.loadMaskImage
 * @param {(data: Uint8Array, w: number, h: number, filter: string) => *} args.createMaskTexture
 * @param {(data: Float32Array, w: number, h: number) => *} args.createPackTexture -
 *   the island pack's own uploader — MUST use NearestFilter, same requirement
 *   `specular-surface-subsystem.js#bakeIslandPack` documents.
 * @param {*} args.illumTexture - `buf:scene.illum`.
 * @param {*} [args.depthTexture]
 * @param {(itemId: string) => number} [args.resolveExpectedDepth] - THIS
 *   item's own rank, per ITEM rather than per floor.
 * @param {(item: object) => object|null} [args.getItemTileMotion]
 * @param {*} args.uViewRect @param {*} args.uOutdoorsRect @param {*} args.outdoorsTexNode
 * @param {Function} args.buildOutdoorsGate
 * @param {*} args.timeMsNode
 * @param {() => object} [args.getSpecularRenderState] - the SAME effect-wide
 *   look/enable seam the floor subsystem reads.
 * @param {() => object|null} [args.getSkyHandle]
 * @param {*} [args.profiler]
 * @returns {{scene: *, sync: (floorIndex: number, viewRect: object|null) => void, setDarknessFloor: Function, hasContent: () => boolean, isLoadingMask: () => boolean, getStatus: () => object, dispose: () => void}}
 */
export function createSpecularTileSurfaceSubsystem({
  THREE,
  getSpecularMaskItems,
  loadMaskImage,
  // Accepted (not `_`-prefixed away) for call-site SYMMETRY with the floor
  // subsystem, which the viewer passes the identical value to — but never
  // read here; see `window-tile-surface-subsystem.js`'s own identical
  // parameter for the full reasoning.
  createMaskTexture: _createMaskTexture,
  createPackTexture,
  illumTexture,
  depthTexture = null,
  resolveExpectedDepth,
  getItemTileMotion,
  uViewRect,
  uOutdoorsRect,
  outdoorsTexNode,
  buildOutdoorsGate,
  timeMsNode,
  getSpecularRenderState,
  getSkyHandle,
  profiler = null,
}) {
  getSpecularRenderState ??= () => ({ enabled: true, params: {} });
  getSkyHandle ??= () => null;
  resolveExpectedDepth ??= () => 0;
  getItemTileMotion ??= () => null;

  const scene = new THREE.Scene();

  let enabled = true;
  let syncs = 0;
  const failedUrls = new Set();
  /** One entry per masked TILE, keyed by item id. */
  const entries = new Map();

  function refreshVisibility() {
    for (const e of entries.values()) {
      if (e.mesh) e.mesh.visible = enabled && !!e.loadedUrl;
      if (e.mesh) e.mesh.material = e.debugChannel > 0 ? e.built?.debugMaterial : e.built?.specularMaterial;
    }
  }

  function resolveTier() {
    const t = getSpecularRenderState().perfTier;
    return Number.isFinite(t) ? t : SPECULAR_DEFAULT_TIER;
  }

  /** Builds (or rebuilds) ONE entry's material for a given tier, wiring its
   * OWN live tile-motion bag — see this module's header. */
  function buildSurfaceForEntry(entry, tier) {
    const tm = entry.tileMotionBag;
    const positionNode = tm ? buildTileMotionPositionNode(THREE.TSL, tm) : null;
    const maskUvNode = tm ? buildTileMotionMaskUvNode(THREE.TSL, tm, THREE.TSL.uv()) : null;
    return buildSpecularSurfaceMaterial({
      THREE,
      maskTexture: entry.maskTexture,
      islandPackTexture: entry.islandPackTexture,
      illumTexture,
      depthTexture,
      uViewRect,
      uOutdoorsRect,
      outdoorsTexNode,
      buildOutdoorsGate,
      timeMsNode,
      positionNode,
      maskUvNode,
      tier,
    });
  }

  /** Label this entry's mask's connected regions and upload their parallax —
   * mirrors `specular-surface-subsystem.js#bakeIslandPack` exactly, scoped to
   * one entry's own bytes/texture rather than the shared instance's. */
  function bakeIslandPack(entry, spread) {
    if (!entry.pendingBytes) return;
    profiler?.beginById('surface.specularTileIslandBake');
    try {
      const pack = buildSpecularIslandPack({
        rgba: entry.pendingBytes.data,
        width: entry.pendingBytes.width,
        height: entry.pendingBytes.height,
        spread,
      });
      entry.islandPackTexture?.dispose?.();
      entry.islandPackTexture = createPackTexture(pack.data, pack.w, pack.h);
      entry.built?.setIslandPackTexture(entry.islandPackTexture);
      entry.islandBakeStatus = pack.islandCount > 0 ? 2 : 1;
      entry.built?.setIslandBakeStatus(entry.islandBakeStatus);
    } catch (err) {
      log.error(`specular island pack bake failed for tile ${entry.id} — falling back to global parallax:`, err);
    } finally {
      profiler?.endById('surface.specularTileIslandBake');
    }
  }

  /** Load one item's mask, bake its island pack, and build its mesh. */
  async function loadAndBuild(item) {
    const entry = entries.get(item.id);
    if (!entry || entry.loading) return;
    entry.loading = true;
    try {
      const loaded = await loadMaskImage({ url: item.url, scale: SPECULAR_MASK_IMAGE_SCALE, channels: 'rgb' });
      if (!loaded) {
        if (!failedUrls.has(item.url)) {
          failedUrls.add(item.url);
          log.error(`specular mask failed to load for tile ${item.id}: ${item.url}`);
        }
        return;
      }
      if (entries.get(item.id) !== entry || entry.url !== item.url) return;

      entry.maskTexture?.dispose?.();
      entry.maskTexture = loaded.texture;
      entry.pendingBytes = loaded.data ? { data: loaded.data, width: loaded.width, height: loaded.height } : null;
      // The pack's own 1×1 placeholder — global parallax `(1,0)`, matching
      // the floor subsystem's identical fallback — until the bake below runs.
      entry.islandPackTexture ??= createPackTexture(new Uint8Array([191, 128, 0, 0]), 1, 1);
      entry.tileMotionBag = getItemTileMotion(item) ?? null;
      entry.builtForTier = resolveTier();
      disposeMesh(entry);
      entry.built = buildSurfaceForEntry(entry, entry.builtForTier);
      entry.built.setMaskUvBounds({ minU: 0, minV: 0, maxU: 1, maxV: 1 });
      bakeIslandPack(entry, entry.islandSpread);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
      geometry.setIndex(Array.from(QUAD_INDICES));
      geometry.setAttribute('position', new THREE.BufferAttribute(buildQuadPositions(entry.corners), 3));
      geometry.computeBoundingSphere();
      entry.geometry = geometry;

      entry.mesh = new THREE.Mesh(geometry, entry.built.specularMaterial);
      entry.mesh.name = `SpecularTile_${entry.id}`;
      entry.mesh.frustumCulled = false;
      entry.mesh.visible = false;
      scene.add(entry.mesh);

      entry.loadedUrl = item.url;
      lastParamsKey = '';
      log.info(`specular mask attached to tile ${item.id}: ${item.url}`);
    } finally {
      entry.loading = false;
      refreshVisibility();
    }
  }

  function disposeMesh(entry) {
    if (entry.mesh) scene.remove(entry.mesh);
    entry.built?.specularMaterial?.dispose?.();
    entry.built?.debugMaterial?.dispose?.();
    entry.geometry?.dispose?.();
    entry.mesh = null;
    entry.geometry = null;
    entry.built = null;
  }

  function disposeEntry(entry) {
    disposeMesh(entry);
    entry.maskTexture?.dispose?.();
    entry.islandPackTexture?.dispose?.();
    entry.maskTexture = null;
    entry.islandPackTexture = null;
    entry.pendingBytes = null;
  }

  /** Rebuild ONLY the materials for a tier change or a tile-motion-bag
   * change — mirrors the floor subsystem's own tier-rebuild re-push
   * discipline: a fresh material starts at its own constructor defaults. */
  function rebuildEntryMaterials(entry, tier) {
    const prev = entry.built;
    entry.tileMotionBag = getItemTileMotion(entry.item) ?? null;
    entry.built = buildSurfaceForEntry(entry, tier);
    entry.built.setMaskUvBounds({ minU: 0, minV: 0, maxU: 1, maxV: 1 });
    entry.built.setIslandBakeStatus(entry.islandBakeStatus ?? 0);
    if (entry.mesh) entry.mesh.material = entry.built.specularMaterial;
    prev?.specularMaterial?.dispose?.();
    prev?.debugMaterial?.dispose?.();
    entry.builtForTier = tier;
    lastParamsKey = '';
  }

  let lastParamsKey = '';
  let lastSkyKey = '';

  /**
   * @param {number} floorIndex - the VIEWED floor.
   * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} viewRect
   */
  function sync(floorIndex, viewRect) {
    syncs++;
    const state = getSpecularRenderState();
    enabled = state.enabled !== false;
    const resolvedTier = Number.isFinite(state.perfTier) ? state.perfTier : SPECULAR_DEFAULT_TIER;

    const items = typeof getSpecularMaskItems === 'function' ? (getSpecularMaskItems(floorIndex) ?? []) : [];
    const seen = new Set();
    for (const item of items) {
      seen.add(item.id);
      let entry = entries.get(item.id);
      if (!entry) {
        entry = {
          id: item.id,
          item,
          // ⚠️ `null`, NOT `item.url` — see window-tile-surface-subsystem.js's
          // own identical comment: the very next branch is `entry.url !==
          // item.url`, and this sentinel is what makes it fire for a
          // brand-new entry, mirroring `fluid-surface-subsystem.js`'s own
          // entry literal.
          url: null,
          corners: item.corners,
          renderOrder: item.renderOrder,
          loading: false,
          loadedUrl: null,
          maskTexture: null,
          islandPackTexture: null,
          islandBakeStatus: 0,
          islandSpread: SPECULAR_DEFAULT_ISLAND_SPREAD,
          pendingBytes: null,
          tileMotionBag: null,
          builtForTier: null,
          geometry: null,
          mesh: null,
          built: null,
          debugChannel: 0,
        };
        entries.set(item.id, entry);
      }
      entry.item = item; // refreshed every sync — getItemTileMotion needs the LIVE item

      if (entry.url !== item.url) {
        entry.url = item.url;
        entry.corners = item.corners;
        entry.loadedUrl = null;
        disposeEntry(entry);
        loadAndBuild(item);
      } else if (entry.mesh && cornersMoved(entry.corners, item.corners)) {
        entry.corners = item.corners;
        const pos = entry.geometry.getAttribute('position');
        const buf = buildQuadPositions(item.corners);
        for (let i = 0; i < buf.length; i++) pos.array[i] = buf[i];
        pos.needsUpdate = true;
        entry.geometry.computeBoundingSphere();
      }

      if (typeof item.renderOrder === 'number') entry.renderOrder = item.renderOrder;

      if (entry.built) {
        const currentBag = getItemTileMotion(entry.item) ?? null;
        if (entry.builtForTier !== resolvedTier || entry.tileMotionBag !== currentBag) {
          rebuildEntryMaterials(entry, resolvedTier);
        }
      }

      if (entry.built) entry.built.setExpectedDepth(resolveExpectedDepth(entry.id));

      // THE CAMERA — every entry, every frame, never gated: this is the
      // whole reason the shimmer moves when the author pans (mirrors the
      // floor subsystem's own comment).
      if (viewRect && entry.built) {
        entry.built.setViewCentre((viewRect.minX + viewRect.maxX) / 2, (viewRect.minY + viewRect.maxY) / 2);
      }
    }
    for (const [id, entry] of entries) {
      if (seen.has(id)) continue;
      disposeEntry(entry);
      entries.delete(id);
    }

    // THE SUN'S AZIMUTH — shared across every entry, cached on a key exactly
    // like the floor subsystem's own `sync()`.
    const sky = getSkyHandle();
    if (sky?.key) {
      const skyKey = `${sky.version}|${sky.key.azimuthDeg}|${sky.key.elevationDeg}`;
      if (skyKey !== lastSkyKey) {
        lastSkyKey = skyKey;
        const dir = keyLightDirection(sky.key);
        for (const entry of entries.values()) entry.built?.setSunDir(dir[0], dir[1]);
      }
    }

    // ── THE LOOK PARAMS — EFFECT-WIDE, PUSHED ONTO EVERY LIVE ENTRY ────────
    const p = state.params ?? {};
    const layerParams = state.layers ?? [];
    const key = [
      enabled ? 1 : 0,
      state.debugChannel ?? 0,
      p.strength,
      p.saturation,
      p.maskContrast,
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
      p.incidentKnee,
      p.kneeSoftness,
      p.incidentGain,
      p.flickerAmount,
      p.flickerSpeed,
      p.flickerScalePx,
      p.flickerRoughness,
      JSON.stringify(layerParams),
    ].join('|');
    if (key !== lastParamsKey) {
      lastParamsKey = key;
      const debugChannel = Number.isFinite(state.debugChannel) ? Math.max(0, Math.round(state.debugChannel)) : 0;
      for (const entry of entries.values()) {
        if (!entry.built) continue;
        entry.debugChannel = debugChannel;
        const b = entry.built;
        if (Number.isFinite(p.strength)) b.setStrength(p.strength);
        if (Number.isFinite(p.saturation)) b.setSaturation(p.saturation);
        if (Number.isFinite(p.maskContrast)) b.setMaskContrast(p.maskContrast);
        if (Number.isFinite(p.shimmerGain)) b.setShimmerGain(p.shimmerGain);
        if (Number.isFinite(p.patternScalePx)) b.setPatternScale(p.patternScalePx);
        if (Number.isFinite(p.lightFloor)) b.setLightFloor(p.lightFloor);
        if (Number.isFinite(p.parallaxStrength)) b.setParallaxStrength(p.parallaxStrength);
        if (Number.isFinite(p.driftSpeed)) b.setDriftSpeed(p.driftSpeed);
        if (Number.isFinite(p.sheenCeiling)) b.setSheenCeiling(p.sheenCeiling);
        if (Number.isFinite(p.glintCeiling)) b.setGlintCeiling(p.glintCeiling);
        if (Number.isFinite(p.incidentSteepness)) b.setIncidentSteepness(p.incidentSteepness);
        if (Number.isFinite(p.incidentKnee)) b.setIncidentKnee(p.incidentKnee);
        if (Number.isFinite(p.kneeSoftness)) b.setKneeSoftness(p.kneeSoftness);
        if (Number.isFinite(p.incidentGain)) b.setIncidentGain(p.incidentGain);
        if (Number.isFinite(p.flickerAmount)) b.setFlickerAmount(p.flickerAmount);
        if (Number.isFinite(p.flickerSpeed)) b.setFlickerSpeed(p.flickerSpeed);
        if (Number.isFinite(p.flickerScalePx)) b.setFlickerScalePx(p.flickerScalePx);
        if (Number.isFinite(p.flickerRoughness)) b.setFlickerRoughness(p.flickerRoughness);
        if (Number.isFinite(p.pulse)) b.setPulse(p.pulse);
        if (Number.isFinite(p.sunBias)) b.setSunBias(p.sunBias);
        for (let i = 0; i < layerParams.length; i++) {
          const L = layerParams[i] ?? {};
          if (Number.isFinite(L.density)) b.setLayerDensity(i, L.density);
          if (Number.isFinite(L.grainAngleDeg)) b.setLayerGrainAngle(i, L.grainAngleDeg);
          if (Number.isFinite(L.streak)) b.setLayerStreak(i, L.streak);
          if (Number.isFinite(L.softness)) b.setLayerSoftness(i, L.softness);
          if (Number.isFinite(L.rowSpacing)) b.setLayerRowSpacing(i, L.rowSpacing);
          if (Number.isFinite(L.contrast)) b.setLayerContrast(i, L.contrast);
          if (Number.isFinite(L.strength)) b.setLayerStrength(i, L.strength);
          if (Number.isFinite(L.parallaxDepth)) b.setLayerParallaxDepth(i, L.parallaxDepth);
        }
        // `islandSpread` costs a REBAKE, not a uniform write — same guard the
        // floor subsystem's own `sync()` uses, scoped to this entry's pack.
        if (Number.isFinite(p.islandSpread) && p.islandSpread !== entry.islandSpread) {
          entry.islandSpread = p.islandSpread;
          bakeIslandPack(entry, entry.islandSpread);
        }
        b.setDebugChannel(debugChannel);
      }
    }
    refreshVisibility();
  }

  return {
    scene,
    sync,
    /** Thin passthrough to every live entry's `setDarknessFloor` — mirrors
     * the floor subsystem's own accessor, called from `runLightAccumulatePass`
     * on the same cadence.
     * @param {number} r @param {number} g @param {number} b */
    setDarknessFloor(r, g, b) {
      for (const entry of entries.values()) entry.built?.setDarknessFloor(r, g, b);
    },
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
          islandBakeStatus: e.islandBakeStatus,
          tileMotionActive: !!e.tileMotionBag,
        })),
        failedUrls: [...failedUrls],
      };
    },
    dispose() {
      for (const entry of entries.values()) disposeEntry(entry);
      entries.clear();
    },
  };
}
