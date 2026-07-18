# LIGHT PARITY — the two light types, and how they land in V3's illumination model

**Status:** RESEARCH + DESIGN SEED, 2026-07-17. Follows the two-light-type decision ([[keyhole-two-light-types-decision]]) and the Foundry lighting audit (`docs/reference/foundry-v14-lighting-audit.md`).
**Companions:** `Light-and-Shadow.md` (the shadow half of the same pass), `Environment.md` (the sun this consumes), `v3/B2-lighting-grade-unification.md` (the illumination-priority contract this refines), `Forward+.md` §14.2 / Keyhole §4.2 (the frame graph).
**Governs:** the construction of the `light.accumulate` / `light.visibility` seams (`src/effects/lighting/lighting-pass.js`, `src/graph/passes.js`), currently `NotBuiltError`.

---

## 0. The answer first

**V2's lights didn't fail because the light math was wrong. They failed because good light math sat inside a pipeline that transformed the whole image away from Foundry's look** — a linear-HDR multiply, a global tonemap, and two-to-three grade layers on top — *and* several light **types** were missing. **V3 has already removed most of that surrounding distortion.** So the author's instinct is correct and now evidence-backed: **get lighting working on V3's foundation, with the grade off, and it will look far closer to Foundry by default than V2 ever did.** The remaining parity work is precise and small in surface area — it is the §18 checklist from the audit, plus one genuine open decision (gamma vs linear multiply) and a list of missing light features.

**The two types map cleanly onto the B2 illumination contract that already exists** — they are not a new pipeline, they are two configurations of the `light.accumulate` pass. Nothing here fights `Light-and-Shadow.md`; parity *is* the "shadow = absence of a specific light" model with Foundry-exact numbers.

---

## 1. Why V2 lights never matched — the forensic answer (evidence, not theory)

The old `legacy/compositor-v3/ForwardLightingPass.js` header (lines 5–42) proves the core math was already a faithful Foundry repro:
> `final = screen( albedo × illumination , coloration )` · illumination is `MAX_COLOR` (lights don't stack) · `per light: mix(ambientBg, switchColor(brightLevel, dimLevel, dist), falloff)` · `ratio = clamp(bright/max(dim,bright),0,1)` · coloration is `SCREEN`, light colour × colorationAlpha modulated by albedo brightness.

That is Foundry's model. So the miss was **around** the math, in four places — each now independently verified:

| # | Distortion | Foundry does | V2/interim-V3 did | Status in V3 today |
|---|---|---|---|---|
| 1 | **Composite colour space** | multiply `albedo × illum` in **gamma** (sRGB values used raw) | multiply in **linear HDR** | ⚠️ still linear — the one real open decision (§4) |
| 2 | **Tonemap** | **none** — hard-clip at 1.0 | **global ACES** that *"bleached"* highlights (its own README's word), later a hue-preserving rolloff | ✅ ACES removed; a gentle rolloff remains (§4) |
| 3 | **Grade stack** | **none** | **2–3 layers**: CC ToD timeline (hour→exposure/tint) + contextual indoor/outdoor packs (−0.52/+0.34 exposure…) re-grading the lit image | ✅ absent under V3 (B2 GAP-C); to be reintroduced as ONE thin aesthetic grade only |
| 4 | **Missing light types** | global light, darkness/negative lights, 13 coloration techniques, 29 animations | skipped all of these (`ForwardLightingPass.js:38-42`) — "the ambient base approximates global light; darkness lights [skipped]… non-default coloration techniques [skipped]" | ❌ still to build (§5) |

Plus the architecture-level scars in [[v2-postmortem-the-failure-modes]] and `Light-and-Shadow.md`: lights lived *inside* the CC stack, "four places encode night" (B2 §0), eight suns (`Environment.md`), shadow-as-paint. Those made the look **un-tunable**, not just wrong — every fix re-broke another owner.

**The one-line diagnosis:** correct-ish light, rendered in the wrong space, tone-compressed, then re-graded twice, with half the light types absent. V3 already deleted items 2 and 3 and fixed the base-map colour space ([[reference_foundry_v14_lighting_audit]] context; `vt-sample.tsl.js:178` — the srgbDecode fix). **That is why "closer by default" is real.**

---

## 2. What V3 already gives us (the solid foundation, verified)

- **Base map colour is correct.** `world.draw` decodes sRGB→linear per-pack (`srgbDecode`) and the present pass does exactly one sRGB OETF; the double-encode "washed out" bug is fixed. The *unlit* map already matches Foundry.
- **Forward lighting is Foundry-modeled and live.** Wall-clipped light polygons (`lightSource.shape.points`), `MAX_COLOR` illum, `SCREEN` coloration, environment ambient colours, `lit = albedo × illum`.
- **The bleaching global ACES is gone**, replaced by a hue-preserving highlight rolloff with a `hdrKnee` control and a hard-clip A/B toggle.
- **The illumination-priority contract is designed** (B2 §3.1) and is *already* Foundry's model as a superset (§3 below).
- **The frame graph has the seams cut**: `light.visibility` (creates `res:vis`) and `light.accumulate` (creates `buf:scene.illum`, modifies `buf:scene.color`) — declared, dependency-checked, throwing `NotBuiltError` until built.
- **`LightingDirector`** already merges Foundry-slider + calendar + weather darkness into one `masterDarkness` (B2 §1.1) — the single source of truth the sun/ambient reads.

We are not starting from scratch. We are building the `light.accumulate` body with Foundry-exact numbers into a pipeline that is already shaped for it.

---

## 3. The illumination contract, and where the two types plug in

B2 §3.1's contract (linear HDR, built once per frame) — annotated for the two types:

```
illum = ambient(hour, masterDarkness, outdoorsWeight)      // sky/day/night/indoor-outdoor AS LIGHT
for each light L:
    contribution = L.shader(dist, ratio, colour, …) × visibility_L      // visibility_L = L's OWN shadow
    if L.type == PARITY:  illum = MAX(illum, contribution)   // Foundry MAX_COLOR — overlaps take max
    if L.type == MSA:     illum = illum + contribution        // additive HDR — bloomable, can exceed 1
illum = MIN(illum, darknessContribution)                    // negative/darkness lights (Foundry: priority)
illum *= occlusion                                          // shadow term (Light-and-Shadow.md)
illum += emissive                                           // glow (candle/fire) — an MSA-ish add
lit    = albedo × illum
lit    = SCREEN(lit, colorationParity) + colorationMSA      // Foundry coloured-light layer (+ MSA extras)
── physical light ends ──
graded = aestheticGrade(lit)     // ONE thin artist grade — OFF during parity A/B (§4)
final  = highlightRolloff(graded) → sRGB
```

**Key reconciliation — the MAX-vs-sum question is already answered, correctly.** Some docs wrote the model as `illum = skyAmbient×skyVis + Σ(light×vis)` (a sum). The B2 contract writes `illum = MAX(illum, contribution)`. **MAX is right and it's what Foundry does**, and — crucially — **MAX does not break "shadow = absence of a specific light":** each light's `contribution × visibility_L` is computed independently (its own shadow), *then* MAX-combined. A shadow on light A dims A; an overlapping light B fills via MAX where B is brighter. That is simultaneously Foundry's overlap behaviour and the light-linking thesis. **Read every `Σ` in the older lighting docs as "MAX for the illumination channel, ADD for coloration."** (Worth a one-line correction in `Light-and-Shadow.md` §1 when that pass is touched.)

**So the two types differ in exactly one line each:** parity lights **MAX** into illum (and their colour SCREENs); MSA lights **ADD** into illum (and may exceed 1.0, feeding bloom/rolloff). Same pass, same visibility machinery, same `lit = albedo × illum`. Type-B is literally what the `+= emissive` and HDR-rolloff terms were built for.

---

## 4. THE open decision — gamma vs linear multiply (the last parity gap)

This is the one thing the B2 contract does *not* yet resolve, and it is the subtle reason a linear pipeline running Foundry's exact math still won't be pixel-identical.

- **Foundry:** `lit = albedo_sRGB × illum_sRGB` — the darkening multiply happens on **gamma-encoded** values.
- **V3:** albedo is decoded to **linear**, `lit = albedo_linear × illum_linear`, then linear→sRGB at present.
- `linear2srgb(albedo_linear × illum) ≠ albedo_sRGB × illum`. They agree at illum=0 and illum=1 and **diverge most in the mid-tones** — a half-lit floor reads *darker* in linear than in Foundry's gamma multiply. This is a real, visible-in-A/B difference, and it is independent of getting every §18 number right.

Three ways to close it, in order of increasing faithfulness/cost:

1. **Measure-first, accept if within tolerance (recommended start).** Build `light.accumulate` with the exact §18 ambient ladder + colours in linear, run the §19 A/B harness at several darkness levels, and *measure* the mid-tone gap. It may be small enough to live with once the ambient *colours* are exactly Foundry's — and linear is arguably "more correct." Decide with the diff, not a priori. (Respects [[feedback_instruments_must_not_lie]] and the author's out-diagnosing instinct.)
2. **Gamma-space island for the parity composite.** For parity content, apply the multiply as Foundry does: `lit_linear = srgb2linear( linear2srgb(albedo_linear) × illum_gamma )`. Exact match; costs an encode/decode pair on the composite; keeps `buf:scene.illum` linear for the surface/water/Type-B consumers that want it. This is the escalation if (1) measures out of tolerance.
3. **Warp the illum factor** so a linear multiply reproduces the gamma curve. Equivalent to (2), messier; not recommended.

**Coupled sub-decisions, both about keeping parity content undistorted:**
- **Rolloff:** Foundry hard-clips at 1.0. Parity Type-A content stays in SDR range, so the rolloff (which only bends >~0.9) is *mostly* invisible — but a bright parity light on a bright surface will roll where Foundry clips. Use `MapShine.v3.hardClip`/`hdrKnee` to validate parity against hard-clip; keep the rolloff for MSA/HDR content only, or set the knee high enough that SDR parity is untouched.
- **Grade:** Foundry has none. **Parity A/B must run with the aesthetic grade OFF** (B2 keeps it behind a flag — good). The grade is an MSA-look choice layered *after* parity is proven, never part of the parity claim.

---

## 5. Missing light features → where each lands (build order for `light.accumulate`)

From `ForwardLightingPass.js:38-42`'s "skipped for now" list, mapped to the model. Roughly the order to build:

| Feature | Model home | Notes / audit § |
|---|---|---|
| **Exact ambient ladder** | `ambient()` term | background=mix(daylight,darkness,DL); bright=mix(bg,brightest,1); dim=mix(bg,bright,0.25); weights `{0,.5,.25,1}`. Audit §5a. Replaces B2's tuned endpoints for parity. |
| **Exact per-light falloff** | parity `contribution` | `ratio` pivot + `switchColor` band + attenuation easing `(cos(π·a^1.5)−1)/−2` + outer `smoothstep(1,1−a,dist)`. Audit §5c/§7. |
| **13 coloration techniques** | `colorationParity` | the `if(technique==N)` chain sampling albedo `perceivedBrightness`. Default (1, luminance) first; the rest are a table port. Audit §6. |
| **Global light (sun) as a light** | `ambient()` **or** a scene-sized parity light, gated by the darkness field | Foundry gates the sun by `discard` on a per-pixel darkness window. In V3 the sun already lives in `ambient()`; the *gate* is the `_Outdoors`/region darkness field via the mask-authority hub. Audit §11; [[keyhole-mask-authority]]. |
| **Darkness / negative lights** | `MIN(illum, darknessContribution)` | already a line in the contract; needs the `AdaptiveDarkness` shader (violet `#8651d5`, single MAX channel) + priority/suppression. Audit §12. |
| **29 animations** | per-light `contribution` shader swap | the scaffold + `time/intensity/pulse/brightnessPulse/ratio` uniforms; each animation a body swap. **Parity animations are Type-A; new modes are Type-B.** Audit §13. |

**Tier 0 of parity** (matches the author's proven fallback, per the tier doctrine): exact ambient ladder + exact default-technique point lights with correct `ratio`/attenuation, MAX-combined, `lit = albedo × illum` — grade off, hard-clip on. That alone should A/B close on the common case (plain coloured lights at various darkness). Everything else in the table is additive on top.

---

## 6. Co-existence checklist — don't trip the existing walls

Building parity lighting must not violate the architecture already enforced:

- **No `tCombinedShadow`, no `shadowLift`, no shadow shader sampling a light buffer** — `verify-structure.mjs` `shadow/no-lift-no-combine` fails the build. Parity shadows are per-light `visibility_L`, full stop (`Light-and-Shadow.md` §4.3).
- **Sun direction/darkness from `env.sun` + `LightingDirector` only** — one-sun tripwire; don't re-read `canvas.environment` raw in the parity pass (that was interim-V3 GAP-A).
- **Screen→world bounds via `view-projection-service.getVisibleWorldRect()`** — never an ortho formula; the camera is perspective (`Forward+.md` — the indoor/outdoor bug).
- **The darkness field is one channel, served by the mask-authority hub** — the sun-gate, the ambient indoor/outdoor term, and Foundry's region "Adjust Darkness Level" all read the *same* field ([[keyhole-mask-authority]]); don't spawn a second darkness source of truth (that was the V2 "grey canvas" feedback bus, `Environment.md` §0.3).
- **Parity vs MSA is a per-light flag, opt-in** ([[keyhole-two-light-types-decision]]) — a GM's normal light is always Type-A; Type-B is asked-for.
- **Foundry input authority unchanged** — MSA mirrors Foundry's camera and lights; parity lights are driven from Foundry's `LightData`, not re-authored ([[keyhole-input-model-decision]]).

---

## 7. Recommended first step

**B2-a is already the next step for lighting** (wire `LightingDirector` into V3). Parity slots in right after, as the body of `light.accumulate`, built in the §5 order starting at Tier 0. The very first parity milestone is a **measurement, not a feature**: build Tier-0 parity, run the §19 A/B diff against vanilla Foundry at 3–4 darkness levels with the grade off, and read off (a) how close "closer by default" actually is, and (b) whether the gamma-multiply gap (§4) needs escalating past option 1. Let the diff pick the path.

---

*V2's lights were a good repro drowned in a linear-HDR, tone-mapped, twice-graded pipeline with half the light types missing. V3 already drained most of that. Parity now is exact numbers + one colour-space decision, measured against a diff — not another rewrite.*
