/**
 * settings-panel.test.mjs — the pure row-shaping half of the graphics &
 * performance panel (CONVENTIONS §4: DOM builders are browser-only; the
 * input→shape prediction they consume is pure and Node-tested here).
 *
 * `isEffectLocked`/`describeEffectRows` decide which effect rows the panel
 * must render as LOCKED (Control-Panel.md §5's "a11y-forced-off shown
 * LOCKED") — the same condition `effect-cascade.js#resolveEffectEnabled`'s
 * step 4 enforces at render time, mirrored here for the UI so the two can
 * never show a control the resolver would silently overrule.
 */
import { isEffectLocked, describeEffectRows } from '../settings-panel.js';

export function run(t) {
  const { ok } = t;

  // --- isEffectLocked ---------------------------------------------------
  {
    ok('photosensitive + a11y on → locked', isEffectLocked({ photosensitive: true }, true) === true);
    ok('photosensitive + a11y off → not locked', isEffectLocked({ photosensitive: true }, false) === false);
    ok(
      'not photosensitive + a11y on → not locked (nothing to protect)',
      isEffectLocked({ photosensitive: false }, true) === false
    );
    ok('neither → not locked', isEffectLocked({ photosensitive: false }, false) === false);
    ok(
      'an absent photosensitive flag is treated as false, never locked by accident',
      isEffectLocked({}, true) === false
    );
    ok('a malformed row does not throw', isEffectLocked(null, true) === false);
    ok(
      'a non-boolean reducePhotosensitive (e.g. undefined) never locks — must be exactly true',
      isEffectLocked({ photosensitive: true }, undefined) === false
    );
  }

  // --- describeEffectRows -------------------------------------------------
  {
    const input = [
      {
        id: 'candleFlame',
        title: 'Candle flames',
        photosensitive: true,
        playerKey: 'candleFlame.playerEnable',
        gmKey: 'candleFlame.gmEnable',
      },
      { id: 'water', title: 'Water', photosensitive: false, playerKey: 'water.playerEnable', gmKey: 'water.gmEnable' },
    ];

    const offRows = describeEffectRows(input, false);
    ok(
      'a11y off → nothing is locked',
      offRows.every((r) => r.locked === false)
    );
    ok('order is preserved, never re-sorted', offRows[0].id === 'candleFlame' && offRows[1].id === 'water');
    ok(
      'title/keys pass through unchanged',
      offRows[0].title === 'Candle flames' && offRows[0].playerKey === 'candleFlame.playerEnable'
    );

    const onRows = describeEffectRows(input, true);
    ok('a11y on → the photosensitive effect is locked', onRows[0].locked === true);
    ok('a11y on → a NON-photosensitive effect is untouched', onRows[1].locked === false);

    ok(
      'a row with no photosensitive flag defaults to false, never undefined (a clean boolean for the DOM to branch on)',
      describeEffectRows([{ id: 'x', title: 'X', playerKey: 'a', gmKey: 'b' }], true)[0].photosensitive === false
    );

    ok('empty input → empty output, no throw', describeEffectRows([], true).length === 0);
    ok('malformed input (not an array) → empty output, no throw', describeEffectRows(null, true).length === 0);
    ok(
      'a null entry in the array degrades to a safe placeholder row rather than throwing',
      describeEffectRows([null], false)[0].title === '?'
    );
  }
}
