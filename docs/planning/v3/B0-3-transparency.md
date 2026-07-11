# B0-3 — Class B Transparency Strategy for the Unified Pass

**Status:** DRAFT for author review (B0, no code). Written 2026-07-10; blend/depth settings verified against source that day.
**Parent:** [Forward+.md](../Forward+.md) §12.3 Class B, §12.6 (open question), §15 B0(3)/B4.
**Decides:** how transparent/particle effects sort correctly in one depth-tested pass — painter's-order **within** floor bands + hardware depth **between** bands, with OIT held as a gated fallback, not a default.

---

## 1. What Class B does today (verified inventory)

Two structural groups, one shared fact: **nothing in Class B writes depth.**

### Group 1 — drawn inside the level pass (bus scene or parallel scenes, per-floor RT isolation does the cross-floor work)

| Effect | Blending | depthTest | Ordering today |
|---|---|---|---|
| `DustEffectV2` | Normal (:1093) | false | renderOrder band (`FLOOR_EFFECTS`) |
| `FluidEffectV2` | Normal (:1297) | false | renderOrder band |
| `AshDisturbanceEffectV2` | Normal (:1029) | false | renderOrder band |
| `CandleFlamesEffectV2` | **Additive** (:2684) | **true** (:2686) | renderOrder band |
| `SelectionBoxEffectV2` | **Additive** (:799) | — | overlay |
| `MovementPreviewEffectV2` | default Normal | — | overlay |
| `SmellyFlies`, `WeatherParticlesV2`, `WeatherLightning`, `AshCloud`, `Cloud sprites`, `DetectionFilter` | no explicit `blending:` found → three.js default (Normal) or shader-file-local; **verify per effect at B4** | varies | varies |

### Group 2 — deliberately excluded from the level pass, composited post-merge
- **Vegetation** (`BushEffectV2` :2126–2142, `TreeEffectV2` :2517–2533): Normal blending, `depthTest:false`, layer **32** (`VEGETATION_ABOVE_WATER_LAYER`), drawn onto the merged HDR composite after water/bloom, before CC ([FloorCompositor.js:9673–9707](../../../scripts/compositor-v2/FloorCompositor.js)) in explicit label order (`bush.shadow`, `tree.shadow`, then `bush.canopy`, `tree.canopy`). Reason (verified comment, [render-layers.js:12–15](../../../scripts/core/render-layers.js)): water tint/specular must never paint over vegetation.
- **Water splashes** (`WaterSplashesEffectV2` :2718–2925, all four materials Normal / no depth): layer **33**, composited after water, before vegetation (:9653), floor-gated by the M4 occluder GLSL ([water-screen-occlusion.js](../../../scripts/compositor-v2/effects/water-screen-occlusion.js)).

### The ordering substrate (keep it — it already works)
[LayerOrderPolicy.js](../../../scripts/compositor-v2/LayerOrderPolicy.js) gives every mesh `renderOrder = floor × 10000 + role band + intra-slot` with five bands per floor (`ALBEDO`, `EFFECTS`, `OVERHEAD`, `OVERHEAD_FX`, `MOTION_TOP`), fractional per-tile interleave slots, and Sequencer/JB2A mapping. This *is* painter's order within and across floors, fully deterministic, with a decoder for diagnostics. The bus geometry is additionally at real Z (`GROUND_Z = 1000`, `Z_PER_FLOOR = 1`).

## 2. The V3 strategy

> **Within a floor band: painter's order (keep `LayerOrderPolicy` verbatim). Between floor bands: the hardware depth test. OIT only if that visibly fails on golden scenes.**

Concretely, in the unified pass (B0-2 `unified.transparents`):

1. **Opaques + alphaTest first** (they write depth + attributes), then all transparents in one sorted list ordered by `renderOrder` — which already encodes floor-then-band-then-slot, so the within-band contract is untouched.
2. **Flip Class B to `depthTest: true`** (keep `depthWrite: false`). Lower-floor particles behind a solid upper floor are then rejected by depth — replacing the presence-mask gating that does this job today. Candles already run this way (:2686), which is evidence the pattern works in this codebase.
3. **Soft floor gating stays shader-side where softness is authored** (splash occluders, heat shimmer edges): those consumers move from presence masks to the attribute buffer (B0-1 §2.3), not to raw depth.
4. **MRT discipline:** every transparent material outputs `gAttr = vec4(0)` (B0-1 §3.1). Additive and Normal blending both satisfy the zero-write rule; any Custom/premultiplied blending found in the B4 per-effect audit must be checked against it.

### Sequencing constraint (do not break the water sandwich early)
Group 2's post-merge position exists because **water is a post-merge screen-space composite until B5**. Folding vegetation/splashes into the in-pass transparent list before water is geometry would let water paint over them again. Therefore:
- **B4:** Group 1 moves into `unified.transparents`; Group 2 keeps its post-merge composite position but swaps presence-mask gating for attribute-buffer gating. Fire glow folds onto the same primitive here (Forward+ §12.3 — fixes the TODO §7 item 20 bug class instead of porting it).
- **B5+:** water becomes geometry; Group 2 joins the in-pass list; layers 32/33 and the composite calls retire.

### Z-headroom prerequisite (flagged for B1)
With `Z_PER_FLOOR = 1`, every transparent on a floor must sort within a 1-unit Z slice. Painter's order makes intra-band Z irrelevant, but depth *testing* against the unified depth buffer needs particles positioned inside their floor's slice with margin (bush canopies bob, splash arcs jump floors visually). **Recommendation: widen the Z stride (e.g. `Z_PER_FLOOR = 10`, floor n → Z = 1000 + 10n) as a B1 change while the bus is being wired to the graph** — a one-constant change today ([LayerOrderPolicy.js:77–78](../../../scripts/compositor-v2/LayerOrderPolicy.js)), a migration hazard later. Ortho depth is linear, so precision is not the issue; authoring margin is.

## 3. When OIT gets reconsidered (the exit ramp, pre-committed)

Adopt weighted-blended OIT (McGuire/Bavoil, single extra RGBA16F + R8 accumulation target, no sorting) **only if** a golden scene shows either:
- **O1 — cross-floor interleave artifact:** transparents from different floors that must visually interleave at the *same* depth slice (e.g. falling ash through a stairwell reading as popping when the camera crosses floor boundaries), or
- **O2 — additive-vs-normal ordering artifact:** additive glows (candles, selection) reading differently than V2 on S4 because per-floor RT isolation previously reordered them relative to Normal-blended content.

If triggered: OIT applies to the *offending band only* (per-floor-band accumulation), never the whole transparent set. This is deliberately narrow — full-scene OIT changes the look of every Normal-blended overlay and would violate golden-scene parity by construction.

## 4. Per-effect B4 checklist (the audit this spec commissions)

For each Class B effect, at migration time record in this doc: actual blend mode (incl. shader-file-local materials — cloud/ash-cloud shader files have their own `blending` sites), depth flags before/after, Z placement within the floor slice, attr-zero-write added, presence-mask reads replaced with attr reads, golden-scene diff result. No effect merges without its row filled — this table is the §14.1 principle 5 "you cannot safely rewrite what you cannot read" instrument for Class B.

## 5. Open questions

1. **Tokens:** token sprites are Normal-blended transparents owned by `TokenManager` — do they join `unified.transparents` in B4 or stay a separate composite until Phase 5 settles the content layers? Recommendation: keep separate through B4; decide with C-track.
2. **Weather (rain/snow) above overheads:** currently `MOTION_TOP`/overlay-band; verify whether weather should depth-test against roofs (probably yes — rain under a roof is a live bug class) — candidate for an early attr-buffer win.
3. **`DetectionFilterEffect` / UI-ish overlays** (selection box, movement preview): these are view-space chrome, not world content — likely exempt from depth entirely (render after post chain). Decide at B4; exemption must be explicit in the pass list, not incidental.
