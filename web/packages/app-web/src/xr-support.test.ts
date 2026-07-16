import { describe, expect, it, vi } from 'vitest';
import { createXrSupportProbe, type XrSystemLike } from './xr-support.js';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('createXrSupportProbe', () => {
  it('resolves false without querying when navigator.xr is absent', async () => {
    const log = makeLogger();
    const probe = createXrSupportProbe(undefined, log);
    await expect(probe.query()).resolves.toBe(false);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('queries the browser once for repeated calls', async () => {
    const isSessionSupported = vi.fn().mockResolvedValue(false);
    const probe = createXrSupportProbe({ isSessionSupported }, makeLogger());
    await expect(probe.query()).resolves.toBe(false);
    await expect(probe.query()).resolves.toBe(false);
    await expect(probe.query()).resolves.toBe(false);
    expect(isSessionSupported).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight query between concurrent callers', async () => {
    let resolve!: (v: boolean) => void;
    const isSessionSupported = vi.fn().mockReturnValue(
      new Promise<boolean>((r) => (resolve = r))
    );
    const probe = createXrSupportProbe({ isSessionSupported }, makeLogger());
    const a = probe.query();
    const b = probe.query();
    resolve(true);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(true);
    expect(isSessionSupported).toHaveBeenCalledTimes(1);
  });

  it('logs the result once, not per query', async () => {
    const log = makeLogger();
    const probe = createXrSupportProbe(
      { isSessionSupported: vi.fn().mockResolvedValue(false) },
      log
    );
    await probe.query();
    await probe.query();
    await probe.query();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      '[xr] isSessionSupported(immersive-vr) =',
      false
    );
  });

  it('invalidate() while a query is in flight forces a fresh browser query', async () => {
    // The devicechange listener fires invalidate() whenever a headset
    // is plugged in / removed — quite possibly while a slow
    // isSessionSupported enumeration is still pending. The next query
    // must NOT be served from the stale in-flight promise.
    const resolvers: Array<(v: boolean) => void> = [];
    const isSessionSupported = vi.fn(
      () => new Promise<boolean>((r) => resolvers.push(r))
    );
    const probe = createXrSupportProbe({ isSessionSupported }, makeLogger());
    const a = probe.query();
    probe.invalidate(); // devicechange lands mid-flight
    const b = probe.query();
    expect(isSessionSupported).toHaveBeenCalledTimes(2);
    resolvers[0]!(false); // pre-devicechange answer
    resolvers[1]!(true); // post-devicechange answer
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(true);
  });

  it('after invalidate(): re-queries, but logs only when the value changed', async () => {
    const log = makeLogger();
    let supported = false;
    const isSessionSupported = vi.fn(() => Promise.resolve(supported));
    const probe = createXrSupportProbe({ isSessionSupported }, log);

    await probe.query();
    probe.invalidate();
    await probe.query(); // still false → no second log
    expect(isSessionSupported).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledTimes(1);

    supported = true; // headset plugged in
    probe.invalidate();
    await expect(probe.query()).resolves.toBe(true);
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenLastCalledWith(
      '[xr] isSessionSupported(immersive-vr) =',
      true
    );
  });

  it('resolves false and warns when the browser query rejects', async () => {
    const log = makeLogger();
    const probe = createXrSupportProbe(
      { isSessionSupported: vi.fn().mockRejectedValue(new Error('boom')) },
      log
    );
    await expect(probe.query()).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    // Failure result is cached — no warn spam on the next refresh.
    await expect(probe.query()).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('recovers after a rejected query once invalidated', async () => {
    const log = makeLogger();
    const isSessionSupported = vi
      .fn<XrSystemLike['isSessionSupported']>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(true);
    const probe = createXrSupportProbe({ isSessionSupported }, log);
    await expect(probe.query()).resolves.toBe(false);
    probe.invalidate();
    await expect(probe.query()).resolves.toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      '[xr] isSessionSupported(immersive-vr) =',
      true
    );
  });
});
