/**
 * @fileoverview Shared CSS animation styles for styled loading screens.
 * @module ui/loading-screen/loading-screen-animations
 */

const STYLE_ID = 'map-shine-loading-screen-animations';

/**
 * Install shared keyframes/classes once.
 * @returns {HTMLStyleElement|null}
 */
export function installLoadingScreenAnimationStyle() {
  try {
    const parent = document.head || document.documentElement;
    if (!parent) return null;

    let style = parent.querySelector(`#${STYLE_ID}`);
    if (style) return /** @type {HTMLStyleElement} */ (style);

    style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = buildCss();
    parent.appendChild(style);
    return /** @type {HTMLStyleElement} */ (style);
  } catch (_) {
    return null;
  }
}

/**
 * @param {string|null|undefined} animationType
 * @returns {string}
 */
export function mapEntranceAnimationClass(animationType) {
  switch (String(animationType || '').trim()) {
    case 'fade-in-up': return 'ms-ls-enter-fade-up';
    case 'fade-in-down': return 'ms-ls-enter-fade-down';
    case 'fade-in-left': return 'ms-ls-enter-fade-left';
    case 'fade-in-right': return 'ms-ls-enter-fade-right';
    case 'scale-in': return 'ms-ls-enter-scale';
    case 'blur-in': return 'ms-ls-enter-blur';
    case 'clip-reveal-up': return 'ms-ls-enter-clip-up';
    case 'clip-reveal-left': return 'ms-ls-enter-clip-left';
    case 'clip-reveal-center': return 'ms-ls-enter-clip-center';
    case 'glitch-in': return 'ms-ls-enter-glitch';
    case 'typewriter': return 'ms-ls-enter-typewriter';
    case 'fade-in':
    default:
      return 'ms-ls-enter-fade';
  }
}

/**
 * @param {string|null|undefined} animationType
 * @returns {string}
 */
export function mapAmbientAnimationClass(animationType) {
  switch (String(animationType || '').trim()) {
    case 'spin': return 'ms-ls-ambient-spin';
    case 'glow-pulse': return 'ms-ls-ambient-glow';
    case 'float': return 'ms-ls-ambient-float';
    case 'float-rotate': return 'ms-ls-ambient-float-rotate';
    case 'pulse':
    default:
      return 'ms-ls-ambient-pulse';
  }
}

function buildCss() {
  return [
    '.map-shine-styled-loading-overlay * { box-sizing: border-box; }',
    '.map-shine-styled-loading-overlay__wallpaper { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }',
    '.map-shine-styled-loading-overlay__wallpaper img { width:100%; height:100%; object-fit:var(--ms-ls-wallpaper-fit,cover); }',
    '.map-shine-styled-loading-overlay__panel { position:absolute; transform:translate(-50%, -50%); will-change: transform, opacity; }',
    '.map-shine-styled-loading-overlay__element { position:absolute; transform:translate(-50%, -50%); will-change: transform, opacity; user-select:none; }',
    '.map-shine-styled-loading-overlay__progress-track { width:100%; height:100%; border-radius:inherit; background:rgba(255,255,255,0.08); overflow:hidden; }',
    '.map-shine-styled-loading-overlay__progress-fill { height:100%; width:0%; border-radius:inherit; background:linear-gradient(90deg, var(--ms-ls-accent, rgba(0,180,255,0.9)), var(--ms-ls-accent-2, rgba(140,100,255,0.9))); }',
    '.map-shine-styled-loading-overlay__spinner { border-radius:50%; border:2.5px solid rgba(255,255,255,0.16); border-top-color: var(--ms-ls-accent, rgba(0,200,255,0.85)); }',
    '.map-shine-styled-loading-overlay__stage-row { display:flex; flex-wrap:wrap; gap:5px; justify-content:center; align-items:center; }',
    '.map-shine-styled-loading-overlay__stage-pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:500; letter-spacing:0.2px; transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease; }',
    '.map-shine-styled-loading-overlay__stage-pill--pending { background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.35); }',
    '.map-shine-styled-loading-overlay__stage-pill--active { background:rgba(0,180,255,0.2); color:rgba(0,210,255,0.95); box-shadow:0 0 8px rgba(0,180,255,0.2); }',
    '.map-shine-styled-loading-overlay__stage-pill--done { background:rgba(100,220,140,0.12); color:rgba(100,220,140,0.75); }',

    '@keyframes msLsEnterFade { from { opacity:0; } to { opacity:1; } }',
    '@keyframes msLsEnterFadeUp { from { opacity:0; transform:translate(-50%, calc(-50% + 20px)); } to { opacity:1; transform:translate(-50%, -50%); } }',
    '@keyframes msLsEnterFadeDown { from { opacity:0; transform:translate(-50%, calc(-50% - 20px)); } to { opacity:1; transform:translate(-50%, -50%); } }',
    '@keyframes msLsEnterFadeLeft { from { opacity:0; transform:translate(calc(-50% - 30px), -50%); } to { opacity:1; transform:translate(-50%, -50%); } }',
    '@keyframes msLsEnterFadeRight { from { opacity:0; transform:translate(calc(-50% + 30px), -50%); } to { opacity:1; transform:translate(-50%, -50%); } }',
    '@keyframes msLsEnterScale { from { opacity:0; transform:translate(-50%, -50%) scale(0.84); } to { opacity:1; transform:translate(-50%, -50%) scale(1); } }',
    '@keyframes msLsEnterBlur { from { opacity:0; filter:blur(12px); } to { opacity:1; filter:blur(0); } }',
    '@keyframes msLsEnterClipUp { from { clip-path:inset(100% 0 0 0); } to { clip-path:inset(0 0 0 0); } }',
    '@keyframes msLsEnterClipLeft { from { clip-path:inset(0 100% 0 0); } to { clip-path:inset(0 0 0 0); } }',
    '@keyframes msLsEnterClipCenter { from { clip-path:inset(50% 50% 50% 50%); } to { clip-path:inset(0 0 0 0); } }',
    '@keyframes msLsEnterGlitch { 0% { opacity:0; transform:translate(-45%, -50%); } 20% { opacity:0.4; transform:translate(-55%, -50%);} 40% { opacity:0.75; transform:translate(-48%, -50%);} 100% { opacity:1; transform:translate(-50%, -50%);} }',
    '@keyframes msLsTypewriter { from { width:0; } to { width:100%; } }',

    '.ms-ls-enter-fade { animation-name: msLsEnterFade; animation-fill-mode: both; }',
    '.ms-ls-enter-fade-up { animation-name: msLsEnterFadeUp; animation-fill-mode: both; }',
    '.ms-ls-enter-fade-down { animation-name: msLsEnterFadeDown; animation-fill-mode: both; }',
    '.ms-ls-enter-fade-left { animation-name: msLsEnterFadeLeft; animation-fill-mode: both; }',
    '.ms-ls-enter-fade-right { animation-name: msLsEnterFadeRight; animation-fill-mode: both; }',
    '.ms-ls-enter-scale { animation-name: msLsEnterScale; animation-fill-mode: both; }',
    '.ms-ls-enter-blur { animation-name: msLsEnterBlur; animation-fill-mode: both; }',
    '.ms-ls-enter-clip-up { animation-name: msLsEnterClipUp; animation-fill-mode: both; }',
    '.ms-ls-enter-clip-left { animation-name: msLsEnterClipLeft; animation-fill-mode: both; }',
    '.ms-ls-enter-clip-center { animation-name: msLsEnterClipCenter; animation-fill-mode: both; }',
    '.ms-ls-enter-glitch { animation-name: msLsEnterGlitch; animation-fill-mode: both; }',
    '.ms-ls-enter-typewriter { white-space:nowrap; overflow:hidden; animation-name: msLsTypewriter; animation-fill-mode: both; }',

    '@keyframes msLsAmbientPulse { 0%, 100% { opacity:0.65; } 50% { opacity:1; } }',
    '@keyframes msLsAmbientSpin { from { transform:translate(-50%, -50%) rotate(0deg); } to { transform:translate(-50%, -50%) rotate(360deg); } }',
    '@keyframes msLsAmbientGlow { 0%, 100% { box-shadow:0 0 6px rgba(0,180,255,0.22); } 50% { box-shadow:0 0 14px rgba(0,180,255,0.5); } }',
    '@keyframes msLsAmbientFloat { 0%, 100% { transform:translate(-50%, -50%) translateY(0px); } 50% { transform:translate(-50%, -50%) translateY(-8px); } }',
    '@keyframes msLsAmbientFloatRotate { 0%, 100% { transform:translate(-50%, -50%) translateY(0px) rotate(-2deg); } 50% { transform:translate(-50%, -50%) translateY(-6px) rotate(2deg); } }',

    '.ms-ls-ambient-pulse { animation-name: msLsAmbientPulse; animation-iteration-count: infinite; }',
    '.ms-ls-ambient-spin { animation-name: msLsAmbientSpin; animation-iteration-count: infinite; }',
    '.ms-ls-ambient-glow { animation-name: msLsAmbientGlow; animation-iteration-count: infinite; }',
    '.ms-ls-ambient-float { animation-name: msLsAmbientFloat; animation-iteration-count: infinite; }',
    '.ms-ls-ambient-float-rotate { animation-name: msLsAmbientFloatRotate; animation-iteration-count: infinite; }',

    '.map-shine-styled-loading-overlay__effect-vignette { position:absolute; inset:0; pointer-events:none; background:radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(0,0,0,0.72) 100%); }',
    '.map-shine-styled-loading-overlay__effect-scanlines { position:absolute; inset:0; pointer-events:none; background:repeating-linear-gradient(to bottom, transparent 0 2px, rgba(0,0,0,0.14) 2px 4px); mix-blend-mode:screen; }',
    '@keyframes msLsGrain { 0% { transform:translate(0,0);} 25% { transform:translate(-4%,2%);} 50% { transform:translate(3%,-3%);} 75% { transform:translate(-2%,4%);} 100% { transform:translate(0,0);} }',
    '.map-shine-styled-loading-overlay__effect-grain { position:absolute; inset:-20%; pointer-events:none; background-image:radial-gradient(rgba(255,255,255,0.18) 0.7px, transparent 0.8px); background-size:3px 3px; opacity:0.06; animation:msLsGrain 0.7s steps(6) infinite; }',

    '@media (prefers-reduced-motion: reduce) {',
    '  .map-shine-styled-loading-overlay__element,',
    '  .map-shine-styled-loading-overlay__progress-fill,',
    '  .map-shine-styled-loading-overlay__spinner { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }',
    '}',
  ].join('\n');
}
