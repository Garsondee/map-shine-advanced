/**
 * @fileoverview Building Shadows effect
 * Generates directional ground-plane shadows from the _Outdoors mask
 * (white = outdoors, black = indoors/buildings) by smearing indoor
 * regions along a sun-driven direction.
 * @module effects/BuildingShadowsEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('BuildingShadowsEffect');

/**
 * Building Shadows environmental effect.
 *
 * v1 scope:
 * - Uses the _Outdoors luminance mask as a building/ground classifier.
 * - Treats dark (indoor) regions as occluders that cast a shadow onto
 *   nearby outdoor pixels.
 * - The shadow is produced by raymarching backwards along the sun
 *   direction in screen space and checking for indoor pixels.
 */
export class BuildingShadowsEffect extends EffectBase {
  constructor() {
    // Environmental layer: generates a shadow texture consumed by LightingEffect.
    super('building-shadows', RenderLayers.ENVIRONMENTAL, 'low');

    this.priority = 15;
    this.alwaysRender = true;

    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;

    /** @type {THREE.Mesh|null} */
    this.baseMesh = null;

    /** @type {THREE.Scene|null} */
    this.shadowScene = null; // World-pinned shadow mesh scene
    /** @type {THREE.Mesh|null} */
    this.shadowMesh = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.shadowTarget = null;   // Final building shadow factor texture

    /** @type {THREE.Texture|null} */
    this.outdoorsMask = null;   // _Outdoors mask (bright outside, dark indoors)

    /** @type {THREE.Vector2|null} */
    this.sunDir = null; // Screen-space sun direction, driven by TimeManager

    this.params = {
      enabled: true,
      opacity: 0.7,        // How strong the building shadow darkening is
      length: 0.05,        // Shadow length in UV space (0-0.25 reasonable)
      quality: 24,         // Sample count along the ray (integer >= 4)
      sunLatitude: 0.5,    // 0=flat east/west, 1=maximum north/south arc
      // High-level blur control (0 = hard edge, 1 = very soft)
      blurStrength: 0.5,
      // Internal penumbra parameters derived from blurStrength in update()
      penumbraRadiusNear: 0.0,
      penumbraRadiusFar: 0.06,
      penumbraSamples: 3,
      penumbraExponent: 1.0
    };
  }

  /**
   * Receive base mesh and asset bundle so we can access the _Outdoors mask
   * and build a world-pinned projection mesh.
   * @param {THREE.Mesh} baseMesh
   * @param {MapAssetBundle} assetBundle
   */
  setBaseMesh(baseMesh, assetBundle) {
    const THREE = window.THREE;
    if (!assetBundle || !assetBundle.masks || !THREE) return;

    this.baseMesh = baseMesh;

    const outdoorsData = assetBundle.masks.find(m => m.id === 'outdoors' || m.type === 'outdoors');
    this.outdoorsMask = outdoorsData?.texture || null;

    if (!this.outdoorsMask) {
      log.info('No _Outdoors mask found for BuildingShadowsEffect');
      return;
    }

    // If initialize() has already run, we can build the world-pinned shadow mesh now.
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
          label: 'Building Shadows',
          type: 'inline',
          parameters: ['opacity', 'length', 'quality', 'sunLatitude', 'blurStrength']
        }
      ],
      parameters: {
        opacity: {
          type: 'slider',
          label: 'Shadow Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.7
        },
        length: {
          type: 'slider',
          label: 'Shadow Length',
          min: 0.0,
          max: 0.25,
          step: 0.005,
          default: 0.05
        },
        quality: {
          type: 'slider',
          label: 'Quality (Samples)',
          min: 4,
          max: 48,
          step: 1,
          default: 24
        },
        sunLatitude: {
          type: 'slider',
          label: 'Sun Latitude',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5
        },
        blurStrength: {
          type: 'slider',
          label: 'Blur Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5
        }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    this.renderer = renderer;
    this.mainScene = scene;
    this.mainCamera = camera;

    // Create a dedicated scene to render the world-pinned shadow mesh.
    this.shadowScene = new THREE.Scene();

    // If setBaseMesh has already run and we have an outdoors mask, build the mesh now.
    if (this.baseMesh && this.outdoorsMask) {
      this._createShadowMesh();
    }

    log.info('BuildingShadowsEffect initialized');
  }

  _createShadowMesh() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh || !this.outdoorsMask) return;

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
        tOutdoors: { value: this.outdoorsMask },
        uOpacity: { value: this.params.opacity },
        uLength: { value: this.params.length },
        uSampleCount: { value: this.params.quality },
        uSunDir: { value: new THREE.Vector2(0.0, 1.0) },
        uPenumbraRadiusNear: { value: this.params.penumbraRadiusNear },
        uPenumbraRadiusFar: { value: this.params.penumbraRadiusFar },
        uPenumbraSamples: { value: this.params.penumbraSamples },
        uPenumbraExponent: { value: this.params.penumbraExponent }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tOutdoors;
        uniform float uOpacity;
        uniform float uLength;
        uniform float uSampleCount;
        uniform vec2 uSunDir;
        uniform float uPenumbraRadiusNear;
        uniform float uPenumbraRadiusFar;
        uniform float uPenumbraSamples;
        uniform float uPenumbraExponent;

        varying vec2 vUv;

        bool inBounds(vec2 uv) {
          return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
        }

        void main() {
          // Normalize sun direction in UV space.
          vec2 dir = normalize(uSunDir);
          float samples = max(uSampleCount, 1.0);

          // Start fully lit
          float shadowFactor = 1.0;

          // Direction perpendicular to the shadow, used for penumbra
          // sampling. This lets the cone widen as we move away from the
          // building, producing softer edges further from the caster.
          vec2 perp = normalize(vec2(-dir.y, dir.x));
          float penumbraCount = max(uPenumbraSamples, 1.0);

          // Accumulate occlusion along the ray with distance-based weighting
          float totalOcclusion = 0.0;
          float totalWeight = 0.0;

          const int MAX_STEPS = 64;
          for (int i = 0; i < MAX_STEPS; i++) {
            float fi = float(i);
            if (fi >= samples) break;

            float t = (samples > 1.0) ? (fi / (samples - 1.0)) : 0.0;
            vec2 baseUv = vUv + dir * (t * uLength);

            if (!inBounds(baseUv)) {
              continue;
            }

            float rLerp = pow(t, uPenumbraExponent);
            float radius = mix(uPenumbraRadiusNear, uPenumbraRadiusFar, rLerp);

            float occlusion = 0.0;
            float weightSum = 0.0;

            int maxPenumbra = 16;
            int taps = int(clamp(penumbraCount, 1.0, float(maxPenumbra)));

            if (taps <= 1 || radius <= 1e-5) {
              vec3 sampleColor = texture2D(tOutdoors, baseUv).rgb;
              float outdoors = dot(sampleColor, vec3(0.2126, 0.7152, 0.0722));
              occlusion = (outdoors < 0.5) ? 1.0 : 0.0;
              weightSum = 1.0;
            } else {
              for (int j = 0; j < maxPenumbra; j++) {
                if (j >= taps) break;

                float fj = float(j);
                float halfCount = (float(taps) - 1.0) * 0.5;
                float offsetIndex = fj - halfCount;

                float norm = (halfCount > 0.0) ? (offsetIndex / halfCount) : 0.0;
                float w = 1.0 - abs(norm);

                vec2 sampleUv = baseUv + perp * (norm * radius);

                float outdoors = 1.0;
                if (inBounds(sampleUv)) {
                  vec3 sampleColor = texture2D(tOutdoors, sampleUv).rgb;
                  outdoors = dot(sampleColor, vec3(0.2126, 0.7152, 0.0722));
                }

                float indoor = (outdoors < 0.5) ? 1.0 : 0.0;
                occlusion += indoor * w;
                weightSum += w;
              }
            }

            if (weightSum > 0.0) {
              occlusion /= weightSum;
            }

            float distanceWeight = pow(t, max(0.001, uPenumbraExponent));
            float contrib = occlusion * distanceWeight;
            totalOcclusion += contrib;
            totalWeight += distanceWeight;
          }

          float avgOcclusion = 0.0;
          if (totalWeight > 0.0) {
            avgOcclusion = clamp(totalOcclusion / totalWeight, 0.0, 1.0);
          }

          shadowFactor = 1.0 - avgOcclusion;

          float strength = clamp((1.0 - shadowFactor) * uOpacity, 0.0, 1.0);
          float finalFactor = 1.0 - strength;

          gl_FragColor = vec4(finalFactor, finalFactor, finalFactor, 1.0);
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

  setInputTexture(texture) {
    // No-op; this effect uses the outdoors mask rather than the scene color.
    this.inputTexture = texture;
  }

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

    const t = (hour % 24.0) / 24.0;
    // Use a half-orbit (-PI/2 .. +PI/2) so the sun moves smoothly from
    // east to west over the course of the day without wrapping a full
    // 360 degrees, which caused the shadow direction to "pop" when
    // sunLatitude is low.
    const azimuth = (t - 0.5) * Math.PI;

    const x = -Math.sin(azimuth);

    const lat = Math.max(0.0, Math.min(1.0, this.params.sunLatitude ?? 0.5));
    const y = -Math.cos(azimuth) * lat;

    if (!this.sunDir) {
      this.sunDir = new THREE.Vector2(x, y);
    } else {
      this.sunDir.set(x, y);
    }

    if (this.material.uniforms.uSunDir) {
      this.material.uniforms.uSunDir.value.copy(this.sunDir);
    }

    // Drive basic shadow controls
    if (this.material.uniforms.uOpacity) {
      this.material.uniforms.uOpacity.value = this.params.opacity;
    }
    if (this.material.uniforms.uLength) {
      this.material.uniforms.uLength.value = this.params.length;
    }
    if (this.material.uniforms.uSampleCount) {
      this.material.uniforms.uSampleCount.value = this.params.quality;
    }

    // Derive penumbra parameters from a single blurStrength control so
    // the UI stays simple but still drives a meaningful blur range.
    const blur = Math.max(0.0, Math.min(1.0, this.params.blurStrength ?? 0.5));

    // Near radius stays small so the shadow begins relatively crisp
    // at the building edge.
    this.params.penumbraRadiusNear = 0.0;
    // Far radius scales up with blur strength.
    this.params.penumbraRadiusFar = 0.02 + blur * 0.18; // 0.02 .. 0.20

    // Sample count: 1 (no blur) up to 9 (very soft) in odd steps.
    const minTaps = 1;
    const maxTaps = 9;
    const taps = Math.round(minTaps + blur * (maxTaps - minTaps));
    this.params.penumbraSamples = Math.max(1, Math.min(9, taps));

    // Blur growth curve: lower values bias blur towards the base,
    // higher values bias blur towards the tail.
    this.params.penumbraExponent = 0.5 + blur * 2.0; // 0.5 .. 2.5

    if (this.material.uniforms.uPenumbraRadiusNear) {
      this.material.uniforms.uPenumbraRadiusNear.value = this.params.penumbraRadiusNear;
    }
    if (this.material.uniforms.uPenumbraRadiusFar) {
      this.material.uniforms.uPenumbraRadiusFar.value = this.params.penumbraRadiusFar;
    }
    if (this.material.uniforms.uPenumbraSamples) {
      this.material.uniforms.uPenumbraSamples.value = this.params.penumbraSamples;
    }
    if (this.material.uniforms.uPenumbraExponent) {
      this.material.uniforms.uPenumbraExponent.value = this.params.penumbraExponent;
    }
  }

  render(renderer, scene, camera) {
    if (!this.enabled || !this.material) return;

    const THREE = window.THREE;
    if (!THREE || !this.mainCamera || !this.shadowScene) return;

    // Ensure render target exists and is correctly sized
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    if (!this.shadowTarget) {
      this.onResize(size.x, size.y);
    } else if (this.shadowTarget.width !== size.x || this.shadowTarget.height !== size.y) {
      this.shadowTarget.setSize(size.x, size.y);
    }

    const previousTarget = renderer.getRenderTarget();

    // Render world-pinned shadow mesh into shadowTarget. Clear to white so
    // regions outside the base mesh remain fully lit (factor = 1.0).
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this.shadowScene, this.mainCamera);

    renderer.setRenderTarget(previousTarget);
  }

  dispose() {
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
    log.info('BuildingShadowsEffect disposed');
  }
}
