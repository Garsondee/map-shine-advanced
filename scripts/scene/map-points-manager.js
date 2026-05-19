/**
 * @fileoverview Map Points Manager - Manages point groups for effects
 * Provides backwards compatibility with v1.x map-shine flag data
 * @module scene/map-points-manager
 */
import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { extendMsaLocalFlagWriteGuard } from '../utils/msa-local-flag-guard.js';
import { OVERLAY_THREE_LAYER } from '../core/render-layers.js';
import {
  recomputeControlClusters,
  buildGroupIdToClusterIdMap,
} from './map-point-control-clusters.js';

const log = createLogger('MapPointsManager');

/** Module ID for flag access (current module) */
const MODULE_ID = 'map-shine-advanced';

/** Legacy module ID for v1.x backwards compatibility */
const LEGACY_MODULE_ID = 'map-shine';

/** Current data version for migration tracking */
const CURRENT_VERSION = 2;

/** Default level-binding mode for legacy/backward-compatible map point groups. */
const DEFAULT_LEVEL_BINDING_MODE = 'all-levels';

/**
 * Effect target options - maps effect keys to display names
 * Must remain backwards compatible with v1.x
 */
export const EFFECT_SOURCE_OPTIONS = {
  '': 'None',
  sparks: 'Sparks',
  fire: 'Fire Particles',
  candleFlame: 'Candle Flame',
  dust: 'Dust Motes',
  smellyFlies: 'Smelly Flies',
  lightning: 'Lightning',
  cloudShadows: 'Cloud Shadows',
  canopy: 'Canopy Shadows',
  structuralShadows: 'Structural Shadows',
  water: 'Water Surface',
  pressurisedSteam: 'Pressurised Steam'
};

/**
 * @typedef {Object} MapPoint
 * @property {number} x - X coordinate in scene space
 * @property {number} y - Y coordinate in scene space
 */

/**
 * @typedef {Object} EmissionSettings
 * @property {number} intensity - Emission intensity (0-1)
 * @property {Object} falloff - Falloff settings
 * @property {boolean} falloff.enabled - Whether falloff is enabled
 * @property {number} falloff.strength - Falloff strength
 */

/**
 * @typedef {Object} LevelBinding
 * @property {'locked'|'all-levels'} mode - Whether this group is level-locked or globally visible
 * @property {number|null} bottom - Inclusive bottom elevation when mode='locked'
 * @property {number|null} top - Inclusive top elevation when mode='locked'
 * @property {string|null} floorKey - Optional stable floor identifier
 */

/**
 * @typedef {Object} MapPointMetadata
 * @property {LevelBinding} levelBinding - Level ownership/visibility contract
 */

/**
 * @typedef {Object} MapPointGroup
 * @property {string} id - Unique identifier
 * @property {string} label - Display name
 * @property {'point'|'line'|'area'|'rope'} type - Group type
 * @property {MapPoint[]} points - Array of points
 * @property {boolean} isBroken - Validation state
 * @property {string} reason - Validation message
 * @property {boolean} isEffectSource - Whether this group drives an effect
 * @property {string} effectTarget - Effect key (e.g., 'lightning', 'candleFlame')
 * @property {EmissionSettings} emission - Emission settings
 * @property {number} [version] - Data version for migration
 * @property {MapPointMetadata} [metadata] - Additional metadata (includes level-binding)
 * @property {string} [ropeType] - Rope preset type (for rope groups)
 * @property {string} [texturePath] - Custom texture path (for rope groups)
 * @property {number} [segmentLength] - Rope segment length
 */

/**
 * @typedef {Object} AreaPolygon
 * @property {string} groupId - Parent group ID
 * @property {MapPoint[]} points - Polygon vertices
 * @property {EmissionSettings} emission - Emission settings
 * @property {{minX: number, minY: number, maxX: number, maxY: number}} bounds - Bounding box
 */

/**
 * @typedef {Object} AreaBounds
 * @property {number} minX - Minimum X coordinate
 * @property {number} minY - Minimum Y coordinate
 * @property {number} maxX - Maximum X coordinate
 * @property {number} maxY - Maximum Y coordinate
 * @property {number} centerX - Center X coordinate
 * @property {number} centerY - Center Y coordinate
 * @property {number} width - Width of bounds
 * @property {number} height - Height of bounds
 */

/**
 * MapPointsManager - Manages map point groups for the Three.js rendering system
 * Provides backwards compatibility with v1.x data stored in scene flags
 */
export class MapPointsManager {
  /**
   * @param {THREE.Scene} scene - Three.js scene to add visual elements to
   */
  constructor(scene) {
    /** @type {THREE.Scene} */
    this.scene = scene;
    
    /** @type {Map<string, MapPointGroup>} */
    this.groups = new Map();
    
    /** @type {Map<string, THREE.Object3D>} */
    this.visualObjects = new Map();
    
    /** @type {boolean} */
    this.initialized = false;
    
    /** @type {boolean} */
    /** When true, on-map handles/lines for existing groups are shown (Manage Map Points → "Show visual helpers"). */
    this.showVisualHelpers = false;

    /** When true, GM effect-cluster toggle HUD is shown on the canvas. */
    this.showControlHud = false;

    /** @type {Map<string, import('./map-point-control-clusters.js').MapPointControlCluster>} */
    this.controlClusters = new Map();

    /** @type {Map<string, string>} groupId -> clusterId */
    this._groupIdToClusterId = new Map();

    /** @type {Map<string, THREE.Object3D>} */
    this.controlHudObjects = new Map();

    /** @type {THREE.Group|null} */
    this.controlHudGroup = null;

    /** @type {ReturnType<typeof setTimeout>|null} */
    this._recomputeClustersTimer = null;
    
    /** @type {Function[]} */
    this.changeListeners = [];

    /** @type {Promise<void>} */
    this._opChain = Promise.resolve();

    /** @type {Array<{hook: string, fn: Function}>} */
    this._hookRegistrations = [];

    this._idCounter = 0;

    /** While > now, `updateScene` hook skips loadFromScene (avoids double-reload from our own setFlag echoes). */
    this._suppressLoadFromSceneUntil = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._suppressLoadFromSceneTimer = null;

    log.debug('MapPointsManager created');
  }

  _enqueueOp(fn) {
    this._opChain = this._opChain.catch(() => {}).then(() => fn());
    return this._opChain;
  }

  _canEditScene() {
    const scene = canvas?.scene;
    const user = game?.user;
    if (!scene || !user) return false;
    if (user.isGM) return true;
    try {
      if (typeof scene.canUserModify === 'function') return scene.canUserModify(user, 'update');
    } catch (_) {
      return false;
    }
    return false;
  }

  /**
   * @returns {LevelBinding}
   * @private
   */
  _getDefaultLevelBinding() {
    return {
      mode: DEFAULT_LEVEL_BINDING_MODE,
      bottom: null,
      top: null,
      floorKey: null,
    };
  }

  /**
   * Normalize level-binding payload into a stable, serializable shape.
   * Legacy groups default to mode='all-levels' to preserve existing behavior.
   * @param {any} raw
   * @returns {LevelBinding}
   * @private
   */
  _normalizeLevelBinding(raw) {
    const fallback = this._getDefaultLevelBinding();
    if (!raw || typeof raw !== 'object') return fallback;

    const mode = (raw.mode === 'locked' || raw.mode === 'all-levels')
      ? raw.mode
      : fallback.mode;
    const bottom = Number.isFinite(raw.bottom) ? Number(raw.bottom) : null;
    const top = Number.isFinite(raw.top) ? Number(raw.top) : null;
    const floorKey = (typeof raw.floorKey === 'string' && raw.floorKey.length > 0)
      ? raw.floorKey
      : null;

    return { mode, bottom, top, floorKey };
  }

  /**
   * @param {any} metadata
   * @returns {MapPointMetadata}
   * @private
   */
  _normalizeMetadata(metadata) {
    const normalized = (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
      ? { ...metadata }
      : {};
    normalized.levelBinding = this._normalizeLevelBinding(normalized.levelBinding);
    return normalized;
  }

  /**
   * @param {any} metadata
   * @returns {boolean}
   * @private
   */
  _requiresLevelBindingMigration(metadata) {
    const lb = metadata?.levelBinding;
    if (!lb || typeof lb !== 'object') return true;
    if (lb.mode !== 'locked' && lb.mode !== 'all-levels') return true;
    if (lb.bottom !== null && !Number.isFinite(lb.bottom)) return true;
    if (lb.top !== null && !Number.isFinite(lb.top)) return true;
    if (lb.floorKey !== null && typeof lb.floorKey !== 'string') return true;
    return false;
  }

  /**
   * Build normalized metadata using the provided level context.
   * When no valid context exists, falls back to all-levels behavior.
   * @param {any} context
   * @returns {MapPointMetadata}
   */
  buildMetadataFromLevelContext(context = null) {
    const ctx = context ?? window.MapShine?.activeLevelContext ?? null;
    const bottom = Number(ctx?.bottom);
    const top = Number(ctx?.top);
    const hasRange = Number.isFinite(bottom) && Number.isFinite(top);
    const floorKey = (typeof ctx?.levelId === 'string' && ctx.levelId.length > 0)
      ? ctx.levelId
      : null;

    const levelBinding = hasRange
      ? {
          mode: 'locked',
          bottom: Math.min(bottom, top),
          top: Math.max(bottom, top),
          floorKey,
        }
      : this._getDefaultLevelBinding();

    return this._normalizeMetadata({ levelBinding });
  }

  /**
   * @param {MapPointGroup} group
   * @param {any} context
   * @returns {boolean}
   * @private
   */
  _groupMatchesLevelContext(group, context = null) {
    if (!group || typeof group !== 'object') return false;

    const ctx = context ?? window.MapShine?.activeLevelContext ?? null;
    if (!ctx) return true;
    // Single-level/no-level scenes should keep legacy behavior.
    if ((ctx.count ?? 0) <= 1) return true;

    const binding = this._normalizeLevelBinding(group?.metadata?.levelBinding);
    if (binding.mode !== 'locked') return true;

    const ctxLevelId = (typeof ctx?.levelId === 'string' && ctx.levelId.length > 0) ? ctx.levelId : null;
    if (binding.floorKey && ctxLevelId) {
      return binding.floorKey === ctxLevelId;
    }

    const b0 = Number(binding.bottom);
    const t0 = Number(binding.top);
    const b1 = Number(ctx?.bottom);
    const t1 = Number(ctx?.top);
    if (Number.isFinite(b0) && Number.isFinite(t0) && Number.isFinite(b1) && Number.isFinite(t1)) {
      const min0 = Math.min(b0, t0);
      const max0 = Math.max(b0, t0);
      const min1 = Math.min(b1, t1);
      const max1 = Math.max(b1, t1);
      return !(max0 < min1 || min0 > max1);
    }

    return true;
  }

  /**
   * Initialize the manager and load groups from scene flags
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      log.warn('MapPointsManager already initialized');
      return;
    }

    // Load groups from scene flags
    await this.loadFromScene();
    
    // Register Foundry hooks for updates
    this.setupHooks();
    
    this.initialized = true;
    log.info(`MapPointsManager initialized with ${this.groups.size} groups`);
  }

  /**
   * Load map point groups from the current scene's flags
   * Handles migration from v1.x format if needed
   * Checks both current and legacy module namespaces for backwards compatibility
   * @private
   */
  async loadFromScene() {
    return this._enqueueOp(async () => {
      const scene = canvas?.scene;
      if (!scene) {
        log.warn('No active scene, skipping map points load');
        this.groups.clear();
        this.clearVisualObjects();
        return;
      }

      let v2Initialized = false;
      try {
        const initFlag = scene.getFlag(MODULE_ID, 'mapPointGroupsInitialized');
        v2Initialized = Boolean(initFlag);
      } catch (_) {
        v2Initialized = false;
      }

      let groupsData = null;
      let fromLegacy = false;

      try {
        groupsData = scene.getFlag(MODULE_ID, 'mapPointGroups');
      } catch (e) {
        log.debug('Current module flag namespace not available');
      }

      if (!groupsData && v2Initialized) {
        groupsData = {};
      }

      if (!groupsData && !v2Initialized) {
        try {
          groupsData = scene.getFlag(LEGACY_MODULE_ID, 'mapPointGroups');
        } catch (e) {
          groupsData = scene?.flags?.[LEGACY_MODULE_ID]?.mapPointGroups;
        }

        if (groupsData) {
          fromLegacy = true;
          log.info('Found map point groups in legacy namespace, will migrate');
        }
      }

      log.debug(`Loading map points: v2Initialized=${v2Initialized}, source=${fromLegacy ? 'legacy' : 'current'}`);

      const prevShowHelpers = this.showVisualHelpers;
      const prevShowControlHud = this.showControlHud;
      this.groups.clear();
      this.clearVisualObjects();
      this._loadControlClustersFromScene(scene);

      if (!groupsData || typeof groupsData !== 'object') {
        log.debug('No map point groups found in scene flags');
        return;
      }

      const utils = globalThis.foundry?.utils;
      const raw = typeof utils?.deepClone === 'function' ? utils.deepClone(groupsData) : groupsData;

      let needsMigration = false;

      for (const [id, group] of Object.entries(raw)) {
        if (!group || typeof group !== 'object') {
          needsMigration = true;
          continue;
        }

        const migratedGroup = this.migrateGroup(group);
        migratedGroup.id = id;
        migratedGroup.metadata = this._normalizeMetadata(migratedGroup.metadata);

        if (!Array.isArray(migratedGroup.points)) migratedGroup.points = [];
        migratedGroup.points = migratedGroup.points
          .filter(p => p && typeof p === 'object')
          .map(p => ({ x: Number(p.x), y: Number(p.y) }))
          .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
          // Legacy Map Shine (v1.x) stored points in Foundry coordinates (Y-down).
          // Map Shine Advanced stores points in world coordinates (Y-up).
          // If we don't convert here, legacy points appear vertically mirrored.
          .map(p => {
            if (!fromLegacy) return p;
            const wp = Coordinates.toWorld(p.x, p.y);
            return { x: wp.x, y: wp.y };
          });

        if (migratedGroup.version !== (group.version ?? 0)) needsMigration = true;
        if (this._requiresLevelBindingMigration(group.metadata)) needsMigration = true;
        if (!migratedGroup.type || !['point', 'line', 'area', 'rope'].includes(migratedGroup.type)) {
          migratedGroup.type = 'point';
          needsMigration = true;
        }
        if (typeof migratedGroup.label !== 'string') {
          migratedGroup.label = String(migratedGroup.label ?? 'New Group');
          needsMigration = true;
        }

        this.groups.set(id, migratedGroup);
      }

      if (needsMigration || fromLegacy) {
        log.info(`Migrating map point groups to v2 format${fromLegacy ? ' (from legacy namespace)' : ''}`);
        await this._saveToSceneNow();
      }

      this._recomputeControlClusters(false);

      if (prevShowHelpers) {
        const editingGroupId = window.MapShine?.interactionManager?.mapPointDraw?.editingGroupId;
        for (const [id, group] of this.groups) {
          if (editingGroupId && id === editingGroupId) continue;
          this.createVisualHelper(id, group);
        }
      }

      if (prevShowControlHud && game.user?.isGM) {
        this.showControlHud = true;
        this._refreshControlHud();
      }

      log.info(`Loaded ${this.groups.size} map point groups from scene${fromLegacy ? ' (from legacy)' : ''}`);
    });
  }

  /**
   * Migrate a group from v1.x format to v2 format
   * @param {Object} group - Group data (possibly v1.x format)
   * @returns {MapPointGroup} Migrated group
   * @private
   */
  migrateGroup(group) {
    if (!group || typeof group !== 'object') {
      return {
        id: foundry.utils.randomID(),
        label: 'New Group',
        type: 'point',
        points: [],
        isBroken: false,
        reason: '',
        isEffectSource: false,
        effectTarget: '',
        emission: {
          intensity: 1.0,
          falloff: { enabled: false, strength: 0.5 }
        },
        version: CURRENT_VERSION,
        metadata: this._normalizeMetadata({})
      };
    }

    // Already v2+
    if ((group.version ?? 0) >= CURRENT_VERSION) {
      return {
        ...group,
        metadata: this._normalizeMetadata(group.metadata),
      };
    }

    // v1.x -> v2 migration
    return {
      // Preserve all existing properties
      ...group,
      
      // Add version tracking
      version: CURRENT_VERSION,
      
      // Add metadata container for future use
      metadata: this._normalizeMetadata(group.metadata || {}),
      
      // Ensure emission settings exist with defaults
      emission: group.emission || {
        intensity: 1.0,
        falloff: { enabled: false, strength: 0.5 }
      },
      
      // Ensure validation state exists
      isBroken: group.isBroken ?? false,
      reason: group.reason || '',
      
      // Ensure effect source settings exist
      isEffectSource: group.isEffectSource ?? false,
      effectTarget: group.effectTarget || ''
    };
  }

  /**
   * Save current groups to scene flags
   * @private
   */
  async saveToScene() {
    return this._enqueueOp(() => this._saveToSceneNow());
  }

  /**
   * Arm guards so scene flag persistence does not trigger a full canvas teardown.
   * Shared by map point groups and control-cluster writes.
   * @param {{ logLabel?: string, payloadKeys?: string[] }} [options]
   * @private
   */
  _armMapPointPersistGuards(options = {}) {
    if (this._suppressLoadFromSceneTimer) {
      try { clearTimeout(this._suppressLoadFromSceneTimer); } catch (_) {}
      this._suppressLoadFromSceneTimer = null;
    }
    this._suppressLoadFromSceneUntil = performance.now() + 15000;

    try {
      if (typeof window !== 'undefined') {
        if (!window.MapShine) window.MapShine = {};
        window.MapShine.__msaMapPointWriteUntil = performance.now() + 12000;
        window.MapShine.__msaMapPointWriteStarted = performance.now();
      }
    } catch (_) {}

    if (options.logLabel) {
      try {
        const scene = canvas?.scene;
        // eslint-disable-next-line no-console
        console.warn(`[MSA-MAP-POINT-SAVE] ${options.logLabel} — strong guard armed for 12s`, {
          sceneId: scene?.id ?? null,
          payloadKeys: options.payloadKeys ?? [],
          canvasSceneId: canvas?.scene?.id ?? null,
          lastResolvedSceneId: window?.MapShine?.__msaLastResolvedSceneId ?? null,
        });
      } catch (_) {}
    }

    extendMsaLocalFlagWriteGuard(20000, 20000);
  }

  /**
   * @private
   */
  _scheduleClearMapPointPersistGuards() {
    this._suppressLoadFromSceneTimer = setTimeout(() => {
      this._suppressLoadFromSceneTimer = null;
      this._suppressLoadFromSceneUntil = 0;
    }, 2500);
  }

  async _saveToSceneNow() {
    const scene = canvas?.scene;
    if (!scene) {
      log.warn('No active scene, cannot save map points');
      return false;
    }

    if (!this._canEditScene()) {
      ui?.notifications?.warn?.('You do not have permission to modify map points on this scene.');
      return false;
    }

    const groupsData = {};
    for (const [id, group] of this.groups) {
      if (!group || typeof group !== 'object') continue;
      groupsData[id] = { ...group, id };
    }

    // Foundry merges object flag updates instead of replacing the whole object (see wiki
    // "Some details about setFlag and objects"). Omitting a group id from `groupsData`
    // would NOT remove it from persisted data — use `-=groupId` so deletions stick.
    let prevRaw = null;
    try {
      prevRaw = scene.getFlag(MODULE_ID, 'mapPointGroups');
    } catch (_) {
      prevRaw = null;
    }
    const prevIds = (prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw))
      ? Object.keys(prevRaw)
      : [];
    const nextIds = new Set(Object.keys(groupsData));
    const flagPayload = { ...groupsData };
    for (const id of prevIds) {
      if (!nextIds.has(id)) flagPayload[`-=${id}`] = null;
    }

    try {
      // Same-scene flag writes redraw Foundry's canvas; arm guards so tearDown does not
      // show the scene-switch loading overlay (see _armMapPointPersistGuards).
      this._armMapPointPersistGuards({
        logLabel: 'starting scene.update (groups)',
        payloadKeys: Object.keys(flagPayload || {}),
      });
      await scene.update({
        [`flags.${MODULE_ID}.mapPointGroups`]: flagPayload,
        [`flags.${MODULE_ID}.mapPointGroupsInitialized`]: true,
      });
      log.debug('Map point groups saved to scene');
      return true;
    } catch (e) {
      log.error('Failed to save map point groups to scene:', e);
      ui?.notifications?.error?.('Failed to save map points to the scene. See console for details.');
      return false;
    } finally {
      this._scheduleClearMapPointPersistGuards();
    }
  }

  /**
   * Setup Foundry hooks for reactive updates
   * @private
   */
  setupHooks() {
    const updateSceneHandler = async (scene, changes) => {
      const activeId = canvas?.scene?.id ?? game?.scenes?.viewed?.id ?? game?.scenes?.current?.id;
      if (!activeId || String(scene.id) !== String(activeId)) return;

      const currentUpdated = changes.flags?.[MODULE_ID]?.mapPointGroups !== undefined;
      const legacyUpdated = changes.flags?.[LEGACY_MODULE_ID]?.mapPointGroups !== undefined;
      const clustersUpdated = changes.flags?.[MODULE_ID]?.mapPointControlClusters !== undefined;

      if (currentUpdated || legacyUpdated) {
        if (performance.now() < (this._suppressLoadFromSceneUntil || 0)) {
          log.debug('Map point groups: skipping loadFromScene during local persistence');
          return;
        }
        log.debug('Map point groups updated via scene flag');
        await this.loadFromScene();
        this.notifyListeners();
        return;
      }

      if (clustersUpdated) {
        if (performance.now() < (this._suppressLoadFromSceneUntil || 0)) {
          log.debug('Map point control clusters: skipping hook during local persistence');
          return;
        }
        log.debug('Map point control clusters updated via scene flag');
        this._loadControlClustersFromScene(scene);
        this._rebuildGroupIdToClusterIdMap();
        this._refreshControlHud();
        this.notifyListeners();
      }
    };

    Hooks.on('updateScene', updateSceneHandler);
    this._hookRegistrations.push({ hook: 'updateScene', fn: updateSceneHandler });

    const canvasReadyHandler = async () => {
      await this.loadFromScene();
      this.notifyListeners();
    };

    Hooks.on('canvasReady', canvasReadyHandler);
    this._hookRegistrations.push({ hook: 'canvasReady', fn: canvasReadyHandler });
  }

  /**
   * Get all groups
   * @returns {Map<string, MapPointGroup>}
   */
  getGroups() {
    return this.groups;
  }

  /**
   * Get a specific group by ID
   * @param {string} id - Group ID
   * @returns {MapPointGroup|undefined}
   */
  getGroup(id) {
    return this.groups.get(id);
  }

  /**
   * Get all groups that target a specific effect
   * @param {string} effectTarget - Effect key (e.g., 'fire', 'lightning')
   * @returns {MapPointGroup[]}
   */
  getGroupsByEffect(effectTarget) {
    const result = [];
    for (const group of this.groups.values()) {
      if (group.isEffectSource && group.effectTarget === effectTarget && this._isGroupClusterEnabled(group.id)) {
        result.push(group);
      }
    }
    return result;
  }

  /**
   * Get effect-source groups that match the active/provided level context.
   * @param {string} effectTarget - Effect key (e.g., 'lightning')
   * @param {any} [context=null] - Optional level context override
   * @returns {MapPointGroup[]}
   */
  getGroupsByEffectForContext(effectTarget, context = null) {
    const groups = this.getGroupsByEffect(effectTarget);
    return groups.filter((group) => this._groupMatchesLevelContext(group, context));
  }

  /**
   * Get all points for a specific effect, flattened from all matching groups
   * @param {string} effectTarget - Effect key
   * @returns {MapPoint[]}
   */
  getPointsForEffect(effectTarget) {
    const groups = this.getGroupsByEffect(effectTarget);
    const points = [];
    
    for (const group of groups) {
      if (group.points && Array.isArray(group.points)) {
        points.push(...group.points);
      }
    }
    
    return points;
  }

  /**
   * Get flattened points for an effect, filtered by level context.
   * @param {string} effectTarget - Effect key
   * @param {any} [context=null] - Optional level context override
   * @returns {MapPoint[]}
   */
  getPointsForEffectForContext(effectTarget, context = null) {
    const groups = this.getGroupsByEffectForContext(effectTarget, context);
    const points = [];

    for (const group of groups) {
      if (group.points && Array.isArray(group.points)) {
        points.push(...group.points);
      }
    }

    return points;
  }

  /**
   * Get line segments for a specific effect (for line-type groups)
   * @param {string} effectTarget - Effect key
   * @returns {Array<{start: MapPoint, end: MapPoint}>}
   */
  getLinesForEffect(effectTarget) {
    const groups = this.getGroupsByEffect(effectTarget);
    const lines = [];
    
    for (const group of groups) {
      if (group.type !== 'line' || !group.points || group.points.length < 2) {
        continue;
      }
      
      // Create line segments from consecutive points
      for (let i = 0; i < group.points.length - 1; i++) {
        lines.push({
          start: group.points[i],
          end: group.points[i + 1],
          groupId: group.id,
          emission: group.emission
        });
      }
    }
    
    return lines;
  }

  /**
   * Get rope configurations for physics rope effect
   * @returns {Array<{group: MapPointGroup, points: MapPoint[]}>}
   */
  getRopeConfigurations() {
    const ropes = [];

    let lastRopeType = null;
    try {
      const saved = game?.settings?.get?.('map-shine-advanced', 'rope-default-behavior');
      if (saved && typeof saved === 'object') {
        const v = saved._lastRopeType;
        if (v === 'rope' || v === 'chain') lastRopeType = v;
      }
    } catch (_) {
    }
    
    for (const group of this.groups.values()) {
      const isLegacyRopeType = group.type === 'rope';
      const isRopeEffectLine = group.type === 'line' && group.effectTarget === 'rope';
      if (!this._isGroupClusterEnabled(group.id)) continue;
      if ((isLegacyRopeType || isRopeEffectLine) && group.points && group.points.length >= 2) {
        const ropeType = (group.ropeType === 'rope' || group.ropeType === 'chain') ? group.ropeType : (lastRopeType || 'chain');
        const segLen = Number.isFinite(group.segmentLength) ? group.segmentLength : undefined;
        ropes.push({
          group,
          points: group.points,
          ropeType,
          texturePath: group.texturePath,
          segmentLength: segLen
        });
      }
    }
    
    return ropes;
  }

  /**
   * Get all area polygons for a specific effect
   * @param {string} effectTarget - Effect key (e.g., 'smellyFlies')
   * @returns {AreaPolygon[]}
   */
  getAreasForEffect(effectTarget) {
    const groups = this.getGroupsByEffect(effectTarget);
    const areas = [];
    
    for (const group of groups) {
      if (group.type !== 'area' || !group.points || group.points.length < 3) {
        continue;
      }
      
      areas.push({
        groupId: group.id,
        points: group.points,
        emission: group.emission,
        bounds: this._computeBounds(group.points)
      });
    }
    
    return areas;
  }

  /**
   * Get area polygons for an effect filtered by level context.
   * @param {string} effectTarget - Effect key
   * @param {any} [context=null] - Optional level context override
   * @returns {AreaPolygon[]}
   */
  getAreasForEffectForContext(effectTarget, context = null) {
    const groups = this.getGroupsByEffectForContext(effectTarget, context);
    const areas = [];

    for (const group of groups) {
      if (group.type !== 'area' || !group.points || group.points.length < 3) {
        continue;
      }

      areas.push({
        groupId: group.id,
        points: group.points,
        emission: group.emission,
        bounds: this._computeBounds(group.points)
      });
    }

    return areas;
  }

  /**
   * Check if a point is inside an area group's polygon
   * Uses ray-casting algorithm for point-in-polygon test
   * @param {string} groupId - Group ID
   * @param {{x: number, y: number}} point - Point to test
   * @returns {boolean}
   */
  isPointInArea(groupId, point) {
    const group = this.groups.get(groupId);
    if (!group || group.type !== 'area' || !group.points || group.points.length < 3) {
      return false;
    }
    
    return this._isPointInPolygon(point.x, point.y, group.points);
  }

  /**
   * Get a random point inside an area group's polygon
   * Uses rejection sampling with bounding box
   * @param {string} groupId - Group ID
   * @param {number} [maxAttempts=50] - Maximum sampling attempts
   * @returns {{x: number, y: number}|null}
   */
  getRandomPointInArea(groupId, maxAttempts = 50) {
    const group = this.groups.get(groupId);
    if (!group || group.type !== 'area' || !group.points || group.points.length < 3) {
      return null;
    }
    
    const bounds = this._computeBounds(group.points);
    
    for (let i = 0; i < maxAttempts; i++) {
      const x = bounds.minX + Math.random() * bounds.width;
      const y = bounds.minY + Math.random() * bounds.height;
      
      if (this._isPointInPolygon(x, y, group.points)) {
        return { x, y };
      }
    }
    
    // Fallback: return centroid (always inside for convex polygons, usually inside for concave)
    return { x: bounds.centerX, y: bounds.centerY };
  }

  /**
   * Get the bounding box of an area group
   * @param {string} groupId - Group ID
   * @returns {AreaBounds|null}
   */
  getAreaBounds(groupId) {
    const group = this.groups.get(groupId);
    if (!group || !group.points || group.points.length < 1) {
      return null;
    }
    
    return this._computeBounds(group.points);
  }

  /**
   * Compute bounding box for a set of points
   * @param {MapPoint[]} points - Array of points
   * @returns {AreaBounds}
   * @private
   */
  _computeBounds(points) {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    
    const width = maxX - minX;
    const height = maxY - minY;
    
    return {
      minX,
      minY,
      maxX,
      maxY,
      centerX: minX + width / 2,
      centerY: minY + height / 2,
      width,
      height
    };
  }

  /**
   * Ray-casting point-in-polygon test
   * @param {number} x - Test point X
   * @param {number} y - Test point Y
   * @param {MapPoint[]} polygon - Polygon vertices
   * @returns {boolean}
   * @private
   */
  _isPointInPolygon(x, y, polygon) {
    let inside = false;
    const n = polygon.length;
    
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;
      
      // Check if the ray from (x, y) going right crosses this edge
      if (((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    
    return inside;
  }

  /**
   * Create a new group
   * @param {Partial<MapPointGroup>} groupData - Initial group data
   * @returns {Promise<MapPointGroup>}
   */
  async createGroup(groupData) {
    return this._enqueueOp(async () => {
      if (!this._canEditScene()) {
        ui?.notifications?.warn?.('You do not have permission to create map points on this scene.');
        throw new Error('Insufficient permissions to create map point group');
      }

      let id = groupData.id;
      if (typeof id !== 'string' || id.length === 0) {
        const base = foundry.utils.randomID();
        const t = Date.now().toString(36);
        const n = (this._idCounter = (this._idCounter + 1) | 0);
        id = `${base}_${t}_${n}`;
      }
      while (this.groups.has(id)) {
        const base = foundry.utils.randomID();
        const t = Date.now().toString(36);
        const n = (this._idCounter = (this._idCounter + 1) | 0);
        id = `${base}_${t}_${n}`;
      }

      const group = this.migrateGroup({
        id,
        label: groupData.label || 'New Group',
        type: groupData.type || 'point',
        points: groupData.points || [],
        isBroken: false,
        reason: '',
        isEffectSource: groupData.isEffectSource ?? false,
        effectTarget: groupData.effectTarget || '',
        emission: groupData.emission || {
          intensity: 1.0,
          falloff: { enabled: false, strength: 0.5 }
        },
        metadata: groupData.metadata ?? this.buildMetadataFromLevelContext(),
        ...groupData
      });

      group.id = id;

      this.groups.set(id, group);
      const ok = await this._saveToSceneNow();
      if (!ok) {
        this.groups.delete(id);
        throw new Error('Failed to save map point group to scene');
      }

      this.notifyListeners();
      this._scheduleRecomputeClusters();

      log.info(`Created map point group: ${id} (${group.label})`);
      return group;
    });
  }

  /**
   * Update an existing group
   * @param {string} id - Group ID
   * @param {Partial<MapPointGroup>} updates - Properties to update
   * @returns {Promise<MapPointGroup|null>}
   */
  async updateGroup(id, updates) {
    return this._enqueueOp(async () => {
      if (!this._canEditScene()) {
        ui?.notifications?.warn?.('You do not have permission to edit map points on this scene.');
        return null;
      }

      const group = this.groups.get(id);
      if (!group) {
        log.warn(`Cannot update non-existent group: ${id}`);
        return null;
      }

      // If the caller explicitly clears points, treat that as deleting the group.
      // This matches user expectations that "removing the map points" removes the group itself.
      if (Object.prototype.hasOwnProperty.call(updates, 'points') && Array.isArray(updates.points) && updates.points.length === 0) {
        if (!this._canEditScene()) return null;
        if (!this.groups.has(id)) return null;
        const prev = group;
        this.groups.delete(id);
        this.removeVisualObject(id);
        const ok = await this._saveToSceneNow();
        if (!ok) {
          this.groups.set(id, prev);
          if (this.showVisualHelpers) this.createVisualHelper(id, prev);
          return prev;
        }
        this.notifyListeners();
        log.info(`Deleted map point group: ${id}`);
        return null;
      }

      const prev = group;
      const updatedGroup = { ...group, ...updates };
      const normalizedGroup = this.migrateGroup({ ...updatedGroup, id });
      normalizedGroup.id = id;
      this.groups.set(id, normalizedGroup);

      const ok = await this._saveToSceneNow();
      if (!ok) {
        this.groups.set(id, prev);
        return prev;
      }

      this.notifyListeners();
      this._scheduleRecomputeClusters();

      log.debug(`Updated map point group: ${id}`);
      return normalizedGroup;
    });
  }

  /**
   * Delete a group
   * @param {string} id - Group ID
   * @returns {Promise<boolean>}
   */
  async deleteGroup(id) {
    return this._enqueueOp(async () => {
      if (!this._canEditScene()) {
        ui?.notifications?.warn?.('You do not have permission to delete map points on this scene.');
        return false;
      }

      if (!this.groups.has(id)) {
        log.warn(`Cannot delete non-existent group: ${id}`);
        return false;
      }

      const prev = this.groups.get(id);
      this.groups.delete(id);
      this.removeVisualObject(id);

      const ok = await this._saveToSceneNow();
      if (!ok) {
        this.groups.set(id, prev);
        if (this.showVisualHelpers) this.createVisualHelper(id, prev);
        return false;
      }

      this.notifyListeners();
      this._scheduleRecomputeClusters();
      log.info(`Deleted map point group: ${id}`);
      return true;
    });
  }

  /**
   * Add a point to a group
   * @param {string} groupId - Group ID
   * @param {MapPoint} point - Point to add
   * @returns {Promise<boolean>}
   */
  async addPoint(groupId, point) {
    return this._enqueueOp(async () => {
      if (!this._canEditScene()) {
        ui?.notifications?.warn?.('You do not have permission to edit map points on this scene.');
        return false;
      }

      const group = this.groups.get(groupId);
      if (!group) {
        log.warn(`Cannot add point to non-existent group: ${groupId}`);
        return false;
      }

      const prevPoints = Array.isArray(group.points) ? group.points.slice() : [];
      group.points = group.points || [];
      group.points.push(point);

      const ok = await this._saveToSceneNow();
      if (!ok) {
        group.points = prevPoints;
        return false;
      }

      this.notifyListeners();

      return true;
    });
  }

  /**
   * Remove a point from a group
   * @param {string} groupId - Group ID
   * @param {number} pointIndex - Index of point to remove
   * @returns {Promise<boolean>}
   */
  async removePoint(groupId, pointIndex) {
    return this._enqueueOp(async () => {
      if (!this._canEditScene()) {
        ui?.notifications?.warn?.('You do not have permission to edit map points on this scene.');
        return false;
      }

      const group = this.groups.get(groupId);
      if (!group || !group.points || pointIndex >= group.points.length) {
        return false;
      }

      const prev = { ...group, points: group.points.slice() };
      group.points.splice(pointIndex, 1);

      if (group.points.length === 0) {
        this.groups.delete(groupId);
        this.removeVisualObject(groupId);
        const ok = await this._saveToSceneNow();
        if (!ok) {
          this.groups.set(groupId, prev);
          if (this.showVisualHelpers) this.createVisualHelper(groupId, prev);
          return false;
        }
        this.notifyListeners();
        log.info(`Deleted map point group: ${groupId}`);
        return true;
      }

      const ok = await this._saveToSceneNow();
      if (!ok) {
        this.groups.set(groupId, prev);
        return false;
      }

      this.notifyListeners();
      return true;
    });
  }

  /**
   * Register a change listener
   * @param {Function} callback - Callback function
   */
  addChangeListener(callback) {
    this.changeListeners.push(callback);
  }

  /**
   * Remove a change listener
   * @param {Function} callback - Callback function
   */
  removeChangeListener(callback) {
    const index = this.changeListeners.indexOf(callback);
    if (index >= 0) {
      this.changeListeners.splice(index, 1);
    }
  }

  /**
   * Notify all change listeners
   * @private
   */
  notifyListeners() {
    for (const callback of this.changeListeners) {
      try {
        callback(this.groups);
      } catch (e) {
        log.error('Error in change listener:', e);
      }
    }
  }

  /**
   * Toggle visual helper display
   * @param {boolean} show - Whether to show helpers
   */
  setShowVisualHelpers(show) {
    this.showVisualHelpers = !!show;
    if (this.showVisualHelpers) {
      this.createVisualHelpers();
    } else {
      this.clearVisualObjects();
    }
  }

  /**
   * Create visual helper objects for all groups
   * @private
   */
  createVisualHelpers() {
    const THREE = window.THREE;
    if (!THREE) return;

    this.clearVisualObjects();

    for (const [id, group] of this.groups) {
      this.createVisualHelper(id, group);
    }
  }

  /**
   * Create a visual helper for a single group
   * @param {string} id - Group ID
   * @param {MapPointGroup} group - Group data
   * @private
   */
  createVisualHelper(id, group) {
    const THREE = window.THREE;
    if (!THREE || !group.points || group.points.length === 0) return;

    // Remove existing helper
    this.removeVisualObject(id);

    // Choose color based on effect target
    const color = this.getEffectColor(group.effectTarget);
    
    // Get ground plane Z for proper positioning
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 1000;
    const helperZ = groundZ + 2; // Render above ground plane
    
    // Create a group to hold all visual elements
    const helperGroup = new THREE.Group();
    helperGroup.name = `MapPointHelper_${id}`;
    helperGroup.renderOrder = 1000;
    helperGroup.userData = {
      ...(helperGroup.userData || {}),
      type: 'mapPointHelper',
      groupId: id,
      helperZ
    };
    
    if (group.type === 'point') {
      // Create visible point markers for each point
      for (let i = 0; i < group.points.length; i++) {
        const point = group.points[i];
        const marker = this._createPointMarkerMesh(point.x, point.y, helperZ, color, i, id);
        helperGroup.add(marker);
      }
      
    } else if (group.type === 'line' || group.type === 'rope') {
      // Create line visualization
      const lineGeo = new THREE.BufferGeometry();
      const positions = [];
      
      for (const point of group.points) {
        positions.push(point.x, point.y, helperZ);
      }
      
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      
      const lineMat = new THREE.LineBasicMaterial({
        color,
        linewidth: 2,
        depthTest: false,
        transparent: true,
        opacity: 0.8
      });
      
      const line = new THREE.Line(lineGeo, lineMat);
      line.userData = {
        ...(line.userData || {}),
        type: 'mapPointLine',
        groupId: id,
        helperZ
      };
      helperGroup.add(line);
      
      // Add point markers at each vertex
      for (let i = 0; i < group.points.length; i++) {
        const point = group.points[i];
        const marker = this._createPointMarkerMesh(point.x, point.y, helperZ + 1, color, i, id);
        helperGroup.add(marker);
      }
      
    } else if (group.type === 'area') {
      // Create area outline (closed loop) with fill
      if (group.points.length >= 3) {
        // Semi-transparent fill
        const shape = new THREE.Shape();
        shape.moveTo(group.points[0].x, group.points[0].y);
        for (let i = 1; i < group.points.length; i++) {
          shape.lineTo(group.points[i].x, group.points[i].y);
        }
        shape.closePath();
        
        const fillGeo = new THREE.ShapeGeometry(shape);
        const posAttr = fillGeo.getAttribute('position');
        for (let i = 0; i < posAttr.count; i++) {
          posAttr.setZ(i, helperZ - 1);
        }
        posAttr.needsUpdate = true;
        
        const fillMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.15,
          depthTest: false,
          side: THREE.DoubleSide
        });
        
        const fillMesh = new THREE.Mesh(fillGeo, fillMat);
        fillMesh.userData = {
          ...(fillMesh.userData || {}),
          type: 'mapPointFill',
          groupId: id,
          helperZ
        };
        helperGroup.add(fillMesh);
        
        // Outline
        const outlineGeo = new THREE.BufferGeometry();
        const positions = [];
        for (const point of group.points) {
          positions.push(point.x, point.y, helperZ);
        }
        positions.push(group.points[0].x, group.points[0].y, helperZ);
        
        outlineGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        
        const outlineMat = new THREE.LineBasicMaterial({
          color,
          linewidth: 2,
          depthTest: false,
          transparent: true,
          opacity: 0.9
        });
        
        const outline = new THREE.Line(outlineGeo, outlineMat);
        outline.userData = {
          ...(outline.userData || {}),
          type: 'mapPointOutline',
          groupId: id,
          helperZ
        };
        helperGroup.add(outline);
        
        // Add point markers at each vertex
        for (let i = 0; i < group.points.length; i++) {
          const point = group.points[i];
          const marker = this._createPointMarkerMesh(point.x, point.y, helperZ + 1, color, i, id);
          helperGroup.add(marker);
        }
      }
    }
    
    this.scene.add(helperGroup);
    this.visualObjects.set(id, helperGroup);
  }

  /**
   * Create a point marker mesh (circle with border)
   * @param {number} x - World X
   * @param {number} y - World Y  
   * @param {number} z - World Z
   * @param {number} color - Hex color
   * @param {number} index - Point index
   * @returns {THREE.Group}
   * @private
   */
  _createPointMarkerMesh(x, y, z, color, index) {
    const THREE = window.THREE;
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // White outer ring (border)
    const outerRing = new THREE.RingGeometry(16, 22, 32);
    const outerMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      side: THREE.DoubleSide
    });
    const outerMesh = new THREE.Mesh(outerRing, outerMat);
    group.add(outerMesh);

    // Inner filled circle (effect color)
    const innerCircle = new THREE.CircleGeometry(14, 32);
    const innerMat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      side: THREE.DoubleSide
    });
    const innerMesh = new THREE.Mesh(innerCircle, innerMat);
    innerMesh.position.z = 0.1;
    group.add(innerMesh);

    // Center dot (darker)
    const centerDot = new THREE.CircleGeometry(4, 16);
    const centerMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
      side: THREE.DoubleSide
    });
    const centerMesh = new THREE.Mesh(centerDot, centerMat);
    centerMesh.position.z = 0.2;
    group.add(centerMesh);

    group.renderOrder = 1001 + index;
    if (arguments.length >= 6) {
      const groupId = arguments[5];
      const data = {
        type: 'mapPointHandle',
        groupId,
        pointIndex: index
      };
      group.userData = { ...(group.userData || {}), ...data };
      group.traverse((child) => {
        child.userData = { ...(child.userData || {}), ...data };
      });
    }
    return group;
  }

  /**
   * Get color for an effect type
   * @param {string} effectTarget - Effect key
   * @returns {number} Hex color
   * @private
   */
  getEffectColor(effectTarget) {
    const colors = {
      fire: 0xff4400,
      candleFlame: 0xffaa00,
      sparks: 0xffff00,
      lightning: 0x00aaff,
      dust: 0xaaaaaa,
      smellyFlies: 0x00ff00,
      water: 0x0066ff,
      pressurisedSteam: 0xcccccc,
      cloudShadows: 0x666666,
      canopy: 0x228822,
      structuralShadows: 0x444444
    };
    
    return colors[effectTarget] || 0xffffff;
  }

  /**
   * Remove a visual object
   * @param {string} id - Group ID
   * @private
   */
  removeVisualObject(id) {
    const obj = this.visualObjects.get(id);
    if (obj) {
      // Recursively dispose all children (for groups with multiple meshes)
      obj.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      this.scene.remove(obj);
      this.visualObjects.delete(id);
    }
  }

  /**
   * Clear all visual objects
   * @private
   */
  clearVisualObjects() {
    for (const id of this.visualObjects.keys()) {
      this.removeVisualObject(id);
    }
  }

  // ── Effect control clusters (GM HUD toggles) ─────────────────────────────

  /**
   * @param {object|null} [scene]
   * @private
   */
  _loadControlClustersFromScene(scene = canvas?.scene) {
    this.controlClusters.clear();
    if (!scene) return;

    let clustersData = null;
    try {
      clustersData = scene.getFlag(MODULE_ID, 'mapPointControlClusters');
    } catch (_) {
      clustersData = null;
    }

    if (!clustersData || typeof clustersData !== 'object' || Array.isArray(clustersData)) {
      this._rebuildGroupIdToClusterIdMap();
      return;
    }

    for (const [id, cluster] of Object.entries(clustersData)) {
      if (!cluster || typeof cluster !== 'object') continue;
      const memberGroupIds = Array.isArray(cluster.memberGroupIds)
        ? cluster.memberGroupIds.filter((gid) => typeof gid === 'string' && gid.length > 0)
        : [];
      const cx = Number(cluster.centroid?.x);
      const cy = Number(cluster.centroid?.y);
      this.controlClusters.set(id, {
        id,
        effectTarget: typeof cluster.effectTarget === 'string' ? cluster.effectTarget : '',
        enabled: cluster.enabled !== false,
        memberGroupIds,
        centroid: {
          x: Number.isFinite(cx) ? cx : 0,
          y: Number.isFinite(cy) ? cy : 0,
        },
        source: cluster.source === 'group' ? 'group' : 'auto',
      });
    }

    this._rebuildGroupIdToClusterIdMap();
  }

  /**
   * @param {boolean} [persist=false]
   * @private
   */
  _recomputeControlClusters(persist = false) {
    const previous = new Map(this.controlClusters);
    const next = recomputeControlClusters(this.groups, previous);
    this.controlClusters = next;
    this._rebuildGroupIdToClusterIdMap();
    if (persist) {
      this._saveClustersToSceneNow().catch((e) => {
        log.error('Failed to persist control clusters after recompute:', e);
      });
    }
  }

  /**
   * @private
   */
  _rebuildGroupIdToClusterIdMap() {
    this._groupIdToClusterId = buildGroupIdToClusterIdMap(this.controlClusters);
  }

  /**
   * @param {string} groupId
   * @returns {boolean}
   * @private
   */
  _isGroupClusterEnabled(groupId) {
    const clusterId = this._groupIdToClusterId.get(groupId);
    if (!clusterId) return true;
    const cluster = this.controlClusters.get(clusterId);
    if (!cluster) return true;
    return cluster.enabled !== false;
  }

  /**
   * @param {string} groupId
   * @returns {import('./map-point-control-clusters.js').MapPointControlCluster|undefined}
   */
  getClusterForGroup(groupId) {
    const clusterId = this._groupIdToClusterId.get(groupId);
    if (!clusterId) return undefined;
    return this.controlClusters.get(clusterId);
  }

  /**
   * @returns {import('./map-point-control-clusters.js').MapPointControlCluster[]}
   */
  getControlClusters() {
    return Array.from(this.controlClusters.values());
  }

  /**
   * @private
   */
  _scheduleRecomputeClusters() {
    if (this._recomputeClustersTimer) {
      try { clearTimeout(this._recomputeClustersTimer); } catch (_) {}
    }
    this._recomputeClustersTimer = setTimeout(() => {
      this._recomputeClustersTimer = null;
      this._enqueueOp(async () => {
        this._recomputeControlClusters(false);
        const ok = await this._saveClustersToSceneNow();
        if (ok) {
          this._refreshControlHud();
          this.notifyListeners();
        }
      });
    }, 200);
  }

  /**
   * @returns {Promise<boolean>}
   */
  async rebuildControlClusters() {
    return this._enqueueOp(async () => {
      if (!this._canEditScene()) {
        ui?.notifications?.warn?.('You do not have permission to rebuild effect clusters on this scene.');
        return false;
      }
      this._recomputeControlClusters(false);
      const ok = await this._saveClustersToSceneNow();
      if (ok) {
        this._refreshControlHud();
        this.notifyListeners();
        ui?.notifications?.info?.('Map point effect clusters rebuilt.');
      }
      return ok;
    });
  }

  /**
   * @returns {Promise<boolean>}
   */
  async _saveClustersToSceneNow() {
    const scene = canvas?.scene;
    if (!scene) return false;
    if (!this._canEditScene()) return false;

    const clustersData = {};
    for (const [id, cluster] of this.controlClusters) {
      if (!cluster || typeof cluster !== 'object') continue;
      clustersData[id] = { ...cluster, id };
    }

    let prevRaw = null;
    try {
      prevRaw = scene.getFlag(MODULE_ID, 'mapPointControlClusters');
    } catch (_) {
      prevRaw = null;
    }
    const prevIds = (prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw))
      ? Object.keys(prevRaw)
      : [];
    const nextIds = new Set(Object.keys(clustersData));
    const flagPayload = { ...clustersData };
    for (const id of prevIds) {
      if (!nextIds.has(id)) flagPayload[`-=${id}`] = null;
    }

    try {
      this._armMapPointPersistGuards({
        logLabel: 'starting scene.update (control clusters)',
        payloadKeys: Object.keys(flagPayload || {}),
      });
      await scene.update({
        [`flags.${MODULE_ID}.mapPointControlClusters`]: flagPayload,
      });
      return true;
    } catch (e) {
      log.error('Failed to save map point control clusters:', e);
      return false;
    } finally {
      this._scheduleClearMapPointPersistGuards();
    }
  }

  /**
   * @param {string} clusterId
   * @returns {Promise<boolean>}
   */
  async toggleClusterEnabled(clusterId) {
    return this._enqueueOp(async () => {
      if (!game.user?.isGM) return false;
      if (!this._canEditScene()) {
        ui?.notifications?.warn?.('You do not have permission to modify effect clusters on this scene.');
        return false;
      }

      const cluster = this.controlClusters.get(clusterId);
      if (!cluster) return false;

      const wasOn = cluster.enabled !== false;
      cluster.enabled = !wasOn;
      const ok = await this._saveClustersToSceneNow();
      if (!ok) {
        cluster.enabled = wasOn;
        return false;
      }

      this._refreshControlHud();
      this.notifyListeners();
      return true;
    });
  }

  /**
   * @param {string} groupId
   * @returns {Promise<boolean>}
   */
  async toggleClusterForGroup(groupId) {
    const clusterId = this._groupIdToClusterId.get(groupId);
    if (!clusterId) return false;
    return this.toggleClusterEnabled(clusterId);
  }

  /**
   * @param {boolean} show
   */
  setShowControlHud(show) {
    this.showControlHud = !!show && !!game.user?.isGM;
    if (this.showControlHud) {
      this._recomputeControlClusters(false);
      this._refreshControlHud();
      if (this._canEditScene()) {
        this._saveClustersToSceneNow().catch(() => {});
      }
    } else {
      this._clearControlHud();
    }
  }

  /**
   * @returns {THREE.Group|null}
   */
  getControlHudGroup() {
    return this.controlHudGroup;
  }

  /**
   * @param {PointerEvent} event
   * @param {THREE.Raycaster} raycaster
   * @param {THREE.Camera} [camera]
   * @returns {string|null} clusterId
   */
  pickEffectControlCluster(event, raycaster, camera = null) {
    if (!game.user?.isGM || !this.showControlHud || !this.controlHudGroup) return null;
    if (!raycaster || typeof raycaster.setFromCamera !== 'function') return null;

    const cam = camera
      ?? window.MapShine?.sceneComposer?.camera
      ?? window.MapShine?.interactionManager?.sceneComposer?.camera;
    if (!cam) return null;

    const rect = canvas?.app?.view?.getBoundingClientRect?.()
      ?? document.getElementById('board')?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) return null;

    const clientX = Number(event?.clientX);
    const clientY = Number(event?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const THREE = window.THREE;
    const prevMask = raycaster.layers?.mask;
    try {
      if (THREE && !raycaster.layers) raycaster.layers = new THREE.Layers();
      if (raycaster.layers) {
        raycaster.layers.mask = 0xffffffff;
        raycaster.layers.enable(0);
        raycaster.layers.enable(OVERLAY_THREE_LAYER);
      }
    } catch (_) {
    }

    raycaster.setFromCamera({ x: ndcX, y: ndcY }, cam);

    const hits = raycaster.intersectObject(this.controlHudGroup, true);
    try {
      if (typeof prevMask === 'number' && raycaster.layers) {
        raycaster.layers.mask = prevMask;
      }
    } catch (_) {
    }

    for (const hit of hits) {
      let object = hit.object;
      while (object && object !== this.controlHudGroup) {
        const type = object.userData?.type;
        if (type === 'mapPointEffectControl' || type === 'mapPointEffectControlHit') {
          const clusterId = object.userData?.clusterId
            ?? object.parent?.userData?.clusterId;
          if (clusterId) return clusterId;
        }
        object = object.parent;
      }
    }
    return null;
  }

  /**
   * @private
   */
  _ensureControlHudGroup() {
    const THREE = window.THREE;
    if (!THREE) return null;

    if (!this.controlHudGroup) {
      this.controlHudGroup = new THREE.Group();
      this.controlHudGroup.name = 'MapPointControlHud';
      this.scene.add(this.controlHudGroup);
    }
    return this.controlHudGroup;
  }

  /**
   * @private
   */
  _refreshControlHud() {
    const THREE = window.THREE;
    if (!THREE) return;

    if (!game.user?.isGM || !this.showControlHud) {
      this._clearControlHud();
      return;
    }

    const hudRoot = this._ensureControlHudGroup();
    if (!hudRoot) return;

    for (const id of [...this.controlHudObjects.keys()]) {
      this._removeControlHudObject(id);
    }

    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 1000;
    const uiScale = canvas?.dimensions?.uiScale ?? 1;
    const iconSize = 28 * uiScale;

    for (const cluster of this.controlClusters.values()) {
      if (!cluster?.id || !cluster.centroid) continue;
      this._createOrUpdateControlHudSprite(cluster, groundZ, iconSize);
    }
  }

  /**
   * @param {import('./map-point-control-clusters.js').MapPointControlCluster} cluster
   * @param {number} groundZ
   * @param {number} iconSize
   * @private
   */
  _createOrUpdateControlHudSprite(cluster, groundZ, iconSize) {
    const THREE = window.THREE;
    if (!THREE) return;

    const clusterId = cluster.id;
    const enabled = cluster.enabled !== false;
    const cx = Number(cluster.centroid?.x);
    const cy = Number(cluster.centroid?.y);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;

    let hudGroup = this.controlHudObjects.get(clusterId);
    if (hudGroup) {
      this._removeControlHudObject(clusterId);
      hudGroup = null;
    }
    if (!hudGroup) {
      hudGroup = new THREE.Group();
      hudGroup.name = `MapPointControlHud_${clusterId}`;
      hudGroup.userData = { type: 'mapPointEffectControl', clusterId };

      const fillColor = enabled ? 0x44cc66 : 0x666666;
      const ringColor = enabled ? 0xffffff : 0x999999;

      const iconGeo = new THREE.CircleGeometry(iconSize * 0.42, 24);
      const iconMat = new THREE.MeshBasicMaterial({
        color: fillColor,
        transparent: true,
        opacity: enabled ? 0.92 : 0.55,
        depthTest: false,
        depthWrite: false,
      });
      iconMat.toneMapped = false;
      const icon = new THREE.Mesh(iconGeo, iconMat);
      icon.renderOrder = 260000;
      icon.layers.set(OVERLAY_THREE_LAYER);
      icon.userData = { type: 'mapPointEffectControl', clusterId };
      hudGroup.add(icon);

      const ringGeo = new THREE.RingGeometry(iconSize * 0.42, iconSize * 0.5, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: ringColor,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      });
      ringMat.toneMapped = false;
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.renderOrder = 260001;
      ring.layers.set(OVERLAY_THREE_LAYER);
      ring.userData = { type: 'mapPointEffectControl', clusterId };
      hudGroup.add(ring);

      const hitGeo = new THREE.CircleGeometry(iconSize * 0.85, 16);
      const hitMat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.001,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.z = 0.5;
      hit.renderOrder = 259000;
      hit.layers.set(0);
      hit.userData = { type: 'mapPointEffectControlHit', clusterId };
      hudGroup.add(hit);

      this._ensureControlHudGroup()?.add(hudGroup);
      this.controlHudObjects.set(clusterId, hudGroup);
    }

    hudGroup.position.set(cx, cy, groundZ + 6);
    hudGroup.userData.clusterId = clusterId;
    hudGroup.userData.effectTarget = cluster.effectTarget;

    const iconMesh = hudGroup.children.find((c) => c.userData?.type === 'mapPointEffectControl');
    const ringMesh = hudGroup.children.find((c) => c.geometry?.type === 'RingGeometry');
    const fillColor = enabled ? 0x44cc66 : 0x666666;
    if (iconMesh?.material) {
      iconMesh.material.color.setHex(fillColor);
      iconMesh.material.opacity = enabled ? 0.92 : 0.55;
      iconMesh.material.needsUpdate = true;
    }
    if (ringMesh?.material) {
      ringMesh.material.color.setHex(enabled ? 0xffffff : 0x999999);
      ringMesh.material.needsUpdate = true;
    }
  }

  /**
   * @param {string} clusterId
   * @private
   */
  _removeControlHudObject(clusterId) {
    const obj = this.controlHudObjects.get(clusterId);
    if (!obj) return;
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
    this.controlHudGroup?.remove(obj);
    this.controlHudObjects.delete(clusterId);
  }

  /**
   * @private
   */
  _clearControlHud() {
    for (const id of [...this.controlHudObjects.keys()]) {
      this._removeControlHudObject(id);
    }
    if (this.controlHudGroup) {
      this.scene.remove(this.controlHudGroup);
      this.controlHudGroup = null;
    }
  }

  /**
   * Dispose of all resources
   */
  dispose() {
    if (this._suppressLoadFromSceneTimer) {
      try { clearTimeout(this._suppressLoadFromSceneTimer); } catch (_) {}
      this._suppressLoadFromSceneTimer = null;
    }
    if (this._recomputeClustersTimer) {
      try { clearTimeout(this._recomputeClustersTimer); } catch (_) {}
      this._recomputeClustersTimer = null;
    }
    this._suppressLoadFromSceneUntil = 0;

    for (const { hook, fn } of this._hookRegistrations) {
      try {
        Hooks.off(hook, fn);
      } catch (_) {
        // Ignore
      }
    }
    this._hookRegistrations = [];

    this.clearVisualObjects();
    this._clearControlHud();
    this.groups.clear();
    this.controlClusters.clear();
    this._groupIdToClusterId.clear();
    this.showControlHud = false;
    this.changeListeners = [];
    this.initialized = false;
    
    log.info('MapPointsManager disposed');
  }
}
