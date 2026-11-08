---
sources: src/effects/sun-shadows.js, src/effects/window/window.js, src/effects/dynamic-range.js, src/effects/bloom.js, src/effects/lens.js (Glare), src/effects/grade/grade.js (lightLevel), src/effects/lighting/ambience-filter.js (scene Environment), src/foundry/scene-environment.js (readSceneAuthoredDarkness), boot.js onSweepToHour
---
Map Shine lights a scene like a camera would see it: a real sun that moves, shadows that stretch, lamps that glow, and a camera that copes with bright and dark together.

::: compare "**Big Bank**. Drag to compare: noon on the left, golden hour on the right. Same scene, only the clock changed."
![Noon](big-bank-noon.webp)
![Golden hour](big-bank-golden.webp)
:::

[[do: time-dawn, time-noon, time-golden, time-night]]

### The sun

- It rises, crosses the sky and sets with the scene's clock. Turn the dial on the Remote's Play tab.
- **Golden hour**, just before sunset, gives long warm shadows. Most maps look their best then.
- Shadows come from `_Outdoors`: the black shapes are buildings.

### Lamps and torches

Foundry's own lights become Map Shine lights. Their radius, colour and animation are set the same way as always, in the light's settings. **Studio → Effects → Colour Grade** has a **Light level** for every lamp at once.

The scene's own **Environment** settings in Foundry (Base and Darkness: tint, luminosity, saturation, shadows) colour the map art the same way they do in Foundry. So does its **Darkness Level**: a scene set dark in Foundry stays at least that dark, and the clock can only make it darker.

### Window light

Rooms get daylight through the patches you paint on `_Window`. It follows the sun and dims with clouds, so interiors feel connected to the weather.

### The camera

- **Dynamic Range** is the camera's exposure. It lets bright windows and dark corners sit in one picture, and slowly adjusts like an eye when you pan between a dark room and a sunny street. **Drama** sets how hard light and dark push apart. A flash of lightning never makes it re-adjust.
- **Bloom** is the camera's glare: a small share of the light that is too bright for the picture spreads into a tight glow with a faint wide haze. It is eased down on maps with many lights.
- The **Lens** card's **Glare** settings add what bright light does inside a lens: a warm film fringe, dirt on the glass that shows only in front of a light, and starbursts on the fiercest glints. Streaks, flare ghosts and light leaks are there too, off until you want them. The **Camera** Looks set all of this in one press.
- **Exposure** brightens or darkens the whole picture.

> [!tip] Interiors look best a little darker than you expect. Dark rooms make lamps and window light the stars. If players can't see, raise the **lamps** before the exposure.

[[do: lamps-up, brighten-inside, more-drama]]

Changed too much? Every button above has **Undo**.

### Every setting

The full lists, straight from the Studio:

[[settings: sunShadows]]

[[settings: dynamicRange]]

[[settings: bloom]]

[[settings: grade]]

[[settings: lens]]

[[settings: depthOfField]]
