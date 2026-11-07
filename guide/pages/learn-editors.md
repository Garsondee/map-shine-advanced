---
sources: src/scene/mask-catalog.js (gray reads red, transparent = unpainted), src/vt/mask-image.js (MASK_CONTENT_EMPTY_BYTE, size cap), src/effects/specular/specular-material.js (decodeSpecularMask: alpha 0 reads RGB at full strength), tools/guide/editor-tests (Photoshop 2026, Krita 5.3, GIMP 3.2 round trips, 2026-11-07)
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
| Colour mode | **RGB.** Paint greys in an RGB document. |
| Background | **Solid black**, not transparent, except for `_Tree` and `_Bush`. |
| Edges | Soft edges are fine and often look better. |

### Black, white and grey

Greyscale masks read only the **red channel**, so paint in pure greys. A coloured brush counts only its red: pure blue paints nothing.

### Transparency traps

- On `_Outdoors` and the other greyscale masks, transparent means "not painted", **not** black. Flatten onto a black or white background before export.
- On colour masks (`_Specular`, `_Window`, `_Prism`), Map Shine reads a fully transparent pixel's colour **at full strength**. Whatever colour the file stores there shows up as shine or light. Flatten onto black so nothing is hiding.

> [!tip] In GIMP's PNG export, untick **Save color values from transparent pixels**. In any editor, filling a black layer under the mask and merging it down is the safest way.

### Tested in Photoshop, Krita and GIMP

We exported test images from Photoshop 2026, Krita 5.3 and GIMP 3.2 and read them back the way Map Shine does. The trap is what each one stores under a transparent pixel:

| Saved with a transparent background | What the empty pixels held |
|---|---|
| Photoshop PNG (Save As or Save for Web) | **White**: shines or lights up everywhere it is empty |
| Photoshop lossless WebP | Black: safe |
| Krita PNG | **The colour you erased**: still shines |
| Krita WebP | Black: safe |
| GIMP PNG (default export) | Black: safe |
| GIMP WebP | **The colour you erased**: still shines |

The other tests passed in all three: a 50% grey painted in RGB came back as exactly 128, and a one-pixel white line survived PNG and lossless WebP. One trap is Photoshop's own: after **Image → Mode → Grayscale** the same grey came back as 105, so every grey got darker.

So in any editor: **stay in RGB mode**, and before saving a colour mask add a black layer underneath and merge down. Then nothing can hide under the transparency, whatever the format.

Affinity Photo has not been tested. Follow the same rules, and check a mask in Map Shine before painting a whole map.

### Lossy files

Heavily compressed `.jpg` or lossy `.webp` adds faint noise. Map Shine ignores the faintest noise, but compression also smudges thin lines: a one-pixel `_Fire` line or a narrow `_Water` channel can break up. Use lossless for those.

### Big maps

Masks don't need to be full size. A half-size `_Outdoors` mask looks the same and loads faster. Keep `_Specular` and `_Fire` at full size if they have fine detail. The longest side can be up to 16384 pixels.

### Checking your work

After uploading, open the painter in Map Shine and press **M**. The Masks list shows which masks were found, so you can see at a glance whether a name or folder is wrong.
