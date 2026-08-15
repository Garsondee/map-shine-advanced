# LIGHT & SHADOW — why they fought, and the model where they cannot

**Status:** RESEARCH + DESIGN SEED, 2026-07-16. Author's brief, with their five-step pile-up quoted in §1: _"Light and Shadow. These two facets had their own horrible terrible battle in V2... Sky reach NEVER WORKED even though I thought it was simple. Overhead shadow was meant to work but was always a nightmare. \_Shadow as a manually painted texture was the best solution... Do you see the horrible pile up mess? Full research audit. Never again."_
**Companions:** `Environment.md` (the sun this consumes), `Effects-API.md` (the contract), `Engine-Postmortem.md`, Keyhole §4.4 (the unified shadow pass this seeds).

---

## 0. The answer first, because it is one sentence

> **V2 modeled shadow as a THING — dark paint composited onto the scene. Shadow is not a thing. Shadow is the ABSENCE OF A SPECIFIC LIGHT.**

Once shadow is paint, the author's five steps become rock-paper-scissors with no winner: shadow must darken sun (2), light must punch through shadow (3), shadow must re-darken over light (4)... forever — because _"this shadow applies to the sun but not to the torch"_ is **inexpressible** in stacked darkening layers. Every horror below is a compensator for that one wrong noun.

In the author's own professional language: **V2 had no light-linking.** In Maya you can link a shadow to the light that casts it; a flag on set cuts ONE lamp, not the scene's exposure. V2's shadows were flags that cut the exposure. The fix is not better flags — it is light-linking, which the author already knows how to think in.

## 1. The pile-up, restated as what each step ACTUALLY is

| Author's step                                               | What it is in the correct model                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1. "The sun lights the white of `_Outdoors` during the day" | the sun is a light; `_Outdoors` is part of its **visibility term**                                                                |
| 2. "Building shadows must darken that"                      | building shadow is ALSO part of the **sun's visibility term** — it modulates the sun, and ONLY the sun                            |
| 3. "A token torch would naturally override that shadow"     | nothing to override! The torch is a separate light with its OWN visibility; the sun's shadow never touched it. Its light **adds** |
| 4. "A shadow tile over the torch would darken it further"   | the tile joins the **torch's** visibility term — a per-light occluder, affecting that torch alone                                 |
| 5. "Lightning and others tinkered with lighting"            | lightning is just another light (a directional flash) reusing the same caster geometry — free, not special                        |

`illum(pixel) = skyAmbient × skyVisibility(pixel) + Σ over lights L of L(pixel) × visibility_L(pixel)`

Multiply per light, then sum. **No step fights any other step** — light accumulates, shadow gates its own light, and the pile-up is structurally impossible. This is also Foundry v14's own additive illumination model (the harvested `ForwardLightingPass` is already per-light additive with MAX-blend illum), extended with a visibility term per light.

## 2. The evidence — every compensator V2 built instead (all verified in source)

The family: **27,684 lines** across the light/shadow effects + a 14-file `shadow-system/` directory, holding **43 render targets** in the effects alone (Lighting 11, OverheadStamp 13, Painted 8, Building 7...).

1. **ONE combined shadow for ALL lights** — SkyReach's own docstring: _"ShadowManagerV2 folds it into `tCombinedShadow` next to the building/painted/overhead/cloud factors."_ A single factor texture that cannot know which light it should apply to. **This is the wrong noun, in code.**
2. **`DynamicLightShadowLift.js` — an entire module for un-darkening shadows near lights.** Shadow shaders take `tDynamicLight` and `tWindowLight` as INPUTS and weaken their own darkening where lights glow, by `uDynamicLightShadowOverrideStrength = 0.7` — **one global hand-tuned scalar**. A candle and a floodlight punch through a building shadow by the same 70%. It could only ever look right in the cases it was tuned on. Ten files carry lift machinery. _The lift is the exact cost of the wrong noun: because shadow darkened everything, an inverse system had to exist to protect lights from it._
3. **Per-source opacity knobs at the combine** — `uBuildingOpacity`, `uOverheadOpacity`, `uCloudOpacity`, `uCloudWeight`: each shadow producer's contribution hand-weighted into the shared factor. More output-space collision (`Environment.md` §0.5): five producers × opacity knobs × the lift × time-of-day strength — tuned against each other, so touching one re-broke the sum. **The same disease as the grade stack, in the shadow domain.**
4. **OverheadStamp (13 RTs), the "nightmare", confesses in its header:** _"capture passes (roof/fluid/tile/upper-floor-alpha composite), **temporary override restoration**..."_ — it mutates scene state, renders captures, and must perfectly restore, with four hash-keyed cache families (`hashCamera`, `hashCasterLive`, `hashRoofMaskCapture`, `hashTileProjectionCapture`) invalidated by hand. It also once _duplicated_ building/skyreach terms and had to be de-duplicated later (the header says so). Save-mutate-render-restore is the state-leak generator (`Engine-Postmortem.md` §3) — of COURSE it was a nightmare.
5. **Comment-MUST #7 and #8** — both SkyReach and OverheadStamp carry HEALTH-WIRING BADGEs demanding hand-maintained sync with the HealthEvaluator. The genre remains 0-for-everything.

## 3. Why each named system failed — specifically

- **Sky Reach "never worked, even though it seemed simple" — because it WAS simple; the pipeline it fed wasn't.** Its output (a clean R-channel factor, correct contract) had to traverse: the ShadowManager combine → its per-source opacity → _"the existing roof/top-floor suppression gates"_ (other systems' logic gating its output) → the dynamic-light lift → a canvas-padding UV remap its own header warns about (_"do not clip with sceneRect offsets here — that mixes spaces"_). **Five hand-tuned stages owned by three other systems sat between its math and the screen.** When it looked wrong, no instrument could show which stage ate it (2,670 silent catches; `feedback_instruments_must_not_lie`). A simple effect in an unaccountable pipeline is not a simple effect.
- **Overhead shadow "always a nightmare"** — §2.4: temporary-override capture architecture + hand cache invalidation + cross-coupling into LightingEffect's ceiling transmittance. Its _job_ was reasonable; its _architecture_ was save-mutate-restore with four caches.
- **Painted `_Shadow` "was the best solution" — because it accidentally implements the CORRECT model.** An artist looking at the map and painting where sunlight doesn't reach is _hand-authoring the sun's visibility term_ — a baked light-linking map. It bypassed the combine, the gates and the lift, and it looked right because it **is** the right noun. The author out-designed their own pipeline with a paintbrush.

## 4. THE KEYHOLE DESIGN

### 4.1 The model

- **Every light carries its own visibility term.** `illum = skyAmbient × skyVis + Σ L_i × vis_i`. The sun is a light. Lightning is a light (same caster geometry, different direction/time — free). Window light is a light. A torch is a light.
- **The sun's visibility term is a composition of producers that all mean the same thing** — and are therefore reconcilable by `min()` with no opacity knobs: authored `_Shadow` (the artist's word — wins where painted), computed building shadow from `_Outdoors`, computed sky-reach from upper-floor alpha. One semantic, one channel, min-combined. **Sky-reach finally works because it lands in a term with one meaning, not a gauntlet.** ⚠️ Cloud does **not** join this min-combine (corrected 2026-08-01, after this line was written): it drifts continuously while this field only rebakes a few times a minute, so it combines separately at the read site instead, `effects/shadow-access.js`'s `shadowAtmosphere()`. Full ruling: `Clouds.md` §4.1.
- **Dynamic lights' visibility**: Foundry's wall-clipped LOS polygons (already authoritative, §4.3) are the base term — that alone covers the author's step 3 with zero new machinery. Overhead-tile occlusion of point lights (step 4 — "never was a problem but always could have been") becomes a **tier rung**, not a default: per-light tile occlusion at higher tiers only, on machines with budget. The ladder makes the maybe-someday case affordable to have and cheap to not-have.
- **`env.sun` (Environment.md) supplies the one sun** — direction, elevation, colour. The eight suns die there; shadows and specular finally agree on where the sky is.
- **No lift. No combine. No per-source opacity.** These words become tripwires (§4.3). If a shadow needs to be weaker near a torch, that is the model working — the torch's own light adds — not a compensator.

### 4.2 What survives from V2 (harvest with respect)

- **The painted `_Shadow` workflow, promoted to first-class**: it is now _the authored sun-visibility layer_, the highest-authority producer in the sun's term. The author's favourite tool stops being a workaround and becomes the canon.
- `SeparableShadowBlur` (the soft look), the ceiling-transmittance concept (roofs dim interiors — it becomes part of the sun/sky visibility for indoor pixels), the caster-geometry ideas in the producers, and the sun-direction math (unified into `env.sun`).

### 4.3 Tripwires queued (covenant rule 4 — add when the lighting pass lands)

- **Shadow may only modulate a light's contribution.** No shadow texture is ever multiplied onto composed scene colour. (Greppable: no `tCombinedShadow`-shaped uniform; no multiply-darken in post.)
- **The words `shadowLift` / `ShadowOverride` / a shadow shader sampling a light buffer = build failure.** The lift is the fossil of the wrong noun.
- One sun: sun direction computed in exactly one module (shared with Environment.md's tripwire).

### 4.4 Cost note (Effects.md terms)

Sun visibility is one VT channel (authored) + cheap composited producers (C3/C4); per-light dynamic shadows beyond Foundry's walls are C6+ tier rungs. Tier 0 of the entire shadow system = _authored `_Shadow` alone modulating the sun_ — which is exactly what the author shipped V2 with, by hand, and it looked right. **Tier 0 is literally the author's proven fallback.**

---

## 5. BUILD STATUS + THE UI-SHADOW PRODUCER (2026-07-20)

### 5.1 The finding, stated plainly

There is a **fully-featured LIGHT system** and **no SHADOW system**. `light.accumulate` is `live` (ambient/exterior, point-light illumination, coloration, global illumination, region-driven darkness — a real Foundry-parity light rig). `light.visibility` — the shadow half — is a `seam`: `buildLightVisibilityPass` throws `NotBuiltError`. So "make UI cast a shadow on the world" cannot be built as a feature yet; it needs this pass. That is the correct order, not a detour: **a UI element casting a shadow is an occluder in a light's visibility term** — a _producer into `light.visibility`_ — and the buffer it writes into does not exist.

### 5.2 What landed this session (the pure core)

Following the `frame.snapshot` precedent (pure core built + Node-tested, GPU wiring deferred), `effects/lighting/light-visibility.js` now holds the CPU-pure, tested heart:

- **The model** — `combineVisibility` (min-combine, absence = fully lit), `authoredShadowVisibility` (the `_Shadow` catalog semantic), and `composeSunTermWithMaxLight`, which encodes the whole doctrine as a scalar: `illum = max(ambient × sunVisibility, maxLight)`. Its test asserts the invariant directly — **a torch ≥ ambient fully lights a painted-shadow pixel, and the result is independent of how dark the shadow was.** No lift, proven executable.
- **The offset-projection geometry** — `projectShadowOffset` / `shadowPenumbraPx` / `projectOccluderShadow`: a screen-space occluder rect + a light direction → an offset, feathered shadow stamp. This IS the UI-shadow feature's math, and its test pins the screen-space convention in every quadrant (the Y-flip class).

The `light.visibility` door stays a seam and now reads as an honest progress marker (points at the built core; names what remains). **The GPU producer + frame-loop multiply need LIVE pixel-probe verification and are the next, author-present increment** — a world→screen mask sample is not a Node-assertable fact.

### 5.3 Tier-0 wiring plan (the next increment)

1. **`res:vis` graduates to `buf:scene.vis`** — a per-pixel visibility term is an AOV, so it belongs in the `buf:` namespace (update `graph/passes.js`: `light.visibility` `creates: ['buf:scene.vis']`).
2. **Producer** — a pass that draws the sun's visibility (Tier 0 = the authored `_Shadow` mask, `min`-combined) into `buf:scene.vis`. White/absent = 1 (lit).
3. **Multiply** — in `runLightAccumulatePass` (vt-pan-viewer.js), the `illumQuad` ambient fill becomes `ambient × visibility` (sample `buf:scene.vis`), written **before** `regionScene`/`lightScene`. Point lights then MAX on top exactly as today, so a torch punches through the shadow for free (§5.2's invariant).
4. **Default is a proven no-op** — a scene with no `_Shadow` painted reads visibility 1 everywhere → pixel-identical to today. Same "noon no-op" parity bar `environmental-light.js` already meets; it means Tier 0 cannot regress an existing scene.
5. **Graph honesty** — flip `light.visibility` `seam`→`live` (delete the throwing door, move to `PASS_IMPLS`), and add `buf:scene.vis` to `light.accumulate`'s `reads` **only once the producer exists** (declaring an unproduced read while `live` is a `pass-health` STARVED error).

### 5.4 The UI-shadow producer (the wishlist feature, once §5.3 lands)

The open-window shadow is **another producer into the same `buf:scene.vis`**, driven by a virtual _workspace light_:

- **Read (never touch) the windows.** Open Foundry `Application`/`ApplicationV2` windows are DOM elements; their `getBoundingClientRect()` gives the occluder rects. This is read-only observation — MSA's canvas is `pointer-events:none` and never intercepts their input, so the input-model lock ([[keyhole-input-model-decision]]) and the interface seam ([[keyhole-interface-seam]]) hold. The chrome stays PIXI's; MSA only reads geometry.
- **Project.** Each rect → `projectOccluderShadow({ rect, ...DEFAULT_WORKSPACE_LIGHT })` → a feathered dark rounded-rect stamped into the vis buffer, `min`-combined with the authored/building/sky-reach producers.
- **Why a fixed workspace light, not `env.sun`.** UI chrome is not a world object. A fixed decorative key (`DEFAULT_WORKSPACE_LIGHT`, upper-left, ~55°) keeps window shadows consistent across time-of-day; tying them to `env.sun` would make a character sheet's shadow vanish at noon. `env.sun`-linked stays available as an option (the projection takes the light as parameters).
- **Doctrine safety = the wall stays green.** It modulates a _light's visibility_, never composed scene colour, so it does not resemble `tCombinedShadow` and cannot trip `shadow/no-lift-no-combine`. Its proof case is a window dragged over a torch-lit floor: the torch MAXes back, so the shadow correctly fades where the floor is already bright — free, and _only_ because it is a visibility term rather than a paint-over.
- **Depth / occlusion / tier.** Screen-space, drawn as the topmost visibility producer (it should read as floating above everything); no world-depth or floor/elevation gating (chrome, not geometry); stacked/overlapping windows each contribute and `min` resolves overlap. Cost is a handful of soft rects (C2-ish); when built, default-on with a toggle ([[feedback_default_on_new_features]]).

### 5.5 §4.3 tripwires — still queued

The greppable buffer tripwires ("no `tCombinedShadow`-shaped uniform; no multiply-darken in post") land **with the GPU pass**, per covenant rule 4 (add when the pass lands). The pure core adds no new buffers, so nothing to guard yet — but §5.4's "producer into visibility, never a post-darken" is exactly the rule they will enforce.

### 5.6 SHIPPED (2026-07-20): the UI-shadow, Tier 0, folded into `light.accumulate`

The wishlist feature is **live and default-on**. Implementation note, because it diverged from §5.3's buffer plan for a good reason discovered while building:

- **It did NOT flip `light.visibility` to `live`.** The UI-shadow is a _screen-space_ occluder that needs no world-space mask sampling, so it ships as a sub-render **inside `light.accumulate`, sibling to region-darkness**: a fullscreen MULTIPLY quad darkens `buf:scene.illum` where windows float (`vt-pan-viewer.js#runLightAccumulatePass`). It draws **AFTER the point lights** (a v2 correction — see below): still the illum/light buffer, never composed scene colour → the wall stays green; and no lift → a brighter light reads brighter through the shadow. A separate `buf:scene.vis` pass (§5.3) earns its keep only when the **world-space** sun producers (authored `_Shadow`, building, sky-reach) land — those genuinely need a world-space render. `light.visibility` stays a seam until then.
- **v2 (same day, author feedback): the multiply moved to AFTER the lights.** Drawing it before the lights left each point light MAX-blending against a _flat_ dark shadow floor, and `max(flatFloor, lightDome)` creases where they cross — a hard-edged "spherical bite" out of the shadow. Multiplying the _finished_ illum (ambient + region + lights) by the smooth visibility scales the light dome itself, so a light inside a window's shadow keeps its own soft attenuation (just dimmer), no crease. Non-lit shadow is bit-identical either way (`ambient × vis`); only the lit overlap changes crease→smooth.
- **v3 (same day, author feedback): `flipY` defaulted the WRONG WAY.** Reported live: dragging a window UP moved its shadow DOWN — the inverted-drag signature of a bad Y-flip (memory: feedback_y_flip_recurring_risk), not a mere offset bug. Root cause: `vt-pan-viewer.js`'s own occlusion-mask comment already proves `screenUV.y=0` is top on this backend ("matches the v=0-is-top convention already proven by the orientation self-test") — the SAME convention `mapWindowRectToStamp`'s DOM rects use — so the shader's default `flipY:true` was inverting an already-correct mapping. Fixed by defaulting `flipY:false` (both `_uiShadowState` in vt-pan-viewer.js and the shader's own initial uniform in light-visibility.js); the knob stays as an escape hatch, not deleted, in case a future backend ever disagrees with itself again.
- **v4 (same day, author-requested): the shadow offset is now 5x by default.** `projectShadowOffset` gained a cosmetic `offsetScale` param (default 1, ≤0/non-finite falls back to 1) applied to the raw `heightPx/tan(elevation)` length, clamped by `maxOffsetPx` AFTER scaling — deliberately decoupled from `heightPx`, which alone still drives the penumbra (`shadowPenumbraPx` never reads `offsetScale`), so throwing the shadow further does not also blur it out further. `DEFAULT_WORKSPACE_LIGHT.offsetScale = 5` is the new live default (threaded through `projectOccluderShadow` → `mapWindowRectToStamp` → `_uiShadowState.offsetScale` → `MapShine.setUiShadow({ offsetScale })`), locked in by a Node test asserting the live default is genuinely 5x, not merely an available knob.
- **v5 (same day, author-measured PERFORMANCE FIX, attempt 1 — throttle the DOM read): 120fps → 78fps at a per-frame scan.** Diagnosed the DOM read as the cost — `canvas.getBoundingClientRect()` + `document.querySelectorAll('.application, .app.window-app')` + one `getBoundingClientRect()` per open window, all main-thread, every frame; `getBoundingClientRect()` forces a synchronous layout reflow, and a live Foundry session keeps layout dirty (chat, combat tracker, animations) enough for that flush to be real repeated work. Fixed with a frame-count throttle (`_uiShadowState.scanEveryNFrames`, default 6; deliberately NOT time-based — `time/one-clock` reserves `performance.now()`/`Date.now()` to `core/frame-clock.js` + `diag/`, and `vt-pan-viewer.js` is already at its grandfathered ratchet limit for that wall). **Author re-measured: FPS barely recovered (still ~75, not the 6x-fewer-reflows result the diagnosis predicted) — proving the DOM read was NOT the dominant cost.** Kept as a real secondary optimization (the reflow is still non-zero work), but the primary fix is v6 below.
- **v6 (same day, author-measured PERFORMANCE FIX, attempt 2 — the actual root cause: the EXTRA RENDER PASS itself).** The v5 quad's `uiShadowQuad.render(renderer)` call ran every frame REGARDLESS of the DOM-read throttle (only the DOM scan was gated, never the draw) — so if the true cost were an extra `render()` call's fixed overhead (pipeline bind + command encode + submit, on top of the four `illumQuad`/`regionScene`/`lightScene`/`compositeQuad` calls already in the same sequence) rather than the DOM read, throttling the DOM read alone would do nothing — exactly what was observed. FIX: `buildUiShadowMaterial` → `buildUiShadowVisibility` (`effects/lighting/light-visibility.js`) now returns a bare TSL `visNode`, no material, no quad, no `render()` call of its own. `environmental-light.js#buildEnvironmentalLightMaterials` takes an optional `uiShadowVisNode` and multiplies it into `illumTexNode.rgb` INSIDE the composite shader that already runs, unconditionally, once per frame — mathematically identical output (composite samples illum AFTER ambient+region+lights have accumulated, same as the v5/v2 write-back pass did) with ZERO extra draw calls. This also now matches the EXISTING precedent exactly: coloration is likewise added only inside the composite, never written back into `buf:scene.illum` — UI-shadow follows the same shape instead of being the odd one out. Correctness note: because there is no longer a draw to SKIP, `updateUiShadowStamps` now explicitly clears every uniform (`uiShadow.setStamps([])`) when the feature is disabled — previously disabling just meant "don't render the quad," which is no longer sufficient since `visNode` is now always evaluated.
- **Files:** `effects/lighting/light-visibility.js` grew `mapWindowRectToStamp` (pure, Node-tested — the DOM→shader geometry) and `buildUiShadowMaterial` (the fullscreen box-SDF MULTIPLY shader, browser-only); `vt-pan-viewer.js` grew `updateUiShadowStamps` (reads `.application`/`.app.window-app` windows carrying a direct-child `.window-header`, read-only) + `setUiShadow`/`getUiShadow`; `boot.js` exposes `MapShine.setUiShadow(...)` and a debug **"Window shadows"** toggle + **"UI window shadows"** status report (proves the reader is finding windows — never a silent no-op).
- **Default-safe:** with no windows open every stamp is strength 0 and the draw is skipped entirely → bit-identical to before. Reads windows read-only; MSA's canvas stays `pointer-events:none` (input-model + interface-seam locks hold).
- **Awaiting live confirmation:** the one Y-flip knob (`setUiShadow({ flipY })`) and the default strength/height/angle tuning — the parts only the author's eyes can settle.

---

## 6. THE SHADOW HANDLE — the sky described once (2026-07-23)

> **BUILT, verify-green (3,236 assertions). NOT YET LIVE-TESTED.** `effects/shadow-access.js` + `effects/__tests__/shadow-access.test.mjs`. Its first and currently only consumer is vegetation (`docs/planning/Vegetation.md`).

### 6.1 The brief, and why it is structural

Author, on adding shadows to `_Tree`/`_Bush`:

> _"eventually we'll want a single interface that drives shadows related to atmospheric conditions so shadows are sharper when there are no clouds, softer as cloud increases and the angle changes with the sun and elongates at dawn and dusk. During night shadows will be softer too and softest if there are clouds… the old V2 had a separate slider for every different aspect of scene shadows and we don't need that, only different offsets and the ability to simulate different heights from the ground (which will have a separate impact on shadow sharpness)."_

That last clause is the whole design. V2 gave every shadow system its own softness/offset/strength sliders, so nothing in the scene agreed about where the sun was, and each new caster added three more knobs that could disagree with the other thirty. The cure is the same shape as `Wind.md` §5.1's wind handle: **the sky is described ONCE, and a caster contributes only what is genuinely its own.**

### 6.2 A caster declares exactly two things

| Knob          | What it does                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `heightPx`    | How far above the ground it sits. Drives the offset length **and** the penumbra, both, automatically.                  |
| `offsetScale` | Cosmetic "throw it further", deliberately decoupled from softness (the `projectShadowOffset` decoupling from §5.6 v4). |

**One honest physical property, two derived behaviours** — that is what replaces V2's separate offset and softness sliders. `VEGETATION_KINDS` carries `shadowHeightPx: 70` for a tree and `16` for a bush; nothing else is declared, and a tree automatically gets the longer, softer shadow.

Everything else — direction, dawn elongation, cloud softening, night fading — is atmospheric, derived once, and **shared by every caster**. A future caster (token, wall, structure) adds **zero** new sliders.

### 6.3 Two of the four behaviours were already built — a finding, not code

`projectShadowOffset` computes `height / tan(elevation)`; `shadowPenumbraPx` computes `base + height × (heightFactor + grazingFactor × grazing)`. Both were already driven by height + sun elevation, for the UI-shadow, already Node-tested. So:

- _"the angle changes with the sun"_ → `shadowOffsetDirection(azimuth)`, already there.
- _"elongates at dawn and dusk"_ → emergent from `height / tan(elevation)`: as the sun nears the horizon `tan → 0` and the throw grows (bounded by `maxOffsetPx`). **Grazing softness comes free from the same input.**

Recording this mattered more than the code it saved: the obvious move was to write a "dawn elongation" term, which would have been a second, disagreeing model stacked on a correct one — the exact V2 failure mode.

### 6.4 What is genuinely new: `shadowAtmosphere(sun, weather)`

- **Cloud → softer AND fainter.** `softnessMul = 1 + 3·cloud`; strength falls to 15% at full overcast. Never zero — a dense canopy still darkens the ground.
- **Night → softer AND fainter**, keyed off `sun.dayFactor01` so shadows fade _through_ twilight rather than popping at the horizon, down to a 12% moon/skyglow floor.
- The two multiply, so **night under cloud is the softest and faintest case** — the exact ordering the brief specified, and asserted as such in the test suite rather than left to prose.

### 6.5 ⚠ The inputs exist; the sources do not (yet)

`world/environment.js#buildEnvSnapshot` already carries everything needed (`sun.*`, `weather.cloudCover01`, `darkness01`). But `vt-pan-viewer.js#updateEnvSnapshot` has **no calendar** (its own comment says so) and had **no weather owner at all** — `cloudCover01` was permanently 0. So in a live scene the handle is correct for the inputs it gets, and those are currently a fixed noon under a clear sky.

Two **debug levers** ship alongside so the model is demonstrable rather than unverifiable: `MapShine.setSunHour(6.5)` and `MapShine.setCloudCover(0.9)`. Both are reported as overrides in the env diagnostics (`todHourSource` / `cloudSource`), never as a calendar — the acknowledged gap stays acknowledged. An atmospheric model nobody can exercise is a model nobody can trust (`feedback_instruments_must_not_lie`).

### 6.6 What deliberately did NOT migrate

The **UI-shadow** keeps reading `DEFAULT_WORKSPACE_LIGHT`. That constant's own doc already argues it: tying UI chrome to `env.sun` would make character-sheet shadows vanish at noon and rake across the screen at dusk — _"reads as a bug, not a feature."_ Different light, correctly a different system. It shares the projection maths without sharing the sky, which is the right seam and already was the seam.

---

_Shadow is not paint. It is the absence of a specific light. Give every light its own shadow and the war has no combatants — the author's paintbrush knew this before the code did._
