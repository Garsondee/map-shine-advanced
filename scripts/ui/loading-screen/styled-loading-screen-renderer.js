/**
 * @fileoverview Styled loading screen renderer (DOM + CSS animations).
 * @module ui/loading-screen/styled-loading-screen-renderer
 */

import { installLoadingScreenAnimationStyle, mapAmbientAnimationClass, mapEntranceAnimationClass } from './loading-screen-animations.js';
import { normalizeLoadingScreenConfig } from './loading-screen-config.js';
import { familySpecToFamilyName } from './loading-screen-fonts.js';
import { getCachedWallpaperImage, loadImage, selectWallpaper } from './loading-screen-wallpapers.js';

/**
 * Styled DOM renderer implementing the same API contract as LoadingOverlay.
 */
export class StyledLoadingScreenRenderer {
  constructor() {
    this.el = null;
    this._style = null;
    this._token = 0;

    this._progressCurrent = 0;
    this._progressTarget = 0;
    this._progressRaf = 0;
    this._progressLastTs = 0;
    this._autoProgress = null;

    this._stages = null;
    this._stageState = null;

    this._elementsById = new Map();
    this._stageRow = null;
    this._progressFill = null;

    this._timerStart = 0;
    this._timerRaf = 0;
    this._timerEl = null;

    this._debugMode = false;
    this._debugContainer = null;
    this._debugLog = null;
    this._debugDismissBtn = null;
    this._debugDismissCallback = null;

    this._sceneName = 'scene';
    this._message = 'Starting…';
    this._config = normalizeLoadingScreenConfig(null);
    this._activeWallpaper = null;
  }

  /**
   * @param {Object} config
   */
  setConfig(config) {
    this._config = normalizeLoadingScreenConfig(config);
    if (this.el) {
      this._rebuild();
    }
  }

  /**
   * @param {Object|null} wallpaperEntry
   */
  setActiveWallpaper(wallpaperEntry) {
    this._activeWallpaper = wallpaperEntry || null;
    if (this.el) this._applyWallpaper();
  }

  configureStages(stages) {
    this._stages = Array.isArray(stages) ? stages.filter(Boolean) : null;
    this._stageState = null;
  }

  startStages(opts = undefined) {
    this.ensure();
    const stages = Array.isArray(opts?.stages) ? opts.stages : this._stages;
    if (!Array.isArray(stages) || stages.length === 0) {
      this._stageState = null;
      this._renderStagePills();
      return;
    }

    const normalized = [];
    let totalWeight = 0;
    for (const s of stages) {
      const id = String(s.id || '').trim();
      if (!id) continue;
      const weight = Number.isFinite(s.weight) ? Math.max(0, s.weight) : 1;
      totalWeight += weight;
      normalized.push({ id, label: s.label ?? null, weight });
    }

    if (normalized.length === 0 || totalWeight <= 0) {
      this._stageState = null;
      this._renderStagePills();
      return;
    }

    let acc = 0;
    const ranges = new Map();
    for (const s of normalized) {
      const start = acc / totalWeight;
      acc += s.weight;
      const end = acc / totalWeight;
      ranges.set(s.id, { start, end, label: s.label });
    }

    this._stageState = {
      ranges,
      currentStageId: null,
      currentStageProgress: 0,
    };

    this._renderStagePills();
  }

  setStage(stageId, progress01 = 0, message = undefined, opts = undefined) {
    this.ensure();
    if (!this._stageState?.ranges) return;

    const id = String(stageId || '').trim();
    const range = this._stageState.ranges.get(id);
    if (!range) return;

    const p = Number.isFinite(progress01) ? clamp(progress01, 0, 1) : 0;
    this._stageState.currentStageId = id;
    this._stageState.currentStageProgress = p;

    const global = range.start + (range.end - range.start) * p;
    const label = message ?? range.label;
    if (label !== undefined && label !== null) {
      this.setMessage(String(label));
    }

    this._updateStagePills(id);
    this.setProgress(global, opts);
  }

  ensure() {
    if (this.el) return;

    installLoadingScreenAnimationStyle();

    const root = document.createElement('div');
    root.id = 'map-shine-styled-loading-overlay';
    root.className = 'map-shine-styled-loading-overlay map-shine-loading-overlay--hidden';
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.zIndex = '100001';
    root.style.display = 'none';
    root.style.opacity = '1';
    root.style.pointerEvents = 'none';
    root.style.background = this._config.style.backgroundColor;
    root.style.overflow = 'hidden';

    this.el = root;
    this._installRuntimeStyle();
    this._rebuild();

    if (document.body) document.body.appendChild(root);
    else (document.documentElement || document.head)?.appendChild(root);
  }

  setSceneName(name) {
    this._sceneName = String(name || 'scene');
    const sceneEl = this._elementsById.get('scene-name');
    if (sceneEl) {
      const prefix = String(sceneEl.dataset.prefix || 'Loading ');
      sceneEl.textContent = `${prefix}${this._sceneName}`;
    }
  }

  setMessage(message) {
    this._message = String(message || '');
    const msgEl = this._elementsById.get('message');
    if (msgEl) msgEl.textContent = this._message;
  }

  setProgress(value01, opts = undefined) {
    this.ensure();
    const v = Number.isFinite(value01) ? clamp(value01, 0, 1) : 0;
    const immediate = !!opts?.immediate;
    const keepAuto = !!opts?.keepAuto;

    if (!keepAuto) this._autoProgress = null;
    this._progressTarget = v;

    if (immediate) {
      this._progressCurrent = v;
      this._applyProgress(v);
      this._stopProgressLoop();
      return;
    }

    this._startProgressLoop();
  }

  startAutoProgress(target01, rate01PerSec = 0.01) {
    this.ensure();
    const t = Number.isFinite(target01) ? clamp(target01, 0, 1) : 0;
    const rate = Number.isFinite(rate01PerSec) ? Math.max(0, rate01PerSec) : 0.01;
    this._autoProgress = { target: t, rate };
    this._startProgressLoop();
  }

  stopAutoProgress() {
    this._autoProgress = null;
  }

  showBlack(message = 'Loading…') {
    this.ensure();
    this._resetProgress();
    this.setMessage(message);
    this._startTimer();

    this.el.style.display = 'block';
    this.el.style.pointerEvents = 'auto';
    this.el.style.opacity = '1';
    this.el.style.background = this._config.style.backgroundColor;
    this.el.classList.remove('map-shine-loading-overlay--hidden');
  }

  showLoading(message = 'Loading…') {
    this.showBlack(message);
  }

  hide() {
    if (!this.el) return;
    this._resetProgress();
    this._stopTimer();
    this.el.classList.add('map-shine-loading-overlay--hidden');
    this.el.style.display = 'none';
    this.el.style.pointerEvents = 'none';
  }

  async fadeToBlack(durationMs = 500, _contentFadeMs = 250) {
    this.ensure();
    const token = ++this._token;

    this.el.style.display = 'block';
    this.el.style.pointerEvents = 'auto';
    this.el.style.transition = `opacity ${Math.max(0, durationMs)}ms ease`;
    this.el.style.opacity = '0';
    await this._nextFrame();
    this.el.style.opacity = '1';

    await sleep(Math.max(0, durationMs));
    if (token !== this._token) return;
  }

  async fadeIn(durationMs = 500, _contentFadeMs = 250) {
    if (!this.el) return;
    const token = ++this._token;

    this.el.style.display = 'block';
    this.el.style.pointerEvents = 'none';
    this.el.style.transition = `opacity ${Math.max(0, durationMs)}ms ease`;
    this.el.style.opacity = '1';
    await this._nextFrame();
    this.el.style.opacity = '0';
    await sleep(Math.max(0, durationMs));
    if (token !== this._token) return;

    this.hide();
  }

  enableDebugMode() {
    this.ensure();
    this._debugMode = true;
    if (this._debugContainer) this._debugContainer.style.display = 'block';
    if (this.el) this.el.style.pointerEvents = 'auto';
    if (this._debugLog) this._debugLog.textContent = '';
    if (this._debugDismissBtn) this._debugDismissBtn.style.display = 'none';
  }

  disableDebugMode() {
    this._debugMode = false;
    if (this._debugContainer) this._debugContainer.style.display = 'none';
    if (this._debugDismissBtn) this._debugDismissBtn.style.display = 'none';
  }

  appendDebugLine(line) {
    if (!this._debugLog) return;
    if (this._debugLog.textContent) this._debugLog.textContent += `\n${line}`;
    else this._debugLog.textContent = String(line || '');
    this._debugLog.scrollTop = this._debugLog.scrollHeight;
  }

  setDebugLog(text) {
    if (!this._debugLog) return;
    this._debugLog.textContent = String(text || '');
    this._debugLog.scrollTop = this._debugLog.scrollHeight;
  }

  showDebugDismiss(callback = null) {
    this._debugDismissCallback = typeof callback === 'function' ? callback : null;
    if (this._debugDismissBtn) this._debugDismissBtn.style.display = 'block';
    if (this.el) this.el.style.pointerEvents = 'auto';
  }

  /**
   * Returns elapsed seconds since the timer started (matches legacy LoadingOverlay API).
   * @returns {number}
   */
  getElapsedSeconds() {
    if (!this._timerStart) return 0;
    return (performance.now() - this._timerStart) / 1000;
  }

  _applyProgress(value01) {
    const pct = Math.round(clamp(value01, 0, 1) * 1000) / 10;
    if (this._progressFill) this._progressFill.style.width = `${pct}%`;

    const pctEl = this._elementsById.get('percentage');
    if (pctEl) pctEl.textContent = `${Math.round(clamp(value01, 0, 1) * 100)}%`;
  }

  _resetProgress() {
    this._autoProgress = null;
    this._progressCurrent = 0;
    this._progressTarget = 0;
    this._applyProgress(0);
    this._stopProgressLoop();
    if (this._stageRow) this._stageRow.innerHTML = '';
  }

  _stopProgressLoop() {
    if (this._progressRaf) {
      try { cancelAnimationFrame(this._progressRaf); } catch (_) {}
    }
    this._progressRaf = 0;
    this._progressLastTs = 0;
  }

  _startProgressLoop() {
    if (this._progressRaf) return;
    this._progressRaf = requestAnimationFrame((ts) => this._progressTick(ts));
  }

  _progressTick(ts) {
    this._progressRaf = 0;
    if (!this.el || !this._progressFill) return;

    if (!this._progressLastTs) this._progressLastTs = ts;
    const dt = Math.min(0.05, Math.max(0, (ts - this._progressLastTs) / 1000));
    this._progressLastTs = ts;

    if (this._autoProgress && dt > 0) {
      const t = this._autoProgress.target;
      if (this._progressTarget < t) {
        this._progressTarget = Math.min(t, this._progressTarget + this._autoProgress.rate * dt);
      }
    }

    const diff = this._progressTarget - this._progressCurrent;
    if (Math.abs(diff) < 0.0005) {
      this._progressCurrent = this._progressTarget;
    } else if (dt > 0) {
      const k = 1 - Math.exp(-8 * dt);
      this._progressCurrent += diff * k;
    }

    this._applyProgress(this._progressCurrent);

    const needsMore = Math.abs(this._progressTarget - this._progressCurrent) >= 0.0005;
    const needsAuto = !!this._autoProgress && this._progressTarget < this._autoProgress.target;

    if (needsMore || needsAuto) {
      this._progressRaf = requestAnimationFrame((nextTs) => this._progressTick(nextTs));
    } else {
      this._stopProgressLoop();
    }
  }

  _startTimer() {
    this._timerStart = performance.now();
    if (this._timerEl) this._timerEl.textContent = '0.0s';
    this._stopTimerLoop();
    this._timerRaf = requestAnimationFrame(() => this._timerTick());
  }

  _stopTimer() {
    this._stopTimerLoop();
  }

  _stopTimerLoop() {
    if (this._timerRaf) {
      try { cancelAnimationFrame(this._timerRaf); } catch (_) {}
    }
    this._timerRaf = 0;
  }

  _timerTick() {
    this._timerRaf = 0;
    if (!this._timerEl || !this._timerStart) return;

    const elapsed = (performance.now() - this._timerStart) / 1000;
    this._timerEl.textContent = elapsed < 10 ? `${elapsed.toFixed(1)}s` : `${Math.round(elapsed)}s`;

    this._timerRaf = requestAnimationFrame(() => this._timerTick());
  }

  _rebuild() {
    if (!this.el) return;

    this.el.innerHTML = '';
    this._elementsById.clear();
    this._stageRow = null;
    this._progressFill = null;
    this._timerEl = null;

    this.el.style.background = String(this._config.style.backgroundColor || 'rgba(0,0,0,1)');
    this.el.style.setProperty('--ms-ls-accent', String(this._config.style.accentColor || 'rgba(0,180,255,0.9)'));
    this.el.style.setProperty('--ms-ls-accent-2', String(this._config.style.secondaryAccentColor || 'rgba(140,100,255,0.9)'));
    this.el.style.setProperty('--ms-ls-wallpaper-fit', String(this._config.wallpapers?.fit || 'cover'));

    // Wallpaper layer
    const wallLayer = document.createElement('div');
    wallLayer.className = 'map-shine-styled-loading-overlay__wallpaper';
    this.el.appendChild(wallLayer);

    // Optional overlay effects
    this._buildOverlayEffects();

    // Panel
    const panelCfg = this._config.layout?.panel || {};
    const panel = document.createElement('div');
    panel.className = 'map-shine-styled-loading-overlay__panel';
    panel.style.left = `${clamp(panelCfg.x, 0, 100)}%`;
    panel.style.top = `${clamp(panelCfg.y, 0, 100)}%`;
    panel.style.width = `min(${Math.max(120, Number(panelCfg.widthPx) || 440)}px, ${String(panelCfg.maxWidthCss || 'calc(100vw - 40px)')})`;
    panel.style.padding = String(panelCfg.padding || '24px 22px');
    panel.style.borderRadius = `${Math.max(0, Number(this._config.style.panelRadiusPx) || 14)}px`;
    panel.style.background = String(this._config.style.panelBackground || 'rgba(10,10,14,0.7)');
    panel.style.border = String(this._config.style.panelBorder || '1px solid rgba(255,255,255,0.12)');
    panel.style.boxShadow = String(this._config.style.panelShadow || '0 12px 48px rgba(0,0,0,0.6)');
    panel.style.backdropFilter = `blur(${Math.max(0, Number(this._config.style.panelBlurPx) || 0)}px)`;
    panel.style.webkitBackdropFilter = panel.style.backdropFilter;
    panel.style.fontFamily = `${quoteFont(this._config.style.bodyFont || 'Signika')}, sans-serif`;
    panel.style.color = String(this._config.style.textColor || 'rgba(255,255,255,0.92)');

    if (panelCfg.visible !== false) {
      this.el.appendChild(panel);
    }

    // Elements are always children of the full overlay so they can be freely
    // positioned anywhere on screen, independent of the panel.
    const elements = Array.isArray(this._config.layout?.elements) ? this._config.layout.elements : [];
    for (const element of elements) {
      const node = this._createElementNode(element);
      if (!node) continue;
      this.el.appendChild(node);
    }

    // Debug UI lives inside the panel for readability
    const debugHost = panelCfg.visible !== false ? panel : this.el;
    this._buildDebugUi(debugHost);
    this._applyWallpaper();
    this.setSceneName(this._sceneName);
    this.setMessage(this._message);
    this._applyProgress(this._progressCurrent);
    this._renderStagePills();
  }

  _buildOverlayEffects() {
    const effects = Array.isArray(this._config.overlayEffects) ? this._config.overlayEffects : [];
    if (!this.el || effects.length === 0) return;

    for (const effect of effects) {
      if (!effect || effect.enabled === false) continue;
      const type = String(effect.type || '').trim();
      const intensity = clamp(Number(effect.intensity), 0, 1);
      if (!type || intensity <= 0) continue;

      if (type === 'vignette') {
        const node = document.createElement('div');
        node.className = 'map-shine-styled-loading-overlay__effect-vignette';
        node.style.opacity = `${intensity}`;
        node.style.background = `radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, ${String(effect.color || 'rgba(0,0,0,0.75)')} 100%)`;
        this.el.appendChild(node);
      } else if (type === 'scanlines') {
        const node = document.createElement('div');
        node.className = 'map-shine-styled-loading-overlay__effect-scanlines';
        node.style.opacity = `${Math.max(0.05, intensity * 0.55)}`;
        this.el.appendChild(node);
      } else if (type === 'grain') {
        const node = document.createElement('div');
        node.className = 'map-shine-styled-loading-overlay__effect-grain';
        node.style.opacity = `${Math.max(0.03, intensity * 0.25)}`;
        this.el.appendChild(node);
      } else if (type === 'embers' || type === 'dust' || type === 'stars' || type === 'magic-motes' || type === 'fog' || type === 'smoke') {
        this._buildParticleOverlay(type, effect);
      }
    }
  }

  _buildParticleOverlay(type, effect) {
    if (!this.el) return;
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.inset = '0';
    container.style.pointerEvents = 'none';
    this.el.appendChild(container);

    const intensity = clamp(Number(effect.intensity), 0, 1);
    let count = 10;
    if (type === 'stars') count = Math.round(15 + 35 * intensity);
    else if (type === 'embers') count = Math.round(8 + 14 * intensity);
    else if (type === 'dust') count = Math.round(8 + 12 * intensity);
    else if (type === 'magic-motes') count = Math.round(6 + 12 * intensity);
    else if (type === 'fog' || type === 'smoke') count = Math.round(2 + 5 * intensity);

    const color = String(effect.color || '#ffffff');
    const speed = clamp(Number(effect.speed), 0.25, 4);

    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.style.position = 'absolute';
      p.style.left = `${Math.random() * 100}%`;
      p.style.top = `${Math.random() * 100}%`;
      p.style.borderRadius = '50%';
      p.style.pointerEvents = 'none';

      if (type === 'fog' || type === 'smoke') {
        p.style.width = `${80 + Math.random() * 160}px`;
        p.style.height = `${60 + Math.random() * 140}px`;
        p.style.filter = 'blur(36px)';
        p.style.background = color;
        p.style.opacity = `${0.06 + Math.random() * 0.15 * intensity}`;
      } else {
        const size = (type === 'stars') ? 1 + Math.random() * 2 : 2 + Math.random() * 4;
        p.style.width = `${size}px`;
        p.style.height = `${size}px`;
        p.style.background = color;
        p.style.boxShadow = `0 0 ${4 + Math.random() * 10}px ${color}`;
        p.style.opacity = `${0.2 + Math.random() * 0.6}`;
      }

      const driftX = (-20 + Math.random() * 40).toFixed(1);
      const driftY = (type === 'embers') ? (-120 - Math.random() * 120).toFixed(1) : (-15 + Math.random() * 30).toFixed(1);
      const duration = ((type === 'embers' ? 4 : 8) + Math.random() * (type === 'embers' ? 5 : 12)) / speed;
      const delay = Math.random() * 3;
      p.style.animation = `msLsParticleDrift ${duration.toFixed(2)}s ${delay.toFixed(2)}s ease-in-out infinite`;
      p.style.setProperty('--ms-ls-drift-x', `${driftX}px`);
      p.style.setProperty('--ms-ls-drift-y', `${driftY}px`);

      container.appendChild(p);
    }

    if (!this._style || !this._style.textContent.includes('msLsParticleDrift')) {
      this._style.textContent += '\n@keyframes msLsParticleDrift { 0% { transform:translate(0,0) scale(0.9); opacity:0; } 10% { opacity: var(--ms-ls-op, 0.6);} 50% { transform:translate(var(--ms-ls-drift-x, 10px), calc(var(--ms-ls-drift-y, -10px) * 0.5)) scale(1); } 100% { transform:translate(var(--ms-ls-drift-x, 10px), var(--ms-ls-drift-y, -10px)) scale(0.9); opacity:0; } }';
    }
  }

  _createElementNode(element) {
    if (!element || element.visible === false) return null;

    const id = String(element.id || 'element');
    const type = String(element.type || 'text');

    const node = document.createElement('div');
    node.className = 'map-shine-styled-loading-overlay__element';
    node.dataset.elementId = id;
    node.dataset.elementType = type;
    node.style.left = `${clamp(element.position?.x, 0, 100)}%`;
    node.style.top = `${clamp(element.position?.y, 0, 100)}%`;

    applyAnchor(node, String(element.anchor || 'center'));

    if (element.style?.fontFamily) {
      node.style.fontFamily = `${quoteFont(element.style.fontFamily)}, sans-serif`;
    }
    if (element.style?.fontSize) node.style.fontSize = String(element.style.fontSize);
    if (element.style?.fontWeight) node.style.fontWeight = String(element.style.fontWeight);
    if (element.style?.color) node.style.color = String(element.style.color);
    if (element.style?.textShadow) node.style.textShadow = String(element.style.textShadow);
    if (element.style?.textAlign) node.style.textAlign = String(element.style.textAlign);
    if (element.style?.letterSpacing) node.style.letterSpacing = String(element.style.letterSpacing);
    if (element.style?.lineHeight) node.style.lineHeight = String(element.style.lineHeight);
    if (Number.isFinite(element.style?.opacity)) node.style.opacity = `${clamp(element.style.opacity, 0, 1)}`;

    const widthPx = Number(element.style?.widthPx);
    const maxWidthPx = Number(element.style?.maxWidthPx);
    const minWidthPx = Number(element.style?.minWidthPx);
    if (Number.isFinite(widthPx) && widthPx > 0) node.style.width = `${Math.max(1, widthPx)}px`;
    if (Number.isFinite(maxWidthPx) && maxWidthPx > 0) node.style.maxWidth = `${Math.max(16, maxWidthPx)}px`;
    if (Number.isFinite(minWidthPx) && minWidthPx > 0) node.style.minWidth = `${Math.max(1, minWidthPx)}px`;

    const whiteSpace = String(element.style?.whiteSpace || '').trim();
    const textLikeType = isTextLikeType(type);
    const hasBlockWidth = (Number.isFinite(widthPx) && widthPx > 0) || (Number.isFinite(maxWidthPx) && maxWidthPx > 0);
    if (whiteSpace && whiteSpace !== 'auto') node.style.whiteSpace = whiteSpace;
    else if (textLikeType && hasBlockWidth) node.style.whiteSpace = 'normal';

    if (type === 'text') {
      node.textContent = String(element.props?.text || 'Text');
    } else if (type === 'scene-name') {
      const prefix = String(element.props?.prefix || 'Loading ');
      node.dataset.prefix = prefix;
      node.textContent = `${prefix}${this._sceneName}`;
    } else if (type === 'message') {
      node.textContent = this._message;
    } else if (type === 'percentage') {
      node.textContent = `${Math.round(this._progressCurrent * 100)}%`;
    } else if (type === 'timer') {
      node.textContent = '0.0s';
      this._timerEl = node;
    } else if (type === 'spinner') {
      node.classList.add('map-shine-styled-loading-overlay__spinner-wrap');
      const sizePx = Math.max(10, Number(element.props?.sizePx) || 30);
      node.style.width = `${sizePx}px`;
      node.style.height = `${sizePx}px`;

      // IMPORTANT: Spinner rotation uses CSS `transform`, which would override the
      // anchor transform applied to the positioned element. Keep anchoring on the
      // wrapper and rotation on an inner node.
      const spinner = document.createElement('div');
      spinner.className = 'map-shine-styled-loading-overlay__spinner';
      spinner.style.width = '100%';
      spinner.style.height = '100%';
      node.appendChild(spinner);
    } else if (type === 'progress-bar') {
      const widthPx = Math.max(80, Number(element.props?.widthPx) || 360);
      const heightPx = Math.max(2, Number(element.props?.heightPx) || 6);
      const radiusPx = Math.max(0, Number(element.props?.radiusPx) || 999);

      node.style.width = `${widthPx}px`;
      node.style.height = `${heightPx}px`;
      node.style.borderRadius = `${radiusPx}px`;

      const track = document.createElement('div');
      track.className = 'map-shine-styled-loading-overlay__progress-track';
      track.style.borderRadius = `${radiusPx}px`;

      const fill = document.createElement('div');
      fill.className = 'map-shine-styled-loading-overlay__progress-fill';
      fill.style.borderRadius = `${radiusPx}px`;
      track.appendChild(fill);
      node.appendChild(track);

      this._progressFill = fill;
    } else if (type === 'stage-pills') {
      node.classList.add('map-shine-styled-loading-overlay__stage-row');

      const containerEnabled = element.props?.containerEnabled !== false;
      const padY = Math.max(0, Number(element.props?.containerPaddingYpx) || 8);
      const padX = Math.max(0, Number(element.props?.containerPaddingXpx) || 12);
      const radius = Math.max(0, Number(element.props?.containerRadiusPx) || 999);
      const maxWidthPx = Math.max(240, Number(element.props?.maxWidthPx) || 1200);

      node.style.width = 'max-content';
      node.style.maxWidth = `min(${maxWidthPx}px, calc(100vw - 24px))`;
      node.style.padding = containerEnabled ? `${padY}px ${padX}px` : '0';
      node.style.borderRadius = containerEnabled ? `${radius}px` : '0';
      node.style.background = containerEnabled
        ? String(element.props?.containerBackground || 'rgba(6,10,20,0.62)')
        : 'transparent';
      node.style.border = containerEnabled
        ? String(element.props?.containerBorder || '1px solid rgba(120,160,255,0.24)')
        : 'none';

      const stageAlign = String(element.style?.textAlign || 'left').toLowerCase();
      node.style.justifyContent = stageAlign === 'right' ? 'flex-end' : stageAlign === 'center' ? 'center' : 'flex-start';

      this._stageRow = node;
    } else if (type === 'image') {
      const src = String(element.props?.src || '').trim();
      const img = document.createElement('img');
      img.src = src;
      img.alt = String(element.props?.alt || '');
      img.style.maxWidth = `${Math.max(16, Number(element.props?.widthPx) || 120)}px`;
      img.style.maxHeight = `${Math.max(16, Number(element.props?.heightPx) || 120)}px`;
      img.style.objectFit = 'contain';
      if (Number.isFinite(element.props?.opacity)) img.style.opacity = `${clamp(element.props.opacity, 0, 1)}`;
      node.appendChild(img);
    } else if (type === 'custom-html') {
      node.innerHTML = String(element.props?.html || '');
    } else {
      node.textContent = String(element.props?.text || type);
    }

    this._elementsById.set(id, node);

    applyElementAnimations(node, element.animation);
    return node;
  }

  _buildDebugUi(parent) {
    const debug = document.createElement('div');
    debug.style.display = this._debugMode ? 'block' : 'none';
    debug.style.marginTop = '14px';
    debug.style.position = 'relative';

    const title = document.createElement('div');
    title.textContent = 'Loading Log';
    title.style.fontSize = '11px';
    title.style.fontWeight = '600';
    title.style.color = 'rgba(255,255,255,0.6)';
    title.style.textTransform = 'uppercase';
    title.style.letterSpacing = '0.5px';
    title.style.marginBottom = '6px';

    const log = document.createElement('pre');
    log.style.margin = '0';
    log.style.padding = '8px 10px';
    log.style.fontFamily = "'Consolas', 'Monaco', 'Courier New', monospace";
    log.style.fontSize = '10.5px';
    log.style.lineHeight = '1.45';
    log.style.color = 'rgba(200,220,255,0.9)';
    log.style.background = 'rgba(0,0,0,0.5)';
    log.style.border = '1px solid rgba(255,255,255,0.08)';
    log.style.borderRadius = '6px';
    log.style.maxHeight = '40vh';
    log.style.overflow = 'auto';

    const btn = document.createElement('button');
    btn.textContent = 'Load Scene';
    btn.style.display = 'none';
    btn.style.marginTop = '10px';
    btn.style.width = '100%';
    btn.style.padding = '8px 12px';
    btn.style.borderRadius = '6px';
    btn.style.border = '1px solid rgba(0,180,255,0.4)';
    btn.style.background = 'rgba(0,180,255,0.16)';
    btn.style.color = 'rgba(0,200,255,0.95)';
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', () => this._onDebugDismiss());

    debug.appendChild(title);
    debug.appendChild(log);
    debug.appendChild(btn);
    parent.appendChild(debug);

    this._debugContainer = debug;
    this._debugLog = log;
    this._debugDismissBtn = btn;
  }

  async _applyWallpaper() {
    if (!this.el) return;
    const wallLayer = this.el.querySelector('.map-shine-styled-loading-overlay__wallpaper');
    if (!wallLayer) return;

    wallLayer.innerHTML = '';

    const entry = this._activeWallpaper || selectWallpaper(this._config.wallpapers, { isFirstLoad: false });
    if (!entry?.src) {
      this._applyWallpaperOverlay();
      return;
    }

    let img = getCachedWallpaperImage(entry.src);
    if (!img) img = await loadImage(entry.src, 2000);

    if (img) {
      const domImg = document.createElement('img');
      domImg.src = img.src;
      domImg.alt = String(entry.label || 'Wallpaper');
      wallLayer.appendChild(domImg);
    }

    this._applyWallpaperOverlay();
  }

  _applyWallpaperOverlay() {
    if (!this.el) return;
    this.el.querySelectorAll('.map-shine-styled-loading-overlay__wallpaper-overlay').forEach((n) => n.remove());

    const overlay = this._config.wallpapers?.overlay;
    if (!overlay?.enabled) return;

    const node = document.createElement('div');
    node.className = 'map-shine-styled-loading-overlay__wallpaper-overlay';
    node.style.position = 'absolute';
    node.style.inset = '0';
    node.style.pointerEvents = 'none';
    node.style.background = String(overlay.color || 'rgba(0,0,0,0.45)');
    this.el.appendChild(node);
  }

  _renderStagePills() {
    if (!this._stageRow) return;
    this._stageRow.innerHTML = '';
    if (!this._stageState?.ranges) return;

    for (const [id, range] of this._stageState.ranges.entries()) {
      const pill = document.createElement('span');
      pill.className = 'map-shine-styled-loading-overlay__stage-pill map-shine-styled-loading-overlay__stage-pill--pending';
      pill.dataset.stageId = id;
      const rawLabel = String(range.label || id);
      pill.textContent = rawLabel.replace(/[\u2026.]+$/, '').trim();
      this._stageRow.appendChild(pill);
    }
  }

  _updateStagePills(activeStageId) {
    if (!this._stageRow || !this._stageState?.ranges) return;
    const pills = this._stageRow.querySelectorAll('.map-shine-styled-loading-overlay__stage-pill');

    let passedActive = false;
    const stageComplete = this._stageState.currentStageProgress >= 0.999;

    for (const pill of pills) {
      const id = pill.dataset.stageId;
      if (id === activeStageId) {
        pill.className = stageComplete
          ? 'map-shine-styled-loading-overlay__stage-pill map-shine-styled-loading-overlay__stage-pill--done'
          : 'map-shine-styled-loading-overlay__stage-pill map-shine-styled-loading-overlay__stage-pill--active';
        passedActive = true;
      } else if (!passedActive) {
        pill.className = 'map-shine-styled-loading-overlay__stage-pill map-shine-styled-loading-overlay__stage-pill--done';
      } else {
        pill.className = 'map-shine-styled-loading-overlay__stage-pill map-shine-styled-loading-overlay__stage-pill--pending';
      }
    }
  }

  _onDebugDismiss() {
    if (this._debugDismissCallback) {
      try { this._debugDismissCallback(); } catch (_) {}
      this._debugDismissCallback = null;
    }
    this.fadeIn(2000, 800).catch(() => {});
  }

  _installRuntimeStyle() {
    if (this._style) return;
    const style = document.createElement('style');
    style.id = 'map-shine-styled-loading-overlay-style';
    style.textContent = `
      /* --- Map Shine Styled Loading Overlay --- */
      .map-shine-styled-loading-overlay {
        font-family: 'Signika', sans-serif;
        color: rgba(255,255,255,0.92);
      }

      .map-shine-styled-loading-overlay__wallpaper {
        position: absolute; inset: 0; overflow: hidden; pointer-events: none;
      }
      .map-shine-styled-loading-overlay__wallpaper img {
        width: 100%; height: 100%; object-fit: var(--ms-ls-wallpaper-fit, cover);
      }

      .map-shine-styled-loading-overlay__panel {
        position: absolute;
        transform: translate(-50%, -50%);
        pointer-events: none;
      }

      .map-shine-styled-loading-overlay__element {
        position: absolute;
        white-space: nowrap;
        pointer-events: none;
      }

      .map-shine-styled-loading-overlay__spinner {
        width: 100%;
        height: 100%;
        border-radius: 999px;
        border: 2px solid rgba(255,255,255,0.15);
        border-top-color: var(--ms-ls-accent, rgba(0,180,255,0.9));
        animation: msLsSpinnerSpin 0.85s linear infinite;
      }

      .map-shine-styled-loading-overlay__spinner-wrap {
        display: block;
      }

      .map-shine-styled-loading-overlay__progress-track {
        width: 100%; height: 100%;
        background: rgba(255,255,255,0.1);
        overflow: hidden;
      }
      .map-shine-styled-loading-overlay__progress-fill {
        height: 100%; width: 0%;
        background: linear-gradient(90deg, var(--ms-ls-accent, rgba(0,180,255,0.9)), var(--ms-ls-accent-2, rgba(140,100,255,0.9)));
        box-shadow: 0 0 10px rgba(0,180,255,0.3);
        transition: width 120ms ease-out;
      }

      .map-shine-styled-loading-overlay__stage-row {
        display: flex;
        gap: 5px;
        row-gap: 6px;
        flex-wrap: wrap;
        justify-content: flex-start;
        align-items: center;
        box-sizing: border-box;
        white-space: normal;
      }
      .map-shine-styled-loading-overlay__stage-pill {
        padding: 2px 7px; border-radius: 999px;
        font-size: 10px; font-weight: 600;
        transition: background 200ms ease, color 200ms ease;
      }
      .map-shine-styled-loading-overlay__stage-pill--pending {
        background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.4);
      }
      .map-shine-styled-loading-overlay__stage-pill--active {
        background: rgba(0,180,255,0.18); color: rgba(0,220,255,0.95);
      }
      .map-shine-styled-loading-overlay__stage-pill--done {
        background: rgba(100,220,140,0.15); color: rgba(140,255,180,0.9);
      }

      .map-shine-styled-loading-overlay__effect-vignette {
        position: absolute; inset: 0; pointer-events: none;
      }
      .map-shine-styled-loading-overlay__effect-scanlines {
        position: absolute; inset: 0; pointer-events: none;
        background: repeating-linear-gradient(
          0deg,
          rgba(0,0,0,0.15) 0px, rgba(0,0,0,0.15) 1px,
          transparent 1px, transparent 3px
        );
      }
      .map-shine-styled-loading-overlay__effect-grain {
        position: absolute; inset: 0; pointer-events: none;
        background: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
        background-size: 128px;
        mix-blend-mode: overlay;
      }

      @keyframes msLsSpinnerSpin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `;
    this._style = style;
    (document.head || document.documentElement)?.appendChild(style);
  }

  _nextFrame() {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try { requestAnimationFrame(() => done()); } catch (_) {}
      setTimeout(done, 50);
    });
  }
}

function applyElementAnimations(node, animation) {
  if (!node || !animation) return;

  const entrance = animation.entrance;
  if (entrance && entrance.type) {
    node.classList.add(mapEntranceAnimationClass(entrance.type));
    node.style.animationDuration = `${Math.max(1, Number(entrance.duration) || 600)}ms`;
    node.style.animationDelay = `${Math.max(0, Number(entrance.delay) || 0)}ms`;
    node.style.animationTimingFunction = String(entrance.easing || 'ease-out');
    node.style.animationFillMode = 'both';
  }

  const ambient = animation.ambient;
  if (ambient && ambient.type) {
    const cls = mapAmbientAnimationClass(ambient.type);
    if (cls) {
      const composed = (node.style.animationName || '').trim();
      node.classList.add(cls);
      const ambientDuration = `${Math.max(150, Number(ambient.duration) || 3000)}ms`;

      if (composed) {
        node.style.animationDuration = `${node.style.animationDuration || '600ms'}, ${ambientDuration}`;
        node.style.animationTimingFunction = `${node.style.animationTimingFunction || 'ease-out'}, ${String(ambient.easing || 'ease-in-out')}`;
        node.style.animationIterationCount = '1, infinite';
      } else {
        node.style.animationDuration = ambientDuration;
        node.style.animationTimingFunction = String(ambient.easing || 'ease-in-out');
        node.style.animationIterationCount = 'infinite';
      }
    }
  }
}

function applyAnchor(node, anchor) {
  const a = String(anchor || 'center').toLowerCase();
  if (a === 'top-left') {
    node.style.transform = 'translate(0, 0)';
  } else if (a === 'top-right') {
    node.style.transform = 'translate(-100%, 0)';
  } else if (a === 'bottom-left') {
    node.style.transform = 'translate(0, -100%)';
  } else if (a === 'bottom-right') {
    node.style.transform = 'translate(-100%, -100%)';
  } else if (a === 'top-center') {
    node.style.transform = 'translate(-50%, 0)';
  } else if (a === 'bottom-center') {
    node.style.transform = 'translate(-50%, -100%)';
  } else if (a === 'center-left') {
    node.style.transform = 'translate(0, -50%)';
  } else if (a === 'center-right') {
    node.style.transform = 'translate(-100%, -50%)';
  } else {
    node.style.transform = 'translate(-50%, -50%)';
  }
}

function clamp(v, min, max) {
  const n = Number.isFinite(v) ? Number(v) : min;
  return Math.max(min, Math.min(max, n));
}

function quoteFont(name) {
  const family = String(name || '').trim();
  if (!family) return 'Signika';
  if (family.includes('"') || family.includes("'")) return family;
  if (family.includes(' ')) return `'${family}'`;
  return family;
}

function isTextLikeType(type) {
  const t = String(type || '').toLowerCase();
  return t === 'text' || t === 'subtitle' || t === 'scene-name' || t === 'message' || t === 'percentage' || t === 'timer';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a renderer-time CSS font-family from style+google-family spec.
 * @param {Object} config
 * @returns {string}
 */
export function resolvePrimaryFontFamily(config) {
  const family = String(config?.style?.primaryFont || '').trim();
  if (family) return family;
  const firstGoogle = Array.isArray(config?.fonts?.googleFamilies) ? config.fonts.googleFamilies[0] : null;
  return familySpecToFamilyName(firstGoogle || '') || 'Signika';
}
