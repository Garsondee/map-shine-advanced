export class LoadingOverlay {
  constructor() {
    this.el = null;
    this.msgEl = null;
    this.barEl = null;
    this._contentEl = null;
    this._styleEl = null;
    this._token = 0;
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
    bar.style.transition = 'width 120ms linear';

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

  setProgress(value01) {
    this.ensure();
    const v = Number.isFinite(value01) ? Math.max(0, Math.min(1, value01)) : 0;
    if (this.barEl) this.barEl.style.width = `${Math.round(v * 100)}%`;
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
    this.setProgress(0);
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
    this.setProgress(0);
    this.el.style.display = 'flex';
    this.el.style.pointerEvents = 'auto';
    this.el.style.opacity = '1';
    this._setContentOpacity(1, 0);
    this.el.classList.remove('map-shine-loading-overlay--hidden');
  }

  hide() {
    if (!this.el) return;
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
    await new Promise(resolve => requestAnimationFrame(resolve));
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
    await new Promise(resolve => requestAnimationFrame(resolve));
    this._setContentOpacity(0, contentMs);
    this.el.style.backgroundColor = 'rgba(0, 0, 0, 0)';
    await this._sleep(durationMs);
    if (token !== this._token) return;
    this.hide();
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const loadingOverlay = new LoadingOverlay();
