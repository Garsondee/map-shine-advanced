![](https://img.shields.io/badge/Foundry-v13-informational)

# Map Shine Advanced

Map Shine Advanced is a Foundry VTT module that brings a Three.js-based renderer to Foundry with a focus on cinematic 2.5D battlemaps: PBR-style surface shading, mask-driven effects, particles, and a modern post-processing pipeline.

- **Repo**: https://github.com/Garsondee/map-shine-advanced
- **Status**: `0.2.0-dev` (active development)

## What this module does

- **Renders the scene in Three.js** while Foundry continues to provide game logic + UI.
- **Syncs Foundry documents** (tokens, tiles, walls, drawings, notes, templates, lights) into Three.js managers.
- **Uses a suffix-based texture system** so map authors can provide extra masks like `_Specular`, `_Outdoors`, `_Windows`, etc.

## Compatibility

- **Foundry VTT**: v13 (minimum/verified/maximum currently set to 13)

## Installation

Install using the manifest URL:

```text
https://github.com/Garsondee/map-shine-advanced/releases/latest/download/module.json
```

## Quick start

1. Install and enable the module.
2. Open a Scene.
3. Open the Map Shine panel:
   - In the Scene Controls (Tokens), click **Map Shine UI**.
4. In the panel, enable Map Shine for the current scene.

### Gameplay mode vs Map Maker mode

Map Shine supports a hybrid workflow:

- **Gameplay Mode**
  - Three.js is responsible for most rendering and gameplay interactions.
  - The Foundry canvas remains available for UI and tooling, but is configured as a transparent overlay.

- **Map Maker Mode**
  - Toggle **Map Maker Mode** in the Map Shine panel.
  - Intended for using native Foundry tools (walls, lights, drawings, regions, etc.) without fighting the Three.js interaction model.

## Map authoring: suffix-based masks

Map Shine discovers masks by searching for sibling files next to your scene background image. Use the same base filename as your background, plus a suffix.

Example (if your background is `MyMap.webp`):

- `MyMap_Specular.webp`
- `MyMap_Roughness.webp`
- `MyMap_Normal.webp`
- `MyMap_Outdoors.webp`
- `MyMap_Windows.webp`

Supported formats:

- `webp`
- `png`
- `jpg` / `jpeg`

### Currently recognized suffixes

These are the masks currently discovered by the loader (`scripts/assets/loader.js`):

- **`_Specular`**: Specular highlights mask
- **`_Roughness`**: Roughness map
- **`_Normal`**: Normal map
- **`_Iridescence`**: Iridescence mask
- **`_Prism`**: Prism/refraction mask
- **`_Outdoors`**: Indoor/outdoor mask (used for roof/indoor logic)
- **`_Windows`**: Window lighting mask
- **`_Structural`**: Legacy structural/window mask fallback
- **`_Fire`**: Fire placement mask
- **`_Dust`**: Dust motes placement mask
- **`_Bush`**: Animated bush texture (RGBA)
- **`_Tree`**: Animated tree canopy texture

## Features (current)

### Core rendering & syncing

- **Three.js scene rendering** with a dedicated render loop.
- **TokenManager**: token sprites synced from Foundry.
- **TileManager**: tiles synced from Foundry, including overhead/roof tiles.
- **WallManager**: walls synced and rendered in Three.js.
- **DoorMeshManager**: Three.js door meshes.
- **GridRenderer**: grid rendering based on Foundry grid settings.
- **DrawingManager**, **NoteManager**, **TemplateManager**, **LightIconManager**: Three.js counterparts for common Foundry overlays.
- **MapPointsManager**: v1.x map points compatibility and effect wiring.

### Effects & post processing

Registered effects are orchestrated through `EffectComposer` (`scripts/effects/EffectComposer.js`). Current notable effects include:

- **LightingEffect**: screen-space lighting composition.
- **WorldSpaceFogEffect**: Fog of War rendered as a world-space plane with Foundry vision/exploration textures.
- **SpecularEffect**: mask-driven specular surface shading.
- **IridescenceEffect**: additive iridescent overlay.
- **PrismEffect**: masked refraction/prism look.
- **WindowLightEffect**: interior window light pools driven by `_Windows` / `_Structural`.
- **OverheadShadowsEffect**: roof/overhead shadowing.
- **BuildingShadowsEffect**: long shadows derived from `_Outdoors`.
- **CloudEffect**: procedural cloud shadows.
- **SkyColorEffect**: outdoor grading driven by `WeatherController` time/weather.
- **ColorCorrectionEffect**, **BloomEffect**, **LensflareEffect**, **AsciiEffect**.
- **DistortionManager**: centralized distortion composition (heat haze, etc.).

### Particles

- **ParticleSystem**: shared particle backend.
- **FireSparksEffect**: mask-driven fire placement (and map-points driven fire/candle sources).
- **SmellyFliesEffect**: map-points driven “smart particles”.
- **DustMotesEffect**: dust motes (mask-driven), with planned coupling to window light.

### Weather state

- **WeatherController** provides shared global state (precipitation, cloud cover, wind, time-of-day) and drives multiple effects.

## Roadmap (planned)

This is a high-level summary of the current planning documents in `docs/`.

- **Cloud system expansion**
  - Spatial window dimming based on cloud shadows
  - Sky reflections on specular surfaces
  - Zoom-dependent cloud tops

- **Wall-aware lighting**
  - Mesh-based light polygons derived from Foundry visibility polygons
  - Light accumulation buffer + composition pass

- **Vision-driven early discard / performance culling**
  - Centralized visibility texture for early fragment discard across expensive effects

- **Smart particles + editing**
  - Three.js-native map points authoring tools (interactive placement, dragging, areas)
  - More effect types powered by map points (steam, lightning, etc.)

## Development

### Building the custom Three.js bundle

This repo uses an esbuild step to generate a custom Three.js bundle used by Foundry:

```text
npm install
npm run build:tsl
```

That produces:

```text
scripts/vendor/three/three.custom.js
```

## Troubleshooting

- **Nothing renders / black screen**
  - Check the browser console for capability errors. The module requires WebGL.

- **Effects look like they do nothing**
  - Many effects default to subtle settings (some are intentionally `0` intensity until enabled).

- **My masks aren’t detected**
  - Ensure the mask files are in the same directory as the background.
  - Ensure the base filename matches exactly and the suffix is correct.

## License

See `LICENSE`.
