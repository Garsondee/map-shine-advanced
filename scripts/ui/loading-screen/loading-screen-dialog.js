/**
 * @fileoverview WYSIWYG Loading Screen Dialog.
 * @module ui/loading-screen/loading-screen-dialog
 */

import { normalizeLoadingScreenConfig, normalizePresentationTimings, WALLPAPER_MODES } from './loading-screen-config.js';
import { getAllLoadingHints } from './loading-hints.js';
import { getAvailableFontFamilies } from './loading-screen-fonts.js';
import { applyPresetToConfig } from './loading-screen-presets.js';
import {
  alignEntries,
  buildSnapTargets,
  centerEntriesOn,
  distributeEntries,
  loadAlignmentPrefs,
  rectRelativeToLayer,
  resolveAxisSnap,
  saveAlignmentPrefs,
  snapThresholdForStrength,
} from './loading-screen-alignment.js';
import {
  applyRectToElement,
  applyRectToPanel,
  computePanelResizeRect,
  computeResizedRect,
  cursorForHandle,
  measureElementRect,
  RESIZE_HANDLES,
} from './loading-screen-element-resize.js';

const DIALOG_ID = 'map-shine-loading-screen-dialog';
const STYLE_ID = 'map-shine-loading-screen-dialog-style';

export class LoadingScreenDialog {
  /**
   * @param {import('./loading-screen-manager.js').LoadingScreenManager} manager
   */
  constructor(manager) {
    this.manager = manager;

    this.container = null;
    this.visible = false;

    this.state = null;
    this.selectedElementId = null;
    /** @type {Set<string>} */
    this.selectedElementIds = new Set();
    this.drag = null;
    this._fontFamilies = [];
    this._alignmentPrefs = loadAlignmentPrefs();
    this._alignmentGuideTimer = null;
    this._onKeyDown = null;

    this._safeRatio = 'none'; // safe guides are optional and off by default
    this._layoutHelperRefId = '__panel__';
    this._layoutHelperGapPct = 1.5;
    this._layoutHelperNudgePct = 0.5;
    this._dragSnapPct = 0.25;
    this._suppressPresetChange = false;
    /** @type {string|null} Composer-only wallpaper preview selection (not persisted). */
    this._previewWallpaperId = null;

    this.refs = {
      modeSelect: null,
      enabledCheckbox: null,
      foundryCheckbox: null,
      applyScopeSelect: null,
      googleFontsCheckbox: null,
      presetSelect: null,
      userPresetInput: null,
      userPresetList: null,
      deleteUserPresetBtn: null,
      presentationSettings: null,
      wallpaperList: null,
      wallpaperModeSelect: null,
      wallpaperFitSelect: null,
      elementList: null,
      previewLayer: null,
      safeGuides: null,
      alignmentGuides: null,
      alignToolbar: null,
      snapEnabledCheckbox: null,
      axesEnabledCheckbox: null,
      snapStrengthSelect: null,
      inspector: null,
      status: null,
    };
  }

  async initialize(parentElement = document.body) {
    if (this.container) return;

    this._installStyle();

    this.container = document.createElement('div');
    this.container.id = DIALOG_ID;
    this.container.className = 'ms-lsd-overlay';
    this.container.style.display = 'none';

    this.container.innerHTML = this._buildMarkup();
    parentElement.appendChild(this.container);

    this._cacheRefs();
    this._bindEvents();
    this._fontFamilies = getAvailableFontFamilies();

    await this._loadState();
    this._renderAll();
  }

  async show() {
    if (!this.container) await this.initialize();
    this.visible = true;
    this.container.style.display = 'block';
    this._bindKeyboardNudge();
    await this._loadState();
    this._renderAll();
  }

  hide() {
    if (!this.container) return;
    this.visible = false;
    this.container.style.display = 'none';
    this._unbindKeyboardNudge();
  }

  async toggle() {
    if (this.visible) this.hide();
    else await this.show();
  }

  dispose() {
    this._unbindKeyboardNudge();
    if (this._alignmentGuideTimer) {
      clearTimeout(this._alignmentGuideTimer);
      this._alignmentGuideTimer = null;
    }
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
    if (!this.container) return;
    this.container.remove();
    this.container = null;
    this.visible = false;
  }

  async _loadState() {
    this.state = await this.manager.getRuntimeState();
    this.state.config = normalizeLoadingScreenConfig(this.state.config);
    if (!this.selectedElementId) {
      this.selectedElementId = this.state.config.layout?.elements?.[0]?.id || null;
    }
    if (this.selectedElementId && this.selectedElementId !== '__panel__') {
      this.selectedElementIds = new Set([this.selectedElementId]);
    } else {
      this.selectedElementIds = new Set();
    }
    this._ensurePreviewWallpaperId();
  }

  _renderAll() {
    this._renderTopControls();
    this._renderUserPresetList();
    this._renderPresentationSettings();
    this._renderWallpaperSettings();
    this._renderWallpaperList();
    this._renderAlignToolbar();
    this._renderElementList();
    this._renderPreview();
    this._renderInspector();
    this._renderSafeGuides();
    this._renderPersistentAxes();
  }

  _renderWallpaperSettings() {
    const wallpapers = this.state?.config?.wallpapers;
    if (!wallpapers) return;

    if (this.refs.wallpaperModeSelect) {
      const mode = String(wallpapers.mode || WALLPAPER_MODES.SEQUENTIAL);
      this.refs.wallpaperModeSelect.value = mode;
    }

    if (this.refs.wallpaperFitSelect) {
      this.refs.wallpaperFitSelect.value = String(wallpapers.fit || 'cover');
    }
  }

  _renderPresentationSettings() {
    const host = this.refs.presentationSettings;
    if (!host || !this.state?.config) return;

    if (!this.state.config.presentation) {
      this.state.config.presentation = normalizePresentationTimings(null);
    }

    const p = this.state.config.presentation;
    host.innerHTML = '';

    const intro = document.createElement('div');
    intro.className = 'ms-lsd-empty';
    intro.style.marginBottom = '6px';
    intro.textContent = 'Scene load fade timings (ms). Defaults: 4000ms fades.';
    host.appendChild(intro);

    const fields = [
      { key: 'coverFadeMs', label: 'Cover fade (scene → black)' },
      { key: 'panelInFadeMs', label: 'Panel in (black → loading UI)' },
      { key: 'minBlackHoldMs', label: 'Min black hold before panel in' },
      { key: 'minVisibleMs', label: 'Min visible after panel in' },
      { key: 'readyHoldMs', label: 'Hold at Ready / 100%' },
      { key: 'panelOutFadeMs', label: 'Panel out (loading UI → black)' },
      { key: 'sceneRevealFadeMs', label: 'Scene reveal (black → scene)' },
      { key: 'progressSettleMs', label: 'Progress bar settle wait' },
    ];

    for (const field of fields) {
      host.appendChild(this._inputRow(field.label, this._number(
        num(p[field.key], 0),
        0,
        10000,
        100,
        (v) => {
          p[field.key] = Math.max(0, Math.round(v));
          this.state.config.presentation = normalizePresentationTimings(p);
        }
      )));
    }

    const deferRow = document.createElement('label');
    deferRow.className = 'ms-lsd-stack';
    deferRow.style.marginTop = '4px';
    const deferCheckbox = document.createElement('input');
    deferCheckbox.type = 'checkbox';
    deferCheckbox.checked = p.deferPanelUntilPresentable !== false;
    deferCheckbox.addEventListener('change', () => {
      p.deferPanelUntilPresentable = deferCheckbox.checked;
      this.state.config.presentation = normalizePresentationTimings(p);
    });
    deferRow.append(deferCheckbox, document.createTextNode(' Wait for fonts/wallpaper before panel in'));
    host.appendChild(deferRow);
  }

  _cacheRefs() {
    const q = (selector) => this.container.querySelector(selector);

    this.refs.modeSelect = q('[data-ref="mode"]');
    this.refs.enabledCheckbox = q('[data-ref="enabled"]');
    this.refs.foundryCheckbox = q('[data-ref="use-foundry"]');
    this.refs.applyScopeSelect = q('[data-ref="apply-scope"]');
    this.refs.googleFontsCheckbox = q('[data-ref="google-fonts"]');
    this.refs.presetSelect = q('[data-ref="preset"]');
    this.refs.userPresetInput = q('[data-ref="preset-name"]');
    this.refs.userPresetList = q('[data-ref="user-preset-list"]');
    this.refs.deleteUserPresetBtn = q('[data-action="delete-user-preset"]');
    this.refs.presentationSettings = q('[data-ref="presentation-settings"]');
    this.refs.wallpaperList = q('[data-ref="wallpaper-list"]');
    this.refs.wallpaperModeSelect = q('[data-ref="wallpaper-mode"]');
    this.refs.wallpaperFitSelect = q('[data-ref="wallpaper-fit"]');
    this.refs.elementList = q('[data-ref="element-list"]');
    this.refs.previewLayer = q('[data-ref="preview-layer"]');
    this.refs.safeGuides = q('[data-ref="safe-guides"]');
    this.refs.alignmentGuides = q('[data-ref="alignment-guides"]');
    this.refs.alignToolbar = q('[data-ref="align-toolbar"]');
    this.refs.snapEnabledCheckbox = q('[data-ref="snap-enabled"]');
    this.refs.axesEnabledCheckbox = q('[data-ref="axes-enabled"]');
    this.refs.snapStrengthSelect = q('[data-ref="snap-strength"]');
    this.refs.inspector = q('[data-ref="inspector"]');
    this.refs.status = q('[data-ref="status"]');

    if (this.refs.snapEnabledCheckbox) {
      this.refs.snapEnabledCheckbox.checked = this._alignmentPrefs.snapEnabled !== false;
    }
    if (this.refs.axesEnabledCheckbox) {
      this.refs.axesEnabledCheckbox.checked = !!this._alignmentPrefs.axesEnabled;
    }
    if (this.refs.snapStrengthSelect) {
      this.refs.snapStrengthSelect.value = String(this._alignmentPrefs.snapStrength || 'normal');
    }
  }

  _bindEvents() {
    // The overlay IS the live preview — don't close on background click.
    // Users close via the Close button only.
    this.container.querySelector('[data-action="close"]')?.addEventListener('click', () => this.hide());

    // Safe-region aspect ratio selector
    this.container.querySelector('[data-ref="safe-ratio"]')?.addEventListener('change', (e) => {
      this._safeRatio = String(e.target.value || 'none');
      this._renderSafeGuides();
    });

    this.refs.snapEnabledCheckbox?.addEventListener('change', (e) => {
      this._alignmentPrefs.snapEnabled = !!e.target.checked;
      saveAlignmentPrefs(this._alignmentPrefs);
    });
    this.refs.axesEnabledCheckbox?.addEventListener('change', (e) => {
      this._alignmentPrefs.axesEnabled = !!e.target.checked;
      saveAlignmentPrefs(this._alignmentPrefs);
      this._renderPersistentAxes();
    });
    this.refs.snapStrengthSelect?.addEventListener('change', (e) => {
      this._alignmentPrefs.snapStrength = String(e.target.value || 'normal');
      saveAlignmentPrefs(this._alignmentPrefs);
    });

    // Re-render safe guides on resize so they match the new viewport
    this._onResize = () => {
      if (!this.visible) return;
      this._renderSafeGuides();
      this._renderPersistentAxes();
    };
    window.addEventListener('resize', this._onResize);

    this.refs.previewLayer?.addEventListener('mousedown', (ev) => {
      if (!this.visible || this.drag) return;
      if (ev.button !== 0) return;
      if (ev.target.closest('.ms-lsd-live-element, .ms-lsd-live-panel, .ms-lsd-resize-handle')) return;
      if (!this.selectedElementId && this.selectedElementIds.size === 0) return;
      ev.preventDefault();
      this._clearSelection();
      this._renderPreview();
      this._renderElementList();
      this._renderInspector();
      this._renderAlignToolbar();
    });

    // Make the floating dialog draggable by its header
    const floating = this.container.querySelector('.ms-lsd-floating');
    const header = this.container.querySelector('.ms-lsd-header');
    if (floating && header) {
      header.addEventListener('mousedown', (ev) => {
        if (ev.target.closest('button, select, input, label')) return;
        ev.preventDefault();
        const startX = ev.clientX;
        const startY = ev.clientY;
        const rect = floating.getBoundingClientRect();
        const origLeft = rect.left;
        const origTop = rect.top;

        // Switch from right-positioned to left-positioned for dragging
        floating.style.right = 'auto';
        floating.style.left = `${origLeft}px`;
        floating.style.top = `${origTop}px`;

        const onMove = (moveEv) => {
          const dx = moveEv.clientX - startX;
          const dy = moveEv.clientY - startY;
          floating.style.left = `${origLeft + dx}px`;
          floating.style.top = `${origTop + dy}px`;
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    }

    this.refs.enabledCheckbox?.addEventListener('change', () => {
      this.state.enabled = this.refs.enabledCheckbox.checked;
      this._renderTopControls();
    });

    this.refs.modeSelect?.addEventListener('change', () => {
      this.state.mode = String(this.refs.modeSelect.value || 'legacy');
      this._renderTopControls();
    });

    this.refs.foundryCheckbox?.addEventListener('change', () => {
      this.state.useFoundryDefault = this.refs.foundryCheckbox.checked;
      this._renderTopControls();
    });

    this.refs.applyScopeSelect?.addEventListener('change', () => {
      this.state.applyTo = String(this.refs.applyScopeSelect.value || 'all');
    });

    this.refs.googleFontsCheckbox?.addEventListener('change', () => {
      this.state.googleFontsEnabled = this.refs.googleFontsCheckbox.checked;
    });

    this.refs.wallpaperModeSelect?.addEventListener('change', () => {
      if (!this.state?.config?.wallpapers) return;
      this.state.config.wallpapers.mode = String(this.refs.wallpaperModeSelect.value || WALLPAPER_MODES.SEQUENTIAL);
      this.state.config.wallpapersModeExplicit = true;
      this._renderPreview();
      this._status(`Wallpaper rotation: ${this.state.config.wallpapers.mode}.`);
    });

    this.refs.wallpaperFitSelect?.addEventListener('change', () => {
      if (!this.state?.config?.wallpapers) return;
      this.state.config.wallpapers.fit = String(this.refs.wallpaperFitSelect.value || 'cover');
      this._renderPreview();
    });

    this.refs.presetSelect?.addEventListener('change', async () => {
      if (this._suppressPresetChange) return;
      const presetId = String(this.refs.presetSelect.value || '');
      if (!presetId) return;

      // Apply the preset locally (no persistence) so changes stay in the
      // dialog until the user explicitly clicks Apply / Save+Close.
      try {
        this.state.config = await this.manager.resolvePresetConfig(presetId, this.state.config);
        this.state.activePresetId = presetId;
        this.state.userPresets = await this.manager.getUserPresets();
        this.selectedElementId = this.state.config.layout?.elements?.[0]?.id || null;
        const wallpaperCount = this.state.config.wallpapers?.entries?.length || 0;
        console.log(`Map Shine: dialog applied preset "${presetId}"`, {
          style: this.state.config.style,
          wallpaperCount,
        });
        this._status('Applied preset (click Apply to save).');
        this._renderAll();
      } catch (err) {
        console.error('Map Shine: failed to apply preset in dialog', err);
        this._status('Failed to apply preset.');
      }
    });

    this.container.querySelector('[data-action="save-user-preset"]')?.addEventListener('click', async () => {
      const name = String(this.refs.userPresetInput.value || '').trim();
      if (!name) {
        this._status('Enter a preset name first.');
        return;
      }
      this._markLayoutCustomized();
      const saved = await this.manager.saveUserPreset({ name, config: this.state.config });
      this.state.activePresetId = saved.id;
      await this._applyChanges();
      this.state.userPresets = await this.manager.getUserPresets();
      this.refs.userPresetInput.value = '';
      this._status(`Saved preset "${name}" and applied loading screen settings.`);
      this._renderTopControls();
      this._renderUserPresetList();
    });

    this.container.querySelector('[data-action="delete-user-preset"]')?.addEventListener('click', async () => {
      const presetId = String(this.refs.presetSelect?.value || '');
      await this._deleteUserPreset(presetId);
    });

    this.container.querySelector('[data-action="add-element"]')?.addEventListener('click', () => {
      this._addElement();
      this._renderAll();
    });

    this.container.querySelector('[data-action="add-hints-element"]')?.addEventListener('click', () => {
      this._addHintsElement();
      this._renderAll();
    });

    this.container.querySelector('[data-action="manage-hints"]')?.addEventListener('click', async () => {
      await this.manager.openHintsDialog();
    });

    this.container.querySelector('[data-action="add-wallpaper"]')?.addEventListener('click', async () => {
      const src = await this._pickFilePath();
      if (!src) return;

      const entry = {
        id: `wall-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        label: this._basename(src),
        src,
        pinToFirstLoad: false,
        weight: 1,
      };

      this.state.config.wallpapers.entries.push(entry);
      this._previewWallpaperId = entry.id;
      if (this.state.config.wallpapers.entries.length > 1) {
        const mode = String(this.state.config.wallpapers.mode || WALLPAPER_MODES.SEQUENTIAL);
        if (mode === WALLPAPER_MODES.SINGLE && this.state.config.wallpapersModeExplicit !== true) {
          this.state.config.wallpapers.mode = WALLPAPER_MODES.SEQUENTIAL;
          this._status('Multiple wallpapers — rotation set to Sequential (cycles each load).');
        }
      }
      this._renderWallpaperList();
      this._renderPreview();
      this._status('Wallpaper added.');
    });

    this.container.querySelector('[data-action="apply"]')?.addEventListener('click', async () => {
      await this._applyChanges();
    });

    this.container.querySelector('[data-action="save-close"]')?.addEventListener('click', async () => {
      await this._applyChanges();
      this.hide();
    });

    this.container.querySelector('[data-action="reset-default"]')?.addEventListener('click', async () => {
      // Reset locally — no persistence until Apply / Save+Close.
      try {
        this.state.config = await applyPresetToConfig('map-shine-default', this.state.config);
      } catch (_) {
        this.state.config = normalizeLoadingScreenConfig(null);
      }
      this.state.activePresetId = 'map-shine-default';
      this.selectedElementId = this.state.config.layout?.elements?.[0]?.id || null;
      this._status('Reset to default (click Apply to save).');
      this._renderAll();
    });
  }

  _renderTopControls() {
    const modeSelect = this.refs.modeSelect;
    if (modeSelect) modeSelect.value = this.state.mode || 'legacy';

    if (this.refs.enabledCheckbox) this.refs.enabledCheckbox.checked = this.state.enabled !== false;
    if (this.refs.foundryCheckbox) this.refs.foundryCheckbox.checked = this.state.useFoundryDefault === true;
    if (this.refs.applyScopeSelect) this.refs.applyScopeSelect.value = this.state.applyTo || 'all';
    if (this.refs.googleFontsCheckbox) this.refs.googleFontsCheckbox.checked = this.state.googleFontsEnabled !== false;

    const presetSelect = this.refs.presetSelect;
    if (presetSelect) {
      const builtIns = Array.isArray(this.state.builtInPresets) ? this.state.builtInPresets : [];
      const user = Array.isArray(this.state.userPresets) ? this.state.userPresets : [];

      presetSelect.innerHTML = '';

      const addGroup = (label, list, isUser = false) => {
        if (!Array.isArray(list) || list.length === 0) return;
        const group = document.createElement('optgroup');
        group.label = label;
        for (const item of list) {
          const option = document.createElement('option');
          option.value = String(item.id || '');
          option.textContent = isUser ? `User: ${item.name || item.id}` : String(item.name || item.id || 'Preset');
          group.appendChild(option);
        }
        presetSelect.appendChild(group);
      };

      addGroup('Built-in', builtIns, false);
      addGroup('User', user, true);

      const active = String(this.state.activePresetId || 'map-shine-default');
      this._suppressPresetChange = true;
      try {
        presetSelect.value = active;
      } finally {
        this._suppressPresetChange = false;
      }

      const activeId = String(presetSelect.value || this.state.activePresetId || '');
      const isUserPreset = (this.state.userPresets || []).some((p) => String(p?.id || '') === activeId);
      if (this.refs.deleteUserPresetBtn) {
        this.refs.deleteUserPresetBtn.classList.toggle('is-muted', !isUserPreset);
        this.refs.deleteUserPresetBtn.title = isUserPreset
          ? 'Delete the selected user preset'
          : 'Select a user preset from the dropdown (User group) to delete';
      }
    }
  }

  _renderUserPresetList() {
    const listEl = this.refs.userPresetList;
    if (!listEl) return;

    const user = Array.isArray(this.state?.userPresets) ? this.state.userPresets : [];
    listEl.innerHTML = '';

    if (user.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ms-lsd-empty';
      empty.textContent = 'No user presets yet. Save the current layout above.';
      listEl.appendChild(empty);
      return;
    }

    for (const preset of user) {
      const id = String(preset.id || '');
      const isActive = id && id === String(this.state.activePresetId || '');

      const row = document.createElement('div');
      row.className = `ms-lsd-user-preset-row${isActive ? ' is-active' : ''}`;

      const main = document.createElement('div');
      main.className = 'ms-lsd-user-preset-main';

      const name = document.createElement('div');
      name.className = 'ms-lsd-user-preset-name';
      name.textContent = preset.name || id || 'Custom Preset';

      const meta = document.createElement('div');
      meta.className = 'ms-lsd-user-preset-meta';
      meta.textContent = isActive ? 'Currently selected' : 'Click to select';

      main.append(name, meta);

      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.ms-lsd-user-preset-controls, button')) return;
        if (!this.refs.presetSelect || !id) return;
        this.refs.presetSelect.value = id;
        this.refs.presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const controls = document.createElement('div');
      controls.className = 'ms-lsd-user-preset-controls';
      controls.addEventListener('click', (ev) => ev.stopPropagation());

      const remove = this._button('✕', async (ev) => {
        ev?.stopPropagation?.();
        await this._deleteUserPreset(id);
      }, true);
      remove.title = 'Delete this user preset';

      controls.append(remove);
      row.append(main, controls);
      listEl.appendChild(row);
    }
  }

  async _deleteUserPreset(presetId) {
    const id = String(presetId || '').trim();
    if (!id) {
      this._status('Select a user preset to delete.');
      return;
    }

    let userPresets = [];
    try {
      userPresets = await this.manager.getUserPresets();
    } catch (err) {
      console.error('Map Shine: failed to load user presets for delete', err);
      this._status('Could not load user presets.');
      return;
    }

    const preset = userPresets.find((p) => String(p?.id || '') === id);
    if (!preset) {
      this._status('Only user presets can be deleted. Pick one from the User group in the dropdown.');
      return;
    }

    const label = foundry.utils.escapeHTML(String(preset.name || preset.id || 'Custom Preset'));
    let confirmed = false;
    try {
      confirmed = await this._confirmAboveOverlay({
        title: 'Delete Loading Screen Preset',
        content: `<p>Permanently delete user preset <strong>${label}</strong>? This cannot be undone.</p>`,
      });
    } catch (err) {
      console.error('Map Shine: delete preset confirmation failed', err);
      this._status('Delete confirmation failed.');
      return;
    }
    if (!confirmed) return;

    try {
      await this.manager.deleteUserPreset(id);
    } catch (err) {
      console.error('Map Shine: failed to delete user preset', err);
      ui.notifications?.error?.('Map Shine: Could not delete loading screen preset.');
      this._status('Failed to delete preset.');
      return;
    }

    this.state.userPresets = await this.manager.getUserPresets();

    const wasActive = String(this.state.activePresetId || '') === id;
    if (wasActive) {
      this.state.activePresetId = 'map-shine-default';
      try {
        this.state.config = await this.manager.resolvePresetConfig('map-shine-default', this.state.config);
      } catch (_) {
        this.state.config = normalizeLoadingScreenConfig(null);
      }
    }

    this._renderTopControls();
    this._renderUserPresetList();
    if (wasActive) {
      this._renderAll();
      this._status(`Deleted "${preset.name}" and switched to Map Shine Default (click Apply to save).`);
    } else {
      this._status(`Deleted user preset "${preset.name}".`);
    }
  }

  _getValidWallpaperEntries() {
    return (this.state?.config?.wallpapers?.entries || [])
      .filter((e) => e && String(e.src || '').trim());
  }

  _ensurePreviewWallpaperId() {
    const valid = this._getValidWallpaperEntries();
    if (this._previewWallpaperId && valid.some((e) => String(e.id) === String(this._previewWallpaperId))) {
      return;
    }
    this._previewWallpaperId = valid[0]?.id ? String(valid[0].id) : null;
  }

  _resolvePreviewWallpaper() {
    this._ensurePreviewWallpaperId();
    const valid = this._getValidWallpaperEntries();
    if (!valid.length) return null;
    return valid.find((e) => String(e.id) === String(this._previewWallpaperId)) || valid[0];
  }

  _setPreviewWallpaper(entryOrId) {
    const id = typeof entryOrId === 'object' ? entryOrId?.id : entryOrId;
    if (!id) return;
    const entry = this._getValidWallpaperEntries().find((e) => String(e.id) === String(id));
    if (!entry) return;
    this._previewWallpaperId = String(entry.id);
    this._renderWallpaperList();
    this._renderPreview();
    this._status(`Previewing wallpaper: ${entry.label || this._basename(entry.src)}`);
  }

  _renderWallpaperList() {
    const listEl = this.refs.wallpaperList;
    if (!listEl) return;

    const wallpapers = this.state.config.wallpapers.entries || [];
    listEl.innerHTML = '';

    this._ensurePreviewWallpaperId();

    if (wallpapers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ms-lsd-empty';
      empty.textContent = 'No wallpapers. Add one to enable themed backgrounds.';
      listEl.appendChild(empty);
      return;
    }

    const hint = document.createElement('div');
    hint.className = 'ms-lsd-wall-hint';
    hint.textContent = 'Click a wallpaper to preview it behind the composer.';
    listEl.appendChild(hint);

    wallpapers.forEach((w, index) => {
      const entryId = String(w?.id || '');
      const isPreviewing = entryId && entryId === String(this._previewWallpaperId || '');
      const row = document.createElement('div');
      row.className = `ms-lsd-wall-row${isPreviewing ? ' is-previewing' : ''}`;
      row.title = isPreviewing ? 'Currently previewing' : 'Click to preview this wallpaper';
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.ms-lsd-wall-controls, input, button')) return;
        if (!String(w?.src || '').trim()) return;
        this._setPreviewWallpaper(w);
      });

      const thumb = document.createElement('div');
      thumb.className = 'ms-lsd-wall-thumb';
      if (String(w?.src || '').trim()) {
        const img = document.createElement('img');
        img.src = String(w.src);
        img.alt = w.label || this._basename(w.src);
        img.loading = 'lazy';
        img.draggable = false;
        thumb.appendChild(img);
      } else {
        thumb.classList.add('is-empty');
        thumb.textContent = '?';
      }

      const main = document.createElement('div');
      main.className = 'ms-lsd-wall-main';

      const title = document.createElement('div');
      title.className = 'ms-lsd-wall-title';
      title.textContent = `${w.label || this._basename(w.src || 'wallpaper')}${isPreviewing ? ' · preview' : ''}`;

      const path = document.createElement('div');
      path.className = 'ms-lsd-wall-path';
      path.textContent = String(w.src || '');

      main.appendChild(title);
      main.appendChild(path);

      const controls = document.createElement('div');
      controls.className = 'ms-lsd-wall-controls';
      controls.addEventListener('click', (ev) => ev.stopPropagation());

      const pin = document.createElement('input');
      pin.type = 'checkbox';
      pin.title = 'Pin as first load wallpaper';
      pin.checked = !!w.pinToFirstLoad;
      pin.addEventListener('change', () => {
        wallpapers.forEach((x, i) => {
          x.pinToFirstLoad = (i === index) ? pin.checked : false;
        });
        this._renderWallpaperList();
      });

      const up = this._button('↑', () => {
        if (index <= 0) return;
        [wallpapers[index - 1], wallpapers[index]] = [wallpapers[index], wallpapers[index - 1]];
        this._renderWallpaperList();
      });

      const down = this._button('↓', () => {
        if (index >= wallpapers.length - 1) return;
        [wallpapers[index], wallpapers[index + 1]] = [wallpapers[index + 1], wallpapers[index]];
        this._renderWallpaperList();
      });

      const remove = this._button('✕', () => {
        const removedId = String(w.id || '');
        wallpapers.splice(index, 1);
        if (removedId && removedId === String(this._previewWallpaperId || '')) {
          this._previewWallpaperId = null;
          this._ensurePreviewWallpaperId();
        }
        this._renderWallpaperList();
        this._renderPreview();
      }, true);

      controls.append(pin, up, down, remove);
      row.append(thumb, main, controls);
      listEl.appendChild(row);
    });
  }

  _renderElementList() {
    const listEl = this.refs.elementList;
    if (!listEl) return;

    const elements = this.state.config.layout.elements || [];
    listEl.innerHTML = '';

    // Panel backdrop row — always at top so users can select/toggle the panel
    const panelCfg = this.state.config.layout.panel || {};
    {
      const row = document.createElement('div');
      row.className = `ms-lsd-element-row ${this.selectedElementId === '__panel__' ? 'is-selected' : ''}`;
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.ms-lsd-element-controls, input, button')) return;
        this._handleElementSelect('__panel__', ev);
        this._renderElementList();
        this._renderInspector();
        this._renderPreview();
        this._renderAlignToolbar();
      });

      const left = document.createElement('div');
      left.className = 'ms-lsd-element-left';

      const name = document.createElement('div');
      name.className = 'ms-lsd-element-name';
      name.textContent = 'Panel Backdrop';
      name.style.fontWeight = '600';

      const meta = document.createElement('div');
      meta.className = 'ms-lsd-element-meta';
      meta.textContent = `x:${num(panelCfg.x, 50).toFixed(1)} y:${num(panelCfg.y, 50).toFixed(1)} w:${panelCfg.widthPx || 440}px`;

      left.append(name, meta);

      const controls = document.createElement('div');
      controls.className = 'ms-lsd-element-controls';
      controls.addEventListener('click', (ev) => ev.stopPropagation());

      const vis = document.createElement('input');
      vis.type = 'checkbox';
      vis.checked = panelCfg.visible !== false;
      vis.title = 'Visible';
      vis.addEventListener('change', () => {
        panelCfg.visible = vis.checked;
        this._markLayoutCustomized();
        this._renderPreview();
        this._renderElementList();
      });

      controls.append(vis);
      row.append(left, controls);
      listEl.appendChild(row);
    }

    if (elements.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ms-lsd-empty';
      empty.textContent = 'No elements. Add one.';
      listEl.appendChild(empty);
      return;
    }

    for (const element of elements) {
      const row = document.createElement('div');
      row.className = `ms-lsd-element-row ${this._elementSelectionClass(element.id)}`;
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.ms-lsd-element-controls, input, button')) return;
        this._handleElementSelect(element.id, ev);
        this._renderElementList();
        this._renderInspector();
        this._renderPreview();
        this._renderAlignToolbar();
      });

      const left = document.createElement('div');
      left.className = 'ms-lsd-element-left';

      const name = document.createElement('div');
      name.className = 'ms-lsd-element-name';
      name.textContent = `${element.type} (${element.id})`;

      const meta = document.createElement('div');
      meta.className = 'ms-lsd-element-meta';
      meta.textContent = `x:${num(element.position?.x, 0).toFixed(1)} y:${num(element.position?.y, 0).toFixed(1)} anchor:${element.anchor || 'center'}`;

      left.append(name, meta);

      const controls = document.createElement('div');
      controls.className = 'ms-lsd-element-controls';
      controls.addEventListener('click', (ev) => ev.stopPropagation());

      const vis = document.createElement('input');
      vis.type = 'checkbox';
      vis.checked = element.visible !== false;
      vis.title = 'Visible';
      vis.addEventListener('change', () => {
        element.visible = vis.checked;
        this._markLayoutCustomized();
        this._renderPreview();
        this._renderElementList();
      });

      const remove = this._button('✕', (ev) => {
        ev?.stopPropagation?.();
        const idx = elements.findIndex((e) => e.id === element.id);
        if (idx >= 0) elements.splice(idx, 1);
        this._markLayoutCustomized();
        if (this.selectedElementId === element.id) {
          this.selectedElementId = elements[0]?.id || null;
        }
        this.selectedElementIds.delete(element.id);
        if (this.selectedElementIds.size === 0 && this.selectedElementId) {
          this.selectedElementIds.add(this.selectedElementId);
        }
        this._renderAll();
      }, true);

      controls.append(vis, remove);
      row.append(left, controls);
      listEl.appendChild(row);
    }
  }

  _renderPreview() {
    const layer = this.refs.previewLayer;
    if (!layer) return;

    layer.innerHTML = '';
    layer.style.background = this.state.config.style.backgroundColor || 'rgba(0,0,0,1)';

    // Wallpaper preview — composer picks which entry to show (runtime rotation unchanged).
    const wall = this._resolvePreviewWallpaper();
    if (wall?.src) {
      const img = document.createElement('img');
      img.src = wall.src;
      img.alt = wall.label || 'Wallpaper';
      img.className = 'ms-lsd-live-wallpaper';
      img.style.objectFit = String(this.state.config.wallpapers?.fit || 'cover');
      layer.appendChild(img);
    }

    // Wallpaper overlay
    if (this.state.config.wallpapers.overlay?.enabled) {
      const overlay = document.createElement('div');
      overlay.className = 'ms-lsd-live-wallpaper-overlay';
      overlay.style.background = this.state.config.wallpapers.overlay.color || 'rgba(0,0,0,0.45)';
      overlay.style.pointerEvents = 'none';
      layer.appendChild(overlay);
    }

    // Overlay effects (vignette, scanlines, grain)
    for (const effect of (this.state.config.overlayEffects || [])) {
      if (!effect || effect.enabled === false) continue;
      const type = String(effect.type || '');
      const intensity = clamp(Number(effect.intensity) || 0, 0, 1);
      if (!type || intensity <= 0) continue;

      if (type === 'vignette') {
        const node = document.createElement('div');
        node.className = 'ms-lsd-live-effect';
        node.style.opacity = `${intensity}`;
        node.style.background = `radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, ${String(effect.color || 'rgba(0,0,0,0.75)')} 100%)`;
        layer.appendChild(node);
      } else if (type === 'scanlines') {
        const node = document.createElement('div');
        node.className = 'ms-lsd-live-effect';
        node.style.opacity = `${Math.max(0.05, intensity * 0.55)}`;
        node.style.background = 'repeating-linear-gradient(0deg, rgba(0,0,0,0.15) 0px, rgba(0,0,0,0.15) 1px, transparent 1px, transparent 3px)';
        layer.appendChild(node);
      } else if (type === 'grain') {
        const node = document.createElement('div');
        node.className = 'ms-lsd-live-effect';
        node.style.opacity = `${Math.max(0.03, intensity * 0.25)}`;
        node.style.mixBlendMode = 'overlay';
        node.style.backgroundSize = '128px';
        node.style.background = "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";
        layer.appendChild(node);
      }
    }

    // Panel backdrop — interactive: can be selected and dragged
    const panelCfg = this.state.config.layout.panel || {};
    if (panelCfg.visible !== false) {
      const panel = document.createElement('div');
      panel.className = `ms-lsd-live-panel ${this.selectedElementId === '__panel__' ? 'is-selected' : ''}`;
      panel.style.left = `${num(panelCfg.x, 50)}%`;
      panel.style.top = `${num(panelCfg.y, 50)}%`;
      const panelWidthCss = String(panelCfg.widthCss || '').trim();
      panel.style.width = panelWidthCss || `min(${Math.max(120, num(panelCfg.widthPx, 440))}px, calc(100vw - 40px))`;
      panel.style.padding = panelCfg.padding || '24px 22px';
      panel.style.background = this.state.config.style.panelBackground || 'rgba(10,10,14,0.7)';
      panel.style.border = this.state.config.style.panelBorder || '1px solid rgba(255,255,255,0.12)';
      panel.style.borderRadius = `${Math.max(0, num(this.state.config.style.panelRadiusPx, 14))}px`;
      panel.style.backdropFilter = `blur(${Math.max(0, num(this.state.config.style.panelBlurPx, 14))}px)`;
      panel.style.boxShadow = this.state.config.style.panelShadow || '0 12px 48px rgba(0,0,0,0.6)';
      panel.style.fontFamily = `'${this.state.config.style.bodyFont || 'Signika'}', sans-serif`;
      panel.style.color = this.state.config.style.textColor || 'rgba(255,255,255,0.92)';

      // Click to select panel; drag to reposition
      panel.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._handleElementSelect('__panel__', ev);
        this._renderElementList();
        this._renderInspector();
        this._renderPreview();
        this._renderAlignToolbar();
      });
      panel.addEventListener('mousedown', (ev) => {
        if (ev.target.closest('.ms-lsd-resize-handle')) return;
        this._startDragPanel(ev);
      });
      if (this.selectedElementId === '__panel__') {
        this._appendResizeHandles(panel, panelCfg, 'panel');
      }
      layer.appendChild(panel);
    }

    // Elements — positioned on the full viewport
    const globalFont = this.state.config.style.bodyFont || 'Signika';
    const globalTextColor = this.state.config.style.textColor || 'rgba(255,255,255,0.92)';

    for (const element of this.state.config.layout.elements || []) {
      if (element.visible === false) continue;

      const node = document.createElement('div');
      node.className = `ms-lsd-live-element ${this._elementSelectionClass(element.id)}`;
      node.dataset.elementId = element.id;
      node.style.left = `${num(element.position?.x, 50)}%`;
      node.style.top = `${num(element.position?.y, 50)}%`;
      node.style.fontSize = element.style?.fontSize || '';
      node.style.fontWeight = element.style?.fontWeight || '';
      node.style.color = element.style?.color || globalTextColor;
      node.style.fontFamily = element.style?.fontFamily
        ? `'${element.style.fontFamily}', sans-serif`
        : `'${globalFont}', sans-serif`;
      node.style.textShadow = element.style?.textShadow || '';
      node.style.textAlign = String(element.style?.textAlign || 'left');
      node.style.letterSpacing = element.style?.letterSpacing || '';
      node.style.lineHeight = element.style?.lineHeight || '';

      const widthCss = String(element.style?.widthCss || '').trim();
      const maxWidthCss = String(element.style?.maxWidthCss || '').trim();
      const minWidthCss = String(element.style?.minWidthCss || '').trim();
      const widthPx = Number(element.style?.widthPx);
      const maxWidthPx = Number(element.style?.maxWidthPx);
      const minWidthPx = Number(element.style?.minWidthPx);
      if (widthCss) node.style.width = widthCss;
      if (maxWidthCss) node.style.maxWidth = maxWidthCss;
      if (minWidthCss) node.style.minWidth = minWidthCss;
      if (Number.isFinite(widthPx) && widthPx > 0) node.style.width = `${Math.max(1, widthPx)}px`;
      if (Number.isFinite(maxWidthPx) && maxWidthPx > 0) node.style.maxWidth = `${Math.max(16, maxWidthPx)}px`;
      if (Number.isFinite(minWidthPx) && minWidthPx > 0) node.style.minWidth = `${Math.max(1, minWidthPx)}px`;
      const heightPx = Number(element.style?.heightPx);
      if (Number.isFinite(heightPx) && heightPx > 0) {
        node.style.height = `${Math.max(1, heightPx)}px`;
        node.style.boxSizing = 'border-box';
      }

      const whiteSpace = String(element.style?.whiteSpace || '').trim();
      const textLikeType = isTextLikeType(element.type);
      const hasBlockWidth = (Number.isFinite(widthPx) && widthPx > 0) || (Number.isFinite(maxWidthPx) && maxWidthPx > 0);
      if (whiteSpace && whiteSpace !== 'auto') node.style.whiteSpace = whiteSpace;
      else if (textLikeType && hasBlockWidth) node.style.whiteSpace = 'normal';

      if (element.type === 'progress-bar') {
        node.classList.add('ms-lsd-live-progress');
        const progressWidthCss = String(element.props?.widthCss || '').trim();
        node.style.width = progressWidthCss || `${Math.max(80, num(element.props?.widthPx, 280))}px`;
        node.style.height = `${Math.max(2, num(element.props?.heightPx, 6))}px`;
        node.style.borderRadius = `${Math.max(0, num(element.props?.radiusPx, 999))}px`;

        const track = document.createElement('div');
        track.className = 'ms-lsd-live-progress-track';
        const fill = document.createElement('div');
        fill.className = 'ms-lsd-live-progress-fill';
        fill.style.width = '62%';
        fill.style.background = `linear-gradient(90deg, ${this.state.config.style.accentColor || '#00b4ff'}, ${this.state.config.style.secondaryAccentColor || '#8c64ff'})`;
        track.appendChild(fill);
        node.appendChild(track);
      } else if (element.type === 'spinner') {
        // IMPORTANT: Rotation animation uses `transform`, which would override the
        // anchor transform applied to the positioned element. Keep anchoring on the
        // wrapper and rotation on an inner node.
        node.classList.add('ms-lsd-live-spinner-wrap');
        const sizeCss = String(element.props?.sizeCss || '').trim();
        const size = Math.max(10, num(element.props?.sizePx, 30));
        node.style.width = sizeCss || `${size}px`;
        node.style.height = sizeCss || `${size}px`;

        const spinner = document.createElement('div');
        spinner.className = 'ms-lsd-live-spinner';
        spinner.style.width = '100%';
        spinner.style.height = '100%';
        spinner.style.borderTopColor = this.state.config.style.accentColor || '#00b4ff';
        node.appendChild(spinner);
      } else if (element.type === 'scene-name') {
        node.textContent = `${element.props?.prefix || 'Loading '}${this._getPreviewSceneDisplayName()}`;
      } else if (element.type === 'message') {
        node.textContent = element.props?.text || 'Loading assets…';
      } else if (element.type === 'percentage') {
        node.textContent = '62%';
      } else if (element.type === 'timer') {
        node.textContent = '2.8s';
      } else if (element.type === 'stage-pills') {
        node.classList.add('ms-lsd-live-stage-row');

        // Stage-pill container settings (editable in inspector)
        const containerEnabled = element.props?.containerEnabled !== false;
        const padY = Math.max(0, num(element.props?.containerPaddingYpx, 8));
        const padX = Math.max(0, num(element.props?.containerPaddingXpx, 12));
        const radius = Math.max(0, num(element.props?.containerRadiusPx, 999));
        const maxWidthCss = String(element.props?.maxWidthCss || '').trim();
        const maxWidthPx = Math.max(240, num(element.props?.maxWidthPx, 1200));

        node.style.width = 'max-content';
        // Keep full width in preview so placement matches the largest runtime footprint.
        node.style.maxWidth = maxWidthCss || `${maxWidthPx}px`;
        node.style.padding = containerEnabled ? `${padY}px ${padX}px` : '0';
        node.style.borderRadius = containerEnabled ? `${radius}px` : '0';
        node.style.background = containerEnabled
          ? String(element.props?.containerBackground || 'rgba(6,10,20,0.62)')
          : 'transparent';
        node.style.border = containerEnabled
          ? String(element.props?.containerBorder || '1px solid rgba(120,160,255,0.24)')
          : 'none';

        const stageAlign = String(element.style?.textAlign || 'center').toLowerCase();
        node.style.justifyContent = stageAlign === 'right' ? 'flex-end' : stageAlign === 'center' ? 'center' : 'flex-start';

        // Use realistic stage labels so wrapping/fit behavior is visible in editor
        [
          'Discovering assets',
          'Cataloging batches',
          'Loading textures',
          'Uploading GPU data',
          'Bootstrapping effects',
          'Core effects',
          'Dependency effects',
          'Wiring effects',
          'Token systems',
          'Floor layers',
          'Movement systems',
          'Interaction graph',
          'Camera systems',
          'Syncing scene',
          'UI bootstrap',
          'Control panels',
          'Preparing scene',
          'Compiling shaders',
          'Final polish',
          'Ready',
        ].forEach((label, idx) => {
          const pill = document.createElement('span');
          pill.className = `ms-lsd-live-pill ${idx < 13 ? 'is-done' : idx === 17 ? 'is-active' : 'is-pending'}`;
          pill.textContent = label;
          node.appendChild(pill);
        });
      } else if (element.type === 'image') {
        const img = document.createElement('img');
        img.className = 'ms-lsd-live-image';
        img.src = element.props?.src || '';
        const imgWidthCss = String(element.props?.widthCss || '').trim();
        const imgHeightCss = String(element.props?.heightCss || '').trim();
        img.style.maxWidth = imgWidthCss || `${Math.max(16, num(element.props?.widthPx, 90))}px`;
        img.style.maxHeight = imgHeightCss || `${Math.max(16, num(element.props?.heightPx, 90))}px`;
        node.appendChild(img);
      } else if (element.type === 'custom-html') {
        node.innerHTML = String(element.props?.html || '<em>Custom HTML</em>');
      } else if (element.type === 'loading-hints') {
        const hints = getAllLoadingHints().filter((h) => h.enabled !== false);
        const sample = hints[0]?.text || element.props?.emptyText || 'Loading hint preview…';
        const prefix = String(element.props?.prefix ?? 'Tip: ');
        node.textContent = `${prefix}${sample}`;
        node.style.fontStyle = String(element.style?.fontStyle || 'italic');
      } else {
        node.textContent = String(element.props?.text || element.type);
      }

      node.addEventListener('mousedown', (ev) => {
        if (ev.target.closest('.ms-lsd-resize-handle')) return;
        this._startDragElement(ev, element.id);
      });
      node.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._handleElementSelect(element.id, ev);
        this._renderElementList();
        this._renderInspector();
        this._renderPreview();
        this._renderAlignToolbar();
      });

      if (this.selectedElementId === element.id) {
        this._appendResizeHandles(node, element, 'element');
      }

      this._applyAnchor(node, element.anchor || 'center');

      layer.appendChild(node);
    }
  }

  /**
   * Render safe-region guides on the full-screen preview.
   * Shows a dashed rectangle representing the safe area for a given aspect ratio,
   * so elements won't end up off-screen on monitors with different ratios.
   */
  _renderSafeGuides() {
    const guides = this.refs.safeGuides;
    if (!guides) return;
    guides.innerHTML = '';

    const ratios = [
      { label: '4:3', w: 4, h: 3 },
      { label: '16:10', w: 16, h: 10 },
      { label: '16:9', w: 16, h: 9 },
      { label: '21:9', w: 21, h: 9 },
    ];

    const selected = this._safeRatio || 'none';
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const viewAspect = viewW / viewH;

    for (const r of ratios) {
      if (r.label !== selected && selected !== 'all') continue;
      const targetAspect = r.w / r.h;

      let safeW, safeH;
      if (targetAspect < viewAspect) {
        // Target is narrower than viewport — constrain width
        safeH = viewH;
        safeW = viewH * targetAspect;
      } else {
        // Target is wider — constrain height
        safeW = viewW;
        safeH = viewW / targetAspect;
      }

      const left = (viewW - safeW) / 2;
      const top = (viewH - safeH) / 2;

      const rect = document.createElement('div');
      rect.className = 'ms-lsd-safe-rect';
      rect.style.left = `${left}px`;
      rect.style.top = `${top}px`;
      rect.style.width = `${safeW}px`;
      rect.style.height = `${safeH}px`;

      const label = document.createElement('span');
      label.className = 'ms-lsd-safe-label';
      label.textContent = r.label;
      rect.appendChild(label);

      guides.appendChild(rect);
    }
  }

  _renderInspector() {
    const wrap = this.refs.inspector;
    if (!wrap) return;

    wrap.innerHTML = '';

    // Panel backdrop inspector
    if (this.selectedElementId === '__panel__') {
      this._renderPanelInspector(wrap);
      this._renderGlobalStyleInspector(wrap);
      return;
    }

    const element = (this.state.config.layout.elements || []).find((e) => e.id === this.selectedElementId) || null;

    if (!element) {
      const empty = document.createElement('div');
      empty.className = 'ms-lsd-empty';
      empty.textContent = 'Select an element in the list or preview to edit it.';
      wrap.appendChild(empty);
      return;
    }

    wrap.appendChild(this._fieldLabel(`Editing: ${element.type} (${element.id})`, true));

    wrap.appendChild(this._inputRow('Visible', this._checkbox(element.visible !== false, (v) => {
      element.visible = v;
      this._markLayoutCustomized();
      this._renderElementList();
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Type', this._select([
      'text', 'scene-name', 'message', 'progress-bar', 'spinner', 'percentage', 'timer', 'stage-pills', 'image', 'custom-html', 'subtitle', 'loading-hints'
    ], element.type, (v) => {
      element.type = v;
      this._renderElementList();
      this._renderPreview();
      this._renderInspector();
    })));

    wrap.appendChild(this._inputRow('Anchor', this._select([
      'center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center', 'center-left', 'center-right'
    ], element.anchor || 'center', (v) => {
      element.anchor = v;
      this._renderPreview();
      this._renderElementList();
    })));

    wrap.appendChild(this._inputRow('X %', this._number(element.position?.x || 50, 0, 100, 0.1, (v) => {
      element.position.x = clamp(v, 0, 100);
      this._renderPreview();
      this._renderElementList();
    })));

    wrap.appendChild(this._inputRow('Y %', this._number(element.position?.y || 50, 0, 100, 0.1, (v) => {
      element.position.y = clamp(v, 0, 100);
      this._renderPreview();
      this._renderElementList();
    })));

    this._renderElementLayoutHelpers(wrap, element);

    if (['text', 'message', 'subtitle'].includes(element.type)) {
      const value = String(element.props?.text || '');
      wrap.appendChild(this._inputRow('Text', this._text(value, (v) => {
        element.props.text = v;
        this._renderPreview();
      })));
    }

    if (element.type === 'scene-name') {
      wrap.appendChild(this._inputRow('Prefix', this._text(String(element.props?.prefix || 'Loading '), (v) => {
        element.props.prefix = v;
        this._renderPreview();
      })));

      const hint = document.createElement('div');
      hint.className = 'ms-lsd-empty';
      hint.textContent = 'Uses scene Navigation Name first, then scene name if Navigation Name is empty.';
      wrap.appendChild(hint);
    }

    if (element.type === 'custom-html') {
      wrap.appendChild(this._inputRow('HTML', this._textarea(String(element.props?.html || ''), (v) => {
        element.props.html = v;
        this._renderPreview();
      })));
    }

    if (element.type === 'image') {
      wrap.appendChild(this._inputRow('Image URL', this._text(String(element.props?.src || ''), (v) => {
        element.props.src = v;
        this._renderPreview();
      })));
      wrap.appendChild(this._inputRow('Width px', this._number(num(element.props?.widthPx, 90), 16, 2000, 1, (v) => {
        element.props.widthPx = Math.max(16, v);
        this._renderPreview();
      })));
      wrap.appendChild(this._inputRow('Height px', this._number(num(element.props?.heightPx, 90), 16, 2000, 1, (v) => {
        element.props.heightPx = Math.max(16, v);
        this._renderPreview();
      })));
      wrap.appendChild(this._inputRow('Pick file', this._button('Browse…', async () => {
        const src = await this._pickFilePath();
        if (!src) return;
        element.props.src = src;
        this._renderInspector();
        this._renderPreview();
      })));
    }

    if (element.type === 'spinner') {
      wrap.appendChild(this._inputRow('Size px', this._number(num(element.props?.sizePx, 30), 10, 400, 1, (v) => {
        element.props.sizePx = Math.max(10, v);
        this._renderPreview();
      })));
    }

    if (element.type === 'progress-bar') {
      wrap.appendChild(this._inputRow('Width px', this._number(num(element.props?.widthPx, 360), 80, 2500, 1, (v) => {
        element.props.widthPx = Math.max(80, v);
        this._renderPreview();
      })));
      wrap.appendChild(this._inputRow('Height px', this._number(num(element.props?.heightPx, 6), 2, 80, 1, (v) => {
        element.props.heightPx = Math.max(2, v);
        this._renderPreview();
      })));
      wrap.appendChild(this._inputRow('Radius px', this._number(num(element.props?.radiusPx, 999), 0, 999, 1, (v) => {
        element.props.radiusPx = Math.max(0, v);
        this._renderPreview();
      })));
    }

    if (element.type === 'loading-hints') {
      wrap.appendChild(this._fieldLabel('Loading Hints', true));
      wrap.appendChild(this._inputRow('Manage hints', this._button('Open Hint Editor…', async () => {
        await this.manager.openHintsDialog();
        this._renderPreview();
      })));
      wrap.appendChild(this._inputRow('Prefix', this._text(String(element.props?.prefix ?? 'Tip: '), (v) => {
        element.props.prefix = v;
        this._renderPreview();
      })));
      wrap.appendChild(this._inputRow('Interval sec', this._number(num(element.props?.intervalMs, 10000) / 1000, 2, 120, 0.5, (v) => {
        element.props.intervalMs = Math.round(Math.max(2, v) * 1000);
      })));
      wrap.appendChild(this._inputRow('Fade ms', this._number(num(element.props?.fadeMs, 600), 0, 4000, 50, (v) => {
        element.props.fadeMs = Math.max(0, v);
      })));
      wrap.appendChild(this._inputRow('Random order', this._checkbox(element.props?.shuffle !== false, (v) => {
        element.props.shuffle = v;
      })));
      wrap.appendChild(this._inputRow('Empty pool text', this._text(String(element.props?.emptyText || ''), (v) => {
        element.props.emptyText = v;
        this._renderPreview();
      })));
    }

    if (element.type === 'stage-pills') {
      wrap.appendChild(this._fieldLabel('Pill Container'));

      wrap.appendChild(this._inputRow('Show box', this._checkbox(element.props?.containerEnabled !== false, (v) => {
        element.props.containerEnabled = v;
        this._renderPreview();
      })));

      wrap.appendChild(this._inputRow('Max width px', this._number(num(element.props?.maxWidthPx, 1200), 240, 3000, 1, (v) => {
        element.props.maxWidthPx = Math.max(240, v);
        this._renderPreview();
      })));

      wrap.appendChild(this._inputRow('Pad X px', this._number(num(element.props?.containerPaddingXpx, 12), 0, 96, 1, (v) => {
        element.props.containerPaddingXpx = Math.max(0, v);
        this._renderPreview();
      })));

      wrap.appendChild(this._inputRow('Pad Y px', this._number(num(element.props?.containerPaddingYpx, 8), 0, 64, 1, (v) => {
        element.props.containerPaddingYpx = Math.max(0, v);
        this._renderPreview();
      })));

      wrap.appendChild(this._inputRow('Radius px', this._number(num(element.props?.containerRadiusPx, 999), 0, 999, 1, (v) => {
        element.props.containerRadiusPx = Math.max(0, v);
        this._renderPreview();
      })));

      wrap.appendChild(this._inputRow('BG', this._text(String(element.props?.containerBackground || 'rgba(6,10,20,0.62)'), (v) => {
        element.props.containerBackground = v;
        this._renderPreview();
      })));

      wrap.appendChild(this._inputRow('Border', this._text(String(element.props?.containerBorder || '1px solid rgba(120,160,255,0.24)'), (v) => {
        element.props.containerBorder = v;
        this._renderPreview();
      })));
    }

    wrap.appendChild(this._fieldLabel('Style'));

    wrap.appendChild(this._inputRow('Font family', this._fontFamilyEditor(element.style?.fontFamily || '', (v) => {
      element.style.fontFamily = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Font size', this._text(String(element.style?.fontSize || ''), (v) => {
      element.style.fontSize = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Font weight', this._text(String(element.style?.fontWeight || ''), (v) => {
      element.style.fontWeight = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Color', this._color(String(element.style?.color || '#ffffff'), (v) => {
      element.style.color = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Text shadow', this._text(String(element.style?.textShadow || ''), (v) => {
      element.style.textShadow = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Text align', this._select([
      'left', 'center', 'right'
    ], String(element.style?.textAlign || 'left'), (v) => {
      element.style.textAlign = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Width px', this._number(num(element.style?.widthPx, 0), 0, 3000, 1, (v) => {
      if (v <= 0) delete element.style.widthPx;
      else element.style.widthPx = Math.max(1, v);
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Height px', this._number(num(element.style?.heightPx, 0), 0, 3000, 1, (v) => {
      if (v <= 0) delete element.style.heightPx;
      else element.style.heightPx = Math.max(1, v);
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Max width px', this._number(num(element.style?.maxWidthPx, 0), 0, 3000, 1, (v) => {
      if (v <= 0) delete element.style.maxWidthPx;
      else element.style.maxWidthPx = Math.max(16, v);
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('White-space', this._select([
      'auto', 'normal', 'nowrap', 'pre-line'
    ], String(element.style?.whiteSpace || 'auto'), (v) => {
      if (v === 'auto') delete element.style.whiteSpace;
      else element.style.whiteSpace = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._fieldLabel('Animation'));

    wrap.appendChild(this._inputRow('Entrance', this._select([
      'fade-in', 'fade-in-up', 'fade-in-down', 'fade-in-left', 'fade-in-right', 'scale-in', 'blur-in', 'clip-reveal-up', 'clip-reveal-left', 'clip-reveal-center', 'typewriter', 'glitch-in', 'none'
    ], String(element.animation?.entrance?.type || 'fade-in'), (v) => {
      if (v === 'none') element.animation.entrance = null;
      else {
        element.animation.entrance = {
          ...(element.animation?.entrance || {}),
          type: v,
          duration: num(element.animation?.entrance?.duration, 600),
          delay: num(element.animation?.entrance?.delay, 0),
          easing: String(element.animation?.entrance?.easing || 'ease-out'),
        };
      }
    })));

    wrap.appendChild(this._inputRow('Ambient', this._select([
      'none', 'pulse', 'float', 'float-rotate', 'spin', 'glow-pulse'
    ], String(element.animation?.ambient?.type || 'none'), (v) => {
      if (v === 'none') element.animation.ambient = null;
      else {
        element.animation.ambient = {
          ...(element.animation?.ambient || {}),
          type: v,
          duration: num(element.animation?.ambient?.duration, 3000),
          easing: String(element.animation?.ambient?.easing || 'ease-in-out'),
        };
      }
      this._renderPreview();
    })));

    this._renderGlobalStyleInspector(wrap);
  }

  _renderPanelInspector(wrap) {
    const panel = this.state.config.layout.panel;
    const style = this.state.config.style || {};

    wrap.appendChild(this._fieldLabel('Panel Backdrop', true));

    wrap.appendChild(this._inputRow('Visible', this._checkbox(panel.visible !== false, (v) => {
      panel.visible = v;
      this._markLayoutCustomized();
      this._renderPreview();
      this._renderElementList();
    })));

    wrap.appendChild(this._inputRow('X %', this._number(num(panel.x, 50), 0, 100, 0.1, (v) => {
      panel.x = clamp(v, 0, 100);
      this._renderPreview();
      this._renderElementList();
    })));

    wrap.appendChild(this._inputRow('Y %', this._number(num(panel.y, 50), 0, 100, 0.1, (v) => {
      panel.y = clamp(v, 0, 100);
      this._renderPreview();
      this._renderElementList();
    })));

    wrap.appendChild(this._inputRow('Width px', this._number(num(panel.widthPx, 440), 120, 1400, 1, (v) => {
      panel.widthPx = Math.max(120, v);
      this._renderPreview();
      this._renderElementList();
    })));

    wrap.appendChild(this._inputRow('Padding', this._text(String(panel.padding || '24px 22px'), (v) => {
      panel.padding = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._fieldLabel('Panel Style'));

    wrap.appendChild(this._inputRow('Background', this._text(String(style.panelBackground || 'rgba(10,10,14,0.7)'), (v) => {
      style.panelBackground = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Border', this._text(String(style.panelBorder || '1px solid rgba(255,255,255,0.12)'), (v) => {
      style.panelBorder = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Radius px', this._number(num(style.panelRadiusPx, 14), 0, 100, 1, (v) => {
      style.panelRadiusPx = Math.max(0, v);
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Blur px', this._number(num(style.panelBlurPx, 14), 0, 80, 1, (v) => {
      style.panelBlurPx = Math.max(0, v);
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Shadow', this._text(String(style.panelShadow || '0 12px 48px rgba(0,0,0,0.6)'), (v) => {
      style.panelShadow = v;
      this._renderPreview();
    })));
  }

  _renderGlobalStyleInspector(wrap) {
    const style = this.state.config.style || {};

    wrap.appendChild(this._fieldLabel('Global Theme', true));
    wrap.appendChild(this._inputRow('Theme name', this._text(String(this.state.config.themeName || ''), (v) => {
      this.state.config.themeName = v;
    })));

    wrap.appendChild(this._inputRow('Background', this._color(String(style.backgroundColor || '#000000'), (v) => {
      style.backgroundColor = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Accent', this._color(String(style.accentColor || '#00b4ff'), (v) => {
      style.accentColor = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Accent 2', this._color(String(style.secondaryAccentColor || '#8c64ff'), (v) => {
      style.secondaryAccentColor = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Panel BG', this._text(String(style.panelBackground || 'rgba(10,10,14,0.7)'), (v) => {
      style.panelBackground = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Panel border', this._text(String(style.panelBorder || '1px solid rgba(255,255,255,0.12)'), (v) => {
      style.panelBorder = v;
      this._renderPreview();
    })));

    wrap.appendChild(this._inputRow('Primary font', this._fontFamilyEditor(String(style.primaryFont || ''), (v) => {
      style.primaryFont = v;
    })));

    wrap.appendChild(this._inputRow('Body font', this._fontFamilyEditor(String(style.bodyFont || ''), (v) => {
      style.bodyFont = v;
      this._renderPreview();
    })));

    const familiesRaw = Array.isArray(this.state.config.fonts?.googleFamilies)
      ? this.state.config.fonts.googleFamilies.join(', ')
      : '';

    wrap.appendChild(this._inputRow('Google families', this._textarea(familiesRaw, (v) => {
      const list = String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
      this.state.config.fonts.googleFamilies = list;
    }, 2)));

    const elements = this.state.config.layout.elements || [];
    const sceneNameElement = elements.find((e) => e?.type === 'scene-name') || null;
    wrap.appendChild(this._inputRow('Include scene name', this._checkbox(!!sceneNameElement && sceneNameElement.visible !== false, (v) => {
      let sceneEl = elements.find((e) => e?.type === 'scene-name') || null;
      if (v) {
        if (!sceneEl) {
          sceneEl = {
            id: `scene-name-${Date.now()}`,
            type: 'scene-name',
            visible: true,
            position: { x: 12, y: 16 },
            anchor: 'top-left',
            props: { prefix: 'Loading ' },
            style: { fontSize: '13px', color: 'rgba(255,255,255,0.5)' },
            animation: { entrance: { type: 'fade-in', duration: 400, delay: 180, easing: 'ease-out' }, ambient: null },
          };
          elements.push(sceneEl);
        }
        sceneEl.visible = true;
      } else if (sceneEl) {
        sceneEl.visible = false;
        if (this.selectedElementId === sceneEl.id) this.selectedElementId = '__panel__';
      }

      this._renderPreview();
      this._renderElementList();
      this._renderInspector();
    })));

    const panel = this.state.config.layout.panel;
    wrap.appendChild(this._inputRow('Panel visible', this._checkbox(panel.visible !== false, (v) => {
      panel.visible = v;
      this._renderPreview();
    })));
    wrap.appendChild(this._inputRow('Panel X %', this._number(num(panel.x, 50), 0, 100, 0.1, (v) => {
      panel.x = clamp(v, 0, 100);
      this._renderPreview();
    })));
    wrap.appendChild(this._inputRow('Panel Y %', this._number(num(panel.y, 50), 0, 100, 0.1, (v) => {
      panel.y = clamp(v, 0, 100);
      this._renderPreview();
    })));
    wrap.appendChild(this._inputRow('Panel width px', this._number(num(panel.widthPx, 440), 120, 1400, 1, (v) => {
      panel.widthPx = Math.max(120, v);
      this._renderPreview();
    })));
  }

  _getPreviewSceneDisplayName() {
    try {
      const activeScene = canvas?.scene || game?.scenes?.viewed || game?.scenes?.current || null;
      const navName = String(activeScene?.navName || '').trim();
      if (navName) return navName;
      const sceneName = String(activeScene?.name || '').trim();
      if (sceneName) return sceneName;
    } catch (_) {
    }
    return 'Scene';
  }

  _elementSelectionClass(elementId) {
    if (this.selectedElementId === elementId) return 'is-selected';
    if (this.selectedElementIds.has(elementId)) return 'is-selected-secondary';
    return '';
  }

  _clearSelection() {
    this.selectedElementId = null;
    this.selectedElementIds.clear();
  }

  _handleElementSelect(elementId, ev) {
    const elements = this.state.config.layout.elements || [];
    const orderedIds = elements.map((e) => e.id);

    if (elementId === '__panel__') {
      this.selectedElementId = '__panel__';
      this.selectedElementIds.clear();
      return;
    }

    if (ev?.shiftKey && this.selectedElementId && this.selectedElementId !== '__panel__') {
      const anchorIdx = orderedIds.indexOf(this.selectedElementId);
      const targetIdx = orderedIds.indexOf(elementId);
      if (anchorIdx >= 0 && targetIdx >= 0) {
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        this.selectedElementIds = new Set(orderedIds.slice(start, end + 1));
        this.selectedElementId = elementId;
        return;
      }
    }

    if (ev?.ctrlKey || ev?.metaKey) {
      if (this.selectedElementId === '__panel__') {
        this.selectedElementIds.clear();
      }
      if (this.selectedElementIds.has(elementId)) {
        this.selectedElementIds.delete(elementId);
        if (this.selectedElementId === elementId) {
          this.selectedElementId = [...this.selectedElementIds][0] || null;
        }
      } else {
        this.selectedElementIds.add(elementId);
        this.selectedElementId = elementId;
      }
      if (this.selectedElementIds.size === 0) {
        this.selectedElementIds.add(elementId);
        this.selectedElementId = elementId;
      }
      return;
    }

    this.selectedElementId = elementId;
    this.selectedElementIds = new Set([elementId]);
  }

  _collectPreviewEntries(selectedIds = null) {
    const layer = this.refs.previewLayer;
    if (!layer) return [];

    const layerRect = layer.getBoundingClientRect();
    const elements = this.state.config.layout.elements || [];
    const ids = selectedIds || [...this.selectedElementIds];
    const entries = [];

    for (const id of ids) {
      const element = elements.find((e) => e && String(e.id) === String(id));
      const node = layer.querySelector(`[data-element-id="${CSS.escape(String(id))}"]`);
      if (!element || !node || element.visible === false) continue;
      entries.push({
        element,
        rect: rectRelativeToLayer(node.getBoundingClientRect(), layerRect),
      });
    }

    return entries;
  }

  _resolveDragPosition(rawX, rawY, moveEvent, draggingId = null) {
    const altHeld = !!moveEvent?.altKey;
    let x = rawX;
    let y = rawY;
    let guides = {};

    if (!altHeld && this._alignmentPrefs.snapEnabled !== false) {
      const targets = buildSnapTargets({
        layout: this.state.config.layout,
        draggingId,
        includePanel: draggingId !== '__panel__',
      });
      const threshold = snapThresholdForStrength(this._alignmentPrefs.snapStrength);
      const snapped = resolveAxisSnap(x, y, targets, threshold);
      x = snapped.x;
      y = snapped.y;
      guides = snapped.guides;

      if (!guides.vertical && !guides.horizontal) {
        const snapStep = Math.max(0, Number(this._dragSnapPct) || 0);
        if (snapStep > 0) {
          x = snapToStep(x, snapStep);
          y = snapToStep(y, snapStep);
        }
      }
    } else if (!altHeld) {
      const snapStep = Math.max(0, Number(this._dragSnapPct) || 0);
      if (snapStep > 0) {
        x = snapToStep(x, snapStep);
        y = snapToStep(y, snapStep);
      }
    }

    this._renderAlignmentGuides(guides);
    return { x: clamp(x, 0, 100), y: clamp(y, 0, 100) };
  }

  _renderAlignmentGuides(guides = {}, { flash = false } = {}) {
    const container = this.refs.alignmentGuides;
    if (!container) return;

    if (this._alignmentGuideTimer && !flash) {
      clearTimeout(this._alignmentGuideTimer);
      this._alignmentGuideTimer = null;
    }

    container.innerHTML = '';
    const layer = this.refs.previewLayer;
    const layerRect = layer?.getBoundingClientRect();
    const viewW = Math.max(1, layerRect?.width || window.innerWidth);
    const viewH = Math.max(1, layerRect?.height || window.innerHeight);

    const addLine = (orientation, pct, isAxis = false) => {
      const line = document.createElement('div');
      line.className = `ms-lsd-align-line ms-lsd-align-line--${orientation === 'vertical' ? 'v' : 'h'}${isAxis ? ' is-axis' : ''}${flash ? ' is-flash' : ''}`;
      if (orientation === 'vertical') {
        line.style.left = `${(Number(pct) / 100) * viewW}px`;
      } else {
        line.style.top = `${(Number(pct) / 100) * viewH}px`;
      }
      container.appendChild(line);
    };

    if (Number.isFinite(guides.vertical)) addLine('vertical', guides.vertical, false);
    if (Number.isFinite(guides.horizontal)) addLine('horizontal', guides.horizontal, false);
  }

  _clearAlignmentGuides() {
    if (this._alignmentGuideTimer) {
      clearTimeout(this._alignmentGuideTimer);
      this._alignmentGuideTimer = null;
    }
    if (this.refs.alignmentGuides) this.refs.alignmentGuides.innerHTML = '';
    this._renderPersistentAxes();
  }

  _flashAlignmentGuides(guides = {}) {
    this._renderAlignmentGuides(guides, { flash: true });
    if (this._alignmentGuideTimer) clearTimeout(this._alignmentGuideTimer);
    this._alignmentGuideTimer = window.setTimeout(() => {
      this._alignmentGuideTimer = null;
      this._clearAlignmentGuides();
    }, 600);
  }

  _renderPersistentAxes() {
    if (this.drag || !this._alignmentPrefs.axesEnabled) {
      if (!this.drag && this.refs.alignmentGuides && !this._alignmentGuideTimer) {
        this.refs.alignmentGuides.innerHTML = '';
      }
      return;
    }

    this._renderAlignmentGuides({ vertical: 50, horizontal: 50 });
    const container = this.refs.alignmentGuides;
    if (!container) return;
    for (const line of container.querySelectorAll('.ms-lsd-align-line')) {
      line.classList.add('is-axis');
    }
  }

  _renderAlignToolbar() {
    const wrap = this.refs.alignToolbar;
    if (!wrap) return;

    wrap.innerHTML = '';
    const count = this.selectedElementIds.size;
    if (count < 2 || this.selectedElementId === '__panel__') {
      wrap.classList.remove('is-visible');
      return;
    }

    wrap.classList.add('is-visible');

    const title = document.createElement('div');
    title.className = 'ms-lsd-align-toolbar-title';
    title.textContent = `Align Selection (${count})`;
    wrap.appendChild(title);

    wrap.appendChild(this._inputRow('Align', this._buttonGroup([
      { label: 'Left', onClick: () => this._applyAlignSelection('left') },
      { label: 'Center', onClick: () => this._applyAlignSelection('center') },
      { label: 'Right', onClick: () => this._applyAlignSelection('right') },
    ])));

    wrap.appendChild(this._inputRow('Vertical', this._buttonGroup([
      { label: 'Top', onClick: () => this._applyAlignSelection('top') },
      { label: 'Middle', onClick: () => this._applyAlignSelection('middle') },
      { label: 'Bottom', onClick: () => this._applyAlignSelection('bottom') },
    ])));

    wrap.appendChild(this._inputRow('Distribute', this._buttonGroup([
      { label: 'Horiz', onClick: () => this._applyAlignSelection('distribute-h') },
      { label: 'Vert', onClick: () => this._applyAlignSelection('distribute-v') },
    ])));

    wrap.appendChild(this._inputRow('Center on', this._buttonGroup([
      { label: 'Canvas', onClick: () => this._applyAlignSelection('center-canvas') },
      { label: 'Panel', onClick: () => this._applyAlignSelection('center-panel') },
    ])));
  }

  _applyAlignSelection(action) {
    const layer = this.refs.previewLayer;
    if (!layer) return;

    const layerRect = layer.getBoundingClientRect();
    const entries = this._collectPreviewEntries();
    if (entries.length < 2 && !String(action || '').startsWith('center-')) return;

    if (action === 'left' || action === 'center' || action === 'right') {
      alignEntries(entries, layerRect.width, layerRect.height, action);
    } else if (action === 'top' || action === 'middle' || action === 'bottom') {
      alignEntries(entries, layerRect.width, layerRect.height, action);
    } else if (action === 'distribute-h') {
      distributeEntries(entries, layerRect.width, layerRect.height, 'horizontal');
    } else if (action === 'distribute-v') {
      distributeEntries(entries, layerRect.width, layerRect.height, 'vertical');
    } else if (action === 'center-canvas') {
      centerEntriesOn(entries, layerRect.width, layerRect.height, { x: 50, y: 50 });
    } else if (action === 'center-panel') {
      const panel = this.state.config.layout.panel || {};
      centerEntriesOn(entries, layerRect.width, layerRect.height, {
        x: num(panel.x, 50),
        y: num(panel.y, 50),
      });
    } else {
      return;
    }

    this._markLayoutCustomized();
    this._flashAlignmentGuides({ vertical: 50, horizontal: 50 });
    this._renderPreview();
    this._renderElementList();
    this._renderInspector();
    this._renderAlignToolbar();
  }

  _bindKeyboardNudge() {
    if (this._onKeyDown) return;
    this._onKeyDown = (ev) => {
      if (!this.visible) return;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.key)) return;

      const tag = String(ev.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (ev.target?.isContentEditable) return;

      ev.preventDefault();
      const step = ev.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (ev.key === 'ArrowLeft') dx = -step;
      else if (ev.key === 'ArrowRight') dx = step;
      else if (ev.key === 'ArrowUp') dy = -step;
      else if (ev.key === 'ArrowDown') dy = step;
      this._nudgeSelection(dx, dy);
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  _unbindKeyboardNudge() {
    if (!this._onKeyDown) return;
    window.removeEventListener('keydown', this._onKeyDown);
    this._onKeyDown = null;
  }

  _nudgeSelection(dxPx, dyPx) {
    const layer = this.refs.previewLayer;
    if (!layer || (!dxPx && !dyPx)) return;

    const layerRect = layer.getBoundingClientRect();
    const dxPct = (dxPx / Math.max(1, layerRect.width)) * 100;
    const dyPct = (dyPx / Math.max(1, layerRect.height)) * 100;

    if (this.selectedElementId === '__panel__') {
      const panel = this.state?.config?.layout?.panel;
      if (!panel) return;
      panel.x = clamp(num(panel.x, 50) + dxPct, 0, 100);
      panel.y = clamp(num(panel.y, 50) + dyPct, 0, 100);
      this._markLayoutCustomized();
      this._renderPreview();
      this._renderElementList();
      this._renderInspector();
      return;
    }

    const ids = this.selectedElementIds.size > 0
      ? [...this.selectedElementIds]
      : (this.selectedElementId ? [this.selectedElementId] : []);
    if (!ids.length) return;

    const elements = this.state.config.layout.elements || [];
    for (const id of ids) {
      const element = elements.find((e) => e && String(e.id) === String(id));
      if (!element?.position) continue;
      element.position.x = clamp(num(element.position.x, 50) + dxPct, 0, 100);
      element.position.y = clamp(num(element.position.y, 50) + dyPct, 0, 100);
    }

    this._markLayoutCustomized();
    this._renderPreview();
    this._renderElementList();
    this._renderInspector();
    this._renderAlignToolbar();
  }

  _appendResizeHandles(node, target, kind = 'element') {
    if (!node || !target) return;

    const wrap = document.createElement('div');
    wrap.className = 'ms-lsd-resize-handles';
    wrap.addEventListener('mousedown', (ev) => ev.stopPropagation());
    wrap.addEventListener('click', (ev) => ev.stopPropagation());

    for (const handle of RESIZE_HANDLES) {
      if (kind === 'panel' && (handle === 'n' || handle === 's')) continue;

      const hit = document.createElement('div');
      hit.className = `ms-lsd-resize-handle ms-lsd-resize-handle--${handle}`;
      hit.dataset.handle = handle;
      hit.style.cursor = cursorForHandle(handle);
      hit.title = `Resize ${handle.toUpperCase()}`;
      hit.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (kind === 'panel') this._startResizePanel(ev, target, handle, node);
        else this._startResizeElement(ev, target, handle, node);
      });
      wrap.appendChild(hit);
    }

    node.appendChild(wrap);
  }

  _syncElementNodeLayout(node, element) {
    if (!node || !element) return;

    node.style.left = `${num(element.position?.x, 50)}%`;
    node.style.top = `${num(element.position?.y, 50)}%`;

    const type = String(element.type || 'text');
    if (type === 'progress-bar') {
      node.style.width = `${Math.max(80, num(element.props?.widthPx, 280))}px`;
      node.style.height = `${Math.max(2, num(element.props?.heightPx, 6))}px`;
    } else if (type === 'spinner') {
      const size = Math.max(10, num(element.props?.sizePx, 30));
      node.style.width = `${size}px`;
      node.style.height = `${size}px`;
    } else if (type === 'image') {
      const img = node.querySelector('img');
      if (img) {
        const w = Math.max(16, num(element.props?.widthPx, 90));
        const h = Math.max(16, num(element.props?.heightPx, 90));
        img.style.maxWidth = `${w}px`;
        img.style.maxHeight = `${h}px`;
        node.style.width = `${w}px`;
        node.style.height = `${h}px`;
      }
    } else if (type === 'stage-pills') {
      node.style.maxWidth = `${Math.max(240, num(element.props?.maxWidthPx, 1200))}px`;
      const padY = Math.max(0, num(element.props?.containerPaddingYpx, 8));
      const padX = Math.max(0, num(element.props?.containerPaddingXpx, 12));
      node.style.padding = `${padY}px ${padX}px`;
    } else {
      if (Number.isFinite(element.style?.widthPx) && element.style.widthPx > 0) {
        node.style.width = `${Math.max(1, element.style.widthPx)}px`;
      }
      if (Number.isFinite(element.style?.heightPx) && element.style.heightPx > 0) {
        node.style.height = `${Math.max(1, element.style.heightPx)}px`;
        node.style.boxSizing = 'border-box';
      }
    }

    this._applyAnchor(node, element.anchor || 'center');
  }

  _syncPanelNodeLayout(node, panelCfg) {
    if (!node || !panelCfg) return;
    node.style.left = `${num(panelCfg.x, 50)}%`;
    node.style.top = `${num(panelCfg.y, 50)}%`;
    node.style.width = `min(${Math.max(120, num(panelCfg.widthPx, 440))}px, calc(100vw - 40px))`;
  }

  _scheduleDragUiRefresh() {
    /* Inspector/list refresh deferred to mouseup via _finishDragInteraction for smoother drags. */
  }

  _finishDragInteraction() {
    if (this._dragRenderRaf) {
      cancelAnimationFrame(this._dragRenderRaf);
      this._dragRenderRaf = null;
    }
    this._renderPreview();
    this._renderElementList();
    this._renderInspector();
    this._renderAlignToolbar();
  }

  _startResizeElement(ev, element, handle, node) {
    const layer = this.refs.previewLayer;
    if (!layer || !element?.position || !node) return;

    this.selectedElementId = element.id;
    this.selectedElementIds = new Set([element.id]);

    const layerRect = layer.getBoundingClientRect();
    const startRect = measureElementRect(node.getBoundingClientRect(), layerRect);
    this.drag = { kind: 'resize-element', element, node, handle, layerRect, startRect };

    const onMove = (moveEvent) => {
      if (!this.drag || this.drag.kind !== 'resize-element') return;
      const px = moveEvent.clientX - layerRect.left;
      const py = moveEvent.clientY - layerRect.top;
      const rect = computeResizedRect(this.drag.startRect, handle, px, py);
      applyRectToElement(element, rect, element.anchor || 'center', layerRect.width, layerRect.height, handle);
      const liveNode = this._getPreviewElementNode(element.id) || node;
      this._syncElementNodeLayout(liveNode, element);
    };

    const onUp = () => {
      delete element._resizeAxis;
      this.drag = null;
      this._markLayoutCustomized();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      this._finishDragInteraction();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  _startResizePanel(ev, panelCfg, handle, node) {
    const layer = this.refs.previewLayer;
    if (!layer || !panelCfg || !node) return;

    this.selectedElementId = '__panel__';
    this.selectedElementIds.clear();

    const layerRect = layer.getBoundingClientRect();
    const startRect = measureElementRect(node.getBoundingClientRect(), layerRect);
    this.drag = { kind: 'resize-panel', panelCfg, node, handle, layerRect, startRect };

    const onMove = (moveEvent) => {
      if (!this.drag || this.drag.kind !== 'resize-panel') return;
      const px = moveEvent.clientX - layerRect.left;
      const rect = computePanelResizeRect(this.drag.startRect, handle, px);
      if (!rect) return;
      applyRectToPanel(panelCfg, rect, layerRect.width, layerRect.height);
      const liveNode = layer.querySelector('.ms-lsd-live-panel') || node;
      this._syncPanelNodeLayout(liveNode, panelCfg);
    };

    const onUp = () => {
      this.drag = null;
      this._markLayoutCustomized();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      this._finishDragInteraction();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  _getPreviewElementNode(elementId) {
    const layer = this.refs.previewLayer;
    if (!layer || !elementId) return null;
    return layer.querySelector(`[data-element-id="${CSS.escape(String(elementId))}"]`);
  }

  _highlightPreviewSelection() {
    const layer = this.refs.previewLayer;
    if (!layer) return;

    for (const node of layer.querySelectorAll('.ms-lsd-live-element')) {
      const id = node.dataset.elementId;
      node.classList.remove('is-selected', 'is-selected-secondary');
      const cls = this._elementSelectionClass(id);
      if (cls) node.classList.add(cls);
    }

    const panel = layer.querySelector('.ms-lsd-live-panel');
    if (panel) {
      panel.classList.toggle('is-selected', this.selectedElementId === '__panel__');
    }
  }

  _updateDraggedElementPosition(elementId, x, y) {
    const element = (this.state.config.layout.elements || []).find((e) => e.id === elementId);
    const node = this._getPreviewElementNode(elementId);
    if (!element?.position || !node) return null;

    element.position.x = x;
    element.position.y = y;
    node.style.left = `${x}%`;
    node.style.top = `${y}%`;
    this._applyAnchor(node, element.anchor || 'center');
    return node;
  }

  _updateDraggedPanelPosition(x, y) {
    const panelCfg = this.state.config.layout.panel;
    const layer = this.refs.previewLayer;
    const panelNode = layer?.querySelector('.ms-lsd-live-panel');
    if (!panelCfg || !panelNode) return null;

    panelCfg.x = x;
    panelCfg.y = y;
    panelNode.style.left = `${x}%`;
    panelNode.style.top = `${y}%`;
    return panelNode;
  }

  _startDragElement(ev, elementId) {
    ev.preventDefault();
    ev.stopPropagation();

    const layer = this.refs.previewLayer;
    if (!layer) return;

    const element = (this.state.config.layout.elements || []).find((e) => e.id === elementId);
    if (!element) return;

    this.selectedElementId = elementId;
    if (!ev?.ctrlKey && !ev?.metaKey && !ev?.shiftKey) {
      this.selectedElementIds = new Set([elementId]);
    } else {
      this.selectedElementIds.add(elementId);
    }

    // The preview layer covers the full viewport, so use its bounding rect
    // (which equals the window size) for coordinate mapping.
    const rect = layer.getBoundingClientRect();
    this.drag = { kind: 'move-element', element, rect, draggingId: elementId };

    const onMove = (moveEvent) => {
      if (!this.drag || this.drag.kind !== 'move-element') return;
      const rawX = ((moveEvent.clientX - rect.left) / Math.max(1, rect.width)) * 100;
      const rawY = ((moveEvent.clientY - rect.top) / Math.max(1, rect.height)) * 100;
      const next = this._resolveDragPosition(rawX, rawY, moveEvent, elementId);
      this._updateDraggedElementPosition(elementId, next.x, next.y);
    };

    const onUp = () => {
      this.drag = null;
      this._clearAlignmentGuides();
      this._markLayoutCustomized();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      this._finishDragInteraction();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    this._highlightPreviewSelection();
    const liveNode = this._getPreviewElementNode(elementId);
    if (liveNode && !liveNode.querySelector('.ms-lsd-resize-handles')) {
      this._appendResizeHandles(liveNode, element, 'element');
    }
    this._renderElementList();
    this._renderInspector();
  }

  _startDragPanel(ev) {
    ev.preventDefault();
    ev.stopPropagation();

    const layer = this.refs.previewLayer;
    if (!layer) return;

    const panelCfg = this.state.config.layout.panel;
    if (!panelCfg) return;

    this.selectedElementId = '__panel__';
    this.selectedElementIds.clear();

    const rect = layer.getBoundingClientRect();
    this.drag = { kind: 'move-panel', panel: panelCfg, rect, draggingId: '__panel__' };

    const onMove = (moveEvent) => {
      if (!this.drag || this.drag.kind !== 'move-panel') return;
      const rawX = ((moveEvent.clientX - rect.left) / Math.max(1, rect.width)) * 100;
      const rawY = ((moveEvent.clientY - rect.top) / Math.max(1, rect.height)) * 100;
      const next = this._resolveDragPosition(rawX, rawY, moveEvent, '__panel__');
      this._updateDraggedPanelPosition(next.x, next.y);
    };

    const onUp = () => {
      this.drag = null;
      this._clearAlignmentGuides();
      this._markLayoutCustomized();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      this._finishDragInteraction();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    this._highlightPreviewSelection();
    const panelNode = layer.querySelector('.ms-lsd-live-panel');
    if (panelNode && !panelNode.querySelector('.ms-lsd-resize-handles')) {
      this._appendResizeHandles(panelNode, panelCfg, 'panel');
    }
    this._renderElementList();
    this._renderInspector();
  }

  async _applyChanges() {
    this._markLayoutCustomized();
    this.state.config = normalizeLoadingScreenConfig(this.state.config);

    // Auto-switch to styled mode when saving from the composer so the user's
    // edits actually take effect at runtime instead of silently using legacy.
    if (this.state.mode === 'legacy') {
      this.state.mode = 'styled';
      if (this.refs.modeSelect) this.refs.modeSelect.value = 'styled';
    }

    // Ensure the loading screen is enabled when explicitly saving
    this.state.enabled = true;
    if (this.refs.enabledCheckbox) this.refs.enabledCheckbox.checked = true;

    await this.manager.saveRuntimeState({
      enabled: this.state.enabled,
      mode: this.state.mode,
      applyTo: this.state.applyTo,
      googleFontsEnabled: this.state.googleFontsEnabled,
      useFoundryDefault: this.state.useFoundryDefault,
      activePresetId: this.state.activePresetId,
      config: this.state.config,
    });

    console.log('Map Shine: loading screen settings saved', { mode: this.state.mode, enabled: this.state.enabled });
    this._status('Saved loading screen settings (mode: styled).');
  }

  _addElement() {
    const id = `el-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const element = {
      id,
      type: 'text',
      visible: true,
      // Left-anchored by default so new elements are easier to line up.
      position: { x: 12, y: 16 },
      anchor: 'top-left',
      props: { text: 'New Element' },
      style: {
        fontSize: '14px',
        color: '#ffffff',
      },
      animation: {
        entrance: { type: 'fade-in', duration: 400, delay: 0, easing: 'ease-out' },
        ambient: null,
      },
    };

    this.state.config.layout.elements.push(element);
    this._markLayoutCustomized();
    this.selectedElementId = id;
    this.selectedElementIds = new Set([id]);
  }

  _addHintsElement() {
    const elements = this.state.config.layout.elements || [];
    if (elements.some((e) => String(e?.type || '') === 'loading-hints')) {
      this._status('This layout already has a Loading Hints element.');
      return;
    }

    const id = `hints-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const element = {
      id,
      type: 'loading-hints',
      visible: true,
      position: { x: 50, y: 78 },
      anchor: 'center',
      props: {
        prefix: 'Tip: ',
        intervalMs: 10000,
        fadeMs: 600,
        shuffle: true,
        emptyText: 'Add loading hints via the Hint Editor.',
      },
      style: {
        fontSize: 'clamp(12px, 0.95vw, 14px)',
        fontStyle: 'italic',
        color: 'rgba(196,223,255,0.82)',
        textAlign: 'center',
        maxWidthCss: 'min(640px, 86vw)',
      },
      animation: {
        entrance: { type: 'fade-in', duration: 500, delay: 420, easing: 'ease-out' },
        ambient: null,
      },
    };

    this.state.config.layout.elements.push(element);
    this._markLayoutCustomized();
    this.selectedElementId = id;
    this.selectedElementIds = new Set([id]);
    this._status('Added Loading Hints element — open Hint Editor to add tips.');
  }

  _markLayoutCustomized() {
    if (!this.state?.config) return;
    this.state.config.layoutCustomized = true;
  }

  _renderElementLayoutHelpers(wrap, element) {
    if (!element) return;

    const elements = Array.isArray(this.state.config?.layout?.elements) ? this.state.config.layout.elements : [];
    const references = [
      { value: '__panel__', label: 'Panel backdrop' },
      ...elements
        .filter((e) => e && e.id && e.id !== element.id)
        .map((e) => ({ value: String(e.id), label: `${String(e.type || 'element')} (${String(e.id)})` })),
    ];

    if (!references.some((r) => r.value === this._layoutHelperRefId)) {
      this._layoutHelperRefId = '__panel__';
    }

    wrap.appendChild(this._fieldLabel('Layout Helpers'));

    wrap.appendChild(this._inputRow('Reference', this._selectOptions(references, this._layoutHelperRefId, (v) => {
      this._layoutHelperRefId = String(v || '__panel__');
    })));

    wrap.appendChild(this._inputRow('Gap %', this._number(num(this._layoutHelperGapPct, 1.5), 0, 30, 0.1, (v) => {
      this._layoutHelperGapPct = clamp(v, 0, 30);
    })));

    wrap.appendChild(this._inputRow('Nudge %', this._number(num(this._layoutHelperNudgePct, 0.5), 0.05, 10, 0.05, (v) => {
      this._layoutHelperNudgePct = clamp(v, 0.05, 10);
    })));

    wrap.appendChild(this._inputRow('Drag snap %', this._number(num(this._dragSnapPct, 0.25), 0, 2, 0.05, (v) => {
      this._dragSnapPct = clamp(v, 0, 2);
    })));

    wrap.appendChild(this._inputRow('Align to ref', this._buttonGroup([
      { label: 'Match X', onClick: () => this._applyElementLayoutHelper(element, 'match-x') },
      { label: 'Match Y', onClick: () => this._applyElementLayoutHelper(element, 'match-y') },
      { label: 'Center', onClick: () => this._applyElementLayoutHelper(element, 'center-on-ref') },
      { label: 'Above', onClick: () => this._applyElementLayoutHelper(element, 'above') },
      { label: 'Below', onClick: () => this._applyElementLayoutHelper(element, 'below') },
    ])));

    wrap.appendChild(this._inputRow('Snap edge', this._buttonGroup([
      { label: 'Left', onClick: () => this._applyElementLayoutHelper(element, 'snap-left') },
      { label: 'Right', onClick: () => this._applyElementLayoutHelper(element, 'snap-right') },
      { label: 'Top', onClick: () => this._applyElementLayoutHelper(element, 'snap-top') },
      { label: 'Bottom', onClick: () => this._applyElementLayoutHelper(element, 'snap-bottom') },
    ])));

    wrap.appendChild(this._inputRow('Justify', this._buttonGroup([
      { label: 'Left', onClick: () => this._applyElementLayoutHelper(element, 'justify-left') },
      { label: 'Center', onClick: () => this._applyElementLayoutHelper(element, 'justify-center') },
      { label: 'Right', onClick: () => this._applyElementLayoutHelper(element, 'justify-right') },
    ])));

    wrap.appendChild(this._inputRow('Nudge', this._buttonGroup([
      { label: '←', onClick: () => this._applyElementLayoutHelper(element, 'nudge-left') },
      { label: '→', onClick: () => this._applyElementLayoutHelper(element, 'nudge-right') },
      { label: '↑', onClick: () => this._applyElementLayoutHelper(element, 'nudge-up') },
      { label: '↓', onClick: () => this._applyElementLayoutHelper(element, 'nudge-down') },
    ])));

    const hint = document.createElement('div');
    hint.className = 'ms-lsd-helper-hint';
    hint.textContent = 'Tip: hold Alt while dragging to disable snap. Arrow keys nudge 1px (Shift=10px). Ctrl/Cmd+click or Shift+click to multi-select.';
    wrap.appendChild(hint);
  }

  _getReferencePreviewRect(referenceId, currentElementId = null) {
    const layer = this.refs.previewLayer;
    if (!layer) return null;

    const layerRect = layer.getBoundingClientRect();
    const id = String(referenceId || '__panel__').trim() || '__panel__';

    if (id === '__panel__') {
      const node = layer.querySelector('.ms-lsd-live-panel');
      if (!node) {
        const panel = this.state?.config?.layout?.panel || {};
        return {
          kind: 'point',
          x: clamp(num(panel.x, 50), 0, 100),
          y: clamp(num(panel.y, 50), 0, 100),
        };
      }
      return { kind: 'rect', ...rectRelativeToLayer(node.getBoundingClientRect(), layerRect) };
    }

    if (String(currentElementId || '') === id) return null;
    const node = layer.querySelector(`[data-element-id="${CSS.escape(id)}"]`);
    if (!node) {
      const ref = this._resolveLayoutReference(id, currentElementId);
      return ref ? { kind: 'point', x: ref.x, y: ref.y } : null;
    }
    return { kind: 'rect', ...rectRelativeToLayer(node.getBoundingClientRect(), layerRect) };
  }

  _snapElementToReferenceEdge(element, edge) {
    const layer = this.refs.previewLayer;
    if (!layer || !element?.position) return null;

    const refRect = this._getReferencePreviewRect(this._layoutHelperRefId, element.id);
    if (!refRect) return null;

    const gapPx = (clamp(num(this._layoutHelperGapPct, 1.5), 0, 30) / 100) * layer.getBoundingClientRect().width;
    const layerRect = layer.getBoundingClientRect();
    const node = layer.querySelector(`[data-element-id="${CSS.escape(String(element.id))}"]`);
    if (!node) return null;

    const elRect = rectRelativeToLayer(node.getBoundingClientRect(), layerRect);
    let dxPx = 0;
    let dyPx = 0;
    let guides = {};

    if (refRect.kind === 'point') {
      const refXPx = (refRect.x / 100) * layerRect.width;
      const refYPx = (refRect.y / 100) * layerRect.height;
      if (edge === 'left') {
        dxPx = refXPx + gapPx - elRect.left;
        guides = { vertical: refRect.x };
      } else if (edge === 'right') {
        dxPx = refXPx - gapPx - elRect.right;
        guides = { vertical: refRect.x };
      } else if (edge === 'top') {
        dyPx = refYPx + gapPx - elRect.top;
        guides = { horizontal: refRect.y };
      } else if (edge === 'bottom') {
        dyPx = refYPx - gapPx - elRect.bottom;
        guides = { horizontal: refRect.y };
      } else {
        return null;
      }
    } else if (edge === 'left') {
      dxPx = refRect.left + gapPx - elRect.left;
      guides = { vertical: (refRect.left / layerRect.width) * 100 };
    } else if (edge === 'right') {
      dxPx = refRect.right - gapPx - elRect.right;
      guides = { vertical: (refRect.right / layerRect.width) * 100 };
    } else if (edge === 'top') {
      dyPx = refRect.top + gapPx - elRect.top;
      guides = { horizontal: (refRect.top / layerRect.height) * 100 };
    } else if (edge === 'bottom') {
      dyPx = refRect.bottom - gapPx - elRect.bottom;
      guides = { horizontal: (refRect.bottom / layerRect.height) * 100 };
    } else {
      return null;
    }

    element.position.x = clamp(num(element.position.x, 50) + (dxPx / layerRect.width) * 100, 0, 100);
    element.position.y = clamp(num(element.position.y, 50) + (dyPx / layerRect.height) * 100, 0, 100);
    return guides;
  }

  _applyElementLayoutHelper(element, action) {
    if (!element?.position) return;

    const ref = this._resolveLayoutReference(this._layoutHelperRefId, element.id);
    const gap = clamp(num(this._layoutHelperGapPct, 1.5), 0, 30);
    const nudge = clamp(num(this._layoutHelperNudgePct, 0.5), 0.05, 10);
    let flashGuides = null;

    if (action === 'match-x' && ref) {
      element.position.x = clamp(ref.x, 0, 100);
      flashGuides = { vertical: ref.x };
    } else if (action === 'match-y' && ref) {
      element.position.y = clamp(ref.y, 0, 100);
      flashGuides = { horizontal: ref.y };
    } else if (action === 'center-on-ref' && ref) {
      element.position.x = clamp(ref.x, 0, 100);
      element.position.y = clamp(ref.y, 0, 100);
      flashGuides = { vertical: ref.x, horizontal: ref.y };
    } else if (action === 'above' && ref) {
      element.position.y = clamp(ref.y - gap, 0, 100);
      flashGuides = { horizontal: ref.y };
    } else if (action === 'below' && ref) {
      element.position.y = clamp(ref.y + gap, 0, 100);
      flashGuides = { horizontal: ref.y };
    } else if (action === 'snap-left') {
      flashGuides = this._snapElementToReferenceEdge(element, 'left');
    } else if (action === 'snap-right') {
      flashGuides = this._snapElementToReferenceEdge(element, 'right');
    } else if (action === 'snap-top') {
      flashGuides = this._snapElementToReferenceEdge(element, 'top');
    } else if (action === 'snap-bottom') {
      flashGuides = this._snapElementToReferenceEdge(element, 'bottom');
    } else if (action === 'justify-left') {
      this._applyHorizontalJustification(element, 'left', ref?.x);
    } else if (action === 'justify-center') {
      this._applyHorizontalJustification(element, 'center', ref?.x);
    } else if (action === 'justify-right') {
      this._applyHorizontalJustification(element, 'right', ref?.x);
    } else if (action === 'nudge-left') {
      element.position.x = clamp(num(element.position?.x, 50) - nudge, 0, 100);
    } else if (action === 'nudge-right') {
      element.position.x = clamp(num(element.position?.x, 50) + nudge, 0, 100);
    } else if (action === 'nudge-up') {
      element.position.y = clamp(num(element.position?.y, 50) - nudge, 0, 100);
    } else if (action === 'nudge-down') {
      element.position.y = clamp(num(element.position?.y, 50) + nudge, 0, 100);
    } else {
      return;
    }

    this._markLayoutCustomized();
    if (flashGuides && (flashGuides.vertical != null || flashGuides.horizontal != null)) {
      this._flashAlignmentGuides(flashGuides);
    }
    this._renderPreview();
    this._renderElementList();
    this._renderInspector();
  }

  _resolveLayoutReference(referenceId, currentElementId = null) {
    const id = String(referenceId || '__panel__').trim() || '__panel__';
    if (id === '__panel__') {
      const panel = this.state?.config?.layout?.panel || {};
      return { x: clamp(num(panel.x, 50), 0, 100), y: clamp(num(panel.y, 50), 0, 100), id: '__panel__' };
    }

    const elements = Array.isArray(this.state?.config?.layout?.elements) ? this.state.config.layout.elements : [];
    const ref = elements.find((e) => e && String(e.id) === id && String(e.id) !== String(currentElementId || ''));
    if (!ref) return null;
    return {
      x: clamp(num(ref.position?.x, 50), 0, 100),
      y: clamp(num(ref.position?.y, 50), 0, 100),
      id,
    };
  }

  _applyHorizontalJustification(element, align, targetX = undefined) {
    if (!element) return;
    const nextAlign = (align === 'right' || align === 'center') ? align : 'left';

    const verticalBand = getAnchorVerticalBand(element.anchor);
    element.anchor = composeAnchor(verticalBand, nextAlign);
    if (!element.style || typeof element.style !== 'object') element.style = {};
    element.style.textAlign = nextAlign;

    if (Number.isFinite(targetX)) {
      element.position.x = clamp(Number(targetX), 0, 100);
    }
  }

  _button(label, onClick, danger = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ms-lsd-btn ${danger ? 'is-danger' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  _buttonGroup(defs) {
    const group = document.createElement('div');
    group.className = 'ms-lsd-btn-group';
    for (const def of defs || []) {
      if (!def || typeof def.onClick !== 'function') continue;
      const btn = this._button(String(def.label || 'Action'), (ev) => {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        def.onClick();
      }, !!def.danger);
      btn.classList.add('ms-lsd-btn--group');
      group.appendChild(btn);
    }
    return group;
  }

  _fieldLabel(text, isSection = false) {
    const label = document.createElement('div');
    label.className = isSection ? 'ms-lsd-inspector-section' : 'ms-lsd-inspector-label';
    label.textContent = text;
    return label;
  }

  _inputRow(labelText, inputEl) {
    const row = document.createElement('label');
    row.className = 'ms-lsd-input-row';

    const label = document.createElement('span');
    label.className = 'ms-lsd-input-label';
    label.textContent = labelText;

    const control = document.createElement('div');
    control.className = 'ms-lsd-input-control';
    control.appendChild(inputEl);

    row.append(label, control);
    return row;
  }

  _text(value, onChange) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ms-lsd-input';
    input.value = String(value || '');
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  _textarea(value, onChange, rows = 3) {
    const input = document.createElement('textarea');
    input.className = 'ms-lsd-input ms-lsd-textarea';
    input.rows = rows;
    input.value = String(value || '');
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  _number(value, min, max, step, onChange) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'ms-lsd-input';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step || 1);
    input.value = String(Number.isFinite(value) ? value : min);
    input.addEventListener('input', () => {
      const n = Number.parseFloat(input.value);
      if (!Number.isFinite(n)) return;
      onChange(n);
    });
    return input;
  }

  _select(options, current, onChange) {
    const select = document.createElement('select');
    select.className = 'ms-lsd-input';

    for (const optValue of options) {
      const option = document.createElement('option');
      option.value = String(optValue);
      option.textContent = String(optValue);
      select.appendChild(option);
    }

    select.value = String(current || options[0] || '');
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  _selectOptions(options, current, onChange) {
    const select = document.createElement('select');
    select.className = 'ms-lsd-input';

    for (const opt of options || []) {
      const option = document.createElement('option');
      option.value = String(opt?.value || '');
      option.textContent = String(opt?.label || opt?.value || '');
      select.appendChild(option);
    }

    select.value = String(current || options?.[0]?.value || '');
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  _checkbox(value, onChange) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'ms-lsd-checkbox';
    input.checked = !!value;
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  }

  _color(value, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ms-lsd-color-wrap';

    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'ms-lsd-color';
    input.value = normalizeColorHex(value || '#ffffff');

    const txt = document.createElement('input');
    txt.type = 'text';
    txt.className = 'ms-lsd-input';
    txt.value = String(value || '#ffffff');

    input.addEventListener('input', () => {
      txt.value = input.value;
      onChange(input.value);
    });

    txt.addEventListener('input', () => {
      const value = txt.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(value)) input.value = value;
      onChange(value);
    });

    wrap.append(input, txt);
    return wrap;
  }

  _fontFamilyEditor(value, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ms-lsd-font-wrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ms-lsd-input';
    input.value = String(value || '');

    const datalistId = `ms-lsd-fonts-${Math.random().toString(36).slice(2, 7)}`;
    const data = document.createElement('datalist');
    data.id = datalistId;

    for (const family of this._fontFamilies.slice(0, 400)) {
      const opt = document.createElement('option');
      opt.value = family;
      data.appendChild(opt);
    }

    input.setAttribute('list', datalistId);
    input.addEventListener('input', () => onChange(input.value));

    wrap.append(input, data);
    return wrap;
  }

  _status(message) {
    if (!this.refs.status) return;
    this.refs.status.textContent = String(message || '');
    this.refs.status.classList.add('is-visible');
    setTimeout(() => {
      if (!this.refs.status) return;
      this.refs.status.classList.remove('is-visible');
    }, 1800);
  }

  /**
   * Foundry Application / ApplicationV2 root element (handles jQuery-wrapped legacy apps).
   * @param {any} app
   * @returns {HTMLElement|null}
   */
  _applicationDomElement(app) {
    const el = app?.element;
    if (!el) return null;
    if (el instanceof HTMLElement) return el;
    if (typeof el.get === 'function') {
      const node = el.get(0);
      return node instanceof HTMLElement ? node : null;
    }
    const first = el[0];
    return first instanceof HTMLElement ? first : null;
  }

  /**
   * Loading Screen Composer uses a very high z-index overlay; Foundry FilePicker stacks
   * using Application z-order (much lower), so the picker would open behind this UI
   * until the composer closed. Force the picker above our overlay.
   * @param {any} picker
   */
  _elevateFilePickerAboveOverlay(picker) {
    if (!picker) return;
    // Fixed headroom above `.ms-lsd-overlay` (100050) and other Map Shine panels (~10000–100100).
    const z = '250000';
    try {
      picker.bringToTop?.();
      picker.bringToFront?.();
    } catch (_) {
    }
    const raw = picker.element;
    if (raw?.jquery && typeof raw.css === 'function') {
      try {
        raw.css('z-index', z);
      } catch (_) {
      }
    }
    const node = this._applicationDomElement(picker);
    if (node?.style) node.style.setProperty('z-index', z, 'important');
  }

  /**
   * While FilePicker is open, pull the composer overlay out of the way so the native
   * window stacks correctly even if we cannot target the picker's root node (e.g. some
   * ApplicationV2 hosts). Restored in {@link _endFilePickerStackingWorkaround}.
   */
  _beginFilePickerStackingWorkaround() {
    if (!this.container) return;
    const next = (this._filePickerStackDepth || 0) + 1;
    this._filePickerStackDepth = next;
    if (next > 1) return;
    this._filePickerStackSave = {
      z: this.container.style.zIndex,
      prio: this.container.style.getPropertyPriority('z-index'),
    };
    this.container.style.setProperty('z-index', '40', 'important');
  }

  _endFilePickerStackingWorkaround() {
    if (!this.container) return;
    const next = Math.max(0, (this._filePickerStackDepth || 0) - 1);
    this._filePickerStackDepth = next;
    if (next > 0) return;
    const save = this._filePickerStackSave;
    this._filePickerStackSave = null;
    if (!save) return;
    if (save.z) {
      this.container.style.zIndex = save.z;
      if (save.prio) this.container.style.setProperty('z-index', save.z, save.prio);
    } else {
      this.container.style.removeProperty('z-index');
    }
  }

  /**
   * Foundry confirm dialogs stack below the composer's high z-index overlay unless
   * we temporarily pull the overlay aside (same approach as FilePicker).
   * @param {{title?: string, content?: string}} config
   * @returns {Promise<boolean>}
   */
  async _confirmAboveOverlay(config = {}) {
    this._beginFilePickerStackingWorkaround();
    try {
      const title = String(config.title || 'Confirm');
      const content = String(config.content || '<p>Are you sure?</p>');
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (typeof DialogV2?.confirm === 'function') {
        const result = await DialogV2.confirm({
          window: { title },
          content,
          modal: true,
          rejectClose: false,
        });
        return result === true;
      }
      if (typeof Dialog?.confirm === 'function') {
        return await Dialog.confirm({
          title,
          content,
          yes: () => true,
          no: () => false,
          defaultYes: false,
        });
      }
      return globalThis.confirm(`${title}\n\n${content.replace(/<[^>]+>/g, '')}`);
    } finally {
      this._endFilePickerStackingWorkaround();
    }
  }

  async _pickFilePath() {
    try {
      const filePickerImpl = globalThis.foundry?.applications?.apps?.FilePicker?.implementation;
      const PickerCls = filePickerImpl ?? globalThis.FilePicker;
      if (!PickerCls) {
        const raw = prompt('Enter file path:');
        return String(raw || '').trim() || null;
      }

      return await new Promise((resolve) => {
        let settled = false;
        let closeApplicationHook = null;

        const finish = (path) => {
          if (settled) return;
          settled = true;
          if (closeApplicationHook && typeof Hooks?.off === 'function') {
            try {
              Hooks.off('closeApplication', closeApplicationHook);
            } catch (_) {
            }
            closeApplicationHook = null;
          }
          this._endFilePickerStackingWorkaround();
          resolve(path == null ? null : String(path || '').trim() || null);
        };

        try {
          this._beginFilePickerStackingWorkaround();

          const picker = new PickerCls({
            type: 'imagevideo',
            current: '',
            callback: (path) => finish(path),
          });

          const closeOrig = typeof picker.close === 'function' ? picker.close.bind(picker) : null;
          if (closeOrig) {
            picker.close = async (...args) => {
              const out = await closeOrig(...args);
              if (!settled) finish(null);
              return out;
            };
          } else if (typeof Hooks?.on === 'function') {
            closeApplicationHook = (app) => {
              if (app !== picker) return;
              if (!settled) finish(null);
            };
            Hooks.on('closeApplication', closeApplicationHook);
          }

          const elevate = () => this._elevateFilePickerAboveOverlay(picker);

          (async () => {
            try {
              if (typeof picker.render === 'function') {
                const ren = picker.render(true);
                if (ren && typeof ren.then === 'function') await ren;
              }
              if (typeof picker.browse === 'function') {
                const br = picker.browse();
                if (br && typeof br.then === 'function') await br;
              }
              if (typeof picker.render !== 'function' && typeof picker.browse !== 'function') {
                finish(null);
                return;
              }
            } catch (_) {
              finish(null);
              return;
            }
            elevate();
            queueMicrotask(elevate);
            requestAnimationFrame(() => {
              elevate();
              requestAnimationFrame(elevate);
            });
            for (const ms of [50, 150, 400, 800]) setTimeout(elevate, ms);
          })();
        } catch (_) {
          finish(null);
        }
      });
    } catch (_) {
      this._endFilePickerStackingWorkaround();
      return null;
    }
  }

  _basename(path) {
    const value = String(path || '');
    const i = value.lastIndexOf('/');
    return i >= 0 ? value.slice(i + 1) : value;
  }

  _applyAnchor(node, anchor) {
    const a = String(anchor || 'center');
    if (a === 'top-left') node.style.transform = 'translate(0, 0)';
    else if (a === 'top-right') node.style.transform = 'translate(-100%, 0)';
    else if (a === 'bottom-left') node.style.transform = 'translate(0, -100%)';
    else if (a === 'bottom-right') node.style.transform = 'translate(-100%, -100%)';
    else if (a === 'top-center') node.style.transform = 'translate(-50%, 0)';
    else if (a === 'bottom-center') node.style.transform = 'translate(-50%, -100%)';
    else if (a === 'center-left') node.style.transform = 'translate(0, -50%)';
    else if (a === 'center-right') node.style.transform = 'translate(-100%, -50%)';
    else node.style.transform = 'translate(-50%, -50%)';
  }

  _buildMarkup() {
    return `
      <!-- Full-screen live preview layer (behind the dialog) -->
      <div class="ms-lsd-live-preview" data-ref="preview-layer"></div>

      <!-- Safe-region guide overlays -->
      <div class="ms-lsd-safe-guides" data-ref="safe-guides"></div>

      <!-- Smart alignment guide overlays (Miro-style snap lines) -->
      <div class="ms-lsd-alignment-guides" data-ref="alignment-guides"></div>

      <!-- Floating dialog panel -->
      <div class="ms-lsd-floating" role="dialog" aria-label="Loading Screen Composer">

        <header class="ms-lsd-header">
          <h2>Loading Screen Composer</h2>
          <div class="ms-lsd-header-actions">
            <label class="ms-lsd-safe-select-label">Safe region
              <select data-ref="safe-ratio" class="ms-lsd-input ms-lsd-input--mini">
                <option value="none" selected>None</option>
                <option value="4:3">4:3</option>
                <option value="16:10">16:10</option>
                <option value="16:9">16:9</option>
                <option value="21:9">21:9</option>
                <option value="all">All</option>
              </select>
            </label>
            <label class="ms-lsd-safe-select-label" title="Snap to center lines and other elements while dragging">
              <input type="checkbox" data-ref="snap-enabled" checked /> Snap
            </label>
            <label class="ms-lsd-safe-select-label" title="Show viewport center crosshair">
              <input type="checkbox" data-ref="axes-enabled" /> Axes
            </label>
            <label class="ms-lsd-safe-select-label">Strength
              <select data-ref="snap-strength" class="ms-lsd-input ms-lsd-input--mini" title="Snap sensitivity">
                <option value="tight">Tight</option>
                <option value="normal" selected>Normal</option>
                <option value="loose">Loose</option>
              </select>
            </label>
            <button type="button" class="ms-lsd-btn" data-action="reset-default">Reset</button>
            <button type="button" class="ms-lsd-btn" data-action="close">Close</button>
          </div>
        </header>

        <section class="ms-lsd-topbar">
          <label><input type="checkbox" data-ref="enabled" /> Enabled</label>
          <label>Mode
            <select data-ref="mode" class="ms-lsd-input ms-lsd-input--mini">
              <option value="legacy">legacy</option>
              <option value="styled">styled</option>
              <option value="foundry">foundry</option>
            </select>
          </label>
          <label><input type="checkbox" data-ref="use-foundry" /> Foundry native</label>
          <label>Scope
            <select data-ref="apply-scope" class="ms-lsd-input ms-lsd-input--mini">
              <option value="all">all</option>
              <option value="startup-only">startup</option>
              <option value="transitions-only">transitions</option>
            </select>
          </label>
          <label><input type="checkbox" data-ref="google-fonts" /> Google Fonts</label>
        </section>

        <section class="ms-lsd-body">
          <div class="ms-lsd-sidebar">
            <details open>
              <summary class="ms-lsd-section-title">Presets</summary>
              <label class="ms-lsd-stack">
                <select data-ref="preset" class="ms-lsd-input"></select>
              </label>
              <label class="ms-lsd-stack">
                <input type="text" data-ref="preset-name" class="ms-lsd-input" placeholder="Save as…" />
              </label>
              <button type="button" class="ms-lsd-btn ms-lsd-btn--full" data-action="save-user-preset">Save User Preset</button>
              <button type="button" class="ms-lsd-btn ms-lsd-btn--full is-danger is-muted" data-action="delete-user-preset">Delete Selected User Preset</button>
              <div class="ms-lsd-list ms-lsd-user-preset-list" data-ref="user-preset-list"></div>
            </details>

            <details>
              <summary class="ms-lsd-section-title">Presentation</summary>
              <div class="ms-lsd-presentation-settings" data-ref="presentation-settings"></div>
            </details>

            <details open>
              <summary class="ms-lsd-section-title">Wallpapers</summary>
              <label class="ms-lsd-stack">
                Rotation
                <select data-ref="wallpaper-mode" class="ms-lsd-input">
                  <option value="single">Single (always first)</option>
                  <option value="sequential">Sequential (cycle each load)</option>
                  <option value="random">Random (weighted)</option>
                </select>
              </label>
              <label class="ms-lsd-stack">
                Fit
                <select data-ref="wallpaper-fit" class="ms-lsd-input">
                  <option value="cover">Cover</option>
                  <option value="contain">Contain</option>
                </select>
              </label>
              <div class="ms-lsd-list" data-ref="wallpaper-list"></div>
              <button type="button" class="ms-lsd-btn ms-lsd-btn--full" data-action="add-wallpaper">Add Wallpaper</button>
            </details>

            <details open>
              <summary class="ms-lsd-section-title">Elements</summary>
              <div class="ms-lsd-align-toolbar" data-ref="align-toolbar"></div>
              <div class="ms-lsd-list" data-ref="element-list"></div>
              <button type="button" class="ms-lsd-btn ms-lsd-btn--full" data-action="add-element">Add Element</button>
              <button type="button" class="ms-lsd-btn ms-lsd-btn--full" data-action="add-hints-element">Add Loading Hints</button>
              <button type="button" class="ms-lsd-btn ms-lsd-btn--full" data-action="manage-hints">Manage Hint Text…</button>
            </details>
          </div>

          <div class="ms-lsd-inspector-wrap">
            <div class="ms-lsd-section-title">Inspector</div>
            <div class="ms-lsd-inspector" data-ref="inspector"></div>
          </div>
        </section>

        <footer class="ms-lsd-footer">
          <div class="ms-lsd-status" data-ref="status"></div>
          <div class="ms-lsd-footer-actions">
            <button type="button" class="ms-lsd-btn" data-action="apply">Apply</button>
            <button type="button" class="ms-lsd-btn is-primary" data-action="save-close">Save + Close</button>
          </div>
        </footer>

      </div>
    `;
  }

  _installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* ===== Container: full-screen overlay that IS the preview ===== */
      .ms-lsd-overlay {
        position: fixed; inset: 0; z-index: 100050;
        background: transparent;
      }

      /* ===== Full-screen live preview layer ===== */
      .ms-lsd-live-preview {
        position: absolute; inset: 0; overflow: hidden;
        background: #000;
      }
      .ms-lsd-live-wallpaper {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: cover; pointer-events: none;
      }
      .ms-lsd-live-wallpaper-overlay {
        position: absolute; inset: 0; pointer-events: none;
      }
      .ms-lsd-live-effect {
        position: absolute; inset: 0; pointer-events: none;
      }
      .ms-lsd-live-panel {
        position: absolute; transform: translate(-50%, -50%);
        pointer-events: auto; cursor: move; user-select: none;
      }
      .ms-lsd-live-panel.is-selected {
        outline: 2px dashed rgba(255,180,60,0.85);
        outline-offset: 4px;
      }
      .ms-lsd-live-element {
        position: absolute; cursor: move; user-select: none;
        pointer-events: auto; white-space: nowrap; z-index: 1;
        transform-origin: center center;
      }
      .ms-lsd-live-element.is-selected {
        outline: 2px dashed rgba(110,200,255,0.85);
        outline-offset: 4px;
      }
      .ms-lsd-resize-handles {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 3;
      }
      .ms-lsd-resize-handle {
        position: absolute;
        width: 8px;
        height: 8px;
        background: #ffffff;
        border: 1px solid rgba(110, 200, 255, 0.95);
        border-radius: 1px;
        box-shadow: 0 0 4px rgba(0, 0, 0, 0.45);
        pointer-events: auto;
        z-index: 4;
      }
      .ms-lsd-resize-handle--n { top: 0; left: 50%; transform: translate(-50%, -50%); }
      .ms-lsd-resize-handle--s { bottom: 0; left: 50%; transform: translate(-50%, 50%); }
      .ms-lsd-resize-handle--e { right: 0; top: 50%; transform: translate(50%, -50%); }
      .ms-lsd-resize-handle--w { left: 0; top: 50%; transform: translate(-50%, -50%); }
      .ms-lsd-resize-handle--ne { top: 0; right: 0; transform: translate(50%, -50%); }
      .ms-lsd-resize-handle--nw { top: 0; left: 0; transform: translate(-50%, -50%); }
      .ms-lsd-resize-handle--se { bottom: 0; right: 0; transform: translate(50%, 50%); }
      .ms-lsd-resize-handle--sw { bottom: 0; left: 0; transform: translate(-50%, 50%); }
      .ms-lsd-live-spinner {
        width: 100%;
        height: 100%;
        border-radius: 999px;
        border: 2px solid rgba(255,255,255,0.2);
        border-top-color: #00b4ff;
        animation: msLsdSpin 0.85s linear infinite;
      }
      .ms-lsd-live-spinner-wrap {
        display: block;
      }
      .ms-lsd-live-progress { pointer-events: auto; }
      .ms-lsd-live-progress-track {
        width: 100%; height: 100%; border-radius: inherit;
        background: rgba(255,255,255,0.12); overflow: hidden;
      }
      .ms-lsd-live-progress-fill {
        height: 100%; width: 0%; border-radius: inherit;
        box-shadow: 0 0 8px rgba(0,180,255,0.35);
      }
      .ms-lsd-live-stage-row {
        display: flex;
        gap: 4px;
        row-gap: 5px;
        flex-wrap: wrap;
        justify-content: flex-start;
        align-items: center;
        box-sizing: border-box;
        white-space: normal;
      }
      .ms-lsd-live-pill {
        padding: 2px 6px; border-radius: 999px;
        font-size: 9.5px; font-weight: 600;
        line-height: 1.2;
      }
      .ms-lsd-live-pill.is-pending { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.5); }
      .ms-lsd-live-pill.is-active { background: rgba(0,180,255,0.2); color: rgba(0,220,255,0.95); }
      .ms-lsd-live-pill.is-done { background: rgba(100,220,140,0.18); color: rgba(140,255,180,0.95); }
      .ms-lsd-live-image { object-fit: contain; display: block; }

      /* ===== Safe-region guides ===== */
      .ms-lsd-safe-guides {
        position: absolute; inset: 0; pointer-events: none; z-index: 2;
      }
      .ms-lsd-safe-rect {
        position: absolute;
        border: 1px dashed rgba(255,200,0,0.45);
        box-sizing: border-box;
      }
      .ms-lsd-safe-label {
        position: absolute; top: 2px; left: 6px;
        font-size: 10px; font-weight: 600;
        color: rgba(255,200,0,0.65);
        font-family: 'Consolas', 'Monaco', monospace;
        text-shadow: 0 1px 3px rgba(0,0,0,0.8);
      }

      /* ===== Alignment snap guides ===== */
      .ms-lsd-alignment-guides {
        position: absolute; inset: 0; pointer-events: none; z-index: 3;
      }
      .ms-lsd-align-line {
        position: absolute; background: rgba(255, 90, 210, 0.85);
        box-shadow: 0 0 6px rgba(255, 90, 210, 0.45);
      }
      .ms-lsd-align-line--v {
        top: 0; bottom: 0; width: 1px;
      }
      .ms-lsd-align-line--h {
        left: 0; right: 0; height: 1px;
      }
      .ms-lsd-align-line.is-axis {
        background: rgba(90, 220, 255, 0.55);
        box-shadow: none;
      }
      .ms-lsd-align-line.is-flash {
        background: rgba(120, 255, 180, 0.9);
        box-shadow: 0 0 8px rgba(120, 255, 180, 0.5);
      }

      .ms-lsd-align-toolbar {
        display: none;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 8px;
        padding: 8px;
        border-radius: 6px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .ms-lsd-align-toolbar.is-visible { display: flex; }
      .ms-lsd-align-toolbar-title {
        font-size: 10px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.04em; opacity: 0.75;
      }
      .ms-lsd-align-toolbar .ms-lsd-btn-group {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .ms-lsd-live-element.is-selected-secondary {
        outline: 1px dashed rgba(110, 200, 255, 0.55);
        outline-offset: 3px;
      }

      /* ===== Floating dialog panel ===== */
      .ms-lsd-floating {
        position: absolute; z-index: 10;
        right: 16px; top: 16px;
        width: 380px;
        max-height: calc(100vh - 32px);
        display: grid; grid-template-rows: auto auto 1fr auto;
        border-radius: 10px; overflow: hidden;
        background: rgba(14,18,26,0.92);
        color: #e7edf6;
        border: 1px solid rgba(255,255,255,0.14);
        box-shadow: 0 12px 50px rgba(0,0,0,0.7);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        font-size: 12px;
      }

      .ms-lsd-header {
        display: flex; justify-content: space-between; align-items: center;
        gap: 8px; padding: 10px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.1);
        background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.01));
        cursor: move;
      }
      .ms-lsd-header h2 { margin: 0; font-size: 14px; font-weight: 700; white-space: nowrap; }
      .ms-lsd-header-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
      .ms-lsd-safe-select-label {
        display: flex; align-items: center; gap: 4px;
        font-size: 10px; opacity: 0.8; white-space: nowrap;
      }

      .ms-lsd-topbar {
        display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center;
        padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.08);
        background: rgba(0,0,0,0.18); font-size: 11px;
      }
      .ms-lsd-topbar label { display: flex; align-items: center; gap: 4px; white-space: nowrap; }

      .ms-lsd-body {
        display: flex; flex-direction: column;
        min-height: 0; overflow-y: auto;
        overflow-x: hidden;
      }
      .ms-lsd-sidebar { padding: 8px 12px; }
      .ms-lsd-sidebar details > summary {
        list-style: none;
      }
      .ms-lsd-sidebar details > summary::-webkit-details-marker {
        display: none;
      }
      .ms-lsd-sidebar details > :not(summary) {
        padding-left: 0;
        margin-left: 0;
      }
      .ms-lsd-inspector-wrap {
        padding: 8px 12px;
        border-top: 1px solid rgba(255,255,255,0.08);
      }
      .ms-lsd-section-title {
        font-size: 11px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.4px; opacity: 0.85;
        padding: 4px 0; cursor: pointer; user-select: none;
      }
      .ms-lsd-stack {
        display: flex; flex-direction: column; gap: 4px;
        margin-bottom: 6px; font-size: 11px;
      }

      .ms-lsd-list { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 6px; }
      .ms-lsd-empty {
        font-size: 10px; opacity: 0.5; padding: 5px;
        border: 1px dashed rgba(255,255,255,0.18); border-radius: 5px;
      }
      .ms-lsd-wall-row, .ms-lsd-element-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 6px;
        padding: 5px;
        border: 1px solid rgba(255,255,255,0.1); border-radius: 5px;
        background: rgba(255,255,255,0.03);
        box-sizing: border-box;
      }
      .ms-lsd-wall-row {
        grid-template-columns: 56px minmax(0, 1fr) auto;
        cursor: pointer;
      }
      .ms-lsd-wall-row.is-previewing {
        border-color: rgba(0,180,255,0.5);
        background: rgba(0,180,255,0.09);
      }
      .ms-lsd-wall-hint {
        font-size: 9px;
        opacity: 0.62;
        line-height: 1.35;
        margin-bottom: 4px;
      }
      .ms-lsd-wall-thumb {
        width: 56px;
        height: 34px;
        border-radius: 4px;
        overflow: hidden;
        background: rgba(0,0,0,0.35);
        border: 1px solid rgba(255,255,255,0.12);
        flex-shrink: 0;
      }
      .ms-lsd-wall-thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        pointer-events: none;
      }
      .ms-lsd-wall-thumb.is-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        opacity: 0.45;
      }
      .ms-lsd-element-row { cursor: pointer; }
      .ms-lsd-element-row.is-selected {
        border-color: rgba(0,180,255,0.5); background: rgba(0,180,255,0.09);
      }
      .ms-lsd-element-row.is-selected-secondary {
        background: rgba(110, 200, 255, 0.08);
        box-shadow: inset 2px 0 0 rgba(110, 200, 255, 0.45);
      }
      .ms-lsd-wall-main, .ms-lsd-element-left { min-width: 0; }
      .ms-lsd-wall-title, .ms-lsd-element-name {
        font-size: 10px; font-weight: 600;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ms-lsd-wall-path, .ms-lsd-element-meta {
        font-size: 9px; opacity: 0.6;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ms-lsd-wall-controls, .ms-lsd-element-controls {
        display: flex; align-items: center; gap: 3px;
      }

      .ms-lsd-user-preset-list { margin-top: 6px; }
      .ms-lsd-user-preset-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 6px;
        padding: 5px;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 5px;
        background: rgba(255,255,255,0.03);
        cursor: pointer;
      }
      .ms-lsd-user-preset-row.is-active {
        border-color: rgba(0,180,255,0.5);
        background: rgba(0,180,255,0.09);
      }
      .ms-lsd-user-preset-name {
        font-size: 10px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ms-lsd-user-preset-meta {
        font-size: 9px;
        opacity: 0.6;
      }

      .ms-lsd-inspector { display: flex; flex-direction: column; gap: 5px; }
      .ms-lsd-helper-hint {
        margin-top: 2px;
        font-size: 9px;
        opacity: 0.65;
        line-height: 1.35;
      }
      .ms-lsd-inspector-section {
        margin-top: 6px; font-size: 10px; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.85;
      }
      .ms-lsd-inspector-label { font-size: 10px; font-weight: 700; margin-top: 6px; opacity: 0.85; }
      .ms-lsd-input-row {
        display: grid; grid-template-columns: 80px 1fr; gap: 6px; align-items: center;
      }
      .ms-lsd-input-label { font-size: 10px; opacity: 0.8; }
      .ms-lsd-input-control { min-width: 0; }
      .ms-lsd-input {
        width: 100%; background: rgba(0,0,0,0.32); color: #e8f0ff;
        border: 1px solid rgba(255,255,255,0.14); border-radius: 5px;
        font-size: 11px; padding: 3px 5px;
      }
      .ms-lsd-input--mini { width: auto; min-width: 60px; }
      .ms-lsd-textarea { resize: vertical; min-height: 36px; }
      .ms-lsd-checkbox { transform: translateY(1px); }
      .ms-lsd-color-wrap, .ms-lsd-font-wrap {
        display: grid; grid-template-columns: 40px 1fr; gap: 5px;
      }
      .ms-lsd-color {
        width: 100%; height: 26px;
        border: 1px solid rgba(255,255,255,0.14); border-radius: 5px;
        background: transparent; padding: 0;
      }

      .ms-lsd-footer {
        display: flex; justify-content: space-between; align-items: center;
        gap: 8px; padding: 8px 12px;
        border-top: 1px solid rgba(255,255,255,0.08);
        background: rgba(0,0,0,0.22);
      }
      .ms-lsd-footer-actions { display: flex; gap: 6px; }
      .ms-lsd-status { font-size: 10px; opacity: 0; transition: opacity 180ms ease; }
      .ms-lsd-status.is-visible { opacity: 0.85; }

      .ms-lsd-btn {
        background: rgba(255,255,255,0.1); color: #e8efff;
        border: 1px solid rgba(255,255,255,0.14); border-radius: 5px;
        padding: 4px 8px; font-size: 10px; cursor: pointer; white-space: nowrap;
      }
      .ms-lsd-btn:hover { background: rgba(255,255,255,0.16); }
      .ms-lsd-btn.is-primary {
        background: rgba(0,180,255,0.2); border-color: rgba(0,180,255,0.4); color: #a6e8ff;
      }
      .ms-lsd-btn.is-danger {
        background: rgba(255,90,90,0.18); border-color: rgba(255,90,90,0.35); color: #ffb9b9;
      }
      .ms-lsd-btn.is-muted {
        opacity: 0.55;
      }
      .ms-lsd-btn.is-muted:hover {
        opacity: 0.85;
      }
      .ms-lsd-btn--full { width: 100%; }
      .ms-lsd-btn-group {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 4px;
      }
      .ms-lsd-btn--group {
        width: 100%;
        padding: 3px 4px;
        text-align: center;
      }

      @keyframes msLsdSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    `;
    (document.head || document.documentElement)?.appendChild(style);
  }
}

function num(v, fallback) {
  return Number.isFinite(v) ? Number(v) : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number(v)));
}

function normalizeColorHex(value) {
  const s = String(value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return '#ffffff';
}

function isTextLikeType(type) {
  const t = String(type || '').toLowerCase();
  return t === 'text' || t === 'subtitle' || t === 'scene-name' || t === 'message'
    || t === 'percentage' || t === 'timer' || t === 'loading-hints';
}

function snapToStep(value, step) {
  const s = Number(step);
  if (!Number.isFinite(s) || s <= 0) return value;
  return Math.round(Number(value) / s) * s;
}

function getAnchorVerticalBand(anchor) {
  const a = String(anchor || 'center').toLowerCase();
  if (a.startsWith('top-') || a === 'top-left' || a === 'top-right' || a === 'top-center') return 'top';
  if (a.startsWith('bottom-') || a === 'bottom-left' || a === 'bottom-right' || a === 'bottom-center') return 'bottom';
  return 'center';
}

function composeAnchor(verticalBand, horizontalAlign) {
  const v = String(verticalBand || 'center').toLowerCase();
  const h = String(horizontalAlign || 'center').toLowerCase();

  if (v === 'top') {
    if (h === 'left') return 'top-left';
    if (h === 'right') return 'top-right';
    return 'top-center';
  }

  if (v === 'bottom') {
    if (h === 'left') return 'bottom-left';
    if (h === 'right') return 'bottom-right';
    return 'bottom-center';
  }

  if (h === 'left') return 'center-left';
  if (h === 'right') return 'center-right';
  return 'center';
}
