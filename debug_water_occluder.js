// === WATER OCCLUDER DIAGNOSTIC ===
// Paste this into the browser console on a map with a tile selected.
// It will dump everything needed to see why a tile’s _Water mask isn’t punching through water.

(() => {
  const tileManager = window.MapShine?.tileManager;
  const sceneComposer = window.MapShine?.sceneComposer;
  const distortionManager = window.MapShine?.distortionManager;
  const composer = window.MapShine?.effectComposer;

  const resolveEffect = (effects, id) => {
    if (!effects || !id) return null;

    // Map<string, EffectBase>
    if (typeof effects.get === 'function') {
      return effects.get(id) || null;
    }

    // Array<EffectBase>
    if (Array.isArray(effects)) {
      return effects.find((e) => e?.id === id) || null;
    }

    // Plain object { [id]: effect }
    if (typeof effects === 'object') {
      return effects[id] || null;
    }

    return null;
  };

  const waterEffect = resolveEffect(composer?.effects, 'water');

  if (!tileManager || !sceneComposer) {
    console.error('❌ MapShine core not available.');
    return;
  }

  // 1) Get the currently selected tile in Foundry
  const selected = canvas?.tiles?.controlled;
  if (!selected || selected.length === 0) {
    console.error('❌ No tile selected. Select a tile in the Foundry UI and run again.');
    return;
  }
  const tile = selected[0];
  const tileDoc = tile.document;

  console.group('🔍 Water Occluder Diagnostic for Tile:', tileDoc.id);

  // 2) Basic tile info
  console.log('📄 Tile Document:', {
    id: tileDoc.id,
    name: tileDoc.name,
    src: tileDoc.texture?.src,
    width: tileDoc.width,
    height: tileDoc.height,
    x: tileDoc.x,
    y: tileDoc.y,
    elevation: tileDoc.elevation,
    alpha: tileDoc.alpha,
    hidden: tileDoc.hidden
  });

  // 3) Flags: occludesWater?
  const moduleId = 'map-shine-advanced';
  const occludesWaterFlag = tileDoc.getFlag(moduleId, 'occludesWater');
  console.log('🚩 Flags:', {
    'map-shine-advanced.occludesWater': occludesWaterFlag,
    evaluated: occludesWaterFlag === undefined ? false : !!occludesWaterFlag
  });

  // 4) Sprite userData
  const spriteData = tileManager.tileSprites.get(tileDoc.id);
  const sprite = spriteData?.sprite;
  if (sprite) {
    console.log('🎭 Sprite userData:', {
      occludesWater: sprite.userData.occludesWater,
      isOverhead: sprite.userData.isOverhead,
      isWeatherRoof: sprite.userData.isWeatherRoof,
      visible: sprite.visible,
      layers: sprite.layers.mask
    });
  } else {
    console.warn('⚠️ No THREE.Sprite found for this tile in TileManager.');
  }

  // 5) Water mask texture path and load status
  const deriveMaskPath = (src, suffix) => {
    const s = String(src || '');
    if (!s) return null;
    const q = s.indexOf('?');
    const base = q >= 0 ? s.slice(0, q) : s;
    const query = q >= 0 ? s.slice(q) : '';
    const dot = base.lastIndexOf('.');
    if (dot < 0) return null;
    const path = base.slice(0, dot);
    const ext = base.slice(dot);
    return `${path}${suffix}${ext}${query}`;
  };
  const maskPath = deriveMaskPath(tileDoc.texture?.src, '_Water');
  console.log('🖼️ Expected _Water mask path:', maskPath);

  // 6) Check if mask is cached
  const cachedMask = maskPath ? tileManager._tileWaterMaskCache.get(maskPath) : null;
  console.log('💾 Cached mask texture:', cachedMask ? '✅ loaded' : '❌ not cached');

  // 7) Water occluder mesh presence
  const occluderMesh = sprite?.userData?.waterOccluderMesh;
  if (occluderMesh) {
    console.log('🧊 Occluder mesh:', {
      visible: occluderMesh.visible,
      layers: occluderMesh.layers.mask,
      material: occluderMesh.material?.type,
      uniforms: occluderMesh.material?.uniforms ? {
        tTile: !!occluderMesh.material.uniforms.tTile?.value,
        uHasTile: occluderMesh.material.uniforms.uHasTile?.value,
        tWaterMask: !!occluderMesh.material.uniforms.tWaterMask?.value,
        uHasWaterMask: occluderMesh.material.uniforms.uHasWaterMask?.value,
        uOpacity: occluderMesh.material.uniforms.uOpacity?.value
      } : 'no uniforms'
    });
  } else {
    console.warn('⚠️ No water occluder mesh found for this sprite.');
  }

  // 8) DistortionManager waterOccluderTarget
  if (distortionManager) {
    console.log('🌊 DistortionManager waterOccluderTarget:', distortionManager.waterOccluderTarget ? '✅ exists' : '❌ missing');
    if (distortionManager.waterOccluderTarget) {
      console.log('   size:', distortionManager.waterOccluderTarget.width, 'x', distortionManager.waterOccluderTarget.height);
    }
  } else {
    console.warn('⚠️ DistortionManager not available.');
  }

  // 9) WaterEffectV2 uniforms
  if (waterEffect) {
    const u = waterEffect._material?.uniforms;
    if (u) {
      console.log('💧 WaterEffectV2 uniforms:', {
        tWaterOccluderAlpha: !!u.tWaterOccluderAlpha?.value,
        uHasWaterOccluderAlpha: u.uHasWaterOccluderAlpha?.value,
        uDebugView: u.uDebugView?.value
      });
    } else {
      console.warn('⚠️ WaterEffectV2 material/uniforms not available.');
    }
  } else {
    console.warn('⚠️ WaterEffectV2 not found in effectComposer.');
  }

  // 10) Quick sanity check: try to load the mask manually and log first pixel
  if (maskPath) {
    fetch(maskPath)
      .then(r => r.blob())
      .then(blob => createImageBitmap(blob))
      .then(bitmap => {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.canvas.width = 1;
        ctx.canvas.height = 1;
        ctx.drawImage(bitmap, 0, 0, 1, 1);
        const pixel = ctx.getImageData(0, 0, 1, 1).data;
        console.log('🎨 First pixel of _Water mask (RGBA):', pixel);
        const lum = 0.299 * pixel[0] + 0.587 * pixel[1] + 0.114 * pixel[2];
        console.log('   Luminance (0-255):', lum.toFixed(2));
        console.log('   Expected mask value (luminance * alpha):', (lum * pixel[3] / 255).toFixed(2));
      })
      .catch(e => console.warn('⚠️ Could not fetch/decode mask image:', e));
  }

  console.groupEnd();
})();
