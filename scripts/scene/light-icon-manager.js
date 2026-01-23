/**
 * @fileoverview Light icon manager - syncs Foundry ambient lights to THREE.js icons
 * Renders billboarded icons for AmbientLight documents in Gameplay Mode
 * @module scene/light-icon-manager
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';

const log = createLogger('LightIconManager');

/**
 * Creates a custom shader material for light icon sprites with a dark outline.
 * The outline ensures visibility against bright/white backgrounds.
 * @param {THREE.Texture} texture - The icon texture
 * @returns {THREE.ShaderMaterial}
 */
function createOutlinedSpriteMaterial(texture) {
  const THREE = window.THREE;
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      outlineColor: { value: new THREE.Color(0x222222) },
      outlineWidth: { value: 0.08 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 scale = vec2(
          length(modelMatrix[0].xyz),
          length(modelMatrix[1].xyz)
        );
        mvPosition.xy += position.xy * scale;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform vec3 outlineColor;
      uniform float outlineWidth;
      varying vec2 vUv;

      void main() {
        vec4 texColor = texture2D(map, vUv);
        float alpha = texColor.a;

        // Sample neighbors to detect edges for outline
        float outlineAlpha = 0.0;
        float step = outlineWidth;
        for (float x = -1.0; x <= 1.0; x += 1.0) {
          for (float y = -1.0; y <= 1.0; y += 1.0) {
            if (x == 0.0 && y == 0.0) continue;
            vec2 offset = vec2(x, y) * step;
            float neighborAlpha = texture2D(map, vUv + offset).a;
            outlineAlpha = max(outlineAlpha, neighborAlpha);
          }
        }

        // Dark outline where neighbors have alpha but current pixel doesn't
        float outline = clamp(outlineAlpha - alpha, 0.0, 1.0);
        vec3 finalColor = mix(texColor.rgb, outlineColor, outline * 0.9);
        float finalAlpha = max(alpha, outline * 0.85);

        gl_FragColor = vec4(finalColor, finalAlpha);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
}

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

    this._hookIds.push(['createAmbientLight', Hooks.on('createAmbientLight', (doc) => this.create(doc))]);
    this._hookIds.push(['updateAmbientLight', Hooks.on('updateAmbientLight', (doc, changes) => this.update(doc, changes))]);
    this._hookIds.push(['deleteAmbientLight', Hooks.on('deleteAmbientLight', (doc) => this.remove(doc.id))]);

    // Resync on canvas ready (scene change)
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
      this.syncAllLights();
    })]);

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
      const THREE = window.THREE;
      // Make sure the light still exists
      if (!canvas.lighting?.placeables?.some(l => l.id === doc.id)) return;

      const size = 48; // Fixed icon size in pixels

      // Ensure correct color space
      try {
        if (THREE && 'colorSpace' in texture && THREE.SRGBColorSpace) {
          texture.colorSpace = THREE.SRGBColorSpace;
        }
      } catch (_) {
      }

      // Use custom outlined material for visibility on bright backgrounds
      const material = createOutlinedSpriteMaterial(texture);
      
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
        lightId: doc.id,
        type: 'ambientLight',
        baseScale: { x: size, y: size, z: 1 }
      };

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
      // Handle shader material with uniform texture
      if (sprite.material.uniforms?.map?.value) {
        sprite.material.uniforms.map.value.dispose();
      }
      sprite.geometry?.dispose?.();
      sprite.material.dispose();
      this.lights.delete(id);
    }
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

    for (const sprite of this.lights.values()) {
      this.group.remove(sprite);
      // Handle shader material with uniform texture
      if (sprite.material.uniforms?.map?.value) {
        sprite.material.uniforms.map.value.dispose();
      }
      sprite.geometry?.dispose?.();
      sprite.material.dispose();
    }
    this.lights.clear();

    this.scene.remove(this.group);
  }
}
