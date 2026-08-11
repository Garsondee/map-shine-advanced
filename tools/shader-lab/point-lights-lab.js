/**
 * SHADER LAB — page wiring for STAGE 2's point-light batching proof.
 *
 * Minimal on purpose: this bench is driven via `window.lab.run('point-lights',
 * scenarioName, {})` (the same generic contract every other bench uses), not
 * through a dedicated form — there are no parameters to tune, only two fixed
 * scenarios to run and read. `lab.js` is untouched, same as every sibling
 * `-lab.js` file.
 *
 * @module tools/shader-lab/point-lights-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { installContract } from './contract.js';
import { createPointLightsBench } from './bench-point-lights.js';

const log = (msg) => console.log('[point-lights-lab]', msg);

installContract();
window.pointLightsBench = createPointLightsBench({ THREE, log });
