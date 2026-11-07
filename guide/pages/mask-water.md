---
sources: src/scene/mask-catalog.js (water: rgba, red read), src/effects/water/ (WATER_PARAMS, WATER_GRID_MAX_DIM), shore foam from the mask edge (0cfd9fd9)
---
`_Water` says **where the water is and how deep**. Map Shine adds moving waves, shore foam, reflections of the sky, the sun shining through the shallows, and rain rings when it rains.

::: compare "**Town River Bridge**, the lower floor. Drag to compare: the river comes alive, with foam along the banks and piers."
![Plain art](river-water-art.webp)
![Map Shine](river-water-msa.webp)
:::

![The _Water mask](river-water-mask.webp "Its `_Water` mask. White is deep water. The soft grey band along the banks is the shallows.")

### How to read it

- **Black**: dry land.
- **Any grey or white**: water. **Brighter is deeper.**
- Map Shine reads only the red channel. Paint in grey.

### Painting it

1. Paint every patch of water white.
2. **Blur the edges**, or paint a grey band along the shore. That band is the shallows, and it is where the foam gathers.
3. Leave piers, boats and rocks black. The foam then wraps around them.

### Tips

- **Clean edges make clean foam.** Foam traces the edge of the mask, so a ragged edge gives ragged foam.
- Small islands and thin piers need a mask big enough to show them clearly. A very small mask turns thin piers into blobs.
- Water lies under everything else, so you can paint it under bridges and docks.

> [!tip] How fast the water flows, how rough it is and its colour are all in **Studio → Effects → Water**, with ready-made presets from garden ponds and mountain streams to rivers, tropical shallows, open ocean and hot springs.
