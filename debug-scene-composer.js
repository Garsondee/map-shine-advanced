// Check SceneComposer structure and initialization
const sceneComposer = window.MapShine?.sceneComposer;

if (sceneComposer) {
  console.log("=== SCENE COMPOSER FOUND ===");
  console.log("SceneComposer object:", sceneComposer);
  console.log("Available properties:", Object.keys(sceneComposer));
  
  // Check for effectComposer
  if (sceneComposer.effectComposer) {
    console.log("\n=== EFFECT COMPOSER FOUND ===");
    console.log("Effects:", sceneComposer.effectComposer.effects);
    console.log("Effects size:", sceneComposer.effectComposer.effects?.size);
  } else {
    console.log("\n=== EFFECT COMPOSER NOT FOUND ===");
    console.log("Looking for alternative effects location...");
    
    // Check if effects are directly on sceneComposer
    if (sceneComposer.effects) {
      console.log("Found effects directly on sceneComposer");
    } else {
      console.log("No effects found anywhere");
    }
  }
  
  // Check MapShine global for lightingEffect
  if (window.MapShine.lightingEffect) {
    console.log("\n=== LIGHTING EFFECT FOUND IN GLOBAL ===");
    console.log("LightingEffect:", window.MapShine.lightingEffect);
    console.log("Enabled:", window.MapShine.lightingEffect.enabled);
  } else {
    console.log("\n=== LIGHTING EFFECT NOT FOUND IN GLOBAL ===");
  }
} else {
  console.log("SceneComposer not found - checking MapShine structure");
  console.log("MapShine object:", window.MapShine);
  console.log("MapShine properties:", Object.keys(window.MapShine || {}));
}
