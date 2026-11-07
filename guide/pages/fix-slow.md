---
sources: src/ui/rooms/system-panel.js (Graphics quality, Render Resolution), src/effects/clouds/cloud-tops.js, src/effects/depth-of-field.js, effect manifests (tiers)
---
Map Shine does a lot of work on the graphics card. A big map on a modest laptop can stutter.

### The quickest wins

These are the effects that cost the most for the least:

[[do: cloudtops-off, dof-off, lens-off]]

These change only your own screen. If a player is the one stuttering, ask them to lower **Graphics quality** (below).

### Each player's own settings

Every player can open **Performance & Graphics** from the scene controls on the left. The two settings that matter most:

- **Graphics quality.** Lower drops the costly extras from every effect.
- **Render Resolution.** **Auto** lowers the resolution only when the frame rate drops. Pick a fixed lower value on a weak laptop.

### The first load is the slowest

The first time a scene opens on a computer, Map Shine has to prepare its effects. That can take a while. The next load of the same scene is much quicker.

> [!tip] Open your session's scenes once before the players arrive. The work is done, and their first load is quicker too.

### Still slow?

To check whether Map Shine is the cause, the **⋯** menu on the Remote has **Stop Map Shine until reload**. It stops Map Shine on your own computer only. [Turn it all off](page:fix-emergency) covers the whole table.
