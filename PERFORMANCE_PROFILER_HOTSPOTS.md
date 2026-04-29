# Performance profiler hotspots (mythicamachina.com)

Working list of functions and call chains visible in a **bottom-up** profiler view (**Invert call stack** + **Include idle samples**). Add any additional rows from the same capture or future runs so we can investigate each in turn.

---

## How to use this doc

1. Treat each row as a **candidate** — high self time or repeated stacks merit deeper dives.
2. Line numbers refer to **bundled or built** paths as shown in the profiler (e.g. `three.custom.js`); map to source via source maps when investigating.
3. After the list feels complete for this session, pick an item and trace: who calls it, how often per frame, and whether work can be deferred, batched, or skipped.

---

## 1. Three.js / matrix updates

| Priority (for triage) | Function | Approx. weight | Location (as in report) | Notes |
|------------------------|----------|----------------|-------------------------|--------|
| High | `updateMatrixWorld` | ~5.9% total, **high self** (~56 samples cited) | `vendor/three/three.custom.js` ~5190 | Often dominates when many objects update transforms each frame. |
| | `updateMatrixWorld` (nested / other stacks) | ~5.6%, ~4.7% (additional entries) | same file / similar stacks | Multiple tree entries suggest several hot paths into matrix updates. |

---

## 2. Main render path (`WebGLRenderer.render`)

Multiple distinct stacks into `WebGLRenderer/this.render` (~`three.custom.js` ~18131):

| Instance (as labeled in report) | Approx. weight | Notable frames in the chain |
|----------------------------------|----------------|-----------------------------|
| A | ~2.5% (24 samples) | `render` → `wrappedHealthHeartbeat` → `render` (EffectComposer) → `render` (render-loop) → `FrameRequestCallback` |
| B | ~2.1% (20 samples) | Similar; includes **`OverheadShadowsEffectV2.js`** (~2105) and **`HealthEvaluatorService.js`** (~783) |
| C | ~1.0% (9 samples) | Same renderer entry, another stack variant |

**Browser / scheduling context (roots mentioned):**

- `RefreshDriver tick`
- `Update the rendering Animation and video frame callbacks` → `FrameRequestCallback`

---

## 3. Diagnostics / heartbeat wrapping render

| Function | Location (as in report) | Role in stacks |
|----------|-------------------------|----------------|
| `wrappedHealthHeartbeat` | `core/diagnostics/HealthEvaluatorService.js` ~783 | Appears **around** render calls — verify whether it adds synchronous work on the render path or only wraps for timing. |

---

## 4. Compositor / floor pipeline (this repo)

| Function | Approx. weight | Location (as in report) |
|----------|----------------|-------------------------|
| `renderFloorRangeTo` | ~0.2% | `compositor-v2/FloorRenderBus.js` ~1124 |
| `_renderPerLevelPipeline` | ~0.2% | `compositor-v2/FloorCompositor.js` ~4700 |
| `_renderLateWorldOverlay` | ~0.2% | `compositor-v2/FloorCompositor.js` ~918 |

*Note: Small **%** here does not mean “unimportant” in absolute terms — bottom-up % is relative to the whole profile; floor work may still correlate with jank if it runs in critical frames.*

---

## 5. Effects / post-processing (this repo)

| Area | Location (as in report) | Notes |
|------|-------------------------|--------|
| Overhead shadows pass | `compositor-v2/effects/OverheadShadowsEffectV2.js` ~2105 | Linked from render stack instance B — worth correlating with full flame chart (per-frame cost vs amortized). |
| Effect composer | `EffectComposer.js` (path as shown in profiler) | Middle of chain between heartbeat wrapper and `render-loop`. |

---

## 6. Render loop orchestration

| File / concept | Notes |
|----------------|--------|
| `render-loop.js` | Named in chains into `render`; central place to audit “what runs every rAF”. |

---

## Files referenced by the report (quick index)

- `vendor/three/three.custom.js` — Three.js (matrix world, WebGLRenderer)
- `scripts/core/diagnostics/HealthEvaluatorService.js`
- `scripts/compositor-v2/effects/OverheadShadowsEffectV2.js`
- `scripts/compositor-v2/FloorRenderBus.js`
- `scripts/compositor-v2/FloorCompositor.js`
- `EffectComposer.js` (module path as bundled)
- `render-loop.js`

---

## Next steps (after the list is complete)

For each hotspot:

1. Confirm **call frequency** (once per frame vs N times) and **scene scale** (token count, lights, layers).
2. Decide: **reduce work**, **cache / skip invalid frames**, **move off hot path**, or **split heavy passes**.
3. Re-profile with the same settings for apples-to-apples comparison.

---

## Appendix — items to add from your capture

_Use this checklist while scrolling the same profile: any function with notable **Self** time or many duplicate stack heads._

- [ ] Additional `updateMatrixWorld` callers (which object types?)
- [ ] Other effects beside OverheadShadows in top stacks
- [ ] `TreeEffectV2` or token/wall batching (if they appear in your tree)
- [ ] GC / scripting (if “System” or V8 shows up with idle included)
- [ ] Layout / DOM (if any UI overlays spike)
