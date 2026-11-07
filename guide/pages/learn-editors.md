---
sources: src/scene/mask-catalog.js (gray reads red, transparent = unpainted), src/vt/mask-image.js (MASK_CONTENT_EMPTY_BYTE, size cap), src/effects/specular/specular-material.js (RGB under alpha)
---
Any image editor that supports layers works: Photoshop, Krita, GIMP, Affinity Photo, Procreate. The steps are the same everywhere.

### The setup

1. Open the finished map. **Don't resize or crop the canvas.**
2. Add a new layer for each mask, named after it: `_Outdoors`, `_Water` and so on.
3. Work with the map visible underneath and the mask layer half see-through, so you can trace.
4. Before exporting a mask, set its layer back to fully opaque and hide every other layer.

### The settings that matter

| Setting | Use |
|---|---|
| Canvas size | Same as the map, or exactly half or a quarter. Never a different shape. |
| File type | `.webp` or `.png`. Use **lossless** WebP for masks with thin lines. |
| Colour | Ordinary RGB. A greyscale document is fine. |
| Background | **Solid black**, not transparent, except for `_Tree` and `_Bush`. |
| Edges | Soft edges are fine and often look better. |

### Black, white and grey

Greyscale masks read only the **red channel**, so paint in pure greys. A coloured brush counts only its red: pure blue paints nothing.

### Transparency traps

- On `_Outdoors` and the other greyscale masks, transparent means "not painted", **not** black. Flatten onto a black or white background before export.
- On colour masks (`_Specular`, `_Window`, `_Prism`), Map Shine reads the colour **even under fully transparent pixels**. Some editors keep hidden colour there. Flatten onto black so nothing is hiding.

> [!tip] In GIMP's PNG export, untick **Save color values from transparent pixels**. In any editor, filling a black layer under the mask and merging it down is the safest way.

### Lossy files

Heavily compressed `.jpg` or lossy `.webp` adds faint noise. Map Shine ignores the faintest noise, but compression also smudges thin lines: a one-pixel `_Fire` line or a narrow `_Water` channel can break up. Use lossless for those.

### Big maps

Masks don't need to be full size. A half-size `_Outdoors` mask looks the same and loads faster. Keep `_Specular` and `_Fire` at full size if they have fine detail. The longest side can be up to 16384 pixels.

### Checking your work

After uploading, open the painter in Map Shine and press **M**. The Masks list shows which masks were found, so you can see at a glance whether a name or folder is wrong.
