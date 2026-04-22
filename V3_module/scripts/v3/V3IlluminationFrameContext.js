/**
 * @fileoverview Per-frame illumination inputs for the V3 illumination pipeline.
 *
 * Read-only snapshot built by {@link V3ThreeSceneHost} each tick and consumed
 * by {@link V3IlluminationPipeline} plus its registered terms. Centralizing
 * inputs here guarantees every term sees the **same** Foundry darkness, the
 * **same** map-UV transform, and the **same** mask lookups. Prior ad-hoc
 * reads (each effect re-deriving darkness or flip conventions) were the main
 * source of illumination drift between passes.
 */

/**
 * @typedef {import("../vendor/three.module.js").Texture} ThreeTexture
 */

export class V3IlluminationFrameContext {
  constructor() {
    /** Foundry scene darkness 0..1 (0 = day, 1 = night). */
    this.sceneDarkness01 = 0;
    /**
     * Linear RGB tint applied at full darkness (Foundry `ambientDarkness`, default ~#303030).
     * Night multiplies lit ambient toward this tint instead of to black.
     */
    this.darknessTintLinear = [0.033, 0.033, 0.033];
    /** If false, the host is overriding darkness with a manual slider. */
    this.usingSceneDarkness = true;
    /** Viewed Levels floor key; terms use this for per-floor mask lookups. */
    this.floorKey = "floor0";
    /** Drawing-buffer resolution in pixels. */
    this.resolutionPx = [1, 1];
    /** Map UV transform (matches the sandwich compositor). */
    this.pivotWorld = [0, 0];
    this.invScale = 1;
    this.sceneRect = [0, 0, 1, 1];
    /** Whether background textures are flipped vertically (Foundry convention). */
    this.flipBackgroundTextureY = true;
    /**
     * Mask textures resolved for this frame (viewed-floor scoped).
     * Keys are mask ids (`skyReach`, `outdoors`, ...); values may be null.
     * @type {Map<string, ThreeTexture|null>}
     */
    this.masks = new Map();

    /**
     * Foundry ambient lights as world-space radial samples for the illumination
     * resolve pass (see {@link V3IlluminationPipeline} `uFl*` uniforms). Filled
     * each frame by {@link V3ThreeSceneHost}; capped in the shader (8).
     * @type {Array<{ wx: number, wy: number, inner: number, outer: number, color: [number, number, number], hasColor: boolean, colorationAlpha: number, attenuation: number, coloration: number, luminosity: number, contrast: number, saturation: number, shadows: number, angleDeg: number, rotationDeg: number, priority: number, polygon?: number[] }>}
     */
    this.foundryRadialLights = [];

    /**
     * Lights scoped to the floor **adjacent** to the viewed one (either one
     * level up or one level down) in a stacked scene. Composited like
     * {@link V3WaterOverlay}: visibility scales by `(1 − upperAlbedoAlpha)`
     * so lamps authored on the non-viewed floor show through holes in the
     * viewed-floor albedo. The bucket is bidirectional — same uniform set
     * covers both "lamp below, viewer above" and "lamp above, viewer below".
     * @type {Array<{ wx: number, wy: number, inner: number, outer: number, color: [number, number, number], hasColor: boolean, colorationAlpha: number, attenuation: number, coloration: number, luminosity: number, contrast: number, saturation: number, shadows: number, angleDeg: number, rotationDeg: number, priority: number, polygon?: number[] }>}
     */
    this.foundryRadialLightsAdjacentFloor = [];

    /**
     * Diagnostic-only mirror of the viewed floor index used when buckets were
     * filled. `-1` means single-level scene. Surfaced via {@link snapshot} so
     * `V3Shine.diag()` can show it without poking at private shader uniforms.
     */
    this.viewedFloorIndex = 0;
    /**
     * Diagnostic-only mirror of the adjacent floor index used when populating
     * the through-floor bucket. `-1` if no adjacent floor exists.
     */
    this.adjacentFloorIndex = -1;
    /**
     * Diagnostic-only mirror of the matte apply flag the pipeline will receive
     * (`0` = albedo matte bypassed, `1` = matte active).
     */
    this.adjacentFloorMatteApply = 0;
    /**
     * Diagnostic-only mirror of whether an upper albedo texture was available
     * when the bucket was populated (`true` means the shader will sample
     * `uUpperAlbedoMatte`, `false` means the 1×1 fallback is in use).
     */
    this.adjacentFloorHasUpperTexture = false;

    /**
     * Scales summed Foundry-style light contribution before add into base (default 0.38).
     * @type {number}
     */
    this.foundryLightAddScale = 0.5;
    /** Outer (dim radius) radial falloff intensity in the light stamp. */
    this.foundryLightDimRadiusStrength = 0.7;
    /** Inner (bright radius) radial falloff intensity in the light stamp. */
    this.foundryLightBrightRadiusStrength = 4.0;
    /** Scales neutral illumination derived from the light buffer intensity. */
    /** Matches v13 LightingEffectV2 default `lightIntensity` (0.25). */
    this.foundryLightIlluminationStrength = 0.25;
    /** Matches v13 LightingEffectV2 default `colorationStrength` (1.0). */
    this.foundryLightColorationStrength = 1.0;
    /** 0 = color ignores surface reflection, 1 = fully reflection-weighted. */
    this.foundryLightColorationReflectivity = 1.0;
    /** Extra saturation applied to the light buffer before coloration extraction. */
    this.foundryLightColorationSaturation = 1.0;
    /** Extra saturation applied to the lit ground under light influence. */
    this.foundryLightGroundSaturation = 0;
    /** Extra contrast applied to the lit ground under light influence. */
    this.foundryLightGroundContrast = -0.2;

    /** Final scene grading applied after lighting, before output encode. */
    this.sceneColorGradeEnabled = true;
    this.sceneGradeExposure = 1.0;
    this.sceneGradeTemperature = 0.0;
    this.sceneGradeTint = 0.0;
    this.sceneGradeBrightness = 0.0;
    this.sceneGradeContrast = 0.995;
    this.sceneGradeSaturation = 1.4;
    this.sceneGradeVibrance = 0.0;
    this.sceneGradeLift = [0, 0, 0];
    this.sceneGradeGamma = [1, 1, 1];
    this.sceneGradeGain = [1, 1, 1];
    this.sceneGradeMasterGamma = 1.05;
    this.sceneGradeToneMapping = 0;

    /** Token-only color grading (masked by token deck alpha). */
    this.tokenColorGradeEnabled = true;
    this.tokenGradeExposure = 0.9;
    this.tokenGradeTemperature = 0.0;
    this.tokenGradeTint = 0.0;
    this.tokenGradeBrightness = 0.0;
    this.tokenGradeContrast = 1.0;
    this.tokenGradeSaturation = 1.25;
    this.tokenGradeVibrance = 0.0;
    this.tokenGradeAmount = 1.0;
  }

  /**
   * Backcompat alias for {@link foundryRadialLightsAdjacentFloor}. One-release
   * bridge so external consumers that still reference the old name keep
   * working through the internal rename. Returns the live array, so
   * `.length = 0` / `.push(...)` on either name touches the same storage.
   */
  get foundryRadialLightsThroughFloor() {
    return this.foundryRadialLightsAdjacentFloor;
  }

  set foundryRadialLightsThroughFloor(v) {
    this.foundryRadialLightsAdjacentFloor = v;
  }

  /** @param {string} id @param {ThreeTexture|null} tex */
  setMask(id, tex) {
    this.masks.set(id, tex ?? null);
  }

  /**
   * @param {string} id
   * @returns {ThreeTexture|null}
   */
  getMask(id) {
    return this.masks.get(id) ?? null;
  }

  /** Convenience snapshot for diag (textures shown as ids only). */
  snapshot() {
    return {
      sceneDarkness01: this.sceneDarkness01,
      usingSceneDarkness: this.usingSceneDarkness,
      floorKey: this.floorKey,
      resolutionPx: [...this.resolutionPx],
      pivotWorld: [...this.pivotWorld],
      invScale: this.invScale,
      sceneRect: [...this.sceneRect],
      flipBackgroundTextureY: this.flipBackgroundTextureY,
      masks: Array.from(this.masks.entries()).map(([id, tex]) => ({
        id,
        hasTexture: !!tex,
      })),
      foundryRadialLights: this.foundryRadialLights.length,
      foundryRadialLightsAdjacentFloor: this.foundryRadialLightsAdjacentFloor.length,
      // Legacy alias — same length, kept for one release so existing diag consumers don't break.
      foundryRadialLightsThroughFloor: this.foundryRadialLightsAdjacentFloor.length,
      viewedFloorIndex: this.viewedFloorIndex,
      adjacentFloorIndex: this.adjacentFloorIndex,
      adjacentFloorMatteApply: this.adjacentFloorMatteApply,
      adjacentFloorHasUpperTexture: this.adjacentFloorHasUpperTexture,
      foundryLightAddScale: this.foundryLightAddScale,
      foundryLightDimRadiusStrength: this.foundryLightDimRadiusStrength,
      foundryLightBrightRadiusStrength: this.foundryLightBrightRadiusStrength,
      foundryLightIlluminationStrength: this.foundryLightIlluminationStrength,
      foundryLightColorationStrength: this.foundryLightColorationStrength,
      foundryLightColorationReflectivity: this.foundryLightColorationReflectivity,
      foundryLightColorationSaturation: this.foundryLightColorationSaturation,
      foundryLightGroundSaturation: this.foundryLightGroundSaturation,
      foundryLightGroundContrast: this.foundryLightGroundContrast,
      sceneColorGradeEnabled: this.sceneColorGradeEnabled,
      sceneGradeExposure: this.sceneGradeExposure,
      sceneGradeTemperature: this.sceneGradeTemperature,
      sceneGradeTint: this.sceneGradeTint,
      sceneGradeBrightness: this.sceneGradeBrightness,
      sceneGradeContrast: this.sceneGradeContrast,
      sceneGradeSaturation: this.sceneGradeSaturation,
      sceneGradeVibrance: this.sceneGradeVibrance,
      sceneGradeLift: [...this.sceneGradeLift],
      sceneGradeGamma: [...this.sceneGradeGamma],
      sceneGradeGain: [...this.sceneGradeGain],
      sceneGradeMasterGamma: this.sceneGradeMasterGamma,
      sceneGradeToneMapping: this.sceneGradeToneMapping,
      tokenColorGradeEnabled: this.tokenColorGradeEnabled,
      tokenGradeExposure: this.tokenGradeExposure,
      tokenGradeTemperature: this.tokenGradeTemperature,
      tokenGradeTint: this.tokenGradeTint,
      tokenGradeBrightness: this.tokenGradeBrightness,
      tokenGradeContrast: this.tokenGradeContrast,
      tokenGradeSaturation: this.tokenGradeSaturation,
      tokenGradeVibrance: this.tokenGradeVibrance,
      tokenGradeAmount: this.tokenGradeAmount,
      darknessTintLinear: [...this.darknessTintLinear],
    };
  }
}
