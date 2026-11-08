---
sources: src/effects/sun-shadows.js, src/effects/window/window.js, src/effects/dynamic-range.js, src/effects/bloom.js, src/effects/grade/grade.js (lightLevel), src/effects/lighting/ambience-filter.js (scene Environment), src/foundry/scene-environment.js (readSceneAuthoredDarkness), boot.js onSweepToHour
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

- **Dynamic Range** lets bright windows and dark corners sit in one picture without either washing out. **Drama** sets how hard they push apart.
- **Bloom** is the soft glow around the brightest lights. A little goes a long way. With Dynamic Range on, its **Glow amount** sets how much glow reaches the picture.
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
