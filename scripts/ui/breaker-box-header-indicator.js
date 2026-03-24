import { createLogger } from '../core/log.js';

const log = createLogger('BreakerBoxHeader');

/** Prefer active-floor rollup so the HUD matches what the GM is looking at. */
function headlineHealthStatus(snapshot) {
  if (!snapshot) return 'unknown';
  const af = snapshot.activeFloorOverallStatus ?? snapshot.meta?.activeFloorOverallStatus;
  if (af && af !== 'unknown') return af;
  return snapshot.overallStatus || 'unknown';
}

function colorForStatus(status) {
  if (status === 'critical') return '#ff3b30';
  if (status === 'broken') return '#ff453a';
  if (status === 'degraded') return '#ffcc00';
  if (status === 'healthy') return '#30d158';
  return '#8e8e93';
}

export class BreakerBoxHeaderIndicator {
  constructor({ healthEvaluator = null, dialog = null } = {}) {
    this.healthEvaluator = healthEvaluator;
    this.dialog = dialog;
    this.button = null;
    this._unsubscribe = null;
  }

  attach(mountRoot) {
    if (this.button) return;
    if (!mountRoot) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Open Breaker Box';
    btn.setAttribute('aria-label', 'Open Breaker Box');
    btn.innerHTML = '<span class="mapshine-breaker-dot"></span>';
    btn.style.position = 'absolute';
    btn.style.right = '28px';
    btn.style.top = '50%';
    btn.style.transform = 'translateY(-50%)';
    btn.style.width = '16px';
    btn.style.height = '16px';
    btn.style.lineHeight = '16px';
    btn.style.textAlign = 'center';
    btn.style.border = 'none';
    btn.style.background = 'transparent';
    btn.style.padding = '0';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.cursor = 'pointer';
    btn.style.color = '#8e8e93';
    btn.style.zIndex = '2';

    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.dialog?.toggle?.();
    });
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });

    mountRoot.appendChild(btn);
    this.button = btn;

    this._unsubscribe = this.healthEvaluator?.subscribe?.((snapshot) => {
      this._applyStatus(headlineHealthStatus(snapshot));
    }) || null;
    this._applyStatus(headlineHealthStatus(this.healthEvaluator?.getSnapshot?.()));
  }

  _applyStatus(status) {
    if (!this.button) return;
    const color = colorForStatus(status);
    this.button.style.color = color;
    const dot = this.button.querySelector('.mapshine-breaker-dot');
    if (dot) {
      dot.style.background = color;
      dot.style.boxShadow = `0 0 8px ${color}99`;
    }
    if (status === 'critical' || status === 'broken') {
      this.button.style.animation = 'mapshine-breaker-pulse 1s ease-in-out infinite';
    } else if (status === 'degraded') {
      this.button.style.animation = 'mapshine-breaker-pulse 1.8s ease-in-out infinite';
    } else {
      this.button.style.animation = 'none';
    }

    if (!document.getElementById('map-shine-breaker-style')) {
      const style = document.createElement('style');
      style.id = 'map-shine-breaker-style';
      style.textContent = `
.mapshine-breaker-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  display: inline-block;
  border: 1px solid rgba(255,255,255,0.35);
}
@keyframes mapshine-breaker-pulse {
  0% { transform: scale(1.0); opacity: 1; }
  50% { transform: scale(1.15); opacity: 0.72; }
  100% { transform: scale(1.0); opacity: 1; }
}
`;
      document.head.appendChild(style);
    }
  }

  dispose() {
    try { this._unsubscribe?.(); } catch (_) {}
    this._unsubscribe = null;
    if (this.button?.parentElement) this.button.parentElement.removeChild(this.button);
    this.button = null;
    log.debug('Breaker header indicator disposed');
  }
}

