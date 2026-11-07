---
sources: src/scene/mask-catalog.js (fluid: rgba, red read), src/effects/fluid/fluid-net.js (flow from brightest, never ramp to black), src/effects/fluid/fluid.js
---
`_Fluid` fills **tubes, flasks and vats with glowing liquid** that flows, bubbles and lights the glass around it.

::: compare "**Wizards Lair / Laboratory** at night. Drag to compare: liquid runs through the alchemy glassware and glows."
![Plain art](lair-fluid-art.webp)
![Map Shine](lair-fluid-msa.webp)
:::

![The _Fluid mask](lair-fluid-mask.webp "The `_Fluid` mask for the glassware: every tube and flask is filled in.")

### How to read it

- **Black**: no liquid.
- **Any brightness above black**: liquid inside a tube or a vessel.
- **The brightest end is where the liquid flows from.** Map Shine runs it downhill from bright to dim.
- Map Shine reads only the red channel. Red or grey both work.

### Painting it

1. Fill the **inside** of each tube and flask, not the glass rim.
2. To set the flow, paint a gradient along each tube: bright at the source, dimmer at the far end.
3. Flasks and vats can be a flat fill. They bubble in place.

> [!warn] **Never fade all the way to black.** Black means "no liquid", so a gradient that reaches black cuts the tube off early. Stop at a dark grey.

### Tips

- Keep tubes **connected** on the mask. A gap of one pixel splits them into two separate tubes.
- The art underneath shows through. Glass art with clear centres looks best.
- Colours, glow and bubble speed are in **Studio → Effects → Fluid**.

The glassware in this example sits on a tile above the floor, with its own `_Fluid` mask named after the tile's image. That works for any mask. [Naming](page:learn-naming).

[[settings: fluid]]
