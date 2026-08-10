# Moonshot (V4) — The Menu

**Status: DECIDED 2026-08-10 — the author picked the staged 1 → 2 path. This file is now the
analysis record of the options considered; the PLAN OF RECORD is `docs/holy/V4-Testament.md`
(governed by the Covenant). Do not work from this file's checklists.**
Companion: `Moonshot.md` (the evidence file — every "measured" number here lives there with its
source). Assembled 2026-08-10.

**The goal, in the author's own framing (2026-08-10):** V4 = the module brought in line with
V2's feature list, plus performance on the Mansion map's upper floor made much more acceptable
— as soon as possible, because releasing maps is how the business makes money. Working targets:
**acceptable = sustained 40+ fps; good = a locked 60 fps (16.7 ms)** at 3840×1906 on the
reference RTX 3070 Laptop, worst frame ≤ 50 ms.

**Standing context, stated so this document can't be misread:** V3 is not a failure. It is
being tested against the hardest case that will ever exist for it — a 12,000×12,000 two-floor
map, at 4K, with effects running across both floors — and in one session of tuning it went
4.9 → 18.1 avgFps (+269%) with the world draw down 80%. An architecture that responds to
tuning like that is a healthy one. The question this menu answers is not "how do we escape
V3?" — it is "which path gets V3's foundation to V2's feature list at acceptable speed
fastest, and how high is each path's ceiling?"

---

## 0. Week zero — done first under EVERY option (all cheap, all option-agnostic)

Two ground-truth packages. Neither changes a pixel; both change every decision after them.

### 0a. Name the mysteries (perf ground truth)

- [ ] **Pass census:** one Chrome `about:tracing` capture (Dawn categories) over the bench
      route. Count `beginRenderPass` per frame, record load/store ops. Confirm the world draw
      really is one pass. If it isn't, that alone may explain several ms.
- [ ] **The 7.7 ms CPU mystery:** DevTools flame over the route, then the migration
      experiment — insert a dummy 1-triangle `render()` before the depth pass. If the cost
      follows "first render of the frame," it's deferred upload/init flush; if it stays with
      the depth pass, it's that pass specifically. This answer matters to EVERY option —
      **if the cost lives inside three.js's generic path, a from-zero rewrite on three
      inherits it, and if it lives in Dawn/Chrome, even raw WebGPU inherits it.**
- [ ] **Hitch autopsy (the 783 ms class):** `PerformanceObserver` longtask attribution armed
      during the route, correlated with the same frame's upload/IDB/residency activity.
- [ ] **A/B: blending force-off on fully-opaque layers** — measures the rgba16f MRT
      read-modify-write tax.
- [ ] **A/B: `maskNode` discard force-off** (debug flag, wrong pixels, measurement only, in
      the live pipeline — never a second context) — measures what discard-based composition
      costs vs. saves.
- [ ] **Live-test the already-built CAS tier** (evidence §6 item 6): flip
      `performanceProfile` to `performance` once and capture. Zero code; it's sitting there
      unmeasured.
- [ ] **Probe RenderBundle** on our three 0.185.1 (24 references confirmed present in the
      build) with our actual material set.
- [ ] **Record the reference machine's CPU model** into `Moonshot.md` §1 — the one hardware
      fact still missing, now load-bearing since half the mysteries are CPU-side.

### 0b. The V2 → V4 parity ledger (feature ground truth)

- [ ] Enumerate V2's actual shipped effect list from `legacy/` (the autopsy counted 46 wired
      effects — get the real names).
- [ ] Mark each: V3 status today (LIVE / BUILT-unverified / designed / absent), from the
      author's live-verdict ledger, not from "BUILT" claims.
- [ ] The gap list, ordered by map-selling value **by the author**, becomes the V4 feature
      backlog. Every option below consumes this same backlog — only the hosting differs.

---

## 1. The shared diagnosis — why the frame is slow (and why it isn't the card, the map, or three.js's shaders)

What the silicon affords per 16.7 ms frame at 3840×1906 (7.32 MP), worst-case 100 W clocks:

| Resource | Per-frame budget | Buys |
| --- | --- | --- |
| ALU 13.2 TFLOPS | ≈ 220 GFLOP | ~30 full-screen passes at 1,000 flops/px |
| Bandwidth 384 GB/s (~60% achievable) | ≈ 3.8 GB | ~65 full-screen rgba16f writes |
| VRAM | 2,500 MB self-imposed wall | current use 1,215 MB — half the wall free |

60 fps needs the frame to spend ~8 full-screen-equivalents. The measured 47 ms frame spends
~85. That gap is **frame anatomy**, four taxes, all measured or directly observable:

1. **Pixels shaded many times.** The world rasterizes twice (depth pass + colour pass), layers
   overlap, and colour-pass occlusion is a texture-lookup + `discard` (`maskNode`) — which
   still launches the shader for occluded fragments and disables hardware early-Z.
   `geometry.worldDraw`: 26.6 ms, 56.5% of the frame.
2. **~15–20 `renderer.render()` calls/frame**, each paying traversal + node updates + pass
   begin/end. 55 lights are 110 draws. One call hides the unexplained 7.7 ms CPU.
3. **No memory between frames.** During a pan, ~95% of what's on screen is static art under
   static light, recomputed every frame.
4. **Post is serial full-screen passes** (bloom composite → DoF composite → grade/present,
   plus a 2×/frame blit), each paying full render-target bandwidth.

**The one-sentence conclusion that shapes the whole menu: the GPU-side problem is
algorithmic, not API overhead — so it is fixable in three.js + TSL, and switching APIs
wouldn't fix it by itself.**

### The destination frame (every option converges here; only the road differs)

| # | Pass | GPU target |
| --- | --- | --- |
| 1 | sims (wind/fluid/particles/fire compute) | 0.5 ms |
| 2 | visibility — the depth authority, unchanged in role: THE one rasterization of the world | 2–3 ms |
| 3 | opaque resolve — colour with `depthFunc: EQUAL`, no discard: each pixel shades ONCE | 3–4 ms |
| 4 | edge blend — boundary/semi-transparent cells only, blended as today (a sliver of screen) | 0.5 ms |
| 5 | lights — one MAX draw + one ADD draw (order-independent blends make batching pixel-exact) | 2–3 ms |
| 6 | animated effects (specular, fire, candle, lightning, water anim) | 1.5 ms |
| 7 | post — shared bloom/DoF pyramid, ONE composite shader | 2 ms |
|   | **Total ≈ 12 ms worst, 8–10 typical** — before the bake/cache pillar, which later removes most of 2–5 from steady-state frames | |

Enabling facts already true in V3: the depth authority already writes rank as real hardware Z
(`depth32float`, samplable); depth proxies already **share the item's own geometry**
(`scene-depth.js:478-488`) so an EQUAL-depth colour pass matches by construction; coverage
meshing already classifies cells from real alpha (needs an interior/boundary split added);
`alphaStats` already proves which items are fully opaque.

---

## 2. THE MENU

### Option 1 — Tune V3 in place *("the practical one")*

**What it is.** Keep V3's frame structure and host (`vt-pan-viewer.js`) exactly where it is,
and perform the anatomy surgery inside it, one gated commit at a time. No new architecture,
no new module, no parallel path. Effects keep landing in parallel the whole time; the module
stays shippable at every commit.

**What's involved, concretely, in order:**
1. **Early-Z composition** — the big one. Coverage meshing gains an interior/boundary index
   split (per-cell min alpha from the existing coarse grid). The colour pass binds
   `buf:scene.depth` as its real depth attachment. Interior geometry draws with
   `depthFunc: EQUAL`, discard-free, blending off — hardware early-Z then skips every
   occluded fragment before the shader launches. Boundary cells draw exactly as today
   (back-to-front, blended). The `maskNode` lookup is deleted behind a revert flag.
   Target: `worldDraw` 26.6 → 4–8 ms.
2. **Light batching** — all point-light polygons into one storage-buffer draw per target
   (MAX illum, ADD coloration — both order-independent, so pixel-exact), window light folded,
   CPU reconcile dirty-flagged. Target: light stack 8.6 → 3–4 ms, `pointLightUpdate` < 1 ms.
3. **Post merge** — bloom and DoF share one downsample pyramid; bloom-composite +
   DoF-composite + grade + present become ONE shader with uniform toggles; the duplicate
   `present.blit` is explained and, if redundant, killed. Target: ~4 → ~2 ms, −~100 MB VRAM.
4. **CPU diet** — render() census in the profiler, static render lists, `matrixAutoUpdate`
   off, RenderBundles if the week-zero probe passed, plus whatever week zero named as the
   7.7 ms cause. Target: render-loop CPU ≤ 8 ms.
5. **Tail latency** — per-frame GPU upload byte budget, render targets preallocated across
   floor switches, zero-alloc steady-state audit. Target: worst frame ≤ 50 ms.

**What it buys.** The fastest route to "mansion upper floor acceptable": the first and
biggest lever (early-Z) needs no extraction work because it operates where residency already
lives. Predicted end state ~45–60 fps average. Feature parity proceeds at full speed
throughout, because nothing is being re-hosted.

**What it costs / risks.** Every step is surgery inside a 10.7k-line closure — the extraction
memory's seven traps (TDZ, live-mutable locals, shared uniforms) all apply, which is exactly
why each step carries a revert flag and a pixel-diff gate. And the ceiling has a soft spot:
the **bake/cache pillar** (the thing that eventually makes static effects free) is the one
pillar that's genuinely painful to retrofit into the god object — reachable, but it's the
point where Option 1 starts paying Option 2's price without getting Option 2's goods.
The architecture debt (closure-bag effect wiring, the V2-autopsy disease vector) remains.

**Time-shape (estimate, not a promise):** days per step; first big fps win within the first
week of sessions; full sequence a few weeks, interleaved with feature work.

---

### Option 2 — The New Keel: rebuild the frame core inside V3 *("the rebuild that pays for itself")*

**What it is.** The observation that "each time I rebuild it gets better" is true — and V3's
own components prove it *selectively*: the parts rebuilt recently (BC/residency pipeline,
coverage meshing, the depth authority) are exactly the excellent parts, and the part still
shaped like V2 thinking is the frame loop — the pass sequence, closure-hosted render targets,
and effect wiring inside `vt-pan-viewer.js`. Option 2 gives **that one part** its overdue
rebuild, from zero, as clean modules in the same repo — while everything proven (asset
pipeline, mask authority, depth authority, every effect's TSL shader logic, the instruments,
the Foundry seam) is consumed as-is through explicit contracts. Notably: `FrameGraph`, the
real dependency-solving render-graph class that has sat complete and tested with **zero
callers**, finally gets its caller — the keel IS the "something real" its own comment was
waiting for.

**What's involved, concretely, in order:**
1. **Carve the residency seam** — whole-image loading out of the god object (~900 lines, the
   one extraction step already known to be gnarly: device-loss hardening, the serialized BC
   chain). This is the keel's prerequisite AND the standing extraction plan's remaining step —
   the work is owed under every future, so it's close to no-regret.
2. **Keel skeleton:** FrameGraph-driven frame with explicit resources; subsystem contract =
   the extraction memory's shape (`createXSubsystem({deps})`, getters for live state,
   caller-supplied render callbacks) — the seven traps become API rules instead of hazards.
3. **Base world on the keel:** visibility pass (depth authority as-is) → opaque EQUAL resolve
   → boundary blend → present. Born with the right anatomy — no maskNode path ever exists
   here. Side-by-side with the live renderer behind a three-way safety slide
   (Foundry / V3 / keel), pixel-diffed on the bench route.
4. **World members migrate:** tiles/levels art, tokens, doors, vegetation, water surface —
   each a small port with a diff gate.
5. **Lights born batched** (never port the 110-draw shape), **post born unified** (one
   composite shader from day one).
6. **Effect ports, one at a time, ordered by the parity ledger's revenue ranking.** The TSL
   graphs carry over nearly verbatim — a port is re-hosting inputs/outputs (masks via the
   mask authority, uniforms via the keel's update contract), not re-deriving looks. Each port
   ends with one author LIVE verdict, same as today's per-effect cadence.
7. **The bake/cache pillar lands on the keel** once it's stable — the keel's resolve treats
   "static stack" as a first-class concept from day 3, so the cache is a feature, not a
   retrofit. This is the pillar that takes "60 locked" to "60 locked with ~40% headroom for
   MORE effects than V2."
8. **Sunset:** the old frame path inside `vt-pan-viewer.js` is deleted — the extraction plan
   completes by evacuation instead of surgery, and the size ratchet drops by thousands.

**What it buys.** Everything Option 1 buys (same anatomy, same targets), plus: the cache
pillar lands cleanly (the biggest end-state number), every future effect gets a contract
instead of a closure-bag reach (the V2-autopsy fix in its strongest form — the wrong move
becomes *unavailable*, not discouraged), and the god object dissolves as a side effect.

**What it costs / risks.** Two renderers coexist during the transition — drift risk,
double-think risk. Mitigations: the pixel-diff harness runs both on every bench capture, the
old path is frozen (bug fixes only) once the keel renders the base world, and the sunset is a
scheduled phase, not "eventually." Keel scope creep is the other classic failure — hard rule:
the keel renders the base world only until cutover; no new features land keel-side before
parity of what it replaced. First fps win arrives later than Option 1 (the seam-carving comes
first).

**Time-shape (estimate):** ~2–3 weeks of sessions to the base-world cutover (the 34.5 ms
world-draw elephant dies at that moment); effect ports thereafter at roughly the cadence
effects already land today; cache after parity.

---

### Option 3 — V4 from zero on three.js + TSL *("the clean sheet")*

**What it is.** A new module skeleton; every subsystem ported or rebuilt in dependency order:
asset pipeline → mask authority → depth authority → keel-equivalent frame core → effects, plus
rebuilt boot/module surface, settings, and UI wiring. What V3 did to V2, done to V3.

**What it genuinely buys over Option 2 — real, but subsystem-local:** unify the two texture
systems (the page-cache/VT stack for masks and the whole-image BC path for albedo are two
parallel machines with real duplicated concepts); redesign `boot.js` (4.3k lines, the same
disease as the viewer, already needing its own plan); effect registration born as data with
completeness checks (the `EFFECT_REAPPLIERS` class — six strikes — designed out at birth);
delete all seam/future scaffolding rather than migrating it.

**What it costs.** The decisive number is not lines of code — it's **verification rounds.
The author is the only verifier, and the LIVE ledger prices what verdicts cost: specular took
17 rounds to its first live confirmation; elevation occlusion took 15 across two sessions;
fluid took multiple rounds in one day; vegetation two. A from-zero V4 resets every LIVE
verdict in the project to unverified simultaneously** — months of author-eyes to climb back
to today, before a single NEW feature exists. Revenue gap for the duration. And the
V2-autopsy risk profile is at its maximum here: a from-scratch build under revenue pressure
is exactly the 2,000-lines/day velocity regime in which structure historically lost.

**The honest ceiling comparison:** end-state *performance* identical to Option 2 — the fps
comes from frame anatomy, and both options build the same anatomy. End-state *code health*
better than Option 2 by a nose — and every item in that nose (texture-system unification,
boot diet, registration-as-data) is individually reachable as a bounded post-keel project
under Option 2, without ever resetting the verification ledger.

**Time-shape (estimate):** months to parity. Not weeks.

---

### Option 4 — Raw WebGPU, no three.js *("the metal")* — and the direct answer to the author's question

**The question asked:** "Would raw WebGPU actually work better? Surely the three.js people
are the best experts at squeezing performance out of this?"

**The expert answer, straight:** the three.js team are excellent, but their mandate is
**generality, not your frame.** A scene-graph renderer that must serve a million arbitrary
use cases pays per-frame costs a purpose-built engine doesn't: generic traversal, node/
material update loops, bind-group management done defensively. That tax is real, it is
CPU-side, and it is likely where part of our 7.7 ms mystery lives. **But the GPU does not
know three.js exists.** TSL compiles to WGSL; a texture sample is the same instruction
hand-written or emitted; our measured GPU problem (26.6 ms of overdraw-shaped world draw) is
frame *anatomy* — how many times each pixel is shaded — which is entirely ours to fix from
TSL/three land and which raw WebGPU would NOT fix by itself. Port today's pass structure to
raw WebGPU verbatim and you'd keep ~90% of the GPU cost.

**What raw would buy:** a CPU floor — realistic estimate ~3–6 ms/frame at our draw-call scale
— native render bundles, exact pass/bind control, and zero library mysteries.

**What raw would cost:** the TSL authoring model — which is not a convenience here, it is
**the business's production line**: the author personally works in TSL terms (Maya shader
background), the shader lab is TSL, every effect look is a TSL graph, and effect velocity is
what sells maps. Plus everything three provides free (compressed-texture handling, render
targets, compute plumbing, math), plus months of engine infrastructure before the first
pixel, plus every future effect costing more, forever. And the mystery costs may not even be
three's — anything living in Dawn/Chrome comes along to raw WebGPU too. Week zero answers
that before anyone bets on this.

**Verdict as the expert:** for a one-artist business whose product is effects-rich maps, raw
WebGPU is the wrong trade — it spends the moat (authoring speed) to buy CPU margin that
Options 1/2/5 buy for a fraction of the price. The legitimate version of the instinct is
Option 5. (Choosing Option 4 would also reopen the locked WebGPU+TSL decision — noted, since
that decision was locked for exactly these reasons.)

---

### Option 5 — The scalpel hybrid: three + TSL everywhere, raw where measured *("the contingency")*

**What it is.** Not a standalone path — a track that composes with Option 1 or 2. Keep three
+ TSL as the engine and authoring layer. Where — and only where — week zero *proves* a
three-internal cost that batching/bundles/static-lists can't avoid, take one of two scalpels:

1. **Patch our three locally.** We already build a custom `three.webgpu` bundle
   (`npm run build:three-webgpu`) — a measured hot-path patch (e.g., skipping a generic
   per-frame loop our usage never needs) is maintainable, documented per-patch, and
   re-appliable on upgrades.
2. **Drive specific passes with raw device access.** three exposes the underlying WebGPU
   device/queue; individual hot passes (a blit, the visibility pass) can be encoded by hand
   alongside three-managed passes, keeping TSL for everything authored.

**What it buys:** Option 4's realistic CPU wins (the few ms that are actually three's fault)
without losing the authoring model. **Costs/risks:** fork discipline (every patch documented,
upstreamed where possible); raw passes are expert-only territory with no TSL safety net —
kept to passes no one authors against.

---

## 3. Comparison at a glance

| | 1 · Tune in place | 2 · New keel | 3 · From zero | 4 · Raw WebGPU | 5 · Scalpel |
| --- | --- | --- | --- | --- | --- |
| First big fps win | days | ~2–3 weeks | months | many months | after week zero |
| Mansion end-state | ~45–60 fps; cache pillar hard to retrofit | 60 locked + headroom (cache lands clean) | same as 2 | same GPU + CPU margin | +few ms CPU to 1 or 2 |
| Time to V2 parity | fastest — features never pause | fast — ports resume at current cadence after cutover | slowest that still ships | slowest, full stop | n/a (composes) |
| Author verification burden | low (per-step gates) | medium (per-port, each small) | maximal — every LIVE verdict resets | maximal+ | low |
| End-state code health | unchanged (god object stays) | strong (god object dissolves by evacuation) | strongest by a nose | different, not better for velocity | neutral |
| Chief risk | surgery inside the closure (7 traps) | two-path drift; keel scope creep | V2-autopsy velocity regime + revenue gap | loses the authoring moat | fork discipline |

## 4. Recommendation (and what would change it)

**Staged: Option 1 now → Option 2 as the next campaign → the cache pillar lands on the keel.
Option 5 held as a contingency; Options 3 and 4 declined for V4.**

Reasoning: revenue wants the mansion acceptable in days-to-weeks, and Option 1's biggest
lever (early-Z composition) is precisely the step that needs no extraction first. Nothing in
Option 1 is throwaway — the interior/boundary meshes, discard-free materials, batched light
buffers, and unified post shader all carry into the keel as-is; Option 1 builds the keel's
organs in place, and Option 2 then gives them a clean skeleton and dissolves the god object
by evacuation rather than surgery. The cache — the pillar that turns "more effects than V2"
from a hope into an accounting identity (static effects: zero frame cost) — waits for the
keel, where it's a feature instead of a retrofit.

**What would change my mind:** if week zero shows the 7.7 ms class is structural in three's
per-render path and un-patchable → Option 5's scalpels get promoted into Option 1
immediately. If early-Z lands under 2× predicted win → stop, reconcile against the A/B
measurements before building anything on top. If the author's parity ledger turns out short
(V2's 46 effects collapse into fewer real gaps than feared) → the keel campaign can start
sooner, since the revenue pressure window is narrower than assumed.

## 5. Off-menu, and why

- **Shrinking maps or authoring smaller art** — off-menu. 12K×12K is the product promise and
  the mansion is the declared ceiling case; the engine copes or the engine is wrong.
- **Temporal upscaling / dynamic resolution at `standard` profile** — off-menu; zoom-out
  clarity is a locked aesthetic. Lower profiles may use resolution levers (one is already
  built and awaiting its first live test).
- **Worker-thread renderer (OffscreenCanvas)** — parked; camera-sync jitter risk against
  Foundry-owned input, and main-thread CPU isn't yet proven to be the binding constraint.
- **Radiance-cascades GI** — separately parked, long-term, explicitly not started unprompted.
- **Vision/fog in any cache, ever** — the known fog-of-war gap is a correctness bug scheduled
  on its own track; nothing in any option bakes or caches vision state.

## 6. What every option must preserve

The `standard` profile keeps producing today's pixels until the author says otherwise
(parity doctrine). The safety slide keeps its Foundry fallback at every commit. The depth
authority remains the sole occlusion/rank system — every option *promotes* it (the rank
buffer literally becomes the hardware depth test). Foundry owns input; the interface seam
stands. Every structural change ships behind a revert flag. `npm run verify` green before any
`src/` work is called done — and green is necessary, never sufficient: the author's eyes on a
real scene are the only promotion to LIVE.

## 7. Decisions needed from the author

1. **Pick from the menu** (or ask for a deeper dive on any option before choosing).
   The recommendation on the table: staged 1 → 2.
2. **The reference laptop's CPU model** — for `Moonshot.md` §1; the CPU-side mysteries make
   it load-bearing.
3. **Blessing for week zero regardless of the pick** — it's measurement + the parity ledger
   only, no pixels change, and every option needs both.
