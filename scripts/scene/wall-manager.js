/**
 * @fileoverview Wall manager - syncs Foundry walls to THREE.js
 * Handles creation, updates, and deletion of wall objects for lighting/collision
 * @module scene/wall-manager
 */
import { isGmLike } from '../core/gm-parity.js';


import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { applyWallLevelDefaults, getFiniteActiveLevelBand, shouldApplyLevelCreateDefaults } from '../foundry/levels-create-defaults.js';
import { readWallHeightFlags } from '../foundry/levels-scene-flags.js';
import { getPerspectiveElevation } from '../foundry/elevation-context.js';
import { OVERLAY_THREE_LAYER } from '../core/render-layers.js';
import { flattenWallUpdateChanges, isWallDoorStateOnlyUpdate } from '../utils/wall-update-classify.js';

const log = createLogger('WallManager');

// Foundry Wall Colors (Approximated)
const WALL_COLORS = {
  NORMAL: 0xf5f5dc, // Cream
  TERRAIN: 0x88ff88, // Light Green
  INVISIBLE: 0x88ccff, // Light Blue/Cyan
  ETHEREAL: 0xaa88ff, // Light Purple
  DOOR: 0x5555ff, // Blue
  SECRET: 0xaa00aa, // Dark Purple
  LOCKED: 0xff4444 // Red
};

/**
 * WallManager - Synchronizes Foundry VTT walls to THREE.js
 * Renders walls as 3D lines and endpoints
 */
export class WallManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene
   */
  constructor(scene) {
    this.scene = scene;
    
    /** @type {Map<string, THREE.Object3D>} */
    this.walls = new Map();
    
    this.initialized = false;
    
    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];
    
    // Group for all wall objects
    this.wallGroup = new THREE.Group();
    this.wallGroup.name = 'Walls';
    
    // Track selected walls
    this.selected = new Set();
    
    // Z-index for walls - will be updated in initialize() once groundZ is available
    this.wallGroup.position.z = 3.0; 
    
    this.scene.add(this.wallGroup);
    
    // Reusable geometry for endpoints
    this.endpointGeometry = new THREE.CircleGeometry(5, 16); // Radius 5px
    
    log.debug('WallManager created');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) return;

    this._ensureWallGroupInActiveRenderScene();

    // Update Z position based on groundZ
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    this.wallGroup.position.z = groundZ + 3.0;

    this.setupHooks();

    // Initial wall sync can occur before Foundry fully populates wall placeables
    // and/or before canvas dimensions are stable. If we build door controls too
    // early, some can end up stuck at origin and appear as a second icon set.
    this._scheduleInitialSync();
    
    this.initialized = true;
    log.info(`WallManager initialized at z=${this.wallGroup.position.z}`);
  }

  _scheduleInitialSync() {
    const maxAttempts = 30;
    const attemptDelayMs = 50;

    let attempts = 0;
    const tick = () => {
      attempts += 1;
      try {
        const dimsOk = Number.isFinite(Number(canvas?.dimensions?.height)) && canvas.dimensions.height > 0;
        const wallsOk = Array.isArray(canvas?.walls?.placeables) && canvas.walls.placeables.length > 0;
        if (dimsOk && wallsOk) {
          this.syncAllWalls();
          return;
        }
      } catch (_) {
      }

      if (attempts < maxAttempts) setTimeout(tick, attemptDelayMs);
    };

    setTimeout(tick, 0);
  }

  _getActiveRenderScene() {
    const busScene = window.MapShine?.effectComposer?._floorCompositorV2?._renderBus?._scene
      ?? window.MapShine?.floorRenderBus?._scene
      ?? null;
    return busScene || this.scene || null;
  }

  _ensureWallGroupInActiveRenderScene() {
    const targetScene = this._getActiveRenderScene();
    if (!targetScene || !this.wallGroup) return;
    if (this.wallGroup.parent === targetScene) return;

    try {
      if (this.wallGroup.parent) this.wallGroup.parent.remove(this.wallGroup);
      targetScene.add(this.wallGroup);
      this.scene = targetScene;
      log.info(`WallManager render scene updated (children=${targetScene.children?.length ?? 0})`);
    } catch (_) {
    }
  }

  /**
   * Setup Foundry hooks for wall updates
   * @private
   */
  setupHooks() {
    this._hookIds.push(['pasteWall', Hooks.on('pasteWall', (_objects, data) => {
      try {
        if (!Array.isArray(data)) return;
        for (const entry of data) {
          if (!entry || !Array.isArray(entry.c) || entry.c.length < 4) continue;
          entry.c = entry.c.slice(0, 4).map((v) => Math.round(Number(v) || 0));
        }
      } catch (_) {
      }
    })]);

    this._hookIds.push(['preCreateWall', Hooks.on('preCreateWall', (doc, data, options, userId) => {
      this._onPreCreateWall(doc, data, options, userId);
    })]);

    this._hookIds.push(['createWall', Hooks.on('createWall', (doc) => {
      this.create(doc);
      this._postCreateWallIntegrityGuard(doc);
      setTimeout(() => {
        try {
          this.updateVisibility();
        } catch (_) {
        }
      }, 0);
      this._requestLightingRefresh();
    })]);
    this._hookIds.push(['updateWall', Hooks.on('updateWall', (doc, changes) => {
      this.update(doc, changes);
      setTimeout(() => {
        try {
          this.updateVisibility();
        } catch (_) {
        }
      }, 0);
      if (!window.MapShine?.__debugSkipWallManagerHookLightingRefresh) {
        this._requestLightingRefresh();
      }
    })]);
    this._hookIds.push(['deleteWall', Hooks.on('deleteWall', (doc) => {
      this.remove(doc.id);
      setTimeout(() => {
        try {
          this.updateVisibility();
        } catch (_) {
        }
      }, 0);
      this._requestLightingRefresh();
    })]);

    this._hookIds.push(['mapShineLevelContextChanged', Hooks.on('mapShineLevelContextChanged', () => {
      this.updateVisibility();
    })]);

    this._hookIds.push(['controlToken', Hooks.on('controlToken', () => {
      this.updateVisibility();
    })]);

    this._hookIds.push(['sightRefresh', Hooks.on('sightRefresh', () => {
      this.updateVisibility();
    })]);
  }

  _onPreCreateWall(doc, data, options, userId) {
    try {
      if (userId && game?.user?.id && userId !== game.user.id) return;

      // Foundry requires integer wall endpoints. Some legacy wall data and copy/paste
      // workflows can carry float coordinates; coerce here before model validation.
      if (Array.isArray(data?.c) && data.c.length >= 4) {
        const intCoords = data.c.slice(0, 4).map((v) => Math.round(Number(v) || 0));
        data.c = intCoords;
        try {
          doc.updateSource({ c: intCoords });
        } catch (_) {
        }
      }

      const hasBottom = data?.flags?.['wall-height']?.bottom !== undefined
        && data?.flags?.['wall-height']?.bottom !== null;
      const hasTop = data?.flags?.['wall-height']?.top !== undefined
        && data?.flags?.['wall-height']?.top !== null;
      if (hasBottom && hasTop) return;

      const defaults = {};
      applyWallLevelDefaults(defaults, { scene: doc?.parent ?? canvas?.scene });
      const seeded = defaults?.flags?.['wall-height'];
      if (!seeded) return;

      const nextWallHeight = {
        bottom: hasBottom ? data.flags['wall-height'].bottom : seeded.bottom,
        top: hasTop ? data.flags['wall-height'].top : seeded.top,
      };

      // Mutate the pending create data directly so all downstream preCreate
      // consumers see the same wall-height bounds in this transaction.
      data.flags = (data.flags && typeof data.flags === 'object') ? data.flags : {};
      data.flags['wall-height'] = {
        ...(data.flags['wall-height'] && typeof data.flags['wall-height'] === 'object' ? data.flags['wall-height'] : {}),
        bottom: nextWallHeight.bottom,
        top: nextWallHeight.top,
      };

      doc.updateSource({
        'flags.wall-height.bottom': nextWallHeight.bottom,
        'flags.wall-height.top': nextWallHeight.top,
      });
    } catch (_) {
    }
  }

  /**
   * Post-create integrity guard: if a wall was created in a multi-level scene
   * but somehow landed without wall-height bounds (e.g. preCreate hook was
   * bypassed, or a module created the wall programmatically), patch it now.
   *
   * This is a safety net — the preCreateWall hook should handle the normal case.
   * @param {WallDocument} doc
   * @private
   */
  _postCreateWallIntegrityGuard(doc) {
    try {
      if (!doc?.id) return;
      if (!shouldApplyLevelCreateDefaults(doc.parent ?? canvas?.scene, { allowWhenModeOff: true })) return;

      const flags = doc.flags?.['wall-height'];
      const hasBottom = flags?.bottom !== undefined && flags?.bottom !== null && Number.isFinite(Number(flags.bottom));
      const hasTop = flags?.top !== undefined && flags?.top !== null && Number.isFinite(Number(flags.top));
      if (hasBottom && hasTop) return;

      const band = getFiniteActiveLevelBand();
      if (!band) return;

      const patch = {};
      if (!hasBottom) patch['flags.wall-height.bottom'] = band.bottom;
      if (!hasTop) patch['flags.wall-height.top'] = band.top;

      log.warn(`Post-create guard: wall ${doc.id} missing wall-height bounds — patching with band [${band.bottom}, ${band.top}]`);

      // Defer the update to avoid re-entrant document mutations during the
      // createWall hook chain.
      setTimeout(() => {
        try {
          doc.update(patch);
        } catch (e) {
          log.warn('Post-create wall-height patch failed:', e);
        }
      }, 50);
    } catch (_) {
      // Guard must never throw and disrupt the createWall flow
    }
  }

  _shouldShowWallLines() {
    try {
      // Native PIXI owns wall segments on the Walls layer; hide Three.js duplicates.
      if (canvas?.walls?.active) return false;
      const active = canvas?.activeLayer;
      if (active === canvas?.walls) return false;

      // IMPORTANT: Only show Three.js wall edit geometry when the user is explicitly
      // in the Walls tool. Returning true for generic "token gameplay" caused
      // controlToken + sightRefresh (frequent after checkpoint movement / fog) to
      // call updateVisibility() and briefly show wall lines until the next
      // InteractionManager frame forced them off again — visible flicker.
      const activeName = String(active?.options?.name || active?.name || active?.constructor?.name || '').toLowerCase();
      const activeControlName = String(ui?.controls?.control?.name || ui?.controls?.activeControl || '').toLowerCase();
      const activeControlLayer = String(ui?.controls?.control?.layer || '').toLowerCase();

      const wallsEditing =
        activeName === 'wallslayer'
        || activeName === 'walllayer'
        || activeName === 'walls'
        || activeName === 'wall'
        || activeControlName === 'walls'
        || activeControlName === 'wall'
        || activeControlLayer === 'walls'
        || activeControlLayer === 'wall';

      return !!wallsEditing;
    } catch (_) {
      return false;
    }
  }

  _requestLightingRefresh() {
    try {
      const fc = window.MapShine?.frameCoordinator;
      if (fc?.forcePerceptionUpdate) {
        setTimeout(() => {
          try {
            fc.forcePerceptionUpdate();
          } catch (_) {
          }
        }, 0);

        setTimeout(() => {
          try {
            const le = window.MapShine?.lightingEffect;
            if (le?.forceRebuildLightGeometriesFromWalls) {
              le.forceRebuildLightGeometriesFromWalls();
            }
          } catch (_) {
          }
        }, 0);

        return;
      }
    } catch (_) {
    }

    try {
      if (canvas?.perception?.update) {
        setTimeout(() => {
          try {
            canvas.perception.update({ refreshVision: true, refreshLighting: true });
          } catch (_) {
          }
        }, 0);

        setTimeout(() => {
          try {
            const le = window.MapShine?.lightingEffect;
            if (le?.forceRebuildLightGeometriesFromWalls) {
              le.forceRebuildLightGeometriesFromWalls();
            }
          } catch (_) {
          }
        }, 0);
      }
    } catch (_) {
    }
  }

  /**
   * Update visibility based on current active layer state
   */
  updateVisibility() {
    // V2 self-heal: when FloorRenderBus becomes active after manager init,
    // move walls/door controls into the actually rendered scene.
    this._ensureWallGroupInActiveRenderScene();

    const showLines = this._shouldShowWallLines();
    this.setVisibility(showLines);
  }

  _isWallVisibleAtPerspective(wallDoc) {
    if (!wallDoc) return true;

    const perspective = getPerspectiveElevation();
    const elevation = Number(perspective?.elevation);
    if (!Number.isFinite(elevation)) return true;

    const bounds = readWallHeightFlags(wallDoc);
    let bottom = Number(bounds?.bottom);
    let top = Number(bounds?.top);
    if (!Number.isFinite(bottom)) bottom = -Infinity;
    if (!Number.isFinite(top)) top = Infinity;
    if (top < bottom) {
      const swap = bottom;
      bottom = top;
      top = swap;
    }

    return (bottom <= elevation) && (elevation <= top);
  }

  _getSelectedTokenDocs() {
    const docs = [];
    const seen = new Set();
    const isGM = isGmLike();

    const addDoc = (tokenDoc) => {
      const tokenId = String(tokenDoc?.id || '');
      if (!tokenId || seen.has(tokenId)) return;
      seen.add(tokenId);
      docs.push(tokenDoc);
    };

    try {
      const interactionManager = window.MapShine?.interactionManager;
      if (interactionManager?.selection && interactionManager?.tokenManager?.tokenSprites) {
        for (const id of interactionManager.selection) {
          const tokenDoc = interactionManager.tokenManager.tokenSprites.get(id)?.tokenDoc;
          addDoc(tokenDoc);
        }
      }
    } catch (_) {
    }

    if (docs.length === 0) {
      for (const token of canvas?.tokens?.controlled || []) {
        addDoc(token?.document);
      }
    }

    if (docs.length === 0) {
      const observed = canvas?.tokens?.observed;
      if (Array.isArray(observed)) {
        for (const token of observed) addDoc(token?.document);
      } else {
        addDoc(observed?.document);
      }
    }

    if (!isGM && docs.length === 0) {
      try {
        const user = game?.user;
        const placeables = canvas?.tokens?.placeables || [];
        for (const token of placeables) {
          const doc = token?.document;
          if (!doc) continue;
          let isOwner = token?.isOwner === true || doc?.isOwner === true;
          if (!isOwner && typeof doc?.testUserPermission === 'function' && user) {
            try {
              isOwner = doc.testUserPermission(user, 'OWNER');
            } catch (_) {
              isOwner = false;
            }
          }
          if (isOwner) addDoc(doc);
        }
      } catch (_) {
      }
    }

    return docs;
  }

  _getEffectiveVisionTokens() {
    const tokens = [];
    const seen = new Set();
    const isGM = isGmLike();
    const addToken = (token) => {
      const tokenId = String(token?.document?.id || '');
      if (!tokenId || seen.has(tokenId)) return;
      seen.add(tokenId);
      tokens.push(token);
    };

    try {
      const interactionManager = window.MapShine?.interactionManager;
      const selection = interactionManager?.selection;
      const placeables = canvas?.tokens?.placeables || [];
      if (selection && placeables.length) {
        for (const id of selection) {
          const token = placeables.find((candidate) => candidate?.document?.id === id);
          if (token) addToken(token);
        }
      }
    } catch (_) {
    }

    if (!tokens.length) {
      for (const token of canvas?.tokens?.controlled || []) addToken(token);
    }

    if (!tokens.length) {
      const observed = canvas?.tokens?.observed;
      if (Array.isArray(observed)) {
        for (const token of observed) addToken(token);
      } else {
        addToken(observed);
      }
    }

    if (!isGM && !tokens.length) {
      for (const token of canvas?.tokens?.placeables || []) {
        const doc = token?.document;
        if (!doc) continue;
        let isOwner = token?.isOwner === true || doc?.isOwner === true;
        if (!isOwner && typeof doc?.testUserPermission === 'function') {
          try {
            isOwner = doc.testUserPermission(game.user, 'OWNER');
          } catch (_) {
            isOwner = false;
          }
        }
        if (isOwner) addToken(token);
      }
    }

    if (isGM && !tokens.length) {
      for (const token of canvas?.tokens?.placeables || []) {
        const hasSight = token?.hasSight || token?.document?.sight?.enabled;
        if (hasSight) addToken(token);
      }
    }

    return tokens;
  }

  _getNativeDoorControlVisibility(wallDoc) {
    try {
      const wall = canvas?.walls?.get?.(wallDoc?.id);
      if (!wall?.isDoor) return null;
      if (!wall.doorControl && typeof wall.createDoorControl === 'function') {
        wall.createDoorControl();
      }
      const doorControl = wall.doorControl;
      if (!doorControl) return null;
      if (!('isVisible' in doorControl)) return null;
      return !!doorControl.isVisible;
    } catch (_) {
      return null;
    }
  }

  _isDoorVisibleToSelection(wallDoc) {
    if (!wallDoc?.door) return false;

    if (!this._isWallVisibleAtPerspective(wallDoc)) return false;

    const nativeVisibility = this._getNativeDoorControlVisibility(wallDoc);
    if (nativeVisibility !== null) {
      return nativeVisibility;
    }

    if ((wallDoc.door === CONST.WALL_DOOR_TYPES.SECRET) && !isGmLike()) {
      return false;
    }

    const visionTokens = this._getEffectiveVisionTokens();
    if ((canvas?.scene?.tokenVision ?? false) && !visionTokens.length) {
      return false;
    }

    if (!canvas?.visibility?.tokenVision) {
      return true;
    }

    const coords = wallDoc.c;
    if (!Array.isArray(coords) || coords.length < 4) return false;
    const ray = Ray.fromArrays(coords.slice(0, 2), coords.slice(2, 4));
    const x = (coords[0] + coords[2]) / 2;
    const y = (coords[1] + coords[3]) / 2;
    const dx = -ray.dy;
    const dy = ray.dx;
    const denom = Math.abs(dx) + Math.abs(dy);
    if (!denom) return false;
    const t = 3 / denom;
    const points = [
      { x: x + (t * dx), y: y + (t * dy) },
      { x: x - (t * dx), y: y - (t * dy) }
    ];

    for (const token of visionTokens) {
      try {
        const shape = token?.vision?.los || token?.vision?.shape || token?.vision?.fov;
        if (shape?.contains && points.some((point) => shape.contains(point.x, point.y))) {
          return true;
        }
      } catch (_) {
      }
    }

    try {
      return points.some((point) => canvas.visibility.testVisibility(point, { tolerance: 0 }));
    } catch (_) {
      return isGmLike();
    }
  }

  /**
   * Set explicit visibility for wall lines
   * @param {boolean} visible 
   */
  setVisibility(visible) {
    // Keep wall visuals attached to whichever scene is currently rendered.
    this._ensureWallGroupInActiveRenderScene();

    // Self-heal: if walls loaded after manager init (or scene switched), rebuild now.
    const sceneWallCount = Number(canvas?.walls?.placeables?.length || 0);
    if (sceneWallCount > 0 && this.walls.size === 0) {
      this.syncAllWalls();
    }

    const selectedDocs = this._getSelectedTokenDocs();
    let totalDoors = 0;
    let visibleDoors = 0;
    let wallLinesVisible = 0;

    this.walls.forEach((group, wallId) => {
      const wallDoc = canvas.walls?.get?.(wallId)?.document ?? canvas.scene?.walls?.get?.(wallId) ?? null;
      const inActiveBand = this._isWallVisibleAtPerspective(wallDoc);
      const doorVisible = this._isDoorVisibleToSelection(wallDoc);
      // Keep wall editing handles/segments floor-scoped so Walls tool only shows
      // the current perspective floor's walls.
      const showEditVisuals = !!visible && inActiveBand;
      if (wallDoc?.door) totalDoors += 1;
      if (doorVisible) visibleDoors += 1;

      // Keep wall groups alive in gameplay so Three door controls remain visible
      // and interactive. Only hide wall editing visuals when not on Walls layer.
      group.visible = true;

      for (const child of group.children || []) {
        const type = child?.userData?.type;
        if (!type) continue;

        if (type === 'doorControl') {
          child.visible = doorVisible;
          continue;
        }

        if (type === 'wallLine' || type === 'wallLineBg' || type === 'wallHitbox' || type === 'wallEndpoint' || type === 'wallEndpointOuter') {
          child.visible = showEditVisuals;
          if (type === 'wallLine' && child.visible) wallLinesVisible += 1;
        }
      }
    });

    // Disabled: too spammy
    // log.warn('Three door visibility refresh', {
    //   totalWalls: this.walls.size,
    //   totalDoors,
    //   visibleDoors,
    //   showWallLines: visible,
    //   tokenVision: canvas?.visibility?.tokenVision,
    //   selectedTokenIds: selectedDocs.map((doc) => doc?.id).filter(Boolean)
    // });
  }

  /**
   * Sync all existing walls from the scene
   * @public
   */
  syncAllWalls() {
    if (!canvas.walls) return;

    // If called before canvas dimensions are ready, coordinate transforms can
    // be incorrect and door controls may appear at origin. Bail and allow the
    // initializer retry loop to reschedule.
    const dimsH = Number(canvas?.dimensions?.height);
    if (!Number.isFinite(dimsH) || dimsH <= 0) return;
    
    log.info(`Syncing ${canvas.walls.placeables.length} walls...`);
    let createdDoorControls = 0;
    
    // Clear existing
    this.walls.forEach(wall => {
      this.wallGroup.remove(wall);
    });
    this.walls.clear();
    
    // Add current
    canvas.walls.placeables.forEach(wall => {
      const doorType = wall?.document?.door;
      if (doorType && doorType !== CONST.WALL_DOOR_TYPES.NONE) createdDoorControls += 1;
      this.create(wall.document);
    });

    log.info('Three wall sync complete', {
      totalWalls: canvas.walls.placeables.length,
      createdDoorControls
    });
  }

  /**
   * Create a wall in the THREE.js scene
   * @param {WallDocument} doc - Foundry wall document
   * @param {Object} [dataOverride={}] - Optional data to override document properties (e.g. pending changes)
   */
  create(doc, dataOverride = {}) {
    if (this.walls.has(doc.id)) return;

    const group = new THREE.Group();
    group.userData = { wallId: doc.id };

    // Check if lines should be visible (active layer)
    const showLines = this._shouldShowWallLines();

    // Get Coordinates
    const c = dataOverride.c || doc.c;
    const [x0, y0, x1, y1] = c;
    
    const start = Coordinates.toWorld(x0, y0);
    const end = Coordinates.toWorld(x1, y1);

    // Determine Color based on properties
    const color = this.getWallColor(doc, dataOverride);
    
    // Create Wall Mesh (Thick Line)
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    const lineWidth = Math.max(2, 2 * (canvas?.dimensions?.uiScale || 1));
    const thickness = lineWidth;
    const bgThickness = lineWidth * 3;
    const wallGeo = new THREE.PlaneGeometry(length, thickness);
    const wallBgGeo = new THREE.PlaneGeometry(length, bgThickness);
    const wallBgMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        side: THREE.DoubleSide,
        depthWrite: false
    });
    const wallBg = new THREE.Mesh(wallBgGeo, wallBgMat);
    wallBg.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, -0.01);
    wallBg.rotation.z = angle;
    wallBg.userData = { type: 'wallLineBg' };
    wallBg.visible = showLines;
    wallBg.renderOrder = 9998;
    wallBg.layers.set(OVERLAY_THREE_LAYER);
    wallBg.layers.enable(0);
    group.add(wallBg);
    const wallMat = new THREE.MeshBasicMaterial({ 
        color: color,
        side: THREE.DoubleSide
    });
    
    const wallMesh = new THREE.Mesh(wallGeo, wallMat);
    wallMesh.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, 0);
    wallMesh.rotation.z = angle;
    wallMesh.userData = { type: 'wallLine' };
    wallMesh.visible = showLines;
    wallMesh.renderOrder = 9999;
    wallMesh.layers.set(OVERLAY_THREE_LAYER);
    wallMesh.layers.enable(0);
    group.add(wallMesh);

    // Hitbox (wider invisible mesh for easier selection)
    const hitboxThickness = Math.max(24, lineWidth * 10);
    const hitboxGeo = new THREE.PlaneGeometry(length, hitboxThickness);
    const hitboxMat = new THREE.MeshBasicMaterial({ 
        visible: true,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false
    });
    const hitbox = new THREE.Mesh(hitboxGeo, hitboxMat);
    hitbox.position.copy(wallMesh.position);
    hitbox.rotation.copy(wallMesh.rotation);
    hitbox.userData = { type: 'wallHitbox' };
    hitbox.visible = showLines;
    group.add(hitbox);

    // Create Endpoints (black ring + colored center), matching Foundry's handle style.
    const endpointOuterRadius = Math.max(5, lineWidth * 3);
    const endpointInnerRadius = Math.max(2.5, endpointOuterRadius - lineWidth);
    const endpointOuterGeometry = new THREE.CircleGeometry(endpointOuterRadius, 20);
    const endpointInnerGeometry = new THREE.CircleGeometry(endpointInnerRadius, 20);
    const outerDotMat = new THREE.MeshBasicMaterial({ color: 0x000000, depthWrite: false });
    const innerDotMat = new THREE.MeshBasicMaterial({ color: color, depthWrite: false });
    
    const p0Outer = new THREE.Mesh(endpointOuterGeometry, outerDotMat);
    p0Outer.position.set(start.x, start.y, -0.005);
    p0Outer.userData = { type: 'wallEndpointOuter', wallId: doc.id, index: 0 };
    p0Outer.visible = showLines;
    p0Outer.renderOrder = 10000;
    p0Outer.layers.set(OVERLAY_THREE_LAYER);
    p0Outer.layers.enable(0);
    group.add(p0Outer);

    const p0 = new THREE.Mesh(endpointInnerGeometry, innerDotMat);
    p0.position.set(start.x, start.y, 0);
    p0.userData = { type: 'wallEndpoint', wallId: doc.id, index: 0 };
    p0.visible = showLines;
    p0.renderOrder = 10000;
    p0.layers.set(OVERLAY_THREE_LAYER);
    p0.layers.enable(0);
    group.add(p0);
    
    const p1Outer = new THREE.Mesh(endpointOuterGeometry, outerDotMat);
    p1Outer.position.set(end.x, end.y, -0.005);
    p1Outer.userData = { type: 'wallEndpointOuter', wallId: doc.id, index: 1 };
    p1Outer.visible = showLines;
    p1Outer.renderOrder = 10000;
    p1Outer.layers.set(OVERLAY_THREE_LAYER);
    p1Outer.layers.enable(0);
    group.add(p1Outer);

    const p1 = new THREE.Mesh(endpointInnerGeometry, innerDotMat);
    p1.position.set(end.x, end.y, 0);
    p1.userData = { type: 'wallEndpoint', wallId: doc.id, index: 1 };
    p1.visible = showLines;
    p1.renderOrder = 10000;
    p1.layers.set(OVERLAY_THREE_LAYER);
    p1.layers.enable(0);
    group.add(p1);

    const door = dataOverride.door !== undefined ? dataOverride.door : doc.door;
    if (door) {
      this.createDoorControl(group, doc, start, end, dataOverride);
    }

    this.wallGroup.add(group);
    this.walls.set(doc.id, group);
    
    log.debug(`Rendered wall ${doc.id}`);
  }

  /**
   * Create Door Control Icon
   * @param {THREE.Group} group 
   * @param {WallDocument} doc 
   * @param {THREE.Vector3} start 
   * @param {THREE.Vector3} end 
   * @param {Object} [dataOverride={}]
   */
  createDoorControl(group, doc, start, end, dataOverride = {}) {
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      
      // Door Group
      const doorGroup = new THREE.Group();
      doorGroup.position.set(midX, midY, 4.0); // Keep icon above wall/door planes
      doorGroup.userData = { type: 'doorControl', wallId: doc.id };

      log.info(`Creating Three door control for wall ${doc.id}`, {
        door: dataOverride.door !== undefined ? dataOverride.door : doc.door,
        ds: dataOverride.ds !== undefined ? dataOverride.ds : doc.ds,
        midX,
        midY,
        wallGroupZ: this.wallGroup.position.z
      });

      // Keep door controls visually enabled. If this is false, meshes still
      // exist for interaction but render no visible pixels, making doors look
      // "missing" in Three even when the control geometry is present.
      const showVisuals = true;
      
      const size = 40 * (canvas.dimensions.uiScale || 1);
      
      // Icon Sprite
      const iconPath = this.getDoorIconPath(doc, dataOverride);
      // Debug state
      const ds = dataOverride.ds !== undefined ? dataOverride.ds : doc.ds;
      log.debug(`Wall ${doc.id} Door State: ${ds} (${typeof ds}), Icon: ${iconPath}`);

      const loader = new THREE.TextureLoader();
      
      // Requested: icons are twice as large as before (previously size * 0.7).
      const iconSize = size * 1.4;
      const iconGeo = new THREE.PlaneGeometry(iconSize, iconSize);
      const iconMat = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: showVisuals ? 1.0 : 0.0,
          color: 0xffffff,
          depthWrite: false,
          depthTest: false
      });
      iconMat.colorWrite = showVisuals;
      
      if (showVisuals) {
        loader.load(iconPath, (tex) => {
            if (THREE.SRGBColorSpace) {
              try {
                tex.colorSpace = THREE.SRGBColorSpace;
              } catch (_) {}
            }
            tex.anisotropy = 4;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = true;
            iconMat.map = tex;
            iconMat.needsUpdate = true;
            doorGroup.userData._lastDoorIconPath = iconPath;
        });
      }
      
      const icon = new THREE.Mesh(iconGeo, iconMat);
      icon.position.z = 2.0;
      // DoorMeshManager uses renderOrder 250000. Keep controls above that.
      icon.renderOrder = 260000;
      // Visual icon renders in the late overlay pass so it appears above
      // fog/post-processing. Keep interaction separate via an invisible hit area.
      icon.layers.set(OVERLAY_THREE_LAYER);
      doorGroup.add(icon);

      // Keep left/right click interaction in the world pass (layer 0) while
      // drawing visuals in the late overlay layer.
      const hitGeo = new THREE.PlaneGeometry(iconSize, iconSize);
      const hitMat = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide
      });
      hitMat.colorWrite = false;
      const hitArea = new THREE.Mesh(hitGeo, hitMat);
      hitArea.position.z = 1.5;
      hitArea.renderOrder = 259999;
      hitArea.userData = { type: 'doorHitArea', wallId: doc.id };
      doorGroup.add(hitArea);

      // Store references for updates
      doorGroup.userData.icon = icon;
      
      group.add(doorGroup);
  }

  /**
   * Get the correct icon path for the door state
   * @param {WallDocument} doc 
   * @param {Object} [dataOverride={}]
   * @returns {string}
   */
  getDoorIconPath(doc, dataOverride = {}) {
      const ds = dataOverride.ds !== undefined ? dataOverride.ds : doc.ds; // 0=CLOSED, 1=OPEN, 2=LOCKED
      const type = dataOverride.door !== undefined ? dataOverride.door : doc.door; // 1=DOOR, 2=SECRET
      
      // Config defaults
      const icons = CONFIG.controlIcons;
      
      if (type === 2 && ds === 0) { // Secret & Closed
          return icons.doorSecret;
      }
      
      if (ds === 2) return icons.doorLocked;
      if (ds === 1) return icons.doorOpen;
      return icons.doorClosed;
  }

  /**
   * Determine wall color based on type
   * @param {WallDocument} doc 
   * @param {Object} [dataOverride={}]
   * @returns {number} Hex color
   */
  getWallColor(doc, dataOverride = {}) {
      // Logic based on Foundry's Wall class
      const door = dataOverride.door !== undefined ? dataOverride.door : doc.door;
      const move = dataOverride.move !== undefined ? dataOverride.move : doc.move;
      const sight = dataOverride.sight !== undefined ? dataOverride.sight : doc.sight;

      if (door === 1) return WALL_COLORS.DOOR;
      if (door === 2) return WALL_COLORS.SECRET;
      
      // Sense types: 0=NONE, 10=LIMITED, 20=NORMAL (approx consts)
      
      if (move === 0) return WALL_COLORS.ETHEREAL; // Passable
      if (sight === 0) return WALL_COLORS.INVISIBLE; // See-through
      if (sight === 10 || move === 10) return WALL_COLORS.TERRAIN; // Terrain
      
      return WALL_COLORS.NORMAL;
  }

  /**
   * Door open/close/lock only changes `ds`. Wall line color (getWallColor) does not
   * depend on `ds`, so rebuilding every PlaneGeometry + material forces shader
   * recompilation and texture reload — a major frame spike (see profiler:
   * getProgramInfoLog + texSubImage2D). Update only the door icon texture.
   *
   * @param {THREE.Group} group
   * @param {WallDocument} doc
   * @param {Object} changes
   * @returns {boolean} true if handled
   * @private
   */
  _refreshDoorIconOnly(group, doc, changes) {
    const doorGroup = group?.children?.find((c) => c?.userData?.type === 'doorControl');
    if (!doorGroup) return false;
    const icon = doorGroup.userData?.icon;
    const mat = icon?.material;
    if (!mat) return false;

    const iconPath = this.getDoorIconPath(doc, flattenWallUpdateChanges(changes));
    if (doorGroup.userData._lastDoorIconPath === iconPath) return true;

    doorGroup.userData._lastDoorIconPath = iconPath;
    const prevMap = mat.map || null;
    const loader = new THREE.TextureLoader();
    loader.load(
      iconPath,
      (tex) => {
        if (THREE.SRGBColorSpace) {
          try {
            tex.colorSpace = THREE.SRGBColorSpace;
          } catch (_) {}
        }
        tex.anisotropy = 4;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        if (prevMap && prevMap !== tex) {
          try {
            prevMap.dispose();
          } catch (_) {}
        }
        mat.map = tex;
        mat.needsUpdate = true;
      },
      undefined,
      () => {
        doorGroup.userData._lastDoorIconPath = '';
      }
    );
    return true;
  }

  /**
   * True when `changes` includes a door state update but nothing that affects
   * wall segment geometry, door type, or pass/sight/light/sound channels.
   * Foundry often adds unrelated keys (flags, etc.) — those must not block the fast path.
   *
   * @param {Object} changes
   * @returns {boolean}
   * @private
   */
  _isDoorStateOnlyWallChange(changes) {
    if (!changes || typeof changes !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(changes, 'ds')) return false;
    const geomKeys = ['c', 'door', 'move', 'sight', 'light', 'sound'];
    return !geomKeys.some((k) => Object.prototype.hasOwnProperty.call(changes, k));
  }

  /**
   * Update an existing wall
   * @param {WallDocument} doc - Foundry wall document
   * @param {Object} changes - Changed data
   */
  update(doc, changes) {
    log.debug(`WallManager.update called for ${doc.id}`, changes);

    const wallMapKey = doc?.id != null ? doc.id : null;
    let wallGroup = null;
    if (wallMapKey != null) {
      wallGroup = this.walls.get(wallMapKey);
      if (!wallGroup && typeof wallMapKey !== 'string') {
        wallGroup = this.walls.get(String(wallMapKey));
      }
    }

    if (isWallDoorStateOnlyUpdate(changes) && wallGroup) {
      if (this._refreshDoorIconOnly(wallGroup, doc, changes)) {
        if (!window.MapShine?.__debugSkipWallManagerUpdateLightingRefresh) {
          this._requestLightingRefresh();
        }
        return;
      }
    }

    // Rebuild geometry if coordinates, type, or state changed
    // Check for undefined because 0 is a valid value for ds, move, sight
    const shouldUpdate = 
      changes.c || 
      changes.door !== undefined || 
      changes.ds !== undefined || 
      changes.move !== undefined || 
      changes.sight !== undefined || 
      changes.light !== undefined || 
      changes.sound !== undefined;

    if (shouldUpdate) {
      log.debug(`WallManager.update: Recreating wall ${doc.id}`);
      this.remove(doc.id);
      this.create(doc, changes);
      if (!window.MapShine?.__debugSkipWallManagerUpdateLightingRefresh) {
        this._requestLightingRefresh();
      }
    } else {
      log.debug(`WallManager.update: Update skipped for ${doc.id} (no relevant changes)`);
    }
  }

  /**
   * Highlight a wall
   * @param {string} id 
   * @param {boolean} active 
   */
  setHighlight(id, active) {
      const group = this.walls.get(id);
      if (!group) return;
      
      // If active is false, but it is selected, keep it active (highlighted)
      const shouldBeHighlighted = active || this.selected.has(id);

      const line = group.children.find(c => c.userData.type === 'wallLine');
      if (line) {
          if (shouldBeHighlighted) {
             line.material.color.setHex(0xff9829); // Orange highlight
          } else {
             const doc = canvas.walls.get(id)?.document;
             if (doc) {
                 line.material.color.setHex(this.getWallColor(doc));
             }
          }
          line.material.needsUpdate = true;
      }

      const lineBg = group.children.find(c => c.userData.type === 'wallLineBg');
      if (lineBg?.material?.color) {
        lineBg.material.color.setHex(0x000000);
        lineBg.material.needsUpdate = true;
      }
      
      // Highlight endpoint center fill while preserving black outer ring.
      group.children.forEach(c => {
          if (c.userData.type === 'wallEndpoint') {
              c.material.color.setHex(shouldBeHighlighted ? 0xff9829 : this.getWallColor(canvas.walls.get(id).document));
              c.material.needsUpdate = true;
          }
      });
  }

  /**
   * Select a wall
   * @param {string} id 
   * @param {boolean} active 
   */
  select(id, active) {
    if (active) {
      this.selected.add(id);
    } else {
      this.selected.delete(id);
    }
    // Re-evaluate highlight state
    this.setHighlight(id, false); // False here means "check selection state" basically
  }

  /**
   * Remove a wall
   * @param {string} id - Wall ID
   */
  remove(id) {
    const group = this.walls.get(id);
    if (group) {
      this.wallGroup.remove(group);
      
      // Cleanup geometry/material to prevent leaks
      group.traverse(obj => {
          if (obj.geometry && obj.geometry !== this.endpointGeometry) obj.geometry.dispose();
          if (obj.material) obj.material.dispose();
      });
      
      this.walls.delete(id);
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    // Unregister Foundry hooks using correct two-argument signature
    try {
      if (this._hookIds && this._hookIds.length) {
        for (const [hookName, hookId] of this._hookIds) {
          try {
            Hooks.off(hookName, hookId);
          } catch (e) {
          }
        }
      }
    } catch (e) {
    }
    this._hookIds = [];
    
    this.walls.forEach((group, id) => this.remove(id));
    this.walls.clear();
    this.scene.remove(this.wallGroup);
    if (this.endpointGeometry) this.endpointGeometry.dispose();
    log.debug('WallManager disposed');
  }
}
