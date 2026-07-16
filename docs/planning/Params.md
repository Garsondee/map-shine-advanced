# PARAMS — the last undesigned system, and the last unwalled disease

**Status:** RESEARCH + DESIGN SPEC, 2026-07-17. The final big undesigned piece: how an effect's knobs are declared, validated, stored, changed, persisted and rendered.
**Why now:** params are the **biggest single input to every effect** (2,197 read-hits — `Effects-API.md` §4.1), so every Stage 6 port queues behind this. And it is the **only named V2 disease with no tripwire**, purely because "correct" was undecided. Designing it closes the last gap in the wall.
**Companions:** `Effects-API.md` (the contract), `UI.md` (the render side), `Environment.md` §0.4 (the seven homes), `Effects.md` (tiers absorb most perf knobs).

---

## 0. The finding, in one line

> **V2's schema was ignored by all three parties who needed it — the UI, the effect's own write path, and the sanitizer that exists *because* nobody validates.**

`static getControlSchema()` exists in **48 effect files**, declaring types, ranges, steps, defaults and help text. Then:

| Who needed it | Uses of `getControlSchema` | What they did instead |
|---|---|---|
| `tweakpane-manager.js` (11,157 lines) | **0** | hand-wrote every folder (`UI.md`, bypass #7) |
| `SpecularEffectV2.applyParamChange()` — **in the same file as the schema** | **0** | `this.params[paramId] = value` — no type check, no clamp |
| `control-state-sanitize.js` (333 lines) | **0** | **hand-wrote the constraints a third time** (`finite01`, `finiteDeg`, hardcoded valid sets) |

That third row is the punchline. `sanitizeControlStateInPlace` exists to *"coerce controlState fields in place so Tweakpane bindings do not throw"* — **a repair shop at the disk boundary, cleaning up values that were never validated on the way in**, guessing at constraints the schema already declares thirty lines away. It cannot be correct: it is a second, drifting copy of the truth.

**The write path is the disease.** `applyParamChange` is nine lines and sits *inches below* `getControlSchema` in the same file, and never reads it:

```js
applyParamChange(paramId, value) {
  if (!this.params || !hasOwnProperty(this.params, paramId)) return; // silent skip!
  this.params[paramId] = value;   // any type. any range. no clamp. no error.
  this._paramsDirty = true;
}
```

A declaration inches from its mutation, not talking to it. That is not sloppiness — at ~2,000 lines/day, `x[k] = v` is free and wiring the schema is not (`Engine-Postmortem.md` §0: **structure loses to velocity**).

## 1. The measured surface

| | |
|---|---|
| Distinct `params.*` keys | **938** |
| Written from outside `effects/` | **119 sites, 6 subsystems** — incl. `HealthEvaluatorService` (**diagnostics mutating product state**) |
| Control types in use | slider **1,513** · boolean 188 · folder 159 · inline 41 · color 40 · string 17 · checkbox 15 · list 14 · dropdown 13 · select 4 · button 3 · gradient 2 |
| `throttle:` on **parameters** | **333** (`throttle: 50` ×184, `throttle: 100` ×149) |
| Homes per weather value | **7** (`Environment.md` §0.4), synced by ~140 hand-written functions |

**Two smells in that table.** `checkbox` vs `boolean`, `list` vs `dropdown` vs `select` — **the same concept under three names**, because there was no canonical vocabulary. And `throttle` on a *parameter*: a value's definition knows about **UI event timing**. Which exposes the real structural fault:

## 2. THE ROOT CAUSE: four concerns wearing one coat

V2's schema conflates four things with four different owners and lifetimes:

| Concern | Example fields | Belongs to | Lifetime |
|---|---|---|---|
| **The contract** | `type`, `min`, `max`, `step`, `default` | the effect (the truth) | forever |
| **The presentation** | `label`, `tooltip`, `help`, `glossary`, group `folder`s | the UI | per renderer |
| **View state** | `expanded`, `advanced` (21 in one file) | the panel, per user | per session |
| **UI mechanics** | `throttle` (×333) | the renderer | per widget |

Because they are one object, **nothing can consume just the part it needs** — so everyone re-implemented the part they needed. Split them and each consumer gets exactly its concern:

- Validation reads the **contract** and needs nothing else — so the sanitizer's 333 lines become `validate(schema, value)`.
- The renderer reads contract + presentation — so the UI generates instead of being hand-written.
- `expanded`/`advanced` are **per-user view state** and belong in client settings, never in a scene flag shared by every player.
- `throttle` is a **renderer policy** derived from type (a slider throttles; a checkbox does not), not authored per param 333 times.

## 3. The design

### 3.1 One home, one owner
```js
// The effect declares ONCE — beside the effect, in the author's voice:
export const SPECULAR_PARAMS = {
  intensity: { type: 'float', min: 0, max: 2, step: 0.01, default: 1.23,
               label: 'Intensity', help: 'Master strength of the additive specular pass.' },
  lightColor: { type: 'color', default: '#ffffff',
                label: 'Specular tint', help: 'Tint multiplied into highlights.' },
};
```
The **params service** owns the live values. Effects **read** them (via `ctx`, per `Effects-API.md` §5). Nobody else writes them directly — `.params.X =` outside the service is a build failure. The 119 external writers become service calls; the 7 homes become 1 home + N views; the ~140 sync functions cease to exist because **there is nothing to sync**.

### 3.2 The write path validates — the fix for the actual disease
```js
setParam(effectId, key, value)  // the ONLY door
  → look up the declared contract
  → unknown key?      → THROW (V2 silently returned; the caller never knew)
  → wrong type?       → THROW (a colour where a float goes is a bug, not a coercion)
  → out of range?     → CLAMP + report once (author intent, honoured but visible)
  → equal to current? → no-op (no dirty flag, no re-render)
  → else commit + mark dirty
```
**Validation happens at the WRITE, not at the read and not at disk.** Then `control-state-sanitize.js`'s entire reason to exist evaporates: nothing invalid can be stored, so nothing needs repairing on load. A repair shop at the disk boundary is a confession that the front door has no lock.

### 3.3 The canonical type vocabulary
`float` · `int` · `bool` · `color` · `enum` · `vec2` · `vec3` · `curve` · `action`

Eleven fuzzy V2 types collapse to nine precise ones (`checkbox`→`bool`, `list`/`dropdown`/`select`→`enum`, `slider`→`float`/`int` — *slider is a widget, not a type*, which is exactly the conflation §2 names). Frozen, validated, and the renderer maps type→widget **once**, in one table, instead of 266 hand-written bindings.

### 3.4 Persistence is derived, never authored
Store **only values that differ from their declared default**, keyed by effect. Consequences, all free:
- A scene flag shrinks to the handful of knobs actually touched (V2 stored the whole blob).
- Adding a param with a sensible default **cannot break old scenes** — absent means default.
- **The default is only ever in one place** (the declaration), so a "changed" value can never silently mean "same as the old default".
- View state (`expanded`/`advanced`) goes to client settings, so one GM's folder preferences stop riding in a document every player loads.

### 3.5 Tiers absorb most of the count
`UI.md` §3: *"hundreds of controls" is a symptom.* A large share of the 938 exist because performance was a manual knob-hunt. Under `Effects.md`, per-effect perf knobs collapse into one `tier` the governor drives. **Do not port 938 params. Port the ones that are still knobs after tiering** — expect the count to fall hard.

## 4. What is harvested (and it is a lot)

- **The 48 `getControlSchema()` bodies** — types, ranges, steps and, above all, the `help`/`summary`/`glossary` text **in the author's own voice** ("*World scale: how large world-space shimmer patterns are — higher = bigger, calmer glint clusters*"). Irreplaceable; becomes free tooltips in every surface.
- **Every tuned default.** `intensity: 1.23` is not a number, it is taste. The values are the product.
- **The grouping intent** (Look / Shimmer / Layer 1…) — good IA, re-expressed as presentation.
- The **"Cinematic Plausibility"** doctrine that shaped which knobs exist at all.

## 5. Tripwires (the last gap in the wall)

1. **`params/one-owner`** — `.params.X =` / `params[k] =` assignment outside the params service = build failure. *Closes the disease this doc is about.*
2. **`params/no-ui-in-contract`** — `throttle`/`expanded`/`advanced` in a params declaration = build failure. Keeps the four concerns apart at the only moment it is cheap: authoring time.
3. **Schema validation in Node** — declarations validate (known type, coherent min/max/step, default in range, non-empty label). A bad param is a red test, not a value discovered wrong in play six months later.

## 6. Build order (declaration-first, per `keyhole-stage6-effects-approach`)
1. `PARAM_TYPES` + `validateParamsSchema()` — pure data, Node-tested, **today**.
2. `validateParamValue()` — the write-path check that V2 never had.
3. The service (get/set/subscribe/serialize) — when a second consumer exists.
4. The renderers (`UI.md`) — Tweakpane pane + `ApplicationV2` dialog, both **generated**.

**The velocity test governs all of it** (`Skeleton.md` law 2): declaring a param must be *faster* than hand-writing a folder, or this loses exactly as V2's schema did. One declaration → validation, UI, persistence, tooltips, all free. That asymmetry is the only thing that makes the wall a rail instead of an obstacle.

---

*The schema was right. Nobody could consume it, so everybody rebuilt it. Split the concerns, validate at the write, generate everything else.*
