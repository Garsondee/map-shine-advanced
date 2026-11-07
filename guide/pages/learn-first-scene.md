---
sources: src/scene/scene-readiness.js, src/ui/rooms/remote/readiness-card.js, src/ui/paint-mode.js, src/scene/mask-export.js
---
From a finished map to a working Map Shine scene. You need your map art and any image editor, or just Map Shine's own painter.

### 1. Export the map

Export the finished map as `.webp` (smallest) or `.png`. Give it a plain name you'll keep, like `old-mill-ground.webp`.

### 2. Make the `_Outdoors` mask

Make a new layer over the map. Fill it white, then paint every roofed area black: rooms, halls, covered porches. Leave courtyards, streets and open ground white.

Export only that layer, at the same size as the map, as `old-mill-ground_Outdoors.webp`.

![Docklands Warehouse with its _Outdoors mask](docklands-outdoors-mask.webp "The `_Outdoors` mask of **Docklands Warehouse**. Black: under a roof. White: open sky.")

> [!tip] No image editor? Skip this step. Map Shine's painter can draw `_Outdoors` for you, even starting from the scene's walls. See [Painting inside Map Shine](page:learn-painter).

### 3. Upload both files

Upload the map and the mask **to the same folder** in Foundry.

### 4. Make the scene

Create the scene in Foundry as usual and set the map as the floor's background. Open the scene.

### 5. Check the Remote

Open the Map Shine Remote. If something is missing, a **Scene readiness** card sits above the tabs and says what. When the card is gone, the scene is ready.

### 6. Add more, one at a time

Add `_Windows`, `_Specular`, `_Water` and the rest as your map needs them. Reload the scene after each one and look at what changed. Going one mask at a time makes problems easy to spot.

> [!note] Changed a mask that was already loaded? Press **F5** to reload. Map Shine remembers what it found for a few minutes.
