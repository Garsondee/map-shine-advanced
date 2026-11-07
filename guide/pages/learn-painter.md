---
sources: src/ui/paint-mode.js, src/ui/paint-mode-toolbar.js, src/ui/paint-mode-mask-list.js, src/ui/mask-file-actions.js, src/scene/mask-export.js, src/ui/rooms/studio/painter-department.js
---
Map Shine has its own mask painter, so you can make masks without leaving Foundry. It suits greyscale masks best, and `_Outdoors` most of all.

[[do: open-painter]]

### The tools

- **Brush and eraser**, with size and softness.
- **Rectangle and polygon shapes** that snap to the grid, square or hex. Fast for buildings.
- **Fill room**: click inside a room bounded by walls and it is filled in one go.
- **Start from walls**: builds a first `_Outdoors` mask from the scene's walls. Tidy it up, don't start blank.
- **Clean view**: hides every effect and shows the plain map art, so you can see what you're painting over.
- **Overlay opacity**: how strongly the mask is tinted over the map while you paint.

### Switching masks

Press **M** (or **☰ Masks**). The list shows every mask Map Shine can use, which ones this map already has, and lets you jump to another. If you have unsaved paint, it asks first.

### Keeping your work

- **Save next to map** writes a full-size mask file beside the map art, named correctly. This is the best way: the mask becomes a real file you can back up and share.
- **Download** saves the full-size mask to your computer, to finish in an image editor.
- **Import** loads a mask file from your computer and lines it up with the map for you.

> [!tip] A good routine: block out `_Outdoors` with **Start from walls** and **Fill room**, **Download** it, polish the edges in your image editor, then **Import** it back.

### What the painter can't do

- Colour masks such as `_Specular` and `_Window` need an image editor.
- `_Tree` and `_Bush` are pictures of the plants themselves, so they must be imported.

> [!note] Paint done in the painter wins over a mask file of the same kind. If an uploaded file seems to do nothing, check the painter isn't covering it.
