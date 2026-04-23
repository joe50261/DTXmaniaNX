import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VrOnScreenLog } from './vr-on-screen-log.js';
import { appendLog, resetLogForTest } from './on-screen-log-model.js';

/**
 * Regression guard for `a3fac0f`. `show()` originally ran `paint()`
 * with `this.latest` still `[]` because `subscribeLog` doesn't replay
 * — a player entering VR with `vrLogEnabled=true` on a session that
 * already had captured console output would see a blank panel until
 * the next `console.*` fired. The fix seeds `this.latest = getLog()`
 * before subscribing.
 *
 * We only assert the observable consequence (what the panel's
 * `peekForTest()` reports) — paint-side effects need a real WebGL
 * context which happy-dom doesn't provide.
 */

// happy-dom returns null from canvas.getContext('2d'). The panel's
// constructor throws if the context is missing, so stub it to a no-op
// 2D API for the duration of this suite. Minimal surface — paint()
// goes through fillRect / fillText / etc. which we never actually
// inspect here.
beforeAll(() => {
  const ctxStub = new Proxy({} as CanvasRenderingContext2D, {
    get: (_t, prop) => (prop === 'canvas' ? null : () => {}),
  });
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, id: string): RenderingContext | null {
    return id === '2d' ? ctxStub : null;
  } as HTMLCanvasElement['getContext'];
});

afterEach(() => resetLogForTest());

describe('VrOnScreenLog.show() — seed from current ring buffer', () => {
  it('reflects entries that were captured BEFORE show()', () => {
    appendLog('info', ['pre-session']);
    appendLog('warn', ['also pre-session']);
    const panel = new VrOnScreenLog(new THREE.Scene());
    panel.show();
    const latest = panel.peekForTest();
    expect(latest).toHaveLength(2);
    expect(latest[0]?.text).toBe('pre-session');
    expect(latest[1]?.text).toBe('also pre-session');
    panel.dispose();
  });

  it('continues to reflect appends made AFTER show() (subscription still works)', () => {
    const panel = new VrOnScreenLog(new THREE.Scene());
    panel.show();
    expect(panel.peekForTest()).toHaveLength(0);
    appendLog('log', ['post-show']);
    expect(panel.peekForTest()).toHaveLength(1);
    expect(panel.peekForTest()[0]?.text).toBe('post-show');
    panel.dispose();
  });
});
