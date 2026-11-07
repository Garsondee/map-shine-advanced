---
sources: src/effects/depth-of-field.js (enable), src/effects/lens.js (enable, grainAmount, chromaticAmountPx), Performance & Graphics room (src/ui/rooms/system-panel.js)
---
Map Shine has a few camera effects that copy real lenses. They suit cinematic moments, but not every table wants them.

### Blurry floors below

**Depth of Field** softens floors below the one you are looking at, like a camera focusing on the nearest floor.

[[do: dof-off]]

### Grain, fringes or dark corners

These come from **Lens**: film grain, colour fringing at the edges, and a vignette.

[[do: grain-off, fringe-off, lens-off, lens-on]]

### Soft everywhere, or at the edges when you pan

That is usually **Render Resolution**. When a computer struggles, Map Shine draws fewer pixels to keep the frame rate up. Open **Performance & Graphics** from the scene controls on the left and set **Render Resolution** to a fixed value, or set **Graphics quality** higher if the computer can take it.

> [!note] **Depth blur off** and **Lens effects off** are on this computer only. Each player has their own switches in **Performance & Graphics**.
