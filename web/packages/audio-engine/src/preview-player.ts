/**
 * Song-select preview audio player. Loads the DTXmania `#PREVIEW` WAV,
 * plays it on a loop with fade-in, and fades-out on stop / replace.
 *
 * DTXmania's canonical behaviour (CActSelectPresound.cs):
 *   - Start on song focus, with a short delay to avoid thrashing when
 *     the wheel is scrolled fast.
 *   - Loop indefinitely.
 *   - Fade-out main BGM while preview is active; we have no ambient BGM
 *     to duck, so skip that half.
 *   - Cut when another preview is requested, or when the player picks.
 */
export class PreviewPlayer {
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** Buffer cache keyed by path so scrolling back to a recently-visited
   * song doesn't re-fetch / re-decode the WAV. Trimmed at runtime to the
   * `cacheLimit` most recently used paths. */
  private readonly cache = new Map<string, AudioBuffer>();
  private readonly cacheLimit = 8;
  /** Monotonic token so a late-returning load() can detect that it was
   * pre-empted by a newer request and skip starting playback. */
  private requestId = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly loader: (path: string) => Promise<ArrayBuffer>
  ) {}

  /**
   * Load and start looping `path` at `volume` (0..1). Any previously-
   * playing preview is faded out. Cheap no-op if `path` is already the
   * current preview. If decode fails, logs a warning and silently stops.
   */
  async play(path: string, volume = 0.7): Promise<void> {
    const myId = ++this.requestId;
    this.stopInternal(200);

    let buf = this.cache.get(path);
    if (!buf) {
      try {
        const raw = await this.loader(path);
        buf = await this.ctx.decodeAudioData(raw.slice(0));
      } catch (e) {
        console.warn('[preview] load failed', path, e);
        return;
      }
      this.cache.set(path, buf);
      this.trimCache();
    }

    // A newer play() call landed while we were fetching — abandon.
    if (myId !== this.requestId) return;
    if (this.ctx.state === 'suspended') {
      // The AudioContext can't start until a user gesture; wait rather
      // than throw. The wheel's own click/keydown counts as a gesture,
      // so this resumes on first user action.
      try {
        await this.ctx.resume();
      } catch {
        return;
      }
      if (myId !== this.requestId) return;
    }

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + 0.15);
    gain.connect(this.ctx.destination);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain);
    src.start();

    this.source = src;
    this.gain = gain;
  }

  /** Fade out + stop the current preview. Safe to call when nothing is
   * playing. */
  stop(fadeMs = 200): void {
    this.requestId++;
    this.stopInternal(fadeMs);
  }

  private stopInternal(fadeMs: number): void {
    const src = this.source;
    const gain = this.gain;
    this.source = null;
    this.gain = null;
    if (!src || !gain) return;
    const now = this.ctx.currentTime;
    const end = now + Math.max(0.01, fadeMs / 1000);
    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, end);
      src.stop(end + 0.02);
    } catch {
      // source may already be stopped — swallow
    }
  }

  private trimCache(): void {
    while (this.cache.size > this.cacheLimit) {
      // Maps preserve insertion order; drop the oldest entry.
      const firstKey = this.cache.keys().next().value;
      if (firstKey === undefined) break;
      this.cache.delete(firstKey);
    }
  }
}
