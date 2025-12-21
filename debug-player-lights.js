// Console snippet to debug PlayerLightEffect dynamic lights
// Run this in the browser console when Player Light is active

console.log("=== PLAYER LIGHT DEBUG ===");

// 1. Check if PlayerLightEffect is registered and active
const sceneComposer = window.MapShine?.sceneComposer;
const effectComposer = sceneComposer?.effectComposer || window.MapShine?.effectComposer;
const playerLightEffect = effectComposer?.effects?.get?.('playerLight') || sceneComposer?.effects?.find(e => e.constructor.name === 'PlayerLightEffect');

console.log("PlayerLightEffect found:", !!playerLightEffect);
if (playerLightEffect) {
  console.log("PlayerLightEffect enabled:", playerLightEffect.enabled);
  console.log("PlayerLightEffect mode:", playerLightEffect.params.mode);
  console.log("PlayerLightEffect torchLightEnabled:", playerLightEffect.params.torchLightEnabled);
  console.log("PlayerLightEffect flashlightLightEnabled:", playerLightEffect.params.flashlightLightEnabled);
}

// 2. Check if LightingEffect is available
const lightingEffect = window.MapShine?.lightingEffect;
console.log("\nLightingEffect found:", !!lightingEffect);
if (lightingEffect) {
  console.log("LightingEffect enabled:", lightingEffect.enabled);
  console.log("LightingEffect lightScene children count:", lightingEffect.lightScene?.children?.length || 0);
}

// 3. Check if player light sources exist and are in the scene
if (playerLightEffect) {
  console.log("\n=== TORCH LIGHT ===");
  const torchLight = playerLightEffect._torchLightSource;
  console.log("Torch light source exists:", !!torchLight);
  if (torchLight) {
    console.log("Torch mesh exists:", !!torchLight.mesh);
    console.log("Torch mesh visible:", torchLight.mesh?.visible);
    console.log("Torch mesh parent:", torchLight.mesh?.parent?.name || 'none');
    console.log("Torch mesh in lightScene:", lightingEffect?.lightScene?.children?.includes(torchLight.mesh) || false);
    console.log("Torch mesh layers:", torchLight.mesh?.layers?.mask);
    console.log("Torch mesh position:", torchLight.mesh?.position);
    console.log("Torch material uniforms:", torchLight.material?.uniforms);
    
    // Check if radius is zero
    const radius = torchLight.material?.uniforms?.uRadius?.value;
    console.log("Torch uRadius:", radius, (radius === 0 ? 'ZERO - LIGHT INVISIBLE' : 'OK'));
  }
  
  console.log("\n=== FLASHLIGHT LIGHT ===");
  const flashlightLight = playerLightEffect._flashlightLightSource;
  console.log("Flashlight light source exists:", !!flashlightLight);
  if (flashlightLight) {
    console.log("Flashlight mesh exists:", !!flashlightLight.mesh);
    console.log("Flashlight mesh visible:", flashlightLight.mesh?.visible);
    console.log("Flashlight mesh parent:", flashlightLight.mesh?.parent?.name || 'none');
    console.log("Flashlight mesh in lightScene:", lightingEffect?.lightScene?.children?.includes(flashlightLight.mesh) || false);
    console.log("Flashlight mesh layers:", flashlightLight.mesh?.layers?.mask);
    console.log("Flashlight mesh position:", flashlightLight.mesh?.position);
    console.log("Flashlight material uniforms:", flashlightLight.material?.uniforms);
    
    // Check if radius is zero
    const radius = flashlightLight.material?.uniforms?.uRadius?.value;
    console.log("Flashlight uRadius:", radius, (radius === 0 ? 'ZERO - LIGHT INVISIBLE' : 'OK'));
  }
}

// 4. Test forcing a light update
if (playerLightEffect && lightingEffect) {
  console.log("\n=== FORCING LIGHT UPDATE ===");
  try {
    const timeInfo = sceneComposer?.getTimeManager()?.getCurrentTime() || { elapsed: 0, delta: 0 };
    playerLightEffect._updateDynamicLightSources(timeInfo);
    console.log("Light update completed");
  } catch (e) {
    console.error("Error during light update:", e);
  }
}

// 5. Check camera layers during light render
if (lightingEffect && lightingEffect.mainCamera) {
  console.log("\n=== CAMERA LAYERS ===");
  console.log("Main camera layers mask:", lightingEffect.mainCamera.layers.mask);
  console.log("OVERLAY_THREE_LAYER enabled:", !!(lightingEffect.mainCamera.layers.mask & (1 << 31)));
  console.log("Default layer 0 enabled:", !!(lightingEffect.mainCamera.layers.mask & (1 << 0)));
}

// 6. Manual light target inspection
if (lightingEffect?.lightTarget) {
  console.log("\n=== LIGHT TARGET ===");
  console.log("Light target exists:", true);
  console.log("Light target size:", lightingEffect.lightTarget.width, 'x', lightingEffect.lightTarget.height);
  console.log("Light target texture:", lightingEffect.lightTarget.texture);
} else {
  console.log("\nLight target missing - LightingEffect may not be rendering");
}

console.log("\n=== END DEBUG ===");
