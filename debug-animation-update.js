// Test animation update specifically for wave and fairy lights
const lightingEffect = window.MapShine?.lightingEffect;

if (lightingEffect) {
  console.log("=== TESTING ANIMATION UPDATE ===");
  
  // Find wave and fairy lights
  let waveLight = null;
  let fairyLight = null;
  
  lightingEffect.lights.forEach((light, id) => {
    const opts = light._getAnimationOptions();
    if (opts.type === 'wave') waveLight = light;
    if (opts.type === 'fairy') fairyLight = light;
  });
  
  if (waveLight) {
    console.log("Testing WAVE light:");
    const opts = waveLight._getAnimationOptions();
    console.log(`  Options:`, opts);
    
    // Test with different time values
    for (let t = 0; t < 5000; t += 1000) {
      const result = waveLight.animateWave(t, opts);
      console.log(`  t=${t}: pulse=${result.pulse.toFixed(3)}, ratio=${result.ratioPulse.toFixed(3)}`);
    }
    
    // Test actual updateAnimation call
    console.log("  Before updateAnimation:", {
      intensity: waveLight.material.uniforms.uIntensity.value,
      time: waveLight.material.uniforms.uTime.value
    });
    
    waveLight.updateAnimation({ delta: 0.016, elapsed: 2.0 }, 0);
    
    console.log("  After updateAnimation:", {
      intensity: waveLight.material.uniforms.uIntensity.value,
      time: waveLight.material.uniforms.uTime.value
    });
  }
  
  if (fairyLight) {
    console.log("\nTesting FAIRY light:");
    const opts = fairyLight._getAnimationOptions();
    console.log(`  Options:`, opts);
    
    // Test with different time values
    for (let t = 0; t < 5000; t += 1000) {
      const result = fairyLight.animateFairy(t, opts);
      console.log(`  t=${t}: pulse=${result.pulse.toFixed(3)}, ratio=${result.ratioPulse.toFixed(3)}`);
    }
    
    // Test actual updateAnimation call
    console.log("  Before updateAnimation:", {
      intensity: fairyLight.material.uniforms.uIntensity.value,
      time: fairyLight.material.uniforms.uTime.value
    });
    
    fairyLight.updateAnimation({ delta: 0.016, elapsed: 2.0 }, 0);
    
    console.log("  After updateAnimation:", {
      intensity: fairyLight.material.uniforms.uIntensity.value,
      time: fairyLight.material.uniforms.uTime.value
    });
  }
}
