# Gradient-Over-Lifespan Control & Color Picker Audit

## Status: PLANNING

---

## Part A — Color Picker Bug Investigation

### Root Cause

`buildParameterControl()` in `scripts/ui/tweakpane-manager.js` calls `container.addBinding()` without
a `colorType` option for `type: 'color'` params. Tweakpane's `ObjectColorInputPlugin` defaults
`colorType` to `'int'` when it is not specified.

```javascript
// Current (buggy) — no colorType passed
const binding = container.addBinding(effectData.params, paramId, bindingOptions);
```

In `int` mode Tweakpane treats each channel as a 0–255 integer. All our schema defaults use
0–1 float values (e.g. `{ r: 0.02, g: 0.18, b: 0.28 }`). Consequences:

| Scenario | What happens |
|---|---|
| Display | `r:0.02` rendered as effectively `#000000` (near-black); picker shows wrong colour |
| Write-back | User picks a colour → Tweakpane writes channels as 0–255 ints back to `params` |
| Reload | Saved scene flags may contain `{ r:25, g:64, b:89 }` (int range) but default is float |

### Affected Params (survey)

Every `{ type: 'color' }` entry across ALL V2 effect schemas uses 0–1 float defaults:
- `WaterEffectV2` — `tintColor`, `shoreFoamColor`, `shoreFoamTint`, `foamColor`
- `ColorCorrectionEffectV2` — `liftColor`, `gammaColor`, `gainColor`
- `SkyColorEffectV2` — `*LiftColor`, `*GammaColor`, `*GainColor` (all time-of-day stages)
- `WindowLightEffectV2` — `color`
- `canvas-replacement.js` ash/ember inline schemas — `ashColorStart`, `ashColorEnd`,
  `emberColorStart`, `emberColorEnd`

`ParameterValidator.inferType()` also returns `null` for `'color'` (object), so no type mismatch
is caught when a previously-saved int colour is loaded.

### Fix Plan (Phase 1)

1. **`scripts/ui/tweakpane-manager.js` — `buildParameterControl`**
   - When `paramDef.type === 'color'`, set `bindingOptions.colorType = paramDef.colorType ?? 'float'`
   - Schema params may carry an explicit `colorType: 'int'` if desired (opt-in escape hatch).

2. **Migration: saved int values → float**
   - In `loadEffectParameters`, after resolving saved params, iterate all `type: 'color'` param defs.
   - If any channel value > 2.0, the value was stored as int. Divide all channels by 255 and clamp.
   - Threshold of 2.0 is safe: float colours can legitimately have HDR values up to ~1.0 for normal
     colours; values like `r:25` are unambiguously old int data.

3. **`scripts/ui/parameter-validator.js` — `inferType`**
   - Add `if (paramDef.type === 'color') return null;` to skip JS `typeof` check for objects.

---

## Part B — Gradient-Over-Lifespan System

### Goal

Add two independent gradient tracks to smoke (and potentially any future particle system):

| Track | Controls | Default |
|---|---|---|
| **Colour** | RGB over normalised life t=[0,1] | Warm orange at birth → dark grey at death |
| **Emission** | Scalar HDR multiplier over t | Bright glow near fire → zero emission |

These are separate from the existing flame/ember gradients in `fire-behaviors.js` (which are
non-editable coded constants). The smoke gradient is user-editable per-scene.

---

### Architecture

#### Data Format

Gradient stops are plain arrays stored in `params`:

```javascript
// Colour stops — channels are 0–1 linear float
smokeColorGradient: [
  { t: 0.00, r: 0.90, g: 0.45, b: 0.10 },   // warm orange near fire
  { t: 0.08, r: 0.55, g: 0.38, b: 0.25 },   // transition
  { t: 0.20, r: 0.42, g: 0.38, b: 0.32 },   // warm grey
  { t: 0.50, r: 0.36, g: 0.34, b: 0.32 },   // neutral grey
  { t: 1.00, r: 0.22, g: 0.22, b: 0.22 },   // dark grey
]

// Emission stops — HDR scalar
smokeEmissionGradient: [
  { t: 0.00, v: 0.80 },    // orange glow near fire
  { t: 0.06, v: 0.25 },
  { t: 0.18, v: 0.04 },
  { t: 1.00, v: 0.00 },
]
```

These are serialised as JSON arrays in scene flags alongside other effect params. The existing
`lerpColorStops` / `lerpScalarStops` utility functions in `fire-behaviors.js` already handle
interpolation of this exact format.

---

### Phase 2 — GradientEditor Custom Widget

New file: **`scripts/ui/gradient-editor.js`**

A self-contained DOM widget that does NOT depend on Tweakpane internals. It is injected into
the Tweakpane pane's container element after a regular Tweakpane label blade.

#### Visual Layout

```
┌─────────────────────────────────────────────────────┐
│  Smoke Colour                                        │
│  ┌─────────────────────────────────────────────────┐ │
│  │ ██████▓▓▓▒▒▒░░░░░░░░░░░░░░░░░░░▒▒░░░░░░░░░░░░░ │ │  ← gradient canvas (click to add stop)
│  └─────────────────────────────────────────────────┘ │
│         ▲        ▲          ▲              ▲         │  ← draggable stop handles
│         0.00    0.08       0.20           1.00        │
└─────────────────────────────────────────────────────┘
```

On stop **click**: inline colour swatch opens a `<input type="color">` dialog (for colour mode)
or a number field (for scalar mode).
On stop **drag**: moves the stop left/right along the t axis.
On canvas **click** (between stops): inserts a new interpolated stop.
On stop **double-click** / right-click: removes the stop (minimum 2 stops enforced).

#### API

```javascript
const editor = new GradientEditor(containerEl, {
  mode: 'color',       // 'color' | 'scalar'
  label: 'Smoke Colour',
  stops: [...],        // initial stop array
  scalarMax: 3.0,      // only for scalar mode
  onChange: (stops) => { /* called on any edit */ }
});
editor.setStops(stops);   // programmatic update
editor.getStops();        // returns current stops
editor.destroy();         // removes DOM + listeners
```

#### Injection Strategy

Tweakpane `Blade` objects expose a `.element` property on their controller. We can also
access `folder.element` on a `FolderApi` to get its DOM container. After adding a
`folder.addBlade({ view: 'separator' })` or an empty label blade, we locate the injected
container's parent and append the editor's `<div>` directly.

Simpler alternative that avoids DOM surgery: use `pane.element.querySelector` after registering
a uniquely-labelled blade. The blade acts as an anchor; we insert the gradient editor
immediately after it using `insertAdjacentElement('afterend', ...)`.

#### Tweakpane schema type

```javascript
smokeColorGradient: {
  type: 'gradient',
  label: 'Colour Over Life',
  mode: 'color',         // 'color' | 'scalar'
  scalarMax: 3.0,        // only used if mode === 'scalar'
  default: [ /* stops */ ]
}
```

`buildParameterControl` case `'gradient'`:
1. Initialise `effectData.params[paramId]` to saved value or default.
2. Add an anchor blade (separator or label).
3. Instantiate `GradientEditor(anchorEl.parentElement, { ... })`.
4. On `onChange`: call `updateCallback(effectId, paramId, stops)`, `queueSave(effectId)`.
5. Store editor ref in `effectData.gradientEditors[paramId]` for refresh/destroy.

Save/load: gradient arrays serialise naturally as JSON via the existing scene-flag machinery.

---

### Phase 3 — Smoke Gradient Integration

#### `fire-behaviors.js` — `SmokeLifecycleBehavior`

`update(particle, delta)` colour block changes from blending COOL/WARM constants to sampling
the user gradient:

```javascript
// New: if ownerEffect.params.smokeColorGradient is populated, use it
const cgStops = this.ownerEffect?.params?.smokeColorGradient;
const color = (cgStops && cgStops.length >= 2)
  ? lerpColorStops(cgStops, t, _smokeColorTemp)
  : this._fallbackSmokeColor(t);   // existing COOL/WARM blend as fallback
```

`update` emission block (new):

```javascript
const egStops = this.ownerEffect?.params?.smokeEmissionGradient;
const emission = (egStops && egStops.length >= 2)
  ? lerpScalarStops(egStops, t)
  : 0.0;   // no emission when no gradient defined
// Apply emission: multiply colour channels (additive brightness boost)
particle.color.x += color.r * emission * brightDark;
particle.color.y += color.g * emission * brightDark;
particle.color.z += color.b * emission * brightDark;
```

Emission is additive on top of the normal diffuse smoke colour — this creates the orange glow
near the fire base without changing the existing colour calculation path.

#### `FireEffectV2.js` schema additions

New params added to `params` object (with correct defaults) and `getControlSchema()`:

```javascript
// In params object
smokeColorGradient: null,        // null → use legacy warmth/brightness sliders
smokeEmissionGradient: null,     // null → no emission (pure diffuse smoke)
smokeUseGradient: false,         // toggle: use gradient vs legacy sliders

// In schema parameters
smokeUseGradient: { type: 'checkbox', label: 'Use Gradient Colour', default: false },
smokeColorGradient: {
  type: 'gradient', mode: 'color', label: 'Colour Over Life',
  default: [ /* warm orange → dark grey */ ]
},
smokeEmissionGradient: {
  type: 'gradient', mode: 'scalar', scalarMax: 3.0, label: 'Emission (Glow)',
  default: [ { t:0.0, v:0.8 }, { t:0.06, v:0.25 }, { t:0.18, v:0.04 }, { t:1.0, v:0.0 } ]
},
```

The legacy `smokeColorWarmth` / `smokeColorBrightness` sliders are kept and hidden when
`smokeUseGradient` is true (using the existing `updateControlStates` / dependency system).

---

## Implementation Order

1. **Phase 1 — Color picker fix** (low risk, high value): `tweakpane-manager.js` +
   `parameter-validator.js`. One-line change per file.
2. **Phase 2 — GradientEditor widget**: New `scripts/ui/gradient-editor.js` +
   `buildParameterControl` additions in `tweakpane-manager.js`.
3. **Phase 3 — Smoke gradient integration**: `fire-behaviors.js` + `FireEffectV2.js` schema.

---

## Open Questions

- **Gradient persistence format**: Arrays of stop objects will be stored verbatim in scene flags
  as JSON. No migration is needed — if the param is absent, the fallback (legacy sliders) is used.
- **Emission HDR range for smoke**: Defaulting to max 0.8 so smoke near fire gets a subtle orange
  self-illumination, not a full bloom explosion. `scalarMax` can be adjusted in schema.
- **Other particle systems**: The gradient widget is generic. After smoke, it can be wired into
  `FlameLifecycleBehavior` and `EmberLifecycleBehavior` to allow full user-defined colour curves
  for fire and embers too — replacing the hard-coded `FLAME_GRADIENT_*` constants.
- **Tweakpane injection stability**: If Tweakpane's DOM structure changes between vendored
  versions, the anchor insertion strategy needs revisiting. We own the vendor copy so this is low
  risk.
