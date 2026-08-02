# Sun Shadows — the SMEAR redesign (2026-07-31)

**Status:** PROTOTYPE, Shader-Lab-only (`tools/shader-lab/smear-prototype.js`). The production
march (`src/effects/lighting/sun-occlusion-render.js`) stays shipped and untouched until the
author approves this look in the lab; then this REPLACES it (no permanent fork — the V2 autopsy's
first law).

## Why start again

The author, live, after Rounds Twelve/Thirteen fixed the march's discretization plateaus in the
lab: *"The shadow is pitch black from the origin and only becomes a little bit soft right at the
right side. That's not how shadows appear in real life... If I change the azimuth you can see an
ugly square step pattern... the current approach to shadows might not actually be the best
approach."* And the live scene STILL showed the double shadow — see "What the lab was missing"
below.

The pitch-black complaint is not a bug in the march — it IS the march. Physical column occlusion
saturates: a blocked ray reads fully blocked, so every receiver under the geometric shadow reads
identically dark and all softness lives at the tip. The author's requirements describe a
different model:

1. **Contact AO** — soft, diffused darkening hugging the building on the lee side.
2. **Distance falloff** — darker near the building, progressively WEAKER and BLURRIER with
   distance, near-transparent at the far tip.
3. **Overhead participates without detaching** — a tavern sign's shadow must stay part of the
   building's shadow mass, never a floating orphan. (Solved before in V2 by offsetting the
   `_Outdoors` mask together with the overhead art — the union happens BEFORE the offset.)

## The model

One scene-space bake, same rect/packing/uniform plumbing as the march. Per ground texel, march
toward the sun over stations `d_i = i·stepPx` (i = 0..N — station 0 included; it is what darkens
the ground directly beneath a bridge at noon, replacing the march's special-cased d=0 seed):

- **Silhouette union** `S` = `max(buildingCoverage = 1−A, floatingCoverage = B)` — building,
  overhead and sky-reach as ONE mass, which is requirement 3 by construction: the sign and its
  building are the same silhouette before any smearing happens.
- **Coverage at a station** is read MIP-FILTERED with a blur radius that GROWS with distance
  (`base + d·PENUMBRA_PER_PX·tipBlurMul`, floored at one caster texel) — requirement 2's
  "more blurred further away", and what dissolves the caster-texel staircase the author
  screenshotted (raw texel corners are never sampled unblurred).
- **Falloff weight** `w = (1 − d/throw)^exponent`, `throw = stationHeight/tanElev` — requirement
  2's "progressively less strong". Taller parts of the silhouette throw further; the weight
  reaches 0 exactly at the physical throw distance, so length still derives from height, never
  an authored length.
- **Self-immunity** — a station only counts if its height exceeds the receiver's own
  (`smoothstep` feathered), Round Six's rule inherited verbatim: "you cannot be shadowed by
  something not taller than you." A receiver on the deck of the thing itself reads nothing;
  ground under a bridge reads the bridge.
- **occlusion = max_i ( S_i · w_i · taller_i )**, then **contact AO** is max'd in: a wide-mip
  read of `S` at the receiver itself, gated by whether blurred material lies TOWARD the sun
  (lee side only — requirement 1's exact scoping), scaled by an authored AO strength.

## Why the old failure modes cannot recur

- **The plateau class dies by construction.** There is no height-crossing test, no closest-
  station scoring, no bracket to interpolate: occlusion is a max of continuous functions of the
  receiver position (mip-filtered coverage × smooth falloff), so it is continuous in the
  receiver position. Rounds Ten–Thirteen's entire machinery (sign-change searches, bisection
  refinement) has nothing to attach to and is absent.
- **The staircase dies** because coverage is never point-sampled: the read radius is floored at
  one caster texel and grows with distance, while opacity simultaneously falls — texel corners
  are both blurred and faded where they used to be full-contrast.
- **Cheaper, too:** one mip'd fetch per station, no lateral-tap loop at all (the mip read IS the
  lateral softening — the cone existed to fix point-sampling, and nothing point-samples any
  more). Tier ladder simplifies to steps × fieldDim × casterGridDim when ported.

## What the lab was missing (the author's fidelity question, answered honestly)

The CPU twin was NOT the divergence: it matched the GPU shader decimal-for-decimal in the lab,
proven repeatedly. The divergence is that the lab (and twin) bypass two whole stages of the live
pipeline:

1. **The derivation** — real `mask-derive.js`/`bakeCasterTexture` over real multi-floor mask
   sets (two floors, two `_Outdoors`, overhead layers). The lab rasterizes its own synthetic
   packing directly. The live double-shadow surviving lab-verified march fixes points here.
   → Roadmap: a harness feeding synthetic multi-floor mask sets through the REAL derivation.
2. **The composite** — the per-floor gate, ambient multiply, gamma. The author's "shadow
   overlaid on the upper floor" is composite-side: the 2026-07-28 floor-gate fix is evidently
   not working live. → Separate live investigation (task logged), independent of the model.

## Port status (2026-08-01) — STAGE 1 DONE, live-toggleable, not yet the default

The plan below assumed the port would wait for a look verdict from the lab. The author correctly
rejected that ordering: *"I don't think the shader lab version of the shadow is actually working
in engine yet and I can't judge unless I'm looking at the real end result."* A synthetic-rectangle
comparison in an isolated canvas cannot settle a question about real composited output — so getting
the model INTO the real engine, safely and reversibly, became the prerequisite for judging it, not
a reward for having already judged it.

**Done:**
1. ✅ CPU twin — `sun-occlusion.js#marchVisibilitySmear`, 10 assertions (count-invariance, monotonic
   falloff, self-immunity, lee-only AO, sign-attachment, strength/gate bounds, full-sky sweep).
2. ✅ Shader — `sun-occlusion-render.js#buildSmearShadowBakeMaterial`, public surface a strict
   match of the march's own (`setSun`/`setField`/`setLook`/`setRect`/`setEdgeBandPx`) so the
   subsystem needs zero special-casing to hold either material.
3. ✅ A LIVE TOGGLE, not a silent replacement — `shadowModel` param (`effects/sun-shadows.js`,
   same schema-driven ROH-dropdown shape as `debugView`), `march` (shipped) default, `smear`
   (experimental) one click away in the author's own control panel, no code change, no reload.
   `sun-shadow-subsystem.js#applyMarchQuality` is now model-aware (merged, not a parallel
   function — see its own header for why a parallel one would rebuild with the wrong builder
   the instant a tier changed while `smear` was selected).
4. ✅ Full verify green (6587 tests, structure, lint/format on every touched file).

**Still open, in order:**
5. ⏳ The author's own eyes on a real scene, both models, back to back — the step everything above
   exists to make possible. Not done until this line is.
6. ⏳ IF approved: delete the march's crossing/bisection machinery, the lateral-tap loop, and the
   width-gate from `sun-occlusion-render.js`; tier plans lose `lateralTaps`, re-scale steps per
   rung; `shadowModel` param removed once there is only one model again (a toggle between one
   thing and itself is dead weight, not a feature — `feedback_mode_forks_silently_drop_features`'s
   own lesson, applied before it has the chance to rot).
7. ⏳ IF NOT approved, or approved with changes: keep iterating with the toggle live (this is
   exactly what it is FOR) — Shader Lab for fast synthetic iteration, the toggle for real-scene
   confirmation, both against the SAME CPU twin so the two never quietly diverge.
