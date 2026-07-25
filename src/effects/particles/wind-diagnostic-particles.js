/**
 * WIND DIAGNOSTIC PARTICLES — a debug-only visualization, RENAMED from
 * `dust.js` (2026-07-22, author: "these aren't dust motes, they're wind
 * diagnostic particles"). This declaration exists to make the shared wind
 * field (world/wind-field.js#sampleWind + the baked wall-structure grid)
 * visibly, physically legible — a population of motes that show what the
 * field is actually doing at a glance, the same purpose the wind-field
 * arrow overlay serves, just as a particle cloud instead of arrows. It is
 * NOT the mansion's ambient-dust dressing effect; that is a planned,
 * SEPARATE future feature that will reuse this same engine
 * (particle-runtime.js) but tuned for visual atmosphere rather than
 * diagnostic legibility (docs/planning/Particles.md §23's "first slice"
 * scope was written before this relabeling — the engine itself did not
 * change, only what this declaration is FOR).
 *
 * DEBUG-ONLY, OFF BY DEFAULT (2026-07-22) — construction is gated behind a
 * debug-panel toggle in vt-pan-viewer.js/boot.js, the same idiom as the wind
 * field arrow overlay (`wind-overlay-toggle`) it is a companion to. A scene
 * nobody has opened this toggle for pays nothing for it (no arena, no
 * kernels, no draw).
 *
 * It validates against `validateParticleSystem` today — declaration before
 * implementation, the same order the schema, the wind contributor, and the
 * arena budget all took. The engine that consumes it (particle-runtime.js)
 * reads these fields; nothing here knows about the GPU.
 *
 * FIRST-SLICE SCOPE (honest): the built kernel uses `smartWind` (drift on the
 * shared wind field), an exit-test rect (not a modulo wrap), a real lifespan
 * (motes are born, fade in, live, fade out, and respawn), acceleration/
 * momentum, and (2026-07-22, checklist item 28 in particle-runtime.js) a
 * coherent/chaotic split so sheltered positions show undirected turbulence
 * instead of a damped-but-still-directional breeze. `sizeOverLife`/
 * `colorOverLife` are declared for the ladder (§22) but are draw-side polish
 * not yet wired; the `outdoors` gate (now: exposure-based coherentGate) and
 * curl turbulence are still higher rungs.
 *
 * @module effects/particles/wind-diagnostic-particles
 */

/** @type {import('./particle-system-schema.js').ParticleSystemDecl} */
export const WIND_DIAGNOSTIC_PARTICLES = {
  id: 'diagnostic.windParticles',
  visualWeight: 0.4,
  // An area of drifting motes. No `gate` yet — the `outdoors` gate is a later
  // rung (it needs the buf:scene.attr read wired into the kernel).
  emitter: { shape: 'circle' },
  behaviors: [
    { type: 'smartWind', params: { gain: 0.6 } }, // rides res:wind via sampleWind()
    { type: 'sizeOverLife' }, // declared for the ladder; draw-side, not in the tier-1 kernel yet
    { type: 'colorOverLife' }, // ditto
  ],
  spawn: { kind: 'area' },
  // The one dependency, sampled through the door (world/wind-field.js#sampleWind),
  // never re-invented as private noise (the wind/sample-through-the-door rule).
  reads: ['res:wind'],
  tiers: [
    { n: 0 }, // stand-in: faint haze or absent (particle tier 0 is special)
    { n: 1 }, // motes exist — drift on wind (THE first-slice rung)
    { n: 2 }, // motes swirl — curl-noise turbulence
    { n: 3 }, // density + pseudo-height depth
  ],
  // Tuned values — the author's taste, read by the engine as uniforms. Kept here
  // (not hard-coded in the kernel) so they become FOH/ROH dials later (§19).
  params: {
    capacity: 4096, // reserved arena slots (max-tier); the live count follows the tier
    // RANDOM SIZE + OPACITY (author request, 2026-07-22) — replaces the old
    // fixed sizePx/opacity. Re-rolled each time a mote is BORN, not fixed
    // per arena slot forever (particle-runtime.js's own `lifeRandomOf`).
    // opacityMax is the author's own explicit ceiling: "opacity 80% at max."
    sizeMinPx: 8,
    sizeMaxPx: 24,
    opacityMin: 0.15,
    opacityMax: 0.8,
    windGain: 0.6, // how hard the wind pushes a mote (a gain ON TOP of the real-unit gale scale below)
    // Exposure-gated OPTIONAL style nudge (fix-16/19) on top of the real-unit
    // gale calibration below — 1 = no-op, the DEFAULT since 2026-07-22. WAS 8
    // (mid-strength winds "hard to distinguish from calm" against the OLD
    // arbitrary, too-weak windSpeedScale) — now that the base scale is
    // physically real (particle-runtime.js's own GALE_MPS), an 8x multiplier
    // on top would push funneled outdoor gusts to absurd, un-physical speeds.
    // Still here as a deliberate STYLE dial if an author wants outdoor gusts
    // to read stronger than the real physical ceiling on purpose.
    outdoorSpeedBoost: 1,
    // COHERENT/CHAOTIC SPLIT — a sheltered position no longer damps ONE
    // combined wind vector down to near-stillness; instead the
    // direction-following push (the ambient bias) is gated to exactly 0 as
    // openness drops, and the undirected organic-noise/drift terms are
    // BOOSTED by this factor instead, so a sealed room's motes still visibly
    // move — just with no preferred heading — rather than going quiet. See
    // particle-runtime.js's own header for the full mechanism.
    indoorChaosBoost: 2,
    // OUTDOOR GALE MULTIPLIER (item 29, author: "outdoor particles blown by
    // galeforce winds need to move 2x faster... without making indoors
    // particles get faster"). Rides the COHERENT (direction-following) target
    // and ceiling ONLY, never the chaos term — and the coherent target is
    // already gated to ≈0 deep indoors, so 2× here is invisible to sheltered
    // motes. 2× the ≈18.92 m/s Beaufort-8 gale ≈ 37.8 m/s (hurricane force),
    // far under the ≈90-100 m/s survivable-extreme cap, so there is headroom
    // for a stormier preset later. See particle-runtime.js's checklist item 29.
    outdoorGaleBoost: 2,
    driftPx: 3, // a small always-on drift so dead-still air still stirs — now a CHAOS source (item 28), boosted indoors rather than suppressed
    // THE LIFESPAN RUNG, wired 2026-07-22 (author request — a nicer-looking
    // simulation that visibly cycles through motes, not a bug fix): a fixed
    // 6s life, with the first and last 2s fading in/out so a mote's birth and
    // death are never a hard pop. See particle-runtime.js's own header for
    // the age-based respawn + vertex→fragment fade-varying mechanism.
    lifeMs: 6000,
    fadeMs: 2000,
    // ACCELERATION (author request, 2026-07-22): how long, from a standing
    // start, a mote takes to reach the CURRENT gale-scaled speed ceiling —
    // see particle-runtime.js's checklist item 24. UNTESTED guess; tune by
    // eye if the ramp-up reads as sluggish drag rather than wind picking up.
    accelToMaxSeconds: 2.5,
    // deathSpeedMps/deathAgeMultiplier (stall-death) were built, then
    // REVERTED the same day — author-confirmed live, it killed every
    // particle: a mote spawns at velocity (0,0) and, once acceleration
    // (above) landed, genuinely spends real time at low speed early in its
    // life while ramping up, which read as "stalled." See
    // particle-runtime.js's checklist item 25 for the full account.
  },
};
