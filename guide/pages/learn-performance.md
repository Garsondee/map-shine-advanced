---
sources: src/ui/rooms/system-panel.js (Graphics quality, Render Resolution), effect manifests (tiers, cost), src/vt/mask-image.js, load/shader pass notes
---
Map Shine runs on the graphics card. Most computers made in the last few years handle it well. These habits keep it smooth for everyone.

### For map makers

- **Masks can be smaller than the map.** A half-size `_Outdoors` or `_Water` mask looks the same and loads faster. Keep full size only for fine detail like `_Specular` trim and `_Fire` dots.
- **Use `.webp`.** It's much smaller than `.png` and loads quicker.
- **Only add the masks a map needs.** Each mask adds a little loading time. An empty mask still costs time, so leave it out.
- **Very large maps** (over about 10000 pixels on a side) are the slowest to load. Splitting a huge map into Levels or separate scenes helps.

### For the table

- **Performance & Graphics**, from the scene controls on the left, is each player's own settings room.
- **Graphics quality** sets how much every effect does. Lower drops the costly extras first.
- **Render Resolution: Auto** quietly lowers the resolution when the frame rate drops and raises it again when it can.

### The first load

The first time a computer opens a scene, Map Shine prepares its shaders. It can take a while, and it's much quicker every time after. Open the session's scenes once before the players arrive.

### The heaviest effects

When a computer struggles, these give back the most:

[[do: cloudtops-off, dof-off, lens-off]]

These buttons change this computer only.
