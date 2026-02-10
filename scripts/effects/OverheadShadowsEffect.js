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
      indoorShadowEnabled: false, // Treat indoor areas (_Outdoors dark) as additional shadow
      indoorShadowOpacity: 0.5,   // Opacity of the indoor area shadow contribution
      indoorShadowMaskId: 'none', // Which mask to use for indoor shadow (resolved from MaskManager)
      indoorShadowLengthScale: 1.0,
      indoorShadowSoftnessScale: 1.0
    };
    
    // PERFORMANCE: Reusable objects to avoid per-frame allocations
    this._tempSize = null; // Lazy init when THREE is available
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
          parameters: ['opacity', 'length', 'softness', 'affectsLights']
        },
        {
          name: 'indoorShadow',
          label: 'Indoor Shadow',
          type: 'inline',
          parameters: ['indoorShadowEnabled', 'indoorShadowMaskId', 'indoorShadowOpacity', 'indoorShadowLengthScale', 'indoorShadowSoftnessScale']
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
        indoorShadowEnabled: {
          type: 'checkbox',
          label: 'Enable Indoor Shadow',
          default: false,
          tooltip: 'Add shadow to indoor areas using the _Outdoors mask'
        },
        indoorShadowMaskId: {
          type: 'list',
          label: 'Mask Source',
          options: {
            'None': 'none',
            '_Outdoors': 'outdoors',
            '_Structural': 'structural',
            '_Windows': 'windows',
            '_Fire': 'fire',
            '_Water': 'water',
            '_Specular': 'specular',
            '_Iridescence': 'iridescence',
            '_Bush': 'bush',
            '_Tree': 'tree',
            '_Dust': 'dust',
            '_Ash': 'ash',
            '_Prism': 'prism'
          },
          default: 'none',
          tooltip: 'Select which discovered mask to use for indoor shadow areas'
        },
        indoorShadowOpacity: {
          type: 'slider',
          label: 'Indoor Shadow Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5,
          tooltip: 'Strength of the shadow applied to indoor (covered) areas'
        },
        indoorShadowLengthScale: {
          type: 'slider',
          label: 'Indoor Length Scale',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Scale factor for indoor shadow projection distance'
        },
        indoorShadowSoftnessScale: {
          type: 'slider',
          label: 'Indoor Softness Scale',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Scale factor for indoor shadow blur radius'
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
        uSunDir: { value: new THREE.Vector2(0.0, 1.0) },
        uResolution: { value: new THREE.Vector2(1024, 1024) },
        uZoom: { value: 1.0 },
        // Indoor shadow from _Outdoors mask
        uOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uIndoorShadowEnabled: { value: 0.0 },
        uIndoorShadowOpacity: { value: 0.5 },
        uIndoorShadowLengthScale: { value: 1.0 },
        uIndoorShadowSoftnessScale: { value: 1.0 },
        // Scene dimensions in world pixels for world-space mask UV conversion
        uSceneDimensions: { value: new THREE.Vector2(1, 1) }
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
        uniform vec2 uSunDir;
        uniform vec2 uResolution;
        uniform float uZoom;

        // Indoor shadow from _Outdoors mask
        uniform sampler2D uOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uIndoorShadowEnabled;
        uniform float uIndoorShadowOpacity;
        uniform float uIndoorShadowLengthScale;
        uniform float uIndoorShadowSoftnessScale;
        // Scene dimensions in world pixels for mask UV conversion
        uniform vec2 uSceneDimensions;

        varying vec2 vUv;

        void main() {
          // Screen-space UV for this fragment, matching the roofTarget
          // render that was produced with the same camera.
          vec2 screenUv = gl_FragCoord.xy / uResolution;

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
          vec2 offsetUv = screenUv + screenDir * pixelLen * uTexelSize;

          // Simple 3x3 blur around the offset position to soften edges.
          float blurScale = 1.0 * uSoftness;
          vec2 stepUv = uTexelSize * blurScale;

          // Prepare indoor shadow sampling in world UV (mask space). We will
          // merge roof+indoor into a single pre-blur kernel by taking the per-tap
          // max() and then blurring once.
          bool indoorEnabled = (uIndoorShadowEnabled > 0.5 && uHasOutdoorsMask > 0.5);
          vec2 maskTexelSize = vec2(1.0) / max(uSceneDimensions, vec2(1.0));
          float maskPixelLen = uLength * 1080.0 * uIndoorShadowLengthScale;
          vec2 maskOffsetUv = vUv + dir * maskPixelLen * maskTexelSize;
          vec2 maskStepUv = maskTexelSize * uSoftness * 4.0 * max(uIndoorShadowSoftnessScale, 0.0);

          float accum = 0.0;
          float weightSum = 0.0;
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              vec2 sUv = offsetUv + vec2(float(dx), float(dy)) * stepUv;
              float w = 1.0;
              if (dx == 0 && dy == 0) w = 2.0; // center bias

              // Roof tap (screen-space)
              float roofTap = texture2D(tRoof, sUv).a;
              float roofStrengthTap = clamp(roofTap * uOpacity, 0.0, 1.0);

              // Indoor tap (world-space mask)
              float indoorStrengthTap = 0.0;
              if (indoorEnabled) {
                vec2 mUv = maskOffsetUv + vec2(float(dx), float(dy)) * maskStepUv;
                float mv = 1.0 - texture2D(uOutdoorsMask, mUv).r;
                indoorStrengthTap = clamp(mv * uIndoorShadowOpacity, 0.0, 1.0);
              }

              // Combine BEFORE blur.
              float combinedTap = max(roofStrengthTap, indoorStrengthTap);
              accum += combinedTap * w;
              weightSum += w;
            }
          }

          float combinedStrength = (weightSum > 0.0) ? (accum / weightSum) : 0.0;

          // Encode shadow factor in the red channel (1.0 = fully lit,
          // 0.0 = fully shadowed).
          float shadowFactor = 1.0 - combinedStrength;
          gl_FragColor = vec4(shadowFactor, shadowFactor, shadowFactor, 1.0);
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
    const updateHash = `${hour.toFixed(3)}_${this.params.sunLatitude}_${this.params.opacity}_${this.params.length}_${this.params.softness}_${camZoom.toFixed(4)}_${this.params.indoorShadowEnabled}_${this.params.indoorShadowMaskId}_${this.params.indoorShadowOpacity}_${this.params.indoorShadowLengthScale}_${this.params.indoorShadowSoftnessScale}`;
    
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
      if (u.uIndoorShadowSoftnessScale) u.uIndoorShadowSoftnessScale.value = this.params.indoorShadowSoftnessScale;

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

      // Resolve the active indoor shadow mask texture from MaskManager.
      // Falls back to the auto-discovered outdoorsMask from setBaseMesh()
      // if no explicit selection is made.
      let activeMask = null;
      const maskId = this.params.indoorShadowMaskId;
      if (maskId && maskId !== 'none') {
        const mm = window.MapShine?.maskManager;
        if (mm) {
          activeMask = mm.getTexture(maskId) || null;
        }
        // Fallback: if the selected ID matches what setBaseMesh found, use it
        if (!activeMask && maskId === 'outdoors') {
          activeMask = this.outdoorsMask;
        }
      }
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

    if (!this.roofTarget || !this.shadowTarget) {
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

    const overrides = [];
    const roofMaskBit = 1 << ROOF_LAYER;
    this.mainScene.traverse((object) => {
      if (!object.isSprite || !object.layers || !object.material) return;

      // Directly test the ROOF_LAYER bit to avoid Layers.test() argument issues.
      if ((object.layers.mask & roofMaskBit) === 0) return;

      const mat = object.material;
      if (typeof mat.opacity !== 'number') return;
      overrides.push({ object, opacity: mat.opacity });
      // IMPORTANT: Hover-hide is a UX-only fade on roof sprites. We intentionally
      // keep overhead shadows active while hovering, so the shadow mask render
      // pass always treats roof sprites as fully opaque.
      mat.opacity = 1.0;
    });

    // Pass 1: render overhead tiles into roofTarget (alpha mask)
    this.mainCamera.layers.set(ROOF_LAYER);
    renderer.setRenderTarget(this.roofTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.mainScene, this.mainCamera);

    // IMPORTANT: restore camera layers before rendering the world-pinned
    // shadow mesh so the base plane is visible to the camera again.
    this.mainCamera.layers.mask = previousLayersMask;

    // Pass 2: build shadow texture from roofTarget using a world-pinned
    // groundplane mesh that samples the roof mask in screen space.
    if (this.material && this.material.uniforms) {
      this.material.uniforms.tRoof.value = this.roofTarget.texture;
      if (this.material.uniforms.uResolution) {
        this.material.uniforms.uResolution.value.set(size.x, size.y);
      }
    }

    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this.shadowScene, this.mainCamera);

    // Restore per-sprite opacity and previous render target
    for (const entry of overrides) {
      if (entry.object && entry.object.material) {
        entry.object.material.opacity = entry.opacity;
      }
    }
    renderer.setRenderTarget(previousTarget);
  }

  dispose() {
    if (this.roofTarget) {
      this.roofTarget.dispose();
      this.roofTarget = null;
    }
    if (this.shadowTarget) {
      this.shadowTarget.dispose();
      this.shadowTarget = null;
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
