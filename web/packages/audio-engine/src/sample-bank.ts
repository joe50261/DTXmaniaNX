/**
 * Async-decoded sample store for arbitrary WAV/OGG/MP3 files. Primary use is
 * BGM chip playback for DTX charts (channel 0x01 samples).
 *
 * The bank is intentionally decoupled from any filesystem backend — callers
 * provide a loader function that returns the raw bytes for a given path.
 * That keeps @dtxmania/audio-engine free of dependencies on dtx-core's
 * FileSystemBackend abstraction or the PWA's FSA wrapper.
 *
 * Responses are cached by path so repeated loads within the same song (or
 * subsequent plays of the same chart) reuse the AudioBuffer.
 */
export type SampleLoader = (path: string) => Promise<ArrayBuffer>;

export class SampleBank {
  private readonly cache = new Map<string, Promise<AudioBuffer | null>>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly loader: SampleLoader
  ) {}

  load(path: string): Promise<AudioBuffer | null> {
    let p = this.cache.get(path);
    if (!p) {
      p = this.loadFresh(path);
      this.cache.set(path, p);
    }
    return p;
  }

  private async loadFresh(path: string): Promise<AudioBuffer | null> {
    try {
      const bytes = await this.loader(path);
      // decodeAudioData mutates / detaches the passed buffer in some browsers,
      // so hand it a fresh copy to keep the loader's return value reusable.
      return await this.ctx.decodeAudioData(bytes.slice(0));
    } catch (e) {
      console.warn('[SampleBank] failed to load', path, e);
      return null;
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
