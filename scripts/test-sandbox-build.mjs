// Runs src/sim/sandbox-build.tests.ts under both values of the Vite define so
// the sandbox contract (sim forced on, exit ignored) and the live contract
// (sim stays URL-driven) are both asserted by `npm test`.
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "chama-sandbox-policy-"));
try {
  for (const sandbox of [false, true]) {
    const outfile = join(directory, `policy-${sandbox}.mjs`);
    await build({
      entryPoints: ["src/sim/sandbox-build.tests.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      define: { __CHAMA_SANDBOX__: String(sandbox), __APP_VERSION__: '"test"' },
    });
    await import(pathToFileURL(outfile).href);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
