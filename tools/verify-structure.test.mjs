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

import { existsSync, readFileSync } from 'node:fs';
import { sep, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RULES,
  validateExceptions,
  applyExceptions,
  evaluateUniformBudgets,
  UNIFORM_CAP,
  extractParamsDeclarations,
  findDeadControlsInTexts,
  findUnwiredSeams,
  UNWIRED_VIEWER_SEAMS,
  sourceFiles,
} from './verify-structure.mjs';
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

  // --- particle memory: storage allocation that must stay in the arena. A NEW
  // invariant (like the log-door cases below), not a V2 line — the arena is
  // built at zero, so the wall proves itself against synthetic offenders.
  {
    rule: 'particles/allocator-only',
    from: 'the disposal-free arena (Particles.md §10) — the allocation that must have ONE owner',
    code: "const positions = instancedArray(capacity, 'vec2');",
    note: 'raw storage allocation outside effects/particles/ has no ceiling and no dispose()',
  },
  {
    rule: 'particles/allocator-only',
    from: 'the lower-level constructor the wall must also catch (both Storage*BufferAttribute spellings)',
    code: 'this._buf = new THREE.StorageInstancedBufferAttribute(new Float32Array(n * 2), 2);',
    note: 'StorageInstancedBufferAttribute inherits BufferAttribute — no dispose(); it belongs to the arena',
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

  // --- the instrument that lied about the author's own settings
  {
    rule: 'panels/no-captured-readout',
    from: 'every effect panel in boot.js, until the 📋 button exported defaults the author never set',
    code: '      const readout = water.getReadout();',
    note: 'a resolve replaces the readout object, so the capture froze at card-build time while the sliders still looked right',
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

  // --- one time-of-day: THE original sin, verbatim
  {
    rule: 'time/one-tod',
    from: 'legacy/core/WeatherController.js:184',
    code: 'this.timeOfDay = 12.0; // Canonical fresh-scene default: clear noon.',
    note: 'the clock lived INSIDE weather; twenty files then grew their own hour',
  },
  {
    rule: 'time/one-tod',
    from: 'legacy: any of the twenty files that kept their own',
    code: 'let todHour = 12;',
    note: 'a MUTABLE local hour is a second clock waiting to drift',
  },

  // --- one atmosphere: the grade that needed a second system to undo it
  {
    rule: 'sky/one-atmosphere',
    from: 'legacy/compositor-v2/effects/ColorCorrectionEffectV2.js (the ToD timeline + outdoor atmosphere)',
    code: 'const todGrade = evaluateTodTimeline(hour, anchors);',
    note: 'atmosphere as a full-screen grade needed a "Local ToD override" to cancel itself in torch pools',
  },
  {
    rule: 'sky/one-atmosphere',
    from: 'legacy: the reach for a saturation knob',
    code: 'const saturationAmount = 1 - cloudCover * 0.5;',
    note: 'a multiply cannot desaturate — the additive veil is what does (Sky.md §5)',
  },

  // --- one grade stack: the 112-uniform, three-family sprawl
  {
    rule: 'grade/one-stack',
    from: 'legacy/compositor-v2/effects/ColorCorrectionEffectV2.js (uCc* family, 13 uniforms)',
    code: 'const uCcSaturation = uniform(1.0);',
    note: 'one of THREE parallel grade families (uCc*/uContext*/uAtmosphere*) — 112 grade uniforms total',
  },
  {
    rule: 'grade/one-stack',
    from: 'legacy/core/context-grade/ContextualSceneGradeManager.js (uContext* family, 18 uniforms)',
    code: 'const uContextGrade = new THREE.Vector3();',
    note: 'the indoor/outdoor context grade that metastasized to 1165 lines + 6 helpers',
  },
  {
    rule: 'grade/one-stack',
    from: 'legacy: a second grade engine growing in an effect',
    code: 'let weatherGrade = computeWeatherGrade();',
    note: 'a `*Grade` owned identifier outside effects/grade/ = a rival grade stack forming',
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

  // --- hand-assembled wind: the four-line block that was copy-pasted at four
  // --- call sites, and the two kernels on an incompatible second shape
  {
    rule: 'wind/handle-only',
    from: 'src/vt/vt-pan-viewer.js (the block, verbatim, at all four material call sites)',
    code: 'bakedField: windBakedField,',
    note: 'the input particle-runtime.js silently omitted for a whole phase — door turbulence never reached the dust',
  },
  {
    rule: 'wind/handle-only',
    from: 'src/effects/candle-flame-render.js (buildCandleFlameMaterial’s old signature)',
    code: 'export function buildCandleFlameMaterial({ THREE, quality, bakedField, wallAvoidField, liveField }) {',
    note: 'a consumer that can NAME the inputs is a consumer that can forget one; taking a handle removes the chance',
  },
  {
    rule: 'wind/handle-only',
    from: 'src/effects/particles/particle-runtime.js (the second, incompatible access shape)',
    code: 'const { openness, cols, rows, originX, originY, cellSize } = opennessGrid;',
    note: 'the compute kernels’ own raw-array shape — hand-unpacked in two files, with the index maths duplicated too',
  },
  {
    rule: 'wind/handle-only',
    from: 'src/diag/wind-field-overlay.js (the overlay that froze its bake for a whole session)',
    code: 'export function buildWindHeatmapMaterial({ THREE, uGlobalTimeMs, ambientWind, liveField }) {',
    note: 'bug #2: a stale material kept the startup bake’s texture forever — "rebaking never visibly changes anything"',
  },

  // --- the old height-gate mechanism: a NEW invariant (like particles/
  // allocator-only above), not a V2 line — depth/authority-only is built at
  // the exact moment the depth authority replaced it as the live-confirmed
  // fix, so there is no legacy/ corpse to cite. Proven against a synthetic
  // offender shaped like what a SECOND effect would have written if this
  // wall did not exist (docs/planning/Light-Elevation-Occlusion-Failure.md).
  {
    rule: 'depth/authority-only',
    from: 'the shape a new consumer would write, absent this wall',
    code: 'combinedFalloff = combinedFalloff.mul(buildHeightGateNode(THREE.TSL, { attrHere, uLightElevationRank }));',
    note: 'fifteen rounds tuning this exact call for point lights; a second effect must reach for the depth authority instead',
  },
  {
    rule: 'depth/authority-only',
    from: "boot.js's own candle/lightning anchor mapping — the grandfathered, still-load-bearing call",
    code: 'elevationRank: resolveAnchorElevationRank(a.floorBinding, lastKnownFloors),',
    note: 'proves the pattern actually matches the real grandfathered call, not just a hypothetical shape',
  },
  // `ui/tokens-only` has no V2 corpse to cite — LANTERN is new, built at U0
  // (docs/holy/UI-Testament.md §9), so there is no legacy/ line where this
  // mistake already happened. `from` says so honestly rather than dressing a
  // synthetic case up as a historical one; the shape mirrors ui/tokens.js's
  // own THEME_TOKENS object exactly, which is what a copy-pasted "just add the
  // token here too" edit in some other file would actually look like.
  {
    rule: 'ui/tokens-only',
    from: 'synthetic — no V2 precedent; LANTERN did not exist before U0',
    code: "  '--shine': '#ffcc00',",
    note: 'a second file redeclaring a token — today matching ui/tokens.js, tomorrow drifted from it',
  },
  // `ui/canon-only` has no V2 corpse either — the NEW canon it protects
  // didn't exist before U0/U1. Shaped like a hand-rolled copy of
  // buildRangeRow appearing in a room file instead of a buildParamControl call.
  {
    rule: 'ui/canon-only',
    from: 'synthetic — no V2 precedent; the LANTERN widget canon did not exist before U0',
    code: "const slider = document.createElement('input'); slider.type = 'range';",
    note: 'a hand-rolled range input outside the canon — the exact shape buildRangeRow already is',
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
  // The particle-arena wall must bite on ALLOCATION only — reserving a slot range
  // and reading a buffer are the sanctioned path and must never trip.
  {
    code: 'const region = arena.reserve(system.capacity);',
    note: 'reserving a slot range is bookkeeping, not allocation',
  },
  { code: 'const positionBuffer = arena.buffers.position;', note: 'reading an arena buffer is not allocating one' },
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
  // `time/one-tod` bans KEEPING an hour, never naming or forwarding one. Its
  // first cut fired on all four of these, every one of which is the system
  // working as designed — a wall that bans the sanctioned path teaches people
  // to obfuscate the name, which hides the concept instead of centralising it.
  {
    code: 'buildEnvSnapshot({ time, todHour, weather });',
    note: 'forwarding the hour you were handed is the sanctioned path',
  },
  { code: 'const h = env.time.todHour;', note: 'READING the hour off the frame snapshot is the whole design' },
  { code: 'const todHour = dayClock.tick(dtSec);', note: 'a const local cannot drift — it is a name, not a clock' },
  { code: 'if (a.todHour === b.todHour) return;', note: 'comparing is not assigning' },
  // `sky/one-atmosphere` bans OWNING an atmosphere knob, never reading the
  // handle that owns it — same distinction as time/one-tod.
  { code: 'envLight.setSky(skyHandle.ambientMultiplierRgb, skyHandle.veilAddRgb);', note: 'reading the sky handle' },
  { code: 'const veil = sky.veil.strength;', note: 'a const local naming the handle’s own value' },
  // `grade/one-stack` bans a rival grade FAMILY/knob, not the primitive's own
  // params, a method call, or a strength scalar. (A FORWARDED resolved grade is
  // deliberately named without the `…Grade` suffix — `const envResolved = …` —
  // so the wall catches "a grade STAGE is forming here" without a false alarm on
  // a value in flight; the viewer/boot already follow this.)
  { code: 'applyGrade(rgb, { exposure, contrast, saturation });', note: 'the grade primitive’s own params' },
  {
    code: 'const envResolved = scaleGradeToIdentity(resolveEnvGrade(env), s);',
    note: 'a forwarded grade, named without the Grade suffix',
  },
  { code: 'gradePresent.setEnvGrade(params);', note: 'a method call, not an owned grade uniform' },
  { code: 'let gradeEnvStrength = 0;', note: 'a strength scalar, not a grade knob family' },
  {
    code: 'MapShine.setGrade = (partial) => {};',
    note: 'a set*Grade public API setter (like setBloom), not a stage assignment',
  },
  // `depth/authority-only` bans the OLD gate's two CALL SITES, never its own
  // pure arithmetic — computeHeightGate/elevationRank stay real, Node-tested
  // functions in their own right (still load-bearing for the grandfathered
  // candle/lightning path) and must never trip just for being referenced.
  {
    code: 'computeHeightGate(elevationRank(0, 9), elevationRank(0, 5))',
    note: "the OLD gate's own pure-arithmetic twins are not banned, only the two call sites that reach the byte",
  },
  {
    code: 'export const LIGHT_ELEVATION_UNCONFIGURED_SENTINEL = 1e6;',
    note: 'the sentinel constant itself is not banned — candle/lightning still legitimately reads it',
  },
  {
    code: 'const rank = depthAuthority.rankOfElevation(light.elevation);',
    note: 'the NEW, sanctioned path this wall exists to push every new consumer toward',
  },
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

  // --- effects/uniform-budget — the single-dimension sibling of the size
  // ratchet, scoped to src/effects/ (Water.md §6.3's "per effect module") ---
  {
    const cap = UNIFORM_CAP; // the REAL exported constant, not a local copy
    const overUniform = [{ rel: 'src/effects/foo.js', uniformCount: cap + 20 }];
    t.ok(
      'a NEW file over the uniform cap with no budget FAILS',
      evaluateUniformBudgets(overUniform, {}, cap).violations.some((v) => v.budget === null)
    );
    t.ok(
      '...growth past a frozen uniform budget FAILS',
      evaluateUniformBudgets(overUniform, { 'src/effects/foo.js': 50 }, cap).violations.some((v) => v.budget === 50)
    );
    const uniformShrink = evaluateUniformBudgets(
      [{ rel: 'src/effects/foo.js', uniformCount: cap + 5 }],
      { 'src/effects/foo.js': 50 },
      cap
    );
    t.ok(
      '...shrinking tightens the uniform budget with no violation',
      uniformShrink.violations.length === 0 && uniformShrink.tightened.some((x) => x.to === cap + 5)
    );
    // Same written-vs-printed split as the size ratchet above — this family
    // shipped with the identical gap, built the same day.
    t.ok(
      '...and the WRITTEN uniform budget is the tighter one',
      uniformShrink.newBudgets['src/effects/foo.js'] === cap + 5
    );
    t.ok(
      '...a uniform VIOLATION leaves the frozen budget alone (never auto-loosens)',
      evaluateUniformBudgets(overUniform, { 'src/effects/foo.js': 50 }, cap).newBudgets['src/effects/foo.js'] === 50
    );
    const underUniform = evaluateUniformBudgets([{ rel: 'src/effects/bar.js', uniformCount: 12 }], {}, cap);
    t.ok(
      'a file UNDER the uniform cap needs no budget and never fails',
      underUniform.violations.length === 0 && Object.keys(underUniform.newBudgets).length === 0
    );
  }

  // --- seams/viewer-wired — the SECOND cross-file rule, built the day a
  // declared-and-defaulted seam shipped without ever being passed ----------
  {
    const viewer = 'export async function startVtPanViewer({\n  renderer,\n  getThing,\n  getOther,\n}) {';

    t.ok(
      'a seam passed as shorthand is wired',
      findUnwiredSeams(viewer, 'start({\n  renderer,\n  getThing,\n  getOther,\n})').length === 0
    );
    t.ok(
      'a seam passed explicitly (name: value) is wired',
      findUnwiredSeams(viewer, 'start({\n  renderer,\n  getThing: x.y,\n  getOther,\n})').length === 0
    );

    // THE ACTUAL BUG, as a test. `water.getRenderState` existed, worked, and
    // was never handed over; a substring search for the seam name would have
    // found the local declaration and called it wired.
    t.ok(
      'a LOCAL of the seam`s name does NOT count as wired — the exact 2026-07-26 miss',
      findUnwiredSeams(viewer, 'const getOther = () => 1;\nstart({\n  renderer,\n  getThing,\n})').join(',') ===
        'getOther'
    );
    t.ok(
      'a seam merely MENTIONED in prose does not count either',
      findUnwiredSeams(viewer, '// getOther hands the viewer its state\nstart({\n  renderer,\n  getThing,\n})').join(
        ','
      ) === 'getOther'
    );
    t.ok(
      'a documented-unwired seam is exempt, so the rule sits at zero honestly',
      Object.prototype.hasOwnProperty.call(UNWIRED_VIEWER_SEAMS, 'getOcclusionInputs')
    );
    // The real files, checked for real — this is what keeps the rule at zero.
    t.ok(
      'the SHIPPED viewer/boot pair has no unwired seams',
      findUnwiredSeams(
        readFileSync(join(ROOT, 'src/vt/vt-pan-viewer.js'), 'utf8'),
        readFileSync(join(ROOT, 'src/boot.js'), 'utf8')
      ).length === 0
    );
  }

  // --- params/no-dead-controls — THE FIRST cross-file structural rule -----
  {
    // extractParamsDeclarations: brace-depth key extraction.
    const decl = extractParamsDeclarations([
      'export const FOO_PARAMS = Object.freeze({',
      '  // a comment naming a fakeKey: { should not be mistaken for a real key',
      '  tintColor: {',
      "    type: 'color',",
      "    space: 'srgb',",
      '  },',
      '  tintStrength: {',
      "    type: 'float',",
      '  },',
      '});',
    ]);
    t.ok('extractParamsDeclarations finds the params name', decl.length === 1 && decl[0].paramsName === 'FOO_PARAMS');
    t.ok(
      'extractParamsDeclarations finds both real keys, in order',
      decl[0].keys.length === 2 && decl[0].keys[0] === 'tintColor' && decl[0].keys[1] === 'tintStrength'
    );
    t.ok(
      "extractParamsDeclarations does NOT mistake a comment's own text for a key",
      !decl[0].keys.includes('fakeKey')
    );

    // An EMPTY schema (water.js's own current shape) — zero keys, not a parse
    // failure.
    const emptyDecl = extractParamsDeclarations(['export const EMPTY_PARAMS = Object.freeze({});']);
    t.ok(
      'an empty PARAMS object yields zero keys, not a crash',
      emptyDecl.length === 1 && emptyDecl[0].keys.length === 0
    );

    // findDeadControlsInTexts: the actual V2 disease, reproduced —
    // a param declared with NO consumer anywhere else in the tree.
    const deadFixture = [
      {
        rel: 'src/effects/fake/fake.js',
        text:
          'export const FAKE_PARAMS = Object.freeze({\n' +
          '  bathymetryEnabled: {\n' +
          "    type: 'bool',\n" +
          '  },\n' +
          '});\n',
      },
      { rel: 'src/effects/fake/fake-render.js', text: '// nothing here reads bathymetryEnabled at all\n' },
    ];
    const deadHits = findDeadControlsInTexts(deadFixture);
    t.ok(
      'a param with NO consumer anywhere is caught (the V2 "Bathymetry" disease)',
      deadHits.some((v) => v.key === 'bathymetryEnabled' && v.paramsName === 'FAKE_PARAMS')
    );

    // The SAME key, but genuinely consumed in a sibling file — not a
    // violation. Proves the wall does not just flag every key on principle.
    const liveFixture = [
      {
        rel: 'src/effects/fake/fake.js',
        text: "export const FAKE_PARAMS = Object.freeze({\n  tintStrength: {\n    type: 'float',\n  },\n});\n",
      },
      // The REAL codebase's dominant consumption pattern is bare-key access
      // on the resolved params object (verified: bloom's own `threshold` is
      // read as `p.threshold` in vt-pan-viewer.js, not a `uThreshold`-
      // prefixed local) — this fixture matches that, not an invented one.
      { rel: 'src/effects/fake/fake-render.js', text: 'u.strength.value = fakeNum(p.tintStrength, 1.0);\n' },
    ];
    t.ok('a param genuinely referenced elsewhere is NOT flagged', findDeadControlsInTexts(liveFixture).length === 0);

    // Consumption in an ENTIRELY different zone counts (ui-window-shadow.js's
    // own real shape: declared in effects/, consumed in boot.js) — proves the
    // whole-tree scope, not a directory-scoped one, which is the whole reason
    // this design was chosen (see findDeadControls's own module comment).
    const crossZoneFixture = [
      {
        rel: 'src/effects/ui-window-shadow.js',
        text: "export const UI_SHADOW_PARAMS = Object.freeze({\n  strength01: {\n    type: 'float',\n  },\n});\n",
      },
      { rel: 'src/boot.js', text: 'const s = resolved.params.strength01; // consumed far from the declaration\n' },
    ];
    t.ok(
      "cross-zone consumption counts (ui-window-shadow.js's real shape)",
      findDeadControlsInTexts(crossZoneFixture).length === 0
    );

    // The REAL codebase, right now, has zero dead controls — this is the
    // wall built at the cheapest possible moment (Skeleton.md's own phrase
    // for a wall with no debt to grandfather). sourceFiles() with no args
    // uses its own default (src/), the SAME set the real check scans.
    const realFiles = sourceFiles().map((f) => ({
      rel: relative(ROOT, f).replace(/\\/g, '/'),
      text: readFileSync(f, 'utf8'),
    }));
    t.ok(
      'the REAL codebase has zero dead controls today (no ratchet needed)',
      findDeadControlsInTexts(realFiles).length === 0
    );
  }

  // ---- ui/tokens-only: the ONE DOOR (ui/tokens.js itself) must be open, and
  // the wall must not bite the hundreds of legitimate `var(--token, ...)`
  // READS the widget canon and every room actually contain -----------------
  {
    const rule = RULES.find((r) => r.id === 'ui/tokens-only');
    t.ok("'ui/tokens-only' exists", !!rule);
    if (rule) {
      const tokensRel = `src${sep}ui${sep}tokens.js`;
      t.ok(
        'the token table itself may declare tokens (the door is open)',
        rule.allow.some((a) => tokensRel.includes(a))
      );
      t.ok('ui/tokens.js exists on disk', existsSync(join(ROOT, 'src', 'ui', 'tokens.js')));
      t.ok(
        'a second declaration site with the SAME value still trips the wall (today-identical is still a second writer)',
        rule.pattern.test("'--bg0': '#14161d',")
      );
      // The whole reason `param-control.js` exists post-U0: hundreds of reads
      // like this, none of which are a declaration.
      t.ok(
        'a var(--token, fallback) READ never trips the wall',
        !rule.pattern.test("const ACCENT = 'var(--shine, rgb(143,214,255))';")
      );
      t.ok('a bare CSS var() usage never trips it either', !rule.pattern.test('color: var(--ink1);'));
      t.ok(
        "an UNRELATED custom property (not in LANTERN's vocabulary) never trips it",
        !rule.pattern.test("'--totally-unrelated-thing': '3px',")
      );
    }
  }

  // ---- ui/canon-only: the door (ui/widgets/ + the two grandfathered diag
  // files) is open, the wall bites the three input types the canon owns, and
  // it does NOT bite the legitimate structural `<button>`/`<select>`/text-
  // `<input>` construction every Studio room file actually contains --------
  {
    const rule = RULES.find((r) => r.id === 'ui/canon-only');
    t.ok("'ui/canon-only' exists", !!rule);
    if (rule) {
      const widgetsRel = `src${sep}ui${sep}widgets${sep}param-control.js`;
      const debugPanelRel = `src${sep}diag${sep}debug-panel.js`;
      t.ok(
        'the canon itself may build these three input types (the door is open)',
        rule.allow.some((a) => widgetsRel.includes(a))
      );
      t.ok(
        'the grandfathered old panel may too, until re-homed',
        rule.allow.some((a) => debugPanelRel.includes(a))
      );
      t.ok(
        'ui/widgets/param-control.js exists on disk',
        existsSync(join(ROOT, 'src', 'ui', 'widgets', 'param-control.js'))
      );

      for (const type of ['range', 'checkbox', 'color']) {
        t.ok(
          `a hand-rolled input.type = '${type}' outside the canon trips the wall`,
          rule.pattern.test(`el.type = '${type}';`)
        );
      }
      t.ok('double-quoted works too, not just single', rule.pattern.test('el.type = "range";'));

      // Real lines from this session's own new Studio room files — the wall
      // must stay silent on all of them, or every room file becomes an
      // instant, permanent exception.
      const realStructuralLines = [
        "enableBtn.type = 'button';",
        "closeBtn.type = 'button';",
        "const select = document.createElement('select');",
        "input.placeholder = 'Search every control — try “opacity”, “glow”, “direction”…';",
      ];
      for (const line of realStructuralLines) {
        t.ok(`ALLOWS real Studio room code: ${line}`, !rule.pattern.test(line));
      }
    }
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
