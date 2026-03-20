# PIXI Bridge: WebGL Context Sharing — Investigation & Options

**Date:** March 2026  
**Scope:** Whether Map Shine Advanced can integrate the PIXI content-layer bridge with Foundry’s PIXI renderer using a **shared WebGL context** so overlay pixels move **GPU → GPU** without `readPixels` / CPU staging, and what the browser and Foundry constraints actually allow.

---

## Executive summary

| Question | Answer |
|----------|--------|
| Can two *separate* WebGL contexts (PIXI’s and Three.js’s) **share** textures or FBOs the way desktop GL “shared contexts” do? | **No** — not in shipping browsers. Cross-context GPU resource sharing was proposed (`WEBGL_shared_resources`) and **rejected**; there is no supported API to bind one context’s `WebGLTexture` in another. |
| Can PIXI and Three.js still achieve **zero-copy** use of a PIXI `RenderTexture` in Three.js? | **Yes, but only if they use the *same* `WebGLRenderingContext`** (same canvas, same `gl`). Then the underlying `WebGLTexture` handle is valid for both engines. |
| Does this codebase already support that? | **Partially.** `renderer-strategy.js` can construct `THREE.WebGLRenderer` with `context` + `canvas` from Foundry (`bootstrap.js`). `PixiContentLayerBridge._injectPixiRTToWorldTexture()` and `FoundryFogBridge._pixiToThreeTexture()` inject PIXI’s GL texture handle into Three’s texture property map **only when** `pixiRenderer.gl === threeRenderer.getContext()`. Sharing is **opt-in** via `window.MapShine.__usePixiSharedWebGLContext === true` at bootstrap. |
| Is this “better than a kludge”? | For **throughput**, same-context injection is the **correct** GPU path. Operationally it is **not** a small integration: two renderers on one context imply **strict GL state discipline**, **frame ordering**, and **compatibility risk** with anything that assumes exclusive ownership of Foundry’s canvas or GL state. |

---

## 1. What “shared WebGL context” means in a browser

### 1.1 Not available: two contexts, one GPU namespace

OpenGL ES has concepts of shared object namespaces between contexts. **WebGL deliberately does not expose** general cross-context sharing. Practical consequences:

- Each `<canvas>` (or each `getContext('webgl'|'webgl2')`) normally gets its **own** context.
- A `WebGLTexture` created in context **A** is **not** valid to bind in context **B**.
- Workarounds are **copy** paths: e.g. readback, `texImage2D` from a **2D canvas** or `ImageBitmap`, or compositing in the DOM — not a shared object handle.

References: [Khronos WebGL wiki — Shared resources](https://www.khronos.org/webgl/wiki/SharedResouces), [Rejected `WEBGL_shared_resources`](https://registry.khronos.org/webgl/extensions/rejected/WEBGL_shared_resources/).

### 1.2 What *is* supported: one context, two consumers

`THREE.WebGLRenderer` accepts:

```js
new THREE.WebGLRenderer({ canvas: existingCanvas, context: existingGl });
```

That does **not** merge two contexts — it makes Three.js a **second user** of an **existing** context. PIXI’s renderer and Three.js then **must** cooperate on:

- **Default framebuffer** vs **off-screen** targets (who clears, who presents).
- **GL state** (program, VAO, blend, viewport, scissor, framebuffer binding) — each frame typically needs a defined handoff contract.
- **Resource lifetime** — textures created by PIXI remain owned by that context; Three.js only **references** the same GL names.

This is the only standards-based way to get **true** reuse of PIXI’s `WebGLTexture` inside Three.js materials.

---

## 2. Current architecture in this repo

### 2.1 Slow path (separate contexts): GPU → CPU → GPU

Documented in `docs/planning/TEMPLATE-PIXI-BRIDGE-ONGOING-INCIDENT.md` and implemented on the bridge fallback path:

1. PIXI renders to a `RenderTexture`.
2. `renderer.extract.canvas(...)` (or equivalent) forces **readback** / staging.
3. Result is drawn into a 2D bridge canvas → `THREE.CanvasTexture` → compositor.

That path is **correct** when contexts differ, but it is inherently **heavier** and explains placement/zoom stalls when capture runs hot.

### 2.2 Fast path (same context): texture handle injection

**`PixiContentLayerBridge._injectPixiRTToWorldTexture()`** (`scripts/foundry/pixi-content-layer-bridge.js`):

- Binds PIXI’s `baseTexture`, reads `_glTextures[CONTEXT_UID].texture`.
- Resolves Three’s renderer from `MapShine.sceneComposer` / `effectComposer` / `renderer`.
- **Hard gate:** `pixiRenderer.gl === threeRenderer.getContext()` — if false, returns `false` and the bridge falls back to extraction.
- Injects `properties.__webglTexture` on the world `CanvasTexture` wrapper (same pattern as fog).

**`FoundryFogBridge._pixiToThreeTexture()`** (`scripts/vision/FoundryFogBridge.js`) documents the same assumption: *“PIXI and Three.js share the same WebGL context.”*

### 2.3 Bootstrap wiring for shared context

**`scripts/core/bootstrap.js`**:

- If `window.MapShine.__usePixiSharedWebGLContext === true`, it passes `canvas.app.renderer.gl` (with fallbacks) into `rendererStrategy.create(..., { sharedContext })`.
- **`renderer-strategy.js`** then passes that `context` and `canvas` into `THREE.WebGLRenderer`, so Three attaches to Foundry’s GL context instead of creating a new canvas.

If the flag is **false** (default unless something sets it early), Three gets its **own** context → injection fails → CPU bridge path.

---

## 3. Can we “smoothly” share a context with Foundry + modules?

### 3.1 Technical feasibility: **yes**, with constraints

**Feasible:**

- Same-context **zero-copy** sampling of PIXI `RenderTexture` in Three (already coded).
- Avoiding `extract.canvas` on the hot path when injection applies.

**Hard constraints:**

1. **Bootstrap order:** Shared context requires Foundry’s `canvas.app.renderer` (and thus `gl`) to exist **before** `THREE.WebGLRenderer` is constructed. If Map Shine bootstraps too early, `requestedSharedContext` is null and you silently stay on dual-context mode.
2. **WebGL version alignment:** Three must be created against the **same** context type Foundry uses (WebGL1 vs WebGL2). Mismatch → renderer creation or features may fail; shared mode needs explicit testing on Electron + target Foundry versions.
3. **GL state isolation:** After PIXI renders the bridge pass, Three must render with known state or explicit reset. Foundry and PIXI already mutate state every frame; Three’s internal state cache can desync if assumptions break.
4. **Canvas ownership / presentation:** If both write to the **default** framebuffer of the same canvas, you need a single coherent “who paints the screen when” story. The current product likely composites Map Shine in a **separate** full-window Three canvas in non-shared mode — switching to Foundry’s canvas may change **DOM layering**, **input**, and **module expectations**.

### 3.2 Module compatibility: **mixed**

- **PIXI-only modules** (filters, display objects): Unaffected by whether Three shares GL; they only care that Foundry’s PIXI app still runs.
- **Modules that assume a dedicated WebGL canvas for Map Shine** or inject their own WebGL next to Foundry: Independent extra contexts remain possible; they still cannot share textures with PIXI without copies.
- **Modules that patch low-level renderer behavior** (PIXI batching, state, resize): Higher risk when a second heavy user (Three) shares the same `gl`.
- **Fragility of `_glTextures` / `properties.__webglTexture`:** Both PIXI and Three.js use **private** internals. Foundry or PIXI version bumps can rename or restructure these fields — the pattern is **pragmatic**, not API-stable.

---

## 4. Options compared

| Approach | GPU path | Compatibility / complexity |
|----------|----------|----------------------------|
| **A. Same GL context (current optional design)** | **Zero-copy** texture handle reuse | Best performance **when** shared bootstrap works and state ordering is correct. Highest integration risk; must validate Foundry v12 + Electron. |
| **B. Separate contexts + extract** (current default) | Readback / upload | Heavier, but **isolates** GL state and keeps Map Shine on its own canvas. Matches “two renderers” mental model. |
| **C. Stay on PIXI for compositing** (render Map Shine into PIXI via filters/custom mesh) | Same context **by construction** | Theoretically smooth, but **reimplements** the compositor in PIXI — opposite direction to “Three.js glory” and very large scope. |
| **D. DOM stack two canvases** | No GL sharing; GPU compositing by the browser | Simple layering, no texture sharing; different class of sync/alpha issues. |
| **E. Future WebGPU** | N/A for Foundry PIXI today | Not a near-term answer for V12 PIXI integration. |

---

## 5. Recommendations

1. **Treat “shared context” as “single context,” not “two contexts that share.”** Marketing-wise: *GPU-direct bridge* = same `gl` as Foundry, not magic cross-context sharing.

2. **Clarify the misleading comment** in `_injectPixiRTToWorldTexture` that suggests handles are “valid across contexts on the same page.” The **implemented** check (`pixiGl === threeGl`) is the spec-aligned rule; cross-context handle reuse would be **undefined** behavior.

3. **If the product goal is default GPU-direct bridge:**  
   - Set (or settings-gate) `__usePixiSharedWebGLContext` so bootstrap reliably receives PIXI’s `gl`.  
   - Add **telemetry or logging** for `MapShine.__pixiBridgeSharedContext` and `__pixiBridgeGpuDirectActive` in QA builds.  
   - Maintain **automatic fallback** to extract when shared context fails (already present).

4. **Invest engineering time in GL handoff**, not in impossible cross-context APIs: document the exact frame order (PIXI bridge RT render → Three compositor bind/inject → Three main pass) and add regression tests around resize, scene change, and template tool transitions.

5. **Do not depend on** any future browser extension for cross-context sharing unless standards ship — planning should assume **copy** or **same context** only.

---

## 6. Code anchors (for implementers)

| Area | Location |
|------|----------|
| Shared-context bootstrap flag | `scripts/core/bootstrap.js` (`__usePixiSharedWebGLContext`, `requestedSharedContext`) |
| Three renderer construction with foreign `context` | `scripts/core/renderer-strategy.js` (`tryWebGL2` / `tryWebGL1`) |
| GPU injection gate + handle copy | `scripts/foundry/pixi-content-layer-bridge.js` (`_injectPixiRTToWorldTexture`) |
| Same pattern for fog | `scripts/vision/FoundryFogBridge.js` (`_pixiToThreeTexture`) |
| Injection call site (UI capture path) | `scripts/foundry/pixi-content-layer-bridge.js` (~`canInjectGpuDirect && this._injectPixiRTToWorldTexture`) |

---

## 7. Conclusion

**Yes:** you can achieve **smooth GPU → GPU** use of PIXI’s output **without** readback, but **only** by using **one WebGL context** for both PIXI (Foundry) and Three.js — which this repo already supports in principle via bootstrap + injection.

**No:** you cannot rely on **two** contexts sharing GPU textures in the browser; the “non-kludge” alternative to CPU extraction is **not** a different sharing API — it is **unifying on a single context** (or accepting copies).

The remaining work is **product and engineering integration** (bootstrap timing, defaulting shared context, GL state lifecycle, and Foundry/module regression), not discovery of a hidden cross-context WebGL feature.
