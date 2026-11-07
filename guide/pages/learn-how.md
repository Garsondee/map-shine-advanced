---
sources: src/scene/mask-catalog.js (MASK_KINDS), src/foundry/mask-discovery.js
---
A map is a flat painting. Map Shine needs to know a little more: where the roofs are, which parts are metal, where the water is. You tell it with **masks**.

::: compare "Drag the slider. **Big Bank**, the plain art on the left and Map Shine on the right: sun and shadow, gold that shines, light through the windows."
![Plain art](big-bank-compare-art.webp)
![Map Shine](big-bank-compare-msa.webp)
:::

### What is a mask?

A mask is a picture the same shape as your map, saved next to it. Most masks are black and white: **white means "here", black means "not here"**. A `_Water` mask is white where the water is. That's it.

Some masks carry colour. A `_Specular` mask uses colour to say which colour a surface shines, and a `_Window` mask uses colour for the colour of the light.

### How Map Shine finds them

By name. A mask has the map's file name with an ending added:

| File | What it is |
|---|---|
| `big-bank.webp` | the map art |
| `big-bank_Outdoors.webp` | where the open sky is |
| `big-bank_Specular.webp` | what shines |
| `big-bank_Windows.webp` | the light from windows |

Put them in the same folder as the map and Map Shine finds them when the scene opens.

### Only one mask is required

`_Outdoors` is the one every map needs. It tells Map Shine where the roofs are, so the sun, the shadows and the weather know where to stop. Every other mask is optional: add the ones your map needs.

> [!try] Open the Remote, press **Help**, then **Quick Fixes → Change the mood**. Try **Storm** and **Golden hour** on any scene with an `_Outdoors` mask.

Next: [your first scene, step by step](page:learn-first-scene).
