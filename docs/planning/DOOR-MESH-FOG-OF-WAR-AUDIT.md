# Door meshes ↔ Fog of War (FogOfWarEffectV2) — full breakdown

This document describes how Map Shine’s **Three.js door meshes** (`DoorMeshManager`) interact with **V2 fog**, where things can go wrong, and what was fixed (2026-03-20).

---

## 1. Two separate systems

| System | Role |
|--------|------|
| **DoorMeshManager** | Loads door textures, creates `THREE.Mesh` planes per wall, animates open/close from `wall.document` (`ds`, `animation`). Meshes live on the **FloorRenderBus** scene in V2 (`DOOR_BASE_Z_V2`). |
| **FogOfWarEffectV2** | Renders **vision** into an RT (white = visible), **exploration** accumulation, and the **fog plane** compositing. It does **not** read the door texture directly; it only needs **where the door leaf blocks line-of-sight** during a **transition**. |

Fog does **not** sample the door mesh’s pixels. It builds **1D segments** (or quads for overlays) that approximate the **door panel** in **Foundry canvas space** for LOS.

---

## 2. Coordinate spaces (must stay consistent)

- **Foundry walls**: `document.c = [ax, ay, bx, by]` in **canvas space** (Y down).
- **DoorMeshManager** uses `Coordinates.toWorld` / positions in **Three world** (X right, Y up, Z for layering).
- **VisionPolygonComputer** and **vision mask** polygons use **Foundry** coordinates; the vision **ortho camera** uses **scene-local** space = Foundry minus `sceneRect` offset.
- **Fog door segments** convert mesh endpoints with `Coordinates.toFoundry` so synthetic “walls” match `VisionPolygonComputer`.

If any step mixed **world X/Y** with **Foundry** without conversion, segments would be wrong for **all** animation types (swing and slide).

---

## 3. Frame order (why mesh pose is usually current)

From `EffectComposer.render`:

1. **Updatables** run (includes **`DoorMeshManager.update`** → advances door animation progress).
2. **`FloorCompositor.render`** → **`FogOfWarEffectV2.update`** → **`_renderVisionMask`** reads **`mesh.matrixWorld`** after door positions updated.

So the fog pass generally sees the **same frame** as the rendered door mesh (no extra lag from ordering).

---

## 4. Door → fog sync pipeline (high level)

### 4.1 Starting a “door fog transition”

- Hook: **`Hooks.on('updateWall', …)`** → **`_onDoorWallUpdated(doc, changes)`**.
- Previously required **`'ds' in changes`** exactly. **Foundry often nests updates** under **`changes.diff.ds`**, so **no transition** was recorded → **no** `_doorFogTransitions` entry → **no** animated LOS or overlays.
- **Fix:** treat door state as changed when **`ds`** appears on **`changes`** **or** on **`changes.diff`** (`wallChangesIncludeDoorState`). Authoritative next state comes from **`doc.ds`** after the update.

### 4.2 While `_doorFogTransitions` has an entry

- **`FogOfWarEffectV2.update`** sets **`_needsVisionUpdate = true`** each frame so the vision RT refreshes during the easing window.
- **`_getDoorFogTransitionState`** interpolates **`openFactor`** (eased) between **`fromState`** and **`toState`** until duration elapses, then removes the entry.

### 4.3 Building LOS for doors in motion

1. **`_getDoorTransitionLeafSegmentsFoundry(doc, openFactor)`**  
   - **Primary:** **`doc` + `openFactor`** math (`_computeDoorLeafSegmentsDocMath`) — same eased progress as **`_getDoorFogTransitionState`**, aligned with **`DoorMeshManager`** formulas.  
   - **Fallback:** live mesh **bbox × `matrixWorld`** (`_computeDoorLeafSegmentsMeshBbox`) only if doc math yields nothing.  
   - Math-first avoids mesh/timer desync and bad bbox segments that can seal the whole portal; it also matches fog transition time.

2. **`_buildDoorTransitionBlockingWalls`**  
   - Produces **fake wall-like objects** `{ document: { c: [x0,y0,x1,y1], sight, light, door: NONE, … } }` for **`VisionPolygonComputer`**.

3. **Critical merge with real walls**  
   - **`polygonWalls`** is **`canvas.walls.placeables`** **minus** walls whose ids are in **`transitioningDoorWallIds`**.  
   - **`polygonWallsWithDoors`** = **`polygonWalls` + synthetic blockers** (when any blockers exist).

### 4.4 Fundamental bug (fixed): stripping real walls without replacements

**Previous behavior:** every wall with an **active** transition was added to **`transitioningWallIds`** **before** checking whether **any** synthetic segment was produced.

If segment generation failed (bbox degenerate, missing mesh, etc.), the **real wall was still removed** from **`polygonWalls`**, but **no** synthetic segment was added. **`VisionPolygonComputer`** already **skips open doors** (`door > 0 && ds === OPEN`). During an open animation the door is often **already open** in data → **no** edge along the doorway → **LOS and fog jump** or show wrong visibility. This affected **swing and slide** alike.

**Fix:** only **`transitioningWallIds.add(wallId)`** when **`segments.length > 0`** for that wall. If we cannot build a leaf segment, we **keep** the real wall in the wall list (still imperfect if `ds` is open, but we no longer **delete** the only geometry and inject nothing).

---

## 5. Who actually uses the synthetic door segments?

### 5.1 Tokens with **360°** sight (custom LOS path)

- **`_computeTokenVisionPolygonPoints`** is called with **`polygonWallsWithDoors`** → **synthetic segments** are **raycast** as walls → **animated** door line **if** segments are non-empty.

### 5.2 Tokens with **cone** or non‑360 sight

- Code uses **Foundry** `visionSource.los` / `shape` **points** → those polygons **do not** include our synthetic walls.  
- **Door transition overlays** are **closing-only** (white strip). **Opening** has no raster overlay; cone / Foundry-LOS tokens still do not get synthetic segments in their polygons (known limitation).

### 5.3 Custom polygon **fails** (`customPoints` null / &lt; 6 points)

- Execution **falls through** to the **Foundry LOS** branch → **same** as cone: **no** synthetic door walls in the polygon.

---

## 6. DoorMeshManager map keys

**`doorMeshes`** uses **`String(wallId)`** keys. Lookups must use the same; otherwise **no** mesh → **fallback** only (or empty segments if fallback also fails).

---

## 7. Fog shader vs vision RT (`visible`)

- Fragment shader uses **`fogAlpha = 1.0 - visible`** where **`visible`** comes from the vision texture (or SDF). **`visible = 0`** ⇒ **full fog strength** on that pixel; unexplored tint makes the doorway read as **opaque** black fog.
- **Black** quads drawn into the vision RT during door **opening** were intended as a local mask but set **`visible = 0`** along (and sometimes around) the door. Combined with **VisionSDF**, that could make the **whole doorway** read as solid fog so nothing beyond the frame was visible — no way to **see** the animated LOS edge.
- **Fix:** no opening raster overlay; opening is driven only by **animated synthetic LOS segments**. **White** quads on **closing** may remain for a softer re-occlusion.

## 8. Exploration vs vision

- Exploration uses **`max()`** of prior exploration and current vision mask.  
- If the **vision** mask animates smoothly, exploration **accumulates** that animation. If vision **jumps**, exploration **jumps**. Fixing **vision** during door transitions is prerequisite for “smooth” revealed fog.

---

## 9. Quick runtime checks

- **`FogOfWarEffectV2.diagnose()`** (if exposed in your build): **`doorFogSyncEnabled`**, **`bypassFog`**, controlled tokens, exploration loaded.  
- **`window.MapShine.doorMeshManager.doorMeshes`** — keys should be strings; entries should exist for walls with **`animation.texture`**.  
- Temporarily log **`_doorFogTransitions.size`** and **`_buildDoorTransitionBlockingWalls` blocker count** during a door click.

---

## 10. Related files

- `scripts/scene/DoorMeshManager.js` — mesh animation, **`wallKey`**, textures.  
- `scripts/compositor-v2/effects/FogOfWarEffectV2.js` — transitions, segments, vision RT, overlays.  
- `scripts/vision/VisionPolygonComputer.js` — segment tests; **skips** `door > 0 && ds === OPEN`.  
- `scripts/effects/EffectComposer.js` — updatable order vs **`FloorCompositor`**.
