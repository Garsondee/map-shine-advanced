/**
 * @fileoverview ShadowManagerV2 — combines cloud + overhead + building + painted +
 * sky-reach + tree/bush billboard canopy factors.
 *
 * Contract:
 * - Inputs are shadow factors in [0..1], where 1 = fully lit.
 * - Output is their product (independent darkening), for ambient-darkening consumers.
 */

import { createLogger } from '../../core/log.js';
import {
  applySceneViewProjectionToUniforms,
  createSceneViewProjectionCache,
  updateSceneViewProjectionFromCamera,
} from '../scene-view-projection.js';

const log = createLogger('ShadowManagerV2');

export class ShadowManagerV2 {
  constructor() {
    this.enabled = true;
    this._initialized = false;

    this.params = {
      cloudWeight: 1.0,
      cloudOpacity: 1.0,
      overheadOpacity: 1.0,
      overheadOcclusionStrength: 1.0,
      buildingOpacity: 1.0,
      paintedOpacity: 1.0,
      /**
       * Independent opacity for {@link SkyReachShadowsEffectV2}. The effect's
       * own `params.opacity` already shapes its strength; this slider lets a
       * deployer dim the contribution at combine time without retuning the
       * source.
       */
      skyReachOpacity: 1.0,
      treeBillboardOpacity: 1.0,
      bushBillboardOpacity: 1.0,
    };

    this._combinedRT = null;
    this._combinedRawRT = null;
    this._scene = null;
    this._camera = null;
    this._quad = null;
    this._material = null;
    this._sizeVec = null;

    this._cloudShadowTexture = null;
    this._cloudShadowRawTexture = null;
    this._overheadShadowTexture = null;
    this._buildingShadowTexture = null;
    this._paintedShadowTexture = null;
    this._skyReachShadowTexture = null;
    this._treeBillboardShadowTexture = null;
    this._bushBillboardShadowTexture = null;
    this._lightningBuildingTexture = null;
    this._lightningSkyReachTexture = null;
    this._lightningPaintedTexture = null;
    this._lightningVegetationTexture = null;
    this._landscapeLightningFlash01 = 0;
    this._landscapeLightningShadowWeight = 0;
    this._landscapeLightningShadowDarkness = 1.0;
    this._inputList = null;
    /** @type {import('../scene-view-projection.js').SceneViewProjectionCache|null} */
    this._viewProjectionCache = null;
    this._tmpNdcVec = null;
    this._tmpWorldVec = null;
    this._tmpDirVec = null;
    /** Reused WebGLRenderTarget options — avoid per-resize object churn. */
    this._rtOpts = null;
    /** Cached scene rect in Foundry pixels (x, y, width, height). */
    this._sceneRectVec = null;
    this._hasSceneRect = false;
  }

  /**
   * Blend pre-baked landscape lightning shadow factors during active flash.
   * @param {object} [opts]
   * @param {number} [opts.flash01]
   * @param {number} [opts.shadowWeight]
   * @param {number} [opts.shadowDarkness] Lit-factor power (>1 = deeper lightning shadows).
   * @param {THREE.Texture|null} [opts.building]
   * @param {THREE.Texture|null} [opts.skyReach]
   * @param {THREE.Texture|null} [opts.painted]
   * @param {THREE.Texture|null} [opts.vegetation]
   */
  setLandscapeLightningBlend(opts = {}) {
    const flash01 = Math.max(0, Math.min(1, Number(opts.flash01) || 0));
    const shadowWeight = Math.max(0, Math.min(1, Number(opts.shadowWeight) || 0));
    this._landscapeLightningFlash01 = flash01;
    this._landscapeLightningShadowWeight = shadowWeight;
    this._landscapeLightningShadowDarkness = Math.max(1, Number(opts.shadowDarkness) || 1);
    const blend = flash01 * shadowWeight;
    if (blend <= 0.0001) {
      this._lightningBuildingTexture = null;
      this._lightningSkyReachTexture = null;
      this._lightningPaintedTexture = null;
      this._lightningVegetationTexture = null;
      return;
    }
    this._lightningBuildingTexture = opts.building ?? null;
    this._lightningSkyReachTexture = opts.skyReach ?? null;
    this._lightningPaintedTexture = opts.painted ?? null;
    this._lightningVegetationTexture = opts.vegetation ?? null;
  }

  initialize(renderer, width, height) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;
    if (this._initialized) return;

    this._sizeVec = new THREE.Vector2();
    this._sceneRectVec = new THREE.Vector4();
    this._viewProjectionCache = createSceneViewProjectionCache();
    this._tmpNdcVec = new THREE.Vector3();
    this._tmpWorldVec = new THREE.Vector3();
    this._tmpDirVec = new THREE.Vector3();
    this._rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tCloudShadow: { value: null },
        tCloudShadowRaw: { value: null },
        tOverheadShadow: { value: null },
        tBuildingShadow: { value: null },
        tPaintedShadow: { value: null },
        tSkyReachShadow: { value: null },
        tTreeBillboardShadow: { value: null },
        tBushBillboardShadow: { value: null },
        uHasCloudShadow: { value: 0.0 },
        uHasCloudShadowRaw: { value: 0.0 },
        uHasOverheadShadow: { value: 0.0 },
        uHasBuildingShadow: { value: 0.0 },
        uHasPaintedShadow: { value: 0.0 },
        uHasSkyReachShadow: { value: 0.0 },
        uHasTreeBillboardShadow: { value: 0.0 },
        uHasBushBillboardShadow: { value: 0.0 },
        uUseRawCloud: { value: 0.0 },
        uCloudWeight: { value: 1.0 },
        uCloudOpacity: { value: 1.0 },
        uOverheadOpacity: { value: 1.0 },
        uBuildingOpacity: { value: 1.0 },
        uPaintedOpacity: { value: 1.0 },
        uSkyReachOpacity: { value: 1.0 },
        uTreeBillboardOpacity: { value: 1.0 },
        uBushBillboardOpacity: { value: 1.0 },
        // Coordinate conversion uniforms for building shadows (world space)
        uSceneRect: { value: this._sceneRectVec },
        uHasSceneRect: { value: 0.0 },
        // Match water-shader.js + LightingEffectV2: vUv → Foundry → sceneUv for tBuildingShadow.
        uViewBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        uHasBuildingUvRemap: { value: 0.0 },
        tLightningBuilding: { value: null },
        tLightningSkyReach: { value: null },
        tLightningPainted: { value: null },
        tLightningVegetation: { value: null },
        uHasLightningBuilding: { value: 0.0 },
        uHasLightningSkyReach: { value: 0.0 },
        uHasLightningPainted: { value: 0.0 },
        uHasLightningVegetation: { value: 0.0 },
        uLandscapeLightningBlend: { value: 0.0 },
        uLandscapeLightningShadowDarkness: { value: 1.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tCloudShadow;
        uniform sampler2D tCloudShadowRaw;
        uniform sampler2D tOverheadShadow;
        uniform sampler2D tBuildingShadow;
        uniform sampler2D tPaintedShadow;
        uniform sampler2D tSkyReachShadow;
        uniform sampler2D tTreeBillboardShadow;
        uniform sampler2D tBushBillboardShadow;
        uniform float uHasCloudShadow;
        uniform float uHasCloudShadowRaw;
        uniform float uHasOverheadShadow;
        uniform float uHasBuildingShadow;
        uniform float uHasPaintedShadow;
        uniform float uHasSkyReachShadow;
        uniform float uHasTreeBillboardShadow;
        uniform float uHasBushBillboardShadow;
        uniform float uUseRawCloud;
        uniform float uCloudWeight;
        uniform float uCloudOpacity;
        uniform float uOverheadOpacity;
        uniform float uBuildingOpacity;
        uniform float uPaintedOpacity;
        uniform float uSkyReachOpacity;
        uniform float uTreeBillboardOpacity;
        uniform float uBushBillboardOpacity;
        // Coordinate conversion uniforms for building shadows (world space)
        uniform vec4 uSceneRect;
        uniform float uHasSceneRect;
        uniform vec4 uViewBounds;
        uniform vec2 uSceneDimensions;
        uniform float uHasBuildingUvRemap;
        uniform sampler2D tLightningBuilding;
        uniform sampler2D tLightningSkyReach;
        uniform sampler2D tLightningPainted;
        uniform sampler2D tLightningVegetation;
        uniform float uHasLightningBuilding;
        uniform float uHasLightningSkyReach;
        uniform float uHasLightningPainted;
        uniform float uHasLightningVegetation;
        uniform float uLandscapeLightningBlend;
        uniform float uLandscapeLightningShadowDarkness;
        varying vec2 vUv;

        float blendLightningLit(float liveLit, float lightningLit, float hasLightning) {
          float b = clamp(uLandscapeLightningBlend, 0.0, 1.0) * step(0.5, hasLightning);
          b = b * b * (3.0 - 2.0 * b);
          float bolt = clamp(lightningLit, 0.0, 1.0);
          float darkPow = max(1.0, uLandscapeLightningShadowDarkness);
          if (darkPow > 1.001) bolt = pow(bolt, darkPow);
          // Union with live sun shadows — lightning darkens further but never erases existing shadow.
          float merged = min(liveLit, bolt);
          return mix(liveLit, merged, b);
        }

        vec2 smScreenUvToFoundry(vec2 screenUv) {
          float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
          return vec2(threeX, uSceneDimensions.y - threeY);
        }

        vec2 smFoundryToSceneUv(vec2 foundryPos) {
          return (foundryPos - uSceneRect.xy) / max(uSceneRect.zw, vec2(1e-5));
        }

        /**
         * Building / painted / sky-reach factor textures are in normalized scene UV
         * (same as LightingEffectV2). Never use vUv * uSceneRect.zw + uSceneRect.xy:
         * uSceneRect is in Foundry pixels, so that expression clamps to (1,1) and
         * wipes all world-space shadows in this combiner.
         */
        vec2 smSceneUvForWorldTextures(vec2 screenUv) {
          if (uHasSceneRect < 0.5) return screenUv;
          bool useRemap = (uHasBuildingUvRemap > 0.5);
          if (!useRemap) {
            float spanX = abs(uViewBounds.z - uViewBounds.x);
            float spanY = abs(uViewBounds.w - uViewBounds.y);
            useRemap = (uSceneDimensions.x > 2.0 && uSceneDimensions.y > 2.0
              && spanX > 1e-4 && spanY > 1e-4);
          }
          if (useRemap) {
            vec2 foundryPos = smScreenUvToFoundry(screenUv);
            return clamp(smFoundryToSceneUv(foundryPos), vec2(0.0), vec2(1.0));
          }
          return screenUv;
        }

        float readCloudShadow() {
          // Masked cloud RT (CloudEffectV2 _shadowRT) is view-aligned with world-stable
          // sampling via the mask pass. Always prefer it over raw scene capture.
          if (uHasCloudShadow > 0.5) {
            return clamp(texture2D(tCloudShadow, vUv).r, 0.0, 1.0);
          }
          // Fallback: scene-space raw capture — must not use screen vUv directly.
          if (uUseRawCloud > 0.5 && uHasCloudShadowRaw > 0.5) {
            vec2 sceneUv = smSceneUvForWorldTextures(vUv);
            return clamp(texture2D(tCloudShadowRaw, sceneUv).r, 0.0, 1.0);
          }
          return 1.0;
        }

        float readOverheadShadow() {
          if (uHasOverheadShadow < 0.5) return 1.0;
          vec4 ov = texture2D(tOverheadShadow, vUv);
          vec3 rgb = clamp(ov.rgb, vec3(0.0), vec3(1.0));
          float projection = clamp(ov.a, 0.0, 1.0);
          // Match water-shader + LightingEffectV2: lit factor from mean of (RGB × projection),
          // not max(RGB) (max stays too bright vs ambient dimming under tinted roofs).
          vec3 combinedRgb = rgb * projection;
          return clamp(dot(combinedRgb, vec3(0.3333333)), 0.0, 1.0);
        }

        float readBuildingShadow() {
          if (uHasBuildingShadow < 0.5) return 1.0;
          vec2 sceneUv = smSceneUvForWorldTextures(vUv);
          float liveV = clamp(texture2D(tBuildingShadow, sceneUv).r, 0.0, 1.0);
          if (uHasLightningBuilding < 0.5) return liveV;
          float boltV = clamp(texture2D(tLightningBuilding, sceneUv).r, 0.0, 1.0);
          return blendLightningLit(liveV, boltV, uHasLightningBuilding);
        }

        float readPaintedShadow() {
          if (uHasPaintedShadow < 0.5) return 1.0;
          vec2 sceneUv = smSceneUvForWorldTextures(vUv);
          float liveV = clamp(texture2D(tPaintedShadow, sceneUv).r, 0.0, 1.0);
          if (uHasLightningPainted < 0.5) return liveV;
          float boltV = clamp(texture2D(tLightningPainted, sceneUv).r, 0.0, 1.0);
          return blendLightningLit(liveV, boltV, uHasLightningPainted);
        }

        float readSkyReachShadow() {
          if (uHasSkyReachShadow < 0.5) return 1.0;
          vec2 sceneUv = smSceneUvForWorldTextures(vUv);
          float liveV = clamp(texture2D(tSkyReachShadow, sceneUv).r, 0.0, 1.0);
          if (uHasLightningSkyReach < 0.5) return liveV;
          float boltV = clamp(texture2D(tLightningSkyReach, sceneUv).r, 0.0, 1.0);
          return blendLightningLit(liveV, boltV, uHasLightningSkyReach);
        }

        float readTreeBillboardShadow() {
          if (uHasTreeBillboardShadow < 0.5) return 1.0;
          float liveV = clamp(texture2D(tTreeBillboardShadow, vUv).r, 0.0, 1.0);
          if (uHasLightningVegetation < 0.5) return liveV;
          float boltV = clamp(texture2D(tLightningVegetation, vUv).r, 0.0, 1.0);
          return blendLightningLit(liveV, boltV, uHasLightningVegetation);
        }

        float readBushBillboardShadow() {
          if (uHasBushBillboardShadow < 0.5) return 1.0;
          float liveV = clamp(texture2D(tBushBillboardShadow, vUv).r, 0.0, 1.0);
          if (uHasLightningVegetation < 0.5) return liveV;
          float boltV = clamp(texture2D(tLightningVegetation, vUv).r, 0.0, 1.0);
          return blendLightningLit(liveV, boltV, uHasLightningVegetation);
        }

        void main() {
          float cloudBase = readCloudShadow();
          float overheadBase = readOverheadShadow();
          float buildingBase = readBuildingShadow();
          float paintedBase = readPaintedShadow();
          float skyReachBase = readSkyReachShadow();
          float treeBillboardBase = readTreeBillboardShadow();
          float bushBillboardBase = readBushBillboardShadow();

          float cloud = mix(1.0, cloudBase, clamp(uCloudOpacity, 0.0, 1.0));
          float overhead = mix(1.0, overheadBase, clamp(uOverheadOpacity, 0.0, 1.0));
          float building = mix(1.0, buildingBase, clamp(uBuildingOpacity, 0.0, 1.0));
          float painted = mix(1.0, paintedBase, clamp(uPaintedOpacity, 0.0, 1.0));
          float skyReach = mix(1.0, skyReachBase, clamp(uSkyReachOpacity, 0.0, 1.0));
          float treeBb = mix(1.0, treeBillboardBase, clamp(uTreeBillboardOpacity, 0.0, 1.0));
          float bushBb = mix(1.0, bushBillboardBase, clamp(uBushBillboardOpacity, 0.0, 1.0));
          float cw = clamp(uCloudWeight, 0.0, 1.0);
          float combined = overhead * building * painted * skyReach * treeBb * bushBb * mix(1.0, cloud, cw);
          // Raw RT: alpha carries overhead-only factor so LightingEffectV2 can keep
          // porch/daylight lift from erasing stamp shadows outdoors (see uUseRawCloud).
          float rawAlpha = (uUseRawCloud > 0.5) ? overhead : 1.0;
          gl_FragColor = vec4(combined, combined, combined, rawAlpha);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._material.toneMapped = false;

    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);

    this._initialized = true;
    this.onResize(width, height);
    log.info('ShadowManagerV2 initialized');
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (!THREE || !this._initialized) return;
    const w = Math.max(1, Number(width) || 1);
    const h = Math.max(1, Number(height) || 1);
    const opts = this._rtOpts;
    if (this._combinedRT) this._combinedRT.setSize(w, h);
    else this._combinedRT = new THREE.WebGLRenderTarget(w, h, opts);
    if (this._combinedRawRT) this._combinedRawRT.setSize(w, h);
    else this._combinedRawRT = new THREE.WebGLRenderTarget(w, h, opts);
  }

  /**
   * Zero-allocation per-frame texture binding (preferred over {@link #setInputList}).
   * @param {THREE.Texture|null} cloudShadowTexture
   * @param {THREE.Texture|null} cloudShadowRawTexture
   * @param {THREE.Texture|null} overheadShadowTexture
   * @param {THREE.Texture|null} buildingShadowTexture
   * @param {THREE.Texture|null} paintedShadowTexture
   * @param {THREE.Texture|null} skyReachShadowTexture
   * @param {THREE.Texture|null} treeBillboardShadowTexture
   * @param {THREE.Texture|null} bushBillboardShadowTexture
   */
  bindTextures(
    cloudShadowTexture,
    cloudShadowRawTexture,
    overheadShadowTexture,
    buildingShadowTexture,
    paintedShadowTexture,
    skyReachShadowTexture,
    treeBillboardShadowTexture,
    bushBillboardShadowTexture,
  ) {
    this._cloudShadowTexture = cloudShadowTexture ?? null;
    this._cloudShadowRawTexture = cloudShadowRawTexture ?? null;
    this._overheadShadowTexture = overheadShadowTexture ?? null;
    this._buildingShadowTexture = buildingShadowTexture ?? null;
    this._paintedShadowTexture = paintedShadowTexture ?? null;
    this._skyReachShadowTexture = skyReachShadowTexture ?? null;
    this._treeBillboardShadowTexture = treeBillboardShadowTexture ?? null;
    this._bushBillboardShadowTexture = bushBillboardShadowTexture ?? null;
  }

  setInputs({ cloudShadowTexture = null, cloudShadowRawTexture = null, overheadShadowTexture = null, buildingShadowTexture = null, paintedShadowTexture = null, skyReachShadowTexture = null, treeBillboardShadowTexture = null, bushBillboardShadowTexture = null } = {}) {
    this._inputList = null;
    this._cloudShadowTexture = cloudShadowTexture ?? null;
    this._cloudShadowRawTexture = cloudShadowRawTexture ?? null;
    this._overheadShadowTexture = overheadShadowTexture ?? null;
    this._buildingShadowTexture = buildingShadowTexture ?? null;
    this._paintedShadowTexture = paintedShadowTexture ?? null;
    this._skyReachShadowTexture = skyReachShadowTexture ?? null;
    this._treeBillboardShadowTexture = treeBillboardShadowTexture ?? null;
    this._bushBillboardShadowTexture = bushBillboardShadowTexture ?? null;
  }

  /**
   * Phase-10 compatibility API: accepts the planned N-input shape while the
   * WebGL1 combiner still maps known ids onto the existing fixed sampler layout.
   *
   * @param {{id:string, texture:any, rawTexture?:any, uvSpace?:'screen'|'scene', opacity?:number, preservesDeep?:boolean}[]} inputs
   */
  setInputList(inputs = []) {
    this._inputList = Array.isArray(inputs) ? inputs.slice() : [];
    const byId = new Map();
    for (const input of this._inputList) {
      const id = String(input?.id ?? '').toLowerCase();
      if (id) byId.set(id, input);
    }
    const cloud = byId.get('cloud');
    const overhead = byId.get('overhead');
    const building = byId.get('building');
    const painted = byId.get('painted');
    const skyReach = byId.get('skyreach') ?? byId.get('sky-reach');
    const treeBb = byId.get('tree') ?? byId.get('tree-billboard');
    const bushBb = byId.get('bush') ?? byId.get('bush-billboard');
    this._cloudShadowTexture = cloud?.texture ?? null;
    this._cloudShadowRawTexture = cloud?.rawTexture ?? cloud?.texture ?? null;
    this._overheadShadowTexture = overhead?.texture ?? null;
    this._buildingShadowTexture = building?.texture ?? null;
    this._paintedShadowTexture = painted?.texture ?? null;
    this._skyReachShadowTexture = skyReach?.texture ?? null;
    this._treeBillboardShadowTexture = treeBb?.texture ?? null;
    this._bushBillboardShadowTexture = bushBb?.texture ?? null;
    if (Number.isFinite(Number(cloud?.opacity))) this.params.cloudOpacity = Number(cloud.opacity);
    if (Number.isFinite(Number(overhead?.opacity))) this.params.overheadOpacity = Number(overhead.opacity);
    if (Number.isFinite(Number(building?.opacity))) this.params.buildingOpacity = Number(building.opacity);
    if (Number.isFinite(Number(painted?.opacity))) this.params.paintedOpacity = Number(painted.opacity);
    if (Number.isFinite(Number(skyReach?.opacity))) this.params.skyReachOpacity = Number(skyReach.opacity);
    if (Number.isFinite(Number(treeBb?.opacity))) this.params.treeBillboardOpacity = Number(treeBb.opacity);
    if (Number.isFinite(Number(bushBb?.opacity))) this.params.bushBillboardOpacity = Number(bushBb.opacity);
  }

  /**
   * Set scene rectangle for coordinate conversion (needed for world-space building shadows)
   * @param {THREE.Vector4} sceneRect - (x, y, width, height) in Foundry coordinates
   */
  setSceneRect(sceneRect) {
    if (!this._sceneRectVec || !sceneRect) {
      this._hasSceneRect = false;
      return;
    }
    if (sceneRect.isVector4) {
      this._sceneRectVec.copy(sceneRect);
    } else {
      this._sceneRectVec.set(
        Number(sceneRect.x) || 0,
        Number(sceneRect.y) || 0,
        Number(sceneRect.z ?? sceneRect.width) || 1,
        Number(sceneRect.w ?? sceneRect.height) || 1,
      );
    }
    this._hasSceneRect = true;
  }

  /** @private Read Foundry sceneRect into cached uniforms without per-frame object churn. */
  _syncSceneRectUniforms() {
    const u = this._material?.uniforms;
    if (!u?.uSceneRect) return;
    try {
      const dims = globalThis.canvas?.dimensions;
      if (!dims) {
        u.uHasSceneRect.value = 0.0;
        this._hasSceneRect = false;
        return;
      }
      const rect = dims.sceneRect ?? dims;
      this._sceneRectVec.set(
        rect?.x ?? dims.sceneX ?? 0,
        rect?.y ?? dims.sceneY ?? 0,
        rect?.width ?? dims.sceneWidth ?? dims.width ?? 1,
        rect?.height ?? dims.sceneHeight ?? dims.height ?? 1,
      );
      u.uHasSceneRect.value = 1.0;
      this._hasSceneRect = true;
    } catch (_) {
      u.uHasSceneRect.value = 0.0;
      this._hasSceneRect = false;
    }
  }

  /**
   * Match water-shader.js / LightingEffectV2 building UV: screen vUv → Foundry XY →
   * normalized scene UV into BuildingShadowsEffectV2.shadowFactorTexture.
   * Call after {@link #setSceneRect} each frame before {@link #render}.
   * @param {import('three').Camera|null} camera
   */
  applyBuildingShadowUvRemap(camera) {
    const u = this._material?.uniforms;
    if (!u?.uHasBuildingUvRemap) return;
    if (!camera) {
      u.uHasBuildingUvRemap.value = 0.0;
      return;
    }
    try {
      const dims = globalThis.canvas?.dimensions;
      if (!dims || !this._hasSceneRect) {
        u.uHasBuildingUvRemap.value = 0.0;
        return;
      }
      const totalW = Math.max(1, Number(dims.width) || 1);
      const totalH = Math.max(1, Number(dims.height) || 1);
      u.uSceneDimensions.value.set(totalW, totalH);

      const sc = window.MapShine?.sceneComposer;
      const groundZ = sc?.basePlaneMesh?.position?.z ?? (sc?.groundZ ?? 0);
      const cache = this._viewProjectionCache;
      if (!cache) {
        u.uHasBuildingUvRemap.value = 0.0;
        return;
      }
      const ok = updateSceneViewProjectionFromCamera(
        camera,
        groundZ,
        cache,
        {
          ndc: this._tmpNdcVec,
          world: this._tmpWorldVec,
          dir: this._tmpDirVec,
        },
      );
      if (!ok || !cache.isValid) {
        u.uHasBuildingUvRemap.value = 0.0;
        return;
      }
      applySceneViewProjectionToUniforms(cache, u);
      u.uHasBuildingUvRemap.value = 1.0;
    } catch (_) {
      u.uHasBuildingUvRemap.value = 0.0;
    }
  }

  /** @private Sync uniforms shared by combined + raw combine passes. */
  _syncCombineUniforms() {
    const u = this._material.uniforms;
    u.tCloudShadow.value = this._cloudShadowTexture;
    u.tCloudShadowRaw.value = this._cloudShadowRawTexture;
    u.tOverheadShadow.value = this._overheadShadowTexture;
    u.tBuildingShadow.value = this._buildingShadowTexture;
    u.tPaintedShadow.value = this._paintedShadowTexture;
    u.tSkyReachShadow.value = this._skyReachShadowTexture;
    u.tTreeBillboardShadow.value = this._treeBillboardShadowTexture;
    u.tBushBillboardShadow.value = this._bushBillboardShadowTexture;
    u.tLightningBuilding.value = this._lightningBuildingTexture;
    u.tLightningSkyReach.value = this._lightningSkyReachTexture;
    u.tLightningPainted.value = this._lightningPaintedTexture;
    u.tLightningVegetation.value = this._lightningVegetationTexture;
    u.uHasLightningBuilding.value = this._lightningBuildingTexture ? 1.0 : 0.0;
    u.uHasLightningSkyReach.value = this._lightningSkyReachTexture ? 1.0 : 0.0;
    u.uHasLightningPainted.value = this._lightningPaintedTexture ? 1.0 : 0.0;
    u.uHasLightningVegetation.value = this._lightningVegetationTexture ? 1.0 : 0.0;
    const rawBlend = Math.max(0, Math.min(1,
      (Number(this._landscapeLightningFlash01) || 0) * (Number(this._landscapeLightningShadowWeight) || 0),
    ));
    u.uLandscapeLightningBlend.value = rawBlend;
    u.uLandscapeLightningShadowDarkness.value = Math.max(1, Number(this._landscapeLightningShadowDarkness) || 1);
    u.uHasCloudShadow.value = this._cloudShadowTexture ? 1.0 : 0.0;
    u.uHasCloudShadowRaw.value = this._cloudShadowRawTexture ? 1.0 : 0.0;
    u.uHasOverheadShadow.value = this._overheadShadowTexture ? 1.0 : 0.0;
    u.uHasBuildingShadow.value = this._buildingShadowTexture ? 1.0 : 0.0;
    u.uHasPaintedShadow.value = this._paintedShadowTexture ? 1.0 : 0.0;
    u.uHasSkyReachShadow.value = this._skyReachShadowTexture ? 1.0 : 0.0;
    u.uHasTreeBillboardShadow.value = this._treeBillboardShadowTexture ? 1.0 : 0.0;
    u.uHasBushBillboardShadow.value = this._bushBillboardShadowTexture ? 1.0 : 0.0;
    u.uCloudWeight.value = Math.max(0.0, Math.min(1.0, Number(this.params.cloudWeight) || 0));
    u.uCloudOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.cloudOpacity) || 0));
    u.uOverheadOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.overheadOpacity) || 0));
    u.uBuildingOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.buildingOpacity) || 1.0));
    u.uPaintedOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.paintedOpacity) || 1.0));
    u.uSkyReachOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.skyReachOpacity) || 1.0));
    u.uTreeBillboardOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.treeBillboardOpacity) || 1.0));
    u.uBushBillboardOpacity.value = Math.max(0.0, Math.min(1.0, Number(this.params.bushBillboardOpacity) || 1.0));
  }

  _renderOne(renderer, target, useRawCloud) {
    if (!renderer || !target || !this._material || !this._scene || !this._camera) return;
    this._material.uniforms.uUseRawCloud.value = useRawCloud ? 1.0 : 0.0;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this._scene, this._camera);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera|null} [camera=null] When set, refreshes screen→scene UV uniforms
   *   immediately before combining (keeps painted/sky-reach/building aligned).
   */
  render(renderer, camera = null) {
    if (!this._initialized || !this.enabled || !renderer) return false;
    if (!this._combinedRT || !this._combinedRawRT) {
      renderer.getDrawingBufferSize(this._sizeVec);
      this.onResize(this._sizeVec.x, this._sizeVec.y);
    }
    this._syncSceneRectUniforms();
    try {
      if (camera) this.applyBuildingShadowUvRemap(camera);
    } catch (_) {}
    this._syncCombineUniforms();
    const prevTarget = renderer.getRenderTarget();
    try {
      this._renderOne(renderer, this._combinedRT, false);
      this._renderOne(renderer, this._combinedRawRT, true);
    } finally {
      renderer.setRenderTarget(prevTarget);
    }
    return true;
  }

  get combinedShadowTexture() {
    return this._combinedRT?.texture ?? null;
  }

  get combinedShadowRawTexture() {
    return this._combinedRawRT?.texture ?? this._combinedRT?.texture ?? null;
  }

  dispose() {
    try { this._combinedRT?.dispose?.(); } catch (_) {}
    try { this._combinedRawRT?.dispose?.(); } catch (_) {}
    try { this._material?.dispose?.(); } catch (_) {}
    try { this._quad?.geometry?.dispose?.(); } catch (_) {}
    this._combinedRT = null;
    this._combinedRawRT = null;
    this._material = null;
    this._quad = null;
    this._scene = null;
    this._camera = null;
    this._initialized = false;
    log.info('ShadowManagerV2 disposed');
  }
}
