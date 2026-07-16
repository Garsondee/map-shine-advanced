/**
 * Bundle Three's NODE build (`three/webgpu` + `three/tsl`) into one vendored ESM
 * file the browser can load directly.
 *
 * WHY THIS EXISTS: `three.webgpu.js` is not standalone — it imports `three.core.js`
 * — and `three.tsl.js` is a one-line re-export of `TSL` from `three/webgpu`. Bare
 * specifiers like `three/webgpu` don't resolve in a browser, and Foundry loads
 * `src/boot.js` as a plain ES module. So the pieces have to be bundled once, here.
 *
 * THE BUG THIS AVOIDS — legacy/build/entry.js, which claimed to build TSL and
 * silently didn't, for however long it sat there:
 *
 *     import * as THREE from 'three';   // ← the CLASSIC build. Has no TSL.
 *     const { TSL } = THREE;            // ← always undefined
 *     if (TSL) { ... }                  // ← never ran
 *
 * It was ONE WORD from working: `'three/webgpu'` exports `TSL`; `'three'` does not.
 * Nothing threw, nothing warned, and its own log line called itself "WebGL-only".
 * This script re-exports explicitly and the spike asserts the exports exist at
 * runtime, so a repeat cannot be silent.
 *
 * Run: npm run build:three-webgpu
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outfile = resolve(root, 'src/vendor/three/three.webgpu.js');
const entry = resolve(root, 'src/vendor/three/.webgpu-entry.js');

mkdirSync(dirname(entry), { recursive: true });
// Explicit re-export of BOTH namespaces. `TSL` is the node language; the rest is
// the renderer + node materials. Named separately so a missing one is a build
// error rather than an undefined at runtime.
writeFileSync(entry, ["export * from 'three/webgpu';", "export * as TSL from 'three/tsl';", ''].join('\n'), 'utf8');

await build({
  entryPoints: [entry],
  bundle: true,
  outfile,
  format: 'esm',
  target: ['es2022'],
  minify: false, // vendored code stays readable — this project debugs INTO Three
  sourcemap: false,
  legalComments: 'inline',
  logLevel: 'warning',
});

const kb = (statSync(outfile).size / 1024).toFixed(0);
console.log(`built ${outfile} (${kb} KB)`);
console.log('NOTE: this is the SPIKE build (docs/planning/Shaders.md §7.5). Adopting it is a separate decision.');
