# Unified Light System - Planning Document

## Problem Statement

The current lighting system has two separate workflows:
1. **Foundry VTT native lights** - Created via standard Foundry tool, stored as `AmbientLight` documents
2. **MapShine enhanced lights** - Created via separate tool buttons, stored in scene flags

This creates confusion because:
- Users don't know which type to create
- Cookie textures, layer targeting, and other advanced features only work on "enhanced" lights
- Users try to add cookies to Foundry lights and nothing happens
- Two separate tool buttons in the lighting controls (`MapShine Light`, `MapShine Sun Light`)
- Different UIs for different light types (though `LightRingUI` attempts to handle both)

---

## Goal

**One workflow**: Users create lights the normal Foundry way. When they enable advanced features (cookies, layer targeting, sun-light behavior, etc.), MapShine automatically "enhances" the light behind the scenes. A warning appears reminding users these features require Map Shine Advanced.

---

## Design Principles

1. **Foundry-first**: All lights start as Foundry `AmbientLight` documents
2. **Progressive enhancement**: Advanced features trigger automatic enhancement
3. **Transparent linking**: Enhanced data is linked to the Foundry light by ID
4. **Graceful degradation**: Without MapShine, lights still work (just without enhancements)
5. **Consistent UI**: Use Tweakpane for all light editing dialogs

---

## Architecture Changes

### A. Remove Separate Enhanced Light Creation

**Current state:**
- `map-shine-enhanced-light` tool creates standalone enhanced lights
- `map-shine-sun-light` tool creates standalone sun lights
- These lights exist only in scene flags, not as Foundry documents

**New state:**
- Remove both tool buttons from the lighting controls
- All lights are created via Foundry's native tool
- Enhanced features are stored as "overlays" linked to Foundry light IDs

### B. Unified Data Model

```
Foundry AmbientLight (source of truth for position, basic photometry)
    ↓
MapShine Enhancement Layer (scene flags, keyed by Foundry light ID)
    - cookieEnabled, cookieTexture, cookieRotation, cookieScale, cookieStrength, etc.
    - targetLayers ('ground' | 'overhead' | 'both')
    - outputGain, outerWeight, innerWeight
    - darknessResponse (sun-light behavior)
    - animation overrides (cableswing motion params, etc.)
```

**Migration:** Existing standalone enhanced lights could be converted to linked enhancements + newly created Foundry lights, or kept for backwards compatibility with a deprecation warning.

### C. Automatic Enhancement Trigger

When a user edits a Foundry light and enables any of these features, MapShine automatically creates/updates an enhancement record:

| Feature | Enhancement Trigger |
|---------|---------------------|
| Cookie texture | `cookieEnabled = true` or `cookieTexture` set |
| Layer targeting | `targetLayers !== 'both'` |
| Output shaping | `outputGain !== 1.0`, `outerWeight !== 0.5`, `innerWeight !== 0.5` |
| Sun Light mode | `darknessResponse.enabled = true` |
| Cable Swing | `animation.type === 'cableswing'` |
| Cookie shaping | `cookieStrength`, `cookieContrast`, `cookieGamma`, `cookieInvert`, `cookieColorize` |

### D. Warning Banner

When any enhancement is active, display a warning at the top of the light editor:

```
⚠️ This light uses Map Shine Advanced features (cookie texture, layer targeting).
   These effects will not appear without Map Shine Advanced enabled.
```

The warning should:
- Be dismissible (per-session, not permanently)
- List which specific features are active
- Not be annoying (only show once per light edit session)

---

## UI Changes

### A. Replace Custom Dialogs with Tweakpane

**Current UIs:**
- `LightRingUI` - Custom radial SVG + details panel
- `EnhancedLightInspector` - Custom inspector panel

**New UIs:**
- **Light Ring** - Keep the radial SVG for quick visual editing (it's unique and useful)
- **Light Details Panel** - Replace the custom details with a Tweakpane pane
- **Animation Panel** - Replace `LightAnimDialog` with Tweakpane folder
- **Remove `EnhancedLightInspector`** - Merge into unified details panel

### B. Unified Light Editor Structure (Tweakpane)

```
Light Editor (Tweakpane Pane)
├── Core (always visible)
│   ├── Enabled [checkbox]
│   ├── Darkness Mode [checkbox]
│   ├── Dim Radius [slider]
│   ├── Bright Radius [slider]
│   ├── Color [color picker]
│   ├── Alpha [slider 0-1]
│   ├── Attenuation [slider 0-1]
│   └── Luminosity [slider 0-1]
│
├── Animation [folder, collapsible]
│   ├── Type [dropdown]
│   ├── Speed [slider]
│   ├── Intensity [slider]
│   ├── Reverse [checkbox]
│   └── (Cable Swing sub-folder if type === 'cableswing')
│       ├── Max Offset [slider]
│       ├── Spring [slider]
│       ├── Damping [slider]
│       └── Wind Influence [slider]
│
├── ⚠️ Advanced (Map Shine) [folder, collapsible]
│   ├── [Warning banner if any feature enabled]
│   │
│   ├── Cookie/Gobo [sub-folder]
│   │   ├── Enabled [checkbox]
│   │   ├── Texture [file picker button]
│   │   ├── Rotation [slider 0-360]
│   │   ├── Scale [slider 0.1-5]
│   │   ├── Strength [slider]
│   │   ├── Contrast [slider]
│   │   ├── Gamma [slider]
│   │   ├── Invert [checkbox]
│   │   ├── Colorize [checkbox]
│   │   └── Tint [color picker]
│   │
│   ├── Output Shaping [sub-folder]
│   │   ├── Output Gain [slider]
│   │   ├── Outer Weight [slider]
│   │   └── Inner Weight [slider]
│   │
│   ├── Layer Targeting [sub-folder]
│   │   └── Target Layers [dropdown: Both/Ground/Overhead]
│   │
│   └── Sun Light [sub-folder]
│       ├── Enabled [checkbox]
│       ├── Invert [checkbox]
│       ├── Exponent [slider]
│       ├── Min [slider 0-1]
│       └── Max [slider 0-1]
```

### C. Visual Indicator on Light Icons

When a Foundry light has MapShine enhancements, show a small badge/indicator on its icon in the canvas. This helps users identify which lights have advanced features.

---

## Implementation Plan

### Phase 1: Data Layer Refactor
1. Create `LightEnhancementStore` - manages enhancement data keyed by Foundry light ID
2. Modify `EnhancedLightsApi` to support linked mode (Foundry ID as key)
3. Add migration for existing standalone enhanced lights
4. Update `LightingEffect` to merge Foundry + enhancement data

### Phase 2: UI Consolidation
1. Create `LightEditorPane` class using Tweakpane
2. Integrate with `LightRingUI` (replace details panel)
3. Remove `EnhancedLightInspector` (merge into main editor)
5. Add warning banner component

### Phase 3: Tool Cleanup
1. Remove `map-shine-enhanced-light` tool button
2. Remove `map-shine-sun-light` tool button
3. Update `interaction-manager.js` to remove enhanced light placement code
4. Update documentation

### Phase 4: Polish
1. Add visual badge for enhanced lights
2. Improve Tweakpane styling to match MapShine aesthetic
3. Add keyboard shortcuts for common actions
4. User testing and feedback

---

## Migration Strategy

### Existing Standalone Enhanced Lights

Option A: **Auto-migrate on scene load**
- For each standalone enhanced light, create a Foundry `AmbientLight` at the same position
- Link the enhancement to the new Foundry light ID
- Mark the old standalone record as migrated

Option B: **Keep both systems (deprecated)**
- Standalone lights continue to work
- Show deprecation warning encouraging users to recreate as Foundry lights
- Remove standalone support in a future major version

**Recommendation:** Option A with a one-time migration notice to users.

---

## Open Questions

1. **Foundry light sheet integration**: Should we hook into Foundry's native `AmbientLightConfig` sheet and inject our Tweakpane UI, or keep it as a separate overlay?
   - Pros of injection: More native feel, single sheet
   - Cons: More fragile, may break with Foundry updates

2. **Position editing**: Currently enhanced lights have independent position. With linking, position comes from Foundry. Do we need position override capability?

3. **Performance**: Will merging enhancement data on every render loop add overhead? (Probably negligible, but worth profiling.)

4. **Multi-select**: Should the unified editor support editing multiple lights at once?

---

## Success Metrics

- [ ] Users can create lights using only Foundry's native tool
- [ ] Cookie textures work on any light (not just "enhanced" lights)
- [ ] Single unified editor for all light properties
- [ ] Warning clearly communicates MapShine dependency
- [ ] Existing scenes continue to work after update
- [ ] No regression in rendering quality or performance

---

## Timeline Estimate

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Data Layer | 2-3 days | None |
| Phase 2: UI Consolidation | 3-4 days | Phase 1 |
| Phase 3: Tool Cleanup | 1 day | Phase 2 |
| Phase 4: Polish | 2 days | Phase 3 |

**Total: ~8-10 days of focused work**

---

## Additional UI Improvements to Consider

1. **Preset system**: Quick buttons for common light setups (Torch, Candle, Neon, etc.) - already partially exists in `LightAnimDialog`

2. **Light templates**: Save/load custom light configurations

3. **Batch operations**: Apply settings to multiple selected lights

4. **Live preview**: Show changes in real-time before committing (already works)

5. **Undo/Redo**: Integrate with Foundry's undo system if possible

6. **Search/filter**: In scenes with many lights, ability to filter by type/color/enhancement status

7. **Copy/paste light settings**: Right-click menu to copy settings from one light to another

8. **Contextual help**: Tooltips explaining what each parameter does, especially for advanced features
