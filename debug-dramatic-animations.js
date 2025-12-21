// Test with more dramatic animation values
const lightingEffect = window.MapShine?.lightingEffect;

if (lightingEffect) {
  console.log("=== TESTING DRAMATIC ANIMATIONS ===");
  
  // Find wave and fairy lights
  let waveLight = null;
  let fairyLight = null;
  
  lightingEffect.lights.forEach((light, id) => {
    const opts = light._getAnimationOptions();
    if (opts.type === 'wave') waveLight = light;
    if (opts.type === 'fairy') fairyLight = light;
  });
  
  if (waveLight) {
    console.log("Testing WAVE with dramatic values:");
    
    // Test the current animation
    console.log("Current values:");
    for (let t = 0; t < 6000; t += 1000) {
      const result = waveLight.animateWave(t, { speed: 1, intensity: 3, reverse: false });
      console.log(`  t=${t}: pulse=${result.pulse.toFixed(3)}, ratio=${result.ratioPulse.toFixed(3)}`);
    }
    
    // Test with higher intensity for more visible effect
    console.log("\nHigh intensity values:");
    for (let t = 0; t < 6000; t += 1000) {
      const result = waveLight.animateWave(t, { speed: 1, intensity: 10, reverse: false });
      console.log(`  t=${t}: pulse=${result.pulse.toFixed(3)}, ratio=${result.ratioPulse.toFixed(3)}`);
    }
  }
  
  if (fairyLight) {
    console.log("\nTesting FAIRY with dramatic values:");
    
    // Test the current animation
    console.log("Current values:");
    for (let t = 0; t < 6000; t += 1000) {
      const result = fairyLight.animateFairy(t, { speed: 5, intensity: 10, reverse: false });
      console.log(`  t=${t}: pulse=${result.pulse.toFixed(3)}, ratio=${result.ratioPulse.toFixed(3)}`);
    }
    
    // Test with more dramatic shimmer
    console.log("\nMore dramatic shimmer:");
    for (let t = 0; t < 6000; t += 1000) {
      const result = fairyLight.animateFairy(t, { speed: 5, intensity: 10, reverse: false });
      console.log(`  t=${t}: pulse=${result.pulse.toFixed(3)}, ratio=${result.ratioPulse.toFixed(3)}`);
    }
  }
  
  // Check if the issue is that the light radius is too small to see changes
  console.log("\n=== LIGHT SIZES ===");
  lightingEffect.lights.forEach((light, id) => {
    const opts = light._getAnimationOptions();
    if (opts.type === 'wave' || opts.type === 'fairy') {
      console.log(`${id} (${opts.type}):`);
      console.log(`  Base radius: ${light._baseRadiusPx.toFixed(1)}px`);
      console.log(`  Bright radius: ${light._baseBrightRadiusPx.toFixed(1)}px`);
      console.log(`  Current intensity: ${light.material.uniforms.uIntensity.value.toFixed(3)}`);
      console.log(`  Current brightRadius: ${light.material.uniforms.uBrightRadius.value.toFixed(1)}px`);
    }
  });
}
