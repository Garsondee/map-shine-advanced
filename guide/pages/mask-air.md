---
sources: src/scene/mask-catalog.js (dust, drip, ash, flies, maggots, fireflies), src/effects/critters/ (dust.js, critter-zone.js), src/effects/precipitation/drip-edges.js (dripAuthoredMode), precipitation mantle (ash)
---
These small masks add life to the air: dust in sunbeams, drips from the eaves, ash on the ground, and swarms of creatures. All are greyscale: **white where it happens, black where it doesn't.**

### `_Dust`: motes in the light

Paint the **whole room** where the air is dusty, not just the sunbeam. The specks only show up where window light falls, so they appear and fade as the sun moves. It works together with a `_Window` mask.

![The _Dust mask](goblin-dust-mask.webp "The `_Dust` mask of **Goblin Alchemist**: the dusty air of the workshop, brightest where the window light falls.")

### `_Drip`: water dripping

Paint short marks where water drips from: roof edges, gutters, broken pipes, cave ceilings. **Studio → Effects → Precipitation** chooses whether they drip only after rain or all the time.

### `_Ash`: ash lying on the ground

Paint where ash or soot already lies, around a forge or a burned-out house. It stays whatever the weather: an ashfall can add more, but the ground never gets cleaner than you painted it.

![The _Ash mask of the Forge](forge-ash-mask.webp "The `_Ash` mask of **Foundry / Forge**: soft drifts of ash across the yard.")

### `_Flies`, `_Maggots` and `_Fireflies`

- **Each separate blob is one swarm** (or colony, or group).
- A **bigger blob** means more of them.
- The mask itself never shows. Only the creatures do.

Paint flies over the rubbish heap, maggots in the corpse pit, fireflies over the pond. Fireflies are at their best around dusk. Creatures scatter when a token walks through them.

> [!tip] Keep blobs **separate**. Two blobs that touch become one big swarm.

[[settings: dust]]
