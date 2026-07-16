# LIGHT & SHADOW — why they fought, and the model where they cannot

**Status:** RESEARCH + DESIGN SEED, 2026-07-16. Author's brief, with their five-step pile-up quoted in §1: *"Light and Shadow. These two facets had their own horrible terrible battle in V2... Sky reach NEVER WORKED even though I thought it was simple. Overhead shadow was meant to work but was always a nightmare. _Shadow as a manually painted texture was the best solution... Do you see the horrible pile up mess? Full research audit. Never again."*
**Companions:** `Environment.md` (the sun this consumes), `Effects-API.md` (the contract), `Engine-Postmortem.md`, Keyhole §4.4 (the unified shadow pass this seeds).

---

## 0. The answer first, because it is one sentence

> **V2 modeled shadow as a THING — dark paint composited onto the scene. Shadow is not a thing. Shadow is the ABSENCE OF A SPECIFIC LIGHT.**

Once shadow is paint, the author's five steps become rock-paper-scissors with no winner: shadow must darken sun (2), light must punch through shadow (3), shadow must re-darken over light (4)... forever — because *"this shadow applies to the sun but not to the torch"* is **inexpressible** in stacked darkening layers. Every horror below is a compensator for that one wrong noun.

In the author's own professional language: **V2 had no light-linking.** In Maya you can link a shadow to the light that casts it; a flag on set cuts ONE lamp, not the scene's exposure. V2's shadows were flags that cut the exposure. The fix is not better flags — it is light-linking, which the author already knows how to think in.

## 1. The pile-up, restated as what each step ACTUALLY is

| Author's step | What it is in the correct model |
|---|---|
| 1. "The sun lights the white of `_Outdoors` during the day" | the sun is a light; `_Outdoors` is part of its **visibility term** |
| 2. "Building shadows must darken that" | building shadow is ALSO part of the **sun's visibility term** — it modulates the sun, and ONLY the sun |
| 3. "A token torch would naturally override that shadow" | nothing to override! The torch is a separate light with its OWN visibility; the sun's shadow never touched it. Its light **adds** |
| 4. "A shadow tile over the torch would darken it further" | the tile joins the **torch's** visibility term — a per-light occluder, affecting that torch alone |
| 5. "Lightning and others tinkered with lighting" | lightning is just another light (a directional flash) reusing the same caster geometry — free, not special |

`illum(pixel) = skyAmbient × skyVisibility(pixel) + Σ over lights L of L(pixel) × visibility_L(pixel)`

Multiply per light, then sum. **No step fights any other step** — light accumulates, shadow gates its own light, and the pile-up is structurally impossible. This is also Foundry v14's own additive illumination model (the harvested `ForwardLightingPass` is already per-light additive with MAX-blend illum), extended with a visibility term per light.

## 2. The evidence — every compensator V2 built instead (all verified in source)

The family: **27,684 lines** across the light/shadow effects + a 14-file `shadow-system/` directory, holding **43 render targets** in the effects alone (Lighting 11, OverheadStamp 13, Painted 8, Building 7...).

1. **ONE combined shadow for ALL lights** — SkyReach's own docstring: *"ShadowManagerV2 folds it into `tCombinedShadow` next to the building/painted/overhead/cloud factors."* A single factor texture that cannot know which light it should apply to. **This is the wrong noun, in code.**
2. **`DynamicLightShadowLift.js` — an entire module for un-darkening shadows near lights.** Shadow shaders take `tDynamicLight` and `tWindowLight` as INPUTS and weaken their own darkening where lights glow, by `uDynamicLightShadowOverrideStrength = 0.7` — **one global hand-tuned scalar**. A candle and a floodlight punch through a building shadow by the same 70%. It could only ever look right in the cases it was tuned on. Ten files carry lift machinery. *The lift is the exact cost of the wrong noun: because shadow darkened everything, an inverse system had to exist to protect lights from it.*
3. **Per-source opacity knobs at the combine** — `uBuildingOpacity`, `uOverheadOpacity`, `uCloudOpacity`, `uCloudWeight`: each shadow producer's contribution hand-weighted into the shared factor. More output-space collision (`Environment.md` §0.5): five producers × opacity knobs × the lift × time-of-day strength — tuned against each other, so touching one re-broke the sum. **The same disease as the grade stack, in the shadow domain.**
4. **OverheadStamp (13 RTs), the "nightmare", confesses in its header:** *"capture passes (roof/fluid/tile/upper-floor-alpha composite), **temporary override restoration**..."* — it mutates scene state, renders captures, and must perfectly restore, with four hash-keyed cache families (`hashCamera`, `hashCasterLive`, `hashRoofMaskCapture`, `hashTileProjectionCapture`) invalidated by hand. It also once *duplicated* building/skyreach terms and had to be de-duplicated later (the header says so). Save-mutate-render-restore is the state-leak generator (`Engine-Postmortem.md` §3) — of COURSE it was a nightmare.
5. **Comment-MUST #7 and #8** — both SkyReach and OverheadStamp carry HEALTH-WIRING BADGEs demanding hand-maintained sync with the HealthEvaluator. The genre remains 0-for-everything.

## 3. Why each named system failed — specifically

- **Sky Reach "never worked, even though it seemed simple" — because it WAS simple; the pipeline it fed wasn't.** Its output (a clean R-channel factor, correct contract) had to traverse: the ShadowManager combine → its per-source opacity → *"the existing roof/top-floor suppression gates"* (other systems' logic gating its output) → the dynamic-light lift → a canvas-padding UV remap its own header warns about (*"do not clip with sceneRect offsets here — that mixes spaces"*). **Five hand-tuned stages owned by three other systems sat between its math and the screen.** When it looked wrong, no instrument could show which stage ate it (2,670 silent catches; `feedback_instruments_must_not_lie`). A simple effect in an unaccountable pipeline is not a simple effect.
- **Overhead shadow "always a nightmare"** — §2.4: temporary-override capture architecture + hand cache invalidation + cross-coupling into LightingEffect's ceiling transmittance. Its *job* was reasonable; its *architecture* was save-mutate-restore with four caches.
- **Painted `_Shadow` "was the best solution" — because it accidentally implements the CORRECT model.** An artist looking at the map and painting where sunlight doesn't reach is *hand-authoring the sun's visibility term* — a baked light-linking map. It bypassed the combine, the gates and the lift, and it looked right because it **is** the right noun. The author out-designed their own pipeline with a paintbrush.

## 4. THE KEYHOLE DESIGN

### 4.1 The model
- **Every light carries its own visibility term.** `illum = skyAmbient × skyVis + Σ L_i × vis_i`. The sun is a light. Lightning is a light (same caster geometry, different direction/time — free). Window light is a light. A torch is a light.
- **The sun's visibility term is a composition of producers that all mean the same thing** — and are therefore reconcilable by `min()` with no opacity knobs: authored `_Shadow` (the artist's word — wins where painted), computed building shadow from `_Outdoors`, computed sky-reach from upper-floor alpha, cloud shadow from weather. One semantic, one channel, min-combined. **Sky-reach finally works because it lands in a term with one meaning, not a gauntlet.**
- **Dynamic lights' visibility**: Foundry's wall-clipped LOS polygons (already authoritative, §4.3) are the base term — that alone covers the author's step 3 with zero new machinery. Overhead-tile occlusion of point lights (step 4 — "never was a problem but always could have been") becomes a **tier rung**, not a default: per-light tile occlusion at higher tiers only, on machines with budget. The ladder makes the maybe-someday case affordable to have and cheap to not-have.
- **`env.sun` (Environment.md) supplies the one sun** — direction, elevation, colour. The eight suns die there; shadows and specular finally agree on where the sky is.
- **No lift. No combine. No per-source opacity.** These words become tripwires (§4.3). If a shadow needs to be weaker near a torch, that is the model working — the torch's own light adds — not a compensator.

### 4.2 What survives from V2 (harvest with respect)
- **The painted `_Shadow` workflow, promoted to first-class**: it is now *the authored sun-visibility layer*, the highest-authority producer in the sun's term. The author's favourite tool stops being a workaround and becomes the canon.
- `SeparableShadowBlur` (the soft look), the ceiling-transmittance concept (roofs dim interiors — it becomes part of the sun/sky visibility for indoor pixels), the caster-geometry ideas in the producers, and the sun-direction math (unified into `env.sun`).

### 4.3 Tripwires queued (covenant rule 4 — add when the lighting pass lands)
- **Shadow may only modulate a light's contribution.** No shadow texture is ever multiplied onto composed scene colour. (Greppable: no `tCombinedShadow`-shaped uniform; no multiply-darken in post.)
- **The words `shadowLift` / `ShadowOverride` / a shadow shader sampling a light buffer = build failure.** The lift is the fossil of the wrong noun.
- One sun: sun direction computed in exactly one module (shared with Environment.md's tripwire).

### 4.4 Cost note (Effects.md terms)
Sun visibility is one VT channel (authored) + cheap composited producers (C3/C4); per-light dynamic shadows beyond Foundry's walls are C6+ tier rungs. Tier 0 of the entire shadow system = *authored `_Shadow` alone modulating the sun* — which is exactly what the author shipped V2 with, by hand, and it looked right. **Tier 0 is literally the author's proven fallback.**

---

*Shadow is not paint. It is the absence of a specific light. Give every light its own shadow and the war has no combatants — the author's paintbrush knew this before the code did.*
