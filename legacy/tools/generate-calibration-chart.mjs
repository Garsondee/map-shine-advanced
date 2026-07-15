#!/usr/bin/env node
/**
 * Generate Map Shine calibration color-chart PNG + chart-spec JSON.
 *
 * Usage:
 *   npm run chart:generate
 *   npm run chart:generate -- --width 4096 --height 4096 --out assets/calibration/msa-chart-v1.png
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { buildChartSpec } from '../calibration/chart-spec-build.mjs';
import { buildChartSpecV2 } from '../calibration/chart-spec-v2-build.mjs';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const opts = {
    mode: 'v1',
    width: 2048,
    height: 2048,
    out: path.join(REPO_ROOT, 'assets/calibration/msa-chart-v1.png'),
    specOut: path.join(REPO_ROOT, 'data/calibration/chart-spec-v1.json'),
    idOut: path.join(REPO_ROOT, 'assets/calibration/msa-chart-v2-id.png'),
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') opts.mode = String(argv[++i] || 'v1').toLowerCase();
    else if (a === '--width') opts.width = Number(argv[++i]) || opts.width;
    else if (a === '--height') opts.height = Number(argv[++i]) || opts.height;
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--spec-out') opts.specOut = path.resolve(argv[++i]);
    else if (a === '--id-out') opts.idOut = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/tools/generate-calibration-chart.mjs [--mode v1|v2] [--width N] [--height N] [--out png] [--spec-out json] [--id-out png]');
      process.exit(0);
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }
  // PowerShell/npm sometimes strips long-flag names and forwards only values.
  // Accept fallback positional form: [mode] [width] [height].
  if (positional[0] && !['v1', 'v2'].includes(opts.mode)) opts.mode = String(positional[0]).toLowerCase();
  if (positional[0] && ['v1', 'v2'].includes(String(positional[0]).toLowerCase())) {
    opts.mode = String(positional[0]).toLowerCase();
    if (positional[1]) opts.width = Number(positional[1]) || opts.width;
    if (positional[2]) opts.height = Number(positional[2]) || opts.height;
  }
  if (opts.mode === 'v2') {
    if (!opts.out.includes('v2')) opts.out = path.join(REPO_ROOT, 'assets/calibration/msa-chart-v2.png');
    if (!opts.specOut.includes('v2')) opts.specOut = path.join(REPO_ROOT, 'data/calibration/chart-spec-v2.json');
  }
  return opts;
}

function writePng(png, outPath) {
  return new Promise((resolve, reject) => {
    png.pack().pipe(fs.createWriteStream(outPath)).on('finish', resolve).on('error', reject);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const spec = opts.mode === 'v2'
    ? buildChartSpecV2(opts.width, opts.height)
    : buildChartSpec(opts.width, opts.height);
  const patchCount = Array.isArray(spec.patches) ? spec.patches.length : (Number(spec.cellCount) || 0);

  fs.mkdirSync(path.dirname(opts.specOut), { recursive: true });
  fs.writeFileSync(opts.specOut, JSON.stringify(spec, null, 2), 'utf8');
  console.log(`[chart:generate] Wrote spec: ${opts.specOut} (${patchCount} patches)`);

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const png = new PNG({ width: opts.width, height: opts.height });

  for (let y = 0; y < opts.height; y++) {
    for (let x = 0; x < opts.width; x++) {
      const idx = (opts.width * y + x) << 2;
      png.data[idx] = 26;
      png.data[idx + 1] = 26;
      png.data[idx + 2] = 26;
      png.data[idx + 3] = 255;
    }
  }

  if (opts.mode === 'v2') {
    const idPng = new PNG({ width: opts.width, height: opts.height });
    for (let y = 0; y < opts.height; y++) {
      for (let x = 0; x < opts.width; x++) {
        const idx = (opts.width * y + x) << 2;
        idPng.data[idx] = 0;
        idPng.data[idx + 1] = 0;
        idPng.data[idx + 2] = 0;
        idPng.data[idx + 3] = 255;
      }
    }

    const mf = Math.max(1, Math.floor((spec.grid?.markerFrac ?? 0.2) * Math.min(opts.width, opts.height) * 0.035));
    for (const cell of spec.cells ?? []) {
      const x0 = Math.floor(cell.rectNorm.x * opts.width);
      const y0 = Math.floor(cell.rectNorm.y * opts.height);
      const x1 = Math.min(opts.width, x0 + Math.floor(cell.rectNorm.w * opts.width));
      const y1 = Math.min(opts.height, y0 + Math.floor(cell.rectNorm.h * opts.height));
      const [r, g, b] = cell.srgb;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (opts.width * y + x) << 2;
          png.data[idx] = r;
          png.data[idx + 1] = g;
          png.data[idx + 2] = b;
          png.data[idx + 3] = 255;
          // ID map encodes row/col signature in RG.
          idPng.data[idx] = (cell.row * 31) & 255;
          idPng.data[idx + 1] = (cell.col * 17) & 255;
          idPng.data[idx + 2] = (cell.tileIndex * 13) & 255;
        }
      }
      const corners = [
        { x: x0, y: y0, rgb: cell.marker.tl },
        { x: Math.max(x0, x1 - mf), y: y0, rgb: cell.marker.tr },
        { x: x0, y: Math.max(y0, y1 - mf), rgb: cell.marker.bl },
        { x: Math.max(x0, x1 - mf), y: Math.max(y0, y1 - mf), rgb: cell.marker.br },
      ];
      for (const c of corners) {
        for (let y = c.y; y < Math.min(y1, c.y + mf); y++) {
          for (let x = c.x; x < Math.min(x1, c.x + mf); x++) {
            const idx = (opts.width * y + x) << 2;
            png.data[idx] = c.rgb[0];
            png.data[idx + 1] = c.rgb[1];
            png.data[idx + 2] = c.rgb[2];
          }
        }
      }
    }

    await writePng(idPng, opts.idOut);
    console.log(`[chart:generate] Wrote ID PNG: ${opts.idOut} (${opts.width}x${opts.height})`);
  } else {
    for (const patch of spec.patches) {
      const x0 = Math.floor(patch.rectNorm.x * opts.width);
      const y0 = Math.floor(patch.rectNorm.y * opts.height);
      const x1 = Math.min(opts.width, x0 + Math.floor(patch.rectNorm.w * opts.width));
      const y1 = Math.min(opts.height, y0 + Math.floor(patch.rectNorm.h * opts.height));
      const [r, g, b] = patch.srgb;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (opts.width * y + x) << 2;
          png.data[idx] = r;
          png.data[idx + 1] = g;
          png.data[idx + 2] = b;
          png.data[idx + 3] = 255;
        }
      }
    }
  }

  const border = Math.max(2, Math.floor(opts.width / 1024));
  for (let i = 0; i < border; i++) {
    for (let x = 0; x < opts.width; x++) {
      for (const y of [i, opts.height - 1 - i]) {
        const idx = (opts.width * y + x) << 2;
        png.data[idx] = 255;
        png.data[idx + 1] = 255;
        png.data[idx + 2] = 255;
      }
    }
    for (let y = 0; y < opts.height; y++) {
      for (const x of [i, opts.width - 1 - i]) {
        const idx = (opts.width * y + x) << 2;
        png.data[idx] = 255;
        png.data[idx + 1] = 255;
        png.data[idx + 2] = 255;
      }
    }
  }

  await writePng(png, opts.out);
  console.log(`[chart:generate] Wrote PNG: ${opts.out} (${opts.width}x${opts.height})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
