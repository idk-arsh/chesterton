import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Other spellings of an existing directory, for tests of paths that are not in their real form.
 * CI runners hit both: macOS temp dirs sit under /var, a symlink to /private/var, and the Windows
 * runner's TEMP can be an 8.3 short path (C:\Users\RUNNER~1\...). Git prints paths resolved.
 */

/** A junction (Windows, no admin needed) or dir symlink pointing at `dir`. Call the returned cleanup when done. */
export function linkTo(dir: string): { path: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "chesterton-alias-"));
  const path = join(parent, "linked");
  symlinkSync(dir, path, process.platform === "win32" ? "junction" : "dir");
  return {
    path,
    cleanup: () => {
      // Remove the link itself first so the recursive delete cannot follow it into the target.
      rmSync(path, { force: true, recursive: false });
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

/**
 * The 8.3 short form of `dir` on Windows, or null when there is none (other platforms, volumes with
 * short names turned off, or a path whose parts are all short already).
 */
export function shortPathOf(dir: string): string | null {
  if (process.platform !== "win32") return null;
  const res = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${dir}") do @echo %~sI`], {
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  const short = res.status === 0 ? res.stdout.trim() : "";
  if (!short || short.toLowerCase() === dir.toLowerCase() || !short.includes("~")) return null;
  return short;
}

/** True on Windows when new directories under the temp dir get 8.3 short names (the volume can turn them off). */
export function shortNamesAvailable(): boolean {
  if (process.platform !== "win32") return false;
  const probe = mkdtempSync(join(tmpdir(), "chesterton-shortname-probe-"));
  try {
    return shortPathOf(probe) !== null;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
