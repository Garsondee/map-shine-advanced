# SKELETON — the load-bearing skeleton

**Status:** DESIGN SPEC, authored 2026-07-16, answering the author's question directly:

> _"Is there a way we can make a non-functional skeleton of the whole module out of comments with the single goal of not fucking this up for a third time? The idea being that we make a rigid but correct shape for the rest of the code to eventually fit into... We need to nail down the right form in a way that future LLMs cannot fail but act inside of."_

**Companions:** `Engine-Postmortem.md` + `Effects-API.md` (the evidence), `Effects.md` (tiers), `Keyhole.md` (the plan). Memory: `v2-postmortem-the-failure-modes`.

---

## 0. The straight answer

**Yes to the skeleton. No to comments as its material.** The postmortems make the reason unavoidable — V2 _already had_ a comment skeleton, and here is what happened to it:

1. `EffectComposer.js` documented and implemented the correct layer model. **5 importers. The god-object got 92.**
2. `legacy/foundry/` was the documented adapter for all Foundry access. **21 of 128 files complied — 16%.**
3. `resolve-effect-enabled.js`'s docstring: _"Every render pass gate... **MUST** call this instead of inlining its own variation."_ A MUST, in writing. It was added _because_ the pattern had already scattered, and the scattering continued.

Every one of those is a comment-skeleton losing. Not because anyone was careless — the author tried harder than most — but because **a comment cannot fail a build.** A fresh session (human or LLM) under deadline pressure does the locally easy thing, and reading prose is never the locally easy thing.

> **The skeleton's one law: everything load-bearing must be able to FAIL A BUILD or THROW AT THE CALL SITE.**
> Comments explain the walls. They are never the walls.

**And the second law, which the velocity finding forces (`Engine-Postmortem.md`, §0): THE WALL MUST BE FRICTIONLESS — the correct path has to be the FAST path.** V2 was ~376k lines in under six months, ~2,000/day. At that pace there is no afternoon in which a harder-but-correct route is affordable, and a wall that costs time gets routed around no matter how right it is. That is _precisely_ how `EffectComposer` lost. So: enforcement by **absence** (nothing to reach with) and by **automation** (`npm run verify`), never by discipline — discipline is exactly the resource a sprint does not have spare. **Design test for every piece of this skeleton: does it make the right move QUICKER than the wrong one?** If declaring a particle system is more work than hand-rolling a sprite, the declaration loses and the tripwire becomes an obstacle instead of a rail — that is a defect in the skeleton, not in the person who routed around it.

The "future LLMs cannot fail but act inside of" framing is exactly right, and it sharpens the design: every future session starts cold, confident, and biased toward the easy path — _the same population that built V2's mess_. The skeleton must therefore deliver its rules **at the moment of violation**, not in documents read beforehand, because the cold session hasn't read them. Which yields the design's central trick:

> **Errors are the documentation's front door.** Every wall a session can hit carries, in its error message, _what this is, which doc owns it, and what must be true before proceeding_. The wrong move triggers the reading.

---

## 1. The media ladder — what is allowed to carry a rule

Strongest first. A rule lives at the highest rung that can hold it, never lower.

| Rung   | Medium                                                                              | Example                                                                                  |
| ------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **L0** | **Absence** — you cannot reach what you were never handed                           | an effect's `ctx` holds exactly its declared reads; passes are never handed the renderer |
| **L1** | **Throw at the seam** — real exports that throw with a map reference                | `NOT_BUILT('occlusion-producer', 'Keyhole.md §…')`; the allocator's >2048px throw        |
| **L2** | **Machine checks in `npm run verify`** — lint boundaries, structure tests, ratchets | deep cross-zone import = lint error; `setRenderTarget` outside `graph/` = red test       |
| **L3** | **Schema-validated data** — declarations that a Node test validates                 | effect manifests (`Effects-API.md` §5, `Effects.md` §2)                                  |
| **L4** | **Comments** — explanation ONLY, attached to an L0–L3 artifact that points at them  | the stub's contract text; the doc section its error cites                                |

L4 alone is V2. Every finding in both postmortems traces to a rule that lived at L4 when it needed L0–L2.

---

## 2. What the skeleton physically is

Five artifacts. Together they are the "rigid but correct shape."

### 2.1 Zones with ONE door each

The directory tree from `Keyhole.md` §3 is created in full, now. Each zone (`vt/`, `graph/`, `scene/`, `foundry/`, `gameplay/`, `effects/`, `world/`, `ui/`, `diag/`) exposes **one public door: its `index.js`**. Importing anything else across a zone boundary is an ESLint error (`import/no-restricted-paths` — already in the toolchain, no new dependency). Inside a zone, imports are free.

This kills the reach-into-privates disease at module scale: `sceneComposer?._sceneMaskCompositor` (27 reaches in V2) is not _discouraged_, it is **unimportable**.

### 2.2 Seam stubs that throw

Every load-bearing seam named in the plans exists as a real module exporting the real signatures — and throwing:

```js
export function buildOcclusionMask() {
  throw new NotBuilt('occlusion-mask-producer', {
    owns: 'Keyhole.md §"THE REMAINING PIECE" + scene/occlusion.js (the ported model)',
    gate: 'tokens must render first (author, 2026-07-16) — they do; this is unblocked',
  });
}
```

A future session that wires toward an unbuilt capability fails **at the exact seam, with the assignment brief in the error**. Not every file is stubbed — only the seams the plans name. Stubs are replaced only by an implementation _plus its tests_, and the stub's contract text moves into the implementation's header.

### 2.3 The tripwire suite — `tools/verify-structure.mjs`

A Node script in `npm run verify` (already the standing gate — `feedback_v3_code_cleanliness_standard`) asserting the architecture itself. Each assertion carries the postmortem citation it defends. v1 list:

| Tripwire                                                                                                                 | Defends against (citation)                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| No `window.*` cross-module reads; the ONLY allowed global surface is `MapShine.debug` (the shop window, never a hallway) | 479 global-bus reaches; effect→effect cycles                                        |
| Foundry globals (`canvas.`/`game.`/`Hooks.`) only in `foundry/` (+ ratcheted allowlist, see 2.4)                         | the adapter that covered 16% of its job                                             |
| `.prototype.X =` patches only in `foundry/`, each listed in a patch registry with the Foundry version it targets         | 98 unguarded monkey-patches (the drift bomb)                                        |
| `setRenderTarget` / `autoClear` / `setViewport` / `setScissor` only in `graph/`                                          | 452 call sites across 60 files — renderer state with 60 owners                      |
| `new *RenderTarget(` only in the allocator                                                                               | 70 private world-res RTs                                                            |
| GPU readbacks (`readRenderTargetPixels`/`readPixels`/`gl.finish`) only in `diag/`, labeled                               | the GPU-as-data-structure stalls (one of them read ONE PIXEL)                       |
| **No empty catch blocks** (ESLint `no-empty` + review of catch bodies)                                                   | **2,670 silent swallows** — one per ~140 lines; `feedback_instruments_must_not_lie` |
| No `.mix(`/`.smoothstep(` method form in shader-building files                                                           | `reference_tsl_method_chaining_trap` — one session, three bugs                      |
| No uniform named `uEnable*`/`uUse*`/`uHas*`                                                                              | 117 uniform-gated branches; `Effects.md` Law 4                                      |
| Effect manifests validate (contiguous tiers, non-decreasing cost class, one producer per resource)                       | `Effects-API.md` §5, `Effects.md` §7                                                |
| `.params.X =` writes only via the params service (one owner)                                                             | 938 keys written from 119 external sites by 6 subsystems                            |
| `setTimeout` with a numeric delay outside `diag/`+`ui/` requires an inline justification tag                             | 208 timing-as-glue sites; ordering by hoped-for delay                               |
| `src/` never imports `legacy/`                                                                                           | the quarantine (exists — absorbed here)                                             |

### 2.4 Ratchets — how existing debt is handled without lying

Some rules the current `src/` already violates (boot.js wires hooks directly; `vt-pan-viewer.js` is really the scene renderer). Those tripwires start as **ratchets**: the current count is frozen in `tools/structure-ratchets.json`; any _increase_ fails; any decrease auto-tightens the stored bound. The suite never claims virtue it doesn't have — it guarantees **monotonic improvement**, which is the honest version of "rigid."

### 2.5 The covenant header

Each zone's `index.js` opens with five lines: what the zone owns, what it may touch, which doc governs it, and the sentence _"Changing this file's exports is an architectural change — say so in the commit message (`[structure-change]`) and update the governing doc."_ Weakening a tripwire requires the same tag. Not hard-enforceable — but it makes drift **loud**, and every quiet-drift disaster in the autopsy was quiet precisely because nothing announced it.

---

## 2.6 ✅ BUILT AND PROVEN (2026-07-16) — the forcing function is no longer a plan

Author: _"How do we force the new version to not commit those same mistakes?"_ Three parts, all now real:

**1. THE BAD PATH FAILS.** `tools/verify-structure.mjs` — **14 rules**, in `npm run verify`. Each carries the V2 corpse it defends against and the fix, printed on failure. Coverage of the seven documented bypasses is now 6/7 walled (the god-object itself needs the effect-registry to exist first). Five are **ratcheted** at current debt (global-bus 7, silent-catch 35, foundry-reach 12, private-clocks 41, renderer-state 0): an increase fails, a decrease auto-tightens. **Four are FREE WALLS built before the rooms** — `darknessLevel`, `sunDirection`, `shadowLift`/`tCombinedShadow`, and hand-written controls all sit at ZERO, so the code that would violate them can never be written in the first place. That is the cheapest moment to build a wall and it will never come again.

**2. THE WALLS CANNOT ROT.** `tools/verify-structure.test.mjs` — **73 assertions** feeding _real lines from the real `legacy/` source_ to the rules and asserting each is rejected: Lighting reading Fire's private `_glowBucketsByFloor`; the one-pixel `readRenderTargetPixels`; the `.mix()` line that blacked out the map; `uDynamicLightShadowOverrideStrength = 0.7`; `addFolder({title:'Sun'})`. **Adversarially verified:** gutting a rule's regex — exactly what a future session does to unblock itself — turns the suite red and _names the corpse that would slip through_. It also asserts every rule carries a `why` and an `instead`, and that legitimate code (`TSL.mix`, `MapShine.debug`, a catch that reports) is never rejected. A wall that cries wolf gets muted; this stops that too.

**3. THE GOOD PATH MUST BE FASTER** (law 2, §0) — the only part not yet mechanical, and the one that decides everything. All seven bypasses happened because at ~2,000 lines/day the correct path cost more _that afternoon_. So: **generate, never hand-write.** UI from the params schema; a particle system from a declaration; an effect's plumbing from its manifest. When declaring is quicker than hand-rolling, the wall stops being an obstacle and becomes a rail. **Every unbuilt piece of this skeleton must be judged against that test, not against elegance.**

## 3. The covenant — rules a future session acts inside

0. **Read `v2-postmortem-the-failure-modes` before touching architecture.** (It is at the top of memory.)
1. **If a wall stops you, the wall is right until the author says otherwise.** Read what its error cites. Routing around a wall — a new global, a deep import, a catch-and-continue, a setTimeout — is _the_ V2 move; every one of the 2,670 swallows was someone routing around a wall quietly.
2. **Declaration first, implementation second.** If you cannot write the manifest/contract, you do not understand the thing yet — find out in an afternoon, not week three.
3. **A stub is replaced only by an implementation plus its tests.** The contract text moves into the implementation.
4. **When you fix a bug class, add its tripwire.** The `.mix()` ban exists because that bug cost a session. The suite grows with the autopsy — that is the mechanism by which "burning failures into memory" becomes _enforcement_ instead of remembrance.
5. **Never weaken silently.** `[structure-change]` in the commit, doc updated, author told.

## 4. Rigid without being frozen

The skeleton pins **boundaries and contracts** — who may touch what — never implementations. Boundaries are what two independent postmortems supply evidence for; implementations are where the product's taste lives and must stay free. And "rigid" does not mean unchangeable: it means **changes announce themselves**. V2's shape was never _decided_ wrongly — it _drifted_ wrongly, one quiet expedient at a time, each invisible on the day. The skeleton's whole job is to make the drift moves loud or impossible; deliberate change stays cheap.

## 5. Sequencing

1. **Name the ~10 passes and write their declarations first** (the queued thinking task — `Effects-API.md` §6). The seams _are_ the passes; generating stubs before naming them would pin guesses.
2. **Then generate the skeleton**: zone tree, one-door indexes, seam stubs, `verify-structure.mjs` v1 with ratchets frozen at current counts.
3. **From then on it rides `npm run verify`**, which already gates every session's work.

## 6. What this is NOT

- Not pseudocode of implementations — algorithm comments rot; the plans stay the narrative.
- Not a file for every eventual module — only the seams the plans name.
- Not a promise that structure can't change — a promise that it can't change _quietly_.

---

_A comment cannot fail a build. Make the walls real, hang the signs on the walls, and put the map inside the error message._
