import { createLogger } from '../../core/log.js';

const log = createLogger('VisionModeEffectV2');

/**
 * VisionModeEffectV2 - Vision mode post-processing
 * 
 * Archetype: C (Post-Processing Effect)
 * Applies per-vision-mode visual adjustments (darkvision desaturation, etc.)
 * Reads active vision mode from controlled token and applies shader adjustments.
 */
export class VisionModeEffectV2 {
  constructor() {
    this._enabled = true;
    this._initialized = false;

    this._quadScene = null;
    this._quadCamera = null;
    this._mesh = null;
    this._material = null;

    this._activeMode = 'basic';
    this._target = { saturation: 1.0, brightness: 0.0, contrast: 1.0, tintR: 1.0, tintG: 1.0, tintB: 1.0 };
    this._current = { saturation: 1.0, brightness: 0.0, contrast: 1.0, tintR: 1.0, tintG: 1.0, tintB: 1.0 };
    this._lerpSpeed = 6.0;

    this.params = {
      enabled: true
    };
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
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

  initialize() {
    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE not available');
      return;
    }

    this._quadScene = new THREE.Scene();
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uSaturation: { value: 1.0 },
        uBrightness: { value: 0.0 },
        uContrast: { value: 1.0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uStrength: { value: 0.0 },
        uTime: { value: 0.0 }
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
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

          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          vec3 adjusted = mix(vec3(luma), color, uSaturation);
          adjusted += uBrightness;
          adjusted = (adjusted - 0.5) * uContrast + 0.5;
          adjusted *= uTint;
          adjusted = max(adjusted, vec3(0.0));

          color = mix(color, adjusted, uStrength);
          gl_FragColor = vec4(color, texel.a);
        }
      `,
      depthWrite: false,
      depthTest: false,
      toneMapped: false
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    this._mesh = new THREE.Mesh(geometry, this._material);
    this._quadScene.add(this._mesh);

    this._initialized = true;
  }

  _resolveActiveVisionMode() {
    try {
      const ms = window.MapShine;
      const tokenId = ms?.selectedTokenId || canvas?.tokens?.controlled?.[0]?.id;
      if (!tokenId) return 'basic';

      const tokenDoc = game.scenes?.current?.tokens?.get(tokenId);
      if (!tokenDoc) return 'basic';

      return tokenDoc.sight?.visionMode || 'basic';
    } catch (_) {
      return 'basic';
    }
  }

  _updateTargetFromMode(modeId) {
    const config = CONFIG?.Canvas?.visionModes?.[modeId];
    if (!config?.vision?.defaults) {
      this._target.saturation = 1.0;
      this._target.brightness = 0.0;
      this._target.contrast = 1.0;
      this._target.tintR = 1.0;
      this._target.tintG = 1.0;
      this._target.tintB = 1.0;
      return;
    }

    const d = config.vision.defaults;
    this._target.saturation = d.saturation ?? 1.0;
    this._target.brightness = d.brightness ?? 0.0;
    this._target.contrast = d.contrast ?? 1.0;

    if (modeId === 'lightAmplification') {
      this._target.tintR = 0.38;
      this._target.tintG = 0.8;
      this._target.tintB = 0.38;
    } else {
      this._target.tintR = 1.0;
      this._target.tintG = 1.0;
      this._target.tintB = 1.0;
    }
  }

  update(timeInfo) {
    if (!this._initialized || !this._material) return;

    const newMode = this._resolveActiveVisionMode();
    if (newMode !== this._activeMode) {
      this._activeMode = newMode;
      this._updateTargetFromMode(newMode);
    }

    const dt = timeInfo?.delta ?? 0.016;
    const alpha = Math.min(1.0, this._lerpSpeed * dt);

    this._current.saturation += (this._target.saturation - this._current.saturation) * alpha;
    this._current.brightness += (this._target.brightness - this._current.brightness) * alpha;
    this._current.contrast += (this._target.contrast - this._current.contrast) * alpha;
    this._current.tintR += (this._target.tintR - this._current.tintR) * alpha;
    this._current.tintG += (this._target.tintG - this._current.tintG) * alpha;
    this._current.tintB += (this._target.tintB - this._current.tintB) * alpha;

    const u = this._material.uniforms;
    u.uSaturation.value = this._current.saturation;
    u.uBrightness.value = this._current.brightness;
    u.uContrast.value = this._current.contrast;
    u.uTint.value.set(this._current.tintR, this._current.tintG, this._current.tintB);

    const isBasic = (this._activeMode === 'basic');
    u.uStrength.value = isBasic ? 0.0 : 1.0;
    u.uTime.value = timeInfo?.elapsed ?? 0;
  }

  render(renderer, camera, inputRT, outputRT) {
    if (!this._enabled || !this._initialized || !this._material) return false;

    const u = this._material.uniforms;
    if (u.uStrength.value < 0.01) return false;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    this._material.uniforms.tDiffuse.value = inputRT.texture;

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = false;
    renderer.render(this._quadScene, this._quadCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    return true;
  }

  onResize(width, height) {
    // No internal RTs to resize
  }

  dispose() {
    if (this._material) {
      this._material.dispose();
      this._material = null;
    }
    if (this._mesh) {
      if (this._mesh.geometry) this._mesh.geometry.dispose();
      this._mesh = null;
    }
    this._quadScene = null;
    this._quadCamera = null;
    this._initialized = false;
  }
}
