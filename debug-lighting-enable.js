// Check if LightingEffect has an error and re-enable it
const lightingEffect = window.MapShine?.sceneComposer?.effects?.find(e => e.constructor.name === 'LightingEffect');

if (lightingEffect) {
  console.log("=== LIGHTING EFFECT STATUS ===");
  console.log("Enabled:", lightingEffect.enabled);
  console.log("Error State:", lightingEffect.errorState);
  console.log("Error Time:", lightingEffect.errorTime);
  console.log("User Notified:", lightingEffect._userNotified);
  console.log("Params enabled:", lightingEffect.params?.enabled);
  
  // If disabled due to error, try to re-enable
  if (!lightingEffect.enabled && lightingEffect.errorState) {
    console.log("Attempting to re-enable LightingEffect...");
    lightingEffect.enabled = true;
    lightingEffect.errorState = null;
    lightingEffect.errorTime = null;
    lightingEffect._userNotified = false;
    console.log("LightingEffect re-enabled");
    
    // Force sync lights
    lightingEffect.syncAllLights();
  }
} else {
  console.log("LightingEffect not found in effects list");
}
