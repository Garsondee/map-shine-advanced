---
sources: src/world/weather-data.js (WEATHER_ARCHETYPES), src/ui/rooms/remote/weather-board.js, src/ui/rooms/remote/shell.js (scope chip, Fade Time), src/effects/precipitation
---
Weather in Map Shine is a whole sky: clouds that drift and cast shadows, rain and snow that stop at the roofs, wind that bends trees and smoke, and fog that rolls in.

::: compare "**Docklands Warehouse**. Drag to compare: a clear afternoon, and the same hour under a thunderstorm sky. Only the weather changed."
![Clear](docklands-outdoors-msa.webp)
![Storm](docklands-storm.webp)
:::

[[do: wx-clear, wx-fog, wx-rain, wx-storm, wx-snow]]

### Where the controls are

The Remote's **Mix** tab holds the weather:

- **Moods** such as Clear, Fair, Overcast, Fog, Rain, Snow, Storm, Gale and Ashfall. Press one to head there.
- **Faders** for clouds, rain, wind, temperature and night darkness.
- **Set** holds the weather still. **Wander** lets it drift on its own within the mood.

### Fade Time

Changes ease in over the **Fade Time** set on the Play tab. **Now** snaps. A minute or two lets the players watch the storm roll in.

### This scene or every scene

The chip at the top of the Remote says **This scene** or **All scenes**. With **All scenes**, scenes share one sky, so moving between the tavern and the street keeps the same rain. With **This scene**, the scene keeps its own weather, which is right for a dungeon or another world.

### Making maps that weather well

- A good `_Outdoors` mask is everything: weather stops exactly at its black edges.
- Open ground, streets and courtyards show weather best. A map that is all roof will show very little.
- Add `_Water`. Rain rings and wind ripples on water are some of the best weather moments.
- Add `_Drip` along roof edges. Drips after rain sell the weather inside.
