import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPlayer } from './preview-player.js';

/**
 * Mock enough of AudioContext for PreviewPlayer's pipeline:
 *   createGain — for fade envelope
 *   createBufferSource — for looping playback
 *   decodeAudioData — for load
 *   resume / state — for suspend handling
 *   currentTime — for fade scheduling
 *
 * We record buffer-source lifecycle (start/stop/connect) so tests can
 * assert pre-emption, cache hits, and stop behaviour without an actual
 * AudioContext.
 */

interface MockSource {
  buffer: AudioBuffer | null;
  loop: boolean;
  started: boolean;
  stoppedAt: number | null;
  connectTargets: unknown[];
}

interface MockGain {
  value: number;
  connectTargets: unknown[];
  schedule: Array<{ op: string; value?: number; when: number }>;
  cancelled: boolean;
}

function makeMockCtx() {
  let currentTime = 0;
  let state: 'running' | 'suspended' = 'running';
  const destination = { __isDestination: true };
  const gains: MockGain[] = [];
  const sources: MockSource[] = [];
  const decodeCalls: ArrayBuffer[] = [];

  const createGain = () => {
    const g: MockGain = {
      value: 0,
      connectTargets: [],
      schedule: [],
      cancelled: false,
    };
    gains.push(g);
    const api = {
      gain: {
        get value() {
          return g.value;
        },
        set value(v: number) {
          g.value = v;
        },
        setValueAtTime(v: number, when: number) {
          g.value = v;
          g.schedule.push({ op: 'set', value: v, when });
        },
        linearRampToValueAtTime(v: number, when: number) {
          g.value = v;
          g.schedule.push({ op: 'ramp', value: v, when });
        },
        cancelScheduledValues(when: number) {
          g.cancelled = true;
          g.schedule.push({ op: 'cancel', when });
        },
      },
      connect(target: unknown) {
        g.connectTargets.push(target);
      },
      _state: g,
    };
    return api;
  };

  const createBufferSource = () => {
    const s: MockSource = {
      buffer: null,
      loop: false,
      started: false,
      stoppedAt: null,
      connectTargets: [],
    };
    sources.push(s);
    return {
      get buffer() {
        return s.buffer;
      },
      set buffer(b: AudioBuffer | null) {
        s.buffer = b;
      },
      get loop() {
        return s.loop;
      },
      set loop(v: boolean) {
        s.loop = v;
      },
      connect(target: unknown) {
        s.connectTargets.push(target);
      },
      start() {
        s.started = true;
      },
      stop(when?: number) {
        s.stoppedAt = when ?? currentTime;
      },
      _state: s,
    };
  };

  const decodeAudioData = vi.fn(async (bytes: ArrayBuffer): Promise<AudioBuffer> => {
    decodeCalls.push(bytes);
    // Tag the buffer with its byte-length so tests can verify identity
    // without a real AudioBuffer API.
    return { __tag: bytes.byteLength } as unknown as AudioBuffer;
  });

  const resume = vi.fn(async () => {
    state = 'running';
  });

  return {
    ctx: {
      createGain,
      createBufferSource,
      decodeAudioData,
      get currentTime() {
        return currentTime;
      },
      get state() {
        return state;
      },
      resume,
      destination,
    } as unknown as AudioContext,
    gains,
    sources,
    decodeCalls,
    resumeCalls: resume,
    advance(seconds: number) {
      currentTime += seconds;
    },
    setSuspended() {
      state = 'suspended';
    },
    destination,
  };
}

describe('PreviewPlayer', () => {
  let mock: ReturnType<typeof makeMockCtx>;
  let loader: ReturnType<typeof vi.fn>;
  let player: PreviewPlayer;

  beforeEach(() => {
    mock = makeMockCtx();
    loader = vi.fn(async (path: string) => {
      // Each path gets a unique byte-length so tests can tell buffers apart.
      return new ArrayBuffer(path.length);
    });
    player = new PreviewPlayer(mock.ctx, loader, mock.destination as unknown as AudioNode);
  });

  it('play() fetches, decodes, and starts a looping source connected to the given destination', async () => {
    await player.play('song-a.wav', 0.5);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(mock.decodeCalls).toHaveLength(1);
    expect(mock.sources).toHaveLength(1);
    const src = mock.sources[0]!;
    expect(src.started).toBe(true);
    expect(src.loop).toBe(true);
    expect(src.buffer).not.toBeNull();
    // Source connects to the gain; gain connects to the player's destination.
    expect(mock.gains).toHaveLength(1);
    expect(mock.gains[0]!.connectTargets).toContain(mock.destination);
  });

  it('caches decoded buffers by path — second play of the same path does not re-decode', async () => {
    await player.play('song-a.wav');
    await player.play('song-b.wav');
    await player.play('song-a.wav'); // cache hit
    expect(loader).toHaveBeenCalledTimes(2);
    expect(mock.decodeCalls).toHaveLength(2);
  });

  it('fades in with a linear ramp to the requested volume', async () => {
    await player.play('song-a.wav', 0.4);
    const fadeIn = mock.gains[0]!.schedule;
    // setValueAtTime(0, now), then linearRampToValueAtTime(0.4, now + 0.15).
    expect(fadeIn[0]).toMatchObject({ op: 'set', value: 0 });
    expect(fadeIn[1]).toMatchObject({ op: 'ramp', value: 0.4 });
  });

  it('request-ID pre-emption: a newer play() during decode cancels the older', async () => {
    // Block the loader for song-a until after song-b completes; without
    // the requestId guard, song-a would still start playback after
    // song-b, layering two loops.
    let releaseA: () => void = () => {};
    const aPromise = new Promise<ArrayBuffer>((resolve) => {
      releaseA = () => resolve(new ArrayBuffer(1));
    });
    loader.mockImplementationOnce(() => aPromise);

    const pA = player.play('song-a.wav');
    const pB = player.play('song-b.wav');
    await pB;
    releaseA();
    await pA;

    // Exactly one source should have started — song-b's. Song-a's
    // play() aborted before constructing a source.
    const startedBuffers = mock.sources.filter((s) => s.started).map((s) => s.buffer);
    expect(startedBuffers).toHaveLength(1);
  });

  it('stop() fades out and schedules stop on the source', async () => {
    await player.play('song-a.wav');
    const gain = mock.gains[0]!;
    const src = mock.sources[0]!;
    mock.advance(0.5);
    player.stop(250);
    // Schedule should have a cancel + a ramp-to-0 at now + 0.25.
    const ops = gain.schedule.map((s) => s.op);
    expect(ops).toContain('cancel');
    expect(ops).toContain('ramp');
    const lastRamp = [...gain.schedule].reverse().find((s) => s.op === 'ramp')!;
    expect(lastRamp.value).toBe(0);
    expect(lastRamp.when).toBeCloseTo(0.75, 5);
    expect(src.stoppedAt).not.toBeNull();
  });

  it('stop() is a no-op when nothing is playing', async () => {
    // Must not throw, must not touch unrelated state.
    player.stop();
    expect(mock.sources).toHaveLength(0);
    expect(mock.gains).toHaveLength(0);
  });

  it('loader throws → play() returns without starting a source (silent-fail)', async () => {
    loader.mockRejectedValueOnce(new Error('404'));
    await player.play('missing.wav');
    expect(mock.sources).toHaveLength(0);
  });

  it('decodeAudioData throws → silent-fail, nothing played', async () => {
    (mock.ctx.decodeAudioData as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('corrupt')
    );
    await player.play('broken.wav');
    expect(mock.sources).toHaveLength(0);
  });

  it('a stop() between two plays results in exactly one active source (no layering)', async () => {
    await player.play('a.wav');
    player.stop();
    await player.play('b.wav');
    // Two sources created over the run, but the first was stopped.
    expect(mock.sources).toHaveLength(2);
    expect(mock.sources[0]!.stoppedAt).not.toBeNull();
    expect(mock.sources[1]!.started).toBe(true);
  });

  it('LRU cache trims to 8 entries — the oldest path is evicted and re-decoded if requested again', async () => {
    // Load 9 distinct paths; the first should no longer be cached.
    for (let i = 0; i < 9; i++) {
      await player.play(`song-${i}.wav`);
    }
    expect(loader).toHaveBeenCalledTimes(9);

    // Now re-play song-0 — it was evicted, so the loader fires again.
    await player.play('song-0.wav');
    expect(loader).toHaveBeenCalledTimes(10);

    // But song-5 is still cached (it's within the last 8 after the
    // first eviction).
    await player.play('song-5.wav');
    expect(loader).toHaveBeenCalledTimes(10);
  });

  it('resumes a suspended AudioContext before starting playback', async () => {
    mock.setSuspended();
    await player.play('song-a.wav');
    expect(mock.resumeCalls).toHaveBeenCalled();
    expect(mock.sources[0]?.started).toBe(true);
  });

  it('ctx.resume() rejection aborts playback without starting a source', async () => {
    mock.setSuspended();
    (mock.ctx.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no gesture'));
    await player.play('song-a.wav');
    expect(mock.sources).toHaveLength(0);
  });
});
