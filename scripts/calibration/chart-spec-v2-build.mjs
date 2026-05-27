/**
 * Tile-based calibration chart layout (v2).
 * @module calibration/chart-spec-v2-build
 */

const PALETTE = [
  { id: 'red', srgb: [220, 30, 30] },
  { id: 'green', srgb: [30, 200, 60] },
  { id: 'blue', srgb: [30, 80, 220] },
  { id: 'cyan', srgb: [30, 200, 210] },
  { id: 'magenta', srgb: [210, 40, 200] },
  { id: 'yellow', srgb: [240, 220, 40] },
  { id: 'neutral_26', srgb: [26, 26, 26] },
  { id: 'neutral_128', srgb: [128, 128, 128] },
  { id: 'neutral_230', srgb: [230, 230, 230] },
  { id: 'orange', srgb: [240, 120, 30] },
  { id: 'purple', srgb: [120, 50, 180] },
  { id: 'foliage', srgb: [60, 120, 50] },
];

function markerColorFromCode(code) {
  // 4-bit code packed into high-contrast channels for resilient readback.
  return [
    code & 0b0001 ? 255 : 16,
    code & 0b0010 ? 255 : 16,
    code & 0b0100 ? 255 : 16,
  ];
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {object}
 */
export function buildChartSpecV2(width = 1920, height = 1080) {
  const aspect = width / height;
  const targetAspect = 16 / 9;
  if (Math.abs(aspect - targetAspect) > 0.05) {
    // Keep metadata explicit for non-16:9 outputs.
  }

  const margin = 0.03;
  const cols = 12;
  const rows = 7;
  const gridW = 1 - margin * 2;
  const gridH = 1 - margin * 2;
  const cellW = gridW / cols;
  const cellH = gridH / rows;
  const markerFrac = 0.2;
  const cells = [];
  let tileIndex = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = PALETTE[tileIndex % PALETTE.length];
      const rowCode = r & 0x7;
      const colCode = c & 0xF;
      cells.push({
        tileIndex,
        row: r,
        col: c,
        colorId: color.id,
        srgb: color.srgb,
        marker: {
          rowCode,
          colCode,
          tl: markerColorFromCode(rowCode),
          tr: markerColorFromCode(colCode),
          bl: markerColorFromCode(rowCode ^ colCode),
          br: markerColorFromCode((rowCode + colCode) & 0xF),
        },
        rectNorm: {
          x: margin + c * cellW,
          y: margin + r * cellH,
          w: cellW,
          h: cellH,
        },
        sampleNorm: {
          center: { u: 0.5, v: 0.5 },
          tl: { u: markerFrac * 0.5, v: markerFrac * 0.5 },
          tr: { u: 1 - markerFrac * 0.5, v: markerFrac * 0.5 },
          bl: { u: markerFrac * 0.5, v: 1 - markerFrac * 0.5 },
          br: { u: 1 - markerFrac * 0.5, v: 1 - markerFrac * 0.5 },
        },
      });
      tileIndex += 1;
    }
  }

  return {
    version: 'chart-spec-v2',
    mode: 'tiled',
    defaultWidth: width,
    defaultHeight: height,
    targetAspect: targetAspect,
    grid: { rows, cols, margin, markerFrac },
    palette: PALETTE,
    cellCount: cells.length,
    cells,
  };
}
