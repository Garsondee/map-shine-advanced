# Feature Plan: Texture Manager UI (Separate Tweakpane Window)

## 1. Overview
The **Texture Manager UI** is a separate, draggable Tweakpane window opened via the existing button **“Open Texture Manager”**.

This UI has two primary goals:

### Goals
1. **Sanity-check / Debug View**: Show what textures/masks are currently discovered and actively used, so missing or miswired textures are obvious.
2. **Instructional Catalog**: Show textures/masks that *could* be supplied (by suffix convention) but are currently missing, including what they do and how they connect to effects.

---

## 2. Architecture

### 2.1 Class Structure
- **Class**: `TextureManagerUI`
- **Location**: `scripts/ui/texture-manager.js`
- **Instantiation**: Created by `TweakpaneManager.initialize()` and toggled by the button.

### 2.2 Data Sources (Authoritative)
The window should read from **two sources of truth**:

1. **Asset Suffix Registry** (What *could* exist)
   - **Location**: `scripts/assets/loader.js`
   - **Source**: `EFFECT_MASKS` entries (e.g. `_Specular`, `_Outdoors`, `_Fire`)
   - Used to populate the “Available / Missing” list.

2. **Runtime Mask Registry** (What *does* exist right now)
   - **Location**: `scripts/masks/MaskManager.js`
   - **Access**: `window.MapShine.maskManager`
   - **Records**: `MaskManager.getRecord(id)` provides metadata (space, source, dimensions, flipY, etc.).
   - Used to populate the “Found / In Use” list.

#### Notes on runtime IDs
Runtime registry currently contains a mix of:
- **Scene-space masks** loaded from assets:
  - `${maskId}.scene` (e.g. `outdoors.scene`, `specular.scene`)
- **Screen-space render targets** published by effects:
  - `roofAlpha.screen`, `outdoors.screen`, `windowLight.screen`, `cloudShadow.screen`, etc.
- **Derived masks** defined in `canvas-replacement.js`:
  - `indoor.scene`, `roofVisible.screen`, `roofClear.screen`, `precipVisibility.screen`

---

## 3. UI Design (Information Architecture)

### 3.1 Window Layout (Top-Level)
The Texture Manager pane should be split into 3 main folders:

1. **Summary**
2. **Found Textures (Live Registry)**
3. **Available / Missing Textures (Suffix Catalog)**

Optional (future) folder:
- **Debug / Tools** (refresh, copy report, open mask debug)

### 3.2 Summary Section
Purpose: answer “Is my scene set up correctly?” in under 10 seconds.

Recommended fields:
- **Scene Base Path**: what map base image path we detected (informational)
- **Found**: count of registry textures (total)
- **Found (Asset Masks)**: count of `*.scene` from `source: 'assetMask'`
- **Found (Render Targets)**: count of `*.screen` from `source: 'renderTarget'`
- **Derived**: count of `source: 'derived'`
- **Warnings**: e.g. “No `_Outdoors` found; indoor/outdoor features disabled”

### 3.3 Found Textures (Live Registry)
Purpose: show what the system is actually using right now.

#### Display format per entry
Each texture record should appear as a compact row with:
- **ID**: e.g. `outdoors.scene`
- **Source**: `assetMask` / `renderTarget` / `derived` / `unknown`
- **Space**: `sceneUv` vs `screenUv`
- **Size**: `width x height` (if known)
- **Channels**: expected primary channel(s) (e.g. `r`, `a`)
- **FlipY**: effective flip state (meta overrides vs texture flip)

#### “Used By” attribution
To meet the “what they are being used for” goal, each entry should include a **Used By** label.

Implementation approach (planning):
- Maintain a small static mapping in the UI layer:
  - `outdoors.scene` → “WeatherController roof/indoors; SkyColorEffect masking; indoor lighting decisions”
  - `specular.scene` → “SpecularEffect / PBR material”
  - `roughness.scene` → “SpecularEffect / PBR material”
  - `normal.scene` → “SpecularEffect / PBR material”
  - `iridescence.scene` → “IridescenceEffect”
  - `windows.scene` / `structural.scene` → “WindowLightEffect (mask input)” (depending on back-compat)
  - `fire.scene` → “FireSparksEffect (spawn positions / heat distortion mask)” (if applicable)
  - `roofAlpha.screen` → “LightingEffect roof alpha pre-pass; precipitation visibility; indoor light occlusion”
  - `windowLight.screen` → “WindowLightEffect output (screen-space additive)”
  - `cloudShadow.screen` → “CloudEffect output (screen-space)”
  - Derived masks should list their recipe (e.g. `roofVisible.screen = threshold(roofAlpha.screen)`)

This mapping is intentionally UI-only: it is documentation-by-code for creators.

#### Sorting / grouping
- Group by `space` then by `source`.
- Put `*.scene` above `*.screen` above derived.

### 3.4 Available / Missing Textures (Suffix Catalog)
Purpose: show creators what other masks they can add.

This should be generated from the suffix registry (`EFFECT_MASKS` in loader).

For each catalog entry:
- **Mask Name**: e.g. `Outdoors`
- **Expected Filename**: `BaseName_Outdoors.(webp|png|jpg|jpeg)`
- **Status**: Found / Missing
- **Used for**: short description that is user-facing (not internal)
- **Notes**: channel conventions, authoring tips

Example descriptions:
- `_Outdoors`: “Defines indoor vs outdoor areas. White = outdoors. Used by weather, roof logic, and outdoor-only grading.”
- `_Specular`: “Reflectivity mask. Bright = shiny.”
- `_Roughness`: “Surface roughness. Bright = rough/matte, Dark = smooth.”
- `_Normal`: “Normal map for surface detail. Must be authored as a normal map; treated as data (linear).”
- `_Windows`: “Window lighting sources. Used to project sunlight pools / interior window glow.”
- `_Structural`: “Legacy alternative to `_Windows` (back-compat).”
- `_Fire`: “Fire source locations. Used to spawn fire/embers/heat distortion.”

Additionally, include “Not Yet Implemented” tags where relevant.
- Example: loader lists `_Prism`, `_Water`, `_Dust`, but the effect may not be fully wired; the UI should be explicit.

---

## 4. Implementation Details

### 4.1 Refresh Model
This UI should be a **live inspector**.

Refresh triggers:
- **On open** (`toggle()` when becoming visible)
- **Manual refresh button** (“Refresh Now”)
- **On scene change** (optional; via a hook or by re-opening)

Refresh should:
- Rebuild the “Found Textures” list from `maskManager.listIds()` + `getRecord()`.
- Rebuild the “Catalog” list from the suffix registry.

### 4.2 Required exports / wiring
Right now `EFFECT_MASKS` in `loader.js` is not exported.

Plan options:
- **Option A (Preferred)**: export a read-only getter like `getEffectMaskRegistry()` from `loader.js`.
- **Option B**: duplicate a minimal registry in the UI (avoid if possible).

### 4.3 Dealing with Derived and Screen-Space masks
`MaskManager` already stores `meta.space` and `meta.source`.

The UI should treat them as first-class entries.
- Derived masks should show:
  - **Derived From**: recipe inputs
  - **Operation**: invert/threshold/max/blur/boost

If recipe introspection isn’t currently exposed, the UI can initially show:
- “Derived mask (see canvas-replacement.js definitions)”
and later we can add a `MaskManager.getRecipe(id)` API.

### 4.4 “Copy Report” (Optional but valuable)
Add a button that copies a markdown report to clipboard containing:
- Base path
- Found textures table
- Missing catalog entries
- Warnings

This is high leverage for bug reports.

---

## 5. Integration Steps

1. **Expand `TextureManagerUI`**
   - Replace placeholder “Texture Library” folder with the sections above.
2. **Expose suffix registry**
   - Add a safe export from `scripts/assets/loader.js`.
3. **Wire live data**
   - Read `window.MapShine.maskManager`.
   - Build display rows from `listIds()` + `getRecord()`.
4. **Add “Used By” mapping**
   - Keep mapping local to UI module.
5. **Add Refresh + Copy Report**

---

## 6. Future Considerations
- **Inline previews**: show small thumbnail previews of each texture (careful with perf/memory).
- **Open Mask Debug**: deep link into `MaskDebugEffect` controls by selecting a mask ID.
- **Validation rules**: detect obvious mistakes (wrong resolution, wrong color space, missing `_Outdoors` when weather enabled).
- **“Where loaded from”**: show exact file path when available (requires loader to store it in meta).
