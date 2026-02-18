/**
 * @fileoverview Loading screen config defaults, normalization, and helpers.
 * @module ui/loading-screen/loading-screen-config
 */

export const LOADING_SCREEN_CONFIG_VERSION = 1;

/**
 * Build the default styled config which visually matches the current Map Shine loading screen.
 * @returns {Object}
 */
export function createDefaultStyledLoadingScreenConfig() {
  return {
    version: LOADING_SCREEN_CONFIG_VERSION,
    themeName: 'Map Shine Default',
    style: {
      backgroundColor: 'rgba(0, 0, 0, 1)',
      accentColor: 'rgba(0, 180, 255, 0.9)',
      secondaryAccentColor: 'rgba(140, 100, 255, 0.9)',
      textColor: 'rgba(255, 255, 255, 0.92)',
      panelBackground: 'rgba(10, 10, 14, 0.7)',
      panelBorder: '1px solid rgba(255, 255, 255, 0.12)',
      panelBlurPx: 14,
      panelRadiusPx: 14,
      panelShadow: '0 12px 48px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255,255,255,0.05)',
      primaryFont: 'Signika',
      bodyFont: 'Signika',
    },
    fonts: {
      googleFamilies: [],
    },
    wallpapers: {
      mode: 'single',
      fit: 'cover',
      entries: [],
      overlay: {
        enabled: false,
        color: 'rgba(0,0,0,0.45)',
      },
    },
    layout: {
      panel: {
        visible: true,
        x: 50,
        y: 50,
        widthPx: 440,
        maxWidthCss: 'calc(100vw - 40px)',
        padding: '24px 22px',
      },
      elements: [
        {
          id: 'title',
          type: 'text',
          visible: true,
          position: { x: 12, y: 8 },
          anchor: 'top-left',
          props: { text: 'Map Shine' },
          style: { fontSize: '20px', fontWeight: '700', color: 'rgba(255,255,255,0.95)' },
          animation: { entrance: { type: 'fade-in', duration: 400, delay: 0, easing: 'ease-out' }, ambient: null },
        },
        {
          id: 'timer',
          type: 'timer',
          visible: true,
          position: { x: 88, y: 9 },
          anchor: 'top-right',
          props: {},
          style: { fontSize: '13px', fontWeight: '500', color: 'rgba(255,255,255,0.45)' },
          animation: { entrance: { type: 'fade-in', duration: 400, delay: 100, easing: 'ease-out' }, ambient: null },
        },
        {
          id: 'scene-name',
          type: 'scene-name',
          visible: true,
          position: { x: 12, y: 16 },
          anchor: 'top-left',
          props: { prefix: 'Loading ' },
          style: { fontSize: '13px', color: 'rgba(255,255,255,0.5)' },
          animation: { entrance: { type: 'fade-in', duration: 400, delay: 180, easing: 'ease-out' }, ambient: null },
        },
        {
          id: 'spinner',
          type: 'spinner',
          visible: true,
          position: { x: 50, y: 35 },
          anchor: 'center',
          props: { variant: 'ring', sizePx: 30 },
          style: {},
          animation: { entrance: { type: 'scale-in', duration: 450, delay: 230, easing: 'ease-out' }, ambient: { type: 'spin', duration: 800, easing: 'linear' } },
        },
        {
          id: 'stage-pills',
          type: 'stage-pills',
          visible: true,
          position: { x: 50, y: 50 },
          anchor: 'center',
          props: {
            containerEnabled: true,
            containerPaddingYpx: 8,
            containerPaddingXpx: 12,
            containerRadiusPx: 999,
            containerBackground: 'rgba(6,10,20,0.62)',
            containerBorder: '1px solid rgba(120,160,255,0.24)',
            maxWidthPx: 1200,
          },
          style: {},
          animation: { entrance: { type: 'fade-in', duration: 350, delay: 300, easing: 'ease-out' }, ambient: null },
        },
        {
          id: 'message',
          type: 'message',
          visible: true,
          position: { x: 50, y: 62 },
          anchor: 'center',
          props: { text: 'Starting…' },
          style: { fontSize: '12.5px', color: 'rgba(255,255,255,0.72)' },
          animation: { entrance: { type: 'fade-in', duration: 300, delay: 380, easing: 'ease-out' }, ambient: null },
        },
        {
          id: 'progress',
          type: 'progress-bar',
          visible: true,
          position: { x: 50, y: 72 },
          anchor: 'center',
          props: { widthPx: 360, heightPx: 6, radiusPx: 999 },
          style: {},
          animation: { entrance: { type: 'fade-in', duration: 300, delay: 420, easing: 'ease-out' }, ambient: { type: 'glow-pulse', duration: 2200, easing: 'ease-in-out' } },
        },
        {
          id: 'percentage',
          type: 'percentage',
          visible: true,
          position: { x: 87, y: 72 },
          anchor: 'center',
          props: {},
          style: { fontSize: '12px', fontWeight: '600', color: 'rgba(255,255,255,0.55)' },
          animation: { entrance: { type: 'fade-in', duration: 300, delay: 460, easing: 'ease-out' }, ambient: null },
        },
      ],
    },
    overlayEffects: [],
  };
}

/**
 * @param {any} input
 * @returns {Object}
 */
export function normalizeLoadingScreenConfig(input) {
  const defaults = createDefaultStyledLoadingScreenConfig();
  const source = isObject(input) ? input : {};

  const config = {
    ...defaults,
    ...source,
    style: {
      ...defaults.style,
      ...(isObject(source.style) ? source.style : {}),
    },
    fonts: {
      ...defaults.fonts,
      ...(isObject(source.fonts) ? source.fonts : {}),
    },
    wallpapers: {
      ...defaults.wallpapers,
      ...(isObject(source.wallpapers) ? source.wallpapers : {}),
      overlay: {
        ...defaults.wallpapers.overlay,
        ...(isObject(source.wallpapers?.overlay) ? source.wallpapers.overlay : {}),
      },
      entries: Array.isArray(source.wallpapers?.entries)
        ? source.wallpapers.entries.filter((e) => isObject(e)).map((e) => ({
            id: String(e.id || cryptoSafeId()),
            label: String(e.label || 'Wallpaper'),
            src: String(e.src || ''),
            pinToFirstLoad: !!e.pinToFirstLoad,
            weight: Number.isFinite(e.weight) ? clamp(e.weight, 1, 10) : 1,
          }))
        : defaults.wallpapers.entries,
    },
    layout: {
      panel: {
        ...defaults.layout.panel,
        ...(isObject(source.layout?.panel) ? source.layout.panel : {}),
      },
      elements: Array.isArray(source.layout?.elements)
        ? source.layout.elements.filter((e) => isObject(e)).map((e) => normalizeElement(e))
        : defaults.layout.elements.map((e) => normalizeElement(e)),
    },
    overlayEffects: Array.isArray(source.overlayEffects)
      ? source.overlayEffects.filter((e) => isObject(e)).map((e) => ({
          type: String(e.type || 'none'),
          enabled: e.enabled !== false,
          intensity: Number.isFinite(e.intensity) ? clamp(e.intensity, 0, 1) : 0.5,
          color: String(e.color || '#ffffff'),
          speed: Number.isFinite(e.speed) ? clamp(e.speed, 0.25, 4) : 1,
        }))
      : defaults.overlayEffects,
  };

  config.version = LOADING_SCREEN_CONFIG_VERSION;
  if (!Array.isArray(config.fonts.googleFamilies)) config.fonts.googleFamilies = [];
  config.fonts.googleFamilies = config.fonts.googleFamilies.map((f) => String(f || '').trim()).filter(Boolean);

  return config;
}

/**
 * @param {Object} element
 * @returns {Object}
 */
function normalizeElement(element) {
  const normalized = {
    id: String(element.id || cryptoSafeId()),
    type: String(element.type || 'text'),
    visible: element.visible !== false,
    position: {
      x: Number.isFinite(element.position?.x) ? clamp(element.position.x, 0, 100) : 50,
      y: Number.isFinite(element.position?.y) ? clamp(element.position.y, 0, 100) : 50,
    },
    anchor: String(element.anchor || 'center'),
    props: isObject(element.props) ? { ...element.props } : {},
    style: isObject(element.style) ? { ...element.style } : {},
    animation: isObject(element.animation) ? { ...element.animation } : { entrance: null, ambient: null },
  };

  if (normalized.type === 'stage-pills') {
    normalized.props.containerEnabled = normalized.props.containerEnabled !== false;
    normalized.props.containerPaddingYpx = Number.isFinite(normalized.props.containerPaddingYpx)
      ? clamp(normalized.props.containerPaddingYpx, 0, 64)
      : 8;
    normalized.props.containerPaddingXpx = Number.isFinite(normalized.props.containerPaddingXpx)
      ? clamp(normalized.props.containerPaddingXpx, 0, 96)
      : 12;
    normalized.props.containerRadiusPx = Number.isFinite(normalized.props.containerRadiusPx)
      ? clamp(normalized.props.containerRadiusPx, 0, 999)
      : 999;
    normalized.props.containerBackground = String(normalized.props.containerBackground || 'rgba(6,10,20,0.62)');
    normalized.props.containerBorder = String(normalized.props.containerBorder || '1px solid rgba(120,160,255,0.24)');
    normalized.props.maxWidthPx = Number.isFinite(normalized.props.maxWidthPx)
      ? clamp(normalized.props.maxWidthPx, 240, 3000)
      : 1200;
  }

  return normalized;
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepClone(value) {
  try {
    return /** @type {T} */ (JSON.parse(JSON.stringify(value)));
  } catch (_) {
    return value;
  }
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function cryptoSafeId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch (_) {
  }
  return `id-${Math.random().toString(36).slice(2, 10)}`;
}
