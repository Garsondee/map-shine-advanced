/**
 * POINT-LIGHT MERGED SHADING CORE — S2.14 (Performance-Audit-2026-08.md
 * §3.1's MRT-merge plan, following S2.13's shared-term extraction). The one
 * place illumination's own tail (switchColor + animation-seed injection via
 * `buildIlluminationSeed` + exposure + sun-shadow) and coloration's own tail
 * (albedo sample + BT.709 reflection + animation-seed injection via
 * `buildColorationSeed`) are BOTH computed, from ONE
 * `buildPointLightSharedTerms` call instead of the two independent calls
 * `buildIlluminationShadingCore`/`buildColorationShadingCore` each make on
 * their own — the actual GPU-side saving this whole stage exists for (S2.13
 * itself was code organization only; THIS is where calling the shared terms
 * once instead of twice, inside ONE compiled shader, actually happens).
 *
 * Deliberately a NEW function, not a wrapper around the two existing
 * per-channel cores: calling `buildIlluminationShadingCore`+
 * `buildColorationShadingCore` as black boxes would have EACH of them call
 * `buildPointLightSharedTerms` again internally, defeating the entire point.
 * Illumination's and coloration's own TAIL logic (the genuinely divergent
 * part, verified NOT shareable in S2.13 — see that stage's own account) is
 * therefore reproduced here rather than imported — a deliberate, bounded
 * duplication chosen over restructuring the already-verified S2.13 cores a
 * second time in the same stage. Copied faithfully from the real, currently-
 * shipped tails (`point-light-illumination.js#buildIlluminationShadingCore`,
 * `point-light-coloration.js#buildColorationShadingCore`), not reimplemented
 * from memory of what they do (`feedback_port_faithfully_then_modernize_
 * opportunistically`).
 *
 * Aperture-gobo is NOT wired here: `canBatchLight` (`point-light-batch.js`)
 * unconditionally excludes any light with `apertureCount > 0` from EVERY
 * batched channel, illumination and coloration alike, today — a merged
 * bucket inherits the identical exclusion (S2.0's census: zero aperture-lit
 * lights on the flagship map), so `buildPointLightSharedTerms` is always
 * called with `apertureCount: 0` here, exactly like the existing batched
 * illumination/coloration branches in `point-light-batch-mesh.js`'s
 * `buildBatchedMaterial` already do. The dead, `void`-ed polygon-edge-SDF
 * soft-edge term (`edgeSoftFactor`, `point-light-illumination.js`'s own
 * header) is not reproduced either — it contributes nothing to output in the
 * channels it already exists in, confirmed there, and the batched
 * illumination path already omits its `edgeCount`/`edgeSoftMargin`/
 * `edgePointsUniform` inputs entirely today (they read as `undefined`,
 * harmless only because the dead subgraph that would read them is never
 * reached by the NodeBuilder from a real output — the SAME "a disconnected
 * node costs nothing" property this project's own candle-noise-hoist work
 * leaned on).
 *
 * @module effects/lighting/point-light-merged
 */
import { buildAnimationTimeNode } from './animations/light-animation-clock.js';
import { buildPointLightSharedTerms } from './point-light-illumination.js';

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {object} args.inputs - per-light/per-vertex NODES, the UNION of
 *   `buildIlluminationShadingCore`'s and `buildColorationShadingCore`'s own
 *   `inputs` shapes (see each function's own header for what each field
 *   means): `localUnitXY`, `ratio`, `attenuationEased`, `exposure`,
 *   `expectedDepth`, `backgroundColor`/`dimColor`/`brightColor`,
 *   `colorationAlpha`, `lightColor`, `anim`, `wind`.
 * @param {object} args.shared - the union of both channels' own `shared`:
 *   `attrTexNode`, `depthTexNode`, `depthFlagsTexNode`, `sunShadowSlotNodes`,
 *   `blendSunVisibilityAcrossFloors`, `albedoTexture`, `uGlobalTimeMs`,
 *   `windHandle`. `apertureGoboShared` is deliberately NOT read — see this
 *   module's own header for why apertures never reach a batched bucket.
 * @param {object} args.flags - `animation` (the matched registry entry or
 *   null — its `buildIlluminationSeed`/`buildColorationSeed` are each
 *   checked and called INDEPENDENTLY, exactly like the two single-channel
 *   cores already do, since a registry entry may define only one of the
 *   two), `animationQuality`, `falloffModel`.
 * @returns {{illumFinal: *, illumAlpha: *, colorFinal: *, colorAlpha: *}}
 *   the four values a merged material's
 *   `mrt({illum: vec4(illumFinal, illumAlpha), coloration: vec4(colorFinal,
 *   colorAlpha)})` needs — byte-identical to `buildIlluminationShadingCore`'s
 *   own `{finalNode, alphaNode}` and `buildColorationShadingCore`'s own
 *   `{finalNode, alphaNode}` for the SAME light, verified by the S2.14 bench
 *   gate against real per-channel twins built from the SAME inputs.
 */
export function buildMergedPointLightShadingCore({ THREE, inputs, shared, flags }) {
  const {
    float,
    vec2,
    vec3,
    mix,
    clamp,
    smoothstep,
    positionWorld,
    screenUV,
    select,
    texture,
    dot,
    sqrt,
    sRGBTransferOETF,
  } = THREE.TSL;

  const {
    attrTexNode,
    depthTexNode,
    depthFlagsTexNode,
    sunShadowSlotNodes,
    blendSunVisibilityAcrossFloors,
    albedoTexture,
    uGlobalTimeMs,
    windHandle,
  } = shared;
  const { animation, animationQuality = 0, falloffModel = 'foundry' } = flags;
  const {
    localUnitXY,
    ratio: uRatio,
    attenuationEased: uAttenuationEased,
    exposure: uExposure,
    expectedDepth: uLightExpectedDepth,
    backgroundColor: uBackgroundColor,
    dimColor: uDimColor,
    brightColor: uBrightColor,
    colorationAlpha: uColorationAlpha,
    lightColor: uLightColor,
    anim,
    wind: windInputs,
  } = inputs;

  // Same screenUV-not-bare rule both single-channel cores follow — this
  // material's mesh carries no `uv` attribute at all.
  const attrHere = attrTexNode ? attrTexNode.sample(screenUV) : null;

  // THE ACTUAL WIN — one call, not two. `apertureCount:0` always (see this
  // module's own header), so `falloff` already equals what either channel's
  // OWN `falloffGoboed` would have been — no separate gobo term to thread.
  const {
    dist,
    falloff: combinedFalloff,
    depthFlagsHere,
  } = buildPointLightSharedTerms({
    THREE,
    localUnitXY,
    attenuationEased: uAttenuationEased,
    expectedDepth: uLightExpectedDepth,
    falloffModel,
    depthTexNode,
    depthFlagsTexNode,
    apertureCount: 0,
  });

  // ============================================================================
  // ILLUMINATION TAIL — faithfully reproduced from buildIlluminationShadingCore
  // (point-light-illumination.js) — see that function's own comments for the
  // full "why" behind each term.
  // ============================================================================
  const computeSwitchColorBand = (ratio) => {
    const attenuationStrength = uAttenuationEased.mul(float(0.7));
    const lowerEdge = ratio.mul(float(0.99).sub(attenuationStrength));
    const upperEdge = clamp(ratio.mul(float(1.01).add(attenuationStrength)), float(0.0001), float(1.0));
    const t = smoothstep(lowerEdge, upperEdge, dist);
    return mix(uBrightColor, uDimColor, t);
  };
  const illumDefaultSeed = computeSwitchColorBand(uRatio);

  let illumFinalColor = illumDefaultSeed;
  let skipExposure = false;
  if (animation?.buildIlluminationSeed) {
    const { speedRaw: uSpeedRaw, reverseSign: uReverseSign, seed: uSeed, intensityRaw: uIntensityRaw } = anim;
    const time = buildAnimationTimeNode(THREE.TSL, { uSpeedRaw, uReverseSign, uSeed, uGlobalTimeMs });
    let wind;
    let uWindResponse;
    if (windInputs) {
      uWindResponse = windInputs.response;
      wind = windHandle.node(THREE.TSL, {
        centerXY: windInputs.center,
        time: uGlobalTimeMs,
        exposure: windInputs.exposure,
      });
    }
    const seeded = animation.buildIlluminationSeed({
      THREE,
      uBrightColor,
      uDimColor,
      uRatio,
      uAttenuationEased,
      dist,
      localPosition: localUnitXY,
      defaultSeed: illumDefaultSeed,
      time,
      uIntensityRaw,
      computeSwitchColorBand,
      quality: animationQuality,
      wind,
      windResponse: uWindResponse,
    });
    illumFinalColor = seeded.finalColor;
    skipExposure = seeded.skipExposure === true;
  }

  let illumFinalColorExposed;
  if (skipExposure) {
    illumFinalColorExposed = illumFinalColor;
  } else {
    const attenuationStrengthExp = uAttenuationEased.mul(float(0.25));
    const lowerEdgeExp = uRatio.mul(float(0.98).sub(attenuationStrengthExp));
    const upperEdgeExp = clamp(uRatio.mul(float(1.02).add(attenuationStrengthExp)), float(0.0001), float(1.0));
    const quartExposure = uExposure.mul(float(0.25));
    const finalExposurePositive = quartExposure
      .mul(float(1).sub(smoothstep(lowerEdgeExp, upperEdgeExp, dist)))
      .add(quartExposure);
    const exposureFactor = select(
      uExposure.greaterThan(float(0)),
      float(1).add(finalExposurePositive),
      float(1).add(uExposure)
    );
    illumFinalColorExposed = illumFinalColor.mul(exposureFactor);
  }

  // SUN-SHADOW ATTENUATION — identical to buildIlluminationShadingCore's own.
  let backgroundFloor = uBackgroundColor;
  if (sunShadowSlotNodes && sunShadowSlotNodes.length > 0) {
    const sampleSlot = (slot) => {
      const u = positionWorld.x.sub(slot.uRect.x).div(slot.uRect.z.sub(slot.uRect.x));
      const v = positionWorld.y.sub(slot.uRect.y).div(slot.uRect.w.sub(slot.uRect.y));
      return slot.texNode.sample(vec2(u.clamp(0, 1), v.clamp(0, 1))).r;
    };
    const shadowFloorHere = depthFlagsHere ?? attrHere;
    const sunVis =
      shadowFloorHere && blendSunVisibilityAcrossFloors
        ? blendSunVisibilityAcrossFloors(THREE.TSL, {
            attrFloorIndex01: shadowFloorHere.r,
            presence: depthFlagsHere ? depthFlagsHere.a : null,
            slots: sunShadowSlotNodes.map((slot) => ({ sunVis: sampleSlot(slot), floorIndex01: slot.uFloorIndex01 })),
          })
        : sampleSlot(sunShadowSlotNodes[0]);
    backgroundFloor = uBackgroundColor.mul(sunVis);
  }

  const illumFinal = mix(backgroundFloor, illumFinalColorExposed, combinedFalloff);
  const illumAlpha = float(1);

  // ============================================================================
  // COLORATION TAIL — faithfully reproduced from buildColorationShadingCore
  // (point-light-coloration.js) — see that function's own comments.
  // ============================================================================
  const mapColor = sRGBTransferOETF(texture(albedoTexture, screenUV).rgb);
  const BT709 = vec3(0.2126, 0.7152, 0.0722);
  const reflection = sqrt(dot(BT709, mapColor.mul(mapColor)));

  const colorDefaultSeed = uLightColor.mul(uColorationAlpha);
  let colorSeed = colorDefaultSeed;
  if (animation?.buildColorationSeed) {
    const { speedRaw: uSpeedRaw, reverseSign: uReverseSign, seed: uSeed, intensityRaw: uIntensityRaw } = anim;
    const time = buildAnimationTimeNode(THREE.TSL, { uSpeedRaw, uReverseSign, uSeed, uGlobalTimeMs });
    let wind;
    let uWindResponse;
    if (windInputs) {
      uWindResponse = windInputs.response;
      wind = windHandle.node(THREE.TSL, {
        centerXY: windInputs.center,
        time: uGlobalTimeMs,
        exposure: windInputs.exposure,
      });
    }
    const seeded = animation.buildColorationSeed({
      THREE,
      uLightColor,
      uColorationAlpha,
      dist,
      localPosition: localUnitXY,
      defaultSeed: colorDefaultSeed,
      time,
      uIntensityRaw,
      uRatio,
      quality: animationQuality,
      wind,
      windResponse: uWindResponse,
    });
    colorSeed = seeded.finalColor;
  }

  const colorFinal = colorSeed.mul(reflection).mul(combinedFalloff);
  const colorAlpha = combinedFalloff;

  return { illumFinal, illumAlpha, colorFinal, colorAlpha };
}
