# MSA Owns Vision & Fog — the build plan

**Status:** design + slice 1 in progress. Testament **Pillar 11**.
**Author decision, 2026-08-15:** *"MSA owns vision/fog outright."* Chosen over three
smaller options (force global illumination on; per-pixel darkness handed to Foundry;
per-scene toggle) after three failed attempts to make Foundry's own Global Illumination
grant outdoor daylight vision.

> **Covenant note.** This is `docs/planning/`, not `docs/holy/`. Pillar 11 and its tasks
> already exist in the Testament and are not edited by this document. Worker sessions
> execute those checkboxes and append evidence; they do not add tasks here or there.

---

## 1. The bug that forced this, and why it is the right forcing function

Author's report, three times: *"A token outside at noon can only see a nearby point light,
not the majority of the scene."* A pixel probe on the author's own machine settled it:

| point | MSA `illum` | Foundry's verdict |
| --- | --- | --- |
| 2 — token standing in noon daylight | **0.945** | lit |
| 3 — open ground a little further out | **0.933** | **unrevealed / dark** |

**MSA's own illumination is correct at both points.** The disagreement is entirely inside
Foundry's vision pipeline, whose ambient-daylight gate (`environment.globalLight.enabled`)
is schema-default `false` and — on the author's server, running Rules-Based-Vision PF2e —
reads back `disabled: true` with the untouched factory window `{min:0,max:1}` no matter
what MSA publishes into it.

That is the whole argument for this build in one table. MSA already knows, per pixel, how
bright the world is. Foundry cannot see any of it. Every attempt to translate MSA's
knowledge into the one scalar Foundry exposes is lossy, fights the game system for
ownership of a document field, and still cannot express "this outdoor corner is in deep
shadow". **Owning the render removes the translation entirely.**

## 2. The division of labour — LOCKED, do not relitigate

Locked in an earlier session (memory `keyhole-vision-fog-direction`), re-affirmed here:

- **CONSUME Foundry's vision COMPUTE. Never reimplement it.** Read
  `canvas.effects.visionSources` — each source's `.los` / `.light` / `.shape` are
  `PointSourcePolygon`s with flat `.points` arrays, already computed by Foundry's own
  wall sweep. The vision RULESET (sight ranges, wall sense types, detection modes,
  darkness sources, elevation, and every game system's overrides of them) is Foundry's
  module-compatibility surface. Reimplementing it = perpetual parity chase + broken
  modules. **This is the half that keeps us compatible with any game system**, which is
  the author's standing constraint on this work.
- **OWN the RENDER.** `canvas.visibility.renderable = false` — the same single lever
  already used for `primary` and `effects` — and rasterise the mask ourselves in TSL.
- **OWN the explored-area persistence buffer**, written back through Foundry's own
  `FogExploration` API, throttled, so multiplayer/union/GM-reveal semantics survive.
- **NEVER sample PIXI's rendered fog texture.** MSA's WebGPU canvas and Foundry's
  PIXI/WebGL canvas are separate GPU contexts; sampling across them forces a per-frame
  GPU→CPU→GPU readback — the exact V2 disease. Reading polygon *data* sidesteps it.

## 3. What is NEW in this plan — the illumination join

The locked plan above says "consume Foundry's vision compute". It did not say what decides
**lit**. That is the piece this build adds, and it is what actually fixes the reported bug:

```
revealed(pixel) =
      insideLOS(pixel)                     // Foundry's wall sweep — consumed, never re-derived
  AND ( insideOwnSightRadius(pixel)        // basicSight: illumination-INDEPENDENT by design
        OR msaIllumination(pixel) >= T )   // light perception: MSA's OWN per-pixel brightness
```

Three consequences, all of them things the author asked for:

1. **Outdoor daylight works with no Foundry cooperation at all.** `globalLight.enabled`
   never enters the expression, so PF2e's Rules-Based Vision cannot switch it off.
2. **Dark outdoor areas genuinely stop revealing** — the author's own stated ideal. The
   term is per-pixel MSA illumination, so night, shadow, and an unlit courtyard all
   behave correctly without needing an authored Region.
3. **Authored darkness Regions still work**, because they already darken MSA's own
   illumination. They stop being a *precondition* and become just another input.

⚠️ **`T` is a rules-visible threshold, so it is a parity decision, not a taste knob.**
Foundry's own model is binary (`testInsideLight` → in a light source's polygon or not).
Ours is a brightness comparison, which is strictly richer and therefore *cannot* be a
faithful port at the edges. Start `T` low (just above MSA's darkness floor) so the
common cases match Foundry, expose it, and treat any divergence report as a parity bug.

## 4. Slices, in dependency order

**Slice 1 — the reader.** `foundry/scene-vision.js`: pure derivation + live gatherer for
every active vision source (origin, LOS polygon points, light-perception polygon, sight
radius, blinded state, elevation/level). Node-testable, no rendering. *This slice cannot
break anything — nothing consumes it yet.*

**Slice 2 — the mask render.** Split in two once building started:

- **2a — the RULE. ✅ DONE** (`861f745`), `effects/vision/vision-mask.js`.
  `decideRevealed` is the pure CPU TWIN the shader must match, plus the pool
  reconciliation and a fail-closed gating decision. 33 assertions. Written BEFORE the
  shader deliberately: Law 7 makes this player-facing information, so the rule gets pinned
  in Node where a divergence fails loudly, rather than being discovered by a player seeing
  something they shouldn't.
- **2b — the RASTERISER.** Not started. Fan-triangulate each source's polygons and draw
  into a "currently visible" R8 target, then evaluate `decideRevealed`'s clauses per pixel
  against `buf:scene.illum`.
  - **Reuse, do not reinvent:** `point-light-illumination.js#triangulateLightFan(points,
    ox, oy, radius, outArray)` already fan-triangulates exactly these Foundry polygons
    every frame. Call it with **`radius = 1`** to get plain local-space offsets (it
    divides by radius to reach the light shader's unit-circle space, which the mask does
    not want), and position the mesh at the source origin.
  - **Build it as a self-contained subsystem** (`createVisionMaskSubsystem({THREE,
    allocator, …})` with `update()`/`dispose()`), matching water/lightning. That keeps the
    `vt-pan-viewer.js` touch down to a few lines — worth insisting on, because that file
    is a ~15k-line god object the author edits concurrently, and hunk-level collisions
    there are a recorded hazard (`feedback_git_staging_hazard`).
  - **Verification needs a controlled token** — the bench ships none;
    `tests/playwright/msa-token-vision-noon.spec.js` already creates and controls one.

**Slice 3 — explored persistence. ✅ BUILT (in-session).** A world-space 2048²
accumulation buffer, MAX-blended from the same fan scene through an ortho camera over the
**scene** rect (not the padded canvas), never cleared except on a real scene change. The
gate samples it back via the same screen→world→buffer UV mapping
`sun-occlusion-render.js#buildSunVisibilityNode` already uses.

> ⚠️ **THE EXPLORED ZONE CURRENTLY RENDERS BLACK, NOT DIM — AND THAT IS DELIBERATE, BUT IT
> IS ALSO NOT DONE.** `exploredDimNode` is pinned to `0`. The reason is structural, not
> laziness: the gate multiplies a **fully composited** frame, which already contains
> tokens, candle flames and particles. Any non-zero dim would therefore show *live
> content* at reduced brightness in areas the viewer cannot currently see — which is
> precisely the 50%-opacity hole this whole pillar exists to close, and is the exact bug
> Foundry itself has (`keyhole-fog-of-war-gap`). Showing a player **less** than Foundry
> did is safe; showing more is not, so black is the only defensible interim.
>
> **What it costs:** players lose the familiar dim "remembered map" and see black outside
> their current vision. Functionally safe, visually a regression against Foundry.
>
> **What finishes it (the next slice):** a content-free base to dim — i.e. gate
> tokens/effects out of `buf:scene.color` at the *geometry* stage so the explored zone can
> sample map-art-only, then raise `exploredDimNode`. That is per-object gating done at the
> right layer, and it is the one remaining piece before this matches Foundry's look.

**Cross-session persistence is NOT built.** The buffer is per-session; a reload starts
unexplored. Foundry's own `FogExploration` document keeps saving throughout (suppressing
`canvas.visibility` stops the group *rendering*, not `refreshVisibility` running and
committing), so the saved data still exists — seeding MSA's buffer from
`canvas.fog.exploration`'s stored image on scene load is a one-time texture load, not a
per-frame readback, and is the natural follow-up.

**Slice 4 — the takeover.** `canvas.visibility.renderable = false` behind a revert flag,
MSA composites the three zones (unexplored / explored-not-visible / visible).

**Slice 5 — THE LEAK** (Testament Pillar 11's first checkbox, and it *outranks* look work
by Law 7): per-object gating so non-GM players cannot see live content in the
explored-but-not-visible zone. Owning the mask makes this cheap — the same buffer gates
MSA's own draws.

> ⚠️ **NOW DEMONSTRATED LIVE, not just reasoned about (2026-08-15).** A verification run
> with the takeover flag temporarily ON, on the bench Mansion, showed the map correctly
> blacked out where unrevealed — **and candle flames, fire particles and light coronas
> still drawn on top of the fog.** They are separate draws (`candleFlameScene`, the
> particle engine, coloration) that never pass through the composite the vision gate sits
> in, so gating the composite cannot reach them. This is exactly the per-object gating
> this slice exists for, and it is the concrete reason the takeover flag cannot default on
> yet: a player would see every lit candle through solid fog. The fix is to gate those
> draws against the same `visionMask` texture, not to add a second mechanism.

**Slice 6 — vision modes** (night vision et al.) as per-viewer grade presets.

## 5. ⚠️ SAFETY — the one ordering rule that must not be broken

`canvas.visibility` is the layer that hides things from players. Turning it off before
MSA's replacement is complete does not degrade gracefully — **it reveals the entire map to
every player at once**, which is mission priority #2 and Law 7.

Therefore:

- Slices 1–3 ship with Foundry's visibility render **untouched**. They are additive and
  inert.
- Slice 4 ships behind a revert flag (Law 5, the safety slide), default **OFF** until the
  author has confirmed a real two-client GM+player session — the DoD Pillar 11 already
  states. This is the one place the project's "default new features ON" posture is
  deliberately overruled, because the failure mode is a secrets leak rather than a missing
  effect.
- Any slice-4 error path falls back to re-enabling Foundry's own visibility render, never
  to "no fog".

## 6. Known traps, banked before starting

- **Soft-edge SDF has a live bug.** `point-light-illumination.js`'s `edgeSoftFactor` turned
  the scene black and is currently disabled. If smooth fog edges reuse that
  `Loop`/`uniformArray`/`Fn` SDF path, budget debugging (memory
  `keyhole-uniformarray-indexed-read-unexplained-failures`).
- **A GM with no controlled token skips the whole visibility group**
  (`refresh()`: `this.visible = visionSources.some(s => s.active) || !game.user.isGM`), so
  every "looks fine" observation made that way tested nothing. Verification needs a real
  controlled token — the trap that let two wrong fixes pass as verified this same day.
- **The bench scene ships no tokens** (the export bridge excludes them), so any harness for
  this must create and control one. `tests/playwright/msa-token-vision-noon.spec.js`
  already does.
- **Throttled persistence readback is a sanctioned exception**, not a licence to widen the
  `no-gpu-readback` wall — route it through `tools/structure-exceptions.json` with a real
  `approvedBy`. Foundry's own fog does the same readback, throttled 500 ms / debounced 2 s.
