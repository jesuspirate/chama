import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const directory = await mkdtemp(join(tmpdir(), "chama-build-policy-"));
try {
  for (const next of [false, true]) {
    const outfile = join(directory, `policy-${next}.mjs`);
    await build({ entryPoints: ["src/sim/next-build.tests.ts"], bundle: true, platform: "node", format: "esm", outfile,
      define: { __CHAMA_NEXT__: String(next), __APP_VERSION__: '"test"' } });
    await import(pathToFileURL(outfile).href);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
