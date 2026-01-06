# Token Rendering - Testing Guide

**Status**: Ready for Testing  
**Date**: 2024-11-18

---

## 🎯 What Was Implemented

The `TokenManager` syncs Foundry VTT tokens to THREE.js sprites using Foundry's hook system.

### Features

1. **Hook-Based Synchronization** - Reacts to token create/update/delete events
2. **Coordinate Conversion** - Converts Foundry's top-left origin to THREE.js center origin
3. **Texture Loading** - Loads and caches token textures
4. **Elevation Support** - Maps token elevation to z-position
5. **Visibility Handling** - Respects hidden tokens (GM-only visibility)
6. **Texture Caching** - Reuses textures for performance

---

## 🧪 Testing Steps

### 1. Load a Scene with Tokens

Open Foundry VTT and load a scene that has tokens already placed on it.

### 2. Check Console for Initialization

```
[TokenManager] TokenManager initialized
[TokenManager] Canvas ready, syncing all tokens
[TokenManager] Syncing X tokens
[TokenManager] Created token sprite: [tokenId] at (x, y, z=...)
```

### 3. Verify Tokens Render

Tokens should now appear in the THREE.js scene at their correct positions.

**Expected**: Token sprites visible above the ground plane, below any overhead tiles.

### 4. Test Token Creation

Create a new token in Foundry (drag from actor sidebar or create manually).

**Expected Console Output**:
```
[TokenManager] Token created: [tokenId]
[TokenManager] Created token sprite: [tokenId] at (x, y, z=...)
```

**Expected Visual**: Token immediately appears in THREE.js scene.

### 5. Test Token Movement

Click and drag a token to move it.

**Expected Console Output**:
```
[TokenManager] Token updated: [tokenId]
[TokenManager] Updated token sprite: [tokenId]
```

**Expected Visual**: Token sprite smoothly follows Foundry token position.

### 6. Test Token Deletion

Delete a token from the scene.

**Expected Console Output**:
```
[TokenManager] Token deleted: [tokenId]
[TokenManager] Removed token sprite: [tokenId]
```

**Expected Visual**: Token sprite disappears from THREE.js scene.

### 7. Test Token Elevation

Change a token's elevation (right-click → Configure → Elevation).

**Expected Console Output**:
```
[TokenManager] Token updated: [tokenId]
[TokenManager] Updated token sprite: [tokenId]
```

**Expected Visual**: Token z-position changes (may be hard to see without other reference points).

### 8. Test Hidden Tokens (GM Only)

1. Toggle a token's visibility (right-click → Toggle Visibility)
2. As **GM**: Token should still be visible
3. As **Player**: Token should disappear

---

## 🔍 Debugging Console Commands

Access the TokenManager from the browser console:

```javascript
// Get TokenManager instance
const tm = canvas.mapShine.tokenManager;

// Get statistics
console.log(tm.getStats());
// Output: {tokenCount: 5, cachedTextures: 3, initialized: true, hooksRegistered: true}

// Get all token sprites
const sprites = tm.getAllTokenSprites();
console.log(`${sprites.length} token sprites:`, sprites);

// Get specific token sprite by ID
const tokenId = "your-token-id-here";
const sprite = tm.getTokenSprite(tokenId);
console.log("Token sprite:", sprite);

// Check token position
console.log("Position:", sprite.position);
// Output: Vector3 {x: 500, y: 300, z: 10}

// Check if sprite is visible
console.log("Visible:", sprite.visible);

// List all Foundry tokens
const foundryTokens = canvas.tokens.placeables;
console.log(`${foundryTokens.length} Foundry tokens:`, foundryTokens);

// Compare Foundry token data with THREE.js sprite
const foundryToken = foundryTokens[0];
const threeSprite = tm.getTokenSprite(foundryToken.id);
console.log("Foundry position:", foundryToken.document.x, foundryToken.document.y);
console.log("THREE position:", threeSprite.position.x, threeSprite.position.y);
```

---

## 🐛 Common Issues & Solutions

### Issue: No tokens visible

**Possible Causes**:
1. TokenManager not initialized
2. Hooks not firing
3. Textures not loading
4. Z-ordering issue (tokens behind ground)

**Debug**:
```javascript
// Check if TokenManager is initialized
console.log(canvas.mapShine.tokenManager.getStats());

// Check if tokens exist in scene
console.log(canvas.mapShine.tokenManager.getAllTokenSprites());

// Check scene children (should include token sprites)
console.log(canvas.mapShine.sceneComposer.scene.children);
```

### Issue: Tokens in wrong position

**Possible Causes**:
1. Coordinate conversion error
2. Scene dimensions mismatch

**Debug**:
```javascript
// Get first token
const token = canvas.tokens.placeables[0];
const sprite = canvas.mapShine.tokenManager.getTokenSprite(token.id);

// Compare positions
console.log("Foundry (top-left):", token.document.x, token.document.y);
console.log("THREE (center):", sprite.position.x, sprite.position.y);
console.log("Expected THREE:", 
  token.document.x + token.document.width / 2, 
  token.document.y + token.document.height / 2
);
```

### Issue: Tokens not updating when moved

**Possible Causes**:
1. Hooks not registered
2. Update handler not firing

**Debug**:
```javascript
// Check if hooks are registered
console.log(canvas.mapShine.tokenManager.hooksRegistered);

// Manually trigger update
const token = canvas.tokens.placeables[0];
canvas.mapShine.tokenManager.updateTokenSprite(
  token.document, 
  {x: token.document.x, y: token.document.y}
);
```

### Issue: Texture not loading

**Possible Causes**:
1. Invalid texture path
2. CORS issue
3. Texture loader error

**Debug**:
```javascript
// Check token texture path
const token = canvas.tokens.placeables[0];
console.log("Texture path:", token.document.texture.src);

// Check texture cache
const tm = canvas.mapShine.tokenManager;
console.log("Cached textures:", tm.textureCache.size);

// List cached texture paths
for (const [path, texture] of tm.textureCache.entries()) {
  console.log("Cached:", path, texture);
}
```

---

## 📊 Performance Testing

### Token Count Test

```javascript
// Count tokens
const tokenCount = canvas.mapShine.tokenManager.getStats().tokenCount;
console.log(`Rendering ${tokenCount} tokens`);

// Check FPS
const fps = canvas.mapShine.renderLoop.getFPS();
console.log(`FPS: ${fps}`);

// Check frame time
const frameCount = canvas.mapShine.renderLoop.getFrameCount();
console.log(`Frame count: ${frameCount}`);
```

**Expected Performance**:
- 10 tokens: 60 FPS
- 50 tokens: 55+ FPS
- 100 tokens: 45+ FPS

### Memory Usage

```javascript
// Check sprite count
const stats = canvas.mapShine.tokenManager.getStats();
console.log("Token sprites:", stats.tokenCount);
console.log("Cached textures:", stats.cachedTextures);

// Check THREE.js memory info (if available)
console.log("Renderer info:", canvas.mapShine.renderer.info);
```

---

## ✅ Success Criteria

Token implementation is successful if:

1. ✅ Tokens appear at correct positions
2. ✅ Tokens update when moved in Foundry
3. ✅ New tokens appear immediately when created
4. ✅ Deleted tokens disappear from scene
5. ✅ Elevation changes affect z-position
6. ✅ Hidden tokens only visible to GM
7. ✅ No console errors during token operations
8. ✅ Performance acceptable (55+ FPS with 50 tokens)

---

## 🚀 Next Steps

Once tokens are working:

1. **Test edge cases**:
   - Tokens with missing textures
   - Tokens with invalid positions
   - Very large tokens
   - Rotated tokens

2. **Add token effects**:
   - Status effect icons
   - Health bars
   - Name plates
   - Target indicators

3. **Optimize**:
   - Batch updates
   - Frustum culling
   - LOD for distant tokens

4. **Move to TileManager**:
   - Apply same pattern to tiles
   - Handle overhead tiles
   - Support tile rotation

---

**Token rendering is the foundation. Get this right, everything else builds on it.**
