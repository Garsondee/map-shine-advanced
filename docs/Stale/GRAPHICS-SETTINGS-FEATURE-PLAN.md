# Graphics Settings Feature Plan

**Status**: Planning Phase  
**Priority**: Essential Feature  
**Target Users**: Players & GMs  
**Integration Point**: Left-hand control palette under "Map Shine Control"

---

## Overview

This feature provides players and GMs with an intuitive, dedicated UI for managing graphics effects during gameplay. The goal is to give users **easy access to override controls** that allow them to:

- **Turn off effects entirely** (disable/enable toggle)
- **Modulate intensity down** from current value to zero (but NOT increase beyond current)
- **Selectively disable parts of effects** (e.g., turn off fire particles but keep fire glow)
- **See what's currently active** at a glance with clear status indicators

This is a **critical accessibility and performance feature** that should be implemented in all new effect features going forward.

---

## Architecture & Design

### UI Structure

**Location**: New button in `ControlPanelManager` alongside existing time/weather controls  
**Button Label**: "🎨 Graphics Settings" or "Graphics Overrides"  
**Opens**: Modal Tweakpane dialog (similar to existing control panel)

### Component Hierarchy

```
GraphicsSettingsDialog (new manager class)
├── Pane Container (Tweakpane)
├── Status Panel (Active Effects Summary)
│   ├── Effect Status Indicators (Green/Red/Grey dots)
│   ├── Active Effect Count
│   └── Performance Impact Estimate
├── Effect Folders (one per active effect)
│   ├── Effect Header with Status Light
│   ├── Enable/Disable Toggle
│   ├── Intensity Slider (0-100%, clamped to current max)
│   ├── Sub-component Toggles (if applicable)
│   └── Reset to Default Button
└── Global Controls
    ├── "Disable All Effects" Button
    ├── "Reset All to Defaults" Button
    └── Performance Mode Preset (Low/Medium/High)
```

### Key Design Principles

1. **Read-Only Upward**: Users can only reduce intensity, never increase it beyond the current configured value
2. **Clear Visibility**: Status lights (Green=Active, Red=Disabled, Grey=Unavailable) show at a glance what's running
3. **Hierarchical Control**: Global disable-all, then per-effect toggles, then sub-component controls
4. **Non-Destructive**: All changes are temporary overrides; reset buttons restore original settings
5. **Performance Aware**: Show estimated performance impact of current configuration
6. **Accessibility**: Large touch targets, clear labels, tooltips explaining each control

---

## Data Model

### GraphicsSettingsState (per-client, not persisted to scene)

```javascript
{
  // Global overrides
  globalDisableAll: false,
  performanceMode: 'auto', // 'auto' | 'low' | 'medium' | 'high'
  
  // Per-effect overrides (keyed by effect ID)
  effectOverrides: {
    'fire': {
      enabled: true,
      intensityMultiplier: 1.0,  // 0.0-1.0, clamped to current max
      subComponentOverrides: {
        'particles': true,
        'glow': true,
        'distortion': false
      }
    },
    'weather': {
      enabled: true,
      intensityMultiplier: 0.5,
      subComponentOverrides: {}
    },
    // ... more effects
  },
  
  // Session metadata
  lastModified: timestamp,
  isDirty: boolean
}
```

### Effect Capability Schema

Each effect must declare:

```javascript
{
  effectId: 'fire',
  displayName: 'Fire & Embers',
  category: 'particles', // 'particles' | 'environmental' | 'post-processing' | 'material'
  icon: '🔥',
  description: 'Animated fire particles and glow effects',
  
  // Intensity control
  supportsIntensity: true,
  intensityLabel: 'Particle Density',
  intensityMin: 0,
  intensityMax: 1.0,
  intensityDefault: 1.0,
  
  // Sub-components (optional)
  subComponents: [
    { id: 'particles', label: 'Particles', default: true },
    { id: 'glow', label: 'Glow', default: true },
    { id: 'distortion', label: 'Heat Distortion', default: true }
  ],
  
  // Performance impact (for sorting/filtering)
  performanceImpact: 'medium', // 'low' | 'medium' | 'high'
  
  // Availability check
  isAvailable: () => boolean, // e.g., check if _Fire mask exists
  availabilityReason: 'string' // e.g., "No fire texture found"
}
```

---

## Implementation Phases

### Phase 1: Core Infrastructure (ESSENTIAL)

**Deliverables**:
- `GraphicsSettingsManager` class (manages state, persistence, UI)
- `GraphicsSettingsDialog` class (Tweakpane-based UI)
- Effect capability registry system
- State applier integration (apply overrides to effects)

**Files to Create**:
- `scripts/ui/graphics-settings-manager.js`
- `scripts/ui/graphics-settings-dialog.js`
- `scripts/effects/effect-capabilities-registry.js`

**Integration Points**:
- Add button to `ControlPanelManager` to open dialog
- Hook into `EffectComposer` to register effect capabilities
- Integrate with `stateApplier` to apply overrides

---

### Phase 2: Effect Integration (ESSENTIAL)

**For Each Effect**, add capability declaration:

```javascript
// In effect class (e.g., FireSparksEffect.js)
static getCapabilities() {
  return {
    effectId: 'fire',
    displayName: 'Fire & Embers',
    // ... full schema
  };
}

// In effect update loop
update(timeInfo, overrides) {
  if (overrides?.enabled === false) {
    // Disable effect rendering
    return;
  }
  
  if (overrides?.intensityMultiplier !== undefined) {
    // Apply intensity multiplier to emission rate, etc.
    const multiplier = overrides.intensityMultiplier;
    this.emissionRate *= multiplier;
  }
  
  if (overrides?.subComponentOverrides) {
    // Apply sub-component toggles
    this.particlesEnabled = overrides.subComponentOverrides.particles !== false;
    this.glowEnabled = overrides.subComponentOverrides.glow !== false;
  }
}
```

**Effects to Integrate** (Priority Order):
1. FireSparksEffect (particles, glow, distortion)
2. WeatherParticles (rain, snow, splash)
3. SpecularEffect (stripes, sparkles, iridescence)
4. LightingEffect (global intensity)
5. WorldSpaceFogEffect (fog density)
6. DistortionManager (all distortions)
7. CloudShadowsEffect (cloud intensity)
8. OverheadShadowsEffect (shadow intensity)

---

### Phase 3: UI Polish & Presets (IMPORTANT)

**Deliverables**:
- Performance presets (Low/Medium/High/Ultra)
- Quick-access buttons for common scenarios
- Persistent client-side state (localStorage)
- Tooltips and help text for each control
- Status panel with active effect count

**Performance Presets**:
```javascript
{
  low: {
    fire: { enabled: false },
    weather: { intensityMultiplier: 0.3 },
    specular: { enabled: false },
    distortion: { enabled: false },
    cloudShadows: { enabled: false }
  },
  medium: {
    fire: { intensityMultiplier: 0.5 },
    weather: { intensityMultiplier: 0.7 },
    specular: { intensityMultiplier: 0.8 },
    distortion: { intensityMultiplier: 0.5 }
  },
  high: {
    // All effects at 100%
  }
}
```

---

### Phase 4: Advanced Features (OPTIONAL)

- **Preset Saving**: Save/load custom override configurations
- **Per-Scene Overrides**: Different settings per scene
- **Collaborative Overrides**: GM can suggest overrides to players
- **Performance Monitoring**: Real-time FPS/GPU load display
- **Effect Dependencies**: Show which effects depend on others

---

## Implementation Checklist

### Core Files

- [ ] Create `scripts/ui/graphics-settings-manager.js`
  - [ ] State management (get/set overrides)
  - [ ] Persistence (localStorage)
  - [ ] Apply overrides to effects
  - [ ] Reset to defaults

- [ ] Create `scripts/ui/graphics-settings-dialog.js`
  - [ ] Tweakpane pane initialization
  - [ ] Status panel rendering
  - [ ] Effect folder generation
  - [ ] Intensity slider logic (clamped to max)
  - [ ] Sub-component toggles
  - [ ] Global control buttons

- [ ] Create `scripts/effects/effect-capabilities-registry.js`
  - [ ] Registry class (register/query capabilities)
  - [ ] Capability validation
  - [ ] Availability checking

### Integration

- [ ] Update `ControlPanelManager`
  - [ ] Add "Graphics Settings" button
  - [ ] Open dialog on click

- [ ] Update `EffectComposer`
  - [ ] Register effect capabilities on initialization
  - [ ] Pass overrides to effect `update()` methods

- [ ] Update each effect class
  - [ ] Add `getCapabilities()` static method
  - [ ] Modify `update()` to respect overrides
  - [ ] Handle intensity multiplier
  - [ ] Handle sub-component toggles

### Testing

- [ ] Verify intensity sliders are clamped correctly
- [ ] Verify disable-all button disables all effects
- [ ] Verify reset buttons restore defaults
- [ ] Verify state persists across scene changes
- [ ] Verify performance presets work correctly
- [ ] Test with multiple effects active
- [ ] Test on low-end hardware (performance mode)

---

## Code Examples

### Effect Capability Declaration

```javascript
// In FireSparksEffect.js
export class FireSparksEffect extends EffectBase {
  static getCapabilities() {
    return {
      effectId: 'fire',
      displayName: 'Fire & Embers',
      category: 'particles',
      icon: '🔥',
      description: 'Animated fire particles with glow and heat distortion',
      supportsIntensity: true,
      intensityLabel: 'Particle Density',
      intensityMin: 0,
      intensityMax: 1.0,
      intensityDefault: 1.0,
      subComponents: [
        { id: 'particles', label: 'Particles', default: true },
        { id: 'glow', label: 'Glow', default: true },
        { id: 'distortion', label: 'Heat Distortion', default: true }
      ],
      performanceImpact: 'high',
      isAvailable: () => {
        const assets = window.MapShine?.assetLoader?.assets;
        return assets?.['_Fire'] !== undefined;
      },
      availabilityReason: 'Fire texture not found'
    };
  }

  update(timeInfo, overrides = {}) {
    // Check if effect is disabled
    if (overrides.enabled === false) {
      this.visible = false;
      return;
    }
    
    this.visible = true;

    // Apply intensity multiplier
    const intensityMult = overrides.intensityMultiplier ?? 1.0;
    this.emissionRate = this.baseEmissionRate * intensityMult;

    // Apply sub-component overrides
    if (overrides.subComponentOverrides) {
      this.particlesEnabled = overrides.subComponentOverrides.particles !== false;
      this.glowEnabled = overrides.subComponentOverrides.glow !== false;
      this.distortionEnabled = overrides.subComponentOverrides.distortion !== false;
    }

    // ... rest of update logic
  }
}
```

### Graphics Settings Manager Usage

```javascript
// In ControlPanelManager or wherever button is added
const graphicsSettings = window.MapShine?.graphicsSettings;
if (graphicsSettings) {
  graphicsSettings.openDialog();
}

// Get current overrides
const overrides = graphicsSettings.getOverrides();

// Set override for specific effect
graphicsSettings.setEffectOverride('fire', {
  enabled: true,
  intensityMultiplier: 0.5
});

// Apply performance preset
graphicsSettings.applyPreset('low');

// Reset all to defaults
graphicsSettings.resetAll();
```

---

## UI Mockup (Text Description)

```
┌─────────────────────────────────────────┐
│ 🎨 Graphics Settings                  [−] │
├─────────────────────────────────────────┤
│ Active Effects: 5/8                     │
│ Performance: Medium (Est. 45 FPS)       │
│                                         │
│ ┌─ 🔥 Fire & Embers ● ─────────────────┐ │
│ │ ☑ Enabled                            │ │
│ │ Intensity: [████████░░] 80%          │ │
│ │ ☑ Particles  ☑ Glow  ☐ Distortion   │ │
│ │ [Reset to Default]                   │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ 🌧️ Weather ● ───────────────────────┐ │
│ │ ☑ Enabled                            │ │
│ │ Intensity: [██████░░░░] 60%          │ │
│ │ [Reset to Default]                   │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ ✨ Specular ● ───────────────────────┐ │
│ │ ☑ Enabled                            │ │
│ │ Intensity: [██████████] 100%         │ │
│ │ [Reset to Default]                   │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ Global Controls ─────────────────────┐ │
│ │ Performance Preset: [Medium ▼]       │ │
│ │ [Disable All]  [Reset All]           │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

---

## Persistence & State

**Client-Side Storage** (localStorage):
- Key: `map-shine-graphics-overrides-${sceneId}`
- Scope: Per-scene, per-client
- Cleared on: Scene change, manual reset

**NOT Persisted to Scene Flags**:
- These are player-specific preferences
- Each client maintains their own overrides
- GMs can suggest but not force overrides

---

## Performance Considerations

1. **Lazy Evaluation**: Only apply overrides to active effects
2. **Batched Updates**: Collect override changes, apply once per frame
3. **Memoization**: Cache capability queries
4. **Throttled UI Updates**: Status panel updates at 10 Hz, not per-frame

---

## Accessibility & UX

- **Color + Text**: Status indicators use color AND text labels
- **Large Touch Targets**: Minimum 44px buttons for mobile
- **Keyboard Navigation**: Tab through controls, Enter to toggle
- **Tooltips**: Hover/long-press for help text
- **Presets**: Quick buttons for common scenarios (Low/Med/High)
- **Undo**: "Reset to Default" for each effect

---

## Testing Strategy

### Unit Tests
- Capability registry (register, query, validate)
- Override application (clamping, merging)
- State persistence (save/load)

### Integration Tests
- Effect responds to overrides
- Intensity multiplier affects emission/intensity
- Sub-component toggles work
- Reset restores original values

### Manual Testing
- Open dialog, verify all effects listed
- Adjust sliders, verify effects change
- Toggle sub-components
- Apply presets
- Reset individual effects
- Reset all effects
- Close and reopen dialog (state persists)
- Change scenes (state clears)

---

## Future Extensions

1. **Per-Effect Profiles**: Save named configurations
2. **Collaborative Settings**: GM broadcasts override suggestions
3. **Adaptive Performance**: Auto-adjust based on FPS
4. **Effect Chains**: Show dependencies (e.g., "Distortion requires Fire")
5. **Recording Mode**: Preset for streaming/recording
6. **Accessibility Mode**: High contrast, larger text

---

## Success Criteria

✅ Players can disable any active effect  
✅ Players can reduce effect intensity without increasing it  
✅ Players can toggle sub-components (e.g., particles vs. glow)  
✅ Status indicators clearly show what's active  
✅ Settings persist across scene changes  
✅ Performance presets work correctly  
✅ All new effects include capability declarations  
✅ No performance regression from override system  
✅ UI is accessible and intuitive  
✅ Documentation is clear for future effect developers  

---

## Essential Feature Requirement

**This feature MUST be implemented for all new effects going forward.**

When creating a new effect:
1. Add `getCapabilities()` static method
2. Modify `update()` to respect overrides
3. Register capability in `EffectComposer`
4. Add to Graphics Settings UI automatically

This ensures consistent, discoverable control over all visual effects.
