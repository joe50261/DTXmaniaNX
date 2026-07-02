import { describe, it, expect, vi } from 'vitest';
import { RenderWakeLock, type RenderWakeLockDeps, type WakeLockSentinelLike } from './wake-lock.js';

interface Harness {
  lock: RenderWakeLock;
  deps: RenderWakeLockDeps;
  requests: Array<{ sentinel: WakeLockSentinelLike; released: () => boolean }>;
  fireVisible: () => void;
  subscriberCount: () => number;
}

function harness(over: Partial<RenderWakeLockDeps> = {}): Harness {
  const requests: Harness['requests'] = [];
  const visibleCbs = new Set<() => void>();
  const deps: RenderWakeLockDeps = {
    request: () => {
      let released = false;
      const sentinel: WakeLockSentinelLike = {
        release: () => {
          released = true;
          return Promise.resolve();
        },
      };
      requests.push({ sentinel, released: () => released });
      return Promise.resolve(sentinel);
    },
    subscribeVisible: (cb) => {
      visibleCbs.add(cb);
      return () => visibleCbs.delete(cb);
    },
    ...over,
  };
  return {
    lock: new RenderWakeLock(deps),
    deps,
    requests,
    fireVisible: () => {
      for (const cb of [...visibleCbs]) cb();
    },
    subscriberCount: () => visibleCbs.size,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('RenderWakeLock', () => {
  it('acquire requests a sentinel and logs once', async () => {
    const h = harness();
    const log = vi.fn();
    await h.lock.acquire(log);
    expect(h.requests).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      'Screen wake lock held — device stays awake while rendering.',
    );
  });

  it('unsupported platform logs a hint and never throws', async () => {
    const h = harness({ request: null });
    const log = vi.fn();
    await h.lock.acquire(log);
    await h.lock.release();
    expect(log).toHaveBeenCalledWith(
      'Screen wake lock unsupported here — the device may sleep mid-render.',
    );
    expect(h.requests).toHaveLength(0);
  });

  it('re-acquires when the page becomes visible while a job holds it', async () => {
    const h = harness();
    await h.lock.acquire();
    expect(h.requests).toHaveLength(1);
    // UA released the sentinel on hide; show fires the subscription.
    h.fireVisible();
    await flush();
    expect(h.requests).toHaveLength(2);
    // The stale first sentinel was released defensively.
    expect(h.requests[0]!.released()).toBe(true);
  });

  it('re-acquire logs only once per acquire (no spam on every wake)', async () => {
    const h = harness();
    const log = vi.fn();
    await h.lock.acquire(log);
    h.fireVisible();
    await flush();
    h.fireVisible();
    await flush();
    const acquiredLines = log.mock.calls.filter(([l]) =>
      String(l).startsWith('Screen wake lock held'),
    );
    expect(acquiredLines).toHaveLength(1);
  });

  it('release drops the sentinel, unsubscribes, and stops re-acquiring', async () => {
    const h = harness();
    await h.lock.acquire();
    await h.lock.release();
    expect(h.requests[0]!.released()).toBe(true);
    expect(h.subscriberCount()).toBe(0);
    h.fireVisible();
    await flush();
    expect(h.requests).toHaveLength(1);
  });

  it('release without acquire and double release are safe', async () => {
    const h = harness();
    await expect(h.lock.release()).resolves.toBeUndefined();
    await h.lock.acquire();
    await h.lock.release();
    await expect(h.lock.release()).resolves.toBeUndefined();
  });

  it('a rejected request (hidden page) is swallowed and retried on visible', async () => {
    let fail = true;
    const h = harness();
    const realRequest = h.deps.request!;
    h.deps.request = () =>
      fail ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : realRequest();
    await h.lock.acquire();
    expect(h.requests).toHaveLength(0);
    fail = false;
    h.fireVisible();
    await flush();
    expect(h.requests).toHaveLength(1);
  });

  it('a release racing an in-flight request does not leak the lock', async () => {
    let resolveRequest: ((s: WakeLockSentinelLike) => void) | null = null;
    let released = false;
    const h = harness({
      request: () =>
        new Promise<WakeLockSentinelLike>((r) => {
          resolveRequest = r;
        }),
    });
    const acquireP = h.lock.acquire();
    await h.lock.release();
    resolveRequest!({
      release: () => {
        released = true;
        return Promise.resolve();
      },
    });
    await acquireP;
    await flush();
    expect(released).toBe(true);
  });
});
