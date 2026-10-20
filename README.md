![](https://img.shields.io/badge/Foundry-v14-informational)

# Map Shine Advanced

Map Shine Advanced is a Foundry VTT module that brings a Three.js-based renderer to Foundry with a focus on cinematic 2.5D battlemaps: PBR-style surface shading, mask-driven effects, particles, and a modern post-processing pipeline.

## What this module does

- **Renders the scene in Three.js** while Foundry continues to provide game logic + UI.
- **Syncs Foundry documents** (tokens, tiles, walls, doors, lights, regions) into Three.js managers. Drawings, notes and templates stay in Foundry's own canvas layer, drawn on top.
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
- **`_Flies`** (grayscale): the zone a swarm of flies hovers over. Every separate painted blob is its own swarm.
- **`_Maggots`** (grayscale): the zone a writhing mass of maggots crawls in. Independent of `_Flies` — paint both over a corpse, or either alone.
- **`_Fireflies`** (grayscale): the zone a firefly colony glows over during twilight. Every separate painted blob is its own colony.
- **`_Specular`** (colour): metal and shine; the hue is the reflection colour.
- **`_Window`** (colour): interior window-light cookie. `_Windows` and `_Structural` are still accepted as older names.
- **`_Water`** (RGBA): water depth and presence.
- **`_Fluid`** (RGBA): liquid-filled tiles (tubes, troughs, cauldrons).
- **`_Tree`** / **`_Bush`** (RGBA): animated canopy and bush colour plus coverage.
- **`_Prism`** / **`_Iridescence`** (colour): glass/crystal refraction and thin-film shimmer.

## Features (current)

This section describes the module's actual roster as of 0.9.0 (superseding an older description that named classes — `EffectComposer`, `TokenManager`, `LightingEffect`, and similar — that no longer exist under those names in `src/`; see mythica-machina-press#567). It's grouped by capability rather than by internal class name, since those names change across refactors and a name-level list is what went stale last time.

### Foundry syncing (`src/foundry/`, `src/scene/`)

- Tokens, tiles (including overhead/roof), walls, doors, lights and regions are synced from the live Foundry scene into the Three.js world and kept live as the GM edits. Drawings, notes and templates stay in Foundry's PIXI interface layer.
- Vision/fog-of-war ownership, occlusion (walls, floors, roofs), and depth authority are handled natively rather than layered on top of Foundry's own PIXI rendering.
- Tile motion (scrolling/animated tiles, with per-tile specular/window attachment) and player-light modes (torch/flashlight/night vision/etc.) are first-class, not bolted on.

### Effects (`src/effects/`)

- **Clouds** — ground shadow and high-altitude tops. Only the tops are zoom-gated.
- **Water** — tiered surface with refraction, caustics and shore foam drawn from the `_Water` mask, driven by a per-floor water simulation (flow, and foam memory). Spray flecks fly up where water breaks on hard edges, drift with the current, and land and fade on water or ground.
- **Fire** — a cel-shaded, painted-campfire look built from closed-form billows (no sprite population): licking tongues, torn flecks, a coal bed, smoke and heavy spit embers, with heat haze above a burning fire. Weather drives it — wind lays flames over and streams the smoke, rain soaks a fire out over time and it rekindles after a dry spell — and a wide painted region becomes a mass of overlapping flames, the start of a burning building.
- **Smelly Flies** — paint a `_Flies` zone and a swarm of procedurally drawn flies buzzes over it, lands, walks (with planted feet), grooms and takes off again. Species, wing detail, metallic sheen, flight height, buzz, tether and landing behaviour are all adjustable.
- **Maggots** — paint a `_Maggots` zone and a mass of segmented, moist-looking maggots wriggles and crawls in it, clumping together and pausing to rest. Girth, gloss, segmentation, wriggle rhythm and crawl behaviour are adjustable.
- **Fireflies** — paint a `_Fireflies` zone and a colony of glowing beetles drifts over it during the twilight window (keyed to the sun's elevation, so it follows the sky's own dusk and dawn), flashing in a chosen pattern with adjustable synchrony (no insect flashes more than three times a second).

  All three are separate effects with their own Studio cards: a short front-of-house strip for running a scene, and the full set of controls grouped by Presence, Look, Detail, Motion, Depth and more under Advanced. Each one responds to the weather on its own terms. How much **rain**, **snow**, **high wind** (above a tolerance you set) and **cold** (below a threshold you set) clears the population is adjustable per cause, and so is what the weather does to the ones that stay: wind carries flying insects downwind and makes them erratic, rain drives fliers to the ground or makes maggots squirm, cold slows everything. Flies are driven off easily, fireflies are fair-weather creatures, and maggots barely mind — and every one of those defaults is a slider.

- **Vegetation** — GPU-driven wind sway and shadowing.
- **Window** / **Specular** — mask-driven interior light pools and surface shine, both attachable to tiles. A window can carry its own rain (splats, drops that run down the pane toward the wall or stream across it in wind, scaled from a trickle to a furious storm) and a light pattern that fades out over a set reach outside the glass, instead of throwing a hard-edged fan across the whole yard.
- **Fluid** — liquid-filled tiles (troughs, cauldrons, etc.) with their own mask channel.
- **Precipitation** — rain/snow with splash/settle behavior, Storm Fog (reduced-visibility mist at high intensity), and an authored `_Drip` mask.
- **Rope & Chain** — GM-placed two-point spans with sag, GPU wind-spring sway, and a matching shadow.
- **Player-carried lights** — scene-permissioned Torch (a real fire, held out toward the cursor) and Flashlight (a cursor-aimed beam that lands on a textured cookie spot with its own bounced glow) plus five vision grades: Night Vision, Low-light, Low Light (Active), Infravision and Active Infravision. The flashlight sits on the rim of its token and rolls round it as the cursor moves; a GM carries lights on the token they have selected (Remote > Player Lights). A carried light exists only while somebody is steering it — a player's own cursor, or a GM's selection — so a scene loads with no beam frozen pointing north. A torch or flashlight also reveals Foundry's native door icons, the same way MSA's candles and fires already do.
- **Atmospheric haze** — aerial perspective that builds as you zoom out, driven by zoom and cloud cover.
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

- **Studio** (`src/ui/rooms/studio/`) — the GM's authoring panel, one card per effect, plus named Scene Presets that save and re-apply a scene's whole look.
- **Remote** (`src/ui/rooms/remote/`) — the in-session control surface (weather channels, sky/time dials, astrolabe).

## Still to build

Checked against the code on 2026-10-17. Shipped items have been removed from this list. The GitHub issue tracker is the live status.

- **Ambient particle dressing**: dust motes, ash kick-up, and shoreline spray. The particle passes are live, but today they draw only debug motes and gust ribbons.
- **Interactive water**: rain and token ripples, distinct water body types, and splash spray.
- **Post finishers**: screen-space distortion and heat haze, dazzle and eye adaptation, and the ASCII, halftone and dot-screen stylisers.
- **Painted shadows**: an authored `_Shadow` mask that the sun term reads.
- **Storm lightning**: a sky flash that briefly brightens the whole scene's grade.
- **Weather on materials**: rain on window glass, and wet or frost sheen on specular surfaces.
- **Vision polish**: the Vision occlusion mode (roof reveal from a token's sight), Foundry's native vision-mode grades, and detection-mode indicators.
- **Third-party bridges**: Dice So Nice and Sequencer/JB2A. Nothing in `src/` implements them yet.

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

  - Check the browser console for capability errors. The module needs WebGPU or WebGL2: WebGPU is preferred, and Three.js picks the backend.

- **Effects look like they do nothing**

  - Many effects default to subtle settings (some are intentionally `0` intensity until enabled).

- **My masks aren’t detected**
  - Ensure the mask files are in the same directory as the background.
  - Ensure the base filename matches exactly and the suffix is correct.

## License

See `LICENSE`.
