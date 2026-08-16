/**
 * THE EVENTS ENGINE — pure math (docs/planning/Weather-Manager.md §6.1-§6.2).
 *
 * What is proven here:
 *   - the closed list and the defaults table never drift apart;
 *   - every kind's authored defaults are internally well-formed;
 *   - `envelopePhase` ramps attack→sustain→release→done correctly, for both a
 *     numeric sustain (auto-advances) and `'held'` (needs an explicit release);
 *   - an explicit release always wins over the natural schedule, from ANY phase;
 *   - `composeOverride` is a true no-op at progress 0 and each op's own neutral,
 *     and lerps the RESULT (not toward a neutral) in between;
 *   - `applyEventOverrides` folds multiple events in insertion order, is pure
 *     (never mutates its input), and ignores overrides naming an absent axis;
 *   - only `ash-storm` actually moves an axis this slice — the other eight
 *     kinds are honestly inert pending slice 5/6 (`weather-events.js`'s header).
 */
import {
  EVENT_KINDS,
  EVENT_KIND_DEFAULTS,
  OVERRIDE_OPS,
  OP_NEUTRAL,
  resolveEventKind,
  envelopePhase,
  composeOverride,
  applyEventOverrides,
} from '../weather-events.js';

export function run(t) {
  // ---- the closed list + defaults table -------------------------------------
  {
    t.ok('9 event kinds ship in slice 4', EVENT_KINDS.length === 9);
    t.ok(
      'the closed list and the defaults table name exactly the same kinds',
      EVENT_KINDS.length === Object.keys(EVENT_KIND_DEFAULTS).length &&
        EVENT_KINDS.every((k) => Object.hasOwn(EVENT_KIND_DEFAULTS, k))
    );
    t.ok(
      'every kind declares a well-formed envelope',
      EVENT_KINDS.every((k) => {
        const e = EVENT_KIND_DEFAULTS[k].envelope;
        const sustainOk = e.sustainSec === 'held' || (Number.isFinite(e.sustainSec) && e.sustainSec >= 0);
        return (
          Number.isFinite(e.attackSec) &&
          e.attackSec >= 0 &&
          Number.isFinite(e.releaseSec) &&
          e.releaseSec >= 0 &&
          sustainOk
        );
      })
    );
    t.ok(
      'every kind declares an intensity inside [0,1]',
      EVENT_KINDS.every((k) => {
        const v = EVENT_KIND_DEFAULTS[k].intensity01;
        return Number.isFinite(v) && v >= 0 && v <= 1;
      })
    );
    t.ok(
      'every kind declares overrides as an array (empty is honest, absent is not)',
      EVENT_KINDS.every((k) => Array.isArray(EVENT_KIND_DEFAULTS[k].overrides))
    );
    t.ok(
      'ONLY ash-storm moves an axis this slice — the other 8 are honestly empty',
      Object.values(EVENT_KIND_DEFAULTS).filter((d) => d.overrides.length > 0).length === 1 &&
        EVENT_KIND_DEFAULTS['ash-storm'].overrides.length > 0
    );
    t.ok(
      "ash-storm's own overrides only touch axes this slice actually owns",
      EVENT_KIND_DEFAULTS['ash-storm'].overrides.every((ov) => ['cloudCover01', 'cloudType01'].includes(ov.axis))
    );
    t.ok(
      "sky-flash sums to exactly 300ms (§6.2's own number)",
      (() => {
        const e = EVENT_KIND_DEFAULTS['sky-flash'].envelope;
        return Math.abs(e.attackSec + e.sustainSec + e.releaseSec - 0.3) < 1e-9;
      })()
    );
    t.ok(
      'sky-flash is the one kind with a numeric (not held) sustain — fire and forget',
      EVENT_KIND_DEFAULTS['sky-flash'].envelope.sustainSec !== 'held'
    );
    t.ok(
      'every OTHER kind is held — a GM decides when it ends',
      EVENT_KINDS.filter((k) => k !== 'sky-flash').every((k) => EVENT_KIND_DEFAULTS[k].envelope.sustainSec === 'held')
    );
    t.ok(
      'sky-flash carries a11yFlash — the one kind the flag actually matters for',
      EVENT_KIND_DEFAULTS['sky-flash'].a11yFlash === true
    );
    t.ok(
      'no other kind claims a11yFlash it does not need',
      EVENT_KINDS.filter((k) => k !== 'sky-flash').every((k) => EVENT_KIND_DEFAULTS[k].a11yFlash === false)
    );
  }

  // ---- resolveEventKind -------------------------------------------------------
  {
    const hit = resolveEventKind('ash-storm');
    t.ok('a known kind resolves ok', hit.ok === true && hit.defaults === EVENT_KIND_DEFAULTS['ash-storm']);
    const miss = resolveEventKind('made-up-kind');
    t.ok(
      'an unknown kind fails OPEN, not throws',
      miss.ok === false && miss.defaults === null && typeof miss.reason === 'string'
    );
    const empty = resolveEventKind(undefined);
    t.ok('undefined kind also fails open cleanly', empty.ok === false);
  }

  // ---- OVERRIDE_OPS / OP_NEUTRAL ----------------------------------------------
  {
    t.ok(
      '5 ops, the exact closed list',
      OVERRIDE_OPS.length === 5 && ['set', 'max', 'min', 'add', 'mul'].every((o) => OVERRIDE_OPS.includes(o))
    );
    t.ok('set has no numeric neutral, by design', OP_NEUTRAL.set === undefined);
    for (const [op, neutral] of [
      ['max', OP_NEUTRAL.max],
      ['min', OP_NEUTRAL.min],
      ['add', OP_NEUTRAL.add],
      ['mul', OP_NEUTRAL.mul],
    ]) {
      t.ok(
        `${op}'s declared neutral is a true no-op at full progress`,
        composeOverride(5, { op, value: neutral }, 1) === 5
      );
    }
  }

  // ---- composeOverride ---------------------------------------------------------
  {
    t.ok('progress 0 is always a no-op, regardless of op', composeOverride(0.3, { op: 'set', value: 0.9 }, 0) === 0.3);
    t.ok('progress 1 with set fully applies', composeOverride(0.3, { op: 'set', value: 0.9 }, 1) === 0.9);
    t.ok(
      'progress 0.5 with set lerps exactly halfway',
      Math.abs(composeOverride(0.2, { op: 'set', value: 1.0 }, 0.5) - 0.6) < 1e-9
    );
    t.ok('progress 1 with max fully applies', composeOverride(0.2, { op: 'max', value: 0.85 }, 1) === 0.85);
    t.ok(
      'max never lowers a value already above its floor',
      composeOverride(0.95, { op: 'max', value: 0.85 }, 1) === 0.95
    );
    t.ok('progress 1 with min fully applies', composeOverride(0.9, { op: 'min', value: 0.4 }, 1) === 0.4);
    t.ok('progress 1 with add fully applies', Math.abs(composeOverride(2, { op: 'add', value: 3 }, 1) - 5) < 1e-9);
    t.ok(
      'progress 0.5 with add lerps exactly halfway',
      Math.abs(composeOverride(2, { op: 'add', value: 4 }, 0.5) - 4) < 1e-9
    );
    t.ok('progress 1 with mul fully applies', Math.abs(composeOverride(2, { op: 'mul', value: 3 }, 1) - 6) < 1e-9);
    t.ok('progress out of [0,1] is clamped, not extrapolated', composeOverride(0, { op: 'set', value: 10 }, 5) === 10);
  }

  // ---- envelopePhase — natural schedule (no explicit release) -----------------
  {
    const env = { attackSec: 10, sustainSec: 20, releaseSec: 5 }; // numeric sustain
    let r = envelopePhase(env, 0, null);
    t.ok('t=0 starts mid-attack at progress 0', r.phase === 'attack' && r.progress01 === 0);
    r = envelopePhase(env, 5, null);
    t.ok('t=attack/2 is half-attacked', r.phase === 'attack' && Math.abs(r.progress01 - 0.5) < 1e-9);
    r = envelopePhase(env, 10, null);
    t.ok('t=attack lands exactly on sustain at full progress', r.phase === 'sustain' && r.progress01 === 1);
    r = envelopePhase(env, 25, null);
    t.ok('mid-sustain (numeric) stays at full progress', r.phase === 'sustain' && r.progress01 === 1);
    r = envelopePhase(env, 30, null);
    t.ok('sustain expiring auto-advances into release at full progress', r.phase === 'release' && r.progress01 === 1);
    r = envelopePhase(env, 32.5, null);
    t.ok('mid-release is half-released', r.phase === 'release' && Math.abs(r.progress01 - 0.5) < 1e-9);
    r = envelopePhase(env, 35, null);
    t.ok('release fully elapsed is DONE, progress 0', r.phase === 'done' && r.progress01 === 0);
    r = envelopePhase(env, 1000, null);
    t.ok('long past done stays done, never wraps or reactivates', r.phase === 'done');
  }

  // ---- envelopePhase — held sustain never auto-advances ------------------------
  {
    const held = { attackSec: 10, sustainSec: 'held', releaseSec: 5 };
    let r = envelopePhase(held, 10, null);
    t.ok('held: reaches sustain at full progress', r.phase === 'sustain' && r.progress01 === 1);
    r = envelopePhase(held, 1e6, null);
    t.ok(
      'held: a million seconds later, STILL sustaining — nothing auto-releases it',
      r.phase === 'sustain' && r.progress01 === 1
    );
    r = envelopePhase(held, 1e6, 0);
    t.ok(
      'held: an explicit release (elapsedSinceRelease=0) starts the ramp at full progress',
      r.phase === 'release' && r.progress01 === 1
    );
    r = envelopePhase(held, 1e6, 2.5);
    t.ok('held: mid-release after explicit trigger', r.phase === 'release' && Math.abs(r.progress01 - 0.5) < 1e-9);
    r = envelopePhase(held, 1e6, 5);
    t.ok('held: release fully elapsed is done', r.phase === 'done');
  }

  // ---- envelopePhase — explicit release always wins, from ANY natural phase ---
  {
    const env = { attackSec: 10, sustainSec: 20, releaseSec: 5 };
    let r = envelopePhase(env, 3, 0); // natural schedule says "attack"; release just triggered
    t.ok(
      'a release triggered mid-attack overrides the natural attack phase',
      r.phase === 'release' && r.progress01 === 1
    );
    r = envelopePhase(env, 15, 0); // natural schedule says "sustain"
    t.ok(
      'a release triggered mid-sustain overrides the natural sustain phase',
      r.phase === 'release' && r.progress01 === 1
    );
  }

  // ---- envelopePhase — zero-duration edges --------------------------------------
  {
    const instant = { attackSec: 0, sustainSec: 'held', releaseSec: 0 };
    let r = envelopePhase(instant, 0, null);
    t.ok('zero attack starts already-sustaining, not stuck at attack', r.phase === 'sustain' && r.progress01 === 1);
    r = envelopePhase(instant, 500, 0);
    t.ok('zero release snaps straight to done the instant release triggers', r.phase === 'done');
  }

  // ---- applyEventOverrides — purity + folding ------------------------------------
  {
    const base = Object.freeze({ cloudCover01: 0.2, cloudType01: 0.5, cloudAltitudePx: 1400, cloudScalePx: 1100 });

    const empty = applyEventOverrides(base, [], 0);
    t.ok('no active events: values pass through unchanged', empty.cloudCover01 === 0.2 && empty.cloudType01 === 0.5);
    t.ok('no active events: still a genuine COPY, not the same reference', empty !== base);

    const fullAsh = {
      spec: {
        overrides: [
          { axis: 'cloudCover01', op: 'max', value: 0.85 },
          { axis: 'cloudType01', op: 'set', value: 1.0 },
        ],
        envelope: { attackSec: 0, sustainSec: 'held', releaseSec: 45 },
        intensity01: 1,
      },
      startedAtRealSec: 0,
      releasedAtRealSec: null,
    };
    const composed = applyEventOverrides(base, [fullAsh], 100);
    t.ok(
      'a fully-ramped-in event fully applies its overrides',
      composed.cloudCover01 === 0.85 && composed.cloudType01 === 1.0
    );
    t.ok(
      'an override never touches an axis it does not name',
      composed.cloudAltitudePx === 1400 && composed.cloudScalePx === 1100
    );
    t.ok('applyEventOverrides never mutates its input', base.cloudCover01 === 0.2 && base.cloudType01 === 0.5);

    const midAttack = {
      spec: {
        overrides: [{ axis: 'cloudCover01', op: 'set', value: 1.0 }],
        envelope: { attackSec: 10, sustainSec: 'held', releaseSec: 5 },
        intensity01: 1,
      },
      startedAtRealSec: 0,
      releasedAtRealSec: null,
    };
    const half = applyEventOverrides(base, [midAttack], 5); // exactly half-attacked
    t.ok(
      'a mid-attack event applies a PARTIAL effect, neither 0 nor full',
      half.cloudCover01 > 0.2 && half.cloudCover01 < 1.0
    );

    // Two events on the SAME axis — fold order must be insertion order.
    const first = {
      spec: {
        overrides: [{ axis: 'cloudCover01', op: 'max', value: 0.5 }],
        envelope: { attackSec: 0, sustainSec: 'held', releaseSec: 1 },
        intensity01: 1,
      },
      startedAtRealSec: 0,
      releasedAtRealSec: null,
    };
    const second = {
      spec: {
        overrides: [{ axis: 'cloudCover01', op: 'add', value: 0.1 }],
        envelope: { attackSec: 0, sustainSec: 'held', releaseSec: 1 },
        intensity01: 1,
      },
      startedAtRealSec: 0,
      releasedAtRealSec: null,
    };
    const stacked = applyEventOverrides({ cloudCover01: 0.2 }, [first, second], 10);
    // max(0.2, 0.5) = 0.5, then + 0.1 = 0.6 — first-then-second, exactly insertion order.
    t.ok('two events on one axis fold in insertion order', Math.abs(stacked.cloudCover01 - 0.6) < 1e-9);
    const reversed = applyEventOverrides({ cloudCover01: 0.2 }, [second, first], 10);
    // + 0.1 first = 0.3, then max(0.3, 0.5) = 0.5 — a DIFFERENT result, proving order matters.
    t.ok(
      'reversing insertion order genuinely changes the result (order is not incidental)',
      Math.abs(reversed.cloudCover01 - 0.5) < 1e-9
    );

    const doneEvent = {
      spec: {
        overrides: [{ axis: 'cloudCover01', op: 'set', value: 1 }],
        envelope: { attackSec: 0, sustainSec: 1, releaseSec: 1 },
        intensity01: 1,
      },
      startedAtRealSec: 0,
      releasedAtRealSec: null,
    };
    const afterDone = applyEventOverrides({ cloudCover01: 0.2 }, [doneEvent], 100); // long past attack+sustain+release
    t.ok('a DONE event contributes nothing', afterDone.cloudCover01 === 0.2);

    const strangerAxis = {
      spec: {
        overrides: [{ axis: 'notARealAxis', op: 'set', value: 99 }],
        envelope: { attackSec: 0, sustainSec: 'held', releaseSec: 1 },
        intensity01: 1,
      },
      startedAtRealSec: 0,
      releasedAtRealSec: null,
    };
    const untouched = applyEventOverrides({ cloudCover01: 0.2 }, [strangerAxis], 10);
    t.ok(
      'an override naming an axis absent from baseState is ignored, not appended',
      untouched.cloudCover01 === 0.2 && !Object.hasOwn(untouched, 'notARealAxis')
    );

    const dialedDown = {
      spec: {
        overrides: [{ axis: 'cloudCover01', op: 'set', value: 1.0 }],
        envelope: { attackSec: 0, sustainSec: 'held', releaseSec: 1 },
        intensity01: 0.5,
      },
      startedAtRealSec: 0,
      releasedAtRealSec: null,
    };
    const halfIntensity = applyEventOverrides({ cloudCover01: 0.0 }, [dialedDown], 10);
    t.ok(
      "intensity01 scales the effect even at full envelope progress — a mild event doesn't hit full strength",
      Math.abs(halfIntensity.cloudCover01 - 0.5) < 1e-9
    );
  }
}
