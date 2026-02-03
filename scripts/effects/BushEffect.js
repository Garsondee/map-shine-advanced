import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('BushEffect');

/**
 * Animated Bushes effect
 * Renders the `_Bush` RGBA texture as a surface overlay.
 * 
 * IMPROVEMENTS:
 * - Implements scrolling "Gust" noise to desynchronize movement.
 * - Simulates weight: bushes bend WITH wind, they don't oscillate equally back and forth.
 * - Couples leaf flutter to wind gusts (leaves shake more when wind hits).
 * - ORBITAL MOVEMENT: Decouples the forward push from the sideways sway so bushes
 *   move in arcs rather than linear piston (rewind) motions.
 * - Adds smoothing/inertia so wind changes don't cause snapping movements.
 */
export class BushEffect extends EffectBase {
  constructor() {
    super('bush', RenderLayers.SURFACE_EFFECTS, 'low');

    this.priority = 11;
    this.alwaysRender = false;
    this.baseMesh = null;
    this.mesh = null;
    this.bushMask = null;
    this.material = null;
    this.scene = null;
    this.shadowScene = null;
    this.shadowMesh = null;
    this.shadowMaterial = null;
    this.shadowTarget = null;

    this._enabled = true;

    // Internal state for smoothing
    this._currentWindSpeed = 0.0;
    this._lastFrameTime = 0.0;

    this.params = {
      enabled: true,
      intensity: undefined,

      // -- Wind Physics --
      windSpeedGlobal: 0.04,        // Multiplier for actual game wind speed
      windRampSpeed: 2.93,          // Inertia: Lower = slower fade in/out of movement

      gustFrequency: 0.01,       // How distinct the "waves" of wind are (Spatial)
      gustSpeed: 0.52463,        // How fast the noise field scrolls

      // -- Bush Movement --
      branchBend: 0.037,         // How far the "branches" move in strong wind

      elasticity: 5.0,           // Higher = snappier return, Lower = lazy heavy branches

      // -- Leaf Flutter --
      flutterIntensity: 0.0014,  // Base vibration
      flutterSpeed: 1.85362,     // Speed of vibration
      flutterScale: 0.01133,     // Spatial scale of flutter clusters (leaf size)

      // -- Color --
      exposure: 0.0,

      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.1,
      temperature: 0.0,
      tint: 0.0,

      // Shadow
      shadowOpacity: 0.4,
      shadowLength: 0.02,

      shadowSoftness: 5.0
    };

    // PERFORMANCE: Reusable objects to avoid per-frame allocations
    this._tempSize = null; // Lazy init when THREE is available
  }

  _resetTemporalState() {
    this._currentWindSpeed = 0.0;
    this._lastFrameTime = 0.0;
  }

  dispose() {
    try {
      if (this.mesh && this.scene) {
        this.scene.remove(this.mesh);
      }
      this.mesh = null;

      if (this.shadowMesh && this.shadowScene) {
        this.shadowScene.remove(this.shadowMesh);
      }
      this.shadowMesh = null;

      if (this.material) {
        this.material.dispose();
      }
      this.material = null;

      if (this.shadowMaterial) {
        this.shadowMaterial.dispose();
      }
      this.shadowMaterial = null;

      if (this.shadowTarget) {
        this.shadowTarget.dispose();
      }
      this.shadowTarget = null;

      this.shadowScene = null;
      this.scene = null;
      this.camera = null;
      this.renderer = null;
      this.baseMesh = null;
      this.bushMask = null;

      this._tempSize = null;
      this._resetTemporalState();
    } catch (e) {
      // Keep dispose resilient during scene teardown
    }
  }

  get enabled() { return this._enabled; }
  set enabled(value) {
    this._enabled = !!value;
    if (this.mesh) this.mesh.visible = !!value && !!this.bushMask;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'bush-phys',
          label: 'Wind Physics',
          type: 'inline',
          parameters: ['windSpeedGlobal', 'windRampSpeed', 'branchBend', 'elasticity']
        },
        {
          name: 'bush-flutter',
          label: 'Leaf Flutter',
          type: 'inline',
          parameters: ['flutterIntensity', 'flutterSpeed', 'flutterScale']
        },
        {
          name: 'bush-color',
          label: 'Color',
          type: 'folder',
          parameters: ['exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint']
        },
        {
          name: 'bush-shadow',
          label: 'Shadow',
          type: 'inline',
          parameters: ['shadowOpacity', 'shadowLength', 'shadowSoftness']
        }
      ],
      parameters: {
        intensity: { type: 'slider', min: 0.0, max: 2.0, default: undefined },
        windSpeedGlobal: { type: 'slider', label: 'Wind Strength', min: 0.0, max: 3.0, default: 0.04 },
        windRampSpeed: { type: 'slider', label: 'Wind Responsiveness', min: 0.1, max: 10.0, default: 2.93 },
        branchBend: { type: 'slider', label: 'Branch Bend', min: 0.0, max: 0.05, step: 0.001, default: 0.037 },
        elasticity: { type: 'slider', label: 'Springiness', min: 0.5, max: 5.0, default: 5.0 },
        flutterIntensity: { type: 'slider', label: 'Leaf Flutter Amount', min: 0.0, max: 0.005, step: 0.0001, default: 0.0014 },
        flutterSpeed: { type: 'slider', label: 'Leaf Flutter Speed', min: 1.0, max: 20.0, default: 1.85 },
        flutterScale: { type: 'slider', label: 'Leaf Cluster Size', min: 0.005, max: 0.1, default: 0.01 },
        exposure: { type: 'slider', min: -2.0, max: 2.0, default: 0.0 },
        brightness: { type: 'slider', min: -0.5, max: 0.5, default: 0.0 },
        contrast: { type: 'slider', min: 0.5, max: 2.0, default: 1.0 },
        saturation: { type: 'slider', min: 0.0, max: 2.0, default: 1.1 },
        temperature: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 },
        tint: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 },
        shadowOpacity: { type: 'slider', label: 'Shadow Opacity', min: 0.0, max: 1.0, default: 0.4 },
        shadowLength: { type: 'slider', label: 'Shadow Length', min: 0.0, max: 0.1, default: 0.02 },
        shadowSoftness: { type: 'slider', label: 'Shadow Softness', min: 0.5, max: 5.0, default: 5.0 }
      }
    };
  }

  _createShadowMesh() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh || !this.bushMask) return;

    if (this.shadowMesh && this.shadowScene) {
      this.shadowScene.remove(this.shadowMesh);
      this.shadowMesh = null;
    }
    if (this.shadowMaterial) {
      this.shadowMaterial.dispose();
      this.shadowMaterial = null;
    }

    this.shadowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uBushMask: { value: this.bushMask },
        uTime: { value: 0.0 },
        uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
        uWindSpeed: { value: 0.0 },

        uWindSpeedGlobal: { value: this.params.windSpeedGlobal },
        uGustFrequency: { value: this.params.gustFrequency },
        uGustSpeed: { value: this.params.gustSpeed },
        uBranchBend: { value: this.params.branchBend },
        uElasticity: { value: this.params.elasticity },
        uFlutterIntensity: { value: this.params.flutterIntensity },
        uFlutterSpeed: { value: this.params.flutterSpeed },
        uFlutterScale: { value: this.params.flutterScale },

        uShadowOpacity: { value: 1.0 },
        uShadowLength: { value: this.params.shadowLength },
        uShadowSoftness: { value: this.params.shadowSoftness },

        uResolution: { value: new THREE.Vector2(1024, 1024) },
        uSunDir: { value: new THREE.Vector2(0.0, 1.0) },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uZoom: { value: 1.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec2 vWorldPos;

        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xy;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D uBushMask;
        uniform float uTime;
        uniform vec2  uWindDir;
        uniform float uWindSpeed;

        uniform float uWindSpeedGlobal;
        uniform float uGustFrequency;
        uniform float uGustSpeed;
        uniform float uBranchBend;
        uniform float uElasticity;
        uniform float uFlutterIntensity;
        uniform float uFlutterSpeed;
        uniform float uFlutterScale;

        uniform float uShadowOpacity;
        uniform float uShadowLength;
        uniform float uShadowSoftness;

        uniform vec2 uResolution;
        uniform vec2 uTexelSize;

        varying vec2 vUv;
        varying vec2 vWorldPos;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
                     mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
        }

        void main() {
          // --- Wind / Bush motion (same as color pass) ---
          vec2 windDir = normalize(uWindDir);
          if (length(windDir) < 0.01) windDir = vec2(1.0, 0.0);

          float speed = uWindSpeed * uWindSpeedGlobal;
          float ambientMotion = 0.1;
          float effectiveSpeed = ambientMotion + speed;

          vec2 gustPos = vWorldPos * uGustFrequency;
          vec2 scroll = windDir * uTime * uGustSpeed * effectiveSpeed;
          float gustNoise = noise(gustPos - scroll);
          float gustStrength = smoothstep(0.2, 0.8, gustNoise);

          vec2 perpDir = vec2(-windDir.y, windDir.x);
          float orbitPhase = uTime * uElasticity + (gustNoise * 5.0);
          float orbitSway = sin(orbitPhase);

          float pushMagnitude = gustStrength * uBranchBend * effectiveSpeed;
          float swayMagnitude = orbitSway * (uBranchBend * 0.4) * effectiveSpeed * (0.5 + 0.5 * gustStrength);

          float noiseVal = noise(vWorldPos * uFlutterScale);
          float flutterPhase = uTime * uFlutterSpeed * effectiveSpeed + noiseVal * 6.28;
          float flutter = sin(flutterPhase);
          float flutterMagnitude = flutter * uFlutterIntensity * (0.5 + 0.5 * gustStrength);

          vec2 distortion = (windDir * pushMagnitude)
                          + (perpDir * swayMagnitude)
                          + vec2(flutter, flutter) * flutterMagnitude;

          // Sample projected bush alpha (shadow source) and self alpha at the animated bush position
          vec4 bushSample = texture2D(uBushMask, vUv - distortion);
          float selfAlpha = bushSample.a;

          float a = bushSample.a;
          float baseShadow = clamp(a * uShadowOpacity, 0.0, 1.0);

          float accum = 0.0;
          float weightSum = 0.0;
          float blurScale = max(uShadowSoftness, 0.5);
          vec2 stepUv = uTexelSize * blurScale;

          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              vec2 blurUv = vUv + vec2(float(dx), float(dy)) * stepUv;

              float w = 1.0;
              if (dx == 0 && dy == 0) w = 2.0;
              float v = texture2D(uBushMask, blurUv - distortion).a;

              accum += v * w;
              weightSum += w;
            }
          }

          float blurred = (weightSum > 0.0) ? accum / weightSum : baseShadow;
          float strength = clamp(blurred * uShadowOpacity, 0.0, 1.0);
          float shadowFactor = 1.0 - strength;

          float coverage = a;
          gl_FragColor = vec4(shadowFactor, coverage, 0.0, 1.0);
        }
      `,
      transparent: false
    });

    this.shadowMesh = new THREE.Mesh(this.baseMesh.geometry, this.shadowMaterial);
    this.shadowMesh.position.copy(this.baseMesh.position);
    this.shadowMesh.rotation.copy(this.baseMesh.rotation);
    this.shadowMesh.scale.copy(this.baseMesh.scale);

    this.shadowScene.add(this.shadowMesh);
  }

  initialize(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    const THREE = window.THREE;
    if (THREE) {
      this.shadowScene = new THREE.Scene();
      if (this.baseMesh && this.bushMask) {
        this._createShadowMesh();
      }
    }
    log.info('BushEffect initialized');
  }

  setBaseMesh(baseMesh, assetBundle) {
    if (!assetBundle || !assetBundle.masks) return;
    this.baseMesh = baseMesh;

    const bushData = assetBundle.masks.find(m => m.id === 'bush' || m.type === 'bush');
    this.bushMask = bushData?.texture || null;

    // Scene switches can keep the effect instance around briefly; ensure we don't
    // carry motion state across fundamentally different scenes.
    this._resetTemporalState();

    if (!this.bushMask) {
      this.enabled = false;
      return;
    }
    if (this.scene) this._createMesh();
    if (this.shadowScene && this.bushMask) this._createShadowMesh();
  }

  _createMesh() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh || !this.bushMask) return;

    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh);
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uBushMask: { value: this.bushMask },
        uTime: { value: 0.0 },
        uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
        uWindSpeed: { value: 0.0 },
        
        // Params
        uIntensity: { value: (this.params.intensity ?? 1.0) },
        uWindSpeedGlobal: { value: this.params.windSpeedGlobal },
        uGustFrequency: { value: this.params.gustFrequency },
        uGustSpeed: { value: this.params.gustSpeed },
        uBranchBend: { value: this.params.branchBend },
        uElasticity: { value: this.params.elasticity },
        uFlutterIntensity: { value: this.params.flutterIntensity },
        uFlutterSpeed: { value: this.params.flutterSpeed },
        uFlutterScale: { value: this.params.flutterScale },
        
        // Color
        uExposure: { value: this.params.exposure },
        uBrightness: { value: this.params.brightness },
        uContrast: { value: this.params.contrast },
        uSaturation: { value: this.params.saturation },
        uTemperature: { value: this.params.temperature },
        uTint: { value: this.params.tint },
        
        // Shadows
        tOverheadShadow: { value: null },
        tBuildingShadow: { value: null },
        tOutdoorsMask: { value: null },
        uOverheadShadowOpacity: { value: 0.0 },
        uBuildingShadowOpacity: { value: 0.0 },
        uHasOutdoorsMask: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec2 vScreenUv;
        // Pass world position to fragment to anchor noise to the ground, not the mesh UVs
        varying vec2 vWorldPos; 

        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xy; 

          vec4 clipPos = projectionMatrix * viewMatrix * worldPos;
          
          vec2 ndc = clipPos.xy / clipPos.w;
          vScreenUv = ndc * 0.5 + 0.5;

          gl_Position = clipPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D uBushMask;
        uniform float uTime;
        uniform vec2  uWindDir;
        uniform float uWindSpeed;
        uniform float uIntensity;
        
        uniform float uWindSpeedGlobal;
        uniform float uGustFrequency;
        uniform float uGustSpeed;
        uniform float uBranchBend;
        uniform float uElasticity;
        uniform float uFlutterIntensity;
        uniform float uFlutterSpeed;
        uniform float uFlutterScale;

        uniform float uExposure;
        uniform float uBrightness;
        uniform float uContrast;
        uniform float uSaturation;
        uniform float uTemperature;
        uniform float uTint;

        uniform sampler2D tOverheadShadow;
        uniform sampler2D tBuildingShadow;
        uniform sampler2D tOutdoorsMask;
        uniform float uOverheadShadowOpacity;
        uniform float uBuildingShadowOpacity;
        uniform float uHasOutdoorsMask;

        varying vec2 vUv;
        varying vec2 vScreenUv;
        varying vec2 vWorldPos;

        // Pseudo-random hash
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        // Gradient Noise
        float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
                       mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
        }

        float msLuminance(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        vec3 applyCC(vec3 color) {
          color *= pow(2.0, uExposure);
          float t = uTemperature;
          float g = uTint;
          color.r += t * 0.1; color.b -= t * 0.1; color.g += g * 0.1;
          color += vec3(uBrightness);
          color = (color - 0.5) * uContrast + 0.5;
          float l = msLuminance(color);
          color = mix(vec3(l), color, uSaturation);
          return color;
        }

        void main() {
          // 1. Calculate Environmental Factors
          vec2 windDir = normalize(uWindDir);
          if (length(windDir) < 0.01) windDir = vec2(1.0, 0.0);
          
          float speed = uWindSpeed * uWindSpeedGlobal;
          float ambientMotion = 0.1; 
          float effectiveSpeed = ambientMotion + speed;

          // 2. Compute "Gust" Field (Main Push)
          vec2 gustPos = vWorldPos * uGustFrequency;
          vec2 scroll = windDir * uTime * uGustSpeed * effectiveSpeed;
          
          // Noise determines the "push" strength (0.0 to 1.0)
          float gustNoise = noise(gustPos - scroll);
          float gustStrength = smoothstep(0.2, 0.8, gustNoise);

          // 3. Compute "Orbit" (Perpendicular Sway)
          // To fix the "rewind" effect, we need the bush to take a different path back 
          // than it took forward. We use a sine wave to control perpendicular sway.
          // By offsetting the phase, we turn linear motion into elliptical/orbital motion.
          vec2 perpDir = vec2(-windDir.y, windDir.x);
          
          // 'Elasticity' controls the frequency of the bounce
          float orbitPhase = uTime * uElasticity + (gustNoise * 5.0);
          float orbitSway = sin(orbitPhase);

          // 4. Combine Forces
          // Force A: Wind Push (Unidirectional along Wind Vector)
          float pushMagnitude = gustStrength * uBranchBend * effectiveSpeed;
          
          // Force B: Sway (Bidirectional along Perpendicular Vector)
          // We scale this down (0.4) so it's an ellipse, not a circle.
          // We also modulate it slightly by gustStrength so it sways MORE when wind is strong.
          float swayMagnitude = orbitSway * (uBranchBend * 0.4) * effectiveSpeed * (0.5 + 0.5 * gustStrength);

          // 5. Leaf Flutter (High Frequency Vibration)
          float noiseVal = noise(vWorldPos * uFlutterScale);
          float flutterPhase = uTime * uFlutterSpeed * effectiveSpeed + noiseVal * 6.28;
          float flutter = sin(flutterPhase);
          float flutterMagnitude = flutter * uFlutterIntensity * (0.5 + 0.5 * gustStrength);

          // Final Distortion Vector
          // Summing these creates a chaotic, non-linear loop motion.
          vec2 distortion = (windDir * pushMagnitude) 
                          + (perpDir * swayMagnitude) 
                          + vec2(flutter, flutter) * flutterMagnitude;

          // Sample Texture
          vec4 bushSample = texture2D(uBushMask, vUv - distortion);

          // --- Standard Render Logic ---
          float a = bushSample.a * uIntensity;
          if (a <= 0.001) discard;

          vec3 color = bushSample.rgb;
          color = applyCC(color);

          float shadowFactor = 1.0;
          float buildingFactor = 1.0;

          // Shadows
          float shadowTex = texture2D(tOverheadShadow, vScreenUv).r;
          shadowFactor = mix(1.0, shadowTex, uOverheadShadowOpacity);

          float buildingTex = texture2D(tBuildingShadow, vScreenUv).r;
          buildingFactor = mix(1.0, buildingTex, uBuildingShadowOpacity);

          if (uHasOutdoorsMask > 0.5) {
            float outdoorStrength = texture2D(tOutdoorsMask, vScreenUv).r;
            shadowFactor = mix(1.0, shadowFactor, outdoorStrength);
            buildingFactor = mix(1.0, buildingFactor, outdoorStrength);
          }

          color *= shadowFactor * buildingFactor;
          gl_FragColor = vec4(color, clamp(a, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true
    });

    this.mesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    this.mesh.position.copy(this.baseMesh.position);
    this.mesh.rotation.copy(this.baseMesh.rotation);
    this.mesh.scale.copy(this.baseMesh.scale);
    this.mesh.renderOrder = (this.baseMesh.renderOrder || 0) + 1;

    this.scene.add(this.mesh);
    this.mesh.visible = this._enabled;
  }

  update(timeInfo) {
    if (!this.material || !this.mesh || !this._enabled) return;

    const u = this.material.uniforms;
    u.uTime.value = timeInfo.elapsed;
    
    // Calculate delta time for frame-independent smoothing
    const now = timeInfo.elapsed;
    const delta = now - (this._lastFrameTime || now);
    this._lastFrameTime = now;
    const safeDelta = Math.min(delta, 0.1); 

    // Shared MapShine handle for downstream shadow integration and
    // sun-direction/zoom syncing so scope is correct for all blocks.
    const mapShine = window.MapShine || window.mapShine;

    // --- Weather Integration with Smoothing ---
    try {
      const state = weatherController?.getCurrentState?.();
      if (state) {
        if (state.windDirection) {
          u.uWindDir.value.set(state.windDirection.x, state.windDirection.y);
          if (this.shadowMaterial && this.shadowMaterial.uniforms && this.shadowMaterial.uniforms.uWindDir) {
            this.shadowMaterial.uniforms.uWindDir.value.set(state.windDirection.x, state.windDirection.y);
          }
        }
        
        const targetWindSpeed = (typeof state.windSpeed === 'number') ? state.windSpeed : 0.0;
        
        // Dampen the wind speed change (Low-Pass Filter)
        const smoothingFactor = this.params.windRampSpeed * safeDelta;
        const alpha = Math.max(0.0, Math.min(1.0, smoothingFactor));
        
        this._currentWindSpeed += (targetWindSpeed - this._currentWindSpeed) * alpha;

        u.uWindSpeed.value = this._currentWindSpeed;
        if (this.shadowMaterial && this.shadowMaterial.uniforms && this.shadowMaterial.uniforms.uWindSpeed) {
          this.shadowMaterial.uniforms.uWindSpeed.value = this._currentWindSpeed;
        }
      }
    } catch (e) {
      u.uWindSpeed.value = 0.0;
      if (this.shadowMaterial && this.shadowMaterial.uniforms && this.shadowMaterial.uniforms.uWindSpeed) {
        this.shadowMaterial.uniforms.uWindSpeed.value = 0.0;
      }
    }

    // --- Parameter Sync ---
    u.uIntensity.value = (this.params.intensity ?? 1.0);
    u.uWindSpeedGlobal.value = this.params.windSpeedGlobal;
    u.uGustFrequency.value = this.params.gustFrequency;
    u.uGustSpeed.value = this.params.gustSpeed;
    u.uBranchBend.value = this.params.branchBend;
    u.uElasticity.value = this.params.elasticity;
    u.uFlutterIntensity.value = this.params.flutterIntensity;
    u.uFlutterSpeed.value = this.params.flutterSpeed;
    u.uFlutterScale.value = this.params.flutterScale;

    u.uExposure.value = this.params.exposure;
    u.uBrightness.value = this.params.brightness;
    u.uContrast.value = this.params.contrast;
    u.uSaturation.value = this.params.saturation;
    u.uTemperature.value = this.params.temperature;
    u.uTint.value = this.params.tint;

    if (this.shadowMaterial && this.shadowMaterial.uniforms) {
      const su = this.shadowMaterial.uniforms;
      su.uTime.value = timeInfo.elapsed;
      su.uWindSpeedGlobal.value = this.params.windSpeedGlobal;
      su.uGustFrequency.value = this.params.gustFrequency;
      su.uGustSpeed.value = this.params.gustSpeed;
      su.uBranchBend.value = this.params.branchBend;
      su.uElasticity.value = this.params.elasticity;
      su.uFlutterIntensity.value = this.params.flutterIntensity;
      su.uFlutterSpeed.value = this.params.flutterSpeed;
      su.uFlutterScale.value = this.params.flutterScale;

      su.uShadowOpacity.value = 1.0;

      su.uShadowLength.value = this.params.shadowLength;
      su.uShadowSoftness.value = this.params.shadowSoftness;
    }

    // --- Shadow Integration ---
    try {
      const overhead = mapShine?.overheadShadowsEffect;
      u.tOverheadShadow.value = overhead?.shadowTarget?.texture || null;
      u.uOverheadShadowOpacity.value = overhead?.params?.opacity ?? 0.0;

      const building = mapShine?.buildingShadowsEffect;
      const THREE = window.THREE;
      if (building && building.shadowTarget) {
        const baseOpacity = building.params?.opacity ?? 0.0;
        let ti = 1.0;
        if (THREE && typeof building.timeIntensity === 'number') {
          ti = THREE.MathUtils.clamp(building.timeIntensity, 0.0, 1.0);
        }
        u.tBuildingShadow.value = building.shadowTarget.texture;
        u.uBuildingShadowOpacity.value = baseOpacity * ti;
      } else {
        u.tBuildingShadow.value = null;
        u.uBuildingShadowOpacity.value = 0.0;
      }

      const lighting = mapShine?.lightingEffect;
      if (lighting?.outdoorsTarget?.texture) {
        u.tOutdoorsMask.value = lighting.outdoorsTarget.texture;
        u.uHasOutdoorsMask.value = 1.0;
      } else {
        u.tOutdoorsMask.value = null;
        u.uHasOutdoorsMask.value = 0.0;
      }
    } catch (e) {}

    if (this.shadowMaterial && this.shadowMaterial.uniforms) {
      const THREE = window.THREE;
      if (THREE && this.renderer) {
        // PERFORMANCE: Reuse Vector2 instead of allocating every frame
        if (!this._tempSize) this._tempSize = new THREE.Vector2();
        const size = this._tempSize;
        this.renderer.getDrawingBufferSize(size);
        const su = this.shadowMaterial.uniforms;
        if (su.uResolution) su.uResolution.value.set(size.x, size.y);
        if (su.uTexelSize) su.uTexelSize.value.set(1 / size.x, 1 / size.y);
      }

      // Sync sun direction with OverheadShadowsEffect when available so
      // bush shadows exactly match the roof shadows. Fall back to the
      // same time-of-day model if overhead is missing.
      try {
        const overhead = mapShine?.overheadShadowsEffect;

        if (su.uSunDir) {
          if (overhead && overhead.sunDir) {
            su.uSunDir.value.copy(overhead.sunDir);
          } else if (weatherController) {
            let hour = 12.0;
            try {
              if (typeof weatherController.timeOfDay === 'number') {
                hour = weatherController.timeOfDay;
              }
            } catch (e) {}

            const t = (hour % 24.0) / 24.0;
            const azimuth = (t - 0.5) * Math.PI;

            const x = -Math.sin(azimuth);
            const lat = (overhead && overhead.params)
              ? (overhead.params.sunLatitude ?? 0.5)
              : 0.5;
            const y = Math.cos(azimuth) * lat;

            su.uSunDir.value.set(x, y);
          }
        }

        if (su.uZoom) {
          // Prefer sceneComposer.currentZoom (FOV-based zoom system)
          const sceneComposer = window.MapShine?.sceneComposer;
          if (sceneComposer?.currentZoom !== undefined) {
            su.uZoom.value = sceneComposer.currentZoom;
          } else if (this.camera?.isOrthographicCamera) {
            su.uZoom.value = this.camera.zoom;
          } else if (this.camera) {
            const baseDist = 10000.0;
            const dist = this.camera.position.z;
            su.uZoom.value = (dist > 0.1) ? (baseDist / dist) : 1.0;
          }
        }
      } catch (e) {}
    }
  }

  render(renderer, scene, camera) {
    if (!this.enabled || !this.shadowMaterial || !this.shadowScene) return;

    const THREE = window.THREE;
    if (!THREE) return;

    // PERFORMANCE: Reuse Vector2 instead of allocating every frame
    if (!this._tempSize) this._tempSize = new THREE.Vector2();
    const size = this._tempSize;
    renderer.getDrawingBufferSize(size);

    if (!this.shadowTarget) {
      this.shadowTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.shadowTarget.width !== size.x || this.shadowTarget.height !== size.y) {
      this.shadowTarget.setSize(size.x, size.y);
    }

    if (this.shadowMaterial.uniforms.uResolution) {
      this.shadowMaterial.uniforms.uResolution.value.set(size.x, size.y);
    }
    if (this.shadowMaterial.uniforms.uTexelSize) {
      this.shadowMaterial.uniforms.uTexelSize.value.set(1 / size.x, 1 / size.y);
    }

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this.shadowScene, this.camera);
    renderer.setRenderTarget(previousTarget);
  }
}