---
sources: src/scene/mask-catalog.js (outdoors: required, packed trio, ownsPackedAlpha), src/effects/sun-shadows.js, src/world (wind shelter), src/effects/precipitation
---
**White is open sky. Black is under a roof.** It's the one mask every floor of every map needs.

::: gallery
![Plain art](docklands-outdoors-art.webp "**Docklands Warehouse**, plain art.")
![_Outdoors mask](docklands-outdoors-mask.webp "Its `_Outdoors` mask.")
:::

![Map Shine render of Docklands Warehouse](docklands-outdoors-msa.webp "Map Shine reads the black shapes as buildings: they cast the sun's shadows, and the light inside them is kept apart from the daylight outside.")

### What it controls

- **Sunlight and sun shadows.** Black shapes are buildings. Their edges cast the shadows.
- **Weather.** Rain, snow and cloud shadows stop at black.
- **Wind.** Plants and smoke under a roof stay still.
- **Window light**, which shines into black areas from the outside.
- **Fire.** Rain only puts out fires under open sky.

### How to paint it well

1. **Follow the outside of the walls.** The roof covers the wall, so paint the walls black with the room.
2. **Paint solid black and white.** Soft greys are fine at the very edge, but a room should be solid black.
3. **Doorways and windows stay black.** They are part of the building.
4. **Courtyards and roofless ruins are white**, even when walls surround them.
5. **A covered porch or awning is black**, even though it is open at the sides.

> [!warn] **Transparent is not black.** Transparent areas mean "not painted", and Map Shine treats them as open sky. Fill the whole mask, with no transparent pixels.

### Underground floors

A cellar or a dungeon has no sky at all. Fill its `_Outdoors` mask **solid black**. Don't leave the mask out: a floor with no `_Outdoors` mask stops the effects that need it, and the Remote will say so.

### `_Shadow`

A file named `_Shadow` is recognised but has no effect. Sun shadows come from `_Outdoors`.

> [!tip] Short on time? The painter's **Start from walls** builds a first `_Outdoors` mask from the scene's walls. Tidy it up rather than starting blank. [The painter](page:learn-painter).
