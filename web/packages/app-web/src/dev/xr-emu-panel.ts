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
 *     `controller.setButtonValueImmediate('trigger', …)` for one-shot
 *     select events. Note: IWER's internal button id is `'trigger'`,
 *     NOT `'xr-standard-trigger'` (that's the WebXR Gamepad standard
 *     mapping name; IWER uses its own short ids — see
 *     `iwer/lib/device/configs/controller/meta.js`).
 *   - Recenter — `xrDevice.recenter()`.
 *   - Head Y +/- — small step buttons because head height matters
 *     for laser angle in our menu layouts.
 *   - Aim ↑↓←→ — pitch / yaw step on the right controller (the one
 *     `xr-controllers.ts` resolves to the laser pointer in our app).
 *     Lets you re-aim onto a panel without DevUI's drag handles.
 *
 * Pose-level control beyond this is via `window.__xrEmu` from the
 * console (e.g. `__xrEmu.controllers.right.position.set(...)`).
 */
import type { XRDevice } from 'iwer';

const PANEL_ID = 'iwer-mini-panel';
const TRIGGER_BUTTON_ID = 'trigger';
const AIM_STEP_DEG = 5;

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
    width: '220px',
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
  panel.appendChild(makeStepRow('Head Y', (delta) => stepHeadY(device, delta), '−', '+', 0.05));
  panel.appendChild(makeAimRow(device));

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

function makeStepRow(
  label: string,
  onStep: (delta: number) => void,
  minus = '−',
  plus = '+',
  step = 1,
): HTMLDivElement {
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
  row.appendChild(makeButton(minus, () => onStep(-step)));
  row.appendChild(makeButton(plus, () => onStep(step)));
  return row;
}

function makeAimRow(device: XRDevice): HTMLDivElement {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: '4px',
    margin: '3px 0',
  } as Partial<CSSStyleDeclaration>);
  const tag = document.createElement('span');
  tag.textContent = 'Aim R';
  tag.style.gridColumn = '1 / span 3';
  tag.style.opacity = '0.7';
  row.appendChild(tag);
  row.appendChild(makeButton('↖', () => aimRight(device, -AIM_STEP_DEG, -AIM_STEP_DEG)));
  row.appendChild(makeButton('↑', () => aimRight(device, -AIM_STEP_DEG, 0)));
  row.appendChild(makeButton('↗', () => aimRight(device, -AIM_STEP_DEG, AIM_STEP_DEG)));
  row.appendChild(makeButton('←', () => aimRight(device, 0, -AIM_STEP_DEG)));
  row.appendChild(makeButton('•', () => resetAimRight(device)));
  row.appendChild(makeButton('→', () => aimRight(device, 0, AIM_STEP_DEG)));
  row.appendChild(makeButton('↙', () => aimRight(device, AIM_STEP_DEG, -AIM_STEP_DEG)));
  row.appendChild(makeButton('↓', () => aimRight(device, AIM_STEP_DEG, 0)));
  row.appendChild(makeButton('↘', () => aimRight(device, AIM_STEP_DEG, AIM_STEP_DEG)));
  return row;
}

/**
 * Press the trigger for ~120 ms, then release. The 'trigger' id is
 * configured with `eventTrigger: 'select'` in IWER's Quest profile,
 * so the press fires `selectstart` → `select` → `selectend` on the
 * input source, which is what `xr-controllers.ts` listens to for
 * laser-ray clicks against VR panels.
 */
function pressTrigger(device: XRDevice, hand: 'left' | 'right'): void {
  const c = device.controllers[hand];
  if (!c) {
    console.warn(`[xr-emu] no ${hand} controller`);
    return;
  }
  c.setButtonValueImmediate(TRIGGER_BUTTON_ID, 1);
  setTimeout(() => c.setButtonValueImmediate(TRIGGER_BUTTON_ID, 0), 120);
}

function stepHeadY(device: XRDevice, delta: number): void {
  device.position.y += delta;
}

/**
 * Apply a relative pitch / yaw to the right controller's existing
 * orientation. We pull the current quaternion as YXZ Euler so we can
 * tweak the human-readable axes, add the deltas, then push the new
 * Euler back. `eulerToQuat` matches `quatToEuler`'s order so this
 * round-trips cleanly.
 */
function aimRight(device: XRDevice, pitchDeg: number, yawDeg: number): void {
  applyAimDelta(device, 'right', pitchDeg, yawDeg);
}

function resetAimRight(device: XRDevice): void {
  const c = device.controllers.right;
  if (!c) return;
  c.quaternion.set(0, 0, 0, 1);
}

function applyAimDelta(
  device: XRDevice,
  hand: 'left' | 'right',
  pitchDeg: number,
  yawDeg: number,
): void {
  const c = device.controllers[hand];
  if (!c) return;
  const eulerNow = quatToEuler(c.quaternion);
  const q = eulerToQuat({
    pitch: eulerNow.pitch + pitchDeg,
    yaw: eulerNow.yaw + yawDeg,
    roll: eulerNow.roll,
  });
  c.quaternion.set(q.x, q.y, q.z, q.w);
}

interface EulerDeg {
  pitch: number;
  yaw: number;
  roll: number;
}

interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** YXZ-order quat → Euler in degrees, mirroring IWER's own helper. */
function quatToEuler(q: QuatLike): EulerDeg {
  const { x, y, z, w } = q;
  const RAD = 180 / Math.PI;
  const sinp = Math.max(-1, Math.min(1, 2 * (w * x - y * z)));
  const pitch = Math.abs(sinp) >= 1 ? (Math.sign(sinp) * Math.PI) / 2 : Math.asin(sinp);
  const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
  const roll = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
  return { pitch: pitch * RAD, yaw: yaw * RAD, roll: roll * RAD };
}

function eulerToQuat(e: EulerDeg): QuatLike {
  const RAD = Math.PI / 180;
  const cy = Math.cos((e.yaw * RAD) / 2);
  const sy = Math.sin((e.yaw * RAD) / 2);
  const cp = Math.cos((e.pitch * RAD) / 2);
  const sp = Math.sin((e.pitch * RAD) / 2);
  const cr = Math.cos((e.roll * RAD) / 2);
  const sr = Math.sin((e.roll * RAD) / 2);
  // YXZ multiply order
  return {
    x: cy * sp * cr + sy * cp * sr,
    y: sy * cp * cr - cy * sp * sr,
    z: cy * cp * sr - sy * sp * cr,
    w: cy * cp * cr + sy * sp * sr,
  };
}

