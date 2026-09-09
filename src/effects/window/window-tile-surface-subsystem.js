/**
 * WINDOW LIGHT'S PER-TILE SURFACE — one mesh PER MASKED TILE, ADDED beside
 * `window-surface-subsystem.js`'s existing per-FLOOR population, never
 * instead of it (mythica-machina-press#538/#539).
 *
 * ============================================================================
 * WHY A SEPARATE SUBSYSTEM, NOT A CHANGE TO THE FLOOR ONE
 * ============================================================================
 * `window-surface-subsystem.js` builds ONE mesh per FLOOR, cropped to the
 * mask file's own painted AABB in WORLD space, sampled through a
 * `uMaskUvBounds` remap of the quad's `uv()`. That shape is right for a
 * cookie painted into a level's background art and would be WRONG for a
 * tile: a rotated tile mapped through an axis-aligned world-rect crop comes
 * out misaligned the instant the tile is not axis-aligned, and — the
 * `mythica-machina-press#539` half of this fix — a tile can be LIVE-MOVING
 * under tile-motion, which an AABB computed once at mask-load time cannot
 * track at all.
 *
 * This subsystem instead follows `fluid-surface-subsystem.js`'s own shape:
 * ONE mesh PER MASKED ITEM, and that mesh IS the item's own quad — corners
 * from `getWindowMaskItems`, sampled at plain `uv()` (no crop: the mask
 * file's whole extent maps onto the whole tile, `uMaskUvBounds` pushed as
 * the constant identity `(0,0,1,1)`, exactly the reasoning Fluid's own
 * header gives for not cropping to content on a per-item quad). A rotated
 * tile comes out right for free, the same way Fluid's own header already
 * explains.
 *
 * `buildWindowSurfaceMaterial` (`window-render.js`) is REUSED unchanged —
 * same glass/dispersion/caustic chain, same highlight shoulder, same
 * daylight tint — so a tile-attached cookie looks and behaves like the
 * shipped effect, not a stripped-down cousin. Only the GEOMETRY and the two
 * new optional parameters (`positionNode`/`maskUvNode`) differ from the
 * floor path.
 *
 * ============================================================================
 * TILE-MOTION (mythica-machina-press#539)
 * ============================================================================
 * `getItemTileMotion(item)` resolves the SAME live uniform bag the tile's
 * own visible mesh reads (`vt-pan-viewer.js#resolveItemTileMotion`) — never
 * a fresh copy (see `effects/tile-motion-nodes.js`'s own header on why).
 * Both `positionNode` (transform mode) and the mask's own UV node (texture
 * mode) are wired UNCONDITIONALLY whenever a bag exists — the inactive
 * half's uniforms are pushed as the identity every frame by
 * `syncAllTileMotionForFrame` regardless of which mode the tile is
 * actually in, so there is no per-mode branch to keep in sync here (see
 * `tile-motion-nodes.js`'s own header). A tile with NO tile-motion
 * configured at all never resolves a bag — its surface is built with
 * neither parameter, an ordinary static per-tile surface.
 *
 * `positionNode`/`maskUvNode` are baked into the compiled material graph at
 * BUILD time (TSL has no "swap this node later" setter) — so if the
 * resolved bag reference ever changes for an already-built entry (the
 * tile's own mesh was rebuilt, e.g. after a texture reload), this
 * subsystem rebuilds that entry's materials, the same way a resolved-tier
 * change already does (see `rebuildEntryMaterials`).
 *
 * ============================================================================
 * WHY THE MASK IS NOT CROPPED — AND WHY THAT IS SAFE HERE, UNLIKE THE FLOOR
 * ============================================================================
 * `window-surface-subsystem.js`'s own header calls out Effects.md Law 6 (cost
 * scales with covered pixels) as the reason its floor mesh crops to painted
 * content: a level's mask file can be tiny compared to the whole scene canvas.
 * A TILE's own `_Window` file has no such mismatch — the file IS the tile's
 * art, at the tile's own extent — so the quad already covers only what the
 * tile covers, with nothing to crop.
 *
 * @module effects/window/window-tile-surface-subsystem
 */

import { createLogger } from '../../core/log.js';
import {
  buildWindowSurfaceMaterial,
  WINDOW_MASK_IMAGE_SCALE,
  WINDOW_DEFAULT_DAWN_DUSK_TINT_RGB,
  WINDOW_DEFAULT_NIGHT_TINT_RGB,
  WINDOW_DEFAULT_TIER,
} from './window-render.js';
import { computeSeedOffset } from './window-glass.js';
import { WINDOW_DEFAULT_AMBIENT_CEILING } from './window-cookie.js';
import { buildTileMotionPositionNode, buildTileMotionMaskUvNode } from '../tile-motion-nodes.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../scene/index.js';

const log = createLogger('WindowTileSurface');

/** Identical A→B→C lerp idiom `window-surface-subsystem.js` already uses for
 * the same daylight-tint chain — duplicated rather than imported across a
 * sibling subsystem module (neither exports the other; both are peers of
 * `window-render.js`, mirroring `specular-surface-subsystem.js`'s own
 * standalone copy of comparable small helpers).
 * @param {readonly number[]} a @param {readonly number[]} b @param {number} t
 * @returns {number[]} */
function lerpRgb(a, b, t) {
  const s = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

/** Have any of the four corners actually moved? Mirrors
 * `fluid-surface-subsystem.js`'s own helper of the same name and contract. */
function cornersMoved(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return true;
  }
  return false;
}

/** World-space AABB span of a quad's corners — the ONLY thing
 * `setUvPerWorldPx` needs, and the per-tile equivalent of the floor
 * subsystem's `contentBoundsWorld` span (there the crop; here the tile's
 * own full extent, since the mask covers the whole quad — see this
 * module's header on why no crop exists here). */
function worldSpanOf(corners) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  return { width: maxX - minX, height: maxY - minY };
}

/**
 * @param {object} args
 * @param {*} args.THREE - injected, never imported.
 * @param {(floorIndex: number) => Array<{id: string, url: string, corners: Array<{x:number,y:number}>, renderOrder: number|null}>} args.getWindowMaskItems -
 *   every TILE visible on this floor with its own authored `_Window` file —
 *   see `window-seams.js#getWindowMaskItems`'s own header for why this is
 *   TILE-ONLY (level hosts stay on `window-surface-subsystem.js`'s door).
 * @param {(opts: object) => Promise<object|null>} args.loadMaskImage
 * @param {(data: Uint8Array, w: number, h: number, filter: string) => *} args.createMaskTexture
 * @param {*} [args.depthTexture] - `buf:scene.depth`'s DEPTH attachment; null
 *   compiles the floor gate out, mirroring the floor subsystem exactly.
 * @param {(itemId: string) => number} [args.resolveExpectedDepth] - THIS
 *   item's own rank (`depthAuthority.rankOf({id: itemId})`, composed by the
 *   viewer) — per ITEM, not per floor, unlike the floor subsystem's own
 *   seam of the same name.
 * @param {(item: object) => object|null} [args.getItemTileMotion] - the
 *   item's LIVE tile-motion uniform bag, or null for an unanimated tile —
 *   see this module's own header.
 * @param {*} args.uViewRect
 * @param {*} [args.cloudFactorNode]
 * @param {() => object} [args.getWindowRenderState] - the SAME effect-wide
 *   look/enable seam the floor subsystem reads; Window has one param set for
 *   the whole effect, not one per surface.
 * @param {() => object|null} [args.getEnvSun]
 * @param {() => (readonly number[]|null)} [args.getAmbientCeilingRgb]
 * @param {*} [args.profiler]
 * @returns {{scene: *, sync: (floorIndex: number) => void, hasContent: () => boolean, isLoadingMask: () => boolean, getStatus: () => object, dispose: () => void}}
 */
export function createWindowTileSurfaceSubsystem({
  THREE,
  getWindowMaskItems,
  loadMaskImage,
  // Accepted (not `_`-prefixed away) for call-site SYMMETRY with the floor
  // subsystem, which the viewer passes the identical value to — but never
  // read here: unlike that subsystem, an entry here does not exist until a
  // mask URL is already confirmed, so there is no 1×1-placeholder-texture
  // moment of its own to build one for.
  createMaskTexture: _createMaskTexture,
  depthTexture = null,
  resolveExpectedDepth,
  getItemTileMotion,
  uViewRect,
  cloudFactorNode = null,
  getWindowRenderState,
  getEnvSun,
  getAmbientCeilingRgb,
  profiler = null,
}) {
  // ⚠️ `seams/viewer-wired` history — see window-surface-subsystem.js's own
  // identical guard. An absent seam here would mean every tile-attached
  // cookie silently never appears, with no error anywhere.
  getWindowRenderState ??= () => ({ enabled: true, params: {}, debugChannel: 0 });
  getEnvSun ??= () => null;
  getAmbientCeilingRgb ??= () => null;
  resolveExpectedDepth ??= () => 0;
  getItemTileMotion ??= () => null;

  const scene = new THREE.Scene();

  let enabled = true;
  let syncs = 0;
  /** Every url that failed, so a broken file is reported ONCE not every frame. */
  const failedUrls = new Set();
  /** One entry per masked TILE, keyed by item id — mirrors
   * `fluid-surface-subsystem.js`'s own `entries` Map exactly. */
  const entries = new Map();

  function refreshVisibility() {
    for (const e of entries.values()) {
      if (e.mesh) e.mesh.visible = enabled && !!e.loadedUrl;
      if (e.mesh) e.mesh.material = e.debugChannel > 0 ? e.built?.debugMaterial : e.built?.windowMaterial;
    }
  }

  /**
   * Builds (or rebuilds) ONE entry's material for a given tier, wiring its
   * OWN live tile-motion bag — see this module's header on why both nodes
   * are wired unconditionally whenever a bag exists.
   * @param {object} entry @param {number} tier
   */
  function buildSurfaceForEntry(entry, tier) {
    const tm = entry.tileMotionBag;
    const positionNode = tm ? buildTileMotionPositionNode(THREE.TSL, tm) : null;
    const maskUvNode = tm ? buildTileMotionMaskUvNode(THREE.TSL, tm, THREE.TSL.uv()) : null;
    return buildWindowSurfaceMaterial({
      THREE,
      maskTexture: entry.maskTexture,
      depthTexture,
      uViewRect,
      cloudFactorNode,
      positionNode,
      maskUvNode,
      // Same production wiring the floor subsystem uses — see that file's
      // own comment on `gateGlass`/`glass` for the reasoning; unchanged here.
      gateGlass: true,
      glass: tier >= 1,
    });
  }

  /**
   * Load one item's mask and build its mesh. Async and idempotent, same
   * shape as `fluid-surface-subsystem.js#loadAndBake` minus the tube bake —
   * this effect has nothing to extract, only a file to decode.
   * @param {object} item
   */
  async function loadAndBuild(item) {
    const entry = entries.get(item.id);
    if (!entry || entry.loading) return;
    entry.loading = true;
    try {
      const loaded = await loadMaskImage({ url: item.url, scale: WINDOW_MASK_IMAGE_SCALE, channels: 'rgb' });
      if (!loaded) {
        if (!failedUrls.has(item.url)) {
          failedUrls.add(item.url);
          log.error(`window mask failed to load for tile ${item.id}: ${item.url}`);
        }
        return;
      }
      // Guard the await gap: a scene change during the fetch would otherwise
      // build a mesh for an item no longer here, or for a URL this entry has
      // since moved on from.
      if (entries.get(item.id) !== entry || entry.url !== item.url) return;

      entry.maskTexture?.dispose?.();
      entry.maskTexture = loaded.texture;
      entry.tileMotionBag = getItemTileMotion(item) ?? null;
      entry.builtForTier = resolveTier();
      disposeMesh(entry); // drop any stale mesh before building the real one
      entry.built = buildSurfaceForEntry(entry, entry.builtForTier);
      entry.built.setMaskUvBounds({ minU: 0, minV: 0, maxU: 1, maxV: 1 });
      const span = worldSpanOf(entry.corners);
      entry.built.setUvPerWorldPx(span.width > 1e-6 ? 1 / span.width : 0, span.height > 1e-6 ? 1 / span.height : 0);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
      geometry.setIndex(Array.from(QUAD_INDICES));
      geometry.setAttribute('position', new THREE.BufferAttribute(buildQuadPositions(entry.corners), 3));
      geometry.computeBoundingSphere();
      entry.geometry = geometry;

      entry.mesh = new THREE.Mesh(geometry, entry.built.windowMaterial);
      entry.mesh.name = `WindowTile_${entry.id}`;
      entry.mesh.frustumCulled = false;
      entry.mesh.visible = false; // refreshVisibility() below decides
      scene.add(entry.mesh);

      entry.loadedUrl = item.url;
      lastParamsKey = ''; // force the fresh material to receive the current look
      log.info(`window mask attached to tile ${item.id}: ${item.url}`);
    } finally {
      entry.loading = false;
      refreshVisibility();
    }
  }

  /** Mesh + material teardown for one entry — NOT the map entry itself
   * (mirrors `fluid-surface-subsystem.js#disposeMesh`'s own split). */
  function disposeMesh(entry) {
    if (entry.mesh) scene.remove(entry.mesh);
    entry.built?.windowMaterial?.dispose?.();
    entry.built?.debugMaterial?.dispose?.();
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

  /** Rebuild ONLY the materials (never geometry/mesh identity/scene
   * membership) for a tier change or a tile-motion-bag change — mirrors
   * `window-surface-subsystem.js#buildSurfaceForTier`'s own re-push
   * discipline: a fresh material starts at its own constructor defaults, so
   * the crop bounds and UV-per-world-px ratio (normally pushed once, on
   * load) must be re-pushed here too.
   * @param {object} entry @param {number} tier
   */
  function rebuildEntryMaterials(entry, tier) {
    const prev = entry.built;
    entry.tileMotionBag = getItemTileMotion(entry.item) ?? null;
    entry.built = buildSurfaceForEntry(entry, tier);
    entry.built.setMaskUvBounds({ minU: 0, minV: 0, maxU: 1, maxV: 1 });
    const span = worldSpanOf(entry.corners);
    entry.built.setUvPerWorldPx(span.width > 1e-6 ? 1 / span.width : 0, span.height > 1e-6 ? 1 / span.height : 0);
    if (entry.mesh) entry.mesh.material = entry.built.windowMaterial;
    prev?.windowMaterial?.dispose?.();
    prev?.debugMaterial?.dispose?.();
    entry.builtForTier = tier;
    lastParamsKey = '';
  }

  function resolveTier() {
    const t = getWindowRenderState().perfTier;
    return Number.isFinite(t) ? t : WINDOW_DEFAULT_TIER;
  }

  let lastParamsKey = '';

  /** @param {number} floorIndex - the VIEWED floor. */
  function sync(floorIndex) {
    profiler?.beginById('light.windowTileSync');
    try {
      syncUnguarded(floorIndex);
    } finally {
      profiler?.endById('light.windowTileSync');
    }
  }

  function syncUnguarded(floorIndex) {
    syncs++;
    const state = getWindowRenderState();
    enabled = state.enabled !== false;
    const resolvedTier = Number.isFinite(state.perfTier) ? state.perfTier : WINDOW_DEFAULT_TIER;

    const items = typeof getWindowMaskItems === 'function' ? (getWindowMaskItems(floorIndex) ?? []) : [];
    const seen = new Set();
    for (const item of items) {
      seen.add(item.id);
      let entry = entries.get(item.id);
      if (!entry) {
        entry = {
          id: item.id,
          item,
          // ⚠️ `null`, NOT `item.url` — the very next branch below is
          // `entry.url !== item.url`, and this is the "never loaded
          // anything yet" sentinel that makes it fire for a brand-new
          // entry. Mirrors `fluid-surface-subsystem.js#sync`'s own entry
          // literal exactly (its own `url: null` for the identical reason).
          url: null,
          corners: item.corners,
          renderOrder: item.renderOrder,
          loading: false,
          loadedUrl: null,
          maskTexture: null,
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
        // Dragged/rotated/resized: move the quad and re-derive the glass's
        // own world-px-to-UV ratio — the mask itself is unchanged.
        entry.corners = item.corners;
        const pos = entry.geometry.getAttribute('position');
        const buf = buildQuadPositions(item.corners);
        for (let i = 0; i < buf.length; i++) pos.array[i] = buf[i];
        pos.needsUpdate = true;
        entry.geometry.computeBoundingSphere();
        const span = worldSpanOf(item.corners);
        entry.built?.setUvPerWorldPx(span.width > 1e-6 ? 1 / span.width : 0, span.height > 1e-6 ? 1 / span.height : 0);
      }

      if (typeof item.renderOrder === 'number') entry.renderOrder = item.renderOrder;

      // ── TILE-MOTION-BAG / TIER REBUILD ──────────────────────────────────
      // Either can move independently of the mask URL: a live profile change
      // resolves a different tier with the SAME mask, and the tile's own
      // visible mesh can be rebuilt (a fresh bag) with the SAME mask and tier.
      if (entry.built) {
        const currentBag = getItemTileMotion(entry.item) ?? null;
        if (entry.builtForTier !== resolvedTier || entry.tileMotionBag !== currentBag) {
          rebuildEntryMaterials(entry, resolvedTier);
        }
      }

      if (entry.built) {
        entry.built.setExpectedDepth(resolveExpectedDepth(entry.id));
      }
    }
    for (const [id, entry] of entries) {
      if (seen.has(id)) continue;
      disposeEntry(entry);
      entries.delete(id);
    }

    // ── THE LOOK PARAMS — EFFECT-WIDE, PUSHED ONTO EVERY LIVE ENTRY ────────
    // Window has ONE param set for the whole effect, not one per surface —
    // see this module's own header. Cached on a key exactly like the floor
    // subsystem's own `sync()`, so a static clock/unchanged panel costs one
    // string compare per frame.
    const p = state.params ?? {};
    const sun = getEnvSun();
    const dayFactor01 = Number.isFinite(sun?.dayFactor01) ? sun.dayFactor01 : 1;
    const twilight01 = Number.isFinite(sun?.twilight01) ? sun.twilight01 : 0;
    const rawAmbientRgb = getAmbientCeilingRgb();
    const ambientCeiling =
      Array.isArray(rawAmbientRgb) && rawAmbientRgb.length === 3 && rawAmbientRgb.every(Number.isFinite)
        ? Math.max(rawAmbientRgb[0], rawAmbientRgb[1], rawAmbientRgb[2], 0)
        : WINDOW_DEFAULT_AMBIENT_CEILING;
    const debugChannel = Number.isFinite(state.debugChannel) ? Math.max(0, Math.round(state.debugChannel)) : 0;
    const key = [
      enabled ? 1 : 0,
      debugChannel,
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
      const seedOffset = computeSeedOffset(p.glassSeed);
      const dawnDusk = Array.isArray(p.dawnDuskTint) ? p.dawnDuskTint : WINDOW_DEFAULT_DAWN_DUSK_TINT_RGB;
      const night = Array.isArray(p.nightTint) ? p.nightTint : WINDOW_DEFAULT_NIGHT_TINT_RGB;
      const nightToTwilight = lerpRgb(night, dawnDusk, twilight01);
      const daylightTint = lerpRgb(nightToTwilight, [1, 1, 1], dayFactor01);
      for (const entry of entries.values()) {
        if (!entry.built) continue;
        entry.debugChannel = debugChannel;
        if (Number.isFinite(p.strength)) entry.built.setStrength(p.strength);
        if (Number.isFinite(p.contrast)) entry.built.setContrast(p.contrast);
        entry.built.setAmbientCeiling(ambientCeiling);
        entry.built.setGlass({
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
        entry.built.setDaylightTint(daylightTint);
        entry.built.setDebugChannel(debugChannel);
      }
    }
    refreshVisibility();
  }

  return {
    scene,
    sync,
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
