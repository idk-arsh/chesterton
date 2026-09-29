import type { ChestertonConfig } from "./types.js";

export const DEFAULT_CONFIG: ChestertonConfig = {
  mode: "speedbump",
  history: "3y",
  maxCommits: 20_000,
  protect: [],
  fixPatternsExtra: [],
  ignoreCommits: [],
  hookTimeoutMs: 1_500,
};

/**
 * Load `.chesterton.yml` from the repo root and merge over DEFAULT_CONFIG.
 * Never throws: a missing or broken file yields defaults.
 *
 * OWNER: builder C implements the parsing (tiny YAML subset, no dependencies).
 * Until then it returns defaults so the other halves can be built and tested.
 */
export function loadConfig(_repoRoot: string): ChestertonConfig {
  return { ...DEFAULT_CONFIG };
}
