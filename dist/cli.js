#!/usr/bin/env node
// Launcher for cli-main.js. Built by scripts/build.mjs; do not edit.
import module from "node:module";
try {
  if (typeof module.enableCompileCache === "function") module.enableCompileCache();
} catch {
  // No compile cache; everything still works, just a little slower.
}

const { main } = await import("./cli-main.js");
process.exitCode = main(process.argv.slice(2));
