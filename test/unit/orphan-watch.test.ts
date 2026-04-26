import { describe, it, expect, vi } from 'vitest';
import { startOrphanWatch } from '../../src/utils/orphan-watch.js';

/**
 * Phase 1.6 — orphan watchdog. Confirms we detect a reparented process
 * (ppid changes, typically to 1 on POSIX when the parent dies) and invoke
 * the supplied shutdown callback exactly once.
 */

describe('startOrphanWatch', () => {
  it('does NOT fire when started directly under PID 1 (systemd Type=simple, supervisord, container ENTRYPOINT)', async () => {
    const onOrphaned = vi.fn();
    const watch = startOrphanWatch({
      onOrphaned,
      intervalMs: 5,
      getPpid: () => 1,
    });
    await new Promise((r) => setTimeout(r, 30));
    watch.stop();
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it('does nothing while ppid is unchanged', async () => {
    const onOrphaned = vi.fn();
    const watch = startOrphanWatch({
      onOrphaned,
      intervalMs: 10,
      getPpid: () => 12345,
    });
    await new Promise((r) => setTimeout(r, 50));
    watch.stop();
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it('fires onOrphaned when ppid changes from the initial value', async () => {
    let current = 12345;
    const onOrphaned = vi.fn();
    const watch = startOrphanWatch({
      onOrphaned,
      intervalMs: 10,
      getPpid: () => current,
    });
    current = 1; // reparented to init
    await new Promise((r) => setTimeout(r, 50));
    watch.stop();
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it('fires onOrphaned only once even if the watcher keeps ticking', async () => {
    let current = 12345;
    const onOrphaned = vi.fn();
    const watch = startOrphanWatch({
      onOrphaned,
      intervalMs: 5,
      getPpid: () => current,
    });
    current = 1;
    await new Promise((r) => setTimeout(r, 50));
    watch.stop();
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it('fires even if ppid changes to something other than 1 (Windows-style reparenting)', async () => {
    let current = 12345;
    const onOrphaned = vi.fn();
    const watch = startOrphanWatch({
      onOrphaned,
      intervalMs: 10,
      getPpid: () => current,
    });
    current = 99999; // different parent, not init
    await new Promise((r) => setTimeout(r, 50));
    watch.stop();
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it('swallows errors thrown by the shutdown handler', async () => {
    const onOrphaned = vi.fn().mockRejectedValue(new Error('boom'));
    let current = 12345;
    const fakeLogger = { warn: vi.fn() };
    const watch = startOrphanWatch({
      onOrphaned,
      intervalMs: 10,
      getPpid: () => current,
      logger: fakeLogger,
    });
    current = 1;
    await new Promise((r) => setTimeout(r, 50));
    watch.stop();
    expect(onOrphaned).toHaveBeenCalledTimes(1);
    // Either the orphan-detected warn or the handler-threw warn should have fired.
    expect(fakeLogger.warn).toHaveBeenCalled();
  });

  it('stop() prevents further firings', async () => {
    let current = 12345;
    const onOrphaned = vi.fn();
    const watch = startOrphanWatch({
      onOrphaned,
      intervalMs: 5,
      getPpid: () => current,
    });
    watch.stop();
    current = 1;
    await new Promise((r) => setTimeout(r, 30));
    expect(onOrphaned).not.toHaveBeenCalled();
  });
});
