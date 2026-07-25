/**
 * SUN OCCLUSION, ON THE GPU — the TSL transcription of `sun-occlusion.js`.
 *
 * BROWSER-ONLY (builds TSL; verified live against real Foundry data, never a
 * mocked THREE — CONVENTIONS.md §4, the same split `buildUiShadowVisibility` and
 * `buildPointLightIlluminationMaterial` already draw). Every number this shader
 * uses comes from the pure module next door, which IS Node-tested; what lives
 * here is the fetch pattern and the loop, nothing original.
 *
 * ============================================================================
 * TWO MATERIALS, AND WHY THE EXPENSIVE ONE ALMOST NEVER RUNS
 * ============================================================================
 *
 * 1. {@link buildSunShadowBakeMaterial} — the march. Writes a SCENE-SPACE
 *    (world-aligned) visibility field: how much sun reaches each world texel.
 *    It is camera-independent, so panning and zooming cost NOTHING, and it is
 *    re-run only when the quantised sun moves, the masks change, or the floor
 *    changes (`sunNeedsRebake`). V2 re-marched a VIEW-aligned target every
 *    single frame, through five stages owned by three other systems — that is
 *    the cost model this replaces, and the reason a 32-step march is affordable
 *    here when it never was there.
 *
 * 2. {@link buildSunVisibilityNode} — the read. One clamped texture fetch,
 *    folded into the ambient-fill shader that already runs. That is the entire
 *    per-frame cost of every cast shadow in the scene.
 *
 * ⚠️ THE PLACEMENT RULE, stated because a future session WILL be tempted to
 * "unify" it with the UI-window shadow: this multiplies the AMBIENT FILL, before
 * the point lights accumulate. The UI shadow multiplies in the COMPOSITE, after
 * them. Both are correct, for opposite reasons — the UI shadow is a decorative
 * key over the whole picture, while this gates ONE light (the sun) and nothing
 * else. Moving this after the lights would make a torch standing inside a
 * building's shadow read DIMMER than the same torch outside it: the
 * `DynamicLightShadowLift` bug, in mirror image, rebuilt by accident. The author
 * stated the model independently on 2026-07-24 — *"passive light is the sunlight
 * which cannot overpower these shadows because it's the light that produces
 * these shadows, then 'active' lights are ones brought in afterwards which
 * overpower these shadows"* — and MAX-after-multiply is exactly that sentence.
 *
 * ============================================================================
 * THREE LIVE FIXES (2026-07-24, author's own first-look report)
 * ============================================================================
 *
 * 1. **The receiver gate is SHARPENED**, not read raw — a bright halo was
 *    hugging every building because the coarse `_Outdoors` grid blurs a wall's
 *    true edge across roughly a texel, and that blur was multiplying the
 *    shadow's strength right where contact-hardening says it should be
 *    strongest. See `GATE_SHARPEN_LOW`/`HIGH` in `sun-occlusion.js`.
 * 2. **The march is a thin CONE, not a single ray** — `LATERAL_TAPS` samples
 *    spread perpendicular to the sun, by a distance that GROWS with `d` (the
 *    same `PENUMBRA_PER_PX` already governing front-back softness, applied to
 *    the other axis of the same physical phenomenon). This is what makes a
 *    silhouette's SIDE edges soften and widen with distance instead of staying
 *    pixel-perfect at the coarse field's own native resolution.
 * 3. **A point light's floor is no longer flat** — every point light's
 *    material samples THIS field per-fragment (`point-light-illumination.js`,
 *    "SUN-SHADOW ATTENUATION") so its background floor matches the shadowed
 *    ambient at each pixel, instead of erasing the shadow across its whole
 *    dim radius. Two earlier per-light-scalar attempts flipped the whole
 *    light hard-edged as the sun swept the light's origin; the field is the
 *    only correct sample space.
 *
 * @module effects/lighting/sun-occlusion-render
 */

import { DEFAULT_MARCH_STEPS, PENUMBRA_PER_PX, GATE_SHARPEN_LOW, GATE_SHARPEN_HIGH } from './sun-occlusion.js';

/**
 * Build the height-field march. Renders a fullscreen quad over a scene-space
 * target whose UV maps linearly onto `casterRect` (the world rect the height
 * field covers) — so `uv()` IS the world position, and no camera is involved.
 *
 * THE HEIGHT FIELD'S PACKING (scene/mask-derive.js): R = building, G = overhead,
 * B = sky-reach, each a byte over `uHeightScalePx`; A = the `_Outdoors` receiver
 * gate. The march reads `max(R,G,B)` — three producers of ONE physical quantity,
 * so the tallest wins rather than them summing into a triple-dark smear.
 *
 * THE ISOLATION TOGGLES ARE NOT HERE. They are applied when the field is BAKED
 * (the disabled producer's channel is never written), so turning one off removes
 * real work instead of multiplying by a zero the shader still pays to fetch —
 * `tsl/no-uniform-gates`, and the reason no `uEnable*` uniform appears below.
 *
 * @param {object} args
 * @param {*} args.THREE - the renderer namespace (carries `.TSL`).
 * @param {*} args.casterTexture - the packed height field (RGBA8).
 * @param {number} [args.steps] - march sample count.
 * @returns {{
 *   material: *,
 *   setSun: (azimuthDeg: number, elevationDeg: number) => void,
 *   setField: (args: {heightScalePx: number, maxCasterHeightPx: number}) => void,
 *   setLook: (args: {strength01: number, softnessMul: number, basePx: number}) => void,
 *   setRect: (rect: {minX:number, minY:number, maxX:number, maxY:number}) => void,
 *   setEdgeBandPx: (px: number) => void,
 *   casterTexNode: *,
 * }}
 */
export function buildSunShadowBakeMaterial({ THREE, casterTexture, steps = DEFAULT_MARCH_STEPS }) {
  const { uniform, texture, uv, vec2, vec3, vec4, float, max, min, smoothstep, Fn } = THREE.TSL;

  // Fixed at shader-BUILD time, like `steps` — the loop is unrolled either way,
  // so this is a real, deliberate cost decision, not a live-tunable knob. See
  // this function's own header for the LATERAL_TAPS reasoning.
  const LATERAL_TAPS = 3;

  const casterTexNode = texture(casterTexture);
  /** (dirToSunX, dirToSunY, tanElevation, stepPx) — everything the loop needs
   * about the sky, resolved on the CPU once per bake. A shader that recomputed
   * `tan()` per texel would be paying for a value that is constant across the
   * entire draw. */
  const uSun = uniform(vec4(0, -1, 1, 8));
  /** (heightScalePx, strength01, softnessMul, basePenumbraPx). */
  const uLook = uniform(vec4(2048, 1, 1, 2));
  /** (buildingHeightPx, skyOcclusion01, _, _). `buildingHeightPx` is here
   * rather than baked into a texture channel because building height is
   * `height × (1 − outdoors)` and `outdoors` is already the A channel — see
   * the packing note in `bakeCasterTexture`. */
  const uLook2 = uniform(vec4(0, 0, 0, 0));
  /** The world rect this field covers: (minX, minY, maxX, maxY). */
  const uRect = uniform(vec4(0, 0, 1, 1));
  /** Width of the map-edge ramp, in world px. */
  const uEdgeBandPx = uniform(float(0));

  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;

  material.fragmentNode = Fn(() => {
    const rectSize = vec2(uRect.z.sub(uRect.x), uRect.w.sub(uRect.y));
    // uv().y = 0 is the rect's minY, matching `MaskGrid`'s "row 0 = minY" and a
    // DataTexture's default flipY:false. Three spaces, one direction — the same
    // derivation `environmental-light.js#buildOutdoorsGate` writes out at
    // length, and the reason there is no flip anywhere in this file.
    const world = vec2(uRect.x, uRect.y).add(uv().mul(rectSize));

    const dir = vec2(uSun.x, uSun.y);
    // The direction PERPENDICULAR to the sun — a 90° rotation of a unit vector
    // is itself unit length, so this needs no separate normalize. Used below to
    // widen the march into a thin CONE rather than a single ray (the lateral
    // soft-edge fix).
    const perp = vec2(dir.y.negate(), dir.x);
    const tanElev = uSun.z;
    const stepPx = uSun.w;
    const heightScalePx = uLook.x;
    const strength = uLook.y;
    const softnessMul = uLook.z;
    const basePx = uLook.w;

    // THE RECEIVER GATE, read at THIS texel: the `_Outdoors` white — SHARPENED
    // (2026-07-24, author live report: "brighter area next to the actual
    // building… shadow should be strongest next to the building"). The raw
    // value is the coarse grid's own box-blurred read, which straddles a wall's
    // true edge over roughly a texel; sharpening collapses that ambiguous band
    // so the shadow reaches full strength immediately outside a wall instead of
    // ramping up over tens of world px. See sun-occlusion.js's own header for
    // why this targets the SHADOW's reading only, not the shared mask.
    const here = casterTexNode.sample(uv());
    const gate = smoothstep(float(GATE_SHARPEN_LOW), float(GATE_SHARPEN_HIGH), here.a);
    const buildingHeightPx = uLook2.x;
    const skyOcclusion01 = uLook2.y;
    /** Height of whatever stands at a texel: the tallest of the two ART-driven
     * channels and the authored BUILDING height, the latter recomputed from the
     * gate (`height × indoor-ness`) rather than stored — see uLook2. */
    const heightAt = (packed) =>
      max(max(packed.g, packed.b).mul(heightScalePx), float(1).sub(packed.a).mul(buildingHeightPx));

    const occlusion = float(0).toVar();
    for (let i = 1; i <= steps; i++) {
      const d = stepPx.mul(float(i));
      const at = world.add(dir.mul(d));
      // CONTACT HARDENING (front-back): the feather widens with distance
      // travelled, so the same wall is a knife edge where it meets the ground
      // and a smudge at the tip. `softnessMul` carries cloud + night from
      // effects/shadow-access.js.
      const feather = max(basePx.add(d.mul(float(PENUMBRA_PER_PX))).mul(softnessMul), float(1e-3));
      // LATERAL SOFTENING (2026-07-24, author: "the furthest away edge of the
      // shadow could do with being more blurred... the edges of a building
      // shadow are currently pixel perfect lines... blur the shadow to make it
      // more diffuse the further away from the building and to make edges less
      // perfect"). A single ray only ever asks "is THIS exact line blocked?",
      // so a caster's SILHOUETTE (its edge PERPENDICULAR to the sun, not its
      // front-back depth) inherits nothing but the coarse field's own native
      // texel blur — visually near-hard. Sampling a few points spread
      // sideways, with a spread that GROWS with `d` (the SAME physical
      // reasoning `marchPenumbraPx` already applies to the front-back axis —
      // a small light source's angular size blurs a penumbra equally in every
      // direction, not just toward/away from it), turns the ray into a thin
      // CONE: near the wall the cone is narrow (crisp silhouette), far from it
      // the cone has fanned out enough to average across the true edge (soft,
      // diffuse silhouette) — exactly the "more diffuse the further away"
      // asked for, from the SAME constant already governing front-back
      // softness, not a second, disagreeing blur radius.
      const spread = d.mul(float(PENUMBRA_PER_PX)).mul(softnessMul);
      let stepOcclusion = float(0);
      for (let lt = 0; lt < LATERAL_TAPS; lt++) {
        const tapT = LATERAL_TAPS === 1 ? 0 : -1 + (2 * lt) / (LATERAL_TAPS - 1);
        const tapAt = tapT === 0 ? at : at.add(perp.mul(spread.mul(float(tapT))));
        // World → field UV, clamped: a sample off the map reads the nearest
        // edge rather than wrapping in a caster from the opposite side.
        const sampleUv = tapAt.sub(vec2(uRect.x, uRect.y)).div(rectSize);
        const packed = casterTexNode.sample(vec2(sampleUv.x.clamp(0, 1), sampleUv.y.clamp(0, 1)));
        const h = heightAt(packed);
        // A blocker must stand ABOVE the sun ray's height at this distance.
        const over = h.sub(d.mul(tanElev));
        stepOcclusion = stepOcclusion.add(smoothstep(float(0), feather, over));
      }
      stepOcclusion = stepOcclusion.div(float(LATERAL_TAPS));
      // MAX, not accumulate, ACROSS STEPS: the deepest blocked station along
      // the ray decides, once. A sum would darken a shadow in proportion to how
      // many march steps happened to land inside the same wall, which is a
      // resolution artefact, not light. (The lateral taps within ONE station
      // DO average, above — that average is what makes the silhouette soft;
      // it is a different axis from this MAX, not the same knob twice.)
      occlusion.assign(max(occlusion, stepOcclusion));
    }

    // THE MAP-EDGE RAMP (author, 2026-07-24: *"avoid producing a gap in the
    // shadow as it moves around the edge of the scene… a gradient at the edge"*).
    // A caster just outside the scene rect does not exist in any of our data, so
    // the shadow it should throw INTO the map cannot be computed — but a shadow
    // field that simply stops at a straight line reads as a rendering fault,
    // while one that eases out over a band reads as distance haze.
    const dEdge = min(min(world.x.sub(uRect.x), uRect.z.sub(world.x)), min(world.y.sub(uRect.y), uRect.w.sub(world.y)));
    const ramp = smoothstep(float(0), max(uEdgeBandPx, float(1e-3)), dEdge);

    // ═══════════════════════════════════════════════════════════════════
    // SKY OCCLUSION — the term that makes UNDER a bridge dark (2026-07-25)
    // ═══════════════════════════════════════════════════════════════════
    //
    // Author, twice: *"using their opaque sections to block light from getting
    // to bits of the scene below THAT POINT"*, and *"underneath a bridge isn't
    // 'indoors' it's outdoors and just not able to see the sky from that
    // space."* That is NOT the directional march — it is how much SKY the point
    // can see, and it is why the march alone read as "still not the desired
    // effect": a 300px-tall bridge deck at a 60° noon sun throws its ray-shadow
    // only ~86px past its own footprint, 0.8% of a 10,650px map. Physically
    // right, visually nothing.
    //
    // `coverAbove` (R) answers the actual question — is anything solid directly
    // overhead — so this darkens the whole area under the deck at ANY sun
    // angle, and it is what a bridge, a roof or an upper floor should do. Gated
    // by the receiver like everything else: a true interior is not lit by the
    // sky in this model anyway, so it must not be darkened twice.
    const skyBlocked = here.r.mul(skyOcclusion01).mul(gate);
    const vis = float(1).sub(occlusion.mul(strength).mul(gate).mul(ramp)).mul(float(1).sub(skyBlocked));
    // Stored in RGB (not just R) so the field is readable as a greyscale image
    // in the debug layer cycler — a shadow field you can LOOK at is the
    // difference between "sky-reach is broken" and "sky-reach has no casters".
    return vec4(vec3(vis, vis, vis), float(1));
  })();

  return {
    material,
    casterTexNode,
    /**
     * @param {number} azimuthDeg @param {number} elevationDeg
     * @param {{dirX:number, dirY:number, tanElev:number, stepPx:number}} resolved -
     *   computed by the CALLER through `sun-occlusion.js`'s pure functions, so
     *   the CPU and GPU cannot end up with two ideas of where the sun is.
     */
    setSun(azimuthDeg, elevationDeg, resolved) {
      uSun.value.set(resolved.dirX, resolved.dirY, resolved.tanElev, resolved.stepPx);
    },
    setField({ heightScalePx }) {
      uLook.value.x = heightScalePx;
    },
    /** The two terms the texture no longer carries: the authored building
     * height (recomputed in-shader from the gate) and the sky-occlusion
     * strength (see the SKY OCCLUSION block). */
    setSkyOcclusion({ buildingHeightPx, skyOcclusion01 }) {
      uLook2.value.x = buildingHeightPx > 0 ? buildingHeightPx : 0;
      uLook2.value.y = Math.max(0, Math.min(1, skyOcclusion01 ?? 0));
    },
    setLook({ strength01, softnessMul, basePx }) {
      uLook.value.y = strength01;
      uLook.value.z = softnessMul;
      uLook.value.w = basePx;
    },
    setRect(rect) {
      uRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
    },
    setEdgeBandPx(px) {
      uEdgeBandPx.value = px > 0 ? px : 0;
    },
  };
}

/**
 * THE READ — a scalar 0..1 sun-visibility node for a fullscreen pass, sampled at
 * the world position under this screen pixel.
 *
 * Deliberately takes the CALLER's `uViewRect` (the camera's world rect) rather
 * than building its own: `environmental-light.js` already owns that uniform and
 * updates it once per frame beside `setAmbient`. A second copy is precisely how
 * the outdoors gate and the shadow field would end up covering different halves
 * of the map — the drift `buildOutdoorsGate` exists to prevent, one buffer over.
 *
 * Returns `null` when no field texture is supplied, so the whole lookup is
 * compiled OUT rather than multiplied by a one (`tsl/no-uniform-gates`, and the
 * same JS-time-branch shape the sky gate uses).
 *
 * @param {*} TSL - THREE.TSL.
 * @param {object} args
 * @param {*} args.uViewRect - vec4 uniform, the camera world rect.
 * @param {*} args.uShadowRect - vec4 uniform, the rect the shadow field covers.
 * @param {*} args.shadowTexNode - the baked field's texture node, or null.
 * @returns {*|null} scalar node, 1 = full sun.
 */
export function buildSunVisibilityNode(TSL, { uViewRect, uShadowRect, shadowTexNode }) {
  if (!shadowTexNode) return null;
  const { uv, vec2, mix } = TSL;
  const worldX = mix(uViewRect.x, uViewRect.z, uv().x);
  const worldY = mix(uViewRect.y, uViewRect.w, uv().y);
  const u = worldX.sub(uShadowRect.x).div(uShadowRect.z.sub(uShadowRect.x));
  const v = worldY.sub(uShadowRect.y).div(uShadowRect.w.sub(uShadowRect.y));
  return shadowTexNode.sample(vec2(u.clamp(0, 1), v.clamp(0, 1))).r;
}
