# EFFECTS — the TSL tier spec

**Status:** DESIGN SPEC, authored 2026-07-16. Not yet implemented — no effect has been ported to Keyhole yet. This is the shape they must take when they are (Keyhole §8 Stage 6).
**Scope:** performance, and nothing else. Not the look, not the art direction, not the parameter schemas. How an effect is *laid out* so that it costs what the machine can afford.
**Prerequisite reading:** `Keyhole.md` §0 (the law + doctrine), §4.1 (the VT sampler), §4.2 (the attribute buffer), §9 Q3 (why TSL). Project memory: `keyhole-webgpu-tsl-decision`, `keyhole-stage6-effects-approach`, `reference_tsl_method_chaining_trap`.

---

## 0. The thesis

**Author's framing (2026-07-16), which is the whole spec in one sentence:** *"a water effect would at its very lowest level be just the color blue placed in the correct place on the mask. Then everything upwards from that would be an additional thing that was gated or tiered by performance requirements."*

That is exactly right, and it is the same idea as the coarse pin.

Keyhole's memory core guarantees that **the whole world always renders, instantly, just soft** — because the top mips of every layer are pinned and never evicted. Worst case is blur; never black, never absent (§4.1). The effect system needs the identical guarantee on the *time* axis rather than the *memory* axis:

> **Tier 0 is the effect's coarse pin.** It is always compiled, always drawn, and cheap enough that the floor hardware can always afford it. Worst case is flat, never absent. Water is always blue.

A scene on a weak machine should look **simpler**, never **broken**, and never **different**. The river is still a river. That is a product statement as much as a performance one, and it falls out of the architecture rather than being policed.

### Why this also solves the deferred-features problem

`keyhole-stage6-effects-approach` demands two things that normally fight: *design the eventual full feature set up front*, but *ship a minimal slice first* — and **remember the deferred features explicitly** so the MVP doesn't quietly become forever.

The tier ladder makes those the **same artifact**. The ladder IS the design of the full effect. Tier 0 IS the minimal slice. Tiers 1..N are the deferred list — written down, ordered, costed, and *executable*. A deferred feature isn't a comment that rots; it is a rung that no machine currently reaches. Building it later is filling in a rung, not a rewrite, because the rung's contract was declared on day one.

---

## 1. The laws

### Law 1 — Tier 0 is guaranteed
Always compiled, always resident, always drawn, never gated. It must be affordable on the design-floor card (RTX 3070 Laptop, §1) even with every effect in the scene at tier 0 simultaneously. If tier 0 can ever be too expensive, it is not tier 0.

### Law 2 — Tiers are a LADDER, not a checklist
A totally ordered integer `0..N` per effect. **Monotonic:** tier `n+1` is tier `n` **plus** additions — never a substitution, never a different technique for the same term. Turning the tier down removes detail; it never changes identity, hue, or placement.

This is also the reason the ladder is an integer and not a bag of booleans. `k` independent booleans is `2^k` shader variants; a ladder of `N` rungs is `N` variants. **Variants are linear, not exponential** — see §5. Independent toggles are how effect systems die of compile time.

### Law 3 — Order the ladder by COST CLASS, not by prettiness
This is the least obvious law and the most important. The instinct is to add features in order of how good they look. The correct order is **cheapest-visual-return first**, and cost is dominated by *class*, not by instruction count:

| Class | What it is | Relative cost |
|---|---|---|
| **C0** Constant | a literal colour, a compile-time value | free (folded) |
| **C1** ALU | maths on values already in registers | ~free at our resolutions |
| **C2** Resident read | a small always-loaded tiling texture (noise, ripple) | cheap, cache-friendly |
| **C3** Graph read | a buffer the frame graph already produced (`scene.attr`, `scene.illum`) | cheap — no new bandwidth |
| **C4** VT read | a `vtSample` — indirection fetch **then** atlas fetch | real; it is 2 dependent reads |
| **C5** Dependent read | a read whose *coordinate* comes from another read (refraction, SSR) | expensive; defeats prefetch |
| **C6** Extra RT | a new full/partial screen target + its bandwidth | expensive; also VRAM (§4.6) |
| **C7** Per-frame sim | ping-pong state that ticks whether or not it is seen | expensive **and constant** |
| **C8** Geometry | extra draws, extra vertices, extra overdraw | expensive; CPU too |

A tier may only introduce a cost class **≥** the tiers below it. A ladder that goes `C1 → C6 → C2` is malformed: the C2 rung would be free-ish detail stranded above an expensive one, so a machine that could afford the detail is denied it by an unrelated cost. Sort the rungs by class, then by visual return within a class.

### Law 4 — Gating by uniform is NOT gating
**A `uniform` set to zero does not remove work. It executes every pixel and pays for its bindings.**

We have already paid for this exactly once, and it is worth the reminder because it looked correct: the occlusion block ran on every drawable with `occlusionWeights = [0,0,0,0]` — arithmetically an identity, `alpha *= mix(1,0,0)`. It still sampled its mask texture, still bound it, still executed. It was "off" only in the sense that its output happened not to change anything.

- **Tier selection is a JS `if` at graph-build time.** The nodes for a tier that is off are *never constructed*, so they cannot cost anything. Different tier → different node graph → different pipeline → genuinely cheaper.
- **TSL's `If()` / `Loop()` are RUNTIME branches.** Reserve them for per-pixel, data-dependent decisions that cannot be known at build time. Never use them for tiers.
- A literal (`float(0)`) can be constant-folded by the compiler; a `uniform(0)` cannot, by definition — the whole point of a uniform is that it might change.

> **The test:** if turning a feature off does not *shrink the compiled shader*, it is not off.

### Law 5 — Tier follows MEASURED performance, never the backend
Restated from `keyhole-webgpu-tsl-decision` because it is the one most likely to be violated by accident: **WebGPU availability tracks browser recency, not GPU power.** A 2017 laptop on current Chrome has it. Coupling "fancy" to "has WebGPU" hands the weakest hardware the most expensive path — precisely the crash Keyhole exists to prevent. Backend selection is automatic and separate. Tier comes from the governor's measurements and explicit settings, full stop.

### Law 6 — Cost scales with COVERED pixels, not screen pixels
Keyhole's law is O(screen). For effects it sharpens to **O(covered screen)**. A water pass that runs fullscreen while water covers 2% of the view is an O(screen) violation wearing a disguise. Effects render as **geometry bounded to their mask's region**, or are scissored/stencilled to it. The mask already knows where the effect is; that knowledge must reach the rasteriser, not just the shader.

### Law 7 — Above the sim line, gate on COVERAGE and ZOOM, not just tier
C7 (per-frame sim) and C8 (geometry) don't care that the water is three pixels in the corner — they tick regardless. So rungs at or above C7 take a second gate: **screen coverage** and **zoom level**. Ripples that are sub-pixel at the current zoom are not "cheap", they are *waste with a cost*. Zoom out far enough and the correct tier is 0 no matter how fast the machine is.

This is the effect-side mirror of `chooseMip()`: don't stream detail you cannot see, don't simulate detail you cannot see.

### Law 8 — One TSL source per effect. No twin.
`three.webgpu.js` carries both `WebGLBackend` and `WebGPUBackend`; TSL compiles to both. There is never a hand-written WebGL2 version of an effect. The tiers are the only axis of variation.

---

## 2. The effect manifest

Every effect declares its ladder as **data**, next to its implementation. Not prose, not a comment — data, because three different consumers must read it: the governor (to plan a budget), the settings UI (to show what a machine can do), and the verifier (to prove the ladder is well-formed).

```js
export const WATER_EFFECT = {
  id: 'water',
  // What the author would lose first if the frame budget shrinks. Higher = defend
  // harder. Not a priority queue position — an input to one.
  visualWeight: 0.8,
  // Which VT layer-packs this effect needs resident AT ALL. Tier 0's needs are
  // pinned with the coarse set; higher tiers may declare additional packs, which
  // the residency planner only streams when that tier is live.
  packs: { base: ['water'], 3: ['waterNormal'] },
  tiers: [
    {
      n: 0,
      name: 'flat',
      // THE COARSE PIN. One VT read, one constant, a lerp. Never gated.
      cost: { class: 'C4', estMsPerMp: 0.05 },
      adds: 'the water mask, tinted. The river is a river.',
    },
    // ... see §4 for the full worked ladder
  ],
};
```

**Required per rung:**
- `n` — its position. Contiguous from 0.
- `cost.class` — its highest cost class. **Must be ≥ the rung below (Law 3).**
- `cost.estMsPerMp` — the author's honest estimate at design time, replaced by the *measured* value once `GpuPassTimer` has seen it. The estimate exists so a rung can be budgeted before it is written; the measurement exists because estimates are wrong.
- `adds` — one line, in English, of what this rung buys. If it cannot be said in one line, it is probably two rungs.

**A rung may not:** change a lower rung's output, introduce a cost class below its predecessor, or depend on a rung above it.

---

## 3. Authoring rules for TSL

1. **Build the graph with JS control flow.** `if (tier >= 3) { ... }` around node construction. Never a `uniform` multiply to disable.
2. **`.toVar()` any subexpression used more than once.** TSL is a graph; re-referencing a node re-evaluates it unless it is materialised into a variable. This is the single easiest accidental 2× cost.
3. **Never TSL's `.mix()` / `.smoothstep()` methods.** Their receiver is the *interpolant* — `a.mix(b, t)` compiles to `mix(b, t, a)`, silently, with no type error. Always the function form `mix(a, b, t)`. See `reference_tsl_method_chaining_trap`; this cost a full session and produced three simultaneous bugs that all read as correct code.
4. **Sample the world through `vtSample` and nothing else.** An effect that reaches around the VT is an effect that can allocate at world resolution, and §4.6's allocator will throw — correctly.
5. **Prefer a C3 graph read to a C4 VT read.** If the attribute buffer or the illumination buffer already knows it, read that. `scene.attr` exists precisely so floor gating, outdoors, and coverage are screen-space reads instead of per-floor RT stacks.
6. **Hoist shared terms into the frame graph, not into each effect.** If four effects each compute a scrolling UV or a screen-space normal, that is four times the cost for one result. Shared terms are a pass, or a shared `Fn()` evaluated once and passed down.
7. **Colour space is a property of the DATA, not the texture.** One atlas holds albedo pages *and* mask pages. Tagging the texture sRGB fixes the art and silently corrupts every mask. Decode per-pack, in-shader. (Learned live, 2026-07-16.)
8. **Alpha is linear in every colour space.** Never transfer-encode it.

---

## 4. The worked example — water

The author's own example, taken to its conclusion. Note that the ordering is by **cost class**, and that this is *not* the order a person would list water features in if asked what makes water look good — which is the entire point of Law 3.

| Tier | Adds | Class | Why here |
|---|---|---|---|
| **0** | **The mask, tinted blue.** | C4 | The coarse pin. One `vtSample`, one constant, one `mix`. The river is in the right place and is the right colour. **Never gated.** |
| **1** | Depth tint — shallow/deep from the mask's own channel. | C1 | Pure ALU on a value tier 0 already read. Free detail. Enormous visual return per cycle: this is what stops it reading as a flat blue decal. |
| **2** | Scrolling ripple normal from a small tiling texture. | C2 | One resident, cache-friendly read; UV scroll is ALU. The water *moves* — the largest perceptual jump on the whole ladder, and still nearly free. |
| **3** | Specular response from `scene.illum`. | C3 | The lighting buffer is already in the graph. Water catches the light. **No new bandwidth.** |
| **4** | Shoreline foam from the mask's distance field. | C4 | A second VT read. Real cost, high return — edges are where water reads as wet. |
| **5** | Refraction — distort what is beneath. | C5 | First dependent read: the coordinate comes from the normal. Defeats prefetch. Below this line, the machine must be earning it. |
| **6** | Planar/screen-space reflection. | C6 | An extra target and its bandwidth. Beautiful, and the first rung with a VRAM cost the ledger must see. |
| **7** | Flow simulation — ping-pong sim grid. | C7 | **Ticks whether or not it is on screen.** Coverage- and zoom-gated per Law 7. Sim-res, never world-res. |
| **8** | Splash particles, plank-gap interaction. | C8 | Geometry, CPU cost, overdraw. The top of the ladder. |

Read the table as a story: **tiers 0–3 cost almost nothing beyond tier 0 and buy nearly all of the look.** Colour, depth, motion, light. A weak machine gets water that a player would not describe as "missing effects" — they'd describe it as water. Everything from 5 up is the expensive half, and it is the half a player only notices when it is present, not when it is absent.

That asymmetry is not luck. It is what Law 3 *is*: sorted by cost class, the cheap rungs cluster at the bottom, and the cheap rungs are where perceptual return per cycle is highest — because human vision is far more sensitive to colour, contrast and motion than to physically-correct refraction.

**The cross-floor rule survives at tier 0.** Keyhole §4.4 flags water as the honest hard case: the river must render and simulate under the plank gaps of the floor above. That is a *correctness* constraint, not a detail one, so it belongs to tier 0's placement (which mask, which floor) and not to a rung. **Correctness never rides the ladder.** A rung may only add detail; if a machine drops to tier 0, the water is still in the right place on the right floor, under the right planks.

---

## 5. Variants and the compile budget

Every tier of every effect is a distinct compiled pipeline. That is the price of Law 4, and it is the right price — but it must be counted.

- **Ladders keep it linear.** `Σ tiers` across effects, not `Π toggles`. ~10 effects × ~6 rungs ≈ 60 pipelines, not thousands.
- **Only compile what a machine will run.** The governor picks a tier; only that tier's pipeline is built. Adjacent rungs (`n±1`) may be precompiled speculatively so a tier change is not a hitch.
- **Compile at load, behind the curtain, under the governor.** `KHR_parallel_shader_compile` is present on the design-floor card. A tier change mid-session must never compile on the frame it takes effect — that is a stutter caused by the mechanism meant to prevent stutter.
- **Author toggles are a separate, coarse axis:** an effect is on or off entirely. An off effect compiles nothing. Do not let author toggles become per-feature booleans inside an effect — that is the exponential path, re-entered through the settings dialog.

---

## 6. How the governor chooses

Not built. The shape, so the manifests are right:

1. **Budget.** A frame's GPU time, minus the non-negotiables (geometry, lighting, present). What remains is the effect budget.
2. **Floor.** Every effect gets tier 0. Unconditionally. Tier 0's total is part of the non-negotiable set, not the discretionary budget — Law 1.
3. **Spend.** Walk the rungs across all effects by **return per millisecond** — `visualWeight` ÷ measured cost — buying the cheapest worthwhile rung next, regardless of which effect it belongs to. A cheap rung on a lesser effect beats an expensive rung on a favoured one. This is what makes cross-effect quality coherent instead of one effect hogging the frame.
4. **Gate.** Rungs at C7+ additionally require coverage and zoom to justify them (Law 7).
5. **Damp.** Tier changes are sticky and hysteretic. An effect oscillating between rungs is worse than either rung — visibly, and because of the pipeline swap. Measure over seconds, not frames.

The existing DRS governor stays the *fine* knob (render scale). Tiers are the *coarse* knob. Neither is a survival mechanism any more — that is what the memory law is for.

---

## 7. Verification

An effect is not done because it looks right at the tier the developer's machine picked.

- **Every rung renders.** A per-effect harness that forces each tier in turn and screenshots it. A rung nobody's hardware currently selects is a rung that silently rots — the exact failure the ladder exists to prevent (§0).
- **Monotonicity is testable.** Tier `n+1` must not change tier `n`'s output where `n`'s features are concerned. Assert it: render both, diff the region the lower tier owns.
- **The manifest is checkable in Node.** Contiguous `n`, non-decreasing cost class, no rung depending upward, tier 0 present. Pure data, so it is a unit test, not a review.
- **Law 4 is checkable.** Compile tier 0 and tier N, compare shader lengths. If disabling a feature does not shrink the shader, it was a uniform, not a gate.
- **Tier 0's total is a budget with a number.** All effects at tier 0, on the torture scene, on the design-floor card, inside the frame. If that fails, a tier 0 somewhere is lying about its class.

---

## 8. What this spec deliberately does not decide

- **The tier count per effect.** Six is not a law. Some effects are two rungs. Say so in the manifest.
- **The look.** Which blue, which ripple, which parameters. That is the product and it lives with the effect (`keyhole-stage6-effects-approach`: audit and rethink each effect from scratch — this spec constrains the *layout*, not the design).
- **Which effects exist.** Keyhole §4.4's 48→10 mapping is the starting inventory, still not the final word.
- **The governor's exact policy.** §6 is a shape. It gets built when there are ≥2 tiered effects to arbitrate between, not before.

---

*Tier 0 is the coarse pin. Water is always blue.*
