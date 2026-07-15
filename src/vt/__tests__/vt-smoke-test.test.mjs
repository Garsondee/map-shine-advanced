/**
 * Node verification for vt/vt-smoke-test.js's one pure function. The rest of
 * that module needs a real browser (WebGL2, createImageBitmap, DOM) — it's
 * verified live via the debug panel's "VT Smoke Test" report instead.
 */
import { encodeIndirectionTexel } from '../vt-smoke-test.js';

export function run(t) {
  const { ok } = t;

  ok('not resident -> all-zero (the GLSL decode reads a>0.5 as the residency test)',
    JSON.stringify(encodeIndirectionTexel(999, false)) === JSON.stringify([0, 0, 0, 0]));

  ok('slot 0, resident -> [0,0,0,255]', JSON.stringify(encodeIndirectionTexel(0, true)) === JSON.stringify([0, 0, 0, 255]));
  ok('slot 255, resident -> low byte maxed, high byte 0', JSON.stringify(encodeIndirectionTexel(255, true)) === JSON.stringify([255, 0, 0, 255]));
  ok('slot 256, resident -> low byte wraps to 0, high byte 1 (matches GLSL: r + g*256 decode)',
    JSON.stringify(encodeIndirectionTexel(256, true)) === JSON.stringify([0, 1, 0, 255]));
  ok('slot 2047 (max at the 512MB/8GB-tier default capacity), resident',
    JSON.stringify(encodeIndirectionTexel(2047, true)) === JSON.stringify([2047 & 0xff, (2047 >> 8) & 0xff, 0, 255]));
}
