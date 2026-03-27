import { isGmLike } from '../../core/gm-parity.js';
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
    this._target = { saturation: 1.0, brightness: 0.0, contrast: 1.0, tintR: 1.0, tintG: 1.0, tintB: 1.0, waveStrength: 0.0 };
    this._current = { saturation: 1.0, brightness: 0.0, contrast: 1.0, tintR: 1.0, tintG: 1.0, tintB: 1.0, waveStrength: 0.0 };
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
        uTime: { value: 0.0 },
        // Tremorsense wave distortion (0=off, 1=on, lerped for smooth transitions)
        uWaveStrength: { value: 0.0 }
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
        uniform float uSaturation;   // 0=greyscale, 1=unchanged, 2=oversaturated
        uniform float uBrightness;   // added directly to RGB channels
        uniform float uContrast;     // 0=flat grey, 1=unchanged, 2=high contrast
        uniform vec3 uTint;
        uniform float uStrength;     // 0=bypass (basic mode), 1=full effect
        uniform float uTime;
        uniform float uWaveStrength; // 0=off, 1=tremorsense ripple
        varying vec2 vUv;

        void main() {
          // Tremorsense: apply sonar-wave UV distortion before sampling.
          // Multiplying offsets by uWaveStrength means this is a no-op when off.
          float waveX = sin(vUv.y * 12.0 + uTime * 2.5) * 0.004 * uWaveStrength;
          float waveY = cos(vUv.x *  8.5 + uTime * 1.8) * 0.004 * uWaveStrength;
          vec2 uv = clamp(vUv + vec2(waveX, waveY), vec2(0.001), vec2(0.999));

          vec4 texel = texture2D(tDiffuse, uv);
          vec3 color = texel.rgb;

          // Saturation: mix towards luma (0=greyscale, 1=unchanged)
          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          vec3 adjusted = mix(vec3(luma), color, uSaturation);

          // Brightness: direct additive offset
          adjusted += uBrightness;

          // Contrast: pivot around 0.5
          adjusted = (adjusted - 0.5) * uContrast + 0.5;

          // Tint multiply (lightAmplification green, etc.)
          adjusted *= uTint;
          adjusted = max(adjusted, vec3(0.0));

          // Blend between original and adjusted based on overall effect strength
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
      // GM view should stay authorial/full-scene and must not inherit token
      // vision-mode post processing when selecting NPCs.
      if (isGmLike()) return 'basic';

      // Resolve from Foundry's active vision source, not selected token docs.
      // Selected tokens can have darkvision configured even when there is no
      // active vision source driving current visibility, which would otherwise
      // incorrectly dim/tint the whole scene.
      const sources = canvas?.effects?.visionSources;
      if (!sources?.size) return 'basic';

      let activeSource = null;
      for (const source of sources.values()) {
        if (!source?.active) continue;
        if (source?.isPreview) continue;
        activeSource = source;
        break;
      }
      if (!activeSource) return 'basic';

      const modeId = activeSource?.visionMode?.id
        ?? activeSource?.object?.document?.sight?.visionMode
        ?? 'basic';
      return modeId || 'basic';
    } catch (_) {
      return 'basic';
    }
  }

  _updateTargetFromMode(modeId) {
    const config = CONFIG?.Canvas?.visionModes?.[modeId];
    if (!config?.vision?.defaults) {
      // Unknown / unregistered mode — reset to neutral
      this._target.saturation    = 1.0;
      this._target.brightness    = 0.0;
      this._target.contrast      = 1.0;
      this._target.tintR         = 1.0;
      this._target.tintG         = 1.0;
      this._target.tintB         = 1.0;
      this._target.waveStrength  = 0.0;
      return;
    }

    const d = config.vision.defaults;

    // Foundry vision.defaults use a [-1, 1] convention where 0 = no change.
    // The shader uses [0, 2] for saturation and contrast (1 = unchanged).
    //   saturation: -1 (greyscale) → uSaturation=0,  0 (unchanged) → 1,  1 → 2
    //   contrast:   -1 (flat)      → uContrast=0,    0 (unchanged) → 1,  1 → 2
    //   brightness: -1..1 added directly to RGB channels (same in both conventions)
    const sat = d.saturation !== undefined && d.saturation !== null ? Number(d.saturation) : 0;
    const con = d.contrast   !== undefined && d.contrast   !== null ? Number(d.contrast)   : 0;
    this._target.saturation = sat + 1.0;
    this._target.contrast   = con + 1.0;
    this._target.brightness = d.brightness !== undefined && d.brightness !== null ? Number(d.brightness) : 0.0;

    // Tint: read from CONFIG canvas uniforms so system-registered modes with
    // custom tints are honoured automatically (e.g. PF2e may change the
    // lightAmplification tint colour for its own low-light vision flavour).
    const canvasTint = config.canvas?.uniforms?.tint;
    if (Array.isArray(canvasTint) && canvasTint.length >= 3) {
      this._target.tintR = Number(canvasTint[0]) || 1.0;
      this._target.tintG = Number(canvasTint[1]) || 1.0;
      this._target.tintB = Number(canvasTint[2]) || 1.0;
    } else {
      this._target.tintR = 1.0;
      this._target.tintG = 1.0;
      this._target.tintB = 1.0;
    }

    // Wave distortion: active for tremorsense and any mode that uses a Wave*
    // vision shader (detected by shader name convention used by Foundry core).
    const bgShaderName = config.vision?.background?.shader?.name ?? '';
    const hasWaveShader = bgShaderName.toLowerCase().includes('wave');
    this._target.waveStrength = (modeId === 'tremorsense' || hasWaveShader) ? 1.0 : 0.0;
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

    this._current.saturation   += (this._target.saturation   - this._current.saturation)   * alpha;
    this._current.brightness   += (this._target.brightness   - this._current.brightness)   * alpha;
    this._current.contrast     += (this._target.contrast     - this._current.contrast)     * alpha;
    this._current.tintR        += (this._target.tintR        - this._current.tintR)        * alpha;
    this._current.tintG        += (this._target.tintG        - this._current.tintG)        * alpha;
    this._current.tintB        += (this._target.tintB        - this._current.tintB)        * alpha;
    this._current.waveStrength += (this._target.waveStrength - this._current.waveStrength) * alpha;

    const u = this._material.uniforms;
    u.uSaturation.value   = this._current.saturation;
    u.uBrightness.value   = this._current.brightness;
    u.uContrast.value     = this._current.contrast;
    u.uTint.value.set(this._current.tintR, this._current.tintG, this._current.tintB);
    u.uWaveStrength.value = this._current.waveStrength;

    const isBasic = (this._activeMode === 'basic');
    // Overall effect strength: bypass entirely for basic mode.
    // Wave distortion can still lerp down even when returning to basic,
    // so keep the pass active until waveStrength has fully faded out.
    const waveResidual = this._current.waveStrength > 0.005;
    u.uStrength.value = (isBasic && !waveResidual) ? 0.0 : 1.0;
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
