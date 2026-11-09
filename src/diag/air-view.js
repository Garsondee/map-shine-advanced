/**
 * diag/air-view.js — THE WIND VIEW: see what the 3-D air is doing (2026-11-09, Lab · Air).
 *
 * Ingram's brief: "visualising it ... using the wind visualisation mode that you will create in order to see what wind
 * is doing ... We're requiring a 3D representation of that energy." A DOM canvas over the map, drawn from the air's
 * own numbers (`vt/air-runtime.js#latest`), so what you see IS the field the effects read:
 *
 *   - LAYER: arrows at one height (1-2 m by default), coloured by speed against the open wind at that height
 *     (deep blue still → pale = the open wind → orange/red faster), over a soft fill of one of three readings:
 *       speed  — the same colours;
 *       lift   — vertical air: warm rising, cool sinking (air climbing a windward face, falling into a lee);
 *       churn  — turbulence σ/U (a doorway's draft, a wake, a courtyard).
 *   - TRACERS: motes carried through the 3-D air, coloured by HEIGHT (blue low → gold high): a mote that climbs over a
 *     roof turns gold, and one that drops into the lee turns blue again.
 *   - SLICE: a side view along the wind through the middle of the screen (or the cursor): what goes over, what goes
 *     round, what stalls behind.
 *
 * Keys while it is on: Alt+↑/↓ height, Alt+M reading, Alt+T tracers, Alt+S slice, Alt+C slice follows the cursor.
 *
 * Diagnostic only: it owns its animation frame and reads the wall clock for its motes (diag/ may), never the world.
 *
 * @module diag/air-view
 */

const MODES = ['speed', 'lift', 'churn'];

/** Speed ratio → colour (matches tools/lab/air-bench.mjs). */
export function airSpeedColour(r) {
  const stops = [
    [0, [20, 30, 90]],
    [0.25, [40, 90, 170]],
    [0.6, [110, 180, 210]],
    [1.0, [235, 235, 225]],
    [1.3, [250, 180, 80]],
    [1.7, [220, 60, 40]],
    [2.2, [120, 0, 40]],
  ];
  const x = Math.max(0, Math.min(2.2, r));
  for (let s = 1; s < stops.length; s++) {
    if (x <= stops[s][0]) {
      const [a, ca] = stops[s - 1];
      const [b, cb] = stops[s];
      const t = (x - a) / (b - a);
      return ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
    }
  }
  return stops[stops.length - 1][1];
}
/** Height (m) → mote colour: blue near the ground, gold above a roof. */
export function airHeightColour(zM) {
  const t = Math.max(0, Math.min(1, zM / 10));
  return [Math.round(60 + 195 * t), Math.round(140 + 70 * t), Math.round(235 - 175 * t)];
}

/**
 * @param {object} a
 * @param {HTMLElement} a.host - the element the map canvas sits in.
 * @param {() => ({minX:number,minY:number,maxX:number,maxY:number}|null)} a.worldRect - the view's world rect.
 * @param {() => (object|null)} a.air - the runtime (`latest()`, `grid`, `stats()`).
 * @param {() => ({speedMps:number, directionDeg:number})} a.wind
 * @param {(on:boolean) => void} [a.wantLayers]
 */
export function createAirView({ host, worldRect, air, wind, wantLayers = () => {} }) {
  const opts = { layer: 1, mode: 'speed', tracers: true, slice: true, followCursor: false, fill: 0.35 };
  let on = false;
  let canvas = null;
  let ctx = null;
  let raf = 0;
  let lastT = 0;
  let cursor = null; // world point under the mouse
  const motes = [];

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.dataset.msaAirView = '1';
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '40',
    });
    host.appendChild(canvas);
    ctx = canvas.getContext('2d');
  }

  function onKey(e) {
    if (!on || !e.altKey) return;
    const g = air()?.grid;
    if (e.key === 'ArrowUp') opts.layer = Math.min((g?.nz ?? 9) - 1, opts.layer + 1);
    else if (e.key === 'ArrowDown') opts.layer = Math.max(0, opts.layer - 1);
    else if (e.key === 'm' || e.key === 'M') opts.mode = MODES[(MODES.indexOf(opts.mode) + 1) % MODES.length];
    else if (e.key === 't' || e.key === 'T') opts.tracers = !opts.tracers;
    else if (e.key === 's' || e.key === 'S') opts.slice = !opts.slice;
    else if (e.key === 'c' || e.key === 'C') opts.followCursor = !opts.followCursor;
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  function onMove(e) {
    const r = worldRect();
    if (!r || !canvas) return;
    const b = canvas.getBoundingClientRect();
    const fx = (e.clientX - b.left) / Math.max(1, b.width);
    const fy = (e.clientY - b.top) / Math.max(1, b.height);
    cursor = { x: r.minX + fx * (r.maxX - r.minX), y: r.minY + fy * (r.maxY - r.minY) };
  }

  /** Cell-centred sample of the whole box at (x px, y px, z m): {vx, vy, vz, k} or null. Trilinear in x, y; linear in z. */
  function sample3(snap, g, x, y, z) {
    if (!snap?.all) return null;
    const fx = (x - g.originX) / g.cellPx - 0.5;
    const fy = (y - g.originY) / g.cellPx - 0.5;
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
    const zc = [];
    for (let k = 0; k < g.nz; k++) zc.push(0.5 * (g.zb[k] + g.zb[k + 1]));
    let k0 = 0;
    while (k0 < g.nz - 2 && z >= zc[k0 + 1]) k0++;
    const tz = Math.max(0, Math.min(1, (z - zc[k0]) / (zc[k0 + 1] - zc[k0])));
    const i0 = Math.min(g.nx - 2, Math.floor(fx));
    const j0 = Math.min(g.ny - 2, Math.floor(fy));
    const tx = fx - i0;
    const ty = fy - j0;
    const NXY = g.nx * g.ny;
    const out = [0, 0, 0, 0];
    for (let q = 0; q < 4; q++) {
      const at = (k, j, i) => snap.all[(k * NXY + j * g.nx + i) * 4 + q];
      const lay = (k) =>
        (at(k, j0, i0) * (1 - tx) + at(k, j0, i0 + 1) * tx) * (1 - ty) +
        (at(k, j0 + 1, i0) * (1 - tx) + at(k, j0 + 1, i0 + 1) * tx) * ty;
      out[q] = lay(k0) * (1 - tz) + lay(k0 + 1) * tz;
    }
    return { vx: out[0], vy: out[1], vz: out[2], k: out[3] };
  }

  function draw(tNow) {
    raf = requestAnimationFrame(draw);
    const rt = air();
    const g = rt?.grid;
    const snap = rt?.latest?.();
    const r = worldRect();
    ensureCanvas();
    const dpr = globalThis.devicePixelRatio || 1;
    const W = Math.round(canvas.clientWidth * dpr);
    const H = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    ctx.clearRect(0, 0, W, H);
    const dt = lastT ? Math.min(0.1, (tNow - lastT) / 1000) : 0;
    lastT = tNow;
    if (!g || !snap || !r) {
      label(['Wind view — waiting for the air…']);
      return;
    }
    const { speedMps } = wind();
    const U = Math.max(0.1, speedMps);
    const sx = W / (r.maxX - r.minX);
    const sy = H / (r.maxY - r.minY);
    const toS = (x, y) => [(x - r.minX) * sx, (y - r.minY) * sy];
    const NXY = g.nx * g.ny;
    const k = Math.min(g.nz - 1, Math.max(0, opts.layer));
    const zMid = 0.5 * (g.zb[k] + g.zb[k + 1]);
    const prof = Math.log((zMid + 0.05) / 0.05) / Math.log(1.55 / 0.05);
    const layerArr = snap.all ? snap.all.subarray(k * NXY * 4, (k + 1) * NXY * 4) : k === 1 ? snap.ground : null;
    const cellS = g.cellPx * sx;
    // Fill + arrows (every cell, or fewer when zoomed out).
    if (layerArr) {
      const step = Math.max(1, Math.ceil(16 / Math.max(1, cellS)));
      const i0 = Math.max(0, Math.floor((r.minX - g.originX) / g.cellPx));
      const i1 = Math.min(g.nx, Math.ceil((r.maxX - g.originX) / g.cellPx));
      const j0 = Math.max(0, Math.floor((r.minY - g.originY) / g.cellPx));
      const j1 = Math.min(g.ny, Math.ceil((r.maxY - g.originY) / g.cellPx));
      const ref = U * prof;
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
          const c = j * g.nx + i;
          const vx = layerArr[c * 4];
          const vy = layerArr[c * 4 + 1];
          const vz = layerArr[c * 4 + 2];
          const kk = layerArr[c * 4 + 3];
          let col;
          if (opts.mode === 'speed') col = airSpeedColour(Math.hypot(vx, vy) / ref);
          else if (opts.mode === 'lift') {
            const t = Math.max(-1, Math.min(1, (vz / U) * 3));
            col =
              t >= 0
                ? [235, Math.round(235 - 120 * t), Math.round(225 - 190 * t)]
                : [Math.round(235 + 180 * t), Math.round(235 + 60 * t), 235];
          } else col = airSpeedColour((Math.sqrt((2 * kk) / 3) / U) * 4);
          const [px, py] = toS(g.originX + i * g.cellPx, g.originY + j * g.cellPx);
          ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${opts.fill})`;
          ctx.fillRect(px, py, cellS + 0.5, cellS + 0.5);
        }
      }
      ctx.lineWidth = Math.max(1, dpr);
      for (let j = j0; j < j1; j += step) {
        for (let i = i0; i < i1; i += step) {
          const c = j * g.nx + i;
          const vx = layerArr[c * 4] / ref;
          const vy = layerArr[c * 4 + 1] / ref;
          const L = Math.hypot(vx, vy);
          if (L < 0.03) continue;
          const col = airSpeedColour(L);
          const len = (Math.min(L, 2) / L) * Math.min(cellS * step * 0.45, 40 * dpr);
          const [cx, cy] = toS(g.originX + (i + 0.5) * g.cellPx, g.originY + (j + 0.5) * g.cellPx);
          arrow(
            cx - (vx * len) / 2,
            cy - (vy * len) / 2,
            vx * len,
            vy * len,
            `rgba(${col[0] * 0.35},${col[1] * 0.35},${col[2] * 0.35},0.9)`
          );
        }
      }
      // Walls at this height (closed faces), faint.
      ctx.fillStyle = 'rgba(10,10,20,0.55)';
      const NU = g.nx + 1;
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i <= i1 && i <= g.nx; i++) {
          const a = g.ax[(k * g.ny + j) * NU + i];
          if (a >= 0.5) continue;
          const [px, py] = toS(g.originX + i * g.cellPx, g.originY + j * g.cellPx);
          ctx.fillRect(px - dpr, py, 2 * dpr, cellS);
        }
      }
      for (let j = j0; j <= j1 && j <= g.ny; j++) {
        for (let i = i0; i < i1; i++) {
          const a = g.ay[(k * (g.ny + 1) + j) * g.nx + i];
          if (a >= 0.5) continue;
          const [px, py] = toS(g.originX + i * g.cellPx, g.originY + j * g.cellPx);
          ctx.fillRect(px, py - dpr, cellS, 2 * dpr);
        }
      }
    }
    // Tracers through the 3-D air.
    if (opts.tracers && snap.all) {
      const want = 900;
      while (motes.length < want) motes.push(spawnMote(r));
      ctx.lineWidth = 1.5 * dpr;
      for (let m = 0; m < motes.length; m++) {
        const p = motes[m];
        const s = sample3(snap, g, p.x, p.y, p.z);
        p.age += dt;
        if (!s || p.age > p.life || p.x < r.minX || p.x > r.maxX || p.y < r.minY || p.y > r.maxY) {
          motes[m] = spawnMote(r);
          continue;
        }
        const ppm = g.cellPx / g.h;
        const nx = p.x + s.vx * dt * ppm;
        const ny = p.y + s.vy * dt * ppm;
        const nz = Math.max(0.2, Math.min(g.zb[g.nz] - 0.5, p.z + s.vz * dt));
        // A mote never passes a wall: a closed face between its old and new cell kills it.
        if (crossesWall(g, p.x, p.y, nx, ny, nz)) {
          motes[m] = spawnMote(r);
          continue;
        }
        p.trail.push([nx, ny, nz]);
        if (p.trail.length > 14) p.trail.shift();
        p.x = nx;
        p.y = ny;
        p.z = nz;
        const fade = Math.min(1, p.age / 0.4, (p.life - p.age) / 0.6);
        for (let q = 1; q < p.trail.length; q++) {
          const [ax_, ay_, az_] = p.trail[q - 1];
          const [bx, by] = p.trail[q];
          const col = airHeightColour(az_);
          const [x0, y0] = toS(ax_, ay_);
          const [x1, y1] = toS(bx, by);
          ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${(0.85 * fade * q) / p.trail.length})`;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      }
    }
    if (opts.slice && snap.all) drawSlice(g, snap, r, U, dpr, W, H);
    const st = rt.stats?.() ?? {};
    label([
      `Wind view · ${opts.mode} at ${g.zb[k]}–${g.zb[k + 1]} m · wind ${speedMps.toFixed(1)} m/s`,
      `air ${st.grid ?? ''} · step ${(st.meanStepMs ?? 0).toFixed(0)} ms · Alt+↑↓ height  Alt+M reading  Alt+T motes  Alt+S slice  Alt+C cursor`,
    ]);

    function arrow(x, y, dx, dy, colour) {
      const L = Math.hypot(dx, dy);
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + dx, y + dy);
      if (L > 4) {
        const ux = dx / L;
        const uy = dy / L;
        const a = Math.min(5 * dpr, L * 0.35);
        ctx.moveTo(x + dx, y + dy);
        ctx.lineTo(x + dx - a * (ux + uy * 0.6), y + dy - a * (uy - ux * 0.6));
        ctx.moveTo(x + dx, y + dy);
        ctx.lineTo(x + dx - a * (ux - uy * 0.6), y + dy - a * (uy + ux * 0.6));
      }
      ctx.stroke();
    }
    function label(lines) {
      ctx.font = `${12 * dpr}px sans-serif`;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(8 * dpr, 8 * dpr, 640 * dpr, (lines.length * 16 + 8) * dpr);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      lines.forEach((t, i) => ctx.fillText(t, 14 * dpr, (24 + i * 16) * dpr));
    }
  }

  function crossesWall(g, x0, y0, x1, y1, z) {
    const i0 = Math.floor((x0 - g.originX) / g.cellPx);
    const j0 = Math.floor((y0 - g.originY) / g.cellPx);
    const i1 = Math.floor((x1 - g.originX) / g.cellPx);
    const j1 = Math.floor((y1 - g.originY) / g.cellPx);
    let k = 0;
    while (k < g.nz - 1 && z >= g.zb[k + 1]) k++;
    if (i1 !== i0 && j0 >= 0 && j0 < g.ny && g.ax[(k * g.ny + j0) * (g.nx + 1) + Math.max(i0, i1)] < 0.5) return true;
    if (j1 !== j0 && i1 >= 0 && i1 < g.nx && g.ay[(k * (g.ny + 1) + Math.max(j0, j1)) * g.nx + i1] < 0.5) return true;
    return false;
  }

  function spawnMote(r) {
    const u = Math.random();
    return {
      x: r.minX + Math.random() * (r.maxX - r.minX),
      y: r.minY + Math.random() * (r.maxY - r.minY),
      z: 0.5 + 9 * u * u,
      age: 0,
      life: 3 + Math.random() * 4,
      trail: [],
    };
  }

  /** A side view along the wind: speed colour, (along, up) arrows, roofs and walls. */
  function drawSlice(g, snap, r, U, dpr, W, H) {
    const { directionDeg } = wind();
    const rad = (directionDeg * Math.PI) / 180;
    const fx = Math.sin(rad);
    const fy = -Math.cos(rad);
    const centre = opts.followCursor && cursor ? cursor : { x: 0.5 * (r.minX + r.maxX), y: 0.5 * (r.minY + r.maxY) };
    const ppm = g.cellPx / g.h;
    const lengthM = 70;
    const PW = Math.round(Math.min(W * 0.55, 620 * dpr));
    const PH = Math.round(PW * 0.38);
    const x0p = 8 * dpr;
    const y0p = H - PH - 8 * dpr;
    const zTop = g.zb[g.nz];
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x0p - 4 * dpr, y0p - 22 * dpr, PW + 8 * dpr, PH + 26 * dpr);
    const cols = 70;
    const rows = 22;
    const cw = PW / cols;
    const rh = PH / rows;
    for (let a = 0; a < cols; a++) {
      const sM = ((a + 0.5) / cols - 0.5) * lengthM;
      const x = centre.x + fx * sM * ppm;
      const y = centre.y + fy * sM * ppm;
      for (let b = 0; b < rows; b++) {
        const z = ((b + 0.5) / rows) * zTop;
        const s = sample3(snap, g, x, y, z);
        const px = x0p + a * cw;
        const py = y0p + PH - (b + 1) * rh;
        if (!s) continue;
        const prof = Math.log((z + 0.05) / 0.05) / Math.log(1.55 / 0.05);
        const along = s.vx * fx + s.vy * fy;
        const col = airSpeedColour(Math.hypot(along, s.vz) / (U * prof));
        ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
        ctx.fillRect(px, py, cw + 0.5, rh + 0.5);
      }
      // Roof line of this column.
      const i = Math.floor((x - g.originX) / g.cellPx);
      const j = Math.floor((y - g.originY) / g.cellPx);
      if (i >= 0 && j >= 0 && i < g.nx && j < g.ny && g.lid[j * g.nx + i] > 0) {
        const zr = g.zb[g.lid[j * g.nx + i]];
        ctx.fillStyle = 'rgba(15,15,25,0.9)';
        ctx.fillRect(x0p + a * cw, y0p + PH - (zr / zTop) * PH - 1.5 * dpr, cw + 0.5, 3 * dpr);
      }
    }
    ctx.lineWidth = Math.max(1, dpr);
    for (let a = 1; a < cols; a += 3) {
      const sM = ((a + 0.5) / cols - 0.5) * lengthM;
      const x = centre.x + fx * sM * ppm;
      const y = centre.y + fy * sM * ppm;
      for (let b = 1; b < rows; b += 2) {
        const z = ((b + 0.5) / rows) * zTop;
        const s = sample3(snap, g, x, y, z);
        if (!s) continue;
        const along = (s.vx * fx + s.vy * fy) / U;
        const up = s.vz / U;
        const L = Math.hypot(along, up);
        if (L < 0.03) continue;
        const len = (Math.min(L, 2) / L) * cw * 2.2;
        const cx = x0p + (a + 0.5) * cw;
        const cy = y0p + PH - ((b + 0.5) / rows) * PH;
        ctx.strokeStyle = 'rgba(20,20,20,0.85)';
        ctx.beginPath();
        ctx.moveTo(cx - (along * len) / 2, cy + (up * len) / 2);
        ctx.lineTo(cx + (along * len) / 2, cy - (up * len) / 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(20,20,20,0.85)';
        ctx.fillRect(cx + (along * len) / 2 - dpr, cy - (up * len) / 2 - dpr, 2 * dpr, 2 * dpr);
      }
    }
    ctx.font = `${11 * dpr}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(
      `side view along the wind, ${lengthM} m × ${zTop} m (heights to scale ×${(PH / zTop / (PW / lengthM)).toFixed(1)}) · ${opts.followCursor ? 'at the cursor' : 'through the screen centre'}`,
      x0p,
      y0p - 8 * dpr
    );
    // Mark the slice on the map.
    const a0 = { x: centre.x - fx * 0.5 * lengthM * ppm, y: centre.y - fy * 0.5 * lengthM * ppm };
    const a1 = { x: centre.x + fx * 0.5 * lengthM * ppm, y: centre.y + fy * 0.5 * lengthM * ppm };
    const sxp = W / (r.maxX - r.minX);
    const syp = H / (r.maxY - r.minY);
    ctx.setLineDash([6 * dpr, 6 * dpr]);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.moveTo((a0.x - r.minX) * sxp, (a0.y - r.minY) * syp);
    ctx.lineTo((a1.x - r.minX) * sxp, (a1.y - r.minY) * syp);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  return {
    get on() {
      return on;
    },
    get options() {
      return { ...opts };
    },
    /** Turn the view on or off, and/or change options ({layer, mode, tracers, slice, followCursor, fill}). */
    set(next) {
      if (typeof next === 'boolean') next = { on: next };
      for (const key of Object.keys(opts)) if (next && key in next) opts[key] = next[key];
      if (next && 'mode' in next && !MODES.includes(opts.mode)) opts.mode = 'speed';
      const want = next && 'on' in next ? !!next.on : on;
      if (want && !on) {
        on = true;
        ensureCanvas();
        canvas.style.display = '';
        wantLayers(true);
        globalThis.addEventListener('keydown', onKey, true);
        globalThis.addEventListener('mousemove', onMove, true);
        lastT = 0;
        raf = requestAnimationFrame(draw);
      } else if (!want && on) {
        on = false;
        cancelAnimationFrame(raf);
        raf = 0;
        wantLayers(false);
        globalThis.removeEventListener('keydown', onKey, true);
        globalThis.removeEventListener('mousemove', onMove, true);
        if (canvas) canvas.style.display = 'none';
        motes.length = 0;
      }
      return { on, ...opts };
    },
    dispose() {
      this.set(false);
      canvas?.remove?.();
      canvas = null;
    },
  };
}
