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
        widthCss: '48%',
        maxWidthCss: 'min(960px, 92vw)',
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
          style: { fontSize: 'clamp(18px, 1.8vw, 24px)', fontWeight: '700', color: 'rgba(255,255,255,0.95)' },
          animation: { entrance: { type: 'fade-in', duration: 400, delay: 0, easing: 'ease-out' }, ambient: null },
        },
        {
          id: 'timer',
          type: 'timer',
          visible: true,
          position: { x: 46.2, y: 60.2 },
          anchor: 'center-right',
          props: {},
          style: { fontSize: 'clamp(13px, 1.05vw, 16px)', fontWeight: '700', color: 'rgba(206,228,248,0.9)' },
          animation: { entrance: { type: 'fade-in', duration: 400, delay: 100, easing: 'ease-out' }, ambient: null },
        },
        {
          id: 'scene-name',
          type: 'scene-name',
          visible: true,
          position: { x: 12, y: 16 },
          anchor: 'top-left',
          props: { prefix: 'Entering ' },
          style: { fontSize: 'clamp(11px, 0.9vw, 13px)', color: 'rgba(255,255,255,0.5)' },
          animation: { entrance: { type: 'fade-in', duration: 400, delay: 180, easing: 'ease-out' }, ambient: null },
        },
        {
          id: 'subtitle',
          type: 'text',
          visible: true,
          position: { x: 50, y: 36 },
          anchor: 'center',
          props: { text: 'Preparing your world...' },
          style: { fontSize: 'clamp(11px, 0.9vw, 13px)', fontWeight: '400', color: 'rgba(196,223,255,0.8)' },
          animation: { entrance: { type: 'fade-in', duration: 460, delay: 120, easing: 'ease-out' }, ambient: null },
        },
        {
          id: 'spinner',
          type: 'spinner',
          visible: true,
          position: { x: 50, y: 54.8 },
          anchor: 'center',
          props: { variant: 'ring', sizeCss: 'clamp(54px, 6vw, 84px)' },
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
            maxWidthCss: '72%',
          },
          style: {},
          animation: { entrance: { type: 'fade-in', duration: 350, delay: 300, easing: 'ease-out' }, ambient: null },
        },
        {
          id: 'message',
          type: 'message',
          visible: true,
          position: { x: 50, y: 67.2 },
          anchor: 'center',
          props: { text: 'Starting…' },
          style: { fontSize: 'clamp(12px, 0.98vw, 14px)', fontWeight: '500', color: 'rgba(200,222,244,0.84)' },
          animation: { entrance: { type: 'fade-in', duration: 300, delay: 380, easing: 'ease-out' }, ambient: null },
        },
        {
          id: 'progress',
          type: 'progress-bar',
          visible: true,
          position: { x: 50, y: 60.2 },
          anchor: 'center',
          props: { widthCss: 'min(640px, 62vw)', heightPx: 24, radiusPx: 14 },
          style: {},
          animation: { entrance: { type: 'fade-in', duration: 300, delay: 420, easing: 'ease-out' }, ambient: { type: 'glow-pulse', duration: 2200, easing: 'ease-in-out' } },
        },
        {
          id: 'percentage',
          type: 'percentage',
          visible: true,
          position: { x: 53.8, y: 60.2 },
          anchor: 'center-left',
          props: {},
          style: { fontSize: 'clamp(13px, 1.05vw, 16px)', fontWeight: '700', color: 'rgba(218,241,255,0.9)' },
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
  applyDefaultThemeBottomClusterUpgrade(config);

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

/**
 * Ensure the built-in default theme gets the latest chunky bottom cluster
 * even when older world settings saved stale element values.
 * @param {Object} config
 */
function applyDefaultThemeBottomClusterUpgrade(config) {
  const basePresetId = String(config?.basePresetId || '').trim();
  const themeName = String(config?.themeName || '').trim();
  const isMapShineDefault = basePresetId === 'map-shine-default' || themeName === 'Map Shine Default';
  if (!isMapShineDefault) return;

  const elements = Array.isArray(config?.layout?.elements) ? config.layout.elements : [];
  if (!elements.length) return;

  // Some worlds saved older/default variations can leave duplicate bottom
  // cluster elements. We normalize then enforce singletons by type.
  const canonicalByType = new Map([
    ['progress-bar', 'progress'],
    ['spinner', 'spinner'],
    ['timer', 'timer'],
    ['percentage', 'percentage'],
    ['message', 'message'],
  ]);

  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const id = String(el.id || '').trim();
    if (!id) continue;
    const type = String(el.type || '').trim().toLowerCase();

    // For the built-in default theme, keep only the known decorative custom HTML.
    // Older saved configs can contain extra custom-html bottom shells that no
    // longer match the canonical chunky loading-bar cluster.
    if (type === 'custom-html' && id !== 'decor-line') {
      el.visible = false;
      continue;
    }

    el.position = isObject(el.position) ? el.position : { x: 50, y: 50 };
    el.props = isObject(el.props) ? el.props : {};
    el.style = isObject(el.style) ? el.style : {};

    if (id === 'subtitle') {
      el.props.text = 'Preparing your world...';
    } else if (id === 'scene-name') {
      el.props.prefix = 'Entering ';
    }
  }

  // Enforce one visible element per bottom role type, preferring canonical ids.
  for (const [type, canonicalId] of canonicalByType.entries()) {
    const matches = elements.filter((e) => String(e?.type || '').trim().toLowerCase() === type);
    if (!matches.length) continue;
    let chosen = matches.find((e) => String(e?.id || '').trim() === canonicalId) || matches[0];
    for (const m of matches) m.visible = (m === chosen);
    chosen.id = canonicalId;
    chosen.visible = true;
  }

  // Re-apply canonical bottom-cluster styling by canonical ids.
  for (const el of elements) {
    if (!el || el.visible === false) continue;
    const id = String(el.id || '').trim();
    if (!id) continue;
    applyCanonicalBottomClusterStyle(el, id);
  }
}

function applyCanonicalBottomClusterStyle(el, id) {
  el.position = isObject(el.position) ? el.position : { x: 50, y: 50 };
  el.props = isObject(el.props) ? el.props : {};
  el.style = isObject(el.style) ? el.style : {};

  if (id === 'spinner') {
    el.position.x = 50;
    el.position.y = 54.8;
    el.anchor = 'center';
    el.props.sizeCss = 'clamp(54px, 6vw, 84px)';
    el.props.sizePx = 72;
  } else if (id === 'progress') {
    el.position.x = 50;
    el.position.y = 60.2;
    el.anchor = 'center';
    el.props.widthCss = 'min(640px, 62vw)';
    el.props.heightPx = 24;
    el.props.radiusPx = 14;
  } else if (id === 'timer') {
    el.position.x = 46.2;
    el.position.y = 60.2;
    el.anchor = 'center-right';
    el.style.fontSize = 'clamp(13px, 1.05vw, 16px)';
    el.style.fontWeight = '700';
    el.style.color = 'rgba(206,228,248,0.9)';
  } else if (id === 'percentage') {
    el.position.x = 53.8;
    el.position.y = 60.2;
    el.anchor = 'center-left';
    el.style.fontSize = 'clamp(13px, 1.05vw, 16px)';
    el.style.fontWeight = '700';
    el.style.color = 'rgba(218,241,255,0.9)';
  } else if (id === 'message') {
    el.position.x = 50;
    el.position.y = 67.2;
    el.anchor = 'center';
    el.style.fontSize = 'clamp(12px, 0.98vw, 14px)';
    el.style.fontWeight = '500';
    el.style.color = 'rgba(200,222,244,0.84)';
  }
}
