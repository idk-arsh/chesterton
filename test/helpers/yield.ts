// Most tests here run git through spawnSync, which blocks the worker's event loop. A whole file of
// them can run for a minute on a busy machine without the loop turning once, and vitest's own
// progress messages to the main process then time out. Letting the loop turn after each test
// keeps those messages flowing.
import { afterEach } from "vitest";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
