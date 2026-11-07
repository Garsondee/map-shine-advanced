/**
 * Node verification for diag/state-digest.js (mmp-f0k.2).
 */
import { roundTo, canonicalJson, fnv1a, buildStateDigest, compareDigests } from '../state-digest.js';

const raw = () => ({
  msaVersion: '1.0.0',
  viewerStarted: true,
  sceneId: 'S1',
  levelId: 'L0',
  worldTime: 3600.4,
  paused: false,
  env: {
    time: { todHour: 12.02 },
    sun: { azimuthDeg: 180.2, elevationDeg: 60.1 },
    wind: { directionDeg: 90, speed01: 0.3, gustiness01: 0.2 },
  },
  darkness: 0.1234,
  weather: {
    mode: 'director',
    preset: 'clear',
    targets: { cloudCover01: 0.1, cloudAltitudePx: 1400.2 },
    state: { cloudCover01: 0.1001 },
  },
  cloudDrift: { x: 101, y: -3 },
  lights: [
    {
      id: 'b',
      x: 10,
      y: 20,
      config: { dim: 10, bright: 5, color: '#ff0000', alpha: 0.5, luminosity: 0.5, attenuation: 0.5 },
    },
    { id: 'a', x: 30, y: 40, config: { dim: 10, bright: 5, animation: { type: 'torch' } } },
  ],
  effectsEnabled: { bloom: true, lens: false },
  user: 'Gamemaster',
  isGM: true,
  profile: 'standard',
  renderScale: 1,
});

export function run(t) {
  const { ok } = t;

  ok('roundTo: grain 0.01', roundTo(0.12345, 0.01) === 0.12);
  ok('roundTo: grain 8', roundTo(101, 8) === 104);
  ok('roundTo: non-number is null', roundTo('x', 1) === null && roundTo(undefined, 1) === null);
  ok('roundTo: no float tail', roundTo(0.1 + 0.2, 0.01) === 0.3);

  ok(
    'canonicalJson: key order does not matter',
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }) === canonicalJson({ a: { c: 3, d: 2 }, b: 1 })
  );
  ok('canonicalJson: undefined keys dropped', canonicalJson({ a: 1, b: undefined }) === '{"a":1}');
  ok('fnv1a: stable known value', fnv1a('') === '811c9dc5');
  ok('fnv1a: differs on change', fnv1a('abc') !== fnv1a('abd'));

  const d = buildStateDigest(raw());
  ok('digest: lights sorted by id', d.shared.lights[0].id === 'a' && d.shared.lights[1].id === 'b');
  ok('digest: animation type kept', d.shared.lights[0].animation === 'torch');
  ok('digest: darkness rounded', d.shared.darkness === 0.12);
  ok('digest: px weather axes rounded to the weather grain', d.shared.weather.targets.cloudAltitudePx === 1400);
  const easing = raw();
  easing.weather.state.cloudScalePx = 4473;
  const easing2 = raw();
  easing2.weather.state.cloudScalePx = 4472;
  ok(
    'digest: 1 px of mid-ease difference does not change the hash',
    buildStateDigest(easing).hash === buildStateDigest(easing2).hash
  );
  ok('digest: per-client fields kept out of shared', d.shared.user === undefined && d.perClient.user === 'Gamemaster');
  ok('digest: hash is 8 hex chars', /^[0-9a-f]{8}$/.test(d.hash));

  const other = raw();
  other.user = 'Player1';
  other.isGM = false;
  other.profile = 'low';
  other.renderScale = 0.5;
  ok('digest: per-client differences do not change the hash', buildStateDigest(other).hash === d.hash);

  const noisy = raw();
  noisy.darkness = 0.1236;
  noisy.cloudDrift = { x: 102, y: -2 };
  ok('digest: float noise inside the grain does not change the hash', buildStateDigest(noisy).hash === d.hash);

  const wrong = raw();
  wrong.weather.targets.cloudCover01 = 0.6;
  ok('digest: a real weather difference changes the hash', buildStateDigest(wrong).hash !== d.hash);

  const cmp = compareDigests({ gm: d, p1: buildStateDigest(wrong) });
  ok('compare: mismatch found', cmp.match === false);
  ok(
    'compare: names the path',
    cmp.differences.some((x) => x.path === 'weather.targets.cloudCover01')
  );
  ok('compare: reports both values', cmp.differences[0].values.gm === 0.1 && cmp.differences[0].values.p1 === 0.6);
  ok('compare: identical clients match', compareDigests({ gm: d, p1: buildStateDigest(other) }).match === true);

  const live = raw();
  live.darkness = { darkness01: 0.5, source: 'scene' };
  ok('digest: live darkness object reads darkness01', buildStateDigest(live).shared.darkness === 0.5);
  const envOnly = raw();
  delete envOnly.darkness;
  envOnly.env.darkness01 = 0.25;
  ok('digest: falls back to env.darkness01', buildStateDigest(envOnly).shared.darkness === 0.25);

  const empty = buildStateDigest({});
  ok('digest: empty input does not throw and says viewer not started', empty.shared.viewerStarted === false);
}
