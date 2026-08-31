/**
 * PRECIPITATION's declaration — the manifest and PRECIPITATION_PARAMS.
 *
 * ⚠️ THE LAST EFFECT WITHOUT ONE (2026-08-30). Precipitation shipped P1 LIVE
 * and P2-P7 `BUILT` without ever passing through `effect-cascade.js`/
 * `registry.js` — confirmed by the original tier-gradient audit
 * (docs/planning/Effect-Tier-Gradient-Audit-2026-08-29.md §3.4) as a real,
 * structural gap: no GM/player enable override, no `a11y.photosensitive`
 * gate, and its own "budget multiplier" (`precipTierScaleForProfile`,
 * `precip-species.js`) read the raw performance-profile SETTING directly
 * rather than going through the real resolver every other effect uses.
 *
 * PRECIPITATION_PARAMS IS DELIBERATELY EMPTY. Precipitation's "look" — which
 * species falls, how hard (`precip01`) — is WEATHER-MANAGER state
 * (`MapShine.setPrecip`/`setPrecipKind`/`setPrecipitationTuning`, boot.js),
 * not a per-scene author dial the way water's `tint` or window's dawn/dusk
 * colours are: the astrolabe's own weather shelf sets it, not a card on this
 * effect. Inventing author-facing params here that don't correspond to an
 * actual, already-decided design would be exactly the unrequested scope this
 * project's own conventions warn against — an empty schema is a legitimate,
 * precedented state (`FLUID_PARAMS` shipped this way too, before that effect
 * had any real params). What genuinely belongs to THIS manifest — enable/
 * disable, the a11y gate, the tier ladder — is declared below regardless.
 *
 * `visualWeight`/`cost.estMsPerMp` below are REASONABLE, UNMEASURED
 * estimates, not a bench result — no `tools/shader-lab` bench exists for
 * this effect yet. Stated plainly rather than left to look more authoritative
 * than they are (`feedback_instruments_must_not_lie`), the same discipline
 * fire's own manifest already states for its identical gap.
 *
 * @module effects/precipitation/precipitation
 */

/** See this file's own header for why this is empty rather than guessed. */
export const PRECIPITATION_PARAMS = Object.freeze({});

export const PRECIPITATION = Object.freeze({
  id: 'precipitation',
  title: 'Precipitation',
  // Covers the whole viewport when active, the same "dominates the screen,
  // not a localised decoration" shape water's own 0.8 already reflects —
  // unlike a single fire or fluid tube, weather has no natural "small" case.
  visualWeight: 0.7,
  a11y: Object.freeze({
    photosensitive: false,
    // A future flash/lightning-adjacent species (the audit's own §3.4 named
    // this risk) would need this flipped true — recorded here so the gate
    // exists to flip, not invented from scratch the day it's actually needed.
  }),
  // On at every profile, matching what this effect ALREADY does today
  // (`getPrecipRenderState()` hardcoded `enabled: true` unconditionally,
  // vt-pan-viewer.js) — this manifest FORMALISES that behaviour, it does
  // not change it. Low still gets real, visible weather (tier 0 below),
  // just fewer live particles — the same "still visible, minimal cost"
  // shape this whole audit exists to find for every effect.
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'none',
    why:
      'Builds its species curtains, arrival/splash engines, mantle buffers and drip engines lazily on first ' +
      'use per floor (precip-subsystem.js) — no dedicated probe; covered by settle.js`s own frame-steadiness ' +
      'and pipeline-growth criteria, the same posture fluid`s own readiness declares for the identical reason.',
  }),
  params: PRECIPITATION_PARAMS,
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.1 }),
      adds:
        'the floor every profile gets: rain/snow/etc. genuinely falls, at 40% of the shipped live-particle ' +
        'count (precipTierPlan(0).tierScale, precip-species.js) — real weather at the cheapest setting this ' +
        'effect has.',
    }),
    Object.freeze({
      n: 1,
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.18 }),
      adds: 'live-particle count rises to 70% of shipped',
    }),
    Object.freeze({
      n: 2,
      fromProfile: 'standard',
      cost: Object.freeze({ class: 'C7', estMsPerMp: 0.25 }),
      adds: 'live-particle count reaches its own ceiling — 100% of shipped, unchanged above this rung',
    }),
  ]),
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'authorSchema',
      note:
        'per-scene author-facing look params (e.g. a scene-specific intensity/density multiplier layered on ' +
        'top of the weather manager`s own precip01) — genuinely new design, not declared here because no such ' +
        'control has been designed yet; PRECIPITATION_PARAMS stays empty until one is.',
    }),
  ]),
});
