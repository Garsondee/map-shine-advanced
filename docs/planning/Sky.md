# SKY — atmosphere as LIGHT, not as a colour grade

> **Status: BUILT, verify-green (3,568 tests, 27 structure rules). NOT LIVE-TESTED.**
> Written as a design 2026-07-23 and implemented the same day on the author's
> "build the sky light next". §9's build order is done except step 5 (retiring
> the cloud debug lever in favour of a full weather owner — cloud is now a real
> authored setting, but there is no weather _system_ behind it yet).
>
> **It ships as a no-op.** `realism01` defaults to 0, at which the sky light is
> mathematically the identity and every existing scene renders exactly as it did
> (§8). Move the astrolabe's **Sky light** slider off 0 to see any of this.
>
> Where it lives: `effects/sky-access.js` (the handle, pure + Node-tested),
> `effects/lighting/environmental-light.js` (the two channels it writes),
> `world/sky-settings.js` (per-world/per-scene precedence, pure),
> `foundry/sky-persistence.js` (the two stores), and the `sky/one-atmosphere`
> tripwire.
>
> The original brief, kept because it is still the yardstick:
>
> _"The previous V2 did this by using CCs to change the look of the world but we
> want to make it so that it's the light itself which is bringing these
> properties, the outdoors light. This is a critical huge system so feel free to
> spend plenty of time researching and trying to devise the best possible V3
> approach that doesn't repeat the myriad mistakes which this concept brought to
> V2."_

---

## 0. The answer first, in one sentence

**The outdoor sky becomes a real light source writing into the two per-pixel
channels the composite already has — a multiply and an add — gated by the
`_Outdoors` mask; the colour grade stops being where atmosphere comes from and
goes back to being what a colourist does on top.**

---

## 1. What the author asked for, itemised

Five behaviours, all one system:

| Ask                                                                | Physically, that is…                             |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| "darkness to hit 1 at a point after dusk and before dawn"          | the sky dome outliving the sun disc              |
| "subtle recoloration of the scene based on time of day"            | the key/fill colours moving with elevation       |
| "very long soft shadows at dawn and dusk"                          | grazing sun — **already emergent** (§2)          |
| "noon shadows sharp and dark, softer and less dark if cloudy"      | cloud converting a point source into a softbox   |
| "desaturate outside if cloudy, more saturated at cloudless midday" | **veiling luminance** — the interesting one (§5) |

Plus the constraint that ties them together: it must feed the same interface the
shadows already read, so nothing in the scene can disagree about the sky.

---

## 2. What is already built and can be leaned on

Three of the five have their inputs live TODAY.

- **`world/sun.js`** — one sun, Node-tested. Since this session it carries
  `skyFactor01` (the sky dome's own, longer curve), `phase` (the named section
  of sky), and `phaseBoundaryHours()` (the sections as clock hours, derived by
  inverting the elevation curve). **Darkness now keys off `skyFactor01`, so ask
  #1 is DONE** — full dark lands ~19:10/04:50 instead of at sunset, and the blue
  hour exists as a real window.
- **`effects/shadow-access.js`** — the shadow handle. `softnessMul = 1 + 3·cloud`,
  strength to 15% at overcast, night softening off `dayFactor01`. Dawn
  elongation was never written: it falls out of `height / tan(elevation)`.
  **Asks #3 and #4 are already modelled**; they have been waiting on real
  inputs, which the day clock now supplies for time and a weather owner still
  owes for cloud.
- **`world/day-clock.js`** — the hour, with a pause ramp, two authority modes,
  and a `time/one-tod` wall behind it.

So the genuinely-unbuilt part is **the light itself**: asks #2 and #5.

---

## 3. THE STRUCTURAL FINDING — the pipe is already the right shape

`effects/lighting/environmental-light.js` composites:

```
lit = EOTF( OETF(albedo) × illum + coloration )
```

Read that again with the asks in hand. There are **two per-pixel channels**:

- `buf:scene.illum` — a **MULTIPLY**. Currently a flat fill of Foundry's ambient
  background. Its own source comment says: _"Constant per frame today; becomes
  per-pixel when `_Outdoors` indoor/outdoor lands (increment 1b)."_
- `buf:scene.coloration` — an **ADD**, in gamma space, Foundry-parity.

A multiply channel and an add channel, both per-pixel, both already composited
correctly, with the mask integration already anticipated in writing.

**The outdoor sky does not need a new pass.** It needs to write into those two.
That is not a lucky coincidence — it is what happens when the lighting model was
built from Foundry's own algorithm rather than invented.

---

## 4. THE OUTDOOR LIGHT — four properties, one description

The sky is described ONCE, the way `wind-access.js` and `shadow-access.js`
already describe their domains. A consumer receives a handle; it never assembles
the sky by hand.

```
skyHandle = f(sun, weather)
  ├─ key    { dirXY, colorRgb, strength }   the sun disc      → multiply
  ├─ fill   { colorRgb, strength }          the sky dome      → multiply
  ├─ veil   { colorRgb, strength }          scattered light   → ADD
  └─ shadow { softnessMul, strength }       ← already exists, unchanged
```

### 4.1 Key — the sun disc

- **Direction** from `env.sun.azimuthDeg` (already the shadow direction — the
  same number, so a highlight can never point away from its own shadow).
- **Colour** from elevation, on a Planckian-ish ramp: ~1900 K at the horizon,
  ~5500 K overhead. This is where _"subtle recoloration based on time of day"_
  actually lives, and it is one curve, not eight anchors.
- **Strength** from `dayFactor01`, then **killed by cloud**: `× (1 − cloud)`.
  A key light is the first casualty of overcast — that is what "overcast" means.

### 4.2 Fill — the sky dome

- **Colour**: deep blue at zenith on a clear day, warming toward the horizon
  band at golden hour, near-black-blue at night.
- **Strength** from `skyFactor01`, and cloud **raises** it: `× (1 + 0.6·cloud)`.

The key/fill split is the whole reason this reads as weather rather than as a
dimmer. Clear day = a hard warm key against a blue fill (high colour contrast).
Overcast = no key, a big neutral fill (no colour contrast). **Ask #5's second
half — "increase saturation during cloudless middays" — is emergent from this**,
before any saturation term exists at all: two differently-coloured lights across
a frame produce more chroma variety than one flat one.

### 4.3 Veil — and why this is the desaturator

See §5. It is the part worth arguing carefully.

---

## 5. DESATURATION, honestly derived

**A multiply cannot desaturate.** Multiplying an albedo by grey preserves the
ratios between its channels exactly — the pixel gets darker, not greyer. So
"cloudy days look grey" cannot come from dimming the light, and any attempt to
get there by dimming will produce a _dark_ scene, not a _flat_ one. This is
worth stating plainly because it is the trap: the obvious move is a `saturation`
uniform, and the obvious move is V2.

**Additive light does desaturate**, and it is real physics: _veiling luminance_
— skylight scattered by the air between the eye and the subject, laid over
everything. Worked through:

```
albedo (0.80, 0.20, 0.20)   a strong red    saturation (max−min)/max = 0.75
+ veil  0.30 neutral
      = (1.10, 0.50, 0.50)                  saturation             = 0.545
```

Chroma drops by a quarter, from adding light. No saturation knob involved. And
the `coloration` channel is **already an additive, gamma-space, per-pixel
channel** — the veil has a home before it is written.

Three properties fall out for free, all of which the author asked for elsewhere:

1. **Cloud desaturates**, because cloud raises the veil.
2. **Clear midday is the most saturated moment of the day** — minimum veil, and
   the maximum key/fill colour split from §4.2.
3. **Distance haze** works the same way later, if the veil is ever allowed to
   vary spatially. Same term, no new system.

### ⚠ The honest caveat

Veiling luminance also **lifts blacks and lowers contrast**. That is _correct_ —
overcast days genuinely are low-contrast — but it means the physical model gives
"flat and grey" as one gesture, not "grey but still punchy". If the author wants
a stronger, more stylised desaturation than the physics delivers, that wants an
explicit small chroma term on the sky light, declared as a **look** knob and
labelled as such. Do not pretend the physics gave it. One named cheat beside a
model is maintainable; a model quietly tuned until it lies is V2.

---

## 6. WHY THIS BEATS V2'S COLOUR CORRECTOR — three receipts, not opinions

All three are from V2's own documented behaviour
(`docs/reference/v2-effect-params/color-correction-effect.md`).

### 6.1 The mask gate stops being a special case

V2's outdoor atmosphere had to be bolted _inside_ the colour corrector:

> _"Outdoor atmosphere: procedural weather/golden-hour offsets on sky-eligible
> outdoor pixels (after timeline, before tone map). Requires `_Outdoors` for
> interior vs outdoor timeline splits and atmosphere gating."_

A full-screen grade is global by nature, so making it outdoor-only meant
teaching the colourist about masks. As a **light**, `_Outdoors` is simply where
the light reaches. The special case does not get better — it ceases to exist.

### 6.2 The compensator disappears — this is the big one

V2 shipped an entire mechanism called **Local ToD override**:

> _"under gameplay lights (HDR light buffer), blends from the timeline grade
> toward a bright neutral local grade — cancels midnight tint/exposure in lit
> pools without a circular cutout."_

Read what that is. The midnight grade was applied to the whole frame _after_
lighting, so it tinted the inside of torch pools too — and a torch pool should
not be blue at midnight. So V2 built a second system to **undo the first system
wherever a light was**. That is the exact compensator shape `Light-and-Shadow.md`
catalogues: `DynamicLightShadowLift.js` was a module for un-darkening shadows
near lights, and this is the same disease in the colour domain.

As a light, there is nothing to cancel. A torch is brighter than the night sky;
the sum is simply brighter. **The compensator was the cost of grading after
lighting, and moving the atmosphere upstream refunds it.**

### 6.3 One authority for "what is it like outside"

Today `shadowAtmosphere` derives softness/strength from `(sun, weather)`, and a
CC would derive tint/exposure from the same pair — **two derivations of one
sky**, which is `env/one-sun`'s own failure re-run in the colour domain. One
handle, and the shadow softness and the light colour are guaranteed to be
describing the same afternoon.

---

## 7. WHAT THE GRADE STACK IS FOR NOW

`post.grade` does not go away. It changes job.

|                                | Source                                          | Owns                         |
| ------------------------------ | ----------------------------------------------- | ---------------------------- |
| **Sky light** (new)            | `f(sun, weather)`, per-pixel, `_Outdoors`-gated | what the world **is** like   |
| **Grade stack** (`post.grade`) | the author's own knobs                          | what the shot **looks** like |

V2 had one system doing both, which is why every weather change meant
re-tuning a look and every look change broke the weather. Separating them is
what makes "overcast noon" and "my scene has a teal-and-orange look" independent
statements. The grade keeps exposure/contrast/LGG/tone-map/vignette/grain — a
colourist's pass, on a plate that already has the right light in it.

---

## 8. THE SAFETY SLIDE — ship neutral, exactly like the darkness lever

`environmental-light.js` holds a hard-won parity property: at `background =
white` the sRGB round-trip is the identity and MSA's lit map is **pixel-identical
to Foundry's**. That is the strongest parity check the project has, and a sky
light that alters the frame by default would destroy it silently.

So the sky light ships behind a `skyRealism01`-style scalar defaulting to **0 =
exact Foundry parity**, reusing the proven pattern of `darknessRealism01`
(`keyhole-darkness-realism-lever`): one number, two honest modes, and the
default is the one that cannot surprise anybody. Note this is a deliberate,
logged exception to `feedback_default_on_new_features` — the same exception the
day clock's zero drift rate takes, and for the same reason: it changes how
EXISTING scenes look.

---

## 9. Build order, when it is time

1. **`effects/sky-access.js`** — the handle: `createSkyHandle({sun, weather})` →
   `{key, fill, veil, shadow}`, immutable, versioned, Node-tested against named
   cases ("clear noon has a warm key and a blue fill"; "overcast kills the key
   and raises the veil"; "midnight veil is near zero"). Pure — no TSL, no
   Foundry. Absorbs the existing `shadowAtmosphere` rather than sitting beside
   it, so there is one sky object, not two.
2. **`_Outdoors` into the illum pass** — the "increment 1b" that
   `environmental-light.js` has had written down since it was built. Per-pixel
   ambient. This is the prerequisite for everything visual and is worth doing on
   its own merits.
3. **Key + fill into `illum`**, `skyRealism01` at 0 by default.
4. **Veil into `coloration`**, gated the same way.
5. **Retire the debug `setCloudCover` lever** in favour of a real weather owner
   — the last acknowledged gap in the env snapshot after this session closed the
   time one.

Tripwire to add WITH step 3 (covenant rule 4 — when built, not before):
**`sky/one-atmosphere`** — sky/atmosphere terms (`skyTint`, `atmosphereStrength`,
`veilStrength`, a saturation uniform outside `post.grade`) legal only in
`effects/sky-access.js`. The wall that stops receipt 6.3 from happening again.

---

_Atmosphere is not a filter over the picture. It is the light the picture is made
of. V2 graded the photograph; V3 lights the room._
