/**
 * @fileoverview Resize handle math and element dimension read/write for the Loading Screen Composer.
 * @module ui/loading-screen/loading-screen-element-resize
 */

export const RESIZE_HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

const MIN_ELEMENT_SIZE = 12;
const MIN_PANEL_WIDTH = 120;

/**
 * @param {string} anchor
 * @param {{ left: number, top: number, width: number, height: number }} rect
 * @returns {{ x: number, y: number }}
 */
export function anchorPointFromRect(anchor, rect) {
  const { left, top, width, height } = rect;
  const a = String(anchor || 'center').toLowerCase();

  if (a === 'top-left') return { x: left, y: top };
  if (a === 'top-right') return { x: left + width, y: top };
  if (a === 'bottom-left') return { x: left, y: top + height };
  if (a === 'bottom-right') return { x: left + width, y: top + height };
  if (a === 'top-center') return { x: left + width / 2, y: top };
  if (a === 'bottom-center') return { x: left + width / 2, y: top + height };
  if (a === 'center-left') return { x: left, y: top + height / 2 };
  if (a === 'center-right') return { x: left + width, y: top + height / 2 };
  return { x: left + width / 2, y: top + height / 2 };
}

/**
 * @param {{ left: number, top: number, right: number, bottom: number }} startRect
 * @param {string} handle
 * @param {number} px pointer x in layer coords
 * @param {number} py pointer y in layer coords
 * @param {number} [minSize]
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
export function computeResizedRect(startRect, handle, px, py, minSize = MIN_ELEMENT_SIZE) {
  let left = startRect.left;
  let top = startRect.top;
  let right = startRect.right;
  let bottom = startRect.bottom;
  const h = String(handle || 'se');

  if (h.includes('e')) right = px;
  if (h.includes('w')) left = px;
  if (h.includes('n')) top = py;
  if (h.includes('s')) bottom = py;

  if (right - left < minSize) {
    if (h.includes('w')) left = right - minSize;
    else right = left + minSize;
  }
  if (bottom - top < minSize) {
    if (h.includes('n')) top = bottom - minSize;
    else bottom = top + minSize;
  }

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * Panel only supports horizontal resize (width).
 * @param {{ left: number, top: number, right: number, bottom: number }} startRect
 * @param {string} handle
 * @param {number} px
 * @param {number} [minWidth]
 */
export function computePanelResizeRect(startRect, handle, px, minWidth = MIN_PANEL_WIDTH) {
  const h = String(handle || 'e');
  if (!['e', 'w', 'ne', 'nw', 'se', 'sw'].includes(h)) return null;

  let left = startRect.left;
  let right = startRect.right;
  const top = startRect.top;
  const height = startRect.bottom - startRect.top;

  if (h.includes('e')) right = px;
  if (h.includes('w')) left = px;

  if (right - left < minWidth) {
    if (h.includes('w')) left = right - minWidth;
    else right = left + minWidth;
  }

  return {
    left,
    top,
    width: right - left,
    height,
  };
}

/**
 * @param {object} element
 * @param {DOMRect} layerRect
 * @param {DOMRect} nodeRect
 * @returns {{ left: number, top: number, right: number, bottom: number, width: number, height: number }}
 */
export function measureElementRect(nodeRect, layerRect) {
  const left = nodeRect.left - layerRect.left;
  const top = nodeRect.top - layerRect.top;
  const width = nodeRect.width;
  const height = nodeRect.height;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/**
 * @param {object} element
 * @param {number} widthPx
 * @param {number} heightPx
 */
export function writeElementDimensions(element, widthPx, heightPx) {
  if (!element) return;
  const type = String(element.type || 'text');
  const w = Math.max(MIN_ELEMENT_SIZE, Math.round(widthPx));
  const h = Math.max(MIN_ELEMENT_SIZE, Math.round(heightPx));

  if (type === 'progress-bar') {
    if (!element.props) element.props = {};
    element.props.widthPx = w;
    element.props.heightPx = Math.max(2, Math.round(heightPx));
    delete element.props.widthCss;
    return;
  }

  if (type === 'spinner') {
    if (!element.props) element.props = {};
    if (String(element._resizeAxis || '') === 'width') {
      element.props.sizePx = w;
    } else if (element._resizeAxis === 'height') {
      element.props.sizePx = h;
    } else {
      element.props.sizePx = Math.max(w, h);
    }
    delete element.props.sizeCss;
    return;
  }

  if (type === 'image') {
    if (!element.props) element.props = {};
    element.props.widthPx = w;
    element.props.heightPx = h;
    delete element.props.widthCss;
    delete element.props.heightCss;
    return;
  }

  if (type === 'stage-pills') {
    if (!element.props) element.props = {};
    element.props.maxWidthPx = w;
    delete element.props.maxWidthCss;
    const padY = Math.max(0, Math.round((h - 24) / 2));
    element.props.containerPaddingYpx = padY;
    return;
  }

  if (!element.style) element.style = {};
  element.style.widthPx = w;
  element.style.heightPx = h;
  delete element.style.widthCss;
  delete element.style.maxWidthCss;
  if (Number.isFinite(element.style.maxWidthPx)) {
    element.style.maxWidthPx = Math.max(w, Number(element.style.maxWidthPx));
  }
}

/**
 * @param {object} panelCfg
 * @param {number} widthPx
 */
export function writePanelWidth(panelCfg, widthPx) {
  if (!panelCfg) return;
  panelCfg.widthPx = Math.max(MIN_PANEL_WIDTH, Math.round(widthPx));
  delete panelCfg.widthCss;
}

/**
 * @param {object} element
 * @param {{ left: number, top: number, width: number, height: number }} rect
 * @param {string} anchor
 * @param {number} layerWidth
 * @param {number} layerHeight
 * @param {string} [handle]
 */
export function applyRectToElement(element, rect, anchor, layerWidth, layerHeight, handle = 'se') {
  if (!element?.position) return;

  const type = String(element.type || 'text');
  if (type === 'spinner') {
    if (handle === 'e' || handle === 'w' || handle.includes('e') || handle.includes('w')) {
      element._resizeAxis = 'width';
    } else if (handle === 'n' || handle === 's' || handle.includes('n') || handle.includes('s')) {
      element._resizeAxis = 'height';
    } else {
      delete element._resizeAxis;
    }
  }

  writeElementDimensions(element, rect.width, rect.height);

  const anchorPt = anchorPointFromRect(anchor, rect);
  element.position.x = clampPct((anchorPt.x / Math.max(1, layerWidth)) * 100);
  element.position.y = clampPct((anchorPt.y / Math.max(1, layerHeight)) * 100);
}

/**
 * @param {object} panelCfg
 * @param {{ left: number, top: number, width: number, height: number }} rect
 * @param {number} layerWidth
 * @param {number} layerHeight
 */
export function applyRectToPanel(panelCfg, rect, layerWidth, layerHeight) {
  if (!panelCfg) return;
  writePanelWidth(panelCfg, rect.width);
  const anchorPt = anchorPointFromRect('center', rect);
  panelCfg.x = clampPct((anchorPt.x / Math.max(1, layerWidth)) * 100);
  panelCfg.y = clampPct((anchorPt.y / Math.max(1, layerHeight)) * 100);
}

/**
 * @param {string} handle
 * @returns {string}
 */
export function cursorForHandle(handle) {
  const map = {
    n: 'ns-resize',
    s: 'ns-resize',
    e: 'ew-resize',
    w: 'ew-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
    nw: 'nwse-resize',
    se: 'nwse-resize',
  };
  return map[String(handle || 'se')] || 'nwse-resize';
}

function clampPct(v) {
  return Math.max(0, Math.min(100, Number(v)));
}
