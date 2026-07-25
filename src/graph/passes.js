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
      // Closes the absorb-gap audit (2026-07-18, docs/reference/v2-effect-
      // params/README.md's "no V3 pass claims this" list): 35 controls, all
      // direction/speed/gustiness — exactly world/environment.js's DEFAULT_WIND
      // shape (directionDeg/speed01/gustiness01), which this pass already owns.
      'SceneWindField',
    ],
    note:
      'ONE per-frame read-only snapshot: time, sun (computed ONCE), weather, wind, darkness, camera, ' +
      'scene docs — the call sheet every later pass reads. Kills the eight suns, the twenty clocks, ' +
      'and the darkness feedback bus. PURE CORE BUILT + Node-tested (world/environment.js, world/sun.js, ' +
      'core/frame-clock.js); status stays future until the pass is wired into the frame loop.',
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
    status: 'live',
    owns: 'docs/planning/Particles.md §7, §23 + keyhole-particles-tsl-decision',
    creates: ['res:particles'],
    // Narrowed to res:env (time/dt) — the only live-produced read the first-slice
    // kernel needs, the same discipline light.accumulate takes. It samples the
    // wind field via world/wind-field.js#sampleWind's TSL-analytic Tier-0 ambient
    // (no res:wind resource yet); res:wind returns here when the baked/sim field
    // is bound (Wind.md Tier 1+). res:view / buf:scene.attr return with view
    // gating + the outdoors gate (higher rungs).
    reads: ['res:env'],
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
      'zoom-gated (Effects.md Law 7). LIVE as of 2026-07-21 (first slice: ambient dust): ' +
      'createParticleEngine dispatches the update kernel via a DIRECT renderer.compute() in renderFrame, ' +
      'right after tickWindSim — the sims stage is out of the plan range (framePlan fromStage:masks), so ' +
      'this is driven like the wind sim, not via runPassPlan. `live` = the sim runs every frame, not ' +
      'that every rung is built (curl/lifespan/gating are higher rungs — Particles.md §22).',
  },
  {
    id: 'sims.fluids',
    stage: 'sims',
    kind: 'gpu',
    status: 'seam',
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
    status: 'live',
    owns: 'Keyhole.md (the occlusionMask block in vt-pan-viewer.js) + scene/occlusion.js (the ported, tested model)',
    creates: ['buf:occlusion'],
    reads: ['res:scene', 'res:view'],
    modifies: [],
    absorbs: ['CanvasOcclusionMask(re-impl, RADIAL channel only)', 'OverheadStampEffectV2(token-fade half)'],
    note:
      'RADIAL ONLY as of 2026-07-18 (G channel: token discs, MIN-blended, real elevation-indexed). ' +
      'R (FADE) and B (VISION) stay inert — neither is wired; A (SURFACE) — the default mode for ' +
      "level/roof art and this feature's headline case — needs Foundry's separate Region/Surfaces " +
      'system (Scene#getSurfaces/polygonTree), not built at all. `live` here means the RADIAL ' +
      'channel genuinely runs every frame against real document data, not that the pass is complete — ' +
      'same honesty bar geometry.world already sets for its own partial buf:scene.attr claim.',
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
      'one flat list under elevation→sortLayer→sort→zIndex. buf:scene.attr is REAL as of 2026-07-25 ' +
      '(B0-1, vt/scene-attr.js) — base map/tile art and Case-1 embedded vegetation MRT-write floorId/' +
      'outdoors/presence-bit0/solidity; every overlay (vegetation Case-2, doors, tokens) writes the ' +
      'safe zero-default for free. TWO honest gaps, not silent ones: presence bit 1 (levelsHidden) is ' +
      "not derived (needs the VIEWED floor, which changes at runtime, compared against an item's own " +
      "floor, resolved once at build time); the clear value is the renderer's ordinary (0,0,0,0), not " +
      "B0-1 §2.1's (255,0,0,0) sentinel (no per-attachment MRT clear found in the vendored three.js) — " +
      'consumers should read attr.a>0 for "is anything drawn here", never trust R\'s zero as absence. ' +
      'Live today as the vt-pan-viewer; becomes this pass by rename. Same honesty bar masks.occlusion ' +
      'sets for its own partial claim.',
  },
  {
    id: 'light.visibility',
    stage: 'lighting',
    kind: 'gpu',
    status: 'seam',
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
      'thing: the authored shadow mask (the paintbrush, promoted to canon — scene/mask-catalog.js) ' +
      '∧ building ∧ sky-reach ∧ cloud. Dynamic lights use Foundry wall-clipped LOS. NO ' +
      'combined-shadow, NO lift — those words fail the build. ' +
      "STILL A SEAM, and the reason is worth stating (2026-07-24): the sun's OWN term is now BUILT " +
      'and live — building + overhead + sky-reach march one occluder height field into a scene-space ' +
      'field that multiplies the ambient fill (docs/planning/Sun-Shadows.md, effects/lighting/' +
      'sun-occlusion*.js). But it landed the same way the UI-shadow did: folded INSIDE ' +
      'light.accumulate rather than as its own screen-space pass, because the field is WORLD-aligned ' +
      'and camera-independent — a per-frame screen buffer would be strictly more work for an ' +
      'identical picture. This pass earns its keep when a SECOND light needs its own visibility ' +
      '(per-light tile occlusion), not before. A seam that names what exists beats a `live` that ' +
      'describes a buffer nobody writes.',
  },
  {
    id: 'light.accumulate',
    stage: 'lighting',
    kind: 'gpu',
    status: 'live',
    owns: 'docs/planning/Light-and-Shadow.md §1 + Keyhole §4.2 (harvested ForwardLightingPass semantics) + docs/planning/Light-Parity.md',
    creates: ['buf:scene.illum'],
    // `reads` stays narrowed to res:env even now that point lights are live
    // (2026-07-18): light DATA comes from a direct foundry/scene-lights.js
    // adapter read (canvas.effects.lightSources), the same shortcut
    // geometry.world already takes for its own res:view/res:scene reads —
    // not a formally-produced graph resource yet. res:vis / buf:scene.attr /
    // vt:masks return to this list as the shadow (light.visibility) and
    // indoor/outdoor (_Outdoors) rungs land — declaring an unproduced read
    // while live is a pass-health ERROR, so a read appears here only when a
    // producer for it does (pass-health.js STARVED).
    reads: ['res:env'],
    modifies: ['buf:scene.color'],
    absorbs: [
      'LightingEffectV2',
      'PlayerLightEffectV2',
      'WindowLightEffectV2',
      'LightningEffectV2',
      'WeatherLightningEffectV2',
      'SkyColorEffectV2',
      'ThreeLightSource',
      // Closes the absorb-gap audit (2026-07-18): a 1-control tint on how
      // darkvision/etc. read the lit scene — SUPERSEDED, not ported. Fog/
      // vision stay with Foundry's own PIXI rendering (keyhole-vision-fog-
      // direction, memory) — MSA does not own vision mode until that day.
      'VisionModeEffectV2(SUPERSEDED — stays with Foundry, not MSA-rendered)',
    ],
    note:
      'AMBIENT/EXTERIOR + POINT-LIGHT ILLUMINATION + COLORATION + GLOBAL ILLUMINATION + REGION-DRIVEN ' +
      "DARKNESS as of 2026-07-19: buf:scene.illum = Foundry's ambient background mix(daylight, " +
      "darkness, DL) (DL the scene darkness), raised to the scene's Global Illumination floor when " +
      'enabled + within its own darkness window (foundry/scene-lights.js#deriveGlobalLightConfig — ' +
      'verified against source that the global light needs its OWN handling, not the circular point-' +
      'light mesh pipeline: GlobalLightSource skips PointEffectSourceMixin entirely); darkness-' +
      'adjusting Regions ("Adjust Darkness Level" behavior — foundry/scene-regions.js + effects/' +
      'lighting/region-darkness.js) then OVERWRITE their own footprint with a per-fragment analytic ' +
      'shape test (rectangle/ellipse/polygon, discard-outside — no render-to-texture pipeline built ' +
      'for this), re-mixed by their OWN mode/modifier (OVERRIDE/BRIGHTEN/DARKEN, verbatim formulas); ' +
      "MAX-blended with every active AmbientLight source's default-technique illumination (ratio/" +
      'switchColor/attenuation falloff + a soft analytic-SDF edge + luminosity-driven exposure — ' +
      'effects/lighting/point-light-illumination.js), each gated by its OWN darkness activation window ' +
      '(LightData.darkness {min,max}, default {0,1} — a GM can set a torch to "dusk only"); then ' +
      'scene.color ×= illum (in gamma space — effects/lighting/environmental-light.js). SEPARATELY, ' +
      "buf:scene.coloration accumulates each light's OWN colour (default coloration technique only — " +
      '"Adaptive Luminance", finalColor = color × colorationAlpha × perceivedBrightness(mapColour), ' +
      'sampled via screenUV off buf:scene.color — effects/lighting/point-light-coloration.js), MAX-' +
      "blended across lights (a documented approximation of Foundry's own SCREEN-per-mesh combine — " +
      'identical wherever at most one light reaches a pixel) and ADDED onto scene.lit afterward (audit ' +
      '§6\'s own "SCREEN per-mesh, ADD onto scene", the ADD half exact). Point-light shape is ' +
      "Foundry's OWN wall-clipped polygon (source.shape.points, fan-triangulated) — walls are already " +
      'free here; no separate visibility work needed for point lights, only for the SUN. `live` means ' +
      'these terms run every frame against real Foundry data, NOT that the pass is complete — the ' +
      'other 12 coloration techniques, contrast/saturation/shadow adjustments, darkness sources, and ' +
      "animations are later rungs (Light-Parity.md §5); elevation occlusion, the region system's own " +
      "Clipper-CSG/elevation gate, the global light's OWN (currently colourless) coloration, and the " +
      "interaction between Global Illumination's floor and a region's own overwrite (region-darkness." +
      "js's own header names this last one precisely) are documented, accepted simplifications, not " +
      'silent gaps. Same honesty bar geometry.world/masks.occlusion set for their own partial claims.',
  },
  {
    id: 'surface.response',
    stage: 'surface',
    kind: 'gpu',
    status: 'seam',
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
    status: 'seam',
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
    status: 'live',
    owns: 'docs/planning/Particles.md §7, §16 (draw half — instanced, batched, never a scene object per particle)',
    creates: [],
    // Narrowed to res:particles (the sim output it draws, produced by
    // sims.particles). buf:scene.attr returns when the per-pixel outdoors gate
    // lands (a higher rung); res:view drops (no live producer).
    reads: ['res:particles'],
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
      'only outdoors). Draw half of the one engine; sim half ran in sims.particles. LIVE as of ' +
      '2026-07-21 (first slice: ambient dust): ONE InstancedBufferGeometry draw of the engine scene, ' +
      'additively into scene.lit, as a viewer closure in the local passImpls map (mirrors the candle ' +
      'flame). Per-pixel gating is a higher rung.',
  },
  {
    id: 'post.bloom',
    stage: 'post',
    kind: 'gpu',
    status: 'live',
    owns: 'docs/planning/Bloom.md (the dual-filter pyramid + the two-band core/atmosphere model)',
    creates: [],
    reads: [],
    modifies: ['buf:scene.color'],
    absorbs: ['BloomEffectV2'],
    note:
      'THE FIRST POST-STAGE EFFECT — the template the next post effect (fog, distortion, stylizers) ' +
      'copies. A Jimenez/COD dual-filter pyramid (13-tap downsample + Karis on the first step, ' +
      'tent-filter upsample) split into an independently-weighted tight CORE and wide ATMOSPHERE ' +
      "band out of ONE blur chain — V2's Surface/Atmosphere split for free. The bright-pass INPUT " +
      'is darkened by a world-space mask (outdoor-spill clamp via the outdoors mask; the SAME hook takes a ' +
      'native fog-of-war texture later) so bloom cannot leak where it is not visible. Additively ' +
      'modifies scene.lit BEFORE present, so the grade grades the scene AND its bloom together. ' +
      "Runtime: runPostBloomPass, a closure in the viewer's local passImpls (mirrors " +
      'surface.particles); PASS_IMPLS names startVtPanViewer as the reachable door, same honest ' +
      'invocability caveat as the other live passes.',
  },
  {
    id: 'post.grade',
    stage: 'post',
    kind: 'gpu',
    status: 'seam',
    owns: 'docs/planning/Environment.md §2.3 (the grade stack with a DEFINED order)',
    creates: ['buf:final'],
    reads: ['buf:scene.color', 'buf:scene.attr', 'buf:scene.depth', 'res:env'],
    modifies: [],
    absorbs: [
      'ColorCorrectionEffectV2',
      'ContextualSceneGradeEffectV2',
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
      // Closes the absorb-gap audit (2026-07-18): both are plain stylizer-
      // chain nodes, the same shape as Ascii/Halftone/DotScreen/Sepia above.
      'InvertEffectV2',
      'SharpenEffectV2',
      // GridRenderer's STYLE layer (dashed/dotted lines, ghost adjacent-floor
      // grids, floor tinting) is a stylizer-chain overlay; Foundry's own grid
      // line rendering itself stays with PIXI's interface group regardless
      // (keyhole-interface-seam — MSA never draws it), so this claims only
      // the cosmetic embellishment V2 added on top, not baseline grid drawing.
      'GridRenderer',
    ],
    note:
      'THE GRADE STACK, in fixed node order: base → ToD (8-anchor timeline) → weather → context ' +
      'gate (indoor/outdoor from attr) → manual trim — then fog, distortion, stylizers (bloom is now ' +
      'the separate post.bloom pass, just above). Four ' +
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
