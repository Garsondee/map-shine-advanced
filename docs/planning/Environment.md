# ENVIRONMENT — why time, sun and weather fought, and the design that makes them compose

**Status:** RESEARCH + DESIGN SEED, 2026-07-16. Author: _"time of day, sun angle (and other things about the sun) and the weather were a constant battle when they should have wonderfully complimented each other."_
**Verdict up front:** the battle is fully explained, it was structural, and none of it was tuning error. Five mechanisms, each verified in source, each with a date-stamped scar.
**Companions:** `Effects-API.md` (the params blackboard — three of its six illegal writers are these systems), `Particles.md` (weather's consumers), `Engine-Postmortem.md` §1 (two-sources-of-truth, the family disease).

---

## 0. The anatomy of the battle — five mechanisms, all verified

### 0.1 🔴 THE ORIGINAL SIN: the clock lives INSIDE the weather system

`WeatherController.js:184` — `this.timeOfDay = 12.0`. **Time of day is a field of the weather controller.** Meanwhile `core/time.js` declares itself _"the single source of truth for time"_ (for animation time), Foundry has its own game time, and `foundry-time-phases.js` derives a sunlight factor from a third representation. **Twenty files touch a `timeOfDay`.**

Time and weather could never "wonderfully compliment each other" because they were never two peers composing — **one owned the other.** Every downstream mess in this document is a consequence: nobody wants to depend on the weather controller just to know what time it is, so everybody derived, cached, or duplicated their own.

And the hand-maintained coherence contract this forced, in V2's own words (`msa-v2-darkness.js`): _"WeatherController static fast-path skips `_updateEnvironmentOutputs()` after `_staticSnapped`; **any external change to `timeOfDay` must clear that flag**."_ Weather caches sky outputs; time changes must remember to poke weather's cache. Miss the poke → the documented "stale sky/fog" bug. That is a fight scheduled by the architecture.

### 0.2 🔴 EIGHT SUNS

Sun-from-time is computed in **at least eight places**: the shadow system's own `SunDirection.js` + `ShadowDriverState.js`, `core/time.js`, `ThreeLightSource.js`, and inline math in Specular, Lightning and others. **Fifteen files hold sun state; ten are effects** (fed via the bespoke `setSunAngles` push-door, ×5).

Several suns, derived independently, means shadows can point one way while specular glints answer to a different sky — _by construction_, not by bug. This is design-question #9 (`feedback_probed_constants_vs_derived`) in its milder form: not probed, but derived N times, which is N−1 more chances to disagree than necessary.

### 0.3 🔴 FOUNDRY'S SCENE DOCUMENT USED AS A SHARED VARIABLE — with a feedback loop

The flow: MSA computes darkness from its time+weather → **pushes it into Foundry** (`canvas.environment` via `mapShinePushSceneDarknessLevel`) → **28 files, including 8 effects, read it back out of Foundry.** MSA subsystems are communicating with each other _through the game document_ — a bus that Foundry itself, the GM's slider, and other modules also write.

The scars are date-stamped in `msa-v2-darkness.js`'s header like tombstones:

- _"Grey canvas (2026-03)"_ — **three** writers (time slider, `updateScene` resync, weather snapshot) stacking `scene.update({darknessLevel})` destabilized WebGL.
- _"V14 getter trap (2026-05)"_ — an API change made direct assignment **silently fail**, so the scene _snapped_ from night to day when a transition ended. (Silent failure, again.)
- _"Darkness-gated lights (2026-05)"_ — bypassing `scene.update` meant perception flags never fired, so lights with darkness activation ranges stopped toggling. Belt-and-suspenders added.

Two months of combat over **one float**. The module ends with the rule _"all darkness writes MUST go through this function"_ — a comment-MUST, the genre that is now 0-for-5 in this codebase (EffectComposer, the adapter, resolve-effect-enabled, time.js, this).

### 0.4 🔴 SEVEN HOMES PER WEATHER VALUE

`weather-param-bridge.js`'s own docstring lays out the "authority model": a manual weather value lives in `WeatherController.targetState`, `currentState`, the main Tweakpane folder display, `directedCustomPreset`, the top-level panel wind fields, the control-panel DOM, and the scene-flag `weather-snapshot` — **seven homes**, kept coherent by hand-written one-way sync paths with ordering rules ("hydrate from WC _after_ param callbacks"; "apply into WC _first_, then hydrate the UI"). It is the token-movement echo-defence disease (33 suppress-flags) in the params domain: N copies of one fact, N−1 sync paths, each a chance to fight.

### 0.5 🟠 THE COLLISION IS IN OUTPUT SPACE, NOT KEY SPACE — hypothesis corrected

My going-in hypothesis — same param keys, last-writer-wins — was **wrong at the key level** and worth recording as wrong: each system writes disjoint keys (wind → wind params, context grade → context params, weather → weather params). The real fight is one level up: **final visual quantities are products of knobs owned by different systems with no defined composition order.** Scene brightness = ToD grade × `contextBrightness` × weather darkening × Foundry `darknessLevel` — four owners, one perceptual result.

In the author's own professional terms: **four colorists grading the same shot on separate unlabeled adjustment layers, blend modes undefined, each re-tweaking to undo what the others did.** That is why it _felt_ like a constant battle — every system was hand-tuned to compensate for the others' output, so touching any one re-broke the sum. The ToD anchor timeline (8 keyframes, `tod0..tod7`) keyed per-effect looks, and weather had no principled way to modulate them — overcast noon can't read as "flatter noon" if noon is a hardcoded per-effect anchor.

## 1. What was RIGHT (harvest list)

- **"Cinematic Plausibility over Physical Simulation"** (WeatherController's own philosophy line) — correct for a VTT, keep it as doctrine.
- **The 8-anchor ToD timeline** (`tod0..tod7`, 3-hour steps, noon-at-top orbit UI) — a good authoring model; the _keyframe idea_ survives, its per-effect scattering does not.
- **The transition machinery's intent** (weather states with eased transitions between presets) and the wind field as a shared spatial input.
- The v14 darkness lessons themselves (`initialize()` not assignment; perception flags) — hard-won Foundry knowledge, harvest into the adapter.

## 2. THE KEYHOLE DESIGN — one sky, derived, composing like a grade stack

### 2.1 One environment snapshot, one owner, read-only

A single per-frame value — call it **`env`** — computed by ONE owner from declared inputs, then handed to consumers as a frame input (the `FrameState` instinct, which was right, applied to the sky):

```js
env = {
  time: { gameTime, todHour }, // time is NOT a field of weather
  sun: { azimuth, elevation, color, intensity }, // computed ONCE, Node-tested (derived, never probed)
  weather: { preset, precip, cloudCover, wetness, transition }, // a FUNCTION of time + weather state
  wind: { direction, speed, gustiness },
  darkness, // one value, one derivation
};
```

- **Time is upstream of weather**, never inside it. Weather is `f(time, weatherState)`; sun is `f(time, scene)`. The dependency arrows all point one way, so there is nothing to cache-poke and no flag to forget.
- **Effects read `env` via a declared read** (`res:environment`) — never Foundry globals, never each other, never a bridge. The bespoke `setSunAngles`/`setOutdoorsMask` push-doors cease to exist.
- **Sun math is one pure function with Node tests** asserting dawn/noon/dusk positions. Eight suns become one sun with a test suite.

### 2.2 Darkness: pick ONE direction of authority — never both

Either Foundry's `darknessLevel` is an **input** MSA reads (GM/core owns night), or MSA **owns** it and writes through exactly one function while treating its own value as authoritative (never reading it back). **Reading back what you wrote through a document other parties also write is the feedback bus that cost two months.** Decide per §4.3's authority table and enforce with a tripwire (`darknessLevel` appears in exactly one src file).

### 2.3 Grading composes in ONE stack with a DEFINED order

The author's domain, stated in the author's terms: a **grade stack**, like a node chain in Resolve — not four unlabeled adjustment layers.

```
base look (scene) → ToD grade (from the 8-anchor timeline) → weather grade
                  → context gate (indoor/outdoor, from scene.attr) → manual trim
```

Each stage is a declared transform with a defined blend; the ORDER is fixed and documented; any system that wants to affect the final image contributes a stage, never a hidden multiplier somewhere else. "Overcast noon" works because weather grades _the output of_ the ToD stage — flatter, cooler, dimmer — rather than fighting a hardcoded noon anchor inside each effect. One stack also means tier-ladder gating applies cleanly (`Effects.md`): the whole environment look is C1–C3 (maths + graph reads), cheap at every tier.

### 2.4 Presets and the seven homes

Weather state gets ONE home (the environment owner's state), UI binds to it through the params service (the 938-key fix, same design note), and scene persistence is a snapshot OF that one home. Mirrors die; the bridge files die with them.

## 3. Tripwires this audit adds (per covenant rule 4 — when built, not before)

- `timeOfDay` defined in exactly one module; `performance.now()/Date.now()` banned outside the frame clock (V2's time.js MUST, made mechanical).
- Sun terms (`azimuth/elevation/sunDirection`) computed in exactly one module.
- `darknessLevel` referenced in exactly one src file (whichever §2.2 direction is chosen).

---

_One clock, one sun, one darkness, one grade stack with a defined order. Time upstream of weather, weather upstream of look — arrows pointing one way is what "wonderfully compliment each other" is made of._
