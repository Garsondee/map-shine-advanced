/**
 * @fileoverview Cloud Effect - Procedural cloud shadows and optional cloud tops
 * Generates cloud density and shadow textures for atmospheric effects.
 * @module effects/CloudEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('CloudEffect');

/**
 * Cloud Effect - Procedural cloud system
 * 
 * Generates:
 * - cloudDensityTarget: Raw cloud coverage texture
 * - cloudShadowTarget: Shadow factor texture (1.0 = lit, 0.0 = shadowed)
 * 
 * Features:
 * - World-space coordinates (clouds pinned to map, not camera)
 * - Time-of-day shadow offset (sun direction alignment)
 * - Wind-driven cloud drift
 * - Multi-layer noise for natural cloud shapes
 * - Zoom-dependent cloud top visibility
 */
export class CloudEffect extends EffectBase {
  constructor() {
    super('cloud', RenderLayers.ENVIRONMENTAL, 'low');

    this.priority = 5; // Before OverheadShadowsEffect (10)
    this.alwaysRender = true;

    /** @type {THREE.ShaderMaterial|null} */
    this.densityMaterial = null;

    /** @type {THREE.ShaderMaterial|null} */
    this.shadowMaterial = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.cloudDensityTarget = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.cloudShadowTarget = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.cloudTopTarget = null;

    /** @type {THREE.ShaderMaterial|null} */
    this.cloudTopMaterial = null;

    /** @type {THREE.Scene|null} */
    this.quadScene = null;

    /** @type {THREE.OrthographicCamera|null} */
    this.quadCamera = null;

    /** @type {THREE.Mesh|null} */
    this.quadMesh = null;

    /** @type {THREE.Mesh|null} */
    this.baseMesh = null;

    /** @type {THREE.Texture|null} */
    this.outdoorsMask = null;

    /** @type {THREE.Vector2|null} */
    this.sunDir = null;

    // Accumulated wind offset for cloud drift
    this._windOffset = null; // Lazy init as THREE.Vector2

    this.params = {
      enabled: true,

      // Cloud generation
      cloudCover: 0.5,        // Base cloud coverage (0-1), driven by WeatherController
      noiseScale: 2.0,        // Scale of noise pattern (higher = smaller clouds)
      noiseDetail: 4,         // Number of noise octaves (1-6)
      cloudSharpness: 0.5,    // Edge sharpness (0 = soft, 1 = hard)
      cloudBrightness: 1.0,   // Cloud top brightness

      // Shadow settings
      shadowOpacity: 0.4,     // How dark cloud shadows are
      shadowSoftness: 2.0,    // Blur amount for shadow edges
      shadowOffsetScale: 0.1, // How far shadows offset based on sun angle

      // Cloud top visibility (zoom-dependent)
      cloudTopOpacity: 0.3,   // Max opacity of visible cloud layer (0 = shadows only)
      cloudTopFadeStart: 0.3, // Zoom level where cloud tops start appearing
      cloudTopFadeEnd: 0.8,   // Zoom level where cloud tops are fully visible

      // Wind drift
      windInfluence: 1.0,     // How much wind affects cloud movement
      driftSpeed: 0.02,       // Base drift speed multiplier

      // Minimum shadow brightness (prevents crushing blacks)
      minShadowBrightness: 0.25
    };

    // Performance: reusable objects
    this._tempSize = null;
    this._lastUpdateHash = null;
  }

  /**
   * Receive base mesh and asset bundle for outdoors mask access.
   * @param {THREE.Mesh} baseMesh
   * @param {MapAssetBundle} assetBundle
   */
  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;
    if (assetBundle?.masks) {
      const outdoorsData = assetBundle.masks.find(m => m.id === 'outdoors' || m.type === 'outdoors');
      this.outdoorsMask = outdoorsData?.texture || null;
    }
  }

  /**
   * UI control schema for Tweakpane
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'cloud-generation',
          label: 'Cloud Generation',
          type: 'inline',
          parameters: ['noiseScale', 'noiseDetail', 'cloudSharpness']
        },
        {
          name: 'shadow-settings',
          label: 'Cloud Shadows',
          type: 'inline',
          separator: true,
          parameters: ['shadowOpacity', 'shadowSoftness', 'shadowOffsetScale', 'minShadowBrightness']
        },
        {
          name: 'cloud-tops',
          label: 'Cloud Tops (Zoom)',
          type: 'inline',
          separator: true,
          parameters: ['cloudTopOpacity', 'cloudTopFadeStart', 'cloudTopFadeEnd']
        },
        {
          name: 'wind',
          label: 'Wind & Drift',
          type: 'inline',
          separator: true,
          parameters: ['windInfluence', 'driftSpeed']
        }
      ],
      parameters: {
        noiseScale: {
          type: 'slider',
          label: 'Cloud Scale',
          min: 0.5,
          max: 8.0,
          step: 0.1,
          default: 2.0
        },
        noiseDetail: {
          type: 'slider',
          label: 'Detail (Octaves)',
          min: 1,
          max: 6,
          step: 1,
          default: 4
        },
        cloudSharpness: {
          type: 'slider',
          label: 'Edge Sharpness',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5
        },
        shadowOpacity: {
          type: 'slider',
          label: 'Shadow Darkness',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.4
        },
        shadowSoftness: {
          type: 'slider',
          label: 'Shadow Softness',
          min: 0.5,
          max: 10.0,
          step: 0.1,
          default: 3.0
        },
        shadowOffsetScale: {
          type: 'slider',
          label: 'Shadow Offset',
          min: 0.0,
          max: 0.3,
          step: 0.01,
          default: 0.1
        },
        minShadowBrightness: {
          type: 'slider',
          label: 'Min Brightness',
          min: 0.0,
          max: 0.5,
          step: 0.01,
          default: 0.25
        },
        cloudTopOpacity: {
          type: 'slider',
          label: 'Cloud Top Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.0
        },
        cloudTopFadeStart: {
          type: 'slider',
          label: 'Fade Start Zoom',
          min: 0.1,
          max: 1.0,
          step: 0.01,
          default: 0.3
        },
        cloudTopFadeEnd: {
          type: 'slider',
          label: 'Fade End Zoom',
          min: 0.1,
          max: 1.0,
          step: 0.01,
          default: 0.8
        },
        windInfluence: {
          type: 'slider',
          label: 'Wind Influence',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0
        },
        driftSpeed: {
          type: 'slider',
          label: 'Drift Speed',
          min: 0.0,
          max: 0.1,
          step: 0.001,
          default: 0.02
        }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE not available during initialization');
      return;
    }

    this.renderer = renderer;
    this.mainScene = scene;
    this.mainCamera = camera;

    // Initialize wind offset
    this._windOffset = new THREE.Vector2(0, 0);

    // Create quad scene for full-screen passes
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Create cloud density material with procedural noise
    this._createDensityMaterial();

    // Create shadow material (samples density with offset + blur)
    this._createShadowMaterial();

    // Create cloud top material (visible cloud layer with zoom fade)
    this._createCloudTopMaterial();

    // Create quad mesh
    const quadGeometry = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(quadGeometry, this.densityMaterial);
    this.quadScene.add(this.quadMesh);

    log.info('CloudEffect initialized');
  }

  /**
   * Create the cloud density generation material.
   * Uses layered simplex noise for natural cloud shapes.
   * @private
   */
  _createDensityMaterial() {
    const THREE = window.THREE;

    this.densityMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uCloudCover: { value: this.params.cloudCover },
        uNoiseScale: { value: this.params.noiseScale },
        uNoiseDetail: { value: this.params.noiseDetail },
        uCloudSharpness: { value: this.params.cloudSharpness },
        uWindOffset: { value: new THREE.Vector2(0, 0) },
        uResolution: { value: new THREE.Vector2(1024, 1024) },

        // World-space coordinate conversion (view bounds in world coords)
        uViewBoundsMin: { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax: { value: new THREE.Vector2(1, 1) },
        uSceneSize: { value: new THREE.Vector2(1, 1) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uCloudCover;
        uniform float uNoiseScale;
        uniform float uNoiseDetail;
        uniform float uCloudSharpness;
        uniform vec2 uWindOffset;
        uniform vec2 uResolution;
        uniform vec2 uViewBoundsMin;
        uniform vec2 uViewBoundsMax;
        uniform vec2 uSceneSize;

        varying vec2 vUv;

        // Simplex 2D noise
        vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }

        float snoise(vec2 v) {
          const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                             -0.577350269189626, 0.024390243902439);
          vec2 i  = floor(v + dot(v, C.yy));
          vec2 x0 = v - i + dot(i, C.xx);
          vec2 i1;
          i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
          vec4 x12 = x0.xyxy + C.xxzz;
          x12.xy -= i1;
          i = mod(i, 289.0);
          vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                         + i.x + vec3(0.0, i1.x, 1.0));
          vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
                                  dot(x12.zw,x12.zw)), 0.0);
          m = m*m;
          m = m*m;
          vec3 x = 2.0 * fract(p * C.www) - 1.0;
          vec3 h = abs(x) - 0.5;
          vec3 ox = floor(x + 0.5);
          vec3 a0 = x - ox;
          m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
          vec3 g;
          g.x = a0.x * x0.x + h.x * x0.y;
          g.yz = a0.yz * x12.xz + h.yz * x12.yw;
          return 130.0 * dot(m, g);
        }

        // Fractal Brownian Motion (layered noise)
        float fbm(vec2 p, int octaves) {
          float value = 0.0;
          float amplitude = 0.5;
          float frequency = 1.0;
          float maxValue = 0.0;

          for (int i = 0; i < 6; i++) {
            if (i >= octaves) break;
            value += amplitude * snoise(p * frequency);
            maxValue += amplitude;
            amplitude *= 0.5;
            frequency *= 2.0;
          }

          return value / maxValue;
        }

        void main() {
          // Convert screen UV to world-space UV using view bounds
          // vUv (0,0)-(1,1) maps to the visible world rectangle
          // This ensures clouds are pinned to the ground with ZERO parallax
          vec2 worldPos = mix(uViewBoundsMin, uViewBoundsMax, vUv);
          vec2 worldUV = worldPos / uSceneSize;

          // Apply wind offset for drift (NO sun offset here - that's applied in shadow pass)
          vec2 driftedUV = worldUV + uWindOffset;

          // Scale for noise sampling - NO fract() to avoid visible tile boundaries
          // Simplex noise handles large coordinates naturally
          vec2 noiseUV = driftedUV * uNoiseScale;

          // Generate cloud density using FBM
          int octaves = int(uNoiseDetail);
          float noise = fbm(noiseUV * 4.0 + uTime * 0.01, octaves);

          // Remap noise from [-1, 1] to [0, 1]
          noise = noise * 0.5 + 0.5;

          // Apply cloud cover threshold
          // Higher cloudCover = more of the noise passes through
          float threshold = 1.0 - uCloudCover;
          float cloud = smoothstep(threshold - 0.1, threshold + 0.1, noise);

          // Apply sharpness
          float sharpMix = uCloudSharpness;
          float softCloud = cloud;
          float hardCloud = step(threshold, noise);
          cloud = mix(softCloud, hardCloud, sharpMix);

          // Output: R = cloud density, G = unused, B = unused, A = 1
          gl_FragColor = vec4(cloud, cloud, cloud, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false
    });
  }

  /**
   * Create the shadow generation material.
   * Samples cloud density with sun-direction offset and applies blur.
   * @private
   */
  _createShadowMaterial() {
    const THREE = window.THREE;

    this.shadowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tCloudDensity: { value: null },
        tOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uShadowOpacity: { value: this.params.shadowOpacity },
        uShadowSoftness: { value: this.params.shadowSoftness },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uZoom: { value: 1.0 },
        uMinBrightness: { value: this.params.minShadowBrightness },
        // Sun offset for shadow displacement (in UV space)
        uShadowOffsetUV: { value: new THREE.Vector2(0, 0) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tCloudDensity;
        uniform sampler2D tOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uShadowOpacity;
        uniform float uShadowSoftness;
        uniform vec2 uTexelSize;
        uniform float uZoom;
        uniform float uMinBrightness;
        uniform vec2 uShadowOffsetUV;

        varying vec2 vUv;

        void main() {
          // Apply sun offset when sampling density for shadows
          // This creates the shadow displacement effect
          vec2 shadowUV = vUv + uShadowOffsetUV;

          // Apply blur for soft shadow edges
          // Scale blur by zoom so softness is consistent in world space
          float blurPixels = uShadowSoftness * 20.0 * uZoom;
          vec2 stepUv = uTexelSize * blurPixels;

          float accum = 0.0;
          float weightSum = 0.0;

          // 3x3 blur kernel - sample around the OFFSET position
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              vec2 sUv = shadowUV + vec2(float(dx), float(dy)) * stepUv;
              float w = 1.0;
              if (dx == 0 && dy == 0) w = 2.0; // Center bias
              float v = texture2D(tCloudDensity, sUv).r;
              accum += v * w;
              weightSum += w;
            }
          }

          float blurredDensity = accum / max(weightSum, 0.001);

          // Calculate shadow factor (1.0 = fully lit, 0.0 = fully shadowed)
          float shadowStrength = blurredDensity * uShadowOpacity;
          float shadowFactor = 1.0 - shadowStrength;

          // Apply minimum brightness floor to prevent crushing blacks
          shadowFactor = max(shadowFactor, uMinBrightness);

          // Apply outdoors mask LAST (after blur) to prevent bleeding into interiors
          if (uHasOutdoorsMask > 0.5) {
            float outdoors = texture2D(tOutdoorsMask, vUv).r;
            // Only apply shadow outdoors; indoors get full brightness (1.0)
            shadowFactor = mix(1.0, shadowFactor, outdoors);
          }

          gl_FragColor = vec4(shadowFactor, shadowFactor, shadowFactor, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false
    });
  }

  /**
   * Create the cloud top material.
   * Renders cloud density as a visible white overlay with zoom-based fade.
   * Uses normalized zoom (0-1 range based on zoom limits) for map-size independence.
   * @private
   */
  _createCloudTopMaterial() {
    const THREE = window.THREE;

    this.cloudTopMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tCloudDensity: { value: null },
        tOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uCloudTopOpacity: { value: this.params.cloudTopOpacity },
        uNormalizedZoom: { value: 0.5 },
        uFadeStart: { value: this.params.cloudTopFadeStart },
        uFadeEnd: { value: this.params.cloudTopFadeEnd },
        uCloudColor: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
        uSkyTint: { value: new THREE.Vector3(0.9, 0.95, 1.0) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tCloudDensity;
        uniform sampler2D tOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uCloudTopOpacity;
        uniform float uNormalizedZoom;
        uniform float uFadeStart;
        uniform float uFadeEnd;
        uniform vec3 uCloudColor;
        uniform vec3 uSkyTint;

        varying vec2 vUv;

        void main() {
          // Sample cloud density (no sun offset - we want clouds directly overhead)
          float density = texture2D(tCloudDensity, vUv).r;

          // Calculate zoom-based fade
          // When zoomed OUT (low normalizedZoom), clouds are visible
          // When zoomed IN (high normalizedZoom), clouds fade out
          // This creates the effect of being "under" the clouds when zoomed in
          float zoomFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, uNormalizedZoom);

          // Soft cloud edges with density threshold
          float cloudAlpha = smoothstep(0.2, 0.6, density);

          // Final alpha combines density, zoom fade, and user opacity
          float alpha = cloudAlpha * zoomFade * uCloudTopOpacity;

          // Cloud color with slight sky tint for realism
          vec3 color = mix(uSkyTint, uCloudColor, density * 0.5 + 0.5);

          // Apply outdoors mask - only show cloud tops outdoors
          if (uHasOutdoorsMask > 0.5) {
            float outdoors = texture2D(tOutdoorsMask, vUv).r;
            alpha *= outdoors;
          }

          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending
    });
  }

  /**
   * Get effective zoom level from camera.
   * @returns {number} Zoom level (1.0 = default)
   * @private
   */
  _getEffectiveZoom() {
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer?.currentZoom !== undefined) {
      return sceneComposer.currentZoom;
    }

    if (!this.mainCamera) return 1.0;

    if (this.mainCamera.isOrthographicCamera) {
      return this.mainCamera.zoom;
    }

    const baseDist = 10000.0;
    const dist = this.mainCamera.position.z;
    return (dist > 0.1) ? (baseDist / dist) : 1.0;
  }

  /**
   * Calculate sun direction from time of day.
   * @returns {THREE.Vector2} Normalized sun direction
   * @private
   */
  _calculateSunDirection() {
    const THREE = window.THREE;
    if (!THREE) return null;

    let hour = 12.0;
    try {
      if (weatherController && typeof weatherController.timeOfDay === 'number') {
        hour = weatherController.timeOfDay;
      }
    } catch (e) {
      // Fallback to noon
    }

    // Map hour to sun azimuth (same logic as OverheadShadowsEffect)
    const t = (hour % 24.0) / 24.0;
    const azimuth = (t - 0.5) * Math.PI;

    const x = -Math.sin(azimuth);
    const y = Math.cos(azimuth) * 0.3; // Slight vertical component

    if (!this.sunDir) {
      this.sunDir = new THREE.Vector2(x, y);
    } else {
      this.sunDir.set(x, y);
    }

    return this.sunDir;
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (!width || !height || !THREE) return;

    // Cloud density render target
    if (!this.cloudDensityTarget) {
      this.cloudDensityTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.cloudDensityTarget.setSize(width, height);
    }

    // Cloud shadow render target
    if (!this.cloudShadowTarget) {
      this.cloudShadowTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.cloudShadowTarget.setSize(width, height);
    }

    // Cloud top render target (RGBA for alpha blending)
    if (!this.cloudTopTarget) {
      this.cloudTopTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.cloudTopTarget.setSize(width, height);
    }

    // Update material uniforms
    if (this.densityMaterial?.uniforms) {
      this.densityMaterial.uniforms.uResolution.value.set(width, height);
    }

    if (this.shadowMaterial?.uniforms) {
      this.shadowMaterial.uniforms.uTexelSize.value.set(1 / width, 1 / height);
    }
  }

  update(timeInfo) {
    if (!this.densityMaterial || !this.shadowMaterial || !this.enabled) return;

    const THREE = window.THREE;
    if (!THREE) return;

    // Get weather state
    let cloudCover = this.params.cloudCover;
    let windSpeed = 0.07;
    let windDirX = 1.0;
    let windDirY = 0.0;

    try {
      const state = weatherController?.getCurrentState?.();
      if (state) {
        cloudCover = state.cloudCover ?? cloudCover;
        windSpeed = state.windSpeed ?? windSpeed;
        if (state.windDirection) {
          windDirX = state.windDirection.x ?? windDirX;
          windDirY = state.windDirection.y ?? windDirY;
        }
      }
    } catch (e) {
      // Use defaults
    }

    // Update wind offset for cloud drift
    const delta = timeInfo?.delta ?? 0.016;
    const driftAmount = windSpeed * this.params.windInfluence * this.params.driftSpeed * delta;
    this._windOffset.x += windDirX * driftAmount;
    this._windOffset.y += windDirY * driftAmount;

    // Wrap wind offset to prevent floating point issues over long sessions
    this._windOffset.x = this._windOffset.x % 100.0;
    this._windOffset.y = this._windOffset.y % 100.0;

    // Calculate sun direction for shadow offset
    this._calculateSunDirection();

    // Get scene dimensions for world-space coordinates
    const sceneRect = canvas?.dimensions?.sceneRect;
    const sceneWidth = sceneRect?.width ?? 4000;
    const sceneHeight = sceneRect?.height ?? 3000;

    // Calculate view bounds in world coordinates for ZERO PARALLAX shadows.
    // Use the Three.js camera + sceneComposer zoom, which are already
    // synchronized with Foundry via the camera follower.
    const sceneComposer = window.MapShine?.sceneComposer;
    let viewMinX = 0;
    let viewMinY = 0;
    let viewMaxX = sceneWidth;
    let viewMaxY = sceneHeight;

    if (sceneComposer && this.mainCamera) {
      const zoom = sceneComposer.currentZoom || 1.0;
      const viewportWidth = sceneComposer.baseViewportWidth || window.innerWidth;
      const viewportHeight = sceneComposer.baseViewportHeight || window.innerHeight;

      // At zoom=1, viewport pixels = world units. At other zooms, visible
      // world size = viewport / zoom.
      const visibleWorldWidth = viewportWidth / zoom;
      const visibleWorldHeight = viewportHeight / zoom;

      // Camera center in world coords
      const camX = this.mainCamera.position.x;
      const camY = this.mainCamera.position.y;

      // View bounds centered on camera
      viewMinX = camX - visibleWorldWidth / 2;
      viewMinY = camY - visibleWorldHeight / 2;
      viewMaxX = camX + visibleWorldWidth / 2;
      viewMaxY = camY + visibleWorldHeight / 2;
    }

    // Update density material uniforms
    const du = this.densityMaterial.uniforms;
    du.uTime.value = timeInfo?.elapsed ?? 0;
    du.uCloudCover.value = cloudCover;
    du.uNoiseScale.value = this.params.noiseScale;
    du.uNoiseDetail.value = this.params.noiseDetail;
    du.uCloudSharpness.value = this.params.cloudSharpness;
    du.uWindOffset.value.copy(this._windOffset);
    du.uSceneSize.value.set(sceneWidth, sceneHeight);
    du.uViewBoundsMin.value.set(viewMinX, viewMinY);
    du.uViewBoundsMax.value.set(viewMaxX, viewMaxY);

    const zoom = this._getEffectiveZoom();

    // Update shadow material uniforms
    const su = this.shadowMaterial.uniforms;
    su.uShadowOpacity.value = this.params.shadowOpacity;
    su.uShadowSoftness.value = this.params.shadowSoftness;
    su.uMinBrightness.value = this.params.minShadowBrightness;
    su.uZoom.value = zoom;

    // Calculate sun offset in UV SPACE for shadow displacement
    // The offset is applied when sampling the density texture in the shadow pass
    // This separates shadow position from cloud top position
    const offsetWorldUnits = this.params.shadowOffsetScale * 5000.0;
    if (this.sunDir) {
      // Convert world offset to UV offset based on visible view size
      const viewWidth = viewMaxX - viewMinX;
      const viewHeight = viewMaxY - viewMinY;
      const offsetUVx = (this.sunDir.x * offsetWorldUnits) / viewWidth;
      const offsetUVy = (this.sunDir.y * offsetWorldUnits) / viewHeight;
      su.uShadowOffsetUV.value.set(offsetUVx, offsetUVy);
    }

    // Set outdoors mask for shadow material
    const le = window.MapShine?.lightingEffect;
    if (le?.outdoorsTarget) {
      su.tOutdoorsMask.value = le.outdoorsTarget.texture;
      su.uHasOutdoorsMask.value = 1.0;
    } else if (this.outdoorsMask) {
      su.tOutdoorsMask.value = this.outdoorsMask;
      su.uHasOutdoorsMask.value = 1.0;
    } else {
      su.uHasOutdoorsMask.value = 0.0;
    }

    // Update cloud top material uniforms
    if (this.cloudTopMaterial) {
      const tu = this.cloudTopMaterial.uniforms;
      tu.uCloudTopOpacity.value = this.params.cloudTopOpacity;
      tu.uFadeStart.value = this.params.cloudTopFadeStart;
      tu.uFadeEnd.value = this.params.cloudTopFadeEnd;

      // Calculate normalized zoom (0-1 range based on zoom limits)
      // This makes cloud top fade independent of map size
      const limits = sceneComposer?.getZoomLimits?.() ?? { min: 0.1, max: 3.0 };
      const normalizedZoom = (zoom - limits.min) / (limits.max - limits.min);
      tu.uNormalizedZoom.value = Math.max(0, Math.min(1, normalizedZoom));

      // Set outdoors mask for cloud top material
      if (le?.outdoorsTarget) {
        tu.tOutdoorsMask.value = le.outdoorsTarget.texture;
        tu.uHasOutdoorsMask.value = 1.0;
      } else if (this.outdoorsMask) {
        tu.tOutdoorsMask.value = this.outdoorsMask;
        tu.uHasOutdoorsMask.value = 1.0;
      } else {
        tu.uHasOutdoorsMask.value = 0.0;
      }
    }
  }

  render(renderer, scene, camera) {
    if (!this.enabled || !this.densityMaterial || !this.shadowMaterial) return;

    const THREE = window.THREE;
    if (!THREE || !this.quadScene || !this.quadCamera) return;

    // Ensure render targets exist
    if (!this._tempSize) this._tempSize = new THREE.Vector2();
    renderer.getDrawingBufferSize(this._tempSize);
    const width = this._tempSize.x;
    const height = this._tempSize.y;

    if (!this.cloudDensityTarget || !this.cloudShadowTarget) {
      this.onResize(width, height);
    } else if (this.cloudDensityTarget.width !== width || this.cloudDensityTarget.height !== height) {
      this.onResize(width, height);
    }

    const previousTarget = renderer.getRenderTarget();

    // Pass 1: Generate cloud density
    this.quadMesh.material = this.densityMaterial;
    renderer.setRenderTarget(this.cloudDensityTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(this.quadScene, this.quadCamera);

    // Pass 2: Generate cloud shadow from density
    this.shadowMaterial.uniforms.tCloudDensity.value = this.cloudDensityTarget.texture;
    this.quadMesh.material = this.shadowMaterial;
    renderer.setRenderTarget(this.cloudShadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this.quadScene, this.quadCamera);

    // Pass 3: Generate cloud tops (visible cloud layer with zoom fade)
    if (this.cloudTopMaterial && this.cloudTopTarget) {
      this.cloudTopMaterial.uniforms.tCloudDensity.value = this.cloudDensityTarget.texture;
      this.quadMesh.material = this.cloudTopMaterial;
      renderer.setRenderTarget(this.cloudTopTarget);
      renderer.setClearColor(0x000000, 0); // Transparent background
      renderer.clear();
      renderer.render(this.quadScene, this.quadCamera);
    }

    // Restore previous render target
    renderer.setRenderTarget(previousTarget);
  }

  dispose() {
    if (this.cloudDensityTarget) {
      this.cloudDensityTarget.dispose();
      this.cloudDensityTarget = null;
    }
    if (this.cloudShadowTarget) {
      this.cloudShadowTarget.dispose();
      this.cloudShadowTarget = null;
    }
    if (this.cloudTopTarget) {
      this.cloudTopTarget.dispose();
      this.cloudTopTarget = null;
    }
    if (this.densityMaterial) {
      this.densityMaterial.dispose();
      this.densityMaterial = null;
    }
    if (this.shadowMaterial) {
      this.shadowMaterial.dispose();
      this.shadowMaterial = null;
    }
    if (this.cloudTopMaterial) {
      this.cloudTopMaterial.dispose();
      this.cloudTopMaterial = null;
    }
    if (this.quadMesh && this.quadScene) {
      this.quadScene.remove(this.quadMesh);
      this.quadMesh.geometry?.dispose();
      this.quadMesh = null;
    }
    this.quadScene = null;
    this.quadCamera = null;

    log.info('CloudEffect disposed');
  }
}
