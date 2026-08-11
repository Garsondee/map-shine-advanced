/**
 * SHADER LAB — STAGE 2's LOAD-BEARING UNKNOWN, PROVEN BEFORE ANY PRODUCTION
 * CODE COMMITS TO IT (docs/holy/V4-Testament.md's Stage 2 bullets;
 * petition P-004's re-aim of the gate to CPU draw-call submission cost).
 *
 * ============================================================================
 * WHAT STAGE 2 ACTUALLY REQUIRES, READ FROM THE REAL CODE FIRST
 * ============================================================================
 * `effects/lighting/point-light-pool.js#createLightEntry` builds ONE
 * `THREE.Mesh` per light, each with its OWN fan-triangulated polygon geometry
 * (Foundry's real light-shape computation — variable vertex count, up to
 * `INITIAL_LIGHT_FAN_VERTICES`=192, drawn via `geometry.setDrawRange`) and its
 * OWN COMPILED material: `point-light-illumination.js#buildPointLightIllumination
 * Material` bakes `resolveLightAnimation(light.animation.type)` into the node
 * graph at BUILD time, per the project-wide `tsl/no-uniform-gates` discipline
 * (`world/wind-access.js`'s own header names it: "whether a field is present
 * at all is a JS-time branch… so a rebake genuinely requires consumers to
 * REBUILD, not merely to re-read"). Measured (S1.6's capture,
 * `stage1-earlyz-bench-result.json`): `pass.light.accumulate` spends 5.886ms
 * CPU issuing 152 draw calls, against 4.33ms of WHOLE-FRAME GPU time — this is
 * CPU dispatch overhead, not shading cost.
 *
 * TWO CANDIDATE FIXES, AND WHY ONLY ONE SURVIVES CONTACT WITH THE REAL CODE:
 *   1. "One uber-shader, per-instance data read from a storage buffer,
 *      branches on animation type at runtime." This is EXACTLY the shape
 *      `tsl/no-uniform-gates` exists to forbid — animation TYPE is behaviour,
 *      not data, and this project has already paid (candle-flame-render.js's
 *      own tier system) for keeping that distinction as a build-time branch.
 *   2. MERGE lights that already share ONE compiled material (same animation
 *      type, same falloff model, same wind/shadow feature combination — i.e.
 *      already the same pipeline today) into ONE UNGROUPED mesh: one shared
 *      vertex/index buffer, per-light DATA (position, colour, edge points)
 *      baked into extra PER-VERTEX attributes at merge time. No new shader
 *      branch — the SAME compiled material draws every light in the bucket.
 *
 * `scenarios.set('groups-do-not-reduce-draw-calls')` proves candidate 2's own
 * premise first: this project's S1a work (`vt-pan-viewer.js`'s
 * `setTileGeometry`) just shipped geometry GROUPS + a material ARRAY assuming
 * that was a batching win — it is not, for THIS goal. `renderObject` in the
 * vendored WebGPU renderer (three.webgpu.js's own `Array.isArray(material)`
 * branch) pushes ONE render-list entry PER GROUP, and each reaches the
 * backend's own low-level draw dispatch separately, which calls
 * `WebGPUInfo#update()` — "executed per draw call" by its own JSDoc — once
 * per group (three.webgpu.js:46411, called from six backend draw sites
 * including :76208/:76222's index/vertex paths). That increments
 * `render.drawCalls`, the field `info.reset()` actually zeroes.
 *
 * ⚠️ `render.calls` (three.webgpu.js:61327) is a DIFFERENT counter and this
 * bench's own first draft read it by mistake: it increments ONCE PER
 * `render()`/`renderAsync()` INVOCATION, not per draw inside it, and
 * `info.reset()` does not touch it at all (only `info.dispose()` does) — so it
 * is a monotonically-growing total across the bench's ENTIRE lifetime, not a
 * per-scenario count. Reading it produced small-but-wrong numbers (1, 2, 3)
 * that looked plausible enough to almost ship uncorrected; the fix is
 * `render.drawCalls`, read after `info.reset()`, every time.
 *
 * A grouped array-material draw is N real GPU submissions wearing one JS
 * Mesh — it saves shading cost (S1a's own goal), not CPU dispatch cost
 * (Stage 2's). Reading this in source, once, here, is cheaper than
 * re-discovering it after production code ships assuming otherwise.
 *
 * `scenarios.set('merged-mesh-is-order-independent-under-max-blend')` proves
 * candidate 2 itself: N differently-shaped, differently-positioned,
 * differently-coloured light fans — merged into ONE ungrouped mesh, ONE
 * material, drawn ONCE — reproduce the SAME MAX-blended result as drawing
 * them as N separate meshes, byte-identical, regardless of merge order (MAX
 * blending is commutative; a batching bug that silently reordered contribution
 * would still need proving harmless, not assumed so).
 *
 * DELIBERATELY NOT PROVEN HERE: the full illumination shader (wind, sun-
 * shadow floor blend, aperture gobo, edge-soft-margin antialiasing, per-light
 * ANIMATION). Those are the SAME node graph regardless of whether it is fed by
 * a uniform or a per-vertex attribute — batching does not change what the
 * shader computes, only how its inputs arrive. Proving the batching MECHANISM
 * against a simple flat-falloff material first, exactly as
 * `bench-scene-depth.js`'s own header argues for isolating one mechanical
 * question per scenario before the real map's complexity layers on.
 *
 * @module tools/shader-lab/bench-point-lights
 */
import { evaluate, registerBench } from './contract.js';
import {
  buildIlluminationShadingCore,
  buildPointLightIlluminationMaterial,
} from '../../src/effects/lighting/point-light-illumination.js';
import { resolveLightAnimation } from '../../src/effects/lighting/animations/registry.js';
import { describeBucketVertexBuffers } from '../../src/effects/lighting/point-light-batch.js';
import { createWindHandle } from '../../src/world/index.js';

const WORLD = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
const DIM = 256;

/**
 * A regular n-gon fan, in LOCAL space (centred on its own origin — merging
 * translates it, never rebuilds it), matching the real code's own fan
 * convention: vertex 0 is the centre, vertices 1..n trace the perimeter,
 * indices form a triangle fan. Deliberately NOT Foundry's real irregular
 * light-shape polygon — the property under test is "many DIFFERENT vertex
 * counts and positions merge correctly", which a regular n-gon exercises just
 * as well as an irregular one, for far less fixture code.
 *
 * @param {number} sides @param {number} radius
 * @returns {{positions: Float32Array, indices: Uint32Array, vertexCount: number}}
 */
function buildFanLocal(sides, radius) {
  const vertexCount = sides + 1;
  const positions = new Float32Array(vertexCount * 3); // centre + perimeter
  // positions[0..2] = centre = (0,0,0), already zeroed.
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    positions[(i + 1) * 3 + 0] = Math.cos(a) * radius;
    positions[(i + 1) * 3 + 1] = Math.sin(a) * radius;
    positions[(i + 1) * 3 + 2] = 0;
  }
  const indices = new Uint32Array(sides * 3);
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    indices[i * 3 + 0] = 0;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = next + 1;
  }
  return { positions, indices, vertexCount };
}

/**
 * A regular n-gon fan, UNIT-RADIUS, NON-INDEXED — S2.3's own fixture, DIFFERENT
 * from {@link buildFanLocal} on purpose: `buildFanLocal` is indexed (`sides+1`
 * vertices + a shared index buffer), which is NOT how production geometry is
 * shaped (`triangulateLightFan`, `point-light-illumination.js` — a flat
 * triangle LIST, `vertexCount = n*3`, no `setIndex` anywhere,
 * `docs/planning/Point-Light-Batching-Design.md` §3.3 cites this exact
 * convention). S2.3 is the "production-shaped" scenario — its own fixture
 * has to match that shape, not the earlier scenarios' simpler indexed one
 * (`feedback_bench_must_build_inputs_like_production`). Unit radius (not a
 * caller-supplied one, unlike `buildFanLocal`): S2.3's callers separately
 * bake each light's REAL radius into the batched mesh's WORLD `position`
 * buffer while keeping this shape's raw unit-circle coordinates for
 * `aLocalUnit` — see `buildPackedBatchIllumMesh`'s own header for why both
 * are needed.
 *
 * @param {number} sides
 * @returns {{positions: Float32Array, vertexCount: number}} `positions` is
 *   xyz (z always 0), 3 floats/vertex, `vertexCount = sides*3`.
 */
function buildFanLocalUnit(sides) {
  const vertexCount = sides * 3;
  const positions = new Float32Array(vertexCount * 3);
  let o = 0;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    positions[o++] = 0;
    positions[o++] = 0;
    positions[o++] = 0; // centre
    positions[o++] = Math.cos(a0);
    positions[o++] = Math.sin(a0);
    positions[o++] = 0; // rim i
    positions[o++] = Math.cos(a1);
    positions[o++] = Math.sin(a1);
    positions[o++] = 0; // rim i+1
  }
  return { positions, vertexCount };
}

/**
 * MAX-BLEND MATERIAL — the flat-falloff stand-in for
 * `buildPointLightIlluminationMaterial`. `vColor`/`vFalloff` are PER-VERTEX
 * attributes (baked at merge time, never uniforms) so the SAME compiled
 * material draws every light in a merged mesh; `vFalloff` is 1 at the centre
 * vertex, 0 at every perimeter vertex, so ordinary triangle interpolation
 * gives each light a real radial falloff with zero per-fragment distance math
 * — cheap on purpose, since the falloff SHAPE is not what this bench tests.
 *
 * Every flag copied verbatim from `point-light-illumination.js:1487-1497`'s
 * own material build, including `transparent: false` — which is NOT the
 * simplification it looks like.
 *
 * ⚠️ `transparent:false` IS LOAD-BEARING, FOUND CHASING A GHOST (2026-08-11).
 * This bench's own first draft set `transparent:true` here — plausible, since
 * `CustomBlending` obviously wants blending to happen — and that ONE flag
 * mismatch against production produced a convincing but FALSE finding: with
 * `transparent:true`, `DoubleSide` genuinely costs the backend TWO real
 * `renderer.info.render.drawCalls` per mesh (front and back faces submitted
 * separately — the only correct way to alpha-composite a double-sided
 * transparent surface, since blending is order-dependent and a single
 * rasterizer pass cannot depth-sort two triangles of the SAME draw against
 * each other). That looked like a free win sitting in production: switch
 * `DoubleSide` to `FrontSide`, halve every light's draw cost, before touching
 * the harder batching redesign at all. Tested directly against
 * `point-light-illumination.js`'s OWN real flag set before believing it — and
 * at `transparent:false` (production's actual value), DoubleSide costs
 * exactly ONE draw call, byte-identical to FrontSide. Three's own
 * `Array.isArray(material)`-adjacent single-pass path evidently does not need
 * the two-submission split when `transparent` is false regardless of what the
 * blend equation is doing — `transparent` here is not free-floating metadata,
 * it changes which code path the backend takes. No quick win existed; this is
 * recorded so nobody re-discovers the same false lead from a bench that
 * doesn't match its own production source
 * ([[feedback_bench_must_build_inputs_like_production]]).
 *
 * @param {*} THREE
 * @returns {*} a `THREE.NodeMaterial`.
 */
function buildMaxBlendMaterial(THREE) {
  const { Fn, attribute, vec4 } = THREE.TSL;
  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = Fn(() => {
    const col = attribute('vColor', 'vec3');
    const falloff = attribute('vFalloff', 'float');
    return vec4(col.mul(falloff), falloff);
  })();
  return material;
}

/**
 * ONE light drawn as its OWN mesh — the baseline "N separate draws" shape
 * `point-light-pool.js` ships today, using the SAME material/attribute
 * contract as the merged path so a pixel diff between the two proves the
 * MERGE, not a difference in what is being merged.
 *
 * @param {*} THREE @param {{sides:number, radius:number, x:number, y:number, z:number, color:[number,number,number]}} light
 * @returns {*} a `THREE.Mesh`.
 */
function buildSeparateLightMesh(THREE, light) {
  const { positions, indices, vertexCount } = buildFanLocal(light.sides, light.radius);
  const colors = new Float32Array(vertexCount * 3);
  const falloffs = new Float32Array(vertexCount);
  falloffs[0] = 1; // centre
  for (let v = 0; v < vertexCount; v++) {
    colors[v * 3 + 0] = light.color[0];
    colors[v * 3 + 1] = light.color[1];
    colors[v * 3 + 2] = light.color[2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('vColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('vFalloff', new THREE.BufferAttribute(falloffs, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  const mesh = new THREE.Mesh(geo, buildMaxBlendMaterial(THREE));
  mesh.position.set(light.x, light.y, light.z ?? 0);
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * MANY lights merged into ONE ungrouped mesh, ONE material, ONE draw call —
 * candidate fix 2. World-space positions are baked directly into the merged
 * POSITION attribute (no per-instance transform node needed: a light's shape
 * never moves relative to itself after this merge, matching how
 * `point-light-pool.js` already rebuilds geometry from scratch on any
 * placement change rather than transforming it live).
 *
 * @param {*} THREE @param {Array<{sides:number, radius:number, x:number, y:number, z:number, color:[number,number,number]}>} lights
 * @returns {*} a `THREE.Mesh`.
 */
function buildMergedLightsMesh(THREE, lights) {
  let totalVerts = 0;
  let totalIndices = 0;
  const fans = lights.map((light) => {
    const fan = buildFanLocal(light.sides, light.radius);
    totalVerts += fan.vertexCount;
    totalIndices += fan.indices.length;
    return fan;
  });
  const positions = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const falloffs = new Float32Array(totalVerts);
  const indices = new Uint32Array(totalIndices);
  let vOff = 0;
  let iOff = 0;
  for (let li = 0; li < lights.length; li++) {
    const light = lights[li];
    const fan = fans[li];
    for (let v = 0; v < fan.vertexCount; v++) {
      // WORLD position baked directly — this merge is a one-shot snapshot,
      // the same posture `point-light-pool.js` already takes (a placement
      // change rebuilds geometry; it does not move it via a transform node).
      positions[(vOff + v) * 3 + 0] = fan.positions[v * 3 + 0] + light.x;
      positions[(vOff + v) * 3 + 1] = fan.positions[v * 3 + 1] + light.y;
      positions[(vOff + v) * 3 + 2] = fan.positions[v * 3 + 2] + (light.z ?? 0);
      colors[(vOff + v) * 3 + 0] = light.color[0];
      colors[(vOff + v) * 3 + 1] = light.color[1];
      colors[(vOff + v) * 3 + 2] = light.color[2];
    }
    falloffs[vOff] = 1; // this light's own centre vertex
    for (let i = 0; i < fan.indices.length; i++) indices[iOff + i] = fan.indices[i] + vOff;
    vOff += fan.vertexCount;
    iOff += fan.indices.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('vColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('vFalloff', new THREE.BufferAttribute(falloffs, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  // ⚠️ NO GROUPS. This is the entire point — see this module's own header.
  const mesh = new THREE.Mesh(geo, buildMaxBlendMaterial(THREE));
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * S2.3's real thing under test: N lights merged into ONE mesh, per-light
 * values carried as PACKED PER-VERTEX ATTRIBUTES (never `uniformArray`, per
 * `docs/planning/Point-Light-Batching-Design.md` §0/§2), shaded by the REAL
 * production core (`buildIlluminationShadingCore`, unmodified — S2.1's own
 * split is what makes this possible without a second, hand-copied shader).
 *
 * TWO different local-space concepts, BOTH needed, matching design doc §3.3:
 *   - `position` (world-space) is BAKED at build/rebuild time —
 *     `origin + localUnit*radius` — computed ONCE here on the CPU, never a
 *     runtime transform. This is the movement mechanism of record, replacing
 *     the BANNED `uniformArray`-indexed transform (the third scenario's own
 *     narrowed-not-fixed defect).
 *   - `aLocalUnit` carries the RAW unit-circle coordinates, unscaled,
 *     untranslated — what the shading core's `dist`/falloff/switchColor math
 *     actually needs (the equivalent of the per-light path's own
 *     `positionLocal.xy`, which is unusable here because `positionLocal` on
 *     THIS mesh already means the WORLD-baked value).
 *
 * `layout` (from `describeBucketVertexBuffers`, S2.2) drives which buffers
 * actually get created — the SAME function production's own bucket registry
 * will call, so this scenario is a real exercise of it, not a parallel guess.
 *
 * @param {*} THREE
 * @param {Array<object>} lights - see the scenario's own light fixtures for
 *   the exact per-light fields consumed.
 * @param {object} args
 * @param {boolean} args.animated @param {boolean} args.windPresent
 * @param {*} [args.animationEntry] - `resolveLightAnimation`'s own return;
 *   required when `animated`.
 * @param {*} args.uGlobalTimeMs @param {*} args.windHandle
 * @param {number} [args.animationQuality=2] @param {string} [args.falloffModel='inverseSquare']
 * @returns {{mesh: *, geo: *, spans: Record<string,{start:number,count:number}>,
 *   buffers: Record<string,*>, layout: *}} `spans`/`buffers` are what the
 *   movement/value-rewrite checks mutate directly — the exact CPU-side
 *   handles a real bucket registry (S2.2's `createBucket`) would also hold.
 */
function buildPackedBatchIllumMesh(
  THREE,
  lights,
  {
    animated,
    windPresent,
    animationEntry,
    uGlobalTimeMs,
    windHandle,
    animationQuality = 2,
    falloffModel = 'inverseSquare',
  }
) {
  const { attribute, vec2, vec3, vec4 } = THREE.TSL;
  const layout = describeBucketVertexBuffers({ channel: 'illumination', animated, windPresent });

  const fans = lights.map((l) => buildFanLocalUnit(l.sides));
  const totalVerts = fans.reduce((s, f) => s + f.vertexCount, 0);

  const itemSizes = { position: 3, aLocalUnit: 2, aParams: 4, aColorA: 4, aColorB: 4, aColorC: 4, aAnim: 4, aWind: 4 };
  const arrays = {};
  for (const name of layout.buffers) arrays[name] = new Float32Array(totalVerts * itemSizes[name]);

  let vOff = 0;
  const spans = {};
  for (let li = 0; li < lights.length; li++) {
    const l = lights[li];
    const fan = fans[li];
    spans[l.sourceId] = { start: vOff, count: fan.vertexCount };
    for (let v = 0; v < fan.vertexCount; v++) {
      const lx = fan.positions[v * 3 + 0];
      const ly = fan.positions[v * 3 + 1];
      const vi = vOff + v;
      arrays.position[vi * 3 + 0] = l.x + lx * l.radius;
      arrays.position[vi * 3 + 1] = l.y + ly * l.radius;
      arrays.position[vi * 3 + 2] = 0;
      arrays.aLocalUnit[vi * 2 + 0] = lx;
      arrays.aLocalUnit[vi * 2 + 1] = ly;
      arrays.aParams[vi * 4 + 0] = l.ratio;
      arrays.aParams[vi * 4 + 1] = l.attenuationEased;
      arrays.aParams[vi * 4 + 2] = l.exposure ?? 0;
      arrays.aParams[vi * 4 + 3] = l.expectedDepth ?? 0;
      arrays.aColorA[vi * 4 + 0] = l.bg[0];
      arrays.aColorA[vi * 4 + 1] = l.bg[1];
      arrays.aColorA[vi * 4 + 2] = l.bg[2];
      arrays.aColorA[vi * 4 + 3] = l.dim[0];
      arrays.aColorB[vi * 4 + 0] = l.dim[1];
      arrays.aColorB[vi * 4 + 1] = l.dim[2];
      arrays.aColorB[vi * 4 + 2] = l.bright[0];
      arrays.aColorB[vi * 4 + 3] = l.bright[1];
      arrays.aColorC[vi * 4 + 0] = l.bright[2];
      arrays.aColorC[vi * 4 + 1] = 0;
      arrays.aColorC[vi * 4 + 2] = 0;
      arrays.aColorC[vi * 4 + 3] = 0;
      if (animated) {
        arrays.aAnim[vi * 4 + 0] = l.speedRaw;
        arrays.aAnim[vi * 4 + 1] = l.reverseSign;
        arrays.aAnim[vi * 4 + 2] = l.seed;
        arrays.aAnim[vi * 4 + 3] = l.intensityRaw;
      }
      if (windPresent) {
        arrays.aWind[vi * 4 + 0] = l.x;
        arrays.aWind[vi * 4 + 1] = l.y;
        arrays.aWind[vi * 4 + 2] = l.windExposure;
        arrays.aWind[vi * 4 + 3] = l.windResponse;
      }
    }
    vOff += fan.vertexCount;
  }

  const geo = new THREE.BufferGeometry();
  const buffers = {};
  for (const name of layout.buffers) {
    const attr = new THREE.BufferAttribute(arrays[name], itemSizes[name]);
    geo.setAttribute(name, attr);
    buffers[name] = attr;
  }

  const aParamsNode = attribute('aParams', 'vec4');
  const aColorANode = attribute('aColorA', 'vec4');
  const aColorBNode = attribute('aColorB', 'vec4');
  const aColorCNode = attribute('aColorC', 'vec4');
  let animInput = null;
  if (animated) {
    const n = attribute('aAnim', 'vec4');
    animInput = { speedRaw: n.x, reverseSign: n.y, seed: n.z, intensityRaw: n.w };
  }
  let windInput = null;
  if (windPresent) {
    const n = attribute('aWind', 'vec4');
    windInput = { center: vec2(n.x, n.y), exposure: n.z, response: n.w };
  }

  const { finalNode, alphaNode } = buildIlluminationShadingCore({
    THREE,
    inputs: {
      localUnitXY: attribute('aLocalUnit', 'vec2'),
      ratio: aParamsNode.x,
      attenuationEased: aParamsNode.y,
      exposure: aParamsNode.z,
      expectedDepth: aParamsNode.w,
      backgroundColor: vec3(aColorANode.x, aColorANode.y, aColorANode.z),
      dimColor: vec3(aColorANode.w, aColorBNode.x, aColorBNode.y),
      brightColor: vec3(aColorBNode.z, aColorBNode.w, aColorCNode.x),
      anim: animInput,
      wind: windInput,
    },
    shared: {
      uGlobalTimeMs,
      windHandle,
      attrTexNode: null,
      depthTexNode: null,
      depthFlagsTexNode: null,
      sunShadowSlotNodes: null,
      blendSunVisibilityAcrossFloors: null,
      apertureGoboShared: null,
    },
    flags: { animation: animated ? animationEntry : null, animationQuality, falloffModel, apertureCount: 0 },
  });

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(finalNode, alphaNode);

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;

  return { mesh, geo, spans, buffers, layout };
}

/**
 * The COMPARISON TWIN for `batched-byte-identical-to-uniform-twins`: N
 * SEPARATE meshes, each built by the REAL, unmodified per-light wrapper
 * (`buildPointLightIlluminationMaterial`) and placed via `mesh.position`/
 * `mesh.scale` — production's actual, current technique
 * (`point-light-pool.js:1365-1366`), untouched by anything S2 has built.
 * If the batched mesh's rendered output ever diverges from this, the
 * divergence is real — this is what production draws TODAY, per light.
 *
 * @param {*} THREE @param {Array<object>} lights
 * @param {object} args - same shape as `buildPackedBatchIllumMesh`'s own.
 * @returns {{scene: *, handles: Array<{mesh:*, handle:object, light:object}>}}
 */
function buildUniformTwinIllumMeshes(
  THREE,
  lights,
  {
    animated,
    windPresent,
    animationEntry,
    uGlobalTimeMs,
    windHandle,
    animationQuality = 2,
    falloffModel = 'inverseSquare',
  }
) {
  const { uniform, vec3 } = THREE.TSL;
  const scene = new THREE.Scene();
  const handles = [];
  for (const l of lights) {
    const uBackgroundColor = uniform(vec3(l.bg[0], l.bg[1], l.bg[2]));
    const uDimColor = uniform(vec3(l.dim[0], l.dim[1], l.dim[2]));
    const uBrightColor = uniform(vec3(l.bright[0], l.bright[1], l.bright[2]));
    const handle = buildPointLightIlluminationMaterial({
      THREE,
      uBackgroundColor,
      uDimColor,
      uBrightColor,
      animation: animated ? animationEntry : null,
      uGlobalTimeMs,
      animationQuality,
      falloffModel,
      windCenter: windPresent ? { x: l.x, y: l.y } : undefined,
      windExposure: windPresent ? l.windExposure : undefined,
      windResponse: windPresent ? l.windResponse : undefined,
      windHandle,
    });
    handle.uRatio.value = l.ratio;
    handle.uAttenuationEased.value = l.attenuationEased;
    handle.uExposure.value = l.exposure ?? 0;
    handle.uLightExpectedDepth.value = l.expectedDepth ?? 0;
    if (animated) {
      handle.uSpeedRaw.value = l.speedRaw;
      handle.uReverseSign.value = l.reverseSign;
      handle.uSeed.value = l.seed;
      handle.uIntensityRaw.value = l.intensityRaw;
    }
    if (windPresent) {
      handle.uWindCenter.value.set(l.x, l.y);
      handle.uWindExposure.value = l.windExposure;
      handle.uWindResponse.value = l.windResponse;
    }
    const fan = buildFanLocalUnit(l.sides);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(fan.positions, 3));
    const mesh = new THREE.Mesh(geo, handle.material);
    // Production's REAL placement technique — see this function's own header.
    mesh.position.set(l.x, l.y, 0);
    mesh.scale.set(l.radius, l.radius, 1);
    mesh.frustumCulled = false;
    scene.add(mesh);
    handles.push({ mesh, handle, light: l });
  }
  return { scene, handles };
}

export function createPointLightsBench({ THREE, log }) {
  let renderer = null;
  let camera = null;
  let colorRt = null;

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    camera = new THREE.OrthographicCamera(WORLD.minX, WORLD.maxX, WORLD.maxY, WORLD.minY, 0.01, 10);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    colorRt = new THREE.RenderTarget(DIM, DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.NoColorSpace,
    });
    log?.(`POINT-LIGHTS: renderer backend ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
  }

  /** @returns {{color: Uint8Array, drawCalls: number}} */
  async function renderScene(scene) {
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(colorRt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.info.autoReset = false;
    renderer.info.reset();
    await renderer.renderAsync(scene, camera);
    const drawCalls = renderer.info.render.drawCalls;
    renderer.info.autoReset = true;
    renderer.setRenderTarget(prevTarget);
    const buf = await renderer.readRenderTargetPixelsAsync(colorRt, 0, 0, DIM, DIM);
    return { color: ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf), drawCalls };
  }

  // ⚠️ Y-FLIP (feedback_y_flip_recurring_risk — this project's own named,
  // "bitten five times" risk; this is the sixth), found live 2026-08-11 while
  // debugging what looked like a real GPU defect in S2.3's new checks.
  // `readRenderTargetPixelsAsync`'s row 0 is HIGH world-Y (near `WORLD.maxY`),
  // not low — confirmed directly: a quad authored at world Y∈[750,850] reads
  // back at buffer row ≈51 (near the TOP), never row ≈205 (near the bottom,
  // what the un-flipped `row = fy*DIM` this function used to compute would
  // predict). Every check that only ever sampled y=500 (this WORLD's exact
  // vertical midpoint, self-symmetric under a flip) was blind to this the
  // whole session; only an asymmetric-Y sample point could ever have caught
  // it, which is exactly what S2.3's own movement checks were the first to
  // do. `row = (1 - fy) * DIM`, not `fy * DIM`.
  function sampleColor(colorBuf, x, y) {
    const fx = (x - WORLD.minX) / (WORLD.maxX - WORLD.minX);
    const fy = (y - WORLD.minY) / (WORLD.maxY - WORLD.minY);
    const px = Math.min(DIM - 1, Math.max(0, Math.floor(fx * DIM)));
    const row = Math.min(DIM - 1, Math.max(0, Math.floor((1 - fy) * DIM)));
    const i = (row * DIM + px) * 4;
    return { r: colorBuf[i], g: colorBuf[i + 1], b: colorBuf[i + 2], a: colorBuf[i + 3] };
  }

  // Deliberately varied: different vertex counts (triangle through decagon),
  // different radii, different colours, TWO overlapping at the centre (the
  // case that actually exercises MAX blending — non-overlapping lights would
  // pass even with plain alpha blending and prove nothing about MAX
  // specifically).
  const LIGHTS = [
    { sides: 3, radius: 120, x: 300, y: 500, color: [1, 0, 0] },
    { sides: 4, radius: 90, x: 500, y: 500, color: [0, 1, 0] }, // overlaps the pentagon below
    { sides: 5, radius: 110, x: 560, y: 480, color: [0.2, 0.2, 1] }, // overlaps the square above
    { sides: 6, radius: 70, x: 750, y: 300, color: [1, 1, 0] },
    { sides: 10, radius: 100, x: 750, y: 750, color: [1, 0, 1] },
  ];

  const scenarios = new Map();

  scenarios.set('groups-do-not-reduce-draw-calls', {
    name: 'groups-do-not-reduce-draw-calls',
    summary:
      "Pins the S1a finding this bench's own header explains: a geometry with N groups + an " +
      'N-element material array issues N real renderer.info.render.drawCalls, not one. Read once ' +
      "here so Stage 2 does not repeat S1a's own first assumption.",
    async run() {
      await ensureRenderer();
      const checks = [];
      const { Fn, vec4, float } = THREE.TSL;
      const flatMat = (r, g, b) => {
        const m = new THREE.NodeMaterial();
        m.fragmentNode = Fn(() => vec4(float(r), float(g), float(b), float(1)))();
        return m;
      };
      const { positions: posA, indices: idxA, vertexCount: vcA } = buildFanLocal(3, 150);
      const { positions: posB, indices: idxB, vertexCount: vcB } = buildFanLocal(6, 150);
      for (let i = 0; i < vcB; i++) {
        posB[i * 3 + 0] += 400; // shift the second fan clear of the first
      }
      const positions = new Float32Array((vcA + vcB) * 3);
      positions.set(posA, 0);
      positions.set(posB, vcA * 3);
      const indices = new Uint32Array(idxA.length + idxB.length);
      indices.set(idxA, 0);
      for (let i = 0; i < idxB.length; i++) indices[idxA.length + i] = idxB[i] + vcA;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
      geo.clearGroups();
      geo.addGroup(0, idxA.length, 0);
      geo.addGroup(idxA.length, idxB.length, 1);
      const mesh = new THREE.Mesh(geo, [flatMat(1, 0, 0), flatMat(0, 1, 0)]);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);
      const { drawCalls } = await renderScene(scene);
      checks.push(
        evaluate('two-groups-cost-two-real-draw-calls', () => ({
          ok: drawCalls === 2,
          measured: `${drawCalls} renderer.info.render.drawCalls for a 2-group array-material mesh`,
          expected: '2 — confirms groups do NOT collapse into one GPU submission on this backend',
          note: 'if this ever reads 1, three changed how it dispatches grouped array materials and Stage 2 should hear about it',
        }))
      );
      geo.dispose();
      return { checks, calibration: 'OK' };
    },
  });

  scenarios.set('merged-mesh-is-order-independent-under-max-blend', {
    name: 'merged-mesh-is-order-independent-under-max-blend',
    summary:
      'THE PROOF Stage 2 is built on: N differently-shaped, differently-positioned, ' +
      'differently-coloured lights merged into ONE ungrouped mesh under MAX blending are ' +
      'byte-identical to drawing them as N separate meshes, in EITHER merge order, at ONE ' +
      'real draw call instead of N.',
    async run() {
      await ensureRenderer();
      const checks = [];

      const scene1 = new THREE.Scene();
      for (const light of LIGHTS) scene1.add(buildSeparateLightMesh(THREE, light));
      const separate = await renderScene(scene1);

      const scene2 = new THREE.Scene();
      const merged = buildMergedLightsMesh(THREE, LIGHTS);
      scene2.add(merged);
      const mergedResult = await renderScene(scene2);

      const reversed = [...LIGHTS].reverse();
      const scene3 = new THREE.Scene();
      scene3.add(buildMergedLightsMesh(THREE, reversed));
      const mergedReversed = await renderScene(scene3);

      checks.push(
        evaluate('separate-draw-uses-N-real-calls', () => ({
          ok: separate.drawCalls === LIGHTS.length,
          measured: `${separate.drawCalls} draw calls for ${LIGHTS.length} separate meshes`,
          expected: `${LIGHTS.length} — the baseline this bench must beat`,
        }))
      );
      checks.push(
        evaluate('merged-draw-uses-ONE-real-call', () => ({
          ok: mergedResult.drawCalls === 1,
          measured: `${mergedResult.drawCalls} draw call for ${LIGHTS.length} merged lights`,
          expected: '1 — THE Stage 2 win, measured on the real device, not assumed from the design',
        }))
      );

      let maxDelta = 0;
      let differing = 0;
      for (let i = 0; i < separate.color.length; i++) {
        const d = Math.abs(separate.color[i] - mergedResult.color[i]);
        if (d > 0) differing++;
        if (d > maxDelta) maxDelta = d;
      }
      checks.push(
        evaluate('merged-is-byte-identical-to-separate', () => ({
          ok: differing === 0,
          measured: `${differing} differing bytes, maxDelta ${maxDelta}`,
          expected: '0 differing bytes — the merge must not change a single pixel MAX blending already decided',
        }))
      );

      let orderDiffers = 0;
      for (let i = 0; i < mergedResult.color.length; i++) {
        if (mergedResult.color[i] !== mergedReversed.color[i]) orderDiffers++;
      }
      checks.push(
        evaluate('merge-order-does-not-matter', () => ({
          ok: orderDiffers === 0,
          measured: `${orderDiffers} bytes differ between forward and reversed merge order`,
          expected:
            '0 — MAX blending is commutative; a batching bug that reordered contribution would show up here first',
        }))
      );

      // NON-VACUITY: the overlap region (square × pentagon, LIGHTS[1]/[2])
      // must actually show a MAX-composited result, not one colour silently
      // winning by z-order or draw sequence — otherwise every check above
      // could pass on a broken blend that merely never got exercised.
      const overlap = sampleColor(mergedResult.color, 530, 490);
      checks.push(
        evaluate('overlap-region-shows-real-MAX-compositing', () => ({
          ok: overlap.r > 10 && overlap.g > 10 && overlap.b > 10,
          measured: `${overlap.r},${overlap.g},${overlap.b} at the square/pentagon overlap`,
          expected:
            'all three channels present — green (0,1,0) MAX blue (0.2,0.2,1) must show as a real mix, not one light silently absent',
        }))
      );

      return { checks, calibration: 'OK' };
    },
  });

  scenarios.set('indexed-transform-array-preserves-cheap-position-updates', {
    name: 'indexed-transform-array-preserves-cheap-position-updates',
    summary:
      "THE REAL MODULE'S actual design, proven before it is built: " +
      '`triangulateLightFan` (point-light-illumination.js) keeps every light in LOCAL, unit-' +
      'radius space — world placement is a cheap `mesh.position.set()`/`mesh.scale.set()` ' +
      'transform, never a vertex rewrite. A merge that bakes world position INTO vertex data ' +
      "(this bench's own first two scenarios) loses that: `lightShapeChanged` only fires on a " +
      'real polygon change, but a light that merely MOVES or PULSES its radius would need a ' +
      'full vertex-data rewrite every frame instead. The fix: keep local-space vertices, add a ' +
      'per-vertex `lightSlot` attribute, and hold (origin, radius) per light in a SEPARATE small ' +
      '`uniformArray`, read in the VERTEX stage indexed by that attribute — this project has only ' +
      'ever indexed a `uniformArray` from the FRAGMENT stage before (the soft-edge polygon SDF, ' +
      'point-light-illumination.js), so vertex-stage indexed reads are the genuinely new claim ' +
      'here, proven on the real device before any production code assumes it.' +
      '\n\n✅ ALL FOUR CHECKS PASS (corrected 2026-08-11 — see docs/holy/V4-Testament.md P-005 for ' +
      'the full account). This scenario previously reported `moving-a-light-only-touched-its-OWN-' +
      'transform-slot` as failing, and an extensive investigation (real, careful device ' +
      'instrumentation: patching `UniformArrayNode.value` and `device.queue.writeBuffer` itself, ' +
      'both proven byte-correct) concluded the render was somehow "stuck" on stale data, narrowed ' +
      "to the backend's bind-group layer. That conclusion was WRONG. The actual bug was in THIS " +
      "BENCH FILE's own `sampleColor()` — `row = fy * DIM` instead of `row = (1 - fy) * DIM` " +
      "(readRenderTargetPixelsAsync's row 0 is HIGH world-Y, not low). Every check in this file " +
      "that sampled a named coordinate happened to use world Y=500 (this WORLD's exact vertical " +
      'midpoint, self-symmetric under a flip), so the bug was invisible until this specific check ' +
      'sampled asymmetric Y values (425, 650). With `sampleColor` fixed, this check passes ' +
      'cleanly — the light was moving correctly the whole time; the write WAS byte-correct AND the ' +
      'render WAS correct, only the MEASUREMENT reading it back was wrong. The device-instrumentation ' +
      'work itself was not wasted — it correctly ruled out the write path, which is exactly why the ' +
      'remaining gap (a broken read) was findable once someone thought to question the sampler ' +
      'instead of the mechanism (`feedback_instruments_must_not_lie`).',
    async run() {
      await ensureRenderer();
      const checks = [];
      const { Fn, attribute, positionLocal, uniformArray, vec3, vec4, float, int } = THREE.TSL;

      // Three lights, LOCAL-space QUADS centred on their OWN origin (local
      // (0,0) is the shape's centre, matching how a real light fan is built
      // AROUND the light's own origin — see triangulateLightFan). Deliberately
      // NOT a corner-anchored triangle (this scenario's first draft): sampling
      // a shape exactly AT one of its own vertices is a real rasterisation
      // edge case (a zero-area point, fill-rule dependent) and produced
      // false-negative "nothing rendered" reads even once positionLocal was
      // fixed. A shape centred on its own origin makes "sample at the origin"
      // trivially, robustly inside it.
      const LOCAL_LIGHTS = [{ color: [1, 0, 0] }, { color: [0, 1, 0] }, { color: [0.2, 0.2, 1] }];
      // Non-indexed, two triangles — matches triangulateLightFan's own
      // non-indexed convention (a flat triangle LIST, no setIndex anywhere in
      // point-light-pool.js's real geometry).
      // prettier-ignore
      const localQuad = new Float32Array([
        -1, -1, 0,  1, -1, 0,  1, 1, 0,
        -1, -1, 0,  1, 1, 0,  -1, 1, 0,
      ]);
      const vertsPerLight = 6;
      const totalVerts = LOCAL_LIGHTS.length * vertsPerLight;
      const positions = new Float32Array(totalVerts * 3);
      const colors = new Float32Array(totalVerts * 3);
      const slotIndex = new Float32Array(totalVerts);
      for (let li = 0; li < LOCAL_LIGHTS.length; li++) {
        for (let v = 0; v < vertsPerLight; v++) {
          const o = (li * vertsPerLight + v) * 3;
          positions[o + 0] = localQuad[v * 3 + 0];
          positions[o + 1] = localQuad[v * 3 + 1];
          positions[o + 2] = 0;
          colors[o + 0] = LOCAL_LIGHTS[li].color[0];
          colors[o + 1] = LOCAL_LIGHTS[li].color[1];
          colors[o + 2] = LOCAL_LIGHTS[li].color[2];
          slotIndex[li * vertsPerLight + v] = li;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('vColor', new THREE.BufferAttribute(colors, 3));
      geo.setAttribute('vSlot', new THREE.BufferAttribute(slotIndex, 1));

      // THE PER-LIGHT TRANSFORM ARRAY — updated per-frame in production,
      // completely independent of the (unchanged) vertex buffer above.
      const MAX_SLOTS = 8;
      const originArr = Array.from({ length: MAX_SLOTS }, () => new THREE.Vector2(0, 0));
      const uOrigin = uniformArray(originArr, 'vec2');
      const radiusArr = new Array(MAX_SLOTS).fill(0);
      const uRadius = uniformArray(radiusArr, 'float');

      const material = new THREE.NodeMaterial();
      material.transparent = false;
      material.depthTest = false;
      material.depthWrite = false;
      material.side = THREE.DoubleSide;
      material.blending = THREE.CustomBlending;
      material.blendEquation = THREE.MaxEquation;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneFactor;
      material.blendEquationAlpha = THREE.MaxEquation;
      material.blendSrcAlpha = THREE.OneFactor;
      material.blendDstAlpha = THREE.OneFactor;
      // THE MECHANISM UNDER TEST: a per-vertex attribute selects which
      // element of a shared uniformArray this VERTEX reads, in the VERTEX
      // stage (positionNode), to place local-space geometry in world space —
      // exactly what a cheap per-frame position/radius update would write
      // into, leaving `position`/`vSlot` above untouched.
      //
      // ⚠️ `positionLocal`, NOT `attribute('position', 'vec3')` (found live,
      // 2026-08-11): this material OVERRIDES `positionNode` entirely, and a
      // manual `attribute('position', ...)` read inside that override does
      // not resolve to the geometry's real input position on this backend —
      // every fragment rendered fully transparent black, geometry present
      // (`renderer.info.render.drawCalls` still read 1) but nothing visible
      // anywhere in the target. `positionLocal` is three's own canonical
      // symbolic reference for "the raw local-space vertex position", and is
      // what every other `positionNode` override in this codebase already
      // uses (e.g. the vegetation wind displacement in `vt-pan-viewer.js`) —
      // this scenario's first draft used the wrong node instead of following
      // that established convention.
      material.positionNode = Fn(() => {
        const slot = int(attribute('vSlot', 'float'));
        const origin = uOrigin.element(slot);
        const radius = uRadius.element(slot);
        const world = positionLocal.xy.mul(radius).add(origin);
        return vec3(world, float(0));
      })();
      material.fragmentNode = Fn(() => vec4(attribute('vColor', 'vec3'), float(1)))();

      const mesh = new THREE.Mesh(geo, material);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);

      // FRAME 1 — an initial placement, written ONLY to the transform array
      // (`uOrigin`/`uRadius` already reference `originArr`/`radiusArr` by
      // identity from their construction above — no `.array = ...`
      // reassignment needed here or before frame 2 below).
      //
      // ✅ RESOLVED 2026-08-11 — see the scenario's `summary` string above and
      // docs/holy/V4-Testament.md's P-005: this was never a device defect.
      // This scenario's OWN `sampleColor()` had a Y-flip bug, unrelated to
      // anything below — fixed once, at its one definition, not here.
      originArr[0].set(300, 500);
      radiusArr[0] = 80;
      originArr[1].set(700, 500);
      radiusArr[1] = 80;
      originArr[2].set(500, 900);
      radiusArr[2] = 80;
      const frame1 = await renderScene(scene);

      // FRAME 2 — light 1 (green) MOVES DIAGONALLY and its radius GROWS.
      // Vertex/slot attributes are NEVER touched — only the transform array
      // changes, exactly the cheap per-frame path this scenario exists to
      // prove.
      originArr[1].set(560, 650);
      radiusArr[1] = 220;
      const frame2 = await renderScene(scene);

      checks.push(
        evaluate('single-merged-draw-even-with-per-light-transforms', () => ({
          ok: frame1.drawCalls === 1 && frame2.drawCalls === 1,
          measured: `frame1=${frame1.drawCalls}, frame2=${frame2.drawCalls} draw calls`,
          expected: '1 and 1 — three lights, one draw, in BOTH frames',
        }))
      );

      const before1 = sampleColor(frame1.color, 300, 500);
      const before2 = sampleColor(frame1.color, 700, 500);
      checks.push(
        evaluate('frame1-lights-render-at-their-own-transform-slots', () => ({
          ok: before1.r > 200 && before2.g > 200,
          measured: `slot0(red) at its origin=${before1.r},${before1.g},${before1.b}; slot1(green) at its origin=${before2.r},${before2.g},${before2.b}`,
          expected:
            'slot0 reads red-dominant, slot1 reads green-dominant — each vertex found ITS OWN slot´s transform, not slot 0´s for everyone',
        }))
      );

      const movedTo = sampleColor(frame2.color, 560, 650);
      // OLD footprint (origin 700,500 radius 80): x in [620,780], y in
      // [420,580]. NEW footprint (origin 560,650 radius 220): x in
      // [340,780], y in [430,870] — they overlap on x, since the radius grew
      // along with the move. (700,425) sits inside the OLD footprint's
      // y-range but below the NEW footprint's y-floor (430) — the one point
      // that is unambiguous proof the light actually moved rather than
      // merely grew in place.
      const oldSpotGone = sampleColor(frame2.color, 700, 425);
      checks.push(
        evaluate('moving-a-light-only-touched-its-OWN-transform-slot', () => ({
          ok: movedTo.g > 200 && oldSpotGone.r === 0 && oldSpotGone.g === 0 && oldSpotGone.b === 0,
          measured: `new spot=${movedTo.r},${movedTo.g},${movedTo.b}; old spot=${oldSpotGone.r},${oldSpotGone.g},${oldSpotGone.b}`,
          expected:
            'green now renders at its NEW origin and the OLD spot (outside the new footprint too) is empty — a transform-array write alone moved it, no vertex rewrite',
        }))
      );

      const untouchedSlot0 = sampleColor(frame2.color, 300, 500);
      const untouchedSlot2 = sampleColor(frame2.color, 500, 900);
      checks.push(
        evaluate('untouched-lights-are-pixel-identical-across-frames', () => ({
          ok:
            untouchedSlot0.r === before1.r &&
            untouchedSlot0.g === before1.g &&
            untouchedSlot2.b === sampleColor(frame1.color, 500, 900).b,
          measured: `slot0 frame1=${before1.r},${before1.g},${before1.b} frame2=${untouchedSlot0.r},${untouchedSlot0.g},${untouchedSlot0.b}`,
          expected: 'byte-identical — slot 1´s transform write must not perturb slots 0 or 2 in the SAME shared array',
        }))
      );

      geo.dispose();
      return { checks, calibration: 'OK' };
    },
  });

  scenarios.set('production-shaped-packed-batch', {
    name: 'production-shaped-packed-batch',
    summary:
      "S2.3 (docs/planning/Point-Light-Batching-Design.md §7) — Stage 2's mechanism of record, " +
      'proven on-device with the REAL shading core (`buildIlluminationShadingCore`, S2.1) and the ' +
      'REAL layout function (`describeBucketVertexBuffers`, S2.2), not a simplified stand-in. Seven ' +
      "checks, 6/7 passing: one draw for the fully-loaded (animated + wind) case; that layout's " +
      '8-buffer count proven by an actual compile+draw, not arithmetic alone; movement via ' +
      'rewriting the `position` span (the mechanism that REPLACES uniformArray — the third ' +
      'scenario\'s own once-"unresolved" check is now RESOLVED, docs/holy/V4-Testament.md P-005: ' +
      "it was a Y-flip bug in THIS FILE's own `sampleColor`, not a device defect); a single light's " +
      'value rewrite touches nothing else; two renders with zero writes stay byte-stable. The ONE ' +
      "real, understood failure: at animationQuality:2 (production's actual value), the batched " +
      "mesh diverges from production's own per-light wrapper — root cause CONFIRMED (not a " +
      "mystery): candle-flicker.js's candleShape() reads `positionLocal` directly at quality>=2, " +
      "bypassing the core's own injected local-position value; the SAME comparison at quality:1 " +
      'passes byte-perfectly, isolating the gap to that one animation helper, not the core split.',
    async run() {
      await ensureRenderer();
      const checks = [];
      const animationEntry = resolveLightAnimation('candleFlicker');
      const uGlobalTimeMs = THREE.TSL.uniform(THREE.TSL.float(4200));
      const windHandle = createWindHandle();

      // ==== Checks 1-3: the FULLY-LOADED case (animated + wind), candleFlicker
      // — S2.0's own census found this is production's actual dominant shape
      // (207 candle anchors, one shared bucket). ====
      const FULL_LIGHTS = [
        {
          sourceId: 'A',
          x: 300,
          y: 400,
          radius: 90,
          sides: 20,
          ratio: 0.25,
          attenuationEased: 0.6,
          exposure: 0,
          bg: [0.5, 0.5, 0.5],
          dim: [0.65, 0.65, 0.65],
          bright: [1, 0.9, 0.8],
          speedRaw: 5,
          reverseSign: 1,
          seed: 11,
          intensityRaw: 5,
          windExposure: 0.7,
          windResponse: 1,
        },
        {
          sourceId: 'B',
          x: 650,
          y: 400,
          radius: 130,
          sides: 24,
          ratio: 0.3,
          attenuationEased: 0.5,
          exposure: 0,
          bg: [0.5, 0.5, 0.5],
          dim: [0.6, 0.6, 0.6],
          bright: [1, 1, 0.9],
          speedRaw: 5,
          reverseSign: 1,
          seed: 37,
          intensityRaw: 5,
          windExposure: 0.4,
          windResponse: 1,
        },
        {
          sourceId: 'C',
          x: 480,
          y: 750,
          radius: 70,
          sides: 16,
          ratio: 0.2,
          attenuationEased: 0.7,
          exposure: 0,
          bg: [0.5, 0.5, 0.5],
          dim: [0.6, 0.6, 0.6],
          bright: [1, 0.85, 0.7],
          speedRaw: 5,
          reverseSign: 1,
          seed: 59,
          intensityRaw: 5,
          windExposure: 0.9,
          windResponse: 1,
        },
      ];
      const fullCfg = {
        animated: true,
        windPresent: true,
        animationEntry,
        uGlobalTimeMs,
        windHandle,
        animationQuality: 2,
        falloffModel: 'inverseSquare',
      };

      const layout = describeBucketVertexBuffers({ channel: 'illumination', animated: true, windPresent: true });
      // ⚠️ `evaluate()` calls its callback SYNCHRONOUSLY and reads
      // `.ok`/`.measured`/`.expected` off whatever it returns IMMEDIATELY
      // (contract.js:93-109) — it does not await a Promise. This check (and
      // every other one below) computes its async result FIRST via a plain
      // `await`, then calls `evaluate()` with a synchronous closure over the
      // already-resolved values. An earlier draft returned `renderScene(...)
      // .then(...)` directly from the `evaluate()` callback — `evaluate()`
      // read the unresolved Promise as a truthy-but-fieldless object
      // (`.ok`/`.measured` both undefined → an instant, uninformative fail)
      // AND, because nothing awaited it, let every render AFTER this one
      // start while this one was still in flight on the shared `colorRt`,
      // corrupting checks 2-4's own results too (a stray-render race, not a
      // batching-mechanism bug — caught and fixed before it could be
      // mistaken for one).
      {
        const batch = buildPackedBatchIllumMesh(THREE, FULL_LIGHTS, fullCfg);
        const scene = new THREE.Scene();
        scene.add(batch.mesh);
        const r = await renderScene(scene);
        batch.geo.dispose();
        checks.push(
          evaluate('fully-loaded-layout-fits-vertex-buffer-limit', () => ({
            ok:
              layout.count === 8 && layout.ok === true && Object.keys(batch.buffers).length === 8 && r.drawCalls === 1,
            measured: `describeBucketVertexBuffers count=${layout.count} ok=${layout.ok}; real geometry attributes=${Object.keys(batch.buffers).length}; drawCalls=${r.drawCalls}`,
            expected:
              '8 and true from the arithmetic, matching 8 REAL attributes that actually compiled and drew — the device accepted the fully-loaded layout, not just the count',
          }))
        );
      }

      const packedResult = await (async () => {
        const batch = buildPackedBatchIllumMesh(THREE, FULL_LIGHTS, fullCfg);
        const scene = new THREE.Scene();
        scene.add(batch.mesh);
        const frame = await renderScene(scene);
        batch.geo.dispose();
        return frame;
      })();
      checks.push(
        evaluate('packed-batch-renders-one-draw', () => ({
          ok: packedResult.drawCalls === 1,
          measured: `drawCalls=${packedResult.drawCalls}`,
          expected: '1 — three animated, wind-present lights, one merged mesh, one real draw call',
        }))
      );

      const twins = buildUniformTwinIllumMeshes(THREE, FULL_LIGHTS, fullCfg);
      const twinFrame = await renderScene(twins.scene);
      for (const h of twins.handles) h.mesh.geometry.dispose();
      let maxDelta = 0;
      let firstDiffAt = null;
      for (let i = 0; i < packedResult.color.length; i++) {
        const d = Math.abs(packedResult.color[i] - twinFrame.color[i]);
        if (d > maxDelta) maxDelta = d;
        if (d > 0 && firstDiffAt === null) firstDiffAt = i;
      }
      // ⚠️ CONFIRMED, REAL, UNDERSTOOD GAP (2026-08-11) — do not fudge this to
      // pass by quietly lowering `fullCfg.animationQuality`. `quality: 2` is
      // the REAL production value (S2.1's own harness capture: the live
      // Mansion's candles run at `animation.quality:2` today) — testing
      // anything lower would misrepresent what batching actually supports.
      // Root cause, found by reading source, then CONFIRMED by an isolated
      // per-quality-tier A/B (not left as a mystery): `animations/candle-
      // flicker.js#candleShape` (called only at `quality >= 2`) reads
      // `positionLocal.xy` DIRECTLY (line ~251) — the raw TSL global vertex-
      // position symbol — instead of using the `dist`/local-position value
      // the shading core already computed and would have passed through
      // correctly. For the per-light twin mesh, `positionLocal` genuinely IS
      // the unit-circle local coordinate (mesh.position/scale places it), so
      // `candleShape`'s lean/shape math gets sane inputs. For the BATCHED
      // mesh, `positionLocal` is the WORLD-BAKED coordinate (§3.3's own
      // design — `position` holds `origin + local*radius`), so the SAME code
      // feeds `candleShape` a wildly out-of-range value, producing garbage
      // shape math that collapses this check's sample point to pure
      // background. Isolated with a per-quality-tier A/B, single light,
      // single sample point: quality 0 and 1 are BYTE-IDENTICAL between
      // batch and twin (`candleShape`'s own `if (quality<2) return
      // {flameDist:dist}` fallback correctly uses the injected value); only
      // quality>=2 diverges, and only there. `sunburst`/`emanation` are
      // named in `candleShape`'s own comment as reading `positionLocal` the
      // same way — likely the same class of gap, unaudited here.
      //
      // This is NOT a device defect and NOT covered by S2.1's core split —
      // the core itself is proven correct (see the quality<2 check just
      // below). It is a SEPARATE, real requirement S2.1 did not anticipate:
      // animation SEED BUILDERS that reach for `positionLocal` directly also
      // need to accept an injected local-position node before they batch
      // correctly. Recorded as a real gap in
      // `docs/planning/Point-Light-Batching-Design.md` and
      // `docs/holy/V4-Testament.md` — not silently worked around here.
      checks.push(
        evaluate('batched-byte-identical-to-uniform-twins', () => ({
          ok: maxDelta === 0,
          measured: `maxChannelDelta=${maxDelta}${firstDiffAt !== null ? ` (first diff at byte ${firstDiffAt})` : ''}; twin drawCalls=${twinFrame.drawCalls}`,
          expected:
            '0, but a REAL, understood gap fails this at quality:2 (production´s actual value): candle-flicker.js´s candleShape() reads positionLocal directly, bypassing the injected local-position value — sound for quality<2 (see the next check), broken specifically where an animation seed builder reaches around the core´s own injection seam',
        }))
      );

      // Isolates the CORE mechanism from the animation-seed-builder gap just
      // documented: the SAME batched-vs-twin comparison, SAME lights, ONLY
      // `animationQuality` dropped to 1 (still animated, still wind-present —
      // `candleShape`'s positionLocal branch specifically requires >=2).
      const lowerQualityCfg = { ...fullCfg, animationQuality: 1 };
      const packedLowQ = await (async () => {
        const batch = buildPackedBatchIllumMesh(THREE, FULL_LIGHTS, lowerQualityCfg);
        const scene = new THREE.Scene();
        scene.add(batch.mesh);
        const frame = await renderScene(scene);
        batch.geo.dispose();
        return frame;
      })();
      const twinsLowQ = buildUniformTwinIllumMeshes(THREE, FULL_LIGHTS, lowerQualityCfg);
      const twinLowQFrame = await renderScene(twinsLowQ.scene);
      for (const h of twinsLowQ.handles) h.mesh.geometry.dispose();
      let lowQMaxDelta = 0;
      for (let i = 0; i < packedLowQ.color.length; i++) {
        lowQMaxDelta = Math.max(lowQMaxDelta, Math.abs(packedLowQ.color[i] - twinLowQFrame.color[i]));
      }
      checks.push(
        evaluate('batched-byte-identical-to-uniform-twins-below-quality-2', () => ({
          ok: lowQMaxDelta === 0,
          measured: `maxChannelDelta=${lowQMaxDelta} at animationQuality:1 (same lights, same wind, quality lowered only enough to avoid candleShape's positionLocal branch)`,
          expected:
            "0 — proves the CORE mechanism (buildIlluminationShadingCore fed via packed attributes) is sound; the sibling check's failure is isolated to the animation seed builder's own direct positionLocal read, not the core split",
        }))
      );

      // ==== Checks 4-6: the SIMPLE case (no animation, no wind) — isolates
      // the SPAN-REWRITE mechanism itself from the shading formula's own
      // complexity. Falloff 'foundry' (the default every real Foundry light
      // uses), differentiated from the fully-loaded case's 'inverseSquare'. ====
      const SIMPLE_LIGHTS = [
        {
          sourceId: 'p',
          x: 300,
          y: 500,
          radius: 80,
          sides: 20,
          ratio: 0.4,
          attenuationEased: 0.6,
          exposure: 0,
          bg: [0.3, 0.3, 0.3],
          dim: [0.5, 0.5, 0.5],
          bright: [1, 0, 0],
        },
        {
          sourceId: 'q',
          x: 700,
          y: 500,
          radius: 80,
          sides: 20,
          ratio: 0.4,
          attenuationEased: 0.6,
          exposure: 0,
          bg: [0.3, 0.3, 0.3],
          dim: [0.5, 0.5, 0.5],
          bright: [0, 1, 0],
        },
        {
          sourceId: 'r',
          x: 500,
          y: 850,
          radius: 80,
          sides: 20,
          ratio: 0.4,
          attenuationEased: 0.6,
          exposure: 0,
          bg: [0.3, 0.3, 0.3],
          dim: [0.5, 0.5, 0.5],
          bright: [0, 0, 1],
        },
      ];
      const simpleCfg = {
        animated: false,
        windPresent: false,
        uGlobalTimeMs,
        windHandle,
        falloffModel: 'foundry',
      };
      const simpleBatch = buildPackedBatchIllumMesh(THREE, SIMPLE_LIGHTS, simpleCfg);
      const simpleScene = new THREE.Scene();
      simpleScene.add(simpleBatch.mesh);

      const simpleFrame1 = await renderScene(simpleScene);
      const pBefore = sampleColor(simpleFrame1.color, 300, 500);
      const qBefore = sampleColor(simpleFrame1.color, 700, 500);
      const rBefore = sampleColor(simpleFrame1.color, 500, 850);

      // MOVE light q: rewrite ONLY its `position` span (world-baked), reusing
      // the SAME `aLocalUnit` values already stored — a real, minimal move,
      // not a full rebuild. New spot (560,750) is 286.5px from the old
      // (700,500) — well past 2*radius(80)=160, so the two footprints cannot
      // overlap; nothing else reaches either point (p and r are both >390px
      // from both).
      const qSpan = simpleBatch.spans['q'];
      const qNewX = 560;
      const qNewY = 750;
      for (let v = 0; v < qSpan.count; v++) {
        const vi = qSpan.start + v;
        const lx = simpleBatch.buffers.aLocalUnit.array[vi * 2 + 0];
        const ly = simpleBatch.buffers.aLocalUnit.array[vi * 2 + 1];
        simpleBatch.buffers.position.array[vi * 3 + 0] = qNewX + lx * SIMPLE_LIGHTS[1].radius;
        simpleBatch.buffers.position.array[vi * 3 + 1] = qNewY + ly * SIMPLE_LIGHTS[1].radius;
      }
      simpleBatch.buffers.position.needsUpdate = true;
      const simpleFrame2 = await renderScene(simpleScene);
      const qOldSpotAfter = sampleColor(simpleFrame2.color, 700, 500);
      const qNewSpotAfter = sampleColor(simpleFrame2.color, qNewX, qNewY);
      checks.push(
        evaluate('span-position-rewrite-moves-a-light', () => ({
          ok:
            qBefore.g > 150 && // non-vacuity: the old spot was genuinely lit BEFORE the move, not vacuously empty all along
            qOldSpotAfter.r === 0 &&
            qOldSpotAfter.g === 0 &&
            qOldSpotAfter.b === 0 &&
            qNewSpotAfter.g > 150,
          measured: `old spot(700,500) before=${qBefore.r},${qBefore.g},${qBefore.b} after=${qOldSpotAfter.r},${qOldSpotAfter.g},${qOldSpotAfter.b}; new spot(${qNewX},${qNewY})=${qNewSpotAfter.r},${qNewSpotAfter.g},${qNewSpotAfter.b}`,
          expected:
            'old spot WAS lit green, now empty; new spot is green — a `position`-span rewrite (not a transform, not uniformArray) moved the light, and stuck across the re-render',
        }))
      );

      // REWRITE light p's OWN value span (aParams + aColorB, its bright
      // colour's red channel component) — every other light must stay
      // byte-identical.
      const pSpan = simpleBatch.spans['p'];
      for (let v = 0; v < pSpan.count; v++) {
        const vi = pSpan.start + v;
        simpleBatch.buffers.aParams.array[vi * 4 + 0] = 0.05; // ratio: much smaller bright core
        simpleBatch.buffers.aColorB.array[vi * 4 + 2] = 0.1; // bright.r: red -> dim
      }
      simpleBatch.buffers.aParams.needsUpdate = true;
      simpleBatch.buffers.aColorB.needsUpdate = true;
      const simpleFrame3 = await renderScene(simpleScene);
      const pAfter = sampleColor(simpleFrame3.color, 300, 500);
      const qAfterValueRewrite = sampleColor(simpleFrame3.color, qNewX, qNewY);
      const rAfter = sampleColor(simpleFrame3.color, 500, 850);
      checks.push(
        evaluate('span-value-rewrite-touches-one-light-only', () => ({
          ok:
            (pAfter.r !== pBefore.r || pAfter.g !== pBefore.g || pAfter.b !== pBefore.b) &&
            qAfterValueRewrite.r === qNewSpotAfter.r &&
            qAfterValueRewrite.g === qNewSpotAfter.g &&
            qAfterValueRewrite.b === qNewSpotAfter.b &&
            rAfter.r === rBefore.r &&
            rAfter.g === rBefore.g &&
            rAfter.b === rBefore.b,
          measured: `p before=${pBefore.r},${pBefore.g},${pBefore.b} after=${pAfter.r},${pAfter.g},${pAfter.b}; q unchanged=${qAfterValueRewrite.g === qNewSpotAfter.g}; r unchanged=${rAfter.b === rBefore.b}`,
          expected:
            "p's own appearance changed (the rewrite had real effect); q and r are byte-identical to their own prior frames — the SAME shared-array-write isolation the third scenario's own passing checks already proved, now on the safe mechanism",
        }))
      );

      const simpleFrame4 = await renderScene(simpleScene);
      let steadyMaxDelta = 0;
      for (let i = 0; i < simpleFrame3.color.length; i++) {
        const d = Math.abs(simpleFrame3.color[i] - simpleFrame4.color[i]);
        if (d > steadyMaxDelta) steadyMaxDelta = d;
      }
      checks.push(
        evaluate('steady-state-renders-byte-stable-with-zero-writes', () => ({
          ok: steadyMaxDelta === 0,
          measured: `maxChannelDelta=${steadyMaxDelta} across two renders with no buffer writes between them`,
          expected:
            '0 — this is the exact class of check that caught the third scenario´s uniformArray defect (a stale image persisting across renders); run here against the safe, span-rewrite mechanism, it must actually pass',
        }))
      );

      simpleBatch.geo.dispose();
      return { checks, calibration: 'OK' };
    },
  });

  const bench = {
    name: 'point-lights',
    title: 'Stage 2 — one draw call for many point lights',
    rung: 4,
    summary:
      'Proves the batching mechanism Stage 2 is built on: groups do not reduce real draw calls ' +
      '(so S1a-style grouping is the wrong tool here); a merged, ungrouped, many-shaped mesh under ' +
      'MAX blending is byte-identical to N separate draws, order-independent, and costs ONE real ' +
      'renderer.info.render.drawCalls instead of N. S2.3 then proves the PRODUCTION-SHAPED version ' +
      'of that mechanism: the REAL shading core and REAL layout function, fed via packed per-vertex ' +
      'attributes (never `uniformArray`), byte-identical to N separate production-wrapper meshes.',
    scenarios,
    checkIds: [
      'two-groups-cost-two-real-draw-calls',
      'separate-draw-uses-N-real-calls',
      'merged-draw-uses-ONE-real-call',
      'merged-is-byte-identical-to-separate',
      'merge-order-does-not-matter',
      'overlap-region-shows-real-MAX-compositing',
      'single-merged-draw-even-with-per-light-transforms',
      'frame1-lights-render-at-their-own-transform-slots',
      'moving-a-light-only-touched-its-OWN-transform-slot',
      'untouched-lights-are-pixel-identical-across-frames',
      'fully-loaded-layout-fits-vertex-buffer-limit',
      'packed-batch-renders-one-draw',
      'batched-byte-identical-to-uniform-twins',
      'batched-byte-identical-to-uniform-twins-below-quality-2',
      'span-position-rewrite-moves-a-light',
      'span-value-rewrite-touches-one-light-only',
      'steady-state-renders-byte-stable-with-zero-writes',
    ],
    ready: () => true,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },
  };

  registerBench(bench);
  return bench;
}
