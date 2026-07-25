# EFFECTS UI — front of house & rear of house

**Status:** DESIGN SPEC, authored 2026-07-19 from an author directive. This is the plan for the effects configuration UI — the surface every Stage 6 effect is authored and tuned through.
**Author directive (verbatim intent):** V2 ended with 1,000+ Tweakpane sliders — huge artistic flexibility, a real boon to authoring, but it hid two problems. **(1) The dead-slider minefield:** with so many controls, keeping them wired was a nightmare; they broke silently and became dead controls with no warning, so the interface became a minefield of dead-or-problematic knobs. **(2) The UX wall:** the controls were only usable by someone very technical; the terminology was correctly pitched at experts, which made the _main way to configure effects_ intimidating and esoteric to an average human. The ask: a strong spec for a UI **split into two halves — front of house (approachable) and rear of house (expert)** — and a real answer to "Tweakpane or our own solution?"
**Foundations this builds on (settled — do not relitigate):** `UI.md` (Tweakpane was never the problem; 220 lines of plumbing per control was), `Params.md` (the four-concerns split; validate-at-write), and `src/core/params-schema.js` (**already built**: 9 canonical types, `validateParamsSchema`, `validateParamValue`, `serializeParams`/`hydrateParams`). This doc adds the **front-of-house layer** and the **structural cure for dead controls** on top of those.

---

## 0. WHERE V2 FAILED — named, because the spec is the antidote to each

The directive names two problems; the audit (`UI.md`, `Params.md`) found five mechanisms behind them. Each becomes a design requirement below.

| #   | V2 failure                         | Mechanism                                                                                                                                                        | Answered by                                                                    |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| F1  | **Dead sliders**                   | No generator → every control hand-wired (≈220 lines each) → wiring rots as effects change                                                                        | §2 generate-from-schema (a control cannot exist without a live param)          |
| F2  | **Dead sliders with _no warning_** | Silent write path (`this.params[k]=v`, unknown key silently skipped) + 2,670 empty catches → a broken control looked identical to a working one                  | §4 validate-at-write (built) + the **derived control-health** surface          |
| F3  | **Intimidating to non-experts**    | One surface, expert terminology, every raw knob exposed at once. No approachable layer existed at all                                                            | §3 the **front-of-house** dial layer                                           |
| F4  | **Surfaces drift apart**           | Three hand-mirrored UIs (tweakpane 11,157 / control-panel 5,533 / graphics-settings 1,607) over the same 938 params, kept in sync by ≈140 hand-written functions | §2 one schema, N generated views, zero mirrors                                 |
| F5  | **Slider count itself**            | Performance was a manual knob-hunt, so every effect exposed dozens of perf sliders                                                                               | Tiers absorb them (`Effects.md`): one `tier` the governor drives, not 20 knobs |

> **The core lesson:** V2's controls broke _silently and invisibly_ because nothing connected the control to a checked fact. The fix is not "be more careful updating sliders" — it is to make a control a **generated, validated projection of a declared param**, so a dead control cannot be built and a broken one cannot hide.

---

## 1. THE SHAPE — one schema, two houses

```
                    ┌──────────────────────────────┐
                    │  THE PARAMS SCHEMA (built)    │   ← the ONE source of truth
                    │  core/params-schema.js        │      per effect: {id: {type,min,max,default,label,help}}
                    └──────────────┬───────────────┘
                       ┌───────────┴───────────┐
             (drives)  │                       │  (renders)
        ┌──────────────▼─────────┐   ┌─────────▼──────────────────┐
        │  FRONT OF HOUSE        │   │  REAR OF HOUSE             │
        │  the DIAL layer (new)  │   │  the full schema, categorised
        │  3–6 plain-language    │   │  every knob, expert labels │
        │  macros + presets      │   │  harvested help as tooltips│
        │  → Foundry ApplicationV2│   │  → Tweakpane (+ Advanced)  │
        │  for AVERAGE users     │   │  for the AUTHOR / experts  │
        └────────────────────────┘   └────────────────────────────┘
```

**Both houses are generated from declarations. Nothing is hand-written.** The rear of house renders the params schema directly. The front of house renders a small **dial layer** that _drives_ rear-of-house params through declared remaps. One source, two audiences, zero mirrors — which is F4 solved by construction.

---

## 2. REAR OF HOUSE — the expert surface (full access, generated, categorised)

The rear of house is the complete, technical control set. Its terminology stays expert — that was _correct_ in V2 (`UI.md`); the mistake was making it the _only_ door, not making it technical. Requirements:

- **Generated from the params schema.** A `type → widget` table maps each of the 9 types to a Tweakpane widget, once. `float`→slider, `bool`→checkbox, `color`→colour picker (decoded per its declared `space`), `enum`→dropdown, `curve`→curve editor, `action`→button. **No control is ever hand-constructed** — the tripwire (§6) forbids it.
- **Every param, always.** The rear of house hides nothing. Full supreme access is its job.
- **Harvested help is the tooltip.** The `help`/`glossary` prose already written for 25 of 45 V2 effects (`docs/reference/v2-effect-params/`, the author's own voice) ships as the tooltip on every control, for free. This is the buried treasure `UI.md` §1 named.
- **Consistent categories** (the directive's "consistently organised into categories"). Every effect's params sort into the **same fixed category set**, so the rear of house of _any_ effect is navigable the same way:

  | Category      | Holds                                   | Example knobs                                                            |
  | ------------- | --------------------------------------- | ------------------------------------------------------------------------ |
  | **Presence**  | enable · `tier` · master amount/opacity | on/off, quality tier, overall strength                                   |
  | **Look**      | the core aesthetic                      | colour, tint, contrast, sharpness                                        |
  | **Motion**    | anything time-varying                   | speed, animation phase, flow, wind response                              |
  | **Extent**    | where and how far                       | world scale, coverage, falloff, which mask                               |
  | **Response**  | couplings to the world                  | reaction to light / weather / darkness / time-of-day                     |
  | **Technical** | quality internals                       | thresholds, sample counts, blend modes                                   |
  | _(Readouts)_  | derived status, **not params**          | probe values, live counts — displayed, never stored (`Params.md` §3.6.2) |

  The category is **declared once per param** (a `category` field the renderer reads — presentation, not contract, so it lives beside `label`/`help`), not hand-grouped per surface. A param with no category falls to **Technical** — visible, never lost.

- **Tiers collapse the count.** Most V2 perf sliders become one `tier` the governor drives (`Effects.md`). The rear of house is smaller than V2's _because the knobs that were really "performance" are gone_, not because access was removed.

## 3. FRONT OF HOUSE — the approachable surface (the DIAL layer, new)

The front of house exists so an average GM gets **directed artistic freedom without the firehose**. It is a small set of **dials** (the "dynamic sliders that affect multiple rear controls at once" from the directive) plus **presets**. In the author's own vocabulary: a dial is a **set-driven-key / master attribute** — one control channel driving many downstream channels through a remap curve, exactly like a single _smile_ slider driving thirty blendshapes on a face rig. The difference from V2: the driving is **declared as data and validated**, so it cannot rot into the thing it replaces.

### 3.1 The dial declaration (the new artifact)

```js
// Declared BESIDE the effect, in plain language. Validated against the effect's
// PARAMS schema at build time — a dial that drives a param which does not exist
// FAILS THE BUILD (§6). This is what stops the front of house from becoming the
// new dead-slider minefield.
export const WATER_DIALS = {
  wetness: {
    label: 'Wetness',
    help: 'From a faint damp sheen to a deep, dark pool.',
    range: [0, 1],
    default: 0.4,
    drives: {
      //  rear param      remap into that param's own declared [min,max]
      surfaceOpacity: { to: [0.1, 0.9], curve: 'linear' },
      specularBoost: { to: [0.0, 2.0], curve: 'ease-in' },
      reflectionMix: { to: [0.0, 0.6], curve: 'smoothstep' },
      floorDarken: { to: [0.0, 0.35], curve: 'linear' },
    },
  },
  liveliness: {
    label: 'Liveliness',
    help: 'How much the water moves.',
    range: [0, 1],
    default: 0.5,
    drives: { flowSpeed: { to: [0, 1.5], curve: 'linear' }, rippleAmount: { to: [0, 1], curve: 'ease-out' } },
  },
};
```

- **`drives` is pure data**, not a JS function — so it is inspectable and Node-testable. Each entry names a rear param and a remap into _that param's own declared range_. `curve` is from a fixed set (`linear` · `ease-in` · `ease-out` · `smoothstep`).
- **Moving a dial calls the same validated `setParam` write path** as the rear of house (`validateParamValue`, built). The dial computes each driven param from its curve and writes it. The rear of house updates live as the dial moves — one truth, two views, never out of sync.
- **A preset is the discrete cousin of a dial:** a named snapshot of rear values (`serializeParams` output). "Overcast", "Golden hour", "Menacing". Presets and dials coexist; a preset sets a starting point, dials nudge from there.

### 3.2 Front-of-house design rules

- **Few controls.** 3–6 dials per effect, hard ceiling. If it needs more, it is rear-of-house work wearing a front-of-house costume.
- **Plain language, no jargon.** "Wetness", not "specular Fresnel bias". The label/help here are written _for the average human_ — a separate register from the rear of house's expert terminology.
- **Sensible defaults = Foundry-parity out of the box.** Following `keyhole-two-light-types-decision`: the default state of every effect looks like well-tuned Foundry, so a GM who never opens the panel still gets a good scene. Dials move _away_ from that baseline, they don't build it from zero.
- **Directed freedom, never raw power.** A dial gives a bounded, art-directed axis. It cannot put the effect in a broken state, because its `to` ranges are authored to stay pleasing. Overwhelm lives in the rear of house, behind a door.
- **Progressive disclosure.** A single, obvious **"Advanced →"** control opens the rear of house for that effect. The two houses are one continuous surface with a threshold, not two disconnected apps.

## 4. THE DEAD-CONTROL CURE — F1/F2 solved structurally

The directive's most important ask: _a way to solve dead, silently-broken controls._ There are exactly four ways a control can be "dead," and each has a structural guard — none rely on anyone remembering to check.

| Dead-control mode                                                                                                        | V2 behaviour                                                                    | V3 guard                                                                                   | Enforced by                  |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| **Orphan** — a control with no backing param                                                                             | hand-written folders drifted from params constantly                             | **Impossible** — controls are _generated from_ params; there is no control without a param | §2 generation                |
| **Silent write** — control writes a param that no longer exists                                                          | `this.params[k]=v` skipped unknown keys silently                                | **Throws**, naming the key                                                                 | `validateParamValue` (built) |
| **Dead dial reference** — a front-of-house dial drives a renamed/removed param                                           | (V2 had no dial layer, but this is the new risk it introduces)                  | **Build fail** — `validateDialsSchema` checks every `drives` key against the params schema | §6 tripwire (new)            |
| **Unconsumed param** — the control works, the value updates, but the effect never _reads_ it, so nothing visibly happens | the classic silent dead slider; invisible until someone noticed nothing changed | **Surfaced automatically** — see below                                                     | derived control-health       |

**The unconsumed-param case is the one V2 could never catch**, because nothing knew which params an effect actually used. V3 can, because params flow to effects through `ctx.params` (`Effects-API.md` §5). Two complementary guards:

1. **Runtime (always-on):** `ctx.params` is a **read-tracking proxy**. The set of param keys an effect actually read is recorded. **Control-health = declared − read.** Any declared param never read this session is a _suspected dead control_, surfaced in the debug panel automatically — the same **derived-health** pattern as `pass-health.js` (health is _derived by comparing declaration to runtime_, never a hand-maintained model — `Health.md`). This is the direct answer to "they broke with no warning": now a dead control **announces itself**.
2. **Static (build-time, where feasible):** a Node check that every `PARAMS` key appears as a `ctx.params.X` reference in the effect's build source. Catches the obvious cases before runtime; the runtime proxy is the backstop for computed access.

> **The guarantee, stated plainly:** in V3 a control is a _generated, validated, provably-consumed projection of a declared param_. A dead control cannot be built (F1), a broken write cannot be silent (F2), a dial cannot reference a ghost (build fail), and an unused knob **reports itself** (derived health). The minefield is not swept — it is made unable to form.

## 5. TWEAKPANE, OR OUR OWN? — the decision

**Both, by audience, over one schema — and the "our own" part is the generator and the dial layer, never a new widget toolkit.** Building a bespoke UI framework from scratch would re-buy V2's disease (220 lines per control, in a new coat). The recommendation:

| House              | Tool                                            | Why                                                                                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Rear of house**  | **Tweakpane**                                   | It is _exactly_ the tool for dense, live, expert lookdev (`UI.md` §3). Keep it. Render it from the schema. The author lives here.                                                                                                                                                                |
| **Front of house** | **Foundry `ApplicationV2`** (our own themed UI) | Player/GM-facing product controls want Foundry's native, themeable, permission-aware app framework — not a dev-tool aesthetic. V2 already got this right in 3 files (`UI.md` §5). This is the "our own solution", and it is _thin_ because it renders the dial layer, not hand-written controls. |

The real decision was never the library — it is that **one schema feeds both, through one `type→widget` table, with zero hand-written controls and zero mirrors.** Swap either renderer in an afternoon; the schema is the thing that matters (`UI.md` §5.3). The bespoke engineering is the **generator + the dial layer + the control-health derivation** — the parts that make the walls into rails.

## 6. WALLS & BUILD ORDER

**Tripwires** (media ladder, `Skeleton.md`; each a build failure, not a comment):

1. **No control constructed outside `ui/renderers/`** — no `new Pane()`/`ApplicationV2` control anywhere else. Kills hand-wiring (F1/F4) at the source.
2. **`params/one-owner`** (built) — `.params.X =` outside the params service is a build failure.
3. **`dials/valid-reference`** (new) — every dial `drives` key must exist in that effect's params schema, and its `to` range must lie within the param's `[min,max]`. A dial referencing a ghost, or over-driving a range, fails the build.
4. **`params/must-be-consumed`** (new) — the static half of §4's unconsumed-param check, where the effect's build source is analysable; the runtime proxy is the always-on backstop.
5. **No `readonly`/`throttle`/`expanded`/`advanced` in a contract** (built) — the four-concerns split holds at authoring time.

**Build order** (declaration-first, per `keyhole-stage6-effects-approach`; the params half is done):

1. ✅ `params-schema.js` — the contract + validation. **Built.**
2. The `type → widget` table + the rear-of-house Tweakpane renderer (generated). _First real consumer of the schema._
3. `dials-schema.js` — the dial declaration + `validateDialsSchema` (pure, Node-tested, before any renderer, same as params).
4. The front-of-house `ApplicationV2` renderer (generated from dials) + presets.
5. The read-tracking `ctx.params` proxy + the control-health debug report (derived).
6. The three-tier persistence wiring (Map-Maker / GM / Player), riding `serializeParams`/`hydrateParams` (built) — view state to client settings, values-as-diff to scene flags.

**The velocity test governs all of it** (`Skeleton.md` law 2): declaring an effect's params + a few dials must be _faster_ than hand-writing a folder, or this loses exactly as V2's schema did. One declaration → validation, rear-of-house UI, front-of-house dials, tooltips, persistence, and dead-control detection, all free. That asymmetry is the only thing that keeps the wall a rail.

---

## 7. THE LESSONS, CARRIED FORWARD

- **A control must be a projection of a checked fact, never a hand-wired guess.** V2's controls broke because nothing tied them to a live, validated param. Generate them; validate the write; derive their health.
- **Two audiences, two registers, one truth.** Expert terminology was _right_ — for experts. The failure was having no approachable register at all. Front of house and rear of house are two renderings of one schema, not two codebases.
- **A macro is a rig, and a rig can rot — so declare it as data and validate it.** The dial layer is powerful and is exactly the new place a dead-wiring minefield could regrow. It doesn't, because `drives` is inspectable data checked against the schema at build time.
- **The library was never the question.** Keep Tweakpane, keep ApplicationV2, build the generator. The count drops when tiers absorb perf knobs; the minefield never forms when controls are generated and their health is derived.

---

_V2 gave supreme control and hid a minefield. V3 gives an average human a few honest dials, an expert the whole board, and neither a single control that can die in silence — because every control is generated from a param, validated at the write, and provably consumed or it says so itself._
