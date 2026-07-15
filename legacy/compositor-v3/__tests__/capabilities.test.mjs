/**
 * Node tests for core/capabilities.js `detect()` — the post-TDR retry logic
 * (a transient probe failure must NOT be reported as an incompatible GPU).
 * Runs under the same harness; mocks `document` + a scripted getContext.
 * Run via ./run-tests.mjs.
 */
import { detect } from '../../core/capabilities.js';

/**
 * Install a fake `document` whose canvas `getContext` is driven by `plan`:
 * plan(type, attemptIndex) → truthy fake-gl or null. Returns a restore fn.
 */
function withMockDocument(plan, run) {
  const prev = globalThis.document;
  let attempt = -1;
  const fakeGl = { getExtension: () => ({ loseContext() {} }) };
  globalThis.document = {
    createElement() {
      attempt += 1;
      const a = attempt;
      return {
        width: 0,
        height: 0,
        getContext(type) {
          const ok = plan(type, a);
          return ok ? fakeGl : null;
        },
        remove() {},
      };
    },
  };
  return Promise.resolve(run()).finally(() => { globalThis.document = prev; });
}

export async function run(t) {
  const { ok } = t;

  // Success on first probe → tier high, no retries consumed.
  await withMockDocument((type) => type === 'webgl2', async () => {
    const caps = await detect({ retries: 4, retryDelayMs: 0 });
    ok('first-probe webgl2 → tier high', caps.tier === 'high' && caps.webgl2 === true);
  });

  // webgl2 unavailable but webgl1 present → tier low.
  await withMockDocument((type) => type === 'webgl', async () => {
    const caps = await detect({ retries: 2, retryDelayMs: 0 });
    ok('webgl1 only → tier low', caps.tier === 'low' && caps.webgl === true && caps.webgl2 === false);
  });

  // Transient: fails the first 2 attempts, succeeds on the 3rd (post-TDR settle).
  await withMockDocument((type, attempt) => type === 'webgl2' && attempt >= 2, async () => {
    const caps = await detect({ retries: 4, retryDelayMs: 0 });
    ok('transient failure recovered on retry → tier high', caps.tier === 'high');
  });

  // Genuinely no GPU: every attempt fails → tier none (only after exhausting retries).
  {
    let attempts = 0;
    await withMockDocument((type) => { if (type === 'webgl2') attempts += 1; return false; }, async () => {
      const caps = await detect({ retries: 3, retryDelayMs: 0 });
      ok('all probes fail → tier none', caps.tier === 'none' && caps.webgl2 === false && caps.webgl === false);
      // 1 initial + 3 retries = 4 webgl2 probe attempts (proves the loop bound).
      ok('exhausts exactly retries+1 attempts', attempts === 4);
    });
  }

  // retries: 0 → single attempt, no retry (behaves like the old one-shot).
  {
    let attempts = 0;
    await withMockDocument((type) => { if (type === 'webgl2') attempts += 1; return false; }, async () => {
      const caps = await detect({ retries: 0, retryDelayMs: 0 });
      ok('retries:0 → one attempt, tier none', caps.tier === 'none' && attempts === 1);
    });
  }
}
