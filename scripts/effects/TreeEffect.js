import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('TreeEffect');

/**
 * Animated Tree effect (High Canopy)
 * Renders the `_Tree` RGBA texture as a high-level surface overlay.
 * 
 * Key Differences from BushEffect:
 * - Placed ABOVE overhead layers (z=25)
 * - Does NOT receive shadows (canopy is top-most)
 * - Casts shadows onto everything below (Ground, Overhead, Bushes)
 */
export class TreeEffect extends EffectBase {
  constructor() {
    super('tree', RenderLayers.SURFACE_EFFECTS, 'low');

    this.priority = 12; // Higher priority than bushes
    this.alwaysRender = false;
    this.baseMesh = null;
    this.mesh = null;
    this.treeMask = null;
    this.material = null;
    this.scene = null;
    this.shadowScene = null;
    this.shadowMesh = null;
    this.shadowMaterial = null;
    this.shadowTarget = null;

    this._enabled = true;

    this._hoverHidden = false;
    this._hoverFade = 1.0;

    this._alphaMask = null;
    this._alphaMaskWidth = 0;
    this._alphaMaskHeight = 0;

    // Internal state for smoothing
    this._currentWindSpeed = 0.0;
    this._lastFrameTime = 0.0;

    this.params = {
      enabled: true,
      intensity: 1.0,

      // -- Wind Physics --
      windSpeedGlobal: 0.36,     // Multiplier for actual game wind speed (slightly stronger than bushes)
      windRampSpeed: 2.05,       // Inertia: heavier canopy, slower response
      gustFrequency: 0.002,      // Larger, more spread-out gusts for tall trees
      gustSpeed: 0.15,           // How fast the noise field scrolls

      // -- Tree Movement --
      branchBend: 0.013,         // Tree trunks bend less overall
      elasticity: 3.15,          // Heavier inertia than bushes

      // -- Leaf Flutter --
      flutterIntensity: 0.0001,  // Very subtle flutter for high canopy
      flutterSpeed: 1.5,         // Slightly slower flutter than bushes
      flutterScale: 0.01,        // Slightly larger clusters (bigger leaf groups)

      // -- Color --
      exposure: -2.0,
      brightness: 0.0,
      contrast: 1.03,
      saturation: 1.25,
      temperature: 0.0,
      tint: 0.0,

      // Shadow (cast onto scene via LightingEffect)
      shadowOpacity: 0.35,
      shadowLength: 0.08,
      shadowSoftness: 10.0
    };
  }

  _ensureAlphaMask() {
    if (!this.treeMask || !this.treeMask.image || this._alphaMask) return;

    try {
      const image = this.treeMask.image;
      let width = image.width;
      let height = image.height;
      if (!width || !height) return;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(image, 0, 0, width, height);
      const imgData = ctx.getImageData(0, 0, width, height);
      this._alphaMask = imgData.data;
      this._alphaMaskWidth = width;
      this._alphaMaskHeight = height;
    } catch (e) {
      // If anything fails, leave mask null and fall back to simple hit test.
      this._alphaMask = null;
      this._alphaMaskWidth = 0;
      this._alphaMaskHeight = 0;
    }
  }

  isUvOpaque(uv) {
    if (!uv) return true;
    this._ensureAlphaMask();
    if (!this._alphaMask || !this._alphaMaskWidth || !this._alphaMaskHeight) return true;

    let u = uv.x;
    let v = uv.y;
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;

    const x = Math.floor(u * (this._alphaMaskWidth - 1));
    const y = Math.floor(v * (this._alphaMaskHeight - 1));
    const index = (y * this._alphaMaskWidth + x) * 4;
    const alpha = this._alphaMask[index + 3] / 255;
    return alpha > 0.5;
  }

  setHoverHidden(hidden) {
    this._hoverHidden = !!hidden;
  }

  get enabled() { return this._enabled; }
  set enabled(value) {
    this._enabled = !!value;
    if (this.mesh) this.mesh.visible = !!value && !!this.treeMask;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'tree-phys',
          label: 'Wind Physics',
          type: 'inline',
          parameters: ['windSpeedGlobal', 'windRampSpeed', 'gustFrequency', 'gustSpeed', 'branchBend', 'elasticity']
        },
        {
          name: 'tree-flutter',
          label: 'Leaf Flutter',
          type: 'inline',
          parameters: ['flutterIntensity', 'flutterSpeed', 'flutterScale']
        },
        {
          name: 'tree-color',
          label: 'Color',
          type: 'folder',
          parameters: ['exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint']
        },
        {
          name: 'tree-shadow',
          label: 'Shadow',
          type: 'inline',
          parameters: ['shadowOpacity', 'shadowLength', 'shadowSoftness']
        }
      ],
      parameters: {
        intensity: { type: 'slider', min: 0.0, max: 2.0, default: 1.0 },
        windSpeedGlobal: { type: 'slider', label: 'Wind Strength', min: 0.0, max: 3.0, default: 0.36 },
        windRampSpeed: { type: 'slider', label: 'Wind Responsiveness', min: 0.1, max: 10.0, default: 2.05 },
        gustFrequency: { type: 'slider', label: 'Gust Spacing', min: 0.001, max: 0.1, default: 0.002 },
        gustSpeed: { type: 'slider', label: 'Gust Speed', min: 0.0, max: 2.0, default: 0.15 },
        branchBend: { type: 'slider', label: 'Branch Bend', min: 0.0, max: 0.1, step: 0.001, default: 0.013 },
        elasticity: { type: 'slider', label: 'Springiness', min: 0.5, max: 5.0, default: 3.15 },
        flutterIntensity: { type: 'slider', label: 'Leaf Flutter Amount', min: 0.0, max: 0.005, step: 0.0001, default: 0.0001 },
        flutterSpeed: { type: 'slider', label: 'Leaf Flutter Speed', min: 1.0, max: 20.0, default: 1.5 },
        flutterScale: { type: 'slider', label: 'Leaf Cluster Size', min: 0.005, max: 0.1, default: 0.01 },
        exposure: { type: 'slider', min: -2.0, max: 2.0, default: -2.0 },
        brightness: { type: 'slider', min: -0.5, max: 0.5, default: 0.0 },
        contrast: { type: 'slider', min: 0.5, max: 2.0, default: 1.03 },
        saturation: { type: 'slider', min: 0.0, max: 2.0, default: 1.25 },
        temperature: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 },
        tint: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 },
        shadowOpacity: { type: 'slider', label: 'Shadow Opacity', min: 0.0, max: 1.0, default: 0.35 },
        shadowLength: { type: 'slider', label: 'Shadow Length', min: 0.0, max: 0.2, default: 0.08 },
        shadowSoftness: { type: 'slider', label: 'Shadow Softness', min: 0.5, max: 10.0, default: 10.0 }
      }
    };
  }

  _createShadowMesh() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh || !this.treeMask) return;

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
        uTreeMask: { value: this.treeMask },
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
        uniform sampler2D uTreeMask;
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
          // --- Wind / Tree motion ---
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

          // Sample projected tree alpha (shadow source)
          vec4 treeSample = texture2D(uTreeMask, vUv - distortion);
          float a = treeSample.a;
          
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
              float v = texture2D(uTreeMask, blurUv - distortion).a;
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
      if (this.baseMesh && this.treeMask) {
        this._createShadowMesh();
      }
    }
    log.info('TreeEffect initialized');
  }

  setBaseMesh(baseMesh, assetBundle) {
    if (!assetBundle || !assetBundle.masks) return;
    this.baseMesh = baseMesh;

    const treeData = assetBundle.masks.find(m => m.id === 'tree' || m.type === 'tree');
    this.treeMask = treeData?.texture || null;

    if (!this.treeMask) {
      this.enabled = false;
      return;
    }
    if (this.scene) this._createMesh();
    if (this.shadowScene && this.treeMask) this._createShadowMesh();
  }

  _createMesh() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh || !this.treeMask) return;

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
        uTreeMask: { value: this.treeMask },
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

        uHoverFade: { value: 1.0 }
        // Note: No shadow reception uniforms (Tree is top-most)
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
        uniform sampler2D uTreeMask;
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

        uniform float uHoverFade;

        varying vec2 vUv;
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
          
          float gustNoise = noise(gustPos - scroll);
          float gustStrength = smoothstep(0.2, 0.8, gustNoise);

          // 3. Compute "Orbit" (Perpendicular Sway)
          vec2 perpDir = vec2(-windDir.y, windDir.x);
          
          float orbitPhase = uTime * uElasticity + (gustNoise * 5.0);
          float orbitSway = sin(orbitPhase);

          // 4. Combine Forces
          float pushMagnitude = gustStrength * uBranchBend * effectiveSpeed;
          float swayMagnitude = orbitSway * (uBranchBend * 0.4) * effectiveSpeed * (0.5 + 0.5 * gustStrength);

          // 5. Leaf Flutter
          float noiseVal = noise(vWorldPos * uFlutterScale);
          float flutterPhase = uTime * uFlutterSpeed * effectiveSpeed + noiseVal * 6.28;
          float flutter = sin(flutterPhase);
          float flutterMagnitude = flutter * uFlutterIntensity * (0.5 + 0.5 * gustStrength);

          vec2 distortion = (windDir * pushMagnitude) 
                          + (perpDir * swayMagnitude) 
                          + vec2(flutter, flutter) * flutterMagnitude;

          // Sample Texture
          vec4 treeSample = texture2D(uTreeMask, vUv - distortion);

          float a = treeSample.a * uIntensity * uHoverFade;
          if (a <= 0.001) discard;

          vec3 color = treeSample.rgb;
          color = applyCC(color);

          // No shadow reception - Trees are top canopy
          
          gl_FragColor = vec4(color, clamp(a, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true
    });

    this.mesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    this.mesh.position.copy(this.baseMesh.position);
    // Elevate tree layer above overhead tiles (z=20)
    this.mesh.position.z = 25.0; 
    
    this.mesh.rotation.copy(this.baseMesh.rotation);
    this.mesh.scale.copy(this.baseMesh.scale);
    this.mesh.renderOrder = (this.baseMesh.renderOrder || 0) + 20; // Ensure draw on top
    
    // ENABLE ROOF LAYER (20)
    // This ensures LightingEffect renders this into tRoofAlpha, which:
    // 1. Prevents ground shadows from darkening the tree (mix(shadow, 1.0, roofAlpha))
    // 2. Prevents ground lights from lighting the tree (sunlight only)
    this.mesh.layers.enable(20);

    this.scene.add(this.mesh);
    this.mesh.visible = this._enabled;
  }

  update(timeInfo) {
    if (!this.material || !this.mesh || !this._enabled) return;

    const u = this.material.uniforms;
    u.uTime.value = timeInfo.elapsed;
    
    const now = timeInfo.elapsed;
    const delta = now - (this._lastFrameTime || now);
    this._lastFrameTime = now;
    const safeDelta = Math.min(delta, 0.1); 

    const mapShine = window.MapShine || window.mapShine;

    // --- Weather Integration ---
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

    const dt = timeInfo.delta ?? safeDelta;
    const targetFade = this._hoverHidden ? 0.0 : 1.0;
    const currentFade = this._hoverFade;
    const diffFade = targetFade - currentFade;
    const absDiffFade = Math.abs(diffFade);

    if (absDiffFade > 0.0005) {
      const maxStep = dt / 2;
      const step = Math.sign(diffFade) * Math.min(absDiffFade, maxStep);
      this._hoverFade = currentFade + step;
    } else {
      this._hoverFade = targetFade;
    }

    u.uHoverFade.value = this._hoverFade;

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
      
      // Screen Space Shadows Setup
      const THREE = window.THREE;
      if (THREE && this.renderer) {
        const size = new THREE.Vector2();
        this.renderer.getDrawingBufferSize(size);
        if (su.uResolution) su.uResolution.value.set(size.x, size.y);
        if (su.uTexelSize) su.uTexelSize.value.set(1 / size.x, 1 / size.y);
      }
      
      // Sync sun direction
      try {
        const overhead = mapShine?.overheadShadowsEffect;
        if (su.uSunDir) {
          if (overhead && overhead.sunDir) {
            su.uSunDir.value.copy(overhead.sunDir);
          } else if (weatherController) {
            // Fallback time-of-day
            let hour = 12.0;
            try { if (typeof weatherController.timeOfDay === 'number') hour = weatherController.timeOfDay; } catch (e) {}
            const t = (hour % 24.0) / 24.0;
            const azimuth = (t - 0.5) * Math.PI;
            const lat = (overhead && overhead.params) ? (overhead.params.sunLatitude ?? 0.5) : 0.5;
            su.uSunDir.value.set(-Math.sin(azimuth), Math.cos(azimuth) * lat);
          }
        }
        if (su.uZoom && this.camera) {
           const dist = this.camera.position.z;
           su.uZoom.value = (dist > 0.1) ? (10000.0 / dist) : 1.0;
        }
      } catch (e) {}
    }
  }

  render(renderer, scene, camera) {
    if (!this.enabled || !this.shadowMaterial || !this.shadowScene) return;

    const THREE = window.THREE;
    if (!THREE) return;

    const size = new THREE.Vector2();
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

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this.shadowScene, this.camera);
    renderer.setRenderTarget(previousTarget);
  }
}
