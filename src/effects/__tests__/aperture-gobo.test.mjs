/**
 * aperture-gobo.test.mjs — the aperture-gobo declaration is a valid,
 * registrable effect, and its registration file behaves.
 *
 * Registration MACHINERY is proven in effect-registration.test.mjs; this pins
 * this effect's own shape, that it flows through the one door, and the
 * checkable claim its header makes.
 */
import { validateParamsSchema } from '../../core/params-schema.js';
import { validateEffectManifest } from '../effect-manifest.js';
import { createEffectRegistry } from '../registry.js';
import { resolveEffectEnabled } from '../effect-cascade.js';
import { APERTURE_GOBO, APERTURE_GOBO_PARAMS } from '../aperture-gobo.js';
import { createApertureGoboRegistration } from '../aperture-gobo-registration.js';
import { MAX_APERTURES_PER_LIGHT } from '../lighting/aperture-gobo-render.js';

export function run(t) {
  const { ok } = t;

  // --- the declaration validates -------------------------------------------
  ok('APERTURE_GOBO_PARAMS is a valid params schema', validateParamsSchema(APERTURE_GOBO_PARAMS).ok);
  ok('APERTURE_GOBO is a valid manifest', validateEffectManifest(APERTURE_GOBO).ok);
  ok("the effect's id is apertureGobo", APERTURE_GOBO.id === 'apertureGobo');
  ok('does not flash (a11y photosensitive false)', APERTURE_GOBO.a11y.photosensitive === false);
  ok('no authoring.paint — this effect reads no mask at all', APERTURE_GOBO.authoring === undefined);

  // --- default ON: inert on any light with no nearby aperture wall --------
  ok('gated to low → on even at Low', APERTURE_GOBO.enabledFromProfile === 'low');
  ok('resolves ON at Low by default', resolveEffectEnabled(APERTURE_GOBO, { profile: 'low' }) === true);
  ok('resolves ON at Standard by default', resolveEffectEnabled(APERTURE_GOBO, { profile: 'standard' }) === true);
  ok(
    'a player can still turn it OFF (final say)',
    resolveEffectEnabled(APERTURE_GOBO, { profile: 'low', playerEnable: 'off' }) === false
  );

  // --- the ladder: BUILT rungs in `tiers`, the rest honestly deferred ------
  ok('tier 0 exists — the coarse pin (Effects.md Law 1)', APERTURE_GOBO.tiers[0]?.n === 0);
  ok('tier 0 is named for what it does, not for a technique', APERTURE_GOBO.tiers[0]?.name === 'projection');
  ok('exactly one tier is BUILT — this increment is deliberately small', APERTURE_GOBO.tiers.length === 1);
  const allNames = [...APERTURE_GOBO.tiers.map((x) => x.name), ...APERTURE_GOBO.deferredRungs.map((x) => x.name)];
  ok('no rung is claimed twice', new Set(allNames).size === allNames.length);
  ok(
    'every deferred rung says what it will add',
    APERTURE_GOBO.deferredRungs.every((r) => typeof r.note === 'string' && r.note.length > 0)
  );
  ok('the hole-stack-correctness gap is recorded, not silently assumed', allNames.includes('holeStackCorrectness'));
  ok('the elevation-height simplification is recorded as deferred', allNames.includes('elevationHeight'));

  // --- every param is genuinely consumed (params/no-dead-controls proves ---
  // this at build time for real code; this pins the SHAPE: window geometry
  // exposed generously, blur physics kept to one bias).
  const keys = Object.keys(APERTURE_GOBO_PARAMS);
  ok(
    'every param declares a category, so the panel groups itself',
    keys.every((k) => typeof APERTURE_GOBO_PARAMS[k].category === 'string')
  );
  ok('a master strength control exists and can reach 0 (fully neutral)', APERTURE_GOBO_PARAMS.strength.min === 0);
  ok('…and defaults ON', APERTURE_GOBO_PARAMS.strength.default > 0);
  ok('exactly one softness dial — the model itself stays a constant', keys.filter((k) => /soft/i.test(k)).length === 1);
  ok(
    'no separate "penumbra"/"falloff shape"/"near softness" param exists — those are module constants',
    !keys.some((k) => /penumbra|falloffShape|nearSoft/i.test(k))
  );
  ok(
    'maxAperturesPerLight cannot be authored past the shader’s own hard cap',
    APERTURE_GOBO_PARAMS.maxAperturesPerLight.max === MAX_APERTURES_PER_LIGHT
  );
  ok(
    'pane count is procedural (round 11) — a target pane SIZE is authored, not a fixed count',
    APERTURE_GOBO_PARAMS.paneWidthPx.type === 'float' && APERTURE_GOBO_PARAMS.paneHeightPx.type === 'float'
  );
  ok(
    'cols/rows are no longer authored params — point-light-pool.js derives them per-light from wallLen',
    !Object.prototype.hasOwnProperty.call(APERTURE_GOBO_PARAMS, 'cols') &&
      !Object.prototype.hasOwnProperty.call(APERTURE_GOBO_PARAMS, 'rows')
  );
  ok(
    'no "enabled" key leaked into the schema — that is the manifest/cascade’s job, not a param',
    !Object.prototype.hasOwnProperty.call(APERTURE_GOBO_PARAMS, 'enabled')
  );

  // --- it registers through the ONE door -----------------------------------
  const registry = createEffectRegistry();
  let applied = null;
  registry.register(APERTURE_GOBO, (resolved) => {
    applied = resolved;
  });
  registry.resolveAndApply('apertureGobo', { profile: 'standard', paramLayers: [{ strength: 0.5 }] });
  ok('registration + resolve reaches the apply callback', applied !== null);
  ok('…with the effect enabled', applied?.enabled === true);
  ok('…and the override layer winning over the default', applied?.params?.strength === 0.5);
  ok(
    '…while unset params fall back to their declared defaults',
    applied?.params?.paneWidthPx === APERTURE_GOBO_PARAMS.paneWidthPx.default
  );

  // ==========================================================================
  // createApertureGoboRegistration — the registration factory itself
  // ==========================================================================
  {
    const fakeSettings = new Map();
    const log = { error: () => {} };
    const reg = createApertureGoboRegistration({
      effectRegistry: createEffectRegistry(),
      deriveEffectLayers: (id, readSetting) => ({ profile: 'standard', playerEnable: readSetting(`msa.${id}.player`) }),
      readSetting: (key) => fakeSettings.get(key),
      writeSetting: (moduleId, key, value) => {
        fakeSettings.set(key, value);
        return Promise.resolve();
      },
      moduleId: 'msa',
      effectEnableKey: (id, scope) => `msa.${id}.${scope}`,
      log,
    });

    ok(
      'starts pre-resolved ENABLED (inert on a scene with no aperture walls anyway)',
      reg.getReadout().enabled === true
    );
    ok('debug starts off', reg.getDebug() === false);
    ok("debugChannel starts 'off' too", reg.getDebugChannel() === 'off');

    const debugResult = reg.setDebug(true);
    ok(
      "setDebug(true) flips it on — the OLD boolean API maps to the 'pattern' channel",
      reg.getDebug() === true && debugResult.debug === true && reg.getDebugChannel() === 'pattern'
    );
    reg.setDebug(false);
    ok(
      "setDebug(false) restores normal render — back to 'off'",
      reg.getDebug() === false && reg.getDebugChannel() === 'off'
    );

    const visResult = reg.setDebugChannel('visibility');
    ok(
      "setDebugChannel('visibility') reaches the third channel the OLD boolean API never could",
      reg.getDebugChannel() === 'visibility' && visResult.debugChannel === 'visibility' && reg.getDebug() === false
    );

    const gateResult = reg.setDebugChannel('gate-inputs');
    ok(
      "setDebugChannel('gate-inputs') reaches the fourth channel too",
      reg.getDebugChannel() === 'gate-inputs' && gateResult.debugChannel === 'gate-inputs' && reg.getDebug() === false
    );
    reg.setDebugChannel('off');

    let channelErrorSeen = false;
    const regWithChannelErrorLog = createApertureGoboRegistration({
      effectRegistry: createEffectRegistry(),
      deriveEffectLayers: (id, readSetting) => ({ profile: 'standard', playerEnable: readSetting(`msa.${id}.player`) }),
      readSetting: () => undefined,
      writeSetting: () => Promise.resolve(),
      moduleId: 'msa',
      effectEnableKey: (id, scope) => `msa.${id}.${scope}`,
      log: {
        error: () => {
          channelErrorSeen = true;
        },
      },
    });
    const badChannelResult = regWithChannelErrorLog.setDebugChannel('bogus');
    ok(
      'an unrecognised channel id is reported loudly and falls back to off, never left as a nonsense string',
      channelErrorSeen === true &&
        badChannelResult.debugChannel === 'off' &&
        regWithChannelErrorLog.getDebugChannel() === 'off'
    );

    let errorSeen = false;
    const regWithErrorLog = createApertureGoboRegistration({
      effectRegistry: createEffectRegistry(),
      deriveEffectLayers: (id, readSetting) => ({ profile: 'standard', playerEnable: readSetting(`msa.${id}.player`) }),
      readSetting: () => undefined,
      writeSetting: () => Promise.resolve(),
      moduleId: 'msa',
      effectEnableKey: (id, scope) => `msa.${id}.${scope}`,
      log: {
        error: () => {
          errorSeen = true;
        },
      },
    });
    regWithErrorLog.setApertureGobo({ notARealParam: 5 });
    ok('an unknown param key is reported loudly, never a silent no-op', errorSeen === true);

    const state = reg.getRenderState();
    ok(
      'getRenderState returns the {enabled, params, debugChannel} shape point-light-pool.js reads',
      'enabled' in state && 'params' in state && 'debugChannel' in state
    );
  }
}
