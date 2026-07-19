# AUTHORING & DISTRIBUTION — paint the map, save it to the scene, sell it in an adventure

**Status:** DESIGN SPEC, authored 2026-07-20 from an author directive. The Map Points successor, plus the persistence/distribution model that makes MSA maps *sellable*. A milestone to land **before** the effects, because effects consume what this produces (you paint the `_Fire` mask; the fire effect reads it).
**Audience:** the author (a map-maker selling adventures), and a fresh session. Read `docs/planning/Params.md` (persistence is built) and `keyhole-mask-authority` (memory) first — this leans on both.
**Companions:** `Parity-and-Compatibility.md` (the QA-gate pattern this borrows for distribution), `Effects-UI.md` (the paint UI is a sibling of the config UI), `keyhole-interface-seam` + `keyhole-input-model-decision` (the input tension paint mode must resolve).

---

## 0. THE TWO QUESTIONS, AND THE SHORT ANSWERS

The author asked two hard, Foundry-specific questions. Both have simpler answers than feared:

> **Q1 — Files.** Foundry restricts creating files. To let a user generate a new `_Fire` texture and get it back into the right server directory, do we need to download it quietly and give them a re-upload button? Or is there a simpler solution?

**No dance needed.** Foundry ships `ImageHelper.uploadBase64(base64, fileName, filePath, …)` (`client/helpers/media/image-helper.mjs:183`) — it takes a painted canvas's data-URL and writes it **straight to a server path** (internally `fetch → Blob → File → FilePicker.upload`). It only needs the `FILES_UPLOAD` permission (`game.user.can("FILES_UPLOAD")`), which a GM/map-maker has. So the map-maker paints and the file lands beside the map, no download/reupload. And for the case where you'd rather have **no file at all**, the paint can be **embedded in the scene flags** (§3). The download/reupload is a last-resort fallback for a permission-locked player, not the design.

> **Q2 — Selling.** Can MSA's effect settings be *saved* to a scene and *reliably exported* when scenes are packaged into an "adventure"-type compendium — with a strong good-looking default profile?

**Yes, and most of it is already architected.** A Foundry `Adventure` embeds **full scene documents including their `flags`** (`common/documents/adventure.mjs:45,53`), and MSA settings already persist to scene flags (`Params.md` §3.4 — built). Painted masks travel as files in the module's asset tree (discovered by the mask-authority's sibling convention) **or** embedded in flags. The default profile is the schema defaults in code, and a scene ships only what *differs* from them. The one new thing to build is a **package-readiness gate** (§4) that proves a scene is self-contained before you sell it.

---

## 1. WHAT V2'S MAP POINTS WERE — the audit

**8 files, 7,480 lines**, to place points that spawn effects:

| File | Lines | |
|---|---|---|
| `map-points-manager.js` | 2,998 | the manager (god-object shape again) |
| `map-point-interaction.js` | 1,686 | placement/editing input |
| `map-point-emission-sampling.js` | 996 | where a group emits |
| `map-point-wall-clustering.js` | 451 | cluster points by walls |
| `map-point-control-clusters.js` | 374 | control-gizmo clustering |
| `map-point-level-binding-ui.js` | 497 | per-floor binding UI |
| `map-point-group-info.js` / `marker-visual.js` | 478 | info + markers |

A "map point group" was a set of placed `{x,y}` points + emission settings + an **effect target** (`EFFECT_SOURCE_OPTIONS` — `map-points-manager.js:45`: fire, candleFlame, dust, smellyFlies, lightning, water, sparks, structuralShadows…) + a level binding, persisted to `scene.flags['map-shine-advanced'].mapPointGroups` (`:790`).

**What V2 got right (keep):**
- **Scene-flag persistence** — the groups travelled with the scene, so they already export in an adventure. This is the pattern §4 formalises.
- **The point→effect mapping** as a concept, and **per-floor level binding**.

**What made it "clunky, slow, inorganic, awkward" (the author's words):**
- It expressed *"there is fire across this hearth"* as **discrete placed points + emission falloff + clustering** — machinery for what is really **a painted region**. The mismatch between the mental model ("this area is on fire") and the tool ("place points, tune emission, cluster by walls") is the awkwardness.
- 7,480 lines of it, with the god-object/backwards-compat sprawl the postmortem catalogues everywhere else.

**The reframe:** most of what Map Points did is a **painting** problem, not a **placement** problem. A few things (a single candle, one lightning point, a rope span) are genuinely discrete. So the successor is **paint for regions, place for anchors** — one coherent surface replacing the 7,480 lines.

---

## 2. THE VISION — paint for regions, place for anchors

One authoring surface, opened in an explicit **Paint Mode** (map-maker, opt-in — see §5 for the input reconciliation):

- **Brush tool (regions).** Paint/erase with size, softness, opacity, flow — directly into the mask an effect consumes: `_Fire`, `_Dust`, `_Water`, `_Outdoors`, `_Shadow`, `_Specular`, etc. **Live preview:** paint fire, see fire, because the brush writes into the very texture the fire pass reads. This is the organic feel V2 never had.
- **Stamp / anchor tool (discrete).** A single candle flame, a lightning strike point, the two endpoints of a rope, a specific emitter. Placed, not painted — the genuinely-discrete remainder of V2's map points, kept lightweight.
- **One authority underneath.** The brush writes into the **mask authority** (`src/scene/mask-authority.js`), which is *already* the one source of truth for authored + derived masks (`keyhole-mask-authority`). No new source of truth is created — painting, runtime serving, derivation (sky-reach etc.), and persistence all flow through the one hub. That is the doctrine (`v2-postmortem` §3B.8: one owner) applied to authored content.

The mental model matches the tool: an area *is* on fire because you painted it, exactly as you would in Photoshop — but in-app, live, against the real renderer.

---

## 3. PROBLEM 1 — persisting painted textures without the file dance

Three storage modes, one ingest point (the mask authority). The author's "download quietly, re-upload" idea is **mode C, the last resort** — modes A and B are simpler and better.

| Mode | Mechanism | Travels in an adventure? | Best for | Needs |
|---|---|---|---|---|
| **A. Embed in scene flag** | Paint → downscale (masks are low-frequency; ≤512² is the mask-authority's own grid size) → compress (PNG data-URL or RLE'd Uint8) → store in `scene.flags`. Decoded at load into a DataTexture the mask authority serves. | **Yes, automatically** — it's flag data, and adventures embed scene flags | Simple/low-detail masks (outdoors, fire regions, dust); zero file management; **FILES_UPLOAD-locked users** | nothing |
| **B. Bake to file** | Paint → `canvas.toDataURL()` → `ImageHelper.uploadBase64(dataUrl, 'Tavern_Fire.webp', 'worlds/…/maps')` writes the sibling file straight to the server dir. Discovered by the mask-authority's sibling convention. | **Yes** — ships in the module's asset tree beside the map (§4) | High-detail / final masks; full resolution; the selling master | `FILES_UPLOAD` (the map-maker has it) |
| **C. Download + manual re-upload** | Paint → browser download → user re-uploads via Foundry's own FilePicker | Same as B once the file lands | **Only** a player with no upload permission who insists on a file | user action |

**Recommendation:** **default to Mode A (embed)** — it is frictionless, self-contained, and travels for free, which is exactly what selling wants. Offer **Mode B (bake)** as "promote to full-resolution file" for the final master or when a mask is too detailed to embed cheaply. **Never require Mode C** — it exists only so a locked user is not blocked. This directly answers *"do we even need to go that far?"* — no.

**Size discipline (Mode A):** a scene flag is not free — a compendium of many scenes each carrying several fat mask blobs bloats the pack and slows load. So embed is **downscaled + compressed by default**, with a per-mask byte budget surfaced in the UI, and "this mask is large — bake it to a file instead?" guidance when a mask exceeds it. The mask authority owns this decision, in one place.

---

## 4. PROBLEM 2 — saving to scenes and shipping in adventures

### 4.1 What actually travels (verified against Foundry v14 source)

| MSA state | Where it lives | Travels in an Adventure? | Status |
|---|---|---|---|
| Effect **param settings** | `scene.flags['map-shine-advanced']` (params serialize → only diffs from default) | **Yes** — `Adventure.scenes` embeds full `BaseScene` incl. `flags` (`adventure.mjs:45,53`) | **Built** (`params-schema.js`) |
| **Embedded** painted masks (Mode A) | `scene.flags` (compressed) | **Yes** — same as above | To build |
| **File** painted masks (Mode B) | sibling files beside the map, e.g. `Tavern_Fire.webp` | **Not embedded** — the adventure stores the *path*; the **file** ships in the module's asset tree and must resolve on install. The mask-authority sibling convention makes it travel *with the map file*. | Discovery **built**; the packaging step is the map-maker's |
| Point/anchor placements | `scene.flags` (as V2 did) | **Yes** | Pattern proven (V2) |
| The **default profile** | schema defaults **in code** (the buyer's installed MSA) | N/A — it *is* the buyer's MSA | **Built** (`serializeParams` stores only diffs) |

**The key facts:** an Adventure embeds scene *documents* (with flags), **not arbitrary asset files**. So param settings and embedded masks travel automatically; file masks travel as module assets alongside the map they sit beside. Nothing MSA does breaks this — it already persists to flags and discovers masks by convention.

### 4.2 The default profile — a good look for free

The buyer gets the schema defaults (a strong, tuned, good-looking baseline — the author's taste, `Effects-UI.md`), and the scene overlays only the handful of values the map-maker changed (`serializeParams` stores just the diffs — `Params.md` §3.4). So: **a scene with zero MSA overrides still looks good**, and a fully-authored scene carries only its deltas. A buyer who never opens a menu gets a beautiful map; the map-maker's authored look rides on top.

### 4.3 THE SELF-CONTAINMENT DOCTRINE (the load-bearing rule for selling)

> **MSA's authored look on a scene must be a pure function of `(scene document + files that ship beside the map)`. Nothing in `localStorage`, nothing client-local, nothing that only exists on the author's machine.**

This is what makes *"what I see is what the buyer gets"* **true** rather than hopeful. It has a concrete consequence: **per-user view state and client-local settings may never carry authored look** (they already don't — `Params.md` §3.4 sends `expanded`/`advanced` to client settings and *values* to the scene). Any future feature that stores authored content client-side breaks selling silently.

### 4.4 THE PACKAGE-READINESS GATE (new — the distribution QA benchline)

A one-click check, cousin to the parity benchline (`Parity-and-Compatibility.md` §6), that proves a scene is **sellable** before you package it:

| Check | Pass |
|---|---|
| Every **file mask** referenced by the scene exists at a path that will travel (beside the map / in the module tree) | no dangling mask path |
| Every **embedded mask** is within its size budget | no oversized flag |
| **No client-local authored state** — the look is 100% in flags + sibling files (§4.3) | self-contained |
| The scene renders acceptably **with defaults only** (simulate a buyer with no overrides) | the default profile holds |
| Point/anchor groups persisted to flags | present |

Green = *"this will look the same on the buyer's machine."* This gate is the selling equivalent of B1–B5 in the parity doc: a release/pack either clears it or it isn't ready to ship.

---

## 5. THE ARCHITECTURE — reuses V3, adds little

```
   Paint Mode (opt-in, map-maker)
        │ brush / stamp
        ▼
   ┌──────────────────────┐     serves      ┌────────────┐
   │  MASK AUTHORITY      │ ───────────────▶ │  effects   │  (live preview: paint fire, see fire)
   │  (one source of truth)│                  └────────────┘
   └─────────┬────────────┘
             │ persist
     ┌───────┴─────────┐
     ▼                 ▼
  scene flags      sibling file
  (embed, Mode A)  (uploadBase64, Mode B)
     │                 │
     └──── travel in the adventure / module ────┘
```

**Reused, already built:** the mask authority (serving + derivation + sibling discovery), params persistence (flags, diffs-from-default, hydrate), the interface seam's mode-awareness, Foundry's `uploadBase64`. **Foundry supplies the hard part** (file write, adventure embedding) — MSA supplies the brush and the wiring.

**New to build:** the paint UI (`ui/` — sibling of the config UI, so it can be *generated* the same way against a small paint-tool schema); the brush→DataTexture path (the mask authority's known-but-unbuilt DataTexture ingest — `keyhole-mask-authority` "deliberately not built" list, whose first consumer this becomes); the embed codec (downscale + compress + budget); the package-readiness gate.

**Walls (candidates, `Skeleton.md` L1–L2):** authored mask/paint state may be written **only** through the mask authority (one owner — a `.paint`/mask write anywhere else fails); no authored look in client-local storage (defends §4.3 self-containment); paint mode is an explicit, announced state, never silent gameplay input capture.

**The input reconciliation (the real tension, resolved carefully):** `keyhole-input-model-decision` gives *all* input to Foundry, MSA's canvas `pointer-events:none`. Painting needs pointer input — but painting is **authoring, not gameplay**. The likely mechanism: a dedicated **paint overlay canvas** (`pointer-events:auto`) mounted *only while Paint Mode is active*, capturing brush strokes, torn down on exit — it never touches the gameplay input path, so it does not reopen the input decision (which is about not being a second *gameplay* authority). This wants a live check (§7). It rhymes with V2's own "map-maker mode" and the interface seam's edit-mode handling.

---

## 6. WHERE IT SITS IN THE ROADMAP

**Before the effect families** (`Roadmap-to-Parity.md` §2 items 5–9) — an effect is only worth building once you can paint the mask that drives it. Tier-0-first, as always:

- **Tier 0:** brush-paint **one** mask (`_Fire`) into the mask authority with **live preview** and **Mode-A embed persistence**. Prove the whole loop — paint → see it → save to scene flag → reload → it's still there — end to end, on one mask.
- **Then:** Mode B (`uploadBase64` bake) · the stamp/anchor tool (the discrete remainder of V2 map points) · the package-readiness gate · multi-mask + per-floor binding (V2's level-binding, kept).

---

## 7. OPEN QUESTIONS — the real forks

1. **Paint-mode input mechanism** — overlay canvas (leaning) vs. MSA canvas temporarily interactive vs. driving off Foundry's own region/drawing tools. Needs a live check; the overlay is the cleanest against the input decision.
2. **Embed size budget** — how large a mask flag is acceptable inside an adventure compendium before Mode B is the better call. Needs a measured number on a real multi-scene pack.
3. **Anchors: flags or authority?** — keep discrete points in `scene.flags` (V2, proven) or fold them into the mask authority alongside painted regions. Leaning: flags for anchors, authority for painted regions, one persistence pass reads both.
4. **Brush feel** — a GPU brush compositing into the DataTexture (soft, pressure-like, flow) is what makes it feel organic rather than a paint-bucket. The bar the author set is "really really nice," so brush quality is a feature, not a detail.

---

*V2 made you place points to say "fire is here." MSA lets you paint it, watch it light up, and save it into a scene you can sell — with nothing left behind on your own machine.*
