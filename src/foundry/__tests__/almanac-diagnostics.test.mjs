/**
 * `buildAlmanacDiagnosticsReport` with zero Foundry globals present — the
 * real behaviour a torture/CI run (or this Node suite) actually exercises.
 * Every section must degrade gracefully rather than throw or silently omit
 * itself (`feedback_instruments_must_not_lie`); the live, populated shape
 * (real `game`/`CONFIG`, real pf2e) is for the author's own click, not
 * something this suite fakes with a Foundry mock.
 */
import { buildAlmanacDiagnosticsReport } from '../almanac-diagnostics.js';

export function run(t) {
  t.ok(
    'never throws with no options and no Foundry globals',
    (() => {
      try {
        buildAlmanacDiagnosticsReport();
        return true;
      } catch {
        return false;
      }
    })()
  );

  const r = buildAlmanacDiagnosticsReport();
  t.ok(
    'carries a report id and a generatedAt timestamp',
    r.report === 'almanac-diagnostics' && typeof r.generatedAt === 'string'
  );

  t.ok('calendarInstall reports unavailable, honestly, not a guessed value', r.calendarInstall.ok === false);
  t.ok('worldTime.raw is null with no game global — never a guessed 0', r.worldTime.raw === null);
  t.ok('worldTime.todHour is null too', r.worldTime.todHour === null);

  t.ok('pf2e.worldClockSetting reports pf2e inactive', r.pf2e.worldClockSetting.ok === false);
  t.ok('pf2e.liveWorldClock reports pf2e inactive too', r.pf2e.liveWorldClock.ok === false);
  t.ok(
    'pf2e.ourProjection explains WHY it was not computed',
    r.pf2e.ourProjection.ok === false && typeof r.pf2e.ourProjection.reason === 'string'
  );

  t.ok('pen.posture is null when not supplied', r.pen.posture === null);
  t.ok('pen.armed is null (unknown) rather than falsely false', r.pen.armed === null);
  t.ok(
    'pen.currentUserIsGM reads false (the real, fail-closed answer with no game global)',
    r.pen.currentUserIsGM === false
  );
  t.ok('pen.combatActive reads false (the real, permissive-default answer)', r.pen.combatActive === false);
  t.ok('pen.auditLog is a real (possibly empty) array, not undefined', Array.isArray(r.pen.auditLog));

  t.ok(
    'pf2eDarknessStanddown reports ok with pf2e inactive (a confirmed, not a failed, read)',
    r.pf2eDarknessStanddown.ok === true && r.pf2eDarknessStanddown.pf2eActive === false
  );

  t.ok('dayClockReconcile explains why it was not computed', r.dayClockReconcile.ok === false);

  // ---- supplying a posture and calendars/projectWorldTime changes exactly the fields that depend on them
  {
    const fakeProject = (worldTimeSeconds, calendarConfig, themeId) => ({
      ok: true,
      dateLine: `fake-${themeId}-${worldTimeSeconds}`,
      calendarName: calendarConfig?.name,
    });
    const r2 = buildAlmanacDiagnosticsReport({
      posture: 'follow',
      calendars: { 'golarion-parity': { name: 'Golarion (PF2E parity)', epochOffsetSeconds: 0 } },
      projectWorldTime: fakeProject,
      dayClockTodHour: 12.5,
    });
    t.ok('a supplied posture is echoed back verbatim', r2.pen.posture === 'follow');
    t.ok("'follow' correctly reports the pen as NOT armed", r2.pen.armed === false);
    // pf2e is still inactive here (no game global), so ourProjection stays
    // "not computed" even with calendars/projectWorldTime supplied — proves
    // the gate is genuinely "pf2e active AND worldTime available", not just
    // "were the functions handed in".
    t.ok('ourProjection still not computed without an active pf2e system', r2.pf2e.ourProjection.ok === false);
    t.ok(
      'dayClockReconcile still reports unavailable (no worldTime.todHour to compare against)',
      r2.dayClockReconcile.ok === false
    );
  }

  {
    const r3 = buildAlmanacDiagnosticsReport({ posture: 'almanac' });
    t.ok("'almanac' correctly reports the pen as armed", r3.pen.armed === true);
  }
}
