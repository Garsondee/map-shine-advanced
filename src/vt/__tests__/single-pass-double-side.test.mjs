/**
 * single-pass-double-side.test.mjs — no transparent DoubleSide material is drawn (and compiled) twice
 * (2026-11-07, mmp-a5e.14). See vt/single-pass-double-side.js for the trap.
 */
import { DOUBLE_SIDE, installSinglePassDoubleSide, isTwoPassMaterial } from '../single-pass-double-side.js';

/** A renderer whose renderObject applies three's own two-pass rule and records each pass's side. */
function fakeRenderer() {
  const passes = [];
  const renderer = {
    renderObject(object, scene, camera, geometry, material) {
      if (material.transparent === true && material.side === DOUBLE_SIDE && material.forceSinglePass === false) {
        material.side = 1;
        passes.push(1);
        material.side = 0;
        passes.push(0);
        material.side = DOUBLE_SIDE;
      } else passes.push(material.side);
      return this === renderer ? 'drawn' : 'wrong-this';
    },
  };
  return { renderer, passes };
}

const mat = (o) => ({
  transparent: true,
  side: DOUBLE_SIDE,
  forceSinglePass: false,
  name: '',
  type: 'NodeMaterial',
  ...o,
});

export function run(t) {
  const { ok } = t;

  ok('a transparent DoubleSide material is two-pass', isTwoPassMaterial(mat()));
  ok('...an opaque one is not', !isTwoPassMaterial(mat({ transparent: false })));
  ok('...a FrontSide one is not', !isTwoPassMaterial(mat({ side: 0 })));
  ok('...one already single-pass is not', !isTwoPassMaterial(mat({ forceSinglePass: true })));
  ok('...null is not', !isTwoPassMaterial(null));

  {
    const { renderer, passes } = fakeRenderer();
    const before = mat({ name: 'unwrapped' });
    renderer.renderObject({}, {}, {}, {}, before);
    ok('the trap, as three has it: without the wrap a transparent DoubleSide quad draws twice', passes.length === 2);

    passes.length = 0;
    const gate = installSinglePassDoubleSide(renderer);
    const m = mat({ name: 'illum quad' });
    const out = renderer.renderObject({}, {}, {}, {}, m);
    ok('with the wrap it draws once, as DoubleSide (culling off)', passes.length === 1 && passes[0] === DOUBLE_SIDE);
    ok("three's result and `this` pass through", out === 'drawn');
    ok('the material is marked single-pass and keeps its side', m.forceSinglePass === true && m.side === DOUBLE_SIDE);
    renderer.renderObject({}, {}, {}, {}, m);
    ok('a second draw is not counted again', gate.report().converted === 1);
    ok('the report names it', gate.report().names[0] === 'illum quad' && gate.report().installed === true);

    const opaque = mat({ transparent: false });
    renderer.renderObject({}, {}, {}, {}, opaque);
    ok(
      'an opaque DoubleSide material is left alone',
      opaque.forceSinglePass === false && gate.report().converted === 1
    );

    const override = mat({ name: 'depth override' });
    renderer.renderObject({}, { overrideMaterial: override }, {}, {}, mat({ transparent: false }));
    ok("a scene's overrideMaterial is converted too", override.forceSinglePass === true);

    gate.uninstall();
    passes.length = 0;
    renderer.renderObject({}, {}, {}, {}, mat());
    ok("uninstall puts three's renderObject back", passes.length === 2 && gate.report().installed === false);
  }

  {
    const gate = installSinglePassDoubleSide({});
    ok('a renderer without renderObject is left alone and says so', gate.report().installed === false);
  }
}
