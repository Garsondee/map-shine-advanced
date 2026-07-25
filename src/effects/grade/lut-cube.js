/**
 * THE .cube LUT PARSER — Adobe/IRIDAS Cube 3D-LUT text → GPU-ready RGBA data.
 *
 * A 3D LUT is the industry-standard "creative look": a baked colour transform
 * (film emulation, a show LUT, a stylised grade) sampled trilinearly per pixel.
 * WebGPU/TSL samples it natively via `Data3DTexture` + the `texture3D` node
 * (three.webgpu.js) — so the ONLY new code a LUT needs is this parser. We own it
 * rather than vendor `LUTCubeLoader` from three's examples: it is ~one screen of
 * pure text parsing, Node-testable, and a vendored addon is a dependency we'd
 * have to keep in sync across the WebGPU build (docs/planning/Grade.md §15).
 *
 * THE FORMAT (the subset that matters):
 *   TITLE "…"                     (optional)
 *   LUT_3D_SIZE N                 (required; N is the cube edge, e.g. 33 or 65)
 *   DOMAIN_MIN r g b              (optional, defaults 0 0 0)
 *   DOMAIN_MAX r g b              (optional, defaults 1 1 1)
 *   <N³ lines of "r g b">         (floats 0..1, RED fastest, then green, then blue)
 *
 * The row order (red fastest) is EXACTLY the memory order a `Data3DTexture`
 * wants (x=r fastest, then y=g, then z=b), so no reshuffle — the parsed array
 * uploads directly. Stated because getting that order wrong is a LUT that looks
 * plausibly-but-subtly wrong, the worst kind (feedback_instruments_must_not_lie).
 *
 * Pure: string in, plain object out. No THREE, no fetch — the caller reads the
 * file and builds the `Data3DTexture` (that lives in vt/, the GPU zone).
 *
 * @module effects/grade/lut-cube
 */

/**
 * @typedef {object} ParsedCubeLut
 * @property {number} size - the cube edge N (LUT_3D_SIZE).
 * @property {Float32Array} data - N³·4 RGBA floats, red-fastest, alpha = 1.
 * @property {[number,number,number]} domainMin
 * @property {[number,number,number]} domainMax
 * @property {string} title
 */

/**
 * Parse a `.cube` file's text into GPU-ready RGBA float data.
 *
 * Throws (loudly) on a malformed cube rather than returning a half-parsed LUT: a
 * silently-truncated LUT would sample garbage past its filled rows, and a
 * creative look that is subtly wrong everywhere is far harder to notice than a
 * clean "this file is not a valid cube" at load. The caller (vt/) turns the
 * throw into a logged fallback to no-LUT, exactly as the outdoors bake does.
 *
 * @param {string} text
 * @returns {ParsedCubeLut}
 */
export function parseCubeLut(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('parseCubeLut: empty or non-string input');
  }

  let size = 0;
  let title = '';
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  /** @type {number[]} flat r,g,b triples in file order */
  const triples = [];

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const upper = line.toUpperCase();
    if (upper.startsWith('TITLE')) {
      const m = line.match(/"([^"]*)"/);
      title = m ? m[1] : line.slice(5).trim();
      continue;
    }
    if (upper.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (upper.startsWith('LUT_1D_SIZE')) {
      // A 1D LUT is a per-channel curve, not a 3D colour cube. Reject rather
      // than mis-parse it as 3D — they are different textures with different
      // sampling. (A 1D-LUT path is a later, separate rung — Grade.md §10.)
      throw new Error('parseCubeLut: LUT_1D_SIZE is a 1D curve, not a 3D cube — not supported here');
    }
    if (upper.startsWith('DOMAIN_MIN')) {
      domainMin = readTriple(line, 'DOMAIN_MIN');
      continue;
    }
    if (upper.startsWith('DOMAIN_MAX')) {
      domainMax = readTriple(line, 'DOMAIN_MAX');
      continue;
    }

    // A data row: three floats.
    const parts = line.split(/\s+/);
    if (parts.length !== 3) {
      throw new Error(`parseCubeLut: expected 3 numbers per data row, got ${parts.length}: "${line}"`);
    }
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      throw new Error(`parseCubeLut: non-numeric data row "${line}"`);
    }
    triples.push(r, g, b);
  }

  if (!(size > 1)) throw new Error(`parseCubeLut: missing or invalid LUT_3D_SIZE (${size})`);
  const expected = size * size * size;
  if (triples.length / 3 !== expected) {
    throw new Error(`parseCubeLut: LUT_3D_SIZE ${size} needs ${expected} rows, found ${triples.length / 3}`);
  }

  // Expand to RGBA (Data3DTexture wants 4 components); file order is already
  // red-fastest = the texture's own memory order, so a straight copy.
  const data = new Float32Array(expected * 4);
  for (let i = 0; i < expected; i++) {
    data[i * 4 + 0] = triples[i * 3 + 0];
    data[i * 4 + 1] = triples[i * 3 + 1];
    data[i * 4 + 2] = triples[i * 3 + 2];
    data[i * 4 + 3] = 1;
  }

  return { size, data, domainMin, domainMax, title };
}

/**
 * The identity 3D LUT of a given size — every cell maps a colour to itself.
 * A sampled identity LUT is a mathematical no-op, so it is what a "no LUT"
 * slot resolves to when the code needs a texture to exist (and it is the
 * cleanest thing to test a sampler against: identity in, identity out).
 * @param {number} size @returns {ParsedCubeLut}
 */
export function identityCubeLut(size = 2) {
  const n = Math.max(2, size | 0);
  const data = new Float32Array(n * n * n * 4);
  let i = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        data[i++] = r / (n - 1);
        data[i++] = g / (n - 1);
        data[i++] = b / (n - 1);
        data[i++] = 1;
      }
    }
  }
  return { size: n, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: 'identity' };
}

/** @param {string} line @param {string} key @returns {[number,number,number]} */
function readTriple(line, key) {
  const parts = line.slice(key.length).trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`parseCubeLut: malformed ${key} "${line}"`);
  }
  return [parts[0], parts[1], parts[2]];
}
