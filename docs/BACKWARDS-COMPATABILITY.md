# Map Shine v2.0 - Backwards Compatibility Plan

## Overview

This document outlines the backwards compatibility strategy for Map Shine v2.0, ensuring that existing scenes, configurations, and user workflows continue to function when upgrading from v1.x.

---

## Table of Contents

1. [Effect Systems & Requirements](#effect-systems--requirements)
2. [Texture-Based Effects](#texture-based-effects)
3. [Map Points System](#map-points-system)
4. [Configuration & Settings Migration](#configuration--settings-migration)
5. [Profile System Compatibility](#profile-system-compatibility)
6. [Weather System](#weather-system)
7. [Universal Effects](#universal-effects)
8. [Breaking Changes & Migration Strategies](#breaking-changes--migration-strategies)

---

## Effect Systems & Requirements

### Summary of All Effects

| Effect | Trigger Type | Required Texture/Data | Config Path | Notes |
|--------|-------------|----------------------|-------------|-------|
| **Metallic Shine** | Texture | `_Specular.webp` | `baseShine` | Core effect, always active if texture found |
| **Cloud Shadows** | Procedural | None (procedural) | `cloudShadows` | No texture required |
| **Iridescence** | Texture | `_Iridescence.webp` | `iridescence` | Oil-slick rainbow effect |
| **Canopy Shadows** | Texture | `_Canopy.webp` | `canopy` | Tree/foliage shadows |
| **Bush Distortion** | Texture | `_Bush.webp` | `bush` | Foliage movement |
| **Tree Distortion** | Texture | `_Tree.webp` | `tree` | Tree sway animation |
| **Structural Shadows** | Texture | `_Structural.webp` | `structuralShadows` | Building/structure shadows |
| **Prism** | Texture | `_Prism.webp` | `prism` | Light refraction effect |
| **Water Effects** | Texture | `_Water.webp` | `water` | Waves, caustics, foam |
| **Caustics** | Texture | `_Caustics.webp` (optional) | `water.caustics` | Underwater light patterns |
| **Shoreline** | Texture | `_Shoreline.webp` (optional) | `water.shoreline` | Beach foam |
| **Puddles** | Texture | `_Puddle.webp` | `water.puddles` | Rain puddle effects |
| **Ground Glow** | Texture | `_GroundGlow.webp` | `groundGlow` | Emissive ground areas |
| **Heat Distortion** | Texture | `_Heat.webp` | `heatDistortion` | Heat shimmer effect |
| **Ambient Layer** | Texture | `_Ambient.webp` | `ambient` | Custom ambient overlay |
| **Outdoors Mask** | Texture | `_Outdoors.webp` | N/A | Masking for weather/effects |
| **Fire Particles** | Texture | `_Fire.webp` | `fire.particles` | Flame particle effect |
| **Sparks** | Texture | `_Sparks.webp` | `sparks` | Spark particle effect |
| **Dust Motes** | Texture | `_Dust.webp` | `dust` | Floating dust particles |
| **Steam** | Texture/Points | `_Steam.webp` or Map Points | `pressurisedSteam` | Steam burst effect |
| **Glint Particles** | Texture | `_Prism.webp` | `glint` | Sparkle particles |
| **Metallic Glints** | Texture | `_Specular.webp` | `metallicGlints` | Metal sparkle particles |
| **Water Splashes** | Texture | `_Water.webp` (edge detection) | `biofilm` | Splash particles at water edges |
| **Water Glints** | Texture | `_Water.webp` | `water.glintParticles` | Water surface sparkles |
| **Candle Flame** | Map Points | Point group | `candleFlame` | Candle flame particles |
| **Smelly Flies** | Map Points | Point/Area group | `smellyFlies` | Fly swarm effect |
| **Lightning** | Map Points | Line group | `lightning` | Lightning bolt effect |
| **Physics Ropes** | Map Points | Line group | `physicsRope` | Rope/chain simulation |
| **Building Shadows** | Texture | `_Structural.webp` | `buildingShadows` | Sun-angle shadows |
| **Time of Day** | Procedural | None | `timeOfDay` | Day/night color grading |
| **Post-Processing** | Procedural | None | `postProcessing` | Color correction, vignette, etc. |
| **Weather System** | Procedural | None | `weather` | Rain, snow, fog, etc. |

---

## Texture-Based Effects

### Current Texture Discovery System

The `TextureAutoLoader` class automatically discovers effect textures by looking for files with specific suffixes in the same directory as the base texture.

#### Suffix Map (Current v1.x)
```javascript
static SUFFIX_MAP = {
  specular: "_Specular",
  ambient: "_Ambient",
  iridescence: "_Iridescence",
  groundGlow: "_GroundGlow",
  heat: "_Heat",
  fire: "_Fire",
  sparks: "_Sparks",
  dust: "_Dust",
  outdoors: "_Outdoors",
  canopy: "_Canopy",
  bush: "_Bush",
  tree: "_Tree",
  structural: "_Structural",
  prism: "_Prism",
  water: "_Water",
  caustics: "_Caustics",
  shoreline: "_Shoreline",
  puddle: "_Puddle",
  noWater: "_NoWater",
  steam: "_Steam",
};
```

### Backwards Compatibility Requirements

1. **Preserve All Existing Suffixes**: The suffix map must remain unchanged to ensure existing texture sets continue to work.

2. **Support Both Background and Tile Textures**: Effects can be triggered from either the scene background or individual tiles.

3. **Graceful Degradation**: If a texture is missing, the effect should simply not activate (no errors).

### v2.0 Recommendations

```javascript
// Add version detection for future suffix additions
static SUFFIX_MAP_V1 = { /* current suffixes */ };
static SUFFIX_MAP_V2 = { 
  ...SUFFIX_MAP_V1,
  // New v2 suffixes here
  snow: "_Snow",
  ice: "_Ice",
  // etc.
};

// Use appropriate map based on detected version
static get SUFFIX_MAP() {
  return this.SUFFIX_MAP_V2; // Always use latest, backwards compatible
}
```

---

## Map Points System

### Current Implementation

Map Points are stored in scene flags under `flags.map-shine.mapPointGroups`. Each group has:

```javascript
{
  id: string,           // Unique identifier
  label: string,        // Display name
  type: "point" | "line" | "area" | "rope",
  points: [{x, y}, ...],
  isBroken: boolean,    // Validation state
  reason: string,       // Validation message
  isEffectSource: boolean,
  effectTarget: string, // Effect key (e.g., "lightning", "candleFlame")
  emission: {
    intensity: number,
    falloff: { enabled: boolean, strength: number }
  },
  // Rope-specific properties
  ropeType?: string,
  texturePath?: string,
  segmentLength?: number,
  // ... other rope properties
}
```

### Effect Target Options (Current)

```javascript
EFFECT_SOURCE_OPTIONS = {
  "": "None",
  sparks: "Sparks",
  fire: "Fire Particles",
  candleFlame: "Candle Flame",
  dust: "Dust Motes",
  smellyFlies: "Smelly Flies",
  lightning: "Lightning",
  cloudShadows: "Cloud Shadows",
  canopy: "Canopy Shadows",
  structuralShadows: "Structural Shadows",
  water: "Water Surface",
  pressurisedSteam: "Pressurised Steam",
};
```

### Backwards Compatibility Requirements

1. **Preserve Flag Structure**: The `mapPointGroups` flag structure must remain unchanged.

2. **Support Legacy Group Types**: All existing group types (`point`, `line`, `area`, `rope`) must continue to work.

3. **Effect Target Mapping**: All existing effect targets must remain valid.

4. **Rope Presets**: Existing rope configurations must be preserved.

### v2.0 Recommendations

```javascript
// Migration helper for v1 -> v2 point groups
function migratePointGroup(group) {
  // Add any new required properties with defaults
  return {
    ...group,
    // New v2 properties with defaults
    version: group.version || 1,
    metadata: group.metadata || {},
    // Preserve all existing properties
  };
}

// On scene load, migrate groups if needed
async function ensureGroupCompatibility() {
  const groups = MapPointsManager.getGroups();
  let needsUpdate = false;
  
  for (const [id, group] of Object.entries(groups)) {
    if (!group.version || group.version < 2) {
      groups[id] = migratePointGroup(group);
      needsUpdate = true;
    }
  }
  
  if (needsUpdate) {
    await canvas.scene.setFlag(MODULE_ID, "mapPointGroups", groups);
  }
}
```

---

## Configuration & Settings Migration

### Current Configuration Structure (MODULE_DEFAULTS)

The `MODULE_DEFAULTS` object defines all effect configurations. Key sections:

- `enabled` - Master toggle
- `baseShine` - Metallic shine settings
- `cloudShadows` - Cloud shadow settings
- `iridescence` - Iridescence settings
- `canopy` - Canopy shadow settings
- `bush` / `tree` - Foliage distortion
- `structuralShadows` - Building shadows
- `prism` - Light refraction
- `water` - Water effects (waves, caustics, foam, etc.)
- `foam` - Foam layer
- `fire` - Fire particles
- `candleFlame` - Candle flame
- `pressurisedSteam` - Steam bursts
- `sparks` - Spark particles
- `lightning` - Lightning bolts
- `smellyFlies` - Fly swarms
- `dust` / `glint` / `metallicGlints` / `biofilm` - Various particles
- `particleSystems` - Global particle settings
- `buildingShadows` - Sun-angle shadows
- `timeOfDay` - Day/night cycle
- `diagnostic` - Debug settings
- `physicsRope` - Rope presets
- `overheadEffect` - Overhead tile effects
- `weather` - Weather system
- `postProcessing` - Color correction, vignette, etc.

### Backwards Compatibility Requirements

1. **Preserve All Config Paths**: Existing config paths must remain valid.

2. **Default Value Preservation**: Default values should not change behavior.

3. **Deep Merge on Load**: New properties should be added without overwriting existing user settings.

### v2.0 Recommendations

```javascript
// Version-aware config migration
function migrateConfig(config, fromVersion, toVersion) {
  const migrated = foundry.utils.deepClone(config);
  
  // v1.x -> v2.0 migrations
  if (fromVersion < 2) {
    // Example: Rename a property
    if (migrated.oldPropertyName !== undefined) {
      migrated.newPropertyName = migrated.oldPropertyName;
      delete migrated.oldPropertyName;
    }
    
    // Example: Add new required properties with defaults
    migrated.newFeature = migrated.newFeature ?? {
      enabled: false,
      intensity: 1.0
    };
  }
  
  return migrated;
}

// Deep merge with defaults, preserving user values
function mergeWithDefaults(userConfig, defaults) {
  return foundry.utils.mergeObject(
    foundry.utils.deepClone(defaults),
    userConfig,
    { insertKeys: true, insertValues: true, overwrite: true }
  );
}
```

---

## Profile System Compatibility

### Current Profile Structure

Profiles are stored in:
- **World Defaults**: `game.settings.get(MODULE_ID, "worldDefaults")`
- **Scene Profiles**: `scene.flags.map-shine.profiles`
- **Active Profile**: `scene.flags.map-shine.activeProfile`

### Profile Data Structure

```javascript
{
  id: string,
  name: string,
  config: { /* Full MODULE_DEFAULTS structure */ }
}
```

### Backwards Compatibility Requirements

1. **Preserve Profile IDs**: Existing profile references must remain valid.

2. **Config Migration**: Profile configs must be migrated alongside global configs.

3. **Default Profile Handling**: The "default" profile must always exist.

### v2.0 Recommendations

```javascript
// Profile migration on load
async function migrateProfiles() {
  const profiles = await getSceneProfiles();
  let needsUpdate = false;
  
  for (const profile of profiles) {
    const originalVersion = profile.version || 1;
    if (originalVersion < 2) {
      profile.config = migrateConfig(profile.config, originalVersion, 2);
      profile.version = 2;
      needsUpdate = true;
    }
  }
  
  if (needsUpdate) {
    await saveSceneProfiles(profiles);
  }
}
```

---

## Weather System

### Current Weather States

```javascript
statePresets: {
  clear: { /* ... */ },
  "partly-cloudy": { /* ... */ },
  drizzle: { /* ... */ },
  rain: { /* ... */ },
  storm: { /* ... */ },
  sleet: { /* ... */ },
  snow: { /* ... */ },
  blizzard: { /* ... */ }
}
```

### Weather State Properties

Each state includes:
- `name` - Display name
- `cloudDensity` - Cloud coverage (0-1)
- `cloudThreshold` - Cloud visibility threshold
- `cloudSoftness` - Cloud edge softness
- `precipitationIntensity` - Rain/snow intensity
- `precipitationType` - "none", "rain", "snow", "sleet"
- `particleCount` - Precipitation particle count
- `atmosphericTint` - RGB tint values
- `colorCorrection` - Saturation, contrast, brightness
- `windMultipliers` - Wind behavior modifiers
- `foliageMultipliers` - Foliage movement modifiers
- `cloudWind` - Cloud movement settings

### Backwards Compatibility Requirements

1. **Preserve State Names**: Existing state names must remain valid.

2. **State Property Defaults**: New properties should have sensible defaults.

3. **Custom States**: User-defined states should be preserved.

### v2.0 Recommendations

```javascript
// Weather state migration
function migrateWeatherState(state) {
  return {
    ...state,
    // Add new v2 properties with defaults
    lightningEnabled: state.lightningEnabled ?? (state.name === "Storm"),
    thunderEnabled: state.thunderEnabled ?? (state.name === "Storm"),
    // Preserve all existing properties
  };
}
```

---

## Universal Effects

### Current Universal Effects

Stored in `UNIVERSAL_EFFECT_DEFAULTS`:

1. **Scene Transition**
   - Fade durations
   - Logo, heading, subheading
   - Random hints system

2. **Pause Effect**
   - Overlay styling
   - Color correction
   - Random hints

3. **Combat Effect**
   - Duration, time scale
   - Color correction

4. **Font Manager**
   - Font family configurations

### Backwards Compatibility Requirements

1. **Preserve Setting Keys**: All `universal.*` settings must remain valid.

2. **Hint System**: Random hints arrays must continue to work.

3. **Color Correction**: Color correction structures must be preserved.

### v2.0 Recommendations

```javascript
// Universal settings migration
function migrateUniversalSettings() {
  const settings = [
    "sceneTransition",
    "pauseEffect",
    "combatEffect",
    "fontManager"
  ];
  
  for (const key of settings) {
    const current = game.settings.get(MODULE_ID, `universal.${key}`);
    if (current && !current._version) {
      const migrated = migrateUniversalSetting(key, current);
      game.settings.set(MODULE_ID, `universal.${key}`, migrated);
    }
  }
}
```

---

## Breaking Changes & Migration Strategies

### Potential Breaking Changes in v2.0

1. **API Changes**: If any public API methods change signature.
2. **Config Structure Changes**: If config paths are renamed or restructured.
3. **Removed Features**: If any features are deprecated.

### Migration Strategy

#### Phase 1: Detection
```javascript
// Detect v1.x data on module load
Hooks.once("ready", async () => {
  const dataVersion = game.settings.get(MODULE_ID, "dataVersion") || 1;
  
  if (dataVersion < 2) {
    console.log("Map Shine | Detected v1.x data, initiating migration...");
    await runMigration(dataVersion, 2);
    await game.settings.set(MODULE_ID, "dataVersion", 2);
  }
});
```

#### Phase 2: Backup
```javascript
// Create backup before migration
async function backupV1Data() {
  const backup = {
    worldDefaults: game.settings.get(MODULE_ID, "worldDefaults"),
    timestamp: Date.now(),
    version: "1.x"
  };
  
  await game.settings.set(MODULE_ID, "v1Backup", backup);
  console.log("Map Shine | Created backup of v1.x data");
}
```

#### Phase 3: Migration
```javascript
async function runMigration(fromVersion, toVersion) {
  // Backup first
  await backupV1Data();
  
  // Migrate world defaults
  const worldDefaults = game.settings.get(MODULE_ID, "worldDefaults");
  const migratedDefaults = migrateConfig(worldDefaults, fromVersion, toVersion);
  await game.settings.set(MODULE_ID, "worldDefaults", migratedDefaults);
  
  // Migrate all scenes
  for (const scene of game.scenes) {
    await migrateSceneData(scene, fromVersion, toVersion);
  }
  
  // Migrate universal settings
  await migrateUniversalSettings();
  
  console.log("Map Shine | Migration complete!");
}
```

#### Phase 4: Rollback Support
```javascript
// Allow rollback to v1.x if needed
async function rollbackToV1() {
  const backup = game.settings.get(MODULE_ID, "v1Backup");
  if (!backup) {
    ui.notifications.error("No v1.x backup found!");
    return;
  }
  
  await game.settings.set(MODULE_ID, "worldDefaults", backup.worldDefaults);
  await game.settings.set(MODULE_ID, "dataVersion", 1);
  
  ui.notifications.info("Rolled back to v1.x data. Please reload.");
}
```

---

## Implementation Checklist

### Before Release

- [x] Add `dataVersion` setting to track data format version - **MapPointsManager uses version field**
- [x] Implement migration detection in `ready` hook - **MapPointsManager.loadFromScene() handles this**
- [ ] Create backup system for v1.x data
- [x] Write migration functions for each data type - **MapPointsManager.migrateGroup() implemented**
- [ ] Test migration with real v1.x scenes
- [ ] Document any breaking changes in CHANGELOG
- [ ] Add rollback capability

### Map Points System (v2.0)

- [x] Create `MapPointsManager` class (`scripts/scene/map-points-manager.js`)
- [x] Read v1.x `mapPointGroups` from scene flags
- [x] Migrate groups to v2 format with version tracking
- [x] Provide `getGroupsByEffect()` for effects to query points
- [x] Provide `getLinesForEffect()` for line-type groups (lightning, etc.)
- [x] Provide `getRopeConfigurations()` for physics rope effect
- [x] Visual helper system for debugging point placement
- [x] Integrate with canvas-replacement.js lifecycle
- [x] Wire to actual particle effects (fire, sparks, etc.) - **FireSparksEffect.setMapPointsSources()**
- [ ] Wire to lightning effect
- [ ] Wire to physics rope effect

### Testing Requirements

- [ ] Load v1.x scene with all effect types
- [ ] Verify all textures are discovered correctly
- [x] Verify all map point groups work - **MapPointsManager reads v1.x flags**
- [ ] Verify all profiles load correctly
- [ ] Verify weather states work
- [ ] Verify universal settings work
- [ ] Test migration on corrupted/partial data
- [ ] Test rollback functionality

### Documentation Updates

- [ ] Update README with v2.0 changes
- [ ] Document migration process for users
- [ ] Update API documentation if changed
- [ ] Add troubleshooting section for migration issues

---

## Summary

The key principles for backwards compatibility are:

1. **Never Remove, Only Add**: Keep all existing config paths, suffixes, and effect targets.

2. **Deep Merge with Defaults**: New properties get defaults, existing values are preserved. We must be careful with this step however, since many effects may have drastically different configs in their threejs format, in those cases it's better to just use the defaults.

3. **Version Detection**: Track data format version to know when migration is needed.

4. **Backup Before Migration**: Always create a backup before modifying user data.

5. **Graceful Degradation**: If something is missing, use defaults rather than crashing.

6. **Rollback Support**: Allow users to revert if migration causes issues.

By following these principles, Map Shine v2.0 can introduce new features while ensuring existing users have a seamless upgrade experience.
