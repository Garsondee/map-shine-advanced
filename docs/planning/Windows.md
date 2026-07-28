# WINDOWS — the painted light cookie, driven by the sky (`light.accumulate`)

**Status:** **Tier 0 BUILT (unverified) 2026-07-27** — the mask read as light, added onto `buf:scene.illum`, floor-gated, cropped to its own AABB, wired end to end (seams → registration → panel → debug channels → status report) and Node-tested (120 assertions across the cookie decode, the highlight shoulder, the TSL graph construction, and the surface subsystem's visibility/debug-swap contract). ⚠️ **Seen once, live** — a real scene (an observatory tower with a large gold-and-blue mosaic skylight room) showed the room washed out to a flat white disc, the painted tracery gone. §11 records the cause (an unbounded additive contribution meeting `lit = EOTF(OETF(albedo)×illum)`, traced to the real formula, not guessed) and the fix (a hue-preserving highlight shoulder on the cookie's own contribution). **Not yet RE-seen with the fix applied** — this codebase has a measured record of fully-green test suites meaning nothing about whether an effect draws correctly (`keyhole-current-state`); only the author's own eyes promote this to LIVE. Everything past tier 0 (sky-drive, drift, moon, cloud, occlude, stretch, bounce, shaft, motes, the point-light-conversion idea) is `deferredRungs` in `src/effects/window/window.js` — designed, ordered, not built. Authored from a direct read of `legacy/compositor-v2/effects/WindowLightEffectV2.js` (3,667 lines), its consumption inside `LightingEffectV2.js`'s compose (the half that actually decided what the effect looked like), `CloudEffectV2.js` (2,728 lines, the shadow producer), and the harvested control schema (`docs/reference/v2-effect-params/window-light-effect.md`, **98 authored controls**).
**Owns:** no new pass. `graph/passes.js` already assigns `WindowLightEffectV2` to **`light.accumulate`**, and that is the right home: this is a light, so it belongs in the light system.
**Forces one shared prerequisite:** `world/cloud-field.js` — a spatial cloud-shadow field, for tier 4. It does not exist yet; tier 0 ships a WIRED SEAM instead (`window-render.js#cloudFactorNode`, defaults to a constant 1 — see §4.4 and the module's own header). Windows will be its first consumer, and **it must not be owned by this effect**.

**Author directive, 2026-07-27** — the sentence the whole design turns on:

> _"All `_Windows` and `_Structural` masks are light applied only to the interior of buildings, so you can safely assume that any bright pixel in `_Windows` is where a bright light would fall on the interior of the building at day. Imagine that you are looking down on the gobo lighting cookie shapes of window lights spilling into rooms. **A cloud travels across the sky and the window light inside dims and dies.** That's the goal."_

---

## 0. The thesis, in one paragraph

**The mask is not a window. The mask is the light.** The author has already painted the cookie — the shape daylight makes on the interior floor, with its own falloff and its own colour, in exactly the right place. That deletes the entire geometry problem: there is nothing to project, no aperture to locate, no wall to face, no beam to trace. What the painting *cannot* carry is **time** — how bright it is at this hour, what colour the sun is right now, and what happens when a cloud goes over. V2 answered that with fifty-six hand-keyframed sliders and a 2,728-line sprite simulator feeding a screen-space render target. The answer is one function of the sky we already compute, plus one analytic noise field drifting on the wind we already compute. **The mask supplies the shape; the sky supplies the life.**

---

## 1. WHAT THE DIRECTIVE DELETES

Worth stating plainly, because it removes most of what would otherwise be hard:

| Problem a "window light" effect normally has | Status under the painted-cookie semantic |
| --- | --- |
| Where does the light land? | **Answered by the paint.** Not inferred, not projected, not marched. |
| Which side of the wall is outside? | **Does not arise.** There is no wall in this effect; there is a patch on a floor. |
| How wide/soft is the beam's penumbra? | **Painted.** The cookie's own value falloff *is* the penumbra, at whatever softness the artist wanted. |
| Where is the sill, how tall is the window? | **Not needed.** Those existed to compute the throw, and the throw is painted. |
| Do interior walls clip the beam? | **Yes, already** — the artist did not paint light through a wall. |
| Is this a wall window or a skylight? | **Irrelevant to the shape.** Both are cookies on the floor. |

Everything that survives is **radiometric and temporal**: strength, colour, spectral character, and motion. That is a much smaller and much better-conditioned problem than the one a procedural window system has to solve, and it is a genuine authoring advantage rather than a shortcut — the artist's cookie will beat anything derived, because it is the light they *intended*.

**The one thing the paint cannot know is what time it is.** That is the whole remaining job.

---

## 2. THE AUTOPSY — what V2 did with a mask that was already the answer

### 2.1 It hand-keyframed a quantity the engine derives

**Fifty-six of the ninety-eight controls** are eight time-of-day anchors × (hour, intensity scale, exposure, saturation, tint R, tint G, tint B). Every one of them is describing what the sun is doing — and none of them is *connected* to the sun. `effects/sky-access.js` computes the outdoor light's colour and strength from `world/sun.js` as one continuous curve; V2's timeline is a second, independent, hand-drawn copy of the same curve that can disagree with it and has no way to be told it has.

This is `env/one-sun`'s thesis with a human in the loop: a term derived twice is N−1 needless chances to disagree, and here the second derivation is a person with a mouse and eight keyframes. It is also unfalsifiable — nothing can be wrong with a curve whose only specification is "whatever the author dragged it to", which is why the effect accumulated a 506-line overexposure probe.

Fifty-six sliders is the price of not having modelled the mechanism. §3 is the mechanism.

### 2.2 The additive wash — the paint, not the blend

V2 folds the emit buffer into compose **twice**:

```glsl
totalIllumination += winIllum;              // :3829  — correct: light multiplies the albedo
vec3 litColor = baseColor.rgb * totalIllumination;
litColor += winHueLit * spillAmt;           // :3854  — a paint-over on the finished pixel
litColor += winChromaLit * fringeSpill;     // :3860
```

The first is right — a light scales what it falls on, so a sunlit flagstone shows *more of its own colour*, not less. The second (`uWindowScreenSpill`) is an additive haze on the already-lit result, which **flattens the art it is supposed to be lighting**: it lifts blacks, crushes the albedo's own contrast, and makes a bright patch read as fog rather than as sun.

`keyhole-water-tsl-design` records the identical correction at the cost of three rejected builds — *"the IN-SCATTER term was the paint, not the blend."* And `sky-access.js`'s own header records it a third time, in the sky's deleted veil: *"an additive term lifts blacks, so it read as 'the scene just got brighter and greyish'."* **Three effects, one mistake.** A light multiplies. If a term must add, it is not the light.

### 2.3 Seventeen fetches per pixel re-deriving a hand-painted picture

The shader spends most of its bandwidth discovering geometry:

| Function | Taps | Deriving |
| --- | --- | --- |
| `wlMaskEdge` | **5** | where the patch's edge is |
| `wlRainFlowDir` | **4** on `_Outdoors` | which way the wall faces — at a **user-tunable 1…160 px radius** (`rainGlassSlopeSamplePx`) |
| prismatic RGB split | 3 | |
| mask + softened mask + floor id + `_Specular` + cloud shadow | 5 | |

**Seventeen fetches per pixel**, through **11 samplers** and **94 uniforms**, over a target up to 4096² — to re-discover the outline and softness of a picture an artist already drew. The cookie's edge *is* the mask; its softness *is* the mask's value ramp. None of it needed deriving, and a slider whose job is tuning how far to look while guessing a static fact is the tell.

### 2.4 A cloud system that cost 2,728 lines and drifted with the camera

The goal in the directive was **attempted** in V2, and the machinery is the finding:

- `CloudEffectV2.js` simulates cloud **sprites** — spawn arcs, downwind recycling (`_hasExitedDownwind`), drift orbit strength, drift responsiveness, drift deceleration, max speed — and renders them into `_shadowRT`.
- `WindowLightEffectV2` samples that RT through `wlSampleCloudShadowFactor`, converting scene UV → world → **screen UV**, because the buffer is screen-space.
- Being screen-space, it moves when the camera moves, so a bespoke motion-compensation cache (`_shadowCacheMotionRef`, coarse drift buckets) exists to hide the swim.
- Four controls (`cloudShadowContrast/Bias/Gamma/MinLight`) reshape the result after the fact.

**A cloud shadow is a scalar field over the world at a time.** In TSL that is one `mx_fractal_noise_float` at `worldXY + wind·t` — ~10 ALU ops, no sprites, no render target, no camera dependence, no motion cache, and correct while panning by construction. V2 built a particle simulator because GLSL-era thinking says *"a field must be a texture"*, and then paid for the texture being in the wrong space forever.

### 2.5 A precondition that can only subtract

`LightingEffectV2.js:3351`: `winLights *= (1.0 - isOutdoorForInteriorDimSafe);`

Given the interior-only semantic this is *approximately correct* — but it is redundant, and redundant in the direction that costs pixels. **The author has already asserted "indoors" by only painting indoors.** Re-testing that assertion against a derived, feathered, `smoothstep(0.18, 0.82)`-laddered `_Outdoors` mask can only ever remove light the artist deliberately put there — and it removes it precisely at thresholds, doorways, arcades and window reveals, which is exactly where these patches live and exactly where the `_Outdoors` boundary is feathered.

`feedback_count_silent_preconditions`: **delete a precondition rather than repair one.** Trust the paint.

### 2.6 The rest of the ledger

- **VRAM.** A 4096² RGBA16F emit target is **134 MB**. `_floorEmitCache` holds one *per floor* (up to four); `_shadowLiftEmitRT` is a fifth. Worst case is over half a gigabyte for one effect, on an engine with two logged device losses (`keyhole-device-loss-large-map`, `keyhole-floor-switch-canvas-redraw-collision`). `windowLightUseHalfFloat` and `setEmitResolutionScale(0.25…1)` are the architecture apologising for itself.
- **A cache that cannot cache.** The 28-field key includes `Math.floor(uTime * 8)` whenever `rgbShiftAnimate` is on — and it **defaults to `true`**. Eight invalidations per second, by construction, in the shipping configuration.
- **Two consumers, two definitions.** Compose gates the emit buffer at `smoothstep(0.008, 0.055)`; the shadow-lift blit gates the *same buffer* at `smoothstep(0.10, 0.24)`. A twelve-fold disagreement about "is there window light here", possible only because the buffer's units were never defined — same symptom as the `WINDOW_ILLUM_SCALE = 0.22` constant, whose comment cites a compose formula the compose no longer uses.
- **Its own tone shoulder and its own colourist.** `emit /= (1 + emit × 0.14)` plus a full exposure/saturation/tint stack, inside an effect, in a renderer with one grade engine.
- **`specularBoost` reaches into `_Specular`** — four more samplers, so this effect's output depends on another effect's mask through no declared edge. The `window.MapShine` free-for-all `graph/passes.js` exists to make impossible.
- **Rain-on-glass (9 controls) warps the cookie's UVs.** Under the true semantic this is unambiguous: it wobbles *the shape of the light on the floor* with procedural droplets. Rain does not move a sunbeam. Wrong effect, wrong place — it belongs to `surface.response` (a wet clear coat) or to the particle engine.
- **Sparkle density is measured in camera-view units.** `wlSparklePointField` derives cell size from `viewUvMax − viewUvMin`, so zooming re-lays out the lattice — on a feature whose own author note says *"Glints do not drift on the map."* Same aliasing failure `Specular.md` §3.5 names.
- **Ten independent `flipY` uniforms** (`uWindow0…3FlipY`, `uSpecular0…3FlipY`, `uOutdoorsMaskFlipY`, `uFloorIdFlipY`) — ten separate chances at `feedback_y_flip_recurring_risk`, each with its own push site.
- **Dead instrumentation.** `windowLightDraw.outdoorsClip` (`:5499`) and `lightOverride.windowDraw.outdoorsClip` (`:5275`) are perf spans that begin and immediately end, bracketing nothing. `feedback_instruments_must_not_lie`.

### 2.7 What is worth harvesting

| V2 instinct | Verdict |
| --- | --- |
| **`_Windows` / `_Structural` aliases** | Already preserved in `scene/mask-catalog.js`. V2 map folders keep working. Nothing to do. |
| **Cloud shadows dim the window light** | **The goal, and correct.** Rebuilt as an analytic world-space field (§4) instead of a sprite sim feeding a screen-space RT. 4 reshaping controls → 0 (the field is shaped where it is defined). |
| **Cloud dimming as a global scalar** (1 control) | Free — `sky-access.js` already collapses the key under `cloudCover01` and raises the dome's share. 1 control → 0. |
| **Lightning blasts through windows** (4 controls) | **Free.** `Light-and-Shadow.md`: *"Lightning is a light — same caster geometry, different direction/time."* A flash is "the sky spiked for 100 ms", and §3 already reads the sky. 4 controls → 0. |
| **The patch takes the light's colour** | Right. V2 could only apply one global colour picker for the whole map; §3 gives the sun's own hour-by-hour ramp, and the paint's own hue on top of it, for free. |
| **A gamma on the patch's falloff** (`falloff`) | Keep exactly one, as a thumb on an authored quantity — §3.3 gives it a second job worth having. |
| **The prismatic fringe** (8 controls) | The instinct (light dispersing through coloured glass) is real; the mechanism (RGB texture-offset on the mask) is not. Returns at the top of the ladder as an edge treatment on the patch, at one control. |

---

## 3. THE DRIVE — one sun, two lobes

### 3.1 The cookie, read as light

```
c      = mask.rgb (linear)
v      = max(c.r, c.g, c.b)
p      = smoothstep(EDGE0, EDGE1, v)              // presence, antialiased from the file
level  = pow(v, contrast)                          // HOW MUCH light lands here — the painted falloff
tint   = (v > 0) ? c / v : vec3(1)                 // WHAT COLOUR the glass made it
```

Three axes, three meanings, and unlike `_Specular` this needs no argument — the author is painting light directly, so hue is the light's colour, value is its strength, and the bottom of value is presence. Stained glass works because the artist paints the reds and blues where they fall.

> ⚠️ `level` and `tint` stay **two numbers**. `feedback_one_byte_two_quantities` is the four-round bug class here: V2 collapsed both into one luma × one global picker, which is why a dim red patch and a bright grey one were indistinguishable. Presence keys off the very bottom of value (a threshold); level uses the whole range (a value). Same split `_Fluid` uses, same authoring caveat: **do not paint the falloff down to pure black**, or the faintest edge of every cookie reads as "no light".

### 3.2 It MULTIPLIES. It never adds.

```
buf:scene.illum  +=  level × tint × skyDrive       // an illumination term, MAX/ADD'd with the lamps
```

and then `litColor = albedo × illum` as it already does for every other light. **No `litColor +=` anywhere in this effect.** §2.2 is the reason, and it has been paid for three times in this codebase.

The visible consequence is the point: a sunlit flagstone shows *more of its own colour and texture*, not a white film over it. That is the difference between a room with sun in it and a room with a lens flare on it.

### 3.3 Two lobes, and this is what makes the cloud read

The single most important structural decision in the document. The drive is **not one number**:

```
KEY   = sky.key.colorRgb  × sky.key.strength  × cloudField(worldXY, t) × keyGain
FILL  = sky.fill.colorRgb × sky.fill.strength                          × fillGain

drive = KEY × pow(v, contrast)          // sharp: the painted falloff at full contrast
      + FILL × pow(v, contrast × soft)  // soft:  the same fetch, flattened   (soft < 1)
```

`effects/sky-access.js` already hands both halves over, already split, already cloud-aware:

| | `key` — the sun disc | `fill` — the sky dome |
| --- | --- | --- |
| Colour | warm at the horizon (1900 K), neutral overhead | day blue → twilight blue → night blue |
| Strength | `dayFactor01 × (1 − cloud01)` — **cloud is its first casualty** | `skyFactor01 × 0.42 × (1 + 0.6 × cloud01)` — **cloud makes it stronger** |
| Character here | sharp-edged, follows the painted falloff exactly | flattened, broad, no hard edge |

**So when a cloud crosses, the patch does not fade uniformly — it changes character.** The warm sharp term dies; the cool soft term stays and slightly grows. A room goes from *sunbeam* to *grey daylight through a window*, which is exactly what happens in a real room, and it is the whole difference between an effect that reads as light and one that reads as an opacity slider.

The softening costs **zero extra fetches**: it is a second `pow()` on the value already in a register. (Tier 7 upgrades the fill to a genuinely blurred cookie — see §6.)

> ⚠️ **The fill is NOT gated on the key.** `feedback_environment_term_gates_wrong_thing` cost this project a shipped-invisible specular build for precisely this shape: an ambient floor gated on its directional partner's own trigger measured **exactly zero** in the commonest case, and the wrongness was invisible because the effect merely looked "subtle". The two lobes are always both computed and always both added. A build where the fill sits behind the key's test is that bug in a new costume, and it will present as *"the cloud makes the light vanish completely"* rather than as a crash.

### 3.4 Night is not a special case

At night `dayFactor01 → 0`, so KEY → 0. `fill` becomes `FILL_NIGHT_RGB`, a cold near-colourless blue. Left alone, the same cookie becomes **a faint cold pool of moonlight on the same flagstones** — free, one multiplier, and the reason the window never simply switches off. That is tier 3 and it is deliberately not zero by default (`feedback_default_on_new_features`).

---

## 4. THE CLOUD — the named goal

### 4.1 What it has to be

*"A cloud travels across the sky and the window light inside dims and dies."*

Three requirements fall out, and each one rules something out:

1. **Spatial, not scalar.** `env.weather.cloudCover01` is one number for the whole map — a global dimmer, not a travelling shadow. **There is no spatial cloud field anywhere in `src/` today** (verified: every consumer — `shadow-access.js`, `sky-access.js`, `sun-occlusion.js` — reads the scalar). This is the one genuinely new thing the design needs.
2. **World-space, not screen-space.** V2's was screen-space and needed a motion-compensation cache to stop it swimming under the camera (§2.4). A cloud shadow lies on the ground; it must be a function of world position.
3. **Progressive.** "Travels across" means the leading edge dims first. Sampled per-pixel, not per-patch — a patch half in shadow is the shot.

### 4.2 The field

```
drift    = windDirXY × (CLOUD_BASE_SPEED + wind.speed01 × CLOUD_WIND_GAIN) × t
n        = mx_fractal_noise_float(vec3((worldXY + drift) / cloudScalePx, 0), octaves)   // ≈ −1..1
coverage = smoothstep(edge0(cover01), edge1(cover01), n)
shadow   = 1 − coverage × depth(cover01)
```

`mx_fractal_noise_float` is **present** (`three.webgpu.js:53739`) and backend-identical, so there is no hand-rolled hash and no WebGL2 twin (Law 8). No render target, no sprites, no cache, no bandwidth. **C2 at worst, and arguably C1.**

Four properties are load-bearing:

- **It is a mathematical no-op at clear sky.** At `cover01 = 0` the threshold sits above the noise's range, `coverage = 0`, and the field returns exactly `1.0`. A clear-sky frame is bit-identical to one with the feature absent — the same discipline `sky-access.js`'s `realism01 = 0` and the darkness-realism lever both take, and the reason this can default on.
- **Contrast peaks at broken cloud, not at overcast.** `depth(c) = CLOUD_SHADOW_DEPTH × 4c(1 − c)` — maximum at `c = 0.5`, zero at both ends. That is physically true (overcast has no cloud *shadows*; it is all shadow, which is why the sky's own `fill` gain handles it) and it is the behaviour that makes a partly-cloudy afternoon the most alive weather on the map. Nobody tunes this; it is a parabola.
- **It drifts on the wind the engine already has.** `env.wind.directionDeg` / `speed01`, via the same handle `world/wind-field.js` serves — so clouds and wind-blown foliage move together, and there is one wind. `CLOUD_BASE_SPEED > 0` keeps clouds drifting on a still day (they are at a different altitude); one optional angular offset covers the different-altitude-different-direction case.
- **Two scales.** A large slow octave (cloud masses) plus a smaller faster one (wisps and edges). One `octaves` parameter on the same call. That is the difference between "the light dims" and "a cloud went over".

### 4.3 What it looks like, in order

A cloud arrives:

1. The **key** dies progressively across the patch — leading edge first, over a second or two.
2. As it dies, the patch's *sharpness* goes with it, because only the flattened fill term remains (§3.3).
3. The colour cools: the warm 1900–5500 K key is replaced by the blue dome.
4. The patch **does not vanish.** A soft cool presence remains, and slightly strengthens, because `fill.strength` rises with cover.
5. The cloud passes; all four reverse.

And free, from the same field, the moment it exists: **the building shadows outside soften and fade in step**, because `shadow-access.js` is the second consumer (§4.4). The whole map breathes together.

### 4.4 ⚠️ THE FIELD IS NOT THIS EFFECT'S PROPERTY

A cloud shadow is a fact about the world, and at least five things want it:

| Consumer | What it gets |
| --- | --- |
| **windows** (first) | the patch dims and dies |
| `effects/shadow-access.js` | its scalar `cloudStrength`/`cloudSoften` become **spatial** — building shadows fade under the same cloud |
| `effects/lighting/environmental-light.js` | outdoor ambient dips as the cloud passes |
| `effects/water/water-light.js` | the sun glint on water dies under the same cloud |
| `effects/specular` (tier 5 `context`) | the metal's sun lobe, likewise |

If windows owns it, MSA acquires a second weather system the day the second consumer arrives — the eight-suns failure (`env/one-sun`) re-run in a new domain, and this codebase has already paid for that twice (`sky-access.js`'s `dirX`, the two wind fields).

So: **`world/cloud-field.js`** — pure, TSL-analytic, Node-testable core, sibling to `world/wind-field.js` and `world/sun.js`, surfaced through the existing handle pattern. Windows is its **forcing function and first consumer**, not its owner. That is a prerequisite of tier 4, and it should be built as one — small, shared, and correct once.

---

## 5. MOTION — the patch slides with the day

The cookie is painted at *some* hour. The sun does not stay there.

### 5.1 Drift is one global offset, and that is not an approximation

All patches move **the same direction and the same distance** — because there is one sun, at one azimuth, and every wall window on the map sits at roughly one sill height. So:

```
dir     = −marchDirectionToSun(env.sun.azimuthDeg)      // the ONE azimuth→XY convention here
throw   = sillHeightPx / tan(elevationDeg)              // verbatim the sun shadow's own formula
offset  = (throw(now) − throw(referenceHour)) × dir  ×  driftAmount
uv      = maskUv − offset / maskWorldSize
```

Six ALU ops on the UV before an existing fetch. **C1.** One authored number — *what hour was this painted for* — as a scene-level parameter, with `driftAmount = 0` available for authors who want the patch to stay exactly where they put it.

> `marchDirectionToSun` and `heightPx / tan(elevation)` are **delegated, never re-derived** — the second is verbatim `projectShadowOffset` from the sun shadow. The dividend is that a building's shadow outside and the sunbeam inside its window travel the same way *by construction*. `feedback_unconsumed_api_rots_silently` is the reason to then **assert that relationship in a test**: `sky-access.js`'s key direction was 90°-and-mirrored wrong for its entire life under a comment claiming exactly this agreement, and nothing caught it because nothing consumed it.

### 5.2 Stretch needs a pivot, and that is the only thing left that needs a list

A low sun also **elongates** the patch by `tan(refEl)/tan(el)` along `dir`. Scaling needs an origin, and scaling every patch about the map origin would fling distant ones off the map. Each patch must pivot on **its own centroid** — which means knowing that patches are *things*.

Connected-component labelling on the mask gives it: a small table of `{ id, floorId, centroidWorld, aabb }`, extracted **on the CPU at decode time**, exactly as `effects/fluid/fluid-net.js` already extracts its tube net from `_Fluid`. Precedent in the repo, works on both backends, runs on mask change. The per-pixel lookup is the label written into the coarse derived grid (`scene/mask-derive.js`, ≤512² per floor — `window` needs `rasterize: true`, one line in the catalog).

This is a **tier 6 C4 rung**, not the foundation. The v1 draft of this document built an entire jump-flood aperture pack for geometry the author paints; the true semantic reduces that to one centroid per patch, and only for the stretch.

---

## 6. THE LADDER

Ordered by **cost class** per `Effects.md` Law 3 — not by prettiness. Tier 0's C4 is the admission price; monotonicity governs 1..N upward from there, the same shape `water.js` and `specular.js` established.

| Tier | Name | Class | Adds |
| --- | --- | --- | --- |
| **0** ✅ | `cookie` | C4 | The painted cookie read as light (§3.1): level × tint, hue-preserving highlight shoulder (§11), **ADDED onto** `buf:scene.illum`, floor-gated by `buf:scene.attr.r`, cropped to the mask's own AABB. No `_Outdoors` re-test (§2.5). Never gated off; carries the correctness gate. **BUILT (unverified) 2026-07-27** — `src/effects/window/`, Node-tested (120 assertions), seen once live, washout found and corrected (§11), not yet re-confirmed. |
| **1** | `sky-driven` | C1 | The key/fill split from `sky-access.js` (§3.3), each with its own gamma on the same fetch. **Dawn is orange, noon is white, overcast is flat grey — and fifty-six sliders are gone.** Pure ALU on tier 0's fetch. |
| **2** | `drift` | C1 | The patch slides along the sun's own throw as the hour changes (§5.1). Six ALU ops. **The light moves across the room as the day passes.** |
| **3** | `moon` | C1 | The same cookie at night on the night dome's colour (§3.4). One multiplier. **A cold faint pool instead of an off switch.** |
| **4** | `cloud` | **C2** | `world/cloud-field.js` (§4): a two-octave analytic field drifting on the wind, sampled at world position, killing the key and leaving the fill. **THE NAMED GOAL — a cloud crosses, the leading edge dims first, the warmth and the sharpness go, a cool presence lingers, and it comes back.** One noise call. No render target. |
| **5** | `occlude` | C3 | The patch cut by what blocks the sun *outside*: a neighbouring building's shadow lying across the window kills its beam. Reads the caster-height field `effects/lighting/sun-occlusion.js` already marches — the same field, one more consumer. |
| **6** | `stretch` | C4 | Per-patch elongation at low sun, pivoting on each cookie's own centroid (§5.2). The connected-component table + the coarse derived grid. **Evening light stretches long across the floor.** |
| **7** | `bounce` | C4 | The fill lobe upgraded from a gamma-flattened copy to the **genuinely blurred** cookie (the ≤512² derived grid *is* that blur, already rasterized), plus a soft warm indirect wash into the room around each patch. **Rooms with sun in them feel sunlit, not spotlit.** |
| **8** | `shaft` | C6 | The visible fan of light in the air above the patch. Half-res, temporally accumulated via ping-pong, additive. An honest 2D fake (`Light-MSA-Ideas.md` §D). Coverage- and zoom-gated (Law 7). |
| **9** | `motes` | C2+C7 | Dust in the beam through the particle engine that already exists, brightest where the shaft passes. Ticks whether seen or not → gated hard. |

**Read it as a story.** Tiers 0–4 are **one mask read, one analytic noise, and arithmetic** — no new buffers, no new bandwidth, nothing above C2 — and they buy the whole identity of the effect including the named goal. They ship as one increment. A weak machine gets the sunbeam, the hour, the drift, the moonlight and the cloud. Everything from 5 up is the expensive half, and it is the half noticed when present rather than when absent. That asymmetry is Law 3 working, not luck.

**Fourteen controls replace ninety-eight.** The 56 anchors become one sun. The 9 rain-on-glass go to another effect. The 4 lightning and 1 cloud-dim controls become zero. The 4 cloud-shadow reshaping controls become zero, because the field is shaped where it is defined rather than corrected after the fact.

---

## 7. THE DECLARATION

### 7.1 The correctness gate — and it does not ride the ladder

Two things live in tier 0 and are never compiled out:

- **Floor.** `attr.r == myFloor` is the "is this cookie actually visible" test. Same gate `surface.response` uses, and the SAME caveat travels with it: `attr`'s alpha lane is confirmed broken (specular's own measured note), so tier 0 reads R only and does not attempt a partial-transparency test off alpha — and `buf:scene.attr` is written by floor **art** only, so an overlay leaves the attributes beneath it untouched.
- **Nothing else.** In particular **no `_Outdoors` re-test** (§2.5) — the paint already asserts it, and the derived mask can only subtract.

### 7.2 Ordering inside `light.accumulate`

No new pass; `passes.js` already absorbs `WindowLightEffectV2` here. The window terms are a sub-render sibling to region-darkness and the UI shadow, the shape sun-occlusion already took:

```
light.accumulate:
  1. ambient / darkness / regions      → buf:scene.illum
  2. point lights (MAX-blended)        → buf:scene.illum
  3. WINDOW COOKIES (add)              → buf:scene.illum     ← new
  4. UI window shadow (multiply)
  … then scene.color ×= illum, as today
```

Adding rather than MAX-ing is deliberate: a torch standing *in* a sunbeam should be brighter than either alone. Nothing here reads `buf:scene.illum`, so there is no read-while-writing hazard and no ordering subtlety — a direct consequence of §3 replacing the v1 draft's two-way valve, which did have one.

### 7.3 Module layout — the established split

```
src/effects/window/
  window.js                    WINDOW_PARAMS + the WINDOW manifest + debug channels. Pure data, no THREE. ✅ BUILT
  window-cookie.js             mask RGB → (level, tint, presence). Pure fn + CPU twin, Node-tested. ✅ BUILT
  window-render.js             the TSL material, the bounded quad, the ADD-onto-illum blend, the
                                cloud-factor SEAM (constant-1 default). THREE injected. ✅ BUILT (tier 0 only)
  window-surface-subsystem.js  the mesh, its own scene, mask load/crop/sync/status/dispose — mirrors
                                specular-surface-subsystem.js. ✅ BUILT
  window-seams.js              getWindowMaskRect / getWindowMaskUrl onto the mask authority. ✅ BUILT
  window-registration.js       the cascade layer, the live override, the console setter, the FOH card. ✅ BUILT
  window-drive.js              sky handle + cloud field → the key/fill pair (tier 1). Pure + CPU twin.
                                ← THE MEASURED MODULE. NOT BUILT.
  window-motion.js             sun + reference hour → the UV offset (tier 2) and tier 6's stretch. Pure +
                                CPU twin. DELEGATES to marchDirectionToSun / the shadow throw formula.
                                NOT BUILT.
  window-patches.js            connected components → the patch table (tier 6). Pure, CPU, at decode.
                                NOT BUILT.

src/world/
  cloud-field.js                THE SHARED PREREQUISITE (§4.4), for tier 4. Pure, TSL-analytic + CPU twin.
                                 NOT owned by windows. NOT BUILT — tier 0 ships the SEAM
                                 (window-render.js#cloudFactorNode) that plugs it in the day it exists.
```

### 7.4 What changes outside the folder

1. **`scene/mask-catalog.js`** — `window` gains `rasterize: true`, one line. **DONE.** Tier 0 needs the per-floor grid for its **world rect** — what maps `positionWorld` to a mask UV, the same reason `specular` carries the flag; tier 6 will additionally want it for the patch labels. Fourth kind to use the flag after `water`, `fluid` and `specular`.
2. **`world/cloud-field.js`** — new, shared, and the only genuinely new subsystem tier 4 needs. Not built yet; tier 0 ships the seam it plugs into instead (§4.4, `window-render.js`'s own header). `shadow-access.js` should become its second consumer immediately once it lands (its scalar `cloudStrength` gains a spatial query), which is how it proves it is not a window feature.
3. **`scene/mask-authority.js`** — `layersForItem` should stop refusing anything but `'levelBackground'` (`keyhole-mask-any-item-decision`, LOCKED), for the future tile-attached case (§7.4 item 3 in the original draft — a placed building tile carrying its own light cookies). Not needed by tier 0, which only reads level-background floors, same as specular's own current scope.
4. **`graph/passes.js`** — `light.accumulate`'s note should gain the window terms (prose only — the pass was already `live` and already absorbs `WindowLightEffectV2`; no new pass entry, no new declared resource).
5. **`src/vt/vt-pan-viewer.js` / `src/boot.js` / `src/diag/effect-status-reports.js`** — wired **DONE**: the two mask seams, the render-state seam, the subsystem construction, the `runLightAccumulatePass` render call (ADD, right after the point-light MAX-blend), dispose, the diagnostics getter, the debug panel, the status report. Same touch points specular's own tier 0 landing used.
6. **Nothing of V2's shape survives.** No emit RT, no shadow-lift RT, no `_floorEmitCache`, no blit, no `WINDOW_ILLUM_SCALE`, no two-threshold disagreement, no `outdoorsClip` timers, no per-effect tone shoulder, no per-effect grade.

### 7.5 The params, in the author's language

**Two shipped for tier 0**, against V2's ninety-eight. Each arrives **with its consumer** — `params/no-dead-controls` fails the build on a key nothing reads, and it fired on exactly that during the specular build; the rest of this table is the FULL fourteen-control target once every rung lands, not what exists today. FOH/ROH per `feedback_foh_roh_must_differ` (would they touch it mid-session, or only while tuning?).

| Control | Category | FOH? | Status | Tier | What it is |
| --- | --- | --- | --- | --- | --- |
| Window light | Look | **✓** | ✅ | 0 | Master strength of every cookie on the map. |
| Patch contrast | Look | **✓** | ✅ | 0 | Gamma on the painted falloff — how hard-edged the cookies read. |
| Sunlight | Daylight | **✓** | | 1 | Strength of the sharp warm patch — the direct sun coming through. |
| Skylight | Daylight | **✓** | | 1 | Strength of the soft cool patch that **survives cloud**. Deliberately front-of-house and deliberately not zero: this is the term whose absence is invisible until you know to look for it (`Specular.md` §10.8 cost a whole build to that exact lesson). |
| Cloud shadows | Weather | **✓** | | 4 | How deeply a passing cloud kills the sunlight. 0 = clear skies always. |
| Cloud size | Weather | | | 4 | How big the cloud masses are, in grid squares. |
| Cloud speed | Weather | | | 4 | How fast they cross. Adds to the scene's own wind. |
| Softness split | Look | | | 1 | How much flatter the skylight term reads than the sunlight term. This is what makes a cloud change the light's *character* and not just its level. |
| Painted for hour | Daylight | | | 2 | What time of day the cookies were painted for. The patch sits exactly where you drew it at this hour. |
| Drift | Daylight | | | 2 | How far the patch slides as the hours pass. 0 = never moves. |
| Moonlight | Night | | | 3 | Strength of the cold pool the same cookie makes at night. |
| Stretch | Daylight | | | 6 | How much a low sun elongates each patch. |
| Bounce | Look | | | 7 | Soft warm indirect spill into the room around each patch. |
| Shaft | Atmosphere | | | 8 | The visible fan of light in the air. |

---

## 8. THE TRAPS

| Trap | Where it bites here |
| --- | --- |
| `feedback_measure_the_output_not_the_equation` | **The one that has already cost this project twice**, and specular shipped invisible *twice* on it. `window-drive.js` gets a CPU twin and a Node suite asserting **brightness bands in the units the screen uses**, at clear noon / clear dusk / broken cloud / overcast / night — plus the two assertions no static test thinks to make: **the patch must MOVE** (monotonic displacement vs. sun elevation) and **the cloud must actually cross** (the field's value at a fixed world point must change monotonically as `t` advances along the wind). A gorgeous still frame is exactly the output that hides a beam that never travels. |
| `feedback_environment_term_gates_wrong_thing` | §3.3. The fill lobe must never sit behind the key's trigger. Symptom if it does: *"the cloud makes the light disappear completely"*, which reads as a tuning problem and is not one. |
| The additive-wash class (`keyhole-water-tsl-design`, `sky-access.js`'s deleted veil) | §3.2. This effect **multiplies**. If a term must add, it is not the light. Three effects have made this mistake in this repo. |
| `feedback_count_silent_preconditions` | §2.5. Do not re-gate the cookie on `_Outdoors`. Specular reached thirteen silent preconditions before anyone counted; this one starts with two (floor, presence) and should stay there. |
| `feedback_one_byte_two_quantities` | §3.1. Level (value) and tint (hue/sat) stay separate. Presence is a threshold at the bottom of value, never a product with it. |
| `feedback_y_flip_recurring_risk` | Two new mappings, and the dangerous one is **the drift offset** — a Y-flipped drift does not look broken, it looks like a plausible sunbeam moving the wrong way through the day, which nobody catches from a screenshot. Assert against the sun shadow's own throw: same sun, same direction, one derivation. |
| `feedback_unconsumed_api_rots_silently` | §5.1 delegates direction and throw rather than re-deriving them, **and then a test asserts the relationship** — because prose claiming two derivations agree is not a mechanism, which is exactly how `sky-access.js`'s `dirX` stayed 90° wrong for its whole life. |
| `env/one-sun` | §4.4. The cloud field is shared or it is a second weather system. |
| `feedback_probed_constants_vs_derived` | §4.2's `depth(c) = 4c(1−c)` is **derived**, not voted on at runtime, and the clear-sky no-op is exact rather than epsilon-close. |
| `keyhole-tsl-constructs-in-node` | **Call the builders in the Node suite.** `three.webgpu.js` imports under plain Node; a TDZ crash shipped once with 4,460 green assertions because nothing invoked the builder. |
| `reference_tsl_method_chaining_trap` | `a.mix(b, t)` compiles to `mix(b, t, a)` **silently**. Function form only. §3.3 is nothing but mixes. |
| `reference_tsl_fn_deferred_execution_trap` | `Fn(cb)()` is deferred; a closure var set inside is unset on the next line. Use `TSL.output`. |
| `feedback_doubleside_invisible_to_status_reports` | Every cookie quad needs `side: DoubleSide` or it culls silently while every JS field reports healthy. |
| `keyhole-mask-any-item-decision` (LOCKED) | §7.4 item 3. Do not repeat the levelBackground-only narrowing water, fluid and specular all shipped. |
| Law 4 | Tiers are JS `if`s at graph-build time. A `uniform(0)` is not off. |
| Law 6 | Bounded quads cropped to the cookie AABB. V2's 4096² emit target **is** the violation this design deletes. |
| Law 8 | `mx_fractal_noise_float` for the cloud field — one TSL source, no hand-rolled hash, no WebGL2 twin. |

---

## 9. WHAT THIS DELIBERATELY DOES NOT DO

- **No procedural window geometry.** No aperture detection, no jump flood, no beam projection, no sill heights, no "which side is outside". The author paints the light; deriving what they already drew would be strictly worse and it is the bulk of what §10 removed.
- **No new mask.** `_Window` carries the shape, the colour and the falloff.
- **No second light system.** The window is a light inside `light.accumulate`, and gets shadows, coloration, bloom and the grade for free.
- **No per-effect COLOUR GRADE, no time-of-day anchors.** One sun, one grade — exposure/saturation/tint and V2's 8-anchor stack both go, and stay gone. ⚠️ This is narrower than it first reads: it rules out re-grading the SCENE, not shaping this ONE light's own energy curve. §11 records why a bounded curve on the cookie's own contribution turned out to be necessary, and why that is not the same thing.
- **No rain-on-glass.** Nine controls, and it would wobble the shape of sunlight on a floor. `surface.response` or particles.
- **No `_Specular` read.** Cross-effect mask reach with no declared edge; four samplers deleted.
- **No screen-space emit target.** The 4096² buffer is **deleted**, not resized, and its half-float / resolution-scale escape hatches go with it.
- **No cloud DRAWING.** §4 produces the shadow on the ground, which is what the goal asks for. Clouds visible overhead are a separate effect, and when it arrives it must read the same field (§4.4) rather than growing a second one.
- **No real volumetrics.** Tier 8's shaft is an honest 2D fake; there is no third axis to march.

---

## 10. WHAT THE FIRST DRAFT OF THIS DOCUMENT GOT WRONG

Recorded rather than quietly overwritten, because the error is instructive and its shape recurs.

The v1 draft read `_Window` as **an aperture** — a hole in a wall — and built accordingly: a jump-flood distance-and-normal pack, a connected-component aperture table with outward normals, a projected patch quad per window (`sillHeight/tan(el)`, sheared and stretched), a two-way valve deciding whether light flowed in or out, an exterior night-time glow pool, and an open question about which side of each wall faced outdoors. Ten rungs, most of them geometry.

**Every one of those exists to compute where the light lands — and the author paints where the light lands.** The design was solving, at considerable expense, a problem that had already been solved upstream by a human with better judgement than any derivation would have.

Two claims in v1 were also simply wrong under the true semantic, and both are corrected above rather than deleted:

1. **"The outdoors clip killed the exterior half."** With an interior-only mask, `winLights *= (1 − isOutdoor)` is approximately correct. It is redundant and can only subtract (§2.5) — a real but far smaller finding than the one claimed.
2. **"V2's noon anchor is physically inverted."** That depended on reading the mask as a vertical aperture, where `1/tan(el) → 0` at zenith. For a painted floor cookie, maximum sun at noon is defensible. The anchors' actual fault is that they are a hand-drawn second copy of a curve the engine computes (§2.1), which is the stronger objection anyway.

The lesson generalises past this effect, and it is worth carrying into the next Stage 6 port: **read the mask's authored MEANING before designing what reads it.** `keyhole-stage6-effects-approach` says redesign rather than mechanically port — and a redesign aimed at the wrong noun is more expensive than the port would have been, because it looks principled all the way down.

---

## 11. WHAT SHIPPED WASHED OUT, AND WHAT THE FORMULA SAID

Found live, on a real scene, from a screenshot: an observatory tower, a large round skylight room floored in a gold-and-blue astronomical mosaic. The whole room read as a flat, textureless white disc — the mosaic's own wagon-wheel tracery gone entirely, not merely brightened. Reported directly: the result was "milky white" / "washed out," not "a bit too bright."

### 11.1 The cause, traced through the real formula rather than guessed

`effects/lighting/environmental-light.js`'s composite is, verbatim:

```
litSrgb  = OETF(albedo) × illum
litLinear = EOTF(litSrgb)
```

(`feedback_gamma_space_composite_arithmetic`). Illum **multiplies** the gamma-encoded albedo, so any channel where `OETF(albedo) × illum` crosses 1.0 clips to flat white — and it clips **flatly**: two texels whose painted brightness differed (a tracery spoke vs. its neighbouring pane) both land on the identical white once both cross the ceiling, so the relative detail that makes the shape *readable* is exactly what is lost, not just its peak brightness.

Tier 0 shipped with **no ceiling at all** on the cookie's own contribution: `illum += level × tint × strength × coverage`, unbounded, capable of adding up to `strength` (default 1, slider range 0–3) on top of whatever ambient the room already had. Bright architectural art — pale stone, gold trim, a parchment-coloured mosaic — commonly sits at `OETF(albedo) ≈ 0.8–0.95`, which leaves almost no headroom: **an unbounded add blows out the instant the pre-existing ambient is anywhere above "quite dark."** A large cookie covering an entire domed room (as this one did — the whole floor was one painted skylight, not a small beam) pushes that outcome from "possible" to "certain."

### 11.2 The fix, and why it lives in this effect rather than in the shared composite

The shared composite (`environmental-light.js`) is load-bearing for every light in the renderer and carries a "byte-identical to Foundry at noon" invariant; changing IT to add general highlight compression would be a much larger, riskier edit than this effect's own scope, and was not asked for. Instead, `window-cookie.js#shoulderedContribution` shapes **this light's own energy curve** before it ever reaches the shared buffer — a Reinhard-style soft shoulder (`x / (1 + x·K)`, `K = 0.8`, `window-cookie.js#WINDOW_SHOULDER_K`) applied to the contribution's **peak channel**, with all three channels rescaled by the same ratio so hue and saturation survive compression (shaping each channel independently would desaturate a saturated cookie exactly where it is brightest — the compression curve's slope shrinks as its input grows, and unevenly-saturated channels sit at different points on that shrinking slope).

⚠️ **This is not the "no per-effect tonemap" rule from §9 being broken** — that rule forbids re-implementing exposure/saturation/tint/time-of-day on the whole scene a second time. A bounded curve on one light's own maximum output is the same category of thing `point-light-illumination.js` already does to its own falloff (`easeAttenuation`, its presence envelope) — an energy shape belonging to the light, not a grade belonging to the picture. It is also, not coincidentally, the same INSTINCT V2's own window effect had (`emit / (1 + emit × 0.14)`) — V2's mistake was never having a shoulder at all conceptually wrong, it was applying it *after* an additive spill onto already-composed scene colour (§2.2), the wrong place, not the wrong idea.

### 11.3 What it does and does not guarantee — measured, not assumed

A fully-painted, default-strength cookie (`raw = 1`) now contributes `≈0.556` rather than `1.0` — bright enough to read clearly, with real headroom left before a typical dim-to-moderate interior pushes the total past 1.0. Measured against the actual composite formula (`__tests__/window-cookie.test.mjs`):

| Case | Ambient before this effect | Cookie's own contribution | Composite result |
| --- | --- | --- | --- |
| Typical dim interior, default cookie, pale albedo (0.88) | 0.3 | ≈0.556 (shouldered) | **0.756 — no clip** |
| Bright daylight interior, MAXED strength (3), pale albedo | 0.9 | ≈0.882 (shouldered) vs. 3.0 (unshouldered) | Shouldered overshoots by less than **half** of what the unshouldered version would have |

**The honest limit, stated rather than buried:** this shoulder cannot see how much headroom `buf:scene.illum` already has, because reading the buffer this pass is simultaneously rendering *into* is the exact read-while-write hazard that made `surface.response` a separate, later pass instead of a draw inside `light.accumulate` (`Specular.md`'s own status note). So a cookie sitting on top of an *already* near-maximum ambient can still clip somewhat. The claim is "the overshoot is bounded and the loss of relative detail is far smaller," never "clipping is now impossible here." A headroom-aware version — reading the accumulated illum before adding, the way tier 5 (`occlude`) will eventually need geometry-aware occlusion anyway — is a real future rung, not a same-day fix.

### 11.4 The diagnostic this bought

Channel 7 (`rawLight`) and channel 8 (`final`) are a deliberate pair on the debug picker: the pre-shoulder and post-shoulder contribution, both boosted ×8. If they look nearly identical, the shoulder was never close to engaging. If channel 7 reads much whiter/brighter than channel 8 over a large area, the shoulder is doing real work — which is the picture version of the table above, and the fast way to confirm this fix is actually landing on a given scene rather than trusting the formula a second time (`feedback_measure_the_output_not_the_equation`).

---

_The artist already drew the light. The engine's job is to tell it what time it is, and when the cloud arrives._
