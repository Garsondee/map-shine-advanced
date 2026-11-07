---
sources: src/scene/mask-catalog.js (window: _Window, _Windows, _Structural), src/effects/window/ (window-render.js, WINDOW_PARAMS), src/effects/critters/dust.js
---
Paint the **pool of daylight a window throws onto the floor**. Map Shine then lights that pool with the real sun: warm at dusk, cool by moonlight, dimmed by clouds, and rippled by rain on the glass.

::: compare "**Docklands Warehouse**. Drag to compare: the plain art, and the same room with window light at four in the afternoon."
![Plain art](docklands-window-art.webp)
![Map Shine](docklands-window-msa.webp)
:::

![The _Window mask for the same room](docklands-window-mask.webp "The `_Window` mask for that room. Each bright shape is the light from one window, with the frame's bars left dark.")

### The mask is the light, not the window

Don't paint the window itself. Paint where its light **lands**: a soft-edged patch on the floor next to the window, with the frame's shadow cut into it.

- **Brightness** is how much light falls there. Bright near the glass, fading further in.
- **Colour** tints the light. Leave it white for daylight, or paint it blue, amber or green for stained glass.
- **Black** is no window light.

### Tips

- Keep patches **inside** the building, on the black of `_Outdoors`. Window light out on the street is wasted.
- A **soft, blurred edge** looks like real daylight. A hard edge looks like a spotlight.
- Leave the bars of the window frame dark. That's what makes it read as a window.
- **Fill the background black, never transparent.** Like `_Specular`, a transparent pixel is read by its stored colour, and a Photoshop PNG stores white there: light everywhere.
- `_Window`, `_Windows` and `_Structural` are all accepted.

### It moves with the sun

Map Shine slides and stretches each patch with the time of day and keeps it inside its room. You don't need one mask for morning and another for evening: paint it for midday and let the sun do the rest.

> [!tip] Add a `_Dust` mask to the same rooms and specks of dust float in the window light. [Dust and critters](page:mask-air).

[[settings: window]]
