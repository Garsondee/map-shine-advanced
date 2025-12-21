// Find EffectComposer and register LightingEffect
const sceneComposer = window.MapShine?.sceneComposer;
const lightingEffect = window.MapShine?.lightingEffect;

if (sceneComposer && lightingEffect) {
  console.log("=== REGISTERING LIGHTING EFFECT ===");
  
  // Look for EffectComposer in various locations
  let effectComposer = null;
  
  // Check direct property
  if (sceneComposer.effectComposer) {
    effectComposer = sceneComposer.effectComposer;
    console.log("Found EffectComposer directly on sceneComposer");
  }
  
  // Check if SceneComposer IS the EffectComposer
  if (sceneComposer.effects && typeof sceneComposer.registerEffect === 'function') {
    effectComposer = sceneComposer;
    console.log("SceneComposer IS the EffectComposer");
  }
  
  // Check MapShine global
  if (!effectComposer && window.MapShine.effectComposer) {
    effectComposer = window.MapShine.effectComposer;
    console.log("Found EffectComposer in MapShine global");
  }
  
  if (effectComposer && typeof effectComposer.registerEffect === 'function') {
    console.log("Registering LightingEffect...");
    await effectComposer.registerEffect(lightingEffect);
    console.log("LightingEffect registered successfully!");
    
    // Verify registration
    const registeredEffect = effectComposer.effects.get('lighting');
    if (registeredEffect) {
      console.log("✓ LightingEffect is now registered and enabled");
    } else {
      console.log("✗ Registration failed - effect not found in effects list");
    }
  } else {
    console.log("EffectComposer not found or doesn't have registerEffect method");
    console.log("Available properties on sceneComposer:", Object.keys(sceneComposer));
    console.log("Available properties on MapShine:", Object.keys(window.MapShine || {}));
  }
} else {
  console.log("Missing sceneComposer or lightingEffect");
  console.log("sceneComposer:", !!sceneComposer);
  console.log("lightingEffect:", !!lightingEffect);
}
