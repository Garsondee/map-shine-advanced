/**
 * Node verification for vt/scene-attr.js.
 *
 * TSL node construction is inherently GPU/browser-only (CONVENTIONS.md §4) —
 * these tests verify the JS-level WIRING (which descriptor fields are set,
 * which TSL functions get called with what), not shader correctness. A
 * minimal mock TSL stands in: each function returns a plain marker object
 * recording its own call, so assertions read the SHAPE of what was built.
 */
import {
  describeSceneAttrMrt,
  buildSceneAttrZeroMrt,
  packFloorAttr,
  buildRealFloorAttrMrtNode,
} from '../scene-attr.js';

// A real (not swizzle-capable) plain object standing in for `output.a` —
// distinct identity from the bare `output` symbol so a test can tell whether
// a node came from `output.a` specifically, not just "some node".
const OUTPUT_ALPHA_SWIZZLE = { __kind: 'output-alpha-swizzle' };

function makeTSL() {
  return {
    mrt: (outputs) => ({ __kind: 'mrt', outputs }),
    output: { __kind: 'output-symbol', a: OUTPUT_ALPHA_SWIZZLE },
    vec4: (...args) => ({ __kind: 'vec4', args }),
    float: (v) => ({ __kind: 'float', value: v }),
    uniform: (v) => ({ __kind: 'uniform', value: v?.value }),
  };
}

function makeTHREE() {
  return {
    HalfFloatType: 'F16',
    UnsignedByteType: 'U8',
    NoColorSpace: 'none',
    TSL: makeTSL(),
  };
}

export function run(t) {
  const { ok } = t;

  // describeSceneAttrMrt — pure descriptor shape, no TSL involved.
  {
    const THREE = makeTHREE();
    const d = describeSceneAttrMrt({ THREE, resolvedW: 1920, resolvedH: 1080 });
    ok('descriptor: screenSized', d.screenSized === true);
    ok('descriptor: sizes pass through', d.resolvedW === 1920 && d.resolvedH === 1080);
    ok('descriptor: attachment 0 color unchanged (HalfFloat)', d.type === 'F16');
    ok('descriptor: no depth (unified pass has none)', d.depth === false);
    ok('descriptor: mrtCount 2', d.mrtCount === 2);
    ok('descriptor: 2 attachment entries', Array.isArray(d.attachments) && d.attachments.length === 2);
    ok('descriptor: attachment[0] named "output" verbatim', d.attachments[0].outputName === 'output');
    ok('descriptor: attachment[1] named "attr" verbatim', d.attachments[1].outputName === 'attr');
    ok('descriptor: attr is nearest', d.attachments[1].filter === 'nearest');
    ok('descriptor: attr is 8-bit unsigned', d.attachments[1].type === 'U8');
    ok('descriptor: attr is NoColorSpace (a data buffer, never sRGB)', d.attachments[1].colorSpace === 'none');
  }

  // buildSceneAttrZeroMrt — the renderer-global safe default.
  {
    const THREE = makeTHREE();
    const node = buildSceneAttrZeroMrt(THREE);
    ok('zero-mrt: built via mrt()', node.__kind === 'mrt');
    ok('zero-mrt: keeps the material\'s own "output" symbol untouched', node.outputs.output.__kind === 'output-symbol');
    ok('zero-mrt: attr is a vec4(0,0,0,0) — exact zero, not a partial value', node.outputs.attr.__kind === 'vec4');
    ok(
      'zero-mrt: all four components are literal 0',
      node.outputs.attr.args.length === 4 && node.outputs.attr.args.every((a) => a === 0)
    );
  }

  // packFloorAttr — the real-writer channel pack.
  {
    const TSL = makeTSL();
    const floorIndex01 = { __kind: 'uniform-floor' };
    const outdoors01 = { __kind: 'gate-result' };
    const presenceBits01 = { __kind: 'uniform-presence' };
    const solidityAlpha = { __kind: 'material-alpha' };
    const packed = packFloorAttr(TSL, { floorIndex01, outdoors01, presenceBits01, solidityAlpha });
    ok('pack: returns a vec4', packed.__kind === 'vec4');
    ok(
      'pack: channel order is R,G,B,A = floor,outdoors,presence,solidity',
      packed.args[0] === floorIndex01 &&
        packed.args[1] === outdoors01 &&
        packed.args[2] === presenceBits01 &&
        packed.args[3] === solidityAlpha
    );

    // No outdoors mask available (e.g. a floor with none authored) — G reads
    // as a real "indoors" 0, not a compiled-out gap. Per the module's own
    // doc: this is real per-pixel DATA, not a feature toggle, so it must
    // never disappear the way a JS-time tier gate would.
    const packedNoOutdoors = packFloorAttr(TSL, {
      floorIndex01,
      outdoors01: null,
      presenceBits01,
      solidityAlpha,
    });
    ok('pack: null outdoors becomes a real float(0), not undefined', packedNoOutdoors.args[1].__kind === 'float');
    ok('pack: that float is exactly 0', packedNoOutdoors.args[1].value === 0);
  }

  // buildRealFloorAttrMrtNode — REGRESSION for the live crash (2026-07-25):
  // the first draft took `solidityAlpha` as a caller-supplied param, fed by a
  // JS closure variable set INSIDE a material's `Fn(() => {...})()` body.
  // `Fn(cb)()` does not run `cb` synchronously — it returns a lazy call node
  // and `cb` only runs later, at actual shader-compile time — so the closure
  // variable was still `null` the instant this function ran, and every
  // whole-image tile failed to load (`vec4(...)` received a literal `null`).
  // The fix reads `TSL.output.a` instead — this test proves that's still
  // true, so the exact bug can't silently come back via a future edit that
  // reintroduces a `solidityAlpha` parameter.
  {
    const THREE = makeTHREE();
    // sceneDoc: null -> getActiveSceneFloors(null) hits its own real,
    // deterministic "no active scene" branch (verified against foundry/
    // active-scene-source.js) — exercises resolveItemFloorAttrUniforms'
    // actual fail-open path for real, no mock needed for that half.
    const node = buildRealFloorAttrMrtNode({
      THREE,
      item: { key: { elevation: 0 } },
      viewedFloorIndex: 0,
      sceneDoc: null,
      logError: () => {},
      envLight: { uOutdoorsRect: null, outdoorsTexNode: null },
    });
    ok('real-writer: built via mrt()', node.__kind === 'mrt');
    const attr = node.outputs.attr;
    ok('real-writer: attr is a vec4', attr.__kind === 'vec4');
    ok(
      'real-writer: solidity (arg 3) IS TSL.output.a — never a param, never null/undefined',
      attr.args[3] === OUTPUT_ALPHA_SWIZZLE
    );
    ok(
      'real-writer: solidity is not the bare output symbol either (it must be the .a swizzle)',
      attr.args[3] !== THREE.TSL.output
    );
  }
}
