/**
 * VEGETATION TORQUE-SWAY — the GPU half of tier 6's rotation + lift spring.
 * A direct structural port of `world/wind-sim-gpu.js`'s ping-pong/publish
 * shape (read THAT file's header first — this one assumes it) applied to a
 * much smaller job: one Euler spring-chase step (`vegetation-render.js#
 * springChase`, the Node-tested reference this must stay byte-for-byte
 * equivalent to) per clump cell, once per frame, no relax/neighbour-coupling
 * pass at all.
 *
 * ============================================================================
 * WHY THE RENDER-TARGET ROUTE, NOT `particles/`'s STORAGE-BUFFER ROUTE
 * ============================================================================
 * This effect needs the spring state's ANGLE smoothly blended across
 * neighbouring clump cells (see `vt-pan-viewer.js#buildVegetationSway
 * DisplacementNode`'s own doc for why — rotation shears far more visibly at a
 * cell boundary than plain translation ever did). The storage-buffer/
 * `.compute()` family (`effects/particles/*.js`) has no precedent anywhere in
 * this codebase for blending between neighbouring buffer slots. The
 * render-target route gets that blending FOR FREE from hardware bilinear
 * filtering — the exact mechanism vegetation's own EXISTING translation sway
 * already relies on (`world/wind-field.js#sampleWind`'s own `texture(baked
 * Texture, clampedUv)`) — so this file extends a pattern already proven live
 * in this exact consumer, rather than adopting an unproven one.
 *
 * ============================================================================
 * ONE SHARED, SCENE-WIDE GRID — NOT ONE PER VEGETATION MESH
 * ============================================================================
 * `vegetationSpringGridSpec` (vegetation-render.js) sizes this from the REAL
 * scene rect, not any one mesh's own placement — see that function's own doc
 * for why a per-mesh grid would leave two plants on two different meshes with
 * uncorrelated spring phases. `vt-pan-viewer.js` allocates ONE ping/pong/
 * publish triple for the whole scene and every vegetation mesh's vertex
 * shader binds the SAME published texture.
 *
 * ============================================================================
 * NO renderer-state, RenderTarget, or Texture allocation lives here — walled
 * to `vt/`/`graph/` (`renderer-state/graph-only`, `gpu/allocator-only`,
 * `gpu/textures-in-vt-only` in tools/verify-structure.mjs). This file only
 * BUILDS NodeMaterial + QuadMesh objects and hands back the mutable texture/
 * uniform nodes `vt-pan-viewer.js` needs to drive the ping-pong itself — the
 * same discipline `world/wind-sim-gpu.js` already follows.
 * ============================================================================
 *
 * @module effects/vegetation-spring-gpu
 */

/**
 * Largest `dt` (seconds) this integrator will ever step with. A code
 * constant, not a live param — `vegetation-render.js#springChase`'s own doc
 * explains why: unlike every other "spring-like" curve in this codebase
 * (closed-form exponentials, unconditionally stable), this is a genuine
 * Euler-integrated 2nd-order ODE and CAN diverge for a large enough `dt` at a
 * high enough `springStiffness` — a frame hitch must not be allowed to blow
 * it up. Clamped by the CALLER (`vt-pan-viewer.js#tickVegetationSpring`,
 * plain JS, before the value ever reaches this shader) rather than inside the
 * shader graph, since a clamp on a plain number costs nothing extra to do in
 * JS and keeps this file's own graph one node simpler.
 */
export const VEG_SPRING_MAX_DT_SEC = 1 / 20;

/**
 * How far the two wind-differential probe points sit from a clump cell's own
 * pivot, as a fraction of the cell size. A code constant (the plan's own
 * "rotation-radius cap" — a structural safety/geometry choice, not a
 * creative dial an author would reach for) rather than a live param, matching
 * the posture `vt-pan-viewer.js`'s own `VEG_MAX_DISPLACE_PX`/`VEG_FLUTTER_
 * UV_CAP` already take. Half the cell size keeps both probes safely inside
 * the cell's own footprint.
 */
export const VEG_SPRING_ARM_LEN_FRACTION = 0.5;

/**
 * Hard ceiling on the spring's own POSITION channels (angle, radians; lift,
 * world px) — the backstop for a genuinely new failure mode this codebase's
 * shaders have not had before: this is the FIRST persistent, frame-to-frame
 * INTEGRATED state (`springChase`'s own doc explains why it is not
 * unconditionally stable), so a pathological live-param combination
 * (`torqueGain`/`liftGain` high, `springDamping` low relative to
 * `springStiffness`) could in principle ring up without bound across many
 * frames — unlike every other displacement in this effect, which is a pure,
 * bounded function of "now" and cannot accumulate. Clamped HERE, inside the
 * integrator, not only at the vertex-shader read site, so an unbounded value
 * can never feed back into ITS OWN next tick's `prevAngle`/`prevLift` either
 * — the same "clamp where state could compound" reasoning as
 * `VEG_MAX_LOCAL_SPEED` clamping vegetation's existing wind sample before
 * anything downstream integrates from it. Generous relative to this effect's
 * own shipped defaults (`torqueGain: 0.15`, `liftGain: 6`) — sane tuning
 * should never come close to either ceiling; only a deliberately extreme
 * slider combination would.
 */
export const VEG_SPRING_MAX_ANGLE_RAD = Math.PI / 4; // 45°
export const VEG_SPRING_MAX_LIFT_PX = 200;

/**
 * INTEGRATE — one clump cell's spring state, advanced one tick. Port of
 * `vegetation-render.js#springChase`, applied to two independent channels
 * packed into one RGBA state texture: `.x` angle (radians), `.y` angular
 * velocity, `.z` lift offset (world px), `.w` lift velocity.
 *
 * Reads the PREVIOUS tick's state from `prevStateTexture` at this fragment's
 * own texel (a DIFFERENT render target than the one this pass writes to — no
 * read-your-own-write hazard, matching `wind-sim-gpu.js`'s own reasoning) —
 * NOT filtered/blended here (an exact per-cell fetch; the bilinear smoothing
 * happens once, downstream, when a vertex shader samples the PUBLISHED
 * texture — smoothing the integrator's own input as well would double-count
 * it and drift the physics off whatever `springStiffness`/`springDamping`
 * describe).
 *
 * THE TORQUE — wind sampled at two points straddling the pivot along a
 * per-cell fixed axis (`armDir`, hashed from cell coordinates so neighbouring
 * clumps twist around different axes — organic variety, the same role
 * `vt-pan-viewer.js`'s own `vegClumpHash` plays for phase/amplitude/direction
 * jitter elsewhere in this effect). The CROSS PRODUCT of the two samples'
 * difference against the arm is the torque: literally "wind pressing harder
 * on one side than the other," and it correctly zeroes out any differential
 * component parallel to the arm (which would stretch/compress, never
 * rotate). `target = torque * torqueGain` (not raw torque, and not directly
 * summed with the spring's own restoring term) is what keeps steady-state
 * amplitude a function of `torqueGain` ALONE, independent of `springStiffness`/
 * `springDamping` — see `springChase`'s own doc for why that matters.
 *
 * THE LIFT — driven by the SAME two samples' combined magnitude (not their
 * difference — overall local gust strength, not a side-to-side signal),
 * through the identical spring-chase shape, sharing `springStiffness`/
 * `springDamping` with the angle channel for v1.
 *
 * ⚠️ THE HASH BELOW MUST STAY BYTE-IDENTICAL TO `vt-pan-viewer.js`'s OWN
 * PRIVATE `vegClumpHash` — that function cannot be imported here (it is a
 * closure-local TSL function, not exported), so this is a deliberate,
 * cited duplication of one line, the same "reference the exact formula it
 * must match" discipline `wind-sim-gpu.js`'s own header already uses for
 * `ambientVectorFromWind` across three independent sites. If `vegClumpHash`
 * ever changes, this must change with it — there is no shared import to keep
 * them honest automatically.
 *
 * @param {object} args
 * @param {*} args.THREE - the injected THREE namespace (never imported).
 * @param {*} args.prevStateTexture - this tick's read source (the ping-pong
 *   half NOT being written this pass).
 * @param {object} args.windHandle - `world/wind-access.js#createWindHandle()`'s
 *   return — sampled via `.node()`, the ordinary-material shape (this is a
 *   plain fragment/QuadMesh pass, structurally no different from any other
 *   TSL material as far as the wind handle is concerned).
 * @param {*} args.time - a TSL float node, the shared clock (`uGlobalTimeMs`,
 *   ms) — this is ONE scene-wide pass, so there is no per-kind lag term the
 *   way the canopy's own vertex-shader sway has.
 * @param {number} args.cols @param {number} args.rows @param {number} args.cellSize
 * @param {number} args.originX @param {number} args.originY - the shared grid
 *   spec (`vegetation-render.js#vegetationSpringGridSpec`) — build-time
 *   constants; a genuine regrid rebuilds this material entirely (no live
 *   regrid in v1 — see that function's own doc).
 * @returns {{material:*, quad:*, prevTexNodes:Array<*>, uDtSec:*, uTorqueGain:*, uSpringStiffness:*, uSpringDamping:*, uLiftGain:*}}
 *   `prevTexNodes` has exactly ONE entry (the self sample) — re-point its
 *   `.value` to the current ping-pong source before rendering this pass.
 */
export function buildVegetationSpringIntegrateMaterial({
  THREE,
  prevStateTexture,
  windHandle,
  time,
  cols,
  rows,
  cellSize,
  originX,
  originY,
}) {
  const { texture, uv, vec2, vec4, float, uniform, cos, sin, dot, fract, length, clamp } = THREE.TSL;

  const uv0 = uv();
  const prevState = texture(prevStateTexture, uv0);
  const prevAngle = prevState.x;
  const prevAngleVel = prevState.y;
  const prevLift = prevState.z;
  const prevLiftVel = prevState.w;

  const uDtSec = uniform(float(0));
  const uTorqueGain = uniform(float(0));
  const uSpringStiffness = uniform(float(0));
  const uSpringDamping = uniform(float(0));
  const uLiftGain = uniform(float(0));

  // This texel's own cell index and world-space pivot (cell centre) — the
  // inverse of the world->UV map `vt-pan-viewer.js#buildVegetationSway
  // DisplacementNode` uses to look this texture back up.
  const cellXY = vec2(uv0.x.mul(float(cols)), uv0.y.mul(float(rows))).floor();
  const pivotXY = vec2(
    float(originX).add(cellXY.x.add(float(0.5)).mul(float(cellSize))),
    float(originY).add(cellXY.y.add(float(0.5)).mul(float(cellSize)))
  );

  // ⚠️ BYTE-IDENTICAL TO vt-pan-viewer.js's OWN vegClumpHash — see this
  // function's own doc above for why this cannot simply be imported instead.
  const cellHash01 = fract(sin(dot(cellXY, vec2(float(127.1), float(311.7)))).mul(float(43758.5453)));
  const armAngle = cellHash01.mul(float(2 * Math.PI));
  const armDir = vec2(cos(armAngle), sin(armAngle));
  const armLenPx = float(cellSize * VEG_SPRING_ARM_LEN_FRACTION);

  const probeA = pivotXY.add(armDir.mul(armLenPx));
  const probeB = pivotXY.sub(armDir.mul(armLenPx));
  const sampleA = windHandle.node(THREE.TSL, { centerXY: probeA, time });
  const sampleB = windHandle.node(THREE.TSL, { centerXY: probeB, time });

  const diff = sampleA.sub(sampleB);
  // cross2D(diff, armDir) — the component of the differential that would
  // actually spin the cell about its pivot; a component parallel to armDir
  // just stretches/compresses along it and is correctly zeroed here.
  const torque = diff.x.mul(armDir.y).sub(diff.y.mul(armDir.x));
  const angleTarget = torque.mul(uTorqueGain);

  const liftTarget = length(sampleA.add(sampleB)).mul(float(0.5)).mul(uLiftGain);

  // springChase (vegetation-render.js), inlined per-channel — TSL has no
  // shared closure worth extracting for two call sites this small, and each
  // needs its own distinct target/value/velocity triple anyway.
  const angleAccel = uSpringStiffness.mul(angleTarget.sub(prevAngle)).sub(uSpringDamping.mul(prevAngleVel));
  const newAngleVel = prevAngleVel.add(angleAccel.mul(uDtSec));
  // Clamped HERE, before it can ever become next tick's own prevAngle — see
  // VEG_SPRING_MAX_ANGLE_RAD's own doc for why this integrator (unlike every
  // other displacement in this effect) needs a backstop against compounding.
  const newAngle = clamp(
    prevAngle.add(newAngleVel.mul(uDtSec)),
    float(-VEG_SPRING_MAX_ANGLE_RAD),
    float(VEG_SPRING_MAX_ANGLE_RAD)
  );

  const liftAccel = uSpringStiffness.mul(liftTarget.sub(prevLift)).sub(uSpringDamping.mul(prevLiftVel));
  const newLiftVel = prevLiftVel.add(liftAccel.mul(uDtSec));
  const newLift = clamp(
    prevLift.add(newLiftVel.mul(uDtSec)),
    float(-VEG_SPRING_MAX_LIFT_PX),
    float(VEG_SPRING_MAX_LIFT_PX)
  );

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(newAngle, newAngleVel, newLift, newLiftVel);
  const quad = new THREE.QuadMesh(material);
  return {
    material,
    quad,
    prevTexNodes: [prevState],
    uDtSec,
    uTorqueGain,
    uSpringStiffness,
    uSpringDamping,
    uLiftGain,
  };
}

/**
 * PUBLISH — a trivial passthrough (all 4 channels, unlike `wind-sim-gpu.js#
 * buildWindPublishMaterial`'s `.xy`-only copy — every channel here is real:
 * angle and lift are read downstream, angular/lift velocity must round-trip
 * for the NEXT tick's own read of this same published texture as its `prev
 * StateTexture`) into a THIRD, never-swapped target every vegetation mesh's
 * vertex shader binds to ONCE. See `buildWindPublishMaterial`'s own header
 * for why this indirection exists at all — the identical reasoning applies
 * here: vegetation materials are compiled once, lazily, at unpredictable
 * mesh-construction time, and cannot safely hold a live reference into a
 * ping-pong pair whose identity flips every tick.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.sourceTexture - re-pointed via `.value` each tick to
 *   whichever ping-pong half this tick's integrate pass most recently wrote.
 * @returns {{material:*, quad:*, sourceTexNode:*}}
 */
export function buildVegetationSpringPublishMaterial({ THREE, sourceTexture }) {
  const { texture, uv } = THREE.TSL;
  const sourceTexNode = texture(sourceTexture, uv());
  const material = new THREE.NodeMaterial();
  material.fragmentNode = sourceTexNode;
  const quad = new THREE.QuadMesh(material);
  return { material, quad, sourceTexNode };
}

/**
 * Build both passes together — the call `vt-pan-viewer.js` makes once, at
 * construction (this grid never regrids live in v1 — see
 * `vegetation-render.js#vegetationSpringGridSpec`'s own doc). Mirrors
 * `world/wind-sim-gpu.js#buildWindSimMaterials`'s own bundling shape, minus
 * the multi-pass ping/pong split that bundler needs and this one doesn't:
 * there is exactly ONE persistent texture read here (the integrate pass's
 * own `prevState`), so only ONE initial texture is needed — the CALLER
 * re-points its `.value` to whichever render target is actually "current"
 * before every tick regardless of what it was seeded with here.
 *
 * @param {object} args - the union of both builders' own args above, plus:
 * @param {*} args.initialStateTexture - the integrate pass's initial read
 *   source (allocated by the caller through ThreeAllocator —
 *   `gpu/allocator-only` forbids doing that here). Only its VALIDITY matters;
 *   every render call re-points `integrate.prevTexNodes[0].value` to the
 *   actual current ping-pong half first, so this starting value is never
 *   actually sampled as-is.
 * @param {*} args.publishTexture - the initial source for the publish pass;
 *   typically `initialStateTexture` again, re-pointed via `.value` each tick
 *   regardless.
 * @returns {{integrate:object, publish:object, dispose:()=>void}}
 */
export function buildVegetationSpringMaterials({
  THREE,
  initialStateTexture,
  publishTexture,
  windHandle,
  time,
  cols,
  rows,
  cellSize,
  originX,
  originY,
}) {
  const integrate = buildVegetationSpringIntegrateMaterial({
    THREE,
    prevStateTexture: initialStateTexture,
    windHandle,
    time,
    cols,
    rows,
    cellSize,
    originX,
    originY,
  });
  const publish = buildVegetationSpringPublishMaterial({ THREE, sourceTexture: publishTexture ?? initialStateTexture });
  return {
    integrate,
    publish,
    dispose() {
      integrate.material.dispose();
      publish.material.dispose();
      // NOT the quads' geometry — QuadMesh shares ONE module-level
      // QuadGeometry across every QuadMesh in the process (see
      // vt-pan-viewer.js's own disposeSceneColor comment for the citation,
      // and world/wind-sim-gpu.js#buildWindSimMaterials' own identical note).
    },
  };
}
