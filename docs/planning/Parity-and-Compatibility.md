# PARITY & COMPATIBILITY — MSA as a good citizen of Foundry and its ecosystem

**Status:** STANDING DESIGN DOCTRINE, authored 2026-07-19. Not a status report — a **decision filter**. Its job is to catch a bad decision _before_ it ships, the same way `Skeleton.md` catches a bad structural move. When a change touches input, visibility, camera, game state, or another module's territory, it must survive this document.
**Audience:** a fresh session with zero context, and the author. Read `Keyhole.md` §4.3 + §4.7 and `v2-postmortem-the-failure-modes` (memory) first — this doc assumes them.
**Companions:** `Keyhole.md` (the plan), `Skeleton.md` (how a rule is made to hold), `docs/archive/ARCHITECTURE-SUMMARY-v2.md` §20 (the V2 external-effects bridge — the proven pattern this doc generalises), memory: `keyhole-interface-seam`, `keyhole-input-model-decision`, `feedback_safety_slide_outranks_doctrine`, `keyhole-vision-fog-direction`.

---

## 0. THE SIMPLE QUESTION

> **Does Map Shine Advanced approximate Foundry closely enough to cause the user minimal trouble — do they keep reasonable parity and access to features — and what UX bugs might MSA accidentally introduce that we have to design against? And, secondarily: are we cross-compatible with other modules wherever an easy compatibility is possible, while taking full and complete responsibility for rendering the scene ourselves?**

That is one sentence and it cannot be answered with an opinion. "Close enough" and "minimal trouble" are only meaningful as **a test you can fail**. So the question splits three ways, and each half gets teeth:

| Split                                                  | Becomes                                                                                                                                 | Lives in |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| "reasonable parity + feature access"                   | **The Parity Contract** — an enumerated list of what a user must still be able to do, and _why the architecture makes it hard to break_ | §2       |
| "UX bugs we might accidentally introduce"              | **The UX-Regression Catalog** — the specific ways MSA can hurt a session even when the game logic is untouched                          | §3       |
| "cross-compatible where easy, while owning the render" | **The Cross-Compatibility Doctrine** — own the picture completely; bridge the ecosystem cheaply; never trade the first for the second   | §4       |

And the two halves the author asked for explicitly:

- **The testing regime** (§5) — _how we check_, instrument by instrument, manual and automated.
- **The QA benchline** (§6) — _the pass/fail thresholds_. A release either clears the benchline or it doesn't ship as "parity."

§1 states the hard lines we will NOT trade to get there. §7 lists the walls we can actually build so these stay enforced, not merely hoped. §8 is the honesty section: what is proven today vs. aspirational.

---

## 1. THE HARD LINES — what we will not trade away

These are not up for negotiation to win a compatibility point or shave a millisecond. They are the reason the module exists.

1. **We push the envelope of what a 2D VTT can do** — in JS, in WebGPU/TSL, on a top-down plane. MSA is a cinematic renderer, not a skin. We accept that this is ambitious and that ambition has a cost.
2. **Tiered effects across a range of hardware.** Every effect declares a cost ladder (`Effects.md`, C0–C8); a weaker machine runs fewer/cheaper rungs, not a different codebase. Tiers follow **measured performance, never the backend** (`Keyhole.md` §9 Q3 — WebGPU availability tracks browser recency, not GPU power).
3. **We accept a real, honest downside** — load time and VRAM and frame cost are the price of the picture. We minimise the harm (the whole Keyhole cost model exists for this: nothing is ever allocated at world resolution), but we do **not** pretend it is free. An instrument that hides the cost is a lie (`feedback_instruments_must_not_lie`).
4. **The safety slide is sacred: WebGPU → WebGL2 → native Foundry PIXI.** A player whose hardware cannot sustain our best effort must **never** be the reason a session stalls or a browser crashes mid-game. The GM must **never** be forced to choose between removing the module and ending the session. Reliability outranks visuals — always, and by author directive (`feedback_safety_slide_outranks_doctrine`). The last rung (`diag/render-fallback.js#engageFoundryFallback`) is built and has fired live; the auto-detect ladder above it is deferred, not abandoned (`Keyhole.md` §4.3, menu item 12).
5. **We take full and complete responsibility for rendering the scene.** This is the _precondition_ for everything in §4, not a tension with it. Cross-compatibility is only possible **because** we own the picture — we can choose to draw someone else's content into it. We never half-own the render to accommodate a module; a module that demands we cede rendering authority is a module we degrade around, not for.

> The through-line: **§1.4 and §1.5 are the same coin.** We own the render _so completely_ that when we cannot, we hand the whole thing back to Foundry cleanly. Total ownership and total fallback are the same discipline.

---

## 2. THE PARITY CONTRACT

### 2.1 The one insight that organises everything

**Because Foundry owns all input, MSA cannot break interaction _logic_ — it can only fail to draw, mis-align, physically block, or (forbidden) mutate state.**

This is not aspiration; it is architecture (`Keyhole.md` §4.7, LOCKED):

- MSA's canvas is `pointer-events: none`. Every click, drag, drop, marquee, target, ping and context-menu reaches Foundry exactly as it would with the module absent.
- MSA has **no camera of its own** on a real scene — it mirrors `canvas.stage` per frame.
- Foundry's `interface` group (every interactive layer's chrome + hit-testing: tokens, tiles, walls, grid, controls, notes, drawings, templates, regions, sounds) **stays with PIXI, on top, untouched.** MSA takes only `primary` + `effects` — the _art_ (`keyhole-interface-seam`; `src/foundry/canvas-compositing.js`). The two renderers draw **disjoint sets**, so there is nothing to sync and no interaction path for MSA to sever.

The consequence is liberating: the parity contract is overwhelmingly a **visibility + alignment + non-interference** contract, not a re-implementation of Foundry's interaction surface. Every hour V2 spent re-implementing selection/drag/delete (`interaction-manager.js`, 8,955 lines) is an hour V3 does not spend, _and_ a whole class of parity bugs that cannot occur.

### 2.2 The contract, enumerated

For a scene with MSA enabled, the user must retain all of the following. "Guaranteed by" names the structural reason it holds; "risk" names the residual way it can still fail (→ §3).

| Capability                                                                   | Parity requirement                          | Guaranteed by                                                                                         | Residual risk                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Select / drag / marquee / delete placeables                                  | Identical to native                         | `pointer-events:none`; hit-testing is Foundry's                                                       | Opaque-canvas regression (§3.1); camera misalignment (§3.2)                  |
| Open sheets, right-click HUD, context menus                                  | Identical to native                         | Interface group stays PIXI                                                                            | Opaque-canvas regression                                                     |
| Targeting, ruler / measurement, pings                                        | Identical to native                         | Foundry input + interface chrome                                                                      | Camera misalignment                                                          |
| Drag-drop from sidebar (actors, tiles, pins)                                 | Creates the document; art appears           | Foundry handles the drop; MSA renders from the new document                                           | Drop lands but art missing until doc exists (§3.3)                           |
| All keybindings, scene controls, tool switching                              | Identical to native                         | Foundry owns the toolbar; `InputRouter` only _adds_ PIXI-edit routing, never removes Foundry's        | Unknown 3rd-party tool swallowed (§3.5)                                      |
| Placing / editing walls, lights, templates, drawings, notes, sounds, regions | Full native editing                         | Edit mode restores PIXI visibility; MSA draws from documents in play                                  | Floor-filtering hides an object the GM is editing (§3.6)                     |
| Every placeable is **visible and correctly ordered**                         | Matches Foundry's own sort law              | `src/scene/layer-order.js` — parity-fuzzed against Foundry's comparator (6000 keys, incl. ±Infinity)  | A new drawable type not entered into the law                                 |
| Camera (pan/zoom/rotate/recenter) matches the picture                        | Picture tracks `canvas.stage` exactly       | `CameraFollower`-equivalent mirror per frame                                                          | Mirror drift / lag (§3.2)                                                    |
| **Vision & fog of war are correct**                                          | A player never sees what Foundry would hide | **Fog/vision stay with Foundry (PIXI `visibility` group) by design** (`keyhole-vision-fog-direction`) | Regressing this early → information leak (§3.7) — the highest-severity class |
| Scenes **without** MSA enabled                                               | Pixel-identical to stock Foundry            | Scene opt-in (`flags['map-shine-advanced'].enabled`); MSA never touches a non-opted scene             | A global patch that leaks past the opt-in (§3.8)                             |
| No change to game data                                                       | MSA never writes a document                 | Documents-only _reads_; MSA is a renderer, not a simulation participant                               | An effect that writes a flag/param it shouldn't (§3.9)                       |

### 2.3 The parity floor vs. the parity ceiling

- **Floor (non-negotiable):** everything in §2.2 works, or the scene falls to the safety slide. Below the floor there is no "degraded MSA" — there is Foundry.
- **Ceiling (the point of the module):** MSA renders the scene _better_ than PIXI — cinematic light, weather, water, materials. The ceiling is where the hard lines (§1) live. Parity is the floor we never sink below **while** reaching for the ceiling.

---

## 3. THE UX-REGRESSION CATALOG

Every entry is grounded in a **real V2 failure** or a **known V3 gap**, not a hypothetical. This is the list to hold a change against. Severity: 🔴 session-breaking / information-leaking · 🟠 visibly wrong · 🟡 cosmetic.

| #    | Regression                                       | What the user experiences                                                                    | Root cause / provenance                                                                                                                                                                             | The guard                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | 🔴 **Opaque canvas over Foundry**                | Clicks do nothing; scene looks frozen; drops never create tokens                             | V2/early-V3: MSA canvas `background:#000`, `zIndex:5`, `pointer-events:auto` sat over `#board` and swallowed everything (`Keyhole.md` §4.7 origin story; `feedback_safety_slide_outranks_doctrine`) | Transparent seam decided from **measured** facts, **defaults to refuse** suppression, announces every refusal (`canvas-compositing.js`); the two PIXI-7.4.3 alpha traps are source-verified (`keyhole-interface-seam`)                                                                                                                                         |
| 3.2  | 🔴 **Camera mirror drift**                       | The picture and the click-targets disagree — you click a token and hit empty floor           | Mirror lags or mis-converts `canvas.stage` pivot/zoom; Y-flip is this project's recurring bug class (`feedback_y_flip_recurring_risk`)                                                              | Camera carries the entire flip (`world-quad.js`, `top=minY`), asserted link-by-link in Node; mirror runs per-frame in the render loop                                                                                                                                                                                                                          |
| 3.3  | 🟠 **Drag-preview / preview-token art missing**  | You drag an outline with no picture; a spell template preview may look bare                  | MSA renders from **documents**; a preview is not a document — it lives at `canvas.tokens.preview.children` (`keyhole-interface-seam`, recorded gap)                                                 | Known + bounded; wire preview rendering as its own slice; until then, documented so it is not mistaken for a bug                                                                                                                                                                                                                                               |
| 3.4  | 🔴 **Loading curtain lies "Ready"**              | GM starts play; the viewed floor's art is still a blank/encoding                             | V3 whole-image BC7 encode ran fire-and-forget; nothing awaited the opening floor (`Keyhole.md` compression section; the "0%/98% two-gate Ready lie" class)                                          | Startup **awaits** the viewed floor's compression with honest progress; ±1 floors prewarm in background (`load-progress.js`, `vt-pan-viewer.js`)                                                                                                                                                                                                               |
| 3.5  | 🟠 **3rd-party tool swallowed**                  | A tool from another module (e.g. Monk's Active Tile Triggers) does nothing on the MSA canvas | `InputRouter` knows a fixed set of PIXI tools; an unknown tool defaults to THREE mode                                                                                                               | Public `addPixiTool()` / `addPixiLayer()` exist and default-to-THREE is correct — but this **must be a documented API** (§4.4), or every such module is a silent conflict                                                                                                                                                                                      |
| 3.6  | 🟠 **Floor-filter hides what the GM is editing** | GM selects a wall/light on another floor and it's invisible                                  | Multi-floor visibility filtering by elevation band                                                                                                                                                  | Edit mode restores full PIXI visibility; filtering is a _play-mode_ concern; verify on every floor-navigation change                                                                                                                                                                                                                                           |
| 3.7  | 🔴 **Fog / vision information leak**             | A player sees a token, trap, or room Foundry would have hidden                               | If MSA ever renders vision/fog itself and gets an edge or elevation wrong                                                                                                                           | **Do not render it yet.** Fog/vision stay Foundry's until deliberately taken, and then reproduce Foundry's _logic_ (consume `.los` polygons, do not recompute) with Three's _strengths_ (smooth fog) (`keyhole-vision-fog-direction`, `Forward+.md` §11). This is the one regression that is a **gameplay** bug, not a visual one — it gets the strictest gate |
| 3.8  | 🔴 **Opt-in leak**                               | A scene with MSA _off_ renders wrong, or stock Foundry behaviour changes globally            | A monkey-patch or global hook that fires regardless of the per-scene flag; V2 had 98 unguarded `.prototype` patches                                                                                 | Patches live only in `foundry/`, in a version-gated patch registry (`Skeleton.md` §2.3); every render path checks the scene opt-in; non-MSA scene is a benchline test (§6)                                                                                                                                                                                     |
| 3.9  | 🔴 **MSA writes game state**                     | A "render" changes a document; two clients disagree; an undo eats a change                   | V2 precedent: `HealthEvaluatorService` (diagnostics) mutated product params; darkness round-tripped through the scene document as a feedback bus (`v2-postmortem` §3C.3, §3C.8)                     | MSA reads documents, never writes them; darkness/env is read-one-direction (`Environment.md`); params flow through one owner (`params-schema.js`)                                                                                                                                                                                                              |
| 3.10 | 🟠 **Perf so poor the session is unusable**      | Stutter, multi-second freezes, eventual device loss                                          | The V2 cost model (`O(world×floors×masks)`); the measured 2.5 GB WebGPU device-loss wall                                                                                                            | The Keyhole cost law (fixed page budget); the VRAM tripwire (`Keyhole.md` menu item 8); and below the floor, the safety slide (§1.4)                                                                                                                                                                                                                           |
| 3.11 | 🟡 **Cosmetic desync at the seam**               | A native PIXI overlay and MSA's art disagree at a Z-boundary for a frame                     | Two renderers, one boundary; timing                                                                                                                                                                 | Draw disjoint sets (no shared picture → no sync code); if you find yourself writing sync code, you have re-grown `frame-coordinator.js` — stop (`keyhole-interface-seam`)                                                                                                                                                                                      |

**The catalog's own law:** a regression that is **silent** is worse than one that crashes (`v2-postmortem` §3.8). Every guard above must fail _loud_ — a refusal with a code, a `renderMode` in diagnostics, a red test — never a quiet no-op that manufactures the impression things work.

---

## 4. THE CROSS-COMPATIBILITY DOCTRINE

### 4.1 The principle, stated once

> **Own the picture completely. Bridge the ecosystem where the bridge is cheap and the module is worth it. Never trade rendering authority for a compatibility point.**

We took full responsibility for the scene (§1.5). That means a module which draws _into_ the scene is, by default, **invisible or inconsistent** under MSA — because we suppressed the PIXI groups it was drawing to, or because it draws its own canvas that never receives our lighting/grade. Cross-compatibility is the deliberate, opt-in act of **drawing that module's content into our frame** (or letting it sit cleanly on top). It is a gift we choose to give, from a position of total ownership — never a compromise of it.

### 4.2 The module taxonomy — how MSA treats each class

The seam (`primary`+`effects` = MSA; `interface`+`visibility` = PIXI) sorts every module into one of four classes. **Know a module's class before deciding anything.**

| Class                                                | What it does                                                                                                                                     | Default behaviour under MSA                                                    | MSA's job                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Logic / UI / sheets / automation**             | Touches documents, chat, sidebar, HUD, combat — not the scene art. The large majority (game systems, most automation, dice-roll logic, journals) | **Works for free.** It never drew to `primary`/`effects`; MSA never touched it | Nothing. Do not "integrate" what already works                                                                                                       |
| **B — Interface-group canvas drawing**               | Draws controls, highlights, custom HUD _chrome_ into the `interface` group                                                                       | **Works for free** (interface stays PIXI, on top)                              | Nothing — unless it also adds a **tool** (→ §3.5, document the router API)                                                                           |
| **C — Scene-art drawing (into `primary`/`effects`)** | Puts sprites/animations _in the scene_: **Sequencer/JB2A** spell & effect video, some weather/token-magic modules                                | **Invisible** (its group is suppressed)                                        | **Bridge required** — mirror its content into our frame (§4.3, channel 1) if the module is worth it; otherwise it degrades to invisible-but-harmless |
| **D — Own-canvas / own-context overlay**             | Renders its own canvas or WebGL context over Foundry: **Dice So Nice**                                                                           | **Visible but inconsistent** — sits on top, ungraded, unlit, no fog/lens       | **Bridge optional** — mirror it into our frame for consistency (§4.3, channel 2); without the bridge it still _works_, just doesn't match            |

**The graceful-degradation guarantee falls out of the taxonomy:** class A/B need nothing; class D is visible without us; only class C goes _invisible_ unbridged — and an invisible spell animation is a missing nicety, never a broken session. **No module in any class can take the session down through MSA.** If one could, that is the bug.

### 4.3 The two proven channels (reference patterns from V2 §20)

V2 shipped both; V3 will rebuild both at Stage 6. They are the templates for any future bridge.

- **Channel 1 — Sprite mirror (class C: Sequencer / JB2A).** For each `CanvasEffect` the module creates, set its PIXI container `renderable = false` and spawn a mesh in our scene wrapping the **same** media (zero-copy: `VideoTexture` over the `<video>` Sequencer already plays; spritesheet frame-rect for animated sprites). Sync transform once per Foundry ticker tick, not per RAF. Order it via the one sort law so it stacks correctly among our drawables. Result: the spell video receives our lighting, bloom, and grade like it belongs in the scene. `screenSpace`/`screenSpaceAboveUI` paths are intentionally **left alone** — they are meant to sit above everything.
- **Channel 2 — Texture mirror (class D: Dice So Nice).** DSN ships its own Three.js in its own WebGL context — no shared GPU resources. Wrap its canvas in a `CanvasTexture`, mark it dirty once per DSN frame, hide its canvas, composite the texture into our frame _after_ grade/fog/lens so the dice read the scene's mood. On disable, un-hide its canvas and revert — DSN returns to stock behaviour, fully.

**Both channels obey the same three rules**, and any new bridge must too:

1. **Zero-copy where the media already exists** (a `<video>`, an `HTMLImageElement`, a canvas). Never re-decode. Never `readback` (`v2-postmortem` §3B.4 — the GPU is a write-only pipe).
2. **Reversible to the byte.** Disabling the bridge restores the module's stock rendering completely — monkey-patches reverted, `renderable`/`display` restored. A bridge you cannot cleanly remove is a bridge you cannot ship.
3. **A Graphics-Settings toggle, gated on the module being active.** The user can turn any bridge off; the toggle only appears when the module is present.

### 4.4 The public API surface MSA must expose — and DOCUMENT

V2's compatibility hooks existed but were **undocumented**, so every third-party module was a silent guess. The surface below is small; the requirement is that it is **written down for other module authors**, because an undocumented extension point is one nobody extends (`archive/ARCHITECTURE-SUMMARY-v2.md` §19.4B — "needs documentation").

| Surface                                                           | Purpose                                                                      | Status                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `addPixiTool(name)` / `addPixiLayer(name)`                        | A module with a custom scene tool tells the router to route to PIXI for it   | Pattern proven in V2; V3 must re-expose + **document**   |
| Mirror registration (register a class-C container to be mirrored) | Let a module opt its scene-art into our frame without us hardcoding its name | Design target; generalise the Sequencer adapter          |
| `renderMode` query (`'msa'` \| `'foundry-fallback'`)              | Let a module know whether MSA is actually rendering, from DOM ground truth   | **Built** (`diag/render-fallback.js#describeRenderMode`) |
| A `map-shine-advanced.enabled` scene-flag read                    | Let a module know if MSA is active on _this_ scene                           | Built (the opt-in flag)                                  |

**The rule for the surface:** it is a stable, documented, versioned contract or it does not exist. `MapShine.debug` is a shop window, never a hallway (`Skeleton.md` §2.3) — a real integration API is a separate, deliberate export.

### 4.5 Milestones (author-named), and the "when in doubt" rule

| Milestone                                          | Class | Priority              | Note                                                                                                     |
| -------------------------------------------------- | ----- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| **Dice So Nice**                                   | D     | **Critical** (author) | The proven texture-mirror; degrades to visible-on-top if bridge off                                      |
| **Sequencer / JB2A**                               | C     | High (author)         | Spell & effect video _in_ the scene; the sprite-mirror. The headline "it feels like part of the map" win |
| Automated Animations, etc. (Sequencer-backed)      | C     | Follows Sequencer     | If it renders _through_ Sequencer, the Sequencer bridge covers it for free — verify, don't rebuild       |
| Weather/token-magic modules that draw to the scene | C     | Case-by-case          | Bridge only if worth it; otherwise invisible-but-safe is an acceptable outcome                           |

> **When in doubt, the ranking is fixed:** _rendering authority (§1.5) > the safety floor (§2.3) > an easy compatibility > a hard compatibility._ A compatibility that would force us to cede any of the render, or that risks the parity floor, is not "hard" — it is **refused**, and the module degrades gracefully instead. We would rather a spell animation be invisible than the scene be wrong.

---

## 5. THE TESTING REGIME

How we actually check §2–§4. Split by what a machine can hold vs. what needs a human at a browser (this project cannot run Foundry headless — live verification is always a person).

### 5.1 The parity interaction matrix (manual, per release)

A fixed checklist run on the acceptance scene set (Church, Mansion, the 12k torture fixture, one non-square multi-floor scene). For each: select · drag · marquee · double-click sheet · right-click HUD · target · ruler · ping · drag-drop from sidebar · switch every scene-control tool · place+edit a wall/light/template/note/region · navigate every floor · confirm every placeable visible and correctly ordered. **Pass = indistinguishable from stock Foundry.** This is the direct test of §2.2.

### 5.2 The instruments (already built — reach for these first)

| Instrument                                             | Answers                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pixel Probe** (`MapShine.probePixels`)               | "Is this pixel what Foundry would show?" — click-to-set, 5 buffers, auto-diff. The flagship parity instrument (`keyhole-pixel-probe-tool`) |
| **Flight Recorder** (`diag/flight-recorder.js`)        | The full load story + per-frame timing + every hitch; `renderMode` from DOM ground truth                                                   |
| **Stage-Gate Baseline** (`stage-gate-baseline` report) | PIXI residency, load time, frame-gap p50/p95/p99 vs. the gates — one click, per scene = the validation matrix row                          |
| **Diagnostics report**                                 | `framePlan`, `envSnapshot`, `occlusion`, mask-authority provenance                                                                         |

### 5.3 The non-MSA-scene test (the opt-in guarantee, §3.8)

Load a scene with MSA disabled. It must be **pixel-identical to stock Foundry** and behave identically. This is the cheapest, highest-value parity test and it should be a standing tripwire candidate (§7).

### 5.4 The module-compatibility matrix

For each supported/tested module, record a **verdict**, not a vibe:

| Verdict                 | Meaning                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| **Works**               | Class A/B — no MSA code, confirmed unaffected                                                             |
| **Bridged**             | Class C/D — mirrored into our frame, toggle present, reversible confirmed                                 |
| **Degrades safely**     | Class C unbridged — invisible-but-harmless, confirmed no session impact                                   |
| **Documented conflict** | Fights for rendering authority — the conflict + the workaround are written down; we do not silently break |

A module with **no** verdict is untested, and "untested" is a distinct fact from "works" (`v2-postmortem` §3.8 — `skipped:[]` must mean _nothing was skipped_, never _I didn't look_).

### 5.5 The tier / safety-slide drill

Force each rung and confirm the outcome: (a) WebGPU healthy → MSA renders; (b) renderer failure → `engageFoundryFallback` removes the canvas, announces unmissably, `renderMode:'foundry-fallback'`, session fully playable on PIXI; (c) `useNativeFoundryRendering` off-switch → same clean Foundry hand-back. **The drill passes only if a _loud, non-interfering_ announcement fires every time** (`feedback_safety_slide_outranks_doctrine`).

---

## 6. THE QA BENCHLINE

The pass/fail line. A release is "parity-grade" only when every row is green. `null` (not measured) is never counted as green — it is an unrun test (`Keyhole.md` menu item 5).

| #   | Dimension                 | Threshold (PASS)                                                                                | Measured by                                             | Severity if failed               |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| B1  | Interaction parity        | §5.1 matrix 100% on all acceptance scenes                                                       | Manual matrix                                           | 🔴 blocks release                |
| B2  | Non-MSA scene untouched   | Pixel-identical + behaviour-identical to stock Foundry                                          | §5.3 + pixel probe                                      | 🔴 blocks release                |
| B3  | Vision / fog correctness  | **Zero** information leaks; MSA shows nothing Foundry would hide                                | Manual, adversarial (move a hidden token behind a wall) | 🔴 blocks release                |
| B4  | Safety slide              | Fires on forced failure; canvas removed; announced; session playable                            | §5.5 drill                                              | 🔴 blocks release                |
| B5  | No state mutation         | MSA writes zero documents during a session                                                      | Flight recorder / code audit (tripwire §7)              | 🔴 blocks release                |
| B6  | Camera alignment          | Click-target and drawn position agree within 1px at all zoom levels                             | Pixel probe + a marker token                            | 🟠 blocks "parity" label         |
| B7  | Load honesty              | Curtain drops only after the viewed floor's art is real; progress never lies                    | `load-progress` receipt                                 | 🟠                               |
| B8  | Bridged modules           | DSN + Sequencer: **Bridged** verdict, toggle present, reversible confirmed                      | §5.4 matrix                                             | 🟠 (feature, not floor)          |
| B9  | Unbridged class-C modules | **Degrades safely** — invisible, zero session impact                                            | §5.4 matrix                                             | 🟠                               |
| B10 | Perf floor                | Load ≤10 s, PIXI residency ≤60 MB, no device loss on the acceptance set (`Keyhole.md` §8 gates) | Stage-gate baseline                                     | 🟠 (below it → safety slide, B4) |

**Reading the benchline:** B1–B5 are the **parity floor** — miss one and the release is not parity, full stop. B6–B10 are the **quality band** — miss one and you ship without the "parity-grade" label and a named debt entry (`feedback_now_pressure_protocol`), never a quiet pass.

---

## 7. WALLS WE CAN BUILD — making this enforced, not hoped

`Skeleton.md`'s law applies here too: **a comment cannot fail a build.** Parity and compatibility must live at L0–L2 (absence / throw / machine check) wherever they can, not as prose someone remembers. Candidate walls, in the project's `tools/verify-structure.mjs` + test spirit — flagged built vs. proposed:

| Wall                                                                                                              | Defends                         | Rung     | Status                                             |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------- | -------------------------------------------------- |
| `renderMode` reported from DOM ground truth in every diagnostics export                                           | §3.1, safety slide never silent | L1       | **Built** (`render-fallback.js`)                   |
| Suppression **defaults to refuse**, property-fuzzed                                                               | §3.1 opaque-canvas catastrophe  | L2       | **Built** (`canvas-compositing.js`; 40-combo fuzz) |
| Layer law parity-fuzzed against Foundry's comparator                                                              | §2.2 ordering                   | L2       | **Built** (`layer-order.js`, 6000 keys)            |
| MSA writes no Foundry document (no `.update(`/`.create(` on a Document outside a sanctioned path)                 | B5 / §3.9                       | L2       | **Proposed** tripwire                              |
| Non-MSA-scene-untouched assertion in the suite                                                                    | B2 / §3.8                       | L2       | **Proposed** (opt-in must gate every render entry) |
| A drawable type absent from `layer-order.js` fails, not silently sorts to 0                                       | §2.2 new-drawable gap           | L1/L2    | **Proposed**                                       |
| The integration API (`addPixiTool`, mirror registration) is a documented, versioned export — not `MapShine.debug` | §3.5, §4.4                      | L4-on-L1 | **Proposed** (write it when Stage 6 bridges land)  |
| Every bridge adapter proves clean revert in a test (patch reverted, `renderable`/`display` restored)              | §4.3 rule 2                     | L2/L3    | **Proposed** (Stage 6)                             |

**When a parity/compat bug is fixed, add its wall** (`Skeleton.md` covenant #4). This document grows the same way the postmortem does: each scar becomes a rail.

---

## 8. STATUS HONESTY — proven vs. aspirational (2026-07-19)

This doc is **doctrine**, and doctrine describes the target. What is actually true today:

- ✅ **Basic Foundry↔three.js parity is reached and author-confirmed** (`keyhole-stage-status`, 2026-07-19). Tokens/tiles/floors render, placed and hit-tested correctly; selection works like native.
- ✅ **The input model (§4.7) and interface seam are LIVE.** `pointer-events:none`, disjoint groups, transparent canvas — "working exactly like native Foundry" (author, `206320a`).
- ✅ **The safety slide's last rung is built and has fired unprompted** (`engageFoundryFallback`).
- 🔶 **Fog/vision are deliberately still Foundry's.** This is the _correct_ parity-safe default (§3.7), not a gap to rush — taking them early is the one move that risks an information leak.
- ⬜ **Cross-compatibility bridges (DSN, Sequencer/JB2A) are V2-proven but V3-UNBUILT.** They are Stage 6 work. §4 is the doctrine for _when we build them_, not a claim that they run today.
- ⬜ **The auto-detect tier ladder (WebGPU→WebGL2) above the last fallback rung is deferred** (`Keyhole.md` §4.3).
- ⬜ **Most §7 walls are proposed, not built.** The parity floor is currently held by a mix of built walls (§3.1, §2.2) and manual testing; hardening it is ongoing.

> **Do not read this document as "MSA is compatible." Read it as "here is what compatible means, here is how we stay it, and here is exactly how far along we are."** The moment a claim here drifts from the code, the claim is wrong — fix the doc or fix the code, never let them disagree (`feedback_plausible_diagnosis_rots`).

---

_We own the picture so completely that we can afford to be generous with it — and to hand the whole thing back the instant we can't. Parity is the floor we never sink below; compatibility is the gift we give from above it; neither ever costs us the render._
