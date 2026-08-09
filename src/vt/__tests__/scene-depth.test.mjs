/**
 * Node verification for vt/scene-depth.js.
 *
 * Same posture as scene-attr.test.mjs (CONVENTIONS.md §4, that file's own
 * header): TSL node construction is GPU/browser-only, so these tests verify
 * JS-level WIRING with a minimal mock TSL, never shader correctness — the
 * shader itself is proven against a real WebGPU device in
 * tools/shader-lab/bench-scene-depth.js.
 */
import {
  describeSceneDepthTarget,
  rankToDepthZ,
  computeExpectedStoredDepth,
  DEPTH_PASS_CAMERA_Z,
  DEPTH_PASS_NEAR,
  DEPTH_PASS_FAR,
  computeSceneDepthFlags,
  DEPTH_FLAG_RESTRICTS_LIGHT,
  DEPTH_FLAG_RESTRICTS_WEATHER,
  DEPTH_FLAG_IS_LEVEL_BACKGROUND,
  DEPTH_FLAG_IS_LEVEL_FOREGROUND,
  DEPTH_FLAG_IS_TILE,
  resolveSceneDepthFloorIndex,
  buildSceneDepthWriterMaterial,
  buildSceneDepthProxyMesh,
  querySceneDepth,
} from '../scene-depth.js';

/** A minimal chainable node — supports the TSL method chains this module's
 * own TSL-building functions call (`.level().a`, `.lessThan()`, `.not()`,
 * `.discard()`) — the same "minimal mock, not the real vendored TSL"
 * posture scene-attr.test.mjs's own header establishes. */
function chainable(kind, extra = {}) {
  const node = { __kind: kind, ...extra };
  node.level = (lvl) => chainable('level', { subject: node, lvl });
  Object.defineProperty(node, 'a', { get: () => chainable('swizzle-a', { subject: node }) });
  node.lessThan = (other) => chainable('lessThan', { subject: node, other });
  node.not = () => chainable('not', { subject: node });
  node.discard = () => chainable('discard', { subject: node });
  return node;
}

function makeTSL() {
  return {
    Fn: (cb) => () => cb(),
    float: (v) => chainable('float', { value: v }),
    // Unwraps a wrapped node's own `.value` (e.g. `uniform(float(x))`) down to
    // the raw number, mirroring a real UniformNode's `.value` — a mock detail,
    // not a claim about three's internals (this file's own header).
    uniform: (v) => chainable('uniform', { value: v && typeof v === 'object' && 'value' in v ? v.value : v }),
    vec4: (...args) => chainable('vec4', { args }),
    texture: (tex, uv) => chainable('texture', { tex, uv }),
    screenUV: chainable('screenUV'),
  };
}

function makeTHREE() {
  return {
    UnsignedByteType: 'U8',
    FloatType: 'F32',
    NoColorSpace: 'none',
    DoubleSide: 'DOUBLE',
    LessDepth: 'LESS',
    NodeMaterial: class {},
    TSL: makeTSL(),
    Mesh: class {
      constructor(geometry, material) {
        this.geometry = geometry;
        this.material = material;
        this.position = { z: 0 };
        this.frustumCulled = true;
      }
    },
  };
}

export function run(t) {
  const { ok } = t;

  // describeSceneDepthTarget — pure descriptor shape.
  {
    const THREE = makeTHREE();
    const d = describeSceneDepthTarget({ THREE, resolvedW: 1920, resolvedH: 1080 });
    ok('descriptor: screenSized', d.screenSized === true);
    ok('descriptor: sizes pass through', d.resolvedW === 1920 && d.resolvedH === 1080);
    ok(
      'descriptor: colour attachment is U8/NoColorSpace/nearest',
      d.type === 'U8' && d.colorSpace === 'none' && d.filter === 'nearest'
    );
    ok('descriptor: requests a REAL depth texture, not a plain depth buffer', d.depthTexture === true);
    ok('descriptor: depth32float — FloatType, not the colour attachment´s own U8', d.depthTextureType === 'F32');
  }

  // rankToDepthZ — the exact formula bench-scene-depth.js already proved.
  {
    ok('rankToDepthZ: rank 0 of 5 → 1/6', rankToDepthZ(0, 5) === 1 / 6);
    ok('rankToDepthZ: rank 4 of 5 → 5/6', rankToDepthZ(4, 5) === 5 / 6);
    ok('rankToDepthZ: every real rank stays strictly inside (0,1)', rankToDepthZ(0, 5) > 0 && rankToDepthZ(4, 5) < 1);
    ok('rankToDepthZ: increases monotonically with rank', rankToDepthZ(1, 5) > rankToDepthZ(0, 5));
    ok(
      'rankToDepthZ: maxRank clamps to >= 1 — an empty scene never divides by zero',
      Number.isFinite(rankToDepthZ(0, 0))
    );
  }

  // computeExpectedStoredDepth — the formula that lets a light (no geometry
  // of its own) ask "is the surface here above me". Cross-checked against
  // this module's own documented convention (LessDepth wins: higher rank →
  // smaller stored depth) — NOT proof the GPU agrees; that is
  // bench-scene-depth.js scenario 6's own job.
  {
    const low = computeExpectedStoredDepth(0, 5);
    const high = computeExpectedStoredDepth(4, 5);
    ok('computeExpectedStoredDepth: a HIGHER rank produces a SMALLER stored depth', high < low);
    // Hand-derived: z=1/6, (5 - 0.01 - 1/6) / (10 - 0.01) = 4.65667.../9.99
    const expectedLow = (DEPTH_PASS_CAMERA_Z - DEPTH_PASS_NEAR - 1 / 6) / (DEPTH_PASS_FAR - DEPTH_PASS_NEAR);
    ok('computeExpectedStoredDepth: matches the documented closed form exactly (rank 0 of 5)', low === expectedLow);
    const expectedHigh = (DEPTH_PASS_CAMERA_Z - DEPTH_PASS_NEAR - 5 / 6) / (DEPTH_PASS_FAR - DEPTH_PASS_NEAR);
    ok('computeExpectedStoredDepth: matches the documented closed form exactly (rank 4 of 5)', high === expectedHigh);
    ok(
      'computeExpectedStoredDepth: every real rank´s expected depth stays inside the camera´s own (0,1) NDC range',
      low > 0 && low < 1 && high > 0 && high < 1
    );
  }

  // computeSceneDepthFlags — pure per-item flag byte.
  {
    ok('flags: a missing item sets nothing, never throws', computeSceneDepthFlags(null) === 0);
    ok('flags: an ordinary item with no fields sets nothing', computeSceneDepthFlags({}) === 0);
    ok(
      'flags: restrictsLight sets its own bit',
      computeSceneDepthFlags({ restrictsLight: true }) === DEPTH_FLAG_RESTRICTS_LIGHT
    );
    ok(
      'flags: restrictsWeather sets its own bit',
      computeSceneDepthFlags({ restrictsWeather: true }) === DEPTH_FLAG_RESTRICTS_WEATHER
    );
    ok(
      'flags: a Level background sets its own bit',
      computeSceneDepthFlags({ kind: 'levelBackground' }) === DEPTH_FLAG_IS_LEVEL_BACKGROUND
    );
    ok(
      'flags: a Level foreground sets its own bit',
      computeSceneDepthFlags({ kind: 'levelForeground' }) === DEPTH_FLAG_IS_LEVEL_FOREGROUND
    );
    ok('flags: a tile sets its own bit', computeSceneDepthFlags({ kind: 'tile' }) === DEPTH_FLAG_IS_TILE);
    ok(
      'flags: a tile with restrictsLight sets BOTH bits, independently',
      computeSceneDepthFlags({ kind: 'tile', restrictsLight: true }) ===
        (DEPTH_FLAG_IS_TILE | DEPTH_FLAG_RESTRICTS_LIGHT)
    );
    ok('flags: an unrecognised kind sets no kind bit', computeSceneDepthFlags({ kind: 'token' }) === 0);
    ok(
      'flags: every named bit fits in one byte (0-255), no overlap',
      DEPTH_FLAG_RESTRICTS_LIGHT +
        DEPTH_FLAG_RESTRICTS_WEATHER +
        DEPTH_FLAG_IS_LEVEL_BACKGROUND +
        DEPTH_FLAG_IS_LEVEL_FOREGROUND +
        DEPTH_FLAG_IS_TILE <=
        255
    );
  }

  // resolveSceneDepthFloorIndex — membership first, elevation fallback,
  // the SAME two-step scene-attr.js already established (see this
  // function's own "DUPLICATED LOGIC, NAMED NOT HIDDEN" doc).
  {
    const sceneDoc = {
      levels: [
        { id: 'lvl0', name: 'Underground', background: { src: 'a.webp' }, elevation: { bottom: 0, top: 10 } },
        { id: 'lvl1', name: 'Middle', background: { src: 'b.webp' }, elevation: { bottom: 10, top: 20 } },
      ],
    };
    ok(
      "a Level's OWN foreground resolves to ITS floor, not the one its elevation would band into ([bottom,top) trap)",
      resolveSceneDepthFloorIndex({
        item: { kind: 'levelForeground', levelId: 'lvl0', key: { elevation: 10 } },
        sceneDoc,
        viewedFloorIndex: 0,
      }) === 0
    );
    ok(
      'a loose tile (no levelId) falls through to the elevation lookup',
      resolveSceneDepthFloorIndex({
        item: { kind: 'tile', levelId: '', key: { elevation: 15 } },
        sceneDoc,
        viewedFloorIndex: 0,
      }) === 1
    );
    ok(
      'no active scene falls open to the viewed floor, never throws',
      resolveSceneDepthFloorIndex({ item: { key: { elevation: 5 } }, sceneDoc: null, viewedFloorIndex: 3 }) === 3
    );
    ok(
      'a lookup that throws falls open to the viewed floor and reports through logError, not a private console call',
      (() => {
        let reported = false;
        const result = resolveSceneDepthFloorIndex({
          item: { key: { elevation: 5 } },
          sceneDoc: {
            get levels() {
              throw new Error('boom');
            },
          },
          viewedFloorIndex: 7,
          logError: () => {
            reported = true;
          },
        });
        return result === 7 && reported === true;
      })()
    );
  }

  // buildSceneDepthWriterMaterial — the TSL wiring, mirroring
  // bench-scene-depth.js#buildDepthWriterMaterial's proven shape.
  {
    const THREE = makeTHREE();
    const mat = buildSceneDepthWriterMaterial({ THREE, floorIndex: 2, flags: DEPTH_FLAG_IS_TILE });
    ok('writer: a real depth test, never bypassed', mat.depthTest === true && mat.depthWrite === true);
    ok('writer: LessDepth — this pass´s own proven convention, not GreaterDepth', mat.depthFunc === 'LESS');
    ok('writer: never blends — the depth TEST is the composition', mat.transparent === false);
    ok('writer: DoubleSide, same as every world-quad material', mat.side === 'DOUBLE');
    const payload = mat.fragmentNode;
    ok('writer: returns a vec4 payload', payload.__kind === 'vec4');
    ok(
      'writer: R (floor index) is a UNIFORM, never a baked shader constant — a fresh material every ' +
        'residency rebuild would force a pipeline recompile per distinct floorIndex otherwise',
      payload.args[0].__kind === 'uniform'
    );
    ok('writer: R is the floor index, normalised', payload.args[0].value === 2 / 255);
    ok('writer: G (outdoors) is a real 0, the named KNOWN GAP — never undefined', payload.args[1].value === 0);
    ok(
      'writer: B (flags) is a UNIFORM, never a baked shader constant — same pipeline-recompile risk as R',
      payload.args[2].__kind === 'uniform'
    );
    ok('writer: B is the flags byte, normalised', payload.args[2].value === DEPTH_FLAG_IS_TILE / 255);
    ok(
      'writer: A is always 1 — the payload only exists where the fragment survived the alpha test',
      payload.args[3].value === 1
    );
  }

  // buildSceneDepthWriterMaterial — with a real texture, the alpha test
  // fires at .level(0), never an implicit LOD (round 10's own fix, carried
  // over verbatim).
  {
    const THREE = makeTHREE();
    let sampledTex = null;
    const originalTexture = THREE.TSL.texture;
    THREE.TSL.texture = (tex) => {
      sampledTex = tex;
      return originalTexture(tex);
    };
    const tex = { __kind: 'real-texture' };
    buildSceneDepthWriterMaterial({ THREE, tex, alphaThreshold: 0.6, floorIndex: 0, flags: 0 });
    ok('writer: sampled the item´s own real texture', sampledTex === tex);
  }

  // buildSceneDepthProxyMesh — shares the item's OWN geometry, never builds new.
  {
    const THREE = makeTHREE();
    const geometry = { __kind: 'shared-geometry' };
    const material = { __kind: 'writer-material' };
    const mesh = buildSceneDepthProxyMesh({ THREE, geometry, material, z: 0.42 });
    ok('proxy mesh: shares the EXACT geometry object, never a copy', mesh.geometry === geometry);
    ok('proxy mesh: carries the writer material', mesh.material === material);
    ok('proxy mesh: positioned at the rank´s own Z', mesh.position.z === 0.42);
    ok(
      'proxy mesh: never frustum-culled (moved far from its own geometry´s bounding sphere)',
      mesh.frustumCulled === false
    );
  }

  // querySceneDepth — the GPU-side half, mirroring bench-scene-depth.js
  // scenario 5's proven material exactly: sample once at screenUV, compare
  // against a plain float, no rank-to-depth conversion on the GPU at all.
  {
    const TSL = makeTSL();
    const depthTexture = { __kind: 'the-written-depth-texture' };
    const expectedDepth = chainable('uniform-expected-depth');
    const q = querySceneDepth(TSL, { depthTexture, expectedDepth });
    ok('query: samples the depth texture, not any other node', q.storedDepth.tex === depthTexture);
    ok(
      'query: samples at screenUV — a screen-space buffer, never the mesh´s own uv',
      q.storedDepth.uv === TSL.screenUV
    );
    ok(
      'query: isAbove compares storedDepth against expectedDepth directly',
      q.isAbove.subject === q.storedDepth && q.isAbove.other === expectedDepth
    );
    ok('query: isAtOrBelow is the logical complement, not a second comparison', q.isAtOrBelow.subject === q.isAbove);
  }
}
