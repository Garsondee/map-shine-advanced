import { createLogger } from '../core/log.js';

const log = createLogger('SelectionBoxEffect');

/**
 * SelectionBoxEffect
 * Owns all drag-select visuals:
 * - Screen-space SVG overlay (border styles, patterns, label)
 * - World-space projected shadow mesh
 * - Animation (marching ants / pulse)
 */
export class SelectionBoxEffect {
  /**
   * @param {import('../scene/interaction-manager.js').InteractionManager} interactionManager
   */
  constructor(interactionManager) {
    this.im = interactionManager;
  }

  initialize() {
    try {
      this.createSelectionOverlay();
      this.createSelectionShadow();
      this.createSelectionIllumination();
    } catch (e) {
      log.warn('Failed to initialize SelectionBoxEffect', e);
    }
  }

  dispose() {
    try {
      const ds = this.im?.dragSelect;
      if (ds?.overlayEl?.parentNode) {
        ds.overlayEl.parentNode.removeChild(ds.overlayEl);
      }
      if (ds) ds.overlayEl = null;

      if (ds?.shadowMesh) {
        try { this.im.sceneComposer?.scene?.remove?.(ds.shadowMesh); } catch (_) {}
        try { ds.shadowMesh.geometry?.dispose?.(); } catch (_) {}
        try { ds.shadowMaterial?.dispose?.(); } catch (_) {}
        ds.shadowMesh = null;
        ds.shadowMaterial = null;
      }

      if (ds?.illuminationMesh) {
        try { this.im.sceneComposer?.scene?.remove?.(ds.illuminationMesh); } catch (_) {}
        try { ds.illuminationMesh.geometry?.dispose?.(); } catch (_) {}
        try { ds.illuminationMaterial?.dispose?.(); } catch (_) {}
        ds.illuminationMesh = null;
        ds.illuminationMaterial = null;
      }

      if (this.im?._selectionOverlay) {
        this.im._selectionOverlay.svg = null;
        this.im._selectionOverlay.defs = null;
        this.im._selectionOverlay.baseRect = null;
        this.im._selectionOverlay.patternRect = null;
        this.im._selectionOverlay.strokeRect = null;
        this.im._selectionOverlay.strokeRect2 = null;
        this.im._selectionOverlay.reticleH = null;
        this.im._selectionOverlay.reticleV = null;
        this.im._selectionOverlay.bracketsPath = null;
        this.im._selectionOverlay.labelEl = null;
        this.im._selectionOverlay.ids = null;
        this.im._selectionOverlay._strokeGradient = null;
        this.im._selectionOverlay._strokeGradientStopA = null;
        this.im._selectionOverlay._strokeGradientStopB = null;
      }
    } catch (_) {
    }
  }

  applyParamChange(paramId, value) {
    const im = this.im;
    if (!im?.selectionBoxParams) return;

    const p = im.selectionBoxParams;

    if (Object.prototype.hasOwnProperty.call(p, paramId)) {
      p[paramId] = value;
    }

    if (paramId === 'outlineColor' && value && typeof value === 'object') {
      p.outlineColor = value;
    }

    this._applySelectionOverlayStyles();
    this._applySelectionShadowParams();
    this._applySelectionIlluminationParams();

    if (p.enabled === false) {
      if (im.dragSelect?.overlayEl) im.dragSelect.overlayEl.style.display = 'none';
      this._hideSelectionShadow();
      this._hideSelectionIllumination();
    }
  }

  createSelectionOverlay() {
    const im = this.im;
    const ds = im.dragSelect;

    // If already created (hot reload), remove old.
    if (ds.overlayEl?.parentNode) {
      try { ds.overlayEl.parentNode.removeChild(ds.overlayEl); } catch (_) {}
      ds.overlayEl = null;
    }

    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '9999';
    el.style.display = 'none';
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.width = '0px';
    el.style.height = '0px';

    // SVG overlay (border styles + patterns)
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.position = 'absolute';
    svg.style.left = '0';
    svg.style.top = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.overflow = 'visible';

    const defs = document.createElementNS(SVG_NS, 'defs');
    svg.appendChild(defs);

    // Unique IDs to avoid collisions with other SVGS in the DOM.
    const ids = {
      basePatternGrid: `msSelGrid_${Math.random().toString(16).slice(2)}`,
      basePatternDiag: `msSelDiag_${Math.random().toString(16).slice(2)}`,
      basePatternDots: `msSelDots_${Math.random().toString(16).slice(2)}`,
      strokeGradient: `msSelGrad_${Math.random().toString(16).slice(2)}`
    };

    const baseRect = document.createElementNS(SVG_NS, 'rect');
    const patternRect = document.createElementNS(SVG_NS, 'rect');
    const strokeRect = document.createElementNS(SVG_NS, 'rect');
    const strokeRect2 = document.createElementNS(SVG_NS, 'rect');

    const reticleH = document.createElementNS(SVG_NS, 'line');
    const reticleV = document.createElementNS(SVG_NS, 'line');
    const bracketsPath = document.createElementNS(SVG_NS, 'path');

    baseRect.setAttribute('x', '0');
    baseRect.setAttribute('y', '0');
    patternRect.setAttribute('x', '0');
    patternRect.setAttribute('y', '0');
    strokeRect.setAttribute('x', '0');
    strokeRect.setAttribute('y', '0');
    strokeRect2.setAttribute('x', '0');
    strokeRect2.setAttribute('y', '0');

    // Draw order: fill -> pattern -> stroke
    svg.appendChild(baseRect);
    svg.appendChild(patternRect);
    svg.appendChild(reticleH);
    svg.appendChild(reticleV);
    svg.appendChild(bracketsPath);
    svg.appendChild(strokeRect);
    svg.appendChild(strokeRect2);

    // Label
    const labelEl = document.createElement('div');
    labelEl.style.position = 'absolute';
    labelEl.style.left = '6px';
    labelEl.style.top = '6px';
    labelEl.style.padding = '2px 6px';
    labelEl.style.borderRadius = '4px';
    labelEl.style.background = 'rgba(0,0,0,0.45)';
    labelEl.style.color = 'white';
    labelEl.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    labelEl.style.fontWeight = '600';
    labelEl.style.letterSpacing = '0.2px';
    labelEl.style.pointerEvents = 'none';
    labelEl.style.display = 'none';

    el.appendChild(svg);
    el.appendChild(labelEl);
    document.body.appendChild(el);

    ds.overlayEl = el;

    // Reuse InteractionManager's cache container to keep patch small.
    im._selectionOverlay.svg = svg;
    im._selectionOverlay.defs = defs;
    im._selectionOverlay.baseRect = baseRect;
    im._selectionOverlay.patternRect = patternRect;
    im._selectionOverlay.strokeRect = strokeRect;
    im._selectionOverlay.strokeRect2 = strokeRect2;
    im._selectionOverlay.reticleH = reticleH;
    im._selectionOverlay.reticleV = reticleV;
    im._selectionOverlay.bracketsPath = bracketsPath;
    im._selectionOverlay.labelEl = labelEl;
    im._selectionOverlay.ids = ids;

    this._ensureSelectionPatterns();
    this._ensureSelectionGradient();
    this._applySelectionOverlayStyles();
  }

  _ensureSelectionGradient() {
    const im = this.im;
    const ov = im._selectionOverlay;
    if (!ov?.defs || !ov?.ids) return;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', ov.ids.strokeGradient);
    grad.setAttribute('gradientUnits', 'objectBoundingBox');
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '1');
    grad.setAttribute('y2', '0');

    const stopA = document.createElementNS(SVG_NS, 'stop');
    stopA.setAttribute('offset', '0%');
    stopA.setAttribute('stop-color', 'rgba(0,255,255,1.0)');
    const stopB = document.createElementNS(SVG_NS, 'stop');
    stopB.setAttribute('offset', '100%');
    stopB.setAttribute('stop-color', 'rgba(255,0,255,1.0)');
    grad.appendChild(stopA);
    grad.appendChild(stopB);
    ov.defs.appendChild(grad);

    ov._strokeGradient = grad;
    ov._strokeGradientStopA = stopA;
    ov._strokeGradientStopB = stopB;
  }

  _ensureSelectionPatterns() {
    const im = this.im;
    const ov = im._selectionOverlay;
    if (!ov?.defs || !ov?.ids) return;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const defs = ov.defs;

    // Grid pattern
    const grid = document.createElementNS(SVG_NS, 'pattern');
    grid.setAttribute('id', ov.ids.basePatternGrid);
    grid.setAttribute('patternUnits', 'userSpaceOnUse');
    grid.setAttribute('width', '18');
    grid.setAttribute('height', '18');
    const gridPath = document.createElementNS(SVG_NS, 'path');
    gridPath.setAttribute('d', 'M 18 0 L 0 0 0 18');
    gridPath.setAttribute('fill', 'none');
    gridPath.setAttribute('stroke', 'rgba(255,255,255,0.2)');
    gridPath.setAttribute('stroke-width', '1');
    grid.appendChild(gridPath);
    defs.appendChild(grid);
    ov._gridPath = gridPath;

    // Diagonal pattern
    const diag = document.createElementNS(SVG_NS, 'pattern');
    diag.setAttribute('id', ov.ids.basePatternDiag);
    diag.setAttribute('patternUnits', 'userSpaceOnUse');
    diag.setAttribute('width', '16');
    diag.setAttribute('height', '16');
    const diagPath = document.createElementNS(SVG_NS, 'path');
    diagPath.setAttribute('d', 'M -4 16 L 16 -4 M 0 20 L 20 0');
    diagPath.setAttribute('fill', 'none');
    diagPath.setAttribute('stroke', 'rgba(255,255,255,0.2)');
    diagPath.setAttribute('stroke-width', '1');
    diag.appendChild(diagPath);
    defs.appendChild(diag);
    ov._diagPath = diagPath;

    // Dots pattern
    const dots = document.createElementNS(SVG_NS, 'pattern');
    dots.setAttribute('id', ov.ids.basePatternDots);
    dots.setAttribute('patternUnits', 'userSpaceOnUse');
    dots.setAttribute('width', '18');
    dots.setAttribute('height', '18');
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', '9');
    dot.setAttribute('cy', '9');
    dot.setAttribute('r', '1.5');
    dot.setAttribute('fill', 'rgba(255,255,255,0.25)');
    dots.appendChild(dot);
    defs.appendChild(dots);
    ov._dot = dot;
  }

  _applySelectionOverlayStyles() {
    const im = this.im;
    const el = im.dragSelect.overlayEl;
    if (!el) return;

    const p = im.selectionBoxParams || {};
    const enabled = p.enabled !== false;
    if (!enabled && !im.dragSelect?.active) {
      el.style.display = 'none';
    }

    const outline = p.outlineColor || { r: 0.314, g: 0.784, b: 1.0 };
    const outlineAlpha = Number.isFinite(p.outlineAlpha) ? p.outlineAlpha : 0.9;
    const outlineWidth = Number.isFinite(p.outlineWidthPx) ? p.outlineWidthPx : 2;
    const fillAlpha = Number.isFinite(p.fillAlpha) ? p.fillAlpha : 0.035;
    const cornerRadius = Number.isFinite(p.cornerRadiusPx) ? p.cornerRadiusPx : 2;

    const rgb255 = (c) => Math.max(0, Math.min(255, Math.round((Number(c) || 0) * 255)));
    const r = rgb255(outline.r);
    const g = rgb255(outline.g);
    const b = rgb255(outline.b);

    const ov = im._selectionOverlay;
    if (ov) {
      ov.strokeRgb = { r, g, b };
      ov.strokeAlpha = Math.max(0, Math.min(1, outlineAlpha));
      ov.fillAlpha = Math.max(0, Math.min(1, fillAlpha));
      ov.glowAlpha = Number.isFinite(p.glowAlpha) ? Math.max(0, Math.min(1, p.glowAlpha)) : 0.12;
    }

    // Glassmorphism (blur the game world behind the selection rectangle)
    const glassEnabled = p.glassEnabled === true;
    const glassBlur = Number.isFinite(p.glassBlurPx) ? Math.max(0, p.glassBlurPx) : 4;
    if (glassEnabled && glassBlur > 0) {
      el.style.backdropFilter = `blur(${Math.round(glassBlur)}px)`;
      el.style.webkitBackdropFilter = `blur(${Math.round(glassBlur)}px)`;
    } else {
      el.style.backdropFilter = 'none';
      el.style.webkitBackdropFilter = 'none';
    }

    // Minor perf hints for browsers
    el.style.willChange = 'left, top, width, height, opacity';

    const strokeRect = ov?.strokeRect;
    const strokeRect2 = ov?.strokeRect2;
    const baseRect = ov?.baseRect;
    const patternRect = ov?.patternRect;
    const svg = ov?.svg;

    if (strokeRect && baseRect && patternRect && svg) {
      baseRect.setAttribute('fill', `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, fillAlpha))})`);

      strokeRect.setAttribute('fill', 'none');
      const gradientEnabled = p.gradientEnabled === true;
      if (gradientEnabled && ov?._strokeGradient) {
        strokeRect.setAttribute('stroke', `url(#${ov.ids.strokeGradient})`);
      } else {
        strokeRect.setAttribute('stroke', `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, outlineAlpha))})`);
      }
      strokeRect.setAttribute('stroke-width', `${Math.max(0, outlineWidth)}`);
      strokeRect.setAttribute('rx', `${Math.max(0, cornerRadius)}`);
      strokeRect.setAttribute('ry', `${Math.max(0, cornerRadius)}`);

      // Double border (simple easy-win): an inset secondary stroke which can be dashed/marching.
      const doubleEnabled = p.doubleBorderEnabled === true;
      const doubleInset = Number.isFinite(p.doubleBorderInsetPx) ? Math.max(0, p.doubleBorderInsetPx) : 3;
      const doubleWidth = Number.isFinite(p.doubleBorderWidthPx) ? Math.max(0, p.doubleBorderWidthPx) : 1;
      const doubleAlpha = Number.isFinite(p.doubleBorderAlpha) ? Math.max(0, Math.min(1, p.doubleBorderAlpha)) : 0.5;
      const doubleStyle = (typeof p.doubleBorderStyle === 'string') ? p.doubleBorderStyle : 'dashed';
      if (strokeRect2) {
        if (doubleEnabled && doubleWidth > 0 && doubleAlpha > 0) {
          strokeRect2.style.display = 'block';
          strokeRect2.setAttribute('fill', 'none');
          strokeRect2.setAttribute('stroke', `rgba(${r}, ${g}, ${b}, ${doubleAlpha})`);
          strokeRect2.setAttribute('stroke-width', `${doubleWidth}`);
          strokeRect2.setAttribute('rx', `${Math.max(0, cornerRadius - doubleInset)}`);
          strokeRect2.setAttribute('ry', `${Math.max(0, cornerRadius - doubleInset)}`);

          const dashLen2 = Math.max(1, (Number.isFinite(p.dashLengthPx) ? p.dashLengthPx : 10));
          const dashGap2 = Math.max(0, (Number.isFinite(p.dashGapPx) ? p.dashGapPx : 6));
          if (doubleStyle === 'dashed' || doubleStyle === 'marching') {
            strokeRect2.setAttribute('stroke-dasharray', `${dashLen2} ${dashGap2}`);
          } else {
            strokeRect2.removeAttribute('stroke-dasharray');
            strokeRect2.removeAttribute('stroke-dashoffset');
          }
        } else {
          strokeRect2.style.display = 'none';
          strokeRect2.removeAttribute('stroke-dasharray');
          strokeRect2.removeAttribute('stroke-dashoffset');
        }
      }

      // Reticle crosshair lines (inside the selection box for now)
      const reticleEnabled = p.reticleEnabled === true;
      const reticleAlpha = Number.isFinite(p.reticleAlpha) ? Math.max(0, Math.min(1, p.reticleAlpha)) : 0.12;
      const reticleWidth = Number.isFinite(p.reticleWidthPx) ? Math.max(1, p.reticleWidthPx) : 1;
      if (ov?.reticleH && ov?.reticleV && reticleEnabled && reticleAlpha > 0) {
        ov.reticleH.setAttribute('stroke', `rgba(${r}, ${g}, ${b}, ${reticleAlpha})`);
        ov.reticleV.setAttribute('stroke', `rgba(${r}, ${g}, ${b}, ${reticleAlpha})`);
        ov.reticleH.setAttribute('stroke-width', `${reticleWidth}`);
        ov.reticleV.setAttribute('stroke-width', `${reticleWidth}`);
        ov.reticleH.style.display = 'block';
        ov.reticleV.style.display = 'block';
      } else if (ov?.reticleH && ov?.reticleV) {
        ov.reticleH.style.display = 'none';
        ov.reticleV.style.display = 'none';
      }

      // Tech corner brackets
      const bracketsEnabled = p.techBracketsEnabled === true;
      const bracketAlpha = Number.isFinite(p.techBracketAlpha) ? Math.max(0, Math.min(1, p.techBracketAlpha)) : Math.max(0, Math.min(1, outlineAlpha));
      const bracketLen = Number.isFinite(p.techBracketLengthPx) ? Math.max(2, p.techBracketLengthPx) : 18;
      const bracketW = Number.isFinite(p.techBracketWidthPx) ? Math.max(1, p.techBracketWidthPx) : Math.max(1, outlineWidth);
      if (ov?.bracketsPath) {
        if (bracketsEnabled) {
          ov.bracketsPath.setAttribute('fill', 'none');
          ov.bracketsPath.setAttribute('stroke', `rgba(${r}, ${g}, ${b}, ${bracketAlpha})`);
          ov.bracketsPath.setAttribute('stroke-width', `${bracketW}`);
          ov.bracketsPath.setAttribute('stroke-linecap', 'square');
          ov.bracketsPath.setAttribute('stroke-linejoin', 'miter');
          ov.bracketsPath.style.display = 'block';

          // When brackets are enabled, hide the full strokeRect for a cleaner look.
          strokeRect.setAttribute('stroke', 'rgba(0,0,0,0)');
          strokeRect.removeAttribute('stroke-dasharray');
          strokeRect.removeAttribute('stroke-dashoffset');
          if (strokeRect2) {
            strokeRect2.style.display = 'none';
            strokeRect2.removeAttribute('stroke-dasharray');
            strokeRect2.removeAttribute('stroke-dashoffset');
          }
        } else {
          ov.bracketsPath.style.display = 'none';
        }
      }

      const pattern = (typeof p.pattern === 'string') ? p.pattern : 'none';
      const patternAlpha = Number.isFinite(p.patternAlpha) ? Math.max(0, Math.min(1, p.patternAlpha)) : 0.14;
      const scale = Number.isFinite(p.patternScalePx) ? Math.max(4, p.patternScalePx) : 18;
      const lw = Number.isFinite(p.patternLineWidthPx) ? Math.max(1, p.patternLineWidthPx) : 1;

      patternRect.setAttribute('rx', `${Math.max(0, cornerRadius)}`);
      patternRect.setAttribute('ry', `${Math.max(0, cornerRadius)}`);
      patternRect.setAttribute('opacity', `${patternAlpha}`);

      if (pattern === 'grid') {
        patternRect.setAttribute('fill', `url(#${ov.ids.basePatternGrid})`);
        try {
          const gridPattern = ov.defs.querySelector(`#${ov.ids.basePatternGrid}`);
          if (gridPattern) {
            gridPattern.setAttribute('width', `${scale}`);
            gridPattern.setAttribute('height', `${scale}`);
          }
          if (ov._gridPath) {
            ov._gridPath.setAttribute('stroke', `rgba(${r}, ${g}, ${b}, 1.0)`);
            ov._gridPath.setAttribute('stroke-width', `${lw}`);
            ov._gridPath.setAttribute('d', `M ${scale} 0 L 0 0 0 ${scale}`);
          }
        } catch (_) {
        }
      } else if (pattern === 'diagonal') {
        patternRect.setAttribute('fill', `url(#${ov.ids.basePatternDiag})`);
        try {
          const diagPattern = ov.defs.querySelector(`#${ov.ids.basePatternDiag}`);
          if (diagPattern) {
            diagPattern.setAttribute('width', `${scale}`);
            diagPattern.setAttribute('height', `${scale}`);
          }
          if (ov._diagPath) {
            ov._diagPath.setAttribute('stroke', `rgba(${r}, ${g}, ${b}, 1.0)`);
            ov._diagPath.setAttribute('stroke-width', `${lw}`);
            ov._diagPath.setAttribute('d', `M ${-Math.round(scale * 0.25)} ${scale} L ${scale} ${-Math.round(scale * 0.25)} M 0 ${scale + Math.round(scale * 0.25)} L ${scale + Math.round(scale * 0.25)} 0`);
          }
        } catch (_) {
        }
      } else if (pattern === 'dots') {
        patternRect.setAttribute('fill', `url(#${ov.ids.basePatternDots})`);
        try {
          const dotsPattern = ov.defs.querySelector(`#${ov.ids.basePatternDots}`);
          if (dotsPattern) {
            dotsPattern.setAttribute('width', `${scale}`);
            dotsPattern.setAttribute('height', `${scale}`);
          }
          if (ov._dot) {
            ov._dot.setAttribute('cx', `${scale * 0.5}`);
            ov._dot.setAttribute('cy', `${scale * 0.5}`);
            ov._dot.setAttribute('r', `${Math.max(1.0, scale * 0.08)}`);
            ov._dot.setAttribute('fill', `rgba(${r}, ${g}, ${b}, 1.0)`);
          }
        } catch (_) {
        }
      } else {
        patternRect.setAttribute('fill', 'none');
      }

      const borderStyle = (typeof p.borderStyle === 'string') ? p.borderStyle : 'solid';
      const dashLen = Number.isFinite(p.dashLengthPx) ? Math.max(1, p.dashLengthPx) : 10;
      const dashGap = Number.isFinite(p.dashGapPx) ? Math.max(0, p.dashGapPx) : 6;
      if ((borderStyle === 'dashed' || borderStyle === 'marching') && p.techBracketsEnabled !== true) {
        strokeRect.setAttribute('stroke-dasharray', `${dashLen} ${dashGap}`);
      } else {
        strokeRect.removeAttribute('stroke-dasharray');
        strokeRect.removeAttribute('stroke-dashoffset');
      }

      const glowEnabled = p.glowEnabled !== false;
      const glowAlpha = Number.isFinite(p.glowAlpha) ? p.glowAlpha : 0.12;
      const glowSize = Number.isFinite(p.glowSizePx) ? p.glowSizePx : 18;
      if (glowEnabled && glowAlpha > 0 && glowSize > 0) {
        svg.style.filter = `drop-shadow(0 0 ${Math.round(glowSize)}px rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, glowAlpha))}))`;
      } else {
        svg.style.filter = 'none';
      }
    } else {
      el.style.border = `${Math.max(0, outlineWidth)}px solid rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, outlineAlpha))})`;
      el.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, fillAlpha))})`;
    }

    if (ov?.labelEl) {
      const fontSize = Number.isFinite(p.labelFontSizePx) ? Math.max(8, p.labelFontSizePx) : 12;
      const la = Number.isFinite(p.labelAlpha) ? Math.max(0, Math.min(1, p.labelAlpha)) : 0.85;
      ov.labelEl.style.fontSize = `${Math.round(fontSize)}px`;
      ov.labelEl.style.opacity = `${la}`;
    }

    if (ov?._strokeGradientStopA && ov?._strokeGradientStopB) {
      const cA = p.gradientColorA || { r: 0.0, g: 1.0, b: 1.0 };
      const cB = p.gradientColorB || { r: 1.0, g: 0.0, b: 1.0 };
      const rA = rgb255(cA.r);
      const gA = rgb255(cA.g);
      const bA = rgb255(cA.b);
      const rB = rgb255(cB.r);
      const gB = rgb255(cB.g);
      const bB = rgb255(cB.b);

      ov._strokeGradientStopA.setAttribute('stop-color', `rgba(${rA}, ${gA}, ${bA}, 1.0)`);
      ov._strokeGradientStopB.setAttribute('stop-color', `rgba(${rB}, ${gB}, ${bB}, 1.0)`);
    }
  }

  updateOverlayGeometry(w, h) {
    const im = this.im;
    const ov = im._selectionOverlay;
    if (!ov?.svg || !ov.baseRect || !ov.strokeRect || !ov.patternRect) return;

    const p = im.selectionBoxParams || {};
    const bracketLen = Number.isFinite(p.techBracketLengthPx) ? Math.max(2, p.techBracketLengthPx) : 18;
    const doubleInset = Number.isFinite(p.doubleBorderInsetPx) ? Math.max(0, p.doubleBorderInsetPx) : 3;

    const ww = Math.max(0, Math.floor(w));
    const hh = Math.max(0, Math.floor(h));
    if (ww === ov.lastW && hh === ov.lastH && bracketLen === ov.lastBracketLen && doubleInset === ov.lastDoubleBorderInset) return;
    ov.lastW = ww;
    ov.lastH = hh;
    ov.lastBracketLen = bracketLen;
    ov.lastDoubleBorderInset = doubleInset;

    ov.svg.setAttribute('viewBox', `0 0 ${Math.max(1, ww)} ${Math.max(1, hh)}`);

    ov.baseRect.setAttribute('width', `${Math.max(0, ww)}`);
    ov.baseRect.setAttribute('height', `${Math.max(0, hh)}`);
    ov.patternRect.setAttribute('width', `${Math.max(0, ww)}`);
    ov.patternRect.setAttribute('height', `${Math.max(0, hh)}`);
    ov.strokeRect.setAttribute('width', `${Math.max(0, ww)}`);
    ov.strokeRect.setAttribute('height', `${Math.max(0, hh)}`);

    if (ov.strokeRect2) {
      const inset = doubleInset;
      const w2 = Math.max(0, ww - inset * 2);
      const h2 = Math.max(0, hh - inset * 2);
      ov.strokeRect2.setAttribute('x', `${inset}`);
      ov.strokeRect2.setAttribute('y', `${inset}`);
      ov.strokeRect2.setAttribute('width', `${w2}`);
      ov.strokeRect2.setAttribute('height', `${h2}`);
    }

    // Reticle lines are defined in the overlay's viewBox coordinates
    if (ov.reticleH && ov.reticleV) {
      const cx = ww * 0.5;
      const cy = hh * 0.5;
      ov.reticleH.setAttribute('x1', '0');
      ov.reticleH.setAttribute('y1', `${cy}`);
      ov.reticleH.setAttribute('x2', `${ww}`);
      ov.reticleH.setAttribute('y2', `${cy}`);

      ov.reticleV.setAttribute('x1', `${cx}`);
      ov.reticleV.setAttribute('y1', '0');
      ov.reticleV.setAttribute('x2', `${cx}`);
      ov.reticleV.setAttribute('y2', `${hh}`);
    }

    // Corner brackets path (in overlay coordinates)
    if (ov.bracketsPath) {
      const len = bracketLen;
      const inset = 0;

      const x0 = inset;
      const y0 = inset;
      const x1 = Math.max(inset, ww - inset);
      const y1 = Math.max(inset, hh - inset);

      const d = [
        // TL
        `M ${x0} ${y0 + len} L ${x0} ${y0} L ${x0 + len} ${y0}`,
        // TR
        `M ${x1 - len} ${y0} L ${x1} ${y0} L ${x1} ${y0 + len}`,
        // BR
        `M ${x1} ${y1 - len} L ${x1} ${y1} L ${x1 - len} ${y1}`,
        // BL
        `M ${x0 + len} ${y1} L ${x0} ${y1} L ${x0} ${y1 - len}`
      ].join(' ');
      ov.bracketsPath.setAttribute('d', d);
    }
  }

  updateLabel(width, height) {
    const im = this.im;
    const p = im.selectionBoxParams || {};
    const labelEl = im._selectionOverlay?.labelEl;
    if (!labelEl) return;

    if (p.labelEnabled) {
      labelEl.textContent = `${Math.round(width)}×${Math.round(height)}`;
      labelEl.style.display = 'block';

      if (p.labelClampToViewport !== false) {
        // Clamp the label to viewport so it doesn't go off-screen when the selection box is near the edge.
        const overlay = im.dragSelect?.overlayEl;
        if (overlay) {
          const pad = 6;
          const left = Number.parseFloat(overlay.style.left) || 0;
          const top = Number.parseFloat(overlay.style.top) || 0;

          // Ensure we have a measured size.
          const lw = labelEl.offsetWidth || 0;
          const lh = labelEl.offsetHeight || 0;

          const maxLeft = Math.max(pad, (window.innerWidth - lw - pad));
          const maxTop = Math.max(pad, (window.innerHeight - lh - pad));
          const clampedLeft = Math.max(pad, Math.min(maxLeft, left + pad)) - left;
          const clampedTop = Math.max(pad, Math.min(maxTop, top + pad)) - top;
          labelEl.style.left = `${Math.round(clampedLeft)}px`;
          labelEl.style.top = `${Math.round(clampedTop)}px`;
        }
      } else {
        labelEl.style.left = '6px';
        labelEl.style.top = '6px';
      }
    } else {
      labelEl.style.display = 'none';
    }
  }

  update(timeInfo) {
    const im = this.im;
    const p = im.selectionBoxParams || {};
    const ov = im._selectionOverlay;
    if (!im.dragSelect?.active || !im.dragSelect?.dragging) {
      // Ensure we don't leave world-space meshes visible after drag ends.
      this._hideSelectionIllumination();
      return;
    }

    if (!ov?.strokeRect || !ov?.svg) return;

    const dt = Number(timeInfo?.delta) || 0;
    ov.time += dt;

    // Keep illumination animated even if other overlay animations are disabled.
    try {
      this.updateIlluminationFromDrag(timeInfo);
    } catch (_) {
    }

    // Gradient stroke animation
    if (p.gradientEnabled === true && ov?._strokeGradient) {
      const speed = Number.isFinite(p.gradientSpeed) ? p.gradientSpeed : 0.6;
      const t = ov.time * speed;
      const cx = 0.5;
      const cy = 0.5;
      const a = t * Math.PI * 2.0;
      const dx = Math.cos(a) * 0.5;
      const dy = Math.sin(a) * 0.5;
      const x1 = cx - dx;
      const y1 = cy - dy;
      const x2 = cx + dx;
      const y2 = cy + dy;
      ov._strokeGradient.setAttribute('x1', `${x1}`);
      ov._strokeGradient.setAttribute('y1', `${y1}`);
      ov._strokeGradient.setAttribute('x2', `${x2}`);
      ov._strokeGradient.setAttribute('y2', `${y2}`);
    }

    const borderStyle = (typeof p.borderStyle === 'string') ? p.borderStyle : 'solid';
    if (borderStyle === 'marching') {
      const speed = Number.isFinite(p.dashSpeed) ? p.dashSpeed : 120;
      ov.dashOffset -= speed * dt;
      ov.strokeRect.setAttribute('stroke-dashoffset', `${ov.dashOffset}`);
    }

    const doubleStyle = (typeof p.doubleBorderStyle === 'string') ? p.doubleBorderStyle : 'dashed';
    if (p.doubleBorderEnabled === true && doubleStyle === 'marching' && ov?.strokeRect2) {
      const speed = Number.isFinite(p.dashSpeed) ? p.dashSpeed : 120;
      ov.dashOffset2 += speed * dt;
      ov.strokeRect2.setAttribute('stroke-dashoffset', `${ov.dashOffset2}`);
    }

    if (p.pulseEnabled) {
      const speed = Number.isFinite(p.pulseSpeed) ? p.pulseSpeed : 2.0;
      const strength = Number.isFinite(p.pulseStrength) ? Math.max(0, Math.min(1, p.pulseStrength)) : 0.5;
      const pulse = 0.5 + 0.5 * Math.sin(ov.time * speed * Math.PI * 2.0);
      const glowK = 1.0 - strength + strength * pulse;

      const r = ov.strokeRgb?.r ?? 80;
      const g = ov.strokeRgb?.g ?? 200;
      const b = ov.strokeRgb?.b ?? 255;

      const outlineAlpha = (ov.strokeAlpha ?? 0.9) * (0.8 + 0.2 * glowK);
      ov.strokeRect.setAttribute('stroke', `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, outlineAlpha))})`);

      if (p.glowEnabled !== false) {
        const baseGlowA = ov.glowAlpha ?? 0.12;
        const glowA = Math.max(0, Math.min(1, baseGlowA * (0.6 + 0.8 * glowK)));
        const glowSize = Number.isFinite(p.glowSizePx) ? p.glowSizePx : 18;
        ov.svg.style.filter = `drop-shadow(0 0 ${Math.round(glowSize)}px rgba(${r}, ${g}, ${b}, ${glowA}))`;
      }
    }
  }

  createSelectionShadow() {
    const im = this.im;
    const THREE = window.THREE;
    if (!THREE || !im.sceneComposer?.scene) return;

    // Avoid double-creating on hot reloads.
    if (im.dragSelect.shadowMesh) {
      try { im.sceneComposer.scene.remove(im.dragSelect.shadowMesh); } catch (_) {}
      try { im.dragSelect.shadowMesh.geometry?.dispose?.(); } catch (_) {}
      try { im.dragSelect.shadowMaterial?.dispose?.(); } catch (_) {}
      im.dragSelect.shadowMesh = null;
      im.dragSelect.shadowMaterial = null;
    }

    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uOpacity: { value: 0.26 },
        uFeather: { value: 0.08 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        uniform float uFeather;
        varying vec2 vUv;

        void main() {
          float edgeDist = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
          float feather = max(uFeather, 0.0001);
          float alpha = smoothstep(0.0, feather, edgeDist);
          alpha *= uOpacity;
          gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
        }
      `
    });
    material.toneMapped = false;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.name = 'SelectionBoxShadow';
    mesh.renderOrder = 500;

    im.dragSelect.shadowMesh = mesh;
    im.dragSelect.shadowMaterial = material;
    im.sceneComposer.scene.add(mesh);

    this._applySelectionShadowParams();
  }

  createSelectionIllumination() {
    const im = this.im;
    const THREE = window.THREE;
    if (!THREE || !im.sceneComposer?.scene) return;

    // Avoid double-creating on hot reloads.
    if (im.dragSelect.illuminationMesh) {
      try { im.sceneComposer.scene.remove(im.dragSelect.illuminationMesh); } catch (_) {}
      try { im.dragSelect.illuminationMesh.geometry?.dispose?.(); } catch (_) {}
      try { im.dragSelect.illuminationMaterial?.dispose?.(); } catch (_) {}
      im.dragSelect.illuminationMesh = null;
      im.dragSelect.illuminationMaterial = null;
    }

    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0.0 },
        uIntensity: { value: 0.35 },
        uGridScalePx: { value: 24.0 },
        uScrollSpeed: { value: 0.25 },
        uColor: { value: new THREE.Color(0.3, 0.85, 1.0) },
        uWorldMin: { value: new THREE.Vector2(0, 0) },
        uWorldSize: { value: new THREE.Vector2(1, 1) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uIntensity;
        uniform float uGridScalePx;
        uniform float uScrollSpeed;
        uniform vec3 uColor;
        uniform vec2 uWorldMin;
        uniform vec2 uWorldSize;
        varying vec2 vUv;

        void main() {
          // World-space tiling so the interior doesn't stretch with selection size.
          float cell = max(uGridScalePx, 1.0);
          vec2 world = uWorldMin + vUv * uWorldSize;
          world.y += uTime * uScrollSpeed * cell;

          vec2 grid = world / cell;
          vec2 f = fract(grid);
          vec2 d = min(f, 1.0 - f);
          vec2 aa = fwidth(grid);

          // Thickness in "cell"-relative units.
          float thickness = 0.04;
          float lx = 1.0 - smoothstep(thickness, thickness + aa.x * 1.5, d.x);
          float ly = 1.0 - smoothstep(thickness, thickness + aa.y * 1.5, d.y);
          float g = clamp(lx + ly, 0.0, 1.0);

          // Feather at edges of the selection for a softer projection.
          float edgeDist = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
          float edge = smoothstep(0.0, 0.06, edgeDist);

          float a = g * edge * uIntensity;
          gl_FragColor = vec4(uColor, a);
        }
      `
    });
    material.toneMapped = false;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.name = 'SelectionBoxIllumination';
    mesh.renderOrder = 510;

    im.dragSelect.illuminationMesh = mesh;
    im.dragSelect.illuminationMaterial = material;
    im.sceneComposer.scene.add(mesh);

    this._applySelectionIlluminationParams();
  }

  _applySelectionIlluminationParams() {
    const im = this.im;
    const mat = im.dragSelect.illuminationMaterial;
    if (!mat?.uniforms) return;
    const p = im.selectionBoxParams || {};

    if (mat.uniforms.uIntensity) {
      const v = Number(p.illuminationIntensity);
      mat.uniforms.uIntensity.value = Number.isFinite(v) ? Math.max(0, Math.min(2.0, v)) : 0.35;
    }
    if (mat.uniforms.uGridScalePx) {
      const v = Number(p.illuminationGridScalePx);
      mat.uniforms.uGridScalePx.value = Number.isFinite(v) ? Math.max(1.0, v) : 24.0;
    }
    if (mat.uniforms.uScrollSpeed) {
      const v = Number(p.illuminationScrollSpeed);
      mat.uniforms.uScrollSpeed.value = Number.isFinite(v) ? v : 0.25;
    }
    if (mat.uniforms.uColor && p.illuminationColor && typeof p.illuminationColor === 'object') {
      const c = p.illuminationColor;
      const r = Math.max(0, Math.min(1, Number(c.r) || 0));
      const g = Math.max(0, Math.min(1, Number(c.g) || 0));
      const b = Math.max(0, Math.min(1, Number(c.b) || 0));
      mat.uniforms.uColor.value.setRGB(r, g, b);
    }
  }

  updateIlluminationFromDrag(timeInfo) {
    const im = this.im;
    const mesh = im.dragSelect.illuminationMesh;
    const mat = im.dragSelect.illuminationMaterial;
    if (!mesh || !mat?.uniforms) return;

    const p = im.selectionBoxParams || {};
    const enabled = (p.enabled !== false) && (p.illuminationEnabled === true);
    if (!enabled) {
      mesh.visible = false;
      return;
    }

    const start = im.dragSelect.start;
    const current = im.dragSelect.current;
    const minX = Math.min(start.x, current.x);
    const maxX = Math.max(start.x, current.x);
    const minY = Math.min(start.y, current.y);
    const maxY = Math.max(start.y, current.y);

    const w = Math.max(0.001, maxX - minX);
    const h = Math.max(0.001, maxY - minY);
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;

    const groundZ = im.sceneComposer?.groundZ ?? 0;
    mesh.position.set(cx, cy, groundZ + 0.14);
    mesh.scale.set(w, h, 1);
    mesh.visible = true;

    mat.uniforms.uTime.value = Number(timeInfo?.elapsed) || 0.0;
    if (mat.uniforms.uWorldMin) mat.uniforms.uWorldMin.value.set(minX, minY);
    if (mat.uniforms.uWorldSize) mat.uniforms.uWorldSize.value.set(w, h);
  }

  _applySelectionShadowParams() {
    const im = this.im;
    const mat = im.dragSelect.shadowMaterial;
    if (!mat?.uniforms) return;
    const p = im.selectionBoxParams || {};

    if (mat.uniforms.uOpacity) {
      const v = Number(p.shadowOpacity);
      mat.uniforms.uOpacity.value = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.26;
    }
    if (mat.uniforms.uFeather) {
      const v = Number(p.shadowFeather);
      mat.uniforms.uFeather.value = Number.isFinite(v) ? Math.max(0.0, Math.min(0.5, v)) : 0.08;
    }
  }

  updateShadowFromDrag() {
    const im = this.im;
    const THREE = window.THREE;
    if (!THREE) return;
    const mesh = im.dragSelect.shadowMesh;
    if (!mesh) return;

    const start = im.dragSelect.start;
    const current = im.dragSelect.current;
    const minX = Math.min(start.x, current.x);
    const maxX = Math.max(start.x, current.x);
    const minY = Math.min(start.y, current.y);
    const maxY = Math.max(start.y, current.y);

    const w = Math.max(0.001, maxX - minX);
    const h = Math.max(0.001, maxY - minY);
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;

    const p = im.selectionBoxParams || {};
    const zoom = im._getEffectiveZoom?.() ?? 1.0;
    const offsetPx = Number.isFinite(p.shadowOffsetPx) ? p.shadowOffsetPx : 18;
    const ox = offsetPx / Math.max(zoom, 0.0001);
    const oy = -offsetPx / Math.max(zoom, 0.0001);

    const groundZ = im.sceneComposer?.groundZ ?? 0;
    const zOff = Number.isFinite(p.shadowZOffset) ? p.shadowZOffset : 0.12;
    mesh.position.set(cx + ox, cy + oy, groundZ + zOff);
    mesh.scale.set(w, h, 1);
    mesh.visible = (p.enabled !== false) && (p.shadowEnabled !== false);
  }

  _hideSelectionShadow() {
    const im = this.im;
    if (im.dragSelect.shadowMesh) im.dragSelect.shadowMesh.visible = false;
  }

  _hideSelectionIllumination() {
    const im = this.im;
    if (im?.dragSelect?.illuminationMesh) im.dragSelect.illuminationMesh.visible = false;
  }
}
