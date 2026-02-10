/**
 * @fileoverview Light Interaction handler.
 *
 * Extracted from interaction-manager.js to isolate light-specific logic:
 * - Selected-light outline visualization
 * - Light placement preview (LOS polygon + shader)
 * - Translate gizmo (X/Y axes + center handle)
 * - Radius rings gizmo (bright/dim handles)
 * - Radius slider overlay (HTML)
 * - Light query helpers (_getSelectedLight, _canEditSelectedLight, etc.)
 * - Radius commit / live-apply logic
 * - UI hover label
 *
 * The handler receives a reference to the parent InteractionManager for
 * shared utilities (sceneComposer, selection, lightIconManager, dragState).
 *
 * @module scene/light-interaction
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';
import { VisionPolygonComputer } from '../vision/VisionPolygonComputer.js';

const log = createLogger('LightInteraction');

const _lightPreviewLosComputer = new VisionPolygonComputer();
_lightPreviewLosComputer.circleSegments = 64;

/**
 * Handles all light-specific gizmos, previews, queries, and radius editing logic.
 * Delegates to the parent InteractionManager for shared state.
 */
export class LightInteractionHandler {
  /**
   * @param {import('./interaction-manager.js').InteractionManager} im - Parent interaction manager
   */
  constructor(im) {
    /** @private */
    this._im = im;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get sceneComposer() { return this._im.sceneComposer; }
  get selection() { return this._im.selection; }
  get lightIconManager() { return this._im.lightIconManager; }
  get dragState() { return this._im.dragState; }
  get canvasElement() { return this._im.canvasElement; }

  // ── Selected-Light Outline ────────────────────────────────────────────────

  createSelectedLightOutline() {
    try {
      const THREE = window.THREE;
      if (!THREE) return;

      const points = [
        new THREE.Vector3(-0.5, -0.5, 0),
        new THREE.Vector3(0.5, -0.5, 0),
        new THREE.Vector3(0.5, 0.5, 0),
        new THREE.Vector3(-0.5, 0.5, 0),
        new THREE.Vector3(-0.5, -0.5, 0)
      ];

      const geom = new THREE.BufferGeometry().setFromPoints(points);
      const mat = new THREE.LineBasicMaterial({
        color: 0x33aaff,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false
      });

      const line = new THREE.Line(geom, mat);
      line.name = 'SelectedLightOutline';
      line.visible = false;
      line.renderOrder = 9999;
      line.layers.set(OVERLAY_THREE_LAYER);
      line.layers.enable(0);

      if (this.sceneComposer?.scene) {
        this.sceneComposer.scene.add(line);
      }

      this._im._selectedLightOutline = {
        line,
        basePaddingMul: 1.35,
        zOffset: 0.02
      };
    } catch (_) {
      this._im._selectedLightOutline = { line: null };
    }
  }

  hideSelectedLightOutline() {
    try {
      const l = this._im._selectedLightOutline?.line;
      if (l) l.visible = false;
    } catch (_) {
    }
  }

  updateSelectedLightOutline() {
    try {
      const entry = this._im._selectedLightOutline;
      const line = entry?.line;
      if (!line) return;

      const sel = this.getSelectedLight();
      if (!sel) {
        line.visible = false;
        return;
      }

      let worldPos = null;
      let icon = null;
      if (sel.type === 'foundry') {
        icon = this.lightIconManager?.lights?.get?.(sel.id) || null;
        worldPos = this.getSelectedLightWorldPos(sel);
      } else if (sel.type === 'enhanced') {
        const mgr = window.MapShine?.enhancedLightIconManager;
        icon = mgr?.lights?.get?.(sel.id) || null;
        worldPos = this.getSelectedLightWorldPos(sel);
      }

      if (!worldPos) {
        line.visible = false;
        return;
      }

      let sx = 60;
      let sy = 60;
      try {
        const s = icon?.scale;
        if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {
          sx = s.x;
          sy = s.y;
        }
      } catch (_) {
      }

      const pad = (Number.isFinite(entry.basePaddingMul) ? entry.basePaddingMul : 1.35);
      line.position.set(worldPos.x, worldPos.y, (worldPos.z ?? 0) + (entry.zOffset ?? 0.02));
      line.scale.set(sx * pad, sy * pad, 1);
      line.visible = true;
    } catch (_) {
    }
  }

  // ── Light Preview (LOS polygon + shader) ──────────────────────────────────

  computeLightPreviewLocalPolygon(originWorld, radiusWorld) {
    try {
      const radius = Number(radiusWorld);
      if (!Number.isFinite(radius) || radius <= 0) return null;

      const sceneRect = canvas?.dimensions?.sceneRect;
      const sceneBounds = sceneRect ? {
        x: sceneRect.x,
        y: sceneRect.y,
        width: sceneRect.width,
        height: sceneRect.height
      } : null;

      const originF = Coordinates.toFoundry(originWorld.x, originWorld.y);
      const ptsF = _lightPreviewLosComputer.compute(originF, radius, null, sceneBounds, { sense: 'light' });
      if (!ptsF || ptsF.length < 6) return null;

      const THREE = window.THREE;
      const local = [];
      for (let i = 0; i < ptsF.length; i += 2) {
        const w = Coordinates.toWorld(ptsF[i], ptsF[i + 1]);
        local.push(new THREE.Vector2(w.x - originWorld.x, w.y - originWorld.y));
      }
      return local.length >= 3 ? local : null;
    } catch (_) {
      return null;
    }
  }

  updateLightPlacementPreviewGeometry(preview, originWorld, radiusWorld) {
    try {
      if (!preview?.previewFill || !preview?.previewBorder) return;
      const THREE = window.THREE;

      const radius = Math.max(0.1, Number(radiusWorld) || 0.1);

      if (preview.previewGroup) preview.previewGroup.scale.set(1, 1, 1);

      if (preview.previewFill?.material?.uniforms?.uRadius) {
        preview.previewFill.material.uniforms.uRadius.value = radius;
      }

      const localPoly = this.computeLightPreviewLocalPolygon(originWorld, radius);
      let geom;
      if (localPoly && localPoly.length >= 3) {
        const shape = new THREE.Shape(localPoly);
        geom = new THREE.ShapeGeometry(shape);
      } else {
        geom = new THREE.CircleGeometry(radius, 64);
      }

      if (preview.previewFill.geometry) preview.previewFill.geometry.dispose();
      preview.previewFill.geometry = geom;

      const borderGeom = new THREE.EdgesGeometry(geom);
      if (preview.previewBorder.geometry) preview.previewBorder.geometry.dispose();
      preview.previewBorder.geometry = borderGeom;
    } catch (_) {
    }
  }

  /**
   * Create the light placement preview Three.js objects (shader fill + border).
   */
  createLightPreview() {
    const THREE = window.THREE;
    const lp = this._im.lightPlacement;

    lp.previewGroup = new THREE.Group();
    lp.previewGroup.name = 'LightPlacementPreview';
    lp.previewGroup.visible = false;
    lp.previewGroup.position.z = 0;

    const geometry = new THREE.CircleGeometry(0.1, 64);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1.0, 1.0, 0.8) },
        uRatio: { value: 0.5 },
        uRadius: { value: 0.1 }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        varying vec2 vCenterWorld;
        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          vCenterWorld = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xy;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uRatio;
        uniform float uRadius;
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        varying vec2 vCenterWorld;

        void main() {
          float dist = length(vWorldPosition.xy - vCenterWorld);

          float d = dist / max(uRadius, 0.0001);

          // Falloff Logic
          float dOuter = d;
          float innerFrac = clamp(uRatio, 0.0, 0.99);

          float coreRegion = 1.0 - smoothstep(0.0, innerFrac, dOuter);
          float haloRegion = 1.0 - smoothstep(innerFrac, 1.0, dOuter);

          // Bright core, soft halo
          float coreIntensity = pow(coreRegion, 1.2) * 2.0;
          float haloIntensity = pow(haloRegion, 1.0) * 0.6; 

          float intensity = (coreIntensity + haloIntensity) * 2.0;
          
          // Output with additive-friendly alpha
          gl_FragColor = vec4(uColor * intensity, intensity); 
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      side: THREE.DoubleSide
    });

    lp.previewFill = new THREE.Mesh(geometry, material);
    lp.previewGroup.add(lp.previewFill);

    const borderGeo = new THREE.EdgesGeometry(geometry);
    const borderMat = new THREE.LineBasicMaterial({
      color: 0xFFFFBB,
      transparent: true,
      opacity: 0.8,
      depthTest: false
    });
    lp.previewBorder = new THREE.LineSegments(borderGeo, borderMat);
    lp.previewGroup.add(lp.previewBorder);

    if (this.sceneComposer.scene) {
      this.sceneComposer.scene.add(lp.previewGroup);
    }
  }

  // ── Translate Gizmo ───────────────────────────────────────────────────────

  createTranslateGizmo() {
    try {
      const THREE = window.THREE;
      if (!THREE || !this.sceneComposer?.scene) return;

      const g = new THREE.Group();
      g.name = 'LightTranslateGizmo';
      g.visible = false;
      g.renderOrder = 10010;
      g.layers.set(OVERLAY_THREE_LAYER);
      g.layers.enable(0);

      const depthTest = false;
      const depthWrite = false;

      const matX = new THREE.MeshBasicMaterial({ color: 0xff3333, transparent: true, opacity: 0.95, depthTest, depthWrite });
      const matY = new THREE.MeshBasicMaterial({ color: 0x33ff33, transparent: true, opacity: 0.95, depthTest, depthWrite });
      const matC = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest, depthWrite });
      matX.toneMapped = false;
      matY.toneMapped = false;
      matC.toneMapped = false;

      const axisLen = 58;
      const axisThick = 6;
      const centerSize = 14;
      const arrowLen = 14;
      const arrowRadius = 7;

      // X axis (red)
      const geoX = new THREE.BoxGeometry(axisLen, axisThick, 0.5);
      const xHandle = new THREE.Mesh(geoX, matX);
      xHandle.position.set(axisLen * 0.5, 0, 0);
      xHandle.renderOrder = 10011;
      xHandle.layers.set(OVERLAY_THREE_LAYER);
      xHandle.layers.enable(0);
      xHandle.userData = { type: 'lightTranslateHandle', axis: 'x' };

      const xArrowGeo = new THREE.ConeGeometry(arrowRadius, arrowLen, 16);
      const xArrow = new THREE.Mesh(xArrowGeo, matX);
      xArrow.rotation.z = -Math.PI / 2;
      xArrow.position.set(axisLen + arrowLen * 0.5, 0, 0);
      xArrow.renderOrder = 10012;
      xArrow.layers.set(OVERLAY_THREE_LAYER);
      xArrow.layers.enable(0);
      xArrow.userData = { type: 'lightTranslateHandle', axis: 'x' };

      // Y axis (green)
      const geoY = new THREE.BoxGeometry(axisThick, axisLen, 0.5);
      const yHandle = new THREE.Mesh(geoY, matY);
      yHandle.position.set(0, axisLen * 0.5, 0);
      yHandle.renderOrder = 10011;
      yHandle.layers.set(OVERLAY_THREE_LAYER);
      yHandle.layers.enable(0);
      yHandle.userData = { type: 'lightTranslateHandle', axis: 'y' };

      const yArrowGeo = new THREE.ConeGeometry(arrowRadius, arrowLen, 16);
      const yArrow = new THREE.Mesh(yArrowGeo, matY);
      yArrow.position.set(0, axisLen + arrowLen * 0.5, 0);
      yArrow.renderOrder = 10012;
      yArrow.layers.set(OVERLAY_THREE_LAYER);
      yArrow.layers.enable(0);
      yArrow.userData = { type: 'lightTranslateHandle', axis: 'y' };

      // Center (free move)
      const geoC = new THREE.BoxGeometry(centerSize, centerSize, 0.5);
      const cHandle = new THREE.Mesh(geoC, matC);
      cHandle.position.set(0, 0, 0);
      cHandle.renderOrder = 10012;
      cHandle.layers.set(OVERLAY_THREE_LAYER);
      cHandle.layers.enable(0);
      cHandle.userData = { type: 'lightTranslateHandle', axis: 'xy' };

      g.add(xHandle);
      g.add(xArrow);
      g.add(yHandle);
      g.add(yArrow);
      g.add(cHandle);

      this.sceneComposer.scene.add(g);
      this._im._lightTranslate.group = g;
      this._im._lightTranslate.handles = [xHandle, xArrow, yHandle, yArrow, cHandle];
    } catch (_) {
    }
  }

  updateTranslateGizmo() {
    try {
      const g = this._im._lightTranslate?.group;
      if (!g) return;

      const showGizmo = window.MapShine?.tweakpaneManager?.globalParams?.showLightTranslateGizmo ?? true;
      if (!showGizmo) {
        g.visible = false;
        return;
      }

      if (this.dragState?.active) {
        g.visible = false;
        return;
      }

      const sel = this.getSelectedLight();
      this._im._lightTranslate.selected = sel;
      if (!sel || !this.canEditSelectedLight(sel)) {
        g.visible = false;
        return;
      }

      const pos = this.getSelectedLightWorldPos(sel);
      if (!pos) {
        g.visible = false;
        return;
      }

      const groundZ = this.sceneComposer?.groundZ ?? 0;
      const z = groundZ + 4.05;

      const zoom = this._im._getEffectiveZoom();
      const dx = (this._im._lightTranslate.offsetPx.x || 0) / zoom;
      const dy = -(this._im._lightTranslate.offsetPx.y || 0) / zoom;

      g.position.set(pos.x + dx, pos.y + dy, z);

      const s = 1 / zoom;
      g.scale.set(s, s, 1);

      for (const h of this._im._lightTranslate.handles) {
        if (!h?.userData) h.userData = {};
        h.userData.lightType = sel.type;
        if (sel.type === 'foundry') {
          h.userData.lightId = sel.id;
          h.userData.enhancedLightId = undefined;
        } else {
          h.userData.enhancedLightId = sel.id;
          h.userData.lightId = undefined;
        }
      }

      g.visible = true;
    } catch (_) {
    }
  }

  // ── Radius Rings Gizmo ────────────────────────────────────────────────────

  createRadiusRingsGizmo() {
    try {
      const THREE = window.THREE;
      if (!THREE || !this.sceneComposer?.scene) return;

      const g = new THREE.Group();
      g.name = 'LightRadiusHandlesGizmo';
      g.visible = false;
      g.renderOrder = 10005;
      g.layers.set(OVERLAY_THREE_LAYER);
      g.layers.enable(0);

      const depthTest = false;
      const depthWrite = false;

      const brightMat = new THREE.MeshBasicMaterial({ color: 0xffdd44, transparent: true, opacity: 0.95, depthTest, depthWrite });
      brightMat.toneMapped = false;

      const dimMat = new THREE.MeshBasicMaterial({ color: 0x44ddff, transparent: true, opacity: 0.95, depthTest, depthWrite });
      dimMat.toneMapped = false;

      const handleRadius = 10;
      const handleSegments = 24;

      const brightGeo = new THREE.CircleGeometry(handleRadius, handleSegments);
      const brightHandle = new THREE.Mesh(brightGeo, brightMat);
      brightHandle.position.set(0, 0, 0);
      brightHandle.renderOrder = 10006;
      brightHandle.layers.set(OVERLAY_THREE_LAYER);
      brightHandle.layers.enable(0);
      brightHandle.userData = { type: 'lightRadiusHandle', radiusType: 'bright' };

      const dimGeo = new THREE.CircleGeometry(handleRadius, handleSegments);
      const dimHandle = new THREE.Mesh(dimGeo, dimMat);
      dimHandle.position.set(0, -24, 0);
      dimHandle.renderOrder = 10006;
      dimHandle.layers.set(OVERLAY_THREE_LAYER);
      dimHandle.layers.enable(0);
      dimHandle.userData = { type: 'lightRadiusHandle', radiusType: 'dim' };

      g.add(brightHandle);
      g.add(dimHandle);

      this.sceneComposer.scene.add(g);
      this._im._lightRadiusRings.group = g;
      this._im._lightRadiusRings.brightHandle = brightHandle;
      this._im._lightRadiusRings.dimHandle = dimHandle;
      this._im._lightRadiusRings.handles = [brightHandle, dimHandle];
    } catch (_) {
    }
  }

  updateRadiusRingsGizmo() {
    try {
      const g = this._im._lightRadiusRings?.group;
      if (!g) return;

      // 3D gizmo is disabled; we use the HTML slider overlay instead.
      g.visible = false;

      const showRings = window.MapShine?.tweakpaneManager?.globalParams?.showLightRadiusRings ?? true;
      if (!showRings) {
        g.visible = false;
        return;
      }

      if (this.dragState?.active && this.dragState.mode !== 'radiusEdit') {
        g.visible = false;
        return;
      }

      const sel = this.getSelectedLight();
      this._im._lightRadiusRings.selected = sel;
      const uiSlider = this._im._radiusSliderUI;
      if (!sel || !this.canEditSelectedLight(sel) || !uiSlider?.el) {
        if (uiSlider?.el) uiSlider.el.style.display = 'none';
        return;
      }

      const pos = this.getSelectedLightWorldPos(sel);
      if (!pos) {
        if (uiSlider?.el) uiSlider.el.style.display = 'none';
        return;
      }
      const groundZ = this.sceneComposer?.groundZ ?? 0;
      const z = groundZ + 4.04;

      const zoom = this._im._getEffectiveZoom();
      const dx = (this._im._lightRadiusRings.offsetPx?.x || 0) / zoom;
      const dy = -(this._im._lightRadiusRings.offsetPx?.y || 0) / zoom;

      // Project world→screen and position the overlay.
      try {
        const THREE = window.THREE;
        const cam = this.sceneComposer?.camera;
        const el = uiSlider.el;
        if (THREE && cam && el) {
          const rect = this._im._getCanvasRectCached();
          const v = this._im._tempVec3UI;
          v.set(pos.x + dx, pos.y + dy, z);
          v.project(cam);
          const sx = rect.left + (v.x * 0.5 + 0.5) * rect.width;
          const sy = rect.top + (-v.y * 0.5 + 0.5) * rect.height;

          const leftCss = `${Math.round(sx)}px`;
          const topCss = `${Math.round(sy)}px`;

          if (uiSlider._lastLeft !== leftCss) {
            el.style.left = leftCss;
            uiSlider._lastLeft = leftCss;
          }
          if (uiSlider._lastTop !== topCss) {
            el.style.top = topCss;
            uiSlider._lastTop = topCss;
          }

          if (el.style.transform !== 'translate(0px, 0px)') el.style.transform = 'translate(0px, 0px)';
          if (el.style.display !== 'block') el.style.display = 'block';
        }
      } catch (_) {
      }

      // Sync slider values from the authoritative light state.
      try {
        const r = this.getSelectedLightRadiiInSceneUnits(sel);
        if (r && uiSlider.dimEl && uiSlider.brightPctEl && uiSlider.dimValueEl && uiSlider.brightValueEl) {
          const dimU = Math.max(0, Math.min(200, r.dimUnits));
          const pct = Math.max(0, Math.min(100, r.brightPct));

          const needsDim = (uiSlider.lastDimUnits === null) || (Math.abs(uiSlider.lastDimUnits - dimU) > 1e-3);
          const needsPct = (uiSlider.lastBrightPct === null) || (Math.abs(uiSlider.lastBrightPct - pct) > 1e-3);
          if (needsDim || needsPct) {
            uiSlider.suppressInput = true;
            if (needsDim) uiSlider.dimEl.value = String(dimU);
            if (needsPct) uiSlider.brightPctEl.value = String(Math.round(pct));
            uiSlider.suppressInput = false;
            uiSlider.lastDimUnits = dimU;
            uiSlider.lastBrightPct = pct;
          }

          const brightU = dimU * (pct / 100);
          uiSlider.dimValueEl.textContent = `${dimU.toFixed(1)}`;
          uiSlider.brightValueEl.textContent = `${Math.round(pct)}% (${brightU.toFixed(1)})`;
        }
      } catch (_) {
      }
    } catch (_) {
    }
  }

  // ── Radius Slider Overlay (HTML) ──────────────────────────────────────────

  createRadiusSliderOverlay() {
    const root = document.createElement('div');
    root.style.position = 'fixed';
    root.style.pointerEvents = 'auto';
    root.style.zIndex = '10002';
    root.style.width = '260px';
    root.style.padding = '10px 12px';
    root.style.borderRadius = '10px';
    root.style.background = 'rgba(20,20,24,0.92)';
    root.style.border = '1px solid rgba(255,255,255,0.12)';
    root.style.boxShadow = '0 10px 30px rgba(0,0,0,0.55)';
    root.style.backdropFilter = 'blur(10px)';
    root.style.webkitBackdropFilter = 'blur(10px)';
    root.style.color = 'rgba(255,255,255,0.9)';
    root.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    root.style.fontSize = '12px';
    root.style.display = 'none';

    // Prevent camera/selection interactions when using sliders.
    const stop = (e) => {
      try { e.stopPropagation(); } catch (_) {}
      try { e.stopImmediatePropagation?.(); } catch (_) {}
    };
    for (const t of ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel']) {
      root.addEventListener(t, stop, { capture: true });
    }

    const makeRow = (label) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.flexDirection = 'column';
      row.style.gap = '4px';
      row.style.marginBottom = '8px';
      const l = document.createElement('div');
      l.textContent = label;
      l.style.opacity = '0.85';
      l.style.fontSize = '11px';
      row.appendChild(l);
      return { row, labelEl: l };
    };

    const makeRange = () => {
      const input = document.createElement('input');
      input.type = 'range';
      input.style.width = '100%';
      input.style.margin = '0';
      input.style.height = '18px';
      return input;
    };

    const makeValue = () => {
      const v = document.createElement('div');
      v.style.opacity = '0.9';
      v.style.fontSize = '11px';
      v.style.textAlign = 'right';
      return v;
    };

    const dimRow = makeRow('Dim Radius');
    const dimWrap = document.createElement('div');
    dimWrap.style.display = 'grid';
    dimWrap.style.gridTemplateColumns = '1fr auto';
    dimWrap.style.gap = '8px';
    const dimEl = makeRange();
    dimEl.min = '0';
    dimEl.max = '200';
    dimEl.step = '0.5';
    const dimValue = makeValue();
    dimWrap.appendChild(dimEl);
    dimWrap.appendChild(dimValue);
    dimRow.row.appendChild(dimWrap);
    root.appendChild(dimRow.row);

    const brightRow = makeRow('Bright (% of Dim)');
    const brightWrap = document.createElement('div');
    brightWrap.style.display = 'grid';
    brightWrap.style.gridTemplateColumns = '1fr auto';
    brightWrap.style.gap = '8px';
    const brightPctEl = makeRange();
    brightPctEl.min = '0';
    brightPctEl.max = '100';
    brightPctEl.step = '1';
    const brightValue = makeValue();
    brightWrap.appendChild(brightPctEl);
    brightWrap.appendChild(brightValue);
    brightRow.row.appendChild(brightWrap);
    root.appendChild(brightRow.row);

    const hint = document.createElement('div');
    hint.textContent = 'Live update while dragging';
    hint.style.opacity = '0.55';
    hint.style.fontSize = '10px';
    hint.style.marginTop = '2px';
    root.appendChild(hint);

    document.body.appendChild(root);

    this._im._radiusSliderUI.el = root;
    this._im._radiusSliderUI.dimEl = dimEl;
    this._im._radiusSliderUI.brightPctEl = brightPctEl;
    this._im._radiusSliderUI.dimValueEl = dimValue;
    this._im._radiusSliderUI.brightValueEl = brightValue;

    const onInput = () => {
      if (this._im._radiusSliderUI.suppressInput) return;
      void this.applyRadiusFromSlidersLive();
    };

    dimEl.addEventListener('input', onInput);
    brightPctEl.addEventListener('input', onInput);
    dimEl.addEventListener('change', onInput);
    brightPctEl.addEventListener('change', onInput);
  }

  // ── UI Hover Label ────────────────────────────────────────────────────────

  createUIHoverLabelOverlay() {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '10001';
    el.style.padding = '4px 10px';
    el.style.borderRadius = '6px';
    el.style.backgroundColor = 'rgba(0,0,0,0.75)';
    el.style.border = '1px solid rgba(255,255,255,0.12)';
    el.style.color = 'rgba(255,255,255,0.92)';
    el.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    el.style.fontSize = '12px';
    el.style.display = 'none';
    document.body.appendChild(el);
    this._im._uiHoverLabel.el = el;
  }

  showUIHoverLabel(text, clientX, clientY) {
    try {
      const el = this._im._uiHoverLabel?.el;
      if (!el) return;
      el.textContent = String(text || '');
      el.style.left = `${clientX + 12}px`;
      el.style.top = `${clientY + 12}px`;
      el.style.display = 'block';
      this._im._uiHoverLabel.visible = true;
    } catch (_) {
    }
  }

  hideUIHoverLabel() {
    try {
      const el = this._im._uiHoverLabel?.el;
      if (el) el.style.display = 'none';
      if (this._im._uiHoverLabel) this._im._uiHoverLabel.visible = false;
    } catch (_) {
    }
  }

  // ── Light Query Helpers ───────────────────────────────────────────────────

  sceneUnitsPerPixel() {
    try {
      const dist = canvas?.dimensions?.distance;
      const size = canvas?.dimensions?.size;
      if (!Number.isFinite(dist) || !Number.isFinite(size) || size <= 0) return 1;
      return dist / size;
    } catch (_) {
    }
    return 1;
  }

  getSelectedLightRadiiInSceneUnits(sel) {
    try {
      if (!sel) return null;

      if (sel.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(sel.id) || canvas?.lighting?.get?.(sel.id)?.document;
        if (!doc) return null;
        const dimUnits = Number(doc.config?.dim ?? 0);
        const brightUnits = Number(doc.config?.bright ?? 0);
        if (!Number.isFinite(dimUnits) || !Number.isFinite(brightUnits)) return null;
        const pct = (dimUnits > 1e-6) ? (brightUnits / dimUnits) * 100 : 0;
        return { dimUnits: Math.max(0, dimUnits), brightPct: Math.max(0, Math.min(100, pct)) };
      }

      if (sel.type === 'enhanced') {
        const radiiPx = this.getSelectedLightRadii(sel);
        if (!radiiPx) return null;
        const unitsPerPx = this.sceneUnitsPerPixel();
        const dimUnits = Number(radiiPx.dim ?? 0) * unitsPerPx;
        const brightUnits = Number(radiiPx.bright ?? 0) * unitsPerPx;
        if (!Number.isFinite(dimUnits) || !Number.isFinite(brightUnits)) return null;
        const pct = (dimUnits > 1e-6) ? (brightUnits / dimUnits) * 100 : 0;
        return { dimUnits: Math.max(0, dimUnits), brightPct: Math.max(0, Math.min(100, pct)) };
      }
    } catch (_) {
    }
    return null;
  }

  getSelectedLights() {
    try {
      if (!this.selection || this.selection.size === 0) return [];

      const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
      const out = [];

      for (const id of this.selection) {
        if (this.lightIconManager?.lights?.has?.(id)) {
          out.push({ type: 'foundry', id: String(id) });
          continue;
        }

        if (enhancedLightIconManager?.lights?.has?.(id)) {
          out.push({ type: 'enhanced', id: String(id) });
        }
      }

      return out;
    } catch (_) {
      return [];
    }
  }

  getSelectedLight() {
    try {
      if (!this.selection || this.selection.size !== 1) return null;
      const id = Array.from(this.selection)[0];

      const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
      if (enhancedLightIconManager?.lights?.has?.(id)) {
        return { type: 'enhanced', id: String(id) };
      }

      if (this.lightIconManager?.lights?.has?.(id)) {
        return { type: 'foundry', id: String(id) };
      }
    } catch (_) {
    }
    return null;
  }

  canEditSelectedLight(sel) {
    try {
      if (!sel) return false;
      if (sel.type === 'enhanced') return !!game.user.isGM;
      if (sel.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(sel.id) || canvas?.lighting?.get?.(sel.id)?.document;
        return !!(doc && doc.canUserModify(game.user, 'update'));
      }
    } catch (_) {
    }
    return false;
  }

  getSelectedLightWorldPos(sel) {
    try {
      const THREE = window.THREE;
      if (!THREE) return null;
      const v = new THREE.Vector3();

      if (sel.type === 'enhanced') {
        const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
        const root = enhancedLightIconManager?.getRootObject?.(sel.id);
        if (root?.getWorldPosition) {
          root.getWorldPosition(v);
          return v;
        }
      }

      if (sel.type === 'foundry') {
        const sprite = this.lightIconManager?.lights?.get?.(sel.id);
        if (sprite?.getWorldPosition) {
          sprite.getWorldPosition(v);
          return v;
        }

        const doc = canvas?.scene?.lights?.get?.(sel.id) || canvas?.lighting?.get?.(sel.id)?.document;
        if (doc) {
          const w = Coordinates.toWorld(doc.x, doc.y);
          v.set(w.x, w.y, 0);
          return v;
        }
      }
    } catch (_) {
    }
    return null;
  }

  getSelectedLightRadii(sel) {
    try {
      if (sel.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(sel.id) || canvas?.lighting?.get?.(sel.id)?.document;
        if (doc) {
          const gridSize = canvas?.scene?.grid?.size || 100;
          return {
            bright: (doc.config?.bright ?? 0) * gridSize,
            dim: (doc.config?.dim ?? 0) * gridSize
          };
        }
      } else if (sel.type === 'enhanced') {
        const container = canvas?.scene?.getFlag?.('map-shine-advanced', 'enhancedLights');
        const lights = container?.lights;
        const data = Array.isArray(lights) ? lights.find((l) => String(l?.id) === String(sel.id)) : null;
        if (data) {
          return {
            bright: Number(data.photometry?.bright ?? 0),
            dim: Number(data.photometry?.dim ?? 0)
          };
        }
      }
    } catch (_) {
    }
    return null;
  }

  // ── Radius Commit / Live-Apply ────────────────────────────────────────────

  async commitRadiiSceneUnits(sel, dimUnits, brightPct) {
    try {
      if (!sel) return;
      const dimU = Math.max(0, Number(dimUnits) || 0);
      const pct = Math.max(0, Math.min(100, Number(brightPct) || 0));
      const brightU = dimU * (pct / 100);

      if (sel.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(sel.id) || canvas?.lighting?.get?.(sel.id)?.document;
        if (!doc) return;
        await doc.update({
          'config.dim': dimU,
          'config.bright': brightU
        });
        return;
      }

      if (sel.type === 'enhanced') {
        const api = window.MapShine?.enhancedLights;
        if (!api?.update) return;
        const unitsPerPx = this.sceneUnitsPerPixel();
        const pxPerUnit = unitsPerPx > 1e-9 ? (1 / unitsPerPx) : 1;
        await api.update(sel.id, {
          photometry: {
            dim: dimU * pxPerUnit,
            bright: brightU * pxPerUnit
          }
        });
      }
    } catch (_) {
    }
  }

  async applyRadiusFromSlidersLive() {
    try {
      const uiSlider = this._im._radiusSliderUI;
      if (!uiSlider?.el || !uiSlider.dimEl || !uiSlider.brightPctEl) return;
      const sel = this.getSelectedLight();
      if (!sel || !this.canEditSelectedLight(sel)) return;

      const dimUnits = parseFloat(uiSlider.dimEl.value);
      const brightPct = parseFloat(uiSlider.brightPctEl.value);
      if (!Number.isFinite(dimUnits) || !Number.isFinite(brightPct)) return;

      this._im._lightRadiusRings.pendingType = 'both';
      this._im._lightRadiusRings.pendingRadius = { dimUnits, brightPct };

      const st = this._im._lightRadiusRings;
      const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const hz = Math.max(1, Number(st.liveApplyHz) || 15);
      const intervalMs = 1000 / hz;
      if ((nowMs - (st.lastLiveApplyMs || 0)) < intervalMs) return;
      st.lastLiveApplyMs = nowMs;

      if (st.liveInFlight) {
        st.liveQueued = { sel, radiusType: 'both', newRadius: { dimUnits, brightPct } };
        return;
      }

      st.liveInFlight = true;
      st.liveQueued = null;

      const run = async () => {
        try {
          await this.commitRadiiSceneUnits(sel, dimUnits, brightPct);
        } catch (_) {
        } finally {
          st.liveInFlight = false;
          const q = st.liveQueued;
          st.liveQueued = null;
          if (q && q.radiusType === 'both' && q.newRadius) {
            try {
              const d2 = q.newRadius.dimUnits;
              const p2 = q.newRadius.brightPct;
              if (Number.isFinite(d2) && Number.isFinite(p2)) {
                uiSlider.suppressInput = true;
                uiSlider.dimEl.value = String(d2);
                uiSlider.brightPctEl.value = String(p2);
                uiSlider.suppressInput = false;
              }
              await this.commitRadiiSceneUnits(q.sel, d2, p2);
            } catch (_) {
              uiSlider.suppressInput = false;
            }
          }
        }
      };

      void run();
    } catch (_) {
    }
  }

  previewRadiusChange(sel, radiusType, newRadius) {
    try {
      this._im._lightRadiusRings.pendingType = radiusType;
      this._im._lightRadiusRings.pendingRadius = newRadius;
      if (radiusType === 'bright') this._im._lightRadiusRings.previewBright = newRadius;
      else this._im._lightRadiusRings.previewDim = newRadius;
    } catch (_) {
    }
  }

  applyPendingRadiusLive(sel) {
    try {
      const st = this._im._lightRadiusRings;
      if (!st) return;

      const radiusType = st.pendingType;
      const newRadius = st.pendingRadius;
      if (!radiusType || !Number.isFinite(newRadius)) return;

      const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const hz = Math.max(1, Number(st.liveApplyHz) || 15);
      const intervalMs = 1000 / hz;

      if ((nowMs - (st.lastLiveApplyMs || 0)) < intervalMs) return;
      st.lastLiveApplyMs = nowMs;

      if (st.liveInFlight) {
        st.liveQueued = { sel, radiusType, newRadius };
        return;
      }

      st.liveInFlight = true;
      st.liveQueued = null;

      const run = async () => {
        try {
          await this.commitPendingRadius(sel);
        } catch (_) {
        } finally {
          st.liveInFlight = false;
          const q = st.liveQueued;
          st.liveQueued = null;
          if (q && q.sel && q.radiusType && Number.isFinite(q.newRadius)) {
            try {
              this.previewRadiusChange(q.sel, q.radiusType, q.newRadius);
              this.applyPendingRadiusLive(q.sel);
            } catch (_) {
            }
          }
        }
      };

      void run();
    } catch (_) {
    }
  }

  async commitPendingRadius(sel) {
    try {
      const radiusType = this._im._lightRadiusRings.pendingType;
      const newRadius = this._im._lightRadiusRings.pendingRadius;
      if (!radiusType || !Number.isFinite(newRadius)) return;

      if (sel.type === 'foundry') {
        const doc = canvas?.scene?.lights?.get?.(sel.id) || canvas?.lighting?.get?.(sel.id)?.document;
        if (!doc) return;

        const gridSize = canvas?.scene?.grid?.size || 100;
        const gridUnits = newRadius / gridSize;
        const updateData = {};
        if (radiusType === 'bright') updateData['config.bright'] = gridUnits;
        else updateData['config.dim'] = gridUnits;
        await doc.update(updateData);
        return;
      }

      if (sel.type === 'enhanced') {
        const api = window.MapShine?.enhancedLights;
        if (!api?.update) return;

        const updateData = { photometry: {} };
        if (radiusType === 'bright') updateData.photometry.bright = newRadius;
        else updateData.photometry.dim = newRadius;
        await api.update(sel.id, updateData);
      }
    } catch (_) {
    }
  }

  commitRadiusChange() {
    try {
      const sel = this._im._lightRadiusRings?.selected;
      if (sel) {
        void this.commitPendingRadius(sel);
      }

      try {
        this.hideUIHoverLabel();
      } catch (_) {
      }

      if (window.MapShine?.cameraController) {
        window.MapShine.cameraController.enabled = true;
      }

      this.canvasElement.style.cursor = '';

      this.dragState.active = false;
      this.dragState.mode = null;
      this.dragState.object = null;
      this._im._lightRadiusRings.dragging = null;
      this._im._lightRadiusRings.startRadius = 0;
      this._im._lightRadiusRings.startDistance = 0;
      this._im._lightRadiusRings.pendingType = null;
      this._im._lightRadiusRings.pendingRadius = null;
      this._im._lightRadiusRings.previewBright = null;
      this._im._lightRadiusRings.previewDim = null;
      this._im._lightRadiusRings.liveQueued = null;

      const lightEditor = window.MapShine?.lightEditor;
      lightEditor?._refreshFromSource?.();
    } catch (_) {
    }
  }
}
