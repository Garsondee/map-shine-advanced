# Map Shine Advanced — Docs (V3 / Keyhole)

**This directory is the V3 (Keyhole) project.** V2 / pre-Keyhole material has been moved to [`archive/`](archive/) and is kept for history only — nothing there governs current work.

## Start here
- **[`ARCHITECTURE-SUMMARY.md`](ARCHITECTURE-SUMMARY.md)** — the one-page map of the V3 engine (kept deliberately short).
- **[`planning/Keyhole.md`](planning/Keyhole.md)** — the plan of record. Read its CURRENT STATUS section first.
- **[`planning/Skeleton.md`](planning/Skeleton.md)** — the enforcement doctrine (why rules live in `tools/`, not comments).

## The governing design docs (`planning/`)
- **[`Parity-and-Compatibility.md`](planning/Parity-and-Compatibility.md)** — Foundry parity, the UX-regression catalog, the cross-module compatibility doctrine, the testing regime + QA benchline.
- `Engine-Postmortem.md`, `Effects-API.md`, `Effects.md`, `Environment.md`, `Light-and-Shadow.md`, `Light-Parity.md`, `Light-MSA-Ideas.md`, `Params.md`, `Particles.md`, `Water.md`, `UI.md`, `Health.md`, `Shaders.md` — one design doc per subsystem, each grounded in the V2 audit.
- `Forward+.md` — the diagnosis archive Keyhole builds on (still a live companion).
- `v3/` — the B0/B2 build specs and golden-scene expectations.

## Reference (`reference/`)
- `foundry-v14-lighting-audit.md` — Foundry v14 lighting, read against the vendored source.
- `v2-effect-params/` — what each V2 effect did, cross-referenced to the V3 pass that replaces it (the Stage-6 rebuild guide).

## Also authoritative (not in `docs/`)
- **Project memory** (`MEMORY.md` + files) — rolling status, decisions, and hard-won lessons.
- **`src/graph/passes.js`** — the live render pipeline. **`tools/verify-structure.mjs`** — the walls.
