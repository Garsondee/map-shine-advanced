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
    this._enabled = true;

    // Internal state for smoothing
    this._currentWindSpeed = 0.0;
    this._lastFrameTime = 0.0;

    this.params = {
      enabled: true,
      intensity: 1.0,
      
      // -- Wind Physics --
      windSpeedGlobal: 0.1086,   // Multiplier for actual game wind speed
      windRampSpeed: 1.5,        // Inertia: Lower = slower fade in/out of movement
      gustFrequency: 0.01,       // How distinct the "waves" of wind are (Spatial)
      gustSpeed: 0.16,           // How fast the noise field scrolls
      
      // -- Bush Movement --
      branchBend: 0.034,         // How far the "branches" move in strong wind
      elasticity: 2.913,         // Higher = snappier return, Lower = lazy heavy branches
      
      // -- Leaf Flutter --
      flutterIntensity: 0.001,   // Base vibration
      flutterSpeed: 1.0,         // Speed of vibration
      flutterScale: 0.05,        // Spatial scale of flutter clusters (leaf size)
      
      // -- Color --
      exposure: -2.0,
      brightness: 0.0,
      contrast: 1.03,
      saturation: 1.25,
      temperature: 0.0,
      tint: 0.0
    };
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
          parameters: ['windSpeedGlobal', 'windRampSpeed', 'gustFrequency', 'gustSpeed', 'branchBend', 'elasticity']
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
        }
      ],
      parameters: {
        intensity: { type: 'slider', min: 0.0, max: 2.0, default: 1.0 },
        windSpeedGlobal: { type: 'slider', label: 'Wind Multiplier', min: 0.0, max: 3.0, default: 0.1086 },
        windRampSpeed: { type: 'slider', label: 'Responsiveness', min: 0.1, max: 10.0, default: 1.5 },
        gustFrequency: { type: 'slider', label: 'Gust Scale', min: 0.01, max: 0.5, default: 0.01 },
        gustSpeed: { type: 'slider', label: 'Gust Speed', min: 0.0, max: 2.0, default: 0.16 },
        branchBend: { type: 'slider', label: 'Bend Strength', min: 0.0, max: 0.05, step: 0.001, default: 0.034 },
        elasticity: { type: 'slider', label: 'Bounciness', min: 0.5, max: 5.0, default: 2.913 },
        flutterIntensity: { type: 'slider', label: 'Flutter Amp', min: 0.0, max: 0.02, step: 0.001, default: 0.001 },
        flutterSpeed: { type: 'slider', label: 'Flutter Hz', min: 1.0, max: 20.0, default: 1.0 },
        flutterScale: { type: 'slider', label: 'Leaf Size', min: 0.01, max: 100.0, default: 0.05 },
        exposure: { type: 'slider', min: -2.0, max: 2.0, default: -2.0 },
        brightness: { type: 'slider', min: -0.5, max: 0.5, default: 0.0 },
        contrast: { type: 'slider', min: 0.5, max: 2.0, default: 1.03 },
        saturation: { type: 'slider', min: 0.0, max: 2.0, default: 1.25 },
        temperature: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 },
        tint: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 }
      }
    };
  }

  initialize(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    log.info('BushEffect initialized');
  }

  setBaseMesh(baseMesh, assetBundle) {
    if (!assetBundle || !assetBundle.masks) return;
    this.baseMesh = baseMesh;
    const bushData = assetBundle.masks.find(m => m.id === 'bush' || m.type === 'bush');
    this.bushMask = bushData?.texture || null;
    if (!this.bushMask) {
      this.enabled = false;
      return;
    }
    if (this.scene) this._createMesh();
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
        uIntensity: { value: this.params.intensity },
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

    // --- Weather Integration with Smoothing ---
    try {
      const state = weatherController?.getCurrentState?.();
      if (state) {
        if (state.windDirection) u.uWindDir.value.set(state.windDirection.x, state.windDirection.y);
        
        const targetWindSpeed = (typeof state.windSpeed === 'number') ? state.windSpeed : 0.0;
        
        // Dampen the wind speed change (Low-Pass Filter)
        const smoothingFactor = this.params.windRampSpeed * safeDelta;
        const alpha = Math.max(0.0, Math.min(1.0, smoothingFactor));
        
        this._currentWindSpeed += (targetWindSpeed - this._currentWindSpeed) * alpha;
        
        u.uWindSpeed.value = this._currentWindSpeed;
      }
    } catch (e) {
      u.uWindSpeed.value = 0.0;
    }

    // --- Parameter Sync ---
    u.uIntensity.value = this.params.intensity;
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

    // --- Shadow Integration ---
    try {
      const mapShine = window.MapShine || window.mapShine;
      
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
  }
}