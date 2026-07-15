# `src/` conventions — the V3/Keyhole tree

**Why this file exists:** the previous module (`legacy/`, née `scripts/`) grew huge and disorganized fast, partly because multiple LLM sessions touched it without a shared, enforced standard. This document plus the tooling below (ESLint + Prettier) exist so that doesn't happen again — conventions here are **machine-checked**, not just written down and hoped for. Run `npm run verify` before considering any `src/` change done.

**Scope:** everything under `src/`. `legacy/` is frozen and quarantined (Keyhole.md §5) — never touch it, never lint it, never reformat it. It doesn't run; there is nothing to fix.

---

## 1. Directory structure

The tree is fixed by [`docs/planning/Keyhole.md`](../docs/planning/Keyhole.md) §3 — don't add a new top-level directory under `src/` without updating that doc first:

```
src/
  boot.js       # the ONE entry point (module.json esmodules) — nothing else may be listed there
  vt/           # the virtual-texture core: page cache, page table, residency, atlas, decode
  graph/        # frame graph, allocator (law-enforcing), perf, present
  scene/        # floor model, unified geometry, attribute buffer, view-rect
  foundry/      # the ONE Foundry adapter: hooks, documents, proxy textures, vision, levels
  gameplay/     # native tokens, walls, fog/vision, templates, drawings, interaction
  effects/      # lighting, grade, bloom, water, fire, vegetation, weather, post
  world/        # LightingDirector, weather, wind, time-of-day
  ui/           # loading overlay, graphics settings, tweakpane shells
  diag/         # crash recovery, ledger, leak probe, profiler, debug panel
  core/         # small shared utilities (logging, etc.) — keep this thin, resist "misc bucket" drift
  vendor/       # third-party code, vendored verbatim (currently just Three r170) — never linted/reformatted
```

A file that doesn't obviously belong in one of these is a signal to either (a) pick the right one deliberately, or (b) ask whether the tree itself needs a new, documented category — never just drop it wherever seems convenient.

## 2. File naming: **kebab-case, always**

`page-cache.js`, `three-allocator.js`, `vt-pan-viewer.js`, `frame-graph.js` — every file under `src/`, no exceptions, including files harvested from `legacy/` (which used `PascalCase.js`; they get renamed to kebab-case on harvest, imports fixed, in the same commit). Enforced by `eslint-plugin-unicorn`'s `filename-case` rule — `npm run lint` will fail on a violation.

Compound-extension files (`vt-sample.glsl.js`, `*.test.mjs`) follow the same rule for the part before the first meaningful dot.

## 3. Identifier naming

- **Classes:** `PascalCase` — `PageCache`, `PageTable`, `PageAtlas`.
- **Functions, variables, methods:** `camelCase` — `computeVisiblePages`, `slotToAtlasPosition`.
- **Constants (module-level, truly constant):** `UPPER_SNAKE_CASE` — `DEFAULT_PAGE_PAYLOAD_PX`, `BYTES_PER_TEXEL_RGBA8`, `LAW_MAX_WORLD_RES_DIM`.
- **"Private" fields/closures:** a leading underscore signals "don't touch from outside this module/class" — `_active`, `_THREE`, `_renderer`. Not real privacy (no `#` fields yet in this codebase), just a convention both humans and ESLint's `no-unused-vars` (`argsIgnorePattern: '^_'`) understand.
- **GLSL exports:** `SCREAMING_SNAKE` for the exported string constant — `VT_SAMPLE_GLSL` — matching the shader-source-as-string convention already established.

## 4. Tests

- One `__tests__/` subdirectory per module directory (`src/vt/__tests__/`, `src/graph/__tests__/`), never a top-level `src/__tests__/`.
- One `*.test.mjs` file per source module under test, same base name (`atlas.js` → `atlas.test.mjs`).
- Each `__tests__/` directory has exactly one `run-tests.mjs` aggregator that imports every `*.test.mjs` in that directory and runs them via the shared `{ok, throws}` harness pattern (see any existing `run-tests.mjs` for the exact shape — copy it, don't reinvent it).
- Pure logic gets a real Node test. Browser-only code (real WebGL, real `createImageBitmap`, DOM) gets verified live via a debug-panel report instead (see `src/diag/debug-panel.js`) — don't fake a DOM/WebGL mock just to force a Node test where a live check is more honest.
- Run tests via `node ./node_modules/esbuild/bin/esbuild <dir>/__tests__/run-tests.mjs --bundle --format=esm --platform=node --outfile=<tmp>.mjs && node <tmp>.mjs` (esbuild resolves the ESM graph; plain `node` can't run it directly because of bare-ish relative imports mixed with `.mjs`).

## 5. The import fence — `src/` never imports `legacy/`

Machine-enforced two ways:
- `eslint`'s `no-restricted-imports` rule (`.eslintrc.json`) — catches it at lint time, in-editor.
- The precise grep the release script (eventually) runs: `grep -rnE "(from|import|require)\s*\(?\s*['\"][^'\"]*legacy/" src/` — should always return nothing.

Harvesting a legacy module means `git mv` (never copy) into the right `src/` subdirectory, rename to kebab-case, fix its imports to point at other already-harvested `src/` modules, and re-run tests. If a harvested module needs something not yet harvested, harvest that dependency first — never reach back into `legacy/`.

## 6. Comments

Default to none. Write one only when the reasoning isn't obvious from the code itself — a hidden constraint, a non-obvious invariant, a live-debugged fix whose root cause would otherwise get re-discovered the hard way. This codebase leans toward **longer, dated, evidence-citing comments at exactly the spot a bug was fixed** (see `atlas.js`, `vt-sample.glsl.js` for examples) — that's deliberate: several Stage 1 bugs took multiple live-debugging rounds to root-cause, and the fix comment is what stops the next session from re-deriving (or worse, re-breaking) the same thing. Cite the actual evidence (source line numbers, hand-traced numbers, dates) — "fixed a bug" without the mechanism is not a useful comment.

Never write a comment that just restates what the code says.

## 7. Tooling — run before considering work done

```sh
npm run lint          # ESLint over src/ + tools/ (legacy/ and vendor/ excluded)
npm run lint:fix       # auto-fix what's fixable
npm run format         # Prettier --write over src/ + tools/
npm run format:check   # Prettier --check (what CI/verify uses)
npm run verify          # lint + format:check, the pre-flight combo
```

Config lives at repo root: `.eslintrc.json`, `.prettierrc.json`, `.prettierignore`. Both exclude `legacy/`, `src/vendor/`, and other reference/generated trees — they were never meant to touch those.

**No silent scope creep on rules.** If a lint rule is fighting a genuinely idiomatic pattern (this happened with `no-inner-declarations` flagging ordinary nested function declarations, and `eqeqeq` flagging the standard `== null` idiom — both reconfigured, not the code) fix the *rule config* with a comment explaining why, don't sprinkle inline disables through the code. Inline `eslint-disable` comments are a last resort, not a first one, and should say why right there when used.

## 8. Doctrine reminders (from Keyhole.md, worth repeating here)

- Nothing is ever allocated at world resolution — enforced physically by `ThreeAllocator`'s law (`LAW_MAX_WORLD_RES_DIM`), not just documented.
- No fallback paths through `legacy/`. An absent feature fails loudly; it never silently routes to the old tree.
- Harvest = `git mv` + fix imports + rename to kebab-case, in one commit, tests green before and after.
