/**
 * Tiny corner control surface for the IWER-emulated XR device, used
 * when running with `?xr-emu=1` (i.e. the runtime-only path that
 * intentionally skips `@iwer/devui`'s global event hijack).
 *
 * Why this and not just DevUI: DevUI installs `keydown` / `mousedown`
 * listeners on `document` and `window` from inside `InputLayer` and
 * `pinch.js`, which races every hotkey + click handler the app
 * already owns (practice-loop `[`/`]`/`\`, pickfolder button, etc.).
 * The result is a page that *looks* fine but where every input goes
 * to DevUI first and never reaches the app. This panel keeps its
 * pointer-events scoped to a 200x110 px box pinned to the bottom
 * corner, so the rest of the page stays operable.
 *
 * Capabilities:
 *   - Trigger L / Trigger R buttons → drive
 *     `controller.setButtonValueImmediate('xr-standard-trigger', …)`
 *     for one-shot select events. Enough for VR menu / config /
 *     calibrate panel verification.
 *   - Recenter — `xrDevice.recenter()`.
 *   - Head Y +/- — small step buttons because head height matters
 *     for laser angle in our menu layouts.
 *   - Status text — surfaces device name + active session state so
 *     reviewers can confirm requestSession actually went through.
 *
 * Pose-level control beyond this is via `window.__xrEmu` from the
 * console (e.g. `__xrEmu.controllers.right.position.set(...)`).
 */
import type { XRDevice } from 'iwer';

const PANEL_ID = 'iwer-mini-panel';

export function installMiniPanel(device: XRDevice): void {
  if (document.getElementById(PANEL_ID)) return;
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  // Inline styles so we don't have to ship CSS — keeps the panel
  // self-contained and reachable even if the app's stylesheet hasn't
  // loaded yet (the emulator installs *before* the rest of init).
  Object.assign(panel.style, {
    position: 'fixed',
    right: '8px',
    bottom: '8px',
    width: '200px',
    padding: '8px',
    background: 'rgba(15, 23, 42, 0.92)',
    color: '#e5e7eb',
    border: '1px solid rgba(80, 120, 255, 0.55)',
    borderRadius: '6px',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '11px',
    lineHeight: '1.4',
    zIndex: '10000',
    pointerEvents: 'auto',
    userSelect: 'none',
  } as Partial<CSSStyleDeclaration>);

  const status = document.createElement('div');
  status.textContent = `XR Emu · ${device.name}`;
  status.style.marginBottom = '6px';
  status.style.fontWeight = '600';
  panel.appendChild(status);

  const sessionLine = document.createElement('div');
  sessionLine.style.opacity = '0.7';
  sessionLine.style.marginBottom = '6px';
  panel.appendChild(sessionLine);
  const refreshSession = () => {
    sessionLine.textContent = device.activeSession ? 'session: active' : 'session: idle';
  };
  refreshSession();
  setInterval(refreshSession, 500);

  panel.appendChild(makeButton('Trigger L', () => pressTrigger(device, 'left')));
  panel.appendChild(makeButton('Trigger R', () => pressTrigger(device, 'right')));
  panel.appendChild(makeButton('Recenter', () => device.recenter()));
  panel.appendChild(makeStepRow('Head Y', (delta) => stepHeadY(device, delta)));

  document.body.appendChild(panel);
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  Object.assign(b.style, {
    display: 'block',
    width: '100%',
    margin: '3px 0',
    padding: '4px',
    background: '#1e293b',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: '3px',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: 'pointer',
  } as Partial<CSSStyleDeclaration>);
  b.addEventListener('click', (e) => {
    // Stop the click from bubbling into anything else the page might
    // listen for; the panel's whole purpose is to be input-isolated.
    e.stopPropagation();
    try {
      onClick();
    } catch (err) {
      console.warn('[xr-emu] button action failed', err);
    }
  });
  return b;
}

function makeStepRow(label: string, onStep: (delta: number) => void): HTMLDivElement {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    margin: '3px 0',
  } as Partial<CSSStyleDeclaration>);
  const tag = document.createElement('span');
  tag.textContent = label;
  tag.style.flex = '1';
  row.appendChild(tag);
  row.appendChild(makeButton('−', () => onStep(-0.05)));
  row.appendChild(makeButton('+', () => onStep(0.05)));
  return row;
}

/**
 * Press the trigger for ~120 ms, then release. The 'xr-standard-trigger'
 * id is configured with `eventTrigger: 'select'` in IWER's Quest profile,
 * so the press fires `selectstart` → `select` → `selectend` on the input
 * source, which is what `xr-controllers.ts` listens to for laser-ray
 * clicks against VR panels.
 */
function pressTrigger(device: XRDevice, hand: 'left' | 'right'): void {
  const c = device.controllers[hand];
  if (!c) {
    console.warn(`[xr-emu] no ${hand} controller`);
    return;
  }
  c.setButtonValueImmediate('xr-standard-trigger', 1);
  setTimeout(() => c.setButtonValueImmediate('xr-standard-trigger', 0), 120);
}

function stepHeadY(device: XRDevice, delta: number): void {
  device.position.y += delta;
}
