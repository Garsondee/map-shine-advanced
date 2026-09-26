![](https://img.shields.io/badge/Foundry-v14-informational)

# Map Shine Advanced

Map Shine Advanced is a Foundry VTT module that brings a Three.js-based renderer to Foundry with a focus on cinematic 2.5D battlemaps: PBR-style surface shading, mask-driven effects, particles, and a modern post-processing pipeline.

## What this module does

- **Renders the scene in Three.js** while Foundry continues to provide game logic + UI.
- **Syncs Foundry documents** (tokens, tiles, walls, drawings, notes, templates, lights) into Three.js managers.
- **Uses a suffix-based texture system** so map authors can provide extra masks like `_Specular`, `_Outdoors`, `_Windows`, etc.

## Installation

Install using the manifest URL:

```text
https://github.com/Garsondee/map-shine-advanced/releases/latest/download/module.json
```

## Quick start

1. Install and enable the module, then open a Scene. Map Shine renders it straight away; there is no per-scene switch to turn on.
2. The Map Shine tools live in the **Token controls** toolbar:
   - **MSA Remote** (GM, satellite dish) is the in-session control surface. It covers time of day, weather moods and faders, fade time, wind, Player Lights allowances, the cue deck and the camera path. It opens by itself for the GM.
   - **MSA Studio** (GM) is the authoring panel: an Effects department with one card per effect, plus Painter, Scene, Cues, System and Lab.
   - **MSA Anchor View** (GM) shows and toggles candle and lightning anchors.
   - **Performance & Graphics** (everyone) holds each player's own settings: the on/off switch, graphics quality, render resolution, accessibility, per-effect toggles, and their carried light.
3. If Map Shine misbehaves mid-session, the Remote's **Renderer** dropdown switches the whole table to Foundry's own renderer. A player can also turn it off for themselves in Performance & Graphics.

## Map authoring: suffix-based masks

Map Shine discovers masks by searching for sibling files next to your scene background image. Use the same base filename as your background, plus a suffix.

Example (if your background is `MyMap.webp`):

- `MyMap_Outdoors.webp`
- `MyMap_Specular.webp`
- `MyMap_Window.webp`
- `MyMap_Water.webp`

Supported formats:

- `webp`
- `png`
- `jpg` / `jpeg`

### Currently recognized suffixes

These are the masks the module discovers (the source of truth is `src/scene/mask-catalog.js`; the Studio's Scene department shows which ones the current scene has under "Masks aboard"):

- **`_Outdoors`** (grayscale): white is outdoors, black is indoors. Required on every level.
- **`_Shadow`** (grayscale): hand-painted shadow; black is shadowed.
- **`_Fire`** (grayscale): where fire spawns.
- **`_Drip`** (grayscale): where drips spawn (cave ceilings, leaking pipes).
- **`_Specular`** (colour): metal and shine; the hue is the reflection colour.
- **`_Window`** (colour): interior window-light cookie. `_Windows` and `_Structural` are still accepted as older names.
- **`_Water`** (RGBA): water depth and presence.
- **`_Fluid`** (RGBA): liquid-filled tiles (tubes, troughs, cauldrons).
- **`_Tree`** / **`_Bush`** (RGBA): animated canopy and bush colour plus coverage.
- **`_Prism`** / **`_Iridescence`** (colour): glass/crystal refraction and thin-film shimmer.

## Features (current)

This section describes the module's actual roster as of 0.6.5 (superseding an older description that named classes — `EffectComposer`, `TokenManager`, `LightingEffect`, and similar — that no longer exist under those names in `src/`; see mythica-machina-press#567). It's grouped by capability rather than by internal class name, since those names change across refactors and a name-level list is what went stale last time.

### Foundry syncing (`src/foundry/`, `src/scene/`)

- Tokens, tiles (including overhead/roof), walls, doors, lights, regions, and drawings/notes/templates are synced from the live Foundry scene into the Three.js world and kept live as the GM edits.
- Vision/fog-of-war ownership, occlusion (walls, floors, roofs), and depth authority are handled natively rather than layered on top of Foundry's own PIXI rendering.
- Tile motion (scrolling/animated tiles, with per-tile specular/window attachment) and player-light modes (torch/flashlight/night vision/etc.) are first-class, not bolted on.

### Effects (`src/effects/`)

- **Clouds** — ground shadow + high-altitude tops, both zoom-aware.
- **Water** — refraction, caustics, foam, and a real simulation, not a static ripple texture.
- **Fire** — wind-responsive flame/spark rendering.
- **Vegetation** — GPU-driven wind sway and shadowing.
- **Window** / **Specular** — mask-driven interior light pools and surface shine, both attachable to tiles.
- **Fluid** — liquid-filled tiles (troughs, cauldrons, etc.) with their own mask channel.
- **Precipitation** — rain/snow with splash/settle behavior.
- **Prism** / **Iridescence** — TSL/WebGPU-native refraction and iridescent surface finishes.
- **Lens** — overlay/grime texture compositing on the camera lens.
- **Bloom**, **Depth of Field**, **Grade** (color grading), **Sun Shadows**, **TAA** — the post-processing chain.
- **Region Darkness Override** — a GM-set floor for every scene's darkening regions.

### World / weather state (`src/world/`)

- **Almanac & calendar** (`almanac.js`, `calendar/`) drive an in-game time-of-day and season system.
- **Weather** (`weather.js`, `weather-biomes.js`, `weather-events.js`) provides shared global state — precipitation, cloud cover, wind, time-of-day — that the effects above consume as inputs, plus a GPU wind field/simulation (`wind-sim-gpu.js`, `wind-field.js`).
- **Fades** (`fade-engine.js`, `fade-registry.js`) let the GM transition weather/sky state smoothly rather than snapping.

### Texture pipeline (`src/vt/`)

- Pre-baked BC1/BC7 compressed textures with a decode-worker pool, so mask/overlay art doesn't decode twice or block the main thread on load.

### UI

- **Studio** (`src/ui/rooms/studio/`) — the GM's authoring panel, one card per effect.
- **Remote** (`src/ui/rooms/remote/`) — the in-session control surface (weather channels, sky/time dials, astrolabe).

## Roadmap (planned)

This list predates a large amount of work that has since shipped (cloud shadows, vision/fog-of-war ownership, and more) — treat it as historical rather than current, and check the GitHub issue tracker for live status.

- **Cloud system expansion**
  - Spatial window dimming based on cloud shadows
  - Sky reflections on specular surfaces
  - ~~Zoom-dependent cloud tops~~ — shipped (Cloud Tops)

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
npm run build:three-webgpu
```

That produces:

```text
src/vendor/three/three.webgpu.js
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
