/**
 * @fileoverview Selection Box interaction handler.
 *
 * Extracted from interaction-manager.js to isolate selection-box-specific logic:
 * - 3D selection box mesh (fill + border)
 * - Screen-space DOM overlay (SVG patterns, border styles, animations)
 * - World-space shadow mesh (shader-based soft shadow)
 * - Selection overlay styling, geometry updates, and animation
 * - Shadow parameter application and drag-based positioning
 *
 * The handler receives a reference to the parent InteractionManager for
 * shared state (sceneComposer, dragSelect, selectionBoxParams, _selectionOverlay).
 *
 * @module scene/selection-box-interaction
 */

import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';

/**
 * Handles all selection-box-specific visuals: 3D mesh, DOM overlay, shadow mesh.
 * Delegates to the parent InteractionManager for shared state.
 */
export class SelectionBoxHandler {
  /**
   * @param {import('./interaction-manager.js').InteractionManager} im - Parent interaction manager
   */
  constructor(im) {
    /** @private */
    this._im = im;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get sceneComposer() { return this._im.sceneComposer; }
  get dragSelect() { return this._im.dragSelect; }
  get selectionBoxParams() { return this._im.selectionBoxParams; }
  get _selectionOverlay() { return this._im._selectionOverlay; }

  // ── 3D Selection Box Mesh ─────────────────────────────────────────────────

  /**
   * Create the basic Three.js selection box fill + border meshes.
   */
  createSelectionBox() {
    const THREE = window.THREE;

    // Semi-transparent blue fill
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0x3388ff,
      transparent: true,
      opacity: 0.2,
      depthTest: false,
      side: THREE.DoubleSide
    });

    this.dragSelect.mesh = new THREE.Mesh(geometry, material);
    this.dragSelect.mesh.visible = false;
    this.dragSelect.mesh.name = 'SelectionBoxFill';
    this.dragSelect.mesh.layers.set(OVERLAY_THREE_LAYER);
    this.dragSelect.mesh.renderOrder = 9999;

    // Blue border
    const borderGeo = new THREE.EdgesGeometry(geometry);
    const borderMat = new THREE.LineBasicMaterial({
      color: 0x3388ff,
      transparent: true,
      opacity: 0.8,
      depthTest: false
    });

    this.dragSelect.border = new THREE.LineSegments(borderGeo, borderMat);
    this.dragSelect.border.visible = false;
    this.dragSelect.border.name = 'SelectionBoxBorder';
    this.dragSelect.border.layers.set(OVERLAY_THREE_LAYER);
    this.dragSelect.border.renderOrder = 10000;

    if (this.sceneComposer.scene) {
      this.sceneComposer.scene.add(this.dragSelect.mesh);
      this.sceneComposer.scene.add(this.dragSelect.border);
    }
  }

  // ── Screen-Space DOM Overlay ──────────────────────────────────────────────

  /**
   * Create a screen-space DOM overlay for drag selection.
   * Uses SVG for border styles, patterns, and animation.
   */
  createSelectionOverlay() {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '9999';
    el.style.display = 'none';
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.width = '0px';
    el.style.height = '0px';

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

    // Unique IDs to avoid collisions with other SVGs in the DOM.
    const ids = {
      basePatternGrid: `msSelGrid_${Math.random().toString(16).slice(2)}`,
      basePatternDiag: `msSelDiag_${Math.random().toString(16).slice(2)}`,
      basePatternDots: `msSelDots_${Math.random().toString(16).slice(2)}`
    };

    const baseRect = document.createElementNS(SVG_NS, 'rect');
    const patternRect = document.createElementNS(SVG_NS, 'rect');
    const strokeRect = document.createElementNS(SVG_NS, 'rect');

    baseRect.setAttribute('x', '0');
    baseRect.setAttribute('y', '0');
    patternRect.setAttribute('x', '0');
    patternRect.setAttribute('y', '0');
    strokeRect.setAttribute('x', '0');
    strokeRect.setAttribute('y', '0');

    // Draw order: fill -> pattern -> stroke
    svg.appendChild(baseRect);
    svg.appendChild(patternRect);
    svg.appendChild(strokeRect);

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

    this.dragSelect.overlayEl = el;
    this._selectionOverlay.svg = svg;
    this._selectionOverlay.defs = defs;
    this._selectionOverlay.baseRect = baseRect;
    this._selectionOverlay.patternRect = patternRect;
    this._selectionOverlay.strokeRect = strokeRect;
    this._selectionOverlay.labelEl = labelEl;
    this._selectionOverlay.ids = ids;

    this.ensureSelectionPatterns();
    this.applySelectionOverlayStyles();
  }

  ensureSelectionPatterns() {
    const ov = this._selectionOverlay;
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

  // ── World-Space Shadow Mesh ───────────────────────────────────────────────

  /**
   * Create a world-space shadow mesh for drag selection.
   * Rendered on the ground plane with shader-based soft edges.
   */
  createSelectionShadow() {
    const THREE = window.THREE;
    if (!THREE || !this.sceneComposer?.scene) return;

    // Avoid double-creating on hot reloads.
    if (this.dragSelect.shadowMesh) {
      try { this.sceneComposer.scene.remove(this.dragSelect.shadowMesh); } catch (_) {}
      try { this.dragSelect.shadowMesh.geometry?.dispose?.(); } catch (_) {}
      try { this.dragSelect.shadowMaterial?.dispose?.(); } catch (_) {}
      this.dragSelect.shadowMesh = null;
      this.dragSelect.shadowMaterial = null;
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
          // Distance to nearest edge (0 at border, ~0.5 at center)
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

    this.dragSelect.shadowMesh = mesh;
    this.dragSelect.shadowMaterial = material;
    this.sceneComposer.scene.add(mesh);

    this.applySelectionShadowParams();
  }

  // ── Overlay Styling ───────────────────────────────────────────────────────

  applySelectionOverlayStyles() {
    const el = this.dragSelect.overlayEl;
    if (!el) return;

    const p = this.selectionBoxParams || {};
    const enabled = p.enabled !== false;
    if (!enabled && !this.dragSelect?.active) {
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

    // Cache for animation (pulse/marching) without re-parsing colors.
    const ov = this._selectionOverlay;
    if (ov) {
      ov.strokeRgb = { r, g, b };
      ov.strokeAlpha = Math.max(0, Math.min(1, outlineAlpha));
      ov.fillAlpha = Math.max(0, Math.min(1, fillAlpha));
      ov.glowAlpha = Number.isFinite(p.glowAlpha) ? Math.max(0, Math.min(1, p.glowAlpha)) : 0.12;
    }

    const strokeRect = ov?.strokeRect;
    const baseRect = ov?.baseRect;
    const patternRect = ov?.patternRect;
    const svg = ov?.svg;
    if (strokeRect && baseRect && patternRect && svg) {
      baseRect.setAttribute('fill', `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, fillAlpha))})`);

      strokeRect.setAttribute('fill', 'none');
      strokeRect.setAttribute('stroke', `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, outlineAlpha))})`);
      strokeRect.setAttribute('stroke-width', `${Math.max(0, outlineWidth)}`);
      strokeRect.setAttribute('rx', `${Math.max(0, cornerRadius)}`);
      strokeRect.setAttribute('ry', `${Math.max(0, cornerRadius)}`);

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
      if (borderStyle === 'dashed' || borderStyle === 'marching') {
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
  }

  // ── Geometry & Animation Updates ──────────────────────────────────────────

  updateSelectionOverlayGeometry(w, h) {
    const ov = this._selectionOverlay;
    if (!ov?.svg || !ov.baseRect || !ov.strokeRect || !ov.patternRect) return;

    const ww = Math.max(0, Math.floor(w));
    const hh = Math.max(0, Math.floor(h));
    if (ww === ov.lastW && hh === ov.lastH) return;
    ov.lastW = ww;
    ov.lastH = hh;

    ov.svg.setAttribute('viewBox', `0 0 ${Math.max(1, ww)} ${Math.max(1, hh)}`);

    ov.baseRect.setAttribute('width', `${Math.max(0, ww)}`);
    ov.baseRect.setAttribute('height', `${Math.max(0, hh)}`);
    ov.patternRect.setAttribute('width', `${Math.max(0, ww)}`);
    ov.patternRect.setAttribute('height', `${Math.max(0, hh)}`);
    ov.strokeRect.setAttribute('width', `${Math.max(0, ww)}`);
    ov.strokeRect.setAttribute('height', `${Math.max(0, hh)}`);
  }

  updateSelectionOverlayAnimation(timeInfo) {
    const p = this.selectionBoxParams || {};
    const ov = this._selectionOverlay;
    if (!ov?.strokeRect || !ov?.svg) return;

    // Only animate while visible (dragging) to avoid background work.
    if (!this.dragSelect?.active || !this.dragSelect?.dragging) return;

    const dt = Number(timeInfo?.delta) || 0;
    ov.time += dt;

    const borderStyle = (typeof p.borderStyle === 'string') ? p.borderStyle : 'solid';
    if (borderStyle === 'marching') {
      const speed = Number.isFinite(p.dashSpeed) ? p.dashSpeed : 120;
      ov.dashOffset -= speed * dt;
      ov.strokeRect.setAttribute('stroke-dashoffset', `${ov.dashOffset}`);
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

  // ── Shadow Params & Positioning ───────────────────────────────────────────

  applySelectionShadowParams() {
    const mat = this.dragSelect.shadowMaterial;
    if (!mat?.uniforms) return;
    const p = this.selectionBoxParams || {};

    if (mat.uniforms.uOpacity) {
      const v = Number(p.shadowOpacity);
      mat.uniforms.uOpacity.value = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.26;
    }
    if (mat.uniforms.uFeather) {
      const v = Number(p.shadowFeather);
      mat.uniforms.uFeather.value = Number.isFinite(v) ? Math.max(0.0, Math.min(0.5, v)) : 0.08;
    }
  }

  updateSelectionShadowFromDrag() {
    const THREE = window.THREE;
    if (!THREE) return;
    const mesh = this.dragSelect.shadowMesh;
    if (!mesh) return;

    const start = this.dragSelect.start;
    const current = this.dragSelect.current;
    const minX = Math.min(start.x, current.x);
    const maxX = Math.max(start.x, current.x);
    const minY = Math.min(start.y, current.y);
    const maxY = Math.max(start.y, current.y);

    const w = Math.max(0.001, maxX - minX);
    const h = Math.max(0.001, maxY - minY);
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;

    const p = this.selectionBoxParams || {};
    const zoom = this._im._getEffectiveZoom?.() ?? 1.0;
    const offsetPx = Number.isFinite(p.shadowOffsetPx) ? p.shadowOffsetPx : 18;
    const ox = offsetPx / Math.max(zoom, 0.0001);
    const oy = -offsetPx / Math.max(zoom, 0.0001);

    const groundZ = this.sceneComposer?.groundZ ?? 0;
    const zOff = Number.isFinite(p.shadowZOffset) ? p.shadowZOffset : 0.12;
    mesh.position.set(cx + ox, cy + oy, groundZ + zOff);
    mesh.scale.set(w, h, 1);
    mesh.visible = (p.enabled !== false) && (p.shadowEnabled !== false);
  }

  hideSelectionShadow() {
    if (this.dragSelect.shadowMesh) this.dragSelect.shadowMesh.visible = false;
  }

  // ── Param Change Forwarding ───────────────────────────────────────────────

  applyParamChange(paramId, value) {
    if (!paramId) return;
    try {
      this._im.selectionBoxEffect?.applyParamChange?.(paramId, value);
    } catch (_) {
    }
  }
}
