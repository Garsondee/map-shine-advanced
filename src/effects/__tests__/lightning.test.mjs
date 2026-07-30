/**
 * lightning.test.mjs — the lightning bolt is a valid, registrable effect
 * DECLARATION, and — the single most safety-critical assertion in this whole
 * effect — its accessibility hard override actually wins over every other
 * layer. Mirrors candle-flame.test.mjs's own shape.
 */
import { validateParamsSchema } from '../../core/params-schema.js';
import { validateEffectManifest } from '../effect-manifest.js';
import { createEffectRegistry } from '../registry.js';
import { resolveEffectEnabled } from '../effect-cascade.js';
import { LIGHTNING, LIGHTNING_PARAMS } from '../lightning.js';

export function run(t) {
  const { ok, throws } = t;

  // --- the declaration validates ------------------------------------------
  ok('LIGHTNING_PARAMS is a valid params schema', validateParamsSchema(LIGHTNING_PARAMS).ok);
  ok('LIGHTNING is a valid manifest', validateEffectManifest(LIGHTNING).ok);
  ok("the effect's id is lightning", LIGHTNING.id === 'lightning');

  // --- a11y — the non-negotiable one --------------------------------------
  ok('lightning DOES flash (a11y photosensitive true)', LIGHTNING.a11y.photosensitive === true);
  ok(
    'a player who asked to reduce photosensitive effects is force-disabled, beating a GM "on"',
    resolveEffectEnabled(LIGHTNING, {
      profile: 'standard',
      gmEnable: 'on',
      playerEnable: 'on',
      reducePhotosensitive: true,
    }) === false
  );
  ok(
    'the SAME force-off beats even the PLAYER trying to turn it on themselves',
    resolveEffectEnabled(LIGHTNING, { profile: 'standard', playerEnable: 'on', reducePhotosensitive: true }) === false
  );
  ok(
    'with reducePhotosensitive OFF, the same layers resolve the effect ON',
    resolveEffectEnabled(LIGHTNING, {
      profile: 'standard',
      gmEnable: 'on',
      playerEnable: 'on',
      reducePhotosensitive: false,
    }) === true
  );

  // --- default ON, cheap bolts at every profile ---------------------------
  ok('gated to low → on even at Low', LIGHTNING.enabledFromProfile === 'low');
  ok('resolves ON at Low by default', resolveEffectEnabled(LIGHTNING, { profile: 'low' }) === true);
  ok('resolves ON at Standard by default', resolveEffectEnabled(LIGHTNING, { profile: 'standard' }) === true);
  ok(
    'a player can still turn it OFF (final say, absent the a11y override)',
    resolveEffectEnabled(LIGHTNING, { profile: 'low', playerEnable: 'off' }) === false
  );

  // --- look knobs, and what is NOT a knob ---------------------------------
  ok('the outer colour declares its space (srgb)', LIGHTNING_PARAMS.outerColor.space === 'srgb');
  ok('the core colour declares its space (srgb)', LIGHTNING_PARAMS.coreColor.space === 'srgb');
  ok("'enabled' is NOT a param (resolved by the cascade)", !('enabled' in LIGHTNING_PARAMS));
  ok('audio params were dropped, not carried forward as dead knobs', !('audioEnabled' in LIGHTNING_PARAMS));
  ok('overheadOrder was dropped (deferred rung, no live draw-order hook yet)', !('overheadOrder' in LIGHTNING_PARAMS));
  ok('zOffset was dropped (no paint-order effect under depthTest:false)', !('zOffset' in LIGHTNING_PARAMS));

  // --- V2-inspired defaults, spot-checked ---------------------------------
  ok('brightness default matches V2 (5)', LIGHTNING_PARAMS.brightness.default === 5);
  ok('minDelayMs default matches V2 (5000)', LIGHTNING_PARAMS.minDelayMs.default === 5000);
  ok('maxDelayMs default matches V2 (10000)', LIGHTNING_PARAMS.maxDelayMs.default === 10000);
  ok('burstMinStrikes default matches V2 (7)', LIGHTNING_PARAMS.burstMinStrikes.default === 7);
  ok('burstMaxStrikes default matches V2 (16)', LIGHTNING_PARAMS.burstMaxStrikes.default === 16);
  ok('wildArcChance default matches V2 (0, off)', LIGHTNING_PARAMS.wildArcChance.default === 0);
  ok('windDriftStrength default matches V2 (0, off)', LIGHTNING_PARAMS.windDriftStrength.default === 0);
  ok('originFlashAnchor default matches V2 (start)', LIGHTNING_PARAMS.originFlashAnchor.default === 'start');

  // --- it flows through the ONE door --------------------------------------
  {
    const reg = createEffectRegistry();
    let applied = null;
    const id = reg.register(LIGHTNING, (r) => {
      applied = r;
    });
    ok('register returns the lightning id', id === 'lightning');
    const resolved = reg.resolveAndApply('lightning', { profile: 'standard' });
    ok('resolveAndApply drives the lightning apply', applied !== null && applied.enabled === true);
    ok(
      'the resolved params carry the look defaults',
      resolved.params.brightness === 5 && resolved.params.outerColor === '#0037ff'
    );
    throws('a duplicate lightning registration throws', () => reg.register(LIGHTNING, () => {}), 'already registered');
  }
}
