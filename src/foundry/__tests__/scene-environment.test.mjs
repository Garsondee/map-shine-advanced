/**
 * Node verification for foundry/scene-environment.js.
 *
 * Only `deriveDarkness` is testable here — same split as
 * canvas-compositing.test.mjs's own header explains: the pure decision logic
 * is Node-tested, the live `canvas.scene` read is browser-only (verified via
 * a debug report, not here).
 */
import {
  deriveDarkness,
  deriveAmbient,
  FOUNDRY_FALLBACK_AMBIENT,
  shouldPublishDarkness,
  DARKNESS_PUBLISH_STEP,
  DARKNESS_PUBLISH_MIN_INTERVAL_MS,
  deriveGlobalLightWindow,
  shouldPublishGlobalLightWindow,
  GLOBAL_LIGHT_DAYLIGHT_MAX,
} from '../scene-environment.js';

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
  // ══════════════════════════════════════════════════════════════════════
  // THE DARKNESS WRITE-BACK's own pure guard (2026-08-15)
  // ══════════════════════════════════════════════════════════════════════
  // `publishSceneDarkness` is the one write, and MSA owns darkness outright —
  // it never reads Foundry's own copy back into what it computes (see that
  // function's own header for the corrected design and the read-back-loop
  // shape it replaces). With no read-back, there is no ratchet to guard
  // against; the throttle below is the only guard this write still needs.

  // ---- WHY THERE IS NO "ECHO GUARD" TEST HERE ANYMORE ---------------------
  // An earlier cut of this fix DID read Foundry's darkness back into the same
  // fold that produced the write (`max(nightDarkness, darknessInput)`), which
  // ratchets: feed your own last output back in as an input and a max() can
  // only ever climb. That cut added a guard-flag ("ignore my own echo") to
  // patch it — the exact "feedback loop held together by a guard flag" shape
  // `world/day-clock.js`'s own header names as the pattern this project
  // deliberately moved away from. Removing the read-back entirely (rather than
  // guarding it) removes the loop by construction, so there is nothing here
  // left to pin a ratchet-reproduction test against.

  // ---- THE THROTTLE: fires when it must, stays quiet when it must ---------
  {
    const base = { lastPublished01: 0.5, lastPublishedAtMs: 1000 };
    ok(
      'a first publish ignores the interval entirely',
      shouldPublishDarkness({ darkness01: 0.5, lastPublished01: null, nowMs: 0, lastPublishedAtMs: 0 }) === true
    );
    ok(
      'a frozen clock does not republish forever on float noise',
      shouldPublishDarkness({ ...base, darkness01: 0.5 + DARKNESS_PUBLISH_STEP / 4, nowMs: 99999 }) === false
    );
    ok(
      'a real move, after the interval, publishes',
      shouldPublishDarkness({
        ...base,
        darkness01: 0.5 + DARKNESS_PUBLISH_STEP * 2,
        nowMs: 1000 + DARKNESS_PUBLISH_MIN_INTERVAL_MS,
      }) === true
    );
    ok(
      'a real move DURING the interval waits — a fast sweep cannot fire refreshVision every frame',
      shouldPublishDarkness({ ...base, darkness01: 1, nowMs: 1000 + DARKNESS_PUBLISH_MIN_INTERVAL_MS - 1 }) === false
    );
    ok(
      'a non-finite darkness never publishes',
      shouldPublishDarkness({ ...base, darkness01: NaN, nowMs: 99999 }) === false
    );
  }

  // ---- THE LATCHED THROTTLE: the author's own live failure, pinned ---------
  // 2026-08-15, live: "I set the scene to midnight on the astrolabe and then I
  // check scene darkness which is still at 0 and should be at 1." Cause was not
  // in this function — it was the CALLER passing `time.tMs` (SIM time, frozen
  // while Foundry is paused) as `nowMs`. One publish happened at startup, the
  // clock stopped, and `nowMs - lastPublishedAtMs` never again reached the
  // interval. `core/frame-clock.js`'s own header warns about exactly this
  // ("a consumer that reached for the obvious `tMs` would silently opt OUT of
  // pause"); poll throttles must use `realMs`.
  //
  // This models a STOPPED clock — every later call sees the same `nowMs` the
  // publish was stamped with — and asserts the shape of the failure, so that a
  // future caller re-introducing a frozen clock fails here rather than live.
  {
    const frozenNow = 5000;
    const latched = shouldPublishDarkness({
      darkness01: 1, // midnight
      lastPublished01: 0, // published once at noon, at startup
      nowMs: frozenNow,
      lastPublishedAtMs: frozenNow, // a clock that never advanced
    });
    ok('a frozen clock latches the throttle shut — the reported live failure', latched === false);
    ok(
      'the SAME call with a wall clock that really advanced does publish',
      shouldPublishDarkness({
        darkness01: 1,
        lastPublished01: 0,
        nowMs: frozenNow + DARKNESS_PUBLISH_MIN_INTERVAL_MS,
        lastPublishedAtMs: frozenNow,
      }) === true
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // THE GLOBAL ILLUMINATION WRITE-BACK's own pure logic (2026-08-15)
  // ══════════════════════════════════════════════════════════════════════
  // See `deriveGlobalLightWindow`'s own header: `publishSceneDarkness` fixes
  // the darkness LEVEL Foundry's vision reads, but `environment.globalLight.
  // enabled` is a SEPARATE gate (schema-default false) that a level fix alone
  // can never flip. This closes that second gate.

  // ---- ⚠️ THE REGRESSION THAT SHIPPED AND WAS RE-REPORTED THE SAME DAY -----
  // The first cut returned {enabled:false} whenever the scene had no
  // darkness-adjusting Region — i.e. on nearly every real scene — which
  // reproduced the author's original bug verbatim ("token outside at noon
  // can only see a point light"). These pin BOTH no-region cases as ENABLED.
  {
    const noRegions = deriveGlobalLightWindow(null);
    ok('THE REGRESSION: a scene with NO darkness regions still enables daylight', noRegions.enabled === true);
    ok('and gets the default daylight ceiling, not a fabricated null', noRegions.max === GLOBAL_LIGHT_DAYLIGHT_MAX);
    ok('a non-finite floor behaves identically to absent', deriveGlobalLightWindow(NaN).enabled === true);
  }

  // ---- noon outdoors must ALWAYS be admitted — the reported scenario -------
  // darkness01 at noon is 0, and Foundry admits a point when
  // `darkness >= min && darkness <= max`. Whatever the regions say, 0 must
  // never fall outside the window, or the author's exact test fails again.
  for (const floor of [null, 1, 0.5, 0.25, 0.1, 0.01, 0]) {
    const w = deriveGlobalLightWindow(floor);
    ok(
      `noon (darkness 0) is inside the window for region floor ${JSON.stringify(floor)}`,
      w.enabled === true && 0 >= 0 && 0 <= w.max
    );
  }

  // ---- a protective interior is still kept strictly OUTSIDE the window -----
  {
    const w = deriveGlobalLightWindow(0.5); // the bench Mansion's authored floor
    ok('the bench interior floor (0.5) stays above the window — still protected', w.max < 0.5);
    const shallow = deriveGlobalLightWindow(0.1);
    ok('an unusually shallow interior floor (0.1) still clamps the window under it', shallow.max < 0.1);
  }

  // ---- a BRIGHT region can no longer collapse the feature -----------------
  // (computeMinimumDarknessFloor now filters floor<=0 out entirely, so this
  // function should never see 0 — but if it does, it must degrade to a
  // usable window, never to "disabled".)
  {
    const w = deriveGlobalLightWindow(0);
    ok('a zero floor degrades to a usable window, never to disabled', w.enabled === true && w.max === 0);
    ok('a zero-floor window still admits exactly-noon darkness', 0 <= w.max);
  }

  ok('the window never exceeds 1', deriveGlobalLightWindow(1).max <= 1);
  ok('the window is never negative', deriveGlobalLightWindow(DARKNESS_PUBLISH_STEP / 2).max >= 0);

  // ---- THE CHANGE-ONLY THROTTLE: static almost all the time, by design ----
  {
    ok(
      'never published before => always publish',
      shouldPublishGlobalLightWindow({ enabled: true, max: 0.4 }, null) === true
    );
    ok(
      'identical to the last publish => stays quiet (this is correct, not the darkness-throttle bug)',
      shouldPublishGlobalLightWindow({ enabled: true, max: 0.4 }, { enabled: true, max: 0.4 }) === false
    );
    ok(
      'a meaningfully different max (a region edited live) republishes',
      shouldPublishGlobalLightWindow(
        { enabled: true, max: 0.4 },
        { enabled: true, max: 0.4 + DARKNESS_PUBLISH_STEP * 2 }
      ) === true
    );
    ok(
      'sub-margin float noise in max does not republish forever',
      shouldPublishGlobalLightWindow(
        { enabled: true, max: 0.4 },
        { enabled: true, max: 0.4 + DARKNESS_PUBLISH_STEP / 4 }
      ) === false
    );
  }

  // ---- DRIFT REPAIR: something else re-initialised the environment --------
  // Foundry rebuilds `globalLight` from the SCENE DOCUMENT on any
  // `canvas.environment.initialize()` — a Scene Config save, animateDarkness,
  // another module — which silently wipes our window back to enabled:false.
  // A throttle comparing only our own values against our own values would
  // never notice, and the feature would die at the first unrelated refresh.
  {
    const next = { enabled: true, max: 0.25 };
    const last = { enabled: true, max: 0.25 };
    const agreeing = { liveDisabled: false, liveMax: 0.25 };
    ok(
      'live state agreeing with what we published => stay quiet',
      shouldPublishGlobalLightWindow(next, last, agreeing, 10000, 0) === false
    );
    const wiped = { liveDisabled: true, liveMax: 1 };
    ok(
      'THE DRIFT CASE: Foundry wiped our window back to disabled => re-assert',
      shouldPublishGlobalLightWindow(next, last, wiped, 10000, 0) === true
    );
    ok(
      'a drifted MAX alone (window widened back to the document default) => re-assert',
      shouldPublishGlobalLightWindow(next, last, { liveDisabled: false, liveMax: 1 }, 10000, 0) === true
    );
    ok(
      'drift repair is RATE-LIMITED — no per-frame perception storm if something fights us',
      shouldPublishGlobalLightWindow(next, last, wiped, 100, 0) === false
    );
    ok(
      'omitting live state entirely keeps the old change-only behaviour',
      shouldPublishGlobalLightWindow(next, last) === false
    );
    ok(
      'an unreadable live source (all nulls) never triggers a pointless republish',
      shouldPublishGlobalLightWindow(next, last, { liveDisabled: null, liveMax: null }, 10000, 0) === false
    );
  }
}
