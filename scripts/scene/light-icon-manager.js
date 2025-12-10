/**
 * @fileoverview Light icon manager - syncs Foundry ambient lights to THREE.js icons
 * Renders billboarded icons for AmbientLight documents in Gameplay Mode
 * @module scene/light-icon-manager
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('LightIconManager');

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

    /** @type {THREE.TextureLoader} */
    this.textureLoader = new THREE.TextureLoader();

    this.initialized = false;
    this.hooksRegistered = false;

    // Group for all light icons
    this.group = new THREE.Group();
    this.group.name = 'LightIcons';
    // Z position will be set in initialize() once groundZ is available
    this.group.position.z = 4.0;
    this.group.visible = false;  // Start hidden until canvas-replacement drives visibility
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

    // Update Z position based on groundZ
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    this.group.position.z = groundZ + 4.0;

    this.setupHooks();
    this.syncAllLights();

    this.initialized = true;
    log.info(`LightIconManager initialized at z=${this.group.position.z}`);
  }

  /**
   * Setup Foundry hooks
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    Hooks.on('createAmbientLight', (doc) => this.create(doc));
    Hooks.on('updateAmbientLight', (doc, changes) => this.update(doc, changes));
    Hooks.on('deleteAmbientLight', (doc) => this.remove(doc.id));

    // Resync on canvas ready (scene change)
    Hooks.on('canvasReady', () => {
      this.syncAllLights();
    });

    this.hooksRegistered = true;
  }

  /**
   * Set visibility of all icons
   * @param {boolean} visible
   * @public
   */
  setVisibility(visible) {
    this.group.visible = visible;
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

    // Clear existing
    for (const sprite of this.lights.values()) {
      this.group.remove(sprite);
      if (sprite.material.map) sprite.material.map.dispose();
      sprite.material.dispose();
    }
    this.lights.clear();

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
    if (this.lights.has(doc.id)) return;

    const iconPath = this.defaultIcon;

    this.textureLoader.load(iconPath, (texture) => {
      // Make sure the light still exists
      if (!canvas.lighting?.placeables?.some(l => l.id === doc.id)) return;

      const size = 48; // Fixed icon size in pixels

      const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
      const sprite = new THREE.Sprite(material);

      // Position: convert Foundry coordinates into Three.js world space so
      // icons line up exactly with the lighting overlay and base plane.
      const worldPos = Coordinates.toWorld(doc.x, doc.y);
      sprite.position.set(worldPos.x, worldPos.y, 0);
      sprite.scale.set(size, size, 1);

      sprite.userData = { lightId: doc.id, type: 'ambientLight' };

      this.group.add(sprite);
      this.lights.set(doc.id, sprite);

      log.debug(`Created light icon ${doc.id}`);
    }, undefined, (err) => {
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
    const sprite = this.lights.get(doc.id);
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

    // No icon/color change for now; that could be extended later
  }

  /**
   * Remove a light icon
   * @param {string} id
   * @private
   */
  remove(id) {
    const sprite = this.lights.get(id);
    if (sprite) {
      this.group.remove(sprite);
      if (sprite.material.map) sprite.material.map.dispose();
      sprite.material.dispose();
      this.lights.delete(id);
    }
  }

  /**
   * Dispose all resources
   * @public
   */
  dispose() {
    for (const sprite of this.lights.values()) {
      this.group.remove(sprite);
      if (sprite.material.map) sprite.material.map.dispose();
      sprite.material.dispose();
    }
    this.lights.clear();

    this.scene.remove(this.group);
  }
}
