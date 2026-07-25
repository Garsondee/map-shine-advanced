/**
 * THE TRIPWIRE SUITE — architecture rules that FAIL THE BUILD.
 *
 * ============================================================================
 * WHY THIS FILE IS THE MOST IMPORTANT FILE IN THE REPO
 * ============================================================================
 *
 * The previous module died of ONE mechanism, observed independently at three
 * different layers (memory: `v2-postmortem-the-failure-modes`):
 *
 *   1. `EffectComposer.js` had the RIGHT effect-layering design, documented.
 *      → 5 importers. The god-object it lost to: 92.
 *   2. `legacy/foundry/` was the designated Foundry adapter.
 *      → 21 of 128 files complied. 16% coverage of its own job.
 *   3. `resolve-effect-enabled.js` says "every render pass gate MUST call this"
 *      → bypassed anyway.
 *
 * Three correct designs. Three losses. **Not because anyone was careless — the
 * author tried hard, and it is visible everywhere in that code. They lost
 * because they were OPTIONAL.** Bypassing structure is always cheaper *today*,
 * and "today" is when every line gets written.
 *
 * > **A comment cannot fail a build. This file can.**
 *
 * Author's standing directive (2026-07-16): *"I would rather this project was
 * too fussy about following rules than too lenient."* When in doubt, this file
 * says no.
 *
 * ---------------------------------------------------------------------------
 * HOW TO ADD A RULE (covenant rule 4, Skeleton.md §3)
 * When you fix a bug CLASS, add its tripwire here. That is the mechanism by
 * which "burn the failure into memory" becomes enforcement rather than
 * remembrance — memory informs a session that reads it; this stops one that
 * doesn't.
 *
 * HOW TO WEAKEN A RULE
 * Don't, casually. If a rule is genuinely wrong, say so in the commit with
 * `[structure-change]` and update the governing doc. Loud, never quiet — every
 * disaster in the autopsy was quiet.
 *
 * RATCHETS
 * Some rules the current tree already violates (boot.js wires Foundry hooks
 * directly; vt-pan-viewer.js is really the scene renderer). Those are ratcheted:
 * the current count is frozen in `tools/structure-ratchets.json`, an INCREASE
 * fails, and a DECREASE auto-tightens the bound. This suite never claims virtue
 * it does not have — it guarantees monotonic improvement, which is the honest
 * version of "rigid".
 *
 * Usage: `npm run verify` (or `node tools/verify-structure.mjs`)
 *        `node tools/verify-structure.mjs --update-ratchets` after a real cleanup.
 *
 * @module tools/verify-structure
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeReachability } from './reachability.mjs';

// fileURLToPath, not URL.pathname — the repo path contains spaces, which pathname
// percent-encodes into %20 and fs then cannot find. Found on this file's first run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const RATCHET_FILE = join(ROOT, 'tools', 'structure-ratchets.json');
const SIZE_BUDGET_FILE = join(ROOT, 'tools', 'size-budgets.json');
const UNIFORM_BUDGET_FILE = join(ROOT, 'tools', 'uniform-budgets.json');
const EFFECTS_DIR = join(SRC, 'effects');

/**
 * THE GOD-OBJECT CAP — the one V2 disease every other rule in this file left
 * uncovered, because every rule above polices COUPLING (imports, doors,
 * globals, renderer ownership) and none measures BULK. V2 died of two 10,000+
 * line files (FloorCompositor 10,063; token-movement 12,771) that no seam ever
 * forced to split — and on 2026-07-25 the audit found src/vt/vt-pan-viewer.js
 * already a 11,860-line file whose startVtPanViewer() is a single ~10,385-line
 * function, LARGER than FloorCompositor, and `npm run verify` was green through
 * all of it. A green gate with a god-object in the tree is the exact "the wall
 * didn't look here" failure this repo exists to prevent.
 *
 * No file may exceed `file` lines, and no top-level function may exceed `fn`
 * lines, UNLESS it is already over and registered in size-budgets.json — where
 * it is frozen at its recorded size and may only SHRINK (the no-silent-catch
 * ratchet, applied to bulk instead of a count). A NEW file/function crossing a
 * cap FAILS THE BUILD: split it, or register the debt consciously with
 * `npm run ratchets:update` (visible in the diff, never silent).
 *
 * The seeded number does not have to be precise — the same measurement is
 * compared against itself over time, so a rare few-line miscount from a brace
 * inside a string cannot break monotonicity, only shift an absolute already
 * thousands of lines from any cap.
 */
export const SIZE_CAPS = { file: 1000, fn: 500 };

/**
 * THE UNIFORM BUDGET — the same shrink-only ratchet as `SIZE_CAPS`, measuring
 * a different disease: V2's water shader alone declared 324 `uniform`s (46
 * of them provably inert while still shipping a live UI slider — a fully-
 * labelled "Bathymetry (Volumetric)" folder with ZERO implementing GLSL
 * behind it, `docs/planning/Water.md` §2). A file with hundreds of uniforms
 * is compiled for its maximal self forever and pays for every binding on
 * every pixel, whether or not the feature it drives is even on
 * (`tsl/no-uniform-gates` catches the FEATURE-GATE half of that disease;
 * this catches the RAW SCALE half — nothing stopped a single file from
 * growing to 324 of them one knob at a time).
 *
 * Scoped to `src/effects/` — "per effect module" (`docs/planning/Water.md`
 * §6.3), not the whole codebase: `src/vt/vt-pan-viewer.js` and `src/world/
 * wind-sim-gpu.js` have their own real uniform counts, but neither is a
 * single effect in the Effects.md sense, and the size ratchet already polices
 * their bulk. No file under `src/effects/` may exceed `UNIFORM_CAP` calls to
 * `uniform(`, UNLESS it is already over and registered in uniform-
 * budgets.json, frozen at its recorded count, shrink-only — same contract as
 * `SIZE_CAPS`, same escape hatch (`npm run ratchets:update`, loud in the
 * diff), same reason the seeded number does not need to be exact (a rare
 * miscount from a commented-out `uniform(` cannot break monotonicity, only
 * shift an absolute already tens of calls from the cap).
 */
export const UNIFORM_CAP = 40;
const SIZE_WHY =
  'V2 died of god-objects: FloorCompositor 10,063 lines, token-movement 12,771, FireEffectV2 6,861 — ' +
  'each grown one locally-rational addition at a time because no seam forced a split. Every other rule ' +
  'in this file polices coupling; none measured SIZE, so on 2026-07-25 vt-pan-viewer.js was a 11,860-line ' +
  'file / 10,385-line function (bigger than FloorCompositor) with the gate green throughout.';
const SIZE_INSTEAD =
  'Split it into a sibling module behind a clean signature (a builder that takes inputs and returns an ' +
  'object, a subsystem with its own file). If a large file is genuinely justified right now, register ' +
  'the debt: `npm run ratchets:update` records its size as a frozen, shrink-only budget — loud in the ' +
  'diff, and it can never grow again without another visible bump.';
const UNIFORM_WHY =
  "V2's water shader alone declared 324 uniforms — 46 of them provably inert while still shipping a " +
  'live UI slider, including a fully-labelled "Bathymetry (Volumetric)" folder with ZERO implementing ' +
  'GLSL behind it. A shader compiled for its maximal self pays for every binding on every pixel, ' +
  'whether or not the feature it drives is even on.';
const UNIFORM_INSTEAD =
  'Split the render module (a builder per concern — bloom/water already split colour vs body vs field). ' +
  'If a file genuinely needs this many uniforms right now, register the debt: `npm run ratchets:update` ' +
  'records its count as a frozen, shrink-only budget — loud in the diff, and it can never grow again ' +
  'without another visible bump.';

/**
 * The whole-graph reachability walk runs ONCE per `npm run verify`, memoized
 * here — `graph/reachable-from-boot`'s `scan` is called once PER FILE by the
 * main loop below, and re-walking the entire import graph 55+ times would be
 * needless work for an answer that does not change mid-scan.
 */
let _unreachableCache = null;
function unreachableFromBoot() {
  if (!_unreachableCache) _unreachableCache = new Set(computeReachability(ROOT).unreachable);
  return _unreachableCache;
}

/** Vendored third-party code is never ours to police. */
const IGNORED = [`${sep}vendor${sep}`, `${sep}__tests__${sep}`];

/** @returns {string[]} every .js/.mjs file under src/, excluding vendor + tests */
export function sourceFiles(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.(js|mjs)$/.test(full) && !IGNORED.some((i) => full.includes(i))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A rule. `pattern` is searched per line; a hit outside `allow` is a violation.
 *
 * @typedef {object} Rule
 * @property {string} id
 * @property {RegExp} pattern
 * @property {string[]} allow - path fragments where this IS permitted (the one door).
 * @property {string} why - the V2 corpse this defends against. Printed on failure.
 * @property {string} instead - what to do. Printed on failure.
 * @property {boolean} [ratchet] - if true, existing violations are tolerated but may not grow.
 */

/** @type {Rule[]} */
export const RULES = [
  // ===================================================================
  // PARTICLES — the author's ask, 2026-07-16. The single biggest sprawl
  // in V2: FIVE particle architectures, because the good one was optional.
  // ===================================================================
  {
    id: 'particles/one-engine',
    pattern: /\b(?:THREE\.)?(?:Sprite|Points)\s*\(|InstancedMesh|three\.quarks|BatchedRenderer/,
    allow: [`${sep}effects${sep}particles${sep}`],
    why:
      'V2 had FIVE particle architectures at once (quarks / Points / InstancedMesh / a Sprite PER ' +
      'PARTICLE in 8 files / per-particle JS callbacks in 11). Not because nobody built a good ' +
      'engine — somebody did — but because using it was optional. Sprite-per-particle means N ' +
      'particles = N scene objects = N draw calls.',
    instead:
      'Particles come from src/effects/particles/ and nowhere else. Declare a system with ' +
      'validateParticleSystem() (a declaration is data — it works today, months before the engine ' +
      'does). See docs/planning/Particles.md §7.',
  },

  // ===================================================================
  // PARTICLE MEMORY HAS ONE DOOR — the sibling of gpu/allocator-only, for
  // storage buffers instead of render targets. Built at ZERO with the arena
  // (Particles.md §10, §20), the cheapest moment, which does not come twice.
  // ===================================================================
  {
    id: 'particles/allocator-only',
    // instancedArray() IS particle-memory allocation; so is constructing a
    // Storage(Instanced)BufferAttribute. `Storage\w*BufferAttribute` catches
    // both StorageBufferAttribute and StorageInstancedBufferAttribute.
    pattern: /\binstancedArray\s*\(|new\s+(?:THREE\.)?\w*Storage\w*BufferAttribute\s*\(/,
    allow: [`${sep}effects${sep}particles${sep}`],
    why:
      'Particle state is GPU storage (instancedArray / Storage*BufferAttribute), and it has NO safe ' +
      'per-buffer dispose() — a StorageInstancedBufferAttribute inherits BufferAttribute, which cost a ' +
      'live WebGPU device-loss in ~30s when one was replaced per frame ' +
      '(reference_bufferattribute_no_dispose_trap). The particle arena allocates its whole budget ONCE ' +
      'and never frees, so there is no disposal to get wrong — but only if allocation has ONE door. ' +
      'graph/three-allocator.js guards render targets and NOT storage buffers, so without this wall ' +
      'particle memory has no ceiling and no owner: the exact O(world x floors x masks) sprawl Keyhole ' +
      '§1 died of, one resource class over.',
    instead:
      'Storage buffers come from src/effects/particles/particle-arena.js and nowhere else — it owns a ' +
      'fixed, sub-ranged pool (Particles.md §10). A system RESERVES a slot range; it never calls ' +
      'instancedArray itself. Need particle memory somewhere new? That is a conversation about the ' +
      "arena's budget, had in the open, not a buffer at the call site.",
  },

  // ===================================================================
  // THE GLOBAL BUS — 479 window.MapShine reaches from V2's effects, which is
  // how Lighting ended up reading Fire's private _glowBucketsByFloor.
  // ===================================================================
  {
    id: 'no-global-bus',
    // MapShine.debug is the sanctioned shop window (the debug panel). Never a hallway.
    pattern: /window\.MapShine(?!\.debug)|globalThis\.MapShine(?!\.debug)/,
    allow: [`${sep}boot.js`, `${sep}diag${sep}`],
    why:
      'V2 effects reached into window.MapShine 479 times — up into private fields ' +
      '(sceneComposer._sceneMaskCompositor, x27) and SIDEWAYS into other effects, which closed a ' +
      "CYCLE: Lighting read Fire's private _glowBucketsByFloor; Fire read Lighting's params. " +
      'Neither could be built, tested or ported without the other.',
    instead:
      'Declare what you need as a `reads` entry and receive it. If it is not declared you cannot ' +
      'touch it — there is nothing to reach with (Effects-API.md §5).',
    ratchet: true,
  },

  // ===================================================================
  // RENDERER STATE — 452 setRenderTarget calls across 60 FILES in V2.
  // Renderer state had sixty owners, i.e. none.
  // ===================================================================
  {
    id: 'renderer-state/graph-only',
    pattern: /\.setRenderTarget\s*\(|\.autoClear\s*=|\.setScissor\s*\(|\.setViewport\s*\(/,
    allow: [`${sep}graph${sep}`, `${sep}vt${sep}`, `${sep}diag${sep}`],
    why:
      'V2: 452 setRenderTarget sites across 60 files, 262 autoClear touches of a GLOBAL mutable ' +
      'boolean. Every module had to save/restore; any that forgot leaked into the next pass. This ' +
      'is the bug class that produces "it works unless you enable bloom, then shadows break" — ' +
      'unfixable at the call site, because the call site is not wrong.',
    instead:
      'The frame graph is the ONLY thing that touches the renderer. A pass declares reads/writes ' +
      'and is HANDED a target — enforcement by absence (Engine-Postmortem.md §3).',
    ratchet: true,
  },

  // ===================================================================
  // THE LAW, MADE NON-OPTIONAL — designed in Skeleton.md §2.3 and never
  // built. Keyhole is NAMED for this law and it was enforced by nothing:
  // ThreeAllocator had ZERO callers and would have thrown on its first
  // (`window.THREE unavailable`) if anyone had tried. Built at ZERO on
  // 2026-07-17 — the cheapest moment, which does not come twice.
  // ===================================================================
  {
    id: 'gpu/allocator-only',
    // `new X(Multiple)RenderTarget(s)(` in any form. A local named `renderTarget`
    // is a read, not an allocation, and must not trip — hence the `new`.
    pattern: /new\s+(?:THREE\.)?\w*RenderTargets?\s*\(/,
    allow: [`${sep}graph${sep}three-allocator.js`],
    why:
      'V2 allocated render targets at 126 sites across 35 FILES — 70 of them private, per-effect, ' +
      'and WORLD-RES. BuildingShadowsEffectV2 alone opened four (_strengthTarget, shadowTarget, ' +
      '_blurTarget, _sharpHoldTarget). That is the entire crash class measured in Keyhole.md §1: the ' +
      'compositor cost 470-580 MB per drawing-buffer megapixel and the card has ~1.6 GB. No budget ' +
      'policing survives a cost model of O(world x floors x masks); only making the allocation ' +
      'IMPOSSIBLE does. The allocator that enforces the >2048px cap existed, tested, with ZERO ' +
      "callers — the law was optional, and this repo's one-sentence finding is that an optional " +
      'law loses.',
    instead:
      'Render targets come from graph/three-allocator.js and nowhere else. It throws on any ' +
      'dimension > 2048px unless the descriptor explicitly says { allowWorldScale: true } — a crash ' +
      "in dev at YOUR call site with a stack, not a context loss in a player's session three weeks " +
      'later. The frame graph hands a pass its targets; a pass never allocates. (Keyhole.md §4.6)',
  },

  // ===================================================================
  // THE LAW'S OTHER HALF — a raw texture is how the world gets resident.
  // Also at ZERO outside vt/ on 2026-07-17.
  // ===================================================================
  {
    id: 'gpu/textures-in-vt-only',
    // Any `new <Something>Texture(`: Data/DataArray/Canvas/Video/Compressed and
    // plain Texture. `new THREE.TextureLoader()` must NOT trip (it is not an
    // allocation) — it does not, because `Texture` must be followed by `(`.
    // PIXI textures are deliberately out of scope: foundry/pixi-proxy-textures.js
    // exists precisely to hand PIXI a ≤1024px proxy, and that IS the fix (§4.3).
    pattern: /new\s+(?:THREE\.)?\w*Texture\s*\(/,
    // vt/ IS the paging system — creating textures is its whole job, and the
    // atlas is the ONE fixed >2048 allocation the plan sanctions (§4.1).
    allow: [`${sep}vt${sep}`],
    why:
      "Keyhole's one law is that nothing is ever allocated at world resolution — and the single " +
      "biggest measured offender was never a render target: it was ONE texture. Foundry's PIXI held " +
      '~719 MB of duplicate art including an 8250² LightCovers.webp costing 345 MB, plus a continuous ' +
      '6408x5121 texImage2D re-upload storm at 100-300 ms each (Keyhole.md §1, every crash report). ' +
      '`new THREE.Texture(sourceBitmap)` on a 12K map is one line, looks completely reasonable, and ' +
      'is the whole crisis.',
    instead:
      'World-sized image data pages through vt/ — it is the fixed-size cache the plan is named for ' +
      '(§4.1). Sample it via the shared vtSample() and nothing else. If you need pixels on the GPU ' +
      'and vt/ cannot give them to you, that is a conversation about vt/, not a texture at the call ' +
      'site. Screen-sized buffers are render targets: use the allocator (gpu/allocator-only).',
  },

  // ===================================================================
  // Y-FLIP — this project's oldest recurring bug class (V1, V2, and V3
  // again on 2026-07-17). Built at ZERO the same hour it bit.
  // ===================================================================
  {
    id: 'gpu/no-handrolled-fullscreen-quad',
    // A fullscreen quad is a PlaneGeometry whose extents are 2 (NDC-sized) —
    // `PlaneGeometry(2, 2)`. A normal world-space plane (a tile, a billboard)
    // is sized in world units and must NOT trip; `PlaneGeometry(2, 2)` is only
    // ever an attempt at a screen-filling surface.
    pattern: /new\s+(?:THREE\.)?PlaneGeometry\s*\(\s*2\s*,\s*2\s*[,)]/,
    allow: [],
    why:
      "Y-flips are this project's oldest recurring bug (memory: feedback_y_flip_recurring_risk — V1 " +
      'fought them constantly, V2 occasionally, V3 hit one on 2026-07-17). The cause is always the ' +
      'same: a hand-rolled mapping between two spaces that disagree about which way is up. THE ' +
      'SPECIFIC CORPSE: the present pass was written as `new Mesh(new PlaneGeometry(2,2))` and the ' +
      'entire map rendered upside down. PlaneGeometry puts v=0 at the screen BOTTOM; three ' +
      "normalises BOTH backends to 'v=0 is the TOP of a render-target texture' (isFlipY() is false " +
      'on WebGPU, true on WebGL — three.webgpu.js:56350/64344) and its OWN fullscreen geometry, ' +
      'QuadGeometry (three.webgpu.js:49443), puts v=0 at the TOP to match. A PlaneGeometry ' +
      'fullscreen quad is therefore exactly inverted — and BACKEND-DEPENDENTLY so, which is the one ' +
      'thing keyhole-webgpu-tsl-decision forbids ("ONE source per effect, never a WebGL2 twin").',
    instead:
      "Use `new THREE.QuadMesh(material)` and `quad.render(renderer)`. It bundles three's own " +
      'QuadGeometry AND its own camera, so the VENDOR owns the orientation convention on both ' +
      'backends — and they must get it right, because every three.js user would notice if they did ' +
      'not. Never add a compensating flip to make a hand-rolled quad look right: two flips that ' +
      'cancel is how you end up with four, and the next person cannot tell which one is load-bearing. ' +
      'Verify with the debug panel\'s "Orientation self-test", which reads REAL pixels through the ' +
      'REAL chain rather than trusting the eye on symmetric content.',
  },

  // ===================================================================
  // GPU READBACKS — the GPU is a write-only pipe, not a data structure.
  // ===================================================================
  {
    id: 'no-gpu-readback',
    pattern: /readRenderTargetPixels|\.readPixels\s*\(|gl\.finish\s*\(|\.getImageData\s*\(/,
    // vt/ is the DECODE path: its getImageData runs in the worker at decode time on
    // 256px pages — which is exactly what this rule PRESCRIBES as the fix, not the
    // runtime GPU stall it forbids. diag/ reads back for instruments, deliberately.
    allow: [`${sep}diag${sep}`, `${sep}vt${sep}`],
    why:
      'V2: 46 getImageData, 41 readRenderTargetPixels, 8 readPixels, 7 gl.finish() — each a full ' +
      'pipeline stall. The defining example reached through a global to read back ONE PIXEL. The ' +
      '8250x8250 getImageData cost 260MB of heap and a 550-850ms stall per load.',
    instead:
      'Per-page CPU extraction at DECODE time, in the worker (Keyhole.md §4.1) — the data is on ' +
      'the CPU before anyone asks. The GPU is deep-pipelined; asking it anything costs the pipeline.',
  },

  // ===================================================================
  // TSL's .mix() TRAP — cost a full session and produced 3 simultaneous bugs.
  // ===================================================================
  {
    id: 'tsl/no-mix-method',
    // Method form only. mix(...) and TSL.mix(...) are the correct FUNCTION forms
    // and must NOT trip. A custom test captures the receiver of each `.mix(`/
    // `.smoothstep(` and exempts one ending in TSL. (Regex lookbehind was fragile
    // for the dotted `THREE.TSL.mix` case; an explicit capture is unambiguous.)
    pattern: /\.\s*(?:mix|smoothstep)\s*\(/,
    test: (code) => {
      const re = /([\w.]*)\.\s*(?:mix|smoothstep)\s*\(/g;
      let m;
      while ((m = re.exec(code)) !== null) {
        if (!/(?:^|\.)TSL$/.test(m[1])) return true;
      }
      return false;
    },
    allow: [],
    why:
      "TSL's .mix() METHOD takes its RECEIVER as the interpolant: three.js defines " +
      '`mixElement = (t, e1, e2) => mix(e1, e2, t)`, so `a.mix(b, t)` compiles to `mix(b, t, a)` — ' +
      'silently, no type error. This blacked out the entire map for a session ' +
      '(uUnoccludedAlpha.mix(uOccludedAlpha, occ) reads as mix(1,0,0)==1 and compiled to ' +
      'mix(0,occ,1)==0, so alpha was multiplied by ZERO) while every printed uniform looked correct.',
    instead:
      'ALWAYS the function form: mix(a, b, t). It reads the way it behaves. ' +
      '(memory: reference_tsl_method_chaining_trap)',
  },

  // ===================================================================
  // UNIFORM GATING — "off" that still costs. V2 did this 117 times.
  // ===================================================================
  {
    id: 'tsl/no-uniform-gates',
    pattern:
      /\buniform\s*\(\s*(?:float\s*\(\s*)?[01]\s*\)?\s*\)?\s*[,;]?\s*\/\/\s*(?:enable|toggle)|u(?:Enable|Use|Has)[A-Z]\w*/,
    allow: [],
    why:
      'V2 had 117 distinct uniform-gated shader branches (uEnable*/uUse*/uHas*). A uniform set to ' +
      'zero does NOT remove work — it executes every pixel and pays for its bindings. The shader ' +
      'compiles for its maximal self and every machine pays forever.',
    instead:
      'Tier selection is a JS `if` at graph-build time — the nodes are never constructed. TSL If()/' +
      'Loop() are RUNTIME branches, only for per-pixel data-dependent decisions. The test: if ' +
      'turning it off does not SHRINK the compiled shader, it is not off (Effects.md Law 4).',
  },

  // ===================================================================
  // SILENT FAILURE — 2,670 empty catch blocks. One per ~140 lines.
  // The worst number in the entire autopsy.
  // ===================================================================
  {
    id: 'no-silent-catch',
    pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    allow: [],
    why:
      'V2 had 2,670 EMPTY CATCH BLOCKS — one silent error-swallow per ~140 lines. It did not merely ' +
      'fail to report; it INDUSTRIALISED not-knowing. That is why the rot stayed invisible until it ' +
      'crashed. (I hit this personally: a whole diagnostic eaten by one bare catch, which looked ' +
      'exactly like code that never ran.)',
    instead:
      'Handle it, or report it with a reason. Every skip/drop/early-return states WHY and WHICH. ' +
      '`skipped: []` must mean "nothing was skipped", never "I did not look". ' +
      '(memory: feedback_instruments_must_not_lie)',
    // Ratcheted: 35 pre-existing empties in harvested vt/graph code + early boot/diag.
    // Frozen here so NEW ones fail the build; the backlog is a separate cleanup task.
    ratchet: true,
  },

  // ===================================================================
  // THE FOUNDRY ADAPTER — V2's adapter covered 16% of its own job.
  // 128 files touched Foundry; 21 were in legacy/foundry/.
  // ===================================================================
  {
    id: 'foundry/adapter-only',
    pattern:
      /\bcanvas\.(?:scene|stage|app|dimensions|environment|tokens|tiles|walls|lighting|perception)\b|\bgame\.(?:user|settings|scenes|system|socket)\b|\bHooks\.(?:on|once|call)/,
    allow: [`${sep}foundry${sep}`, `${sep}diag${sep}`],
    why:
      'V2 designated legacy/foundry/ as THE Foundry adapter -- exactly as Keyhole 9.1 does -- and 107 ' +
      'of 128 files that touch Foundry globals reached around it (16% coverage). Plus 98 direct ' +
      '.prototype.x = monkey-patches vs 2 libWrapper registrations: a drift bomb at call sites nobody ' +
      'remembers writing. The adapter existed and LOST -- the second independent proof that optional ' +
      'structure loses.',
    instead:
      'All Foundry access goes through src/foundry/. It is a LEAF: version-gated, fail-loud, and it ' +
      'imports nothing above itself (V2 inverted this -- canvas-replacement.js imported concrete ' +
      'effect classes by name).',
    ratchet: true,
  },

  // ===================================================================
  // ONE LOG DOOR — core/log.js had 3 importers and 61 direct console.*
  // calls standing against it (2026-07-17). The fourth independent proof
  // that a good abstraction loses when following it is optional.
  // ===================================================================
  {
    id: 'log/one-door',
    // `console.table`/`group` etc. are included deliberately: they are how a
    // "just this once, it's only a diagnostic" bypass gets its foot in the door,
    // and a diagnostic that never reaches the flight recorder is precisely the
    // one nobody can read back after the bug.
    pattern: /\bconsole\.(?:log|warn|error|info|debug|trace|table|dir|group|groupEnd|groupCollapsed|assert)\s*\(/,
    // Two doors, and only two. `core/log.js` IS the logger. `flight-recorder.js`
    // PATCHES console to catch foreign traffic, so it cannot be forbidden from
    // naming it. Nothing else in src/ — including the rest of diag/ — has a
    // reason to talk to the console directly instead of through the logger that
    // records what it says.
    allow: [`${sep}core${sep}log.js`, `${sep}diag${sep}flight-recorder.js`],
    why:
      'core/log.js shipped a clean scoped-logger API and won 3 importers. Against it: 61 direct ' +
      'console.* calls, 22 in boot.js alone. That is EffectComposer (5 vs 92), legacy/foundry/ (16% ' +
      'of its own job) and resolve-effect-enabled.js ("every gate MUST call this") for the FOURTH ' +
      'time — the same mechanism, not carelessness: bypassing is cheaper today, and today is when ' +
      'every line gets written. The cost is not tidiness. Console output cannot be exported, so ' +
      'every bypassed line is a line missing from the flight recorder bundle the author presses ONE ' +
      'BUTTON to get — i.e. missing from the story of the bug being reported.',
    instead:
      "Use core/log.js: `import { createLogger } from '../core/log.js'` then `const log = " +
      "createLogger('my-subsystem')`. It prints to the console exactly as before AND records to the " +
      'flight recorder as structure (level, subsystem, data). The print level and the record level ' +
      'are different dials, so log.debug() is free to be verbose: it stays out of the console and ' +
      'still lands in the export.',
    // Ratcheted: vt-pan-viewer.js (14 — the 2,318-line file a standing decision
    // says not to touch), foundry/canvas-compositing.js, diag/soak.js,
    // diag/debug-panel.js, vt/decode-pool.js, diag/render-fallback.js. Frozen so
    // NEW ones fail the build; the backlog shrinks when those files are next
    // opened for real reasons.
    ratchet: true,
  },

  // ===================================================================
  // ONE CLOCK — time.js declared itself the single source of truth
  // ("ALL EFFECTS MUST USE THIS") and Water alone sampled time 8 times.
  // ===================================================================
  {
    id: 'time/one-clock',
    pattern: /performance\.now\s*\(|\bDate\.now\s*\(/,
    allow: [`${sep}diag${sep}`, `${sep}core${sep}frame-clock.js`],
    why:
      'V2 core/time.js declared itself "the single source of truth for time" and said in its own ' +
      'docstring: "CRITICAL: ALL EFFECTS MUST USE THIS TIME SYSTEM. Never use performance.now() or ' +
      'Date.now() directly in effects." Comment-MUST #4 of 7. WaterEffectV2 sampled time 8 ' +
      'independent times anyway. Independent clocks desync animations that must agree.',
    instead:
      'Time is an INPUT: the frame snapshot (env.time / dt), handed to you. Never sampled privately. ' +
      '(docs/planning/Environment.md)',
    ratchet: true,
  },

  // ===================================================================
  // ONE DARKNESS — V2 round-tripped it THROUGH Foundry's scene document:
  // MSA computed it, pushed it in, and 28 files read it back out. A
  // feedback bus. Two months of dated scars over one float.
  // Currently ZERO occurrences in src/ -- a free wall, built before the room.
  // ===================================================================
  {
    id: 'env/one-darkness',
    pattern: /darknessLevel/,
    allow: [`${sep}foundry${sep}`, `${sep}world${sep}environment.js`],
    why:
      'V2 computed darkness from time+weather, pushed it into canvas.environment, and 28 files -- ' +
      'including 8 effects -- READ IT BACK. Subsystems talking to each other through the game ' +
      'document, a bus Foundry, the GM slider and other modules also write. msa-v2-darkness.js reads ' +
      'like tombstones: grey canvas (2026-03, three stacking writers), the V14 getter trap (2026-05, ' +
      'silent-fail assignment made night SNAP to day), darkness-gated lights (2026-05).',
    instead:
      'Darkness gets ONE direction of authority: an input we read, OR a value we own and never read ' +
      'back. A read-back of your own write through a shared document is a feedback bus. ' +
      '(docs/planning/Environment.md 2.2)',
  },

  // ===================================================================
  // ONE SUN — V2 computed sun-from-time in 8+ places, so shadows and
  // specular could disagree about the sky BY CONSTRUCTION.
  // ===================================================================
  {
    id: 'env/one-sun',
    pattern: /\b(?:sunAzimuth|sunElevation|sunDirection|solarAngle|computeSunAngle)\b/,
    allow: [`${sep}world${sep}environment.js`, `${sep}world${sep}sun.js`],
    why:
      'V2 derived sun-from-time in at least 8 places (the shadow system had its own SunDirection.js; ' +
      'time.js, ThreeLightSource, inline effect math), and 15 files held sun state. Shadows pointing ' +
      'one way while specular answers to a different sky is then a CONSTRUCTION, not a bug. Derived ' +
      'N times = N-1 needless chances to disagree (feedback_probed_constants_vs_derived, mild form).',
    instead:
      'One pure sun function with Node tests asserting dawn/noon/dusk. Consumers read env.sun. ' +
      '(docs/planning/Environment.md 2.1)',
  },

  // ===================================================================
  // ONE TIME-OF-DAY — Environment.md §3 has specified this tripwire since
  // the audit ("`timeOfDay` defined in exactly one module"). It could not
  // be built until a real day clock existed; it does now (2026-07-23,
  // world/day-clock.js), so per covenant rule 4 the wall goes up WITH it.
  //
  // V2's clock lived INSIDE the weather controller
  // (WeatherController.js:184, `this.timeOfDay = 12.0`) and TWENTY files
  // ended up holding their own notion of the hour. Every one of them was
  // added by someone reasonable who needed the hour and had no wall telling
  // them where it lived.
  // ===================================================================
  {
    id: 'time/one-tod',
    // THIS BANS *KEEPING* A TIME OF DAY, NOT NAMING OR FORWARDING ONE.
    //
    // A first cut also matched `todHour:` object keys and `const todHour =`,
    // and immediately fired on two lines that are the system working exactly as
    // designed — `buildEnvSnapshot({ todHour })` forwarding the day clock's
    // output, and a diagnostic reading `env.time.todHour` straight back off the
    // snapshot. Forwarding a value you were handed is the OPPOSITE of the
    // failure; banning it would have pushed callers into obfuscating the name,
    // which makes the concept harder to find, not easier.
    //
    // What V2 actually did was STORE one: `this.timeOfDay = 12.0`
    // (WeatherController.js:184), twenty times over. So the pattern matches a
    // MUTABLE declaration (`let`/`var`) or an assignment to a PROPERTY — the
    // two shapes that mean "this object now carries its own hour". A `const`
    // local naming a value in flight cannot drift and is left alone.
    pattern: /\b(?:let|var)\s+(?:todHour|timeOfDay)\b|\.(?:todHour|timeOfDay)\s*=(?!=)/,
    allow: [
      `${sep}world${sep}sun.js`,
      `${sep}world${sep}environment.js`,
      `${sep}world${sep}day-clock.js`,
      `${sep}foundry${sep}game-time.js`,
      `${sep}ui${sep}astrolabe.js`,
      `${sep}diag${sep}`,
    ],
    why:
      "V2's clock lived inside the weather controller, so time was a FIELD OF weather and the two " +
      'systems that should have composed were hierarchically entangled. Twenty files grew their own ' +
      'time-of-day and eight grew their own sun; a scene could have shadows answering to one hour ' +
      'while the grade answered to another. (docs/planning/Environment.md §0.1)',
    instead:
      'ONE owner (world/day-clock.js) moves the hour; world/sun.js is a pure function OF it; every ' +
      'other consumer READS `env.time.todHour` off the frame snapshot it was handed. If you need the ' +
      'hour, take it as an input — never keep your own.',
  },

  // ===================================================================
  // ONE ATMOSPHERE — V2 made the weather/time-of-day LOOK with a
  // full-screen colour corrector, and paid for it twice (both documented
  // in its own params reference, docs/reference/v2-effect-params/):
  //
  //   - the outdoor-only gate had to be bolted INSIDE the colourist,
  //     because a full-screen grade is global by nature;
  //   - it needed a WHOLE SECOND SYSTEM, the "Local ToD override", to
  //     cancel its own midnight tint inside torch pools. The same
  //     compensator shape as DynamicLightShadowLift.js — and the
  //     compensator was the cost of grading AFTER lighting.
  //
  // Built WITH the sky light (2026-07-23), per covenant rule 4.
  // ===================================================================
  {
    id: 'sky/one-atmosphere',
    // Atmosphere terms as OWNED state. Same discipline as `time/one-tod`: this
    // bans DECLARING an atmosphere knob, never reading `skyHandle.veil` or
    // passing one along. A saturation/desaturation uniform is included on
    // purpose — reaching for one is the exact move docs/planning/Sky.md §5
    // exists to prevent (a multiply cannot desaturate; the additive veil is
    // what does), and it belongs to `post.grade`'s creative stack if anywhere.
    pattern:
      /\b(?:let|var|const)\s+(?:skyTint|atmosphereStrength|veilStrength|todGrade|weatherGrade|saturationAmount)\b|\.(?:skyTint|atmosphereStrength|veilStrength|todGrade|weatherGrade)\s*=(?!=)/,
    // THREE homes, each named on purpose:
    //   sky-access.js               — DERIVES the atmosphere (the one owner).
    //   lighting/environmental-light.js — APPLIES it, and is the only pass that
    //     may: it owns `buf:scene.illum`'s fill and the composite's gamma-space
    //     add, which are the two channels the sky light writes to. Naming it
    //     here is the point — the wall's job is to keep the application site
    //     SINGULAR, and a second pass reaching for these names is exactly the
    //     drift to catch.
    //   grade/                      — the creative LOOK, a different job (§7).
    allow: [
      `${sep}effects${sep}sky-access.js`,
      `${sep}effects${sep}lighting${sep}environmental-light.js`,
      `${sep}effects${sep}grade${sep}`,
    ],
    why:
      'V2 built the weather/time-of-day look as a full-screen colour correction, so the outdoor-only ' +
      'gate had to be taught to the colourist ("offsets on sky-eligible outdoor pixels... Requires ' +
      '_Outdoors"), and a whole second system — the "Local ToD override" — existed purely to CANCEL ' +
      'that grade inside lit pools, because a torch pool should not be blue at midnight. An entire ' +
      'module to undo another module is the same corpse as DynamicLightShadowLift.js.',
    instead:
      'Atmosphere COLOUR comes from the LIGHT: effects/sky-access.js produces one multiplier, mask-gated ' +
      'at the point of use, so indoors needs no special case and a torch needs no cancellation. ' +
      'Atmosphere CHROMA/TONE (desaturation, contrast) comes from the grade — a light cannot drain ' +
      'chroma. A creative LOOK is a third job, also the grade. (docs/planning/Sky.md, Grade.md)',
  },

  // ===================================================================
  // ONE GRADE STACK — V2 had 112 grade uniforms across THREE parallel
  // families (uCc*, uContext*, uAtmosphere*), each independently doing
  // exposure/contrast/saturation/tint/gamma, plus the same knobs bleeding
  // into water, foam, fog and distortion. Three colourists undoing each
  // other. Built WITH the grade engine (2026-07-23), per covenant rule 4.
  // ===================================================================
  {
    id: 'grade/one-stack',
    // Bans a SECOND grade system reforming — the V2 uniform FAMILIES (`uCc`,
    // `uContext`, `uAtmosphere`/`uAtmo`, `uGrade`) and any owned `*Grade` /
    // `*Desaturation` identifier. NOT the common words exposure/contrast/
    // saturation themselves: those are the grade primitive's own PARAMS
    // (`applyGrade({exposure, contrast, …})`) and appear as destructures and
    // function args all over legitimately — banning them would push callers to
    // obfuscate, the same lesson `time/one-tod` learned. What is unambiguous is
    // a grade-FAMILY uniform or a var literally named `…Grade`: those mean "a
    // second grade engine is growing here", which is the disease.
    //
    // The property-assignment arm (`.…Grade =`) excludes a `set`-prefixed
    // method — `MapShine.setGrade = fn`/`gradePresent.setEnvGrade = …` are the
    // effect's public WRITE API (the same shape as `MapShine.setBloom`), NOT a
    // `this.todGrade = …` stage-state assignment (V2's actual disease). A
    // grade-stage noun never starts with "set"; a setter always does.
    pattern:
      /\bu(?:Cc|Context|Atmosphere|Atmo|Grade)[A-Z]\w*|\b(?:let|var|const)\s+\w*(?:Grade|Desaturation)\b|\.(?!set)\w*Grade\s*=(?!=)/,
    // effects/grade/ DERIVES + APPLIES the grade (the one owner). diag/ is
    // tooling. A `const envGrade =` in the viewer/boot that FORWARDS a resolved
    // grade is fine — it is not a `*Grade` DECLARATION of owned knobs, it is a
    // value in flight — but to keep the rule simple the two seam files that
    // forward it are named rather than relying on the reader to see the
    // difference.
    allow: [`${sep}effects${sep}grade${sep}`, `${sep}diag${sep}`],
    why:
      'V2 had 112 distinct grade uniforms across three parallel families (uCc*, uContext*, ' +
      'uAtmosphere*), each re-implementing exposure/contrast/saturation/tint/gamma and re-tweaking to ' +
      'undo the others, with the knobs then bleeding into water/foam/fog/distortion. The same ' +
      '"seven homes per value" disease as weather, in the colour domain.',
    instead:
      'ONE grade primitive (effects/grade/grade-ops.js#applyGrade), applied at two SCOPES (environmental ' +
      'f(env), artistic authored). Every "CC" is that function with different DATA — never a new uniform ' +
      'family, never a `*Grade` knob grown in an effect. (docs/planning/Grade.md)',
  },

  // ===================================================================
  // SHADOW IS NOT PAINT — the one wrong noun that caused the whole
  // light/shadow war. These identifiers are its fossils.
  // ===================================================================
  {
    id: 'shadow/no-lift-no-combine',
    // (?!\(DELETED allows passes.js to name the dead module in its obituary line.
    pattern: /shadowLift|ShadowLift(?!\(DELETED)|tCombinedShadow|uDynamicLightShadowOverride|ShadowOverrideStrength/,
    allow: [],
    why:
      'V2 modeled shadow as a THING (dark paint composited onto the scene). Shadow is the ABSENCE OF ' +
      'A SPECIFIC LIGHT. That one wrong noun forced tCombinedShadow (ONE factor for ALL lights) and ' +
      'then DynamicLightShadowLift.js -- an entire module for un-darkening shadows near lights by a ' +
      'global hand-tuned 0.7, so a candle and a floodlight punch through identically. The lift is the ' +
      'exact cost of the wrong noun: because shadow darkened everything, an inverse system had to ' +
      'exist to protect lights from it.',
    instead:
      'illum = skyAmbient*skyVis + SUM(light_i * visibility_i). Every light carries its OWN ' +
      'visibility term; shadow modulates its own light and nothing else. Then no lift can be needed. ' +
      '(docs/planning/Light-and-Shadow.md)',
  },

  // ===================================================================
  // THE UI IS GENERATED — getControlSchema() existed in 48 effects and
  // tweakpane-manager referenced it ZERO times, hand-writing 11,157 lines.
  // ===================================================================
  {
    id: 'ui/no-handwritten-controls',
    pattern: /\.addBinding\s*\(|\.addInput\s*\(|\.addFolder\s*\(|\.addBlade\s*\(|new Tweakpane|from ['"]tweakpane/,
    allow: [`${sep}ui${sep}renderers${sep}`],
    why:
      'V2 had a GOOD declarative control system -- static getControlSchema() in 48 effect files, ' +
      "carrying params AND help text AND a per-control glossary in the author's own voice. " +
      'tweakpane-manager.js referenced it ZERO times and hand-wrote every folder for 11,157 lines. ' +
      'Bypass #7 of 7. Result: 58,603 lines of UI around 266 Tweakpane calls (~220 lines of plumbing ' +
      'PER CONTROL) across 3 surfaces held together by ~140 hand-written sync functions.',
    instead:
      'The UI is GENERATED from the params schema. Declare params on the effect; ui/renderers/ renders ' +
      'them (Tweakpane for the dev pane, ApplicationV2 for player settings). Two renderers, one ' +
      'schema, zero mirrors -- and a new effect gets a UI for free. (docs/planning/UI.md)',
  },

  // ===================================================================
  // ONE RESIDENCY WRITER — the same disease as every rule in this file, at
  // function scope. `scheduleResidencyUpdate()` existed, was correct, and was
  // OPTIONAL: six call sites invoked `updateResidency()` directly and bypassed
  // its in-flight guard. That function mutates shared per-pack state across
  // awaits, so two concurrent runs interleave on `pack.residentViewKeys` and
  // whichever assigns last orphans every page the other pinned — pinned
  // forever, tracked by nobody. Proven live, not theorised: the author's own
  // thrash report showed pinnedView 1536 (the exact cap) at halfSpan 6705,
  // fully zoomed OUT, where the view tier should be near empty.
  // ===================================================================
  {
    id: 'vt/residency-one-writer',
    pattern: /__never__/, // file-level rule; see `scan`
    scan: (rel, lines) => {
      const norm = rel.replace(/\\/g, '/');
      if (!norm.endsWith('src/vt/vt-pan-viewer.js')) return [];
      const calls = [];
      lines.forEach((text, i) => {
        const t = text.trim();
        if (t.startsWith('*') || t.startsWith('//')) return;
        if (!/updateResidencyUnguarded\s*\(/.test(text)) return;
        if (/function\s+updateResidencyUnguarded\s*\(/.test(text)) return; // the declaration itself
        calls.push({ line: i + 1, text: t.slice(0, 100) });
      });
      // Exactly one legal call site: scheduleResidencyUpdate's own do-while.
      // A second is, by construction, a caller going around the guard.
      return calls.length <= 1 ? [] : calls;
    },
    allow: [],
    why:
      'scheduleResidencyUpdate() was correct and OPTIONAL, so six call sites went around it — the ' +
      'exact shape of every V2 bypass in this file, one scope down. updateResidencyUnguarded mutates ' +
      "shared per-pack state ACROSS AWAITS; two concurrent runs orphan each other's view pins (live " +
      'evidence: pinnedView pegged at its 1536 cap while fully zoomed OUT, where it should be ~empty).',
    instead:
      'Call scheduleResidencyUpdate(). It coalesces rather than drops — a request arriving mid-pass ' +
      'sets residencyDirty and the in-flight run loops again, so the LAST state always wins and exactly ' +
      'one pass touches shared state at a time. If you need the pass to have COMPLETED, note it already ' +
      'runs inline (and the await resolves after it) whenever no pass is in flight.',
  },

  // ===================================================================
  // ONE DOOR PER ZONE — deep cross-zone imports are the module-scale version
  // of reaching into another object's privates. V2: 27 reaches into
  // sceneComposer._sceneMaskCompositor alone; nothing was unimportable, so
  // everything got imported. (Skeleton.md §2.1)
  // ===================================================================
  {
    id: 'zones/one-door',
    pattern: /__never__/, // file-level rule; see `scan`
    scan: (rel, lines) => {
      // Which zones require a door. core/ and diag/ are exempt AS TARGETS:
      // core is the standard library (its files are individually public) and
      // diag is tooling. Tests are exempt entirely (scanner skips __tests__).
      const DOOR_ZONES = ['vt', 'graph', 'scene', 'foundry', 'gameplay', 'effects', 'world', 'ui'];
      const norm = rel.replace(/\\/g, '/');
      const srcDir = norm.split('/').slice(0, -1).join('/');
      const zoneOf = (p) => {
        const m = p.match(/^src\/([^/]+)\//);
        return m ? m[1] : 'root';
      };
      const sourceZone = zoneOf(norm + (norm.endsWith('.js') && !norm.includes('/', 4) ? '/' : ''));
      const out = [];
      lines.forEach((text, i) => {
        const t = text.trim();
        if (t.startsWith('*') || t.startsWith('//')) return;
        const m = text.match(/from\s+['"](\.[^'"]+)['"]/) || text.match(/import\(\s*['"](\.[^'"]+)['"]/);
        if (!m) return;
        // resolve the relative specifier against the importing file's dir
        const parts = (srcDir + '/' + m[1]).split('/');
        const stack = [];
        for (const seg of parts) {
          if (seg === '' || seg === '.') continue;
          if (seg === '..') stack.pop();
          else stack.push(seg);
        }
        const target = stack.join('/');
        const targetZone = zoneOf(target + '/');
        if (targetZone === sourceZone || !DOOR_ZONES.includes(targetZone)) return;
        if (target === `src/${targetZone}/index.js`) return; // through the door: fine
        out.push({ line: i + 1, text: t.slice(0, 100) });
      });
      return out;
    },
    allow: [],
    why:
      'Reaching past a zone boundary into its internals is how V2 effects consumed ' +
      "sceneComposer._sceneMaskCompositor (x27) and each other's private fields. Nothing was " +
      'unimportable, so under deadline pressure everything got imported. One public door per zone ' +
      '(its index.js) makes reach-into-privates UNIMPORTABLE at module scale.',
    instead:
      "Import the zone's index.js (its ONE door). If what you need is not exported there, that is a " +
      "conversation about the zone's public API — have it in the open, in the door file, not by " +
      'reaching around it.',
    ratchet: true,
  },

  // ===================================================================
  // REACHABILITY FROM boot.js — built + built AGAIN and STILL walled by
  // nothing, discovered 2026-07-17 the same session the wall itself got fixed.
  // Every other rule here asks "is this line ALLOWED here". None of them ask
  // "does anything ACTUALLY GET HERE" — and that gap let 28 of 52 src/ files
  // (4,778 lines), including the entire graph/ zone and Keyhole's own >2048px
  // LAW, sit fully wired, fully tested, and fully disconnected at once.
  // ===================================================================
  {
    id: 'graph/reachable-from-boot',
    pattern: /__never__/, // whole-graph rule; see `scan`
    scan: (rel) => {
      const norm = rel.replace(/\\/g, '/');
      if (norm === 'src/boot.js') return []; // the root itself is trivially reachable
      return unreachableFromBoot().has(norm)
        ? [{ line: 1, text: '(unreachable — nothing under src/boot.js imports this file, even transitively)' }]
        : [];
    },
    allow: [],
    why:
      "V2's EffectComposer had the right layer model, documented, and 5 importers — the god-object " +
      'it lost to had 92. Here in 2026-07-17: src/graph/ (2,225 lines, 195 assertions, "npm run ' +
      'verify" green throughout) had ZERO real importers, including ThreeAllocator — the module ' +
      'Keyhole is NAMED for (Keyhole.md 4.6, "nothing is ever allocated at world resolution"). A ' +
      "wall built before the room it governs exists is correct strategy (this repo's own doctrine); " +
      'a wall left unconnected indefinitely, with every test staying green regardless, is the exact ' +
      'failure this repo exists to prevent, one level up. This rule is the missing question: not ' +
      '"is this code ALLOWED to exist here" but "is anything ACTUALLY USING it".',
    instead:
      'Wire the file into something boot.js reaches — through its zone door (zones/one-door), same ' +
      'session as the code lands, never left for later. If it is deliberately not ready yet, that is ' +
      "what 'seam'/'future' status in graph/passes.js is FOR (memory: " +
      'feedback_walls_must_be_passable_and_wired) — a declared, honest gap, not a silent one. This ' +
      "ratchet freezes today's real debt (shrink-only, same mechanism as the 7 ratchets above it) — " +
      'it does not demand zero, it demands the gap never grows without someone noticing.',
    ratchet: true,
  },

  // ===================================================================
  // PARAMS HAVE ONE OWNER — the LAST named V2 disease to get a wall, and the
  // only one that stayed unwalled purely because "correct" was undesigned.
  // ===================================================================
  {
    id: 'params/one-owner',
    // Assignment to a params member. Reads are fine and expected; the WRITE is
    // the disease. `paramsSchema`/`PARAMS` declarations are not writes.
    pattern: /\.params\.[a-zA-Z_]\w*\s*=[^=]|\.params\[[^\]]+\]\s*=[^=]/,
    allow: [`${sep}core${sep}params-schema.js`, `${sep}core${sep}params-service.js`],
    why:
      'V2 had 938 param keys written from 119 sites OUTSIDE effects/ by six subsystems — including ' +
      "HealthEvaluatorService, i.e. DIAGNOSTICS mutating product state. Worse, the effect's own write " +
      'path (applyParamChange) sat INCHES BELOW its own getControlSchema() in the same file and never ' +
      'read it: `this.params[id] = value` with no type check and no clamp, and a SILENT return on an ' +
      'unknown key. That is why control-state-sanitize.js exists — 333 lines repairing values at the ' +
      'DISK boundary, hand-writing constraints a third time because it never read the schema either.',
    instead:
      'Params flow through ONE owner. Declare them (core/params-schema.js: validateParamsSchema), and ' +
      'let the service validate at the WRITE — validateParamValue rejects wrong types, clamps out-of-range ' +
      'VISIBLY, and errors on unknown keys. Then nothing invalid can be stored, so nothing needs ' +
      'repairing on load. (docs/planning/Params.md)',
    ratchet: true,
  },

  // ===================================================================
  // THE QUARANTINE — src/ never imports legacy/. (Keyhole.md §5)
  // ===================================================================
  {
    id: 'quarantine/no-legacy-imports',
    pattern: /from\s+['"][^'"]*legacy\/|import\s*\(\s*['"][^'"]*legacy\//,
    allow: [],
    why:
      'legacy/ is frozen and quarantined. It is a reference library and a parts donor, not a ' +
      'runtime. One import across that boundary and V2 is alive again inside V3.',
    instead: 'Harvest by `git mv` into src/ + fix imports, in one commit. Never a cross-boundary import.',
  },

  // ===================================================================
  // MASKS HAVE ONE AUTHORITY — suffix/file-convention knowledge lives in
  // scene/mask-catalog.js and NOWHERE else. (Built 2026-07-17 with the mask
  // authority; the wall and the room land in the same commit, at zero.)
  // ===================================================================
  {
    id: 'masks/authority-only',
    // A mask file suffix appearing in CODE (comments are stripped by the
    // scanner): quoted, template-interpolated, or inside a longer filename
    // literal alike. The trailing (?![a-zA-Z]) keeps identifier substrings out
    // (`_Firebase`) while still catching V2's own `_Outdoors_0` per-level hack.
    // The list deliberately RESERVES the not-yet-declared V2 suffixes too
    // (Roughness/Normal/…): the day an effect needs one, its declaration goes
    // in the catalog — one line — or this wall stops the build.
    pattern:
      /_(?:Outdoors|Shadow|Fire|Specular|Window|Windows|Structural|Tree|Bush|Water|Roughness|Normal|Iridescence|Prism|Fluid|Dust|Ash)(?![a-zA-Z])/,
    allow: [`${sep}scene${sep}mask-catalog.js`],
    why:
      'V2 held the mask-suffix convention in THREE independent copies — assets/loader.js EFFECT_MASKS ' +
      "(with a hardcoded '_Outdoors_0'/'_1' per-level hack), masks/mask-catalog.js (synced to the " +
      'loader BY COMMENT), and per-effect literals — then fanned results out through 12 hand-listed ' +
      '?.setOutdoorsMask?.() pushes, with TWO mask services running in parallel "during rollout", ' +
      'forever (module-loading-investigation.md). Copyable knowledge drifted; the drift needed a ' +
      '4,092-line compositor to reconcile.',
    instead:
      'Import MASK_KINDS / maskKindById / assembleLayerDescriptors from scene/index.js (the catalog ' +
      'is the one legal home of suffix knowledge), and serve/consume masks through the mask ' +
      'authority (scene/mask-authority.js). Adding a mask kind is ONE catalog entry.',
  },

  // ===================================================================
  // WIND HAS ONE HANDLE — the field's inputs are assembled in world/ and
  // NOWHERE else. (Built 2026-07-23 with world/wind-access.js; the wall and
  // the room land in the same commit, at zero — the masks/authority-only
  // precedent directly above.)
  // ===================================================================
  {
    id: 'wind/handle-only',
    // The BAKED inputs `sampleWind` needs. Naming one outside world/ means
    // somebody is hand-assembling the field again — which is the mechanism,
    // not the symptom: every wind-access bug this project has had was a
    // hand-assembly that forgot, froze, or diverged from an input, never a
    // wrong formula. `(?![a-zA-Z])` keeps longer identifiers out (a future
    // `bakedFieldCache` is a different thing and should say so).
    //
    // `ambientWind` is DELIBERATELY NOT in this list, and the rule fired on its
    // own birth commit to establish that: the composition root must hand the
    // live direction/speed uniforms to `createWindHandle` itself (it owns
    // them), and Tier 2's sim materials — part of the wind system rather than a
    // consumer of it — take the same pair. More to the point, none of the three
    // bugs in `why` below involve the ambient at all: they are all about a
    // BAKED, graph-build-time ref being forgotten, frozen, or duplicated. A
    // rule should ban exactly the mechanism it can name, or it teaches people
    // to route around it (`feedback_too_fussy_over_lenient` says choose the
    // stricter option when a rule is in DOUBT — not when it is demonstrably
    // wider than its own rationale).
    pattern: /\b(?:bakedField|wallAvoidField|liveField|opennessGrid)(?![a-zA-Z])/,
    allow: [`${sep}world${sep}`],
    why:
      'sampleWind needs FIVE inputs, and until the handle existed every consumer assembled them by ' +
      'hand from vt-pan-viewer.js closure locals — the same four-line block copy-pasted at four call ' +
      'sites, plus two compute kernels on an incompatible second shape. That arrangement produced ' +
      'three real, separately-diagnosed bugs: particle-runtime.js silently omitted bakedField for a ' +
      'whole phase (door turbulence never reached the visible dust at all); the debug overlay froze ' +
      'its baked texture at the startup bake forever ("rebaking never visibly changes anything"); and ' +
      'computeWindTurbulence had to be extracted only AFTER two divergent copies were already live. ' +
      'Shared helpers did not stop this — the third bug IS a shared helper, arriving late. What stops ' +
      'it is making the malformed call unwriteable.',
    instead:
      'Take a wind handle (world/wind-access.js#createWindHandle, exported from world/index.js) and ' +
      'call handle.node() in a material, handle.kernel() in a compute kernel, or handle.cpuAt() on ' +
      'the CPU. A consumer holding a handle cannot forget an input, because it never names one. ' +
      'Only the bake site builds a handle. See docs/planning/Wind.md §5.1.',
  },
];

// ---------------------------------------------------------------------------

/**
 * THE DEBT LEDGER — the sanctioned outlet for "make it work NOW".
 *
 * The author named the threat themselves: *"drift that might be caused by me
 * shouting about an effect needing to work now as opposed to working
 * correctly."* A session under that pressure, with no sanctioned outlet, will
 * route around a wall QUIETLY — that is how all seven V2 bypasses happened.
 *
 * So the shortcut gets a legal form instead: an entry in
 * `tools/structure-exceptions.json` —
 *
 *   { "rule": "zones/one-door", "pathIncludes": "effects/fire",
 *     "reason": "author needs fire visible for Saturday's session",
 *     "approvedBy": "author", "expires": "2026-08-01" }
 *
 * Properties of the mechanism, each deliberate:
 *  - LOUD while active: every verify prints the debt (never invisible).
 *  - BOUNDED: on expiry the build FAILS until the shortcut is fixed properly
 *    or consciously renewed (renewal = editing the ledger = visible in diff).
 *  - OWNED: `approvedBy` is required — pressure has a name attached.
 *  - It cannot become permanent by forgetting. Forgetting is what expiry is for.
 *
 * @param {Array<object>} exceptions
 * @param {number} nowMs
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateExceptions(exceptions, nowMs) {
  const errors = [];
  if (!Array.isArray(exceptions)) return { ok: false, errors: ['exceptions file must be an array'] };
  exceptions.forEach((e, i) => {
    for (const field of ['rule', 'pathIncludes', 'reason', 'approvedBy', 'expires']) {
      if (!e?.[field] || typeof e[field] !== 'string') errors.push(`exception[${i}]: missing/invalid '${field}'`);
    }
    if (e?.expires) {
      const t = Date.parse(e.expires);
      if (!Number.isFinite(t)) errors.push(`exception[${i}]: expires '${e.expires}' is not a date`);
      else if (t < nowMs) {
        errors.push(
          `exception[${i}] EXPIRED ${e.expires}: "${e.reason}" (rule ${e.rule}, ${e.pathIncludes}). ` +
            'Fix it properly, or consciously renew it with the author — it does not get to become permanent by forgetting.'
        );
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Filter rule violations through the ACTIVE exceptions. Returns what remains,
 * plus what was excepted (so the debt can be printed loudly every run).
 * @param {string} ruleId
 * @param {{file: string, line: number, text: string}[]} found
 * @param {Array<object>} exceptions
 * @returns {{remaining: typeof found, excepted: typeof found}}
 */
export function applyExceptions(ruleId, found, exceptions) {
  const active = (exceptions ?? []).filter((e) => e.rule === ruleId);
  const remaining = [];
  const excepted = [];
  for (const hit of found) {
    const covered = active.some((e) => hit.file.replace(/\\/g, '/').includes(e.pathIncludes));
    (covered ? excepted : remaining).push(hit);
  }
  return { remaining, excepted };
}

function loadExceptions() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'tools', 'structure-exceptions.json'), 'utf8'));
  } catch {
    return [];
  }
}

function loadRatchets() {
  try {
    return JSON.parse(readFileSync(RATCHET_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function loadSizeBudgets() {
  try {
    return JSON.parse(readFileSync(SIZE_BUDGET_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function loadUniformBudgets() {
  try {
    return JSON.parse(readFileSync(UNIFORM_BUDGET_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Strip line + block comments so braces inside them don't miscount. Naive by
 *  design (does not track `//` or `/*` inside string/template literals) — see
 *  SIZE_CAPS on why an occasional miscount is harmless to a shrink-only ratchet. */
function stripBraceComments(line) {
  return line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
}

/**
 * The line-span of the largest TOP-LEVEL function in a file. Top-level =
 * column-0 `function NAME`, `const NAME = (…) =>`, or `const NAME = function`
 * (Prettier keeps top-level declarations AND their closing brace at column 0;
 * nested ones are indented, so a column-0 scan sees only the outermost). The
 * body span is found by brace balance from the declaration to the line the
 * balance returns to 0 — which correctly steps over a multi-line destructured
 * parameter list (`function start({\n …\n}) {`, the real startVtPanViewer
 * shape) because the param `{}` opens and closes before the body `{`.
 *
 * @param {string[]} lines
 * @returns {{name: string|null, startLine: number, lines: number}}
 */
export function largestTopLevelFunction(lines) {
  const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([\w$]+)/;
  const CONST_FN = /^(?:export\s+)?const\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\b|\(|[\w$]+\s*=>)/;
  let best = { name: null, startLine: 0, lines: 0 };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw[0] === ' ' || raw[0] === '\t') continue; // top-level declarations sit at column 0
    const m = DECL.exec(raw) || CONST_FN.exec(raw);
    if (!m) continue;
    let depth = 0;
    let opened = false;
    let end = lines.length - 1;
    for (let j = i; j < lines.length; j++) {
      const code = stripBraceComments(lines[j]);
      for (let k = 0; k < code.length; k++) {
        if (code[k] === '{') {
          depth++;
          opened = true;
        } else if (code[k] === '}') {
          depth--;
        }
      }
      if (opened && depth <= 0) {
        end = j;
        break;
      }
      if (!opened && /;\s*$/.test(code)) {
        end = j;
        break; // an expression-bodied arrow / a non-function `const` — no block body
      }
    }
    if (opened) {
      const span = end - i + 1;
      if (span > best.lines) best = { name: m[1], startLine: i + 1, lines: span };
    }
    i = end; // top level: never re-enter a body we just measured
  }
  return best;
}

/** @returns {{rel: string, fileLines: number, fnName: string|null, fnLines: number}[]} */
function measureSizes(files) {
  return files.map((file) => {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split('\n');
    const fn = largestTopLevelFunction(lines);
    return { rel, fileLines: lines.length, fnName: fn.name, fnLines: fn.lines };
  });
}

/**
 * The size ratchet: compare each file's measured size to its frozen budget.
 * Over cap with no budget → a NEW god-object (violation). Over its budget →
 * grew (violation). Under its budget → tighten. Under cap → no budget needed.
 * Same monotonic-improvement contract as the count ratchets in main().
 *
 * @param {{rel: string, fileLines: number, fnName: string|null, fnLines: number}[]} measurements
 * @param {Record<string, {file?: number, fn?: number}>} budgets
 * @param {{file: number, fn: number}} caps
 */
export function evaluateSizeBudgets(measurements, budgets, caps = SIZE_CAPS) {
  const violations = [];
  const tightened = [];
  const newBudgets = {};
  for (const rec of measurements) {
    const prior = budgets[rec.rel] ?? {};
    const entry = {};
    const dims = [
      { kind: 'file', current: rec.fileLines, cap: caps.file, budget: prior.file },
      { kind: 'fn', current: rec.fnLines, cap: caps.fn, budget: prior.fn },
    ];
    for (const d of dims) {
      if (d.current <= d.cap) continue; // under cap: free, no budget
      if (d.budget == null) {
        violations.push({
          rel: rec.rel,
          kind: d.kind,
          current: d.current,
          cap: d.cap,
          budget: null,
          fnName: rec.fnName,
        });
        entry[d.kind] = d.current; // so --update can adopt it consciously
      } else if (d.current > d.budget) {
        violations.push({
          rel: rec.rel,
          kind: d.kind,
          current: d.current,
          cap: d.cap,
          budget: d.budget,
          fnName: rec.fnName,
        });
        entry[d.kind] = d.budget;
      } else {
        if (d.current < d.budget) tightened.push({ rel: rec.rel, kind: d.kind, from: d.budget, to: d.current });
        entry[d.kind] = Math.min(d.current, d.budget);
      }
    }
    if (entry.file != null || entry.fn != null) newBudgets[rec.rel] = entry;
  }
  return { violations, tightened, newBudgets };
}

/**
 * Count real calls to `uniform(` in a file's lines — comment-stripped per
 * line (the same naive-but-loud-not-silent posture `stripBraceComments`
 * documents for the size ratchet), so a doc-comment quoting `uniform(...)`
 * as an example does not inflate the count. `\buniform\s*\(` also matches
 * `THREE.TSL.uniform(` / a destructured `{ uniform }` call — the word
 * boundary is on the identifier, not the access path, which is the point:
 * every real uniform allocation counts, however it is spelled.
 *
 * @param {string[]} lines
 * @returns {number}
 */
function countUniformCalls(lines) {
  let count = 0;
  for (const line of lines) {
    const code = stripBraceComments(line);
    const m = code.match(/\buniform\s*\(/g);
    if (m) count += m.length;
  }
  return count;
}

/** @returns {{rel: string, uniformCount: number}[]} */
function measureUniformCounts(files) {
  return files.map((file) => {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split('\n');
    return { rel, uniformCount: countUniformCalls(lines) };
  });
}

/**
 * The uniform-budget ratchet — a single-dimension version of
 * `evaluateSizeBudgets`'s exact contract (over cap with no budget → a NEW
 * violation; over budget → grew; under budget → tighten; under cap → free).
 *
 * @param {{rel: string, uniformCount: number}[]} measurements
 * @param {Record<string, number>} budgets
 * @param {number} cap
 */
export function evaluateUniformBudgets(measurements, budgets, cap = UNIFORM_CAP) {
  const violations = [];
  const tightened = [];
  const newBudgets = {};
  for (const rec of measurements) {
    const current = rec.uniformCount;
    if (current <= cap) continue; // under cap: free, no budget needed
    const budget = budgets[rec.rel];
    if (budget == null) {
      violations.push({ rel: rec.rel, current, cap, budget: null });
      newBudgets[rec.rel] = current; // so --update can adopt it consciously
    } else if (current > budget) {
      violations.push({ rel: rec.rel, current, cap, budget });
      newBudgets[rec.rel] = budget;
    } else {
      if (current < budget) tightened.push({ rel: rec.rel, from: budget, to: current });
      newBudgets[rec.rel] = Math.min(current, budget);
    }
  }
  return { violations, tightened, newBudgets };
}

/**
 * `params/no-dead-controls` — THE FIRST CROSS-FILE STRUCTURAL RULE in this
 * tool. Every other rule here scans one file's lines in isolation; this one
 * genuinely needs two files together: a `*_PARAMS` declaration, and every
 * OTHER source file, to answer "does anything actually read this key?"
 *
 * V2's water shipped 46 uniforms with a live UI slider and ZERO consuming
 * GLSL — including a fully-labelled "Bathymetry (Volumetric)" folder with
 * two colour pickers and a documented Beer-Lambert model, entirely inert
 * (`docs/planning/Water.md` §2). A control an author can move that changes
 * NOTHING is worse than no control at all: it is a lie they tune against.
 *
 * ============================================================================
 * WHY THE SEARCH SCOPE IS "ALL OF src/", NOT "src/effects/ only"
 * ============================================================================
 *
 * The obvious first design is "does this key appear in the effect's own
 * render/builder SIBLING files" — but `ui-window-shadow.js` (MSA's first
 * registered effect) proves that wrong: its params are declared in
 * `src/effects/`, and consumed entirely in `src/boot.js` + `src/vt/vt-pan-
 * viewer.js` — NEITHER under `src/effects/`. A directory-scoped search would
 * flag every one of its real, working params as dead. Scoping to the WHOLE
 * `src/` tree (never `__tests__/` — a test asserting a key EXISTS does not
 * prove it does anything) avoids that false positive while still catching
 * the real disease: a key with ZERO occurrences ANYWHERE outside its own
 * declaration is unambiguously dead, wherever its consumer would have lived.
 *
 * Known, accepted imprecision (documented, not engineered around — same
 * posture `stripBraceComments` states for its own naive comment-stripping):
 * a key COULD, in principle, be "saved" by an unrelated file that happens to
 * contain the same identifier for a different reason (two effects both
 * naming a param `strength`, say). Rare in practice — this codebase's own
 * convention already favours distinctive names (`azimuthDeg`, `tintColor`,
 * not bare `angle`/`color`) — and the failure direction is a missed
 * violation, not a false alarm on real work.
 */

/**
 * Extract every `export const X_PARAMS = {...}` (or `Object.freeze({...})`)
 * declaration's own TOP-LEVEL keys from a file's lines, by brace depth — the
 * same "column-0 declaration, then track braces" approach as
 * `largestTopLevelFunction`, one level down (keys immediately inside the
 * object, not the whole file's function span).
 *
 * @param {string[]} lines
 * @returns {{paramsName: string, keys: string[], startLine: number}[]}
 */
export function extractParamsDeclarations(lines) {
  const DECL = /^export const (\w+_PARAMS)\s*=\s*(?:Object\.freeze\()?\{/;
  const KEY = /^\s{2}(\w+):\s*\{/;
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw[0] === ' ' || raw[0] === '\t') continue; // top-level only
    const m = DECL.exec(stripBraceComments(raw));
    if (!m) continue;
    const keys = [];
    let depth = 0;
    let started = false;
    for (let j = i; j < lines.length; j++) {
      const code = stripBraceComments(lines[j]);
      // Checked BEFORE this line's own braces are counted: a key line like
      // `  threshold: {` must be seen while we are still "at depth 1" (only
      // inside the outer PARAMS object), not after descending into its body.
      if (started && depth === 1) {
        const keyMatch = KEY.exec(code);
        if (keyMatch) keys.push(keyMatch[1]);
      }
      for (const ch of code) {
        if (ch === '{') {
          depth++;
          started = true;
        } else if (ch === '}') depth--;
      }
      if (started && depth <= 0) break;
    }
    decls.push({ paramsName: m[1], keys, startLine: i + 1 });
  }
  return decls;
}

/**
 * The pure half — given every file's own {rel, text}, which declared param
 * keys have zero occurrences outside their own declaring file. Split from
 * `findDeadControls` (the disk-reading wrapper) so the actual cross-
 * referencing logic is testable with synthetic in-memory fixtures, same
 * `measureSizes`/`evaluateSizeBudgets` split the size ratchet already uses.
 *
 * @param {{rel: string, text: string}[]} fileTexts
 * @returns {{file: string, line: number, paramsName: string, key: string}[]}
 */
export function findDeadControlsInTexts(fileTexts) {
  // Comment-stripped ONCE per file (not per key) — a key name merely
  // MENTIONED in a comment must not count as "used". This is not a nicety:
  // V2's own "Bathymetry (Volumetric)" folder is exactly the failure mode a
  // comment-blind search would miss saving a genuinely dead param from
  // detection just because some nearby prose happens to say its name.
  const stripped = fileTexts.map(({ rel, text }) => ({
    rel,
    code: text.split('\n').map(stripBraceComments).join('\n'),
  }));
  const violations = [];
  for (const { rel, text } of fileTexts) {
    const decls = extractParamsDeclarations(text.split('\n'));
    for (const { paramsName, keys, startLine } of decls) {
      for (const key of keys) {
        // String-concatenated, not a template literal: `\b` inside a
        // template literal is the BACKSPACE escape, not the two-character
        // word-boundary sequence a RegExp needs — confirmed live while
        // prototyping this exact check.
        const pattern = new RegExp('\\b' + key + '\\b');
        const usedElsewhere = stripped.some((other) => other.rel !== rel && pattern.test(other.code));
        if (!usedElsewhere) violations.push({ file: rel, line: startLine, paramsName, key });
      }
    }
  }
  return violations;
}

/**
 * @param {string[]} files - absolute paths, from `sourceFiles()`.
 * @returns {{file: string, line: number, paramsName: string, key: string}[]}
 */
function findDeadControls(files) {
  const fileTexts = files.map((f) => ({
    rel: relative(ROOT, f).replace(/\\/g, '/'),
    text: readFileSync(f, 'utf8'),
  }));
  return findDeadControlsInTexts(fileTexts);
}

function scan() {
  const files = sourceFiles();
  /** @type {Map<string, {file: string, line: number, text: string}[]>} */
  const hits = new Map();

  for (const rule of RULES) hits.set(rule.id, []);

  for (const file of files) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const rule of RULES) {
      if (rule.allow.some((a) => file.includes(a))) continue;
      if (rule.scan) {
        for (const v of rule.scan(rel, lines)) hits.get(rule.id).push({ file: rel, line: v.line, text: v.text });
        continue;
      }
      lines.forEach((text, i) => {
        const t = text.trim();
        // Skip comment lines, AND strip inline `// ...` and `/* ... */` before
        // testing — otherwise a rule trips on its own explanatory comment. (Found
        // exactly that: the .mix() rule matched a comment WARNING about .mix().)
        // Not a full tokenizer; it does not handle `//` inside a string literal,
        // which is rare in this codebase and errs toward a false POSITIVE (loud),
        // never a false negative (silent) — the safe direction for a wall.
        if (t.startsWith('*') || t.startsWith('//')) return;
        const code = text.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
        const matched = rule.test ? rule.test(code) : rule.pattern.test(code);
        if (matched) {
          hits.get(rule.id).push({ file: rel, line: i + 1, text: code.trim().slice(0, 100) });
        }
      });
    }
  }
  return hits;
}

function main() {
  const updating = process.argv.includes('--update-ratchets');
  const ratchets = loadRatchets();
  const exceptions = loadExceptions();
  const exv = validateExceptions(exceptions, Date.now());
  if (!exv.ok) {
    for (const e of exv.errors) console.error(`\n⏰ ${e}`);
    process.exit(1);
  }
  const hits = scan();
  let failed = false;
  let debtShown = 0;
  const newRatchets = {};

  for (const rule of RULES) {
    const { remaining: found, excepted } = applyExceptions(rule.id, hits.get(rule.id), exceptions);
    for (const ex of excepted) {
      debtShown++;
      console.log(`⏳ excepted (${rule.id}): ${ex.file}:${ex.line} — see tools/structure-exceptions.json`);
    }
    const count = found.length;
    const bound = ratchets[rule.id] ?? 0;

    if (rule.ratchet) {
      newRatchets[rule.id] = Math.min(count, bound || count);
      if (count > bound) {
        failed = true;
        console.error(`\n❌ ${rule.id} — RATCHET BROKEN: ${count} violations, bound is ${bound}`);
      } else if (count < bound) {
        console.log(`✅ ${rule.id} — ratchet tightened: ${bound} → ${count}`);
      }
      if (count <= bound) continue;
    } else if (count === 0) {
      continue;
    } else {
      failed = true;
      console.error(`\n❌ ${rule.id} — ${count} violation(s)`);
    }

    console.error(`\n   WHY THIS RULE EXISTS:\n   ${rule.why.replace(/\s+/g, ' ')}`);
    console.error(`\n   DO THIS INSTEAD:\n   ${rule.instead.replace(/\s+/g, ' ')}`);
    console.error('\n   Violations:');
    for (const h of found.slice(0, 10)) console.error(`     ${h.file}:${h.line}  ${h.text}`);
    if (found.length > 10) console.error(`     ... and ${found.length - 10} more`);
  }

  // THE SIZE RATCHET — same monotonic-improvement contract as the count
  // ratchets above, keyed per file/function instead of a global tally.
  const sizeBudgets = loadSizeBudgets();
  const measurements = measureSizes(sourceFiles());
  const size = evaluateSizeBudgets(measurements, sizeBudgets, SIZE_CAPS);
  for (const t of size.tightened) {
    console.log(`✅ size/${t.kind} — ${t.rel}: budget tightened ${t.from} → ${t.to}`);
  }
  if (size.violations.length) {
    failed = true;
    console.error(`\n❌ size/bounded — ${size.violations.length} over-budget file(s)/function(s)`);
    console.error(`\n   WHY THIS RULE EXISTS:\n   ${SIZE_WHY.replace(/\s+/g, ' ')}`);
    console.error(`\n   DO THIS INSTEAD:\n   ${SIZE_INSTEAD.replace(/\s+/g, ' ')}`);
    console.error('\n   Violations:');
    for (const v of size.violations) {
      const what =
        v.kind === 'file'
          ? `${v.current} lines (cap ${v.cap})`
          : `function ${v.fnName || '?'}() is ${v.current} lines (cap ${v.cap})`;
      const how =
        v.budget == null
          ? 'NEW over-cap — split it, or `npm run ratchets:update` to register the debt'
          : `grew past its frozen budget of ${v.budget} — it may only SHRINK`;
      console.error(`     ${v.rel}: ${what} — ${how}`);
    }
  }

  // THE UNIFORM BUDGET (`effects/uniform-budget`) — same shrink-only ratchet
  // as size, scoped to `src/effects/` (Water.md §6.3: "per effect module").
  const uniformBudgets = loadUniformBudgets();
  const uniformMeasurements = measureUniformCounts(sourceFiles(EFFECTS_DIR));
  const uniformBudgetResult = evaluateUniformBudgets(uniformMeasurements, uniformBudgets, UNIFORM_CAP);
  for (const t of uniformBudgetResult.tightened) {
    console.log(`✅ effects/uniform-budget — ${t.rel}: budget tightened ${t.from} → ${t.to}`);
  }
  if (uniformBudgetResult.violations.length) {
    failed = true;
    console.error(`\n❌ effects/uniform-budget — ${uniformBudgetResult.violations.length} over-budget file(s)`);
    console.error(`\n   WHY THIS RULE EXISTS:\n   ${UNIFORM_WHY.replace(/\s+/g, ' ')}`);
    console.error(`\n   DO THIS INSTEAD:\n   ${UNIFORM_INSTEAD.replace(/\s+/g, ' ')}`);
    console.error('\n   Violations:');
    for (const v of uniformBudgetResult.violations) {
      const how =
        v.budget == null
          ? 'NEW over-cap — split it, or `npm run ratchets:update` to register the debt'
          : `grew past its frozen budget of ${v.budget} — it may only SHRINK`;
      console.error(`     ${v.rel}: ${v.current} calls to uniform( (cap ${v.cap}) — ${how}`);
    }
  }

  // `params/no-dead-controls` — no ratchet: zero violations exist today (the
  // cheapest possible moment to build this wall), so it is built at zero and
  // stays at zero, same posture as the other free walls in this file.
  const deadControls = findDeadControls(sourceFiles());
  if (deadControls.length) {
    failed = true;
    console.error(`\n❌ params/no-dead-controls — ${deadControls.length} inert param(s)`);
    console.error(
      '\n   WHY THIS RULE EXISTS:\n   ' +
        (
          "V2's water shipped 46 uniforms with a live UI slider and ZERO consuming GLSL — including a " +
          'fully-labelled "Bathymetry (Volumetric)" folder with two colour pickers and a documented ' +
          'Beer-Lambert model, entirely inert. A control an author can move that changes NOTHING is ' +
          'worse than no control at all: it is a lie they tune against.'
        ).replace(/\s+/g, ' ')
    );
    console.error(
      '\n   DO THIS INSTEAD:\n   ' +
        (
          'Wire the param into its real consumer, or delete the declaration. If the feature is coming ' +
          'in a later phase (same discipline `docs/planning/Water.md` uses for its own deferred tiers), ' +
          'record it as a `deferredRungs` note instead of a param nobody reads yet.'
        ).replace(/\s+/g, ' ')
    );
    console.error('\n   Violations:');
    for (const v of deadControls.slice(0, 10)) {
      console.error(`     ${v.file}:${v.line}  ${v.paramsName}.${v.key} — no consumer found anywhere in src/`);
    }
    if (deadControls.length > 10) console.error(`     ... and ${deadControls.length - 10} more`);
  }

  if (updating) {
    for (const rule of RULES) {
      if (rule.ratchet) newRatchets[rule.id] = hits.get(rule.id).length;
    }
    writeFileSync(RATCHET_FILE, JSON.stringify(newRatchets, null, 2) + '\n');
    // Seed/adopt size budgets at CURRENT sizes for every over-cap file — the
    // tightest honest bound, the "tighten immediately" the ratchet is for.
    const seeded = {};
    for (const rec of measurements) {
      const e = {};
      if (rec.fileLines > SIZE_CAPS.file) e.file = rec.fileLines;
      if (rec.fnLines > SIZE_CAPS.fn) e.fn = rec.fnLines;
      if (e.file != null || e.fn != null) seeded[rec.rel] = e;
    }
    writeFileSync(SIZE_BUDGET_FILE, JSON.stringify(seeded, null, 2) + '\n');
    // Same seed-at-current-value contract, for uniform counts.
    const seededUniforms = {};
    for (const rec of uniformMeasurements) {
      if (rec.uniformCount > UNIFORM_CAP) seededUniforms[rec.rel] = rec.uniformCount;
    }
    writeFileSync(UNIFORM_BUDGET_FILE, JSON.stringify(seededUniforms, null, 2) + '\n');
    console.log(
      `\n📌 Ratchets + size budgets written (${Object.keys(seeded).length} files budgeted, ` +
        `${Object.keys(seededUniforms).length} uniform-budgeted)`
    );
    return;
  }

  if (failed) {
    console.error(
      '\n────────────────────────────────────────────────────────────\n' +
        'STRUCTURE CHECK FAILED.\n\n' +
        'This is not bureaucracy. Each rule above is a corpse from the previous\n' +
        'module (memory: v2-postmortem-the-failure-modes; docs/planning/Engine-Postmortem.md).\n' +
        'V2 had the right designs written down THREE times and lost anyway, because\n' +
        'following them was optional. This file is what "not optional" looks like.\n\n' +
        'The wall is right until the author says otherwise. If it is genuinely wrong,\n' +
        'change it LOUDLY: [structure-change] in the commit + update the governing doc.\n' +
        '────────────────────────────────────────────────────────────'
    );
    process.exit(1);
  }

  const tightened = Object.keys(newRatchets).length;
  const budgeted = Object.keys(size.newBudgets).length;
  const uniformBudgeted = Object.keys(uniformBudgetResult.newBudgets).length;
  console.log(
    `✅ structure: ${RULES.length} rules pass${tightened ? ` (${tightened} ratcheted)` : ''}` +
      `${budgeted ? `, ${budgeted} size budget(s)` : ''}` +
      `${uniformBudgeted ? `, ${uniformBudgeted} uniform budget(s)` : ''}` +
      `${debtShown ? ` — ⏳ ${debtShown} declared debt(s) active` : ''}`
  );
}

// Only run when invoked directly -- verify-structure.test.mjs imports RULES to
// prove each wall rejects its real V2 corpse, and must not trigger a full scan.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
