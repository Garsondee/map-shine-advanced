/**
 * window.test.mjs — the window declaration is a valid, registrable effect.
 *
 * Registration MACHINERY is proven in effect-registration.test.mjs; this pins
 * window's own shape, that it flows through the one door, and the checkable
 * claim its header makes: built + deferred = the whole ladder, nothing
 * claimed twice, nothing dropped.
 */
import { validateParamsSchema } from '../../../core/params-schema.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { createEffectRegistry } from '../../registry.js';
import { resolveEffectEnabled } from '../../effect-cascade.js';
import { WINDOW, WINDOW_PARAMS, WINDOW_DEBUG_CHANNELS, WINDOW_DEBUG_BOOST } from '../window.js';

export function run(t) {
  const { ok } = t;

  // --- the declaration validates -------------------------------------------
  ok('WINDOW_PARAMS is a valid params schema', validateParamsSchema(WINDOW_PARAMS).ok);
  ok('WINDOW is a valid manifest', validateEffectManifest(WINDOW).ok);
  ok("the effect's id is window", WINDOW.id === 'window');
  ok('tier 0 does not flash (a11y photosensitive false)', WINDOW.a11y.photosensitive === false);

  // --- default ON: inert on a scene with no `_Window` file -----------------
  ok('gated to low → on even at Low', WINDOW.enabledFromProfile === 'low');
  ok('resolves ON at Low by default', resolveEffectEnabled(WINDOW, { profile: 'low' }) === true);
  ok('resolves ON at Standard by default', resolveEffectEnabled(WINDOW, { profile: 'standard' }) === true);
  ok(
    'a player can still turn it OFF (final say)',
    resolveEffectEnabled(WINDOW, { profile: 'low', playerEnable: 'off' }) === false
  );

  // --- the ladder: BUILT rungs in `tiers`, the rest honestly deferred ------
  ok('tier 0 exists — the coarse pin (Effects.md Law 1)', WINDOW.tiers[0]?.n === 0);
  ok('tier 0 is named for what it does, not for a technique', WINDOW.tiers[0]?.name === 'cookie');
  ok('exactly one tier is BUILT — this increment is deliberately small', WINDOW.tiers.length === 1);
  const allNames = [...WINDOW.tiers.map((x) => x.name), ...WINDOW.deferredRungs.map((x) => x.name)];
  ok('no rung is claimed twice', new Set(allNames).size === allNames.length);
  ok(
    'every deferred rung says what it will add',
    WINDOW.deferredRungs.every((r) => typeof r.note === 'string' && r.note.length > 0)
  );
  // The named goal (author directive) must be ON the ladder, not merely
  // implied — a future reader should not have to re-derive that cloud
  // shadows are a planned rung from prose alone.
  ok('the cloud rung is recorded as deferred, not silently assumed', allNames.includes('cloud'));
  // The author's own extension idea, likewise — flagged rather than lost.
  ok("the author's point-light-conversion idea is recorded", allNames.includes('pointLights'));

  // --- every param is genuinely consumed (params/no-dead-controls proves ---
  // this at build time for real code; this pins the SHAPE the design argues
  // for: a small schema, not a rebuild of V2's 98 controls).
  //
  // ⚠️ THIS BOUND MOVED, 4 → 16, AND IT WAS A DELIBERATE DESIGN CHANGE, NOT A
  // TEST BEING MADE TO FIT. It was written at 4 to encode "tier 0 is
  // deliberately small". The author then asked for the glass rung by name and
  // in the same breath asked for *"plenty of controls to alter the look of the
  // RGB split"* (2026-08-05) — a direct instruction that the glass deserves a
  // real control surface, which is the only authority that can move a pin like
  // this one. Nine `Glass` params landed as a result.
  //
  // The bound is kept, and kept TIGHT, because what it actually guards is
  // still live: V2's 98 controls were not one considered decision but the
  // absence of any, one knob at a time, with 46 of them driving nothing at all.
  // `params/no-dead-controls` walls the inert half at build time; this walls
  // the accretion half. Sixteen leaves room for the deferred rungs that will
  // legitimately want a knob (cloud, moon) and not much else — the next person
  // to need more must come back here and justify it too.
  const keys = Object.keys(WINDOW_PARAMS);
  ok('the whole schema is a small fraction of V2s 98 controls', keys.length <= 16);
  ok(
    'every glass control is grouped under its own category, so the panel does not read as one long list',
    keys.filter((k) => k.startsWith('glass')).every((k) => WINDOW_PARAMS[k].category === 'Glass')
  );
  // The master: at 0 the pane is flat and EVERY glass term must vanish with
  // it (window-glass.js's model makes warp, prism and caustic all derivatives
  // of one field). A default above 0 is the standing "new features ship ON so
  // the author actually sees them" rule.
  ok('the glass master can reach 0 — flat glass is reachable', WINDOW_PARAMS.glassWarpPx.min === 0);
  ok('…and ships on, not silently disabled', WINDOW_PARAMS.glassWarpPx.default > 0);
  ok(
    'every param declares a help string an author can act on',
    keys.every((k) => (WINDOW_PARAMS[k].help ?? '').length > 20)
  );
  ok(
    'every param declares a category, so the panel groups itself',
    keys.every((k) => typeof WINDOW_PARAMS[k].category === 'string')
  );
  ok('a master strength control exists and can reach 0', WINDOW_PARAMS.strength.min === 0);
  ok('…and defaults ON', WINDOW_PARAMS.strength.default > 0);

  // ⚠️ There must be NO "cloud shadows" or "cloud" param yet — the field does
  // not exist, and `params/no-dead-controls` would fail the build on a
  // slider with no consumer. This assertion is the guard against someone
  // adding the control before the rung, which is exactly backwards.
  ok(
    'no cloud param exists yet — the seam is code-level, not a UI control ahead of its rung',
    !keys.some((k) => /cloud/i.test(k))
  );

  // --- it registers through the ONE door -----------------------------------
  const registry = createEffectRegistry();
  let applied = null;
  registry.register(WINDOW, (resolved) => {
    applied = resolved;
  });
  registry.resolveAndApply('window', { profile: 'standard', paramLayers: [{ strength: 0.5 }] });
  ok('registration + resolve reaches the apply callback', applied !== null);
  ok('…with the effect enabled', applied?.enabled === true);
  ok('…and the override layer winning over the default', applied?.params?.strength === 0.5);
  ok(
    '…while unset params fall back to their declared defaults',
    applied?.params?.contrast === WINDOW_PARAMS.contrast.default
  );

  // --- THE DEBUG CHANNELS ---------------------------------------------------
  const ns = WINDOW_DEBUG_CHANNELS.map((c) => c.n);
  const ids = WINDOW_DEBUG_CHANNELS.map((c) => c.id);
  ok('there are debug channels at all', WINDOW_DEBUG_CHANNELS.length > 1);
  ok(
    'channel 0 is off — the effect as it ships',
    WINDOW_DEBUG_CHANNELS[0]?.n === 0 && WINDOW_DEBUG_CHANNELS[0]?.id === 'off'
  );
  ok(
    'the channel numbers are contiguous from 0',
    ns.every((n, i) => n === i)
  );
  ok('every channel number is unique', new Set(ns).size === ns.length);
  ok('every channel id is unique', new Set(ids).size === ids.length);
  ok(
    'every channel carries a label and a reading guide',
    WINDOW_DEBUG_CHANNELS.every(
      (c) => typeof c.label === 'string' && c.label.length > 0 && typeof c.reads === 'string' && c.reads.length > 0
    )
  );
  ok(
    'no channel leaked into WINDOW_PARAMS as a look control',
    !Object.prototype.hasOwnProperty.call(WINDOW_PARAMS, 'debugChannel') &&
      !Object.prototype.hasOwnProperty.call(WINDOW_PARAMS, 'debug')
  );
  ok('channel 1 is the quad — is the mesh drawing at all, and where', WINDOW_DEBUG_CHANNELS[1]?.id === 'quad');
  ok('the mask is read before the level derived from it', ids.indexOf('mask') < ids.indexOf('level'));
  ok('presence is read before the gate that multiplies it', ids.indexOf('presence') < ids.indexOf('floorGate'));
  ok('the final channel closes the chain, after everything it composes', ids.indexOf('final') === ids.length - 1);
  ok('the boost is a real amplification, not a no-op', WINDOW_DEBUG_BOOST > 1);
  // rawLight/final are a deliberate PAIR (compare pre- and post-shoulder) —
  // pin that rawLight sits immediately before final, so a future rung cannot
  // slot something between them and break the "compare these two" reading.
  ok(
    'rawLight sits immediately before final — they are a comparison pair',
    ids.indexOf('final') === ids.indexOf('rawLight') + 1
  );
}
