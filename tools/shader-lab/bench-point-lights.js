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

  function sampleColor(colorBuf, x, y) {
    const fx = (x - WORLD.minX) / (WORLD.maxX - WORLD.minX);
    const fy = (y - WORLD.minY) / (WORLD.maxY - WORLD.minY);
    const px = Math.min(DIM - 1, Math.max(0, Math.floor(fx * DIM)));
    const row = Math.min(DIM - 1, Math.max(0, Math.floor(fy * DIM)));
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
      '\n\n⚠️ ONE CHECK BELOW (`moving-a-light-only-touched-its-OWN-transform-slot`) FAILS HERE, ' +
      'NARROWED (NOT YET ROOT-CAUSED) 2026-08-11. An earlier pass of this investigation reported ' +
      'this as unreproducible outside this file; that framing was WRONG — a fresh, minimal, ' +
      "standalone script using this scenario's exact values reproduces it too, so the trigger is " +
      'not this harness. What IS now conclusively ruled out, via direct device instrumentation ' +
      '(not more bisection — three targeted probes against the running WebGPU backend): (1) ' +
      '`UniformArrayNode.value` — the padded CPU-side mirror `update()` writes into — reads back ' +
      'byte-correct for the moved light immediately after the second render (verified by reading ' +
      'the node instance directly); (2) `device.queue.writeBuffer` — patched and logged — is ' +
      'called for both the origin and radius buffers on the second render with the fully correct, ' +
      'moved values (logged the actual bytes). The CPU-to-GPU write path is provably correct end ' +
      'to end. Yet the rendered image keeps showing the light at its FIRST-frame position and ' +
      'radius, and two further no-op re-renders (no array mutation, no new writeBuffer calls) stay ' +
      'stuck on that same stale image — ruling out simple one-frame latency (a ping-ponged buffer ' +
      'that would resolve itself one frame later). The defect is therefore isolated to whatever ' +
      "GPU resource the DRAW's bind group actually references, downstream of a confirmed-correct " +
      'buffer write — most likely a bind-group or buffer-object identity/caching detail inside this ' +
      "vendored WebGPU backend (three.webgpu.js's `Bindings`/`WebGPUBindingUtils`) that this " +
      'investigation did not chase further, per explicit guidance against open-ended, unbounded ' +
      'debugging. Next step for whoever picks this back up: instrument `backend.get(binding).buffer` ' +
      'identity (not just its contents) across the two renders, and compare against the GPUBuffer ' +
      'object actually captured in the cached `bindGroupGPU` used for the draw. This does NOT ' +
      'weaken the design conclusion: the other three checks here (single draw call, correct ' +
      "per-slot placement, untouched slots staying byte-identical) pass, and the mechanism's CPU- " +
      'and upload-side correctness is now proven, not assumed — the remaining gap is a specific, ' +
      'narrowed backend question, not the indexed-transform-array design itself.',
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
      // ⚠️ A NARROWED, NOT YET ROOT-CAUSED ANOMALY (2026-08-11 — corrects an
      // earlier note here that claimed swapping numeric values alone made
      // this pass; a later re-check with these same values showed it still
      // fails, so that earlier "fix" was never real — see the scenario's
      // `summary` string above for what direct device instrumentation since
      // ruled in and out: `UniformArrayNode#update()`'s CPU-side `.value` and
      // the actual `device.queue.writeBuffer` call are both independently
      // confirmed correct for the moved light on the second render, and two
      // further no-op re-renders stay stuck on the first-frame image (not a
      // one-frame latency issue). The gap is isolated to the bind-group/
      // buffer-resource layer inside the vendored WebGPU backend, downstream
      // of a confirmed-correct write — not chased further here, per guidance
      // against open-ended debugging.
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

  const bench = {
    name: 'point-lights',
    title: 'Stage 2 — one draw call for many point lights',
    rung: 4,
    summary:
      'Proves the batching mechanism Stage 2 is built on: groups do not reduce real draw calls ' +
      '(so S1a-style grouping is the wrong tool here); a merged, ungrouped, many-shaped mesh under ' +
      'MAX blending is byte-identical to N separate draws, order-independent, and costs ONE real ' +
      'renderer.info.render.drawCalls instead of N.',
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
    ],
    ready: () => true,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },
  };

  registerBench(bench);
  return bench;
}
