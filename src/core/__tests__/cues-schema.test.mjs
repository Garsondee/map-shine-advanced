/**
 * THE CUES CONTRACT — verification (docs/holy/UI-Testament.md §4.3, U3).
 * "Invalid cue refuses to arm" (§9's own U3 checklist) is the load-bearing
 * claim this suite exists to prove.
 */
import { validateCue, validateCueStack, orderedCues, cueToFadePatch } from '../cues-schema.js';

/** A fake registry, exactly the shape world/fade-registry.js's own
 * createFadeSourceRegistry provides — 'weather.cloudCover01' and
 * 'water.depth' are known/fadeable; 'water.debugLabel' is known but NOT
 * fadeable (a text field); anything else resolves to undefined. */
function fakeResolveType(key) {
  if (key === 'weather.cloudCover01' || key === 'water.depth') return 'float';
  if (key === 'water.debugLabel') return 'text';
  return undefined;
}
function fakeReadLive(key) {
  return { 'weather.cloudCover01': 0.2, 'water.depth': 0.5 }[key] ?? 0;
}

/** @param {Partial<import('../cues-schema.js').Cue>} overrides */
function cue(overrides = {}) {
  return {
    id: 'dusk-falls',
    name: 'Dusk falls',
    order: 1,
    targets: { 'weather.cloudCover01': { to: 0.9, overMs: 300000, curve: 'ease' } },
    ...overrides,
  };
}

export function run(t) {
  // ---- validateCue: the happy path ---------------------------------------
  {
    const r = validateCue(cue(), fakeResolveType);
    t.ok('a well-formed cue targeting a real, fadeable key passes', r.ok);
    t.ok('a passing cue has no errors', r.errors.length === 0);

    const multi = validateCue(
      cue({
        targets: {
          'weather.cloudCover01': { to: 0.9, overMs: 1000, curve: 'linear' },
          'water.depth': { to: 0.7, overMs: 1000, curve: 'ease' },
        },
      }),
      fakeResolveType
    );
    t.ok('a cue may target multiple keys across different namespaces at once', multi.ok);
  }

  // ---- validateCue: structural rejection ---------------------------------
  {
    t.ok('null is rejected, not thrown on', !validateCue(null, fakeResolveType).ok);
    t.ok('a string is rejected, not thrown on', !validateCue('not a cue', fakeResolveType).ok);
    t.ok('an array is rejected (not a plain object)', !validateCue([], fakeResolveType).ok);

    const noId = validateCue(cue({ id: '' }), fakeResolveType);
    t.ok('an empty id fails', !noId.ok);
    t.ok(
      'the id error names the actual problem',
      noId.errors.some((e) => e.includes('id'))
    );

    const noName = validateCue(cue({ name: '' }), fakeResolveType);
    t.ok('an empty name fails — the deck card has nothing else to show', !noName.ok);

    const noOrder = validateCue(cue({ order: undefined }), fakeResolveType);
    t.ok('a missing order fails', !noOrder.ok);
    t.ok('NaN order fails too', !validateCue(cue({ order: NaN }), fakeResolveType).ok);

    const noTargets = validateCue(cue({ targets: {} }), fakeResolveType);
    t.ok('an empty targets object fails — a cue that changes nothing is not a moment', !noTargets.ok);

    const badTargetsShape = validateCue(cue({ targets: 'nope' }), fakeResolveType);
    t.ok('a non-object targets value fails, not throws', !badTargetsShape.ok);
  }

  // ---- validateCue: per-target rejection ---------------------------------
  {
    const missingTo = validateCue(
      cue({ targets: { 'weather.cloudCover01': { overMs: 1000, curve: 'ease' } } }),
      fakeResolveType
    );
    t.ok("a target missing 'to' fails", !missingTo.ok);

    const negativeOverMs = validateCue(
      cue({ targets: { 'weather.cloudCover01': { to: 0.9, overMs: -50, curve: 'ease' } } }),
      fakeResolveType
    );
    t.ok('a negative overMs fails (0 itself — an instant cut — is legal)', !negativeOverMs.ok);
    const zeroOverMsOk = validateCue(
      cue({ targets: { 'weather.cloudCover01': { to: 0.9, overMs: 0, curve: 'ease' } } }),
      fakeResolveType
    );
    t.ok('overMs:0 (a cut) is explicitly legal', zeroOverMsOk.ok);

    const badCurve = validateCue(
      cue({ targets: { 'weather.cloudCover01': { to: 0.9, overMs: 1000, curve: 'bounce' } } }),
      fakeResolveType
    );
    t.ok('an unrecognized curve fails', !badCurve.ok);

    // THE TESTAMENT'S OWN CLAIM: "fails at author time, not at the table".
    const unknownKey = validateCue(
      cue({ targets: { 'made.up.key': { to: 1, overMs: 1000, curve: 'ease' } } }),
      fakeResolveType
    );
    t.ok('a target key nothing can resolve fails — the exact author-time failure §4.3 promises', !unknownKey.ok);
    t.ok(
      'the error explains WHY (unresolvable), not just that it failed',
      unknownKey.errors.some((e) => e.includes('no fade source resolves'))
    );

    const nonFadeableType = validateCue(
      cue({ targets: { 'water.debugLabel': { to: 'x', overMs: 1000, curve: 'ease' } } }),
      fakeResolveType
    );
    t.ok('a real key whose TYPE is not fadeable (text) still fails', !nonFadeableType.ok);
  }

  // ---- validateCueStack ---------------------------------------------------
  {
    const stack = [cue({ id: 'a', order: 0 }), cue({ id: 'b', order: 1 }), cue({ id: 'c', order: 2 })];
    const r = validateCueStack(stack, fakeResolveType);
    t.ok('three well-formed, distinct cues pass as a stack', r.ok);

    t.ok('a non-array is rejected, not thrown on', !validateCueStack({}, fakeResolveType).ok);
    t.ok('an empty stack is valid (zero cues authored yet is not an error)', validateCueStack([], fakeResolveType).ok);

    const dupIds = validateCueStack([cue({ id: 'x', order: 0 }), cue({ id: 'x', order: 1 })], fakeResolveType);
    t.ok('duplicate ids across the stack fail', !dupIds.ok);
    t.ok(
      'the duplicate-id error names the collision',
      dupIds.errors.some((e) => e.includes('duplicate id'))
    );

    const dupOrders = validateCueStack([cue({ id: 'x', order: 5 }), cue({ id: 'y', order: 5 })], fakeResolveType);
    t.ok('two cues fighting for the same order fail', !dupOrders.ok);

    const oneBadOneGood = validateCueStack(
      [
        cue({ id: 'good', order: 0 }),
        cue({ id: 'bad', order: 1, targets: { 'nope.nope': { to: 1, overMs: 0, curve: 'linear' } } }),
      ],
      fakeResolveType
    );
    t.ok('one bad cue in an otherwise-valid stack still fails the whole stack', !oneBadOneGood.ok);
    t.ok(
      "each error is prefixed with ITS OWN cue's id, not a generic message",
      oneBadOneGood.errors.some((e) => e.startsWith('bad:'))
    );
  }

  // ---- orderedCues ---------------------------------------------------------
  {
    const stack = [cue({ id: 'third', order: 2 }), cue({ id: 'first', order: 0 }), cue({ id: 'second', order: 1 })];
    const ordered = orderedCues(stack);
    t.ok('orderedCues sorts by order, not input position', ordered.map((c) => c.id).join(',') === 'first,second,third');
    t.ok('orderedCues does not mutate the input array', stack[0].id === 'third');
    t.ok('orderedCues on undefined returns an empty array, not a throw', orderedCues(undefined).length === 0);

    const missingOrder = orderedCues([cue({ id: 'a', order: 5 }), cue({ id: 'b', order: undefined })]);
    t.ok('a cue with no order sorts as if it were 0, never throws', missingOrder.length === 2);
  }

  // ---- cueToFadePatch -------------------------------------------------------
  {
    const patch = cueToFadePatch(cue(), fakeReadLive, fakeResolveType);
    t.ok(
      "the patch id is namespaced 'cue:<id>' — never collides with an ad-hoc mood-chip gesture id",
      patch.id === 'cue:dusk-falls'
    );
    t.ok("the patch label is the cue's own name", patch.label === 'Dusk falls');
    t.ok("every target carries the cue's own to/overMs/curve", patch.targets['weather.cloudCover01'].to === 0.9);
    t.ok(
      "every target's `from` comes from the injected readLive, not invented",
      patch.targets['weather.cloudCover01'].from === 0.2
    );
    t.ok(
      "every target's `type` comes from the injected resolveType",
      patch.targets['weather.cloudCover01'].type === 'float'
    );

    const multiTarget = cueToFadePatch(
      cue({
        targets: {
          'weather.cloudCover01': { to: 0.9, overMs: 1000, curve: 'ease' },
          'water.depth': { to: 0.1, overMs: 500, curve: 'linear' },
        },
      }),
      fakeReadLive,
      fakeResolveType
    );
    t.ok('a multi-target cue produces one patch entry per target', Object.keys(multiTarget.targets).length === 2);
    t.ok('each target resolves its OWN live value independently', multiTarget.targets['water.depth'].from === 0.5);
  }
}
