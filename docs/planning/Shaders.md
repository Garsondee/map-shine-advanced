# Shader compilation, TSL, and the ground to prepare

---

## ⚡ DECISION (author, 2026-07-16): **WebGPU + TSL is the direction.** This note's §5 recommendation is superseded.

**Author's call, verbatim intent:** _"we have to work on the basis that WebGPU is the way to go... the improvements that TSL offers us are extremely hard to turn down... WebGPU is the future and TSL should be able to do everything that WebGL2 can do and a lot more, better memory management... it seems like a bad idea to build the entire module on a slightly outdated technology."_ Plus: **every effect gets a tiered arrangement, with the most basic tier deliberately lightweight.**

**This overrules §5's "don't port now", and the evidence now supports the author rather than my caution:**

1. **The first spike run's "FAILURE" was MY INSTRUMENT, not TSL.** WebGL2 returned `[0,165,255]` against an expected `[0,96,255]` — red and blue exact, and 96→165 is precisely **sRGB encoding of linear 96**. The pointer→layer lookup was _perfectly correct_; the renderer applied its default output colour conversion and my comparison didn't know. **WebGL2 passed all three hard parts.** WebGPU returned `[0,0,0,0]` — including **zero alpha**, i.e. "nothing was read", not "wrong colour drawn": it compiled cleanly in 406ms, and my readback fell back to `backend.gl`, which does not exist on `WebGPUBackend`. Both fixed; re-run required.
2. **The strongest argument is one I under-weighted: memory.** WebGPU has an _explicit_ resource model — you create, you `destroy()`, you know what exists. WebGL's is implicit and driver-managed. This project's entire crisis was VRAM it could not see or control (§1: "102–103% of ceiling", masks+PIXI at 75% before one RT existed). Keyhole's thesis is a **fixed, explicit budget**; WebGPU's model _is_ that thesis, and WebGL's fights it. That alignment matters more than the porting cost.
3. **Reach:** WebGPU shipped in Chrome 113 (May 2023) and Chrome auto-updates; the author's read is that the vast majority of Foundry users have it and skew to decent hardware.
4. **Compounding cost:** every GLSL shader written from here is written twice later. At one shader, that debt is zero. It only grows.

**What stands from the original analysis (unchanged by the decision):**

- **TSL is not "the WebGPU language" — it runs on BOTH backends** (`three.webgpu.js` has `WebGLBackend` _and_ `WebGPUBackend`). So there is **ONE source per effect**, never a hand-written WebGL2 twin. The tiers below are variants _within_ it.
- **TIERS ARE DRIVEN BY MEASURED PERFORMANCE, NOT BY BACKEND.** Having WebGPU means the _browser_ is recent, not that the _machine_ is fast. A 2017 laptop on current Chrome has WebGPU; handing it the expensive tier is the exact crash Keyhole exists to prevent. The DRS governor and explicit user settings choose the tier; backend selection is a separate, automatic thing.
- **Workers still cannot compile shaders** (§2) — structurally, on either backend.
- **The design floor still exists.** "Most users have good hardware" is a reason to make WebGPU primary; it is not a reason to stop having a cheap tier. §4.3's PIXI rung remains the last resort.

**Confirmed live on the author's 3070 (2026-07-16):** `parallelShaderCompile: true`, `precompileMs: 13`, `programCount: 1` — the KHR extension IS present, so §3's good case is the real one, and the precompile added in `3cafa1e` genuinely parallelises.

**Sequencing (unchanged in spirit by the decision):** re-run the fixed spike first. It is now ~10 minutes of the author's time to convert "WebGPU works here" from a belief into a pixel. Only then port the core, once, and delete the GLSL — never maintain both.

---

**Status:** DESIGN NOTE (authored 2026-07-16, at the author's request: _"give some serious thought to shader compilation for both webGL2 and TSL — what can we do to prepare the ground for these things? Organisation is key. Web workers might be appropriate but might not be."_)
**Scope:** thinking and decisions, not a build plan. Nothing here is scheduled. It exists so the decisions are made **while the cost of being wrong is still one shader**.
**Relationship to Keyhole.md:** subordinate. Q3 (_"WebGL2 now — do not block the rebirth on it"_) and §4.3's deferred tiered fallback are unchanged by this note; it explains what those decisions cost and what makes them cheap to revisit.

---

## 0. Why now, and the one number that matters

MSA has **exactly one shader program** today (`vt/vt-sample.glsl.js`, inlined by `ensureItemMesh`). Keyhole §4.4 maps ~48 V2 effect classes onto ~10 passes, each with its own shaders and their own variants.

So the honest framing is: **every organisational decision here is currently free and will never be this cheap again.** That is the entire argument for spending an hour on it now rather than at effect #12.

Everything below is verified against the vendored v14 Foundry source and the vendored/npm Three r185 build. Where a claim is load-bearing, the file and line are cited — several widely-believed things about this topic turn out to be false.

---

## 1. Verified facts (check these before trusting any of the reasoning)

| Fact                                                                                                 | Evidence                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Our vendored Three is the **classic WebGL-only** build — no node system, no TSL, no `WebGPURenderer` | `src/vendor/three/three.module.js`: 0 hits for `class NodeMaterial`, `class Node`, `WebGLBackend`                                                              |
| `three@0.185.1` **does** ship TSL                                                                    | `package.json` exports include `./tsl` and `./webgpu`; `build/` contains `three.tsl.js`, `three.webgpu.js`, `three.webgpu.nodes.js`                            |
| **`WebGPURenderer` has a WebGL2 backend**                                                            | `three.webgpu.js` contains `class WebGLBackend` AND `class WebGPUBackend`, plus a `forceWebGL` flag                                                            |
| `compileAsync` **is not async compilation**                                                          | `three.module.js:42011` — `const materials = this.compile(scene, camera)` runs **synchronously**; only the completion _wait_ is a promise                      |
| Without `KHR_parallel_shader_compile`, `compileAsync` **resolves immediately and does nothing**      | `three.module.js:36061` — `let programReady = parameters.rendererExtensionParallelShaderCompile === false;` → `isReady()` is instantly `true`                  |
| The async wait is a **10ms `setTimeout` poll** of `COMPLETION_STATUS_KHR`                            | `three.module.js:42024`, `36066`                                                                                                                               |
| **We never precompile anything**                                                                     | no `compileAsync` call anywhere in `src/` — every program compiles lazily on first draw                                                                        |
| Identical `ShaderMaterial` source **shares one program**                                             | `three.module.js:36407` — the cache key uses `customVertexShaderID`/`customFragmentShaderID`, i.e. source identity. Our N item materials cost 1 program, not N |
| Legacy's `build:tsl` **was inert**                                                                   | `legacy/build/entry.js`: `const { TSL } = THREE` on the _classic_ build is always `undefined`, so its `if (TSL)` never ran. Its own log line says "WebGL-only" |

That last row deserves a moment. There is prior art for "we did TSL", and it did nothing at all, silently, for however long it existed. Nobody was lying; the classic entry point simply doesn't export TSL, and nothing failed loudly enough to notice. **Treat any future "TSL is wired up" claim as unproven until a node actually renders.**

---

## 2. The web-worker question, answered

The author's instinct — _"might be appropriate but might not be"_ — is right to be suspicious. The answer is a hard no, for a structural reason rather than a performance one.

> **A worker cannot compile a shader for the main thread's renderer. Not slowly, not with effort — at all.**

WebGL objects (`WebGLProgram`, `WebGLShader`) belong to the **context that created them**. A worker with an `OffscreenCanvas` has its _own_ context. There is no program sharing, no serialisation, no transfer, and no extension that adds one. A program compiled in a worker is unusable in the main thread, permanently.

So the three things workers _could_ do here:

1. **Generate shader source strings** (TSL→GLSL codegen, permutation expansion, `#include` resolution). Real work, no GL — a worker _can_ do it. But it is string manipulation measured in **single-digit milliseconds**, against compiles measured in **tens to hundreds**. Moving it would be optimising the wrong end, and would cost an async boundary on every material creation. **Not worth it.**
2. **Run the entire renderer in a worker** via `OffscreenCanvas`. This genuinely moves _all_ GL — compiles included — off the main thread, and would help far more than shaders. But MSA reads Foundry documents (`canvas.scene`, tiles, tokens, `vision.los`) on every residency update, and those live on the main thread. Every frame would need a marshalled snapshot. It's a rewrite, and it fights Keyhole's actual thesis (the problem is the cost _model_, not the thread). **Recorded, not scheduled.** If it is ever done, it should be for main-thread stalls generally, not for shaders.
3. **Nothing else.**

**The thing that actually does what people hope workers will do is `KHR_parallel_shader_compile`** — the _driver_ compiles on its own threads, and the API returns immediately. It is already in the vendored build, already auto-detected by Three, and **we have never used it**, because we never call `compileAsync`.

That is the real finding of this section: the parallelism is sitting there, switched off, and the thing everyone reaches for instead is incapable by construction.

---

## 3. What `compileAsync` actually buys (and what it doesn't)

Read `three.module.js:42011` carefully, because the name is misleading:

```js
this.compileAsync = function (scene, camera, targetScene = null) {
  const materials = this.compile(scene, camera, targetScene); // ← SYNCHRONOUS. All of it.
  return new Promise((resolve) => {
    /* poll isReady() every 10ms */
  });
};
```

`this.compile()` walks the scene and, for every material, does `createShader` / `shaderSource` / `compileShader` / `attachShader` / `linkProgram` **on the main thread, now**. What the promise defers is only _waiting for the result_.

Whether that is a win depends entirely on one extension:

- **With `KHR_parallel_shader_compile`:** `linkProgram` hands the work to driver threads and returns. `isReady()` polls `COMPLETION_STATUS_KHR` **without blocking**. The main thread is free. This is the good case, and it is real.
- **Without it:** `programReady` is initialised to `true` (line 36061), `isReady()` lies immediately, the promise resolves at once — and the driver's compile blocks at the **first `getProgramParameter`/`useProgram`**, i.e. inside the first `render()`. The stall does not disappear; it moves somewhere less visible.

**Consequence:** `KHR_parallel_shader_compile` availability is not a detail, it is the fork in the road. It must be a reported fact, not an assumption — the design floor for this project is an 8GB laptop GPU on ANGLE/D3D11, and "which extensions does this machine actually have" is exactly the class of thing this project has been burned by before.

---

## 4. The TSL reframe — the important architectural fact

The naming misleads here too, and it matters more than anything else in this note.

> **`WebGPURenderer` is not "the WebGPU renderer". It is the node-based renderer, and it has two backends: `WebGPUBackend` and `WebGLBackend`.**

Evidence: `three.webgpu.js` contains both classes plus `forceWebGL`. So:

- **§4.3's ladder is not two renderers.** "WebGPU → WebGL2" is _one_ renderer selecting a backend — a far smaller thing than the plan currently implies, and a strong argument that the tiered fallback's top two rungs are cheap _if and only if_ shaders are written in TSL.
- **TSL is the write-once layer.** A TSL node graph emits WGSL for WebGPU and GLSL for WebGL2 from the same source. Writing 48 effects' shaders as GLSL strings is choosing, now, to write them twice later.
- The third rung (native Foundry PIXI, `diag/render-fallback.js`) is unaffected — it is a different renderer entirely, and already built.

This reframes Q3. "WebGL2 now" is still right, but the _reason_ changes: it is not "WebGPU is far off so ignore it", it is **"the port is a backend swap, provided the shaders are portable."** The cost of TSL is paid per shader written; the cost of _not_ using it is paid per shader rewritten.

---

## 5. Should we port to TSL now? No. Here is the honest reasoning.

**Arguments for porting now:**

- One shader exists. It will never be cheaper.
- Every GLSL string written between now and the port is written twice.
- §4.3's ladder becomes nearly free.

**Arguments against, which win:**

- **Q3 is explicit:** _"WebGL2 now (rec) — §16 W-track conventions keep the WebGPU port mechanical later; **do not block the rebirth on it**."_ §4.3's ladder is _"explicitly deferred — do not build it unprompted."_ This note is not grounds to overturn either; it is grounds to make the eventual port cheap.
- **It would put the most expensive-to-earn code in the project at risk.** `vt-sample.glsl.js` survived **nine live-debugged bugs** (Y-flip → coordinate space → clamp-bound → GL interleaving → texture-unit cache → the UV-compounding bug). Rewriting it as a node graph re-opens every one of those, in a system where `texelFetch`-on-an-indirection-texture and `sampler2DArray` semantics are exactly the sharp edges.
- **It swaps the renderer wholesale.** `WebGPURenderer` + `WebGLBackend` is a different code path from `WebGLRenderer` — different state handling, different extension paths. That is a Stage-3-sized change landing during Stage 2.
- **TSL cannot express everything yet**, and finding that out mid-port is the worst time.

**Decision: stay on classic `WebGLRenderer` + GLSL. Prepare so the port is mechanical, and buy the cheap wins now.**

---

## 6. What "prepare the ground" actually means

Not "build a shader framework". Four disciplines, in descending order of value-per-effort:

### 6.1 Shaders are DECLARED, not inlined _(the one that matters)_

Today `ensureItemMesh` builds a `ShaderMaterial` with a template literal containing `${VT_SAMPLE_GLSL}`. Correct for one shader; fatal at forty, and for a specific reason: **an inlined string has no identity.** You cannot precompile it, count it, budget it, or swap its backend, because nothing knows it exists.

The shape to converge on — deliberately the same shape TSL's `Fn()` already has, which is what makes the port mechanical:

```
a shader module declares:  { id, uniforms (a real schema), variants (an explicit list), source(variantKey) }
```

Explicit uniform schemas are what a TSL port consumes; a hand-written string with implicit conventions is what it chokes on. **This costs nothing today and is most of the port later.**

### 6.2 Permutations are the real explosion risk

The failure mode is not "shaders are slow to compile". It is **N effects × M variants = a program count nobody counted**, each one a first-draw stall, discovered in the field.

Rules to adopt before there is anything to fix:

- **Prefer a uniform branch to a `#define` variant** unless profiling says otherwise. A uniform costs a little GPU; a `#define` costs a whole program, permanently, per combination. On the design-floor GPU, program count is the scarcer resource.
- **Variants are declared, never implicit.** If a shader has 3 variants, that number is written down and countable. A variant key assembled ad-hoc from booleans is a combinatorial explosion waiting to be discovered by a crash report.
- **The program count is a reported diagnostic**, like page residency. "How many programs exist and what did they cost" is exactly the class of question this project has repeatedly needed and not been able to answer.

### 6.3 Compilation is scheduled work, like everything else

This project's whole thesis is that unbounded synchronous work is what kills it. Compilation is unbounded synchronous work that nobody has looked at yet. It should obey the same rules as decode and upload: **precompiled before first draw, paced, and reported** — and it now has an obvious home, since `ui/loading-screen.js` already has a `FIRST_FRAME` phase that a compile stall would hide inside.

### 6.4 Keep the backend boundary thin

One place creates materials. Today that is `ensureItemMesh`. Keep it that way: the port's blast radius is exactly the number of places that say `new THREE.ShaderMaterial`.

---

## 7. Concrete, non-speculative next steps

Ordered by value-per-risk. None of these is a framework.

1. **Report whether `KHR_parallel_shader_compile` exists.** One line in the boot/GPU report. It decides everything in §3, it is currently unknown on the author's own machine, and this project does not guess about extensions.
2. **Call `compileAsync` before the first frame**, inside the loading screen's `FIRST_FRAME` phase. ~10 lines. Turns an invisible first-draw stall into either (a) free driver-thread work, or (b) a _measured_ stall we can see — and the loading screen's `worstStallMs` already reports it.
3. **When the second shader arrives — not before — introduce the declaration shape in §6.1.** One shader does not justify a registry. Two are the moment the convention has to exist, and the moment it is still nearly free.
4. **Record the program count** in diagnostics once there is more than one.
5. **Vendor `three.webgpu.js` + `three.tsl.js` and render one trivial TSL node** — a spike, not a migration, timeboxed, on a branch. This is the only way to convert "TSL will work" from a belief into a fact, and legacy's inert `build:tsl` is exactly what happens when nobody does. Do this _before_ committing to TSL for 48 effects, not during.

## 8. What NOT to do

- **Do not put shader compilation in a worker.** It is structurally impossible (§2). If someone proposes it, the answer is `KHR_parallel_shader_compile`.
- **Do not port `vt-sample.glsl.js` to TSL as the first TSL work.** It is the most expensive code in the project to have gotten right. Port something new and disposable first.
- **Do not build a shader registry for one shader.**
- **Do not trust `compileAsync`'s name.** Without KHR it is a no-op that moves the stall rather than removing it.
- **Do not repeat legacy's `build:tsl`** — importing from `'three'` and hoping `TSL` is on the namespace. It isn't, it never was, and it failed silently.
