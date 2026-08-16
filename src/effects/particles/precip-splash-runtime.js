/**
 * THE ARRIVAL — ground splashes (Precipitation.md §4.1), the fifth particle
 * runtime.
 *
 * ============================================================================
 * ⭐ STATISTICAL, NOT TRACKED — THE LOAD-BEARING DECISION
 * ============================================================================
 *
 * There is NO drop→splash coupling here. Not a queue, not an atomic counter,
 * not a readback. Impact sites are drawn from the same distribution the falling
 * bodies land in — `rate ∝ precip01 × skyReach(x,y)` — and that is the whole
 * emitter.
 *
 * V2 proved the equivalence by accident: its per-drop impact queue was capped
 * at `RAIN_IMPACT_MAX_QUEUE = 512` per frame
 * (`legacy/particles/WeatherParticles.js:123`) and the author's storms looked
 * right, i.e. at rain densities it was ALREADY statistical — the cap threw away
 * the correspondence long before anyone could see it. Keeping the coupling
 * would buy a property nobody can perceive and cost the atomics, the queue, the
 * CPU-side drain, and a whole class of "the splashes stopped but the rain
 * didn't" failures.
 *
 * ⚠️ HOW `skyReach` ENTERS IS THE SUBTLE PART. Bodies spawn UNIFORMLY over the
 * padded view rect and the mask multiplies their OPACITY, exactly as the fall
 * does. That is not an approximation of "rate ∝ skyReach" — it IS it: with a
 * uniform spatial process and a multiplicative visibility mask, the density of
 * *visible* splashes per unit area is the uniform rate times the mask. Trying
 * to bias the SPAWN by the mask instead would need the texture read in the
 * compute stage plus a rejection loop, and would thin the population near
 * covered edges in exactly the way `SPAWN_MARGIN_FRAC` exists to prevent.
 *
 * ⚠️ ONE FACTOR OF §4.1's RATE IS GENUINELY MISSING AND IS NOT FAKED: the
 * `squallField(x,y)` — the breathing bands that make heavy rain arrive in
 * gusts. That field is P4's (the impression curtain owns it), and inventing a
 * local noise here would be a second, private answer to a question another
 * slice is about to answer properly (`feedback_shared_field_two_meanings_two_
 * registries`). Recorded, not approximated.
 *
 * ============================================================================
 * WHY A SEPARATE ENGINE AND NOT §4.1's "SPLASH SUB-RANGE"
 * ============================================================================
 *
 * Precipitation.md §4.1 says splashes *"live in the same arena as a `splash`
 * sub-range with a trivial kernel"*. This is a separate `ParticleArena` and a
 * separate engine, and the divergence is argued rather than drifted into:
 *
 *  1. A sub-range makes the kernel branch PER BODY on which range it is in —
 *     a runtime branch over the whole population, which Effects.md Law 4 spends
 *     its whole text forbidding. Falling and splashing are as different as two
 *     species are, and species are already a BUILD-TIME split here.
 *  2. The draw has to split regardless: different geometry orientation,
 *     different material, different blending discipline, and an instance
 *     OFFSET that `InstancedBufferGeometry` has no clean way to express.
 *  3. The stated benefit — no new allocation machinery — is preserved anyway,
 *     because this reuses `ParticleArena` unchanged. "Splashes are bodies too"
 *     is the claim that mattered, and it still holds.
 *
 * The storage budget is what the sub-range was really protecting, and it is
 * COUNTED: this kernel binds **5** of the 8-per-stage floor (position, age,
 * life, seed, custom — `velocity` is never referenced, so it never binds). The
 * fall binds 6. They are separate dispatches, so the limit is never summed.
 *
 * ============================================================================
 * ⭐ THE FOUR ARCHETYPES ARE V2's, BY NAME, AND THEY ARE A CONTINUUM HERE
 * ============================================================================
 *
 * V2 ran FOUR SEPARATE ParticleSystems, one per tile of a 2×2 sprite atlas, so
 * each could be hand-tuned — and `legacy/core/WeatherController.js:355-386`
 * names them in its own comments:
 *
 *   1. *"Thin clean ring"*    life 0.20–0.35 s · size  8–16 · peak 0.14
 *   2. *"Thick broken ring"*  life 0.09–0.22 s · size  2–3  · peak 0.14
 *   3. *"Droplets-only"*      life 0.20–0.79 s · size  6–27 · peak 0.33
 *   4. *"Inner puddle"*       life 0.305–1.40 s· size 10–24 · peak 0.08
 *
 * Those NUMBERS are transcribed exactly. The SHAPES are re-authored as one
 * parameterised per-fragment expression rather than four baked tiles — the
 * fire-sprite precedent (continuous phase beats a 64px atlas at every zoom),
 * and here it buys something extra: the four looks become the corners of a
 * five-knob space (`ringR, ringW, roughen01, disc01, spikes`), so a future
 * species can sit BETWEEN them without a new texture. `splashArchetype01`
 * slides the window over that space, which is exactly what §2.1's schema means
 * by *"which of the four V2 splash looks dominates"*.
 *
 * ⚠️ THE PER-ARCHETYPE CONSTANTS ARE GRAPH LITERALS, NOT UNIFORMS. They come
 * from a frozen species row and cannot change during the engine's life, so a
 * uniform would be a mutable home for an immutable fact. They are selected by a
 * ONE-HOT DOT against the body's archetype index, never by indexing a
 * `uniformArray` — that idiom fails in the fragment stage on this renderer
 * (memory: keyhole-uniformarray-indexed-read-unexplained-failures) and four
 * multiply-adds are cheaper than the bug.
 *
 * ============================================================================
 * WHAT A SPLASH DELIBERATELY DOES NOT DO
 * ============================================================================
 *
 * - **No parallax.** The fall applies `M(h) = D/(D−h)` because a falling body
 *   is between the eye and the map. A splash is ON the map: `h = 0`, `M = 1`,
 *   and applying the transform anyway would slide impacts off the surfaces
 *   that caused them.
 * - **No view scaling.** Every length the FALL owns rides `uViewScale`, because
 *   a curtain of rain is an atmospheric layer that must hold its apparent size
 *   as the camera moves. A splash is scenery — 40 world px of water on the
 *   flagstones is 40 world px at every zoom, and scaling it would make the
 *   flagstones appear to change size.
 * - **No gravity.** V2 gave splashes wind drift and no gravity; kept verbatim.
 *
 * @module effects/particles/precip-splash-runtime
 */
import { ParticleArena, BYTES_PER_PARTICLE } from './particle-arena.js';
import { createWindHandle } from '../../world/index.js';
import { createLogger } from '../../core/log.js';
import { resolveSpecies } from '../precipitation/precip-species.js';

const log = createLogger('precip-splash');
const TIER0_WIND_HANDLE = createWindHandle();

/**
 * How far outside the view rect splashes keep spawning, as a fraction of the
 * rect — the fall's own constant and for the same reason: bodies must already
 * exist off-screen when the camera pans, or a pan reveals a band that fills in
 * visibly. Smaller than the fall's 0.25 because a splash lives ~0.3 s and
 * cannot travel far enough to need the wider apron.
 */
const SPAWN_MARGIN_FRAC = 0.12;

/**
 * V2's `SizeOverLife` control points — `new Bezier(0.4, 4.0, 7.0, 9.0)`
 * (`legacy/particles/WeatherParticles.js:5207`), a cubic Bézier evaluated over
 * normalised age and MULTIPLIED onto the body's base size (three.quarks'
 * `SizeOverLife` semantics: `size = startSize × f(t)`).
 *
 * ⚠️ THE END POINT IS NOT WHERE THE SPLASH IS SEEN. B(1) = 9.0 sounds enormous
 * against a 12–24 px base, but the alpha triangle has already returned to ZERO
 * by then. At the alpha PEAK (t = 0.5) the curve reads B(0.5) = 5.3, so the
 * visible splash is ~64–127 world px — a hand's width of water on the ground,
 * which is what it should be. Reading the endpoint as "the size" is the same
 * mistake that made the rain a starfield (memory:
 * keyhole-precipitation-p1-built, BUG 1): a harvested control point is not a
 * harvested outcome.
 */
const GROWTH_BEZIER = Object.freeze([0.4, 4.0, 7.0, 9.0]);

/**
 * How much of the wind's air speed a splash inherits as ground drift.
 *
 * V2 attached an `ApplyForce` to each splash system, so the sheet of water
 * spreads downwind rather than sitting where it landed. Small on purpose: a
 * splash that TRAVELS reads as a skidding sprite, not as an impact.
 */
const WIND_DRIFT_CARRY = 0.08;

/**
 * Build the ground-splash engine for ONE species.
 *
 * Refuses — loudly, drawing nothing — for any species whose `arrive.kind` is
 * not `'splash'`. Snow settles (P3) and hail bounces (P5); neither is this.
 *
 * @param {object} deps
 * @param {*} deps.THREE - injected.
 * @param {string} [deps.speciesId='rain']
 * @param {object} [deps.worldRect] - `{minX,minY,maxX,maxY}`; `setWorldRect()`
 *   sets the real one each frame.
 * @param {number} [deps.capacity] - overrides the species row's splash capacity
 *   (the shader lab runs small).
 * @param {number} [deps.zDepth=0]
 * @param {number} [deps.renderOrder=0] - set on the MESH, not the scene.
 * @param {object} [deps.windHandle]
 * @param {*} [deps.openSkyTexture] - the injected 1×1 WHITE placeholder. See
 *   the fall runtime's note: `TSL.texture(null)` throws at graph-build inside a
 *   swallowed node, and white IS the fail-open answer.
 * @returns {object}
 */
export function createPrecipSplashEngine({
  THREE,
  speciesId = 'rain',
  worldRect = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
  capacity: capacityOverride = null,
  zDepth = 0,
  renderOrder = 0,
  windHandle = TIER0_WIND_HANDLE,
  openSkyTexture = null,
}) {
  const TSL = THREE.TSL;
  const { Fn, instanceIndex, float, vec2, vec3, vec4, uniform, sin, cos, atan, fract, uv, mix, positionGeometry } = TSL;

  const resolved = resolveSpecies(speciesId);
  const S = resolved.ok ? resolved.species : null;
  const A = S?.arrive ?? null;
  /**
   * ⚠️ THE DISCRIMINATOR IS `arrive.kind`, NOT "does the row have an arrive
   * block". Snow HAS one (`kind: 'settle'`) and must build no splash engine at
   * all — a settle is not a weak splash, it is a different phenomenon owned by
   * P3. Testing for the block's existence would have made snow splash.
   */
  const splashes = A?.kind === 'splash';
  if (!splashes) {
    log.info(
      `species '${speciesId}' arrives as '${A?.kind ?? 'nothing'}' — no ground splashes. This engine draws nothing.`
    );
  }

  const ARCH = A?.archetypes ?? [];
  const capacity = Math.max(1, Math.floor(capacityOverride ?? A?.capacity ?? 1));
  /** Splashes alive per megapixel of view at full precip — see the species
   * row, which explains at length why this is per-AREA and why deriving it
   * from `capacity` was the bug. */
  const PER_MEGAPIXEL = Number.isFinite(A?.splashesPerMegapixel) ? A.splashesPerMegapixel : 0;

  // ── ARENA — 5 of the 8-per-stage floor; `velocity` is never referenced ────
  const arena = new ParticleArena({ budgetBytes: BYTES_PER_PARTICLE * capacity });
  const buffers = arena.allocateBuffers(TSL);
  const position = buffers.position; // vec2 world px — the impact point, ON the ground
  const age = buffers.age; // float ms
  const lifeBuf = buffers.life; // float ms — THE lifecycle driver here (no height to fall)
  const seed = buffers.seed;
  /**
   * x = archetype index, 0..3 (a float; the one-hot selector reads it)
   * y = base size, world px (before the growth curve)
   * z = peak alpha (the archetype's own, already ground-boosted)
   * w = shape rotation phase, radians — V2's *"random rotation at spawn"*
   */
  const custom = buffers.custom;

  // ── UNIFORMS ─────────────────────────────────────────────────────────────
  const uDtSec = uniform(0);
  const uRectMin = uniform(vec2(worldRect.minX, worldRect.minY));
  const uRectSize = uniform(vec2(worldRect.maxX - worldRect.minX, worldRect.maxY - worldRect.minY));
  /** How many slots the DRAW shows — §4.1's rate, since life is fixed per
   * archetype and `count = rate × life`. The sim always runs full capacity
   * (the sibling runtimes' idiom: a compute dispatch is far cheaper than the
   * fill rate it would save, and skipping it makes an intensity change POP). */
  const uActiveCount = uniform(float(0));

  // Look dials — the only mutable numbers here. Everything per-archetype is a
  // graph literal (see the header).
  const uSizeScale = uniform(float(1));
  const uAlphaScale = uniform(float(1));
  /** V2's `SPLASH_PEAK_OPACITY_BOOST` (`:115`) — its own comment says the
   * legacy 0.02–0.12 peaks *"read too faint on the map"*. Harvested as a dial
   * rather than folded into the archetype peaks, so the four stay recognisably
   * V2's numbers. */
  const uPeakBoost = uniform(float(2.75));
  /** ⭐ WIND SMEAR (§4.1) — *"lashing against the ground is precisely an impact
   * that cannot stay round"*. Multiplies the quad's along-wind axis. */
  const uSmearGain = uniform(float(1.6));
  const uWindSpeed01 = uniform(float(0));
  const uWindDirDeg = uniform(float(0));
  /** The wind field's own px/s at full gale — the fall's calibration, shared by
   * value. Only the DRIFT reads it; the smear reads `speed01` directly. */
  const uWindAirSpeed = uniform(float(2600));

  // ── THE GATES ────────────────────────────────────────────────────────────
  /** `w <= 0` disables the clip — the same fail-open polarity as the fall: a
   * viewer that never calls `setSceneBounds` splashes everywhere, never
   * nowhere. */
  const uSceneRect = uniform(vec4(0, 0, 0, 0));
  const uSkyReachRect = uniform(vec4(0, 0, 1, 1));
  const uSkyReachHasBake = uniform(float(0));
  const openSkyPixel = openSkyTexture ?? null;
  /** A SEPARATE `texture()` node from the fall's — a shared node carries the
   * wrong uv (`feedback_shared_texture_node_carries_the_wrong_uv`). Null when
   * nothing was injected, and the gate is then compiled OUT rather than built
   * around a null (which throws at graph-build, silently). */
  const skyReachTex = openSkyPixel ? TSL.texture(openSkyPixel) : null;

  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));

  /**
   * ⭐ THE DIRECTION THE WIND PUSHES THINGS — `(−sin, cos)`, a +90° rotation of
   * the meteorological `directionDeg` in this engine's Y-DOWN world.
   *
   * ⚠️ A THIRD HAND-WRITTEN COPY OF ONE CONVENTION, and that is the debt, not
   * the bug. The fall's own header records getting this wrong TWICE live (a
   * missing rotation, then a `.negate()` that fixed 180° of a 90° error). It is
   * duplicated here rather than imported because the fall's copy is a local
   * arrow inside its factory; the real fix — `world/wind-field.js` exporting one
   * helper every consumer calls — is filed and unchanged by this slice.
   * `precip-species.js#windTowardVector` is the CPU twin that pins all four
   * cardinals in Node, and it covers this expression too.
   */
  const windToward = (rad) => vec2(sin(rad).negate(), cos(rad));
  const windRad = () => uWindDirDeg.mul(float(Math.PI / 180));

  // ── PER-ARCHETYPE CONSTANTS, AS GRAPH LITERALS ───────────────────────────
  // Packed one vec4 per parameter, indexed by a one-hot dot. A refused species
  // yields all-zero rows, so every body is zero-size and fully transparent.
  const col = (key, fallback) => {
    const v = [0, 1, 2, 3].map((i) => {
      const n = Number(ARCH[i]?.[key]);
      return Number.isFinite(n) ? n : fallback;
    });
    return vec4(v[0], v[1], v[2], v[3]);
  };
  const K_LIFE_MIN = col('lifeSecMin', 0);
  const K_LIFE_MAX = col('lifeSecMax', 0);
  const K_SIZE_MIN = col('sizePxMin', 0);
  const K_SIZE_MAX = col('sizePxMax', 0);
  const K_PEAK = col('peakAlpha', 0);
  const K_RING_R = col('ringR', 0.7);
  const K_RING_W = col('ringW', 0.15);
  const K_ROUGHEN = col('roughen01', 0);
  const K_DISC = col('disc01', 0);
  const K_SPIKES = col('spikes', 7);

  /**
   * ONE-HOT SELECT — four comparisons and four multiply-adds, deliberately not
   * a `uniformArray` dynamic index (see the header) and deliberately not a
   * `select()` chain (`feedback_tsl_select_chain_strands_vars`: a chain that
   * assigns into a `var` strands it on this renderer). Pure float arithmetic
   * has neither failure mode.
   * @param {*} idx - the archetype index, 0..3, as a float node.
   */
  const oneHot = (idx) =>
    vec4(
      idx.lessThan(float(0.5)).select(float(1), float(0)),
      idx
        .greaterThanEqual(float(0.5))
        .and(idx.lessThan(float(1.5)))
        .select(float(1), float(0)),
      idx
        .greaterThanEqual(float(1.5))
        .and(idx.lessThan(float(2.5)))
        .select(float(1), float(0)),
      idx.greaterThanEqual(float(2.5)).select(float(1), float(0))
    );
  const pick = (column, hot) =>
    column.x.mul(hot.x).add(column.y.mul(hot.y)).add(column.z.mul(hot.z)).add(column.w.mul(hot.w));

  /** Uniform over the padded rect — the fall's spawner, same margin reasoning. */
  const spawnAt = (h1, h2) => {
    const margin = uRectSize.mul(float(SPAWN_MARGIN_FRAC));
    const origin = uRectMin.sub(margin);
    const span = uRectSize.add(margin.mul(float(2)));
    return vec2(origin.x.add(hash11(h1).mul(span.x)), origin.y.add(hash11(h2).mul(span.y)));
  };

  /**
   * ⭐ WHICH ARCHETYPE A BODY IS, from §2.1's `splashArchetype01`.
   *
   * The schema calls it *"which of the four V2 splash looks DOMINATES"* — a
   * position on the 0..1 archetype axis, not a hard pick. So it slides a window
   * of width `archetypeSpread` across the four: at the shipped `0.5` / `1.0`
   * the window is exactly `[0,1]` and all four appear in equal quarters, which
   * is V2's behaviour (its four systems had near-identical intensity scales:
   * 8.45 / 8.7 / 9.1 / 9.25). A future row wanting *"mostly thin rings"* sets
   * `0.15` and gets it without a new field or a new branch.
   */
  const ARCH_CENTRE = Number.isFinite(A?.splashArchetype01) ? A.splashArchetype01 : 0.5;
  const ARCH_SPREAD = Number.isFinite(A?.archetypeSpread) ? A.archetypeSpread : 1;
  const archetypeIndex = (entropy) => {
    const h = hash11(entropy.mul(float(5.9)).add(float(17.3)));
    const t = float(ARCH_CENTRE)
      .add(h.sub(float(0.5)).mul(float(ARCH_SPREAD)))
      .clamp(float(0), float(0.9999));
    return t.mul(float(4)).floor();
  };

  /**
   * Every per-life constant, from ONE hash of a well-mixed entropy scalar — no
   * storage beyond `custom`, and stable for the body's whole life because the
   * inputs are.
   */
  const bodyConstants = (entropy) => {
    const idx = archetypeIndex(entropy);
    const hot = oneHot(idx);
    const sizePx = mix(pick(K_SIZE_MIN, hot), pick(K_SIZE_MAX, hot), hash11(entropy.mul(float(2.3)).add(float(11))));
    const lifeMs = mix(
      pick(K_LIFE_MIN, hot),
      pick(K_LIFE_MAX, hot),
      hash11(entropy.mul(float(3.1)).add(float(29)))
    ).mul(float(1000));
    const peak = pick(K_PEAK, hot);
    // V2's *"random rotation at spawn"*. Applied to the SHAPE in the fragment
    // rather than to the quad, because the quad's axes belong to the wind smear
    // — see `positionNode`.
    const phase = hash11(entropy.mul(float(4.7)).add(float(53))).mul(float(Math.PI * 2));
    return { idx, sizePx, lifeMs, peak, phase };
  };

  // ── SEED KERNEL ──────────────────────────────────────────────────────────
  const seedKernel = Fn(() => {
    const i = instanceIndex;
    const fi = float(i);
    seed.element(i).assign(fi);
    position.element(i).assign(spawnAt(fi.mul(float(1.37)).add(float(5.9)), fi.mul(float(0.61)).add(float(11.3))));
    const b = bodyConstants(fi);
    custom.element(i).assign(vec4(b.idx, b.sizePx, b.peak, b.phase));
    lifeBuf.element(i).assign(b.lifeMs);
    // ⚠️ AGES ARE STAGGERED ACROSS THE WHOLE POPULATION, not zeroed. Seeding
    // every splash at age 0 fires one synchronised carpet that blooms and dies
    // together, then leaves the ground bare until the next — a strobing
    // pavement rather than rain landing. The fall staggers HEIGHT for exactly
    // this reason; here age is the lifecycle, so age is what staggers.
    age.element(i).assign(hash11(fi.mul(float(7.3)).add(float(2.2))).mul(b.lifeMs));
  })().compute(capacity);

  // ── UPDATE KERNEL — §4.1's *"trivial kernel (age, no motion)"* ────────────
  const updateKernel = Fn(() => {
    const i = instanceIndex;
    const pos = position.element(i).toVar();
    const s = seed.element(i);
    const c = custom.element(i).toVar();
    const nextAge = age
      .element(i)
      .add(uDtSec.mul(float(1000)))
      .toVar();
    const life = lifeBuf.element(i).toVar();

    // Wind drift — V2's `ApplyForce` on each splash system. No gravity, by
    // design: the water spreads, it does not fall.
    const drift = windToward(windRad()).mul(uWindSpeed01).mul(uWindAirSpeed).mul(float(WIND_DRIFT_CARRY));
    pos.assign(pos.add(drift.mul(uDtSec)));

    // ── RESPAWN ──
    // A splash has no height to reach zero and no rect to escape (it lives ~0.3
    // s and drifts a few px), so age crossing life is the ONLY end condition.
    const done = nextAge.greaterThanEqual(life);
    /**
     * ⚠️ BOUNDED ENTROPY — SEED PLUS THE BODY'S OWN POSITION, **NEVER THE RAW
     * CLOCK**. A first cut here used `uTimeMs`, which is the dot engine's fix-8
     * and the fall runtime's own documented trap: `sin()`'s float32 precision
     * collapses at large arguments, `uTimeMs` grows all session, and distinct
     * bodies progressively alias onto the same "random" value — a splash carpet
     * that starts varied and quietly becomes a tiled pattern over an evening,
     * which is the worst possible failure shape because nobody reproduces it in
     * a five-minute test.
     *
     * Position works because it is exactly what changes on a respawn: this
     * life's entropy is drawn from where the body currently is, and the place
     * it respawns to is what feeds the NEXT one. Bounded by the world rect,
     * forever.
     */
    const entropy = s
      .mul(float(0.61))
      .add(pos.x.mul(float(0.011)))
      .add(pos.y.mul(float(0.013)));
    const b = bodyConstants(entropy);
    const respawned = spawnAt(entropy.mul(float(1.11)).add(float(3.7)), entropy.mul(float(0.83)).add(float(19.1)));

    position.element(i).assign(done.select(respawned, pos));
    custom.element(i).assign(done.select(vec4(b.idx, b.sizePx, b.peak, b.phase), c));
    lifeBuf.element(i).assign(done.select(b.lifeMs, life));
    age.element(i).assign(done.select(float(0), nextAge));
  })().compute(capacity);

  // ── THE DRAW ─────────────────────────────────────────────────────────────
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.attributes.position);
  geometry.setAttribute('uv', base.attributes.uv);
  geometry.instanceCount = capacity;

  /** Normalised age, 0..1. One expression, three consumers (growth, alpha, the
   * fragment's thinning) — extracted so they cannot drift apart. */
  const life01 = (i) =>
    age
      .element(i)
      .div(lifeBuf.element(i).max(float(1)))
      .clamp(float(0), float(1));

  /** V2's cubic growth Bézier, evaluated on normalised age. */
  const growth = (t) => {
    const [p0, p1, p2, p3] = GROWTH_BEZIER;
    const u = float(1).sub(t);
    return u
      .mul(u)
      .mul(u)
      .mul(float(p0))
      .add(
        u
          .mul(u)
          .mul(t)
          .mul(float(3 * p1))
      )
      .add(
        u
          .mul(t)
          .mul(t)
          .mul(float(3 * p2))
      )
      .add(t.mul(t).mul(t).mul(float(p3)));
  };

  /**
   * The fragment's per-body inputs, in TWO varyings.
   *
   * ⚠️ TWO, WHERE THE FALL NEEDS ONE, AND IT IS NOT LAZINESS. Storage reads are
   * VERTEX-STAGE ONLY on this renderer, so every fragment input must cross as a
   * varying — and a splash's shape needs five per-archetype knobs the fall's
   * streak does not have. The alternative is re-deriving the archetype in the
   * fragment from a hash, which would evaluate the whole one-hot per PIXEL
   * instead of per vertex.
   *
   * `vSplashA = (alpha, ringR, ringW, roughen01)`
   * `vSplashB = (disc01, spikes, phase, life01)`
   *
   * ⚠️ `alpha` HAS ALREADY ABSORBED THE SKY GATE AND THE SCENE CLIP. All three
   * are pure opacity multipliers, and folding them costs nothing while keeping
   * the second varying's `w` free for `life01`, which the shape genuinely needs.
   */
  const vA = Fn(() => {
    const i = instanceIndex;
    const c = custom.element(i);
    const hot = oneHot(c.x);
    const t = life01(i);

    // ⭐ V2's `SplashAlphaBehavior` verbatim (`:1808-1841`): a TRIANGLE, 0 →
    // peak at t=0.5 → 0. Not a fade-out from full: a splash has to be BORN,
    // and a sprite that appears at peak opacity reads as a decal being pasted
    // on rather than as water leaving the ground.
    const tri = float(1)
      .sub(t.mul(float(2)).sub(float(1)).abs())
      .clamp(float(0), float(1));
    const alive = float(i).lessThan(uActiveCount).select(float(1), float(0));
    const alpha = tri.mul(c.z).mul(uPeakBoost).mul(uAlphaScale).mul(alive).toVar();

    // The scene clip — splashes must not appear in the void around the map.
    // Same 64px feather as the fall so the two fade out together at the edge
    // rather than one cutting while the other ramps.
    const p = position.element(i);
    const hasBounds = uSceneRect.z.sub(uSceneRect.x).greaterThan(float(0));
    const band = float(64);
    const inX = p.x
      .sub(uSceneRect.x)
      .div(band)
      .clamp(float(0), float(1))
      .mul(uSceneRect.z.sub(p.x).div(band).clamp(float(0), float(1)));
    const inY = p.y
      .sub(uSceneRect.y)
      .div(band)
      .clamp(float(0), float(1))
      .mul(uSceneRect.w.sub(p.y).div(band).clamp(float(0), float(1)));
    alpha.assign(alpha.mul(hasBounds.select(inX.mul(inY), float(1))));

    // ⭐ THE SKY-REACH GATE (LAW 3 + §4.1's *"Where"*), sampled at the impact
    // point itself.
    //
    // ⚠️ NO PARALLAX CORRECTION HERE, UNLIKE THE FALL. The fall had to sample
    // its DRAWN position because M(h) slides a high body away from the ground
    // point it is over (a measured 61% of rain drew inside the test building
    // before that fix). A splash is at h=0, so drawn position and ground
    // position are THE SAME POINT — the two engines agree by construction
    // rather than by coincidence, which is why this is stated instead of
    // copied.
    if (!skyReachTex) return vec4(alpha, pick(K_RING_R, hot), pick(K_RING_W, hot), pick(K_ROUGHEN, hot));

    const uvx = p.x.sub(uSkyReachRect.x).div(uSkyReachRect.z.sub(uSkyReachRect.x).max(float(1)));
    const uvy = p.y.sub(uSkyReachRect.y).div(uSkyReachRect.w.sub(uSkyReachRect.y).max(float(1)));
    const inside = uvx
      .greaterThanEqual(float(0))
      .and(uvx.lessThanEqual(float(1)))
      .and(uvy.greaterThanEqual(float(0)))
      .and(uvy.lessThanEqual(float(1)));
    const sampled = skyReachTex.sample(vec2(uvx.clamp(float(0), float(1)), uvy.clamp(float(0), float(1)))).r;
    const gate = uSkyReachHasBake.mul(inside.select(float(1), float(0)));
    // `mix(1, sampled, gate)` — with no bake, or outside the rect, exactly 1.
    // Absence means KEEP SPLASHING, the same polarity the whole system uses.
    alpha.assign(alpha.mul(mix(float(1), sampled, gate)));

    return vec4(alpha, pick(K_RING_R, hot), pick(K_RING_W, hot), pick(K_ROUGHEN, hot));
  })().toVarying('vSplashA');

  const vB = Fn(() => {
    const i = instanceIndex;
    const c = custom.element(i);
    const hot = oneHot(c.x);
    return vec4(pick(K_DISC, hot), pick(K_SPIKES, hot), c.w, life01(i));
  })().toVarying('vSplashB');

  const material = new THREE.NodeMaterial();

  material.positionNode = Fn(() => {
    const i = instanceIndex;
    const c = custom.element(i);
    const t = life01(i);

    // World px, NOT scaled by the view — a splash is scenery, not atmosphere.
    // See the header.
    const sizePx = c.y.mul(growth(t)).mul(uSizeScale);
    const local = positionGeometry.xy.mul(sizePx);

    // ⭐ WIND SMEAR (§4.1). The quad's axes are the WIND's, and the along-wind
    // axis stretches with wind speed. Building the basis from the wind vector
    // means the elongation always points where the rain is going, with no
    // second angle to keep in sync.
    //
    // ⚠️ THE SHAPE's OWN RANDOM ROTATION IS NOT HERE — it rides `phase` in the
    // fragment. Two rotations competing for one quad is how a smear ends up
    // perpendicular to the wind on half the population; giving the quad to the
    // wind and the shape to the hash makes that unrepresentable.
    const w = windToward(windRad());
    const smear = float(1).add(uWindSpeed01.mul(uSmearGain));
    // Area is roughly preserved: what the along-wind axis gains, the across
    // axis gives back. A quad that only grows would make a gale read as bigger
    // splashes rather than as smeared ones.
    const across = float(1).div(smear.sqrt().max(float(0.001)));
    const e1 = w.mul(smear);
    const e2 = vec2(w.y.negate(), w.x).mul(across);
    const offset = e1.mul(local.x).add(e2.mul(local.y));

    return vec3(position.element(i).add(offset), float(zDepth));
  })();

  /**
   * ⭐ THE SHAPE — one parameterised expression covering V2's four tiles.
   *
   * ```
   *   ringR    where the crown sits, as a fraction of the quad's half-extent
   *   ringW    the crown's radial thickness (a soft band, never a hard edge)
   *   roughen  0 = a clean circle · 1 = a spiked crown broken into beads
   *   disc01   how much of the interior is filled — V2's "inner puddle"
   *   spikes   the angular frequency both the wobble and the beads run at
   * ```
   *
   * ⚠️ `roughen01` DRIVES BOTH THE RADIUS WOBBLE AND THE ANGULAR BREAK, and
   * that is one knob on purpose. They are not two properties: a crown breaks
   * into beads BECAUSE its tips have thinned, so a shape with deep spikes and
   * an unbroken rim is not a splash anybody has seen. Splitting them would
   * make three quarters of the parameter space unphysical
   * (`feedback_membership_beats_derived_threshold`'s cousin — the model should
   * only be able to express real states).
   */
  material.colorNode = Fn(() => vec3(0.8, 0.9, 1.0))();

  material.opacityNode = Fn(() => {
    const alpha = vA.x;
    const ringR = vA.y;
    const ringW = vA.z.max(float(0.01));
    const roughen = vA.w;
    const disc01 = vB.x;
    const spikes = vB.y;
    const phase = vB.z;
    const t = vB.w;

    // Quad-local, −1..1 in both axes.
    const p = uv().sub(float(0.5)).mul(float(2));
    const d = p.length();
    const theta = atan(p.y, p.x);

    /**
     * ⭐ TWO COPRIME HARMONICS, AND THE SECOND ONE IS THE WHOLE DIFFERENCE
     * BETWEEN WATER AND A SNOWFLAKE.
     *
     * A single `cos(n·θ)` is exactly n-fold symmetric, so the "droplets"
     * archetype came out of the first lab run as a perfect six-petal rosette —
     * geometric, repeating, and unmistakably not a splash. Real crown tips are
     * uneven.
     *
     * ⚠️ AND IT MUST BE **INTEGER** HARMONICS, WHICH IS WHY THIS IS `n` AND
     * `n+1` RATHER THAN AN IRRATIONAL MULTIPLE. `θ` wraps at ±π; any
     * non-integer multiple of it leaves a discontinuity at the wrap, i.e. a
     * hard radial seam across every sprite. Two consecutive integers are always
     * coprime, so the combined pattern only repeats after `n(n+1)` — visually
     * never — while each term stays perfectly periodic and the seam is
     * unrepresentable.
     */
    const wob = cos(theta.mul(spikes).add(phase))
      .mul(float(0.62))
      .add(cos(theta.mul(spikes.add(float(1))).add(phase.mul(float(1.7)))).mul(float(0.38)));

    // The crown's radius wobbles into spikes as `roughen` rises.
    const rr = ringR.mul(float(1).add(roughen.mul(float(0.22)).mul(wob)));
    // ⚠️ THE BAND THINS AS THE SPLASH EXPANDS. A ring of constant thickness
    // growing 5× reads as an inflating donut; real water thins as it spreads,
    // and this one line is most of why the growth curve looks like water
    // instead of a zoom.
    const w = ringW.mul(mix(float(1.35), float(0.55), t));
    const ring = float(1)
      .sub(rr.sub(d).abs().div(w).clamp(float(0), float(1)))
      .toVar();

    /**
     * The angular break — the rim thins to beads at the spike tips.
     *
     * ⚠️ AN EXPONENT, NOT A LERP, AND THE LERP WAS VISIBLY WRONG. A first cut
     * used `mix(1, 0.5+0.5·cos, roughen)`, which is a smooth sinusoidal
     * brightness wave around an unbroken rim — the "droplets" archetype came
     * out as a continuous scalloped ring rather than as separate drops. Raising
     * the same wave to a power pinches it toward its peaks, so the rim
     * genuinely SEPARATES into beads with dark gaps between them. `roughen` 0
     * leaves the exponent at 1, i.e. the clean ring is untouched.
     */
    const beadWave = wob.mul(float(0.5)).add(float(0.5)).clamp(float(0), float(1));
    ring.assign(ring.mul(beadWave.pow(float(1).add(roughen.mul(float(3.5))))));

    /**
     * The inner puddle (V2's fourth tile) — the film of water the impact
     * leaves, inside the crown.
     *
     * ⚠️ IT FADES OUT ACROSS THE LIFE WHILE THE RING KEEPS EXPANDING, and that
     * asymmetry is what stops the archetype reading as a grey ball. Sharing one
     * envelope made the disc grow with the quad, so by late life the puddle was
     * a 200px out-of-focus dot — the shape was fine, the LIFETIME was wrong. A
     * real film settles and vanishes in the first moments; the crown is what
     * travels.
     *
     * The rim is brighter than the middle (`0.35 + 0.65·d/ringR`) because a
     * water film catches the light at its meniscus, and a flat disc is the one
     * thing that never looks wet.
     */
    const discEdge = float(1).sub(
      d
        .div(ringR.max(float(0.01)))
        .sub(float(0.72))
        .div(float(0.28))
        .clamp(float(0), float(1))
    );
    const film = discEdge.mul(
      float(0.35).add(
        d
          .div(ringR.max(float(0.01)))
          .mul(float(0.65))
          .clamp(float(0), float(1))
      )
    );
    const shape = ring
      .add(film.mul(disc01).mul(float(1).sub(t).pow(float(1.6))))
      .clamp(float(0), float(1))
      .toVar();

    // Never let anything reach the quad's corner — a hard edge at the quad
    // boundary is the one artefact that gives a billboard away as a square.
    const clip = float(1).sub(d.sub(float(0.9)).div(float(0.1)).clamp(float(0), float(1)));
    shape.assign(shape.mul(clip));

    return shape.mul(alpha);
  })();

  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  /**
   * ⚠️ NORMAL, NOT ADDITIVE, and V2 agrees (`:5191`). A splash is water
   * catching the light, not a light source: additive would make a downpour's
   * splash carpet glow brighter the denser it got, which is precisely backwards
   * — heavy rain darkens ground, it does not illuminate it.
   */
  material.blending = THREE.NormalBlending;
  /**
   * ⚠️ DoubleSide OR THE WHOLE BATCH IS CULLED **SILENTLY**, and this file
   * shipped without it for exactly one lab run. The camera is flipped
   * (`top = minY`), which inverts triangle winding, so `FrontSide` renders
   * nothing at all — no warning, no error, a perfectly healthy engine
   * reporting `liveCount: 1080` and drawing zero pixels.
   *
   * ⚠️ IT IS INVISIBLE TO EVERY STATUS REPORT
   * (`feedback_doubleside_invisible_to_status_reports`) — `debugState()` said
   * splashes were live, the kernels ran, the tests were green and the bundle
   * was clean. All four sibling runtimes in this directory carry this same line
   * with the same warning, and copying the *structure* of a runtime without
   * copying this one property is apparently a repeatable mistake: it is now the
   * fifth time this project has paid for it.
   */
  material.side = THREE.DoubleSide;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // ⚠️ ON THE MESH, never the scene — THREE reads `renderOrder` off the
  // renderable object and never off an ancestor container. Fire's subsystem
  // shipped that exact silent no-op once already.
  mesh.renderOrder = renderOrder;
  const scene = new THREE.Scene();
  scene.add(mesh);

  let seeded = false;
  let liveCount = 0;
  /** The last view rect, held so `setFrame` can size the population by AREA.
   * See the species row's `splashesPerMegapixel`. */
  let lastRect = { minX: worldRect.minX, minY: worldRect.minY, maxX: worldRect.maxX, maxY: worldRect.maxY };
  /** Rate multiplier the debug panel drives. 1 = the species row's number. */
  let rateScale = 1;
  /** The curtain's own capacity-normalised count, 0..1 — see `setFrame`. */
  let rateFrac = 0;

  /**
   * ⭐ THE POPULATION, FROM AN AREA DENSITY — §4.1's rate, made concrete.
   *
   * `live = perMegapixel × (padded view area / 1e6) × rateFrac × rateScale`,
   * capped by the arena. The padded area is used, not the raw view, because
   * that is where bodies actually live (`SPAWN_MARGIN_FRAC`); sizing against
   * the unpadded rect would leave the visible middle under-populated by
   * exactly the margin's share.
   *
   * ⚠️ A CAP THAT BITES IS LOGGED ONCE. `no silent caps` — a very wide view
   * degrades by thinning, and a reader looking at a sparse carpet must be able
   * to find out that the ceiling, not the weather, chose it.
   */
  function applyCount() {
    if (!splashes) return;
    const w = Math.max(1, lastRect.maxX - lastRect.minX) * (1 + 2 * SPAWN_MARGIN_FRAC);
    const h = Math.max(1, lastRect.maxY - lastRect.minY) * (1 + 2 * SPAWN_MARGIN_FRAC);
    const wanted = Math.round(PER_MEGAPIXEL * ((w * h) / 1e6) * rateFrac * rateScale);
    liveCount = Math.min(capacity, Math.max(0, wanted));
    if (wanted > capacity && !cappedReported) {
      cappedReported = true;
      log.info(
        `'${speciesId}' splash population capped: wanted ${wanted}, arena holds ${capacity} — the carpet thins from here.`
      );
    }
    uActiveCount.value = liveCount;
    geometry.instanceCount = Math.max(1, liveCount);
  }
  let cappedReported = false;

  return {
    scene,
    capacity,
    speciesId,
    /** False when the species does not splash — the caller can skip it whole. */
    ok: splashes,

    init(renderer) {
      if (seeded) return;
      renderer.compute(seedKernel);
      seeded = true;
    },

    /**
     * Advance one frame.
     *
     * ⚠️ SYNCHRONOUS `renderer.compute`, never `computeAsync` — the shipped
     * idiom in all four sibling runtimes. An async dispatch inside a frame lets
     * the draw read a buffer the kernel has not finished writing.
     *
     * @param {*} renderer
     * @param {number} dtSec - REAL seconds. A splash is presentation pacing,
     *   like the fall: water does not land in slow motion because the GM slowed
     *   the game clock.
     * @param {number} timeMs
     * @param {object} [wind]
     */
    step(renderer, dtSec, timeMs, wind) {
      if (!splashes) return;
      // Re-read the handle EVERY frame rather than binding it at build — the
      // viewer reassigns `windHandle` when the wind field bakes, and these
      // engines are built lazily, so a captured reference goes dead silently.
      // That exact bug reached the author once already ("wind doesn't seem to
      // affect it at all").
      const src = wind ?? windHandle;
      if (src?.ambient) {
        const sp = src.ambient.speed01?.value;
        const dg = src.ambient.directionDeg?.value;
        if (Number.isFinite(sp)) uWindSpeed01.value = sp;
        if (Number.isFinite(dg)) uWindDirDeg.value = dg;
      }
      // ⚠️ `timeMs` IS ACCEPTED AND DELIBERATELY UNUSED — the signature matches
      // the four sibling runtimes so a caller never has to remember which of
      // them wants a clock. Nothing here reads one: a splash's whole life is
      // its own age, and the respawn entropy is bounded by POSITION rather
      // than by the clock (see the update kernel's note on why that matters).
      uDtSec.value = Math.max(0, Math.min(0.1, dtSec || 0));
      if (!seeded) this.init(renderer);
      // A JS `if`, never a uniform set to zero (Effects.md Law 4) — LAW 5's
      // teeth: no rain means no dispatch and no draw.
      if (uActiveCount.value <= 0) return;
      renderer.compute(updateKernel);
    },

    setWorldRect(rect) {
      if (!rect) return;
      uRectMin.value.set(rect.minX, rect.minY);
      uRectSize.value.set(Math.max(1, rect.maxX - rect.minX), Math.max(1, rect.maxY - rect.minY));
      lastRect = rect;
      // ⚠️ RE-SIZE THE POPULATION ON EVERY RECT CHANGE, not only when the
      // weather moves. The count is per-AREA, so a zoom or a pan that grows
      // the view must grow the population — recomputing only in `setFrame`
      // would leave the density wrong until the next weather tick, which on a
      // held sky is never.
      applyCount();
    },

    /** @see the fall engine's identical method — same fail-open polarity. */
    setSkyReachTexture(texture, rect) {
      if (!openSkyPixel) {
        return { armed: false, reason: 'no openSkyTexture injected — the gate cannot arm' };
      }
      if (!texture || !rect) {
        skyReachTex.value = openSkyPixel;
        uSkyReachHasBake.value = 0;
        return { armed: false, reason: texture ? 'no rect supplied' : 'no texture supplied' };
      }
      skyReachTex.value = texture;
      uSkyReachRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
      uSkyReachHasBake.value = 1;
      return { armed: true, rect };
    },

    setSceneBounds(rect) {
      if (!rect || !(rect.maxX > rect.minX)) {
        uSceneRect.value.set(0, 0, 0, 0);
        return { clipped: false };
      }
      uSceneRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
      return { clipped: true, rect };
    },

    /**
     * How many splashes are live this frame — §4.1's rate.
     *
     * ⚠️ TAKES THE **FALL's** RESOLVED FRAME, not a private curve. The splash
     * carpet must thin exactly as the drops do, and rain's count curve is
     * QUADRATIC on purpose (drizzle is sparse before it is short). A second
     * curve here would be a second opinion about how much rain there is, free
     * to disagree with the one the player can see falling.
     *
     * @param {{liveCount: number}} fallFrame - from `resolveSpeciesFrame`.
     */
    setFrame(fallFrame) {
      if (!splashes) return;
      const fallLive = Number.isFinite(fallFrame?.liveCount) ? fallFrame.liveCount : 0;
      const fallCap = Math.max(1, S?.capacity ?? 1);
      // ⚠️ THE FRACTION IS THE CURTAIN'S OWN, capacity-normalised — that is
      // what carries rain's QUADRATIC count curve (drizzle is sparse before it
      // is short) onto the ground for free. Only the SCALE is the splash
      // row's; the SHAPE of the response is the species'.
      rateFrac = Math.min(1, Math.max(0, fallLive / fallCap));
      applyCount();
    },

    setTuning(t = {}) {
      if (Number.isFinite(t.splashSizeScale)) uSizeScale.value = t.splashSizeScale;
      if (Number.isFinite(t.splashAlphaScale)) uAlphaScale.value = t.splashAlphaScale;
      if (Number.isFinite(t.splashPeakBoost)) uPeakBoost.value = t.splashPeakBoost;
      if (Number.isFinite(t.splashSmearGain)) uSmearGain.value = t.splashSmearGain;
      if (Number.isFinite(t.splashRateScale)) {
        rateScale = Math.max(0, t.splashRateScale);
        applyCount();
      }
      if (Number.isFinite(t.windAirSpeedPxS)) uWindAirSpeed.value = t.windAirSpeedPxS;
    },

    /** Every factor separately — "no splashes are visible" has half a dozen
     * causes and one boolean names none of them. */
    debugState() {
      return {
        speciesId,
        splashes,
        capacity,
        liveCount,
        visible: splashes && liveCount > 0,
        rate: { perMegapixel: PER_MEGAPIXEL, rateFrac, rateScale, capped: liveCount >= capacity && rateFrac > 0 },
        archetypes: ARCH.map((a) => a.id),
        wind: {
          speed01: uWindSpeed01.value,
          directionDeg: uWindDirDeg.value,
          smear: 1 + uWindSpeed01.value * uSmearGain.value,
        },
        tuning: {
          sizeScale: uSizeScale.value,
          alphaScale: uAlphaScale.value,
          peakBoost: uPeakBoost.value,
          smearGain: uSmearGain.value,
        },
        skyGate: {
          hasPlaceholder: Boolean(openSkyPixel),
          inGraph: Boolean(skyReachTex),
          armed: uSkyReachHasBake.value === 1,
        },
      };
    },
  };
}
