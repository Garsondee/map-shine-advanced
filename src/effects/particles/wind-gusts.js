/**
 * WIND GUSTS — a small population of RIBBON TRAILS ("wind snakes") that trace
 * the wind field's actual flow, appearing ONLY where the local flow is
 * genuinely fast (author request, 2026-07-22). This is NOT the wind diagnostic
 * particles ([[wind-diagnostic-particles.js]]) and NOT a replacement for them:
 * that system is a debug-only cloud of dots that makes the field legible
 * everywhere; THIS one is an atmospheric dressing effect — a few curved streaks
 * that whoosh through the windiest parts of the map so a player can see, at a
 * glance, where the wind is blowing hard.
 *
 * WHY A SEPARATE DECLARATION + ENGINE (not a `drawStyle` on the dot engine):
 * a ribbon is a genuinely different draw primitive than a billboard dot — it
 * needs a per-trail HISTORY of recent positions and a strip mesh threaded
 * through them, none of which the dot engine has. Bolting a second mode onto
 * the (heavily battle-scarred) `particle-runtime.js` would fork that file
 * internally — exactly the "mode fork silently drops features" bug class this
 * codebase has proven three times. Instead, Wind Gusts gets its own thin
 * runtime (`gust-runtime.js`) that REUSES the real shared engine — the arena
 * (`particle-arena.js`), the one wind-sampling door (`world/wind-field.js#
 * sampleWind`), and the same baked `openness` grid the diagnostic particles,
 * candle and overlay all read. Same engine, different costume.
 *
 * PLACEMENT — "anywhere the flow is fast" (author's chosen gate, 2026-07-22):
 * visibility keys on the magnitude of the TOTAL flow at each trail's head —
 * coherent (ambient × openness — 2026-07-22, THE RETHINK, docs/planning/
 * Wind-Rethink.md §4: see world/wind-field.js's own header for why ambient is
 * gated by geometry, never damped-then-cancelled) PLUS turbulence
 * (2026-07-23, author: "add turbulence to the wind gusts/ribbons too" — see
 * gust-runtime.js's own checklist item 6 and world/wind-field.js#
 * computeWindTurbulence for the design), the same two ingredients the wind
 * overlay and diagnostic particles now both read too. That magnitude is
 * large in open strong wind AND right at a chaotic doorway transition, zero
 * in sealed pockets and calm air — so gusts naturally light up open gales
 * and doorway turbulence alike without any explicit "outdoors" test, and
 * stay absent where there is nothing to show. STILL NOT built: any
 * bend/funnelling around obstacles from a genuine flow SOLVE (the
 * potential-flow relaxation that used to produce that is deleted — see
 * wind-bake.js's own header; wall AVOIDANCE, a different and now-built
 * mechanism, is separate — see deflectAroundWalls).
 *
 * "A FEW, MORE + STRONGER WHEN WIND IS HIGHER": the number of ACTIVE trails
 * scales with the scene's live `windSpeed01` dial (a handful at breeze, up to
 * `maxTrails` at gale — see gust-runtime.js's `uActiveTrails`), and each trail's
 * length/brightness follow its own local flow, so a calm scene shows an empty
 * sky and a gale fills it with taut snakes.
 *
 * DEBUG/OPT-IN, OFF BY DEFAULT for now — gated behind a `wind-gusts-toggle`
 * debug action, the same idiom as the wind overlay and the diagnostic particles.
 * (This is the logged exception to "default new features ON": like the diagnostic
 * particles it is wind-tooling that a scene should not pay for unopened, and it
 * has never been live-seen yet.) Construction is DEFERRED to first enable — a
 * scene nobody opens the toggle for allocates no arena and compiles no kernel.
 *
 * Validates against `validateParticleSystem` today (declaration before
 * implementation, the same order the schema/arena/diagnostic all took). The
 * engine that consumes it (`gust-runtime.js`) reads these fields; nothing here
 * knows about the GPU.
 *
 * @module effects/particles/wind-gusts
 */

/** @type {import('./particle-system-schema.js').ParticleSystemDecl} */
export const WIND_GUSTS = {
  id: 'weather.windGusts',
  // A real atmospheric effect (unlike the 0.4 diagnostic cloud), so the governor
  // defends it a little harder when the frame budget shrinks — but it is still
  // dressing, not gameplay, so nowhere near a 1.0.
  visualWeight: 0.5,
  emitter: { shape: 'circle' }, // heads seed across the view rect (area spawn)
  behaviors: [
    { type: 'smartWind', params: { gain: 0.9 } }, // heads ride res:wind via sampleWind()
    { type: 'sizeOverLife' }, // declared for the ladder; the ribbon's own taper is draw-side
    { type: 'colorOverLife' }, // ditto
  ],
  spawn: { kind: 'area' },
  // The one dependency, sampled through the door (world/wind-field.js#sampleWind
  // + the baked structure/exposure grids), never re-invented as private noise.
  reads: ['res:wind'],
  tiers: [
    { n: 0 }, // absent (no gusts)
    { n: 1 }, // ribbons exist — follow the coherent flow (THE first-slice rung)
    { n: 2 }, // more trails + longer memory
    { n: 3 }, // curl-noise wobble on the ribbon spine
  ],
  // Tuned values — the author's taste, read by the engine as uniforms (kept here,
  // not hard-coded in the kernel, so they become FOH/ROH dials later, §19).
  params: {
    // ARENA: one row per TRAIL (its head is a normal particle; the ribbon's
    // history lives in a separate buffer, `capacity × segments` vec2). 64 slots
    // is deliberate headroom over `maxTrails` (24) — spare slots cost nothing
    // (the arena reserves once) and leave room for a stormier preset later.
    capacity: 64,
    // Ring-buffer length per trail: how many recent head positions the ribbon
    // is drawn through. More = smoother/longer snake, linearly more history
    // memory + one extra draw segment each. 32 reads as a flowing streak
    // without looking like a stiff noodle.
    segments: 32,
    // ACTIVE-TRAIL COUNT vs the live wind dial — "a few, more when windier."
    // `minTrails` show even at a light breeze; the count ramps to `maxTrails`
    // at gale (windSpeed01=1) along a sqrt curve (mid settings pulled up, so
    // "breezy" already reads as busier than "calm"). See gust-runtime.js's
    // step() where uActiveTrails is set.
    minTrails: 3,
    maxTrails: 24,
    // FLOW-ENERGY VISIBILITY GATE (dimensionless flow magnitude, full-strength
    // ambient + structure×gain, times windSpeed01 — see this file's own header
    // for why ambient is NOT exposure-scaled) — a trail is invisible below
    // `flowLo` and full-strength above `flowHi`, smoothstepped between. This
    // is the whole "only where the flow is fast" behaviour: tuned so open
    // gales and funnel
    // pinch-points clear `flowHi` while calm/sheltered air sits below `flowLo`.
    flowLo: 0.12,
    flowHi: 0.35,
    // Ribbon WIDTH at the head, in world px (tapers to ~0 at the tail — the
    // draw-side comet profile). Opacity ceiling is separate (`opacityMax`).
    widthPx: 12,
    opacityMax: 0.7,
    // Cool-white whoosh colour (additive), a touch bluer than the diagnostic
    // dust's warm white so the two effects never read as the same thing.
    colorRGB: [0.86, 0.92, 1.0],
    // How hard a head obeys the field — same meaning + default as the
    // diagnostic particles' own windGain (see wind-diagnostic-particles.js).
    windGain: 0.9,
    // Gusts are outdoor/high-energy by definition, so they carry the SAME
    // outdoor gale multiplier the diagnostic uses — 2× the calibrated
    // Beaufort-8 gale ceiling. Applied to the coherent flow + the speed ceiling.
    outdoorGaleBoost: 2,
    // Snappier acceleration than the drifting diagnostic dust (2.5s): a gust
    // should feel taut, so its head reaches the flow ceiling faster.
    accelToMaxSeconds: 1.2,
    // Trail LIFESPAN — a gust is born, snakes across its patch of fast air, and
    // fades out, so the population visibly cycles rather than snaking forever.
    // Shorter than the diagnostic's 6s: gusts are transient by nature.
    lifeMs: 4000,
    fadeMs: 1200,
    // RESPAWN BIAS: on rebirth, sample the flow magnitude at `respawnCandidates`
    // random points and keep the windiest — cheap rejection sampling that
    // concentrates the few trails into fast air instead of wasting them in dead
    // spots (the gate above then hides any that still land calm). 2 taps is
    // enough to bias meaningfully without a CPU-side hot-spot list.
    respawnCandidates: 2,
  },
};
