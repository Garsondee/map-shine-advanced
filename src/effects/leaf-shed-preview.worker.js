/**
 * LEAF SHED — the design-preview worker: draws one design per message (`leaf-shed-preview.js`) off the main
 * thread, so dragging a Studio slider never stalls the page while the pictures catch up. One job at a time:
 * the card sends the next only when this one answers, and drops stale jobs itself.
 *
 * @module effects/leaf-shed-preview.worker
 */
import { renderShedPreview } from './leaf-shed-preview.js';

self.onmessage = (e) => {
  const { job, designId, params, size } = e.data || {};
  try {
    const px = renderShedPreview(designId, params, size);
    self.postMessage({ job, designId, size, px }, [px.buffer]);
  } catch (err) {
    self.postMessage({ job, designId, size, error: String(err?.message || err) });
  }
};
