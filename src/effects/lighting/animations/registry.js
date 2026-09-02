/**
 * THE ANIMATED-LIGHTS REGISTRY — the single, neat home for every "animated
 * light" style, mirroring Foundry's own `CONFIG.Canvas.lightAnimations`
 * (docs/reference/foundry-v14-light-animations-audit.md is the per-animation
 * implementation reference; docs/planning/Light-Parity.md §5's last item).
 *
 * Keyed by the EXACT string Foundry stores on `LightData.animation.type`
 * (`torch`, `pulse`, `chroma`, …) — no remapping layer, so a lookup is a
 * direct `LIGHT_ANIMATIONS[light.animation.type]` (see `resolveLightAnimation`
 * below). A key that is absent from this map means exactly one of two things,
 * distinguished by `KNOWN_DEFERRED_ANIMATIONS`:
 *   - a real, Foundry-valid animation type this project hasn't ported yet
 *     (listed there, with why), or
 *   - a genuinely unrecognized string (a future Foundry version, a modded
 *     animation type, a data error).
 * EITHER WAY the light safety-slides to today's default non-animated look —
 * never a crash, never a black light (matches feedback_safety_slide_
 * outranks_doctrine memory). `resolveLightAnimation` is the one door that
 * distinction is read through, so a diagnostic can tell them apart without
 * every call site re-deriving it.
 *
 * ENTRY SHAPE:
 *   label             - human-readable, matching Foundry's own i18n label,
 *                        for diagnostics only (never shown as MSA-authored UI
 *                        — Foundry's native config sheet already has it).
 *   cpuDriver         - 'time' | 'flicker' | 'pulse'. Which of light-
 *                        animation-clock.js's functions computes this
 *                        animation's per-frame uniforms (every animation
 *                        needs `computeAnimationTime`; `flicker`/`pulse`
 *                        additionally need computeFlickerUniforms/
 *                        computePulseUniforms and a jittered `ratio`).
 *   flickerAmplification - ONLY for `cpuDriver: 'flicker'` entries:
 *                        `(intensityRaw: number) => number`, the
 *                        `amplification` computeFlickerUniforms needs.
 *                        Verified against source (docs/reference/foundry-
 *                        v14-light-animations-audit.md §1.3): torch/siren's
 *                        `animateTorch` wraps the flicker primitive with
 *                        `intensity/5`, but flame calls the primitive
 *                        DIRECTLY (amplification fixed at `1`, ignoring
 *                        intensity) — a real per-animation divergence, not
 *                        a shared constant.
 *   forceDefaultColor - per docs/reference/foundry-v14-light-animations-
 *                        audit.md's `forceDefaultColor` roster: true means
 *                        this animation's coloration mesh must draw even on
 *                        a COLOURLESS light (the animation supplies its own
 *                        colour) — flips MSA's existing colourless-light
 *                        gate in vt-pan-viewer.js.
 *   buildIlluminationSeed / buildColorationSeed
 *                     - `({THREE, ...scaffoldTerms}) => TSLNode`, or `null`
 *                        if this animation never touches that channel (a
 *                        real, permanent null — e.g. chroma is coloration-
 *                        only — never "not built yet"; an unbuilt animation
 *                        simply has no entry at all, per the map-absence
 *                        rule above). Replaces ONLY the seed color line in
 *                        point-light-illumination.js / point-light-
 *                        coloration.js — everything downstream (exposure,
 *                        the coloration `reflection` technique multiply,
 *                        falloff, soft-edge, background mix, MAX-blending)
 *                        is the EXISTING scaffold, reused unchanged.
 *
 * @module effects/lighting/animations/registry
 */

import { buildTorchIlluminationSeed, buildTorchColorationSeed } from './torch.js';
import { buildPulseIlluminationSeed, buildPulseColorationSeed } from './pulse.js';
import { buildChromaColorationSeed } from './chroma.js';
import { buildFlameIlluminationSeed, buildFlameColorationSeed } from './flame.js';
import { buildEnergyColorationSeed } from './energy.js';
import { buildRevolvingColorationSeed } from './revolving.js';
import { buildSirenIlluminationSeed, buildSirenColorationSeed } from './siren.js';
import { buildWaveIlluminationSeed, buildWaveColorationSeed } from './wave.js';
import { buildFogColorationSeed } from './fog.js';
import { buildSunburstIlluminationSeed, buildSunburstColorationSeed } from './sunburst.js';
import { buildDomeColorationSeed } from './dome.js';
import { buildEmanationColorationSeed } from './emanation.js';
import { buildHexaColorationSeed } from './hexa.js';
import { buildGhostIlluminationSeed, buildGhostColorationSeed } from './ghost.js';
import { buildVortexColorationSeed } from './vortex.js';
import { buildWitchwaveIlluminationSeed, buildWitchwaveColorationSeed } from './witchwave.js';
import { buildRainbowswirlColorationSeed } from './rainbowswirl.js';
import { buildRadialrainbowColorationSeed } from './radialrainbow.js';
import { buildFairyIlluminationSeed, buildFairyColorationSeed } from './fairy.js';
import { buildGridColorationSeed } from './grid.js';
import { buildStarlightColorationSeed } from './starlight.js';
import { buildSmokepatchIlluminationSeed, buildSmokepatchColorationSeed } from './smokepatch.js';
import {
  buildCandleFlickerIlluminationSeed,
  buildCandleFlickerColorationSeed,
  buildFirePuffColorationSeed,
} from './candle-flicker.js';

/**
 * Real, Foundry-valid animation keys this project has deliberately not
 * ported yet, with why — so a diagnostic (getPointLightsInfo) can say
 * "known, deferred" instead of "unrecognized", and so nobody re-discovers
 * these gaps by surprise. Not a technical gate (an absent registry key
 * already safety-slides correctly on its own) — a documentation aid.
 *
 * EXPLICITLY LOW-PRIORITY, NOT FORGOTTEN (author's own direction,
 * 2026-07-20): all 5 of these are real TODOs, tracked here on purpose,
 * deliberately skipped for now rather than silently dropped. Pick this
 * doc entry back up before considering the animated-lights rung "done" —
 * it isn't, these 5 are the honest remainder.
 */
export const KNOWN_DEFERRED_ANIMATIONS = Object.freeze({
  reactivepulse:
    'TODO, LOW PRIORITY: needs live game.audio band-level data — a separate foundry/-adapter rung, not the intensity/speed sliders this feature is about',
  magicalGloom:
    'TODO, LOW PRIORITY: darkness animation — blocked on MSA having no negative/darkness-light channel yet (Light-Parity.md §5 sequences that above animations)',
  roiling: 'TODO, LOW PRIORITY: darkness animation — same blocker as magicalGloom',
  hole: 'TODO, LOW PRIORITY: darkness animation — same blocker as magicalGloom',
  denseSmoke: 'TODO, LOW PRIORITY: darkness animation — same blocker as magicalGloom',
});

/**
 * LIGHT_ANIMATIONS — grows one entry per ported animation (see this
 * module's own header for the entry shape). Intentionally starts empty:
 * a stub entry with no real builders would be a silent lie about what's
 * actually built, which is exactly what the map-absence safety-slide rule
 * above is designed to avoid.
 * @type {Record<string, {label: string, cpuDriver: 'time'|'flicker'|'pulse',
 *   forceDefaultColor: boolean,
 *   buildIlluminationSeed: (Function|null), buildColorationSeed: (Function|null)}>}
 */
export const LIGHT_ANIMATIONS = {
  // TIER 0 (2026-07-20) — one representative per CPU driver / noise family,
  // built and live-verified first per docs/planning's own build order
  // before the remaining light animations follow the same proven pattern.
  torch: {
    label: 'Torch',
    cpuDriver: 'flicker',
    // torch/siren's animateTorch wrapper: amplification = intensity/5
    // (light-animation-clock.js#computeFlickerUniforms's own header).
    flickerAmplification: (intensityRaw) => intensityRaw / 5,
    forceDefaultColor: false,
    // GPU-ONLY REWRITE (2026-07-20): now a REAL builder — see torch.js's own
    // header for why the old "needs no shader change" trick no longer
    // applies once ratio-jitter itself moved onto the GPU.
    buildIlluminationSeed: buildTorchIlluminationSeed,
    buildColorationSeed: buildTorchColorationSeed,
  },
  pulse: {
    label: 'Pulse',
    cpuDriver: 'pulse',
    forceDefaultColor: false,
    buildIlluminationSeed: buildPulseIlluminationSeed,
    buildColorationSeed: buildPulseColorationSeed,
  },
  chroma: {
    label: 'Chroma',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: null, // coloration-only
    buildColorationSeed: buildChromaColorationSeed,
  },
  flame: {
    label: 'Flame',
    cpuDriver: 'flicker',
    // flame calls animateFlickering DIRECTLY — amplification stays fixed at
    // 1 regardless of intensity (light-animation-clock.js's own header).
    flickerAmplification: () => 1,
    forceDefaultColor: false,
    buildIlluminationSeed: buildFlameIlluminationSeed,
    buildColorationSeed: buildFlameColorationSeed,
  },
  energy: {
    label: 'Energy Field',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: null, // coloration-only
    buildColorationSeed: buildEnergyColorationSeed,
  },
  /**
   * FIRE's cast light (docs/planning/Fire.md). Shares `candleFlicker`'s
   * illumination builder verbatim rather than inventing a second wind-aware
   * shader — same philosophy as the original `firePuff` (the difference
   * between a candle and a bonfire is the DESCRIPTOR: radius, luminosity,
   * ratio, `quality`), just pointed at MSA's own richer noise instead of
   * Foundry's generic `flame` torch shader.
   *
   * ⚠️ RE-POINTED FROM `flame` TO `candleFlicker`, 2026-08-09, AUTHOR'S OWN
   * DIRECTION: *"adjust fire light to work more like candle light."* `flame`
   * (Foundry's stock torch noise, still used verbatim by `torch`/`siren`) has
   * NO wind coupling at all — no lean, no gutter, no snuff — despite
   * `buildFireLightSources` computing and shipping `windExposure`/
   * `windResponse` on every fire light descriptor. Those fields were being
   * built, carried, and read by nothing (`feedback_unconsumed_api_rots_
   * silently`, same bug class this file already names for the OLD `firePuff`
   * missing an entry at all). `candleFlicker`'s builders already accept
   * `wind`/`windResponse` generically from the scaffold
   * (`point-light-illumination.js` builds and passes them to WHICHEVER
   * animation is active, not specially for candles) and fire's descriptor
   * already carries `quality` in the exact 0..2 range `candleFlicker` expects
   * (`buildFireLightSources`'s own `quality: clampNum(..., 0, 2)`) — so this
   * was a pure re-point, no scaffold or descriptor change required.
   *
   * ⚠️ COLORATION SPLIT FROM CANDLE'S OWN, 2026-09-02
   * (mythica-machina-press#475, author-reported: "the light a fire throws is
   * white"). `buildCandleFlickerColorationSeed`'s `coreFade` narrows the
   * visible tint to roughly the inner half of the light's OWN radius — a
   * deliberate "fine point at the wick" for a candle, but fire's radii are
   * documented elsewhere as substantially larger (`fire-geometry.js#cluster
   * FireSources`'s own header: "Fire's radii are LARGER"), so the same
   * fraction-of-radius core left most of a fire's glow reading as plain,
   * colourless brightness. `buildFirePuffColorationSeed` (`candle-flicker.js`)
   * keeps the identical warm↔cool temperature swing and guttering pulse but
   * drops `coreFade`/`candleShape` entirely, so the tint rides the same
   * single `falloff` illumination already uses. Illumination is UNCHANGED
   * (still `buildCandleFlickerIlluminationSeed`) — the brightness/guttering
   * look was never the reported problem, only the hue's reach was.
   *
   * ⚠️ REGISTERED BECAUSE AN UNREGISTERED TYPE IS NOT INERT — IT IS FEATURELESS.
   * `resolveLightAnimation` returns null for an unknown string, and the pool's
   * `if (animation?.buildIlluminationSeed)` then skips the whole animated
   * branch. That safety-slides to a STATIC light (correct, never a crash — the
   * header above promises exactly this) but it also silently skips the WIND
   * uniforms, which are built inside that same branch — exactly the gap this
   * entry closes.
   */
  firePuff: {
    label: 'Fire Puff',
    cpuDriver: 'flicker',
    flickerAmplification: () => 1,
    forceDefaultColor: false,
    buildIlluminationSeed: buildCandleFlickerIlluminationSeed,
    buildColorationSeed: buildFirePuffColorationSeed,
  },

  // TIER 1 (2026-07-20) — the remaining 17 light animations, same proven
  // pattern as Tier 0. `siren` is the one Tier-1 entry sharing torch's
  // flicker driver (animateTorch, amplification=intensity/5 — see
  // light-animation-clock.js's own header on why this must be explicit
  // per-entry, not derived).
  revolving: {
    label: 'Revolving',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: null, // coloration-only
    buildColorationSeed: buildRevolvingColorationSeed,
  },
  siren: {
    label: 'Siren',
    cpuDriver: 'flicker',
    flickerAmplification: (intensityRaw) => intensityRaw / 5,
    forceDefaultColor: false,
    buildIlluminationSeed: buildSirenIlluminationSeed,
    buildColorationSeed: buildSirenColorationSeed,
  },
  wave: {
    label: 'Wave',
    cpuDriver: 'time',
    forceDefaultColor: false,
    buildIlluminationSeed: buildWaveIlluminationSeed,
    buildColorationSeed: buildWaveColorationSeed,
  },
  fog: {
    label: 'Fog',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: null, // coloration-only
    buildColorationSeed: buildFogColorationSeed,
  },
  sunburst: {
    label: 'Sunburst',
    cpuDriver: 'time',
    forceDefaultColor: false,
    buildIlluminationSeed: buildSunburstIlluminationSeed,
    buildColorationSeed: buildSunburstColorationSeed,
  },
  dome: {
    label: 'Light Dome',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: null, // coloration-only
    buildColorationSeed: buildDomeColorationSeed,
  },
  emanation: {
    label: 'Emanation',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: null, // coloration-only
    buildColorationSeed: buildEmanationColorationSeed,
  },
  hexa: {
    label: 'Hexa Dome',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: null, // coloration-only
    buildColorationSeed: buildHexaColorationSeed,
  },
  ghost: {
    label: 'Ghost Light',
    cpuDriver: 'time',
    forceDefaultColor: false,
    buildIlluminationSeed: buildGhostIlluminationSeed,
    buildColorationSeed: buildGhostColorationSeed,
  },
  vortex: {
    label: 'Vortex',
    cpuDriver: 'time',
    forceDefaultColor: true,
    // Illumination is CONFIRMED DEAD CODE in Foundry itself (vortex.js's
    // own header) — null, not a stub, matching torch's own "needs no
    // shader change" pattern for the SAME reason a real Foundry light
    // there would look unanimated.
    buildIlluminationSeed: null,
    buildColorationSeed: buildVortexColorationSeed,
  },
  witchwave: {
    label: 'Bewitching Wave',
    cpuDriver: 'time',
    forceDefaultColor: false,
    buildIlluminationSeed: buildWitchwaveIlluminationSeed,
    buildColorationSeed: buildWitchwaveColorationSeed,
  },
  rainbowswirl: {
    label: 'Swirling Rainbow',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: null, // coloration-only
    buildColorationSeed: buildRainbowswirlColorationSeed,
  },
  radialrainbow: {
    label: 'Radial Rainbow',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: null, // coloration-only
    buildColorationSeed: buildRadialrainbowColorationSeed,
  },
  fairy: {
    label: 'Fairy Light',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: buildFairyIlluminationSeed,
    buildColorationSeed: buildFairyColorationSeed,
  },
  grid: {
    label: 'Force Grid',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: null, // coloration-only
    buildColorationSeed: buildGridColorationSeed,
  },
  starlight: {
    label: 'Star Light',
    cpuDriver: 'time',
    forceDefaultColor: true,
    buildIlluminationSeed: null, // coloration-only
    buildColorationSeed: buildStarlightColorationSeed,
  },
  smokepatch: {
    label: 'Smoke Patch',
    cpuDriver: 'time',
    forceDefaultColor: false,
    buildIlluminationSeed: buildSmokepatchIlluminationSeed,
    buildColorationSeed: buildSmokepatchColorationSeed,
  },

  // MSA-NATIVE (not a Foundry key) — see candle-flicker.js's own header.
  // A distinct type from `torch` on purpose: candles are meant to be
  // enhanced independently later without dragging Foundry's own Torch
  // along for the ride.
  candleFlicker: {
    label: 'Candle Flicker (MSA)',
    cpuDriver: 'flicker',
    flickerAmplification: (intensityRaw) => intensityRaw / 5,
    forceDefaultColor: false,
    buildIlluminationSeed: buildCandleFlickerIlluminationSeed,
    buildColorationSeed: buildCandleFlickerColorationSeed,
  },
};

/**
 * The one door: look up an animation type's registry entry.
 * @param {string|null} type - `light.animation.type` (foundry/scene-lights.js).
 * @returns {{label: string, cpuDriver: string, forceDefaultColor: boolean,
 *   buildIlluminationSeed: (Function|null), buildColorationSeed: (Function|null)}|null}
 *   `null` for no animation, an unported-but-known type, or a genuinely
 *   unrecognized one — callers that need to tell those apart for a
 *   diagnostic use `KNOWN_DEFERRED_ANIMATIONS` directly.
 */
export function resolveLightAnimation(type) {
  if (!type) return null;
  return LIGHT_ANIMATIONS[type] ?? null;
}
