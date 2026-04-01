import { createLogger } from '../core/log.js';

const log = createLogger('BreakerBoxDialog');
const STATUS_WEIGHT = { unknown: 0, healthy: 1, degraded: 2, broken: 3, critical: 4 };

const SOURCE_DEFS = [
  { id: 'src:waterMasks', label: 'Water Masks', effects: ['WaterEffectV2'], keywords: ['floorDataMap', 'mask'] },
  { id: 'src:waterData', label: 'Water Data Builder', effects: ['WaterEffectV2'], keywords: ['composeMaterial', 'floorData'] },
  { id: 'src:cloudField', label: 'Cloud Field Generator', effects: ['CloudEffectV2'], keywords: ['initialized', 'shadowTarget'] },
  { id: 'src:roofCapture', label: 'Roof Capture Targets', effects: ['OverheadShadowsEffectV2'], keywords: ['targets', 'roof', 'shadow'] },
  { id: 'src:windowMasks', label: 'Window Masks', effects: ['WindowLightEffectV2'], keywords: ['overlayMap', 'window', 'overlay'] },
  { id: 'src:fireMasks', label: 'Fire Masks + Spawn Data', effects: ['FireEffectV2'], keywords: ['batchRenderer', 'initialized', 'mask'] },
  { id: 'src:playerRuntime', label: 'Player Runtime Inputs', effects: ['PlayerLightEffectV2'], keywords: ['runtimeBound', 'groupOrLight'] },
  { id: 'src:lightingCore', label: 'Lighting Core (lightRT / compose)', effects: ['LightingEffectV2'], keywords: ['lightRT', 'composeMaterial', 'initialized'] },
  { id: 'src:waterSplashes', label: 'Water Splashes (Quarks)', effects: ['WaterSplashesEffectV2'], keywords: ['batchRenderer', 'initialized'] },
  { id: 'src:dustParticles', label: 'Dust Particles (Quarks)', effects: ['DustEffectV2'], keywords: ['batchRenderer', 'initialized'] },
  { id: 'src:skyGrade', label: 'Sky Color Pass', effects: ['SkyColorEffectV2'], keywords: ['composeMaterial', 'initialized'] },
  { id: 'src:buildingShadowRTs', label: 'Building Shadow RTs', effects: ['BuildingShadowsEffectV2'], keywords: ['initializedTargets', 'shadow'] },
  {
    id: 'src:specularOutdoors',
    label: 'Specular + _Outdoors (GPU masks)',
    effects: ['SpecularEffectV2', 'GpuSceneMaskCompositor'],
    keywords: [
      'specularOutdoorsBinding',
      'compositorInstance',
      'outdoors',
      'initialized',
      'overlay',
      'activeOutdoorsMaskStatus',
      'wetCloudOutdoorFactor',
      'fallback_white',
      'outdoorFactor',
      'outdoorsTrace',
      'getFloorTextureAttempts',
      'tileManager',
    ],
  },
];

function copyText(text) {
  const value = String(text || '');
  if (!value) return Promise.resolve(false);
  if (navigator?.clipboard?.writeText) {
    return navigator.clipboard.writeText(value).then(() => true).catch(() => false);
  }
  return Promise.resolve(false);
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function colorForStatus(status) {
  if (status === 'critical') return '#ff3b30';
  if (status === 'broken') return '#ff453a';
  if (status === 'degraded') return '#ffcc00';
  if (status === 'healthy') return '#30d158';
  return '#8e8e93';
}

function collectChecks(effect) {
  const out = [];
  for (const lvl of effect?.byLevel || []) {
    for (const check of lvl?.checks || []) out.push({ levelKey: lvl.levelKey, ...check });
  }
  return out;
}

/** Split direct contract failures vs graph propagation noise for clearer Breaker Box copy. */
function partitionFailedChecks(checks) {
  const direct = [];
  const propagated = [];
  for (const c of checks || []) {
    if (c.result !== 'fail') continue;
    const id = String(c.ruleId || '');
    if (id.startsWith('propagated:')) propagated.push(c);
    else direct.push(c);
  }
  return { direct, propagated };
}

export class BreakerBoxDialog {
  constructor(healthEvaluator) {
    this.healthEvaluator = healthEvaluator || null;
    this.container = null;
    this._visible = false;
    this._selectedNodeId = null;
    this._graphModel = null;
    this._unsubscribe = null;
    this._drag = null;
    this._resizeObserver = null;
    this._lastRect = { left: 20, top: 72 };
    this._graphZoom = 1;
    this._graphPan = null;
    this._stackScroll = null;
    this._splitWrap = null;
    this._selectedStackPassId = null;
  }

  initialize() {
    if (this.container) return;
    this._ensureStyles();

    const root = document.createElement('div');
    root.id = 'map-shine-breaker-box';
    root.className = 'mapshine-breaker-root';
    root.style.display = 'none';

    const header = document.createElement('div');
    header.className = 'mapshine-breaker-header';
    header.innerHTML = '<strong>Map Shine Breaker Box</strong>';
    this._header = header;

    const actions = document.createElement('div');
    actions.className = 'mapshine-breaker-actions';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy Full JSON';
    copyBtn.addEventListener('click', async () => {
      const payload = this.healthEvaluator?.exportDiagnostics?.() ?? {};
      const ok = await copyText(JSON.stringify(payload, null, 2));
      if (ok) ui?.notifications?.info?.('Breaker Box diagnostics copied');
      else ui?.notifications?.warn?.('Could not copy Breaker Box diagnostics');
    });
    actions.appendChild(copyBtn);

    const copyNodeBtn = document.createElement('button');
    copyNodeBtn.textContent = 'Copy Selected Node';
    copyNodeBtn.addEventListener('click', async () => {
      const snapshot = this.healthEvaluator?.getSnapshot?.() || null;
      const payload = this._buildNodeDiagnostic(this._selectedNodeId, snapshot);
      const ok = await copyText(JSON.stringify(payload, null, 2));
      if (ok) ui?.notifications?.info?.('Breaker Box node diagnostics copied');
      else ui?.notifications?.warn?.('Could not copy selected node diagnostics');
    });
    actions.appendChild(copyNodeBtn);
    this._copyNodeBtn = copyNodeBtn;

    const zoomOutBtn = document.createElement('button');
    zoomOutBtn.textContent = '−';
    zoomOutBtn.title = 'Zoom out graph';
    zoomOutBtn.addEventListener('click', () => this._setGraphZoom(this._graphZoom - 0.1));
    actions.appendChild(zoomOutBtn);

    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'mapshine-breaker-zoom-label';
    zoomLabel.textContent = '100%';
    actions.appendChild(zoomLabel);
    this._zoomLabel = zoomLabel;

    const zoomInBtn = document.createElement('button');
    zoomInBtn.textContent = '+';
    zoomInBtn.title = 'Zoom in graph';
    zoomInBtn.addEventListener('click', () => this._setGraphZoom(this._graphZoom + 0.1));
    actions.appendChild(zoomInBtn);

    const fitBtn = document.createElement('button');
    fitBtn.textContent = 'Fit';
    fitBtn.title = 'Reset graph zoom and scroll';
    fitBtn.addEventListener('click', () => {
      this._setGraphZoom(1);
      if (this._graphWrap) {
        this._graphWrap.scrollLeft = 0;
        this._graphWrap.scrollTop = 0;
      }
    });
    actions.appendChild(fitBtn);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.hide());
    actions.appendChild(closeBtn);

    header.appendChild(actions);
    root.appendChild(header);

    const subhead = document.createElement('div');
    subhead.className = 'mapshine-breaker-subhead';
    subhead.innerHTML = `
      <span>Left: sources → effects graph. Right: render stack (pipeline). Click bulbs for health; stack rows to highlight.</span>
      <span id="mapshine-breaker-overall"></span>
    `;
    root.appendChild(subhead);

    const graphWrap = document.createElement('div');
    graphWrap.className = 'mapshine-breaker-graph-wrap';
    graphWrap.id = 'mapshine-breaker-graph-wrap';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('mapshine-breaker-graph-svg');
    graphWrap.appendChild(svg);

    const nodes = document.createElement('div');
    nodes.className = 'mapshine-breaker-graph-nodes';
    graphWrap.appendChild(nodes);

    const split = document.createElement('div');
    split.className = 'mapshine-breaker-split';
    this._splitWrap = split;
    split.appendChild(graphWrap);

    const stackWrap = document.createElement('div');
    stackWrap.className = 'mapshine-breaker-stack-wrap';
    const stackTitle = document.createElement('div');
    stackTitle.className = 'mapshine-breaker-stack-title';
    stackTitle.textContent = 'Render stack';
    const stackScroll = document.createElement('div');
    stackScroll.className = 'mapshine-breaker-stack-scroll';
    stackScroll.id = 'mapshine-breaker-stack-scroll';
    stackWrap.appendChild(stackTitle);
    stackWrap.appendChild(stackScroll);
    split.appendChild(stackWrap);

    root.appendChild(split);

    const detail = document.createElement('div');
    detail.className = 'mapshine-breaker-detail';
    detail.id = 'mapshine-breaker-detail';
    root.appendChild(detail);

    const content = document.createElement('div');
    content.id = 'map-shine-breaker-box-content';
    content.className = 'mapshine-breaker-summary';
    root.appendChild(content);

    document.body.appendChild(root);
    this.container = root;
    this._content = content;
    this._graphWrap = graphWrap;
    this._graphSvg = svg;
    this._nodesLayer = nodes;
    this._stackScroll = stackScroll;
    this._detail = detail;
    this._overall = subhead.querySelector('#mapshine-breaker-overall');

    this._unsubscribe = this.healthEvaluator?.subscribe?.(() => {
      if (this._visible) this.render();
    }) || null;

    this._installDrag();
    this._installGraphPanAndZoom();
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        if (this._visible) this.render();
      });
      this._resizeObserver.observe(this._splitWrap || this._graphWrap);
    }

    this.render();
  }

  _ensureStyles() {
    if (document.getElementById('map-shine-breaker-box-style')) return;
    const style = document.createElement('style');
    style.id = 'map-shine-breaker-box-style';
    style.textContent = `
#map-shine-breaker-box.mapshine-breaker-root{
  position:fixed;right:20px;top:72px;z-index:100000;
  width:min(1280px,calc(100vw - 32px));max-height:82vh;
  overflow:auto;background:rgba(16,18,24,0.97);
  border:1px solid rgba(255,255,255,0.18);border-radius:10px;
  padding:10px;color:#f0f0f0;font-size:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);
}
.mapshine-breaker-split{
  display:flex;flex-direction:row;gap:10px;margin-top:8px;align-items:stretch;
  min-height:420px;
}
.mapshine-breaker-graph-wrap{
  margin-top:0;
}
.mapshine-breaker-stack-wrap{
  flex:0 0 38%;max-width:440px;min-width:220px;
  border:1px solid rgba(255,255,255,0.12);border-radius:8px;
  background:rgba(8,10,14,0.55);display:flex;flex-direction:column;overflow:hidden;
  max-height:520px;
}
.mapshine-breaker-stack-title{
  font-weight:700;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.1);
  color:#e8ecf4;flex-shrink:0;
}
.mapshine-breaker-stack-scroll{
  overflow:auto;flex:1;padding:6px 8px 10px;
}
.mapshine-breaker-stack-row{
  border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:6px 8px;margin-bottom:5px;
  cursor:pointer;text-align:left;background:rgba(255,255,255,0.03);color:#dfe6f2;
}
.mapshine-breaker-stack-row:hover{background:rgba(255,255,255,0.06);}
.mapshine-breaker-stack-row.disabled{opacity:0.55;}
.mapshine-breaker-stack-row.highlight{background:rgba(139,197,255,0.12);border-color:rgba(139,197,255,0.35);}
.mapshine-breaker-stack-row.selected{background:rgba(139,197,255,0.2);border-color:#8bc5ff;}
.mapshine-breaker-stack-sub{margin-left:12px;margin-top:4px;padding-left:8px;border-left:2px solid rgba(255,255,255,0.12);}
.mapshine-breaker-stack-row .row-top{display:flex;align-items:center;gap:8px;}
.mapshine-breaker-stack-row .idx{opacity:0.65;min-width:22px;font-variant-numeric:tabular-nums;}
.mapshine-breaker-stack-row .kind{font-size:10px;text-transform:uppercase;opacity:0.55;}
.mapshine-breaker-stack-findings{margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);}
.mapshine-breaker-stack-findings .fi{font-size:11px;margin-bottom:6px;color:#c8d0e0;}
.mapshine-breaker-header{display:flex;justify-content:space-between;align-items:center;gap:8px;}
.mapshine-breaker-header strong{cursor:move;user-select:none;}
.mapshine-breaker-actions{display:flex;gap:6px;flex-wrap:wrap;}
.mapshine-breaker-zoom-label{display:inline-flex;align-items:center;opacity:.85;min-width:44px;justify-content:center;}
.mapshine-breaker-subhead{display:flex;justify-content:space-between;align-items:center;margin-top:6px;color:#b8bdc8;}
.mapshine-breaker-graph-wrap{
  position:relative;flex:1 1 58%;min-width:260px;height:420px;border:1px solid rgba(255,255,255,0.12);
  border-radius:8px;background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.01));
  overflow:auto;cursor:grab;
}
.mapshine-breaker-graph-svg{position:absolute;inset:0;width:100%;height:100%;}
.mapshine-breaker-graph-nodes{position:absolute;inset:0;pointer-events:none;}
.mapshine-breaker-edge{fill:none;stroke-width:1.5;opacity:.7;}
.mapshine-breaker-edge.required{stroke:#d8dce8;}
.mapshine-breaker-edge.contextual{stroke:#9fb2ff;stroke-dasharray:4 3;}
.mapshine-breaker-edge.optional{stroke:#7f8a9e;stroke-dasharray:2 4;}
.mapshine-breaker-node{
  position:absolute;transform:translate(-50%,-50%);width:178px;padding:6px 8px;
  border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(10,12,16,.78);
  color:#eff2f8;display:flex;align-items:center;gap:8px;cursor:pointer;text-align:left;
  pointer-events:auto;
}
.mapshine-breaker-node.selected{outline:1px solid #8bc5ff;box-shadow:0 0 0 2px rgba(139,197,255,.25);}
.mapshine-breaker-node.kind-source{width:190px;}
.mapshine-breaker-node .bulb{
  width:11px;height:11px;border-radius:999px;flex:0 0 11px;border:1px solid rgba(255,255,255,.45);
}
.mapshine-breaker-node .label{font-weight:600;line-height:1.2;}
.mapshine-breaker-node .sub{font-size:11px;opacity:.78;line-height:1.2;}
.mapshine-breaker-detail{
  margin-top:8px;border:1px solid rgba(255,255,255,.12);border-radius:8px;
  background:rgba(8,10,14,.65);padding:8px;white-space:normal;
}
.mapshine-breaker-detail .muted{color:#a8b0c0;}
.mapshine-breaker-summary{margin-top:8px;white-space:pre-wrap;color:#c2cad7;}
`;
    document.head.appendChild(style);
  }

  _getSelectedEffectId() {
    const id = this._selectedNodeId;
    if (!id || !String(id).startsWith('effect:')) return null;
    return String(id).slice('effect:'.length);
  }

  _bindingTouchesPass(bindings, effectId, passId) {
    return (bindings || []).some(
      (b) => b.effectId === effectId && (b.passIds || []).includes(passId)
    );
  }

  _bindingTouchesSubpass(bindings, effectId, subpassId) {
    return (bindings || []).some(
      (b) => b.effectId === effectId && (b.subpassIds || []).includes(subpassId)
    );
  }

  _pipelineDetailHtml(snapshot, effectId) {
    const rs = snapshot?.renderStack;
    if (!effectId || !rs) return '';
    const binds = (rs.bindings || []).filter((b) => b.effectId === effectId);
    let html = '<div class="muted" style="margin-top:8px">Pipeline position (right panel)</div><ul style="margin:4px 0 0 16px;font-size:11px">';
    if (!binds.length) {
      html += '<li>No explicit binding — see full stack list.</li></ul>';
      return html;
    }
    for (const b of binds) {
      const p = (b.passIds || []).join(', ');
      const s = (b.subpassIds || []).length ? ` · subpasses: ${b.subpassIds.join(', ')}` : '';
      html += `<li><strong>${esc(p)}</strong>${esc(s)}</li>`;
    }
    html += '</ul>';
    if (effectId === 'WindowLightEffectV2' && rs.windowLightMeta) {
      const wl = rs.windowLightMeta;
      if (wl.composeNote) {
        html += `<div class="muted" style="margin-top:8px">Window vs floor albedo</div><p style="font-size:11px;margin:4px 0;line-height:1.35">${esc(wl.composeNote)}</p>`;
      }
      if (wl.zFormula) {
        html += `<p style="font-size:11px;margin:4px 0;opacity:0.9">${esc(wl.zFormula)}</p>`;
      }
      if (rs.busMeta?.tileZFormula) {
        html += `<p style="font-size:11px;margin:4px 0;opacity:0.9">Bus tiles: ${esc(rs.busMeta.tileZFormula)}</p>`;
      }
      const floors = Object.keys(wl.byFloor || {}).sort((a, b) => {
        const na = Number(String(a).replace(/^floor:/, '')) || 0;
        const nb = Number(String(b).replace(/^floor:/, '')) || 0;
        return na - nb;
      });
      if (floors.length) {
        html += '<div class="muted" style="margin-top:6px">Window overlays by floor</div><ul style="font-size:11px;margin:4px 0 0 16px">';
        for (const k of floors) {
          const v = wl.byFloor[k];
          html += `<li>${esc(k)}: ${v.count} mesh(es), renderOrder ${v.minRenderOrder}–${v.maxRenderOrder}, visible ${v.visibleCount}/${v.count}</li>`;
        }
        html += '</ul>';
      }
      const inv = Array.isArray(wl.overlayList) ? wl.overlayList : [];
      if (inv.length) {
        const af = Number(wl.activeFloor ?? rs.runtime?.activeFloor ?? 0);
        html += `<div class="muted" style="margin-top:8px">Overlay inventory (active floor ${af})</div>`;
        html +=
          '<table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:4px"><thead><tr style="opacity:0.85">' +
          '<th style="text-align:left;padding:2px 4px">tile</th>' +
          '<th style="text-align:right;padding:2px 4px">fl</th>' +
          '<th style="text-align:right;padding:2px 4px">rO</th>' +
          '<th style="text-align:center;padding:2px 4px">vis</th>' +
          '<th style="text-align:right;padding:2px 4px">mask</th>' +
          '</tr></thead><tbody>';
        for (const row of inv) {
          const hi = Number(row.floorIndex) === af ? 'font-weight:600' : '';
          html += `<tr style="${hi}">` +
            `<td style="padding:2px 4px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(row.tileId)}">${esc(row.tileId)}</td>` +
            `<td style="text-align:right;padding:2px 4px">${esc(String(row.floorIndex))}</td>` +
            `<td style="text-align:right;padding:2px 4px">${esc(String(row.renderOrder))}</td>` +
            `<td style="text-align:center;padding:2px 4px">${row.visible ? '✓' : '—'}</td>` +
            `<td style="text-align:right;padding:2px 4px">${esc(Number(row.maskReady).toFixed(2))}</td>` +
            `</tr>`;
        }
        html += '</tbody></table>';
        if (wl.overlayListTruncated) {
          html += '<p style="font-size:10px;opacity:0.8;margin:4px 0 0">List truncated (first 64 rows).</p>';
        }
      }
    }
    return html;
  }

  /**
   * @param {string} status
   * @returns {string}
   */
  _outdoorsStatusColor(status) {
    const s = String(status || '');
    if (s.includes('valid_compositor') || s.includes('legacy_weather')) return '#30d158';
    if (s.includes('broken') || s.includes('fallback_white')) return '#ff453a';
    if (s.includes('single_floor') || s.includes('unknown')) return '#ffcc00';
    return '#8e8e93';
  }

  /**
   * @param {object} d
   * @returns {string}
   */
  _htmlSpecularOutdoorsDetail(d) {
    if (d.error) {
      return `<div class="muted" style="margin-top:8px">Specular — _Outdoors bind error</div>` +
        `<p style="font-size:11px;color:#ff453a;margin:4px 0">${esc(d.message || 'Error')}</p>`;
    }
    if (d.note && Number(d.overlayCount) === 0) {
      return `<div class="muted" style="margin-top:8px">Specular diagnostics</div><p style="font-size:11px;margin:4px 0">${esc(d.note)}</p>`;
    }

    const st = String(d.activeOutdoorsMaskStatus || 'unknown');
    const stColor = this._outdoorsStatusColor(st);
    const af = d.activeFloorOutdoors || null;
    const wc = d.wetCloudOutdoorFactor || null;
    const hist = d.outdoorsFloorIdxHistogram || {};
    const obf = d.overlayByFloor || {};
    const histRows = Object.keys(hist).sort((a, b) => Number(a) - Number(b)).map((k) =>
      `<tr><td style="padding:2px 4px">uOutdoorsFloorIdx ${esc(k)}</td>` +
      `<td style="text-align:right;padding:2px 4px">${esc(String(hist[k]))}</td></tr>`
    ).join('');
    const obfRows = Object.keys(obf).sort((a, b) => Number(a) - Number(b)).map((k) =>
      `<tr><td style="padding:2px 4px">floor ${esc(k)}</td>` +
      `<td style="text-align:right;padding:2px 4px">${esc(String(obf[k]))}</td></tr>`
    ).join('');

    const afBlock = af
      ? `<div style="margin-top:8px;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.2)">` +
        `<div style="font-size:11px;font-weight:600;margin-bottom:4px">Active floor — _Outdoors (what specular uses for this view)</div>` +
        `<table style="width:100%;border-collapse:collapse;font-size:10px">` +
        `<tr><td class="muted" style="padding:2px 0">Floor index</td><td style="padding:2px 4px">${esc(String(af.activeFloorIndex))}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">Compositor key</td><td style="padding:2px 4px"><code>${esc(String(af.activeCompositorKey || '—'))}</code></td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">Slot uRoofMapN</td><td style="padding:2px 4px">${esc(String(af.slotIndex))}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">Resolved mask key</td><td style="padding:2px 4px;font-size:9px"><code>${esc(String(af.resolvedCompositorKey || '—'))}</code></td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">Binding</td><td style="padding:2px 4px">${esc(String(af.binding || '—'))}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">Real compositor texture</td><td style="padding:2px 4px">${af.usesRealCompositorTexture ? '✓ yes' : '✗ no (see status)'}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">Texture UUID</td><td style="padding:2px 4px;font-size:9px;word-break:break-all">${esc(af.textureUuid || '—')}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">Size</td><td style="padding:2px 4px">${esc(af.textureSize || '—')}</td></tr>` +
        `</table></div>`
      : `<p class="muted" style="font-size:10px;margin-top:8px">No active floor outdoors snapshot (floor stack / index missing).</p>`;

    const sfAttempts = Array.isArray(d.singleFloorOutdoorsAttempts) ? d.singleFloorOutdoorsAttempts : [];
    const sfAttemptBlock = (!d.usePerFloor && sfAttempts.length)
      ? `<div class="muted" style="margin-top:10px;font-size:10px">Single-floor bind attempts (ordered)</div>` +
        `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:2px"><thead><tr style="opacity:0.85">` +
        `<th style="text-align:left;padding:2px 4px">step</th><th style="text-align:center;padding:2px 4px">hit</th>` +
        `<th style="text-align:left;padding:2px 4px">key</th><th style="text-align:left;padding:2px 4px">uuid / note</th>` +
        `</tr></thead><tbody>` +
        sfAttempts.map((a) =>
          `<tr${a.hit ? '' : ' style="background:rgba(255,69,58,0.06)"'}>` +
          `<td style="padding:2px 4px;font-size:9px">${esc(String(a.step || ''))}</td>` +
          `<td style="padding:2px 4px;text-align:center">${a.hit ? '✓' : '—'}</td>` +
          `<td style="padding:2px 4px;font-size:9px"><code>${esc(String(a.key || '—'))}</code></td>` +
          `<td style="padding:2px 4px;font-size:8px;word-break:break-all">${esc(a.uuid || a.note || '—')}</td>` +
          `</tr>`
        ).join('') +
        `</tbody></table>`
      : '';

    const wcBlock = wc
      ? `<div class="muted" style="margin-top:10px;font-size:10px;line-height:1.35">${esc(wc.note || '')}</div>` +
        `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:6px"><tbody>` +
        `<tr><td class="muted" style="padding:2px 4px">Outdoor cloud specular</td><td style="padding:2px 4px">${wc.outdoorCloudSpecularEnabled ? 'on' : 'off'} · blend ${esc(String(wc.outdoorStripeBlend))} · intensity ${esc(String(wc.cloudSpecularIntensity))}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 4px">Wet specular</td><td style="padding:2px 4px">${wc.wetSpecularEnabled ? 'on' : 'off'} · rainWetness ${esc(String(wc.rainWetnessUniform))} · intensity ${esc(String(wc.wetSpecularIntensity))}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 4px">Wet base / wind ripple</td><td style="padding:2px 4px">sheen ${esc(String(wc.wetBaseSheen))} · wind ${esc(String(wc.wetWindRippleStrength))}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 4px">Stripes / frost / bldg shadow suppr.</td><td style="padding:2px 4px">stripes ${wc.stripeEnabled ? 'on' : 'off'} · frost ${wc.frostGlazeEnabled ? 'on' : 'off'} · bldg ${wc.buildingShadowSuppressionEnabled ? 'on' : 'off'}</td></tr>` +
        `</tbody></table>` +
        `<p style="font-size:10px;opacity:0.85;margin:6px 0 0">If <strong>rainWetness</strong> is 0, weather is dry or uniforms were not updated yet this frame (<code>update()</code> vs <code>render()</code> order).</p>`
      : '';

    const rows = (d.outdoorsSlots || []).map((s) =>
      `<tr${s.isFallbackWhite ? ' style="background:rgba(255,69,58,0.08)"' : ''}>` +
      `<td style="padding:2px 4px">${esc(String(s.slot))}</td>` +
      `<td style="padding:2px 4px;font-size:10px">${esc(s.binding || '')}</td>` +
      `<td style="text-align:center;padding:2px 4px;font-size:9px">${s.isFallbackWhite ? '⚠' : ''}</td>` +
      `<td style="padding:2px 4px;font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis" title="${esc(s.resolvedCompositorKey || '')}">${esc(s.resolvedCompositorKey || '—')}</td>` +
      `<td style="padding:2px 4px;font-size:9px;word-break:break-all">${esc(s.textureUuid || '—')}</td>` +
      `<td style="padding:2px 4px;font-size:10px">${esc(s.textureSize || '—')}</td></tr>`
    ).join('');
    const fl = (d.floors || []).map((f) =>
      `<li style="font-size:10px">[${esc(String(f.index))}] <code>${esc(f.compositorKey)}</code> · elev ${esc(f.elevationMin)}–${esc(f.elevationMax)}</li>`
    ).join('');

    return `<div class="muted" style="margin-top:8px">Specular V2 — _Outdoors &amp; outdoorFactor consumers</div>` +
      `<p style="font-size:11px;margin:6px 0;line-height:1.4;padding:6px;border-radius:6px;border-left:3px solid ${esc(stColor)};background:rgba(255,255,255,0.04)">` +
      `<strong style="color:${esc(stColor)}">Status:</strong> <code style="font-size:10px">${esc(st)}</code><br/>` +
      `<span style="opacity:0.9">Shader mode: <code>${esc(String(d.shaderOutdoorsMode || '—'))}</code> · ` +
      `uUsePerFloorOutdoors: <strong>${esc(String(d.usePerFloorOutdoorsUniform))}</strong> · ` +
      `legacy <code>uRoofMap</code> bound: <strong>${esc(d.legacyRoofMapBound ? 'yes' : 'no')}</strong></span>` +
      `</p>` +
      `<p style="font-size:10px;margin:4px 0;opacity:0.88;line-height:1.35">${esc(d.decodeOutdoorsHint || '')}</p>` +
      `<p style="font-size:11px;margin:4px 0">Overlays: <strong>${esc(String(d.overlayCount))}</strong> · compositor present: <strong>${esc(d.compositorPresent ? 'yes' : 'no')}</strong> · floor stack: <strong>${esc(String(d.floorStackCount))}</strong></p>` +
      afBlock +
      sfAttemptBlock +
      wcBlock +
      `<div class="muted" style="margin-top:10px;font-size:10px">Overlays per tile floor index</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:2px"><tbody>${obfRows || '<tr><td class="muted">—</td></tr>'}</tbody></table>` +
      `<div class="muted" style="margin-top:8px;font-size:10px">Shader slot selection (uOutdoorsFloorIdx per overlay)</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:2px"><tbody>${histRows || '<tr><td class="muted">—</td></tr>'}</tbody></table>` +
      `<div class="muted" style="margin-top:8px;font-size:10px">FloorStack bands</div><ul style="margin:2px 0 6px 12px">${fl || '<li class="muted">None</li>'}</ul>` +
      `<div class="muted" style="margin-top:6px;font-size:10px">All uRoofMap0–3 slots (per-floor mode)</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:4px"><thead><tr style="opacity:0.85">` +
      `<th style="text-align:left;padding:2px 4px">slot</th><th style="text-align:left;padding:2px 4px">binding</th>` +
      `<th style="text-align:center;padding:2px 4px">fb</th>` +
      `<th style="text-align:left;padding:2px 4px">resolved key</th><th style="text-align:left;padding:2px 4px">uuid</th><th style="text-align:left;padding:2px 4px">size</th>` +
      `</tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">No slot data</td></tr>'}</tbody></table>` +
      `<p style="font-size:10px;opacity:0.8;margin:6px 0 0">Row highlight = <code>fallbackWhite</code> bound (full outdoor decode). <strong>fb</strong> column flags that slot.</p>`;
  }

  /**
   * @param {object} d
   * @returns {string}
   */
  _htmlGpuOutdoorsDetail(d) {
    if (!d.compositorPresent) {
      return `<div class="muted" style="margin-top:8px">GpuSceneMaskCompositor</div><p style="font-size:11px">${esc(d.message || 'Missing')}</p>`;
    }
    const sum = d.activeFloorOutdoorsSummary || null;
    const sumHtml = sum
      ? `<div style="margin-top:8px;padding:8px;border-radius:6px;border:1px solid rgba(139,197,255,0.25);background:rgba(139,197,255,0.06)">` +
        `<div style="font-size:11px;font-weight:600;margin-bottom:4px">Active floor (viewer) — GPU _Outdoors</div>` +
        `<table style="width:100%;border-collapse:collapse;font-size:10px">` +
        `<tr><td class="muted" style="padding:2px 0">Compositor key</td><td style="padding:2px 4px"><code>${esc(String(sum.compositorKey || '—'))}</code></td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">Resolvable texture</td><td style="padding:2px 4px">${sum.resolvedOutdoors ? '✓ yes' : '✗ no'}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">outdoors in cached bundle list</td><td style="padding:2px 4px">${sum.outdoorsInMetaBundle ? '✓' : '—'}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">getFloorTexture(direct key)</td><td style="padding:2px 4px">${sum.getFloorTextureHit ? '✓' : '—'}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">Texture UUID</td><td style="padding:2px 4px;font-size:9px;word-break:break-all">${esc(sum.textureUuid || '—')}</td></tr>` +
        `<tr><td class="muted" style="padding:2px 0">Note</td><td style="padding:2px 4px;font-size:9px">${esc(sum.resolvedNote || '—')}</td></tr>` +
        `</table></div>`
      : `<p class="muted" style="font-size:10px;margin-top:8px">No active floor row (floor stack empty).</p>`;

    const fr = (d.floorRows || []).map((r) =>
      `<tr${r.isActiveFloor ? ' style="background:rgba(139,197,255,0.1)"' : ''}>` +
      `<td style="padding:2px 4px">${r.isActiveFloor ? '▶ ' : ''}${esc(String(r.floorIndex))}</td>` +
      `<td style="padding:2px 4px;font-size:9px;max-width:88px;overflow:hidden;text-overflow:ellipsis" title="${esc(r.compositorKey)}">${esc(r.compositorKey)}</td>` +
      `<td style="text-align:center;padding:2px 4px">${r.bundleInMeta ? '✓' : '—'}</td>` +
      `<td style="text-align:center;padding:2px 4px">${r.outdoorsInMetaBundle ? '✓' : '—'}</td>` +
      `<td style="text-align:center;padding:2px 4px">${r.getFloorTextureHit ? '✓' : '—'}</td>` +
      `<td style="text-align:center;padding:2px 4px">${r.resolvedOutdoors ? '✓' : '—'}</td>` +
      `<td style="padding:2px 4px;font-size:8px;max-width:72px;overflow:hidden;word-break:break-all" title="${esc(r.textureUuid || '')}">${esc(r.textureUuid ? String(r.textureUuid).slice(0, 10) + '…' : '—')}</td>` +
      `<td style="padding:2px 4px;font-size:9px">${esc(r.resolvedNote || '')}</td></tr>`
    ).join('');
    const samp = (d.metaKeysSample || []).join(', ');
    return `<div class="muted" style="margin-top:8px">GpuSceneMaskCompositor — _Outdoors (scene mask RTs)</div>` +
      sumHtml +
      `<p style="font-size:10px;margin:8px 0 4px;opacity:0.88;line-height:1.35">${esc(d.outdoorsHelp || '')}</p>` +
      `<p style="font-size:10px;margin:4px 0;opacity:0.9">Active index ${esc(String(d.activeFloorIndex ?? '—'))} · key <code>${esc(String(d.activeCompositorKey || '—'))}</code> · _floorMeta keys: ${esc(String(d.metaKeyCount ?? 0))}</p>` +
      `<p style="font-size:10px;margin:4px 0;opacity:0.9">_floorMeta keys (sample): <code style="word-break:break-all">${esc(samp || '—')}</code></p>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:4px"><thead><tr style="opacity:0.85">` +
      `<th style="text-align:left;padding:2px 4px">fl</th><th style="text-align:left;padding:2px 4px">key</th>` +
      `<th style="text-align:center;padding:2px 4px">meta</th><th style="text-align:center;padding:2px 4px">out∈</th>` +
      `<th style="text-align:center;padding:2px 4px">RT</th><th style="text-align:center;padding:2px 4px">ok</th>` +
      `<th style="text-align:left;padding:2px 4px">uuid</th><th style="text-align:left;padding:2px 4px">note</th>` +
      `</tr></thead><tbody>${fr || '<tr><td colspan="8" class="muted">No floors</td></tr>'}</tbody></table>` +
      `<p style="font-size:10px;opacity:0.8;margin:6px 0 0"><strong>RT</strong> = <code>getFloorTexture</code> hit on compositor key. <strong>ok</strong> = resolvable for effects (incl. sibling key). ▶ row = active floor.</p>`;
  }

  /**
   * @param {object} d
   * @returns {string}
   */
  _htmlBuildingShadowsOutdoorsDetail(d) {
    if (!d || typeof d !== 'object') return '';
    const yn = (v) => (v ? '✓' : '—');
    const keys = Array.isArray(d.floorKeys) ? d.floorKeys.map((k) => esc(String(k))).join(', ') : '—';
    return (
      `<div class="muted" style="margin-top:8px">BuildingShadowsEffectV2 — _Outdoors &amp; draw</div>` +
      `<div style="margin-top:6px;padding:8px;border-radius:6px;border:1px solid rgba(255,200,120,0.25);background:rgba(255,200,120,0.06);font-size:10px;line-height:1.45">` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px"><tbody>` +
      `<tr><td class="muted" style="padding:2px 0;width:40%">Enabled</td><td style="padding:2px 4px">${d.paramsEnabled === false ? 'off' : 'on'}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Compositor</td><td style="padding:2px 4px">${yn(!!d.compositorPresent)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Drew shadow RT</td><td style="padding:2px 4px">${yn(!!d.drewAny)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Floor keys</td><td style="padding:2px 4px;font-size:9px"><code style="word-break:break-all">${keys}</code></td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Fallback-only draw</td><td style="padding:2px 4px">${yn(!!d.fallbackUsed)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Unified resolve</td><td style="padding:2px 4px;font-size:9px">${esc(String(d.outdoorsResolveRoute || '—'))} · <code>${esc(String(d.outdoorsResolveKey || '—'))}</code></td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Sync _outdoorsMask uuid</td><td style="padding:2px 4px;font-size:8px;word-break:break-all">${esc(d.syncOutdoorsMaskUuid || '—')}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Shadow factor uuid</td><td style="padding:2px 4px;font-size:8px;word-break:break-all">${esc(d.shadowFactorTextureUuid || '—')}</td></tr>` +
      `</tbody></table>` +
      (d.note ? `<p class="muted" style="margin:8px 0 0;font-size:10px">${esc(d.note)}</p>` : '') +
      `</div>`
    );
  }

  /**
   * End-to-end _Outdoors pipeline (manifest → tiles → GPU compositor → uniforms).
   * @param {object|null} t
   * @returns {string}
   */
  _htmlOutdoorsTrace(t) {
    if (!t || typeof t !== 'object') {
      return '<p class="muted" style="font-size:11px;margin-top:10px">Outdoors pipeline trace: unavailable.</p>';
    }
    const yn = (v) =>
      v
        ? '<span style="color:#30d158">yes</span>'
        : '<span style="color:#ff453a">no</span>';
    const briefTex = (b) => {
      if (!b || !b.present) return '<span class="muted">—</span>';
      return `<code style="font-size:8px;word-break:break-all">${esc(b.uuid || '')}</code><div class="muted" style="font-size:9px">${esc(b.size || '')}</div>`;
    };

    const sc = t.scene || {};
    const mf = t.manifest || {};
    const sb = t.sceneComposerBundle || {};
    const tm = t.tileManager || {};
    const gpu = t.gpuCompositor || {};
    const reg = t.registry?.outdoors || {};
    const wc = t.weatherController || {};
    const fcs = t.floorCompositorSync || {};
    const cons = t.consumers || {};

    const ids = Array.isArray(mf.enabledMaskIds) ? mf.enabledMaskIds : [];
    const idsShow = ids.slice(0, 24).map((id) => esc(String(id))).join(', ');
    const idsTail = ids.length > 24 ? ` <span class="muted">(+${ids.length - 24} more)</span>` : '';

    const bundleLine = sb.error
      ? '<span style="color:#ff453a">Error reading scene composer bundle</span>'
      : sb.present
        ? `${briefTex(sb)}<div class="muted" style="font-size:9px;margin-top:2px">bundle base: ${esc(sb.fromBasePath || '—')}</div>`
        : `<span class="muted">No texture on bundle entry</span> · in mask list: ${yn(!!sb.inBundleList)} · ${esc(sb.fromBasePath || '—')}`;

    const tileSamples = (tm.samples || [])
      .map(
        (s) =>
          `<tr><td style="padding:2px 4px;font-size:9px">${esc(s.tileId)}</td>` +
          `<td style="padding:2px 4px;font-size:9px">${esc(s.urlTail || '—')}</td>` +
          `<td style="padding:2px 4px;font-size:8px;word-break:break-all">${esc(s.uuid || '—')}</td>` +
          `<td style="padding:2px 4px;font-size:9px">${esc(s.size || '—')}</td></tr>`
      )
      .join('');

    const gft = (gpu.getFloorTextureAttempts || [])
      .map(
        (r) =>
          `<tr${r.hit ? '' : ' style="background:rgba(255,69,58,0.06)"'}>` +
          `<td style="padding:2px 4px;font-size:9px"><code>${esc(String(r.key))}</code></td>` +
          `<td style="padding:2px 4px;text-align:center">${yn(!!r.hit)}</td>` +
          `<td style="padding:2px 4px;font-size:8px;word-break:break-all">${esc(r.uuid || r.note || '—')}</td>` +
          `<td style="padding:2px 4px;font-size:9px">${esc(r.size || '—')}</td></tr>`
      )
      .join('');

    const fmeta = (gpu.floorMetaByKey || [])
      .slice(0, 16)
      .map(
        (r) =>
          `<tr>` +
          `<td style="padding:2px 4px;font-size:9px"><code>${esc(String(r.floorKey))}</code></td>` +
          `<td style="padding:2px 4px;text-align:center">${yn(!!r.outdoorsInList)}</td>` +
          `<td style="padding:2px 4px;font-size:8px;word-break:break-all">${esc(r.outdoorsUuid || '—')}</td>` +
          `<td style="padding:2px 4px;font-size:9px">${esc(r.outdoorsSize || '—')}</td></tr>`
      )
      .join('');

    const frt = (gpu.floorCacheGpuOutdoors || [])
      .slice(0, 16)
      .map(
        (r) =>
          `<tr>` +
          `<td style="padding:2px 4px;font-size:9px"><code>${esc(String(r.floorKey))}</code></td>` +
          `<td style="padding:2px 4px;text-align:center">${yn(!!r.outdoorsRenderTarget)}</td>` +
          `<td style="padding:2px 4px;font-size:8px;word-break:break-all">${esc(r.texUuid || '—')}</td></tr>`
      )
      .join('');

    const cloud = cons.cloud || {};
    const cloudPf = Array.isArray(cloud.perFloorSlotsNonNull)
      ? cloud.perFloorSlotsNonNull.map((x) => (x ? '●' : '○')).join(' ')
      : '—';

    return (
      `<div class="muted" style="margin-top:14px;font-weight:600">_Outdoors pipeline trace</div>` +
      `<p class="muted" style="font-size:10px;margin:4px 0 8px;line-height:1.35">` +
      `Follow the mask from <strong>settings / manifest</strong> into <strong>tile cache</strong>, ` +
      `<strong>GPU floor meta</strong>, then each <strong>consumer</strong> uniform. ` +
      `Red rows = <code>getFloorTexture</code> miss for that key.</p>` +
      `<div style="padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.18);font-size:10px;line-height:1.4">` +
      `<div style="font-weight:600;margin-bottom:4px;opacity:0.9">Scene / Levels</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px"><tbody>` +
      `<tr><td class="muted" style="padding:2px 0;width:38%">Levels extension</td><td style="padding:2px 4px">${yn(!!sc.levelsEnabled)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Floor stack count</td><td style="padding:2px 4px">${esc(String(sc.floorStackCount ?? '—'))}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Active level ctx</td><td style="padding:2px 4px;font-size:9px"><code>${esc(sc.activeLevelContext?.key ?? '—')}</code></td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Active floor</td><td style="padding:2px 4px;font-size:9px">idx ${esc(String(sc.activeFloor?.index ?? '—'))} · key <code>${esc(String(sc.activeFloor?.compositorKey ?? '—'))}</code></td></tr>` +
      `</tbody></table>` +
      `<div style="font-weight:600;margin:10px 0 4px;opacity:0.9">Manifest</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px"><tbody>` +
      `<tr><td class="muted" style="padding:2px 0;width:38%"><code>outdoors</code> in enabled mask IDs</td><td style="padding:2px 4px">${yn(!!mf.outdoorsInEnabledMaskIds)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Flag manifest loaded</td><td style="padding:2px 4px">${yn(!!mf.flagHasManifest)} · base ${esc(mf.flagBasePath || '—')}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Outdoors path in flag</td><td style="padding:2px 4px;font-size:9px;word-break:break-all">${esc(mf.outdoorsPathInFlag || '—')}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0;vertical-align:top">Enabled mask IDs</td><td style="padding:2px 4px;font-size:9px">${idsShow || '<span class="muted">—</span>'}${idsTail}</td></tr>` +
      `</tbody></table>` +
      `<div style="font-weight:600;margin:10px 0 4px;opacity:0.9">Scene composer bundle (current)</div>` +
      `<div style="font-size:10px">${bundleLine}</div>` +
      `<div style="font-weight:600;margin:10px 0 4px;opacity:0.9">Tile manager (<code>_tileEffectMasks</code>)</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:4px"><tbody>` +
      `<tr><td class="muted" style="padding:2px 0;width:38%">Cached tile mask maps</td><td style="padding:2px 4px">${esc(String(tm.cachedTileMaskMaps ?? 0))}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">Tiles with loaded outdoors tex</td><td style="padding:2px 4px">${esc(String(tm.tilesWithOutdoorsTexture ?? 0))}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">VRAM (effect masks)</td><td style="padding:2px 4px">${esc(String(tm.effectMaskVramMb ?? '—'))} / ${esc(String(tm.effectMaskVramBudgetMb ?? '—'))} MB budget</td></tr>` +
      `</tbody></table>` +
      `<div class="muted" style="font-size:9px;margin-bottom:2px">Sample tiles (up to 12)</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:6px"><thead><tr style="opacity:0.85">` +
      `<th style="text-align:left;padding:2px 4px">tile</th><th style="text-align:left;padding:2px 4px">url</th>` +
      `<th style="text-align:left;padding:2px 4px">uuid</th><th style="text-align:left;padding:2px 4px">size</th></tr></thead>` +
      `<tbody>${tileSamples || '<tr><td colspan="4" class="muted">No loaded outdoors rows in cache</td></tr>'}</tbody></table>` +
      `<div style="font-weight:600;margin:10px 0 4px;opacity:0.9">GPU compositor</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:4px"><tbody>` +
      `<tr><td class="muted" style="padding:2px 0;width:38%">Instance present</td><td style="padding:2px 4px">${yn(!!gpu.present)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0"><code>_activeFloorKey</code></td><td style="padding:2px 4px;font-size:9px"><code>${esc(String(gpu._activeFloorKey ?? '—'))}</code></td></tr>` +
      `</tbody></table>` +
      `<div class="muted" style="font-size:9px;margin-bottom:2px"><code>getFloorTexture(key, &apos;outdoors&apos;)</code> probe</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:6px"><thead><tr style="opacity:0.85">` +
      `<th style="text-align:left;padding:2px 4px">key</th><th style="text-align:center;padding:2px 4px">hit</th>` +
      `<th style="text-align:left;padding:2px 4px">uuid / err</th><th style="text-align:left;padding:2px 4px">size</th></tr></thead>` +
      `<tbody>${gft || '<tr><td colspan="4" class="muted">No probes (compositor missing)</td></tr>'}</tbody></table>` +
      `<div class="muted" style="font-size:9px;margin-bottom:2px"><code>_floorMeta</code> outdoors entry (per key, first 16)</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:6px"><thead><tr style="opacity:0.85">` +
      `<th style="text-align:left;padding:2px 4px">floorKey</th><th style="text-align:center;padding:2px 4px">out∈</th>` +
      `<th style="text-align:left;padding:2px 4px">uuid</th><th style="text-align:left;padding:2px 4px">size</th></tr></thead>` +
      `<tbody>${fmeta || '<tr><td colspan="4" class="muted">No _floorMeta rows</td></tr>'}</tbody></table>` +
      `<div class="muted" style="font-size:9px;margin-bottom:2px"><code>_floorCache</code> outdoors RT (first 16)</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:6px"><thead><tr style="opacity:0.85">` +
      `<th style="text-align:left;padding:2px 4px">floorKey</th><th style="text-align:center;padding:2px 4px">RT</th>` +
      `<th style="text-align:left;padding:2px 4px">tex uuid</th></tr></thead>` +
      `<tbody>${frt || '<tr><td colspan="3" class="muted">No cache rows</td></tr>'}</tbody></table>` +
      `<div style="font-weight:600;margin:10px 0 4px;opacity:0.9">Registry &amp; weather</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:6px"><tbody>` +
      `<tr><td class="muted" style="padding:2px 0;width:38%"><code>getMask(&apos;outdoors&apos;)</code></td><td style="padding:2px 4px">${briefTex(reg)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0"><code>weatherController.roofMap</code></td><td style="padding:2px 4px">${briefTex(wc.roofMap)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 0">FC <code>_lastOutdoorsTexture</code></td><td style="padding:2px 4px">${briefTex(fcs.lastOutdoorsTexture)} · key <code>${esc(String(fcs.lastOutdoorsFloorKey ?? '—'))}</code></td></tr>` +
      `</tbody></table>` +
      `<div style="font-weight:600;margin:10px 0 4px;opacity:0.9">Consumers (who bound a texture / flag)</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:10px"><tbody>` +
      `<tr><td class="muted" style="padding:2px 4px;vertical-align:top;width:34%">Building shadows</td><td style="padding:2px 4px">${briefTex(cons.buildingShadows?._outdoorsMaskSync)} · enabled ${yn(!!cons.buildingShadows?.paramsEnabled)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 4px;vertical-align:top">Water</td><td style="padding:2px 4px">uHas ${esc(String(cons.water?.uHasOutdoorsMask ?? '—'))} · ${briefTex(cons.water?.tOutdoorsMask)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 4px;vertical-align:top">Sky color</td><td style="padding:2px 4px">uHas ${esc(String(cons.skyColor?.uHasOutdoorsMask ?? '—'))} · ${briefTex(cons.skyColor?.tOutdoorsMask)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 4px;vertical-align:top">Lighting (roof)</td><td style="padding:2px 4px">uHas ${esc(String(cons.lighting?.uHasOutdoorsForRoofLight ?? '—'))} · ${briefTex(cons.lighting?.tOutdoorsForRoofLight)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 4px;vertical-align:top">Cloud</td><td style="padding:2px 4px">legacy ${briefTex(cloud.legacyOutdoorsMask)} · per-floor slots ${esc(cloudPf)}</td></tr>` +
      `<tr><td class="muted" style="padding:2px 4px;vertical-align:top">Overhead shadows</td><td style="padding:2px 4px">${briefTex(cons.overheadShadows?.outdoorsMask)}</td></tr>` +
      `</tbody></table>` +
      `</div>` +
      `<p class="muted" style="font-size:9px;margin:8px 0 0;line-height:1.35">` +
      `Full JSON: Breaker Box → <strong>Copy full health JSON</strong> includes <code>outdoorsTrace</code>.</p>`
    );
  }

  /**
   * @param {string|null} effectId
   * @returns {string}
   */
  _effectSurfaceDetailHtml(effectId) {
    if (!effectId || !this.healthEvaluator?.getEffectSurfaceDiagnostics) return '';
    const d = this.healthEvaluator.getEffectSurfaceDiagnostics(effectId);
    if (!d) return '';

    if (effectId === 'SpecularEffectV2') {
      return this._htmlSpecularOutdoorsDetail(d);
    }

    if (effectId === 'GpuSceneMaskCompositor') {
      return this._htmlGpuOutdoorsDetail(d);
    }

    if (effectId === 'BuildingShadowsEffectV2') {
      return this._htmlBuildingShadowsOutdoorsDetail(d);
    }

    return '';
  }

  _renderStackPanel(snapshot) {
    const el = this._stackScroll;
    if (!el) return;
    el.innerHTML = '';
    const rs = snapshot?.renderStack;
    const bindings = rs?.bindings || [];
    const selEffect = this._getSelectedEffectId();

    if (!rs?.passes?.length) {
      el.innerHTML = '<div class="muted" style="padding:6px">No render stack data (FloorCompositor missing).</div>';
      return;
    }

    for (const pass of rs.passes) {
      const passId = pass.id;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mapshine-breaker-stack-row';
      if (!pass.enabled) row.classList.add('disabled');
      if (this._selectedStackPassId === passId) row.classList.add('selected');
      if (selEffect && this._bindingTouchesPass(bindings, selEffect, passId)) row.classList.add('highlight');

      const en = pass.enabled ? 'on' : 'off';
      const bulbColor = pass.enabled ? colorForStatus('healthy') : colorForStatus('unknown');
      row.innerHTML = `
        <div class="row-top">
          <span class="bulb" style="width:9px;height:9px;border-radius:999px;background:${bulbColor};flex:0 0 9px;border:1px solid rgba(255,255,255,0.35)"></span>
          <span class="idx">${pass.stageIndex}</span>
          <span style="flex:1">${esc(pass.label)}</span>
          <span class="kind">${esc(pass.kind)} · ${esc(en)}</span>
        </div>
        ${pass.detail ? `<div style="font-size:10px;opacity:0.75;margin-top:4px;line-height:1.3">${esc(pass.detail)}</div>` : ''}
      `;
      row.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._selectedStackPassId = passId;
        this.render();
      });
      el.appendChild(row);

      if (Array.isArray(pass.subpasses) && pass.subpasses.length) {
        const subWrap = document.createElement('div');
        subWrap.className = 'mapshine-breaker-stack-sub';
        for (const sp of pass.subpasses) {
          const spId = sp.id;
          const sub = document.createElement('button');
          sub.type = 'button';
          sub.className = 'mapshine-breaker-stack-row';
          sub.style.marginBottom = '4px';
          if (!sp.enabled) sub.classList.add('disabled');
          if (this._selectedStackPassId === spId) sub.classList.add('selected');
          if (selEffect && this._bindingTouchesSubpass(bindings, selEffect, spId)) sub.classList.add('highlight');
          const sb = sp.enabled ? colorForStatus('healthy') : colorForStatus('unknown');
          sub.innerHTML = `
            <div class="row-top">
              <span class="bulb" style="width:8px;height:8px;border-radius:999px;background:${sb};flex:0 0 8px;border:1px solid rgba(255,255,255,0.35)"></span>
              <span style="flex:1;font-size:11px">${esc(sp.label)}</span>
            </div>
            ${sp.detail ? `<div style="font-size:10px;opacity:0.75;margin-top:3px">${esc(sp.detail)}</div>` : ''}
          `;
          sub.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._selectedStackPassId = spId;
            this.render();
          });
          subWrap.appendChild(sub);
        }
        el.appendChild(subWrap);
      }
    }

    const findings = snapshot.renderStackFindings || [];
    if (findings.length) {
      const fd = document.createElement('div');
      fd.className = 'mapshine-breaker-stack-findings';
      fd.innerHTML = '<strong style="font-size:11px">Stack checks</strong>';
      for (const f of findings) {
        const div = document.createElement('div');
        div.className = 'fi';
        const sev = f.severity || 'info';
        div.style.color = sev === 'warn' ? '#ffcc00' : sev === 'error' ? '#ff453a' : '#a8b0c0';
        div.textContent = `[${f.ruleId}] ${f.message}`;
        fd.appendChild(div);
      }
      el.appendChild(fd);
    }
  }

  _deriveSourceStatus(def, effectById) {
    let status = 'unknown';
    for (const effectId of def.effects) {
      const effect = effectById.get(effectId);
      if (!effect) continue;
      if (STATUS_WEIGHT[effect.status] > STATUS_WEIGHT[status]) status = effect.status;
      const checks = collectChecks(effect);
      for (const check of checks) {
        if (check.result !== 'fail') continue;
        const text = `${check.ruleId} ${check.message}`.toLowerCase();
        const matches = (def.keywords || []).some((kw) => text.includes(String(kw).toLowerCase()));
        if (!matches) continue;
        if ((check.severity || 'warn') === 'critical') status = 'critical';
        else if ((check.severity || 'warn') === 'error' && STATUS_WEIGHT.broken > STATUS_WEIGHT[status]) status = 'broken';
        else if (STATUS_WEIGHT.degraded > STATUS_WEIGHT[status]) status = 'degraded';
      }
    }
    return status;
  }

  _buildGraphModel(snapshot) {
    const effects = Array.isArray(snapshot?.effects) ? snapshot.effects : [];
    const effectById = new Map(effects.map((e) => [e.effectId, e]));

    const sourceNodes = SOURCE_DEFS
      .filter((def) => def.effects.some((effectId) => effectById.has(effectId)))
      .map((def) => ({
        id: def.id,
        kind: 'source',
        label: def.label,
        status: this._deriveSourceStatus(def, effectById),
        effects: [...def.effects],
      }));

    const effectNodes = effects.map((effect) => ({
      id: `effect:${effect.effectId}`,
      effectId: effect.effectId,
      kind: 'effect',
      label: effect.effectId,
      status: effect.status || 'unknown',
      effect,
    }));

    const nodeIndex = new Map();
    for (const node of [...sourceNodes, ...effectNodes]) nodeIndex.set(node.id, node);

    const edges = [];
    for (const source of sourceNodes) {
      const def = SOURCE_DEFS.find((d) => d.id === source.id);
      for (const effectId of def?.effects || []) {
        const targetId = `effect:${effectId}`;
        if (nodeIndex.has(targetId)) edges.push({ from: source.id, to: targetId, type: 'required' });
      }
    }
    for (const edge of snapshot?.edges || []) {
      const fromId = `effect:${edge.from}`;
      const toId = `effect:${edge.to}`;
      if (!nodeIndex.has(fromId) || !nodeIndex.has(toId)) continue;
      edges.push({ from: fromId, to: toId, type: edge.type || 'contextual' });
    }

    const depthByEffect = new Map(effectNodes.map((n) => [n.effectId, 0]));
    const effectOutgoing = new Map(effectNodes.map((n) => [n.effectId, []]));
    const effectInDegree = new Map(effectNodes.map((n) => [n.effectId, 0]));
    for (const edge of snapshot?.edges || []) {
      if (!effectOutgoing.has(edge?.from) || !effectOutgoing.has(edge?.to)) continue;
      effectOutgoing.get(edge.from).push(edge.to);
      effectInDegree.set(edge.to, Number(effectInDegree.get(edge.to) || 0) + 1);
    }
    const queue = [];
    for (const [id, deg] of effectInDegree.entries()) {
      if (deg === 0) queue.push(id);
    }
    while (queue.length) {
      const id = queue.shift();
      const fromDepth = Number(depthByEffect.get(id) || 0);
      for (const to of effectOutgoing.get(id) || []) {
        if (fromDepth + 1 > Number(depthByEffect.get(to) || 0)) depthByEffect.set(to, fromDepth + 1);
        const nextDeg = Number(effectInDegree.get(to) || 0) - 1;
        effectInDegree.set(to, nextDeg);
        if (nextDeg === 0) queue.push(to);
      }
    }
    for (const n of effectNodes) n.depth = Number(depthByEffect.get(n.effectId) || 0);
    return { sourceNodes, effectNodes, edges, nodeIndex, depthByEffect };
  }

  _layoutColumn(nodes, x, h, top = 24, bottom = 24) {
    const out = new Map();
    if (!nodes.length) return out;
    if (nodes.length === 1) {
      out.set(nodes[0].id, { x, y: h / 2 });
      return out;
    }
    const available = Math.max(20, h - top - bottom);
    const step = available / (nodes.length - 1);
    nodes.forEach((node, i) => out.set(node.id, { x, y: top + (i * step) }));
    return out;
  }

  _installDrag() {
    const header = this._header;
    const root = this.container;
    if (!header || !root) return;

    const startDrag = (ev) => {
      if (ev.button !== 0) return;
      const target = ev.target;
      if (target?.closest?.('button')) return;
      const rect = root.getBoundingClientRect();
      root.style.right = 'auto';
      root.style.left = `${rect.left}px`;
      root.style.top = `${rect.top}px`;
      this._drag = {
        offsetX: ev.clientX - rect.left,
        offsetY: ev.clientY - rect.top,
      };
      ev.preventDefault();
      ev.stopPropagation();
    };

    const onMove = (ev) => {
      if (!this._drag || !root) return;
      const vw = window.innerWidth || 1920;
      const vh = window.innerHeight || 1080;
      const rect = root.getBoundingClientRect();
      const nextLeft = Math.min(Math.max(6, ev.clientX - this._drag.offsetX), Math.max(6, vw - rect.width - 6));
      const nextTop = Math.min(Math.max(6, ev.clientY - this._drag.offsetY), Math.max(6, vh - 46));
      root.style.left = `${nextLeft}px`;
      root.style.top = `${nextTop}px`;
      this._lastRect = { left: nextLeft, top: nextTop };
    };

    const endDrag = () => { this._drag = null; };

    header.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', endDrag);
    this._dragCleanup = () => {
      header.removeEventListener('mousedown', startDrag);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', endDrag);
    };
  }

  _installGraphPanAndZoom() {
    const wrap = this._graphWrap;
    if (!wrap) return;
    const startPan = (ev) => {
      if (ev.button !== 0) return;
      const target = ev.target;
      if (target?.closest?.('.mapshine-breaker-node,button')) return;
      wrap.style.cursor = 'grabbing';
      this._graphPan = {
        x: ev.clientX,
        y: ev.clientY,
        sl: wrap.scrollLeft,
        st: wrap.scrollTop,
      };
      ev.preventDefault();
    };
    const onMove = (ev) => {
      if (!this._graphPan) return;
      const dx = ev.clientX - this._graphPan.x;
      const dy = ev.clientY - this._graphPan.y;
      wrap.scrollLeft = this._graphPan.sl - dx;
      wrap.scrollTop = this._graphPan.st - dy;
    };
    const endPan = () => {
      this._graphPan = null;
      wrap.style.cursor = 'grab';
    };
    const onWheel = (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      const dir = ev.deltaY > 0 ? -0.08 : 0.08;
      this._setGraphZoom(this._graphZoom + dir);
    };
    wrap.addEventListener('mousedown', startPan);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', endPan);
    wrap.addEventListener('wheel', onWheel, { passive: false });
    this._graphPanCleanup = () => {
      wrap.removeEventListener('mousedown', startPan);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', endPan);
      wrap.removeEventListener('wheel', onWheel);
    };
  }

  _setGraphZoom(value) {
    const clamped = Math.max(0.5, Math.min(2.5, Number(value || 1)));
    if (Math.abs(clamped - this._graphZoom) < 0.0001) return;
    this._graphZoom = clamped;
    if (this._zoomLabel) this._zoomLabel.textContent = `${Math.round(this._graphZoom * 100)}%`;
    if (this._visible) this.render();
  }

  _buildIncomingMap(model) {
    const incoming = new Map();
    for (const n of model.effectNodes) incoming.set(n.id, []);
    for (const edge of model.edges) {
      if (!incoming.has(edge.to)) continue;
      incoming.get(edge.to).push(edge.from);
    }
    return incoming;
  }

  _orderColumns(effectCols, sourceCol, model) {
    const ordered = new Map();
    const sourceOrder = new Map();
    sourceCol.forEach((n, idx) => sourceOrder.set(n.id, idx));
    const incoming = this._buildIncomingMap(model);
    const effectOrder = new Map();

    const colIndexes = Array.from(effectCols.keys()).sort((a, b) => a - b);
    for (const colIdx of colIndexes) {
      const nodes = [...(effectCols.get(colIdx) || [])];
      for (const n of nodes) {
        const refs = incoming.get(n.id) || [];
        if (!refs.length) {
          n._layoutScore = Number(effectOrder.get(`effect:${n.effectId}`) ?? sourceOrder.get(n.id) ?? 9999);
          continue;
        }
        let sum = 0;
        let count = 0;
        for (const fromId of refs) {
          const srcRank = sourceOrder.get(fromId);
          const effRank = effectOrder.get(fromId);
          const rank = Number.isFinite(srcRank) ? srcRank : (Number.isFinite(effRank) ? effRank : NaN);
          if (!Number.isFinite(rank)) continue;
          sum += rank;
          count++;
        }
        n._layoutScore = count > 0 ? (sum / count) : 9999;
      }

      nodes.sort((a, b) => {
        const da = Number.isFinite(a._layoutScore) ? a._layoutScore : 9999;
        const db = Number.isFinite(b._layoutScore) ? b._layoutScore : 9999;
        if (da !== db) return da - db;
        return a.label.localeCompare(b.label);
      });
      nodes.forEach((n, i) => effectOrder.set(n.id, i));
      ordered.set(colIdx, nodes);
    }
    return ordered;
  }

  _renderGraph(snapshot) {
    if (!this._graphSvg || !this._nodesLayer || !this._graphWrap) return;
    const model = this._buildGraphModel(snapshot);
    this._graphModel = model;

    const rowGap = Math.round(58 * this._graphZoom);
    const colGap = Math.round(250 * this._graphZoom);
    const marginX = Math.round(26 * this._graphZoom);
    const marginY = Math.round(24 * this._graphZoom);
    const sourceCol = [...model.sourceNodes];
    const effectCols = new Map();
    for (const node of model.effectNodes) {
      const col = Number(node.depth || 0);
      const arr = effectCols.get(col) || [];
      arr.push(node);
      effectCols.set(col, arr);
    }
    const orderedCols = this._orderColumns(effectCols, sourceCol, model);
    const effectColIndexes = Array.from(effectCols.keys()).sort((a, b) => a - b);
    const totalCols = 1 + Math.max(1, effectColIndexes.length);
    const maxRows = Math.max(
      sourceCol.length,
      ...effectColIndexes.map((idx) => (effectCols.get(idx) || []).length),
      1
    );

    const wrapW = Math.max(560, Math.floor(this._graphWrap.clientWidth || 560));
    const wrapH = Math.max(280, Math.floor(this._graphWrap.clientHeight || 280));
    const w = Math.max(wrapW, marginX * 2 + ((totalCols - 1) * colGap) + 220);
    const h = Math.max(wrapH, marginY * 2 + ((maxRows - 1) * rowGap) + 80);
    this._graphSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this._graphSvg.style.width = `${w}px`;
    this._graphSvg.style.height = `${h}px`;
    this._nodesLayer.style.width = `${w}px`;
    this._nodesLayer.style.height = `${h}px`;
    this._graphSvg.innerHTML = '';
    this._nodesLayer.innerHTML = '';

    const pos = new Map();
    const leftX = marginX + 95;
    sourceCol.forEach((node, i) => {
      pos.set(node.id, { x: leftX, y: marginY + (i * rowGap) + 24 });
    });
    for (const colIdx of effectColIndexes) {
      const colNodes = orderedCols.get(colIdx) || effectCols.get(colIdx) || [];
      const x = marginX + 95 + ((colIdx + 1) * colGap);
      colNodes.forEach((node, i) => {
        pos.set(node.id, { x, y: marginY + (i * rowGap) + 24 });
      });
    }

    const ns = 'http://www.w3.org/2000/svg';
    const outgoingByNode = new Map();
    const incomingByNode = new Map();
    for (const edge of model.edges) {
      const out = outgoingByNode.get(edge.from) || [];
      out.push(edge);
      outgoingByNode.set(edge.from, out);
      const inc = incomingByNode.get(edge.to) || [];
      inc.push(edge);
      incomingByNode.set(edge.to, inc);
    }
    const edgeOutIndex = new Map();
    const edgeInIndex = new Map();
    const edgeKey = (e) => `${e.from}->${e.to}:${e.type || 'required'}`;
    for (const [fromId, list] of outgoingByNode.entries()) {
      list.sort((a, b) => (pos.get(a.to)?.y || 0) - (pos.get(b.to)?.y || 0));
      list.forEach((e, i) => edgeOutIndex.set(`${edgeKey(e)}|${fromId}`, { i, total: list.length }));
    }
    for (const [toId, list] of incomingByNode.entries()) {
      list.sort((a, b) => (pos.get(a.from)?.y || 0) - (pos.get(b.from)?.y || 0));
      list.forEach((e, i) => edgeInIndex.set(`${edgeKey(e)}|${toId}`, { i, total: list.length }));
    }

    for (const edge of model.edges) {
      const a = pos.get(edge.from);
      const b = pos.get(edge.to);
      if (!a || !b) continue;
      const fromNode = model.nodeIndex.get(edge.from);
      const toNode = model.nodeIndex.get(edge.to);
      const fromW = (fromNode?.kind === 'source' ? 190 : 178) * this._graphZoom;
      const toW = (toNode?.kind === 'source' ? 190 : 178) * this._graphZoom;
      const ax = a.x + (fromW / 2) - 6;
      const bx = b.x - (toW / 2) + 6;
      const path = document.createElementNS(ns, 'path');
      const dx = Math.max(24, Math.abs(bx - ax));
      const bend = Math.min(140, dx * 0.48);
      const c1x = ax + bend;
      const c2x = bx - bend;
      const k = edgeKey(edge);
      const outMeta = edgeOutIndex.get(`${k}|${edge.from}`) || { i: 0, total: 1 };
      const inMeta = edgeInIndex.get(`${k}|${edge.to}`) || { i: 0, total: 1 };
      const outCenter = (outMeta.total - 1) / 2;
      const inCenter = (inMeta.total - 1) / 2;
      const laneGap = Math.max(4, Math.round(6 * this._graphZoom));
      const ay = a.y + ((outMeta.i - outCenter) * laneGap);
      const by = b.y + ((inMeta.i - inCenter) * laneGap);
      path.setAttribute('d', `M ${ax} ${ay} C ${c1x} ${ay}, ${c2x} ${by}, ${bx} ${by}`);
      path.setAttribute('class', `mapshine-breaker-edge ${esc(edge.type || 'contextual')}`);
      this._graphSvg.appendChild(path);
    }

    for (const node of [...model.sourceNodes, ...model.effectNodes]) {
      const p = pos.get(node.id);
      if (!p) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `mapshine-breaker-node kind-${node.kind}`;
      if (node.id === this._selectedNodeId) btn.classList.add('selected');
      btn.style.width = `${Math.round((node.kind === 'source' ? 190 : 178) * this._graphZoom)}px`;
      btn.style.padding = `${Math.max(4, Math.round(6 * this._graphZoom))}px ${Math.max(6, Math.round(8 * this._graphZoom))}px`;
      btn.style.fontSize = `${Math.max(11, Math.round(12 * this._graphZoom))}px`;
      btn.style.left = `${p.x}px`;
      btn.style.top = `${p.y}px`;
      btn.title = `${node.label} (${node.status})`;
      btn.innerHTML = `
        <span class="bulb" style="background:${colorForStatus(node.status)};"></span>
        <span>
          <div class="label">${esc(node.label)}</div>
          <div class="sub">${esc(node.kind === 'source' ? 'Source' : 'Effect')} · ${esc(node.status)}</div>
        </span>
      `;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._selectedNodeId = node.id;
        this._renderGraph(snapshot);
        this._renderDetails(snapshot);
      });
      this._nodesLayer.appendChild(btn);
    }

    if (!this._selectedNodeId || !model.nodeIndex.has(this._selectedNodeId)) {
      const firstBad = [...model.effectNodes, ...model.sourceNodes]
        .find((n) => STATUS_WEIGHT[n.status] >= STATUS_WEIGHT.degraded);
      const next = firstBad?.id || model.effectNodes[0]?.id || model.sourceNodes[0]?.id || null;
      if (next && next !== this._selectedNodeId) {
        this._selectedNodeId = next;
        this._renderGraph(snapshot);
        return;
      }
      this._selectedNodeId = next;
    }
  }

  _renderDetails(snapshot) {
    if (!this._detail) return;
    const selected = this._graphModel?.nodeIndex?.get(this._selectedNodeId) || null;
    if (!selected) {
      this._detail.innerHTML = '<div class="muted">Select a source/effect bulb to inspect diagnostics.</div>';
      if (this._copyNodeBtn) this._copyNodeBtn.disabled = true;
      return;
    }
    if (this._copyNodeBtn) this._copyNodeBtn.disabled = false;

    if (selected.kind === 'source') {
      const effectRows = selected.effects.map((effectId) => {
        const effect = (snapshot.effects || []).find((e) => e.effectId === effectId);
        return `<li>${esc(effectId)}: <strong>${esc(effect?.status || 'unknown')}</strong></li>`;
      }).join('');
      let specGpuBlock = '';
      if (selected.id === 'src:specularOutdoors' && this.healthEvaluator?.getEffectSurfaceDiagnostics) {
        const dSpec = this.healthEvaluator.getEffectSurfaceDiagnostics('SpecularEffectV2');
        const dGpu = this.healthEvaluator.getEffectSurfaceDiagnostics('GpuSceneMaskCompositor');
        const trace = this.healthEvaluator.getOutdoorsTraceDiagnostics?.() ?? null;
        specGpuBlock =
          '<div class="muted" style="margin-top:12px;font-weight:600">_Outdoors + specular (full dump)</div>' +
          '<p class="muted" style="font-size:10px;margin:4px 0 8px">Same panels as selecting SpecularEffectV2 or GpuSceneMaskCompositor — shown here so the source bulb is enough.</p>' +
          (dSpec ? this._htmlSpecularOutdoorsDetail(dSpec) : '<p class="muted">SpecularEffectV2: no render diagnostics yet.</p>') +
          (dGpu ? this._htmlGpuOutdoorsDetail(dGpu) : '<p class="muted">GpuSceneMaskCompositor: unavailable.</p>') +
          this._htmlOutdoorsTrace(trace);
      }
      this._detail.innerHTML = `
        <div><strong>${esc(selected.label)}</strong> <span class="muted">(source)</span></div>
        <div>Status: <strong style="color:${colorForStatus(selected.status)}">${esc(selected.status)}</strong></div>
        <div class="muted">Linked effects:</div>
        <ul>${effectRows || '<li>None</li>'}</ul>
        ${specGpuBlock}
      `;
      return;
    }

    const effect = selected.effect;
    const byLevel = (effect?.byLevel || [])
      .slice()
      .sort((a, b) => String(a.levelKey).localeCompare(String(b.levelKey)))
      .map((lvl) => `<li>${esc(lvl.levelKey)}: <strong>${esc(lvl.status)}</strong>${lvl.rootCause ? ' (root cause)' : ''}</li>`)
      .join('');

    const af = Number(snapshot.runtime?.activeFloor ?? 0);
    const afKey = `floor:${af}`;
    const activeRow =
      (effect?.byLevel || []).find((l) => l.levelKey === afKey) ||
      (effect?.effectId === 'PlayerLightEffectV2'
        ? (effect?.byLevel || []).find((l) => l.levelKey === 'global:active')
        : null);

    const allFailed = collectChecks(effect).filter((c) => c.result === 'fail');
    const { direct, propagated } = partitionFailedChecks(allFailed);
    const fmtFail = (c) =>
      `<li style="line-height:1.35"><span class="muted">${esc(c.levelKey)}</span> · <code style="font-size:10px">${esc(c.ruleId)}</code><br/>${esc(c.message)}</li>`;
    const directBlock =
      direct.slice(0, 8).map(fmtFail).join('') || '<li class="muted">None — no direct contract failures.</li>';
    const propBlock =
      propagated.slice(0, 6).map(fmtFail).join('') ||
      '<li class="muted">None — no dependency-graph propagation on this effect.</li>';

    const pipelineBlock = this._pipelineDetailHtml(snapshot, effect?.effectId);
    const surfaceBlock = this._effectSurfaceDetailHtml(effect?.effectId);

    this._detail.innerHTML = `
      <div><strong>${esc(effect?.effectId || selected.label)}</strong> <span class="muted">(effect)</span></div>
      <div>Aggregate status: <strong style="color:${colorForStatus(effect?.status)}">${esc(effect?.status || 'unknown')}</strong></div>
      <div style="margin-top:4px;font-size:11px">This floor (${af}): <strong style="color:${colorForStatus(activeRow?.status || 'unknown')}">${esc(activeRow?.status || 'n/a')}</strong></div>
      <div class="muted" style="margin-top:6px">Level rows:</div>
      <ul>${byLevel || '<li>None</li>'}</ul>
      <div class="muted" style="margin-top:6px">Direct failures (contracts):</div>
      <ul style="margin-top:4px">${directBlock}</ul>
      <div class="muted" style="margin-top:6px">Graph propagation (upstream → this effect):</div>
      <ul style="margin-top:4px">${propBlock}</ul>
      ${pipelineBlock}
      ${surfaceBlock}
    `;
  }

  _buildNodeDiagnostic(nodeId, snapshot) {
    const selected = this._graphModel?.nodeIndex?.get(nodeId) || null;
    const base = {
      meta: {
        timestamp: new Date().toISOString(),
        selectedNodeId: nodeId || null,
      },
      runtime: snapshot?.runtime || null,
      node: null,
    };
    if (!selected) return base;
    if (selected.kind === 'source') {
      const node = {
        kind: 'source',
        id: selected.id,
        label: selected.label,
        status: selected.status,
        linkedEffects: selected.effects.map((effectId) => {
          const effect = (snapshot?.effects || []).find((e) => e.effectId === effectId);
          return {
            effectId,
            status: effect?.status || 'unknown',
            byLevel: effect?.byLevel || [],
          };
        }),
      };
      if (selected.id === 'src:specularOutdoors' && this.healthEvaluator?.getEffectSurfaceDiagnostics) {
        node.specularOutdoorsDiagnostics = {
          specularEffectV2: this.healthEvaluator.getEffectSurfaceDiagnostics('SpecularEffectV2'),
          gpuSceneMaskCompositor: this.healthEvaluator.getEffectSurfaceDiagnostics('GpuSceneMaskCompositor'),
        };
        if (this.healthEvaluator.getOutdoorsTraceDiagnostics) {
          node.outdoorsTrace = this.healthEvaluator.getOutdoorsTraceDiagnostics();
        }
      }
      return { ...base, node };
    }
    const stackBinds = (snapshot?.renderStack?.bindings || []).filter((b) => b.effectId === selected.effectId);
    const surfaceDx = ['SpecularEffectV2', 'GpuSceneMaskCompositor', 'BuildingShadowsEffectV2'].includes(selected.effectId)
      ? (this.healthEvaluator?.getEffectSurfaceDiagnostics?.(selected.effectId) ?? null)
      : null;
    return {
      ...base,
      node: {
        kind: 'effect',
        id: selected.id,
        effectId: selected.effectId,
        status: selected.status,
        payload: selected.effect || null,
        surfaceDiagnostics: surfaceDx,
      },
      graphEdges: (snapshot?.edges || []).filter((e) =>
        e?.from === selected.effectId || e?.to === selected.effectId
      ),
      renderStackBindings: stackBinds,
    };
  }

  render() {
    if (!this._content) return;
    const snapshot = this.healthEvaluator?.getSnapshot?.() || null;
    if (!snapshot) {
      this._content.textContent = 'Health evaluator not available.';
      if (this._detail) this._detail.textContent = 'No graph data.';
      if (this._stackScroll) this._stackScroll.innerHTML = '<div class="muted" style="padding:6px">No data.</div>';
      return;
    }

    if (this._overall) {
      const af = Number(snapshot.runtime?.activeFloor ?? 0);
      const afs = snapshot.activeFloorOverallStatus || snapshot.meta?.activeFloorOverallStatus || 'unknown';
      this._overall.innerHTML = `
        <div>All tracked levels: <strong style="color:${colorForStatus(snapshot.overallStatus)}">${esc(snapshot.overallStatus)}</strong></div>
        <div style="margin-top:4px;font-size:12px">Current floor (${af}): <strong style="color:${colorForStatus(afs)}">${esc(afs)}</strong></div>
      `;
    }

    this._renderGraph(snapshot);
    this._renderStackPanel(snapshot);
    this._renderDetails(snapshot);

    const lines = [
      `Runtime`,
      `Active floor: ${snapshot.runtime?.activeFloor ?? 'n/a'}`,
      `Visible floors: ${(snapshot.runtime?.visibleFloors || []).join(', ') || 'n/a'}`,
      `Level context: ${snapshot.runtime?.levelContextKey ?? 'n/a'}`,
      `FPS: ${Number(snapshot.runtime?.frameState?.fps ?? 0).toFixed(1)}`,
    ];
    this._content.textContent = lines.join('\n');
  }

  show() {
    this.initialize();
    this.render();
    if (this.container) {
      this.container.style.left = `${this._lastRect.left}px`;
      this.container.style.top = `${this._lastRect.top}px`;
      this.container.style.right = 'auto';
    }
    if (this.container) this.container.style.display = 'block';
    this._visible = true;
    if (this._zoomLabel) this._zoomLabel.textContent = `${Math.round(this._graphZoom * 100)}%`;
  }

  hide() {
    if (this.container) this.container.style.display = 'none';
    this._visible = false;
  }

  toggle() {
    if (this._visible) this.hide();
    else this.show();
  }

  dispose() {
    try { this._unsubscribe?.(); } catch (_) {}
    this._unsubscribe = null;
    try { this._resizeObserver?.disconnect?.(); } catch (_) {}
    this._resizeObserver = null;
    try { this._dragCleanup?.(); } catch (_) {}
    this._dragCleanup = null;
    try { this._graphPanCleanup?.(); } catch (_) {}
    this._graphPanCleanup = null;
    if (this.container?.parentElement) this.container.parentElement.removeChild(this.container);
    this.container = null;
    this._content = null;
    this._graphWrap = null;
    this._graphSvg = null;
    this._nodesLayer = null;
    this._stackScroll = null;
    this._splitWrap = null;
    this._detail = null;
    this._overall = null;
    this._copyNodeBtn = null;
    this._graphModel = null;
    this._visible = false;
    log.debug('Breaker Box disposed');
  }
}

