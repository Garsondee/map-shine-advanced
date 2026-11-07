---
sources: src/scene/mask-catalog.js (specular: color), src/effects/specular/specular-material.js (decodeSpecularMask), src/effects/specular/specular.js (SPECULAR_PARAMS, metalResponse), src/vt/mask-image.js (0.75x upload)
---
`_Specular` marks what **shines**: gold trim, brass fittings, polished floors, wet stone, glass. Shiny areas catch the sun and the lamps, and glints slide across them as the camera moves.

::: compare "**Big Bank** at dusk. Drag to compare: the gold inlays and trim catch the low sun."
![Plain art](big-bank-specular-art.webp)
![Map Shine](big-bank-specular-msa.webp)
:::

![The _Specular mask](big-bank-specular-mask.webp "The `_Specular` mask of the same area. Black doesn't shine. The colours are copied from the art, so gold shines gold.")

### How to read it

- **Black**: not shiny.
- **Brightness**: how polished. Bright is a mirror-like gleam, dim is a soft sheen.
- **Colour**: the colour of the shine. Gold shines warm, steel shines white.

### The quick way to make one

1. Duplicate the map art.
2. Paint black over everything that isn't shiny.
3. What's left keeps its own colours, so gold shines gold and copper shines copper.
4. Use Levels or Curves to brighten the most polished things and dim the duller ones.

### Tips

- **Less is more.** Shine only on edges and highlights reads as metal. Shine over a whole floor reads as wet plastic.
- **Thin trim is worth it.** One-pixel gold edges on a frame or a table make a map sparkle.
- How metallic it all looks is a setting: **Studio → Effects → Metal & shine**. You don't paint that.

> [!warn] **Keep transparent areas black.** Map Shine reads a pixel's colour even when it is fully transparent, so stray colour hidden under transparency will shine. Fill the background black before you export.

> [!note] Map Shine's painter can't edit a colour mask like this one. Make it in an image editor.

[[settings: specular]]
