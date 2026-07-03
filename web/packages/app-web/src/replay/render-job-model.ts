/**
 * Single-flight guard for the replay → video render job.
 *
 * Why this exists: the render survives the page being frozen (Quest
 * sleeps when the headset comes off mid-render) and resumes when the
 * page thaws. A user who wakes the headset, sees a seemingly stalled
 * progress bar, and clicks Render again would previously start a
 * SECOND concurrent render — both jobs then interleave writes into the
 * same progress bar (the reported "progress jumping between two
 * points" symptom) and double the encoder memory, which Quest can't
 * afford. The state machine here makes "at most one render at a time"
 * a testable invariant instead of an accident of UI visibility.
 *
 * Tokens: every started job gets a distinct monotonic token. Progress
 * and log callbacks captured by a job's closures carry its token and
 * are dropped once the job is no longer current, so a cancelled job
 * that emits a few final events can never repaint a newer job's UI.
 * The guard must be consulted synchronously (before the first await in
 * the click handler) — two clicks in the same frame otherwise both
 * pass an async check and race each other into `renderReplayToBlob`.
 */

export interface RenderJobState {
  /** Token of the in-flight job; null when idle. */
  activeToken: number | null;
  /** Monotonic counter so every job gets a distinct token. */
  nextToken: number;
  /** Replay id the in-flight job is rendering (null when idle). */
  replayId: string | null;
}

export function idleJobState(): RenderJobState {
  return { activeToken: null, nextToken: 1, replayId: null };
}

/**
 * Reserve the render slot. Returns the running state + this job's
 * token, or null when another job already holds the slot (the caller
 * should surface the existing job's progress instead of starting).
 */
export function startJob(
  state: RenderJobState,
  replayId: string,
): { state: RenderJobState; token: number } | null {
  if (state.activeToken !== null) return null;
  const token = state.nextToken;
  return {
    state: { activeToken: token, nextToken: state.nextToken + 1, replayId },
    token,
  };
}

/**
 * Release the render slot. Only the job holding the slot may release
 * it — a stale token (a superseded job's finally block firing late)
 * must not clear a newer job's reservation.
 */
export function endJob(state: RenderJobState, token: number): RenderJobState {
  if (state.activeToken !== token) return state;
  return { ...state, activeToken: null, replayId: null };
}

/** Is `token` the job currently holding the slot? Progress/log
 * callbacks check this before touching the shared panel. */
export function isCurrentJob(state: RenderJobState, token: number): boolean {
  return state.activeToken === token;
}

export function isJobRunning(state: RenderJobState): boolean {
  return state.activeToken !== null;
}

/**
 * Throw the standard `AbortError` when the render job's signal has
 * been aborted. The render pipeline calls this at every resumption
 * point (per frame, per audio chunk, per sample preload) so a Cancel
 * click lands within milliseconds instead of after the current phase.
 */
export function throwIfRenderAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
}
