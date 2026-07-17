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

## 3.6 ⚗️ HARVEST FINDINGS — what the real 48 schemas taught the contract (2026-07-17)

The contract in §3 was designed from a sample of ONE (SpecularEffectV2). Before building the service, it was tested against the **real field vocabulary of all 48 schemas**. Three gaps, all now fixed and Node-tested — this is *why* declaration-first means "declare against real data, not an imagined shape":

**1. Colour space was being smuggled in as a storage shape.** 39 colour params exist in TWO shapes: 30 hex strings and 9 carrying `colorType: 'float'` (i.e. `{r,g,b}` linear). **The shape was silently encoding the colour SPACE** — `'float'` meant *"already linear, do not decode"*. That is the same class of bug as the washed-out map (an implied colour space, discovered live at the cost of a session). **Fix:** ONE storage shape (`#rrggbb`) and an explicit, required `space: 'srgb' | 'linear'`. `colorType` is now forbidden outright. A colour that does not name its space fails validation.

**2. `readonly: true` marked things that were never params.** 11 of them: `statusSubject`, `statusProbeAge`, `statusOutdoorsSample`, `statusDayPhase`… **Status READOUTS, rendered through the params system because it was the only display channel available.** This retroactively explains the ugliest number in `Effects-API.md` §4.1 — *why HealthEvaluatorService (diagnostics) was writing product params*. **It was not malice; it was a missing concept.** Diagnostics had status to show and only one surface to show it on. **Fix:** `readonly` in a params declaration is a validation error naming the real concept — a readout is a computed OUTPUT the renderer derives, never a stored, persisted, writable value. The renderer needs a derived-display concept; the params system must not be it.

**3. `type: 'string'` was three different things.** All 17 uses split cleanly: **11** were the readouts above; **4** were `*Selection` params carrying an `options` array — *an enum wearing a string costume*; **1** (`audioStrikePath`, a file path) was a genuine free-text value. So `string` was never a type — it was an enum, a readout, or a path. **Fix:** `text` added for the single legitimate case; `enum` already covered the four; `string` remains absent. Exactly one of seventeen needed a string type.

**And one false lead worth recording** (the instruments lesson, again): an initial grep reported `format` as a schema field with 47 uses. It was `THREE.RGBAFormat` on render targets — the pattern was too loose. Measured properly, the real vocabulary is: `type`, `label`, `tooltip`, `default`, `step`, `min`, `max`, `expanded`, `advanced`, `throttle`, `options`, `colorType`, `readonly`. **A sloppy measurement nearly added a field to the contract that never existed.**

## 4. What is harvested (and it is a lot)

### ⚠️ CORRECTED 2026-07-17 — one line of this was WRONG, and it cost a rebuild

> ~~**Every tuned default.** `intensity: 1.23` is not a number, it is taste. **The values are the product.**~~

**The values are NOT the product. They are taste expressed *through a specific shader that is being deleted*.** Author, 2026-07-17:

> *"Given that every single effect is going to be rewritten from scratch I think the parameters and things that I've built up are only really useful as a reference to the sort of features I'd like to see eventually. We're going to be building the effects in modern TSL so it's very likely that even using the exact same settings wouldn't give us the result we want."*

Correct, and it invalidates the struck line. `intensity: 1.23` was tuned against V2's GLSL math, its tone mapping, its colour handling — none of which survive the TSL rebuild. Port the number and you get a different picture. **The number is not portable; the INTENT is.**

**This mattered practically, not academically.** Read literally, this section produced a harvest that emitted a `params-schema.js`-conformant `.js` tree into `src/` — 601K of V2 schemas imported by `boot.js`, shipped to and parsed by every player, for data no V3 code read — **while silently dropping the `help`/`glossary` prose this very section calls irreplaceable.** Exactly inverted: the worthless half preserved as product code, the priceless half binned. Rebuilt as `docs/reference/v2-effect-params/` (commit `8ca0ea0`); `tools/harvest-params.mjs`'s header carries the full account.

**What actually survives a rewrite** — and is therefore what the harvest is FOR:

- **The `help`/`summary`/`glossary` text in the author's own voice** ("*World scale: how large world-space shimmer patterns are — higher = bigger, calmer glint clusters*"). This section already called it *"above all… irreplaceable"* and was right: it describes INTENT, which is shader-independent. **25 of the 45 schemas carry it.**
- **Which knobs existed at all** — a feature wishlist. *"I wanted to control shimmer world-scale"* survives; *"at 1.23"* does not.
- **The grouping intent** (Look / Shimmer / Layer 1…) — good IA, and a record of which knobs the author thought belonged together.
- **The vocabulary** — what the author *called* things.
- The **"Cinematic Plausibility"** doctrine that shaped which knobs exist at all.

**✅ THE HARVEST IS DONE** (2026-07-17): **45 effects, 2,240 controls**, each cross-referenced to the V3 pass that replaces it via `passes.js`'s `absorbs` — so the index answers *"I'm building `post.grade`; what did the 13 effects it replaces do?"*. It also surfaces **5 effects no V3 pass claims** (`SceneWindField` has 35 controls and `frame.snapshot`'s own note says it covers wind — a real gap in the 48→~12 accounting, worth closing before Stage 7). It is a **reference for authoring**, read by a human designing a V3 effect — never imported, never shipped, never a schema.

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
