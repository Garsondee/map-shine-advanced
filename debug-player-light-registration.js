// Debug PlayerLightEffect registration
console.log("=== PLAYER LIGHT REGISTRATION DEBUG ===");

const sceneComposer = window.MapShine?.sceneComposer;
const effectComposer = sceneComposer?.effectComposer || window.MapShine?.effectComposer;

console.log("EffectComposer found:", !!effectComposer);
if (effectComposer) {
  console.log("Effects map size:", effectComposer.effects.size);
  console.log("All registered effects:", Array.from(effectComposer.effects.keys()));
  console.log("Capabilities tier:", effectComposer.capabilities?.tier);
  
  // Check if player-light is in the effects
  console.log("player-light in effects:", effectComposer.effects.has('player-light'));
  
  // Try to get the effect
  const playerLight = effectComposer.effects.get('player-light');
  console.log("player-light effect:", playerLight);
}

// Check sceneComposer effects as fallback
if (sceneComposer?.effects) {
  console.log("\nSceneComposer effects array length:", sceneComposer.effects.length);
  const playerFromScene = sceneComposer.effects.find(e => e.constructor.name === 'PlayerLightEffect');
  console.log("PlayerLightEffect found in sceneComposer.effects:", !!playerFromScene);
  if (playerFromScene) {
    console.log("PlayerLightEffect id:", playerFromScene.id);
    console.log("PlayerLightEffect enabled:", playerFromScene.enabled);
  }
}

// Check window.MapShine reference
console.log("\nwindow.MapShine.playerLightEffect:", !!window.MapShine?.playerLightEffect);

console.log("=== END REGISTRATION DEBUG ===");
