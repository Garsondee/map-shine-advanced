// Map Shine Vision Debug Snippet
(async () => {
  console.group("Map Shine Vision Debug");

  // 1. Check Vision Sources
  console.log("--- Foundry Vision Sources ---");
  const v11Sources = canvas.effects?.visionSources;
  const v12Sources = canvas.visibility?.visionSources;
  
  console.log("v11 sources (canvas.effects):", v11Sources);
  console.log("v12 sources (canvas.visibility):", v12Sources);
  
  let activeSources = [];
  if (v11Sources) activeSources = Array.from(v11Sources.values ? v11Sources.values() : v11Sources);
  else if (v12Sources) activeSources = Array.from(v12Sources.contents ? v12Sources.contents : v12Sources);
  
  console.log(`Found ${activeSources.length} sources in standard collections.`);
  activeSources.forEach((s, i) => {
    console.log(`Source ${i}:`, {
      active: s.active,
      disabled: s.disabled,
      radius: s.radius,
      shape: s.shape,
      objectVisible: s.object?.visible,
      documentHidden: s.object?.document?.hidden
    });
  });

  // 2. Check Tokens Fallback
  console.log("--- Token Fallback Check ---");
  const tokens = canvas.tokens?.placeables || [];
  const sightTokens = tokens.filter(t => t.hasSight);
  console.log(`Total Tokens: ${tokens.length}, With Sight: ${sightTokens.length}`);
  
  sightTokens.forEach(t => {
    const s = t.vision;
    console.log(`Token ${t.name} Vision Source:`, {
      active: s?.active,
      radius: s?.radius,
      hasShape: !!s?.shape,
      points: s?.shape?.points?.length
    });
  });

  // 3. Check Map Shine Internal State
  console.log("--- Map Shine Internals ---");
  const ms = window.MapShine;
  if (!ms) {
    console.error("MapShine global not found!");
    return;
  }
  
  console.log("VisionManager:", ms.visionManager);
  if (ms.visionManager) {
    console.log("Needs Update:", ms.visionManager.needsUpdate);
    // Inspect the render target texture if possible (requires WebGL context read which is hard in console)
  }
  
  console.log("FogEffect:", ms.fogEffect);
  if (ms.fogEffect && ms.fogEffect.material) {
    console.log("Fog Uniforms:", {
      uBypassFog: ms.fogEffect.material.uniforms.uBypassFog.value,
      tVision: ms.fogEffect.material.uniforms.tVision.value,
      tDiffuse: ms.fogEffect.material.uniforms.tDiffuse.value
    });
  }
  
  console.log("Selection:", ms.interactionManager?.selection);

  // 4. Force Update Test
  console.log("--- Attempting Forced Update ---");
  if (ms.visionManager) {
    ms.visionManager.needsUpdate = true;
    ms.visionManager.update();
    console.log("Triggered VisionManager.update()");
  }

  console.groupEnd();
})();
