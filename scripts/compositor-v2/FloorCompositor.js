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
 *   - **WeatherParticlesV2**: Rain, snow, ash, foam, and splash particles via
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
import { WaterEffectV2 } from './effects/WaterEffectV2.js';
import { CloudEffectV2 } from './effects/CloudEffectV2.js';
import { WeatherParticlesV2 } from './effects/WeatherParticlesV2.js';
import { OutdoorsMaskProviderV2 } from './effects/OutdoorsMaskProviderV2.js';
import { BuildingShadowsEffectV2 } from './effects/BuildingShadowsEffectV2.js';
import { weatherController } from '../core/WeatherController.js';

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

    /**
     * V2 Water Effect: screen-space water post-processing pass driven by
     * `_Water` mask textures. Runs after lighting (refracts the lit scene),
     * before sky color grading.
     * @type {WaterEffectV2}
     */
    this._waterEffect = new WaterEffectV2();

    /**
     * V2 Weather Particles: rain, snow, ash, foam, and rain-splash particles.
     * Wraps the V1 WeatherParticles class using a shared BatchedRenderer that
     * lives in the FloorRenderBus scene. Also drives WeatherController.update()
     * each frame so weather state is live in V2.
     * @type {WeatherParticlesV2}
     */
    this._weatherParticles = new WeatherParticlesV2();

    /**
     * V2 Outdoors mask provider: discovers _Outdoors tiles per floor, composites
     * them into a scene-UV canvas texture, and notifies all consumers (cloud shadow,
     * water indoor damping, weather particle roof gating).
     * @type {OutdoorsMaskProviderV2}
     */
    this._outdoorsMask = new OutdoorsMaskProviderV2();

    /**
     * V2 Building Shadows Effect: bakes a greyscale shadow-factor texture from the
     * union of all _Outdoors masks up to the active floor. Fed into LightingEffectV2
     * as `tBuildingShadow`.
     * @type {BuildingShadowsEffectV2}
     */
    this._buildingShadowEffect = new BuildingShadowsEffectV2();

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

    /** @type {THREE.Scene|null} Dedicated scene for fullscreen blit quad */
    this._blitScene = null;
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
    // HalfFloat for HDR headroom (additive specular/window light can exceed 1.0).
    //
    // IMPORTANT: All intermediate RTs must use LinearSRGBColorSpace so that
    // Three.js does NOT apply sRGB encoding on write or decoding on read.
    // With renderer.outputColorSpace = SRGBColorSpace, Three.js would otherwise
    // gamma-compress every render-to-RT, causing post-processing shaders to
    // receive sRGB-encoded values where additive operations (caustics, window
    // light, specular) produce grey mist instead of bright light.
    // The sRGB encode happens exactly once: in the final blit to the screen
    // framebuffer (null render target).
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    };
    this._sceneRT = new THREE.WebGLRenderTarget(w, h, rtOpts);
    this._sceneRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    // Ping-pong pair for post-processing chain. No depth needed for post passes.
    const postOpts = { ...rtOpts, depthBuffer: false };
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
          gl_FragColor = texture2D(tDiffuse, vUv);
        }
      `,
      depthTest: false,
      depthWrite: false,
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
    this._fireEffect.initialize();
    this._windowLightEffect.initialize();
    // Cloud effect needs the bus scene and main camera for the overhead blocker pass.
    this._cloudEffect.initialize(this.renderer, this._renderBus._scene, this.camera);
    // Weather particles live in the bus scene so they render in the same pass as tiles.
    this._weatherParticles.initialize(this._renderBus._scene);

    // Subscribe outdoors mask consumers so they receive the texture as soon as
    // populate() builds it, and again on every floor change.
    // CloudEffectV2: cloud shadows and cloud tops only fall on outdoor areas.
    // We set both the legacy single-texture path (setOutdoorsMask, which is the one
    // actually sampled since V2 has no floorIdTarget) AND the per-floor array so the
    // multi-floor path is ready if a floorIdTexture is ever wired up.
    this._outdoorsMask.subscribe((tex) => {
      try {
        this._cloudEffect.setOutdoorsMask(tex);
        this._cloudEffect.setOutdoorsMasks(this._outdoorsMask.getFloorTextureArray(4));
      } catch (_) {}
    });
    // WaterEffectV2: wave/rain indoor damping.
    this._outdoorsMask.subscribe((tex) => {
      try { this._waterEffect.setOutdoorsMask(tex); } catch (_) {}
    });
    // WeatherController: particle foam fleck roof gating (roofMap CPU readback).
    this._outdoorsMask.subscribe((tex) => {
      try { if (weatherController?.initialized) weatherController.setRoofMap(tex ?? null); } catch (_) {}
    });

    this._lightingEffect.initialize(w, h);
    this._skyColorEffect.initialize();
    this._colorCorrectionEffect.initialize();
    this._bloomEffect.initialize(w, h);
    this._filmGrainEffect.initialize();
    this._sharpenEffect.initialize();
    this._waterEffect.initialize();
    this._buildingShadowEffect.initialize(this.renderer);
    // Register the outdoors mask provider so building shadows can union-composite
    // per-floor canvases. The provider fires the callback immediately (even if not
    // yet populated) so the effect sets up its subscription before populate() runs.
    this._buildingShadowEffect.setOutdoorsMaskProvider(this._outdoorsMask);

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
      const fire = this._fireEffect;
      if (!fire || !fire.enabled) return false;
      // If any floors are active, we have live particle systems that should
      // animate smoothly (not at idle FPS).
      if (fire._activeFloors && fire._activeFloors.size > 0) return true;
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
        this._waterEffect.populate(sc.foundrySceneData).then(() => {
          this._applyCurrentFloorVisibility();
        }).catch(err => {
          log.error('WaterEffectV2 populate failed:', err);
        });
        // Populate outdoors mask (discovers _Outdoors tiles, notifies all consumers).
        this._outdoorsMask.populate(sc.foundrySceneData).catch(err => {
          log.error('OutdoorsMaskProviderV2 populate failed:', err);
        });
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
      this._fireEffect.update(timeInfo);
      this._windowLightEffect.update(timeInfo);
      this._cloudEffect.update(timeInfo);
      this._lightingEffect.update(timeInfo);
      // Weather particles must update BEFORE the bus render so their BatchedRenderer
      // positions are current when the bus scene is drawn this frame.
      this._weatherParticles.update(timeInfo);
      this._waterEffect.update(timeInfo);
      this._skyColorEffect.update(timeInfo);
      this._colorCorrectionEffect.update(timeInfo);
      this._bloomEffect.update(timeInfo);
      this._filmGrainEffect.update(timeInfo);
      this._sharpenEffect.update(timeInfo);
      // Building shadows: update sun direction + bake hash. Must run after
      // sky color so sun angles are current before being fed to the shadow effect.
      this._buildingShadowEffect.update(timeInfo);
    }

    // ── Bind per-frame textures and camera to effects ────────────────────────
    this._specularEffect.render(this.renderer, this.camera);

    // Feed live sun angles from SkyColorEffectV2 into building shadows
    // so both systems share the same sun direction (single source of truth).
    try {
      const sky = this._skyColorEffect;
      if (sky && typeof sky.currentSunAzimuthDeg === 'number') {
        this._buildingShadowEffect.setSunAngles(
          sky.currentSunAzimuthDeg,
          sky.currentSunElevationDeg ?? 45
        );
      }
    } catch (_) {}

    // Bake building shadow map if needed (triggered by sun change or floor change).
    this._buildingShadowEffect.render(this.renderer);

    // ── Step 1: Render bus scene → sceneRT ───────────────────────────────
    // The bus scene contains albedo tiles + specular/fire overlays.
    // Window light is NOT in the bus scene — it renders after lighting.
    this._renderBus.renderTo(this.renderer, this.camera, this._sceneRT);

    // ...
    // ── Cloud passes (before lighting) ───────────────────────────────────
    // Must run after bus render so the blocker pass sees current tile visibility.
    // Outputs: _cloudEffect.cloudShadowTexture (fed into lighting compose shader)
    //          _cloudEffect._cloudTopRT        (blitted after lighting)
    if (this._cloudEffect.enabled && this._cloudEffect.params.enabled) {
      this._cloudEffect.render(this.renderer);
    }

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
    const buildingShadowTex = (this._buildingShadowEffect.params.enabled)
      ? this._buildingShadowEffect.shadowFactorTexture : null;
    this._lightingEffect.render(this.renderer, this.camera, currentInput, this._postA, winScene, cloudShadowTex, buildingShadowTex);

    // Feed live cloud shadow into WaterEffectV2 so caustics/specular are
    // correctly suppressed under cloud cover. Must be set before water renders.
    // cloudShadowTex is already a THREE.Texture|null from the getter.
    try { this._waterEffect.setCloudShadowTexture(cloudShadowTex ?? null); } catch (_) {}
    currentInput = this._postA;

    // Sky color grading pass (time-of-day atmospheric grading). Ping-pongs.
    if (this._skyColorEffect.params.enabled) {
      const skyOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._skyColorEffect.render(this.renderer, currentInput, skyOutput);
      currentInput = skyOutput;
    }

    // Color correction pass: global user-authored grade (exposure, contrast, saturation, etc.).
    // Ping-pongs: whichever is current → the other.
    if (this._colorCorrectionEffect.params.enabled) {
      const ccOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._colorCorrectionEffect.render(this.renderer, currentInput, ccOutput);
      currentInput = ccOutput;
    }

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
    if (this._waterEffect.enabled) {
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
      const waterWrote = this._waterEffect.render(this.renderer, this.camera, currentInput, waterOutput, occluderRT);
      if (waterWrote) currentInput = waterOutput;
    }

    // Bloom pass: screen-space glow (threshold → mip blur → additive composite).
    if (this._bloomEffect.params.enabled) {
      const bloomOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._bloomEffect.render(this.renderer, currentInput, bloomOutput);
      currentInput = bloomOutput;
    }

    // Cloud-top blit: alpha-over after the full post chain (sky, CC, water, bloom).
    // Placed here so cloud tops are never refracted by water, never double-graded
    // by sky-color/CC, and sit visually above everything except grain and sharpen.
    // bloom has already run so cloud edges can still receive glow via the bloom
    // pass below, while cloud tops themselves remain crisp and unaffected.
    if (this._cloudEffect.enabled && this._cloudEffect.params.enabled) {
      this._cloudEffect.blitCloudTops(this.renderer, currentInput);
    }

    // Film grain pass (disabled by default — optional artistic effect).
    if (this._filmGrainEffect.params.enabled) {
      const fgOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._filmGrainEffect.render(this.renderer, currentInput, fgOutput);
      currentInput = fgOutput;
    }

    // Sharpen pass (disabled by default — optional artistic effect).
    if (this._sharpenEffect.params.enabled) {
      const shOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._sharpenEffect.render(this.renderer, currentInput, shOutput);
      currentInput = shOutput;
    }

    // ── Step 3: Blit final result to screen ──────────────────────────────
    this._blitToScreen(currentInput);
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

    this._blitMaterial.uniforms.tDiffuse.value = sourceRT.texture;
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    renderer.render(this._blitScene, this._blitCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  // ── Settings Replay ───────────────────────────────────────────────────────

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
    // Update window light overlay visibility (isolated scene, not bus-managed).
    this._windowLightEffect.onFloorChange(maxFloorIndex);
    // Cloud effect: blocker pass is automatically floor-isolated via bus visibility;
    // no extra state needed, but notify for any future floor-aware work.
    this._cloudEffect.onFloorChange(maxFloorIndex);
    // Weather particles are global (rain falls on all visible floors); no-op.
    this._weatherParticles.onFloorChange(maxFloorIndex);
    // Swap active outdoors mask for the new floor (notifies all consumers).
    this._outdoorsMask.onFloorChange(maxFloorIndex);
    // Swap active water SDF data for the new floor.
    this._waterEffect.onFloorChange(maxFloorIndex);
    // Building shadows: rebuild union mask for the new floor set.
    this._buildingShadowEffect.onFloorChange(maxFloorIndex);
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
    this._weatherParticles.onResize(w, h);
    log.debug(`FloorCompositor.onResize: RTs resized to ${w}x${h}`);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  /**
   * Dispose all GPU resources. Call on scene teardown.
   */
  dispose() {
    try { this._cloudEffect.dispose(); } catch (_) {}
    try { this._weatherParticles.dispose(); } catch (_) {}
    try { this._outdoorsMask.dispose(); } catch (_) {}
    try { this._buildingShadowEffect.dispose(); } catch (_) {}
    try { this._waterEffect.dispose(); } catch (_) {}
    try { this._sharpenEffect.dispose(); } catch (_) {}
    try { this._filmGrainEffect.dispose(); } catch (_) {}
    try { this._bloomEffect.dispose(); } catch (_) {}
    try { this._colorCorrectionEffect.dispose(); } catch (_) {}
    try { this._skyColorEffect.dispose(); } catch (_) {}
    try { this._lightingEffect.dispose(); } catch (_) {}
    try { this._fireEffect.dispose(); } catch (_) {}
    try { this._specularEffect.dispose(); } catch (_) {}
    try { this._windowLightEffect.dispose(); } catch (_) {}
    try { this._renderBus.dispose(); } catch (_) {}
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

    // Unregister the level-change hook.
    if (this._levelHookId !== null) {
      try { Hooks.off('mapShineLevelContextChanged', this._levelHookId); } catch (_) {}
      this._levelHookId = null;
    }

    this._initialized = false;
    log.info('FloorCompositor disposed');
  }
}
