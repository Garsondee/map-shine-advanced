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

  // ---- hasRealConsumer ------------------------------------------------------
  {
    ok('cloudCover01 (declared live) has a real consumer', hasRealConsumer('cloudCover01') === true);
    ok('cloudType01 (declared pending) has none', hasRealConsumer('cloudType01') === false);
    ok('an unknown axis name reports no consumer, never a crash', hasRealConsumer('nonsenseAxis') === false);
  }

  // ---- the audit catches BOTH directions of drift, on synthetic data ------
  {
    const problems1 = auditAxisConsumers({ cloudType01: { consumerStatus: 'live' } });
    ok(
      "flags 'live' with zero registered consumers",
      problems1.some((p) => /cloudType01.*live.*no real consumer/.test(p))
    );

    const problems2 = auditAxisConsumers({ cloudCover01: { consumerStatus: 'pending' } });
    ok(
      "flags 'pending' when real consumers already exist (the axis went live silently)",
      problems2.some((p) => /cloudCover01.*pending.*real consumer/.test(p))
    );

    const problems3 = auditAxisConsumers({ someNewAxis: { consumerStatus: 'pending' } });
    ok(
      'flags an axis with no AXIS_CONSUMERS entry at all',
      problems3.some((p) => /someNewAxis.*no entry in AXIS_CONSUMERS/.test(p))
    );

    const clean = auditAxisConsumers({
      cloudCover01: { consumerStatus: 'live' },
      cloudType01: { consumerStatus: 'pending' },
    });
    // NOTE: this subset intentionally omits precip01/temperature01/etc., so
    // the REVERSE check (AXIS_CONSUMERS has an entry the caller's axes object
    // doesn't) fires for every omitted key — that's the audit function
    // working correctly against a partial input, not a bug in this test.
    // Filtered out here to isolate the two directions this block actually
    // means to test.
    const relevant = clean.filter((p) => p.includes('cloudCover01') || p.includes('cloudType01'));
    ok('a genuinely consistent pair of entries raises nothing for those two axes', relevant.length === 0);

    // `undefined` degrades to "no axes declared at all", which correctly
    // flags every REAL AXIS_CONSUMERS entry as stale against that empty
    // input (there's nothing left to agree with) — the point of this
    // assertion is only that it returns an array and never throws.
    let threw = false;
    let result = null;
    try {
      result = auditAxisConsumers(undefined);
    } catch (_e) {
      threw = true;
    }
    ok('auditAxisConsumers never throws on undefined input', threw === false && Array.isArray(result));
  }
}
