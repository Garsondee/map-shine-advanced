# Perspective Camera Change

**Date**: 2024-11-18  
**Reason**: Simplified camera system, better THREE.js compatibility

## Problem with Orthographic Camera

- Complex frustum calculations
- Device pixel ratio issues
- `sizeAttenuation: false` hack required
- Sprite scaling didn't work intuitively
- Constant fighting with world unit conversions

## Solution: Quasi-Orthographic Perspective Camera

### Concept
Use a **perspective camera positioned very far away** (10,000 units) with a **narrow FOV**. At this distance, perspective distortion is negligible (<1%), giving us an "orthographic-like" view but with normal THREE.js behavior.

### Benefits
1. ✅ **Sprites work naturally** - Default `sizeAttenuation: true` works correctly
2. ✅ **Simpler math** - No complex frustum calculations
3. ✅ **Standard THREE.js patterns** - Camera distance = zoom
4. ✅ **1:1 pixel mapping** - FOV calculated to match viewport
5. ✅ **Intuitive controls** - Pan = move XY, zoom = move Z

### Technical Details

#### Camera Setup
```javascript
cameraDistance = 10000;
FOV = 2 * atan(viewportHeight / (2 * distance)) * (180 / PI)
camera.position.set(centerX, centerY, cameraDistance);
// CRITICAL: Set rotation directly (lookAt doesn't work reliably)
camera.rotation.set(-Math.PI / 2, 0, 0); // -90° X = looking down
camera.up.set(0, 0, -1); // Up vector for rotated camera
```

#### Pan (Move viewport)
```javascript
camera.position.x += deltaX;
camera.position.y += deltaY;
```

#### Zoom (Get closer/farther)
```javascript
newDistance = currentDistance / zoomFactor;
camera.position.z = newDistance;
```

### Token Rendering
- Sprites use default `sizeAttenuation: true`
- Scale in world units (100x100 for 100px grid)
- Natural perspective scaling (minimal at distance 10000)

### Files Changed
- `scripts/scene/composer.js` - Camera setup, pan, zoom, resize
- `scripts/scene/token-manager.js` - Removed `sizeAttenuation: false`

## Expected Results

After reload, tokens should:
- ✅ Appear at correct size (~100x100 pixels for 1x1 grid tokens)
- ✅ Position correctly (centered on grid squares)
- ✅ Scale naturally with zoom
- ✅ No more "too small" or "wrong position" issues

## Verification

```javascript
const camera = canvas.mapShine.sceneComposer.camera;
console.log("Camera type:", camera.type); // Should be "PerspectiveCamera"
console.log("FOV:", camera.fov.toFixed(2)); // Should be ~7-8 degrees
console.log("Distance:", camera.position.z); // Should be 10000
console.log("Looking at:", {
  x: camera.position.x,
  y: camera.position.y
});
```

## Perspective Distortion Analysis

At 10,000 units distance with tokens at z=10 vs z=20:
- Angular difference: 0.0001 radians
- Screen size difference: <0.1%
- **Practically indistinguishable from orthographic**

## Future Benefits

- Easier to add 3D elements later (elevated terrain, flying tokens)
- Natural parallax effects
- Simpler fog of war calculations
- Standard camera controls (orbiting, if we want it later)
