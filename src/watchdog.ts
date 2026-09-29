import { Worker } from "node:worker_threads";

/**
 * Kill this process after `ms`, even when the main thread is stuck in synchronous work that no
 * timer can interrupt, such as a runaway `fix_patterns_extra` regex from a repo's config. Used by
 * the background indexer, which nobody is watching. The worker is unref'd, so a normal exit is not
 * held up. Never throws; without worker threads there is simply no watchdog.
 */
export function armWatchdog(ms: number): void {
  try {
    const code =
      'const { workerData: d } = require("node:worker_threads");' +
      'setTimeout(() => { try { process.kill(d.pid, "SIGKILL"); } catch {} }, d.ms);';
    const w = new Worker(code, { eval: true, workerData: { pid: process.pid, ms } });
    w.on("error", () => {});
    w.unref();
  } catch {
    // No watchdog.
  }
}
