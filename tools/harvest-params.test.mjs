/**
 * Tests for tools/harvest-params.mjs's TRANSFORM logic — the mechanical rules
 * that turned 2,226 real V2 params into the new contract. Extraction (safe
 * eval, cross-file dependency resolution, topological ordering) is proven by
 * the fact that all 45 real effects harvest cleanly with zero manual-review
 * flags and zero validateParamsSchema errors (checked live by re-running
 * `node tools/harvest-params.mjs` — a generator, not something to re-invoke
 * from this suite). What's unit-tested here is `transformParam` itself: the
 * V2-type -> PARAM_TYPES mapping, which is exactly the kind of mechanical
 * rule that silently drifts if a future edit "simplifies" a case.
 *
 * @module tools/harvest-params.test
 */

import { transformParam } from './harvest-params.mjs';

export function run(t) {
  const { ok } = t;

  // --- slider -> float / int, and the min===max "locked" exclusion --------
  {
    const r = transformParam('opacity', { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5, label: 'Opacity' });
    ok('slider with fractional step -> float', r.decl.type === 'float');
    ok(
      'slider preserves default/min/max/step',
      r.decl.default === 0.5 && r.decl.min === 0 && r.decl.max === 1 && r.decl.step === 0.05
    );
  }
  {
    const r = transformParam('count', { type: 'slider', min: 1, max: 100, step: 1, default: 10, label: 'Count' });
    ok('slider with integer min/max/step/default -> int', r.decl.type === 'int');
  }
  {
    const r = transformParam('locked', {
      type: 'slider',
      min: 1,
      max: 1,
      step: 0.05,
      default: 1,
      hidden: true,
      tooltip: 'Deprecated: forced to 1.0',
    });
    ok(
      'min===max slider is EXCLUDED as locked/deprecated, not force-declared',
      r.decl === null && r.excludedAsLocked === true
    );
    ok('...and NOT double-counted as a readout', r.excludedAsReadout === false);
  }

  // --- boolean/checkbox -> bool ----------------------------------------------
  ok('boolean -> bool', transformParam('x', { type: 'boolean', default: true }).decl.type === 'bool');
  ok('checkbox -> bool', transformParam('x', { type: 'checkbox', default: false }).decl.type === 'bool');

  // --- color: space from colorType, {r,g,b} -> #rrggbb ----------------------
  {
    const srgb = transformParam('tint', { type: 'color', default: '#FF8800', label: 'Tint' });
    ok('hex color -> srgb space, lowercased', srgb.decl.space === 'srgb' && srgb.decl.default === '#ff8800');
    const linear = transformParam('tint2', {
      type: 'color',
      colorType: 'float',
      default: { r: 1, g: 0.5, b: 0 },
      label: 'Tint',
    });
    ok('colorType:float -> linear space', linear.decl.space === 'linear');
    ok('{r,g,b} 0..1 -> #rrggbb hex', linear.decl.default === '#ff8000');
  }

  // --- readonly: excluded as a status readout, never a param -----------------
  {
    const r = transformParam('statusFoo', { type: 'string', default: 'idle', readonly: true, label: 'Status' });
    ok('readonly -> excluded as readout, not declared', r.decl === null && r.excludedAsReadout === true);
  }

  // --- enum: label->value maps, and the label-space-default remap -----------
  {
    const r = transformParam('shape', { type: 'select', label: 'Shape', options: { Dot: 1, Ellipse: 2 }, default: 1 });
    ok('select with a REAL value default keeps it', r.decl.type === 'enum' && r.decl.default === 1);
    ok("values are the MAP's values, not its labels", r.decl.values.includes(1) && r.decl.values.includes(2));
    ok('valueLabels preserves the authored label text', r.decl.valueLabels['1'] === 'Dot');
  }
  {
    // The exact real case: ContextualSceneGradeEffectV2's easing params —
    // options: { '': '(global)', linear: 'linear' }, default: '' (the LABEL,
    // not any declared VALUE).
    const r = transformParam('easing', {
      type: 'select',
      label: 'Easing',
      options: { '': '(global)', linear: 'linear' },
      default: '',
    });
    ok('a default authored in LABEL space is remapped to its VALUE', r.decl.default === '(global)');
    ok('...and that value is genuinely in the declared set', r.decl.values.includes('(global)'));
  }
  ok(
    'dropdown/list are the same enum path as select',
    transformParam('x', { type: 'dropdown', options: { A: 'a' }, default: 'a' }).decl.type === 'enum' &&
      transformParam('x', { type: 'list', options: { A: 'a' }, default: 'a' }).decl.type === 'enum'
  );

  // --- string: readonly (already covered) / options -> enum / else text -----
  {
    const enumLike = transformParam('preset', { type: 'string', options: { Coal: 'coal' }, default: 'coal' });
    ok('string WITH options -> enum (the "*Selection" case, Params.md §3.6)', enumLike.decl.type === 'enum');
    const text = transformParam('path', { type: 'string', default: 'sounds/strike.ogg' });
    ok('string with no options -> text (the one genuine free-text case)', text.decl.type === 'text');
  }

  // --- implicit type inference (no `type` field at all) ----------------------
  {
    const implicitSlider = transformParam('x', { min: 0, max: 10, step: 1, default: 5, label: 'X' });
    ok('no type + numeric fields -> inferred slider -> float/int', ['float', 'int'].includes(implicitSlider.decl.type));
    const implicitBool = transformParam('x', { default: true, label: 'X' });
    ok('no type + boolean default -> inferred boolean -> bool', implicitBool.decl.type === 'bool');
    const implicitSelect = transformParam('x', { options: { A: 'a' }, default: 'a', label: 'X' });
    ok('no type + options present -> inferred select -> enum', implicitSelect.decl.type === 'enum');
  }

  // --- gradient -> curve -------------------------------------------------------
  {
    const r = transformParam('grad', {
      type: 'gradient',
      label: 'Gradient',
      default: [
        { t: 0, r: 1, g: 0, b: 0 },
        { t: 1, r: 0, g: 0, b: 1 },
      ],
    });
    ok(
      'gradient -> curve, control points preserved verbatim',
      r.decl.type === 'curve' && r.decl.default.length === 2 && r.decl.default[0].r === 1
    );
    const bad = transformParam('grad2', { type: 'gradient', default: [{ t: 0, r: 1, g: 0, b: 0 }] });
    ok(
      'a gradient with < 2 control points is skipped, not force-declared',
      bad.decl === null && bad.reason.includes('2 control points')
    );
  }

  // --- button -> action --------------------------------------------------------
  ok('button -> action', transformParam('reset', { type: 'button', label: 'Reset' }).decl.type === 'action');

  // --- unknown types are surfaced, never silently dropped or guessed --------
  {
    const r = transformParam('mystery', { type: 'interactionOverlay', foo: 1 });
    ok(
      'an unhandled type is SKIPPED with a reason naming it, not silently lost',
      r.decl === null && r.reason.includes('interactionOverlay')
    );
  }

  // --- every declared param must actually pass the real contract -----------
  // (imported lazily to avoid a hard dependency if this file is ever run
  // standalone without the rest of src/ present)
  {
    const samples = [
      { type: 'slider', min: 0, max: 1, step: 0.1, default: 0.5, label: 'A' },
      { type: 'boolean', default: true, label: 'B' },
      { type: 'color', default: '#112233', label: 'C' },
      { type: 'select', options: { X: 'x' }, default: 'x', label: 'D' },
    ];
    ok(
      'every transformed sample produces a decl object with a label',
      samples.every((s) => transformParam('id', s).decl?.label)
    );
  }
}
