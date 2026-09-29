// Bundles each entry point into one dependency-free ESM file in dist/.
// dist/ is committed so the plugin runs straight from a git checkout with only Node installed.
import { build } from "esbuild";

const entries = ["hook", "cli"];

await build({
  entryPoints: entries.map((e) => `src/${e}.ts`),
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
