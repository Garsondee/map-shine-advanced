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
 *     and cloud-top RT (blitted after lighting). Shadow occlusion uses overhead
 *     blockers plus a cross-floor mask for slabs above the active band.
 *   - **LightingEffectV2**: Ambient + dynamic lights + darkness, with cloud shadow.
 *     Window light overlays are fed into the light accumulation RT here so
 *     the compose shader tints them by surface albedo (preserving hue).
 *   - **WaterEffectV2**: Water tint/distortion/specular/foam driven by _Water masks.
 *   - **SkyColorEffectV2**: Time-of-day atmospheric color grading.
 *   - **BloomEffectV2**: Screen-space glow via UnrealBloomPass.
 *   - **ColorCorrectionEffectV2**: User-authored color grade.
 *   - **SharpenEffectV2**: Unsharp mask filter (disabled by default).
 *
 * Called by EffectComposer.render() in the V2-only runtime.
 *
 * @module compositor-v2/FloorCompositor
 */

import { createLogger } from '../core/log.js';
import { OVERLAY_THREE_LAYER } from '../core/render-layers.js';
import { FloorRenderBus } from './FloorRenderBus.js';
import { SpecularEffectV2 } from './effects/SpecularEffectV2.js';
import { FireEffectV2 } from './effects/FireEffectV2.js';
import { WindowLightEffectV2 } from './effects/WindowLightEffectV2.js';
import { LightingEffectV2 } from './effects/LightingEffectV2.js';
import { SkyColorEffectV2 } from './effects/SkyColorEffectV2.js';
import { ColorCorrectionEffectV2 } from './effects/ColorCorrectionEffectV2.js';
import { BloomEffectV2 } from './effects/BloomEffectV2.js';
import { SharpenEffectV2 } from './effects/SharpenEffectV2.js';
import { FloorDepthBlurEffect } from './effects/FloorDepthBlurEffect.js';
import { FilterEffectV2 } from './effects/FilterEffectV2.js';
import { WaterEffectV2 } from './effects/WaterEffectV2.js';
import { CloudEffectV2 } from './effects/CloudEffectV2.js';
import { ShadowManagerV2 } from './effects/ShadowManagerV2.js';
import { WeatherParticlesV2 } from './effects/WeatherParticlesV2.js';
import { WaterSplashesEffectV2 } from './effects/WaterSplashesEffectV2.js';
import { WaterGlitterEffectV2 } from './effects/WaterGlitterEffectV2.js';

// Debug: Check if import worked
console.log('FloorCompositor: WaterGlitterEffectV2 import check:', {
  classExists: !!WaterGlitterEffectV2,
  className: WaterGlitterEffectV2?.name,
  constructorType: typeof WaterGlitterEffectV2
});
import { AshDisturbanceEffectV2 } from './effects/AshDisturbanceEffectV2.js';
import { FluidEffectV2 } from './effects/FluidEffectV2.js';
import { IridescenceEffectV2 } from './effects/IridescenceEffectV2.js';
import { PrismEffectV2 } from './effects/PrismEffectV2.js';
import { BushEffectV2 } from './effects/BushEffectV2.js';
import { TreeEffectV2 } from './effects/TreeEffectV2.js';
import { OverheadShadowsEffectV2 } from './effects/OverheadShadowsEffectV2.js';
import { BuildingShadowsEffectV2 } from './effects/BuildingShadowsEffectV2.js';
import { createLightingPerspectiveContext } from './LightingPerspectiveContext.js';
import { DustEffectV2 } from './effects/DustEffectV2.js';
import { DotScreenEffectV2 } from './effects/DotScreenEffectV2.js';
import { HalftoneEffectV2 } from './effects/HalftoneEffectV2.js';
import { AsciiEffectV2 } from './effects/AsciiEffectV2.js';
import { DazzleOverlayEffectV2 } from './effects/DazzleOverlayEffectV2.js';
import { VisionModeEffectV2 } from './effects/VisionModeEffectV2.js';
import { InvertEffectV2 } from './effects/InvertEffectV2.js';
import { SepiaEffectV2 } from './effects/SepiaEffectV2.js';
import { LensEffectV2 } from './effects/LensEffectV2.js';
import { DistortionManager, DistortionLayer } from './effects/DistortionManager.js';
import { LightningEffectV2 } from './effects/LightningEffectV2.js';
import { AtmosphericFogEffectV2 } from './effects/AtmosphericFogEffectV2.js';
import { FogOfWarEffectV2 } from './effects/FogOfWarEffectV2.js';
import { MovementPreviewEffectV2 } from './effects/MovementPreviewEffectV2.js';
import { PlayerLightEffectV2 } from './effects/PlayerLightEffectV2.js';
import { SmellyFliesEffect } from '../particles/SmellyFliesEffect.js';
import { CandleFlamesEffectV2 } from './effects/CandleFlamesEffectV2.js';
import { weatherController } from '../core/WeatherController.js';
import { resolveCompositorOutdoorsTexture } from '../masks/resolve-compositor-outdoors.js';
import { MaskDebugOverlayPass } from './MaskDebugOverlayPass.js';

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
    /** @type {any|null} */
    this._healthEvaluator = null;

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
     * V2 Iridescence Effect: per-tile holographic overlays driven by
     * _Iridescence masks. Overlays live in the bus scene and are floor-visible
     * via the bus visibility system.
     * @type {IridescenceEffectV2}
     */
    this._iridescenceEffect = new IridescenceEffectV2(this._renderBus);

    /**
     * V2 Prism Effect: per-tile crystal/glass refraction overlays driven by
     * _Prism masks. Overlays live in the bus scene and are floor-visible
     * via the bus visibility system.
     * @type {PrismEffectV2}
     */
    this._prismEffect = new PrismEffectV2(this._renderBus);

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
     * V2 Dust Effect: per-floor ambient dust particles driven by _Dust masks.
     * BatchedRenderer lives in the bus scene.
     * @type {DustEffectV2}
     */
    this._dustEffect = new DustEffectV2(this._renderBus);

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
     * Debug: composite mask textures (e.g. _Outdoors) over the final V2 frame before blit.
     * Controlled from Tweakpane → Developer Tools → Mask overlay (V2).
     * @type {MaskDebugOverlayPass}
     */
    this._maskDebugOverlayPass = new MaskDebugOverlayPass();

    /**
     * V2 Sharpen Effect: unsharp mask filter. Disabled by default.
     * @type {SharpenEffectV2}
     */
    this._sharpenEffect = new SharpenEffectV2();

    /**
     * V2 Floor Depth Blur Effect: Kawase multi-pass blur applied to floors
     * below the currently active level. Disabled by default.
     * @type {FloorDepthBlurEffect}
     */
    this._floorDepthBlurEffect = new FloorDepthBlurEffect();

    /**
     * V2 Cloud Effect: procedural cloud density, shadow, and cloud-top passes.
     * - Shadow RT is fed into LightingEffectV2 as an illumination multiplier.
     * - Cloud-top RT is blitted (alpha-over) after the lighting pass.
     * - Blocker mask is built from overhead bus sprites each frame so
     *   floor-level rooftops correctly occlude shadows (free with bus visibility).
     * @type {CloudEffectV2}
     */
    this._cloudEffect = new CloudEffectV2();
    /** @type {ShadowManagerV2} */
    this._shadowManagerEffect = new ShadowManagerV2();
    /**
     * Cloud shadow textures from the previous frame — combined with current
     * overhead/building in ShadowManagerV2 before the bus draw so water splashes
     * sample the same structural shadow field as the scene (cloud lags one frame).
     * @type {THREE.Texture|null}
     */
    this._shadowManagerPrevFrameCloudTex = null;
    /** @type {THREE.Texture|null} */
    this._shadowManagerPrevFrameCloudRawTex = null;

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
     * V2 Water Glitter Effect: particle-based glitter system for water surfaces.
     * Creates bright, short-lived sparkles designed to catch the bloom shader.
     * @type {WaterGlitterEffectV2}
     */
    try {
      console.log('FloorCompositor: Creating WaterGlitterEffectV2...');
      this._waterGlitterEffect = new WaterGlitterEffectV2(this._renderBus);
      console.log('FloorCompositor: WaterGlitterEffectV2 created successfully:', !!this._waterGlitterEffect);
      // Expose test method globally for debugging
      if (typeof window !== 'undefined') {
        window.testWaterGlitter = () => this._waterGlitterEffect?.test();
      }
    } catch (err) {
      console.error('FloorCompositor: Failed to create WaterGlitterEffectV2:', err);
      this._waterGlitterEffect = null;
    }

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

    /**
     * V2 Player Light Effect: token-attached torch/flashlight gameplay light.
     * Global-scoped effect (not floor-isolated).
     * @type {PlayerLightEffectV2}
     */
    this._playerLightEffect = new PlayerLightEffectV2();

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
     * Frozen per-frame snapshot for Levels/floor-aware lighting (see `LightingPerspectiveContext`).
     * Refreshed at the start of each `render()` before the lighting pass.
     * @type {import('./LightingPerspectiveContext.js').LightingPerspectiveContext|null}
     */
    this._lightingPerspectiveContext = null;

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

    /**
     * V2 Lens Effect: stylized lens distortion/aberration/grime post pass.
     * Post-processing pass. Disabled by default.
     * @type {LensEffectV2}
     */
    this._lensEffect = new LensEffectV2();

    /**
     * V2 Distortion Manager: unified post-process distortion pass.
     * Currently driven by FireEffectV2 heat-haze source.
     * @type {DistortionManager}
     */
    this._distortionEffect = new DistortionManager();

    /**
     * V2 Movement Preview Effect: token path preview lines, tile highlights, ghost
     * tokens, and drag-ghost sprites — all rendered in the bus scene at the
     * correct Z above tiles/tokens so they are always visible.
     * @type {MovementPreviewEffectV2}
     */
    this._movementPreviewEffect = new MovementPreviewEffectV2(this._renderBus);

    /** @type {boolean} Whether the render bus has been populated this session. */
    this._busPopulated = false;

    /** @type {Promise<boolean>|null} In-flight async populate/prewarm task. */
    this._populatePromise = null;

    /** @type {boolean} Whether bus/effect populate has completed at least once. */
    this._populateComplete = false;

    /** @type {boolean} Whether initialize() has been called */
    this._initialized = false;

    /**
     * Optional scene-level hints provided by canvas replacement at load time.
     * Expected shape: { maskIds: string[] }.
     * Used to avoid compiling mask-driven effects that cannot run on this scene.
     * @type {{maskIds?: string[]|Set<string>}|null}
     */
    this._effectHints = null;

    /**
     * Whether the shader warmup gate is open. While false, all effect update()
     * calls receive delta=0 so time-based systems (particles, wind, waves) don't
     * accumulate missed time during the warmup window. Opens via openShaderGate()
     * after warmupAsync() resolves.
     * @type {boolean}
     */
    this._shaderWarmupGateOpen = false;

    /** @type {THREE.Vector2} Reusable size vector (avoids per-frame allocation) */
    this._sizeVec = null;

    /** @type {number|null} Foundry hook ID for mapShineLevelContextChanged */
    this._levelHookId = null;

    /** @type {string|null} Last applied active level context key (bottom:top) */
    this._lastAppliedLevelContextKey = null;

    /** @type {number} Number of runtime visibility drift corrections applied */
    this._visibilityDriftCorrections = 0;
    /** @type {number} Leak count observed on latest drift scan */
    this._visibilityDriftLastLeakCount = 0;
    /** @type {number|null} Timestamp of last drift correction */
    this._visibilityDriftLastCorrectionMs = null;

    /** @type {number} Number of tile-sprite visibility corrections applied */
    this._tileSpriteVisibilityCorrections = 0;
    /** @type {number} Last observed tile-sprite leak count */
    this._tileSpriteVisibilityLastLeakCount = 0;
    /** @type {number|null} Timestamp of last tile-sprite correction */
    this._tileSpriteVisibilityLastCorrectionMs = null;

    /** @type {THREE.Texture|null} Last outdoors mask pushed to V2 consumers */
    this._lastOutdoorsTexture = null;

    /** @type {string|null} Last resolved floor key used for outdoors sync diagnostics */
    this._lastOutdoorsFloorKey = null;

    /** @type {THREE.Texture|null} Cached fire mask texture used for heat-haze blur */
    this._fireHeatMaskInput = null;
    /** @type {THREE.Texture|null} Cached blurred fire mask texture used by distortion */
    this._fireHeatMaskOutput = null;
    /** @type {number} Cached blur radius used to build _fireHeatMaskOutput */
    this._fireHeatMaskBlurRadius = -1;
    /** @type {number} Cached blur pass count used to build _fireHeatMaskOutput */
    this._fireHeatMaskBlurPasses = -1;

    /** @type {import('../scene/map-points-manager.js').MapPointsManager|null} Last wired map-points manager instance */
    this._wiredMapPointsManager = null;

    // Diagnostic: log the first frame's major render stages once.
    // This helps pinpoint which stage stalls the main thread on some GPUs.
    this._debugFirstFrameStagesLogged = false;

    /**
     * P4: Per-pass profiler counters. Enabled via MapShine.__v2PassProfiler = true.
     * When active, accumulates per-pass wall-clock times and exposes them on
     * MapShine.__v2PassTimings as a plain object { stageName: { total, count, avg, last } }.
     * @type {Object<string,{total:number,count:number,last:number}>|null}
     * @private
     */
    this._passTimings = null;

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

    /** @type {THREE.Scene|null} Scene for compositing PIXI world channel into post chain */
    this._pixiWorldCompositeScene = null;
    /** @type {THREE.OrthographicCamera|null} Camera for PIXI world composite */
    this._pixiWorldCompositeCamera = null;
    /** @type {THREE.ShaderMaterial|null} Material for base+overlay alpha composite */
    this._pixiWorldCompositeMaterial = null;
    /** @type {THREE.Mesh|null} Fullscreen quad for PIXI world composite */
    this._pixiWorldCompositeQuad = null;

    /** @type {THREE.Scene|null} Scene for rendering PIXI UI channel to screen */
    this._pixiUiOverlayScene = null;
    /** @type {THREE.OrthographicCamera|null} Camera for PIXI UI overlay */
    this._pixiUiOverlayCamera = null;
    /** @type {THREE.ShaderMaterial|null} Material for PIXI UI overlay */
    this._pixiUiOverlayMaterial = null;
    /** @type {THREE.Mesh|null} Fullscreen quad for PIXI UI overlay */
    this._pixiUiOverlayQuad = null;

    /** @type {string} Cached PIXI world stage transform signature for uniform updates */
    this._pixiWorldStageInvSig = '';
    /** @type {string} Cached PIXI world screen-size signature for uniform updates */
    this._pixiWorldScreenSizeSig = '';
    /** @type {string} Cached PIXI world overlay-size signature for uniform updates */
    this._pixiWorldOverlaySizeSig = '';

    /** @type {THREE.Scene|null} Dedicated scene for fog overlay pass */
    this._fogOverlayScene = null;
    /** @type {THREE.OrthographicCamera|null} Camera for fog overlay pass */
    this._fogOverlayCamera = null;

    /**
     * P2: Whether the bus scene has any objects on OVERLAY_THREE_LAYER (31).
     * Checked cheaply each frame to skip the late overlay render pass when empty.
     * Set to true when overlay content is added; reset/recomputed on populate.
     * @type {boolean}
     */
    this._hasOverlayLayerContent = false;

    log.debug('FloorCompositor created');
  }

  /**
   * Attach optional health evaluator for diagnostics callbacks.
   * @param {any|null} evaluator
   */
  setHealthEvaluator(evaluator) {
    this._healthEvaluator = evaluator || null;
  }

  /**
   * Composite PIXI world-channel texture into the post chain using straight-alpha over.
   * @param {THREE.WebGLRenderTarget} inputRT
   * @returns {THREE.WebGLRenderTarget}
   * @private
   */
  _compositePixiWorldOverlay(inputRT) {
    const mapShine = window.MapShine ?? null;
    const publishMappingStub = (skipReason, extra = {}) => {
      try {
        if (mapShine) {
          mapShine.__pixiWorldCompositeMapping = {
            active: false,
            timestampMs: performance.now(),
            skipReason: String(skipReason || 'unknown'),
            ...extra,
          };
        }
      } catch (_) {}
    };

    if (!inputRT || !this._pixiWorldCompositeMaterial || !this._postA || !this._postB) {
      publishMappingStub('floor-compositor-not-ready', { hasInputRT: !!inputRT });
      return inputRT;
    }
    const bridge = window.MapShine?.pixiContentLayerBridge ?? null;
    const overlayTexture = bridge?.getWorldTexture?.() ?? null;
    const debugForceTint = !!mapShine?.__pixiBridgeForceCompositorTint;
    const debugCompositeStatus = !!mapShine?.__pixiBridgeCompositeDebug;

    if (!overlayTexture && !debugForceTint) {
      publishMappingStub('no-overlay-texture', {
        bridgeLastStatus: bridge?._lastUpdateStatus ?? 'bridge-missing',
      });
      this._setPixiBridgeCompositeStatus({
        enabled: debugCompositeStatus,
        ran: false,
        reason: 'skip:no-overlay',
        bridgeStatus: bridge?._lastUpdateStatus ?? 'bridge-missing',
        debugForceTint,
      });
      return inputRT;
    }

    const outputRT = (inputRT === this._postA) ? this._postB : this._postA;
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    this._pixiWorldCompositeMaterial.uniforms.tBase.value = inputRT.texture;
    this._pixiWorldCompositeMaterial.uniforms.tOverlay.value = overlayTexture;
    this._pixiWorldCompositeMaterial.uniforms.uHasOverlay.value = overlayTexture ? 1 : 0;
    this._pixiWorldCompositeMaterial.uniforms.uDebugForceTint.value = debugForceTint ? 1 : 0;
    // Keep reprojection in the same coordinate space as PIXI stage transforms
    // (renderer.screen logical pixels), not Three RT drawing-buffer pixels.
    const pixiScreenW = Math.max(1, Number(canvas?.app?.renderer?.screen?.width) || 0);
    const pixiScreenH = Math.max(1, Number(canvas?.app?.renderer?.screen?.height) || 0);
    const rtW = Math.max(1, Number(inputRT?.width) || Number(this._sceneRT?.width) || 1);
    const rtH = Math.max(1, Number(inputRT?.height) || Number(this._sceneRT?.height) || 1);
    const screenW = pixiScreenW > 0 ? pixiScreenW : rtW;
    const screenH = pixiScreenH > 0 ? pixiScreenH : rtH;
    const screenSig = `${screenW}x${screenH}`;
    if (screenSig !== this._pixiWorldScreenSizeSig) {
      this._pixiWorldScreenSizeSig = screenSig;
      this._pixiWorldCompositeMaterial.uniforms.uScreenSize.value.set(screenW, screenH);
    }

    // Read bridge logical size directly to avoid per-frame object allocation via
    // getWorldLogicalSize(), then fall back to texture backing dimensions.
    const ovW = Math.max(
      1,
      Number(bridge?._worldLogicalWidth) || Number(overlayTexture?.image?.width) || Number(overlayTexture?.source?.data?.width) || 1
    );
    const ovH = Math.max(
      1,
      Number(bridge?._worldLogicalHeight) || Number(overlayTexture?.image?.height) || Number(overlayTexture?.source?.data?.height) || 1
    );
    const overlaySig = `${ovW}x${ovH}`;
    if (overlaySig !== this._pixiWorldOverlaySizeSig) {
      this._pixiWorldOverlaySizeSig = overlaySig;
      this._pixiWorldCompositeMaterial.uniforms.uOverlaySize.value.set(ovW, ovH);
    }

    const t = canvas?.stage?.worldTransform ?? null;
    const stageSig = this._getPixiStageTransformSig(t);
    if (stageSig !== this._pixiWorldStageInvSig) {
      this._pixiWorldStageInvSig = stageSig;
      const inv = this._computePixiStageInverse(t);
      this._pixiWorldCompositeMaterial.uniforms.uStageInvMat.value.set(inv.ia, inv.ib, inv.ic, inv.id);
      this._pixiWorldCompositeMaterial.uniforms.uStageInvTranslate.value.set(inv.itx, inv.ity);
    }
    try {
      if (mapShine) {
        mapShine.__pixiWorldCompositeMapping = {
          active: true,
          timestampMs: performance.now(),
          screenSize: { width: screenW, height: screenH },
          overlaySize: { width: ovW, height: ovH },
          stageInverseSignature: stageSig,
          yFlipModel: 'screenToTopLeft_then_overlayYInvert'
        };
      }
    } catch (_) {}

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    try {
      renderer.render(this._pixiWorldCompositeScene, this._pixiWorldCompositeCamera);
      this._setPixiBridgeCompositeStatus({
        enabled: debugCompositeStatus,
        ran: true,
        reason: 'rendered',
        hasOverlay: !!overlayTexture,
        bridgeStatus: bridge?._lastUpdateStatus ?? 'bridge-missing',
        debugForceTint,
      });
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }

    return outputRT;
  }

  /**
   * @param {PIXI.Matrix|null|undefined} t
   * @returns {string}
   * @private
   */
  _getPixiStageTransformSig(t) {
    if (!t) return 'none';
    const q = (v) => Math.round((Number(v) || 0) * 10000) / 10000;
    return `${q(t.a)}|${q(t.b)}|${q(t.c)}|${q(t.d)}|${q(t.tx)}|${q(t.ty)}`;
  }

  /**
   * @param {PIXI.Matrix|null|undefined} t
   * @returns {{ia:number,ib:number,ic:number,id:number,itx:number,ity:number}}
   * @private
   */
  _computePixiStageInverse(t) {
    let ia = 1; let ib = 0; let ic = 0; let id = 1; let itx = 0; let ity = 0;
    if (!t) return { ia, ib, ic, id, itx, ity };

    const a = Number(t.a) || 0;
    const b = Number(t.b) || 0;
    const c = Number(t.c) || 0;
    const d = Number(t.d) || 0;
    const tx = Number(t.tx) || 0;
    const ty = Number(t.ty) || 0;
    const det = (a * d) - (b * c);
    if (Math.abs(det) <= 1e-8) return { ia, ib, ic, id, itx, ity };

    ia = d / det;
    ib = -b / det;
    ic = -c / det;
    id = a / det;
    itx = ((c * ty) - (d * tx)) / det;
    ity = ((b * tx) - (a * ty)) / det;
    return { ia, ib, ic, id, itx, ity };
  }

  /**
   * Debug-only status emitter for PIXI world composite pass.
   * Reuses a single object to avoid per-frame allocation churn.
   * @param {{enabled:boolean,ran:boolean,reason:string,bridgeStatus:string,debugForceTint:boolean,hasOverlay?:boolean}} payload
   * @private
   */
  _setPixiBridgeCompositeStatus(payload) {
    const mapShine = window.MapShine;
    if (!mapShine) return;
    const status = mapShine.__pixiBridgeCompositeStatus ?? (mapShine.__pixiBridgeCompositeStatus = {});
    status.ran = !!payload.ran;
    status.reason = String(payload.reason || 'unknown');
    status.bridgeStatus = String(payload.bridgeStatus || 'bridge-missing');
    status.debugForceTint = !!payload.debugForceTint;
    status.hasOverlay = !!payload.hasOverlay;
    status.timestampMs = performance.now();
    // When true, extra verbose logging/UI may be attached elsewhere (opt-in).
    status.debugVerbose = !!payload.enabled;
  }

  /**
   * Render PIXI UI-channel texture above the final composed frame.
   * @private
   */
  _renderPixiUiOverlay() {
    if (!this._pixiUiOverlayMaterial || !this._pixiUiOverlayScene || !this._pixiUiOverlayCamera) return;
    const bridge = window.MapShine?.pixiContentLayerBridge ?? null;
    if (typeof bridge?.hasUiContent === 'function' && !bridge.hasUiContent()) return;
    const overlayTexture = bridge?.getUiTexture?.() ?? null;
    if (!overlayTexture) return;

    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    this._pixiUiOverlayMaterial.uniforms.tOverlay.value = overlayTexture;

    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    try {
      renderer.render(this._pixiUiOverlayScene, this._pixiUiOverlayCamera);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * Render overlay-layer world UI from the FloorRenderBus scene after final blit.
   * @private
   */
  _renderLateWorldOverlay() {
    const scene = this._renderBus?._scene;
    const camera = this.camera;
    if (!scene || !camera || !this.renderer) return;

    // P2: Skip the late overlay render call when no objects are on OVERLAY_THREE_LAYER.
    // This avoids an unnecessary renderer.render() call per frame on scenes without
    // door icons or other late-overlay objects.
    if (!this._hasOverlayLayerContent) {
      // Cheap refresh: check if any bus scene child has the overlay layer enabled.
      // Only scan top-level children (not full traverse) to keep this O(N-floors).
      const children = scene.children;
      let found = false;
      const overlayBit = 1 << OVERLAY_THREE_LAYER;
      for (let i = 0, len = children.length; i < len; i++) {
        if (children[i].layers && (children[i].layers.mask & overlayBit)) {
          found = true;
          break;
        }
      }
      this._hasOverlayLayerContent = found;
      if (!found) return;
    }

    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevLayerMask = camera.layers.mask;
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    try {
      // Render ONLY overlay layer content. Using enable() here would keep the
      // existing layer 0 mask active and re-draw raw bus albedo on top of the
      // post-processed frame, making most V2 effects appear "missing".
      camera.layers.set(OVERLAY_THREE_LAYER);
      renderer.render(scene, camera);
    } finally {
      camera.layers.mask = prevLayerMask;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * Composite fog overlay into the post RT chain.
   * @param {THREE.WebGLRenderTarget} inputRT
   * @param {THREE.WebGLRenderTarget} outputRT
   * @returns {boolean} True when fog was composited into outputRT.
   * @private
   */
  _compositeFogOverlayToRT(inputRT, outputRT) {
    const fog = this._fogEffect;
    if (!fog?.enabled || fog?.params?.enabled === false) return false;
    const scene = this._fogOverlayScene;
    const camera = this.camera;
    const renderer = this.renderer;
    if (!scene || !camera || !renderer || !this._blitMaterial || !inputRT || !outputRT) return false;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevLayerMask = camera.layers.mask;
    try {
      // Start from the latest composited scene color in outputRT.
      this._blitMaterial.uniforms.tDiffuse.value = inputRT.texture;
      renderer.setRenderTarget(outputRT);
      renderer.autoClear = true;
      renderer.render(this._blitScene, this._blitCamera);

      // Alpha-over fog plane onto the same RT.
      renderer.autoClear = false;
      camera.layers.enable(OVERLAY_THREE_LAYER);
      renderer.render(scene, camera);
      return true;
    } finally {
      camera.layers.mask = prevLayerMask;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  _wireMapPointConsumers() {
    try {
      const mapPoints = window.MapShine?.mapPointsManager ?? null;
      const activeLevelContext = window.MapShine?.activeLevelContext ?? null;
      if (mapPoints === this._wiredMapPointsManager) return;

      this._smellyFliesEffect?.setMapPointsSources?.(mapPoints);
      this._lightningEffect?.setMapPointsSources?.(mapPoints);
      this._candleFlamesEffect?.setMapPointsSources?.(mapPoints);
      this._dustEffect?.setMapPointsSources?.(mapPoints);
      this._smellyFliesEffect?.setActiveLevelContext?.(activeLevelContext);
      this._lightningEffect?.setActiveLevelContext?.(activeLevelContext);
      this._candleFlamesEffect?.setActiveLevelContext?.(activeLevelContext);
      this._dustEffect?.setActiveLevelContext?.(activeLevelContext);

      this._wiredMapPointsManager = mapPoints;
      if (mapPoints) {
        log.info('Map-point effect wiring refreshed (smelly flies / lightning / candle flames / dust)');
      }
    } catch (err) {
      log.warn('Map-point effect wiring failed (smelly flies / lightning / candle flames / dust):', err);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Initialize the compositor. Currently just sets up the bus and the
   * floor-change hook. Render targets will be added when effects need them.
   * @param {object} [options]
   * @param {(label: string, index: number, total: number) => void} [options.onProgress]
   *   Optional callback fired after each effect is initialized.
   *   `index` is 1-based; `total` is the expected total number of init steps.
   * @param {{maskIds?: string[]|Set<string>}|null} [options.effectHints]
   *   Advisory scene hints used by warmupAsync to skip unnecessary compile targets.
   */
  initialize(options = {}) {
    const _onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
    this._effectHints = options?.effectHints ?? null;
    // Total number of named effect init steps in this method — update when adding/removing effects.
    const TOTAL_EFFECT_INITS = 41;
    let _effectInitIndex = 0;
    const _reportProgress = (label) => {
      if (!_onProgress) return;
      try { _onProgress(label, ++_effectInitIndex, TOTAL_EFFECT_INITS); } catch (_) {}
    };
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

    // ── PIXI world-channel composite quad (post-chain injection) ───────────
    this._pixiWorldCompositeScene = new THREE.Scene();
    this._pixiWorldCompositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._pixiWorldCompositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tBase: { value: null },
        tOverlay: { value: null },
        uHasOverlay: { value: 0 },
        uDebugForceTint: { value: 0 },
        uScreenSize: { value: new THREE.Vector2(1, 1) },
        uOverlaySize: { value: new THREE.Vector2(1, 1) },
        uStageInvMat: { value: new THREE.Vector4(1, 0, 0, 1) },
        uStageInvTranslate: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tBase;
        uniform sampler2D tOverlay;
        uniform float uHasOverlay;
        uniform float uDebugForceTint;
        uniform vec2 uScreenSize;
        uniform vec2 uOverlaySize;
        uniform vec4 uStageInvMat;
        uniform vec2 uStageInvTranslate;
        varying vec2 vUv;
        void main() {
          vec4 base = texture2D(tBase, vUv);
          if (uDebugForceTint > 0.5) {
            vec3 dbg = vec3(1.0, 0.0, 1.0);
            gl_FragColor = vec4(mix(base.rgb, dbg, 0.9), 1.0);
            return;
          }
          if (uHasOverlay < 0.5) {
            gl_FragColor = vec4(base.rgb, 1.0);
            return;
          }
          // Fullscreen UV is bottom-left origin; PIXI stage transforms are in
          // top-left screen coordinates (Y-down). Convert before inverse stage.
          vec2 screenPx = vec2(vUv.x * uScreenSize.x, (1.0 - vUv.y) * uScreenSize.y);
          vec2 worldPx = vec2(
            (uStageInvMat.x * screenPx.x) + (uStageInvMat.z * screenPx.y) + uStageInvTranslate.x,
            (uStageInvMat.y * screenPx.x) + (uStageInvMat.w * screenPx.y) + uStageInvTranslate.y
          );
          vec2 ovUv = vec2(
            worldPx.x / max(uOverlaySize.x, 1.0),
            1.0 - (worldPx.y / max(uOverlaySize.y, 1.0))
          );
          if (ovUv.x < 0.0 || ovUv.x > 1.0 || ovUv.y < 0.0 || ovUv.y > 1.0) {
            gl_FragColor = vec4(base.rgb, 1.0);
            return;
          }
          vec4 ov = texture2D(tOverlay, ovUv);
          // Preserve sub-pixel AA from replay canvas by trusting source alpha.
          // Keep a narrow fallback for rare legacy captures that carry RGB with
          // near-zero alpha.
          float ovAlpha = clamp(ov.a, 0.0, 1.0);
          if (ovAlpha < 0.0001) {
            ovAlpha = clamp(max(ov.r, max(ov.g, ov.b)), 0.0, 1.0);
          }
          vec3 outRgb = mix(base.rgb, ov.rgb, ovAlpha);
          gl_FragColor = vec4(outRgb, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._pixiWorldCompositeMaterial.toneMapped = false;
    this._pixiWorldCompositeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._pixiWorldCompositeMaterial
    );
    this._pixiWorldCompositeQuad.frustumCulled = false;
    this._pixiWorldCompositeScene.add(this._pixiWorldCompositeQuad);

    // ── PIXI UI-channel overlay quad (rendered above all post FX) ─────────
    this._pixiUiOverlayScene = new THREE.Scene();
    this._pixiUiOverlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._pixiUiOverlayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tOverlay: { value: null },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tOverlay;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tOverlay, vUv);
          gl_FragColor = vec4(c.rgb, c.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.NormalBlending,
    });
    this._pixiUiOverlayMaterial.toneMapped = false;
    this._pixiUiOverlayQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._pixiUiOverlayMaterial
    );
    this._pixiUiOverlayQuad.frustumCulled = false;
    this._pixiUiOverlayScene.add(this._pixiUiOverlayQuad);

    // Fog overlay scene is rendered after final blit with autoClear=false.
    this._fogOverlayScene = new THREE.Scene();
    this._fogOverlayScene.name = 'FogOverlaySceneV2';
    this._fogOverlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // ── Effects + hooks ───────────────────────────────────────────────────
    this._renderBus.initialize();

    // Movement preview UI: path lines, tile highlights, ghost tokens, drag ghosts.
    // Must initialize after _renderBus so _scene is available.
    try {
      this._movementPreviewEffect.initialize();
    } catch (err) {
      log.warn('FloorCompositor: MovementPreviewEffectV2 initialize failed:', err);
    }

    // Door meshes are still managed by the legacy DoorMeshManager, but in V2
    // only the FloorRenderBus scene is rendered. Re-target existing and future
    // door meshes to the bus scene so door graphics remain visible.
    try {
      const doorMeshManager = window.MapShine?.doorMeshManager ?? null;
      doorMeshManager?.setScene?.(this._renderBus._scene ?? null);
    } catch (err) {
      log.warn('FloorCompositor: failed to route door meshes to V2 render bus scene:', err);
    }

    // Keep compositor startup resilient: a single effect init failure should not
    // abort V2 rendering entirely. Each effect is isolated and logged.
    // `_reportProgress` is called after each init to advance the loading overlay.
    const initEffect = (label, fn) => {
      try {
        fn?.();
      } catch (err) {
        log.warn(`FloorCompositor: ${label} initialize failed:`, err);
      }
      _reportProgress(label);
    };

    // Initialize floor depth blur with the same RT type as the rest of the pipeline.
    initEffect('FloorDepthBlurEffect', () =>
      this._floorDepthBlurEffect.initialize(this.renderer, w, h, preferredType));
    initEffect('SpecularEffectV2', () => this._specularEffect.initialize());
    initEffect('FluidEffectV2', () => this._fluidEffect.initialize());
    initEffect('IridescenceEffectV2', () => this._iridescenceEffect.initialize());
    initEffect('PrismEffectV2', () => this._prismEffect.initialize());
    initEffect('BushEffectV2', () => this._bushEffect.initialize());
    initEffect('TreeEffectV2', () => this._treeEffect.initialize());
    initEffect('FireEffectV2', () => this._fireEffect.initialize());
    initEffect('DustEffectV2', () => this._dustEffect.initialize());
    initEffect('WindowLightEffectV2', () => this._windowLightEffect.initialize());
    // Cloud effect needs the bus scene and main camera for the overhead blocker pass.
    this._cloudEffect.initialize(this.renderer, this._renderBus._scene, this.camera);
    try {
      this._cloudEffect.setUpperFloorMaskBuilder?.((r, cam, target) => {
        const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
        const activeIdx = Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index ?? 0);
        if (!Number.isFinite(activeIdx) || (activeIdx + 1) >= floors.length) return;
        this._renderBus.renderFloorMaskTo(r, cam, activeIdx + 1, target, { includeHiddenAboveFloors: true });
      });
    } catch (err) {
      log.warn('FloorCompositor: CloudEffectV2 upper-floor mask builder failed:', err);
    }
    _reportProgress('CloudEffectV2');
    initEffect('ShadowManagerV2', () => this._shadowManagerEffect.initialize(this.renderer, w, h));
    // Water splashes: own BatchedRenderer added via addEffectOverlay.
    try { this._waterSplashesEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: WaterSplashesEffectV2 initialize failed:', err);
    }
    _reportProgress('WaterSplashesEffectV2');
    // Water glitter: own BatchedRenderer added via addEffectOverlay.
    try { this._waterGlitterEffect?.initialize?.(this.renderer); } catch (err) {
      log.warn('FloorCompositor: WaterGlitterEffectV2 initialize failed:', err);
    }
    _reportProgress('WaterGlitterEffectV2');
    // Weather particles live in the bus scene so they render in the same pass as tiles.
    try { this._weatherParticles?.initialize?.(this._renderBus._scene); } catch (err) {
      log.warn('FloorCompositor: WeatherParticlesV2 initialize failed:', err);
    }
    _reportProgress('WeatherParticlesV2');

    // Ash disturbance bursts: owns its own batch renderer and registers it via renderBus overlay.
    try { this._ashDisturbanceEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: AshDisturbanceEffectV2 initialize failed:', err);
    }
    _reportProgress('AshDisturbanceEffectV2');

    // Smelly flies uses the particles bridge batch renderer and should render
    // in the bus scene for V2.
    try { this._smellyFliesEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera); } catch (err) {
      log.warn('FloorCompositor: SmellyFliesEffect initialize failed:', err);
    }
    _reportProgress('SmellyFliesEffect');
    // Lightning renders procedural strike meshes in the bus scene.
    try { this._lightningEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera); } catch (err) {
      log.warn('FloorCompositor: LightningEffectV2 initialize failed:', err);
    }
    _reportProgress('LightningEffectV2');

    // Candle flames render in bus scene and push glow into lighting lightScene.
    try {
      this._candleFlamesEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera);
      this._candleFlamesEffect?.setLightingEffect?.(this._lightingEffect);
    } catch (err) {
      log.warn('FloorCompositor: CandleFlamesEffectV2 initialize failed:', err);
    }
    _reportProgress('CandleFlamesEffectV2');

    // Player light renders token-attached flashlight/torch effects and drives
    // gameplay-facing dynamic light behavior.
    try {
      this._playerLightEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera);
    } catch (err) {
      log.warn('FloorCompositor: PlayerLightEffectV2 initialize failed:', err);
    }
    _reportProgress('PlayerLightEffectV2');

    // Subscribe outdoors mask consumers so they receive the texture as soon as
    // populate() builds it, and again on every floor change.
    // CloudEffectV2: cloud shadows and cloud tops only fall on outdoor areas.
    // We set both the legacy single-texture path (setOutdoorsMask, which is the one
    // Outdoors mask subscribers now wired via EffectMaskRegistry in initialize()

    initEffect('LightingEffectV2', () => this._lightingEffect.initialize(w, h));
    initEffect('SkyColorEffectV2', () => this._skyColorEffect.initialize());
    initEffect('ColorCorrectionEffectV2', () => this._colorCorrectionEffect.initialize());
    initEffect('FilterEffectV2', () => this._filterEffect.initialize());
    initEffect('AtmosphericFogEffectV2', () => this._atmosphericFogEffect.initialize(this.renderer, this._renderBus._scene, this.camera));
    initEffect('FogOfWarEffectV2', () => this._fogEffect.initialize(this.renderer, this.scene, this.camera));
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
    initEffect('BloomEffectV2', () => this._bloomEffect.initialize(w, h));
    initEffect('SharpenEffectV2', () => this._sharpenEffect.initialize());
    if (this._waterEffect) {
      initEffect('WaterEffectV2', () => this._waterEffect.initialize());
    } else {
      _reportProgress('WaterEffectV2');
    }
    // OverheadShadowsEffectV2 initialization
    try { 
      this._overheadShadowEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera, null);
    } catch (err) {
      log.warn('FloorCompositor: OverheadShadowsEffectV2 initialize failed:', err);
    }
    _reportProgress('OverheadShadowsEffectV2');
    try {
      this._buildingShadowEffect?.initialize?.(this.renderer, this.camera);
    } catch (err) {
      log.warn('FloorCompositor: BuildingShadowsEffectV2 initialize failed:', err);
    }
    _reportProgress('BuildingShadowsEffectV2');

    // Artistic post-processing effects (disabled by default)
    try { this._dotScreenEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: DotScreenEffectV2 initialize failed:', err);
    }
    _reportProgress('DotScreenEffectV2');
    try { this._halftoneEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: HalftoneEffectV2 initialize failed:', err);
    }
    _reportProgress('HalftoneEffectV2');
    try { this._asciiEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: AsciiEffectV2 initialize failed:', err);
    }
    _reportProgress('AsciiEffectV2');
    try { this._dazzleOverlayEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: DazzleOverlayEffectV2 initialize failed:', err);
    }
    _reportProgress('DazzleOverlayEffectV2');
    try { this._visionModeEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: VisionModeEffectV2 initialize failed:', err);
    }
    _reportProgress('VisionModeEffectV2');
    try { this._invertEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: InvertEffectV2 initialize failed:', err);
    }
    _reportProgress('InvertEffectV2');
    try { this._sepiaEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: SepiaEffectV2 initialize failed:', err);
    }
    _reportProgress('SepiaEffectV2');
    try { this._lensEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: LensEffectV2 initialize failed:', err);
    }
    _reportProgress('LensEffectV2');
    initEffect('DistortionManagerV2', () => this._distortionEffect.initialize(this.renderer, this._renderBus._scene, this.camera));

    try {
      if (window.MapShine) window.MapShine.distortionManager = this._distortionEffect;
    } catch (_) {}

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
      let reason = 'none';
      const hasVisibleOverlay = (effect) => {
        const overlays = effect?._overlays;
        if (!(overlays instanceof Map) || overlays.size <= 0) return false;
        for (const entry of overlays.values()) {
          const mesh = entry?.mesh;
          if (mesh && mesh.visible !== false) return true;
        }
        return false;
      };
      // Animated shader overlay: if any fluid overlays exist, we need continuous
      // render so uTime advances and the effect animates.
      const fluid = this._fluidEffect;
      if (fluid?.enabled && fluid?.params?.enabled !== false && hasVisibleOverlay(fluid)) {
        reason = 'fluid:overlays';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const iridescence = this._iridescenceEffect;
      if (iridescence?.enabled && iridescence?.params?.enabled !== false && hasVisibleOverlay(iridescence)) {
        reason = 'iridescence:overlays';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const prism = this._prismEffect;
      if (prism?.enabled && prism?.params?.enabled !== false && hasVisibleOverlay(prism)) {
        reason = 'prism:overlays';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const bush = this._bushEffect;
      if (bush?.enabled && bush?.params?.enabled !== false && hasVisibleOverlay(bush)) {
        reason = 'bush:overlays';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const tree = this._treeEffect;
      if (tree?.enabled && tree?.params?.enabled !== false && hasVisibleOverlay(tree)) {
        reason = 'tree:overlays';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const fire = this._fireEffect;
      if (fire?.enabled && fire._activeFloors?.size > 0) {
        reason = 'fire:active-floors';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const dust = this._dustEffect;
      if (dust?.enabled && dust._activeFloors?.size > 0) {
        reason = 'dust:active-floors';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const splash = this._waterSplashesEffect;
      if (splash?.enabled && splash._activeFloors?.size > 0) {
        reason = 'splashes:active-floors';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const flies = this._smellyFliesEffect;
      if (flies?.enabled && (flies?.flySystems?.size ?? 0) > 0) {
        reason = 'flies:systems';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const lightning = this._lightningEffect;
      if (lightning?.enabled && lightning?.wantsContinuousRender?.()) {
        reason = 'lightning:wants-continuous';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const candles = this._candleFlamesEffect;
      if (candles?.enabled && ((candles?._sourceFlameCount ?? 0) > 0 || (candles?._glowBuckets?.size ?? 0) > 0)) {
        reason = 'candles:active-sources';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const playerLight = this._playerLightEffect;
      const playerLightActive = !!(
        playerLight?.enabled
        && playerLight?.params?.enabled
        && (
          playerLight?._torchWasActiveLastFrame === true
          || ((Number(playerLight?._flashlightFinalIntensity) || 0) > 1e-4)
          || playerLight?._torchParticleSystem?.emitter?.visible === true
          || playerLight?._torchSparksSystem?.emitter?.visible === true
          || playerLight?._flashlightBeamMesh?.visible === true
        )
      );
      if (playerLightActive) {
        reason = 'playerLight:active';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const lens = this._lensEffect;
      if (lens?.enabled && ((Number(lens?.params?.grainAmount) || 0) > 0) && ((Number(lens?.params?.grainSpeed) || 0) > 0)) {
        reason = 'lens:grain';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
      return false;
    } catch (_) {
      // Fail safe: if anything about the probe throws, treat as active.
      if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = 'probe-error';
      return true;
    }
  }

  /**
   * Optional adaptive-FPS hint for RenderLoop.
   * Return 0 when no override is needed.
   *
   * @returns {number}
   */
  getPreferredContinuousFps() {
    try {
      const fluid = this._fluidEffect;
      if (fluid?.enabled && (fluid?._overlays?.size ?? 0) > 0) {
        // Fluid shader animation looks noticeably stepped at 30fps.
        // Prefer 60fps while fluid overlays are active.
        return 60;
      }
    } catch (_) {
    }
    return 0;
  }

  /**
   * @param {string} maskId
   * @returns {boolean}
   * @private
   */
  _hasSceneMaskHint(maskId) {
    const id = String(maskId || '').trim().toLowerCase();
    if (!id) return false;
    const hints = this._effectHints;
    if (!hints) return false;
    const source = hints.maskIds;
    if (source instanceof Set) return source.has(id);
    if (Array.isArray(source)) return source.some((x) => String(x || '').trim().toLowerCase() === id);
    return false;
  }

  /**
   * Decide if a compositor effect should be included in shader warmup.
   * This only affects upfront compile cost; runtime behavior is unchanged.
   *
   * @param {string} effectKey
   * @returns {boolean}
   * @private
   */
  _shouldWarmupEffectKey(effectKey) {
    const effect = this[effectKey];
    if (!effect) return false;

    // Respect explicit runtime disable states when available.
    if (effect?.enabled === false) return false;
    if (effect?.params?.enabled === false) return false;

    const maskDriven = {
      _specularEffect: ['specular'],
      _fluidEffect: ['fluid'],
      _iridescenceEffect: ['iridescence'],
      _prismEffect: ['prism'],
      _bushEffect: ['bush'],
      _treeEffect: ['tree'],
      _fireEffect: ['fire'],
      _dustEffect: ['dust'],
      _windowLightEffect: ['windows', 'structural'],
    };

    if (Object.prototype.hasOwnProperty.call(maskDriven, effectKey)) {
      const ids = maskDriven[effectKey];
      return ids.some((id) => this._hasSceneMaskHint(id));
    }

    // Water compile should depend on discovered data, not scene bundle hints.
    // The scene bundle intentionally omits _Water in V2.
    if (effectKey === '_waterEffect') {
      try {
        if (typeof effect.hasRenderableWater === 'function') {
          return effect.hasRenderableWater();
        }
      } catch (_) {}
      return false;
    }
    if (effectKey === '_waterSplashesEffect') {
      try {
        const water = this._waterEffect;
        if (water && typeof water.hasRenderableWater === 'function') {
          return water.hasRenderableWater();
        }
      } catch (_) {}
      return false;
    }

    return true;
  }

  /**
   * Explicit loading-time prewarm entrypoint.
   *
   * Runs the one-time populate work that used to happen lazily on first render,
   * then optionally cycles floor visibility across all bands so floor-scoped
   * systems are touched before gameplay starts.
   *
   * @param {object} [options]
   * @param {boolean} [options.prewarmAllFloors=false]
   * @param {boolean} [options.awaitPopulate=false]
   * @returns {Promise<boolean>}
   */
  async prewarmForLoading(options = {}) {
    const { prewarmAllFloors = false, awaitPopulate = false } = options;
    const populatePromise = this._ensureBusPopulated({ source: 'loading' });
    if (!awaitPopulate) {
      return true;
    }
    const ok = await populatePromise;
    if (ok && prewarmAllFloors) {
      this._prewarmFloorVisibilityPasses();
    }
    return ok;
  }

  /**
   * Ensure render bus + async effect population run exactly once.
   *
   * @param {object} [options]
   * @param {string} [options.source='runtime']
   * @returns {Promise<boolean>}
   * @private
   */
  async _ensureBusPopulated(options = {}) {
    const { source = 'runtime' } = options;
    if (this._populateComplete) return true;
    if (this._populatePromise) return this._populatePromise;

    this._populatePromise = (async () => {
      const sc = window.MapShine?.sceneComposer ?? null;
      if (!sc) {
        log.warn(`FloorCompositor: no sceneComposer available for populate (${source})`);
        return false;
      }

      if (!this._busPopulated) {
        this._renderBus.populate(sc);
        this._busPopulated = true;
      }

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

      const populateJobs = [
        ['SpecularEffectV2', () => this._specularEffect.populate(sc.foundrySceneData)],
        ['FluidEffectV2', () => this._fluidEffect.populate(sc.foundrySceneData)],
        ['IridescenceEffectV2', () => this._iridescenceEffect.populate(sc.foundrySceneData)],
        ['PrismEffectV2', () => this._prismEffect.populate(sc.foundrySceneData)],
        ['BushEffectV2', () => this._bushEffect.populate(sc.foundrySceneData)],
        ['TreeEffectV2', () => this._treeEffect.populate(sc.foundrySceneData)],
        ['FireEffectV2', () => this._fireEffect.populate(sc.foundrySceneData)],
        ['DustEffectV2', () => this._dustEffect.populate(sc.foundrySceneData)],
        ['WindowLightEffectV2', () => this._windowLightEffect.populate(sc.foundrySceneData)],
      ];

      if (this._waterEffect) {
        populateJobs.push(['WaterEffectV2', () => this._waterEffect.populate(sc.foundrySceneData)]);
      }
      if (this._waterSplashesEffect) {
        populateJobs.push(['WaterSplashesEffectV2', () => this._waterSplashesEffect.populate(sc.foundrySceneData)]);
      }
      if (this._waterGlitterEffect) {
        populateJobs.push(['WaterGlitterEffectV2', () => this._waterGlitterEffect.populate(sc.foundrySceneData)]);
      }
      if (this._ashDisturbanceEffect) {
        populateJobs.push(['AshDisturbanceEffectV2', () => this._ashDisturbanceEffect.populate(sc.foundrySceneData)]);
      }

      for (const [label, fn] of populateJobs) {
        try {
          await fn();
        } catch (err) {
          log.error(`${label} populate failed:`, err);
        }
        try { this._applyCurrentFloorVisibility(); } catch (_) {}
        // Give the browser/event loop a chance to process socket + UI work
        // between heavy floor/effect populate steps.
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      // Initial attempt; render-time guard above re-attempts when globals land.
      this._wireMapPointConsumers();
      // Push current outdoors mask immediately; async compositor cache warmup
      // can still update this later via the per-frame sync below.
      this._syncOutdoorsMaskConsumers({
        context: window.MapShine?.activeLevelContext ?? null,
        force: true,
      });

      this._populateComplete = true;
      return true;
    })().finally(() => {
      // Allow retry if the attempt failed or aborted before completion.
      // Without this, a single early false/rejection can permanently block
      // particle/effect population for the session until full refresh.
      if (!this._populateComplete) {
        this._populatePromise = null;
      }
    });

    return this._populatePromise;
  }

  /**
   * Run floor visibility notifications across all floors once, then restore
   * the currently active context. This touches floor-scoped states during load.
   *
   * @private
   */
  _prewarmFloorVisibilityPasses() {
    const floorStack = window.MapShine?.floorStack;
    const floors = floorStack?.getFloors?.() ?? [];
    if (!floors.length) return;

    const originalContext = window.MapShine?.activeLevelContext ?? null;
    for (const floor of floors) {
      this._applyCurrentFloorVisibility({
        context: {
          bottom: Number(floor?.elevationMin),
          top: Number(floor?.elevationMax),
        },
      });
    }
    this._applyCurrentFloorVisibility({ context: originalContext });
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  /**
   * Asynchronously compiles all shaders used by the compositor and its effects.
   * This prevents the main thread from freezing when the first frame renders.
   *
   * It traverses all scenes (including the FloorRenderBus scene which contains
   * meshes for all floors, visible or not), so materials for all floors are compiled.
   *
   * Uses KHR_parallel_shader_compile when available so GPU compilation runs
   * in a driver thread without blocking the browser main thread. Progress is
   * reported via onProgress by polling renderer.info.programs readiness every 32ms.
   *
   * @param {number} [timeoutMs=8000] - Maximum time to wait for compilation
   * @param {((progress: number, label: string) => void)|null} [onProgress] - Optional
   *   callback fired ~30× per second with (0..1 progress, status label)
   * @returns {Promise<boolean>} True if completed fully, false if timed out or failed
   */
  async warmupAsync(timeoutMs = 8000, onProgress = null) {
    if (!this.renderer || typeof this.renderer.compileAsync !== 'function') {
      log.warn('warmupAsync: renderer.compileAsync is not available');
      return false;
    }

    const targets = [];
    const seenTargets = new Set();
    const pushTarget = (scene, camera, label = 'unknown') => {
      if (!scene || scene.isScene !== true) return;
      if (!camera || camera.isCamera !== true) return;
      const key = `${scene.uuid || label}:${camera.uuid || 'no-camera-uuid'}`;
      if (seenTargets.has(key)) return;
      seenTargets.add(key);
      targets.push({ scene, camera, label });
    };

    // 1. Add bus scene (contains all tile/overlay materials across all floors)
    if (this._renderBus && this._renderBus._scene) {
      pushTarget(this._renderBus._scene, this.camera, 'FloorRenderBus');
    }

    // 2. Add full-screen quad scene used for compositing
    if (this._scene) {
      pushTarget(this._scene, this.camera, 'FloorCompositorMain');
    }

    // 3. Sniff scenes from all registered effects
    const effectKeys = [
      '_specularEffect', '_fluidEffect', '_iridescenceEffect', '_prismEffect',
      '_bushEffect', '_treeEffect', '_fireEffect', '_dustEffect', '_windowLightEffect',
      '_lightingEffect', '_skyColorEffect', '_colorCorrectionEffect',
      '_filterEffect', '_atmosphericFogEffect', '_fogEffect', '_bloomEffect',
      '_sharpenEffect', '_cloudEffect', '_shadowManagerEffect', '_waterEffect', '_waterSplashesEffect',
      '_waterGlitterEffect', '_underwaterBubblesEffect', '_ashDisturbanceEffect', '_smellyFliesEffect',
      '_lightningEffect', '_candleFlamesEffect', '_playerLightEffect',
      '_overheadShadowEffect', '_buildingShadowEffect', '_dotScreenEffect',
      '_halftoneEffect', '_asciiEffect', '_dazzleOverlayEffect',
      '_visionModeEffect', '_invertEffect', '_sepiaEffect', '_lensEffect',
      '_movementPreviewEffect',
      '_floorDepthBlurEffect',
    ];

    for (const key of effectKeys) {
      if (!this._shouldWarmupEffectKey(key)) continue;
      const effect = this[key];
      if (!effect) continue;

      if (typeof effect.getCompileTargets === 'function') {
        const effectTargets = effect.getCompileTargets();
        for (const target of effectTargets) {
          if (target) {
            pushTarget(target.scene, target.camera, `${key}.getCompileTargets`);
          }
        }
      } else {
        // Fallback: sniff common scene properties
        const scenes = [
          effect._composeScene, effect._quadScene, effect._scene, effect._cloudLayerScene,
          effect._lightScene, effect._darknessScene, effect._passThroughScene,
          effect._waterDataPackScene
        ];
        // Camera is usually _composeCamera, _quadCamera, or this.camera
        const camera = effect._composeCamera || effect._quadCamera || effect._camera || this.camera;
        for (const s of scenes) {
          pushTarget(s, camera, `${key}.fallback`);
        }
      }
    }

    if (targets.length === 0) {
      if (onProgress) try { onProgress(1.0, 'Shaders: 0/0'); } catch (_) {}
      return true;
    }

    log.info(`warmupAsync: starting compilation for ${targets.length} scenes...`);

    const cameraMasks = new Map();
    let _pollingActive = false;
    try {
      const enableAllLayers = (camera) => {
        if (!camera || camera.isCamera !== true || !camera.layers) return;
        if (cameraMasks.has(camera)) return;
        cameraMasks.set(camera, camera.layers.mask);
        camera.layers.enableAll();
      };

      // Compile with all layers enabled so hidden floors also warm up.
      enableAllLayers(this.camera);

      // Submit all compile jobs. renderer.compileAsync calls renderer.compile()
      // synchronously inside, which submits all programs to the GPU driver.
      // After these calls, all programs exist in renderer.info.programs.
      const promises = [];
      for (const target of targets) {
        enableAllLayers(target.camera);
        try {
          const p = this.renderer.compileAsync(target.scene, target.camera)
            .catch((err) => {
              log.warn(`warmupAsync: compileAsync failed for target ${target.label}`, err);
            });
          promises.push(p);
        } catch (err) {
          log.warn(`warmupAsync: compileAsync threw synchronously for target ${target.label}`, err);
        }
      }

      if (promises.length === 0) {
        log.warn('warmupAsync: no valid compile targets');
        return false;
      }

      // Snapshot total program count now that compile() has submitted them.
      const getPrograms = () => this.renderer.info?.programs ?? [];
      const totalAtSubmit = getPrograms().length;
      log.info(`warmupAsync: ${totalAtSubmit} programs submitted`);

      // Parallel polling loop: report KHR_parallel_shader_compile readiness at ~30fps.
      // Without the extension isReady() returns true immediately (programs stall on
      // first draw instead) — progress still jumps to 100% quickly, which is correct.
      _pollingActive = true;
      const pollLoop = (async () => {
        while (_pollingActive) {
          if (onProgress) {
            const progs = getPrograms();
            const total = Math.max(progs.length, totalAtSubmit, 1);
            let ready = 0;
            for (const p of progs) {
              try { if (typeof p.isReady === 'function' ? p.isReady() : true) ready++; } catch (_) { ready++; }
            }
            try { onProgress(Math.min(ready / total, 1.0), `Shaders: ${ready}/${total}`); } catch (_) {}
            if (ready >= total) break;
          }
          await new Promise(r => setTimeout(r, 32));
        }
      })();

      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
      const result = await Promise.race([Promise.all([...promises, pollLoop]), timeoutPromise]);
      _pollingActive = false;

      if (result === 'timeout') {
        log.warn(`warmupAsync: shader compilation timed out after ${timeoutMs}ms, proceeding with lazy compilation`);
        // Report final achieved progress on timeout.
        if (onProgress) {
          const progs = getPrograms();
          const total = Math.max(progs.length, 1);
          let ready = 0;
          for (const p of progs) {
            try { if (typeof p.isReady === 'function' ? p.isReady() : true) ready++; } catch (_) { ready++; }
          }
          try { onProgress(Math.min(ready / total, 1.0), `Shaders: ${ready}/${total} (timeout)`); } catch (_) {}
        }
        return false;
      }

      // Final 100% report.
      const finalCount = getPrograms().length;
      if (onProgress) try { onProgress(1.0, `Shaders: ${finalCount}/${finalCount}`); } catch (_) {}
      log.info(`warmupAsync: shader compilation finished (${finalCount} programs)`);
      return true;
    } catch (err) {
      _pollingActive = false;
      log.error('warmupAsync: error during shader compilation', err);
      return false;
    } finally {
      _pollingActive = false;
      for (const [camera, mask] of cameraMasks.entries()) {
        try { camera.layers.mask = mask; } catch (_) {}
      }
    }
  }

  /**
   * Combine cloud (may be null / previous frame) + overhead + building into
   * ShadowManagerV2's screen-space RT for consumers that draw before the cloud pass.
   * @param {THREE.Texture|null} cloudTex
   * @param {THREE.Texture|null} cloudRawTex
   * @param {boolean} disableOverheadInLighting
   */
  _runShadowManagerCombinePass(cloudTex, cloudRawTex, disableOverheadInLighting) {
    const sm = this._shadowManagerEffect;
    if (!sm || typeof sm.setInputs !== 'function' || typeof sm.render !== 'function') return;
    const overheadTex = (!disableOverheadInLighting && this._overheadShadowEffect?.params?.enabled)
      ? (this._overheadShadowEffect.shadowFactorTexture ?? null)
      : null;
    const buildingTex = (this._buildingShadowEffect?.params?.enabled)
      ? (this._buildingShadowEffect.shadowFactorTexture ?? null)
      : null;
    sm.setInputs({
      cloudShadowTexture: cloudTex ?? null,
      cloudShadowRawTexture: cloudRawTex ?? null,
      overheadShadowTexture: overheadTex,
      buildingShadowTexture: buildingTex,
    });
    try {
      const dims = globalThis.canvas?.dimensions;
      if (dims) {
        const rect = dims.sceneRect ?? dims;
        const sx = rect?.x ?? dims.sceneX ?? 0;
        const sy = rect?.y ?? dims.sceneY ?? 0;
        const sw = rect?.width ?? dims.sceneWidth ?? dims.width ?? 1;
        const sh = rect?.height ?? dims.sceneHeight ?? dims.height ?? 1;
        sm.setSceneRect({ x: sx, y: sy, z: sw, w: sh });
      }
    } catch (_) {}
    try {
      sm.render(this.renderer);
    } catch (err) {
      log.warn('FloorCompositor: ShadowManagerV2 render failed:', err);
    }
  }

  /**
   * Open the shader warmup gate, allowing time to advance in all effects.
   * Call this after warmupAsync() resolves so all systems start simultaneously
   * from t=0 rather than catching up on accumulated missed time.
   */
  openShaderGate() {
    if (this._shaderWarmupGateOpen) return;
    this._shaderWarmupGateOpen = true;
    log.info('FloorCompositor: shader warmup gate opened — time now advancing');
  }

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

    // Update PIXI-content bridge once per compositor frame.
    try {
      const bridge = window.MapShine?.pixiContentLayerBridge ?? null;
      bridge?.update?.();
    } catch (_) {
    }

    // Keep map-point-driven effects (flies/lightning/candles) wired even if
    // MapPointsManager is exposed on window.MapShine after the first render.
    this._wireMapPointConsumers();

    // Rewire tile projection source through the V2 compositor dependency path.
    // This keeps OverheadShadowsEffectV2 independent from global lookups.
    try {
      this._overheadShadowEffect?.setTileMotionManager?.(window.MapShine?.tileMotionManager ?? null);
    } catch (_) {}

    // ── Lazy fallback: if loading-time prewarm didn't run, kick it off here. ──
    if (!this._populateComplete) {
      void this._ensureBusPopulated({ source: 'render' });
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
      // Treat finite-bottom + non-finite-top as distinct (topmost Levels band).
      const key = Number.isFinite(b)
        ? `${b}:${Number.isFinite(t) ? t : 'inf'}`
        : 'single';
      if (this._lastAppliedLevelContextKey !== key) {
        this._lastAppliedLevelContextKey = key;
        if (this._busPopulated) {
          this._applyCurrentFloorVisibility({ context: ctx });
        }
      }
    } catch (_) {}

    // Enforce bus floor visibility every frame to prevent stale/leaked tile
    // visibility after asynchronous tile upserts or late scene updates.
    this._enforceBusVisibilityForActiveFloor(floorStack);
    // Enforce TileManager sprite floor visibility in parallel. Even in V2, stale
    // sprite visibility can leak upper-floor art if other paths render sprites.
    this._enforceTileSpriteVisibilityForActiveFloor(floorStack);

    // Keep outdoors consumers in sync even when the compositor cache populates
    // asynchronously after initial render, or when floor-context hooks were missed.
    this._syncOutdoorsMaskConsumers({ context: window.MapShine?.activeLevelContext ?? null });

    // ── Update effects (time-varying uniforms) ───────────────────────────
    // Freeze delta to 0 while the shader warmup gate is closed. This prevents
    // particles, wind, and waves from accumulating time during the warmup window
    // so all systems start cleanly from t=0 when the scene first becomes visible.
    if (!this._shaderWarmupGateOpen && timeInfo) {
      timeInfo = { ...timeInfo, delta: 0 };
    }
    if (timeInfo) {
      // Wind must advance before update() so accumulation is 1× per frame.
      this._cloudEffect.advanceWind(timeInfo.delta ?? 0.016);
      this._specularEffect.update(timeInfo);
      try { this._fluidEffect.update(timeInfo); } catch (err) {
        log.warn('FluidEffectV2 update threw, skipping fluid update:', err);
      }
      try { this._iridescenceEffect.update(timeInfo); } catch (err) {
        log.warn('IridescenceEffectV2 update threw, skipping iridescence update:', err);
      }
      try { this._prismEffect.update(timeInfo); } catch (err) {
        log.warn('PrismEffectV2 update threw, skipping prism update:', err);
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
        this._dustEffect.update(timeInfo);
      } catch (err) {
        log.warn('DustEffectV2 update threw, skipping frame:', err);
      }
      try {
        this._waterSplashesEffect?.update?.(timeInfo);
      } catch (err) {
        log.warn('WaterSplashesEffectV2 update threw, skipping frame:', err);
      }
      try {
        this._waterGlitterEffect?.update?.(timeInfo);
      } catch (err) {
        log.warn('WaterGlitterEffectV2 update threw, skipping frame:', err);
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
        this._playerLightEffect?.update?.(timeInfo);
      } catch (err) {
        log.warn('PlayerLightEffectV2 update threw, skipping frame:', err);
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
      const skyIntensity01 = Number(this._skyColorEffect?._composeMaterial?.uniforms?.uIntensity?.value);
      const weatherEnv = weatherController?.getEnvironment?.() ?? null;
      const sceneDarknessRaw = Number(canvas?.scene?.environment?.darknessLevel);
      const envDarknessRaw = Number(canvas?.environment?.darknessLevel);
      const sceneDarkness01 = Number.isFinite(sceneDarknessRaw)
        ? Math.max(0.0, Math.min(1.0, sceneDarknessRaw))
        : (Number.isFinite(envDarknessRaw) ? Math.max(0.0, Math.min(1.0, envDarknessRaw)) : undefined);
      const effectiveDarknessRaw = Number(weatherEnv?.effectiveDarkness);
      const effectiveDarkness01 = Number.isFinite(effectiveDarknessRaw)
        ? Math.max(0.0, Math.min(1.0, effectiveDarknessRaw))
        : undefined;
      try {
        this._windowLightEffect?.setSkyState?.({
          skyTintColor: this._skyColorEffect?.currentSkyTintColor,
          sunAzimuthDeg: this._skyColorEffect?.currentSunAzimuthDeg,
          skyIntensity01: Number.isFinite(skyIntensity01) ? Math.max(0.0, Math.min(1.0, skyIntensity01)) : 1.0,
          sceneDarkness01,
          effectiveDarkness01,
        });
      } catch (_) {}
      try {
        this._dustEffect?.setSkyState?.({
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
      this._sharpenEffect.update(timeInfo);
      // Artistic post-processing effects
      try { this._dotScreenEffect?.update?.(timeInfo); } catch (_) {}
      try { this._halftoneEffect?.update?.(timeInfo); } catch (_) {}
      try { this._asciiEffect?.update?.(timeInfo); } catch (_) {}
      try { this._dazzleOverlayEffect?.update?.(timeInfo); } catch (_) {}
      try { this._visionModeEffect?.update?.(timeInfo); } catch (_) {}
      try { this._invertEffect?.update?.(timeInfo); } catch (_) {}
      try { this._sepiaEffect?.update?.(timeInfo); } catch (_) {}
      try { this._lensEffect?.update?.(timeInfo); } catch (_) {}
      try { this._distortionEffect?.update?.(timeInfo); } catch (_) {}
      // Overhead shadows: update sun direction + uniform params from controls.
      try { this._overheadShadowEffect?.update?.(timeInfo); } catch (err) {
        log.warn('OverheadShadowsEffectV2 update threw, skipping overhead shadow update:', err);
      }
      // Building shadows: must run update() here — unlike most effects, render() can
      // return before calling update() (no compositor / disabled / RT not ready).
      // HealthEvaluator + uniform freshness rely on this path every frame.
      try { this._buildingShadowEffect?.update?.(timeInfo); } catch (err) {
        log.warn('BuildingShadowsEffectV2 update threw, skipping building shadow update:', err);
      }

    }

    // ── Bind per-frame textures and camera to effects ────────────────────────
    this._specularEffect.render(this.renderer, this.camera);
    this._iridescenceEffect.render(this.renderer, this.camera);
    this._prismEffect.render(this.renderer, this.camera);

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

    // P4: Per-pass profiler — toggled via MapShine.__v2PassProfiler.
    // When active, each _profileStart/_profileEnd pair records wall-clock ms.
    const _profiling = !!window.MapShine?.__v2PassProfiler;
    // Runtime alpha/isolation bisect flags (all optional, all default false).
    // Usage: window.MapShine.__alphaIsolationDebug = { skipLensPass: true, ... }.
    const _alphaIsoDebug = window.MapShine?.__alphaIsolationDebug ?? null;
    const _skipCloudPass = _alphaIsoDebug?.skipCloudPass === true;
    const _skipOverheadShadowPass = _alphaIsoDebug?.skipOverheadShadowPass === true;
    const _skipBuildingShadowPass = _alphaIsoDebug?.skipBuildingShadowPass === true;
    const _disableOverheadInLighting = _alphaIsoDebug?.disableOverheadInLighting === true;
    const _disableRoofInLighting = _alphaIsoDebug?.disableRoofInLighting === true;
    const _skipWaterPass = _alphaIsoDebug?.skipWaterPass === true;
    const _disableWaterOccluder = _alphaIsoDebug?.disableWaterOccluder === true;
    const _skipLensPass = _alphaIsoDebug?.skipLensPass === true;
    if (_profiling && !this._passTimings) {
      this._passTimings = {};
    } else if (!_profiling && this._passTimings) {
      this._passTimings = null;
    }
    let _profileT0 = 0;

    // Levels / floor snapshot for the whole frame — must exist before overhead and
    // building shadow passes so they agree with lighting compose (same active floor).
    try {
      this._lightingPerspectiveContext = createLightingPerspectiveContext();
      this._lightingEffect?.setLightingPerspectiveContext?.(this._lightingPerspectiveContext);
    } catch (_) {
      this._lightingPerspectiveContext = null;
      this._lightingEffect?.setLightingPerspectiveContext?.(null);
    }

    // Keep bus tile materials aligned to live TileManager sprite opacity before
    // shadow capture. OverheadShadowsEffectV2 now handles its own stable caster
    // capture internally (forced-opacity roofTarget pass), while the separate
    // roof-visibility pass must see runtime fade alpha to avoid stale clipping
    // holes in building shadows.
    try {
      this._renderBus?.syncRuntimeTileState?.();
    } catch (_) {}

    // Capture overhead tile alpha + compute soft shadow factor for lighting / ShadowManager.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: overheadShadows.render'); } catch (_) {} }
    if (_profiling) _profileT0 = performance.now();
    if (!_skipOverheadShadowPass) {
      try {
        this._overheadShadowEffect?.render?.(this.renderer, this._renderBus._scene, this.camera);
      } catch (err) {
        log.warn('OverheadShadowsEffectV2 render threw, skipping overhead shadow pass:', err);
      }
    }
    if (_profiling) this._recordPassTiming('overheadShadowsRender', _profileT0);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: overheadShadows.render DONE'); } catch (_) {} }

    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: buildingShadows.render'); } catch (_) {} }
    if (_profiling) _profileT0 = performance.now();
    if (!_skipBuildingShadowPass) {
      try {
        this._buildingShadowEffect?.render?.(this.renderer, this.camera);
      } catch (err) {
        log.warn('BuildingShadowsEffectV2 render threw, skipping building shadow pass:', err);
      }
    }
    if (_profiling) this._recordPassTiming('buildingShadowsRender', _profileT0);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: buildingShadows.render DONE'); } catch (_) {} }

    // ShadowManagerV2 (required): combine previous-frame cloud + current structural
    // shadows so water splash/bubble particles can sample the same darkening the
    // lit scene uses, before the bus draws them.
    try {
      this._runShadowManagerCombinePass(
        this._shadowManagerPrevFrameCloudTex,
        this._shadowManagerPrevFrameCloudRawTex ?? this._shadowManagerPrevFrameCloudTex,
        _disableOverheadInLighting
      );
    } catch (err) {
      log.warn('FloorCompositor: pre-bus ShadowManagerV2 combine failed:', err);
    }
    try { this._waterSplashesEffect?.syncShadowDarkeningUniforms?.(); } catch (err) {
      log.warn('WaterSplashesEffectV2 syncShadowDarkeningUniforms threw, skipping:', err);
    }

    // Runtime tile opacity already synced before shadow capture above. Keep the
    // value as-is for the main albedo render.

    // ── Step 1: Render bus scene → sceneRT ───────────────────────────────
    // The bus scene contains albedo tiles + specular/fire overlays.
    // Window light is NOT in the bus scene — it renders after lighting.
    //
    // When floor depth blur is enabled and the player is above floor 0,
    // FloorDepthBlurEffect handles the bus render internally: it renders
    // each below-floor separately, applies progressive Kawase blur, composites
    // them, then renders the active+above floors sharp on top — all writing
    // the final result into _sceneRT.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: bus.renderTo(sceneRT)'); } catch (_) {} }
    if (_profiling) _profileT0 = performance.now();
    {
      // Use the bus's already-authoritative value (set by _applyCurrentFloorVisibility).
      // Guard against the Infinity default (single-floor / not yet initialised) to prevent
      // the per-floor loop in FloorDepthBlurEffect from running indefinitely.
      const activeFloorIndex = Number.isFinite(this._renderBus._visibleMaxFloorIndex)
        ? this._renderBus._visibleMaxFloorIndex
        : 0;
      const blurEnabled = this._floorDepthBlurEffect?.params.enabled && activeFloorIndex > 0;
      if (blurEnabled) {
        this._floorDepthBlurEffect.render(
          this.renderer, this.camera, this._renderBus, activeFloorIndex, this._sceneRT);
      } else {
        this._renderBus.renderTo(this.renderer, this.camera, this._sceneRT);
      }
    }
    if (_profiling) this._recordPassTiming('busRender', _profileT0);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: bus.renderTo(sceneRT) DONE'); } catch (_) {} }

    // ── Cloud passes (before lighting) ───────────────────────────────────
    // Must run after bus render. Cloud shadow RT includes overhead blockers and
    // a floors-above-active mask; ShadowManagerV2 still composes overhead + cloud.
    // Outputs: _cloudEffect.cloudShadowTexture (fed into lighting compose shader)
    //          _cloudEffect._cloudTopRT        (blitted after lighting)
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: cloud.render'); } catch (_) {} }
    if (_profiling) _profileT0 = performance.now();
    if (!_skipCloudPass && this._cloudEffect.enabled && this._cloudEffect.params.enabled) {
      this._cloudEffect.render(this.renderer);
    }
    {
      const cloudTex = (!_skipCloudPass && this._cloudEffect.enabled && this._cloudEffect.params.enabled)
        ? this._cloudEffect.cloudShadowTexture
        : null;
      const cloudRawTex = (!_skipCloudPass && this._cloudEffect.enabled && this._cloudEffect.params.enabled)
        ? (this._cloudEffect.cloudShadowRawTexture ?? this._cloudEffect.cloudShadowTexture)
        : null;
      try {
        this._runShadowManagerCombinePass(cloudTex, cloudRawTex, _disableOverheadInLighting);
      } catch (err) {
        log.warn('FloorCompositor: post-cloud ShadowManagerV2 combine failed:', err);
      }
      this._shadowManagerPrevFrameCloudTex = cloudTex ?? null;
      this._shadowManagerPrevFrameCloudRawTex = cloudRawTex ?? null;
    }
    if (_profiling) this._recordPassTiming('cloudRender', _profileT0);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: cloud.render DONE'); } catch (_) {} }

    // ── Step 2: Post-processing chain ────────────────────────────────────
    // Post effects read sceneRT and chain through _postA/_postB.
    // `currentInput` tracks which RT holds the latest result.
    let currentInput = this._sceneRT;

    // Lighting pass: sceneRT → postA.
    // Window scene renders to its own RT; compose merges it with Foundry lights
    // (per-channel roof gating by active floor).
    // Cloud shadow RT is also passed so illumination is multiplied by the shadow factor.
    const winScene = this._windowLightEffect.enabled
      ? this._windowLightEffect._scene : null;
    const cloudShadowTexLegacy = (this._cloudEffect.enabled && this._cloudEffect.params.enabled)
      ? this._cloudEffect.cloudShadowTexture : null;
    const windowCloudShadowTexLegacy = (this._cloudEffect.enabled && this._cloudEffect.params.enabled)
      ? (this._cloudEffect.cloudShadowRawTexture ?? this._cloudEffect.cloudShadowTexture)
      : null;
    const combinedShadowTex = this._shadowManagerEffect?.combinedShadowTexture ?? cloudShadowTexLegacy;
    const combinedShadowRawTex = this._shadowManagerEffect?.combinedShadowRawTexture ?? combinedShadowTex;
    // Back-compat alias for nearby call sites that still use legacy names.
    const cloudShadowRawTexLegacy = windowCloudShadowTexLegacy;
    const windowCloudShadowViewBounds = (this._cloudEffect.enabled && this._cloudEffect.params.enabled)
      ? (this._cloudEffect.cloudShadowViewBounds ?? null)
      : null;
    const shadowW = Number(combinedShadowRawTex?.image?.width) || this._sceneRT?.width || 1;
    const shadowH = Number(combinedShadowRawTex?.image?.height) || this._sceneRT?.height || 1;
    this._windowLightEffect?.setCloudShadowTexture?.(combinedShadowRawTex, shadowW, shadowH, windowCloudShadowViewBounds);
    const buildingShadowTex = (this._buildingShadowEffect?.params?.enabled)
      ? this._buildingShadowEffect.shadowFactorTexture : null;
    const buildingShadowOpacity = Number.isFinite(this._buildingShadowEffect?.params?.opacity)
      ? this._buildingShadowEffect.params.opacity : 0.75;
    const overheadShadowTexLegacy = (!_disableOverheadInLighting && this._overheadShadowEffect?.params?.enabled)
      ? this._overheadShadowEffect.shadowFactorTexture : null;
    const overheadRoofAlphaTex = _disableRoofInLighting ? null : (this._overheadShadowEffect?.roofAlphaTexture ?? null);
    // IMPORTANT INVARIANT:
    // Do NOT null `roofBlockTexture` / `ceilingTransmittanceTextureForLighting` during
    // hover-reveal. The shader-side occlusion math in `OverheadShadowsEffectV2` +
    // `LightingEffectV2` explicitly gates the hard blocker contribution by the *live*
    // roof visibility weight, so keeping these textures wired avoids “stuck mask”
    // behavior under faded trees/overheads.
    const overheadRoofBlockTex = _disableRoofInLighting ? null : (this._overheadShadowEffect?.roofBlockTexture ?? null);
    // IMPORTANT INVARIANT:
    // Keep ceiling transmittance available during hover-reveal; blocker/occlusion
    // fade is handled in shader via roof visibility weights (not by runtime nulling).
    const ceilingTransmittanceTex = (!_disableRoofInLighting && this._overheadShadowEffect?.ceilingTransmittanceTextureForLighting)
      ? this._overheadShadowEffect.ceilingTransmittanceTextureForLighting
      : null;
    this._windowLightEffect?.setOverheadRoofAlphaTexture?.(
      overheadRoofAlphaTex,
      this._sceneRT?.width || 1,
      this._sceneRT?.height || 1
    );
    this._windowLightEffect?.setCeilingTransmittanceTexture?.(ceilingTransmittanceTex);
    this._windowLightEffect?.syncFrameOcclusion?.(this);
    this._skyColorEffect?.setOverheadRoofAlphaTexture?.(overheadRoofAlphaTex);
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: lighting.render(sceneRT→postA)'); } catch (_) {} }
    if (_profiling) _profileT0 = performance.now();
    const lightingCtx = window.MapShine?.activeLevelContext ?? null;
    const outdoorsForLightingTex = this._resolveOutdoorsMask(lightingCtx, { allowWeatherRoofMap: false }).texture ?? null;
    this._lightingEffect.render(
      this.renderer,
      this.camera,
      currentInput,
      this._postA,
      winScene,
      cloudShadowTexLegacy,
      cloudShadowRawTexLegacy,
      buildingShadowTex,
      overheadShadowTexLegacy,
      buildingShadowOpacity,
      overheadRoofAlphaTex,
      overheadRoofBlockTex,
      outdoorsForLightingTex,
      ceilingTransmittanceTex,
      combinedShadowTex,
      combinedShadowRawTex
    );
    if (_profiling) this._recordPassTiming('lightingRender', _profileT0);
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

    // Feed sky state + cloud shadow into water after sky+CC have updated.
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
      // Feed cloud shadow texture so water darkening, caustics kill, and
      // specular kill all respond to cloud coverage.
      if (typeof this._waterEffect?.setCloudShadowTexture === 'function') {
        this._waterEffect.setCloudShadowTexture(combinedShadowTex);
      }
      // Feed structural shadow textures so water specular/foam respond to
      // building and overhead shadows as well.
      if (typeof this._waterEffect?.setBuildingShadowTexture === 'function') {
        this._waterEffect.setBuildingShadowTexture(buildingShadowTex);
      }
      if (typeof this._waterEffect?.setOverheadShadowTexture === 'function') {
        this._waterEffect.setOverheadShadowTexture(overheadShadowTexLegacy);
      }
      if (typeof this._waterEffect?.setCombinedShadowTexture === 'function') {
        this._waterEffect.setCombinedShadowTexture(combinedShadowTex);
      }
      // Feed ShadowManagerV2 combined shadow texture for murk darkening
      if (typeof this._waterEffect?.setShadowManagerCombinedTexture === 'function') {
        this._waterEffect.setShadowManagerCombinedTexture(combinedShadowTex);
      }
    } catch (_) {}

    // Water pass: refracts/tints/specular the fully graded scene.
    // Occlusion is handled via a deterministic occluder mask (upper floor tiles)
    // plus depth pass fallback inside the shader.
    let _waterPassWrote = false;
    if (!_skipWaterPass && this._waterEffect?.enabled) {
      try {
        const _vm = Number.isFinite(this._renderBus._visibleMaxFloorIndex)
          ? this._renderBus._visibleMaxFloorIndex
          : 0;
        const _blurOn = this._floorDepthBlurEffect?.params.enabled && _vm > 0;
        this._waterEffect.syncFloorDepthBlurContext?.(_blurOn, _vm);
      } catch (_) {}

      // Build occluder mask for the *currently viewed* floor.
      // If on floor 0, no occluder needed.
      let occluderRT = null;
      try {
        const viewFloor = window.MapShine?.floorStack?.getActiveFloor()?.index ?? 0;
        if (!_disableWaterOccluder && viewFloor > 0 && this._waterOccluderRT) {
          this._renderBus.renderFloorMaskTo(this.renderer, this.camera, viewFloor, this._waterOccluderRT);
          occluderRT = this._waterOccluderRT;
        }
      } catch (_) {}

      const waterOutput = (currentInput === this._postA) ? this._postB : this._postA;
      // render() returns true if it wrote to waterOutput, false if it returned early.
      // Only advance currentInput when the pass actually ran — otherwise waterOutput
      // is an unwritten (black) RT and advancing would black out the entire scene.
      if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: water.render'); } catch (_) {} }
      if (_profiling) _profileT0 = performance.now();
      _waterPassWrote = this._waterEffect.render(this.renderer, this.camera, currentInput, waterOutput, occluderRT);
      if (_profiling) this._recordPassTiming('waterRender', _profileT0);
      if (_waterPassWrote) currentInput = waterOutput;
      if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: water.render DONE'); } catch (_) {} }
    }

    try {
      const wt = (_waterPassWrote && typeof this._waterEffect?.getWaterSpecularBloomTexture === 'function')
        ? this._waterEffect.getWaterSpecularBloomTexture()
        : null;
      this._bloomEffect?.setWaterSpecularBloomTexture?.(wt ?? null);
    } catch (_) {}

    // Distortion pass (fire-driven heat haze).
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: distortion.render'); } catch (_) {} }
    if (this._distortionEffect?.enabled && this._distortionEffect?.params?.enabled) {
      this._syncFireHeatDistortionSource();
      const distOutput = (currentInput === this._postA) ? this._postB : this._postA;
      this._distortionEffect.setBuffers(currentInput, distOutput);
      this._distortionEffect.setRenderToScreen(false);
      if (_profiling) _profileT0 = performance.now();
      this._distortionEffect.render(this.renderer, this._renderBus?._scene ?? this.scene, this.camera);
      if (_profiling) this._recordPassTiming('distortionRender', _profileT0);
      currentInput = distOutput;
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: distortion.render DONE'); } catch (_) {} }

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

    // PIXI world-channel composite: inject bridge drawings late so they are
    // not altered by bloom/grading stylization passes.
    if (_profiling) _profileT0 = performance.now();
    currentInput = this._compositePixiWorldOverlay(currentInput);
    if (_profiling) this._recordPassTiming('pixiWorldComposite', _profileT0);

    // Composite fog-of-war into the RT chain so downstream post effects (lens)
    // are guaranteed to render above fog.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: fogOverlay.compositeToRT'); } catch (_) {} }
    {
      const fogOutput = (currentInput === this._postA) ? this._postB : this._postA;
      if (this._compositeFogOverlayToRT(currentInput, fogOutput)) {
        currentInput = fogOutput;
      }
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: fogOverlay.compositeToRT DONE'); } catch (_) {} }

    // Stylized lens pass: distortion/chromatic/vignette/grime overlays.
    // This now runs after fog composition so lens artifacts remain on top of FOW.
    // CRITICAL: Pass _postA as the luma sample source so the lens effect can detect
    // actual light intensity (albedo × lighting) BEFORE sky color grading darkens it.
    // We can't use _sceneRT (raw albedo) because it's too dark, and we can't use
    // currentInput (final graded output) because darkness level has already been applied.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: lens.render'); } catch (_) {} }
    if (!_skipLensPass && this._lensEffect?.enabled && this._lensEffect?.params?.enabled) {
      const lensOutput = (currentInput === this._postA) ? this._postB : this._postA;
      if (this._lensEffect.render(this.renderer, this.camera, currentInput, lensOutput, this._postA)) {
        currentInput = lensOutput;
      }
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: lens.render DONE'); } catch (_) {} }

    // ── Step 3: Optional mask debug overlay → blit to screen ────────────
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: blitToScreen'); } catch (_) {} }
    let blitSource = currentInput;
    try {
      const ui = window.MapShine?.uiManager ?? window.MapShine?.tweakpaneManager;
      const tp = ui?.globalParams;
      const dbgEnabled = tp?.maskDebugOverlayEnabled;
      const dbgOn =
        dbgEnabled === true ||
        dbgEnabled === 1 ||
        dbgEnabled === 'true';
      const dbgMode = typeof tp?.maskDebugOverlayMode === 'string' ? tp.maskDebugOverlayMode : 'outdoors_current';
      const op = Number(tp?.maskDebugOverlayOpacity);
      const dbgOpacity = Number.isFinite(op) ? Math.max(0, Math.min(1, op)) : 0.35;
      if (dbgOn && this._maskDebugOverlayPass) {
        const ctx = window.MapShine?.activeLevelContext ?? null;
        const { texture: dbgTex, floorKey: dbgFk, directScreenUv: dbgDirectScreenUv, replaceScene: dbgReplaceScene } = this._maskDebugOverlayPass.resolveMaskTexture(dbgMode, {
          resolveOutdoorsMask: () => {
            const strict = this._resolveOutdoorsMask(ctx, { allowWeatherRoofMap: false });
            if (strict.texture) return strict;
            const loose = this._resolveOutdoorsMask(ctx, { allowWeatherRoofMap: true });
            if (loose.texture) return loose;
            const rm = weatherController?.roofMap ?? null;
            return { texture: rm, floorKey: rm ? 'weatherController.roofMap' : null };
          },
          resolveOverheadDebugTexture: (mode) => {
            const ov = this._overheadShadowEffect;
            if (!ov) return null;
            switch (mode) {
              case 'overhead_shadow_factor':
                return ov.shadowFactorTexture ?? null;
              case 'overhead_roof_coverage':
                return ov.roofTarget?.texture ?? null;
              case 'overhead_roof_visibility':
                return ov.roofAlphaTexture ?? null;
              case 'overhead_roof_block':
                return ov.roofBlockTexture ?? null;
              case 'overhead_fluid_roof':
                return ov.fluidRoofTarget?.texture ?? null;
              case 'overhead_tile_projection':
                return ov.tileProjectionTarget?.texture ?? null;
              default:
                return null;
            }
          },
        });
        try {
          if (window.MapShine) {
            window.MapShine.__maskDebugOverlayFloorKey = dbgFk ?? null;
            window.MapShine.__maskDebugOverlayHasTexture = !!dbgTex;
          }
        } catch (_) {}
        if (dbgTex) {
          const dbgOut = currentInput === this._postA ? this._postB : this._postA;
          const gz = Number(window.MapShine?.sceneComposer?.groundZ);
          const groundZ = Number.isFinite(gz) ? gz : 0;
          if (
            this._maskDebugOverlayPass.renderComposite(
              this.renderer,
              currentInput,
              dbgOut,
              dbgTex,
              dbgOpacity,
              this.camera,
              groundZ,
              {
                directScreenUv: dbgDirectScreenUv === true,
                replaceScene: dbgReplaceScene === true,
              },
            )
          ) {
            blitSource = dbgOut;
          }
        }
      }
    } catch (e) {
      log.warn('FloorCompositor: mask debug overlay failed:', e);
    }
    this._blitToScreen(blitSource);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: blitToScreen DONE'); } catch (_) {} }

    // Late UI/world overlay pass (layer 31) rendered after all post-FX.
    // This keeps interactive world controls (e.g. Three door icons) above
    // fog, bloom, color correction, and any screen-space passes.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: lateOverlay.render'); } catch (_) {} }
    this._renderLateWorldOverlay();
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: lateOverlay.render DONE'); } catch (_) {} }

    // Cloud-top blit: render after late world overlay so atmospheric cloud tops
    // remain visually above world-space overlay content (e.g. bypass tiles,
    // drawing overlays, interaction aids routed through OVERLAY_THREE_LAYER).
    // Keep PIXI UI overlay above clouds so HUD/control affordances stay readable.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: cloudTops.blit'); } catch (_) {} }
    if (this._cloudEffect.enabled && this._cloudEffect.params.enabled) {
      this._cloudEffect.blitCloudTops(this.renderer, null);
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: cloudTops.blit DONE'); } catch (_) {} }

    // PIXI UI-channel overlay: render last so it remains above bloom/fog/lens.
    this._renderPixiUiOverlay();

    // P4: Expose accumulated pass timings on MapShine for console inspection.
    if (_profiling && this._passTimings && window.MapShine) {
      const out = {};
      for (const [name, data] of Object.entries(this._passTimings)) {
        out[name] = {
          total: Math.round(data.total * 100) / 100,
          count: data.count,
          avg: data.count > 0 ? Math.round((data.total / data.count) * 100) / 100 : 0,
          last: Math.round(data.last * 100) / 100,
        };
      }
      window.MapShine.__v2PassTimings = out;
    }

    if (_dbgStages) {
      this._debugFirstFrameStagesLogged = true;
      try { log.info('[V2 Frame] ✔ FloorCompositor.render: END'); } catch (_) {}
    }
  }

  /**
   * Runtime guard: keep FloorRenderBus visibility slice aligned with active floor
   * and immediately correct leaked above-floor entries if they become visible.
   * @param {object|null} floorStackArg
   * @private
   */
  _enforceBusVisibilityForActiveFloor(floorStackArg = null) {
    const bus = this._renderBus;
    if (!bus || !this._busPopulated) return;

    let desiredMax = 0;
    try {
      const fs = floorStackArg || window.MapShine?.floorStack || null;
      const active = fs?.getActiveFloor?.() || null;
      if (Number.isFinite(Number(active?.index))) {
        desiredMax = Number(active.index);
      } else if (Number.isFinite(Number(bus?._visibleMaxFloorIndex))) {
        desiredMax = Number(bus._visibleMaxFloorIndex);
      }
    } catch (_) {}
    if (!Number.isFinite(desiredMax) || desiredMax < 0) desiredMax = 0;

    let corrected = false;
    const currentMax = Number.isFinite(Number(bus?._visibleMaxFloorIndex))
      ? Number(bus._visibleMaxFloorIndex)
      : 0;
    if (currentMax !== desiredMax) {
      bus.setVisibleFloors(desiredMax);
      corrected = true;
    }

    let leakCount = 0;
    try {
      const entries = bus?._tiles;
      if (entries && typeof entries.forEach === 'function') {
        entries.forEach((entry, key) => {
          const k = String(key || '');
          if (k.startsWith('__')) return;
          const fi = Number(entry?.floorIndex);
          if (!Number.isFinite(fi) || fi <= desiredMax) return;
          const node = entry?.root || entry?.mesh || null;
          const nodeVisible = Boolean(node?.visible);
          const meshVisible = (typeof entry?.mesh?.visible === 'boolean') ? entry.mesh.visible : null;
          const rootVisible = (typeof entry?.root?.visible === 'boolean') ? entry.root.visible : null;
          const effectiveVisible = nodeVisible && meshVisible !== false && rootVisible !== false;
          if (effectiveVisible) leakCount += 1;
        });
      }
    } catch (_) {}

    this._visibilityDriftLastLeakCount = leakCount;
    if (leakCount > 0) {
      try {
        bus._applyTileVisibility?.();
        corrected = true;
      } catch (_) {}
    }

    if (corrected) {
      this._visibilityDriftCorrections += 1;
      this._visibilityDriftLastCorrectionMs = Date.now();
    }
  }

  /**
   * Runtime guard for TileManager sprite visibility by active floor.
   * @param {object|null} floorStackArg
   * @private
   */
  _enforceTileSpriteVisibilityForActiveFloor(floorStackArg = null) {
    let activeFloorIndex = 0;
    try {
      const fs = floorStackArg || window.MapShine?.floorStack || null;
      const af = fs?.getActiveFloor?.() || null;
      if (Number.isFinite(Number(af?.index))) activeFloorIndex = Number(af.index);
    } catch (_) {}
    if (!Number.isFinite(activeFloorIndex) || activeFloorIndex < 0) activeFloorIndex = 0;

    const tm = window.MapShine?.tileManager ?? null;
    const flm = window.MapShine?.floorLayerManager ?? null;
    const map = tm?.tileSprites;
    if (!map || typeof map.entries !== 'function') return;

    let leakCount = 0;
    let correctedAny = false;
    const expectedFloorFromDoc = (tileDoc) => {
      const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
      if (!Array.isArray(floors) || floors.length <= 1) return 0;
      try {
        const flags = tileDoc?.flags?.levels;
        const b = Number(flags?.rangeBottom);
        const t = Number(flags?.rangeTop);
        if (Number.isFinite(b) && Number.isFinite(t)) {
          const mid = (b + t) / 2;
          for (let i = 0; i < floors.length; i += 1) {
            const f = floors[i];
            if (mid >= Number(f?.elevationMin) && mid < Number(f?.elevationMax)) return i;
          }
        }
      } catch (_) {}
      const elev = Number(tileDoc?.elevation ?? 0);
      for (let i = 0; i < floors.length; i += 1) {
        const f = floors[i];
        const min = Number(f?.elevationMin);
        const max = Number(f?.elevationMax);
        if (Number.isFinite(min) && Number.isFinite(max) && elev >= min && elev <= max) return i;
      }
      return 0;
    };

    for (const [tileId, data] of map.entries()) {
      const sprite = data?.sprite ?? null;
      const tileDoc = data?.tileDoc ?? canvas?.scene?.tiles?.get?.(tileId) ?? null;
      if (!sprite || !tileDoc) continue;
      const mappedFloorRaw = flm?._spriteFloorMap?.get?.(sprite);
      const mappedFloor = Number.isFinite(Number(mappedFloorRaw)) ? Number(mappedFloorRaw) : null;
      const expectedFloor = mappedFloor ?? expectedFloorFromDoc(tileDoc);
      const shouldBeVisible = expectedFloor <= activeFloorIndex;
      const currentlyVisible = sprite.visible === true;
      if (currentlyVisible && !shouldBeVisible) {
        leakCount += 1;
        sprite.visible = false;
        correctedAny = true;
      }
    }

    this._tileSpriteVisibilityLastLeakCount = leakCount;
    if (correctedAny) {
      this._tileSpriteVisibilityCorrections += 1;
      this._tileSpriteVisibilityLastCorrectionMs = Date.now();
    }
  }

  /**
   * P4: Record wall-clock time for a named render pass.
   * @param {string} name
   * @param {number} t0 - performance.now() timestamp from before the pass
   * @private
   */
  _recordPassTiming(name, t0) {
    if (!this._passTimings) return;
    const elapsed = performance.now() - t0;
    let entry = this._passTimings[name];
    if (!entry) {
      entry = { total: 0, count: 0, last: 0 };
      this._passTimings[name] = entry;
    }
    entry.total += elapsed;
    entry.count += 1;
    entry.last = elapsed;
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
    const prevScissorTest = (typeof renderer.getScissorTest === 'function')
      ? renderer.getScissorTest()
      : null;
    const THREE = window.THREE;
    const prevClearColor = (THREE && typeof renderer.getClearColor === 'function')
      ? renderer.getClearColor(new THREE.Color())
      : null;
    const prevClearAlpha = (typeof renderer.getClearAlpha === 'function')
      ? renderer.getClearAlpha()
      : null;
    const prevViewport = (THREE && typeof renderer.getViewport === 'function')
      ? renderer.getViewport(new THREE.Vector4())
      : null;

    this._blitMaterial.uniforms.tDiffuse.value = sourceRT.texture;
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    try {
      // Defensive state reset: if any prior pass/module leaves scissor clipping
      // enabled, the fullscreen blit only updates a sub-rect and stale pixels
      // from earlier frames remain visible as a static "underlay".
      if (typeof renderer.setScissorTest === 'function') {
        renderer.setScissorTest(false);
      }
      if (typeof renderer.setViewport === 'function') {
        // setViewport expects renderer logical/CSS pixels (not drawing-buffer
        // pixels). Using drawing-buffer dimensions here applies pixelRatio twice
        // and causes visible post/overlay misalignment.
        const size = this._sizeVec ?? new THREE.Vector2();
        renderer.getSize(size);
        renderer.setViewport(0, 0, Math.max(1, size.x), Math.max(1, size.y));
      }

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
      if (typeof renderer.setScissorTest === 'function' && prevScissorTest !== null) {
        try { renderer.setScissorTest(prevScissorTest); } catch (_) {}
      }
      if (prevViewport && typeof renderer.setViewport === 'function') {
        try {
          renderer.setViewport(prevViewport.x, prevViewport.y, prevViewport.z, prevViewport.w);
        } catch (_) {}
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
    // IMPORTANT: Fog plane is world-space geometry. Rendering it with a
    // fullscreen orthographic camera makes it screen-locked during pan/zoom.
    // Use the main world camera so fog stays pinned to map coordinates.
    const camera = this.camera;
    if (!scene || !camera || !this.renderer) return;

    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevLayerMask = camera.layers.mask;
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    try {
      camera.layers.enable(OVERLAY_THREE_LAYER);
      renderer.render(scene, camera);
    } finally {
      camera.layers.mask = prevLayerMask;
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
        if (typeof effect.setEnabled === 'function') {
          try { effect.setEnabled(!!value); } catch (_) {}
        }
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
        // Reject NaN/Infinity numbers — corrupted scene flags or stale saves
        // must not poison effect.params and propagate into GPU uniforms.
        if (typeof value === 'number' && !Number.isFinite(value)) return;
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
   * @param {{allowWeatherRoofMap?: boolean}} [options] When false (lighting pass), never use
   *   `weatherController.roofMap` — it is not an indoor/outdoor floor mask and wrongly gates lights.
   * @returns {{texture: THREE.Texture|null, floorKey: string|null}}
   * @private
   */
  _resolveOutdoorsMask(context = null, options = {}) {
    const { allowWeatherRoofMap = true } = options;

    let floorStackFloors = [];
    try {
      floorStackFloors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    } catch (_) {
      floorStackFloors = [];
    }
    // In multi-floor scenes, a "ground/global" outdoors fallback can resolve to
    // whichever floor cache was composed first (or last persisted), which may be
    // the wrong band during scene/floor transitions. Prefer null until the active
    // floor's own outdoors texture is ready.
    const skipGroundGlobalFallback = floorStackFloors.length > 1;

    const sc = window.MapShine?.sceneComposer;
    const compositor = sc?._sceneMaskCompositor;
    if (!compositor) {
      if (!skipGroundGlobalFallback) {
        const bundleMask = sc?.currentBundle?.masks?.find?.(m => (m?.id === 'outdoors' || m?.type === 'outdoors'))?.texture ?? null;
        if (bundleMask) return { texture: bundleMask, floorKey: 'bundle' };
        const mmMask = window.MapShine?.maskManager?.getTexture?.('outdoors.scene') ?? null;
        if (mmMask) return { texture: mmMask, floorKey: 'maskManager' };
      }
      if (!allowWeatherRoofMap) {
        const regMask = window.MapShine?.effectMaskRegistry?.getMask?.('outdoors') ?? null;
        if (regMask) return { texture: regMask, floorKey: 'registry' };
        return { texture: null, floorKey: null };
      }
      // roofMap is global — on upper floors it may still be the previous band's _Outdoors.
      if (skipGroundGlobalFallback) {
        return { texture: null, floorKey: null };
      }
      const roofMap = weatherController?.roofMap ?? null;
      return { texture: roofMap, floorKey: roofMap ? 'weatherController' : null };
    }

    const gpu = resolveCompositorOutdoorsTexture(
      compositor,
      context,
      { skipGroundFallback: skipGroundGlobalFallback },
    );
    if (gpu.texture) {
      return { texture: gpu.texture, floorKey: gpu.resolvedKey };
    }

    if (!skipGroundGlobalFallback) {
      const bundleMask = sc?.currentBundle?.masks?.find?.(m => (m?.id === 'outdoors' || m?.type === 'outdoors'))?.texture ?? null;
      if (bundleMask) return { texture: bundleMask, floorKey: 'bundle' };

      const mmMask = window.MapShine?.maskManager?.getTexture?.('outdoors.scene') ?? null;
      if (mmMask) return { texture: mmMask, floorKey: 'maskManager' };
    }

    if (!allowWeatherRoofMap) {
      const regMask = window.MapShine?.effectMaskRegistry?.getMask?.('outdoors') ?? null;
      if (regMask) return { texture: regMask, floorKey: 'registry' };
      return { texture: null, floorKey: null };
    }
    if (skipGroundGlobalFallback) {
      return { texture: null, floorKey: null };
    }
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
      // Water movement suppression must use a real _Outdoors mask.
      // Do not seed this from the generic path because it may fall back to
      // weatherController.roofMap (not floor-authored indoors/outdoors data).
      const waterResolved = this._resolveOutdoorsMask(context, { allowWeatherRoofMap: false });
      let waterOutdoorsTex = waterResolved.texture ?? null;
      // Sky grading is very sensitive to mask source quality/alignment.
      // Resolve a strict floor outdoors texture for sky that never falls back to
      // weather roof maps and never reuses stale previous masks.
      const skyResolved = this._resolveOutdoorsMask(context, { allowWeatherRoofMap: false });
      const skyOutdoorsTex = skyResolved.texture ?? null;

      let floorStackForSync = [];
      try {
        floorStackForSync = window.MapShine?.floorStack?.getFloors?.() ?? [];
      } catch (_) {
        floorStackForSync = [];
      }
      const multiFloorScene = floorStackForSync.length > 1;

      // Do not clobber a valid outdoors texture with transient null while floor
      // caches are still warming asynchronously. On upper floors, reusing the
      // previous texture is usually stale ground-floor _Outdoors.
      if (!outdoorsTex && this._lastOutdoorsTexture && !multiFloorScene) {
        outdoorsTex = this._lastOutdoorsTexture;
      }

      // Water can run in floor-fallback mode (for example only ground has _Water
      // data while viewing an upper floor). In that case, sampling outdoors from
      // the viewed floor can alter wave/rain response and make the same water body
      // appear different per view floor. Prefer outdoors for the active water floor
      // when available so fallback water remains visually consistent.
      try {
        const waterFloorIndex = Number(this._waterEffect?._activeFloorIndex);
        if (Number.isFinite(waterFloorIndex)) {
          const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
          const waterFloor = floors.find((f) => Number(f?.index) === waterFloorIndex) ?? null;
          const waterFloorKey = waterFloor?.compositorKey ?? null;
          const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
          const waterFloorTex = (compositor && waterFloorKey)
            ? (compositor.getFloorTexture?.(waterFloorKey, 'outdoors') ?? null)
            : null;
          if (waterFloorTex) {
            waterOutdoorsTex = waterFloorTex;
          }
        }
      } catch (_) {}

      if (!force && outdoorsTex === this._lastOutdoorsTexture) return;

      this._lastOutdoorsTexture = outdoorsTex;
      this._lastOutdoorsFloorKey = resolved.floorKey;

      // Always propagate (including null) so consumers cannot keep stale masks.
      this._cloudEffect?.setOutdoorsMask?.(outdoorsTex);
      this._waterEffect?.setOutdoorsMask?.(waterOutdoorsTex);
      this._skyColorEffect?.setOutdoorsMask?.(skyOutdoorsTex);
      this._filterEffect?.setOutdoorsMask?.(outdoorsTex);
      this._atmosphericFogEffect?.setOutdoorsMask?.(outdoorsTex);
      this._overheadShadowEffect?.setOutdoorsMask?.(outdoorsTex);
      this._buildingShadowEffect?.setOutdoorsMask?.(outdoorsTex);

      // CloudEffectV2 supports floor-aware outdoors masking when provided with
      // per-floor textures and the compositor floor-id texture.
      try {
        const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
        if (compositor) {
          // floorIdTarget encodes the *topmost* floor index per world pixel, not the
          // viewed floor. Binding only getVisibleFloors() leaves higher indices null;
          // CloudEffectV2 then substitutes 1×1 white (= outdoors) for those samplers,
          // so underground views show full cloud shadow / rain wherever an upper floor
          // has tile coverage. Bind every band's _Outdoors that exists in the stack.
          const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
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

    const resolveFloorIndexFromContext = (ctx, floors, fallbackIdx = 0) => {
      if (!Array.isArray(floors) || floors.length === 0) return fallbackIdx;
      const b = Number(ctx?.bottom);
      const t = Number(ctx?.top);
      if (!Number.isFinite(b)) return fallbackIdx;
      const hasFiniteTop = Number.isFinite(t);
      const mid = hasFiniteTop ? ((b + t) / 2) : b;
      let bestIdx = fallbackIdx;
      let foundExactMatch = false;
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        const fMin = Number(f?.elevationMin);
        const fMax = Number(f?.elevationMax);
        if (fMin === b && (!hasFiniteTop || fMax === t)) {
          bestIdx = i;
          foundExactMatch = true;
          break;
        }
        // If we haven't found an exact match, check if mid is within bounds.
        // Ignore infinity bounds for the mid check to avoid jumping to a
        // "catch-all" floor if a tighter floor contains the center.
        if (!foundExactMatch && mid >= fMin && mid <= fMax) {
          bestIdx = i;
        }
      }
      return bestIdx;
    };

    const resolveFloorIndexFromElevation = (elevation, floors, fallbackIdx = 0) => {
      const elev = Number(elevation);
      if (!Array.isArray(floors) || floors.length === 0 || !Number.isFinite(elev)) return fallbackIdx;
      let bestIdx = fallbackIdx;
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        const fMin = Number(f?.elevationMin);
        const fMax = Number(f?.elevationMax);
        if (Number.isFinite(fMin) && Number.isFinite(fMax) && elev >= fMin && elev <= fMax) {
          bestIdx = i;
          break;
        }
      }
      return bestIdx;
    };

    // Prefer the hook payload's active level band (authoritative) to avoid
    // getting stuck when FloorStack.activeFloorIndex wasn't updated elsewhere.
    // CameraFollower._emitLevelContextChanged updates window.MapShine.activeLevelContext
    // then fires this hook with { context:{bottom,top}, ... }.
    try {
      const ctx = payload?.context ?? window.MapShine?.activeLevelContext ?? null;
      const floors = floorStack.getFloors?.() ?? [];
      // Levels commonly represents the top-most band as [bottom, Infinity].
      // Accept finite-bottom contexts even when top is non-finite so active
      // floor switching still works on the highest level.
      if (floors.length > 1) {
        const currentIdx = Number(floorStack.getActiveFloor?.()?.index);
        const safeCurrentIdx = Number.isFinite(currentIdx) ? currentIdx : 0;
        let bestIdx = resolveFloorIndexFromContext(ctx, floors, safeCurrentIdx);

        // Context can be transiently null/non-finite during rapid view changes.
        // In that window, infer floor from controlled token elevation so we do
        // not keep stale upper-floor state while rendering the ground view.
        if (!Number.isFinite(Number(ctx?.bottom))) {
          const controlledToken = canvas?.tokens?.controlled?.[0] ?? null;
          const controlledElev = Number(controlledToken?.document?.elevation);
          bestIdx = resolveFloorIndexFromElevation(controlledElev, floors, bestIdx);
        }

        floorStack.setActiveFloor(bestIdx);
      }
    } catch (_) {}

    try {
      const comp = window.MapShine?.sceneComposer?._sceneMaskCompositor;
      if (comp && typeof comp.syncActiveFloorFromFloorStack === 'function') {
        comp.syncActiveFloorFromFloorStack();
      }
    } catch (_) {}

    const activeFloor = floorStack.getActiveFloor();
    // IMPORTANT: never fall back to Infinity here. Several effects (including
    // BuildingShadowsEffectV2) treat non-finite floor indices as "floor 0" to
    // avoid infinite loops, which would make the effect appear stuck on the
    // ground-floor state.
    let maxFloorIndex = 0;
    if (activeFloor && typeof activeFloor.index === 'number' && Number.isFinite(activeFloor.index)) {
      maxFloorIndex = activeFloor.index;
    }
    
    if (maxFloorIndex < 0 || !Number.isFinite(maxFloorIndex)) {
      log.info('FloorCompositor: maxFloorIndex invalid; falling back to 0', activeFloor);
      maxFloorIndex = 0;
    } else {
      log.info(`FloorCompositor: active floor index = ${maxFloorIndex}`);
    }
    
    this._renderBus.setVisibleFloors(maxFloorIndex);
    // Notify fire effect of floor change so it can swap active particle systems.
    this._fireEffect.onFloorChange(maxFloorIndex);
    // Notify dust effect of floor change so it can swap active particle systems.
    this._dustEffect.onFloorChange(maxFloorIndex);
    // Iridescence overlays are bus-managed but we still notify for parity.
    try { this._iridescenceEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Notify water splashes of floor change so it can swap active systems.
    try { this._waterSplashesEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Notify water glitter so it can swap active systems.
    try { this._waterGlitterEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
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
    try { this._playerLightEffect?.setActiveLevelContext?.(payload?.context ?? window.MapShine?.activeLevelContext ?? null); } catch (_) {}
    try { this._lightningEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    try { this._candleFlamesEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    try { this._playerLightEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Outdoors mask floor changes are handled above via GpuSceneMaskCompositor
    // Swap active water SDF data for the new floor.
    try { this._waterEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    this._fireHeatMaskInput = null;
    this._fireHeatMaskOutput = null;
    this._fireHeatMaskBlurRadius = -1;
    this._fireHeatMaskBlurPasses = -1;
    try {
      this._healthEvaluator?.handleFloorChange?.(
        maxFloorIndex,
        payload?.context ?? window.MapShine?.activeLevelContext ?? null
      );
    } catch (_) {}
    log.info(`FloorCompositor: visibility set to floors 0–${maxFloorIndex}`);
  }

  /**
   * Update DistortionManager's `heat` source from the currently active fire mask.
   * Heat intensity and expansion scale with fire size/rate so larger flames produce
   * broader, stronger haze.
   * @private
   */
  _syncFireHeatDistortionSource() {
    const dist = this._distortionEffect;
    if (!dist) return;

    const fire = this._fireEffect;
    // Root-cause guard: a non-null fire mask texture can exist even when there are
    // no active fire systems on the currently-visible band.
    // In that state, leaving heat enabled forces DistortionManager to run its
    // expensive full-screen apply every frame even when the active-frame heat
    // mask has no meaningful contribution (e.g. all-zero masks).
    const fireActiveFloorCount = Number(fire?._activeFloors?.size);
    const fireHasActiveFloors = Number.isFinite(fireActiveFloorCount) && fireActiveFloorCount > 0;
    if (!fireHasActiveFloors) {
      dist.setSourceEnabled('heat', false);
      return;
    }

    // Prefer checking whether the ACTIVE floor band has any fire systems.
    // FireEffectV2 deactivates systems from the per-floor BatchedRenderer but keeps the
    // per-floor arrays resident, so "any systems anywhere" is not enough to
    // decide whether heat should run this frame.
    let hasSystemsOnActiveBand = null;
    try {
      const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
      const activeIdx = activeFloor && Number.isFinite(Number(activeFloor.index)) ? Number(activeFloor.index) : null;
      if (activeIdx !== null) {
        const state = fire?._floorStates?.get(activeIdx) ?? null;
        hasSystemsOnActiveBand = this._fireEffectHasSystemsInState(state);
      }
    } catch (_) {
      // Fall back to broader checks below.
    }

    if (hasSystemsOnActiveBand === false) {
      dist.setSourceEnabled('heat', false);
      return;
    }

    // If we couldn't resolve active-band state, fall back to whether there are
    // any fire systems at all (legacy safety net).
    if (hasSystemsOnActiveBand === null) {
      const fireHasAnySystems = this._fireEffectHasAnySystems(fire);
      if (!fireHasAnySystems) {
        dist.setSourceEnabled('heat', false);
        return;
      }
    }

    const fireParams = fire?.params ?? null;
    const fireEnabled = !!(fire?.enabled && fireParams?.enabled !== false && fireParams?.heatDistortionEnabled !== false);
    if (!fireEnabled) {
      dist.setSourceEnabled('heat', false);
      return;
    }

    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
    const ctx = window.MapShine?.activeLevelContext ?? null;
    const b = Number(ctx?.bottom);
    const t = Number(ctx?.top);
    const activeKey = (Number.isFinite(b) && Number.isFinite(t)) ? `${b}:${t}` : null;

    let fireMask = null;
    let fireMaskSource = 'none';
    if (compositor && activeKey) {
      fireMask = compositor.getFloorTexture?.(activeKey, 'fire') ?? null;
      if (fireMask) fireMaskSource = 'compositor-active';
    }
    if (!fireMask && compositor && Number.isFinite(b) && Number.isFinite(t)) {
      // In levels-inferred contexts, activeLevelContext keys may be fractional and
      // not string-identical to compositor cache keys. Resolve by numeric range.
      const cacheKeys = Array.isArray(compositor?._floorCache?.keys?.())
        ? compositor._floorCache.keys()
        : Array.from(compositor?._floorCache?.keys?.() ?? []);
      const mid = (b + t) * 0.5;
      let bestKey = null;
      let bestDelta = Infinity;
      for (const key of cacheKeys) {
        if (typeof key !== 'string') continue;
        const parts = key.split(':');
        if (parts.length !== 2) continue;
        const kb = Number(parts[0]);
        const kt = Number(parts[1]);
        if (!Number.isFinite(kb) || !Number.isFinite(kt)) continue;
        if (mid < kb || mid > kt) continue;
        const delta = Math.abs(kb - b) + Math.abs(kt - t);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestKey = key;
        }
      }
      if (bestKey) {
        fireMask = compositor.getFloorTexture?.(bestKey, 'fire') ?? null;
        if (fireMask) fireMaskSource = 'compositor-best';
      }
    }
    if (!fireMask) {
      fireMask = compositor?.getGroundFloorMaskTexture?.('fire') ?? null;
      if (fireMask) fireMaskSource = 'compositor-ground';
    }
    if (!fireMask) {
      fireMask = window.MapShine?.effectMaskRegistry?.getSlot?.('fire')?.texture ?? null;
      if (fireMask) fireMaskSource = 'registry-slot';
    }
    if (!fireMask) {
      fireMask = window.MapShine?.sceneComposer?.currentBundle?.masks?.find?.(
        (m) => (m?.id === 'fire' || m?.type === 'fire')
      )?.texture ?? null;
      if (fireMask) fireMaskSource = 'bundle-mask';
    }
    if (!fireMask) {
      fireMask = window.MapShine?.maskManager?.getTexture?.('fire.scene') ?? null;
      if (fireMask) fireMaskSource = 'mask-manager';
    }

    if (!fireMask) {
      dist.setSourceEnabled('heat', false);
      return;
    }

    // Guardrail: only trust compositor floor-scoped fire masks by default.
    // Weak/global fallback sources can keep a non-null texture resident even when
    // no meaningful fire contribution exists, forcing DistortionManager apply
    // every frame. Allow override for debugging/legacy behavior.
    const allowWeakHeatFallback = !!window?.MapShine?.__allowFireHeatMaskFallback;
    const reliableFireMask = fireMaskSource.startsWith('compositor-');
    if (!reliableFireMask && !allowWeakHeatFallback) {
      dist.setSourceEnabled('heat', false);
      return;
    }

    const baseIntensity = Number.isFinite(Number(fireParams.heatDistortionIntensity)) ? Number(fireParams.heatDistortionIntensity) : 0.05;
    const heatFrequency = Number.isFinite(Number(fireParams.heatDistortionFrequency)) ? Number(fireParams.heatDistortionFrequency) : 20.0;
    const heatSpeed = Number.isFinite(Number(fireParams.heatDistortionSpeed)) ? Number(fireParams.heatDistortionSpeed) : 3.0;
    const heatEdgeSoftness = Number.isFinite(Number(fireParams.heatDistortionEdgeSoftness))
      ? Number(fireParams.heatDistortionEdgeSoftness)
      : 1.0;
    const fireRate = Number.isFinite(Number(fireParams.globalFireRate)) ? Number(fireParams.globalFireRate) : 5.2;
    const fireSizeMin = Number.isFinite(Number(fireParams.fireSizeMin)) ? Number(fireParams.fireSizeMin) : 19;
    const fireSizeMax = Number.isFinite(Number(fireParams.fireSizeMax)) ? Number(fireParams.fireSizeMax) : 170;
    const avgSize = Math.max(1, (fireSizeMin + fireSizeMax) * 0.5);

    const sizeScale = Math.max(0.25, Math.min(2.0, avgSize / 95.0));
    const rateScale = Math.max(0.15, Math.min(2.0, fireRate / 5.2));
    const finalIntensity = Math.max(0.0, Math.min(0.2, baseIntensity * sizeScale * rateScale));
    if (finalIntensity <= 0.0001) {
      dist.setSourceEnabled('heat', false);
      return;
    }
    const softnessScale = Math.max(0.4, Math.min(3.0, heatEdgeSoftness));
    // Softer, larger feathering for heat masks; sharp clipping looked unnatural
    // around fire edges. Keep this in pixel-space style scaling and let
    // DistortionManager map it through its blur texel-size path.
    const blurRadiusBase = 3.0 + (avgSize / 30.0) + (fireRate * 0.22);
    const blurRadius = Math.max(4.0, Math.min(28.0, blurRadiusBase * softnessScale));
    const blurPasses = blurRadius >= 20.0 ? 5 : (blurRadius >= 14.0 ? 4 : (blurRadius >= 9.0 ? 3 : 2));

    let heatMask = fireMask;
    const needsBlurRefresh =
      this._fireHeatMaskInput !== fireMask ||
      Math.abs(this._fireHeatMaskBlurRadius - blurRadius) > 0.01 ||
      this._fireHeatMaskBlurPasses !== blurPasses;
    if (needsBlurRefresh) {
      this._fireHeatMaskInput = fireMask;
      this._fireHeatMaskBlurRadius = blurRadius;
      this._fireHeatMaskBlurPasses = blurPasses;
      this._fireHeatMaskOutput = dist.blurMask(fireMask, blurRadius, blurPasses) ?? fireMask;
    }
    if (this._fireHeatMaskOutput) heatMask = this._fireHeatMaskOutput;

    const source = dist.getSource('heat');
    if (!source) {
      dist.registerSource('heat', DistortionLayer.UNDER_OVERHEAD, heatMask, {
        intensity: finalIntensity,
        frequency: heatFrequency,
        speed: heatSpeed,
      });
      dist.setSourceEnabled('heat', true);
    } else {
      dist.updateSourceMask('heat', heatMask);
      dist.updateSourceParams('heat', {
        intensity: finalIntensity,
        frequency: heatFrequency,
        speed: heatSpeed,
      });
      dist.setSourceEnabled('heat', true);
    }
  }

  /**
   * Whether FireEffectV2 currently has any built systems across cached floors.
   * @private
   */
  _fireEffectHasAnySystems(fire) {
    const floorStates = fire?._floorStates;
    if (!(floorStates instanceof Map) || floorStates.size === 0) return false;
    for (const state of floorStates.values()) {
      if (this._fireEffectHasSystemsInState(state)) return true;
    }
    return false;
  }

  /**
   * @private
   * Whether a FireEffectV2 floor state has any resident systems.
   * This checks the actual per-floor arrays, not BatchedRenderer activation.
   */
  _fireEffectHasSystemsInState(state) {
    if (!state) return false;
    const n =
      (Number.isFinite(Number(state?.systems?.length)) ? Number(state.systems.length) : 0) +
      (Number.isFinite(Number(state?.emberSystems?.length)) ? Number(state.emberSystems.length) : 0) +
      (Number.isFinite(Number(state?.smokeSystems?.length)) ? Number(state.smokeSystems.length) : 0);
    return n > 0;
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
    try { this._shadowManagerEffect?.onResize?.(w, h); } catch (_) {}
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
    try { this._lensEffect?.onResize?.(w, h); } catch (_) {}
    try { this._distortionEffect?.onResize?.(w, h); } catch (_) {}
    try { this._floorDepthBlurEffect?.onResize?.(w, h); } catch (_) {}
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
    try { this._iridescenceEffect?.dispose?.(); } catch (_) {}
    try { this._prismEffect?.dispose?.(); } catch (_) {}
    try { this._bushEffect?.dispose?.(); } catch (_) {}
    try { this._treeEffect?.dispose?.(); } catch (_) {}
    try { this._fireEffect?.dispose?.(); } catch (_) {}
    try { this._dustEffect?.dispose?.(); } catch (_) {}
    try { this._windowLightEffect?.dispose?.(); } catch (_) {}
    try { this._cloudEffect?.dispose?.(); } catch (_) {}
    try { this._shadowManagerEffect?.dispose?.(); } catch (_) {}
    this._lightingPerspectiveContext = null;
    try { this._lightingEffect?.setLightingPerspectiveContext?.(null); } catch (_) {}
    try { this._lightingEffect?.dispose?.(); } catch (_) {}
    try { this._skyColorEffect?.dispose?.(); } catch (_) {}
    try { this._atmosphericFogEffect?.dispose?.(); } catch (_) {}
    try { this._fogEffect?.dispose?.(); } catch (_) {}
    try { this._bloomEffect?.dispose?.(); } catch (_) {}
    try { this._colorCorrectionEffect?.dispose?.(); } catch (_) {}
    try { this._overheadShadowEffect?.dispose?.(); } catch (_) {}
    try { this._buildingShadowEffect?.dispose?.(); } catch (_) {}
    try { this._smellyFliesEffect?.dispose?.(); } catch (_) {}
    try { this._lightningEffect?.dispose?.(); } catch (_) {}
    try { this._candleFlamesEffect?.dispose?.(); } catch (_) {}
    try { this._playerLightEffect?.dispose?.(); } catch (_) {}
    try { this._dotScreenEffect?.dispose?.(); } catch (_) {}
    try { this._halftoneEffect?.dispose?.(); } catch (_) {}
    try { this._asciiEffect?.dispose?.(); } catch (_) {}
    try { this._dazzleOverlayEffect?.dispose?.(); } catch (_) {}
    try { this._visionModeEffect?.dispose?.(); } catch (_) {}
    try { this._invertEffect?.dispose?.(); } catch (_) {}
    try { this._sepiaEffect?.dispose?.(); } catch (_) {}
    try { this._lensEffect?.dispose?.(); } catch (_) {}
    try { this._distortionEffect?.dispose?.(); } catch (_) {}
    try { this._floorDepthBlurEffect?.dispose?.(); } catch (_) {}
    try { this._maskDebugOverlayPass?.dispose?.(); } catch (_) {}
    try { this._renderBus?.dispose?.(); } catch (_) {}
    this._busPopulated = false;
    this._populateComplete = false;
    this._populatePromise = null;

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
    try { this._pixiWorldCompositeMaterial?.dispose?.(); } catch (_) {}
    try { this._pixiWorldCompositeQuad?.geometry?.dispose?.(); } catch (_) {}
    try { this._pixiUiOverlayMaterial?.dispose?.(); } catch (_) {}
    try { this._pixiUiOverlayQuad?.geometry?.dispose?.(); } catch (_) {}
    this._blitScene = null;
    this._blitCamera = null;
    this._blitMaterial = null;
    this._blitQuad = null;
    this._pixiWorldCompositeScene = null;
    this._pixiWorldCompositeCamera = null;
    this._pixiWorldCompositeMaterial = null;
    this._pixiWorldCompositeQuad = null;
    this._pixiUiOverlayScene = null;
    this._pixiUiOverlayCamera = null;
    this._pixiUiOverlayMaterial = null;
    this._pixiUiOverlayQuad = null;
    this._fogOverlayScene = null;
    this._fogOverlayCamera = null;

    this._initialized = false;
    log.info('FloorCompositor disposed');
  }
}
