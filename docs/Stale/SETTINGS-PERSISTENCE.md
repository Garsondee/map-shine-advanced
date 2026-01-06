# Settings Persistence System

## Overview

Map Shine Advanced uses a sophisticated three-tier settings persistence system designed to handle hundreds of parameters efficiently while respecting the needs of Map Makers, GMs, and Players.

## Architecture

### Three-Tier Hierarchy

```
┌─────────────────────────────────────────────────┐
│         Map Maker (Author)                      │
│  • Baseline settings distributed with scene     │
│  • Stored in scene.flags['map-shine-advanced']  │
│  • Defines the "artistic vision"                │
└──────────────────┬──────────────────────────────┘
                   │ Overrides ↓
┌──────────────────┴──────────────────────────────┐
│         GM (Game Master)                        │
│  • Temporary tweaks for their table             │
│  • Stored in scene.flags['map-shine-advanced']  │
│  • Can be reverted to Map Maker original        │
└──────────────────┬──────────────────────────────┘
                   │ Overrides ↓
┌──────────────────┴──────────────────────────────┐
│         Player (End User)                       │
│  • Performance/disable controls only            │
│  • Stored client-local (not distributed)        │
│  • Final say over their visual experience       │
└─────────────────────────────────────────────────┘
```

### Data Storage Locations

**Scene Flags** (distributed with scene):
```javascript
scene.flags['map-shine-advanced'] = {
  enabled: true,
  settings: {
    mapMaker: {
      version: '0.2.0',
      effects: {
        specular: {
          enabled: true,
          intensity: 0.5,
          roughness: 0.3,
          // ... all effect parameters
        }
      },
      renderer: { /* ... */ },
      performance: { /* ... */ }
    },
    gm: {
      // Same structure as mapMaker
      // Only contains overridden values
      effects: {
        specular: {
          intensity: 0.7  // GM bumped this up
        }
      }
    },
    player: {} // Reserved for future use
  }
};
```

**Client Settings** (local, not distributed):
```javascript
game.settings.get('map-shine-advanced', 'scene-{sceneId}-player-overrides')
// Returns:
{
  specular: true,  // enabled/disabled only
  cloudShadows: false,  // player disabled this
  // ... other effects
}
```

## How It Works

### Effect Registration

When an effect registers with the UI, it provides a **control schema**:

```javascript
// In SpecularEffect.js
static getControlSchema() {
  return {
    enabled: true,
    parameters: {
      intensity: {
        type: 'slider',
        label: 'Shine Intensity',
        min: 0,
        max: 2,
        step: 0.01,
        default: 0.5,
        throttle: 100
      },
      // ... more parameters
    }
  };
}
```

### Loading Parameters

When the UI initializes, it loads parameters following the three-tier hierarchy:

```javascript
loadEffectParameters(effectId, schema) {
  // 1. Start with Map Maker settings
  let params = allSettings.mapMaker?.effects?.[effectId] || {};
  
  // 2. Apply GM overrides if in GM mode
  if (settingsMode === 'gm' && allSettings.gm?.effects?.[effectId]) {
    params = { ...params, ...allSettings.gm.effects[effectId] };
  }
  
  // 3. Apply player overrides (disable only)
  if (!game.user.isGM) {
    const playerOverrides = game.settings.get(...);
    if (playerOverrides[effectId] !== undefined) {
      params.enabled = playerOverrides[effectId];
    }
  }
  
  return params;
}
```

### Saving Parameters

**Batched Save System** - Avoids excessive Foundry scene flag writes:

```javascript
// On parameter change:
onChange(effectId, paramId, value) {
  // 1. Update effect immediately
  effect.params[paramId] = value;
  
  // 2. Queue for save (batched)
  this.queueSave(effectId);
}

// UI loop (15 Hz):
async flushSaveQueue() {
  // Only save if debounce time passed (1 second)
  if (now - lastSave < 1000) return;
  
  // Save all queued effects in one batch
  for (const effectId of saveQueue) {
    await saveEffectParameters(effectId);
  }
}
```

**Save Targets** - Respects user role and mode:

```javascript
async saveEffectParameters(effectId) {
  if (game.user.isGM) {
    if (settingsMode === 'mapMaker') {
      // Save to Map Maker tier (baseline)
      allSettings.mapMaker.effects[effectId] = params;
    } else if (settingsMode === 'gm') {
      // Save to GM override tier
      allSettings.gm.effects[effectId] = params;
    }
    await scene.setFlag('map-shine-advanced', 'settings', allSettings);
  } else {
    // Players save enabled/disabled only to client settings
    playerOverrides[effectId] = params.enabled;
    await game.settings.set(..., playerOverrides);
  }
}
```

## UI Controls

### Mode Switcher (GM Only)

```javascript
// Scene Setup section in Tweakpane
setupFolder.addBinding(modeParams, 'mode', {
  label: 'Settings Mode',
  options: {
    'Map Maker': 'mapMaker',
    'GM Override': 'gm'
  }
}).on('change', (ev) => {
  this.setSettingsMode(ev.value);
  // Reloads all effect parameters from new tier
});
```

### Revert Button (GM Only)

```javascript
// Revert GM overrides back to Map Maker original
setupFolder.addButton({
  title: 'Revert to Original'
}).on('click', () => {
  this.revertToMapMaker();
  // Clears GM tier and reloads all effects
});
```

## Performance Optimizations

### 1. Batched Saves
- Parameters queued for save
- Flushed every 1 second (debounced)
- Multiple effects saved in one scene update

### 2. Throttled UI Events
- Slider `input`: 100ms throttle
- Boolean toggle: 50-100ms throttle
- Prevents excessive uniform writes

### 3. Decoupled UI Loop
- UI updates at 15 Hz (vs render at 30-60 Hz)
- Saves processed during UI frames
- No impact on render performance

### 4. Efficient Flag Writes
- Scene flags written atomically
- No redundant writes for unchanged values
- Client settings use Foundry's built-in debouncing

## Handling Hundreds of Parameters

### Schema-Driven Architecture
Effects define their own schemas - UI auto-generates controls:

```javascript
// Effect class defines parameters once
static getControlSchema() { /* ... */ }

// UI auto-generates all controls
uiManager.registerEffect(id, name, schema, callback);
```

**Benefits**:
- Add/remove parameters without breaking UI
- Controls always match effect parameters
- Easy to version and migrate
- No manual synchronization needed

### Sparse Storage
Only **changed** values stored in GM tier:

```javascript
// Map Maker defined 30 parameters
mapMaker.effects.specular = { /* 30 params */ }

// GM only changed 2 - only store those 2
gm.effects.specular = {
  intensity: 0.7,
  roughness: 0.4
}
// Saves 93% space for this override
```

### Scene Flag Limits
Foundry scene flags have no hard limit, but best practices:
- **Typical effect**: 20-40 parameters × 4 bytes each = ~160 bytes
- **100 effects**: ~16 KB per tier (very safe)
- **Worst case** (all effects, all tiers): ~50 KB (still tiny)

JSON serialization is efficient; no concerns with hundreds of parameters.

## Migration System

### Version Tracking
```javascript
settings.mapMaker.version = '0.2.0';

// On load, check version
if (oldVersion !== currentVersion) {
  migrateSettings(oldSettings);
}
```

### Future Migration Example
```javascript
function migrateSettings(oldSettings) {
  const fromVersion = oldSettings.version || '0.1.0';
  
  if (fromVersion === '0.1.0') {
    // Rename parameter
    for (const [effectId, params] of Object.entries(oldSettings.effects)) {
      if (params.shininess !== undefined) {
        params.intensity = params.shininess;
        delete params.shininess;
      }
    }
  }
  
  oldSettings.version = CURRENT_VERSION;
  return oldSettings;
}
```

## Usage Examples

### Map Maker Workflow
```javascript
// 1. GM enables Map Shine for scene
await sceneSettings.enable(scene);

// 2. GM switches to Map Maker mode
uiManager.setSettingsMode('mapMaker');

// 3. GM tweaks effects
// (all changes saved to mapMaker tier)

// 4. GM exports scene
// (settings travel with scene automatically)
```

### GM Customization Workflow
```javascript
// 1. Load Map Maker's scene
// (mapMaker tier loaded automatically)

// 2. Switch to GM mode
uiManager.setSettingsMode('gm');

// 3. Tweak effects
// (changes saved to gm tier as overrides)

// 4. (Optional) Revert to original
await uiManager.revertToMapMaker();
```

### Player Performance Control
```javascript
// 1. Player opens simplified UI
// (future feature - not yet implemented)

// 2. Disable heavy effects
// (saved to client settings only)

// 3. Settings persist across sessions
// (but don't travel to other clients)
```

## Debugging

### Console Helpers

```javascript
// View current settings
const scene = canvas.scene;
const settings = scene.getFlag('map-shine-advanced', 'settings');
console.log(settings);

// View player overrides
const overrides = game.settings.get('map-shine-advanced', `scene-${scene.id}-player-overrides`);
console.log(overrides);

// Export current as defaults
MapShine.uiManager.exportCurrentAsDefaults();
// (prints JSON for pasting into effect class)
```

### Logging

Enable debug mode to see persistence activity:
```javascript
game.settings.set('map-shine-advanced', 'debug-mode', true);

// Logs show:
// - "Loaded parameters for specular: {...}"
// - "Saved specular to Map Maker tier"
// - "Flushing save queue: 3 effect(s)"
```

## Best Practices

### For Effect Developers

**DO**:
- ✅ Define schema in effect class static method
- ✅ Use descriptive parameter names (not `val1`, `val2`)
- ✅ Set sensible defaults in schema
- ✅ Use throttle to reduce save frequency
- ✅ Test with many parameters (50+)

**DON'T**:
- ❌ Hardcode parameter lists in UI code
- ❌ Save on every `input` event (use throttle)
- ❌ Store redundant data (derive from other params when possible)
- ❌ Use deeply nested objects (keep flat where possible)

### For Map Makers

**DO**:
- ✅ Use Map Maker mode when creating baseline
- ✅ Test settings before distributing scene
- ✅ Document your artistic intent (future: scene notes)

**DON'T**:
- ❌ Use GM mode for baseline (use Map Maker)
- ❌ Forget to save before exporting scene
- ❌ Assume all GMs will keep your exact settings

### For GMs

**DO**:
- ✅ Use GM mode for table-specific tweaks
- ✅ Revert to original if unsure about changes
- ✅ Communicate changes to players if dramatic

**DON'T**:
- ❌ Modify Map Maker tier unless you're the original author
- ❌ Forget you can always revert
- ❌ Blame Map Maker for your own overrides

## Future Enhancements

### Planned Features
- [ ] Preset save/load system
- [ ] Settings import/export as JSON files
- [ ] Copy/paste settings between effects
- [ ] Simplified player UI
- [ ] Undo/redo system (session-only)
- [ ] Scene templates library

### Under Consideration
- [ ] Settings diff viewer (Map Maker vs GM vs Current)
- [ ] Automatic migration testing
- [ ] Settings validation before scene export
- [ ] Cloud backup integration (controversial)

## Technical Notes

### Why Scene Flags?
- Automatically distributed with scene
- Versioned with scene (undo/redo)
- Exportable with scene
- No additional infrastructure needed
- Foundry handles synchronization

### Why Client Settings for Players?
- Not every player wants same tweaks
- Prevents players from "breaking" GM's vision
- Doesn't bloat scene data with per-player preferences
- Foundry's built-in sync handles updates

### Why Batched Saves?
- Foundry scene updates trigger network sync
- Dragging slider = 10+ updates/second
- Batching reduces network traffic 95%
- 1 second debounce feels instant to users

---

**Last Updated**: 2024-11-18  
**Version**: 0.2.0  
**Status**: Implemented ✅
