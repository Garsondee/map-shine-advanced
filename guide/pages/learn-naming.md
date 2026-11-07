---
sources: src/foundry/mask-discovery.js (matchMaskFiles, EXTENSION_PREFERENCE, base-name fallback, cache), src/scene/mask-export.js (checkImportSize, planMaskFile), src/vt/mask-image.js (size cap)
---
### The one rule

**Mask name = map name + ending.** Same folder as the map.

| Map art | Mask |
|---|---|
| `tavern-ground.webp` | `tavern-ground_Outdoors.webp` |
| `tavern-upper.webp` | `tavern-upper_Outdoors.webp` |

Capital letters don't matter: `_outdoors` works too. Spelling and spaces do.

### File types

`.webp`, `.png` and `.jpg` all work. If two copies exist, Map Shine prefers the one with the same file type as the map, then `.webp`, then `.png`, then `.jpg`.

> [!warn] On The Forge, S3 and other hosts that don't let Map Shine list folders, it only looks for the map's own file type, `.webp` and `.png`. Use `.webp` or `.png` for masks and you'll never hit this.

### Size

- The mask must have the **same shape** (width to height) as the map. The size can differ: a half-size mask is fine and loads faster.
- Cover the map art only. Don't add Foundry's scene padding.
- The longest side can be up to 16384 pixels.

### Several maps that share masks

If nothing matches the full name, Map Shine tries again with the last `_part` removed. So `bridge_lower_wet.webp` can use `bridge_lower_Outdoors.webp`. Handy for variants of one map, like day and night versions.

### Floors and tiles

Map Shine looks for masks beside every floor's background, every floor's foreground and **every tile**. A tile can carry its own masks, named after the tile's image. A mask on a tile sits on top of the floor's mask in the same spot, so a tile can add a roof or open one up.

### Maps inside another module

You can't save files into another module's folder. When Map Shine saves a mask for a map like that, it uses a folder inside your world instead and remembers it for that scene.
