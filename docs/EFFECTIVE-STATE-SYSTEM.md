# Effective State & Smart Control System

## Overview

The system automatically detects when effects or sub-effects are **enabled but ineffective** (producing no visual output) and provides:

1. **Visual warnings** when effect is on but doing nothing
2. **Smart control disabling** - grays out controls that don't apply
3. **Dependency management** - Layer 2 controls disabled when Layer 2 is off

## The Problem This Solves

### Before
```
Specular Effect
  ✅ Enabled: true
  Shine Intensity: 0.5
  ✅ Enable Stripes: true
  ✅ Layer 1 Enabled: true
     Layer 1 Intensity: 0      ← Enabled but invisible!
     Layer 1 Width: 0           ← Enabled but invisible!
  ✅ Layer 2 Enabled: false
     Layer 2 Frequency: 8.0     ← Still interactive!
     Layer 2 Speed: -0.1        ← Still interactive!
```

**User confusion:**
- "Why can't I see the stripes?" (intensity/width = 0)
- "Why are these controls active?" (Layer 2 disabled)
- No indication that settings are ineffective

### After
```
Specular Effect
  ⚠️ Status: Stripes enabled but all layers ineffective (zero intensity or width)
  ✅ Enabled: true
  Shine Intensity: 0.5
  ✅ Enable Stripes: true
  ✅ Layer 1 Enabled: true
     Layer 1 Intensity: 0      ← Warning shows why no effect
     Layer 1 Width: 0
  ⬜ Layer 2 Enabled: false
     Layer 2 Frequency: 8.0     ← GRAYED OUT (disabled)
     Layer 2 Speed: -0.1        ← GRAYED OUT (disabled)
```

**Clear feedback:**
- Orange warning explains the problem
- Inactive controls are visually disabled
- User knows exactly what's wrong

## How It Works

### 1. Effective State Detection

For each effect, the system calculates if it will produce visible output:

```javascript
// Specular effect is ineffective if:
// 1. Intensity = 0 (no shine visible)
// 2. Stripes enabled but ALL layers have:
//    - intensity = 0 OR
//    - width = 0 OR
//    - layer disabled

getSpecularEffectiveState(params) {
  if (params.intensity === 0) {
    return { effective: false, reasons: ['Shine intensity is 0'] };
  }
  
  if (params.stripeEnabled) {
    const hasActiveStripe = /* check all layers */;
    if (!hasActiveStripe) {
      return { 
        effective: false, 
        reasons: ['All stripe layers ineffective'] 
      };
    }
  }
  
  return { effective: true, reasons: [] };
}
```

### 2. Status Warning Display

Orange warning box appears when:
- Effect is **enabled** (checkbox checked)
- Effect is **ineffective** (no visual output)

```javascript
updateEffectiveState(effectId) {
  const state = getEffectiveState(params);
  
  if (!state.effective && params.enabled) {
    // Show warning
    statusElement.textContent = state.reasons.join('; ');
    statusElement.style.display = 'block';
  } else {
    // Hide warning
    statusElement.style.display = 'none';
  }
}
```

**When warning shows:**
- Effect checkbox: ✅ (enabled)
- But effect not rendering properly

**When warning hides:**
- Effect checkbox: ⬜ (disabled) - expected behavior
- Or effect is working correctly

### 3. Smart Control Disabling

Controls automatically gray out based on dependencies:

```javascript
updateControlStates(effectId) {
  const depState = getDependencyState(params);
  
  // Disable stripe blend mode if stripes off
  if (paramId === 'stripeBlendMode' && !params.stripeEnabled) {
    binding.disabled = true;
  }
  
  // Disable Layer 1 controls if Layer 1 off
  if (paramId.startsWith('stripe1') && !params.stripe1Enabled) {
    binding.disabled = true;
  }
  
  // ... same for Layer 2, Layer 3
}
```

## Dependency Rules

### Specular Effect

**Global Stripe Controls** (disabled when `stripeEnabled = false`):
- Stripe Blend Mode
- Parallax Strength

**Layer 1 Controls** (disabled when `stripe1Enabled = false`):
- Layer 1 Frequency
- Layer 1 Speed
- Layer 1 Angle
- Layer 1 Width
- Layer 1 Intensity
- Layer 1 Parallax

**Layer 2 Controls** (disabled when `stripe2Enabled = false`):
- Layer 2 Frequency
- Layer 2 Speed
- Layer 2 Angle
- Layer 2 Width
- Layer 2 Intensity
- Layer 2 Parallax

**Layer 3 Controls** (disabled when `stripe3Enabled = false`):
- Layer 3 Frequency
- Layer 3 Speed
- Layer 3 Angle
- Layer 3 Width
- Layer 3 Intensity
- Layer 3 Parallax

## Effective State Conditions

### Specular Effect is **Ineffective** when:

1. **Main intensity is 0**
   ```
   intensity: 0
   → "Shine intensity is 0 (no visual effect)"
   ```

2. **Stripes enabled but all layers ineffective**
   ```
   stripeEnabled: true
   stripe1Enabled: true, intensity: 0  ← ineffective
   stripe2Enabled: true, width: 0      ← ineffective
   stripe3Enabled: false               ← ineffective
   → "Stripes enabled but all layers ineffective"
   ```

3. **Layer is ineffective if:**
   - `enabled = false`, OR
   - `intensity = 0`, OR
   - `width = 0`

## Visual States

### Status Warning Box

**Appearance:**
```css
background: #3a3a3a
border: 1px solid #ffa500
color: #ffa500
```

**Content:**
```
⚠️ Status: Shine intensity is 0 (no visual effect)
```

**Visibility:**
- `display: block` when enabled but ineffective
- `display: none` when disabled or working

### Disabled Controls

**Visual:**
- Text grayed out
- Slider not draggable
- Checkbox not clickable

**Tweakpane API:**
```javascript
binding.disabled = true;  // Gray out control
binding.disabled = false; // Enable control
```

## Update Triggers

State updates automatically when:

1. **Effect enabled/disabled**
   ```javascript
   enableBinding.on('change', () => {
     updateEffectiveState(effectId);
     updateControlStates(effectId);
   });
   ```

2. **Parameter changed**
   ```javascript
   binding.on('change', () => {
     updateEffectiveState(effectId);  // Check if still effective
     updateControlStates(effectId);   // Update disabled states
   });
   ```

3. **Settings loaded**
   ```javascript
   registerEffect() {
     // Initial state update
     updateEffectiveState(effectId);
     updateControlStates(effectId);
   }
   ```

4. **Mode switched (Map Maker ↔ GM)**
   ```javascript
   reloadAllEffectParameters() {
     for (effect of effects) {
       updateEffectiveState(effectId);
       updateControlStates(effectId);
     }
   }
   ```

5. **Reset to defaults**
   ```javascript
   resetEffectToDefaults() {
     // ... reset params ...
     updateEffectiveState(effectId);
     updateControlStates(effectId);
   }
   ```

## Examples

### Example 1: Layer Disabled

**Settings:**
```javascript
{
  stripe1Enabled: false,
  stripe1Frequency: 10.0,  // Still has value
  stripe1Speed: 0.5,       // Still has value
  stripe1Intensity: 1.0    // Still has value
}
```

**Result:**
- `⬜ Layer 1 Enabled` checkbox unchecked
- All Layer 1 controls **GRAYED OUT**
- Can't interact with frequency, speed, intensity, etc.
- Prevents confusion about why changes don't work

### Example 2: Intensity Zero

**Settings:**
```javascript
{
  enabled: true,
  stripeEnabled: true,
  stripe1Enabled: true,
  stripe1Intensity: 0,  // ← Problem!
  stripe1Width: 0.5
}
```

**Result:**
```
⚠️ Status: Stripes enabled but all layers ineffective (zero intensity or width)
```

- Warning appears at top of effect panel
- All controls still interactive (can adjust to fix)
- Clear explanation of the problem

### Example 3: Width Zero

**Settings:**
```javascript
{
  enabled: true,
  stripeEnabled: true,
  stripe1Enabled: true,
  stripe1Intensity: 1.0,
  stripe1Width: 0  // ← Problem!
}
```

**Result:**
```
⚠️ Status: Stripes enabled but all layers ineffective (zero intensity or width)
```

- Same warning (width = 0 also makes layer ineffective)
- User knows to increase width

### Example 4: Multiple Layers, Some Active

**Settings:**
```javascript
{
  enabled: true,
  stripeEnabled: true,
  stripe1Enabled: true,
  stripe1Intensity: 0.5,  // ✅ Active
  stripe1Width: 0.4,
  stripe2Enabled: false,  // ⬜ Disabled
  stripe2Intensity: 1.0,
  stripe3Enabled: true,
  stripe3Intensity: 0,    // ❌ Ineffective
  stripe3Width: 0.5
}
```

**Result:**
- **No warning** (Layer 1 is active, so effect is effective)
- Layer 2 controls **GRAYED OUT** (disabled)
- Layer 3 controls **ACTIVE** (enabled but ineffective)

Layer 1 provides visual output, so no warning shown.

## Console Diagnostics

Updated diagnostics show effective state:

```javascript
MapShine.debug.diagnoseSpecular()
```

**Output:**
```
🔍 Map Shine Specular Diagnostics
  ✅ Specular effect found
  Enabled: true
  ⚠️ Effect is ineffective: ["Stripes enabled but all layers ineffective"]
  ✅ Material exists
  ✅ Validation passed
  
  Parameters
    ✅ intensity: 0.5
    ✅ stripe1Intensity: 0    ← Problem here
    ✅ stripe1Width: 0.4
    ...
  
  💡 Suggestions
    Increase stripe1Intensity above 0 to see effect
```

## API Reference

### getSpecularEffectiveState(params)
```javascript
/**
 * @param {Object} params - Effect parameters
 * @returns {Object} { effective: boolean, reasons: string[] }
 */
```

**Returns:**
- `effective: true` - Effect will produce visual output
- `effective: false` - Effect enabled but no visual output
- `reasons: []` - Array of why ineffective

### getStripeDependencyState(params)
```javascript
/**
 * @param {Object} params - Effect parameters
 * @returns {Object} {
 *   stripeControlsActive: boolean,
 *   stripe1Active: boolean,
 *   stripe2Active: boolean,
 *   stripe3Active: boolean
 * }
 */
```

**Returns:**
- `stripeControlsActive` - true if stripeEnabled
- `stripe1Active` - true if stripeEnabled && stripe1Enabled
- `stripe2Active` - true if stripeEnabled && stripe2Enabled
- `stripe3Active` - true if stripeEnabled && stripe3Enabled

### updateEffectiveState(effectId)
Internal method - updates status warning visibility

### updateControlStates(effectId)
Internal method - updates control disabled states

## Best Practices

### For Users

✅ **DO:**
- Watch for orange warning boxes
- Read the warning message - it tells you exactly what's wrong
- Check grayed-out controls to see what's disabled
- Adjust parameters to make effect functional

❌ **DON'T:**
- Ignore warning messages
- Try to adjust grayed-out controls (they won't work)
- Wonder why Layer 2 controls don't do anything (check if Layer 2 is enabled)

### For Developers

✅ **DO:**
- Add effective state checkers for new effects
- Consider zero-value parameters ineffective if they prevent output
- Disable child controls when parent is disabled
- Update state after every parameter change

❌ **DON'T:**
- Leave controls interactive when they have no effect
- Show warnings for disabled effects (expected behavior)
- Forget to update state on mode switch or reload

## Extending to New Effects

To add effective state checking for a new effect:

### 1. Create Effective State Function
```javascript
export function getMyEffectEffectiveState(params) {
  const reasons = [];
  
  if (!params.enabled) {
    return { effective: false, reasons: ['Effect is disabled'] };
  }
  
  // Check conditions that make effect ineffective
  if (params.someValue === 0) {
    reasons.push('someValue is 0 (no effect)');
  }
  
  return {
    effective: reasons.length === 0,
    reasons
  };
}
```

### 2. Create Dependency State Function (if needed)
```javascript
export function getMyEffectDependencyState(params) {
  return {
    subFeatureActive: params.parentEnabled && params.subFeatureEnabled
  };
}
```

### 3. Update TweakpaneManager
```javascript
// In updateEffectiveState()
if (effectId === 'myEffect') {
  effectiveState = getMyEffectEffectiveState(effectData.params);
}

// In updateControlStates()
if (effectId === 'myEffect') {
  depState = getMyEffectDependencyState(effectData.params);
  
  // Apply disabled states
  if (paramId === 'subParam' && !depState.subFeatureActive) {
    binding.disabled = true;
  }
}
```

## Future Enhancements

### Planned
- [ ] Show count of active/inactive layers in effect title
- [ ] Green indicator when effect is optimal
- [ ] Tooltips explaining why controls are disabled
- [ ] Batch enable/disable for multiple layers

### Under Consideration
- [ ] "Fix ineffective" button (auto-adjust to working state)
- [ ] Performance impact indicator per layer
- [ ] Suggest alternative settings if current is ineffective
- [ ] Visual hierarchy showing dependency tree

---

**Last Updated**: 2024-11-18  
**Version**: 0.2.0  
**Status**: Implemented ✅
