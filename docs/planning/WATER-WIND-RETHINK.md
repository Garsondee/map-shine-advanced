# Water Wind System Rethink

## Problem Statement

The specular highlight (and potentially other water elements) ping-pong / boomerang — they appear to travel in one direction then reverse, rather than flowing consistently downwind. Every previous attempt to fix this has failed because we were patching symptoms without understanding the root cause. We need to establish ground truth about what `uWindDir` actually means, verify it visually, and redesign the specular slope around provably-correct wind semantics.

**Before writing any more shader code, we need a debug arrow.**

---

## Step 1 — Wind Direction Debug Arrow (DO THIS FIRST)

Add a red arrow HTML overlay to `WaterEffectV2.js` that renders on-screen every frame, showing exactly which direction the CPU-side `windDirX / windDirY` vector points. This is the ground truth — it tells us what the shader is actually receiving.

### Implementation

Add a `_windDebugArrow` DOM element to `WaterEffectV2`, updated in the `update()` method:

```js
// In _initDebugArrow() — called from constructor or first update:
const el = document.createElement('div');
el.id = 'ms-wind-debug-arrow';
el.style.cssText = `
  position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
  width: 80px; height: 80px; pointer-events: none; z-index: 99999;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.55); border-radius: 50%; border: 2px solid #f00;
`;
// Inner arrow SVG — rotate transform set each frame
el.innerHTML = `<svg width="60" height="60" viewBox="-1 -1 2 2">
  <line id="ms-wind-shaft" x1="0" y1="0.6" x2="0" y2="-0.5"
        stroke="red" stroke-width="0.12"/>
  <polygon id="ms-wind-head" points="0,-0.9 -0.2,-0.45 0.2,-0.45"
           fill="red"/>
</svg>
<div id="ms-wind-label" style="position:absolute;bottom:2px;font:10px monospace;color:#fff;text-align:center;width:100%"></div>`;
document.body.appendChild(el);
this._windDebugArrow = el;

// In update(), after windDirX/windDirY are resolved:
if (this._windDebugArrow && this.params.debugWindArrow) {
  // windDirX/Y are in Foundry Y-down space.
  // Screen Y is also down, so the rotation angle directly maps:
  // atan2(x, -y) gives degrees from screen-up (north) clockwise.
  const angleDeg = Math.atan2(windDirX, -windDirY) * (180 / Math.PI);
  const svg = this._windDebugArrow.querySelector('svg');
  if (svg) svg.style.transform = `rotate(${angleDeg}deg)`;
  const lbl = this._windDebugArrow.querySelector('#ms-wind-label');
  if (lbl) lbl.textContent = `${Math.round(angleDeg)}° spd:${windSpeed01.toFixed(2)}`;
  this._windDebugArrow.style.display = 'flex';
} else if (this._windDebugArrow) {
  this._windDebugArrow.style.display = 'none';
}
```

Add `debugWindArrow: false` to the params schema (boolean toggle in the Debug folder).

### What to Verify

With the arrow visible, observe:
1. **Does the arrow point in the visually expected "upwind from" direction?** i.e. if wind is blowing right-to-left on screen, the arrow should point left.
2. **Does the arrow direction agree with cloud drift?** Clouds are the ground-truth reference — clouds move in the direction the arrow points.
3. **Does `uWindOffsetUv` accumulate in the same direction as the arrow?** Log `_windOffsetUvX / Y` and compare to `windDirX / Y` each frame.

---

## Step 2 — Audit the Coordinate Space Confusion

This is likely the real root cause of the boomerang and wrong-direction problems.

### Known Coordinate Systems

| System | Origin | Y axis | Used by |
|--------|--------|--------|---------|
| Foundry canvas | top-left | Y-down | Token/tile positions, weather |
| Three.js world | bottom-left | Y-up | Camera, meshes |
| Scene UV `sceneUv` | top-left | Y-down | Shader sampling |
| Screen UV `vUv` | bottom-left | Y-up | WebGL default |

### The Wind Vector Path

```
WeatherController / CloudEffectV2
  → windDirX, windDirY  (Foundry Y-down space)
    → CPU: uWindDir.set(windDirX, windDirY)
      → GPU: uWindDir uniform (vec2)
        → shader uses windF = uWindDir, normalizes it
```

### Critical Unknown: Does the shader agree on Y convention?

In `calculateWave()` / `addWave()`:
```glsl
vec2 wind = vec2(windF.x, windF.y);  // no Y flip
```

In `warpUv()` (main shader):
```glsl
vec2 windDir = vec2(windF.x, windF.y);  // no Y flip
```

In the V2 distortion sub-shader (`WaterEffectV2.js` inline shader):
```glsl
vec2 windDir = vec2(windF.x, -windF.y);  // Y IS FLIPPED
```

**This inconsistency is almost certainly contributing to the problem.** The distortion sub-shader flips Y while the main shader does not. Depending on which shader is used for which visual element, they will move in opposite directions.

### What to Audit

- [ ] Confirm what coordinate space `sceneUv` lives in (it's derived from `screenUvToFoundry()` → `foundryToSceneUv()` — is the final UV Y-down or Y-up?)
- [ ] Check whether `vUv` (the raw screen UV passed to the main shader) is Y-up (WebGL default) or Y-down
- [ ] Verify that `uWindOffsetUv` is subtracted from (not added to) `sceneUv` in sampling calls, and confirm the sign produces the correct travel direction
- [ ] Find every place the shader normalizes `uWindDir` and list whether it flips Y or not — they must all be consistent

---

## Step 3 — Redesign Specular Slope from Ground Truth

Only start this after the debug arrow confirms we understand the wind vector, and after the coordinate audit is complete.

### Design Principles (revised)

1. **Never derive slope from oscillating fields.** Wave gradients (`waveGrad2D`) and distortion vectors (`combinedVec`) oscillate in direction as wave trains interfere — they will always ping-pong unless the slope is taken from a single uncontested wave (not a sum).

2. **Use `uWindOffsetUv` for position — not `uWindTime` for velocity.** `uWindTime` is a monotonically growing scalar, but when used to offset noise domain coordinates it just translates the pattern at constant speed. That alone doesn't prevent the *gradient* of the pattern from reversing. `uWindOffsetUv` is a position accumulator in wind-direction space, which means sampling at `sceneUv - uWindOffsetUv` produces a pattern that scrolls exactly in the wind direction — the gradient of that pattern will predominantly point downwind.

3. **The correct advection formula for scroll-locked patterns:**
   ```glsl
   // Pattern moves with the wind: sample at position-minus-offset.
   // As uWindOffsetUv grows rightward (wind blows right), the lookup
   // moves left, so the texture appears to scroll right. Correct.
   vec2 scrollUv = sceneUv - uWindOffsetUv * scrollScale;
   float h = fbmNoise(scrollUv * spatialScale);
   ```
   The finite-difference slope of `fbmNoise(scrollUv)` with respect to screen position is just the spatial gradient of the noise texture at that scroll position — it does NOT flip direction over time because the scroll is monotonic.

4. **Wind basis must be consistent.** All functions that decompose into `(windBasis, windPerp)` must use the same Y convention as `sceneUv`. Since `sceneUv` is Y-down (derived from Foundry space), and `uWindDir` is also Y-down (from `WeatherController`), no Y-flip should be applied to `windDir` inside any function that works in `sceneUv` space.

5. **The specular slope should only control the tilt of the normal, not the highlight position.** A slope vector `(sx, sy)` means the surface is tilted so water flows in that direction. For the specular highlight to appear on the downwind side of each ripple, the slope should point *away from* the viewer — i.e., slightly into the wind.

### Proposed New Architecture

```
specFlowSlope(sceneUv) =
    spatial_gradient(fbmNoise(sceneUv - uWindOffsetUv * k))
```

This is simpler than the previous attempt. The noise texture scrolls with the wind (monotonically). The spatial gradient of that texture at any pixel is just the local tilt of the noise surface — it produces a normal field that has no directional bias, but the *pattern of normals* travels consistently downwind, so the specular highlights appear to move with the water.

There is no need for a "constant downwind bias" because we're not trying to force the highlight to tilt toward wind — we just want the pattern of tilts to travel in one direction. `uWindOffsetUv` provides that.

---

## Step 4 — Implementation Plan (after Steps 1–3 are verified)

1. Implement and enable the debug arrow (Step 1)
2. Run in-app, compare arrow to cloud drift, fix any Y-flip/direction issues found (Step 2)
3. Implement new `specFlowSlope2D` using scroll-locked noise (Step 3 formula)
4. Wire as Mode 4, make default
5. Remove the failed Mode 4 implementation (`specFlowAlignedSlope2D`) or replace in-place

---

## Open Questions (answer with the debug arrow)

- Q1: Does `uWindDir` in the shader point the direction wind blows *toward*, or the direction it comes *from*?
- Q2: In scene UV space (Y-down), if wind blows toward the right of the screen, is `windDirX` positive?
- Q3: Does `uWindOffsetUv` accumulate in the same direction as `uWindDir`? (Should be yes — advection offset should grow downwind)
- Q4: When we do `sceneUv - uWindOffsetUv`, does the visible pattern scroll in the wind direction or opposite?

---

## Files to Modify

- `scripts/compositor-v2/effects/WaterEffectV2.js` — debug arrow DOM element, `debugWindArrow` param
- `scripts/compositor-v2/effects/water-shader.js` — new `specFlowSlope2D()`, Mode 4 branch

## Files to Leave Alone

- `specFlowAlignedSlope2D` currently in water-shader.js — keep as dead code (Mode 4 branch points to it but it's not the default), will be replaced
