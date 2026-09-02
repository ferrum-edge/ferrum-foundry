export interface ShutdownLogger {
  info: (payload: Record<string, unknown>, message: string) => void;
  error: (payload: Record<string, unknown>, message: string) => void;
}

export interface ShutdownHandlerOptions {
  /** Drains in-flight work. Invoked at most once for the lifetime of the handler. */
  close: () => Promise<unknown>;
  log: ShutdownLogger;
  /** Hard deadline for `close()` before the process is failed out. */
  timeoutMs: number;
  exit: (code: number) => void;
}

/**
 * Builds a signal handler that bounds graceful shutdown.
 *
 * An unbounded `close()` lets a single streaming request hold the process open
 * until the orchestrator escalates to SIGKILL, which loses the exit code and
 * any final log flush. The handler runs `close()` once, exits 0 when it drains
 * inside the deadline, and exits 1 when the deadline wins. Repeat signals are
 * logged and ignored rather than restarting the deadline.
 */
export function createShutdownHandler(options: ShutdownHandlerOptions): (signal: string) => void {
  const { close, log, timeoutMs, exit } = options;
  let closing = false;
  let settled = false;

  const finish = (code: number, timer: NodeJS.Timeout): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    exit(code);
  };

  return (signal: string): void => {
    if (closing) {
      log.info({ signal }, 'Shutdown already in progress; ignoring signal');
      return;
    }
    closing = true;
    log.info({ signal, timeoutMs }, 'Shutting down gracefully');

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.error({ signal, timeoutMs }, 'Graceful shutdown timed out; forcing exit');
      exit(1);
    }, timeoutMs);
    // The deadline must never be the reason the event loop stays alive.
    timer.unref?.();

    // Invoked synchronously so the drain starts on the signal, not a tick later.
    void (async () => {
      try {
        await close();
        finish(0, timer);
      } catch (error) {
        log.error({ signal, err: error }, 'Graceful shutdown failed');
        finish(1, timer);
      }
    })();
  };
}
