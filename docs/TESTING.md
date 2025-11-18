# Map Shine Advanced - Testing Guide

## Testing the Specular Effect (v0.2)

This guide will help you test the basic specular effect implementation.

### Prerequisites

1. **Foundry VTT** installed and running (v13+)
2. **Test battlemap with specular mask** (see below for creating one)

### Installation

1. Copy the `map-shine-advanced` folder to your Foundry `Data/modules/` directory
2. Restart Foundry VTT
3. Enable Map Shine Advanced in your world settings

### Creating a Test Battlemap

You need a battlemap image with a specular mask:

1. **Base texture**: `TestMap.png` (your battlemap)
2. **Specular mask**: `TestMap_Specular.png` (black and white image)
   - White areas = specular highlights (shiny/metallic)
   - Black areas = no specular (matte)
   - Gray areas = partial specular

Example specular mask workflow in Photoshop/GIMP:
- Start with a copy of your base map
- Paint white over metallic surfaces (armor, weapons, water, wet stone)
- Paint white over glossy surfaces (polished wood, glass, ice)
- Leave matte surfaces (cloth, dry stone, dirt) as black
- Save as `TestMap_Specular.png`

### Enabling Map Shine for a Scene

1. Import your test battlemap into a Foundry scene
2. Open the browser console (F12)
3. Run this command to enable Map Shine:

```javascript
// Enable Map Shine for current scene
const scene = game.scenes.current;
await scene.setFlag('map-shine-advanced', 'enabled', true);

// Reload the scene
await scene.view();
```

### What You Should See

If everything is working:

1. **Console logs**:
   - "Map Shine Advanced | Initializing..."
   - "AssetLoader | Loading asset bundle: [your map path]"
   - "SceneComposer | Scene composer initialized with X effect masks"
   - "SpecularEffect | Specular mask loaded, creating PBR material"
   - "RenderLoop | Starting render loop"
   - Periodic FPS updates

2. **Visual result**:
   - Your battlemap should render in the canvas
   - Areas painted white in the specular mask should have shiny highlights
   - Highlights should respond to the default top-down lighting

### Troubleshooting

#### "No specular mask found, effect will have no visible result"
- Ensure your specular mask file is named correctly: `[BaseMapName]_Specular.png`
- Place it in the same directory as your base map
- Supported formats: PNG, WebP, JPG

#### "MapShine not initialized"
- Check console for errors during module initialization
- Try refreshing the page (F5)
- Check that three.js loaded correctly

#### No visual difference
- Your specular mask might be all black (no shiny areas)
- Try painting some test areas in bright white
- Check console logs to verify the mask was loaded

### Testing Tweaks

You can adjust effect parameters in the console:

```javascript
// Get the effect composer
const composer = window.MapShine.effectComposer;

// Find the specular effect
const specular = Array.from(composer.effects.values())
  .find(e => e.id === 'specular');

// Adjust parameters
specular.params.intensity = 2.0;  // Increase specular intensity
specular.params.roughness = 0.2;  // Make surface smoother (0=mirror, 1=rough)
specular.params.ambientIntensity = 0.5; // Increase ambient light

// Adjust light direction (x, y, z)
specular.params.lightDirection = { x: 1, y: 0, z: 1 };
```

### Performance Monitoring

Check FPS in console (logged every 5 seconds):
```
Canvas | FPS: 60, Frames: 1234
```

Target: 30+ FPS for smooth experience

### Disabling Map Shine

To disable Map Shine for a scene:

```javascript
const scene = game.scenes.current;
await scene.setFlag('map-shine-advanced', 'enabled', false);
await scene.view();
```

### Next Steps After Testing

Once basic specular effect works:

1. Test with different specular mask patterns
2. Test with optional roughness mask (`TestMap_Roughness.png`)
3. Test with normal map (`TestMap_Normal.png`)
4. Test scene switching (enable for some scenes, disable for others)
5. Test performance on different GPU tiers

### Reporting Issues

When reporting issues, include:

1. Console logs (especially errors)
2. Browser and version
3. Foundry VTT version
4. GPU information (chrome://gpu in Chrome/Edge)
5. Steps to reproduce
6. Screenshot if visual issue

### Known Limitations (v0.2)

- No UI controls yet (must use console to tweak parameters)
- No normal map support yet (lighting is simplified)
- No roughness map derivation yet (uses default if missing)
- Fixed top-down lighting only
- No fog of war integration yet
- No token rendering yet
