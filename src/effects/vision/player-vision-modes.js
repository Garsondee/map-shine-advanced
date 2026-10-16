/**
 * PLAYER VISION-MODE GRADES — the presets and the gate for the five
 * screen-space looks Night Vision / Low-light Vision / Low-light (Active) /
 * Infravision / Active
 * Infravision resolve to (mythica-machina-press#77 Stage 2b, #580's own
 * "real MSA thermal-vision post-process" ask).
 *
 * Deliberately separate from `foundry/player-light-mode.js#PLAYER_LIGHT_MODES`
 * (all seven carried-light modes, Torch/Flashlight included) — THIS module only
 * knows the five that have a screen-space GRADE at all. Torch/Flashlight are
 * real MSA-rendered LIGHTS (Stage 2a, `point-light-pool.js`/the particle
 * engine), not a post-process tint, so they never resolve to a preset here.
 *
 * Same "one place, named constants" shape as `effects/lighting/player-light-
 * geometry.js#PLAYER_LIGHT_MODE_PRESETS` — a preset is a plain object of
 * tuned numbers, nothing else reaches into the shader to pick a value.
 *
 * ⚠️ REASONED, NOT MEASURED (same honesty posture as `environmental-
 * light.js#FLUID_SHADOW_TINT_STRENGTH`). #77's "concept only" scope note asks
 * for a good, distinct, functional look per mode — not V2's full per-control
 * depth (scanlines/phosphor/bloom/Purkinje-crossover/chromatic-aberration/
 * warm-up-flicker are real V2 controls, explicitly deferred as follow-up
 * depth, not this build's bar). If the author wants a mode stronger/weaker/
 * more-or-less saturated by eye, these are the numbers to change.
 *
 * @module effects/vision/player-vision-modes
 */

/** The five mode keys that have a screen-space grade at all — a strict
 * subset of `PLAYER_LIGHT_MODES` (`torch`/`flashlight` excluded: they render
 * as real lights, not a tint on the final image). */
export const PLAYER_VISION_GRADE_MODE_KEYS = Object.freeze([
  'nightVision',
  'lowLight',
  'activeLowLight',
  'infravision',
  'activeInfravision',
]);

/**
 * Named, tuned constants per mode. Every number here is a deliberate design
 * choice, not a measurement — see this module's own header.
 *
 * Shared vocabulary across modes:
 *   - `gain`       multiplies luminance before the tint/ramp (brightness/amp boost)
 *   - `floorLift`  additive black-floor lift, so total darkness reads as a dim
 *                  glow rather than pure black (both amplification modes)
 *   - `grainAmount` per-pixel animated noise amplitude, 0 = none
 *   - `noiseDensity` fraction of pixels that carry grain at all (1 = the whole
 *                   field); below 1 gives sparse speckle rather than uniform noise
 *   - `baseSaturation`/`darkSaturation` how much colour a LIT / deep-shadow
 *                   pixel keeps on the low-light modes (see `buildLowLightNode`)
 *   - `rodGainRgb`/`rodLumaRgb`/`purkinjeStrength`/`purkinjeDesaturation` the
 *                   Purkinje (rod) colouration shared by both low-light modes —
 *                   see `buildPurkinjeNode`'s own header
 *   - `eyepieceRadius`/`eyepieceSoftness` the token-centred range, in TOKEN
 *                   WIDTHS (zoom-stable world space), shared by every
 *                   amplification mode; `lightRevealStart/End` keeps a bright
 *                   light outside that range from being darkened
 *   - `shadowGain`/`shadowKnee`/`darkLift` how hard a thermal mode brightens
 *                   shadows (same shape as the low-light modes'; a thermal
 *                   mode may not darken the scene — see `buildInfravisionNode`)
 *   - `thermalGain`/`thermalGamma`/`contrastPower` push a pixel's (brightened)
 *                   luminance up the palette, i.e. how HOT the scene reads
 *   - `tintStrength` how much of the thermal palette's HUE replaces the
 *                   scene's own — a pure colour change, never a level change
 *   - `tokenStrength`/`tokenScale`/`tokenFeather01`/`tokenHeat`/
 *                   `tokenHeatFromLuma`/`tokenGain`/`tokenLumaFloor` the
 *                   hot-body token recolour unique to the two thermal modes —
 *                   see `buildTokenMaskNode`'s own header
 *
 * @type {Readonly<Record<string, object>>}
 */
export const VISION_MODE_PRESETS = Object.freeze({
  /** Image-intensifier goggles, ported from V2's tuned Night Vision (the
   * author's own live-tuned numbers, PlayerLightEffectV2 `nightVision*`): a
   * luminance amplifier that BRIGHTENS shadows (gamma-curved gain, never
   * crushing), a pure monochrome green tint, a round eyepiece with a black
   * surround, scanlines, sensor noise that grows in the dark, and a faint
   * phosphor shimmer. This starts from V2's tuned profile, with gain, edge
   * separation and scanline contrast softened after live review. */
  nightVision: Object.freeze({
    // amplifyNightVision: amp = min(gain * (Y + darkLift)^(1/gamma), maxLuma); scale = max(1, amp / Y)
    gain: 8.5,
    gamma: 0.86,
    maxLuma: 3.5,
    darkLift: 0.016,
    saturation: 0, // 0 = fully monochrome
    tintRgb: Object.freeze([0, 0.55, 0.17]),
    tintStrength: 1,
    brightness: 1.45,
    purkinjeStrength: 0,
    purkinjeDarkStart: 0.021,
    purkinjeBrightEnd: 0.23,
    purkinjeCurve: 1.4,
    // V2's lens optics and per-channel edge separation.
    distortionAmount: -0.06,
    chromaticAberrationPx: 1.5,
    chromaticAberrationEdgePower: 4,
    // World-space falloff measured in token widths: zoom changes its screen
    // footprint, not how far the wearer's NV reaches across the map.
    eyepieceStyle: 'single',
    eyepieceRadius: 14,
    eyepieceSoftness: 6,
    eyepieceIntensity: 1,
    eyepieceColor: Object.freeze([0, 0, 0]),
    eyepieceSeparation: 0.26,
    scanIntensity: 0.06,
    scanDensity: 300, // lines across the screen height
    scanSpeed: 1.4,
    scanThickness: 0.5,
    noiseAmount: 0.11,
    noiseLowLightBoost: 0.55,
    noiseEdgeBoost: 4.5,
    noiseSpeed: 0.1,
    noiseScale: 1,
    lightRevealStart: 0.02,
    lightRevealEnd: 0.18,
    phosphorFlickerAmount: 0.09,
    phosphorFlickerSpeed: 4.1,
    phosphorSize: 1.39,
    phosphorDensity: 0.51,
    phosphorIntensity: 1.05,
    // Startup/shutdown response from V2. The compositor drives this power
    // envelope so turning the mode off does not cut the tube instantly.
    warmupSeconds: 0.6,
    shutdownSeconds: 0.4,
    powerFlickerEnabled: true,
    powerFlickerIntensity: 0.5,
    // V2's burn map was temporally persistent. This pass reproduces its soft
    // spatial halo; a true burn trail needs a compositor-owned history target.
    bloomEnabled: true,
    bloomThreshold: 1.44,
    bloomThresholdSoftness: 0.5,
    bloomIntensity: 3,
    bloomBlurPx: 9.8,
    bloomResponse: 0.5,
    // V2's darkness gate: goggles only engage as the scene gets dark, so a lit
    // daytime map is left alone. power = smoothstep(start, end, darkness01).
    darknessGateStart: 0.25,
    darknessGateEnd: 0.6,
  }),
  /** Passive scotopic vision: weak shadow lift, and the most desaturated of the
   * two low-light modes — rod-dominated human vision (see `buildPurkinjeNode`'s
   * own header for the Purkinje colouration every low-light mode shares). Like
   * real rods it improves dark sensitivity without a green display device's
   * tint. */
  lowLight: Object.freeze({
    shadowGain: 0.55, // multiplier tops at 1.55 in the deepest shadows
    shadowKnee: 0.34,
    darkLift: 0.006,
    // SATURATION, 2026-10-15 (author's call: "make saturation much lower"):
    // `baseSaturation` is what a genuinely LIT pixel keeps, `darkSaturation`
    // the floor a deep-shadow pixel drains to. Passive rods give up far more
    // colour than active ones — see `activeLowLight` below.
    baseSaturation: 0.55,
    darkSaturation: 0.2,
    // THE PURKINJE SHIFT (2026-10-15, author's own ask — "blues and greens
    // appear relatively brighter... reds turn nearly black") — this IS the
    // colouration mechanism for both low-light modes, replacing the old mild
    // cool tint. See `buildPurkinjeNode`'s header for both terms.
    rodGainRgb: Object.freeze([0.32, 1.02, 1.18]),
    rodLumaRgb: Object.freeze([0.05, 0.58, 0.37]),
    purkinjeStrength: 1.0,
    purkinjeDesaturation: 0.6,
    eyepieceRadius: 14,
    eyepieceSoftness: 6,
    lightRevealStart: 0.02,
    lightRevealEnd: 0.16,
    noiseAmount: 0.028,
    noiseLowLightBoost: 0.9,
    noiseDensity: 0.22,
    noiseSpeed: 9,
    darknessGateStart: 0.15,
    darknessGateEnd: 0.5,
  }),
  /** Active animal-like night vision: much stronger rod sensitivity, and
   * DESATURATED TOO (2026-10-15: "less saturation but not as low as plain Low
   * Light") — a cat's eye still resolves colour the rods alone cannot, so both
   * saturation terms sit well above `lowLight`'s while staying far below the
   * 0.94/1.0 a first pass shipped. Same Purkinje colouration, slightly gentler. */
  activeLowLight: Object.freeze({
    shadowGain: 1.65,
    shadowKnee: 0.62,
    darkLift: 0.018,
    baseSaturation: 0.8,
    darkSaturation: 0.45,
    rodGainRgb: Object.freeze([0.5, 1.02, 1.12]),
    rodLumaRgb: Object.freeze([0.08, 0.57, 0.35]),
    purkinjeStrength: 0.85,
    purkinjeDesaturation: 0.4,
    eyepieceRadius: 14,
    eyepieceSoftness: 6,
    lightRevealStart: 0.02,
    lightRevealEnd: 0.16,
    noiseAmount: 0.02,
    noiseLowLightBoost: 0.7,
    noiseDensity: 0.35,
    noiseSpeed: 7,
    darknessGateStart: 0.1,
    darknessGateEnd: 0.45,
  }),
  /** Passive thermal sensing: the scene read as temperature, a little more
   * powerful than Low Light. Dim scenery lands on a bright NEUTRAL grey, warm
   * light reads ember orange, and a body reads as the warmest thing in frame —
   * using the final composited luminance as the heat proxy (see
   * `buildThermalRampNode`'s own header for why).
   *
   * 2026-10-15, second live pass — three rewrites, all from the author's own
   * verdict on a real scene ("making it MUCH HARDER to actually see what is
   * happening. The scene isn't brightened it's being obscured... The purple
   * colour is a problem too. It's far far too strong and obscures things. Your
   * illumination of tokens is to put a light on them but this washes them out
   * badly. Instead of placing a 'light' over tokens maybe mutate the colours of
   * the token"):
   *   1. the cool end of the palette is a near-neutral grey, not blue-violet,
   *      and `shadowGain`/`darkLift` BRIGHTEN dim scenery instead of leaving it
   *      at whatever the ramp's cold stop happened to be;
   *   2. `tintStrength` is a pure hue substitution at the scene's own (lifted)
   *      luminance, so nothing this mode does can reduce legibility — see
   *      `thermalHueAtLuminance`;
   *   3. the token path recolours the token's OWN pixels inside its own
   *      footprint — no glow, no blob — see `buildTokenMaskNode`.
   * Passive-sensing feel: no scan sweep, and a gentler `tintStrength` than
   * `activeInfravision`, so a dim room still reads like a slightly warm
   * low-light view rather than a full thermal image. */
  infravision: Object.freeze({
    // Cold end is a visible neutral grey with the faintest cool cast. The
    // shipped palette's near-black blue-violet stops are what washed the map
    // purple after live review; these three numbers are the regression bar for
    // that ("the purple colour is a problem too... it obscures things").
    rampStops: Object.freeze([
      Object.freeze([0.46, 0.47, 0.5]), // coldest — neutral grey, a whisper of cool
      Object.freeze([0.62, 0.56, 0.48]), // cool — warm grey, i.e. a body in shadow
      Object.freeze([0.95, 0.56, 0.24]), // warm — ember orange
      Object.freeze([1.0, 0.92, 0.66]), // hottest — pale warm yellow
    ]),
    // THE BRIGHTENING. "The scene isn't brightened it's being obscured" — a
    // thermal mode now lifts shadows at least as hard as Low Light (0.55),
    // applied to the scene's own luminance so the lift can never crush.
    shadowGain: 0.9,
    shadowKnee: 0.45,
    darkLift: 0.02,
    thermalGain: 1.35,
    thermalGamma: 0.9,
    contrastPower: 1.0,
    // How much of the palette's HUE replaces the scene's own. A pure colour
    // change (see `thermalHueAtLuminance`), so this is a taste knob, not a
    // legibility one — deliberately below `activeInfravision`'s.
    tintStrength: 0.6,
    grainAmount: 0.015,
    grainSpeed: 6,
    scanAmount: 0, // no active sweep — see `activeInfravision` below
    // THE TOKEN-CENTERED RANGE — the same token-width radius/softness pair NV
    // and both low-light modes use, so every mode the wearer can pick reaches
    // the same distance across the map (zoom-stable; see `buildVisionFalloff`).
    eyepieceRadius: 14,
    eyepieceSoftness: 6,
    lightRevealStart: 0.02,
    lightRevealEnd: 0.18,
    darknessGateStart: 0.15,
    darknessGateEnd: 0.5,
    // HOT BODIES — the body's own pixels recoloured warm, inside the body's own
    // footprint. `tokenScale`/`tokenFeather01` size that footprint (a multiple
    // of the token's own half-extents, and the fraction of it the mask fades
    // over — deliberately just past 1 so the recolour covers the token's
    // outer border pixels without hanging a halo off the box);
    // `tokenHeat`/`tokenHeatFromLuma` say how warm a body reads and how much
    // its own brightness adds; `tokenGain`/`tokenLumaFloor` brighten it,
    // including a floor so even a pitch-dark body still reads as an emitter.
    tokenStrength: 0.8,
    tokenScale: 1.06,
    tokenFeather01: 0.12,
    tokenHeat: 0.5,
    tokenHeatFromLuma: 0.3,
    tokenGain: 1.3,
    tokenLumaFloor: 0.17,
  }),
  /** The same palette and the same hot-body recolour, pushed harder: a
   * stronger shadow lift, a hotter ramp position for the same scene, and a
   * heavier hue substitution — "active infravision being a brighter, broader
   * and more powerful version" of the passive look (author, 2026-10-15).
   * Plus a dim horizontal sweep band that loops down the screen, which reads as
   * an ACTIVELY scanning sensor rather than passive heat-sensing. */
  activeInfravision: Object.freeze({
    rampStops: Object.freeze([
      Object.freeze([0.46, 0.47, 0.5]),
      Object.freeze([0.62, 0.56, 0.48]),
      Object.freeze([0.95, 0.56, 0.24]),
      Object.freeze([1.0, 0.92, 0.66]),
    ]),
    shadowGain: 1.35,
    shadowKnee: 0.6,
    darkLift: 0.03,
    thermalGain: 1.8,
    thermalGamma: 0.85,
    contrastPower: 1.25,
    tintStrength: 0.85,
    grainAmount: 0.02,
    grainSpeed: 6,
    scanAmount: 1,
    scanSpeedHz: 0.2, // one top-to-bottom sweep every 5s
    scanBandWidth: 0.025, // fraction of screen height
    scanBrightness: 0.04,
    // Same range as every other mode; the active sensor holds its reading a
    // touch harder and covers a slightly larger footprint per body.
    eyepieceRadius: 14,
    eyepieceSoftness: 6,
    lightRevealStart: 0.02,
    lightRevealEnd: 0.18,
    darknessGateStart: 0.15,
    darknessGateEnd: 0.5,
    tokenStrength: 0.92,
    tokenScale: 1.12,
    tokenFeather01: 0.18,
    tokenHeat: 0.66,
    tokenHeatFromLuma: 0.35,
    tokenGain: 1.6,
    tokenLumaFloor: 0.22,
  }),
});

/**
 * THE GATE — should THIS client's present pass apply a vision-mode grade
 * right now, and which one? Pure and total: every live Foundry/canvas read
 * (which token is mine, what that token's flag says, what the scene
 * currently allows, whether I am a GM) happens at the CALLER's own call site
 * (`boot.js`'s injected `getActivePlayerVisionMode` closure — mirrors
 * `player-light-mode.js#readActivePlayerCarriedLightTokens`'s own "live read
 * vs. pure resolver" split), never here.
 *
 * ⚠️ `isGM: true` GETS NO GRADE, EVEN IF `mode` IS SET — the gate for a caller
 * that wants a GM excluded outright. `boot.js`'s `getActivePlayerVisionMode`
 * does NOT: a GM's carried-light token is the one they have selected
 * (`foundry/viewer-token.js#resolveCarriedLightToken`), and that token's mode
 * grades the GM's own view, so a GM can try the modes. It passes `false`.
 *
 * @param {object} args
 * @param {boolean} args.isGM - true to exclude the viewer outright.
 * @param {string|null} args.mode - `readTokenPlayerLightMode()`'s result for
 *   the viewer's own token (or `null` — no token, no mode, torch/flashlight).
 * @param {{modes: Record<string, boolean>}} args.permissions -
 *   `readScenePlayerLightPermissions().permissions`.
 * @returns {string|null} one of `PLAYER_VISION_GRADE_MODE_KEYS`, or `null`
 *   (no grade should render this frame).
 */
export function resolveActivePlayerVisionModePreset({ isGM, mode, permissions }) {
  if (isGM) return null;
  if (!PLAYER_VISION_GRADE_MODE_KEYS.includes(mode)) return null;
  if (permissions?.modes?.[mode] !== true) return null;
  return mode;
}
