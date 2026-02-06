export class LoadingOverlay {
  constructor() {
    this.el = null;
    this.msgEl = null;
    this.barEl = null;
    this._contentEl = null;
    this._styleEl = null;
    this._token = 0;
    this._progressCurrent = 0;
    this._progressTarget = 0;
    this._progressRaf = 0;
    this._progressLastTs = 0;
    this._autoProgress = null;

    this._stages = null;
    this._stageState = null;
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
      return;
    }

    const normalized = [];
    let totalWeight = 0;
    for (const s of stages) {
      const id = String(s.id || '').trim();
      if (!id) continue;
      const weight = Number.isFinite(s.weight) ? Math.max(0, s.weight) : 1;
      totalWeight += weight;
      normalized.push({
        id,
        label: s.label ?? null,
        weight
      });
    }
    if (normalized.length === 0 || totalWeight <= 0) {
      this._stageState = null;
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
  }

  setStage(stageId, progress01 = 0, message = undefined, opts = undefined) {
    this.ensure();
    if (!this._stageState?.ranges) return;
    const id = String(stageId || '').trim();
    const range = this._stageState.ranges.get(id);
    if (!range) return;

    const p = Number.isFinite(progress01) ? Math.max(0, Math.min(1, progress01)) : 0;
    this._stageState.currentStageId = id;
    this._stageState.currentStageProgress = p;

    const global = range.start + (range.end - range.start) * p;

    const label = message ?? range.label;
    if (label !== undefined && label !== null) {
      this.setMessage(String(label));
    }

    this.setProgress(global, opts);
  }

  ensure() {
    if (this.el) return;

    const el = document.createElement('div');
    el.id = 'map-shine-loading-overlay';
    el.className = 'map-shine-loading-overlay map-shine-loading-overlay--hidden';

    el.style.position = 'fixed';
    el.style.inset = '0';
    el.style.zIndex = '100000';
    el.style.display = 'none';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.backgroundColor = 'rgba(0, 0, 0, 1)';
    el.style.opacity = '1';
    el.style.pointerEvents = 'none';
    el.style.transitionProperty = 'background-color, opacity';
    el.style.transitionTimingFunction = 'ease';

    const content = document.createElement('div');
    content.className = 'map-shine-loading-overlay__content';

    content.style.width = 'min(420px, calc(100vw - 40px))';
    content.style.padding = '20px 18px';
    content.style.borderRadius = '12px';
    content.style.background = 'rgba(10, 10, 10, 0.55)';
    content.style.border = '1px solid rgba(255, 255, 255, 0.15)';
    content.style.backdropFilter = 'blur(10px)';
    content.style.webkitBackdropFilter = 'blur(10px)';
    content.style.boxShadow = '0 10px 40px rgba(0, 0, 0, 0.55)';
    content.style.fontFamily = "var(--font-primary, 'Signika', sans-serif)";
    content.style.opacity = '1';
    content.style.transitionProperty = 'opacity';
    content.style.transitionTimingFunction = 'ease';
    content.style.transitionDuration = '0ms';

    this._contentEl = content;

    const title = document.createElement('div');
    title.className = 'map-shine-loading-overlay__title';
    title.textContent = 'Map Shine';

    title.style.fontSize = '22px';
    title.style.fontWeight = '700';
    title.style.letterSpacing = '0.5px';
    title.style.color = 'rgba(255, 255, 255, 0.95)';

    const subtitle = document.createElement('div');
    subtitle.className = 'map-shine-loading-overlay__subtitle';
    subtitle.textContent = 'Loading';

    subtitle.style.marginTop = '2px';
    subtitle.style.fontSize = '13px';
    subtitle.style.color = 'rgba(255, 255, 255, 0.65)';

    const spinner = document.createElement('div');
    spinner.className = 'map-shine-loading-overlay__spinner';

    spinner.style.marginTop = '14px';
    spinner.style.width = '34px';
    spinner.style.height = '34px';
    spinner.style.borderRadius = '50%';
    spinner.style.border = '3px solid rgba(255, 255, 255, 0.18)';
    spinner.style.borderTopColor = 'rgba(255, 255, 255, 0.85)';

    const msg = document.createElement('div');
    msg.className = 'map-shine-loading-overlay__message';
    msg.textContent = 'Starting…';

    msg.style.marginTop = '12px';
    msg.style.fontSize = '13px';
    msg.style.lineHeight = '1.4';
    msg.style.color = 'rgba(255, 255, 255, 0.8)';

    const progress = document.createElement('div');
    progress.className = 'map-shine-loading-overlay__progress';

    progress.style.marginTop = '12px';
    progress.style.height = '8px';
    progress.style.width = '100%';
    progress.style.borderRadius = '999px';
    progress.style.overflow = 'hidden';
    progress.style.background = 'rgba(255, 255, 255, 0.12)';

    const bar = document.createElement('div');
    bar.className = 'map-shine-loading-overlay__progress-bar';
    bar.style.width = '0%';

    bar.style.height = '100%';
    bar.style.borderRadius = '999px';
    bar.style.background = 'linear-gradient(90deg, rgba(0, 200, 255, 0.85), rgba(160, 120, 255, 0.85))';
    bar.style.transition = 'width 0ms linear';

    progress.appendChild(bar);
    content.appendChild(title);
    content.appendChild(subtitle);
    content.appendChild(spinner);
    content.appendChild(msg);
    content.appendChild(progress);
    el.appendChild(content);

    this.el = el;
    this.msgEl = msg;
    this.barEl = bar;

    this._installLocalStyle();

    if (document.body) {
      document.body.appendChild(el);
    } else {
      const root = document.documentElement;
      if (root) root.appendChild(el);
      document.addEventListener('readystatechange', () => {
        if (!this.el) return;
        if (document.body && !document.body.contains(this.el)) document.body.appendChild(this.el);
      }, { once: true });
    }

    try {
      spinner.animate(
        [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
        { duration: 900, iterations: Infinity }
      );
    } catch (e) {
      spinner.style.animation = 'mapShineSpin 0.9s linear infinite';
    }
  }

  _installLocalStyle() {
    if (this._styleEl) return;
    const style = document.createElement('style');
    style.id = 'map-shine-loading-overlay-style';
    style.textContent = `@keyframes mapShineSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
    this._styleEl = style;

    const parent = document.head || document.documentElement;
    if (parent && !parent.querySelector?.('#map-shine-loading-overlay-style')) {
      parent.appendChild(style);
    }
  }

  setMessage(message) {
    this.ensure();
    if (this.msgEl) this.msgEl.textContent = message || '';
  }

  setProgress(value01, opts = undefined) {
    this.ensure();
    const v = Number.isFinite(value01) ? Math.max(0, Math.min(1, value01)) : 0;
    const immediate = !!opts?.immediate;
    const keepAuto = !!opts?.keepAuto;
    if (!keepAuto) this._autoProgress = null;
    this._progressTarget = v;

    if (immediate) {
      this._progressCurrent = v;
      this._applyProgress(this._progressCurrent);
      this._stopProgressLoop();
      return;
    }

    this._startProgressLoop();
  }

  startAutoProgress(target01, rate01PerSec = 0.01) {
    this.ensure();
    const t = Number.isFinite(target01) ? Math.max(0, Math.min(1, target01)) : 0;
    const rate = Number.isFinite(rate01PerSec) ? Math.max(0, rate01PerSec) : 0.01;
    this._autoProgress = { target: t, rate };
    if (this._progressTarget < this._progressCurrent) this._progressTarget = this._progressCurrent;
    this._startProgressLoop();
  }

  stopAutoProgress() {
    this._autoProgress = null;
  }

  _applyProgress(value01) {
    const v = Number.isFinite(value01) ? Math.max(0, Math.min(1, value01)) : 0;
    if (this.barEl) this.barEl.style.width = `${Math.round(v * 1000) / 10}%`;
  }

  _resetProgress() {
    this._autoProgress = null;
    this._progressCurrent = 0;
    this._progressTarget = 0;
    this._applyProgress(0);
    this._stopProgressLoop();
  }

  _stopProgressLoop() {
    if (this._progressRaf) {
      try {
        cancelAnimationFrame(this._progressRaf);
      } catch (_) {
      }
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
    if (!this.el || !this.barEl) return;

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

  _setContentOpacity(opacity, durationMs = 0) {
    if (!this._contentEl) return;
    const d = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    this._contentEl.style.transitionDuration = `${d}ms`;
    this._contentEl.style.opacity = String(opacity);
  }

  showBlack(message = 'Loading…') {
    this.ensure();
    this.setMessage(message);
    this._resetProgress();
    this.el.style.display = 'flex';
    this.el.style.pointerEvents = 'auto';
    this.el.style.transitionDuration = '0ms';
    this.el.style.opacity = '1';
    this.el.style.backgroundColor = 'rgba(0, 0, 0, 1)';
    this._setContentOpacity(1, 0);
    this.el.classList.remove('map-shine-loading-overlay--hidden');
    this.el.classList.add('map-shine-loading-overlay--black');
  }

  showLoading(message = 'Loading…') {
    this.ensure();
    this.setMessage(message);
    this._resetProgress();
    this.el.style.display = 'flex';
    this.el.style.pointerEvents = 'auto';
    this.el.style.opacity = '1';
    this._setContentOpacity(1, 0);
    this.el.classList.remove('map-shine-loading-overlay--hidden');
  }

  hide() {
    if (!this.el) return;
    this._resetProgress();
    this.el.classList.add('map-shine-loading-overlay--hidden');
    this.el.style.pointerEvents = 'none';
    this.el.style.display = 'none';
    this._setContentOpacity(1, 0);
  }

  async fadeToBlack(durationMs = 5000, contentFadeMs = 2000) {
    this.ensure();
    const token = ++this._token;
    const contentMs = Math.min(
      Number.isFinite(contentFadeMs) ? Math.max(0, contentFadeMs) : 0,
      Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
    );
    this.el.style.display = 'flex';
    this.el.style.pointerEvents = 'auto';
    this.el.style.transitionDuration = `${durationMs}ms`;
    this.el.classList.remove('map-shine-loading-overlay--hidden');
    this.el.classList.add('map-shine-loading-overlay--black');

    this._setContentOpacity(1, 0);
    this.el.style.backgroundColor = 'rgba(0, 0, 0, 0)';
    await this._nextFrame();
    this._setContentOpacity(0, contentMs);
    this.el.style.backgroundColor = 'rgba(0, 0, 0, 1)';
    await this._sleep(durationMs);
    if (token !== this._token) return;
  }

  async fadeIn(durationMs = 5000, contentFadeMs = 2000) {
    this.ensure();
    const token = ++this._token;
    const contentMs = Math.min(
      Number.isFinite(contentFadeMs) ? Math.max(0, contentFadeMs) : 0,
      Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
    );
    this.el.style.display = 'flex';
    this.el.style.pointerEvents = 'none';
    this.el.style.transitionDuration = `${durationMs}ms`;
    this.el.classList.remove('map-shine-loading-overlay--black');

    this._setContentOpacity(1, 0);
    this.el.style.backgroundColor = 'rgba(0, 0, 0, 1)';
    await this._nextFrame();
    this._setContentOpacity(0, contentMs);
    this.el.style.backgroundColor = 'rgba(0, 0, 0, 0)';
    await this._sleep(durationMs);
    if (token !== this._token) return;
    this.hide();
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _nextFrame() {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        requestAnimationFrame(() => finish());
      } catch (_) {
        // Ignore rAF errors in non-visual contexts.
      }
      setTimeout(finish, 50);
    });
  }
}

export const loadingOverlay = new LoadingOverlay();
