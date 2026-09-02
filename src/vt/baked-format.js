/**
 * @fileoverview vt/baked-format.js — the binary container for a build-time
 * pre-baked BC1/BC7 texture (mythica-machina-press#439: bake once at module-
 * build time instead of encoding in every player's browser). Pure codec, no
 * fetch, no DOM — Node-testable like every other file in this directory.
 *
 * WHY A CUSTOM CONTAINER RATHER THAN REAL KTX2 (for now): #439's own research
 * recommends KTX2 for the shipped feature, since Foundry v14 already speaks it
 * natively (`client/canvas/ktx2-parser.mjs`, `libktx.wasm`) and a customer
 * without MSA installed still benefits. This file is the proof-of-concept
 * codec instead: a correct, spec-compliant KTX2 writer (DFD blocks, level
 * index, supercompression global data) is real work with real ways to get
 * subtly wrong, and this environment has no independent KTX2 parser to check
 * output against. This format is deliberately small enough to read at a
 * glance and round-trip-test exhaustively — see `__tests__/baked-format.test.mjs`.
 * Migrating the shipped feature to real KTX2 is tracked as 439's own follow-up,
 * not silently deferred.
 *
 * THE CONTRACT: `decodeSidecar()`'s return shape is exactly the shape
 * `bc-compress.worker.js#handle()` already returns from a live encode —
 * `{format, width, height, levels:[{width,height,blocks}], alphaStats,
 * alphaMinGrid}` — so a caller holding a decoded sidecar and a caller holding
 * a fresh encode are interchangeable. `vt-pan-viewer.js` never needs to know
 * which one it got.
 *
 * COMPRESSION: the Compression Streams API (`CompressionStream`/
 * `DecompressionStream`), not `node:zlib` — that keeps this ONE file correct
 * for both the Node-side baker (mythica-machina-press/scripts/bake-textures.mjs)
 * and the browser-side loader (baked-textures.js), by construction, rather
 * than by two independent implementations staying in sync by discipline.
 * `'deflate'` (zlib-wrapped), not `'deflate-raw'`: verified directly against
 * this project's Node version (18.16) — `'deflate-raw'` throws
 * ERR_INVALID_ARG_VALUE there, while `'deflate'` round-trips correctly on both
 * Node 18 and the Chrome this project ships against. The ~6 zlib-header/
 * Adler32 bytes this costs per file are noise next to a multi-megabyte block
 * buffer.
 *
 * FILE LAYOUT (little-endian throughout):
 *   offset  0   u32  magic (MAGIC below)
 *   offset  4   u8   formatId (1 = bc1, 2 = bc7)
 *   offset  5   u8   compressed (0 or 1)
 *   offset  6   u16  levelCount
 *   offset  8   u32  width         — LOGICAL level-0 width (pre block-padding)
 *   offset 12   u32  height        — LOGICAL level-0 height
 *   offset 16   i32  alphaMin
 *   offset 20   i32  alphaMax
 *   offset 24   f64  alphaMean     (-1 sentinel ⇒ null, texelCount was 0)
 *   offset 32   u32  alphaGridW
 *   offset 36   u32  alphaGridH
 *   offset 40   u32  payloadByteLength — length of the trailing payload AS
 *                     STORED (the compressed length if compressed=1, else the
 *                     raw concatenated length)
 *   offset 44   level table: levelCount × (u32 width, u32 height) — each
 *                     level's own BLOCK-PADDED size (a multiple of 4), the
 *                     same convention `computeMipChainDims` already uses.
 *                     A level's byte length is DERIVED from this pair (never
 *                     stored) via `bc1ByteLength`/`bc7ByteLength` — one source
 *                     of truth for that arithmetic, shared with the encoder.
 *   HEADER_END  payload bytes (payloadByteLength bytes). Once inflated (if
 *                     compressed), this is: level[0].blocks ++ level[1].blocks
 *                     ++ ... ++ level[n-1].blocks ++ alphaMinGrid.data — sliced
 *                     back apart using the level table's sizes and
 *                     alphaGridW×alphaGridH, in that fixed order.
 *
 * WHY EACH LEVEL GETS ITS OWN COPY ON DECODE, NOT A SUBARRAY VIEW: the browser
 * loader hands `levels[i].blocks` to `Worker#postMessage`'s TRANSFER list
 * (`bc-compress.worker.js`'s own contract — transferring detaches the buffer).
 * Two subarray views sharing one big inflated ArrayBuffer cannot each be
 * transferred independently — the first transfer would detach the buffer out
 * from under the second view. `TypedArray#slice()` (never `#subarray()`)
 * allocates an independent backing buffer per level, so each is safe to
 * transfer on its own. Cheap: total sidecar payloads are a few MB at most.
 */
import { bc1ByteLength, bc7ByteLength } from './block-compress.js';

const MAGIC = 0x3141534d; // ASCII "MSA1", read as a little-endian u32
const HEADER_FIXED_SIZE = 44;
const FORMAT_IDS = { bc1: 1, bc7: 2 };
const FORMAT_NAMES = { 1: 'bc1', 2: 'bc7' };

function levelByteLength(width, height, formatId) {
  return formatId === FORMAT_IDS.bc7 ? bc7ByteLength(width, height) : bc1ByteLength(width, height);
}

/** Normalize any TypedArray/ArrayBuffer input to a Uint8Array VIEW (no copy). */
function toUint8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new Error('baked-format: expected a Uint8Array, ArrayBuffer, or typed array view');
}

async function pipeThroughStream(bytes, StreamCtor, format) {
  const stream = new Response(bytes).body.pipeThrough(new StreamCtor(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(bytes) {
  return pipeThroughStream(bytes, CompressionStream, 'deflate');
}

async function inflate(bytes) {
  return pipeThroughStream(bytes, DecompressionStream, 'deflate');
}

/**
 * Pack one baked texture into the on-disk/on-wire sidecar format.
 *
 * @param {object} args
 * @param {'bc1'|'bc7'} args.format
 * @param {number} args.width - LOGICAL level-0 width (pre block-padding).
 * @param {number} args.height - LOGICAL level-0 height.
 * @param {Array<{width:number, height:number, blocks:Uint8Array|ArrayBuffer}>} args.levels
 *   - each `width`/`height` is that level's own BLOCK-PADDED size (a multiple
 *   of 4) — `computeMipChainDims`'s own convention — and `blocks` its exact
 *   `bc1ByteLength`/`bc7ByteLength` bytes.
 * @param {{min:number, max:number, mean:number|null}} args.alphaStats
 * @param {{w:number, h:number, data:Uint8Array}|null} [args.alphaMinGrid]
 * @param {boolean} [args.compress=true]
 * @returns {Promise<Uint8Array>}
 */
export async function encodeSidecar({
  format,
  width,
  height,
  levels,
  alphaStats,
  alphaMinGrid = null,
  compress = true,
}) {
  const formatId = FORMAT_IDS[format];
  if (!formatId) throw new Error(`encodeSidecar: bad format "${format}" (expected "bc1" or "bc7")`);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`encodeSidecar: bad logical size ${width}x${height}`);
  }
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new Error('encodeSidecar: levels must be a non-empty array');
  }
  if (levels.length > 0xffff) throw new Error(`encodeSidecar: too many levels (${levels.length})`);

  const levelBytes = levels.map((lvl, i) => {
    if (lvl.width % 4 !== 0 || lvl.height % 4 !== 0) {
      throw new Error(
        `encodeSidecar: level ${i} size ${lvl.width}x${lvl.height} is not block-padded (must be a multiple of 4)`
      );
    }
    const bytes = toUint8(lvl.blocks);
    const expected = levelByteLength(lvl.width, lvl.height, formatId);
    if (bytes.length !== expected) {
      throw new Error(
        `encodeSidecar: level ${i} (${lvl.width}x${lvl.height}) has ${bytes.length} block bytes, expected ${expected}`
      );
    }
    return bytes;
  });

  const gridW = alphaMinGrid?.w ?? 0;
  const gridH = alphaMinGrid?.h ?? 0;
  const gridData = alphaMinGrid ? toUint8(alphaMinGrid.data) : new Uint8Array(0);
  if (gridW * gridH !== gridData.length) {
    throw new Error(`encodeSidecar: alphaMinGrid is ${gridW}x${gridH} but data.length is ${gridData.length}`);
  }

  const rawParts = [...levelBytes, gridData];
  const rawTotalLen = rawParts.reduce((n, p) => n + p.length, 0);
  const raw = new Uint8Array(rawTotalLen);
  {
    let off = 0;
    for (const p of rawParts) {
      raw.set(p, off);
      off += p.length;
    }
  }

  const payload = compress ? await deflate(raw) : raw;

  const headerSize = HEADER_FIXED_SIZE + levels.length * 8;
  const out = new Uint8Array(headerSize + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  out[4] = formatId;
  out[5] = compress ? 1 : 0;
  view.setUint16(6, levels.length, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setInt32(16, alphaStats?.min ?? 255, true);
  view.setInt32(20, alphaStats?.max ?? 255, true);
  view.setFloat64(24, alphaStats?.mean ?? -1, true);
  view.setUint32(32, gridW, true);
  view.setUint32(36, gridH, true);
  view.setUint32(40, payload.length, true);
  let tOff = HEADER_FIXED_SIZE;
  for (const lvl of levels) {
    view.setUint32(tOff, lvl.width, true);
    tOff += 4;
    view.setUint32(tOff, lvl.height, true);
    tOff += 4;
  }
  out.set(payload, headerSize);
  return out;
}

/**
 * Unpack a sidecar produced by {@link encodeSidecar}. Throws on a malformed or
 * truncated buffer — callers at the edge of the system (the loader) are
 * expected to catch and fall through to a fresh encode, per this whole
 * pipeline's degradation-first posture; this function itself stays strict so
 * a real corruption is never silently misread as an empty texture.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Promise<{format:'bc1'|'bc7', width:number, height:number,
 *   levels:Array<{width:number,height:number,blocks:ArrayBuffer}>,
 *   alphaStats:{min:number,max:number,mean:number|null},
 *   alphaMinGrid:{w:number,h:number,data:Uint8Array}|null}>}
 */
export async function decodeSidecar(input) {
  const bytes = toUint8(input);
  if (bytes.length < HEADER_FIXED_SIZE) throw new Error('decodeSidecar: buffer shorter than the fixed header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) throw new Error('decodeSidecar: bad magic — not an MSA baked sidecar file');
  const formatId = bytes[4];
  const format = FORMAT_NAMES[formatId];
  if (!format) throw new Error(`decodeSidecar: unknown formatId ${formatId}`);
  const compressed = bytes[5] === 1;
  const levelCount = view.getUint16(6, true);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const alphaMin = view.getInt32(16, true);
  const alphaMax = view.getInt32(20, true);
  const alphaMeanRaw = view.getFloat64(24, true);
  const gridW = view.getUint32(32, true);
  const gridH = view.getUint32(36, true);
  const payloadLen = view.getUint32(40, true);

  const tableEnd = HEADER_FIXED_SIZE + levelCount * 8;
  if (bytes.length < tableEnd) throw new Error('decodeSidecar: buffer truncated inside the level table');
  const levelDims = [];
  {
    let off = HEADER_FIXED_SIZE;
    for (let i = 0; i < levelCount; i++) {
      const w = view.getUint32(off, true);
      const h = view.getUint32(off + 4, true);
      levelDims.push({ width: w, height: h });
      off += 8;
    }
  }

  const payloadStart = tableEnd;
  if (bytes.length < payloadStart + payloadLen) throw new Error('decodeSidecar: buffer truncated inside the payload');
  const payloadBytes = bytes.subarray(payloadStart, payloadStart + payloadLen);
  const raw = compressed ? await inflate(payloadBytes) : payloadBytes;

  const levels = [];
  let roff = 0;
  for (const d of levelDims) {
    const len = levelByteLength(d.width, d.height, formatId);
    if (roff + len > raw.length) {
      throw new Error(`decodeSidecar: payload too short for level ${d.width}x${d.height} (need ${len} more bytes)`);
    }
    levels.push({ width: d.width, height: d.height, blocks: raw.slice(roff, roff + len).buffer });
    roff += len;
  }

  let alphaMinGrid = null;
  if (gridW > 0 && gridH > 0) {
    const gridLen = gridW * gridH;
    if (roff + gridLen > raw.length) throw new Error('decodeSidecar: payload too short for the alpha-min grid');
    alphaMinGrid = { w: gridW, h: gridH, data: raw.slice(roff, roff + gridLen) };
    roff += gridLen;
  }

  return {
    format,
    width,
    height,
    levels,
    alphaStats: { min: alphaMin, max: alphaMax, mean: alphaMeanRaw < 0 ? null : alphaMeanRaw },
    alphaMinGrid,
  };
}
