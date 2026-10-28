/**
 * THE TORRENT (torrent-field.js / torrent-render.js, 2026-10-27) — the CPU
 * half: the response curve that keeps it at the top of the rain fader, the
 * wind gain, the vanishing point the slanting sheets radiate from, and the
 * integrated state whose wraps must be seamless.
 *
 * ⚠️ SAME HONEST LIMIT `storm-fog-field.test.mjs` STATES: the field itself is
 * browser-only TSL. The picture was checked in `tools/shader-lab`'s precip
 * bench (the `torrent` isolator, runs/torrent-waves-*), not here.
 */
import {
  TORRENT_LAYERS,
  TORRENT_SEGMENT_WRAP,
  TORRENT_WAVE_WRAP_PX,
  TORRENT_CALM_GAIN_FLOOR,
  TORRENT_CALM_SPEED_FLOOR,
  TORRENT_VANISH_PX_AT_GALE,
  TORRENT_VANISH_REF_PX,
  torrentWindGain,
  torrentWaveSpeedPxS,
  TORRENT_WAVE_MIN_PX_S,
  torrentVanishingPoint,
  stepTorrentState,
} from '../torrent-field.js';
import { PRECIP_SPECIES, resolveSpeciesFrame } from '../precip-species.js';
import { PRECIPITATION_PARAMS } from '../precipitation.js';
import { windTravelPxPerSec, speed01ForBeaufort } from '../../../world/index.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function run(t) {
  // ── the top of the rain fader, and only there ──
  const rain = PRECIP_SPECIES.rain;
  const at = (p) => resolveSpeciesFrame(rain, { precip01: p }).torrent01;
  t.ok('torrent is silent through ordinary heavy rain (precip01 0.75)', at(0.75) === 0 && at(0.5) === 0);
  t.ok('torrent rises in the fader`s last quarter', at(0.875) > 0.4 && at(0.875) < 0.6);
  t.ok('torrent is full at the top of the fader', at(1) === 1);
  t.ok(
    '⭐ torrent starts LATER than storm-fog — torrential is past merely foggy',
    rain.respond.torrent.at > rain.respond.fog.at
  );
  t.ok(
    'snow has no torrent (it has its white-out)',
    resolveSpeciesFrame(PRECIP_SPECIES.snow, { precip01: 1 }).torrent01 === 0
  );

  // ── the wind drives it harder, but never switches it off ──
  t.ok(
    '⭐ a dead calm still draws most of the torrent (the author: convincing at every wind)',
    torrentWindGain(0) === TORRENT_CALM_GAIN_FLOOR && TORRENT_CALM_GAIN_FLOOR >= 0.6
  );
  t.ok('a full gale draws it at full strength', torrentWindGain(1) === 1);
  t.ok('wind gain is monotonic', torrentWindGain(0.3) < torrentWindGain(0.7));
  t.ok('a bad wind reading fails to the calm floor, not NaN', torrentWindGain(NaN) === TORRENT_CALM_GAIN_FLOOR);

  // ── the waves ride the wind at its REAL speed — the gust fronts' own pace ──
  t.ok('⭐ a gale`s waves cross the map at the real wind speed', torrentWaveSpeedPxS(0.5) === windTravelPxPerSec(0.5));
  t.ok('…on the scene`s own scale', torrentWaveSpeedPxS(0.5, 131.2) === 2 * torrentWaveSpeedPxS(0.5));
  t.ok('a calm`s waves still drift, at the floor', torrentWaveSpeedPxS(0) === TORRENT_WAVE_MIN_PX_S);

  // ── the slanting sheets: where the streaks radiate from ──
  const calm = torrentVanishingPoint(0, 90);
  t.ok(
    '⭐ in a calm the streaks radiate from the centre — rain falling straight at the eye',
    calm.x === 0 && calm.y === 0 && calm.refPx === TORRENT_VANISH_REF_PX
  );
  // Wind blowing TOWARD east (90°): the point slides WEST, upwind.
  // Beaufort 6 (12.3 m/s) is half strength — what the old dial's 0.5 was.
  const east = torrentVanishingPoint(speed01ForBeaufort(6), 90);
  t.ok('⭐ the vanishing point sits UPWIND', east.x < 0 && near(east.y, 0, 1e-6));
  t.ok('…by focal × tan(slant), half way at Beaufort 6', near(east.distPx, TORRENT_VANISH_PX_AT_GALE / 2, 1e-6));
  const south = torrentVanishingPoint(1, 180);
  t.ok('wind toward south (y down) puts the point north (y < 0)', south.y < 0 && near(south.x, 0, 1e-6));
  t.ok(
    'a gale pushes it far enough off screen that the streaks are near parallel',
    south.distPx >= 4000 && south.refPx === south.distPx
  );

  // ── the layers really are far → near ──
  const ok = TORRENT_LAYERS.every(
    (L, i) =>
      i === 0 ||
      (L.colPx > TORRENT_LAYERS[i - 1].colPx &&
        L.speedPxS > TORRENT_LAYERS[i - 1].speedPxS &&
        L.halfWidthPx > TORRENT_LAYERS[i - 1].halfWidthPx)
  );
  t.ok('each nearer layer is coarser, faster and wider than the one behind it', ok);

  // ── the CPU-integrated state ──
  const s1 = stepTorrentState(null, 0.1, 1, 90);
  t.ok(
    'scroll advances layer 0 by speed×dt / period segments',
    near(s1.scroll[0], (0.1 * TORRENT_LAYERS[0].speedPxS) / TORRENT_LAYERS[0].periodPx)
  );
  t.ok(
    '⭐ the waves move DOWNWIND (toward east at 90°)',
    near(s1.waveX, 0.1 * windTravelPxPerSec(1), 1e-6) && near(s1.waveY, 0, 1e-6)
  );
  const c1 = stepTorrentState(null, 0.1, 0, 90);
  t.ok(
    'a calm still scrolls the streaks, at the calm floor',
    near(c1.scroll[0] / s1.scroll[0], TORRENT_CALM_SPEED_FLOOR)
  );
  // A turn of the wind steers the waves already on the map; it does not
  // swing the whole pattern round (the offset is a 2-D vector, kept).
  const turned = stepTorrentState(s1, 0.1, 1, 180);
  t.ok(
    'when the wind turns, the waves keep their place and move the new way',
    near(turned.waveX, s1.waveX, 1e-6) && turned.waveY > 0
  );
  let s = null;
  for (let i = 0; i < 100000; i++) s = stepTorrentState(s, 0.05, 0.9, 120);
  t.ok(
    '⭐ after ~80 minutes everything is still wrapped small (float32 stays precise)',
    s.scroll.every((v) => v >= 0 && v < TORRENT_SEGMENT_WRAP) &&
      Math.abs(s.waveX) < TORRENT_WAVE_WRAP_PX &&
      Math.abs(s.waveY) < TORRENT_WAVE_WRAP_PX
  );
  const frozen = { scroll: [1, 2, 3], waveX: 4, waveY: 5, evolveSec: 6 };
  t.ok(
    'a negative or NaN dt does not move anything',
    JSON.stringify(stepTorrentState(frozen, -1, 1, 0)) === JSON.stringify(frozen) &&
      JSON.stringify(stepTorrentState(frozen, NaN, 1, 0)) === JSON.stringify(frozen)
  );
  t.ok(
    'a huge dt (resume after a stall) is clamped to one quarter-second',
    near(stepTorrentState(null, 30, 0, 0).evolveSec, 0.25)
  );

  // ── the author dial ──
  const p = PRECIPITATION_PARAMS.torrentStrength;
  t.ok(
    'torrentStrength exists, 0..2, default 0.65 (the author`s chosen default)',
    p && p.min === 0 && p.max === 2 && p.default === 0.65
  );
}
