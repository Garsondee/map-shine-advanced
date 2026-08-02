# Shader Lab — how to drive it (read this first, don't read the source)

A dev-only page that renders **real production shader code** against **real or synthetic inputs**
on a real WebGPU device, and reports exact numbers. Design: `docs/planning/Shader-Lab.md`.
Growth plan: `docs/planning/Shader-Lab-Proving-Ground.md`.

## 1. Start it

```bash
node tools/shader-lab/serve.mjs
```

Or, from Claude Code, `preview_start` with `name: "shader-lab"` (registered in
`.claude/launch.json`, `autoPort: true`). Then `navigate` to the port **with `force: true`** —
ES modules cache hard and a stale `lab.js` will be served to you *and* to the author.

Working in a git worktree? Start the server **from that worktree** so the page imports that
worktree's `src/`. Instances are cheap and isolated; that is the fleet story.

## 2. Ask what exists — never guess

```js
window.lab.describe()
```

Returns every registered bench, its rung, its scenarios, its params, its check ids. This is
the intended first call. Do not read bench source to find out what a scenario does.

## 3. Run a scenario

```js
await window.lab.run('fixture', 'outdoors-all-floors', { params: { scale: 0.25 } })
```

Returns a **report**:

| Field | Meaning |
| --- | --- |
| `ok` | true only if zero `fail`, zero `UNMEASURED`, and `calibration === 'OK'` |
| `checks[]` | `{id, status, measured, expected, note}` |
| `summary` | counts per status |
| `inputs` / `stats` | what was fed in, what was measured |
| `provenance` | git SHA, branch, **and the hash of every dirty file** |
| `persistedTo` | path under `tools/shader-lab/runs/<runId>/` |
| `artifacts[]` | PNGs etc. saved beside the report |

### The three statuses, and why the third exists

- `pass` — measured, and it matched.
- `fail` — measured, and it did not.
- **`UNMEASURED`** — *could not be measured*. Not a pass. Not a failure. A rig without this
  status will always find a way to call an unmeasured thing green
  (`feedback_instruments_must_not_lie`).

**`ok: false` with zero failures is normal and correct** — it means something real is still
unmeasured. Read `summary`, don't just read `ok`.

## 4. Look at the picture, don't only read numbers

Runs save PNGs to `tools/shader-lab/runs/<runId>/`. **Read those files directly** — you can see
images. A 1-D scanline through a 2-D artifact has lied to us before (that is why
`shaderLab.findHoles()` exists). If the pane won't screenshot for you ("Browser pane is not
displayed"), that is a known caveat and does **not** mean the author can't see it — save a PNG
and read it instead.

Leave the pane showing something meaningful, with the legend naming what is on it. The author
watches this same pane.

## 5. Add a scenario

Scenarios live on their bench (`bench-*.js`), in a `Map` keyed by name, each
`{ name, summary, async run(ctx) → { checks[], inputs, stats } }`. Use `evaluate(id, fn)` from
`contract.mjs` — it turns a thrown predicate into `UNMEASURED` rather than into a false `fail`.

Adding a whole new bench? Follow `fixture-lab.js`: **its own module file, its own canvas, its own
panel, and a second independent `change` listener** on the shared `#effect` `<select>`. Never
edit `lab.js` to add a bench — it is large and another session is often editing it.

## 6. Rules that are not optional

- **Import real `src/` code. Never transcribe it.** A lab-local copy of a shader, a tonemap, or
  a packing rule is a divergence waiting to happen, and we already have one on the books
  (`bench-specular.js`'s hand-written `neutralToneMap`).
- **Verify orientation, never assume it.** Every new texture mapping is a fresh chance to be
  upside-down (`feedback_y_flip_recurring_risk`). Benches calibrate empirically in `selfTest()`.
  If you cannot calibrate, report `UNMEASURED`.
- **Test at the REAL tier / scale.** A device-loss bug was invisible at Standard and only
  appeared at Extreme's real settings. Same for mask scale: production is 1, except `_Specular`
  at 0.5.
- **Lab-green is `BUILT (unverified)`, always.** Only the author, on a real scene, says `LIVE`.

## 7. Fixture One — real authored masks

`tools/shader-lab/fixtures/tower-bridge.mjs` — the "town river bridge" map. Three floors
(underground = an open **river**, middle = deck + town, roof = a few rooftops), every mask
10650 × 4950, the exact regime `vt/mask-image.js` was written against.

⚠️ **Scale costs real memory.** One mask at scale 1 is 52.7 M texels: ~53 MB as `'r'`, ~211 MB as
`'rgb'`, plus an equal transient during decode. Explore at `0.25`; use scale 1 deliberately.
`window.fixtureBench.releaseAll()` frees everything.

Two things in that file are worth reading before you trust any mask assumption: `ART_LAYERS`
(why `_Overhead` is **not** a mask kind — the fixture asserted it was and its own check caught
it) and `BLACK_HAS_TWO_MEANINGS` (an open hypothesis, tagged as such).

## 8. The `derive` bench — real multi-floor derivation

`bench-derive.js` runs the real `deriveFloorProducts` + `rasterizeAuthored` over the real
three-floor item set. **This is the stage the live sun-shadow double-shadow escaped through** —
lab-green march fixes never touched it because the lab used to rasterize its own synthetic caster
packing.

It loads the ART too (at `ART_ALPHA_SCALE`), because the derivation's coverage input is genuinely
art alpha, not a mask — feeding it a mask instead would be inventing the producer's shape.

⚠️ **Two neighbouring grid types with different shapes**, and conflating them is a real trap this
bench already fell into: a `MaskGrid` (what the derivation returns) is `{spec, data}` with its
size on `.spec.w/.h`; a `ContentGrid` (what you feed in) is `{w, h, data}`. Use `gridDims()`.

⚠️ **`coverAbove` ≠ `skyReach`.** `skyReach = outdoors × (1 − coverAbove)`. The top floor has zero
cover above it, so its sky-reach *equals its outdoors mask* — not zero. Asserting otherwise is a
mistake this bench also already made.

## 9. The `composite` bench — rung 3, the gamma arithmetic

`bench-composite.js` renders the REAL `compositeMaterial` from
`environmental-light.js` and checks it against an independent CPU twin. It owns the project's
strongest parity check: **`noon-is-a-no-op`** — at `illum = white` the composite must return the
albedo unchanged (measured to 1.2e-5). Any transfer-function error anywhere breaks it.

Two rules this bench learned the hard way, both worth carrying into any new numeric check:

- **Judge perceptual differences in DISPLAY space, not linear.** Near black, a 37.6% relative
  error is only 0.0023 in linear units. An absolute linear tolerance called the worst case on the
  curve "barely diverging". Convert through the OETF first.
- **Scope a "must NOT match X" check to cases where X is separable.** Gamma and linear
  compositing genuinely agree at `illum = 1`; asserting they differ there would false-fail on
  correct physics.

The CPU twin here transcribes the sRGB transfer pair, which normally this lab forbids. It is
justified *only* because the twin must be independent of the code under test — a twin that
called the same function would be a tautology — and because sRGB is a fixed published spec, not
project code that can drift. Do not take it as licence to transcribe anything else.

## 10. Known-good smoke test

```js
window.lab.describe().benches.map(b => b.name)   // ['fixture', 'derive']
await window.lab.run('fixture', 'outdoors-all-floors', { params: { scale: 0.125 } })
// expect: 21 pass, 0 fail, 2 UNMEASURED, ok:false (orientation + authored points are real gaps)
await window.lab.run('derive', 'multi-floor-bands')
// expect: 13 pass, 0 fail, ok:true
await window.lab.run('derive', 'caster-grid-dim-independence')
// expect: 8 pass — including `detector-is-not-vacuous`, which reproduces the 2026-07-30
// stride bug on the real gate grid to prove the stability check can actually see it.
```
