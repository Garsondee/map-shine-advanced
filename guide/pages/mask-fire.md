---
sources: src/scene/mask-catalog.js (fire: width sets diameter), src/effects/fire/fire-mask.js, src/effects/fire/fire.js (FIRE_PARAMS, maskSensitivity, rain response), src/effects/fire/fire-billow-engine.js (the wind at each fire, roof shelter), src/effects/fire/fire-billow-geometry.js (flame tilt, smoke carried by the wind)
---
`_Fire` says **where something burns**. Map Shine grows a flame, rising smoke, embers and flickering firelight from each painted shape.

::: compare "**Foundry / Forge** at night. Drag to compare: the furnaces burn, light the room and send smoke up."
![Plain art](forge-fire-art.webp)
![Map Shine](forge-fire-msa.webp)
:::

![The _Fire mask](forge-fire-mask.webp "The `_Fire` mask: one small white dot in each furnace mouth.")

### The shape sets the size

Map Shine measures **how wide** each painted shape is:

- a **small dot** is a candle or a lamp flame;
- a **wide blob** is one big bonfire;
- a **thin line** is a row of small flames, like a burning beam or a fire along a wall.

So paint the fire the size you want it. One wide shape gives one big fire, and a scribble gives lots of little ones.

### Tips

- **Paint it bright.** Very faint paint is ignored. Pure white is safest.
- Put the dot **where the flames start**, at the base of the fire, not over the whole flame in the art.
- Fires under open sky (white on `_Outdoors`) react to the weather. Each feels the wind where it stands, so a wall or building upwind shelters it. In a breeze the flames lean over and the smoke streams away downwind; in a fresh breeze it shreds and thins, and in a gale it is blown out within a few flame heights (**Wind disperses smoke** sets how much). Heavy rain puts them out until a dry spell.
- Fires under a roof keep burning whatever the weather, and their smoke rises.

### Adjusting

Flame size, smoke, embers and colour are in **Studio → Effects → Fire**. The **Fuel** setting (wood, coal, oil or magical) changes the colour and behaviour in one go.

> [!try] On a scene with fire, try **Quick Fixes → Fire or smoke is too much** to see the main settings change live.

[[settings: fire]]
