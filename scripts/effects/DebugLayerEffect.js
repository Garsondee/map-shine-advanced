import { EffectBase, RenderLayers, OVERLAY_THREE_LAYER } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('DebugLayerEffect');

export class DebugLayerEffect extends EffectBase {
  constructor() {
    super('debug-layer', RenderLayers.ENVIRONMENTAL, 'low');

    this.priority = 10001;
    this.enabled = false;

    this.params = {
      enabled: false,
      showPanel: true,
      showTether: true,
      showCollisionPoint: true,
      onlyWhenTokenControlled: true,
      onlyForOwnedTokens: true,
      maxDistanceUnits: 9
    };

    this.scene = null;
    this.camera = null;

    this.overlayGroup = null;
    this._line = null;
    this._lineGeom = null;
    this._lineMat = null;

    this._cursorMarker = null;
    this._collisionMarker = null;

    this._panelEl = null;
    this._panelText = '';

    this._pointerClientX = null;
    this._pointerClientY = null;
    this._onPointerMove = this._handlePointerMove.bind(this);

    this._tempA = null;
    this._tempB = null;
    this._tempC = null;

    this._lastProbe = {
      tokenId: null,
      tokenName: null,
      isOwner: false,
      canUpdate: false,
      tokenWorldX: 0,
      tokenWorldY: 0,
      cursorWorldX: 0,
      cursorWorldY: 0,
      distancePx: 0,
      distanceUnits: 0,
      blocked: false,
      collisionWorldX: null,
      collisionWorldY: null
    };
  }

  static getControlSchema() {
    return {
      enabled: false,
      groups: [
        {
          name: 'debug-layer',
          label: 'Debug Layer',
          type: 'inline',
          parameters: [
            'enabled',
            'showPanel',
            'showTether',
            'showCollisionPoint',
            'onlyWhenTokenControlled',
            'onlyForOwnedTokens',
            'maxDistanceUnits'
          ]
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: false },
        showPanel: { type: 'boolean', label: 'Panel', default: true },
        showTether: { type: 'boolean', label: 'Tether', default: true },
        showCollisionPoint: { type: 'boolean', label: 'Hit Point', default: true },
        onlyWhenTokenControlled: { type: 'boolean', label: 'Only Controlled', default: true },
        onlyForOwnedTokens: { type: 'boolean', label: 'Only Owned', default: true },
        maxDistanceUnits: { type: 'slider', label: 'Max Dist (u)', min: 1, max: 200, step: 1, default: 9, throttle: 50 }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) return;

    this.scene = scene;
    this.camera = camera;

    this._tempA = new THREE.Vector3();
    this._tempB = new THREE.Vector3();
    this._tempC = new THREE.Vector3();

    this.overlayGroup = new THREE.Group();
    this.overlayGroup.name = 'DebugLayer';
    this.overlayGroup.layers.set(OVERLAY_THREE_LAYER);

    const positions = new Float32Array(6);
    this._lineGeom = new THREE.BufferGeometry();
    this._lineGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    this._lineMat = new THREE.LineBasicMaterial({
      color: 0x22ff66,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 1.0
    });

    this._line = new THREE.Line(this._lineGeom, this._lineMat);
    this._line.layers.set(OVERLAY_THREE_LAYER);
    this._line.frustumCulled = false;
    this.overlayGroup.add(this._line);

    const ringGeo = new THREE.RingGeometry(6, 10, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.75,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this._cursorMarker = new THREE.Mesh(ringGeo, ringMat);
    this._cursorMarker.layers.set(OVERLAY_THREE_LAYER);
    this._cursorMarker.visible = false;
    this._cursorMarker.frustumCulled = false;
    this.overlayGroup.add(this._cursorMarker);

    const hitGeo = new THREE.RingGeometry(8, 12, 32);
    const hitMat = new THREE.MeshBasicMaterial({
      color: 0xff3355,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this._collisionMarker = new THREE.Mesh(hitGeo, hitMat);
    this._collisionMarker.layers.set(OVERLAY_THREE_LAYER);
    this._collisionMarker.visible = false;
    this._collisionMarker.frustumCulled = false;
    this.overlayGroup.add(this._collisionMarker);

    if (this.scene) {
      this.scene.add(this.overlayGroup);
    }

    this._createPanel();

    window.addEventListener('pointermove', this._onPointerMove, { passive: true });

    log.info('DebugLayerEffect initialized');
  }

  applyParamChange(paramId, value) {
    if (!this.params) return;
    if (paramId === 'enabled') {
      this.enabled = !!value;
      this.params.enabled = !!value;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }
  }

  update(timeInfo) {
    if (!this.enabled) {
      this._setVisible(false);
      this._setPanelVisible(false);
      return;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    const tokenId = this._getActiveTokenId();
    if (!tokenId) {
      this._setVisible(false);
      this._setPanelVisible(!!this.params.showPanel);
      this._updatePanel(timeInfo, null);
      return;
    }

    const tokenSprite = window.MapShine?.tokenManager?.getTokenSprite?.(tokenId) ?? null;
    const tokenDoc = tokenSprite?.userData?.tokenDoc ?? null;
    const tokenObj = canvas?.tokens?.get?.(tokenId) ?? null;

    if (!tokenSprite || !tokenDoc || !tokenObj) {
      this._setVisible(false);
      this._setPanelVisible(!!this.params.showPanel);
      this._updatePanel(timeInfo, null);
      return;
    }

    const isOwner = !!tokenDoc.isOwner;
    const canUpdate = !!tokenDoc.canUserModify?.(game.user, 'update');

    if (this.params.onlyForOwnedTokens && !isOwner) {
      this._setVisible(false);
      this._setPanelVisible(!!this.params.showPanel);
      this._updatePanel(timeInfo, {
        tokenId,
        tokenName: tokenDoc.name ?? null,
        isOwner,
        canUpdate
      });
      return;
    }

    if (this._pointerClientX === null || this._pointerClientY === null) {
      this._setVisible(false);
      this._setPanelVisible(!!this.params.showPanel);
      this._updatePanel(timeInfo, {
        tokenId,
        tokenName: tokenDoc.name ?? null,
        isOwner,
        canUpdate
      });
      return;
    }

    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    const im = window.MapShine?.interactionManager;
    const worldPos = (im && typeof im.viewportToWorld === 'function')
      ? im.viewportToWorld(this._pointerClientX, this._pointerClientY, groundZ)
      : null;

    if (!worldPos) {
      this._setVisible(false);
      this._setPanelVisible(!!this.params.showPanel);
      this._updatePanel(timeInfo, {
        tokenId,
        tokenName: tokenDoc.name ?? null,
        isOwner,
        canUpdate
      });
      return;
    }

    const tokenCenterWorld = tokenSprite.position;

    const dx = worldPos.x - tokenCenterWorld.x;
    const dy = worldPos.y - tokenCenterWorld.y;
    const distancePx = Math.hypot(dx, dy);

    const d = canvas?.dimensions;
    const pxToUnits = (d && typeof d.distance === 'number' && typeof d.size === 'number' && d.size > 0)
      ? (d.distance / d.size)
      : 1;
    const distanceUnits = distancePx * pxToUnits;

    let blocked = false;
    let collisionWorld = null;

    try {
      const destFoundry = Coordinates.toFoundry(worldPos.x, worldPos.y);
      const collision = tokenObj.checkCollision(destFoundry, { mode: 'closest', type: 'move' });
      if (collision) {
        blocked = true;
        const cv = Coordinates.toWorld(collision.x, collision.y);
        collisionWorld = this._tempC;
        collisionWorld.set(cv.x, cv.y, groundZ);
      }
    } catch (_) {
    }

    const targetWorld = blocked && collisionWorld ? collisionWorld : worldPos;

    this._writeLine(tokenCenterWorld, targetWorld, blocked);

    if (this._cursorMarker) {
      this._cursorMarker.visible = !!this.params.showTether;
      if (this._cursorMarker.visible) {
        this._cursorMarker.position.set(worldPos.x, worldPos.y, groundZ + 0.1);
        this._cursorMarker.updateMatrix();
      }
    }

    if (this._collisionMarker) {
      this._collisionMarker.visible = !!(this.params.showCollisionPoint && blocked && collisionWorld);
      if (this._collisionMarker.visible) {
        this._collisionMarker.position.set(collisionWorld.x, collisionWorld.y, groundZ + 0.11);
        this._collisionMarker.updateMatrix();
      }
    }

    this._setVisible(!!this.params.showTether);
    this._setPanelVisible(!!this.params.showPanel);

    this._lastProbe.tokenId = tokenId;
    this._lastProbe.tokenName = tokenDoc.name ?? null;
    this._lastProbe.isOwner = isOwner;
    this._lastProbe.canUpdate = canUpdate;
    this._lastProbe.tokenWorldX = tokenCenterWorld.x;
    this._lastProbe.tokenWorldY = tokenCenterWorld.y;
    this._lastProbe.cursorWorldX = worldPos.x;
    this._lastProbe.cursorWorldY = worldPos.y;
    this._lastProbe.distancePx = distancePx;
    this._lastProbe.distanceUnits = distanceUnits;
    this._lastProbe.blocked = blocked;
    this._lastProbe.collisionWorldX = collisionWorld ? collisionWorld.x : null;
    this._lastProbe.collisionWorldY = collisionWorld ? collisionWorld.y : null;

    this._updatePanel(timeInfo, this._lastProbe);
  }

  render(renderer, scene, camera) {
  }

  dispose() {
    try {
      window.removeEventListener('pointermove', this._onPointerMove);
    } catch (_) {
    }

    if (this._panelEl && this._panelEl.parentNode) {
      try {
        this._panelEl.parentNode.removeChild(this._panelEl);
      } catch (_) {
      }
    }
    this._panelEl = null;

    if (this.overlayGroup && this.overlayGroup.parent) {
      this.overlayGroup.parent.remove(this.overlayGroup);
    }

    if (this._lineGeom) {
      this._lineGeom.dispose();
      this._lineGeom = null;
    }
    if (this._lineMat) {
      this._lineMat.dispose();
      this._lineMat = null;
    }

    if (this._cursorMarker) {
      this._cursorMarker.geometry?.dispose?.();
      this._cursorMarker.material?.dispose?.();
      this._cursorMarker = null;
    }

    if (this._collisionMarker) {
      this._collisionMarker.geometry?.dispose?.();
      this._collisionMarker.material?.dispose?.();
      this._collisionMarker = null;
    }

    this.overlayGroup = null;
    this.scene = null;
    this.camera = null;

    super.dispose();
  }

  _handlePointerMove(ev) {
    this._pointerClientX = ev.clientX;
    this._pointerClientY = ev.clientY;
  }

  _getActiveTokenId() {
    try {
      const controlled = canvas?.tokens?.controlled;
      if (Array.isArray(controlled) && controlled.length > 0) {
        const t = controlled[0];
        const id = t?.document?.id ?? t?.id;
        if (id) return id;
      }
    } catch (_) {
    }

    if (!this.params.onlyWhenTokenControlled) {
      try {
        const selection = window.MapShine?.interactionManager?.selection;
        const tm = window.MapShine?.tokenManager;
        if (selection && tm && typeof tm.getTokenSprite === 'function') {
          for (const id of selection) {
            if (tm.getTokenSprite(id)) return id;
          }
        }
      } catch (_) {
      }
    }

    return null;
  }

  _writeLine(a, b, blocked) {
    if (!this._lineGeom || !this._lineMat || !this._line) return;

    const attr = this._lineGeom.getAttribute('position');
    if (!attr || !attr.array) return;

    const z = window.MapShine?.sceneComposer?.groundZ ?? 0;
    attr.array[0] = a.x;
    attr.array[1] = a.y;
    attr.array[2] = z + 0.09;
    attr.array[3] = b.x;
    attr.array[4] = b.y;
    attr.array[5] = z + 0.09;
    attr.needsUpdate = true;

    if (blocked) {
      this._lineMat.color.setHex(0xff3355);
    } else {
      this._lineMat.color.setHex(0x22ff66);
    }
  }

  _createPanel() {
    const el = document.createElement('div');
    el.id = 'mapshine-debug-layer-panel';
    el.style.position = 'fixed';
    el.style.left = '10px';
    el.style.top = '10px';
    el.style.zIndex = '10000';
    el.style.pointerEvents = 'none';
    el.style.padding = '8px 10px';
    el.style.borderRadius = '6px';
    el.style.background = 'rgba(0,0,0,0.65)';
    el.style.color = 'white';
    el.style.fontFamily = 'monospace';
    el.style.fontSize = '12px';
    el.style.whiteSpace = 'pre';
    el.style.maxWidth = '420px';
    el.style.display = 'none';

    document.body.appendChild(el);
    this._panelEl = el;
  }

  _setPanelVisible(v) {
    if (!this._panelEl) return;
    this._panelEl.style.display = v ? 'block' : 'none';
  }

  _updatePanel(timeInfo, data) {
    if (!this._panelEl) return;
    if (!this.params.showPanel) return;

    const frameCount = timeInfo?.frameCount ?? 0;
    if (frameCount % 6 !== 0) return;

    const tm = window.MapShine?.tokenManager;
    const tokenCount = tm?.tokenSprites?.size ?? null;

    if (!data) {
      const text = [
        'Debug Layer',
        '',
        `tokens: ${tokenCount ?? '?'}`,
        'active: none',
        'move mouse / control a token'
      ].join('\n');

      if (text !== this._panelText) {
        this._panelEl.textContent = text;
        this._panelText = text;
      }
      return;
    }

    const out = [];
    out.push('Debug Layer');
    out.push('');
    out.push(`tokens: ${tokenCount ?? '?'}`);
    out.push(`token: ${data.tokenName ?? '(unnamed)'} (${data.tokenId ?? '?'})`);
    out.push(`owner: ${data.isOwner ? 'yes' : 'no'} | canUpdate: ${data.canUpdate ? 'yes' : 'no'}`);

    if (typeof data.tokenWorldX === 'number') {
      out.push(`tokenWorld: ${data.tokenWorldX.toFixed(1)}, ${data.tokenWorldY.toFixed(1)}`);
    }
    if (typeof data.cursorWorldX === 'number') {
      out.push(`cursorWorld: ${data.cursorWorldX.toFixed(1)}, ${data.cursorWorldY.toFixed(1)}`);
    }

    if (typeof data.distancePx === 'number') {
      out.push(`dist: ${data.distanceUnits.toFixed(2)}u (${data.distancePx.toFixed(1)}px)`);
    }

    out.push(`blocked: ${data.blocked ? 'yes' : 'no'}`);
    if (data.blocked && data.collisionWorldX !== null) {
      out.push(`hitWorld: ${data.collisionWorldX.toFixed(1)}, ${data.collisionWorldY.toFixed(1)}`);
    }

    const text = out.join('\n');
    if (text !== this._panelText) {
      this._panelEl.textContent = text;
      this._panelText = text;
    }
  }

  _setVisible(v) {
    if (this._line) this._line.visible = v;
    if (this._cursorMarker) this._cursorMarker.visible = v && !!this.params.showTether;
    if (this._collisionMarker) this._collisionMarker.visible = v && !!this.params.showCollisionPoint;
  }
}
