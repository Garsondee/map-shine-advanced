/**
 * SHADER LAB — SNOW AND SLEET (2026-11-03).
 *
 * The author: *"make the snow look great from everything from low wind low intensity where it creates a pleasant
 * winter wonderland of gentle snow all the way up to a full whiteout blizzard. The shape of snow should be simple,
 * ragged, not circles and not snowflake shapes."*
 *
 * Built on `rain-cloud-lab.js`'s driver (real map albedo, the shared scene eye, the cloud deck the fall is born
 * from, the production wind door) and adds what snow is judged by and rain is not:
 *   - the VEIL (`curtain-render.js`) and the STORM FOG (`storm-fog-render.js`), combined exactly as
 *     `precip-subsystem.js#sync` combines them — a whiteout IS those two layers, so a lab without them cannot
 *     show one;
 *   - SLEET: rain and snow populations at once, `liveCount × weight` each, drawn by layer (all splashes, all
 *     veils, all bodies, then fog) — the subsystem's own order;
 *   - a snow-covered ground (`ground` lerps the albedo toward the mantle's own snow tint), because white flakes
 *     over white ground is the hard case and a dark map hides every failure of it;
 *   - CROPS: a region of the frame magnified with nearest-neighbour, so a 3-px flake's silhouette is judgeable.
 *
 * Time is hand-stepped (the Browser pane may be hidden). Map art is not in the repo: `runs/sb-art/<map>.jpg`.
 *
 * @module tools/shader-lab/snow-lab
 */
import { RainCloudDriver, LAB_MAPS, PRECIP_DEFAULTS } from './rain-cloud-lab.js';
import { createPrecipCurtain, VEIL_TINT, DEFAULT_TINT } from '../../src/effects/precipitation/curtain-render.js';
import { createStormFog } from '../../src/effects/precipitation/storm-fog-render.js';
import { PRECIP_SPECIES, resolveSpeciesFrame } from '../../src/effects/precipitation/precip-species.js';

export { LAB_MAPS, PRECIP_DEFAULTS };

/** The mantle's own snow tint (`precip-species.js` snow `stay.surface.tint`). */
const SNOW_TINT = PRECIP_SPECIES.snow.stay.surface.tint;

/**
 * The ladder the author described, calm wonderland to whiteout. `storm` is what the weather manager would hand
 * for that sky (it rises with wind and precip together); `cover` is the CLOUD cover (`rain-cloud-lab.js`'s own key —
 * since 75ad0432 snow falls only under cloud that carries it, so a thin sky leaves the view dry).
 */
export const SNOW_LADDER = Object.freeze([
  { id: 'a-wonderland', precip: 0.15, wind: 0.04, storm: 0, cover: 0.8, label: 'wonderland: light, still' },
  { id: 'b-gentle', precip: 0.35, wind: 0.1, storm: 0.05, cover: 0.85, label: 'gentle steady snow' },
  { id: 'c-heavy-calm', precip: 0.7, wind: 0.08, storm: 0.15, cover: 0.95, label: 'heavy, calm' },
  { id: 'd-breezy', precip: 0.5, wind: 0.35, storm: 0.3, cover: 0.85, label: 'breezy snow' },
  { id: 'e-squall', precip: 0.8, wind: 0.6, storm: 0.65, cover: 0.95, label: 'snow squall' },
  { id: 'f-blizzard', precip: 0.95, wind: 0.85, storm: 0.9, cover: 1, label: 'blizzard' },
  { id: 'g-whiteout', precip: 1, wind: 1, storm: 1, cover: 1, label: 'whiteout' },
]);

export class SnowLabDriver extends RainCloudDriver {
  constructor({ THREE }) {
    super({ THREE });
    this.curtains = new Map();
    this.fog = null;
    this.uCover = THREE.TSL.uniform(THREE.TSL.float(0));
  }

  /** The ground, plus a lerp toward the mantle's snow tint by `ground` (a stand-in for the real mantle). */
  groundMaterial(tex) {
    const mat = super.groundMaterial(tex);
    if (mat._snowWrapped) return mat;
    const T = this.THREE.TSL;
    const base = mat.colorNode;
    const lum = T.dot(base.rgb, T.vec3(0.299, 0.587, 0.114));
    // Snow lies brightest on the open ground and keeps the art's darks (walls, shadow) as darker snow.
    const snowRgb = T.vec3(...SNOW_TINT).mul(lum.mul(0.55).add(0.5).min(1.0));
    mat.colorNode = T.vec4(T.mix(base.rgb, snowRgb, this.uCover), T.float(1));
    mat._snowWrapped = true;
    mat.needsUpdate = true;
    return mat;
  }

  curtain(id) {
    if (this.curtains.has(id)) return this.curtains.get(id);
    const st = this.state;
    const c = createPrecipCurtain({
      THREE: this.THREE,
      speciesId: id,
      worldRect: st.board,
      renderOrder: 9.5,
      openSkyTexture: this.openSky,
    });
    this.curtains.set(id, c);
    return c;
  }

  stormFog() {
    if (this.fog) return this.fog;
    this.fog = createStormFog({
      THREE: this.THREE,
      worldRect: this.state.board,
      renderOrder: 20,
      openSkyTexture: this.openSky,
    });
    return this.fog;
  }

  /**
   * `o.sleet` (0..1, the SNOW share) turns the scene into a sleet: both populations, weighted. Everything else is
   * `RainCloudDriver#configure`'s.
   */
  configure(o = {}) {
    const sleet = Number.isFinite(o.sleet) ? Math.max(0, Math.min(1, o.sleet)) : null;
    const res = super.configure({ ...o, species: 'snow' });
    const st = this.state;
    st.populations =
      sleet === null
        ? [{ speciesId: 'snow', weight: 1 }]
        : [
            { speciesId: 'rain', weight: 1 - sleet },
            { speciesId: 'snow', weight: sleet },
          ].filter((p) => p.weight > 0.01);
    const axes = this.frameAxes(o);
    this.frames = new Map();
    for (const { speciesId, weight } of st.populations) {
      const base = resolveSpeciesFrame(PRECIP_SPECIES[speciesId], axes);
      this.frames.set(speciesId, { base, frame: { ...base, liveCount: Math.round(base.liveCount * weight) }, weight });
      const e = this.engine(speciesId);
      e.setTuning(this.tuning);
      const s = this.splashes.get(speciesId);
      if (s?.ok) s.setTuning(this.tuning);
    }
    // The snow frame the parent stepped with is the WEIGHTED one.
    if (this.frames.has('snow')) this.frame = this.frames.get('snow').frame;
    for (const [id, e] of this.engines) if (!this.frames.has(id)) e.setFrame({ liveCount: 0 });
    for (const [id, s] of this.splashes)
      if (!this.frames.has(id) && s?.ok) s.setFrame({ liveCount: 0, splashRate01: 0 });
    this.uCover.value = Number.isFinite(o.ground) ? o.ground : 0;
    // Atmosphere, combined the subsystem's way: fog is a weighted SUM, its look the dominant population's.
    let fog01 = 0;
    let windBorne01 = 0;
    let whiteoutMaxAlpha;
    let dominant = st.populations[0];
    for (const p of st.populations) if (p.weight > dominant.weight) dominant = p;
    for (const { speciesId, weight } of st.populations) {
      const { base } = this.frames.get(speciesId);
      fog01 += base.fog01 * weight;
      const wo = PRECIP_SPECIES[speciesId].whiteout;
      if (wo) {
        windBorne01 += weight;
        whiteoutMaxAlpha = wo.maxAlpha;
      }
      const c = this.curtain(speciesId);
      c.setFrame({ ...base, veil01: base.veil01 * weight });
      c.setTuning(this.tuning);
    }
    for (const [id, c] of this.curtains) if (!this.frames.has(id)) c.setFrame({ veil01: 0, rgbMul: 1, alphaMul: 1 });
    const db = this.frames.get(dominant.speciesId).base;
    const fog = this.stormFog();
    fog.setFrame({
      intensity01: fog01,
      tint: VEIL_TINT[dominant.speciesId] ?? DEFAULT_TINT,
      rgbMul: db.rgbMul,
      sceneLight01: db.sceneLight01,
      alphaMul: db.alphaMul,
      windBorne01,
      whiteoutMaxAlpha,
    });
    fog.setTuning(this.tuning);
    st.fog01 = fog01;
    return res;
  }

  frameAxes(o) {
    return {
      precip01: this.state.precip,
      stormActivity01: o.storm ?? 0,
      // ⚠️ THE SUN'S OWN `dayFactor01`, as production feeds it (`vt-pan-viewer.js` → `env.sun.dayFactor01`,
      // elevation only). The parent's `key.strength + 0.3` falls with CLOUD cover, so a full overcast drew noon
      // snow at night levels (dim grey flakes, a faint whiteout) over a daylight ground.
      dayFactor01: this.sun.dayFactor01,
      flash01: 0,
      sceneLight01: 1,
    };
  }

  /** The parent steps the snow (`state.species`); a sleet's rain is stepped here, in the same frame. */
  advance(n = 1, dtMs = 1000 / 60) {
    const st = this.state;
    for (let k = 0; k < n; k++) {
      super.advance(1, dtMs);
      const dt = dtMs / 1000;
      if (this.frames?.has('rain')) {
        const e = this.engine('rain');
        const s = this.splashes.get('rain');
        e.setWorldRect(st.view);
        e.setViewRect(st.view);
        e.setEye(st.eye);
        e.setSceneBounds(st.board);
        if (e.setCloudDeck) e.setCloudDeck(this.cloudDeckFor());
        e.setFrame(this.frames.get('rain').frame);
        e.step(this.renderer, dt, this.nowMs, this.windHandle);
        if (s?.ok) {
          s.setWorldRect(st.view);
          s.setSceneBounds(st.board);
          if (s.setCloudDeck) {
            const cd = this.cloudDeckFor();
            s.setCloudDeck(cd ? { ...cd, landingShiftPx: e.landingShiftPx?.() } : null);
          }
          s.setFrame(this.frames.get('rain').frame);
          s.step(this.renderer, dt, this.nowMs, this.windHandle);
        }
      }
      for (const { speciesId } of st.populations) this.curtains.get(speciesId)?.step(this.nowMs, this.windHandle);
      this.fog?.step(this.nowMs, this.windHandle);
    }
  }

  /** Ground → splashes → veils → bodies → storm fog: `precip-subsystem.js#scenes`, by layer. */
  async frameBytes({ layers = 'all' } = {}) {
    const st = this.state;
    const r = this.renderer;
    const tex = await this.texture(st.map);
    this.groundMesh.material = this.groundMaterial(tex);
    const prev = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.setRenderTarget(this._rt);
    r.autoClear = false;
    r.setClearColor(0x000000, 1);
    r.clear();
    this.u.groundDim.value = 1;
    const pops = st.populations.map((p) => p.speciesId);
    if (layers !== 'fall') {
      r.render(this.groundScene, this.camera);
      for (const id of pops) {
        const s = this.splashes.get(id);
        if (s?.ok) r.render(s.scene, this.camera);
      }
      for (const id of pops) {
        const c = this.curtains.get(id);
        if (c?.hasContent && st.veil !== false) r.render(c.scene, this.camera);
      }
    }
    for (const id of pops) r.render(this.engine(id).scene, this.camera);
    if (layers !== 'fall' && this.fog?.hasContent && st.fogOn !== false) r.render(this.fog.scene, this.camera);
    const bytes = await r.readRenderTargetPixelsAsync(this._rt, 0, 0, st.W, st.H);
    r.setRenderTarget(prev);
    r.autoClear = prevAuto;
    return { bytes, w: st.W, h: st.H };
  }

  /** Cut `crop` = {x, y, w, h} (target px) out of a frame and magnify it `k`× (nearest). */
  static crop({ bytes, w }, crop, k = 4) {
    const out = new Uint8Array(crop.w * k * crop.h * k * 4);
    const ow = crop.w * k;
    for (let y = 0; y < crop.h * k; y++) {
      for (let x = 0; x < ow; x++) {
        const si = ((crop.y + Math.floor(y / k)) * w + crop.x + Math.floor(x / k)) * 4;
        const di = (y * ow + x) * 4;
        out[di] = bytes[si];
        out[di + 1] = bytes[si + 1];
        out[di + 2] = bytes[si + 2];
        out[di + 3] = 255;
      }
    }
    return { bytes: out, w: ow, h: crop.h * k };
  }

  /**
   * One rung: configure, warm, shoot the full frame, and optionally a magnified crop beside it.
   * @returns {Promise<object>} what was shot, with the measured readout.
   */
  async rung(run, o = {}) {
    this.configure(o);
    this.advance(o.warmFrames ?? 240);
    const f = await this.frameBytes({ layers: o.layers ?? 'all' });
    const tag = o.id ?? 'shot';
    const label = o.label ?? tag;
    await this.savePng(run, `${tag}.png`, f, `${label}\nprecip ${o.precip} wind ${o.wind} storm ${o.storm ?? 0}`);
    if (o.crop) {
      const c = SnowLabDriver.crop(f, o.crop, o.cropK ?? 4);
      await this.savePng(run, `${tag}-crop.png`, c, null);
    }
    return {
      tag,
      fog01: +this.state.fog01.toFixed(3),
      frames: Object.fromEntries(
        [...this.frames].map(([id, v]) => [
          id,
          { liveCount: v.frame.liveCount, veil01: +v.base.veil01.toFixed(3), alphaMul: +v.base.alphaMul.toFixed(2) },
        ])
      ),
      meanLuma: SnowLabDriver.meanLuma(f),
    };
  }

  /**
   * The whole ladder (or a subset by id). ⚠️ `link: 0` BY DEFAULT: the look is judged as it falls under a cloud
   * core, everywhere in the frame. With the cloud link on, a view that happens to sit in a dry gap between clouds
   * (the map centre at 95% cover, measured) shows no snow at all, which says nothing about how snow LOOKS.
   */
  async ladder(run, o = {}) {
    const ids = o.ids ? new Set(o.ids) : null;
    const out = [];
    for (const r of SNOW_LADDER) {
      if (ids && !ids.has(r.id)) continue;
      out.push(await this.rung(run, { map: 'snow', link: 0, ...o, ...r, ...(o.override ?? {}) }));
    }
    return out;
  }

  /**
   * A long exposure of the fall only, over the dimmed ground — every flake's path over `frames` frames as one
   * trail, which is how motion (sway, drift, gust) is judged from a still.
   */
  async trails(run, file, o = {}) {
    this.configure(o);
    this.advance(o.warmFrames ?? 240);
    const st = this.state;
    const r = this.renderer;
    const tex = await this.texture(st.map);
    this.groundMesh.material = this.groundMaterial(tex);
    const prev = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.setRenderTarget(this._rt);
    r.autoClear = false;
    r.setClearColor(0x000000, 1);
    r.clear();
    this.u.groundDim.value = 0.25;
    const cover = this.uCover.value;
    this.uCover.value = 0;
    r.render(this.groundScene, this.camera);
    const frames = o.frames ?? 60;
    const every = o.every ?? 2;
    for (let k = 0; k < frames; k++) {
      this.advance(1, o.dtMs ?? 1000 / 60);
      if (k % every) continue;
      r.setRenderTarget(this._rt);
      for (const { speciesId } of st.populations) r.render(this.engine(speciesId).scene, this.camera);
    }
    const bytes = await r.readRenderTargetPixelsAsync(this._rt, 0, 0, st.W, st.H);
    r.setRenderTarget(prev);
    r.autoClear = prevAuto;
    this.u.groundDim.value = 1;
    this.uCover.value = cover;
    const f = { bytes, w: st.W, h: st.H };
    await this.savePng(run, file, f, o.label);
    if (o.crop) await this.savePng(run, file.replace('.png', '-crop.png'), SnowLabDriver.crop(f, o.crop, o.cropK ?? 3));
    return true;
  }

  static meanLuma({ bytes }) {
    let s = 0;
    const n = bytes.length / 4;
    for (let i = 0; i < bytes.length; i += 4) s += bytes[i] * 0.2126 + bytes[i + 1] * 0.7152 + bytes[i + 2] * 0.0722;
    return +(s / n / 255).toFixed(4);
  }
}
