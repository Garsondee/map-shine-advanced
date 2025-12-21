// Check what effects are actually registered and find LightingEffect
const sceneComposer = window.MapShine?.sceneComposer;

if (sceneComposer) {
  console.log("=== SCENE COMPOSER STATUS ===");
  console.log("Effects registered:", sceneComposer.effects.size);
  
  console.log("\n=== ALL REGISTERED EFFECTS ===");
  sceneComposer.effects.forEach((effect, id) => {
    console.log(`- ${id}: ${effect.constructor.name} (enabled: ${effect.enabled})`);
    if (effect.errorState) {
      console.log(`  ERROR: ${effect.errorState}`);
    }
  });
  
  // Look for LightingEffect specifically
  const lightingEffect = sceneComposer.effects.get('lighting');
  if (lightingEffect) {
    console.log("\n=== LIGHTING EFFECT FOUND ===");
    console.log("ID:", lightingEffect.id);
    console.log("Enabled:", lightingEffect.enabled);
    console.log("Error State:", lightingEffect.errorState);
  } else {
    console.log("\n=== LIGHTING EFFECT NOT FOUND ===");
    console.log("Checking if it was registered with different ID...");
    
    // Search all effects for LightingEffect class
    let found = false;
    sceneComposer.effects.forEach((effect, id) => {
      if (effect.constructor.name === 'LightingEffect') {
        console.log(`Found LightingEffect with ID: ${id}`);
        found = true;
      }
    });
    
    if (!found) {
      console.log("LightingEffect not registered at all");
    }
  }
} else {
  console.log("SceneComposer not found");
}
