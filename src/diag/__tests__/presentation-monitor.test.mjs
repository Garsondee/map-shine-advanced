/**
 * Node verification for diag/presentation-monitor.js — the "two floors on screen" detector
 * (loading audit §6.7). The properties that matter: it catches the lingering-specular shape,
 * it stays quiet when nothing is wrong, and it never claims more than it knows.
 */
import {
  createPresentationMonitor,
  findMixedState,
  DEFAULT_ARM_FRAMES,
  MAX_EXAMPLES,
} from '../presentation-monitor.js';

function recordingLog() {
  const lines = { warn: [], error: [] };
  return { lines, warn: (...a) => lines.warn.push(a.join(' ')), error: (...a) => lines.error.push(a.join(' ')) };
}

export async function run(t) {
  const { ok } = t;

  // --- the pure rule ---------------------------------------------------------
  const rule = findMixedState(1, [
    { name: 'specular', visible: true, floor: 0 }, // the reported bug: lower floor's shine still up
    { name: 'prism', visible: true, floor: 1 },
    { name: 'window tiles', visible: false, floor: 0 }, // stale floor but showing nothing: fine
    { name: 'iridescence', visible: true, floor: null }, // cannot say
  ]);
  ok(
    'a visible consumer on another floor is a violation',
    rule.violations.length === 1 && rule.violations[0].name === 'specular'
  );
  ok('...and it names the floor it is stuck on', rule.violations[0].floor === 0);
  ok('a consumer on the presented floor is clean', !rule.violations.some((v) => v.name === 'prism'));
  ok(
    'a consumer showing nothing is never wrong, whatever it last synced',
    !rule.violations.some((v) => v.name === 'window tiles')
  );
  ok(
    'a visible consumer that cannot name its floor is reported as unreported, not guessed',
    rule.unreported[0] === 'iridescence' && rule.violations.length === 1
  );
  ok(
    'garbage in is empty out',
    findMixedState(0, null).violations.length === 0 && findMixedState(0, [null, undefined]).violations.length === 0
  );
  ok(
    'floor 0 is a real floor (falsy is not "unknown")',
    findMixedState(0, [{ name: 'x', visible: true, floor: 0 }]).violations.length === 0
  );

  // --- not armed: free and silent --------------------------------------------
  {
    const log = recordingLog();
    const m = createPresentationMonitor({ log });
    let probeCalls = 0;
    m.register('specular', () => {
      probeCalls++;
      return { visible: true, floor: 0 };
    });
    ok('a monitor that was never armed does not call a single probe', m.checkFrame(1).length === 0 && probeCalls === 0);
    ok('...and says so, instead of claiming clean', m.getReport().verdict === 'never-armed');
  }

  // --- the scenario: flip to floor 1, specular lags three frames -------------
  {
    const log = recordingLog();
    const m = createPresentationMonitor({ log });
    let specularFloor = 0;
    m.register('specular', () => ({ visible: true, floor: specularFloor }));
    m.register('prism', () => ({ visible: true, floor: 1 }));
    m.arm('floor-change', 10);
    ok('arming opens a window', m.isArmed() === true);

    ok('frame 1: the lag is caught', m.checkFrame(1).length === 1);
    ok('frame 2: still caught', m.checkFrame(1).length === 1);
    ok('frame 3: still caught', m.checkFrame(1).length === 1);
    specularFloor = 1; // the shine finally catches up
    ok('frame 4: clean once it catches up', m.checkFrame(1).length === 0);

    const report = m.getReport();
    ok('three bad frames were counted', report.framesWithMixedState === 3);
    ok('four frames were checked in all', report.framesChecked === 4);
    ok('the verdict says floors were mixed', report.verdict === 'mixed-floors-seen');
    ok('the offender is named with its frame count', report.perConsumer.specular?.frames === 3);
    ok('the well-behaved consumer is not blamed', report.perConsumer.prism === undefined);
    ok('it was logged ONCE, not once per frame', log.lines.warn.length === 1);
    ok(
      '...with the consumer, both floors and the reason',
      /"specular".*floor 0.*floor 1.*floor-change/.test(log.lines.warn[0])
    );
    ok('an example was kept for the report', report.examples.length === 1 && report.examples[0].name === 'specular');
  }

  // --- the window closes by itself -------------------------------------------
  {
    const m = createPresentationMonitor({});
    let calls = 0;
    m.register('a', () => {
      calls++;
      return { visible: true, floor: 0 };
    });
    m.arm('t', 3);
    for (let i = 0; i < 10; i++) m.checkFrame(0);
    ok(
      'it checks exactly the armed number of frames, then stops costing anything',
      calls === 3 && m.isArmed() === false
    );
    m.arm('t2'); // default window
    ok('the default window is the documented one', m.getReport().framesLeft === DEFAULT_ARM_FRAMES);
    m.arm('t3', 5);
    ok('re-arming never SHORTENS an open window', m.getReport().framesLeft === DEFAULT_ARM_FRAMES);
    ok('...and a clean run reads clean', m.getReport().verdict === 'clean');
  }

  // --- a new window logs again; the same window does not ---------------------
  {
    const log = recordingLog();
    const m = createPresentationMonitor({ log });
    m.register('specular', () => ({ visible: true, floor: 0 }));
    m.arm('first', 4);
    m.checkFrame(1);
    m.checkFrame(1);
    m.arm('second', 4);
    m.checkFrame(1);
    ok('a second floor change that goes wrong again is logged again', log.lines.warn.length === 2);
  }

  // --- a broken probe is loud and harmless -----------------------------------
  {
    const log = recordingLog();
    const m = createPresentationMonitor({ log });
    m.register('broken', () => {
      throw new Error('boom');
    });
    m.register('specular', () => ({ visible: true, floor: 0 }));
    m.arm('x', 5);
    let threw = false;
    let caught = [];
    try {
      caught = m.checkFrame(1);
      m.checkFrame(1);
    } catch (_) {
      threw = true;
    }
    ok('a throwing probe never takes the frame down', threw === false);
    ok('...the other probes are still checked', caught.length === 1 && caught[0].name === 'specular');
    ok(
      '...it is counted and logged once, not silently ignored',
      m.getReport().probeErrors === 2 && log.lines.error.length === 1
    );
  }

  // --- unreported consumers surface in the report ----------------------------
  {
    const m = createPresentationMonitor({});
    m.register('mystery', () => ({ visible: true, floor: undefined }));
    m.arm('x', 2);
    m.checkFrame(0);
    ok(
      'a visible consumer that cannot name its floor is listed, never blamed',
      m.getReport().unreportedConsumers[0] === 'mystery' && m.getReport().framesWithMixedState === 0
    );
  }

  // --- bounded memory --------------------------------------------------------
  {
    const m = createPresentationMonitor({});
    for (let i = 0; i < MAX_EXAMPLES + 10; i++) m.register(`c${i}`, () => ({ visible: true, floor: 0 }));
    m.arm('x', 2);
    m.checkFrame(1);
    ok('the examples list is capped', m.getReport().examples.length === MAX_EXAMPLES);
  }

  // --- bad registrations are ignored -----------------------------------------
  {
    const m = createPresentationMonitor({});
    m.register('', () => ({ visible: true, floor: 0 }));
    m.register('x', null);
    ok('a nameless or probe-less registration is ignored', m.getReport().consumers.length === 0);
  }
}
