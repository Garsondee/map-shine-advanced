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
      opacity: 0.6,        // How strong the shadow darkening is
      length: 0.04,        // Shadow length in UV space (0-0.25 reasonable)
      softness: 1.5,       // Multiplier for blur kernel size
      verticalOnly: true,  // v1: primarily vertical motion in screen space
      affectsLights: 0.75, // 0=ambient only, 1=ambient + full dynamic light
      sunLatitude: 0.5     // 0=flat east/west, 1=maximum north/south arc
    };
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
          parameters: ['opacity', 'length', 'softness', 'sunLatitude', 'affectsLights']
        }
      ],
      parameters: {
        opacity: {
          type: 'slider',
          label: 'Shadow Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.6
        },
        length: {
          type: 'slider',
          label: 'Shadow Length',
          min: 0.0,
          max: 0.25,
          step: 0.005,
          default: 0.04
        },
        softness: {
          type: 'slider',
          label: 'Softness',
          min: 0.5,
          max: 9.0,
          step: 0.1,
          default: 1.5
        },
        sunLatitude: {
          type: 'slider',
          label: 'Sun Latitude',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5
        },
        affectsLights: {
          type: 'slider',
          label: 'Affects Dynamic Lights',
          min: 0.0,
          max: 1.0,
          step: 0.05,
          default: 0.75
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
        uZoom: { value: 1.0 }
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

        varying vec2 vUv;

        void main() {
          // Screen-space UV for this fragment, matching the roofTarget
          // render that was produced with the same camera.
          vec2 screenUv = gl_FragCoord.xy / uResolution;

          // Sun direction in screen space, driven by TimeManager. We
          // assume uSunDir is already normalized.
          vec2 dir = normalize(uSunDir);

          // Scale length by zoom so the world-space band stays
          // approximately constant as the camera zoom changes.
          float len = uLength * max(uZoom, 0.0001);

          // Base roof coverage (directly overhead)
          float roofBase = texture2D(tRoof, screenUv).a;

          // Sample along the shadow direction at a small distance to
          // represent where the shadow lands on the ground outside.
          vec2 offsetUv = screenUv + dir * len;
          float roofOffset = texture2D(tRoof, offsetUv).a;

          // Simple 3x3 blur around the offset position to soften edges.
          float blurScale = 1.0 * uSoftness;
          vec2 stepUv = uTexelSize * blurScale;

          float accum = 0.0;
          float weightSum = 0.0;
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              vec2 sUv = offsetUv + vec2(float(dx), float(dy)) * stepUv;
              float w = 1.0;
              if (dx == 0 && dy == 0) w = 2.0; // center bias
              float v = texture2D(tRoof, sUv).a;
              accum += v * w;
              weightSum += w;
            }
          }

          float blurred = (weightSum > 0.0) ? accum / weightSum : roofOffset;

          // Shadow band from blurred roofOffset. We intentionally do NOT
          // subtract roofBase so the band stays solid across the roof
          // footprint. Roof masking and outdoors gating are handled in
          // LightingEffect during final composition.
          float shadowMask = blurred;

          float strength = clamp(shadowMask * uOpacity, 0.0, 1.0);

          // Encode shadow factor in the red channel (1.0 = fully lit,
          // 0.0 = fully shadowed).
          float shadowFactor = 1.0 - strength;
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

    // Map hour to a sun azimuth over a half-orbit.
    // 12h (noon) -> 0 azimuth
    //  6h (sunrise) -> -PI/2
    // 18h (sunset)  -> +PI/2
    const t = (hour % 24.0) / 24.0;
    const azimuth = (t - 0.5) * Math.PI;

    // Horizontal offset (X) driven by -sin(azimuth):
    //  Noon (0)       ->  0  (no horizontal offset)
    //  Sunrise(-PI/2) -> +1  (shadow to the west, sun in the east)
    //  Sunset( PI/2)  -> -1  (shadow to the east, sun in the west)
    const x = -Math.sin(azimuth);

    // Vertical offset (Y) driven by cos(azimuth) scaled by sunLatitude
    // (eccentricity). When sunLatitude = 0, Y is always 0 so the band
    // slides purely east/west. Increasing sunLatitude introduces an
    // orbital north/south component. We flip the sign here so the
    // north/south motion matches BuildingShadowsEffect visually.
    const lat = Math.max(0.0, Math.min(1.0, this.params.sunLatitude ?? 0.5));
    const y = Math.cos(azimuth) * lat;

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
        const z = typeof this.mainCamera.zoom === 'number' ? this.mainCamera.zoom : 1.0;
        u.uZoom.value = z;
      }
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
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    if (!this.roofTarget || !this.shadowTarget) {
      this.onResize(size.x, size.y);
    } else if (this.roofTarget.width !== size.x || this.roofTarget.height !== size.y) {
      this.roofTarget.setSize(size.x, size.y);
      this.shadowTarget.setSize(size.x, size.y);
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
