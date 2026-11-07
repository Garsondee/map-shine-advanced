/**
 * THE LIGHT METER OVERLAY — false colour over the board (mmp-dpw.10).
 *
 * A DOM canvas laid over Foundry's board, one pixel per meter cell, scaled up without
 * smoothing, so each patch of the screen shows its band of light (diag/light-meter.js
 * LIGHT_METER_BANDS) plus a legend with the shares and the median EV. Pure DOM: nothing
 * in the render pipeline changes, so it costs nothing when off and cannot alter the picture
 * it measures.
 *
 * @module diag/light-meter-overlay
 */
import { LIGHT_METER_BANDS, falseColourPixels } from './light-meter.js';

const ID = 'msa-light-meter-overlay';

/**
 * Create or update the overlay.
 * @param {{w:number,h:number}} grid @param {ReturnType<import('./light-meter.js').lightMeterStats>} stats
 * @param {{alpha?: number}} [opts]
 */
export function paintLightMeterOverlay(grid, stats, { alpha = 160 } = {}) {
  const doc = globalThis.document;
  if (!doc) return;
  const board = doc.getElementById('board') ?? doc.querySelector('canvas');
  const rect = board?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
  let wrap = doc.getElementById(ID);
  if (!wrap) {
    wrap = doc.createElement('div');
    wrap.id = ID;
    Object.assign(wrap.style, { position: 'fixed', pointerEvents: 'none', zIndex: '60' });
    const cv = doc.createElement('canvas');
    Object.assign(cv.style, { width: '100%', height: '100%', imageRendering: 'pixelated', display: 'block' });
    const legend = doc.createElement('div');
    Object.assign(legend.style, {
      position: 'absolute',
      right: '12px',
      bottom: '12px',
      background: 'rgba(0,0,0,0.75)',
      color: '#fff',
      font: '12px/1.4 monospace',
      padding: '8px 10px',
      borderRadius: '6px',
    });
    wrap.append(cv, legend);
    doc.body.append(wrap);
  }
  Object.assign(wrap.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  const [cv, legend] = wrap.children;
  cv.width = grid.w;
  cv.height = grid.h;
  const ctx = cv.getContext('2d');
  // The meter grid is read back top-origin (vt readback convention), which is canvas order.
  ctx.putImageData(new ImageData(falseColourPixels(stats.perCellEv, alpha), grid.w, grid.h), 0, 0);
  const rows = LIGHT_METER_BANDS.map((b, i) => {
    const share = Math.round((stats.bands[i]?.share ?? 0) * 100);
    const sw = `<span style="display:inline-block;width:10px;height:10px;background:rgb(${b.rgb.join(',')})"></span>`;
    return `${sw} ${String(share).padStart(3)}%  ${b.label}`;
  });
  legend.innerHTML =
    `<b>Light meter</b> median ${stats.evMedian ?? '-'} EV (p5 ${stats.evP5 ?? '-'}, p95 ${stats.evP95 ?? '-'})<br>` +
    `over white ${Math.round(stats.overWhiteShare * 100)}%<br>` +
    rows.join('<br>');
}

/** Remove the overlay. */
export function removeLightMeterOverlay() {
  globalThis.document?.getElementById(ID)?.remove();
}
