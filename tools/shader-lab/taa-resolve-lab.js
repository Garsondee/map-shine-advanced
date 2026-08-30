/**
 * SHADER LAB — page wiring for the TAA Resolve bench. No UI panel (console-
 * driven, `window.lab.run('taa-resolve', <scenario>)`) — same minimal
 * shape `block-compress-lab.js`/`albedo-clarity-lab.js` use for a
 * pixel-comparison-driven bench with no persistent on-screen render.
 *
 * @module tools/shader-lab/taa-resolve-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createTaaResolveBench } from './bench-taa-resolve.js';

const log = (msg) => console.log('[taa-resolve-lab]', msg);

installContract();
const bench = createTaaResolveBench({ THREE, log });
window.taaResolveBench = bench;

log('taa-resolve bench ready — window.lab.run("taa-resolve", "reprojection-lands-on-the-correct-stripe")');
