/**
 * Test-only browser-global shim. Some shared utilities the V3 modules import
 * (e.g. utils/coordinates.js) assign to `window` at MODULE LOAD time, which is
 * fine in a browser but throws under Node. This shim provides inert globals so
 * those modules load; every code path that would actually USE them at runtime is
 * stubbed in the test bodies (the lighting/present passes never run for real
 * under Node). Import this FIRST in run-tests.mjs.
 */
globalThis.window = globalThis.window || globalThis;
globalThis.canvas = globalThis.canvas || null;
globalThis.foundry = globalThis.foundry || {};
globalThis.game = globalThis.game || {};

export {};
