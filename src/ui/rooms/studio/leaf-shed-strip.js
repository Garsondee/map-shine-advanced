/**
 * FALLING LEAVES & TWIGS — the design strip at the top of its Studio card.
 *
 * The author, 2026-10-31: "give me a way to select the leaves I want to drop. This means having visual
 * buttons to show each leaf design … if we place these previews alongside the controls which change their
 * visuals, … as you change the sliders we can update the leaf shapes in the previews for easy before/after
 * comparison."
 *
 *   • One button per design (`effects/leaf-shed-preview.js#SHED_DESIGNS`), drawn by the shader's own shape
 *     code on the CPU; pressing it toggles that design's `drop…` param for this map.
 *   • The strip sticks to the top of the card while the sliders below scroll past, and redraws as they move:
 *     a quick coarse pass first, then the full one.
 *   • Hold "Compare" to see the same designs at the default settings — the before to the sliders' after.
 *
 * The drawing runs in a worker; if one cannot start, it falls back to the main thread, one design per tick.
 *
 * @module ui/rooms/studio/leaf-shed-strip
 */

import { SHED_DESIGNS, renderShedPreview } from '../../../effects/index.js';

const FINE_PX = 48;
const COARSE_PX = 20;
/** How often the strip looks for a moved slider, ms. Cheap: a string compare. */
const POLL_MS = 150;

let worker = null;
let workerFailed = false;
function getWorker() {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('../../../effects/leaf-shed-preview.worker.js', import.meta.url), { type: 'module' });
  } catch (_) {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

/** Default renders, shared by every strip (they never change). */
const defaultImages = new Map();

/**
 * @param {object} o
 * @param {() => object} o.getParams - the effect's live params.
 * @param {(key: string, value: boolean) => void} o.setParam
 * @returns {HTMLElement}
 */
export function buildLeafShedStrip({ getParams, setParam }) {
  const root = document.createElement('div');
  root.className = 'msa-leafstrip';
  Object.assign(root.style, {
    position: 'sticky',
    top: '0px',
    zIndex: '3',
    padding: '8px 0 10px',
    margin: '0 0 6px',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  });
  const head = document.createElement('div');
  Object.assign(head.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' });
  const title = document.createElement('span');
  title.textContent = 'Which leaves drop';
  Object.assign(title.style, { fontWeight: '600', fontSize: '12px', opacity: '0.85' });
  const hint = document.createElement('span');
  hint.textContent = 'click to allow or forbid · pictures follow the sliders';
  Object.assign(hint.style, { fontSize: '11px', opacity: '0.55', flex: '1' });
  const compare = document.createElement('button');
  compare.type = 'button';
  compare.className = 'msa-chip';
  compare.textContent = 'Hold: compare';
  compare.title = 'Hold to see these designs at the default settings; let go to see your settings again.';
  head.append(title, hint, compare);

  const grid = document.createElement('div');
  Object.assign(grid.style, { display: 'grid', gridTemplateColumns: `repeat(${SHED_DESIGNS.length}, 1fr)`, gap: '4px' });
  /** @type {Map<string, {btn: HTMLButtonElement, canvas: HTMLCanvasElement}>} */
  const cells = new Map();
  for (const d of SHED_DESIGNS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.msaDesign = d.id;
    Object.assign(btn.style, {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '2px',
      padding: '4px 2px 3px',
      borderRadius: '8px',
      border: '1px solid rgba(255,255,255,0.14)',
      background: 'rgba(0,0,0,0.28)',
      cursor: 'pointer',
      color: 'inherit',
      position: 'relative',
      // The card's own button rule is a one-line control height; a picture button needs its own.
      height: 'auto',
      minHeight: '0',
      lineHeight: '1',
      overflow: 'visible',
    });
    const canvas = document.createElement('canvas');
    canvas.width = FINE_PX;
    canvas.height = FINE_PX;
    Object.assign(canvas.style, { display: 'block', width: '48px', height: '48px', flex: '0 0 auto' });
    const label = document.createElement('span');
    label.textContent = d.label;
    Object.assign(label.style, { fontSize: '10px', lineHeight: '1.1', whiteSpace: 'nowrap' });
    btn.append(canvas, label);
    btn.addEventListener('click', () => {
      const on = getParams()?.[d.param] !== false;
      setParam(d.param, !on);
      paintToggles();
    });
    grid.append(btn);
    cells.set(d.id, { btn, canvas });
  }
  root.append(head, grid);

  function paintToggles() {
    const p = getParams() ?? {};
    for (const d of SHED_DESIGNS) {
      const { btn, canvas } = cells.get(d.id);
      const on = p[d.param] !== false;
      btn.setAttribute('aria-pressed', String(on));
      btn.title = `${d.label}: ${on ? 'drops on this map — click to forbid' : 'never drops on this map — click to allow'}`;
      btn.style.borderColor = on ? 'var(--acc, rgba(160,200,255,0.7))' : 'rgba(255,255,255,0.10)';
      canvas.style.opacity = on ? '1' : '0.28';
      btn.style.textDecoration = on ? 'none' : 'line-through';
    }
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  let showingDefaults = false;
  /** @type {Map<string, ImageData>} the latest picture of each design at the current settings */
  const current = new Map();
  function put(designId, img) {
    const c = cells.get(designId)?.canvas;
    if (!c) return;
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    if (img.width === c.width) {
      g.putImageData(img, 0, 0);
    } else {
      const tmp = document.createElement('canvas');
      tmp.width = img.width;
      tmp.height = img.height;
      tmp.getContext('2d').putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true;
      g.drawImage(tmp, 0, 0, c.width, c.height);
    }
  }
  function show(designId) {
    const img = showingDefaults ? defaultImages.get(designId) : current.get(designId);
    if (img) put(designId, img);
  }

  /** @type {Array<{designId: string, size: number, params: object, target: 'current'|'default'}>} */
  let queue = [];
  let busy = false;
  let jobSeq = 0;
  let liveJob = 0;
  function land(job, designId, size, px) {
    const img = new ImageData(new Uint8ClampedArray(px), size, size);
    if (job.target === 'default') {
      defaultImages.set(designId, img);
    } else {
      current.set(designId, img);
    }
    show(designId);
  }
  function pump() {
    if (busy || !root.isConnected || queue.length === 0) return;
    const job = queue.shift();
    busy = true;
    const id = ++jobSeq;
    liveJob = id;
    const w = getWorker();
    if (w) {
      w.onmessage = (e) => {
        const d = e.data || {};
        if (d.job !== liveJob) return;
        busy = false;
        if (!d.error && d.px) land(job, d.designId, d.size, d.px);
        pump();
      };
      w.onerror = () => {
        workerFailed = true;
        worker = null;
        busy = false;
        queue.unshift(job);
        pump();
      };
      w.postMessage({ job: id, designId: job.designId, params: job.params, size: job.size });
    } else {
      setTimeout(() => {
        busy = false;
        if (!root.isConnected) return;
        land(job, job.designId, job.size, renderShedPreview(job.designId, job.params, job.size));
        pump();
      }, 0);
    }
  }
  function plan(params) {
    const plain = { ...params };
    const jobs = [];
    for (const d of SHED_DESIGNS) jobs.push({ designId: d.id, size: COARSE_PX, params: plain, target: 'current' });
    for (const d of SHED_DESIGNS) jobs.push({ designId: d.id, size: FINE_PX, params: plain, target: 'current' });
    for (const d of SHED_DESIGNS)
      if (!defaultImages.has(d.id)) jobs.push({ designId: d.id, size: FINE_PX, params: {}, target: 'default' });
    queue = jobs;
    pump();
  }

  compare.addEventListener('pointerdown', () => {
    showingDefaults = true;
    compare.setAttribute('aria-pressed', 'true');
    for (const d of SHED_DESIGNS) show(d.id);
  });
  const release = () => {
    if (!showingDefaults) return;
    showingDefaults = false;
    compare.setAttribute('aria-pressed', 'false');
    for (const d of SHED_DESIGNS) show(d.id);
  };
  compare.addEventListener('pointerup', release);
  compare.addEventListener('pointerleave', release);

  // ── follow the sliders ────────────────────────────────────────────────────
  let lastSig = '';
  const tick = () => {
    if (!root.isConnected) {
      // Built but not yet mounted: wait a moment; gone for good after it was mounted: stop.
      if (mounted) clearInterval(timer);
      return;
    }
    if (!mounted) {
      mounted = true;
      // Sit under the card's sticky jump bar, on the card's own background.
      const card = root.closest('.msa-card');
      const jump = card?.querySelector('.msa-jump');
      if (jump) root.style.top = `${jump.offsetHeight}px`;
      if (card) root.style.background = getComputedStyle(card).backgroundColor || 'rgba(20,22,28,0.96)';
    }
    const p = getParams() ?? {};
    paintToggles();
    // Only the look redraws the pictures: the drop toggles change nothing in them.
    const look = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('drop')));
    const sig = JSON.stringify(look);
    if (sig === lastSig) return;
    lastSig = sig;
    plan(look);
  };
  let mounted = false;
  const timer = setInterval(tick, POLL_MS);
  queueMicrotask(tick);
  return root;
}
