/**
 * THE PASS LIST — the fixed node graph of the whole renderer, declared as data.
 *
 * ============================================================================
 * WHAT THIS IS (and the mental model, in the author's own language)
 * ============================================================================
 *
 * This is the Nuke script of the engine. A fixed DAG of nodes; every node
 * declares what it reads and what it writes; the connections ARE the pipeline.
 * Porting an effect later means parameterising one of these nodes — it never
 * means adding new wiring, because all the wiring that will ever exist is
 * declared HERE, once, visibly.
 *
 * V2 had no such graph. It had 46 effects each grabbing what they wanted
 * through `window.MapShine` — a comp where any node can secretly read any
 * other node's output with no visible pipe. The result is measured in
 * docs/planning/Effects-API.md: 643 hand-written touch points, 70 private
 * render targets, a Lighting↔Fire dependency CYCLE through private fields,
 * and a 10,063-line god-object doing by hand what a graph derives for free.
 *
 * THE RESOURCE GRAMMAR (Effects-API.md §5):
 *   vt:*   a virtual-texture layer pack (world data, streamed in pages)
 *   buf:*  a screen-sized buffer this frame (an AOV, in lookdev terms)
 *   res:*  a non-image resource (the env snapshot, light lists, sim state)
 *
 * THE ONE-PRODUCER RULE, stated as a film-set rule: one department OPENS each
 * file (`creates`); later departments may APPEND (`modifies` — an explicit
 * read-modify-write); nobody touches a file before it exists. The Node test
 * (`pass-declarations.test.mjs`) proves the whole list obeys this — so the
 * "unified plan" is not a diagram in a doc, it is an executable invariant.
 * V2's Lighting↔Fire knot, declared here, would be a FAILING TEST.
 *
 * STATUS is honest, not aspirational:
 *   'live'   the code exists and runs today
 *   'seam'   a throwing NotBuilt door exists (Skeleton.md §2.2)
 *   'future' declared only — this file IS its first artifact
 *
 * `absorbs` lists the V2 classes whose JOB this pass takes over — the 48→~12
 * collapse from Keyhole §4.4, made checkable: the test totals them, so the
 * mapping cannot silently drop an effect family.
 *
 * @module graph/passes
 */

/** Frame stages, in execution order. CPU stages feed the GPU stages. */
export const STAGES = Object.freeze([
  'frame',
  'residency',
  'sims',
  'masks',
  'geometry',
  'lighting',
  'surface',
  'post',
  'present',
]);

/**
 * @typedef {object} PassDecl
 * @property {string} id
 * @property {string} stage - one of {@link STAGES}
 * @property {'cpu'|'gpu'} kind
 * @property {'live'|'seam'|'future'} status
 * @property {string} owns - the design doc that governs this pass
 * @property {string[]} creates - resources this pass brings into existence
 * @property {string[]} reads - resources consumed (must exist earlier in the list)
 * @property {string[]} modifies - explicit read-modify-write (must exist earlier)
 * @property {string[]} absorbs - V2 classes/systems whose job this pass takes over
 * @property {string} note - one line of intent
 */

/** @type {PassDecl[]} — ARRAY ORDER IS FRAME ORDER. That is the whole DAG. */
export const PASSES = [
  {
    id: 'frame.snapshot',
    stage: 'frame',
    kind: 'cpu',
    status: 'future',
    owns: 'docs/planning/Environment.md §2.1 + Engine-Postmortem.md §7 (the FrameState instinct, kept)',
    creates: ['res:env', 'res:view', 'res:scene'],
    reads: [],
    modifies: [],
    absorbs: [
      'WeatherController(state)',
      'core/time.js',
      'SunDirection',
      'ShadowDriverState',
      'frame-state.js',
      'foundry-time-phases',
    ],
    note:
      'ONE per-frame read-only snapshot: time, sun (computed ONCE), weather, wind, darkness, camera, ' +
      'scene docs — the call sheet every later pass reads. Kills the eight suns, the twenty clocks, ' +
      'and the darkness feedback bus.',
  },
  {
    id: 'vt.residency',
    stage: 'residency',
    kind: 'cpu',
    status: 'live',
    owns: 'Keyhole.md §4.1 (the keyhole itself)',
    creates: ['vt:albedo', 'vt:masks'],
    reads: ['res:view', 'res:scene'],
    modifies: [],
    absorbs: ['GpuSceneMaskCompositor', 'pyramid/streaming stack', 'pixi-texture-demotion(all sweeps)'],
    note:
      'Analytic visible-page planning, decode (with per-page CPU extractors — the spawn-point fix), ' +
      'atlas upload. The 4,959-line world-res mask baker becomes vtSample(). Runs today.',
  },
  {
    id: 'sims.particles',
    stage: 'sims',
    kind: 'gpu',
    status: 'seam',
    owns: 'docs/planning/Particles.md §7 + keyhole-particles-tsl-decision',
    creates: ['res:particles'],
    reads: ['res:env', 'res:view'],
    modifies: [],
    absorbs: [
      'WeatherParticles(sim)',
      'SmellyFliesEffect(sim)',
      'AshDisturbanceEffectV2',
      'DustEffectV2(sim)',
      'WaterSplashesEffectV2(sim)',
      'RoofDrip*',
    ],
    note:
      'ONE engine, TSL compute (transform feedback on WebGL2). A weather type is DATA. Coverage- and ' +
      'zoom-gated (Effects.md Law 7). The door already throws; the walls already bite.',
  },
  {
    id: 'sims.fluids',
    stage: 'sims',
    kind: 'gpu',
    status: 'future',
    owns: 'docs/planning/Water.md §5 (tiers 7+) + Keyhole §4.4 (water is the honest hard case)',
    creates: ['res:fluidSim'],
    reads: ['res:env', 'res:view', 'vt:masks'],
    modifies: [],
    absorbs: ['FluidEffectV2', 'FireEffectV2(sim)', 'CandleFlamesEffectV2(sim)'],
    note:
      'Ping-pong sim grids (water flow, fire), sim-res never world-res, top rungs of their ladders ' +
      'only — tier 0 water needs no sim at all.',
  },
  {
    id: 'masks.occlusion',
    stage: 'masks',
    kind: 'gpu',
    status: 'seam',
    owns: 'Keyhole.md §"THE REMAINING PIECE" + scene/occlusion.js (the ported, tested model)',
    creates: ['buf:occlusion'],
    reads: ['res:scene', 'res:view'],
    modifies: [],
    absorbs: ['CanvasOcclusionMask(re-impl)', 'OverheadStampEffectV2(token-fade half)'],
    note:
      "Foundry's RGBA occlusion mask (R=Fade G=Radial B=Vision A=Surface, elevation-indexed, MIN " +
      'blend) — tokens fading roofs. Unblocked since tokens render; the last piece of the original ' +
      'tiles directive.',
  },
  {
    id: 'geometry.world',
    stage: 'geometry',
    kind: 'gpu',
    status: 'live',
    owns: 'Keyhole.md §4.2 + reference_foundry_v14_layering_law (the ONE flat sort law)',
    creates: ['buf:scene.color', 'buf:scene.attr', 'buf:scene.depth'],
    reads: ['vt:albedo', 'vt:masks', 'res:view', 'buf:occlusion'],
    modifies: [],
    absorbs: [
      'FloorCompositor',
      'FloorRenderBus',
      'LevelCompositePass',
      'tile-manager(draw)',
      'TokenManager(draw)',
      'TreeEffectV2(billboards)',
      'BushEffectV2(billboards)',
    ],
    note:
      'THE unified world draw: every drawable — level art, tiles, tokens, vegetation billboards — is ' +
      'one flat list under elevation→sortLayer→sort→zIndex, MRT-writing color + the attribute buffer ' +
      '(floorId/outdoors/coverage — the utility AOV every cheap trick reads). Live today as the ' +
      'vt-pan-viewer; becomes this pass by rename.',
  },
  {
    id: 'light.visibility',
    stage: 'lighting',
    kind: 'gpu',
    status: 'future',
    owns: 'docs/planning/Light-and-Shadow.md §4 (shadow = absence of a SPECIFIC light)',
    creates: ['res:vis'],
    reads: ['res:env', 'res:scene', 'vt:masks', 'buf:scene.attr'],
    modifies: [],
    absorbs: [
      'BuildingShadowsEffectV2',
      'SkyReachShadowsEffectV2',
      'PaintedShadowEffectV2',
      'OverheadStampEffectV2(shadow half)',
      'VegetationBillboardShadowPass',
      'CloudEffectV2(shadow half)',
      'ShadowManagerV2',
      'DynamicLightShadowLift(DELETED, not absorbed)',
    ],
    note:
      "Per-light visibility terms. The sun's term min-combines producers that all MEAN the same " +
      'thing: authored _Shadow (the paintbrush, promoted to canon) ∧ building ∧ sky-reach ∧ cloud. ' +
      'Dynamic lights use Foundry wall-clipped LOS. NO combined-shadow, NO lift — those words fail ' +
      'the build.',
  },
  {
    id: 'light.accumulate',
    stage: 'lighting',
    kind: 'gpu',
    status: 'seam',
    owns: 'docs/planning/Light-and-Shadow.md §1 + Keyhole §4.2 (harvested ForwardLightingPass semantics)',
    creates: ['buf:scene.illum'],
    reads: ['res:env', 'res:vis', 'res:scene', 'buf:scene.attr', 'vt:masks'],
    modifies: ['buf:scene.color'],
    absorbs: [
      'LightingEffectV2',
      'PlayerLightEffectV2',
      'WindowLightEffectV2',
      'LightningEffectV2',
      'WeatherLightningEffectV2',
      'SkyColorEffectV2',
      'ThreeLightSource',
    ],
    note:
      'illum = skyAmbient×skyVis + Σ(light×its OWN visibility). The sun is a light. Lightning is a ' +
      'light. A torch is a light. Then color ×= illum. The five-step pile-up has no combatants here.',
  },
  {
    id: 'surface.response',
    stage: 'surface',
    kind: 'gpu',
    status: 'future',
    owns: 'Effects-API.md §5 (the worked SPECULAR declaration) + Effects.md (the ladder)',
    creates: [],
    reads: ['vt:masks', 'buf:scene.illum', 'buf:scene.attr', 'res:env'],
    modifies: ['buf:scene.color'],
    absorbs: ['SpecularEffectV2', 'IridescenceEffectV2', 'PrismEffectV2', 'RoughnessEffectV2', 'NormalEffectV2'],
    note:
      'One material term: shine/iridescence/wetness reading the packed specular VT layer × illum × ' +
      'weather wetness. Additive into color. Five V2 classes, one node with tiers.',
  },
  {
    id: 'surface.water',
    stage: 'surface',
    kind: 'gpu',
    status: 'future',
    owns: 'docs/planning/Water.md (the full audit + ladder + cross-floor rule)',
    creates: [],
    reads: ['vt:masks', 'buf:scene.illum', 'buf:scene.attr', 'res:env', 'res:fluidSim'],
    modifies: ['buf:scene.color'],
    absorbs: ['WaterEffectV2', 'water-shader.js(look, harvested)'],
    note:
      'The tier ladder from blue-in-the-right-place to refraction. Carries the fifteen-line ' +
      'cross-floor borrow rule at tier 0 — correctness never rides the ladder. First Stage 6 port.',
  },
  {
    id: 'surface.particles',
    stage: 'surface',
    kind: 'gpu',
    status: 'seam',
    owns: 'docs/planning/Particles.md §7 (draw half — instanced, batched, never a scene object per particle)',
    creates: [],
    reads: ['res:particles', 'buf:scene.attr', 'res:view'],
    modifies: ['buf:scene.color'],
    absorbs: [
      'WeatherParticles(draw)',
      'RainStreakGeometry',
      'SnowGeometry',
      'AshCloudEffectV2(draw)',
      'FireEffectV2(glow draw)',
      'CandleFlamesEffectV2(draw)',
    ],
    note:
      'Instanced quads/streaks over the lit scene, gated per-pixel by the attribute buffer (rain ' +
      'only outdoors). Draw half of the one engine; sim half ran in sims.particles.',
  },
  {
    id: 'post.grade',
    stage: 'post',
    kind: 'gpu',
    status: 'future',
    owns: 'docs/planning/Environment.md §2.3 (the grade stack with a DEFINED order)',
    creates: ['buf:final'],
    reads: ['buf:scene.color', 'buf:scene.attr', 'buf:scene.depth', 'res:env'],
    modifies: [],
    absorbs: [
      'ColorCorrectionEffectV2',
      'ContextualSceneGradeEffectV2',
      'BloomEffectV2',
      'AtmosphericFogEffectV2',
      'FloorDepthBlurEffect',
      'DistortionManager',
      'LensEffectV2',
      'AsciiEffectV2',
      'HalftoneEffectV2',
      'DotScreenEffectV2',
      'SepiaEffectV2',
      'DazzleOverlayEffectV2',
      'FilterEffectV2',
    ],
    note:
      'THE GRADE STACK, in fixed node order: base → ToD (8-anchor timeline) → weather → context ' +
      'gate (indoor/outdoor from attr) → manual trim — then bloom, fog, distortion, stylizers. Four ' +
      'colorists become one node chain with labeled layers.',
  },
  {
    id: 'present.composite',
    stage: 'present',
    kind: 'gpu',
    status: 'live',
    owns: 'Keyhole.md §4.3 (the safety slide) + graph/fullscreen-present.js (harvested)',
    creates: [],
    reads: ['buf:final'],
    modifies: [],
    absorbs: ['FullscreenPresent', 'render-loop(present half)', 'FogOfWarEffectV2(composite point)'],
    note:
      'Tonemap + present + the Foundry fog/UI handoff, and the safety-slide boundary: if anything ' +
      'above failed, this is where Foundry takes back the frame — announced, never silent.',
  },
];

/**
 * Validate the pass list as a GRAPH — the executable half of "a unified plan".
 *
 * Array order is frame order, so the DAG check reduces to: nothing is read or
 * modified before the pass that creates it, and each resource is created
 * exactly once. This is the rule that makes V2's Lighting↔Fire cycle — two
 * passes each reaching for the other's output — impossible to even DECLARE.
 *
 * @param {PassDecl[]} passes
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validatePassGraph(passes) {
  const errors = [];
  const fail = (m) => errors.push(m);
  const ids = new Set();
  const created = new Map(); // resource -> pass id that created it

  const NAMESPACE = /^(vt|buf|res):[a-zA-Z][\w.]*$/;
  let lastStageIndex = 0;

  for (const p of passes) {
    if (ids.has(p.id)) fail(`duplicate pass id '${p.id}'`);
    ids.add(p.id);

    const stageIndex = STAGES.indexOf(p.stage);
    if (stageIndex === -1) fail(`${p.id}: unknown stage '${p.stage}'`);
    if (stageIndex < lastStageIndex) fail(`${p.id}: stage '${p.stage}' is out of order — array order IS frame order`);
    lastStageIndex = Math.max(lastStageIndex, stageIndex);

    if (!p.owns || p.owns.length < 10) fail(`${p.id}: must cite the doc that owns it`);
    if (!Array.isArray(p.absorbs) || p.absorbs.length === 0) {
      fail(`${p.id}: must list the V2 systems it absorbs (or state its V2 novelty explicitly)`);
    }

    for (const r of [...p.creates, ...p.reads, ...p.modifies]) {
      if (!NAMESPACE.test(r)) fail(`${p.id}: resource '${r}' must match vt:|buf:|res: grammar`);
    }
    for (const r of p.reads) {
      if (!created.has(r)) fail(`${p.id}: reads '${r}' before any pass creates it`);
    }
    for (const r of p.modifies) {
      if (!created.has(r)) fail(`${p.id}: modifies '${r}' before any pass creates it`);
      if (p.creates.includes(r)) fail(`${p.id}: cannot both create and modify '${r}'`);
    }
    for (const r of p.creates) {
      if (created.has(r)) {
        fail(`${p.id}: '${r}' already created by '${created.get(r)}' — ONE producer per resource`);
      }
      created.set(r, p.id);
    }
  }
  return { ok: errors.length === 0, errors };
}
