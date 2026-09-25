/**
 * vertical-fader.js's pure half (mythica-machina-press#626): where the cap
 * sits for a value, which value a pointer position means, how far the level
 * fill reaches, and what the readout says. The DOM-wiring half (pointer
 * drags, the hidden input, fine-drag surfaces) is browser-verified live in
 * tools/remote-preview, same convention as every other pointer-driven widget
 * in this directory (CONVENTIONS.md §4).
 */
import {
  FADER_GEOMETRY,
  faderNormalize,
  faderCapY,
  faderTFromY,
  faderFillSpan,
  formatFaderValue,
} from '../vertical-fader.js';

export function run(t) {
  const { ok } = t;
  const { heightPx, capPx } = FADER_GEOMETRY;
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  // ── value → position ────────────────────────────────────────────────────
  ok('the floor of the range is position 0', faderNormalize(0, 0, 1) === 0);
  ok('the top of the range is position 1', faderNormalize(1, 0, 1) === 1);
  ok('a signed range normalises around its own centre (latitude 0° = 0.5)', faderNormalize(0, -90, 90) === 0.5);
  ok('30° of latitude sits two-thirds up', near(faderNormalize(30, -90, 90), 2 / 3));
  ok(
    'out-of-range values clamp rather than escaping the well',
    faderNormalize(2, 0, 1) === 1 && faderNormalize(-1, 0, 1) === 0
  );
  ok(
    'a non-finite value or an empty range reads as the floor, never NaN',
    faderNormalize(NaN, 0, 1) === 0 && faderNormalize(0.5, 1, 1) === 0
  );

  // ── position → cap ──────────────────────────────────────────────────────
  ok('at full, the cap sits flush with the top of the well (no overhang)', faderCapY(1) === capPx / 2);
  ok('at zero, the cap sits flush with the bottom of the well', faderCapY(0) === heightPx - capPx / 2);
  ok('halfway is the middle of the well', faderCapY(0.5) === heightPx / 2);
  ok('higher values sit higher (smaller y)', faderCapY(0.8) < faderCapY(0.2));

  // ── pointer → value: the inverse, so the cap stays under the pointer ────
  let roundTrips = true;
  for (let i = 0; i <= 20; i++) {
    const tv = i / 20;
    if (!near(faderTFromY(faderCapY(tv)), tv)) roundTrips = false;
  }
  ok('pointer mapping is the exact inverse of cap placement across the whole travel', roundTrips);
  ok('a pointer above the well clamps to full', faderTFromY(-50) === 1);
  ok('a pointer below the well clamps to zero', faderTFromY(heightPx + 50) === 0);

  // ── the level fill ──────────────────────────────────────────────────────
  {
    const span = faderFillSpan(0.75);
    ok(
      'an ordinary fader fills from the cap down to the floor',
      span.top === faderCapY(0.75) && near(span.top + span.height, heightPx)
    );
  }
  {
    const up = faderFillSpan(2 / 3, { bipolar: true });
    const mid = faderCapY(0.5);
    ok(
      'a bipolar fader above centre fills from the centre UP to the cap',
      near(up.top, faderCapY(2 / 3)) && near(up.top + up.height, mid)
    );
    const down = faderFillSpan(0.25, { bipolar: true });
    ok(
      'a bipolar fader below centre fills from the centre DOWN to the cap',
      near(down.top, mid) && near(down.top + down.height, faderCapY(0.25))
    );
    ok(
      'a bipolar fader dead on centre (the equator) has no fill at all',
      faderFillSpan(0.5, { bipolar: true }).height === 0
    );
  }

  // ── the readout ─────────────────────────────────────────────────────────
  ok('a 0..1 channel reads as a whole percent', formatFaderValue(0.37, { unit: 'percent' }) === '37%');
  ok('full reads as 100%, not "1"', formatFaderValue(1, { unit: 'percent' }) === '100%');
  ok('the floor reads 0%, never "-0%"', formatFaderValue(-0.001, { unit: 'percent' }) === '0%');
  ok('latitude reads in degrees', formatFaderValue(30, { unit: 'degrees' }) === '30°');
  ok('southern latitudes keep their sign', formatFaderValue(-45, { unit: 'degrees' }) === '-45°');
  ok(
    'no unit keeps the original plain-number readout',
    formatFaderValue(0.5) === '0.5' && formatFaderValue(250) === '250'
  );
}
