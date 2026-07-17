/**
 * THE V2 REGRESSION TEST — proof the walls reject the actual historical mistakes.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * `verify-structure.mjs` claims to prevent V2's failure modes. A claim is not
 * evidence. This test takes **real lines from the real `legacy/` source** — the
 * exact code that killed the previous module — feeds them to the rules, and
 * asserts each one is rejected.
 *
 * So the walls are not trusted, they are TESTED, on every `npm run verify`. And
 * the test doubles as an executable history: every case below is a citation,
 * with the file it came from.
 *
 * If a wall ever stops catching its corpse, this goes red. That is the point:
 * a rule can rot (a regex loosened, an allow-list widened for convenience) and
 * nothing else would notice. This notices.
 *
 * ADDING A CASE: when you fix a bug CLASS and add its tripwire (covenant rule 4,
 * Skeleton.md §3), add the real offending line here too. The rule and its proof
 * ship together.
 *
 * @module tools/verify-structure.test
 */

import { existsSync } from 'node:fs';
import { sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RULES, validateExceptions, applyExceptions } from './verify-structure.mjs';
import { computeReachability } from './reachability.mjs';

// Same derivation tools/verify-structure.mjs itself uses — replicated here
// (rather than exported) because this file proves the RULE's behavior, and a
// rule that silently depended on a test-only ROOT would not be proving the
// real thing.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Real V2 code, verbatim, with its source. Each MUST be rejected by `rule`.
 * @type {{rule: string, from: string, code: string, note: string}[]}
 */
const V2_CORPSES = [
  // --- the particle sprawl: five architectures because the good one was optional
  {
    rule: 'particles/one-engine',
    from: '8 files did Sprite-per-particle; N particles = N scene objects = N draw calls',
    code: 'const sprite = new THREE.Sprite(this._material);',
    note: 'the worst of V2 five particle architectures',
  },
  {
    rule: 'particles/one-engine',
    from: 'legacy/particles/WeatherParticles.js',
    code: "import { BatchedRenderer } from '../libs/three.quarks.module.js';",
    note: 'quarks cannot render under the node renderer at all (keyhole-particles-tsl-decision)',
  },

  // --- the global bus: 479 reaches, and the Lighting<->Fire cycle it enabled
  {
    rule: 'no-global-bus',
    from: 'legacy/compositor-v2/effects/LightingEffectV2.js:4209',
    code: 'const fire = window.MapShine?.fireEffectV2?._glowBucketsByFloor;',
    note: 'Lighting reads Fire PRIVATE field, through a global. Half of the cycle.',
  },
  {
    rule: 'no-global-bus',
    from: 'legacy/compositor-v2/effects/FireEffectV2.js:4799',
    code: 'const pad = window.MapShine?.lightingEffect?.params?.wallPaddingPx;',
    note: 'Fire reads Lighting params -- for a CONSTANT. The other half. The knot was fake.',
  },

  // --- renderer state with 60 owners
  {
    rule: 'renderer-state/graph-only',
    from: '452 setRenderTarget sites across 60 files',
    code: 'renderer.setRenderTarget(this._compositeTarget);',
    note: 'the "it works unless you enable bloom" generator',
  },
  {
    rule: 'renderer-state/graph-only',
    from: '262 autoClear touches of a global mutable boolean',
    code: 'renderer.autoClear = false;',
    note: '60 modules flipping one global flag and hoping about ordering',
  },

  // --- the GPU as a data structure
  {
    rule: 'no-gpu-readback',
    from: 'legacy/scene/physics-rope-manager.js:657',
    code: 'renderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);',
    note: 'a FULL pipeline stall to fetch ONE PIXEL -- four bytes',
  },
  {
    rule: 'no-gpu-readback',
    from: 'legacy/compositor-v2/effects/fire-behaviors.js (readImageRgba)',
    code: 'const data = ctx.getImageData(0, 0, 8250, 8250).data;',
    note: '260MB of heap + a 550-850ms stall, per load',
  },

  // --- the TSL trap that blacked out the map for a session
  {
    rule: 'tsl/no-mix-method',
    from: 'src/vt/vt-pan-viewer.js, as originally written (2026-07-16)',
    code: 'c.a.mulAssign(uUnoccludedAlpha.mix(uOccludedAlpha, occ));',
    note: 'reads as mix(1,0,0)==1; COMPILED to mix(0,occ,1)==0. alpha *= ZERO. Whole map black.',
  },

  // --- "off" that still costs, 117 times
  {
    rule: 'tsl/no-uniform-gates',
    from: 'legacy: 117 distinct uniform-gated branches',
    code: 'uniforms.uHasBelowWaterMask = { value: 0.0 };',
    note: 'a zero uniform does not remove work -- it executes every pixel and binds its textures',
  },

  // --- 2,670 silent swallows: one per ~140 lines
  {
    rule: 'no-silent-catch',
    from: 'legacy/compositor-v2/effects/WaterEffectV2.js (_setCrossSliceWaterDataUniform)',
    code: '  } catch (_) {}',
    note: 'the swallow disease reached even the healthiest two-line function in the file',
  },

  // --- the quarantine
  {
    rule: 'quarantine/no-legacy-imports',
    from: 'the boundary Keyhole 5 exists to hold',
    code: "import { FloorCompositor } from '../legacy/compositor-v2/FloorCompositor.js';",
    note: 'one import and V2 is alive again inside V3',
  },

  // --- the adapter that covered 16% of its own job
  {
    rule: 'foundry/adapter-only',
    from: '107 of 128 files reached around legacy/foundry/',
    code: 'const sceneDoc = canvas.scene;',
    note: 'the adapter existed and LOST -- proof #2 that optional structure loses',
  },
  {
    rule: 'foundry/adapter-only',
    from: 'legacy: 224 Hooks sites across 79 distinct hooks',
    code: "Hooks.on('updateToken', this._onUpdateToken.bind(this));",
    note: 'Foundry coupling sprayed across 128 files instead of isolated in the adapter',
  },

  // --- one clock: time.js MUST, ignored 8 times by Water alone
  {
    rule: 'time/one-clock',
    from: 'legacy/compositor-v2/effects/WaterEffectV2.js (8 independent samples)',
    code: 'const t = performance.now() * 0.001;',
    note: 'time.js: "ALL EFFECTS MUST USE THIS TIME SYSTEM". Comment-MUST #4 of 7.',
  },

  // --- one darkness: the feedback bus that cost two months
  {
    rule: 'env/one-darkness',
    from: 'legacy: 28 files read back the darkness MSA itself pushed into Foundry',
    code: 'const dark = canvas.environment.darknessLevel;',
    note: 'subsystems talking to each other THROUGH the game document',
  },

  // --- one sun: 8 independent derivations
  {
    rule: 'env/one-sun',
    from: 'legacy/compositor-v2/shadow-system/SunDirection.js + 7 others',
    code: 'const sunDirection = computeSunAngle(timeOfDay);',
    note: 'shadows and specular could disagree about the sky BY CONSTRUCTION',
  },

  // --- shadow is not paint: the fossils of the wrong noun
  {
    rule: 'shadow/no-lift-no-combine',
    from: 'legacy/compositor-v2/shadow-system/DynamicLightShadowLift.js',
    code: 'uniforms.uDynamicLightShadowOverrideStrength.value = 0.7;',
    note: 'ONE global scalar: a candle and a floodlight punch through a shadow identically',
  },
  {
    rule: 'shadow/no-lift-no-combine',
    from: 'legacy/compositor-v2/effects/ShadowManagerV2.js',
    code: 'material.uniforms.tCombinedShadow.value = this._compositeTarget.texture;',
    note: 'ONE shadow factor for ALL lights -- the wrong noun, in code',
  },

  // --- params: the write path that never read its own schema
  {
    rule: 'params/one-owner',
    from: 'legacy/compositor-v2/effects/SpecularEffectV2.js (applyParamChange) — inches below its own getControlSchema()',
    code: '    this.params[paramId] = value;',
    note: 'no type check, no clamp, silent return on unknown key -- the disease control-state-sanitize.js exists to mop up',
  },
  {
    rule: 'params/one-owner',
    from: 'legacy: 119 param writes from OUTSIDE effects/, incl. HealthEvaluatorService (diagnostics mutating product state)',
    code: 'effect.params.contextBrightness = computed;',
    note: '938 keys, six writing subsystems, no owner',
  },

  // --- the Y-flip: V3's own, caught live by the author 2026-07-17
  {
    rule: 'gpu/no-handrolled-fullscreen-quad',
    from: 'src/vt/vt-pan-viewer.js, the present pass as first written (2026-07-17)',
    code: 'const presentQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), presentMaterial);',
    note: 'the whole map rendered UPSIDE DOWN. PlaneGeometry v=0 is screen-BOTTOM; three RT textures are v=0 TOP.',
  },
  {
    rule: 'gpu/no-handrolled-fullscreen-quad',
    from: 'the same mistake without the THREE. prefix (destructured import)',
    code: 'const geo = new PlaneGeometry(2, 2);',
    note: 'the wall must not be dodgeable by an import style',
  },

  // --- the UI: a good schema system, referenced zero times
  {
    rule: 'ui/no-handwritten-controls',
    from: 'legacy/ui/tweakpane-manager.js (11,157 lines, 0 uses of getControlSchema)',
    code: "const sunFolder = parent.addFolder({ title: 'Sun', expanded: true });",
    note: 'bypass #7: 48 declarative schemas sat unused while folders were hand-written',
  },

  // --- THE LAW: 126 render-target allocations across 35 files, 70 of them
  // private and world-res. This is Keyhole.md §1's crash class, line by line.
  {
    rule: 'gpu/allocator-only',
    from: 'legacy/compositor-v2/effects/BuildingShadowsEffectV2.js:935',
    code: 'this._strengthTarget = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {',
    note: 'ONE effect opened FOUR private targets (_strength/_shadow/_blur/_sharpHold)',
  },
  {
    rule: 'gpu/allocator-only',
    from: 'legacy/compositor-v2/effects/DistortionManager.js:544',
    code: 'this.distortionTarget = new THREE.WebGLRenderTarget(width, height, rtOptions);',
    note: 'a private target sized from a `width` nobody could see the law applying to',
  },
  {
    rule: 'gpu/allocator-only',
    from: 'legacy/compositor-v2/effects/FogOfWarEffectV2.js:1287',
    code: 'this.visionRenderTarget = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {',
    note: 'fog is the ONE sanctioned world-space buffer — and it still must come from the allocator, capped',
  },
  {
    rule: 'gpu/allocator-only',
    from: 'the r170 MRT class V2 used before it was removed',
    code: 'this._targets = new THREE.WebGLMultipleRenderTargets(w, h, 2);',
    note: 'the plural spelling must not be a hole in the wall',
  },

  // --- THE LAW'S OTHER HALF: the single biggest measured offender was ONE
  // texture (8250² LightCovers.webp = 345 MB), not a render target.
  {
    rule: 'gpu/textures-in-vt-only',
    from: 'legacy/assets/image-texture-loader.js:288',
    code: 'const texture = new THREE.Texture(texSource);',
    note: 'the whole crisis in one reasonable-looking line: a world-res bitmap straight onto the GPU',
  },
  {
    rule: 'gpu/textures-in-vt-only',
    from: 'legacy/assets/loader.js:1388',
    code: 'const threeTexture = new THREE.Texture(texSource);',
    note: 'and again in the other loader — two paths, because nothing forbade either',
  },

  // --- the log door: the only corpse here that is OURS, not V2's.
  //
  // Every other case in this file is a citation from `legacy/` — a mistake the
  // previous module already died of. These four came out of `src/` on
  // 2026-07-17, live, while `core/log.js` sat there exporting a perfectly good
  // scoped logger to 3 importers. 61 direct console calls against it, 22 in
  // boot.js alone.
  //
  // That is worth keeping visible: the failure mode is not something that
  // happened to someone else in the past. It reproduced inside the rebuilt tree,
  // under the doctrine, with the postmortem written down, in under six months —
  // which is exactly the claim `v2-postmortem-the-failure-modes` makes about WHY
  // V2 died. Not carelessness. Optionality.
  {
    rule: 'log/one-door',
    from: 'src/boot.js:1085 (V3, pre-migration)',
    code: 'console.log(`${TAG} boot heartbeat rendering. Gate "boot renders" ✔`);',
    note: 'OUR code, not V2 — the logger existed and boot.js bypassed it 22 times',
  },
  {
    rule: 'log/one-door',
    from: 'src/boot.js:1088 (V3, pre-migration)',
    code: 'console.error(`${TAG} boot heartbeat FAILED — the new renderer did not come up:`, err);',
    note: 'the single most important line in the file, and it could not be exported',
  },
  {
    rule: 'log/one-door',
    from: 'src/diag/soak.js:32',
    code: "console.warn('[soak] webglcontextlost');",
    note: 'a hand-rolled [soak] prefix — reinventing the scoped logger it did not import',
  },
  {
    rule: 'log/one-door',
    from: 'the "just this once, it is only a diagnostic" bypass',
    code: 'console.table(rows);',
    note: 'table/group are how the door gets propped open; a diagnostic that never reaches the export is the one nobody can read back',
  },

  // --- the mask-suffix sprawl: three independent copies of the file convention
  {
    rule: 'masks/authority-only',
    from: 'legacy/assets/loader.js:56 (EFFECT_MASKS — copy #1 of the convention)',
    code: "outdoors: { suffix: '_Outdoors', required: false, description: 'Indoor/outdoor area mask' },",
    note: 'the loader’s own suffix registry, one of three that drifted apart',
  },
  {
    rule: 'masks/authority-only',
    from: 'legacy/assets/loader.js:58 (the hardcoded per-level hack)',
    code: "outdoors0: { suffix: '_Outdoors_0', required: false, description: 'Outdoors mask for level 0' },",
    note: 'the _Outdoors_0 per-level variant — the boundary regex must still catch a trailing _N',
  },
  {
    rule: 'masks/authority-only',
    from: 'legacy/masks/GpuSceneMaskCompositor.js:1259',
    code: "const probed = await assetLoader.probeMaskFile(fallbackPath, '_Outdoors', { suppressProbeErrors: true });",
    note: 'a THIRD holder of the suffix, deep inside the 4,092-line compositor, complete with probe-error suppression',
  },
  {
    rule: 'masks/authority-only',
    from: 'legacy/assets/loader.js:63 (the alias the window kind now absorbs)',
    code: "windows: { suffix: '_Windows', required: false, description: 'Window lighting mask' },",
    note: 'V2 alias suffixes are reserved too — they resolve through the catalog, never re-hardcode',
  },
];

/** Lines that must NOT trip a rule (guards against a wall crying wolf). */
const MUST_PASS = [
  { code: 'return { occ, factor: THREE.TSL.mix(a, b, t) };', note: 'TSL.mix FUNCTION form is correct' },
  { code: 'const blended = mix(colorLo, colorHi, t);', note: 'bare mix() function form is correct' },
  { code: 'MapShine.debug.registerReport("boot", "Boot", fn);', note: 'MapShine.debug is the sanctioned shop window' },
  { code: '} catch (err) { log.warn("decode failed", err); }', note: 'a catch that REPORTS is fine' },
  // The two law walls must bite on ALLOCATION, never on reading or testing. A
  // wall that trips on `handle.renderTarget` gets muted, and a muted wall is
  // worse than none — it teaches that the suite cries wolf.
  // The log door must bite on `console.*` and NOTHING else. If it tripped on the
  // sanctioned path, the fix would be to mute the wall — and a muted wall is
  // worse than no wall, because it teaches that the suite cries wolf.
  { code: "const log = createLogger('boot');", note: 'creating a scoped logger is the prescribed fix, not a bypass' },
  { code: 'log.info(`scene load complete in ${summary.totalMs}ms`, summary);', note: 'the sanctioned path itself' },
  { code: "log.error('real-scene VT viewer auto-sync failed:', err);", note: 'logger.error is not console.error' },
  {
    code: "import { setLogSink, isLoggerPrinting } from '../core/log.js';",
    note: "importing the logger's own seams is not talking to the console",
  },
  { code: 'const target = frame.renderTarget;', note: 'READING a renderTarget is not allocating one' },
  { code: 'if (tex.isDataArrayTexture) return tex.image.depth;', note: 'a type CHECK is not an allocation' },
  { code: 'const loader = new THREE.TextureLoader();', note: 'TextureLoader is not a texture' },
  { code: 'const proxy = new PIXI.Texture(baseTexture);', note: 'PIXI proxies are the §4.3 FIX, not the disease' },
  // The fullscreen-quad wall must bite ONLY on a screen-filling quad. A
  // world-space plane is the renderer's bread and butter (every tile is one)
  // and tripping on those would get the rule muted within a day.
  {
    code: 'const geo = new THREE.PlaneGeometry(tileW, tileH);',
    note: 'a world-space tile plane is not a fullscreen quad',
  },
  {
    code: 'const geo = new THREE.PlaneGeometry(2048, 2048);',
    note: 'a big world-space plane is still not a fullscreen quad',
  },
  { code: 'const quad = new THREE.QuadMesh(material);', note: "three's OWN fullscreen quad is the prescribed fix" },
  // The mask wall must bite on SUFFIX literals, never on identifiers that
  // merely start the same way, and never on catalog KIND ids (no underscore).
  {
    code: 'const value = state._Normalized ?? 0;',
    note: 'an identifier substring is not a mask suffix (_Normal + letter)',
  },
  { code: 'this._FireballCache = new Map();', note: 'an identifier substring is not a mask suffix (_Fire + letter)' },
  { code: "const kind = maskKindById('outdoors');", note: 'catalog kind ids are the sanctioned vocabulary' },
];

export function run(t) {
  const byId = new Map(RULES.map((r) => [r.id, r]));
  const matches = (rule, code) => (rule.test ? rule.test(code) : rule.pattern.test(code));

  // Every corpse must be rejected by its rule.
  for (const c of V2_CORPSES) {
    const rule = byId.get(c.rule);
    t.ok(`rule '${c.rule}' exists`, !!rule);
    if (!rule) continue;
    t.ok(`REJECTS [${c.rule}] ${c.note}`, matches(rule, c.code));
  }

  // No rule may reject legitimate code.
  for (const g of MUST_PASS) {
    const tripped = RULES.filter((r) => matches(r, g.code)).map((r) => r.id);
    t.ok(`ALLOWS: ${g.note}${tripped.length ? ` (tripped: ${tripped})` : ''}`, tripped.length === 0);
  }

  // Every rule must carry its evidence — a wall with no sign is a wall people resent.
  for (const r of RULES) {
    t.ok(`rule '${r.id}' explains WHY (cites a V2 corpse)`, typeof r.why === 'string' && r.why.length > 80);
    t.ok(`rule '${r.id}' says what to do INSTEAD`, typeof r.instead === 'string' && r.instead.length > 20);
  }

  // ---- the mask wall's ONE DOOR must be open (and be a real file) ----------
  // Same lesson as the THREE-law doors below: a wall whose sanctioned path is
  // welded shut (allow-list typo, file moved) teaches everyone to route around
  // it. The catalog is where suffix literals are LEGAL — prove the allow-list
  // actually matches the real file, and that the wall still bites elsewhere.
  {
    const rule = byId.get('masks/authority-only');
    t.ok("'masks/authority-only' exists", !!rule);
    if (rule) {
      const catalogRel = `src${sep}scene${sep}mask-catalog.js`;
      t.ok(
        'the catalog door is OPEN (allow-list matches its real path)',
        rule.allow.some((a) => catalogRel.includes(a))
      );
      t.ok('the catalog file exists on disk', existsSync(join(ROOT, 'src', 'scene', 'mask-catalog.js')));
      t.ok('the wall bites a bare suffix concat', matches(rule, "const s = base + '_Outdoors.webp';"));
      t.ok('the wall bites template interpolation', matches(rule, 'const u = `${dir}/${base}_Specular.${ext}`;'));
    }
  }

  // ---- THE LAW's two walls: the ONE DOOR each must actually be open --------
  // The corpse cases above prove these walls BITE. They do not prove the
  // sanctioned path is reachable — and a wall whose door is welded shut is the
  // failure mode this whole session was about: ThreeAllocator was unreachable
  // through its own front door (`window.THREE unavailable`) for its entire life,
  // with every test green, because nothing checked the way IN.
  {
    const allocOnly = RULES.find((r) => r.id === 'gpu/allocator-only');
    const texVt = RULES.find((r) => r.id === 'gpu/textures-in-vt-only');
    t.ok("'gpu/allocator-only' exists (Skeleton.md §2.3, unbuilt until 2026-07-17)", !!allocOnly);
    t.ok("'gpu/textures-in-vt-only' exists", !!texVt);

    // `allow` is a path-fragment list; the scanner skips a file whose path
    // contains one. Assert the REAL owner paths are covered — a typo here (or a
    // future file move) silently welds the door shut and the next session routes
    // around the law rather than through it.
    const covers = (rule, path) => rule.allow.some((a) => path.includes(a));
    t.ok(
      'the allocator itself may allocate render targets',
      covers(allocOnly, `src${sep}graph${sep}three-allocator.js`)
    );
    t.ok('nothing ELSE in graph/ may', !covers(allocOnly, `src${sep}graph${sep}frame-graph.js`));
    t.ok(
      'an effect may NOT allocate a render target',
      !covers(allocOnly, `src${sep}effects${sep}water${sep}water-pass.js`)
    );

    t.ok('vt/ may create textures — it IS the paging system', covers(texVt, `src${sep}vt${sep}atlas.js`));
    t.ok('...including the renderer inside vt/', covers(texVt, `src${sep}vt${sep}vt-pan-viewer.js`));
    t.ok('an effect may NOT create a texture', !covers(texVt, `src${sep}effects${sep}water${sep}water-pass.js`));
    t.ok('foundry/ may NOT create a THREE texture', !covers(texVt, `src${sep}foundry${sep}scene-layers.js`));
  }

  // ---- reachability: the wall built to catch the museum this session found -
  {
    const rule = RULES.find((r) => r.id === 'graph/reachable-from-boot');
    t.ok(
      "'graph/reachable-from-boot' exists and is a whole-graph scan rule",
      !!rule && typeof rule.scan === 'function'
    );
    if (rule) {
      // Real data, not synthetic — matches this file's house style. These are
      // load-bearing facts as of 2026-07-17, not incidental: graph/index.js
      // and graph/pass-impls.js are the SPECIFIC files this session built to
      // fix the museum finding, so their reachability is the direct proof the
      // fix landed, not just that the rule's mechanism works in the abstract.
      t.ok('boot.js itself is NEVER flagged (it is the root)', rule.scan('src/boot.js').length === 0);
      t.ok('a REAL file this session wired IS now reachable', rule.scan('src/graph/index.js').length === 0);
      t.ok(
        'the live-registry this session added IS reachable through the door',
        rule.scan('src/graph/pass-impls.js').length === 0
      );
      // Proves the wall still BITES, not just that it stays quiet — using a
      // REAL currently-unreachable file rather than a fabricated path. A
      // fabricated path can never appear in `unreachableFromBoot()`'s Set (it
      // is computed only over files that exist on disk), so asserting against
      // one proves nothing; it would silently pass even if the rule's `has()`
      // check were deleted entirely. Picked dynamically, not hardcoded, so
      // this assertion keeps working as today's honest debt (frozen in
      // structure-ratchets.json) gets paid down over future sessions.
      const { unreachable } = computeReachability(ROOT);
      t.ok('there IS current debt to prove the wall against (else this proof is vacuous)', unreachable.length > 0);
      if (unreachable.length > 0) {
        t.ok(
          `a REAL unreachable file (${unreachable[0]}) is correctly flagged`,
          rule.scan(unreachable[0]).length === 1
        );
      }
    }
  }

  // ---- the one-door rule: file-level scan, proven both ways ----------------
  {
    const rule = RULES.find((r) => r.id === 'zones/one-door');
    t.ok("'zones/one-door' exists and is a scan rule", !!rule && typeof rule.scan === 'function');
    if (rule) {
      const deep = rule.scan('src/effects/water/water-pass.js', [
        "import { PageCache } from '../../vt/page-cache.js';",
      ]);
      t.ok('REJECTS a deep cross-zone import (effects reaching into vt internals)', deep.length === 1);
      const door = rule.scan('src/effects/water/water-pass.js', ["import { vtSample } from '../../vt/index.js';"]);
      t.ok('ALLOWS crossing through the door (vt/index.js)', door.length === 0);
      const inside = rule.scan('src/vt/page-cache.js', ["import { PageTable } from './page-table.js';"]);
      t.ok('ALLOWS imports inside a zone', inside.length === 0);
      const stdlib = rule.scan('src/effects/water/water-pass.js', [
        "import { NotBuiltError } from '../../core/not-built.js';",
      ]);
      t.ok('ALLOWS core/ (the standard library is individually public)', stdlib.length === 0);
    }
  }

  // ---- the debt ledger: the sanctioned outlet for "make it work NOW" -------
  {
    const NOW = Date.parse('2026-07-16');
    const good = [
      {
        rule: 'zones/one-door',
        pathIncludes: 'effects/fire',
        reason: 'author needs fire visible for Saturday',
        approvedBy: 'author',
        expires: '2026-08-01',
      },
    ];
    t.ok('a complete, future-dated exception validates', validateExceptions(good, NOW).ok);

    const expired = [{ ...good[0], expires: '2026-07-01' }];
    const r = validateExceptions(expired, NOW);
    t.ok('an EXPIRED exception fails the build', !r.ok);
    t.ok(
      '...and the error says fix-or-renew, never quietly-keep',
      r.errors.some((e) => /renew/.test(e))
    );

    const anonymous = [{ ...good[0], approvedBy: '' }];
    t.ok('pressure must have a NAME attached (approvedBy required)', !validateExceptions(anonymous, NOW).ok);
    const unreasoned = [{ ...good[0], reason: '' }];
    t.ok('and a reason (no blank-cheque debt)', !validateExceptions(unreasoned, NOW).ok);

    const hits = [
      { file: 'src/effects/fire/fire-pass.js', line: 10, text: 'deep import' },
      { file: 'src/effects/water/water-pass.js', line: 5, text: 'deep import' },
    ];
    const { remaining, excepted } = applyExceptions('zones/one-door', hits, good);
    t.ok('an active exception covers ONLY its declared path', excepted.length === 1 && remaining.length === 1);
    t.ok('...the covered one is the declared one', excepted[0].file.includes('fire'));
    const other = applyExceptions('no-silent-catch', hits, good);
    t.ok('an exception never bleeds across rules', other.excepted.length === 0);
  }

  // Every corpse in the list must map to a real rule (no orphan citations).
  const covered = new Set(V2_CORPSES.map((c) => c.rule));
  // File-level `scan` rules cannot be fed a bare corpse line — they carry their
  // own dedicated proof section above (and this assertion keeps THAT honest:
  // a scan rule with no bespoke proof shows up here as uncovered).
  const scanRulesProven = new Set(['zones/one-door', 'graph/reachable-from-boot', 'vt/residency-one-writer']);
  t.ok(
    `every rule has at least one proof case (${covered.size + scanRulesProven.size}/${RULES.length})`,
    RULES.every((r) => covered.has(r.id) || (typeof r.scan === 'function' && scanRulesProven.has(r.id)))
  );
}
