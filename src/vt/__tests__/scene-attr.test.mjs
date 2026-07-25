/**
 * Node verification for vt/scene-attr.js.
 *
 * TSL node construction is inherently GPU/browser-only (CONVENTIONS.md §4) —
 * these tests verify the JS-level WIRING (which descriptor fields are set,
 * which TSL functions get called with what), not shader correctness. A
 * minimal mock TSL stands in: each function returns a plain marker object
 * recording its own call, so assertions read the SHAPE of what was built.
 */
import { describeSceneAttrMrt, buildSceneAttrZeroMrt, packFloorAttr } from '../scene-attr.js';

function makeTSL() {
  return {
    mrt: (outputs) => ({ __kind: 'mrt', outputs }),
    output: { __kind: 'output-symbol' },
    vec4: (...args) => ({ __kind: 'vec4', args }),
    float: (v) => ({ __kind: 'float', value: v }),
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
}
