---
sources: src/scene/mask-catalog.js (outdoors: required, transparent = unpainted), src/world/air-grid.js (roofs, doors), src/ui/rooms/remote/readiness-card.js, src/ui/paint-mode.js
---
Rain, snow and cloud shadows stop at the edge of a roof, and wind only comes in through open doors. Map Shine finds roofs on the map's `_Outdoors` mask: **white is open sky, black is under a roof.** Weather indoors means that room is white, or not painted, on the mask.

### Right now, mid-session

Stop the weather while you fix it later:

[[do: wx-clear, wx-overcast]]

### Fix it properly

[[do: open-painter]]

1. In the painter, press **M** to open the Masks list and pick `_Outdoors`.
2. Turn on **Clean view** to see the plain map art.
3. Paint the room black. The **Room** tool fills a room bounded by walls in one click.
4. **Save next to map**, so the fix is a real file beside the map art.

> [!warn] **Transparent is not black.** A transparent area on `_Outdoors` means "not painted here", and Map Shine reads it as open sky. Paint indoor areas solid black, with no transparency.

### Is it only one floor?

Each floor needs its own `_Outdoors` mask. If the ground floor is right and the floor above is wrong, it is that floor's mask that needs painting.

![The _Outdoors mask of the Docklands Warehouse: white is open sky, black is under a roof](docklands-outdoors-mask.webp "The `_Outdoors` mask of **Docklands Warehouse**. Every black shape is a roof.")

More in [the _Outdoors page](page:mask-outdoors).
