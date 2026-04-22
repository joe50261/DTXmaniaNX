import { getConfig, updateConfig } from './config.js';

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

  constructor() {
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

    this.form = new ConfigForm();
    this.modal.appendChild(this.form.root);

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
  private readonly autoKickInput: HTMLInputElement;
  private readonly bgmVolInput: HTMLInputElement;
  private readonly bgmVolVal: HTMLSpanElement;
  private readonly drumsVolInput: HTMLInputElement;
  private readonly drumsVolVal: HTMLSpanElement;
  private readonly previewVolInput: HTMLInputElement;
  private readonly previewVolVal: HTMLSpanElement;

  constructor() {
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

    // Auto-kick
    const ak = checkboxRow('Auto-kick (BD + LBD fire automatically)');
    this.autoKickInput = ak.input;
    ak.input.addEventListener('change', () => {
      updateConfig({ autoKick: ak.input.checked });
    });
    gameplay.body.appendChild(ak.row);

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
  }

  refreshFromConfig(): void {
    const cfg = getConfig();
    this.scrollSpeedInput.value = String(cfg.scrollSpeed);
    this.scrollSpeedVal.textContent = cfg.scrollSpeed.toFixed(2);
    this.judgeYInput.value = String(cfg.judgeLineY);
    this.judgeYVal.textContent = String(cfg.judgeLineY);
    this.reverseInput.checked = cfg.reverseScroll;
    this.autoKickInput.checked = cfg.autoKick;
    this.bgmVolInput.value = String(cfg.volumeBgm);
    this.bgmVolVal.textContent = cfg.volumeBgm.toFixed(2);
    this.drumsVolInput.value = String(cfg.volumeDrums);
    this.drumsVolVal.textContent = cfg.volumeDrums.toFixed(2);
    this.previewVolInput.value = String(cfg.volumePreview);
    this.previewVolVal.textContent = cfg.volumePreview.toFixed(2);
  }
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
