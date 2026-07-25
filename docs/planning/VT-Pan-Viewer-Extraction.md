# EXTRACTING `vt-pan-viewer.js` — the 11,957-line god-object, split safely

**Status:** IN PROGRESS, 2026-07-25. Steps 1-3 (Sun shadows, Vegetation shadows, Point-light pool) DONE — see §7-9. Author-requested after the size ratchet was bumped three times in one session; steps 2-3 done as Phase 0a of the Water rebuild (`docs/planning/Water.md`), which cannot land until `startVtPanViewer()` has room to grow.
**Companions:** `Skeleton.md` (the enforcement doctrine), `Engine-Postmortem.md` §3, `Keyhole.md` §4.2, memory `keyhole-god-object-forming`.

---

## 0. The one sentence

> **`startVtPanViewer()` is a 10,484-line function — bigger than V2's `FloorCompositor` (10,063), the corpse this project exists to avoid. It grew because every subsystem it hosts needs 5–20 of its closure locals, and no seam ever forced those locals to be named.**

The cure is not "move code to another file". It is to **name the handful of things each subsystem actually needs**, hand them in, and get an object back. Once the dependency is written down as a parameter list, the code can live anywhere.

## 1. Why it grew (so the split does not just re-grow)

`startVtPanViewer` is one closure holding ~40 mutable locals: `renderer`, `scene`, `allocator`, `dimensions`, `view`, `THREE`, `shadowHandle`, `windHandle`, `envLight`, `sceneColor/illum/lit/coloration`, a dozen `let` caches, and the whole item-state `Map`. Every new effect reaches into that bag directly. That is *locally* the cheapest possible thing to do every single time — which is exactly the mechanism `v2-postmortem-the-failure-modes` describes, and precisely why a size wall (not taste) is what caught it.

**The rule for this work:** a subsystem may not be "extracted" while still reading closure state. If the extraction does not produce an explicit parameter list, it has not happened.

## 2. Extraction order — smallest blast radius first

Ordered so each step is independently shippable and independently live-testable. **Each step ends with the ratchet going DOWN**, which is the objective proof it worked.

| # | Subsystem | Est. lines | Why this order |
| --- | --- | --- | --- |
| 1 | **Sun shadows** (`bakeCasterTexture`, `bakeSunShadowField`, `maybeBakeSunShadow`, 6 constants) | ~250 | Newest, best-understood, already has its own pure core + render module + report. Its closure deps are few and already half-named. Lowest risk, and it is the code most likely to keep changing — getting it out first stops the bleeding. |
| 2 | **Vegetation shadows** (`attachVegetationTileShadow`, `vegetationShadowPadPx`, `syncVegetationShadowUniforms`, `padPlacement`, smear constants) | ~400 | Self-contained, has its own tests, and is the other actively-churning area. Shares `setTileGeometry` — that stays behind as a viewer primitive and is passed in. |
| 3 | **The point-light pool** (`updatePointLightMeshes` + entry lifecycle) | ~700 | Big, but its inputs are already an explicit list (`darkness01`, `activeRegions`, `env`, …) because it was written as a function, not inline. Mostly mechanical. |
| 4 | **Whole-image loading** (`ensureWholeImageMeshes`, `refreshWholeImageItem`, the load chain) | ~900 | Large and gnarly (device-loss hardening, BC compression, the serialized chain). Do it once the pattern is proven three times. |
| 5 | **Diagnostics assembly** (`getDiagnostics`'s body) | ~700 | Pure reporting; deferred deliberately because it READS everything, so it is easiest once the subsystems above already expose status objects. |

Stop after any step. There is no half-broken intermediate state — each is a complete move.

## 3. The shape every extraction takes

The precedent already exists in this codebase and should be copied exactly, not reinvented — `buildEnvironmentalLightMaterials`, `buildBloomMaterials`, `buildSunShadowBakeMaterial` are all this shape:

```js
// effects/lighting/sun-shadow-subsystem.js
export function createSunShadowSubsystem({
  THREE, renderer, allocator,        // the engine
  dimensions,                        // the world rect
  envLight,                          // the ONE shared rect uniform (never a copy)
  getCasterHeightField,              // injected seam, already exists
  getSunShadowRenderState,           // injected seam, already exists
  getMaskAuthorityVersion,
  getShadowHandle,                   // () => shadowHandle — a GETTER, see §4
}) {
  // …all the state that is currently viewer-closure locals lives HERE…
  return {
    texture,                         // for envLight/point lights to sample
    rectUniform,
    maybeBake(floorIndex),           // called once per frame by the viewer
    getStatus(),                     // for the report
    dispose(),
  };
}
```

The viewer then holds **one** local instead of eleven, and its frame loop reads:

```js
sunShadows.maybeBake(view?.floorIndex ?? 0);
```

## 4. The four traps, named in advance

1. **⚠️ MUTABLE LOCALS READ LIVE.** `shadowHandle` is *reassigned* every time the sky changes; `casterTexture` is swapped on rebake. Passing the **value** captures a stale one — the exact class as `feedback_residency_sync_vs_render_loop` and the wind-overlay freeze in `wind-access.js`'s own header. **Pass a getter, or return a setter.** Never a bare value for anything that is reassigned.
2. **⚠️ SHARED UNIFORMS MUST STAY SHARED.** `envLight.uSunShadowRect` / `uViewRect` / `outdoorsTexNode` are deliberately one object read by several materials (bloom, grade, point lights). An extraction that "tidies" these into per-module copies silently splits the map in half — `buildOutdoorsGate`'s own doc is about exactly this. Pass the node, never rebuild it.
3. **⚠️ DISPOSE ORDER.** The viewer's teardown disposes targets and textures in a specific order and nulls the closure locals. Each subsystem needs its own `dispose()`, called from the existing teardown — and `BufferAttribute` still has no `dispose()` (`reference_bufferattribute_no_dispose_trap`).
4. **⚠️ TDZ.** This session hit `Cannot access 'SUN_SHADOW_FIELD_DIM' before initialization` from exactly this kind of movement. Constants must be declared before first use, and in a module they simply move with their subsystem — which is one of the real wins here.

## 5. Verification per step (non-negotiable, in order)

1. `npm run verify` green — necessary, **not sufficient**: this session proved twice that Node tests cannot execute the viewer's real closure (both live crashes were invisible to a green suite).
2. **The ratchet goes DOWN.** `npm run ratchets:update` must record a SMALLER number. If it does not, the extraction moved text without moving dependencies.
3. **Author loads a real scene.** Non-negotiable for anything touching render-target wiring — the `.target`/`.samples` crash was only ever findable this way.
4. Diff review for trap #2: grep that no `uniform(` call appeared in the new module for something the viewer already owned.

## 6. What this is NOT

- Not a rewrite. Every extracted line should be the same line, in a new home, with its dependencies named. Behaviour changes and extractions must never share a commit — that is how a regression becomes unattributable.
- Not a chance to "improve" the extracted code. Note improvements, land them after.
- Not `boot.js`. That is a second god-object (4,115 lines / `install()` 3,500) with the same disease and it deserves its own plan, after this one proves the pattern.

## 7. Step 1 — DONE, 2026-07-25

`effects/lighting/sun-shadow-subsystem.js` (`createSunShadowSubsystem`) now owns everything §0 described: the 5 constants, the caster/field state, `bakeCasterTexture`/`bakeSunShadowField`/`maybeBake`, the status report, and (new) a real `dispose()` — see §7.3.

**Ratchet went down**, the plan's own objective proof: `vt-pan-viewer.js` file 11,957 → 11,718, `startVtPanViewer()` 10,484 → 10,255. `npm run verify` green (3,949 assertions, 28/28 structural rules).

### 7.1 A fifth trap, found live (not in the original four)

`renderer-state/graph-only` and `gpu/textures-in-vt-only` are scoped by **directory**, not by call pattern: they allow `.setRenderTarget(`/`new ...Texture(` only inside `vt/`, `graph/`, `diag/`. The sun-shadow bake does both (the march's render-to-target, the caster field's `DataTexture` upload) — legal only because that code used to live inside `vt-pan-viewer.js`. Moving the literal call sites into `effects/lighting/` tripped both walls immediately; this was not anticipated by the original 4-trap list.

**Fix, not a workaround:** the two GPU-touching operations became caller-supplied callbacks — `renderSunShadowPass(target, quad)` and `createCasterTexture(data, w, h)` — defined in `vt-pan-viewer.js` (so the literal `.setRenderTarget(`/`new ...Texture(` text stays inside `vt/`, exactly where both walls already sanction it) and invoked by the subsystem, which only decides *when* to bake and *with what data*. This is the same shape as the pre-existing `getCasterHeightField`/`getSunShadowRenderState` seams, and it is literally the frame-graph pattern the walls' own `instead:` text prescribes ("a pass declares reads/writes and is HANDED a target"), applied one step early.

**Add this as trap #5 for steps 2-5:** any extracted subsystem that allocates a render target's *texture* or calls `setRenderTarget` directly will trip these two walls the moment it leaves `vt/`. Check for both patterns in the code being moved BEFORE writing the new module's signature, not after `verify:structure` fails.

### 7.2 The leak this step fixed

Confirmed while extracting: neither `sunShadowRt` nor `sunShadowBake.material` had ever been disposed anywhere in `vt-pan-viewer.js` — every Stop/Restart cycle leaked one 1024² RGBA8 render target and one NodeMaterial. The subsystem's new `dispose()` fixes it; wired into `disposeActive()`'s list as `disposeSunShadows()`, same one-method-per-subsystem pattern as `disposeSceneColor`/`disposeLighting`.

### 7.3 Not yet done

Live-scene verification — non-negotiable per §5.3, still outstanding. Two real crashes this feature already produced (the TDZ, the `.target` typo) were both invisible to the test suite; this extraction touches the exact same render-target wiring, so it needs the same check before being trusted.

## 8. Step 2 — DONE, 2026-07-25

`effects/vegetation-shadow-subsystem.js` (`createVegetationShadowSubsystem`) now owns: the 6 constants (`VEG_SHADOW_RENDER_ORDER_MAGNITUDE`, `VEG_SHADOW_SMEAR_TAPS`, and 4 more), `padPlacement`/`vegetationShadowPadPx` (pure, exported standalone — `setTileGeometry` and the Case-2 overlay build both still need them), and `attachTileShadow`/`syncUniforms` (the old `attachVegetationTileShadow`/`syncVegetationShadowUniforms`). Trap #1 confirmed live: `shadowHandle` is reassigned on every sky change (`vt-pan-viewer.js`), so it's taken as `getShadowHandle: () => shadowHandle`, not a value. Traps #2 (no new `uniform(` calls) and #5 (no `setRenderTarget`/`new *Texture`) both checked clean.

This step's before/after numbers are folded into a single large checkpoint commit (`e092f6d`) alongside ~150 files of previously-uncommitted V3 work, so a clean isolated delta isn't recoverable from git history — the honest number is step 3's, below, measured against that checkpoint as the baseline.

## 9. Step 3 — DONE, 2026-07-25

`effects/lighting/point-light-pool.js` (`createPointLightPool`) now owns: `lightScene`/`colorationScene` (exposed properties, read directly by the render loop), `lightMeshes`/`candleWallClipCache` (exposed Maps, read by wind-rebake marking and by `getPointLightsInfo` diagnostics — deliberately untouched, see §2 row 5), `INITIAL_LIGHT_FAN_VERTICES`, and `update()`/`dispose()` (the old `updatePointLightMeshes`/`disposePointLights`).

**Ratchet went down**, against the checkpoint baseline: `vt-pan-viewer.js` file 11,957 → 11,009, `startVtPanViewer()` 10,484 → 10,270 (well under its own frozen budget — no `ratchets:update` needed). `npm run verify` green (3,949 assertions, 28/28 structural rules).

### 9.1 A deliberate non-move: `uGlobalTimeMs`

The one shared animation-clock TSL uniform is written ONLY by this pool but read by roughly a dozen unrelated consumers (the wind sim's input bundle, vegetation motion sync, several TSL light-animation builders, diagnostics). Moving it into `point-light-pool.js` alongside its one writer would mean every unrelated caller reaching back into "the point-light module" for a general-purpose clock — the wrong owner, chosen only because that's where the one write happens to live. It stays a `vt-pan-viewer.js` primitive (like `dimensions`/`scene`), taken by this pool as a plain value.

### 9.2 Trap #6, found live: nesting doesn't shrink the ratchet's measurement

The first draft split the ~150-line "build a brand-new light entry" block into a function NESTED inside `createPointLightPool`'s own closure (so it could read `lightScene`/`envLight`/etc. for free). `verify-structure.mjs`'s `largestTopLevelFunction` measures the brace span of the outer, COLUMN-0 function only — a nested `function` declaration doesn't create a second measured span, it just adds lines to the one that already exists. The nested version made the violation WORSE (502 → 520 lines), not better.

**The fix:** `createLightEntry` had to become a genuine top-level (column-0) function, which meant every value it used to close over — `THREE`, `envLight`, `sunShadows`, `sceneColor`, `uGlobalTimeMs`, `lightScene`, `colorationScene` — became an explicit parameter instead. More verbose at the call site, but this is arguably the correct shape anyway: `createLightEntry`'s full dependency list is now written down rather than implicit, which is the extraction plan's own §1 rule applied one level deeper than the plan's own examples show.

**Add this as trap #6 for steps 4-5:** if a subsystem's own function is still over the 500-line cap after extraction, splitting a piece of it into a function nested INSIDE that same factory buys nothing — measure against the outer, column-0 span. The split must go all the way to top-level, with its dependencies named explicitly, same as the subsystem itself.

### 9.3 A real behavior-change caught before it shipped

The first draft of `dispose()` replaced the original's per-resource `try { ... } catch (err) { log.error(...) }` (log and continue to the next entry, always `.clear()` at the end) with `throw new Error(...)` on first failure. That is a real behavior change bundled into what was supposed to be a pure extraction — worse, on a real dispose failure it would now skip disposing every remaining entry AND skip the final `.clear()`. Caught by re-reading the diff against the original before running it, not by a test (a thrown dispose error has no test coverage either way). Restored to the original catch-log-continue shape, with `createLogger('PointLightPool')` replacing the viewer's own `log` reference.

### 9.4 Not yet done

Live-scene verification — non-negotiable per §5.3, still outstanding, same as step 1. Point lights + candles + wind response + sun-shadow sampling all reconcile in this one pool; a live session with real lights, at least one wind rebake, and a sun sweep is the check, not a green test suite.

---

_The size wall did its job: it caught a 10,484-line function that every other rule in the file called healthy. The wall is not asking for tidiness — it is asking for the dependency list nobody has ever had to write down._
