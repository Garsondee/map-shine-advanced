/**
 * tools/preview-shared/control-audit.js — measure every control in a room the
 * way it will behave INSIDE FOUNDRY, and name what is wrong with it.
 *
 * Load a harness with Foundry's real stylesheet (`?foundry=<url>`, see
 * page-setup.js), open the room, then from the page (devtools, or the desktop
 * app's browser tool):
 *
 *   const { auditRooms, auditMotion } = await import('/tools/preview-shared/control-audit.js');
 *   auditRooms(['#msa-remote', '#msa-player'])   // what is wrong, named
 *   auditMotion(['#msa-remote', '#msa-player'])  // what actually animates, from getAnimations()
 *
 * (In the desktop app's browser pane, whose page is hidden and heavily throttled, fire the import
 * WITHOUT awaiting it — `import(...).then(m => (window.__audit = m))` — and call the functions in
 * a later, synchronous script: an awaited import there can sit for a minute.)
 *
 * ============================================================================
 * HOW STATES ARE MEASURED (no mouse needed)
 * ============================================================================
 * `:hover`, `:active` and `:focus` cannot be set from script, so this clones
 * every stylesheet rule that mentions one of them with the pseudo-class swapped
 * for a plain class (`:hover` -> `.__aud-hover`). A class and a pseudo-class
 * weigh the same in the cascade, and the copy keeps its `@layer`/`@media`
 * wrappers, so a control with that class computes exactly what the real state
 * would give it — Foundry's layered rules and MSA's unlayered ones included.
 * Transitions are switched off for the read so the SETTLED value is measured,
 * not a mid-fade one (the duration is recorded before that). Each state is
 * applied to EVERY control at once — one style recalculation per state, not one
 * per control: with Foundry's whole stylesheet in the page a recalculation costs
 * ~15ms, and probing control by control took 20s+ for 150 controls (now ~0.5s).
 *
 * KNOWN, DELIBERATE EXCEPTIONS (reported, not hidden): a text field that is
 * focused the moment it opens (the Browse overlay's search box) carries a caret,
 * not a ring, so it shows up as `no-focus-ring`; the astrolabe ring draws its
 * keyboard ring on its square slot (a `mask` would clip it) and is not asked
 * for one; a `msa-planned` stub is not asked for hover feedback.
 *
 * WHAT IT FLAGS (each flag is a real defect class found in the Studio audit of
 * 2026-10-18):
 *   `min-height-binding`  Foundry's `button{min-height:2em}` is making the box
 *                         taller than the height the room's CSS asked for (the
 *                         28x27 CIRCULAR switch, the 24x28 header buttons).
 *   `foundry-hover`       hovering gives the control a BARE FOUNDRY BUTTON's hover
 *                         look (the orange-red fill) — it was never styled.
 *   `no-hover-feedback`   hover changes nothing visible at all.
 *   `no-press-feedback`   `:active` changes nothing (no scale, no colour).
 *   `foundry-focus`       a mouse click would leave Foundry's focus glow behind.
 *   `no-focus-ring`       keyboard focus (`:focus-visible`) shows no ring.
 *   `slow-transition`     a transition of 300ms or more (Foundry's is `0.5s`).
 *   `transition-all`      `transition: all` animates properties nobody meant to.
 *   `ease-in`             an ease-in curve on UI (sluggish exactly when watched).
 *   `native-tooltip`      a non-empty `title` the themed tooltip (ui/widgets/tooltip.js) has
 *                         not taken over: it is outside every scope the tooltip covers, or the
 *                         tooltip is not installed. (Inside a scope the title is converted on the
 *                         first hover, so its mere presence at build time is correct.)
 *   `not-pointer`         a pressable whose cursor is the plain arrow (a text cursor on a field,
 *                         grab/ns-resize on a drag handle are deliberate).
 *   `serif-heading`       a heading still in Foundry's display face.
 *   `full-width-select`   a `<select>` stretched to its parent by Foundry's
 *                         `select{width:100%}` while it has siblings to share with.
 *   `overflow`            content wider/taller than the box (clipped label/icon).
 *
 * @module tools/preview-shared/control-audit
 */

const CLASS = { hover: '__aud-hover', active: '__aud-active', focus: '__aud-focus', focusVisible: '__aud-fv' };
const STATE_RE = /:(hover|active|focus-visible|focus(?![-\w]))/;
const STATE_PROPS = [
  'backgroundColor',
  'backgroundImage',
  'color',
  'borderTopColor',
  'borderTopWidth',
  'borderTopStyle',
  'boxShadow',
  'outlineStyle',
  'outlineWidth',
  'outlineColor',
  'transform',
  'opacity',
  'filter',
  'textDecorationLine',
];
const CONTROL_SELECTOR =
  'button, a[href], select, input, textarea, summary, [role=button], [role=tab], [role=switch], [tabindex]:not([tabindex="-1"])';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

function swapPseudos(text) {
  return text
    .replace(/:hover/g, `.${CLASS.hover}`)
    .replace(/:active/g, `.${CLASS.active}`)
    .replace(/:focus-visible/g, `.${CLASS.focusVisible}`)
    .replace(/:focus(?![-\w])/g, `.${CLASS.focus}`);
}

/** Rewrite one rule (recursing through @media/@layer/@supports), keeping only what mentions a state. */
function rewriteRule(rule) {
  if (rule.cssRules && rule.cssText && !rule.selectorText) {
    const inner = [...rule.cssRules].map(rewriteRule).join('\n');
    if (!inner) return '';
    return `${rule.cssText.slice(0, rule.cssText.indexOf('{'))}{${inner}}`;
  }
  if (rule.selectorText && STATE_RE.test(rule.cssText)) return swapPseudos(rule.cssText);
  return '';
}

/** Build the forced-state copy of every readable stylesheet, once. @returns {{unreadable: number, rules: number}} */
function installForcedStates() {
  if (document.getElementById('__aud-forced')) return { unreadable: 0, rules: -1 };
  let css = '';
  let unreadable = 0;
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      unreadable++;
      continue;
    }
    for (const rule of rules) css += `${rewriteRule(rule)}\n`;
  }
  const style = document.createElement('style');
  style.id = '__aud-forced';
  style.textContent = css;
  document.head.appendChild(style);
  return { unreadable, rules: css.split('}').length };
}

function readState(el) {
  const cs = getComputedStyle(el);
  const out = {};
  for (const p of STATE_PROPS) out[p] = cs[p];
  return out;
}

/**
 * A range input's look lives on its thumb, a UA shadow pseudo-element whose computed style the
 * page cannot read (`getComputedStyle(input, '::-webkit-slider-thumb')` answers with the INPUT's own
 * values). So ask the other way round: does any forced-state rule aimed at the thumb match this
 * input in that state?
 * @param {HTMLElement} el @param {string} stateClass one of {@link CLASS}
 */
function thumbHasStateRule(el, stateClass) {
  const sheet = document.getElementById('__aud-forced')?.sheet;
  if (!sheet) return false;
  const visit = (rules) => {
    for (const rule of rules) {
      if (rule.cssRules && !rule.selectorText) {
        if (visit(rule.cssRules)) return true;
      } else if (rule.selectorText?.includes('::-webkit-slider-thumb') && rule.selectorText.includes(stateClass)) {
        const bare = rule.selectorText.replace(/::-webkit-slider-thumb/g, '');
        el.classList.add(stateClass);
        let hit = false;
        try {
          hit = el.matches(bare);
        } catch {
          hit = false;
        }
        el.classList.remove(stateClass);
        if (hit) return true;
      }
    }
    return false;
  };
  return visit(sheet.cssRules);
}

function withClass(el, cls, fn) {
  el.classList.add(cls);
  try {
    return fn();
  } finally {
    el.classList.remove(cls);
  }
}

function changed(a, b, props = STATE_PROPS) {
  return props.filter((p) => a[p] !== b[p]);
}

/** A bare, unstyled <button> measured in every state — "what Foundry alone does". */
function foundrySignature() {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed; left:-9999px; top:0';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'probe';
  host.appendChild(btn);
  document.body.appendChild(host);
  const sig = {
    minHeight: getComputedStyle(btn).minHeight,
    base: readState(btn),
    hover: withClass(btn, CLASS.hover, () => readState(btn)),
    focus: withClass(btn, CLASS.focus, () => readState(btn)),
  };
  host.remove();
  return sig;
}

const pickSig = (s) => ({
  bg: s.backgroundColor,
  color: s.color,
  border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
  shadow: s.boxShadow,
  outline: `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}`,
});

function describe(el) {
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`;
}

/** The tooltip widget's own element lists the scopes it covers (data-scope). */
function coveredByTooltip(el) {
  const scope = document.getElementById('msa-tooltip')?.dataset.scope;
  return Boolean(scope && el.closest(scope));
}

/** A native input kept for keyboard/screen-reader use but drawn by something else (the fader's 1x1). */
function isVisuallyHiddenInput(el) {
  const r = el.getBoundingClientRect();
  return el.matches('input') && r.width <= 2 && r.height <= 2;
}

function isVisible(el) {
  if (!el.getClientRects().length) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

function durationsMs(cs) {
  return cs.transitionDuration.split(',').map((d) => (d.trim().endsWith('ms') ? parseFloat(d) : parseFloat(d) * 1000));
}

/**
 * @param {string[]} roots - selectors of the rooms/popovers to audit (hidden ones are skipped).
 * @param {{withRows?: boolean}} [opts] - `withRows` adds every control's own row (large).
 * @returns {{env: object, controls: number, flagged: object, byFlag: Record<string, number>, rows?: object[]}}
 */
export function auditRooms(roots, opts = {}) {
  // A previous run that was killed mid-way (a tool timeout) would leave its `transition:none`
  // sheet behind and silently turn every later transition off — which once made a motion audit
  // report that nothing animated. Clear any stale one first, and always remove ours.
  document.querySelectorAll('style[data-aud-nomotion]').forEach((s) => s.remove());
  const noMotion = document.createElement('style');
  noMotion.dataset.audNomotion = '';
  noMotion.textContent = '*,*::before,*::after{transition:none !important; animation:none !important}';
  noMotion.disabled = true;
  document.head.appendChild(noMotion);
  try {
    return runAudit(roots, opts, noMotion);
  } finally {
    noMotion.remove();
  }
}

function runAudit(roots, { withRows = false }, noMotion) {
  const forced = installForcedStates();
  // `noMotion` is switched ON only around a read of states (`still(true)`), OFF while reading
  // authored transitions: with it on, every computed `transition-duration` reads 0s, and with it
  // off Foundry's `transition:0.5s` would still be fading when a state is read.
  const still = (on) => {
    noMotion.disabled = !on;
  };
  still(true);
  const sig = foundrySignature();
  still(false);
  const hoverMedia = matchMedia('(hover:hover) and (pointer:fine)').matches;

  // ---- PASS 1: what each control is and looks like AT REST ----------------------------------------
  const rootEls = roots.flatMap((sel) => [...document.querySelectorAll(sel)]).filter(isVisible);
  const items = [];
  for (const root of rootEls) {
    const rootFont = getComputedStyle(root).fontFamily;
    for (const el of root.querySelectorAll(`${CONTROL_SELECTOR}, ${HEADING_SELECTOR}`)) {
      if (!isVisible(el) || isVisuallyHiddenInput(el)) continue;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const parent = el.parentElement;
      items.push({
        root,
        rootFont,
        el,
        isHeading: el.matches(HEADING_SELECTOR),
        font: cs.fontFamily,
        rect,
        display: cs.display,
        overflow: cs.overflow,
        minHeight: cs.minHeight,
        cursor: cs.cursor,
        transitionProperty: cs.transitionProperty,
        transitionDuration: cs.transitionDuration,
        transitionTiming: cs.transitionTimingFunction,
        durations: durationsMs(cs),
        title: el.getAttribute('title'),
        parentWidth: parent ? parent.getBoundingClientRect().width : 0,
        siblings: parent ? [...parent.children].filter((c) => c !== el && isVisible(c)).length : 0,
        // What a control IS decides which checks make sense: a field answers focus (not a press), a
        // switch answers hover and focus, a slider shows its state on its THUMB, and a drag surface
        // (the astrolabe ring) draws its own focus ring on its slot — see the doc at the top.
        kind: el.matches('[role=slider]:not(input)')
          ? 'surface'
          : el.matches('input[type=range]')
            ? 'slider'
            : el.matches('input[type=checkbox]')
              ? 'toggle'
              : el.matches('select, input:not([type=button]), textarea')
                ? 'field'
                : 'button',
      });
    }
  }

  // ---- PASS 2: every state, applied to ALL controls at once (one style recalc per state, not one per
  // control — on a page carrying Foundry's whole stylesheet a recalc is ~15ms, and per-control probing
  // took 20s+ for 150 controls). A state class only changes its own element's rules.
  const controls = items.filter((i) => !i.isHeading);
  still(true);
  const base = controls.map((i) => readState(i.el));
  const allIn = (cls) => {
    for (const i of controls) i.el.classList.add(cls);
    const out = controls.map((i) => readState(i.el));
    for (const i of controls) i.el.classList.remove(cls);
    return out;
  };
  const hovS = allIn(CLASS.hover);
  const actS = allIn(CLASS.active);
  const focS = allIn(CLASS.focus);
  const fvS = allIn(CLASS.focusVisible);
  still(false);
  const at = new Map(controls.map((item, n) => [item, n]));

  // ---- PASS 3: the verdicts -------------------------------------------------------------------------
  const rows = [];
  for (const item of items) {
    const { el, root } = item;
    const flags = [];
    const info = {
      root: root.id,
      el: describe(el),
      text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('data-tip') || '').trim().slice(0, 24),
    };
    if (item.isHeading) {
      if (item.font !== item.rootFont) flags.push('serif-heading');
      info.font = item.font.slice(0, 40);
      rows.push({ ...info, flags });
      continue;
    }
    const { rect, kind } = item;
    info.size = `${Math.round(rect.width * 10) / 10}x${Math.round(rect.height * 10) / 10}`;
    info.kind = kind;

    // box — Foundry's `button{min-height:2em}`: a box that is exactly as tall as that minimum IS the
    // minimum talking (every room resets min-height to 0, so only a bleed lands on Foundry's value).
    const minH = parseFloat(item.minHeight) || 0;
    if (minH > 0.5 && item.minHeight === sig.minHeight && rect.height - minH <= 0.5) {
      flags.push('min-height-binding');
      info.minHeightExtra = Math.round(minH * 10) / 10;
    }
    if (
      (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) &&
      item.overflow === 'visible' &&
      el.matches('button') &&
      !el.querySelector('.msa-jump-menu')
    ) {
      flags.push('overflow');
    }
    if (el.matches('select') && item.siblings > 0 && item.parentWidth && rect.width >= item.parentWidth - 2) {
      if (item.display !== 'block') flags.push('full-width-select');
    }

    // motion
    const longest = Math.max(...item.durations);
    info.transition = `${item.transitionProperty} ${item.transitionDuration}`.slice(0, 80);
    if (longest >= 300) flags.push('slow-transition');
    if (item.transitionProperty === 'all' && longest > 0) flags.push('transition-all');
    if (/\bease-in\b(?!-out)/.test(item.transitionTiming)) flags.push('ease-in');

    // cursor, tooltips
    if (kind === 'button' && (item.cursor === 'auto' || item.cursor === 'default') && !el.disabled) {
      flags.push('not-pointer');
    }
    info.cursor = item.cursor;
    if (item.title && !coveredByTooltip(el)) flags.push('native-tooltip');

    // states
    const n = at.get(item);
    const [b, hov, act, foc, fv] = [base[n], hovS[n], actS[n], focS[n], fvS[n]];
    if (kind === 'button') {
      const hoverDelta = changed(b, hov);
      // A `msa-planned` control is an honest, inert stub ("not built yet"): it is dashed and red on
      // purpose and is not asked to invite a click.
      if (hoverDelta.length === 0 && !el.classList.contains('msa-planned')) flags.push('no-hover-feedback');
      // A bare Foundry button's hover moves its text and border colour (and its fill, in themes that
      // set one). Any control that lands on ITS hover values for a property Foundry changes was never
      // given a hover of its own.
      const foundryMoved = ['backgroundColor', 'color', 'borderTopColor'].filter((p) => sig.hover[p] !== sig.base[p]);
      const borderShows = hov.borderTopStyle !== 'none' && parseFloat(hov.borderTopWidth) > 0;
      // text colour only matters where there is text (or an icon drawn in currentColor)
      const hasInk = el.textContent.trim().length > 0 || el.querySelector('svg') !== null;
      const bleeds = foundryMoved.filter(
        (p) => hov[p] === sig.hover[p] && (p !== 'borderTopColor' || borderShows) && (p !== 'color' || hasInk)
      );
      if (bleeds.length) {
        flags.push('foundry-hover');
        info.foundryHover = bleeds.join(',');
      }
      if (changed(b, act).length === 0) flags.push('no-press-feedback');
      info.hoverDelta = hoverDelta.join(',') || '-';
      info.pressTransform = act.transform !== 'none' ? act.transform : undefined;
      // Foundry's `button:focus{outline:1px solid X; box-shadow:0 0 4px X}`: a plain MOUSE CLICK
      // matches :focus, so the glow outlives the click. It is a bleed when :focus shows what a bare
      // Foundry button shows.
      const focusGlow =
        foc.boxShadow !== b.boxShadow &&
        foc.boxShadow === sig.focus.boxShadow &&
        sig.focus.boxShadow !== sig.base.boxShadow;
      const focusOutline =
        foc.outlineStyle !== 'none' && parseFloat(foc.outlineWidth) > 0 && foc.outlineColor === sig.focus.outlineColor;
      if (focusGlow || focusOutline) flags.push('foundry-focus');
    }
    if (kind === 'toggle' && changed(b, hov).length === 0) flags.push('no-hover-feedback');
    if (kind === 'slider') {
      if (!thumbHasStateRule(el, CLASS.hover)) flags.push('no-hover-feedback');
      if (!thumbHasStateRule(el, CLASS.focusVisible)) flags.push('no-focus-ring');
    }
    if (kind !== 'surface' && kind !== 'slider') {
      // Fields show focus on :focus (any focus); everything else on :focus-visible only.
      const f = kind === 'field' ? foc : fv;
      const ring = f.outlineStyle !== 'none' && parseFloat(f.outlineWidth) > 0;
      if (!ring && f.boxShadow === b.boxShadow && f.borderTopColor === b.borderTopColor) flags.push('no-focus-ring');
    }
    rows.push({ ...info, flags });
  }

  const byFlag = {};
  const flaggedMap = new Map();
  for (const row of rows) {
    for (const flag of row.flags) {
      byFlag[flag] = (byFlag[flag] || 0) + 1;
      const key = `${flag} | ${row.root} | ${row.el}`;
      const entry = flaggedMap.get(key) || { flag, root: row.root, el: row.el, count: 0, example: row };
      entry.count++;
      flaggedMap.set(key, entry);
    }
  }
  const flagged = {};
  for (const { flag, root, el, count, example } of flaggedMap.values()) {
    (flagged[flag] ||= []).push(
      `${root} ${el} x${count}${example.size ? ` [${example.size}]` : ''}${example.text ? ` "${example.text}"` : ''}${
        example.minHeightExtra ? ` (min-height ${example.minHeightExtra}px)` : ''
      }`
    );
  }
  return {
    env: {
      hoverMedia,
      rootsFound: rootEls.map((r) => r.id),
      forcedStates: forced,
      // what a BARE <button> does under Foundry alone, for reading the flags against
      foundrySignature: {
        base: pickSig(sig.base),
        hover: pickSig(sig.hover),
        focus: pickSig(sig.focus),
      },
    },
    controls: rows.length,
    byFlag,
    flagged,
    ...(withRows ? { rows } : {}),
  };
}

/**
 * Does the motion the rooms promise actually RUN under Foundry's `transition:0.5s`? Presses every
 * distinct pressable (the forced `:active` state), toggles every switch, and lists the transitions
 * the browser really started — property, duration, easing — straight from `getAnimations()`, so what
 * is reported is the live cascade, not the stylesheet text. (The pane's rAF/reduced-motion quirks
 * are handled by `?pane=1`; see page-setup.js.)
 * @param {string[]} roots
 * @returns {{pressables: object[], switches: object[], problems: string[]}}
 */
export function auditMotion(roots) {
  installForcedStates();
  // a stale `transition:none` sheet from a killed audit would make every press look un-animated
  document.querySelectorAll('style[data-aud-nomotion]').forEach((s) => s.remove());
  const problems = [];
  const summarise = (anims) =>
    anims.map((a) => {
      const t = a.effect?.getTiming?.() ?? {};
      return `${a.transitionProperty ?? a.animationName} ${t.duration}ms ${t.easing}`;
    });
  const pressables = [];
  const switches = [];
  const seen = new Set();
  for (const root of roots.flatMap((sel) => [...document.querySelectorAll(sel)]).filter(isVisible)) {
    for (const el of root.querySelectorAll(CONTROL_SELECTOR)) {
      if (!isVisible(el) || isVisuallyHiddenInput(el)) continue;
      const key = `${root.id} ${describe(el)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (el.matches('input[type=checkbox]')) {
        const before = el.checked;
        el.checked = !before;
        void getComputedStyle(el).backgroundColor;
        const anims = el.getAnimations({ subtree: true });
        const list = summarise(anims);
        el.checked = before;
        el.getAnimations({ subtree: true }).forEach((a) => a.finish());
        switches.push({ el: key, running: list });
        if (!anims.some((a) => /transform/.test(a.transitionProperty ?? '')))
          problems.push(`${key}: thumb does not slide`);
        continue;
      }
      if (el.matches('input, select, textarea, [role=slider]')) continue;
      el.classList.add(CLASS.active);
      void getComputedStyle(el).transform;
      const anims = el.getAnimations().filter((a) => a.transitionProperty);
      const press = anims.find((a) => a.transitionProperty === 'transform');
      el.classList.remove(CLASS.active);
      el.getAnimations().forEach((a) => a.finish());
      const row = { el: key, running: summarise(anims) };
      pressables.push(row);
      if (!press) problems.push(`${key}: no transform transition on press`);
      else {
        const t = press.effect.getTiming();
        if (t.duration > 300) problems.push(`${key}: press takes ${t.duration}ms`);
        if (/\bease-in\b(?!-out)/.test(String(t.easing))) problems.push(`${key}: ease-in on press`);
      }
      if (anims.some((a) => a.effect.getTiming().duration >= 300)) problems.push(`${key}: a transition of 300ms+ runs`);
    }
  }
  return { pressables, switches, problems };
}
