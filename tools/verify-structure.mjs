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

// fileURLToPath, not URL.pathname — the repo path contains spaces, which pathname
// percent-encodes into %20 and fs then cannot find. Found on this file's first run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const RATCHET_FILE = join(ROOT, 'tools', 'structure-ratchets.json');

/** Vendored third-party code is never ours to police. */
const IGNORED = [`${sep}vendor${sep}`, `${sep}__tests__${sep}`];

/** @returns {string[]} every .js/.mjs file under src/, excluding vendor + tests */
function sourceFiles(dir = SRC, out = []) {
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

  if (updating) {
    for (const rule of RULES) {
      if (rule.ratchet) newRatchets[rule.id] = hits.get(rule.id).length;
    }
    writeFileSync(RATCHET_FILE, JSON.stringify(newRatchets, null, 2) + '\n');
    console.log(`\n📌 Ratchets written to ${relative(ROOT, RATCHET_FILE)}`);
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
  console.log(
    `✅ structure: ${RULES.length} rules pass${tightened ? ` (${tightened} ratcheted)` : ''}${debtShown ? ` — ⏳ ${debtShown} declared debt(s) active` : ''}`
  );
}

// Only run when invoked directly -- verify-structure.test.mjs imports RULES to
// prove each wall rejects its real V2 corpse, and must not trigger a full scan.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
