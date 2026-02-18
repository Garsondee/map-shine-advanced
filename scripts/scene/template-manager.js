/**
 * @fileoverview Template manager - syncs Foundry measured templates to THREE.js
 * Renders spell templates (cones, circles, rays, rects) in Gameplay Mode
 * @module scene/template-manager
 */

import { createLogger } from '../core/log.js';
import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';
import { getPerspectiveElevation } from '../foundry/elevation-context.js';
import { readDocLevelsRange, isLevelsEnabledForScene } from '../foundry/levels-scene-flags.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from '../foundry/levels-compatibility.js';

const log = createLogger('TemplateManager');

/**
 * TemplateManager - Synchronizes Foundry VTT templates to THREE.js
 */
export class TemplateManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene
   */
  constructor(scene) {
    this.scene = scene;
    
    /** @type {Map<string, THREE.Object3D>} */
    this.templates = new Map();
    
    this.initialized = false;
    this.hooksRegistered = false;
    
    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];
    
    // Group for all templates
    this.group = new THREE.Group();
    this.group.name = 'Templates';
    // Z position will be set in initialize() once groundZ is available
    this.group.position.z = 1.5;
    this.scene.add(this.group);
    
    log.debug('TemplateManager created');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) return;

    // Update Z position based on groundZ
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    this.group.position.z = groundZ + 1.5;

    this.setupHooks();
    this.syncAllTemplates();
    
    this.initialized = true;
    log.info(`TemplateManager initialized at z=${this.group.position.z}`);
  }

  /**
   * Setup Foundry hooks
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    this._hookIds.push(['createMeasuredTemplate', Hooks.on('createMeasuredTemplate', (doc) => this.create(doc))]);
    this._hookIds.push(['preCreateMeasuredTemplate', Hooks.on('preCreateMeasuredTemplate', (doc, data, options, userId) => this._onPreCreateMeasuredTemplate(doc, data, options, userId))]);
    this._hookIds.push(['updateMeasuredTemplate', Hooks.on('updateMeasuredTemplate', (doc, changes) => this.update(doc, changes))]);
    this._hookIds.push(['deleteMeasuredTemplate', Hooks.on('deleteMeasuredTemplate', (doc) => this.remove(doc.id))]);
    
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
        this.syncAllTemplates();
        this.updateVisibility();
    })]);

    // Keep baseline Foundry visibility in sync with vision/perception refreshes.
    this._hookIds.push(['sightRefresh', Hooks.on('sightRefresh', () => this.refreshVisibility())]);

    // MS-LVL-045: Re-check template visibility when level context or controlled
    // token changes.
    this._hookIds.push(['mapShineLevelContextChanged', Hooks.on('mapShineLevelContextChanged', () => this.refreshVisibility())]);
    this._hookIds.push(['controlToken', Hooks.on('controlToken', () => this.refreshVisibility())]);

    this._hookIds.push(['activateTemplateLayer', Hooks.on('activateTemplateLayer', () => this.setVisibility(false))]);
    this._hookIds.push(['deactivateTemplateLayer', Hooks.on('deactivateTemplateLayer', () => this.setVisibility(true))]);

    this.hooksRegistered = true;
  }

  /**
   * Set visibility
   * @param {boolean} visible 
   * @public
   */
  setVisibility(visible) {
    this.group.visible = visible;
  }

  /**
   * Update visibility
   * @private
   */
  updateVisibility() {
    const isTemplateLayer = canvas.activeLayer?.name === 'TemplateLayer';
    this.setVisibility(!isTemplateLayer);
  }

  /**
   * Check whether a template should be visible to the current user.
   * Mirrors Foundry's MeasuredTemplate#isVisible: hidden templates
   * are only visible to the author or GM.
   * @param {MeasuredTemplateDocument} doc
   * @returns {boolean}
   * @private
   */
  _isTemplateVisible(doc) {
    try {
      // If the PIXI placeable exists, defer to its authoritative isVisible.
      const placeable = canvas?.templates?.get?.(doc.id);
      if (placeable && ('isVisible' in placeable) && !placeable.isVisible) return false;

      // Fallback: replicate core logic.
      if (!placeable) {
        const isVisibleByCore = !doc.hidden || doc.isAuthor || !!game?.user?.isGM;
        if (!isVisibleByCore) return false;
      }
    } catch (_) {
      // Fail-open: keep template visible if baseline check errors.
    }

    // MS-LVL-045: Elevation range gating for templates.
    try {
      if (getLevelsCompatibilityMode() !== LEVELS_COMPATIBILITY_MODES.OFF
          && isLevelsEnabledForScene(canvas?.scene)) {
        const range = readDocLevelsRange(doc);
        if (Number.isFinite(range.rangeBottom) || Number.isFinite(range.rangeTop)) {
          const perspective = getPerspectiveElevation();
          if (perspective.source !== 'background') {
            const elev = perspective.elevation;
            if (elev < range.rangeBottom || elev > range.rangeTop) return false;
          }
        }
      }
    } catch (_) {
      // Fail-open: keep template visible if elevation check errors.
    }

    return true;
  }

  /**
   * MS-LVL-045: Apply template creation defaults from active elevation context.
   *
   * - If no explicit template elevation is provided, default to current
   *   perspective elevation.
   * - If an active level band exists, seed missing rangeBottom/rangeTop flags
   *   from that band so template visibility follows the current floor context.
   *
   * @param {MeasuredTemplateDocument} doc
   * @param {object} data
   * @param {object} options
   * @param {string} userId
   * @private
   */
  _onPreCreateMeasuredTemplate(doc, data, options, userId) {
    try {
      if (userId && game?.user?.id && userId !== game.user.id) return;
      if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return;

      // Keep parity with Levels behavior: if the template payload is meant for
      // levels-3d-preview tooling, do not override elevation/special defaults.
      if (data?.flags?.['levels-3d-preview']) return;

      const scene = doc?.parent ?? canvas?.scene;
      if (!isLevelsEnabledForScene(scene)) return;

      const patch = {};

      // Elevation default: only seed when the create payload omitted elevation.
      const hasExplicitElevation = data?.elevation !== undefined && data?.elevation !== null;
      if (!hasExplicitElevation) {
        const perspective = getPerspectiveElevation();
        const elevation = Number(perspective?.elevation);
        if (Number.isFinite(elevation)) patch.elevation = elevation;
      }

      // Range defaults: seed from active level context if a finite band exists.
      const active = window.MapShine?.activeLevelContext;
      const activeBottom = Number(active?.bottom);
      const activeTop = Number(active?.top);
      if (Number.isFinite(activeBottom) && Number.isFinite(activeTop)) {
        const hasRangeBottom = data?.flags?.levels?.rangeBottom !== undefined && data?.flags?.levels?.rangeBottom !== null;
        const hasRangeTop = data?.flags?.levels?.rangeTop !== undefined && data?.flags?.levels?.rangeTop !== null;

        if (!hasRangeBottom || !hasRangeTop) {
          patch.flags = patch.flags || {};
          patch.flags.levels = patch.flags.levels || {};
          if (!hasRangeBottom) patch.flags.levels.rangeBottom = activeBottom;
          if (!hasRangeTop) patch.flags.levels.rangeTop = activeTop;
        }
      }

      // Levels template depth (`flags.levels.special`) defaults to a derived
      // hand-mode style offset. In native mode we derive it from the current
      // perspective LOS/elevation delta when omitted.
      const hasSpecial = data?.flags?.levels?.special !== undefined
        && data?.flags?.levels?.special !== null;
      if (!hasSpecial) {
        const perspective = getPerspectiveElevation();
        const losHeight = Number(perspective?.losHeight);
        const elevation = Number(perspective?.elevation);
        const delta = Number.isFinite(losHeight) && Number.isFinite(elevation)
          ? Math.max(0, losHeight - elevation)
          : 0;
        const specialDepth = Math.round(delta * 0.8);

        patch.flags = patch.flags || {};
        patch.flags.levels = patch.flags.levels || {};
        patch.flags.levels.special = Number.isFinite(specialDepth) ? specialDepth : 0;
      }

      if (Object.keys(patch).length > 0) {
        doc.updateSource(patch);
      }
    } catch (e) {
      log.warn('Failed to apply pre-create template defaults', e);
    }
  }

  /**
   * Sync all templates, filtering by visibility/permission.
   * @private
   */
  syncAllTemplates() {
    if (!canvas.scene || !canvas.scene.templates) return;
    
    for (const template of canvas.scene.templates) {
      if (this._isTemplateVisible(template)) {
        this.create(template);
      } else {
        this.remove(template.id);
      }
    }
  }

  /**
   * Refresh visibility of all templates after elevation context changes.
   * @public
   */
  refreshVisibility() {
    if (!canvas?.scene?.templates) return;
    for (const doc of canvas.scene.templates) {
      const shouldShow = this._isTemplateVisible(doc);
      if (shouldShow && !this.templates.has(doc.id)) {
        this.create(doc);
      } else if (!shouldShow && this.templates.has(doc.id)) {
        this.remove(doc.id);
      }
    }
  }

  /**
   * Create a template object
   * @param {MeasuredTemplateDocument} doc 
   * @private
   */
  create(doc) {
    if (this.templates.has(doc.id)) return;
    // WP-6: Skip templates that fail visibility/permission check.
    if (!this._isTemplateVisible(doc)) return;

    try {
        const t = doc.t; // circle, cone, rect, ray
        const distance = doc.distance;
        const direction = doc.direction || 0;
        // Use system-specific default cone angle (e.g. 53.13° for DnD5e, 90° for PF2e)
        const gsm = window.MapShine?.gameSystem;
        const defaultConeAngle = gsm?.getDefaultConeAngle?.() ?? 53.13;
        const angle = doc.angle || defaultConeAngle;
        const width = doc.width;
        
        // Convert distance (grid units) to pixels
        const pixelDistance = (distance / canvas.dimensions.distance) * canvas.dimensions.size;
        
        let geometry;
        
        // Color
        const color = new THREE.Color(doc.fillColor || 0xFF0000);
        const borderColor = new THREE.Color(doc.borderColor || 0x000000);
        
        switch (t) {
            case 'circle':
                geometry = new THREE.CircleGeometry(pixelDistance, 32);
                break;
            case 'cone':
                // Cone is a sector of a circle
                // thetaStart = rotation, thetaLength = angle
                // Foundry cones are centered on direction
                const thetaLength = THREE.MathUtils.degToRad(angle);
                // Start is -half angle + rotation?
                // Foundry rotation 0 is South (down)? No, 0 is East usually?
                // Need to verify rotation. For now assume standard math (0 = East).
                geometry = new THREE.CircleGeometry(pixelDistance, 32, -thetaLength/2, thetaLength);
                break;
            case 'rect':
                // Rect is defined by distance (length/height?) and width?
                // Or direction? Foundry Rects are dragged.
                // doc.shape contains the points usually.
                // Fallback to plane
                geometry = new THREE.PlaneGeometry(pixelDistance, pixelDistance); // Approx
                break;
            case 'ray':
                // Ray is a line with width
                const rayWidth = (width / canvas.dimensions.distance) * canvas.dimensions.size || 50;
                geometry = new THREE.PlaneGeometry(pixelDistance, rayWidth);
                geometry.translate(pixelDistance/2, 0, 0); // Anchor at start
                break;
            default:
                geometry = new THREE.CircleGeometry(pixelDistance, 32);
        }
        
        const material = new THREE.MeshBasicMaterial({ 
            color: color, 
            transparent: true, 
            opacity: 0.3,
            side: THREE.DoubleSide
        });
        
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(doc.x, doc.y, 0);
        // Render templates in overlay pass so they are not affected by bloom.
        // Layers are not inherited in three.js, so apply to descendants too.
        mesh.traverse((obj) => {
          if (obj?.layers) obj.layers.set(OVERLAY_THREE_LAYER);
        });
        
        // Rotation
        mesh.rotation.z = THREE.MathUtils.degToRad(-direction);
        
        // Border
        const edges = new THREE.EdgesGeometry(geometry);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: borderColor }));
        mesh.add(line);
        
        this.group.add(mesh);
        this.templates.set(doc.id, mesh);
        
        log.debug(`Created template ${doc.id} (${t})`);
    } catch (e) {
        log.error(`Failed to create template ${doc.id}:`, e);
    }
  }

  /**
   * Update a template
   * @param {MeasuredTemplateDocument} doc 
   * @param {Object} changes 
   * @private
   */
  update(doc, changes) {
    // WP-6: Re-check visibility on update (e.g., hidden flag changed).
    this.remove(doc.id);
    if (this._isTemplateVisible(doc)) {
      this.create(doc);
    }
  }

  /**
   * Remove a template
   * @param {string} id 
   * @private
   */
  remove(id) {
    const object = this.templates.get(id);
    if (object) {
      this.group.remove(object);
      // Dispose
      if (object.geometry) object.geometry.dispose();
      if (object.material) object.material.dispose();
      this.templates.delete(id);
    }
  }
  
  /**
   * Dispose resources
   * @public
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
      this.hooksRegistered = false;
      
      this.group.clear();
      this.scene.remove(this.group);
      this.templates.clear();
  }
}
