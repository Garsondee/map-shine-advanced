/**
 * candle-flame.test.mjs — the candle is a valid, registrable effect DECLARATION.
 * The registration MACHINERY is proven in effect-registration.test.mjs; this
 * pins the candle's own shape and that it flows through the one door. The
 * effect id 'candleFlame' MUST equal the anchor kind's effectId (scene/anchor-
 * catalog.js) — pinned on each side to the same literal (a cross-zone import
 * would trip zones/one-door), so a drift there is caught in review, not in play.
 */
import { validateParamsSchema } from '../../core/params-schema.js';
import { validateEffectManifest } from '../effect-manifest.js';
import { createEffectRegistry } from '../registry.js';
import { resolveEffectEnabled } from '../effect-cascade.js';
import { CANDLE_FLAME, CANDLE_FLAME_PARAMS } from '../candle-flame.js';

export function run(t) {
  const { ok, throws } = t;

  // --- the declaration validates ------------------------------------------
  ok('CANDLE_FLAME_PARAMS is a valid params schema', validateParamsSchema(CANDLE_FLAME_PARAMS).ok);
  ok('CANDLE_FLAME is a valid manifest', validateEffectManifest(CANDLE_FLAME).ok);
  ok("the effect's id is candleFlame (== the anchor kind's effectId)", CANDLE_FLAME.id === 'candleFlame');
  ok('the candle does not flash (a11y photosensitive false)', CANDLE_FLAME.a11y.photosensitive === false);

  // --- default ON: cheap teardrop markers, so on at every profile ---------
  ok('gated to low → on even at Low', CANDLE_FLAME.enabledFromProfile === 'low');
  ok('resolves ON at Low by default', resolveEffectEnabled(CANDLE_FLAME, { profile: 'low' }) === true);
  ok('resolves ON at Standard by default', resolveEffectEnabled(CANDLE_FLAME, { profile: 'standard' }) === true);
  ok(
    'a player can still turn it OFF (final say)',
    resolveEffectEnabled(CANDLE_FLAME, { profile: 'low', playerEnable: 'off' }) === false
  );

  // --- look knobs, and what is NOT a knob ---------------------------------
  ok('the flame colour declares its space (srgb)', CANDLE_FLAME_PARAMS.color.space === 'srgb');
  ok('per-anchor intensity is NOT an effect param (it lives on the anchor)', !('intensity' in CANDLE_FLAME_PARAMS));
  ok("'enabled' is NOT a param (resolved by the cascade)", !('enabled' in CANDLE_FLAME_PARAMS));

  // --- it flows through the ONE door (the velocity test in miniature) -----
  {
    const reg = createEffectRegistry();
    let applied = null;
    const id = reg.register(CANDLE_FLAME, (r) => {
      applied = r;
    });
    ok('register returns the candle id', id === 'candleFlame');
    const resolved = reg.resolveAndApply('candleFlame', { profile: 'standard' });
    ok('resolveAndApply drives the candle apply', applied !== null && applied.enabled === true);
    // ⚠️ `color` is asserted against the SCHEMA rather than a repeated literal.
    // It was hardcoded `'#ffaa00'` here, which is a second copy of a value the
    // schema already owns — so retuning the flame's palette (2026-08-06, to the
    // author's reference art) failed this test for no reason other than the
    // duplication. What is worth pinning is that the cascade RESOLVES the
    // declared default, not what that default happens to be this month.
    ok(
      'the resolved params carry the look defaults',
      resolved.params.sizePx === 24 &&
        resolved.params.color === CANDLE_FLAME_PARAMS.color.default &&
        resolved.params.lightRadiusPx === 400
    );
    ok('the flame colour default is a valid #rrggbb', /^#[0-9a-f]{6}$/i.test(CANDLE_FLAME_PARAMS.color.default));
    throws('a duplicate candle registration throws', () => reg.register(CANDLE_FLAME, () => {}), 'already registered');
  }
}
