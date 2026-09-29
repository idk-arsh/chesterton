#!/usr/bin/env node
// Launcher for hook-main.js. Built by scripts/build.mjs; do not edit.
import module from "node:module";
try {
  if (typeof module.enableCompileCache === "function") module.enableCompileCache();
} catch {
  // No compile cache; everything still works, just a little slower.
}

try {
  const { main } = await import("./hook-main.js");
  await main();
} catch {
  process.exit(0);
}
