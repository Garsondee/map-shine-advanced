/**
 * THE PARTICLE ENGINE — runtime (docs/planning/Particles.md §9, §12, §16).
 *
 * `createParticleEngine(...)` turns a {@link ParticleSystemDecl} into GPU-resident
 * particles: it allocates the arena (§10), compiles a seed kernel + an update
 * kernel (TSL compute, proven live by diag/compute-spike.js), and builds ONE
 * instanced draw — never a scene object per particle (§16, the particles/one-
 * engine wall). Simulation state lives only in storage buffers; there is no JS
 * object per particle, by construction (§11).
 *
 * ============================================================================
 * TRANSITIONAL STATE — read this
 * ============================================================================
 * This is wired DIRECTLY into the vt/vt-pan-viewer.js render loop (the pragmatic
 * "not yet a registered pass" pattern wind Tier 1 and the candle already use),
 * ahead of the formal `sims.particles`/`surface.particles` seam→live flip. THREE
 * is INJECTED (never imported here) so this module's top level stays Node-safe;
 * the arena's free-list and the DUST declaration are Node-tested, but the kernels
 * and the draw are browser-only and verified LIVE — the standing rule for GPU
 * code (CONVENTIONS.md §4).
 *
 * THE WALLS force the split: this module may NOT touch setRenderTarget/autoClear
 * (renderer-state/graph-only allows only graph/·vt/·diag/), so the guarded
 * additive DRAW block lives in the viewer; here we only build the scene + mesh
 * and dispatch the sync `renderer.compute()`. Per-particle allocation goes
 * through the arena's one door; the ONE exception is the small, one-time
 * wall-structure grid buffer (fix-12) — not particle data, so it bypasses the
 * arena's per-slot budget on purpose, but it is still `instancedArray` called
 * from inside `effects/particles/`, which `particles/allocator-only` allows
 * anywhere under this directory, not only the arena file.
 *
 * LIVE-VERIFY CHECKLIST (the things I cannot test without your GPU):
 *   1. positionNode returns WORLD coords; the mesh is untransformed, so the
 *      viewer's ortho camera (whose frustum carries the Y-flip) must place a mote
 *      at world (x,y) exactly where map content at (x,y) sits. If motes are
 *      flipped/offset, that mapping is the suspect (feedback_y_flip_recurring_risk).
 *   2. zDepth must sit inside the camera's near/far or the motes clip away.
 *      updateCamera() (vt-pan-viewer.js) only ever sets left/right/top/bottom —
 *      near/far stay at construction (-1, 1) for the camera's whole life, so
 *      zDepth just needs to stay inside that fixed range, not a per-frame one.
 *   3. additive white on the lit scene — if it blows out, drop `opacity`.
 *   4. SOLVED (2026-07-21, live-confirmed): first draw seeded 4096 particles
 *      (compute ran, logged) but drew NOTHING, no console error — exactly
 *      candle-flame-render.js's own documented disease ("`side: DoubleSide`
 *      sidesteps quad winding under the flipped camera"). The material below
 *      now sets it; if particles vanish again, this is the first thing to check.
 *   5. SOLVED (2026-07-21, live-confirmed): motes drew and drifted, but at
 *      ~1% of any believable speed, and gale vs calm looked identical. TWO
 *      compounding bugs, both in the first update-kernel draft: (a) the first
 *      `sampleWind` call omitted the `wind` (ambient bias) argument entirely —
 *      it read ONLY the low-amplitude organic gust/flutter noise, never the
 *      scene's actual configured direction/speed, so the wind SETTING was
 *      simply never consulted; (b) `sampleWind`'s return is a small
 *      DIMENSIONLESS lean fraction (candle/light scale it to their OWN space —
 *      a quad fraction, a light-radius fraction), not a world-px/sec velocity,
 *      and the kernel used it AS ONE with no scale-up, so real displacement
 *      per frame was ~0.005px. Fixed: `ambientWind` (the SAME uWindDirectionDeg/
 *      uWindSpeed01 NODE references candle reads — no new uniform, no per-
 *      frame resync needed since a uniform's `.value` mutates in place) is now
 *      threaded into `sampleWind`'s `wind` arg, and a new `windSpeedScale`
 *      param (dust.js) converts the dimensionless lean into an actual
 *      world-px/sec velocity. Both were needed together — scaling alone would
 *      still have ignored the scene's wind setting; wiring the setting alone
 *      would still have been imperceptibly small.
 *   6. SOLVED (2026-07-21, live-confirmed): zooming the camera in caused
 *      motes to CLUSTER and appear to get "pushed" toward one edge/corner —
 *      not a rendering glitch, a MATH one. The first draft used a toroidal
 *      modulo wrap (`mod(pos - min, size) + min`) to keep motes "always
 *      present" inside the CURRENT VIEW rect, recomputed fresh every frame
 *      from `viewToWorldRect`. That is fine while the rect's SIZE is roughly
 *      stable (an ordinary pan), but a zoom changes `uRectSize` abruptly —
 *      and `mod` against a suddenly much SMALLER divisor maps many different
 *      absolute positions onto similar remainders, so the whole population
 *      visibly reshuffles into a dense, structured clump in ONE frame. Fixed:
 *      replaced the wrap with a per-particle AABB exit test — a mote outside
 *      the current rect gets reseeded to a fresh random point WITHIN it
 *      (an ordinary ambient-particle technique); everything still inside just
 *      keeps drifting, untouched. A rect-size change now reshuffles only the
 *      motes that actually fall outside it — a natural trickle, never a
 *      synchronised mass event. (Embarrassingly parallel either way — no
 *      ping-pong, §12 — this only changed what one slot decides for itself.)
 *      ⚠ INSUFFICIENT ALONE — see fix-8: the exit test was correct, but the
 *      RESEED position's own randomness had a separate bug that could still
 *      produce clustering, just from a different mechanism.
 *   7. NOT YET CONFIRMED LIVE (2026-07-21): motes drifted with the general
 *      wind but ignored local structure — they didn't bend around walls the
 *      way the wind-arrow overlay's arrows visibly do at the same spot.
 *      ROOT CAUSE: the update kernel never passed `bakedField` to
 *      `sampleWind` — only the smooth ambient+organic term, with no wall
 *      correction at all. FIX: thread the SAME `windBakedField` the overlay/
 *      candle read into `createParticleEngine`'s new `bakedField` option,
 *      straight into `sampleWind`'s own `bakedField` arg — reusing its
 *      ALREADY-VERIFIED world-space grid sampling, not new coordinate math.
 *   8. NOT YET CONFIRMED LIVE (2026-07-21) — the more likely true cause of
 *      "the zoom clustering is still happening" after fix-6: the RESEED
 *      hash used `s.add(uTimeMs)` — `uTimeMs` is a RAW, UNBOUNDED,
 *      ever-growing millisecond count, fed into `sin(x*12.9898)` inside
 *      `hash11`. float32 `sin()` loses precision badly at large arguments
 *      (this is a session-duration-dependent bug, not a one-time one), and
 *      because `uTimeMs` is the SAME huge number for every particle in a
 *      frame, it can swamp the small per-seed differences — many distinct
 *      particles alias onto nearly the SAME "random" output, worst exactly
 *      when a zoom event reseeds a large batch simultaneously. FIX: the
 *      reseed hash now uses ONLY the particle's own seed + its own (bounded,
 *      exit-time) position — both naturally scale-limited by `capacity` and
 *      the scene's size, so the hash's argument never grows over a session.
 *   9. NOT YET CONFIRMED LIVE (2026-07-21): fix-7 (bakedField) could NOT have
 *      worked, because the engine was CONSTRUCTED before the startup wind bake
 *      ran (vt-pan-viewer.js) — so it captured `windBakedField` while still
 *      null, and the compiled kernel never included wall channeling for the
 *      whole session. Construction was moved to AFTER bakeWindField('startup')
 *      (see that call's own comment — the exact trap it warns about). Same
 *      construction-time-only caveat candle's material has: a LATER rebake
 *      won't reach the already-built kernel.
 *  10. NOT YET CONFIRMED LIVE (2026-07-21): author — "the overlay shows a
 *      working wind SIMULATION and the particles are just drifting." The
 *      overlay passes `liveField` (Tier-2 transient sim, D_live) to
 *      sampleWind; the kernel did NOT — so particles missed the entire live
 *      sim, only ever seeing the smoother ambient+baked field. FIX: added a
 *      `liveField` option (mirrors bakedField exactly) threaded into
 *      sampleWind's own `liveField` arg. Verified from THREE source that the
 *      texture read is NOT the problem: TSL's WGSL backend auto-emits
 *      `textureSampleLevel(...,0)` outside the fragment stage
 *      (three.webgpu.js:72056), so texture sampling works in a compute kernel.
 *      GROUND TRUTH now available: `readbackVelocities()` reads the ACTUAL GPU
 *      velocities back and reports their circular spread — a definitive
 *      uniform-vs-varied answer, no more guessing (feedback_instruments_must
 *      _not_lie). Exposed as the "🌫️ Particle diagnostics" debug action.
 *  11. WRONG DIAGNOSIS, corrected by fix-12 (2026-07-21): the round-6 readback
 *      showed `velocityDirections.alignment` 0.95 (nearly uniform) and guessed
 *      the prevailing wind simply DOMINATES a real-but-subtle wall structure.
 *      Shipped a `windStructureGain` amplifier (dust.js) on that theory. WRONG:
 *      the very next readback showed the structure term at EXACTLY 0.00 for
 *      every sample, not "small" — and the author, standing at a real building
 *      with the overlay showing correct channeling at that exact spot, called
 *      this out directly: assume the mechanism is broken, not the location.
 *      They were right. See fix-12.
 *  12. NOT YET CONFIRMED LIVE (2026-07-21) — the actual bug fix-7/fix-10/fix-11
 *      all sat on top of without anyone questioning it: `sampleWind`'s
 *      `bakedField`/`liveField` args sample a TEXTURE. That path is proven to
 *      work from the FRAGMENT/VERTEX stage (the candle, the light, the
 *      overlay all use it successfully) — it was NEVER proven from a COMPUTE
 *      shader in this renderer. diag/compute-spike.js proved storage buffers
 *      work in compute; it never touched a texture. Reading THREE's WGSL
 *      codegen (three.webgpu.js:72056) only proved the STRING GENERATION for
 *      a non-fragment texture sample exists — not that the higher-level
 *      pipeline correctly binds a texture+sampler to a COMPUTE bind-group
 *      layout in this specific setup, which is a different, unverified layer.
 *      A live readback at a real building came back exactly zero, which is
 *      the signature of a resource that silently isn't actually bound, not of
 *      "small deviation". FIX: stop depending on it. The particle kernel no
 *      longer samples bakedField/liveField as textures at all — it uploads the
 *      SAME bake's raw `dvx`/`dvy` arrays as a storage buffer
 *      (`windStructureGrid`) and does its own nearest-cell lookup, using
 *      EXACTLY the mechanism already proven correct in this very kernel
 *      (`.element(idx)` on a storage node — identical to how position/
 *      velocity/age/seed already work). `sampleWind` itself is UNCHANGED and
 *      still owns the organic+ambient term (pure math + procedural noise, no
 *      texture, safe in compute); only the wall-structure ADDITION moved off
 *      the texture path. Tier-2 (liveField, transient door-gusts) is dropped
 *      from particles for now — it's pure GPU render-target data with no CPU-
 *      side copy to re-upload as a buffer, a materially bigger rewrite of the
 *      Tier-2 sim itself; the author's complaint was specifically about STATIC
 *      building-shaped bending, which IS the baked/Tier-1 term this fixes.
 *      readbackVelocities() now reports `hasWindStructureGrid` and, if
 *      `wallStructure.present` is STILL false after this fix, that means the
 *      grid-buffer mechanism itself has a bug (wrong index math, or the CPU
 *      array never reached the GPU) — not "no structure exists".
 *  13. NOT YET CONFIRMED LIVE (2026-07-21) — fix-12 alone did NOT change
 *      anything: the readback was EXACTLY 0.00 again, `hasWindStructureGrid:
 *      true`, real 120x120 grid. Two DIFFERENT sampling mechanisms (texture,
 *      then storage buffer) reading back the IDENTICAL wrong answer is itself
 *      the diagnostic — that pattern means the bug is common to both: the
 *      DATA they read, not either read PATH. ROOT CAUSE: `bakeWindField
 *      ('startup')` — the ONLY bake that has ever run by the time this engine
 *      is constructed — is UNCONDITIONALLY windless (uWindDirectionDeg/
 *      uWindSpeed01 start at 0/0). With zero ambient wind, a wall has nothing
 *      to redirect, so dvx/dvy really ARE all-zero at that exact moment —
 *      correctly, not a bug. `setWindAmbient()` (called when the author
 *      dials in "gale") DOES trigger a real rebake with non-zero dvx/dvy
 *      (`bakeWindField('ambient-change')`) — candle/overlay/heat all
 *      explicitly dispose+null themselves at that point so they rebuild
 *      lazily on their NEXT per-frame call and pick up the fresh bake; the
 *      particle engine had NO such hook, so its storage buffer stayed frozen
 *      at the original windless snapshot forever, no matter how many times
 *      "gale" got set or rebaked afterward — explaining why BOTH the texture
 *      attempt and the storage-buffer attempt read back identically zero.
 *      FIX: `updateWindStructureGrid(newGrid)` — called from
 *      `vt-pan-viewer.js`'s `bakeWindField()`, in the SAME spot candle/
 *      overlay/heat get invalidated — overwrites the EXISTING storage
 *      buffer's content with the fresh dvx/dvy (cols/rows are stable across
 *      an ordinary rebake, so this is a data refresh, not a kernel rebuild;
 *      a genuine cols/rows change is logged and skipped, not silently
 *      misread). The compute-vs-texture pivot (fix-12) may not have been the
 *      actual bug, but it removed a genuinely unverified dependency and is
 *      being kept — this fix (fix-13) is the one that should make dust react
 *      to a REAL rebake for the first time.
 *  14. NOT YET CONFIRMED LIVE (2026-07-21) — fix-13 worked ("first
 *      improvement... wind is moving particles around"), but exposed the
 *      NEXT bug precisely: author reported indoor motes (where the overlay
 *      shows very little force) moving in the full "windward" direction at
 *      FULL speed — "the calmest spots move the fastest" — while outdoor
 *      motes (where wind should be strongest) didn't feel proportionally
 *      stronger. ROOT CAUSE: `exposure` was hardcoded to `float(1)`
 *      (full-exposure) for EVERY particle, on the WRONG assumption (an
 *      earlier round's own note) that the exposure/outdoors source reads
 *      flat map-wide — the author's live report of the overlay correctly
 *      showing LOW force indoors directly disproves that; exposure DOES vary
 *      real, meaningfully in this scene, and the overlay reads it correctly.
 *      `sampleWind` damps BOTH the organic term and the ambient bias by
 *      exposure (NOT the wall-structure term — that's already shelter-aware,
 *      being a wall-shaped correction) — so hardcoding full exposure
 *      everywhere gave every indoor mote the SAME undamped, full-strength
 *      ambient push as an outdoor one, swamping the (correctly small, since
 *      fix-13) wall-structure correction: exactly "ignoring the local field,
 *      moving in the windward direction" indoors. FIX: an `exposureGrid`
 *      option (mirrors `windStructureGrid` exactly — same storage-buffer
 *      mechanism, same nearest-cell lookup, its own independent dims/refresh
 *      method) sourced from `world/index.js#sampleWindExposureAt` (the mask
 *      authority) — the SAME real per-position shelter the overlay already
 *      bakes per-vertex. No new orientation risk: reuses the exact grid
 *      pattern already built and reasoned through for fix-12/fix-13.
 *  15. NOT YET CONFIRMED LIVE (2026-07-21) — fix-14 made the field genuinely
 *      flow (readback: `wallStructure.present:true, meanLean:0.28`,
 *      `velocityDirections.alignment` down to 0.4/77° spread — real per-cell
 *      variation), but exposed a THIRD bug on top, precisely reported:
 *      "particles do flow around the house in the red [strong] cells, but
 *      then hit a blue [weak] cell and get pushed hard — sheltered spaces
 *      inject MORE movement than strong-wind cells." The single fastest,
 *      most wrong-direction sample in that readback (139 px/sec, opposite
 *      the ambient) had `structMag` at the sample set's observed maximum —
 *      i.e. the largest RAW local deviation, at what Wind.md calls a
 *      doorway/gap "funnel" point. ROOT CAUSE: `windStructureGain` defaulted
 *      to 4 — a band-aid shipped in fix-11, BEFORE fix-13 (rebake
 *      propagation) or fix-14 (real exposure) existed, back when the raw
 *      structure term wasn't reaching the kernel at all and 4x was meant to
 *      compensate for that. Once fix-13/14 landed, that leftover 4x became
 *      actively harmful: `sampleWind`'s own bakedField/liveField terms carry
 *      NO gain and NO exposure scaling (correct — a wall correction is
 *      already shelter-aware by construction) — so the overlay's displayed
 *      total is `ambient_damped + structure` at gain 1. Multiplying ONLY the
 *      structure term by 4 breaks that balance: in sheltered cells the
 *      (correctly tiny, since fix-14) damped ambient gets swamped by a
 *      4x-inflated structure term, and at genuine gap-funnel points (where
 *      structure is naturally large) 4x turns a real effect into an absurd
 *      one — together producing exactly "blue cells push harder than red
 *      ones." FIX: `windStructureGain` default 4 → 1 (dust.js) — dust's total
 *      wind vector now matches the overlay's own formula exactly, gain-for-
 *      gain. Raising it above 1 is a legitimate STYLE choice once 1 is
 *      confirmed to track the overlay correctly, not a workaround.
 *  16. WRONG (superseded by fix-19, kept for history): author-confirmed
 *      fix-14/15 finally correct ("much much better... interior particles
 *      don't move much which is right, exterior particles move"), then asked
 *      for MORE contrast: gale-force outdoors should feel 3-5x faster,
 *      WITHOUT touching the indoor calm that's now finally right. Shipped
 *      `outdoorSpeedBoost` (dust.js) as a LINEAR `mix(1, outdoorSpeedBoost,
 *      exposure)` — this itself caused fix-19's regression: real exposure
 *      masks rarely read a crisp 0 even in an obviously-enclosed room, so a
 *      linear mix from exposure still applied a meaningful chunk of the
 *      boost there. See fix-19 for the corrected, threshold-based version.
 *  17. NOT YET CONFIRMED LIVE (2026-07-21) — a DIFFERENT bug from fix-6/8,
 *      same neighbourhood: "when I zoom in it shoves particles closer
 *      together, zoom back out and I'm looking at a screen-shaped bucket of
 *      particles — only happens when zooming in [then out]." ROOT CAUSE:
 *      the exit test (fix-6) only rescues a mote that drifts OUTSIDE the
 *      CURRENT rect. Zooming OUT makes the rect suddenly bigger — every
 *      existing mote (clustered wherever the smaller, zoomed-in rect used to
 *      be) is now comfortably INSIDE the new, larger rect, so the exit test
 *      never fires for any of them; nothing ever tells them to spread out
 *      and fill the newly-revealed area. FIX: `setWorldRect` now detects a
 *      real zoom (rect AREA changes by >40% either way — NOT the sub-pixel
 *      wobble of an ordinary pan at constant zoom, which the exit test
 *      already handles correctly) and opens a short window
 *      (`REDISTRIBUTE_FRAMES` ≈1.5s) during which every particle gets an
 *      independent 4%/frame chance to force-respawn to a fresh random point
 *      in the current rect, via `uRespawnChance` (0 the rest of the time, so
 *      ordinary steady viewing never teleports a single mote). The Bernoulli
 *      trial needs a per-frame-varying signal, so it hashes `uTimeMs` WRAPPED
 *      to a bounded [0,10000) range first — never the raw unbounded clock
 *      directly (fix-8's own lesson: sin() precision collapses at large,
 *      ever-growing arguments).
 *  18. NOT YET CONFIRMED LIVE, AND HONESTLY UNCERTAIN (2026-07-21) — author:
 *      "the wind hits the side of a building and a blue low-energy zone
 *      exists as a buffer around the exterior... particles stick to the
 *      side of buildings like glue... this is a deeper simulation problem."
 *      LEADING HYPOTHESIS (not confirmed): the exposure grid (fix-14) was
 *      baked at the SAME coarse resolution as the wind-structure grid
 *      (~120x120 over the whole scene). Exposure has a SHARP real-world
 *      edge (a wall blocks sky-reach or it doesn't); the wind-structure
 *      deviation is smoothly-varying by nature (a relaxation solve). Nearest-
 *      cell sampling (fix-12/13's own stated simplification) blurs BOTH the
 *      same way, but a sharp-edged quantity suffers far more visibly — one
 *      coarse cell straddling a wall's true edge reads a single blended
 *      value for its whole footprint, plausibly creating an artificial one-
 *      cell-wide "moat" of wrong exposure hugging every building. FIX
 *      ATTEMPTED: bake exposure at DOUBLE the linear resolution (half the
 *      cell size → up to 4x the cells) of the wind-structure grid — cheap,
 *      since `sampleWindExposureAt` is the same CPU point-query the overlay
 *      itself already runs at up to 4x resolution. HONEST LIMIT: this may
 *      only shrink the band, not eliminate it, and does NOT touch two other
 *      real candidates — the outdoors mask's own edge-softening (upstream of
 *      both the overlay and this engine), or the wind-bake's relaxation
 *      itself behaving more like a no-slip boundary than the free-slip Wind.md
 *      §4 specifies. If the glue persists after this, that is the next
 *      question, and it belongs in world/wind-bake.js or the mask authority,
 *      not another particle-side patch.
 *  19. NOT YET CONFIRMED LIVE (2026-07-21) — two more author reports from the
 *      SAME test: (a) "the interior particles speeded up which wasn't meant
 *      to happen" — see fix-16, now WRONG: a linear `mix(1,boost,exposure)`
 *      still applies real speed at moderate, ambiguous exposure readings a
 *      visually-enclosed room can easily have. FIX: `smoothstep(0.5, 0.9,
 *      exposure)` — a THRESHOLD, not a ramp — stays at EXACTLY 0 (no boost
 *      whatsoever) for any exposure below 0.5, so only positions
 *      convincingly, unambiguously outdoors ever receive it.
 *      (b) "gale isn't fast enough by a long way, light breeze is hard to
 *      distinguish from calm — regular outdoor particles." Both about the
 *      configured WIND-STRENGTH axis (calm/breeze/gale), a different axis
 *      from indoor/outdoor. FIX: `strengthCurve = sqrt(clamp(windSpeed01,0,1))`
 *      multiplies into the SAME exposure-gated boost — sqrt pulls MID
 *      settings (e.g. 0.25) up disproportionately (→0.5, not 0.25) so a
 *      light breeze reads clearly stronger than dead calm, while calm (0)
 *      and gale (1) stay at the floor/ceiling; `outdoorSpeedBoost`'s default
 *      also raised 4→8 (dust.js) for a dramatically faster gale ceiling.
 *      `windSpeed01` reads `ambientWind.speed01` directly — the SAME live
 *      uniform node candle/overlay read, so a live wind-setting change
 *      reaches this curve too, with no resync code.
 *  20. NOT YET CONFIRMED LIVE (2026-07-21) — author, precisely: "particles
 *      fully contained inside rooms which aren't connected to the outside"
 *      still had "a lot of wiggle energy," and asked directly whether this
 *      was a missing drag/damping term. CONFIRMED ROOT CAUSE, 100% certain
 *      (not a hypothesis — read directly from the code): the `drift` term
 *      ("a small per-particle drift so dead-still air still stirs," present
 *      since the very first kernel draft) was applied UNCONDITIONALLY, with
 *      NO exposure gate at all. Worse: it is a pure function of the
 *      particle's fixed `seed` — never position or time — so it is not
 *      per-frame noise, it is a PERMANENT PER-PARTICLE BIAS: every particle
 *      nudges in its own fixed direction, forever, from the moment it seeds.
 *      Outdoors this was invisible, masked by real wind dominating; once
 *      fix-14 correctly damped the real wind terms toward zero indoors, this
 *      never-gated nudge became the ONLY visible motion in a sheltered room —
 *      and because every particle's fixed direction differs, the population
 *      as a whole reads as incoherent "wiggle" even though each individual
 *      mote is just steadily drifting one way. On the "drag/conservation of
 *      energy" question specifically: AT THE TIME this kernel had NO
 *      momentum to conserve — `vel` was recomputed FRESH from the CURRENT
 *      field sample every frame (§12, no ping-pong), never integrated from
 *      the previous frame's velocity, so there was no accumulating "energy"
 *      and no drag term would have been meaningful; the actual bug was this
 *      one specific term never checking whether it was appropriate. (STALE
 *      AS OF 2026-07-22 — the kernel now DOES integrate velocity
 *      frame-to-frame, checklist item 24; this stays for the historical
 *      diagnosis.)
 *      FIX: gated `drift` by a NEW `stillness` factor, PLUS added a stricter,
 *      dust-specific "how still is a TRULY sealed room" curve
 *      (`indoorStillness`, default 0.12) — deliberately a LOWER, tighter
 *      exposure threshold (0-0.2) than the outdoor-boost gate (0.5-0.9), so
 *      a half-open doorway or any real wall-structure signal keeps its full,
 *      correct channeling; only unambiguously-sealed positions (exposure
 *      near 0) get the extra damping, applied to BOTH the wind-driven
 *      velocity and the (now-gated) drift term together.
 *  21. DOCUMENTED, NOT FIXED — genuinely out of this file's scope
 *      (2026-07-21). Author: "the area around buildings still acts like fly
 *      paper... they don't become turbulent areas redirecting the force when
 *      it hits that space." VERIFIED FROM SOURCE (world/wind-bake.js — this
 *      is NOT a guess): the Tier-1 wind-structure bake (`bakeWindStructure`)
 *      is a scalar POTENTIAL-FLOW relaxation (solves a Laplace-type equation
 *      for a potential `phi`; the field is `-gradient(phi)`) — chosen
 *      deliberately (memory: keyhole-wind-field-plan) because it correctly
 *      produces gap-funnelling for free. But potential flow is IRROTATIONAL
 *      BY DEFINITION — it has zero curl everywhere, which means it CANNOT
 *      produce vortices, eddies, or turbulent wakes, as a mathematical
 *      property of the method, not an oversight. What it DOES correctly
 *      produce near an obstacle: a stagnation zone (velocity toward 0)
 *      directly facing the incoming wind, and accelerated flow around the
 *      sides/corners — genuinely correct physics, but it reads as "sticking,"
 *      not "turbulent redirection," because there is no rotation in the
 *      model to break the slowdown up into churn. This is why
 *      `uStructureGain`/`indoorStillness`/anything else in THIS file cannot
 *      fix it: the particle kernel is faithfully riding a field that is
 *      architecturally incapable of the behaviour being asked for. The fix
 *      is a KNOWN, ALREADY-RESEARCHED technique — geometry-gated turbulence-
 *      behind-obstacles (Bridson's method, banked in `docs/reference/wind-
 *      simulation-research.md` alongside the *God of War* case study) — that
 *      has NOT been built. That is real, separate wind-SIMULATION work (a
 *      new rung on Wind.md's own ladder), not a particle-engine bug, and not
 *      something to improvise into dust.js.
 *  22. INSTRUMENT GAP FOUND, NOT YET A FIX (2026-07-21) — author: "sheltered
 *      particles seem to have a huge amount of speed and wobble still,"
 *      with a readback showing `structMag` pegged near 1.0 for almost EVERY
 *      sample (earlier readbacks showed it varying naturally, 0.04-0.31,
 *      with rare 1.0 spikes only at doorway-gap points) and velocity means
 *      near 114 px/sec. Could NOT diagnose further from that readback alone:
 *      it reports `structure`/`structMag` but NEVER reported the exposure
 *      value each sampled particle actually read, or the `stillness` factor
 *      (fix-20) actually applied that frame — meaning it was IMPOSSIBLE to
 *      tell apart "these particles read low exposure and the stillness math
 *      has a bug" from "these particular 32 strided samples simply aren't
 *      at sheltered positions right now" (the readback samples by STRIDE
 *      across the whole population, not by location — it has no idea what
 *      the author is currently looking at on screen). FIX (instrument only):
 *      `custom.zw` now also stashes `exposure`/`stillness` per particle;
 *      `readbackVelocities()` reports them per-sample plus `exposureStats`
 *      (mean/min/max/lowExposureCount) and a `contradictions` list — samples
 *      that read exposure<0.2 (should be damped near-still) yet still moved
 *      fast. An EMPTY contradictions list with `lowExposureCount:0` means the
 *      NEXT readback's high speeds say nothing about indoor stillness at
 *      all (wrong location, not a bug); a non-empty list is the real,
 *      actionable bug report. Do not re-guess about fix-20's correctness
 *      until the NEXT readback answers this.
 *  23. NOT YET CONFIRMED LIVE (2026-07-22) — THE LIFESPAN RUNG (author
 *      request: 6s life, 2s fade-in, 2s fade-out, "cycle through more
 *      particles and get a nicer looking simulation" — not a bug fix). Age
 *      already existed as a buffer (staggered at seed time, incremented every
 *      frame) but nothing READ it: no death, no fade, just an ever-growing
 *      counter. Now: the update kernel respawns a mote (identical reseed path
 *      as an out-of-bounds exit) once its age reaches `uLifeMs`, resetting age
 *      to 0 on that same frame; the seed-time stagger now spreads initial ages
 *      across the FULL `uLifeMs` window (not a fixed 0-1000ms slice) so the
 *      population starts already mid-cycle instead of everyone fading in from
 *      birth in lockstep. The fade envelope itself (`vFade.x` — a min of a
 *      fade-in ramp and a fade-out ramp) is computed in the VERTEX stage
 *      (only place `age`/`instanceIndex` storage reads are valid on this
 *      renderer) and carried to `opacityNode` via `.toVarying()` — the same
 *      technique THREE's own `instanceColor` uses for per-instance fragment
 *      data (three.webgpu.js). UNVERIFIED: whether `.toVarying()` referenced
 *      ONLY from `opacityNode` (never from `positionNode` itself) is
 *      sufficient for the node builder to still emit the vertex-side
 *      computation — believed yes, by direct analogy with `instanceColor`'s
 *      own usage pattern, but this specific combination (a `Fn` block's
 *      RETURN value converted with `.toVarying()`, rather than a bare
 *      attribute/uniform) has not been exercised elsewhere in this codebase.
 *      If motes now hold a CONSTANT opacity regardless of age (no fade at
 *      all), start here — it means the varying never got wired into the
 *      vertex stage and needs an explicit reference inside `positionNode`
 *      to force it.
 *  24. NOT YET CONFIRMED LIVE (2026-07-22) — REAL-UNIT WIND SPEED AND
 *      ACCELERATION (author request, same session as item 23): landed
 *      together because they share one mechanism. (a) GALE CALIBRATION:
 *      `windSpeedScale` (an arbitrary "feels right" constant, 90) is GONE,
 *      replaced by `pxPerMeter × GALE_MPS` (this file's own GALE_MPS doc has
 *      the Beaufort derivation) — `pxPerMeter` is threaded in from
 *      vt-pan-viewer.js's `readGridDistancePixels()` (Foundry's real
 *      px-per-grid-distance-unit). (b) `outdoorSpeedBoost` defaults to 1
 *      (no-op) now, down from 4 — that multiplier was compensating for the
 *      old arbitrary scale being too weak; stacking it on TOP of a
 *      physically-real ceiling would push funneled outdoor gusts past real
 *      gale speed. (c) ACCELERATION: the kernel no longer snaps `velocity`
 *      straight to the field's target every frame (this file's OWN original
 *      design note called that deliberate — "no energy to build up" — the
 *      author has now asked for the opposite). It steers the CURRENT
 *      velocity toward a ceiling-clamped target, bounded by
 *      `accelToMaxSeconds`-derived acceleration. UNVERIFIED: whether the
 *      visible ramp-up reads as "wind picking up" rather than "sluggish
 *      drag" — accelToMaxSeconds (2.5s default) is an UNTESTED guess, tune
 *      by eye.
 *  25. BUILT THEN REVERTED SAME DAY (2026-07-22) — STALL-DEATH (item 24's
 *      original point (d)): a mote below `deathSpeedMps` aged
 *      `deathAgeMultiplier`× faster, reusing item 23's lifespan fade so a
 *      stalled mote died smoothly, never popped. Author-confirmed live: it
 *      killed EVERY particle. ROOT CAUSE — a genuine interaction with item
 *      24's own acceleration, landed the SAME turn: a mote spawns at
 *      velocity (0,0) (seedKernel), and once velocity had to ACCELERATE up
 *      from a standing start instead of snapping to speed instantly, every
 *      fresh mote spent real TIME with a genuinely low actual speed early
 *      in its life — exactly what the stall check was designed to catch,
 *      just for the wrong reason (ramping up, not dead air). Neither
 *      feature was wrong in isolation; they were never checked TOGETHER
 *      before shipping. REVERTED IN FULL (uDeathSpeedPxPerSec/
 *      uDeathAgeMultiplier uniforms, the isStalled/ageRate kernel logic,
 *      dust.js's deathSpeedMps/deathAgeMultiplier params) rather than
 *      patched (e.g. exempting the first few seconds of life) — the author
 *      asked for a revert, not a fix, and a correct version of this feature
 *      is a genuinely separate design question (STALL means "moving slower
 *      than expected for current conditions," not "moving slower than an
 *      absolute threshold" — a newly-spawned, still-accelerating mote and a
 *      truly-stuck one are NOT the same thing, and telling them apart needs
 *      new state, not a bigger threshold) — deferred, not attempted here.
 *  26. FIXED (2026-07-22, found via the wind+particle probe, not yet
 *      live-verified) — SHELTERED MOTES KEPT OUTDOOR SPEED. Another item-24
 *      interaction bug, this time with fix-20's stillness damping: the
 *      deceleration rate (`maxAccelPxPerSec2`) was computed from the
 *      CURRENT ceiling only, and a sheltered room's ceiling is ~12% of
 *      outdoor (stillness). So a mote carrying full gale speed on crossing
 *      INTO a sealed room braked at only 12% power too — physically
 *      backwards (braking should get STRONGER when the target speed drops,
 *      never weaker) — and coasted at near-outdoor speed for many seconds
 *      after entering shelter, exactly the "calmest spots move the fastest"
 *      symptom fix-14 already fixed once for the AMBIENT term, now
 *      reappearing via the newer acceleration mechanism instead. FIX: the
 *      braking-magnitude basis is `max(currentCeiling, oldVel.length())` —
 *      accelerating UP to a target is unchanged (basis = ceiling, as
 *      before); braking DOWN now scales with how fast the mote actually
 *      is, never with how slow it is ABOUT to become.
 *  27. CORRECTED (2026-07-22, same day, found via a SECOND probe reading) —
 *      item 26's OWN fix was self-referential: `oldVel.length()` is the
 *      mote's CURRENT speed, recomputed fresh every frame, and braking pulls
 *      that same value DOWN each frame — so the braking rate shrank in
 *      lockstep with the speed it was reducing, an EXPONENTIAL tail (~63%
 *      converged at t=accelToMaxSeconds, still not settled 5+ seconds later)
 *      instead of the intended BOUNDED ramp. Live symptom (author, second
 *      probe, same session): sheltered motes read as two groups — some
 *      already at the correct ~12%-of-gale trickle, others still near-full
 *      outdoor speed heading whichever way they originally were (WITH the
 *      wind, or seemingly AGAINST it) — actually the SAME population at
 *      different points along one wrongly-shaped tail, not two separate
 *      bugs or "chaotic indoor turbulence." FIX: the braking-magnitude basis
 *      no longer touches `oldVel` OR the location's `stillness`-collapsed
 *      ceiling at all — it is `uMaxSpeedAtGalePxPerSec × windSpeed01 ×
 *      speedBoost` (the SAME ceiling math, just BEFORE stillness damps it),
 *      which stays constant across the moment a mote crosses into shelter,
 *      so braking is a genuine constant-magnitude ramp that reaches the true
 *      sheltered target within accelToMaxSeconds. Outdoors this is a no-op —
 *      stillness is already 1 there, so pre- and post-stillness ceilings are
 *      identical and acceleration-up is byte-for-byte what item 24 shipped.
 *      NOT yet live-tested. Separate, NOT yet addressed by this fix: once a
 *      sheltered mote truly settles, its steady-state motion is a small
 *      (~12%-of-gale) but still perfectly COHERENT one-direction drift
 *      (the wall-structure lean, just scaled down) — genuinely "chaotic"
 *      swirling indoor motion would need the per-particle `drift` term to
 *      stop being scaled down by the SAME `stillness` factor as the coherent
 *      wind term, so it can dominate once the coherent term is damped away;
 *      that is a real design change, not attempted here, and worth revisiting
 *      only AFTER confirming live that this fix alone resolves the reported
 *      symptom.
 *  28. REDESIGNED (2026-07-22, author request, same day as items 26/27) —
 *      "indoors shouldn't automatically move in the wind direction; it
 *      should come from the chaotic indoor field. Outdoors, give it a big
 *      push from the wind." Author's own second live-probe report after
 *      item 27 still showed EVERY particle's target computed from ONE
 *      combined `windVec` (ambient + wall-structure + organic noise all
 *      summed together), then scaled by ONE `stillness` factor — so a
 *      sheltered mote was always chasing the SAME compass heading as an
 *      outdoor one, just quieter, never genuinely undirected. REPLACED the
 *      whole mechanism: the coherent, direction-following parts (ambient
 *      bias + wall-structure lean) and the chaotic, directionless parts
 *      (sampleWind's organic gust/flutter noise + per-particle drift) are
 *      now SEPARATE vectors with OPPOSITE exposure gating —
 *      `coherentGate` (smoothstep 0.25→0.65 on exposure) suppresses the
 *      compass-heading push toward 0 as a position reads more sheltered;
 *      `chaosBoost` (`mix(uIndoorChaosBoost, 1, coherentGate)`, default
 *      indoor multiplier 4) amplifies the undirected noise/drift terms the
 *      MORE sheltered a position is. `sampleWind` is now called WITHOUT its
 *      `wind` arg (returns organic noise only); the ambient-bias formula is
 *      replicated by hand (same negate/meteorological convention,
 *      documented at its own call site) so it can be gated independently of
 *      the organic term instead of sharing sampleWind's one internal
 *      `amount` scale. RETIRED: `uIndoorStillness`/`stillness`/`sealedT` —
 *      fully superseded, not kept as a parallel path. BONUS: this redesign
 *      makes `ceilingPxPerSec` genuinely LOCATION-INDEPENDENT (no
 *      coherentGate/chaosBoost factor in it — see its own comment), which
 *      removes the root cause items 26/27 were patching around; the
 *      braking-basis workaround item 27 introduced is GONE, replaced with
 *      the plain `ceilingPxPerSec / accelToMaxSeconds` item 24 always
 *      intended. Diagnostic custom.w (fix-22) is REPURPOSED from
 *      `stillnessApplied` to `coherentGateApplied` throughout the readback
 *      functions — answers "is this particle still chasing the compass
 *      heading when it shouldn't be" directly, which is what item 27's
 *      probe-driven bug reports were actually asking. NOT yet live-tested.
 *      Also folded into this same turn: this whole particle system is
 *      RELABELED — it was never really "dust motes," it is a WIND
 *      DIAGNOSTIC visualization (debug-only, off by default); real dust
 *      motes are a planned, separate future feature reusing this same
 *      engine. See `wind-diagnostic-particles.js` (renamed from `dust.js`)
 *      for the relabeling.
 *  29. TUNING PASS (2026-07-22, author): two independent speed asks that item
 *      28's coherent/chaotic split makes trivially separable. (a) "The indoor
 *      chaos needs to be 50% less energetic" → `indoorChaosBoost` 4 → 2,
 *      halving both the organic-noise and per-particle-drift contribution deep
 *      indoors (the only two terms alive there). (b) "Outdoor particles blown
 *      by galeforce winds need to move 2× faster... without making indoors
 *      particles get faster" → a NEW `outdoorGaleBoost` (default 2) applied
 *      ONLY to the coherent target and the ceiling, NEVER the chaos term.
 *      Because the coherent target is multiplied AFTER `coherentGate` (≈0 deep
 *      indoors), the 2× is mathematically invisible to a sheltered mote —
 *      "faster outdoors, unchanged indoors" falls straight out of the algebra,
 *      no location branch. The ceiling carries the SAME constant boost, so it
 *      stays LOCATION-INDEPENDENT (item 28's hard-won stability guarantee is
 *      untouched — the boost is the same everywhere, it does not collapse on a
 *      shelter crossing); raising the cap does not speed indoor motes because
 *      their target (chaos) is far below even the un-boosted cap and never
 *      clamps. Side effect, benign and documented at the accel site: the
 *      acceleration/braking RATE (ceiling / accelToMaxSeconds) also doubles —
 *      which only makes braking-into-shelter brisker (good, anti-coasting) and
 *      leaves indoor momentum smoothing intact (maxStep stays well below the
 *      indoor target magnitude). 2× the Beaufort-8 gale (≈18.92 m/s) puts
 *      outdoor motes near ≈37.8 m/s at windSpeed01=1 (hurricane force), well
 *      under the ≈90-100 m/s / one-1 m-cell-per-~10 ms the author cited as the
 *      survivable-extreme ceiling — deliberate headroom, no per-frame cell
 *      skipping. NOT yet live-tested.
 *  30. DOOR CHAOS (2026-07-22, Part 2 of a 2-part author-directed fix — Part 1
 *      is world/wind-field.js's own header, "THE INDOOR COUNTER-WIND BUG").
 *      Author, after Part 1 was confirmed live: "opening doors, even double
 *      doors directly exposed to the wind, doesn't seem to allow the wind to
 *      enter the building... interior spaces protected unless a door is
 *      opened, then chaotic wind energy can get further into the building."
 *      ROOT CAUSE (research, not a bug in this file): potential flow
 *      (`bakeWindStructure`) is irrotational by construction (item 21) — it
 *      cannot advect air deep into a room even through a wide-open door, only
 *      funnel right at the aperture; and `exposure` (the thing that gates
 *      `coherentGate`/`chaosBoost` here) is 100% static painted art, never
 *      door-aware, so opening a door changed nothing this kernel could see.
 *      FIX: a NEW, independent signal, `doorChaos` (world/wind-enclosure
 *      .js#distanceFromExposedAir + doorChaosFromDistance) — BFS hop-distance
 *      through open cells from the nearest GENUINELY exposed cell (seeded
 *      from the painted mask, not the map border — a courtyard door might be
 *      a few cells from fresh air; border-distance would depend on incidental
 *      map geometry that has nothing to do with the doorway), turned into a
 *      0..1 strength fading out over `DOOR_CHAOS_REACH_CELLS`. A sealed room
 *      reads 0 throughout, exactly like before this item existed; the MOMENT
 *      a door opens (the SAME solid-mask change that already triggers a
 *      rebake), cells near the new gap read a real gradient. Consumed as an
 *      EXTRA, purely ADDITIVE term on `chaosBoost` (`doorChaosExtra`, gated
 *      by `coherentGate.oneMinus()` so it is a no-op outdoors) — never a
 *      replacement for the existing flat `uIndoorChaosBoost` baseline, and
 *      byte-identical to the pre-item-30 formula wherever `doorChaos` reads
 *      0. Deliberately did NOT touch the coherent/structure math at all —
 *      the author's own ask was for CHAOTIC energy, which potential flow
 *      can't produce anyway, so the fix is a new chaos source, not a
 *      stronger coherent push. NOT yet live-tested. Watch on the next live
 *      look: (1) a sealed room with every door shut stays dead calm — this
 *      feature must be invisible there; (2) opening a door visibly stirs
 *      motes in the room just past it, fading out further in, not a uniform
 *      whole-room flip; (3) the effect never reaches through a STILL-CLOSED
 *      door (the solid mask correctly keeps it blocked).
 *  31. COHERENT GATE WAS STATIC-EXPOSURE-ONLY — FIXED (2026-07-22, same day,
 *      after item 30 shipped and the author tested a real corridor with two
 *      open double doors facing gale-force wind). Author, precisely
 *      diagnosing the bug from first principles before I did: "are we
 *      artificially killing the speed of particles just because they are
 *      inside? Because that only works when the inside of the building is
 *      sealed and breaks when it isn't." CONFIRMED TRUE by reading the code:
 *      `coherentGate` (item 28) depended ONLY on the static painted `exposure`
 *      mask — which a door opening never repaints — so even a corridor where
 *      the relaxation solve correctly computes a strong `coherentVec` (Part 1
 *      already made `ambientBias + structure` respond to real door state)
 *      could still have that push clamped toward zero by a gate that had no
 *      way to know the door was open. FIX: `coherentGate` is now the MAX of
 *      the original static-exposure smoothstep AND a new LIVE one —
 *      `coherentVec.length()` normalized against the current ambient's own
 *      magnitude (self-scales with wind speed), smoothstepped through the
 *      SAME 0.25..0.65 band. A position the relaxation says is genuinely
 *      well-connected (a door really is open) now earns the full coherent
 *      push on that evidence ALONE, regardless of what the static paint says
 *      — the two signals are OR'd, so a confirmed-outdoor position by paint
 *      keeps working exactly as before; this only adds a second, truthful way
 *      to open the same gate. `gust-runtime.js` never had this problem (its
 *      own `sampleFlow`/target-velocity math never gated the coherent term by
 *      static exposure at all — only the dot engine, built earlier under
 *      item 28's original design, had a static gate to fix). NOT yet
 *      live-tested. Separate, STILL OPEN question raised by the SAME live
 *      report: the wind OVERLAY (which has no coherentGate at all — it reads
 *      sampleWind's raw ambient+structure directly) ALSO showed an unchanging
 *      corridor energy line regardless of door state — this fix cannot
 *      explain that, since the overlay was never gated by exposure to begin
 *      with. That points at something ELSE: either the relaxation genuinely
 *      isn't picking up THIS specific door's open/close toggle (a rebake- or
 *      wall-flag question), or the corridor has another connection to
 *      outside besides these two doors that keeps it "open" regardless of
 *      their state. Needs a targeted before/after door-toggle probe reading
 *      at the SAME corridor point to settle which — not yet done.
 *
 * @module effects/particles/particle-runtime
 */

import { ParticleArena, BYTES_PER_PARTICLE } from './particle-arena.js';
import {
  createWindHandle,
  packWindCells,
  deflectAroundWalls,
  WALL_MOMENTUM_GUARD_LOW,
  WALL_MOMENTUM_GUARD_HIGH,
  WALL_IMPACT_CHAOS_GAIN,
} from '../../world/index.js';
import { findNearestParticles, summarizeNearestParticles } from '../../diag/wind-probe.js';
import { createLogger } from '../../core/log.js';

const log = createLogger('particle-runtime');

/** A bake-less handle — an un-wired engine still gets the organic field rather
 * than dead-still motes (see candle-flame-render.js's own identical constant). */
const TIER0_WIND_HANDLE = createWindHandle();

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * GALE-FORCE CALIBRATION (author request, 2026-07-22): the wind system's
 * `windSpeed01` dial has never had a real-world anchor — it was a bare 0..1
 * scalar multiplied by an arbitrary per-effect "feels right" constant
 * (dust.js's old `windSpeedScale: 90`). This grounds it: `windSpeed01 = 1.0`
 * (full strength) is calibrated to Beaufort 8, "Gale" — the Beaufort formula
 * `v ≈ 0.836 × B^1.5 m/s` (docs/reference/wind-simulation-research.md §5.5,
 * citing Wikipedia/NOAA) gives ≈18.92 m/s for B=8, matching NOAA's own quoted
 * 34-40 kt gale range. Below 1.0 this is a plain LINEAR ramp from calm — the
 * research doc's own §5.5 flags a full Beaufort-curve or Weibull-flavored
 * intermediate mapping as a real future refinement, not yet built; getting
 * the ceiling right first is what this pass was asked to do.
 */
const GALE_MPS = 0.836 * Math.pow(8, 1.5); // ≈ 18.92 m/s

/**
 * Circular spread of a set of velocity DIRECTIONS (degrees in, a summary out).
 * `alignment` is the mean resultant length: 1 = every velocity points the SAME
 * way (a spatially UNIFORM field — the field is NOT reaching the kernel), 0 =
 * directions spread all around (a genuine per-cell field). `stddevDeg` is the
 * circular standard deviation. Pure, so the instrument's own maths is honest
 * (feedback_instruments_must_not_lie) — an instrument that miscalls "uniform"
 * vs "varied" would be worse than none.
 * @param {number[]} anglesDeg
 * @returns {{alignment:number, stddevDeg:number}|null}
 */
export function circularSpreadDeg(anglesDeg) {
  if (!Array.isArray(anglesDeg) || anglesDeg.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const a of anglesDeg) {
    const r = (a * Math.PI) / 180;
    sx += Math.cos(r);
    sy += Math.sin(r);
  }
  const R = Math.hypot(sx, sy) / anglesDeg.length; // 0..1
  const stdRad = Math.sqrt(Math.max(0, -2 * Math.log(Math.max(1e-6, R))));
  return { alignment: round2(R), stddevDeg: Math.round((stdRad * 180) / Math.PI) };
}

/**
 * Build the one engine for a single declared system (first slice: one system).
 *
 * @param {object} opts
 * @param {*} opts.THREE - the THREE namespace (injected; this file imports none).
 * @param {import('./particle-system-schema.js').ParticleSystemDecl} opts.system - e.g. WIND_DIAGNOSTIC_PARTICLES.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} opts.worldRect - where motes live (a mote that drifts outside this rect respawns at a fresh random point within it, so the field is always present as the camera pans/zooms — §12's fix-6 explains why this is an exit-test, not a modulo wrap).
 * @param {number} [opts.zDepth] - world z for the billboards (must be inside the camera frustum).
 * @param {object} [opts.windHandle] - THE wind handle (`world/wind-access.js`,
 *   Wind.md §5.1) — one object carrying the live ambient uniform NODES (passed
 *   by REFERENCE, so a wind-setting change is picked up next frame with no
 *   resync) AND the geometry-derived per-cell arrays (`openness`: is this cell
 *   connected to the map's open exterior through open space — walls/doors only,
 *   the painted `_Outdoors` mask never enters this computation; plus the
 *   wall-avoidance direction/proximity).
 *
 *   Its `kernel()` shape owns three things this file used to hand-write its own
 *   copy of: the nearest-cell index arithmetic, the meteorological ambient-bias
 *   formula, and the wall deflection. Those copies agreed with `sampleWind`
 *   only by a source comment claiming they did — and fix-5/fix-13 in this
 *   module's own header are both instances of that arrangement failing. A Node
 *   test now asserts the agreement (`world/__tests__/wind-access.test.mjs`).
 *
 *   Cells are read from a STORAGE BUFFER, not `sampleWind`'s texture path — a
 *   fragment/vertex-proven mechanism was proven NOT to work from inside a
 *   compute shader in this renderer (a live readback at a real building came
 *   back EXACTLY zero while the overlay showed real signal at the same spot).
 *   BOUND ONCE AT CONSTRUCTION; a LATER rebake needs its fresh values pushed in
 *   via {@link updateWind} — construction alone is not enough, since the FIRST
 *   bake this engine ever sees is typically the unconditionally-windless
 *   'startup' one. Omit → the unbent organic field everywhere (fully open).
 * @returns {{scene:*, init:(renderer:*)=>void, step:(renderer:*, frame:object)=>void, setWorldRect:(rect:object)=>void, updateWind:(handle:object|null)=>void, capacity:number, debugState:()=>object, readbackVelocities:(renderer:*, n?:number)=>Promise<object>, readbackNearestParticles:(renderer:*, worldX:number, worldY:number, n?:number)=>Promise<object>}}
 */
export function createParticleEngine({
  THREE,
  system,
  worldRect,
  zDepth = 0,
  windHandle = TIER0_WIND_HANDLE,
  // World px per real-world distance unit (Foundry's own `canvas.dimensions
  // .distancePixels` — "1 grid square = 1 meter" on a scene where grid
  // distance=1/units='m' makes this literally px-per-meter). A scene's grid
  // never changes mid-session (same discipline vt-pan-viewer.js's own
  // `readGridDistancePixels` call sites already follow), so this is
  // construction-time-only, exactly like `worldRect`/`zDepth` above.
  // Foundry's own documented default grid size (100px/square) if omitted —
  // never a silent guess, `foundry/scene-occlusion-sources.js`'s own fallback.
  pxPerMeter = 100,
}) {
  const TSL = THREE.TSL;
  const {
    Fn,
    instanceIndex,
    float,
    vec2,
    vec3,
    vec4,
    uniform,
    uv,
    positionGeometry,
    sin,
    cos,
    fract,
    mix,
    smoothstep,
    pow,
  } = TSL;

  const p = system?.params ?? {};
  const capacity = Math.max(1, Math.floor(p.capacity ?? 4096));

  // --- the arena: one pool for this system, allocated once, never freed (§10) --
  const arena = new ParticleArena({ budgetBytes: BYTES_PER_PARTICLE * capacity });
  const buffers = arena.allocateBuffers(TSL);
  const position = buffers.position; // vec2 world
  const velocity = buffers.velocity; // vec2 world px/s
  const age = buffers.age; // ms alive
  const seed = buffers.seed; // per-particle stable seed
  const custom = buffers.custom; // vec4 scratch — xy holds this frame's structure deviation, for the diagnostic readback

  // --- the OPENNESS + WALL-AVOIDANCE grid (2026-07-22 openness, WIDENED
  // --- 2026-07-23 for wall-avoidance): a storage buffer, uploaded ONCE, read
  // --- via a nearest-cell lookup — NOT a texture sample (a fragment/vertex-
  // --- proven mechanism was proven NOT to work from inside a compute shader
  // --- in this renderer; storage buffers are). ONE `vec4` buffer — x=
  // --- openness, y=wall-away-dirX, z=wall-away-dirY, w=wall-proximity —
  // --- rather than a second SEPARATE buffer for the new wall-avoidance data
  // --- (2026-07-23, author: "prevent wind from crossing walls... breaks
  // --- around objects instead of just losing all its energy"): this file's
  // --- OWN arena already uses 6 buffers (particle-arena.js#PARTICLE_
  // --- ATTRIBUTES) and gust-runtime.js's sibling engine adds a 7th
  // --- (trailHistory) + this one = 8 — the WebGPU spec-guaranteed floor for
  // --- storage-buffer count per stage (`vt/texture-limits.js`'s own doc —
  // --- "9 buffers... exceeds the maximum per-stage limit (8)" was a REAL,
  // --- previously-hit failure). Packing avoids ever re-approaching that
  // --- ceiling instead of trusting the raised 16-buffer request to always
  // --- be granted. See this function's own `opennessGrid` param doc. Small
  // --- (cols*rows cells, typically a few hundred to a few thousand), a
  // --- one-time upload, unrelated to the particle arena's per-particle
  // --- budget. Legal here: the particles/allocator-only wall allows
  // --- instancedArray anywhere under effects/particles/, not only the arena
  // --- file.
  let windOpennessBuffer = null;
  let opnCols = 1;
  let opnRows = 1;
  let windHandleVersion = windHandle?.version ?? -1;
  if (windHandle?.grid && windHandle?.cells) {
    const { cols, rows } = windHandle.grid;
    opnCols = cols;
    opnRows = rows;
    const n = Math.max(1, cols * rows);
    windOpennessBuffer = TSL.instancedArray(n, 'vec4');
    // `packWindCells` (world/wind-access.js) writes the CPU-computed grid
    // directly into the storage attribute's OWN backing Float32Array
    // (StorageInstancedBufferAttribute extends BufferAttribute, so `.array` is
    // a plain writable typed array — verified against the vendored source,
    // three.webgpu.js:49706-49719) BEFORE any compute dispatch touches it. The
    // renderer uploads whatever `.array` holds when it first creates the
    // backing GPU buffer, so this is filled in before that first read ever
    // happens — no compute-kernel write pass needed to seed it, unlike every
    // PER-PARTICLE buffer above. The packing itself lives beside the `kernel()`
    // shape that READS it, so writer and reader cannot drift.
    packWindCells(windOpennessBuffer.value, windHandle.cells, n);
  }

  // --- uniforms: built once, values updated per frame (zero per-frame alloc) ---
  const uDtSec = uniform(0);
  const uTimeMs = uniform(0);
  const uRectMin = uniform(vec2(worldRect.minX, worldRect.minY));
  const uRectSize = uniform(vec2(worldRect.maxX - worldRect.minX, worldRect.maxY - worldRect.minY));
  const uWindGain = uniform(float(p.windGain ?? 0.6));
  // sampleWind returns a DIMENSIONLESS lean (candle scales it to a quad
  // fraction; light, to a radius fraction) — REAL-UNIT CALIBRATED as of
  // 2026-07-22 (author request), replacing the old by-eye `windSpeedScale`:
  // pxPerMeter × GALE_MPS is the world-px/sec a mote's TARGET velocity
  // reaches at windSpeed01=1.0 (this file's own GALE_MPS doc has the
  // Beaufort-formula derivation). windSpeed01 itself still scales this
  // linearly below full strength — see this module's header, checklist item
  // 24, for the acceleration/ceiling mechanism this feeds.
  const uMaxSpeedAtGalePxPerSec = float(pxPerMeter * GALE_MPS);
  // Exposure-gated OPTIONAL style nudge (fix-16/19) — 1 = no-op (the DEFAULT
  // now that the base scale above is physically real; the old default of 4
  // was compensating for windSpeedScale being an arbitrary, too-weak-feeling
  // guess, which real gale-force calibration no longer needs). Still
  // available for an author who wants outdoor gusts to read stronger than
  // the physical ceiling as a deliberate STYLE choice, not a correction.
  const uOutdoorSpeedBoost = uniform(float(p.outdoorSpeedBoost ?? 1));
  const uDriftPx = uniform(float(p.driftPx ?? 3));
  // RANDOM SIZE + OPACITY (author request, 2026-07-22): replaces the old
  // fixed `sizePx`/`opacity`. Re-rolled fresh each time a mote is BORN (not
  // once per arena slot forever) — see `vFade`'s own comment below for the
  // precision-safe per-life hash this and the life-fade envelope share.
  // opacityMax defaults to 0.8 — the author's own explicit ceiling ("opacity
  // 80% at max"), not a hard clamp: an author who wants a different ceiling
  // can still set it higher via params, this is just what dust.js ships.
  const uSizeMinPx = uniform(float(p.sizeMinPx ?? 8));
  const uSizeMaxPx = uniform(float(p.sizeMaxPx ?? 24));
  const uOpacityMin = uniform(float(p.opacityMin ?? 0.15));
  const uOpacityMax = uniform(float(p.opacityMax ?? 0.8));
  // ACCELERATION, NOT AN INSTANT VELOCITY SNAP (author request, 2026-07-22)
  // — this kernel used to recompute velocity FRESH from the field every
  // frame with no momentum at all (this file's own header, the ORIGINAL
  // design note: "there is no energy to build up"). accelToMaxSeconds is how
  // long, from a standing start, a mote takes to reach the CURRENT
  // gale-scaled ceiling — the actual acceleration magnitude scales WITH that
  // live ceiling (see the update kernel's own comment), so stronger wind
  // both raises the ceiling AND reaches it faster, matching how a real gust
  // snaps taut rather than crawling up evenly regardless of strength.
  const uAccelToMaxSeconds = uniform(float(Math.max(0.05, p.accelToMaxSeconds ?? 2.5)));
  // KILL STALLED PARTICLES FASTER — BUILT, then REVERTED same day
  // (2026-07-22): author-confirmed live, it killed EVERY particle. Root
  // cause: a mote spawns at velocity (0,0) (seedKernel, below) and, once
  // acceleration landed (checklist item 24), now spends real TIME ramping
  // up from a standing start instead of snapping to speed instantly — so
  // for a meaningful fraction of every fresh mote's early life, its actual
  // speed genuinely reads below any reasonable "stalled" threshold, aging
  // it out before it ever got moving. The stall-death check itself was not
  // wrong in isolation; it was fundamentally incompatible with the
  // acceleration feature landing in THE SAME TURN, and nobody (including
  // me) traced that interaction before shipping both together. See
  // feedback_plausible_diagnosis_rots-class lesson in memory:
  // keyhole-particle-real-physics.md's own updated record.
  // THE LIFESPAN RUNG (author request, 2026-07-22): a fixed lifetime with a
  // symmetric fade envelope at both ends, so the population visibly cycles
  // instead of drifting forever — dust.js's own header used to call this
  // "unused at tier 1's toroidal wrap"; it is wired now. `fadeMs` is clamped
  // to at most half of `lifeMs` so the fade-in and fade-out windows can never
  // overlap (a life shorter than 2×fade would otherwise dip below full
  // opacity in the middle, which is not what "fade at both ends" means).
  const uLifeMs = uniform(float(Math.max(1, p.lifeMs ?? 6000)));
  const uFadeMs = uniform(float(Math.min(p.fadeMs ?? 2000, (p.lifeMs ?? 6000) / 2)));
  // INDOOR = CHAOTIC, NOT WIND-FOLLOWING (item 28, author request, replacing
  // fix-20's blanket `stillness` damping) — see the coherentGate/chaosBoost
  // comment at the update kernel's own use site for the full reasoning.
  // Deep indoors, the ONLY thing indoorChaosBoost affects is how visible the
  // small organic-noise + per-particle-drift term is (never the prevailing
  // wind direction, which is gated to ~0 there) — a genuinely sealed room
  // should look like still, wandering dust, not a slow coherent breeze.
  // TUNED DOWN 4 → 2 (item 29, author: "the indoor chaos needs to be 50% less
  // energetic") — halving this halves BOTH the organic-noise and per-particle
  // drift contribution deep indoors, the only two terms alive there, so the
  // sealed-room motion reads at half its previous energy.
  const uIndoorChaosBoost = uniform(float(p.indoorChaosBoost ?? 2));
  // OUTDOOR GALE MULTIPLIER (item 29, author: "outdoor particles blown by
  // galeforce winds need to move 2x faster... the trick is making the
  // outdoors particles get that fast without making indoors particles get
  // faster"). Applied ONLY to the coherent (direction-following) target and
  // to the location-INDEPENDENT ceiling — NEVER to the chaos term. Because
  // the coherent target is itself gated by `coherentGate` (≈0 deep indoors),
  // multiplying it changes outdoor speed while leaving sheltered motes — whose
  // motion is entirely the un-boosted chaos term — untouched. 2× the calibrated
  // Beaufort-8 gale (≈18.92 m/s) lands outdoor motes near ≈37.8 m/s at
  // windSpeed01=1, i.e. hurricane-force — still far below the ≈90-100 m/s
  // (one 1 m cell per ~10 ms) the author cited as the highest *survivable*
  // sustained wind, so there is deliberate headroom here for an even stormier
  // preset later without a mote ever crossing one grid cell per frame.
  const uOutdoorGaleBoost = uniform(float(p.outdoorGaleBoost ?? 2));
  // Per-frame chance a mote force-respawns even while IN bounds (fix-17) —
  // driven from JS in setWorldRect() only right after a real zoom (rect area
  // changed a lot); 0 the rest of the time, so steady viewing never teleports
  // a mote. See setWorldRect's own comment for the mechanism this answers:
  // the exit-test alone never fires for a particle the NEW (larger) rect
  // still contains, so zooming OUT left everyone clustered in whatever the
  // old, smaller rect used to be — "a screen-shaped bucket of particles."
  const uRespawnChance = uniform(0);

  // A tiny self-contained hash → [0,1). Deliberately NOT depending on TSL.hash
  // being exported; fract(sin(·)) is standard and enough for seeding/variation.
  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));

  // --- SEED kernel: spread motes across the rect, one-off (§14 steady spawn) ----
  const seedKernel = Fn(() => {
    const i = instanceIndex;
    const fi = float(i);
    const hx = hash11(fi.mul(2.17).add(11.3));
    const hy = hash11(fi.mul(1.31).add(47.9));
    position.element(i).assign(vec2(uRectMin.x.add(uRectSize.x.mul(hx)), uRectMin.y.add(uRectSize.y.mul(hy))));
    velocity.element(i).assign(vec2(0, 0));
    seed.element(i).assign(fi);
    // Stagger ages across the FULL lifetime, not a fixed short window — with
    // the lifespan rung now wired, this is what makes the population start
    // already spread across its fade envelope (some just born, some mid-life,
    // some about to expire) instead of everyone fading in from age 0 in
    // lockstep the moment the scene loads.
    age.element(i).assign(hash11(fi.mul(3.7)).mul(uLifeMs));
  })().compute(capacity);

  // --- UPDATE kernel: sample wind, integrate, exit-test (§12 in-place, no ping-pong) -
  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const pos = position.element(i).toVar();
    const s = seed.element(i);
    // THE wind read, through the one door — never private noise (§13).
    // `windAmbient` is the smooth prevailing wind + organic gusts, via
    // sampleWind (pure math + procedural noise, no texture — proven safe in a
    // compute kernel).
    //
    // OPENNESS (2026-07-22, THE RETHINK — see world/wind-enclosure.js#
    // floodFillOpenFromBoundary's own header) — a real per-position
    // nearest-cell lookup. THIS ONE VALUE now does both jobs three separate
    // grids used to split between them (a painted-mask exposure grid, a
    // wall-relaxation structure grid, a door-chaos grid — all DELETED, see
    // this module's own header): it is sampleWind's own `exposure` argument
    // below (damps the organic gust/flutter term between a small indoor
    // residual and full outdoor sway) AND it is `coherentGate` further down
    // (gates the compass-heading push to exactly zero wherever geometry
    // seals a cell off — walls/doors only, the painted `_Outdoors` mask is
    // NOT consulted anywhere in this kernel). Default 1 (fully open) where
    // no grid is wired, never a silent "everything is sealed."
    // THE ONE DOOR (Wind.md §5.1) — the nearest-cell lookup, the meteorological
    // ambient-bias arithmetic and the wall deflection are all the handle's
    // `kernel()` shape now. This kernel used to carry its own hand-written copy
    // of all three (and gust-runtime.js a fourth), agreeing with `sampleWind`
    // only by a comment claiming they did. Asserted by a real test now
    // (world/__tests__/wind-access.test.mjs).
    const w = windHandle.kernel(TSL, { centerXY: pos, time: uTimeMs, cellBuffer: windOpennessBuffer });
    const { openness, wallAwayDirX, wallAwayDirY, wallProximity } = w;
    // COHERENT vs CHAOTIC (replacing fix-20's blanket `stillness`) — a mote
    // should not feel OBLIGED to travel in the scene's prevailing wind
    // direction just because it is damped down; a genuinely sheltered spot
    // should feel like disordered, wandering air, not a quiet coherent
    // breeze. So the two kinds of motion are kept as SEPARATE vectors,
    // gated in OPPOSITE directions by openness, rather than one combined
    // vector scaled by one factor:
    //   - COHERENT: the ambient directional bias (points a specific way,
    //     tracking "the wind" as a scene setting) — full strength only
    //     where openness reads 1 (see coherentGate below); zero the instant
    //     a position is sealed off, so an enclosed room's motes stop
    //     chasing the compass heading at all, by construction.
    //   - CHAOTIC: sampleWind's own organic gust/flutter noise (procedural,
    //     no fixed direction) plus the per-particle drift term — BOOSTED as
    //     a position reads more sheltered (see chaosBoost below), so a
    //     sealed room's dust still visibly moves, just with no preferred
    //     direction, instead of the field simply going quiet.
    // `organic` is the field WITHOUT its ambient term — only the organic
    // dir+flutter (damped internally by `openness` as its `exposure`) plus
    // turbulence, never the ambient bias. The ambient arrives SEPARATELY as
    // `coherent` so it can be gated by `coherentGate` alone instead of sharing
    // one scale factor with the chaos. Inside the handle, this kernel's OWN
    // real per-particle openness is passed for BOTH the `openness` and
    // `exteriorOpenness` slots — there is no spare buffer channel here for a
    // genuine third signal (this file and gust-runtime.js sit at or near the
    // WebGPU 8-storage-buffer-per-stage limit, see the buffer's own
    // construction-site comment), and that reuse is not a shortcut: see
    // `computeWindTurbulence`'s own param doc for why it produces a correctly-
    // shaped curve (calm when sealed, peak chaos at the doorway transition,
    // calmer large-scale swirl once fully in the open).
    const windOrganic = w.organic;
    // The COHERENT push (2026-07-22, THE RETHINK — the wall-structure lean
    // this used to also add is DELETED, see this module's own header): the
    // ambient bias, DEFLECTED off nearby walls, arriving UNGATED so
    // `coherentGate` below decides how much of it actually reaches the target.
    // The angle convention and the deflection are the handle's now — this file
    // used to spell both out itself and vouch for the match in a comment.
    const coherentVec = w.coherent;
    // a small per-particle drift so dead-still air still stirs — FIXED (fix-20):
    // this was applied UNCONDITIONALLY, with no exposure gate at all. Worse, it
    // is a function of `s` (the particle's fixed seed) ONLY — never position or
    // time — so it is not per-frame noise, it is a PERMANENT PER-PARTICLE BIAS:
    // every particle nudges in its own fixed direction, forever. Outdoors this
    // was masked by real wind dominating; but once exposure correctly damped
    // the real wind terms down to near-zero indoors (fix-14), this ungated,
    // never-changing nudge became the ONLY visible motion in a sheltered room —
    // and because every particle's fixed direction differs, a whole population
    // of them reads as incoherent "wiggle" even though each individual mote is
    // just steadily drifting one way. Author: "conservation of energy problem,
    // air drag... particles don't have a force causing them to slow down" — AT
    // THE TIME, the mechanism was not a missing drag term (this kernel had NO
    // momentum/inertia to conserve at all yet: `vel` was recomputed FRESH from
    // the CURRENT field sample every frame, never integrated from the previous
    // frame's velocity) — it was this one specific, always-on term that never
    // checked whether it was appropriate. STALE AS OF 2026-07-22: the kernel
    // NOW does integrate velocity frame-to-frame (checklist item 24, below) —
    // this paragraph is kept for the historical diagnosis, not as a current
    // description of the kernel's own physics model.
    const drift = vec2(hash11(s.add(5.0)).sub(0.5), hash11(s.add(9.0)).sub(0.5));
    // windVec is a dimensionless lean (fix-5) — uMaxSpeedAtGalePxPerSec is
    // what turns it into an actual, REAL-UNIT-calibrated world-px/sec target
    // (checklist item 24); uWindGain is the per-effect "how strongly does
    // dust respond" dial on top of that. speedBoost rides the SAME
    // `openness` already computed above, but as a THRESHOLD (smoothstep),
    // not a linear mix: a linear mix would apply a meaningful fraction of
    // the boost even to a position that's mostly-but-not-fully open.
    // smoothstep(0.5,0.9,openness) instead stays EXACTLY 0 below 0.5, so
    // only positions unambiguously outdoors ever get boosted — genuinely live
    // now that openness is graded (2026-07-22, same-day door-distance
    // penetration falloff, Wind-Rethink.md §5 q1): a mote just past an open
    // door reads openness near 1 but this threshold still keeps it out of
    // the outdoor-speed boost until it's unambiguously in the open.
    // strengthCurve (author: "gale isn't fast enough by a long way, breeze
    // is hard to distinguish from calm") widens the calm→gale range:
    // sqrt(speed01) pulls MID wind-strength settings up disproportionately
    // (e.g. speed01=0.25 → 0.5, not 0.25), so a light breeze reads clearly
    // stronger than dead calm, while speed01=0/1 stay at the floor/ceiling —
    // multiplicatively combined with the openness gate, NEVER applied indoors.
    // The PREVAILING strength, for this engine's own speed ceiling — a
    // different question from "what is the wind vector here", which is why the
    // handle exposes it (see its `ambient` field's own doc).
    const windSpeed01 = windHandle.ambient ? windHandle.ambient.speed01 : float(1);
    const strengthCurve = pow(windSpeed01.clamp(float(0), float(1)), float(0.5));
    const outdoorMultiplier = mix(float(1), uOutdoorSpeedBoost, strengthCurve);
    const boostT = smoothstep(float(0.5), float(0.9), openness);
    const speedBoost = mix(float(1), outdoorMultiplier, boostT);
    // COHERENT GATE — how much of the direction-following push (ambientBias)
    // actually reaches the target. Simply `openness` (2026-07-22, THE
    // RETHINK — docs/planning/Wind-Rethink.md §4): 1 where this cell is
    // connected to the outside through open space (walls/doors only), 0
    // where sealed off, geometry-only and exact in one flood-fill pass at
    // any corridor length — no painted mask, no physics solve, door-
    // responsive by construction (a shut door is a solid cell the fill
    // can't cross → openness 0 → coherent wind 0; opening it lets the fill
    // through → openness floods in). This REPLACES three failed
    // predecessors that all, one way or another, let a painted mask or a
    // never-converging potential-flow relaxation decide wind presence — see
    // this module's own header and docs/planning/Wind-Rethink.md §1 for the
    // full chronicle of why each one failed.
    const coherentGate = openness.clamp(float(0), float(1));
    // CHAOS BOOST — the mirror image of coherentGate: as a position reads
    // MORE sheltered, the organic noise term and the per-particle drift term
    // are amplified, so a sealed room's dust is still visibly, believably in
    // motion — just with no preferred direction — instead of simply going
    // quiet the way suppressing everything by one `stillness` factor used to
    // produce. `uIndoorChaosBoost` is how much extra weight the chaotic
    // terms get at full shelter; outdoors (coherentGate=1) this is a no-op
    // (chaosBoost=1), so the chaotic terms keep their natural, undramatic
    // outdoor magnitude and the coherent push does the heavy lifting there.
    // DOOR-PROXIMITY TURBULENCE (an extra additive term here, gated by
    // `coherentGate.oneMinus()` so it stayed a no-op outdoors) is DELETED
    // from THIS kernel, not forgotten — general curl-noise turbulence is now
    // built (2026-07-22, same day, `world/wind-field.js#sampleWind`'s own
    // organic term, which `windOrganic` below already reads), applied
    // everywhere rather than door-proximity-gated specifically; a sharper
    // door-local variant remains a possible future refinement, not built.
    const chaosBoost = mix(uIndoorChaosBoost, float(1), coherentGate);
    // TARGET velocity, in real world px/sec (checklist item 24) — what the
    // field/boost/gate math above says a mote WANTS to be doing this
    // instant, before acceleration limits how fast it can actually get
    // there. The coherent and chaotic contributions are summed AFTER each
    // gets its OWN independent scale, never one shared factor.
    //
    // `uOutdoorGaleBoost` (item 29, default 2) rides the COHERENT term ONLY,
    // never the chaos terms. Because it multiplies AFTER `coherentGate` — which
    // is ≈0 deep indoors — a 2× outdoor gale leaves a sheltered mote's target
    // (pure chaos there) completely unchanged: this is the "make outdoors
    // faster without making indoors faster" requirement expressed directly in
    // the algebra, not as a location `if`.
    const targetVelRaw = coherentVec
      .mul(uMaxSpeedAtGalePxPerSec)
      .mul(uWindGain)
      .mul(speedBoost)
      .mul(coherentGate)
      .mul(uOutdoorGaleBoost)
      .add(windOrganic.mul(uMaxSpeedAtGalePxPerSec).mul(uWindGain).mul(chaosBoost))
      .add(drift.mul(uDriftPx).mul(chaosBoost));
    // THE CEILING (author request: "accelerate particles up to a maximum
    // that is set by the preset of wind speed") — whatever the raw
    // field/boost math above computed, a mote may never exceed the scene's
    // OWN gale-scaled maximum: windSpeed01 × speedBoost × outdoorGaleBoost,
    // the SAME "how strong is outdoor wind right now" question, deliberately
    // NOT location-gated (no coherentGate/chaosBoost factor here) — this is a
    // single, LOCATION-INDEPENDENT safety cap, so it never collapses the
    // instant a mote crosses into shelter (that collapse was the root cause
    // of checklist items 25-27's whole saga; item 28 removed the need for
    // any of those workarounds by making the ceiling itself stable, and item
    // 29 KEEPS it location-independent while raising it — the boost is the
    // same constant everywhere, so the stability guarantee is untouched).
    // Raising the cap by outdoorGaleBoost does NOT speed indoor motes up: an
    // indoor target is the small chaos term, far below even the un-boosted
    // cap, so the cap never clamps it; the boost only lets the outdoor
    // coherent term (which alone can approach the cap) reach its new 2×
    // target. `.max(float(1))` keeps the ceiling, and the safe-divide guards
    // below, away from a literal 0 at windSpeed01=0 (dead calm) without
    // changing any real over-ceiling case.
    const ceilingPxPerSec = uMaxSpeedAtGalePxPerSec
      .mul(windSpeed01)
      .mul(speedBoost)
      .mul(uOutdoorGaleBoost)
      .max(float(1));
    const targetSpeed = targetVelRaw.length();
    const overCeiling = targetSpeed.greaterThan(ceilingPxPerSec);
    // Safe normalize-and-rescale: only evaluated when overCeiling actually
    // selects it (targetSpeed > ceilingPxPerSec >= 1 there), but TSL builds
    // both branches unconditionally, so `.max(float(1))` keeps the UNUSED
    // branch's own division finite too — the same defensive pattern this
    // kernel already uses for `toTargetDist` below.
    const clampedTargetVel = targetVelRaw.mul(ceilingPxPerSec.div(targetSpeed.max(float(1))));
    const targetVel = overCeiling.select(clampedTargetVel, targetVelRaw);
    // ACCELERATE toward the target, never snapping instantly (author
    // request) — bounded by uAccelToMaxSeconds; the acceleration MAGNITUDE
    // scales with `ceilingPxPerSec` (checklist item 24: a stronger gust
    // both raises the ceiling and reaches it faster, matching how a real
    // gust snaps taut rather than crawling up evenly regardless of
    // strength). Items 26/27 fought a version of this ceiling that
    // collapsed the instant a mote crossed into shelter (braking power
    // collapsing WITH the target it was chasing down, then — item 27's
    // own bug — collapsing further via a self-referential basis fed by the
    // mote's own shrinking speed). Item 28 removes the root cause instead
    // of patching around it: `ceilingPxPerSec` is now LOCATION-INDEPENDENT
    // by construction (no coherentGate/chaosBoost/stillness factor in it
    // at all — see its own comment above), so it never collapses, braking
    // is always a genuine constant-magnitude ramp, and no separate
    // "reference ceiling" workaround is needed here anymore.
    //
    // Item 29 note: `ceilingPxPerSec` now carries `uOutdoorGaleBoost`, so this
    // acceleration rate is 2× what it was — a deliberate, benign side effect.
    // Braking a fast outdoor mote that blows INTO shelter is now BRISKER (it
    // sheds up to 2× gale within accelToMaxSeconds, so it can't coast deep
    // into a room — the very "windward energy indoors" symptom items 25-28
    // chased). It does NOT make indoor motion more energetic: the indoor
    // target is the small chaos term, and `maxStep = rate × dt` stays far
    // below that target's own magnitude, so momentum smoothing survives —
    // motes ease toward the chaos target over a fraction of a second, they do
    // not snap to it frame-by-frame (which WOULD read as jitter). If a live
    // look ever shows indoor jitter, `indoorChaosBoost`/`accelToMaxSeconds`
    // are the live knobs, not this coupling.
    const maxAccelPxPerSec2 = ceilingPxPerSec.div(uAccelToMaxSeconds);
    const oldVel = velocity.element(i);
    const toTarget = targetVel.sub(oldVel);
    const toTargetDist = toTarget.length();
    const maxStep = maxAccelPxPerSec2.mul(uDtSec);
    const reachesTarget = toTargetDist.lessThanEqual(maxStep);
    const step = toTarget.mul(maxStep.div(toTargetDist.max(float(0.0001))));
    const blendedVel = oldVel.add(reachesTarget.select(toTarget, step));
    // WALL AVOIDANCE ON THE ACTUAL MOVE, NOT JUST THE TARGET (2026-07-23,
    // author: "make that wall logic and redirection work for the actual
    // particles themselves... need updating with this information about
    // walls they are meant to go around and not through") — deflecting
    // `coherentVec` above (targetVel's own ingredient) is NOT enough on its
    // own: this mote has MOMENTUM (`oldVel`), eased toward the target over
    // `uAccelToMaxSeconds`, never snapped instantly. A mote already carrying
    // speed INTO a wall when it enters the deflection zone still has
    // old, undeflected momentum this frame — the target redirected the
    // instant it crossed in, but the mote's OWN velocity hasn't caught up
    // yet, so it can still coast forward into the wall for a few frames
    // while braking/turning catches up. Deflecting `blendedVel` itself,
    // sampled at THIS frame's starting position (the SAME wallAwayDirX/Y/
    // wallProximity already read above), cancels whatever into-wall
    // component survived the acceleration blend BEFORE it ever becomes a
    // displacement — and since the corrected value is also what gets stored
    // back into the velocity buffer below, the mote's own momentum is
    // corrected too, not just this one frame's move (a wall a mote is
    // pressed against keeps getting cancelled every frame, not fought once
    // and re-lost the next).
    //
    // A NARROWER PROXIMITY, JUST FOR THIS PASS (2026-07-23, author, a second
    // screenshot: "particles are now deflecting even further from the
    // walls... it's causing the particles to immediately veer away causing
    // them to pile up a long way away from the wall") — widening
    // WALL_DEFLECT_REACH_CELLS (the fix for the PREVIOUS report) made this
    // WORSE, not better, because this specific correction is APPLIED
    // INSTANTLY (a direct reassignment of `vel`, not eased through
    // `maxAccelPxPerSec2` like every other velocity change in this kernel).
    // Across the full width of a wide reach, that reads as an abrupt shove
    // the instant a mote crosses the boundary — exactly "immediately veer
    // away" — and because it fires the same way on every mote that enters
    // that whole wide band, motes never get NEAR the wall before being
    // turned back, piling up at the band's own outer edge instead. The WIDE,
    // GRADUAL "curve as you approach" look the author originally asked for
    // still comes from `coherentVec`'s own deflection above — that one feeds
    // into `targetVel`, which THIS mote's `oldVel` can only chase at the
    // kernel's normal acceleration rate, so it was already smooth by
    // construction. This pass's actual job is narrower: a last-instant
    // guarantee against tunnelling for a mote whose momentum genuinely
    // didn't turn in time — so it should only ever fire right before
    // contact, not across the whole approach. `smoothstep` remaps the SAME
    // wide `wallProximity` so this pass is a hard 0 until ~75% of the way
    // through the band and only ramps to full strength in the last stretch —
    // no separate baked field, no new texture/buffer channel.
    const momentumGuardProximity = smoothstep(
      float(WALL_MOMENTUM_GUARD_LOW),
      float(WALL_MOMENTUM_GUARD_HIGH),
      wallProximity
    );
    // CHAOTIC IMPACT KICK (2026-07-23, author: "if wind particles hit a
    // perpendicular wall to the direction of wind they tend to hit it, lose
    // their windward energy, but they don't get push chaotically around
    // when they impact... instead of being chaotically rediverted" —
    // clumping/sliding along walls after arriving cleanly). See
    // `deflectAroundWalls`'s own header for the full "why a dead-on hit
    // gets NO redirect otherwise" reasoning. The random direction is this
    // kernel's job to generate (the shared function has no seed of its
    // own): the SAME `hash11` idiom already used for drift/respawn above,
    // seeded from this mote's own stable seed PLUS its current position (so
    // it varies as the mote moves through the impact zone across several
    // frames, not a single frozen value) plus a SLOW time term (so a mote
    // sitting still, or two motes meeting at the same spot on different
    // visits, don't always scatter identically).
    const chaosAngle = hash11(s.mul(11.7).add(pos.x.mul(0.023)).add(pos.y.mul(0.019)).add(uTimeMs.mul(0.0007))).mul(
      float(Math.PI * 2)
    );
    const vel = deflectAroundWalls(TSL, {
      vector: blendedVel,
      awayDirX: wallAwayDirX,
      awayDirY: wallAwayDirY,
      proximity: momentumGuardProximity,
      chaosDirX: cos(chaosAngle),
      chaosDirY: sin(chaosAngle),
      chaosAmount: momentumGuardProximity.mul(float(WALL_IMPACT_CHAOS_GAIN)),
    });
    const next = pos.add(vel.mul(uDtSec));
    // EXIT TEST, not a modulo wrap (fix-6): a rect-size change (a zoom) would
    // make `mod` remap the WHOLE population at once, clustering by construction.
    // A mote that drifts outside the current rect instead respawns at a fresh
    // random point within it; everything still inside is untouched.
    const outOfBounds = next.x
      .lessThan(uRectMin.x)
      .or(next.x.greaterThan(uRectMin.x.add(uRectSize.x)))
      .or(next.y.lessThan(uRectMin.y))
      .or(next.y.greaterThan(uRectMin.y.add(uRectSize.y)));
    // FORCE-RESPAWN CHANCE (fix-17): the exit test alone never fires for a
    // mote the CURRENT rect still contains — which is exactly the case right
    // after zooming OUT (the rect suddenly grows to contain everyone), so
    // nothing ever told the existing population to spread out and fill the
    // newly-revealed area; they stayed clustered in whatever the smaller,
    // zoomed-in rect used to be. uRespawnChance is 0 during ordinary viewing
    // (JS only raises it for a short window right after a real rect-area
    // change — setWorldRect's own comment) so this is silent/inert normally,
    // and gives every particle an independent chance to reshuffle into the
    // new rect within about a second of a zoom.
    const wrappedT = uTimeMs.sub(float(10000).mul(uTimeMs.div(float(10000)).floor()));
    const respawnRoll = hash11(s.mul(0.71).add(wrappedT.mul(0.013)).add(19.0));
    const forceRespawn = respawnRoll.lessThan(uRespawnChance);
    // LIFESPAN EXPIRY: a mote that has lived out uLifeMs respawns exactly
    // like one that drifted out of bounds — same reseed, same fresh random
    // position — so "died of old age" and "died of leaving the rect" are
    // visually identical, just triggered differently. Read BEFORE this
    // frame's age increment below, same discipline as reading `pos` before
    // integrating `next`.
    const ageExpired = age.element(i).greaterThanEqual(uLifeMs);
    const shouldRespawn = outOfBounds.or(forceRespawn).or(ageExpired);
    // Reseed entropy from the particle's OWN seed + its OWN (bounded, exit-time)
    // position — NEVER the wall clock (fix-8, this module's header): sin()'s
    // float32 precision collapses at large arguments, and uTimeMs grows
    // UNBOUNDED all session long, so an earlier draft that hashed `s + uTimeMs`
    // let the (huge, shared-across-every-particle) clock term swamp the small
    // per-seed differences — many distinct particles could alias onto nearly
    // the SAME "random" output, worst right when a zoom reseeds many at once.
    // Position and seed are both naturally bounded (by the scene size and by
    // `capacity`), so this hash's argument never grows over a session.
    const rndA = hash11(s.mul(0.61).add(next.x.mul(0.011)).add(7.0));
    const rndB = hash11(s.mul(0.83).add(next.y.mul(0.013)).add(51.0));
    const reseedPos = vec2(uRectMin.x.add(uRectSize.x.mul(rndA)), uRectMin.y.add(uRectSize.y.mul(rndB)));
    const finalPos = shouldRespawn.select(reseedPos, next);
    position.element(i).assign(finalPos);
    velocity.element(i).assign(vel);
    // Stash diagnostics for the readback — the definitive answer to "is a
    // sheltered mote actually READING low openness, or is the gate math not
    // being applied despite a correct reading? Is it still chasing the
    // compass heading when it shouldn't be?" Without this, those failure
    // modes are indistinguishable from outside (feedback_instruments_must
    // _not_lie: a diagnostic that can't tell them apart is not a diagnostic).
    // xy = the COHERENT push actually applied this frame (ambientBias ×
    // coherentGate — 2026-07-22, THE RETHINK: there is no more per-cell
    // structure deviation to report pre-gate, since the coherent vector is
    // now a uniform ambient bias; this is the position-VARYING quantity
    // worth watching instead — ≈0 indoors, ≈|ambientBias| outdoors). z =
    // openness (0/1, what this particle's cell read). w = coherentGate (the
    // SAME value as z today — both collapsed onto one source of truth — kept
    // as its own slot so `coherentGateApplied`-named readback consumers below
    // don't need to change shape.
    const coherentApplied = coherentVec.mul(coherentGate);
    custom.element(i).assign(vec4(coherentApplied.x, coherentApplied.y, openness, coherentGate));
    // A respawning mote starts its life over at age 0 (born fully faded-in
    // from nothing, per the fade-in envelope below) — never just KEEP
    // incrementing an age that already passed uLifeMs, which would leave it
    // permanently past its fade-out window and invisible forever after.
    const agedMs = age.element(i).add(uDtSec.mul(1000));
    age.element(i).assign(shouldRespawn.select(float(0), agedMs));
  })().compute(capacity);

  // --- the DRAW: ONE instanced billboard, positions straight from the arena ----
  // InstancedBufferGeometry (not InstancedMesh) so there is no instanceMatrix to
  // reconcile with a positionNode that already returns world space.
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.attributes.position);
  geometry.setAttribute('uv', base.attributes.uv);
  geometry.instanceCount = capacity;

  // PER-LIFE RANDOM VALUE (random size + random opacity, author request,
  // 2026-07-22): a value that's STABLE across one mote's whole life but
  // re-rolls to something fresh each time that arena SLOT is reborn — reused
  // with a different `salt` for size vs. opacity so the two vary
  // independently rather than moving in lockstep. `uTimeMs - ageMs` is the
  // mote's own birth timestamp (constant after the birth frame: both terms
  // advance by the same dt every frame thereafter), WRAPPED to a bounded
  // window before hashing so a long session's ever-growing uTimeMs never
  // repeats this file's own fix-8 precision trap (checklist item 8 — sin()
  // loses precision on large arguments; the SAME wrap technique the update
  // kernel's `wrappedT` already uses for the force-respawn roll).
  // BIRTH_WRAP_MS comfortably exceeds uLifeMs so no single life ever
  // straddles a wrap boundary and reads two different "random" values
  // partway through.
  const BIRTH_WRAP_MS = 20000;
  const lifeRandomOf = (s, ageMs, salt) => {
    const birthMs = uTimeMs.sub(ageMs);
    const wrappedBirth = birthMs.sub(float(BIRTH_WRAP_MS).mul(birthMs.div(float(BIRTH_WRAP_MS)).floor()));
    return hash11(s.mul(1.7).add(wrappedBirth.mul(0.0037)).add(float(salt)));
  };

  // LIFE FADE (the lifespan rung): 0 at birth, 1 through the steady middle,
  // back to 0 at expiry — fadeIn ramps up over the first uFadeMs, fadeOut
  // ramps down over the last uFadeMs, and the smaller of the two wins at any
  // given age (only one of them is ever < 1 at once, since uFadeMs is capped
  // to half of uLifeMs above). Bundled into ONE vec2 varying alongside the
  // random per-life BASE opacity (x=envelope, y=base opacity) rather than
  // two separate varyings — `age`/`seed`/`instanceIndex` are storage-buffer/
  // vertex-stage-only reads on this renderer (the same reason candle/light
  // per-instance state is never read directly in a fragment Fn elsewhere in
  // this codebase) — `.toVarying()` computes this once in the vertex stage
  // and carries the interpolated result into `opacityNode` below.
  const vFade = Fn(() => {
    const ageMs = age.element(instanceIndex);
    const fadeIn = ageMs.div(uFadeMs).clamp(float(0), float(1));
    const fadeOut = uLifeMs.sub(ageMs).div(uFadeMs).clamp(float(0), float(1));
    const lifeFadeEnvelope = fadeIn.min(fadeOut);
    const s = seed.element(instanceIndex);
    const baseOpacity = mix(uOpacityMin, uOpacityMax, lifeRandomOf(s, ageMs, 211.0));
    return vec2(lifeFadeEnvelope, baseOpacity);
  })().toVarying('vFade');

  const material = new THREE.NodeMaterial();
  material.positionNode = Fn(() => {
    const corner = positionGeometry.xy; // -0.5..0.5 (a unit quad)
    const c = position.element(instanceIndex); // vec2 world centre
    const s = seed.element(instanceIndex);
    const ageMs = age.element(instanceIndex);
    // RANDOM SIZE (author request) — a different salt from opacity's above,
    // so the two vary independently, never moving together as one "bigger =
    // more opaque" knob.
    const sizePx = mix(uSizeMinPx, uSizeMaxPx, lifeRandomOf(s, ageMs, 401.0));
    // WORLD position: mesh is untransformed, so the camera's view·proj places it.
    return vec3(c.x.add(corner.x.mul(sizePx)), c.y.add(corner.y.mul(sizePx)), float(zDepth));
  })();
  material.colorNode = vec3(1.0, 0.96, 0.9); // warm dust white
  material.opacityNode = Fn(() => {
    const d = uv().sub(0.5).length(); // 0 centre → ~0.707 corner
    const soft = d.mul(2.0).oneMinus().clamp(0, 1); // 1 centre → 0 edge
    // soft² falloff × this mote's own random base opacity (vFade.y) × the
    // lifespan fade envelope (vFade.x) — random size/opacity per author
    // request, capped by opacityMax (0.8 default: "opacity 80% at max").
    return soft.mul(soft).mul(vFade.y).mul(vFade.x);
  })();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  // `side: DoubleSide` sidesteps quad winding under the flipped camera — the
  // SAME fix candle-flame-render.js already needed for its own world-space
  // billboard quad, under this same camera (updateCamera's `top = minY`
  // inversion flips winding for a plain-wound quad, so FrontSide culls it
  // entirely — silent, not an error). Live-confirmed as the fix: first draw
  // attempt (2026-07-21) had every particle invisible with no console error,
  // exactly this signature.
  material.side = THREE.DoubleSide;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // world-space bounds vary per frame; the gate is the GPU's job
  const scene = new THREE.Scene();
  scene.add(mesh);

  let seeded = false;
  // Redistribution-window bookkeeping (fix-17) — plain JS, no GPU cost. See
  // setWorldRect's own comment for what this answers.
  let lastRectArea = null;
  let redistributeFramesLeft = 0;
  const REDISTRIBUTE_FRAMES = 90; // ~1.5s at 60fps — fast, not instant/jarring
  const REDISTRIBUTE_RATE = 0.04; // per-frame chance while the window is open

  return {
    /** The dedicated scene the viewer renders (additively) into scene.lit. */
    scene,
    capacity,

    /** Seed the field once. Idempotent. Call after the world rect is set. */
    init(renderer) {
      if (seeded) return;
      renderer.compute(seedKernel);
      seeded = true;
      log.info(`seeded ${capacity} ${system.id} particles across the world rect`);
    },

    /**
     * Advance one frame. Synchronous compute (never computeAsync in-frame — that
     * awaits a readback and would stall the render loop).
     * @param {*} renderer
     * @param {{dtSec:number, tMs:number, worldRect?:object}} frame
     */
    step(renderer, { dtSec, tMs, worldRect: rect }) {
      if (rect) this.setWorldRect(rect);
      // clamp dt against the monster-delta lurch, same spirit as the frame clock
      uDtSec.value = Math.min(0.05, Math.max(0, dtSec || 0));
      uTimeMs.value = tMs || 0;
      // fix-17: elevated only during the short post-zoom window; 0 otherwise,
      // so ordinary steady viewing never force-respawns a single mote.
      uRespawnChance.value = redistributeFramesLeft > 0 ? REDISTRIBUTE_RATE : 0;
      if (redistributeFramesLeft > 0) redistributeFramesLeft--;
      if (!seeded) this.init(renderer);
      renderer.compute(updateKernel);
    },

    /**
     * Move the field's world rect (e.g. the camera panned/zoomed). ALSO
     * detects a genuine ZOOM (fix-17, author-reported: "when I zoom in it
     * shoves particles together, zoom back out and I'm looking at a screen-
     * shaped bucket of particles"). The exit-test (fix-6) only rescues a mote
     * that drifts OUTSIDE the current rect — but zooming OUT makes the rect
     * suddenly bigger, so every existing mote (clustered wherever the
     * smaller, zoomed-in rect used to be) is now comfortably INSIDE the new
     * rect and the exit-test never fires for any of them. Nothing tells them
     * to spread out and fill the newly-revealed area — hence the bucket.
     * FIX: when the rect's AREA changes by more than 40% either way (a real
     * zoom, not the sub-pixel wobble of an ordinary pan at constant zoom,
     * which the exit-test already handles correctly), open a short window
     * during which every particle gets an independent per-frame chance to
     * force-respawn — see `uRespawnChance`/fix-17 in the update kernel.
     * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect
     */
    setWorldRect(rect) {
      const area = Math.max(1, (rect.maxX - rect.minX) * (rect.maxY - rect.minY));
      if (lastRectArea != null) {
        const ratio = area / lastRectArea;
        if (ratio > 1.4 || ratio < 1 / 1.4) redistributeFramesLeft = REDISTRIBUTE_FRAMES;
      }
      lastRectArea = area;
      uRectMin.value.set(rect.minX, rect.minY);
      uRectSize.value.set(rect.maxX - rect.minX, rect.maxY - rect.minY);
    },

    /**
     * Adopt a NEWER wind handle after a real rebake. Call this every time the
     * viewer's `bakeWindField()` produces one — the SAME "this data just
     * changed" moment that already disposes/nulls the wind-reading MATERIALS so
     * they rebuild lazily on their next per-frame call. This engine has no
     * per-frame "does my material need rebuilding" check to hook that into (its
     * kernel is built once), so it needs an explicit push instead — this IS
     * that push, and the handle's `version` is what makes a redundant push
     * free.
     *
     * Cheap: cols/rows are stable across an ordinary rebake (only a scene/
     * grid-size change touches them), so this OVERWRITES the existing storage
     * buffer's content and never rebuilds the kernel. A genuine REGRID would
     * need a real rebuild (not implemented — logged loudly rather than
     * silently reading garbage, and note the kernel's own index arithmetic was
     * baked against the old dimensions too).
     * @param {object|null} nextHandle
     */
    updateWind(nextHandle) {
      if (!windOpennessBuffer || !nextHandle?.grid || !nextHandle?.cells) return;
      if (nextHandle.version === windHandleVersion) return; // nothing changed
      const { cols, rows } = nextHandle.grid;
      if (cols !== opnCols || rows !== opnRows) {
        log.error(
          `particle wind grid size changed (${opnCols}x${opnRows} -> ${cols}x${rows}) — ` +
            'a hot content-update cannot handle that; the storage buffer would need reallocating. ' +
            'Ignoring this rebake for particles (other wind-reading materials still update correctly).'
        );
        return;
      }
      packWindCells(windOpennessBuffer.value, nextHandle.cells, cols * rows);
      windHandleVersion = nextHandle.version;
    },

    /** For the debug panel: prove the engine is alive without a screenshot. */
    debugState() {
      return {
        system: system.id,
        capacity,
        seeded,
        // Was the openness grid actually WIRED at construction? A `false`
        // here is a smoking gun — the kernel was compiled without it,
        // permanently (a JS-build-time branch, not a runtime GPU one).
        hasOpennessGrid: !!windOpennessBuffer,
        opennessGridSize: windOpennessBuffer ? { cols: opnCols, rows: opnRows } : null,
        rect: { min: [uRectMin.value.x, uRectMin.value.y], size: [uRectSize.value.x, uRectSize.value.y] },
        uniforms: {
          dtSec: uDtSec.value,
          tMs: uTimeMs.value,
          sizeMinPx: uSizeMinPx.value,
          sizeMaxPx: uSizeMaxPx.value,
          opacityMin: uOpacityMin.value,
          opacityMax: uOpacityMax.value,
          windGain: uWindGain.value,
          // A plain JS number, not a uniform's `.value` — uMaxSpeedAtGalePxPerSec
          // is a construction-time CONSTANT (float(pxPerMeter * GALE_MPS)),
          // never a live-updatable uniform (this file's own comment at its
          // declaration explains why: pxPerMeter is a scene property that
          // cannot change mid-session).
          maxSpeedAtGalePxPerSec: pxPerMeter * GALE_MPS,
          pxPerMeter,
          outdoorSpeedBoost: uOutdoorSpeedBoost.value,
          indoorChaosBoost: uIndoorChaosBoost.value,
          outdoorGaleBoost: uOutdoorGaleBoost.value,
          respawnChance: uRespawnChance.value,
          lifeMs: uLifeMs.value,
          fadeMs: uFadeMs.value,
          accelToMaxSeconds: uAccelToMaxSeconds.value,
        },
        redistributeFramesLeft,
      };
    },

    /**
     * GROUND TRUTH for "are the motes actually obeying the per-cell wind field?"
     * Reads the REAL GPU velocity + position buffers back (async — never call
     * in-frame; getArrayBufferAsync stalls the pipe) for a strided sample of `n`
     * particles, and reports the circular SPREAD of their velocity directions.
     *
     * The decisive number is `velocityDirections.alignment`: ~1 means every mote
     * moves the SAME way (the per-cell field is NOT reaching the kernel — only
     * the spatially-uniform ambient is), a value well below 1 means the field
     * genuinely varies the motion per position. This is the instrument that ends
     * the guessing — it measures what the kernel COMPUTED, not what anyone
     * assumes (feedback_instruments_must_not_lie). It also auto-detects the
     * buffer's float-stride, so a vec2-vs-padded-vec4 storage layout can't make
     * it silently misread (reported as `floatsPerParticle`).
     *
     * @param {*} renderer
     * @param {number} [n]
     * @returns {Promise<object>}
     */
    async readbackVelocities(renderer, n = 32) {
      let posRaw;
      let velRaw;
      let cusRaw;
      try {
        posRaw = new Float32Array(await renderer.getArrayBufferAsync(position.value));
        velRaw = new Float32Array(await renderer.getArrayBufferAsync(velocity.value));
        cusRaw = new Float32Array(await renderer.getArrayBufferAsync(custom.value));
      } catch (err) {
        log.error('particle readback failed', err);
        return {
          ok: false,
          error: String(err?.message ?? err),
          hasOpennessGrid: !!windOpennessBuffer,
        };
      }
      // Auto-detect stride (2 = tight vec2, 4 = padded/vec4) so a layout surprise
      // reports itself instead of scrambling the sample.
      const posStride = Math.max(2, Math.round(posRaw.length / capacity));
      const velStride = Math.max(2, Math.round(velRaw.length / capacity));
      const cusStride = Math.max(4, Math.round(cusRaw.length / capacity)); // custom is vec4
      const step = Math.max(1, Math.floor(capacity / n));
      const samples = [];
      const angles = [];
      const mags = [];
      const coherentMags = [];
      const opennesses = [];
      // Samples this readback can PROVE are contradictory. Under the
      // coherent/chaotic split, a sealed (openness=0) mote moving fast is
      // no longer suspicious by itself — chaosBoost is SUPPOSED to keep
      // sheltered dust visibly moving. What's still a real bug: openness
      // reads 0 (coherentGate should be exactly 0, no compass-heading push
      // at all) yet `coherentGateApplied` (custom.w) itself reads
      // meaningfully above 0 — that means the gate math isn't firing
      // despite a correct openness reading. If this list comes back
      // non-empty, the bug is in the GATE MATH; if it comes back EMPTY while
      // speeds still look "fast" indoors, that's chaosBoost working as
      // designed, not a bug (see interpretation).
      const contradictions = [];
      for (let k = 0; k < n && k * step < capacity; k++) {
        const i = k * step;
        const px = posRaw[i * posStride];
        const py = posRaw[i * posStride + 1];
        const vx = velRaw[i * velStride];
        const vy = velRaw[i * velStride + 1];
        // xy of the custom buffer = the coherent push actually applied this
        // frame (ambientBias × coherentGate); z = openness (0/1) this
        // particle's cell read; w = coherentGate applied that frame (the
        // SAME value as z today — see the update kernel's own comment at
        // its custom.assign call site).
        const sxx = cusRaw[i * cusStride];
        const syy = cusRaw[i * cusStride + 1];
        const opn = cusRaw[i * cusStride + 2];
        const coherentGateApplied = cusRaw[i * cusStride + 3];
        const mag = Math.hypot(vx, vy);
        const coherentMag = Math.hypot(sxx, syy);
        const angleDeg = Math.round((Math.atan2(vy, vx) * 180) / Math.PI);
        samples.push({
          i,
          pos: [round2(px), round2(py)],
          vel: [round2(vx), round2(vy)],
          mag: round2(mag),
          angleDeg,
          openness: round2(opn),
          coherentGateApplied: round2(coherentGateApplied),
          coherentPush: [round2(sxx), round2(syy)],
          coherentMag: round2(coherentMag),
        });
        if (mag > 0.01) {
          angles.push(angleDeg);
          mags.push(mag);
        }
        coherentMags.push(coherentMag);
        opennesses.push(opn);
        if (opn < 0.5 && coherentGateApplied > 0.3) {
          contradictions.push({
            i,
            pos: [round2(px), round2(py)],
            openness: round2(opn),
            coherentGateApplied: round2(coherentGateApplied),
            mag: round2(mag),
          });
        }
      }
      const coherentMean = coherentMags.length ? coherentMags.reduce((a, b) => a + b, 0) / coherentMags.length : 0;
      const opnMean = opennesses.length ? opennesses.reduce((a, b) => a + b, 0) / opennesses.length : 0;
      return {
        ok: true,
        hasOpennessGrid: !!windOpennessBuffer,
        floatsPerParticle: { position: posStride, velocity: velStride, custom: cusStride },
        sampleCount: samples.length,
        movingCount: mags.length,
        velocityDirections: circularSpreadDeg(angles),
        magnitude: mags.length
          ? {
              min: round2(Math.min(...mags)),
              max: round2(Math.max(...mags)),
              mean: round2(mags.reduce((a, b) => a + b, 0) / mags.length),
            }
          : null,
        // The coherent push actually applied — position-VARYING now (it's
        // ambientBias × coherentGate, not a raw per-cell deviation), so
        // "present" here means "at least some sampled particles are
        // currently outdoors/open," not "the grid upload worked" (that's
        // hasOpennessGrid's job).
        coherentPush: {
          meanMag: round2(coherentMean),
          maxMag: round2(coherentMags.length ? Math.max(...coherentMags) : 0),
          present: coherentMean > 0.001,
        },
        // openness ground truth. sealedCount = how many sampled particles
        // read openness < 0.5 (sealed off) — if this is 0, NONE of the
        // sampled particles are actually in a sheltered spot right now (a
        // sampling/location question, not a gate-math bug). `contradictions`
        // names any sample that reads SEALED yet STILL has a non-trivial
        // `coherentGateApplied` — the SMOKING GUN for a real bug in the gate
        // math, as opposed to "these motes just aren't sheltered" or
        // "chaosBoost is doing its job."
        opennessStats: {
          mean: round2(opnMean),
          min: round2(opennesses.length ? Math.min(...opennesses) : 0),
          max: round2(opennesses.length ? Math.max(...opennesses) : 0),
          sealedCount: opennesses.filter((e) => e < 0.5).length,
        },
        contradictions,
        interpretation:
          'velocityDirections.alignment near 1 = motes move the SAME direction (prevailing wind ' +
          'dominates, expected OUTDOORS, a red flag INDOORS). hasOpennessGrid=false = the grid was ' +
          'never wired at construction. coherentPush.present=false WITH hasOpennessGrid=true AND some ' +
          'sampled particles reading openness=1 = the grid IS wired but every lookup read sealed — the ' +
          'upload or the cell-index math has a bug. opennessStats.sealedCount=0 means NONE of these 32 ' +
          'sampled particles are actually reading a sheltered position right now — high speeds or a ' +
          'coherent heading among them say nothing about indoor behavior, only about outdoor/boundary ' +
          'positions. A non-empty `contradictions` list is the real bug report: those specific samples ' +
          'read SEALED (coherentGate should read exactly 0, no compass-heading push at all) yet ' +
          '`coherentGateApplied` is still meaningfully above 0 — that points at the gate math itself, ' +
          'not the openness grid. High SPEED alone at low openness is no longer suspicious by itself ' +
          '(chaosBoost deliberately keeps sheltered dust visibly moving, just non-directional) — check ' +
          '`coherentGateApplied` and whether velocity direction tracks the ambient heading, not raw magnitude.',
        samples,
      };
    },

    /**
     * THE WIND+PARTICLE PROBE's own particle-side ground truth (2026-07-21):
     * "what did the GPU actually compute for the motes right HERE" — a
     * position-anchored cousin of {@link readbackVelocities}'s stride-based
     * sampling, born because that instrument had a real, named limitation:
     * it samples by ARRAY INDEX, with no idea what the author is currently
     * looking at on screen. This reads back the SAME full buffers (no new
     * GPU cost, no kernel/shader change at all — the selection is pure JS
     * over already-transferred data, `diag/wind-probe.js#findNearestParticles`)
     * and returns whichever real particles are actually closest to a clicked
     * world point, so a report can be anchored to the EXACT room in a
     * screenshot instead of a semi-random sample.
     *
     * @param {*} renderer
     * @param {number} worldX @param {number} worldY
     * @param {number} [n=12] - how many nearest particles to return.
     * @returns {Promise<object>}
     */
    async readbackNearestParticles(renderer, worldX, worldY, n = 12) {
      let posRaw;
      let velRaw;
      let cusRaw;
      try {
        posRaw = new Float32Array(await renderer.getArrayBufferAsync(position.value));
        velRaw = new Float32Array(await renderer.getArrayBufferAsync(velocity.value));
        cusRaw = new Float32Array(await renderer.getArrayBufferAsync(custom.value));
      } catch (err) {
        log.error('particle nearest-readback failed', err);
        return { ok: false, error: String(err?.message ?? err) };
      }
      const posStride = Math.max(2, Math.round(posRaw.length / capacity));
      const velStride = Math.max(2, Math.round(velRaw.length / capacity));
      const cusStride = Math.max(4, Math.round(cusRaw.length / capacity));
      // Decode EVERY particle (cheap — plain array reads, no GPU cost; the
      // readback itself already transferred the whole buffer) into the same
      // per-sample shape readbackVelocities' own `samples` uses, so a report
      // comparing the two instruments is comparing like for like.
      const decoded = [];
      for (let i = 0; i < capacity; i++) {
        const px = posRaw[i * posStride];
        const py = posRaw[i * posStride + 1];
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        decoded.push({
          i,
          pos: [px, py],
          vel: [velRaw[i * velStride], velRaw[i * velStride + 1]],
          coherentPush: [cusRaw[i * cusStride], cusRaw[i * cusStride + 1]],
          openness: round2(cusRaw[i * cusStride + 2]),
          coherentGateApplied: round2(cusRaw[i * cusStride + 3]),
        });
      }
      const nearest = findNearestParticles({ particles: decoded, queryX: worldX, queryY: worldY, maxResults: n }).map(
        (p) => ({
          i: p.i,
          pos: [round2(p.pos[0]), round2(p.pos[1])],
          vel: [round2(p.vel[0]), round2(p.vel[1])],
          mag: round2(Math.hypot(p.vel[0], p.vel[1])),
          angleDeg: Math.round((Math.atan2(p.vel[1], p.vel[0]) * 180) / Math.PI),
          openness: p.openness,
          coherentGateApplied: p.coherentGateApplied,
          coherentPush: [round2(p.coherentPush[0]), round2(p.coherentPush[1])],
          distancePx: p.distancePx,
        })
      );
      return {
        ok: true,
        query: { x: round2(worldX), y: round2(worldY) },
        capacity,
        summary: summarizeNearestParticles(nearest),
        nearest,
      };
    },
  };
}
