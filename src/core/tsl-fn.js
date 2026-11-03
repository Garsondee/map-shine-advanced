/**
 * core/tsl-fn.js — SHADER CODE THAT IS WRITTEN ONCE (2026-11-03, epic mmp-8gf.1).
 *
 * ============================================================================
 * WHY THIS FILE EXISTS: TSL PASTES, IT DOES NOT CALL
 * ============================================================================
 * A shader's size is its cost twice over: three builds the WGSL text on the
 * main thread, and the GPU driver compiles it — synchronously, on the GPU
 * process's main thread, for every pipeline that is not async
 * (`core/compile-policy.js`). The load round of 2026-11-02 measured 2.3 M chars
 * per load, and a single 15 s compile is enough to lose the device.
 *
 * Two TSL habits multiply that size without anyone writing more code:
 *
 *   1. A plain `Fn(body)` — and any JS arrow that returns nodes — is INLINED:
 *      three runs `body` again at every call site (three TSLCore.js,
 *      `ShaderCallNodeInternal`, "no layout" branch) and the whole body is
 *      pasted into the shader once per call. A noise helper called 12 times is
 *      12 copies of the noise.
 *
 *      An Fn WITH A LAYOUT (`Fn(body).setLayout({name, type, inputs})`) is
 *      emitted ONCE as a real WGSL function (`builder.buildFunctionNode` +
 *      `addInclude`) and every call site is a one-line call. three's own
 *      MaterialX noise is written this way (52 layouts in mx_noise.js).
 *
 *   2. A CONDITIONAL's operands are re-emitted inside each branch. `select`,
 *      `If` and `cond` build into `if / else` blocks, and a shared operand that
 *      was never pinned to a variable is generated again inside every branch
 *      that reads it. A JS loop that feeds each step's result into the next
 *      step's `select` therefore DOUBLES per step: the critters' eight-token
 *      "nearest token" scan was 2^8 copies of itself and made the fly kernel
 *      391k chars (82k once pinned). The fix is `.toVar()` on each step.
 *
 * ============================================================================
 * THE DEFAULT, FROM NOW ON
 * ============================================================================
 *   - A TSL helper that is CALLED MORE THAN ONCE in a shader (a noise, a hash,
 *     a colour op, an SDF, a sampler of a fixed texture) is built with
 *     `layoutFn` below, ONCE at module scope or once per factory — never inside
 *     the function that calls it (three caches the emitted function by the
 *     Fn object; a new object per call is a new copy per call).
 *   - A value carried from step to step of a JS loop through `select`/`mix`/`If`
 *     is pinned with `.toVar()` every step (or the loop is a TSL `Loop` inside
 *     an `Fn`, see the load ledger 2026-11-02).
 *   - A one-shot body (a kernel's main `Fn(() => {...})().compute(n)`, a
 *     material's output graph) needs neither: it is built once anyway.
 *
 * ============================================================================
 * WHAT A LAYOUT FUNCTION MAY TOUCH: ITS PARAMETERS. NOTHING ELSE.
 * ============================================================================
 * three builds a layout function's code ONCE PER RENDERER and reuses that text
 * in every shader that calls it (`NodeBuilder.buildFunctionNode`'s cache is
 * keyed by backend and Fn, not by shader). Any binding the body reads — a
 * uniform, a texture, a sampler, a storage buffer — is therefore named as the
 * FIRST shader that built it named it, and a second shader fails ("struct
 * member nodeUniform1 not found", found live on 2026-11-03 when two window-light
 * shaders shared one rain) or, worse, binds the wrong thing. Entry-point values
 * (`instanceIndex`, `vertexIndex`, varyings, `positionWorld`, `uv()`) are not in
 * a helper's scope at all. So: pass every uniform, texture value and built-in
 * IN as an argument (pack several floats into a vec4 when there are many; see
 * `window-rain.js` RAIN_PACK). `layoutLeaks` below finds a body that breaks
 * this, and the pipeline governor runs it on every shader that has one.
 * Derivatives (`dFdx`, `fwidth`) and implicit-LOD sampling stay fragment-only,
 * exactly as when inlined.
 *
 * @module core/tsl-fn
 */

const LAYOUT_TYPES = new Set([
  'float',
  'int',
  'uint',
  'bool',
  'vec2',
  'vec3',
  'vec4',
  'ivec2',
  'ivec3',
  'ivec4',
  'uvec2',
  'uvec3',
  'uvec4',
  'mat2',
  'mat3',
  'mat4',
  'void',
]);

const builtCount = new Map();
/** `sharedFn` helpers, one per (TSL namespace, name). */
const shared = new WeakMap();

function check(name, inputs, returns) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`tsl-fn: "${name}" is not a WGSL identifier`);
  for (const [param, type] of Object.entries(inputs)) {
    if (!LAYOUT_TYPES.has(type)) throw new Error(`tsl-fn ${name}: input "${param}" has unknown type "${type}"`);
  }
  if (!LAYOUT_TYPES.has(returns)) throw new Error(`tsl-fn ${name}: unknown return type "${returns}"`);
}

function make(TSL, name, inputs, returns, body) {
  builtCount.set(name, (builtCount.get(name) ?? 0) + 1);
  return TSL.Fn(body).setLayout({
    name,
    type: returns,
    inputs: Object.entries(inputs).map(([n, type]) => ({ name: n, type })),
  });
}

/**
 * A layout function built by ONE effect factory (it may close over the factory's constants and its pure helpers,
 * never its uniforms or textures — those come in as arguments, see the header). Build it once per instance and
 * call it as often as you like.
 *
 * THE NAME IS KEPT EXACTLY AS GIVEN, every build. A rebuilt material must produce the same WGSL text as the
 * last build or three's program cache and Chrome's shader disk cache both miss (`mmp-8gf.2`). The rule this
 * leaves to the caller: a name must be unique WITHIN ONE SHADER. A factory that can be instantiated twice into
 * the same shader must take a suffix and pass a different name per instance; a clash fails loudly at
 * compile ("redefinition"), never silently.
 *
 * @param {object} TSL - three's TSL namespace (the injected one; `THREE.TSL`).
 * @param {string} name - a WGSL identifier, `msa` + effect + helper (e.g. `'msaRainHash'`).
 * @param {Record<string, string>} inputs - parameter name → type (`'vec2'`, `'float'`, `'uint'`, …), IN CALL ORDER.
 * @param {string} returns - the return type (`'void'` for a statement-only body). Several results: pack them
 *   into one vector (`vec3(off.xy, gain)`) and unpack at the call.
 * @param {(args: object) => any} body - receives the parameters as nodes, by name (`({ p, scale }) => …`) or by
 *   position (`([p, scale]) => …`). Arguments are cast to the declared types at the call (`u32(x)` for an int).
 * @returns {Function} call it like any TSL Fn: `helper(p, scale)`.
 */
export function layoutFn(TSL, name, inputs, returns, body) {
  if (!TSL?.Fn) throw new Error('layoutFn: pass the TSL namespace');
  check(name, inputs, returns);
  return make(TSL, name, inputs, returns, body);
}

/**
 * A layout function shared by every caller: built once per name, so every shader that uses it carries the identical
 * function text. Its body may read ONLY its parameters and literal constants (the same rule as `layoutFn`; here
 * the first caller's closure is the one every caller gets, so it must not matter whose it was).
 *
 * @param {object} TSL @param {string} name @param {Record<string, string>} inputs @param {string} returns
 * @param {(args: object) => any} body
 * @returns {Function}
 */
export function sharedFn(TSL, name, inputs, returns, body) {
  if (!TSL?.Fn) throw new Error('sharedFn: pass the TSL namespace');
  let byName = shared.get(TSL);
  if (!byName) shared.set(TSL, (byName = new Map()));
  const hit = byName.get(name);
  if (hit) return hit;
  check(name, inputs, returns);
  const fn = make(TSL, name, inputs, returns, body);
  byName.set(name, fn);
  return fn;
}

/**
 * MSA layout functions in a WGSL text that read something other than their parameters — a uniform (`object.` /
 * `render.` struct members), a texture or sampler (`nodeUniformN`), a storage buffer, a varying or an entry-point
 * built-in. Each one is the bug in this module's header ("struct member … not found" in the second shader, or a
 * silently wrong binding). The governor runs this on every shader that carries an `fn msa…`; tests run it on the
 * shaders they build. @param {string} code @returns {Array<{name: string, token: string}>}
 */
export function layoutLeaks(code) {
  const out = [];
  if (typeof code !== 'string' || !code.includes('fn msa')) return out;
  const re = /^fn (msa[A-Za-z0-9_]*)\s*\(/gm;
  let m;
  while ((m = re.exec(code))) {
    const end = code.indexOf('\n}', m.index);
    const body = code.slice(m.index, end < 0 ? undefined : end);
    const hit =
      /\b(object\.|render\.|frame\.|nodeUniform\d+|nodeVarying\d+|NodeBuffer_\d+|instanceIndex|vertexIndex|v_[A-Za-z])/.exec(
        body
      );
    if (hit) out.push({ name: m[1], token: hit[1] });
  }
  return out;
}

/** How many layout helpers were built under each name since load (tests and diagnostics). */
export function layoutFnCensus() {
  return Object.fromEntries(builtCount);
}
