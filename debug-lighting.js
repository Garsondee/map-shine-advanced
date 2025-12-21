// Debug snippet to inspect light setup and animation data
// Run this in the browser console when in a scene with lights

console.log("=== LIGHTING DEBUG ===");

// Check if MapShine lighting system is active
const lightingEffect = window.MapShine?.sceneComposer?.effects?.find(e => e.constructor.name === 'LightingEffect');
console.log("LightingEffect found:", !!lightingEffect);
if (lightingEffect) {
  console.log("LightingEffect lights count:", lightingEffect.lights?.size || 0);
  console.log("LightingEffect enabled:", lightingEffect.enabled);
}

// Check Foundry lights
if (canvas.lighting) {
  console.log("\n=== FOUNDRY LIGHTS ===");
  const lights = canvas.lighting.placeables;
  console.log("Total Foundry lights:", lights.length);
  
  lights.forEach((light, index) => {
    console.log(`\n--- Light ${index + 1} (ID: ${light.id}) ---`);
    console.log("Position:", light.document.x, light.document.y);
    console.log("Config:", light.document.config);
    
    // Check animation config specifically
    const anim = light.document.config?.animation;
    if (anim) {
      console.log("Animation config:", anim);
      console.log("Animation type:", anim.type);
      console.log("Animation speed:", anim.speed);
      console.log("Animation intensity:", anim.intensity);
      console.log("Animation reverse:", anim.reverse);
    } else {
      console.log("No animation config found");
    }
    
    // Check if MapShine has a corresponding light
    const mapShineLight = lightingEffect?.lights?.get(light.id);
    if (mapShineLight) {
      console.log("MapShine light found:", true);
      console.log("MapShine light base radius:", mapShineLight._baseRadiusPx);
      console.log("MapShine light material uniforms:", mapShineLight.material?.uniforms);
    } else {
      console.log("MapShine light NOT found");
    }
  });
} else {
  console.log("No canvas.lighting found");
}

// Check TimeManager
const timeManager = window.MapShine?.sceneComposer?.getTimeManager();
if (timeManager) {
  console.log("\n=== TIME MANAGER ===");
  console.log("TimeManager found:", true);
  console.log("Current timeInfo:", {
    elapsed: timeManager.getCurrentTime().elapsed,
    delta: timeManager.getCurrentTime().delta,
    frameCount: timeManager.getCurrentTime().frameCount,
    paused: timeManager.getCurrentTime().paused
  });
} else {
  console.log("\nNo TimeManager found");
}

// Test creating a simple animated light
console.log("\n=== TEST ANIMATED LIGHT CREATION ===");
if (canvas.lighting && lightingEffect) {
  // Find a light without animation to test with
  const testLight = canvas.lighting.placeables.find(l => !l.document.config?.animation);
  if (testLight) {
    console.log("Testing with light:", testLight.id);
    
    // Add animation config
    const originalConfig = testLight.document.config;
    testLight.document.config = {
      ...originalConfig,
      animation: {
        type: "torch",
        speed: 5,
        intensity: 5,
        reverse: false
      }
    };
    
    // Trigger update
    lightingEffect.onLightUpdate(testLight.document);
    console.log("Added torch animation to test light");
    
    // Check if it worked
    const updatedLight = lightingEffect.lights.get(testLight.id);
    if (updatedLight) {
      const animOpts = updatedLight._getAnimationOptions();
      console.log("Updated light animation options:", animOpts);
    }
    
    // Restore original config
    testLight.document.config = originalConfig;
    lightingEffect.onLightUpdate(testLight.document);
    console.log("Restored original config");
  } else {
    console.log("All lights already have animations or no lights found");
  }
}
