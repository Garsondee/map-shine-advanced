/**
 * Node verification for foundry/scene-environment.js.
 *
 * Only `deriveDarkness` is testable here — same split as
 * canvas-compositing.test.mjs's own header explains: the pure decision logic
 * is Node-tested, the live `canvas.scene` read is browser-only (verified via
 * a debug report, not here).
 */
import { deriveDarkness, deriveAmbient, FOUNDRY_FALLBACK_AMBIENT } from '../scene-environment.js';

export function run(t) {
  const { ok } = t;

  // ---- the happy path: a real, in-range value passes through -------------
  {
    const d = deriveDarkness(0.6, true);
    ok('a finite in-range value reads through as darkness01', d.darkness01 === 0.6);
    ok('source is "scene" for a real read', d.source === 'scene');
    ok('no reason attached to a clean read', d.reason === null);
  }

  ok('0 is a legitimate scene value, not treated as absent', deriveDarkness(0, true).source === 'scene');
  ok('1 (fully dark) passes through unclamped-looking', deriveDarkness(1, true).darkness01 === 1);

  // ---- out-of-range values clamp rather than propagate a bad number ------
  ok('above 1 clamps to 1', deriveDarkness(1.4, true).darkness01 === 1);
  ok(
    'above 1 still reports source:"scene" (it WAS a real read, just out of range)',
    deriveDarkness(1.4, true).source === 'scene'
  );
  ok('negative clamps to 0', deriveDarkness(-0.2, true).darkness01 === 0);

  // ---- "could not read" must never look like "read zero" -----------------
  {
    const noScene = deriveDarkness(undefined, false);
    ok('no scene present => darkness01:0', noScene.darkness01 === 0);
    ok('no scene present => source:"default"', noScene.source === 'default');
    ok('no scene present => a reason is given', typeof noScene.reason === 'string' && noScene.reason.length > 0);
    ok('the reason names the absent scene, not a guess', noScene.reason.includes('no active scene'));
  }
  {
    const badField = deriveDarkness(undefined, true);
    ok('scene present but field absent => darkness01:0', badField.darkness01 === 0);
    ok('scene present but field absent => source:"default"', badField.source === 'default');
    ok(
      'a present-scene-absent-field reason is distinguishable from a no-scene reason',
      badField.reason !== deriveDarkness(undefined, false).reason
    );
  }
  {
    const nanField = deriveDarkness(NaN, true);
    ok('NaN is rejected, not propagated', nanField.darkness01 === 0 && nanField.source === 'default');
  }
  {
    const stringField = deriveDarkness('0.5', true);
    ok(
      'a non-number type is rejected even if numeric-looking',
      stringField.darkness01 === 0 && stringField.source === 'default'
    );
  }

  // ---- a measured-default and an unmeasured-default read the same darkness
  // (0) but for DIFFERENT reasons — collapsing them is the exact lying-
  // instrument class this project has already paid for once.
  {
    const a = deriveDarkness(undefined, false);
    const b = deriveDarkness('nope', true);
    ok('both default to darkness01:0', a.darkness01 === 0 && b.darkness01 === 0);
    ok('but their reasons differ (different failure, not the same fact twice)', a.reason !== b.reason);
  }

  // ======================================================================
  // deriveAmbient — the palette endpoints parity mixes from
  // ======================================================================

  const eqRgb = (a, b) => a.length === 3 && b.length === 3 && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

  // ---- the happy path: three real triples pass through -------------------
  {
    const raw = { daylight: [0.9, 0.9, 0.85], darkness: [0.1, 0.1, 0.28], brightest: [1, 1, 1] };
    const p = deriveAmbient(raw, true);
    ok('daylight passes through', eqRgb(p.daylight, raw.daylight));
    ok('darkness passes through', eqRgb(p.darkness, raw.darkness));
    ok('brightest passes through', eqRgb(p.brightest, raw.brightest));
    ok('all-present read is source:"scene"', p.source === 'scene');
    ok('a clean read has no reason', p.reason === null);
  }

  // ---- no scene => Foundry fallback palette, flagged as default ----------
  {
    const p = deriveAmbient({}, false);
    ok('no scene => daylight is Foundry fallback', eqRgb(p.daylight, [...FOUNDRY_FALLBACK_AMBIENT.daylight]));
    ok('no scene => darkness is Foundry fallback', eqRgb(p.darkness, [...FOUNDRY_FALLBACK_AMBIENT.darkness]));
    ok('no scene => source:"default"', p.source === 'default');
    ok(
      'no scene => a reason names the absent palette',
      typeof p.reason === 'string' && p.reason.includes('no active scene')
    );
  }

  // ---- a partial read defaults ONLY the missing endpoint, and says so ----
  {
    const p = deriveAmbient({ daylight: [0.8, 0.8, 0.8], darkness: undefined, brightest: [1, 1, 1] }, true);
    ok('present endpoint stays live', eqRgb(p.daylight, [0.8, 0.8, 0.8]));
    ok('missing endpoint falls back per-endpoint', eqRgb(p.darkness, [...FOUNDRY_FALLBACK_AMBIENT.darkness]));
    ok('a partial read is source:"partial", not "scene" or "default"', p.source === 'partial');
    ok('the reason names WHICH endpoint defaulted', p.reason.includes('darkness'));
  }

  // ---- out-of-range / bad channels are rejected to fallback, not propagated
  {
    const p = deriveAmbient({ daylight: [2, -1, 0.5], darkness: [0.1, 'x', 0.2], brightest: [1, 1, 1] }, true);
    ok(
      'a non-finite channel rejects the whole triple to fallback',
      eqRgb(p.darkness, [...FOUNDRY_FALLBACK_AMBIENT.darkness])
    );
    ok('an out-of-range channel is clamped, triple still accepted', eqRgb(p.daylight, [1, 0, 0.5]));
  }

  // ---- a no-scene default and a bad-palette default read the same colours
  // but for different reasons (the lying-instrument discipline, again).
  {
    const a = deriveAmbient({}, false);
    const b = deriveAmbient({ daylight: null, darkness: null, brightest: null }, true);
    ok('both land on the fallback darkness', eqRgb(a.darkness, b.darkness));
    ok('but their reasons differ', a.reason !== b.reason);
  }
}
