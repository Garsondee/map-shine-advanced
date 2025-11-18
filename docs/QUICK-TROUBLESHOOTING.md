# Quick Troubleshooting Guide

## Effect Stopped Rendering (Like Your Screenshot)

### Immediate Fix
Open browser console (F12) and run:
```javascript
MapShine.debug.diagnoseSpecular()
```

Look for ❌ marks - these show the problem.

Then:
```javascript
MapShine.debug.resetSpecular()
```

Or click **🔄 Reset to Defaults** button in the UI.

## What Causes Silent Failures

### Common Issues
1. **Division by Zero**
   - Frequency = 0
   - Width = 0
   - → Creates NaN in shader

2. **Overflow**
   - Total intensity > 3.0
   - Extreme parameter values
   - → Shader math breaks

3. **Invalid Combinations**
   - High intensity + Multiply blend
   - Zero width with stripes enabled
   - → Produces artifacts or nothing

## Prevention

### ✅ Safe Workflow
1. Change **one parameter at a time**
2. Watch for **yellow warning** notifications
3. Use console to save/restore states:
   ```javascript
   // Save before experimenting
   const backup = MapShine.debug.exportParameters()
   
   // Restore if needed
   MapShine.debug.importParameters(backup)
   ```

### ⚠️ Warning Signs
- Yellow notification = risky value (still works, but close to breaking)
- Red notification = invalid value (reverted automatically)
- Console warnings = potential problems

## Console Commands (Quick Reference)

```javascript
// Diagnose current state
MapShine.debug.diagnoseSpecular()

// Reset to defaults  
MapShine.debug.resetSpecular()

// Save current state
const params = MapShine.debug.exportParameters()

// Restore saved state
MapShine.debug.importParameters(params)

// Check all effects
MapShine.debug.validateAll()

// Show help
MapShine.debug.help()
```

## Common Parameter Issues

### Frequency = 0
**Problem**: Division by zero in shader  
**Symptom**: No effect visible  
**Fix**: Auto-fixed to 1.0, or set manually

### Total Intensity > 3.0
**Problem**: Shader overflow  
**Symptom**: Blown out highlights or artifacts  
**Fix**: Reduce layer intensities

### Width < 0.05
**Problem**: Aliasing artifacts  
**Symptom**: Jaggy stripes  
**Fix**: Auto-fixed to 0.05, or increase manually

### Width > 0.9
**Problem**: Stripes invisible  
**Symptom**: No visible pattern  
**Fix**: Reduce width to 0.3-0.6 range

## Validation Levels

### 🟢 Green (Safe)
- All parameters valid
- No warnings
- Effect renders correctly

### 🟡 Yellow (Risky)
- Parameters at extremes
- Warnings issued
- Still works but watch out

### 🔴 Red (Invalid)
- Parameter rejected
- Reverted to default
- Check console for details

## What The System Does

### On Parameter Change
1. **Validates** new value immediately
2. **Clamps** to min/max if needed
3. **Checks** for invalid combinations
4. **Auto-fixes** common problems
5. **Notifies** you if action taken

### Every 60 Frames (1 second @ 60fps)
1. **Scans** all shader uniforms
2. **Detects** NaN/Infinity values
3. **Logs** errors to console
4. **Shows** notification if critical

### On Load
1. **Validates** saved parameters
2. **Migrates** old versions
3. **Applies** safe defaults if invalid
4. **Warns** if settings corrected

## Next Steps

**If effect is broken:**
1. Run diagnostics: `MapShine.debug.diagnoseSpecular()`
2. Check console for errors
3. Reset if needed: `MapShine.debug.resetSpecular()`

**If still having issues:**
- See full documentation: `VALIDATION-SYSTEM.md`
- Enable debug mode: `game.settings.set('map-shine-advanced', 'debug-mode', true)`
- Report with console output

## Quick Tips

💡 **Always save backup before experimenting**
```javascript
window.myBackup = MapShine.debug.exportParameters()
```

💡 **Use validation report to find issues**
```javascript
MapShine.debug.validateAll()
```

💡 **Monitor shader health when testing**
```javascript
MapShine.debug.monitorShader(10000)  // 10 seconds
```

💡 **Check warnings in console**  
Press F12, filter by "warn" to see validation warnings

---

**For detailed technical information, see**: `VALIDATION-SYSTEM.md`
