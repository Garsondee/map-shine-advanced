/**
 * @fileoverview Light icon manager - syncs Foundry ambient lights to THREE.js icons
 * Renders billboarded icons for AmbientLight documents in Gameplay Mode
 * @module scene/light-icon-manager
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { OVERLAY_THREE_LAYER } from '../core/render-layers.js';
import { VisionPolygonComputer } from '../vision/VisionPolygonComputer.js';
import { ControlGizmoFactory } from './control-gizmo-factory.js';
import { applyAmbientLightLevelDefaults } from '../foundry/levels-create-defaults.js';
import { isLightVisibleForPerspective } from '../foundry/elevation-context.js';
import {
  getLightIconLevelVisibilityMode,
  LIGHT_ICON_LEVEL_VISIBILITY_MODES,
} from '../settings/scene-settings.js';

const log = createLogger('LightIconManager');
const _lightLosComputer = new VisionPolygonComputer();
_lightLosComputer.circleSegments = 72;

/**
 * LightIconManager - Synchronizes Foundry VTT ambient lights to THREE.js sprites
 */
export class LightIconManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene
   */
  constructor(scene) {
    this.scene = scene;

    /** @type {Map<string, THREE.Sprite>} */
    this.lights = new Map();

    /** @type {Set<string>} Light IDs currently waiting on async icon texture load */
    this._pendingCreates = new Set();

    /** @type {THREE.TextureLoader} */
    this.textureLoader = new THREE.TextureLoader();

    this.initialized = false;
    this.hooksRegistered = false;

    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];

    // Group for all light icons
    this.group = new THREE.Group();
    this.group.name = 'LightIcons';
    // Z position will be set in initialize() once groundZ is available
    this.group.position.z = 4.0;
    this.group.visible = false;  // Start hidden until canvas-replacement drives visibility
    // Render icons in overlay layer to exclude from bloom and color correction
    this.group.layers.set(OVERLAY_THREE_LAYER);
    this.group.layers.enable(0); // Also enable layer 0 for raycasting
    this.scene.add(this.group);

    // Default icon (Foundry core light icon)
    this.defaultIcon = 'icons/svg/light.svg';

    log.debug('LightIconManager created');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) return;

    this._ensureGroupInActiveRenderScene();

    // Update Z position based on groundZ
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    this.group.position.z = groundZ + 4.0;

    this.setupHooks();
    this.syncAllLights();

    this.initialized = true;
    log.info(`LightIconManager initialized at z=${this.group.position.z}`);
  }

  _getActiveRenderScene() {
    const busScene = window.MapShine?.effectComposer?._floorCompositorV2?._renderBus?._scene
      ?? window.MapShine?.floorRenderBus?._scene
      ?? null;
    return busScene || this.scene || null;
  }

  _ensureGroupInActiveRenderScene() {
    const targetScene = this._getActiveRenderScene();
    if (!targetScene || !this.group) return;
    if (this.group.parent === targetScene) return;

    try {
      if (this.group.parent) this.group.parent.remove(this.group);
      targetScene.add(this.group);
      this.scene = targetScene;
      log.info(`LightIconManager render scene updated (children=${targetScene.children?.length ?? 0})`);
    } catch (_) {
    }
  }

  /**
   * Setup Foundry hooks
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    this._hookIds.push(['preCreateAmbientLight', Hooks.on('preCreateAmbientLight', (doc, data, options, userId) => {
      this._onPreCreateAmbientLight(doc, data, options, userId);
    })]);
    this._hookIds.push(['createAmbientLight', Hooks.on('createAmbientLight', (doc) => this.create(doc))]);
    this._hookIds.push(['updateAmbientLight', Hooks.on('updateAmbientLight', (doc, changes) => this.update(doc, changes))]);
    this._hookIds.push(['deleteAmbientLight', Hooks.on('deleteAmbientLight', (doc) => this.remove(doc.id))]);

    // Resync on canvas ready (scene change)
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
      this.syncAllLights();
    })]);

    // Refresh icon visibility when level context or controlled token changes,
    // because perspective-driven light visibility can change without light docs
    // themselves updating.
    this._hookIds.push(['mapShineLevelContextChanged', Hooks.on('mapShineLevelContextChanged', () => {
      this._refreshPerLightVisibility();
    })]);
    this._hookIds.push(['controlToken', Hooks.on('controlToken', () => {
      this._refreshPerLightVisibility();
    })]);

    this.hooksRegistered = true;
  }

  _onPreCreateAmbientLight(doc, data, options, userId) {
    try {
      if (userId && game?.user?.id && userId !== game.user.id) return;

      const hasElevation = data?.elevation !== undefined && data?.elevation !== null;
      const hasRangeBottom = data?.flags?.levels?.rangeBottom !== undefined
        && data?.flags?.levels?.rangeBottom !== null;
      const hasRangeTop = data?.flags?.levels?.rangeTop !== undefined
        && data?.flags?.levels?.rangeTop !== null;
      if (hasElevation && hasRangeBottom && hasRangeTop) return;

      const defaults = {};
      applyAmbientLightLevelDefaults(defaults, { scene: doc?.parent ?? canvas?.scene });

      const patch = {};
      if (!hasElevation && defaults.elevation !== undefined && defaults.elevation !== null) {
        patch.elevation = defaults.elevation;
      }

      const seededRangeBottom = defaults?.flags?.levels?.rangeBottom;
      const seededRangeTop = defaults?.flags?.levels?.rangeTop;
      if ((!hasRangeBottom && seededRangeBottom !== undefined && seededRangeBottom !== null)
        || (!hasRangeTop && seededRangeTop !== undefined && seededRangeTop !== null)) {
        patch.flags = {
          levels: {
            ...(patch.flags?.levels || {}),
            ...((!hasRangeBottom && seededRangeBottom !== undefined && seededRangeBottom !== null)
              ? { rangeBottom: seededRangeBottom }
              : {}),
            ...((!hasRangeTop && seededRangeTop !== undefined && seededRangeTop !== null)
              ? { rangeTop: seededRangeTop }
              : {}),
          },
        };
      }

      if (Object.keys(patch).length > 0) {
        doc.updateSource(patch);
      }
    } catch (_) {
    }
  }

  /**
   * Set visibility of all icons
   * @param {boolean} visible
   * @public
   */
  setVisibility(visible) {
    this._ensureGroupInActiveRenderScene();

    const sceneLightCount = Number(canvas?.lighting?.placeables?.length || 0);
    if (sceneLightCount > 0 && this.lights.size === 0) {
      this.syncAllLights();
    }

    this.group.visible = visible;
    if (visible) {
      this._refreshPerLightVisibility();
    }
  }

  _getLightDocById(id) {
    try {
      return canvas?.scene?.lights?.get?.(id)
        || canvas?.lighting?.placeables?.find?.((l) => l?.id === id)?.document
        || null;
    } catch (_) {
      return null;
    }
  }

  _shouldShowLightIconForDoc(doc) {
    const mode = getLightIconLevelVisibilityMode();
    if (mode === LIGHT_ICON_LEVEL_VISIBILITY_MODES.ALL) return true;
    try {
      return !!isLightVisibleForPerspective(doc);
    } catch (_) {
      return true;
    }
  }

  _refreshSingleLightVisibility(id, docOverride = null) {
    const sprite = this.lights.get(id);
    if (!sprite) return;
    const doc = docOverride || this._getLightDocById(id);
    sprite.visible = this._shouldShowLightIconForDoc(doc);
    const ring = this._findRadiusRing(id);
    if (ring) ring.visible = sprite.visible;
  }

  /**
   * Re-evaluate per-light icon visibility according to the configured level
   * filtering policy.
   */
  _refreshPerLightVisibility() {
    for (const [id, sprite] of this.lights.entries()) {
      if (!sprite) continue;
      const doc = this._getLightDocById(id);
      sprite.visible = this._shouldShowLightIconForDoc(doc);
      const ring = this._findRadiusRing(id);
      if (ring) ring.visible = sprite.visible;
    }
  }

  _dimToPixels(dim) {
    try {
      const d = canvas?.dimensions;
      if (!d || !Number.isFinite(d.size) || !Number.isFinite(d.distance) || d.distance === 0) return 0;
      const v = Number(dim);
      if (!Number.isFinite(v)) return 0;
      return v * (d.size / d.distance);
    } catch (_) {
      return 0;
    }
  }

  _getRadiusPixelsForDoc(doc) {
    const dim = Number(doc?.config?.dim ?? doc?.config?.bright ?? 0);
    if (!Number.isFinite(dim) || dim <= 0) return 0;
    return Math.max(0, this._dimToPixels(dim));
  }

  _findRadiusRing(id) {
    const key = String(id || '');
    if (!key || !this.group?.children) return null;
    return this.group.children.find((obj) => obj?.userData?.type === 'ambientLightRadius' && String(obj?.userData?.lightId || '') === key) || null;
  }

  _computeRadiusLocalPolygon(foundryX, foundryY, radiusPx) {
    try {
      const r = Number(radiusPx);
      if (!Number.isFinite(r) || r <= 0) return null;

      const sceneRect = canvas?.dimensions?.sceneRect;
      const sceneBounds = sceneRect ? {
        x: sceneRect.x,
        y: sceneRect.y,
        width: sceneRect.width,
        height: sceneRect.height
      } : null;

      const ptsF = _lightLosComputer.compute({ x: foundryX, y: foundryY }, r, null, sceneBounds, { sense: 'light' });
      if (!ptsF || ptsF.length < 6) return null;

      const THREE = window.THREE;
      const centerW = Coordinates.toWorld(foundryX, foundryY);
      const local = [];
      for (let i = 0; i < ptsF.length; i += 2) {
        const w = Coordinates.toWorld(ptsF[i], ptsF[i + 1]);
        local.push(new THREE.Vector3(w.x - centerW.x, w.y - centerW.y, 0));
      }

      return local.length >= 3 ? local : null;
    } catch (_) {
      return null;
    }
  }

  _removeRadiusRing(id) {
    const ring = this._findRadiusRing(id);
    if (!ring) return;
    try {
      this.group.remove(ring);
    } catch (_) {
    }
    try {
      ring.geometry?.dispose?.();
    } catch (_) {
    }
    try {
      ring.material?.dispose?.();
    } catch (_) {
    }
  }

  _upsertRadiusRingForDoc(doc) {
    const THREE = window.THREE;
    if (!THREE || !doc?.id) return;

    const lightId = String(doc.id);
    const radiusPixels = this._getRadiusPixelsForDoc(doc);

    if (!(radiusPixels > 0)) {
      this._removeRadiusRing(lightId);
      return;
    }

    const clippedPoints = this._computeRadiusLocalPolygon(doc.x, doc.y, radiusPixels);
    const points = [];
    if (clippedPoints && clippedPoints.length >= 3) {
      for (const p of clippedPoints) points.push(p);
    } else {
      const segments = 72;
      for (let i = 0; i < segments; i += 1) {
        const angle = (i / segments) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(angle) * radiusPixels, Math.sin(angle) * radiusPixels, 0));
      }
    }

    if (points.length > 0) {
      const first = points[0];
      const last = points[points.length - 1];
      if (first && last && (first.x !== last.x || first.y !== last.y || first.z !== last.z)) {
        points.push(first.clone());
      }
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);

    const worldPos = Coordinates.toWorld(doc.x, doc.y);
    let ring = this._findRadiusRing(lightId);

    if (!ring) {
      const material = ControlGizmoFactory.createRadiusBorderMaterial({
        color: 0xffffff,
        opacity: 0.5
      });

      ring = new THREE.LineLoop(geometry, material);
      ring.userData = { type: 'ambientLightRadius', lightId };
      ring.layers.set(OVERLAY_THREE_LAYER);
      ring.layers.enable(0);
      ring.renderOrder = 9998;
      ring.position.set(worldPos.x, worldPos.y, 0.01);
      this.group.add(ring);
      return;
    }

    try {
      ring.geometry?.dispose?.();
    } catch (_) {
    }
    ring.geometry = geometry;
    ring.position.set(worldPos.x, worldPos.y, ring.position.z);
  }

  /**
   * Update visibility based on active layer
   * Show icons primarily when LightingLayer is active (light placement mode)
   * @private
   */
  updateVisibility() {
    // Deprecated: Visibility is now driven centrally by canvas-replacement.js
    // via lightIconManager.setVisibility(showIcons) inside updateLayerVisibility().
    // This method is kept for backward compatibility but no longer reads
    // canvas.activeLayer directly to avoid timing issues during tool switches.
  }

  /**
   * Sync all existing ambient lights
   * @private
   */
  syncAllLights() {
    if (!canvas.lighting) return;

    // Invalidate any in-flight async icon creation callbacks from the previous sync pass.
    this._pendingCreates.clear();

    // Clear existing
    for (const sprite of this.lights.values()) {
      this.group.remove(sprite);
      try {
        if (sprite?.material?.uniforms?.map?.value) {
          sprite.material.uniforms.map.value.dispose();
        }
      } catch (_) {
      }
      try {
        sprite?.geometry?.dispose?.();
      } catch (_) {
      }
      try {
        sprite?.material?.dispose?.();
      } catch (_) {
      }
    }
    this.lights.clear();

    // Clear radius rings
    if (Array.isArray(this.group?.children)) {
      for (let i = this.group.children.length - 1; i >= 0; i -= 1) {
        const child = this.group.children[i];
        if (child?.userData?.type !== 'ambientLightRadius') continue;
        this._removeRadiusRing(child.userData.lightId);
      }
    }

    for (const light of canvas.lighting.placeables) {
      this.create(light.document);
    }
  }

  /**
   * Create a light icon sprite
   * @param {AmbientLightDocument} doc
   * @private
   */
  create(doc) {
    const id = String(doc?.id ?? '');
    if (!id) return;
    if (this.lights.has(id) || this._pendingCreates.has(id)) return;
    this._pendingCreates.add(id);

    const iconPath = this.defaultIcon;

    this.textureLoader.load(iconPath, (texture) => {
      const THREE = window.THREE;
      const pending = this._pendingCreates.has(id);
      // If this request was invalidated (resync/remove), ignore callback.
      if (!pending) return;
      // Make sure the light still exists
      if (!canvas.lighting?.placeables?.some(l => String(l.id) === id)) {
        this._pendingCreates.delete(id);
        return;
      }

      // Another code path may have already created the sprite while this texture
      // was loading. Keep the first winner and drop this duplicate callback.
      if (this.lights.has(id)) {
        this._pendingCreates.delete(id);
        return;
      }

      const size = 48; // Fixed icon size in pixels

      // Ensure correct color space
      try {
        if (THREE && 'colorSpace' in texture && THREE.SRGBColorSpace) {
          texture.colorSpace = THREE.SRGBColorSpace;
        }
      } catch (_) {
      }

      // Use shared outlined material for visibility on bright backgrounds.
      const material = ControlGizmoFactory.createOutlinedSpriteMaterial(texture);
      
      // Create a mesh that acts like a sprite (billboard)
      const geometry = new THREE.PlaneGeometry(1, 1);
      const sprite = new THREE.Mesh(geometry, material);

      // Position: convert Foundry coordinates into Three.js world space so
      // icons line up exactly with the lighting overlay and base plane.
      const worldPos = Coordinates.toWorld(doc.x, doc.y);
      sprite.position.set(worldPos.x, worldPos.y, 0);
      sprite.scale.set(size, size, 1);

      // Set to overlay layer to exclude from bloom/CC
      sprite.layers.set(OVERLAY_THREE_LAYER);
      sprite.layers.enable(0); // Also enable layer 0 for raycasting
      sprite.renderOrder = 9999;

      sprite.userData = {
        lightId: id,
        type: 'ambientLight',
        baseScale: { x: size, y: size, z: 1 }
      };

      this.group.add(sprite);
      this.lights.set(id, sprite);
      this._pendingCreates.delete(id);
      this._upsertRadiusRingForDoc(doc);
      this._refreshSingleLightVisibility(id, doc);

      log.debug(`Created light icon ${id}`);
    }, undefined, (err) => {
      this._pendingCreates.delete(id);
      log.warn('Failed to load light icon texture', err);
    });
  }

  /**
   * Update an existing light icon
   * @param {AmbientLightDocument} doc
   * @param {Object} changes
   * @private
   */
  update(doc, changes) {
    const id = String(doc?.id ?? doc?._id ?? '');
    if (!id) return;

    const sprite = this.lights.get(id);
    if (!sprite) {
      this.create(doc);
      return;
    }

    // Update position if x/y changed
    if (changes.x !== undefined || changes.y !== undefined) {
      const x = changes.x ?? doc.x;
      const y = changes.y ?? doc.y;

      // Convert Foundry coordinates (top-left origin, pixels) into Three.js
      // world space so the icon stays aligned with the ambient light.
      const worldPos = Coordinates.toWorld(x, y);
      sprite.position.set(worldPos.x, worldPos.y, sprite.position.z);
    }

    this._upsertRadiusRingForDoc(doc);

    // No icon/color change for now; that could be extended later
    this._refreshSingleLightVisibility(id, doc);
  }

  /**
   * Remove a light icon
   * @param {string} id
   * @private
   */
  remove(id) {
    const key = String(id ?? '');
    if (!key) return;

    this._pendingCreates.delete(key);

    const sprite = this.lights.get(key);
    if (sprite) {
      this.group.remove(sprite);
      // Handle shader material with uniform texture
      if (sprite.material.uniforms?.map?.value) {
        sprite.material.uniforms.map.value.dispose();
      }
      sprite.geometry?.dispose?.();
      sprite.material.dispose();
      this.lights.delete(key);
    }
    this._removeRadiusRing(key);
  }

  /**
   * Dispose all resources
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
    this._pendingCreates.clear();

    for (const sprite of this.lights.values()) {
      this.group.remove(sprite);
      // Handle shader material with uniform texture
      if (sprite.material.uniforms?.map?.value) {
        sprite.material.uniforms.map.value.dispose();
      }
      sprite.geometry?.dispose?.();
      sprite.material.dispose();
    }

    if (Array.isArray(this.group?.children)) {
      for (let i = this.group.children.length - 1; i >= 0; i -= 1) {
        const child = this.group.children[i];
        if (child?.userData?.type !== 'ambientLightRadius') continue;
        this._removeRadiusRing(child.userData.lightId);
      }
    }

    this.lights.clear();

    this.scene.remove(this.group);
  }
}
