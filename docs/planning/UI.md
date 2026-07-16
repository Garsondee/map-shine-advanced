# UI — was Tweakpane the wrong choice?

**Status:** RESEARCH + DECISION SEED, 2026-07-16. Author: *"Was tweakpane a good choice? The module ends up with... pardon my language... fucking hundreds of controls. Was it a good choice or is there a better choice for the UI?"*
**Companions:** `Effects-API.md` (params are 2,197 read-hits — the biggest effect input), `Environment.md` (§0.4, seven homes per weather value), `v2-postmortem-the-failure-modes`.

---

## 0. The answer

**No, Tweakpane was not the problem — and swapping it would have fixed nothing.** The evidence is arithmetic:

| | |
|---|---|
| `legacy/ui/` total | **58,603 lines** |
| Tweakpane API calls in all of `legacy/ui/` | **266** |
| **Our code per control** | **≈220 lines** |

If the library were the problem you would expect thin wrappers around it. 220 lines of hand-written plumbing per control says the library is a rounding error. **Tweakpane rendered the controls fine. Everything around it was the disaster.**

> **The real finding: V2 already had a declarative control-schema system, and the UI ignored it completely.**

`static getControlSchema()` exists in **48 effect files**. `tweakpane-manager.js` references it **zero times**. There is **no generic schema→UI renderer anywhere in the codebase**. The manager hand-writes every folder for **11,157 lines** while 48 schemas sit unused next to the effects that own them.

**That is the seventh independent instance of the module's one disease** (`v2-postmortem` §1): EffectComposer (5 importers vs 92), the Foundry adapter (21 of 128 files), `resolve-effect-enabled`'s ignored MUST, `time.js`'s ignored MUST, `msa-v2-darkness`'s ignored MUST, quarks-as-the-one-particle-engine — **and now the control schema.** Seven correct designs, seven bypasses. Not carelessness: at ~2,000 lines/day (`Engine-Postmortem.md` §0), hand-writing the folder you need *right now* is faster than writing the generic renderer that would make it unnecessary. **Structure loses to velocity, every time, unless it is the fast path.**

## 1. What the schemas actually contain — this is the buried treasure

`specular-control-schema.js` is not a list of sliders. It is:

```js
{
  enabled: true,
  help: {
    title: 'Metallic / specular (tile overlays)',
    summary: [ /* rich markdown: what it does, how it composes, perf notes, storage scope */ ],
    glossary: {
      _Outdoors: 'Whether an indoor/outdoor mask is bound — white = outdoor…',
      Intensity: 'Overall strength of the shine pass.',
      'World scale': 'How large world-space shimmer patterns are — higher = bigger, calmer glint clusters.',
      /* … per-control explanations, in the author's voice */
    },
  },
  /* … the actual params */
}
```

**This is documentation, help text, glossary and parameter definition, authored next to the effect, in the author's own voice.** It is the single most valuable non-shader artifact in `legacy/`, and it is *already written* for 48 effects. It is also — not coincidentally — exactly the `params` schema that `Effects-API.md` §5 says every effect declaration needs.

**Harvest it wholesale.** It is years of hard-won explanation of what every knob does, and it cost the author real effort to write.

## 2. The actual disease: three UI surfaces, hand-mirrored

- `tweakpane-manager.js` (11,157) — the main pane
- `control-panel-manager.js` (5,533) — the GM control panel
- `graphics-settings-manager.js` (1,607) — the settings dialog

…rendering **overlapping subsets of the same 938 params**, kept coherent by **~140 hand-written sync/mirror/hydrate functions**. That is `Environment.md` §0.4's "seven homes per weather value" — the UI half of it. `weather-param-bridge.js` exists *solely* to shuttle values between two of these surfaces, and its docstring is a hand-written authority protocol with ordering rules.

**None of that is Tweakpane's fault.** It is the fault of having no single owner for a param and no generator to render it.

## 3. So: keep Tweakpane, or not?

The honest split — **it depends on the surface, and V2 conflated two audiences into one library:**

| Surface | Audience | Right tool |
|---|---|---|
| **Effect tuning** (hundreds of knobs, live, dense) | the author, doing lookdev | **Tweakpane.** It is *exactly* this tool. Dense, live-binding, folder-nesting, zero ceremony. Nothing better exists for it. |
| **Player/GM product settings** (a handful, themed, persistent) | end users | **Foundry's own `ApplicationV2`.** Themed, integrates with settings/permissions, is what users expect. V2 already does this correctly in 3 files (`graphics-settings-menu-app.js`, `native-rendering-settings-menu-app.js`, the loading-screen dialog). |

**"Hundreds of controls" is not a UI-library problem — it is a symptom.** Those hundreds exist because (a) every effect's knobs are exposed raw, and (b) tiers didn't exist, so *performance* was a manual knob-hunt rather than one ladder (`Effects.md`). Under Keyhole, most per-effect performance knobs collapse into `tier`, and the governor drives it. **The knob count should drop hard on its own.**

## 4. THE KEYHOLE DESIGN — generate, never hand-write

**One rule, and it makes the library question almost irrelevant:**

> **The UI is GENERATED from the params schema. No control is ever hand-written.**

```js
// The effect declares (Effects-API.md §5) — this is the ONLY home:
export const SPECULAR_PARAMS = {
  intensity: { type: 'float', min: 0, max: 4, default: 1,
               label: 'Intensity', help: 'Overall strength of the shine pass.' },
  worldScale: { type: 'float', min: 0.1, max: 10, default: 1,
                label: 'World scale', help: 'How large world-space shimmer patterns are…' },
  tint: { type: 'color', default: '#ffffff', label: 'Specular tint', help: '…' },
};
// ui/ renders it. Tweakpane for the dev pane, ApplicationV2 for the player dialog.
// Same schema. Two renderers. Zero hand-written controls. Zero mirrors.
```

**What this buys, all of it structural:**
- **The 11,157-line manager becomes a renderer of a few hundred lines** — because 938 params × a generator is a table, not 220 lines each.
- **The ~140 sync/mirror functions cease to exist.** One home per param (the params service), N views reading it. Nothing to keep in sync — that is the whole "seven homes" fix.
- **Help text ships automatically.** The `help`/`glossary` the author already wrote becomes tooltips in every surface, for free, forever — instead of rotting unused.
- **A new effect gets a UI for free.** Declare params → the pane exists. **This is the velocity test (`Skeleton.md` §0, second law): the correct path becomes FASTER than hand-writing a folder.** That is the only reason it will survive contact with a 2,000-line day — and precisely why V2's schema lost: writing the generic renderer was slower *that afternoon* than hand-writing one folder.
- **Both audiences from one source.** Dev pane and player dialog are two renderers over the same declaration; they cannot drift.

**Tripwire (queued, per covenant rule 4):** no Tweakpane/`ApplicationV2` control constructed outside `ui/renderers/`; `.params.X =` writes only via the params service. Both are already on `Skeleton.md`'s tripwire list.

## 5. Recommendation

1. **Keep Tweakpane** for the author-facing tuning pane. It is the right tool for dense live lookdev, and the 266 API calls were never the problem.
2. **Keep `ApplicationV2`** for player/GM-facing settings — V2 already got this right in 3 files.
3. **Neither is chosen until the params schema exists**, because the schema is the actual decision. Once params are declared, the renderer is a detail you could swap in an afternoon.
4. **Harvest the 48 `getControlSchema()` bodies verbatim** — help text, summaries and glossaries especially. That is the author's voice and it is irreplaceable.

---

*Tweakpane was never the problem. 220 lines of plumbing per control was. Declare the params once; render them twice; hand-write nothing.*
