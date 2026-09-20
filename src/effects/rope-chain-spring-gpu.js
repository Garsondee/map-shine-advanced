/**
 * ROPE & CHAIN — THE WIND-SPRING INTEGRATOR (Phase 2, mythica-machina-
 * press#1; read that issue's 2026-09-20 design comment, and
 * rope-chain-geometry.js's own header, before touching this file). A direct
 * structural port of `effects/vegetation-spring-gpu.js`'s render-target
 * ping-pong integrate/publish pair — READ THAT FILE'S HEADER FIRST, this one
 * assumes it and only calls out where Rope & Chain genuinely differs.
 *
 * ============================================================================
 * WHY THE RENDER-TARGET ROUTE, NOT `particles/`'s STORAGE-BUFFER ROUTE
 * ============================================================================
 * Same root reason `vegetation-spring-gpu.js` gives for its own choice, even
 * though the DETAIL differs (see "ONE TRIO PER INSTANCE" below for how):
 * this codebase's live wind vector is reachable only through
 * `windHandle.node()`/`.kernel()` (both TSL/GPU-only) — `.cpuAt()` returns
 * only a scalar `{exposure, openness, solid, inGrid}`, never a usable force
 * vector (confirmed by direct investigation, issue #1's own 2026-09-20
 * design comment) — so the modal oscillator's per-frame integration has to
 * live in a GPU pass, not plain JS. Render targets carry no restriction
 * analogous to `particles/`'s WebGPU 8-storage-buffers-per-stage ceiling
 * (`gust-runtime.js`'s own accounting), so there is no capacity reason to
 * prefer the storage-buffer route even if this effect's per-instance shape
 * (below) didn't already rule it out.
 *
 * ============================================================================
 * ONE TRIO PER ROPE INSTANCE — NOT ONE SHARED SCENE-WIDE GRID, AND THIS IS
 * DELIBERATE (the one genuine structural difference from vegetation-spring-
 * gpu.js, everything else here mirrors it directly)
 * ============================================================================
 * `vegetation-spring-gpu.js`'s own header explains why ITS state lives in
 * ONE shared, scene-wide grid: vegetation is a dense, regular field, and a
 * clump cell's spring phase must blend smoothly across its neighbours
 * (bilinear filtering across grid cells IS the point — see that file's own
 * "why the render-target route" section). A rope/chain span has no
 * neighbours to blend against: each is an independent, arbitrarily-placed
 * GM prop with its own two anchors, its own preset, its own live spring
 * state, sitting nowhere near a regular grid. So instead of one shared
 * cols x rows grid, `rope-chain-subsystem.js` allocates a SEPARATE 1x1-texel
 * ping/pong/publish trio PER SOURCE — a deliberate, scoped exception to this
 * codebase's usual "pool many instances into one shared resource"
 * convention. Lightning pools its strands because its per-vertex envelope is
 * a PURE function of `(spawnMs, seed, now)` baked once, with no persistent
 * GPU feedback to keep separate per-instance; vegetation pools its clumps
 * because they form a dense, regular field sampled by simple arithmetic from
 * world position. Rope & Chain is neither: it needs genuine persistent
 * per-instance spring state fed back every frame (the whole point of a
 * ping-pong integrator) at an ARBITRARY GM-placed position, not a grid cell.
 * Pooling that would require either a second "probe positions" data texture
 * keyed by instance, or per-instance scissor-rendering into sub-regions of
 * one shared texture — both unprecedented techniques in this codebase, and
 * pure risk for zero real benefit at this effect's realistic scale
 * (decorative props — chandelier chains, bridge cables, prison chains — is
 * single digits to perhaps a few dozen instances at the extreme, nothing
 * like the hundreds/thousands lightning strands or vegetation clumps must
 * handle). See `rope-chain-subsystem.js`'s own header for the instance
 * lifecycle this trio is allocated/torn down under.
 *
 * ============================================================================
 * STATE PACKING — RGBA, HalfFloatType (identical shape to vegetation's own,
 * different physical meaning): `.x` = mode 1 amplitude (world px), `.y` =
 * mode 1 velocity, `.z` = mode 2 amplitude (world px), `.w` = mode 2
 * velocity. Vegetation's angle/lift channels become this effect's mode1/
 * mode2 amplitude channels.
 * ============================================================================
 *
 * No renderer-state, RenderTarget, or Texture allocation lives here — walled
 * to `vt/`/effect subsystems (`gpu/allocator-only` in
 * tools/verify-structure.mjs). This file only BUILDS NodeMaterial + QuadMesh
 * objects and hands back the mutable uniform nodes the caller
 * (`rope-chain-subsystem.js`) needs to drive the ping-pong itself — the same
 * discipline `vegetation-spring-gpu.js`/`world/wind-sim-gpu.js` already
 * follow.
 *
 * @module effects/rope-chain-spring-gpu
 */

/**
 * Largest `dt` (seconds) this integrator will ever step with. Same name
 * pattern and same reasoning as `vegetation-spring-gpu.js#VEG_SPRING_MAX_DT_SEC`
 * (mirrored here, not imported — a code constant this file owns for its own
 * integrator, the same "duplicate a small owned constant rather than cross-
 * import" posture `rope-chain-geometry.js`'s own header already takes for
 * `springChase`): this is a genuine Euler-integrated 2nd-order ODE and CAN
 * diverge for a large enough `dt` at a high enough `modeStiffness` — a frame
 * hitch must not be allowed to blow it up. Clamped by the CALLER
 * (`rope-chain-subsystem.js#tick`, plain JS) before the value ever reaches
 * this shader.
 */
export const ROPE_CHAIN_SPRING_MAX_DT_SEC = 1 / 20;

/**
 * Hard ceiling on the spring's own amplitude channels (world px, both
 * modes) — the same "backstop for a genuinely new failure mode" reasoning
 * `vegetation-spring-gpu.js#VEG_SPRING_MAX_ANGLE_RAD`/`VEG_SPRING_MAX_LIFT_PX`
 * carry: this is persistent, frame-to-frame INTEGRATED state
 * (`rope-chain-geometry.js#springChase`'s own doc explains why it is not
 * unconditionally stable), so a pathological live-param combination
 * (`windCoupling`/`modeStiffness` high, `modeDamping` low relative to
 * `modeStiffness`) could in principle ring up without bound across many
 * frames. Clamped HERE, inside the integrator, not only at the vertex-shader
 * read site, so an unbounded value can never feed back into its OWN next
 * tick's `prevMode1Amp`/`prevMode2Amp` either.
 *
 * Sized at 10x `rope-chain-geometry.js`'s own default `sagPx` (40px) — a
 * DYNAMIC sway amplitude several multiples of the STATIC sag already reads
 * as wildly exaggerated (a chandelier chain swinging sideways by ten times
 * its own resting droop), so sane tuning of `windCoupling`/`modeStiffness`/
 * `modeDamping` should never come remotely close to this ceiling; it exists
 * purely to stop a pathological combination (or a frame hitch arriving
 * before `dt` is clamped) from ringing up without bound, not to shape normal
 * looks.
 */
export const ROPE_CHAIN_SPRING_MAX_AMPLITUDE_PX = 400;

/**
 * INTEGRATE — one rope/chain instance's spring state, advanced one tick.
 * TSL mirror of `rope-chain-geometry.js#springChase` (the Node-tested
 * reference this must stay behaviourally equivalent to), applied to two
 * independent channels (the fundamental sway mode and its S-curve secondary)
 * packed into one RGBA state texture — see this module's own "STATE PACKING"
 * header.
 *
 * Reads the PREVIOUS tick's state from `prevStateTexture` (a DIFFERENT
 * render target than the one this pass writes to — no read-your-own-write
 * hazard, matching `vegetation-spring-gpu.js`/`wind-sim-gpu.js`'s own
 * reasoning). The texture is 1x1, so `uv()`'s own value is irrelevant — any
 * UV samples the same, only texel.
 *
 * THE FORCING — `probeAWorld`/`probeBWorld` are the source's own world
 * positions at arclength fractions 1/3 and 2/3 ({@link
 * import('./rope-chain-geometry.js').computeRopeChainWindProbes}, computed
 * on the CPU once per sync — NOT derivable from a cell index the way
 * vegetation's own `pivotXY` is, since a rope's probe points are arbitrary
 * authored positions, not a grid lookup). `perpDir` is the span's chord unit
 * normal, same convention. Each wind sample is projected onto `perpDir` via
 * `dot()`, then combined exactly like `rope-chain-geometry.js#
 * computeModalForcing`'s own sum/difference decomposition (reimplemented
 * inline in TSL here — that function's own doc explains why sum isolates
 * mode 1 and difference isolates mode 2; the formula, not the JS function
 * itself, is what has to match, since TSL is not "the same JS running on
 * GPU").
 *
 * `target = modeNForcing * uEffectiveWindCoupling` — a SINGLE uniform
 * folding together `ROPE_CHAIN_PRESETS[preset].windCoupling *
 * source.windAffected`, computed ONCE on the CPU side per source (see
 * `rope-chain-subsystem.js`), not twice in the shader — this 1x1 pass runs
 * once per instance per frame regardless, so there is no per-fragment cost
 * argument for doing the multiply here; keeping it as one CPU-resolved
 * uniform just means one fewer live node in this graph.
 *
 * @param {object} args
 * @param {*} args.THREE - the injected THREE namespace (never imported).
 * @param {*} args.prevStateTexture - this tick's read source (the ping-pong
 *   half NOT being written this pass).
 * @param {object} args.windHandle - `world/wind-access.js#createWindHandle()`'s
 *   return, sampled via `.node()` — an ordinary TSL material shape.
 * @param {*} args.time - the shared clock node (`uGlobalTimeMs`, ms).
 * @param {{x:number,y:number}} args.probeAWorld - world position at s=1/3,
 *   wrapped into a live `uniform(vec2(...))` this function returns
 *   (`uProbeA`) so the caller can re-point `.value` on a live anchor drag
 *   without rebuilding this material.
 * @param {{x:number,y:number}} args.probeBWorld - same, at s=2/3 (`uProbeB`).
 * @param {{x:number,y:number}} args.perpDir - the chord's unit sideways
 *   direction, likewise wrapped into a live uniform (`uPerpDir`).
 * @returns {{material:*, quad:*, prevTexNodes:Array<*>, uDtSec:*,
 *   uModeStiffness:*, uModeDamping:*, uEffectiveWindCoupling:*, uProbeA:*,
 *   uProbeB:*, uPerpDir:*}} `prevTexNodes` has exactly ONE entry (the self
 *   sample) — re-point its `.value` to the current ping-pong source before
 *   rendering this pass, exactly like vegetation's own integrator.
 */
export function buildRopeChainSpringIntegrateMaterial({
  THREE,
  prevStateTexture,
  windHandle,
  time,
  probeAWorld,
  probeBWorld,
  perpDir,
}) {
  const { texture, uv, vec2, vec4, float, uniform, dot, clamp } = THREE.TSL;

  const uv0 = uv();
  const prevState = texture(prevStateTexture, uv0);
  const prevMode1Amp = prevState.x;
  const prevMode1Vel = prevState.y;
  const prevMode2Amp = prevState.z;
  const prevMode2Vel = prevState.w;

  const uDtSec = uniform(float(0));
  const uModeStiffness = uniform(float(0));
  const uModeDamping = uniform(float(0));
  // ROPE_CHAIN_PRESETS[preset].windCoupling * source.windAffected, folded
  // together once on the CPU — see this function's own "THE FORCING" doc.
  const uEffectiveWindCoupling = uniform(float(0));

  const uProbeA = uniform(vec2(probeAWorld.x, probeAWorld.y));
  const uProbeB = uniform(vec2(probeBWorld.x, probeBWorld.y));
  const uPerpDir = uniform(vec2(perpDir.x, perpDir.y));

  const sampleA = windHandle.node(THREE.TSL, { centerXY: uProbeA, time });
  const sampleB = windHandle.node(THREE.TSL, { centerXY: uProbeB, time });

  const windPerpA = dot(sampleA, uPerpDir);
  const windPerpB = dot(sampleB, uPerpDir);

  // computeModalForcing (rope-chain-geometry.js), inlined in TSL — sum
  // isolates mode 1 (the two samples share sign there), difference isolates
  // mode 2 (they oppose) — see that function's own doc for the trig identity
  // this mirrors.
  const mode1Forcing = windPerpA.add(windPerpB).mul(float(0.5));
  const mode2Forcing = windPerpA.sub(windPerpB).mul(float(0.5));

  const mode1Target = mode1Forcing.mul(uEffectiveWindCoupling);
  const mode2Target = mode2Forcing.mul(uEffectiveWindCoupling);

  // springChase (rope-chain-geometry.js), inlined per-channel — TSL has no
  // shared closure worth extracting for two call sites this small, and each
  // needs its own distinct target/value/velocity triple anyway (same
  // reasoning vegetation-spring-gpu.js's own angle/lift channels give).
  const mode1Accel = uModeStiffness.mul(mode1Target.sub(prevMode1Amp)).sub(uModeDamping.mul(prevMode1Vel));
  const newMode1Vel = prevMode1Vel.add(mode1Accel.mul(uDtSec));
  const newMode1Amp = clamp(
    prevMode1Amp.add(newMode1Vel.mul(uDtSec)),
    float(-ROPE_CHAIN_SPRING_MAX_AMPLITUDE_PX),
    float(ROPE_CHAIN_SPRING_MAX_AMPLITUDE_PX)
  );

  const mode2Accel = uModeStiffness.mul(mode2Target.sub(prevMode2Amp)).sub(uModeDamping.mul(prevMode2Vel));
  const newMode2Vel = prevMode2Vel.add(mode2Accel.mul(uDtSec));
  const newMode2Amp = clamp(
    prevMode2Amp.add(newMode2Vel.mul(uDtSec)),
    float(-ROPE_CHAIN_SPRING_MAX_AMPLITUDE_PX),
    float(ROPE_CHAIN_SPRING_MAX_AMPLITUDE_PX)
  );

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(newMode1Amp, newMode1Vel, newMode2Amp, newMode2Vel);
  const quad = new THREE.QuadMesh(material);
  return {
    material,
    quad,
    prevTexNodes: [prevState],
    uDtSec,
    uModeStiffness,
    uModeDamping,
    uEffectiveWindCoupling,
    uProbeA,
    uProbeB,
    uPerpDir,
  };
}

/**
 * ZERO-FILL — a trivial always-`vec4(0,0,0,0)` quad, used to zero-fill a
 * freshly allocated 1x1 render target. Exists because `rope-chain-
 * subsystem.js` (in `effects/`) cannot call `renderer.clear()` after
 * `renderer.setRenderTarget()` itself — same `renderer-state/graph-only`
 * wall (`tools/verify-structure.mjs`) `sun-shadow-subsystem.js`'s own §3
 * documents at length: `.setRenderTarget(` is allowed only inside
 * `vt/`/`graph/`/`diag/`. Rendering this quad through the SAME injected
 * `renderRopeChainPass(target, quad)` callback the integrate/publish passes
 * already use (see `rope-chain-subsystem.js`'s own header) achieves an
 * identical zero-fill without a second GPU-touching primitive — one door,
 * not two. Stateless (no uniforms), so ONE instance is built and reused for
 * every rope/chain instance's own three-target zero-fill, the same
 * "singleton, not per-caller" posture `THREE.QuadMesh`'s own shared
 * QuadGeometry already takes.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @returns {{material:*, quad:*}}
 */
export function buildRopeChainSpringZeroMaterial({ THREE }) {
  const { vec4, float } = THREE.TSL;
  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(float(0), float(0), float(0), float(0));
  const quad = new THREE.QuadMesh(material);
  return { material, quad };
}

/**
 * PUBLISH — a trivial passthrough (all 4 channels — both amplitude AND
 * velocity round-trip, since velocity must survive for the NEXT tick's own
 * read of this same published texture as its `prevStateTexture`) into a
 * THIRD, never-swapped target the ribbon material's vertex shader binds to
 * ONCE. See `vegetation-spring-gpu.js#buildVegetationSpringPublishMaterial`'s
 * own header for why this indirection exists at all (a material compiled
 * once, at unpredictable mesh-construction time, cannot safely hold a live
 * reference into a ping-pong pair whose identity flips every tick) — the
 * identical reasoning applies here, one instance at a time instead of one
 * shared grid.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.sourceTexture - re-pointed via `.value` each tick to
 *   whichever ping-pong half this tick's integrate pass most recently wrote.
 * @returns {{material:*, quad:*, sourceTexNode:*}}
 */
export function buildRopeChainSpringPublishMaterial({ THREE, sourceTexture }) {
  const { texture, uv } = THREE.TSL;
  const sourceTexNode = texture(sourceTexture, uv());
  const material = new THREE.NodeMaterial();
  material.fragmentNode = sourceTexNode;
  const quad = new THREE.QuadMesh(material);
  return { material, quad, sourceTexNode };
}

/**
 * Build both passes together for ONE rope/chain instance — the call
 * `rope-chain-subsystem.js` makes once per instance at creation, and again
 * whenever that instance's wind handle goes stale (a scene-wide wind rebake
 * — see that file's own header for why every instance must be checked for
 * this, mirroring `tickVegetationSpring`'s own `windHandle.version` check).
 * Mirrors `vegetation-spring-gpu.js#buildVegetationSpringMaterials`'s own
 * bundling shape exactly, minus the shared-grid params, plus this effect's
 * own per-instance probe/perpendicular params.
 *
 * @param {object} args - the union of both builders' own args above, plus:
 * @param {*} args.initialStateTexture - the integrate pass's initial read
 *   source (this instance's own ping RT, allocated by
 *   `rope-chain-subsystem.js` through ThreeAllocator — `gpu/allocator-only`
 *   forbids doing that here). Only its VALIDITY matters; every render call
 *   re-points `integrate.prevTexNodes[0].value` to the actual current
 *   ping-pong half first, so this starting value is never actually sampled
 *   as-is.
 * @param {*} args.publishTexture - the initial source for the publish pass;
 *   typically `initialStateTexture` again, re-pointed via `.value` each tick
 *   regardless.
 * @returns {{integrate:object, publish:object, dispose:()=>void}}
 */
export function buildRopeChainSpringMaterials({
  THREE,
  initialStateTexture,
  publishTexture,
  windHandle,
  time,
  probeAWorld,
  probeBWorld,
  perpDir,
}) {
  const integrate = buildRopeChainSpringIntegrateMaterial({
    THREE,
    prevStateTexture: initialStateTexture,
    windHandle,
    time,
    probeAWorld,
    probeBWorld,
    perpDir,
  });
  const publish = buildRopeChainSpringPublishMaterial({ THREE, sourceTexture: publishTexture ?? initialStateTexture });
  return {
    integrate,
    publish,
    dispose() {
      integrate.material.dispose();
      publish.material.dispose();
      // NOT the quads' geometry — QuadMesh shares ONE module-level
      // QuadGeometry across every QuadMesh in the process (see
      // vegetation-spring-gpu.js#buildVegetationSpringMaterials' own
      // identical note, and vt-pan-viewer.js's disposeSceneColor comment for
      // the original citation).
    },
  };
}
