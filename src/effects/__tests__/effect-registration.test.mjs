/**
 * Node verification for the effect-registration core — the pure half of MSA's
 * first registered effect (docs/planning/Effect-Registration.md). The cascade
 * resolver's precedence + accessibility invariants are the safety-critical
 * logic (a player's a11y choice must beat a GM), so they are pinned hardest.
 * The Foundry settings adapter + live render wiring are browser-only.
 */
import { validateParamsSchema } from '../../core/params-schema.js';
import { UI_SHADOW_PARAMS, UI_WINDOW_SHADOW } from '../ui-window-shadow.js';
import { GRADE, GRADE_LOOK_PARAMS } from '../grade/grade.js';
import { BLOOM, BLOOM_PARAMS } from '../bloom.js';
import { validateEffectManifest, validateAuthoring } from '../effect-manifest.js';
import { MASK_KINDS } from '../../scene/mask-catalog.js';
import { ANCHOR_KINDS } from '../../scene/anchor-catalog.js';
import { SPECULAR } from '../specular/specular.js';
import { WATER } from '../water/water.js';
import { FLUID } from '../fluid/fluid.js';
import { WINDOW } from '../window/window.js';
import { VEGETATION } from '../vegetation.js';
import { CANDLE_FLAME } from '../candle-flame.js';
import {
  resolveEffectEnabled,
  resolveEffectParams,
  profileRank,
  PERFORMANCE_PROFILES,
  DEFAULT_PERFORMANCE_PROFILE,
} from '../effect-cascade.js';
import { createEffectRegistry } from '../registry.js';
import {
  describeEffectSettings,
  deriveEffectLayers,
  effectEnableKey,
  GLOBAL_SETTING_KEYS,
} from '../effect-settings.js';

/** A minimal valid manifest for a photosensitive effect (for the a11y gate). */
const FLASHER = { enabledFromProfile: 'low', a11y: { photosensitive: true } };
/** A non-flashing effect gated to Extreme (mirrors UI-shadow's shape). */
const DECOR = { enabledFromProfile: 'extreme', a11y: { photosensitive: false } };

export function run(t) {
  const { ok, throws } = t;

  // ======================================================================
  // The real declarations validate
  // ======================================================================
  ok('UI_SHADOW_PARAMS is a valid params schema', validateParamsSchema(UI_SHADOW_PARAMS).ok);
  ok('UI_WINDOW_SHADOW is a valid manifest', validateEffectManifest(UI_WINDOW_SHADOW).ok);

  // THE GOD CC (docs/planning/Grade.md §14) — the Look grade is a real effect,
  // so its schema and manifest must validate exactly like any other.
  ok('GRADE_LOOK_PARAMS is a valid params schema', validateParamsSchema(GRADE_LOOK_PARAMS).ok);
  ok('GRADE is a valid manifest', validateEffectManifest(GRADE).ok);
  ok("the grade's id is grade", GRADE.id === 'grade');
  ok('the grade ships enabled (Neutral default film response)', GRADE.enabledFromProfile === 'low');
  ok('toneMapping defaults to neutral', GRADE_LOOK_PARAMS.toneMapping.default === 'neutral');
  ok("'enabled' is NOT a grade param (the cascade owns it)", !('enabled' in GRADE_LOOK_PARAMS));

  // BLOOM — pinned because the declaration and the runtime disagreed for months.
  // The manifest said 'low' (= on at every profile) the whole time; nothing ever
  // ran the cascade for bloom outside `MapShine.setBloom`, so it was off at boot
  // in every scene. boot.js's EFFECT_REAPPLIERS is the fix; these assertions pin
  // the declaration half so a future "default it off" edit has to be deliberate.
  ok('BLOOM_PARAMS is a valid params schema', validateParamsSchema(BLOOM_PARAMS).ok);
  ok('BLOOM is a valid manifest', validateEffectManifest(BLOOM).ok);
  ok("the bloom's id is bloom", BLOOM.id === 'bloom');
  ok('bloom ships ON at every profile', BLOOM.enabledFromProfile === 'low');
  ok('bloom resolves ON at Low by default', resolveEffectEnabled(BLOOM, { profile: 'low' }) === true);
  ok('bloom resolves ON at Standard by default', resolveEffectEnabled(BLOOM, { profile: 'standard' }) === true);
  ok(
    'a player can still turn bloom OFF (final say)',
    resolveEffectEnabled(BLOOM, { profile: 'low', playerEnable: 'off' }) === false
  );
  ok("'enabled' is NOT a bloom param (the cascade owns it)", !('enabled' in BLOOM_PARAMS));
  ok("the effect's id is uiWindowShadow", UI_WINDOW_SHADOW.id === 'uiWindowShadow');
  ok('the effect declares its a11y flag (photosensitive: false)', UI_WINDOW_SHADOW.a11y.photosensitive === false);
  ok('the effect is gated to Extreme by default (expensive)', UI_WINDOW_SHADOW.enabledFromProfile === 'extreme');
  ok("'enabled' is NOT a param (it is resolved by the cascade)", !('enabled' in UI_SHADOW_PARAMS));
  ok('readouts are NOT params (lastWindowCount stays a readout)', !('lastWindowCount' in UI_SHADOW_PARAMS));

  // ======================================================================
  // THE ＋ AFFORDANCE — `authoring.paint`, shape AND reference
  // ======================================================================
  // Shape is checked in effect-manifest.js; that a declared mask actually EXISTS
  // and is actually PAINTABLE is checked here, because importing the mask catalog
  // from effects/ would add an import edge for one lookup. A ＋ button pointing at
  // a mask kind nobody can paint is a dead control shipped to the author's hand —
  // this is the wall that stops it, in the same spirit as dials/valid-reference.
  ok(
    'an absent authoring block is fine (bloom has nowhere on the map to go)',
    validateAuthoring(undefined).length === 0
  );
  ok('a non-object authoring block is rejected', validateAuthoring('specular').length > 0);
  ok('an empty paint array is rejected', validateAuthoring({ paint: [] }).length > 0);
  ok('a non-string mask id is rejected', validateAuthoring({ paint: [7] }).length > 0);
  ok('an empty mask id is rejected', validateAuthoring({ paint: '' }).length > 0);
  ok('a single mask id is allowed', validateAuthoring({ paint: 'specular' }).length === 0);
  ok("vegetation's two-mask form is allowed", validateAuthoring({ paint: ['tree', 'bush'] }).length === 0);
  ok(
    'a manifest carrying a malformed authoring block fails validation as a whole',
    !validateEffectManifest({ ...UI_WINDOW_SHADOW, authoring: { paint: [''] } }).ok
  );

  // Only kinds with suffixes are genuinely paintable — a derived product like
  // skyReach has no file to paint into. paint-mode.js filters exactly this way.
  const paintable = new Set(
    MASK_KINDS.filter((k) => Array.isArray(k.suffixes) && k.suffixes.length > 0).map((k) => k.id)
  );
  for (const m of [SPECULAR, WATER, FLUID, WINDOW, VEGETATION]) {
    const declared = Array.isArray(m.authoring?.paint) ? m.authoring.paint : [m.authoring?.paint];
    ok(`${m.id} declares how it is painted onto a map`, declared.length > 0 && declared.every(Boolean));
    for (const k of declared) {
      ok(`${m.id}'s ＋ points at a real, paintable mask kind ('${k}')`, paintable.has(k));
    }
  }
  // Candles are PLACED, not painted, and that is already declared — ANCHOR_KINDS
  // carry effectId, so a second declaration on the manifest would be a second
  // thing to drift out of sync.
  ok('candles declare no paint mask', CANDLE_FLAME.authoring?.paint === undefined);
  ok(
    'candles are placeable via the anchor catalog instead',
    ANCHOR_KINDS.some((k) => k.effectId === CANDLE_FLAME.id)
  );
  ok('bloom has no ＋ — there is nowhere on a map to put a whole-image post effect', BLOOM.authoring === undefined);

  // ======================================================================
  // validateEffectManifest — catches the malformed
  // ======================================================================
  ok('a null manifest is rejected', !validateEffectManifest(null).ok);
  ok('a missing a11y flag is rejected', !validateEffectManifest({ ...UI_WINDOW_SHADOW, a11y: {} }).ok);
  ok(
    'an unknown enabledFromProfile is rejected',
    !validateEffectManifest({ ...UI_WINDOW_SHADOW, enabledFromProfile: 'ultra' }).ok
  );
  ok('a non-camelCase id is rejected', !validateEffectManifest({ ...UI_WINDOW_SHADOW, id: 'UI-Shadow' }).ok);
  ok('visualWeight out of [0,1] is rejected', !validateEffectManifest({ ...UI_WINDOW_SHADOW, visualWeight: 2 }).ok);
  ok(
    'non-contiguous tiers are rejected',
    !validateEffectManifest({ ...UI_WINDOW_SHADOW, tiers: [{ n: 1, adds: 'x' }] }).ok
  );
  ok('empty tiers are rejected', !validateEffectManifest({ ...UI_WINDOW_SHADOW, tiers: [] }).ok);

  // ======================================================================
  // COST-CLASS MONOTONICITY (Effects.md Law 3) — rungs 1..N only, tier 0 is
  // the admission price and is exempt from the chain. Water's own ladder
  // (tier 0 = C4, tier 1 = C1) is why the exemption exists as CODE, not just
  // prose: a naive "every tier >= the one before it, including tier 0" check
  // would reject water's own real ladder.
  // ======================================================================
  ok(
    'a tier missing cost.class is rejected',
    !validateEffectManifest({ ...UI_WINDOW_SHADOW, tiers: [{ n: 0, adds: 'x' }] }).ok
  );
  ok(
    'an unrecognised cost.class is rejected',
    !validateEffectManifest({ ...UI_WINDOW_SHADOW, tiers: [{ n: 0, cost: { class: 'C9' }, adds: 'x' }] }).ok
  );
  ok(
    'tier 0 -> tier 1 CHEAPER is allowed (tier 0 is exempt from the chain)',
    validateEffectManifest({
      ...UI_WINDOW_SHADOW,
      tiers: [
        { n: 0, cost: { class: 'C4' }, adds: 'placement' },
        { n: 1, fromProfile: 'low', cost: { class: 'C1' }, adds: 'volume' },
      ],
    }).ok
  );
  ok(
    'tier 1 -> tier 2 CHEAPER is rejected (the real ladder starts here)',
    !validateEffectManifest({
      ...UI_WINDOW_SHADOW,
      tiers: [
        { n: 0, cost: { class: 'C4' }, adds: 'placement' },
        { n: 1, fromProfile: 'low', cost: { class: 'C3' }, adds: 'light' },
        { n: 2, fromProfile: 'low', cost: { class: 'C1' }, adds: 'volume, out of order' },
      ],
    }).ok
  );
  ok(
    'tier 1 -> tier 2 SAME class is allowed (non-decreasing, not strictly increasing)',
    validateEffectManifest({
      ...UI_WINDOW_SHADOW,
      tiers: [
        { n: 0, cost: { class: 'C4' }, adds: 'placement' },
        { n: 1, fromProfile: 'low', cost: { class: 'C2' }, adds: 'motion' },
        { n: 2, fromProfile: 'standard', cost: { class: 'C2' }, adds: 'more motion, same class' },
      ],
    }).ok
  );
  ok(
    "water's own real ladder (C4,C1,C2,C3,C4,C5,C6,C7,C8) validates end to end",
    validateEffectManifest({
      ...UI_WINDOW_SHADOW,
      tiers: ['C4', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'].map((cls, n) => ({
        n,
        // Rung 0 must NOT carry one (it is unconditional); every rung above it must.
        ...(n === 0 ? {} : { fromProfile: 'low' }),
        cost: { class: cls },
        adds: `rung ${n}`,
      })),
    }).ok
  );

  // ======================================================================
  // profileRank — order is rank; unknown falls to the default
  // ======================================================================
  ok('profiles are ordered low→extreme', profileRank('low') < profileRank('extreme'));
  ok(
    'standard sits in the middle',
    profileRank('performance') < profileRank('standard') && profileRank('standard') < profileRank('quality')
  );
  ok(
    'an unknown profile reads as the default, never NaN',
    profileRank('nonsense') === profileRank(DEFAULT_PERFORMANCE_PROFILE)
  );
  ok(
    'all five profiles are distinct ranks',
    new Set(PERFORMANCE_PROFILES.map(profileRank)).size === PERFORMANCE_PROFILES.length
  );

  // ======================================================================
  // resolveEffectEnabled — THE CASCADE + A11Y INVARIANTS (the crown jewels)
  // ======================================================================
  {
    // 1. Profile gate: an Extreme-gated effect is off below Extreme, on at Extreme.
    ok('Extreme-gated effect is OFF at Standard', resolveEffectEnabled(DECOR, { profile: 'standard' }) === false);
    ok('Extreme-gated effect is ON at Extreme', resolveEffectEnabled(DECOR, { profile: 'extreme' }) === true);
    ok('a low-gated effect is on even at Low', resolveEffectEnabled(FLASHER, { profile: 'low' }) === true);
    ok(
      'an absent profile reads as Standard',
      resolveEffectEnabled(DECOR, {}) === resolveEffectEnabled(DECOR, { profile: 'standard' })
    );

    // 2. GM (world) override inherits on 'auto', decides on on/off.
    ok(
      "GM 'on' turns an Extreme effect on at Standard",
      resolveEffectEnabled(DECOR, { profile: 'standard', gmEnable: 'on' }) === true
    );
    ok(
      "GM 'off' turns it off at Extreme",
      resolveEffectEnabled(DECOR, { profile: 'extreme', gmEnable: 'off' }) === false
    );
    ok(
      "GM 'auto' inherits the profile gate",
      resolveEffectEnabled(DECOR, { profile: 'extreme', gmEnable: 'auto' }) === true
    );

    // 3. PLAYER BEATS GM — the player has final say over their own experience.
    ok(
      "player 'off' beats GM 'on'",
      resolveEffectEnabled(DECOR, { profile: 'extreme', gmEnable: 'on', playerEnable: 'off' }) === false
    );
    ok(
      "player 'on' beats GM 'off'",
      resolveEffectEnabled(DECOR, { profile: 'low', gmEnable: 'off', playerEnable: 'on' }) === true
    );
    ok(
      "player 'auto' defers to the GM",
      resolveEffectEnabled(DECOR, { profile: 'standard', gmEnable: 'on', playerEnable: 'auto' }) === true
    );

    // 4. ACCESSIBILITY BEATS EVERYONE — force off, wins over player AND GM 'on'.
    ok(
      'a11y forces a photosensitive effect OFF even when player + GM both say on',
      resolveEffectEnabled(FLASHER, {
        profile: 'extreme',
        gmEnable: 'on',
        playerEnable: 'on',
        reducePhotosensitive: true,
      }) === false
    );
    ok(
      'a11y does NOT touch a non-photosensitive effect',
      resolveEffectEnabled(DECOR, { profile: 'extreme', reducePhotosensitive: true }) === true
    );
    ok(
      'a11y only ever forces OFF, never on (a photosensitive effect the profile leaves off stays off)',
      resolveEffectEnabled(FLASHER, { profile: 'low', playerEnable: 'off', reducePhotosensitive: true }) === false
    );

    // Totality: garbage inputs degrade, never throw.
    ok(
      'a corrupt override reads as auto, not a crash',
      resolveEffectEnabled(DECOR, { profile: 'extreme', playerEnable: 'banana' }) === true
    );
    ok(
      'an absent manifest field (no enabledFromProfile) is treated as always-on',
      resolveEffectEnabled({ a11y: {} }, { profile: 'low' }) === true
    );
  }

  // ======================================================================
  // resolveEffectParams — defaults, layering, validation
  // ======================================================================
  {
    const noLayers = resolveEffectParams(UI_SHADOW_PARAMS, []);
    ok('no layers → declared defaults', noLayers.values.strength01 === 0.4 && noLayers.values.offsetScale === 5);
    ok('no layers → nothing rejected', noLayers.rejected.length === 0);

    const overridden = resolveEffectParams(UI_SHADOW_PARAMS, [{ strength01: 0.7 }]);
    ok('a layer overrides a default', overridden.values.strength01 === 0.7);
    ok('unmentioned params keep their default', overridden.values.offsetScale === 5);

    const layered = resolveEffectParams(UI_SHADOW_PARAMS, [{ strength01: 0.7 }, { strength01: 0.2 }]);
    ok('a later layer wins (client over scene)', layered.values.strength01 === 0.2);

    const bad = resolveEffectParams(UI_SHADOW_PARAMS, [{ strength01: 'purple', bogus: 1 }]);
    ok(
      'an invalid stored value falls back to default and is REPORTED (no silent coerce)',
      bad.values.strength01 === 0.4 && bad.rejected.length >= 1
    );
  }

  // ======================================================================
  // createEffectRegistry — the ONE door
  // ======================================================================
  {
    const reg = createEffectRegistry();
    let applied = null;
    const id = reg.register(UI_WINDOW_SHADOW, (r) => {
      applied = r;
    });
    ok('register returns the id', id === 'uiWindowShadow');
    ok('get returns the entry', reg.get('uiWindowShadow')?.manifest.id === 'uiWindowShadow');
    ok('get of an unknown id is null (not a throw)', reg.get('nope') === null);
    ok(
      'list includes the manifest',
      reg.list().some((m) => m.id === 'uiWindowShadow')
    );

    const resolved = reg.resolveAndApply('uiWindowShadow', { profile: 'extreme' });
    ok('resolveAndApply calls apply with the resolved state', applied !== null && applied.enabled === true);
    ok(
      'resolveAndApply returns the same resolved object shape',
      resolved.enabled === true && typeof resolved.params === 'object'
    );
    ok(
      'at Standard the effect resolves OFF (default gate)',
      reg.resolveAndApply('uiWindowShadow', { profile: 'standard' }).enabled === false
    );

    throws('a duplicate id throws', () => reg.register(UI_WINDOW_SHADOW, () => {}), 'already registered');
    throws('a bad manifest throws at registration', () => reg.register({ id: 'X' }, () => {}), 'invalid');
    throws('a missing apply throws', () => reg.register({ ...UI_WINDOW_SHADOW, id: 'other' }, null), 'apply');
    throws(
      'resolveAndApply of an unknown id throws loudly (never a silent skip)',
      () => reg.resolveAndApply('ghost'),
      'only door'
    );
  }

  // ======================================================================
  // effect-settings — descriptors DERIVED from manifests, layers read back
  // ======================================================================
  {
    const descriptors = describeEffectSettings([UI_WINDOW_SHADOW]);
    const byKey = (k) => descriptors.find((d) => d.key === k);

    ok('one effect → 3 global + 2 per-effect descriptors', descriptors.length === 5);

    const master = byKey(GLOBAL_SETTING_KEYS.msaEnabled);
    ok(
      'the master off-switch is a client bool defaulting ON, requiring a reload',
      master?.scope === 'client' &&
        master?.kind === 'bool' &&
        master?.default === true &&
        master?.requiresReload === true
    );

    const profile = byKey(GLOBAL_SETTING_KEYS.profile);
    ok(
      'the profile is a client enum defaulting to standard',
      profile?.scope === 'client' && profile?.kind === 'enum' && profile?.default === 'standard'
    );
    ok(
      'the profile choices are the five performance profiles',
      profile && Object.keys(profile.choices).length === 5 && 'extreme' in profile.choices
    );

    const a11y = byKey(GLOBAL_SETTING_KEYS.reducePhotosensitive);
    ok(
      'reduce-photosensitive is a client bool defaulting off',
      a11y?.scope === 'client' && a11y?.kind === 'bool' && a11y?.default === false
    );

    const gm = byKey(effectEnableKey('uiWindowShadow', 'gm'));
    ok('the GM enable is WORLD-scoped, defaulting to auto', gm?.scope === 'world' && gm?.default === 'auto');
    const player = byKey(effectEnableKey('uiWindowShadow', 'player'));
    ok(
      'the player enable is CLIENT-scoped, defaulting to auto',
      player?.scope === 'client' && player?.default === 'auto'
    );

    ok(
      'the enable key convention is effectId.gmEnable / .playerEnable',
      effectEnableKey('x', 'gm') === 'x.gmEnable' && effectEnableKey('x', 'player') === 'x.playerEnable'
    );
    ok(
      'every descriptor is config:true (shows in Foundry Settings)',
      descriptors.every((d) => d.config === true)
    );
    ok('no manifests → just the 3 global descriptors', describeEffectSettings([]).length === 3);
    ok(
      'the master off-switch exists even with zero effects registered — it gates BEFORE the cascade',
      describeEffectSettings([]).some((d) => d.key === GLOBAL_SETTING_KEYS.msaEnabled)
    );

    // deriveEffectLayers round-trips through a fake store — the shape the resolver eats.
    const store = {
      [GLOBAL_SETTING_KEYS.profile]: 'quality',
      [GLOBAL_SETTING_KEYS.reducePhotosensitive]: true,
      [effectEnableKey('uiWindowShadow', 'player')]: 'off',
      // gmEnable intentionally absent → comes back undefined (resolver treats as auto)
    };
    const layers = deriveEffectLayers('uiWindowShadow', (k) => store[k]);
    ok('deriveEffectLayers reads the profile back', layers.profile === 'quality');
    ok('deriveEffectLayers reads the a11y flag back as a boolean', layers.reducePhotosensitive === true);
    ok('deriveEffectLayers reads the player override back', layers.playerEnable === 'off');
    ok('an absent layer comes back undefined (not a crash)', layers.gmEnable === undefined);

    // Feeding those layers to the resolver honours the cascade end-to-end.
    ok(
      'derived layers drive the resolver: player OFF wins even at Quality',
      resolveEffectEnabled(UI_WINDOW_SHADOW, layers) === false
    );

    // Totality: a non-function reader degrades to defaults, never throws.
    const empty = deriveEffectLayers('uiWindowShadow', null);
    ok(
      'a non-function readSetting degrades to undefined/false',
      empty.profile === undefined && empty.reducePhotosensitive === false
    );
  }
}
