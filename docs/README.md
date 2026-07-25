# Map Shine Advanced — Docs (V3 / Keyhole)

**This directory is the V3 (Keyhole) project.** V2 / pre-Keyhole material has been moved to [`archive/`](archive/) and is kept for history only — nothing there governs current work.

## Start here

- **[`ARCHITECTURE-SUMMARY.md`](ARCHITECTURE-SUMMARY.md)** — the one-page map of the V3 engine (kept deliberately short).
- **[`planning/Keyhole.md`](planning/Keyhole.md)** — the plan of record. Read its CURRENT STATUS section first.
- **[`planning/Skeleton.md`](planning/Skeleton.md)** — the enforcement doctrine (why rules live in `tools/`, not comments).

## The governing design docs (`planning/`)

- **[`Roadmap-to-Parity.md`](planning/Roadmap-to-Parity.md)** — the backlog from today's basic parity to V2's full look, as 13 declared passes (`src/graph/passes.js`); the sequence, the reframe (parity = V2's _look_, not its machinery), and the gate.
- **[`Parity-and-Compatibility.md`](planning/Parity-and-Compatibility.md)** — Foundry parity, the UX-regression catalog, the cross-module compatibility doctrine, the testing regime + QA benchline.
- **[`Effects-UI.md`](planning/Effects-UI.md)** — the effects config UI: front of house (approachable dials) & rear of house (expert, generated, categorised), and the structural cure for V2's dead-slider minefield.
- **[`Authoring-and-Distribution.md`](planning/Authoring-and-Distribution.md)** — the Map Points successor: paint effect masks onto the map with live preview, and the persistence/distribution model that makes MSA maps sellable in adventures.
- **[`Shapes-and-Regions.md`](planning/Shapes-and-Regions.md)** — the vector half of authoring: precise points/lines/polygons (no grid snap) plus a Foundry-Region `Map Group` behavior, both feeding the same mask authority.
- `Engine-Postmortem.md`, `Effects-API.md`, `Effects.md`, `Environment.md`, `Light-and-Shadow.md`, `Light-Parity.md`, `Light-MSA-Ideas.md`, `Params.md`, `Particles.md`, `Water.md`, `UI.md`, `Health.md`, `Shaders.md` — one design doc per subsystem, each grounded in the V2 audit.
- `Forward+.md` — the diagnosis archive Keyhole builds on (still a live companion).
- `v3/` — the B0/B2 build specs and golden-scene expectations.

## Reference (`reference/`)

- `foundry-v14-lighting-audit.md` — Foundry v14 lighting, read against the vendored source.
- `v2-effect-params/` — what each V2 effect did, cross-referenced to the V3 pass that replaces it (the Stage-6 rebuild guide).

## Also authoritative (not in `docs/`)

- **Project memory** (`MEMORY.md` + files) — rolling status, decisions, and hard-won lessons.
- **`src/graph/passes.js`** — the live render pipeline. **`tools/verify-structure.mjs`** — the walls.
