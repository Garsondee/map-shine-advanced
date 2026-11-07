---
sources: src/ui/rooms/system-panel.js (Graphics quality, Render Resolution), src/effects/clouds/cloud-tops.js, src/effects/depth-of-field.js, effect manifests (tiers)
---
Map Shine does a lot of work on the graphics card. A big map on a modest laptop can stutter.

### The quickest wins

These are the effects that cost the most for the least:

[[do: cloudtops-off, dof-off, lens-off]]

They change this computer only, so try them on the computer that is slow.

### Each player's own settings

Every player can open **Performance & Graphics** from the scene controls on the left. The two settings that matter most:

- **Graphics quality.** Lower drops the costly extras from every effect.
- **Render Resolution.** **Auto** lowers the resolution only when the frame rate drops. Pick a fixed lower value on a weak laptop.

### The first load is the slowest

The first time a scene opens on a computer, Map Shine builds its shaders. That can take a while. The next load of the same scene is much quicker.

> [!tip] Open your session's scenes once before the players arrive. The work is done, and their first load is quicker too.

### Still slow?

Turn Map Shine off for one player while you sort it out: the **⋯** menu on the Remote has **Stop Map Shine until reload** for this computer. [Turn it all off](page:fix-emergency) covers the whole table.
