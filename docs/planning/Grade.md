# GRADE — one colour engine, two scopes, and the desaturation a light can't do

> **Status: BUILT, verify-green (3,643 tests, 28 structure rules). NOT LIVE-TESTED.**
> Written 2026-07-23 after the sky light landed and the author found its cloud
> recolouration "completely badly broken — it just makes the scene brighter with
> a greyish light," and asked for a proper colour-correction _engine_ (not V2's
> pile of CCs) that can **separate the scene's lighting/time-of-day grade from an
> artistic look grade**. Built the same day on "whole two-scope engine in one go".
>
> Where it lives: `effects/grade/grade-ops.js` (the one primitive + env resolver
>
> - presets + TSL builder, Node-tested incl. the luminance-preservation
>   invariant and TSL↔JS agreement), `effects/grade/grade-present.js` (folded into
>   the present pass, outdoor-gated env grade then whole-image artistic grade),
>   the sky-settings block (grade fields, per-world/per-scene), the astrolabe
>   (**Atmosphere** slider + **Look** dropdown), and the `grade/one-stack` tripwire.
>   The sky "veil" is DELETED. Ships neutral (`Atmosphere` 0, `Look` none).
>
> The `post.grade` seam (`grade-pass.js`) stays a `NotBuiltError` for now — this
> first slice fuses the draw into present (§5); the standalone pass lands only if
> a later rung needs a target between grade and present.
>
> **UPDATE 2026-07-23 (second pass — THE GOD CC, §10-16): BUILT, verify-green
> (3,793 tests, 28 rules). NOT LIVE-TESTED.** The artistic "Look" grade is now a
> first-class EFFECT (`effects/grade/grade.js` schema + manifest) with a
> generated FOH/ROH card (`registerPanel('grade-panel', 'Colour Grade', …,
> {zone:'workshop'})`), its own settings cascade + `MapShine.setGrade`, exactly
> like Bloom. The primitive gained VIBRANCE + a selectable **tone-map curve**
> (AgX default, ACES/Neutral/Reinhard/Cineon/None — three's built-in TSL `Fn`s)
> + the **3D-LUT sample** (`texture3D`, bracketed sRGB, strength-gated). The
> `.cube` parser (`lut-cube.js`) is built + tested. The astrolabe **Look**
> dropdown RETIRED into the effect (one home); the astrolabe keeps only
> **Atmosphere** (the environmental grade). **Deferred one rung:** bundled
> `.cube` ASSET loading — the whole LUT SHADER path is built + tested and wired
> to an identity placeholder, so `lutName`/`lutStrength` drop straight in once
> `assets/luts/*.cube` load (grade.js `deferredRungs.bundled-lut-loading`). The
> tone map ships ON at AgX (author's choice; `toneMapping: 'none'` restores raw).

---

## 0. The answer first, in one sentence

**Build ONE grade primitive (a single pure `applyGrade(color, params)`), apply
it at TWO declared scopes — an ENVIRONMENTAL grade `f(env)` that is
outdoor-mask-gated and luminance-preserving (so it drains colour without ever
touching the light level the lights own), and an ARTISTIC grade that is a
hand-authored whole-image look — composed in one fixed order, with a tripwire
that makes a fourth grade uniform anywhere else fail the build.**

---

## 1. Scare yourself: the V2 evidence (all measured, none invented)

| Measure                                                                                                          | Count                                                                                                                                                          | Source                                                        |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Distinct grade-ish uniforms (`*Tint/Exposure/Saturation/Contrast/Lift/Gamma/Gain/Vibrance/Temperature/Vignette`) | **112**                                                                                                                                                        | `grep` over `legacy/compositor-v2`                            |
| **Parallel grade families with the SAME knobs**                                                                  | **3**                                                                                                                                                          | `uCc*` (13) · `uContext*` (18) · `uAtmosphere*`+`uAtmo*` (11) |
| `ColorCorrectionEffectV2.js`                                                                                     | 2,317 lines                                                                                                                                                    | one file                                                      |
| `ContextualSceneGradeManager.js` + 6 helper modules                                                              | 1,165 lines + `context-env-resolver`, `context-grade-engine`, `context-state-evaluator`, `context-grade-coherence`, `context-grade-spec`, `context-dimensions` | —                                                             |

The disease is not "V2 had colour correction." It is **three managers each
implementing exposure/contrast/saturation/tint/gamma independently**, each
re-tweaking to undo the others, with the knobs then bleeding into water, foam,
fog, distortion and chromatic aberration (`uFoamContrast`, `uFogAirLift`,
`uCausticsBrightnessGamma`…). The same "seven homes per value" that
`Environment.md §0.4` documents for weather, in the colour domain.

**The most important finding: V2 already built what the author is asking for.**
`ContextualSceneGradeManager` _was_ a separate indoor/outdoor, environment-driven
grade, distinct from the artistic `ColorCorrectionEffectV2`. The idea is right.
It became a monster because it was optional and unbounded — no single primitive,
no fixed order, no home, no wall. This plan keeps the idea and adds the four
things V2 lacked.

---

## 2. Why a grade, not a light — the desaturation proof

The author is holding me to my own words: I said a light can't desaturate, and
the sky light's cloud "veil" proves it. Here is exactly why it broke, and why a
grade is the right tool — with the maths, not a hand-wave.

**A multiply cannot desaturate.** `albedo × grey` preserves the ratios between
channels; the pixel goes darker, not greyer. (`sky-access.js` header.)

**The additive veil desaturates but LIFTS BLACKS.** `albedo + grey` does reduce
the chroma _ratio_, but it adds light everywhere, so the dark end floats up into
a milky wash. That is physically what haze does — and it is exactly the "just
makes the scene brighter with a greyish light" the author saw. Correct physics,
wrong feel. An overcast day is not brighter; it is _flatter and greyer at the
same brightness_.

**A grade desaturates by pulling each pixel toward its OWN luminance — and this
provably preserves brightness:**

```
L   = dot(c, [0.2126, 0.7152, 0.0722])          // Rec.709 luminance
c'  = mix(vec3(L), c, sat)                        // sat<1 drains colour
luminance(c') = mix(L·(0.2126+0.7152+0.0722), L, sat) = mix(L, L, sat) = L
```

**`luminance(c') == L`, identically.** Desaturation changes chroma and leaves
the light level untouched. THIS is the answer to "preserve the scene's lighting
so we're not fighting things": the dominant grey-it-out operation is
mathematically incapable of changing brightness, and brightness is what the
lights and `darkness01` own. The grade owns chroma and tone-shape; the lights
own level; **they cannot fight because they operate on orthogonal axes** — the
same "sky owns colour, darkness owns level" split the sky light already proved,
extended one axis further.

This is why the author's instinct is right and my earlier "atmosphere = light,
never a CC" was too absolute. Directional _colour_ (warm sun, blue sky-fill) is
genuinely a light. _Chroma and tone shaping_ (desaturate, flatten, cool) is
genuinely a grade. **Neither can do the other's job.** The atmospheric engine
needs both.

---

## 3. The engine: ONE primitive, applied N times

The whole cure for 112 uniforms is that there is exactly **one** grade function,
pure and Node-tested, and every "CC" in the system is that function with
different parameters — never a new class, never a new uniform family.

```
// effects/grade/grade-ops.js  — pure, Node-tested, the ONLY grade math
applyGrade(rgb, {
  exposure,        // linear scale (stops)
  contrast,        // around mid-grey
  saturation,      // luminance-preserving (§2)
  temperature,     // warm/cool white balance
  tint,            // green/magenta
  lift, gamma, gain,   // shadows / mids / highlights (LGG)
  toneCurve,       // optional filmic knee (the highlight rolloff already in the present pass)
}) → rgb
```

One struct. One function. A tripwire (`grade/one-stack`, §8) makes any _other_
declaration of these terms a build failure, so water/foam/fog can never grow
their own `uContrast` again. That single rule is the difference between an
engine and a pile.

Parameters are **plain data** — which means presets are data too (§6), and a
grade can be evaluated on CPU for a preview thumbnail or on GPU for the frame
from the identical description.

---

## 4. The two scopes the author asked for

> _"separate CC for the scene's lighting and time of day … separate from CC for
> artistic purposes."_

Two instances of the one primitive, with different **inputs**, **scope**, and
**authority**:

### 4.1 The ENVIRONMENTAL grade — `f(env)`, automatic, outdoor-gated

- **Input:** the env snapshot (`env.sun`, `env.weather`). No hand-authoring
  per shot; it _derives_, the way the sky light does.
- **Scope:** OUTDOOR ONLY, gated by the `_Outdoors` mask — the exact same gate,
  texture and `quadUvToWorld` mapping the sky light already uses. An interior
  torch-lit room is never touched by "it's overcast outside." **This is the
  structural cure for V2's compensator:** V2's grade ran globally and needed the
  "Local ToD override" to un-blue the torch pools; a mask-gated grade has no
  torch pools to un-blue.
- **Owns:** the ToD grade (8-anchor timeline, harvested from
  `legacy/core/tod-timeline.js` — it already blends 8 clock anchors of
  `{exposure, saturation, tint, intensityScale}` with a midnight wrap) and the
  **weather grade** — _the cloud desaturation fix_. Overcast =
  `saturation = 1 − k·cloud` (luminance-preserving, §2) + reduced contrast +
  a slight cool tint. This is the "flatter, cooler, dimmer" `Environment.md §2.3`
  specified for overcast from the start; it simply had no engine until now.
- **Authored defaults, runtime-driven values:** the _curves_ (what dusk looks
  like, how hard overcast desaturates) are authorable and shipped as sensible
  defaults; the _value each frame_ comes from time+weather. So a GM never
  hand-sets "it's 40% desaturated now" — they set the world's hour and cloud,
  and the curve resolves it.

### 4.2 The ARTISTIC grade — a hand-authored look, whole-image

- **Input:** the author's own knobs (or a preset). Not derived from anything.
- **Scope:** the WHOLE composed frame, last. Teal-and-orange, noir, warm-cozy —
  the colourist's deliberate style, applied over the already-lit,
  already-atmosphere-graded image.
- **Authority:** per-scene or per-world, reusing the **exact** settings pattern
  the sky just shipped (`world/sky-settings.js` + `foundry/sky-persistence.js`:
  per-world by default, per-scene on an opt-in toggle). A campaign has a look;
  a scene may override it. Zero new persistence design.
- **Ships neutral** (identity grade) so an un-authored scene is pixel-unchanged.

### 4.3 One stack, one order (Environment.md §2.3, now built)

```
scene.lit (fully lit, linear)
   → ENVIRONMENTAL grade   (outdoor-gated)   ┐ "what the world is like"
        ToD → weather → context               ┘  = f(env), automatic
   → ARTISTIC grade        (whole image)      ┐ "what the shot looks like"
        the authored look / preset            ┘  = hand-authored
   → stylizers (bloom, fog, vignette, ascii…) later rungs
   → buf:final → present
```

Fixed order, documented, enforced. A new atmospheric influence adds a STAGE in
this chain — never a hidden multiplier in some effect's shader.

---

## 5. Where it sits, and the colour space

`post.grade` is a **declared seam already** (`graph/passes.js`): it reads
`buf:scene.color` + `buf:scene.attr` (the per-pixel outdoor gate) + `res:env`,
creates `buf:final`, and `present.composite` reads `buf:final`. It is _designed_
to absorb `ColorCorrectionEffectV2` + `ContextualSceneGradeEffectV2` + the
stylizers. Building this is filling a seam the graph has been holding open, not
inventing a pass.

**Colour space (a real decision, stated not hidden):** `scene.lit` is LINEAR
(the light composite ends with `EOTF`). Exposure and the luminance-desaturate
are correct in linear. The film-look ops (lift/gamma/gain, contrast around
mid-grey) are traditionally display-referred. The plan: operate in linear, use
Rec.709 weights for the stylistic desaturate, and treat the LGG/contrast terms
as "cinematic plausibility, not colorimetry" — the same doctrine `world/sun.js`
states for the sun. If a filmic look later needs a true log space, that is a
documented stage boundary, not a silent reinterpretation.

**Pass vs fold (perf):** the UI-shadow lesson (a separate fullscreen pass has
real fixed cost) says: keep the grade LOGIC in `effects/grade/` for ownership,
but for the first slice **fold the draw into the present pass** (present already
samples `scene.lit`), exactly as `light.visibility` is fused into
`light.accumulate`. One fewer pass; identical maths. Split it out only if a
later rung (fog/bloom between grade and present) needs its own target. Measure
with the perf lab before defaulting on (`Effects.md` bar).

---

## 6. Presets — the on-ramp, as data

V2 shipped named looks (`Clear Noon`, `Golden Hour`, `Overcast Day`, `Storm`,
`Moonlit Night`, `Noir`, `Warm & Cozy`, `Cold Horror`…). Because the grade is
one primitive over plain-data params, a preset is **just a params object** —
authorable, shippable, previewable on CPU without a frame. Non-technical authors
pick a look; power users open the stack. This is the "presets dropdown as an
on-ramp" `Control-Panel.md` already calls for, for free.

---

## 7. What happens to the sky light — trim, don't fight

The sky light stays, doing the ONE thing a light does and a grade can't: the
**warm-key / cool-fill illumination split** — shadowed outdoor ground reads
blue, sunlit ground reads warm — which needs the per-pixel lighting knowledge a
whole-frame grade lacks. But two changes:

1. **DELETE the veil** (`sky-access.js#veilAddRgb` and the composite's veil
   add). It was the wrong mechanism (§2); the environmental grade's
   luminance-preserving desaturation replaces it correctly. A clean removal of a
   thing that didn't work, not a second thing stacked on it.
2. **The "too subtle" tint** stops being the sky light's problem. The light's
   hue rotation stays modest and physically-grounded (the `TINT_STRENGTH`
   double-count/blue-explosion reasons in `sky-access.js` are still real); the
   _power_ the author wants comes from the environmental grade, which can push
   mood far harder than a light multiply because it can split-tone and shape
   contrast, not just tint. (A quick, independent win is available now — bump
   `TINT_STRENGTH` and expose it — but it is not where the real strength lives.)

Division of labour, final:

| Owns                               | System                      | Axis             |
| ---------------------------------- | --------------------------- | ---------------- |
| How much light                     | `darkness01` + point lights | level            |
| What colour the light is           | sky light (key/fill)        | illumination hue |
| Chroma + tone of the outdoor image | environmental grade         | look, `f(env)`   |
| The scene's deliberate style       | artistic grade              | look, authored   |

Four systems, four orthogonal axes, one env, one mask. Nothing fights because
nothing shares an axis.

---

## 8. Ships neutral, and the wall

- **Neutral by default.** Both grades default to identity — env grade at
  `strength 0`, artistic grade = the identity params. An un-touched scene is
  pixel-for-pixel what it is today, preserving the Foundry-parity check. Logged
  exception to `feedback_default_on_new_features`, same as the sky light and the
  day clock, same reason: it changes how existing scenes look.
- **`grade/one-stack` tripwire** (built WITH the engine, per covenant rule 4):
  grade terms (`exposure/contrast/saturation/lift/gamma/gain/temperature` as
  OWNED uniforms/params) legal only in `effects/grade/`. This is the wall that
  stops the 112-uniform sprawl from ever reforming — water cannot grow a
  `uContrast`, a new effect cannot grow a `uTint`. Same shape and enforcement as
  `sky/one-atmosphere` and `time/one-tod`.

---

## 9. Build order, when approved

1. **`effects/grade/grade-ops.js`** — the one pure primitive + the ToD-timeline
   evaluator (harvest `legacy/core/tod-timeline.js`) + the weather-grade curve.
   Node-tested, including the luminance-preservation invariant of §2 as an
   asserted property.
2. **`world/grade-settings.js`** — the artistic-grade params + the env-grade
   curve overrides, per-world/per-scene, cloning the `sky-settings.js` shape.
3. **Wire into the present/composite** (fold, §5): environmental grade
   (outdoor-gated, from env) then artistic grade (whole-image), both behind
   their neutral defaults. DELETE the sky veil here.
4. **`grade/one-stack` tripwire** + its sabotage tests.
5. **The astrolabe / control panel** grows a look section: the artistic grade's
   knobs + a preset dropdown; the env-grade curves live in the effect's own
   FOH/ROH card.
6. **Presets** as data (§6), a handful ported in intent from V2's named looks.

Steps 1–3 are the atmospheric engine and fix the cloud complaint. 4 is the wall.
5–6 are the authoring surface.

---

_V2 gave the colourist three grade managers and a hundred knobs, and they spent
their lives undoing each other. V3 gives one grade, applied where it belongs:
the world's own look derived from its sky, the author's look laid over the top,
and a wall that lets neither leak into the water shader ever again._

---

---

# GRADE II — THE GOD CC: full feature set, LUTs, tone mapping, and a real effect card

> **Status: DESIGN (2026-07-23, second pass). The engine above is BUILT; this
> makes it FULLY FEATURED and a first-class registered effect.** Author: _"a
> single powerful and extremely fully-featured CC (I'd love for it to be able to
> work with LUTs)… make the god CC so that everything can slot into it… without
> it becoming a tsunami of uniforms and chaos."_ Plus: it has no FOH card yet —
> plumb it in as an actual effect like Bloom.

## 10. What three.js TSL/WebGPU actually gives us (the research answer)

All grounded in the vendored `src/vendor/three/three.webgpu.js`, not general
knowledge — because a CC plan that assumes a capability three doesn't ship is a
plan that dies at the first shader compile.

| Capability                                               | In the vendored source                                                                             | What it buys                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **The primitive ops** (exposure, WB, LGG, contrast, sat) | built (grade-ops.js), pure TSL                                                                     | already ours                                                                                                    |
| **Six tone-mapping curves** as TSL `Fn`s                 | `linear/reinhard/cineon/acesFilmic/agx/neutral ToneMapping` (50923–51051), exported (54480, 54820) | ACES/AgX = the modern **filmic HDR→display response**. The single biggest "cinematic & powerful" win, for ~free |
| **3D LUT sampling**                                      | `Data3DTexture` (5074) + `Texture3DNode`/`texture3D` (50039)                                       | true trilinear `.cube` creative looks in WebGPU — the author's LUT ask, natively                                |
| **1D LUT / tone curve**                                  | `DataTexture` + a `curve` param type in the schema vocab                                           | per-channel curves (a later ROH widget)                                                                         |
| `vec3`/`color`/`enum` param types                        | schema + FOH renderer (float/color/enum today)                                                     | the control surface, generated not hand-wired                                                                   |

**Verdict:** WebGPU/TSL gives us professional tone mapping AND real 3D LUTs
natively. Nothing here needs a WebGL fallback or a vendored addon. The `.cube`
parser is the only new non-trivial code, and it is ~40 lines of pure text
parsing (Node-testable), not a dependency.

## 11. The god CC is the SAME primitive, three stages longer

The anti-tsunami guarantee is unchanged and is the whole point: there is still
ONE `applyGrade` / `buildGradeNode`, applied at the SAME two scopes. "Fully
featured" means the ONE struct grows a few fields and the ONE node chain grows
three trailing stages — never a second system, never a uniform family (the
`grade/one-stack` wall already forbids that). The full fixed order:

```
  exposure → white-balance → lift/gamma/gain → contrast → saturation → vibrance   ← primary (linear)
    → TONE MAP  (enum: none/ACES/AgX/Neutral/Reinhard/Cineon)                       ← HDR → display response
    → 3D LUT    (optional, strength-mixed, sampled in its authored space)          ← the creative "look"
```

- **Vibrance** joins saturation (a saturation that protects already-saturated
  pixels and skin tones — one more scalar, luminance-preserving family).
- **Tone map** is ONE enum + the existing exposure. It is a WHOLE-FRAME display
  transform, so it belongs to the FINAL (artistic) scope, applied once after
  both grades — not per-scope. `none` = today's behaviour (the present pass's
  documented hue-preserving highlight rolloff stays the `none`/default until the
  author picks a curve).
- **3D LUT** is ONE texture + ONE strength scalar + ONE name. `mix(graded,
lut(graded), strength)` — a strength of 0 compiles out (no texture bound), so
  it ships neutral like everything else.

That is **+3 scalars, +1 enum, +1 texture** on the artistic scope. Not a
tsunami — because the containment (one primitive, one order, one home, one wall)
is exactly what stops "fully featured" from becoming "chaos".

## 12. The COLOUR SPACE decision (the one genuinely hard part)

Tone mapping and LUTs are colour-space-sensitive, and getting this wrong is how
a LUT looks radioactive. Stated explicitly, not hidden:

- Primary ops run in **linear** (where `scene.lit` is) — correct for exposure
  and the luminance-preserving desaturation.
- **Tone map** takes linear HDR → returns display-referred. Three's tone-map
  `Fn`s do exactly this.
- A creative **3D LUT is authored in a display space** (almost always sRGB or a
  log space). So the LUT stage brackets: `sRGB-OETF( tonemapped ) → sample LUT →
sRGB-EOTF( result )` back to the linear the canvas expects to encode. The LUT
  declares its input space; we honour it rather than guessing.
- One consequence: with a tone map or LUT active, the present pass must NOT also
  tone-map. Present already does only the canvas sRGB encode, so this composes —
  but it is the thing to verify live first (a double transform is the classic
  "why is it so contrasty" bug).

This is the one area that needs live calibration, and the plan treats it as
such: ship `none`/no-LUT (a proven no-op), then bring up ACES, then a LUT,
checking each against a known chart.

## 13. TWO instances of one engine — the author's exact framing

> _"one CC that modifies the scene because of atmospherics… a separate CC…
> designed to allow for artistic changes. One is physically present in the scene
> and one is layered on top even if they both work the same way."_

That is precisely the two scopes, now each a first-class thing:

|                   | **Atmosphere Grade** (environmental)                  | **Look Grade** (artistic)                      |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------- |
| Physically        | present in the scene — outdoor-mask-gated             | layered on top — whole image                   |
| Driven by         | `f(env)` (auto) + authorable response curves          | hand-authored, fully                           |
| Owns              | ToD/weather chroma & tone (the cloud desaturation)    | the full god-CC stack + tone map + LUT         |
| FOH today         | the astrolabe **Atmosphere** slider                   | (none yet — THIS is what gets the effect card) |
| Registered effect | `grade.atmosphere` (a small card: response strengths) | `grade.look` (the FULL card)                   |

Both are the same `applyGrade`. The tone map + LUT live on the **Look** scope
(the final display transform belongs to the last, whole-image stage). The
Atmosphere scope stays chroma/tone-only — a filmic curve applied twice (once per
scope) would be the double-transform bug by construction, so the architecture
forbids it by placing tone map only on Look.

## 14. Plumbed in as a REAL effect (the Bloom template)

Bloom is the pattern (`effects/bloom.js` declaration + `bloom-render.js` runtime

- `runPostBloomPass` + `registerPanel('bloom-panel', …, {zone:'workshop'})`
  generating FOH/ROH from the schema). The grade becomes the same shape:

* **`effects/grade/grade.js`** — the DECLARATION (pure data, no THREE): a
  `GRADE_LOOK_PARAMS` schema (exposure, temperature, tint, contrast, saturation,
  vibrance, lift/gamma/gain as `color`s, `toneMapping` enum, `lutName` enum,
  `lutStrength` float), a `GRADE` manifest (`id:'grade'`, `enabledFromProfile`,
  tiers, deferredRungs), and `GRADE_PRESETS`. Node-validated by
  `core/params-schema.js` exactly like `BLOOM_PARAMS`.
* **The runtime is already built** (`grade-ops.js` + `grade-present.js`); it
  gains the vibrance/tonemap/LUT stages and a `setLut(data3DTexture, space)`.
* **`registerPanel('grade-look', 'Colour Grade', …, {zone:'workshop'})`** —
  the FULL FOH/ROH card, generated from the schema. The **Atmosphere** grade
  gets a smaller card (its response curves) or stays on the astrolabe for now.
* **Settings** ride the existing per-world/per-scene look block (already carries
  `gradeEnvStrength`/`lookPreset`; the authored Look params join it, or a preset
  name stays the compact default — see the fork below).

## 15. LUTs — how a LUT actually gets in

- **`effects/grade/lut-cube.js`** — a pure `.cube` parser (`TITLE`, `LUT_3D_SIZE
N`, then N³ RGB triples) → `{size, data:Float32Array}`. Node-tested against a
  hand-written tiny cube. No vendored addon.
- **Bundled preset LUTs** ship in `assets/luts/` (a handful: a neutral, a warm
  film, a cool film, a bleach-bypass) as an on-ramp — chosen by the `lutName`
  enum, zero file-handling for the non-technical author.
- **Author-supplied LUTs** (a later rung): a Foundry file-picker `path` param;
  the same parser; the same Data3DTexture upload. Deferred so v1 ships the
  bundled set working end-to-end first.

## 16. Build order (when approved)

1. **`lut-cube.js`** parser + tests. **grade-ops** gains vibrance + the
   tone-map selector (maps the enum to three's `acesFilmicToneMapping` etc.) +
   the 3D-LUT sample, all in `buildGradeNode`, all Node-tested for the ops and
   TSL↔JS-agreed for the shader. Ship `none`/no-LUT = today's no-op.
2. **`grade.js` declaration** (schema + manifest + presets) + register the
   **Colour Grade** (Look) effect card, generated FOH/ROH, `zone:'workshop'`.
   This is the FOH controls the author is missing.
3. **Tone map live-bringup**: ACES/AgX/Neutral selectable, calibrated against a
   chart, colour space (§12) verified.
4. **Bundled LUTs**: `assets/luts/` + the `lutName` enum wired to the parser +
   Data3DTexture. Author-supplied file-picker LUTs are a deferred rung.
5. **Atmosphere grade's own small card** (its response strengths), so both
   scopes are authorable — closing the author's "both, working the same way".

Steps 1–2 give the fully-featured, FOH-controlled god CC. 3–4 are the tone
map + LUT power. 5 completes the two-instance symmetry.

---

_One primitive. Two instances — the world's own, and the author's. Three
trailing stages that make it a real colourist's tool — vibrance, a film curve,
a LUT. And the same wall as before, so "extremely fully featured" arrives as one
node chain and one generated card, never as the hundred-knob tsunami again._
