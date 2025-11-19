# Transparent Canvas Bug (FIXED)

## The Problem

The renderer was configured with `alpha: true`, making the canvas transparent. Combined with the default clear alpha of 0, this resulted in a completely black (transparent) screen, even though rendering was happening correctly.

**Symptoms:**
- Black screen on load
- Test renders showed nothing
- `diagnoseCanvas()` showed `ClearAlpha: 0`
- Canvas diagnostics showed no obvious issues
- Camera and scene were configured correctly

## Root Cause

In `scripts/core/renderer-strategy.js`, all renderer creation functions used:
```javascript
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,  // <-- THIS MADE CANVAS TRANSPARENT
  powerPreference: 'high-performance'
});
```

The `alpha: true` option creates a transparent canvas. Without explicitly setting the clear alpha to 1, the renderer clears to `rgba(0, 0, 0, 0)` (transparent black), which appears as a black screen.

## The Fix

Added explicit clear color configuration in `renderer-strategy.js`:

```javascript
export function configure(renderer, options = {}) {
  // ... size and pixel ratio configuration ...
  
  // CRITICAL: Set clear color to OPAQUE black (alpha = 1)
  if (renderer.setClearColor) {
    renderer.setClearColor(0x000000, 1); // Black, fully opaque
  }
}
```

## Why Alpha: True Was Used

The `alpha: true` option was intended for potential future features:
- Overlaying THREE.js on top of PIXI (not needed - we replace PIXI entirely)
- Transparent UI elements (handled differently)
- Compositing with other canvases (not required)

Since we completely replace Foundry's PIXI canvas, we don't need transparency.

## Alternative Fixes Considered

1. **Set `alpha: false`** - Would work, but prevents potential future use cases
2. **Set `scene.background = new THREE.Color(0x000000)`** - Scene-level, but clear alpha is more fundamental
3. **Use `renderer.autoClear = false`** - Not appropriate, we want auto-clearing

## Testing

After the fix:
- `MapShine.sceneDebug.diagnoseCanvas()` should show `ClearAlpha: 1`
- `MapShine.sceneDebug.testRender()` should show green background with red square
- Normal scene rendering should work

## Related Files

- `scripts/core/renderer-strategy.js` - Renderer creation and configuration
- `scripts/utils/scene-debug.js` - Diagnostic tools that helped identify the issue
