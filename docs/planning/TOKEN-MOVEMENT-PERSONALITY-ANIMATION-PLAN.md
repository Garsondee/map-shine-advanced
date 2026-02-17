# Token Movement Personality Animation Plan

## Status
- Phase: Planning Draft (Session 1)
- Priority: High (game feel and token readability)
- Scope: Movement personality design for walking-first token animation, plus flying, burrowing, teleporting, and chaotic motion styles

---

## 1) Goal
Define a movement personality framework that gives tokens distinctive, characterful motion without compromising gameplay clarity, path correctness, or Foundry-authoritative state.

This plan focuses on:
1. Walking as the primary movement language
2. Secondary traversal families (flying, burrowing, teleporting)
3. Chaotic/supernatural movement methods
4. 3D chip-like rotation language (pitch/roll/yaw) during movement
5. A style architecture that can be assigned by token, creature type, or context

---

## 2) Design Principles

1. **Readability first, personality second**
   - Players must always read destination, heading, and completion state instantly.
2. **Walking is the baseline**
   - Most tokens should feel alive through subtle gait identity before special effects.
3. **Personality through motion signatures**
   - Each movement style should have recognizable rhythm, arc, and settling behavior.
4. **3D chip illusion, not full ragdoll**
   - Rotate tokens as physical board pieces with controlled tilt and spin envelopes.
5. **Server-authoritative final positions**
   - Motion presentation should never break authoritative token state updates.
6. **Performance-safe by design**
   - Styles should degrade gracefully and avoid heavy per-frame allocations.

---

## 3) Movement Personality Stack

Personality should be layered rather than hardcoded into one animation:

1. **Traversal Family** (what kind of movement):
   - Walk, Fly, Burrow, Teleport, Chaos
2. **Style Archetype** (how it behaves):
   - e.g., Stalker Walk, Proud March, Panic Scuttle
3. **Micro-Modifiers** (small traits):
   - limp amount, bounce, swagger sway, jitter, overshoot
4. **Context Modifiers**:
   - combat urgency, terrain roughness, status effects, encumbrance

This allows broad style reuse with many distinct outcomes.

---

## 4) Walking-First Style Library (Primary Focus)

## 4.1 Core walking styles

1. **Steady March**
   - Even speed, low bob, slight forward tilt, minimal lateral sway.
   - Best default for disciplined humanoids.

2. **Heavy Stomp**
   - Lower cadence, stronger vertical bob, brief squash/settle at each node.
   - Works for armored units, constructs, large creatures.

3. **Sneak Glide**
   - Slow approach, reduced bob, cautious stop-start pacing near corners.
   - Slight backward recovery on stop.

4. **Swagger Stride**
   - Lateral sway with alternating roll, medium bob, confident settle.
   - Good for rogues, pirates, flamboyant NPCs.

5. **Skitter Walk**
   - Fast cadence, small rapid heading corrections, tiny bounce jitter.
   - For small creatures, vermin, nervous entities.

6. **Limping Advance**
   - Asymmetric step timing (long-short cadence), periodic hitch in motion.
   - Driven by a repeatable pattern, not random noise.

7. **Wobble Totter**
   - Slight over-correction in heading and roll; playful imbalance.
   - Useful for golems, toy-like entities, comedic units.

## 4.2 Unusual walking variants (personality injectors)

1. **Zigzag Tracker**
   - Preserves path endpoints but oscillates side-to-side around centerline.

2. **Predator Prowl**
   - Slow start, sudden acceleration in final third, aggressive forward lean.

3. **Reluctant Creep**
   - Tiny pauses at path nodes, hesitant tilt backward before each push forward.

4. **Clockwork Tick-Walk**
   - Quantized cadence: move-stop-move in metronomic pulses.

5. **Drunken Drift**
   - Controlled lateral drift with recovery, keeping collision-safe center path.

## 4.3 Walking motion channels

Every walking style should be built from shared channels:
1. Translation along path (required)
2. Heading alignment (yaw)
3. Vertical bob envelope
4. Roll sway envelope
5. Pitch lean (accel/decel dependent)
6. Node settle impulse at turns/stops

A style is defined by parameter curves per channel, not bespoke code.

---

## 5) 3D Chip Rotation Language (All Families)

Tokens should feel like physical chips on a board using constrained 3D rotation:

1. **Yaw (turning)**
   - Align to movement heading with configurable smoothing.
2. **Pitch (forward/back tilt)**
   - Lean forward on acceleration, backward on braking.
3. **Roll (banking)**
   - Bank into turns and side sway; reset smoothly on straights.
4. **Settle wobble**
   - Small damped oscillation after a stop, like a chip settling.
5. **Impact tilt pulse**
   - Optional quick tilt impulse when entering a new tile/node.

### Rotation safety constraints
- Clamp pitch/roll maxima (avoid visual nausea or unreadable token art).
- Preserve top-down identity (token artwork must remain legible).
- Respect reduced-motion mode by disabling non-essential roll/pitch effects.

---

## 6) Flying Movement Family

Flying should read as detached from ground while preserving destination clarity.

## 6.1 Flying archetypes

1. **Hover Glide**
   - Smooth path translation at fixed hover height with gentle bob wave.

2. **Banking Flyer**
   - Stronger roll into turns, nose-down pitch on acceleration.

3. **Soaring Arc**
   - Long easing curves with slight rise/fall over path length.

4. **Flutter Burst**
   - Pulse-driven speed surges and brief vertical hops.

## 6.2 Flying visual anchors
- Ground tether line (optional)
- Ground contact ring (optional)
- Shadow offset and softness scaling with height

These cues keep altitude readable in a top-down tactical view.

---

## 7) Burrowing Movement Family

Burrowing should communicate partial/hidden locomotion and terrain displacement.

## 7.1 Burrow archetypes

1. **Mole Surge**
   - Token dips under surface, ripple indicator travels ahead, token resurfaces at intervals.

2. **Sand Swim**
   - Continuous low-visibility glide with noisy wake and intermittent emergence.

3. **Ambush Tunnel**
   - Long hidden segment, abrupt pop-up near destination with dust burst settle.

## 7.2 Burrow representation strategy
- Use a proxy marker while submerged (ring, mound, tremor ripple).
- Token mesh can lower below board plane with reduced alpha or occlusion mask.
- Re-entry uses a strong settle animation to re-establish positional certainty.

---

## 8) Teleport Movement Family

Teleportation should look intentional, readable, and system-distinct from walking.

## 8.1 Teleport archetypes

1. **Blink Step**
   - Very short vanish/reappear with faint afterimage trail.

2. **Phase Slide**
   - Token partially dissolves and slides through a short ghost path before reforming.

3. **Sigil Gate**
   - Origin and destination circles appear; token compresses at origin and unfolds at destination.

4. **Snap Swap**
   - Hard discontinuity with one-frame orientation lock and settle wobble.

## 8.2 Teleport readability requirements
- Always show origin and destination relation (line, ghost, or synced pulse).
- Show a clear completion cue at destination.
- Ensure turn order/game logic remains tied to authoritative destination update.

---

## 9) Chaotic / Supernatural Movement Family

These styles add high personality and should be opt-in due visual intensity.

## 9.1 Chaotic archetypes

1. **Ricochet Pathing**
   - Token bounces between interim micro-points before landing on final path point.

2. **Glitch Drift**
   - Subtle frame-jump offsets with chromatic echo style (visual-only), then snap-correct.

3. **Spiral Lunge**
   - Token rotates around local axis while advancing in narrowing spiral.

4. **Orbit-Then-Drop**
   - Small circular orbit near destination, then direct settle onto target tile.

5. **Chaos Skip**
   - Alternates micro-teleports and short dashes along path segments.

## 9.2 Guardrails for chaotic styles
- Keep collision/path compliance exact.
- Cap displacement from true path centerline.
- Enforce max visual noise in multiplayer scenes.

---

## 10) Style Assignment Model

## 10.1 Assignment hierarchy
1. Explicit per-token override (highest)
2. Actor/type preset (humanoid, beast, construct, undead, elemental)
3. Scene default profile
4. System fallback profile

## 10.2 Context-driven automatic overrides
- **Combat sprint mode**: increase urgency curves
- **Low HP/injured**: swap to limp variant
- **Stealth mode**: swap to sneak variant
- **Status effects**: fear jitter, slow drag, haste snap

---

## 11) Technical Architecture Plan

## 11.1 Profile contract
```js
{
  id,
  family,              // walk | fly | burrow | teleport | chaos
  label,
  channels,            // translation, yaw, pitch, roll, bob, settle
  buildTrack(intent, context),
  samplePose(track, tNorm),
  constraints,         // max pitch/roll, max lateral offset, etc.
  supportsReducedMotion
}
```

## 11.2 Motion pipeline
1. Path planner produces path nodes (authoritative-safe)
2. Style builds motion track from path + context
3. Runtime sampler outputs pose per frame
4. Pose applies to token mesh/group (position + 3D rotation + optional scale)
5. Completion snaps exactly to authoritative destination transform

## 11.3 Separation of concerns
- Pathfinding determines **where** token can go
- Style profile determines **how** token appears to get there
- Foundry update determines **truth** of final location

---

## 12) UX and Settings Plan

Expose controls at three levels:

1. **Global defaults**
   - default family/style, personality intensity, reduced motion, chaos allowance
2. **Scene profile**
   - tone presets: grounded, heroic, spooky, chaotic
3. **Per-token overrides**
   - movement family + archetype
   - 3D rotation intensity slider
   - settle wobble amount

Suggested presets:
- **Classic Tactical**: minimal motion, readability-first
- **Characterful**: moderate personality, subtle 3D chip tilt
- **Cinematic**: strong curves/rotations, dramatic non-walk modes

---

## 13) Phased Delivery

## Phase MP-1: Walking Personality Foundation (Primary)
- Build walking channel system and 4-6 archetypes
- Add 3D yaw/pitch/roll core with safety clamps
- Add settle wobble and heading smoothing

## Phase MP-2: Style Assignment + Presets
- Add hierarchy-based style resolution
- Add scene/global settings and starter presets

## Phase MP-3: Flying and Burrowing Families
- Implement hover/glide + burrow proxy markers
- Add height/readability anchors (ring/tether/shadow behavior)

## Phase MP-4: Teleport Family
- Implement blink, phase slide, sigil gate variants
- Add origin/destination readability cues and completion pulses

## Phase MP-5: Chaotic Family
- Add opt-in chaotic profiles with strict guardrails
- Add intensity caps and multiplayer-safe limits

## Phase MP-6: Hardening and QA
- Reduced motion coverage
- multiplayer readability tests
- performance profiling on large token counts
- regression checks for movement correctness

---

## 14) Acceptance Criteria

1. Walking styles clearly feel different without reducing tactical clarity.
2. Tokens can rotate in 3D (yaw/pitch/roll) during motion with stable constraints.
3. At least one style each exists for flying, burrowing, teleporting, and chaotic movement.
4. Final positions remain authoritative and exact.
5. Reduced-motion mode produces readable low-intensity alternatives.
6. Performance remains stable with many moving tokens.

---

## 15) Risks and Mitigations

1. **Risk: Over-animation hurts readability**
   - Mitigation: strict defaults, style intensity caps, reduced-motion toggle.
2. **Risk: Visual personality conflicts with path correctness**
   - Mitigation: separate presentation offsets from collision path and clamp deviations.
3. **Risk: Multiplayer visual noise**
   - Mitigation: local quality scaling and chaos family opt-in.
4. **Risk: Excessive per-frame compute**
   - Mitigation: shared channel samplers, pooled objects, no per-frame allocations in hot paths.

---

## 16) Next Planning Session Targets

1. Pick the first 6 walking archetypes for implementation priority.
2. Define exact parameter ranges for yaw/pitch/roll and settle envelopes.
3. Finalize style assignment schema (scene vs token overrides).
4. Choose default behavior for teleport readability cues.
5. Define reduced-motion substitutions for every family.
