# Auto-Disable System - Intelligent Layer Management

## Overview

The system **automatically manages layer enable states** based on parameter values, making it immediately obvious when settings create ineffective layers.

## The Behavior

### Auto-Disable (Intensity or Width = 0)

**When user sets intensity OR width to 0:**

1. ✅ **Layer checkbox auto-unchecks** (layer disabled)
2. 🔴 **Problem control label turns RED** (intensity or width that's 0)
3. ✅ **Problem control stays ENABLED** (user can still adjust it)
4. ⚫ **Other layer controls GRAY OUT** (disabled until fixed)

**Example: User sets Layer 3 Intensity to 0**

```
Before:
✅ Layer 3 Enabled
   Layer 3 Intensity  [●──────] 1.75
   Layer 3 Width      [───●───] 0.50

After sliding intensity to 0:
⬜ Layer 3 Enabled          ← AUTO-UNCHECKED
   Layer 3 Intensity  [●──────] 0.00  (RED LABEL)  ← STAYS ENABLED, RED WARNING
   Layer 3 Width      [───●───] 0.50  (GRAYED)     ← DISABLED
   Layer 3 Frequency  [───────] 8.0   (GRAYED)     ← DISABLED
   Layer 3 Speed      [───────] -0.10 (GRAYED)     ← DISABLED
   ... all other controls grayed out
```

### Auto-Re-Enable (Fix the Problem)

**When user increases value above 0:**

1. ✅ **Layer checkbox auto-checks** (layer re-enabled)
2. ⚪ **Red warning removed** (no longer a problem)
3. ✅ **All controls re-enabled** (back to normal)

**Example: User increases intensity from 0 to 0.5**

```
After increasing intensity:
✅ Layer 3 Enabled          ← AUTO-CHECKED BACK
   Layer 3 Intensity  [──●────] 0.50  (NORMAL)    ← RED CLEARED
   Layer 3 Width      [───●───] 0.50  (ENABLED)   ← RE-ENABLED
   Layer 3 Frequency  [────●──] 8.0   (ENABLED)   ← RE-ENABLED
   Layer 3 Speed      [──●────] -0.10 (ENABLED)   ← RE-ENABLED
   ... all controls active again
```

## Both Conditions Required

Layer is **auto-disabled** if **EITHER** condition is true:
- `intensity = 0` OR
- `width = 0`

Layer is **auto-enabled** if **BOTH** conditions are true:
- `intensity > 0` AND
- `width > 0`

### Example Scenarios

**Scenario 1: Both are 0**
```
intensity: 0, width: 0
→ Layer disabled
→ BOTH controls show red warning
→ User must fix BOTH to re-enable
```

**Scenario 2: One is 0**
```
intensity: 0.5, width: 0
→ Layer disabled
→ Only width shows red warning
→ User fixes width → layer re-enables
```

**Scenario 3: User fixes one but other is still 0**
```
Start: intensity: 0, width: 0 (layer disabled)
User increases intensity to 0.5
→ Layer STAYS disabled (width still 0)
→ Intensity red cleared, width still red
→ User increases width to 0.4
→ Layer NOW re-enables (both fixed)
```

## Visual Indicators

### Red Label (Problem Control)
```css
color: #ff4444
```

**When shown:**
- Parameter value is 0
- This is causing layer to be disabled
- User needs to increase this value

**When removed:**
- Parameter increased above 0
- OR layer manually re-enabled by user

### Grayed Controls (Disabled)
- Standard Tweakpane disabled appearance
- Not interactive
- Only non-problem controls

### Normal Controls (Active)
- Default Tweakpane appearance
- Fully interactive
- Problem controls when layer enabled
- All controls when layer enabled

## User Experience Flow

### Flow 1: Accidentally Set to Zero

1. **User drags slider all the way left** (intensity → 0)
2. **Checkbox unchecks itself** (obvious something happened)
3. **Slider label turns red** (obvious THIS is the problem)
4. **Other sliders gray out** (obvious they don't matter now)
5. **User thinks:** "Oh, I need to increase this red one"
6. **User drags red slider right** (intensity → 0.5)
7. **Checkbox re-checks itself** (layer back on)
8. **Red warning clears** (problem solved)
9. **Other sliders re-enable** (everything back to normal)

**Time to understand problem: ~2 seconds**  
**Time to fix: ~1 second**  
**Total: ~3 seconds**

### Flow 2: Experimenting with Settings

1. **User disables Layer 2** (uncheck checkbox manually)
2. **All Layer 2 controls gray out** (expected)
3. **User sets Layer 2 intensity to 0.8** (experimenting)
4. **User sets Layer 2 width to 0.3** (experimenting)
5. **User re-enables Layer 2** (check checkbox)
6. **All Layer 2 controls re-enable** (layer works)
7. **User tweaks settings** (normal workflow)
8. **User sets width to 0** (accident)
9. **Checkbox unchecks, width turns red** (auto-disable)
10. **User immediately sees red, increases width** (fix)
11. **Checkbox re-checks, continues** (workflow uninterrupted)

**No confusion, clear feedback at every step**

## Implementation Details

### Auto-Toggle Logic

```javascript
autoToggleLayerStates(effectId, paramId, value) {
  // Only for intensity or width parameters
  const layerMatch = paramId.match(/^(stripe[123])(Intensity|Width)$/);
  if (!layerMatch) return;
  
  const layerPrefix = layerMatch[1]; // stripe1, stripe2, stripe3
  const paramType = layerMatch[2];   // Intensity or Width
  
  // Get the OTHER critical parameter
  const otherParam = paramType === 'Intensity' 
    ? `${layerPrefix}Width` 
    : `${layerPrefix}Intensity`;
  const otherValue = params[otherParam];
  
  // Should be enabled if BOTH > 0
  const shouldBeEnabled = value > 0 && otherValue > 0;
  const currentlyEnabled = params[`${layerPrefix}Enabled`];
  
  if (shouldBeEnabled && !currentlyEnabled) {
    // Re-enable (user fixed problem)
    params[`${layerPrefix}Enabled`] = true;
    updateUI();
  } else if (!shouldBeEnabled && currentlyEnabled) {
    // Disable (problem detected)
    params[`${layerPrefix}Enabled`] = false;
    updateUI();
  }
}
```

### Problem Detection

```javascript
getStripeDependencyState(params) {
  const layer1Problems = [];
  
  if (params.stripe1Intensity === 0) {
    layer1Problems.push('stripe1Intensity');
  }
  if (params.stripe1Width === 0) {
    layer1Problems.push('stripe1Width');
  }
  
  return {
    stripe1Active: params.stripe1Enabled === true,
    stripe1Problems // Array of problem param IDs
  };
}
```

### Control State Update

```javascript
updateControlStates(effectId) {
  for (const [paramId, binding] of bindings) {
    let shouldDisable = false;
    let isProblemControl = false;
    
    if (!depState.stripe1Active) {
      // Layer is disabled
      if (depState.stripe1Problems.includes(paramId)) {
        // This param is the problem
        isProblemControl = true;
        shouldDisable = false; // Keep enabled
      } else {
        // This param is not the problem
        shouldDisable = true; // Disable
      }
    }
    
    binding.disabled = shouldDisable;
    
    // Red label for problems
    if (isProblemControl) {
      label.style.color = '#ff4444';
    } else {
      label.style.color = '';
    }
  }
}
```

## Edge Cases

### Edge Case 1: Multiple Problems

```
intensity: 0, width: 0

Result:
- Layer disabled
- BOTH intensity AND width show red
- User can fix either first
- Layer stays disabled until BOTH fixed
```

### Edge Case 2: Manual Override

```
User manually checks layer while intensity = 0

Result:
- Layer checkbox checks
- But intensity STILL shows red
- Status warning shows "intensity is 0"
- Layer technically enabled but ineffective
- Red warning persists until fixed
```

**Note:** Auto-disable only triggers on parameter CHANGE, not on manual checkbox toggle. This allows users to override if desired.

### Edge Case 3: Load Saved Settings

```
Load scene with saved params:
intensity: 0, width: 0.5, enabled: true

Result:
- Layer loads as enabled (from save)
- Intensity shows red (problem detected)
- Status warning shows issue
- Layer is ineffective
- User sees red, fixes intensity
- Auto-enable doesn't trigger (already enabled)
- Red clears when fixed
```

## Interaction with Other Systems

### With Status Warning

**Layer enabled but ineffective:**
```
✅ Layer 1 Enabled (checked)
⚠️ Status: Layer 1 ineffective (zero intensity)
   Layer 1 Intensity  [●──────] 0.00 (RED)
```

**Layer auto-disabled:**
```
⬜ Layer 1 Enabled (unchecked)
(No status warning - disabled is expected)
   Layer 1 Intensity  [●──────] 0.00 (RED, ENABLED)
   Layer 1 Width      [───●───] 0.50 (GRAYED, DISABLED)
```

### With Validation System

1. **Validation** checks value is valid (not NaN, in range, etc.)
2. **Auto-toggle** decides if layer should disable based on value
3. **Control state** grays out non-problem controls
4. **Red warning** shows on problem controls

All systems work together seamlessly.

### With Settings Persistence

Auto-toggle **does not save** the enable state change immediately:
- User sets intensity to 0
- Layer auto-disables (checkbox unchecks)
- Change queued for save (batched)
- Saved after 1 second debounce
- Load scene → enabled state reflects last save

## Benefits

### 1. Immediate Feedback
- User knows instantly something changed
- Checkbox unchecks = obvious indicator
- Red label = obvious what's wrong

### 2. Guides User to Solution
- Only problem control stays enabled
- Red color draws attention
- Other controls grayed = "not the issue"

### 3. Prevents Confusion
- No "why aren't my changes working?" moments
- No "which setting broke it?" searching
- Clear cause and effect

### 4. Supports Experimentation
- User can safely experiment with values
- System auto-recovers when fixed
- No manual cleanup needed

### 5. Reduces Support Questions
- Self-documenting behavior
- Visual feedback explains itself
- No need to read docs to understand

## Comparison to Alternatives

### Alternative 1: Warning Only (No Auto-Disable)

❌ **Problems:**
- Layer stays enabled with intensity/width = 0
- User confused why no effect visible
- All controls stay active (misleading)

✅ **Our Approach:**
- Layer auto-disables (obvious)
- Problem control highlighted in red
- Other controls grayed out (clear focus)

### Alternative 2: Disable Problem Control

❌ **Problems:**
- Problem control grayed out
- User can't fix it (Catch-22)
- Must manually enable layer first

✅ **Our Approach:**
- Problem control stays enabled
- User can fix immediately
- Layer auto-re-enables when fixed

### Alternative 3: Prevent Zero Values

❌ **Problems:**
- User can't set to exactly 0
- Artificial limitation
- May want 0 for some workflows

✅ **Our Approach:**
- User can set to 0 (freedom)
- System handles consequences gracefully
- Easy to undo

## Future Enhancements

### Planned
- [ ] Tooltip on red label explaining problem
- [ ] Animation when auto-enabling/disabling
- [ ] Console log message on auto-toggle
- [ ] Option to disable auto-toggle (advanced users)

### Under Consideration
- [ ] Quick-fix button (set to safe default)
- [ ] Remember last non-zero value (restore on fix)
- [ ] Multi-parameter problems (3+ conditions)
- [ ] Custom thresholds (disable if < 0.1 not just 0)

---

**Last Updated**: 2024-11-18  
**Version**: 0.2.0  
**Status**: Implemented ✅
