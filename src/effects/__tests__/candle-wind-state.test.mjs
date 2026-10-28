/**
 * Node verification for effects/candle-wind-state.js — the candle that
 * remembers being blown out. The TSL look-back is GPU-verified; these pin the
 * timing the author asked for and that the look-back window can hold it.
 */
import {
  candleRecoveryAt,
  CANDLE_DARK_S,
  CANDLE_REGROW_END_S,
  CANDLE_HISTORY_STEP_S,
  CANDLE_HISTORY_TAPS,
  CANDLE_GUTTER_MAG_LOW,
  CANDLE_SNUFF_MAG_LOW,
} from '../candle-wind-state.js';

export function run(t) {
  const { ok } = t;
  ok('⭐ a snuffed candle is fully out at the moment of the gust', candleRecoveryAt(1, 0) === 0);
  ok(
    '⭐ …and STAYS out for a while ("spend longer in the off state")',
    candleRecoveryAt(1, CANDLE_DARK_S * 0.95) === 0 && CANDLE_DARK_S >= 2
  );
  ok(
    '⭐ it comes back SLOWLY (a third regrown takes seconds, not a frame)',
    candleRecoveryAt(1, CANDLE_DARK_S + 1) < 0.25
  );
  ok('it is fully back by the regrow end', Math.abs(candleRecoveryAt(1, CANDLE_REGROW_END_S) - 1) < 1e-9);
  ok('regrowth spans several seconds — room for the next gust to catch it', CANDLE_REGROW_END_S - CANDLE_DARK_S >= 4);
  ok('a gust that only half-snuffs leaves half the light', Math.abs(candleRecoveryAt(0.5, 0) - 0.5) < 1e-9);
  ok(
    'the look-back window reaches past the full regrowth (else a candle would pop back early)',
    CANDLE_HISTORY_STEP_S * (CANDLE_HISTORY_TAPS - 1) >= CANDLE_REGROW_END_S
  );
  ok(
    '⭐ "more guttering before going out" — guttering starts well below the snuff',
    CANDLE_SNUFF_MAG_LOW / CANDLE_GUTTER_MAG_LOW >= 3
  );
}
