/**
 * Orphan-process watchdog.
 *
 * Conductor is launched by Claude (or another MCP client) as a long-running
 * stdio subprocess. If the client crashes or is force-killed, Conductor can
 * stay alive — along with its Deno children — leaking memory and compute
 * until an operator notices. On POSIX the orphaning is visible: the parent
 * PID changes to 1 (init) once the original parent has reaped. We poll
 * periodically and, when reparenting is detected, invoke a graceful
 * shutdown so everything downstream (Deno, MCP hub, HTTP bridge, timers)
 * stops cleanly.
 *
 * On Windows `process.ppid` is less reliable but we still compare against
 * the startup value; any change is treated as an orphan signal.
 */

import { logger } from './logger.js';
import { LIFECYCLE_TIMEOUTS } from '../config/defaults.js';

export interface OrphanWatch {
  stop(): void;
}

export interface OrphanWatchOptions {
  onOrphaned: () => void | Promise<void>;
  intervalMs?: number;
  /** Inject for tests. Defaults to `() => process.ppid`. */
  getPpid?: () => number;
  /** Called once orphaning is confirmed. */
  logger?: Pick<typeof logger, 'warn'>;
}

/**
 * Start watching. Returns a handle with stop() so callers can unhook the
 * watcher during normal shutdown (prevents spurious orphan fires during
 * SIGTERM cleanup).
 */
export function startOrphanWatch(options: OrphanWatchOptions): OrphanWatch {
  const {
    onOrphaned,
    intervalMs = LIFECYCLE_TIMEOUTS.ORPHAN_CHECK_INTERVAL_MS,
    getPpid = () => process.ppid,
    logger: log = logger,
  } = options;

  const initialPpid = getPpid();
  let fired = false;

  const timer = setInterval(() => {
    if (fired) return;
    const current = getPpid();
    // PID 1 on POSIX → reparented to init; any change from initial is also
    // treated as a signal since Windows reparenting is less well-defined.
    if (current === 1 || current !== initialPpid) {
      fired = true;
      log.warn('Parent process gone, triggering orphan shutdown', {
        initialPpid,
        currentPpid: current,
      });
      void Promise.resolve(onOrphaned()).catch((err: unknown) => {
        log.warn('Orphan shutdown handler threw', { error: String(err) });
      });
    }
  }, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
