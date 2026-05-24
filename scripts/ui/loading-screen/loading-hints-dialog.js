/**
 * @fileoverview Dialog for editing world-scoped loading screen hint entries.
 * @module ui/loading-screen/loading-hints-dialog
 */

import {
  createDefaultLoadingHints,
  normalizeHintEntry,
  normalizeHintsList,
} from './loading-hints.js';

const DIALOG_ID = 'map-shine-loading-hints-dialog';
const STYLE_ID = 'map-shine-loading-hints-dialog-style';
const MODULE_ID = 'map-shine-advanced';
const SETTING_KEY = 'loadingScreenHints';

export class LoadingHintsDialog {
  /**
   * @param {import('./loading-screen-manager.js').LoadingScreenManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    this.container = null;
    this.visible = false;
    this.hints = [];
    this.refs = { list: null, status: null, newText: null };
  }

  async initialize(parentElement = document.body) {
    if (this.container) return;

    this._installStyle();
    this.container = document.createElement('div');
    this.container.id = DIALOG_ID;
    this.container.className = 'ms-lhd-overlay';
    this.container.style.display = 'none';
    this.container.innerHTML = this._buildMarkup();
    parentElement.appendChild(this.container);

    this.refs.list = this.container.querySelector('[data-ref="hint-list"]');
    this.refs.status = this.container.querySelector('[data-ref="status"]');
    this.refs.newText = this.container.querySelector('[data-ref="new-hint-text"]');

    this.container.querySelector('[data-action="close"]')?.addEventListener('click', () => this.hide());
    this.container.querySelector('[data-action="add-hint"]')?.addEventListener('click', () => this._addHint());
    this.container.querySelector('[data-action="reset-defaults"]')?.addEventListener('click', async () => {
      this.hints = createDefaultLoadingHints().map((h) => ({ ...h }));
      await this._saveHints();
      this._renderList();
      this._status('Restored default hint examples.');
    });

    await this._loadHints();
    this._renderList();
  }

  async show() {
    if (!this.container) await this.initialize();
    this.visible = true;
    this.container.style.display = 'flex';
    await this._loadHints();
    this._renderList();
  }

  hide() {
    if (!this.container) return;
    this.visible = false;
    this.container.style.display = 'none';
  }

  dispose() {
    this.container?.remove();
    this.container = null;
    this.visible = false;
  }

  async _loadHints() {
    this.hints = await this.manager.getLoadingHints();
  }

  async _saveHints() {
    const next = normalizeHintsList(this.hints);
    await game.settings.set(MODULE_ID, SETTING_KEY, next);
    this.hints = next;
  }

  async _addHint() {
    const text = String(this.refs.newText?.value || '').trim();
    if (!text) {
      this._status('Enter hint text first.');
      return;
    }
    const entry = normalizeHintEntry({
      id: `hint-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      enabled: true,
    });
    if (!entry) return;
    this.hints.push(entry);
    if (this.refs.newText) this.refs.newText.value = '';
    await this._saveHints();
    this._renderList();
    this._status('Hint added.');
  }

  _renderList() {
    const listEl = this.refs.list;
    if (!listEl) return;
    listEl.innerHTML = '';

    if (!this.hints.length) {
      const empty = document.createElement('div');
      empty.className = 'ms-lhd-empty';
      empty.textContent = 'No hints yet. Add one below.';
      listEl.appendChild(empty);
      return;
    }

    this.hints.forEach((hint, index) => {
      const row = document.createElement('div');
      row.className = 'ms-lhd-row';

      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = hint.enabled !== false;
      enabled.title = 'Enabled';
      enabled.addEventListener('change', async () => {
        hint.enabled = enabled.checked;
        await this._saveHints();
      });

      const text = document.createElement('textarea');
      text.className = 'ms-lhd-text';
      text.rows = 2;
      text.value = String(hint.text || '');
      text.placeholder = 'Hint text…';
      let saveTimer = null;
      text.addEventListener('input', () => {
        hint.text = text.value;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          await this._saveHints();
          this._status('Hint saved.');
        }, 450);
      });

      const controls = document.createElement('div');
      controls.className = 'ms-lhd-controls';

      const up = this._button('↑', async () => {
        if (index <= 0) return;
        [this.hints[index - 1], this.hints[index]] = [this.hints[index], this.hints[index - 1]];
        await this._saveHints();
        this._renderList();
      });

      const down = this._button('↓', async () => {
        if (index >= this.hints.length - 1) return;
        [this.hints[index], this.hints[index + 1]] = [this.hints[index + 1], this.hints[index]];
        await this._saveHints();
        this._renderList();
      });

      const remove = this._button('✕', async () => {
        this.hints.splice(index, 1);
        await this._saveHints();
        this._renderList();
        this._status('Hint removed.');
      }, true);

      controls.append(up, down, remove);
      row.append(enabled, text, controls);
      listEl.appendChild(row);
    });
  }

  _button(label, onClick, danger = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ms-lhd-btn ${danger ? 'is-danger' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onClick();
    });
    return btn;
  }

  _status(message) {
    if (!this.refs.status) return;
    this.refs.status.textContent = String(message || '');
    this.refs.status.classList.add('is-visible');
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      this.refs.status?.classList.remove('is-visible');
    }, 2200);
  }

  _buildMarkup() {
    return `
      <div class="ms-lhd-panel">
        <header class="ms-lhd-header">
          <div>
            <div class="ms-lhd-title">Loading Screen Hints</div>
            <div class="ms-lhd-subtitle">Tips rotate on any <em>Loading Hints</em> element during scene loads.</div>
          </div>
          <button type="button" class="ms-lhd-btn" data-action="close">Close</button>
        </header>
        <div class="ms-lhd-list" data-ref="hint-list"></div>
        <footer class="ms-lhd-footer">
          <textarea data-ref="new-hint-text" class="ms-lhd-text ms-lhd-text--new" rows="2" placeholder="New hint text…"></textarea>
          <div class="ms-lhd-footer-actions">
            <button type="button" class="ms-lhd-btn" data-action="reset-defaults">Restore Examples</button>
            <button type="button" class="ms-lhd-btn is-primary" data-action="add-hint">Add Hint</button>
          </div>
          <div class="ms-lhd-status" data-ref="status"></div>
        </footer>
      </div>
    `;
  }

  _installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .ms-lhd-overlay {
        position: fixed; inset: 0; z-index: 100060;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.55); backdrop-filter: blur(3px);
      }
      .ms-lhd-panel {
        width: min(720px, 94vw); max-height: min(82vh, 900px);
        display: flex; flex-direction: column;
        background: rgba(12,16,24,0.96);
        border: 1px solid rgba(120,160,255,0.28);
        border-radius: 12px;
        box-shadow: 0 18px 60px rgba(0,0,0,0.55);
        color: rgba(235,245,255,0.94);
        font-family: Signika, sans-serif;
      }
      .ms-lhd-header, .ms-lhd-footer { padding: 14px 16px; }
      .ms-lhd-header {
        display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .ms-lhd-title { font-size: 18px; font-weight: 700; }
      .ms-lhd-subtitle { font-size: 12px; opacity: 0.72; margin-top: 4px; }
      .ms-lhd-list {
        flex: 1; overflow: auto; padding: 10px 16px;
        display: flex; flex-direction: column; gap: 8px;
      }
      .ms-lhd-row {
        display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: start;
        padding: 8px; border-radius: 8px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.07);
      }
      .ms-lhd-text {
        width: 100%; resize: vertical; min-height: 44px;
        background: rgba(0,0,0,0.35); color: inherit;
        border: 1px solid rgba(255,255,255,0.14); border-radius: 6px;
        padding: 8px 10px; font: inherit; line-height: 1.35;
      }
      .ms-lhd-text--new { margin-bottom: 8px; }
      .ms-lhd-controls { display: flex; gap: 4px; }
      .ms-lhd-btn {
        border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06);
        color: inherit; border-radius: 6px; padding: 6px 10px; cursor: pointer;
        font: inherit; font-size: 12px;
      }
      .ms-lhd-btn.is-primary { border-color: rgba(0,180,255,0.5); background: rgba(0,140,220,0.22); }
      .ms-lhd-btn.is-danger { border-color: rgba(255,90,90,0.45); color: rgba(255,170,170,0.95); }
      .ms-lhd-footer { border-top: 1px solid rgba(255,255,255,0.08); }
      .ms-lhd-footer-actions { display: flex; gap: 8px; justify-content: flex-end; }
      .ms-lhd-empty { opacity: 0.65; font-size: 13px; padding: 8px 2px; }
      .ms-lhd-status { min-height: 18px; font-size: 12px; opacity: 0; margin-top: 6px; transition: opacity 180ms ease; }
      .ms-lhd-status.is-visible { opacity: 0.85; }
    `;
    document.head.appendChild(style);
  }
}
