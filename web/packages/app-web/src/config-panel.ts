import {
  AUTO_PLAY_LANES,
  getConfig,
  subscribe,
  updateConfig,
  type AutoPlayMap,
} from './config.js';
import type { MidiPortInfo } from '@dtxmania/input';

export type MidiStatus = 'pending' | 'ready' | 'unsupported' | 'denied';

export interface ConfigPanelDeps {
  /** Subscribe to MIDI port + status changes. Return value is the unsubscribe. */
  onMidiPortsChanged: (
    cb: (ports: MidiPortInfo[], status: MidiStatus) => void,
  ) => () => void;
  /** Snap the live song clock to a measure boundary and return the
   * index. Returns null when no chart is playing. Used by the Set A /
   * Set B buttons in the Practice section. Thin shim over
   * `Game.captureLoopMarker`; same function is also invoked by the
   * main.ts `[` / `]` keyboard hotkeys and the VR right-controller
   * face buttons so all three capture paths stay consistent. */
  captureLoopMarker?: (which: 'A' | 'B') => number | null;
}

/**
 * Desktop settings modal. Lives entirely in the DOM — no XR rendering.
 * Triggered by the ⚙ button in the overlay; closing returns the player
 * to the song wheel without restarting any chart in progress (changes
 * are applied live via the config subscribe channel).
 *
 * VR access is deliberately deferred — the in-VR menu has no text
 * input and a separate panel would duplicate this whole layout. For
 * now players need to take off the headset to tweak.
 */
export class ConfigPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly modal: HTMLDivElement;
  private readonly form: ConfigForm;

  constructor(deps?: ConfigPanelDeps) {
    this.backdrop = document.createElement('div');
    this.backdrop.id = 'config-backdrop';
    this.backdrop.className = 'config-backdrop';
    this.backdrop.style.display = 'none';
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });

    this.modal = document.createElement('div');
    this.modal.className = 'config-modal';
    this.backdrop.appendChild(this.modal);

    const header = document.createElement('div');
    header.className = 'config-header';
    const title = document.createElement('div');
    title.className = 'config-title';
    title.textContent = 'Settings';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'config-close';
    close.textContent = '✕';
    close.addEventListener('click', () => this.close());
    header.appendChild(title);
    header.appendChild(close);
    this.modal.appendChild(header);

    this.form = new ConfigForm(deps);
    this.modal.appendChild(this.form.root);
    // Keep the loop A/B readouts live while the panel is open — the
    // player might capture a marker via `[` / `]` hotkey or VR face
    // button without closing the modal. Without this subscribe the
    // panel would show stale values until the next open(). Other
    // fields are one-way (panel → config) so they don't need this,
    // but the refresh is cheap so we just re-pull everything.
    subscribe(() => {
      if (this.backdrop.style.display !== 'none') this.form.refreshFromConfig();
    });

    const footer = document.createElement('div');
    footer.className = 'config-footer';
    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = 'Done';
    done.addEventListener('click', () => this.close());
    footer.appendChild(done);
    this.modal.appendChild(footer);

    document.body.appendChild(this.backdrop);
  }

  open(): void {
    this.form.refreshFromConfig();
    this.backdrop.style.display = 'flex';
  }

  close(): void {
    this.backdrop.style.display = 'none';
  }
}

/**
 * The form rows are split out so refreshFromConfig() (called on open)
 * can re-pull current values without rebuilding the DOM. Each input
 * fires updateConfig on every change so sliders feel live.
 */
class ConfigForm {
  readonly root: HTMLDivElement;
  private readonly scrollSpeedInput: HTMLInputElement;
  private readonly scrollSpeedVal: HTMLSpanElement;
  private readonly judgeYInput: HTMLInputElement;
  private readonly judgeYVal: HTMLSpanElement;
  private readonly reverseInput: HTMLInputElement;
  private readonly fastSlowInput: HTMLInputElement;
  private readonly autoPlayInputs: Record<keyof AutoPlayMap, HTMLInputElement>;
  private readonly bgmVolInput: HTMLInputElement;
  private readonly bgmVolVal: HTMLSpanElement;
  private readonly drumsVolInput: HTMLInputElement;
  private readonly drumsVolVal: HTMLSpanElement;
  private readonly previewVolInput: HTMLInputElement;
  private readonly previewVolVal: HTMLSpanElement;
  private readonly gamepadInput: HTMLInputElement;
  private readonly gamepadStatus: HTMLSpanElement;
  private readonly midiInput: HTMLInputElement;
  private readonly midiPortSelect: HTMLSelectElement;
  private readonly midiStatusEl: HTMLSpanElement;
  private midiPorts: MidiPortInfo[] = [];
  private midiStatusState: MidiStatus = 'pending';
  private readonly practiceRateInput: HTMLInputElement;
  private readonly practiceRateVal: HTMLSpanElement;
  private readonly preservePitchInput: HTMLInputElement;
  private readonly loopEnabledInput: HTMLInputElement;
  private readonly loopAVal: HTMLSpanElement;
  private readonly loopBVal: HTMLSpanElement;
  private readonly loopWarn: HTMLDivElement;

  constructor(deps?: ConfigPanelDeps) {
    this.root = document.createElement('div');
    this.root.className = 'config-form';

    const gameplay = section('Gameplay');
    this.root.appendChild(gameplay.section);

    // Scroll speed slider (px / ms)
    const ss = sliderRow('Scroll speed', '0.30', '1.50', '0.05');
    this.scrollSpeedInput = ss.input;
    this.scrollSpeedVal = ss.value;
    ss.input.addEventListener('input', () => {
      const v = parseFloat(ss.input.value);
      ss.value.textContent = v.toFixed(2);
      updateConfig({ scrollSpeed: v });
    });
    gameplay.body.appendChild(ss.row);

    // Judgment line Y
    const jy = sliderRow('Judgment line Y', '450', '620', '5');
    this.judgeYInput = jy.input;
    this.judgeYVal = jy.value;
    jy.input.addEventListener('input', () => {
      const v = parseInt(jy.input.value, 10);
      jy.value.textContent = String(v);
      updateConfig({ judgeLineY: v });
    });
    gameplay.body.appendChild(jy.row);

    // Reverse scroll
    const rs = checkboxRow('Reverse scroll (chips rise)');
    this.reverseInput = rs.input;
    rs.input.addEventListener('change', () => {
      updateConfig({ reverseScroll: rs.input.checked });
    });
    gameplay.body.appendChild(rs.row);

    // FAST / SLOW indicator on judgment flashes
    const fs = checkboxRow('Show FAST / SLOW indicator on hits');
    this.fastSlowInput = fs.input;
    fs.input.addEventListener('change', () => {
      updateConfig({ showFastSlow: fs.input.checked });
    });
    gameplay.body.appendChild(fs.row);

    // Per-lane auto-play (DTXmania bAutoPlay struct — one checkbox per
    // drum lane). Grid laid out in two columns so all 11 fit without
    // overflowing the modal.
    const ap = section('Auto-play (by lane)');
    this.root.appendChild(ap.section);
    const apGrid = document.createElement('div');
    apGrid.className = 'config-autoplay-grid';
    ap.body.appendChild(apGrid);
    const apInputs: Partial<Record<keyof AutoPlayMap, HTMLInputElement>> = {};
    for (const lane of AUTO_PLAY_LANES) {
      const row = autoPlayCell(lane);
      apInputs[lane] = row.input;
      row.input.addEventListener('change', () => {
        updateConfig({
          autoPlay: { ...getConfig().autoPlay, [lane]: row.input.checked },
        });
      });
      apGrid.appendChild(row.row);
    }
    this.autoPlayInputs = apInputs as Record<keyof AutoPlayMap, HTMLInputElement>;

    const audio = section('Audio');
    this.root.appendChild(audio.section);

    const bgm = sliderRow('BGM volume', '0', '1', '0.05');
    this.bgmVolInput = bgm.input;
    this.bgmVolVal = bgm.value;
    bgm.input.addEventListener('input', () => {
      const v = parseFloat(bgm.input.value);
      bgm.value.textContent = v.toFixed(2);
      updateConfig({ volumeBgm: v });
    });
    audio.body.appendChild(bgm.row);

    const drums = sliderRow('Drums volume', '0', '1', '0.05');
    this.drumsVolInput = drums.input;
    this.drumsVolVal = drums.value;
    drums.input.addEventListener('input', () => {
      const v = parseFloat(drums.input.value);
      drums.value.textContent = v.toFixed(2);
      updateConfig({ volumeDrums: v });
    });
    audio.body.appendChild(drums.row);

    const prev = sliderRow('Preview volume', '0', '1', '0.05');
    this.previewVolInput = prev.input;
    this.previewVolVal = prev.value;
    prev.input.addEventListener('input', () => {
      const v = parseFloat(prev.input.value);
      prev.value.textContent = v.toFixed(2);
      updateConfig({ volumePreview: v });
    });
    audio.body.appendChild(prev.row);

    // Input devices (gamepad toggle + live detection readout). MIDI will
    // sit alongside this section once the MIDI wiring lands.
    const inputs = section('Input devices');
    this.root.appendChild(inputs.section);

    const gp = checkboxRow('Enable gamepad (non-VR)');
    this.gamepadInput = gp.input;
    gp.input.addEventListener('change', () => {
      updateConfig({ gamepadEnabled: gp.input.checked });
    });
    inputs.body.appendChild(gp.row);

    const gpStatusRow = document.createElement('div');
    gpStatusRow.className = 'config-row config-row-readout';
    const gpStatusLabel = document.createElement('span');
    gpStatusLabel.className = 'config-label';
    gpStatusLabel.textContent = 'Detected gamepads';
    this.gamepadStatus = document.createElement('span');
    this.gamepadStatus.className = 'config-val';
    gpStatusRow.appendChild(gpStatusLabel);
    gpStatusRow.appendChild(this.gamepadStatus);
    inputs.body.appendChild(gpStatusRow);
    // Refresh on connect / disconnect so the readout reflects reality
    // even when the modal is open.
    if (typeof window !== 'undefined') {
      window.addEventListener('gamepadconnected', () => this.refreshGamepadStatus());
      window.addEventListener('gamepaddisconnected', () => this.refreshGamepadStatus());
    }

    const mi = checkboxRow('Enable MIDI drum input');
    this.midiInput = mi.input;
    mi.input.addEventListener('change', () => {
      updateConfig({ midiEnabled: mi.input.checked });
    });
    inputs.body.appendChild(mi.row);

    const portRow = document.createElement('label');
    portRow.className = 'config-row config-row-select';
    const portLabel = document.createElement('span');
    portLabel.className = 'config-label';
    portLabel.textContent = 'MIDI port';
    this.midiPortSelect = document.createElement('select');
    this.midiPortSelect.addEventListener('change', () => {
      const v = this.midiPortSelect.value;
      updateConfig({ midiInputId: v === '' ? null : v });
    });
    portRow.appendChild(portLabel);
    portRow.appendChild(this.midiPortSelect);
    inputs.body.appendChild(portRow);

    const midiStatusRow = document.createElement('div');
    midiStatusRow.className = 'config-row config-row-readout';
    const midiStatusLabel = document.createElement('span');
    midiStatusLabel.className = 'config-label';
    midiStatusLabel.textContent = 'MIDI status';
    this.midiStatusEl = document.createElement('span');
    this.midiStatusEl.className = 'config-val';
    midiStatusRow.appendChild(midiStatusLabel);
    midiStatusRow.appendChild(this.midiStatusEl);
    inputs.body.appendChild(midiStatusRow);

    if (deps) {
      deps.onMidiPortsChanged((ports, status) => {
        this.midiPorts = ports;
        this.midiStatusState = status;
        this.refreshMidiStatus();
      });
    } else {
      this.midiStatusState = 'unsupported';
      this.refreshMidiStatus();
    }

    // Practice section — playback rate + pitch-preserve. Loop UI is
    // deferred (see plan); the rate slider alone is the DTXmania
    // PlaySpeed analogue and drives the bulk of the practice value.
    const practice = section('Practice');
    this.root.appendChild(practice.section);

    const pr = sliderRow('Playback speed', '0.25', '2.0', '0.05');
    this.practiceRateInput = pr.input;
    this.practiceRateVal = pr.value;
    pr.input.addEventListener('input', () => {
      const v = parseFloat(pr.input.value);
      pr.value.textContent = `${v.toFixed(2)}×`;
      updateConfig({ practiceRate: v });
    });
    practice.body.appendChild(pr.row);

    const pp = checkboxRow('Preserve pitch at non-1× speeds');
    this.preservePitchInput = pp.input;
    pp.input.addEventListener('change', () => {
      updateConfig({ preservePitch: pp.input.checked });
    });
    practice.body.appendChild(pp.row);

    // A/B loop — checkbox + Set-A / Set-B / Clear buttons. The buttons
    // call into captureLoopMarker (live song-time snap); the same path
    // is also bound to the `[` / `]` keys in main.ts and the VR
    // right-controller face buttons in game.ts so all three surfaces
    // stay consistent. We DON'T offer number inputs here — asking the
    // player to type a measure index would be hostile; loop capture
    // during play is the intended UX.
    const le = checkboxRow('Enable A–B loop');
    this.loopEnabledInput = le.input;
    le.input.addEventListener('change', () => {
      updateConfig({ practiceLoopEnabled: le.input.checked });
    });
    practice.body.appendChild(le.row);

    const aRow = captureRow('A (start measure)', 'Set A');
    this.loopAVal = aRow.value;
    aRow.button.addEventListener('click', () => {
      const m = deps?.captureLoopMarker?.('A');
      if (m === undefined || m === null) return;
      updateConfig({ practiceLoopStartMeasure: m, practiceLoopEnabled: true });
      this.refreshFromConfig();
    });
    practice.body.appendChild(aRow.row);

    const bRow = captureRow('B (end measure)', 'Set B');
    this.loopBVal = bRow.value;
    bRow.button.addEventListener('click', () => {
      const m = deps?.captureLoopMarker?.('B');
      if (m === undefined || m === null) return;
      updateConfig({ practiceLoopEndMeasure: m, practiceLoopEnabled: true });
      this.refreshFromConfig();
    });
    practice.body.appendChild(bRow.row);

    const clearRow = document.createElement('div');
    clearRow.className = 'config-row config-row-check';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear A/B';
    clearBtn.addEventListener('click', () => {
      updateConfig({
        practiceLoopEnabled: false,
        practiceLoopStartMeasure: 0,
        practiceLoopEndMeasure: null,
      });
      this.refreshFromConfig();
    });
    clearRow.appendChild(clearBtn);
    practice.body.appendChild(clearRow);

    // Inline warning when resolveLoopWindow would reject the current
    // range (B ≤ A). Hidden otherwise. Silent-disable without this
    // hint confuses players ("I enabled loop but nothing happens").
    this.loopWarn = document.createElement('div');
    this.loopWarn.className = 'config-note config-note-warn';
    this.loopWarn.style.color = '#fbbf24';
    this.loopWarn.style.display = 'none';
    this.loopWarn.textContent = 'Range is invalid (B must be after A). Loop is disabled.';
    practice.body.appendChild(this.loopWarn);

    const loopHint = document.createElement('div');
    loopHint.className = 'config-note';
    loopHint.textContent =
      'Hotkeys during play: [ = Set A, ] = Set B, \\ = toggle loop. ' +
      'VR: right-hand A / B on Touch controllers.';
    practice.body.appendChild(loopHint);

    const warn = document.createElement('div');
    warn.className = 'config-note';
    warn.textContent =
      'Non-1× speed and A–B loop both skip best-score writes (practice runs don\'t overwrite your medals).';
    practice.body.appendChild(warn);
  }

  private refreshMidiStatus(): void {
    this.midiStatusEl.textContent =
      this.midiStatusState === 'pending' ? 'Waiting for first user gesture…'
      : this.midiStatusState === 'unsupported' ? 'Unsupported in this browser'
      : this.midiStatusState === 'denied' ? 'Permission denied'
      : this.midiPorts.length === 0 ? 'No input ports'
      : `${this.midiPorts.length} port(s)`;
    // Rebuild the dropdown: "Any input port" + each port by id.
    const current = getConfig().midiInputId;
    this.midiPortSelect.replaceChildren();
    const anyOpt = document.createElement('option');
    anyOpt.value = '';
    anyOpt.textContent = 'Any input';
    this.midiPortSelect.appendChild(anyOpt);
    for (const p of this.midiPorts) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      this.midiPortSelect.appendChild(opt);
    }
    this.midiPortSelect.value = current ?? '';
    this.midiPortSelect.disabled = this.midiStatusState !== 'ready';
  }

  private refreshGamepadStatus(): void {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      this.gamepadStatus.textContent = 'Unsupported';
      return;
    }
    const pads = Array.from(navigator.getGamepads()).filter(
      (p): p is Gamepad => p !== null,
    );
    if (pads.length === 0) {
      this.gamepadStatus.textContent = 'None';
      return;
    }
    this.gamepadStatus.textContent = pads
      .map((p) => `${p.id}${p.mapping === 'standard' ? '' : ' (non-standard mapping)'}`)
      .join('; ');
  }

  refreshFromConfig(): void {
    const cfg = getConfig();
    this.scrollSpeedInput.value = String(cfg.scrollSpeed);
    this.scrollSpeedVal.textContent = cfg.scrollSpeed.toFixed(2);
    this.judgeYInput.value = String(cfg.judgeLineY);
    this.judgeYVal.textContent = String(cfg.judgeLineY);
    this.reverseInput.checked = cfg.reverseScroll;
    this.fastSlowInput.checked = cfg.showFastSlow;
    for (const lane of AUTO_PLAY_LANES) {
      this.autoPlayInputs[lane].checked = cfg.autoPlay[lane];
    }
    this.bgmVolInput.value = String(cfg.volumeBgm);
    this.bgmVolVal.textContent = cfg.volumeBgm.toFixed(2);
    this.drumsVolInput.value = String(cfg.volumeDrums);
    this.drumsVolVal.textContent = cfg.volumeDrums.toFixed(2);
    this.previewVolInput.value = String(cfg.volumePreview);
    this.previewVolVal.textContent = cfg.volumePreview.toFixed(2);
    this.gamepadInput.checked = cfg.gamepadEnabled;
    this.refreshGamepadStatus();
    this.midiInput.checked = cfg.midiEnabled;
    this.midiPortSelect.value = cfg.midiInputId ?? '';
    this.practiceRateInput.value = String(cfg.practiceRate);
    this.practiceRateVal.textContent = `${cfg.practiceRate.toFixed(2)}×`;
    this.preservePitchInput.checked = cfg.preservePitch;
    this.loopEnabledInput.checked = cfg.practiceLoopEnabled;
    this.loopAVal.textContent = formatMeasure(cfg.practiceLoopStartMeasure);
    this.loopBVal.textContent =
      cfg.practiceLoopEndMeasure === null
        ? '— end of song —'
        : formatMeasure(cfg.practiceLoopEndMeasure);
    const invalid =
      cfg.practiceLoopEndMeasure !== null &&
      cfg.practiceLoopEndMeasure <= cfg.practiceLoopStartMeasure;
    this.loopWarn.style.display = invalid ? '' : 'none';
  }
}

/** Human-facing measure label. Measure 0 shown as "0 (start)" so the
 * player understands it's the very beginning; otherwise just the index. */
function formatMeasure(m: number): string {
  return m === 0 ? '0 (start)' : String(m);
}

/** Compact "[✓] HH" cell used inside the per-lane auto-play grid. */
function autoPlayCell(lane: keyof AutoPlayMap): {
  row: HTMLDivElement;
  input: HTMLInputElement;
} {
  const row = document.createElement('label');
  row.className = 'config-autoplay-cell';
  const input = document.createElement('input');
  input.type = 'checkbox';
  const lab = document.createElement('span');
  lab.className = 'config-autoplay-label';
  lab.textContent = lane;
  row.appendChild(input);
  row.appendChild(lab);
  return { row: row as unknown as HTMLDivElement, input };
}

function section(label: string): { section: HTMLDivElement; body: HTMLDivElement } {
  const sec = document.createElement('div');
  sec.className = 'config-section';
  const title = document.createElement('div');
  title.className = 'config-section-title';
  title.textContent = label;
  sec.appendChild(title);
  const body = document.createElement('div');
  body.className = 'config-section-body';
  sec.appendChild(body);
  return { section: sec, body };
}

function sliderRow(
  label: string,
  min: string,
  max: string,
  step: string
): { row: HTMLDivElement; input: HTMLInputElement; value: HTMLSpanElement } {
  const row = document.createElement('label');
  row.className = 'config-row config-row-slider';
  const lab = document.createElement('span');
  lab.className = 'config-label';
  lab.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = step;
  const value = document.createElement('span');
  value.className = 'config-val';
  row.appendChild(lab);
  row.appendChild(input);
  row.appendChild(value);
  return { row: row as unknown as HTMLDivElement, input, value };
}

function captureRow(
  label: string,
  buttonLabel: string,
): {
  row: HTMLDivElement;
  value: HTMLSpanElement;
  button: HTMLButtonElement;
} {
  const row = document.createElement('div');
  row.className = 'config-row config-row-readout';
  const lab = document.createElement('span');
  lab.className = 'config-label';
  lab.textContent = label;
  const value = document.createElement('span');
  value.className = 'config-val';
  value.textContent = '— none —';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = buttonLabel;
  row.appendChild(lab);
  row.appendChild(value);
  row.appendChild(button);
  return { row, value, button };
}

function checkboxRow(label: string): {
  row: HTMLDivElement;
  input: HTMLInputElement;
} {
  const row = document.createElement('label');
  row.className = 'config-row config-row-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  const lab = document.createElement('span');
  lab.className = 'config-label';
  lab.textContent = label;
  row.appendChild(input);
  row.appendChild(lab);
  return { row: row as unknown as HTMLDivElement, input };
}
