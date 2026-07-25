# B2 — Lighting & grade unification (moving day/night out of CC)

**Status:** design draft, 2026-07-11. Grounds the "reimagine the lighting model"
decision (session 2026-07-11). Reproduces §14's illumination-priority principle
against the _actual_ V2 grade/lighting code, and defines how V3 absorbs the
time-of-day / indoor-outdoor / per-effect day-night logic that today lives in the
colour-correction stack. Companion to [B0-1 attribute buffer](B0-1-floor-attribute-buffer.md)
and the Forward+ plan §14/§15.

---

## 0. The core insight

The author's framing: _"a continual and never-ending unwanted battle to make the
lighting look good and appropriate at all times of day."_ The reason it's a battle
is structural — **three independent subsystems each re-derive "how dark is it" and
"am I indoors," then fight over the final pixel:**

1. **Physical lighting** (`LightingEffectV2` + window/fire/player light + shadows) —
   dims per-floor by `masterDarkness`.
2. **Colour correction** (`ColorCorrectionEffectV2` ToD timeline) — re-grades the
   merged image by hour.
3. **Contextual grade** (`core/context-grade/*` + `ContextualSceneGradeEffectV2`) —
   probes the scene and re-grades again by indoor/outdoor + spatial modifiers.

Plus every effect (`FireEffectV2`, `CandleFlamesEffectV2`, …) independently reads
`masterDarkness` and nudges its own look. **Four places encode "night."** Change
one and the others no longer agree — hence the endless rebalancing.

> **The reframing:** most of what the CC ToD timeline and the contextual grade do
> is _compensating for lighting that isn't physically correct._ If the lighting
> model produces the right ambient (day/night **and** indoor/outdoor) as actual
> light, the image is already "right" before grading — and CC collapses to a thin
> aesthetic film-look instead of a per-context exposure hack. **One place encodes
> night: the illumination buffer.** That is the whole point of B2.

---

## 1. Current state — the V2 "look" pipeline (verified)

### 1.1 The one good part: `LightingDirector` is already a single source of truth

[core/LightingDirector.js](../../../scripts/core/LightingDirector.js) merges the
three darkness inputs **once per frame** into a frozen state:

- `masterDarkness` 0..1 — canonical scene darkness, merged from Foundry slider +
  calendar (`computeTimeOfDayDarkness01(hour)`) + weather `effectiveDarkness`, via
  the `lightingDarknessPriority` setting (`max` default / foundry / calendar / weather).
- `hour` 0..24, `sunAzDeg`/`sunElDeg`, `calendarSunStrength`/`calendarDaylightHours`.
- It **mirrors `masterDarkness` back into `canvas.environment.darknessLevel`** (live,
  not persisted) so Foundry vision and everything downstream agree.

This is the right abstraction and V3 should build on it verbatim. **The problem is
not the director; it's the three consumers below each doing their own thing on top.**

### 1.2 Grade layer 1 — CC time-of-day timeline

[ColorCorrectionEffectV2.js](../../../scripts/compositor-v2/effects/ColorCorrectionEffectV2.js)
(`_evaluateTodTimeline`, `_resolveTimelineHour` ~L2005–2040) keyframes **two tracks
by hour** — `global` and `interior` — each carrying `{exposure, saturation, tintColor}`,
interpolated across the day. This is the literal "time of day CC": midday neutral,
warm dawn/dusk tint, cool night, applied as a post-grade to the merged image.

### 1.3 Grade layer 2 — contextual scene grade

[core/context-grade/](../../../scripts/core/context-grade/) (~120 KB: engine, spec,
probe-service, manager, resolvers, coherence) + the params in
[ContextualSceneGradeEffectV2.js](../../../scripts/compositor-v2/effects/ContextualSceneGradeEffectV2.js).
Probe-driven, it applies:

- **Indoor vs outdoor grade packs** — full `{exposure, saturation, brightness,
contrast, vibrance, temperature, tint, vignette, gamma}` per context. Reference
  values: outdoor `+0.34` exposure / warmer / `+0.1` vibrance; indoor `−0.52`
  exposure / `−0.16` saturation / `+0.32` vignette / `+0.1` gamma. Blended by the
  `_Outdoors` sample through a smooth band `computeOutdoorBlendWeight` (indoor ≤ 0.18,
  outdoor ≥ 0.82). **This is the "indoors vs outdoors CC."**
- **Spatial environment modifiers** — `cloudShadow` (`−0.16` exp, cooler),
  `canopy`/tree-dapple (`−0.12` exp), `buildingShadow` (`−0.4` exp, `+vignette`),
  `paintedShadow` (`−0.18` exp), `windowLit` (`+0.14` exp, warmer), overcast.
- **Drama peaks, eye-adaptation (auto-exposure), coherence** — cinematic time-varying
  exposure on top.

### 1.4 Per-effect day/night

`FireEffectV2` (nightBoost/nightMul — fire reads brighter at night), `CandleFlamesEffectV2`
(hour-keyed), `LightningEffectV2`, `vegetation-ambient-light`, etc. all read
`LightingDirector.get().masterDarkness` and scale themselves. Legitimate per-effect
behaviour — but note **much of it exists because the surrounding ambient wasn't
physically dark**, so the effect had to fake the contrast.

### 1.5 The dependency picture

```
                       ┌─ LightingEffectV2 (per-floor dim by masterDarkness)
LightingDirector ──────┼─ per-effect day/night (fire/candle/… read masterDarkness)
 (masterDarkness,      ├─ CC ToD timeline      (hour → global+interior exposure/tint)   ← GRADE
  hour, sun)           └─ Contextual grade     (indoor/outdoor packs + spatial mods)     ← GRADE
                                   ↓
              final = physical-light image, THEN two stacked grade passes
```

---

## 2. V3 reality + the gaps (verified 2026-07-11)

Under V3 (`compositor-v3/`), the frame is `unifiedGeometry → lighting → effects →
present`. V2's `_compositorV2.render()` is skipped, so **both grade layers (1.2, 1.3)
do not run at all**, and:

- **GAP A — V3 is disconnected from `LightingDirector`.** `compositor-v3/` has **zero**
  references to it. `ForwardLightingPass._environment()` reads `canvas.environment.darknessLevel`
  and `canvas.colors.*` directly. Since `LightingDirector.update()` is called from
  `FloorCompositor.js:4953` (a V2-path method V3 bypasses), **MSA's calendar/weather
  darkness and the priority policy never reach V3** — V3 sees only Foundry's raw
  slider (or a stale mirror). Changing time-of-day through MSA controls has no
  effect in V3. _This alone can explain "day and night look the same" and, by
  extension, why the indoor/outdoor toggle looked inert._
- **GAP B — indoor/outdoor mask not engaging.** `_syncOutdoorsUniforms` resolves
  `sceneComposer._sceneMaskCompositor` (correct handle) but `uHasOutdoors` stays 0
  in practice — either no `_Outdoors` authored on the tested scene, or the mask
  product isn't built under the V3 path. Also, V3 samples the mask as a hard `r`
  value; it should use the **same smooth 0.18→0.82 band** as the contextual grade
  for consistency.
- **GAP C — no grade at all.** All the hand-tuned ToD + contextual look is absent
  under V3. Scenes render "physically lit but ungraded."

---

## 3. The reimagined model (V3)

### 3.1 The illumination-priority contract (the tangle-resolver)

One illumination buffer, fixed operators, fixed order. Everything that means
"light or dark here" resolves _here_, not in post:

```
illumination (linear HDR), built once per frame:
  base   = ambient(hour, masterDarkness, outdoorsWeight)   // day/night + indoor/outdoor AS LIGHT
  lights : illum = MAX(illum, lightContribution)           // Foundry lights (already in V3)
  dark   : illum = MIN(illum, darknessContribution)        // negative/darkness sources (TODO)
  shadow : illum *= occlusion                               // shadows incl. cloud/building/canopy (B3)
  glow   : illum += emissive                                // fire/candle glow (candle in V3)
lit   = albedo * illum
lit   = SCREEN(lit, coloration)                             // Foundry coloured-light layer
── physical light ends here ──────────────────────────────
graded = aestheticGrade(lit)   // ONE thin artist LUT/contrast/sat/tint — NOT per-context
final  = highlightRolloff(graded) → sRGB   // present pass (already in V3)
```

The rule that ends the battle: **whoever contributes doesn't "win" by running last —
the operator decides** (MAX for lights, MIN for darkness, × for shadow, + for glow).
Deterministic, order-independent within a stage, no dual code paths.

### 3.2 What absorbs what

| Today (grade/CC)                                               | V3 home                                                              | How                                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| CC ToD `global` exposure/tint by hour                          | `ambient()` intensity + **light colour**                             | Ambient colour & level come from `hour`/`masterDarkness` (warm dawn/dusk, cool night). The image is lit that colour, not tinted after. |
| CC `interior` track                                            | the indoor branch of `ambient()`                                     | Indoors is physically darker/cooler _as light_, not a post-exposure cut.                                                               |
| Contextual **indoor/outdoor packs** (−0.52 / +0.34 exposure …) | `ambient()` indoor vs outdoor endpoints, blended by `outdoorsWeight` | The −0.52 indoor exposure becomes a darker indoor ambient; local lights/windows fill it. Same 0.18→0.82 blend.                         |
| Contextual **cloud/building/canopy/painted shadow** modifiers  | **shadow term** (B3)                                                 | These are shadows. `buildingShadow −0.4 exposure` is an actual occlusion multiply, not a graded region.                                |
| Contextual **windowLit** modifier                              | window light (already a light)                                       | Window light brightens `illum`; drop the separate "window-lit exposure" grade.                                                         |
| Contextual **drama / eye-adaptation**                          | thin adaptive exposure before the rolloff                            | Auto-exposure is legit; keep a _simplified_ version on the HDR buffer, not a per-context stack.                                        |
| Per-effect day/night (fire/candle)                             | keep — but reads correct `masterDarkness` via GAP-A fix              | Some boosts become unnecessary once ambient is physically dark; re-tune, don't re-invent.                                              |
| Aesthetic film-look (contrast/sat/tint/vignette/LUT)           | **the only surviving CC pass**                                       | One artist grade applied last. Context-independent.                                                                                    |

### 3.3 Consequence

CC stops being a lighting mechanism and becomes a single aesthetic layer. Day/night
and indoor/outdoor are computed **once**, as light. Per-effect code keeps its one
`masterDarkness` read but against a correct, physically-dark surround.

---

## 4. Migration staging (keep V2 grade alive behind the flag)

Reliability first; A/B at every step against golden scenes captured at **multiple
times of day and indoor+outdoor viewpoints** (extends A2 — the ToD axis is new and
mandatory here).

- **B2-a — wire `LightingDirector` into V3 (GAP A).** V3 calls `LightingDirector.update()`
  once per frame and `ForwardLightingPass` reads `masterDarkness`/`hour`/`sun` from
  it instead of raw `canvas.environment`. _Small, high-value, likely fixes the
  day/night-looks-static symptom immediately._ No model change yet.
- **B2-b — indoor/outdoor as light (GAP B).** Fix mask resolution under V3; adopt the
  0.18→0.82 smooth blend; make the indoor/outdoor ambient endpoints match the intent
  of the contextual indoor/outdoor packs (start by porting their exposure deltas into
  ambient levels). Toggle `MapShine.v3.indoorOutdoor` becomes meaningful.
- **B2-c — ambient colour by hour.** Port the CC ToD `global`/`interior` _colour_ +
  level intent into `ambient()` (warm dawn/dusk, cool night) so the map is lit that
  colour. V2 ToD timeline stays available under `?msaV3=0` for A/B.
- **B2-d — adaptive exposure (optional, simplified).** A single eye-adaptation term on
  the HDR buffer before the present rolloff, if scenes need it after b/c.
- **B3 (separate milestone) — env modifiers become shadows.** Cloud/building/canopy/
  painted-shadow modifiers migrate from grade into the shadow term. Needs the
  attribute buffer (B0-1) for floor-gated occlusion.
- **Grade demotion — last.** Only once b–d reach parity, replace the V2 CC/contextual
  stack (under V3) with the single aesthetic grade. Keep V2's stack runnable behind
  the flag until then; delete after a soak.

## 5. Risks

1. **Lost hand-tuning.** The preset values in §1.2/1.3 are hard-won. Port their
   _intent_ (ambient level/colour) and A/B every scene/time; do not eyeball-replace.
2. **ToD golden coverage.** Without day+night+dawn baselines, regressions hide. A2
   must grow a time-of-day axis before B2-c.
3. **Effect re-tuning cascade.** Making ambient physically dark changes what
   fire/candle boosts should be. Expect a re-tune pass; keep it bounded per effect.
4. **Probe/eye-adaptation parity.** The contextual probe service is elaborate; a
   simplified V3 auto-exposure may not match frame-for-frame. Decide "good enough"
   explicitly rather than chasing the old curve.

## 6. Immediate next step

**B2-a (wire `LightingDirector` into V3)** — smallest, safest, and most likely to
move the needle on the day/night symptom today. Everything else in §4 builds on it.

```

```
