# Drop Handler Solution - Complete THREE.js Takeover

**Problem**: Tokens dragged from sidebar weren't being created because PIXI canvas had `pointerEvents: 'none'`.

**Wrong Solution** ❌: Enable PIXI pointer events
- Would create BOTH PIXI and THREE.js tokens
- Hybrid rendering (messy)
- Against our architectural goal of complete THREE.js control

**Right Solution** ✅: Intercept drops ourselves, create Foundry documents directly
- PIXI canvas remains fully disabled (`opacity: 0`, `pointerEvents: 'none'`)
- THREE.js canvas receives all interactions
- We create Foundry token documents via API
- Hooks trigger THREE.js sprite creation
- **Only** THREE.js tokens exist (no PIXI rendering)

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    User Action                      │
│         Drag Actor from Sidebar → Drop             │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│              THREE.js Canvas                        │
│         (z-index: 1, pointerEvents: auto)           │
│                                                     │
│  ┌───────────────────────────────────────────┐    │
│  │         DropHandler                       │    │
│  │  • Intercepts 'drop' event                │    │
│  │  • Parses drop data                       │    │
│  │  • Converts viewport → canvas coords       │    │
│  │  • Creates Foundry TokenDocument via API  │    │
│  └───────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│          Foundry Token Document Created            │
│        (data layer only, no PIXI rendering)        │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│          'createToken' Hook Fires                   │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│              TokenManager                           │
│  • Listens to hook                                 │
│  • Creates THREE.Sprite                            │
│  • Loads texture                                   │
│  • Positions sprite at (tokenDoc.x, tokenDoc.y)    │
│  • Adds to THREE.js scene                          │
└─────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│         Token Visible in THREE.js Scene            │
│              (No PIXI rendering)                    │
└─────────────────────────────────────────────────────┘
```

---

## Implementation

### 1. **DropHandler** (`scripts/foundry/drop-handler.js`)

Intercepts drop events on THREE.js canvas and creates Foundry documents:

```javascript
class DropHandler {
  async handleActorDrop(event, data) {
    // 1. Import actor from drop data
    let actor = await Actor.implementation.fromDropData(data);
    
    // 2. Prepare token document
    const tokenData = await actor.getTokenDocument({
      hidden: game.user.isGM && event.altKey,
      sort: Math.max(canvas.tokens.getMaxSort() + 1, 0)
    }, { parent: canvas.scene });
    
    // 3. Calculate position (center on drop, snap to grid)
    const position = this.getTokenDropPosition(tokenData, 
      { x: data.x, y: data.y }, 
      { snap: !event.shiftKey }
    );
    
    // 4. Create token document (triggers 'createToken' hook)
    await tokenData.constructor.create(tokenData, { parent: canvas.scene });
  }
}
```

### 2. **TokenManager** (`scripts/scene/token-manager.js`)

Listens to hooks and creates THREE.js sprites:

```javascript
class TokenManager {
  setupHooks() {
    Hooks.on('createToken', (tokenDoc, options, userId) => {
      this.createTokenSprite(tokenDoc);
    });
  }
  
  createTokenSprite(tokenDoc) {
    const sprite = new THREE.Sprite(material);
    sprite.position.set(
      tokenDoc.x + tokenDoc.width / 2,  // Center
      tokenDoc.y + tokenDoc.height / 2,
      TOKEN_BASE_Z + tokenDoc.elevation
    );
    this.scene.add(sprite);
  }
}
```

### 3. **Canvas Setup** (`scripts/foundry/canvas-replacement.js`)

```javascript
// PIXI canvas: hidden and non-interactive
pixiCanvas.style.opacity = '0';
pixiCanvas.style.pointerEvents = 'none';

// THREE.js canvas: visible and interactive
threeCanvas.style.zIndex = '1';
threeCanvas.style.pointerEvents = 'auto';

// Initialize managers
tokenManager = new TokenManager(threeScene);
tokenManager.initialize();

dropHandler = new DropHandler(threeCanvas);
dropHandler.initialize();
```

---

## Data Flow

### Token Creation

1. **User drags actor** from sidebar
2. **User drops** on THREE.js canvas
3. **DropHandler intercepts** `drop` event
4. **DropHandler creates** `TokenDocument` via Foundry API
5. **Foundry fires** `createToken` hook
6. **TokenManager receives** hook
7. **TokenManager creates** THREE.Sprite
8. **Token appears** in THREE.js scene

### Token Movement

1. **User drags** token in Foundry UI
2. **Foundry updates** `TokenDocument` position
3. **Foundry fires** `updateToken` hook
4. **TokenManager receives** hook with changes
5. **TokenManager updates** sprite position
6. **Token moves** in THREE.js scene

---

## Key Benefits

### ✅ Complete Control
- **No PIXI rendering** at all
- Only THREE.js sprites exist
- Full control over visuals

### ✅ Clean Architecture
- Clear separation: Foundry = data, THREE.js = visuals
- No hybrid PIXI/THREE.js rendering
- Hook-based reactivity

### ✅ Foundry Compatible
- Uses official Foundry API
- Creates real `TokenDocument` objects
- Compatible with modules expecting token documents

### ✅ Feature Complete
- Supports Alt-drag for hidden tokens
- Supports Shift-drag for no-snap
- Permission checks
- Compendium actors
- Grid snapping

---

## Testing

### Test Actor Drop
1. Open Foundry with Map Shine enabled
2. Drag an actor from sidebar
3. Drop on canvas
4. **Expected**: Token appears in THREE.js scene, no PIXI token

### Check Console
```javascript
// Should see:
[DropHandler] Drop event received
[DropHandler] Handling actor drop
[DropHandler] Creating token for actor: Character at (500, 300)
[TokenManager] Token created: [id]
[TokenManager] Created token sprite: [id] at (500, 300, z=10)
```

### Verify Data
```javascript
// Foundry has the token document
console.log(canvas.tokens.placeables.length); // Should be > 0

// THREE.js has the sprite
console.log(canvas.mapShine.tokenManager.getStats().tokenCount); // Should match

// No PIXI rendering
console.log(canvas.app.view.style.opacity); // Should be '0'
console.log(canvas.app.view.style.pointerEvents); // Should be 'none'
```

---

## Files Created/Modified

### Created
- `scripts/foundry/drop-handler.js` - Intercepts drops, creates Foundry documents

### Modified
- `scripts/foundry/canvas-replacement.js` - Integrated DropHandler, kept PIXI disabled
- `scripts/scene/token-manager.js` - Already hooked into `createToken`

---

## Future Enhancements

### Tile Support
Same pattern as tokens:
1. DropHandler intercepts tile drops
2. Creates `TileDocument` via Foundry API
3. `createTile` hook fires
4. TileManager creates THREE.js sprite

### Click/Select Interaction
Need to implement raycasting on THREE.js scene:
1. User clicks canvas
2. Raycast to find clicked sprite
3. Select corresponding Foundry token
4. Trigger Foundry selection logic

### Context Menu
Right-click on THREE.js sprite:
1. Raycast to find sprite
2. Get Foundry token document
3. Show Foundry context menu

---

## Summary

**We now have complete control:**
- ✅ PIXI fully disabled (no rendering)
- ✅ THREE.js handles all visuals
- ✅ DropHandler creates Foundry documents
- ✅ TokenManager syncs to THREE.js
- ✅ No hybrid rendering
- ✅ Clean separation of concerns

**This is the correct approach for total THREE.js takeover.**
