---
sources: src/world/weather-data.js (WEATHER_ARCHETYPES), src/ui/rooms/remote/weather-board.js, src/ui/rooms/remote/shell.js (scope chip, Fade Time), src/effects/precipitation (ground-mist-render.js for fog), src/effects/lightning-storm.js + src/effects/lightning.js (Storm dials, lightning), src/foundry/world-clock.js (pause), src/world/air-grid.js + air-solver.js (wind round buildings)
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
- **Faders** for clouds, rain, fog, lightning, wind, temperature and night darkness.
- **Set** holds the weather still. **Wander** lets it drift on its own within the mood.

### Fog

The **Fog** mood, or the **Fog** fader, lays ground mist over the outdoors. It comes in soft banks with clear gaps, fills in as you raise it, and thins toward walls. It never goes indoors. Wind thins it and moves it along. It takes the light of the hour: white at noon, gold at dusk, and lamps glow in it at night. It never shortens a token's sight; it only makes the map harder to read.

### Wind round buildings

Wind flows round and over buildings like real air. It slows in front of a wall, speeds up past corners and through narrow gaps, and leaves a sheltered, swirling patch behind a building. Taller buildings leave a longer one. Through an open door it makes a short, gusty draught that dies away inside. A room with doors on both sides gets a real draught through it. A shut room stays still. Map Shine reads walls, doors and the roofs on `_Outdoors`; buildings count as about two storeys tall.

### Lightning

The **Storm** mood brings lightning; the **Lightning** fader sets how often it strikes. Most flashes are inside the cloud: the clouds glow and the land lights up. Some reach the ground with a bolt. Each strike flickers two to four times, lights the rain, and shines in through the windows: `_Window` light turns cold and streams away from the strike. At night every strike also throws its own hard shadows from buildings, trees and bushes, away from where it lands. **Strike** on the Play tab lands one now. The Lightning card's **Storm** dials set brightness, colour, bolts and shadows. Players who reduce flashing effects see none of it.

### Fade Time

Changes ease in over the **Fade Time** set on the Play tab. **Now** snaps. A minute or two lets the players watch the storm roll in.

When you pause the game, the whole world slows to a stop over a few seconds: rain hangs in the air, lightning waits, clouds and water hold still. A change you make while paused waits too, and eases in once you unpause. **Now** still lands at once.

### This scene or every scene

The chip at the top of the Remote says **This scene** or **All scenes**. With **All scenes**, scenes share one sky, so moving between the tavern and the street keeps the same rain. With **This scene**, the scene keeps its own weather, which is right for a dungeon or another world.

### Making maps that weather well

- A good `_Outdoors` mask is everything: weather stops exactly at its black edges.
- Open ground, streets and courtyards show weather best. A map that is all roof will show very little.
- Add `_Water`. Rain rings and wind ripples on water are some of the best weather moments.
- Add `_Drip` along roof edges. Drips after rain sell the weather inside.

### Every setting

[[settings: precipitation]]

[[settings: clouds]]

[[settings: cloudTops]]
