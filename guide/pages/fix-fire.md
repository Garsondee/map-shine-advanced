---
sources: src/effects/fire/fire.js (flameSize, smokeDensity, enable), src/effects/fire/fire-mask.js (width sets size)
---
Fire and smoke grow from the map's `_Fire` mask. Each painted shape becomes one fire, sized by how wide the paint is.

### Bigger or smaller

[[do: fire-smaller, smoke-less, fire-bigger]]

### Off for now

[[do: fire-off, fire-on]]

> [!note] **Fire off** is on this computer only. To calm the fire for the whole table, use **Smaller flames** and **Less smoke**.

### Fire where there shouldn't be any

That spot is painted on the `_Fire` mask. Faint, half-erased paint still counts. Open the mask in your image editor and clean it to pure black.

### Lots of tiny fires instead of one big one

A thin painted line becomes a row of small flames. A round blob becomes one bonfire. To get one big fire, paint one wide shape. [More about _Fire](page:mask-fire).

### Rain puts it out

Fires outdoors are doused by heavy rain and rekindle after a dry spell. That is on purpose. It only happens under open sky, so a fire under a roof keeps burning.
