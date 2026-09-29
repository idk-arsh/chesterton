// Bundles each entry point into one dependency-free ESM file in dist/.
// dist/ is committed so the plugin runs straight from a git checkout with only Node installed.
//
// dist/hook.js and dist/cli.js are small launchers. They turn on Node's compile cache (Node 22.1+,
// skipped quietly on older versions) and then load the real bundle, so later runs skip compiling it.
import { writeFileSync } from "node:fs";
import { build } from "esbuild";

const entries = { hook: "src/hook.ts", cli: "src/cli.ts" };

await build({
  entryPoints: Object.fromEntries(Object.entries(entries).map(([name, src]) => [`${name}-main`, src])),
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  logLevel: "info",
});

const cacheOn = `import module from "node:module";
try {
  if (typeof module.enableCompileCache === "function") module.enableCompileCache();
} catch {
  // No compile cache; everything still works, just a little slower.
}
`;

// The hook must fail open: if the bundle cannot even load, print nothing and exit 0.
const hookLauncher = `#!/usr/bin/env node
// Launcher for hook-main.js. Built by scripts/build.mjs; do not edit.
${cacheOn}
try {
  const { main } = await import("./hook-main.js");
  await main();
} catch {
  process.exit(0);
}
`;

const cliLauncher = `#!/usr/bin/env node
// Launcher for cli-main.js. Built by scripts/build.mjs; do not edit.
${cacheOn}
const { main } = await import("./cli-main.js");
process.exitCode = main(process.argv.slice(2));
`;

writeFileSync("dist/hook.js", hookLauncher);
writeFileSync("dist/cli.js", cliLauncher);
console.log("  dist/hook.js, dist/cli.js (launchers)");
