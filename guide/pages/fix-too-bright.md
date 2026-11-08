---
sources: src/effects/grade/grade.js (exposure), src/effects/bloom.js (strength, enable, glare budget), src/effects/window/window.js (strength), src/effects/dynamic-range.js (drama), src/effects/lens.js (Glare), src/core/looks-schema.js (camera Looks)
---
The picture looks washed out, white areas have lost their detail, or every light wears a foggy halo.

### Too bright overall

[[do: darken, brighten]]

### Too much glow round lights

That haze is **Bloom**, the camera's glare. Only light brighter than the picture can show glows, and only a small share of it, so a halo should hug the light. Maps with many lamps are eased down automatically.

[[do: bloom-softer, bloom-off, bloom-on]]

For a quieter camera all round, play the **Subtle** or **Clean** Look in the Remote's **Camera** group. Dirt, starbursts and streaks are on the **Lens** card's **Glare** settings.

> [!tip] Turning Bloom off is on this computer only. Use **Less glow** if the whole table should see the change.

### Sunlight through windows is blinding

Window light follows the time of day and the weather. At noon on a clear day it is at its strongest.

[[do: window-softer, window-stronger]]

### Contrast is harsh

**Drama** controls how hard the bright parts push against the dark parts.

[[do: less-drama, more-drama]]
