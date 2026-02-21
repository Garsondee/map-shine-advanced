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
    console.group('🔍 Map Shine Specular Diagnostics');
    
    const effect = window.MapShine?.specularEffect;
    if (!effect) {
      console.error('❌ Specular effect not found');
      console.groupEnd();
      return;
    }

    console.log('✅ Specular effect found');
    
    // Check enabled state
    console.log(`Enabled: ${effect.enabled}`);
    
    // Check effective state
    const { getSpecularEffectiveState } = await import('../ui/parameter-validator.js');
    const effectiveState = getSpecularEffectiveState(effect.params);
    if (!effectiveState.effective) {
      console.warn('⚠️ Effect is ineffective:', effectiveState.reasons);
    } else {
      console.log('✅ Effect is active and functional');
    }
    
    // Check material
    if (!effect.material) {
      console.error('❌ Material is null');
      console.groupEnd();
      return;
    }
    console.log('✅ Material exists');
    
    // Check validation status
    const validation = effect.getValidationStatus();
    if (!validation.valid) {
      console.error('❌ Validation failed:', validation.errors);
    } else {
      console.log('✅ Validation passed');
    }
    
    // Check parameters
    console.group('Parameters');
    for (const [key, value] of Object.entries(effect.params)) {
      const isValid = typeof value === 'number' ? Number.isFinite(value) : true;
      const icon = isValid ? '✅' : '❌';
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
        console.error(`❌ ${name}: MISSING`);
        continue;
      }
      
      const value = uniform.value;
      const isValid = typeof value === 'number' ? Number.isFinite(value) : value !== null;
      const icon = isValid ? '✅' : '❌';
      console.log(`${icon} ${name}: ${value}`);
    }
    console.groupEnd();
    
    // Check for common issues
    console.group('Common Issues');
    const issues = [];
    
    if (effect.params.stripeEnabled && effect.params.stripe1Frequency === 0) {
      issues.push('⚠️ Stripe 1 frequency is 0 (will cause NaN)');
    }
    
    if (effect.params.stripe1Width < 0.01) {
      issues.push('⚠️ Stripe 1 width very small (may cause aliasing)');
    }
    
    const totalIntensity = 
      (effect.params.stripe1Enabled ? effect.params.stripe1Intensity : 0) +
      (effect.params.stripe2Enabled ? effect.params.stripe2Intensity : 0) +
      (effect.params.stripe3Enabled ? effect.params.stripe3Intensity : 0);
    
    if (totalIntensity > 3.0) {
      issues.push(`⚠️ Total stripe intensity very high (${totalIntensity.toFixed(2)})`);
    }
    
    if (issues.length === 0) {
      console.log('✅ No obvious issues detected');
    } else {
      issues.forEach(issue => console.warn(issue));
    }
    console.groupEnd();
    
    // Suggestions
    console.group('💡 Suggestions');
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
    
    console.log('🔄 Resetting specular effect to defaults...');
    uiManager.resetEffectToDefaults('specular');
    console.log('✅ Reset complete');
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
      console.log('✅ Copied to clipboard');
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
    
    console.log('📥 Importing parameters...');
    
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
    
    console.log('✅ Import complete');
  },

  /**
   * Show validation report for all effects
   */
  async validateAll() {
    console.group('🔍 Validation Report');
    
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
      
      const icon = validation.valid ? '✅' : '❌';
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
    
    console.log(`🔍 Monitoring shader for ${duration}ms...`);
    
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
      console.log(`✅ Monitoring complete: ${checkCount} checks, ${errorCount} errors`);
      
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
    const sep = '─'.repeat(60);

    console.group('🗺️  MapShine Floor Rendering Diagnostics');
    console.log(sep);

    // ── 1. Floor loop gate ──────────────────────────────────────────────────
    console.group('1. Floor Loop Gate');
    const floorStack = ms?.floorStack ?? null;
    const composer   = ms?.sceneComposer ?? null;
    const compositor = composer?._sceneMaskCompositor ?? null;
    const effectComp = ms?.effectComposer ?? null;

    let loopEnabled = false;
    try {
      loopEnabled = game?.settings?.get?.('map-shine-advanced', 'experimentalFloorRendering') ?? false;
    } catch (_) {}

    console.log(`experimentalFloorRendering setting : ${loopEnabled ? '✅ true' : '❌ false'}`);
    console.log(`FloorStack available               : ${floorStack  ? '✅' : '❌ null'}`);
    console.log(`GpuSceneMaskCompositor available   : ${compositor  ? '✅' : '❌ null'}`);
    console.log(`EffectComposer available            : ${effectComp  ? '✅' : '❌ null'}`);
    console.log(`Floor loop would run               : ${(loopEnabled && !!floorStack) ? '✅ YES' : '❌ NO'}`);
    console.groupEnd();
    console.log(sep);

    // ── 2. FloorStack ────────────────────────────────────────────────────────
    console.group('2. FloorStack');
    if (!floorStack) {
      console.warn('⚠️  FloorStack not available — floor loop cannot run');
    } else {
      const allFloors     = floorStack.getFloors?.() ?? [];
      const visibleFloors = floorStack.getVisibleFloors?.() ?? [];
      const activeFloor   = floorStack.getActiveFloor?.() ?? null;

      console.log(`Total floors   : ${allFloors.length}`);
      console.log(`Active floor   : ${activeFloor ? `index=${activeFloor.index}  [${activeFloor.elevationMin}–${activeFloor.elevationMax}]  compositorKey="${activeFloor.compositorKey}"` : 'null'}`);
      console.log(`Visible floors : ${visibleFloors.length}  (rendered this frame)`);
      console.group('All floor bands');
      for (const f of allFloors) {
        const isActive  = f.isActive ? ' ← ACTIVE' : '';
        const isVisible = visibleFloors.some(v => v.index === f.index) ? ' (visible)' : '';
        console.log(`  [${f.index}] elev ${f.elevationMin}–${f.elevationMax}  key="${f.key}"  compositorKey="${f.compositorKey}"${isActive}${isVisible}`);
      }
      console.groupEnd();
    }
    console.groupEnd();
    console.log(sep);

    // ── 3. GpuSceneMaskCompositor _floorMeta ────────────────────────────────
    console.group('3. GpuSceneMaskCompositor _floorMeta Cache');
    if (!compositor) {
      console.warn('⚠️  Compositor not available');
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
          console.log(`  "${key}" → masks: [${types}]   basePath: "${bp}"`);
        }
        console.groupEnd();
      } else {
        console.warn('  ⚠️  _floorMeta is EMPTY — all bindFloorMasks() calls will receive null bundles');
      }

      // Test compositorKey alignment against FloorStack
      if (floorStack) {
        console.group('compositorKey ↔ _floorMeta alignment (critical)');
        const allFloors = floorStack.getFloors?.() ?? [];
        for (const f of allFloors) {
          const found = floorMeta?.get(f.compositorKey);
          if (found) {
            const types = (found.masks ?? []).map(m => m?.type || m?.id || '?').join(', ');
            console.log(`  ✅ floor[${f.index}] compositorKey="${f.compositorKey}" → FOUND  [${types}]`);
          } else {
            console.error(`  ❌ floor[${f.index}] compositorKey="${f.compositorKey}" → NOT IN _floorMeta — effects will receive null bundle!`);
          }
        }
        console.groupEnd();
      }
    }
    console.groupEnd();
    console.log(sep);

    // ── 4. Scene background & tiles ─────────────────────────────────────────
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
        console.log(`  elev=${elev}  ${w}×${h}  ${levelsInfo}${hidden}  "${src}"`);
      }
      console.groupEnd();
    }
    console.groupEnd();
    console.log(sep);

    // ── 5. Effect registry masks ─────────────────────────────────────────────
    console.group('5. EffectMaskRegistry (active floor masks)');
    const registry = ms?.effectMaskRegistry ?? null;
    if (!registry) {
      console.warn('⚠️  effectMaskRegistry not available');
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
          const size   = (tex?.image?.width && tex?.image?.height) ? `${tex.image.width}×${tex.image.height}` : 'no image';
          const fk     = slot?.floorKey ?? 'null';
          const src    = slot?.source   ?? '?';
          const policy = getPolicy(type);
          const preserve = policy?.preserveAcrossFloors === true;
          // Flag when a preserved mask belongs to a DIFFERENT floor than the active one.
          const crossFloor = preserve && hasTex && activeCompKey && fk && fk !== 'null' && fk !== activeCompKey;
          if (crossFloor) crossFloorCount++;
          const crossTag = crossFloor ? '  ⚠️ CROSS-FLOOR (preserved from floor "' + fk + '")' : '';
          const preserveTag = preserve ? '  [preserveAcrossFloors]' : '';
          console.log(`  ${hasTex ? '✅' : '❌'} ${type.padEnd(20)} texture=${hasTex ? size : 'null'}  floorKey="${fk}"  source=${src}${preserveTag}${crossTag}`);
        }
        if (crossFloorCount > 0) {
          console.warn(`  ⚠️  ${crossFloorCount} mask(s) are PRESERVED from a different floor. This is intentional for water (post-FX)`);
          console.warn(`     but a bug for specular/roughness/normal (should clear per-floor). Check preserveAcrossFloors policies.`);
        }
      } else {
        console.log('  (_slots not accessible — registry:', registry, ')');
      }
    }
    console.groupEnd();
    console.log(sep);

    // ── 6. Floor-scoped effects — current mask bindings ─────────────────────
    console.group('6. Floor-scoped Effects — Current Mask Bindings');
    const ec = effectComp;
    if (!ec) {
      console.warn('⚠️  EffectComposer not available');
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
          const sz  = (tex?.image?.width && tex?.image?.height) ? `${tex.image.width}×${tex.image.height}` : 'loaded';
          return `${f}=${sz}`;
        });
        const floorStates = eff._floorStates?.size !== undefined ? `  _floorStates.size=${eff._floorStates.size}` : '';
        console.log(`  ${hasBind ? '✅' : '⚠️ '} ${eff.id.padEnd(28)} enabled=${String(enabled).padEnd(5)} ${bound.join('  ')}${floorStates}`);
      }
      console.groupEnd();

      console.group('Global-scoped effects');
      for (const eff of globalEffects) {
        console.log(`  ✅ ${eff.id}`);
      }
      console.groupEnd();
    }
    console.groupEnd();
    console.log(sep);

    // ── 7. Visible floor bundle test ─────────────────────────────────────────
    const CORE_MASK_TYPES = ['water','fire','specular','roughness','normal',
                             'windows','structural','outdoors','dust','ash',
                             'iridescence','prism','tree','bush','fluid'];
    console.group('7. Per-Floor Bundle Test (what the render loop would get)');
    if (!floorStack || !compositor) {
      console.warn('⚠️  FloorStack or compositor not available');
    } else {
      const visible = floorStack.getVisibleFloors?.() ?? [];
      if (visible.length === 0) console.warn('⚠️  No visible floors');
      for (const f of visible) {
        const bundle = compositor._floorMeta?.get(f.compositorKey) ?? null;
        if (bundle) {
          const types = (bundle.masks ?? []).map(m => m?.type || m?.id || '?');
          const missing = CORE_MASK_TYPES.filter(t => !types.includes(t));
          console.log(`  ✅ floor[${f.index}] key="${f.compositorKey}" → [${types.join(', ')}]` +
            (missing.length ? `  |  absent: [${missing.join(', ')}]` : '  (all core masks present)'));
        } else {
          console.error(`  ❌ floor[${f.index}] key="${f.compositorKey}" → bundle is NULL`);
          console.error(`     ↳ preloadAllFloors() hasn't cached this floor yet, or composeFloor() returned null.`);
          console.error(`     ↳ Effects will keep the previous floor's masks — likely rendering the wrong content.`);
        }
      }
    }
    console.groupEnd();
    console.log(sep);

    // ── 7b. Per-effect _floorStates cache contents ───────────────────────────
    console.group('7b. Per-Effect _floorStates Cache (what each effect has seen per floor)');
    if (effectComp?.effects instanceof Map) {
      const allEffects = [...effectComp.effects.values()];
      const floorEffects = allEffects.filter(e => e._floorStates instanceof Map && e._floorStates.size > 0);
      if (floorEffects.length === 0) {
        console.warn('⚠️  No effects have populated _floorStates — bindFloorMasks may not be running (check experimentalFloorRendering setting)');
      }
      for (const eff of floorEffects) {
        const entries = [...eff._floorStates.entries()];
        const lines = entries.map(([k, v]) => {
          const maskSummary = Object.entries(v)
            .map(([field, val]) => {
              if (val === null) return `${field}=null`;
              if (val && typeof val === 'object' && val.image) return `${field}=${val.image.width}×${val.image.height}`;
              return `${field}=${String(val).substring(0, 20)}`;
            }).join(', ');
          return `      "${k}": {${maskSummary}}`;
        }).join('\n');
        console.log(`  ${eff.id} (${entries.length} floor(s) cached):\n${lines}`);
      }
    }
    console.groupEnd();
    console.log(sep);

    // ── 8. Summary ───────────────────────────────────────────────────────────
    console.group('8. Summary / Likely Issues');
    if (compositor && floorStack) {
      const visible    = floorStack.getVisibleFloors?.() ?? [];
      const nullFloors = visible.filter(f => !compositor._floorMeta?.get(f.compositorKey));
      let issueCount = 0;

      if (nullFloors.length > 0) {
        issueCount++;
        console.error(`❌ ${nullFloors.length} visible floor(s) have no cached bundle:`);
        for (const f of nullFloors) {
          console.error(`   floor[${f.index}] "${f.compositorKey}" — effects will render with stale cross-floor masks.`);
        }
        console.error('   → Run preloadAllFloors() or wait for it to complete after scene load.');
      }

      // Check for effects with empty _floorStates (bind loop may not be running).
      // Post-processing effects are intentionally excluded from the floor loop's
      // bindFloorMasks calls — they use connectToRegistry() instead — so having
      // _floorStates.size=0 is CORRECT for them (water, lighting, etc.).
      if (effectComp?.effects instanceof Map) {
        let postProcessingOrder = Infinity;
        try {
          const { RenderLayers } = await import('../effects/EffectComposer.js');
          postProcessingOrder = RenderLayers?.POST_PROCESSING?.order ?? Infinity;
        } catch (_) {}
        const bindable = [...effectComp.effects.values()].filter(e => {
          if (typeof e.bindFloorMasks !== 'function') return false;
          // Exclude post-processing effects — they use connectToRegistry, not bindFloorMasks.
          const layerOrder = e.layer?.order ?? -Infinity;
          return layerOrder < postProcessingOrder;
        });
        const neverBound = bindable.filter(e => e._floorStates instanceof Map && e._floorStates.size === 0);
        if (neverBound.length > 0) {
          issueCount++;
          console.warn(`⚠️  ${neverBound.length} scene-layer bindable effect(s) have empty _floorStates:`);
          console.warn('   ' + neverBound.map(e => e.id).join(', '));
          console.warn('   → Check experimentalFloorRendering setting and that preloadAllFloors completed.');
        }
      }

      // Report which masks are absent from each floor's bundle
      for (const f of visible) {
        const bundle = compositor._floorMeta?.get(f.compositorKey);
        if (!bundle) continue;
        const types = (bundle.masks ?? []).map(m => m?.type || m?.id || '?');
        const criticalAbsent = ['specular','windows','water','fire'].filter(t => !types.includes(t));
        if (criticalAbsent.length > 0) {
          console.info(`ℹ️  floor[${f.index}] "${f.compositorKey}" is missing: [${criticalAbsent.join(', ')}]`);
          console.info(`   → These effects will be disabled/null for this floor's render pass (expected if the map has no such mask files).`);
        }
      }

      // ── Foam floor-key guard status ─────────────────────────────────────────
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
            console.warn(`⚠️  FOAM GUARD ACTIVE: water mask is from floor "${waterFloorKey}" but active floor is "${activeKey}"`);
            console.warn(`   → WeatherParticles foam/splash suppressed on this floor (correct — avoids cross-floor spawn positions).`);
            console.warn(`   → The 2D water post-FX shader still runs (preserveAcrossFloors=true for water is intentional for post-FX).`);
            issueCount++; // not an error, but worth highlighting
          } else {
            console.log(`✅ Foam floor-key guard: water floorKey="${waterFloorKey}" matches active floor "${activeKey}" — foam active.`);
          }
        } else if (activeKey && !waterTex) {
          console.log(`ℹ️  Foam: no water mask on active floor "${activeKey}" — foam/splash disabled (correct).`);
        }
      } catch (_) {}

      // ── Fire GPU readback Y-flip check ──────────────────────────────────────
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
            console.log(`ℹ️  Fire mask source for floor "${fireFloorKey}": ${isRT ? 'GPU compositor RT (gpuFlipY=true applied)' : 'bundle/image file (no flip needed)'}`);
          }
        }
      } catch (_) {}

      if (issueCount === 0) {
        console.log(`✅ All ${visible.length} visible floor(s) have cached bundles. Check 7b for per-effect state.`);
      }
    }
    console.groupEnd();

    console.log(sep);
    console.log('Diagnostic complete. Use MapShine.debug.help() for all commands.');
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
    const sep = '─'.repeat(60);
    const ftx = (tex) => {
      if (!tex) return '❌ null';
      if (tex.image?.width) return `✅ ${tex.image.width}×${tex.image.height}`;
      return '✅ loaded(no dims)';
    };
    const compositor = ms?.sceneComposer?._sceneMaskCompositor ?? null;
    const effectComp = ms?.effectComposer ?? null;
    const floorStack = ms?.floorStack ?? null;
    const composer   = ms?.sceneComposer ?? null;
    const specEff    = ms?.specularEffect ?? effectComp?.effects?.get?.('specular') ?? null;
    const tm         = ms?.tileManager ?? null;

    console.group('🔬 MapShine Floor Deep-Dive Diagnostics');
    console.log(sep);

    // ── A. _floorCache GPU RTs vs _floorMeta bundle handles ──────────────────
    // _floorMeta  = bundle metadata (file textures OR RT handles from compose())
    // _floorCache = WebGLRenderTargets produced ONLY by compose() GPU path
    // getBelowFloorTexture() ONLY reads _floorCache — NOT _floorMeta.
    // If ground floor specular came from the file-based fallback (loadAssetBundle),
    // _floorCache["0:10"] never has specular → getBelowFloorTexture returns null.
    console.group('A. _floorCache GPU RTs vs _floorMeta Bundles');
    if (!compositor) {
      console.warn('⚠️  compositor not available');
    } else {
      const fc    = compositor._floorCache ?? new Map();
      const fmeta = compositor._floorMeta  ?? new Map();
      console.log(`_floorMeta entries  : ${fmeta.size}  (file-based OR GPU RT handles)`);
      console.log(`_floorCache entries : ${fc.size}  (GPU RTs only — getBelowFloorTexture reads here)`);
      console.log(`_activeFloorKey     : "${compositor._activeFloorKey ?? 'null'}"`);
      console.log(`_belowFloorKey      : "${compositor._belowFloorKey  ?? 'null'}"`);
      const belowSpec = compositor.getBelowFloorTexture?.('specular') ?? null;
      console.log(`getBelowFloorTexture('specular') : ${ftx(belowSpec)}`);
      if (!belowSpec) console.warn('  ⚠️  null → ground-floor specular NOT visible through first-floor gaps (tBelowSpecularMap=null)');
      for (const [fk, meta] of fmeta.entries()) {
        const rtMap        = fc.get(fk);
        const rtTypes      = rtMap ? [...rtMap.keys()].join(', ') : '(no GPU RTs)';
        const bundleTypes  = (meta?.masks ?? []).map(m => m.id || m.type).join(', ');
        const specInBundle = (meta?.masks ?? []).some(m => m.id === 'specular' || m.type === 'specular');
        const specInCache  = !!rtMap?.has('specular');
        const specTag = specInBundle
          ? (specInCache ? '✅ spec in both' : '⚠️  spec in _floorMeta ONLY → getBelowFloor=null!')
          : '○ no specular';
        console.log(`  "${fk}"  bundle:[${bundleTypes}]  |  RT:[${rtTypes}]  |  ${specTag}`);
      }
    }
    console.groupEnd();
    console.log(sep);

    // ── B. Floor loop simulation — per-pass bandBottom guard prediction ────────
    console.group('B. Floor Loop Simulation (what bindFloorMasks sets per pass)');
    if (!floorStack || !compositor) {
      console.warn('⚠️  FloorStack or compositor not available');
    } else {
      const visible = floorStack.getVisibleFloors?.() ?? [];
      console.log(`Visible floors in loop: ${visible.length}`);
      for (const f of visible) {
        const bundle      = compositor._floorMeta?.get(f.compositorKey) ?? null;
        const bandBottom  = Number(String(f.compositorKey ?? '').split(':')[0]);
        const isBase      = Number.isFinite(bandBottom) && bandBottom <= 0;
        console.group(`floor[${f.index}]  key="${f.compositorKey}"  isBaseMeshFloor=${isBase}`);
        if (!bundle) {
          console.error('  ❌ bundle NULL → stale masks used');
          console.groupEnd(); continue;
        }
        const se = bundle.masks?.find(m => m.id === 'specular'  || m.type === 'specular');
        const re = bundle.masks?.find(m => m.id === 'roughness' || m.type === 'roughness');
        const ne = bundle.masks?.find(m => m.id === 'normal'    || m.type === 'normal');
        console.log(`  bundle: [${(bundle.masks ?? []).map(m => m.id || m.type).join(', ')}]`);
        console.log(`  bundleSpecular=${ftx(se?.texture)}  bundleRoughness=${ftx(re?.texture)}`);
        console.log(`  → this.material.uSpecularMap  ← ${isBase ? ftx(se?.texture) + (se?.texture ? '' : ' (fallback_black)') : 'fallback_black [upper-floor guard]'}`);
        console.log(`  → this.material.uRoughnessMap ← ${isBase ? ftx(re?.texture) + (re?.texture ? '' : ' (fallback_black)') : 'fallback_black [upper-floor guard]'}`);
        const cached = specEff?._floorStates?.get(f.compositorKey);
        console.log(`  _floorStates: ${cached ? 'HIT spec=' + ftx(cached.specularMask) : 'MISS (will re-search bundle)'}`);
        console.groupEnd();
      }
    }
    console.groupEnd();
    console.log(sep);

    // ── C. SpecularEffect material uniforms RIGHT NOW ─────────────────────────
    console.group('C. SpecularEffect Uniform Snapshot (current state after last floor pass)');
    if (!specEff) {
      console.warn('⚠️  specularEffect not found');
    } else {
      const mat = specEff.material;
      if (!mat?.uniforms) {
        console.error('❌ specEff.material or uniforms missing');
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
          console.log('  (uSpecularMap = fallback_black — no specular for last bound floor, correct for upper-floor guard)');
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
          console.log(`  …${tid.slice(-8)}: colorMesh.vis=${cm?.visible ?? '?'}  occluder.vis=${ent.occluderMesh?.visible ?? '?'}  specular=${ftx(cSpec)}`);
        }
      } else {
        console.warn('  ⚠️  No tile overlays — upper floor tiles have no per-tile specular mesh!');
      }
      // Is basePlaneMesh using the PBR shader?
      const bp = composer?.basePlaneMesh ?? null;
      if (bp) {
        const same = bp.material === specEff.material;
        console.log(`basePlaneMesh.material === specEff.material : ${same}`);
        if (!same) console.error('  ❌ PBR shader is NOT on the ground plane! Ground floor specular completely broken.');
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

    // ── D. TileManager _tileEffectMasks (compositor per-tile source data) ──────
    // Empty map (size=0) = "empty-cache poison" bug: first probe cached no masks,
    // so preloadAllFloors skips the tile permanently → upper floor masks missing.
    console.group('D. TileManager _tileEffectMasks (per-tile cached effect masks)');
    if (!tm) {
      console.warn('⚠️  tileManager not available');
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
            console.warn(`  ⚠️  tile[…${tileId.slice(-8)}]: EMPTY (0 masks) — compositor skips this tile!`);
          } else {
            const types = [...mm.entries()].map(([k, v]) => {
              const w = v?.texture?.image?.width ?? '?';
              const h = v?.texture?.image?.height ?? '?';
              return `${k}(${w}×${h})`;
            }).join(', ');
            console.log(`  ✅ tile[…${tileId.slice(-8)}]: [${types}]`);
          }
        }
        if (emptyCount > 0) {
          console.error(`  ❌ ${emptyCount} tile(s) have empty mask caches — run preloadAllFloors() again or reload scene`);
        }
      }
      // _tileSpecularMaskCache for SpecularEffect.loadTileMask path
      const tsc = tm._tileSpecularMaskCache;
      if (tsc instanceof Map) {
        console.log(`  _tileSpecularMaskCache: ${tsc.size} tile(s)`);
        for (const [k, v] of tsc.entries()) {
          console.log(`    …${k.slice(-8)}: ${ftx(v)}`);
        }
      }
    }
    console.groupEnd();
    console.log(sep);

    // ── E. FloorStack object visibility ────────────────────────────────────────
    console.group('E. FloorStack floor object counts');
    if (!floorStack) {
      console.warn('⚠️  FloorStack not available');
    } else {
      const floors  = floorStack.getFloors?.() ?? [];
      const visible = floorStack.getVisibleFloors?.() ?? [];
      for (const f of floors) {
        const objCount = f.objects?.size ?? f.objects?.length ?? f._objects?.size ?? f._objects?.length ?? '?';
        const isVis    = visible.some(v => v.index === f.index);
        const isActive = f.isActive ? ' ← ACTIVE' : '';
        console.log(`  floor[${f.index}]  [${f.elevationMin}–${f.elevationMax}]  objects=${objCount}${isActive}${isVis ? ' (visible in loop)' : ''}`);
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

    // ── F. Upper floor load summary ────────────────────────────────────────────
    console.group('F. Upper Floor Load Diagnosis');
    if (!compositor) {
      console.warn('⚠️  compositor not available');
    } else {
      const fc    = compositor._floorCache ?? new Map();
      const fmeta = compositor._floorMeta  ?? new Map();
      const lru   = compositor._lruOrder   ?? [];
      const allBands = floorStack ? (floorStack.getFloors?.() ?? []).map(f => f.compositorKey) : [];
      const missing  = allBands.filter(k => !fmeta.has(k));
      console.log(`Expected floor bands : ${allBands.join(', ') || '(unknown)'}`);
      console.log(`_floorMeta populated : ${fmeta.size} / ${allBands.length}  ${missing.length ? '⚠️  missing: ' + missing.join(', ') : '✅ all cached'}`);
      console.log(`_floorCache RTs      : ${fc.size} floor(s) have GPU RTs`);
      console.log(`LRU eviction order   : [${lru.join(', ')}]`);
      // Identify which floors have _floorMeta but NO _floorCache
      const metaOnlyFloors = [...fmeta.keys()].filter(k => !fc.has(k));
      if (metaOnlyFloors.length > 0) {
        console.warn(`  ⚠️  Floors in _floorMeta but NO GPU RTs: [${metaOnlyFloors.join(', ')}]`);
        console.warn(`     → These floors came from file-based fallback, not GPU compose().`);
        console.warn(`     → getBelowFloorTexture() returns null for these floors.`);
        console.warn(`     → Fix: getBelowFloorTexture() must also read _floorMeta bundle textures.`);
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
    console.log('If yes, getBelowFloorTexture always returns null → ground specular invisible through gaps.');
    console.groupEnd();
  },

  /**
   * Quick mask binding snapshot — shows what texture each floor-scoped
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

    console.group('🗺️  Floor-Scoped Effect Mask Bindings');
    for (const eff of effectsMap.values()) {
      if (eff.floorScope === 'global') continue;
      const present = maskFields.filter(f => eff[f] !== undefined);
      if (present.length === 0) continue;

      console.group(`${eff.id} (enabled=${eff.enabled ?? eff._enabled})`);
      for (const f of present) {
        const tex = eff[f];
        const info = !tex ? '❌ null'
          : (tex.image?.width ? `✅ ${tex.image.width}×${tex.image.height}` : '✅ (no image dims)');
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
╔═══════════════════════════════════════════╗
║   Map Shine Advanced - Debug Helpers      ║
╚═══════════════════════════════════════════╝

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
    
    log.info('Console helpers installed: MapShine.debug');
    console.log('💡 Type MapShine.debug.help() for debugging commands');
  }
}
