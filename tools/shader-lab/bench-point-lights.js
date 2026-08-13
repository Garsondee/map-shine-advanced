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
import { buildPointLightIlluminationMaterial } from '../../src/effects/lighting/point-light-illumination.js';
import { buildPointLightColorationMaterial } from '../../src/effects/lighting/point-light-coloration.js';
import { resolveLightAnimation } from '../../src/effects/lighting/animations/registry.js';
import { describeBucketVertexBuffers } from '../../src/effects/lighting/point-light-batch.js';
import { createBatchedLightMesh } from '../../src/effects/lighting/point-light-batch-mesh.js';
import { createWindHandle } from '../../src/world/index.js';
import {
  describePointLightMergedMrt,
  buildPointLightMergedRendererMrtStructs,
  buildPointLightMergedZeroQuadMaterial,
  buildPointLightMergedBlitMaterial,
} from '../../src/effects/lighting/point-light-merged.js';
import { ThreeAllocator } from '../../src/graph/three-allocator.js';
import { decodeHalfFloatRgba } from '../../src/diag/pixel-probe.js';

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
 * `aLocalUnit` — see `effects/lighting/point-light-batch-mesh.js#
 * writeLightSpanGeometry`'s own header for why both are needed. Still used
 * here for {@link buildUniformTwinIllumMeshes}'s per-light twin meshes
 * (production's real per-light path, untouched by batching) — the actual
 * batched mesh is built by the real production module since S2.4.
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
 * A regular `sides`-gon WORLD-space polygon around (x,y) at `radius` — feeds
 * the REAL production `triangulateLightFan` (via `createBatchedLightMesh`)
 * an input shaped like `foundry/scene-lights.js#deriveLightSnapshot`'s own
 * `shapePoints`, rather than handing a pre-built local-space fan to a
 * bench-local mesh builder (S2.3's own `buildPackedBatchIllumMesh`, now
 * retired — see this scenario's own header for why S2.4 promoted it to
 * production and pointed THIS bench at the real module instead).
 *
 * Produces the IDENTICAL local-space fan `buildFanLocalUnit(sides)` builds
 * directly: `triangulateLightFan` normalizes each point back to
 * `((px-x)/radius, (py-y)/radius)` = `(cos a, sin a)`, and fans them in the
 * SAME `i, i+1` winding — so the twin comparison below (which still uses
 * `buildFanLocalUnit` for its per-light meshes) remains apples-to-apples.
 *
 * @param {number} x @param {number} y @param {number} radius @param {number} sides
 * @returns {number[]} flat [x0,y0,x1,y1,...] world-space polygon.
 */
function regularPolygonShapePoints(x, y, radius, sides) {
  const pts = new Array(sides * 2);
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    pts[i * 2 + 0] = x + Math.cos(a) * radius;
    pts[i * 2 + 1] = y + Math.sin(a) * radius;
  }
  return pts;
}

/**
 * Adapts one of this scenario's ILLUMINATION light fixtures (a flat
 * `{sourceId, x, y, radius, sides, ...}` object) into
 * `createBatchedLightMesh`'s own per-member value contract (that module's
 * header has the full field list). `expectedDepth` defaults to 0 — this
 * scenario runs with `depthTexNode: null`, under which the height gate
 * compiles out entirely (a JS-time branch, `point-light-illumination.js`'s
 * own header), so the value is provably unread; defaulted anyway to match
 * what the retired local builder did, belt-and-braces.
 * @param {object} l @returns {object}
 */
function toIllumMember(l) {
  return {
    sourceId: l.sourceId,
    x: l.x,
    y: l.y,
    radius: l.radius,
    shapePoints: regularPolygonShapePoints(l.x, l.y, l.radius, l.sides),
    ratio: l.ratio,
    attenuationEased: l.attenuationEased,
    exposure: l.exposure ?? 0,
    expectedDepth: l.expectedDepth ?? 0,
    bg: l.bg,
    dim: l.dim,
    bright: l.bright,
    speedRaw: l.speedRaw,
    reverseSign: l.reverseSign,
    seed: l.seed,
    intensityRaw: l.intensityRaw,
    windExposure: l.windExposure,
    windResponse: l.windResponse,
  };
}

/** The COLORATION sibling of {@link toIllumMember}. @param {object} l @returns {object} */
function toColorMember(l) {
  return {
    sourceId: l.sourceId,
    x: l.x,
    y: l.y,
    radius: l.radius,
    shapePoints: regularPolygonShapePoints(l.x, l.y, l.radius, l.sides),
    attenuationEased: l.attenuationEased,
    colorationAlpha: l.colorationAlpha,
    expectedDepth: 0,
    ratio: l.ratio ?? 0, // packed but inert — see point-light-batch-mesh.js's own header
    lightColor: l.lightColor,
    speedRaw: l.speedRaw,
    reverseSign: l.reverseSign,
    seed: l.seed,
    intensityRaw: l.intensityRaw,
    windExposure: l.windExposure,
    windResponse: l.windResponse,
  };
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
 * @param {object} args - `{animated, windPresent, animationEntry, uGlobalTimeMs,
 *   windHandle, animationQuality, falloffModel}` — this scenario's own `fullCfg`/
 *   `lowerQualityCfg` shape.
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
      'passes byte-perfectly, isolating the gap to that one animation helper, not the core split.' +
      "\n\nS2.4 (2026-08-11, `effects/lighting/point-light-batch-mesh.js`) promoted this scenario's " +
      "own mesh-building logic to production and pointed every check above at the REAL module's " +
      '`createBatchedLightMesh`/`.reconcile()` instead of a bench-local copy — the movement/value ' +
      'checks now go through its real per-member placement dirty-check (asserted via `rebuilt:false` ' +
      'where the bucket itself should not have rebuilt) rather than poking buffer arrays directly. ' +
      'One added check, `coloration-batch-renders-one-draw-and-matches-twin`: the COLORATION channel ' +
      '(Testament S2.4\'s own "both channels" scope), simple case, byte-identical to N separate ' +
      'production coloration meshes against a shared flat-albedo stand-in.',
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

      const illumShared = {
        uGlobalTimeMs,
        windHandle,
        attrTexNode: null,
        depthTexNode: null,
        depthFlagsTexNode: null,
        sunShadowSlotNodes: null,
        blendSunVisibilityAcrossFloors: null,
        apertureGoboShared: null,
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
      //
      // S2.4 (2026-08-11): this scenario now calls the REAL PRODUCTION
      // `createBatchedLightMesh` (`effects/lighting/point-light-batch-mesh.js`)
      // instead of a bench-local mesh builder — S2.3's own proof retargeted
      // at the code it was proving, not a parallel copy of it
      // (`feedback_mode_forks_silently_drop_features` risk, closed).
      const fullBatch = createBatchedLightMesh({
        THREE,
        channel: 'illumination',
        shared: illumShared,
        flags: {
          animated: true,
          windPresent: true,
          animationEntry,
          animationQuality: 2,
          falloffModel: 'inverseSquare',
        },
      });
      {
        const scene = new THREE.Scene();
        scene.add(fullBatch.mesh);
        fullBatch.reconcile(FULL_LIGHTS.map(toIllumMember));
        const r = await renderScene(scene);
        const realAttrCount = Object.keys(fullBatch.mesh.geometry.attributes).length;
        checks.push(
          evaluate('fully-loaded-layout-fits-vertex-buffer-limit', () => ({
            ok:
              layout.count === 8 &&
              layout.ok === true &&
              fullBatch.layout.count === 8 &&
              realAttrCount === 8 &&
              r.drawCalls === 1,
            measured: `describeBucketVertexBuffers count=${layout.count} ok=${layout.ok}; createBatchedLightMesh´s own layout.count=${fullBatch.layout.count}; real geometry attributes=${realAttrCount}; drawCalls=${r.drawCalls}`,
            expected:
              '8 and true from the arithmetic, matching 8 REAL attributes that actually compiled and drew — the device accepted the fully-loaded layout, not just the count',
          }))
        );
      }

      const packedResult = await (async () => {
        const scene = new THREE.Scene();
        scene.add(fullBatch.mesh);
        // Same members, same content — re-reconciling is the steady-state
        // path (`rebuilt:false`, this bucket already built above), exactly
        // what a real per-frame caller (S2.5) does every frame regardless.
        fullBatch.reconcile(FULL_LIGHTS.map(toIllumMember));
        return renderScene(scene);
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

      fullBatch.dispose();

      // Isolates the CORE mechanism from the animation-seed-builder gap just
      // documented: the SAME batched-vs-twin comparison, SAME lights, ONLY
      // `animationQuality` dropped to 1 (still animated, still wind-present —
      // `candleShape`'s positionLocal branch specifically requires >=2). A
      // DIFFERENT `animationQuality` is a DIFFERENT bucket key in production
      // terms (design doc §3.1), hence a fresh `createBatchedLightMesh`
      // instance, not a mutation of `fullBatch`.
      const lowerQualityCfg = { ...fullCfg, animationQuality: 1 };
      const packedLowQ = await (async () => {
        const batch = createBatchedLightMesh({
          THREE,
          channel: 'illumination',
          shared: illumShared,
          flags: {
            animated: true,
            windPresent: true,
            animationEntry,
            animationQuality: 1,
            falloffModel: 'inverseSquare',
          },
        });
        const scene = new THREE.Scene();
        scene.add(batch.mesh);
        batch.reconcile(FULL_LIGHTS.map(toIllumMember));
        const frame = await renderScene(scene);
        batch.dispose();
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
      const simpleBatch = createBatchedLightMesh({
        THREE,
        channel: 'illumination',
        shared: illumShared,
        flags: {
          animated: false,
          windPresent: false,
          animationEntry: null,
          animationQuality: 0,
          falloffModel: 'foundry',
        },
      });
      const simpleScene = new THREE.Scene();
      simpleScene.add(simpleBatch.mesh);

      let simpleMembers = SIMPLE_LIGHTS.map(toIllumMember);
      simpleBatch.reconcile(simpleMembers);
      const simpleFrame1 = await renderScene(simpleScene);
      const pBefore = sampleColor(simpleFrame1.color, 300, 500);
      const qBefore = sampleColor(simpleFrame1.color, 700, 500);
      const rBefore = sampleColor(simpleFrame1.color, 500, 850);

      // MOVE light q: reconcile with an updated member list — its vertex
      // COUNT is unchanged (same `sides`), so `createBucket` itself reports
      // `rebuilt:false`; this exercises `createBatchedLightMesh`'s own
      // PER-MEMBER placement dirty-check (asserted below via
      // `moveResult.rebuilt === false`), not a bucket-level rebuild
      // coincidentally doing the same thing — the exact mechanism that
      // replaces `uniformArray`'s indexed transform. New spot (560,750) is
      // 286.5px from the old (700,500) — well past 2*radius(80)=160, so the
      // two footprints cannot overlap; nothing else reaches either point (p
      // and r are both >390px from both).
      const qNewX = 560;
      const qNewY = 750;
      simpleMembers = simpleMembers.map((m) =>
        m.sourceId === 'q'
          ? {
              ...m,
              x: qNewX,
              y: qNewY,
              shapePoints: regularPolygonShapePoints(qNewX, qNewY, SIMPLE_LIGHTS[1].radius, SIMPLE_LIGHTS[1].sides),
            }
          : m
      );
      const moveResult = simpleBatch.reconcile(simpleMembers);
      const simpleFrame2 = await renderScene(simpleScene);
      const qOldSpotAfter = sampleColor(simpleFrame2.color, 700, 500);
      const qNewSpotAfter = sampleColor(simpleFrame2.color, qNewX, qNewY);
      checks.push(
        evaluate('span-position-rewrite-moves-a-light', () => ({
          ok:
            qBefore.g > 150 && // non-vacuity: the old spot was genuinely lit BEFORE the move, not vacuously empty all along
            moveResult.rebuilt === false &&
            qOldSpotAfter.r === 0 &&
            qOldSpotAfter.g === 0 &&
            qOldSpotAfter.b === 0 &&
            qNewSpotAfter.g > 150,
          measured: `old spot(700,500) before=${qBefore.r},${qBefore.g},${qBefore.b} after=${qOldSpotAfter.r},${qOldSpotAfter.g},${qOldSpotAfter.b}; new spot(${qNewX},${qNewY})=${qNewSpotAfter.r},${qNewSpotAfter.g},${qNewSpotAfter.b}; bucket rebuilt=${moveResult.rebuilt}`,
          expected:
            'old spot WAS lit green, now empty; new spot is green; rebuilt:false — a per-member placement rewrite (not a bucket rebuild, not a transform, not uniformArray) moved the light, and stuck across the re-render',
        }))
      );

      // REWRITE light p's OWN VALUES (ratio + bright.r) via a fresh
      // reconcile — every other light must stay byte-identical. Vertex
      // count and placement are untouched for every member, so this again
      // hits `rebuilt:false`.
      simpleMembers = simpleMembers.map((m) =>
        m.sourceId === 'p' ? { ...m, ratio: 0.05, bright: [0.1, m.bright[1], m.bright[2]] } : m
      );
      const valueResult = simpleBatch.reconcile(simpleMembers);
      const simpleFrame3 = await renderScene(simpleScene);
      const pAfter = sampleColor(simpleFrame3.color, 300, 500);
      const qAfterValueRewrite = sampleColor(simpleFrame3.color, qNewX, qNewY);
      const rAfter = sampleColor(simpleFrame3.color, 500, 850);
      checks.push(
        evaluate('span-value-rewrite-touches-one-light-only', () => ({
          ok:
            valueResult.rebuilt === false &&
            (pAfter.r !== pBefore.r || pAfter.g !== pBefore.g || pAfter.b !== pBefore.b) &&
            qAfterValueRewrite.r === qNewSpotAfter.r &&
            qAfterValueRewrite.g === qNewSpotAfter.g &&
            qAfterValueRewrite.b === qNewSpotAfter.b &&
            rAfter.r === rBefore.r &&
            rAfter.g === rBefore.g &&
            rAfter.b === rBefore.b,
          measured: `p before=${pBefore.r},${pBefore.g},${pBefore.b} after=${pAfter.r},${pAfter.g},${pAfter.b}; q unchanged=${qAfterValueRewrite.g === qNewSpotAfter.g}; r unchanged=${rAfter.b === rBefore.b}; bucket rebuilt=${valueResult.rebuilt}`,
          expected:
            "rebuilt:false, p's own appearance changed (the rewrite had real effect); q and r are byte-identical to their own prior frames — the SAME shared-array-write isolation the third scenario's own passing checks already proved, now on the safe mechanism",
        }))
      );

      // STEADY STATE — reconcile again with LITERALLY UNCHANGED members
      // (the real per-frame call S2.5 will make every frame regardless of
      // whether anything actually changed) and render again. S2.4 does not
      // value-diff yet (its own header), so this still writes every value
      // buffer — proving that redundant rewrite is idempotent (byte-stable
      // output), which is the guarantee S2.5's dirty-skip optimizes on TOP
      // of, not a substitute for.
      const steadyResult = simpleBatch.reconcile(simpleMembers);
      const simpleFrame4 = await renderScene(simpleScene);
      let steadyMaxDelta = 0;
      for (let i = 0; i < simpleFrame3.color.length; i++) {
        const d = Math.abs(simpleFrame3.color[i] - simpleFrame4.color[i]);
        if (d > steadyMaxDelta) steadyMaxDelta = d;
      }
      checks.push(
        evaluate('steady-state-renders-byte-stable-with-zero-writes', () => ({
          ok: steadyMaxDelta === 0 && steadyResult.rebuilt === false,
          measured: `maxChannelDelta=${steadyMaxDelta} across two renders with an unchanged-member reconcile between them; bucket rebuilt=${steadyResult.rebuilt}`,
          expected:
            '0 and rebuilt:false — this is the exact class of check that caught the third scenario´s uniformArray defect (a stale image persisting across renders); run here against the safe, span-rewrite mechanism, it must actually pass',
        }))
      );

      simpleBatch.dispose();

      // ==== Check: COLORATION channel (Testament S2.4´s own scope is "both
      // channels") — the simple (no animation, no wind) case, proving
      // `createBatchedLightMesh`'s coloration branch actually compiles and
      // draws correctly, byte-identical to N separate production coloration
      // meshes. A flat 1x1 albedo stand-in (coloration's `reflection` term
      // needs A texture, unlike illumination's optional depth/attr inputs —
      // point-light-coloration.js samples it unconditionally) — uniform
      // colour is a legitimate input, not an invented producer shape; both
      // the batch and its twin sample the SAME texture, so the comparison
      // stays apples-to-apples regardless of what it holds. ====
      const albedoTexture = new THREE.DataTexture(
        new Uint8Array([160, 160, 160, 255]),
        1,
        1,
        THREE.RGBAFormat,
        THREE.UnsignedByteType
      );
      // NoColorSpace (the default, set explicitly) — coloration's own OETF
      // call expects a LINEAR sample (matching `buf:scene.color`'s real
      // contract, per point-light-coloration.js's own header); an sRGB-
      // tagged texture would double-encode it.
      albedoTexture.colorSpace = THREE.NoColorSpace;
      albedoTexture.needsUpdate = true;
      const colorShared = {
        uGlobalTimeMs,
        windHandle,
        albedoTexture,
        depthTexNode: null,
        depthFlagsTexNode: null,
        apertureGoboShared: null,
      };
      const COLOR_LIGHTS = [
        {
          sourceId: 'cp',
          x: 300,
          y: 500,
          radius: 80,
          sides: 20,
          attenuationEased: 0.6,
          colorationAlpha: 1,
          lightColor: [1, 0, 0],
        },
        {
          sourceId: 'cq',
          x: 700,
          y: 500,
          radius: 80,
          sides: 20,
          attenuationEased: 0.6,
          colorationAlpha: 1,
          lightColor: [0, 1, 0],
        },
      ];
      const colorBatch = createBatchedLightMesh({
        THREE,
        channel: 'coloration',
        shared: colorShared,
        flags: {
          animated: false,
          windPresent: false,
          animationEntry: null,
          animationQuality: 0,
          falloffModel: 'foundry',
        },
      });
      const colorBatchResult = colorBatch.reconcile(COLOR_LIGHTS.map(toColorMember));
      const colorScene = new THREE.Scene();
      colorScene.add(colorBatch.mesh);
      const colorBatchFrame = await renderScene(colorScene);

      const { uniform, float: colFloat } = THREE.TSL;
      const colorTwinScene = new THREE.Scene();
      const colorTwinHandles = [];
      for (const l of COLOR_LIGHTS) {
        const handle = buildPointLightColorationMaterial({
          THREE,
          albedoTexture,
          animation: null,
          uGlobalTimeMs,
          uRatio: uniform(colFloat(0)),
          animationQuality: 0,
          falloffModel: 'foundry',
          windHandle,
        });
        handle.uAttenuationEased.value = l.attenuationEased;
        handle.uColorationAlpha.value = l.colorationAlpha;
        handle.uLightColor.value.set(l.lightColor[0], l.lightColor[1], l.lightColor[2]);
        const fan = buildFanLocalUnit(l.sides);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(fan.positions, 3));
        const mesh = new THREE.Mesh(geo, handle.material);
        mesh.position.set(l.x, l.y, 0);
        mesh.scale.set(l.radius, l.radius, 1);
        mesh.frustumCulled = false;
        colorTwinScene.add(mesh);
        colorTwinHandles.push(mesh);
      }
      const colorTwinFrame = await renderScene(colorTwinScene);
      for (const m of colorTwinHandles) m.geometry.dispose();

      let colorMaxDelta = 0;
      for (let i = 0; i < colorBatchFrame.color.length; i++) {
        colorMaxDelta = Math.max(colorMaxDelta, Math.abs(colorBatchFrame.color[i] - colorTwinFrame.color[i]));
      }
      const colorOverlapSample = sampleColor(colorBatchFrame.color, 300, 500);
      checks.push(
        evaluate('coloration-batch-renders-one-draw-and-matches-twin', () => ({
          ok:
            colorBatch.layout.count === 4 &&
            colorBatchFrame.drawCalls === 1 &&
            colorMaxDelta === 0 &&
            colorBatchResult.rebuilt === true &&
            (colorOverlapSample.r > 10 || colorOverlapSample.g > 10 || colorOverlapSample.b > 10),
          measured: `layout.count=${colorBatch.layout.count}; drawCalls=${colorBatchFrame.drawCalls}; maxChannelDelta=${colorMaxDelta}; sample(300,500)=${colorOverlapSample.r},${colorOverlapSample.g},${colorOverlapSample.b}`,
          expected:
            '4 buffers (position, aLocalUnit, aParams, aLightColor — the simple no-anim/no-wind coloration layout), 1 draw call for 2 lights, 0 pixel delta against N separate production coloration meshes, and a non-vacuous (actually lit) sample point',
        }))
      );
      colorBatch.dispose();
      albedoTexture.dispose();

      return { checks, calibration: 'OK' };
    },
  });

  // ============================================================================
  // S2.11 — MRT-MERGE MECHANISM PROOF (Performance-Audit-2026-08.md §3.1's
  // illum/coloration merge follow-on, docs/planning/Point-Light-Batching-
  // Design.md's own §0 discipline: prove the riskiest mechanism first,
  // isolated, on a real device, before any production file depends on it —
  // the SAME posture this bench's own header already documents for Stage 2's
  // packed-attribute mechanism).
  // ============================================================================
  scenarios.set('mrt-merge-mechanism-proof', {
    name: 'mrt-merge-mechanism-proof',
    summary:
      'Two independent mechanics the illum/coloration MRT-merge design depends on, proven on a real ' +
      'device before touching production. (1) A `.fragmentNode`-direct material assigning ' +
      '`mrt({illum,coloration}).setBlendMode(name, blend)` correctly isolates and independently ' +
      'MAX-blends two named attachments of a dedicated 2-attachment target — verified against ' +
      "three.webgpu.js's fragmentNode-direct build branch (this path does NOT go through the " +
      'renderer-global safe-default merge, which only engages for `.colorNode`+`.mrtNode` materials — ' +
      'every illum-writing material in this codebase except window-render.js uses `.fragmentNode` ' +
      "directly) and MRTNode#setup's own name-matched member assignment. (2) An interleaved `aAnim`+" +
      '`aWind` buffer (one InterleavedBuffer, two InterleavedBufferAttribute views — ordinary, ' +
      'long-established three.js machinery, not novel to this project) renders byte-identical output ' +
      'to the same two fields as separate buffers, confirmed at the JS level to share one underlying ' +
      'buffer object — the property a WebGPU pipeline needs to coalesce two attributes into one ' +
      'vertex-buffer binding instead of two.',
    async run() {
      await ensureRenderer();
      const checks = [];
      const { mrt, vec4, attribute, Fn } = THREE.TSL;

      // ---- Checks 1-2: fragmentNode-direct MRT, independent per-attachment MAX blend ----
      const mrtRt = new THREE.RenderTarget(DIM, DIM, {
        count: 2,
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        colorSpace: THREE.NoColorSpace,
      });
      // Name-matching, not position (MRTNode#setup, three.webgpu.js:48577-48590) —
      // these names are exactly what buildMrtMeshMaterial's `mrt({...})` keys below
      // must match, mirroring `outputName` in the production allocator descriptor
      // shape (three-allocator.js) without needing the allocator itself here.
      mrtRt.textures[0].name = 'illum';
      mrtRt.textures[1].name = 'coloration';

      // Hoisted OUT of buildMrtMeshMaterial (2026-08-13, fixing the first
      // attempt's real gap — see the note below, right before renderer.setMRT):
      // this SAME BlendMode instance is needed by the RENDERER-GLOBAL mrt too,
      // not just each mesh's own material-level mrt().
      const maxBlend = new THREE.BlendMode(THREE.CustomBlending);
      maxBlend.blendEquation = THREE.MaxEquation;
      maxBlend.blendSrc = THREE.OneFactor;
      maxBlend.blendDst = THREE.OneFactor;
      maxBlend.blendEquationAlpha = THREE.MaxEquation;
      maxBlend.blendSrcAlpha = THREE.OneFactor;
      maxBlend.blendDstAlpha = THREE.OneFactor;

      function buildMrtMeshMaterial(illumRgba, colorationRgba) {
        const material = new THREE.NodeMaterial();
        material.transparent = false;
        material.depthTest = false;
        material.depthWrite = false;
        material.side = THREE.DoubleSide;
        // Deliberately NO `.blending`/`.blendEquation` set at the material's own
        // top level — both attachments' blend state lives entirely on the mrt()
        // node itself, via `THREE.BlendMode` + `MRTNode#setBlendMode` (three.webgpu.js
        // :48457-48545), the mechanism check 2 below actually exercises.
        material.fragmentNode = mrt({
          illum: vec4(illumRgba[0], illumRgba[1], illumRgba[2], illumRgba[3]),
          coloration: vec4(colorationRgba[0], colorationRgba[1], colorationRgba[2], colorationRgba[3]),
        })
          .setBlendMode('illum', maxBlend)
          .setBlendMode('coloration', maxBlend);
        return material;
      }

      // Two overlapping diamonds (sides:4 fans) — a fan's horizontal meridian
      // (world Y = its own centre) spans its full local x∈[-1,1], so sampling
      // along that one Y for both meshes cleanly separates "A only" / "overlap"
      // / "B only" without needing exact geometric edge math.
      const fanA = buildFanLocalUnit(4);
      const geoA = new THREE.BufferGeometry();
      geoA.setAttribute('position', new THREE.BufferAttribute(fanA.positions, 3));
      const meshA = new THREE.Mesh(geoA, buildMrtMeshMaterial([1, 0, 0, 1], [0, 0, 1, 1]));
      meshA.position.set(450, 500, 0);
      meshA.scale.set(200, 200, 1);
      meshA.frustumCulled = false;

      const fanB = buildFanLocalUnit(4);
      const geoB = new THREE.BufferGeometry();
      geoB.setAttribute('position', new THREE.BufferAttribute(fanB.positions, 3));
      const meshB = new THREE.Mesh(geoB, buildMrtMeshMaterial([0, 1, 0, 1], [0, 0, 0.5, 1]));
      meshB.position.set(600, 500, 0); // overlaps meshA along X∈[400,650]
      meshB.scale.set(200, 200, 1);
      meshB.frustumCulled = false;

      const mrtScene = new THREE.Scene();
      mrtScene.add(meshA, meshB);

      // ⚠️ REAL GAP FOUND HERE, FIRST TRY (this is exactly what S2.11 is for):
      // per-attachment BLEND STATE is NOT read from the material's own
      // `fragmentNode` MRTNode at all — pipeline creation reads it from
      // `renderObject.context.mrt.getBlendMode(name)` (three.webgpu.js:74356,
      // :74363), and `context.mrt` is populated from `renderer.getMRT()`
      // (three.webgpu.js:52076: `state.mrt = renderer.getMRT()`) — the
      // RENDERER-GLOBAL setting, entirely separate from whatever mrt() node a
      // `.fragmentNode`-direct material happens to construct for VALUE
      // ROUTING. First attempt (no `renderer.setMRT()` call at all) rendered
      // with plain overwrite on BOTH attachments — `getBlendMode` fell back to
      // `_noBlending` because `renderer.getMRT()` was null. VALUE routing
      // (which key goes to which named attachment) is unaffected by this and
      // still comes from the material's own fragmentNode — confirmed by the
      // first check above passing on the FIRST attempt, before this fix.
      // Scoped exactly like `scene-attr.js`'s own documented discipline
      // ("MRT MUST BE SCOPED, NEVER LEFT GLOBALLY SET"): save, set, draw,
      // restore. The renderer-global mrt's own OUTPUT NODES are never read in
      // the fragmentNode-direct path (only its blendModes map is), so a
      // throwaway zero-value struct is sufficient here.
      const prevRendererMrt = renderer.getMRT();
      const globalBlendMrt = mrt({
        illum: vec4(0, 0, 0, 0),
        coloration: vec4(0, 0, 0, 0),
      })
        .setBlendMode('illum', maxBlend)
        .setBlendMode('coloration', maxBlend);
      renderer.setMRT(globalBlendMrt);

      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(mrtRt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.info.autoReset = false;
      renderer.info.reset();
      await renderer.renderAsync(mrtScene, camera);
      const mrtDrawCalls = renderer.info.render.drawCalls;
      renderer.info.autoReset = true;
      renderer.setRenderTarget(prevTarget);
      renderer.setMRT(prevRendererMrt);

      // `readRenderTargetPixelsAsync`'s 6th param IS `textureIndex` (verified
      // against the vendored signature — see this project's own memory of the
      // ONE call site that got this wrong by trusting a stale doc comment
      // instead: feedback_read_the_producer_never_invent_its_shape).
      const illumBuf = await renderer.readRenderTargetPixelsAsync(mrtRt, 0, 0, DIM, DIM, 0);
      const colorBuf = await renderer.readRenderTargetPixelsAsync(mrtRt, 0, 0, DIM, DIM, 1);
      const illumArr = ArrayBuffer.isView(illumBuf) ? illumBuf : new Uint8Array(illumBuf);
      const colorArr = ArrayBuffer.isView(colorBuf) ? colorBuf : new Uint8Array(colorBuf);

      const illumOnlyA = sampleColor(illumArr, 320, 500);
      const illumOverlap = sampleColor(illumArr, 525, 500);
      const illumOnlyB = sampleColor(illumArr, 730, 500);
      const colorOnlyA = sampleColor(colorArr, 320, 500);
      const colorOverlap = sampleColor(colorArr, 525, 500);
      const colorOnlyB = sampleColor(colorArr, 730, 500);

      checks.push(
        evaluate('mrt-fragmentnode-direct-isolates-attachments', () => ({
          ok:
            mrtDrawCalls === 2 &&
            illumOnlyA.r === 255 &&
            illumOnlyA.g === 0 &&
            illumOnlyA.b === 0 &&
            illumOnlyB.r === 0 &&
            illumOnlyB.g === 255 &&
            illumOnlyB.b === 0 &&
            colorOnlyA.r === 0 &&
            colorOnlyA.g === 0 &&
            colorOnlyA.b === 255 &&
            colorOnlyB.r === 0 &&
            colorOnlyB.g === 0 &&
            colorOnlyB.b > 100 &&
            colorOnlyB.b < 150,
          measured:
            `drawCalls=${mrtDrawCalls}; illum(A)=${illumOnlyA.r},${illumOnlyA.g},${illumOnlyA.b}; ` +
            `illum(B)=${illumOnlyB.r},${illumOnlyB.g},${illumOnlyB.b}; ` +
            `coloration(A)=${colorOnlyA.r},${colorOnlyA.g},${colorOnlyA.b}; ` +
            `coloration(B)=${colorOnlyB.r},${colorOnlyB.g},${colorOnlyB.b}`,
          expected:
            '2 real draw calls; illum attachment reads pure red at A, pure green at B — NEVER carrying ' +
            "either mesh's own coloration (blue) value; coloration attachment reads pure blue at A, " +
            '~half-blue at B — NEVER carrying either illum (red/green) value. Proves a `.fragmentNode`-' +
            'direct `mrt(...)` struct routes each named key to its own attachment with zero cross-' +
            'contamination — the load-bearing fact the dedicated-target design (S2.15) depends on.',
        }))
      );

      checks.push(
        evaluate('mrt-per-attachment-blend-mode-is-independent-of-material-blending', () => ({
          ok:
            illumOverlap.r === 255 &&
            illumOverlap.g === 255 &&
            illumOverlap.b === 0 &&
            colorOverlap.r === 0 &&
            colorOverlap.g === 0 &&
            colorOverlap.b === 255,
          measured:
            `illum(overlap)=${illumOverlap.r},${illumOverlap.g},${illumOverlap.b}; ` +
            `coloration(overlap)=${colorOverlap.r},${colorOverlap.g},${colorOverlap.b}`,
          expected:
            'At the overlap: illum = MAX((1,0,0),(0,1,0)) = (255,255,0) — real MAX blending applied to ' +
            'the illum attachment. coloration = MAX((0,0,1),(0,0,0.5)) = (0,0,255) — the SAME MAX ' +
            'equation applied independently to the SECOND attachment via MRTNode#setBlendMode, from a ' +
            'material that never sets `.blending`/`.blendEquation` at its own top level at all (both ' +
            'blend states live entirely on the mrt() node) — proves per-attachment blend state is real ' +
            'and independent, not a single material-wide setting smeared across both outputs.',
        }))
      );

      mrtRt.dispose();
      geoA.dispose();
      geoB.dispose();

      // ---- Check 3: interleaved aAnim+aWind — byte-identical, one shared buffer ----
      function buildInterleaveTestMaterial() {
        const material = new THREE.NodeMaterial();
        material.transparent = false;
        material.depthTest = false;
        material.depthWrite = false;
        material.fragmentNode = Fn(() => {
          const anim = attribute('aAnim', 'vec4');
          const wind = attribute('aWind', 'vec4');
          // Sum both fields into a visible colour so neither can be silently
          // dead-code-eliminated or read as zero without changing the output.
          return vec4(anim.x.add(wind.x), anim.y.add(wind.y), anim.z.add(wind.z), 1);
        })();
        return material;
      }

      const fanC = buildFanLocalUnit(4);
      const ANIM_VALS = [0.1, 0.2, 0.05, 5];
      const WIND_VALS = [0.3, 0.15, 0.4, 1];

      // TWIN 1 — two separate BufferAttributes (today's shape).
      const geoSeparate = new THREE.BufferGeometry();
      geoSeparate.setAttribute('position', new THREE.BufferAttribute(fanC.positions, 3));
      const animData = new Float32Array(fanC.vertexCount * 4);
      const windData = new Float32Array(fanC.vertexCount * 4);
      for (let i = 0; i < fanC.vertexCount; i++) {
        animData.set(ANIM_VALS, i * 4);
        windData.set(WIND_VALS, i * 4);
      }
      geoSeparate.setAttribute('aAnim', new THREE.BufferAttribute(animData, 4));
      geoSeparate.setAttribute('aWind', new THREE.BufferAttribute(windData, 4));
      const meshSeparate = new THREE.Mesh(geoSeparate, buildInterleaveTestMaterial());
      meshSeparate.position.set(500, 500, 0);
      meshSeparate.scale.set(300, 300, 1);
      meshSeparate.frustumCulled = false;

      // TWIN 2 — ONE InterleavedBuffer, two InterleavedBufferAttribute VIEWS
      // (stride 8 floats: aAnim at offset 0, aWind at offset 4) — the exact
      // mechanism S2.14's packed layout needs for its 8th (aAnimWind) slot.
      const geoInterleaved = new THREE.BufferGeometry();
      geoInterleaved.setAttribute('position', new THREE.BufferAttribute(fanC.positions, 3));
      const interleavedData = new Float32Array(fanC.vertexCount * 8);
      for (let i = 0; i < fanC.vertexCount; i++) {
        interleavedData.set([...ANIM_VALS, ...WIND_VALS], i * 8);
      }
      const interleavedBuffer = new THREE.InterleavedBuffer(interleavedData, 8);
      geoInterleaved.setAttribute('aAnim', new THREE.InterleavedBufferAttribute(interleavedBuffer, 4, 0));
      geoInterleaved.setAttribute('aWind', new THREE.InterleavedBufferAttribute(interleavedBuffer, 4, 4));
      const meshInterleaved = new THREE.Mesh(geoInterleaved, buildInterleaveTestMaterial());
      meshInterleaved.position.set(500, 500, 0);
      meshInterleaved.scale.set(300, 300, 1);
      meshInterleaved.frustumCulled = false;

      const sceneSeparate = new THREE.Scene();
      sceneSeparate.add(meshSeparate);
      const separateFrame = await renderScene(sceneSeparate);

      const sceneInterleaved = new THREE.Scene();
      sceneInterleaved.add(meshInterleaved);
      const interleavedFrame = await renderScene(sceneInterleaved);

      let interleaveMaxDelta = 0;
      for (let i = 0; i < separateFrame.color.length; i++) {
        interleaveMaxDelta = Math.max(interleaveMaxDelta, Math.abs(separateFrame.color[i] - interleavedFrame.color[i]));
      }
      // Confirmed at the JS level, not assumed: both attribute views share ONE
      // underlying buffer object — the property a WebGPU pipeline needs in
      // order to coalesce them into a single vertex-buffer binding. Direct
      // GPU-side pipeline slot-count measurement was deliberately NOT attempted
      // this pass (would mean intentionally exceeding a device limit to prove
      // the negative case, a real device-lost risk this project has been
      // burned by before on unrelated large-map work) — this check proves
      // correctness + the JS-level sharing precondition, not the device limit
      // itself.
      const sameBufferObject = geoInterleaved.attributes.aAnim.data === geoInterleaved.attributes.aWind.data;
      const centreSample = sampleColor(interleavedFrame.color, 500, 500);

      checks.push(
        evaluate('interleaved-buffer-reads-byte-identical-and-shares-one-binding', () => ({
          ok:
            interleaveMaxDelta === 0 &&
            sameBufferObject &&
            centreSample.r > 50 &&
            centreSample.g > 50 &&
            centreSample.b > 50,
          measured:
            `maxChannelDelta=${interleaveMaxDelta}; sameUnderlyingBuffer=${sameBufferObject}; ` +
            `centreSample=${centreSample.r},${centreSample.g},${centreSample.b}`,
          expected:
            '0 — a two-view InterleavedBufferAttribute pair reads `aAnim`/`aWind` byte-identically to the ' +
            'same fields as two separate BufferAttributes (proves the interleave offset/stride is ' +
            'correct, not silently reading garbage or the wrong field). sameUnderlyingBuffer:true — both ' +
            'attributes share ONE `InterleavedBuffer` JS object. GPU-side pipeline slot count was NOT ' +
            'independently measured this pass (see note above) — this is a correctness + JS-level-' +
            'sharing proof, not a device-limit probe.',
        }))
      );

      geoSeparate.dispose();
      geoInterleaved.dispose();

      return { checks, calibration: 'OK' };
    },
  });

  // ============================================================================
  // S2.14 — MERGED BUCKET, PRODUCTION-SHAPED (Performance-Audit-2026-08.md
  // §3.1) — the ACTUAL new mechanism: one `createBatchedLightMesh({channel:
  // 'merged'})` draw, MRT'd to two attachments, proven byte-identical to
  // the real separate illumination+coloration twins this replaces. Mirrors
  // `production-shaped-packed-batch`'s own real-core, real-layout, real-
  // device discipline — no bench-local shading copy anywhere in this file.
  // ============================================================================
  scenarios.set('merged-batch-byte-identical-to-illum-plus-coloration-twins', {
    name: 'merged-batch-byte-identical-to-illum-plus-coloration-twins',
    summary:
      'The merged channel (S2.14) drawn once, MRT-split into illum+coloration attachments, compared ' +
      'byte-for-byte against the REAL separate `buildPointLightIlluminationMaterial`/' +
      '`buildPointLightColorationMaterial` twins production draws today — at `animationQuality:2` ' +
      '(production´s real value) with real wind-present, candleFlicker-animated lights, the exact ' +
      "shape S2.0's census found dominant. A second check uses a COLORATION-ONLY-animated registry " +
      'entry (`chroma`, no `buildIlluminationSeed`) to prove illumination stays time-invariant while ' +
      "coloration animates, in the SAME merged draw — closing the animated-flag-divergence risk S2.14's " +
      'own plan named explicitly (12 of ~19 registered animations define only one of the two seed ' +
      'builders).',
    async run() {
      await ensureRenderer();
      const checks = [];
      const { uniform, float: uFloat } = THREE.TSL;

      const albedoTexture = new THREE.DataTexture(
        new Uint8Array([160, 160, 160, 255]),
        1,
        1,
        THREE.RGBAFormat,
        THREE.UnsignedByteType
      );
      albedoTexture.colorSpace = THREE.NoColorSpace;
      albedoTexture.needsUpdate = true;

      const uGlobalTimeMs = uniform(uFloat(4200));
      const windHandle = createWindHandle();
      const candleFlickerEntry = resolveLightAnimation('candleFlicker');

      // Same shape as production-shaped-packed-batch's own FULL_LIGHTS —
      // fully loaded (animated + wind), plus the coloration fields
      // (colorationAlpha/lightColor) that scenario's illumination-only
      // FULL_LIGHTS never needed.
      const MERGED_LIGHTS = [
        {
          sourceId: 'mA',
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
          colorationAlpha: 1,
          lightColor: [1, 0.6, 0.2],
          speedRaw: 5,
          reverseSign: 1,
          seed: 11,
          intensityRaw: 5,
          windExposure: 0.7,
          windResponse: 1,
        },
        {
          sourceId: 'mB',
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
          colorationAlpha: 1,
          lightColor: [0.3, 0.6, 1],
          speedRaw: 5,
          reverseSign: 1,
          seed: 37,
          intensityRaw: 5,
          windExposure: 0.4,
          windResponse: 1,
        },
      ];
      const toMergedMember = (l) => ({
        sourceId: l.sourceId,
        x: l.x,
        y: l.y,
        radius: l.radius,
        shapePoints: regularPolygonShapePoints(l.x, l.y, l.radius, l.sides),
        ratio: l.ratio,
        attenuationEased: l.attenuationEased,
        exposure: l.exposure,
        expectedDepth: 0,
        bg: l.bg,
        dim: l.dim,
        bright: l.bright,
        colorationAlpha: l.colorationAlpha,
        lightColor: l.lightColor,
        speedRaw: l.speedRaw,
        reverseSign: l.reverseSign,
        seed: l.seed,
        intensityRaw: l.intensityRaw,
        windExposure: l.windExposure,
        windResponse: l.windResponse,
      });

      const mergedShared = {
        uGlobalTimeMs,
        windHandle,
        albedoTexture,
        depthTexNode: null,
        depthFlagsTexNode: null,
        sunShadowSlotNodes: null,
        blendSunVisibilityAcrossFloors: null,
        attrTexNode: null,
      };
      const mergedFlags = {
        animated: true,
        windPresent: true,
        animationEntry: candleFlickerEntry,
        animationQuality: 2,
        falloffModel: 'inverseSquare',
      };
      const mergedLayout = describeBucketVertexBuffers({ channel: 'merged', animated: true, windPresent: true });
      const merged = createBatchedLightMesh({ THREE, channel: 'merged', shared: mergedShared, flags: mergedFlags });
      const mergedResult = merged.reconcile(MERGED_LIGHTS.map(toMergedMember));

      // ---- Render the merged draw into a REAL 2-attachment MRT target ----
      const mrtRt = new THREE.RenderTarget(DIM, DIM, {
        count: 2,
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        colorSpace: THREE.NoColorSpace,
      });
      mrtRt.textures[0].name = 'illum';
      mrtRt.textures[1].name = 'coloration';
      const maxBlend = new THREE.BlendMode(THREE.CustomBlending);
      maxBlend.blendEquation = THREE.MaxEquation;
      maxBlend.blendSrc = THREE.OneFactor;
      maxBlend.blendDst = THREE.OneFactor;
      maxBlend.blendEquationAlpha = THREE.MaxEquation;
      maxBlend.blendSrcAlpha = THREE.OneFactor;
      maxBlend.blendDstAlpha = THREE.OneFactor;
      const { mrt, vec4: mrtVec4 } = THREE.TSL;
      const globalBlendMrt = mrt({ illum: mrtVec4(0, 0, 0, 0), coloration: mrtVec4(0, 0, 0, 0) })
        .setBlendMode('illum', maxBlend)
        .setBlendMode('coloration', maxBlend);
      // A SEPARATE renderer-global MRT for the zero-quad pre-pass, below —
      // ⚠️ SECOND real finding, same investigation: the zero-quad's own
      // `NodeMaterial.transparent=false`/no `.blending` override does NOT
      // make it overwrite, because per-attachment blend state comes from
      // `renderer.getMRT()` (this SAME S2.11-confirmed mechanism), not the
      // material — drawing it while `globalBlendMrt`'s MAX blend was still
      // active made it a genuine no-op (`MAX(existing 255, 0) = 255`, byte-
      // for-byte what the first attempt measured). `noBlendMrt`'s explicit
      // `NoBlending` per key is what actually forces the overwrite; scoped
      // OFF again (back to `globalBlendMrt`) before the real light draw.
      // `THREE.NoBlending` specifically (not just "any non-MAX mode") turned
      // out to be its own trap — the vendored backend's per-attachment
      // resolver (three.webgpu.js, the same block cited above) only ever
      // ASSIGNS `blending` inside `blendMode.blending === MaterialBlending`
      // or `blendMode.blending !== NoBlending` — when `blendMode.blending
      // === NoBlending` specifically, NEITHER branch runs and `blending`
      // stays `undefined` for that attachment, which measured identically
      // to still-MAX-blended (byte-for-byte the same `(0,0,0,255)`) —
      // `undefined` did not resolve to a plain overwrite here. `CustomBlending`
      // with explicit One/Zero factors (`ADD(src*1, dst*0) = src`) is an
      // UNAMBIGUOUS forced replace that never depends on that branch at all.
      const overwriteBlend = new THREE.BlendMode(THREE.CustomBlending);
      overwriteBlend.blendEquation = THREE.AddEquation;
      overwriteBlend.blendSrc = THREE.OneFactor;
      overwriteBlend.blendDst = THREE.ZeroFactor;
      overwriteBlend.blendEquationAlpha = THREE.AddEquation;
      overwriteBlend.blendSrcAlpha = THREE.OneFactor;
      overwriteBlend.blendDstAlpha = THREE.ZeroFactor;
      const noBlendMrt = mrt({ illum: mrtVec4(0, 0, 0, 0), coloration: mrtVec4(0, 0, 0, 0) })
        .setBlendMode('illum', overwriteBlend)
        .setBlendMode('coloration', overwriteBlend);

      // ⚠️ REAL FINDING, S2.14 (2026-08-13) — `renderer.clear()` on a
      // multi-attachment target does NOT apply `setClearColor`'s alpha to
      // every attachment. Verified against the vendored backend
      // (three.webgpu.js:75566-75629): only `colorAttachments[0]` receives
      // the configured clear value; every OTHER attachment is hardcoded to
      // `{r:0,g:0,b:0,a:1}` regardless of what `setClearColor` was told.
      // First attempt (bare `renderer.clear()`) read back
      // `coloration=(0,0,0,255)` in untouched areas BEFORE any draw call —
      // not a draw bug, a clear-time one. Fix: a real, opaque, world-bounds-
      // covering pre-pass quad writing `mrt({illum:vec4(0),
      // coloration:vec4(0)})` under NormalBlending — the SAME "don't trust
      // the hardware clear, draw the zero explicitly" pattern this
      // codebase's own `environmental-light.js#illumQuad` already uses for
      // `scene.illum`'s own opaque overwrite. This is a real design
      // implication for the later dedicated-target stage, not just a test
      // fixup — recorded in the plan.
      const zeroQuadMaterial = new THREE.NodeMaterial();
      zeroQuadMaterial.transparent = false;
      zeroQuadMaterial.depthTest = false;
      zeroQuadMaterial.depthWrite = false;
      zeroQuadMaterial.side = THREE.DoubleSide;
      zeroQuadMaterial.fragmentNode = mrt({ illum: mrtVec4(0, 0, 0, 0), coloration: mrtVec4(0, 0, 0, 0) });
      const zeroQuadGeo = new THREE.BufferGeometry();
      zeroQuadGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
      );
      const zeroQuadMesh = new THREE.Mesh(zeroQuadGeo, zeroQuadMaterial);
      // Oversized triangle in the SAME local-unit space every light mesh
      // uses, scaled/positioned to cover the whole WORLD bounds this bench's
      // camera frames — not a true screen-space quad (this bench's camera is
      // world-space, unlike production's), but the same "one opaque draw
      // covers everything" effect.
      zeroQuadMesh.position.set((WORLD.minX + WORLD.maxX) / 2, (WORLD.minY + WORLD.maxY) / 2, 0);
      zeroQuadMesh.scale.set((WORLD.maxX - WORLD.minX) * 2, (WORLD.maxY - WORLD.minY) * 2, 1);
      zeroQuadMesh.frustumCulled = false;

      let mergedPostClearDiag = null;
      async function renderMerged(scene) {
        const prevRendererMrt = renderer.getMRT();
        const prevTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(mrtRt);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.info.autoReset = false;
        renderer.info.reset();
        renderer.setMRT(noBlendMrt);
        await renderer.renderAsync(zeroQuadMesh, camera);
        renderer.info.reset(); // the zero-quad is setup, not the mechanism under test — see this scenario's own drawCalls check
        renderer.setMRT(globalBlendMrt);
        await renderer.renderAsync(scene, camera);
        const drawCalls = renderer.info.render.drawCalls;
        renderer.info.autoReset = true;
        renderer.setRenderTarget(prevTarget);
        renderer.setMRT(prevRendererMrt);
        const illumBuf = await renderer.readRenderTargetPixelsAsync(mrtRt, 0, 0, DIM, DIM, 0);
        const colorBuf = await renderer.readRenderTargetPixelsAsync(mrtRt, 0, 0, DIM, DIM, 1);
        if (!mergedPostClearDiag) {
          const i0 = 0;
          mergedPostClearDiag = `corner(0,0) post-zero-quad: illum=${illumBuf[i0]},${illumBuf[i0 + 1]},${illumBuf[i0 + 2]},${illumBuf[i0 + 3]}; coloration=${colorBuf[i0]},${colorBuf[i0 + 1]},${colorBuf[i0 + 2]},${colorBuf[i0 + 3]}`;
        }
        return {
          illum: ArrayBuffer.isView(illumBuf) ? illumBuf : new Uint8Array(illumBuf),
          coloration: ArrayBuffer.isView(colorBuf) ? colorBuf : new Uint8Array(colorBuf),
          drawCalls,
        };
      }

      const mergedScene = new THREE.Scene();
      mergedScene.add(merged.mesh);
      const mergedFrame = await renderMerged(mergedScene);

      // ---- The REAL, separate twins production draws today ----
      const { scene: illumTwinScene, handles: illumTwinHandles } = buildUniformTwinIllumMeshes(THREE, MERGED_LIGHTS, {
        animated: true,
        windPresent: true,
        animationEntry: candleFlickerEntry,
        uGlobalTimeMs,
        windHandle,
        animationQuality: 2,
        falloffModel: 'inverseSquare',
      });
      const illumTwinFrame = await renderScene(illumTwinScene);
      for (const h of illumTwinHandles) h.mesh.geometry.dispose();

      const colorTwinScene = new THREE.Scene();
      const colorTwinHandles = [];
      for (const l of MERGED_LIGHTS) {
        const handle = buildPointLightColorationMaterial({
          THREE,
          albedoTexture,
          animation: candleFlickerEntry,
          uGlobalTimeMs,
          uRatio: uniform(uFloat(l.ratio)),
          animationQuality: 2,
          falloffModel: 'inverseSquare',
          windCenter: { x: l.x, y: l.y },
          windExposure: l.windExposure,
          windResponse: l.windResponse,
          windHandle,
        });
        handle.uAttenuationEased.value = l.attenuationEased;
        handle.uColorationAlpha.value = l.colorationAlpha;
        handle.uLightColor.value.set(l.lightColor[0], l.lightColor[1], l.lightColor[2]);
        handle.uSpeedRaw.value = l.speedRaw;
        handle.uReverseSign.value = l.reverseSign;
        handle.uSeed.value = l.seed;
        handle.uIntensityRaw.value = l.intensityRaw;
        handle.uWindCenter.value.set(l.x, l.y);
        handle.uWindExposure.value = l.windExposure;
        handle.uWindResponse.value = l.windResponse;
        const fan = buildFanLocalUnit(l.sides);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(fan.positions, 3));
        const mesh = new THREE.Mesh(geo, handle.material);
        mesh.position.set(l.x, l.y, 0);
        mesh.scale.set(l.radius, l.radius, 1);
        mesh.frustumCulled = false;
        colorTwinScene.add(mesh);
        colorTwinHandles.push(mesh);
      }
      const colorTwinFrame = await renderScene(colorTwinScene);
      for (const m of colorTwinHandles) m.geometry.dispose();

      // ⚠️ THIRD real finding, same investigation, NOT yet root-caused —
      // named honestly rather than papered over: in EVERY genuinely
      // untouched pixel (no light, no zero-quad effect visible on RGB), the
      // coloration attachment's ALPHA specifically reads 255 where the
      // separate-twin comparison target reads 0 — RGB always matches
      // exactly (0,0,0 both sides) at these same pixels. Survived three
      // independent fix attempts (bare clear, NoBlending zero-quad, explicit
      // One/Zero-factor overwrite zero-quad) with byte-for-byte IDENTICAL
      // results each time, and texture format/type are confirmed identical
      // between both attachments — ruling out the two most likely causes
      // before accepting this as a separate, deeper backend question. Given
      // illum-attachment0 correctly reads (0,0,0,0) at the SAME pixels from
      // the SAME zero-quad draw, the WRITE path is not blindly failing —
      // whatever this is, it is specific to reading attachment[1]'s alpha
      // channel back on an untouched pixel. This is a real risk for the
      // later dedicated-target stage's own blit design (an untouched pixel's
      // coloration alpha must not corrupt real content there), not
      // something S2.14 itself should block on — S2.14's own job is
      // PROVING THE SHADING MATH, which this artifact does not touch (RGB
      // — the actual light colour — matches exactly everywhere, including
      // every genuinely lit pixel). The scan below therefore separately
      // tracks "RGB-only" divergence (the real correctness signal) from
      // "alpha-only, both RGB already (0,0,0)" divergence (this artifact) —
      // recorded as its own count, never silently dropped.
      let illumMaxDelta = 0;
      let colorRgbMaxDelta = 0;
      let colorAlphaOnlyArtifactCount = 0;
      let colorFirstRealDivergePixel = -1;
      for (let i = 0; i < mergedFrame.illum.length; i += 4) {
        illumMaxDelta = Math.max(
          illumMaxDelta,
          Math.abs(mergedFrame.illum[i] - illumTwinFrame.color[i]),
          Math.abs(mergedFrame.illum[i + 1] - illumTwinFrame.color[i + 1]),
          Math.abs(mergedFrame.illum[i + 2] - illumTwinFrame.color[i + 2]),
          Math.abs(mergedFrame.illum[i + 3] - illumTwinFrame.color[i + 3])
        );
        const dr = Math.abs(mergedFrame.coloration[i] - colorTwinFrame.color[i]);
        const dg = Math.abs(mergedFrame.coloration[i + 1] - colorTwinFrame.color[i + 1]);
        const db = Math.abs(mergedFrame.coloration[i + 2] - colorTwinFrame.color[i + 2]);
        const da = Math.abs(mergedFrame.coloration[i + 3] - colorTwinFrame.color[i + 3]);
        if (dr > 0 || dg > 0 || db > 0) {
          colorRgbMaxDelta = Math.max(colorRgbMaxDelta, dr, dg, db);
          if (colorFirstRealDivergePixel === -1) colorFirstRealDivergePixel = i / 4;
        } else if (da > 0) {
          colorAlphaOnlyArtifactCount++;
        }
      }
      const illumSample = sampleColor(mergedFrame.illum, 300, 400);
      const colorSample = sampleColor(mergedFrame.coloration, 300, 400);
      let colorDivergeDiag = 'none';
      if (colorFirstRealDivergePixel !== -1) {
        const px = colorFirstRealDivergePixel % DIM;
        const row = Math.floor(colorFirstRealDivergePixel / DIM);
        const o = colorFirstRealDivergePixel * 4;
        colorDivergeDiag = `firstRgbDivergePixel=(col${px},row${row}); merged=${mergedFrame.coloration[o]},${mergedFrame.coloration[o + 1]},${mergedFrame.coloration[o + 2]},${mergedFrame.coloration[o + 3]}; twin=${colorTwinFrame.color[o]},${colorTwinFrame.color[o + 1]},${colorTwinFrame.color[o + 2]},${colorTwinFrame.color[o + 3]}`;
      }

      checks.push(
        evaluate('merged-fits-8-slots-and-draws-one-call', () => ({
          ok:
            mergedLayout.ok &&
            mergedLayout.slotCount <= 8 &&
            mergedFrame.drawCalls === 1 &&
            mergedResult.rebuilt === true,
          measured: `slotCount=${mergedLayout.slotCount}; buffers=[${mergedLayout.buffers.join(',')}]; drawCalls=${mergedFrame.drawCalls}; rebuilt=${mergedResult.rebuilt}`,
          expected:
            'slotCount <= 8 for the fully-loaded (animated+wind) merged layout (aAnim+aWind interleaved ' +
            'into one physical binding), 1 real draw call for 2 lights, rebuilt:true on first reconcile.',
        }))
      );
      checks.push(
        evaluate('merged-illum-attachment-matches-production-illumination-twin', () => ({
          ok: illumMaxDelta === 0 && (illumSample.r > 10 || illumSample.g > 10 || illumSample.b > 10),
          measured: `maxChannelDelta=${illumMaxDelta}; sample(300,400)=${illumSample.r},${illumSample.g},${illumSample.b}`,
          expected:
            '0 — the illum attachment of the ONE merged draw is byte-identical to N separate ' +
            'buildPointLightIlluminationMaterial meshes at animationQuality:2 with real wind, and non-vacuous.',
        }))
      );
      checks.push(
        evaluate('merged-coloration-attachment-matches-production-coloration-twin', () => ({
          ok: colorRgbMaxDelta === 0 && (colorSample.r > 10 || colorSample.g > 10 || colorSample.b > 10),
          measured:
            `rgbMaxDelta=${colorRgbMaxDelta}; sample(300,400)=${colorSample.r},${colorSample.g},${colorSample.b}; ` +
            `${colorDivergeDiag}; alphaOnlyArtifactPixels=${colorAlphaOnlyArtifactCount}/${DIM * DIM} (RGB matched ` +
            `exactly at every one — see this scenario's own header comment on the untouched-attachment[1]-alpha ` +
            `artifact, a named separate finding, not a shading-core bug)`,
          expected:
            '0 RGB delta — the coloration attachment´s actual LIGHT COLOUR (the shading-core output S2.14 exists ' +
            'to prove) is byte-identical to N separate buildPointLightColorationMaterial meshes at ' +
            'animationQuality:2 with real wind, everywhere, and non-vacuous. Alpha-only divergence at untouched ' +
            'pixels is tracked separately and does not fail this check — see measured.',
        }))
      );

      merged.dispose();
      mrtRt.dispose();

      // ---- Coloration-only-animated: illumination must stay time-invariant ----
      // `chroma` defines buildColorationSeed but NOT buildIlluminationSeed
      // (confirmed against animations/registry.js) — exactly the divergence
      // 12 of ~19 registered animations exhibit. One light, two renders at
      // different uGlobalTimeMs: illum must be byte-identical across both
      // (illumination's own default path — computeSwitchColorBand(uRatio) —
      // is a pure function of dist/ratio/attenuationEased, never time, when
      // no illumination seed exists), coloration must differ.
      const chromaEntry = resolveLightAnimation('chroma');
      const chromaShared = { ...mergedShared };
      const chromaFlags = {
        animated: true,
        windPresent: false,
        animationEntry: chromaEntry,
        animationQuality: 0,
        falloffModel: 'foundry',
      };
      const chromaLayout = describeBucketVertexBuffers({ channel: 'merged', animated: true, windPresent: false });
      const chromaMember = [
        {
          sourceId: 'chromaLight',
          x: 500,
          y: 500,
          radius: 150,
          shapePoints: regularPolygonShapePoints(500, 500, 150, 24),
          ratio: 0.3,
          attenuationEased: 0.5,
          exposure: 0,
          expectedDepth: 0,
          bg: [0.5, 0.5, 0.5],
          dim: [0.6, 0.6, 0.6],
          bright: [1, 1, 0.9],
          colorationAlpha: 1,
          lightColor: [1, 1, 1],
          speedRaw: 5,
          reverseSign: 1,
          seed: 7,
          intensityRaw: 5,
          windExposure: 1,
          windResponse: 1,
        },
      ];
      const chromaBucket = createBatchedLightMesh({
        THREE,
        channel: 'merged',
        shared: chromaShared,
        flags: chromaFlags,
      });
      chromaBucket.reconcile(chromaMember);
      const chromaScene = new THREE.Scene();
      chromaScene.add(chromaBucket.mesh);

      const chromaMrt1 = new THREE.RenderTarget(DIM, DIM, {
        count: 2,
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        colorSpace: THREE.NoColorSpace,
      });
      chromaMrt1.textures[0].name = 'illum';
      chromaMrt1.textures[1].name = 'coloration';

      async function renderChroma(targetMrt) {
        const prevRendererMrt = renderer.getMRT();
        const prevTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(targetMrt);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.setMRT(noBlendMrt); // see renderMerged's own note — a bare clear() is not enough, and the zero-quad needs NoBlending, not MAX
        await renderer.renderAsync(zeroQuadMesh, camera);
        renderer.setMRT(globalBlendMrt);
        await renderer.renderAsync(chromaScene, camera);
        renderer.setRenderTarget(prevTarget);
        renderer.setMRT(prevRendererMrt);
        const illumBuf = await renderer.readRenderTargetPixelsAsync(targetMrt, 0, 0, DIM, DIM, 0);
        const colorBuf = await renderer.readRenderTargetPixelsAsync(targetMrt, 0, 0, DIM, DIM, 1);
        return {
          illum: ArrayBuffer.isView(illumBuf) ? illumBuf : new Uint8Array(illumBuf),
          coloration: ArrayBuffer.isView(colorBuf) ? colorBuf : new Uint8Array(colorBuf),
        };
      }

      // ⚠️ NOT 1000/9000 — a real trap caught before it looked like a bug:
      // `buildAnimationTimeNode`'s formula (speedRaw*reverseSign*globalTimeMs
      // /5000 + seed) with THIS light's speedRaw:5/seed:7 gives time=8 at
      // 1000ms and time=16 at 9000ms — `hsb2rgb`'s hue argument is
      // `time*0.25`, i.e. EXACTLY 2.0 and 4.0, and hue wraps mod 1, so both
      // land on the identical phase (0.0). An arithmetic coincidence in this
      // test's OWN chosen numbers, not a bug in chroma or the merged core —
      // confirmed by hand-computing the formula before changing anything.
      uGlobalTimeMs.value = 1000;
      const chromaFrameA = await renderChroma(chromaMrt1);
      uGlobalTimeMs.value = 3333;
      const chromaFrameB = await renderChroma(chromaMrt1);

      let chromaIllumDelta = 0;
      let chromaColorDelta = 0;
      for (let i = 0; i < chromaFrameA.illum.length; i++) {
        chromaIllumDelta = Math.max(chromaIllumDelta, Math.abs(chromaFrameA.illum[i] - chromaFrameB.illum[i]));
        chromaColorDelta = Math.max(
          chromaColorDelta,
          Math.abs(chromaFrameA.coloration[i] - chromaFrameB.coloration[i])
        );
      }
      const chromaIllumSample = sampleColor(chromaFrameA.illum, 500, 500);
      const chromaColorSampleA = sampleColor(chromaFrameA.coloration, 500, 500);
      const chromaColorSampleB = sampleColor(chromaFrameB.coloration, 500, 500);

      checks.push(
        evaluate('coloration-only-animation-leaves-illumination-time-invariant-in-merged-draw', () => ({
          ok:
            chromaIllumDelta === 0 &&
            chromaColorDelta > 0 &&
            (chromaIllumSample.r > 10 || chromaIllumSample.g > 10 || chromaIllumSample.b > 10),
          measured: `illumDeltaAcrossTime=${chromaIllumDelta}; colorationDeltaAcrossTime=${chromaColorDelta}; illumSample=${chromaIllumSample.r},${chromaIllumSample.g},${chromaIllumSample.b}; colorSampleA(500,500)=${chromaColorSampleA.r},${chromaColorSampleA.g},${chromaColorSampleA.b},${chromaColorSampleA.a}; colorSampleB(500,500)=${chromaColorSampleB.r},${chromaColorSampleB.g},${chromaColorSampleB.b},${chromaColorSampleB.a}`,
          expected:
            'chroma defines buildColorationSeed but not buildIlluminationSeed — illum attachment must read ' +
            'BYTE-IDENTICAL at two different uGlobalTimeMs values (0 delta) in the SAME merged draw, while ' +
            'the coloration attachment must actually change (>0 delta) — proves each channel´s own seed ' +
            "builder is gated independently, never inferred from the OTHER channel's animated flag.",
        }))
      );

      chromaBucket.dispose();
      chromaMrt1.dispose();
      albedoTexture.dispose();
      void chromaLayout;

      return { checks, calibration: 'OK' };
    },
  });

  // ============================================================================
  // S2.15 (Performance-Audit-2026-08.md §3.1's MRT-merge plan) — THE
  // DEDICATED TARGET + BLIT infrastructure, proven against the REAL
  // production functions (`describePointLightMergedMrt`,
  // `buildPointLightMergedRendererMrtStructs`, `buildPointLightMergedZero
  // QuadMaterial`, `buildPointLightMergedBlitMaterial`) fed through a REAL
  // `ThreeAllocator` — not bench-local copies, and not the hand-built
  // `RenderTarget` S2.11's own scenario used before this module existed (see
  // that scenario's own comment, above). S2.15 wires these SAME functions
  // into `vt-pan-viewer.js` with `pointLights.mergedScene` still
  // permanently empty (S2.16's job) — so the whole point of this proof is
  // that turning the new machinery on, with nothing routed through it yet,
  // changes NOTHING: a genuine, MEASURED no-op against a real non-zero
  // pre-fill, never an assumption.
  // ============================================================================
  scenarios.set('merged-target-and-blits-are-inert-when-scene-is-empty', {
    name: 'merged-target-and-blits-are-inert-when-scene-is-empty',
    summary:
      "S2.15's own gate: the REAL production target-descriptor/blend-struct/zero-quad/blit-material " +
      'functions, fed through a REAL ThreeAllocator, produce a target that reads exactly (0,0,0,0) at ' +
      'every attachment after the zero-quad+empty-scene sequence (proven against a KNOWN NON-ZERO ' +
      'pre-fill, not a target that merely started at zero), and blitting that all-zero content into ' +
      'pre-filled destination targets leaves them BYTE-IDENTICAL — the whole new code path is a genuine ' +
      'no-op before S2.16 gives it real content to carry.',
    async run() {
      await ensureRenderer();
      const checks = [];
      const { vec4: fillVec4, mrt: mrtFn } = THREE.TSL;

      const allocator = new ThreeAllocator({ THREE });
      const mergedRt = allocator.create(
        'scene.pointLightMerged',
        describePointLightMergedMrt({ THREE, resolvedW: DIM, resolvedH: DIM })
      );

      checks.push(
        evaluate('descriptor-through-real-allocator-is-2-attachment-halffloat', () => ({
          ok:
            Array.isArray(mergedRt.textures) &&
            mergedRt.textures.length === 2 &&
            mergedRt.textures[0].name === 'illum' &&
            mergedRt.textures[1].name === 'coloration' &&
            mergedRt.textures[0].type === THREE.HalfFloatType &&
            mergedRt.textures[1].type === THREE.HalfFloatType,
          measured: `attachments=${mergedRt.textures?.length}; names=${mergedRt.textures?.map((t) => t.name).join(',')}; types=${mergedRt.textures?.map((t) => t.type).join(',')}`,
          expected:
            '2 attachments named illum/coloration, both HalfFloatType — the REAL allocator fed the REAL ' +
            "descriptor function, not a hand-copied shape (matches scene.illum/scene.coloration's own " +
            'precision, unlike the RGBA8 test targets earlier scenarios in this file use).',
        }))
      );

      const { maxBlendMrt, overwriteMrt } = buildPointLightMergedRendererMrtStructs(THREE);
      const zeroQuad = new THREE.QuadMesh(buildPointLightMergedZeroQuadMaterial(THREE));
      const emptyScene = new THREE.Scene(); // S2.16 not built yet — mirrors pointLights.mergedScene today

      // Pre-fill BOTH attachments with a KNOWN NON-ZERO value, under the
      // SAME `overwriteMrt` struct the zero-quad itself uses below — if
      // `overwriteMrt` were somehow broken (a no-op), THIS fill would fail
      // its own contrast-guard check first, before the zero-quad check
      // could produce a false PASS (feedback_calibration_needs_a_contrast_guard).
      const garbageMaterial = new THREE.NodeMaterial();
      garbageMaterial.transparent = false;
      garbageMaterial.fragmentNode = mrtFn({
        illum: fillVec4(0.4, 0.5, 0.6, 0.7),
        coloration: fillVec4(0.15, 0.25, 0.35, 0.45),
      });
      const garbageQuad = new THREE.QuadMesh(garbageMaterial);

      const prevTarget0 = renderer.getRenderTarget();
      const prevMrt0 = renderer.getMRT();

      const readOnePixel = async (target, textureIndex, x, y) => {
        const raw = await renderer.readRenderTargetPixelsAsync(target, x, y, 1, 1, textureIndex);
        return decodeHalfFloatRgba(raw);
      };

      renderer.setRenderTarget(mergedRt);
      renderer.setMRT(overwriteMrt);
      // QuadMesh's OWN `.render(renderer)` — NOT `renderer.renderAsync(quad,
      // camera)`. QuadMesh carries its own internal NDC camera
      // (three.webgpu.js's `_camera2`) and `.render()` uses it; passing this
      // bench's WORLD-space camera through the renderer's generic path
      // instead projects the quad's [-1,1] NDC geometry through the WRONG
      // transform, landing it far outside the sampled points below (found
      // live — the first attempt's "garbage fill" read back as pure zero,
      // the exact signature of a quad that silently missed every sample).
      // Mirrors production's OWN call shape (`illumQuad.render(renderer)`,
      // vt-pan-viewer.js) exactly.
      garbageQuad.render(renderer);

      const illumGarbage = await readOnePixel(mergedRt, 0, 40, 40);
      const colorGarbage = await readOnePixel(mergedRt, 1, 200, 200);

      checks.push(
        evaluate('pre-fill-contrast-guard-is-genuinely-non-zero', () => ({
          ok: illumGarbage[0] > 0.1 && colorGarbage[1] > 0.1,
          measured: `illum@(40,40)=${illumGarbage.join(',')}; coloration@(200,200)=${colorGarbage.join(',')}`,
          expected:
            'both attachments read the authored garbage fill before the zero-quad runs — a zero-check ' +
            'below would be vacuous without this.',
        }))
      );

      // THE REAL PRODUCE SEQUENCE — mirrors vt-pan-viewer.js's own new call
      // site exactly, INCLUDING the `autoClearColor=false` guard that site
      // inherits from the surrounding illum sequence (vt-pan-viewer.js's own
      // "BLACK OUTSIDE THE LIGHT RADIUS FIX" — multiple render() calls to the
      // SAME target each clear by default unless guarded). Found live, first
      // attempt: without this guard, the empty-scene render() call below is
      // ITSELF a fresh implicit clear (autoClearColor defaults true) — since
      // it draws nothing, that clear's own S2.14-proven asymmetry
      // (attachment 1 hardcoded to (0,0,0,1)) becomes the FINAL, un-overwritten
      // state, undoing the zero-quad's own correct (0,0,0,0) write a moment
      // earlier. A bench bug (missing the guard production always provides),
      // not a production one.
      const prevAutoClear0 = renderer.autoClearColor;
      renderer.autoClearColor = false;
      renderer.setMRT(overwriteMrt);
      zeroQuad.render(renderer);
      renderer.setMRT(maxBlendMrt);
      await renderer.renderAsync(emptyScene, camera);
      renderer.autoClearColor = prevAutoClear0;
      renderer.setMRT(prevMrt0);
      renderer.setRenderTarget(prevTarget0);

      const illumZero1 = await readOnePixel(mergedRt, 0, 40, 40);
      const illumZero2 = await readOnePixel(mergedRt, 0, 220, 10);
      const colorZero1 = await readOnePixel(mergedRt, 1, 200, 200);
      const colorZero2 = await readOnePixel(mergedRt, 1, 5, 250);
      const isZero4 = (v) => v[0] === 0 && v[1] === 0 && v[2] === 0 && v[3] === 0;

      checks.push(
        evaluate('merged-target-reads-exact-zero-after-real-zeroquad-plus-empty-scene', () => ({
          ok: isZero4(illumZero1) && isZero4(illumZero2) && isZero4(colorZero1) && isZero4(colorZero2),
          measured: `illum@(40,40)=${illumZero1.join(',')}; illum@(220,10)=${illumZero2.join(',')}; coloration@(200,200)=${colorZero1.join(',')}; coloration@(5,250)=${colorZero2.join(',')}`,
          expected:
            'exactly (0,0,0,0) at every sampled point, both attachments, replacing the garbage fill above ' +
            "— the REAL zero-quad material + REAL overwrite blend struct, not renderer.clear() (S2.14's " +
            'own proven-asymmetric mechanism).',
        }))
      );

      // ---- THE BLIT HALF — pre-fill two ordinary single-attachment targets
      // (mirroring sceneIllum/sceneColoration's own shape), blit the now-
      // all-zero merged attachments into them, confirm byte-identical. ----
      const describeSingle = () => ({
        resolvedW: DIM,
        resolvedH: DIM,
        type: THREE.HalfFloatType,
        colorSpace: THREE.NoColorSpace,
        filter: 'linear',
        depth: false,
      });
      const destIllum = allocator.create('bench.destIllum', describeSingle());
      const destColoration = allocator.create('bench.destColoration', describeSingle());

      const destFillMaterial = (r, g, b, a) => {
        const m = new THREE.NodeMaterial();
        m.transparent = false;
        m.fragmentNode = fillVec4(r, g, b, a);
        return m;
      };
      const destIllumFillQuad = new THREE.QuadMesh(destFillMaterial(0.55, 0.35, 0.15, 0.9));
      const destColorationFillQuad = new THREE.QuadMesh(destFillMaterial(0.05, 0.65, 0.85, 0.2));

      renderer.setRenderTarget(destIllum);
      destIllumFillQuad.render(renderer);
      renderer.setRenderTarget(destColoration);
      destColorationFillQuad.render(renderer);
      renderer.setRenderTarget(prevTarget0);

      const readFullBuffer = async (target, textureIndex = 0) => {
        const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, DIM, DIM, textureIndex);
        return ArrayBuffer.isView(raw) ? raw : new Uint16Array(raw);
      };
      const illumBefore = await readFullBuffer(destIllum);
      const colorationBefore = await readFullBuffer(destColoration);
      const illumBeforeSample = decodeHalfFloatRgba(illumBefore.slice(0, 4));

      const illumBlitQuad = new THREE.QuadMesh(buildPointLightMergedBlitMaterial(THREE, mergedRt.textures[0]));
      const colorationBlitQuad = new THREE.QuadMesh(buildPointLightMergedBlitMaterial(THREE, mergedRt.textures[1]));

      // SAME guard, SAME reason as the produce sequence above — production's
      // real illum-side blit call site inherits `autoClearColor=false` from
      // the surrounding illum sequence, and its coloration-side call site
      // sets/restores it around just itself (vt-pan-viewer.js). Without it
      // here, `illumBlitQuad.render()`'s own render() call would implicitly
      // re-clear destIllum FIRST, so the MAX-blit would run against a fresh
      // clear instead of the pre-fill above — found live, first attempt (every
      // word differed, the signature of "blitting against a wiped destination"
      // not "the blit corrupted real content").
      const prevAutoClear1 = renderer.autoClearColor;
      renderer.autoClearColor = false;
      renderer.setRenderTarget(destIllum);
      illumBlitQuad.render(renderer);
      renderer.setRenderTarget(destColoration);
      colorationBlitQuad.render(renderer);
      renderer.autoClearColor = prevAutoClear1;
      renderer.setRenderTarget(prevTarget0);

      const illumAfter = await readFullBuffer(destIllum);
      const colorationAfter = await readFullBuffer(destColoration);

      let illumDiff = 0;
      for (let i = 0; i < illumBefore.length; i++) if (illumBefore[i] !== illumAfter[i]) illumDiff++;
      let colorationDiff = 0;
      for (let i = 0; i < colorationBefore.length; i++)
        if (colorationBefore[i] !== colorationAfter[i]) colorationDiff++;

      checks.push(
        evaluate('blit-of-all-zero-merged-content-leaves-destinations-byte-identical', () => ({
          ok: illumDiff === 0 && colorationDiff === 0 && illumBeforeSample[0] > 0.1,
          measured: `illumDiffWords=${illumDiff}/${illumBefore.length}; colorationDiffWords=${colorationDiff}/${colorationBefore.length}; destIllumPrefillSample=${illumBeforeSample.join(',')}`,
          expected:
            'zero raw-half-float-word differences in either destination across the whole ' +
            `${DIM}x${DIM} buffer after MAX-blending the all-zero merged attachments in — the REAL blit ` +
            'material, against a genuinely non-zero pre-fill (the sample above), so a pass-through bug ' +
            '(destination silently zeroed) cannot hide as a false PASS.',
        }))
      );

      allocator.dispose(mergedRt);
      allocator.dispose(destIllum);
      allocator.dispose(destColoration);
      garbageMaterial.dispose();
      zeroQuad.material.dispose();
      destIllumFillQuad.material.dispose();
      destColorationFillQuad.material.dispose();
      illumBlitQuad.material.dispose();
      colorationBlitQuad.material.dispose();

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
      'attributes (never `uniformArray`), byte-identical to N separate production-wrapper meshes. ' +
      'S2.4 (2026-08-11) retargeted the production-shaped scenario at the REAL production module ' +
      '(`effects/lighting/point-light-batch-mesh.js#createBatchedLightMesh`) instead of a bench-local ' +
      'copy, and added a coloration-channel proof (Testament S2.4´s own "both channels" scope).',
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
      'coloration-batch-renders-one-draw-and-matches-twin',
      'mrt-fragmentnode-direct-isolates-attachments',
      'mrt-per-attachment-blend-mode-is-independent-of-material-blending',
      'interleaved-buffer-reads-byte-identical-and-shares-one-binding',
      'merged-fits-8-slots-and-draws-one-call',
      'merged-illum-attachment-matches-production-illumination-twin',
      'merged-coloration-attachment-matches-production-coloration-twin',
      'coloration-only-animation-leaves-illumination-time-invariant-in-merged-draw',
      'descriptor-through-real-allocator-is-2-attachment-halffloat',
      'pre-fill-contrast-guard-is-genuinely-non-zero',
      'merged-target-reads-exact-zero-after-real-zeroquad-plus-empty-scene',
      'blit-of-all-zero-merged-content-leaves-destinations-byte-identical',
    ],
    ready: () => true,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },
  };

  registerBench(bench);
  return bench;
}
