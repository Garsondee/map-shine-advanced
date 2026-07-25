# EXTRACTING `vt-pan-viewer.js` — the 11,957-line god-object, split safely

**Status:** IN PROGRESS, 2026-07-25. Step 1 (Sun shadows) DONE — see §7. Author-requested after the size ratchet was bumped three times in one session.
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

---

_The size wall did its job: it caught a 10,484-line function that every other rule in the file called healthy. The wall is not asking for tidiness — it is asking for the dependency list nobody has ever had to write down._
