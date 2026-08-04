# Foundry VTT v14 — Token Vision, Global Illumination & Darkness Sources Audit

**Purpose:** trace exactly how Foundry decides "is this point visible to this token" and how darkness (negative-light) sources interact with that decision — triggered by a live report: *outdoor tokens at noon aren't being marked visible unless a point light sits right next to them, as if ambient/global light doesn't count as a vision source the way a real light does.*

**Source of record:** `foundryvttsourcecode_v14/resources/app/` (vendored). Every claim below is grepped from that tree; file:line given so it can be re-opened directly. No guessing.

**Scope note:** this is the sibling of [foundry-v14-lighting-audit.md](foundry-v14-lighting-audit.md), which covers how a light **renders** (shaders/blend/channels). This doc covers a different pipeline entirely — how Foundry decides what a token **can see** (fog of war, hidden-token reveal, the `testVisibility` boolean). MSA does not own this pipeline yet (fog/vision is explicitly future work — see memory `keyhole-vision-fog-direction`), so nothing here is an MSA code bug; it's ground truth for (a) diagnosing the live report as a Scene/Token authoring gap, and (b) the eventual MSA vision/fog rebuild.

---

## 0. The one-paragraph mental model

A token's ability to see anything is decided by **`CanvasVisibility#testVisibility`**, which tries several independent routes in order and returns `true` on the first one that hits: (1) any nearby *real* light source explicitly flagged "provides vision", (2) the token's own `basicSight` — walls + a **configured range number**, completely blind to whether the area is lit or dark, (3) the token's own `lightPerception` — unlimited range, but **only inside something Foundry considers "light"**, which includes a real light's radius *or* the scene's Global Illumination (if it's turned on). A freshly-created token has `sight.range = 0`, which kills route (2) outright, so it lives or dies entirely on route (1)/(3) — i.e., on whether it's near a real light, or whether the GM remembered to enable Global Illumination. **Global Illumination is OFF by default on every Scene**, independent of darkness level — "it's noon" does not imply "everyone can see," because nothing here reads the darkness level unless Global Illumination's own toggle is already on. That single unticked checkbox is indistinguishable, from the token's point of view, from a moonless night.

Separately, darkness (negative-light) sources are **already** full line-of-sight blockers in vanilla Foundry — they register as real polygon edges with the same "fully blocks" sense type an ordinary Wall uses, for both light and sight, in both directions. This is implemented, not missing.

---

## 1. Token vision configuration — what a token actually stores

**File:** `common/documents/token.mjs:90-104`.

| Field | Type / range | Default | Meaning |
|---|---|---|---|
| `sight.enabled` | bool | **`range > 0`** (derived) | Whether this token has a `PointVisionSource` at all |
| `sight.range` | ≥ 0 | **0** | How far `basicSight` can see, illumination-independent |
| `sight.angle` | 0-360° | 360 | Vision cone |
| `sight.visionMode` | string | `"basic"` | Which `VisionMode` (basic / darkvision / etc.) |
| `detectionModes` | keyed object | `{}` | Extra detection modes (darkvision, tremorsense, …), each `{enabled, range}` |

**A brand-new token has `sight.range = 0` and therefore `sight.enabled = false` by construction** (`initial: data => Number(data?.sight?.range) > 0`, line 91). Nothing here reads darkness level, time of day, or Global Illumination — this field is purely "how far can I personally see," authored per-token (per-actor, usually — most systems set this from a race/species darkvision value, or leave it at the system default).

---

## 2. `CanvasVisibility#testVisibility` — the master cascade

**File:** `client/canvas/groups/visibility.mjs:848-907`. Called once per token/point that needs a visible/hidden verdict (fog reveal, hidden-token/door detection, etc.). Order matters — it returns on the first `true`:

```
1. No active vision source at all on the scene → visible only to the GM.
2. For every ACTIVE LIGHT SOURCE with data.vision === true (a light explicitly
   flagged "provides vision" in its config) → lightSource.testVisibility(config).
   First hit wins.                                                          (859-863)
3. For every active vision source (i.e. every token with sight.enabled):
     a. token.detectionModes.basicSight  → walls + sight.range, NO light check.
     b. token.detectionModes.lightPerception → unlimited range by default,
        REQUIRES canvas.effects.testInsideLight(point).                    (874-888)
4. (object is a Token only) special detection modes — darkvision, tremorsense,
   etc. — each token-authored, each its own rules.                         (893-905)
```

**`basicSight` never checks illumination.** `DetectionMode#_testRange` (`perception/detection-mode.mjs:313-324`) is walls + a configured `range` number, full stop — `if (range <= 0) return false`. A token can "see" (reveal fog, spot a door) inside its own `sight.range` bubble in **pitch darkness**, by design — that's what `sight.range` represents (how far you can make things out at all), separate from how bright the render looks.

**`lightPerception`** is the one route that's actually about light: `DetectionModeLightPerception#_testPoint` (`perception/detection-modes/light-perception.mjs:34-37`) does the same base range/LOS test, then additionally requires `canvas.effects.testInsideLight(test.point)`. Its default range is unlimited ("by default tokens have light perception with an infinite range if light perception isn't explicitly configured" — the class's own doc comment) — this is the mode that makes a torch light up an entire room even for a token with zero personal sight range.

**This is exactly why "a point light near a token provides vision" already works two different ways**: a light with `data.vision=true` hits step 2 directly; any other lit token hits step 3b via `testInsideLight`. Both bypass `sight.range` entirely.

---

## 3. `testInsideLight` / `testInsideDarkness` — what counts as "lit"

**File:** `client/canvas/groups/effects.mjs:322-375`.

```js
testInsideLight(point, options={}) {
  const globalLightSource = canvas.environment.globalLightSource;
  if ( globalLightSource.active ) {
    if ( options.condition?.(globalLightSource) !== false ) {
      const {min, max} = globalLightSource.data.darkness;
      const darknessLevel = this.getDarknessLevel(point);
      if ( (darknessLevel >= min) && (darknessLevel <= max) ) return true;
    }
  }
  for ( const lightSource of this.lightSources ) {
    if ( !lightSource.active || (lightSource instanceof GlobalLightSource) ) continue;
    ...
    if ( lightSource.testPoint(point) ) return true;
  }
  return false;
}
```

Global Illumination **does** count as "light" here — but **only if `globalLightSource.active` is true**, which requires the Scene's toggle to be on (see §4). `testInsideDarkness` (375) is the mirror image, walking `canvas.effects.darknessSources` instead — used to decide whether a token's own origin is blinded (§5), not whether a point is lit.

---

## 4. Global Illumination — off by default, independent of darkness level

**Schema:** `common/documents/scene.mjs:119-130` — `environment.globalLight`:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | **`false`** | Master toggle. Nothing else in this section matters until this is `true`. |
| `darkness` | `{min: 0, max: 1}` (shared `LightData.darkness` field, `common/data/data.mjs:66-69`) | Darkness-level window in which global light is active. **Default already spans noon→midnight** — once enabled, this is not usually what needs tuning. |

**Wiring:** `EnvironmentCanvasGroup#configureGlobalLight` (`client/canvas/groups/environment.mjs:320-331`) passes `disabled: !globalLight.enabled` straight into the source's data. `BaseEffectSource#active` (`sources/base-effect-source.mjs:174-176`) is `attached && !disabled && !suppressed` — so with the toggle off, `globalLightSource.active` is `false`, unconditionally, **at any darkness level, including 0 (noon)**. Nothing here reads `darknessLevel` until the toggle is already on.

**This is the mechanism behind the reported symptom.** An outdoor token with no personal `sight.range` and no nearby real light has exactly one route left (§2 step 3b), and that route dead-ends at an inactive global light source — "noon" never enters the calculation, because the gate it needs is a separate boolean the Scene document defaults to off. The fix is Scene Configuration → tick **Global Illumination** (and give tokens that should have baseline unaided sight an actual `sight.range` > 0, if they don't already have one from their actor/species data) — not a code change. This control flow is 100% inside vanilla Foundry's own `CanvasVisibility` / `GlobalLightSource` / `DetectionMode` classes; nothing under `src/` touches it (confirmed — a grep for `globalLight|detectionMode|testVisibility|VisionSource` across `src/` only turns up point-light rendering code, never token vision).

---

## 5. Darkness (negative-light) sources as LOS blockers — already implemented

**How a GM makes one:** ticking **"Darkness Source"** on an `AmbientLight` sets `config.negative = true` (`LightData.negative`, `common/data/data.mjs:45`). `AmbientLight#emitsDarkness`/`#emitsLight` (`client/canvas/placeables/light.mjs:171,182`) and `#createLightSource` (line 476) branch on this single flag to instantiate a `PointDarknessSource` instead of a `PointLightSource` — it's a type switch, not a negative-radius/negative-luminosity number.

**Two independent blocking mechanisms, both real:**

**(a) The darkness source's own boundary is a genuine polygon edge**, not just a "dark" area. `PointDarknessSource` (`sources/point-darkness-source.mjs`):
```js
get requiresEdges() { return true; }                              // line 69-71
_getEdgeCreationOptions() {
  return {
    type: "source", object: this.object, direction: CONST.EDGE_DIRECTIONS.LEFT,
    light: CONST.EDGE_SENSE_TYPES.NORMAL, sight: CONST.EDGE_SENSE_TYPES.NORMAL,  // line 97-107
    priority: this.data.priority
  };
}
```
`EDGE_SENSE_TYPES.NORMAL` (`common/constants.mjs:1428-1453`) is the same "senses collide with this edge" value an ordinary Wall uses for full blocking (as opposed to `NONE`, which lets senses pass through). Every other source's `ClockwiseSweepPolygon` sweep — light **and** sight — treats a darkness source's circular boundary as opaque. This blocks light from shining in, and blocks other tokens from seeing in (or the darkness-standing token from seeing out through that boundary toward anything past it), independent of anyone's blinded state.

**(b) Standing inside one blinds the vision source outright.** `PointVisionSource#_updateBlindedState` (`sources/point-vision-source.mjs:196-199`):
```js
const condition = darknessSource => this.priority <= darknessSource.priority;
this.blinded.darkness = canvas.effects.testInsideDarkness(this.origin, {condition});
```
`DetectionMode#_canDetect` (`perception/detection-mode.mjs:109`) then hard-fails every wall-constrained mode — `basicSight`, `lightPerception` (its own override, `light-perception.mjs:15`), darkvision — for that token, full stop, regardless of any light nearby.

**Arbitration is entirely `priority` (int ≥ 0, default 0), not radius or brightness:**
- A vision source's own `priority` is hardcoded to `0` via the `PointEffectSourceMixin` default (`sources/point-effect-source.mjs:40,73-74`) — Token Config exposes no field for it. Since `LightData.priority` has `min: 0`, a darkness source's priority can never go below 0 either. So `this.priority <= darknessSource.priority` (0 ≤ anything ≥ 0) is **always true** — any vision source standing inside any darkness source is blinded, unconditionally, by construction.
- A real light only suppresses/overrides a same-spot darkness source if the GM explicitly raises that light's `priority` **strictly above** the darkness source's (`sources/point-darkness-source.mjs:88-91`, `condition = lightSource => this.priority < lightSource.priority`). At the default of 0 vs 0, neither wins, and the darkness source's edge (§5a) still blocks the light's own polygon sweep from reaching in.
- Symmetrically, an ordinary **positive** light only becomes a blocking edge itself if its own priority is raised above 0 (`sources/point-light-source.mjs:97`) — at default settings, torches don't act like walls, only darkness sources do (`requiresEdges` is unconditionally `true` for `PointDarknessSource`, but conditional for `PointLightSource`).

**Conclusion: if a scene's darkness source visibly isn't blocking sight, the mechanism above is proven correct in source, so the likely culprits are authoring, not engine behavior** — confirm `config.negative` is actually ticked (a very dim ordinary light looks similar at a glance but behaves completely differently), or check whether a nearby light's `priority` was raised above the darkness source's, intentionally or not.

---

## 6. Summary — diagnosis of the live report

| Symptom | Mechanism | Fix |
|---|---|---|
| Outdoor token at noon, no personal light → not visible | `sight.range` likely 0 (route 2 dead) **and** Scene's Global Illumination toggle is off by default (route 3b dead) — darkness level never enters it | Scene Config → enable **Global Illumination**; optionally give the token/actor a real `sight.range` |
| Point light near a token → vision works | Hits `testVisibility` step 2 (light `data.vision=true`) or step 3b (`testInsideLight` finds the real light directly) — routes that never depended on Global Illumination | Working as intended; not the same code path as ambient light at all, which is why the two look inconsistent |
| Darkness sources as LOS blockers | Already a full edge-based blocker (§5a) plus an occupant-blind flag (§5b), arbitrated by `priority` | If not visibly working: confirm `config.negative` is actually set, and check `priority` on both the darkness source and any nearby light |

Nothing under `src/` participates in any of the mechanisms above — MSA does not own vision/fog yet (see memory `keyhole-vision-fog-direction`). This doc is the ground truth to build against when that work starts: in particular, §2's `testVisibility` cascade and §5's edge-based darkness-blocking are exactly the "reproduce the logic" surface that future build has to match, not reinvent.
