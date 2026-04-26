/**
 * Scene-state — pure model for the app's high-level scene flow.
 *
 * Mirrors the C# DTXMania `CStage` enum (`startup → title → config →
 * select → loading → play → result → end`) so the canvas sub-renderers
 * (`result-canvas`, `splash-canvas`, `playfield-canvas`, …) can branch
 * off a single, explicit field instead of inferring scene from
 * `RenderState.status` plus implicit DOM-overlay visibility.
 *
 * Stays framework-free: no THREE, no DOM, no view imports. The view
 * layer in `renderer.ts` calls `nextScene()` with the latest event and
 * paints whichever sub-canvas matches the result.
 */

export const SCENES = [
  'startup', // 01.Startup — boot splash
  'title',   // 02.Title — main menu
  'config',  // 04.Config — key assign + settings
  'select',  // 05.SongSelection — wheel
  'loading', // 06.SongLoading — between select and play
  'play',    // 07.Performance — gameplay
  'result',  // 08.Result — score / rank
  'end',     // 09.End — exit splash
] as const;

export type Scene = (typeof SCENES)[number];

/**
 * Discrete events that drive scene transitions. Kept narrow on purpose —
 * input-layer modules translate raw key/controller/UI events into one
 * of these tags before calling `nextScene()`.
 */
export type SceneEvent =
  | { kind: 'boot-complete' }       // startup → title
  | { kind: 'menu-play' }            // title → select
  | { kind: 'menu-config' }          // title → config
  | { kind: 'menu-exit' }            // title → end
  | { kind: 'config-back' }          // config → title
  | { kind: 'song-picked' }          // select → loading
  | { kind: 'song-loaded' }          // loading → play
  | { kind: 'song-load-failed' }     // loading → select
  | { kind: 'play-finished' }        // play → result
  | { kind: 'play-cancelled' }       // play → select
  | { kind: 'result-dismissed' }     // result → select
  | { kind: 'select-back' }          // select → title
  | { kind: 'reset' };               // any → startup

/**
 * Pure transition function. Returns the next scene, or the same scene
 * if the event isn't valid for the current state. Callers don't need
 * to do their own gating — feed every input event through this and
 * read the result.
 *
 * Invalid pairs are intentionally a no-op (instead of throwing) so a
 * lagging input thread can't crash the app. Callers that want to
 * detect ignored events can compare `next === current` afterwards.
 */
export function nextScene(current: Scene, event: SceneEvent): Scene {
  if (event.kind === 'reset') return 'startup';

  switch (current) {
    case 'startup':
      if (event.kind === 'boot-complete') return 'title';
      return current;

    case 'title':
      if (event.kind === 'menu-play') return 'select';
      if (event.kind === 'menu-config') return 'config';
      if (event.kind === 'menu-exit') return 'end';
      return current;

    case 'config':
      if (event.kind === 'config-back') return 'title';
      return current;

    case 'select':
      if (event.kind === 'song-picked') return 'loading';
      if (event.kind === 'select-back') return 'title';
      return current;

    case 'loading':
      if (event.kind === 'song-loaded') return 'play';
      if (event.kind === 'song-load-failed') return 'select';
      return current;

    case 'play':
      if (event.kind === 'play-finished') return 'result';
      if (event.kind === 'play-cancelled') return 'select';
      return current;

    case 'result':
      if (event.kind === 'result-dismissed') return 'select';
      return current;

    case 'end':
      // Terminal: only `reset` (handled above) leaves end.
      return current;
  }
}

/**
 * Whether a scene paints the gameplay HUD (chips, judgement, gauge).
 * Used by the renderer to decide between play-time sub-canvases and
 * the splash/result paints. `play` is the only "true" gameplay state;
 * `loading` and `result` overlay on top but the HUD itself is dormant.
 */
export function isGameplayScene(scene: Scene): boolean {
  return scene === 'play';
}

/**
 * Whether a scene wants the desktop DOM overlay (`#overlay`) shown.
 * The overlay houses the song-pick / settings buttons; everything
 * else either hides it (gameplay) or is itself a canvas-only splash.
 */
export function wantsDesktopOverlay(scene: Scene): boolean {
  return scene === 'select';
}
