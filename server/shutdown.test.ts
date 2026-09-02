import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShutdownHandler, type ShutdownLogger } from './shutdown.js';

function createLogger(): ShutdownLogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), error: vi.fn() };
}

describe('bounded graceful shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exits zero and clears the deadline when close drains in time', async () => {
    const log = createLogger();
    const exit = vi.fn();
    let release: () => void = () => {};
    const close = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    const shutdown = createShutdownHandler({ close, log, timeoutMs: 10_000, exit });
    shutdown('SIGTERM');
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);

    // A cleared deadline must not fire a second, failing exit afterwards.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('exits non-zero once the deadline passes while close is still hung', async () => {
    const log = createLogger();
    const exit = vi.fn();
    const close = vi.fn(() => new Promise<void>(() => {}));

    const shutdown = createShutdownHandler({ close, log, timeoutMs: 10_000, exit });
    shutdown('SIGTERM');

    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log.error).toHaveBeenCalledWith(
      { signal: 'SIGTERM', timeoutMs: 10_000 },
      'Graceful shutdown timed out; forcing exit',
    );
  });

  it('runs close once and does not restart the deadline on a repeat signal', async () => {
    const log = createLogger();
    const exit = vi.fn();
    const close = vi.fn(() => new Promise<void>(() => {}));

    const shutdown = createShutdownHandler({ close, log, timeoutMs: 10_000, exit });
    shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(9_000);
    shutdown('SIGINT');

    expect(close).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'Shutdown already in progress; ignoring signal');

    // The original deadline still expires 10s after the FIRST signal.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits non-zero when close rejects', async () => {
    const log = createLogger();
    const exit = vi.fn();
    const close = vi.fn(() => Promise.reject(new Error('drain failed')));

    const shutdown = createShutdownHandler({ close, log, timeoutMs: 10_000, exit });
    shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM' }),
      'Graceful shutdown failed',
    );
  });
});
