/**
 * Console diagnostic probe for SpecularEffectV2.
 * Run this in the browser console to diagnose why specular is broken.
 *
 * Usage:
 *   window.MapShine.specularDiagnosticProbe()
 */

window.MapShine = window.MapShine || {};

window.MapShine.specularDiagnosticProbe = function() {
  console.group('🔍 SpecularEffectV2 Diagnostic Probe');
  console.log('Probe timestamp:', new Date().toISOString());

  // ── 1. Basic instantiation check ────────────────────────────────────────
  const floorCompositor = window.MapShine?.sceneComposer?._floorCompositor;
  if (!floorCompositor) {
    console.error('❌ FloorCompositor not found - V2 rendering may not be active');
    console.groupEnd();
    return;
  }
  console.log('✅ FloorCompositor found');

  const specularEffect = floorCompositor._specularEffect;
  if (!specularEffect) {
    console.error('❌ SpecularEffectV2 not instantiated on FloorCompositor');
    console.groupEnd();
    return;
  }
  console.log('✅ SpecularEffectV2 instantiated');

  // ── 2. Initialization state ────────────────────────────────────────────
  console.log('📋 Initialization state:');
  console.log('  - _initialized:', specularEffect._initialized);
  console.log('  - _enabled:', specularEffect._enabled);
  console.log('  - params.enabled:', specularEffect.params?.enabled);

  if (!specularEffect._initialized) {
    console.error('❌ SpecularEffectV2 not initialized - initialize() was never called');
    console.groupEnd();
    return;
  }

  // ── 3. Shader compilation state ─────────────────────────────────────────
  console.log('🎨 Shader compilation state:');
  console.log('  - _realShaderCompiled:', specularEffect._realShaderCompiled);
  console.log('  - _shaderCompilePending:', specularEffect._shaderCompilePending);
  console.log('  - _shaderCompileFailures:', specularEffect._shaderCompileFailures);
  console.log('  - _lastShaderCompileError:', specularEffect._lastShaderCompileError);

  if (specularEffect._shaderCompileFailures > 0) {
    console.error('❌ Shader compilation failed', specularEffect._shaderCompileFailures, 'times');
    console.error('Last error:', specularEffect._lastShaderCompileError);
  }

  if (!specularEffect._realShaderCompiled && !specularEffect._shaderCompilePending) {
    console.error('❌ Shader never compiled and not pending - overlays may be broken');
  }

  if (specularEffect._pendingOverlays && specularEffect._pendingOverlays.length > 0) {
    console.warn('⚠️ There are', specularEffect._pendingOverlays.length, 'pending overlays waiting for shader compilation');
  }

  // ── 4. Overlay count and state ───────────────────────────────────────────
  console.log('📦 Overlay state:');
  console.log('  - _overlays.size:', specularEffect._overlays.size);
  console.log('  - Overlay count by floor:');

  const overlayByFloor = {};
  specularEffect._overlays.forEach((entry, tileId) => {
    const floor = entry.floorIndex;
    overlayByFloor[floor] = (overlayByFloor[floor] || 0) + 1;
  });
  console.table(overlayByFloor);

  if (specularEffect._overlays.size === 0) {
    console.warn('⚠️ No specular overlays created - populate() may not have found _Specular masks');
  }

  // ── 5. Shared uniforms ───────────────────────────────────────────────────
  console.log('🔧 Shared uniforms:');
  console.log('  - _sharedUniforms exists:', !!specularEffect._sharedUniforms);
  if (specularEffect._sharedUniforms) {
    console.log('  - uEffectEnabled value:', specularEffect._sharedUniforms.uEffectEnabled?.value);
    console.log('  - uSpecularIntensity value:', specularEffect._sharedUniforms.uSpecularIntensity?.value);
    console.log('  - uRoofMaskEnabled value:', specularEffect._sharedUniforms.uRoofMaskEnabled?.value);
  }

  // ── 6. Texture bindings (sample first overlay) ───────────────────────────
  if (specularEffect._overlays.size > 0) {
    const firstOverlay = specularEffect._overlays.values().next().value;
    if (firstOverlay && firstOverlay.material) {
      console.log('🖼️ First overlay material state:');
      console.log('  - material.visible:', firstOverlay.mesh?.visible);
      console.log('  - material.uniforms.uAlbedoMap value:', firstOverlay.material.uniforms.uAlbedoMap?.value);
      console.log('  - material.uniforms.uSpecularMap value:', firstOverlay.material.uniforms.uSpecularMap?.value);
      console.log('  - material.uniforms.uEffectEnabled value:', firstOverlay.material.uniforms.uEffectEnabled?.value);
    }
  }

  // ── 7. FloorRenderBus integration ─────────────────────────────────────────
  const renderBus = specularEffect._renderBus;
  console.log('🚌 FloorRenderBus state:');
  console.log('  - renderBus exists:', !!renderBus);
  if (renderBus) {
    const visibleFloors = renderBus._visibleFloors;
    console.log('  - _visibleFloors:', visibleFloors);
  }

  // ── 8. Health diagnostics ─────────────────────────────────────────────────
  console.log('🏥 Health diagnostics:');
  const health = specularEffect.getHealthDiagnostics();
  if (health) {
    console.log('  - floors:', health.floors);
    console.log('  - outdoorsSlots:', health.outdoorsSlots);
    console.log('  - overlayByFloor:', health.overlayByFloor);
    console.log('  - outdoorsFloorIdxHistogram:', health.outdoorsFloorIdxHistogram);
    console.log('  - wetCloudOutdoorFactor:', health.wetCloudOutdoorFactor);
    console.log('  - activeFloorOutdoors:', health.activeFloorOutdoors);
  } else {
    console.warn('⚠️ No health diagnostics available - render() may not have run yet');
  }

  // ── 9. Parameter state ───────────────────────────────────────────────────
  console.log('⚙️ Key parameters:');
  console.log('  - textureStatus:', specularEffect.params?.textureStatus);
  console.log('  - intensity:', specularEffect.params?.intensity);
  console.log('  - stripeEnabled:', specularEffect.params?.stripeEnabled);
  console.log('  - outdoorCloudSpecularEnabled:', specularEffect.params?.outdoorCloudSpecularEnabled);
  console.log('  - wetSpecularEnabled:', specularEffect.params?.wetSpecularEnabled);

  // ── 10. Scene context ─────────────────────────────────────────────────────
  console.log('🌐 Scene context:');
  console.log('  - canvas.scene exists:', !!canvas?.scene);
  console.log('  - scene tiles count:', canvas?.scene?.tiles?.contents?.length || 0);
  console.log('  - activeLevelContext:', window.MapShine?.activeLevelContext);
  console.log('  - floorStack active floor:', window.MapShine?.floorStack?.getActiveFloor?.());

  // ── 11. WeatherController roof map ───────────────────────────────────────
  const weatherController = window.MapShine?.weatherController;
  console.log('🌤️ WeatherController state:');
  console.log('  - weatherController exists:', !!weatherController);
  console.log('  - roofMap exists:', !!weatherController?.roofMap);
  if (weatherController?.roofMap) {
    console.log('  - roofMap.isRenderTarget:', weatherController.roofMap.isRenderTarget);
    console.log('  - roofMap.width:', weatherController.roofMap.width);
    console.log('  - roofMap.height:', weatherController.roofMap.height);
  }

  // ── 12. Fallback textures ────────────────────────────────────────────────
  console.log('🎭 Fallback textures:');
  console.log('  - _fallbackBlack exists:', !!specularEffect._fallbackBlack);
  console.log('  - _fallbackWhite exists:', !!specularEffect._fallbackWhite);

  // ── 13. Light tracking ────────────────────────────────────────────────────
  console.log('💡 Light tracking:');
  console.log('  - _lights.size:', specularEffect._lights.size);
  console.log('  - Hook IDs registered:', Object.keys(specularEffect._hookIds || {}).length);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('📊 Summary:');
  const issues = [];

  if (!specularEffect._initialized) issues.push('Not initialized');
  if (!specularEffect._realShaderCompiled && !specularEffect._shaderCompilePending) issues.push('Shader not compiled');
  if (specularEffect._shaderCompileFailures > 0) issues.push('Shader compilation failed');
  if (!specularEffect._enabled || !specularEffect.params?.enabled) issues.push('Effect disabled');
  if (specularEffect._overlays.size === 0) issues.push('No overlays created');
  if (!specularEffect._sharedUniforms) issues.push('No shared uniforms');
  if (!weatherController?.roofMap) issues.push('No roof map (outdoors mask missing)');

  if (issues.length === 0) {
    console.log('✅ No obvious issues detected - specular should be working');
  } else {
    console.error('❌ Issues detected:', issues);
  }

  console.groupEnd();

  return {
    initialized: specularEffect._initialized,
    enabled: specularEffect._enabled,
    shaderCompiled: specularEffect._realShaderCompiled,
    shaderPending: specularEffect._shaderCompilePending,
    shaderFailures: specularEffect._shaderCompileFailures,
    overlayCount: specularEffect._overlays.size,
    issues,
    health,
  };
};

console.log('💡 Specular diagnostic probe loaded. Run window.MapShine.specularDiagnosticProbe() to diagnose.');
