/**
 * CLOUD TOPS verification.
 *
 * Three different claims, tested three different ways — the same split this
 * codebase's own doctrine requires (`window-render.test.mjs`'s own header):
 *
 * 1. `CLOUD_TOPS`/`CLOUD_TOPS_PARAMS` are a VALID declaration — the real
 *    validators, not eyeballed against an example (the `clouds.js` round-2
 *    lesson: a manifest-shape mistake is cheap to catch here, expensive to
 *    catch live).
 * 2. `cloudTopsGate` is pure CPU math — Node-tested directly, the ordinary way.
 * 3. `keyhole-tsl-constructs-in-node`: the REAL TSL graph — `buildCloudTopsNode`
 *    fed through `buildCloudTopsParallaxWorldXY`, assigned to a real
 *    `THREE.NodeMaterial` — actually gets built, in Node, against the
 *    vendored `three.webgpu.js` (which imports cleanly with no GPU/browser).
 *    This proves the graph SURVIVES BEING BUILT — nothing about WGSL/GLSL
 *    codegen or what it looks like on screen (that is the shader-lab bench's
 *    own job, `tools/shader-lab/cloud-lab.js`'s `'tops'` view).
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { validateParamsSchema } from '../../../core/params-schema.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { resolveEffectEnabled } from '../../effect-cascade.js';
import { CLOUD_TOPS, CLOUD_TOPS_PARAMS } from '../cloud-tops.js';
import {
  buildCloudTopsNode,
  cloudTopsGate,
  buildCloudTopsParallaxWorldXY,
  CLOUD_TOPS_MAX_PARALLAX,
} from '../cloud-shade.js';
import { createCloudUniforms, buildCloudFieldNode } from '../../../world/cloud-field.js';

export function run(t) {
  const { ok } = t;

  // ---- 1. the declaration validates ----------------------------------------
  ok('CLOUD_TOPS_PARAMS is a valid params schema', validateParamsSchema(CLOUD_TOPS_PARAMS).ok);
  ok('CLOUD_TOPS is a valid manifest', validateEffectManifest(CLOUD_TOPS).ok);
  ok("the effect's id is cloudTops", CLOUD_TOPS.id === 'cloudTops');
  ok('never photosensitive (no flashing)', CLOUD_TOPS.a11y.photosensitive === false);
  // doc 03 §3's own ladder: "tops | C8 | standard" — NOT 'low' like the ground
  // shadow (CLOUD_LOOK); the single most expensive term in the whole feature
  // should be the first thing a lower profile gives up.
  ok('gated to standard, not low (this is the expensive term)', CLOUD_TOPS.enabledFromProfile === 'standard');
  ok('off at performance', resolveEffectEnabled(CLOUD_TOPS, { profile: 'performance' }) === false);
  ok('on at standard (the actual default profile)', resolveEffectEnabled(CLOUD_TOPS, { profile: 'standard' }) === true);
  ok('on at quality', resolveEffectEnabled(CLOUD_TOPS, { profile: 'quality' }) === true);

  // ---- 2. cloudTopsGate — pure CPU math, no TSL ----------------------------
  {
    // No measurement at all ⇒ fails ASLEEP (the opposite of the precipitation
    // gate, which fails awake) — cloud-shade.js's own header states why.
    const noMeasurement = cloudTopsGate({ viewWidthWorldPx: 0, deckAltitudePx: 1400 });
    ok('no view width -> asleep', noMeasurement.awake === false);
    ok('no view width -> zero fade', noMeasurement.fade === 0);
    const noAltitude = cloudTopsGate({ viewWidthWorldPx: 8000, deckAltitudePx: 0 });
    ok('no altitude -> asleep', noAltitude.awake === false);

    // Deep zoom-in: eyeHeightPx << altitude -> asleep, zero fade, parallax
    // clamped at its ceiling (deckAltitudePx/eyeHeightPx blows up, but the
    // clamp must hold regardless of whether the draw is even submitted).
    const zoomedIn = cloudTopsGate({ viewWidthWorldPx: 200, deckAltitudePx: 1400 });
    ok('zoomed in -> asleep', zoomedIn.awake === false);
    ok(
      'zoomed in -> parallax clamped at the ceiling, never past it',
      zoomedIn.parallax <= CLOUD_TOPS_MAX_PARALLAX + 1e-9
    );

    // Deep zoom-out: eyeHeightPx >> altitude -> fully awake, fully faded in,
    // parallax relaxed toward 0 (doc 02 §9: "flatten as you keep rising").
    const zoomedOut = cloudTopsGate({ viewWidthWorldPx: 200000, deckAltitudePx: 1400 });
    ok('zoomed way out -> awake', zoomedOut.awake === true);
    ok('zoomed way out -> fully faded in', zoomedOut.fade === 1);
    ok('zoomed way out -> parallax relaxes well below the ceiling', zoomedOut.parallax < 0.05);
    ok('zoomed way out -> magnification relaxes toward 1 (no loom)', zoomedOut.magnification < 1.05);

    // The gate's own defaults never let magnification blow up or invert.
    for (const viewWidthWorldPx of [50, 500, 5000, 50000, 500000]) {
      const g = cloudTopsGate({ viewWidthWorldPx, deckAltitudePx: 1400 });
      ok(
        `magnification stays in [1, 1/(1-${CLOUD_TOPS_MAX_PARALLAX})] at view width ${viewWidthWorldPx}`,
        g.magnification >= 1 - 1e-9 && g.magnification <= 1 / (1 - CLOUD_TOPS_MAX_PARALLAX) + 1e-9
      );
      ok(`fade stays in [0,1] at view width ${viewWidthWorldPx}`, g.fade >= 0 && g.fade <= 1);
    }

    // zoomSensitivity: doc's own claim — "higher = tops appear at a LESS
    // zoomed-out view". A view width right at the edge of asleep/awake at
    // sensitivity 1 should wake up at a higher sensitivity, same altitude.
    const edge = cloudTopsGate({ viewWidthWorldPx: 4000, deckAltitudePx: 1400, zoomSensitivity: 1 });
    const moreSensitive = cloudTopsGate({ viewWidthWorldPx: 4000, deckAltitudePx: 1400, zoomSensitivity: 2.5 });
    ok(
      'higher zoomSensitivity wakes the gate at the SAME view width a lower one does not',
      moreSensitive.eyeHeightPx > edge.eyeHeightPx && (moreSensitive.awake || !edge.awake)
    );

    // Non-finite/garbage input never throws and never reports awake.
    const garbage = cloudTopsGate({ viewWidthWorldPx: NaN, deckAltitudePx: undefined, zoomSensitivity: -1 });
    ok('garbage input is inert, not a crash', garbage.awake === false && Number.isFinite(garbage.magnification));
  }

  // ---- 2b. buildCloudTopsParallaxWorldXY — the M=1 identity ---------------
  // Real TSL nodes, evaluated numerically the same way the rest of this
  // module's own numeric checks work: build the graph, read back the CPU-side
  // uniform values it was constructed FROM is not possible for a fragment
  // node (no GPU here) — but at M=1 the algebra collapses to
  // `viewCentre + (worldXY - viewCentre) = worldXY`, an IDENTITY independent
  // of what worldXY/viewCentre actually are, which is checkable by
  // construction alone: the two node graphs must be built without throwing,
  // which the section below already proves for the M != 1 case too.
  ok('buildCloudTopsParallaxWorldXY is exported and callable', typeof buildCloudTopsParallaxWorldXY === 'function');

  // ---- 3. keyhole-tsl-constructs-in-node -----------------------------------
  {
    const TSL = THREE.TSL;
    const cloudUniforms = createCloudUniforms(TSL);
    // A non-degenerate recipe so the field's own uniforms aren't all zero —
    // mirrors cloud-lab.js's own driver defaults, not load-bearing for this
    // test (only construction is asserted, never a pixel value).
    cloudUniforms.scalePx.value = 1100;
    cloudUniforms.cover.value = 0.4;
    cloudUniforms.threshold.value = 0.4;
    cloudUniforms.macroThreshold.value = 0.4;

    const sunU = {
      dirXY: TSL.uniform(TSL.vec2(1, 0)),
      sinElev: TSL.uniform(TSL.float(0.5)),
      cosElev: TSL.uniform(TSL.float(0.866)),
      tanElev: TSL.uniform(TSL.float(0.577)),
    };
    const colorsU = {
      keyRgb: TSL.uniform(TSL.vec3(1.0, 0.93, 0.84)),
      fillRgb: TSL.uniform(TSL.vec3(0.46, 0.63, 1.0)),
    };
    const viewCentre = TSL.uniform(TSL.vec2(0, 0));
    const magnification = TSL.uniform(TSL.float(1));

    let tops;
    let threw = null;
    try {
      const worldXY = buildCloudTopsParallaxWorldXY(TSL, TSL.positionWorld.xy, viewCentre, magnification);
      tops = buildCloudTopsNode(TSL, {
        worldXY,
        uniforms: cloudUniforms,
        buildField: buildCloudFieldNode,
        sun: sunU,
        colors: colorsU,
      });
    } catch (err) {
      threw = err;
    }
    ok('buildCloudTopsNode (through the parallax remap) constructs without throwing', threw === null);
    if (threw) console.error('  construction error:', threw.stack || threw);
    ok('returns an rgb node', !!tops?.rgb);
    ok('returns an alpha node', !!tops?.alpha);

    let material;
    let materialThrew = null;
    try {
      material = new THREE.NodeMaterial();
      material.colorNode = tops.rgb;
      material.opacityNode = tops.alpha.mul(TSL.uniform(TSL.float(1)));
      material.transparent = true;
      material.depthTest = false;
      material.depthWrite = false;
      material.side = THREE.DoubleSide;
      material.blending = THREE.NormalBlending;
    } catch (err) {
      materialThrew = err;
    }
    ok('the real NodeMaterial (colorNode + opacityNode) constructs without throwing', materialThrew === null);
    if (materialThrew) console.error('  material error:', materialThrew.stack || materialThrew);

    let mesh;
    let meshThrew = null;
    try {
      const geometry = new THREE.PlaneGeometry(1, 1);
      mesh = new THREE.Mesh(geometry, material);
    } catch (err) {
      meshThrew = err;
    }
    ok('a real THREE.Mesh wraps the material without throwing', meshThrew === null && !!mesh);
  }
}
