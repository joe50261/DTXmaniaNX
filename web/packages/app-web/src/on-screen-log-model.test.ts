import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendLog,
  formatLogEntry,
  getLog,
  LOG_LEVEL_COLOR,
  LOG_MAX_ROWS,
  resetLogForTest,
  subscribeLog,
  type LogEntry,
} from './on-screen-log-model.js';

/**
 * The model is a module-level singleton. Reset between tests so
 * ordering doesn't matter — we assert on its contents, not on
 * accumulation across cases.
 */
afterEach(() => resetLogForTest());

describe('on-screen-log-model — ring buffer', () => {
  it('starts empty', () => {
    expect(getLog()).toHaveLength(0);
  });

  it('appendLog adds an entry with timestamp + level + text', () => {
    appendLog('info', ['hello', 42]);
    const log = getLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.level).toBe('info');
    expect(log[0]?.text).toBe('hello 42');
    expect(log[0]?.timestamp).toBeGreaterThan(0);
  });

  it('concatenates multi-arg messages with spaces and stringifies objects', () => {
    appendLog('log', ['count:', { n: 3 }, 'done']);
    expect(getLog()[0]?.text).toBe('count: {"n":3} done');
  });

  it('renders Error instances as "Name: message" without serialising internals', () => {
    appendLog('error', [new TypeError('bad thing')]);
    expect(getLog()[0]?.text).toBe('TypeError: bad thing');
  });

  it('caps the buffer at LOG_MAX_ROWS; oldest entries fall off the front', () => {
    for (let i = 0; i < LOG_MAX_ROWS + 5; i++) appendLog('log', [`n${i}`]);
    const log = getLog();
    expect(log).toHaveLength(LOG_MAX_ROWS);
    // The first kept entry should be the 5th one we appended (0..4 fell off).
    expect(log[0]?.text).toBe('n5');
    expect(log[log.length - 1]?.text).toBe(`n${LOG_MAX_ROWS + 4}`);
  });
});

describe('subscribeLog', () => {
  it('fires on every append with the current buffer', () => {
    const seen: LogEntry[][] = [];
    const unsub = subscribeLog((entries) => seen.push([...entries]));
    appendLog('log', ['one']);
    appendLog('warn', ['two']);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toHaveLength(2);
    expect(seen[1]![0]?.text).toBe('one');
    expect(seen[1]![1]?.level).toBe('warn');
    unsub();
  });

  it('unsubscribe stops further notifications', () => {
    const cb = vi.fn();
    const unsub = subscribeLog(cb);
    appendLog('log', ['first']);
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    appendLog('log', ['second']);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('formatLogEntry + LOG_LEVEL_COLOR', () => {
  it('formats a single line with HH:MM:SS.mmm timestamp, padded level, and text', () => {
    const e: LogEntry = {
      timestamp: Date.UTC(2025, 0, 2, 3, 4, 5, 678),
      level: 'warn',
      text: 'something fishy',
    };
    expect(formatLogEntry(e)).toBe('03:04:05.678 warn  something fishy');
  });

  it('exposes a colour for every log level', () => {
    for (const lvl of ['log', 'info', 'warn', 'error'] as const) {
      expect(LOG_LEVEL_COLOR[lvl]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
