/**
 * axis-consumer-registry.test.mjs — the real-consumer table stays honest
 * against `WEATHER_AXES`'s own declared `consumerStatus` (mythica-machina-
 * press#390), and the audit function itself catches both directions of
 * drift on synthetic data before trusting it against the real table.
 */
import { WEATHER_AXES } from '../weather.js';
import { AXIS_CONSUMERS, hasRealConsumer, auditAxisConsumers } from '../axis-consumer-registry.js';

export function run(t) {
  const { ok } = t;

  // ---- the real table, cross-checked against the real axes ----------------
  {
    const problems = auditAxisConsumers(WEATHER_AXES);
    ok(`WEATHER_AXES and AXIS_CONSUMERS agree (${problems.join(' | ') || 'clean'})`, problems.length === 0);
  }

  // ---- every declared axis has a table entry, even if empty ---------------
  {
    const missing = Object.keys(WEATHER_AXES).filter((name) => !(name in AXIS_CONSUMERS));
    ok(
      `every WEATHER_AXES key has an AXIS_CONSUMERS entry (missing: ${missing.join(', ') || 'none'})`,
      missing.length === 0
    );
  }

  // ---- hasRealConsumer, against the REAL table -----------------------------
  {
    ok('cloudCover01 (declared live) has a real consumer', hasRealConsumer('cloudCover01') === true);
    ok('cloudType01 (declared live, wired 2026-09-10) has a real consumer', hasRealConsumer('cloudType01') === true);
    ok('an unknown axis name reports no consumer, never a crash', hasRealConsumer('nonsenseAxis') === false);
  }

  // ---- the audit's OWN logic, on a small injected fixture — NOT the real
  // table, which this file's own header says is expected to keep filling in
  // (every axis it once used as "the genuinely still-empty example" has,
  // correctly, stopped being empty over time; hardcoding a real axis name
  // here would make this block a flake waiting for the next wiring pass) ---
  {
    const fixture = Object.freeze({
      wiredAxis: Object.freeze([Object.freeze({ module: 'some/real-file.js', describe: 'a real consumer' })]),
      emptyAxis: Object.freeze([]),
    });

    const problems1 = auditAxisConsumers({ emptyAxis: { consumerStatus: 'live' } }, fixture);
    ok(
      "flags 'live' with zero registered consumers",
      problems1.some((p) => /emptyAxis.*live.*no real consumer/.test(p))
    );

    const problems2 = auditAxisConsumers({ wiredAxis: { consumerStatus: 'pending' } }, fixture);
    ok(
      "flags 'pending' when real consumers already exist (the axis went live silently)",
      problems2.some((p) => /wiredAxis.*pending.*real consumer/.test(p))
    );

    const problems3 = auditAxisConsumers({ someNewAxis: { consumerStatus: 'pending' } }, fixture);
    ok(
      'flags an axis with no AXIS_CONSUMERS entry at all',
      problems3.some((p) => /someNewAxis.*no entry in AXIS_CONSUMERS/.test(p))
    );

    const clean = auditAxisConsumers(
      { wiredAxis: { consumerStatus: 'live' }, emptyAxis: { consumerStatus: 'pending' } },
      fixture
    );
    ok('a genuinely consistent pair of entries raises nothing', clean.length === 0);

    // `undefined` degrades to "no axes declared at all", which correctly
    // flags every fixture entry as stale against that empty input (there's
    // nothing left to agree with) — the point of this assertion is only
    // that it returns an array and never throws.
    let threw = false;
    let result = null;
    try {
      result = auditAxisConsumers(undefined, fixture);
    } catch (_e) {
      threw = true;
    }
    ok('auditAxisConsumers never throws on undefined input', threw === false && Array.isArray(result));
  }
}
