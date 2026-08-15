# SUN SHADOWS — building, overhead and sky-reach as ONE height field

**Status:** **BUILT, 2026-07-24, verify-green (3,940 assertions). NOT YET LIVE-TESTED past the author's first screenshot.** Author's brief quoted in §1; what shipped is §9, the vegetation division is §10, the first-look fixes are §12 (§12.2 revised — the first attempt was insufficient).
**Companions:** `Light-and-Shadow.md` (the doctrine + the V2 autopsy this obeys), `effects/shadow-access.js` (the atmosphere handle this consumes), `Sky.md` (the `_Outdoors` gate this reuses), `Effects-UI.md` (the FOH/ROH card), `Keyhole.md` §4.4.

---

## 0. The answer first, because it is one sentence

> **These are not three shadow systems. They are three answers to ONE question — _"how tall is the thing standing between this ground pixel and the sun?"_ — so they are three PRODUCERS into one occluder height field, consumed by one ray march.**

V2 built three effects (`BuildingShadowsEffectV2` 2,521 lines, `SkyReachShadowsEffectV2` 2,026, `OverheadStampEffectV2` 3,216), each with its own render targets, its own length/softness/smear/penumbra/curve/blur sliders, and its own path through `ShadowManagerV2`'s combine. **Three models of the same physics, tuned against each other.** That is why they could never agree, why overhead was "always a nightmare", and why sky-reach "never worked".

One height field. One march. One receiver gate. Three toggles that pick which producers write into the field — which is exactly the diagnosis instrument the author asked for, and it costs nothing because the producers were already separable.

---

## 1. The brief

> _"Shadows, particularly outdoors ones. We need to combine together about three things, building shadows, overhead shadows and sky reach shadows into a single system… Overhead shadows is an extension onto building shadows, if a tile has a positive elevation for that floor then it's an overhead tile and the parts of it which are in the white part of `_Outdoors` should be included into the building shadow so that protruding elements of the exteriors of buildings are part of that building shadow. This used to work but because of the nature of V2 it became a nightmare and eventually broke. And finally 'Sky Reach' shadows… we look at the albedo pass for all floors and try and determine if a piece of albedo on an upper floor would be casting a shadow on a lower floor… The combination of these three shadows should only appear outdoors (the white part of `_Outdoors`), should be smeared, their shadow length, offset and softness should all be driven through the same system… I haven't seen any evidence of sky reach working yet."_

Every clause maps to exactly one thing below, and the last clause has a specific, verified cause (§2).

---

## 2. ⚠️ THE BLOCKER — sky-reach has no caster data, right now, on every scene

**`coverAbove` is all-zero on every floor today, and has been since the streaming engine was retired.** Verified by reading the code path end to end, not inferred:

1. `scene/mask-catalog.js#extractionPlanForLayer('albedo')` correctly asks for the alpha channel — the plan is fine.
2. `scene/mask-authority.js#ingestDecodedPage` only ever fires from `vt-pan-viewer.js`'s pack-decode loop (the `onPageDecoded` ingest seam, ~line 7148).
3. That loop runs once per **pack**. `buildPack` has exactly **one** call site in the whole file — `loadExtraLayerPacks` (line 5200) — and it iterates `extraLayersForItem(item)`, i.e. the **mask** descriptors.
4. `ensureItemLoaded` says so in its own comment: _"there is no albedo pack any more"_ (line ~5237). Whole-image mode decodes the albedo directly into a BC-compressed texture and never builds a pack for it.

So no page ever reaches the ingest seam with `layerName === 'albedo'`; `scene.ingests` never gets an `${itemId}/albedo` entry; `recomputeIfDirty` passes `alpha: null` for **every** item; `compositeItemMax` is never called for cover; `coverAbove` stays zero-filled and `skyReach` collapses to `outdoors`.

This is [[feedback_mode_forks_silently_drop_features]] again — the same class as the `_Outdoors` masks never loading in whole-image mode (found and fixed 2026-07-22, one door over from this one). The derivation is correct; its input was cut off by a mode fork.

**The instrument already knows.** `mask-authority.getReport()` exposes `derived.coverAbovePct` and `derived.completeness.missingItemIds` per floor. **Falsifiable prediction the author can check before a line is written:** open Diagnostics → "Mask authority" and every floor will show `coverAbovePct: 0` with `missingItemIds` listing every item on the map. If it does not, this section is wrong and Phase 0 changes.

**Why this matters for the plan:** sky-reach cannot be built on top of a signal that is structurally zero. Phase 0 is not optional groundwork, it is the feature's missing input.

---

## 3. The model

### 3.1 One height field

Per floor, one small scene-space grid — the mask authority's existing grid machinery, extended with one new derived product. RGBA8, uploaded as a `DataTexture` exactly the way `bakeOutdoorsTexture` already uploads `_Outdoors`:

| Channel | Producer | Height comes from |
| --- | --- | --- |
| **R** | **Building** | `(1 − outdoors)` × `buildingHeightPx`. The dark of `_Outdoors` IS the building footprint — the author's own paintbrush, already required, already ingested. |
| **G** | **Overhead** | Items on THIS floor with `bottom < elevation < ceiling`, `alpha × (elevation − floorBottom) × distancePixels`. A balcony at +5ft and a chimney at +30ft get genuinely different throws, for free. |
| **B** | **Sky-reach** | Items at/above this floor's ceiling, `alpha × (thatElevation − floorBottom) × distancePixels`. The bridge deck on floor 1 casts onto floor 0; the roofs on floor 2 cast onto both. Transparent holes in upper-floor art are literally holes in this channel — light falls through, no special case. |
| **A** | **Receiver gate** | The floor's raw `outdoors` value. Sampled by the same fetch as the heights, so "only on the white of `_Outdoors`" costs one multiply. |

Heights are stored as a byte over one `uHeightScalePx` uniform (the scene's tallest caster, computed at bake). MAX-combine within a channel, `max(R,G,B)` at march time.

**The threshold rules are already written and already tested.** `mask-derive.js#deriveFloorProducts` uses `item.elevation >= floor.ceilingElevation` for cover, verified against the live drawList (roof at 10, upstairs ground at 10, both over a floor-9 rug that must NOT count). Overhead is the complementary band on the same axis. Nothing new to get wrong here — one new arithmetic term inside a loop that already iterates the right item set.

### 3.2 One march

The march is the only genuinely new GPU code. For each texel of the shadow field, in **world** space:

```
toSun   = −shadowOffsetDirection(azimuth)        // world XY, +y down (Foundry canvas)
tanElev = tan(elevation)
vis     = 1
for i in 1..N:
    d         = i * stepPx
    rayHeight = d * tanElev                       // the sun ray's height at that distance
    h         = max(R,G,B) at (worldPos + toSun*d) * uHeightScalePx
    over      = h − rayHeight
    if over > 0: vis = min(vis, 1 − smoothstep(0, penumbra(d), over) * strength)
vis = mix(1, vis, receiverGate)                   // A channel: outdoors only
```

Four consequences, all of them things V2 needed separate sliders for:

- **"Smeared"** is what a march *is* — the shadow is the union of every blocked step, so it stretches from the caster's foot to its tip rather than being a stamped copy.
- **Length** is `height / tan(elevation)`, emergent. Dawn and dusk elongate for free; noon collapses to nothing. **There is no length slider.**
- **Softness contact-hardens**: `penumbra(d)` grows with distance from the caster, so the shadow is crisp where it touches the wall and diffuse at its tip. That is real penumbra behaviour, and it is one line rather than V2's `softness` + `penumbra` + `shadowCurve` + `blurRadius` + `smear` fighting each other.
- **The three heights coexist in one march.** A balcony's short shadow and a bridge's long one are the same loop reading different bytes. This is the structural reason the three systems collapse into one.

`penumbra(d)`, `strength` and the direction all come from `createShadowHandle(...).forCaster(...)` — cloud softening, night fading, dawn elongation, all of it, shared with vegetation and every future caster. **This system adds zero atmospheric knobs.** (`shadow-access.js` §"A caster declares exactly TWO things".)

### 3.3 Scene-space, not screen-space — the structural win

The field is **world-aligned and camera-independent**. Pan and zoom cost nothing; the bake runs only when something that actually changes the shadows changes:

- the sun moves past a quantization step (`sunQuantizeDeg`, default 0.5° — V2 had the same idea at `BUILDING_SHADOW_SUN_EPS_DEG = 0.1` and it was right);
- the mask-authority version moves (the poll that already triggers a wind rebake);
- the floor changes;
- a param changes.

V2 re-marched a view-aligned target **every frame** through five stages owned by three other systems. This marches once per sun step into a texture the illum pass samples with the mapping it already has.

Size: `SHADOW_FIELD_MAX_DIM = 1024` at Tier 0 (4 MB RGBA8), 2048 at Tier 3. Both are under the allocator's 2048 world-res cap and are O(1) in map size, not O(world) — no `allowWorldScale` flag, no exception to argue for.

### 3.4 Where the answer lands — and the one thing not to "unify"

`light.visibility` finally graduates from seam to live and creates `buf:scene.vis`. `runLightAccumulatePass`'s **ambient fill** (`illumQuad`) multiplies by the sampled visibility, using `buildOutdoorsGate`'s screen→world→texture mapping (shared, not copied — a second inline copy is how two gates end up covering different halves of the map). Point lights then MAX on top exactly as today: **a torch in a building's shadow lights the ground, with no lift, because the shadow only ever gated the sun.** That invariant is already Node-tested as `composeSunTermWithMaxLight`.

⚠️ **Do NOT move this multiply after the lights.** The UI-window shadow deliberately multiplies in the *composite*, after the lights (Light-and-Shadow.md §5.6 v2) — because it is a fake workspace key over everything, and MAXing lights against a flat decorative floor creased. The sun shadow is the opposite case: it gates **one** light, so it belongs on that light's own fill, before the others accumulate. A future session "unifying the two shadow multiplies" would silently reintroduce the lift bug in mirror image — a torch inside a building shadow would go *dimmer*. Both placements are correct for their own light; that is the whole doctrine.

---

## 4. What the author touches

Per `shadow-access.js`'s contract, a caster declares a height and nothing else. Overhead and sky-reach heights come from **Foundry's own elevation data**, so they are physical and sliderless. Building height has no Foundry source, so it gets exactly one number.

**FOH (5 controls):** Enable · Strength · Building height · Softness bias · Quality.

**ROH, by category:**

| Category | Params |
| --- | --- |
| Presence | (the enable toggle) |
| Look | `strength01`, `buildingHeightPx` (default ≈ 3 grid units × `distancePixels` — one storey), `softnessBias` (a ×0.25…×4 nudge on the handle's penumbra, **not** a second softness model) |
| Technical | `fieldResolution` (512/1024/2048), `marchSteps` (16/32/64), `sunQuantizeDeg`, `rebakeThrottleMs` |
| Technical (isolation) | `showBuilding`, `showOverhead`, `showSkyReach` — three independent bools, all default **true** |

Nine params total, replacing V2's ~30 across three effects. There is deliberately **no** length, offset, smear, penumbra, shadow-curve, blur, resolution-scale or per-source opacity knob — every one of those was a symptom of not having one model.

**The isolation toggles are CPU-side, at bake time**, not shader uniforms. Turning off sky-reach means the B channel is not written — the contribution genuinely does not exist, rather than being multiplied by a zero that still costs a fetch and a branch every texel. That satisfies `tsl/no-uniform-gates` (no `uEnable*`/`uUse*`/`uHas*` may appear) without a live material rebuild, and a rebake is ~1 MB of memcpy on a click.

---

## 5. Phases

Each phase ends somewhere shippable and independently verifiable. Nothing after Phase 0 is blocked on the author's eyes except the look tuning.

**Phase 0 — restore the albedo-alpha ingest (§2). The blocker.**
`bc-compress.worker.js` already makes a **full pass over every alpha byte** to compute `alphaStats` (its own comment: _"FULL pass (no early exit), because this is also where alphaStats comes from"_). Accumulate a ≤512² box-averaged alpha grid in that same loop and return it beside `alphaStats`; `compressed-textures.js` forwards it; `vt-pan-viewer.js` hands it to a new `maskAuthority.ingestItemAlpha(itemId, grid, placement)` door. Zero extra network, zero extra decode, and it caches in IndexedDB alongside the existing record (the worker already has precedent for a cache-format bump — its own "v3" note).
*Done when:* the mask-authority report shows non-zero `coverAbovePct` on a multi-floor scene and `missingItemIds` empties. This alone fixes rain-under-a-bridge and every other silently-dead `coverAbove` consumer.

**Phase 1 — the height field, CPU and pure.**
Extend `mask-derive.js` with a `casterHeight` product (new `DERIVED_KINDS` entry, `inputs: ['albedo','outdoors']`) and give `DeriveFloorInput` a `bottomElevation` from `scene-layers.js#levelElevation`. Node-tested on fixtures: a tile at +5 writes G and not B; an item above the ceiling writes B and not G; a `+Infinity` ceiling writes no B at all and says so in `completeness` rather than inventing a number; hidden items write nothing.
*Done when:* the Node suite is green and the report shows a per-channel height mean/max per floor.

**Phase 2 — the march, Tier 0 (building only).**
`effects/lighting/sun-occlusion.js` (pure: step sizing, sun quantization, byte↔px packing, plus a scalar reference march the tests pin) + `sun-occlusion-render.js` (TSL: the bake material, browser-only, the split every effect here uses). `light.visibility` flips seam→live, `creates: ['buf:scene.vis']`, `light.accumulate` gains the read, `graph/__tests__/pass-declarations.test.mjs`'s "still a seam" assertion updates. Wire the illum multiply.
*Done when:* a building throws a shadow onto the outdoor courtyard beside it, only on the white of `_Outdoors`, and it swings with `MapShine.setSunHour()`.

**Phase 3 — overhead (G) and sky-reach (B) light up.**
No new pass. Two more channels in a field the march already reads. The bridge scene is the acceptance case: standing on floor 0, the deck above throws a long soft shadow across the ground; its gaps let sun through.

**Phase 4 — registration, panel, instruments.**
`effects/sun-shadows.js` manifest + params (the `ui-window-shadow.js` shape), `registerPanel` + `buildEffectCard`, the status report, pixel-probe channels.

**Deferred rungs (recorded, not built):** a painted `_Height` mask so a GM can author per-building heights instead of one global; the authored `_Shadow` mask min-combined in as the highest-authority producer (one extra `min` once `buf:scene.vis` exists — the paintbrush finally promoted to canon, per Light-and-Shadow.md §4.2); lightning reusing the same field from a different direction (V2 got this free too, and it was the one thing it got right).

**⚠️ Cloud is NOT a fourth producer into this bake** — corrected 2026-08-01 after this line was written. This field only rebakes when the sun crosses a quantization step, a few times a minute, while clouds drift continuously; baking them would make them visibly jump. Cloud cover combines separately at the **read site** instead — `effects/shadow-access.js`'s `shadowAtmosphere()`. Full ruling: `Clouds.md` §4.1.

---

## 6. Instruments — non-negotiable

A shadow system that renders nothing must **say** it rendered nothing ([[feedback_instruments_must_not_lie]]; sky-reach's whole V2 history is a system that failed silently through five stages nobody could inspect).

A **"Sun shadows"** status report, pasteable, answering "why is it not working" without the console:

- per producer: has real data / empty / disabled-by-isolation-toggle;
- per floor: height-field mean + max per channel, `missingItemIds` count, ceiling elevation (so a `+Infinity` is visible, not mysterious);
- the bake: last reason (`sun` / `mask` / `floor` / `param`), age in frames, field resolution, step count, the quantized sun actually used vs the live one;
- an explicit **"caster field is empty"** line when every channel is zero.

Plus: the three ROH isolation toggles, and the pixel probe gaining the three caster channels + the final visibility at the clicked pixel — so "is the shadow missing or is the caster missing?" is one click, not a guess.

---

## 7. Traps, named in advance

1. **Y-flip** ([[feedback_y_flip_recurring_risk]] — it bit the UI-shadow twice). Three spaces already agree and it is *derived*, not hoped: `quadUvToWorld` has no flip, `MaskGrid` row 0 = minY, `DataTexture` defaults `flipY:false`. Reuse `buildOutdoorsGate`; do not hand-roll a fourth mapping. `shadowOffsetDirection` is documented in **screen** space (+y down) — Foundry world space is *also* +y down, so it transfers unchanged, but assert that in a test rather than trusting this sentence.
2. **Elevation is in scene distance units, not pixels.** Convert through `readGridDistancePixels()` (`foundry/scene-occlusion-sources.js`, already the one door). A hardcoded 100 is a wrong answer on any non-default grid.
3. **`+Infinity` ceilings.** `floorCeilings` returns `Infinity` for a level with no declared top — nothing counts as above, sky-reach is legitimately empty. Report it; never substitute a number.
4. **A continuously-animated sun turns "rebake on change" into "rebake every frame."** The quantization step is what stops that, and the Astrolabe/day-clock work makes it a live risk rather than a theoretical one. Assert the quantizer in a Node test.
5. **[[feedback_residency_sync_vs_render_loop]]** — the rebake trigger belongs in the frame loop / version poll, never inside a residency-triggered function. This bit vegetation on 2026-07-23; the author's note was that "a lot of things" may share it. Do not add another.
6. **Walls that will fire if this is written carelessly:** `shadow/no-lift-no-combine` (never a `*CombinedShadow*` or `*ShadowLift*` identifier — and the wall scans string literals, not just code); `tsl/no-uniform-gates` (§4); `gpu/allocator-only` (the field goes through `allocator.create`, never `new RenderTarget`); `masks/authority-only` (`_Outdoors` as a literal belongs only in the catalog).
7. **Resolution honesty.** The caster's real detail is bounded by the ingested alpha grid, not by the field the march writes into. At 512² per item over a 16K map that is ~31 px per texel — fine for a smeared shadow, visibly soft at the contact edge. If the author wants crisper contact, the lever is Phase 0's grid size, not the march. Say that in the report rather than letting them chase the wrong slider.

---

## 8. Cost

One bake per sun step: `fieldTexels × marchSteps` texture fetches. At Tier 0 (1024², 32 steps) that is ~34 M samples of a tiny cached texture — a few milliseconds on a mid GPU, **not per frame**. Steady-state per-frame cost is one extra texture fetch inside a fullscreen pass that already runs. The Effect Performance Lab measures it; the profile gate starts conservative and walks down as measurements come in, the same way `uiWindowShadow`'s `enabledFromProfile` is meant to.

---

---

## 9. WHAT SHIPPED (2026-07-24)

Built in one pass, verify-green, **not yet live-tested**. Files, in dependency order:

| File | What it is |
| --- | --- |
| `vt/coarse-alpha.js` + `bc-compress.worker.js` (`mode:'alphaGrid'`) + `compressed-textures.js#requestCoarseAlphaGrid` | **Phase 0** — the repair. The worker decodes each item DIRECTLY at ≤512 texels a side (`createImageBitmap`'s own `resizeWidth`), so the readback is ~1 MB instead of 576 MB, and caches it under its own `alpha:v1:` key. |
| `scene/mask-authority.js#ingestItemAlpha` | The new door art opacity arrives through. Its own door rather than more `ingestDecodedPage`, because a page-shaped API cannot be fed by a path that has no pages — which is exactly how the gap survived an engine retirement. |
| `scene/mask-derive.js` (`casterHeight` + `casterChannels`) | The three bands on one elevation axis. Node-tested: a balcony lands in overhead and not sky-reach, a roof the reverse, an item at a floor's own ground casts nothing on it, an unknown ground reports `null` rather than 0. |
| `scene/sky-reach-access.js` | **The service** (§10.1). |
| `effects/lighting/sun-occlusion.js` | The march's maths — 46 assertions, all four quadrants of the direction, the rebake quantiser, the edge ramp. |
| `effects/lighting/sun-occlusion-render.js` | Its TSL: the bake material and the one-fetch read node. |
| `effects/sun-shadows.js` + boot registration/panel/report | Nine params, the FOH/ROH card, `MapShine.setSunShadows`, and the **"Sun shadows"** status report. |
| `effects/lighting/environmental-light.js` | The multiply — on the AMBIENT FILL, before the lights (§3.4). |

**What did NOT happen: `light.visibility` stayed a seam.** The plan said this feature would graduate it. It should not have, and `passes.js` now says why: the field is world-aligned and camera-independent, so a per-frame screen-space `buf:scene.vis` would be strictly more work for an identical picture. It earns its keep when a SECOND light needs its own visibility term, not before. A seam that names what exists beats a `live` describing a buffer nobody writes.

**The author's light-priority model, confirmed and encoded.** Their words: _"passive light is the sunlight which cannot overpower these shadows because it's the light that produces these shadows, then 'active' lights are ones brought in afterwards which overpower these shadows."_ That is `illum = max(ambient × sunVis, pointLights)` exactly — already the doctrine, already Node-tested as `composeSunTermWithMaxLight`, and now the placement rule written at the top of `sun-occlusion-render.js` so nobody "unifies" it with the UI-window shadow and rebuilds the lift backwards.

---

## 10. VEGETATION — the division of labour

The author asked for a plan for how this integrates with vegetation shadows. It is a **division**, not a merge, and the line is resolution.

### 10.1 What they SHARE (already, in code)

- **The sky.** Both read `effects/shadow-access.js` — one azimuth, one elevation, one cloud/night softening. Neither declares a sun.
- **The throw compression** (§10.2) — `softenThrowPx` + `maxThrowForHeightPx` live in the shared modules, so the fix the author asked for on trees applies to any future caster automatically.
- **The map-edge ramp** — `edgeRamp01`, one function, used by the vegetation sync (scaling the throw) and by the bake shader (scaling the strength).
- **The smear concept** — a shadow is the union of its caster's silhouette along the throw. The march does it by ray; vegetation does it by texture sweep. Same idea, two fetch strategies, like the wind handle's `node`/`kernel`/`cpuAt` split.
- **The sky-reach service** — `scene/sky-reach-access.js` is the one door for "what is between this point and the open sky?", and it is the door rain will use too.

### 10.2 What vegetation does NOT do — and must not start doing

**A tree must never become a producer into the caster height field.** It is tempting (a tree IS a caster of height 70px) and it would be wrong: the field is ≤512 texels a side, roughly 31 world px per texel on a big map. A tree's whole canopy is a handful of texels there. Its shadow would be a blob, and worse, it would be a blob that **cannot move with the wind** — the field is baked a few times a minute, while a canopy sways every frame.

So the rule, stated so a later session does not "unify" these either:

> **The height field is for ARCHITECTURE — things that do not move and are hundreds of pixels across. The twin-mesh shadow is for VEGETATION — things that move every frame and are resolved at their own art's resolution.**

They compose correctly without knowing about each other: the sun shadow multiplies the ambient fill, and a vegetation shadow is an alpha-blended darken drawn over the ground. A tree standing in a building's shadow is already dark, and its own shadow adds little on top — which is what a real shadow inside a shadow does.

### 10.3 The three live vegetation defects, fixed

All three from the author's 2026-07-24 report, all verified green, **none live-confirmed**:

1. **"The shadows move but they don't smear."** The old shadow was the canopy mesh bodily translated by the throw — a detached duplicate that slid around, and whose own plant's feet were never in shadow at all. Now the mesh is **not translated**; it is padded by the caster's maximum possible throw and the fragment **sweeps** the silhouette from `t=0` (the ground contact, directly under the plant) to `t=1` (the tip), MAX-combining. The pad is a per-KIND constant (`vegetationShadowPadPx`), so no geometry is ever rebuilt as the sun moves. The tip tapers as the sun lowers; the foot never does.
2. **"Too far away from their producers at dawn and dusk."** `height / tan(elevation)` runs away as the sun nears the horizon, and the handle's own cap was 4096 px — no bound in practice. Now the throw passes through a saturating knee (`softenThrowPx`) against a **height-relative** ceiling (`MAX_THROW_HEIGHT_RATIO = 5`). A knee rather than a `min()` on purpose: a hard clamp makes every tall caster's shadow land at the *same* distance for the last hour of daylight, so the whole scene's shadows snap into a line and stop moving. Height-relative rather than a flat pixel cap on purpose: a flat cap makes a bush and a cathedral throw the same distance, destroying the one cue that says how tall things are.
3. **The map-edge gap.** The author's own suggested cure, taken literally: near the boundary the throw is scaled toward zero (`edgeRamp01`, evaluated at the tile's CENTRE so a plant is never torn in half by the ramp), so an edge plant parks its shadow under itself instead of sliding it off the map. The bake shader ramps the shadow STRENGTH over the same band for the same reason. The underlying cause is unfixable at source — a caster outside the scene rect exists in no data we have — so the goal is a boundary that reads as haze rather than as a straight line where shadows stop.

---

## 12. THE FIRST-LOOK FIXES (2026-07-24, author's first screenshot)

Three defects, all traced to a real line of code rather than guessed, all verify-green.

### 12.1 The bright halo hugging every building

**Report:** *"Building shadows have a brighter area next to the actual building currently. The shadow should be strongest next to the building and brighter as you move away."*

**Root cause, confirmed by reading the chain, not assumed:** the receiver gate (`vis = 1 − occlusion·strength·GATE·ramp`) is the `_Outdoors` mask read at the caster field's own coarse resolution (≤512 texels a side). A wall's true, crisp boundary is smeared across roughly one grid texel by the grid's box-filtered downsample plus its linear texture filter. So immediately outside a wall, the field is still reading a *partial* "40% outdoor" value, and that value directly multiplies down the shadow — weakening it exactly where contact-hardening says it should be strongest. A bright halo hugging every building is the visible result.

**Fix:** `sharpenReceiverGate01` (`sun-occlusion.js`) — a `smoothstep(0.12, 0.35, rawGate)` contrast-stretch that collapses the ambiguous middle band: below 12% "outdoor" stays fully suppressed (correctly — nothing needs a cast shadow where the sun never reaches anyway), above 35% snaps to fully receptive. This does **not** touch the shared `_Outdoors` mask (the sky light legitimately wants that same blur for doorway softness) — only how the sun-shadow reads it. One function, shared by the GPU bake and the new CPU point-light sampler (§12.2), so the two can never disagree about where a wall's edge actually is.

### 12.2 Lights deleting the shadow across their whole radius, not fading it in

**Report:** *"Lights overpower the shadow which is good but it has no attenuation, it just deletes all shadows within its dim radius completely."*

**Root cause, confirmed by reading `point-light-illumination.js`, not guessed:** a point light's fragment output is `mix(uBackgroundColor, litColor, falloff)`. `uBackgroundColor` was a flat, scene-wide ambient constant — never reduced by sun-visibility. `falloff` reaches exactly 0 only at the light's *outer* geometric edge, so the light writes *at least* the un-shadowed ambient everywhere inside its full radius. Since that floor is always ≥ the shadowed ambient the sky pass wrote, the GPU's real `MaxEquation` blend (verified, not assumed — `CustomBlending` + `MaxEquation`) picks the light's value across the *entire* dim radius, not a gradient.

This is the exact bug class the project already found and fixed once, for darkness regions instead of sun-shadow — `updatePointLightMeshes`'s own "PER-LIGHT REGION-AWARE AMBIENT" (2026-07-19): a light's floor used to be one shared constant, blind to a region it might be sitting in, so a region's darkening vanished everywhere the light's mesh reached. The fix there was to give each light its own floor, recomputed from its own position, every frame. **This extends that exact, already-proven mechanism to a second darkening source.**

**Fix, attempt 1:** `sampleSunVisibilityAt` (`sun-occlusion.js`) — a CPU point-sample that reuses `marchVisibility` directly (not a second model), reading the same caster-channel grids the GPU bake reads, at 16 steps. `updatePointLightMeshes` calls it once per light per frame and multiplies the result into `uBackgroundColor` only — never into `uDimColor`/`uBrightColor`, preserving *"the torch was never darkened to begin with."*

**⚠️ Attempt 1 was correct but insufficient — the author reported the SAME symptom again, nearly verbatim, after it shipped.** Root cause of the shortfall: `uBackgroundColor` is only what a light's fragment blends *toward* at `falloff = 0`, and Foundry's own attenuation-slider corona (`combinedFalloff`) reaches that value only in a *narrow band right at the mesh's outer edge* — for anything short of a very wide attenuation setting, `combinedFalloff ≈ 1` across MOST of a light's radius (its "bright zone"). So attempt 1's fix was real, but only visible in a sliver near the light's rim; everywhere else the light was — correctly, per the strict `max()` doctrine, but not per what the author actually wanted — still fully overpowering the shadow.

**Fix, attempt 2 (`point-light-illumination.js`, "SUN-SHADOW ATTENUATION"):** a SECOND, WIDE falloff curve, `wideFalloff`, that starts revealing the (shadow-aware) background at `SHADOW_RECOVERY_INNER_DIST = 0.3` — the outer 70% of the radius, not just Foundry's own rim — blended in via a new per-light uniform `uShadowRecoveryWidth` (0..1, set every frame from `1 − sunVisibilityAtThisLight`):

    effectiveFalloff = mix(combinedFalloff, wideFalloff, uShadowRecoveryWidth)

At `uShadowRecoveryWidth = 0` (a light standing in full sun, or the effect disabled) this is *exactly* `combinedFalloff` — a light's look is provably unchanged wherever shadow isn't actually in play, which is what keeps this a fix for the shadow/light *interaction* rather than a global "soften every torch's corona" change nobody asked for. Only a light currently sitting in (or near) a cast shadow gets the wide reveal, widening continuously with how deep in shadow it is — no discontinuity as a light crosses a shadow's boundary. `finalColorExposed` (everything `effectiveFalloff` blends *toward* — the torch's own dim/bright colour) is completely untouched either way, so the doctrine invariant survives unchanged: no shadow shader ever reads a light buffer; this is a light reading the same upstream sun-visibility inputs the shadow bake reads, never the bake's own rendered texture.

### 12.3 Pixel-perfect edges, no diffusion with distance

**Report:** *"The furthest away edge of the shadow could do with being more blurred... the edges of a building shadow are currently pixel perfect lines... blur the shadow to make it more diffuse the further away from the building and to make edges less perfect."*

**Root cause:** the march only ever asked "is *this exact line* toward the sun blocked?" — one ray, one sample per step. `marchPenumbraPx` already softens the *front-back* transition (how gradually a station goes from lit to shadowed as `over` shrinks), but a caster's *silhouette* — its edge perpendicular to the sun — inherited nothing but the coarse field's own native texel blur. Visually near-hard, and constant width regardless of distance from the caster.

**Fix:** the march is now a thin **cone**, not a ray. At each of the 32 distance steps, 3 samples are taken spread perpendicular to the sun direction, by an amount that *grows with distance* (`d × PENUMBRA_PER_PX × softnessMul` — the exact same constant already governing front-back softness, applied to the other axis of the same physical phenomenon: a small light source's angular size blurs a penumbra equally in every direction, not just toward/away from it). Near the wall the cone is narrow (crisp silhouette); far from it the cone has fanned out enough to average across the true edge (soft, diffuse silhouette) — "more diffuse the further away," from one constant, not a second disagreeing blur radius. Cost: 32×3=96 fetches per baked texel instead of 32 — still a bake that runs a few times a minute, not per frame, so the increase is invisible in practice.

### 12.4 What's still unverified

All three are **Node-tested but not live-tested**: §12.1's threshold constants are a first-cut estimate (13% band), §12.2's per-light CPU march assumes the "hundreds of lights" cost is as cheap as the existing region-darkness per-light sampling it mirrors (not yet measured), §12.3's 3-tap spread uses the front-back penumbra rate for the lateral axis on the assumption that's the right physical read (not yet seen on screen). All are cheap to retune (named constants, no architecture to unwind) if the author's eyes say otherwise.

---

## 13. SECOND-LOOK FIXES (2026-07-24, author's live session)

### 13.1 The point-light shadow flip — fixed for real, PER-FRAGMENT

Two earlier attempts (§12.2) sampled sun-visibility once per light, at the light's ORIGIN. A single point is binary — in shadow or not — so the whole light flipped between soft and hard-edged as the shadow's edge swept its origin with a few degrees of sun rotation (the author's "same light, small clock difference, totally different result"). The per-light scalar cannot describe a quantity that varies ACROSS the light.

**Fix:** every point light's material now samples the baked sun-shadow field at `positionWorld.xy` PER-FRAGMENT (`point-light-illumination.js`, sharing `environmental-light.js`'s own `uSunShadowRect` uniform), multiplying its background floor by the visibility at each pixel. The floor is shadowed exactly where the shadow is, and the light's own corona shape is untouched by the sun. `sampleSunVisibilityAt` and the wide-falloff machinery are DELETED. Bonus: this also removes a per-light-per-frame CPU march (16 steps × 3 grids × N lights) that was the likely cause of the reported perf drop.

### 13.2 The length controls (author's #1 ask)

Two knobs, both folded into the ONE effective tangent `resolveSunMarch` computes:
- **Shadow length** (`lengthScale`, default 0.5) — scales every shadow at every hour. Halves them, as asked.
- **Dawn/dusk length** (`dawnDuskLength` = `maxLengthMul`, default 4) — caps the throw at N × the caster's own height, so it only bites at low sun where `1/tan` blows up. The primary dusk-taming control.

### 13.3 Overhead projected outside the building

An overhead tile over INDOOR ground is interior architecture under a roof — the sun never reaches it, so it must not cast. `mask-derive.js` now multiplies the overhead channel by the outdoors value at the caster's own footprint, so only exterior protrusions (balconies over open air) survive. Receiver-gating alone let an interior overhead's shadow leak out past the wall.

### 13.4 Perf + thin detachment (partial)

March steps 32→24, and the length cap shortens the span, so the steps are FINER than before over a shorter distance — fewer samples AND less thin-caster step-aliasing. **Still open:** truly thin projections can still detach into a dashed series; the author has OK'd "a single smooth blurred faint shadow" for these, and the exact treatment is still to be designed (their message was cut off mid-sentence).

---

_Three effects, 7,763 lines, thirty sliders and five combine stages existed because nobody wrote down that a building, a balcony and a bridge are the same question asked at three heights. Write the height down and the three systems are one loop._
