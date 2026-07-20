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

import { buildTorchColorationSeed } from './torch.js';
import { buildPulseIlluminationSeed, buildPulseColorationSeed } from './pulse.js';
import { buildChromaColorationSeed } from './chroma.js';
import { buildFlameIlluminationSeed, buildFlameColorationSeed } from './flame.js';
import { buildEnergyColorationSeed } from './energy.js';

/**
 * Real, Foundry-valid animation keys this project has deliberately not
 * ported yet, with why — so a diagnostic (getPointLightsInfo) can say
 * "known, deferred" instead of "unrecognized", and so nobody re-discovers
 * these gaps by surprise. Not a technical gate (an absent registry key
 * already safety-slides correctly on its own) — a documentation aid.
 */
export const KNOWN_DEFERRED_ANIMATIONS = Object.freeze({
  reactivepulse:
    'needs live game.audio band-level data — a separate foundry/-adapter rung, not the intensity/speed sliders this feature is about',
  magicalGloom:
    'darkness animation — blocked on MSA having no negative/darkness-light channel yet (Light-Parity.md §5 sequences that above animations)',
  roiling: 'darkness animation — same blocker as magicalGloom',
  hole: 'darkness animation — same blocker as magicalGloom',
  denseSmoke: 'darkness animation — same blocker as magicalGloom',
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
    buildIlluminationSeed: null, // needs no shader change at all — torch.js's own header
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
