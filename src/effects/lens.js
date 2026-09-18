/**
 * LENS — the camera's own glass, grain and shutter (mythica-machina-press#57).
 * V2's real, shipped source: `legacy/compositor-v2/effects/LensEffectV2.js` +
 * `legacy/compositor-v2/effects/lens-shader.js`, recovered from git history
 * (`c328c9bd~1`) rather than guessed from the design doc's own aspirational
 * text — the standing rule for any "V2 parity" claim on this project.
 *
 * ============================================================================
 * THE HONEST SPLIT — WHAT THIS PORTS, AND WHAT IT DELIBERATELY SIMPLIFIES
 * ============================================================================
 * V2's `LensEffectV2` is really TWO effects sharing one shader file:
 *
 *   1. THE OPTICS — distortion, chromatic aberration, vignette, film grain /
 *      digital noise, autofocus defocus pulses, camera motion blur, and a
 *      light-burn persistence buffer. All of it is either pure ALU on the
 *      composited frame or driven by facts this engine already has (elapsed
 *      time, the viewer's own camera delta, the scene's own darkness level).
 *      THIS shipped first (tiers 0-2, below).
 *
 *   2. THE OVERLAY CATALOG — grime/dust/light-leak IMAGES drifting subtly
 *      across the lens, luma-reactive and cycling over time. V2 ran FOUR
 *      permanently-stacked "channel" layers (structural / optical / reactive
 *      / viewfinder) PLUS two more generic slots, each with its OWN 13-ish
 *      authored params, discovered at runtime via Foundry's `FilePicker`
 *      scanning an `assets/lens assets/` folder (`LensEffectV2.js#
 *      _discoverCatalog`) and dual-slot cross-faded per channel.
 *      ⚠️ CORRECTED 2026-09-18 (mythica-machina-press#57): a prior version of
 *      this comment claimed "there is no such folder, and no such library, in
 *      this project today" — that was WRONG (`assets/lens assets/` exists
 *      RIGHT NOW, in this repo, with the full 13-image library: lens_dust_01,
 *      lens_grease_01-03, lens_leak_01-02, lens_overlay_01-02,
 *      lens_scratches_01, light_leak_01-02, rainbow_chroma_01-02 — plus its
 *      own `attribution.md`, free for commercial use via texturelabs.org).
 *
 *      BUILT NOW (tier 3, below) is a deliberately BASIC v1, not a port of
 *      V2's full complexity (author's own instruction: "even a basic version
 *      of every V2 effect is preferable to leaving a gap"):
 *        - ONE overlay control group, not four channels × ~13 params each —
 *          intensity, luma-reactivity, a clear-radius + softness, drift
 *          speed, cycle time and crossfade time. `LENS_OVERLAY_CATALOG`
 *          (below) cycles through all 13 images UNIFORMLY, in a fixed,
 *          hardcoded order — no semantic classification into V2's four
 *          channels, and no runtime `FilePicker` discovery: the images ship
 *          WITH this module (not author-authored per-map content), so a
 *          static list of the known filenames is the honest, simpler
 *          mechanism (`vt/lens-overlay-image.js`'s own header).
 *        - ONE cycling library, not V2's two independently-timed generic
 *          slots — a single current/next crossfade (`lens-render.js`'s own
 *          `overlayCurrentTexNode`/`overlayNextTexNode`), not a dual-slot
 *          pile-up of up to six simultaneous layers.
 *        - Drift is a small fixed-amplitude wobble driven by ONE authored
 *          speed, not V2's own per-channel authored drift VECTOR (a constant
 *          velocity that runs forever) — bounded on purpose so a texture
 *          sampled ClampToEdge never needs to reason about how far an
 *          unbounded pan has travelled over an arbitrarily long play session.
 *        - No V2 "pulse" (a periodic intensity throb independent of drift) —
 *          folded out as one more knob this basic v1 does not need.
 *      None of this is "parity with V2" and it does not claim to be — it is
 *      the same posture Effects.md §0 asks for everywhere else in this file:
 *      built, real, and honestly smaller than the reference implementation,
 *      recorded here rather than silently presented as the full thing.
 *
 * ============================================================================
 * WHERE THIS SITS IN THE FRAME GRAPH — A DELIBERATE, PRECEDENTED DEPARTURE
 * ============================================================================
 * `graph/passes.js`'s `post.grade` entry lists `LensEffectV2` among the
 * THIRTEEN V2 classes it plans to absorb into one unified, order-defined
 * grade stack — and `post.grade` itself is 100% unbuilt (`grade-pass.js`
 * unconditionally throws `NotBuiltError`). Building the full 13-effect
 * unification is a real, separate, cross-cutting architecture project on its
 * own — exactly the "needs careful design first" category this project's own
 * standing principle names, not a single effect.
 *
 * `post.bloom` already sets the precedent for exactly this situation: its own
 * `post.grade` note says outright *"bloom is now the separate post.bloom
 * pass"* — BloomEffectV2 was ALSO originally slated for the grade stack, and
 * shipped standalone instead once it was actually built, with `post.grade`'s
 * own doc updated to say so rather than silently disagreeing with reality.
 * `post.lens` (`graph/passes.js`) follows the identical path: a real,
 * independent post-stage pass, reachable and testable on its own, which
 * `post.grade` can absorb later if/when the full unification is ever
 * attempted — never a blocker on shipping the effect itself.
 *
 * @module effects/lens
 */

/**
 * The authorable knobs (validated by core/params-schema.js), grouped by the
 * fixed ROH categories. Every default below is V2's OWN shipped default
 * (`LensEffectV2.js`'s own `this.params = {...}`), not a guess — the one
 * place a value differs from V2's literal number, the param's own `help`
 * text says why.
 *
 * @type {Record<string, object>}
 */
export const LENS_PARAMS = Object.freeze({
  // ── Optics (tier 0 — the glass itself) ────────────────────────────────────
  distortion: {
    type: 'float',
    min: -0.3,
    max: 0.3,
    step: 0.005,
    default: -0.08,
    category: 'Optics',
    label: 'Lens curvature',
    help: "How much the image bows away from a flat plane, like looking through real camera glass. Negative pulls the edges in (a gentle pincushion, V2's own default); positive pushes them out (barrel). 0 is a perfectly flat, distortion-free image.",
  },
  chromaticAmountPx: {
    type: 'float',
    min: 0,
    max: 12,
    step: 0.1,
    default: 4.22,
    category: 'Optics',
    label: 'Colour fringing',
    help: 'Red/blue channel separation at the edges of the frame, in screen pixels — the coloured fringing real lenses show on high-contrast edges, strongest where the curvature above is strongest. 0 removes it entirely.',
  },
  chromaticEdgePower: {
    type: 'float',
    min: 0.2,
    max: 6,
    step: 0.01,
    default: 2.11,
    category: 'Optics',
    label: 'Fringing falloff',
    help: 'How sharply the colour fringing above concentrates at the very edge of frame versus spreading toward the centre. Higher keeps the centre clean and pushes the fringing further out.',
  },
  vignetteIntensity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Optics',
    label: 'Vignette',
    help: "How dark the corners of the frame read compared to the centre — the natural light falloff of a lens. 0 is perfectly even; 1 is V2's own full default darkening.",
  },
  vignetteSoftness: {
    type: 'float',
    min: 0.02,
    max: 0.9,
    step: 0.01,
    default: 0.34,
    category: 'Optics',
    label: 'Vignette softness',
    help: 'How far in from the very corner the darkening above starts to fade in. Small values keep a hard-edged dark ring near the border; large values spread the falloff in toward the centre.',
  },

  // ── Grain (tier 0 — film/sensor texture) ──────────────────────────────────
  grainAmount: {
    type: 'float',
    min: 0,
    max: 0.15,
    step: 0.001,
    default: 0.01,
    category: 'Grain',
    label: 'Film grain',
    help: 'Fine per-pixel brightness noise, like real film stock or a camera sensor at speed — the texture that keeps a flat CG-perfect image from reading as sterile. 0 removes it entirely.',
  },
  grainSpeed: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: 1,
    category: 'Grain',
    label: 'Grain speed',
    help: 'How fast the grain pattern itself re-rolls, in cycles per second. Low values read as a textured but fairly stable image; high values read as a busier, more electric shimmer.',
  },
  adaptiveGrainEnabled: {
    type: 'bool',
    default: true,
    category: 'Grain',
    label: 'Boost grain in the dark',
    help: 'Real film and sensors get noisier as the light drops — this makes grain visibly heavier in dark scenes and finer in bright ones, the same way a real low-light photo looks grittier than a sunlit one.',
  },
  grainLowLightBoost: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.25,
    category: 'Grain',
    label: 'Low-light grain boost',
    help: 'How much stronger the grain above gets in full darkness, once "boost grain in the dark" is on. 0 leaves grain the same everywhere regardless of exposure.',
  },
  grainCellSizeBright: {
    type: 'float',
    min: 0.5,
    max: 6,
    step: 0.1,
    default: 1.4,
    category: 'Grain',
    label: 'Grain size (bright)',
    help: 'How large each grain speck reads, in screen pixels, in well-lit parts of the image. Smaller is finer and less visible; larger reads as coarser, more obviously textured film.',
  },
  grainCellSizeDark: {
    type: 'float',
    min: 0.5,
    max: 10,
    step: 0.1,
    default: 3,
    category: 'Grain',
    label: 'Grain size (dark)',
    help: 'The same speck size as above, but for the darkest parts of the image once "boost grain in the dark" is on — real high-ISO grain reads visibly coarser than low-ISO grain, not just brighter.',
  },
  digitalNoiseEnabled: {
    type: 'bool',
    default: false,
    category: 'Grain',
    label: 'Digital sensor noise',
    help: "A second, sharper kind of noise on top of film grain — coloured single-pixel speckle that reads as a cheap digital sensor or a night-vision camera rather than real film, biased toward low light. Off by default, matching V2's own shipped state.",
  },
  digitalNoiseAmount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.005,
    default: 0.066,
    category: 'Grain',
    label: 'Digital noise strength',
    help: 'How bright each speck of digital sensor noise reads once it fires. Only visible while "digital sensor noise" above is on.',
  },
  digitalNoiseChance: {
    type: 'float',
    min: 0,
    max: 0.05,
    step: 0.0005,
    default: 0.004,
    category: 'Grain',
    label: 'Digital noise density',
    help: 'How many pixels get a speck on a given frame — low values read as occasional glitchy pixels, higher values read as a dense, staticky field.',
  },
  digitalNoiseGreenBias: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Grain',
    label: 'Digital noise green bias',
    help: 'How strongly each speck leans green rather than a random colour — real camera sensors are more sensitive on the green channel, so their noise floor skews green too. 0 is fully random colour.',
  },
  digitalNoiseLowLightBoost: {
    type: 'float',
    min: 0,
    max: 6,
    step: 0.01,
    default: 3.37,
    category: 'Grain',
    label: 'Digital noise low-light boost',
    help: 'How much more often and how much brighter the digital noise above fires as the scene gets darker — a cheap sensor gets noticeably noisier once it has to amplify a dim signal.',
  },

  // ── Autofocus (tier 1 — the lens hunting for focus) ───────────────────────
  autoFocusEnabled: {
    type: 'bool',
    default: false,
    category: 'Autofocus',
    label: 'Autofocus pulses',
    help: "Every so often, the whole image briefly softens and re-sharpens — a camera hunting for focus, the same beat a real autofocus lens has when the shot changes. Off by default, matching V2's own shipped state.",
  },
  autoFocusMinIntervalSeconds: {
    type: 'float',
    min: 0.5,
    max: 600,
    step: 1,
    default: 10,
    category: 'Autofocus',
    label: 'Min. time between pulses',
    help: 'The shortest real-world gap, in seconds, before the next autofocus pulse can fire. The actual gap is picked randomly between this and the maximum below, so pulses never fall on a predictable beat.',
  },
  autoFocusMaxIntervalSeconds: {
    type: 'float',
    min: 0.5,
    max: 900,
    step: 1,
    default: 45,
    category: 'Autofocus',
    label: 'Max. time between pulses',
    help: 'The longest real-world gap, in seconds, before the next autofocus pulse fires. Set equal to the minimum above for a fixed interval instead of a random one.',
  },
  autoFocusDefocusDurationSeconds: {
    type: 'float',
    min: 0.1,
    max: 6,
    step: 0.05,
    default: 2,
    category: 'Autofocus',
    label: 'Pulse duration',
    help: 'How long one autofocus pulse takes from the moment the image starts to soften to the moment it is sharp again.',
  },
  autoFocusMaxBlurPx: {
    type: 'float',
    min: 0,
    max: 12,
    step: 0.1,
    default: 2.5,
    category: 'Autofocus',
    label: 'Pulse blur',
    help: 'How soft the image gets at the peak of a pulse, in screen pixels of blur radius.',
  },
  autoFocusMaxShiftPx: {
    type: 'float',
    min: 0,
    max: 30,
    step: 0.5,
    default: 6,
    category: 'Autofocus',
    label: 'Pulse drift',
    help: 'How far the whole image can drift sideways during a pulse, in screen pixels, in a random direction each time — the small reframe a real lens makes while it hunts.',
  },
  autoFocusZoomTriggerEnabled: {
    type: 'bool',
    default: true,
    category: 'Autofocus',
    label: 'Refocus on fast zoom',
    help: 'A quick, deliberate camera zoom also triggers an autofocus pulse of its own, on top of the regular timed ones — the same "catching up" moment a real lens has right after you snap-zoom it.',
  },
  autoFocusZoomTriggerThreshold: {
    type: 'float',
    min: 0.1,
    max: 20,
    step: 0.05,
    default: 3,
    category: 'Autofocus',
    label: 'Zoom trigger sensitivity',
    help: 'How fast a zoom has to happen, before it counts as fast enough to trigger the refocus pulse above. Lower values trigger more easily.',
  },
  autoFocusZoomTriggerCooldownSeconds: {
    type: 'float',
    min: 0,
    max: 30,
    step: 0.5,
    default: 6,
    category: 'Autofocus',
    label: 'Zoom trigger cooldown',
    help: 'The minimum gap, in seconds, between two zoom-triggered refocus pulses — stops a shaky or repeated zoom from firing the effect over and over.',
  },
  autoFocusZoomTriggerStrength: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.15,
    category: 'Autofocus',
    label: 'Zoom trigger strength',
    help: 'How much extra punch a zoom-triggered pulse gets on top of an ordinary one — a harder, faster zoom earns a slightly stronger refocus reaction.',
  },

  // ── Motion (tier 1 — camera-driven blur) ──────────────────────────────────
  motionBlurEnabled: {
    type: 'bool',
    default: false,
    category: 'Motion',
    label: 'Camera motion blur',
    help: "A brief directional smear whenever the camera pans or zooms quickly — the same motion blur a real camera picks up when it moves faster than its shutter can freeze. Off by default, matching V2's own shipped state.",
  },
  motionBlurStrength: {
    type: 'float',
    min: 0,
    max: 6,
    step: 0.05,
    default: 1.77,
    category: 'Motion',
    label: 'Pan blur strength',
    help: 'How strongly panning the camera smears the image. 0 disables pan-driven blur while leaving zoom-driven blur below untouched.',
  },
  motionBlurMaxPx: {
    type: 'float',
    min: 0,
    max: 40,
    step: 0.5,
    default: 10,
    category: 'Motion',
    label: 'Max blur',
    help: 'The hardest ceiling on how far the smear can reach, in screen pixels, regardless of how fast the camera is actually moving — keeps a sudden snap-pan from tearing the image apart.',
  },
  motionBlurZoomStrength: {
    type: 'float',
    min: 0,
    max: 6,
    step: 0.05,
    default: 1.25,
    category: 'Motion',
    label: 'Zoom blur strength',
    help: 'How strongly zooming the camera in or out smears the image outward/inward from the centre, independent of the pan blur above.',
  },
  motionBlurSmoothingSeconds: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.02,
    default: 0.8,
    category: 'Motion',
    label: 'Motion smoothing',
    help: "How quickly the blur above reacts to a change in camera speed, in seconds. Low values snap to the camera's exact current speed (can flicker on a jittery pan); higher values ease in and out more like real shutter/exposure persistence.",
  },

  // ── Light burn (tier 2 — bright-source persistence) ───────────────────────
  lightBurnEnabled: {
    type: 'bool',
    default: false,
    category: 'Light burn',
    label: 'Light burn',
    help: 'The brightest points on screen leave a faint, fading afterimage, the way a real camera sensor briefly "burns in" a very bright light. Off by default, matching V2\'s own shipped state.',
  },
  lightBurnThreshold: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.98,
    category: 'Light burn',
    label: 'Burn threshold',
    help: 'How bright a pixel must read before it starts leaving a burn — high values only catch the most intense highlights (a torch, a magical glow, direct sun), low values catch ordinary bright surfaces too.',
  },
  lightBurnThresholdSoftness: {
    type: 'float',
    min: 0.001,
    max: 1,
    step: 0.01,
    default: 0.5,
    category: 'Light burn',
    label: 'Burn threshold softness',
    help: 'How gently the burn fades in around the threshold above, rather than switching on abruptly at an exact brightness.',
  },
  lightBurnIntensity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.1,
    category: 'Light burn',
    label: 'Burn brightness',
    help: 'How visible the afterimage itself reads once it has formed.',
  },
  lightBurnResponse: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.01,
    default: 1.15,
    category: 'Light burn',
    label: 'Burn response',
    help: 'How strongly a source above the threshold writes into the burn buffer each frame it stays lit — higher makes the afterimage build up faster and read stronger overall.',
  },
  lightBurnPersistenceSeconds: {
    type: 'float',
    min: 0.05,
    max: 20,
    step: 0.05,
    default: 0.05,
    category: 'Light burn',
    label: 'Burn persistence',
    help: "How many seconds a burn takes to fade back out once its source dims or moves away. V2's own shipped default is short and subtle; raise it for a lingering, more dramatic afterimage.",
  },
  lightBurnBlurPx: {
    type: 'float',
    min: 0,
    max: 24,
    step: 0.5,
    default: 8,
    category: 'Light burn',
    label: 'Burn softness',
    help: 'How far the afterimage spreads beyond the exact shape of the source that caused it, in screen pixels — a soft glow rather than a hard-edged ghost.',
  },
  lightBurnDarknessGateEnabled: {
    type: 'bool',
    default: true,
    category: 'Light burn',
    label: 'Only burn in the dark',
    help: "Restricts light burn to darker scenes, the same way a real sensor's burn-in is only obvious once everything else is dim — a torch burns in convincingly at night, not at noon.",
  },
  lightBurnDarknessStart: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Light burn',
    label: 'Burn gate start',
    help: 'The scene darkness level (0 = full daylight, 1 = pitch black) where the darkness gate above starts letting burn through.',
  },
  lightBurnDarknessEnd: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Light burn',
    label: 'Burn gate end',
    help: 'The scene darkness level where the gate above reaches its full effect. Together with the start value, this is the range burn fades in across as the scene darkens.',
  },
  lightBurnDarknessInfluence: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
    category: 'Light burn',
    label: 'Burn gate strength',
    help: 'How completely the darkness gate suppresses burn outside its range — 0 leaves burn equally visible everywhere (the gate has no effect); 1 removes it entirely in full daylight.',
  },

  // ── Overlay (tier 3 — the grime catalog) ──────────────────────────────────
  // A basic v1 of V2's overlay catalog — see this module's own header for
  // exactly what is simplified and why. ONE control group governs the whole
  // cycling library; there is no per-image or per-channel tuning.
  overlayEnabled: {
    type: 'bool',
    default: false,
    category: 'Overlay',
    label: 'Grime overlay',
    help: "Dust, scratches and light-leak marks drifting slowly across the glass, cycling through this module's own image library over time — the lived-in imperfection of a real camera lens rather than a perfectly clean render. Off by default, matching V2's own shipped state.",
  },
  overlayIntensity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.35,
    category: 'Overlay',
    label: 'Overlay strength',
    help: 'How visible the grime layer reads at its brightest. 0 is invisible regardless of the other settings below; higher reads as a dirtier, more heavily used lens.',
  },
  overlayLumaReactivity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.6,
    category: 'Overlay',
    label: 'Brightness reactivity',
    help: 'How much the overlay above brightens in well-lit scenes and fades in dark ones, the way real dust and smudges only catch the eye once light hits the glass. 0 keeps the overlay at a constant strength regardless of scene brightness.',
  },
  overlayClearRadius: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.32,
    category: 'Overlay',
    label: 'Clear centre radius',
    help: "How far from the exact centre of the frame stays free of grime, so the middle of the shot — where the player's eye and the action usually sit — never reads as dirty. 0 lets grime cover the whole frame including dead centre.",
  },
  overlayClearSoftness: {
    type: 'float',
    min: 0.02,
    max: 1,
    step: 0.01,
    default: 0.4,
    category: 'Overlay',
    label: 'Clear edge softness',
    help: 'How gradually the clear centre above blends into the full grime outside it, rather than cutting off in a visible ring. Larger values spread the transition further across the frame.',
  },
  overlayDriftSpeed: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.2,
    category: 'Overlay',
    label: 'Drift speed',
    help: 'How quickly the grime texture itself wobbles across the glass — enough restrained motion that it never reads as a static decal painted on the screen, without ever travelling far. 0 freezes it in place.',
  },
  overlayCycleSeconds: {
    type: 'float',
    min: 5,
    max: 300,
    step: 1,
    default: 45,
    category: 'Overlay',
    label: 'Cycle time',
    help: "How many seconds one image from this module's grime library stays current before the catalog moves on to the next one, looping back to the start once every image has had a turn.",
  },
  overlayCrossfadeSeconds: {
    type: 'float',
    min: 0.5,
    max: 30,
    step: 0.5,
    default: 4,
    category: 'Overlay',
    label: 'Crossfade time',
    help: 'How many seconds the transition to the next image in the cycle above takes, so the catalog advancing never reads as a hard cut. Clamped to the cycle time above — it can never outlast the cycle it belongs to.',
  },
});

/** The schema defaults as a flat object. */
const LENS_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(LENS_PARAMS).map(([k, decl]) => [k, decl.default]))
);

/** No named presets ship yet — V2's own were bundled with its full 4-channel
 * overlay catalog, which this basic v1 does not attempt to match (see this
 * module's own header for the scope split).
 * @type {Record<string, Record<string, number|boolean>>} */
export const LENS_PRESETS = Object.freeze({ none: {} });

/**
 * THE OVERLAY CATALOG — every bundled grime/dust/light-leak image, in the
 * fixed order `overlayCycleSeconds` walks through (mythica-machina-press#57).
 *
 * A hardcoded list, deliberately NOT discovered at runtime the way an
 * author's own painted masks are (`foundry/mask-discovery.js`'s own
 * `FilePicker` scan): these 13 files ship WITH this module — fixed, known,
 * version-controlled content, not per-map author content a GM could add to
 * or rename. `foundry/mask-discovery.js`'s whole reason to exist is that an
 * author's files are NOT known in advance; that reason does not apply here,
 * so a static list is the simpler, equally-correct mechanism (`vt/lens-
 * overlay-image.js`'s own header expands on why the mask-discovery path
 * would be the wrong tool even though it superficially "scans a folder"
 * too).
 *
 * Order matches how the files were introduced by `attribution.md`'s own
 * grouping (dust, grease, leak, overlay, scratches, light-leak, rainbow-
 * chroma) — arbitrary but stable, which is all a uniform, semantics-free
 * cycle needs.
 *
 * @type {readonly string[]}
 */
export const LENS_OVERLAY_CATALOG = Object.freeze([
  'lens_dust_01.jpg',
  'lens_grease_01.jpg',
  'lens_grease_02.jpg',
  'lens_grease_03.jpg',
  'lens_leak_01.jpg',
  'lens_leak_02.jpg',
  'lens_overlay_01.jpg',
  'lens_overlay_02.jpg',
  'lens_scratches_01.jpg',
  'light_leak_01.jpg',
  'light_leak_02.jpg',
  'rainbow_chroma_01.jpg',
  'rainbow_chroma_02.jpg',
]);

/**
 * Resolve a named preset to a full params object. Kept as a real function
 * even with no presets defined yet, matching bloomPreset/waterPreset's own
 * shape, so a caller never has to special-case "this effect has no presets".
 * @param {string} name
 * @returns {Record<string, number|boolean>}
 */
export function lensPreset(name) {
  return { ...LENS_DEFAULTS, ...(LENS_PRESETS[name] || {}) };
}

/**
 * The manifest.
 *
 * `visualWeight: 0.35` — a real, deliberate mood tool (the same class as
 * grade/stylize), but never the scene's own substance the way water/fire
 * are — low enough to be defended first under budget, high enough to not
 * read as decorative chrome.
 *
 * `a11y.photosensitive: false` for the tier-0 optics (a static vignette/
 * fringe and slow-drifting grain carry no flicker). ⚠️ AUTOFOCUS PULSES
 * (tier 1) ARE A BRIGHTNESS/SHARPNESS CHANGE EVERY FEW SECONDS TO MINUTES AT
 * MINIMUM — nowhere near the 3–30 Hz strobe band by construction (V2's own
 * fastest interval is 10 s between pulses, each pulse a smooth 2-second
 * envelope), so this stays a real, considered judgement rather than a
 * flicker risk, not a flag to revisit at a faster tier the way fluid's own
 * bubbles/emission tiers have to.
 *
 * ⚠️ `enabledFromProfile: 'extreme'` — CHANGED 2026-09-16, mythica-machina-press#556,
 * author direct instruction: "the lens effect is nice but it needs to be
 * fine tuned and off by default." Was `'low'` (`PERFORMANCE_PROFILES[0]`,
 * the very bottom) — every player at every profile got camera-glass
 * distortion, chromatic aberration and film grain imposed on their view
 * with no choice in the matter, the only manifest in this codebase gated
 * that permissively. `enabledFromProfile` is this system's ONLY
 * on-by-default axis (`effect-manifest.js`'s own doc; there is no separate
 * "default enabled" flag) — `'extreme'`, the top of {@link
 * import('./effect-cascade.js').PERFORMANCE_PROFILES}, is what makes an
 * effect need a DELIBERATE choice rather than come along for the ride with
 * unrelated quality settings a GM cranked up for better water or clouds.
 * This does not remove the look: `effect-cascade.js#resolveEffectEnabled`'s
 * `gmEnable`/`playerEnable` override still turns it on for any scene whose
 * GM actually wants it, at any profile — the Studio effect switch is that
 * override, live. Off by default; on by choice.
 *
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const LENS = Object.freeze({
  id: 'lens',
  title: 'Lens',
  visualWeight: 0.35,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'extreme',
  readiness: Object.freeze({
    firstRunWork: false,
    coverage: 'none',
    why: "A post pass over buffers the frame graph already owns, same posture as bloom's own readiness doc: no masks to bake, no assets to load below tier 2. Tier 2 (light burn) allocates a small persistent render-target pair on first use, covered by settle.js's pipeline-growth criterion rather than a dedicated probe, matching bloom's reasoning for its own pipeline-compilation cost. Tier 3 (overlay) DOES fetch a real bundled asset on first use (`vt/lens-overlay-image.js`) — deliberately NOT wired into a settle.js probe of its own (unlike `post.grade`'s named `gradeLut` probe for its own bundled `.cube` fetch): Lens is off by default at every profile short of `extreme`, the overlay sub-feature defaults off even once Lens itself is on, and the look it adds is a slow-cycling decorative layer, not a scene-defining look a visible pop would be jarring for the way a LUT swap is. A cold first load shows no overlay for one fetch's worth of latency, then fades in on its own next natural crossfade — a degraded-but-honest first frame, the same posture `vt/baked-textures.js`'s own header states for a missing bake, never a broken one.",
  }),
  params: LENS_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'optics',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.05 }),
      adds:
        'THE GLASS ITSELF, unconditional whenever the effect is on: radial distortion (one warped UV, ' +
        'reused by every later tap so nothing samples a different lens shape than the rest), edge-weighted ' +
        'chromatic aberration (two extra taps on the distorted UV, red/blue only — green stays the ' +
        "reference channel, V2's own convention), a screen-space vignette, and film grain / optional " +
        'digital noise (one cell hash, luma-adaptive). One fullscreen pass over `buf:scene.lit` — no new ' +
        'render target of its own, the SAME "read the frame, write a transformed copy" shape ' +
        '`post.taaResolve` already established, re-pointing present at the result rather than a second ' +
        'write into scene.lit itself.',
    }),
    Object.freeze({
      n: 1,
      name: 'motion',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C2', estMsPerMp: 0.03 }),
      adds:
        "Autofocus defocus pulses (a real timer + a zoom-triggered version, both ported from V2's own " +
        "exact easing/scheduling — `lens-motion.js`'s own header) and camera pan/zoom motion blur " +
        "(the viewer's own real frame-to-frame camera delta, smoothed and clamped, V2's own formula). " +
        'Both are UNIFORM-gated at zero cost on the overwhelming majority of frames (no pulse active, ' +
        'camera not moving) rather than compiled out entirely — Effects.md`s own "a per-frame amount, not ' +
        'a per-tier structural change" shape, the same one meniscus/foam already use elsewhere in this ' +
        'codebase — but the TAPS themselves (a 9-sample Kawase blur for the pulse, two extra directional ' +
        'samples for motion) only exist in the compiled graph from this tier up, which is the real reason ' +
        'this is its own rung rather than folded into tier 0.',
    }),
    Object.freeze({
      n: 2,
      name: 'light-burn',
      fromProfile: 'quality',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.06 }),
      adds:
        "A genuine persistence buffer: a small (V2's own quarter-resolution) ping-ponged accumulator, " +
        'one extra render pass per frame this tier is active — `max(previous · decay, freshBrightPass)`, ' +
        "V2's own exact formula, decay derived from a real seconds-based half-life rather than a raw " +
        "per-frame multiplier so it reads the same at any framerate. C4, not tier 0/1's C2: a real extra " +
        "draw call and a real extra pair of resident textures, the same class of cost fluid's own tier 4 " +
        '(`fill`) is priced at for the identical reason — a dependent read against STATE, not pure ALU on ' +
        'values already in registers.',
    }),
    Object.freeze({
      n: 3,
      name: 'overlay',
      fromProfile: 'extreme',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.04 }),
      adds:
        "THE GRIME CATALOG — a basic v1 of V2's overlay layer (this module's own header has the full " +
        'scope split): two extra texture taps (the current and next catalog image, cross-faded) at plain ' +
        'screen UV, a luma-reactive intensity term reusing the SAME `sceneLuma` tier 0 already computes, ' +
        'a clear-radius mask, and a small in-shader UV drift — additively composited straight after ' +
        "motion and before light burn, matching V2's own real ordering exactly (`lens-shader.js`'s own " +
        'execution-order header, recovered from git history). Gated to `extreme` — one profile ABOVE ' +
        "where Lens itself first turns on by default and matching light-burn's own ceiling — because " +
        "it is the single least load-bearing piece of the effect (an author's own framing: the overlay " +
        'catalog was the LOWEST-priority remaining gap on all of Lens). C4, matching tier 2: not because ' +
        "the ALU here is expensive on its own (it genuinely is not — closer to tier 0/1's C2), but Law 3 " +
        'requires a rung above light-burn to cost AT LEAST as much as light-burn, and two dependent texture ' +
        'reads keyed off a runtime-selected catalog index is a real instance of the same "dependent read" ' +
        "shape tier 2's own note describes, not just a conservative label.",
    }),
  ]),
  // Nothing deferred — the overlay catalog (this module's own header has the
  // full "basic v1 vs V2" scope split) is the piece that used to be recorded
  // here; it is now tier 3 above. `Object.freeze([])`, not an omitted field,
  // mirrors precipitation.js's own "nothing left to defer" declaration.
  deferredRungs: Object.freeze([]),
});
