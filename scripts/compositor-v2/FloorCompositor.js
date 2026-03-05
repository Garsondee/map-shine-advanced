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
 * Called by EffectComposer.render() in the V2-only runtime.
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
import { BushEffectV2 } from './effects/BushEffectV2.js';
import { TreeEffectV2 } from './effects/TreeEffectV2.js';
import { OverheadShadowsEffectV2 } from './effects/OverheadShadowsEffectV2.js';
import { BuildingShadowsEffectV2 } from './effects/BuildingShadowsEffectV2.js';
import { DotScreenEffectV2 } from './effects/DotScreenEffectV2.js';
import { HalftoneEffectV2 } from './effects/HalftoneEffectV2.js';
import { AsciiEffectV2 } from './effects/AsciiEffectV2.js';
import { DazzleOverlayEffectV2 } from './effects/DazzleOverlayEffectV2.js';
import { VisionModeEffectV2 } from './effects/VisionModeEffectV2.js';
import { InvertEffectV2 } from './effects/InvertEffectV2.js';
import { SepiaEffectV2 } from './effects/SepiaEffectV2.js';
import { LightningEffectV2 } from './effects/LightningEffectV2.js';
import { AtmosphericFogEffectV2 } from './effects/AtmosphericFogEffectV2.js';
import { FogOfWarEffectV2 } from './effects/FogOfWarEffectV2.js';
import { SmellyFliesEffect } from '../particles/SmellyFliesEffect.js';
import { CandleFlamesEffectV2 } from './effects/CandleFlamesEffectV2.js';
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
     * V2 Fluid Effect: per-tile animated fluid overlays driven by _Fluid masks.
     * Overlays live in the bus scene and are floor-visible via the bus.
     * @type {FluidEffectV2}
     */
    this._fluidEffect = new FluidEffectV2(this._renderBus);

    /**
     * V2 Bush Effect: animated per-tile overlays driven by _Bush masks.
     * Overlays live in the bus scene and are floor-visible via the bus.
     * @type {BushEffectV2}
     */
    this._bushEffect = new BushEffectV2(this._renderBus);

    /**
     * V2 Tree Effect: animated high-canopy overlays driven by _Tree masks.
     * Overlays live in the bus scene and are floor-visible via the bus.
     * @type {TreeEffectV2}
     */
    this._treeEffect = new TreeEffectV2(this._renderBus);

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
     * V2 Atmospheric Fog Effect: weather-driven distance fog as a post-process
     * pass. Runs after water and before bloom.
     * @type {AtmosphericFogEffectV2}
     */
    this._atmosphericFogEffect = new AtmosphericFogEffectV2();

    /**
     * V2 Fog of War: gameplay LOS + exploration fog overlay.
     * Updated as an effect state machine, then rendered once as a dedicated
     * fullscreen overlay scene after final post blit.
     * @type {FogOfWarEffectV2}
     */
    this._fogEffect = new FogOfWarEffectV2();

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
     * V2 Water Effect: fullscreen post-process surface driven by composited _Water
     * masks (background + tiles). Renders in the post chain.
     * @type {WaterEffectV2}
     */
    this._waterEffect = new WaterEffectV2();

    /**
     * V2 Water Splashes Effect: per-floor foam plume + rain splash particle
     * systems driven by _Water masks. Own BatchedRenderer in the bus scene.
     * Replaces the legacy foam bridge (WaterEffectV2 → WeatherParticles).
     * @type {WaterSplashesEffectV2}
     */
    this._waterSplashesEffect = new WaterSplashesEffectV2(this._renderBus);

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
    this._weatherParticles = new WeatherParticlesV2();

    /**
     * V2 Ash Disturbance Effect: token-movement driven ash bursts from _Ash masks.
     * Own BatchedRenderer lives in the bus scene.
     * @type {AshDisturbanceEffectV2}
     */
    this._ashDisturbanceEffect = new AshDisturbanceEffectV2(this._renderBus);

    /**
     * V2 Smelly Flies Effect: map-point-driven ambient fly swarms.
     * Uses Quarks systems that render in the bus scene through the shared
     * weather/particles batch renderer bridge.
     * @type {SmellyFliesEffect}
     */
    this._smellyFliesEffect = new SmellyFliesEffect();

    /**
     * V2 Lightning Effect: map-point-driven atmospheric lightning arcs +
     * environment flash metadata for downstream post effects.
     * @type {LightningEffectV2}
     */
    this._lightningEffect = new LightningEffectV2();

    /**
     * V2 Candle Flames Effect: map-point-driven instanced flames + light-scene glow.
     * Global-scoped effect (not floor-isolated).
     * @type {CandleFlamesEffectV2}
     */
    this._candleFlamesEffect = new CandleFlamesEffectV2();

    // Outdoors mask is now provided by EffectMaskRegistry (central asset system)

    /**
     * V2 Overhead Shadows Effect: per-frame soft shadow cast by overhead tiles
     * (tileDoc.overhead === true) onto the scene below. Fed into LightingEffectV2
     * as `tOverheadShadow` — dims ambient only, dynamic lights punch through.
     * @type {OverheadShadowsEffectV2}
     */
    this._overheadShadowEffect = new OverheadShadowsEffectV2(this._renderBus);

    /**
     * V2 Building Shadows Effect: projects _Outdoors dark regions (building footprints)
     * along sun direction and combines all upper floors into one scene-space shadow map.
     * Fed into LightingEffectV2 as `tBuildingShadow`.
     * @type {BuildingShadowsEffectV2}
     */
    this._buildingShadowEffect = new BuildingShadowsEffectV2();

    /**
     * V2 Dot Screen Effect: artistic dot-screen halftone filter.
     * Post-processing pass. Disabled by default.
     * @type {DotScreenEffectV2}
     */
    this._dotScreenEffect = new DotScreenEffectV2();

    /**
     * V2 Halftone Effect: CMYK halftone printing effect.
     * Post-processing pass. Disabled by default.
     * @type {HalftoneEffectV2}
     */
    this._halftoneEffect = new HalftoneEffectV2();

    /**
     * V2 ASCII Effect: shader-based ASCII art post-processing effect.
     * Disabled by default.
     * @type {AsciiEffectV2}
     */
    this._asciiEffect = new AsciiEffectV2();

    /**
     * V2 Dazzle Overlay Effect: bright light exposure overlay.
     * Post-processing pass. Disabled by default (enabled by DynamicExposureManager).
     * @type {DazzleOverlayEffectV2}
     */
    this._dazzleOverlayEffect = new DazzleOverlayEffectV2();

    /**
     * V2 Vision Mode Effect: vision mode post-processing adjustments.
     * Post-processing pass. Enabled by default.
     * @type {VisionModeEffectV2}
     */
    this._visionModeEffect = new VisionModeEffectV2();

    /**
     * V2 Invert Effect: color inversion effect.
     * Post-processing pass. Disabled by default.
     * @type {InvertEffectV2}
     */
    this._invertEffect = new InvertEffectV2();

    /**
     * V2 Sepia Effect: sepia tone color grading.
     * Post-processing pass. Disabled by default.
     * @type {SepiaEffectV2}
     */
    this._sepiaEffect = new SepiaEffectV2();

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

    /** @type {THREE.Texture|null} Last outdoors mask pushed to V2 consumers */
    this._lastOutdoorsTexture = null;

    /** @type {string|null} Last resolved floor key used for outdoors sync diagnostics */
    this._lastOutdoorsFloorKey = null;

    /** @type {import('../scene/map-points-manager.js').MapPointsManager|null} Last wired map-points manager instance */
    this._wiredMapPointsManager = null;

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

    /** @type {THREE.Scene|null} Dedicated scene for fullscreen blit quad */
    this._blitScene  = null;
    /** @type {THREE.OrthographicCamera|null} Camera for blit renders */
    this._blitCamera = null;
    /** @type {THREE.ShaderMaterial|null} Simple passthrough blit material */
    this._blitMaterial = null;
    /** @type {THREE.Mesh|null} Fullscreen quad for blit */
    this._blitQuad = null;

    /** @type {THREE.Scene|null} Dedicated scene for fog overlay pass */
    this._fogOverlayScene = null;
    /** @type {THREE.OrthographicCamera|null} Camera for fog overlay pass */
    this._fogOverlayCamera = null;

    log.debug('FloorCompositor created');
  }

  _wireMapPointConsumers() {
    try {
      const mapPoints = window.MapShine?.mapPointsManager ?? null;
      const activeLevelContext = window.MapShine?.activeLevelContext ?? null;
      if (mapPoints === this._wiredMapPointsManager) return;

      this._smellyFliesEffect?.setMapPointsSources?.(mapPoints);
      this._lightningEffect?.setMapPointsSources?.(mapPoints);
      this._candleFlamesEffect?.setMapPointsSources?.(mapPoints);
      this._smellyFliesEffect?.setActiveLevelContext?.(activeLevelContext);
      this._lightningEffect?.setActiveLevelContext?.(activeLevelContext);
      this._candleFlamesEffect?.setActiveLevelContext?.(activeLevelContext);

      this._wiredMapPointsManager = mapPoints;
      if (mapPoints) {
        log.info('Map-point effect wiring refreshed (smelly flies / lightning / candle flames)');
      }
    } catch (err) {
      log.warn('Map-point effect wiring failed (smelly flies / lightning / candle flames):', err);
    }
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

    // Fog overlay scene is rendered after final blit with autoClear=false.
    this._fogOverlayScene = new THREE.Scene();
    this._fogOverlayScene.name = 'FogOverlaySceneV2';
    this._fogOverlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // ── Effects + hooks ───────────────────────────────────────────────────
    this._renderBus.initialize();

    // Door meshes are still managed by the legacy DoorMeshManager, but in V2
    // only the FloorRenderBus scene is rendered. Re-target existing and future
    // door meshes to the bus scene so door graphics remain visible.
    try {
      const doorMeshManager = window.MapShine?.doorMeshManager ?? null;
      doorMeshManager?.setScene?.(this._renderBus._scene ?? null);
    } catch (err) {
      log.warn('FloorCompositor: failed to route door meshes to V2 render bus scene:', err);
    }

    this._specularEffect.initialize();
    this._fluidEffect.initialize();
    this._bushEffect.initialize();
    this._treeEffect.initialize();
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

    // Smelly flies uses the particles bridge batch renderer and should render
    // in the bus scene for V2.
    try { this._smellyFliesEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera); } catch (err) {
      log.warn('FloorCompositor: SmellyFliesEffect initialize failed:', err);
    }
    // Lightning renders procedural strike meshes in the bus scene.
    try { this._lightningEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera); } catch (err) {
      log.warn('FloorCompositor: LightningEffectV2 initialize failed:', err);
    }

    // Candle flames render in bus scene and push glow into lighting lightScene.
    try {
      this._candleFlamesEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera);
      this._candleFlamesEffect?.setLightingEffect?.(this._lightingEffect);
    } catch (err) {
      log.warn('FloorCompositor: CandleFlamesEffectV2 initialize failed:', err);
    }

    // Subscribe outdoors mask consumers so they receive the texture as soon as
    // populate() builds it, and again on every floor change.
    // CloudEffectV2: cloud shadows and cloud tops only fall on outdoor areas.
    // We set both the legacy single-texture path (setOutdoorsMask, which is the one
    // Outdoors mask subscribers now wired via EffectMaskRegistry in initialize()

    this._lightingEffect.initialize(w, h);
    this._skyColorEffect.initialize();
    this._colorCorrectionEffect.initialize();
    this._filterEffect.initialize();
    this._atmosphericFogEffect.initialize(this.renderer, this._renderBus._scene, this.camera);
    this._fogEffect.initialize(this.renderer, this.scene, this.camera);
    try {
      const fogPlane = this._fogEffect.fogPlane ?? null;
      if (fogPlane) {
        // In V2, the main scene is not drawn. Move fog plane to dedicated overlay scene.
        fogPlane.removeFromParent();
        this._fogOverlayScene?.add(fogPlane);
      }
    } catch (err) {
      log.warn('FloorCompositor: FogOfWarEffectV2 overlay setup failed:', err);
    }
    this._bloomEffect.initialize(w, h);
    this._filmGrainEffect.initialize();
    this._sharpenEffect.initialize();
    if (this._waterEffect) {
      this._waterEffect.initialize();
    }
    // OverheadShadowsEffectV2 initialization
    try { 
      this._overheadShadowEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera, null);
    } catch (err) {
      log.warn('FloorCompositor: OverheadShadowsEffectV2 initialize failed:', err);
    }
    try {
      this._buildingShadowEffect?.initialize?.(this.renderer, this.camera);
    } catch (err) {
      log.warn('FloorCompositor: BuildingShadowsEffectV2 initialize failed:', err);
    }

    // Artistic post-processing effects (disabled by default)
    try { this._dotScreenEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: DotScreenEffectV2 initialize failed:', err);
    }
    try { this._halftoneEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: HalftoneEffectV2 initialize failed:', err);
    }
    try { this._asciiEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: AsciiEffectV2 initialize failed:', err);
    }
    try { this._dazzleOverlayEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: DazzleOverlayEffectV2 initialize failed:', err);
    }
    try { this._visionModeEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: VisionModeEffectV2 initialize failed:', err);
    }
    try { this._invertEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: InvertEffectV2 initialize failed:', err);
    }
    try { this._sepiaEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: SepiaEffectV2 initialize failed:', err);
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
      const bush = this._bushEffect;
      if (bush?.enabled && (bush?._overlays?.size ?? 0) > 0) return true;
      const tree = this._treeEffect;
      if (tree?.enabled && (tree?._overlays?.size ?? 0) > 0) return true;
      const fire = this._fireEffect;
      if (fire?.enabled && fire._activeFloors?.size > 0) return true;
      const splash = this._waterSplashesEffect;
      if (splash?.enabled && splash._activeFloors?.size > 0) return true;
      const flies = this._smellyFliesEffect;
      if (flies?.enabled && (flies?.flySystems?.size ?? 0) > 0) return true;
      const lightning = this._lightningEffect;
      if (lightning?.enabled && lightning?.wantsContinuousRender?.()) return true;
      const candles = this._candleFlamesEffect;
      if (candles?.enabled && ((candles?._sourceFlameCount ?? 0) > 0 || (candles?._glowBuckets?.size ?? 0) > 0)) return true;
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

    // Keep map-point-driven effects (flies/lightning/candles) wired even if
    // MapPointsManager is exposed on window.MapShine after the first render.
    this._wireMapPointConsumers();

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

        // Populate bush overlays from _Bush masks.
        this._bushEffect.populate(sc.foundrySceneData).then(() => {
          this._applyCurrentFloorVisibility();
        }).catch(err => {
          log.error('BushEffectV2 populate failed:', err);
        });

        // Populate tree overlays from _Tree masks.
        this._treeEffect.populate(sc.foundrySceneData).then(() => {
          this._applyCurrentFloorVisibility();
        }).catch(err => {
          log.error('TreeEffectV2 populate failed:', err);
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

        // Initial attempt; render-time guard above re-attempts when globals land.
        this._wireMapPointConsumers();
        // Push current outdoors mask immediately; async compositor cache warmup
        // can still update this later via the per-frame sync below.
        this._syncOutdoorsMaskConsumers({
          context: window.MapShine?.activeLevelContext ?? null,
          force: true,
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

    // Keep outdoors consumers in sync even when the compositor cache populates
    // asynchronously after initial render, or when floor-context hooks were missed.
    this._syncOutdoorsMaskConsumers({ context: window.MapShine?.activeLevelContext ?? null });

    // ── Update effects (time-varying uniforms) ───────────────────────────
    if (timeInfo) {
      // Wind must advance before update() so accumulation is 1× per frame.
      this._cloudEffect.advanceWind(timeInfo.delta ?? 0.016);
      this._specularEffect.update(timeInfo);
      try { this._fluidEffect.update(timeInfo); } catch (err) {
        log.warn('FluidEffectV2 update threw, skipping fluid update:', err);
      }
      try { this._bushEffect.update(timeInfo); } catch (err) {
        log.warn('BushEffectV2 update threw, skipping bush update:', err);
      }
      try { this._treeEffect.update(timeInfo); } catch (err) {
        log.warn('TreeEffectV2 update threw, skipping tree update:', err);
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
        this._smellyFliesEffect?.update?.(timeInfo);
      } catch (err) {
        log.warn('SmellyFliesEffect update threw, skipping frame:', err);
      }
      try {
        this._lightningEffect?.ensureMeshesAttached?.(this._renderBus?._scene ?? null);
        this._lightningEffect?.update?.(timeInfo);
      } catch (err) {
        log.warn('LightningEffectV2 update threw, skipping frame:', err);
      }
      try {
        this._candleFlamesEffect?.ensureMeshesAttached?.(this._renderBus?._scene ?? null);
        this._candleFlamesEffect?.update?.(timeInfo);
      } catch (err) {
        log.warn('CandleFlamesEffectV2 update threw, skipping frame:', err);
      }
      try {
        this._ashDisturbanceEffect?.update?.(timeInfo);
      } catch (err) {
        log.warn('AshDisturbanceEffectV2 update threw, skipping frame:', err);
      }
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
      try {
        this._windowLightEffect?.setSkyState?.({
          skyTintColor: this._skyColorEffect?.currentSkyTintColor,
          sunAzimuthDeg: this._skyColorEffect?.currentSunAzimuthDeg,
        });
      } catch (_) {}
      this._windowLightEffect.update(timeInfo);
      this._colorCorrectionEffect.update(timeInfo);
      this._filterEffect.update(timeInfo);
      this._atmosphericFogEffect.update(timeInfo);
      this._fogEffect.update(timeInfo);
      this._bloomEffect.update(timeInfo);
      this._filmGrainEffect.update(timeInfo);
      this._sharpenEffect.update(timeInfo);
      // Artistic post-processing effects
      try { this._dotScreenEffect?.update?.(timeInfo); } catch (_) {}
      try { this._halftoneEffect?.update?.(timeInfo); } catch (_) {}
      try { this._asciiEffect?.update?.(timeInfo); } catch (_) {}
      try { this._dazzleOverlayEffect?.update?.(timeInfo); } catch (_) {}
      try { this._visionModeEffect?.update?.(timeInfo); } catch (_) {}
      try { this._invertEffect?.update?.(timeInfo); } catch (_) {}
      try { this._sepiaEffect?.update?.(timeInfo); } catch (_) {}
      // Overhead shadows: update sun direction + uniform params from controls.
      try { this._overheadShadowEffect?.update?.(timeInfo); } catch (err) {
        log.warn('OverheadShadowsEffectV2 update threw, skipping overhead shadow update:', err);
      }
      // Overhead shadows: no per-frame update needed — sun angles are pushed
      // directly below from SkyColorEffectV2 before render().

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
        this._overheadShadowEffect?.setSunAngles?.(az, el);
        this._buildingShadowEffect?.setSunAngles?.(az, el);
      }
    } catch (_) {}

    const _dbgStages = !this._debugFirstFrameStagesLogged;
    if (_dbgStages) {
      try { log.info('[V2 Frame] ▶ FloorCompositor.render: BEGIN'); } catch (_) {}
    }

    // Capture overhead tile alpha + compute soft shadow factor (V1 signature)
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: overheadShadows.render'); } catch (_) {} }
    try {
      this._overheadShadowEffect?.render?.(this.renderer, this._renderBus._scene, this.camera);
    } catch (err) {
      log.warn('OverheadShadowsEffectV2 render threw, skipping overhead shadow pass:', err);
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: overheadShadows.render DONE'); } catch (_) {} }

    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: buildingShadows.render'); } catch (_) {} }
    try {
      this._buildingShadowEffect?.render?.(this.renderer, this.camera);
    } catch (err) {
      log.warn('BuildingShadowsEffectV2 render threw, skipping building shadow pass:', err);
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: buildingShadows.render DONE'); } catch (_) {} }

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
    const windowCloudShadowTex = (this._cloudEffect.enabled && this._cloudEffect.params.enabled)
      ? (this._cloudEffect.cloudShadowRawTexture ?? this._cloudEffect.cloudShadowTexture)
      : null;
    const windowCloudShadowViewBounds = (this._cloudEffect.enabled && this._cloudEffect.params.enabled)
      ? (this._cloudEffect.cloudShadowViewBounds ?? null)
      : null;
    const shadowW = Number(windowCloudShadowTex?.image?.width) || this._sceneRT?.width || 1;
    const shadowH = Number(windowCloudShadowTex?.image?.height) || this._sceneRT?.height || 1;
    this._windowLightEffect?.setCloudShadowTexture?.(windowCloudShadowTex, shadowW, shadowH, windowCloudShadowViewBounds);
    const buildingShadowTex = (this._buildingShadowEffect?.params?.enabled)
      ? this._buildingShadowEffect.shadowFactorTexture : null;
    const buildingShadowOpacity = Number.isFinite(this._buildingShadowEffect?.params?.opacity)
      ? this._buildingShadowEffect.params.opacity : 0.75;
    const overheadShadowTex = (this._overheadShadowEffect?.params?.enabled)
      ? this._overheadShadowEffect.shadowFactorTexture : null;
    const overheadRoofAlphaTex = (this._overheadShadowEffect?.params?.enabled)
      ? this._overheadShadowEffect.roofAlphaTexture : null;
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: lighting.render(sceneRT→postA)'); } catch (_) {} }

    this._lightingEffect.render(this.renderer, this.camera, currentInput, this._postA, winScene, cloudShadowTex, buildingShadowTex, overheadShadowTex, buildingShadowOpacity, overheadRoofAlphaTex);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: lighting.render(sceneRT→postA) DONE'); } catch (_) {} }

    currentInput = this._postA;

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

    // Atmospheric fog pass: weather-driven distance haze over the graded scene.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: atmosphericFog.render'); } catch (_) {} }
    if (this._atmosphericFogEffect?.enabled && this._atmosphericFogEffect?.params?.enabled) {
      const fogOutput = (currentInput === this._postA) ? this._postB : this._postA;
      if (this._atmosphericFogEffect.render(this.renderer, this.camera, currentInput, fogOutput)) {
        currentInput = fogOutput;
      }
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: atmosphericFog.render DONE'); } catch (_) {} }

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

    // Artistic post-processing effects (disabled by default).
    if (this._dotScreenEffect?.enabled) {
      const dsOutput = (currentInput === this._postA) ? this._postB : this._postA;
      if (this._dotScreenEffect.render(this.renderer, this.camera, currentInput, dsOutput)) {
        currentInput = dsOutput;
      }
    }
    if (this._halftoneEffect?.enabled) {
      const htOutput = (currentInput === this._postA) ? this._postB : this._postA;
      if (this._halftoneEffect.render(this.renderer, this.camera, currentInput, htOutput)) {
        currentInput = htOutput;
      }
    }
    if (this._asciiEffect?.enabled) {
      const asciiOutput = (currentInput === this._postA) ? this._postB : this._postA;
      if (this._asciiEffect.render(this.renderer, this.camera, currentInput, asciiOutput)) {
        currentInput = asciiOutput;
      }
    }
    if (this._dazzleOverlayEffect?.enabled) {
      const dzOutput = (currentInput === this._postA) ? this._postB : this._postA;
      if (this._dazzleOverlayEffect.render(this.renderer, this.camera, currentInput, dzOutput)) {
        currentInput = dzOutput;
      }
    }
    if (this._visionModeEffect?.enabled) {
      const vmOutput = (currentInput === this._postA) ? this._postB : this._postA;
      if (this._visionModeEffect.render(this.renderer, this.camera, currentInput, vmOutput)) {
        currentInput = vmOutput;
      }
    }
    if (this._invertEffect?.enabled) {
      const invOutput = (currentInput === this._postA) ? this._postB : this._postA;
      if (this._invertEffect.render(this.renderer, this.camera, currentInput, invOutput)) {
        currentInput = invOutput;
      }
    }
    if (this._sepiaEffect?.enabled) {
      const sepOutput = (currentInput === this._postA) ? this._postB : this._postA;
      if (this._sepiaEffect.render(this.renderer, this.camera, currentInput, sepOutput)) {
        currentInput = sepOutput;
      }
    }

    // ── Step 3: Blit final result to screen ──────────────────────────────
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: blitToScreen'); } catch (_) {} }
    this._blitToScreen(currentInput);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: blitToScreen DONE'); } catch (_) {} }

    // Render fog of war as a final overlay above the composited frame.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: fogOverlay.render'); } catch (_) {} }
    this._renderFogOverlay();
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: fogOverlay.render DONE'); } catch (_) {} }

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
   * Render the fog overlay scene once per frame after final blit.
   * @private
   */
  _renderFogOverlay() {
    const fog = this._fogEffect;
    if (!fog?.enabled || fog?.params?.enabled === false) return;
    const scene = this._fogOverlayScene;
    const camera = this._fogOverlayCamera;
    if (!scene || !camera || !this.renderer) return;

    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    try {
      renderer.render(scene, camera);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
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
   * Resolve the best available outdoors texture for the supplied level context.
   *
   * Fallback order:
   * 1) Explicit payload/active context key (`bottom:top`)
   * 2) Active floor key from FloorStack (compositorKey)
   * 3) Compositor active floor key
   * 4) Ground floor outdoors texture
   *
   * @param {{bottom:number,top:number}|null} context
   * @returns {{texture: THREE.Texture|null, floorKey: string|null}}
   * @private
   */
  _resolveOutdoorsMask(context = null) {
    const sc = window.MapShine?.sceneComposer;
    const compositor = sc?._sceneMaskCompositor;
    if (!compositor) {
      // Fallbacks when compositor cache is not ready yet.
      const bundleMask = sc?.currentBundle?.masks?.find?.(m => (m?.id === 'outdoors' || m?.type === 'outdoors'))?.texture ?? null;
      if (bundleMask) return { texture: bundleMask, floorKey: 'bundle' };
      const mmMask = window.MapShine?.maskManager?.getTexture?.('outdoors.scene') ?? null;
      if (mmMask) return { texture: mmMask, floorKey: 'maskManager' };
      const roofMap = weatherController?.roofMap ?? null;
      return { texture: roofMap, floorKey: roofMap ? 'weatherController' : null };
    }

    const candidateKeys = [];

    const cb = Number(context?.bottom);
    const ct = Number(context?.top);
    if (Number.isFinite(cb) && Number.isFinite(ct)) candidateKeys.push(`${cb}:${ct}`);

    try {
      const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.();
      const activeCompositorKey = activeFloor?.compositorKey;
      if (activeCompositorKey) candidateKeys.push(String(activeCompositorKey));
    } catch (_) {}

    const compositorActiveKey = compositor._activeFloorKey ?? null;
    if (compositorActiveKey) candidateKeys.push(String(compositorActiveKey));

    const uniqueKeys = [...new Set(candidateKeys.filter(Boolean))];
    for (const key of uniqueKeys) {
      const tex = compositor.getFloorTexture?.(key, 'outdoors') ?? null;
      if (tex) return { texture: tex, floorKey: key };
    }

    const groundTex = compositor.getGroundFloorMaskTexture?.('outdoors') ?? null;
    if (groundTex) return { texture: groundTex, floorKey: 'ground' };

    // Last-ditch fallbacks for transient compose timing windows.
    const bundleMask = sc?.currentBundle?.masks?.find?.(m => (m?.id === 'outdoors' || m?.type === 'outdoors'))?.texture ?? null;
    if (bundleMask) return { texture: bundleMask, floorKey: 'bundle' };

    const mmMask = window.MapShine?.maskManager?.getTexture?.('outdoors.scene') ?? null;
    if (mmMask) return { texture: mmMask, floorKey: 'maskManager' };

    const roofMap = weatherController?.roofMap ?? null;
    return { texture: roofMap, floorKey: roofMap ? 'weatherController' : null };
  }

  /**
   * Push outdoors mask texture to all V2 consumers.
   * Uses identity-based change detection to avoid redundant uniform writes.
   *
   * @param {{context?: {bottom:number,top:number}|null, force?: boolean}} [options]
   * @private
   */
  _syncOutdoorsMaskConsumers(options = {}) {
    const { context = null, force = false } = options;
    try {
      const resolved = this._resolveOutdoorsMask(context);
      let outdoorsTex = resolved.texture ?? null;

      // Do not clobber a valid outdoors texture with transient null while floor
      // caches are still warming asynchronously.
      if (!outdoorsTex && this._lastOutdoorsTexture) {
        outdoorsTex = this._lastOutdoorsTexture;
      }

      if (!force && outdoorsTex === this._lastOutdoorsTexture) return;

      this._lastOutdoorsTexture = outdoorsTex;
      this._lastOutdoorsFloorKey = resolved.floorKey;

      // Always propagate (including null) so consumers cannot keep stale masks.
      this._cloudEffect?.setOutdoorsMask?.(outdoorsTex);
      this._waterEffect?.setOutdoorsMask?.(outdoorsTex);
      this._skyColorEffect?.setOutdoorsMask?.(outdoorsTex);
      this._filterEffect?.setOutdoorsMask?.(outdoorsTex);
      this._atmosphericFogEffect?.setOutdoorsMask?.(outdoorsTex);
      this._overheadShadowEffect?.setOutdoorsMask?.(outdoorsTex);
      this._buildingShadowEffect?.setOutdoorsMask?.(outdoorsTex);

      // CloudEffectV2 supports floor-aware outdoors masking when provided with
      // per-floor textures and the compositor floor-id texture.
      try {
        const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
        if (compositor) {
          const floors = window.MapShine?.floorStack?.getVisibleFloors?.() ?? [];
          const perFloor = [null, null, null, null];
          let floorIdSupported = true;
          let anyPerFloorMask = false;
          for (const floor of floors) {
            const idx = Number(floor?.index);
            const key = floor?.compositorKey;
            if (!Number.isFinite(idx) || idx < 0 || idx > 3) {
              floorIdSupported = false;
              continue;
            }
            if (!key) continue;
            perFloor[idx] = compositor.getFloorTexture?.(key, 'outdoors') ?? null;
            if (perFloor[idx]) anyPerFloorMask = true;
          }

          // CloudEffectV2 shader only has per-floor outdoors samplers for indices 0..3.
          // If the visible floor set isn't representable, force legacy single-mask mode.
          if (floorIdSupported && anyPerFloorMask) {
            const floorIdTex = compositor.floorIdTarget?.texture ?? null;
            this._cloudEffect?.setFloorIdTexture?.(floorIdTex);
            this._cloudEffect?.setOutdoorsMasks?.(perFloor);
          } else {
            this._cloudEffect?.setFloorIdTexture?.(null);
            this._cloudEffect?.setOutdoorsMasks?.([null, null, null, null]);
          }
        }
      } catch (_) {}

      if (typeof weatherController?.setRoofMap === 'function') {
        weatherController.setRoofMap(outdoorsTex);
      }
    } catch (err) {
      log.warn('FloorCompositor: outdoors mask sync failed:', err);
    }
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
    // Bush/Tree overlays are bus-managed; still notify for any internal floor state.
    try { this._bushEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    try { this._treeEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    
    this._syncOutdoorsMaskConsumers({
      context: payload?.context ?? window.MapShine?.activeLevelContext ?? null,
      force: true,
    });
    
    // Update window light overlay visibility (isolated scene, not bus-managed).
    this._windowLightEffect.onFloorChange(maxFloorIndex);
    // Cloud effect: blocker pass is automatically floor-isolated via bus visibility;
    // no extra state needed, but notify for any future floor-aware work.
    this._cloudEffect.onFloorChange(maxFloorIndex);
    // Weather particles are global (rain falls on all visible floors); no-op.
    try { this._weatherParticles?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    try { this._smellyFliesEffect?.setActiveLevelContext?.(payload?.context ?? window.MapShine?.activeLevelContext ?? null); } catch (_) {}
    try { this._lightningEffect?.setActiveLevelContext?.(payload?.context ?? window.MapShine?.activeLevelContext ?? null); } catch (_) {}
    try { this._candleFlamesEffect?.setActiveLevelContext?.(payload?.context ?? window.MapShine?.activeLevelContext ?? null); } catch (_) {}
    try { this._lightningEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    try { this._candleFlamesEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Outdoors mask floor changes are handled above via GpuSceneMaskCompositor
    // Swap active water SDF data for the new floor.
    try { this._waterEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
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
    try { this._bushEffect?.onResize?.(w, h); } catch (_) {}
    try { this._treeEffect?.onResize?.(w, h); } catch (_) {}
    this._cloudEffect.onResize(w, h);
    this._lightingEffect.onResize(w, h);
    this._bloomEffect.onResize(w, h);
    try { this._overheadShadowEffect?.onResize?.(w, h); } catch (_) {}
    try { this._buildingShadowEffect?.onResize?.(w, h); } catch (_) {}
    try { this._weatherParticles?.onResize?.(w, h); } catch (_) {}
    try { this._lightningEffect?.onResize?.(w, h); } catch (_) {}
    try { this._atmosphericFogEffect?.onResize?.(w, h); } catch (_) {}
    try { this._dotScreenEffect?.onResize?.(w, h); } catch (_) {}
    try { this._halftoneEffect?.onResize?.(w, h); } catch (_) {}
    try { this._asciiEffect?.onResize?.(w, h); } catch (_) {}
    try { this._dazzleOverlayEffect?.onResize?.(w, h); } catch (_) {}
    try { this._visionModeEffect?.onResize?.(w, h); } catch (_) {}
    try { this._invertEffect?.onResize?.(w, h); } catch (_) {}
    try { this._sepiaEffect?.onResize?.(w, h); } catch (_) {}
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
    try { this._bushEffect?.dispose?.(); } catch (_) {}
    try { this._treeEffect?.dispose?.(); } catch (_) {}
    try { this._fireEffect?.dispose?.(); } catch (_) {}
    try { this._windowLightEffect?.dispose?.(); } catch (_) {}
    try { this._cloudEffect?.dispose?.(); } catch (_) {}
    try { this._lightingEffect?.dispose?.(); } catch (_) {}
    try { this._skyColorEffect?.dispose?.(); } catch (_) {}
    try { this._atmosphericFogEffect?.dispose?.(); } catch (_) {}
    try { this._fogEffect?.dispose?.(); } catch (_) {}
    try { this._bloomEffect.dispose(); } catch (_) {}
    try { this._colorCorrectionEffect.dispose(); } catch (_) {}
    try { this._skyColorEffect.dispose(); } catch (_) {}
    try { this._lightingEffect.dispose(); } catch (_) {}
    try { this._overheadShadowEffect?.dispose?.(); } catch (_) {}
    try { this._buildingShadowEffect?.dispose?.(); } catch (_) {}
    try { this._smellyFliesEffect?.dispose?.(); } catch (_) {}
    try { this._lightningEffect?.dispose?.(); } catch (_) {}
    try { this._candleFlamesEffect?.dispose?.(); } catch (_) {}
    try { this._dotScreenEffect?.dispose?.(); } catch (_) {}
    try { this._halftoneEffect?.dispose?.(); } catch (_) {}
    try { this._asciiEffect?.dispose?.(); } catch (_) {}
    try { this._dazzleOverlayEffect?.dispose?.(); } catch (_) {}
    try { this._visionModeEffect?.dispose?.(); } catch (_) {}
    try { this._invertEffect?.dispose?.(); } catch (_) {}
    try { this._sepiaEffect?.dispose?.(); } catch (_) {}
    try { this._fireEffect.dispose(); } catch (_) {}
    try { this._specularEffect.dispose(); } catch (_) {}
    try { this._windowLightEffect.dispose(); } catch (_) {}
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
    this._fogOverlayScene = null;
    this._fogOverlayCamera = null;

    // Unregister the level-change hook.
    if (this._levelHookId !== null) {
      try { Hooks.off('mapShineLevelContextChanged', this._levelHookId); } catch (_) {}
      this._levelHookId = null;
    }

    this._initialized = false;
    log.info('FloorCompositor disposed');
  }
}
