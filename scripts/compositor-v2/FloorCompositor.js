/**
 * @fileoverview FloorCompositor — V2 compositor render orchestrator.
 *
 * Owns the FloorRenderBus and drives the per-frame render loop.
 * The bus scene contains all tile meshes Z-ordered by floor. Effects add
 * overlay meshes to the same bus scene so they benefit from the same floor
 * visibility system.
 *
 * Render pipeline:
 *   1. Global shadow/cloud passes, then each visible level: bus slice → level RTs,
 *      full post chain **per level** (lighting … filter … per-level water **only when a single
 *      floor is visible** … color correction … bloom …) **before** merge.
 *   2. **LevelCompositePass** blends per-level final RTs bottom→top (straight-alpha).
 *      With **multiple** visible floors, **WaterEffectV2** runs **once after** this
 *      merge so `tDiffuse` is the stacked scene (holes/stacking already correct).
 *      Single-floor keeps water inside the per-level chain (bloom MRT / spec path).
 *   3. Distortion, PIXI/fog/lens, mask debug, blit to screen, late overlays.
 *
 * Current effects (bus overlays — rendered in step 1):
 *   - **SpecularEffectV2**: Per-tile additive overlays driven by _Specular masks.
 *   - **FireEffectV2**: Per-floor particle systems driven by _Fire masks.
 *   - **WaterSplashesEffectV2**: Per-floor foam plume + rain splash particles
 *     driven by _Water masks. Own BatchedRenderer in the bus scene.
 *   - **WeatherParticlesV2**: Rain, snow, and ash particles via
 *     shared BatchedRenderer in the bus scene.
 *   - **AshDisturbanceEffectV2**: Token-movement ash bursts on `_Ash` masks (Quarks).
 *
 * Post-processing effects (per-level and composite passes):
 *   - **CloudEffectV2**: Procedural clouds — generates shadow RT (fed into Lighting)
 *     and cloud-top RT (blitted after lighting). Shadow occlusion uses overhead
 *     blockers plus a cross-floor mask for slabs above the active band.
 *   - **LightingEffectV2**: Ambient + dynamic lights + darkness, with cloud shadow.
 *     Window light overlays are fed into the light accumulation RT here so
 *     the compose shader tints them by surface albedo (preserving hue).
 *   - **WaterEffectV2**: Water tint/distortion/specular/foam driven by _Water masks.
 *   - **SkyColorEffectV2**: Time-of-day atmospheric color grading.
 *   - **BloomEffectV2**: Screen-space glow via UnrealBloomPass.
 *   - **ColorCorrectionEffectV2**: User-authored color grade (runs **after** per-level
 *     water so tint/spec/foam receive the same grade as the rest of the scene; no extra pass).
 *   - **SharpenEffectV2**: Unsharp mask filter (disabled by default).
 *
 * Called by EffectComposer.render() in the V2-only runtime.
 *
 * @module compositor-v2/FloorCompositor
 */

import { createLogger } from '../core/log.js';
import { yieldToMain } from '../core/yield-to-main.js';
import { OVERLAY_THREE_LAYER } from '../core/render-layers.js';
import { FloorRenderBus } from './FloorRenderBus.js';
import { ReplicaOcclusionMaskPass } from './ReplicaOcclusionMaskPass.js';
import { SpecularEffectV2 } from './effects/SpecularEffectV2.js';
import { FireEffectV2 } from './effects/FireEffectV2.js';
import { AshDisturbanceEffectV2 } from './effects/AshDisturbanceEffectV2.js';
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
import { FluidEffectV2 } from './effects/FluidEffectV2.js';
import { IridescenceEffectV2 } from './effects/IridescenceEffectV2.js';
import { PrismEffectV2 } from './effects/PrismEffectV2.js';
import { BushEffectV2 } from './effects/BushEffectV2.js';
import { TreeEffectV2 } from './effects/TreeEffectV2.js';
import { OverheadShadowsEffectV2 } from './effects/OverheadShadowsEffectV2.js';
import { BuildingShadowsEffectV2 } from './effects/BuildingShadowsEffectV2.js';
import { SkyReachShadowsEffectV2 } from './effects/SkyReachShadowsEffectV2.js';
import { PaintedShadowEffectV2 } from './effects/PaintedShadowEffectV2.js';
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
import { MaskBindingController } from '../masks/mask-binding-controller.js';
import { MaskDebugOverlayPass } from './MaskDebugOverlayPass.js';
import { LevelRenderTargetPool } from './LevelRenderTargetPool.js';
import { LevelCompositePass } from './LevelCompositePass.js';
import { LevelAlphaRebindPass } from './LevelAlphaRebindPass.js';
import { getSceneRectScissor, withSceneScissor, withoutSceneScissor } from './SceneRectScissor.js';
import { resolveEffectEnabled, resolveOverlayEffectActive, resolveFloorEffectActive } from '../effects/resolve-effect-enabled.js';

const log = createLogger('FloorCompositor');

/**
 * Per-effect wall-clock ceiling while `_ensureBusPopulated` runs jobs in series.
 * If populate() awaits many slow network probes (e.g. Specular mask checks), the
 * work should still interleave with timers unless the main thread is blocked.
 */
/** Per-effect ceiling; specular mask discovery can still be heavy on huge maps. */
const POPULATE_JOB_TIMEOUT_MS = 90000;

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
     * Last `foundrySceneData` snapshot used during populate (world height, scene rect).
     * Used to refresh per-tile V2 overlays when a tile's image changes after load.
     * @type {object|null}
     */
    this._lastFoundrySceneData = null;

    /**
     * FloorRenderBus: owns a single THREE.Scene containing all tile meshes
     * Z-ordered by floor index. Textures loaded independently via
     * THREE.TextureLoader (straight alpha, no canvas 2D corruption).
     * @type {FloorRenderBus}
     */
    this._renderBus = new FloorRenderBus();

    /**
     * Option B: Map Shine GPU occlusion RT (radial holes) matching Foundry semantics,
     * without PIXI `extract.canvas` readback.
     * @type {ReplicaOcclusionMaskPass}
     */
    this._replicaOcclusionMaskPass = new ReplicaOcclusionMaskPass();

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
     * V2 Ash Disturbance: token-movement bursts on `_Ash` masks (Quarks), bus overlay.
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
     * V2 Sky Reach Shadows Effect: projects upper-floor `floorAlpha` silhouettes
     * (bridges, roofs, solid upper-floor tiles) as directional shadows onto the
     * currently-viewed floor. Combines with {@link BuildingShadowsEffectV2} via
     * {@link ShadowManagerV2} into `tCombinedShadow`.
     * @type {SkyReachShadowsEffectV2}
     */
    this._skyReachShadowEffect = new SkyReachShadowsEffectV2();

    /**
     * V2 Painted Shadow Effect: projects authored _Shadow masks along sun direction.
     * Contribution is gated by _Outdoors so interiors remain fully lit.
     * @type {PaintedShadowEffectV2}
     */
    this._paintedShadowEffect = new PaintedShadowEffectV2();

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

    /** @type {number} Last forceRepopulate wall-clock ms (for coalescing) */
    this._lastForceRepopulateAtMs = 0;
    /** @type {string|null} Scene id associated with last forceRepopulate */
    this._lastForceRepopulateSceneId = null;
    /** @type {string|null} Last forceRepopulate source tag */
    this._lastForceRepopulateSource = null;

    /** @type {number} Throttle anchor for `[POPULATE RENDER-SLIM]` logs. */
    this._populateSlimRenderLogNextAt = 0;

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
    /** @type {string|null} Last level-context key used for outdoors consumer sync */
    this._lastOutdoorsContextKey = null;
    /**
     * Comprehensive binding signature for outdoors mask propagation.
     * Combines context key, resolved floor keys, and texture uuids for the main
     * outdoors texture, water outdoors texture, sky outdoors texture, per-floor
     * cloud outdoors array, and the floor-id texture. We use this instead of a
     * single-texture identity check so that changes in any consumer's required
     * binding trigger a re-sync (catches e.g. per-cloud-floor texture promotion
     * when only the water floor texture actually changed).
     * @type {string|null}
     */
    this._lastOutdoorsSignature = null;
    /**
     * Latest outdoors signature resolution route for diagnostics. Surfaces the
     * route taken for each consumer (direct GPU cache / bundle / registry /
     * neutral fallback / weatherController).
     * @type {object|null}
     */
    this._lastOutdoorsRouteInfo = null;

    /**
     * Strict-sync frame hold counters. Incremented whenever the dependency
     * gate rejects a frame so the last-valid output is held instead.
     * @type {number}
     */
    this._strictFrameHoldCount = 0;
    /** @type {string|null} Last reason reported by the dependency gate */
    this._strictLastHoldReason = null;
    /** @type {number|null} Timestamp of last hold (ms) */
    this._strictLastHoldAtMs = null;
    /** @type {number} Count of successful strict frames */
    this._strictFramesRendered = 0;
    /** @type {THREE.Texture|null} 1x1 indoors fallback when floor-scoped outdoors is unavailable */
    this._neutralOutdoorsTexture = null;

    /**
     * MaskBindingController: unified per-floor mask fan-out engine. Wrapped
     * in a lazy accessor so we can toggle it at runtime via
     * `window.MapShine.maskBindingControllerEnabled` during rollout. The
     * controller runs alongside the legacy `_syncOutdoorsMaskConsumers` path
     * until every consumer is migrated to banded bindings.
     * @type {import('../masks/mask-binding-controller.js').MaskBindingController|null}
     */
    this._maskBindingController = null;

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
    /** @type {THREE.WebGLRenderTarget|null} Ping-pong scratch for upper-alpha occluder union */
    this._waterOccluderScratchRT = null;
    /** @type {THREE.Scene|null} Fullscreen scene for upper-alpha occluder union */
    this._waterOccluderUnionScene = null;
    /** @type {THREE.OrthographicCamera|null} Camera for upper-alpha occluder union */
    this._waterOccluderUnionCamera = null;
    /** @type {THREE.ShaderMaterial|null} Material for upper-alpha occluder union */
    this._waterOccluderUnionMaterial = null;
    /** @type {THREE.Mesh|null} Fullscreen quad for upper-alpha occluder union */
    this._waterOccluderUnionQuad = null;
    /** @type {THREE.Scene|null} sceneRT.a × source-floor overhead mask */
    this._waterSourceOccProductScene = null;
    this._waterSourceOccProductCamera = null;
    this._waterSourceOccProductMaterial = null;
    this._waterSourceOccProductQuad = null;
    /** @type {import('three').Texture|null} Deck mask for this frame (built after bus prepass) */
    this._frameWaterSourceDeckTex = null;
    /** @type {import('three').Texture|null} Source slice alpha matching deck mask */
    this._frameWaterSourceSliceTex = null;

    /** @type {THREE.WebGLRenderTarget|null} Ping-pong A: post-merge bg stack → water mask */
    this._waterBgProductRT = null;
    /** @type {THREE.WebGLRenderTarget|null} Ping-pong B */
    this._waterBgProductScratchRT = null;
    /** @type {THREE.Scene|null} */
    this._waterBgProductScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._waterBgProductCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._waterBgProductMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._waterBgProductQuad = null;

    // ── Per-Level RT Pipeline ─────────────────────────────────────────────────
    /** @type {LevelRenderTargetPool} Per-level RT allocation pool */
    this._levelRTPool = new LevelRenderTargetPool();
    /** @type {LevelCompositePass} Alpha-based bottom→top level compositor */
    this._levelCompositePass = new LevelCompositePass();
    /**
     * @type {LevelAlphaRebindPass} Final per-level pass that clamps a
     * level's post-chain alpha to the authored solidity alpha captured
     * in the raw sceneRT. Guarantees hole pixels stay holes regardless
     * of post-pass alpha widening. See {@link LevelAlphaRebindPass}.
     */
    this._levelAlphaRebindPass = new LevelAlphaRebindPass();

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
     * Revalidated periodically to avoid paying a permanent late-overlay render
     * cost after transient overlay emitters/descriptors are removed.
     * @type {boolean}
     */
    this._hasOverlayLayerContent = false;
    /** @type {number} Next timestamp (performance.now) for overlay-layer re-scan */
    this._overlayLayerScanNextAt = 0;
    /** @type {number} Min interval between overlay-layer scans in ms */
    this._overlayLayerScanIntervalMs = 350;

    // PERFORMANCE: Pre-allocated objects to eliminate GC pressure in the render loop
    this._tempColor = null;
    this._tempVec4 = null;
    this._tempVec2 = null;
    this._tempVec3_1 = null;
    this._tempVec3_2 = null;
    this._tempVec3_3 = null;

    this._tempActiveLevels = new Set();
    this._tempLevelFinalRTs = [];
    this._tempLevelSceneRTs = [];
    this._tempPerLevelEntries = [];
    this._tempTextures = [];

    this._frameValidation = { valid: false, reason: null, details: {} };
    
    this._pixiWorldStageMat = { a: NaN, b: NaN, c: NaN, d: NaN, tx: NaN, ty: NaN };
    this._pixiStageInverse = { ia: 1, ib: 0, ic: 0, id: 1, itx: 0, ity: 0 };

    this._dynamicLightOverride = {
      texture: null,
      windowTexture: null,
      enabled: true,
      strength: 0.7,
      viewBounds: { x: 0, y: 0, z: 1, w: 1 },
      sceneDimensions: { x: 1, y: 1 },
      sceneRect: { x: 0, y: 0, z: 1, w: 1 }
    };

    this._outdoorsStateCache = {
      contextKey: null, mainTex: null, mainRoute: null,
      waterTex: null, waterRoute: null, waterFloorIdx: null,
      skyTex: null, skyRoute: null,
      skyReachTex: null, skyReachRoute: null,
      paintedTex: null, paintedRoute: null,
      cloudMulti: false, floorIdTex: null, activeFloorIdx: null, cacheVersion: null,
      cloudTex0: null, cloudTex1: null, cloudTex2: null, cloudTex3: null
    };

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
    let stageChanged = false;

    if (!t) {
      if (!Number.isNaN(this._pixiWorldStageMat.a)) stageChanged = true;
    } else {
      if (t.a !== this._pixiWorldStageMat.a || t.b !== this._pixiWorldStageMat.b ||
          t.c !== this._pixiWorldStageMat.c || t.d !== this._pixiWorldStageMat.d ||
          t.tx !== this._pixiWorldStageMat.tx || t.ty !== this._pixiWorldStageMat.ty) {

          stageChanged = true;
          this._pixiWorldStageMat.a = t.a; this._pixiWorldStageMat.b = t.b;
          this._pixiWorldStageMat.c = t.c; this._pixiWorldStageMat.d = t.d;
          this._pixiWorldStageMat.tx = t.tx; this._pixiWorldStageMat.ty = t.ty;
      }
    }

    if (stageChanged) {
      this._computePixiStageInverse(t, this._pixiStageInverse);
      const inv = this._pixiStageInverse;
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
   * @param {{ia:number,ib:number,ic:number,id:number,itx:number,ity:number}} out
   * @returns {{ia:number,ib:number,ic:number,id:number,itx:number,ity:number}}
   * @private
   */
  _computePixiStageInverse(t, out) {
    out.ia = 1; out.ib = 0; out.ic = 0; out.id = 1; out.itx = 0; out.ity = 0;
    if (!t) return out;

    const a = Number(t.a) || 0;
    const b = Number(t.b) || 0;
    const c = Number(t.c) || 0;
    const d = Number(t.d) || 0;
    const tx = Number(t.tx) || 0;
    const ty = Number(t.ty) || 0;

    const det = (a * d) - (b * c);
    if (Math.abs(det) <= 1e-8) return out;

    out.ia = d / det;
    out.ib = -b / det;
    out.ic = -c / det;
    out.id = a / det;
    out.itx = ((c * ty) - (d * tx)) / det;
    out.ity = ((b * tx) - (a * ty)) / det;
    return out;
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

    // P2: Skip the late overlay render call when no objects are on
    // OVERLAY_THREE_LAYER. Re-scan periodically (or when currently false) so the
    // flag can both promote and demote as overlay content appears/disappears.
    const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const shouldRescan = !this._hasOverlayLayerContent || now >= this._overlayLayerScanNextAt;
    if (shouldRescan) {
      // Cheap refresh: check if any bus scene child has overlay layer enabled.
      // Only scans top-level children (not full traverse) to keep this O(N-floors).
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
      const scanEvery = Math.max(100, Number(this._overlayLayerScanIntervalMs) || 350);
      this._overlayLayerScanNextAt = now + scanEvery;
    }
    if (!this._hasOverlayLayerContent) return;

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
    if (!resolveEffectEnabled(fog)) return false;
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
   * @returns {Promise<void>}
   */
  async initialize(options = {}) {
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

    if (THREE.ColorManagement && typeof THREE.ColorManagement.enabled === 'boolean') {
      THREE.ColorManagement.enabled = true;
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
    // Color space (aligned with V3ThreeSceneHost / V3EffectChain conventions):
    // - Scene + post ping-pong RTs: LinearSRGBColorSpace — Three renders into RTs in
    //   linear working space; materials sample SRGB albedo textures with correct decode.
    //   Final sRGB encode for the canvas comes from renderer.outputColorSpace + the
    //   fullscreen blit path (see renderer-strategy configure()).
    // - Mask / non-color data RTs: NoColorSpace — same rationale as V3 mask passes and
    //   V3EffectChain ping-pong targets (avoid automatic transfer on read/write).
    const makeRt = (type, depthBuffer) => ({
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type,
      depthBuffer: !!depthBuffer,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    let preferredType = THREE.HalfFloatType;
    // Quick capability probe: if we can't create a half-float RT, fall back.
    try {
      const probe = new THREE.WebGLRenderTarget(4, 4, makeRt(THREE.HalfFloatType, false));
      probe.dispose();
    } catch (e) {
      preferredType = THREE.UnsignedByteType;
      log.warn('FloorCompositor.initialize: HalfFloat RT unsupported; falling back to UnsignedByte RTs', e);
    }

    const rtOpts = makeRt(preferredType, true);
    this._sceneRT = new THREE.WebGLRenderTarget(w, h, rtOpts);

    // Ping-pong pair for post-processing chain. No depth needed for post passes.
    const postOpts = makeRt(preferredType, false);
    this._postA = new THREE.WebGLRenderTarget(w, h, postOpts);
    this._postB = new THREE.WebGLRenderTarget(w, h, postOpts);

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
      colorSpace: THREE.NoColorSpace,
    });
    this._waterOccluderScratchRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace,
    });
    this._waterOccluderUnionScene = new THREE.Scene();
    this._waterOccluderUnionCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._waterOccluderUnionMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tBase: { value: null },
        tUpper: { value: null },
        uHasBase: { value: 0.0 },
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
        uniform sampler2D tUpper;
        uniform float uHasBase;
        varying vec2 vUv;
        // Authoritative coverage for water occlusion: alpha only, stacked
        // bottom-to-top with the same straight-alpha source-over rule as
        // LevelCompositePass (not per-pixel max). Independent per-slice max
        // treated every deck as simultaneously in front at the same UV, so a
        // solid pixel on a lower bridge combined with a hole in the roof still
        // read as fully occluded and killed post-merge water from upper views.
        void main() {
          float upperA = texture2D(tUpper, vUv).a;
          float outA = (uHasBase > 0.5)
            ? (upperA + texture2D(tBase, vUv).a * (1.0 - upperA))
            : upperA;
          gl_FragColor = vec4(0.0, 0.0, 0.0, outA);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._waterOccluderUnionMaterial.toneMapped = false;
    this._waterOccluderUnionQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._waterOccluderUnionMaterial,
    );
    this._waterOccluderUnionQuad.frustumCulled = false;
    this._waterOccluderUnionScene.add(this._waterOccluderUnionQuad);

    this._waterSourceOccProductScene = new THREE.Scene();
    this._waterSourceOccProductCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._waterSourceOccProductMaterial = new THREE.ShaderMaterial({
      name: 'WaterSourceOccProduct',
      uniforms: {
        tScene: { value: null },
        tRoof: { value: null },
        uHasRoof: { value: 0.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision mediump float;
        uniform sampler2D tScene;
        uniform sampler2D tRoof;
        uniform float uHasRoof;
        varying vec2 vUv;
        void main() {
          float sceneA = smoothstep(0.10, 0.88, texture2D(tScene, vUv).a);
          float roofA = smoothstep(0.34, 0.66, texture2D(tRoof, vUv).a);
          float occ = sceneA * roofA * step(0.5, uHasRoof);
          gl_FragColor = vec4(0.0, 0.0, 0.0, occ);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._waterSourceOccProductMaterial.toneMapped = false;
    this._waterSourceOccProductQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._waterSourceOccProductMaterial,
    );
    this._waterSourceOccProductQuad.frustumCulled = false;
    this._waterSourceOccProductScene.add(this._waterSourceOccProductQuad);

    const bgProdRtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace,
    };
    this._waterBgProductRT = new THREE.WebGLRenderTarget(w, h, bgProdRtOpts);
    this._waterBgProductScratchRT = new THREE.WebGLRenderTarget(w, h, bgProdRtOpts);
    this._waterBgProductScene = new THREE.Scene();
    this._waterBgProductCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._waterBgProductMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tAccum: { value: null },
        tLayer: { value: null },
        uHasAccum: { value: 0.0 },
        uViewBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        uSceneRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uHasSceneRect: { value: 0.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tAccum;
        uniform sampler2D tLayer;
        uniform float uHasAccum;
        uniform vec4 uViewBounds;
        uniform vec2 uSceneDimensions;
        uniform vec4 uSceneRect;
        uniform float uHasSceneRect;
        varying vec2 vUv;

        vec2 screenUvToFoundry(vec2 screenUv) {
          float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
          return vec2(threeX, uSceneDimensions.y - threeY);
        }
        vec2 foundryToSceneUv(vec2 foundryPos) {
          return (foundryPos - uSceneRect.xy) / max(uSceneRect.zw, vec2(1e-5));
        }

        void main() {
          float prev = (uHasAccum > 0.5) ? texture2D(tAccum, vUv).r : 1.0;
          vec2 sceneUv = vUv;
          if (uHasSceneRect > 0.5) {
            sceneUv = foundryToSceneUv(screenUvToFoundry(vUv));
          }
          float a = texture2D(tLayer, sceneUv).a;
          float trans = 1.0 - smoothstep(0.04, 0.22, a);
          float outR = prev * trans;
          gl_FragColor = vec4(outR, outR, outR, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._waterBgProductMaterial.toneMapped = false;
    this._waterBgProductQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._waterBgProductMaterial,
    );
    this._waterBgProductQuad.frustumCulled = false;
    this._waterBgProductScene.add(this._waterBgProductQuad);

    // ── Per-level RT infrastructure ───────────────────────────────────────
    this._levelRTPool.initialize(w, h, preferredType);
    this._levelCompositePass.initialize();
    this._levelAlphaRebindPass.initialize();

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

    // Let the browser run timers / websocket heartbeats after heavy RT + shader setup.
    await yieldToMain();

    // ── Effects + hooks ───────────────────────────────────────────────────
    this._renderBus.initialize();
    await yieldToMain();

    // Movement preview UI: path lines, tile highlights, ghost tokens, drag ghosts.
    // Must initialize after _renderBus so _scene is available.
    try {
      this._movementPreviewEffect.initialize();
    } catch (err) {
      log.warn('FloorCompositor: MovementPreviewEffectV2 initialize failed:', err);
    }
    await yieldToMain();

    // Door meshes are still managed by the legacy DoorMeshManager, but in V2
    // only the FloorRenderBus scene is rendered. Re-target existing and future
    // door meshes to the bus scene so door graphics remain visible.
    try {
      const doorMeshManager = window.MapShine?.doorMeshManager ?? null;
      doorMeshManager?.setScene?.(this._renderBus._scene ?? null);
    } catch (err) {
      log.warn('FloorCompositor: failed to route door meshes to V2 render bus scene:', err);
    }
    try {
      const drawingManager = window.MapShine?.drawingManager ?? null;
      drawingManager?.setScene?.(this._renderBus._scene ?? null);
      drawingManager?.syncAllDrawings?.();
      drawingManager?.updateVisibility?.();
    } catch (err) {
      log.warn('FloorCompositor: failed to route scene drawings to V2 render bus scene:', err);
    }
    await yieldToMain();

    // Keep compositor startup resilient: a single effect init failure should not
    // abort V2 rendering entirely. Each effect is isolated and logged.
    // `_reportProgress` is called after each init to advance the loading overlay.
    const initEffect = async (label, fn) => {
      try {
        fn?.();
      } catch (err) {
        log.warn(`FloorCompositor: ${label} initialize failed:`, err);
      }
      _reportProgress(label);
      await yieldToMain();
    };

    // Initialize floor depth blur with the same RT type as the rest of the pipeline.
    await initEffect('FloorDepthBlurEffect', () =>
      this._floorDepthBlurEffect.initialize(this.renderer, w, h, preferredType));
    await initEffect('SpecularEffectV2', () => this._specularEffect.initialize());
    await initEffect('FluidEffectV2', () => this._fluidEffect.initialize());
    await initEffect('IridescenceEffectV2', () => this._iridescenceEffect.initialize());
    await initEffect('PrismEffectV2', () => this._prismEffect.initialize());
    await initEffect('BushEffectV2', () => this._bushEffect.initialize());
    await initEffect('TreeEffectV2', () => this._treeEffect.initialize());
    await initEffect('FireEffectV2', () => this._fireEffect.initialize());
    await initEffect('AshDisturbanceEffectV2', () => this._ashDisturbanceEffect.initialize());
    await initEffect('DustEffectV2', () => this._dustEffect.initialize());
    await initEffect('WindowLightEffectV2', () => this._windowLightEffect.initialize());
    try {
      const tm = window.MapShine?.tileManager ?? null;
      tm?.setWindowLightEffect?.(this._windowLightEffect);
    } catch (err) {
      log.warn('FloorCompositor: failed to link WindowLightEffectV2 to TileManager:', err);
    }
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
    await yieldToMain();
    await initEffect('ShadowManagerV2', () => this._shadowManagerEffect.initialize(this.renderer, w, h));
    // Water splashes: own BatchedRenderer added via addEffectOverlay.
    try { this._waterSplashesEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: WaterSplashesEffectV2 initialize failed:', err);
    }
    _reportProgress('WaterSplashesEffectV2');
    await yieldToMain();
    // Weather particles live in the bus scene so they render in the same pass as tiles.
    try { this._weatherParticles?.initialize?.(this._renderBus._scene); } catch (err) {
      log.warn('FloorCompositor: WeatherParticlesV2 initialize failed:', err);
    }
    _reportProgress('WeatherParticlesV2');
    await yieldToMain();

    // Smelly flies uses the particles bridge batch renderer and should render
    // in the bus scene for V2.
    try { this._smellyFliesEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera); } catch (err) {
      log.warn('FloorCompositor: SmellyFliesEffect initialize failed:', err);
    }
    _reportProgress('SmellyFliesEffect');
    await yieldToMain();
    // Lightning renders procedural strike meshes in the bus scene.
    try { this._lightningEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera); } catch (err) {
      log.warn('FloorCompositor: LightningEffectV2 initialize failed:', err);
    }
    _reportProgress('LightningEffectV2');
    await yieldToMain();

    // Candle flames render in bus scene and push glow into lighting lightScene.
    try {
      this._candleFlamesEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera);
      this._candleFlamesEffect?.setLightingEffect?.(this._lightingEffect);
    } catch (err) {
      log.warn('FloorCompositor: CandleFlamesEffectV2 initialize failed:', err);
    }
    _reportProgress('CandleFlamesEffectV2');
    await yieldToMain();

    // Player light renders token-attached flashlight/torch effects and drives
    // gameplay-facing dynamic light behavior.
    try {
      this._playerLightEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera);
    } catch (err) {
      log.warn('FloorCompositor: PlayerLightEffectV2 initialize failed:', err);
    }
    _reportProgress('PlayerLightEffectV2');
    await yieldToMain();

    // Subscribe outdoors mask consumers so they receive the texture as soon as
    // populate() builds it, and again on every floor change.
    // CloudEffectV2: cloud shadows and cloud tops only fall on outdoor areas.
    // We set both the legacy single-texture path (setOutdoorsMask, which is the one
    // Outdoors mask subscribers now wired via EffectMaskRegistry in initialize()

    await initEffect('LightingEffectV2', () => this._lightingEffect.initialize(w, h));
    await initEffect('SkyColorEffectV2', () => this._skyColorEffect.initialize());
    await initEffect('ColorCorrectionEffectV2', () => this._colorCorrectionEffect.initialize());
    await initEffect('FilterEffectV2', () => this._filterEffect.initialize());
    await initEffect('AtmosphericFogEffectV2', () => this._atmosphericFogEffect.initialize(this.renderer, this._renderBus._scene, this.camera));
    await initEffect('FogOfWarEffectV2', () => this._fogEffect.initialize(this.renderer, this.scene, this.camera));
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
    await initEffect('BloomEffectV2', () => this._bloomEffect.initialize(w, h));
    await initEffect('SharpenEffectV2', () => this._sharpenEffect.initialize());
    if (this._waterEffect) {
      await initEffect('WaterEffectV2', () => this._waterEffect.initialize());
    } else {
      _reportProgress('WaterEffectV2');
      await yieldToMain();
    }
    // OverheadShadowsEffectV2 initialization
    try { 
      this._overheadShadowEffect?.initialize?.(this.renderer, this._renderBus._scene, this.camera, null);
    } catch (err) {
      log.warn('FloorCompositor: OverheadShadowsEffectV2 initialize failed:', err);
    }
    _reportProgress('OverheadShadowsEffectV2');
    await yieldToMain();
    try {
      this._buildingShadowEffect?.initialize?.(this.renderer, this.camera);
    } catch (err) {
      log.warn('FloorCompositor: BuildingShadowsEffectV2 initialize failed:', err);
    }
    _reportProgress('BuildingShadowsEffectV2');
    await yieldToMain();
    try {
      this._skyReachShadowEffect?.initialize?.(this.renderer, this.camera);
    } catch (err) {
      log.warn('FloorCompositor: SkyReachShadowsEffectV2 initialize failed:', err);
    }
    _reportProgress('SkyReachShadowsEffectV2');
    await yieldToMain();
    try {
      this._paintedShadowEffect?.initialize?.(this.renderer);
    } catch (err) {
      log.warn('FloorCompositor: PaintedShadowEffectV2 initialize failed:', err);
    }
    _reportProgress('PaintedShadowEffectV2');
    await yieldToMain();

    // Artistic post-processing effects (disabled by default)
    try { this._dotScreenEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: DotScreenEffectV2 initialize failed:', err);
    }
    _reportProgress('DotScreenEffectV2');
    await yieldToMain();
    try { this._halftoneEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: HalftoneEffectV2 initialize failed:', err);
    }
    _reportProgress('HalftoneEffectV2');
    await yieldToMain();
    try { this._asciiEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: AsciiEffectV2 initialize failed:', err);
    }
    _reportProgress('AsciiEffectV2');
    await yieldToMain();
    try { this._dazzleOverlayEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: DazzleOverlayEffectV2 initialize failed:', err);
    }
    _reportProgress('DazzleOverlayEffectV2');
    await yieldToMain();
    try { this._visionModeEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: VisionModeEffectV2 initialize failed:', err);
    }
    _reportProgress('VisionModeEffectV2');
    await yieldToMain();
    try { this._invertEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: InvertEffectV2 initialize failed:', err);
    }
    _reportProgress('InvertEffectV2');
    await yieldToMain();
    try { this._sepiaEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: SepiaEffectV2 initialize failed:', err);
    }
    _reportProgress('SepiaEffectV2');
    await yieldToMain();
    try { this._lensEffect?.initialize?.(); } catch (err) {
      log.warn('FloorCompositor: LensEffectV2 initialize failed:', err);
    }
    _reportProgress('LensEffectV2');
    await yieldToMain();
    await initEffect('DistortionManagerV2', () => this._distortionEffect.initialize(this.renderer, this._renderBus._scene, this.camera));

    try {
      if (window.MapShine) window.MapShine.distortionManager = this._distortionEffect;
    } catch (_) {}

    // Listen for floor/level changes so we can update tile mesh visibility.
    this._levelHookId = Hooks.on('mapShineLevelContextChanged', (payload) => {
      this._onLevelContextChanged(payload);
    });

    this._initialized = true;
    // Pre-clear global ping-pong RTs to opaque black so the outer-rect
    // area (untouched by every scissored pass) has a known value when
    // bloom samples its input at full UV. See SceneRectScissor.
    try { this._clearGlobalRTsToBlack(); } catch (err) {
      log.warn('FloorCompositor: initial _clearGlobalRTsToBlack failed:', err);
    }
    log.info(`FloorCompositor initialized (${w}x${h}, RT: HalfFloat)`);
  }

  /**
   * Unscissored full clear of every global ping-pong / scratch RT to
   * opaque black. Run once at initialize time and again after a resize
   * (which reallocates underlying texture storage) so the SceneRectScissor
   * pipeline never reads driver-uninitialized memory in the outer-rect
   * area. Bloom is the main consumer that samples its input at full UV,
   * so this matters specifically for `_postA` / `_postB`.
   *
   * @private
   */
  _clearGlobalRTsToBlack() {
    const renderer = this.renderer;
    if (!renderer || typeof renderer.setRenderTarget !== 'function') return;
    const THREE = window.THREE;
    const targets = [
      this._sceneRT,
      this._postA,
      this._postB,
      this._waterOccluderRT,
      this._waterOccluderScratchRT,
      this._waterBgProductRT,
      this._waterBgProductScratchRT,
    ].filter((rt) => rt);
    if (!targets.length) return;

    const prevTarget = renderer.getRenderTarget?.();
    const prevAutoClear = renderer.autoClear;
    const prevScissor = (typeof renderer.getScissorTest === 'function')
      ? renderer.getScissorTest()
      : null;
    if (!this._tempColor && THREE) this._tempColor = new THREE.Color();
    const prevColor = (THREE && typeof renderer.getClearColor === 'function')
      ? renderer.getClearColor(this._tempColor)
      : null;
    const prevAlpha = (typeof renderer.getClearAlpha === 'function')
      ? renderer.getClearAlpha()
      : null;

    try {
      if (typeof renderer.setScissorTest === 'function') renderer.setScissorTest(false);
      if (typeof renderer.setClearColor === 'function') renderer.setClearColor(0x000000, 1);
      if (typeof renderer.setClearAlpha === 'function') renderer.setClearAlpha(1);
      renderer.autoClear = true;
      for (const rt of targets) {
        renderer.setRenderTarget(rt);
        if (typeof renderer.clear === 'function') renderer.clear(true, true, true);
      }
    } finally {
      renderer.autoClear = prevAutoClear;
      try {
        if (prevColor && typeof renderer.setClearColor === 'function') {
          renderer.setClearColor(prevColor, prevAlpha != null ? prevAlpha : 1);
        }
      } catch (_) {}
      try {
        if (prevAlpha != null && typeof renderer.setClearAlpha === 'function') {
          renderer.setClearAlpha(prevAlpha);
        }
      } catch (_) {}
      try {
        if (prevScissor != null && typeof renderer.setScissorTest === 'function') {
          renderer.setScissorTest(prevScissor);
        }
      } catch (_) {}
      try {
        if (typeof renderer.setRenderTarget === 'function') {
          renderer.setRenderTarget(prevTarget ?? null);
        }
      } catch (_) {}
    }
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
      if (resolveOverlayEffectActive(fluid)) {
        reason = 'fluid:overlays';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const iridescence = this._iridescenceEffect;
      if (resolveOverlayEffectActive(iridescence)) {
        reason = 'iridescence:overlays';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const prism = this._prismEffect;
      if (resolveOverlayEffectActive(prism)) {
        reason = 'prism:overlays';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const bush = this._bushEffect;
      if (resolveOverlayEffectActive(bush)) {
        reason = 'bush:overlays';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const tree = this._treeEffect;
      if (resolveOverlayEffectActive(tree)) {
        reason = 'tree:overlays';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const fire = this._fireEffect;
      if (resolveFloorEffectActive(fire)) {
        reason = 'fire:active-floors';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const dust = this._dustEffect;
      if (resolveFloorEffectActive(dust)) {
        reason = 'dust:active-floors';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const water = this._waterEffect;
      const waterActive = !!(
        resolveEffectEnabled(water)
        && (
          (typeof water?.hasRenderableWater === 'function' ? water.hasRenderableWater() : false)
          || ((Number(water?._composeMaterial?.uniforms?.uHasWaterData?.value) || 0) > 0)
          || ((Number(water?._composeMaterial?.uniforms?.uHasWaterRawMask?.value) || 0) > 0)
        )
      );
      if (waterActive) {
        reason = 'water:active-data';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const splash = this._waterSplashesEffect;
      if (resolveFloorEffectActive(splash)) {
        reason = 'splashes:active-floors';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const flies = this._smellyFliesEffect;
      if (resolveEffectEnabled(flies) && (flies?.flySystems?.size ?? 0) > 0) {
        reason = 'flies:systems';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const lightning = this._lightningEffect;
      if (resolveEffectEnabled(lightning) && lightning?.wantsContinuousRender?.()) {
        reason = 'lightning:wants-continuous';
        if (window.MapShine) window.MapShine.__v2ContinuousRenderReason = reason;
        return true;
      }
      const candles = this._candleFlamesEffect;
      if (resolveEffectEnabled(candles) && ((candles?._sourceFlameCount ?? 0) > 0 || (candles?._glowBuckets?.size ?? 0) > 0)) {
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
          || playerLight?._nightVisionActive === true
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
      if (window.MapShine?.externalEffects?.requiresContinuousRender?.()) {
        reason = 'external-effects';
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
      if (resolveOverlayEffectActive(fluid)) {
        // Fluid shader animation looks noticeably stepped at 30fps.
        // Prefer 60fps while fluid overlays are active.
        return 60;
      }
      const externalFps = Number(window.MapShine?.externalEffects?.getPreferredContinuousFps?.());
      if (Number.isFinite(externalFps) && externalFps > 0) return externalFps;
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

    if (!resolveEffectEnabled(effect)) return false;

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
   * When scene `effectHints.maskIds` is non-empty, mask-driven populate jobs
   * can be pruned to match `_shouldWarmupEffectKey` semantics. When hints are
   * absent or empty, keep all mask-driven jobs for backward compatibility.
   *
   * @returns {boolean}
   * @private
   */
  _effectHintsDrivePopulateMaskPruning() {
    // Cold-load level/background races can produce stale/incomplete sceneEffectHints.
    // Pruning mask-driven populate jobs from those hints permanently drops effects
    // for the session (clouds still render, tile effects do not). Keep populate
    // authoritative by always running mask-driven jobs.
    return false;
  }

  /**
   * Force a full populate replay on the next ensure pass.
   *
   * Used after late level/background synchronization on cold load so mask-driven
   * effects (specular/fire/fluid/windows/etc.) are rebuilt from final runtime state.
   *
   * @param {object} [options]
   * @param {string} [options.source='runtime-refresh']
   * @returns {Promise<boolean>}
   */
  async forceRepopulate(options = {}) {
    const { source = 'runtime-refresh' } = options;

    // Coalesce duplicate repopulate requests emitted during cold-load/level-sync
    // bootstrap paths (e.g. cold-load-bg-resync + level-context-resync). Without
    // this, effects are cleared/rebuilt multiple times in quick succession and
    // can briefly flash wrong-floor overlays before final visibility settles.
    if (this._populatePromise && !this._populateComplete) {
      log.info(`FloorCompositor: forceRepopulate coalesced into in-flight populate (source=${source})`);
      return this._populatePromise;
    }

    const nowMs = Date.now();
    const sceneId = canvas?.scene?.id ? String(canvas.scene.id) : null;
    // V14 cold-load bg resync intentionally fires swap+forceRepopulate on several
    // timers (0/150/750/2500ms + rAF). The 900ms same-scene throttle below would
    // let the *first* populate finish (sometimes with wrong canvas.level / texture
    // stack after non-MSA → MSA) and then turn every later resync into a no-op
    // because _ensureBusPopulated returns immediately when _populateComplete is
    // true — leaving the grey FloorRenderBus plane until a full Foundry refresh.
    const bypassDuplicateThrottle = String(source || '').includes('cold-load-bg-resync');
    const sameScene = !!sceneId && sceneId === this._lastForceRepopulateSceneId;
    const elapsedMs = nowMs - Number(this._lastForceRepopulateAtMs || 0);
    if (!bypassDuplicateThrottle && sameScene && elapsedMs >= 0 && elapsedMs < 900) {
      log.info(
        `FloorCompositor: skipping duplicate forceRepopulate (source=${source}, previous=${this._lastForceRepopulateSource || 'unknown'}, elapsedMs=${elapsedMs})`
      );
      return this._ensureBusPopulated({ source: `${source}:coalesced` });
    }

    this._lastForceRepopulateAtMs = nowMs;
    this._lastForceRepopulateSceneId = sceneId;
    this._lastForceRepopulateSource = String(source);

    // Prevent stale canopy overlays from rendering while the async populate
    // queue is replaying. Tree/Bush populate jobs run later in the queue, so
    // without this early clear old-floor overlays can flash for a few frames
    // during floor/level transitions.
    try { this._treeEffect?.clear?.(); } catch (_) {}
    try { this._bushEffect?.clear?.(); } catch (_) {}

    this._populateComplete = false;
    this._populatePromise = null;
    this._busPopulated = false;
    return this._ensureBusPopulated({ source });
  }

  /**
   * While the async populate IIFE is in flight, skip heavy per-frame effect
   * updates and the full post chain so `setTimeout(0)` yields are not filled
   * by concurrent shader work.
   *
   * @returns {boolean}
   * @private
   */
  _populateSlimRenderActive() {
    return !!this._populatePromise && !this._populateComplete;
  }

  /**
   * Build a snapshot of the render inputs this frame depends on. Used by the
   * strict-sync dependency gate to decide whether the current frame has all
   * the data required to produce a correct image. When the gate rejects a
   * frame, the RenderLoop holds the previously-rendered output on screen.
   *
   * @returns {{valid:boolean, reason:string|null, details:object}}
   * @private
   */
  _validateFrameInputs() {
    const out = this._frameValidation;
    // Fast clear of details
    for (const k in out.details) delete out.details[k];
    out.valid = false;

    if (!this._initialized) {
      out.reason = 'compositor-not-initialized';
      return out;
    }

    if (!this._renderBus || !this._renderBus._scene) {
      out.details.hasBus = !!this._renderBus;
      out.reason = 'render-bus-not-ready';
      return out;
    }

    if (!this._populateComplete && !this._populateSlimRenderActive()) {
      out.details.populateComplete = this._populateComplete;
      return out;
    }

    let floors = [];
    let activeFloor = null;
    try {
      const floorStack = window.MapShine?.floorStack;
      floors = floorStack?.getFloors?.() ?? [];
      activeFloor = floorStack?.getActiveFloor?.() ?? null;
    } catch (_) {}

    if (floors.length > 1 && !activeFloor) {
      out.details.floorCount = floors.length;
      out.reason = 'no-active-floor-multi-floor';
      return out;
    }

    if (!this._neutralOutdoorsTexture && !this._lastOutdoorsTexture) {
      out.details.hasLastOutdoors = !!this._lastOutdoorsTexture;
    }

    if (this._isMaskBindingControllerEnabled()) {
      try {
        const controller = this._getMaskBindingController();
        const ready = controller.isReadyForFrame();
        if (!ready.valid) {
          out.details.maskBinding = { activeIndex: ready.activeIndex, missing: ready.missing };
          out.reason = `mask-binding:${ready.reason}`;
          return out;
        }
      } catch (err) {
        out.details.maskBindingError = String(err?.message ?? err);
      }
    }

    out.valid = true;
    out.reason = null;
    return out;
  }

  /**
   * Write the strict-sync hold flag consumed by the RenderLoop. Called when
   * the dependency gate rejects a frame so the next rAF can skip the
   * compositor render entirely and keep the last valid frame on screen.
   *
   * @param {boolean} active
   * @param {string|null} reason
   * @private
   */
  _setStrictHoldFlag(active, reason = null) {
    try {
      if (!window?.MapShine) return;
      const prev = window.MapShine.renderStrictHoldFrame;
      if (active === true) {
        window.MapShine.renderStrictHoldFrame = {
          active: true,
          reason: reason || 'unspecified',
          updatedAtMs: performance.now(),
        };
      } else if (prev?.active === true) {
        window.MapShine.renderStrictHoldFrame = {
          active: false,
          reason: null,
          updatedAtMs: performance.now(),
        };
      }
    } catch (_) {}
  }

  /**
   * Resize + render the replica occlusion mask RT before bus materials sample it.
   *
   * @private
   */
  _prepareBusOcclusionMaskBeforeBus() {
    const pass = this._replicaOcclusionMaskPass;
    if (!pass || typeof pass.setBusRenderTargetSize !== 'function') return;
    const rt = this._sceneRT;
    if (rt?.width > 0 && rt?.height > 0) {
      pass.setBusRenderTargetSize(rt.width, rt.height);
    } else if (this.renderer && typeof this.renderer.getDrawingBufferSize === 'function') {
      const THREE = window.THREE;
      if (!this._sizeVec) this._sizeVec = new THREE.Vector2();
      this.renderer.getDrawingBufferSize(this._sizeVec);
      pass.setBusRenderTargetSize(this._sizeVec.x, this._sizeVec.y);
    }
    try {
      pass.update(this.renderer, this.camera);
    } catch (_) {}
  }

  /**
   * Bus albedo + screen blit only (no lighting / water / bloom). All log lines
   * include POPULATE for filtering.
   *
   * @private
   */
  _runPopulateSlimRenderFrame() {
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    if (!this._populateSlimRenderLogNextAt || now >= this._populateSlimRenderLogNextAt) {
      this._populateSlimRenderLogNextAt = now + 2500;
      log.warn(
        `[POPULATE RENDER-SLIM] skipping full effect updates + post chain until populate completes | busPopulated=${this._busPopulated}`,
      );
    }
    try {
      this._prepareBusOcclusionMaskBeforeBus();
      this._renderBus?.syncRuntimeTileState?.(this._replicaOcclusionMaskPass);
    } catch (err) {
      log.warn('[POPULATE RENDER-SLIM] syncRuntimeTileState threw:', err);
    }
    const activeFloorIndex = Number.isFinite(this._renderBus?._visibleMaxFloorIndex)
      ? this._renderBus._visibleMaxFloorIndex
      : 0;
    const blurEnabled = this._floorDepthBlurEffect?.params?.enabled && activeFloorIndex > 0;
    try {
      if (blurEnabled) {
        this._floorDepthBlurEffect.render(
          this.renderer, this.camera, this._renderBus, activeFloorIndex, this._sceneRT);
      } else {
        this._renderBus.renderTo(this.renderer, this.camera, this._sceneRT);
      }
    } catch (err) {
      log.warn('[POPULATE RENDER-SLIM] bus render threw:', err);
    }
    this._blitToScreen(this._sceneRT);
    try {
      this._renderLateWorldOverlay();
    } catch (err) {
      log.warn('[POPULATE RENDER-SLIM] late overlay threw:', err);
    }
    try {
      this._renderPixiUiOverlay();
    } catch (err) {
      log.warn('[POPULATE RENDER-SLIM] PIXI UI overlay threw:', err);
    }
  }

  /**
   * Resolve scene geometry for mask overlays (populate snapshot or canvas fallback).
   * @returns {object}
   * @private
   */
  _resolveFoundrySceneDataSnapshot() {
    const fd = this._lastFoundrySceneData ?? window.MapShine?.sceneComposer?.foundrySceneData ?? null;
    if (fd && typeof fd === 'object') return fd;
    const d = typeof canvas !== 'undefined' ? canvas?.dimensions : null;
    const h = Number(d?.height) || 0;
    const w = Number(d?.width) || 0;
    return {
      height: h,
      width: w,
      sceneWidth: w,
      sceneHeight: h,
      sceneX: 0,
      sceneY: 0,
    };
  }

  /**
   * When a tile's `texture.src` changes after initial V2 populate, re-probe companion
   * masks and rebuild per-tile overlays (specular, fluid, iridescence, prism, bush, tree)
   * and re-merge fire particles (full FireEffectV2 repopulate per floor batch).
   *
   * @param {object} tileDoc - Updated Foundry TileDocument
   */
  notifyTileTextureChanged(tileDoc) {
    if (!tileDoc) return;
    const id = tileDoc.id ?? tileDoc._id;
    if (!id) return;
    const fd = this._resolveFoundrySceneDataSnapshot();
    const p = this._refreshV2SurfaceEffectsForTile(tileDoc, fd);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  /**
   * @param {object} tileDoc
   * @param {object} foundrySceneData
   * @returns {Promise<void>}
   * @private
   */
  async _refreshV2SurfaceEffectsForTile(tileDoc, foundrySceneData) {
    const effects = [
      this._specularEffect,
      this._fluidEffect,
      this._iridescenceEffect,
      this._prismEffect,
      this._bushEffect,
      this._treeEffect,
      this._fireEffect,
    ];
    const tasks = [];
    for (const e of effects) {
      if (e && typeof e.refreshTileAfterTextureChange === 'function') {
        tasks.push(e.refreshTileAfterTextureChange(tileDoc, foundrySceneData));
      }
    }
    if (!tasks.length) return;
    await Promise.allSettled(tasks);
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
    const { awaitPopulate = false } = options;
    const populatePromise = this._ensureBusPopulated({ source: 'loading' });
    if (!awaitPopulate) {
      return true;
    }
    return await populatePromise;
  }

  /**
   * Structured snapshot for populate / load troubleshooting (safe, no throws).
   *
   * @param {object} [opts]
   * @param {string} [opts.source]
   * @param {object|null} [opts.sceneComposer]
   * @param {string} [opts.phase]
   * @param {string|null} [opts.effectLabel]
   * @param {number|null} [opts.jobIndex] 1-based
   * @param {number|null} [opts.jobTotal]
   * @returns {object}
   * @private
   */
  _gatherPopulateDiagnostics(opts = {}) {
    const {
      source = 'unknown',
      sceneComposer = null,
      phase = 'snapshot',
      effectLabel = null,
      jobIndex = null,
      jobTotal = null,
    } = opts;

    const scene = typeof canvas !== 'undefined' ? canvas?.scene : null;
    const tiles = scene?.tiles?.contents ?? [];
    const fd = sceneComposer?.foundrySceneData ?? null;
    const floorStack = window.MapShine?.floorStack;
    const floorsList = floorStack?.getFloors?.() ?? [];
    const busScene = this._renderBus?._scene;

    let busChildCount = null;
    try {
      busChildCount = busScene?.children?.length ?? null;
    } catch (_) {
      busChildCount = null;
    }

    const fdSummary = fd && typeof fd === 'object'
      ? {
        width: fd.width,
        height: fd.height,
        sceneWidth: fd.sceneWidth,
        sceneHeight: fd.sceneHeight,
        sceneX: fd.sceneX,
        sceneY: fd.sceneY,
        keyCount: Object.keys(fd).length,
      }
      : null;

    let mem = null;
    try {
      if (typeof performance !== 'undefined' && performance.memory) {
        mem = {
          usedJSHeapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
          totalJSHeapMB: Math.round(performance.memory.totalJSHeapSize / 1048576),
          limitJSHeapMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
        };
      }
    } catch (_) {}

    const vis = typeof document !== 'undefined' ? document.visibilityState : null;

    return {
      phase,
      source,
      effectLabel,
      jobProgress:
        jobIndex != null && jobTotal != null ? `${jobIndex}/${jobTotal}` : null,
      flags: {
        populateComplete: this._populateComplete,
        busPopulated: this._busPopulated,
        hasInFlightPopulatePromise: !!this._populatePromise,
        initialized: this._initialized,
      },
      effectHints: this._effectHints ?? null,
      foundry: {
        gameReady: typeof game !== 'undefined' ? !!game?.ready : null,
        canvasReady: typeof canvas !== 'undefined' ? !!canvas?.ready : null,
        sceneId: scene?.id ?? null,
        sceneName: scene?.name ?? null,
        tileDocCount: Array.isArray(tiles) ? tiles.length : null,
        hasBackgroundSrc: !!(canvas?.scene?.background?.src),
      },
      floors: {
        count: floorsList.length,
        activeLevelBottom: window.MapShine?.activeLevelContext?.bottom,
        activeLevelTop: window.MapShine?.activeLevelContext?.top,
      },
      foundrySceneDataSummary: fdSummary,
      busSceneSummary: {
        hasBusScene: !!busScene,
        directChildCount: busChildCount,
      },
      renderer: {
        hasRenderer: !!this.renderer,
        hasCompileAsync: !!(this.renderer && typeof this.renderer.compileAsync === 'function'),
      },
      host: {
        visibilityState: vis,
        memory: mem,
      },
    };
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
      const populateWallStart = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      const sincePopulateStart = () => {
        const now = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();
        return now - populateWallStart;
      };

      const sc = window.MapShine?.sceneComposer ?? null;
      if (!sc) {
        log.warn(
          `FloorCompositor: no sceneComposer available for populate (source=${source})`,
          this._gatherPopulateDiagnostics({
            source,
            sceneComposer: null,
            phase: 'missing-sceneComposer',
          }),
        );
        return false;
      }

      this._lastFoundrySceneData = sc.foundrySceneData ?? null;

      log.warn(
        `[POPULATE LOAD] begin (source=${source})`,
        this._gatherPopulateDiagnostics({
          source,
          sceneComposer: sc,
          phase: 'begin',
        }),
      );

      if (!this._busPopulated) {
        const tBus0 = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();
        this._renderBus.populate(sc);
        this._busPopulated = true;
        const tBus1 = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();
        log.warn(
          `[POPULATE TIMELINE] FloorRenderBus.populate() finished (sync) | busPopulateMs=${(tBus1 - tBus0).toFixed(0)} | sincePopulateStartMs=${sincePopulateStart().toFixed(0)} | source=${source}`,
        );
        await yieldToMain();
      } else {
        log.warn(
          `[POPULATE TIMELINE] FloorRenderBus already populated (skipped) | sincePopulateStartMs=${sincePopulateStart().toFixed(0)} | source=${source}`,
        );
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
      await yieldToMain();

      const hintPruneMasks = this._effectHintsDrivePopulateMaskPruning();
      const maskJobDefs = [
        ['SpecularEffectV2', '_specularEffect', () => this._specularEffect.populate(sc.foundrySceneData)],
        ['FluidEffectV2', '_fluidEffect', () => this._fluidEffect.populate(sc.foundrySceneData)],
        ['IridescenceEffectV2', '_iridescenceEffect', () => this._iridescenceEffect.populate(sc.foundrySceneData)],
        ['PrismEffectV2', '_prismEffect', () => this._prismEffect.populate(sc.foundrySceneData)],
        ['BushEffectV2', '_bushEffect', () => this._bushEffect.populate(sc.foundrySceneData)],
        ['TreeEffectV2', '_treeEffect', () => this._treeEffect.populate(sc.foundrySceneData)],
        ['FireEffectV2', '_fireEffect', () => this._fireEffect.populate(sc.foundrySceneData)],
        ['AshDisturbanceEffectV2', '_ashDisturbanceEffect', () => this._ashDisturbanceEffect.populate(sc.foundrySceneData)],
        ['DustEffectV2', '_dustEffect', () => this._dustEffect.populate(sc.foundrySceneData)],
        ['WindowLightEffectV2', '_windowLightEffect', () => this._windowLightEffect.populate(sc.foundrySceneData)],
      ];

      const populateJobs = [];
      for (const row of maskJobDefs) {
        const [label, effectKey, fn] = row;
        if (!hintPruneMasks || this._shouldWarmupEffectKey(effectKey)) {
          populateJobs.push([label, fn]);
        }
      }
      // Water / splashes must always run populate when present: `_shouldWarmupEffectKey`
      // uses `hasRenderableWater()`, which is only true *after* populate — gating here
      // would skip discovery entirely (water never appears, no error).
      if (this._waterEffect) {
        populateJobs.push(['WaterEffectV2', () => this._waterEffect.populate(sc.foundrySceneData)]);
      }
      if (this._waterSplashesEffect) {
        populateJobs.push(['WaterSplashesEffectV2', () => this._waterSplashesEffect.populate(sc.foundrySceneData)]);
      }
      log.warn(
        `[POPULATE LOAD] effect queue ready | source=${source} | jobs=${populateJobs.length} | maskHintPruneActive=${hintPruneMasks} | perJobTimeoutMs=${POPULATE_JOB_TIMEOUT_MS}`,
        this._gatherPopulateDiagnostics({
          source,
          sceneComposer: sc,
          phase: 'before-effect-queue',
        }),
      );

      let lastPopulateJobFnSettledMs = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();

      for (let idx = 0; idx < populateJobs.length; idx++) {
        const [label, fn] = populateJobs[idx];
        const jobIndex = idx + 1;
        const jobTotal = populateJobs.length;
        if (idx > 0) {
          const tGap0 = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
          const gapSincePrevJobSettledMs = tGap0 - lastPopulateJobFnSettledMs;
          log.warn(
            `[POPULATE INTER-JOB] gap since previous populate() settled | beforeJob=(${jobIndex}/${jobTotal}) ${label} | gapMs=${gapSincePrevJobSettledMs.toFixed(0)} | sincePopulateStartMs=${sincePopulateStart().toFixed(0)} | source=${source} | note=includes_applyFloorVisibility_setTimeout0_and_other_main_thread_work`,
          );
        }
        const startMs = performance?.now?.() ?? Date.now();
        log.warn(
          `[POPULATE TIMELINE] START job (${jobIndex}/${jobTotal}) ${label} | sincePopulateStartMs=${sincePopulateStart().toFixed(0)} | perJobTimeoutMs=${POPULATE_JOB_TIMEOUT_MS} | source=${source} | queuePosition=${jobIndex === jobTotal ? 'LAST' : `${jobIndex} of ${jobTotal}`}`,
        );
        log.warn(
          `[POPULATE START] (${jobIndex}/${jobTotal}) ${label} | source=${source} | perJobTimeoutMs=${POPULATE_JOB_TIMEOUT_MS}`,
          this._gatherPopulateDiagnostics({
            source,
            sceneComposer: sc,
            phase: 'job-start',
            effectLabel: label,
            jobIndex,
            jobTotal,
          }),
        );
        try {
          await Promise.race([
            fn(),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('TIMEOUT')), POPULATE_JOB_TIMEOUT_MS);
            }),
          ]);
          const elapsed = (performance?.now?.() ?? Date.now()) - startMs;
          log.warn(
            `[POPULATE TIMELINE] DONE job (${jobIndex}/${jobTotal}) ${label} | jobDurationMs=${elapsed.toFixed(0)} | sincePopulateStartMs=${sincePopulateStart().toFixed(0)} | source=${source}`,
          );
          log.warn(
            `[POPULATE DONE] (${jobIndex}/${jobTotal}) ${label} in ${elapsed.toFixed(0)}ms | source=${source}`,
          );
        } catch (err) {
          const elapsed = (performance?.now?.() ?? Date.now()) - startMs;
          const isTimeout = err?.message === 'TIMEOUT';
          const timerSkewMs = elapsed - POPULATE_JOB_TIMEOUT_MS;
          const mainThreadLikelyBlocked = isTimeout && timerSkewMs > 1500;
          const timerRoughlyOnTime = isTimeout && Math.abs(timerSkewMs) <= 2000;
          const specularHint = (isTimeout && label === 'SpecularEffectV2')
            ? 'SpecularEffectV2.populate() runs sequential await probeMaskFile() for the background and every tile; stalled fetches or an enormous tile count can keep this step alive until timeout.'
            : null;
          const ashHint = (isTimeout && label === 'AshDisturbanceEffectV2')
            ? 'This timeout only proves AshDisturbanceEffectV2.populate() did not resolve before the per-job wall clock. Check [POPULATE] lines from AshDisturbanceEffectV2 for the last phase logged; long sync work (mask scan / Quarks rebuild) can fill the whole budget. Earlier jobs already completed — root cause may still be cumulative load or this effect’s CPU-heavy paths.'
            : null;
          const correlationNote =
            'Per-job TIMEOUT marks which populate() Promise.race lost — not definitive proof that effect is solely responsible; compare [POPULATE TIMELINE] DONE lines for jobs 1..N-1 and cumulative sincePopulateStartMs.';
          const diagnostics = this._gatherPopulateDiagnostics({
            source,
            sceneComposer: sc,
            phase: isTimeout ? 'populate-timeout' : 'populate-failed',
            effectLabel: label,
            jobIndex,
            jobTotal,
          });
          log.error(
            `[POPULATE ${isTimeout ? 'TIMEOUT' : 'FAILED'}] (${jobIndex}/${jobTotal}) ${label} | source=${source} | elapsedMs=${elapsed.toFixed(0)} | configuredTimeoutMs=${POPULATE_JOB_TIMEOUT_MS}` +
            (mainThreadLikelyBlocked
              ? ` | timerFiredLateByApproxMs=${timerSkewMs.toFixed(0)} (main thread may have been blocked — timeout callbacks only run when the event loop is free)`
              : (timerRoughlyOnTime && isTimeout
                ? ` | timerRoughlyOnSchedule=true (this job ran ~full ${POPULATE_JOB_TIMEOUT_MS}ms wall — likely long async chain or heavy sync sections inside this effect)`
                : '')),
            {
              err,
              diagnostics,
              interpretation: correlationNote,
              ...(specularHint ? { likelyCauseHint: specularHint } : {}),
              ...(ashHint ? { likelyCauseHintAsh: ashHint } : {}),
            },
          );
          if (err?.stack) {
            log.error(`[POPULATE ${isTimeout ? 'TIMEOUT' : 'FAILED'}] ${label} stack:`, err.stack);
          }
        }
        lastPopulateJobFnSettledMs = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();
        try { this._applyCurrentFloorVisibility(); } catch (_) {}
        // Give the browser/event loop a chance to process socket + UI work
        // between heavy floor/effect populate steps.
        await yieldToMain();
      }

      log.warn(
        `[POPULATE LOAD] all effect jobs finished (success or caught errors) | source=${source} | totalPopulateWallMs=${sincePopulateStart().toFixed(0)}`,
        this._gatherPopulateDiagnostics({
          source,
          sceneComposer: sc,
          phase: 'after-effect-queue',
        }),
      );

      // Initial attempt; render-time guard above re-attempts when globals land.
      this._wireMapPointConsumers();
      // Push current outdoors mask immediately; async compositor cache warmup
      // can still update this later via the per-frame sync below.
      this._syncOutdoorsMaskConsumers({
        context: window.MapShine?.activeLevelContext ?? null,
        force: true,
      });

      this._populateComplete = true;
      // Ensure at least one fresh frame after async populate finishes.
      // Without this, first-load occlusion/shadow masks can remain stale until a
      // user camera interaction (pan/zoom) triggers another compositor render.
      try {
        const ms = window.MapShine;
        ms?.cameraFollower?.forceSync?.();
        ms?.unifiedCamera?.syncFromPixi?.('populate-complete');
        ms?.renderLoop?.requestRender?.();
        ms?.renderLoop?.requestContinuousRender?.(180);
      } catch (_) {}
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
  /**
   * V14 refactor: level-mutating prewarm removed.
   *
   * Previously cycled floor visibility across all bands to touch floor-scoped
   * systems. This mutated the viewed level and could desync the bus state on
   * cold load (see V14-COLD-LOAD-LEVEL-RENDER-POSTMORTEM). Shader warmup now
   * runs via warmupAsync() which compiles all materials without changing floor
   * visibility state.
   */
  _prewarmFloorVisibilityPasses() {
    // Intentional no-op — callers preserved for compatibility but
    // the level-mutating behavior is removed per V14 refactor.
    log.info('_prewarmFloorVisibilityPasses: skipped (V14 refactor — non-destructive warmup only)');
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
    const canWarmup = this.renderer && typeof this.renderer.compile === 'function';
    if (!canWarmup) {
      log.warn('warmupAsync: renderer has no compile()');
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
      '_underwaterBubblesEffect', '_smellyFliesEffect',
      '_lightningEffect', '_candleFlamesEffect', '_playerLightEffect',
      '_overheadShadowEffect', '_buildingShadowEffect', '_skyReachShadowEffect', '_dotScreenEffect',
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

      const getPrograms = () => (this.renderer.info?.programs ?? []).filter(Boolean);
      const deadline = Date.now() + timeoutMs;

      // One compile target at a time so the event loop can run heartbeats between
      // submissions. Use sync compile() only: WebGLRenderer.compileAsync() can throw
      // from an internal setTimeout when materialProperties.currentProgram is still
      // undefined for a tracked material (uncaught — try/catch around await does not
      // receive it). We already poll KHR_parallel_shader_compile readiness below.
      const compileOneTarget = async (target) => {
        const { scene, camera, label } = target;
        try {
          if (typeof this.renderer.compile === 'function') {
            await yieldToMain();
            this.renderer.compile(scene, camera);
            await yieldToMain();
          }
        } catch (err) {
          log.warn(`warmupAsync: compile threw for target ${label}`, err);
        }
      };

      let compileAttempts = 0;
      for (const target of targets) {
        if (Date.now() >= deadline) break;
        enableAllLayers(target.camera);
        compileAttempts++;
        await compileOneTarget(target);
        await yieldToMain();
      }

      if (compileAttempts === 0) {
        log.warn('warmupAsync: no valid compile targets');
        return false;
      }

      const totalAtSubmit = getPrograms().length;
      log.info(`warmupAsync: ${totalAtSubmit} programs submitted`);

      // Poll KHR_parallel_shader_compile readiness at ~30fps until done or timeout.
      _pollingActive = true;
      while (_pollingActive && Date.now() < deadline) {
        const progs = getPrograms();
        const total = Math.max(progs.length, totalAtSubmit, 1);
        let ready = 0;
        for (const p of progs) {
          if (!p) continue;
          try { if (typeof p.isReady === 'function' ? p.isReady() : true) ready++; } catch (_) { ready++; }
        }
        if (onProgress) {
          try { onProgress(Math.min(ready / total, 1.0), `Shaders: ${ready}/${total}`); } catch (_) {}
        }
        if (ready >= total) break;
        await new Promise(r => setTimeout(r, 32));
      }
      _pollingActive = false;

      if (Date.now() >= deadline) {
        log.warn(`warmupAsync: shader compilation timed out after ${timeoutMs}ms, proceeding with lazy compilation`);
        // Report final achieved progress on timeout.
        if (onProgress) {
          const progs = getPrograms();
          const total = Math.max(progs.length, 1);
          let ready = 0;
          for (const p of progs) {
            if (!p) continue;
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
   * Build previous-frame dynamic-light payload for source shadow overrides.
   * Uses LightingEffectV2 previous-frame textures: Foundry lights (`_lightRT`)
   * and window glow (`_windowLightRT`) so {@link WindowLightEffectV2} lift matches
   * gameplay lights in source shadow passes.
   * @returns {{texture:any, windowTexture:any, strength:number, enabled:boolean, viewBounds:{x:number,y:number,z:number,w:number}, sceneDimensions:{x:number,y:number}, sceneRect:{x:number,y:number,z:number,w:number}}|null}
   */
  _buildDynamicLightOverridePayload() {
    const le = this._lightingEffect;
    const tex = le?.dynamicLightTexture ?? null;
    const winTex = le?.windowLightTexture ?? null;
    if (!tex && !winTex) return null;

    const dims = globalThis.canvas?.dimensions;
    if (!dims) return null;

    const rect = dims.sceneRect ?? dims;
    const out = this._dynamicLightOverride;

    out.texture = tex;
    out.windowTexture = winTex;
    out.strength = Number(le?.params?.dynamicLightShadowOverrideStrength ?? 0.7);

    out.sceneRect.x = Number(rect?.x ?? dims.sceneX ?? 0);
    out.sceneRect.y = Number(rect?.y ?? dims.sceneY ?? 0);
    out.sceneRect.z = Number(rect?.width ?? dims.sceneWidth ?? dims.width ?? 1);
    out.sceneRect.w = Number(rect?.height ?? dims.sceneHeight ?? dims.height ?? 1);

    out.sceneDimensions.x = Number(dims.width ?? 1);
    out.sceneDimensions.y = Number(dims.height ?? 1);

    try {
      const cam = this.camera ?? null;
      const THREE = window.THREE;
      if (cam?.isOrthographicCamera) {
        const zoom = Math.max(0.001, cam.zoom ?? 1.0);
        out.viewBounds.x = Number(cam.position.x + cam.left / zoom);
        out.viewBounds.y = Number(cam.position.y + cam.bottom / zoom);
        out.viewBounds.z = Number(cam.position.x + cam.right / zoom);
        out.viewBounds.w = Number(cam.position.y + cam.top / zoom);
      } else if (cam?.isPerspectiveCamera && THREE) {
        // Safe instantiation for caches if missing
        if (!this._tempVec3_1) {
           this._tempVec3_1 = new THREE.Vector3();
           this._tempVec3_2 = new THREE.Vector3();
           this._tempVec3_3 = new THREE.Vector3();
        }
        const groundZ = Number(window.MapShine?.sceneComposer?.groundZ ?? 0);
        const ndc = this._tempVec3_1;
        const world = this._tempVec3_2;
        const dir = this._tempVec3_3;

        let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
        const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

        for (let i = 0; i < 4; i++) {
          ndc.set(corners[i][0], corners[i][1], 0.5);
          world.copy(ndc).unproject(cam);
          dir.copy(world).sub(cam.position);

          if (Math.abs(dir.z) < 1e-6) continue;
          const t = (groundZ - cam.position.z) / dir.z;
          if (!Number.isFinite(t) || t <= 0) continue;

          const ix = cam.position.x + dir.x * t;
          const iy = cam.position.y + dir.y * t;
          if (ix < minX) minX = ix;
          if (iy < minY) minY = iy;
          if (ix > maxX) maxX = ix;
          if (iy > maxY) maxY = iy;
        }
        if (minX !== Infinity) {
          out.viewBounds.x = minX; out.viewBounds.y = minY;
          out.viewBounds.z = maxX; out.viewBounds.w = maxY;
        }
      }
    } catch (_) {}

    return out;
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
    const paintedTex = (this._paintedShadowEffect?.params?.enabled)
      ? (this._paintedShadowEffect.shadowFactorTexture ?? null)
      : null;
    const skyReachTex = (this._skyReachShadowEffect?.params?.enabled)
      ? (this._skyReachShadowEffect.shadowFactorTexture ?? null)
      : null;
    sm.setInputs({
      cloudShadowTexture: cloudTex ?? null,
      cloudShadowRawTexture: cloudRawTex ?? null,
      overheadShadowTexture: overheadTex,
      buildingShadowTexture: buildingTex,
      paintedShadowTexture: paintedTex,
      skyReachShadowTexture: skyReachTex,
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
      sm.applyBuildingShadowUvRemap?.(this.camera);
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
      this._ensureDefaultFramebuffer();
      return;
    }

    // Strict-sync dependency gate. When enabled, we validate frame inputs up
    // front and hold the previous image if any critical dependency is missing.
    // This is the fool-proof path: we prefer a temporary pause over rendering
    // with stale/partial state.
    const strictSyncEnabled = (() => {
      try { return window?.MapShine?.renderStrictSyncEnabled === true; } catch (_) { return false; }
    })();
    if (strictSyncEnabled) {
      const validation = this._validateFrameInputs();
      if (!validation.valid) {
        this._strictFrameHoldCount++;
        this._strictLastHoldReason = validation.reason;
        this._strictLastHoldAtMs = performance.now();
        this._setStrictHoldFlag(true, validation.reason);
        try {
          if (window?.MapShine) {
            window.MapShine.__v2StrictHoldInfo = {
              count: this._strictFrameHoldCount,
              reason: validation.reason,
              details: validation.details,
              atMs: this._strictLastHoldAtMs,
            };
          }
        } catch (_) {}
        this._ensureDefaultFramebuffer();
        return;
      }
      // Clear any stale hold flag so subsequent rAFs proceed normally.
      this._setStrictHoldFlag(false);
    }

    // Recompute the scene-rect scissor AABB for this frame. All
    // subsequent per-level / post-chain GL work runs inside
    // `withSceneScissor(...)` so the GPU never rasterizes fragments
    // outside the inner sceneRect (padded zone + outer black region).
    // Cheap to call every frame: short-circuits when camera + sceneRect
    // + drawing-buffer-size hash is unchanged.
    try {
      getSceneRectScissor().update(this.renderer, this.camera);
    } catch (err) {
      log.warn('FloorCompositor: SceneRectScissor.update failed:', err);
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

    // FloorCompositor._activeFloorIndex is normally advanced from
    // _applyCurrentFloorVisibility(); some level transitions update FloorStack /
    // compositor bands first (hooks, Levels navigation). When that snapshot
    // drifts, outdoors sync's signature may match stale state and skip
    // setOutdoorsMask(...) — consumers keep the wrong band until another
    // unrelated signature change.
    try {
      const fsAf = floorStack?.getActiveFloor?.() ?? null;
      const stackIdx = Number.isFinite(Number(fsAf?.index)) ? Number(fsAf.index) : null;
      const prevIdx = this._activeFloorIndex;
      if (stackIdx !== null && stackIdx !== (prevIdx ?? Number.NaN)) {
        this._activeFloorIndex = stackIdx;
        this._lastOutdoorsSignature = null;
        window.MapShine?.sceneComposer?._sceneMaskCompositor?.syncActiveFloorFromFloorStack?.();
      }
    } catch (_) {}

    // Outdoors mask consumer sync runs every frame now. The internal binding
    // signature short-circuits when nothing has changed, so this is cheap
    // (string compare + quick lookups). Running unconditionally catches async
    // mask promotion (e.g. an upper-floor _Outdoors texture becoming available
    // mid-session) without requiring narrow gate conditions.
    try {
      const _ctx = window.MapShine?.activeLevelContext ?? null;
      this._syncOutdoorsMaskConsumers({ context: _ctx });
    } catch (_) {}

    // Unified per-floor mask fan-out. Behind the rollout flag so migration
    // proceeds effect-by-effect; the controller short-circuits on signature
    // match and is cheap to invoke every frame. When disabled, this is a
    // no-op and the legacy outdoors path above owns all mask distribution.
    try {
      if (this._isMaskBindingControllerEnabled()) {
        this._getMaskBindingController().sync({
          activeFloorIndex: this._activeFloorIndex ?? 0,
        });
      }
    } catch (err) {
      log.warn('FloorCompositor: mask-binding-controller.sync failed:', err);
    }

    const populateSlimRender = this._populateSlimRenderActive();
    try {
      if (window.MapShine) {
        window.MapShine.__v2CompositorRenderPath = populateSlimRender ? 'populate-slim' : 'full';
        window.MapShine.__v2PopulateComplete = !!this._populateComplete;
        if (window.MapShine.__v2FrameTraceEnabled === true) {
          const ctx = window.MapShine?.activeLevelContext ?? null;
          const trace = {
            frame: Number(timeInfo?.frameCount ?? -1),
            renderPath: populateSlimRender ? 'populate-slim' : 'full',
            populateComplete: !!this._populateComplete,
            shaderGateOpen: !!this._shaderWarmupGateOpen,
            activeLevel: {
              index: Number.isFinite(Number(ctx?.index)) ? Number(ctx.index) : null,
              bottom: Number.isFinite(Number(ctx?.bottom)) ? Number(ctx.bottom) : null,
              top: Number.isFinite(Number(ctx?.top)) ? Number(ctx.top) : null,
            },
          };
          if (!Array.isArray(window.MapShine.__v2FrameTrace)) window.MapShine.__v2FrameTrace = [];
          window.MapShine.__v2FrameTrace.push(trace);
          if (window.MapShine.__v2FrameTrace.length > 32) window.MapShine.__v2FrameTrace.shift();
          if ((window.MapShine.__v2FrameTrace?.length ?? 0) <= 8) {
            try { log.warn('[V2 FrameTrace]', trace); } catch (_) {}
          }
        }
      }
    } catch (_) {}

    // ── Update effects (time-varying uniforms) ───────────────────────────
    // Freeze delta to 0 while the shader warmup gate is closed. This prevents
    // particles, wind, and waves from accumulating time during the warmup window
    // so all systems start cleanly from t=0 when the scene first becomes visible.
    if (!populateSlimRender && !this._shaderWarmupGateOpen && timeInfo) {
      timeInfo = { ...timeInfo, delta: 0 };
    }
    if (!populateSlimRender && timeInfo) {
      // Wind must advance before update() so accumulation is 1× per frame.
      this._profileEffectCall('cloud', 'update', () => this._cloudEffect.advanceWind(timeInfo.delta ?? 0.016), 'CloudEffectV2 advanceWind');
      this._profileEffectCall('specular', 'update', () => this._specularEffect.update(timeInfo), 'SpecularEffectV2 update');
      this._profileEffectCall('fluid', 'update', () => this._fluidEffect.update(timeInfo), 'FluidEffectV2 update');
      this._profileEffectCall('iridescence', 'update', () => this._iridescenceEffect.update(timeInfo), 'IridescenceEffectV2 update');
      this._profileEffectCall('prism', 'update', () => this._prismEffect.update(timeInfo), 'PrismEffectV2 update');
      this._profileEffectCall('bush', 'update', () => this._bushEffect.update(timeInfo), 'BushEffectV2 update');
      this._profileEffectCall('tree', 'update', () => this._treeEffect.update(timeInfo), 'TreeEffectV2 update');
      this._profileEffectCall('fire', 'update', () => this._fireEffect.update(timeInfo), 'FireEffectV2 update');
      this._profileEffectCall('ashDisturbance', 'update', () => this._ashDisturbanceEffect?.update?.(timeInfo), 'AshDisturbanceEffectV2 update');
      this._profileEffectCall('dust', 'update', () => this._dustEffect.update(timeInfo), 'DustEffectV2 update');
      this._profileEffectCall('waterSplashes', 'update', () => this._waterSplashesEffect?.update?.(timeInfo), 'WaterSplashesEffectV2 update');
      this._profileEffectCall('smellyFlies', 'update', () => this._smellyFliesEffect?.update?.(timeInfo), 'SmellyFliesEffect update');
      this._profileEffectCall('lightning', 'update', () => {
        this._lightningEffect?.ensureMeshesAttached?.(this._renderBus?._scene ?? null);
        this._lightningEffect?.update?.(timeInfo);
      }, 'LightningEffectV2 update');
      this._profileEffectCall('candleFlames', 'update', () => {
        this._candleFlamesEffect?.ensureMeshesAttached?.(this._renderBus?._scene ?? null);
        this._candleFlamesEffect?.update?.(timeInfo);
      }, 'CandleFlamesEffectV2 update');
      this._profileEffectCall('playerLight', 'update', () => this._playerLightEffect?.update?.(timeInfo), 'PlayerLightEffectV2 update');
      this._profileEffectCall('cloud', 'update', () => this._cloudEffect.update(timeInfo), 'CloudEffectV2 update');
      this._profileEffectCall('lighting', 'update', () => this._lightingEffect.update(timeInfo), 'LightingEffectV2 update');
      // Weather particles must update BEFORE the bus render so their BatchedRenderer
      // positions are current when the bus scene is drawn this frame.
      this._profileEffectCall('weatherParticles', 'update', () => this._weatherParticles?.update?.(timeInfo), 'WeatherParticlesV2 update');
      this._profileEffectCall('water', 'update', () => this._waterEffect?.update?.(timeInfo), 'WaterEffectV2 update');
      this._profileEffectCall('skyColor', 'update', () => this._skyColorEffect.update(timeInfo), 'SkyColorEffectV2 update');
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
          skyTintDarknessLightsEnabled: this._skyColorEffect?.params?.skyTintDarknessLightsEnabled,
          skyTintDarknessLightsIntensity: this._skyColorEffect?.params?.skyTintDarknessLightsIntensity,
        });
      } catch (_) {}
      try {
        this._dustEffect?.setSkyState?.({
          skyTintColor: this._skyColorEffect?.currentSkyTintColor,
          sunAzimuthDeg: this._skyColorEffect?.currentSunAzimuthDeg,
        });
      } catch (_) {}
      this._profileEffectCall('windowLight', 'update', () => this._windowLightEffect.update(timeInfo), 'WindowLightEffectV2 update');
      // Keep TileManager linked even if managers are re-created during canvas/scene transitions.
      try {
        const tm = window.MapShine?.tileManager ?? null;
        if (tm?.windowLightEffect !== this._windowLightEffect) {
          tm?.setWindowLightEffect?.(this._windowLightEffect);
        }
      } catch (_) {}
      this._profileEffectCall('colorCorrection', 'update', () => this._colorCorrectionEffect.update(timeInfo), 'ColorCorrectionEffectV2 update');
      this._profileEffectCall('filter', 'update', () => this._filterEffect.update(timeInfo), 'FilterEffectV2 update');
      this._profileEffectCall('atmosphericFog', 'update', () => this._atmosphericFogEffect.update(timeInfo), 'AtmosphericFogEffectV2 update');
      this._profileEffectCall('fogOfWar', 'update', () => this._fogEffect.update(timeInfo), 'FogOfWarEffectV2 update');
      this._profileEffectCall('bloom', 'update', () => this._bloomEffect.update(timeInfo), 'BloomEffectV2 update');
      this._profileEffectCall('sharpen', 'update', () => this._sharpenEffect.update(timeInfo), 'SharpenEffectV2 update');
      // Artistic post-processing effects
      this._profileEffectCall('dotScreen', 'update', () => this._dotScreenEffect?.update?.(timeInfo), 'DotScreenEffectV2 update');
      this._profileEffectCall('halftone', 'update', () => this._halftoneEffect?.update?.(timeInfo), 'HalftoneEffectV2 update');
      this._profileEffectCall('ascii', 'update', () => this._asciiEffect?.update?.(timeInfo), 'AsciiEffectV2 update');
      this._profileEffectCall('dazzleOverlay', 'update', () => this._dazzleOverlayEffect?.update?.(timeInfo), 'DazzleOverlayEffectV2 update');
      this._profileEffectCall('visionMode', 'update', () => this._visionModeEffect?.update?.(timeInfo), 'VisionModeEffectV2 update');
      this._profileEffectCall('invert', 'update', () => this._invertEffect?.update?.(timeInfo), 'InvertEffectV2 update');
      this._profileEffectCall('sepia', 'update', () => this._sepiaEffect?.update?.(timeInfo), 'SepiaEffectV2 update');
      this._profileEffectCall('lens', 'update', () => this._lensEffect?.update?.(timeInfo), 'LensEffectV2 update');
      this._profileEffectCall('distortion', 'update', () => this._distortionEffect?.update?.(timeInfo), 'DistortionManager update');

    }

    // Overhead + building shadows: run whenever we have timeInfo, not only inside
    // the populate-slim gate above. These effects push Tweakpane-driven uniforms
    // and mask bindings; skipping the outer block used to freeze sliders until
    // unrelated params (sun hash) changed.
    if (timeInfo) {
      this._profileEffectCall('overheadShadows', 'update', () => this._overheadShadowEffect?.update?.(timeInfo), 'OverheadShadowsEffectV2 update');
      this._profileEffectCall('buildingShadows', 'update', () => this._buildingShadowEffect?.update?.(timeInfo), 'BuildingShadowsEffectV2 update');
      this._profileEffectCall('skyReachShadows', 'update', () => this._skyReachShadowEffect?.update?.(timeInfo), 'SkyReachShadowsEffectV2 update');
      this._profileEffectCall('paintedShadows', 'update', () => this._paintedShadowEffect?.update?.(timeInfo), 'PaintedShadowEffectV2 update');
    }

    if (populateSlimRender) {
      this._runPopulateSlimRenderFrame();
      this._ensureDefaultFramebuffer();
      return;
    }

    // ── Bind per-frame textures and camera to effects ────────────────────────
    this._profileEffectCall('specular', 'render', () => this._specularEffect.render(this.renderer, this.camera), 'SpecularEffectV2 render');
    this._profileEffectCall('iridescence', 'render', () => this._iridescenceEffect.render(this.renderer, this.camera), 'IridescenceEffectV2 render');
    this._profileEffectCall('prism', 'render', () => this._prismEffect.render(this.renderer, this.camera), 'PrismEffectV2 render');

    // Feed live sun angles from SkyColorEffectV2 into building shadows and
    // overhead shadows — single source of truth for sun direction.
    try {
      const sky = this._skyColorEffect;
      if (sky && typeof sky.currentSunAzimuthDeg === 'number') {
        const az  = sky.currentSunAzimuthDeg;
        const el  = sky.currentSunElevationDeg ?? 45;
        this._overheadShadowEffect?.setSunAngles?.(az, el);
        this._buildingShadowEffect?.setSunAngles?.(az, el);
        this._skyReachShadowEffect?.setSunAngles?.(az, el);
        this._paintedShadowEffect?.setSunAngles?.(az, el);
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
    // Water upper-floor occluder: when multiple floors are visible, the water
    // shader can sample a screen-space mask built from upper levels' authored
    // scene RT alpha (see `_buildUpperSceneAlphaOccluder`). Bisect with
    // `window.MapShine.__alphaIsolationDebug.disableWaterOccluder = true`.
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
      this._prepareBusOcclusionMaskBeforeBus();
      this._renderBus?.syncRuntimeTileState?.(this._replicaOcclusionMaskPass);
    } catch (_) {}

    // Source shadow passes need current-frame light presence so torches, Foundry
    // lights, and WindowLightEffectV2 clear shadows without one-frame swimming.
    try {
      const activeIdx = Number.isFinite(Number(this._activeFloorIndex))
        ? Number(this._activeFloorIndex)
        : 0;
      this._windowLightEffect?.setRenderFloorIndex?.(activeIdx);
      this._windowLightEffect?.setCloudShadowTexture?.(null, 1, 1, null);
      this._windowLightEffect?.setOverheadRoofAlphaTexture?.(null, 1, 1);
      this._windowLightEffect?.setCeilingTransmittanceTexture?.(null);
      this._windowLightEffect?.syncFrameOcclusion?.(this);
      this._lightingEffect?.setRenderFloorIndexForLights?.(activeIdx);
      const winScene = resolveEffectEnabled(this._windowLightEffect)
        ? this._windowLightEffect._scene
        : null;
      this._lightingEffect?.renderLightOverrideMasks?.(this.renderer, this.camera, winScene);
    } catch (err) {
      log.warn('FloorCompositor: current-frame light override prepass failed:', err);
    }

    const _dynamicLightOverride = this._buildDynamicLightOverridePayload();
    try { this._overheadShadowEffect?.setDynamicLightOverride?.(_dynamicLightOverride); } catch (_) {}
    try { this._buildingShadowEffect?.setDynamicLightOverride?.(_dynamicLightOverride); } catch (_) {}
    try { this._skyReachShadowEffect?.setDynamicLightOverride?.(_dynamicLightOverride); } catch (_) {}
    try { this._paintedShadowEffect?.setDynamicLightOverride?.(_dynamicLightOverride); } catch (_) {}

    // Capture overhead tile alpha + compute soft shadow factor for lighting / ShadowManager.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: overheadShadows.render'); } catch (_) {} }
    if (_profiling) _profileT0 = performance.now();
    if (!_skipOverheadShadowPass) {
      this._profileEffectCall('overheadShadows', 'render', () => {
        this._overheadShadowEffect?.render?.(this.renderer, this._renderBus._scene, this.camera);
      }, 'OverheadShadowsEffectV2 render');
    }
    if (_profiling) this._recordPassTiming('overheadShadowsRender', _profileT0);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: overheadShadows.render DONE'); } catch (_) {} }

    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: buildingShadows.render'); } catch (_) {} }
    if (_profiling) _profileT0 = performance.now();
    if (!_skipBuildingShadowPass) {
      this._profileEffectCall('buildingShadows', 'render', () => {
        this._buildingShadowEffect?.render?.(this.renderer, this.camera);
      }, 'BuildingShadowsEffectV2 render');
    }
    if (_profiling) this._recordPassTiming('buildingShadowsRender', _profileT0);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: buildingShadows.render DONE'); } catch (_) {} }

    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: skyReachShadows.render'); } catch (_) {} }
    if (_profiling) _profileT0 = performance.now();
    if (!_skipBuildingShadowPass) {
      this._profileEffectCall('skyReachShadows', 'render', () => {
        this._skyReachShadowEffect?.render?.(this.renderer, this.camera);
      }, 'SkyReachShadowsEffectV2 render');
    }
    if (_profiling) this._recordPassTiming('skyReachShadowsRender', _profileT0);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: skyReachShadows.render DONE'); } catch (_) {} }

    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: paintedShadows.render'); } catch (_) {} }
    if (_profiling) _profileT0 = performance.now();
    if (!_skipBuildingShadowPass) {
      this._profileEffectCall('paintedShadows', 'render', () => {
        this._paintedShadowEffect?.render?.(this.renderer);
      }, 'PaintedShadowEffectV2 render');
    }
    if (_profiling) this._recordPassTiming('paintedShadowsRender', _profileT0);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: paintedShadows.render DONE'); } catch (_) {} }

    // ShadowManagerV2 (required): combine previous-frame cloud + structural shadows
    // for intermediate consumers. Splash/bubble shaders re-sync uniforms after the
    // post-cloud combine so they match the RT used for lighting this frame.
    try {
      this._runShadowManagerCombinePass(
        this._shadowManagerPrevFrameCloudTex,
        this._shadowManagerPrevFrameCloudRawTex ?? this._shadowManagerPrevFrameCloudTex,
        _disableOverheadInLighting
      );
    } catch (err) {
      log.warn('FloorCompositor: pre-bus ShadowManagerV2 combine failed:', err);
    }

    // Runtime tile opacity already synced before shadow capture above. Keep the
    // value as-is for the main albedo render.

    // ── Cloud passes (global — feeds lighting on each level) ───────────────
    // Cloud shadow RT includes overhead blockers and a floors-above-active mask;
    // ShadowManagerV2 still composes overhead + cloud.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: cloud.render'); } catch (_) {} }
    if (_profiling) _profileT0 = performance.now();
    const cloudEnabled = !_skipCloudPass && resolveEffectEnabled(this._cloudEffect);
    if (cloudEnabled) {
      this._profileEffectCall('cloud', 'render', () => this._cloudEffect.render(this.renderer), 'CloudEffectV2 render');
    }
    {
      const cloudTex = cloudEnabled
        ? this._cloudEffect.cloudShadowTexture
        : null;
      const cloudRawTex = cloudEnabled
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
    try { this._waterSplashesEffect?.syncShadowDarkeningUniforms?.(); } catch (err) {
      log.warn('WaterSplashesEffectV2 syncShadowDarkeningUniforms threw, skipping:', err);
    }
    if (_profiling) this._recordPassTiming('cloudRender', _profileT0);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: cloud.render DONE'); } catch (_) {} }

    // Shadow/cloud texture references for per-level lighting passes.
    const cloudShadowTexLegacy = cloudEnabled
      ? this._cloudEffect.cloudShadowTexture : null;
    const windowCloudShadowTexLegacy = cloudEnabled
      ? (this._cloudEffect.cloudShadowRawTexture ?? this._cloudEffect.cloudShadowTexture)
      : null;
    const cloudShadowRawTexLegacy = windowCloudShadowTexLegacy;
    const windowCloudShadowViewBounds = cloudEnabled
      ? (this._cloudEffect.cloudShadowViewBounds ?? null) : null;
    const buildingShadowTex = resolveEffectEnabled(this._buildingShadowEffect)
      ? this._buildingShadowEffect.shadowFactorTexture : null;
    const smCombinedTex = this._shadowManagerEffect?.combinedShadowTexture ?? null;
    const combinedShadowTex = smCombinedTex ?? cloudShadowTexLegacy;
    const combinedShadowRawTex = this._shadowManagerEffect?.combinedShadowRawTexture ?? combinedShadowTex;
    const paintedShadowLitTex = (smCombinedTex != null && resolveEffectEnabled(this._paintedShadowEffect) && this._paintedShadowEffect?.params?.enabled)
      ? (this._paintedShadowEffect.shadowFactorTexture ?? null)
      : null;
    const paintedShadowMgrOpacity = Number.isFinite(Number(this._shadowManagerEffect?.params?.paintedOpacity))
      ? Math.max(0, Math.min(1, Number(this._shadowManagerEffect.params.paintedOpacity)))
      : 1.0;
    const buildingShadowTexForLighting = smCombinedTex != null ? null : buildingShadowTex;
    const buildingShadowOpacity = Number.isFinite(this._buildingShadowEffect?.params?.opacity)
      ? this._buildingShadowEffect.params.opacity : 0.75;
    const overheadShadowTexLegacy = (!_disableOverheadInLighting && resolveEffectEnabled(this._overheadShadowEffect))
      ? this._overheadShadowEffect.shadowFactorTexture : null;
    const overheadRoofAlphaTex = _disableRoofInLighting ? null : (this._overheadShadowEffect?.roofAlphaTexture ?? null);
    const overheadRoofBlockTex = _disableRoofInLighting ? null : (this._overheadShadowEffect?.roofBlockTexture ?? null);
    const ceilingTransmittanceTex = (!_disableRoofInLighting && this._overheadShadowEffect?.ceilingTransmittanceTextureForLighting)
      ? this._overheadShadowEffect.ceilingTransmittanceTextureForLighting : null;
    const overheadRoofRestrictLightTex = _disableRoofInLighting ? null : (this._overheadShadowEffect?.roofRestrictLightTexture ?? null);

    // External-effects compositor (Sequencer / JB2A mirrors live in the bus
    // scene — sync transforms immediately before the per-level pipeline kicks
    // off so the bus render sees current positions). DSN composite runs later.
    try {
      window.MapShine?.externalEffects?.tickBeforeBusRender?.();
    } catch (err) {
      log.warn('FloorCompositor: externalEffects.tickBeforeBusRender failed:', err);
    }

    // ── Per-level scene RTs + composite (sole V2 render path) ───────────────
    const _compositeOut = this._renderPerLevelPipeline({
      _profiling,
      _dbgStages,
      _skipWaterPass,
      _alphaIsoDebug,
      cloudShadowTexLegacy,
      cloudShadowRawTexLegacy,
      combinedShadowTex,
      combinedShadowRawTex,
      paintedShadowLitTex,
      paintedShadowMgrOpacity,
      buildingShadowTex,
      buildingShadowTexForLighting,
      buildingShadowOpacity,
      overheadShadowTexLegacy,
      overheadRoofAlphaTex,
      overheadRoofBlockTex,
      ceilingTransmittanceTex,
      overheadRoofRestrictLightTex,
      windowCloudShadowViewBounds,
    });
    if (!_compositeOut) {
      log.warn('FloorCompositor.render: per-level pipeline produced no output');
      if (_dbgStages) this._debugFirstFrameStagesLogged = true;
      this._ensureDefaultFramebuffer();
      return;
    }
    let currentInput = _compositeOut;

    // External effects: composite Dice So Nice's own canvas onto the scene
    // BEFORE distortion/fog/lens, so dice receive those post-FX along with
    // the rest of the scene (bloom + color grade already applied per-level).
    try {
      const ee = window.MapShine?.externalEffects ?? null;
      if (ee && ee.requiresContinuousRender?.()) {
        const dsnOutput = (currentInput === this._postA) ? this._postB : this._postA;
        const next = withSceneScissor(this.renderer, () =>
          ee.renderDsnPass(this.renderer, currentInput, dsnOutput)
        );
        if (next && next !== currentInput) {
          currentInput = next;
        }
      }
    } catch (err) {
      log.warn('FloorCompositor: externalEffects.renderDsnPass failed:', err);
    }

    // Distortion pass (runs once on composite; not inside per-level loop)
    if (resolveEffectEnabled(this._distortionEffect)) {
      this._syncFireHeatDistortionSource();
      const distOut = (currentInput === this._postA) ? this._postB : this._postA;
      this._distortionEffect.setBuffers(currentInput, distOut);
      this._distortionEffect.setRenderToScreen(false);
      this._profileEffectCall('distortion', 'render', () => {
        withSceneScissor(this.renderer, () => {
          this._distortionEffect.render(this.renderer, this._renderBus?._scene ?? this.scene, this.camera);
        });
      }, 'DistortionManager render');
      currentInput = distOut;
    }

    // PIXI world-channel composite: inject bridge drawings late so they are
    // not altered by bloom/grading stylization passes.
    if (_profiling) _profileT0 = performance.now();
    currentInput = withSceneScissor(this.renderer, () =>
      this._compositePixiWorldOverlay(currentInput)
    );
    if (_profiling) this._recordPassTiming('pixiWorldComposite', _profileT0);

    // Composite fog-of-war into the RT chain so downstream post effects (lens)
    // are guaranteed to render above fog.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: fogOverlay.compositeToRT'); } catch (_) {} }
    {
      const fogOutput = (currentInput === this._postA) ? this._postB : this._postA;
      let fogWrote = false;
      this._profileEffectCall('fogOfWar', 'render', () => {
        fogWrote = withSceneScissor(this.renderer, () =>
          this._compositeFogOverlayToRT(currentInput, fogOutput)
        );
      }, 'FogOfWarEffectV2 composite');
      if (fogWrote) {
        currentInput = fogOutput;
      }
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: fogOverlay.compositeToRT DONE'); } catch (_) {} }

    // Stylized lens pass: distortion/chromatic/vignette/grime overlays.
    // This now runs after fog composition so lens artifacts remain on top of FOW.
    // CRITICAL: Pass _postA as the luma sample source so the lens effect can detect
    // actual light intensity (albedo × lighting) BEFORE sky color grading darkens it.
    // We can't use the raw per-level albedo RT because it is too dark, and we can't use
    // currentInput (final graded composite) because darkness has already been applied.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: lens.render'); } catch (_) {} }
    if (!_skipLensPass && resolveEffectEnabled(this._lensEffect)) {
      const lensOutput = (currentInput === this._postA) ? this._postB : this._postA;
      let wrote = false;
      this._profileEffectCall('lens', 'render', () => {
        wrote = withSceneScissor(this.renderer, () =>
          this._lensEffect.render(this.renderer, this.camera, currentInput, lensOutput, this._postA)
        );
      }, 'LensEffectV2 render');
      if (wrote) {
        currentInput = lensOutput;
      }
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: lens.render DONE'); } catch (_) {} }

    // Night vision goggles post-pass (after lens): tube tint, gain, bloom burn, scanlines.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: playerLight.nightVision'); } catch (_) {} }
    if (resolveEffectEnabled(this._playerLightEffect) && this._playerLightEffect?.shouldRenderNightVision?.()) {
      const nvOutput = (currentInput === this._postA) ? this._postB : this._postA;
      let wrote = false;
      this._profileEffectCall('playerLight', 'render', () => {
        wrote = withSceneScissor(this.renderer, () =>
          this._playerLightEffect.renderNightVision(this.renderer, this.camera, currentInput, nvOutput)
        );
      }, 'PlayerLightEffectV2 renderNightVision');
      if (wrote) {
        currentInput = nvOutput;
      }
    }
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: playerLight.nightVision DONE'); } catch (_) {} }

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
              case 'overhead_roof_restrict_light':
                return ov.roofRestrictLightTexture ?? null;
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
    if (_profiling) _profileT0 = performance.now();
    this._renderLateWorldOverlay();
    if (_profiling) this._recordPassTiming('lateOverlayRender', _profileT0);
    if (_dbgStages) { try { log.info('[V2 Frame] ✔ Stage: lateOverlay.render DONE'); } catch (_) {} }

    // Cloud-top blit: render after late world overlay so atmospheric cloud tops
    // remain visually above world-space overlay content (e.g. bypass tiles,
    // drawing overlays, interaction aids routed through OVERLAY_THREE_LAYER).
    // Keep PIXI UI overlay above clouds so HUD/control affordances stay readable.
    if (_dbgStages) { try { log.info('[V2 Frame] ▶ Stage: cloudTops.blit'); } catch (_) {} }
    if (resolveEffectEnabled(this._cloudEffect)) {
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

    // Strict-sync: record a successful frame in telemetry.
    if (strictSyncEnabled) {
      this._strictFramesRendered++;
      try {
        if (window?.MapShine) {
          window.MapShine.__v2StrictFrameStats = {
            rendered: this._strictFramesRendered,
            held: this._strictFrameHoldCount,
            lastHoldReason: this._strictLastHoldReason,
            lastHoldAtMs: this._strictLastHoldAtMs,
          };
        }
      } catch (_) {}
    }

    // Always leave the context on the default framebuffer so the canvas presents
    // the last blit. _blitToScreen restores prevTarget, which can re-bind an RT.
    this._ensureDefaultFramebuffer();
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

      // V14-native: resolve via native levels membership (tiles use `levels` Set,
      // tokens use singular `level`). This guard runs on tiles only but handles
      // both for safety.
      try {
        const singleLevel = tileDoc?.level ?? tileDoc?._source?.level;
        if (typeof singleLevel === 'string' && singleLevel.length > 0) {
          for (let i = 0; i < floors.length; i += 1) {
            if (floors[i].levelId === singleLevel) return i;
          }
        }
        const levelsSet = tileDoc?.levels;
        if (levelsSet?.size) {
          for (const lid of levelsSet) {
            for (let i = 0; i < floors.length; i += 1) {
              if (floors[i].levelId === lid) return i;
            }
          }
        }
      } catch (_) {}

      // Legacy: Levels range flags
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
   * Performance Recorder shim. When the recorder is enabled, wraps `fn` in a
   * begin/end span so CPU + (optional) GPU + draw-call deltas are attributed
   * to `effectKey`/`phase`. When disabled, this is a single property lookup
   * plus the original try/catch — measured cost is ~tens of nanoseconds per
   * call, safe to leave on the hot path unconditionally.
   *
   * @param {string} effectKey - Stable effect identifier (e.g. `'lighting'`).
   * @param {'update'|'render'} phase
   * @param {() => void} fn - Wrapped call (must NOT throw asynchronously).
   * @param {string} [errorLabel] - Used by the existing per-effect log warn
   *   when `fn` throws. Defaults to `${effectKey} ${phase}`.
   * @private
   */
  _profileEffectCall(effectKey, phase, fn, errorLabel) {
    const recorder = (typeof window !== 'undefined') ? window?.MapShine?.performanceRecorder : null;
    const recording = recorder?.enabled === true;
    const token = recording ? recorder.beginEffectCall(effectKey, phase) : null;
    try {
      fn();
    } catch (err) {
      log.warn(`${errorLabel ?? `${effectKey} ${phase}`} threw, skipping frame:`, err);
    } finally {
      if (recording) recorder.endEffectCall(token);
    }
  }

  /**
   * Blit a render target's colour attachment to the screen framebuffer.
   * @param {THREE.WebGLRenderTarget} sourceRT
   * @private
   */
  /**
   * Bind the WebGL default framebuffer (visible canvas). Passes and
   * {@link #_blitToScreen} can leave an off-screen RT bound; the canvas then
   * keeps showing stale pixels (often read as grey) until something resets.
   * @private
   */
  _ensureDefaultFramebuffer() {
    try {
      const r = this.renderer;
      if (!r || typeof r.setRenderTarget !== 'function') return;
      r.setRenderTarget(null);
    } catch (_) {}
  }

  _blitToScreen(sourceRT) {
    if (!this._blitMaterial || !sourceRT) return;
    const renderer = this.renderer;

    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevScissorTest = (typeof renderer.getScissorTest === 'function')
      ? renderer.getScissorTest()
      : null;
    const THREE = window.THREE;
    if (!this._tempColor && THREE) this._tempColor = new THREE.Color();
    if (!this._tempVec4 && THREE) this._tempVec4 = new THREE.Vector4();
    const prevClearColor = (THREE && typeof renderer.getClearColor === 'function')
      ? renderer.getClearColor(this._tempColor)
      : null;
    const prevClearAlpha = (typeof renderer.getClearAlpha === 'function')
      ? renderer.getClearAlpha()
      : null;
    const prevViewport = (THREE && typeof renderer.getViewport === 'function')
      ? renderer.getViewport(this._tempVec4)
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
        // Unscissored clear: paint the entire default framebuffer black.
        // The scissored blit below only writes the inner sceneRect, so the
        // padded zone + outer black region stay at this clear color. This
        // is what guarantees the outer area is clean even if the source
        // RT (`_postA` / `_postB`) has stale content there from prior
        // frames or before SceneRectScissor became valid.
        renderer.clear(true, true, true);
      }
      // Scissor the blit so we never sample / write the source RT's
      // outer-rect area onto the screen. If scissor is invalid (no
      // sceneRect / off-screen / disabled), withSceneScissor falls
      // through to a passthrough so the full blit still runs.
      withSceneScissor(renderer, () => {
        renderer.render(this._blitScene, this._blitCamera);
      });
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
    try {
      this._overheadShadowEffect?.invalidateDynamicCaches?.('level-context-changed');
    } catch (_) {}
    this._applyCurrentFloorVisibility(payload);
    try {
      const ms = window.MapShine;
      ms?.renderLoop?.requestRender?.();
      ms?.renderLoop?.requestContinuousRender?.(220);
    } catch (_) {}
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
   * @param {{allowWeatherRoofMap?: boolean, strictViewedFloorOnly?: boolean}} [options]
   *   `allowWeatherRoofMap=false` (lighting pass) never uses
   *   `weatherController.roofMap` — it is not an indoor/outdoor floor mask and wrongly gates lights.
   *   `strictViewedFloorOnly=true` disables sibling/lower-band fallbacks inside
   *   `resolveCompositorOutdoorsTexture` so multi-floor scenes never reuse another
   *   floor's outdoors mask when the viewed band's texture is missing.
   * @returns {{texture: THREE.Texture|null, floorKey: string|null}}
   * @private
   */
  _resolveOutdoorsMask(context = null, options = {}) {
    const { allowWeatherRoofMap = true, strictViewedFloorOnly = false } = options;

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
    const bundleMask = sc?.currentBundle?.masks?.find?.(m => (m?.id === 'outdoors' || m?.type === 'outdoors'))?.texture ?? null;

    // Multi-floor scenes intentionally avoid global "ground" fallbacks because
    // they can be stale from another band. However, if the per-floor GPU cache
    // is still empty, forcing neutral-indoor fallback makes every consumer look
    // wrong at once (lighting/water/cloud/shadows). In that transient state,
    // prefer bundle _Outdoors over the neutral synthetic texture.
    let compositorHasFloorMasks = false;
    if (compositor) {
      try {
        const cacheSize = Number(compositor?._floorCache?.size ?? 0);
        const metaSize = Number(compositor?._floorMeta?.size ?? 0);
        compositorHasFloorMasks = (cacheSize > 0) || (metaSize > 0);
      } catch (_) {
        compositorHasFloorMasks = false;
      }
    }
    const allowBundleFallback = !skipGroundGlobalFallback || !compositorHasFloorMasks;

    if (!compositor) {
      if (bundleMask) return { texture: bundleMask, floorKey: 'bundle' };
      if (!skipGroundGlobalFallback) {
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
      {
        skipGroundFallback: skipGroundGlobalFallback,
        allowBundleFallback,
        strictViewedFloorOnly,
      },
    );
    if (gpu.texture) {
      return { texture: gpu.texture, floorKey: gpu.resolvedKey };
    }

    if (allowBundleFallback && bundleMask) {
      return { texture: bundleMask, floorKey: 'bundle' };
    }

    if (!skipGroundGlobalFallback) {
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
   * Build (once) a tiny indoors-classified outdoors mask fallback.
   * R=0, A=1 => shader decoders classify as indoor, never "all outdoors".
   *
   * @returns {THREE.Texture|null}
   * @private
   */
  _getNeutralOutdoorsTexture() {
    if (this._neutralOutdoorsTexture) return this._neutralOutdoorsTexture;
    try {
      const THREE = window.THREE;
      if (!THREE?.DataTexture || !THREE?.RGBAFormat || !THREE?.UnsignedByteType) return null;
      const data = new Uint8Array([0, 0, 0, 255]);
      const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.name = 'MapShineNeutralOutdoorsMask';
      tex.needsUpdate = true;
      tex.flipY = false;
      this._neutralOutdoorsTexture = tex;
      return tex;
    } catch (_) {
      return null;
    }
  }

  /**
   * Lazily instantiate and return the MaskBindingController.
   *
   * The controller is shared across frames. It is safe to re-read the global
   * rollout flag `window.MapShine.maskBindingControllerEnabled` on each
   * `sync()` call — when disabled the legacy `_syncOutdoorsMaskConsumers`
   * continues to own mask distribution.
   *
   * @returns {import('../masks/mask-binding-controller.js').MaskBindingController}
   * @private
   */
  _getMaskBindingController() {
    if (!this._maskBindingController) {
      this._maskBindingController = new MaskBindingController({ floorCompositor: this });
      try {
        if (window?.MapShine) {
          window.MapShine.__maskBindingController = this._maskBindingController;
        }
      } catch (_) {}
    }
    return this._maskBindingController;
  }

  /**
   * Whether the unified MaskBindingController is enabled. Flag lookup is
   * per-frame so the rollout can be toggled live from the console without a
   * reload.
   *
   * @returns {boolean}
   * @private
   */
  _isMaskBindingControllerEnabled() {
    try {
      return window?.MapShine?.maskBindingControllerEnabled === true;
    } catch (_) {
      return false;
    }
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
      const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
      let floorStackForSync = [];
      try {
        floorStackForSync = window.MapShine?.floorStack?.getFloors?.() ?? [];
      } catch (_) {
        floorStackForSync = [];
      }
      const multiFloorScene = floorStackForSync.length > 1;

      // Multi-floor bands must not reuse sibling/lower-floor outdoors fallbacks.
      // If the viewed floor's outdoors is missing, prefer neutral indoor over
      // inheriting another floor's indoor/outdoor layout.
      const resolved = this._resolveOutdoorsMask(context, {
        strictViewedFloorOnly: multiFloorScene,
      });
      let outdoorsTex = resolved.texture ?? null;
      // Water movement suppression must use a real _Outdoors mask.
      // Do not seed this from the generic path because it may fall back to
      // weatherController.roofMap (not floor-authored indoors/outdoors data).
      const waterResolved = this._resolveOutdoorsMask(context, {
        allowWeatherRoofMap: false,
        strictViewedFloorOnly: multiFloorScene,
      });
      let waterOutdoorsTex = waterResolved.texture ?? null;
      let waterOutdoorsRoute = waterResolved.floorKey ?? null;
      // Sky grading is very sensitive to mask source quality/alignment.
      // Resolve a strict floor outdoors texture for sky that never falls back to
      // weather roof maps and never reuses stale previous masks.
      const skyResolved = this._resolveOutdoorsMask(context, {
        allowWeatherRoofMap: false,
        strictViewedFloorOnly: multiFloorScene,
      });
      const skyOutdoorsTex = skyResolved.texture ?? null;
      const neutralOutdoorsTex = this._getNeutralOutdoorsTexture();
      let compositorHasFloorMasks = false;
      try {
        const cacheSize = Number(compositor?._floorCache?.size ?? 0);
        const metaSize = Number(compositor?._floorMeta?.size ?? 0);
        compositorHasFloorMasks = (cacheSize > 0) || (metaSize > 0);
      } catch (_) {
        compositorHasFloorMasks = false;
      }

      // Do not clobber a valid outdoors texture with transient null while floor
      // caches are still warming asynchronously. On upper floors, reusing the
      // previous texture is usually stale ground-floor _Outdoors.
      let mainRoute = resolved.floorKey ?? null;
      if (!outdoorsTex && this._lastOutdoorsTexture && !multiFloorScene) {
        outdoorsTex = this._lastOutdoorsTexture;
        mainRoute = 'reused-last';
      }
      if (!outdoorsTex && multiFloorScene && neutralOutdoorsTex) {
        outdoorsTex = neutralOutdoorsTex;
        mainRoute = 'neutral';
      }
      if (!waterOutdoorsTex && multiFloorScene && neutralOutdoorsTex) {
        waterOutdoorsTex = neutralOutdoorsTex;
        waterOutdoorsRoute = 'neutral';
      }
      const skyOutdoorsFinal = (!skyOutdoorsTex && multiFloorScene && neutralOutdoorsTex)
        ? neutralOutdoorsTex
        : skyOutdoorsTex;
      const skyRoute = skyOutdoorsTex ? (skyResolved.floorKey ?? null) : (skyOutdoorsFinal ? 'neutral' : null);

      // Active-floor `skyReach` mask: gates SkyColorEffectV2 so pixels under
      // upper-floor solid coverage (bridges, rooftops, overhangs) stop
      // receiving sky color. The mask is produced by GpuSceneMaskCompositor as
      // `outdoors ∧ ¬union(upper-floor floorAlpha)`; see `scripts/masks/shaders/skyReachShader.js`.
      let skyReachTex = null;
      let skyReachRoute = null;
      try {
        const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
        const ck = activeFloor?.compositorKey != null ? String(activeFloor.compositorKey) : '';
        if (compositor) {
          if (ck) {
            skyReachTex = compositor.getFloorTexture?.(ck, 'skyReach') ?? null;
            if (skyReachTex) skyReachRoute = `floor:${ck}`;
          }
          if (!skyReachTex) {
            const b = Number(activeFloor?.elevationMin);
            const t = Number(activeFloor?.elevationMax);
            if (Number.isFinite(b) && Number.isFinite(t)) {
              const fallbackKey = `${b}:${t}`;
              skyReachTex = compositor.getFloorTexture?.(fallbackKey, 'skyReach') ?? null;
              if (skyReachTex) skyReachRoute = `band:${fallbackKey}`;
            }
          }
        }
      } catch (_) {
        skyReachTex = null;
      }

      // PaintedShadowEffectV2 should gate by the currently viewed floor band only.
      // Do not reuse sibling/lower-floor outdoors fallbacks from the generic route.
      let paintedOutdoorsTex = null;
      let paintedOutdoorsRoute = null;
      try {
        if (compositor) {
          const strictPainted = resolveCompositorOutdoorsTexture(compositor, context, {
            skipGroundFallback: multiFloorScene,
            allowBundleFallback: !multiFloorScene || !compositorHasFloorMasks,
            strictViewedFloorOnly: true,
          });
          paintedOutdoorsTex = strictPainted.texture ?? null;
          paintedOutdoorsRoute = strictPainted.route ?? strictPainted.resolvedKey ?? null;
        }
      } catch (_) {
        paintedOutdoorsTex = null;
        paintedOutdoorsRoute = null;
      }
      if (!paintedOutdoorsTex && multiFloorScene && neutralOutdoorsTex) {
        paintedOutdoorsTex = neutralOutdoorsTex;
        paintedOutdoorsRoute = 'neutral';
      }
      if (!paintedOutdoorsTex && !multiFloorScene) {
        paintedOutdoorsTex = outdoorsTex;
        paintedOutdoorsRoute = mainRoute ? `main:${mainRoute}` : 'main';
      }

      // Water can run in floor-fallback mode (for example only ground has _Water
      // data while viewing an upper floor). In that case, sampling outdoors from
      // the viewed floor can alter wave/rain response and make the same water body
      // appear different per view floor. Prefer outdoors for the active water floor
      // when available so fallback water remains visually consistent.
      let resolvedWaterFloorIndex = null;
      try {
        const waterFloorIndex = Number(this._waterEffect?._activeFloorIndex);
        if (Number.isFinite(waterFloorIndex)) {
          resolvedWaterFloorIndex = waterFloorIndex;
          const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
          const waterFloor = floors.find((f) => Number(f?.index) === waterFloorIndex) ?? null;
          const waterFloorKey = waterFloor?.compositorKey ?? null;
          const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
          const waterFloorTex = (compositor && waterFloorKey)
            ? (
              compositor.getFloorTexture?.(waterFloorKey, 'skyReach')
              ?? compositor.getFloorTexture?.(waterFloorKey, 'outdoors')
              ?? null
            )
            : null;
          if (waterFloorTex) {
            waterOutdoorsTex = waterFloorTex;
            waterOutdoorsRoute = `water-floor:${waterFloorKey}`;
          }
        }
      } catch (_) {}

      // When water geometry/data is for the **same floor being viewed**, force the water
      // shader to sample the **same** _Outdoors texture as the rest of the stack (cloud,
      // lighting sync via weatherController.setRoofMap, overhead/building shadows, etc.).
      // Otherwise water used compositor.getFloorTexture(key, skyReach ?? outdoors) while
      // main used resolveCompositorOutdoorsTexture — sibling band keys / skyReach vs
      // outdoors / async RT pools can disagree and look like wrong-floor or inverted
      // indoor/outdoor response next to a neutral (all-indoor) fallback.
      try {
        const viewedFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
        const viewedIdx = Number(viewedFloor?.index);
        const waterIdx = Number(this._waterEffect?._activeFloorIndex);
        if (
          Number.isFinite(viewedIdx)
          && Number.isFinite(waterIdx)
          && viewedIdx === waterIdx
          && outdoorsTex
        ) {
          waterOutdoorsTex = outdoorsTex;
          waterOutdoorsRoute = mainRoute ? `same-floor-as-main:${mainRoute}` : 'same-floor-as-main';
        }
      } catch (_) {}

      // Resolve per-floor cloud outdoors masks and the floor-id texture up-front
      // so their identities participate in the binding signature below. This
      // ensures e.g. async promotion of a newly composed upper-floor outdoors
      // mask triggers a full resync even when the main texture identity
      // didn't change.
      let cloudPerFloor = [null, null, null, null];
      let cloudFloorIdTex = null;
      let cloudFloorIdSupported = true;
      let cloudAnyPerFloorMask = false;
      try {
        const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
        if (compositor) {
          const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
          for (const floor of floors) {
            const idx = Number(floor?.index);
            const key = floor?.compositorKey;
            if (!Number.isFinite(idx) || idx < 0 || idx > 3) {
              cloudFloorIdSupported = false;
              continue;
            }
            if (!key) continue;
            cloudPerFloor[idx] = compositor.getFloorTexture?.(key, 'outdoors') ?? null;
            if (cloudPerFloor[idx]) cloudAnyPerFloorMask = true;
          }
          if (cloudFloorIdSupported && cloudAnyPerFloorMask) {
            cloudFloorIdTex = compositor.floorIdTarget?.texture ?? null;
          }
        }
      } catch (_) {}

      // Build a comprehensive binding signature. Any change to any consumer's
      // input (main/water/sky/clouds/floorId) triggers a full resync. We still
      // honour `force: true` from callers (e.g. floor-change path) which
      // bypasses the signature entirely.
      const _ctx = context ?? null;
      const _b = Number(_ctx?.bottom);
      const _t = Number(_ctx?.top);
      const contextKey = Number.isFinite(_b) ? `${_b}:${Number.isFinite(_t) ? _t : 'inf'}` : 'single';
      const texId = (tex) => (tex?.uuid ? tex.uuid : (tex ? 'anon' : 'null'));
      // Include the compositor's floor-cache version. When composeFloor
      // completes asynchronously and a new RT becomes available for any
      // floor/mask combination, this version bumps so the signature changes
      // even if the texture identity alias would otherwise cause a false
      // early-return (e.g. a previously-fallback route promoting to a
      // direct compositor texture that reuses a pooled texture uuid).
      const isMulti = cloudFloorIdSupported && cloudAnyPerFloorMask;
      let cacheVersion = 0;
      try {
        cacheVersion = Number(window?.MapShine?.sceneComposer?._sceneMaskCompositor?.getFloorCacheVersion?.() ?? 0);
      } catch (_) {}

      // Zero-GC Signature Verification
      const cache = this._outdoorsStateCache;
      let signatureChanged = false;

      if (cache.contextKey !== contextKey) { cache.contextKey = contextKey; signatureChanged = true; }
      if (cache.mainTex !== outdoorsTex) { cache.mainTex = outdoorsTex; signatureChanged = true; }
      if (cache.mainRoute !== mainRoute) { cache.mainRoute = mainRoute; signatureChanged = true; }
      if (cache.waterTex !== waterOutdoorsTex) { cache.waterTex = waterOutdoorsTex; signatureChanged = true; }
      if (cache.waterRoute !== waterOutdoorsRoute) { cache.waterRoute = waterOutdoorsRoute; signatureChanged = true; }
      if (cache.waterFloorIdx !== resolvedWaterFloorIndex) { cache.waterFloorIdx = resolvedWaterFloorIndex; signatureChanged = true; }
      if (cache.skyTex !== skyOutdoorsFinal) { cache.skyTex = skyOutdoorsFinal; signatureChanged = true; }
      if (cache.skyRoute !== skyRoute) { cache.skyRoute = skyRoute; signatureChanged = true; }
      if (cache.skyReachTex !== skyReachTex) { cache.skyReachTex = skyReachTex; signatureChanged = true; }
      if (cache.skyReachRoute !== skyReachRoute) { cache.skyReachRoute = skyReachRoute; signatureChanged = true; }
      if (cache.paintedTex !== paintedOutdoorsTex) { cache.paintedTex = paintedOutdoorsTex; signatureChanged = true; }
      if (cache.paintedRoute !== paintedOutdoorsRoute) { cache.paintedRoute = paintedOutdoorsRoute; signatureChanged = true; }
      if (cache.cloudMulti !== isMulti) { cache.cloudMulti = isMulti; signatureChanged = true; }
      if (cache.floorIdTex !== cloudFloorIdTex) { cache.floorIdTex = cloudFloorIdTex; signatureChanged = true; }
      if (cache.activeFloorIdx !== this._activeFloorIndex) { cache.activeFloorIdx = this._activeFloorIndex; signatureChanged = true; }
      if (cache.cacheVersion !== cacheVersion) { cache.cacheVersion = cacheVersion; signatureChanged = true; }

      if (cache.cloudTex0 !== cloudPerFloor[0]) { cache.cloudTex0 = cloudPerFloor[0]; signatureChanged = true; }
      if (cache.cloudTex1 !== cloudPerFloor[1]) { cache.cloudTex1 = cloudPerFloor[1]; signatureChanged = true; }
      if (cache.cloudTex2 !== cloudPerFloor[2]) { cache.cloudTex2 = cloudPerFloor[2]; signatureChanged = true; }
      if (cache.cloudTex3 !== cloudPerFloor[3]) { cache.cloudTex3 = cloudPerFloor[3]; signatureChanged = true; }

      if (!force && !signatureChanged) return;
      this._lastOutdoorsTexture = outdoorsTex;
      this._lastOutdoorsFloorKey = resolved.floorKey;
      this._lastOutdoorsContextKey = contextKey;
      this._lastOutdoorsRouteInfo = {
        contextKey,
        main: { route: mainRoute, texture: !!outdoorsTex },
        water: { route: waterOutdoorsRoute, texture: !!waterOutdoorsTex, floorIndex: resolvedWaterFloorIndex },
        sky: { route: skyRoute, texture: !!skyOutdoorsFinal },
        skyReach: { route: skyReachRoute, texture: !!skyReachTex },
        painted: { route: paintedOutdoorsRoute, texture: !!paintedOutdoorsTex },
        cloud: {
          mode: cloudFloorIdSupported && cloudAnyPerFloorMask ? 'multi' : 'single',
          perFloorPresent: cloudPerFloor.map((t) => !!t),
          floorId: !!cloudFloorIdTex,
        },
      };
      try {
        if (window?.MapShine) {
          window.MapShine.__v2OutdoorsRoute = this._lastOutdoorsRouteInfo;
        }
      } catch (_) {}

      // Always propagate (including null) so consumers cannot keep stale masks.
      this._cloudEffect?.setOutdoorsMask?.(outdoorsTex);
      this._waterEffect?.setOutdoorsMask?.(waterOutdoorsTex);
      this._skyColorEffect?.setOutdoorsMask?.(skyOutdoorsFinal);
      this._skyColorEffect?.setSkyReachMask?.(skyReachTex);
      this._filterEffect?.setOutdoorsMask?.(outdoorsTex);
      this._atmosphericFogEffect?.setOutdoorsMask?.(outdoorsTex);
      this._overheadShadowEffect?.setOutdoorsMask?.(outdoorsTex);
      this._buildingShadowEffect?.setOutdoorsMask?.(outdoorsTex);
      this._paintedShadowEffect?.setOutdoorsMask?.(paintedOutdoorsTex);

      // Apply the pre-resolved cloud per-floor bindings. If the visible floor
      // set isn't representable, fall back to legacy single-mask mode.
      try {
        if (cloudFloorIdSupported && cloudAnyPerFloorMask) {
          this._cloudEffect?.setFloorIdTexture?.(cloudFloorIdTex);
          this._cloudEffect?.setOutdoorsMasks?.(cloudPerFloor);
        } else {
          this._cloudEffect?.setFloorIdTexture?.(null);
          this._cloudEffect?.setOutdoorsMasks?.([null, null, null, null]);
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
    if (!floorStack) {
      // Fallback: floorStack may be transiently unavailable during load races.
      // Keep a deterministic floor context so effects do not remain unbound.
      const fallbackIdx = Number.isFinite(Number(this._renderBus?._visibleMaxFloorIndex))
        ? Number(this._renderBus._visibleMaxFloorIndex)
        : 0;
      this._activeFloorIndex = fallbackIdx;
      try { this._renderBus.setVisibleFloors(fallbackIdx); } catch (_) {}
      try { this._fireEffect?.onFloorChange?.(fallbackIdx); } catch (_) {}
      try { this._ashDisturbanceEffect?.onFloorChange?.(fallbackIdx); } catch (_) {}
      try { this._dustEffect?.onFloorChange?.(fallbackIdx); } catch (_) {}
      try { this._specularEffect?.onFloorChange?.(fallbackIdx); } catch (_) {}
      try { this._waterSplashesEffect?.onFloorChange?.(fallbackIdx); } catch (_) {}
      try { this._windowLightEffect?.onFloorChange?.(fallbackIdx); } catch (_) {}
      try { this._cloudEffect?.onFloorChange?.(fallbackIdx); } catch (_) {}
      try { this._waterEffect?.onFloorChange?.(fallbackIdx); } catch (_) {}
      log.warn(`FloorCompositor: floorStack unavailable, using fallback floor index ${fallbackIdx}`);
      return;
    }

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
    this._activeFloorIndex = maxFloorIndex;
    
    this._renderBus.setVisibleFloors(maxFloorIndex);
    // Notify fire effect of floor change so it can swap active particle systems.
    this._fireEffect.onFloorChange(maxFloorIndex);
    try { this._ashDisturbanceEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Notify dust effect of floor change so it can swap active particle systems.
    this._dustEffect.onFloorChange(maxFloorIndex);
    // Specular background overlay needs floor rebinding on level changes.
    try { this._specularEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Iridescence overlays are bus-managed but we still notify for parity.
    try { this._iridescenceEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Notify water splashes of floor change so it can swap active systems.
    try { this._waterSplashesEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    // Bush/Tree overlays are bus-managed; still notify for any internal floor state.
    try { this._bushEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
    try { this._treeEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}
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
    // Swap active water SDF data for the new floor BEFORE the outdoors sync so
    // that _syncOutdoorsMaskConsumers observes the final water floor index and
    // binds the correct floor-scoped water outdoors texture on the same pass.
    // Previously, water outdoors was bound against the old floor, which
    // produced visible desync (wrong indoor/outdoor water damping) until the
    // next per-frame resync tick.
    try { this._waterEffect?.onFloorChange?.(maxFloorIndex); } catch (_) {}

    // Outdoors consumer sync runs after every consumer has been updated with
    // its new floor index. Force=true ensures the signature is re-evaluated
    // against the current floor state, not skipped by stale identity.
    this._syncOutdoorsMaskConsumers({
      context: payload?.context ?? window.MapShine?.activeLevelContext ?? null,
      force: true,
    });
    try { this._maskBindingController?.invalidate?.(); } catch (_) {}
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
      : 0.4;
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
    // Wider separable blur expands the fire mask before DistortionManager samples it.
    // Heat haze was reading as a hard disk because the pre-blur footprint stayed too tight.
    const blurRadiusBase = 6.5 + (avgSize / 21.0) + (fireRate * 0.32);
    const blurRadius = Math.max(9.0, Math.min(40.0, blurRadiusBase * softnessScale));
    const blurPasses = blurRadius >= 26.0 ? 6 : (blurRadius >= 20.0 ? 5 : (blurRadius >= 14.0 ? 4 : (blurRadius >= 10.0 ? 3 : 2)));
    // Feeds the composite shader's multi-tap fringe; higher = softer map-space falloff.
    const edgeSoftnessTexels = Math.max(2.0, Math.min(120.0, heatEdgeSoftness * 7.2 + blurRadius * 0.38));

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
        edgeSoftnessTexels,
      });
      dist.setSourceEnabled('heat', true);
    } else {
      dist.updateSourceMask('heat', heatMask);
      dist.updateSourceParams('heat', {
        intensity: finalIntensity,
        frequency: heatFrequency,
        speed: heatSpeed,
        edgeSoftnessTexels,
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
   * Wipe Map Shine V2 lighting meshes and rebuild from Foundry; resync specular/iridescence light caches.
   * Console (GM): `await MapShine.rebuildLighting({ repairSceneFlags: true })`
   * @param {{ repairSceneFlags?: boolean, foundryLightingRefresh?: boolean }} [options]
   * @returns {Promise<{ ok: boolean, reason?: string, orphansRemoved?: number }>}
   */
  async rebuildLightingFromFoundry(options = {}) {
    const le = this._lightingEffect;
    if (!le?.forceRebuildFromFoundry) {
      return { ok: false, reason: 'lighting_effect_missing' };
    }
    const out = await le.forceRebuildFromFoundry(options);
    try {
      this._specularEffect?.resyncLightsFromFoundry?.();
    } catch (_) {}
    try {
      this._iridescenceEffect?.resyncLightsFromFoundry?.();
    } catch (_) {}
    return out;
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
    if (this._waterOccluderScratchRT) this._waterOccluderScratchRT.setSize(w, h);
    if (this._waterBgProductRT) this._waterBgProductRT.setSize(w, h);
    if (this._waterBgProductScratchRT) this._waterBgProductScratchRT.setSize(w, h);
    try { this._levelRTPool?.onResize?.(w, h, this.renderer); } catch (_) {}
    // Re-clear global ping-pong RTs so the outer-rect area has a known
    // value after the resize-driven re-allocation.
    try { this._clearGlobalRTsToBlack(); } catch (_) {}
    try { this._shadowManagerEffect?.onResize?.(w, h); } catch (_) {}
    try { this._bushEffect?.onResize?.(w, h); } catch (_) {}
    try { this._treeEffect?.onResize?.(w, h); } catch (_) {}
    this._cloudEffect.onResize(w, h);
    this._lightingEffect.onResize(w, h);
    this._bloomEffect.onResize(w, h);
    try { this._overheadShadowEffect?.onResize?.(w, h); } catch (_) {}
    try { this._buildingShadowEffect?.onResize?.(w, h); } catch (_) {}
    try { this._skyReachShadowEffect?.onResize?.(w, h); } catch (_) {}
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
    try { this._playerLightEffect?.onResize?.(w, h); } catch (_) {}
    try { this._distortionEffect?.onResize?.(w, h); } catch (_) {}
    try { this._floorDepthBlurEffect?.onResize?.(w, h); } catch (_) {}
    try { this._waterSplashesEffect?.syncDrawingBufferSize?.(); } catch (_) {}
    log.debug(`FloorCompositor.onResize: RTs resized to ${w}x${h}`);
  }

  /**
   * Copy viewport / scene-rect uniforms from WaterEffectV2 compose material into
   * the post-merge bg product pass (must run after {@link WaterEffectV2#syncComposeViewportUniforms}).
   * @private
   */
  _syncWaterBgProductUniformsFromWaterCompose() {
    const src = this._waterEffect?._composeMaterial?.uniforms;
    const dst = this._waterBgProductMaterial?.uniforms;
    if (!src || !dst) return;
    try {
      if (src.uViewBounds?.value && dst.uViewBounds?.value) {
        dst.uViewBounds.value.copy(src.uViewBounds.value);
      }
      if (src.uSceneDimensions?.value && dst.uSceneDimensions?.value) {
        dst.uSceneDimensions.value.copy(src.uSceneDimensions.value);
      }
      if (src.uSceneRect?.value && dst.uSceneRect?.value) {
        dst.uSceneRect.value.copy(src.uSceneRect.value);
      }
      if (src.uHasSceneRect && dst.uHasSceneRect) {
        dst.uHasSceneRect.value = src.uHasSceneRect.value;
      }
    } catch (_) {}
  }

  /**
   * Bake transmittance ∏(1 - smoothstep(bg alpha)) into a single fullscreen RT (R channel),
   * two textures per draw to stay under fragment sampler limits in the water shader.
   * @param {Array<import('three').Texture>} stackTextures
   * @returns {import('three').WebGLRenderTarget|null}
   * @private
   */
  _buildWaterBackgroundAlphaMaskRT(stackTextures) {
    const THREE = window.THREE;
    const arr = Array.isArray(stackTextures) ? stackTextures.filter((t) => t) : [];
    if (!THREE || !this.renderer || !arr.length) return null;
    if (!this._waterBgProductRT || !this._waterBgProductScratchRT
      || !this._waterBgProductScene || !this._waterBgProductCamera || !this._waterBgProductMaterial) {
      return null;
    }
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    if (!this._tempColor && THREE) this._tempColor = new THREE.Color();
    const prevColor = renderer.getClearColor(this._tempColor);
    const prevAlpha = renderer.getClearAlpha();
    const mat = this._waterBgProductMaterial.uniforms;
    const dummy = this._waterEffect?._fallbackBlack ?? null;
    const outA = this._waterBgProductRT;
    const outB = this._waterBgProductScratchRT;
    let lastRT = null;
    try {
      for (let i = 0; i < arr.length; i++) {
        const writeRT = (i % 2 === 0) ? outA : outB;
        mat.uHasAccum.value = i > 0 ? 1.0 : 0.0;
        mat.tAccum.value = i > 0 && lastRT ? lastRT.texture : dummy;
        mat.tLayer.value = arr[i];
        renderer.setRenderTarget(writeRT);
        renderer.setClearColor(0x000000, 1);
        renderer.autoClear = true;
        renderer.render(this._waterBgProductScene, this._waterBgProductCamera);
        lastRT = writeRT;
      }
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(prevColor, prevAlpha);
      if (typeof renderer.setClearAlpha === 'function') {
        try { renderer.setClearAlpha(prevAlpha); } catch (_) {}
      }
      renderer.setRenderTarget(prevTarget);
    }
    return lastRT;
  }

  /**
   * @param {number} floorIndex
   * @returns {Set<string>}
   * @private
   */
  _getWaterTileIdsForFloor(floorIndex) {
    const fi = Number(floorIndex);
    if (!Number.isFinite(fi)) return new Set();
    try {
      const ids = this._waterEffect?.getWaterTileIdsForFloor?.(fi);
      if (Array.isArray(ids)) return new Set(ids);
    } catch (_) {}
    return new Set();
  }

  /**
   * Non-_Water tiles on the water-source floor (bridges drawn as normal tiles included).
   * @param {number} floorIndex
   * @param {import('three').WebGLRenderTarget} target
   * @returns {import('three').WebGLRenderTarget|null}
   * @private
   */
  _buildWaterSourceDeckMaskRT(floorIndex, target) {
    const fi = Number(floorIndex);
    if (!Number.isFinite(fi) || fi < 0 || !target) return null;
    if (!this._renderBus || !this.renderer || !this.camera) return null;
    try {
      this._renderBus.renderFloorMaskTo(this.renderer, this.camera, fi, target, {
        sourceFloorDeckMask: true,
        includeRoofCaptureLayers: true,
        preserveCameraLayers: true,
        maxFloorIndex: fi,
        excludeTileIds: this._getWaterTileIdsForFloor(fi),
      });
      return target;
    } catch (_) {
      return null;
    }
  }

  /**
   * sceneRT.a × overhead-only mask — blocks water only where the source floor
   * actually draws opaque coverage (bridge) AND the tile counts as overhead.
   *
   * @param {import('three').WebGLRenderTarget} sceneRT
   * @param {import('three').WebGLRenderTarget} roofRT
   * @returns {import('three').WebGLRenderTarget|null}
   * @private
   */
  _buildWaterSourceOccProductRT(sceneRT, deckRT, outRT) {
    if (!sceneRT?.texture || !deckRT?.texture || !outRT) return null;
    if (!this._waterSourceOccProductScene || !this._waterSourceOccProductCamera
      || !this._waterSourceOccProductMaterial) return null;
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const mat = this._waterSourceOccProductMaterial.uniforms;
    try {
      mat.tScene.value = sceneRT.texture;
      mat.tRoof.value = deckRT.texture;
      mat.uHasRoof.value = 1.0;
      renderer.setRenderTarget(outRT);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.render(this._waterSourceOccProductScene, this._waterSourceOccProductCamera);
      return outRT;
    } catch (_) {
      return null;
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * Screen-space mask: source slice scene alpha × non-water tiles on that floor.
   * Built before upper-floor occluder union so scratch RT is not clobbered.
   *
   * @param {number} floorIndex
   * @param {import('three').WebGLRenderTarget|null} sourceSceneRT
   * @returns {import('three').Texture|null}
   * @private
   */
  /**
   * @param {number} viewedFloorIndex
   * @returns {number}
   * @private
   */
  _resolveWaterSourceFloorForView(viewedFloorIndex) {
    const water = this._waterEffect;
    if (!water?.hasFloorWaterData) return -1;
    const viewed = Number(viewedFloorIndex);
    if (!Number.isFinite(viewed)) return -1;
    let best = -1;
    for (let fi = 0; fi <= viewed; fi++) {
      if (water.hasFloorWaterData(fi)) best = fi;
    }
    return best;
  }

  /**
   * Build deck + slice pair once right after bus prepass so they share the same camera
   * snapshot (avoids one-frame punch mismatch while panning).
   *
   * @param {Array} visibleFloors
   * @param {Array} levelSceneRTs
   * @param {number} viewedFloorIndex
   * @private
   */
  _prepareFrameWaterSourceMask(visibleFloors, levelSceneRTs, viewedFloorIndex) {
    this._frameWaterSourceDeckTex = null;
    this._frameWaterSourceSliceTex = null;
    if (window.MapShine?.__alphaIsolationDebug?.disableWaterSourceDeckMask === true) return;
    if (!resolveEffectEnabled(this._waterEffect) || !this._waterOccluderScratchRT) return;

    const dataFloor = this._resolveWaterSourceFloorForView(viewedFloorIndex);
    if (dataFloor < 0) return;

    const sourceSi = visibleFloors.findIndex((f) => Number(f?.index) === Number(dataFloor));
    if (sourceSi >= 0 && levelSceneRTs[sourceSi]?.texture) {
      this._frameWaterSourceSliceTex = levelSceneRTs[sourceSi].texture;
    }

    try {
      const deckRT = withSceneScissor(this.renderer, () =>
        this._buildWaterSourceDeckMaskRT(dataFloor, this._waterOccluderScratchRT)
      );
      this._frameWaterSourceDeckTex = deckRT?.texture ?? null;
      if (window.MapShine?.__waterDebug) {
        window.MapShine.__waterDebug.lastDeckMask = this._frameWaterSourceDeckTex;
        window.MapShine.__waterDebug.lastSourceFloorIndex = dataFloor;
        window.MapShine.__waterDebug.lastWaterTileIds = [...this._getWaterTileIdsForFloor(dataFloor)];
      }
    } catch (_) {}
  }

  /**
   * @private
   */
  _bindWaterSourceDeckMask() {
    try {
      this._waterEffect?.setOverheadRoofBlockTexture?.(this._frameWaterSourceDeckTex ?? null);
    } catch (_) {}
  }

  /**
   * Build a screen-space upper-floor occluder from authoritative per-level scene RT alpha.
   * Stacks slice alphas bottom→top with straight-alpha source-over (matches
   * `LevelCompositePass`), not per-pixel max — max treated independent decks as
   * simultaneously opaque and hid water through higher-floor holes.
   *
   * @param {Array<THREE.WebGLRenderTarget|null|undefined>} upperSceneRTs
   * @returns {THREE.WebGLRenderTarget|null}
   * @private
   */
  _buildUpperSceneAlphaOccluder(upperSceneRTs) {
    if (!Array.isArray(upperSceneRTs) || upperSceneRTs.length === 0) return null;
    this._tempTextures.length = 0;
    for (let i = 0; i < upperSceneRTs.length; i++) {
      const tex = upperSceneRTs[i]?.texture;
      if (tex) this._tempTextures.push(tex);
    }
    return this._buildUpperSceneAlphaOccluderFromTextures(this._tempTextures);
  }

  /**
   * @param {Array<import('three').Texture>} textures
   * @returns {import('three').WebGLRenderTarget|null}
   * @private
   */
  _buildUpperSceneAlphaOccluderFromTextures(textures) {
    if (!Array.isArray(textures) || textures.length === 0) return null;
    if (!this._waterOccluderRT || !this._waterOccluderScratchRT) return null;
    if (!this._waterOccluderUnionScene || !this._waterOccluderUnionCamera || !this._waterOccluderUnionMaterial) return null;

    const renderer = this.renderer;
    const THREE = window.THREE;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    if (!this._tempColor && THREE) this._tempColor = new THREE.Color();
    const prevColor = renderer.getClearColor(this._tempColor);
    const prevAlpha = renderer.getClearAlpha();

    let readRT = null;
    // First layer writes to scratch so tUpper can safely be a texture already in waterOccluderRT.
    let writeRT = this._waterOccluderScratchRT;
    const mat = this._waterOccluderUnionMaterial;

    try {
      for (const tex of textures) {
        mat.uniforms.tBase.value = readRT ? readRT.texture : null;
        mat.uniforms.uHasBase.value = readRT ? 1.0 : 0.0;
        mat.uniforms.tUpper.value = tex;
        renderer.setRenderTarget(writeRT);
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = true;
        renderer.render(this._waterOccluderUnionScene, this._waterOccluderUnionCamera);
        if (!readRT) {
          readRT = writeRT;
          writeRT = this._waterOccluderScratchRT;
        } else {
          const tmp = readRT;
          readRT = writeRT;
          writeRT = tmp;
        }
      }
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(prevColor, prevAlpha);
      if (typeof renderer.setClearAlpha === 'function') {
        try { renderer.setClearAlpha(prevAlpha); } catch (_) {}
      }
      renderer.setRenderTarget(prevTarget);
    }
    return readRT;
  }

  /**
   * Public occlusion contract for floor-aware effects:
   * returns authored upper-slice alpha occluder texture for `floorIndex`.
   *
   * @param {number} floorIndex
   * @returns {import('three').Texture|null}
   */
  getUpperSceneOccluderTextureForFloorIndex(floorIndex) {
    const fi = Number(floorIndex);
    if (!Number.isFinite(fi)) return null;
    try {
      const diag = window.MapShine?.__v2PerLevelDiag ?? null;
      const visibleFloors = Array.isArray(diag?.visibleFloors) ? diag.visibleFloors : null;
      const levelSceneRTs = Array.isArray(diag?.levelSceneRTs) ? diag.levelSceneRTs : null;
      if (
        !visibleFloors
        || !levelSceneRTs
        || visibleFloors.length !== levelSceneRTs.length
        || visibleFloors.length === 0
      ) return null;
      const li = visibleFloors.findIndex((v) => Number(v) === fi);
      if (li < 0 || li >= visibleFloors.length - 1) return null;
      const rt = this._buildUpperSceneAlphaOccluder(levelSceneRTs.slice(li + 1));
      return rt?.texture ?? null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Mirror lighting shadow textures into WaterEffectV2 so foam/murk/specular
   * sample the same factors as LightingEffectV2.
   * When ShadowManagerV2 is enabled, bind its combined RT to tCombinedShadow
   * (never use cloud-only texture as a false "combined" for foam).
   * @param {object} o
   * @param {THREE.Texture|null} [o.cloudShadowTexLegacy]
   * @param {THREE.Texture|null} [o.buildingShadowTex]
   * @param {THREE.Texture|null} [o.overheadShadowTexLegacy]
   * @private
   */
  _bindWaterShadowUniforms({
    cloudShadowTexLegacy = null,
    buildingShadowTex = null,
    overheadShadowTexLegacy = null,
  } = {}) {
    const water = this._waterEffect;
    if (!water) return;
    const sm = this._shadowManagerEffect;
    const smCombined = (resolveEffectEnabled(sm) && sm?.combinedShadowTexture)
      ? sm.combinedShadowTexture
      : null;
    try {
      if (smCombined) {
        water.setShadowManagerCombinedTexture?.(smCombined);
      } else {
        water.setShadowManagerCombinedTexture?.(null);
      }
      water.setCloudShadowTexture?.(cloudShadowTexLegacy ?? null);
      water.setBuildingShadowTexture?.(buildingShadowTex ?? null);
      water.setOverheadShadowTexture?.(overheadShadowTexLegacy ?? null);
    } catch (_) {}
  }

  // ── Per-Level RT Pipeline ──────────────────────────────────────────────────

  /**
   * Renders each visible level independently, applies the full effect chain
   * per level, then composites them bottom→top using upper-level alpha.
   *
   * @param {Object} ctx - Shared render context from the main render() method.
   * @returns {THREE.WebGLRenderTarget|null} The final composited RT, or null on failure.
   * @private
   */
  _renderPerLevelPipeline(ctx) {
    const {
      _profiling,
      _dbgStages,
      _skipWaterPass,
      _alphaIsoDebug,
      cloudShadowTexLegacy,
      cloudShadowRawTexLegacy,
      combinedShadowTex,
      combinedShadowRawTex,
      paintedShadowLitTex,
      paintedShadowMgrOpacity,
      buildingShadowTex,
      buildingShadowTexForLighting = buildingShadowTex,
      buildingShadowOpacity,
      overheadShadowTexLegacy,
      overheadRoofAlphaTex,
      overheadRoofBlockTex,
      ceilingTransmittanceTex,
      overheadRoofRestrictLightTex,
      windowCloudShadowViewBounds,
    } = ctx;
    let _profileT0 = 0;

    // Collect visible levels bottom→top.
    const floorStack = window.MapShine?.floorStack;
    const visibleFloors = floorStack?.getVisibleFloors?.() ?? [];
    if (!visibleFloors.length) return null;
    const usePostMergeWater = visibleFloors.length > 1;
    const dbgWaterOcc = _alphaIsoDebug?.disableWaterOccluder;
    const _disableWaterOccluder = dbgWaterOcc === true;
    const floorsByIndex = new Map(
      (floorStack?.getFloors?.() ?? []).map((f) => [Number(f?.index), f]),
    );
    const resolveWaterOutdoorsForFloor = (floorIndex) => {
      try {
        const idx = Number(floorIndex);
        if (!Number.isFinite(idx)) return null;
        const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
        const floor = floorsByIndex.get(idx) ?? null;
        const floorKey = floor?.compositorKey ?? null;
        if (compositor && floorKey) {
          return (
            compositor.getFloorTexture?.(floorKey, 'skyReach')
            ?? compositor.getFloorTexture?.(floorKey, 'outdoors')
            ?? null
          );
        }
      } catch (_) {}
      return null;
    };

    if (_dbgStages) { try { log.info(`[V2 PerLevel] rendering ${visibleFloors.length} level(s)`); } catch (_) {} }

    // Hint for bus per-level prepass: enables stacked fire visibility (`fi <= slice L`).
    // Value must be a finite number (we use the active top index); semantics are in FloorRenderBus.
    const topVisibleFloorIndexForFire = Number(visibleFloors[visibleFloors.length - 1]?.index ?? 0);

    // Track which level indices are active so we can release stale pool entries.
    const activeLevels = new Set();
    const levelFinalRTs = [];
    // Parallel array of raw sceneRTs (post-`renderFloorRangeTo`, pre-any-pass).
    // Used by the rebind pass below and exposed via diag for dumpLevelRTs().
    const levelSceneRTs = [];
    /** @type {Array<{floor:any, levelIndex:number, rts:any}>} */
    const perLevelEntries = [];

    // Prepass: render raw sceneRT for every visible level first. This makes
    // authored alpha for upper levels available when building water occluders
    // for lower levels in the post chain.
    for (let li = 0; li < visibleFloors.length; li++) {
      const floor = visibleFloors[li];
      const levelIndex = Number(floor?.index ?? li);
      activeLevels.add(levelIndex);
      // Pass renderer so newly allocated pool RTs are pre-cleared to
      // opaque black. This guarantees the outer-rect area (untouched by
      // every scissored pass below) has a known value when bloom samples
      // its input RT at full UV.
      const rts = this._levelRTPool.acquire(levelIndex, this.renderer);
      if (!rts) continue;
      perLevelEntries.push({ floor, levelIndex, rts });
      const { sceneRT: levelSceneRT } = rts;
      if (_profiling) _profileT0 = performance.now();
      // Scissor to inner sceneRect: skip rasterization of bus tiles +
      // overlay particles in the padded zone / outer black region. The
      // scissored clear leaves the area outside the rect at whatever the
      // pool RT was previously cleared to (black/0 alpha — see plan
      // section 4 'Per-level RTs are full-screen-sized').
      withSceneScissor(this.renderer, () => {
        this._renderBus.renderFloorRangeTo(
          this.renderer, this.camera,
          levelIndex, levelIndex,
          levelSceneRT,
          {
            includeBackground: true,
            filterBackgroundByFloor: true,
            clearBeforeRender: true,
            clearAlpha: 0,
            clearColor: 0x000000,
            topVisibleFloorIndexForFire,
          },
        );
      });
      if (_profiling) this._recordPassTiming(`perLevel_busRender_${levelIndex}`, _profileT0);
      levelSceneRTs.push(levelSceneRT);
    }

    const viewedFloorIdx = Number(floorStack?.getActiveFloor?.()?.index ?? 0);
    this._prepareFrameWaterSourceMask(visibleFloors, levelSceneRTs, viewedFloorIdx);

    let windowLightBufW = 1;
    let windowLightBufH = 1;
    try {
      if (this.renderer && this._sizeVec && typeof this.renderer.getDrawingBufferSize === 'function') {
        this.renderer.getDrawingBufferSize(this._sizeVec);
        windowLightBufW = Math.max(1, Math.floor(this._sizeVec.x));
        windowLightBufH = Math.max(1, Math.floor(this._sizeVec.y));
      }
    } catch (_) {}

    for (let li = 0; li < perLevelEntries.length; li++) {
      const { levelIndex, rts } = perLevelEntries[li];
      const { sceneRT: levelSceneRT, postA: levelPostA, postB: levelPostB } = rts;

      // ── Post-processing chain for this level ───────────────────────────
      // Every effect call below renders into a pool RT (`levelPostA` /
      // `levelPostB`) wrapped in withSceneScissor, so the GPU only
      // rasterizes fragments inside the inner sceneRect. The area outside
      // the rect retains its prior contents on these RTs; the final blit
      // to screen is also scissored so those outer pixels are never
      // sampled (see _blitToScreen).
      let currentInput = levelSceneRT;

      // Lighting pass
      if (resolveEffectEnabled(this._lightingEffect)) {
        if (_profiling) _profileT0 = performance.now();
        this._windowLightEffect?.setRenderFloorIndex?.(levelIndex);
        const winScene = resolveEffectEnabled(this._windowLightEffect)
          ? this._windowLightEffect._scene : null;
        const shadowW = Number(combinedShadowRawTex?.image?.width) || levelSceneRT.width || 1;
        const shadowH = Number(combinedShadowRawTex?.image?.height) || levelSceneRT.height || 1;
        this._windowLightEffect?.setCloudShadowTexture?.(combinedShadowRawTex, shadowW, shadowH, windowCloudShadowViewBounds);
        this._windowLightEffect?.setOverheadRoofAlphaTexture?.(overheadRoofAlphaTex, windowLightBufW, windowLightBufH);
        this._windowLightEffect?.setCeilingTransmittanceTexture?.(ceilingTransmittanceTex);
        this._windowLightEffect?.syncFrameOcclusion?.(this);

        try {
          this._lightingEffect?.setRenderFloorIndexForLights?.(levelIndex);
        } catch (_) {}

        let outdoorsForLightingTex = null;
        try {
          const lightingCtx = window.MapShine?.activeLevelContext ?? null;
          outdoorsForLightingTex = this._resolveOutdoorsMask(lightingCtx, { allowWeatherRoofMap: false }).texture ?? null;
          if (!outdoorsForLightingTex) {
            const floorCount = (floorStack?.getFloors?.() ?? []).length;
            if (floorCount > 1) outdoorsForLightingTex = this._getNeutralOutdoorsTexture();
          }
        } catch (_) {}

        // Lighting composes screen-space occlusion/window terms using gl_FragCoord.
        // Keep this pass unscissored so elevated/parallax overhead pixels outside the
        // ground-projected scene rect still receive correct scene lighting.
        this._profileEffectCall('lighting', 'render', () => {
          withoutSceneScissor(this.renderer, () => {
            this._lightingEffect.render(
              this.renderer, this.camera,
              currentInput, levelPostA,
              winScene,
              cloudShadowTexLegacy, cloudShadowRawTexLegacy,
              buildingShadowTexForLighting, overheadShadowTexLegacy,
              buildingShadowOpacity,
              overheadRoofAlphaTex, overheadRoofBlockTex,
              outdoorsForLightingTex,
              ceilingTransmittanceTex,
              overheadRoofRestrictLightTex,
              combinedShadowTex, combinedShadowRawTex,
              paintedShadowLitTex, paintedShadowMgrOpacity,
            );
          });
        }, 'LightingEffectV2 render');
        if (_profiling) this._recordPassTiming(`perLevel_lighting_${levelIndex}`, _profileT0);
        currentInput = levelPostA;
      }

      // Sky color grading
      if (resolveEffectEnabled(this._skyColorEffect)) {
        const skyOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        const lightingForSky = resolveEffectEnabled(this._lightingEffect) ? this._lightingEffect : null;
        this._skyColorEffect?.setIlluminationMasks?.(
          lightingForSky?.dynamicLightTexture ?? null,
          lightingForSky?.windowLightTexture ?? null,
        );
        this._profileEffectCall('skyColor', 'render', () => {
          withSceneScissor(this.renderer, () => {
            this._skyColorEffect.render(this.renderer, currentInput, skyOut);
          });
        }, 'SkyColorEffectV2 render');
        currentInput = skyOut;
      }

      // Filter (before water: refracted samples include filter; avoids an extra pass)
      if (resolveEffectEnabled(this._filterEffect)) {
        const fOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        this._profileEffectCall('filter', 'render', () => {
          withSceneScissor(this.renderer, () => {
            this._filterEffect.render(this.renderer, currentInput, fOut);
          });
        }, 'FilterEffectV2 render');
        currentInput = fOut;
      }

      // Water pass — per-level only when a single floor is visible (bloom MRT path).
      // Multi-floor: one water pass after LevelCompositePass on the merged RT.
      let _waterPassWrote = false;
      if (!usePostMergeWater && !_skipWaterPass && resolveEffectEnabled(this._waterEffect)) {
        let waterDataFloorIndex = levelIndex;
        try {
          // Set per-level water context so the shader uses this level's mask data
          const resolvedDataFloor = this._waterEffect.setLevelContext?.(levelIndex);
          if (Number.isFinite(Number(resolvedDataFloor))) {
            waterDataFloorIndex = Number(resolvedDataFloor);
          }
        } catch (_) {}
        try {
          // Mirror V3 overlay floor-binding semantics:
          // bind outdoors per rendered level (skyReach-first), and when this
          // slice borrows lower-floor water data bind that lower floor's mask.
          const perLevelWaterOutdoors = resolveWaterOutdoorsForFloor(waterDataFloorIndex);
          if (perLevelWaterOutdoors) {
            this._waterEffect.setOutdoorsMask?.(perLevelWaterOutdoors);
          } else if (visibleFloors.length > 1) {
            this._waterEffect.setOutdoorsMask?.(this._getNeutralOutdoorsTexture());
          }
        } catch (_) {}

        // Upper-slice sceneRT alpha only; same-floor overhead uses input scene alpha in shader.
        let waterOccluder = null;
        if (!_disableWaterOccluder && li < visibleFloors.length - 1 && this._waterOccluderRT) {
          try {
            waterOccluder = withSceneScissor(this.renderer, () =>
              this._buildUpperSceneAlphaOccluder(levelSceneRTs.slice(li + 1))
            );
          } catch (_) {
            waterOccluder = null;
          }
        }

        const waterOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        const nativeSourceWater = Number(waterDataFloorIndex) === Number(levelIndex);
        if (_profiling) _profileT0 = performance.now();
        this._bindWaterShadowUniforms({
          cloudShadowTexLegacy,
          buildingShadowTex,
          overheadShadowTexLegacy,
        });
        this._profileEffectCall('water', 'render', () => {
          try {
            if (nativeSourceWater) {
              this._bindWaterSourceDeckMask();
            }
            _waterPassWrote = withSceneScissor(this.renderer, () =>
              this._waterEffect.render(
                this.renderer,
                this.camera,
                currentInput,
                waterOut,
                waterOccluder,
                this._frameWaterSourceSliceTex ?? levelSceneRT?.texture ?? null,
              )
            );
          } finally {
            try { this._waterEffect?.setOverheadRoofBlockTexture?.(null); } catch (_) {}
          }
        }, 'WaterEffectV2 render');
        if (_profiling) this._recordPassTiming(`perLevel_water_${levelIndex}`, _profileT0);
        if (_waterPassWrote) currentInput = waterOut;
      } else if (usePostMergeWater) {
        try { this._bloomEffect?.setWaterSpecularBloomTexture?.(null); } catch (_) {}
      }

      // Feed water specular bloom texture (only meaningful from the last level that had water)
      try {
        const wt = (!usePostMergeWater && _waterPassWrote && typeof this._waterEffect?.getWaterSpecularBloomTexture === 'function')
          ? this._waterEffect.getWaterSpecularBloomTexture() : null;
        this._bloomEffect?.setWaterSpecularBloomTexture?.(wt ?? null);
      } catch (_) {}

      // User color correction after water so foam/spec/tint are graded with the scene (no extra pass).
      if (resolveEffectEnabled(this._colorCorrectionEffect)) {
        const ccOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        this._profileEffectCall('colorCorrection', 'render', () => {
          withSceneScissor(this.renderer, () => {
            this._colorCorrectionEffect.render(this.renderer, currentInput, ccOut);
          });
        }, 'ColorCorrectionEffectV2 render');
        currentInput = ccOut;
      }

      // Distortion (fire heat haze): skipped per-level because aux-pass
      // caching in DistortionManager assumes one render per frame. Applied
      // once globally after composite in the late pass section.

      // Atmospheric fog
      if (resolveEffectEnabled(this._atmosphericFogEffect)) {
        const fogOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        let fogWrote = false;
        this._profileEffectCall('atmosphericFog', 'render', () => {
          fogWrote = withSceneScissor(this.renderer, () =>
            this._atmosphericFogEffect.render(this.renderer, this.camera, currentInput, fogOut)
          );
        }, 'AtmosphericFogEffectV2 render');
        if (fogWrote) currentInput = fogOut;
      }

      // Bloom — intentionally NOT scissored. UnrealBloomPass internally
      // binds a mip pyramid of progressively smaller render targets;
      // a screen-space scissor rect would be wrong for those sub-RTs
      // (and likely degenerate at the smallest mips). Profile separately
      // before introducing per-mip scissor support.
      if (resolveEffectEnabled(this._bloomEffect)) {
        const bloomOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        this._profileEffectCall('bloom', 'render', () => {
          this._bloomEffect.render(this.renderer, currentInput, bloomOut);
        }, 'BloomEffectV2 render');
        currentInput = bloomOut;
      }

      // Sharpen
      if (resolveEffectEnabled(this._sharpenEffect)) {
        const shOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        this._profileEffectCall('sharpen', 'render', () => {
          withSceneScissor(this.renderer, () => {
            this._sharpenEffect.render(this.renderer, currentInput, shOut);
          });
        }, 'SharpenEffectV2 render');
        currentInput = shOut;
      }

      // Artistic post-processing — use resolveEffectEnabled (instance + params)
      // so registry/UI cannot disagree with FilterEffectV2-style gating.
      if (resolveEffectEnabled(this._dotScreenEffect)) {
        const dsOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        let wrote = false;
        this._profileEffectCall('dotScreen', 'render', () => {
          wrote = withSceneScissor(this.renderer, () =>
            this._dotScreenEffect.render(this.renderer, this.camera, currentInput, dsOut)
          );
        }, 'DotScreenEffectV2 render');
        if (wrote) currentInput = dsOut;
      }
      if (resolveEffectEnabled(this._halftoneEffect)) {
        const htOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        let wrote = false;
        this._profileEffectCall('halftone', 'render', () => {
          wrote = withSceneScissor(this.renderer, () =>
            this._halftoneEffect.render(this.renderer, this.camera, currentInput, htOut)
          );
        }, 'HalftoneEffectV2 render');
        if (wrote) currentInput = htOut;
      }
      if (resolveEffectEnabled(this._asciiEffect)) {
        const ascOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        let wrote = false;
        this._profileEffectCall('ascii', 'render', () => {
          wrote = withSceneScissor(this.renderer, () =>
            this._asciiEffect.render(this.renderer, this.camera, currentInput, ascOut)
          );
        }, 'AsciiEffectV2 render');
        if (wrote) currentInput = ascOut;
      }
      if (resolveEffectEnabled(this._dazzleOverlayEffect)) {
        const dzOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        let wrote = false;
        this._profileEffectCall('dazzleOverlay', 'render', () => {
          wrote = withSceneScissor(this.renderer, () =>
            this._dazzleOverlayEffect.render(this.renderer, this.camera, currentInput, dzOut)
          );
        }, 'DazzleOverlayEffectV2 render');
        if (wrote) currentInput = dzOut;
      }
      if (resolveEffectEnabled(this._visionModeEffect)) {
        const vmOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        let wrote = false;
        this._profileEffectCall('visionMode', 'render', () => {
          wrote = withSceneScissor(this.renderer, () =>
            this._visionModeEffect.render(this.renderer, this.camera, currentInput, vmOut)
          );
        }, 'VisionModeEffectV2 render');
        if (wrote) currentInput = vmOut;
      }
      if (resolveEffectEnabled(this._invertEffect)) {
        const invOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        let wrote = false;
        this._profileEffectCall('invert', 'render', () => {
          wrote = withSceneScissor(this.renderer, () =>
            this._invertEffect.render(this.renderer, this.camera, currentInput, invOut)
          );
        }, 'InvertEffectV2 render');
        if (wrote) currentInput = invOut;
      }
      if (resolveEffectEnabled(this._sepiaEffect)) {
        const sepOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
        let wrote = false;
        this._profileEffectCall('sepia', 'render', () => {
          wrote = withSceneScissor(this.renderer, () =>
            this._sepiaEffect.render(this.renderer, this.camera, currentInput, sepOut)
          );
        }, 'SepiaEffectV2 render');
        if (wrote) currentInput = sepOut;
      }

      // ── Authoritative alpha rebind ─────────────────────────────────────
      // Clamp the post-chain RT's alpha to the raw sceneRT alpha. The
      // sceneRT was just drawn by `renderFloorRangeTo` with
      // `clearAlpha: 0` and preserves authored texture alpha (tiles +
      // `__bg_image__*`), so its alpha channel is the authoritative
      // per-floor solidity mask. Clamping guarantees that pixels the
      // floor author marked transparent (WebP alpha=0 holes) stay
      // transparent on the level final RT even if a downstream pass
      // widened alpha (water is the main culprit: `waterOutA = max(base.a, inside)`).
      //
      // Net result for the multi-level sandwich:
      //   - Upper floor RT alpha == authored upper albedo alpha
      //     (verified by `debug.dumpLevelRTs()` showing checkerboard
      //     wherever the source WebP is transparent).
      //   - LevelCompositePass source-over reveals the ground RT (and
      //     any ground-floor effects like water) through every authored
      //     hole, not just where both RGB and alpha were carved.
      // Always run alpha rebind so effect alpha cannot accidentally flatten
      // authored holes and mask lower floors.
      if (_profiling) _profileT0 = performance.now();
      const rebindOut = (currentInput === levelPostA) ? levelPostB : levelPostA;
      let rebound = false;
      this._profileEffectCall('levelAlphaRebind', 'render', () => {
        rebound = withSceneScissor(this.renderer, () =>
          this._levelAlphaRebindPass.render(
            this.renderer,
            currentInput,
            levelSceneRT,
            rebindOut,
            { allowAlphaWiden: _waterPassWrote === true },
          )
        );
      }, 'LevelAlphaRebindPass render');
      if (_profiling) this._recordPassTiming(`perLevel_alphaRebind_${levelIndex}`, _profileT0);
      if (rebound) currentInput = rebindOut;

      levelFinalRTs.push(currentInput);

      // Restore water to global state after this level's pass
      try { this._waterEffect?.clearLevelContext?.(); } catch (_) {}
    }
    this._windowLightEffect?.setRenderFloorIndex?.(null);
    try {
      this._lightingEffect?.setRenderFloorIndexForLights?.(null);
    } catch (_) {}

    // Release pool entries for levels no longer visible.
    this._levelRTPool.releaseStale(activeLevels);

    if (!levelFinalRTs.length) return null;

    // ── Composite all level RTs bottom→top ─────────────────────────────────
    if (_profiling) _profileT0 = performance.now();

    // Use the compositor's own _postA as the composite output, _postB as scratch.
    // Bottom→top straight-alpha source-over: each `levelFinalRTs[i]` carries
    // that floor's content with alpha preserved; `composite` handles 1, 2, and
    // 3+ levels correctly (iterative ping-pong for 3+).
    withSceneScissor(this.renderer, () => {
      this._levelCompositePass.composite(
        this.renderer,
        levelFinalRTs,
        this._postA,
        this._postB,
      );
    });
    if (_profiling) this._recordPassTiming('perLevel_composite', _profileT0);

    /** Merged composite lives in `_postA`; post-merge water may write `_postB`. */
    let mergedCompositeOut = this._postA;
    // Post-merge water composites onto an already user–CC'd merge (CC ran per slice before
    // composite). Procedural water sits on top without a second CC pass — rare vs single-floor.
    if (usePostMergeWater && !_skipWaterPass && resolveEffectEnabled(this._waterEffect)) {
      const activeFloor = floorStack?.getActiveFloor?.();
      const ai = Number.isFinite(Number(activeFloor?.index))
        ? Number(activeFloor.index)
        : 0;
      let dataFloor = -1;
      try {
        dataFloor = typeof this._waterEffect.setPostMergeWaterContext === 'function'
          ? Number(this._waterEffect.setPostMergeWaterContext(ai))
          : -1;
      } catch (_) {
        dataFloor = -1;
      }
      try {
        const perLevelWaterOutdoors = resolveWaterOutdoorsForFloor(
          Number.isFinite(dataFloor) && dataFloor >= 0 ? dataFloor : ai,
        );
        if (perLevelWaterOutdoors) {
          this._waterEffect.setOutdoorsMask?.(perLevelWaterOutdoors);
        } else {
          this._waterEffect.setOutdoorsMask?.(this._getNeutralOutdoorsTexture());
        }
      } catch (_) {}
      // Post-merge: punch water with every bus background **between** the water
      // data floor (e.g. ground) and the viewer — e.g. levels 1+2 when source is 0
      // and you stand on the roof. Resolve each slice by FloorBand.index first,
      // then stack index j as fallback.
      let postMergeWaterOccluder = null;
      try {
        const bus = this._renderBus;
        let sourceSi = visibleFloors.findIndex(
          (f) => Number(f?.index) === Number(dataFloor),
        );
        if (sourceSi < 0) {
          // Water source below the lowest visible slice: mask the whole visible stack.
          sourceSi = -1;
        }
        if (!_disableWaterOccluder && sourceSi < visibleFloors.length - 1 && this._waterOccluderRT) {
          try {
            postMergeWaterOccluder = withSceneScissor(this.renderer, () =>
              this._buildUpperSceneAlphaOccluder(levelSceneRTs.slice(sourceSi + 1))
            );
          } catch (_) {
            postMergeWaterOccluder = null;
          }
        }
        const stackTex = [];
        for (let j = sourceSi + 1; j < visibleFloors.length; j++) {
          const li = Number(visibleFloors[j]?.index);
          let t = null;
          if (Number.isFinite(li) && typeof bus?.getBackgroundImageMapForFloorIndex === 'function') {
            t = bus.getBackgroundImageMapForFloorIndex(li);
          }
          if (!t && typeof bus?.getBackgroundImageMapForStackIndex === 'function') {
            t = bus.getBackgroundImageMapForStackIndex(j);
          }
          if (t) stackTex.push(t);
        }
        const layers = stackTex.slice(0, 8);
        let maskRt = null;
        if (layers.length) {
          try {
            this._waterEffect.syncComposeViewportUniforms?.(this.renderer, this.camera);
          } catch (_) {}
          this._syncWaterBgProductUniformsFromWaterCompose();
          maskRt = withSceneScissor(this.renderer, () =>
            this._buildWaterBackgroundAlphaMaskRT(layers)
          );
        }
        this._waterEffect.setWaterBackgroundAlphaMaskTexture?.(
          maskRt?.texture ?? null,
        );
      } catch (_) {}
      let postMergeWaterWrote = false;
      if (_profiling) _profileT0 = performance.now();
      this._profileEffectCall('water', 'render', () => {
        try {
          this._bindWaterShadowUniforms({
            cloudShadowTexLegacy,
            buildingShadowTex,
            overheadShadowTexLegacy,
          });
          this._bindWaterSourceDeckMask();
          postMergeWaterWrote = withSceneScissor(this.renderer, () =>
            this._waterEffect.render(
              this.renderer,
              this.camera,
              this._postA,
              this._postB,
              postMergeWaterOccluder,
              this._frameWaterSourceSliceTex,
            )
          );
        } catch (_) {
          postMergeWaterWrote = false;
        } finally {
          try { this._waterEffect.setWaterBackgroundAlphaMaskTexture?.(null); } catch (_) {}
        }
      }, 'WaterEffectV2 postMerge render');
      if (_profiling) this._recordPassTiming('postMerge_water', _profileT0);
      if (postMergeWaterWrote) mergedCompositeOut = this._postB;
      try { this._bloomEffect?.setWaterSpecularBloomTexture?.(null); } catch (_) {}
      try { this._waterEffect?.clearLevelContext?.(); } catch (_) {}
    }

    // Expose per-level diagnostics on MapShine for console inspection
    try {
      if (window.MapShine) {
        window.MapShine.__v2PerLevelDiag = {
          levelCount: visibleFloors.length,
          rtPoolAllocated: this._levelRTPool.allocatedCount,
          levelIndices: [...activeLevels],
          // Live RT refs so debug probes (levelAlphaProbe, dumpLevelRTs) can
          // read back per-level alpha without reaching into private state.
          // `visibleFloors[i]` is the floor index for `levelFinalRTs[i]`.
          visibleFloors: visibleFloors.slice(),
          // Post-chain, alpha-rebound output for each level. This is the
          // RT that LevelCompositePass actually reads from.
          levelFinalRTs: levelFinalRTs.slice(),
          // Raw sceneRT for each level — the direct output of
          // `renderFloorRangeTo`, before any post-pass. Carries the
          // authored content alpha (the authoritative per-floor solidity
          // mask) and is consumed by `_levelAlphaRebindPass`. Useful for
          // isolating draw-time alpha loss vs. post-pass widening in
          // `dumpLevelRTs()` / `levelAlphaProbe()`.
          levelSceneRTs: levelSceneRTs.slice(),
          // Shared upper-floor water occluder RT (tile-only alpha union of
          // floors above the currently-rendering level). `null` on single-floor
          // scenes or before a frame has been composed.
          waterOccluderRT: this._waterOccluderRT ?? null,
        };
      }
    } catch (_) {}

    if (_dbgStages) { try { log.info('[V2 PerLevel] composite complete'); } catch (_) {} }

    return mergedCompositeOut;
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
    try { this._ashDisturbanceEffect?.dispose?.(); } catch (_) {}
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
    try { this._skyReachShadowEffect?.dispose?.(); } catch (_) {}
    try { this._paintedShadowEffect?.dispose?.(); } catch (_) {}
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
    try { this._replicaOcclusionMaskPass?.dispose?.(); } catch (_) {}
    this._replicaOcclusionMaskPass = null;
    try { this._renderBus?.dispose?.(); } catch (_) {}
    this._busPopulated = false;
    this._populateComplete = false;
    this._populatePromise = null;
    this._frameWaterSourceDeckTex = null;
    this._frameWaterSourceSliceTex = null;

    // Dispose render targets.
    try { this._sceneRT?.dispose(); } catch (_) {}
    try { this._postA?.dispose(); } catch (_) {}
    try { this._postB?.dispose(); } catch (_) {}
    try { this._waterOccluderRT?.dispose(); } catch (_) {}
    try { this._waterOccluderScratchRT?.dispose(); } catch (_) {}
    try { this._waterBgProductRT?.dispose(); } catch (_) {}
    try { this._waterBgProductScratchRT?.dispose(); } catch (_) {}
    try { this._levelRTPool?.dispose(); } catch (_) {}
    try { this._levelCompositePass?.dispose(); } catch (_) {}
    try { this._levelAlphaRebindPass?.dispose(); } catch (_) {}
    this._sceneRT = null;
    this._postA = null;
    this._postB = null;
    this._waterOccluderRT = null;
    this._waterOccluderScratchRT = null;
    this._waterBgProductRT = null;
    this._waterBgProductScratchRT = null;
    try { this._waterOccluderUnionMaterial?.dispose?.(); } catch (_) {}
    try { this._waterOccluderUnionQuad?.geometry?.dispose?.(); } catch (_) {}
    this._waterOccluderUnionScene = null;
    this._waterOccluderUnionCamera = null;
    this._waterOccluderUnionMaterial = null;
    this._waterOccluderUnionQuad = null;
    try { this._waterSourceOccProductMaterial?.dispose?.(); } catch (_) {}
    try { this._waterSourceOccProductQuad?.geometry?.dispose?.(); } catch (_) {}
    this._waterSourceOccProductScene = null;
    this._waterSourceOccProductCamera = null;
    this._waterSourceOccProductMaterial = null;
    this._waterSourceOccProductQuad = null;
    try { this._waterBgProductMaterial?.dispose?.(); } catch (_) {}
    try { this._waterBgProductQuad?.geometry?.dispose?.(); } catch (_) {}
    this._waterBgProductScene = null;
    this._waterBgProductCamera = null;
    this._waterBgProductMaterial = null;
    this._waterBgProductQuad = null;

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
    try { this._neutralOutdoorsTexture?.dispose?.(); } catch (_) {}
    this._neutralOutdoorsTexture = null;

    this._initialized = false;
    log.info('FloorCompositor disposed');
  }
}
