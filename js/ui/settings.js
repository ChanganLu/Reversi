/**
 * settings.js — the settings sheet.
 *
 * Reads and writes a plain settings object; the controller decides what to do
 * with the result. Nothing here touches the game state.
 */

export class SettingsDialog {
  /**
   * @param {object} options
   * @param {() => object} options.getSettings current settings
   * @param {(settings:object) => void} options.onApply applied and restarted
   * @param {() => void} options.onResume resume the stored game
   * @param {() => boolean} options.canResume whether a stored game exists
   */
  constructor({ getSettings, onApply, onResume, canResume }) {
    this.getSettings = getSettings;
    this.onApply = onApply;
    this.onResume = onResume;
    this.canResume = canResume;

    this.dialog = document.getElementById('settings-dialog');
    this.form = document.getElementById('settings-form');
    this.engineSelect = document.getElementById('engine-select');
    this.legalToggle = document.getElementById('opt-legal');
    this.coordsToggle = document.getElementById('opt-coords');
    this.motionToggle = document.getElementById('opt-motion');
    this.resumeButton = document.getElementById('btn-resume');
    this.applyButton = document.getElementById('btn-apply');

    this.applyButton.addEventListener('click', () => {
      this.onApply(this.read());
      this.dialog.close();
    });
    this.resumeButton.addEventListener('click', () => {
      this.onResume();
      this.dialog.close();
    });
  }

  /** Opens the sheet, pre-filled with the current settings. */
  open() {
    const settings = this.getSettings();
    for (const input of this.form.querySelectorAll('input[name="mode"]')) {
      input.checked = input.value === settings.mode;
    }
    for (const input of this.form.querySelectorAll('input[name="level"]')) {
      input.checked = input.value === settings.level;
    }
    this.engineSelect.value = settings.engine;
    this.legalToggle.checked = settings.showLegal;
    this.coordsToggle.checked = settings.showCoords;
    this.motionToggle.checked = settings.animations;
    this.resumeButton.disabled = !this.canResume();

    if (typeof this.dialog.showModal === 'function') this.dialog.showModal();
    else this.dialog.setAttribute('open', 'true');
  }

  close() {
    if (typeof this.dialog.close === 'function') this.dialog.close();
    else this.dialog.removeAttribute('open');
  }

  /** @returns {object} the settings currently selected in the form */
  read() {
    const previous = this.getSettings();
    const mode = this.form.querySelector('input[name="mode"]:checked')?.value ?? previous.mode;
    const level = this.form.querySelector('input[name="level"]:checked')?.value ?? previous.level;
    return {
      ...previous,
      mode,
      level,
      engine: this.engineSelect.value === 'ab' ? 'ab' : 'mcts',
      showLegal: this.legalToggle.checked,
      showCoords: this.coordsToggle.checked,
      animations: this.motionToggle.checked,
    };
  }
}
