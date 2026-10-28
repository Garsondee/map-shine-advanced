/**
 * safe-mode.test.mjs — the crash ladder's POLICY (2026-10-27, epic mmp-fpu).
 *
 * The behaviour that matters, in the order a player meets it: a load that died
 * is never repeated unchanged; each crash climbs exactly one rung; a rung that
 * survives is remembered; reloading an impatient load is not a crash; a second
 * tab mid-load is not a crash; a fix gets a fresh chance; and nothing read from
 * storage can make the boot throw.
 */
import {
  HEARTBEAT_STALE_MS,
  MAX_SAFE_LEVEL,
  SAFE_LEVEL,
  beginBoot,
  crashEvidence,
  decideBoot,
  describeDecision,
  emptyRecord,
  getSafeProfile,
  markInterrupted,
  markLost,
  markStable,
  pulse,
  safeProfileForLevel,
  sanitizeRecord,
  setSafeLevel,
  withInFlight,
} from '../safe-mode.js';

const T0 = 1_000_000;

/** Run a whole load on `record` the way the guard does, ending as `how`. */
function load(record, how, { mode = 'auto', build = 'b1', at = T0 } = {}) {
  const decision = decideBoot(record, { mode, build, nowMs: at });
  let r = beginBoot(record, decision, { nowMs: at, scene: 'scene-a', build });
  if (how === 'stable') r = markStable(r, at + 20_000);
  else if (how === 'lost') r = markLost(r, { nowMs: at + 5_000, message: 'device lost', reason: 'unknown' });
  else if (how === 'interrupted') r = markInterrupted(r, at + 3_000);
  // how === 'died': the tab vanished mid-boot — the record is left as `booting`.
  return { decision, record: r };
}

export function run(t) {
  const { ok } = t;

  // ── THE PROFILES ─────────────────────────────────────────────────────────
  {
    const names = [0, 1, 2, 3].map((l) => safeProfileForLevel(l).name);
    ok('four rungs, named full / careful / minimal / foundry', names.join() === 'full,careful,minimal,foundry');
    ok('level 0 builds everything', safeProfileForLevel(0).candleMemory && safeProfileForLevel(0).lightWind);
    ok(
      'level 0 keeps the 4-octave turbulence stack the field was tuned on',
      safeProfileForLevel(0).windTurbulenceOctaves === 4
    );
    ok(
      'level 1 drops only the candle memory',
      !safeProfileForLevel(1).candleMemory &&
        safeProfileForLevel(1).lightWind &&
        safeProfileForLevel(1).forcePerformanceProfile === null
    );
    ok(
      'level 2 forces the low profile and calmer wind',
      safeProfileForLevel(2).forcePerformanceProfile === 'low' &&
        !safeProfileForLevel(2).lightWind &&
        safeProfileForLevel(2).windTurbulenceOctaves < 4
    );
    ok(
      'only the last rung stops MSA from starting',
      [0, 1, 2].every((l) => safeProfileForLevel(l).startMsa) && !safeProfileForLevel(3).startMsa
    );
    ok(
      'out-of-range and non-numeric levels clamp instead of throwing',
      safeProfileForLevel(99).level === 3 && safeProfileForLevel(-4).level === 0 && safeProfileForLevel(NaN).level === 0
    );
    ok('profiles are frozen — a builder cannot mutate the ladder', Object.isFrozen(safeProfileForLevel(1)));
    setSafeLevel(2);
    ok('setSafeLevel changes what builders see', getSafeProfile().level === 2);
    setSafeLevel(0);
    ok('...and resets', getSafeProfile().level === 0);
  }

  // ── A CLEAN FIRST RUN ────────────────────────────────────────────────────
  {
    const d = decideBoot(undefined, { mode: 'auto', build: 'b1', nowMs: T0 });
    ok(
      'no record at all → full quality, nothing to report',
      d.level === 0 && d.reason === 'fresh' && !d.changed && d.evidence === null
    );
  }

  // ── A LOAD THAT DIES IS NEVER REPEATED UNCHANGED ─────────────────────────
  {
    const r = load(emptyRecord(), 'lost').record;
    const second = load(r, 'lost');
    ok(
      'after a device loss the next load climbs one rung',
      second.decision.level === 1 && second.decision.reason === 'crash' && second.decision.changed
    );
    ok('...and names the evidence', second.decision.evidence?.kind === 'device-lost');
    const third = load(second.record, 'lost');
    ok('a second loss climbs again', third.decision.level === 2 && third.decision.consecutive === 2);
    const fourth = load(third.record, 'lost');
    ok('a third loss reaches the last rung', fourth.decision.level === SAFE_LEVEL.FOUNDRY);
    const fifth = load(fourth.record, 'lost');
    ok('it never climbs past the last rung', fifth.decision.level === MAX_SAFE_LEVEL);
  }

  // ── A TAB THAT DIED MID-BOOT IS A CRASH; A LIVE ONE IS NOT ───────────────
  {
    const died = load(emptyRecord(), 'died').record;
    const later = decideBoot(died, { build: 'b1', nowMs: T0 + HEARTBEAT_STALE_MS + 1 });
    ok(
      'a booting record whose pulse went quiet counts as a crash',
      later.reason === 'crash' && later.level === 1 && later.evidence?.kind === 'died-while-booting'
    );
    const concurrent = decideBoot(died, { build: 'b1', nowMs: T0 + 2_000 });
    ok(
      'a second tab opened mid-load does NOT read the first as dead',
      concurrent.reason === 'fresh' && concurrent.level === 0
    );
    const pulsed = pulse(died, T0 + 9_000);
    ok(
      'a pulse keeps the record alive past the stale window',
      decideBoot(pulsed, { build: 'b1', nowMs: T0 + 9_000 + HEARTBEAT_STALE_MS - 1 }).evidence === null
    );
    ok('pulse only touches a booting record', pulse(markStable(died, T0 + 1), T0 + 9).heartbeatAt === T0 + 1);
  }

  // ── NOT EVERY INTERRUPTED LOAD IS A CRASH ────────────────────────────────
  {
    const r = load(emptyRecord(), 'interrupted').record;
    ok('a clean unload mid-boot records `interrupted`', r.state === 'interrupted');
    const next = decideBoot(r, { build: 'b1', nowMs: T0 + 10 * HEARTBEAT_STALE_MS });
    ok('...and the next load does not climb', next.level === 0 && next.evidence === null);
    ok('markInterrupted leaves a settled record alone', markInterrupted(markStable(r, 1), 2).state === 'stable');
  }

  // ── A RUNG THAT SURVIVES IS REMEMBERED (AND NEVER PROBED) ────────────────
  {
    const r = load(emptyRecord(), 'lost').record;
    const careful = load(r, 'stable');
    ok(
      'the careful rung survives',
      careful.decision.level === 1 && careful.record.state === 'stable' && careful.record.consecutive === 0
    );
    const again = load(careful.record, 'stable');
    ok(
      'the next load carries the rung that worked',
      again.decision.level === 1 && again.decision.reason === 'carried' && again.decision.changed
    );
    let r2 = careful.record;
    for (let i = 0; i < 10; i++) r2 = load(r2, 'stable').record;
    ok('ten more stable loads never probe a lower rung', decideBoot(r2, { build: 'b1', nowMs: T0 }).level === 1);
    ok(
      'a stable load clears the consecutive counter',
      markStable({ ...beginBoot(emptyRecord(), { level: 1, consecutive: 3 }, { nowMs: 1 }) }, 2).consecutive === 0
    );
  }

  // ── A LATE TIMER CANNOT UNDO A LOSS ──────────────────────────────────────
  {
    const lost = load(emptyRecord(), 'lost').record;
    ok('markStable after a loss keeps the loss', markStable(lost, T0 + 99_000).state === 'lost');
  }

  // ── THE PLAYER'S OWN SETTING ─────────────────────────────────────────────
  {
    const lost = load(emptyRecord(), 'lost').record;
    const off = decideBoot(lost, { mode: 'off', build: 'b1', nowMs: T0 });
    ok(
      'guard off → always full quality, even after a loss',
      off.level === 0 && off.reason === 'guard-off' && off.evidence === null
    );
    const careful = decideBoot(emptyRecord(), { mode: 'careful', build: 'b1', nowMs: T0 });
    const minimal = decideBoot(emptyRecord(), { mode: 'minimal', build: 'b1', nowMs: T0 });
    ok(
      'forcing careful / minimal sets exactly that rung',
      careful.level === 1 && minimal.level === 2 && careful.reason === 'forced'
    );
    ok('a forced rung is reported to the player', careful.changed && describeDecision(careful).includes('careful'));
    const unknown = decideBoot(lost, { mode: 'banana', build: 'b1', nowMs: T0 });
    ok('an unknown mode behaves as auto', unknown.reason === 'crash');
  }

  // ── A NEW BUILD GETS A FRESH CHANCE ──────────────────────────────────────
  {
    const stuck = load(load(emptyRecord(), 'lost', { build: 'b1' }).record, 'lost', { build: 'b1' }).record;
    const fresh = decideBoot(stuck, { build: 'b2', nowMs: T0 });
    ok(
      'after an update the ladder resets to full',
      fresh.level === 0 && fresh.reason === 'new-build' && fresh.consecutive === 0
    );
    ok('the same build keeps climbing', decideBoot(stuck, { build: 'b1', nowMs: T0 }).level >= 2);
    ok('an unknown build never resets (cannot tell)', decideBoot(stuck, { build: '', nowMs: T0 }).level >= 2);
  }

  // ── THE BREADCRUMBS SURVIVE INTO THE NEXT BOOT ───────────────────────────
  {
    let r = beginBoot(emptyRecord(), { level: 0, consecutive: 0 }, { nowMs: T0, build: 'b1' });
    r = withInFlight(r, [
      { label: 'candle-light', chars: 90_000, startedAt: T0 + 1 },
      { label: 'vegetation', chars: 40_000 },
    ]);
    r = markLost(r, { nowMs: T0 + 9, message: 'A valid external Instance reference no longer exists.' });
    const ev = crashEvidence(r, T0 + 10);
    ok(
      'the loss carries the shaders that were compiling',
      ev?.inFlight.length === 2 && ev.inFlight[0].label === 'candle-light'
    );
    ok('...and the message', ev?.message.includes('Instance reference'));
    const fromJson = sanitizeRecord(JSON.parse(JSON.stringify(r)));
    ok(
      'the record survives a JSON round trip',
      fromJson.lastLoss?.inFlight[0].chars === 90_000 && fromJson.state === 'lost'
    );
    const many = withInFlight(
      r,
      Array.from({ length: 40 }, (_, i) => ({ label: `p${i}`, chars: i }))
    );
    ok('the stored list is capped so localStorage stays small', many.inFlight.length <= 12);
  }

  // ── NOTHING FROM STORAGE CAN THROW ───────────────────────────────────────
  {
    const junk = [
      null,
      undefined,
      0,
      'x',
      [],
      {},
      { v: 2 },
      { v: 1, state: 'banana', level: 'NaN', inFlight: 'no', lastLoss: 5 },
      { v: 1, level: 999, consecutive: -4 },
    ];
    let threw = false;
    let allWellFormed = true;
    for (const raw of junk) {
      try {
        const s = sanitizeRecord(raw);
        decideBoot(raw, { build: 'b', nowMs: T0 });
        allWellFormed &&= s.v === 1 && s.level >= 0 && s.level <= 3 && s.consecutive >= 0 && Array.isArray(s.inFlight);
      } catch (_) {
        threw = true;
      }
    }
    ok('garbage in storage never throws', !threw);
    ok('...and always comes out as a well-formed record', allWellFormed);
  }

  // ── WHAT THE PLAYER IS TOLD ──────────────────────────────────────────────
  {
    const lost = load(emptyRecord(), 'lost').record;
    const d = decideBoot(lost, { build: 'b1', nowMs: T0 });
    ok(
      'a crash is explained in plain words',
      /graphics card stopped responding/.test(describeDecision(d)) && /careful/.test(describeDecision(d))
    );
    ok('a normal load says nothing', describeDecision(decideBoot(undefined, { build: 'b1', nowMs: T0 })) === '');
  }
}
