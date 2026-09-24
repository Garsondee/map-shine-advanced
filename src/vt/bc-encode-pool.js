/**
 * BC ENCODE POOL (2026-09-24, perf goal attempt 1) — the `pool` that
 * `block-compress.js#encodeStripedParallel` hands strips to. Created lazily by
 * the BC-compress worker (nested dedicated workers), one per spare core up to
 * `BC_ENCODE_POOL_MAX`.
 *
 * DEGRADATION-FIRST, like everything else on the compression path: if nested
 * workers cannot be constructed here, `createBcEncodePool` returns `null` and
 * the caller keeps the serial `encodeStriped`; if a pool worker errors, that
 * job rejects and the whole texture falls back to the serial path (the caller's
 * job) — never a half-encoded texture.
 */

/** Cap on pool workers: 4 measured strips in flight already overlap readback
 * with encode; more mostly competes with the decode/mask workers and the
 * main thread for the same cores during a load. */
export const BC_ENCODE_POOL_MAX = 4;

/** How many encoder workers to use for `hardwareConcurrency` logical cores:
 * leave two for the main thread and the compress worker itself. */
export function bcEncodePoolSize(hardwareConcurrency) {
  const hc = Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : 4;
  return Math.max(0, Math.min(BC_ENCODE_POOL_MAX, hc - 2));
}

/**
 * @param {number} size
 * @param {() => Worker} makeWorker
 * @returns {{ encode:(strip:Uint8Array,width:number,h:number,format:string)=>Promise<Uint8Array>, size:number, terminate:()=>void }|null}
 */
export function createBcEncodePool(size, makeWorker) {
  if (!(size >= 1)) return null;
  const workers = [];
  try {
    for (let i = 0; i < size; i++) workers.push(makeWorker());
  } catch {
    for (const w of workers) w.terminate?.();
    return null;
  }
  const pending = new Map();
  const idle = [...workers];
  const queue = [];
  let nextId = 1;
  let live = workers.length;

  const pump = () => {
    while (idle.length && queue.length) {
      const w = idle.pop();
      const job = queue.shift();
      job.worker = w;
      pending.set(job.id, job);
      w.postMessage({ id: job.id, strip: job.strip.buffer, width: job.width, h: job.h, format: job.format }, [
        job.strip.buffer,
      ]);
    }
  };
  for (const w of workers) {
    w.onmessage = (e) => {
      const { id, blocks, error } = e.data || {};
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      idle.push(job.worker);
      if (error || !blocks) job.reject(new Error(error || 'bc-encode worker returned no blocks'));
      else job.resolve(new Uint8Array(blocks));
      pump();
    };
    w.onerror = (ev) => {
      // A worker that dies takes its in-flight job with it; reject that job so
      // the caller falls back, and do not return the worker to the idle list.
      ev?.preventDefault?.();
      live--;
      for (const [id, job] of pending) {
        if (job.worker === w) {
          pending.delete(id);
          job.reject(new Error(`bc-encode worker error: ${ev?.message || 'unknown'}`));
        }
      }
      // With no workers left, queued jobs would wait forever — fail them now.
      if (live <= 0) for (const job of queue.splice(0)) job.reject(new Error('bc-encode pool: every worker died'));
    };
  }

  return {
    size,
    encode(strip, width, h, format) {
      if (live <= 0) return Promise.reject(new Error('bc-encode pool: every worker died'));
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, strip, width, h, format, resolve, reject, worker: null });
        pump();
      });
    },
    terminate() {
      for (const w of workers) w.terminate?.();
      for (const [, job] of pending) job.reject(new Error('bc-encode pool terminated'));
      pending.clear();
      for (const job of queue.splice(0)) job.reject(new Error('bc-encode pool terminated'));
    },
  };
}
