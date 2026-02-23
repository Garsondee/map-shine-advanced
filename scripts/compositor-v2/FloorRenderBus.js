/**
 * @fileoverview FloorRenderBus — simple albedo-only tile renderer for V2.
 *
 * Milestone 1 design: dead simple, no intermediate render targets.
 *
 * Previous approach (ABANDONED — see planning doc Attempts 1-4):
 *   Copied textures from TileManager sprites into bus meshes. This was broken
 *   because TileManager's pipeline routes through canvas 2D drawImage(), which
 *   premultiplies alpha internally. Bus meshes used NormalBlending (straight
 *   alpha), so premultiplied data produced white halos and corrupted edges.
 *   Switching WebP→PNG changed the corruption shape, confirming the root cause.
 *
 * New approach (Attempt 5):
 *   1. Read tile documents directly from `canvas.scene.tiles.contents`.
 *   2. Load textures via `THREE.TextureLoader` — uses an HTML <img> element,
 *      which delivers straight-alpha data with no canvas 2D intermediary.
 *   3. One THREE.Scene. Tiles Z-ordered by floor index (floor 0 at Z=1000,
 *      floor 1 at Z=1001, etc.) so standard depth sorting handles layering.
 *   4. MeshBasicMaterial with transparent:true, NormalBlending — correct for
 *      straight-alpha textures rendered directly to the screen framebuffer.
 *   5. No intermediate RTs, no compositor shaders, no premultiplied conventions.
 *
 * @module compositor-v2/FloorRenderBus
 */

import { createLogger } from '../core/log.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../foundry/levels-scene-flags.js';

const log = createLogger('FloorRenderBus');

// Z base for ground floor tiles. Each floor adds 1 unit so upper floors
// always render on top of lower floors with standard depth sorting.
const GROUND_Z = 1000;
const Z_PER_FLOOR = 1;

// ─── FloorRenderBus ──────────────────────────────────────────────────────────

export class FloorRenderBus {
  constructor() {
    /**
     * Single scene containing ALL floor tiles, Z-ordered by floor index.
     * Standard Three.js depth sorting handles layering when rendered to screen.
     * @type {import('three').Scene|null}
     */
    this._scene = null;

    /**
     * Per-tile entries. Key: tileId (string).
     * Value: { mesh, material, floorIndex }
     * @type {Map<string, {mesh: import('three').Mesh, material: import('three').MeshBasicMaterial, floorIndex: number}>}
     */
    this._tiles = new Map();

    /**
     * THREE.TextureLoader — loads via HTML <img>, preserving straight alpha
     * without any canvas 2D intermediary (which premultiplies alpha).
     * @type {import('three').TextureLoader|null}
     */
    this._loader = null;

    /** @type {boolean} */
    this._initialized = false;

    log.debug('FloorRenderBus created');
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Initialize the bus. Call once after Three.js is available.
   */
  initialize() {
    if (!window.THREE) {
      log.warn('FloorRenderBus.initialize: THREE not available');
      return;
    }
    const THREE = window.THREE;
    this._scene = new THREE.Scene();
    this._scene.name = 'FloorBusScene';
    this._loader = new THREE.TextureLoader();
    this._initialized = true;
    log.info('FloorRenderBus initialized');
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Build the scene from Foundry tile documents and the scene background.
   * Loads all textures independently via THREE.TextureLoader (straight alpha,
   * no canvas 2D corruption). Safe to call multiple times — clears first.
   *
   * @param {import('../scene/composer.js').SceneComposer} sceneComposer
   */
  populate(sceneComposer) {
    if (!this._initialized) return;
    this.clear();

    const fd = sceneComposer?.foundrySceneData;
    if (!fd) { log.warn('FloorRenderBus.populate: no foundrySceneData'); return; }

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];

    // Solid background colour plane (full world canvas, lowest Z).
    this._addSolidBackground(fd);

    // Scene background image — reuse SceneComposer's already-loaded texture
    // if available, otherwise load independently.
    const bgTexture = sceneComposer?._albedoTexture ?? null;
    const bgSrc = canvas?.scene?.background?.src ?? '';
    if (bgTexture) {
      this._addBackgroundImage(fd, bgTexture);
    } else if (bgSrc) {
      this._loader.load(bgSrc, (tex) => {
        tex.colorSpace = window.THREE.SRGBColorSpace;
        tex.flipY = false;
        tex.needsUpdate = true;
        this._addBackgroundImage(fd, tex);
        log.info('FloorRenderBus: bg image loaded via TextureLoader fallback');
      });
    }

    // Tile planes — read directly from Foundry, no TileManager dependency.
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    let tileCount = 0;
    const floorCounts = {};

    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      const alpha = typeof tileDoc.alpha === 'number' ? tileDoc.alpha : 1;
      const rotation = typeof tileDoc.rotation === 'number'
        ? (tileDoc.rotation * Math.PI) / 180 : 0;

      // Foundry tile x/y = top-left in canvas space (Y-down).
      // Three world Y-up: worldY = worldH - foundryY.
      const worldH = fd.height;
      const tileW = tileDoc.width ?? 0;
      const tileH = tileDoc.height ?? 0;
      const centerX = (tileDoc.x ?? 0) + tileW / 2;
      const centerY = worldH - ((tileDoc.y ?? 0) + tileH / 2);
      const z = GROUND_Z + floorIndex * Z_PER_FLOOR;
      const tileId = tileDoc.id ?? tileDoc._id ?? `tile_${tileCount}`;

      // Create mesh immediately with null texture (invisible until loaded).
      this._addTileMesh(tileId, floorIndex, null, centerX, centerY, z, tileW, tileH, rotation, alpha);

      // Load texture via THREE.TextureLoader — HTML <img>, straight alpha.
      this._loader.load(src, (tex) => {
        tex.colorSpace = window.THREE.SRGBColorSpace;
        tex.flipY = true; // Default Three.js convention for image textures.
        tex.needsUpdate = true;
        const entry = this._tiles.get(tileId);
        if (entry) {
          entry.material.map = tex;
          entry.material.needsUpdate = true;
          log.debug(`FloorRenderBus: texture loaded for tile ${tileId} (floor ${floorIndex})`);
        }
      }, undefined, (err) => {
        log.warn(`FloorRenderBus: failed to load texture for tile ${tileId}: ${src}`, err);
      });

      tileCount++;
      floorCounts[floorIndex] = (floorCounts[floorIndex] ?? 0) + 1;
    }

    log.info(`FloorRenderBus populated: ${tileCount} tiles`, floorCounts);
  }

  /**
   * Render the bus scene directly to the screen (null render target).
   * Uses the main perspective camera for correct world-space projection.
   *
   * Saves and restores renderer state (autoClear, clearColor, renderTarget)
   * so the rest of the render loop is not affected.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Camera} camera
   */
  renderToScreen(renderer, camera) {
    if (!this._initialized || !this._scene) return;
    const THREE = window.THREE;

    // Save renderer state.
    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevColor     = renderer.getClearColor(new THREE.Color());
    const prevAlpha     = renderer.getClearAlpha();

    // Render to screen with a black clear so no white flash while textures load.
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    renderer.render(this._scene, camera);

    // Restore renderer state.
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.setRenderTarget(prevTarget);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  /**
   * Remove all meshes and dispose GPU resources. Does not destroy the bus.
   */
  clear() {
    if (!this._scene) return;
    for (const { mesh, material } of this._tiles.values()) {
      this._scene.remove(mesh);
      material.map?.dispose();
      material.dispose();
      mesh.geometry.dispose();
    }
    this._tiles.clear();
    // Remove any remaining children (e.g. background meshes not tracked in _tiles).
    while (this._scene.children.length > 0) {
      this._scene.remove(this._scene.children[0]);
    }
  }

  /**
   * Full dispose — call on scene teardown.
   */
  dispose() {
    this.clear();
    this._scene = null;
    this._loader = null;
    this._initialized = false;
    log.info('FloorRenderBus disposed');
  }

  // ── Visibility ─────────────────────────────────────────────────────────────────

  /**
   * Show tile meshes up to and including `maxFloorIndex`, hide the rest.
   * Background planes (solid colour + scene image) are always visible.
   *
   * Call this whenever the active floor changes so upper-floor tiles are
   * hidden when the player is on a lower floor.
   *
   * @param {number} maxFloorIndex - Highest floor index to show (inclusive).
   *   Pass Infinity to show all floors.
   */
  setVisibleFloors(maxFloorIndex) {
    if (!this._initialized) return;
    for (const [tileId, entry] of this._tiles) {
      // Background planes are always visible regardless of active floor.
      if (tileId === '__bg_solid__' || tileId === '__bg_image__') {
        entry.mesh.visible = true;
        continue;
      }
      entry.mesh.visible = entry.floorIndex <= maxFloorIndex;
    }
    log.debug(`FloorRenderBus: showing floors 0–${maxFloorIndex}`);
  }

  // ── Effect Overlay API ──────────────────────────────────────────────────────

  /**
   * Add an effect overlay mesh to the bus scene. The mesh participates in the
   * same floor visibility system as albedo tiles — setVisibleFloors() will
   * automatically show/hide it based on floorIndex.
   *
   * @param {string} key - Unique key for this overlay (e.g. `${tileId}_specular`)
   * @param {import('three').Mesh} mesh - The overlay mesh (already configured with material, position, etc.)
   * @param {number} floorIndex - Floor this overlay belongs to
   */
  addEffectOverlay(key, mesh, floorIndex) {
    if (!this._initialized || !this._scene) return;
    // Remove existing overlay with the same key to avoid duplicates.
    if (this._tiles.has(key)) {
      this.removeEffectOverlay(key);
    }
    this._scene.add(mesh);
    this._tiles.set(key, { mesh, material: mesh.material, floorIndex });
    log.debug(`FloorRenderBus: added effect overlay '${key}' (floor ${floorIndex})`);
  }

  /**
   * Remove an effect overlay mesh from the bus scene and dispose its resources.
   *
   * @param {string} key - The key used when the overlay was added
   */
  removeEffectOverlay(key) {
    if (!this._scene) return;
    const entry = this._tiles.get(key);
    if (!entry) return;
    this._scene.remove(entry.mesh);
    // Don't dispose material/geometry here — the effect owns those resources
    // and disposes them in its own clear()/dispose() methods.
    this._tiles.delete(key);
    log.debug(`FloorRenderBus: removed effect overlay '${key}'`);
  }

  // ── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Add a solid-colour plane covering the full world canvas at the lowest Z.
   * Ensures no transparent black shows in padding areas.
   * @param {object} fd - foundrySceneData
   * @private
   */
  _addSolidBackground(fd) {
    const THREE = window.THREE;
    const worldW = fd.width ?? 0;
    const worldH = fd.height ?? 0;
    if (worldW <= 0 || worldH <= 0) return;

    let bgColorInt = 0x999999;
    try {
      bgColorInt = parseInt((fd.backgroundColor || '#999999').replace('#', ''), 16) || 0x999999;
    } catch (_) {}

    const mat = new THREE.MeshBasicMaterial({
      color: bgColorInt,
      depthTest: false,
      depthWrite: false,
    });
    const geom = new THREE.PlaneGeometry(worldW, worldH);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'BusBg_solid';
    mesh.frustumCulled = false;
    // Center of world canvas in Three Y-up space.
    mesh.position.set(worldW / 2, worldH / 2, GROUND_Z - 2);
    this._scene.add(mesh);
    // Store in _tiles so clear() disposes it and setVisibleFloors always shows it.
    this._tiles.set('__bg_solid__', { mesh, material: mat, floorIndex: 0 });
    log.debug(`FloorRenderBus: solid bg plane (${worldW}x${worldH}, #${bgColorInt.toString(16)})`);
  }

  /**
   * Add the scene background image plane at Z just above the solid colour plane.
   * Uses the texture already loaded by SceneComposer — no extra network fetch.
   *
   * The background image is opaque and covers only the scene rect (not padding).
   * SceneComposer's basePlaneMesh uses scale.y=-1 to flip Y; we mirror that here
   * with DoubleSide so the back-face isn't culled.
   *
   * @param {object} fd - foundrySceneData
   * @param {import('three').Texture} texture
   * @private
   */
  _addBackgroundImage(fd, texture) {
    const THREE = window.THREE;
    const sceneW = fd.sceneWidth ?? fd.width ?? 0;
    const sceneH = fd.sceneHeight ?? fd.height ?? 0;
    const worldH = fd.height ?? 0;
    if (sceneW <= 0 || sceneH <= 0) return;

    // Scene rect center in Three Y-up world space.
    const sceneX = fd.sceneX ?? 0;
    const sceneY = fd.sceneY ?? 0;
    const centerX = sceneX + sceneW / 2;
    const centerY = worldH - (sceneY + sceneH / 2);

    // Ensure flipY=false to match SceneComposer's UV convention (Y-flip via
    // scale.y=-1 on the mesh instead of on the texture).
    texture.flipY = false;
    texture.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      // DoubleSide because scale.y=-1 reverses face winding.
      side: THREE.DoubleSide,
    });
    const geom = new THREE.PlaneGeometry(sceneW, sceneH);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'BusBg_image';
    mesh.frustumCulled = false;
    mesh.position.set(centerX, centerY, GROUND_Z - 1);
    // Negative Y scale to flip the image right-side up (matches basePlaneMesh).
    mesh.scale.set(1, -1, 1);
    this._scene.add(mesh);
    // Store in _tiles so clear() disposes it and setVisibleFloors always shows it.
    this._tiles.set('__bg_image__', { mesh, material: mat, floorIndex: 0 });
    log.info(`FloorRenderBus: bg image plane (${sceneW}x${sceneH} at ${centerX},${centerY})`);
  }

  /**
   * Create a tile mesh and add it to the single bus scene.
   * Texture starts null and is filled in by the TextureLoader callback.
   *
   * @param {string} tileId
   * @param {number} floorIndex
   * @param {import('three').Texture|null} texture
   * @param {number} cx - world-space center X
   * @param {number} cy - world-space center Y (Three Y-up)
   * @param {number} z  - world-space Z
   * @param {number} w  - tile width in world units
   * @param {number} h  - tile height in world units
   * @param {number} rotation - radians around Z
   * @param {number} alpha
   * @private
   */
  _addTileMesh(tileId, floorIndex, texture, cx, cy, z, w, h, rotation, alpha) {
    const THREE = window.THREE;

    const mat = new THREE.MeshBasicMaterial({
      map: texture || null,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: alpha,
    });

    const geom = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `BusTile_${tileId}`;
    mesh.frustumCulled = false;
    mesh.position.set(cx, cy, z);
    mesh.rotation.z = rotation;

    this._scene.add(mesh);
    this._tiles.set(tileId, { mesh, material: mat, floorIndex });
  }

  /**
   * Resolve which floor index a tile belongs to by reading its Levels elevation
   * flags directly. No FloorLayerManager wiring required.
   *
   * @param {object} tileDoc - Foundry TileDocument
   * @param {Array} floors - Ordered floor bands from FloorStack
   * @returns {number} Floor index (0-based)
   * @private
   */
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop    = Number(flags.rangeTop);
      const tileMid    = (tileBottom + tileTop) / 2;

      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid <= f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }

    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }

}

