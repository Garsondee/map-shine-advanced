/**
 * @fileoverview Vision Mode Post-Processing Effect
 *
 * Applies per-vision-mode visual adjustments to the rendered scene. When the
 * controlled token uses darkvision the scene desaturates, tremorsense adds wave
 * distortion, light amplification tints green, etc.
 *
 * The effect reads the active vision mode from the first controlled token's
 * `sight.visionMode` and maps it to shader uniforms (saturation, brightness,
 * contrast, tint color). It runs as a full-screen post-process pass.
 *
 * Vision mode configs come from `CONFIG.Canvas.visionModes[id]` — the same
 * registry Foundry uses — so module-added vision modes are automatically supported
 * as long as they provide `vision.defaults`.
 *
 * @module effects/VisionModeEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('VisionModeEffect');

/**
 * Hard-coded tint presets for built-in vision modes that use a colored tint.
 * These match the PIXI shader uniforms from Foundry's config.mjs.
 */
const TINT_PRESETS = {
  lightAmplification: { r: 0.38, g: 0.8, b: 0.38 }
};

export class VisionModeEffect extends EffectBase {
  constructor() {
    super('visionMode', RenderLayers.POST_PROCESSING, 'low');

    this.priority = 95; // Render just before ColorCorrection (100)
    this.alwaysRender = false;

    this.quadScene = null;
    this.quadCamera = null;
    this.mesh = null;
    this.material = null;

    /** Currently active vision mode id */
    this._activeMode = 'basic';

    /** Cached uniform targets (lerped for smooth transitions) */
    this._target = { saturation: 1.0, brightness: 0.0, contrast: 1.0, tintR: 1.0, tintG: 1.0, tintB: 1.0 };
    this._current = { saturation: 1.0, brightness: 0.0, contrast: 1.0, tintR: 1.0, tintG: 1.0, tintB: 1.0 };

    /** Transition speed (higher = faster snap). 0 = instant. */
    this._lerpSpeed = 6.0;

    this.params = {
      enabled: true
    };
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) return;

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uSaturation: { value: 1.0 },
        uBrightness: { value: 0.0 },
        uContrast: { value: 1.0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uStrength: { value: 0.0 }, // 0 = no effect (basic mode), 1 = full effect
        uTime: { value: 0.0 }
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uSaturation;
        uniform float uBrightness;
        uniform float uContrast;
        uniform vec3 uTint;
        uniform float uStrength;
        uniform float uTime;
        varying vec2 vUv;

        void main() {
          vec2 uv = vUv;

          vec4 texel = texture2D(tDiffuse, uv);
          vec3 color = texel.rgb;

          // Apply vision mode adjustments
          // Saturation: 0 = greyscale, 1 = normal, >1 = oversaturated
          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          vec3 adjusted = mix(vec3(luma), color, uSaturation);

          // Brightness offset
          adjusted += uBrightness;

          // Contrast around midpoint
          adjusted = (adjusted - 0.5) * uContrast + 0.5;

          // Color tint (multiply)
          adjusted *= uTint;

          adjusted = max(adjusted, vec3(0.0));

          // Blend between original and adjusted based on strength
          color = mix(color, adjusted, uStrength);

          gl_FragColor = vec4(color, texel.a);
        }
      `,
      depthWrite: false,
      depthTest: false
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.quadScene.add(this.mesh);

    log.info('VisionModeEffect initialized');
  }

  /**
   * Read the active vision mode from the first controlled token.
   * @returns {string} Vision mode id (e.g. 'basic', 'darkvision', 'tremorsense')
   * @private
   */
  _resolveActiveVisionMode() {
    try {
      // Prefer MapShine's selected token
      const ms = window.MapShine;
      const selection = ms?.interactionManager?.selection;
      const tokenSprites = ms?.tokenManager?.tokenSprites;

      let tokenDoc = null;

      if (selection && tokenSprites) {
        for (const id of selection) {
          if (!tokenSprites.has(id)) continue;
          const placeables = canvas?.tokens?.placeables || [];
          const token = placeables.find(t => t.document?.id === id);
          if (token?.document?.sight?.visionMode) {
            tokenDoc = token.document;
            break;
          }
        }
      }

      // Fallback: Foundry controlled tokens
      if (!tokenDoc) {
        const controlled = canvas?.tokens?.controlled;
        if (controlled?.length) {
          tokenDoc = controlled[0]?.document;
        }
      }

      // Fallback: first owned token (player default)
      if (!tokenDoc && !game?.user?.isGM) {
        const placeables = canvas?.tokens?.placeables || [];
        for (const t of placeables) {
          if (t?.isOwner || t?.document?.isOwner) {
            tokenDoc = t.document;
            break;
          }
        }
      }

      return tokenDoc?.sight?.visionMode || 'basic';
    } catch (_) {
      return 'basic';
    }
  }

  /**
   * Map a vision mode id to target uniform values.
   * Reads from CONFIG.Canvas.visionModes when available, with hard-coded fallbacks.
   * @param {string} modeId
   * @private
   */
  _computeTargetFromMode(modeId) {
    // Basic vision — no adjustments
    if (modeId === 'basic') {
      this._target.saturation = 1.0;
      this._target.brightness = 0.0;
      this._target.contrast = 1.0;
      this._target.tintR = 1.0;
      this._target.tintG = 1.0;
      this._target.tintB = 1.0;
      return;
    }

    // Try reading from Foundry's VisionMode config
    try {
      const vmConfig = CONFIG?.Canvas?.visionModes?.[modeId];
      if (vmConfig?.vision?.defaults) {
        const d = vmConfig.vision.defaults;
        // Foundry uses -1..1 for saturation where -1=greyscale, 0=normal, 1=oversaturated.
        // Our shader uses 0..2 where 0=greyscale, 1=normal, 2=oversaturated.
        this._target.saturation = (d.saturation !== undefined) ? (d.saturation + 1.0) : 1.0;
        this._target.brightness = d.brightness ?? 0.0;
        this._target.contrast = (d.contrast !== undefined) ? (d.contrast + 1.0) : 1.0;

        // Tint from presets
        const tint = TINT_PRESETS[modeId];
        if (tint) {
          this._target.tintR = tint.r;
          this._target.tintG = tint.g;
          this._target.tintB = tint.b;
        } else {
          this._target.tintR = 1.0;
          this._target.tintG = 1.0;
          this._target.tintB = 1.0;
        }
        return;
      }
    } catch (_) {}

    // Hard-coded fallbacks for known modes
    switch (modeId) {
      case 'darkvision':
        this._target.saturation = 0.0; // Greyscale
        this._target.brightness = 0.0;
        this._target.contrast = 1.0;
        this._target.tintR = 1.0;
        this._target.tintG = 1.0;
        this._target.tintB = 1.0;
        break;
      case 'monochromatic':
        this._target.saturation = 0.0;
        this._target.brightness = 0.0;
        this._target.contrast = 1.0;
        this._target.tintR = 1.0;
        this._target.tintG = 1.0;
        this._target.tintB = 1.0;
        break;
      case 'blindness':
        this._target.saturation = 0.0;
        this._target.brightness = -1.0;
        this._target.contrast = 0.5;
        this._target.tintR = 1.0;
        this._target.tintG = 1.0;
        this._target.tintB = 1.0;
        break;
      case 'tremorsense':
        this._target.saturation = 0.7; // Slightly desaturated
        this._target.brightness = 1.0;
        this._target.contrast = 1.2;
        this._target.tintR = 1.0;
        this._target.tintG = 1.0;
        this._target.tintB = 1.0;
        break;
      case 'lightAmplification':
        this._target.saturation = 0.5;
        this._target.brightness = 1.0;
        this._target.contrast = 1.0;
        this._target.tintR = 0.38;
        this._target.tintG = 0.8;
        this._target.tintB = 0.38;
        break;
      default:
        // Unknown mode — no adjustments
        this._target.saturation = 1.0;
        this._target.brightness = 0.0;
        this._target.contrast = 1.0;
        this._target.tintR = 1.0;
        this._target.tintG = 1.0;
        this._target.tintB = 1.0;
        break;
    }
  }

  setInputTexture(texture) {
    if (this.material) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  setBuffers(readBuffer, writeBuffer) {
    this._readBuffer = readBuffer;
    this._writeBuffer = writeBuffer;
  }

  update(timeInfo) {
    if (!this.material) return;

    // Resolve which vision mode is active
    const mode = this._resolveActiveVisionMode();
    if (mode !== this._activeMode) {
      this._activeMode = mode;
      this._computeTargetFromMode(mode);
      if (mode !== 'basic') {
        log.debug(`Vision mode changed to: ${mode}`);
      }
    }

    // Lerp current values toward target for smooth transitions
    const dt = timeInfo.delta || 0.016;
    const t = Math.min(1.0, this._lerpSpeed * dt);

    this._current.saturation += (this._target.saturation - this._current.saturation) * t;
    this._current.brightness += (this._target.brightness - this._current.brightness) * t;
    this._current.contrast += (this._target.contrast - this._current.contrast) * t;
    this._current.tintR += (this._target.tintR - this._current.tintR) * t;
    this._current.tintG += (this._target.tintG - this._current.tintG) * t;
    this._current.tintB += (this._target.tintB - this._current.tintB) * t;

    const u = this.material.uniforms;
    u.uSaturation.value = this._current.saturation;
    u.uBrightness.value = this._current.brightness;
    u.uContrast.value = this._current.contrast;
    u.uTint.value.set(this._current.tintR, this._current.tintG, this._current.tintB);
    u.uTime.value = timeInfo.elapsed || 0;

    // Strength: 0 when everything is at neutral (basic mode), 1 otherwise
    const isNeutral = Math.abs(this._current.saturation - 1.0) < 0.01
      && Math.abs(this._current.brightness) < 0.01
      && Math.abs(this._current.contrast - 1.0) < 0.01
      && Math.abs(this._current.tintR - 1.0) < 0.01
      && Math.abs(this._current.tintG - 1.0) < 0.01
      && Math.abs(this._current.tintB - 1.0) < 0.01;
    u.uStrength.value = isNeutral ? 0.0 : 1.0;
  }

  render(renderer, scene, camera) {
    if (!this.material) return;

    const inputTexture = this.material.uniforms.tDiffuse.value
      || this._readBuffer?.texture;
    if (!inputTexture) return;
    this.material.uniforms.tDiffuse.value = inputTexture;

    // Always render the full-screen quad to keep the post-processing
    // ping-pong chain intact. When uStrength is 0 the shader is a
    // pure pass-through (mix(color, adjusted, 0) = color).
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.quadScene, this.quadCamera);
    renderer.autoClear = oldAutoClear;
  }

  dispose() {
    this.mesh?.geometry?.dispose();
    this.material?.dispose();
    this.quadScene = null;
    this.quadCamera = null;
    this.mesh = null;
    this.material = null;
    log.info('VisionModeEffect disposed');
  }
}
