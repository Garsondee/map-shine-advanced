/**
 * THE LAYER SMEAR SHADOW MODEL — the TSL bake material.
 * Plan of record: `docs/planning/Sun-Shadows-Layer-Smear.md`.
 *
 * A line-for-line transcription of `layer-smear.js#layerSmearVisibility`. Read
 * THAT module's header for the model, the compositing argument, and THE LAW's
 * proof; this file is the same arithmetic in nodes, and every place the two
 * could drift (station spacing, falloff shape, throw lengths) is either shared
 * through a CPU-resolved uniform or has a named twin function on both sides.
 *
 * THE LAYER TEXTURE'S PACKING — one channel per occluder layer, and nothing
 * else. No heights, no gate, no merged silhouettes:
 *
 *   R  this floor's WALLS    (`_Outdoors` dark)
 *   G  this floor's OVERHEAD (overhead tiles hosted here)
 *   B  BAND 0 — `coverAbove(F)`,   every floor above this one
 *   A  BAND 1 — `coverAbove(F+1)`, every floor above THAT
 *
 * That the whole occluder description is ONE texture plus ONE `vec4` of heights
 * is the point of this model, not a coincidence — the packing it replaced
 * carried coverage and height in channels that disagreed at every silhouette
 * edge, which is what a per-texel height buys you.
 *
 * ⚠️ THE A CHANNEL CHANGED HANDS 2026-08-05 (the shadow cascade). It used to
 * carry THE CASCADE's blend factor (the lower floor's `coverAbove`) because no
 * silhouette source existed for a fourth layer. That blend factor now rides in
 * the BAKED FIELD's own alpha instead — every slot publishes its own band-0
 * coverage there for the slot above to read (`uCascade` below) — which freed
 * this channel for the second real band, at zero extra memory and with no
 * second texture upload per floor. `shadow-bands.js`'s header has the full
 * decomposition and why the bands are cumulative rather than per-floor.
 *
 * @module effects/lighting/layer-smear-render
 */
import { PENUMBRA_PER_PX, GATE_SHARPEN_LOW, GATE_SHARPEN_HIGH } from './sun-occlusion.js';
import {
  SHADOW_LAYER_COUNT,
  DEPTH_SCALES,
  LAYER_WALLS,
  LAYER_OVERHEAD,
  SHADOW_BAND_LAYER_INDICES,
  DIFFUSION_PER_HEIGHT_PX,
} from './layer-smear.js';

/**
 * Which layers the SKY-REACH GRADIENT's nested isotropic reads are compiled in
 * for — a BUILD-TIME set, not a runtime uniform.
 *
 * `setDepth` has always been able to switch the gradient off per layer by
 * pushing a radius of 0, but a zero radius still COMPILED the reads: TSL has no
 * way to skip a texture fetch on a runtime uniform, so every layer paid
 * `DEPTH_SCALES` extra samples per station whether or not it could ever use
 * them. That was 12 fetches per station for a feature only the "above" layers
 * have ever been given a radius (`sun-shadow-subsystem.js`'s own `setDepth`
 * call site) — an unconditional 4× on the dominant cost of the whole bake.
 *
 * Scoping it to the BAND layers here (a JS-time branch, the same
 * `tsl/no-uniform-gates` discipline `lowerFieldTexNode` already uses) is what
 * pays for the per-layer diffusion LOD added alongside it: 4 sharp + 6 depth
 * reads per station, against 1 + 12 before. Strictly fewer samples, one more
 * feature.
 */
const LAYER_HAS_DEPTH_GRADIENT = Array.from({ length: SHADOW_LAYER_COUNT }, (_, i) =>
  SHADOW_BAND_LAYER_INDICES.includes(i)
);

/**
 * Pick layer `i`'s own channel out of a packed RGBA sample. Six places in this
 * shader index the packing; writing `[p.r, p.g, p.b, p.a][i]` at each of them
 * is six chances for one of them to be transcribed in a different order the
 * day a channel changes hands — which is exactly what happened to the A
 * channel on 2026-08-05 (see this module's own packing header).
 *
 * @param {*} packed - a vec4 node.
 * @param {number} i - a layer index, 0..`SHADOW_LAYER_COUNT`-1.
 * @returns {*} a float node.
 */
const channelOf = (packed, i) => [packed.r, packed.g, packed.b, packed.a][i];

/** Ceiling on a requested mip level — a texture's chain tops out at
 * `log2(dimension)`, and asking past it is undefined on some backends. */
export const MAX_LOD = 12;

/**
 * The receiver gate's anti-aliasing mip level, in LOD units. **Currently 0 —
 * i.e. OFF, deliberately.**
 *
 * ⚠️ THIS WAS log2(4) FOR ONE AFTERNOON AND IT WAS A REGRESSION. It was added
 * to fix a stair-stepped shadow edge on a diagonal roofline, and it did — by
 * pre-blurring the wall channel over a 4×4 texel box before the sharpening
 * curve. On the author's real scene that box is **21 world px**, and blurring
 * the gate does not soften an edge, it MOVES it: the gate ramps up over 21px
 * of open ground, so the shadow starts weak at the wall and only reaches full
 * strength well away from it. The author saw exactly that and named it
 * precisely — *"pulls the shadow away from building edges unrealistically"*.
 *
 * That is the SAME bright-strip-hugging-the-wall bug `GATE_SHARPEN_LOW/HIGH`
 * was created to kill in the first place (2026-07-24), reintroduced from the
 * other side. Contact hardening outranks edge smoothness: a shadow that is
 * strongest against its caster is the thing the author has asked for
 * repeatedly, and a slightly stepped edge on a diagonal is the cheaper defect.
 *
 * The staircase's real cause is the layer texture's own resolution (5.2 world
 * px per texel here), so the honest fix for it is a finer `layerGridDim`, not
 * a blur that trades one artifact for a worse one. Kept as a named constant
 * rather than deleted so the trade stays discoverable — set it back and the
 * halo comes back with it.
 */
export const GATE_AA_LOD = 0;

/**
 * Build the layer-smear bake material.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.layerTexture - RGBA coverage, one channel per layer, sampled
 *   with CLAMP-TO-EDGE. The clamp is load-bearing, not incidental: the author's
 *   edge rule is *"if the black pixels of `_Outdoors` extend across the edge of
 *   the map then we assume that this continues into the distance"*, and
 *   clamp-to-edge IS that rule, for free, in the sampler.
 * @param {number} [args.steps=32] - stations along the smear. Unrolled, so a
 *   change means a new material — the caller rebuilds one when the tier moves.
 * @returns {{
 *   material: *,
 *   layerTexNode: *,
 *   setSun: (resolved: {dirX:number, dirY:number, throwPx:number[], heightPx:number[], maxThrowPx:number}) => void,
 *   setCascade: (args: {active: boolean}) => void,
 *   setLayers: (args: {strengths?: number[]}) => void,
 *   setDepth: (args: {radiiPx: number[]}) => void,
 *   setField: (args: {layerGridDimPx?: number}) => void,
 *   setLook: (args: {strength01?: number, softnessMul?: number, basePx?: number, falloffExp?: number, tipBlurMul?: number}) => void,
 *   setRect: (rect: {minX:number, minY:number, maxX:number, maxY:number}) => void,
 *   setEdgeBandPx: (px: number) => void,
 * }}
 */
export function buildLayerSmearBakeMaterial({ THREE, layerTexture, lowerFieldTexture = null, steps = 32 }) {
  const { uniform, texture, uv, vec2, vec3, vec4, float, max, min, mix, select, log2, smoothstep, pow, Fn } = THREE.TSL;

  const STEPS = Number.isFinite(steps) ? Math.max(4, Math.floor(steps)) : 32;

  const layerTexNode = texture(layerTexture);
  /**
   * ⚠️⚠️ THE CASCADE (2026-08-02) — the floor BELOW's already-baked field.
   *
   * Author, after four rounds on cross-floor shadows: *"If a shadow looks great
   * on the ground floor I want to be able to see that same shadow through any
   * holes in the middle or upper or ANY floor above that floor... Lots of maps
   * involve large open spaces with no pixels/fully transparent, holes in the
   * scene which allow the camera to peer down to lower floors."*
   *
   * THE MODEL, in one line: **you see whatever surface is actually visible at
   * this pixel, carrying that surface's own shadow.** Where this floor's art is
   * opaque you see this floor (and its own shadow); where it is transparent you
   * are looking THROUGH to the floor below, so you must see the floor below's
   * shadow — recursively, since that floor cascades too.
   *
   * The blend factor is the layer texture's A channel, which
   * `packLayerTexelData` now fills with the LOWER floor's `coverAbove` — i.e.
   * exactly "how much does this floor (and everything above it) block the view
   * down to the floor below". 255 = solid, use this floor's own answer; 0 =
   * open, fall through. That grid already existed and is already correct; this
   * feature needed no new derivation, only a channel to carry it.
   *
   * Sampled at `uv()`, not re-projected: every slot's field covers the SAME
   * world rect (all derived from `dimensions.sceneRect` through one caster
   * spec), so the two are texel-aligned by construction. Null (floor 0, which
   * has nothing below it) compiles the whole cascade OUT — a JS-time branch,
   * `tsl/no-uniform-gates`, so the bottom floor's shader is byte-identical to
   * what it was before this existed.
   */
  const lowerFieldTexNode = lowerFieldTexture ? texture(lowerFieldTexture) : null;
  /** (dirToSunX, dirToSunY, maxThrowPx, _) — resolved on the CPU once per bake
   * by `layer-smear.js#resolveLayerSmear`, so the twin and the shader cannot
   * disagree about where the sun is or how far the stack reaches. */
  const uSun = uniform(vec4(0, -1, 0, 0));
  /** Per-layer throw distance, world px — `heightᵢ / tan(elevation)`, CPU-side. */
  const uThrowPx = uniform(vec4(0, 0, 0, 0));
  /** Per-layer occluder HEIGHT, world px — the same `heightsPx` array
   * `resolveLayerSmear` turned into `uThrowPx`, carried through unconverted.
   *
   * ⚠️ NOT DERIVABLE FROM `uThrowPx` IN THE SHADER, which is why it is a second
   * uniform rather than a multiply. Throw is `height / tan(elevation)` folded
   * through `lengthScale` and the dawn/dusk cap (`layerThrowPx`), so at a low
   * sun two layers of very different heights can land on the SAME capped throw
   * — and diffusion must still tell them apart, because how soft a shadow is
   * depends on how far the light fell, not on how far the shadow was allowed to
   * stretch. Inverting the cap on the GPU would be re-deriving a CPU decision
   * from its own lossy output. */
  const uHeightPx = uniform(vec4(0, 0, 0, 0));
  /** THE CASCADE's blockage publication — `(scale, floor, _, _)`.
   *
   * This slot writes `max(band0 · scale, floor)` into its baked field's ALPHA,
   * where the slot ABOVE reads it as "how much do I block the view down to
   * you". `(1, 0)` while the effect is live publishes this floor's own band-0
   * coverage verbatim; `(0, 1)` publishes a solid 1 — FULLY BLOCKED — which is
   * the safe state, not the convenient one: an "off" or empty slot must make
   * the cascade a provable no-op for the floor above rather than opening a
   * hole onto a field that was never computed (`feedback_gate_polarity_must_
   * fail_open`, and the same `absentBlockage = 255` convention the CPU packing
   * used while this rode in the layer texture). Arithmetic, never a branch. */
  const uCascade = uniform(vec4(1, 0, 0, 0));
  /** Per-layer strength 0..1. An upper floor need not darken as hard as a wall. */
  const uStrength = uniform(vec4(1, 1, 1, 1));
  /** (globalStrength, softnessMul, basePenumbraPx, falloffExponent). */
  const uLook = uniform(vec4(1, 1, 2, 1.6));
  /** (tipBlurMul, _, _, _) — how fast the penumbra widens with distance. */
  const uBlur = uniform(vec4(3, 0, 0, 0));
  /** Per-layer isotropic blur radius, world px — THE SKY-REACH GRADIENT
   * (`layer-smear.js#isotropicDepthTerm`'s own header has the physics). 0 =
   * off, this layer behaves exactly as it did before this uniform existed. */
  const uDepth = uniform(vec4(0, 0, 0, 0));
  /** The world rect this field covers: (minX, minY, maxX, maxY). */
  const uRect = uniform(vec4(0, 0, 1, 1));
  /** ⚠️ THE LAYER TEXTURE'S OWN resolution — NEVER the bake target's `fieldDim`.
   * Feeding the wrong one silently mis-sizes every mip request, which is a live
   * bug this project already shipped once (see `sun-occlusion-render.js`'s
   * `uCasterGridDim` for the full post-mortem). */
  const uLayerGridDim = uniform(float(1024));
  /** Width of the map-edge ramp, world px. */
  const uEdgeBandPx = uniform(float(0));

  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;

  material.fragmentNode = Fn(() => {
    const rectSize = vec2(uRect.z.sub(uRect.x), uRect.w.sub(uRect.y));
    // uv().y = 0 is the rect's minY, matching `MaskGrid`'s "row 0 = minY" and a
    // DataTexture's default flipY:false — three spaces, one direction, no flip
    // anywhere in this file (memory: feedback_y_flip_recurring_risk).
    const world = vec2(uRect.x, uRect.y).add(uv().mul(rectSize));
    const toSun = vec2(uSun.x, uSun.y);
    const maxThrow = uSun.z;

    const strength = uLook.x;
    const softnessMul = uLook.y;
    const basePx = uLook.z;
    const falloffExp = uLook.w;

    // ⚠️⚠️ READ AT `GATE_AA_LOD` (0, SHARP) — NOT A BARE `.sample(uv())`
    // (2026-08-03, author: an overhead item darkened by its OWN cast shadow —
    // "the shadow needs to be occluded by the actual thing that is casting
    // it"). A plain `.sample()` on a fullscreen bake quad picks an IMPLICIT
    // mip from screen-space derivatives — the exact thing `GATE_AA_LOD`'s own
    // header already names as untrustworthy here (it blurred the wall gate 21
    // world px when it was briefly non-zero). `here` used to be sampled bare,
    // and it now backs TWO receiver-position reads that both need the item's
    // TRUE edge, not a softened one:
    //
    //   - `here.g` (below) — an item's own self-shadow exclusion. A blurry
    //     read means the item's silhouette, as THIS lookup sees it, is
    //     slightly SMALLER than what actually rendered — so at the item's own
    //     boundary `selfCoverage < 1`, `occ[LAYER_OVERHEAD]` is not fully
    //     zeroed, and a thin rim of the item's own shadow survives ONTO the
    //     item — precisely "occluded by the thing casting it" failing at
    //     the one place it is asked to hold hardest: the caster's own edge.
    //   - `here.a` (THE CASCADE, below) — a blurry read smears the fall-
    //     through transition past a floor's real boundary, the identical
    //     "moves the edge, does not soften it" failure `GATE_AA_LOD`'s own
    //     header describes for the wall gate.
    //
    // One sample, one constant — `wallAA` no longer needs its own copy.
    const here = layerTexNode.sample(uv()).level(float(GATE_AA_LOD));

    // THE RECEIVER GATE — the sharpened `_Outdoors` read, from the WALL channel
    // (R): `1 − walls` is how outdoors this texel is. Same sharpening curve the
    // previous model used, so "indoors takes no sun shadow" behaves identically
    // across the change.
    const wallAA = here.r;
    const gate = smoothstep(float(GATE_SHARPEN_LOW), float(GATE_SHARPEN_HIGH), float(1).sub(wallAA));

    const texelWorldPx = max(rectSize.x, rectSize.y).div(uLayerGridDim);
    const sampleUvAt = (at) => {
      const raw = at.sub(vec2(uRect.x, uRect.y)).div(rectSize);
      // Clamped, never wrapped. See `layerTexture`'s own doc — this IS the
      // author's edge rule, and wrapping would teleport a shadow across the map.
      return vec2(raw.x.clamp(0, 1), raw.y.clamp(0, 1));
    };

    // One running max per layer — the union WITHIN a layer.
    const occ = [];
    for (let i = 0; i < SHADOW_LAYER_COUNT; i++) occ.push(float(0).toVar());
    const layerThrow = [uThrowPx.x, uThrowPx.y, uThrowPx.z, uThrowPx.w];
    const layerHeight = [uHeightPx.x, uHeightPx.y, uHeightPx.z, uHeightPx.w];
    const depthRadii = [uDepth.x, uDepth.y, uDepth.z, uDepth.w];
    const lodFor = (blurPx) => max(float(0), min(float(MAX_LOD), log2(max(blurPx.div(texelWorldPx), float(1)))));
    // ⚠️ THE DIFFUSION FLOOR — the TSL twin of `layer-smear.js#
    // layerDiffusionBlurPx`; read THAT for why a height term exists at all
    // (the station blur widens with horizontal throw, so at a high sun it
    // reports every caster as equally crisp no matter how far the light
    // actually fell). Resolved ONCE per layer, outside the station loop: it
    // depends only on this layer's own height and the shared softness, neither
    // of which varies per station.
    const layerDiffusionPx = layerHeight.map((h) => h.mul(float(DIFFUSION_PER_HEIGHT_PX)).mul(softnessMul));

    for (let j = 0; j <= STEPS; j++) {
      // `stationDistancePx(j, STEPS, maxThrow)` — stations bunch toward the
      // caster. `u` and `spacing` are plain JS numbers times a node, because
      // `j`/`STEPS` are compile-time constants; the twin computes the identical
      // values from the identical formula.
      const u = j / STEPS;
      const d = maxThrow.mul(float(u * u));
      const stationUv = sampleUvAt(world.add(toSun.mul(d)));
      // `stationSpacingPx(j, STEPS, maxThrow)` — the anti-aliasing FLOOR. No
      // sample may be narrower than the gap to its neighbour, or a thin caster
      // slips between two stations and THE LAW breaks discretely even though it
      // holds continuously (the twin's header spells this out).
      const spacing = maxThrow.mul(float((2 * u) / STEPS));
      const stationBlurPx = max(
        basePx.add(d.mul(float(PENUMBRA_PER_PX)).mul(uBlur.x)).mul(softnessMul),
        max(spacing, texelWorldPx)
      );

      for (let i = 0; i < SHADOW_LAYER_COUNT; i++) {
        const L = layerThrow[i];
        const r = depthRadii[i];
        // ⚠️ ONE FETCH PER LAYER NOW, NOT ONE SHARED FETCH (2026-08-05, the
        // shadow cascade). The four layers still live in four channels of the
        // same texel, but they no longer want the same MIP: a band three
        // storeys up must read blurrier than the wall at your feet, at the
        // same station, or "softer the further it falls" cannot exist. The
        // shared read is what made every layer's edge equally crisp.
        //
        // Cost is still DOWN on balance — `LAYER_HAS_DEPTH_GRADIENT`'s own
        // header has the arithmetic (4 + 6 reads per station, against 1 + 12).
        const blurPx = max(stationBlurPx, layerDiffusionPx[i]);
        const sharp = channelOf(layerTexNode.sample(stationUv).level(lodFor(blurPx)), i);
        // THE SKY-REACH GRADIENT — `layer-smear.js#isotropicDepthTerm`'s own
        // header has the physics, and its own comment explains why this is
        // NOT a term `max`'d in alongside the march (measured: a station's
        // own `d=0` sample already saturates occ[i] to 1 for any receiver
        // inside solid coverage, making a separately-added term a no-op — the
        // first version of this feature did exactly that). Instead, for a
        // layer with `r>0`, THIS STATION'S coverage read IS the isotropic
        // blur, taken AT the station's own position — so the near-field read
        // is "how enclosed is the receiver itself" and far stations still
        // carry the normal dawn/dusk elongation via the same `falloff(d/L)`
        // every layer uses.
        //
        // NESTED RADII, not one — `layer-smear.js#DEPTH_SCALES` has the full
        // argument: a single radius SATURATES, so the middle of a wide span
        // and a point one radius in from its edge come out identical, which
        // is exactly the flatness this feature exists to remove. Averaging
        // several nested mip levels encodes depth as "how many scales still
        // see solid", so the gradient keeps deepening inward.
        //
        // ⚠️ COMPILED IN ONLY FOR THE BAND LAYERS — a JS-time branch, see
        // `LAYER_HAS_DEPTH_GRADIENT`'s own header. A layer that can never be
        // given a radius no longer pays `DEPTH_SCALES` fetches per station to
        // multiply by a uniform zero.
        let coverage = sharp;
        if (LAYER_HAS_DEPTH_GRADIENT[i]) {
          let depthCov = float(0);
          for (let s = 1; s <= DEPTH_SCALES; s++) {
            const rs = r.mul(float(s / DEPTH_SCALES));
            depthCov = depthCov.add(channelOf(layerTexNode.sample(stationUv).level(lodFor(rs)), i));
          }
          depthCov = depthCov.mul(float(1 / DEPTH_SCALES));
          // `r > 0` picks the isotropic read; `r == 0` keeps the sharp one. This
          // IS a real per-pixel branch (`select`, not `step`-as-arithmetic) —
          // safe here because nothing downstream shares state ACROSS layers or
          // stations the way the debug-channel fold that stranded 12 of 20
          // channels did (memory: feedback_tsl_select_chain_strands_vars); each
          // `occ[i]` is written exactly once per station regardless of which
          // branch is taken.
          // ⚠️ `depthCov.mul(sharp)`, NOT `depthCov` ALONE — the TSL twin of
          // `layer-smear.js#layerSmearVisibility`'s own `* sharp`; read THAT for
          // the measurement (mip 8 of this texture is 8×4 texels for the whole
          // map, so using the wash as the coverage outright MADE it the
          // silhouette and detached every sky-reach shadow from its caster).
          coverage = select(r.greaterThan(float(0)), depthCov.mul(sharp), sharp);
        }
        // `t > 1` (past this layer's throw) and `L <= 0` (this layer casts
        // nothing) both need to contribute ZERO. `max(L, 1e-3)` keeps the
        // divide finite and `clamp(0,1)` then pins `t` to 1, where the falloff
        // is exactly 0 — so both cases fall out of the arithmetic with no
        // branch.
        const t = d.div(max(L, float(1e-3))).clamp(0, 1);
        const fall = pow(float(1).sub(t), falloffExp);
        occ[i].assign(max(occ[i], coverage.mul(fall)));
      }
    }

    // ⚠️ A LAYER NEVER SHADOWS ITS OWN FOOTPRINT — the TSL twin of
    // `layer-smear.js#layerSmearVisibility`'s own block; read THAT for the
    // full argument, including why WALLS needed this fix a session after
    // OVERHEAD did (2026-08-03: a thatched roof's own antialiased ridge
    // line, ~51% wall-covered, cleared `gate`'s smoothstep threshold and
    // self-shadowed anyway — `gate` and self-exclusion answer different
    // questions, and a partially-covered boundary texel is where only one
    // of the two was ever being asked). The floor-above layers must NOT be
    // excluded, or the bridge-deck-over-water shadow disappears entirely.
    //
    // `here` is the receiver's own texel, already sampled for the gate above,
    // so this costs no extra fetch (memory:
    // feedback_composite_only_terms_miss_shared_buffers — reuse the node a
    // consumer already reads, never re-sample it).
    const selfCoverageWalls = channelOf(here, LAYER_WALLS);
    occ[LAYER_WALLS].assign(occ[LAYER_WALLS].mul(float(1).sub(selfCoverageWalls)));
    const selfCoverageOverhead = channelOf(here, LAYER_OVERHEAD);
    occ[LAYER_OVERHEAD].assign(occ[LAYER_OVERHEAD].mul(float(1).sub(selfCoverageOverhead)));

    // Map-edge ramp, unchanged from the previous model.
    const dEdge = min(min(world.x.sub(uRect.x), uRect.z.sub(world.x)), min(world.y.sub(uRect.y), uRect.w.sub(world.y)));
    const ramp = smoothstep(float(0), max(uEdgeBandPx, float(1e-3)), dEdge);

    // ⚠️ TRANSMITTANCES MULTIPLY — different occluders in series. `strength ·
    // gate · ramp` scales each FACTOR rather than the product, so strength 0
    // returns exactly 1 however many layers are stacked.
    const attenuate = strength.mul(gate).mul(ramp);
    const layerStrength = [uStrength.x, uStrength.y, uStrength.z, uStrength.w];
    let transmittance = float(1);
    transmittance = transmittance.mul(float(1).sub(occ[LAYER_WALLS].mul(layerStrength[LAYER_WALLS]).mul(attenuate)));
    transmittance = transmittance.mul(
      float(1).sub(occ[LAYER_OVERHEAD].mul(layerStrength[LAYER_OVERHEAD]).mul(attenuate))
    );
    // ⚠️ THE BANDS UNION, THEY DO NOT COMPOUND — the TSL twin of
    // `layer-smear.js#layerSmearVisibility`'s own band block; read THAT for the
    // full argument (they are ONE nested stack sliced at two elevations, not
    // two occluders in series, and multiplying them would make every extra
    // storey darken a shadow that is already opaque).
    let bandOcc = float(0);
    for (const i of SHADOW_BAND_LAYER_INDICES) {
      bandOcc = max(bandOcc, occ[i].mul(layerStrength[i]));
    }
    transmittance = transmittance.mul(float(1).sub(bandOcc.mul(attenuate)));
    const ownVis = transmittance.clamp(0, 1);

    // ⚠️ THE CASCADE — see `lowerFieldTexNode`'s own header for the model. A
    // JS-time branch: floor 0 has no lower field and compiles this out entirely.
    //
    // ⚠️ THE BLOCKAGE NOW COMES FROM THE LOWER FIELD'S OWN ALPHA, NOT THIS
    // FLOOR'S LAYER TEXTURE (2026-08-05, the shadow cascade). It used to be
    // `here.a` — the lower floor's `coverAbove`, packed into this floor's own
    // layer texture by the CPU. That is the same grid the lower SLOT already
    // holds as its own band 0, so it publishes it itself (below), and the
    // channel it used to occupy became the second real band. One sample of the
    // lower field now yields both halves of the cascade: `.r` is its
    // already-cascaded visibility, `.a` is how much this floor blocks the view
    // down to it. Sampled ONCE, both channels read from it (memory:
    // feedback_composite_only_terms_miss_shared_buffers).
    //
    // ⚠️ THE LOWER FIELD IS ALREADY CASCADED. Slots bake bottom-up, so by the
    // time this runs, `lowerFieldTexNode` holds floor N-1's OWN shadow already
    // blended with floor N-2's, and so on to the ground. That is what makes
    // "see through a hole in the middle floor all the way down" work without
    // this shader knowing how many floors exist — the recursion lives in the
    // bake ORDER, not in the shader.
    const lower = lowerFieldTexNode ? lowerFieldTexNode.sample(uv()) : null;
    const vis = lower ? mix(lower.r, ownVis, lower.a) : ownVis;

    // ⚠️ ALPHA IS THE CASCADE'S PUBLICATION CHANNEL, not padding — see
    // `uCascade`'s own header. It is safe to spend because this material is
    // OPAQUE (`transparent` is never set, so three compiles no blend state at
    // all) and every consumer of a baked field reads `.r` alone
    // (`sun-occlusion-render.js#buildSunVisibilityNode`,
    // `point-light-illumination.js`'s own `sampleSlot`, and the debug view's
    // one-hot `uShadowMask`, which only ever selects RGB).
    //
    // RGB stays a flat greyscale, not just R, so the field is readable as an
    // image in the debug layer cycler — a shadow field you can LOOK at is the
    // difference between "this is broken" and "this has no casters".
    const blockage = max(channelOf(here, SHADOW_BAND_LAYER_INDICES[0]).mul(uCascade.x), uCascade.y).clamp(0, 1);
    return vec4(vec3(vis, vis, vis), blockage);
  })();

  return {
    material,
    layerTexNode,
    /** @param {{dirX:number, dirY:number, throwPx:number[], heightPx:number[], maxThrowPx:number}} resolved -
     *  computed by the CALLER through `layer-smear.js#resolveLayerSmear`. */
    setSun(resolved) {
      uSun.value.set(resolved.dirX, resolved.dirY, resolved.maxThrowPx, 0);
      const t = resolved.throwPx ?? [];
      uThrowPx.value.set(t[0] ?? 0, t[1] ?? 0, t[2] ?? 0, t[3] ?? 0);
      // ⚠️ FROM `resolved`, NEVER FROM THE CALLER'S OWN `heightsPx` ARRAY. The
      // resolve is where a non-finite or negative height becomes 0; reading the
      // raw input here instead would let a NaN reach `uHeightPx` and turn every
      // layer's diffusion LOD into a NaN mip request — a whole-field failure
      // from a value the CPU had already sanitised once.
      const h = resolved.heightPx ?? [];
      uHeightPx.value.set(h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0);
    },
    /**
     * THE CASCADE's publication switch — see `uCascade`'s own header.
     * @param {{active: boolean}} args - `active` is the subsystem's own
     *   `enabled && casterHasCoverage`. Inactive publishes a solid 1 (fully
     *   blocked), so the floor above cascades nothing rather than falling
     *   through onto a field this slot never computed.
     */
    setCascade({ active }) {
      uCascade.value.set(active ? 1 : 0, active ? 0 : 1, 0, 0);
    },
    setLayers({ strengths }) {
      if (!Array.isArray(strengths)) return;
      const s = (i) => (Number.isFinite(strengths[i]) ? Math.max(0, Math.min(1, strengths[i])) : 1);
      uStrength.value.set(s(0), s(1), s(2), s(3));
    },
    /** @param {{radiiPx: number[]}} args - THE SKY-REACH GRADIENT, per layer,
     *  world px. 0 (the default) leaves that layer unchanged. */
    setDepth({ radiiPx }) {
      if (!Array.isArray(radiiPx)) return;
      const r = (i) => (Number.isFinite(radiiPx[i]) && radiiPx[i] > 0 ? radiiPx[i] : 0);
      uDepth.value.set(r(0), r(1), r(2), r(3));
    },
    setField({ layerGridDimPx }) {
      if (Number.isFinite(layerGridDimPx) && layerGridDimPx > 0) uLayerGridDim.value = layerGridDimPx;
    },
    setLook({ strength01, softnessMul, basePx, falloffExp, tipBlurMul }) {
      if (Number.isFinite(strength01)) uLook.value.x = Math.max(0, Math.min(1, strength01));
      if (Number.isFinite(softnessMul) && softnessMul > 0) uLook.value.y = softnessMul;
      if (Number.isFinite(basePx) && basePx >= 0) uLook.value.z = basePx;
      // ⚠️ Must stay > 0 — THE LAW's proof needs the falloff monotonically
      // decreasing, and an exponent of 0 makes it the constant 1.
      if (Number.isFinite(falloffExp) && falloffExp > 0) uLook.value.w = falloffExp;
      if (Number.isFinite(tipBlurMul) && tipBlurMul > 0) uBlur.value.x = tipBlurMul;
    },
    setRect(rect) {
      uRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
    },
    setEdgeBandPx(px) {
      uEdgeBandPx.value = px > 0 ? px : 0;
    },
  };
}
