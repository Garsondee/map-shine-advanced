---
sources: Foundry v14 Levels, src/foundry/mask-discovery.js (discoveryTargetsFrom), src/effects/depth-of-field.js (blurPerFloor), boot.js level visibility, src/effects/lighting/region-geometry.js (selectRegionsForViewedFloor)
---
Foundry lets one scene hold several floors, called **Levels**: a cellar, a ground floor and an attic stacked above each other. Map Shine draws each floor with its own masks and effects.

### What each floor needs

- Its own map art, set as that Level's background.
- Its own `_Outdoors` mask, named after that floor's art. Underground floors get a solid black one.
- Any other masks it needs, named after that floor's art too.

### Seeing between floors

Each Level lists the other floors that can be seen from it. Map Shine follows that list:

- From an upper floor, list the floors **below** if its art has holes to look through: a balcony, a broken floor, a stairwell.
- Don't list floors **above** unless their art is mostly transparent. An opaque floor above covers the one you're on. [The wrong floor is showing](page:fix-wrong-floor).

### Dark rooms on each floor

A darkness Region follows its own **Levels** list, as in Foundry: leave it empty and it darkens every floor; fill it and it works only while you view one of those floors. Its elevation range limits it too.

> [!note] Looking down a stairwell, the floor below takes the darkness Regions of the floor you are on, not its own.

### Roofs and overhead tiles

Roofs, canopies and bridges are usually tiles above the floor. A tile can carry its own masks (a roof tile with its own `_Outdoors`, for example), named after the tile's image.

### Depth between floors

**Depth of Field** softens floors below the one being viewed, like a camera focused on the near floor. It's a strong effect for multi-floor maps. Set it in **Studio → Effects → Depth of Field**.

> [!tip] Floors load in the background. Map Shine switches to a floor once it is ready, so the players see the new floor appear in one go.
