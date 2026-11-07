---
sources: src/foundry/mask-discovery.js (naming, extensions, fallback, cache), src/scene/scene-readiness.js, src/ui/paint-mode-mask-list.js (Masks list)
---
Most effects only appear where a mask tells them to. No `_Water` file, no water. If an effect you expected is missing, one of these is the reason.

### 1. The scene has no `_Outdoors` mask

Map Shine needs `_Outdoors` on every floor. Without it, the Remote shows a **Scene readiness** card above its tabs, with buttons to paint one or import one.

[[do: open-painter]]

### 2. A mask's file name doesn't match the map

Mask files sit in the same folder as the map art and use the same name plus an ending:

| Map art | Its masks |
|---|---|
| `castle-ground.webp` | `castle-ground_Outdoors.webp`, `castle-ground_Water.webp` |

Capital letters don't matter. Spaces and spelling do. [The naming rules](page:learn-naming).

### 3. The mask is there, but the painter has a layer on top

Anything painted inside Map Shine wins over a file. In the painter, press **M**: the Masks list shows which masks are connected and lets you switch to each one to check it.

### 4. You just uploaded it

Map Shine remembers what it found for a few minutes. Press **Check again** on the readiness card, or reload with **F5**.

### 5. The effect is switched off

Open the Studio and check the effect's switch. Players can also turn effects off for themselves in **Performance & Graphics**.

[[do: open-studio]]

> [!note] On The Forge or other hosts where Map Shine cannot list folders, it looks only for `.webp`, `.png` and the art's own file type. Save masks as `.webp` or `.png` to be safe.
