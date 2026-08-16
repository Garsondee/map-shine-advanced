/**
 * THE MANTLE — the GPU side (Precipitation.md §5.1/§5.3).
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 *
 * ONE small world-space RGBA8 buffer per floor, ping-pong integrated at LOW
 * cadence, and TWO overlay meshes that render it over the ground before
 * lighting. `mantle-model.js` owns every number; this owns the texels.
 *
 * Channels (`MANTLE_CHANNELS` — one byte, one quantity, named):
 * `R snow01` · `G dust01` · `B puddle01` · `A trample01`.
 *
 * ============================================================================
 * ⭐ TWO MESHES, BECAUSE SNOW AND DUST ARE TWO BLEND OPS
 * ============================================================================
 *
 * §5.3: *"dust MULTIPLIES toward its tint; snow BRIGHTENS — two channels
 * because they are two different blend ops, not two colours of one op"*. One
 * mesh cannot do both: a material has one blend state.
 *
 * So this follows `effects/water/water-render.js` exactly — the two-mesh
 * precedent §5.3 names — including the part that is easy to miss:
 *
 * ⚠️ **THE MULTIPLY MESH MUST OVERRIDE ITS `attr` MRT OUTPUT TO WHITE.**
 * `vt/scene-attr.js` writes `attr = vec4(0)` by default, which is do-not-touch
 * *for an alpha blend* (`dst·(1−0) + 0·0 = dst`). Blend state is NOT
 * per-attachment, so a multiply mesh applies `dst · src` to attachment 1 too,
 * and `attr · 0` would silently ZERO the floor attributes under every snowy
 * texel — floorId, outdoors, presence, solidity, all gone, across a quad that
 * covers the entire floor. **The neutral element of a blend is a property of
 * the BLEND** (`feedback_blend_neutral_element_is_per_blend`): white for a
 * multiply, zero for an alpha blend. Both are set explicitly below, and the
 * alpha-blend one is stated rather than left to luck precisely because its
 * neighbour is a counter-example to "vec4(0) always means don't touch it".
 *
 * ⚠️ DESTINATION ALPHA IS LEFT ALONE BY BOTH. `buf:scene.color`'s alpha is the
 * level-composite coverage the floor stack is assembled with, and neither "snow
 * lies here" nor "this stone is wet" is a statement about coverage.
 * `Zero·src + One·dst` is the identity on it.
 *
 * ============================================================================
 * ⭐ CADENCE IS REAL TIME; AMOUNT IS GAME TIME
 * ============================================================================
 *
 * The buffer steps a few times a second (REAL, so the GPU cost is bounded and
 * a fast game clock cannot turn into a fast frame cost), and each step
 * integrates however much GAME time actually elapsed (so a fast clock deposits
 * MORE PER STEP rather than more often). Two clocks, two jobs — see
 * `mantle-model.js`'s header for why conflating them is the sim-clock-throttle
 * latch bug.
 *
 * ============================================================================
 * ⚠️ WHAT P3 v1 DOES NOT BUILD, NAMED SO NOBODY READS §5.2 AS DONE
 * ============================================================================
 *
 * **TRAMPLE STAMPS — footprints — are NOT built.** Every other row of §5.2's
 * table is here (accumulate, ambient melt, ⭐ fire melt, dry, recover); the
 * `trample01` channel exists, is integrated, and RECOVERS on schedule. What is
 * missing is the writer: nothing stamps a print into it.
 *
 * That is a scope decision with a reason, not an omission. Trample is the one
 * row of §5.2 that is **not an integrator** — it needs a CPU-side queue fed
 * from token motion, a seam into the token layer, and a way to write a sparse
 * stamp into a buffer whose every other term is a full-screen rate. Half of
 * that shipped alongside a working mantle would be a channel that dents but
 * never heals, or heals but never dents, and either reads as "footprints are
 * broken" rather than "footprints are next". The recover term is here because
 * it belongs to the integrator and costs nothing; the stamp lands with its
 * seam.
 *
 * @module effects/precipitation/mantle-runtime
 */
import { createLogger } from '../../core/log.js';
import { resolveMantleStep, seedMantleDepth, gameHourDelta } from './mantle-model.js';

const log = createLogger('precip-mantle');

/**
 * Longest edge of the buffer, in texels. §5.1's number: on the 10k bench map
 * this is ~5 world px per texel — footprint-legible and cheap (2048×952 RGBA8
 * ≈ 8 MB). Deliberately NOT world resolution: the mantle is a stain buffer, and
 * a stain does not need to resolve a brick.
 */
const MAX_DIMENSION = 2048;

/**
 * How often the integrator runs, in REAL seconds. A few Hz — §5.1's *"never per
 * frame"*. At 4 Hz a melt that takes a game hour is 14,400 steps at a 1:1
 * clock, which is far more resolution than an 8-bit channel can even hold.
 */
const STEP_INTERVAL_SEC = 0.25;

/**
 * Build the mantle for ONE floor.
 *
 * @param {object} deps
 * @param {*} deps.THREE - injected.
 * @param {(w: number, h: number) => object} deps.createTarget - the ALLOCATOR
 *   DOOR. Injected exactly as `effects/fluid`'s `createSimRenderTarget` is, so
 *   the allocator stays the one place render targets come from and this module
 *   never reaches for `new THREE.RenderTarget` itself.
 * @param {(target: object) => void} [deps.disposeTarget]
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} deps.worldRect -
 *   the FLOOR's bounds. The buffer spans exactly this.
 * @param {*} [deps.openSkyTexture] - the injected 1×1 WHITE placeholder, same
 *   one the fall and the splashes take. White = "sky fully open" = the
 *   fail-open answer as the literal content of the texture, not a branch.
 * @returns {object}
 */
export function createMantleRuntime({
  THREE,
  createTarget,
  disposeTarget = null,
  /**
   * `(quad, target) => void` — binds `target` with NO MRT, renders `quad`, and
   * restores whatever was bound. Injected because `renderer-state/graph-only`
   * walls this zone from touching renderer state; see `dispatch`.
   */
  renderStep = null,
  worldRect,
  openSkyTexture = null,
}) {
  const TSL = THREE.TSL;
  const { Fn, float, vec2, vec3, vec4, uniform, uv, mix, positionGeometry, mrt } = TSL;

  const spanX = Math.max(1, worldRect.maxX - worldRect.minX);
  const spanY = Math.max(1, worldRect.maxY - worldRect.minY);
  // Aspect-preserving, capped on the LONG edge — a tall thin floor must not get
  // a 2048×2048 buffer of which 80% is empty.
  const scale = MAX_DIMENSION / Math.max(spanX, spanY);
  const texW = Math.max(8, Math.round(spanX * scale));
  const texH = Math.max(8, Math.round(spanY * scale));

  /** Ping-pong pair. `read` is what the overlay samples and the integrator
   * reads; `write` is where the next state lands. They swap after every step. */
  let read = createTarget(texW, texH);
  let write = createTarget(texW, texH);
  if (!read || !write) {
    log.warn('mantle targets were not allocated — the mantle will draw nothing.');
  }

  // ── THE INTEGRATOR'S UNIFORMS — every one a RATE from `mantle-model.js` ───
  const uDtHours = uniform(float(0));
  const uSnowGain = uniform(float(0));
  const uDustGain = uniform(float(0));
  const uPuddleGain = uniform(float(0));
  const uMelt = uniform(float(0));
  const uFireMelt = uniform(float(0));
  const uDry = uniform(float(0));
  const uTrampleRecover = uniform(float(0));
  const uTrampleBury = uniform(float(0));
  /** 1 while a seed pass is running — see `seed()`. A build-time branch is
   * impossible here (seeding happens at runtime, on load and on floor change),
   * so this is one of the few honest uniform gates in the subsystem. */
  const uSeedMode = uniform(float(0));
  const uSeedSnow = uniform(float(0));
  const uSeedDust = uniform(float(0));
  const uSeedPuddle = uniform(float(0));

  const uWorldRect = uniform(vec4(worldRect.minX, worldRect.minY, worldRect.maxX, worldRect.maxY));
  const uSkyRect = uniform(vec4(0, 0, 1, 1));
  const uSkyHasBake = uniform(float(0));
  const uFireRect = uniform(vec4(0, 0, 1, 1));
  const uFireHasBake = uniform(float(0));

  const openPixel = openSkyTexture ?? null;
  /** ⚠️ SEPARATE `texture()` NODES PER CONSUMER — a shared node carries the
   * wrong uv. Both start on the 1×1 white placeholder, whose content IS the
   * fail-open answer: sky fully open, no fire anywhere is the `hasBake` flag's
   * job rather than the texel's. */
  const prevTex = read ? TSL.texture(read.texture) : null;
  const skyTex = openPixel ? TSL.texture(openPixel) : null;
  const fireTex = openPixel ? TSL.texture(openPixel) : null;

  /** World position of this texel. The buffer spans the floor rect exactly, so
   * this is a plain lerp — no margin, no padding, nothing to get wrong. */
  const worldAt = (texUv) =>
    vec2(
      mix(uWorldRect.x, uWorldRect.z, texUv.x),
      // Row 0 = minY, matching `MaskGrid`'s convention and every bake in this
      // project (`flipY: false`). One direction, agreed everywhere.
      mix(uWorldRect.y, uWorldRect.w, texUv.y)
    );

  /**
   * Sample a baked mask at a WORLD position, mapped through its own rect.
   * Outside the rect there is no data — and for BOTH masks here the absence
   * default is the one that keeps the mantle alive: sky reaches (so snow keeps
   * falling) and no fire (so nothing melts). `fallback` states which.
   */
  const sampleMask = (tex, rect, hasBake, world, fallback) => {
    if (!tex) return float(fallback);
    const sx = world.x.sub(rect.x).div(rect.z.sub(rect.x).max(float(1)));
    const sy = world.y.sub(rect.y).div(rect.w.sub(rect.y).max(float(1)));
    const inside = sx
      .greaterThanEqual(float(0))
      .and(sx.lessThanEqual(float(1)))
      .and(sy.greaterThanEqual(float(0)))
      .and(sy.lessThanEqual(float(1)));
    const sampled = tex.sample(vec2(sx.clamp(float(0), float(1)), sy.clamp(float(0), float(1)))).r;
    return mix(float(fallback), sampled, hasBake.mul(inside.select(float(1), float(0))));
  };

  // ── THE INTEGRATOR ───────────────────────────────────────────────────────
  const integratorMaterial = new THREE.NodeMaterial();
  integratorMaterial.colorNode = Fn(() => {
    const texUv = uv();
    const world = worldAt(texUv);
    const sky = sampleMask(skyTex, uSkyRect, uSkyHasBake, world, 1);
    const fire = sampleMask(fireTex, uFireRect, uFireHasBake, world, 0);

    if (!prevTex) return vec4(0, 0, 0, 0);
    const prev = prevTex.sample(texUv);

    // ⭐ THE SEED PATH (§5.5). A reload rederives the mantle from the weather
    // that has recently been in force rather than loading a saved one — the
    // buffer is deliberately NOT serialized. The DEPTH is uniform (history is
    // genuinely gone) but the SHAPE is right on the very first frame, because
    // sky reach still multiplies it: snow lies in the courtyard and not under
    // the colonnade, immediately.
    const seeded = vec4(uSeedSnow.mul(sky), uSeedDust.mul(sky), uSeedPuddle.mul(sky), float(0));

    // ── ACCUMULATE — only where sky reaches (LAW 3, on the ground this time) ──
    const dt = uDtHours;
    const snowIn = uSnowGain.mul(sky).mul(dt);
    const dustIn = uDustGain.mul(sky).mul(dt);
    const puddleIn = uPuddleGain.mul(sky).mul(dt);

    // ── MELT / DRY ──
    // ⚠️ AMBIENT MELT IS **NOT** SKY-GATED, and the asymmetry is the point:
    // snow under a colonnade never accumulated, but snow that drifted there
    // must still melt when the day warms. Gating the sink the same way as the
    // source would leave permanent ice in every sheltered corner — the shape of
    // the bug where a symmetric-looking pair of terms answers two different
    // questions (`feedback_gate_and_self_exclusion_answer_different_questions`).
    const snowOut = uMelt.add(uFireMelt.mul(fire)).mul(dt);
    const puddleOut = uDry.mul(dt);

    const snow = prev.r.add(snowIn).sub(snowOut).clamp(float(0), float(1));
    const dust = prev.g.add(dustIn).clamp(float(0), float(1));
    // ⭐ MELTWATER BECOMES PUDDLE. The one transfer between channels, and it is
    // what stops a thaw reading as snow simply being deleted: what leaves `snow`
    // by AMBIENT melt arrives in `puddle` (fire melt does not — it boils off,
    // and a hearth ringed by a moat would be absurd).
    const melted = uMelt.mul(dt).min(prev.r);
    const puddle = prev.b
      .add(puddleIn)
      .add(melted.mul(float(0.35)))
      .sub(puddleOut)
      .clamp(float(0), float(1));

    // ── TRAMPLE: recovers on its own, and fresh snow buries it faster ──
    const trample = prev.a.sub(uTrampleRecover.mul(dt)).sub(uTrampleBury.mul(dt)).clamp(float(0), float(1));

    const stepped = vec4(snow, dust, puddle, trample);
    return mix(stepped, seeded, uSeedMode);
  })();
  integratorMaterial.depthTest = false;
  integratorMaterial.depthWrite = false;

  /**
   * ⚠️ `QuadMesh`, NEVER A HAND-ROLLED `PlaneGeometry(2, 2)` — and the first
   * cut here was the hand-rolled one, which `gpu/no-handrolled-fullscreen-quad`
   * caught. The vendor's quad owns v=0-at-top on BOTH backends; a hand-rolled
   * one inherits whichever flip the author happened to assume, which is
   * `feedback_y_flip_recurring_risk` (bitten five times in this project) with a
   * fresh coat of paint. Every other fullscreen pass in the codebase uses this.
   */
  const integratorQuad = new THREE.QuadMesh(integratorMaterial);

  // ── THE OVERLAY — two meshes over the floor AABB (see the header) ─────────
  const uSnowTint = uniform(vec3(0.93, 0.95, 1.0));
  const uDustTint = uniform(vec3(0.42, 0.4, 0.38));
  const uWetTint = uniform(vec3(0.62, 0.66, 0.72));
  const uSnowStrength = uniform(float(1));
  const uDustStrength = uniform(float(1));
  const uWetStrength = uniform(float(1));

  /** The mantle sampled at a WORLD position — the overlay quad spans the same
   * rect the buffer does, so this is `positionGeometry` mapped straight back
   * through `uWorldRect`. A SEPARATE texture node from the integrator's, for
   * the shared-node/wrong-uv reason. */
  const overlayTex = read ? TSL.texture(read.texture) : null;
  const sampleMantle = () => {
    if (!overlayTex) return vec4(0, 0, 0, 0);
    const p = positionGeometry.xy;
    const sx = p.x.sub(uWorldRect.x).div(uWorldRect.z.sub(uWorldRect.x).max(float(1)));
    const sy = p.y.sub(uWorldRect.y).div(uWorldRect.w.sub(uWorldRect.y).max(float(1)));
    return overlayTex.sample(vec2(sx, sy));
  };

  /**
   * ⚠️ COVERAGE IS A SOFT THRESHOLD OF DEPTH, NOT DEPTH ITSELF (§5.3), and it
   * is what makes accumulation CREEP rather than flood. A linear depth→alpha
   * would fade the whole floor up uniformly like a dissolve; a threshold means
   * the deepest places whiten first and the edge advances, which is how snow
   * actually arrives.
   *
   * The offset noise is deliberately STATIC and positional, so the advancing
   * edge is ragged and pinned to the ground rather than crawling.
   */
  const coverageOf = (depth) => {
    const p = positionGeometry.xy;
    // A cheap two-octave hash-free wobble: two sines at incommensurate
    // wavelengths. Static in time — a noise that animated would make the snow
    // line shimmer, which reads as a shader bug rather than as weather.
    const n = p.x
      .mul(float(0.031))
      .sin()
      .mul(float(0.5))
      .add(p.y.mul(float(0.043)).sin().mul(float(0.5)))
      .add(
        p.x
          .mul(float(0.011))
          .add(p.y.mul(float(0.017)))
          .sin()
          .mul(float(0.35))
      );
    const edge = n.mul(float(0.16));
    return depth.mul(float(1.6)).add(edge).clamp(float(0), float(1));
  };

  // MESH 1 — DARKEN. Dust greys the world; standing water darkens it. Both are
  // multiplies, so they share one mesh and one blend.
  const darkenMaterial = new THREE.NodeMaterial();
  darkenMaterial.colorNode = Fn(() => {
    const m = sampleMantle();
    const dust = coverageOf(m.g).mul(uDustStrength);
    const wet = coverageOf(m.b).mul(uWetStrength);
    // Two multiplies composed, each toward its own tint — `mix(white, tint, a)`
    // is the multiplicative factor that leaves the surface alone at a = 0.
    const factor = mix(vec3(1, 1, 1), uDustTint, dust).mul(mix(vec3(1, 1, 1), uWetTint, wet));
    return vec4(factor, 1);
  })();
  // ⚠️ WHITE, not the renderer-global zero — the MULTIPLICATIVE identity. See
  // the header: `attr · 0` erases the floor attributes under every texel this
  // floor-wide quad touches, and blend state is not per-attachment.
  darkenMaterial.mrtNode = mrt({ attr: vec4(1, 1, 1, 1) });

  // MESH 2 — BRIGHTEN. Snow is an albedo LERP toward its tint, i.e. a
  // premultiplied alpha blend, which is a different op from the multiply above
  // and therefore a different mesh.
  const brightenMaterial = new THREE.NodeMaterial();
  brightenMaterial.colorNode = Fn(() => {
    const m = sampleMantle();
    const snow = coverageOf(m.r).mul(uSnowStrength).clamp(float(0), float(1));
    // Compacted prints read grey-blue and slightly LOWER than the surface, so
    // trample both dims the tint and thins the coverage.
    const packed = m.a.clamp(float(0), float(1));
    const tint = mix(uSnowTint, uSnowTint.mul(float(0.72)), packed);
    const alpha = snow.mul(float(1).sub(packed.mul(float(0.45))));
    // PREMULTIPLIED: the colour is already scaled by its own alpha, which is
    // what `One / OneMinusSrcAlpha` expects.
    return vec4(tint.mul(alpha), alpha);
  })();
  // Zero IS the do-not-touch value for an alpha blend (`dst·(1−0) + 0·0`).
  // Stated rather than left to luck, precisely because its neighbour above is a
  // counter-example to "vec4(0) always means don't touch it".
  brightenMaterial.mrtNode = mrt({ attr: vec4(0, 0, 0, 0) });

  for (const material of [darkenMaterial, brightenMaterial]) {
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    // ⚠️ DoubleSide — the flipped camera (`top = minY`) inverts winding, and
    // `FrontSide` renders nothing at all, silently. The fifth runtime in this
    // codebase to need this line and the fifth to say so.
    material.side = THREE.DoubleSide;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendEquationAlpha = THREE.AddEquation;
    // Destination alpha untouched — see the header.
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
  }
  // `dst · src` — the multiply.
  darkenMaterial.blendSrc = THREE.ZeroFactor;
  darkenMaterial.blendDst = THREE.SrcColorFactor;
  // `src + dst·(1−srcA)` — premultiplied over.
  brightenMaterial.blendSrc = THREE.OneFactor;
  brightenMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;

  const quad = new THREE.PlaneGeometry(spanX, spanY);
  quad.translate((worldRect.minX + worldRect.maxX) / 2, (worldRect.minY + worldRect.maxY) / 2, 0);
  /**
   * ⚠️ `renderOrder` JUST ABOVE WATER's 0.5/0.51, and inside the WORLD scene.
   * The flat sort law (`scene/layer-order.js`) makes ascending renderOrder the
   * layering, so this puts the mantle over the ground art and the water surface
   * but under tokens, doors and vegetation — which is where a blanket of snow
   * belongs. Drawing it as a separate pass after the world would put snow on
   * top of the tokens standing in it.
   */
  const darkenMesh = Object.assign(new THREE.Mesh(quad, darkenMaterial), { renderOrder: 0.52 });
  const brightenMesh = Object.assign(new THREE.Mesh(quad, brightenMaterial), { renderOrder: 0.53 });
  darkenMesh.frustumCulled = false;
  brightenMesh.frustumCulled = false;

  let sinceStepSec = 0;
  let lastGameHours = null;
  let stepsRun = 0;
  let seeded = false;
  let lastStep = null;

  /**
   * Run ONE integrator dispatch into `write`, then swap.
   *
   * ⚠️ THE RENDER ITSELF IS **INJECTED**, not performed here. `renderer-state/
   * graph-only` walls `effects/` from `renderer.setRenderTarget(` — the same
   * wall `effects/fluid/fluid-surface-subsystem.js` documents in its own header
   * — because renderer state is global and a zone that binds a target owes
   * every other zone a restore it cannot be trusted to make. The first cut here
   * did the bind/restore dance inline and was caught by that rule.
   *
   * The viewer's `renderMantleStep` owns the whole dance, including the MRT
   * detail that is easy to lose: **MRT must be UNBOUND for the integrator**,
   * because `MRTNode` matches its keys against the bound target's TEXTURE
   * NAMES, and this target has none of them — a key with no match yields an
   * empty output struct, i.e. no fragment output at all.
   */
  function dispatch() {
    if (!read || !write || !renderStep) return;
    prevTex.value = read.texture;
    renderStep(integratorQuad, write);
    const swap = read;
    read = write;
    write = swap;
    // The OVERLAY must follow the swap or it samples the buffer the integrator
    // is about to overwrite — one frame of stale mantle, every frame.
    if (overlayTex) overlayTex.value = read.texture;
    stepsRun++;
  }

  return {
    /** Both overlay meshes, in draw order. The caller adds them to the WORLD
     * scene (see `renderOrder` above) rather than rendering them itself. */
    meshes: [darkenMesh, brightenMesh],
    texW,
    texH,
    /** True once the buffer holds a real state rather than an undefined one. */
    get isSeeded() {
      return seeded;
    },

    /**
     * ⭐ §5.5 — fill the buffer from the weather that has recently been in
     * force. Call on build and on any discontinuity (floor change, a scene
     * load, the GM jumping the clock); NEVER per frame.
     */
    seed({ stay, precip01, temperature01, hoursOfWeather }) {
      const depth = seedMantleDepth({ stay, precip01, temperature01, hoursOfWeather });
      uSeedSnow.value = depth.snow01;
      uSeedDust.value = depth.dust01;
      uSeedPuddle.value = depth.puddle01;
      uSeedMode.value = 1;
      // TWICE, so BOTH targets hold the seeded state. A single pass leaves the
      // other half of the ping-pong holding whatever the allocator handed over,
      // and the very next `dispatch` would read it — one frame of garbage that
      // then integrates forward forever.
      dispatch();
      dispatch();
      uSeedMode.value = 0;
      seeded = true;
      lastGameHours = null;
      return depth;
    },

    /**
     * Advance the mantle. Cheap and safe to call every frame — it steps at most
     * once per {@link STEP_INTERVAL_SEC}.
     *
     * @param {number} dtRealSec - drives the CADENCE.
     * @param {number} todHour - the game clock, 0..24 and WRAPPING. Its delta
     *   drives the amount, unwrapped by `gameHourDelta` — a paused game hands
     *   the same number every call, so the delta is zero and the mantle freezes.
     *   That is the integrator pattern, not a throttle.
     * @param {object} inputs - `{stays, stay, precip01, temperature01, cloudCover01}`.
     *   `stays` is the WEIGHTED list (a blend deposits from every population);
     *   `stay` is the one-population form every existing caller still uses.
     */
    step(dtRealSec, todHour, inputs) {
      if (!read || !write || !renderStep) return null;
      if (!seeded) this.seed(inputs);
      sinceStepSec += Math.max(0, dtRealSec || 0);
      if (sinceStepSec < STEP_INTERVAL_SEC) return null;
      sinceStepSec = 0;

      const now = Number.isFinite(todHour) ? todHour : (lastGameHours ?? 0);
      // ⚠️ `null` ON THE FIRST STEP MEANS ZERO ELAPSED, not "integrate from
      // zero" — the first delta after a seed or a floor change would otherwise
      // be the whole clock reading and deposit a geological age of snow.
      // `gameHourDelta` owns the midnight wrap and the backward-clock case.
      const dtGameHours = gameHourDelta(lastGameHours, now);
      lastGameHours = now;

      const stepValues = resolveMantleStep({ ...inputs, dtGameHours });
      lastStep = stepValues;
      uDtHours.value = stepValues.dtGameHours;
      uSnowGain.value = stepValues.snowGainPerHour;
      uDustGain.value = stepValues.dustGainPerHour;
      uPuddleGain.value = stepValues.puddleGainPerHour;
      uMelt.value = stepValues.meltPerHour;
      uFireMelt.value = stepValues.fireMeltPerHour;
      uDry.value = stepValues.dryPerHour;
      uTrampleRecover.value = stepValues.trampleRecoverPerHour;
      uTrampleBury.value = stepValues.trampleBuryPerHour;
      dispatch();
      return stepValues;
    },

    /** LAW 3's input, and the fire mask that carves the melt halo. Both fail
     * OPEN (sky reaches, no fire) when disarmed. */
    setMasks({ skyReach, fireMask } = {}) {
      const armed = { sky: false, fire: false };
      if (skyTex) {
        if (skyReach?.texture && skyReach.rect) {
          skyTex.value = skyReach.texture;
          uSkyRect.value.set(skyReach.rect.minX, skyReach.rect.minY, skyReach.rect.maxX, skyReach.rect.maxY);
          uSkyHasBake.value = 1;
          armed.sky = true;
        } else if (openPixel) {
          skyTex.value = openPixel;
          uSkyHasBake.value = 0;
        }
      }
      if (fireTex) {
        if (fireMask?.texture && fireMask.rect) {
          fireTex.value = fireMask.texture;
          uFireRect.value.set(fireMask.rect.minX, fireMask.rect.minY, fireMask.rect.maxX, fireMask.rect.maxY);
          uFireHasBake.value = 1;
          armed.fire = true;
        } else if (openPixel) {
          fireTex.value = openPixel;
          uFireHasBake.value = 0;
        }
      }
      return armed;
    },

    /** The active species' `surface` block decides how its channel renders. */
    setSurface(stay) {
      const s = stay?.surface;
      if (!s) return;
      if (stay.channel === 'snow' && Array.isArray(s.tint)) uSnowTint.value.set(s.tint[0], s.tint[1], s.tint[2]);
      if (stay.channel === 'dust' && Array.isArray(s.tint)) uDustTint.value.set(s.tint[0], s.tint[1], s.tint[2]);
      if (stay.channel === null && Array.isArray(s.tint)) uWetTint.value.set(s.tint[0], s.tint[1], s.tint[2]);
    },

    setTuning(t = {}) {
      if (Number.isFinite(t.mantleSnowStrength)) uSnowStrength.value = t.mantleSnowStrength;
      if (Number.isFinite(t.mantleDustStrength)) uDustStrength.value = t.mantleDustStrength;
      if (Number.isFinite(t.mantleWetStrength)) uWetStrength.value = t.mantleWetStrength;
    },

    setVisible(v) {
      darkenMesh.visible = Boolean(v);
      brightenMesh.visible = Boolean(v);
    },

    /**
     * The target the overlay is currently sampling.
     *
     * ⚠️ FOR THE **BENCH**, and named so nobody mistakes it for a render path.
     * The mantle is the one part of precipitation whose bugs take GAME HOURS to
     * become visible, so `bench-precip`'s `mantle-remembers-the-weather` reads
     * the texels back directly rather than judging the overlay — "snow rose
     * from 0.02 to 0.71" is a finding, "the courtyard looks whiter" is a
     * hypothesis. Nothing in `src/` calls this.
     */
    debugTarget() {
      return read;
    },

    debugState() {
      return {
        texW,
        texH,
        seeded,
        stepsRun,
        stepIntervalSec: STEP_INTERVAL_SEC,
        lastGameHours,
        lastStep,
        visible: brightenMesh.visible,
        masks: { skyArmed: uSkyHasBake.value === 1, fireArmed: uFireHasBake.value === 1 },
        strengths: {
          snow: uSnowStrength.value,
          dust: uDustStrength.value,
          wet: uWetStrength.value,
        },
        /** ⚠️ NAMED, NOT OMITTED — `trample01` is integrated and recovers, but
         * nothing STAMPS it. See the module header for why that is a scope
         * decision rather than a bug. */
        trampleStamps: 'not built — P3 v1 integrates and heals the channel, nothing writes it',
      };
    },

    dispose() {
      if (disposeTarget) {
        disposeTarget(read);
        disposeTarget(write);
      }
      read = null;
      write = null;
      quad.dispose();
    },
  };
}
