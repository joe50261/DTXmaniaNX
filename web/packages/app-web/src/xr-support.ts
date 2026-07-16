/**
 * Memoized immersive-vr support probe.
 *
 * `refreshXrButton` in main.ts runs on every library scan, chart
 * start, and VR exit — previously each call re-ran
 * `navigator.xr.isSessionSupported()` and logged the result, filling
 * the console (and the on-screen log) with identical
 * `isSessionSupported(immersive-vr) = false` rows on desktop.
 *
 * The probe caches the answer and logs only when it CHANGES. Support
 * genuinely can change mid-session (headset plugged in / taken off),
 * which is what the XRSystem `devicechange` event signals — main.ts
 * calls `invalidate()` from that listener so the next query re-asks
 * the browser.
 */

/** The slice of XRSystem we use — injectable for tests. */
export interface XrSystemLike {
  isSessionSupported(mode: 'immersive-vr'): Promise<boolean>;
}

export interface XrSupportLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface XrSupportProbe {
  /** Resolves whether immersive-vr is supported. Cached after the
   * first resolution; concurrent callers share one in-flight query. */
  query(): Promise<boolean>;
  /** Drops the cache so the next query re-asks the browser. Wire to
   * XRSystem's `devicechange`. */
  invalidate(): void;
}

export function createXrSupportProbe(
  xr: XrSystemLike | undefined | null,
  log: XrSupportLogger
): XrSupportProbe {
  let inflight: Promise<boolean> | null = null;
  let lastLogged: boolean | null = null;

  return {
    query(): Promise<boolean> {
      if (!xr) return Promise.resolve(false);
      if (inflight) return inflight;
      inflight = xr.isSessionSupported('immersive-vr').then(
        (supported) => {
          if (supported !== lastLogged) {
            log.info('[xr] isSessionSupported(immersive-vr) =', supported);
            lastLogged = supported;
          }
          return supported;
        },
        (e: unknown) => {
          // Failure is cached as "unsupported" too (invalidate() clears
          // it) — re-querying a throwing browser API on every UI refresh
          // would just spam the same warning.
          log.warn('[xr] isSessionSupported threw', e);
          lastLogged = null;
          return false;
        }
      );
      return inflight;
    },
    invalidate(): void {
      inflight = null;
    },
  };
}
