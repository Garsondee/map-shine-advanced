---
sources: src/scene/mask-catalog.js (water: rgba, red read), src/effects/water/ (WATER_PARAMS, WATER_GRID_MAX_DIM), shore foam from the mask edge (0cfd9fd9), src/effects/water/water-field.js (WATER_WIND_SURFACE_TRAVEL), src/effects/water/water-spray-shore.js (sprayWaveImpact)
---
`_Water` says **where the water is and how deep**. Map Shine adds moving waves, shore foam, reflections of the sky, rain rings when it rains, and sunlight through the water: bright, shifting caustics in the shallows and soft shafts with drifting silt over deeper water. They dim under cloud and in shadow and are gone at night.

**The wind drives the surface, and the rest follows.** The waves, the foam floating on them and the caustics underneath all travel with the current *and* downwind. In a strong wind the caustics turn busier and dimmer, and on a calm day they are bolder and slower. Under thin cloud they blur before they fade, and a low sun shifts them away from the waves that made them. Where waves meet a hard edge (a quay wall, a hull, a pier), spray flies off in sudden splats as each crest hits. Between crests that edge stays quiet.

::: compare "**Docklands Warehouse**, the waterfront. Drag to compare: the painted riverbed becomes moving water, with foam around the boat and the jetty."
![Plain art](docklands-water-art.webp)
![Map Shine](docklands-water-msa.webp)
:::

![The _Water mask](docklands-water-mask.webp "Its `_Water` mask. White is water. The boat, the jetty and the quay are left black, so the foam wraps around them.")

### How to read it

- **Black**: dry land.
- **Any grey or white**: water. **Brighter is deeper.** Depth comes from this brightness and nothing else: a white edge against a hull, pier or quay wall stays deep right up to it, like real water. For a sloping bank or a beach, paint a grey ramp.
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

[[settings: water]]
