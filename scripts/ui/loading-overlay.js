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

    // UX enhancement elements
    this._titleEl = null;
    this._subtitleEl = null;
    this._pctEl = null;
    this._timerEl = null;
    this._stageRowEl = null;
    this._timerStart = 0;
    this._timerRaf = 0;

    // Debug loading profiler UI elements
    this._debugLogEl = null;
    this._debugDismissBtn = null;
    this._debugCopyBtn = null;
    this._debugContainerEl = null;
    this._debugMode = false;
    /** @type {Function|null} callback when dismiss is clicked */
    this._debugDismissCallback = null;
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

    // Render stage pill indicators
    this._renderStagePills();
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

    // Update stage pill indicators
    this._updateStagePills(id);

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

    content.style.width = 'min(440px, calc(100vw - 40px))';
    content.style.padding = '24px 22px';
    content.style.borderRadius = '14px';
    content.style.background = 'rgba(10, 10, 14, 0.7)';
    content.style.border = '1px solid rgba(255, 255, 255, 0.12)';
    content.style.backdropFilter = 'blur(14px)';
    content.style.webkitBackdropFilter = 'blur(14px)';
    content.style.boxShadow = '0 12px 48px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255,255,255,0.05)';
    content.style.fontFamily = "var(--font-primary, 'Signika', sans-serif)";
    content.style.opacity = '1';
    content.style.transitionProperty = 'opacity';
    content.style.transitionTimingFunction = 'ease';
    content.style.transitionDuration = '0ms';

    this._contentEl = content;

    // Title row: "Map Shine" left, elapsed timer right
    const titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'baseline';
    titleRow.style.justifyContent = 'space-between';

    const title = document.createElement('div');
    title.className = 'map-shine-loading-overlay__title';
    title.textContent = 'Map Shine';
    title.style.fontSize = '20px';
    title.style.fontWeight = '700';
    title.style.letterSpacing = '0.4px';
    title.style.color = 'rgba(255, 255, 255, 0.95)';
    this._titleEl = title;

    const timer = document.createElement('div');
    timer.className = 'map-shine-loading-overlay__timer';
    timer.textContent = '0.0s';
    timer.style.fontSize = '13px';
    timer.style.fontWeight = '500';
    timer.style.fontVariantNumeric = 'tabular-nums';
    timer.style.color = 'rgba(255, 255, 255, 0.4)';
    timer.style.letterSpacing = '0.3px';
    this._timerEl = timer;

    titleRow.appendChild(title);
    titleRow.appendChild(timer);

    // Subtitle / scene name
    const subtitle = document.createElement('div');
    subtitle.className = 'map-shine-loading-overlay__subtitle';
    subtitle.textContent = 'Loading';
    subtitle.style.marginTop = '3px';
    subtitle.style.fontSize = '13px';
    subtitle.style.color = 'rgba(255, 255, 255, 0.5)';
    this._subtitleEl = subtitle;

    // Spinner
    const spinner = document.createElement('div');
    spinner.className = 'map-shine-loading-overlay__spinner';
    spinner.style.marginTop = '16px';
    spinner.style.width = '30px';
    spinner.style.height = '30px';
    spinner.style.borderRadius = '50%';
    spinner.style.border = '2.5px solid rgba(255, 255, 255, 0.15)';
    spinner.style.borderTopColor = 'rgba(0, 200, 255, 0.85)';

    // Stage pills row (populated dynamically by startStages)
    const stageRow = document.createElement('div');
    stageRow.className = 'map-shine-loading-overlay__stages';
    stageRow.style.marginTop = '16px';
    stageRow.style.display = 'flex';
    stageRow.style.flexWrap = 'wrap';
    stageRow.style.gap = '5px';
    this._stageRowEl = stageRow;

    // Message
    const msg = document.createElement('div');
    msg.className = 'map-shine-loading-overlay__message';
    msg.textContent = 'Starting…';
    msg.style.marginTop = '14px';
    msg.style.fontSize = '12.5px';
    msg.style.lineHeight = '1.4';
    msg.style.color = 'rgba(255, 255, 255, 0.7)';
    msg.style.minHeight = '18px';

    // Progress bar row: bar + percentage
    const progressRow = document.createElement('div');
    progressRow.style.marginTop = '10px';
    progressRow.style.display = 'flex';
    progressRow.style.alignItems = 'center';
    progressRow.style.gap = '10px';

    const progress = document.createElement('div');
    progress.className = 'map-shine-loading-overlay__progress';
    progress.style.flex = '1';
    progress.style.height = '6px';
    progress.style.borderRadius = '999px';
    progress.style.overflow = 'hidden';
    progress.style.background = 'rgba(255, 255, 255, 0.08)';

    const bar = document.createElement('div');
    bar.className = 'map-shine-loading-overlay__progress-bar';
    bar.style.width = '0%';
    bar.style.height = '100%';
    bar.style.borderRadius = '999px';
    bar.style.background = 'linear-gradient(90deg, rgba(0, 180, 255, 0.9), rgba(140, 100, 255, 0.9))';
    bar.style.boxShadow = '0 0 8px rgba(0, 180, 255, 0.3)';
    bar.style.transition = 'width 0ms linear';

    const pct = document.createElement('div');
    pct.className = 'map-shine-loading-overlay__pct';
    pct.textContent = '0%';
    pct.style.fontSize = '12px';
    pct.style.fontWeight = '600';
    pct.style.fontVariantNumeric = 'tabular-nums';
    pct.style.color = 'rgba(255, 255, 255, 0.55)';
    pct.style.minWidth = '32px';
    pct.style.textAlign = 'right';
    this._pctEl = pct;

    progress.appendChild(bar);
    progressRow.appendChild(progress);
    progressRow.appendChild(pct);

    content.appendChild(titleRow);
    content.appendChild(subtitle);
    content.appendChild(spinner);
    content.appendChild(stageRow);
    content.appendChild(msg);
    content.appendChild(progressRow);

    // Debug log container (hidden by default, shown when enableDebugMode() is called)
    const debugContainer = document.createElement('div');
    debugContainer.className = 'map-shine-loading-overlay__debug';
    debugContainer.style.display = 'none';
    debugContainer.style.marginTop = '14px';
    debugContainer.style.position = 'relative';
    this._debugContainerEl = debugContainer;

    // Debug log header with copy button
    const debugHeader = document.createElement('div');
    debugHeader.style.display = 'flex';
    debugHeader.style.justifyContent = 'space-between';
    debugHeader.style.alignItems = 'center';
    debugHeader.style.marginBottom = '6px';

    const debugTitle = document.createElement('span');
    debugTitle.textContent = 'Loading Log';
    debugTitle.style.fontSize = '11px';
    debugTitle.style.fontWeight = '600';
    debugTitle.style.color = 'rgba(255, 255, 255, 0.6)';
    debugTitle.style.textTransform = 'uppercase';
    debugTitle.style.letterSpacing = '0.5px';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy Log';
    copyBtn.className = 'map-shine-debug-copy-btn';
    copyBtn.style.fontSize = '10px';
    copyBtn.style.padding = '2px 8px';
    copyBtn.style.border = '1px solid rgba(255,255,255,0.2)';
    copyBtn.style.borderRadius = '4px';
    copyBtn.style.background = 'rgba(255,255,255,0.08)';
    copyBtn.style.color = 'rgba(255,255,255,0.7)';
    copyBtn.style.cursor = 'pointer';
    copyBtn.style.transition = 'background 0.15s ease';
    copyBtn.addEventListener('mouseenter', () => { copyBtn.style.background = 'rgba(255,255,255,0.15)'; });
    copyBtn.addEventListener('mouseleave', () => { copyBtn.style.background = 'rgba(255,255,255,0.08)'; });
    copyBtn.addEventListener('click', () => this._copyDebugLog());
    this._debugCopyBtn = copyBtn;

    debugHeader.appendChild(debugTitle);
    debugHeader.appendChild(copyBtn);

    // Scrollable log area — selectable monospace text
    const logEl = document.createElement('pre');
    logEl.className = 'map-shine-loading-overlay__debug-log';
    logEl.style.margin = '0';
    logEl.style.padding = '8px 10px';
    logEl.style.fontFamily = "'Consolas', 'Monaco', 'Courier New', monospace";
    logEl.style.fontSize = '10.5px';
    logEl.style.lineHeight = '1.5';
    logEl.style.color = 'rgba(200, 220, 255, 0.85)';
    logEl.style.background = 'rgba(0, 0, 0, 0.5)';
    logEl.style.border = '1px solid rgba(255,255,255,0.08)';
    logEl.style.borderRadius = '6px';
    logEl.style.maxHeight = '40vh';
    logEl.style.overflowY = 'auto';
    logEl.style.overflowX = 'auto';
    logEl.style.whiteSpace = 'pre';
    logEl.style.userSelect = 'text';
    logEl.style.webkitUserSelect = 'text';
    logEl.style.cursor = 'text';
    logEl.style.tabSize = '4';
    logEl.textContent = '';
    this._debugLogEl = logEl;

    // Dismiss button
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Load Scene';
    dismissBtn.className = 'map-shine-debug-dismiss-btn';
    dismissBtn.style.display = 'none';
    dismissBtn.style.marginTop = '10px';
    dismissBtn.style.width = '100%';
    dismissBtn.style.padding = '8px 16px';
    dismissBtn.style.fontSize = '13px';
    dismissBtn.style.fontWeight = '600';
    dismissBtn.style.border = '1px solid rgba(0, 180, 255, 0.4)';
    dismissBtn.style.borderRadius = '6px';
    dismissBtn.style.background = 'rgba(0, 180, 255, 0.15)';
    dismissBtn.style.color = 'rgba(0, 200, 255, 0.95)';
    dismissBtn.style.cursor = 'pointer';
    dismissBtn.style.transition = 'background 0.15s ease, border-color 0.15s ease';
    dismissBtn.addEventListener('mouseenter', () => {
      dismissBtn.style.background = 'rgba(0, 180, 255, 0.25)';
      dismissBtn.style.borderColor = 'rgba(0, 180, 255, 0.6)';
    });
    dismissBtn.addEventListener('mouseleave', () => {
      dismissBtn.style.background = 'rgba(0, 180, 255, 0.15)';
      dismissBtn.style.borderColor = 'rgba(0, 180, 255, 0.4)';
    });
    dismissBtn.addEventListener('click', () => this._onDebugDismiss());
    this._debugDismissBtn = dismissBtn;

    debugContainer.appendChild(debugHeader);
    debugContainer.appendChild(logEl);
    debugContainer.appendChild(dismissBtn);
    content.appendChild(debugContainer);

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
        { duration: 800, iterations: Infinity }
      );
    } catch (e) {
      spinner.style.animation = 'mapShineSpin 0.8s linear infinite';
    }
  }

  _installLocalStyle() {
    if (this._styleEl) return;
    const style = document.createElement('style');
    style.id = 'map-shine-loading-overlay-style';
    style.textContent = [
      `@keyframes mapShineSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`,
      `@keyframes msBarPulse { 0%,100% { box-shadow: 0 0 6px rgba(0,180,255,0.25); } 50% { box-shadow: 0 0 14px rgba(0,180,255,0.5); } }`,
      `.map-shine-loading-overlay__progress-bar { animation: msBarPulse 2s ease-in-out infinite; }`,
      `.map-shine-stage-pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:500; letter-spacing:0.2px; transition: background 0.3s ease, color 0.3s ease, box-shadow 0.3s ease; }`,
      `.map-shine-stage-pill--pending { background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.3); }`,
      `.map-shine-stage-pill--active { background:rgba(0,180,255,0.2); color:rgba(0,200,255,0.95); box-shadow:0 0 8px rgba(0,180,255,0.15); }`,
      `.map-shine-stage-pill--done { background:rgba(100,220,140,0.12); color:rgba(100,220,140,0.7); }`,
      /* Debug mode: wider container to fit log */
      `.map-shine-loading-overlay--debug .map-shine-loading-overlay__content { width: min(720px, calc(100vw - 40px)) !important; }`,
      `.map-shine-loading-overlay__debug-log::-webkit-scrollbar { width: 6px; }`,
      `.map-shine-loading-overlay__debug-log::-webkit-scrollbar-track { background: transparent; }`,
      `.map-shine-loading-overlay__debug-log::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }`,
      `.map-shine-loading-overlay__debug-log::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }`,
    ].join('\n');
    this._styleEl = style;

    const parent = document.head || document.documentElement;
    if (parent && !parent.querySelector?.('#map-shine-loading-overlay-style')) {
      parent.appendChild(style);
    }
  }

  /**
   * Set the scene name displayed in the subtitle.
   * @param {string} name - Scene name
   */
  setSceneName(name) {
    this.ensure();
    if (this._subtitleEl) {
      this._subtitleEl.textContent = name ? `Loading ${name}` : 'Loading';
    }
  }

  /**
   * Get elapsed seconds since the timer started.
   * Returns 0 if the timer hasn't been started.
   * @returns {number}
   */
  getElapsedSeconds() {
    if (!this._timerStart) return 0;
    return (performance.now() - this._timerStart) / 1000;
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
    if (this._pctEl) this._pctEl.textContent = `${Math.round(v * 100)}%`;
  }

  _resetProgress() {
    this._autoProgress = null;
    this._progressCurrent = 0;
    this._progressTarget = 0;
    this._applyProgress(0);
    this._stopProgressLoop();
    // Clear stale stage pills and subtitle from previous load
    if (this._stageRowEl) this._stageRowEl.innerHTML = '';
    if (this._subtitleEl) this._subtitleEl.textContent = 'Loading';
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
    this._startTimer();
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
    this._startTimer();
    this.el.style.display = 'flex';
    this.el.style.pointerEvents = 'auto';
    this.el.style.opacity = '1';
    this._setContentOpacity(1, 0);
    this.el.classList.remove('map-shine-loading-overlay--hidden');
  }

  hide() {
    if (!this.el) return;
    this._resetProgress();
    this._stopTimer();
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

  // ---------------------------------------------------------------------------
  // Elapsed timer
  // ---------------------------------------------------------------------------

  _startTimer() {
    this._timerStart = performance.now();
    if (this._timerEl) this._timerEl.textContent = '0.0s';
    this._stopTimerLoop();
    this._timerRaf = requestAnimationFrame((ts) => this._timerTick(ts));
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

  // ---------------------------------------------------------------------------
  // Stage pills
  // ---------------------------------------------------------------------------

  /**
   * Render stage pill elements into the stage row.
   * Called by startStages after ranges are computed.
   * @private
   */
  _renderStagePills() {
    if (!this._stageRowEl || !this._stageState?.ranges) return;
    this._stageRowEl.innerHTML = '';

    // Short display labels for each stage (strip the trailing ellipsis from label)
    for (const [id, range] of this._stageState.ranges.entries()) {
      const pill = document.createElement('span');
      pill.className = 'map-shine-stage-pill map-shine-stage-pill--pending';
      pill.dataset.stageId = id;
      // Use a short label: take the stage label and trim trailing punctuation
      const rawLabel = range.label || id;
      pill.textContent = rawLabel.replace(/[\u2026.]+$/, '').trim();
      this._stageRowEl.appendChild(pill);
    }
  }

  /**
   * Update stage pill visual states based on current stage progress.
   * @param {string} activeStageId - Currently active stage ID
   * @private
   */
  _updateStagePills(activeStageId) {
    if (!this._stageRowEl || !this._stageState?.ranges) return;
    const pills = this._stageRowEl.querySelectorAll('.map-shine-stage-pill');
    let passedActive = false;

    // If the active stage is at 100% progress, show it as done too
    const stageComplete = this._stageState.currentStageProgress >= 0.999;

    for (const pill of pills) {
      const id = pill.dataset.stageId;
      if (id === activeStageId) {
        pill.className = stageComplete
          ? 'map-shine-stage-pill map-shine-stage-pill--done'
          : 'map-shine-stage-pill map-shine-stage-pill--active';
        passedActive = true;
      } else if (!passedActive) {
        // Stages before the active one are done
        pill.className = 'map-shine-stage-pill map-shine-stage-pill--done';
      } else {
        // Stages after the active one are pending
        pill.className = 'map-shine-stage-pill map-shine-stage-pill--pending';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Debug loading profiler
  // ---------------------------------------------------------------------------

  /**
   * Enable debug mode on the loading overlay.
   * Shows the debug log panel, widens the container, and prepares for log entries.
   * Call this BEFORE showBlack() or during the loading sequence.
   */
  enableDebugMode() {
    this.ensure();
    this._debugMode = true;
    if (this.el) this.el.classList.add('map-shine-loading-overlay--debug');
    // Debug UI must remain clickable even while the overlay is shown.
    // The overlay root defaults to pointer-events:none so it doesn't block gameplay
    // when hidden/fading; debug mode explicitly opts into interaction.
    if (this.el) this.el.style.pointerEvents = 'auto';
    if (this._debugContainerEl) this._debugContainerEl.style.display = 'block';
    if (this._debugContainerEl) this._debugContainerEl.style.pointerEvents = 'auto';
    if (this._debugLogEl) this._debugLogEl.textContent = '';
    if (this._debugDismissBtn) this._debugDismissBtn.style.display = 'none';
  }

  /**
   * Disable debug mode and hide the debug panel.
   */
  disableDebugMode() {
    this._debugMode = false;
    if (this.el) this.el.classList.remove('map-shine-loading-overlay--debug');
    if (this._debugContainerEl) this._debugContainerEl.style.display = 'none';
    if (this._debugContainerEl) this._debugContainerEl.style.pointerEvents = 'none';
    if (this._debugDismissBtn) this._debugDismissBtn.style.display = 'none';
  }

  /**
   * Append a single line to the debug log. Auto-scrolls to bottom.
   * @param {string} line - Text to append (no trailing newline needed)
   */
  appendDebugLine(line) {
    if (!this._debugLogEl) return;
    if (this._debugLogEl.textContent.length > 0) {
      this._debugLogEl.textContent += '\n' + line;
    } else {
      this._debugLogEl.textContent = line;
    }
    // Auto-scroll to bottom
    this._debugLogEl.scrollTop = this._debugLogEl.scrollHeight;
  }

  /**
   * Replace the entire debug log content.
   * @param {string} text - Full log text
   */
  setDebugLog(text) {
    if (!this._debugLogEl) return;
    this._debugLogEl.textContent = text || '';
    this._debugLogEl.scrollTop = this._debugLogEl.scrollHeight;
  }

  /**
   * Show the dismiss button (call when loading is complete).
   * @param {Function} [callback] - Called when button is clicked
   */
  showDebugDismiss(callback = null) {
    this._debugDismissCallback = callback || null;
    // Ensure the overlay is interactive so the user can click the button.
    if (this.el) this.el.style.pointerEvents = 'auto';
    if (this._debugDismissBtn) {
      this._debugDismissBtn.style.display = 'block';
      this._debugDismissBtn.style.pointerEvents = 'auto';
    }
  }

  /**
   * Copy the full debug log text to the clipboard.
   * @private
   */
  async _copyDebugLog() {
    if (!this._debugLogEl) return;
    const text = this._debugLogEl.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      // Flash the button to confirm
      if (this._debugCopyBtn) {
        const orig = this._debugCopyBtn.textContent;
        this._debugCopyBtn.textContent = 'Copied!';
        this._debugCopyBtn.style.color = 'rgba(100, 220, 140, 0.95)';
        this._debugCopyBtn.style.borderColor = 'rgba(100, 220, 140, 0.4)';
        setTimeout(() => {
          if (this._debugCopyBtn) {
            this._debugCopyBtn.textContent = orig;
            this._debugCopyBtn.style.color = 'rgba(255,255,255,0.7)';
            this._debugCopyBtn.style.borderColor = 'rgba(255,255,255,0.2)';
          }
        }, 1500);
      }
    } catch (err) {
      console.warn('Map Shine: Failed to copy debug log to clipboard', err);
    }
  }

  /**
   * Handle dismiss button click — runs the callback then fades out.
   * @private
   */
  _onDebugDismiss() {
    if (this._debugDismissCallback) {
      try { this._debugDismissCallback(); } catch (_) { /* ignore */ }
      this._debugDismissCallback = null;
    }
    // Fade out the overlay
    this.fadeIn(2000, 800).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

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
