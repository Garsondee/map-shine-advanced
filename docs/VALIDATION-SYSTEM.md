# Validation & Error Prevention System

## The Problem You Encountered

When adjusting effect parameters, certain combinations can create **silent shader failures**:
- Invalid math (division by zero, NaN, Infinity)
- Overflow from extreme values
- Invalid parameter combinations

These break the effect completely but don't show obvious errors - the effect just stops rendering.

## The Solution

A comprehensive validation system with **4 layers of protection**:

### Layer 1: Schema-Based Validation
Every parameter has defined constraints in the effect schema:

```javascript
stripe1Width: {
  type: 'slider',
  min: 0,      // Cannot go below 0
  max: 1,      // Cannot go above 1
  step: 0.01,
  default: 0.4  // Safe fallback
}
```

### Layer 2: Real-Time Validation
Every parameter change is validated **before** being applied:

```javascript
// On slider change
onChange(value) {
  const validation = globalValidator.validateParameter(paramId, value, paramDef);
  
  if (!validation.valid) {
    // REJECT invalid value, revert to default
    ui.notifications.error(`Invalid value for ${paramName}`);
    binding.setValue(paramDef.default);
    return;
  }
  
  // Use validated/clamped value
  effect.params[paramId] = validation.value;
}
```

### Layer 3: Sanity Checking
After each change, check for **invalid combinations**:

```javascript
runSanityCheck(effectId) {
  // Example checks:
  // - Total stripe intensity > 3.0? (overflow risk)
  // - Frequency = 0? (division by zero)
  // - Width < 0.01? (aliasing artifacts)
  
  if (!valid) {
    // Auto-fix if possible
    applyFixes(fixes);
    ui.notifications.warn('Auto-fixes applied');
  }
}
```

### Layer 4: Shader Validation
Periodic runtime checks for shader errors:

```javascript
// Every 60 frames
validateShaderState() {
  // Check all uniforms for NaN/Infinity
  for (const [name, uniform] of material.uniforms) {
    if (!Number.isFinite(uniform.value)) {
      // CRITICAL ERROR - show notification
      ui.notifications.error('Invalid shader state - reset to defaults');
    }
  }
}
```

## What It Catches

### Type Errors
```javascript
intensity: "hello"  // ❌ Expected number, got string
→ Reverts to default (0.5)
```

### Range Violations
```javascript
stripe1Width: -0.5   // ❌ Below min (0)
→ Clamped to 0

stripe1Intensity: 5.0  // ⚠️  Above max (2), extreme value
→ Clamped to 2, warning shown
```

### Invalid Combinations
```javascript
{
  stripeEnabled: true,
  stripe1Frequency: 0,  // ❌ Division by zero!
  stripe1Enabled: true
}
→ Auto-fixed: stripe1Frequency = 1.0
→ Notification: "Auto-fixes applied"
```

### Silent Shader Failures
```javascript
// Uniform becomes NaN due to shader math
uStripe1Frequency: NaN

→ Detected every 60 frames
→ Notification: "Invalid shader state detected"
→ Logged to console with details
```

## How To Use It

### If Effect Breaks (Your Scenario)

**1. Open Browser Console** (F12)

**2. Run Diagnostics**
```javascript
MapShine.debug.diagnoseSpecular()
```

This shows:
```
🔍 Map Shine Specular Diagnostics
  ✅ Specular effect found
  ✅ Material exists
  ✅ Validation passed
  
  Parameters
    ✅ intensity: 0.51
    ✅ roughness: 0.30
    ❌ stripe1Frequency: NaN  // FOUND THE PROBLEM!
    
  Common Issues
    ⚠️ Stripe 1 frequency is 0 (will cause NaN)
    
  💡 Suggestions
    Try resetting to defaults:
      MapShine.debug.resetSpecular()
```

**3. Reset to Defaults**
```javascript
MapShine.debug.resetSpecular()
```

Or click the **🔄 Reset to Defaults** button in the UI.

### Prevention: Safe Workflow

**When Adjusting Parameters:**

1. **Change one at a time** - easier to identify problems
2. **Watch for warnings** - yellow notifications indicate risky values
3. **Use console for experimentation**:
   ```javascript
   // Export current params
   const params = MapShine.debug.exportParameters()
   
   // Experiment
   // If it breaks...
   
   // Restore working state
   MapShine.debug.importParameters(params)
   ```

4. **Check console for warnings** - validation messages logged there

## Validation Rules

### Specular Effect Sanity Checks

**Stripe Intensity Overflow**
```javascript
Total intensity = stripe1 + stripe2 + stripe3

If total > 3.0:
  ⚠️ Warning: "May cause overflow"
  
If total > 3.0 && blendMode == Multiply:
  ⚠️ Warning: "Multiply blend with high intensity may cause artifacts"
```

**Width Sanity**
```javascript
If width < 0.01:
  ❌ Error: "Too small, may cause aliasing"
  → Auto-fix: width = 0.05

If width > 0.95:
  ⚠️ Warning: "Very large, stripes may not be visible"
```

**Frequency Validation**
```javascript
If frequency == 0:
  ❌ Error: "Division by zero"
  → Auto-fix: frequency = 1.0

If frequency > 25:
  ⚠️ Warning: "Very high, may cause moiré"
```

**Enabled With Zero Intensity**
```javascript
If stripe1Enabled && stripe1Intensity == 0:
  ⚠️ Warning: "Enabled but intensity is 0 (no effect)"
```

## Console Commands Reference

All accessible via `MapShine.debug.*`

### diagnoseSpecular()
Full health check of the specular effect
- Shows all parameters
- Checks shader uniforms
- Lists common issues
- Provides suggestions

### resetSpecular()
Reset specular effect to schema defaults
- Restores all parameters
- Refreshes UI
- Saves to current tier

### exportParameters()
Export current params as JSON
- Prints to console
- Copies to clipboard
- Returns object for variable assignment

### importParameters(obj)
Import parameters from object
- Validates before applying
- Refreshes UI bindings
- Useful for restoring saved states

### validateAll()
Run validation on all effects
- Shows errors and warnings
- Lists which effects have issues

### monitorShader(ms)
Monitor shader for errors over time
- Default: 5 seconds
- Checks every 100ms
- Reports error count at end

### help()
Show command reference

## Technical Details

### Parameter Validator (`parameter-validator.js`)

**Single Parameter Validation:**
```javascript
validateParameter(paramId, value, paramDef) {
  // 1. Type check
  if (typeof value !== expectedType) return INVALID;
  
  // 2. NaN/Infinity check (numbers)
  if (!Number.isFinite(value)) return INVALID;
  
  // 3. Clamp to range
  value = Math.max(min, Math.min(max, value));
  
  // 4. Check options (dropdowns)
  if (options && !validValues.includes(value)) return INVALID;
  
  // 5. Custom validators
  if (customValidator) value = customValidator(value);
  
  return { valid: true, value, warnings };
}
```

**All Parameters Validation:**
```javascript
validateAllParameters(effectId, params, schema) {
  // 1. Validate each parameter
  for (param of params) {
    validateParameter(...);
  }
  
  // 2. Run sanity checker
  const sanityResult = sanityChecker(validatedParams);
  
  // 3. Apply auto-fixes
  if (sanityResult.fixes) {
    Object.assign(validatedParams, fixes);
  }
  
  return { valid, params: validatedParams, warnings, errors };
}
```

### Shader Validator (`shader-validator.js`)

**Uniform Validation:**
```javascript
validateMaterialUniforms(material) {
  for (const [name, uniform] of material.uniforms) {
    const value = uniform.value;
    
    // Check numbers
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        errors.push(`${name} is ${value}`);
      }
    }
    
    // Check vectors
    if (value.isVector3) {
      if (!Number.isFinite(value.x)) errors.push(`${name}.x is ${value.x}`);
      if (!Number.isFinite(value.y)) errors.push(`${name}.y is ${value.y}`);
      if (!Number.isFinite(value.z)) errors.push(`${name}.z is ${value.z}`);
    }
  }
  
  return { valid: errors.length === 0, errors, warnings };
}
```

### Integration Points

**Load Time:**
```javascript
registerEffect(effectId, schema) {
  // Load saved parameters
  const savedParams = loadEffectParameters(effectId);
  
  // Validate loaded parameters
  const validation = validateAllParameters(effectId, savedParams, schema);
  
  if (!validation.valid) {
    ui.notifications.warn('Invalid settings, using defaults');
  }
  
  // Use validated params
  buildControls(validation.params);
}
```

**Runtime:**
```javascript
update(timeInfo) {
  // Periodic shader validation (every 60 frames)
  if (timeInfo.frameCount % 60 === 0) {
    this.validateShaderState();
  }
  
  // Update uniforms...
}
```

**On Change:**
```javascript
onChange(paramId, value) {
  // Validate before applying
  const validation = validateParameter(paramId, value, paramDef);
  
  if (!validation.valid) {
    revertToDefault();
    return;
  }
  
  // Apply validated value
  effect.params[paramId] = validation.value;
  
  // Run sanity check
  runSanityCheck(effectId);
}
```

## Future Enhancements

### Planned
- [ ] **Validation presets** - "Safe mode" vs "Creative mode" vs "Expert mode"
- [ ] **Parameter history** - Undo/redo with validation
- [ ] **Visual indicators** - Red/yellow/green dots on controls
- [ ] **Validation report export** - Save diagnostics to file
- [ ] **Auto-recovery** - Revert to last known good state

### Under Consideration
- [ ] **Shader compilation check** - Validate GLSL before running
- [ ] **Performance warnings** - "This combo is slow on your GPU"
- [ ] **Constraint hints in UI** - Show valid ranges dynamically
- [ ] **Smart defaults based on GPU tier** - Lower values for weak GPUs

## Best Practices

### For Users
✅ **DO:**
- Change parameters one at a time
- Use "Reset to Defaults" if confused
- Run diagnostics if effect breaks
- Check console for warnings

❌ **DON'T:**
- Ignore yellow warning notifications
- Set extreme values without understanding
- Assume the effect is permanently broken

### For Developers
✅ **DO:**
- Define min/max/default for all parameters
- Add sanity checkers for complex effects
- Log validation warnings for debugging
- Provide clear error messages

❌ **DON'T:**
- Allow unbounded parameters
- Silently fail on invalid values
- Use default values without validation
- Skip testing extreme value combinations

## Troubleshooting

### "Effect stopped rendering"
```javascript
// 1. Check diagnostics
MapShine.debug.diagnoseSpecular()

// 2. Look for ❌ indicators

// 3. Reset if needed
MapShine.debug.resetSpecular()
```

### "Console shows validation errors"
```javascript
// Errors look like:
// "❌ stripe1Frequency is 0 (invalid)"

// Find the problematic parameter in UI
// Adjust or reset
```

### "Auto-fixes applied but still broken"
```javascript
// Multiple issues may exist
// Run full validation:
MapShine.debug.validateAll()

// Or nuclear option:
MapShine.debug.resetSpecular()
```

### "Can't find the problem"
```javascript
// Enable debug mode for verbose logging
game.settings.set('map-shine-advanced', 'debug-mode', true)

// Change parameters and watch console
// Validation messages will show what's wrong
```

---

**Last Updated**: 2024-11-18  
**Version**: 0.2.0  
**Status**: Implemented ✅
