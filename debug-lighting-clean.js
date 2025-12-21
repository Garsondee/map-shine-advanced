// Clean debug snippet - single output to avoid console spam
// Run this in the browser console when in a scene with lights

(function() {
  const results = {
    lightingEffect: null,
    foundryLights: [],
    timeManager: null,
    test: null
  };
  
  // Check LightingEffect
  const lightingEffect = window.MapShine?.sceneComposer?.effects?.find(e => e.constructor.name === 'LightingEffect');
  results.lightingEffect = {
    found: !!lightingEffect,
    lightsCount: lightingEffect?.lights?.size || 0,
    enabled: lightingEffect?.enabled || false
  };
  
  // Check Foundry lights
  if (canvas.lighting) {
    const lights = canvas.lighting.placeables;
    results.foundryLights = lights.map(light => {
      const anim = light.document.config?.animation;
      const mapShineLight = lightingEffect?.lights?.get(light.id);
      
      return {
        id: light.id,
        hasAnimation: !!anim,
        animationType: anim?.type || null,
        animationSpeed: anim?.speed || null,
        animationIntensity: anim?.intensity || null,
        mapShineLightExists: !!mapShineLight,
        baseRadius: mapShineLight?._baseRadiusPx || null
      };
    });
  }
  
  // Check TimeManager
  const timeManager = window.MapShine?.sceneComposer?.timeManager;
  if (timeManager) {
    const timeInfo = timeManager.getCurrentTime();
    results.timeManager = {
      found: true,
      elapsed: timeInfo.elapsed,
      delta: timeInfo.delta,
      frameCount: timeInfo.frameCount,
      paused: timeInfo.paused
    };
  } else {
    results.timeManager = { found: false };
  }
  
  // Quick test
  if (canvas.lighting && lightingEffect) {
    const testLight = canvas.lighting.placeables.find(l => !l.document.config?.animation);
    if (testLight) {
      results.test = { available: true };
    } else {
      results.test = { available: false, reason: "All lights have animations or no lights found" };
    }
  } else {
    results.test = { available: false, reason: "No lighting system found" };
  }
  
  // Single clean output
  console.table(results.foundryLights);
  console.log("=== LIGHTING DEBUG RESULTS ===");
  console.log("LightingEffect:", results.lightingEffect);
  console.log("TimeManager:", results.timeManager);
  console.log("Test:", results.test);
  
  return results;
})();
