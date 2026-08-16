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
import { buildSquallField } from '../precipitation/squall-field.js';

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
 * How long a newly (re)spawned body takes to reach full opacity, in ms.
 *
 * Short enough to be invisible as a fade — at a rain body's ~0.15-0.6s life
 * this is a fraction of it — but long enough to cover the ONE frame after a
 * respawn in which the body's stored velocity was integrated at its previous
 * position while its streak is drawn from its new one. See the birth-fade note
 * at its use site for why that frame exists at all.
 */
const BIRTH_FADE_MS = 90;

/**
 * Lateral chaos amplitude as a FRACTION of a body's own fall speed.
 *
 * Chosen so rain's amplitude is unchanged from the absolute constant it
 * replaces (`34 px × chaosScale 3.5 = 119 px/s` at rain's ~3300 px/s mid
 * speed ⇒ `119 / (3300 × 3.5)`), making this a re-basing of V2's harvested
 * number rather than a retune of it. See its use site for why absolute px/s
 * could not work across species.
 */
const CHAOS_PER_SPEED = 0.0103;

/**
 * The view span every world-space length in this runtime is calibrated
 * against. A view this wide behaves exactly as the tuned numbers describe;
 * wider or narrower views scale proportionally so the weather keeps its
 * apparent pace and size. See {@link uViewScale}.
 */
const REFERENCE_VIEW_SPAN_PX = 2000;

/**
 * How far downwind the convergence point may run, in camera heights.
 *
 * The wind offset is `vel × D / fallSpeed`, which diverges for a slow body —
 * see its use site for the live report that produced this cap. Three camera
 * heights is far enough that even a strongly-leaning drop keeps its lean, and
 * near enough that the streak never degenerates into "point at the wind".
 */
const WIND_OFFSET_MAX_CAM_HEIGHTS = 3;

/**
 * How deeply a flake's silhouette is notched by the angular harmonics — the
 * difference between a snowball and a crystal.
 *
 * ⚠️ WELL SHORT OF 1. At 0.5 a notch reaches the centre and the shape turns
 * inside out into a star of disconnected spikes, which is a *different* cartoon
 * rather than no cartoon. 0.3 keeps a recognisable body with a ragged rim.
 */
const ROUGHNESS = 0.3;

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
  const { Fn, instanceIndex, float, vec2, vec3, vec4, uniform, sin, cos, atan, fract, uv, mix, positionGeometry } = TSL;

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
  /**
   * ⭐ DOES THIS SPECIES WALK A PHASE MACHINE? (§4.4). BUILD-TIME, like every
   * other species branch — a body never changes species mid-life, so a stone's
   * bounce logic is compiled only into hail's own kernel and rain pays nothing.
   */
  const hasPhases = Boolean(S?.bounce);
  const B = S?.bounce ?? null;
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
  /**
   * ⭐ THE PHASE SLOT (§4.4) — `ordinal + progress`, the arena's own encoding.
   *
   * ORDINALS: `0` falling · `1` first pop-up · `2` second pop-up · `3` resting on
   * the ground · `4` fading. A stone with one bounce skips 2.
   *
   * ⚠️ ONLY REFERENCED WHEN `hasPhases`, so rain and snow never bind this
   * buffer and stay at 6 of the 8-per-stage floor. Hail binds 7.
   */
  const phaseBuf = buffers.phase;
  const PHASE_FALL = 0;
  const PHASE_BOUNCE_1 = 1;
  const PHASE_REST = 3;
  const PHASE_FADE = 4;

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
  /** The unscaled base;  multiplies it by the view scale so the
   * magnification stays constant across zoom. A tuning setter writes THIS. */
  let camHeightBase = PERSPECTIVE_CAMERA_HEIGHT;

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
  /**
   * ⭐ THE SCENE'S OWN BOUNDS — precipitation must not fall off the map.
   *
   * Author, seeing it live: *"clip precipitation so that it doesn't appear
   * outside of the bounds of the scene."* Bodies spawn over the VIEW rect plus
   * a margin (so a pan never reveals an empty band), and the view legitimately
   * extends past the map edge into the void around it — so without this, rain
   * falls in the black surround, which is where the author first saw it.
   *
   * ⚠️ A DRAW CLIP, NOT A SPAWN CLAMP, and deliberately: shrinking the spawn
   * rect to the scene would thin the population near the edges (fewer bodies
   * per unit area where the rect was cut) and re-introduce exactly the
   * pan-reveals-a-band artefact the margin exists to prevent. Killing the
   * body's OPACITY at the boundary costs one comparison and keeps the
   * population uniform.
   *
   * `w <= 0` means "no bounds supplied" and disables the clip entirely — the
   * same fail-open polarity as the sky gate: a viewer that never calls
   * `setSceneBounds` rains everywhere rather than nowhere.
   */
  const uSceneRect = uniform(vec4(0, 0, 0, 0));
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

  /**
   * ⭐ THE ENGINE'S **OWN** WIND UNIFORMS, PUSHED PER FRAME — not the wind
   * handle's, bound by reference.
   *
   * ⚠️ THIS IS A BUG FIX WITH A LIVE REPORT BEHIND IT: *"Wind doesn't seem to
   * affect it at all currently."* The three sibling runtimes bind
   * `windHandle.ambient.speed01` directly, which is correct FOR THEM because
   * they are built once beside a handle that outlives them. Precipitation
   * builds its engines LAZILY (a clear map allocates nothing), and
   * `vt-pan-viewer.js`'s `windHandle` is a `let` that gets REASSIGNED when the
   * wind field bakes — so an engine built before a bake, or after a different
   * one, holds a dead handle's uniforms forever. Nothing throws; the rain
   * simply never leans, which is exactly what was reported.
   *
   * Owning the uniforms and pushing values every frame makes engine lifetime
   * and handle lifetime independent, which is the actual invariant this
   * runtime needs. One extra uniform write per frame, and the whole
   * captured-a-stale-reference class stops applying
   * (`feedback_unconsumed_api_rots_silently`'s cousin: a binding that is still
   * live but no longer connected to anything that changes).
   */
  const uWindSpeed01 = uniform(float(0));
  const uWindDirDeg = uniform(float(0));

  /**
   * ⭐ HOW FAR THE FALL TILTS AT FULL WIND, IN DEGREES — the one number that
   * makes wind visible on precipitation.
   *
   * ⚠️ IT REPLACES A VELOCITY RATIO THAT COULD NEVER WORK, and the arithmetic
   * is worth keeping because it is a units bug, not a tuning one. The wind
   * field speaks in `pxPerMeter × 3.2` ⇒ **320 px/s at a full gale**, a scale
   * calibrated for foliage sway. Rain falls at **1400-5200 px/s** — V2's
   * harvested numbers, which were SCREEN-space under a perspective camera, not
   * world-space. Feeding one into the other gives a tilt of
   * `atan(144 / 3300)` = **2.5°** at maximum wind: measured in the shader lab,
   * and exactly the author's report that *"wind doesn't seem to affect it at
   * all."* No gain on the velocity fixes that honestly — the two quantities are
   * calibrated in different frames.
   *
   * An ANGLE is the quantity that actually transfers. It is also the natural
   * authoring unit ("a gale drives rain over at 40°"), it is bounded by
   * construction, and the vanishing point of lines tilted by θ sits at
   * `tan(θ)·D` from the nadir — so the convergence shift falls straight out of
   * it with no second calibration to get wrong.
   */
  const uWindAirSpeed = uniform(float(2600));
  /**
   * ⭐ THE SQUALL FIELD's inputs (P4, §3.4 job 2). `gustiness01` is the wind
   * door's own axis; `squallDepth` at 0 makes the field a constant 1, i.e.
   * EXACTLY the un-banded population this engine had before P4 — the identity,
   * not a value that merely looks unchanged.
   */
  const uGustiness01 = uniform(float(0));
  const uSquallDepth = uniform(float(0.8));
  const uSquallScale = uniform(float(1));

  /**
   * ⭐ ZOOM INVARIANCE — the view's span relative to {@link REFERENCE_VIEW_SPAN}.
   *
   * ⚠️ WITHOUT THIS, PRECIPITATION IS GLUED TO THE WORLD RATHER THAN TO THE
   * CAMERA. Author: *"When I zoom in and out the snow (and probably rain)
   * doesn't quite move how I'd expect."* Every length here was WORLD px — fall
   * speed, wind speed, body size, spawn height — so zoomed in, a drop crossed
   * the small view in a blink; zoomed out, the same drop crawled. The M(h)
   * DISPLACEMENT was already invariant (it is a constant 32% of the view at any
   * span, measured), which is why this reads as a subtle wrongness rather than
   * an obvious break: the geometry was right and the TIMING was not.
   *
   * Precipitation is an ATMOSPHERIC LAYER between the viewer and the map, not
   * scenery painted on it. A curtain of rain should hold its apparent scale and
   * pace as the camera moves, the way it does out of a window. So every length
   * this runtime owns is multiplied by the view's own span — which is exactly
   * how V2 got its zoom-invariance (it zoomed by FOV with the camera distance
   * fixed, so `h/D` never changed).
   *
   * ⚠️ IT SCALES `uCamHeight` AND the spawn height TOGETHER, so `h/D` — and
   * therefore the parallax magnification — is untouched. This changes PACE, not
   * perspective.
   */
  const uViewScale = uniform(float(1));
  // Construction-time constant, not a uniform: `pxPerMeter` cannot change mid-session.
  const windPxPerSec = float(pxPerMeter * 3.2);

  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));

  /**
   * ⭐ THE DIRECTION THE WIND PUSHES THINGS, from `directionDeg`.
   *
   * ⚠️ `directionDeg` IS METEOROLOGICAL — it names the direction the wind blows
   * **FROM**, not toward. `world/wind-field.js` says so in its own angle-
   * convention block ("East" means an east wind, blowing FROM the east TOWARD
   * the west) and its sampler negates accordingly:
   * `vec2(cos, sin).negate().mul(speed01)`.
   *
   * ⚠️ AND IT IS A **+90° ROTATION**, NOT A NEGATION — I got this wrong twice
   * and the second attempt is instructive. The first cut used a bare
   * `vec2(cos, sin)`; reading the field's `.negate()` I "fixed" it by negating
   * too, which is a 180° flip. The author's next report was that precipitation
   * ran *"90 degrees clockwise of the wind direction — wind heading north, snow
   * goes east; wind east, snow goes south."* Two data points is enough to solve
   * exactly: in this engine's Y-DOWN world (the camera is flipped, `top = minY`,
   * so +Y is SOUTH and +X is EAST) those observations are precisely
   * `precip = cw90(heading)`, so the true heading is `ccw90` of what the code
   * produced — which reduces to `(−sin, cos)`, i.e. the raw angle turned +90°.
   *
   * ⚠️ THE LESSON: a DIRECTION being wrong does not tell you the CORRECTION is
   * a sign. Negation fixes 180°; a rotation error needs a rotation. Reaching
   * for `.negate()` because the reference code contained one was pattern-
   * matching, not derivation — the two conventions differ by more than a sign
   * and the honest move was to solve it from observations, as above.
   *
   * ⚠️ STILL A SECOND HAND-WRITTEN READING OF A SHARED CONVENTION, which is the
   * root problem (`feedback_shared_field_two_meanings_two_registries` wearing a
   * compass). The real fix is for `world/wind-field.js` to EXPORT a
   * direction→vector helper that every consumer calls, so there is one
   * implementation to be right or wrong. Filed rather than done here because it
   * touches shipped consumers (vegetation, gusts, the overlay) whose current
   * look is calibrated against their own readings, and silently rotating those
   * is not a change to make in a precipitation commit.
   *
   * One helper, both call sites (the kernel's drift and the draw's convergence
   * shift), so those two can never disagree with each other.
   * @param {*} rad - `directionDeg` already in radians.
   */
  const windToward = (rad) => vec2(sin(rad).negate(), cos(rad));

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
  /** Spawn height and camera height BOTH ride uViewScale, so the parallax
   * magnification h/D is identical at every zoom — this changes pace, not
   * perspective. See uViewScale. */
  const spawnH = () => float(SPAWN_H).mul(uViewScale);
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
    /**
     * ⭐ SIZE AND SPEED SHARE ONE HASH — A BIG DROP FALLS FAST.
     *
     * ⚠️ THEY USED TO BE INDEPENDENT, AND THAT IS WHAT THE AUTHOR KEPT SEEING:
     * *"there are still some rain drops which are double width and fall slower
     * and more strangely."* Precisely. With independent hashes every
     * combination existed, including the one that cannot occur in nature and
     * looks worst on screen — the WIDEST body (3.6 px) at the SLOWEST speed. A
     * streak's length comes from its speed, so that body is short AND fat: a
     * blob, sitting among proper streaks, at a different angle because a slow
     * drop leans differently.
     *
     * Correlating them is both the fix and the physics: terminal velocity rises
     * with drop size, so a fat drop is a FAST drop and the slow ones are the
     * fine ones that read as mist. Nothing needs clamping or rejecting — the
     * bad combination simply stops being representable, which is the shape of
     * fix this project prefers to a tuned threshold.
     *
     * The `pow(0.7)` skews the shared draw toward the small/slow end, because a
     * curtain is mostly fine rain with occasional fat drops rather than an even
     * mix.
     */
    const mass = hash11(entropy.mul(float(2.3)).add(float(11))).pow(float(0.7));
    const sizePx = mix(float(SIZE_MIN), float(SIZE_MAX), mass);
    // A small INDEPENDENT jitter on top, so two drops of the same size still
    // separate over their lives — the variety `gravityMul` was always for,
    // without re-introducing the slow-fat body it used to permit.
    const speed = mix(float(SPEED_MIN), float(SPEED_MAX), mass).mul(
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
    const h0 = hash11(fi.mul(float(7.3)).add(float(2.2))).mul(spawnH());
    custom.element(i).assign(vec4(c.brightness, c.sizePx, c.speed, h0));
    lifeBuf.element(i).assign(
      spawnH()
        .div(c.speed.max(float(1)))
        .mul(float(1000))
    );
    age.element(i).assign(float(0));
    if (hasPhases) phaseBuf.element(i).assign(float(PHASE_FALL));
  })().compute(capacity);

  // ── UPDATE KERNEL ────────────────────────────────────────────────────────
  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const pos = position.element(i).toVar();
    const s = seed.element(i);
    const c = custom.element(i).toVar();

    const speed = c.z.mul(uSpeedMul).mul(uViewScale);

    // ── THE FALL: height integrates DOWN. This is the lifecycle. ──
    // The body clock and its per-body phase, hoisted ABOVE the vertical churn
    // that now needs them — declaring them further down threw `Cannot access
    // tSec before initialization` at graph-build time, which TSL reports only
    // to the console (feedback_bundling_does_not_prove_construction_order).
    const tSec = uTimeMs.mul(float(0.001));
    const phase = s.mul(float(12.9));

    // ⭐ TURBULENCE IN THE THIRD AXIS. Author: *"ideally it would be turbulent
    // in full 3D."* Height is the axis a top-down camera cannot show directly —
    // but it is NOT invisible here, because M(h) turns it into size and radial
    // position. A body that bobs vertically therefore pulses slightly larger
    // and smaller and shifts in and out from the view centre, which is exactly
    // the depth cue that was missing while X and Y jittered on their own.
    //
    // A MODULATION OF THE FALL RATE rather than an added displacement: real
    // turbulence speeds a body up and slows it down through the column, and
    // doing it this way cannot push a body back above its spawn height or
    // stall it into a hover. Clamped well short of 1 so the fall never
    // reverses — a drop that rose would read as a bug, not as weather.
    const vertChurn = sin(tSec.mul(float(2.3)).add(phase.mul(float(1.31))))
      .mul(float(0.45))
      .mul(uChaosScale)
      .clamp(float(-0.8), float(0.8));
    // `.toVar()` because the phase machine below REPLACES it for a species with
    // life stages (a bouncing stone's height follows an arc, not the fall).
    const nextH = c.w.sub(speed.mul(float(1).add(vertChurn)).mul(uDtSec)).toVar();

    // ── THE VISIBLE DRIFT (world XY) ──
    //
    // ⚠️ THERE IS NO "SLANT" TERM HERE ANY MORE, AND ITS REMOVAL IS A BUG FIX.
    // `uFallSlant01` used to ALSO push every body along `uSlantDirDeg` in world
    // space, on top of its (new, correct) job of displacing the convergence
    // point in the draw. One uniform, two meanings, in two files' worth of
    // arithmetic — `feedback_shared_field_two_meanings_two_registries` exactly.
    //
    // The symptom was precise and the author named it: *"The middle of the
    // perspective should be in the middle of the camera view. Currently that is
    // happening to the south of the camera."* With `slantDirDeg = 90` (south)
    // the kernel shoved every drop southward; the draw then derives the
    // convergence offset from `vel`, so that shove dragged the vanishing point
    // south with it. The perspective centre could never sit under the camera
    // while this term existed, at ANY dial setting.
    //
    // Rain falls straight down. WIND is what moves it sideways — that is the
    // whole model now, and `uSlantDirDeg` survives only as the direction a
    // future species (`sand`, hurricane sheets) might want to bias toward.
    //
    // ⚠️ `slantRad` survives ONLY as an axis for snow's flutter to weave
    // ACROSS (below). It no longer contributes any translation of its own —
    // deleting it outright broke the flake sway at graph-build time, which is
    // the sort of thing a TSL graph reports only in the console.
    const slantRad = uSlantDirDeg.mul(float(Math.PI / 180));
    // 1. The wind — a single ambient vector, not a per-particle field sample.
    //    That is what lets this runtime skip the wind-grid buffer entirely
    //    (see the storage arithmetic in the header). Species-scaled: rain
    //    leans, snow is carried.
    // ⚠️ THE DRIFT IS COMPUTED ONCE, HERE, and the draw DERIVES its convergence
    // shift from this same `vel` — so how far downwind a body actually travels
    // and where its streak points cannot disagree. Deriving them separately is
    // the two-terms-disagreeing bug this runtime has already paid for three
    // times. (`windPxPerSec` is unused by precipitation: the wind field's
    // foliage-calibrated 320 px/s is the wrong frame for a body falling at
    // thousands — see `uWindAirSpeed`.)
    const windRad = uWindDirDeg.mul(float(Math.PI / 180));
    // ⭐ AIR-SPEED FIRST. A body's horizontal speed tracks the AIR's speed
    // scaled by how much of it the body catches (`windCarry01`) — it is NOT a
    // function of its own fall speed.
    //
    // ⚠️ DERIVING IT FROM FALL SPEED WAS BACKWARDS, and the author measured it:
    // *"At full wind strength snow barely moves... that goes double for snow."*
    // A tilt-first model gave a snowflake (75 px/s) a 51 px/s drift in a full
    // gale while rain managed 1072 — but a flake is NEARLY WIND-BORNE and
    // should OUTRUN a raindrop sideways, not crawl. Air-speed-first: snow
    // 2210 px/s, rain 1170. The tilt is then DERIVED (snow ~88°, i.e. nearly
    // horizontal — which is what a blizzard actually looks like) rather than
    // dialled, so it can never disagree with the body's real travel.
    const windVec = windToward(windRad).mul(uWindSpeed01).mul(uWindAirSpeed).mul(uViewScale).mul(float(WIND_CARRY));
    // 2. The chaos — V2's dual-frequency lateral sway (`:1450-1505`), phase
    //    offset per body so neighbours never move in lockstep (the ember
    //    lesson: a pure function of position and time makes a swarm drift as
    //    one rigid body no matter how strong the field is).
    // ⚠️ BOTH AXES CARRY THE SAME TWO-FREQUENCY SHAPE AND THE SAME AMPLITUDE.
    // The first cut gave X two terms summing to ±1.0 and Y a single ±0.5 — a
    // 2:1 bias that read exactly as the author described: *"snow chaotically
    // drifts only left and right instead of all four directions."* V2's
    // dual-frequency sway was authored for a body already falling down-screen,
    // where a lateral-only jitter is right; under a top-down camera there is no
    // privileged lateral axis and the jitter has to be isotropic. Y uses its
    // own phase offsets so the two axes stay decorrelated — equal amplitude,
    // not a circle.
    const chaos = vec2(
      sin(tSec.mul(float(3.5)).add(phase))
        .mul(float(0.6))
        .add(sin(tSec.mul(float(10)).add(phase.mul(float(1.7)))).mul(float(0.4))),
      sin(tSec.mul(float(3.1)).add(phase.mul(float(2.3))))
        .mul(float(0.6))
        .add(sin(tSec.mul(float(8.7)).add(phase.mul(float(0.9)))).mul(float(0.4)))
    )
      // ⚠️ SCALED BY THE BODY'S OWN FALL SPEED, not an absolute px/s.
      //
      // V2's chaos amplitude (28-100 px) was authored for RAIN, which falls at
      // 1400-5200 px/s. Carried across as a constant it swamps anything slower:
      // MEASURED, snow's wind-driven drift is 52 px/s against 119 px/s of
      // chaos — a ratio of 0.44, so turbulence simply drowned the wind and
      // flakes ignored it. Rain's ratio is 9.0, which is why rain looked fine
      // and only snow was reported dead ("snow isn't yet affected by wind").
      //
      // Expressing it as a FRACTION OF FALL SPEED makes it scale-free: every
      // species gets the same proportional jitter, and a slow species is no
      // longer dominated by a number picked for a fast one. `CHAOS_PER_SPEED`
      // is set so rain's amplitude is unchanged at the shipped `chaosScale`,
      // i.e. this is a re-basing rather than a retune. Snow's own character
      // comes from `flutter`, which is authored in absolute px BECAUSE a
      // flake's sway is a real physical width rather than a ratio.
      .mul(speed)
      .mul(float(CHAOS_PER_SPEED))
      .mul(uChaosScale);

    // 3. Flutter — snow only. The paper-fall sway (V2 `:1556-1663`), and the
    //    whole character of a flake: without it snow falls like slow rain,
    //    which reads as ash. Collapses in a blizzard via `uFlutterMul`.
    let drift = windVec.add(chaos);
    if (hasFlutter) {
      const fHz = mix(float(FLUTTER.hzMin), float(FLUTTER.hzMax), hash11(s.mul(float(5.9))));
      const fAmp = mix(float(FLUTTER.ampPxMin), float(FLUTTER.ampPxMax), hash11(s.mul(float(6.7)).add(float(3))));
      // ⚠️ THE SWAY IS 2-D NOW, AND SINGLE-AXIS WAS THE BUG THE AUTHOR SAW.
      // It used to weave only along ONE fixed axis (perpendicular to
      // `slantDirDeg`), which under a side view is right — a leaf falling past
      // a window swings across your line of sight. From DIRECTLY ABOVE there is
      // no such privileged axis, and the result was exactly the report: *"snow
      // still moves left and right when falling, but never up or down... locked
      // to being turbulent in a single axis."* Two decorrelated phases at
      // slightly different rates trace an open Lissajous rather than a line,
      // so a flake genuinely wanders the plane. `slantRad` is no longer
      // consulted here at all.
      const swayA = sin(tSec.mul(fHz).mul(float(6.2832)).add(phase));
      const swayB = sin(
        tSec
          .mul(fHz)
          .mul(float(6.2832 * 0.77))
          .add(phase.mul(float(1.9)))
          .add(float(1.3))
      );
      // The two sways ARE the vector — multiplying by a third copy of `swayA`
      // (as a first cut did) would collapse the pair back onto one axis and
      // undo the whole point.
      drift = drift.add(vec2(swayA, swayB).mul(fAmp).mul(uFlutterMul).mul(uViewScale));
    }

    const nextPos = pos.add(drift.mul(uDtSec));

    // ── RESPAWN — landing, OR being blown out of the spawn rect ──
    //
    // ⚠️ THE SECOND CONDITION IS WHY SNOW DEPOPULATED IN WIND, and it is a
    // lifetime problem rather than a speed one. A body used to respawn ONLY on
    // landing. Rain lands in ~0.24s so it never travels far, but SNOW falls for
    // ~12 SECONDS — so any real wind carries a flake thousands of px, far past
    // the padded spawn rect, and it keeps drifting out there forever while the
    // upwind side of the view empties. Measured: snow's population in a centre
    // probe collapsed 268 → 6 at full wind, at EVERY air speed tried, which is
    // the tell that no amount of tuning was going to fix it.
    //
    // Recycling a body the moment it leaves the rect keeps the population
    // uniform under any wind, at any species lifetime, for one comparison —
    // and it composes with the birth fade, so a recycled body eases in rather
    // than popping at the upwind edge.
    const halfSpan = uRectSize.mul(float(0.5 + SPAWN_MARGIN_FRAC));
    const rectCentre = uRectMin.add(uRectSize.mul(float(0.5)));
    const fromCentre = nextPos.sub(rectCentre).abs();
    const escaped = fromCentre.x.greaterThan(halfSpan.x).or(fromCentre.y.greaterThan(halfSpan.y));
    /**
     * ⭐ THE PHASE MACHINE (§4.4) — hail only, build-time.
     *
     * `fall → bounce(×1–2) → rest → fade`, walked in the body's OWN slot so a
     * stone is continuous through all of it. §4.4: *"sparse discrete arrivals
     * are the one place per-body continuity matters."*
     *
     * ⚠️ THE POP-UP IS DRIVEN BY PHASE **PROGRESS**, NOT BY AN INTEGRATED
     * VELOCITY. `h = peak × sin(π · p)` is an exact arc that starts at the
     * ground, reaches `peak` at the midpoint and returns to the ground at
     * p = 1 — so a bounce can never drift below the floor or fail to come back
     * down, which an integrated velocity with a damped restitution absolutely
     * can once dt varies. It also needs no second storage slot for vertical
     * speed. The arc is the STATE; the phase is the clock.
     *
     * ⚠️ AND IT RE-USES M(h), which is the whole reason a bounce reads at all
     * from directly above: the stone's magnification pops up and settles again,
     * so it visibly leaves the ground rather than sliding. §4.4 asks for exactly
     * that ("a damped pop-up re-using the M(h) transform, smaller each time").
     */
    let landed = nextH.lessThanEqual(float(0)).or(escaped);
    if (hasPhases) {
      const ph = phaseBuf.element(i);
      const ord = ph.floor();
      const prog = ph.sub(ord);
      // How many pop-ups this stone gets, from its own stable hash.
      const bounces = hash11(s.mul(float(6.1)).add(float(31)))
        .mul(float(B.countRange[1] - B.countRange[0] + 1))
        .floor()
        .add(float(B.countRange[0]))
        .min(float(2));

      // ── FALLING ── the ordinary height integration, until it reaches 0.
      const fallingDone = nextH.lessThanEqual(float(0));
      // ── BOUNCING/RESTING/FADING ── progress advances at that stage's own rate.
      const stageSec = ord
        .lessThan(float(PHASE_REST))
        .select(float(B.popSec), ord.equal(float(PHASE_REST)).select(float(B.restSec), float(B.fadeSec)));
      const nextProg = prog.add(uDtSec.div(stageSec.max(float(0.01))));
      const stageDone = nextProg.greaterThanEqual(float(1));

      // The pop-up arc, damped once per bounce ordinal.
      const peak = spawnH()
        .mul(float(B.firstPeakFrac))
        .mul(float(B.damping).pow(ord.sub(float(PHASE_BOUNCE_1)).max(float(0))));
      const arcH = peak.mul(nextProg.clamp(float(0), float(1)).mul(float(Math.PI)).sin());

      // Where does this stage hand off to? A stone that has used all its
      // bounces goes to REST; REST goes to FADE; FADE ends the life.
      const afterBounce = ord.greaterThanEqual(bounces).select(float(PHASE_REST), ord.add(float(1)));
      const nextOrd = ord
        .equal(float(PHASE_FALL))
        .select(float(PHASE_BOUNCE_1), ord.lessThan(float(PHASE_REST)).select(afterBounce, ord.add(float(1))));

      const isFalling = ord.equal(float(PHASE_FALL));
      const advance = isFalling.select(fallingDone.select(float(1), float(0)), stageDone.select(float(1), float(0)));
      const resolvedOrd = advance.greaterThan(float(0.5)).select(nextOrd, ord);
      const resolvedProg = advance.greaterThan(float(0.5)).select(float(0), isFalling.select(float(0), nextProg));

      // The height each phase dictates: falling integrates, a bounce follows
      // its arc, rest and fade sit on the ground.
      const phaseH = isFalling.select(
        nextH.max(float(0)),
        resolvedOrd.lessThan(float(PHASE_REST)).select(arcH, float(0))
      );

      phaseBuf.element(i).assign(resolvedOrd.add(resolvedProg.clamp(float(0), float(0.9999))));
      // A stone's life ends when the FADE finishes — or if it leaves the rect.
      landed = ord.equal(float(PHASE_FADE)).and(stageDone).or(escaped);
      nextH.assign(phaseH);
    }
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
      .assign(landed.select(vec4(fresh.brightness, fresh.sizePx, fresh.speed, spawnH()), vec4(c.x, c.y, c.z, nextH)));
    const agedMs = age.element(i).add(uDtSec.mul(float(1000)));
    age.element(i).assign(landed.select(float(0), agedMs));
    // A respawned stone starts falling again — the phase must reset with it, or
    // it would be reborn mid-bounce at the top of the sky.
    if (hasPhases) phaseBuf.element(i).assign(landed.select(float(PHASE_FALL), phaseBuf.element(i)));
    lifeBuf.element(i).assign(
      landed.select(
        spawnH()
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
    const fall01 = float(1).sub(c.w.div(spawnH())).clamp(float(0), float(1));
    const alive = float(i).lessThan(uActiveCount).select(float(1), float(0));

    // ⭐ THE BIRTH FADE — the author's own diagnosis, and it was right:
    // *"could it be that when they spawn they spend a single frame without an
    // angle? Could we fade them in from birth so that by the time they appear
    // they've settled?"*
    //
    // ⚠️ THE MECHANISM IS SLIGHTLY DIFFERENT FROM THE GUESS, AND THE FIX IS THE
    // SAME ONE. A respawned body does get a velocity on its first frame, so it
    // is never literally angle-less — but that velocity was integrated at its
    // OLD position while its streak is drawn from its NEW one, and the body
    // teleports across the rect between the two. For one frame the direction it
    // points and the place it points from disagree, which is exactly the
    // "certain percentage at the wrong angle" — a steady ~1/lifetime fraction
    // of the population, scattered, never the same bodies twice.
    //
    // Fading in over the first `BIRTH_FADE_MS` makes that frame invisible
    // instead of trying to make it correct: by the time a body is opaque its
    // velocity and position describe the same motion. It also removes the pop
    // of a full-brightness streak appearing from nothing, which is V2's
    // universally-praised "clouds never pop" instinct applied one layer down.
    const birthFade = age.element(i).div(float(BIRTH_FADE_MS)).clamp(float(0), float(1));
    // Smoothstep rather than linear: a linear ramp from zero still has a hard
    // first derivative at t=0 and reads as a flicker at these lifetimes.
    const birthEase = birthFade.mul(birthFade).mul(float(3).sub(birthFade.mul(float(2))));

    // ⚠️ THE DRAWN POSITION AND THE SCENE CLIP ARE COMPUTED BEFORE THE SKY-GATE
    // EARLY-OUT BELOW, because clipping to the map is INDEPENDENT of whether a
    // sky-reach texture was ever injected. A first cut computed them after, so
    // a viewer with no gate armed (the ordinary case on an un-ingested floor)
    // silently lost its scene clip too — one absent input disabling an
    // unrelated guarantee.
    const pDrawn = parallaxOf(position.element(i), c.w).xy;
    const hasBounds = uSceneRect.z.sub(uSceneRect.x).greaterThan(float(0));
    const edgeBand = float(64);
    const inX = pDrawn.x
      .sub(uSceneRect.x)
      .div(edgeBand)
      .clamp(float(0), float(1))
      .mul(uSceneRect.z.sub(pDrawn.x).div(edgeBand).clamp(float(0), float(1)));
    const inY = pDrawn.y
      .sub(uSceneRect.y)
      .div(edgeBand)
      .clamp(float(0), float(1))
      .mul(uSceneRect.w.sub(pDrawn.y).div(edgeBand).clamp(float(0), float(1)));
    const sceneClip = hasBounds.select(inX.mul(inY), float(1));

    /**
     * ⭐ THE SQUALL BANDS, IN THE BODIES (P4, §3.4 job 2).
     *
     * ⚠️ THE **SAME** FIELD THE CURTAIN DRAWS, from the same module, not a
     * second noise that happens to look similar. §3.4: *"One field, two
     * consumers, no fork."* If they ever diverge, a downpour shows a dense band
     * of drops falling through a thin patch of veil — worse than no bands.
     *
     * ⚠️ AND IT MODULATES **OPACITY**, WHICH **IS** DENSITY HERE — the same
     * statistical identity the sky gate already relies on: a uniform spatial
     * process times a multiplicative visibility mask yields visible density
     * proportional to the mask. Biasing the SPAWN instead would need the field
     * in the compute stage plus a rejection loop, and would thin the population
     * at the rect edge in exactly the way `SPAWN_MARGIN_FRAC` exists to prevent.
     */
    const squall = buildSquallField(TSL, {
      worldXY: pDrawn,
      timeMs: uTimeMs,
      directionDeg: uWindDirDeg,
      speed01: uWindSpeed01,
      gustiness01: uGustiness01,
      bandDepth: uSquallDepth,
      scale: uSquallScale,
    });

    const visible = alive.mul(birthEase).mul(sceneClip).mul(squall);

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
    if (!skyReachTex) return vec4(fall01, c.x, visible, float(1));

    const p = pDrawn;
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

    // `z` carries alive × the birth fade — both are pure opacity multipliers,
    // and packing them costs no extra varying (storage reads are vertex-stage
    // only, so every fragment input has to fit in this one vec4).
    return vec4(fall01, c.x, visible, skyGate);
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

    const width = c.y.mul(uSizeScale).mul(uViewScale).mul(alive).mul(persp);

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
    // ⭐ THE CONVERGENCE SHIFT, FROM THE TILT ANGLE. Lines tilted by θ have
    // their vanishing point `tan(θ)·D` from the nadir — see `uWindAirSpeed` for
    // why an angle rather than the velocity ratio this used to divide.
    // ⭐ THE CONVERGENCE SHIFT IS `vel · D / fallSpeed` — the EXACT algebraic
    // equivalent of the two-term derivative, so the single-term form stays
    // faithful rather than approximating it. Two corrections live here:
    //
    //  · IT IS DOWNWIND. A previous cut negated it ("the vanishing point sits
    //    behind the fall lines"), which broke the equivalence and pointed every
    //    streak the wrong way — the author's *"rain streaks don't align with
    //    their wind driven direction; they end up pointing sideways when pushed
    //    by wind."* The algebra admits no sign choice: substituting
    //    `offset = vel·D/(M·v)` into `−(P−C−offset)·M²·v/D` reproduces
    //    `vel·M − (P−C)·M²·v/D` only with the POSITIVE offset. I reasoned about
    //    where a vanishing point "should" be instead of doing the substitution.
    //  · THE TILT IS DERIVED from the drift now rather than dialled, so the
    //    streak's direction and the body's actual travel cannot disagree —
    //    they are the same quantity.
    /**
     * ⚠️ **CLAMPED, AND THE UNCLAMPED VERSION WAS A REPORTED BUG.** Author,
     * live: *"some raindrops seem to fall a lot slower than other raindrops,
     * unrealistically slow. These raindrops seem to be very resistant to
     * pointing the correct direction."* Two symptoms, and this is the second's
     * cause.
     *
     * The offset is `vel × D / fallSpeed` — physically right (a slow drop
     * spends longer in the air, so the wind carries it further and its
     * vanishing point sits further downwind), but it diverges as `fallSpeed`
     * shrinks. The slowest drops therefore got a convergence point hundreds of
     * screen-widths away, which makes `centre − convergence` point almost
     * exactly along the WIND for them while every faster drop points radially.
     * They were not resisting the correct direction so much as computing a
     * different one.
     *
     * Capping the offset at a few camera-heights keeps the physical ordering
     * (slower still leans further) and removes the runaway. A cap rather than a
     * softer curve because the runaway is the whole problem and a curve would
     * only move the speed at which it starts.
     */
    const rawWindOffset = vel.mul(uCamHeight).div(fallSpeed).mul(uFallSlant01);
    const offsetLen = rawWindOffset.length().max(float(1e-4));
    const cappedLen = offsetLen.min(uCamHeight.mul(float(WIND_OFFSET_MAX_CAM_HEIGHTS)));
    const windOffset = rawWindOffset.mul(cappedLen.div(offsetLen));
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
      // ⚠️ `length`, NOT `width`, ON THE ALONG AXIS — and using `width` here
      // was why snow could not respond to wind at ANY setting.
      //
      // This branch discarded `length` entirely, so a flake was always a
      // perfect square: `streakPerPxS` could never reach it, and the ONLY
      // visual signature wind has on a round body is exactly that smear.
      // Flakes drifted correctly the whole time (snow has the highest
      // `windCarry01` in the table) — but a round dot moving sideways looks
      // identical to one standing still, and uniform respawn keeps the
      // population's density flat too, so nothing on screen changed. The
      // author's report was precise: *"snow isn't yet affected by wind."*
      //
      // A dead-calm flake still reads as round because snow's own
      // `streakPerPxS` is a quarter of rain's and its fall speed is an order
      // of magnitude lower — `length` and `width` are then near-identical.
      // The stretch only appears once something is genuinely driving it.
      along = ry.mul(length);
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
      /**
       * ⭐ A ROUGH, IRREGULAR CRYSTAL — NOT A ROUND DOT.
       *
       * ⚠️ AUTHOR: *"I don't want them to look like cartoon snow drops, but
       * rougher more random shapes feels like a good idea."* The previous
       * expression was a clean radial falloff, i.e. exactly a cartoon drop —
       * every flake on the map the same circle at a different size.
       *
       * The fix is the SPLASH's lesson reused (P2): perturb the radius with
       * **two coprime integer harmonics** of the angle. Integer because `atan`
       * wraps at ±π and any other multiple leaves a hard radial seam; COPRIME
       * (`n` and `n+1`) because a single harmonic is exactly n-fold symmetric
       * and would produce the six-petal rosette that made the droplets
       * archetype read as a snowflake — which is a wonderful irony here, since
       * a real flake should be irregular, not a paper cut-out.
       *
       * The per-body phase and harmonic come from `brightness`, which already
       * crosses as a varying and is already an arbitrary per-body identity.
       * Reusing it correlates a flake's shape with its brightness; that is a
       * correlation between two RANDOM values, which is still random-looking,
       * and it costs no extra varying slot on a stage that has none to spare.
       */
      const p = uv().sub(float(0.5)).mul(float(2));
      const theta = atan(p.y, p.x);
      const phase = bright.mul(float(43.7));
      // 5..8 arms, per body — a range rather than a constant, so a drift of
      // flakes is not one crystal repeated.
      const arms = bright.mul(float(4)).floor().add(float(5));
      const rough = cos(theta.mul(arms).add(phase))
        .mul(float(0.62))
        .add(cos(theta.mul(arms.add(float(1))).add(phase.mul(float(1.7)))).mul(float(0.38)));
      // The radius the falloff measures against, wobbled. Bounded well away
      // from 0 so a deep notch cannot invert the shape inside out.
      const rr = float(1).add(rough.mul(float(ROUGHNESS)));
      const d = p
        .length()
        .div(rr.max(float(0.35)))
        .clamp(float(0), float(1));
      const soft = float(1).sub(d);
      // `softness01` picks how quickly it falls off: squared is a gentle cloud,
      // the higher power a tighter pellet (which is what hail wants).
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
    step(renderer, dtSec, timeMs, wind) {
      if (!S) return;
      // Re-read the wind EVERY frame from whatever handle the caller currently
      // holds — see `uWindSpeed01`'s note on why this cannot be a build-time
      // binding. A caller that passes nothing keeps the last values rather
      // than snapping the rain upright.
      if (wind?.ambient) {
        const sp = wind.ambient.speed01?.value;
        const dg = wind.ambient.directionDeg?.value;
        const gu = wind.ambient.gustiness01?.value;
        if (Number.isFinite(sp)) uWindSpeed01.value = sp;
        if (Number.isFinite(dg)) uWindDirDeg.value = dg;
        // The squall field's travelling half IS the wind door's gust envelope,
        // so it needs the same gustiness the vegetation bends to.
        if (Number.isFinite(gu)) uGustiness01.value = gu;
      }
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

    /**
     * The SCENE's own bounds — precipitation fades out beyond them so rain
     * never falls in the void around the map. See {@link uSceneRect}'s note
     * for why this is a draw clip rather than a spawn clamp.
     *
     * ⚠️ DISTINCT FROM `setWorldRect`, which is the VIEW rect (where bodies
     * spawn, and which follows the camera). Conflating them would either stop
     * the rain the moment the camera left the map centre, or clip nothing at
     * all — two rects, two questions, deliberately two calls.
     *
     * Passing `null` disables the clip (rain everywhere), the same fail-open
     * polarity the sky gate uses.
     * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} rect
     */
    setSceneBounds(rect) {
      if (!rect || !(rect.maxX > rect.minX)) {
        uSceneRect.value.set(0, 0, 0, 0);
        return { clipped: false };
      }
      uSceneRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
      return { clipped: true, rect };
    },

    /** @param {{minX:number,minY:number,maxX:number,maxY:number}} rect */
    setWorldRect(rect) {
      if (!rect) return;
      uRectMin.value.set(rect.minX, rect.minY);
      uRectSize.value.set(Math.max(1, rect.maxX - rect.minX), Math.max(1, rect.maxY - rect.minY));
      uCamCentre.value.set((rect.minX + rect.maxX) * 0.5, (rect.minY + rect.maxY) * 0.5);
      // ⭐ ZOOM INVARIANCE — see `uViewScale`. Every length this runtime owns
      // (fall speed, wind speed, body size, spawn height, camera height) is
      // expressed relative to the view's own span, so the weather keeps its
      // apparent pace and scale as the camera moves instead of being glued to
      // the world. `uCamHeight` scales here too, which is what keeps `h/D` —
      // and therefore the parallax — identical at every zoom.
      const span = Math.max(1, Math.max(rect.maxX - rect.minX, rect.maxY - rect.minY));
      uViewScale.value = span / REFERENCE_VIEW_SPAN_PX;
      uCamHeight.value = camHeightBase * uViewScale.value;
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
      if (Number.isFinite(t.windAirSpeedPxS)) uWindAirSpeed.value = Math.max(0, t.windAirSpeedPxS);
      // ⭐ THE SAME DIAL THE CURTAIN READS — one control for one phenomenon.
      // Two band-depth sliders, one for the veil and one for the bodies, is
      // how the two pictures end up disagreeing about where the squall is.
      if (Number.isFinite(t.curtainBandDepth)) uSquallDepth.value = Math.max(0, Math.min(1, t.curtainBandDepth));
      if (Number.isFinite(t.curtainBandScale)) uSquallScale.value = Math.max(0.01, t.curtainBandScale);
      if (Number.isFinite(t.parallaxStreak01)) uParallaxStreak01.value = Math.max(0, Math.min(1, t.parallaxStreak01));
      if (Number.isFinite(t.cameraHeight)) camHeightBase = Math.max(1, t.cameraHeight);
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
        /** ⚠️ COUNTED, NOT ASSUMED. Rain and snow bind 6; hail binds 7 because
         * it references the arena's `phase` slot. A hard-coded 6 would have
         * under-reported the one species that is actually near the
         * 8-per-stage floor — exactly the reading a future "can I add a buffer?"
         * question depends on. */
        storageBuffers: hasPhases ? 7 : 6,
        phases: hasPhases,
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
          windAirSpeedPxS: uWindAirSpeed.value,
          squallDepth: uSquallDepth.value,
          parallaxStreak01: uParallaxStreak01.value,
          cameraHeight: uCamHeight.value,
        },
        frame: lastFrame,
        wind: { speed01: uWindSpeed01?.value ?? 0, directionDeg: uWindDirDeg?.value ?? 0 },
      };
    },
  };
}
