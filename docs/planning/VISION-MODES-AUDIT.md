# Vision Modes — Full Audit

**Date:** 2026-03-17  
**Scope:** Foundry VTT core, PF2e, D&D 5e, MapShine Advanced current state  
**Sources examined:**  
- `foundryvttsourcecode/resources/app/client/canvas/perception/vision-mode.mjs`  
- `foundryvttsourcecode/resources/app/client/canvas/perception/detection-mode.mjs`  
- `foundryvttsourcecode/resources/app/client/canvas/perception/detection-modes/*.mjs`  
- `foundryvttsourcecode/resources/app/client/canvas/sources/point-vision-source.mjs`  
- `foundryvttsourcecode/resources/app/client/config.mjs` (Canvas.visionModes / detectionModes block)  
- `gamesystemsourcecode/dnd5e/dnd5e.mjs`  
- `gamesystemsourcecode/pf2e/pf2e.mjs`  
- `scripts/compositor-v2/effects/VisionModeEffectV2.js`  
- `scripts/vision/VisionManager.js`  
- `scripts/vision/VisionPolygonComputer.js`  
- `scripts/vision/FogManager.js`  
- `scripts/compositor-v2/effects/FogOfWarEffectV2.js`  
- `scripts/core/game-system.js`  

---

## Part 1 — How Foundry VTT Handles Vision Modes

### 1.1 Two Orthogonal Systems

Foundry maintains **two distinct but cooperating systems** that are frequently confused:

| System | Class | Purpose |
|---|---|---|
| **VisionMode** | `canvas.perception.VisionMode` | *How the scene looks* from a token's POV — post-processing, shader swaps, tinting |
| **DetectionMode** | `canvas.perception.DetectionMode` | *What a token can detect* — range, LOS, special rules per sense type |

A single token may have one VisionMode (its primary sight appearance) and multiple DetectionModes (each sense is its own mode with its own range and rules).

---

### 1.2 VisionMode — Schema & Architecture

`VisionMode` extends `DataModel`. The full schema is:

```
id            string          Unique key e.g. "darkvision"
label         string          Localisation string
tokenConfig   boolean         Show in token config UI (blindness = false)
canvas        { shader, uniforms }          Affects the base canvas sampler
lighting      {
  background  { visibility, postProcessingModes, uniforms }
  coloration  { visibility, postProcessingModes, uniforms }
  illumination{ visibility, postProcessingModes, uniforms }
  darkness    { visibility, postProcessingModes, uniforms }
  levels      { LIGHTING_LEVEL → LIGHTING_LEVEL }     Level remaps e.g. DIM→BRIGHT
  multipliers { LIGHTING_LEVEL → number }
}
vision        {
  background  { shader, uniforms }
  coloration  { shader, uniforms }
  illumination{ shader, uniforms }
  darkness    { adaptive: boolean }          If false, ignores global darkness
  defaults    { color, attenuation, brightness, saturation, contrast }
  preferred   boolean                        Prioritised over other modes
}
```

**`LIGHTING_VISIBILITY`** controls per-layer render participation:
- `DISABLED (0)` — layer is skipped entirely, shaders have no say
- `ENABLED (1)` — layer renders, shader decides visibility
- `REQUIRED (2)` — layer always renders regardless of shader

**Lifecycle hooks**: `activate(source)` / `deactivate(source)` — called when the active VisionMode changes on a `PointVisionSource`. Subclasses implement `_activate` / `_deactivate` for custom setup.

**`animate(dt)`**: Called each ticker tick when `animated: true`. Used by tremorsense to drive wave shader uniforms.

---

### 1.3 Built-in Vision Modes (Foundry Core)

| ID | Label | Key Behaviour |
|---|---|---|
| `basic` | Basic Vision | No adjustments. `preferred: true` — takes priority if multiple tokens. `adaptive: true` darkness. |
| `darkvision` | Darkvision | Saturation −1.0 (greyscale canvas). DIM lighting level remapped → BRIGHT. Background layer REQUIRED. `adaptive: false`. |
| `monochromatic` | Monochromatic | Full desaturation via SATURATION post-processing on all three lighting layers. Unlike darkvision it does NOT remap lighting levels. |
| `blindness` | Blindness | All three lighting layers DISABLED. Very dark/desaturated defaults (brightness −1, saturation −1, contrast −0.5). `tokenConfig: false` — not selectable by users, assigned programmatically. |
| `tremorsense` | Tremorsense | All lighting layers DISABLED. Animated wave shaders on background + coloration. Defaults: contrast +0.2, saturation −0.3, brightness +1. |
| `lightAmplification` | Light Amplification | Green tinted (0.38, 0.8, 0.38). Requires background, SATURATION + EXPOSURE post-processing. DIM→BRIGHT, BRIGHT→BRIGHTEST level remap. Non-adaptive. |

---

### 1.4 DetectionMode — Schema & Architecture

`DetectionMode` extends `DataModel`. Minimal schema:

```
id          string    Unique key
label       string    Localisation string
tokenConfig boolean   Show in token config UI
walls       boolean   Constrained by walls (false = passes through walls)
angle       boolean   Constrained by vision angle (false = omnidirectional)
type        number    SIGHT(0) | SOUND(1) | MOVE(2) | OTHER(3)
```

**Key method chain**: `testVisibility(visionSource, mode, config)` → `_canDetect(visionSource, target)` → `_testPoint(range + LOS)` → `_testRange` + `_testLOS` / `_testAngle`

**Status effect awareness** in `_canDetect`:
- SIGHT type: fails if source is BLIND or target is INVISIBLE
- Any type: fails if source/target is BURROW (unless `walls: false`)

**Optional visual filter**: `static getDetectionFilter()` — returns a PIXI filter applied on the detected token's appearance (e.g. pulsing outline for tremor, glow for see-invisibility).

---

### 1.5 Built-in Detection Modes (Foundry Core)

| ID | Class | Type | Walls | Angle | Special |
|---|---|---|---|---|---|
| `lightPerception` | `DetectionModeLightPerception` | SIGHT | ✓ | ✓ | Target must be inside a light source (`canvas.effects.testInsideLight`) |
| `basicSight` | `DetectionModeDarkvision` | SIGHT | ✓ | ✓ | Standard LOS sight; blocks on BLIND/BURROW/INVISIBLE |
| `seeInvisibility` | `DetectionModeInvisibility` | SIGHT | ✓ | ✓ | Only detects INVISIBLE tokens; blocked by BLIND |
| `senseInvisibility` | `DetectionModeInvisibility` | OTHER | ✗ | ✗ | Wallless omni sense; only detects INVISIBLE |
| `feelTremor` | `DetectionModeTremor` | MOVE | ✗ | ✗ | Cannot detect FLY or HOVER tokens; magenta outline filter |
| `seeAll` | `DetectionModeAll` | SIGHT | ✓ | ✓ | Detects anything; blocked by BLIND |
| `senseAll` | `DetectionModeAll` | OTHER | ✗ | ✗ | Wallless omni; detects anything |

---

### 1.6 PointVisionSource — How Modes Are Applied

`PointVisionSource` is the runtime object Foundry creates per-token. Key behaviour:

- `_updateVisionMode()` — resolves `this.visionMode` from `CONFIG.Canvas.visionModes[data.visionMode]`; checks `blinded.darkness` (is the token inside a darkness source?); overrides to `blindness` mode if blinded
- `_configure(changes)` — calls `visionMode.activate(this)`
- `_configureShaders()` — swaps in vision-mode-specified shaders per layer
- `_configureLayer(layer, layerId)` — caches `vmUniforms` from the mode's layer definition
- `_updateCommonUniforms()` — binds `depthTexture`, `primaryTexture`, `darknessLevelTexture` every frame

**Two independent polygons per source**:
- `this.los` — Unconstrained LOS polygon (full scene radius)
- `this.light` — Light perception polygon (may be smaller if `lightRadius` is limited)
- `this.shape` (= `this.fov`) — Restricted FOV polygon (clamped to `radius`)

---

## Part 2 — How PF2e Handles Vision Modes

### 2.1 Architecture Overview

PF2e does **not** define custom `VisionMode` entries in `CONFIG.Canvas.visionModes`. Instead it:
1. Maps its senses to **Foundry's built-in vision modes** at token preparation time
2. Registers **custom DetectionModes** in `CONFIG.Canvas.detectionModes` for PF2e-specific senses
3. Uses its own perception system (`actor.system.perception`) as the data source for sense ranges

### 2.2 Actor Sense Data Model

PF2e actors expose sense data at:

```
actor.system.perception.vision         boolean   Basic vision enabled (true = unlimited in bright light)
actor.system.perception.senses[]       array     [{type, range, acuity}]
  .type    "darkvision" | "lowLightVision" | "scent" | "tremorsense" | "wavesense" | "blindsense" | "deathSense" ...
  .range   number | null               null = unlimited
  .acuity  "precise" | "imprecise" | "vague"
```

### 2.3 Vision Mode Mapping in PF2e

PF2e's token preparation logic maps senses to Foundry modes:

| PF2e Sense | Foundry VisionMode | Foundry DetectionMode(s) |
|---|---|---|
| Normal vision (daylight) | `basic` | `lightPerception` + `basicSight` |
| `lowLightVision` | `lightAmplification` | `basicSight` with extended range |
| `darkvision` | `darkvision` | `basicSight` in darkness |
| `scent` | `basic` (canvas unchanged) | Custom `pf2e-scent` (imprecise, SOUND/OTHER type, no walls) |
| `tremorsense` | `tremorsense` (on primary view) | Custom `pf2e-tremorsense` (MOVE type, no walls) |
| `blindsense (precise)` | `basic` | Custom `pf2e-blindsense` (SIGHT type, no walls/angle) |
| `wavesense` | `basic` | Custom `pf2e-wavesense` (MOVE type, no walls) |
| `deathSense` | `basic` | Custom `pf2e-deathSense` (OTHER type) |

### 2.4 PF2e-Specific Behaviours

- **Low-light vision**: Treats dim light as bright light — achieved via `lightAmplification` mode's `DIM→BRIGHT` level remap.
- **Darkvision**: Full greyscale in darkness — standard Foundry `darkvision` mode.
- **Imprecise senses** (scent, wavesense, tremorsense): Apply a visual detection filter (shimmer/outline) on detected tokens to signal "imprecise awareness", not full sight.
- **Detection mode acuity**: Precise senses reveal the token normally; imprecise show an outline only; vague senses reveal a presence indicator. Foundry's filter system (`getDetectionFilter()`) drives this.
- **Unlimited vision range**: `actor.system.perception.vision = true` uses a very large radius (effectively infinite); range of 0 in `token.document.sight.range` is PF2e's sentinel for "unlimited".

---

## Part 3 — How D&D 5e Handles Vision Modes

### 3.1 Architecture Overview

D&D 5e stores its vision sense data under `actor.system.attributes.senses`:

```
senses.darkvision    number | null   Range in ft
senses.blindsight    number | null   Range in ft
senses.tremorsense   number | null   Range in ft
senses.truesight     number | null   Range in ft
```

These are defined in `dnd5e.mjs` as a `SensesField` schema. Sense range references live under `DND5E.senses` and rule references link to Compendium Journal entries.

### 3.2 Vision Mode Mapping in D&D 5e

D&D 5e's token preparation maps senses to Foundry's built-in modes:

| D&D 5e Sense | Foundry VisionMode | Foundry DetectionMode(s) |
|---|---|---|
| Normal sight (no special sense) | `basic` | `lightPerception` + `basicSight` |
| Darkvision | `darkvision` | `basicSight` with darkvision range |
| Blindsight | `basic` | `basicSight` extended range (walls still apply) |
| Tremorsense | `tremorsense` | `feelTremor` (no walls, no angle, MOVE type) |
| Truesight | `basic` | `seeAll` + `seeInvisibility` within truesight range |

### 3.3 D&D 5e-Specific Behaviours

- **Darkvision radius only**: Only the darkvision range grants the greyscale vision mode. Normal sight outside that range is `basic`.
- **Multiple senses per token**: A D&D 5e token can have darkvision AND blindsight simultaneously — these are configured as separate DetectionMode entries on the token's detection modes list, each with their own range.
- **Truesight**: Grants `seeAll` (sees through magical darkness) and `seeInvisibility` DetectionModes within the truesight radius.
- **Blindsight does NOT change visual appearance**: It uses `basicSight` detection logic with wall constraints, just at higher range. No special visual mode.
- **Compendium browser integration**: D&D 5e adds a `hasDarkvision` filter in the Compendium browser, checking `system.senses.darkvision > 0`.

---

## Part 4 — MapShine Current State

### 4.1 Vision Mode Post-Processing (VisionModeEffectV2)

**File**: `scripts/compositor-v2/effects/VisionModeEffectV2.js`  
**Pipeline position**: Post-processing pass in FloorCompositor, after scene accumulation  

**What works:**
- Resolves active vision mode from `canvas.effects.visionSources` (active, non-preview sources only)
- GM-exempt: always stays in `basic`, no false visual mode on NPC selection
- Smooth lerped transitions between modes (`lerpSpeed = 6.0`)
- Handles: `basic`, `darkvision` (greyscale), `monochromatic`, `lightAmplification` (green tint), `tremorsense`, `blindness` via saturation/brightness/contrast uniforms
- Reads `vision.defaults` from `CONFIG.Canvas.visionModes[modeId]` — forward compatible with custom system modes

**Gaps:**
1. **No wave animation for tremorsense** — Foundry uses `WaveBackgroundVisionShader` (animated GLSL). MapShine applies static shader adjustments only. The "rippling sonar" aesthetic is absent.
2. **No `lightAmplification` scan-line effect** — Foundry uses `AmplificationSamplerShader` which has a scan-line / amplification visual. MapShine only applies the green tint.
3. **Tint is hardcoded for `lightAmplification`** — reads `vision.defaults.saturation` from CONFIG but manually hardcodes `(0.38, 0.8, 0.38)` instead of reading `canvas.uniforms.tint`. Custom system modes that change the tint colour will be ignored.
4. **`uStrength` binary toggle** — either 0 (basic) or 1 (any other mode). Intermediate/blended rendering is not possible.
5. **No `LIGHTING_VISIBILITY.DISABLED` enforcement** — Foundry's tremorsense and blindness disable all lighting layers; MapShine can't enforce this because it has its own lighting pipeline.

---

### 4.2 Vision Polygon / LOS Computation (VisionManager + VisionPolygonComputer)

**Files**: `scripts/vision/VisionManager.js`, `scripts/vision/VisionPolygonComputer.js`  

**What works:**
- Raycasting LOS algorithm (Red Blob Games visibility polygon)
- Wall collision + door-state filtering
- Scene bounds clipping to prevent vision leaking into padding
- Wall-height elevation filtering (Levels integration, MS-LVL-072)
- Directional wall support (one-way walls)
- Adaptive throttling (fast during movement, slow when idle)
- Object pooling to avoid GC pressure on hot paths
- Controlled-token-only optimisation (no per-frame vision for every token)

**Gaps:**
1. **No vision mode differentiation** — all controlled tokens compute one polygon at the same radius regardless of whether they have darkvision, tremorsense, etc. Darkvision should see further in darkness.
2. **No separate light perception polygon** — Foundry has `los`, `light`, and `shape` (fov) as three independent polygons. MapShine uses only one polygon per token.
3. **No DetectionMode awareness** — tremorsense should contribute a separate, wall-ignoring polygon to fog computation. Blindsight should show through walls.
4. **Vision radius for D&D 5e collapses all senses** — `DnD5eAdapter.getTokenVisionRadius()` returns `Math.max(darkvision, blindsight, tremorsense, truesight)`. This is wrong for fog: the token might have 60ft darkvision but 120ft blindsight — the fog should show both separately.
5. **Limited sight walls TODO** — `doc.sight === 10` (Limited) is noted as a TODO; these walls partially block sight but should allow vision through at close range.
6. **No light-grants-vision** — Foundry's `lightPerception` detection mode lets tokens see targets that are illuminated by a light source even without range. VisionManager does not implement this; `WorldSpaceFogEffect.js` has partial Levels-only support via `isLightVisibleForPerspective` but not in the V2 FogOfWarEffectV2 path.

---

### 4.3 Fog of War (FogOfWarEffectV2)

**File**: `scripts/compositor-v2/effects/FogOfWarEffectV2.js`  

**What works:**
- World-space plane mesh (not screen-space) for correct map pinning
- VisionPolygonComputer integration for real-time LOS
- VisionSDF for soft fog edges / bleed
- Foundry exploration texture compositing (previously explored = dimmed)
- Levels elevation context — tokens see through correct floor's walls only
- Light-grants-vision for levels-enabled scenes via `isLightVisibleForPerspective`
- Door fog sync (fog reveals/closes as doors open/close)
- Customisable fog colour, explored opacity, softness, noise

**Gaps:**
1. **No tremorsense fog shape** — tremorsense provides awareness in a radius through walls. FogOfWarEffectV2 has no concept of a separate "sense polygon" that bypasses walls.
2. **No blindsight fog polygon** — same issue; blindsight should produce full-scene fog reveal within its range even through walls.
3. **No vision mode-aware fog appearance** — in Foundry, tremorsense mode changes the visual of what you see (wave effect), not just the polygon. FogOfWarEffectV2 is unaware of active vision mode.
4. **Token light radius not contributing to fog** — a token holding a torch should reveal fog around them based on their emitted light, not just their sight polygon.
5. **No exploration per-floor isolation** — explored areas are stored in a single 2D texture; in a multi-floor scene, ground floor exploration can visually bleed onto upper floor.

---

### 4.4 Game System Adapter (GameSystemManager)

**File**: `scripts/core/game-system.js`  

**What works:**
- `hasTokenVision()` — checks sight.enabled, sight.range > 0, token.hasSight
- `getTokenVisionRadius()` — system-aware (D&D5e reads max senses, PF2e reads perception)
- `distanceToPixels()` — unit-to-pixel conversion
- PF2e unlimited vision (returns 10000 scene units)

**Gaps:**
1. **No `getTokenVisionMode()` method** — no API to return which VisionMode ID should be active for a token based on its senses (e.g. darkvision present → `"darkvision"`).
2. **No `getTokenDetectionModes()` method** — no API to enumerate what DetectionModes a token has with what ranges.
3. **No per-sense radius breakdown** — `getTokenVisionRadius()` returns a single number; no way to ask "what is this token's darkvision range specifically" vs "blindsight range".
4. **No `getTokenLightRadius()` method** — token-held light sources are not surfaced.

---

## Part 5 — Release Readiness Summary

### Feature Matrix

| Feature | Foundry Spec | MapShine V2 State | Release Ready? |
|---|---|---|---|
| Basic vision (no adjustments) | ✅ `basic` mode | ✅ Implemented (bypass, strength=0) | ✅ Yes |
| Darkvision (greyscale) | ✅ `darkvision` mode | ✅ Saturation lerp working | ✅ Yes |
| Monochromatic vision | ✅ `monochromatic` mode | ✅ Saturation lerp working | ✅ Yes |
| Light Amplification (NVG) | ✅ `lightAmplification` mode | ⚠️ CONFIG tint + defaults mapping fixed; scan-line + level-remap visuals still missing | ⚠️ Partial |
| Tremorsense visual | ✅ Wave shader, all lighting off | ⚠️ Wave distortion added; full Foundry-equivalent lighting suppression still missing | ⚠️ Partial |
| Blindness | ✅ Programmatic, lighting off | ⚠️ Desaturation applied, but lighting not suppressed | ⚠️ Partial |
| GM immunity | N/A (Foundry has none) | ✅ Always `basic` for GM | ✅ Yes |
| Smooth mode transitions | Not in Foundry (instant) | ✅ Lerp implemented | ✅ Better than Foundry |
| Custom system vision modes | ✅ Via CONFIG.Canvas.visionModes | ⚠️ Reads `vision.defaults` + CONFIG tint; still lacks full per-layer VisionMode parity | ⚠️ Partial |
| Basic LOS polygon | ✅ | ✅ Raycasting implementation | ✅ Yes |
| Directional walls | ✅ | ✅ orient2dFast implemented | ✅ Yes |
| Multi-floor wall elevation filtering | N/A (Levels ext) | ✅ MS-LVL-072 implemented | ✅ Yes |
| Open door pass-through | ✅ | ✅ `ds === 1` skip | ✅ Yes |
| Limited sight walls | ✅ `doc.sight === 10` | ❌ TODO comment, not implemented | ❌ No |
| Light perception polygon | ✅ Separate `light` polygon | ✅ V2 renders vision-granting light shapes in fog mask | ✅ Yes |
| Tremorsense fog polygon | ✅ Wall-ignoring radius | ✅ Implemented via detection-mode wall-ignoring radii circles | ✅ Yes |
| Blindsight fog polygon | ✅ Wall-ignoring radius | ❌ Not implemented | ❌ No |
| Light-grants-vision fog | ✅ `lightPerception` mode | ✅ Implemented in V2 fog path (not Levels-only) | ✅ Yes |
| Per-floor fog exploration | N/A (Levels ext) | ❌ Single exploration texture | ❌ No |
| D&D5e darkvision radius | ✅ Uses `token.sight.range` | ⚠️ Takes max of all senses | ⚠️ Partial |
| D&D5e truesight (`seeAll`) | ✅ Via detectionModes | ❌ Not connected | ❌ No |
| D&D5e blindsight detection | ✅ Via detectionModes | ❌ Not connected | ❌ No |
| PF2e unlimited vision | ✅ Via `perception.vision` | ✅ Returns 10000 scene units | ✅ Yes |
| PF2e low-light vision mode | ✅ `lightAmplification` | ⚠️ Same partial gaps as lightAmplification | ⚠️ Partial |
| PF2e imprecise senses (scent, etc.) | ✅ Via custom detectionModes + filter | ⚠️ Wall-ignoring fog radii connected; detection filter/partial-reveal still missing | ⚠️ Partial |

---

## Part 6 — Gaps Ranked by Impact

### P0 — Breaking / Actively Wrong
- None that cause crashes or corrupt data.

### P1 — Significant Gameplay Impact
1. **Tremorsense has no wave visual** — players using tremorsense see a generic greyscale adjustment, not the distinctive sonar-wave aesthetic. This is clearly broken to anyone who knows the sense.
2. **Single vision radius for D&D5e multi-sense tokens** — a barbarian with tremorsense 30ft and darkvision 60ft gets fog computed at 60ft using darkvision polygon (walls respected), when tremorsense should add a separate wall-ignoring 30ft radius.
3. **Light-grants-vision not in V2 fog path** — tokens standing in torchlight but outside a player's LOS are not revealed by the V2 FogOfWarEffectV2 in non-Levels scenes.

### P2 — Notable But Deferrable
4. **No `getTokenVisionMode()` in GameSystemManager** — VisionModeEffectV2 reads `source.visionMode.id` directly from Foundry which is correct, but the adapter has no method for MapShine code to predict what mode a token will use.
5. **`lightAmplification` missing scan-line amplification shader** — visual fidelity gap but not gameplay-breaking.
6. **Limited sight walls not implemented** — rare wall type, low encounter frequency.
7. **Tint hardcoded for `lightAmplification`** — only breaks custom system vision modes that use a different tint colour.
8. **Per-floor fog exploration** — explored areas bleed across floors in multi-floor scenes; cosmetic but immersion-breaking.

### P3 — Polish / Future Work
9. **Truesight / `seeAll`** detection mode not wired to fog.
10. **D&D5e blindsight** not wired to fog.
11. **PF2e imprecise senses** (scent, wavesense) — no detection filter or partial-reveal logic.
12. **Blindness lighting layer suppression** — lighting layers should be fully disabled when the blindness mode is active; currently they bleed through.

---

## Part 7 — Recommended Action Items

### Immediate (pre-release blockers)

**A. Add `getTokenVisionMode()` to GameSystemManager adapters**  
Returns the recommended VisionMode ID for the active token, based on actor senses. D&D5e: if darkvision > 0 → `"darkvision"`, tremorsense → `"tremorsense"`, truesight → `"basic"` (truesight is a detection mode, not a visual mode). PF2e: if lowLightVision → `"lightAmplification"`, darkvision → `"darkvision"`.

**B. Tremorsense wave animation in VisionModeEffectV2**  
Add a wave distortion pass (UV sine perturbation over time) that activates when `activeMode === "tremorsense"`. Does not need to match Foundry's exact `WaveBackgroundVisionShader` output — an approximation is fine.

**C. Fix `lightAmplification` tint to read from CONFIG**  
Replace the hardcoded `(0.38, 0.8, 0.38)` with `CONFIG.Canvas.visionModes.lightAmplification.canvas.uniforms.tint` so custom system overrides are respected.

### Near-term (post-release polish)

**D. Add `getTokenDetectionModes()` to GameSystemManager adapters**  
Returns `[{id, range, wallsIgnored}]` — lets VisionManager build separate polygons per sense type.

**E. VisionManager: separate sense polygons**  
When a token has tremorsense/blindsight, compute additional wall-ignoring polygons at those ranges and union them with the standard sight polygon for fog reveal.

**F. FogOfWarEffectV2: light-grants-vision in non-Levels scenes**  
Port the `isLightVisibleForPerspective` logic from the legacy path into FogOfWarEffectV2's vision computation loop.

**G. Per-floor fog exploration texture**  
Store exploration data keyed by floor band in the FogManager so explored areas don't bleed across floors.

### Long-term

**H. Limited sight walls** — implement `doc.sight === 10` partial transparency in VisionPolygonComputer.  
**I. PF2e imprecise sense detection filters** — surface shimmer/outline on targets detected via imprecise senses.  
**J. D&D5e truesight and blindsight** — additional DetectionMode-equivalent polygons in FogOfWarEffectV2.

---

*End of audit.*
