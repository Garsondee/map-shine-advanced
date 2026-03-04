/**
 * @fileoverview FloorCompositor — V2 compositor render orchestrator.
 *
 * Owns the FloorRenderBus and drives the per-frame render loop.
 * The bus scene contains all tile meshes Z-ordered by floor. Effects add
 * overlay meshes to the same bus scene so they benefit from the same floor
 * visibility system.
 *
 * Render pipeline:
 *   1. Bus scene (albedo + overlays) → **sceneRT** (offscreen)
 *   2. Post-processing chain reads sceneRT, writes through ping-pong RTs
 *   3. Final blit to screen framebuffer
 *
 * Current effects (bus overlays — rendered in step 1):
 *   - **SpecularEffectV2**: Per-tile additive overlays driven by _Specular masks.
 *   - **FireEffectV2**: Per-floor particle systems driven by _Fire masks.
 *   - **WaterSplashesEffectV2**: Per-floor foam plume + rain splash particles
 *     driven by _Water masks. Own BatchedRenderer in the bus scene.
 *   - **WeatherParticlesV2**: Rain, snow, and ash particles via
 *     shared BatchedRenderer in the bus scene.
 *
 * Post-processing effects (step 2):
 *   - **CloudEffectV2**: Procedural clouds — generates shadow RT (fed into Lighting)
 *     and cloud-top RT (blitted after lighting). Shadow occlusion is floor-aware via
 *     the overhead-tile blocker pass.
 *   - **LightingEffectV2**: Ambient + dynamic lights + darkness, with cloud shadow.
 *     Window light overlays are fed into the light accumulation RT here so
 *     the compose shader tints them by surface albedo (preserving hue).
 *   - **WaterEffectV2**: Water tint/distortion/specular/foam driven by _Water masks.
 *   - **SkyColorEffectV2**: Time-of-day atmospheric color grading.
 *   - **BloomEffectV2**: Screen-space glow via UnrealBloomPass.
 *   - **ColorCorrectionEffectV2**: User-authored color grade.
 *   - **FilmGrainEffectV2**: Animated noise overlay (disabled by default).
 *   - **SharpenEffectV2**: Unsharp mask filter (disabled by default).
 *
 * Called by EffectComposer.render() when the `useCompositorV2` setting is on.
 *
 * @module compositor-v2/FloorCompositor
 */

import { createLogger } from '../core/log.js';
import { FloorRenderBus } from './FloorRenderBus.js';
import { SpecularEffectV2 } from './effects/SpecularEffectV2.js';
import { FireEffectV2 } from './effects/FireEffectV2.js';
import { WindowLightEffectV2 } from './effects/WindowLightEffectV2.js';
import { LightingEffectV2 } from './effects/LightingEffectV2.js';
import { SkyColorEffectV2 } from './effects/SkyColorEffectV2.js';
import { ColorCorrectionEffectV2 } from './effects/ColorCorrectionEffectV2.js';
import { BloomEffectV2 } from './effects/BloomEffectV2.js';
import { FilmGrainEffectV2 } from './effects/FilmGrainEffectV2.js';
import { SharpenEffectV2 } from './effects/SharpenEffectV2.js';
import { FilterEffectV2 } from './effects/FilterEffectV2.js';
import { WaterEffectV2 } from './effects/WaterEffectV2.js';
import { CloudEffectV2 } from './effects/CloudEffectV2.js';
import { WeatherParticlesV2 } from './effects/WeatherParticlesV2.js';
import { WaterSplashesEffectV2 } from './effects/WaterSplashesEffectV2.js';
import { AshDisturbanceEffectV2 } from './effects/AshDisturbanceEffectV2.js';
import { FluidEffectV2 } from './effects/FluidEffectV2.js';
import { getCircuitBreaker } from '../core/circuit-breaker.js';
import { OutdoorsMaskProviderV2 } from './effects/OutdoorsMaskProviderV2.js';
import { BuildingShadowsEffectV2 } from './effects/BuildingShadowsEffectV2.js';
import { OverheadShadowsEffectV2 } from './effects/OverheadShadowsEffectV2.js';
import { weatherController } from '../core/WeatherController.js';
import { WorldSpaceFogEffect } from '../effects/WorldSpaceFogEffect.js';

const log = createLogger('FloorCompositor');

// ─── FloorCompositor ─────────────────────────────────────────────────────────

export class FloorCompositor {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene - The main Three.js scene (not used directly by
   *   the bus — which has its own scene — but kept for future effects that may
   *   need to add objects to the main scene graph).
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(renderer, scene, camera) {
    /** @type {THREE.WebGLRenderer} */
    this.renderer = renderer;
    /** @type {THREE.Scene} */
    this.scene = scene;
    /** @type {THREE.PerspectiveCamera} */
    this.camera = camera;

    /**
     * FloorRenderBus: owns a single THREE.Scene containing all tile meshes
     * Z-ordered by floor index. Textures loaded independently via
     * THREE.TextureLoader (straight alpha, no canvas 2D corruption).
     * @type {FloorRenderBus}
     */
    this._renderBus = new FloorRenderBus();

    /**
     * V2 Specular Effect: per-tile additive overlays driven by _Specular masks.
     * Overlay meshes live in the bus scene so they benefit from the same floor
     * visibility system as albedo tiles.
     * @type {SpecularEffectV2}
     */
    this._specularEffect = new SpecularEffectV2(this._renderBus);

    /**
     * V2 Fluid Effect: per-tile animated fluid overlays driven by _Fluid masks.
     * Overlays live in the bus scene and are floor-visible via the bus.
     * @type {FluidEffectV2}
     */
    this._fluidEffect = new FluidEffectV2(this._renderBus);

    /**
     * V2 Fire Effect: per-floor particle systems (fire + embers + smoke)
     * driven by _Fire masks. BatchedRenderer lives in the bus scene.
     * @type {FireEffectV2}
     */
    this._fireEffect = new FireEffectV2(this._renderBus);

    /**
     * V2 Window Light Effect: per-tile additive overlays driven by _Windows masks.
     * Overlays live in an ISOLATED scene rendered AFTER the lighting pass so they
     * are not multiplied by ambient/darkness (which would wash out saturation).
     * @type {WindowLightEffectV2}
     */
    this._windowLightEffect = new WindowLightEffectV2();

    /**
     * V2 Lighting Effect: post-processing pass that applies ambient light,
     * dynamic light sources, and darkness to the bus scene RT.
     * @type {LightingEffectV2}
     */
    this._lightingEffect = new LightingEffectV2();

    /**
     * V2 Sky Color Effect: screen-space color grading driven by time-of-day
     * and weather. Post-processing pass after lighting.
     * @type {SkyColorEffectV2}
     */
    this._skyColorEffect = new SkyColorEffectV2();

    /**
     * V2 Color Correction Effect: static user-authored color grade.
     * Post-processing pass after sky color (near end of chain).
     * @type {ColorCorrectionEffectV2}
     */
    this._colorCorrectionEffect = new ColorCorrectionEffectV2();

    /**
     * V2 Filter Effect: multiplicative overlay pass. Intended for ink/AO-style
     * darkening and simple multiply tints. Runs after color correction so it can
     * be authored in the final look space, and before bloom so darkening can
     * suppress glow regions.
     * @type {FilterEffectV2}
     */
    this._filterEffect = new FilterEffectV2();

    /**
     * V2 Bloom Effect: screen-space glow via UnrealBloomPass.
     * Runs after sky color, before color correction.
     * @type {BloomEffectV2}
     */
    this._bloomEffect = new BloomEffectV2();

    /**
     * V2 Film Grain Effect: animated noise overlay. Disabled by default.
     * @type {FilmGrainEffectV2}
     */
    this._filmGrainEffect = new FilmGrainEffectV2();

    /**
     * V2 Sharpen Effect: unsharp mask filter. Disabled by default.
     * @type {SharpenEffectV2}
     */
    this._sharpenEffect = new SharpenEffectV2();

    /**
     * V2 Cloud Effect: procedural cloud density, shadow, and cloud-top passes.
     * - Shadow RT is fed into LightingEffectV2 as an illumination multiplier.
     * - Cloud-top RT is blitted (alpha-over) after the lighting pass.
     * - Blocker mask is built from overhead bus sprites each frame so
     *   floor-level rooftops correctly occlude shadows (free with bus visibility).
     * @type {CloudEffectV2}
     */
    this._cloudEffect = new CloudEffectV2();

    // Circuit breaker: central, client-local effect kill-switches.
    this._circuitBreaker = getCircuitBreaker();

    /**
     * V2 Water Effect: fullscreen post-process surface driven by composited _Water
     * masks (background + tiles). Renders in the post chain.
     * @type {WaterEffectV2}
     */
    const waterDisabled = this._circuitBreaker.isDisabled('v2.water') || (() => {
      // Client-local emergency kill switch: if the water shader triggers a GPU driver
      // compilation hang, Foundry can freeze before you can open any UI to disable it.
      // Set in the browser console:
      //   localStorage.setItem('msa-disable-v2-water', '1')
      // and reload.
      try { return globalThis.localStorage?.getItem?.('msa-disable-v2-water') === '1'; } catch (_) { return false; }
    })();
    this._waterEffect = waterDisabled ? null : new WaterEffectV2();

    /**
     * V2 Water Splashes Effect: per-floor foam plume + rain splash particle
     * systems driven by _Water masks. Own BatchedRenderer in the bus scene.
     * Replaces the legacy foam bridge (WaterEffectV2 → WeatherParticles).
     * @type {WaterSplashesEffectV2}
     */
    this._waterSplashesEffect = this._circuitBreaker.isDisabled('v2.waterSplashes') ? null : new WaterSplashesEffectV2(this._renderBus);

    /**
     * V2 Underwater Bubbles controls: proxy to the bubbles layer inside WaterSplashesEffectV2.
     * This exists solely for UI + persistence routing.
     */
    this._underwaterBubblesEffect = this._waterSplashesEffect ? this._waterSplashesEffect.bubbles : null;

    /**
     * V2 Weather Particles: rain, snow, and ash particles.
     * Wraps the V1 WeatherParticles class using a shared BatchedRenderer that
     * lives in the FloorRenderBus scene. Also drives WeatherController.update()
     * each frame so weather state is live in V2.
     * @type {WeatherParticlesV2}
     */
    this._weatherParticles = this._circuitBreaker.isDisabled('v2.weatherParticles') ? null : new WeatherParticlesV2();

    /**
     * V2 Ash Disturbance Effect: token-movement driven ash bursts from _Ash masks.
     * Own BatchedRenderer lives in the bus scene.
     * @type {AshDisturbanceEffectV2}
     */
    this._ashDisturbanceEffect = this._circuitBreaker.isDisabled('v2.ashDisturbance') ? null : new AshDisturbanceEffectV2(this._renderBus);

    /**
     * V2 Outdoors mask provider: discovers _Outdoors tiles per floor, composites
     * them into a scene-UV canvas texture, and notifies all consumers (cloud shadow,
     * water indoor damping, weather particle roof gating).
     * @type {OutdoorsMaskProviderV2}
     */
    this._outdoorsMask = this._circuitBreaker.isDisabled('v2.outdoorsMask') ? null : new OutdoorsMaskProviderV2();

    /**
     * V2 Building Shadows Effect: bakes a greyscale shadow-factor texture from the
     * union of all _Outdoors masks up to the active floor. Fed into LightingEffectV2
     * as `tBuildingShadow`.
     * @type {BuildingShadowsEffectV2}
     */
    this._buildingShadowEffect = this._circuitBreaker.isDisabled('v2.buildingShadows') ? null : new BuildingShadowsEffectV2();

    /**
     * V2 Overhead Shadows Effect: per-frame soft shadow cast by overhead tiles
     * (tileDoc.overhead === true) onto the scene below. Fed into LightingEffectV2
     * as `tOverheadShadow` — dims ambient only, dynamic lights punch through.
     * @type {OverheadShadowsEffectV2}
     */
    this._overheadShadowEffect = this._circuitBreaker.isDisabled('v2.overheadShadows') ? null : new OverheadShadowsEffectV2(this._renderBus);

    /**
     * Fog of War overlay (reuses the V1 WorldSpaceFogEffect implementation).
     *
     * In V1, the fog plane is added to the main scene and renders during the
     * main scene pass. In V2, the main scene is not rendered (we blit RTs), so
     * we render the fog plane in a dedicated overlay scene after the final blit.
     * @type {WorldSpaceFogEffect|null}
     */
    this._fogEffect = this._circuitBreaker.isDisabled('v2.fog') ? null : new WorldSpaceFogEffect();

    /** @type {THREE.Scene|null} Dedicated scene that contains the fog plane mesh. */
    this._fogScene = null;

    /** @type {boolean} Whether the render bus has been populated this session. */
    this._busPopulated = false;

    /** @type {boolean} Whether initialize() has been called */
    this._initialized = false;

    /** @type {THREE.Vector2} Reusable size vector (avoids per-frame allocation) */
    this._sizeVec = null;

    /** @type {number|null} Foundry hook ID for mapShineLevelContextChanged */
    this._levelHookId = null;

    /** @type {string|null} Last applied active level context key (bottom:top) */
    this._lastAppliedLevelContextKey = null;

    // Diagnostic: log the first frame's major render stages once.
    // This helps pinpoint which stage stalls the main thread on some GPUs.
    this._debugFirstFrameStagesLogged = false;

    // ── RT Infrastructure (Step 4) ───────────────────────────────────────────
    // Bus renders to sceneRT instead of screen. Post-processing effects will
    // read sceneRT and chain through ping-pong buffers. Final result is blit
    // to the screen framebuffer.

    /** @type {THREE.WebGLRenderTarget|null} Bus scene render target */
    this._sceneRT = null;
    /** @type {THREE.WebGLRenderTarget|null} Post-processing ping-pong A */
    this._postA = null;
    /** @type {THREE.WebGLRenderTarget|null} Post-processing ping-pong B */
    this._postB = null;

    /** @type {THREE.WebGLRenderTarget|null} Upper-floor occluder mask for water effect */
    this._waterOccluderRT = null;

    /** @type {THREE.WebGLRenderTarget|null} Building shadow screen-space factor texture */
    this._buildingShadowRT = null;

    /** @type {THREE.Scene|null} Dedicated scene for fullscreen blit quad */
    this._blitScene  = null;
    /** @type {THREE.OrthographicCamera|null} Camera for blit renders */
    this._blitCamera = null;
    /** @type {THREE.ShaderMaterial|null} Simple passthrough blit material */
    this._blitMaterial = null;
    /** @type {THREE.Mesh|null} Fullscreen quad for blit */
    this._blitQuad = null;

    log.debug('FloorCompositor created');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Initialize the compositor. Currently just sets up the bus and the
   * floor-change hook. Render targets will be added when effects need them.
   */
  initialize() {
    const THREE = window.THREE;
    if (!THREE || !this.renderer) {
      log.warn('FloorCompositor.initialize: missing THREE or renderer');
      return;
    }

    this._sizeVec = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(this._sizeVec);
    const w = Math.max(1, this._sizeVec.x);
    const h = Math.max(1, this._sizeVec.y);

    // ── Render targets ────────────────────────────────────────────────
    // Prefer HalfFloat for HDR headroom (additive specular/window light can exceed 1.0),
    // but fall back to UnsignedByte on GPUs/browsers that can't render to half-float.
    // A hard failure here can trigger webglcontextlost during startup.
    //
    // IMPORTANT: All intermediate RTs must use LinearSRGBColorSpace so that
    // Three.js does NOT apply sRGB encoding on write or decoding on read.
    // The sRGB encode happens exactly once: in the final blit to the screen.
    const makeRt = (type, depthBuffer) => ({
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type,
      depthBuffer: !!depthBuffer,
      stencilBuffer: false,
    });

    let preferredType = THREE.HalfFloatType;
    // Quick capability probe: if we can't create a half-float RT, fall back.
    try {
      const probe = new THREE.WebGLRenderTarget(4, 4, makeRt(THREE.HalfFloatType, false));
      probe.texture.colorSpace = THREE.LinearSRGBColorSpace;
      probe.dispose();
    } catch (e) {
      preferredType = THREE.UnsignedByteType;
      log.warn('FloorCompositor.initialize: HalfFloat RT unsupported; falling back to UnsignedByte RTs', e);
    }

    const rtOpts = makeRt(preferredType, true);
    this._sceneRT = new THREE.WebGLRenderTarget(w, h, rtOpts);
    this._sceneRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    // Ping-pong pair for post-processing chain. No depth needed for post passes.
    const postOpts = makeRt(preferredType, false);
    this._postA = new THREE.WebGLRenderTarget(w, h, postOpts);
    this._postA.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._postB = new THREE.WebGLRenderTarget(w, h, postOpts);
    this._postB.texture.colorSpace = THREE.LinearSRGBColorSpace;

    // Water occluder mask: screen-space alpha mask of currently viewed floor tiles.
    // Validated approach: this mask is sampled directly in the water post shader
    // to suppress water under upper-floor geometry while preserving water through
    // true openings. Keep this path as the primary occlusion mechanism.
    // UnsignedByte is sufficient; we only sample alpha.
    this._waterOccluderRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });

    // Building shadow RT: screen-space shadow factor from BuildingShadowsEffectV2
    this._buildingShadowRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });

    // ── Fullscreen blit quad ──────────────────────────────────────────────
    this._blitScene  = new THREE.Scene();
    this._blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._blitMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          gl_FragColor = vec4(c.rgb, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    // Prevent the blit pass from re-applying tone mapping to the already
    // tone-mapped scene RT. Without this, the scene is tone-mapped twice
    // which shifts brightness/contrast.
    this._blitMaterial.toneMapped = false;
    this._blitQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._blitMaterial
    );
    this._blitQuad.frustumCulled = false;
    this._blitScene.add(this._blitQuad);

    // ── Effects + hooks ───────────────────────────────────────────────────
    this._renderBus.initialize();
    this._specularEffect.initialize();
    this._fluidEffect.initialize();
    this._fireEffect.initialize();
    this._windowLightEffect.initialize();
    // Cloud effect needs the bus scene and main camera for the overhead blocker pass.
    this._cloudEffect.initialize(this.renderer, this._renderBus._scene, this.camera);
    // Water splashes: own BatchedRenderer added via addEffectOverlay.
    try { this._waterSplashesEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: WaterSplashesEffectV2 initialize failed:', err);
    }
    // Weather particles live in the bus scene so they render in the same pass as tiles.
    try { this._weatherParticles?.initialize?.(this._renderBus._scene); } catch (err) {
      log.warn('FloorCompositor: WeatherParticlesV2 initialize failed:', err);
    }

    // Ash disturbance bursts: owns its own batch renderer and registers it via renderBus overlay.
    try { this._ashDisturbanceEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: AshDisturbanceEffectV2 initialize failed:', err);
    }

    // Subscribe outdoors mask consumers so they receive the texture as soon as
    // populate() builds it, and again on every floor change.
    // CloudEffectV2: cloud shadows and cloud tops only fall on outdoor areas.
    // We set both the legacy single-texture path (setOutdoorsMask, which is the one
    // actually sampled since V2 has no floorIdTarget) AND the per-floor array so the
    // multi-floor path is ready if a floorIdTexture is ever wired up.
    if (this._outdoorsMask) {
      this._outdoorsMask.subscribe((tex) => {
        try {
          this._cloudEffect.setOutdoorsMask(tex);
          this._cloudEffect.setOutdoorsMasks(this._outdoorsMask.getFloorTextureArray(4));
        } catch (_) {}
      });
      // WaterEffectV2: wave/rain indoor damping.
      this._outdoorsMask.subscribe((tex) => {
        try { this._waterEffect?.setOutdoorsMask?.(tex); } catch (_) {}
      });
      // WeatherController: particle foam fleck roof gating (roofMap CPU readback).
      this._outdoorsMask.subscribe((tex) => {
        try { if (weatherController?.initialized) weatherController.setRoofMap(tex ?? null); } catch (_) {}
      });
      // OverheadShadowsEffectV2: optional indoor dark-region projection from _Outdoors.
      this._outdoorsMask.subscribe((tex) => {
        try { this._overheadShadowEffect?.setOutdoorsMask?.(tex ?? null); } catch (_) {}
      });
    }

    this._lightingEffect.initialize(w, h);
    this._skyColorEffect.initialize();
    this._colorCorrectionEffect.initialize();
    this._filterEffect.initialize();
    this._bloomEffect.initialize(w, h);
    this._filmGrainEffect.initialize();
    this._sharpenEffect.initialize();
    if (this._waterEffect) {
      this._waterEffect.initialize();
    }
    try {
      this._buildingShadowEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera);
    } catch (err) {
      log.warn('FloorCompositor: BuildingShadowsEffectV2 initialize failed:', err);
    }
    // Register the outdoors mask provider so building shadows can union-composite
    // per-floor canvases. The provider fires the callback immediately (even if not
    // yet populated) so the effect sets up its subscription before populate() runs.
    try { this._buildingShadowEffect?.setOutdoorsMaskProvider?.(this._outdoorsMask); } catch (_) {}

    // V1-based effects handle _Outdoors masks through OutdoorsMaskProviderV2
    // No need to create base mesh - V1 effects work with their existing architecture

    try { 
      this._overheadShadowEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera); 
      this._overheadShadowEffect?.setOutdoorsMaskProvider?.(this._outdoorsMask);
    } catch (err) {
      log.warn('FloorCompositor: OverheadShadowsEffectV2 initialize failed:', err);
    }

    // Fog of War overlay: initialize into a dedicated overlay scene.
    if (this._fogEffect) {
      try {
        this._fogScene = new THREE.Scene();
        this._fogScene.name = 'FogOverlaySceneV2';
        this._fogEffect.initialize(this.renderer, this._fogScene, this.camera);
        try { if (window.MapShine) window.MapShine.fogEffect = this._fogEffect; } catch (_) {}
      } catch (err) {
        log.warn('FloorCompositor: Fog effect initialize failed:', err);
        this._fogEffect = null;
        this._fogScene = null;
      }
    }

    // Listen for floor/level changes so we can update tile mesh visibility.
    this._levelHookId = Hooks.on('mapShineLevelContextChanged', (payload) => {
      this._onLevelContextChanged(payload);
    });

    this._initialized = true;
    log.info(`FloorCompositor initialized (${w}x${h}, RT: HalfFloat)`);
  }

  /**
   * Hook for EffectComposer/RenderLoop adaptive FPS.
   * When true, the render loop will prefer the "continuous" FPS cap so
   * time-varying systems (particles) stay smooth.
   *
   * @returns {boolean}
   */
  wantsContinuousRender() {
    try {
      // Animated shader overlay: if any fluid overlays exist, we need continuous
      // render so uTime advances and the effect animates.
      const fluid = this._fluidEffect;
      if (fluid?.enabled && (fluid?._overlays?.size ?? 0) > 0) return true;
      const fire = this._fireEffect;
      if (fire?.enabled && fire._activeFloors?.size > 0) return true;
      const splash = this._waterSplashesEffect;
      if (splash?.enabled && splash._activeFloors?.size > 0) return true;
      return false;
    } catch (_) {
      // Fail safe: if anything about the probe throws, treat as active.
      return true;
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  /**
   * Per-frame render entry point. Called by EffectComposer when V2 is active.
   *
   * Renders the bus scene (albedo tiles + specular overlays) directly to screen.
   * No intermediate render targets or post-processing — additive blending on
   * specular overlays handles compositing in a single pass.
   *
   * @param {object} params
   * @param {object} [params.floorStack]
   * @param {object} [params.timeInfo]
   * @param {boolean} [params.doProfile=false]
   * @param {object} [params.profiler]
   */
  render({
    floorStack,
    timeInfo,
    doProfile = false,
    profiler = null,
  } = {}) {
    if (!this._initialized) {
      log.warn('FloorCompositor.render called before initialize()');
      return;
    }

    // ── Lazy bus population ───────────────────────────────────────────────────
    // Populate on the first render frame. Uses THREE.TextureLoader internally
    // so textures arrive asynchronously — meshes become visible as they load.
    if (!this._busPopulated) {
      this._busPopulated = true;
      const sc = window.MapShine?.sceneComposer ?? null;
      if (sc) {
        this._renderBus.populate(sc);
        // Wire basePlaneMesh into V1-based shadow effects once it exists.
        // Both BuildingShadowsEffectV2 and OverheadShadowsEffectV2 rely on a
        // world-pinned mesh (baseMesh geometry) for their projection pass.
        try {
          const basePlaneMesh = sc.basePlaneMesh ?? null;
          if (basePlaneMesh) {
            this._buildingShadowEffect?.setBaseMesh?.(basePlaneMesh);
            this._overheadShadowEffect?.setBaseMesh?.(basePlaneMesh);
          }
        } catch (_) {}
        // Apply initial floor visibility for albedo tiles (synchronous).
        this._applyCurrentFloorVisibility();
        // Populate specular overlays after bus tiles are built.
        // This is async (mask probing) so we re-apply floor visibility after
        // all overlays have been added — otherwise overlays default to visible
        // and upper-floor specular bleeds onto the ground floor on first load.
        this._specularEffect.populate(sc.foundrySceneData).then(() => {
          this._applyCurrentFloorVisibility();
        }).catch(err => {
          log.error('SpecularEffectV2 populate failed:', err);
        });

        // Populate fluid overlays from _Fluid masks.
        this._fluidEffect.populate(sc.foundrySceneData).then(() => {
          this._applyCurrentFloorVisibility();
        }).catch(err => {
          log.error('FluidEffectV2 populate failed:', err);
        });
        // Populate fire particle systems from _Fire masks.
        this._fireEffect.populate(sc.foundrySceneData).then(() => {
          this._applyCurrentFloorVisibility();
        }).catch(err => {
          log.error('FireEffectV2 populate failed:', err);
        });
        // Populate window light overlays from _Windows masks.
        this._windowLightEffect.populate(sc.foundrySceneData).then(() => {
          this._applyCurrentFloorVisibility();
        }).catch(err => {
          log.error('WindowLightEffectV2 populate failed:', err);
        });
        // Populate water mask discovery + SDF building.
        if (this._waterEffect) {
          this._waterEffect.populate(sc.foundrySceneData).then(() => {
            this._applyCurrentFloorVisibility();
          }).catch(err => {
            log.error('WaterEffectV2 populate failed:', err);
          });
        }
        // Populate water splash particle systems from _Water masks.
        if (this._waterSplashesEffect) {
          this._waterSplashesEffect.populate(sc.foundrySceneData).then(() => {
            this._applyCurrentFloorVisibility();
          }).catch(err => {
            log.error('WaterSplashesEffectV2 populate failed:', err);
          });
        }

        // Populate ash disturbance per-floor point sets from _Ash masks.
        if (this._ashDisturbanceEffect) {
          this._ashDisturbanceEffect.populate(sc.foundrySceneData).then(() => {
            this._applyCurrentFloorVisibility();
          }).catch(err => {
            log.error('AshDisturbanceEffectV2 populate failed:', err);
          });
        }
        // Populate outdoors mask (discovers _Outdoors tiles, notifies all consumers).
        if (this._outdoorsMask) {
          this._outdoorsMask.populate(sc.foundrySceneData).catch(err => {
            log.error('OutdoorsMaskProviderV2 populate failed:', err);
          });
        }
      } else {
        log.warn('FloorCompositor.render: no sceneComposer available for populate');
      }
    }

    // ── Robust floor change handling (per-frame self-correction) ─────────────
    // Some floor changes can occur before the compositor is bus-populated, or
    // via pathways that do not reliably trigger our hook listener. To prevent
    // effects from getting stuck on floor 0 (e.g. BuildingShadowsEffectV2),
    // detect activeLevelContext band changes each frame and re-apply floor
    // visibility + effect floor notifications.
    try {
      const ctx = window.MapShine?.activeLevelContext ?? null;
      const b = Number(ctx?.bottom);
      const t = Number(ctx?.top);
      // Only treat as a multi-floor context if both ends are finite.
      const key = (Number.isFinite(b) && Number.isFinite(t)) ? `${b}:${t}` : 'single';
      if (this._lastAppliedLevelContextKey !== key) {
        this._lastAppliedLevelContextKey = key;
        if (this._busPopulated) {
          this._applyCurrentFloorVisibility({ context: ctx });
        }
      }
    } catch (_) {}

    // ── Update effects (time-varying uniforms) ───────────────────────────
    if (timeInfo) {
      // Wind must advance before update() so accumulation is 1× per frame.
      this._cloudEffect.advanceWind(timeInfo.delta ?? 0.016);
      this._specularEffect.update(timeInfo);
      try { this._fluidEffect.update(timeInfo); } catch (err) {
        log.warn('FluidEffectV2 update threw, skipping fluid update:', err);
      }
      try {
        this._fireEffect.update(timeInfo);
      } catch (err) {
        log.warn('FireEffectV2 update threw, skipping frame:', err);
      }
      try {
        this._waterSplashesEffect?.update?.(timeInfo);
      } catch (err) {
        log.warn('WaterSplashesEffectV2 update threw, skipping frame:', err);
      }
      try {
        this._ashDisturbanceEffect?.update?.(timeInfo);
      } catch (err) {
        log.warn('AshDisturbanceEffectV2 update threw, skipping frame:', err);
      }
      this._windowLightEffect.update(timeInfo);
      this._cloudEffect.update(timeInfo);
      this._lightingEffect.update(timeInfo);
      // Weather particles must update BEFORE the bus render so their BatchedRenderer
      // positions are current when the bus scene is drawn this frame.
      try { this._weatherParticles?.update?.(timeInfo); } catch (err) {
        log.warn('WeatherParticlesV2 update threw, skipping weather update:', err);
      }
      try { this._waterEffect?.update?.(timeInfo); } catch (err) {
        log.warn('WaterEffectV2 update threw, skipping water update:', err);
      }
      this._skyColorEffect.update(timeInfo);
      this._colorCorrectionEffect.update(timeInfo);
      this._filterEffect.update(timeInfo);
      this._bloomEffect.update(timeInfo);
      this._filmGrainEffect.update(timeInfo);
      this._sharpenEffect.update(timeInfo);
      // Overhead shadows: update sun direction + uniform params from controls.
      try { this._overheadShadowEffect?.update?.(timeInfo); } catch (err) {
        log.warn('OverheadShadowsEffectV2 update threw, skipping overhead shadow update:', err);
      }
      // Building shadows: update sun direction + bake hash. Must run after
      // sky color so sun angles are current before being fed to the shadow effect.
      try { this._buildingShadowEffect?.update?.(timeInfo); } catch (err) {
        log.warn('BuildingShadowsEffectV2 update threw, skipping building shadow update:', err);
      }
      // Overhead shadows: no per-frame update needed — sun angles are pushed
      // directly below from SkyColorEffectV2 before render().

      // Fog of war: updates vision/exploration RTs and toggles fog plane visibility.
      try { this._fogEffect?.update?.(timeInfo); } catch (err) {
        log.warn('Fog effect update threw, skipping fog update:', err);
      }
    }

    // ── Bind per-frame textures and camera to effects ────────────────────────
    this._specularEffect.render(this.renderer, this.camera);

    // Feed live sun angles from SkyColorEffectV2 into building shadows and
    // overhead shadows — single source of truth for sun direction.
    try {
      const sky = this._skyColorEffect;
      if (sky && typeof sky.currentSunAzimuthDeg === 'number') {
        const az  = sky.currentSunAzimuthDeg;
        const el  = sky.currentSunElevationDeg ?? 45;
        this._buildingShadowEffect?.setSunAngles?.(az, el);
        this._overheadShadowEffect?.setSunAngles?.(az, el);
      }
    } catch (_) {}

    const _dbgStages = !this._debugFirstFrameStagesLogged;
    if (_dbgStages) {
      try { log.info('[V2 Frame] ▶ FloorCompositor.render: BEGIN'); } catch (_) {}
    }

    // Building shadow render (V1 signature - renderer + scene + camera)
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: buildingShadows.render'); } catch (_) {} }
    try { 
      this._buildingShadowEffect?.render?.(this.renderer, this._renderBus._scene, this.camera);
    } catch (err) {
      log.warn('BuildingShadowsEffectV2 render threw, skipping building shadow pass:', err);
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: buildingShadows.render DONE'); } catch (_) {} }

    // Capture overhead tile alpha + compute soft shadow factor (V1 signature)
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: overheadShadows.render'); } catch (_) {} }
    try {
      this._overheadShadowEffect?.render?.(this.renderer, this._renderBus._scene, this.camera);
    } catch (err) {
      log.warn('OverheadShadowsEffectV2 render threw, skipping overhead shadow pass:', err);
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: overheadShadows.render DONE'); } catch (_) {} }

    // ── Step 1: Render bus scene → sceneRT ───────────────────────────────
    // The bus scene contains albedo tiles + specular/fire overlays.
    // Window light is NOT in the bus scene — it renders after lighting.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: bus.renderTo(sceneRT)'); } catch (_) {} }
    this._renderBus.renderTo(this.renderer, this.camera, this._sceneRT);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: bus.renderTo(sceneRT) DONE'); } catch (_) {} }

    // ── Cloud passes (before lighting) ───────────────────────────────────
    // Must run after bus render so the blocker pass sees current tile visibility.
    // Outputs: _cloudEffect.cloudShadowTexture (fed into lighting compose shader)
    //          _cloudEffect._cloudTopRT        (blitted after lighting)
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: cloud.render'); } catch (_) {} }
    if (this._cloudEffect.enabled && this._cloudEffect.params.enabled) {
      this._cloudEffect.render(this.renderer);
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: cloud.render DONE'); } catch (_) {} }

    // ── Step 2: Post-processing chain ────────────────────────────────────
    // Post effects read sceneRT and chain through _postA/_postB.
    // `currentInput` tracks which RT holds the latest result.
    let currentInput = this._sceneRT;

    // Lighting pass: sceneRT → postA.
    // Window light scene is passed in so it accumulates into the light RT
    // alongside ThreeLightSources — the compose shader then applies
    // litColor = albedo * totalIllumination, which tints the glow by the
    // surface colour instead of washing it out with pure white addition.
    // Cloud shadow RT is also passed so illumination is multiplied by the shadow factor.
    const winScene = this._windowLightEffect.enabled
      ? this._windowLightEffect._scene : null;
    const cloudShadowTex = (this._cloudEffect.enabled && this._cloudEffect.params.enabled)
      ? this._cloudEffect.cloudShadowTexture : null;
    const buildingEffect = this._buildingShadowEffect;
    const buildingShadowTex = (buildingEffect?.params?.enabled)
      ? buildingEffect.shadowFactorTexture
      : null;
    const buildingShadowOpacity = Number.isFinite(buildingEffect?.params?.opacity)
      ? buildingEffect.params.opacity
      : 0.75;
    const overheadShadowTex = (this._overheadShadowEffect?.params?.enabled)
      ? this._overheadShadowEffect.shadowFactorTexture : null;
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: lighting.render(sceneRT→postA)'); } catch (_) {} }

    this._lightingEffect.render(this.renderer, this.camera, currentInput, this._postA, winScene, cloudShadowTex, buildingShadowTex, overheadShadowTex, buildingShadowOpacity);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: lighting.render(sceneRT→postA) DONE'); } catch (_) {} }

    // BASELINE: Skip ALL post-processing to establish stable rendering.
    // Post-processing causes freeze on second frame. We'll re-enable passes
    // one by one once we have a stable baseline.
    currentInput = this._postA;
    
    if (_dbgStages) {
      try { log.warn('[V2 BASELINE] Skipping ALL post-processing - establishing stable baseline'); } catch (_) {}
    }
    
    // Baseline step: re-enable ONLY the water pass.
    // Water is a core look-defining effect; leaving it disabled makes V2 appear broken.
    // Keep all other post passes disabled until the original second-frame freeze
    // root cause is fully resolved.
    //
    // The water shader now defaults to a safe mode that removes expensive rain ripple/storm
    // loops which previously caused GPU driver compilation hangs. Safe mode is enabled by
    // default; full rain effects can be re-enabled via localStorage if needed.
    const enableWaterBaseline = (() => {
      // Allow disabling water pass if needed (e.g., for debugging other issues):
      //   localStorage.setItem('msa-disable-v2-water-baseline', '1')
      // Re-enable:
      //   localStorage.removeItem('msa-disable-v2-water-baseline')
      try { return globalThis.localStorage?.getItem?.('msa-disable-v2-water-baseline') !== '1'; } catch (_) { return true; }
    })();

    if (enableWaterBaseline && this._waterEffect?.enabled) {
      // Build occluder mask for the *currently viewed* floor.
      // If on floor 0, no occluder needed.
      let occluderRT = null;
      try {
        const viewFloor = window.MapShine?.floorStack?.getActiveFloor()?.index ?? 0;
        if (viewFloor > 0 && this._waterOccluderRT) {
          this._renderBus.renderFloorMaskTo(this.renderer, this.camera, viewFloor, this._waterOccluderRT);
          occluderRT = this._waterOccluderRT;
        }
      } catch (_) {}

      const waterOutput = (currentInput === this._postA) ? this._postB : this._postA;
      if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: water.render (baseline)'); } catch (_) {} }
      const waterWrote = this._waterEffect.render(this.renderer, this.camera, currentInput, waterOutput, occluderRT);
      if (waterWrote) currentInput = waterOutput;
      if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: water.render (baseline) DONE'); } catch (_) {} }
    }

    // Jump straight to blit
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: blitToScreen'); } catch (_) {} }
    this._blitToScreen(currentInput);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: blitToScreen DONE'); } catch (_) {} }

    // ── Fog of War overlay pass ─────────────────────────────────────────
    // Render fog AFTER the final blit. This overlays the already-lit scene
    // with the fog plane (transparent shader). We must NOT clear the screen.
    if (this._fogEffect && this._fogScene && this._fogEffect.enabled && this._fogEffect.params?.enabled !== false) {
      try {
        const renderer = this.renderer;
        const prevTarget = renderer.getRenderTarget();
        const prevAutoClear = renderer.autoClear;
        const prevLayerMask = this.camera.layers.mask;

        // Ensure the fog plane's layer is visible.
        this.camera.layers.enableAll();

        renderer.setRenderTarget(null);
        renderer.autoClear = false;
        renderer.render(this._fogScene, this.camera);

        this.camera.layers.mask = prevLayerMask;
        renderer.autoClear = prevAutoClear;
        renderer.setRenderTarget(prevTarget);
      } catch (err) {
        log.warn('FloorCompositor: fog overlay render failed:', err);
      }
    }
    
    if (_dbgStages) {
      this._debugFirstFrameStagesLogged = true;
      try { log.info('[V2 Frame] ✔ FloorCompositor.render: END (baseline mode)'); } catch (_) {}
    }
    return;

    // ═══════════════════════════════════════════════════════════════════════
    // POST-PROCESSING DISABLED - ALL CODE BELOW IS UNREACHABLE
    // ═══════════════════════════════════════════════════════════════════════

    // Sky color grading pass (time-of-day atmospheric grading). Ping-pongs.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: skyColor.render'); } catch (_) {} }
    if (this._skyColorEffect.params.enabled) {
      const skyOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._skyColorEffect.render(this.renderer, currentInput, skyOutput);
      currentInput = skyOutput;
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: skyColor.render DONE'); } catch (_) {} }

    // Color correction pass: global user-authored grade (exposure, contrast, saturation, etc.).
    // Ping-pongs: whichever is current → the other.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: colorCorrection.render'); } catch (_) {} }
    if (this._colorCorrectionEffect.params.enabled) {
      const ccOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._colorCorrectionEffect.render(this.renderer, currentInput, ccOutput);
      currentInput = ccOutput;
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: colorCorrection.render DONE'); } catch (_) {} }

    // Filter pass: multiplicative overlay (ink AO / multiply tint). Runs after
    // color correction and before water/bloom.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: filter.render'); } catch (_) {} }
    if (this._filterEffect.enabled && this._filterEffect.params.enabled) {
      const fOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._filterEffect.render(this.renderer, currentInput, fOutput);
      currentInput = fOutput;
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: filter.render DONE'); } catch (_) {} }

    // Feed sky state into water (specular tint + live sun direction) after sky+CC have updated.
    // Water runs after grading so caustics/specular add onto the final image and bloom can pick them up.
    try {
      const sky = this._skyColorEffect;
      const tint = sky?.currentSkyTintColor;
      if (tint && typeof this._waterEffect?.setSkyColor === 'function') {
        this._waterEffect.setSkyColor(tint.r, tint.g, tint.b);
      }
      const skyIntensity01 = sky?._composeMaterial?.uniforms?.uIntensity?.value;
      if (typeof this._waterEffect?.setSkyIntensity01 === 'function' && Number.isFinite(skyIntensity01)) {
        this._waterEffect.setSkyIntensity01(skyIntensity01);
      }
      // Drive specular sun direction from live time-of-day so the highlight
      // angle changes as the sun moves across the sky.
      if (sky && typeof this._waterEffect?.setSunAngles === 'function') {
        this._waterEffect.setSunAngles(sky.currentSunAzimuthDeg, sky.currentSunElevationDeg);
      }
    } catch (_) {}

    // Water pass: refracts/tints/specular the fully graded scene.
    // Occlusion is handled via a deterministic occluder mask (upper floor tiles)
    // plus depth pass fallback inside the shader.
    if (this._waterEffect?.enabled) {
      // Build occluder mask for the *currently viewed* floor.
      // If on floor 0, no occluder needed.
      let occluderRT = null;
      try {
        const viewFloor = window.MapShine?.floorStack?.getActiveFloor()?.index ?? 0;
        if (viewFloor > 0 && this._waterOccluderRT) {
          this._renderBus.renderFloorMaskTo(this.renderer, this.camera, viewFloor, this._waterOccluderRT);
          occluderRT = this._waterOccluderRT;
        }
      } catch (_) {}

      const waterOutput = (currentInput === this._postA) ? this._postB : this._postA;
      // render() returns true if it wrote to waterOutput, false if it returned early.
      // Only advance currentInput when the pass actually ran — otherwise waterOutput
      // is an unwritten (black) RT and advancing would black out the entire scene.
      if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: water.render'); } catch (_) {} }
      const waterWrote = this._waterEffect.render(this.renderer, this.camera, currentInput, waterOutput, occluderRT);
      if (waterWrote) currentInput = waterOutput;
      if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: water.render DONE'); } catch (_) {} }
    }

    // Bloom pass: screen-space glow (threshold → mip blur → additive composite).
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: bloom.render'); } catch (_) {} }
    if (this._bloomEffect.params.enabled) {
      const bloomOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._bloomEffect.render(this.renderer, currentInput, bloomOutput);
      currentInput = bloomOutput;
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: bloom.render DONE'); } catch (_) {} }

    // Cloud-top blit: alpha-over after the full post chain (sky, CC, water, bloom).
    // Placed here so cloud tops are never refracted by water, never double-graded
    // by sky-color/CC, and sit visually above everything except grain and sharpen.
    // bloom has already run so cloud edges can still receive glow via the bloom
    // pass below, while cloud tops themselves remain crisp and unaffected.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: cloudTops.blit'); } catch (_) {} }
    if (this._cloudEffect.enabled && this._cloudEffect.params.enabled) {
      this._cloudEffect.blitCloudTops(this.renderer, currentInput);
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: cloudTops.blit DONE'); } catch (_) {} }

    // Film grain pass (disabled by default — optional artistic effect).
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: filmGrain.render'); } catch (_) {} }
    if (this._filmGrainEffect.params.enabled) {
      const fgOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._filmGrainEffect.render(this.renderer, currentInput, fgOutput);
      currentInput = fgOutput;
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: filmGrain.render DONE'); } catch (_) {} }

    // Sharpen pass (disabled by default — optional artistic effect).
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: sharpen.render'); } catch (_) {} }
    if (this._sharpenEffect.params.enabled) {
      const shOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._sharpenEffect.render(this.renderer, currentInput, shOutput);
      currentInput = shOutput;
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: sharpen.render DONE'); } catch (_) {} }

    // ── Step 3: Blit final result to screen ──────────────────────────────
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: blitToScreen'); } catch (_) {} }
    this._blitToScreen(currentInput);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: blitToScreen DONE'); } catch (_) {} }

    if (_dbgStages) {
      this._debugFirstFrameStagesLogged = true;
      try { log.info('[V2 Frame] ✔ FloorCompositor.render: END'); } catch (_) {}
    }
  }

  /**
   * Blit a render target's colour attachment to the screen framebuffer.
   * @param {THREE.WebGLRenderTarget} sourceRT
   * @private
   */
  _blitToScreen(sourceRT) {
    if (!this._blitMaterial || !sourceRT) return;
    const renderer = this.renderer;

    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const THREE = window.THREE;
    const prevClearColor = (THREE && typeof renderer.getClearColor === 'function')
      ? renderer.getClearColor(new THREE.Color())
      : null;
    const prevClearAlpha = (typeof renderer.getClearAlpha === 'function')
      ? renderer.getClearAlpha()
      : null;

    this._blitMaterial.uniforms.tDiffuse.value = sourceRT.texture;
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    try {
      // Ensure an opaque clear. If the renderer's clearAlpha is 0, the blit quad
      // can appear semi-transparent over underlying canvases/frames.
      if (typeof renderer.setClearColor === 'function') {
        renderer.setClearColor(0x000000, 1);
      }
      if (typeof renderer.setClearAlpha === 'function') {
        renderer.setClearAlpha(1);
      }
      if (typeof renderer.clear === 'function') {
        renderer.clear(true, true, true);
      }
      renderer.render(this._blitScene, this._blitCamera);
    } finally {
      // CRITICAL (V2): do not restore a transparent clear alpha.
      // If we restore clearAlpha=0 here, the renderer ends the frame in a
      // transparent state and the canvas can show underlying stale content.
      if (prevClearColor && typeof renderer.setClearColor === 'function') {
        try {
          renderer.setClearColor(prevClearColor, 1);
        } catch (_) {}
      }
      if (typeof renderer.setClearAlpha === 'function') {
        try { renderer.setClearAlpha(1); } catch (_) {}
      }
    }

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  /**
   * Apply a single saved parameter to the named effect.
   *
   * This is called by EffectComposer immediately after lazy creation to replay
   * all params that the Tweakpane UI already loaded from scene flags — because
   * the UI fires its initial callbacks before the FloorCompositor exists.
   *
   * Mirrors the logic of `_propagateToV2` in canvas-replacement.js.
   *
   * @param {string} effectKey - Property name on FloorCompositor (e.g. '_lightingEffect')
   * @param {string} paramId   - Parameter key (e.g. 'intensity')
   * @param {*}      value     - Value to apply
   */
  applyParam(effectKey, paramId, value) {
    try {
      const effect = this[effectKey];
      if (!effect) return;

      // 'enabled' / 'masterEnabled': use the getter/setter when the effect has
      // a proper accessor (backed by _enabled). Effects like WaterEffectV2 use
      // a plain `this.enabled` property as a render-pass gate — writing false
      // to that would silently disable the entire pass. Detect accessor vs plain
      // property by checking whether the prototype defines a getter.
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        const proto = Object.getPrototypeOf(effect);
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'enabled') : null;
        const hasAccessor = descriptor && typeof descriptor.get === 'function';
        if (hasAccessor) {
          // Proper getter/setter — use it so internal state (uniform, _enabled) stays in sync.
          try { effect.enabled = !!value; } catch (_) {}
        }
        // Also update params.enabled if the effect exposes it, so update() picks it up.
        if (effect.params && Object.prototype.hasOwnProperty.call(effect.params, 'enabled')) {
          effect.params.enabled = !!value;
        }
        return;
      }

      if (effect.params && Object.prototype.hasOwnProperty.call(effect.params, paramId)) {
        effect.params[paramId] = value;
      }
    } catch (_) {}
  }

  // ── Floor Visibility ──────────────────────────────────────────────────────

  /**
   * Called when the active floor/level changes via the mapShineLevelContextChanged hook.
   * @param {object} payload - Hook payload from CameraFollower._emitLevelContextChanged
   * @private
   */
  _onLevelContextChanged(payload) {
    if (!this._busPopulated) return;
    this._applyCurrentFloorVisibility(payload);
  }

  /**
   * Read the current active floor index from FloorStack and apply it to the bus.
   * @private
   */
  _applyCurrentFloorVisibility(payload = null) {
    const floorStack = window.MapShine?.floorStack;
    if (!floorStack) return;

    // Prefer the hook payload's active level band (authoritative) to avoid
    // getting stuck when FloorStack.activeFloorIndex wasn't updated elsewhere.
    // CameraFollower._emitLevelContextChanged updates window.MapShine.activeLevelContext
    // then fires this hook with { context:{bottom,top}, ... }.
    try {
      const ctx = payload?.context ?? window.MapShine?.activeLevelContext ?? null;
      const floors = floorStack.getFloors?.() ?? [];
      const b = Number(ctx?.bottom);
      const t = Number(ctx?.top);
      if (floors.length > 1 && Number.isFinite(b) && Number.isFinite(t)) {
        const mid = (b + t) / 2;
        let bestIdx = 0;
        for (let i = 0; i < floors.length; i++) {
          const f = floors[i];
          if (Number(f?.elevationMin) === b && Number(f?.elevationMax) === t) {
            bestIdx = i;
            break;
          }
          if (mid >= Number(f?.elevationMin) && mid <= Number(f?.elevationMax)) {
            bestIdx = i;
          }
        }
        floorStack.setActiveFloor(bestIdx);
      }
    } catch (_) {}

    const activeFloor = floorStack.getActiveFloor();
    // IMPORTANT: never fall back to Infinity here. Several effects (including
    // BuildingShadowsEffectV2) treat non-finite floor indices as "floor 0" to
    // avoid infinite loops, which would make the effect appear stuck on the
    // ground-floor state.
    const maxFloorIndex = Number.isFinite(activeFloor?.index) ? activeFloor.index : 0;
    if (!Number.isFinite(activeFloor?.index)) {
      log.info('FloorCompositor: activeFloor.index missing; falling back to 0', activeFloor);
    } else {
      log.info(`FloorCompositor: active floor index = ${maxFloorIndex}`);
    }
    this._renderBus.setVisibleFloors(maxFloorIndex);
    // Notify fire effect of floor change so it can swap active particle systems.
    this._fireEffect.onFloorChange(maxFloorIndex);
    // Notify water splashes of floor change so it can swap active systems.
    try { this._waterSplashesEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Notify ash disturbance so it can swap active burst system sets.
    try { this._ashDisturbanceEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Update window light overlay visibility (isolated scene, not bus-managed).
    this._windowLightEffect.onFloorChange(maxFloorIndex);
    // Cloud effect: blocker pass is automatically floor-isolated via bus visibility;
    // no extra state needed, but notify for any future floor-aware work.
    this._cloudEffect.onFloorChange(maxFloorIndex);
    // Weather particles are global (rain falls on all visible floors); no-op.
    try { this._weatherParticles?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Swap active outdoors mask for the new floor (notifies all consumers).
    try { this._outdoorsMask?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Swap active water SDF data for the new floor.
    try { this._waterEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Building shadows: rebuild union mask for the new floor set.
    try { this._buildingShadowEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    log.info(`FloorCompositor: visibility set to floors 0–${maxFloorIndex}`);
  }

  /**
   * External resize handler — call when the viewport size changes.
   * @param {number} width
   * @param {number} height
   */
  onResize(width, height) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (this._sceneRT) this._sceneRT.setSize(w, h);
    if (this._postA)   this._postA.setSize(w, h);
    if (this._postB)   this._postB.setSize(w, h);
    if (this._waterOccluderRT) this._waterOccluderRT.setSize(w, h);
    this._cloudEffect.onResize(w, h);
    this._lightingEffect.onResize(w, h);
    this._bloomEffect.onResize(w, h);
    try { this._overheadShadowEffect?.onResize?.(w, h); } catch (_) {}
    try { this._weatherParticles?.onResize?.(w, h); } catch (_) {}
    try { this._fogEffect?.resize?.(w, h); } catch (_) {}
    log.debug(`FloorCompositor.onResize: RTs resized to ${w}x${h}`);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  /**
   * Dispose all GPU resources. Call on scene teardown.
   */
  dispose() {
    const THREE = window.THREE;

    // Unhook level changes.
    if (this._levelHookId) {
      try { Hooks.off('mapShineLevelContextChanged', this._levelHookId); } catch (_) {}
      this._levelHookId = null;
    }

    // Effects
    try { this._specularEffect?.dispose?.(); } catch (_) {}
    try { this._fluidEffect?.dispose?.(); } catch (_) {}
    try { this._fireEffect?.dispose?.(); } catch (_) {}
    try { this._windowLightEffect?.dispose?.(); } catch (_) {}
    try { this._cloudEffect?.dispose?.(); } catch (_) {}
    try { this._lightingEffect?.dispose?.(); } catch (_) {}
    try { this._skyColorEffect?.dispose?.(); } catch (_) {}
    try { this._bloomEffect.dispose(); } catch (_) {}
    try { this._colorCorrectionEffect.dispose(); } catch (_) {}
    try { this._skyColorEffect.dispose(); } catch (_) {}
    try { this._lightingEffect.dispose(); } catch (_) {}
    try { this._overheadShadowEffect?.dispose?.(); } catch (_) {}
    try { this._fireEffect.dispose(); } catch (_) {}
    try { this._specularEffect.dispose(); } catch (_) {}
    try { this._windowLightEffect.dispose(); } catch (_) {}
    try { this._fogEffect?.dispose?.(); } catch (_) {}
    try { this._renderBus?.dispose?.(); } catch (_) {}
    this._busPopulated = false;

    // Dispose render targets.
    try { this._sceneRT?.dispose(); } catch (_) {}
    try { this._postA?.dispose(); } catch (_) {}
    try { this._postB?.dispose(); } catch (_) {}
    try { this._waterOccluderRT?.dispose(); } catch (_) {}
    this._sceneRT = null;
    this._postA = null;
    this._postB = null;
    this._waterOccluderRT = null;

    // Dispose blit resources.
    try { this._blitMaterial?.dispose(); } catch (_) {}
    try { this._blitQuad?.geometry?.dispose(); } catch (_) {}
    this._blitScene = null;
    this._blitCamera = null;
    this._blitMaterial = null;
    this._blitQuad = null;

    this._fogEffect = null;
    this._fogScene = null;

    // Unregister the level-change hook.
    if (this._levelHookId !== null) {
      try { Hooks.off('mapShineLevelContextChanged', this._levelHookId); } catch (_) {}
      this._levelHookId = null;
    }

    this._initialized = false;
    log.info('FloorCompositor disposed');
  }
}
