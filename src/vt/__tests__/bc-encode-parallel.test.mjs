/**
 * Perf goal attempt 1 (2026-09-24): parallel BC strip encode.
 * LOAD-BEARING: encodeStripedParallel is BYTE-IDENTICAL to the serial
 * encodeStriped (which is itself proven identical to a whole-image encode in
 * block-compress.test.mjs), so parallelism changes time, never pixels.
 */
import { encodeStriped, encodeStripedParallel, encodeBC1, encodeBC7 } from '../block-compress.js';
import { createBcEncodePool, bcEncodePoolSize, BC_ENCODE_POOL_MAX } from '../bc-encode-pool.js';

function makeImage(w, h, seed = 7) {
  const rgba = new Uint8Array(w * h * 4);
  let s = seed;
  for (let i = 0; i < rgba.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    if (i % 4 === 3) rgba[i] = (s >> 8) % 3 === 0 ? 0 : 255 - ((s >> 4) & 63);
    else rgba[i] = (s >> 8) & 255;
  }
  return rgba;
}
const stripsOf = (rgba, w) => (y, h) => rgba.subarray(y * w * 4, (y + h) * w * 4);
const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Synchronous-encode pool that resolves OUT OF ORDER (later strips first). */
function fakePool({ failAt = -1, seen = [] } = {}) {
  let n = 0;
  return {
    size: 3,
    encode(strip, width, h, format) {
      const k = n++;
      seen.push(strip);
      const blocks = format === 'bc7' ? encodeBC7(strip, width, h) : encodeBC1(strip, width, h);
      return new Promise((resolve, reject) =>
        setTimeout(() => (k === failAt ? reject(new Error('boom')) : resolve(blocks)), (7 - (k % 7)) * 2)
      );
    },
  };
}

export async function run(t) {
  const { ok } = t;

  // ---- byte identity vs the serial driver --------------------------------
  const cases = [
    [16, 40, 8, 'bc7'],
    [16, 40, 8, 'bc1'],
    [20, 43, 8, 'bc7'], // final partial band (43 rows)
    [18, 37, 12, 'bc1'], // width and height not multiples of 4
    [16, 40, 4096, 'bc7'], // single band
  ];
  for (const [w, h, step, fmt] of cases) {
    const img = makeImage(w, h, w * 31 + h);
    const serial = encodeStriped(stripsOf(img, w), w, h, fmt, step);
    const par = await encodeStripedParallel(stripsOf(img, w), w, h, fmt, step, fakePool(), 3);
    ok(`parallel == serial (${fmt} ${w}x${h} step ${step}, out-of-order completion)`, bytesEqual(par, serial));
  }

  // ---- view strips are COPIED; owned strips go zero-copy -------------------
  {
    const w = 16;
    const h = 40;
    const img = makeImage(w, h, 3);
    const seen = [];
    await encodeStripedParallel(stripsOf(img, w), w, h, 'bc7', 8, fakePool({ seen }), 3);
    ok(
      'view strips are copied into their own buffers',
      seen.every((s) => s.buffer !== img.buffer && s.byteOffset === 0)
    );
    const owned = [];
    const got = [];
    const pool = {
      size: 2,
      encode: (strip, ww, hh) => {
        got.push(strip);
        return Promise.resolve(encodeBC7(strip, ww, hh));
      },
    };
    const reader = (y, hh) => {
      const s = new Uint8Array(img.subarray(y * w * 4, (y + hh) * w * 4)); // fresh buffer, like getImageData
      owned.push(s);
      return s;
    };
    await encodeStripedParallel(reader, w, h, 'bc7', 8, pool, 2);
    ok('owned strips go zero-copy', got.every((s, i) => s.buffer === owned[i].buffer));
  }

  // ---- a failed strip rejects the whole encode, cleanly --------------------
  {
    const w = 16;
    const h = 40;
    const img = makeImage(w, h, 5);
    let unhandled = 0;
    const onUnhandled = () => unhandled++;
    process.on('unhandledRejection', onUnhandled);
    let threw = null;
    try {
      await encodeStripedParallel(stripsOf(img, w), w, h, 'bc1', 8, fakePool({ failAt: 1 }), 3);
    } catch (e) {
      threw = e;
    }
    await new Promise((r) => setTimeout(r, 40));
    process.off('unhandledRejection', onUnhandled);
    ok('a failed strip rejects the encode', threw?.message === 'boom');
    ok('...with no unhandled rejections left behind', unhandled === 0);
  }
  {
    const w = 16;
    const h = 40;
    const img = makeImage(w, h, 5);
    const badPool = { size: 1, encode: () => Promise.resolve(new Uint8Array(3)) };
    let threw = null;
    try {
      await encodeStripedParallel(stripsOf(img, w), w, h, 'bc7', 8, badPool, 1);
    } catch (e) {
      threw = e;
    }
    ok('a wrong-sized strip result is rejected, never stitched in', /came back 3 bytes/.test(threw?.message ?? ''));
  }

  // ---- pool sizing ----------------------------------------------------------
  ok('16 cores -> capped pool', bcEncodePoolSize(16) === BC_ENCODE_POOL_MAX);
  ok('4 cores -> 2 encoders', bcEncodePoolSize(4) === 2);
  ok('2 cores -> 0 (serial)', bcEncodePoolSize(2) === 0);
  ok('unknown cores -> 2', bcEncodePoolSize(undefined) === 2);

  // ---- pool mechanics with fake workers -------------------------------------
  const makeFakeWorker = () => ({
    posted: [],
    postMessage(msg) {
      this.posted.push(msg);
    },
    terminate() {
      this.terminated = true;
    },
    reply(msg) {
      this.onmessage({ data: msg });
    },
    die() {
      this.onerror({ message: 'crash', preventDefault() {} });
    },
  });
  ok('size 0 pool is null (serial path)', createBcEncodePool(0, makeFakeWorker) === null);
  {
    let made = 0;
    const built = [];
    const pool = createBcEncodePool(3, () => {
      if (made++ === 1) throw new Error('no nested workers');
      const w = makeFakeWorker();
      built.push(w);
      return w;
    });
    ok('construction failure -> null', pool === null);
    ok('...and the workers already made are terminated', built.every((w) => w.terminated));
  }
  {
    const ws = [];
    const pool = createBcEncodePool(2, () => {
      const w = makeFakeWorker();
      ws.push(w);
      return w;
    });
    const p1 = pool.encode(new Uint8Array(64), 4, 4, 'bc1');
    const p2 = pool.encode(new Uint8Array(64), 4, 4, 'bc1');
    const p3 = pool.encode(new Uint8Array(64), 4, 4, 'bc1');
    const postedCount = () => ws.reduce((n, w) => n + w.posted.length, 0);
    ok('two workers take two jobs, the third queues', postedCount() === 2);
    const first = ws.find((w) => w.posted.length);
    first.reply({ id: first.posted[0].id, blocks: new Uint8Array(8).buffer });
    ok('a finished worker picks up the queued job', postedCount() === 3);
    const firstDone = await Promise.race([p1, p2]);
    ok('the finished job resolves with its blocks', firstDone?.length === 8);
    for (const w of ws) w.die();
    const settled = await Promise.allSettled([p1, p2, p3]);
    ok('dead workers reject their in-flight jobs', settled.filter((s) => s.status === 'rejected').length === 2);
    const late = await pool.encode(new Uint8Array(64), 4, 4, 'bc1').then(
      () => 'resolved',
      (e) => e.message
    );
    ok('with every worker dead, new jobs reject instead of hanging', /every worker died/.test(late));
  }
}
