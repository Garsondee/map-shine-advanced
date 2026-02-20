/**
 * @fileoverview Overhead Shadows effect
 * Renders soft, directional shadows cast by overhead tiles onto the ground.
 * @module effects/OverheadShadowsEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('OverheadShadowsEffect');

/**
 * Overhead Shadows post-processing effect.
 *
 * v1 scope:
 * - Uses ROOF_LAYER (20) overhead tiles as a stamp.
 * - Casts a short, soft shadow "downwards" from roofs by sampling an
 *   offset version of the roof mask.
 * - Only darkens the region outside the roof by subtracting the base roof
 *   alpha from the offset roof alpha.
 */
export class OverheadShadowsEffect extends EffectBase {
  constructor() {
    // Environmental layer: generates a shadow texture consumed by LightingEffect.
    super('overhead-shadows', RenderLayers.ENVIRONMENTAL, 'low');

    this.priority = 10;
    this.alwaysRender = true;

    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this.roofTarget = null;   // Raw roof alpha (overhead tiles)

    /** @type {THREE.WebGLRenderTarget|null} */
    this.shadowTarget = null; // Final overhead shadow factor texture

    /** @type {THREE.WebGLRenderTarget|null} */
    this.fluidRoofTarget = null; // Fluid-only roof pass (for optional shadow tint)

    /** @type {THREE.WebGLRenderTarget|null} */
    this.tileProjectionTarget = null; // Selected tile alpha pass for tile shadow projection

    /** @type {THREE.WebGLRenderTarget|null} */
    this.tileProjectionSortTarget = null; // Selected tile sort pass (alpha encoded) for tile shadow projection

    /** @type {THREE.WebGLRenderTarget|null} */
    this.tileReceiverAlphaTarget = null; // Visible tile alpha pass (all tiles)

    /** @type {THREE.WebGLRenderTarget|null} */
    this.tileReceiverSortTarget = null; // Visible tile sort pass (all tiles)

    /** @type {THREE.Texture|null} */
    this.inputTexture = null;

    /** @type {THREE.Texture|null} */
    this.outdoorsMask = null; // _Outdoors mask (bright outside, dark indoors)

    /** @type {THREE.Vector2|null} */
    this.sunDir = null; // Screen-space sun direction, driven by TimeManager

    /** @type {THREE.Mesh|null} */
    this.baseMesh = null; // Groundplane mesh

    /** @type {THREE.Scene|null} */
    this.shadowScene = null; // World-pinned shadow mesh scene
    /** @type {THREE.Mesh|null} */
    this.shadowMesh = null;

    this.params = {
      enabled: true,
      opacity: 0.4,
      length: 0.165,
      softness: 3.0,
      verticalOnly: true,  // v1: primarily vertical motion in screen space
      affectsLights: 0.0,
      sunLatitude: 0.1,    // 0=flat east/west, 1=maximum north/south arc
      indoorShadowEnabled: false, // Use _Outdoors dark regions as extra projected building shadow
      indoorShadowOpacity: 0.5,   // Opacity of dark-region projection contribution
      indoorShadowLengthScale: 1.0,
      indoorShadowSoftness: 3.0,
      indoorFluidShadowSoftness: 3.0,
      indoorFluidShadowIntensityBoost: 1.0,
      indoorFluidColorSaturation: 1.2,
      tileProjectionEnabled: false,
      tileProjectionOpacity: 0.5,
      tileProjectionLengthScale: 1.0,
      tileProjectionSoftness: 3.0,
      tileProjectionThreshold: 0.05,
      tileProjectionPower: 1.0,
      tileProjectionOutdoorOpacityScale: 1.0,
      tileProjectionIndoorOpacityScale: 1.0,
      tileProjectionSortBias: 0.002,
      fluidColorEnabled: false,
      fluidEffectTransparency: 0.35,
      fluidShadowIntensityBoost: 1.0,
      fluidShadowSoftness: 3.0,
      fluidColorBoost: 1.5,
      fluidColorSaturation: 1.2
    };
    
    // PERFORMANCE: Reusable objects to avoid per-frame allocations
    this._tempSize = null; // Lazy init when THREE is available

    /** @type {function|null} Unsubscribe from EffectMaskRegistry */
    this._registryUnsub = null;
  }

  /**
   * Temporarily expand camera view for roof capture, then return a restore callback.
   * @param {number} scale
   * @returns {() => void}
   * @private
   */
  _applyRoofCaptureGuardScale(scale) {
    const THREE = window.THREE;
    const cam = this.mainCamera;
    if (!THREE || !cam || !Number.isFinite(scale) || scale <= 1.0001) {
      return () => {};
    }

    if (cam.isPerspectiveCamera) {
      const oldFov = cam.fov;
      const oldZoom = cam.zoom;
      const oldAspect = cam.aspect;
      const fovRad = THREE.MathUtils.degToRad(Math.max(1.0, oldFov));
      const expandedFov = 2.0 * Math.atan(Math.tan(fovRad * 0.5) * scale);
      cam.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(expandedFov), 1.0, 170.0);
      cam.updateProjectionMatrix();
      return () => {
        cam.fov = oldFov;
        cam.zoom = oldZoom;
        cam.aspect = oldAspect;
        cam.updateProjectionMatrix();
      };
    }

    if (cam.isOrthographicCamera) {
      const oldZoom = cam.zoom;
      cam.zoom = Math.max(0.0001, oldZoom / scale);
      cam.updateProjectionMatrix();
      return () => {
        cam.zoom = oldZoom;
        cam.updateProjectionMatrix();
      };
    }

    return () => {};
  }

  /**
   * Receive base mesh and asset bundle so we can access the _Outdoors mask.
   * @param {THREE.Mesh} baseMesh
   * @param {MapAssetBundle} assetBundle
   */
  setBaseMesh(baseMesh, assetBundle) {
    if (!assetBundle || !assetBundle.masks) return;
    this.baseMesh = baseMesh;
    const outdoorsData = assetBundle.masks.find(m => m.id === 'outdoors' || m.type === 'outdoors');
    this.outdoorsMask = outdoorsData?.texture || null;

    // If initialize() has already run and we have a base mesh, build the
    // world-pinned shadow mesh now.
    if (this.renderer && this.mainScene && this.mainCamera) {
      this._createShadowMesh();
    }
  }

  /**
   * Subscribe to the EffectMaskRegistry for 'outdoors' mask updates.
   * @param {import('../assets/EffectMaskRegistry.js').EffectMaskRegistry} registry
   */
  connectToRegistry(registry) {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    this._registryUnsub = registry.subscribe('outdoors', (texture) => {
      this.outdoorsMask = texture;
      if (texture && this.renderer && this.mainScene && this.mainCamera) {
        this._createShadowMesh();
      }
    });
  }

  /**
   * UI control schema for Tweakpane
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'main',
          label: 'Overhead Shadows',
          type: 'inline',
          parameters: ['opacity', 'length', 'softness', 'affectsLights', 'fluidColorEnabled', 'fluidEffectTransparency', 'fluidShadowIntensityBoost', 'fluidShadowSoftness', 'fluidColorBoost', 'fluidColorSaturation']
        },
        {
          name: 'tileProjection',
          label: 'Tile Shadow Projection',
          type: 'inline',
          parameters: ['tileProjectionEnabled', 'tileProjectionOpacity', 'tileProjectionLengthScale', 'tileProjectionSoftness', 'tileProjectionThreshold', 'tileProjectionPower', 'tileProjectionOutdoorOpacityScale', 'tileProjectionIndoorOpacityScale']
        },
        {
          name: 'indoorShadow',
          label: 'Indoor Shadow',
          type: 'inline',
          parameters: ['indoorShadowEnabled', 'indoorShadowOpacity', 'indoorShadowLengthScale', 'indoorShadowSoftness', 'indoorFluidShadowSoftness', 'indoorFluidShadowIntensityBoost', 'indoorFluidColorSaturation']
        }
      ],
      parameters: {
        opacity: {
          type: 'slider',
          label: 'Shadow Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.4
        },
        length: {
          type: 'slider',
          label: 'Shadow Length',
          min: 0.0,
          max: 0.3,
          step: 0.005,
          default: 0.165
        },
        softness: {
          type: 'slider',
          label: 'Softness',
          min: 0.5,
          max: 5.0,
          step: 0.1,
          default: 3.0
        },
        affectsLights: {
          type: 'slider',
          label: 'Affects Dynamic Lights',
          min: 0.0,
          max: 1.0,
          step: 0.05,
          default: 0.75
        },
        fluidColorEnabled: {
          type: 'checkbox',
          label: 'Use Fluid Effect Colour',
          default: false,
          tooltip: 'Tints overhead shadows with FluidEffect colour when fluid overlays are attached to overhead tiles'
        },
        fluidEffectTransparency: {
          type: 'slider',
          label: 'Fluid Effect Transparency',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.35,
          tooltip: 'Opacity of FluidEffect colour tint in overhead shadows'
        },
        fluidShadowIntensityBoost: {
          type: 'slider',
          label: 'Fluid Shadow Intensity Boost',
          min: 0.0,
          max: 5.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Boost multiplier for FluidEffect shadow contribution (up to 500%)'
        },
        fluidShadowSoftness: {
          type: 'slider',
          label: 'Fluid Shadow Softness',
          min: 0.5,
          max: 10.0,
          step: 0.1,
          default: 3.0,
          tooltip: 'Blur radius for FluidEffect tint on outdoor receivers (up to 2x regular shadow softness range)'
        },
        fluidColorBoost: {
          type: 'slider',
          label: 'Fluid Colour Boost',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: 1.5,
          tooltip: 'Boosts fluid colour intensity used to tint overhead shadows'
        },
        fluidColorSaturation: {
          type: 'slider',
          label: 'Fluid Colour Saturation',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 1.2,
          tooltip: 'Saturation multiplier for fluid shadow tint colour'
        },
        tileProjectionEnabled: {
          type: 'checkbox',
          label: 'Enable Tile Shadow Projection',
          default: false,
          tooltip: 'Adds tile alpha from Tile Motion (per-tile Shadow Projection) as an extra projected shadow source'
        },
        tileProjectionOpacity: {
          type: 'slider',
          label: 'Tile Projection Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5,
          tooltip: 'Overall strength of tile-projected shadows'
        },
        tileProjectionLengthScale: {
          type: 'slider',
          label: 'Tile Projection Length Scale',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Scales projection distance for tile-projected shadows relative to roof shadows'
        },
        tileProjectionSoftness: {
          type: 'slider',
          label: 'Tile Projection Softness',
          min: 0.5,
          max: 10.0,
          step: 0.1,
          default: 3.0,
          tooltip: 'Blur radius for tile-projected shadows'
        },
        tileProjectionThreshold: {
          type: 'slider',
          label: 'Tile Alpha Threshold',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.05,
          tooltip: 'Ignores very low tile alpha values before projection'
        },
        tileProjectionPower: {
          type: 'slider',
          label: 'Tile Alpha Contrast',
          min: 0.1,
          max: 4.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Shapes tile alpha falloff before converting to shadow strength'
        },
        tileProjectionOutdoorOpacityScale: {
          type: 'slider',
          label: 'Tile Outdoor Strength Scale',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Additional multiplier applied to tile-projected shadow strength on outdoor receivers'
        },
        tileProjectionIndoorOpacityScale: {
          type: 'slider',
          label: 'Tile Indoor Strength Scale',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Additional multiplier applied to tile-projected shadow strength on indoor receivers'
        },
        indoorShadowEnabled: {
          type: 'checkbox',
          label: 'Enable Indoor Shadow',
          default: false,
          tooltip: 'Enable projected shadow contribution from _Outdoors dark regions'
        },
        indoorShadowOpacity: {
          type: 'slider',
          label: 'Indoor Shadow Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5,
          tooltip: 'Strength of dark-region projection on outdoor receivers'
        },
        indoorShadowLengthScale: {
          type: 'slider',
          label: 'Indoor Shadow Length Scale',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Scale factor for indoor contribution projection distance'
        },
        indoorShadowSoftness: {
          type: 'slider',
          label: 'Indoor Shadow Softness',
          min: 0.5,
          max: 5.0,
          step: 0.1,
          default: 3.0,
          tooltip: 'Indoor blur radius for overhead and fluid shadow contributions'
        },
        indoorFluidShadowSoftness: {
          type: 'slider',
          label: 'Indoor Fluid Shadow Softness',
          min: 0.5,
          max: 10.0,
          step: 0.1,
          default: 3.0,
          tooltip: 'Blur radius for FluidEffect tint on indoor receivers (up to 2x regular shadow softness range)'
        },
        indoorFluidShadowIntensityBoost: {
          type: 'slider',
          label: 'Indoor Fluid Shadow Intensity Boost',
          min: 0.0,
          max: 5.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Boost multiplier for FluidEffect colour contribution on indoor receivers (up to 500%)'
        },
        indoorFluidColorSaturation: {
          type: 'slider',
          label: 'Indoor Fluid Colour Saturation',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 1.2,
          tooltip: 'Saturation multiplier for FluidEffect tint on indoor receivers'
        }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    this.renderer = renderer;
    this.mainScene = scene;
    this.mainCamera = camera;

    // Create a dedicated scene to render the world-pinned shadow mesh. The
    // roof mask itself is still rendered into roofTarget using the main
    // scene and ROOF_LAYER; this scene only contains the groundplane
    // shadow mesh that samples that mask.
    this.shadowScene = new THREE.Scene();

    if (this.baseMesh) {
      this._createShadowMesh();
    }

    log.info('OverheadShadowsEffect initialized');
  }

  _createShadowMesh() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh) return;

    // Dispose previous mesh/material if rebuilding
    if (this.shadowMesh && this.shadowScene) {
      this.shadowScene.remove(this.shadowMesh);
      this.shadowMesh.geometry.dispose();
      this.shadowMesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tRoof: { value: null },
        uOpacity: { value: this.params.opacity },
        uLength: { value: this.params.length },
        uSoftness: { value: this.params.softness },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uRoofUvScale: { value: 1.0 },
        uTileProjectionUvScale: { value: 1.0 },
        uSunDir: { value: new THREE.Vector2(0.0, 1.0) },
        uResolution: { value: new THREE.Vector2(1024, 1024) },
        uZoom: { value: 1.0 },
        // Indoor shadow from _Outdoors mask
        uOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uIndoorShadowEnabled: { value: 0.0 },
        uIndoorShadowOpacity: { value: 0.5 },
        uIndoorShadowLengthScale: { value: 1.0 },
        uIndoorShadowSoftness: { value: 3.0 },
        uIndoorFluidShadowSoftness: { value: 3.0 },
        uIndoorFluidShadowIntensityBoost: { value: 1.0 },
        uIndoorFluidColorSaturation: { value: 1.2 },
        uFluidColorEnabled: { value: 0.0 },
        uFluidEffectTransparency: { value: 0.35 },
        uFluidShadowIntensityBoost: { value: 1.0 },
        uFluidShadowSoftness: { value: 3.0 },
        uFluidColorBoost: { value: 1.5 },
        uFluidColorSaturation: { value: 1.2 },
        tFluidRoof: { value: null },
        uHasFluidRoof: { value: 0.0 },
        tTileProjection: { value: null },
        uHasTileProjection: { value: 0.0 },
        tTileProjectionSort: { value: null },
        uHasTileProjectionSort: { value: 0.0 },
        tTileReceiverAlpha: { value: null },
        tTileReceiverSort: { value: null },
        uHasTileReceiverSort: { value: 0.0 },
        uTileProjectionEnabled: { value: 0.0 },
        uTileProjectionOpacity: { value: 0.5 },
        uTileProjectionLengthScale: { value: 1.0 },
        uTileProjectionSoftness: { value: 3.0 },
        uTileProjectionThreshold: { value: 0.05 },
        uTileProjectionPower: { value: 1.0 },
        uTileProjectionOutdoorOpacityScale: { value: 1.0 },
        uTileProjectionIndoorOpacityScale: { value: 1.0 },
        uTileProjectionSortBias: { value: 0.002 },
        // Scene dimensions in world pixels for world-space mask UV conversion
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        // Depth pass integration: height-based shadow modulation.
        // Casters must be above receivers to cast shadows — prevents
        // self-shadowing and upward-shadowing using per-pixel depth.
        uDepthTexture: { value: null },
        uDepthEnabled: { value: 0.0 },
        uDepthCameraNear: { value: 800.0 },
        uDepthCameraFar: { value: 1200.0 },
        uGroundDistance: { value: 1000.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tRoof;
        uniform float uOpacity;
        uniform float uLength;
        uniform float uSoftness;
        uniform vec2 uTexelSize;
        uniform float uRoofUvScale;
        uniform float uTileProjectionUvScale;
        uniform vec2 uSunDir;
        uniform vec2 uResolution;
        uniform float uZoom;

        // Indoor shadow from _Outdoors mask
        uniform sampler2D uOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uIndoorShadowEnabled;
        uniform float uIndoorShadowOpacity;
        uniform float uIndoorShadowLengthScale;
        uniform float uIndoorShadowSoftness;
        uniform float uIndoorFluidShadowSoftness;
        uniform float uIndoorFluidShadowIntensityBoost;
        uniform float uIndoorFluidColorSaturation;
        uniform float uFluidColorEnabled;
        uniform float uFluidEffectTransparency;
        uniform float uFluidShadowIntensityBoost;
        uniform float uFluidShadowSoftness;
        uniform float uFluidColorBoost;
        uniform float uFluidColorSaturation;
        uniform sampler2D tFluidRoof;
        uniform float uHasFluidRoof;
        uniform sampler2D tTileProjection;
        uniform float uHasTileProjection;
        uniform sampler2D tTileProjectionSort;
        uniform float uHasTileProjectionSort;
        uniform sampler2D tTileReceiverAlpha;
        uniform sampler2D tTileReceiverSort;
        uniform float uHasTileReceiverSort;
        uniform float uTileProjectionEnabled;
        uniform float uTileProjectionOpacity;
        uniform float uTileProjectionLengthScale;
        uniform float uTileProjectionSoftness;
        uniform float uTileProjectionThreshold;
        uniform float uTileProjectionPower;
        uniform float uTileProjectionOutdoorOpacityScale;
        uniform float uTileProjectionIndoorOpacityScale;
        uniform float uTileProjectionSortBias;
        // Scene dimensions in world pixels for mask UV conversion
        uniform vec2 uSceneDimensions;

        // Depth pass integration
        uniform sampler2D uDepthTexture;
        uniform float uDepthEnabled;
        uniform float uDepthCameraNear;
        uniform float uDepthCameraFar;
        uniform float uGroundDistance;

        varying vec2 vUv;

        // Linearize perspective device depth [0,1] → eye-space distance.
        // Uses the tight depth camera's near/far (NOT main camera).
        float msa_linearizeDepth(float d) {
          float z_ndc = d * 2.0 - 1.0;
          return (2.0 * uDepthCameraNear * uDepthCameraFar) /
                 (uDepthCameraFar + uDepthCameraNear - z_ndc * (uDepthCameraFar - uDepthCameraNear));
        }

        // ClampToEdge + linear filtering can smear border texels when sampling
        // exactly on the 0/1 boundary. Require taps to stay at least half a
        // texel inside texture bounds to keep edge behavior stable.
        float uvInBounds(vec2 uv, vec2 texelSize) {
          vec2 safeMin = max(texelSize * 0.5, vec2(0.0));
          vec2 safeMax = min(vec2(1.0) - texelSize * 0.5, vec2(1.0));
          vec2 ge0 = step(safeMin, uv);
          vec2 le1 = step(uv, safeMax);
          return ge0.x * ge0.y * le1.x * le1.y;
        }

        // Compute how far we can travel along delta before leaving [0,1].
        // Returned scale is clamped to [0,1], so callers can safely apply it
        // to their intended offset vector.
        float offsetScaleLimit(float origin, float delta) {
          if (delta > 0.0) return (1.0 - origin) / delta;
          if (delta < 0.0) return (0.0 - origin) / delta;
          return 1e6;
        }

        float offsetTravelScale(vec2 origin, vec2 delta) {
          float kx = offsetScaleLimit(origin.x, delta.x);
          float ky = offsetScaleLimit(origin.y, delta.y);
          return clamp(min(kx, ky), 0.0, 1.0);
        }

        void main() {
          // Screen-space UV for this fragment, matching the roofTarget
          // render that was produced with the same camera.
          vec2 screenUv = gl_FragCoord.xy / uResolution;
          // roofTarget/fluidRoofTarget may be captured with a guard-band
          // expanded camera. Remap current screen UV into that larger capture.
          float roofUvScale = max(uRoofUvScale, 0.0001);
          vec2 roofUv = (screenUv - 0.5) * roofUvScale + 0.5;
          float tileProjectionUvScale = max(uTileProjectionUvScale, 0.0001);
          vec2 tileProjectionUv = (screenUv - 0.5) * tileProjectionUvScale + 0.5;

          // Two direction vectors are needed because the roof sampling and
          // indoor mask sampling operate in different UV spaces:
          //
          // Screen UV (gl_FragCoord / uResolution): Y=0 at the BOTTOM of the
          //   viewport (south on the map).
          // Mesh UV (vUv on basePlane with scale.y=-1 and flipY=false): V=0 at
          //   the TOP of the mesh (north on the map).
          //
          // BuildingShadowsEffect's bake shader uses a standard-UV bake quad
          // where V=0 also maps to north (flipY=false on the _Outdoors mask).
          // So its +dir.y points north in its UV space. To get the same visual
          // direction in screen UV we must negate Y, because screen Y=0 is south.
          //
          // dir        — mesh/mask UV space (V=0 = north, matches bake UV)
          // screenDir  — screen UV space (Y=0 = south, needs Y flip)
          vec2 dir = normalize(uSunDir);
          vec2 screenDir = normalize(vec2(uSunDir.x, -uSunDir.y));

          // Scale length by zoom so the world-space band stays
          // approximately constant as the camera zoom changes.
          // We use a reference height of 1080px to convert the normalized uLength
          // into a pixel distance. This ensures the shadow length is stable across
          // different resolutions (resolution-independent) and aspect ratios.
          // uLength (0.04) * 1080 ~= 43 pixels at Zoom 1.
          float pixelLen = uLength * 1080.0 * max(uZoom, 0.0001);

          // Sample the roof mask at an offset along screenDir. We look for
          // roof pixels in the +screenDir direction so shadow extends in
          // -screenDir, matching BuildingShadowsEffect's visual convention.
          vec2 baseOffsetDeltaUv = screenDir * pixelLen * uTexelSize * roofUvScale;
          float baseOffsetScale = offsetTravelScale(roofUv, baseOffsetDeltaUv);
          // Smooth edge falloff: when we cannot travel full projection distance
          // near viewport borders, fade contribution to avoid smear bands from
          // heavily compressed sample neighborhoods.
          float baseEdgeFade = smoothstep(0.0, 1.0, baseOffsetScale);
          vec2 offsetUv = roofUv + baseOffsetDeltaUv;

          bool tileProjectionEnabled = (uTileProjectionEnabled > 0.5 && uHasTileProjection > 0.5);
          float tileProjectionLengthScale = max(uTileProjectionLengthScale, 0.0);
          float projectedPixelLen = pixelLen * tileProjectionLengthScale;
          vec2 projectedOffsetDeltaUv = screenDir * projectedPixelLen * uTexelSize * tileProjectionUvScale;
          float projectedOffsetScale = offsetTravelScale(tileProjectionUv, projectedOffsetDeltaUv);
          float projectedEdgeFade = smoothstep(0.0, 1.0, projectedOffsetScale);
          vec2 projectedOffsetUv = tileProjectionUv + projectedOffsetDeltaUv;

          // ---- Depth pass: height-based shadow modulation ----
          // IMPORTANT: Keep depth gating only for tile projection shadows.
          //
          // Roof/indoor overhead shadow continuity intentionally does NOT use
          // this gate, because hover-hidden roofs fade out of the main depth
          // pass (depthWrite disabled near zero opacity) while we still need
          // their captured roof mask to cast shadows. Applying depthMod there
          // also suppresses _Outdoors dark-region contribution in outdoor space.
          float depthTileProjectionMod = 1.0;
          if (uDepthEnabled > 0.5 && tileProjectionEnabled) {
            float receiverDevice = texture2D(uDepthTexture, screenUv).r;
            if (receiverDevice < 0.9999) {
              float receiverLinear = msa_linearizeDepth(receiverDevice);
              float receiverHeight = uGroundDistance - receiverLinear;

              // Tile projection caster height (uses projection-length offset)
              vec2 tileCasterUv = screenUv + screenDir * projectedPixelLen * uTexelSize;
              float tileCasterDevice = texture2D(uDepthTexture, tileCasterUv).r;
              if (tileCasterDevice < 0.9999) {
                float tileCasterLinear = msa_linearizeDepth(tileCasterDevice);
                float tileCasterHeight = uGroundDistance - tileCasterLinear;
                depthTileProjectionMod = smoothstep(0.0, 1.0, tileCasterHeight - receiverHeight);
              }
            }
          }

          // Prepare indoor/outdoor mask sampling in world UV (mask space).
          // We use this for two jobs:
          // 1) Receiver/caster region matching (clip shadows that cross the
          //    indoor/outdoor boundary)
          // 2) Optional indoor-only shadow contribution
          bool hasOutdoorsMask = (uHasOutdoorsMask > 0.5);
          bool indoorEnabled = (uIndoorShadowEnabled > 0.5 && hasOutdoorsMask);
          vec2 maskTexelSize = vec2(1.0) / max(uSceneDimensions, vec2(1.0));
          float maskPixelLenBase = uLength * 1080.0;
          float maskPixelLenIndoor = maskPixelLenBase * uIndoorShadowLengthScale;
          float maskPixelLenProjected = maskPixelLenBase * tileProjectionLengthScale;
          vec2 maskOffsetUvBase = vUv + dir * maskPixelLenBase * maskTexelSize;
          vec2 maskOffsetUvIndoor = vUv + dir * maskPixelLenIndoor * maskTexelSize;
          vec2 maskOffsetUvProjected = vUv + dir * maskPixelLenProjected * maskTexelSize;

          // Receiver-space classification (at the current fragment).
          // White in _Outdoors = outdoors, black = indoors.
          float receiverOutdoors = hasOutdoorsMask ? clamp(texture2D(uOutdoorsMask, vUv).r, 0.0, 1.0) : 1.0;
          float receiverIndoor = 1.0 - receiverOutdoors;
          float receiverIsOutdoors = step(0.5, receiverOutdoors);
          float receiverIsIndoor = 1.0 - receiverIsOutdoors;

          // Apply indoor/outdoor softness selection uniformly so all shadow
          // components (roof, indoor mask, and fluid tint) blur consistently.
          float blurSoftness = mix(uSoftness, uIndoorShadowSoftness, receiverIsIndoor);
          vec2 stepUv = uTexelSize * blurSoftness * roofUvScale;
          vec2 maskStepUv = maskTexelSize * blurSoftness * 4.0;
          float fluidBlurSoftness = mix(uFluidShadowSoftness, uIndoorFluidShadowSoftness, receiverIndoor);
          vec2 fluidStepUv = uTexelSize * fluidBlurSoftness * roofUvScale;
          vec2 maskFluidStepUv = maskTexelSize * fluidBlurSoftness * 4.0;

          float accum = 0.0;
          float weightSum = 0.0;
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              vec2 sUv = offsetUv + vec2(float(dx), float(dy)) * stepUv;
              float sUvValid = uvInBounds(sUv, uTexelSize);
              float w = 1.0;
              if (dx == 0 && dy == 0) w = 2.0; // center bias
              float wEffective = w * sUvValid;

              // Roof tap (screen-space)
              float roofTap = texture2D(tRoof, clamp(sUv, 0.0, 1.0)).a * sUvValid;
              float roofStrengthTap = clamp(roofTap * uOpacity, 0.0, 1.0);
              roofStrengthTap *= baseEdgeFade;

              // Region clipping: prevent shadows from crossing the
              // indoor/outdoor boundary. If the projected caster tap lives in
              // a different _Outdoors region than the receiver pixel, discard it.
              vec2 maskJitterUv = vec2(float(dx), float(dy)) * maskStepUv;
              float sameRegionTap = 1.0;
              if (hasOutdoorsMask) {
                vec2 mUvBase = maskOffsetUvBase + maskJitterUv;
                float mUvBaseValid = uvInBounds(mUvBase, maskTexelSize);
                if (mUvBaseValid > 0.5) {
                  float casterOutdoorsBase = clamp(texture2D(uOutdoorsMask, clamp(mUvBase, 0.0, 1.0)).r, 0.0, 1.0);
                  float casterIsOutdoors = step(0.5, casterOutdoorsBase);
                  sameRegionTap = 1.0 - abs(casterIsOutdoors - receiverIsOutdoors);
                }
                roofStrengthTap *= sameRegionTap;
              }

              // Dark-region tap (world-space _Outdoors mask)
              float indoorStrengthTap = 0.0;
              if (indoorEnabled) {
                vec2 mUvIndoor = maskOffsetUvIndoor + maskJitterUv;
                float mUvIndoorValid = uvInBounds(mUvIndoor, maskTexelSize);
                if (mUvIndoorValid > 0.5) {
                  float casterOutdoorsIndoor = clamp(texture2D(uOutdoorsMask, clamp(mUvIndoor, 0.0, 1.0)).r, 0.0, 1.0);
                  float casterIndoorsIndoor = 1.0 - casterOutdoorsIndoor;
                  // Use dark-region casters as an extra "building shadow" only on
                  // outdoor receivers. Indoors should not get this extra layer.
                  indoorStrengthTap = clamp(casterIndoorsIndoor * uIndoorShadowOpacity * receiverOutdoors, 0.0, 1.0);
                  indoorStrengthTap *= baseEdgeFade;
                }
              }

              // Combine BEFORE blur.
              float combinedTap = max(roofStrengthTap, indoorStrengthTap);
              accum += combinedTap * wEffective;
              weightSum += wEffective;
            }
          }

          float combinedStrength = (weightSum > 0.0) ? (accum / weightSum) : 0.0;

          float tileProjectedStrength = 0.0;
          if (tileProjectionEnabled) {
            float projectedSoftness = max(uTileProjectionSoftness, 0.5);
            vec2 projectedStepUv = uTexelSize * projectedSoftness * tileProjectionUvScale;
            float projectedAccum = 0.0;
            float projectedWeightSum = 0.0;
            float projectionReceiverScale = mix(max(uTileProjectionOutdoorOpacityScale, 0.0), max(uTileProjectionIndoorOpacityScale, 0.0), receiverIndoor);
            bool hasTileSortOcclusion = (uHasTileProjectionSort > 0.5 && uHasTileReceiverSort > 0.5);
            float receiverTileAlpha = hasTileSortOcclusion ? clamp(texture2D(tTileReceiverAlpha, screenUv).a, 0.0, 1.0) : 0.0;
            float receiverTileSortEncoded = hasTileSortOcclusion ? clamp(texture2D(tTileReceiverSort, screenUv).a, 0.0, 1.0) : 0.0;
            float receiverTileSortNorm = (receiverTileAlpha > 0.0001)
              ? clamp(receiverTileSortEncoded / receiverTileAlpha, 0.0, 1.0)
              : 0.0;

            for (int pdy = -1; pdy <= 1; pdy++) {
              for (int pdx = -1; pdx <= 1; pdx++) {
                vec2 pUv = projectedOffsetUv + vec2(float(pdx), float(pdy)) * projectedStepUv;
                float pUvValid = uvInBounds(pUv, uTexelSize);
                float pw = 1.0;
                if (pdx == 0 && pdy == 0) pw = 2.0;
                float pwEffective = pw * pUvValid;

                float tileAlphaTap = clamp(texture2D(tTileProjection, clamp(pUv, 0.0, 1.0)).a, 0.0, 1.0) * pUvValid;
                float thresholdDenom = max(1.0 - uTileProjectionThreshold, 0.0001);
                float tileMaskedTap = clamp((tileAlphaTap - uTileProjectionThreshold) / thresholdDenom, 0.0, 1.0);
                tileMaskedTap = pow(tileMaskedTap, max(uTileProjectionPower, 0.0001));

                float sortGate = 1.0;
                if (hasTileSortOcclusion && receiverTileAlpha > 0.0001 && tileAlphaTap > 0.0001) {
                  float casterTileSortEncoded = clamp(texture2D(tTileProjectionSort, clamp(pUv, 0.0, 1.0)).a, 0.0, 1.0);
                  float casterTileSortNorm = clamp(casterTileSortEncoded / tileAlphaTap, 0.0, 1.0);
                  float requiredCasterSort = receiverTileSortNorm + max(uTileProjectionSortBias, 0.0);
                  // Only allow projection when the caster sort is above the
                  // currently visible receiver tile sort. This prevents tiles
                  // from projecting shadows "onto" tiles layered above them.
                  sortGate = step(requiredCasterSort, casterTileSortNorm);
                }

                // Tile projection is intentionally NOT clipped by _Outdoors region.
                // This keeps projected tile shadows visible indoors and outdoors.
                float sameProjectionRegionTap = 1.0;

                float tileStrengthTap = clamp(tileMaskedTap * uTileProjectionOpacity * projectionReceiverScale * sameProjectionRegionTap * sortGate, 0.0, 1.0);
                tileStrengthTap *= projectedEdgeFade;
                projectedAccum += tileStrengthTap * pwEffective;
                projectedWeightSum += pwEffective;
              }
            }

            tileProjectedStrength = (projectedWeightSum > 0.0) ? (projectedAccum / projectedWeightSum) : 0.0;
            // Depth-based height gate: suppress tile shadow when caster is not above receiver
            tileProjectedStrength *= depthTileProjectionMod;
          }

          // Keep roof/indoor/fluid contribution separate from tile projection.
          // LightingEffect can then route tile projection through its own path
          // without inheriting roof/outdoor masking behavior.
          float roofCombinedStrength = combinedStrength;
          float tileOnlyStrength = tileProjectedStrength;

          // Fluid tint gets its own softer blur path with larger 5x5 Gaussian
          // kernel. This avoids harsh tint edges when the fluid softness sliders
          // are pushed above regular shadow softness.
          float fluidAccumA = 0.0;
          vec3 fluidAccumRgb = vec3(0.0);
          float fluidWeightSum = 0.0;
          if (uFluidColorEnabled > 0.5 && uHasFluidRoof > 0.5) {
            for (int fdy = -2; fdy <= 2; fdy++) {
              for (int fdx = -2; fdx <= 2; fdx++) {
                vec2 fUv = offsetUv + vec2(float(fdx), float(fdy)) * fluidStepUv;
                float fUvValid = uvInBounds(fUv, uTexelSize);
                vec2 maskJitterFluidUv = vec2(float(fdx), float(fdy)) * maskFluidStepUv;
                float wx = 1.0 - (abs(float(fdx)) / 3.0);
                float wy = 1.0 - (abs(float(fdy)) / 3.0);
                float fw = max(wx * wy, 0.0001);
                float fwEffective = fw * fUvValid;

                float sameRegionFluidTap = 1.0;
                if (hasOutdoorsMask) {
                  vec2 mUvFluid = maskOffsetUvBase + maskJitterFluidUv;
                  float mUvFluidValid = uvInBounds(mUvFluid, maskTexelSize);
                  if (mUvFluidValid > 0.5) {
                    float casterOutdoorsFluid = clamp(texture2D(uOutdoorsMask, clamp(mUvFluid, 0.0, 1.0)).r, 0.0, 1.0);
                    float casterIsOutdoorsFluid = step(0.5, casterOutdoorsFluid);
                    sameRegionFluidTap = 1.0 - abs(casterIsOutdoorsFluid - receiverIsOutdoors);
                  }
                }

                vec4 fluidTap = texture2D(tFluidRoof, clamp(fUv, 0.0, 1.0));
                float fa = clamp(fluidTap.a, 0.0, 1.0) * sameRegionFluidTap;
                fa *= fUvValid;
                fa *= baseEdgeFade;
                fluidAccumA += fa * fw;
                // fluidTap.rgb is already alpha-weighted in the source pass.
                fluidAccumRgb += fluidTap.rgb * fw * sameRegionFluidTap * fUvValid * baseEdgeFade;
                fluidWeightSum += fwEffective;
              }
            }
          }

          // Encode shadow factor in the red channel (1.0 = fully lit,
          // 0.0 = fully shadowed).
          float shadowFactor = 1.0 - roofCombinedStrength;
          float tileShadowFactor = 1.0 - tileOnlyStrength;
          vec3 shadowRgb = vec3(shadowFactor);

          if (uFluidColorEnabled > 0.5 && uHasFluidRoof > 0.5 && fluidAccumA > 0.0001) {
            float fluidBlurAlpha = fluidAccumA / max(fluidWeightSum, 0.0001);
            vec3 fluidBlurColor = fluidAccumRgb / max(fluidAccumA, 0.0001);
            float fluidLuma = dot(fluidBlurColor, vec3(0.2126, 0.7152, 0.0722));
            // Blend indoor/outdoor tint controls using the continuous indoor
            // weight so partially covered pixels are not stuck on one branch.
            float fluidSaturation = mix(max(uFluidColorSaturation, 0.0), max(uIndoorFluidColorSaturation, 0.0), receiverIndoor);
            fluidBlurColor = mix(vec3(fluidLuma), fluidBlurColor, fluidSaturation);
            fluidBlurColor = clamp(fluidBlurColor * max(uFluidColorBoost, 0.0), 0.0, 1.0);
            float fluidIntensityBoost = mix(max(uFluidShadowIntensityBoost, 0.0), max(uIndoorFluidShadowIntensityBoost, 0.0), receiverIndoor);
            // Root cause of subtle indoor tint: intensity boost previously only
            // affected mix amount, while tint darkness stayed capped by a weak
            // indoor combinedStrength. Apply boost to tint strength too.
            float tintedStrength = clamp(combinedStrength * fluidIntensityBoost, 0.0, 1.0);
            float fluidTintMix = clamp(fluidBlurAlpha * uFluidEffectTransparency * fluidIntensityBoost, 0.0, 1.0);
            vec3 tintedShadow = 1.0 - tintedStrength * (1.0 - fluidBlurColor);
            shadowRgb = mix(shadowRgb, tintedShadow, fluidTintMix);
          }

          // Encode dedicated tile-projection factor in alpha so compositing can
          // apply it independently from roof/outdoor gating.
          gl_FragColor = vec4(shadowRgb, tileShadowFactor);
        }
      `,
      transparent: false
    });

    this.shadowMesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    this.shadowMesh.position.copy(this.baseMesh.position);
    this.shadowMesh.rotation.copy(this.baseMesh.rotation);
    this.shadowMesh.scale.copy(this.baseMesh.scale);

    this.shadowScene.add(this.shadowMesh);
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (!width || !height || !THREE) return;

    if (!this.roofTarget) {
      this.roofTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.roofTarget.setSize(width, height);
    }

    if (this.material && this.material.uniforms && this.material.uniforms.uTexelSize) {
      this.material.uniforms.uTexelSize.value.set(1 / width, 1 / height);
    }
    if (this.material && this.material.uniforms && this.material.uniforms.uResolution) {
      this.material.uniforms.uResolution.value.set(width, height);
    }

    if (!this.shadowTarget) {
      this.shadowTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.shadowTarget.setSize(width, height);
    }

    if (!this.fluidRoofTarget) {
      this.fluidRoofTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.fluidRoofTarget.setSize(width, height);
    }

    if (!this.tileProjectionTarget) {
      this.tileProjectionTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.tileProjectionTarget.setSize(width, height);
    }

    if (!this.tileProjectionSortTarget) {
      this.tileProjectionSortTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.tileProjectionSortTarget.setSize(width, height);
    }

    if (!this.tileReceiverAlphaTarget) {
      this.tileReceiverAlphaTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.tileReceiverAlphaTarget.setSize(width, height);
    }

    if (!this.tileReceiverSortTarget) {
      this.tileReceiverSortTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.tileReceiverSortTarget.setSize(width, height);
    }
  }

  /**
   * EffectComposer will call this before render() when used as a
   * post-processing effect.
   * @param {THREE.Texture} texture
   */
  setInputTexture(texture) {
    // No-op for this effect; it does not directly composite the scene,
    // it only generates a shadow texture consumed by LightingEffect.
    this.inputTexture = texture;
  }

  /**
   * Get effective zoom level from camera.
   * Works with FOV-based zoom (reads sceneComposer.currentZoom),
   * OrthographicCamera (uses camera.zoom), or legacy PerspectiveCamera.
   * @returns {number} Zoom level (1.0 = default)
   * @private
   */
  _getEffectiveZoom() {
    // Prefer sceneComposer.currentZoom (FOV-based zoom system)
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer?.currentZoom !== undefined) {
      return sceneComposer.currentZoom;
    }
    
    if (!this.mainCamera) return 1.0;
    
    // OrthographicCamera: zoom is a direct property
    if (this.mainCamera.isOrthographicCamera) {
      return this.mainCamera.zoom;
    }
    
    // PerspectiveCamera legacy fallback: calculate from Z position
    const baseDist = 10000.0;
    const dist = this.mainCamera.position.z;
    return (dist > 0.1) ? (baseDist / dist) : 1.0;
  }

  /**
   * Resolve a comparable Foundry tile sort key from a tile sprite.
   * @param {THREE.Object3D} object
   * @returns {number}
   * @private
   */
  _getTileSortKey(object) {
    const raw = Number(
      object?.userData?._msSortKey
      ?? object?.userData?.tileDoc?.sort
      ?? object?.userData?.tileDoc?.z
      ?? 0
    );
    return Number.isFinite(raw) ? raw : 0;
  }

  /**
   * Normalize a sort key into [0,1] for alpha-encoded sort passes.
   * @param {number} sortKey
   * @param {number} sortMin
   * @param {number} sortRange
   * @returns {number}
   * @private
   */
  _encodeTileSort(sortKey, sortMin, sortRange) {
    const key = Number.isFinite(sortKey) ? sortKey : 0;
    const min = Number.isFinite(sortMin) ? sortMin : 0;
    const range = Number.isFinite(sortRange) && sortRange > 0.00001 ? sortRange : 1.0;
    return Math.max(0.0, Math.min(1.0, (key - min) / range));
  }

  /**
   * Update sun direction from current time of day.
   *
   * We use WeatherController.timeOfDay (0-24h) which is driven by the
   * "Time of Day" UI slider. This gives us a stable, user-controlled
   * east/west shadow offset instead of a continuously orbiting sun
   * based on elapsed time.
   */
  update(timeInfo) {
    if (!this.material || !this.enabled) return;

    const THREE = window.THREE;
    if (!THREE) return;

    // Read time of day from WeatherController (0-24 hours). Default to
    // noon (12.0) if unavailable.
    let hour = 12.0;
    try {
      if (weatherController && typeof weatherController.timeOfDay === 'number') {
        hour = weatherController.timeOfDay;
      }
    } catch (e) {
      // Fallback: keep default hour
    }

    // Optimization: Skip update if params haven't changed
    const camZoom = this._getEffectiveZoom();
    const updateHash = `${hour.toFixed(3)}_${this.params.sunLatitude}_${this.params.opacity}_${this.params.length}_${this.params.softness}_${camZoom.toFixed(4)}_${this.params.indoorShadowEnabled}_${this.params.indoorShadowOpacity}_${this.params.indoorShadowLengthScale}_${this.params.indoorShadowSoftness}_${this.params.indoorFluidShadowSoftness}_${this.params.indoorFluidShadowIntensityBoost}_${this.params.indoorFluidColorSaturation}_${this.params.tileProjectionEnabled}_${this.params.tileProjectionOpacity}_${this.params.tileProjectionLengthScale}_${this.params.tileProjectionSoftness}_${this.params.tileProjectionThreshold}_${this.params.tileProjectionPower}_${this.params.tileProjectionOutdoorOpacityScale}_${this.params.tileProjectionIndoorOpacityScale}_${this.params.tileProjectionSortBias}_${this.params.fluidColorEnabled}_${this.params.fluidEffectTransparency}_${this.params.fluidShadowIntensityBoost}_${this.params.fluidShadowSoftness}_${this.params.fluidColorBoost}_${this.params.fluidColorSaturation}`;
    
    if (this._lastUpdateHash === updateHash && this.sunDir) return;
    this._lastUpdateHash = updateHash;

    // Map hour to a sun azimuth over a half-orbit.
    // 12h (noon) -> 0 azimuth
    //  6h (sunrise) -> -PI/2
    // 18h (sunset)  -> +PI/2
    const t = (hour % 24.0) / 24.0;
    const azimuth = (t - 0.5) * Math.PI;

    // Sun direction MUST be identical to BuildingShadowsEffect so both
    // effects follow the same daily arc. The shader projection sign (+dir)
    // is what makes both shadow directions visually consistent.
    const x = -Math.sin(azimuth);

    const lat = Math.max(0.0, Math.min(1.0, this.params.sunLatitude ?? 0.5));
    const y = -Math.cos(azimuth) * lat;

    if (!this.sunDir) {
      this.sunDir = new THREE.Vector2(x, y);
    } else {
      this.sunDir.set(x, y);
    }
    if (this.material && this.material.uniforms.uSunDir) {
      this.material.uniforms.uSunDir.value.copy(this.sunDir);
    }

    // Drive basic uniforms from params and camera zoom.
    if (this.material) {
      const u = this.material.uniforms;
      if (u.uOpacity) u.uOpacity.value = this.params.opacity;
      if (u.uLength)  u.uLength.value  = this.params.length;
      if (u.uSoftness) u.uSoftness.value = this.params.softness;
      if (u.uZoom && this.mainCamera) {
        u.uZoom.value = this._getEffectiveZoom();
      }
      // Indoor shadow uniforms — resolve the selected mask from MaskManager
      if (u.uIndoorShadowEnabled) u.uIndoorShadowEnabled.value = this.params.indoorShadowEnabled ? 1.0 : 0.0;
      if (u.uIndoorShadowOpacity) u.uIndoorShadowOpacity.value = this.params.indoorShadowOpacity;
      if (u.uIndoorShadowLengthScale) u.uIndoorShadowLengthScale.value = this.params.indoorShadowLengthScale;
      if (u.uIndoorShadowSoftness) u.uIndoorShadowSoftness.value = this.params.indoorShadowSoftness;
      if (u.uIndoorFluidShadowSoftness) u.uIndoorFluidShadowSoftness.value = this.params.indoorFluidShadowSoftness;
      if (u.uIndoorFluidShadowIntensityBoost) u.uIndoorFluidShadowIntensityBoost.value = this.params.indoorFluidShadowIntensityBoost;
      if (u.uIndoorFluidColorSaturation) u.uIndoorFluidColorSaturation.value = this.params.indoorFluidColorSaturation;
      if (u.uTileProjectionEnabled) u.uTileProjectionEnabled.value = this.params.tileProjectionEnabled ? 1.0 : 0.0;
      if (u.uTileProjectionOpacity) u.uTileProjectionOpacity.value = this.params.tileProjectionOpacity;
      if (u.uTileProjectionLengthScale) u.uTileProjectionLengthScale.value = this.params.tileProjectionLengthScale;
      if (u.uTileProjectionSoftness) u.uTileProjectionSoftness.value = this.params.tileProjectionSoftness;
      if (u.uTileProjectionThreshold) u.uTileProjectionThreshold.value = this.params.tileProjectionThreshold;
      if (u.uTileProjectionPower) u.uTileProjectionPower.value = this.params.tileProjectionPower;
      if (u.uTileProjectionOutdoorOpacityScale) u.uTileProjectionOutdoorOpacityScale.value = this.params.tileProjectionOutdoorOpacityScale;
      if (u.uTileProjectionIndoorOpacityScale) u.uTileProjectionIndoorOpacityScale.value = this.params.tileProjectionIndoorOpacityScale;
      if (u.uTileProjectionSortBias) u.uTileProjectionSortBias.value = this.params.tileProjectionSortBias;
      if (u.uFluidColorEnabled) u.uFluidColorEnabled.value = this.params.fluidColorEnabled ? 1.0 : 0.0;
      if (u.uFluidEffectTransparency) u.uFluidEffectTransparency.value = this.params.fluidEffectTransparency;
      if (u.uFluidShadowIntensityBoost) u.uFluidShadowIntensityBoost.value = this.params.fluidShadowIntensityBoost;
      if (u.uFluidShadowSoftness) u.uFluidShadowSoftness.value = this.params.fluidShadowSoftness;
      if (u.uFluidColorBoost) u.uFluidColorBoost.value = this.params.fluidColorBoost;
      if (u.uFluidColorSaturation) u.uFluidColorSaturation.value = this.params.fluidColorSaturation;

      // Scene dimensions for mask UV conversion (world-space mask offset)
      if (u.uSceneDimensions) {
        try {
          const dims = canvas?.dimensions;
          if (dims) {
            const sw = dims.sceneWidth || dims.width || 1;
            const sh = dims.sceneHeight || dims.height || 1;
            u.uSceneDimensions.value.set(sw, sh);
          }
        } catch (_) { /* canvas may not be ready */ }
      }

      // Indoor shadow is always sourced from _Outdoors.
      // (White = outdoors, dark = indoors; shader inverts it for indoor weight.)
      const activeMask = this.outdoorsMask;
      if (u.uOutdoorsMask) u.uOutdoorsMask.value = activeMask;
      if (u.uHasOutdoorsMask) u.uHasOutdoorsMask.value = activeMask ? 1.0 : 0.0;
    }
  }

  /**
   * Render the effect as a full-screen pass.
   */
  render(renderer, scene, camera) {
    if (!this.enabled || !this.material) return;

    const THREE = window.THREE;
    if (!THREE || !this.mainCamera || !this.mainScene || !this.shadowScene) return;

    // Ensure roof target exists and is correctly sized
    // PERFORMANCE: Reuse Vector2 instead of allocating every frame
    if (!this._tempSize) this._tempSize = new THREE.Vector2();
    const size = this._tempSize;
    renderer.getDrawingBufferSize(size);

    if (!this.roofTarget
      || !this.shadowTarget
      || !this.fluidRoofTarget
      || !this.tileProjectionTarget
      || !this.tileProjectionSortTarget
      || !this.tileReceiverAlphaTarget
      || !this.tileReceiverSortTarget) {
      this.onResize(size.x, size.y);
    } else if (this.roofTarget.width !== size.x || this.roofTarget.height !== size.y) {
      this.onResize(size.x, size.y);
    }

    // 1. Render ROOF_LAYER (20) into roofTarget as alpha mask.
    //    To keep shadows present even when overhead tiles are hover-hidden
    //    (their sprite opacity fades out for UX), we temporarily force
    //    roof sprite materials to full opacity for this mask pass only.
    const ROOF_LAYER = 20;
    const previousLayersMask = this.mainCamera.layers.mask;
    const previousTarget = renderer.getRenderTarget();

    // Capture roof/fluid with a guard-band expanded camera view so projected
    // sampling near viewport edges still has valid source texels.
    const zoom = this._getEffectiveZoom();
    const maxProjectionScale = Math.max(
      1.0,
      Number(this.params.tileProjectionLengthScale) || 0.0,
      Number(this.params.indoorShadowLengthScale) || 0.0
    );
    const maxSoftness = Math.max(
      Number(this.params.softness) || 0.0,
      Number(this.params.indoorShadowSoftness) || 0.0,
      Number(this.params.fluidShadowSoftness) || 0.0,
      Number(this.params.indoorFluidShadowSoftness) || 0.0,
      Number(this.params.tileProjectionSoftness) || 0.0
    );
    const baseProjectionPx = (Number(this.params.length) || 0.0) * 1080.0 * Math.max(zoom, 0.0001);
    const projectionPx = baseProjectionPx * maxProjectionScale;
    const blurPx = maxSoftness * 2.0;
    const guardPx = Math.max(8.0, projectionPx + blurPx + 2.0);
    const guardScaleX = 1.0 + (2.0 * guardPx / Math.max(size.x, 1));
    const guardScaleY = 1.0 + (2.0 * guardPx / Math.max(size.y, 1));
    const roofCaptureScale = Math.max(guardScaleX, guardScaleY);

    const restoreRoofCaptureCamera = this._applyRoofCaptureGuardScale(roofCaptureScale);
    if (this.material?.uniforms?.uRoofUvScale) {
      this.material.uniforms.uRoofUvScale.value = 1.0 / Math.max(roofCaptureScale, 1.0);
    }
    if (this.material?.uniforms?.uTileProjectionUvScale) {
      this.material.uniforms.uTileProjectionUvScale.value = 1.0;
    }

    const overrides = [];
    const fluidVisibilityOverrides = [];
    const fluidUniformOverrides = [];
    const nonFluidVisibilityOverrides = [];
    const roofSpriteVisibilityOverrides = [];
    const tileProjectionVisibilityOverrides = [];
    const tileProjectionOpacityOverrides = [];
    const tileReceiverVisibilityOverrides = [];
    const tileReceiverOpacityOverrides = [];
    const roofMaskBit = 1 << ROOF_LAYER;
    this.mainScene.traverse((object) => {
      if (!object.layers || !object.material) return;

      // Directly test the ROOF_LAYER bit to avoid Layers.test() argument issues.
      if ((object.layers.mask & roofMaskBit) === 0) return;

      if (typeof object.visible === 'boolean') {
        fluidVisibilityOverrides.push({ object, visible: object.visible });
        const isFluidOverlay = !!(object.material?.uniforms?.tFluidMask);
        object.visible = isFluidOverlay;

        if (isFluidOverlay) {
          const uniforms = object.material?.uniforms;
          if (uniforms) {
            fluidUniformOverrides.push({
              uniforms,
              tileOpacity: uniforms.uTileOpacity?.value,
              roofOcclusionEnabled: uniforms.uRoofOcclusionEnabled?.value
            });
            if (uniforms.uTileOpacity) uniforms.uTileOpacity.value = 1.0;
            if (uniforms.uRoofOcclusionEnabled) uniforms.uRoofOcclusionEnabled.value = 0.0;
          }
        }
      }

      if (!object.isSprite) return;
      const mat = object.material;
      if (typeof mat.opacity !== 'number') return;
      overrides.push({ object, opacity: mat.opacity });
      // IMPORTANT: Hover-hide is a UX-only fade on roof sprites. We intentionally
      // keep overhead shadows active while hovering, so the shadow mask render
      // pass always treats roof sprites as fully opaque.
      mat.opacity = 1.0;
    });

    // Pass 0/1 use guard-band camera state (temporarily expanded frustum).
    try {
      // Pass 0: render only FluidEffect overlays attached to overhead tiles.
      this.mainCamera.layers.set(ROOF_LAYER);
      renderer.setRenderTarget(this.fluidRoofTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);

    for (const entry of fluidVisibilityOverrides) {
      if (entry.object) {
        entry.object.visible = entry.visible;
      }
    }
    for (const entry of fluidUniformOverrides) {
      if (!entry?.uniforms) continue;
      if (entry.uniforms.uTileOpacity && typeof entry.tileOpacity === 'number') {
        entry.uniforms.uTileOpacity.value = entry.tileOpacity;
      }
      if (entry.uniforms.uRoofOcclusionEnabled && typeof entry.roofOcclusionEnabled === 'number') {
        entry.uniforms.uRoofOcclusionEnabled.value = entry.roofOcclusionEnabled;
      }
    }

      // Pass 1 should be based on overhead tile sprites only (exclude fluid overlays).
      this.mainScene.traverse((object) => {
        if (!object.layers || (object.layers.mask & roofMaskBit) === 0) return;
        const isFluidOverlay = !!(object.material?.uniforms?.tFluidMask);
        if (isFluidOverlay) {
          if (typeof object.visible === 'boolean') {
            nonFluidVisibilityOverrides.push({ object, visible: object.visible });
            object.visible = false;
          }
          return;
        }

        // Hover-reveal can temporarily hide/fade roof sprites. For the roof mask
        // capture pass we still need those tiles to contribute caster alpha.
        if (object.isSprite && typeof object.visible === 'boolean') {
          roofSpriteVisibilityOverrides.push({ object, visible: object.visible });
          object.visible = true;
        }
      });

      // Pass 1: render overhead tiles into roofTarget (alpha mask)
      this.mainCamera.layers.set(ROOF_LAYER);
      renderer.setRenderTarget(this.roofTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);
    } finally {
      restoreRoofCaptureCamera();
    }

    // Restore per-sprite opacity now that roof mask capture is done.
    // Tile projection should use each tile's true alpha/opacity settings.
    for (const entry of overrides) {
      if (entry.object && entry.object.material) {
        entry.object.material.opacity = entry.opacity;
      }
    }
    for (const entry of roofSpriteVisibilityOverrides) {
      if (entry.object) entry.object.visible = entry.visible;
    }

    // IMPORTANT: restore camera layers before rendering the world-pinned
    // shadow mesh so the base plane is visible to the camera again.
    this.mainCamera.layers.mask = previousLayersMask;

    // Pass 1.5: optional tile alpha projection pass.
    // Uses the per-tile "Shadow Projection" flags from TileMotionManager,
    // but only for tiles that are motion-enabled.
    let hasTileProjection = false;
    let hasTileProjectionSort = false;
    let hasTileReceiverSort = false;
    const tileProjectionIds = this.params.tileProjectionEnabled
      ? (window.MapShine?.tileMotionManager?.getShadowProjectionTileIds?.() || [])
      : [];
    if (tileProjectionIds.length > 0
      && this.tileProjectionTarget
      && this.tileProjectionSortTarget
      && this.tileReceiverAlphaTarget
      && this.tileReceiverSortTarget) {
      const idSet = new Set(tileProjectionIds);

      // Build a dynamic sort normalization range from currently present tile
      // sprites so projected-caster and receiver sort maps stay comparable.
      let sortMin = Infinity;
      let sortMax = -Infinity;
      this.mainScene.traverse((object) => {
        if (!object?.isSprite || !object?.material) return;
        if (!object?.userData?.foundryTileId) return;
        const sortKey = this._getTileSortKey(object);
        if (sortKey < sortMin) sortMin = sortKey;
        if (sortKey > sortMax) sortMax = sortKey;
      });
      if (!Number.isFinite(sortMin) || !Number.isFinite(sortMax)) {
        sortMin = 0;
        sortMax = 1;
      }
      const sortDelta = sortMax - sortMin;
      const canUseSortOcclusion = Number.isFinite(sortDelta) && sortDelta > 0.00001;
      const sortRange = canUseSortOcclusion ? sortDelta : 1.0;

      // Projection contributors need the same guard-band strategy as roof
      // captures because projected lookups can sample opposite screen edges.
      const tileProjectionPx = baseProjectionPx * Math.max(Number(this.params.tileProjectionLengthScale) || 0.0, 0.0);
      const tileProjectionBlurPx = Math.max(Number(this.params.tileProjectionSoftness) || 0.0, 0.0) * 2.0;
      const tileGuardPx = Math.max(8.0, tileProjectionPx + tileProjectionBlurPx + 2.0);
      const tileGuardScaleX = 1.0 + (2.0 * tileGuardPx / Math.max(size.x, 1));
      const tileGuardScaleY = 1.0 + (2.0 * tileGuardPx / Math.max(size.y, 1));
      const tileCaptureScale = Math.max(tileGuardScaleX, tileGuardScaleY);

      // Receiver sort maps: capture currently visible top tile stacking so
      // projected casters can be occluded by higher-sort receiver tiles.
      this.mainScene.traverse((object) => {
        const isRenderable = !!(object.isSprite || object.isMesh || object.isPoints || object.isLine);
        if (!isRenderable || typeof object.visible !== 'boolean') return;
        tileReceiverVisibilityOverrides.push({ object, visible: object.visible });

        const keepVisible = !!(object.visible && object.isSprite && object?.userData?.foundryTileId && object.material);
        object.visible = keepVisible;

        if (keepVisible && typeof object.material?.opacity === 'number') {
          tileReceiverOpacityOverrides.push({ object, opacity: object.material.opacity });
        }
      });

      // Receiver alpha pass (original alpha/opacity).
      this.mainCamera.layers.enableAll();
      renderer.setRenderTarget(this.tileReceiverAlphaTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);

      // Receiver sort pass (alpha multiplied by normalized sort).
      // Skip when all tiles share the same sort, because there is no ordering
      // signal to compare and a degenerate range would over-suppress shadows.
      if (canUseSortOcclusion) {
        for (const entry of tileReceiverOpacityOverrides) {
          if (!entry.object?.material || typeof entry.opacity !== 'number') continue;
          const sortKey = this._getTileSortKey(entry.object);
          const sortNorm = this._encodeTileSort(sortKey, sortMin, sortRange);
          entry.object.material.opacity = entry.opacity * sortNorm;
        }

        renderer.setRenderTarget(this.tileReceiverSortTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(this.mainScene, this.mainCamera);
        hasTileReceiverSort = true;
      }

      for (const entry of tileReceiverOpacityOverrides) {
        if (!entry.object?.material || typeof entry.opacity !== 'number') continue;
        entry.object.material.opacity = entry.opacity;
      }
      for (const entry of tileReceiverVisibilityOverrides) {
        if (entry.object) entry.object.visible = entry.visible;
      }

      // Contributor alpha pass for selected projection caster tiles.
      this.mainScene.traverse((object) => {
        const isRenderable = !!(object.isSprite || object.isMesh || object.isPoints || object.isLine);
        if (!isRenderable || typeof object.visible !== 'boolean') return;
        tileProjectionVisibilityOverrides.push({ object, visible: object.visible });

        const tileId = object?.userData?.foundryTileId;
        const keepVisible = !!(object.isSprite && tileId && idSet.has(tileId));
        // Projection should still capture tiles that are currently hidden/faded
        // by indoor roof reveal logic. Force selected contributors visible.
        object.visible = keepVisible;

        // Ignore runtime sprite opacity fades (e.g. hover/roof hide) so the
        // projection pass captures the tile alpha silhouette consistently.
        if (keepVisible && object.isSprite && typeof object.material?.opacity === 'number') {
          tileProjectionOpacityOverrides.push({ object, opacity: object.material.opacity });
          object.material.opacity = 1.0;
        }
      });

      // Tile projection can target any tile layer (not only ROOF_LAYER).
      // We isolate contributors via visibility overrides, so enabling all
      // camera layers here ensures selected tiles are always capturable.
      const restoreTileCaptureCamera = this._applyRoofCaptureGuardScale(tileCaptureScale);
      if (this.material?.uniforms?.uTileProjectionUvScale) {
        this.material.uniforms.uTileProjectionUvScale.value = 1.0 / Math.max(tileCaptureScale, 1.0);
      }
      try {
        this.mainCamera.layers.enableAll();

        renderer.setRenderTarget(this.tileProjectionTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(this.mainScene, this.mainCamera);

        // Contributor sort pass (same selected casters, alpha multiplied by
        // normalized sort) for per-pixel sort occlusion in the projection shader.
        if (canUseSortOcclusion) {
          for (const entry of tileProjectionOpacityOverrides) {
            if (!entry.object?.material || typeof entry.opacity !== 'number') continue;
            const sortKey = this._getTileSortKey(entry.object);
            const sortNorm = this._encodeTileSort(sortKey, sortMin, sortRange);
            entry.object.material.opacity = sortNorm;
          }

          renderer.setRenderTarget(this.tileProjectionSortTarget);
          renderer.setClearColor(0x000000, 0);
          renderer.clear();
          renderer.render(this.mainScene, this.mainCamera);
          hasTileProjectionSort = true;
        }
      } finally {
        restoreTileCaptureCamera();
      }

      hasTileProjection = true;
    }

    this.mainCamera.layers.mask = previousLayersMask;

    for (const entry of tileProjectionVisibilityOverrides) {
      if (entry.object) entry.object.visible = entry.visible;
    }
    for (const entry of tileProjectionOpacityOverrides) {
      if (entry.object?.material && typeof entry.opacity === 'number') {
        entry.object.material.opacity = entry.opacity;
      }
    }

    // Pass 2: build shadow texture from roofTarget using a world-pinned
    // groundplane mesh that samples the roof mask in screen space.
    if (this.material && this.material.uniforms) {
      this.material.uniforms.tRoof.value = this.roofTarget.texture;
      this.material.uniforms.tFluidRoof.value = this.fluidRoofTarget?.texture || null;
      this.material.uniforms.uHasFluidRoof.value = this.fluidRoofTarget?.texture ? 1.0 : 0.0;
      this.material.uniforms.tTileProjection.value = hasTileProjection ? this.tileProjectionTarget?.texture : null;
      this.material.uniforms.uHasTileProjection.value = hasTileProjection ? 1.0 : 0.0;
      this.material.uniforms.tTileProjectionSort.value = hasTileProjectionSort ? this.tileProjectionSortTarget?.texture : null;
      this.material.uniforms.uHasTileProjectionSort.value = hasTileProjectionSort ? 1.0 : 0.0;
      this.material.uniforms.tTileReceiverAlpha.value = hasTileReceiverSort ? this.tileReceiverAlphaTarget?.texture : null;
      this.material.uniforms.tTileReceiverSort.value = hasTileReceiverSort ? this.tileReceiverSortTarget?.texture : null;
      this.material.uniforms.uHasTileReceiverSort.value = hasTileReceiverSort ? 1.0 : 0.0;
      if (this.material.uniforms.uResolution) {
        this.material.uniforms.uResolution.value.set(size.x, size.y);
      }

      // Bind depth pass for height-based shadow modulation
      const dpm = window.MapShine?.depthPassManager;
      const depthTex = (dpm && dpm.isEnabled()) ? dpm.getDepthTexture() : null;
      if (this.material.uniforms.uDepthEnabled) {
        this.material.uniforms.uDepthEnabled.value = depthTex ? 1.0 : 0.0;
      }
      if (this.material.uniforms.uDepthTexture) {
        this.material.uniforms.uDepthTexture.value = depthTex;
      }
      if (depthTex && dpm) {
        if (this.material.uniforms.uDepthCameraNear) this.material.uniforms.uDepthCameraNear.value = dpm.getDepthNear();
        if (this.material.uniforms.uDepthCameraFar) this.material.uniforms.uDepthCameraFar.value = dpm.getDepthFar();
        if (this.material.uniforms.uGroundDistance) {
          this.material.uniforms.uGroundDistance.value = window.MapShine?.sceneComposer?.groundDistance ?? 1000.0;
        }
      }
    }

    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this.shadowScene, this.mainCamera);

    for (const entry of nonFluidVisibilityOverrides) {
      if (entry.object) entry.object.visible = entry.visible;
    }

    // Restore previous render target
    renderer.setRenderTarget(previousTarget);
  }

  dispose() {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    if (this.roofTarget) {
      this.roofTarget.dispose();
      this.roofTarget = null;
    }
    if (this.shadowTarget) {
      this.shadowTarget.dispose();
      this.shadowTarget = null;
    }
    if (this.fluidRoofTarget) {
      this.fluidRoofTarget.dispose();
      this.fluidRoofTarget = null;
    }
    if (this.tileProjectionTarget) {
      this.tileProjectionTarget.dispose();
      this.tileProjectionTarget = null;
    }
    if (this.tileProjectionSortTarget) {
      this.tileProjectionSortTarget.dispose();
      this.tileProjectionSortTarget = null;
    }
    if (this.tileReceiverAlphaTarget) {
      this.tileReceiverAlphaTarget.dispose();
      this.tileReceiverAlphaTarget = null;
    }
    if (this.tileReceiverSortTarget) {
      this.tileReceiverSortTarget.dispose();
      this.tileReceiverSortTarget = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this.shadowMesh && this.shadowScene) {
      this.shadowScene.remove(this.shadowMesh);
      this.shadowMesh = null;
    }
    this.shadowScene = null;
    log.info('OverheadShadowsEffect disposed');
  }
}
