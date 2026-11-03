/**
 * TEMPERATURE EFFECTS — the frost / heat-ripple noise tile, baked off the main thread (2026-11-03). The tile is a pure,
 * seeded function (`buildTemperatureNoiseData`), and building it on first use was a ~150 ms JavaScript block inside a
 * frame (Deep Forest's zoom-out, found in a Chrome profile). The viewer starts this early and takes the answer when the
 * effect is first wanted; if it is not back yet the viewer builds the tile itself, exactly as before.
 *
 * @module effects/temperature/temperature-noise.worker
 */
import { buildTemperatureNoiseData } from './temperature-noise.js';

self.onmessage = (e) => {
  const { size, seed } = e.data || {};
  try {
    const out = buildTemperatureNoiseData(size, seed);
    self.postMessage(out, [out.data.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
