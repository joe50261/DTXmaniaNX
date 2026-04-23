import {
  appendLog,
  formatLogEntry,
  getLog,
  installConsoleHook,
  LOG_LEVEL_COLOR,
  LOG_MAX_ROWS,
  subscribeLog,
  type LogEntry,
} from './on-screen-log-model.js';

/**
 * On-screen console log panel — DOM view.
 *
 * Quest Browser has no DevTools, so `console.info` / `console.warn`
 * sprinkled through the XR lifecycle can't be read without a USB
 * debugger the player likely doesn't have. This mirror is pinned to
 * the bottom-left of the viewport so diagnostics are visible in-page.
 *
 * The ring buffer + console hook live in `on-screen-log-model.ts`;
 * this module just paints subscribed updates into the DOM. A parallel
 * VR view (`vr-on-screen-log.ts`) subscribes to the same model so both
 * surfaces stay in lock-step.
 */

export function installOnScreenLog(): void {
  installConsoleHook();

  const panel = document.createElement('div');
  panel.id = 'on-screen-log';
  document.body.appendChild(panel);

  // Render the live buffer on each update. Rebuilding the whole DOM
  // subtree is cheap at MAX_ROWS = 80 and avoids the fiddly bookkeeping
  // of diffing by index — the old implementation mutated children
  // directly, which also worked but scaled worse if MAX_ROWS grows.
  const render = (entries: readonly LogEntry[]): void => {
    panel.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('div');
      row.style.color = LOG_LEVEL_COLOR[entry.level];
      row.style.whiteSpace = 'pre-wrap';
      row.style.wordBreak = 'break-word';
      row.style.lineHeight = '1.35';
      row.textContent = formatLogEntry(entry);
      panel.appendChild(row);
    }
    panel.scrollTop = panel.scrollHeight;
  };

  subscribeLog(render);
  render(getLog());

  appendLog('info', ['[log] on-screen console installed']);
  void LOG_MAX_ROWS;
}
