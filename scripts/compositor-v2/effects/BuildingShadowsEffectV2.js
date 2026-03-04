/**
 * @fileoverview Building Shadows Effect V2 (adapted from V1)
 * Generates directional ground-plane shadows from the _Outdoors mask
 * (white = outdoors, black = indoors/buildings) by smearing indoor
 * regions along a sun-driven direction.
 * @module compositor-v2/effects/BuildingShadowsEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { getFoundryTimePhaseHours } from '../../core/foundry-time-phases.js';

const log = createLogger('BuildingShadowsEffect');

/**
 * Building Shadows Effect V2 (adapted from V1).
 *
 * - Uses the _Outdoors luminance mask as a building/ground classifier.
 * - Treats dark (indoor) regions as occluders that cast a shadow onto
 *   nearby outdoor pixels.
 * - The shadow is produced by raymarching backwards along the sun
 *   direction in screen space and checking for indoor pixels.
 * 
 * Performance Optimization:
 * - Implements "World Space Caching".
 * - The expensive raymarching shader is rendered only when conditions change (time, params)
 *   into a persistent World Space texture (worldShadowTarget).
 * - The per-frame render pass simply samples this cached texture onto the screen-aligned mesh.
 * - This reduces per-frame cost from 64 texture fetches/math ops to 1 texture fetch.
 */
export class BuildingShadowsEffectV2 {
  constructor() {
    /**
     * Per-floor cached state. Keyed by FloorBand.key. Populated lazily by
     * bindFloorMasks(). Holds per-floor bakeTarget render targets and
     * the outdoors mask texture used to drive shadow generation.
     * @type {Map<string, object>}
     */
    this._floorStates = new Map();

    /** @type {THREE.ShaderMaterial|null} */
    this.bakeMaterial = null; // The expensive raymarcher

    /** @type {THREE.MeshBasicMaterial|null} */
    this.displayMaterial = null; // The cheap sampler

    /** @type {THREE.Mesh|null} */
    this.baseMesh = null;

    /** @type {THREE.Scene|null} */
    this.shadowScene = null; // World-pinned shadow mesh scene
    /** @type {THREE.Mesh|null} */
    this.shadowMesh = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.shadowTarget = null;   // Final building shadow factor texture (Screen Space)

    /** @type {THREE.WebGLRenderTarget|null} */
    this.worldShadowTarget = null; // Cached baked shadow map (World Space)

    /** @type {THREE.Scene|null} */
    this.bakeScene = null;
    /** @type {THREE.Camera|null} */
    this.bakeCamera = null;
    /** @type {THREE.Mesh|null} */
    this.bakeQuad = null;

    /** @type {THREE.Texture|null} */
    this.outdoorsMask = null;   // _Outdoors mask (bright outside, dark indoors)

    /** @type {THREE.Vector2|null} */
    this.sunDir = null; // Screen-space sun direction, driven by TimeManager

    this.params = {
      enabled: true,
      opacity: 0.75,
      length: 0.06,
      quality: 80,
      sunLatitude: 0.03,
      blurStrength: 0.3,
      // High-level blur control (0 = hard edge, 1 = very soft)
      penumbraRadiusNear: 0.0,
      penumbraRadiusFar: 0.06,
      penumbraSamples: 3,
      penumbraExponent: 1.0,
      sunriseTime: 8.0,
      sunsetTime: 18.0
    };

    this.needsBake = true;
    this.lastBakeHash = '';

    /** @type {function|null} Unsubscribe from EffectMaskRegistry */
    this._registryUnsub = null;

    /** @type {import('./OutdoorsMaskProviderV2.js').OutdoorsMaskProviderV2|null} */
    this._outdoorsMaskProvider = null;

    /** @type {THREE.WebGLRenderer|null} */
    this.renderer = null;
    /** @type {THREE.Scene|null} */
    this.mainScene = null;
    /** @type {THREE.Camera|null} */
    this.mainCamera = null;

    // One-shot diagnostics to pinpoint invisibility regressions.
    this._dbgLoggedOnce = false;
    this._dbgBakedOnce = false;

    // Bump this to force a rebake when shader sampling conventions change.
    this._bakeVersion = 4;
  }


  /**
   * Set OutdoorsMaskProviderV2 for V2 integration
   * @param {import('./OutdoorsMaskProviderV2.js').OutdoorsMaskProviderV2} provider
   */
  setOutdoorsMaskProvider(provider) {
    this._outdoorsMaskProvider = provider;
    // Subscribe to provider changes
    provider.subscribe(() => {
      // Update outdoors mask when provider updates
      this.outdoorsMask = provider.texture;
      if (this.outdoorsMask && this.renderer && this.mainScene && this.mainCamera) {
        this._createShadowMesh();
        this.needsBake = true;
      }
    });
  }

  /**
   * Set base mesh for world-pinned projection (V2 integration)
   * @param {THREE.Mesh} baseMesh
   */
  setBaseMesh(baseMesh) {
    this.baseMesh = baseMesh;
    
    // Get _Outdoors mask from provider if available
    if (this._outdoorsMaskProvider) {
      this.outdoorsMask = this._outdoorsMaskProvider.texture;
    }

    // If initialize() has already run and we have a mask, build the shadow mesh
    if (this.outdoorsMask && this.renderer) {
      this._createShadowMesh();
      this.needsBake = true;
    }
  }

  /**
   * Get shadow factor texture for LightingEffectV2 integration
   * @returns {THREE.Texture|null}
   */
  get shadowFactorTexture() {
    // LightingEffectV2 samples building shadows in scene-UV space (world-stable)
    // using uBldSceneOrigin/uBldSceneSize reconstruction. Therefore we must
    // provide the UV-space baked texture, NOT the screen-space projection.
    return this.worldShadowTarget?.texture || null;
  }

  /**
   * Subscribe to the EffectMaskRegistry for 'outdoors' mask updates.
   * @param {import('../assets/EffectMaskRegistry.js').EffectMaskRegistry} registry
   */
  connectToRegistry(registry) {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    this._registryUnsub = registry.subscribe('outdoors', (texture) => {
      this.outdoorsMask = texture;
      if (!texture) return;
      if (this.renderer && this.mainScene && this.mainCamera) {
        this._createShadowMesh();
        this.needsBake = true;
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
          label: 'Building Shadows',
          type: 'inline',
          parameters: ['opacity', 'length', 'quality', 'blurStrength', 'sunriseTime', 'sunsetTime']
        }
      ],
      parameters: {
        opacity: {
          type: 'slider',
          label: 'Shadow Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.75
        },
        length: {
          type: 'slider',
          label: 'Shadow Length',
          min: 0.0,
          max: 0.3,
          step: 0.005,
          default: 0.06
        },
        quality: {
          type: 'slider',
          label: 'Quality (Samples)',
          min: 8,
          max: 128,
          step: 1,
          default: 80
        },
        blurStrength: {
          type: 'slider',
          label: 'Blur Strength',
          min: 0.0,
          max: 2.0,
          step: 0.05,
          default: 0.3
        },
        sunriseTime: {
          type: 'slider',
          label: 'Sunrise Time',
          min: 0.0,
          max: 24.0,
          step: 0.1,
          default: 8.0
        },
        sunsetTime: {
          type: 'slider',
          label: 'Sunset Time',
          min: 0.0,
          max: 24.0,
          step: 0.1,
          default: 18.0
        }
      }
    };
  }

  initialize(renderer, scene = null, camera = null) {
    const THREE = window.THREE;
    this.renderer = renderer;
    this.mainScene = scene;
    this.mainCamera = camera;

    // 1. Create Bake Environment (World Space Cache)
    // Renders a full-UV quad (0..1) to generate the shadow map
    this.bakeScene = new THREE.Scene();
    // Orthographic camera covering 0..1 in X and Y
    // IMPORTANT: Match V1's proven bake mapping:
    // Use Y-up (bottom=0, top=1). The base plane uses scale.y=-1 to map
    // Foundry Y-down into Three Y-up; the bake quad applies the same flip.
    this.bakeCamera = new THREE.OrthographicCamera(0, 1, 0, 1, 0, 1);
    
    // Raymarching Material (Expensive)
    this.bakeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tOutdoors: { value: null },
        uLength: { value: 0.05 },
        uSampleCount: { value: 24 },
        uSunDir: { value: new THREE.Vector2(0, 1) },
        uPenumbraRadiusNear: { value: 0 },
        uPenumbraRadiusFar: { value: 0.06 },
        uPenumbraSamples: { value: 3 },
        uPenumbraExponent: { value: 1 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          // Match V1: author vUv directly from geometry UVs.
          // The bake quad is flipped (scale.y=-1) so the rendered result matches
          // the base plane's Y flip exactly.
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tOutdoors;
        uniform float uLength;
        uniform float uSampleCount;
        uniform vec2 uSunDir;
        uniform float uPenumbraRadiusNear;
        uniform float uPenumbraRadiusFar;
        uniform float uPenumbraSamples;
        uniform float uPenumbraExponent;

        varying vec2 vUv;

        float outdoorsValue(vec2 uv) {
          vec4 c = texture2D(tOutdoors, uv);
          float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
          // Some authored masks encode the signal in alpha (or have premult quirks).
          // Using max() keeps the common RGB-luma path intact while allowing
          // alpha-only masks to function.
          return max(luma, c.a);
        }

        bool inBounds(vec2 uv) {
          // Use a small inset to avoid edge-smear from linear filtering on ClampToEdge.
          const float eps = 0.0005;
          return uv.x >= eps && uv.x <= 1.0 - eps && uv.y >= eps && uv.y <= 1.0 - eps;
        }

        void main() {
          // Normalize sun direction in UV space.
          // We sample the outdoors mask in Foundry-space UVs (Y-down) via uvMask.
          // Flip Y so the march direction matches the mask's coordinate system.
          vec2 dir = normalize(vec2(uSunDir.x, -uSunDir.y));
          float samples = max(uSampleCount, 1.0);

          // OutdoorsMaskProviderV2 composites into a Foundry-space canvas (Y-down, flipY=false).
          // The bake quad is geometry-flipped (scale.y=-1) to match the base plane.
          // That flip also mirrors the interpolated vUv relative to the 2D canvas.
          // So we flip V when sampling the canvas-authored mask.
          vec2 uvMask = vec2(vUv.x, 1.0 - vUv.y);

          // Mask rule: interiors (indoors/buildings) should never be darkened by
          // building shadows. Only outdoor pixels receive shadows cast from nearby
          // indoor occluders.
          float selfOutdoors = outdoorsValue(uvMask);
          if (selfOutdoors < 0.5) {
            gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
            return;
          }

          // Direction perpendicular to the shadow, used for penumbra
          vec2 perp = normalize(vec2(-dir.y, dir.x));
          float penumbraCount = max(uPenumbraSamples, 1.0);

          // Accumulate occlusion along the ray
          float totalOcclusion = 0.0;
          float totalWeight = 0.0;

          const int MAX_STEPS = 64;
          for (int i = 0; i < MAX_STEPS; i++) {
            float fi = float(i);
            // Avoid early-break loops with gradient instructions (texture sampling)
            // to keep derivatives well-defined across fragments.
            if (fi >= samples) continue;

            float t = (samples > 1.0) ? (fi / (samples - 1.0)) : 0.0;
            // March against the sun direction to look "up-sun" for occluders.
            vec2 baseUv = uvMask - dir * (t * uLength);

            if (!inBounds(baseUv)) continue;

            float rLerp = pow(t, uPenumbraExponent);
            float radius = mix(uPenumbraRadiusNear, uPenumbraRadiusFar, rLerp);

            float occlusion = 0.0;
            float weightSum = 0.0;

            int maxPenumbra = 16;
            int taps = int(clamp(penumbraCount, 1.0, float(maxPenumbra)));

            // If radius is tiny or taps is 1, single sample
            if (taps <= 1 || radius <= 1e-5) {
              float outdoors = outdoorsValue(baseUv);
              occlusion = (outdoors < 0.5) ? 1.0 : 0.0; // Indoor = Occluder
              weightSum = 1.0;
            } else {
              // Penumbra blur
              for (int j = 0; j < maxPenumbra; j++) {
                // Avoid early-break for the same reason as the outer loop.
                if (j >= taps) continue;

                float fj = float(j);
                float halfCount = (float(taps) - 1.0) * 0.5;
                float offsetIndex = fj - halfCount;

                float norm = (halfCount > 0.0) ? (offsetIndex / halfCount) : 0.0;
                float w = 1.0 - abs(norm);

                vec2 sampleUv = baseUv + perp * (norm * radius);

                float outdoors = 1.0;
                if (inBounds(sampleUv)) {
                  outdoors = outdoorsValue(sampleUv);
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

          // Output raw light factor (1.0 = Fully Lit, 0.0 = Fully Shadowed)
          // We do NOT apply opacity here. Opacity is handled by LightingEffect composition.
          float shadowFactor = 1.0 - avgOcclusion;

          gl_FragColor = vec4(shadowFactor, shadowFactor, shadowFactor, 1.0);
        }
      `,
      transparent: false
    });

    // Bake Quad (0..1 in UVs)
    // PlaneGeometry defaults to 1x1 centered at 0,0
    this.bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.bakeMaterial);
    this.bakeQuad.position.set(0.5, 0.5, 0); // Move center to 0.5,0.5 so it spans 0..1
    // Match V1: apply the same geometry flip as the world base plane (scale.y=-1).
    // This keeps the baked texture aligned with world space when sampled later.
    this.bakeQuad.scale.y = -1;
    this.bakeScene.add(this.bakeQuad);

    // 2. Create Display Environment (Screen Space Render)
    this.shadowScene = new THREE.Scene();

    // Simple material to sample the baked world texture
    this.displayMaterial = new THREE.MeshBasicMaterial({
      map: null, // Will be bound to worldShadowTarget.texture
      transparent: true,
      opacity: 1.0, // We rely on LightingEffect.uBuildingShadowOpacity
      blending: THREE.NoBlending 
    });

    if (this.baseMesh && this.outdoorsMask) {
      this._createShadowMesh();
      this.needsBake = true;
    }

    log.info('BuildingShadowsEffect initialized with World Space Caching');
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

    // Update the bake material input
    if (this.bakeMaterial) {
      this.bakeMaterial.uniforms.tOutdoors.value = this.outdoorsMask;
    }

    // Create the world-pinned mesh for display
    this.shadowMesh = new THREE.Mesh(this.baseMesh.geometry, this.displayMaterial);
    this.shadowMesh.position.copy(this.baseMesh.position);
    this.shadowMesh.rotation.copy(this.baseMesh.rotation);
    this.shadowMesh.scale.copy(this.baseMesh.scale);

    // Ensure the shadow mesh is visible to cameras even when FloorCompositor
    // is rendering with floor-isolated layer masks.
    this.shadowMesh.layers.set(0);

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
    if (!this.params.enabled) return;

    const THREE = window.THREE;
    if (!THREE) return;

    // 1. Update Time & Sun Direction
    let hour = 12.0;
    try {
      if (weatherController && typeof weatherController.timeOfDay === 'number') {
        hour = weatherController.timeOfDay;
      }
    } catch (e) { /* default */ }

    const isFoundryLinked = window.MapShine?.controlPanel?.controlState?.linkTimeToFoundry === true;
    const phaseHours = isFoundryLinked ? getFoundryTimePhaseHours() : null;
    const sunrise = Number.isFinite(phaseHours?.sunrise)
      ? phaseHours.sunrise
      : Math.max(0.0, Math.min(24.0, this.params.sunriseTime ?? 6.0));
    const sunset = Number.isFinite(phaseHours?.sunset)
      ? phaseHours.sunset
      : Math.max(0.0, Math.min(24.0, this.params.sunsetTime ?? 18.0));

    const t = (hour % 24.0) / 24.0;
    const azimuth = (t - 0.5) * Math.PI;
    const x = -Math.sin(azimuth);
    const lat = Math.max(0.0, Math.min(1.0, this.params.sunLatitude ?? 0.5));
    const y = -Math.cos(azimuth) * lat;

    if (!this.sunDir) {
      this.sunDir = new THREE.Vector2(x, y);
    } else {
      this.sunDir.set(x, y);
    }

    const safeHour = ((hour % 24.0) + 24.0) % 24.0;
    const dayLength = ((sunset - sunrise) + 24.0) % 24.0;
    let timeIntensity = 0.0;

    if (dayLength > 0.01) {
      const phase = ((safeHour - sunrise) + 24.0) % 24.0;

      // Core daytime lobe: symmetric peak at sunrise/sunset, minimum at midday.
      if (phase >= 0.0 && phase <= dayLength) {
        const u = phase / dayLength;
        const edge = Math.abs(2.0 * u - 1.0);
        timeIntensity = Math.pow(edge, 0.5);
      } else {
        // Extended fade region outside [sunrise, sunset] to avoid a hard cutoff.
        const fadeHours = 1.5; // Duration of pre-dawn / post-dusk fade in hours.

        // Pre-dawn: from (sunrise - fadeHours) up to sunrise.
        const preDawnDelta = ((sunrise - safeHour) + 24.0) % 24.0;
        if (preDawnDelta > 0.0 && preDawnDelta < fadeHours) {
          const tFade = 1.0 - (preDawnDelta / fadeHours);
          timeIntensity = Math.pow(Math.max(0.0, tFade), 0.5);
        }

        // Post-dusk: from sunset out to (sunset + fadeHours).
        const postDuskDelta = ((safeHour - sunset) + 24.0) % 24.0;
        if (postDuskDelta > 0.0 && postDuskDelta < fadeHours) {
          const tFade = 1.0 - (postDuskDelta / fadeHours);
          const tail = Math.pow(Math.max(0.0, tFade), 0.5);
          // If both regions somehow overlap, keep the stronger contribution.
          timeIntensity = Math.max(timeIntensity, tail);
        }
      }
    } else {
      timeIntensity = 1.0;
    }

    this.timeIntensity = timeIntensity;

    // 2. Derive Penumbra Params
    const blur = Math.max(0.0, Math.min(1.0, this.params.blurStrength ?? 0.5));
    this.params.penumbraRadiusNear = 0.0;
    this.params.penumbraRadiusFar = 0.02 + blur * 0.18;
    const minTaps = 1;
    const maxTaps = 9;
    const taps = Math.round(minTaps + blur * (maxTaps - minTaps));
    this.params.penumbraSamples = Math.max(1, Math.min(9, taps));
    this.params.penumbraExponent = 0.5 + blur * 2.0;

    // 3. Check if Bake is Needed
    // Construct a hash of all parameters that affect the shadow shape
    // (Opacity is NOT included as it's applied in composition)
    const bakeState = {
      v: this._bakeVersion,
      sunX: x.toFixed(4),
      sunY: y.toFixed(4),
      length: this.params.length,
      quality: this.params.quality,
      pNear: this.params.penumbraRadiusNear,
      pFar: this.params.penumbraRadiusFar,
      pSamples: this.params.penumbraSamples,
      pExp: this.params.penumbraExponent,
      maskId: this.outdoorsMask ? this.outdoorsMask.uuid : 'null'
    };
    const currentHash = JSON.stringify(bakeState);

    if (currentHash !== this.lastBakeHash) {
      this.needsBake = true;
      this.lastBakeHash = currentHash;
    }

    // Update Bake Material Uniforms
    if (this.needsBake && this.bakeMaterial) {
      const u = this.bakeMaterial.uniforms;
      const timeScale = (typeof this.timeIntensity === 'number')
        ? (0.5 + 0.5 * THREE.MathUtils.clamp(this.timeIntensity, 0.0, 1.0))
        : 1.0;
      const effectiveLength = this.params.length * timeScale;

      u.uLength.value = effectiveLength;
      u.uSampleCount.value = this.params.quality;
      u.uSunDir.value.copy(this.sunDir);
      u.uPenumbraRadiusNear.value = this.params.penumbraRadiusNear;
      u.uPenumbraRadiusFar.value = this.params.penumbraRadiusFar;
      u.uPenumbraSamples.value = this.params.penumbraSamples;
      u.uPenumbraExponent.value = this.params.penumbraExponent;
    }
  }

  render(renderer, scene = null, camera = null) {
    if (!this.params.enabled) return;

    const THREE = window.THREE;
    if (!THREE) return;

    // Allow V2 compositor to supply the active camera/scene each frame.
    if (camera) this.mainCamera = camera;
    if (scene) this.mainScene = scene;
    if (!this.mainCamera || !this.shadowScene) return;

    if (!this._dbgLoggedOnce) {
      this._dbgLoggedOnce = true;
      try {
        const hasMask = !!this.outdoorsMask;
        const bakeTex = this.bakeMaterial?.uniforms?.tOutdoors?.value;
        log.info('BuildingShadowsEffectV2 first render:',
          'enabled', !!this.params?.enabled,
          '| outdoorsMask', hasMask ? (this.outdoorsMask?.uuid || 'ok') : 'null',
          '| bakeUniform.tOutdoors', bakeTex ? (bakeTex?.uuid || 'ok') : 'null',
          '| needsBake', !!this.needsBake
        );
      } catch (_) {}
    }

    // Ensure targets
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    if (!this.shadowTarget) {
      this.onResize(size.x, size.y);
    }

    const previousTarget = renderer.getRenderTarget();

    // --- PASS 1: BAKE WORLD SHADOWS (Only if needed) ---
    if (this.needsBake && this.bakeScene && this.bakeCamera) {
      if (!this.worldShadowTarget) {
        // Use a fixed high resolution for the world shadow map
        const BAKE_SIZE = 2048; 
        this.worldShadowTarget = new THREE.WebGLRenderTarget(BAKE_SIZE, BAKE_SIZE, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
          wrapS: THREE.ClampToEdgeWrapping,
          wrapT: THREE.ClampToEdgeWrapping
        });
        
        // Bind the new texture to display material
        if (this.displayMaterial) {
          this.displayMaterial.map = this.worldShadowTarget.texture;
          this.displayMaterial.needsUpdate = true;
        }
      }

      renderer.setRenderTarget(this.worldShadowTarget);
      renderer.setClearColor(0xffffff, 1); // Default to Lit
      renderer.clear();
      renderer.render(this.bakeScene, this.bakeCamera);

      if (!this._dbgBakedOnce) {
        this._dbgBakedOnce = true;
        try {
          // Sample multiple pixels from the baked RT.
          // NOTE: The shader intentionally outputs 1.0 (white) for indoor pixels,
          // so the center sample can be a false negative if it lands indoors.
          const w = this.worldShadowTarget.width;
          const h = this.worldShadowTarget.height;
          const px = new Uint8Array(4);

          const taps = [
            { name: 'c',  u: 0.50, v: 0.50 },
            { name: 'l',  u: 0.25, v: 0.50 },
            { name: 'r',  u: 0.75, v: 0.50 },
            { name: 't',  u: 0.50, v: 0.75 },
            { name: 'b',  u: 0.50, v: 0.25 },
            { name: 'tl', u: 0.10, v: 0.90 },
            { name: 'tr', u: 0.90, v: 0.90 },
            { name: 'bl', u: 0.10, v: 0.10 },
            { name: 'br', u: 0.90, v: 0.10 },
          ];

          /** @type {Record<string, number[]>} */
          const samples = {};
          let minR = 255;
          let maxR = 0;

          for (const t of taps) {
            const x = Math.max(0, Math.min(w - 1, Math.floor(w * t.u)));
            const y = Math.max(0, Math.min(h - 1, Math.floor(h * t.v)));
            renderer.readRenderTargetPixels(this.worldShadowTarget, x, y, 1, 1, px);
            samples[t.name] = [px[0], px[1], px[2], px[3]];
            minR = Math.min(minR, px[0]);
            maxR = Math.max(maxR, px[0]);
          }

          log.info('BuildingShadowsEffectV2 bake samples RGBA:', samples, '| minR', minR, '| maxR', maxR);
        } catch (e) {
          try { log.warn('BuildingShadowsEffectV2 bake sample failed:', e); } catch (_) {}
        }
      }

      this.needsBake = false;
      
      // Log strictly for debugging, maybe remove later
      // log.debug('Baked Building Shadows');
    }

    // --- PASS 2: RENDER SCREEN SPACE SHADOWS ---
    // Render world-pinned shadow mesh (sampling baked texture) into screen-space target
    if (this.shadowTarget) {
      const prevLayerMask = this.mainCamera.layers.mask;
      this.mainCamera.layers.enable(0);
      renderer.setRenderTarget(this.shadowTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(this.shadowScene, this.mainCamera);
      this.mainCamera.layers.mask = prevLayerMask;
    }

    renderer.setRenderTarget(previousTarget);
  }

  /**
   * Bind floor-specific mask data before a floor's render pass.
   * @param {object} bundle - Mask bundle for this floor
   * @param {string} floorKey - Stable floor key from FloorBand.key
   */
  bindFloorMasks(bundle, floorKey) {
    if (!bundle) return;

    // Retrieve the outdoors mask from the floor bundle.
    const maskEntry = bundle.masks?.find(m => m.id === 'outdoors' || m.type === 'outdoors');
    const floorMaskTex = maskEntry?.texture ?? null;

    // Restore from cache if available and mask hasn't changed.
    const cached = this._floorStates.get(floorKey);
    if (cached) {
      if (cached.outdoorsMask === floorMaskTex) {
        this.outdoorsMask = cached.outdoorsMask;
        return;
      }
      // Mask reference changed (e.g. recomposed) — fall through to rebind.
    }

    // First visit or mask changed: bind and schedule a rebake.
    this.outdoorsMask = floorMaskTex;
    if (floorMaskTex && this.renderer && this.mainScene && this.mainCamera) {
      this._createShadowMesh();
      this.needsBake = true;
    }
    this._floorStates.set(floorKey, { outdoorsMask: floorMaskTex });
  }

  /**
   * Release the cached state for a specific floor.
   * The floor state only holds a reference to the registry-owned outdoors mask
   * texture — there are no owned GPU resources to dispose here.
   * @param {string} floorKey
   */
  disposeFloorState(floorKey) {
    this._floorStates.delete(floorKey);
  }

  dispose() {
    for (const key of this._floorStates.keys()) {
      this.disposeFloorState(key);
    }
    this._floorStates.clear();
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    if (this.shadowTarget) {
      this.shadowTarget.dispose();
      this.shadowTarget = null;
    }
    if (this.worldShadowTarget) {
      this.worldShadowTarget.dispose();
      this.worldShadowTarget = null;
    }
    if (this.bakeMaterial) {
      this.bakeMaterial.dispose();
      this.bakeMaterial = null;
    }
    if (this.displayMaterial) {
      this.displayMaterial.dispose();
      this.displayMaterial = null;
    }
    if (this.shadowMesh && this.shadowScene) {
      this.shadowScene.remove(this.shadowMesh);
      this.shadowMesh = null;
    }
    this.shadowScene = null;
    this.bakeScene = null;
    log.info('BuildingShadowsEffect disposed');
  }
}
