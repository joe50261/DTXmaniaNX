/**
 * Splash-canvas geometry + timing constants. Pure data — no THREE,
 * no DOM. Source of truth: `splash-design.md`. Reused across
 * startup / title / loading / end scenes via a parameterised
 * constructor in `splash-canvas.ts`.
 */

export const SPLASH_CANVAS_W = 1280;
export const SPLASH_CANVAS_H = 720;

/** Per-scene timing tuple. `holdMs === Infinity` means "hold until
 *  the scene state machine fires the next transition". */
export interface SplashTiming {
  fadeInMs: number;
  /** Time the scene rests at full opacity. Infinity = no auto-exit. */
  holdMs: number;
  fadeOutMs: number;
}

export const STARTUP_TIMING: SplashTiming = {
  fadeInMs: 200,
  holdMs: 1500,
  fadeOutMs: 400,
};

export const TITLE_TIMING: SplashTiming = {
  fadeInMs: 300,
  holdMs: Number.POSITIVE_INFINITY,
  fadeOutMs: 0,
};

export const LOADING_TIMING: SplashTiming = {
  fadeInMs: 0,
  holdMs: Number.POSITIVE_INFINITY,
  fadeOutMs: 200,
};

export const END_TIMING: SplashTiming = {
  fadeInMs: 0,
  holdMs: 800,
  fadeOutMs: 400,
};

/**
 * Discrete phases produced by `splashPhase()`. The view paints
 * differently in each:
 *   - `'fade-in'`   : background + glyph at α = progress
 *   - `'hold'`      : full-opacity steady state
 *   - `'fade-out'`  : α = 1 − progress
 *   - `'done'`      : nothing painted; scene ready to dismiss
 */
export type SplashPhase = 'fade-in' | 'hold' | 'fade-out' | 'done';

export interface SplashPhaseInfo {
  phase: SplashPhase;
  /** 0..1 within the current phase. Meaningless in `'hold'` /
   *  `'done'` (returned as 1). */
  progress: number;
}

/**
 * Resolve which phase the splash is in given an elapsed time and a
 * timing tuple. The fade-out clock is gated on an explicit
 * `exitRequested` flag (set by the host when the scene state
 * machine wants the splash dismissed) so a `holdMs = Infinity`
 * scene can still finish gracefully.
 *
 * `elapsedMs` is "ms since `start()`" — same convention as
 * `result-animations.rankReveal`.
 */
export function splashPhase(
  elapsedMs: number,
  timing: SplashTiming,
  exitRequested: boolean,
  exitRequestedAtMs: number
): SplashPhaseInfo {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { phase: 'fade-in', progress: 0 };
  }

  if (timing.fadeInMs > 0 && elapsedMs < timing.fadeInMs) {
    return { phase: 'fade-in', progress: elapsedMs / timing.fadeInMs };
  }

  // Hold/fade-out gate. If the host hasn't requested an exit AND
  // holdMs is finite, auto-exit when elapsed exceeds fadeIn + hold.
  const autoExitAt =
    timing.holdMs === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : timing.fadeInMs + timing.holdMs;

  if (!exitRequested && elapsedMs < autoExitAt) {
    return { phase: 'hold', progress: 1 };
  }

  // Pick the moment fade-out starts: explicit request wins over
  // auto-exit so a host that calls requestExit() early still gets a
  // proper fade.
  const exitAt = exitRequested
    ? Math.max(exitRequestedAtMs, timing.fadeInMs)
    : autoExitAt;

  if (timing.fadeOutMs <= 0) {
    // No fade-out phase: snap to done at the exit point.
    return { phase: 'done', progress: 1 };
  }

  const sinceExit = elapsedMs - exitAt;
  if (sinceExit < timing.fadeOutMs) {
    return { phase: 'fade-out', progress: sinceExit / timing.fadeOutMs };
  }
  return { phase: 'done', progress: 1 };
}

/**
 * Resolve the rendered alpha for the splash given a phase. Pulled
 * out so the canvas paint can be a one-line `ctx.globalAlpha = …`.
 */
export function splashAlpha(info: SplashPhaseInfo): number {
  switch (info.phase) {
    case 'fade-in':  return info.progress;
    case 'hold':     return 1;
    case 'fade-out': return 1 - info.progress;
    case 'done':     return 0;
  }
}
