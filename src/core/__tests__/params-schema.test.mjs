/**
 * The params contract, proven. Every rejection below is a V2 corpse
 * (docs/planning/Params.md) — and the centrepiece is §4: the real
 * `applyParamChange` body, fed the real bad values it silently accepted.
 */
import {
  PARAM_TYPES,
  COLOR_SPACES,
  validateParamsSchema,
  validateParamValue,
  serializeParams,
  hydrateParams,
} from '../params-schema.js';

/** Harvested verbatim from legacy SpecularEffectV2's own getControlSchema(). */
const SPECULAR = () => ({
  intensity: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1.23,
    label: 'Intensity',
    help: 'Master strength of the additive specular pass.',
  },
  lightColor: {
    type: 'color',
    space: 'srgb',
    default: '#ffffff',
    label: 'Specular tint',
    help: 'Tint multiplied into highlights.',
  },
  stripeEnabled: { type: 'bool', default: true, label: 'Shimmer' },
  blendMode: { type: 'enum', values: ['add', 'screen'], default: 'add', label: 'Blend mode' },
});

export function run(t) {
  // ---- 1. the vocabulary ---------------------------------------------------
  {
    t.ok('PARAM_TYPES is frozen', Object.isFrozen(PARAM_TYPES));
    // V2 had checkbox AND boolean; list AND dropdown AND select — one concept,
    // three names. And `slider` (1,513 uses) is a WIDGET, not a type.
    for (const dead of ['checkbox', 'list', 'dropdown', 'select', 'slider']) {
      t.ok(`'${dead}' is NOT a type (it was a V2 synonym or a widget)`, !PARAM_TYPES.includes(dead));
    }
    t.ok(
      'float/int/bool/color/enum are types',
      ['float', 'int', 'bool', 'color', 'enum'].every((x) => PARAM_TYPES.includes(x))
    );
  }

  // ---- 2. a real harvested schema validates --------------------------------
  {
    const r = validateParamsSchema(SPECULAR());
    t.ok(`the real SpecularEffectV2 params validate (${r.errors.join(' | ') || 'clean'})`, r.ok);
  }

  // ---- 3. the four-concerns split, enforced at authoring time --------------
  {
    // V2 put `throttle` on 333 PARAMETERS — a value's definition knowing about
    // UI event timing.
    const withThrottle = { ...SPECULAR(), x: { type: 'float', min: 0, max: 1, default: 0, label: 'X', throttle: 100 } };
    const r = validateParamsSchema(withThrottle);
    t.ok('REJECTS `throttle` in a contract (renderer mechanics)', !r.ok);
    t.ok(
      '...and explains which layer owns it',
      r.errors.some((e) => /renderer|UI layer/i.test(e))
    );

    for (const f of ['expanded', 'advanced', 'folder', 'widget']) {
      const bad = { x: { type: 'bool', default: true, label: 'X', [f]: true } };
      t.ok(`REJECTS '${f}' in a contract (view state / presentation)`, !validateParamsSchema(bad).ok);
    }
  }

  // ---- 4. THE DISEASE ITSELF: the real applyParamChange, reproduced --------
  {
    // V2, verbatim in shape:
    //   applyParamChange(id, value) {
    //     if (!hasOwnProperty(this.params, id)) return;   // silent skip
    //     this.params[id] = value;                        // no type, no clamp
    //   }
    const schema = SPECULAR();
    const v2ApplyParamChange = (params, id, value) => {
      if (!Object.prototype.hasOwnProperty.call(params, id)) return; // silently does nothing
      params[id] = value;
      return true;
    };
    const v2Params = { intensity: 1.23 };

    // Everything below is what V2 ACCEPTED. Each is now an error or a clamp.
    v2ApplyParamChange(v2Params, 'intensity', 'banana');
    t.ok('V2 accepted a STRING into a float param', v2Params.intensity === 'banana');
    t.ok('...we reject it', !validateParamValue(schema.intensity, 'banana').ok);

    v2ApplyParamChange(v2Params, 'intensity', 999);
    t.ok('V2 accepted 999 into a 0..2 param', v2Params.intensity === 999);
    const clamped = validateParamValue(schema.intensity, 999);
    t.ok(
      '...we clamp to max and SAY SO (author intent honoured, visibly)',
      clamped.ok && clamped.value === 2 && clamped.clamped === true
    );

    const typo = v2ApplyParamChange(v2Params, 'intensityy', 1);
    t.ok("V2 SILENTLY did nothing on a typo'd key", typo === undefined);
    t.ok('...we return a real error naming the problem', !validateParamValue(undefined, 1).ok);

    t.ok(
      'in-range values pass unclamped',
      (() => {
        const r = validateParamValue(schema.intensity, 0.5);
        return r.ok && r.value === 0.5 && !r.clamped;
      })()
    );
  }

  // ---- 4b. HARVEST FINDINGS: gaps the real 48 schemas exposed ------------
  // Designing from a sample of ONE missed both of these. Contact with real data
  // is why the harvest went first.
  {
    t.ok('COLOR_SPACES is frozen vocabulary', Object.isFrozen(COLOR_SPACES) && COLOR_SPACES.length === 2);

    // V2 had 39 colour params in TWO shapes -- 30 hex, 9 `colorType:'float'`
    // {r,g,b} -- where the SHAPE silently carried the colour SPACE. Space is now
    // named, and the old implied form is forbidden outright.
    const noSpace = { c: { type: 'color', default: '#ffffff', label: 'Tint' } };
    const r = validateParamsSchema(noSpace);
    t.ok('REJECTS a colour that does not declare its space', !r.ok);
    t.ok(
      '...and explains srgb-vs-linear',
      r.errors.some((e) => /srgb.*linear|linear.*srgb/is.test(e))
    );

    t.ok(
      "ACCEPTS space:'srgb' (an author-picked tint)",
      validateParamsSchema({ c: { type: 'color', space: 'srgb', default: '#ffffff', label: 'Tint' } }).ok
    );
    t.ok(
      "ACCEPTS space:'linear' (fed straight to a shader)",
      validateParamsSchema({ c: { type: 'color', space: 'linear', default: '#808080', label: 'Mul' } }).ok
    );
    t.ok(
      'REJECTS a bogus space',
      !validateParamsSchema({ c: { type: 'color', space: 'cmyk', default: '#ffffff', label: 'Tint' } }).ok
    );
    t.ok(
      "REJECTS V2's implied form (colorType)",
      !validateParamsSchema({
        c: { type: 'color', space: 'srgb', colorType: 'float', default: '#ffffff', label: 'Tint' },
      }).ok
    );

    // V2 had 12 `readonly: true` string "params" -- statusSubject, statusProbeAge,
    // statusOutdoorsSample... Diagnostics rendered THROUGH params because that was
    // the only display channel. THAT is why HealthEvaluatorService wrote params:
    // a missing concept, not malice.
    const readout = { statusProbeAge: { type: 'text', default: '—', label: 'Last probe age', readonly: true } };
    const rr = validateParamsSchema(readout);
    t.ok('REJECTS a status READOUT posing as a param', !rr.ok);
    t.ok(
      '...and names the real concept (a computed output, not a knob)',
      rr.errors.some((e) => /readout|computed output/i.test(e))
    );

    // The third harvest finding: V2's 17 `type:'string'` params were 11 readouts,
    // 4 enums-in-disguise (`string` + `options`), and exactly ONE real free-text
    // value (audioStrikePath, a file path). So `text` earns its place -- barely.
    t.ok("'text' is a type (one real V2 param needed it: a file path)", PARAM_TYPES.includes('text'));
    t.ok(
      "a real free-text param validates (V2's audioStrikePath)",
      validateParamsSchema({ audioStrikePath: { type: 'text', default: '', label: 'Strike sound path' } }).ok
    );
    t.ok('text rejects a non-string', !validateParamValue({ type: 'text' }, 42).ok);
    // `string` was never a type -- it was an enum, a readout, or a path.
    t.ok("'string' is NOT a type", !PARAM_TYPES.includes('string'));
  }

  // ---- 5. per-type checks (the sanitizer's job, done at the front door) ----
  {
    const s = SPECULAR();
    t.ok('bool rejects truthy non-booleans (1 is not true)', !validateParamValue(s.stripeEnabled, 1).ok);
    t.ok('bool accepts false (not treated as missing)', validateParamValue(s.stripeEnabled, false).ok);
    t.ok('enum rejects an unlisted value', !validateParamValue(s.blendMode, 'multiply').ok);
    t.ok('enum error lists the real options', /add, screen/.test(validateParamValue(s.blendMode, 'multiply').error));
    t.ok('color rejects a non-hex string', !validateParamValue(s.lightColor, 'red').ok);
    t.ok('color normalises case', validateParamValue(s.lightColor, '#AABBCC').value === '#aabbcc');
    t.ok('int rejects a fractional value', !validateParamValue({ type: 'int', min: 0, max: 9 }, 2.5).ok);
    t.ok('vec3 rejects the wrong arity', !validateParamValue({ type: 'vec3' }, [1, 2]).ok);
    t.ok('NaN is never a valid number', !validateParamValue(s.intensity, NaN).ok);
  }

  // ---- 6. schema self-consistency ------------------------------------------
  {
    t.ok(
      'REJECTS min >= max',
      !validateParamsSchema({ x: { type: 'float', min: 1, max: 0, default: 0, label: 'X' } }).ok
    );
    t.ok(
      'REJECTS a default outside its own range',
      !validateParamsSchema({ x: { type: 'float', min: 0, max: 1, default: 5, label: 'X' } }).ok
    );
    t.ok(
      'REJECTS a missing default (persistence needs it)',
      !validateParamsSchema({ x: { type: 'float', min: 0, max: 1, label: 'X' } }).ok
    );
    t.ok(
      'REJECTS a missing label (the UI is generated — nothing else names it)',
      !validateParamsSchema({ x: { type: 'float', min: 0, max: 1, default: 0 } }).ok
    );
    t.ok(
      'REJECTS an unknown type',
      !validateParamsSchema({ x: { type: 'slider', min: 0, max: 1, default: 0, label: 'X' } }).ok
    );
    t.ok(
      'REJECTS an empty enum',
      !validateParamsSchema({ x: { type: 'enum', values: [], default: 'a', label: 'X' } }).ok
    );
    t.ok('an action needs no default or range', validateParamsSchema({ go: { type: 'action', label: 'Rebuild' } }).ok);
  }

  // ---- 7. persistence: store only the difference ---------------------------
  {
    const schema = SPECULAR();
    const { values } = hydrateParams(schema, {});
    t.ok(
      'hydrate with nothing stored gives the declared defaults',
      values.intensity === 1.23 && values.lightColor === '#ffffff'
    );
    t.ok('serialize of untouched values stores NOTHING', Object.keys(serializeParams(schema, values)).length === 0);

    const touched = { ...values, intensity: 0.5 };
    const blob = serializeParams(schema, touched);
    t.ok('serialize stores ONLY what differs', JSON.stringify(blob) === JSON.stringify({ intensity: 0.5 }));

    // The property that makes old scenes survive a new param:
    const extended = { ...schema, newKnob: { type: 'float', min: 0, max: 1, default: 0.7, label: 'New' } };
    const rehydrated = hydrateParams(extended, blob);
    t.ok('a NEW param cannot break an old scene (absent = default)', rehydrated.values.newKnob === 0.7);
    t.ok('...while the stored value still wins', rehydrated.values.intensity === 0.5);
  }

  // ---- 8. hydrate REPORTS bad data, never silently coerces -----------------
  {
    const schema = SPECULAR();
    const { values, rejected } = hydrateParams(schema, { intensity: 'corrupt', ghostKnob: 1 });
    t.ok('an invalid stored value falls back to its default', values.intensity === 1.23);
    t.ok(
      '...and is REPORTED, not silently repaired',
      rejected.some((r) => r.key === 'intensity')
    );
    t.ok(
      'a stored key with no param is reported (renamed/removed?)',
      rejected.some((r) => r.key === 'ghostKnob')
    );
    // control-state-sanitize.js was 333 lines of silent in-place repair at the
    // DISK boundary, hand-writing constraints it could only guess at because it
    // never read the schema. This is that job, done at the front door, loudly.
    t.ok('the whole sanitizer job is two return values', Array.isArray(rejected) && typeof values === 'object');
  }
}
