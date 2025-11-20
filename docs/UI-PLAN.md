# Map Shine Advanced — UI Architecture Plan

## Overview
Tweakpane-based UI for GM/Map Maker effect control with progressive disclosure and non-technical user focus.

## UI Access Levels

### GM/Admin Interface (Full Control)
- Map Maker Mode: Define baseline settings (saved to scene flags)
- GM Mode: Override Map Maker settings (can revert)
- Access all effects and global controls

### Player Interface (Simplified)
- Performance controls only (disable heavy effects)
- Saved client-local (not distributed)

## Layout Structure

### Panel Organization
```
┌─ Map Shine Advanced ─────────────────────────────┐
│ [Patreon] [Foundry Store]        [Help] [Close]  │
├──────────────────────────────────────────────────┤
│ GLOBAL CONTROLS                                   │
│ ☑ Master Enable                                   │
│ ⏱ Time Scale: [━━━━●─────] 100%                  │
├──────────────────────────────────────────────────┤
│ SCENE SETUP                                       │
│ Mode: [Map Maker ▼] [Revert to Original]         │
│ ☐ Enable Map Shine for this scene                │
├──────────────────────────────────────────────────┤
│ EFFECTS                                           │
│ ▶ Material Effects (3 active)                     │
│   ▶ Specular Highlights       [●][S][⎘]          │
│   ▶ Water                      [ ][S][⎘]          │
│ ▶ Particle Effects (0 active)                     │
│ ▶ Environmental (1 active)                        │
│ ▶ Post-Processing (0 active)                      │
└──────────────────────────────────────────────────┘

LEGEND:
● = Enabled toggle
S = Solo (debug)
⎘ = Copy and Paste settings
```

## Control Types System

### Standard Controls
- **Slider**: Numeric ranges with live preview
  - `{type: 'slider', min: 0, max: 2, step: 0.01}`
- **Toggle**: Boolean on/off
  - `{type: 'boolean'}`
- **Color**: RGB/HSV picker
  - `{type: 'color', format: 'rgb'}`
- **Dropdown**: Preset selection
  - `{type: 'list', options: ['low', 'medium', 'high']}`
- **XY Pad**: 2D vector input (light direction)
  - `{type: 'point2d', x: {min: -1, max: 1}, y: {min: -1, max: 1}}`

### Control Organization (Groups & Separators)
Effects can organize controls into logical groups for improved readability:
- **Inline Groups**: Parameters shown directly with optional separators between groups
- **Nested Folders**: Collapsible sub-folders for complex controls (e.g., stripe layers)
- **Separators**: Visual dividers between logical sections

```javascript
// Example: Organized control schema
{
  enabled: true,
  groups: [
    {
      name: 'material',
      label: 'Material Properties',
      type: 'inline',
      parameters: ['intensity', 'roughness', 'metallic']
    },
    {
      name: 'advanced',
      label: 'Advanced Settings',
      type: 'folder',  // Nested collapsible folder
      separator: true,  // Add visual separator before this group
      expanded: false,
      parameters: ['param1', 'param2', 'param3']
    }
  ],
  parameters: { /* parameter definitions */ }
}
```

Benefits:
- Reduces visual clutter with 20+ controls
- Allows collapsing unused sections
- Groups related parameters logically
- Maintains backward compatibility (flat structure still supported)

### Advanced Controls (Future)
- **Gradient Bar**: Particle color/opacity/emissiveness over lifetime
- **Curve Editor**: Animation easing
- **Clock**: 24hr circular time control with drag handle
- **Windsock**: Direction + strength (center of clock)

### Control Robustness Strategy

**Problem**: Original module had brittle UI that broke on changes.

**Solution**: Declarative control definitions
```javascript
// Effect declares controls, UI auto-generates
class SpecularEffect {
  getControlSchema() {
    return [
      {
        id: 'intensity',
        type: 'slider',
        label: 'Shine Intensity',
        min: 0, max: 2, step: 0.01,
        default: 0.5,
        help: 'How bright specular highlights appear on shiny surfaces'
      },
      // ... more controls
    ];
  }
}
```

**Benefits**:
- UI auto-rebuilds from schema
- Add/remove controls without breaking existing code
- Controls always match effect parameters
- Easy to version and migrate

### Human-Readable Number Scaling

- **Problem**: Ideal values can be tiny (e.g., 0.005 cloud speed) due to Foundry world units.
- **Approach**: Scale parameters to user-friendly ranges, display with readable units, map to shader/internal values.
- **Patterns**:
  - Speed: UI 0–100% → internal 0–0.05 (scale factor 0.0005)
  - Distances: UI in grid units/meters → internal world units
  - Angles: UI in degrees → convert to radians internally
- **Implementation**:
  - Each control in schema may define `uiScale`, `displayFormat`, `unit`.
  - Tweakpane shows scaled values; on change, value is converted back before applying.
  - Example: `{ id: 'cloudSpeed', type: 'slider', min: 0, max: 100, unit: '%', uiScale: 0.0005 }`

### Binding Validation & No-Silent-Fail

Goal: Detect when a control is not actually wired to a live parameter or uniform, and surface it immediately.

- **Schema Validation (build + runtime)**
  - Validate control schema against a JSON schema (id, label, type, ranges, uiScale) using a small validator.
  - On panel build, verify every `param` key exists in the effect's `params` object; unknown keys hard-fail in dev and show warning badge in prod.

- **Guarded Setters**
  - Route all param writes through a central setter: `effect.setParam(id, value)`.
  - Unknown `id` throws in dev; logs warning and ignores in prod.
  - Maintain a `paramVersion[id]++` on write; effect `update()` mirrors latest applied version.

- **Apply-Ack (Version Echo)**
  - UI increments `paramVersion[id]` when user changes a control.
  - Effect `update()` calls `ackParam(id, version)` when the uniform/state is actually applied.
  - If UI sees un-acked versions for > 250ms, it marks the control header with a red indicator and tooltip: "Value not applied".

- **Uniform Presence Check**
  - For ShaderMaterial-backed effects, on initialization and after material rebuilds, validate expected uniform names exist.
  - Missing uniform names generate a visible warning in the effect panel's debug section.

- **Live Consumption Watchdog**
  - Track timestamps `lastAppliedAt[id]` per param during `update()`.
  - If a control is changed but `lastAppliedAt` does not move within N frames, surface a warning.

- **Settings Load Validation**
  - When loading scene settings, validate per-effect params; unknown/removed params are reported and pruned with a migration note.

- **UI Indicators**
  - Control-level: small status dot (green applied, yellow pending, red stale/missing binding).
  - Effect-level: header badge showing count of warnings; click opens per-effect Debug Panel filtered to binding issues.

## Effect Control Pattern

Each effect provides:
```javascript
{
  id: 'specular',
  category: 'material',
  priority: 10,
  controls: [
    {type: 'slider', param: 'intensity', min: 0, max: 2, default: 0.5, 
     label: 'Shine Intensity', help: 'How bright specular highlights appear'},
    // ... more controls
  ]
}
```

## High-Level Presets (Per-Effect)

- **Goal**: Quick, safe starting points (e.g., Low / Medium / High) tailored per effect.
- **Schema**:
```javascript
// Optional on effect class
static getPresets() {
  return {
    Low:    { intensity: 0.25, roughness: 0.5, metallic: 0.0 },
    Medium: { intensity: 0.5,  roughness: 0.35, metallic: 0.1 },
    High:   { intensity: 0.9,  roughness: 0.2,  metallic: 0.15 }
  };
}
```
- **UI**: A compact preset dropdown at the top of each effect panel.
- **Behavior**: Selecting a preset sets all defined params atomically and marks overrides as changed.
- **Extensible**: Effects can add domain-specific presets (e.g., "Wet Stone", "Polished Metal").

## Settings Persistence

### Storage Strategy
- **Map Maker**: `scene.flags['map-shine-advanced'].settings.mapMaker`
- **GM Overrides**: `scene.flags['map-shine-advanced'].settings.gm`
- **Player**: `game.settings.get('map-shine-advanced', 'scene-${id}-player')`

### Copy/Paste System
```javascript
// Copy current effect settings to clipboard
copyEffectSettings(effectId) → JSON string

// Paste to same effect in different scene
pasteEffectSettings(effectId, jsonString)
```

## Default Settings Strategy

### Problem
Old module: Huge monolithic default object, hard to update.

### Solution
Per-effect defaults in effect class:
```javascript
class SpecularEffect {
  static getDefaults() {
    return {
      intensity: 0.5,
      roughness: 0.3,
      // ... all params
    };
  }
}
```

Export current scene as new defaults:
```javascript
// Dev command in console
MapShine.exportCurrentAsDefaults() → JSON for code
```

## Implementation Phases

### Phase 1: Foundation (Current Milestone)
- Create Tweakpane instance in Foundry Application
- Global controls section (master enable, time scale)
- Scene setup section (enable/disable, mode switcher)
- Single effect UI (Specular) as proof-of-concept
- Tweakpane plugins: essentials, textarea

**Tweakpane Setup**:
```javascript
const pane = new Tweakpane.Pane({
  title: 'Map Shine Advanced',
  container: htmlElement
});

// Global folder
const globalFolder = pane.addFolder({title: 'Global', expanded: true});
globalFolder.addBinding(settings, 'masterEnable');
globalFolder.addBinding(settings, 'timeScale', {min: 0, max: 1});

// Effects folder
const effectsFolder = pane.addFolder({title: 'Effects', expanded: true});
const materialFolder = effectsFolder.addFolder({title: 'Material Effects'});
// ... add effect controls
```

### Phase 2: Effect System
- **Create UI Stubs**:
  - Implement placeholder classes for all 25+ effects
  - Define minimal control schemas (enabled, intensity) for each
  - Register all stubs to validate UI scrolling, folding, and categorization
- Category folders
- Enable/solo/copy buttons
- Dynamic control generation from effect metadata
- Settings tier switching (Map Maker/GM)

### Phase 3: Advanced Features
- Gradient controls for particles
- Time/weather widgets
- Preset save/load
- Player simplified UI

## Branding & Support Links

### Prominent Placement
- **Top bar buttons**: `[Support on Patreon] [Get Maps]`
- **Patreon**: https://www.patreon.com/c/MythicaMachina
- **Store**: https://www.foundryvtt.store/creators/mythica-machina
- Open in new tab, don't navigate away from Foundry

### Help System
- **Tooltip**: Hover any control for quick help
- **Help Icon**: Click for detailed documentation
- **Examples**: "Cloud Coverage" not "Noise Octaves"

## Effect Organization Details

### Categories
1. **Atmospheric & Environmental** - Cloud Shadows, Time of Day, Weather, Heat Distortion, Lightning, Ambient, Cloud Depth
2. **Surface & Material** - Metallic Shine, Water, Foam, Iridescence, Ground Glow, Biofilm
3. **Object & Structure** - Structural Shadows, Building Shadows, Canopy Distortion, Physics Rope, Bush & Tree, Overhead Effect
4. **Particle Systems** - Dust, Fire & Sparks, Steam, Metallic Glints, Smelly Flies
5. **Global & UI Effects** - Post-Processing, Prism, Scene Transitions, Pause Effect, Loading Screen, Map Points

### Priority System
Effects render in priority order within layer:
- Priority 10: Core visual (specular, material effects)
- Priority 5: Standard effects (environmental, particles)
- Priority 1: Optional polish (post-processing)

### Effect Actions
- **Enable Toggle**: Turn effect on/off
- **Solo Button**: Disable all others (debug)
- **Copy Button**: Export settings to clipboard as JSON
- **Paste**: Load settings from clipboard (same effect, different scene)

## Per-Effect Debug Panel

- **Visibility**: Hidden by default; toggle via a small bug icon on the effect header.
- **Purpose**: Diagnose effect behavior without leaving the UI.
- **Capabilities**:
  - View intermediate outputs (e.g., stripes-only, mask-only, normal-only) using temporary shader defines/uniforms.
  - Toggle wireframe/overlays and show bounding boxes if applicable.
  - Display live metrics: frame delta, effect render time, texture presence flags.
  - Quick reset of this effect to defaults.
- **Implementation Notes**:
  - Add debug uniforms like `uDebugMode` (enum) and branches in shaders guarded for performance.
  - Integrate with centralized TimeManager controls (pause/scale for this effect only when possible).

## Key Files

- `scripts/ui/tweakpane-manager.js` - Tweakpane wrapper
- `scripts/ui/effect-controls.js` - Dynamic control builder
- `scripts/ui/control-types.js` - Custom control definitions
- `scripts/ui/effect-panel.js` - Per-effect UI builder
- `scripts/settings/defaults.js` - Default value registry
- `scripts/settings/import-export.js` - Copy/paste/export functionality

## User Workflows

### Map Maker: Setting Up a Map
1. Open scene with Map Shine compatible map
2. Open Map Shine UI (scene controls button)
3. Enable "Map Shine for this scene"
4. Adjust effects to match map's artistic vision
5. Save scene (settings auto-saved to scene flags)
6. Export/share scene (settings travel with it)

### GM: Customizing for Table
1. Load Map Maker's scene
2. Open Map Shine UI
3. Switch mode to "GM" (top of panel)
4. Tweak effects (GM overrides created automatically)
5. Changes saved to scene flags
6. Can "Revert to Original" to restore Map Maker vision

### Player: Performance Control
1. Open simplified Map Shine UI (different interface)
2. Disable heavy effects if experiencing lag
3. Settings saved client-local only
4. Cannot break GM's or Map Maker's vision

## Permission Handling

### Access Control
```javascript
if (!game.user.isGM) {
  // Show player UI only
  showPlayerInterface();
} else {
  // Show full GM/Map Maker UI
  showFullInterface();
}
```

### UI Visibility
- **GM/Admin**: Access to full UI from scene controls
- **Player**: Simplified performance UI only
- Settings save functions check permissions before writing

## UI Performance Optimization

**Critical**: Original module halved FPS due to UI overhead. Must avoid this.

### Anti-Patterns to Avoid
- ❌ Updating UI controls every frame
- ❌ Triggering effect updates on every `input` event
- ❌ Direct binding: control change → uniform write
- ❌ Heavy DOM manipulation during render loop
- ❌ Synchronous saves on every parameter change

### Performance Strategies

**1. Decoupled Update Loop**
- UI updates run on separate RAF loop at 10-15 FPS max (vs render loop at 30-60 FPS)
- Display values update from effect state snapshot, not live reads
- UI loop pauses when panel is collapsed or hidden

**2. Dirty Flag System**
- Track `dirtyParams` set; batch updates to effects once per UI frame
- Effects track `lastUIVersion` to skip redundant uniform writes
- Only update controls when values changed externally (preset applied, settings loaded)

**3. Event Throttling**
- Slider `input` events: debounce to ~100ms before param update
- Slider `change` (release): immediate update + save queue
- Text input: debounce to 300ms
- Color picker: throttle to 60ms during drag, immediate on release

**4. Lazy Rendering**
- Only render visible effect panels (collapsed folders don't rebuild controls)
- Virtual scrolling if effect list exceeds 20 items
- Tweakpane blade pooling for dynamic controls

**5. Batched Persistence**
- Queue saves to scene flags; flush every 500ms max
- Debounce per-effect: only save after 1 second of no changes
- Use `scene.update()` batch API for multiple effects at once

**6. Measurement & Monitoring**
- Track UI frame budget (should be <2ms per UI frame)
- Warning if UI loop exceeds budget 3 frames in a row
- Expose `MapShine.uiPerf` object with metrics for diagnostics

### Implementation Pattern
```javascript
class TweakpaneManager {
  constructor() {
    this.uiFrameRate = 15; // Hz
    this.dirtyParams = new Set();
    this.saveQueue = new Set();
    this.lastUIFrame = 0;
  }
  
  // Separate UI loop from render loop
  startUILoop() {
    const uiLoop = () => {
      if (!this.visible) {
        requestAnimationFrame(uiLoop);
        return;
      }
      
      const now = performance.now();
      const delta = now - this.lastUIFrame;
      if (delta < 1000 / this.uiFrameRate) {
        requestAnimationFrame(uiLoop);
        return;
      }
      
      this.lastUIFrame = now;
      this.updateDirtyParams(); // Batch param updates
      this.flushSaveQueue();    // Batch saves
      
      requestAnimationFrame(uiLoop);
    };
    requestAnimationFrame(uiLoop);
  }
}
```

## Forward-Thinking Features

### Not Yet Discussed

**1. Keyboard Shortcuts**
- `Ctrl+Shift+M`: Toggle Map Shine panel
- `Ctrl+S`: Save current settings (confirmation toast)
- `Ctrl+Z` / `Ctrl+Y`: Undo/redo (see below)
- `Space`: Solo selected effect (toggle)
- `/`: Focus search/filter box

**2. Undo/Redo System**
- Circular buffer of last 20 param changes (per session)
- Command pattern: `{effectId, paramId, oldValue, newValue, timestamp}`
- UI shows undo availability (grayed if empty)
- Survives panel close/reopen within session
- **Not** persisted to scene flags (session-only)

**3. Search & Filter**
- Text box at top of effects list
- Fuzzy search by effect name, category, or param name
- Filter by: enabled, category, GPU tier requirement
- Highlight matching effects; collapse non-matching folders

**4. Panel Behavior**
- Dockable: left, right, or floating
- Resizable (remember size in client settings)
- Collapsible (minimize to title bar)
- Pin (stay on top) vs unpinned (normal window)
- Remember state across sessions (client-local)

**5. Batch Operations**
- Select multiple effects (checkboxes when in batch mode)
- Apply preset to all selected
- Enable/disable all selected
- Copy settings from one → paste to multiple

**6. Scene Templates**
- Save current scene settings as named template ("Desert Day", "Stormy Night")
- Apply template to new scene (copies all effect configs)
- Template library stored in world settings (shared across scenes)
- Ship module with 3-5 example templates

**7. Settings Import/Export**
- Export scene settings as `.json` file
- Import from file (merges or replaces)
- Share templates via files (not just copy/paste)
- Validate imported JSON before applying

**8. Accessibility**
- Keyboard navigation through all controls (tab order)
- ARIA labels on custom controls
- Screen reader announcements for value changes
- High contrast mode support (read from OS/Foundry theme)
- Focus indicators

**9. Localization Hooks**
- All UI strings externalized to `languages/en.json`
- Control labels, help text, tooltips, warnings
- Use Foundry's `game.i18n.localize()` API
- Community can add translations without code changes

**10. Mobile/Touch Considerations**
- Touch-friendly control sizes (min 44×44px targets)
- Swipe to collapse/expand folders
- Long-press for context menu (copy/paste/reset)
- Responsive layout for portrait tablets
- **Note**: Not primary target, but avoid hard blocks

**11. Visibility Toggle**
- Hotkey or button to hide panel completely (not just collapse)
- Hides from DOM to avoid any performance cost
- Quick toggle for screenshots/presentations

**12. Live Preview Thumbnails**
- Small preview image for certain effects (if feasible)
- Render effect output to 128×128 canvas
- Update on preset change or major param change
- Expensive - only for select effects, opt-in

**13. UI State Persistence**
- Remember which folders are expanded/collapsed (per user)
- Remember scroll position in effects list
- Remember last selected effect
- Stored in client settings, not scene flags

**14. Error Recovery**
- If effect breaks (shader compile error), mark in UI with warning icon
- Don't crash entire panel; allow editing other effects
- Show error details in per-effect debug panel
- "Safe mode" button to disable all effects and reset

**15. Performance Budget Display**
- Optional overlay showing FPS, frame time, UI budget
- Color-coded: green <16ms, yellow 16-33ms, red >33ms
- Per-effect render time (via GPU timer queries if available)
- Warn if effect exceeds budget consistently

## Next Steps

### Immediate (Phase 1)
1. Create `scripts/ui/tweakpane-manager.js`
2. Integrate Tweakpane library (CDN or vendor)
3. Build Foundry Application wrapper
4. Implement global controls
5. Wire Specular effect to UI **with throttling**
6. Test save/load with scene flags
7. **Measure UI performance baseline**

### Near-Term (Phase 2)
1. Generalize effect control generation
2. Implement copy/paste functionality
3. Add mode switcher (Map Maker/GM)
4. Build effect category folders
5. Add solo/enable buttons

### Future (Phase 3)
1. Custom gradient control plugin
2. Clock/windsock widgets
3. Player simplified interface
4. Preset save/load system
5. In-app help documentation

---

## Appendix: Tweakpane Resources

- **Main Site**: https://cocopon.github.io/tweakpane/
- **Plugin System**: https://cocopon.github.io/tweakpane/plugins.html
- **Examples**: https://cocopon.github.io/tweakpane/examples.html
- **Custom Plugins**: May need for gradient bar, clock/windsock

## Appendix: Design Mockup Notes

### Visual Hierarchy
- Global controls: Always visible at top
- Scene setup: Collapsible, expanded by default
- Effects: Collapsible categories, remember expansion state
- Branding: Subtle but prominent, top-right

### Responsive Behavior
- Panel width: 320px minimum, 480px comfortable
- Height: Scrollable if exceeds viewport
- Remember position between sessions
- Dock to right side of Foundry window
