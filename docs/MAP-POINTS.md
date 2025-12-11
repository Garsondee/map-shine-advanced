
# Map Points System - Complete Specification

## Overview

The Map Points system allows users to define geometric shapes (points, lines, areas, ropes) on the canvas that serve as effect sources for various visual effects. This document provides a complete specification for implementing this system in a new module version while maintaining backwards compatibility.

---

## Data Storage

### Location
Map Points are stored in scene flags:
```javascript
canvas.scene.flags["map-shine"].mapPointGroups
```

### Structure
```javascript
{
  [groupId: string]: {
    id: string,                    // Unique identifier (randomID)
    label: string,                 // User-defined display name
    type: "point" | "line" | "area" | "rope",
    points: Array<{x: number, y: number}>,
    isBroken: boolean,             // Validation state (for self-intersecting polygons)
    reason: string,                // Validation error message
    isEffectSource: boolean,       // Whether this group triggers an effect
    effectTarget: string,          // Effect key (e.g., "lightning", "candleFlame")
    emission: {
      intensity: number,           // Effect intensity multiplier (default: 1.0)
      falloff: {
        enabled: boolean,
        strength: number           // Falloff strength (default: 0.5)
      }
    },
    // Rope-specific properties (only for type === "rope")
    ropeType?: string,             // "rope" | "chain" | "elastic"
    texturePath?: string,
    segmentLength?: number,
    animationSpeed?: number,
    damping?: number,
    windForce?: number,
    springConstant?: number,
    tapering?: number,
    ropeEndTexturePath?: string | null,
    ropeEndScale?: number,
    indoorWindShielding?: number,
    endpointFade?: number,
    fadeStartDistance?: number,
    fadeEndDistance?: number,
    isIndoors?: boolean            // Whether rope is shielded from wind
  }
}
```

---

## Group Types

### 1. Point Groups
- **Purpose**: Define single locations for effects like candle flames
- **Minimum Points**: 1
- **Use Cases**: Candle flames, steam vents, light sources

### 2. Line Groups
- **Purpose**: Define paths for effects like lightning
- **Minimum Points**: 2
- **Use Cases**: Lightning bolts, energy beams, trails

### 3. Area Groups
- **Purpose**: Define polygonal regions for effects
- **Minimum Points**: 3 (forms closed polygon)
- **Validation**: Checks for self-intersection
- **Use Cases**: Fly swarm boundaries, effect zones

### 4. Rope Groups
- **Purpose**: Define physics-simulated ropes/chains
- **Minimum Points**: 2 (start and end anchors)
- **Special Properties**: Physics simulation parameters
- **Use Cases**: Hanging ropes, chains, banners, vines

---

## Effect Target Mapping

### Available Effect Targets
```javascript
const EFFECT_SOURCE_OPTIONS = {
  "": "None",                      // No effect
  sparks: "Sparks",                // Spark particles from point
  fire: "Fire Particles",          // Fire particles from point/area
  candleFlame: "Candle Flame",     // Candle flame at point
  dust: "Dust Motes",              // Dust particles in area
  smellyFlies: "Smelly Flies",     // Fly swarm in area
  lightning: "Lightning",          // Lightning bolt along line
  cloudShadows: "Cloud Shadows",   // (Reserved for future use)
  canopy: "Canopy Shadows",        // (Reserved for future use)
  structuralShadows: "Structural Shadows", // (Reserved for future use)
  water: "Water Surface",          // (Reserved for future use)
  pressurisedSteam: "Pressurised Steam"   // Steam burst from point
};
```

### Effect-to-Group-Type Compatibility

| Effect | Point | Line | Area | Notes |
|--------|-------|------|------|-------|
| candleFlame | ✅ | ❌ | ❌ | Single point only |
| lightning | ❌ | ✅ | ❌ | Requires 2+ points |
| smellyFlies | ✅ | ❌ | ✅ | Point = center, Area = boundary |
| pressurisedSteam | ✅ | ❌ | ❌ | Single point only |
| sparks | ✅ | ❌ | ✅ | Point or area spawn |
| fire | ✅ | ❌ | ✅ | Point or area spawn |
| dust | ❌ | ❌ | ✅ | Area spawn only |

---

## API Reference

### MapPointsManager (Static Class)

#### Reading Data

```javascript
// Get all groups for current scene
static getGroups(): Object<string, GroupData>

// Get single group by ID
static getGroup(groupId: string): GroupData | undefined
```

#### Creating Groups

```javascript
// Create new group
static async createGroup(options: {
  label?: string,        // Default: "New Group"
  type?: string,         // Default: "point"
  ropeSettings?: Object  // Optional rope-specific settings
}): Promise<string>      // Returns new group ID
```

#### Updating Groups

```javascript
// Update group properties (label, effectTarget, emission, etc.)
static async updateGroupProperties(
  groupId: string, 
  properties: Partial<GroupData>
): Promise<void>

// Add point to group
static async addPoint(
  groupId: string, 
  point: {x: number, y: number}
): Promise<void>

// Update existing point position
static async updatePoint(
  groupId: string, 
  pointIndex: number, 
  newPosition: {x: number, y: number}
): Promise<void>

// Remove point from group
static async removePoint(
  groupId: string, 
  pointIndex: number
): Promise<void>
```

#### Deleting Groups

```javascript
// Delete entire group
static async deleteGroup(groupId: string): Promise<void>
```

#### Validation

```javascript
// Validate group (checks for self-intersection in areas)
static validate(group: GroupData): GroupData
// Returns group with updated isBroken and reason fields
```

---

## Hooks

### Custom Hooks

```javascript
// Fired when any map point data changes
Hooks.callAll("mapShine:mapPointsUpdated", {
  created?: string,  // ID of newly created group
  updated?: string,  // ID of updated group
  deleted?: string   // ID of deleted group
});

// Fired when geometry masks are re-rendered
Hooks.callAll("mapShine:masksRendered", {
  changedGroupId?: string  // ID of group that triggered re-render
});
```

---

## Geometry Mask Manager

The `GeometryMaskManager` renders map point groups into textures that can be used by particle systems and other effects.

### Responsibilities

1. **Lazy Texture Allocation**: Creates render textures on-demand for each effect type
2. **Graphics Rendering**: Draws polygons/shapes from point groups
3. **Update Coordination**: Listens for map point changes and re-renders
4. **Resize Handling**: Resizes textures when window size changes

### Integration with Particle Systems

```javascript
// Particle systems query the mask manager for spawn regions
const maskTexture = geometryMaskManager.getMaskTexture("smellyFlies");
// Use texture to determine valid spawn positions
```

---

## Particle Effect Definitions

### Structure

```javascript
const PARTICLE_EFFECT_DEFINITIONS = {
  [effectKey]: {
    title: string,           // Display name
    description: string,     // Help text
    configPath: string,      // Path in MODULE_DEFAULTS
    triggerTexture: string,  // Texture suffix OR "dummy" for geometry-only
    spawnOn?: string,        // "tiles" for tile-based spawning
    buildEmitterConfig: Function  // Builds particle-pixi emitter config
  }
};
```

### Current Definitions

```javascript
{
  dust: {
    title: "Dust Motes",
    description: "Floating dust particles. Requires _Dust.webp texture.",
    configPath: "dust",
    triggerTexture: "dust"
  },
  glint: {
    title: "Glint Particles",
    description: "Sparkling glints. Requires _Prism.webp texture.",
    configPath: "glint",
    triggerTexture: "prism"
  },
  candleFlame: {
    title: "Candle Flame",
    description: "Jiggling flame effect. Requires Map Points.",
    configPath: "candleFlame",
    triggerTexture: "candleFlame"  // Dummy - geometry-based
  },
  smellyFlies: {
    title: "Smelly Flies",
    description: "Fly swarm. Requires Map Points.",
    configPath: "smellyFlies",
    triggerTexture: "smellyFlies"  // Dummy - geometry-based
  },
  waterGlints: {
    title: "Water Glints / Spray",
    description: "Particles on water surface.",
    configPath: "water.glintParticles",
    triggerTexture: "water",
    spawnOn: "tiles"
  },
  fire: {
    title: "Flames",
    description: "Fire particles. Requires _Fire.webp texture.",
    configPath: "fire.particles",
    triggerTexture: "fire"
  },
  metallicGlints: {
    title: "Metallic Glints",
    description: "Sparkles on metal. Requires _Specular.webp texture.",
    configPath: "metallicGlints",
    triggerTexture: "specular"
  },
  sparks: {
    title: "Sparks",
    description: "Flying sparks. Requires _Sparks.webp texture.",
    configPath: "sparks",
    triggerTexture: "sparks"
  },
  biofilm: {
    title: "Water Splashes",
    description: "Splash particles at water edges.",
    configPath: "biofilm",
    triggerTexture: "water"
  },
  pressurisedSteam: {
    title: "Pressurised Steam",
    description: "Steam bursts. Requires _Steam.webp or Map Points.",
    configPath: "pressurisedSteam",
    triggerTexture: "steam"
  }
}
```

---

## Lightning System

### Special Handling

Lightning is handled separately from the particle system via `LightningLayer`.

### Requirements
- Group type: `line`
- Minimum points: 2
- Effect target: `lightning`

### Configuration (MODULE_DEFAULTS.lightning)

```javascript
{
  enabled: true,
  minDelay: 100,           // Min ms between flashes
  maxDelay: 5000,          // Max ms between flashes
  flickerChance: 0.55,     // Chance of flicker effect
  burstMinStrikes: 1,      // Min strikes per burst
  burstMaxStrikes: 10,     // Max strikes per burst
  burstStrikeDuration: 150,
  burstStrikeDelay: 300,
  // Visual properties
  color: "#99DDFF",
  coreColor: "#FFFFFF",
  brightness: 2.9,
  width: { start: 47.5, end: 16.1, ... },
  coreWidth: { start: 14.1, end: 4.8 },
  // Path generation
  path: { segments: 100, endPointRandomness: 15 },
  curve: { startAngleMin: -45, ... },
  fork: { maxDepth: 4, chance: 1, ... },
  displacement: { enabled: true, magnitude: 15, ... }
}
```

---

## Physics Rope System

### Special Handling

Ropes are handled by `PhysicsRopeLayer` with Verlet integration physics.

### Requirements
- Group type: `rope`
- Minimum points: 2 (anchor points)

### Rope Type Presets

```javascript
{
  rope: {
    label: "Rope",
    segmentLength: 10,
    damping: 0.99,
    windForce: 1.0,
    springConstant: 0.8,
    tapering: 0.5
  },
  chain: {
    label: "Chain",
    segmentLength: 15,
    damping: 0.95,
    windForce: 0.3,
    springConstant: 0.8,
    tapering: 0.2
  },
  elastic: {
    label: "Elastic/Rubber",
    segmentLength: 8,
    damping: 0.98,
    windForce: 1.5,
    springConstant: 0.8,
    tapering: 0.7
  }
}
```

---

## Smelly Flies System

### Special Handling

Flies are handled by `SmellyFliesLayer` with custom AI behavior.

### Requirements
- Group type: `point` (center) or `area` (boundary)
- Effect target: `smellyFlies`

### Behavior States
1. **Flying**: Orbiting center point with noise-based movement
2. **Landing**: Transitioning to ground
3. **Walking**: Moving on ground within area
4. **Taking Off**: Transitioning back to flying

### Configuration (MODULE_DEFAULTS.smellyFlies)

```javascript
{
  enabled: true,
  blendMode: 0,
  particleTexture: "modules/map-shine/assets/fly.webp",
  maxParticles: 10,
  flying: {
    takeoffDuration: 0.5,
    noiseStrength: 2000,
    tetherStrength: 15.8,
    maxSpeed: 1000,
    drag: 0.8,
    landChance: 0.05
  },
  walking: {
    walkSpeed: 60,
    minIdleTime: 0.5,
    maxIdleTime: 2.5,
    takeoffChance: 0.05
  },
  motionBlur: {
    enabled: true,
    strength: 0.03
  }
}
```

---

## Implementation Checklist for New Module

### Core Infrastructure

- [ ] `MapPointsManager` static class with all CRUD operations
- [ ] Scene flag storage/retrieval
- [ ] Validation system for area groups
- [ ] Hook system for change notifications

### Geometry Mask Manager

- [ ] Lazy texture allocation
- [ ] Graphics rendering for each group type
- [ ] Resize handling
- [ ] Update coordination with particle systems

### Effect Systems

- [ ] Particle effect definitions registry
- [ ] Lightning layer
- [ ] Physics rope layer
- [ ] Smelly flies layer

### UI Components

- [ ] Map Points Editor panel
- [ ] Point placement tool
- [ ] Group property editor
- [ ] Effect target dropdown

### Backwards Compatibility

- [ ] Read existing v1.x flag data
- [ ] Migrate missing properties with defaults
- [ ] Preserve all existing group IDs
- [ ] Support all existing effect targets

---

## Migration from v1.x

### Required Migrations

```javascript
function migrateMapPointGroup(group) {
  return {
    // Ensure all required properties exist
    id: group.id,
    label: group.label || "Unnamed Group",
    type: group.type || "point",
    points: group.points || [],
    isBroken: group.isBroken ?? false,
    reason: group.reason || "",
    isEffectSource: group.isEffectSource ?? false,
    effectTarget: group.effectTarget || "",
    emission: {
      intensity: group.emission?.intensity ?? 1.0,
      falloff: {
        enabled: group.emission?.falloff?.enabled ?? false,
        strength: group.emission?.falloff?.strength ?? 0.5
      }
    },
    // Rope properties (if applicable)
    ...(group.type === "rope" ? {
      ropeType: group.ropeType || "rope",
      texturePath: group.texturePath || ROPE_TYPE_PRESETS.rope.texturePath,
      segmentLength: group.segmentLength ?? ROPE_TYPE_PRESETS.rope.segmentLength,
      // ... other rope properties with defaults
    } : {}),
    // Add version marker
    _version: 2
  };
}
```

---

## Summary

The Map Points system is a critical feature that enables geometry-based effects. Key implementation priorities:

1. **Data Integrity**: Preserve existing scene flag structure
2. **Effect Compatibility**: Support all existing effect targets
3. **Validation**: Maintain polygon self-intersection checking
4. **Performance**: Lazy texture allocation, efficient updates
5. **Extensibility**: Easy to add new effect targets in the future
