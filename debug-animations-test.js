// Debug specific light animations
const lightingEffect = window.MapShine?.lightingEffect;

if (lightingEffect) {
  console.log("=== DEBUGGING ANIMATIONS ===");
  
  // Check each light's animation type and values
  lightingEffect.lights.forEach((light, id) => {
    const opts = light._getAnimationOptions();
    const uniforms = light.material.uniforms;
    
    console.log(`Light ${id}:`);
    console.log(`  Type: ${opts.type}`);
    console.log(`  Speed: ${opts.speed}, Intensity: ${opts.intensity}, Reverse: ${opts.reverse}`);
    console.log(`  uIntensity: ${uniforms.uIntensity.value.toFixed(3)}`);
    console.log(`  uBrightRadius: ${uniforms.uBrightRadius.value.toFixed(1)}`);
    console.log(`  uTime: ${uniforms.uTime.value.toFixed(3)}`);
    
    // Test animation methods directly
    if (opts.type === 'fairy') {
      console.log(`  Testing fairy animation...`);
      const result = light.animateFairy(1000, opts);
      console.log(`  Fairy result: pulse=${result.pulse.toFixed(3)}, ratio=${result.ratioPulse.toFixed(3)}`);
    } else if (opts.type === 'wave') {
      console.log(`  Testing wave animation...`);
      const result = light.animateWave(1000, opts);
      console.log(`  Wave result: pulse=${result.pulse.toFixed(3)}, ratio=${result.ratioPulse.toFixed(3)}`);
    }
    console.log('');
  });
  
  // Check if updateAnimation is being called
  console.log("=== TESTING UPDATE CALL ===");
  const testLight = lightingEffect.lights.values().next().value;
  if (testLight) {
    console.log("Before updateAnimation:");
    console.log(`  uIntensity: ${testLight.material.uniforms.uIntensity.value}`);
    console.log(`  uTime: ${testLight.material.uniforms.uTime.value}`);
    
    testLight.updateAnimation({ delta: 0.016, elapsed: 1.0 }, 0);
    
    console.log("After updateAnimation:");
    console.log(`  uIntensity: ${testLight.material.uniforms.uIntensity.value}`);
    console.log(`  uTime: ${testLight.material.uniforms.uTime.value}`);
  }
} else {
  console.log("LightingEffect not found");
}
