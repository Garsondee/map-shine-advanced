---
sources: src/effects/sun-shadows.js (strength01, lengthScale), src/scene/mask-catalog.js (outdoors), guide page mask-outdoors
---
Map Shine casts sun shadows from the buildings, trees and walls on your map. They move with the time of day.

### Too dark, or too long

[[do: shadows-lighter, shadows-darker, shadows-shorter]]

Shadows are longest at dawn and dusk. If they only bother you late in the day, try a different time instead:

[[do: time-noon, time-golden]]

### Shadows in the wrong place

Sun shadows come from the map's `_Outdoors` mask. Black areas on it are treated as buildings, so their edges cast the shadows.

- **A shadow falls from an open courtyard.** The courtyard is painted black (indoors) on the mask. Paint it white.
- **A building casts no shadow.** That building is painted white (outdoors). Paint it black.
- **Shadows look blocky or stepped.** The mask is very small compared with the map, or was scaled without smoothing.

[[do: open-painter]]

Read [the _Outdoors page](page:mask-outdoors) for how to paint it well.
