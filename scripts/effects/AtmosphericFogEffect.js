/**
 * @fileoverview Atmospheric Fog Effect - Weather-driven distance fog
 * Renders distance-based atmospheric fog controlled by weatherController.fogDensity
 * @module effects/AtmosphericFogEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('AtmosphericFogEffect');

/**
 * Atmospheric Fog Effect
 * 
 * Renders distance-based fog as a post-processing pass.
 * Fog density is driven by weatherController.currentState.fogDensity.
 * 
 * Features:
 * - Distance-based fog falloff from camera/view center
 * - Configurable fog color (defaults to scene ambient or white)
 * - Respects indoor/outdoor mask to avoid fogging indoors
 * - Smooth transitions via weatherController interpolation
 */
export class AtmosphericFogEffect extends EffectBase {
  constructor() {
    super('atmospheric-fog', RenderLayers.POST_PROCESSING, 'low');

    this.priority = 5; // After main scene, before bloom
    this.alwaysRender = false;

    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;

    /** @type {THREE.Scene|null} */
    this.quadScene = null;

    /** @type {THREE.OrthographicCamera|null} */
    this.quadCamera = null;

    /** @type {THREE.Mesh|null} */
    this.quadMesh = null;

    /** @type {THREE.Texture|null} */
    this.outdoorsMask = null;

    this.params = {
      enabled: true,
      
      // Fog appearance
      fogColor: '#c8d0d8',      // Slightly blue-gray fog
      fogColorNight: '#1a1a2e', // Darker blue at night
      skyTintStrength: 0.0,
      nightColorStrength: 2.0,
      darknessStrength: 1.0,
      darknessColorMin: 0.25,

      // Fog behavior
      maxOpacity: 0.6,          // Maximum fog opacity at full density
      falloffStart: 0.1,        // Distance (0-1 of scene) where fog starts
      falloffEnd: 0.9,          // Distance (0-1 of scene) where fog reaches max
      
      // Indoor masking
      useIndoorMask: true,      // Respect outdoor mask to avoid indoor fog
      indoorFogReduction: 0.9,  // How much to reduce fog indoors (0 = full fog, 1 = no fog)
      indoorBufferPx: 80,       
      indoorSoftnessPx: 140,
      
      // Noise for organic look
      noiseEnabled: true,
      noiseScale: 2.0,
      noiseStrength: 0.15,
      noiseSpeed: 0.05,
      noiseWarpStrength: 1.25,
      noiseContrast: 1.35,
      advectionSpeed: 1.0,
      windDirResponsiveness: 6.0,
      curlStrength: 0.55,
      curlScale: 1.0,

      evolveSpeed: 0.25,
      evolveStrength: 0.85,
      evolveScale: 0.75,

      cutoutEnabled: true,
      cutoutScale: 0.22,
      cutoutStrength: 0.65,
      cutoutSpeed: 0.02,
      cutoutContrast: 1.25
    };

    this._initialized = false;

    /** @type {THREE.DataTexture|null} */
    this._fallbackOutdoors = null;

    /** @type {number} */
    this._lastFogDensity = 0.0;

    this._lastTimeValue = null;
    this._windTime = 0.0;
    this._windOffsetNoise = null;
    this._smoothedWindDir = null;
    this._tempWindTarget = null;

    this._evolveTime = 0.0;

    /** @type {function|null} Unsubscribe from EffectMaskRegistry */
    this._registryUnsub = null;
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'fog',
          label: 'Atmospheric Fog',
          type: 'inline',
          parameters: ['fogColor', 'fogColorNight', 'skyTintStrength', 'nightColorStrength', 'darknessStrength', 'darknessColorMin', 'maxOpacity', 'falloffStart', 'falloffEnd', 'useIndoorMask']
        },
        {
          name: 'mask',
          label: 'Mask Falloff',
          type: 'inline',
          parameters: ['indoorFogReduction', 'indoorBufferPx', 'indoorSoftnessPx']
        },
        {
          name: 'noise',
          label: 'Fog Noise',
          type: 'inline',
          parameters: ['noiseEnabled', 'noiseScale', 'noiseStrength', 'noiseSpeed', 'advectionSpeed', 'windDirResponsiveness', 'noiseWarpStrength', 'noiseContrast', 'curlStrength', 'curlScale']
        },
        {
          name: 'evolution',
          label: 'Noise Evolution',
          type: 'inline',
          parameters: ['evolveSpeed', 'evolveStrength', 'evolveScale']
        },
        {
          name: 'cutout',
          label: 'Cutout Noise (Low Density)',
          type: 'inline',
          parameters: ['cutoutEnabled', 'cutoutScale', 'cutoutStrength', 'cutoutSpeed', 'cutoutContrast']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        fogColor: { type: 'color', default: '#c8d0d8', label: 'Fog Color' },
        fogColorNight: { type: 'color', default: '#1a1a2e', label: 'Night Fog Color' },
        skyTintStrength: { type: 'slider', min: 0, max: 10, step: 0.05, default: 0.0, label: 'Sky Tint Strength' },
        nightColorStrength: { type: 'slider', min: 0, max: 10, step: 0.05, default: 2.0, label: 'Night Color Strength' },
        darknessStrength: { type: 'slider', min: 0, max: 10, step: 0.05, default: 1.0, label: 'Darkness Strength' },
        darknessColorMin: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.25, label: 'Darkness Min Color' },
        maxOpacity: { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.85, label: 'Max Opacity' },
        falloffStart: { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.1, label: 'Falloff Start' },
        falloffEnd: { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.9, label: 'Falloff End' },
        useIndoorMask: { type: 'boolean', default: true, label: 'Reduce Indoors' },
        indoorFogReduction: { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.9, label: 'Indoor Reduction' },
        indoorBufferPx: { type: 'slider', min: 0, max: 400, step: 5, default: 80, label: 'Building Buffer (px)' },
        indoorSoftnessPx: { type: 'slider', min: 0, max: 600, step: 5, default: 140, label: 'Buffer Softness (px)' },
        noiseEnabled: { type: 'boolean', default: true, label: 'Enable Noise' },
        noiseScale: { type: 'slider', min: 0.5, max: 10, step: 0.5, default: 2.0, label: 'Noise Scale' },
        noiseStrength: { type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.15, label: 'Noise Strength' },
        noiseSpeed: { type: 'slider', min: 0, max: 0.2, step: 0.01, default: 0.05, label: 'Noise Speed' },
        advectionSpeed: { type: 'slider', min: 0, max: 4, step: 0.05, default: 1.0, label: 'Advection Speed' },
        windDirResponsiveness: { type: 'slider', min: 0.1, max: 10, step: 0.1, default: 6.0, label: 'Wind Responsiveness' },
        noiseWarpStrength: { type: 'slider', min: 0, max: 4, step: 0.05, default: 1.25, label: 'Warp Strength' },
        noiseContrast: { type: 'slider', min: 0.5, max: 2.5, step: 0.05, default: 1.35, label: 'Noise Contrast' },
        curlStrength: { type: 'slider', min: 0, max: 3, step: 0.05, default: 0.55, label: 'Curl Strength' },
        curlScale: { type: 'slider', min: 0.1, max: 6, step: 0.05, default: 1.0, label: 'Curl Scale' },

        evolveSpeed: { type: 'slider', min: 0, max: 2.0, step: 0.01, default: 0.25, label: 'Evolve Speed' },
        evolveStrength: { type: 'slider', min: 0, max: 2.0, step: 0.01, default: 0.85, label: 'Evolve Strength' },
        evolveScale: { type: 'slider', min: 0.1, max: 2.0, step: 0.01, default: 0.75, label: 'Evolve Scale' },

        cutoutEnabled: { type: 'boolean', default: true, label: 'Enable Cutout' },
        cutoutScale: { type: 'slider', min: 0.02, max: 1.0, step: 0.01, default: 0.22, label: 'Cutout Scale' },
        cutoutStrength: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.65, label: 'Cutout Strength' },
        cutoutSpeed: { type: 'slider', min: 0, max: 0.2, step: 0.01, default: 0.02, label: 'Cutout Speed' },
        cutoutContrast: { type: 'slider', min: 0.5, max: 3.0, step: 0.05, default: 1.25, label: 'Cutout Contrast' }
      }
    };
  }

  initialize(renderer, scene, camera) {
    if (this._initialized) return;

    this.renderer = renderer;
    this.mainScene = scene;
    this.camera = camera;

    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE not available');
      return;
    }

    // Create quad scene for post-processing
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Fallback outdoors mask (treat everything as outdoors = 1.0)
    // This prevents shader sampling from a null texture if the roof/outdoor mask
    // is not available yet.
    const outdoorsData = new Uint8Array([255, 255, 255, 255]);
    this._fallbackOutdoors = new THREE.DataTexture(outdoorsData, 1, 1, THREE.RGBAFormat);
    this._fallbackOutdoors.needsUpdate = true;

    this._windOffsetNoise = new THREE.Vector2(0, 0);
    this._smoothedWindDir = new THREE.Vector2(1, 0);
    this._tempWindTarget = new THREE.Vector2(1, 0);

    this._evolveTime = 0.0;

    // Create shader material
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tOutdoors: { value: this._fallbackOutdoors },
        tRoofDistance: { value: this._fallbackOutdoors },
        uFogColor: { value: new THREE.Color(0xc8d0d8) },
        uFogDensity: { value: 0.0 },
        uMaxOpacity: { value: 0.85 },
        uFalloffStart: { value: 0.1 },
        uFalloffEnd: { value: 0.9 },
        uUseIndoorMask: { value: 1.0 },
        uIndoorFogReduction: { value: 0.9 },
        uIndoorBufferPx: { value: 80.0 },
        uIndoorSoftnessPx: { value: 140.0 },
        uRoofDistanceMaxPx: { value: 1.0 },
        uNoiseEnabled: { value: 1.0 },
        uNoiseScale: { value: 2.0 },
        uNoiseStrength: { value: 0.15 },
        uTime: { value: 0.0 },
        uNoiseSpeed: { value: 0.05 },
        uNoiseWarpStrength: { value: 1.25 },
        uNoiseContrast: { value: 1.35 },
        uWindDir: { value: new THREE.Vector2(1, 0) },
        uWindSpeed: { value: 0.0 },
        uWindOffsetNoise: { value: new THREE.Vector2(0, 0) },
        uWindTime: { value: 0.0 },
        uCurlStrength: { value: 0.55 },
        uCurlScale: { value: 1.0 },
        uEvolveTime: { value: 0.0 },
        uEvolveStrength: { value: 0.85 },
        uEvolveScale: { value: 0.75 },
        uCutoutEnabled: { value: 1.0 },
        uCutoutScale: { value: 0.22 },
        uCutoutStrength: { value: 0.65 },
        uCutoutTime: { value: 0.0 },
        uCutoutContrast: { value: 1.25 },
        // Three.js world-space view bounds (minX,minY,maxX,maxY)
        uViewBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        // Foundry sceneRect bounds (x,y,width,height) in Foundry coords (top-left origin, Y-down)
        uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        // Full canvas dimensions (including padding) in Foundry coords
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        uScreenSize: { value: new THREE.Vector2(1, 1) },
        // Depth pass integration: per-pixel depth modulates fog density.
        // Elevated objects (tiles at Z+1..4, tokens at Z+3) are closer to the
        // camera than the ground plane, so they receive less fog.
        uDepthTexture: { value: null },
        uDepthEnabled: { value: 0.0 },
        uDepthCameraNear: { value: 800.0 },
        uDepthCameraFar: { value: 1200.0 },
        uGroundDistance: { value: 1000.0 },
        uDepthFogStrength: { value: 1.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tOutdoors;
        uniform sampler2D tRoofDistance;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uMaxOpacity;
        uniform float uFalloffStart;
        uniform float uFalloffEnd;
        uniform float uUseIndoorMask;
        uniform float uIndoorFogReduction;
        uniform float uIndoorBufferPx;
        uniform float uIndoorSoftnessPx;
        uniform float uRoofDistanceMaxPx;
        uniform float uNoiseEnabled;
        uniform float uNoiseScale;
        uniform float uNoiseStrength;
        uniform float uTime;
        uniform float uNoiseSpeed;
        uniform float uNoiseWarpStrength;
        uniform float uNoiseContrast;
        uniform vec2 uWindDir;
        uniform float uWindSpeed;
        uniform vec2 uWindOffsetNoise;
        uniform float uWindTime;
        uniform float uCurlStrength;
        uniform float uCurlScale;
        uniform float uEvolveTime;
        uniform float uEvolveStrength;
        uniform float uEvolveScale;
        uniform float uCutoutEnabled;
        uniform float uCutoutScale;
        uniform float uCutoutStrength;
        uniform float uCutoutTime;
        uniform float uCutoutContrast;
        uniform vec4 uViewBounds;
        uniform vec4 uSceneBounds;
        uniform vec2 uSceneDimensions;
        uniform vec2 uScreenSize;

        // Depth pass integration
        uniform sampler2D uDepthTexture;
        uniform float uDepthEnabled;
        uniform float uDepthCameraNear;
        uniform float uDepthCameraFar;
        uniform float uGroundDistance;
        uniform float uDepthFogStrength;

        varying vec2 vUv;

        // Linearize perspective device depth [0,1] → eye-space distance.
        // Uses the tight depth camera's near/far (NOT main camera).
        float msa_linearizeDepth(float d) {
          float z_ndc = d * 2.0 - 1.0;
          return (2.0 * uDepthCameraNear * uDepthCameraFar) /
                 (uDepthCameraFar + uDepthCameraNear - z_ndc * (uDepthCameraFar - uDepthCameraNear));
        }

        // Simple hash for noise
        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 345.45));
          p += dot(p, p + 34.345);
          return fract(p.x * p.y);
        }

        // Value noise
        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }

        // FBM noise
        float fbm(vec2 p) {
          float f = 0.0;
          f += 0.5 * noise2(p); p *= 2.01;
          f += 0.25 * noise2(p); p *= 2.02;
          f += 0.125 * noise2(p);
          return f / 0.875;
        }

        float outdoorsAt(vec2 uv) {
          return texture2D(tOutdoors, clamp(uv, 0.0, 1.0)).r;
        }

        vec2 curl2(vec2 p) {
          float e = 0.75;
          float n1 = fbm(p + vec2(0.0, e));
          float n2 = fbm(p - vec2(0.0, e));
          float n3 = fbm(p + vec2(e, 0.0));
          float n4 = fbm(p - vec2(e, 0.0));
          vec2 g = vec2(n3 - n4, n1 - n2) / (2.0 * e);
          return vec2(g.y, -g.x);
        }

        void main() {
          vec4 sceneColor = texture2D(tDiffuse, vUv);
          
          // Early out if no fog
          if (uFogDensity <= 0.001) {
            gl_FragColor = sceneColor;
            return;
          }

          // Calculate world position from screen UV (Three.js world coords)
          float worldX = mix(uViewBounds.x, uViewBounds.z, vUv.x);
          float worldY = mix(uViewBounds.y, uViewBounds.w, vUv.y);

          // Convert to Foundry coords (top-left origin, Y-down)
          float foundryX = worldX;
          float foundryY = uSceneDimensions.y - worldY;

          // Hard clip to sceneRect (prevents fog leaking into padded canvas)
          float sceneX = uSceneBounds.x;
          float sceneY = uSceneBounds.y;
          float sceneW = uSceneBounds.z;
          float sceneH = uSceneBounds.w;
          float sceneMaxX = sceneX + sceneW;
          float sceneMaxY = sceneY + sceneH;
          bool outsideScene = (foundryX < sceneX) || (foundryX > sceneMaxX) || (foundryY < sceneY) || (foundryY > sceneMaxY);
          if (outsideScene) {
            gl_FragColor = sceneColor;
            return;
          }

          // View-centered radial haze (always visible when zoomed in)
          vec2 viewCenter = vec2(
            (uViewBounds.x + uViewBounds.z) * 0.5,
            (uViewBounds.y + uViewBounds.w) * 0.5
          );
          float viewW = max(1.0, (uViewBounds.z - uViewBounds.x));
          float viewH = max(1.0, (uViewBounds.w - uViewBounds.y));

          float dx = (worldX - viewCenter.x) / (viewW * 0.5);
          float dy = (worldY - viewCenter.y) / (viewH * 0.5);

          // At screen corners, sqrt(dx^2+dy^2) ~= 1.414. Normalize to 0..1.
          float radial = clamp(sqrt(dx * dx + dy * dy) / 1.41421356, 0.0, 1.0);

          // Fog falloff: thicker toward screen edges
          float fogFalloff = smoothstep(uFalloffStart, uFalloffEnd, radial);

          // Add a base haze so fogDensity=1 is clearly visible even near center.
          fogFalloff = mix(0.25, 1.0, fogFalloff);
          
          // Add noise for organic look
          float noiseVal = 0.0;
          float noiseShape = 0.5;
          if (uNoiseEnabled > 0.5) {
            float t = uWindTime;

            vec2 p = vec2(worldX, worldY) * (uNoiseScale * 0.00035);
            p += uWindOffsetNoise;

            vec2 evo = vec2(
              fbm(p * (0.35 * uEvolveScale) + vec2(uEvolveTime * 0.11, -uEvolveTime * 0.07)),
              fbm(p * (0.35 * uEvolveScale) + vec2(17.3, 9.2) + vec2(-uEvolveTime * 0.09, uEvolveTime * 0.13))
            ) - 0.5;
            p += evo * uEvolveStrength;

            p += curl2(p * (0.9 * uCurlScale) + vec2(13.7, 9.2) + vec2(t * 0.03, -t * 0.02)) * uCurlStrength;

            vec2 w = vec2(
              fbm(p + vec2(t * 0.07, -t * 0.05)),
              fbm(p + vec2(17.31, 9.27) + vec2(-t * 0.06, t * 0.08))
            ) - 0.5;

            p += w * uNoiseWarpStrength;

            float nA = fbm(p);
            float nB = fbm(p * 2.07 + w * 1.8);
            float n = mix(nA, nB, 0.6);
            n = pow(clamp(n, 0.0, 1.0), max(uNoiseContrast, 0.01));

            noiseShape = n;
            noiseVal = (n - 0.5) * uNoiseStrength;
          }
          
          // Sample outdoor mask if available
          float outdoorFactor = 1.0;
          if (uUseIndoorMask > 0.5) {
            // Roof/Outdoors mask is authored in Foundry world space (sceneRect).
            // Compute UV using Foundry coords.
            vec2 maskUv = vec2(
              (foundryX - sceneX) / max(sceneW, 1.0),
              (foundryY - sceneY) / max(sceneH, 1.0)
            );
            maskUv = clamp(maskUv, 0.0, 1.0);

            // Distance field: 0 at indoors, increasing as we move away from buildings.
            // Stored as normalized [0..1] distance to nearest indoor pixel.
            float distNorm = texture2D(tRoofDistance, maskUv).r;
            float distPx = distNorm * max(uRoofDistanceMaxPx, 1.0);

            float t0 = max(0.0, uIndoorBufferPx);
            float t1 = max(t0 + 0.001, uIndoorBufferPx + max(0.0, uIndoorSoftnessPx));
            float farFromBuildings = smoothstep(t0, t1, distPx);

            // At buildings: farFromBuildings ~ 0 → apply reduction.
            // Far away: farFromBuildings ~ 1 → no reduction.
            outdoorFactor = clamp(1.0 - (uIndoorFogReduction * (1.0 - farFromBuildings)), 0.0, 1.0);
          }
          
          // Final fog amount
          // Use an exponential curve so density ramps smoothly and doesn't white-out.
          float d = clamp(uFogDensity, 0.0, 1.0);
          float shaped = clamp(fogFalloff + noiseVal, 0.0, 1.5);
          float fogStrength = 1.0 - exp(-d * 2.25 * shaped);
          fogStrength = clamp(fogStrength * mix(0.65, 1.35, noiseShape), 0.0, 1.0);

          // Large-scale cutout at low density: creates big holes/lobes that fade out as density approaches 1.
          // This reduces the "painted on" look when density is low/medium.
          if (uCutoutEnabled > 0.5 && uCutoutStrength > 0.001) {
            float fade = pow(clamp(1.0 - d, 0.0, 1.0), 1.35);
            vec2 q = vec2(worldX, worldY) * (max(uCutoutScale, 0.001) * 0.00008);
            q += uWindOffsetNoise * 0.10;
            q += vec2(uCutoutTime * 0.05, -uCutoutTime * 0.04);
            float c = fbm(q);
            c = pow(clamp(c, 0.0, 1.0), max(uCutoutContrast, 0.01));
            float cut = smoothstep(0.35, 0.75, c);
            fogStrength *= (1.0 - (uCutoutStrength * fade * cut));
          }

          // Depth-based fog modulation: elevated objects get less fog.
          // Ground plane is at uGroundDistance from camera. Tiles/tokens/roofs
          // are closer (smaller linear depth). The ratio gives a natural fog
          // gradient: ground=1.0, BG≈0.999, FG≈0.998, tokens≈0.997, roofs≈0.996.
          // smoothstep maps this to a visible reduction curve.
          float depthFogMod = 1.0;
          if (uDepthEnabled > 0.5) {
            float deviceDepth = texture2D(uDepthTexture, vUv).r;
            if (deviceDepth < 0.9999) {
              float linDepth = msa_linearizeDepth(deviceDepth);
              float depthRatio = linDepth / max(uGroundDistance, 1.0);
              // Ramp: ground (ratio≈1.0) → full fog, overhead (ratio≈0.996) → ~55% fog
              depthFogMod = mix(1.0, smoothstep(0.990, 1.001, depthRatio), uDepthFogStrength);
            }
          }

          float fogAmount = clamp(fogStrength * uMaxOpacity * outdoorFactor * depthFogMod, 0.0, uMaxOpacity);
          
          // Blend fog with scene
          vec3 fogCol = mix(uFogColor * 0.85, uFogColor * 1.05, noiseShape);
          vec3 finalColor = mix(sceneColor.rgb, fogCol, fogAmount);
          
          gl_FragColor = vec4(finalColor, sceneColor.a);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false
    });

    // Create fullscreen quad
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(geometry, this.material);
    this.quadScene.add(this.quadMesh);

    this._initialized = true;
    log.info('AtmosphericFogEffect initialized');
  }

  /**
   * Set the outdoor mask texture (from WeatherController)
   */
  setOutdoorsMask(texture) {
    this.outdoorsMask = texture;
    if (this.material) {
      this.material.uniforms.tOutdoors.value = texture;
    }
  }

  /**
   * Subscribe to the EffectMaskRegistry for 'outdoors' mask updates.
   * @param {import('../assets/EffectMaskRegistry.js').EffectMaskRegistry} registry
   */
  connectToRegistry(registry) {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    this._registryUnsub = registry.subscribe('outdoors', (texture) => {
      this.setOutdoorsMask(texture);
    });
  }

  /**
   * Set input/output buffers from EffectComposer
   */
  setBuffers(readBuffer, writeBuffer) {
    this.readBuffer = readBuffer;
    this.writeBuffer = writeBuffer;
  }

  /**
   * Set input texture
   */
  setInputTexture(texture) {
    if (this.material) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  update(timeInfo) {
    if (!this._initialized || !this.material) return;

    const u = this.material.uniforms;

    // Get fog density from weather controller
    const fogDensity = weatherController?.currentState?.fogDensity ?? 0;
    this._lastFogDensity = fogDensity;
    u.uFogDensity.value = fogDensity;

    if (Math.random() < 0.002) {
      log.debug(`AtmosphericFogEffect: fogDensity=${fogDensity.toFixed(3)}, enabled=${this.enabled}, paramEnabled=${this.params.enabled !== false}`);
    }

    // Update params
    try {
      const clamp01 = (n) => Math.max(0, Math.min(1, n));
      const expEase01 = (x) => 1.0 - Math.exp(-Math.max(0.0, x));
      const baseFog = u.uFogColor.value;
      baseFog.set(this.params.fogColor);

      const env = weatherController?.getEnvironment ? weatherController.getEnvironment() : null;
      const skyColor = env?.skyColor;
      const skyIntensity = clamp01(env?.skyIntensity ?? 1.0);

      let sceneDarkness = 0.0;
      try {
        sceneDarkness = canvas?.environment?.darknessLevel ?? canvas?.scene?.environment?.darknessLevel ?? 0.0;
      } catch (_) {
        sceneDarkness = 0.0;
      }
      if (env && Number.isFinite(env.sceneDarkness)) sceneDarkness = env.sceneDarkness;

      const d01 = clamp01(sceneDarkness);

      // 1) Night color: mix toward configured night fog color as scene darkness rises.
      // Use exp easing so high strengths really slam into the night color.
      const nightStrength = Math.max(0.0, Number(this.params.nightColorStrength ?? 2.0) || 0.0);
      const nightMix = expEase01(d01 * nightStrength);
      if (nightMix > 0.0001) {
        const nightCol = (this._tempNightFog ||= new window.THREE.Color(0, 0, 0));
        nightCol.set(this.params.fogColorNight);
        baseFog.lerp(nightCol, Math.min(1.0, nightMix));
      }

      // 2) Sky tint: apply both a strong hue shift (lerp) and a multiplicative tint.
      // We intentionally allow skyTintStrength > 1.0.
      const skyStrength = Math.max(0.0, Number(this.params.skyTintStrength ?? 0.0) || 0.0);
      if (skyStrength > 0.0 && skyColor && typeof skyColor.r === 'number') {
        const skyK = skyStrength * skyIntensity;
        const skyMix = expEase01(0.75 * skyK);
        const skyMul = expEase01(0.25 * skyK);

        const target = (this._tempSkyColor ||= new window.THREE.Color(1, 1, 1));
        target.copy(skyColor);

        const pre = (this._tempFogPreTint ||= new window.THREE.Color(1, 1, 1));
        pre.copy(baseFog);

        baseFog.lerp(target, Math.min(1.0, skyMix));

        const mulCol = (this._tempFogMul ||= new window.THREE.Color(1, 1, 1));
        mulCol.copy(pre).multiply(target);
        baseFog.lerp(mulCol, Math.min(1.0, skyMul));
      }

      const darkStrength = Math.max(0.0, Number(this.params.darknessStrength ?? 1.0) || 0.0);
      const darkInfluence = clamp01(clamp01(sceneDarkness) * darkStrength);
      const darkMin = clamp01(Number(this.params.darknessColorMin ?? 0.25) || 0.25);
      baseFog.multiplyScalar(1.0 - darkInfluence + darkInfluence * darkMin);
    } catch (_) {
      u.uFogColor.value.set(this.params.fogColor);
    }
    u.uMaxOpacity.value = this.params.maxOpacity;
    u.uFalloffStart.value = this.params.falloffStart;
    u.uFalloffEnd.value = this.params.falloffEnd;
    u.uUseIndoorMask.value = this.params.useIndoorMask ? 1.0 : 0.0;
    u.uIndoorFogReduction.value = this.params.indoorFogReduction ?? 0.9;
    u.uIndoorBufferPx.value = this.params.indoorBufferPx ?? 80;
    u.uIndoorSoftnessPx.value = this.params.indoorSoftnessPx ?? 140;
    u.uNoiseEnabled.value = this.params.noiseEnabled ? 1.0 : 0.0;
    u.uNoiseScale.value = this.params.noiseScale;
    u.uNoiseStrength.value = this.params.noiseStrength;
    u.uNoiseSpeed.value = this.params.noiseSpeed;
    u.uNoiseWarpStrength.value = this.params.noiseWarpStrength ?? 1.25;
    u.uNoiseContrast.value = this.params.noiseContrast ?? 1.35;
    u.uCurlStrength.value = this.params.curlStrength ?? 0.55;
    u.uCurlScale.value = this.params.curlScale ?? 1.0;

    u.uEvolveStrength.value = this.params.evolveStrength ?? 0.85;
    u.uEvolveScale.value = this.params.evolveScale ?? 0.75;
    u.uCutoutEnabled.value = this.params.cutoutEnabled ? 1.0 : 0.0;
    u.uCutoutScale.value = this.params.cutoutScale ?? 0.22;
    u.uCutoutStrength.value = this.params.cutoutStrength ?? 0.65;
    u.uCutoutContrast.value = this.params.cutoutContrast ?? 1.25;
    u.uTime.value = timeInfo?.elapsed ?? 0;

    const elapsed = Number.isFinite(timeInfo?.elapsed) ? timeInfo.elapsed : 0.0;
    const dtSeconds = (this._lastTimeValue === null) ? 0.0 : Math.max(0.0, elapsed - this._lastTimeValue);
    this._lastTimeValue = elapsed;

    const evolveSpeed = Number.isFinite(this.params?.evolveSpeed) ? Math.max(0.0, this.params.evolveSpeed) : 0.25;
    this._evolveTime += dtSeconds * evolveSpeed;
    if (u.uEvolveTime) u.uEvolveTime.value = this._evolveTime;

    const cutoutSpeed = Number.isFinite(this.params?.cutoutSpeed) ? Math.max(0.0, this.params.cutoutSpeed) : 0.02;
    if (u.uCutoutTime) u.uCutoutTime.value = this._evolveTime * (cutoutSpeed / Math.max(0.0001, evolveSpeed));

    try {
      const wDir = weatherController?.currentState?.windDirection;
      const wx = Number(wDir?.x);
      const wy = Number(wDir?.y);

      let nx = 1.0;
      let ny = 0.0;
      if (Number.isFinite(wx) && Number.isFinite(wy)) {
        const len = Math.hypot(wx, wy);
        if (len > 1e-6) {
          nx = wx / len;
          ny = wy / len;
        }
      }

      const resp = Number.isFinite(this.params?.windDirResponsiveness)
        ? Math.max(0.05, this.params.windDirResponsiveness)
        : 6.0;

      if (this._smoothedWindDir && dtSeconds > 0.0) {
        const k = 1.0 - Math.exp(-dtSeconds * resp);
        if (this._tempWindTarget) this._tempWindTarget.set(nx, ny);
        this._smoothedWindDir.lerp(this._tempWindTarget ?? this._smoothedWindDir, Math.min(1.0, Math.max(0.0, k)));
        u.uWindDir.value.set(this._smoothedWindDir.x, this._smoothedWindDir.y);
      } else {
        if (this._smoothedWindDir) this._smoothedWindDir.set(nx, ny);
        u.uWindDir.value.set(nx, ny);
      }

      const ws = Number(weatherController?.currentState?.windSpeed ?? 0);
      const w01 = Number.isFinite(ws) ? Math.max(0.0, Math.min(1.0, ws)) : 0.0;
      u.uWindSpeed.value = w01;

      if (dtSeconds > 0.0 && this._windOffsetNoise && u.uWindOffsetNoise) {
        const advMul = Number.isFinite(this.params?.advectionSpeed) ? Math.max(0.0, this.params.advectionSpeed) : 1.0;
        const pxPerSec = (25.0 + 220.0 * w01) * advMul;
        const noiseScaleFactor = (Number.isFinite(u.uNoiseScale?.value) ? u.uNoiseScale.value : 2.0) * 0.00035;

        const dx = (this._smoothedWindDir?.x ?? nx);
        const dy = (this._smoothedWindDir?.y ?? ny);

        this._windOffsetNoise.x += dx * (pxPerSec * dtSeconds) * noiseScaleFactor;
        this._windOffsetNoise.y += dy * (pxPerSec * dtSeconds) * noiseScaleFactor;
        u.uWindOffsetNoise.value.set(this._windOffsetNoise.x, this._windOffsetNoise.y);
      }

      if (u.uWindTime) {
        const baseRate = Number.isFinite(this.params?.noiseSpeed) ? this.params.noiseSpeed : 0.05;
        const windRate = baseRate * (0.35 + 2.25 * w01);
        this._windTime += dtSeconds * windRate;
        u.uWindTime.value = this._windTime;
      }
    } catch (_) {
      u.uWindDir.value.set(1, 0);
      u.uWindSpeed.value = 0.0;
      if (u.uWindOffsetNoise && this._windOffsetNoise) {
        u.uWindOffsetNoise.value.set(this._windOffsetNoise.x, this._windOffsetNoise.y);
      }
      if (u.uWindTime) {
        const baseRate = Number.isFinite(this.params?.noiseSpeed) ? this.params.noiseSpeed : 0.05;
        this._windTime += dtSeconds * baseRate * 0.35;
        u.uWindTime.value = this._windTime;
      }
    }

    // Update outdoor mask from weather controller
    if (this.params.useIndoorMask && weatherController?.roofMap) {
      u.tOutdoors.value = weatherController.roofMap;
    } else {
      u.tOutdoors.value = this._fallbackOutdoors;
    }

    // Distance map for smooth building buffer (generated once per load)
    if (this.params.useIndoorMask && weatherController?.roofDistanceMap) {
      u.tRoofDistance.value = weatherController.roofDistanceMap;
      u.uRoofDistanceMaxPx.value = Number(weatherController.roofDistanceMapMaxPx) || 1.0;
    } else {
      u.tRoofDistance.value = this._fallbackOutdoors;
      u.uRoofDistanceMaxPx.value = 1.0;
    }

    // Update view bounds
    this._updateViewBounds();

    // Update scene bounds
    this._updateSceneBounds();

    // IMPORTANT: Do not disable based on fogDensity.
    // EffectComposer only calls update() for enabled effects, so if we
    // disable when fogDensity hits 0, we can never "wake back up" when the
    // user increases fog density.
    this.enabled = this.params.enabled !== false;
  }

  _updateViewBounds() {
    const camera = this.camera || window.MapShine?.sceneComposer?.camera;
    if (!camera || !this.material) return;

    const u = this.material.uniforms;
    const camPos = camera.position;

    if (camera.isPerspectiveCamera) {
      const sceneComposer = window.MapShine?.sceneComposer;
      const groundZ = Number.isFinite(sceneComposer?.groundZ) ? sceneComposer.groundZ : 0;
      const distance = Math.max(1, camPos.z - groundZ);
      const vFov = camera.fov * Math.PI / 180.0;
      const visibleHeight = 2 * Math.tan(vFov / 2) * distance;
      const visibleWidth = visibleHeight * camera.aspect;

      u.uViewBounds.value.set(
        camPos.x - visibleWidth / 2,
        camPos.y - visibleHeight / 2,
        camPos.x + visibleWidth / 2,
        camPos.y + visibleHeight / 2
      );
    } else if (camera.isOrthographicCamera) {
      u.uViewBounds.value.set(
        camPos.x + camera.left / camera.zoom,
        camPos.y + camera.bottom / camera.zoom,
        camPos.x + camera.right / camera.zoom,
        camPos.y + camera.top / camera.zoom
      );
    }
  }

  _updateSceneBounds() {
    if (!this.material) return;

    const dims = canvas?.dimensions;
    if (!dims) return;

    const u = this.material.uniforms;

    // Foundry sceneRect bounds (actual map area excluding padding)
    // IMPORTANT: These are Foundry coords (top-left origin, Y-down), which is
    // exactly what the shader expects for uSceneBounds.
    const rect = dims.sceneRect;
    const sx = rect?.x ?? 0;
    const sy = rect?.y ?? 0;
    const sw = rect?.width ?? dims.width ?? 1;
    const sh = rect?.height ?? dims.height ?? 1;
    u.uSceneBounds.value.set(sx, sy, sw, sh);

    // Full canvas dimensions (including padding) in Foundry coords.
    // Used for Three->Foundry Y conversion in shader: foundryY = sceneHeight - worldY.
    u.uSceneDimensions.value.set(dims.width ?? 1, dims.height ?? 1);

    // Screen size
    const size = new window.THREE.Vector2();
    this.renderer?.getDrawingBufferSize(size);
    u.uScreenSize.value.copy(size);
  }

  render(renderer, scene, camera) {
    if (!this.enabled || !this._initialized) return;

    const inputTexture = this.readBuffer?.texture || this.material.uniforms.tDiffuse.value;
    if (!inputTexture) return;

    this.material.uniforms.tDiffuse.value = inputTexture;

    // Bind depth pass texture for per-pixel fog modulation
    const dpm = window.MapShine?.depthPassManager;
    const depthTex = (dpm && dpm.isEnabled()) ? dpm.getDepthTexture() : null;
    const u = this.material.uniforms;
    u.uDepthEnabled.value = depthTex ? 1.0 : 0.0;
    u.uDepthTexture.value = depthTex;
    if (depthTex && dpm) {
      u.uDepthCameraNear.value = dpm.getDepthNear();
      u.uDepthCameraFar.value = dpm.getDepthFar();
      u.uGroundDistance.value = window.MapShine?.sceneComposer?.groundDistance ?? 1000.0;
    }

    if (this.writeBuffer) {
      renderer.setRenderTarget(this.writeBuffer);
      renderer.clear();
    } else {
      renderer.setRenderTarget(null);
    }

    renderer.render(this.quadScene, this.quadCamera);
  }

  onResize(width, height) {
    if (this.material?.uniforms?.uScreenSize) {
      this.material.uniforms.uScreenSize.value.set(width, height);
    }
  }

  dispose() {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    if (this.quadMesh) {
      this.quadMesh.geometry.dispose();
      this.quadScene.remove(this.quadMesh);
    }
    if (this.material) {
      this.material.dispose();
    }

    if (this._fallbackOutdoors) {
      try { this._fallbackOutdoors.dispose(); } catch (_) {}
      this._fallbackOutdoors = null;
    }
    this._initialized = false;
    log.info('AtmosphericFogEffect disposed');
  }
}
