import {
  type DirEntry,
  type FileSystemBackend,
} from '../../src/scanner/fs-backend.js';

/**
 * Instrumented FileSystemBackend wrappers used by scanner optimization
 * tests. Each wrapper forwards to an inner backend (typically a
 * MemoryFs) and adds a specific cross-cutting concern:
 *
 *   CountingFs   — records how many times each method was invoked and
 *                  with what path, so tests can assert "the same dir
 *                  was not listed twice" without timing sensitivity.
 *   SlowFs       — adds a fixed per-call delay and tracks the maximum
 *                  number of in-flight calls, so tests can assert that
 *                  the scanner actually runs I/O in parallel.
 *   RandomSlowFs — same idea but with per-call random delays (seeded),
 *                  for stress-testing that parallel completion order
 *                  does not leak into the scanner's output ordering.
 *   ThrowingFs   — injects a specific error on specific paths, for
 *                  verifying that a sibling failure does not serialise
 *                  or abort the rest of the parallel walk.
 */

type Call = { method: string; path: string };

export class CountingFs implements FileSystemBackend {
  readonly calls: Call[] = [];

  constructor(private readonly inner: FileSystemBackend) {}

  count(method: string, path?: string): number {
    return this.calls.filter(
      (c) => c.method === method && (path === undefined || c.path === path)
    ).length;
  }

  async listDir(path: string): Promise<DirEntry[]> {
    this.calls.push({ method: 'listDir', path });
    return this.inner.listDir(path);
  }
  async readFile(path: string): Promise<ArrayBuffer> {
    this.calls.push({ method: 'readFile', path });
    return this.inner.readFile(path);
  }
  async readText(path: string, encoding?: string): Promise<string> {
    this.calls.push({ method: 'readText', path });
    return this.inner.readText(path, encoding);
  }
  async exists(path: string): Promise<boolean> {
    this.calls.push({ method: 'exists', path });
    return this.inner.exists(path);
  }
}

export class SlowFs implements FileSystemBackend {
  inflight = 0;
  inflightMax = 0;
  /** Calls made while `inflight > 1`, i.e. actually overlapping something. */
  overlappingCalls = 0;

  constructor(
    private readonly inner: FileSystemBackend,
    private readonly delayMs: number
  ) {}

  private async gate<T>(fn: () => Promise<T>): Promise<T> {
    this.inflight++;
    if (this.inflight > this.inflightMax) this.inflightMax = this.inflight;
    if (this.inflight > 1) this.overlappingCalls++;
    try {
      await new Promise((r) => setTimeout(r, this.delayMs));
      return await fn();
    } finally {
      this.inflight--;
    }
  }

  listDir(path: string): Promise<DirEntry[]> {
    return this.gate(() => this.inner.listDir(path));
  }
  readFile(path: string): Promise<ArrayBuffer> {
    return this.gate(() => this.inner.readFile(path));
  }
  readText(path: string, encoding?: string): Promise<string> {
    return this.gate(() => this.inner.readText(path, encoding));
  }
  exists(path: string): Promise<boolean> {
    return this.gate(() => this.inner.exists(path));
  }
}

/** Mulberry32 — tiny deterministic PRNG. Good enough for shuffling delays. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RandomSlowFs implements FileSystemBackend {
  private readonly rng: () => number;

  constructor(
    private readonly inner: FileSystemBackend,
    private readonly maxDelayMs: number,
    seed: number
  ) {
    this.rng = mulberry32(seed);
  }

  private async gate<T>(fn: () => Promise<T>): Promise<T> {
    const d = Math.floor(this.rng() * this.maxDelayMs);
    await new Promise((r) => setTimeout(r, d));
    return fn();
  }

  listDir(path: string): Promise<DirEntry[]> {
    return this.gate(() => this.inner.listDir(path));
  }
  readFile(path: string): Promise<ArrayBuffer> {
    return this.gate(() => this.inner.readFile(path));
  }
  readText(path: string, encoding?: string): Promise<string> {
    return this.gate(() => this.inner.readText(path, encoding));
  }
  exists(path: string): Promise<boolean> {
    return this.gate(() => this.inner.exists(path));
  }
}

export class ThrowingFs implements FileSystemBackend {
  constructor(
    private readonly inner: FileSystemBackend,
    private readonly throwOnListDir: ReadonlySet<string>
  ) {}

  async listDir(path: string): Promise<DirEntry[]> {
    if (this.throwOnListDir.has(path)) throw new Error(`EACCES: ${path}`);
    return this.inner.listDir(path);
  }
  readFile(path: string): Promise<ArrayBuffer> {
    return this.inner.readFile(path);
  }
  readText(path: string, encoding?: string): Promise<string> {
    return this.inner.readText(path, encoding);
  }
  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }
}
