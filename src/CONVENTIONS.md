# `src/` conventions — the V3/Keyhole tree

**Why this file exists:** the previous module (`legacy/`, née `scripts/`) grew huge and disorganized fast, partly because multiple LLM sessions touched it without a shared, enforced standard. This document plus the tooling below (ESLint + Prettier) exist so that doesn't happen again — conventions here are **machine-checked**, not just written down and hoped for. Run `npm run verify` before considering any `src/` change done. (`legacy/` itself is long gone — deleted entirely in `c328c9bd`, "V2 fully retired" — this file no longer needs to talk about it as a present directory.)

**Scope:** everything under `src/`.

---

## 1. Directory structure

The tree is fixed by `Keyhole.md` §3 — don't add a new top-level directory under `src/` without updating that doc first. (`Keyhole.md` and `Roadmap-to-Parity.md` are kept outside this repo, in the author's private planning archive — `docs/` no longer exists here, so section-numbered citations to either file throughout this codebase point there, not to a path in this tree.)

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

`page-cache.js`, `three-allocator.js`, `vt-pan-viewer.js`, `frame-graph.js` — every file under `src/`, no exceptions. Enforced by `eslint-plugin-unicorn`'s `filename-case` rule — `npm run lint` will fail on a violation.

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

## 5. Comments

Default to none. Write one only when the reasoning isn't obvious from the code itself — a hidden constraint, a non-obvious invariant, a live-debugged fix whose root cause would otherwise get re-discovered the hard way. This codebase leans toward **longer, dated, evidence-citing comments at exactly the spot a bug was fixed** (see `atlas.js`, `vt-sample.glsl.js` for examples) — that's deliberate: several Stage 1 bugs took multiple live-debugging rounds to root-cause, and the fix comment is what stops the next session from re-deriving (or worse, re-breaking) the same thing. Cite the actual evidence (source line numbers, hand-traced numbers, dates) — "fixed a bug" without the mechanism is not a useful comment.

Never write a comment that just restates what the code says.

## 6. Tooling — run before considering work done

```sh
npm run lint          # ESLint over src/ + tools/ (src/vendor/ excluded)
npm run lint:fix       # auto-fix what's fixable
npm run format         # Prettier --write over src/ + tools/
npm run format:check   # Prettier --check (what CI/verify uses)
npm run verify          # lint + format:check, the pre-flight combo
```

Config lives at repo root: `.eslintrc.json`, `.prettierrc.json`, `.prettierignore`. Both exclude `src/vendor/` and other reference/generated trees — they were never meant to touch those.

**No silent scope creep on rules.** If a lint rule is fighting a genuinely idiomatic pattern (this happened with `no-inner-declarations` flagging ordinary nested function declarations, and `eqeqeq` flagging the standard `== null` idiom — both reconfigured, not the code) fix the _rule config_ with a comment explaining why, don't sprinkle inline disables through the code. Inline `eslint-disable` comments are a last resort, not a first one, and should say why right there when used.

## 7. Doctrine reminders (from Keyhole.md, worth repeating here)

- Nothing is ever allocated at world resolution — enforced physically by `ThreeAllocator`'s law (`LAW_MAX_WORLD_RES_DIM`), not just documented.
- An absent feature fails loudly; it never silently routes to a fallback path.
- A per-frame effect's materials carry `markCompileDeferrable`, read the wind through the baked field (`baked: 'now'`), and stay inside their entry in `src/effects/__tests__/shader-budgets.json`. One synchronous 20 s shader compile kills the GPU process and every context on the page — see `src/GPU-SAFETY.md`.

## 8. Time — one pausing clock for everything that moves

The author, 2026-11-08: _"Everything should pause. Everything should use the same exact clock."_ When Foundry pauses, the
world eases to a stop over five seconds and back. That only works if every moving thing reads the **same** clock:

| You are writing…                                                                                                                                            | Read this                                                                                                                               | Never this                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| an effect, particle, shader animation, sim step, world model                                                                                                | `env.time.tMs` / `env.time.dtSec`, handed to you each frame (`uGlobalTimeMs` on the GPU side)                                           | `perfNowMs()`, `wallClockMs()`, `env.time.realMs` / `realDtSec`, `game.time.serverTime`, `Date.now()`, a `setTimeout`/`setInterval`/`requestAnimationFrame` of your own |
| something every client must see at the same instant (lightning strikes, moving tiles, Fade Engine fades, a hand tremor)                                     | `worldSimNowMs()` (`foundry/world-clock.js`) — server time that stands still while paused                                               | raw `game.time.serverTime`                                                                                                                                              |
| something that is **not** the world moving: a poll throttle, a bake throttle, load/compile timing, decode latency, the camera (Dynamic Range, parallax), UI | wall time (`env.time.realMs`, `perfNowMs()`) — and add your file to `WALL_TIME_BUDGETS` in `tools/verify-structure.mjs` with the reason | —                                                                                                                                                                       |

Both pausing clocks run off one record (the GM's pause ledger, `core/frame-clock.js#ledgerSimMs`) with one ramp
(`pauseRampScale`), so they can never disagree. **The build enforces this** (`time/world-on-sim-clock`): any wall-time read
in `src/effects/` or `src/world/`, any timer of their own there, wall time handed to a frame-loop `.sync/.step/.tick`, or one
more wall-time read than a file's budget fails `npm run verify:structure`. A throttle on the sim clock is the opposite bug
(it latches when paused) — throttles stay on wall time, by listing them.
