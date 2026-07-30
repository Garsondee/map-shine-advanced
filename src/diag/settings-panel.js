/**
 * @fileoverview diag/settings-panel.js — THE GRAPHICS & PERFORMANCE PANEL.
 *
 * The player-facing surface Control-Panel.md's Zone 5 already specified:
 * *"Leads with the performance profile… then per-effect enable (a11y-forced-off
 * shown LOCKED), then presets."* That spec was written 2026-07-20; nothing ever
 * rendered it — the Settings zone held exactly two bespoke controls for one
 * effect (`ui-shadow`/`ui-shadow-status` in boot.js), and every other
 * already-registered setting (`performanceProfile`, `reducePhotosensitiveEffects`,
 * every effect's own enable pair) was reachable ONLY through Foundry's own
 * native "Configure Settings" dialog.
 *
 * Author directive, 2026-07-29, that this file answers point for point:
 *   1. **The off-switch, most prominent, clearly labelled** — so a player whose
 *      hardware can't run MSA has an obvious way out (Keyhole.md §4.3's "one
 *      legitimate switch", `msaEnabled` — previously documented, never wired to
 *      any control at all; see `effects/effect-settings.js`).
 *   2. **Performance tiers next.**
 *   3. **Per-effect toggles/dropdowns under that.**
 *   4. **Persisted between sessions** — free, by construction: every row here
 *      writes through `foundry/settings-adapter.js`'s `game.settings`, Foundry's
 *      OWN persistence (client scope = this browser, world scope = the GM's
 *      world save). There is no second store to keep in sync.
 *   5. **Feels like a game's graphics options menu, GM+player, the ONLY zone a
 *      player sees** (already true — `debug-panel.js#visibleZones` already
 *      restricts a non-GM to `['settings']`; this file only had to fill it).
 *
 * ============================================================================
 * WHY THIS FILE IMPORTS NOTHING FROM `effects/` (a deliberate, checked pattern)
 * ============================================================================
 *
 * Every other `diag/` module that renders effect-shaped data (`effect-controls
 * .js`) takes ALREADY-DERIVED plain data as arguments and imports nothing from
 * `effects/` — boot.js is the composition root that bridges the two. This file
 * follows the identical discipline: `buildSettingsPanel`'s `deps` are flattened,
 * effect-agnostic data (`effectRows: [{id,title,photosensitive,playerKey,gmKey}]`,
 * `profiles: [{value,label}]`, plain setting-key strings) and two callbacks
 * (`read`/`write`). boot.js does the translation from manifests/`GLOBAL_SETTING
 * _KEYS`/`effectEnableKey` into that shape — the same "boot assembles a small
 * contract, diag/ never reaches into effects/ directly" seam already used for
 * `getCandleRenderState` and the perf-lab harness.
 *
 * The row-shaping logic (which effects are LOCKED, in what order) is pure and
 * exported separately from the DOM builders, per CONVENTIONS §4: `describe
 * EffectRows`/`isEffectLocked` are Node-tested; `buildSettingsPanel` and its
 * sub-builders are plain-DOM and browser-verified only.
 *
 * @module diag/settings-panel
 */

import { sectionLabel } from './debug-panel-controls.js';

// ---- pure: row shaping (Node-tested) ---------------------------------------

/**
 * Is this effect's row forced off and LOCKED (the control disabled, not just
 * showing "Off")? True only when the effect itself declares `photosensitive`
 * AND the player has "reduce photosensitive effects" on — the SAME condition
 * `effect-cascade.js#resolveEffectEnabled`'s step 4 already enforces at the
 * render level. This function does not change what plays; it only decides
 * whether the CONTROL should visually and functionally refuse to be dragged
 * back on, so the panel never shows a live, draggable dropdown for a value the
 * cascade will silently override anyway (Control-Panel.md §5: "a11y-forced-off
 * shown LOCKED").
 * @param {{photosensitive?: boolean}} row
 * @param {boolean} reducePhotosensitive
 * @returns {boolean}
 */
export function isEffectLocked(row, reducePhotosensitive) {
  return row?.photosensitive === true && reducePhotosensitive === true;
}

/**
 * The per-effect list, in REGISTRY order (never re-sorted — the same "no
 * hand-curated order" stance the rest of this project takes; the registry's
 * own registration order is already deliberate), each row carrying whether it
 * is currently locked.
 * @param {Array<{id:string, title:string, photosensitive?:boolean, playerKey:string, gmKey:string}>} effectRows
 * @param {boolean} reducePhotosensitive
 * @returns {Array<{id:string, title:string, photosensitive:boolean, playerKey:string, gmKey:string, locked:boolean}>}
 */
export function describeEffectRows(effectRows, reducePhotosensitive) {
  const list = Array.isArray(effectRows) ? effectRows : [];
  return list.map((r) => ({
    id: r?.id,
    title: r?.title ?? r?.id ?? '?',
    photosensitive: r?.photosensitive === true,
    playerKey: r?.playerKey,
    gmKey: r?.gmKey,
    locked: isEffectLocked(r, reducePhotosensitive),
  }));
}

// ---- DOM (browser-only, CONVENTIONS §4) ------------------------------------

/** This session's "you changed the off-switch, reload to apply" flag. Module
 * scope, not a `buildSettingsPanel` local: `registerPanel`'s `buildFn` runs
 * FRESH on every render (see debug-panel.js's own doc for that contract), so a
 * local variable would be lost the moment anything else in the panel changes.
 * A real page reload clears it for free — there is nothing to reset by hand. */
let msaReloadPending = false;

const PANEL_BG = 'rgba(143,214,255,0.05)';
const PANEL_BORDER = '1px solid rgba(143,214,255,0.14)';
const HINT_STYLE = { fontSize: '9.5px', opacity: '0.55', marginTop: '2px', lineHeight: '1.35' };

function hint(text) {
  const d = document.createElement('div');
  d.textContent = text;
  Object.assign(d.style, HINT_STYLE);
  return d;
}

function section(children, { emphasis = false } = {}) {
  const s = document.createElement('div');
  Object.assign(s.style, {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    padding: emphasis ? '10px 12px' : '7px 10px',
    background: emphasis ? 'rgba(240,180,90,0.07)' : PANEL_BG,
    border: emphasis ? '1px solid rgba(240,180,90,0.3)' : PANEL_BORDER,
    borderRadius: '8px',
  });
  for (const c of children) if (c) s.appendChild(c);
  return s;
}

/**
 * A real toggle switch (checkbox semantics, pill-track visual) — the shape
 * every player recognises as "on/off" from a modern settings menu, rather than
 * a bare checkbox or a 2-item dropdown. Inline-styled throughout, no injected
 * stylesheet: the thumb's position is written directly on change, so there is
 * no `:checked` CSS selector to keep in sync with JS state.
 * @param {string} label @param {boolean} value @param {(next:boolean)=>void} onChange
 * @param {{big?: boolean}} [opts]
 */
function buildToggle(label, value, onChange, opts = {}) {
  const row = document.createElement('label');
  Object.assign(row.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    cursor: 'pointer',
    userSelect: 'none',
  });
  const text = document.createElement('span');
  text.textContent = label;
  Object.assign(text.style, {
    fontWeight: opts.big ? '700' : '600',
    fontSize: opts.big ? '13px' : '11px',
    color: '#eaf4ff',
  });

  const track = document.createElement('span');
  const W = opts.big ? 40 : 32;
  const H = opts.big ? 20 : 17;
  Object.assign(track.style, {
    position: 'relative',
    display: 'inline-block',
    width: `${W}px`,
    height: `${H}px`,
    borderRadius: `${H}px`,
    background: value ? 'rgba(90,220,150,0.55)' : 'rgba(255,255,255,0.14)',
    border: '1px solid rgba(255,255,255,0.18)',
    transition: 'background .12s ease',
    flexShrink: '0',
  });
  const thumb = document.createElement('span');
  const D = H - 6;
  Object.assign(thumb.style, {
    position: 'absolute',
    top: '2px',
    left: value ? `${W - D - 3}px` : '2px',
    width: `${D}px`,
    height: `${D}px`,
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
    transition: 'left .12s ease',
  });
  track.appendChild(thumb);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.style.display = 'none';
  input.addEventListener('change', () => onChange(input.checked));

  row.append(text, track);
  row.insertBefore(input, row.firstChild);
  return row;
}

/**
 * A labelled dropdown row — used for the quality profile and every per-effect
 * enable control. `locked` disables the control and dims the whole row rather
 * than hiding it: the effect is still named, the reason it can't be changed is
 * still visible (Control-Panel.md §5's explicit "shown LOCKED", not "shown
 * gone").
 * @param {string} label @param {Array<{value:string,label:string}>} options
 * @param {string} value @param {(next:string)=>void} onChange
 * @param {{locked?: boolean, big?: boolean}} [opts]
 */
function buildDropdown(label, options, value, onChange, opts = {}) {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    opacity: opts.locked ? '0.45' : '1',
  });
  const text = document.createElement('span');
  text.textContent = opts.locked ? `🔒 ${label}` : label;
  Object.assign(text.style, {
    fontWeight: opts.big ? '700' : '500',
    fontSize: opts.big ? '13px' : '11px',
    color: '#eaf4ff',
  });
  const sel = document.createElement('select');
  sel.disabled = !!opts.locked;
  Object.assign(sel.style, {
    background: 'rgba(10,14,22,0.9)',
    border: '1px solid rgba(143,214,255,0.4)',
    borderRadius: '6px',
    color: '#cfe8ff',
    font: `${opts.big ? '12px' : '11px'}/1.3 Signika, sans-serif`,
    padding: opts.big ? '5px 8px' : '3px 6px',
    minWidth: '120px',
    cursor: opts.locked ? 'not-allowed' : 'pointer',
  });
  for (const o of options) {
    const el = document.createElement('option');
    el.value = o.value;
    el.textContent = o.label;
    sel.appendChild(el);
  }
  sel.value = value ?? '';
  sel.addEventListener('change', () => onChange(sel.value));
  row.append(text, sel);
  return row;
}

/**
 * Build the panel. Called FRESH on every render (`registerPanel`'s contract) —
 * every value below is read live via `deps.read`, so the panel can never show
 * a stale value after a change made elsewhere (console, Foundry's own Settings
 * dialog, another client for a world-scoped row).
 *
 * @param {object} deps
 * @param {string} deps.msaEnabledKey @param {string} deps.profileKey @param {string} deps.a11yKey
 * @param {Array<{value:string,label:string}>} deps.profiles
 * @param {Array<{value:string,label:string}>} deps.enableChoices - Auto/On/Off
 * @param {Array<{id:string,title:string,photosensitive?:boolean,playerKey:string,gmKey:string}>} deps.effectRows
 * @param {(key:string)=>unknown} deps.read
 * @param {(key:string,value:unknown)=>void} deps.write
 * @param {()=>boolean} deps.isGM
 * @param {()=>void} deps.refresh - re-render this panel (does NOT touch the live scene; `write` already triggers that via boot.js's own settings `onChange`).
 * @returns {HTMLElement}
 */
export function buildSettingsPanel(deps) {
  const { msaEnabledKey, profileKey, a11yKey, profiles, enableChoices, effectRows, read, write, isGM, refresh } = deps;

  const root = document.createElement('div');
  Object.assign(root.style, { display: 'flex', flexDirection: 'column', gap: '9px', width: '100%' });

  // 1. THE MASTER OFF-SWITCH — highest, most prominent, per the directive.
  const msaOn = read(msaEnabledKey) !== false;
  const masterRow = buildToggle(
    'Map Shine Advanced',
    msaOn,
    (next) => {
      write(msaEnabledKey, next);
      msaReloadPending = true;
      refresh();
    },
    { big: true }
  );
  const masterChildren = [
    masterRow,
    hint(
      msaOn
        ? "Rendering the map. Turn this off to use Foundry's own renderer instead — useful if it isn't working well on your device."
        : "Off — Foundry's own renderer is drawing the map."
    ),
  ];
  if (msaReloadPending) {
    const reloadRow = document.createElement('div');
    Object.assign(reloadRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' });
    const msg = document.createElement('span');
    msg.textContent = 'Reload to apply.';
    Object.assign(msg.style, { fontSize: '10.5px', color: '#ffd08a', fontWeight: '600' });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '⟳ Reload now';
    Object.assign(btn.style, {
      background: 'rgba(255,196,120,0.18)',
      border: '1px solid rgba(255,196,120,0.5)',
      borderRadius: '6px',
      color: '#ffe6c2',
      font: '10.5px/1.2 Signika, sans-serif',
      fontWeight: '600',
      padding: '3px 9px',
      cursor: 'pointer',
    });
    btn.addEventListener('click', () => window.location.reload());
    reloadRow.append(msg, btn);
    masterChildren.push(reloadRow);
  }
  root.appendChild(section(masterChildren, { emphasis: true }));

  // 2. GRAPHICS QUALITY — the performance profile, second-most prominent.
  const profileValue = read(profileKey);
  root.appendChild(
    section([
      buildDropdown(
        'Graphics Quality',
        profiles,
        profileValue,
        (v) => {
          write(profileKey, v);
          refresh();
        },
        { big: true }
      ),
      hint('Overall visual quality for YOUR machine. Higher looks better and costs more GPU.'),
    ])
  );

  // 3. ACCESSIBILITY.
  const reducePhotosensitive = read(a11yKey) === true;
  root.appendChild(
    section([
      buildToggle('Reduce photosensitive effects', reducePhotosensitive, (next) => {
        write(a11yKey, next);
        refresh();
      }),
      hint(
        'Turns off flashing / animated-light effects. Wins over every effect toggle below, even a GM forcing one on.'
      ),
    ])
  );

  // 4. PER-EFFECT TOGGLES — under everything above, per the directive.
  root.appendChild(sectionLabel('Effects'));
  const rows = describeEffectRows(effectRows, reducePhotosensitive);
  const list = document.createElement('div');
  Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '5px' });
  for (const row of rows) {
    const value = row.locked ? 'off' : (read(row.playerKey) ?? 'auto');
    list.appendChild(
      buildDropdown(
        row.title,
        enableChoices,
        value,
        (v) => {
          write(row.playerKey, v);
          refresh();
        },
        { locked: row.locked }
      )
    );
  }
  root.appendChild(section([list]));

  // 5. GM-ONLY: table defaults. Same effect set, the WORLD key instead — a
  // second section, never a second layout (Control-Panel.md §2's "permission
  // is a filter, not a fork" applied inside one panel, not just across zones).
  if (isGM()) {
    root.appendChild(sectionLabel('Table Defaults (GM)'));
    const gmList = document.createElement('div');
    Object.assign(gmList.style, { display: 'flex', flexDirection: 'column', gap: '5px' });
    for (const row of rows) {
      const value = read(row.gmKey) ?? 'auto';
      gmList.appendChild(
        buildDropdown(row.title, enableChoices, value, (v) => {
          write(row.gmKey, v);
          refresh();
        })
      );
    }
    root.appendChild(
      section([
        gmList,
        hint(
          'Sets the default for every player at this table. Each player can still override this for themselves above.'
        ),
      ])
    );
  }

  return root;
}
