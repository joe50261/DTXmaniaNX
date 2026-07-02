/**
 * Screen wake lock for the render job.
 *
 * The render workflow the user actually runs: click Render, take the
 * headset off, come back later. Without a wake lock the display (and
 * on Quest, the whole device) sleeps shortly after, the page freezes,
 * and the render sits half-done until the next wake. Holding a screen
 * wake lock while a render is in flight keeps the device awake where
 * the platform allows it, so the render can actually finish unattended.
 *
 * Platform reality check (why this is best-effort, not a guarantee):
 * the UA auto-releases the sentinel whenever the page is hidden, and
 * Quest's proximity sensor blanks the screen the moment the headset
 * comes off regardless of any lock. So this helper (a) re-acquires on
 * every visibilitychange → visible while a job wants the lock, and
 * (b) never treats a failed request as an error — the render itself
 * pauses/resumes safely (see render.ts context-loss handling); the
 * lock just widens the window in which it keeps running.
 *
 * Deps are injected so the retry/ownership logic is unit-testable
 * without a real `navigator.wakeLock` (which happy-dom doesn't ship).
 */

export interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export interface RenderWakeLockDeps {
  /** `() => navigator.wakeLock.request('screen')`, or null when the
   * platform doesn't expose the API. */
  request: (() => Promise<WakeLockSentinelLike>) | null;
  /** Subscribe to "page became visible" — returns the unsubscriber. */
  subscribeVisible: (cb: () => void) => () => void;
}

export function browserWakeLockDeps(): RenderWakeLockDeps {
  const wakeLock = typeof navigator !== 'undefined' ? navigator.wakeLock : undefined;
  return {
    request: wakeLock ? () => wakeLock.request('screen') : null,
    subscribeVisible: (cb) => {
      const handler = (): void => {
        if (document.visibilityState === 'visible') cb();
      };
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },
  };
}

export class RenderWakeLock {
  private readonly deps: RenderWakeLockDeps;
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;
  private unsubscribe: (() => void) | null = null;
  private log: ((line: string) => void) | undefined;
  private loggedAcquired = false;

  constructor(deps: RenderWakeLockDeps = browserWakeLockDeps()) {
    this.deps = deps;
  }

  /** Hold a screen wake lock until `release()`. Auto re-acquires each
   * time the page becomes visible again (the UA drops the sentinel on
   * hide). Never throws — an unsupported / denied lock only logs. */
  async acquire(log?: (line: string) => void): Promise<void> {
    this.wanted = true;
    this.log = log;
    this.loggedAcquired = false;
    if (!this.deps.request) {
      log?.('Screen wake lock unsupported here — the device may sleep mid-render.');
      return;
    }
    this.unsubscribe ??= this.deps.subscribeVisible(() => {
      void this.requestNow();
    });
    await this.requestNow();
  }

  /** Stop wanting the lock and release any held sentinel. Safe to call
   * without a prior `acquire()` and safe to call twice. */
  async release(): Promise<void> {
    this.wanted = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const s = this.sentinel;
    this.sentinel = null;
    this.log = undefined;
    if (s) {
      try {
        await s.release();
      } catch {
        /* already released by the UA */
      }
    }
  }

  private async requestNow(): Promise<void> {
    if (!this.wanted || !this.deps.request) return;
    // Drop any stale sentinel first — after a hide/show cycle the UA
    // has usually released it already; releasing twice is harmless.
    const stale = this.sentinel;
    this.sentinel = null;
    if (stale) {
      try {
        await stale.release();
      } catch {
        /* already released */
      }
    }
    // `release()` may have run while we awaited the stale release.
    if (!this.wanted) return;
    try {
      this.sentinel = await this.deps.request();
      if (!this.loggedAcquired) {
        this.loggedAcquired = true;
        this.log?.('Screen wake lock held — device stays awake while rendering.');
      }
      // A release() racing the request above must not leak the lock.
      if (!this.wanted) void this.sentinel?.release().catch(() => undefined);
    } catch {
      // NotAllowedError while the page is hidden is the normal case;
      // the visibility subscription retries on the next show.
    }
  }
}
