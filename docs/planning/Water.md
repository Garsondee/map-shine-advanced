# WATER — audit of V2's hardest effect + the design-note seed for the first Stage 6 port

**Status:** RESEARCH + DESIGN SEED, 2026-07-16. The author's dare: *"If you want a particularly horrifying effect then examine the water effect in depth... you'll see so much that you don't like and yet the effect itself looked amazing."* Both halves confirmed, and the tension between them IS the finding.
**Why water:** Keyhole §4.4 names it the honest hard case and the FIRST Stage 6 port; `Effects.md` §4 uses it as the tier ladder's worked example; `keyhole-stage6-effects-approach` requires a per-effect design note before porting. This is that note's seed.

---

## 1. The family, measured

| Lines | File | Role |
|---|---|---|
| 5,174 | `WaterEffectV2.js` | orchestration: mask discovery, per-floor compositing, cross-floor binding |
| **2,835** | `water-shader.js` | **THE LOOK — where "amazing" actually lives** |
| 3,854 | `WaterSplashesEffectV2.js` | splash particles |
| 1,683 | `water-splash-behaviors.js` | splash spawn logic (readback-driven) |
| 1,304 | `FluidEffectV2.js` | the fluid sim variant |
| **14,850** | | **the water family** |

**The ratio is the headline:** the product — the shader and its parameters — is ~2.8k lines. The other ~12k is *plumbing*: mask discovery, per-floor RT compositing, binding switches, occluder push-doors, readback spawn scans. **The amazing part is 19% of the code.** Keyhole keeps the 19% and derives the 81%.

## 2. The horror tour — each with its general lesson

1. **324 uniforms on one shader.** Every knob is a uniform: always bound, always paid, every pixel, every frame — the shader is compiled for its maximal self at all times. This is `Effects.md` Law 4's anti-pattern at its largest observed scale (the module-wide census found 117 gated *branches*; water alone carries 324 knobs). **Lesson:** the tier ladder is not a nicety — without it, every feature you ever add is a permanent tax on every machine forever.
2. **The world's size is derived five separate ways, with a silent fallback to `1`.** `foundrySceneData?.sceneWidth` → `sceneRect?.width` → `sceneRect?.sceneWidth` → `1`. If every source is absent, water gets a **one-pixel world** rather than an error. **Lesson:** shared facts need one owner (`scene-geometry.js` is that owner in V3); a degenerate silent default is an instrument that lies.
3. **Splash spawning reads the GPU back** — `readRenderTargetPixels` over a full RT, with a comment describing the *optimised* path as "single readRenderTargetPixels per floor/mask." A stall per floor per mask, as the good case. **Lesson:** per-page CPU extraction at decode time (§4.1) exists precisely so spawn-point scans never touch the GPU.
4. **Per-floor scene-sized mask composites** (`packTarget = new WebGLRenderTarget(width, height)` at scene dims): the cost model, O(world × floors), in one line. **Lesson:** already dead under the VT — the packed water-data (coverage + shore band) becomes a VT layer-pack.
5. **Even the cleanest logic swallows.** `_setCrossSliceWaterDataUniform` — two lines, wrapped in `catch (_) {}`. The 2,670-swallow disease reaches the healthiest tissue in the file. **Lesson:** `no-empty` is not a style rule.
6. **Bespoke occluder doors:** `setWaterBackgroundAlphaMaskTexture(...)`, `setOverheadRoofBlockTexture(...)` — two more push-setters some caller must remember, existing ONLY so borrowed water can be punched out under opaque upper geometry. **Lesson:** that punch is a coverage question, and the attribute buffer answers it as a C3 screen-space read — both doors dissolve.
7. **The HEALTH-WIRING BADGE:** a docstring MUST demanding manual sync with `HealthEvaluator` contracts — the same diagnostics service the params audit caught *writing* into effect params. Diagnostics and product, coupled in both directions, by convention. **Lesson:** observers observe; a diagnostic that mutates or requires manual contract-sync is a second god-object growing.
8. **Time has no owner:** 8 independent `performance.now()` reads in one effect. **Lesson:** time is an input (the frame's snapshot), not something every module samples privately.

## 3. What is PRODUCT — harvest list (the author's taste, keep all of it)

- **The feature set, verbatim from the header:** tint, wave distortion, **caustics**, **GGX specular**, foam, murk, **rain ripples**, chromatic aberration. This is the real tier ladder's rung inventory.
- **The water-data packing idea is genuinely smart:** R = coverage, **G = shore band derived from mask gradients** — a distance-field-lite computed once at pack time, which is why shorelines looked good. Keep the encoding; it becomes the VT water layer-pack's format, and it means **foam/shoreline is cheaper than `Effects.md` §4 guessed** (the shore band is already in the mask read — tier 4 foam needs no second VT read).
- The splash *behaviors* (spawn feel, lifetimes, interaction) — gameplay feel, not plumbing.
- The 324 uniforms' *values* — the tuning is taste; the delivery mechanism is the disease. They become the params schema + tier-gated node-graph constants.

## 4. THE CROSS-FLOOR RULE — the one piece of logic ported deliberately

Found, read, and it is **fifteen clear lines** (`WaterEffectV2.js:4357`):

> *"When this level has no `_Water` pack, borrow the nearest lower floor's pack so the water surface visible through holes/bridges still renders correctly (composite + shader occluder will still suppress it under upper opaque geometry)."*

**Semantics to preserve, precisely:**
1. A floor with no local water **borrows the nearest lower floor's** water data (`_resolveWaterFloorForView`), flagged `crossSlice`.
2. **Borrowed water is punched out wherever upper geometry is opaque** (decks, tiles) — via occluder coverage.
3. A per-level override can pin which floor's water a given slice uses (`_perLevelOverride`), falling back to the viewed floor.

**The Keyhole translation dissolves the plumbing but keeps every rule:**
- *Borrowing* = which floor's `vt:water` pack the water pass binds — one resolve function at bind time, identical logic, Node-testable in isolation.
- *The punch* = an attribute-buffer read (`scene.attr` carries per-pixel floor/coverage) — replacing both bespoke occluder textures and their setters. C3, no new bandwidth.
- *The override* = an input to the resolve, not mutable state on the effect.

This was V2's hardest plumbing and Keyhole's §9 risk 4. After reading it: **the rule is small and sound; the risk was always the machinery around it.** Risk assessment revised down.

## 5. The real tier ladder (refining `Effects.md` §4 with V2's actual features)

| Tier | Feature (V2-verbatim) | Class | Note |
|---|---|---|---|
| 0 | coverage tint (the mask, blue) | C4 | the coarse pin; carries the cross-floor rule (correctness never rides the ladder) |
| 1 | murk + depth tint | C1 | ALU on the tier-0 read |
| 2 | wave distortion + rain ripples | C2 | scrolling noise; rain state is a shared param input |
| 3 | GGX specular from `scene.illum` | C3 | graph read |
| 4 | foam / shore band | **C4→C1!** | the shore band is IN the water-data G channel — cheaper than the generic ladder guessed |
| 5 | refraction + chromatic aberration | C5 | first dependent reads |
| 6 | reflections | C6 | extra RT |
| 7 | fluid sim (`FluidEffectV2`) | C7 | coverage- and zoom-gated |
| 8 | splashes | C8 | spawn from decode-time extraction, never readback |

## 6. Declaration sketch (per `Effects-API.md` §5)

```js
export const WATER = {
  id: 'water', layer: LAYERS.SURFACE, visualWeight: 0.8,
  reads: ['vt:water', 'buf:scene.color', 'buf:scene.attr', 'buf:scene.illum'],
  writes: ['buf:scene.color'],
  params: WATER_PARAMS,          // the 324 knobs, as a schema with one owner
  tiers: WATER_TIERS,            // §5 above
  resolveWaterFloor,             // §4's rule — pure, tested alone
  build(ctx) { /* tiers construct the node graph; nothing else exists to touch */ },
};
```

## 7. Open questions for the port
- Where does the shore-band gradient computation run now? (Decode-time per-page extractor is the natural home — it is exactly the fire-spawn-points shape.)
- Rain ripples need weather state: a shared param, or a `res:weather` resource? (Decide when weather is designed; do not let it become a reach.)
- Splash sim residency: does splash state live per-floor or per-visible-water-region? (Coverage-gating suggests region.)

---

*The amazing was 19% of the code. Keep the 19%, derive the 81%.*
