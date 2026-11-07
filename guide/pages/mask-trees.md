---
sources: src/scene/mask-catalog.js (tree, bush: rgba), src/effects/vegetation.js (detectSelfVegetationKind, VEGETATION_PARAMS), vegetation-render.js
---
`_Tree` and `_Bush` are different from the other masks: they are **the plants themselves**, painted in full colour on a transparent background. Map Shine lifts them off the map, sways them in the wind and casts soft shadows beneath them.

::: gallery
![Map Shine](bank-trees-msa.webp "**Big Bank**: palms swaying over the garden, with shadows on the ground.")
![_Tree file](bank-trees-mask.webp "The `_Tree` file for that corner: just the canopies, everything else transparent (shown as a checkerboard).")
:::

### Making one

1. Copy the canopy layer of your trees out of the map, or paint the canopies on their own layer.
2. Keep the leaves in **full colour** and make everything else **transparent**.
3. Export as `.webp` or `.png` with transparency, named `<map>_Tree` or `<map>_Bush`.

Use `_Tree` for tall canopies, which stand higher and throw longer shadows, and `_Bush` for low shrubs.

### Two ways to add them

- **Beside the map**, like any mask: `garden_Tree.webp` next to `garden.webp`.
- **As a tile**: a tile whose own image is called `something_Tree.webp` is treated as a tree. Handy for placing single trees by hand.

### Tips

- **Clean edges.** A soft, anti-aliased edge sways well. A hard fringe of background colour shows as a halo.
- **The ground under the canopy should still look right**, because the canopy moves and shows a little of what's below. Paint some shade or grass there in the base map.
- Plants under a roof (black on `_Outdoors`) are sheltered from the wind.
- Map Shine's painter can't create these. Import them as files.
- Height, sway and shadow are in **Studio → Effects → Vegetation (trees & bushes)**.
