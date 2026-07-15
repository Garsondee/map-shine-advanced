/**
 * Shared color-chart layout for local PNG generation and Foundry sampling.
 * @module calibration/chart-spec-build
 */

/** @typedef {{ id: string, label: string, srgb: [number, number, number], rectNorm: { x: number, y: number, w: number, h: number }, group?: string }} ChartPatch */

const NEUTRAL_STEPS = [0, 26, 64, 128, 191, 230, 255];
const WARM_OFFSET = { r: 12, g: 0, b: -14 };
const COOL_OFFSET = { r: -14, g: 0, b: 12 };

const PRIMARY_COLORS = [
  { id: 'red', label: 'Red', srgb: [220, 30, 30] },
  { id: 'green', label: 'Green', srgb: [30, 200, 60] },
  { id: 'blue', label: 'Blue', srgb: [30, 80, 220] },
  { id: 'cyan', label: 'Cyan', srgb: [30, 200, 210] },
  { id: 'magenta', label: 'Magenta', srgb: [210, 40, 200] },
  { id: 'yellow', label: 'Yellow', srgb: [240, 220, 40] },
];

const EXTRA_COLORS = [
  { id: 'orange', label: 'Orange', srgb: [240, 120, 30] },
  { id: 'purple', label: 'Purple', srgb: [120, 50, 180] },
  { id: 'skin_mid', label: 'Skin Mid', srgb: [210, 165, 130] },
  { id: 'sky_haze', label: 'Sky Haze', srgb: [140, 175, 210] },
  { id: 'fire_core', label: 'Fire Core', srgb: [255, 140, 40] },
  { id: 'foliage', label: 'Foliage', srgb: [60, 120, 50] },
];

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
function clampByte(v, lo = 0, hi = 255) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/**
 * @param {number} g
 * @param {{ r: number, g: number, b: number }} off
 * @returns {[number, number, number]}
 */
function greyWithOffset(g, off) {
  return [clampByte(g + off.r), clampByte(g + off.g), clampByte(g + off.b)];
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {{ version: string, defaultWidth: number, defaultHeight: number, patches: ChartPatch[] }}
 */
export function buildChartSpec(width = 2048, height = 2048) {
  const margin = 0.02;
  const headerH = 0.06;
  const rows = 5;
  const usableY = 1 - margin * 2 - headerH;
  const rowH = usableY / rows;
  const patches = [];

  const addRow = (rowIndex, items, group, yOffset = 0) => {
    const cols = items.length;
    const cellW = (1 - margin * 2) / cols;
    const y = margin + headerH + rowIndex * rowH + yOffset;
    for (let i = 0; i < cols; i++) {
      const item = items[i];
      patches.push({
        id: item.id,
        label: item.label,
        srgb: item.srgb,
        group,
        rectNorm: {
          x: margin + i * cellW + cellW * 0.05,
          y: y + rowH * 0.08,
          w: cellW * 0.9,
          h: rowH * 0.84,
        },
      });
    }
  };

  const neutralItems = NEUTRAL_STEPS.map((g, i) => ({
    id: `neutral_${g}`,
    label: `N ${g}`,
    srgb: greyWithOffset(g, { r: 0, g: 0, b: 0 }),
  }));
  const warmItems = NEUTRAL_STEPS.map((g) => ({
    id: `warm_${g}`,
    label: `W ${g}`,
    srgb: greyWithOffset(g, WARM_OFFSET),
  }));
  const coolItems = NEUTRAL_STEPS.map((g) => ({
    id: `cool_${g}`,
    label: `C ${g}`,
    srgb: greyWithOffset(g, COOL_OFFSET),
  }));

  addRow(0, neutralItems, 'neutral_grey');
  addRow(1, warmItems, 'warm_grey');
  addRow(2, coolItems, 'cool_grey');
  addRow(3, PRIMARY_COLORS, 'primary');
  addRow(4, EXTRA_COLORS, 'accent');

  return {
    version: 'chart-spec-v1',
    defaultWidth: width,
    defaultHeight: height,
    patchCount: patches.length,
    patches,
  };
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {ReturnType<typeof buildChartSpec>} spec
 */
export function drawChartToCanvas(ctx, width, height, spec) {
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, Math.floor(width / 1024));
  ctx.strokeRect(
    Math.floor(width * 0.01),
    Math.floor(height * 0.01),
    Math.floor(width * 0.98),
    Math.floor(height * 0.98),
  );

  ctx.fillStyle = '#e8e8e8';
  ctx.font = `${Math.floor(height * 0.028)}px monospace`;
  ctx.fillText('Map Shine Calibration Chart v1', Math.floor(width * 0.02), Math.floor(height * 0.045));

  const cx = Math.floor(width * 0.5);
  const cy = Math.floor(height * 0.5);
  const cross = Math.floor(width * 0.02);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.moveTo(cx - cross, cy);
  ctx.lineTo(cx + cross, cy);
  ctx.moveTo(cx, cy - cross);
  ctx.lineTo(cx, cy + cross);
  ctx.stroke();

  for (const patch of spec.patches) {
    const x = Math.floor(patch.rectNorm.x * width);
    const y = Math.floor(patch.rectNorm.y * height);
    const w = Math.max(1, Math.floor(patch.rectNorm.w * width));
    const h = Math.max(1, Math.floor(patch.rectNorm.h * height));
    const [r, g, b] = patch.srgb;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.strokeRect(x, y, w, h);
    if (h > 24 && w > 40) {
      ctx.fillStyle = r + g + b > 380 ? '#111' : '#eee';
      ctx.font = `${Math.max(10, Math.floor(h * 0.18))}px monospace`;
      ctx.fillText(patch.label, x + 4, y + Math.floor(h * 0.35));
    }
  }
}
