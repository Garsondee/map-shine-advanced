/**
 * WEATHER EVENTS, WIRED INTO THE MANAGER (docs/planning/Weather-Manager.md §6.1).
 *
 * What is proven here, beyond weather-events.test.mjs's pure-math coverage:
 *   - `addEvent`/`releaseEvent`/`removeEvent` fail open exactly like
 *     `setBiome`/`applyArchetype` do for a bad id, never throw;
 *   - ⭐ THE CENTRAL GUARANTEE: `read().state` (the walk/director's own truth,
 *     what a GM's slider shows) is NEVER touched by an event, even a fully
 *     ramped-in one — only `toSnapshotWeather()`/`getStatus()` show the
 *     composed view. This is the one property the whole "read-time overlay,
 *     never a second write path" design rests on.
 *   - `toSnapshotWeather()` re-clamps a composed value back into range;
 *   - `version` bumps on add/release/remove, never on envelope ramping alone;
 *   - events apply identically in Director and Almanac mode (LAW 1);
 *   - an event's envelope runs on real time UNSCALED by `transitionSpeed` —
 *     a different clock from the axis ease, on purpose.
 */
import { createWeatherManager } from '../weather.js';

export function run(t) {
  // ---- addEvent: fail-open shape, matching setBiome/applyArchetype ------------
  {
    const mgr = createWeatherManager();
    const v0 = mgr.read().version;

    const bad = mgr.addEvent({ kind: 'not-a-real-kind' });
    t.ok(
      'an unknown kind fails open, not throws',
      bad.ok === false && bad.id === null && typeof bad.reason === 'string'
    );
    t.ok('a refused addEvent does not bump version', mgr.read().version === v0);
    t.ok('a refused addEvent leaves no trace in getActiveEvents', mgr.getActiveEvents().length === 0);

    const good = mgr.addEvent({ kind: 'ash-storm' });
    t.ok(
      'a known kind is accepted with an auto id',
      good.ok === true && typeof good.id === 'string' && good.id.length > 0
    );
    t.ok('accepting an event bumps version', mgr.read().version > v0);
    t.ok(
      'the accepted event appears in getActiveEvents',
      mgr.getActiveEvents().some((e) => e.id === good.id)
    );

    const dup = mgr.addEvent({ kind: 'mana-storm', id: good.id });
    t.ok('a duplicate id is refused, not silently overwritten', dup.ok === false && /already active/.test(dup.reason));
    t.ok(
      'the original event is untouched by the refused duplicate',
      mgr.getActiveEvents().find((e) => e.id === good.id)?.kind === 'ash-storm'
    );
  }

  // ---- addEvent: bad overrides are dropped and reported, not fatal ------------
  {
    const mgr = createWeatherManager();
    const res = mgr.addEvent({
      kind: 'mana-storm',
      envelope: { attackSec: 0, sustainSec: 'held', releaseSec: 1 }, // instant, isolates the override check below
      overrides: [
        { axis: 'cloudCover01', op: 'set', value: 0.5 }, // valid
        { axis: 'not-a-real-axis', op: 'set', value: 1 }, // bad axis
        { axis: 'cloudType01', op: 'not-a-real-op', value: 1 }, // bad op
      ],
    });
    t.ok('the event is still created despite two bad overrides', res.ok === true);
    t.ok('exactly the two bad overrides are reported dropped', res.droppedOverrides.length === 2);
    mgr.tick(1 / 60); // one frame is enough — attack is instant
    const snap = mgr.toSnapshotWeather();
    t.ok('the surviving valid override still applies', snap.cloudCover01 === 0.5);
  }

  // ---- releaseEvent / removeEvent ----------------------------------------------
  {
    const mgr = createWeatherManager();
    t.ok('releaseEvent on an unknown id returns false', mgr.releaseEvent('nope') === false);
    t.ok('removeEvent on an unknown id returns false', mgr.removeEvent('nope') === false);

    const { id } = mgr.addEvent({ kind: 'ash-storm', envelope: { attackSec: 1, sustainSec: 'held', releaseSec: 1 } });
    t.ok('releaseEvent on a live id returns true', mgr.releaseEvent(id) === true);
    t.ok('releaseEvent is idempotent — releasing twice stays true, no double bump', mgr.releaseEvent(id) === true);

    for (let i = 0; i < 200; i++) mgr.tick(1 / 60); // well past attack(1s)+release(1s)
    t.ok(
      'a fully-released event self-removes via the tick sweep',
      mgr.getActiveEvents().every((e) => e.id !== id)
    );

    const { id: id2 } = mgr.addEvent({ kind: 'sky-flash' });
    t.ok('removeEvent on a live id returns true', mgr.removeEvent(id2) === true);
    t.ok(
      'removeEvent takes effect immediately, no ramp',
      mgr.getActiveEvents().every((e) => e.id !== id2)
    );
  }

  // ---- ⭐ THE CENTRAL GUARANTEE: base state is never corrupted by an event -----
  {
    const mgr = createWeatherManager({ mode: 'director' });
    mgr.jumpTo({ cloudCover01: 0.2, cloudType01: 0.3 });
    const baseBefore = mgr.read().state;

    mgr.addEvent({
      kind: 'ash-storm',
      intensity01: 1, // isolate envelope/state-purity from intensity scaling (covered separately)
      envelope: { attackSec: 0, sustainSec: 'held', releaseSec: 45 }, // instant full effect
    });
    for (let i = 0; i < 10; i++) mgr.tick(1 / 60);

    const composed = mgr.toSnapshotWeather();
    t.ok('the SNAPSHOT shows the event fully composed', composed.cloudCover01 === 0.85 && composed.cloudType01 === 1.0);

    const baseAfter = mgr.read().state;
    t.ok(
      'the BASE state.cloudCover01 is untouched by a fully-active event',
      baseAfter.cloudCover01 === baseBefore.cloudCover01
    );
    t.ok(
      'the BASE state.cloudType01 is untouched by a fully-active event',
      baseAfter.cloudType01 === baseBefore.cloudType01
    );
    t.ok('read().targets is likewise untouched', mgr.read().targets.cloudCover01 === 0.2);

    // A GM's own hand still edits the BASE value, not a phantom composed one.
    mgr.setTargets({ cloudCover01: 0.05 });
    t.ok(
      "a GM's slider drag during an active event moves the base target, not fought by the overlay",
      mgr.read().targets.cloudCover01 === 0.05
    );
  }

  // ---- toSnapshotWeather re-clamps a composed value back into range -----------
  {
    const mgr = createWeatherManager();
    mgr.jumpTo({ cloudCover01: 0.9 });
    mgr.addEvent({
      kind: 'mana-storm',
      envelope: { attackSec: 0, sustainSec: 'held', releaseSec: 1 },
      overrides: [{ axis: 'cloudCover01', op: 'add', value: 5 }], // would blow past max=1 uncapped
    });
    for (let i = 0; i < 5; i++) mgr.tick(1 / 60);
    t.ok('a composed value that overshoots the axis range is re-clamped', mgr.toSnapshotWeather().cloudCover01 === 1);
  }

  // ---- version discipline: add/release/remove bump it; ramping alone does not -
  {
    const mgr = createWeatherManager();
    const { id } = mgr.addEvent({ kind: 'ash-storm', envelope: { attackSec: 5, sustainSec: 'held', releaseSec: 5 } });
    const vAfterAdd = mgr.read().version;
    for (let i = 0; i < 60; i++) mgr.tick(1 / 60); // 1s of pure envelope ramping, no config change
    t.ok('envelope ramping alone does not bump version', mgr.read().version === vAfterAdd);
    mgr.releaseEvent(id);
    t.ok('releaseEvent bumps version', mgr.read().version > vAfterAdd);
  }

  // ---- events are mode-agnostic (LAW 1) ----------------------------------------
  {
    const director = createWeatherManager({ mode: 'director' });
    const almanac = createWeatherManager({ mode: 'almanac', biome: 'temperate-coast' });
    const spec = { kind: 'ash-storm', envelope: { attackSec: 0, sustainSec: 'held', releaseSec: 45 } };
    director.addEvent(spec);
    almanac.addEvent(spec);
    director.tick(1 / 60);
    almanac.tick(1 / 60, { dtGameHours: 0, hour: 12 }); // no walk motion, isolate the event's own effect
    t.ok(
      'the same event composes identically regardless of mode',
      director.toSnapshotWeather().cloudCover01 === almanac.toSnapshotWeather().cloudCover01 &&
        director.toSnapshotWeather().cloudType01 === almanac.toSnapshotWeather().cloudType01
    );
  }

  // ---- an event's envelope runs on REAL time, unscaled by transitionSpeed -----
  {
    const brisk = createWeatherManager({ transitionSpeed: 'brisk' });
    const realistic = createWeatherManager({ transitionSpeed: 'realistic' });
    const spec = { kind: 'ash-storm', envelope: { attackSec: 10, sustainSec: 'held', releaseSec: 45 } };
    brisk.addEvent(spec);
    realistic.addEvent(spec);
    for (let i = 0; i < 300; i++) {
      // 5s of real time
      brisk.tick(1 / 60);
      realistic.tick(1 / 60);
    }
    t.ok(
      "an event's envelope progress is identical under brisk vs realistic transitionSpeed",
      brisk.getActiveEvents()[0].progress01 === realistic.getActiveEvents()[0].progress01
    );
  }

  // ---- multiple simultaneous events of the same kind coexist independently ----
  {
    const mgr = createWeatherManager();
    const a = mgr.addEvent({ kind: 'sky-flash' });
    const b = mgr.addEvent({ kind: 'sky-flash' });
    t.ok('two events of the same kind get distinct auto ids', a.id !== b.id);
    t.ok('both are independently tracked', mgr.getActiveEvents().length === 2);
  }

  // ---- getStatus().events mirrors getActiveEvents ------------------------------
  {
    const mgr = createWeatherManager();
    mgr.addEvent({ kind: 'aurora' });
    const status = mgr.getStatus();
    t.ok(
      'getStatus reports the active event list',
      status.events.active.length === 1 && status.events.active[0].kind === 'aurora'
    );
    t.ok('getStatus and getActiveEvents agree', status.events.active[0].id === mgr.getActiveEvents()[0].id);
  }
}
