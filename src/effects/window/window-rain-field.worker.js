/**
 * RAIN ON GLASS — the pane field, derived off the main thread (2026-11-03). Pooling the window mask into the presence
 * grid and deriving the field from it are pure math over byte arrays, and on the main thread they made the first rain
 * frame a 310-370 ms freeze (Mad Scientist, the FPS round's trace). The window subsystem sends a copy of the mask
 * and uploads the answer on a later frame, dropping any answer whose job is no longer the current one.
 *
 * @module effects/window/window-rain-field.worker
 */
import { buildWindowPresenceGrid, deriveWindowRainField } from './window-rain-field.js';

self.onmessage = (e) => {
  const { job, mask, outdoors, spec, easePx } = e.data || {};
  try {
    const presence = buildWindowPresenceGrid({ ...mask, spec });
    const field = presence ? deriveWindowRainField({ outdoors, spec, presence, easePx }) : null;
    const transfer = field ? [field.dirs.buffer, field.aux.buffer] : [];
    self.postMessage({ job, field }, transfer);
  } catch (err) {
    self.postMessage({ job, error: String(err?.message || err) });
  }
};
