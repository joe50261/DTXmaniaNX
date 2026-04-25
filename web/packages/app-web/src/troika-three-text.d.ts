/**
 * Minimal ambient declaration for troika-three-text.
 *
 * Upstream ships JS only. We only call `Text` (extends THREE.Mesh) and
 * its setter properties; the wrapper in `hud-text.ts` narrows further.
 */
declare module 'troika-three-text' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Text: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const BatchedText: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function preloadFont(opts: any, cb?: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function configureTextBuilder(opts: any): void;
}
