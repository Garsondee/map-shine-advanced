/**
 * Node verification for foundry/player-aim.js — the pure half of "the
 * flashlight follows its bearer's cursor". No Foundry, no clock, no THREE: every
 * rule that decides what a client sends and what it shows is a plain function
 * or a state machine handed its own `nowMs`.
 *
 * The one cross-zone import is deliberate and test-only: the angle convention
 * has to agree with `effects/lighting/player-light-geometry.js`, and the only
 * way to KEEP it agreeing is for a test to hold both ends at once.
 */
import {
  PLAYER_AIM_MODES,
  AIM_MESSAGE_TYPE,
  AIM_MIN_DISTANCE_PX,
  normalizeAngleDeg,
  shortestAngleDeltaDeg,
  quantizeAimAngleDeg,
  aimAngleDegFromPoints,
  smoothAngleDeg,
  encodeAimMessage,
  decodeAimMessage,
  createLocalAimTracker,
  createAimSendPolicy,
  createRemoteAimStore,
} from '../player-aim.js';
import {
  tokenRotationToForwardVector,
  buildOnePlayerLightSource,
  PLAYER_LIGHT_RENDERED_MODES,
} from '../../effects/lighting/player-light-geometry.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // angle maths
  // ======================================================================
  ok('normalize: 0 stays 0', normalizeAngleDeg(0) === 0);
  ok('normalize: 360 wraps to 0', normalizeAngleDeg(360) === 0);
  ok('normalize: a negative angle wraps up', near(normalizeAngleDeg(-90), 270));
  ok('normalize: a large angle wraps down', near(normalizeAngleDeg(725), 5));
  ok('normalize: a tiny negative never yields 360', normalizeAngleDeg(-1e-17) < 360);

  ok('delta: a plain turn', near(shortestAngleDeltaDeg(10, 50), 40));
  ok('delta: 350 → 10 is +20, the short way', near(shortestAngleDeltaDeg(350, 10), 20));
  ok('delta: 10 → 350 is −20, the short way', near(shortestAngleDeltaDeg(10, 350), -20));
  ok('delta: exactly half a turn is +180', near(shortestAngleDeltaDeg(0, 180), 180));
  ok('delta: no turn is 0', shortestAngleDeltaDeg(77, 77) === 0);

  ok(
    'quantize: rounds to tenths',
    near(quantizeAimAngleDeg(123.456), 123.5) && near(quantizeAimAngleDeg(123.44), 123.4)
  );
  ok('quantize: 359.96 rounds up through 360 to 0', quantizeAimAngleDeg(359.96) === 0);
  ok('quantize: 359.94 stays below 360', near(quantizeAimAngleDeg(359.94), 359.9));
  ok('quantize: a tiny negative is 0, not −0 or 360', quantizeAimAngleDeg(-0.04) === 0);
  ok('quantize: NaN stays NaN (callers guard), never a number', Number.isNaN(quantizeAimAngleDeg(NaN)));

  // ======================================================================
  // aimAngleDegFromPoints — the compass bearing, TokenDocument.rotation's convention
  // ======================================================================
  {
    const o = { x: 100, y: 100 };
    ok('north (cursor straight up the canvas) is 0°', aimAngleDegFromPoints(o, { x: 100, y: 0 }) === 0);
    ok('east is 90°', near(aimAngleDegFromPoints(o, { x: 200, y: 100 }), 90));
    ok('south is 180°', near(aimAngleDegFromPoints(o, { x: 100, y: 200 }), 180));
    ok('west is 270°', near(aimAngleDegFromPoints(o, { x: 0, y: 100 }), 270));
    ok('north-east is 45°', near(aimAngleDegFromPoints(o, { x: 200, y: 0 }), 45));
    ok('south-west is 225°', near(aimAngleDegFromPoints(o, { x: 0, y: 200 }), 225));
    ok(
      'the result is always in [0, 360)',
      [0, 17, 91, 133, 200, 271, 359].every((d) => {
        const rad = (d * Math.PI) / 180;
        const a = aimAngleDegFromPoints(o, { x: 100 + Math.sin(rad) * 50, y: 100 - Math.cos(rad) * 50 });
        return a >= 0 && a < 360;
      })
    );

    ok('a cursor on the token itself has no direction', aimAngleDegFromPoints(o, { x: 100, y: 100 }) === null);
    ok(
      'a cursor inside the dead zone has no direction',
      aimAngleDegFromPoints(o, { x: 100 + AIM_MIN_DISTANCE_PX - 1, y: 100 }) === null
    );
    ok(
      'a cursor just outside the dead zone does',
      aimAngleDegFromPoints(o, { x: 100 + AIM_MIN_DISTANCE_PX + 1, y: 100 }) !== null
    );
    ok('a custom dead zone is honoured', aimAngleDegFromPoints(o, { x: 130, y: 100 }, 50) === null);
    ok('a missing cursor has no direction', aimAngleDegFromPoints(o, null) === null);
    ok('a missing origin has no direction', aimAngleDegFromPoints(undefined, { x: 5, y: 5 }) === null);
    ok('a non-finite coordinate has no direction', aimAngleDegFromPoints(o, { x: NaN, y: 5 }) === null);
    ok('a null coordinate is not read as 0', aimAngleDegFromPoints({ x: 100, y: 100 }, { x: null, y: 0 }) === null);
  }

  // The convention lock: an aim angle fed through the beam builder's own
  // rotation→direction function must point at the cursor, in every quadrant.
  {
    const o = { x: 500, y: 500 };
    const targets = [
      { x: 500, y: 100 },
      { x: 900, y: 150 },
      { x: 920, y: 500 },
      { x: 800, y: 900 },
      { x: 500, y: 950 },
      { x: 120, y: 880 },
      { x: 80, y: 500 },
      { x: 210, y: 240 },
    ];
    const allPoint = targets.every((p) => {
      const angle = aimAngleDegFromPoints(o, p);
      const fwd = tokenRotationToForwardVector(angle, false);
      const len = Math.hypot(p.x - o.x, p.y - o.y);
      return near(fwd.x, (p.x - o.x) / len, 1e-9) && near(fwd.y, (p.y - o.y) / len, 1e-9);
    });
    ok('an aim angle, read as a token rotation, points the beam at the cursor in every quadrant', allPoint);
  }

  // ======================================================================
  // smoothing
  // ======================================================================
  ok('smooth: no time passed changes nothing', near(smoothAngleDeg(40, 200, 0, 70), 40));
  ok('smooth: no time passed still normalizes', near(smoothAngleDeg(400, 200, 0, 70), 40));
  ok('smooth: a zero time constant jumps to the target', near(smoothAngleDeg(40, 200, 16, 0), 200));
  ok(
    'smooth: one time constant closes ~63% of the gap, the short way round the wrap',
    near(smoothAngleDeg(350, 10, 70, 70), normalizeAngleDeg(350 + 20 * (1 - Math.exp(-1))), 1e-9)
  );
  ok(
    'smooth: frame-rate independent — one 100 ms step equals two 50 ms steps',
    near(smoothAngleDeg(0, 90, 100, 70), smoothAngleDeg(smoothAngleDeg(0, 90, 50, 70), 90, 50, 70), 1e-9)
  );
  {
    let a = 10;
    for (let i = 0; i < 200; i++) a = smoothAngleDeg(a, 300, 16, 70);
    ok('smooth: converges on the target', near(a, 300, 1e-3));
  }

  // ======================================================================
  // wire format
  // ======================================================================
  {
    const msg = encodeAimMessage({ tokenId: 'tok1', angleDeg: 123.456, userId: 'u1' });
    ok(
      'encode: carries the shared-socket type, token, sender and a quantized angle',
      msg?.type === AIM_MESSAGE_TYPE && msg.tokenId === 'tok1' && msg.userId === 'u1' && near(msg.a, 123.5)
    );
    ok('encode: is a plain JSON-safe object', JSON.stringify(msg) === JSON.stringify(JSON.parse(JSON.stringify(msg))));
    ok('encode: a missing token id sends nothing', encodeAimMessage({ angleDeg: 5, userId: 'u1' }) === null);
    ok('encode: an empty sender sends nothing', encodeAimMessage({ tokenId: 't', angleDeg: 5, userId: '' }) === null);
    ok(
      'encode: a non-finite angle sends nothing',
      encodeAimMessage({ tokenId: 't', angleDeg: NaN, userId: 'u' }) === null
    );
    ok(
      'encode: an absurdly long id sends nothing',
      encodeAimMessage({ tokenId: 'x'.repeat(65), angleDeg: 5, userId: 'u' }) === null
    );
    ok('encode: no argument at all is total', encodeAimMessage() === null);

    const decoded = decodeAimMessage(JSON.parse(JSON.stringify(msg)));
    ok(
      'decode: round-trips through JSON',
      decoded?.tokenId === 'tok1' && decoded.userId === 'u1' && near(decoded.angleDeg, 123.5)
    );
    ok(
      'decode: another feature’s message on the shared socket is ignored',
      decodeAimMessage({ type: 'impulse', id: 'gust' }) === null
    );
    ok(
      'decode: null / undefined / a string are total',
      decodeAimMessage(null) === null && decodeAimMessage(undefined) === null && decodeAimMessage('playerAim') === null
    );
    ok(
      'decode: a string angle is refused',
      decodeAimMessage({ type: AIM_MESSAGE_TYPE, tokenId: 't', userId: 'u', a: '90' }) === null
    );
    ok(
      'decode: a NaN angle is refused',
      decodeAimMessage({ type: AIM_MESSAGE_TYPE, tokenId: 't', userId: 'u', a: NaN }) === null
    );
    ok(
      'decode: an infinite angle is refused',
      decodeAimMessage({ type: AIM_MESSAGE_TYPE, tokenId: 't', userId: 'u', a: Infinity }) === null
    );
    ok(
      'decode: a missing token id is refused',
      decodeAimMessage({ type: AIM_MESSAGE_TYPE, userId: 'u', a: 10 }) === null
    );
    ok(
      'decode: a missing sender is refused',
      decodeAimMessage({ type: AIM_MESSAGE_TYPE, tokenId: 't', a: 10 }) === null
    );
    ok(
      'decode: an out-of-range angle from a modded client is normalized, not trusted',
      near(decodeAimMessage({ type: AIM_MESSAGE_TYPE, tokenId: 't', userId: 'u', a: 725 }).angleDeg, 5)
    );
  }

  // ======================================================================
  // the bearer's own aim
  // ======================================================================
  {
    const tracker = createLocalAimTracker();
    const tok = { x: 100, y: 100 };
    ok('tracker: no cursor yet means no aim', tracker.update('a', tok, null) === null);
    ok('tracker: a cursor gives its bearing', near(tracker.update('a', tok, { x: 200, y: 100 }), 90));
    ok('tracker: a cursor on the token holds the last aim', near(tracker.update('a', tok, { x: 101, y: 101 }), 90));
    ok('tracker: an unknown cursor holds the last aim', near(tracker.update('a', tok, null), 90));
    ok('tracker: a new real cursor replaces the held aim', near(tracker.update('a', tok, { x: 100, y: 0 }), 0));
    ok('tracker: a different token does not inherit the held aim', tracker.update('b', tok, null) === null);
    tracker.update('b', tok, { x: 0, y: 100 });
    tracker.reset();
    ok('tracker: reset forgets the held aim', tracker.update('b', tok, null) === null);
  }

  // ======================================================================
  // outbound policy
  // ======================================================================
  {
    const p = createAimSendPolicy(); // 100 ms interval, 0.75° delta, 250 ms settle, 2500 ms keepalive
    ok('policy: the first aim is sent at once, quantized', near(p.decide('a', 123.456, 0), 123.5));
    ok('policy: a big change inside the rate cap waits', p.decide('a', 200, 50) === null);
    ok('policy: a big change after the rate cap goes', near(p.decide('a', 200, 100), 200));
    ok('policy: a sub-visible change is not worth a message', p.decide('a', 200.3, 200) === null);
    ok('policy: …but it IS sent once settled, so a sweep ends exactly', near(p.decide('a', 200.3, 360), 200.3));
    ok('policy: an unchanged aim stays quiet', p.decide('a', 200.3, 1000) === null);
    ok('policy: …until the keepalive, which repeats it', near(p.decide('a', 200.3, 2900), 200.3));
    ok('policy: the keepalive restarts from the last send', p.decide('a', 200.3, 3000) === null);
  }
  {
    const p = createAimSendPolicy();
    p.decide('a', 359.8, 0);
    ok('policy: 359.8° → 0.2° is a 0.4° turn, not 359.6°', p.decide('a', 0.2, 100) === null);
  }
  {
    const p = createAimSendPolicy();
    p.decide('a', 10, 0);
    ok('policy: a different token sends immediately', near(p.decide('b', 10, 10), 10));
    ok('policy: …and the first token does again when it returns', near(p.decide('a', 10, 20), 10));
  }
  {
    const p = createAimSendPolicy();
    p.decide('a', 10, 0);
    p.reset();
    ok('policy: reset makes the next decision send', near(p.decide('a', 10, 5), 10));
  }
  {
    const p = createAimSendPolicy();
    p.decide('a', 10, 0);
    ok('policy: a non-finite angle sends nothing', p.decide('a', NaN, 500) === null);
    ok('policy: …and does not disturb what it remembers', p.decide('a', 10, 600) === null);
    ok('policy: a non-finite clock sends nothing', p.decide('a', 90, NaN) === null);
  }
  {
    // A realistic sweep: 2°/tick at 50 ms ticks for one second (the last tick
    // lands INSIDE the rate cap, so its angle is not sent by the sweep itself),
    // then the cursor stops. The remote has to end up on that final angle.
    const p = createAimSendPolicy();
    const sentAt = [];
    let lastSent = null;
    let angle = 0;
    for (let tick = 0; tick < 20; tick++) {
      angle = tick * 2;
      const sent = p.decide('a', angle, tick * 50);
      if (sent !== null) {
        sentAt.push(tick * 50);
        lastSent = sent;
      }
    }
    ok(
      'policy: a continuous sweep never exceeds the rate cap',
      sentAt.every((ms, i) => i === 0 || ms - sentAt[i - 1] >= 100)
    );
    ok(
      'policy: a continuous sweep is ~10 messages a second, not one per tick',
      sentAt.length >= 8 && sentAt.length <= 11
    );
    ok('policy: mid-sweep, the remote is behind the final angle', lastSent !== null && lastSent < angle);
    let afterStop = 0;
    for (let tick = 20; tick <= 26; tick++) {
      const sent = p.decide('a', angle, tick * 50);
      if (sent !== null) {
        lastSent = sent;
        afterStop += 1;
      }
    }
    ok(
      'policy: once the sweep stops, the remote ends on the exact final angle',
      near(lastSent, quantizeAimAngleDeg(angle))
    );
    ok('policy: …with one message, not a stream', afterStop === 1);
  }

  // ======================================================================
  // remote aim store
  // ======================================================================
  {
    const s = createRemoteAimStore({ staleMs: 8000, tauMs: 70, maxEntries: 64 });
    ok('store: an unheard token has no aim', s.sample('a', 0) === null);
    ok('store: receiving an unusable id is refused', s.receive('', 10, 0) === false);
    ok('store: receiving a NaN angle is refused', s.receive('a', NaN, 0) === false);
    ok('store: receiving a NaN clock is refused', s.receive('a', 10, NaN) === false);
    ok('store: nothing unusable was kept', s.size === 0);

    ok('store: a first message is accepted', s.receive('a', 90, 0) === true);
    ok('store: a new entry snaps straight to its target — nothing to swing from', near(s.sample('a', 0), 90));
    s.receive('a', 180, 100);
    ok('store: sampling the instant a new target lands has not moved yet', near(s.sample('a', 100), 90));
    ok(
      'store: one time constant later it is ~63% of the way',
      near(s.sample('a', 170), 90 + 90 * (1 - Math.exp(-1)), 1e-9)
    );
    ok('store: sampling twice at the same instant is idempotent', near(s.sample('a', 170), s.sample('a', 170)));
    let v = 0;
    for (let ms = 171; ms < 2000; ms += 16) v = s.sample('a', ms);
    ok('store: it converges on the target', near(v, 180, 1e-3));
  }
  {
    // How often the renderer samples must not change what it shows: one store
    // sampled every 10 ms and one sampled only at the end see the same messages.
    const busy = createRemoteAimStore();
    const idle = createRemoteAimStore();
    for (const s of [busy, idle]) s.receive('a', 90, 0);
    let busyNow = 0;
    for (let ms = 0; ms <= 500; ms += 10) {
      if (ms === 200) {
        busy.receive('a', 180, 200);
        idle.receive('a', 180, 200);
      }
      busyNow = busy.sample('a', ms);
    }
    ok('store: the displayed angle does not depend on sampling cadence', near(busyNow, idle.sample('a', 500), 1e-6));
  }
  {
    const s = createRemoteAimStore();
    s.receive('a', 350, 0);
    s.receive('a', 10, 1);
    const v = s.sample('a', 40);
    ok('store: 350° → 10° crosses north, it does not spin through 180°', normalizeAngleDeg(v - 350) < 20);
  }
  {
    const s = createRemoteAimStore({ staleMs: 8000 });
    s.receive('a', 90, 0);
    ok('store: still fresh just inside the stale window', s.sample('a', 8000) !== null);
    ok('store: gone just past it', s.sample('a', 8001) === null);
    ok('store: an expired entry is removed, not just hidden', s.size === 0);
    s.receive('a', 90, 9000);
    s.receive('a', 45, 30000); // arrives after a long silence
    ok(
      'store: a message after long silence snaps instead of sweeping from the dead angle',
      near(s.sample('a', 30000), 45)
    );
  }
  {
    const s = createRemoteAimStore({ staleMs: 1000 });
    s.receive('old', 10, 0);
    s.receive('new', 20, 900);
    s.prune(1500);
    ok('store: prune drops only the expired', s.size === 1 && s.sample('new', 1500) !== null);
    s.clear();
    ok('store: clear empties it', s.size === 0);
  }
  {
    const s = createRemoteAimStore({ maxEntries: 3 });
    s.receive('a', 1, 0);
    s.receive('b', 2, 10);
    s.receive('c', 3, 20);
    s.receive('d', 4, 30);
    ok('store: it is bounded', s.size === 3);
    ok('store: the oldest entry is the one evicted', s.sample('a', 30) === null && s.sample('d', 30) !== null);
    s.receive('b', 5, 40); // an update to an existing token never evicts anyone
    ok('store: updating a held token does not evict', s.size === 3 && s.sample('c', 40) !== null);
  }

  // ======================================================================
  // the mode list agrees with the beam presets it mirrors
  // ======================================================================
  {
    const beamModes = PLAYER_LIGHT_RENDERED_MODES.filter((mode) => {
      const src = buildOnePlayerLightSource(
        { tokenId: 'x', x: 0, y: 0, elevation: 0, mode },
        { modes: { [mode]: true } }
      );
      return src?.falloffModel === 'beam';
    });
    ok(
      'PLAYER_AIM_MODES is exactly the rendered modes whose light is a beam',
      beamModes.length === PLAYER_AIM_MODES.length && beamModes.every((m) => PLAYER_AIM_MODES.includes(m))
    );
    ok('flashlight is aimable', PLAYER_AIM_MODES.includes('flashlight'));
    ok('torch is not (yet)', !PLAYER_AIM_MODES.includes('torch'));
  }
}
