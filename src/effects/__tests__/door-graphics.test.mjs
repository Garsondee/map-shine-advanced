/**
 * door-graphics.test.mjs — the door-graphics DECLARATION (manifest + params) as
 * data, validated in Node exactly like the sibling effect declarations. The
 * live render wiring (vt/vt-pan-viewer.js) and the Foundry read are browser-only.
 */
import { validateParamsSchema } from '../../core/params-schema.js';
import { validateEffectManifest } from '../effect-manifest.js';
import { resolveEffectParams, resolveEffectEnabled } from '../effect-cascade.js';
import { DOOR_GRAPHICS, DOOR_GRAPHICS_PARAMS } from '../door-graphics.js';

export function run(t) {
  const { ok } = t;

  // The declaration validates.
  ok('DOOR_GRAPHICS_PARAMS is a valid params schema', validateParamsSchema(DOOR_GRAPHICS_PARAMS).ok);
  ok('DOOR_GRAPHICS is a valid manifest', validateEffectManifest(DOOR_GRAPHICS).ok);
  ok('the effect id is doorGraphics', DOOR_GRAPHICS.id === 'doorGraphics');
  ok('a door is not photosensitive (no strobe)', DOOR_GRAPHICS.a11y.photosensitive === false);

  // DEFAULT ON — a door is structural map look, on at every profile (like the candle).
  ok('doors are gated from the lowest profile (default on)', DOOR_GRAPHICS.enabledFromProfile === 'low');
  ok('doors are ON even at the Low profile', resolveEffectEnabled(DOOR_GRAPHICS, { profile: 'low' }) === true);
  ok(
    'a GM can still turn doors off',
    resolveEffectEnabled(DOOR_GRAPHICS, { profile: 'low', gmEnable: 'off' }) === false
  );

  // 'enabled' is resolved by the cascade, never a param; readouts are not params.
  ok("'enabled' is NOT a param (the cascade resolves it)", !('enabled' in DOOR_GRAPHICS_PARAMS));

  // The motion knobs default to Foundry-faithful behaviour.
  const noLayers = resolveEffectParams(DOOR_GRAPHICS_PARAMS, []);
  ok('animation is ON by default', noLayers.values.animateMotion === true);
  ok("duration scale defaults to 1 (Foundry's own timing)", noLayers.values.motionDurationScale === 1);
  ok('nothing rejected with no layers', noLayers.rejected.length === 0);

  const overridden = resolveEffectParams(DOOR_GRAPHICS_PARAMS, [{ animateMotion: false, motionDurationScale: 0.5 }]);
  ok(
    'a layer can disable animation and speed it up',
    overridden.values.animateMotion === false && overridden.values.motionDurationScale === 0.5
  );
  // Out-of-range numbers CLAMP (honour the "louder!" intent, visibly) rather
  // than reject — the params-schema design (Params.md §2, validateParamValue).
  const clamped = resolveEffectParams(DOOR_GRAPHICS_PARAMS, [{ motionDurationScale: 99 }]);
  ok('an out-of-range duration scale clamps to the max (4), not rejected', clamped.values.motionDurationScale === 4);

  // Tier 0 is the animated leaf.
  ok('tier 0 is the animated leaf', DOOR_GRAPHICS.tiers[0]?.n === 0 && /leaf/.test(DOOR_GRAPHICS.tiers[0]?.adds ?? ''));

  // The fog reveal is recorded as a HIGH-PRIORITY deferred rung — the one thing
  // V2 had that this V1 defers, blocked only on the V3 fog system.
  const fogRung = (DOOR_GRAPHICS.deferredRungs ?? []).find((r) => r.name === 'fog-reveal-sync');
  ok('the fog-reveal-sync rung exists', !!fogRung);
  ok('the fog rung is flagged high priority', fogRung?.priority === 'high');
  ok('the fog rung names the openFactor hand-off', /openFactor/i.test(fogRung?.note ?? ''));
  ok(
    'the roof-occlusion limitation is recorded honestly',
    (DOOR_GRAPHICS.deferredRungs ?? []).some((r) => r.name === 'roof-occlusion')
  );
}
