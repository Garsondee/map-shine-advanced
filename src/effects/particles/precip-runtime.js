/**
 * PRECIPITATION — THE FALL. The fourth particle runtime (Precipitation.md §3).
 *
 * ============================================================================
 * RELATIONSHIP TO THE THREE EXISTING RUNTIMES
 * ============================================================================
 *
 * A FOURTH FILE, not a mode fork — `gust-runtime.js:11` set that precedent and
 * `fire-particle-runtime.js:6` followed it. Construction order, the uniform
 * idiom, the arena call, the respawn hash and the draw are cloned from those
 * three on purpose; the simulation is not.
 *
 * ⚠️ IT LIVES IN `effects/particles/`, NOT `effects/precipitation/`, AND THAT
 * IS A WALL RATHER THAN A PREFERENCE. `particles/allocator-only`
 * (tools/verify-structure.mjs) fails the build on `TSL.instancedArray` outside
 * this directory. The precipitation-specific pure data it consumes (the
 * species table, the response curves) lives in `effects/precipitation/` and is
 * imported — the same split fire keeps with `effects/fire/`.
 *
 * ⚠️ IT IS THE FIRST RUNTIME DRIVEN FROM A DATA TABLE rather than hand-set
 * constants (Precipitation.md §8). `rain` and `snow` are the SAME kernel with
 * different rows; adding `hail` is a row plus a phase machine, never a new
 * runtime. That is Particles.md's compiler, one real step in.
 *
 * ============================================================================
 * ⭐ THE STORAGE-BUFFER ARITHMETIC — COUNTED, NOT HOPED
 * ============================================================================
 *
 * WebGPU guarantees only **8 storage buffers per stage**, and this project has
 * already hit that floor for real (`keyhole-storage-buffer-limit-fix`). The
 * count for this runtime:
 *
 *     6 arena attribute buffers  (position, velocity, age, life, seed, custom)
 *   + 0 spawn cloud              ← precipitation spawns over an AREA, not paint
 *   + 0 wind grid                ← fire's idiom: ambient as UNIFORMS + curl ALU
 *   ─────
 *     6 of 8, with two slots of headroom.
 *
 * Fire needs 7 (its painted spawn cloud); the gust engine sits at exactly 8.
 * This one is the cheapest of the four because an area emitter needs no data
 * at all — `hash(seed)` over the padded view rect is the whole spawn model.
 * The two spare slots are deliberately UNSPENT: P2's splashes and P5's drips
 * are the ground-hugging kernels that may legitimately want the wind grid.
 *
 * ============================================================================
 * ⭐ WHY IT READS AS 3D UNDER A CAMERA THAT NEVER TILTS (§3.2)
 * ============================================================================
 *
 * MSA's world camera is orthographic. V2's weather looked three-dimensional
 * because its PERSPECTIVE camera magnified anything high by `M(h) = D/(D−h)`
 * with D = 1000, and weather spawned at h ≈ 990 — **100× magnification
 * collapsing as it falls** (`reference_v2_fire_look_autopsy`: the one place
 * V2's perspective camera genuinely mattered).
 *
 * `fire-particle-runtime.js` already ports that as a PER-PARTICLE transform
 * (displace from view centre by M, scale by M) — mathematically identical to
 * what V2's camera did to that particle, with MSA's ortho camera untouched.
 * This runtime reuses it with the sign INVERTED: fire's height integrates UP
 * (a spark climbs), precipitation's integrates DOWN (a drop falls). The radial
 * swarm converging toward the ground as it shrinks is the whole "rain is
 * coming down AT the map" read.
 *
 * ============================================================================
 * ⭐⭐ HOW WIND MEETS THE FALL — one vanishing point, moved (2026-08-16)
 * ============================================================================
 *
 * ⚠️ THE FIRST MODEL HERE WAS WRONG AND THIS COMMENT ARGUED FOR IT. It claimed
 * a drop falling straight down under a top-down camera is *"physically correct
 * and visually dead"*, and on that basis invented `uFallSlant01` as a fake
 * world-XY translation so the rain would visibly move. Four verdicts from the
 * author, each a different face of the same fault:
 *
 *   1. *"aligned as if they were moving from north to south, not as if they
 *      were falling downwards"*
 *   2. *"some raindrops are falling down and some are moving sideways"*
 *   3. *"the streak doesn't align with bird's eye view perspective downwards"*
 *   4. *"even the mildest use of it makes the rain look like it's travelling in
 *      a rain streak shape but travelling sideways — we need to rethink the
 *      interaction between precipitation and wind"*
 *
 * ⚠️ (4) IS THE ONE THAT NAMED THE REAL DEFECT, and *"even the mildest"* is the
 * clue: the fault was not a magnitude, it was two terms with different SPATIAL
 * PROFILES being summed. The radial (perspective) term is zero at the view
 * centre and grows with distance; a wind/slant velocity is constant everywhere.
 * So the middle of the frame was always wind-dominated and the edges radial,
 * with a ring between where they cancelled and bodies pointed anywhere. Any
 * nonzero weight puts that ring SOMEWHERE — which is why tuning it only moved
 * the problem, and why three attempts each traded one complaint for another.
 *
 * ⭐ THE RESOLUTION IS GEOMETRIC, NOT A DIAL. Parallel lines converge to ONE
 * vanishing point. Vertical rain converges to the nadir; wind-tilted rain is
 * still parallel lines, so it still converges to a single point — that point
 * just moves off-nadir. Wind therefore belongs in WHERE everything converges,
 * never in a competing velocity. Equating the two forms gives the shift in
 * closed form, `offset = vel · D / fallSpeed`: how far downwind a drop drifts
 * while falling the camera's own height. Derived, not tuned, and the whole
 * frame is consistent BY CONSTRUCTION because there is only one term left.
 *
 * `uFallSlant01` survives with an honest meaning — how strongly that
 * convergence point is displaced — and now does what the author asked of it:
 * it interacts with wind, because wind is what dominates `vel`.
 *
 * ⚠️ `chaosScale` 1 → 3.5 and `PERSPECTIVE_CAMERA_HEIGHT` 1000 → 2000 are the
 * author's own values, found on his hands in the lab panel: per-body turbulence
 * is what stops a radial pattern reading as a rigid starburst, and a taller
 * camera (gentler M(h)) keeps the splay short of hyperspace. Every dial here
 * trades against the others; none is meaningful alone.
 *
 * @module effects/particles/precip-runtime
 */
import { ParticleArena, BYTES_PER_PARTICLE } from './particle-arena.js';
import { createWindHandle } from '../../world/index.js';
import { createLogger } from '../../core/log.js';
import { resolveSpecies } from '../precipitation/precip-species.js';

const log = createLogger('precip-runtime');
const TIER0_WIND_HANDLE = createWindHandle();

/**
 * V2's camera-to-ground distance, and therefore the strength of the
 * perspective every body applies to itself. Smaller = stronger parallax.
 * `legacy/scene/composer.js` put the camera at z=2000 over ground at z=1000.
 * Shared with `fire-particle-runtime.js` by VALUE, deliberately not by import:
 * they describe the same V2 camera but are free to diverge if one look needs
 * it, and a shared constant would make that divergence a cross-effect edit.
 */
const PERSPECTIVE_CAMERA_HEIGHT = 2000;

/**
 * How far outside the view rect bodies keep spawning, as a fraction of the
 * rect. Bodies must already exist off-screen when the camera pans, or a pan
 * reveals an empty band that fills in visibly — V2 learned this the hard way
 * and recorded it as `msAutoCull = false`.
 */
const SPAWN_MARGIN_FRAC = 0.25;

/**
 * Build one precipitation engine for ONE species.
 *
 * @param {object} deps
 * @param {*} deps.THREE - injected.
 * @param {string} [deps.speciesId='rain'] - a built id from `precip-species.js`.
 *   ⚠️ BUILD-TIME (Effects.md Law 4), exactly like fire's `kind`: a body never
 *   changes species during its life, and a uniform would compile every row's
 *   dynamics into one kernel and evaluate at least one per body for no benefit.
 *   Rain and snow at once = two engines, which is also how they get their own
 *   capacities and their own draw calls.
 * @param {object} [deps.worldRect] - `{minX,minY,maxX,maxY}`; a placeholder is
 *   fine, `setWorldRect()` sets the real one each frame.
 * @param {number} [deps.capacity] - overrides the species row's own capacity
 *   (the shader lab runs small; production takes the row's number).
 * @param {number} [deps.zDepth=0]
 * @param {number} [deps.renderOrder=0] - set on the MESH, not `scene` — THREE
 *   reads it off the renderable object, never off an ancestor container, and
 *   fire's subsystem shipped that exact silent no-op once already.
 * @param {object} [deps.windHandle]
 * @param {number} [deps.pxPerMeter=100]
 * @returns {object} `{scene, capacity, speciesId, init, step, setWorldRect, setFrame, setTuning, debugState}`
 */
export function createPrecipEngine({
  THREE,
  speciesId = 'rain',
  worldRect = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
  capacity: capacityOverride = null,
  zDepth = 0,
  renderOrder = 0,
  windHandle = TIER0_WIND_HANDLE,
  pxPerMeter = 100,
  openSkyTexture = null,
}) {
  const TSL = THREE.TSL;
  const { Fn, instanceIndex, float, vec2, vec3, vec4, uniform, sin, cos, fract, uv, mix, positionGeometry } = TSL;

  // ⚠️ FAILS OPEN TO NOTHING, LOUDLY. An unknown species must not silently
  // become rain — `precip-species.js#resolveSpecies` returns `null` on purpose
  // and this honours it by building an engine that draws zero bodies rather
  // than by throwing (a bad id in a scene's stored weather must not take the
  // whole renderer down) or by defaulting (which would rain on a map nobody
  // asked to be rained on).
  const resolved = resolveSpecies(speciesId);
  if (!resolved.ok) log.warn(`species '${speciesId}' refused — ${resolved.reason}. This engine will draw nothing.`);
  const S = resolved.species;
  const isStreak = S ? S.body.mode === 'streak' : false;
  const hasFlutter = S ? S.fall.flutter !== null : false;
  const hasSpin = S ? S.fall.spin !== null : false;

  const capacity = Math.max(1, Math.floor(capacityOverride ?? S?.capacity ?? 1));

  // ── ARENA ────────────────────────────────────────────────────────────────
  const arena = new ParticleArena({ budgetBytes: BYTES_PER_PARTICLE * capacity });
  const buffers = arena.allocateBuffers(TSL);
  const position = buffers.position; // vec2 world px — where on the MAP
  const velocity = buffers.velocity; // vec2 world px/s — the drift, integrated
  const age = buffers.age; // float ms
  const lifeBuf = buffers.life; // float ms — the backstop, not the driver
  const seed = buffers.seed;
  /**
   * x = brightness (the `pow(rand, 0.72)` skew — V2's mid-tone-with-glints)
   * y = base size px
   * z = fall speed px/s (already gravity-multiplied, per body)
   * w = HEIGHT above the ground plane, world units — THE lifecycle driver.
   *
   * ⚠️ `w` COUNTS DOWN HERE AND UP IN FIRE. Height is the one genuinely
   * integrated quantity in either runtime (everything else is a per-life
   * constant a hash can reconstruct for free), and a drop's whole life is its
   * descent: `w` reaching 0 IS the landing, and is what triggers respawn.
   */
  const custom = buffers.custom;

  // ── UNIFORMS ─────────────────────────────────────────────────────────────
  const uDtSec = uniform(0);
  const uTimeMs = uniform(0);
  const uRectMin = uniform(vec2(worldRect.minX, worldRect.minY));
  const uRectSize = uniform(vec2(worldRect.maxX - worldRect.minX, worldRect.maxY - worldRect.minY));

  /**
   * How many slots the DRAW shows. The sim always runs the full capacity —
   * the gust engine's own idiom, and the right trade: a compute dispatch over
   * every slot costs far less than the fill rate of the sprites it would
   * otherwise draw, and skipping the sim would make an intensity change POP
   * instead of fade as the newly-live slots would all be freshly spawned.
   */
  const uActiveCount = uniform(float(capacity));

  // ── THE PERSPECTIVE PAIR — see this module's header ──────────────────────
  const uCamCentre = uniform(vec2(0, 0));
  const uCamHeight = uniform(float(PERSPECTIVE_CAMERA_HEIGHT));

  // ── THE FRAME'S DERIVED SCALARS (from `resolveSpeciesFrame`) ─────────────
  // Every one is a MULTIPLIER over the species row's own V2-derived constant,
  // never a replacement: 1.0 always means "exactly what the table says", so a
  // value reads as a distance from the reference rather than as an absolute
  // nobody can calibrate. Fire's dial convention, kept.
  const uSpeedMul = uniform(float(1));
  const uLengthMul = uniform(float(1));
  const uSizeScale = uniform(float(1.1));
  const uAlphaMul = uniform(float(1));
  const uRgbMul = uniform(float(1));
  const uFlutterMul = uniform(float(1));

  /**
   * ⭐ THE LOOK DIAL THAT MATTERS MOST — see this module's header for the full
   * argument. 0 = physically pure vertical fall (correct, and nearly invisible
   * from directly above); 1 = fully slanted (V2's downpour). Deliberately a
   * uniform so the lab can sweep it live.
   */
  const uFallSlant01 = uniform(float(1));
  /** Which way "downhill" is, in world degrees. Screen-down under the flipped
   * camera. Separate from the WIND direction on purpose: rain slants with the
   * wind AND has a base bias, and collapsing them would make a calm day's rain
   * fall in a random direction. */
  const uSlantDirDeg = uniform(float(90));
  /** Turbulence strength — V2's dual-frequency lateral chaos (`:1450-1505`),
   * as one scalar the lab can sweep. */
  const uChaosScale = uniform(float(3.5));
  /**
   * Multiplier on the species' own `streakPerPxS`. 1.0 = exactly the table's
   * number, the same distance-from-reference convention every dial here uses.
   *
   * ⚠️ THIS DIAL EXISTS BECAUSE THE TABLE'S FIRST NUMBER WAS MEASURABLY WRONG,
   * and the lab is what caught it. Precipitation.md §10's harvest ledger records
   * V2's rain billboard as `speedFactor = 0.0065×0.25`; read as a product
   * (0.001625) it produced streaks of **1.2–8.2 SCREEN px** at a normal zoom —
   * measured in `bench-precip`, not eyeballed — which renders as a starfield of
   * specks rather than as rain. The two factors were evidently not both
   * stretch. Rather than silently pick the other reading, the stretch is now a
   * swept dial with the table holding the value the sweep actually chose.
   */
  /**
   * ⚠️ 0.5, AND THAT IS A CHANGE OF BASIS RATHER THAN A TASTE TWEAK. The
   * species table's `streakPerPxS` (0.0065) is V2's number for length per unit
   * of FALL speed; this runtime now derives length from APPARENT (screen)
   * speed, which at the shipped slant is a fraction of it. Halving here
   * re-expresses V2's factor in the new basis instead of editing the harvested
   * constant, so the table keeps meaning what its own comment says it means.
   */
  const uStreakScale = uniform(float(1.1));
  /**
   * How much of the derived RADIAL (falling-toward-you) motion steers a
   * streak's direction. See the derivation at its use site in `positionNode`.
   * 0 = every streak parallel; 1 = the full, physically-derived splay, which
   * measured as hyperspace rather than rain.
   */
  const uParallaxStreak01 = uniform(float(1));

  // ── ⭐ THE SKY-REACH GATE (Precipitation.md LAW 3) ────────────────────────
  //
  // *"Rain indoors is unrepresentable, not discouraged."* `scene/sky-reach-
  // access.js` was built FOR this feature — its own 2026-07-24 header quotes
  // the author: *"repairing sky reach because it needs to be an API / service
  // for other things like rain drops."*
  //
  // ⚠️ IT IS A **RENDER** GATE, NOT A SIM GATE, and that split is deliberate
  // (§3.1). The kernel stays spatially uniform — the cheapest possible sim,
  // with no per-slot texture read, because sampling a texture from a COMPUTE
  // stage is unproven on this renderer and the storage-slot budget is precious
  // (this runtime's 6-of-8 headroom is reserved for P2's splashes and P5's
  // drips). The DRAW samples a baked `skyReach` texture at the body's ground
  // position instead, where fragment/vertex sampling is ordinary — exactly
  // fire's `bakeFireMaskTexture` precedent.
  //
  // ⚠️ IT **FADES**, IT DOES NOT STEP. A streak legitimately crosses an indoor
  // texel while its own body is over an outdoor one, and a hard cut would
  // chop drops in half along every roofline
  // (`feedback_silent_cap_corrupts_hard_boundary`).
  //
  // ⚠️ POLARITY: THE ABSENCE DEFAULT IS **1**, NOT 0. `uSkyReachHasBake` is 0
  // until a real texture arrives, and the gate then multiplies by 1 — missing
  // data means *keep raining*, never *mysteriously stop*. That is the sky-reach
  // service's own documented rule, and it is the difference between a map with
  // no ingested art rendering weather and one silently rendering none
  // (`feedback_gate_polarity_must_fail_open`).
  const uSkyReachRect = uniform(vec4(0, 0, 1, 1));
  const uSkyReachHasBake = uniform(float(0));
  /**
   * ⚠️ THE PLACEHOLDER IS A 1×1 **WHITE** TEXEL, IT IS NOT A DUMMY, AND THE
   * CALLER OWNS IT.
   *
   * Three things shaped it:
   *
   *  1. `TSL.texture(null)` THROWS — *"expects a valid instance of
   *     THREE.Texture()"* — and it does so at GRAPH-BUILD time, inside a node
   *     the renderer swallows: the material silently rendered NOTHING, armed
   *     or disarmed, with the error only visible in the console. That is
   *     `feedback_bundling_does_not_prove_construction_order`'s family — a
   *     clean build and a green Node suite cannot see a TSL graph that failed
   *     to construct. The shader-lab bench caught it in one frame.
   *  2. White is 1.0 is *"the sky is fully open"*, so the fail-open default is
   *     the LITERAL CONTENT of the placeholder rather than a separate branch
   *     that has to remember to be safe. Disarming the gate restores this
   *     texture, so there is exactly one representation of "no data" and it
   *     already means keep raining.
   *  3. ⚠️ IT IS **INJECTED**, not built here, because `gpu/textures-in-vt-only`
   *     (tools/verify-structure.mjs) forbids `new THREE.*Texture` outside vt/.
   *     Four bytes is obviously not the 345 MB `LightCovers.webp` that rule was
   *     written for — but the wall does not read sizes, and arguing the
   *     exception at the call site is exactly how a wall stops meaning
   *     anything. `effects/specular/specular-render.js` already takes its own
   *     1×1 placeholder the same way; this follows it.
   *
   * With no texture supplied the gate simply never arms (`setSkyReachTexture`
   * refuses), which is the fail-open state — a caller that forgets gets rain
   * everywhere, never a silently sealed sky.
   */
  const openSkyPixel = openSkyTexture ?? null;
  /**
   * ⚠️ A SEPARATE `texture()` NODE PER CONSUMER. A shared node carries the
   * wrong uv (`feedback_shared_texture_node_carries_the_wrong_uv`) — this one
   * is sampled at a WORLD position mapped into the mask rect, never `uv()`.
   *
   * ⚠️ NULL WHEN NO PLACEHOLDER WAS INJECTED, and the gate is then compiled
   * OUT of the graph entirely rather than built around a null (which is the
   * exact throw described above). A build-time branch, not a runtime one —
   * Effects.md Law 4 — because whether a caller supplies the placeholder
   * cannot change during the engine's life.
   */
  const skyReachTex = openSkyPixel ? TSL.texture(openSkyPixel) : null;

  // Live by reference — a `setWindAmbient` change reaches the kernel with no
  // resync code, the contract all three existing runtimes rely on.
  const uWindSpeed01 = windHandle?.ambient ? windHandle.ambient.speed01 : float(0);
  const uWindDirDeg = windHandle?.ambient ? windHandle.ambient.directionDeg : float(0);
  // Construction-time constant, not a uniform: `pxPerMeter` cannot change mid-session.
  const windPxPerSec = float(pxPerMeter * 3.2);

  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));

  /**
   * WHERE A BODY IS ACTUALLY DRAWN — V2's `M(h) = D/(D−h)` applied to its world
   * position. Returns `{xy, persp}` so a caller can reuse the magnification for
   * sizing without repeating the divide.
   *
   * ⚠️ ONE EXPRESSION, TWO CONSUMERS, DELIBERATELY EXTRACTED. `positionNode`
   * places the sprite with it and the sky-reach gate samples with it — and the
   * whole reason that gate needed fixing was that those two disagreed. A second
   * hand-written copy is exactly how they would silently drift apart again
   * (`feedback_shared_field_two_meanings_two_registries`, in shader form).
   *
   * Clamped well short of D: a body reaching the camera plane would divide by
   * zero and smear across the entire screen.
   *
   * @param {*} worldXY @param {*} heightW
   */
  const parallaxOf = (worldXY, heightW) => {
    const h = heightW.clamp(float(0), uCamHeight.mul(float(0.6)));
    const persp = uCamHeight.div(uCamHeight.sub(h));
    return { xy: uCamCentre.add(worldXY.sub(uCamCentre).mul(persp)), persp };
  };

  /**
   * Where a body is (re)born: uniform over the view rect plus a margin, so
   * bodies already exist off-screen when the camera pans (see
   * {@link SPAWN_MARGIN_FRAC}).
   * @param {*} h1 @param {*} h2 - two decorrelated hash inputs.
   */
  const spawnAt = (h1, h2) => {
    const margin = uRectSize.mul(float(SPAWN_MARGIN_FRAC));
    const origin = uRectMin.sub(margin);
    const span = uRectSize.add(margin.mul(float(2)));
    return vec2(origin.x.add(hash11(h1).mul(span.x)), origin.y.add(hash11(h2).mul(span.y)));
  };

  // Species constants, hoisted so the kernels read plain numbers. A refused
  // species yields an engine whose bodies are all zero-size and never move.
  const SPEED_MIN = S ? S.fall.speedPxS[0] : 0;
  const SPEED_MAX = S ? S.fall.speedPxS[1] : 0;
  const GRAV_MIN = S ? S.fall.gravityMul[0] : 1;
  const GRAV_MAX = S ? S.fall.gravityMul[1] : 1;
  const SIZE_MIN = S ? S.body.sizePx[0] : 0;
  const SIZE_MAX = S ? S.body.sizePx[1] : 0;
  const SPAWN_H = S ? S.fall.spawnHeightPx : 1;
  const WIND_CARRY = S ? S.fall.windCarry01 : 0;
  const SKEW_EXP = S ? S.body.brightnessSkewExp : 1;
  const STREAK_PER_PXS = S ? S.body.streakPerPxS : 0;
  const FLUTTER = S?.fall.flutter ?? { hzMin: 0, hzMax: 0, ampPxMin: 0, ampPxMax: 0 };
  const SPIN = S?.fall.spin ?? { radSMin: 0, radSMax: 0, windScaleCalm: 1, windScaleStorm: 1 };

  /**
   * Per-body constants, all derived from ONE hash of the seed — no storage
   * beyond `custom`, and stable for the body's whole life because the inputs
   * are. Returns the packed `custom` vec4 the kernels write.
   * @param {*} entropy - a bounded, well-mixed scalar.
   */
  const bodyConstants = (entropy) => {
    // V2 `:1466` — `pow(rand, 0.72)`: a mid-tone skew with rare bright glints,
    // NOT a uniform distribution. Most of why V2's rain read as a real curtain.
    const brightness = hash11(entropy.mul(float(1.7))).pow(float(SKEW_EXP));
    const sizePx = mix(float(SIZE_MIN), float(SIZE_MAX), hash11(entropy.mul(float(2.3)).add(float(11))));
    const speed = mix(float(SPEED_MIN), float(SPEED_MAX), hash11(entropy.mul(float(3.1)).add(float(29)))).mul(
      mix(float(GRAV_MIN), float(GRAV_MAX), hash11(entropy.mul(float(4.7)).add(float(53))))
    );
    return { brightness, sizePx, speed };
  };

  // ── SEED KERNEL ──────────────────────────────────────────────────────────
  const seedKernel = Fn(() => {
    const i = instanceIndex;
    const fi = float(i);
    seed.element(i).assign(fi);
    velocity.element(i).assign(vec2(0, 0));
    position.element(i).assign(spawnAt(fi.mul(float(1.37)).add(float(5.9)), fi.mul(float(0.61)).add(float(11.3))));
    const c = bodyConstants(fi);
    // ⚠️ HEIGHTS ARE STAGGERED ACROSS THE WHOLE COLUMN, not all set to the
    // ceiling. Seeding every body at `SPAWN_H` would drop one solid sheet of
    // rain that lands together and leaves the sky empty until the next sheet —
    // a pulsing curtain rather than steady weather. Fire staggers AGE for the
    // same reason; here height is the lifecycle, so height is what staggers.
    const h0 = hash11(fi.mul(float(7.3)).add(float(2.2))).mul(float(SPAWN_H));
    custom.element(i).assign(vec4(c.brightness, c.sizePx, c.speed, h0));
    lifeBuf.element(i).assign(
      float(SPAWN_H)
        .div(c.speed.max(float(1)))
        .mul(float(1000))
    );
    age.element(i).assign(float(0));
  })().compute(capacity);

  // ── UPDATE KERNEL ────────────────────────────────────────────────────────
  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const pos = position.element(i).toVar();
    const s = seed.element(i);
    const c = custom.element(i).toVar();

    const speed = c.z.mul(uSpeedMul);

    // ── THE FALL: height integrates DOWN. This is the lifecycle. ──
    const nextH = c.w.sub(speed.mul(uDtSec));

    // ── THE VISIBLE DRIFT (world XY) ──
    // 1. The slant — how much of the fall shows up as screen motion. See the
    //    header: without it a top-down camera sees rain as a zoom, not a fall.
    const slantRad = uSlantDirDeg.mul(float(Math.PI / 180));
    const slant = vec2(cos(slantRad), sin(slantRad)).mul(speed).mul(uFallSlant01);
    // 2. The wind — a single ambient vector, not a per-particle field sample.
    //    That is what lets this runtime skip the wind-grid buffer entirely
    //    (see the storage arithmetic in the header). Species-scaled: rain
    //    leans, snow is carried.
    const windRad = uWindDirDeg.mul(float(Math.PI / 180));
    const windVec = vec2(cos(windRad), sin(windRad)).mul(uWindSpeed01).mul(windPxPerSec).mul(float(WIND_CARRY));
    // 3. The chaos — V2's dual-frequency lateral sway (`:1450-1505`), phase
    //    offset per body so neighbours never move in lockstep (the ember
    //    lesson: a pure function of position and time makes a swarm drift as
    //    one rigid body no matter how strong the field is).
    const tSec = uTimeMs.mul(float(0.001));
    const phase = s.mul(float(12.9));
    const chaos = vec2(
      sin(tSec.mul(float(3.5)).add(phase))
        .mul(float(0.6))
        .add(sin(tSec.mul(float(10)).add(phase.mul(float(1.7)))).mul(float(0.4))),
      sin(tSec.mul(float(0.9)).add(phase.mul(float(2.3)))).mul(float(0.5))
    )
      .mul(float(34))
      .mul(uChaosScale);

    // 4. Flutter — snow only. The paper-fall sway (V2 `:1556-1663`), and the
    //    whole character of a flake: without it snow falls like slow rain,
    //    which reads as ash. Collapses in a blizzard via `uFlutterMul`.
    let drift = slant.add(windVec).add(chaos);
    if (hasFlutter) {
      const fHz = mix(float(FLUTTER.hzMin), float(FLUTTER.hzMax), hash11(s.mul(float(5.9))));
      const fAmp = mix(float(FLUTTER.ampPxMin), float(FLUTTER.ampPxMax), hash11(s.mul(float(6.7)).add(float(3))));
      // Perpendicular to the slant, so a flake weaves ACROSS its fall line
      // rather than stuttering along it.
      const across = vec2(cos(slantRad.add(float(Math.PI / 2))), sin(slantRad.add(float(Math.PI / 2))));
      drift = drift.add(
        across.mul(
          sin(tSec.mul(fHz).mul(float(6.2832)).add(phase))
            .mul(fAmp)
            .mul(uFlutterMul)
        )
      );
    }

    const nextPos = pos.add(drift.mul(uDtSec));

    // ── RESPAWN — height reaching the ground IS the landing ──
    const landed = nextH.lessThanEqual(float(0));
    // Bounded entropy: seed plus the body's OWN position, never the raw
    // unbounded clock (the dot engine's fix-8 — `sin()`'s float32 precision
    // collapses at large arguments and `uTimeMs` grows all session, which
    // makes distinct bodies alias onto the same "random" value).
    const entropy = s
      .mul(float(0.61))
      .add(nextPos.x.mul(float(0.011)))
      .add(nextPos.y.mul(float(0.013)));
    const fresh = bodyConstants(entropy);
    const respawnPos = spawnAt(entropy, entropy.mul(float(1.9)).add(float(4.4)));

    position.element(i).assign(landed.select(respawnPos, nextPos));
    velocity.element(i).assign(drift);
    custom
      .element(i)
      .assign(
        landed.select(vec4(fresh.brightness, fresh.sizePx, fresh.speed, float(SPAWN_H)), vec4(c.x, c.y, c.z, nextH))
      );
    const agedMs = age.element(i).add(uDtSec.mul(float(1000)));
    age.element(i).assign(landed.select(float(0), agedMs));
    lifeBuf.element(i).assign(
      landed.select(
        float(SPAWN_H)
          .div(fresh.speed.max(float(1)))
          .mul(float(1000)),
        lifeBuf.element(i)
      )
    );
  })().compute(capacity);

  // ── THE DRAW ─────────────────────────────────────────────────────────────
  // InstancedBufferGeometry (not InstancedMesh) so there is no instanceMatrix
  // to reconcile with a positionNode that already returns world space.
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.attributes.position);
  geometry.setAttribute('uv', base.attributes.uv);
  geometry.instanceCount = capacity;

  /**
   * Per-instance data the FRAGMENT stage needs.
   *
   * ⚠️ BUNDLED INTO ONE vec4 RATHER THAN FOUR VARYINGS — storage reads are
   * VERTEX-STAGE ONLY on this renderer, so anything the fragment wants must
   * cross as a varying, and all three existing runtimes pack rather than
   * multiply. `x` = fall progress 0..1 (1 = just about to land), `y` =
   * brightness, `z` = the alive flag, `w` = THE SKY-REACH GATE.
   *
   * ⚠️ `w` USED TO CARRY THE SEED and now carries the gate, because the seed
   * turned out never to be read in the fragment stage at all — the only
   * consumer (a flake's spin) lives in `positionNode`, which is vertex-stage
   * and reads the storage buffer directly. Spending a varying slot on a value
   * nothing downstream reads, while the gate needed one, was the trade to make.
   */
  const vBody = Fn(() => {
    const i = instanceIndex;
    const c = custom.element(i);
    const fall01 = float(1)
      .sub(c.w.div(float(SPAWN_H)))
      .clamp(float(0), float(1));
    const alive = float(i).lessThan(uActiveCount).select(float(1), float(0));

    // ⭐ THE SKY-REACH GATE, sampled at the body's DRAWN (parallaxed) position.
    // Computed HERE because `position.element(i)` is a storage read and storage
    // reads are VERTEX-STAGE ONLY on this renderer; the result crosses to the
    // fragment as a varying, the same packing discipline all three sibling
    // runtimes use.
    //
    // ⚠️ DRAWN POSITION, NOT GROUND POSITION — a deliberate divergence from
    // Precipitation.md §3.1's wording, and it was MEASURED rather than argued.
    // Sampling the ground position left 61% of the rain still drawn inside the
    // test building; a controlled sweep of `cameraHeight` (which is exactly a
    // sweep of M(h)) collapsed that residual to **0.0% at M≈1.1 and back to
    // ~20-60% at M=2.5**, isolating the cause completely: the gate was asking
    // about one place and the viewer was looking at another.
    //
    // Ground position is the right answer for a real perspective camera, where
    // a drop high above a roof genuinely is visible beside it. MSA's camera is
    // ORTHOGRAPHIC and M(h) is a per-body depth-cue rather than real geometry —
    // so the only position with a viewer-facing meaning is the one the sprite
    // is drawn at, and LAW 3's requirement is itself a viewer-facing claim:
    // *the player must not SEE rain indoors*. §3.1's own follow-on (compare the
    // body's height against the deck's altitude, so a drop above a bridge still
    // renders) remains the next rung and needs the cover-HEIGHT field baked as
    // a second texture; it refines this, it does not replace it.
    // No placeholder injected ⇒ no gate in the graph at all ⇒ a constant 1,
    // which is exactly the fail-open answer (rain everywhere).
    if (!skyReachTex) return vec4(fall01, c.x, alive, float(1));

    const p = parallaxOf(position.element(i), c.w).xy;
    const uvx = p.x.sub(uSkyReachRect.x).div(uSkyReachRect.z.sub(uSkyReachRect.x).max(float(1)));
    const uvy = p.y.sub(uSkyReachRect.y).div(uSkyReachRect.w.sub(uSkyReachRect.y).max(float(1)));
    // Outside the baked rect there is no data, and no data means KEEP RAINING
    // (the absence-default-1 rule) — so an out-of-bounds body reads 1 rather
    // than clamping onto whatever the nearest edge texel happens to hold.
    const inside = uvx
      .greaterThanEqual(float(0))
      .and(uvx.lessThanEqual(float(1)))
      .and(uvy.greaterThanEqual(float(0)))
      .and(uvy.lessThanEqual(float(1)));
    const sampled = skyReachTex.sample(vec2(uvx.clamp(float(0), float(1)), uvy.clamp(float(0), float(1)))).r;
    const gate = uSkyReachHasBake.mul(inside.select(float(1), float(0)));
    // `mix(1, sampled, gate)` — with no bake, or outside the rect, this is
    // exactly 1. One expression, no branch, and the fail-open case is the
    // literal identity rather than a value that merely happens to be safe.
    const skyGate = mix(float(1), sampled, gate);

    return vec4(fall01, c.x, alive, skyGate);
  })().toVarying('vPrecipBody');

  const material = new THREE.NodeMaterial();
  material.positionNode = Fn(() => {
    const i = instanceIndex;
    const corner = positionGeometry.xy;
    const centre = position.element(i);
    const c = custom.element(i);
    const vel = velocity.element(i);

    // Slots past the active count collapse to zero size — invisible, costing
    // no fill rate, and needing no separate draw range.
    const alive = float(i).lessThan(uActiveCount).select(float(1), float(0));

    // ── PERSPECTIVE — the SHARED expression, not a second copy ──
    // `parallaxOf` is the one place M(h) lives; the sky-reach gate samples
    // through it too, and them disagreeing is the exact bug that made the gate
    // miss 61% of the rain it should have stopped.
    const { xy: parallaxed, persp } = parallaxOf(centre, c.w);

    const width = c.y.mul(uSizeScale).mul(alive).mul(persp);

    // ⭐⭐ WIND SHIFTS THE VANISHING POINT — IT DOES NOT ADD A SECOND VELOCITY.
    //
    // Author, 2026-08-16, after the slant was zeroed: *"Fall slant is a good
    // idea, it should interact with wind, but so far even the mildest use of it
    // makes the rain look like it's travelling in a rain streak shape but
    // travelling sideways. We need to rethink the interaction between
    // precipitation and wind."*
    //
    // ⚠️ THE DIAGNOSIS IS A SCALING MISMATCH, and it explains why *even the
    // mildest* slant looked wrong rather than merely "a bit much". The previous
    // model summed two terms with completely different spatial profiles:
    //
    //     dA/dt = vel·M  −  (P − C)·M²·fallSpeed / D
    //             └ CONSTANT ┘  └─ grows with |P − C| ─┘
    //
    // The radial term is ZERO at the view centre and huge at the edges; the
    // wind term is the same everywhere. So the middle of the frame was always
    // wind-dominated (streaks pointing sideways in formation) while the edges
    // were radial — with a ring between them where the two cancelled and bodies
    // pointed in essentially arbitrary directions. No weighting fixes that,
    // because the two profiles cross SOMEWHERE for any nonzero weight. Tuning
    // `uParallaxStreak01` only moved the bad ring around.
    //
    // ⭐ THE FIX COMES FROM THE GEOMETRY, NOT A DIAL. Parallel lines converge to
    // ONE vanishing point under perspective. Vertical rain converges to the
    // nadir — the point directly under the camera. Wind-TILTED rain is still a
    // family of parallel lines, so it still converges to a single point; that
    // point simply moves off-nadir, upwind. So wind belongs in WHERE everything
    // converges, not in a competing velocity.
    //
    // Setting the old expression equal to a pure radial about a shifted centre:
    //
    //     vel·M − (P−C)·M²·v/D  ≡  −(P − C − offset)·M²·v/D
    //     ⇒ offset = vel·D / (M·v)
    //
    // Evaluated at the ground (M ≈ 1) that is `offset = vel · D / fallSpeed` —
    // and it has a clean physical reading: **how far downwind a drop drifts
    // while falling the camera's own height**. One number, derived, no taste in
    // it. Every body then radiates from ONE shifted point, so the pattern is
    // consistent across the whole frame BY CONSTRUCTION — there is no longer a
    // ring where two terms fight, because there is only one term.
    //
    // `uFallSlant01` survives and now means something honest: how strongly the
    // fall's own tilt (wind included) displaces that convergence point. It
    // interacts with wind exactly as the author asked, because wind is the
    // dominant contributor to `vel`.
    const fallSpeed = c.z.mul(uSpeedMul).max(float(1));
    const windOffset = vel.mul(uCamHeight).div(fallSpeed).mul(uFallSlant01);
    const convergence = uCamCentre.add(windOffset);
    // Pure radial about the shifted point. `uParallaxStreak01` blends between
    // the raw world drift (0) and this (1) — kept as an escape hatch for a
    // species that genuinely should read as travelling across the map (sand,
    // hurricane sheets), NOT as a balance dial any more. Rain and snow want 1.
    const radial = centre.sub(convergence).mul(persp).mul(persp).mul(fallSpeed).div(uCamHeight);
    const apparentVel = mix(vel.mul(persp), radial.negate(), uParallaxStreak01);
    // ⚠️ Guarded against a zero-length result (a body sitting exactly on the
    // convergence point), which would make the normalize produce NaN and
    // silently vanish the whole batch.
    const speedLen = apparentVel.length().max(float(1e-4));
    const dir = vec2(apparentVel.x.div(speedLen), apparentVel.y.div(speedLen));

    // ⭐ AND ITS LENGTH COMES FROM THE SAME APPARENT SPEED — the fix for the
    // author's *"some raindrops are falling down and some are moving sideways"*.
    //
    // The first cut derived LENGTH from `c.z`, the body's full 3-D fall speed,
    // while deriving DIRECTION from its much smaller SCREEN motion. Those two
    // disagree by construction, and the failure mode is precise: when a body's
    // apparent motion is small, its direction is dominated by whatever wind and
    // chaos happen to be doing — but the streak was still drawn at full length.
    // The result is long streaks pointing in essentially arbitrary directions,
    // which is exactly what "some are moving sideways" looks like.
    //
    // Deriving both from `apparentVel` makes the streak an honest motion blur:
    // a body falling straight at the camera has near-zero screen motion and
    // draws as a DOT (correct — that is what falling toward you looks like from
    // directly above), and a body genuinely travelling across the map draws a
    // streak along the way it is actually going. One quantity, one direction,
    // no disagreement possible.
    const length = width.add(speedLen.mul(float(STREAK_PER_PXS)).mul(uStreakScale).mul(uLengthMul).mul(uSizeScale));
    // Perpendicular, for the width axis.
    const perp = vec2(dir.y.negate(), dir.x);

    let along = corner.y.mul(length);
    let across = corner.x.mul(width);
    if (hasSpin && !isStreak) {
      // A flake tumbles rather than pointing anywhere. Spin is derived from
      // the seed (per-body rate and direction) and scaled by wind — V2's
      // calm ×0.4 → storm ×3.
      const sd = seed.element(i);
      const rate = mix(float(SPIN.radSMin), float(SPIN.radSMax), hash11(sd.mul(float(8.1))))
        .mul(
          hash11(sd.mul(float(9.3)))
            .step(float(0.5))
            .mul(float(2))
            .sub(float(1))
        )
        .mul(mix(float(SPIN.windScaleCalm), float(SPIN.windScaleStorm), uWindSpeed01));
      const ang = uTimeMs.mul(float(0.001)).mul(rate).add(sd);
      const ca = cos(ang);
      const sa = sin(ang);
      const rx = corner.x.mul(ca).sub(corner.y.mul(sa));
      const ry = corner.x.mul(sa).add(corner.y.mul(ca));
      across = rx.mul(width);
      along = ry.mul(width);
    }

    const offset = vec2(dir.x.mul(along).add(perp.x.mul(across)), dir.y.mul(along).add(perp.y.mul(across)));
    return vec3(parallaxed.x.add(offset.x), parallaxed.y.add(offset.y), float(zDepth));
  })();

  const HEAD = S?.body.headRgba ?? [1, 1, 1, 1];
  const TAIL = S?.body.tailRgba ?? [1, 1, 1, 1];
  const SOFT = S?.body.softness01 ?? 0.5;

  material.colorNode = Fn(() => {
    const bright = vBody.y;
    // Head-to-tail along the quad's own long axis: `uv().y` is 1 at the
    // leading end. A flake's ramp is nearly flat (its two stops are close),
    // so the same expression serves both bodies without a branch.
    const t = uv().y;
    const rgb = mix(vec3(TAIL[0], TAIL[1], TAIL[2]), vec3(HEAD[0], HEAD[1], HEAD[2]), t);
    return rgb.mul(bright).mul(uRgbMul);
  })();

  material.opacityNode = Fn(() => {
    const bright = vBody.y;
    const alive = vBody.z;
    const t = uv().y;
    const alpha = mix(float(TAIL[3]), float(HEAD[3]), t);

    // ⚠️ A STREAK AND A FLAKE NEED DIFFERENT FALLOFF GEOMETRY, and a single
    // expression for both is a bug the shader lab caught by LOOKING: the first
    // cut softened only across X (correct for a streak, whose length should
    // stay crisp) and rendered every snowflake as a hard-edged rotating
    // SQUARE, `softness01: 0.8` notwithstanding. A flake is radially soft; a
    // streak is laterally soft. Build-time branch (Effects.md Law 4) — a body
    // never changes species mid-life, so this costs nothing at runtime.
    let edge;
    if (isStreak) {
      // Lateral falloff only. The `pow` exponent turns `softness01` into an
      // edge profile: high exponent = a nearly hard line, low = a soft smear.
      const across = uv().x.sub(float(0.5)).abs().mul(float(2));
      edge = float(1)
        .sub(across.pow(mix(float(8), float(1.4), float(SOFT))))
        .clamp(float(0), float(1));
      // Taper the tail so a streak fades out behind its head instead of
      // ending in a flat cut — the difference between rain and a dashed line.
      edge = edge.mul(t.mul(float(0.65)).add(float(0.35)));
    } else {
      // Radial falloff — a soft round dot, which is what a flake actually is
      // (V2's own snow sprite was an authored blur; this is that, minus the
      // texture fetch, exactly as fire's ember does it).
      const d = uv().sub(float(0.5)).length().mul(float(2)).clamp(float(0), float(1));
      const soft = float(1).sub(d);
      // `softness01` picks how quickly the dot falls off: squared is a gentle
      // cloud, the higher power a tighter pellet (which is what hail will want).
      edge = soft.pow(mix(float(3), float(1.1), float(SOFT))).clamp(float(0), float(1));
    }
    // ⭐ LAW 3 lands HERE, as a plain multiply: a body over a covered texel
    // fades to nothing. Multiplied unconditionally because the no-bake case is
    // exactly 1 (see the gate's own note) — an `if` would be a second place the
    // polarity could be got backwards.
    const skyGate = vBody.w;
    return alpha.mul(edge).mul(bright).mul(uAlphaMul).mul(alive).mul(skyGate);
  })();

  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  // ⚠️ DoubleSide or the whole batch is culled SILENTLY — the flipped camera
  // (`top = minY`) inverts winding and `FrontSide` renders nothing, with no
  // error anywhere. Every runtime in this directory carries this line and the
  // same warning, because it has bitten before and leaves no trace when it does.
  material.side = THREE.DoubleSide;
  // ⚠️ NORMAL, NOT ADDITIVE — and this is a species property, not a taste.
  // Rain and snow have `emissive01: 0`: they are lit water, not light sources,
  // and additive blending would make a downpour glow brighter than the sun it
  // is falling through. Fire's flame/ember are the additive ones. When P6's
  // emissive species (`spore`, ember) land they will need their own engine
  // with additive blending — a second engine, not a uniform.
  material.blending = THREE.NormalBlending;
  material.toneMapped = false;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // world-space bounds vary per frame; culling is the GPU's job
  mesh.renderOrder = renderOrder; // on the MESH — see the constructor param's own doc
  const scene = new THREE.Scene();
  scene.add(mesh);

  let seeded = false;
  let lastFrame = null;

  return {
    scene,
    capacity,
    speciesId,
    species: S,
    /** True if the species resolved; false means this engine draws nothing. */
    ok: resolved.ok,

    init(renderer) {
      if (seeded) return;
      renderer.compute(seedKernel);
      seeded = true;
    },

    /**
     * Advance one frame.
     *
     * ⚠️ SYNCHRONOUS `renderer.compute`, never `computeAsync` — the shipped
     * idiom in all three sibling runtimes. An async dispatch inside a frame
     * lets the draw read a buffer the kernel has not finished writing.
     *
     * @param {*} renderer
     * @param {number} dtSec - real seconds. Precipitation is presentation
     *   pacing like the weather eases (rain does not fall in slow motion
     *   because the GM slowed the game clock), so this is the WALL delta.
     * @param {number} timeMs
     */
    step(renderer, dtSec, timeMs) {
      if (!S) return;
      uDtSec.value = Math.max(0, Math.min(0.1, dtSec || 0));
      uTimeMs.value = timeMs || 0;
      if (!seeded) this.init(renderer);
      // Nothing live means nothing to simulate — a JS `if`, never a uniform
      // set to zero (Effects.md Law 4). This is LAW 5's teeth: a clear day
      // dispatches no compute and submits no draw.
      if (uActiveCount.value <= 0) return;
      renderer.compute(updateKernel);
    },

    /**
     * Hand the engine this floor's baked sky-reach texture — LAW 3's input.
     * Cheap and idempotent: call it when the mask authority's products version
     * moves or the floor changes, NEVER per frame.
     *
     * ⚠️ PASSING `null` DISARMS THE GATE (back to raining everywhere) rather
     * than sealing the sky. That is the fail-open polarity again, at the API
     * boundary this time: a floor whose art has not streamed yet must rain, not
     * silently stop. A caller that wants no rain sets `precip01` to 0 — the
     * axis that MEANS that — instead of starving the gate.
     *
     * @param {*} texture - a `THREE.Texture`, or null to disarm.
     * @param {{minX:number,minY:number,maxX:number,maxY:number}} [rect] - the
     *   WORLD rect the texture spans. Required with a texture; without it the
     *   sample would map world coordinates through a meaningless box.
     */
    setSkyReachTexture(texture, rect) {
      if (!openSkyPixel) {
        // No placeholder was injected, so the graph has no texture to fall
        // back to and arming would sample whatever the node was built with.
        // Refuse loudly and stay fail-open (raining) rather than half-arm.
        return { armed: false, reason: 'no openSkyTexture injected — the gate cannot arm (see its own note)' };
      }
      if (!texture || !rect) {
        // Back to the 1×1 open-sky texel, never to `null` — see its own note.
        skyReachTex.value = openSkyPixel;
        uSkyReachHasBake.value = 0;
        return { armed: false, reason: texture ? 'no rect supplied' : 'no texture supplied' };
      }
      skyReachTex.value = texture;
      uSkyReachRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
      uSkyReachHasBake.value = 1;
      return { armed: true, rect };
    },

    /** @param {{minX:number,minY:number,maxX:number,maxY:number}} rect */
    setWorldRect(rect) {
      if (!rect) return;
      uRectMin.value.set(rect.minX, rect.minY);
      uRectSize.value.set(Math.max(1, rect.maxX - rect.minX), Math.max(1, rect.maxY - rect.minY));
      uCamCentre.value.set((rect.minX + rect.maxX) * 0.5, (rect.minY + rect.maxY) * 0.5);
    },

    /**
     * Push one frame's worth of derived scalars — the output of
     * `precip-species.js#resolveSpeciesFrame`. Kept as a separate call from
     * `step` so the caller can resolve once and drive several engines, and so
     * the shader lab can set them by hand without faking a whole axis set.
     * @param {object} frame
     */
    setFrame(frame) {
      if (!frame) return;
      lastFrame = frame;
      const live = Math.max(0, Math.min(capacity, Math.round(frame.liveCount ?? 0)));
      uActiveCount.value = live;
      mesh.visible = live > 0;
      if (Number.isFinite(frame.speedMul)) uSpeedMul.value = frame.speedMul;
      if (Number.isFinite(frame.lengthMul)) uLengthMul.value = frame.lengthMul;
      if (Number.isFinite(frame.alphaMul)) uAlphaMul.value = frame.alphaMul;
      if (Number.isFinite(frame.rgbMul)) uRgbMul.value = frame.rgbMul;
      if (Number.isFinite(frame.flutterMul)) uFlutterMul.value = frame.flutterMul;
    },

    /**
     * The author's/lab's look dials — everything the species table does NOT
     * derive. Every one is live-tunable so the shader lab can sweep it and the
     * author can find the value rather than be handed one.
     * @param {object} t
     */
    setTuning(t = {}) {
      if (Number.isFinite(t.sizeScale)) uSizeScale.value = t.sizeScale;
      if (Number.isFinite(t.fallSlant01)) uFallSlant01.value = Math.max(0, Math.min(1, t.fallSlant01));
      if (Number.isFinite(t.slantDirDeg)) uSlantDirDeg.value = t.slantDirDeg;
      if (Number.isFinite(t.chaosScale)) uChaosScale.value = t.chaosScale;
      if (Number.isFinite(t.streakScale)) uStreakScale.value = Math.max(0, t.streakScale);
      if (Number.isFinite(t.parallaxStreak01)) uParallaxStreak01.value = Math.max(0, Math.min(1, t.parallaxStreak01));
      if (Number.isFinite(t.cameraHeight)) uCamHeight.value = Math.max(1, t.cameraHeight);
    },

    /** What the debug panel and the lab legend print. */
    debugState() {
      return {
        speciesId,
        ok: resolved.ok,
        reason: resolved.reason,
        capacity,
        liveCount: uActiveCount.value,
        visible: mesh.visible,
        storageBuffers: 6,
        // ⚠️ LAW 3's own status, printed rather than assumed. `false` here means
        // rain is falling everywhere including indoors — which is the honest
        // fail-open state, not a silent one.
        skyGate: {
          armed: uSkyReachHasBake.value === 1,
          rect: uSkyReachHasBake.value === 1 ? { ...uSkyReachRect.value } : null,
        },
        tuning: {
          sizeScale: uSizeScale.value,
          fallSlant01: uFallSlant01.value,
          slantDirDeg: uSlantDirDeg.value,
          chaosScale: uChaosScale.value,
          streakScale: uStreakScale.value,
          parallaxStreak01: uParallaxStreak01.value,
          cameraHeight: uCamHeight.value,
        },
        frame: lastFrame,
        wind: { speed01: uWindSpeed01?.value ?? 0, directionDeg: uWindDirDeg?.value ?? 0 },
      };
    },
  };
}
