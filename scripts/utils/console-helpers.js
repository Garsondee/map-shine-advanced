/**
 * @fileoverview Console debugging helpers
 * Diagnostic tools for troubleshooting effect issues
 * @module utils/console-helpers
 */

import { createLogger } from '../core/log.js';
import { globalProfiler } from '../core/profiler.js';
import { globalLoadingProfiler } from '../core/loading-profiler.js';

const log = createLogger('ConsoleHelpers');

/**
 * Console helpers for debugging Map Shine Advanced
 * Access via window.MapShine.debug
 */
export const consoleHelpers = {
  /**
   * Diagnose current specular effect state
   * Checks for common issues that break the effect
   */
  async diagnoseSpecular() {
    console.group('ðŸ” Map Shine Specular Diagnostics');
    
    const effect = window.MapShine?.specularEffect;
    if (!effect) {
      console.error('âŒ Specular effect not found');
      console.groupEnd();
      return;
    }

    console.log('âœ… Specular effect found');
    
    // Check enabled state
    console.log(`Enabled: ${effect.enabled}`);
    
    // Check effective state
    const { getSpecularEffectiveState } = await import('../ui/parameter-validator.js');
    const effectiveState = getSpecularEffectiveState(effect.params);
    if (!effectiveState.effective) {
      console.warn('âš ï¸ Effect is ineffective:', effectiveState.reasons);
    } else {
      console.log('âœ… Effect is active and functional');
    }
    
    // Check material
    if (!effect.material) {
      console.error('âŒ Material is null');
      console.groupEnd();
      return;
    }
    console.log('âœ… Material exists');
    
    // Check validation status
    const validation = effect.getValidationStatus();
    if (!validation.valid) {
      console.error('âŒ Validation failed:', validation.errors);
    } else {
      console.log('âœ… Validation passed');
    }
    
    // Check parameters
    console.group('Parameters');
    for (const [key, value] of Object.entries(effect.params)) {
      const isValid = typeof value === 'number' ? Number.isFinite(value) : true;
      const icon = isValid ? 'âœ…' : 'âŒ';
      console.log(`${icon} ${key}: ${value}`);
    }
    console.groupEnd();
    
    // Check uniforms
    console.group('Shader Uniforms (critical)');
    const criticalUniforms = [
      'uSpecularIntensity',
      'uRoughness',
      'uMetallic',
      'uStripeEnabled',
      'uStripe1Frequency',
      'uStripe1Width',
      'uStripe1Intensity'
    ];
    
    for (const name of criticalUniforms) {
      const uniform = effect.material.uniforms[name];
      if (!uniform) {
        console.error(`âŒ ${name}: MISSING`);
        continue;
      }
      
      const value = uniform.value;
      const isValid = typeof value === 'number' ? Number.isFinite(value) : value !== null;
      const icon = isValid ? 'âœ…' : 'âŒ';
      console.log(`${icon} ${name}: ${value}`);
    }
    console.groupEnd();
    
    // Check for common issues
    console.group('Common Issues');
    const issues = [];
    
    if (effect.params.stripeEnabled && effect.params.stripe1Frequency === 0) {
      issues.push('âš ï¸ Stripe 1 frequency is 0 (will cause NaN)');
    }
    
    if (effect.params.stripe1Width < 0.01) {
      issues.push('âš ï¸ Stripe 1 width very small (may cause aliasing)');
    }
    
    const totalIntensity = 
      (effect.params.stripe1Enabled ? effect.params.stripe1Intensity : 0) +
      (effect.params.stripe2Enabled ? effect.params.stripe2Intensity : 0) +
      (effect.params.stripe3Enabled ? effect.params.stripe3Intensity : 0);
    
    if (totalIntensity > 3.0) {
      issues.push(`âš ï¸ Total stripe intensity very high (${totalIntensity.toFixed(2)})`);
    }
    
    if (issues.length === 0) {
      console.log('âœ… No obvious issues detected');
    } else {
      issues.forEach(issue => console.warn(issue));
    }
    console.groupEnd();
    
    // Suggestions
    console.group('ðŸ’¡ Suggestions');
    if (!validation.valid || issues.length > 0) {
      console.log('Try resetting to defaults:');
      console.log('  MapShine.debug.resetSpecular()');
      console.log('Or check specific parameters that look wrong above');
    } else {
      console.log('Effect looks healthy. If still not rendering:');
      console.log('1. Check if specular mask texture loaded');
      console.log('2. Verify WebGL context is active');
      console.log('3. Check browser console for GL errors');
    }
    console.groupEnd();
    
    console.groupEnd();
  },

  /**
   * Reset specular effect to defaults
   */
  resetSpecular() {
    const uiManager = window.MapShine?.uiManager;
    if (!uiManager) {
      console.error('UI Manager not found');
      return;
    }
    
    console.log('ðŸ”„ Resetting specular effect to defaults...');
    uiManager.resetEffectToDefaults('specular');
    console.log('âœ… Reset complete');
  },

  /**
   * Export current parameters as JSON
   */
  exportParameters() {
    const effect = window.MapShine?.specularEffect;
    if (!effect) {
      console.error('Specular effect not found');
      return;
    }
    
    const json = JSON.stringify(effect.params, null, 2);
    console.log('Current parameters:');
    console.log(json);
    
    // Copy to clipboard if available
    if (navigator.clipboard) {
      navigator.clipboard.writeText(json);
      console.log('âœ… Copied to clipboard');
    }
    
    return effect.params;
  },

  /**
   * Import parameters from object
   * @param {Object} params - Parameters to apply
   */
  importParameters(params) {
    const effect = window.MapShine?.specularEffect;
    const uiManager = window.MapShine?.uiManager;
    
    if (!effect || !uiManager) {
      console.error('Effect or UI Manager not found');
      return;
    }
    
    console.log('ðŸ“¥ Importing parameters...');
    
    for (const [key, value] of Object.entries(params)) {
      if (effect.params[key] !== undefined) {
        effect.params[key] = value;
        console.log(`Set ${key} = ${value}`);
      }
    }
    
    // Refresh UI
    const effectData = uiManager.effectFolders['specular'];
    if (effectData) {
      for (const [key, binding] of Object.entries(effectData.bindings)) {
        effectData.params[key] = effect.params[key];
        binding.refresh();
      }
    }
    
    console.log('âœ… Import complete');
  },

  /**
   * Show validation report for all effects
   */
  async validateAll() {
    console.group('ðŸ” Validation Report');
    
    const uiManager = window.MapShine?.uiManager;
    if (!uiManager) {
      console.error('UI Manager not found');
      console.groupEnd();
      return;
    }
    
    const { globalValidator } = await import('./parameter-validator.js');
    
    for (const [effectId, effectData] of Object.entries(uiManager.effectFolders)) {
      const validation = globalValidator.validateAllParameters(
        effectId,
        effectData.params,
        effectData.schema
      );
      
      const icon = validation.valid ? 'âœ…' : 'âŒ';
      console.log(`${icon} ${effectId}`);
      
      if (!validation.valid) {
        console.group('Errors');
        validation.errors.forEach(e => console.error(e));
        console.groupEnd();
      }
      
      if (validation.warnings.length > 0) {
        console.group('Warnings');
        validation.warnings.forEach(w => console.warn(w));
        console.groupEnd();
      }
    }
    
    console.groupEnd();
  },

  /**
   * Monitor shader for errors
   * @param {number} duration - How long to monitor (ms)
   */
  async monitorShader(duration = 5000) {
    const effect = window.MapShine?.specularEffect;
    if (!effect || !effect.material) {
      console.error('Effect or material not found');
      return;
    }
    
    console.log(`ðŸ” Monitoring shader for ${duration}ms...`);
    
    const { ShaderValidator } = await import('../core/shader-validator.js');
    
    let errorCount = 0;
    let checkCount = 0;
    
    const interval = setInterval(() => {
      checkCount++;
      const result = ShaderValidator.validateMaterialUniforms(effect.material);
      
      if (!result.valid) {
        errorCount++;
        console.error(`Check ${checkCount}: FAILED`, result.errors);
      }
    }, 100);
    
    setTimeout(() => {
      clearInterval(interval);
      console.log(`âœ… Monitoring complete: ${checkCount} checks, ${errorCount} errors`);
      
      if (errorCount > 0) {
        console.warn('Shader has validation errors - try resetting to defaults');
      }
    }, duration);
  },

  /**
   * Comprehensive per-floor rendering system diagnostic.
   * Reports FloorStack, compositor _floorMeta, effect mask bindings, registry
   * state, scene tiles, and highlights mismatches that cause cross-floor bleed.
   *
   * Usage: await MapShine.debug.diagnoseFloorRendering()
   */
  async diagnoseFloorRendering() {
    const ms = window.MapShine;
    const sep = 'â”€'.repeat(60);

    console.group('ðŸ—ºï¸  MapShine Floor Rendering Diagnostics');
    console.log(sep);

    // â”€â”€ 1. Floor loop gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('1. Floor Loop Gate');
    const floorStack = ms?.floorStack ?? null;
    const composer   = ms?.sceneComposer ?? null;
    const compositor = composer?._sceneMaskCompositor ?? null;
    const effectComp = ms?.effectComposer ?? null;

    let loopEnabled = false;
    try {
      loopEnabled = game?.settings?.get?.('map-shine-advanced', 'experimentalFloorRendering') ?? false;
    } catch (_) {}

    console.log(`experimentalFloorRendering setting : ${loopEnabled ? 'âœ… true' : 'âŒ false'}`);
    console.log(`FloorStack available               : ${floorStack  ? 'âœ…' : 'âŒ null'}`);
    console.log(`GpuSceneMaskCompositor available   : ${compositor  ? 'âœ…' : 'âŒ null'}`);
    console.log(`EffectComposer available            : ${effectComp  ? 'âœ…' : 'âŒ null'}`);
    console.log(`Floor loop would run               : ${(loopEnabled && !!floorStack) ? 'âœ… YES' : 'âŒ NO'}`);
    console.groupEnd();
    console.log(sep);

    // â”€â”€ 2. FloorStack â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('2. FloorStack');
    if (!floorStack) {
      console.warn('âš ï¸  FloorStack not available â€” floor loop cannot run');
    } else {
      const allFloors     = floorStack.getFloors?.() ?? [];
      const visibleFloors = floorStack.getVisibleFloors?.() ?? [];
      const activeFloor   = floorStack.getActiveFloor?.() ?? null;

      console.log(`Total floors   : ${allFloors.length}`);
      console.log(`Active floor   : ${activeFloor ? `index=${activeFloor.index}  [${activeFloor.elevationMin}â€“${activeFloor.elevationMax}]  compositorKey="${activeFloor.compositorKey}"` : 'null'}`);
      console.log(`Visible floors : ${visibleFloors.length}  (rendered this frame)`);
      console.group('All floor bands');
      for (const f of allFloors) {
        const isActive  = f.isActive ? ' â† ACTIVE' : '';
        const isVisible = visibleFloors.some(v => v.index === f.index) ? ' (visible)' : '';
        console.log(`  [${f.index}] elev ${f.elevationMin}â€“${f.elevationMax}  key="${f.key}"  compositorKey="${f.compositorKey}"${isActive}${isVisible}`);
      }
      console.groupEnd();
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ 3. GpuSceneMaskCompositor _floorMeta â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('3. GpuSceneMaskCompositor _floorMeta Cache');
    if (!compositor) {
      console.warn('âš ï¸  Compositor not available');
    } else {
      const floorMeta = compositor._floorMeta;
      console.log(`_floorMeta entries : ${floorMeta?.size ?? 0}`);
      console.log(`_activeFloorKey    : "${compositor._activeFloorKey ?? 'null'}"`);
      console.log(`_belowFloorKey     : "${compositor._belowFloorKey  ?? 'null'}"`);
      console.log(`_activeFloorBasePath: "${compositor._activeFloorBasePath ?? 'null'}"`);

      if (floorMeta?.size > 0) {
        console.group('Cached floor bundles');
        for (const [key, meta] of floorMeta.entries()) {
          const types = (meta?.masks ?? []).map(m => m?.type || m?.id || '?').join(', ');
          const bp    = meta?.basePath ?? 'null';
          console.log(`  "${key}" â†’ masks: [${types}]   basePath: "${bp}"`);
        }
        console.groupEnd();
      } else {
        console.warn('  âš ï¸  _floorMeta is EMPTY â€” all bindFloorMasks() calls will receive null bundles');
      }

      // Test compositorKey alignment against FloorStack
      if (floorStack) {
        console.group('compositorKey â†” _floorMeta alignment (critical)');
        const allFloors = floorStack.getFloors?.() ?? [];
        for (const f of allFloors) {
          const found = floorMeta?.get(f.compositorKey);
          if (found) {
            const types = (found.masks ?? []).map(m => m?.type || m?.id || '?').join(', ');
            console.log(`  âœ… floor[${f.index}] compositorKey="${f.compositorKey}" â†’ FOUND  [${types}]`);
          } else {
            console.error(`  âŒ floor[${f.index}] compositorKey="${f.compositorKey}" â†’ NOT IN _floorMeta â€” effects will receive null bundle!`);
          }
        }
        console.groupEnd();
      }
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ 4. Scene background & tiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('4. Scene Tiles & Background');
    const scene = canvas?.scene;
    const bgSrc = scene?.background?.src || scene?.img || null;
    const extractBase = (src) => {
      if (!src) return null;
      const lastDot = src.lastIndexOf('.');
      const lastSlash = Math.max(src.lastIndexOf('/'), src.lastIndexOf('\\'));
      const noExt  = lastDot > lastSlash ? src.slice(0, lastDot) : src;
      // Strip known mask suffixes
      return noExt.replace(/_?(Water|Fire|Specular|Roughness|Normal|Windows|Structural|Outdoors|Prism|Iridescence|Fluid|Ash|Dust|FloorAlpha)$/i, '');
    };
    console.log(`Scene background src      : "${bgSrc ?? 'none'}"`);
    console.log(`Scene background basePath : "${extractBase(bgSrc) ?? 'none'}"`);
    console.log(`SceneComposer _lastMaskBasePath: "${composer?._lastMaskBasePath ?? 'null'}"`);

    const tilesCollection = scene?.tiles;
    const tilesArr = tilesCollection
      ? (Array.isArray(tilesCollection) ? tilesCollection
        : (Array.isArray(tilesCollection.contents) ? tilesCollection.contents
          : [...(tilesCollection.values?.() ?? [])]))
      : [];
    console.log(`Total scene tiles : ${tilesArr.length}`);
    if (tilesArr.length > 0) {
      console.group('Tiles (sorted by elevation)');
      const sorted = [...tilesArr].sort((a, b) => Number(a.elevation ?? 0) - Number(b.elevation ?? 0));
      for (const t of sorted) {
        const src  = t?.texture?.src ?? '(no src)';
        const elev = t?.elevation ?? 'undefined';
        let levelsInfo = 'no Levels range';
        try {
          const { tileHasLevelsRange, readTileLevelsFlags } = await import('../foundry/levels-scene-flags.js');
          if (tileHasLevelsRange(t)) {
            const flags = readTileLevelsFlags(t);
            levelsInfo = `rangeBottom=${flags.rangeBottom} rangeTop=${flags.rangeTop}`;
          }
        } catch (_) {}
        const w = t?.width ?? '?';
        const h = t?.height ?? '?';
        const hidden = t?.hidden ? ' [hidden]' : '';
        console.log(`  elev=${elev}  ${w}Ã—${h}  ${levelsInfo}${hidden}  "${src}"`);
      }
      console.groupEnd();
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ 5. Effect registry masks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('5. EffectMaskRegistry (active floor masks)');
    const registry = ms?.effectMaskRegistry ?? null;
    if (!registry) {
      console.warn('âš ï¸  effectMaskRegistry not available');
    } else {
      // Registry stores slots: Map<type, MaskSlot{texture, floorKey, source}>
      const slots = registry._slots ?? null;
      const activeCompKey = compositor?._activeFloorKey ?? null;
      const emrPolicies = registry._policies ?? registry._defaultPolicies ?? null;
      const getPolicy = (type) => {
        if (typeof registry.getPolicy === 'function') return registry.getPolicy(type);
        return emrPolicies?.[type] ?? null;
      };
      if (slots instanceof Map) {
        console.log(`Registered mask slots : ${slots.size}  (active compositor floor: "${activeCompKey ?? 'unknown'}")`);
        let crossFloorCount = 0;
        for (const [type, slot] of slots.entries()) {
          const tex    = slot?.texture ?? null;
          const hasTex = !!tex;
          const size   = (tex?.image?.width && tex?.image?.height) ? `${tex.image.width}Ã—${tex.image.height}` : 'no image';
          const fk     = slot?.floorKey ?? 'null';
          const src    = slot?.source   ?? '?';
          const policy = getPolicy(type);
          const preserve = policy?.preserveAcrossFloors === true;
          // Flag when a preserved mask belongs to a DIFFERENT floor than the active one.
          const crossFloor = preserve && hasTex && activeCompKey && fk && fk !== 'null' && fk !== activeCompKey;
          if (crossFloor) crossFloorCount++;
          const crossTag = crossFloor ? '  âš ï¸ CROSS-FLOOR (preserved from floor "' + fk + '")' : '';
          const preserveTag = preserve ? '  [preserveAcrossFloors]' : '';
          console.log(`  ${hasTex ? 'âœ…' : 'âŒ'} ${type.padEnd(20)} texture=${hasTex ? size : 'null'}  floorKey="${fk}"  source=${src}${preserveTag}${crossTag}`);
        }
        if (crossFloorCount > 0) {
          console.warn(`  âš ï¸  ${crossFloorCount} mask(s) are PRESERVED from a different floor. This is intentional for water (post-FX)`);
          console.warn(`     but a bug for specular/roughness/normal (should clear per-floor). Check preserveAcrossFloors policies.`);
        }
      } else {
        console.log('  (_slots not accessible â€” registry:', registry, ')');
      }
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ 6. Floor-scoped effects â€” current mask bindings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('6. Floor-scoped Effects â€” Current Mask Bindings');
    const ec = effectComp;
    if (!ec) {
      console.warn('âš ï¸  EffectComposer not available');
    } else {
      // EffectComposer stores effects in this.effects (Map<id, EffectBase>)
      const effectsMap = ec.effects instanceof Map ? ec.effects : null;
      const allEffects = effectsMap ? [...effectsMap.values()] : [];

      const floorEffects  = allEffects.filter(e => e.floorScope !== 'global');
      const globalEffects = allEffects.filter(e => e.floorScope === 'global');

      console.log(`Floor-scoped effects (run per-floor) : ${floorEffects.length}`);
      console.log(`Global-scoped effects (run once)     : ${globalEffects.length}`);

      // Key masks we care about
      const maskFields = ['waterMask','specularMask','roughnessMask','normalMap',
                          'windowMask','outdoorsMask','fireMask','dustMask',
                          'structuralMask','iridescenceMask','prismMask','treeMask'];

      console.group('Floor-scoped effect mask state');
      for (const eff of floorEffects) {
        const hasBind = typeof eff.bindFloorMasks === 'function';
        const enabled = eff.enabled ?? eff._enabled ?? '?';
        const bound   = maskFields.filter(f => eff[f] !== undefined).map(f => {
          const tex = eff[f];
          if (!tex) return `${f}=null`;
          const sz  = (tex?.image?.width && tex?.image?.height) ? `${tex.image.width}Ã—${tex.image.height}` : 'loaded';
          return `${f}=${sz}`;
        });
        const floorStates = eff._floorStates?.size !== undefined ? `  _floorStates.size=${eff._floorStates.size}` : '';
        console.log(`  ${hasBind ? 'âœ…' : 'âš ï¸ '} ${eff.id.padEnd(28)} enabled=${String(enabled).padEnd(5)} ${bound.join('  ')}${floorStates}`);
      }
      console.groupEnd();

      console.group('Global-scoped effects');
      for (const eff of globalEffects) {
        console.log(`  âœ… ${eff.id}`);
      }
      console.groupEnd();
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ 7. Visible floor bundle test â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const CORE_MASK_TYPES = ['water','fire','specular','roughness','normal',
                             'windows','structural','outdoors','dust','ash',
                             'iridescence','prism','tree','bush','fluid'];
    console.group('7. Per-Floor Bundle Test (what the render loop would get)');
    if (!floorStack || !compositor) {
      console.warn('âš ï¸  FloorStack or compositor not available');
    } else {
      const visible = floorStack.getVisibleFloors?.() ?? [];
      if (visible.length === 0) console.warn('âš ï¸  No visible floors');
      for (const f of visible) {
        const bundle = compositor._floorMeta?.get(f.compositorKey) ?? null;
        if (bundle) {
          const types = (bundle.masks ?? []).map(m => m?.type || m?.id || '?');
          const missing = CORE_MASK_TYPES.filter(t => !types.includes(t));
          console.log(`  âœ… floor[${f.index}] key="${f.compositorKey}" â†’ [${types.join(', ')}]` +
            (missing.length ? `  |  absent: [${missing.join(', ')}]` : '  (all core masks present)'));
        } else {
          console.error(`  âŒ floor[${f.index}] key="${f.compositorKey}" â†’ bundle is NULL`);
          console.error(`     â†³ preloadAllFloors() hasn't cached this floor yet, or composeFloor() returned null.`);
          console.error(`     â†³ Effects will keep the previous floor's masks â€” likely rendering the wrong content.`);
        }
      }
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ 7b. Per-effect _floorStates cache contents â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('7b. Per-Effect _floorStates Cache (what each effect has seen per floor)');
    if (effectComp?.effects instanceof Map) {
      const allEffects = [...effectComp.effects.values()];
      const floorEffects = allEffects.filter(e => e._floorStates instanceof Map && e._floorStates.size > 0);
      if (floorEffects.length === 0) {
        console.warn('âš ï¸  No effects have populated _floorStates â€” bindFloorMasks may not be running (check experimentalFloorRendering setting)');
      }
      for (const eff of floorEffects) {
        const entries = [...eff._floorStates.entries()];
        const lines = entries.map(([k, v]) => {
          const maskSummary = Object.entries(v)
            .map(([field, val]) => {
              if (val === null) return `${field}=null`;
              if (val && typeof val === 'object' && val.image) return `${field}=${val.image.width}Ã—${val.image.height}`;
              return `${field}=${String(val).substring(0, 20)}`;
            }).join(', ');
          return `      "${k}": {${maskSummary}}`;
        }).join('\n');
        console.log(`  ${eff.id} (${entries.length} floor(s) cached):\n${lines}`);
      }
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ 8. Summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('8. Summary / Likely Issues');
    if (compositor && floorStack) {
      const visible    = floorStack.getVisibleFloors?.() ?? [];
      const nullFloors = visible.filter(f => !compositor._floorMeta?.get(f.compositorKey));
      let issueCount = 0;

      if (nullFloors.length > 0) {
        issueCount++;
        console.error(`âŒ ${nullFloors.length} visible floor(s) have no cached bundle:`);
        for (const f of nullFloors) {
          console.error(`   floor[${f.index}] "${f.compositorKey}" â€” effects will render with stale cross-floor masks.`);
        }
        console.error('   â†’ Run preloadAllFloors() or wait for it to complete after scene load.');
      }

      // Check for effects with empty _floorStates (bind loop may not be running).
      // Post-processing effects are intentionally excluded from the floor loop's
      // bindFloorMasks calls â€” they use connectToRegistry() instead â€” so having
      // _floorStates.size=0 is CORRECT for them (water, lighting, etc.).
      if (effectComp?.effects instanceof Map) {
        let postProcessingOrder = Infinity;
        try {
          const { RenderLayers } = await import('../effects/EffectComposer.js');
          postProcessingOrder = RenderLayers?.POST_PROCESSING?.order ?? Infinity;
        } catch (_) {}
        const bindable = [...effectComp.effects.values()].filter(e => {
          if (typeof e.bindFloorMasks !== 'function') return false;
          // Exclude post-processing effects â€” they use connectToRegistry, not bindFloorMasks.
          const layerOrder = e.layer?.order ?? -Infinity;
          return layerOrder < postProcessingOrder;
        });
        const neverBound = bindable.filter(e => e._floorStates instanceof Map && e._floorStates.size === 0);
        if (neverBound.length > 0) {
          issueCount++;
          console.warn(`âš ï¸  ${neverBound.length} scene-layer bindable effect(s) have empty _floorStates:`);
          console.warn('   ' + neverBound.map(e => e.id).join(', '));
          console.warn('   â†’ Check experimentalFloorRendering setting and that preloadAllFloors completed.');
        }
      }

      // Report which masks are absent from each floor's bundle
      for (const f of visible) {
        const bundle = compositor._floorMeta?.get(f.compositorKey);
        if (!bundle) continue;
        const types = (bundle.masks ?? []).map(m => m?.type || m?.id || '?');
        const criticalAbsent = ['specular','windows','water','fire'].filter(t => !types.includes(t));
        if (criticalAbsent.length > 0) {
          console.info(`â„¹ï¸  floor[${f.index}] "${f.compositorKey}" is missing: [${criticalAbsent.join(', ')}]`);
          console.info(`   â†’ These effects will be disabled/null for this floor's render pass (expected if the map has no such mask files).`);
        }
      }

      // â”€â”€ Foam floor-key guard status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // WeatherParticles suppresses water-driven foam when the registry's water
      // floorKey doesn't match the active compositor floor.
      try {
        const reg = ms?.effectMaskRegistry;
        const activeKey = compositor?._activeFloorKey ?? null;
        const waterSlot = reg?.getSlot?.('water');
        const waterFloorKey = waterSlot?.floorKey ?? null;
        const waterTex = waterSlot?.texture ?? null;
        if (activeKey && waterTex) {
          if (waterFloorKey && waterFloorKey !== activeKey) {
            console.warn(`âš ï¸  FOAM GUARD ACTIVE: water mask is from floor "${waterFloorKey}" but active floor is "${activeKey}"`);
            console.warn(`   â†’ WeatherParticles foam/splash suppressed on this floor (correct â€” avoids cross-floor spawn positions).`);
            console.warn(`   â†’ The 2D water post-FX shader still runs (preserveAcrossFloors=true for water is intentional for post-FX).`);
            issueCount++; // not an error, but worth highlighting
          } else {
            console.log(`âœ… Foam floor-key guard: water floorKey="${waterFloorKey}" matches active floor "${activeKey}" â€” foam active.`);
          }
        } else if (activeKey && !waterTex) {
          console.log(`â„¹ï¸  Foam: no water mask on active floor "${activeKey}" â€” foam/splash disabled (correct).`);
        }
      } catch (_) {}

      // â”€â”€ Fire GPU readback Y-flip check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // When fire mask comes from the GPU compositor (RT texture, no .src),
      // _generatePoints uses the GPU path with gpuFlipY=true to correct the
      // bottom-to-top WebGL readPixels row order.
      try {
        const fireSparks = ms?.effectComposer?.effects?.get?.('fire-sparks');
        if (fireSparks) {
          const floorState = fireSparks._floorStates;
          let fireFloorKey = null;
          if (floorState instanceof Map) {
            for (const [k, v] of floorState.entries()) {
              if (v?.fireMask) { fireFloorKey = k; break; }
            }
          }
          if (fireFloorKey) {
            const bundle = compositor._floorMeta?.get(fireFloorKey);
            const fireEntry = bundle?.masks?.find(m => m.type === 'fire' || m.id === 'fire');
            const fireTex = fireEntry?.texture ?? null;
            const isRT = fireTex?.image != null && !fireTex?.image?.src;
            console.log(`â„¹ï¸  Fire mask source for floor "${fireFloorKey}": ${isRT ? 'GPU compositor RT (gpuFlipY=true applied)' : 'bundle/image file (no flip needed)'}`);
          }
        }
      } catch (_) {}

      if (issueCount === 0) {
        console.log(`âœ… All ${visible.length} visible floor(s) have cached bundles. Check 7b for per-effect state.`);
      }
    }
    console.groupEnd();

    console.log(sep);
    console.groupEnd();
  },

  /**
   * Deep-dive floor rendering diagnostic.
   * Exposes: _floorCache GPU RT state, floor loop simulation per pass,
   * actual SpecularEffect material uniform values, tile overlay specular
   * bindings, base plane mesh state, and TileManager _tileEffectMasks.
   * Usage: await MapShine.debug.diagnoseFloorDeepdive()
   */
  async diagnoseFloorDeepdive() {
    const ms  = window.MapShine;
    const sep = 'â”€'.repeat(60);
    const ftx = (tex) => {
      if (!tex) return 'âŒ null';
      if (tex.image?.width) return `âœ… ${tex.image.width}Ã—${tex.image.height}`;
      return 'âœ… loaded(no dims)';
    };
    const compositor = ms?.sceneComposer?._sceneMaskCompositor ?? null;
    const effectComp = ms?.effectComposer ?? null;
    const floorStack = ms?.floorStack ?? null;
    const composer   = ms?.sceneComposer ?? null;
    const specEff    = ms?.specularEffect ?? effectComp?.effects?.get?.('specular') ?? null;
    const tm         = ms?.tileManager ?? null;

    console.group('ðŸ”¬ MapShine Floor Deep-Dive Diagnostics');
    console.log(sep);

    // â”€â”€ A. _floorCache GPU RTs vs _floorMeta bundle handles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // _floorMeta  = bundle metadata (file textures OR RT handles from compose())
    // _floorCache = WebGLRenderTargets produced ONLY by compose() GPU path
    // getBelowFloorTexture() ONLY reads _floorCache â€” NOT _floorMeta.
    // If ground floor specular came from the file-based fallback (loadAssetBundle),
    // _floorCache["0:10"] never has specular â†’ getBelowFloorTexture returns null.
    console.group('A. _floorCache GPU RTs vs _floorMeta Bundles');
    if (!compositor) {
      console.warn('âš ï¸  compositor not available');
    } else {
      const fc    = compositor._floorCache ?? new Map();
      const fmeta = compositor._floorMeta  ?? new Map();
      console.log(`_floorMeta entries  : ${fmeta.size}  (file-based OR GPU RT handles)`);
      console.log(`_floorCache entries : ${fc.size}  (GPU RTs only â€” getBelowFloorTexture reads here)`);
      console.log(`_activeFloorKey     : "${compositor._activeFloorKey ?? 'null'}"`);
      console.log(`_belowFloorKey      : "${compositor._belowFloorKey  ?? 'null'}"`);
      const belowSpec = compositor.getBelowFloorTexture?.('specular') ?? null;
      console.log(`getBelowFloorTexture('specular') : ${ftx(belowSpec)}`);
      if (!belowSpec) console.warn('  âš ï¸  null â†’ ground-floor specular NOT visible through first-floor gaps (tBelowSpecularMap=null)');
      for (const [fk, meta] of fmeta.entries()) {
        const rtMap        = fc.get(fk);
        const rtTypes      = rtMap ? [...rtMap.keys()].join(', ') : '(no GPU RTs)';
        const bundleTypes  = (meta?.masks ?? []).map(m => m.id || m.type).join(', ');
        const specInBundle = (meta?.masks ?? []).some(m => m.id === 'specular' || m.type === 'specular');
        const specInCache  = !!rtMap?.has('specular');
        const specTag = specInBundle
          ? (specInCache ? 'âœ… spec in both' : 'âš ï¸  spec in _floorMeta ONLY â†’ getBelowFloor=null!')
          : 'â—‹ no specular';
        console.log(`  "${fk}"  bundle:[${bundleTypes}]  |  RT:[${rtTypes}]  |  ${specTag}`);
      }
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ B. Floor loop simulation â€” per-pass bandBottom guard prediction â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('B. Floor Loop Simulation (what bindFloorMasks sets per pass)');
    if (!floorStack || !compositor) {
      console.warn('âš ï¸  FloorStack or compositor not available');
    } else {
      const visible = floorStack.getVisibleFloors?.() ?? [];
      console.log(`Visible floors in loop: ${visible.length}`);
      for (const f of visible) {
        const bundle      = compositor._floorMeta?.get(f.compositorKey) ?? null;
        const bandBottom  = Number(String(f.compositorKey ?? '').split(':')[0]);
        const isBase      = Number.isFinite(bandBottom) && bandBottom <= 0;
        console.group(`floor[${f.index}]  key="${f.compositorKey}"  isBaseMeshFloor=${isBase}`);
        if (!bundle) {
          console.error('  âŒ bundle NULL â†’ stale masks used');
          console.groupEnd(); continue;
        }
        const se = bundle.masks?.find(m => m.id === 'specular'  || m.type === 'specular');
        const re = bundle.masks?.find(m => m.id === 'roughness' || m.type === 'roughness');
        const ne = bundle.masks?.find(m => m.id === 'normal'    || m.type === 'normal');
        console.log(`  bundle: [${(bundle.masks ?? []).map(m => m.id || m.type).join(', ')}]`);
        console.log(`  bundleSpecular=${ftx(se?.texture)}  bundleRoughness=${ftx(re?.texture)}`);
        console.log(`  â†’ this.material.uSpecularMap  â† ${isBase ? ftx(se?.texture) + (se?.texture ? '' : ' (fallback_black)') : 'fallback_black [upper-floor guard]'}`);
        console.log(`  â†’ this.material.uRoughnessMap â† ${isBase ? ftx(re?.texture) + (re?.texture ? '' : ' (fallback_black)') : 'fallback_black [upper-floor guard]'}`);
        const cached = specEff?._floorStates?.get(f.compositorKey);
        console.log(`  _floorStates: ${cached ? 'HIT spec=' + ftx(cached.specularMask) : 'MISS (will re-search bundle)'}`);
        console.groupEnd();
      }
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ C. SpecularEffect material uniforms RIGHT NOW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('C. SpecularEffect Uniform Snapshot (current state after last floor pass)');
    if (!specEff) {
      console.warn('âš ï¸  specularEffect not found');
    } else {
      const mat = specEff.material;
      if (!mat?.uniforms) {
        console.error('âŒ specEff.material or uniforms missing');
      } else {
        const u = mat.uniforms;
        console.log(`uSpecularMap         : ${ftx(u.uSpecularMap?.value)}`);
        console.log(`uRoughnessMap        : ${ftx(u.uRoughnessMap?.value)}`);
        console.log(`uNormalMap           : ${ftx(u.uNormalMap?.value)}`);
        console.log(`tBelowSpecularMap    : ${ftx(u.tBelowSpecularMap?.value)}`);
        console.log(`uHasBelowSpecularMap : ${u.uHasBelowSpecularMap?.value}`);
        console.log(`uEffectEnabled       : ${u.uEffectEnabled?.value}`);
        const fb = specEff._fallbackBlack;
        if (u.uSpecularMap?.value && fb && u.uSpecularMap.value === fb) {
          console.log('  (uSpecularMap = fallback_black â€” no specular for last bound floor, correct for upper-floor guard)');
        }
      }
      // _floorStates cache
      const fs = specEff._floorStates ?? new Map();
      console.log(`_floorStates: ${fs.size} cached`);
      for (const [k, v] of fs.entries()) {
        console.log(`  "${k}": spec=${ftx(v.specularMask)}  rough=${ftx(v.roughnessMask)}  normal=${ftx(v.normalMap)}`);
      }
      // Tile overlays
      const overlays = specEff._tileOverlays ?? new Map();
      console.log(`_tileOverlays: ${overlays.size}`);
      if (overlays.size > 0) {
        for (const [tid, ent] of overlays.entries()) {
          const cm    = ent.colorMesh;
          const cSpec = cm?.material?.uniforms?.uSpecularMap?.value ?? null;
          console.log(`  â€¦${tid.slice(-8)}: colorMesh.vis=${cm?.visible ?? '?'}  occluder.vis=${ent.occluderMesh?.visible ?? '?'}  specular=${ftx(cSpec)}`);
        }
      } else {
        console.warn('  âš ï¸  No tile overlays â€” upper floor tiles have no per-tile specular mesh!');
      }
      // Is basePlaneMesh using the PBR shader?
      const bp = composer?.basePlaneMesh ?? null;
      if (bp) {
        const same = bp.material === specEff.material;
        console.log(`basePlaneMesh.material === specEff.material : ${same}`);
        if (!same) console.error('  âŒ PBR shader is NOT on the ground plane! Ground floor specular completely broken.');
        console.log(`basePlaneMesh.visible : ${bp.visible}`);
        if (bp.material?.uniforms) {
          const bu = bp.material.uniforms;
          console.log(`basePlane.uSpecularMap      : ${ftx(bu.uSpecularMap?.value)}`);
          console.log(`basePlane.tBelowSpecularMap : ${ftx(bu.tBelowSpecularMap?.value)}`);
        }
      }
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ D. TileManager _tileEffectMasks (compositor per-tile source data) â”€â”€â”€â”€â”€â”€
    // Empty map (size=0) = "empty-cache poison" bug: first probe cached no masks,
    // so preloadAllFloors skips the tile permanently â†’ upper floor masks missing.
    console.group('D. TileManager _tileEffectMasks (per-tile cached effect masks)');
    if (!tm) {
      console.warn('âš ï¸  tileManager not available');
    } else {
      const tem = tm._tileEffectMasks;
      if (!(tem instanceof Map)) {
        console.log('  _tileEffectMasks: not a Map');
      } else {
        console.log(`  ${tem.size} tile(s) have effect mask cache entries`);
        let emptyCount = 0;
        for (const [tileId, mm] of tem.entries()) {
          if (!(mm instanceof Map)) continue;
          if (mm.size === 0) {
            emptyCount++;
            console.warn(`  âš ï¸  tile[â€¦${tileId.slice(-8)}]: EMPTY (0 masks) â€” compositor skips this tile!`);
          } else {
            const types = [...mm.entries()].map(([k, v]) => {
              const w = v?.texture?.image?.width ?? '?';
              const h = v?.texture?.image?.height ?? '?';
              return `${k}(${w}Ã—${h})`;
            }).join(', ');
            console.log(`  âœ… tile[â€¦${tileId.slice(-8)}]: [${types}]`);
          }
        }
        if (emptyCount > 0) {
          console.error(`  âŒ ${emptyCount} tile(s) have empty mask caches â€” run preloadAllFloors() again or reload scene`);
        }
      }
      // _tileSpecularMaskCache for SpecularEffect.loadTileMask path
      const tsc = tm._tileSpecularMaskCache;
      if (tsc instanceof Map) {
        console.log(`  _tileSpecularMaskCache: ${tsc.size} tile(s)`);
        for (const [k, v] of tsc.entries()) {
          console.log(`    â€¦${k.slice(-8)}: ${ftx(v)}`);
        }
      }
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ E. FloorStack object visibility â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('E. FloorStack floor object counts');
    if (!floorStack) {
      console.warn('âš ï¸  FloorStack not available');
    } else {
      const floors  = floorStack.getFloors?.() ?? [];
      const visible = floorStack.getVisibleFloors?.() ?? [];
      for (const f of floors) {
        const objCount = f.objects?.size ?? f.objects?.length ?? f._objects?.size ?? f._objects?.length ?? '?';
        const isVis    = visible.some(v => v.index === f.index);
        const isActive = f.isActive ? ' â† ACTIVE' : '';
        console.log(`  floor[${f.index}]  [${f.elevationMin}â€“${f.elevationMax}]  objects=${objCount}${isActive}${isVis ? ' (visible in loop)' : ''}`);
      }
      // Count scene objects with levelsHidden userData
      let levelsHiddenN = 0, levelsTaggedN = 0;
      try {
        ms?.sceneComposer?.scene?.traverse?.((o) => {
          if (o.userData?.levelsHidden === true) levelsHiddenN++;
          if (o.userData?.levelsFloor !== undefined) levelsTaggedN++;
        });
      } catch (_) {}
      console.log(`  Scene objects currently levelsHidden=true : ${levelsHiddenN}`);
      console.log(`  Scene objects with levelsFloor userData   : ${levelsTaggedN}`);
    }
    console.groupEnd();
    console.log(sep);

    // â”€â”€ F. Upper floor load summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.group('F. Upper Floor Load Diagnosis');
    if (!compositor) {
      console.warn('âš ï¸  compositor not available');
    } else {
      const fc    = compositor._floorCache ?? new Map();
      const fmeta = compositor._floorMeta  ?? new Map();
      const lru   = compositor._lruOrder   ?? [];
      const allBands = floorStack ? (floorStack.getFloors?.() ?? []).map(f => f.compositorKey) : [];
      const missing  = allBands.filter(k => !fmeta.has(k));
      console.log(`Expected floor bands : ${allBands.join(', ') || '(unknown)'}`);
      console.log(`_floorMeta populated : ${fmeta.size} / ${allBands.length}  ${missing.length ? 'âš ï¸  missing: ' + missing.join(', ') : 'âœ… all cached'}`);
      console.log(`_floorCache RTs      : ${fc.size} floor(s) have GPU RTs`);
      console.log(`LRU eviction order   : [${lru.join(', ')}]`);
      // Identify which floors have _floorMeta but NO _floorCache
      const metaOnlyFloors = [...fmeta.keys()].filter(k => !fc.has(k));
      if (metaOnlyFloors.length > 0) {
        console.warn(`  âš ï¸  Floors in _floorMeta but NO GPU RTs: [${metaOnlyFloors.join(', ')}]`);
        console.warn(`     â†’ These floors came from file-based fallback, not GPU compose().`);
        console.warn(`     â†’ getBelowFloorTexture() returns null for these floors.`);
        console.warn(`     â†’ Fix: getBelowFloorTexture() must also read _floorMeta bundle textures.`);
      }
      // Tile count per floor band
      const sc = canvas?.scene;
      if (sc && floorStack) {
        const { tileHasLevelsRange, readTileLevelsFlags } = await import('../foundry/levels-scene-flags.js').catch(() => ({}));
        if (tileHasLevelsRange) {
          const allTiles = (() => {
            const t = sc.tiles;
            return Array.isArray(t) ? t : (Array.isArray(t?.contents) ? t.contents : [...(t?.values?.() ?? [])]);
          })();
          for (const f of (floorStack.getFloors?.() ?? [])) {
            const band = allTiles.filter(t => {
              if (!tileHasLevelsRange(t)) return false;
              const flags = readTileLevelsFlags(t);
              return Number(flags.rangeBottom) === Number(f.elevationMin);
            });
            console.log(`  floor[${f.index}] tiles: ${band.length}  (each needs mask probing on first load)`);
          }
        }
      }
    }
    console.groupEnd();
    console.log(sep);

    console.log('Deep-dive complete. Key question: is Section A showing spec-in-_floorMeta-only?');
    console.log('If yes, getBelowFloorTexture always returns null â†’ ground specular invisible through gaps.');
    console.groupEnd();
  },

  /**
   * Quick mask binding snapshot â€” shows what texture each floor-scoped
   * effect currently has bound for each mask type.
   * Usage: MapShine.debug.diagnoseFloorMasks()
   */
  diagnoseFloorMasks() {
    const ec = window.MapShine?.effectComposer;
    if (!ec) { console.error('EffectComposer not available'); return; }

    const effectsMap = ec.effects instanceof Map ? ec.effects : null;
    if (!effectsMap) { console.error('ec.effects Map not accessible'); return; }

    const maskFields = ['waterMask','specularMask','roughnessMask','normalMap',
                        'windowMask','outdoorsMask','fireMask','dustMask',
                        'structuralMask','iridescenceMask','prismMask','treeMask'];

    console.group('ðŸ—ºï¸  Floor-Scoped Effect Mask Bindings');
    for (const eff of effectsMap.values()) {
      if (eff.floorScope === 'global') continue;
      const present = maskFields.filter(f => eff[f] !== undefined);
      if (present.length === 0) continue;

      console.group(`${eff.id} (enabled=${eff.enabled ?? eff._enabled})`);
      for (const f of present) {
        const tex = eff[f];
        const info = !tex ? 'âŒ null'
          : (tex.image?.width ? `âœ… ${tex.image.width}Ã—${tex.image.height}` : 'âœ… (no image dims)');
        console.log(`  ${f.padEnd(22)} ${info}`);
      }
      if (eff._floorStates?.size !== undefined) {
        console.log(`  _floorStates cached : ${eff._floorStates.size} floor(s)`);
      }
      console.groupEnd();
    }
    console.groupEnd();
  },

  /**
   * Show help
   */
  help() {
    console.log(`
â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
â•‘   Map Shine Advanced - Debug Helpers      â•‘
â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

Available commands (access via MapShine.debug):

  .diagnoseFloorRendering() - Comprehensive floor rendering report
  .diagnoseFloorDeepdive()  - Deep-dive: _floorCache RTs, uniform snapshot, tile overlays, _tileEffectMasks
  .diagnoseFloorMasks()     - Quick snapshot of per-effect mask bindings
  .diagnoseSpecular()       - Check specular effect health
  .resetSpecular()          - Reset to defaults
  .exportParameters()       - Export current params as JSON
  .importParameters(obj)    - Import params from object
  .validateAll()            - Validate all effects
  .monitorShader(ms)        - Monitor shader for errors
  .help()                   - Show this help

Floor debugging examples:

  // Full floor rendering report (async)
  await MapShine.debug.diagnoseFloorRendering()

  // Quick mask binding snapshot
  MapShine.debug.diagnoseFloorMasks()

Other examples:

  // Diagnose specular
  MapShine.debug.diagnoseSpecular()

  // Export current settings
  const params = MapShine.debug.exportParameters()
    `);
  }
};

/**
 * Install console helpers globally
 */
export function installConsoleHelpers() {
  if (typeof window !== 'undefined') {
    if (!window.MapShine) window.MapShine = {};
    window.MapShine.debug = consoleHelpers;

    window.MapShine.perf = {
      start: (options = {}) => {
        globalProfiler.start(options);
        return globalProfiler;
      },
      stop: () => {
        globalProfiler.stop();
        return true;
      },
      clear: () => {
        globalProfiler.clear();
        return true;
      },
      summary: () => {
        return globalProfiler.getSummary();
      },
      top: (kind = 'updatables', n = 10) => {
        return globalProfiler.getTopContributors(kind, n);
      },
      exportJson: () => {
        return globalProfiler.exportJson();
      },
      exportCsv: () => {
        return globalProfiler.exportCsv();
      },
      exportAllJson: () => {
        return {
          perf: globalProfiler.exportJson(),
          loading: globalLoadingProfiler.exportJson()
        };
      },
      loading: {
        start: () => {
          globalLoadingProfiler.start();
          return globalLoadingProfiler;
        },
        stop: () => {
          globalLoadingProfiler.stop();
          return true;
        },
        clear: () => {
          globalLoadingProfiler.clear();
          return true;
        },
        report: () => {
          return globalLoadingProfiler.getReport();
        },
        summary: () => {
          return globalLoadingProfiler.getSummary();
        },
        top: (n = 20, prefix = 'effect:') => {
          return globalLoadingProfiler.getTopSpans(n, prefix);
        },
        exportJson: () => {
          return globalLoadingProfiler.exportJson();
        },
        exportCsv: () => {
          return globalLoadingProfiler.exportCsv();
        }
      }
    };
    
    // Water occluder diagnostic â€” call MapShine.debugWaterOccluder() in the browser console
    // to dump the actual runtime state of all blocker meshes and the occluder RT.
    window.MapShine.debugWaterOccluder = () => {
      const tm = window.MapShine?.tileManager;
      const dm = window.MapShine?.distortionManager;
      if (!tm || !dm) { console.warn('tileManager or distortionManager not ready'); return; }

      const occScene = dm.waterOccluderScene;
      const occTarget = dm.waterOccluderTarget;
      console.log('distortionManager.waterOccluderScene:', occScene);
      console.log('distortionManager.waterOccluderTarget:', occTarget);
      console.log('waterOccluderScene child count:', occScene?.children?.length ?? 'N/A');

      let blockerCount = 0, blockerVisible = 0, blockerInWrongScene = 0;
      let occluderCount = 0, occluderVisible = 0;
      const rows = [];

      for (const [id, { sprite, tileDoc }] of (tm.tileSprites ?? new Map())) {
        if (!sprite) continue;
        const ud = sprite.userData;
        const blocker = ud.aboveFloorBlockerMesh;
        const occluder = ud.waterOccluderMesh;

        if (blocker) {
          blockerCount++;
          if (blocker.visible) blockerVisible++;
          // Check if blocker is in the correct scene
          const inOccScene = occScene?.children?.includes(blocker);
          if (!inOccScene) blockerInWrongScene++;
          rows.push({
            tileId: id,
            name: tileDoc?.name ?? tileDoc?.texture?.src?.split('/').pop() ?? '?',
            isOverhead: ud.isOverhead,
            levelsAbove: ud.levelsAbove,
            levelsHidden: ud.levelsHidden,
            shouldBlock: ud.isOverhead || ud.levelsAbove,
            blockerVisible: blocker.visible,
            blockerInOccScene: inOccScene,
            occluderVisible: occluder?.visible ?? null,
            spriteVisible: sprite.visible,
            opacity: sprite.material?.opacity?.toFixed(2) ?? '?'
          });
        }

        if (occluder) {
          occluderCount++;
          if (occluder.visible) occluderVisible++;
        }
      }

      console.log(`Blocker meshes: ${blockerCount} total, ${blockerVisible} visible, ${blockerInWrongScene} in WRONG scene`);
      console.log(`Occluder meshes: ${occluderCount} total, ${occluderVisible} visible`);
      console.table(rows.filter(r => r.isOverhead || r.levelsAbove || r.blockerVisible));
      console.log('Full rows (all tiles with blockers):', rows);

      // Also check if WaterEffectV2 has the occluder texture bound
      const we = window.MapShine?.waterEffect;
      if (we) {
        const u = we._material?.uniforms;
        console.log('WaterEffectV2 tWaterOccluderAlpha:', u?.tWaterOccluderAlpha?.value);
        console.log('WaterEffectV2 uHasWaterOccluderAlpha:', u?.uHasWaterOccluderAlpha?.value);
      }

      return rows;
    };

    // â”€â”€ Water flooding root-cause diagnostic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Call MapShine.diagWater() in the browser console while the flooding is
    // visible. It reads the actual runtime state of every system involved in
    // cross-floor water suppression and prints a clear pass/fail for each one.
    window.MapShine.diagWater = () => {
      const ms   = window.MapShine;
      const we   = ms?.waterEffect;
      const dm   = ms?.distortionManager;
      const comp = ms?.sceneComposer?._sceneMaskCompositor;
      const fs   = ms?.floorStack;

      console.group('=== Water Flooding Diagnostic ===');

      // â”€â”€ 1. Floor stack â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      console.group('1. Floor stack');
      const activeFloor = fs?.getActiveFloor?.() ?? null;
      const allFloors   = fs?.getAllFloors?.()   ?? [];
      console.log('floorStack:', fs ?? 'NULL â€” floorStack not on window.MapShine');
      console.log('activeFloor:', activeFloor);
      console.log('activeFloor.index:', activeFloor?.index ?? 'N/A');
      console.log('activeFloor.compositorKey:', activeFloor?.compositorKey ?? 'N/A');
      console.log('all floors:', allFloors.map(f => `index=${f.index} key=${f.compositorKey}`));
      console.groupEnd();

      // â”€â”€ 2. Floor ID texture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      console.group('2. Floor ID texture (compositor.floorIdTarget)');
      const floorIdTarget = comp?.floorIdTarget ?? null;
      console.log('compositor:', comp ?? 'NULL');
      console.log('floorIdTarget:', floorIdTarget);
      console.log('floorIdTarget.texture:', floorIdTarget?.texture ?? 'NULL');
      if (floorIdTarget) {
        console.log('  size:', floorIdTarget.width, 'x', floorIdTarget.height);
        // GPU readback â€” sample a 4x4 grid to see what values are actually in the texture
        try {
          const renderer = ms?.renderer;
          if (renderer) {
            const w = floorIdTarget.width, h = floorIdTarget.height;
            const buf = new Uint8Array(4);
            const prev = renderer.getRenderTarget();
            renderer.setRenderTarget(floorIdTarget);
            // Sample center pixel
            renderer.readRenderTargetPixels(floorIdTarget, Math.floor(w/2), Math.floor(h/2), 1, 1, buf);
            renderer.setRenderTarget(prev);
            console.log('  center pixel RGBA:', buf[0], buf[1], buf[2], buf[3],
              'â†’ floor index =', Math.round(buf[0] / 255 * 255));
          }
        } catch (e) { console.warn('  readback failed:', e); }
      } else {
        console.warn('  floorIdTarget is NULL â€” floor ID gate is DISABLED (uHasFloorIdTex=0)');
      }
      console.groupEnd();

      // â”€â”€ 3. WaterEffectV2 uniforms â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      console.group('3. WaterEffectV2 uniforms');
      const wu = we?._material?.uniforms;
      if (!wu) {
        console.warn('WaterEffectV2 material not ready');
      } else {
        console.log('uHasFloorIdTex:', wu.uHasFloorIdTex?.value, wu.uHasFloorIdTex?.value > 0.5 ? 'âœ…' : 'âŒ GATE DISABLED');
        console.log('uActiveFloorIndex:', wu.uActiveFloorIndex?.value, 'â†’ floor index =', Math.round((wu.uActiveFloorIndex?.value ?? 0) * 255));
        console.log('tFloorIdTex:', wu.tFloorIdTex?.value ?? 'NULL');
        console.log('uHasWaterData:', wu.uHasWaterData?.value);
        console.log('uHasWaterOccluderAlpha:', wu.uHasWaterOccluderAlpha?.value);
        console.log('uWaterEnabled:', wu.uWaterEnabled?.value);
        console.log('uDebugView:', wu.uDebugView?.value);
      }
      console.groupEnd();

      // â”€â”€ 4. DistortionManager apply uniforms â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      console.group('4. DistortionManager apply uniforms');
      const au = dm?.applyMaterial?.uniforms;
      if (!au) {
        console.warn('DistortionManager applyMaterial not ready');
      } else {
        console.log('uHasFloorIdTex:', au.uHasFloorIdTex?.value, au.uHasFloorIdTex?.value > 0.5 ? 'âœ…' : 'âŒ GATE DISABLED');
        console.log('uActiveFloorIndex:', au.uActiveFloorIndex?.value, 'â†’ floor index =', Math.round((au.uActiveFloorIndex?.value ?? 0) * 255));
        console.log('tFloorIdTex:', au.tFloorIdTex?.value ?? 'NULL');
        console.log('uHasWaterOccluderAlpha:', au.uHasWaterOccluderAlpha?.value);
      }
      console.groupEnd();

      // â”€â”€ 5. Compositor floor cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      console.group('5. Compositor floor cache');
      if (!comp) {
        console.warn('compositor not found at sceneComposer._sceneMaskCompositor');
      } else {
        console.log('_activeFloorKey:', comp._activeFloorKey);
        console.log('_floorCache keys:', [...(comp._floorCache?.keys() ?? [])]);
        console.log('_floorMeta keys:', [...(comp._floorMeta?.keys() ?? [])]);
        for (const [key, targets] of (comp._floorCache ?? new Map())) {
          const maskTypes = [...targets.keys()];
          console.log(`  floor "${key}": masks = [${maskTypes.join(', ')}]`);
        }
      }
      console.groupEnd();

      // â”€â”€ 6. activeLevelContext â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      console.group('6. activeLevelContext');
      console.log('window.MapShine.activeLevelContext:', ms?.activeLevelContext);
      console.groupEnd();

      console.groupEnd();
      console.log('ðŸ“‹ Copy the above and paste it into the issue tracker.');
    };

    // Shortcut to visualize the water occluder RT in WaterEffectV2 (debug view 8 = waterOccluder)
    window.MapShine.showOccluderDebug = (view = 8) => {
      const we = window.MapShine?.waterEffect;
      if (!we?._material?.uniforms?.uDebugView) { console.warn('WaterEffectV2 not ready or no uDebugView uniform'); return; }
      we._material.uniforms.uDebugView.value = view;
      console.log(`WaterEffectV2 debug view set to ${view}. Call MapShine.showOccluderDebug(0) to reset.`);
    };

    log.info('Console helpers installed: MapShine.debug');
    console.log('ðŸ’¡ Type MapShine.debug.help() for debugging commands');
    console.log('ðŸ’¡ Type MapShine.showOccluderDebug(8) to visualize tWaterOccluderAlpha');
  }
}
