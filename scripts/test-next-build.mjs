import { build } from "esbuild";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
  // Characterize the pre-6.4.19 reader with its exact legacy anchor. The
  // ordering/reduction gates are unchanged; no runtime protocol switch added.
  for (const legacy of [false, true]) {
    const outfile = join(directory, `reader-${legacy}.mjs`);
    await build({ entryPoints: ["src/escrow-engine/refund-escalation.tests.ts"], bundle: true,
      platform: "node", format: "esm", outfile, define: { __LEGACY_READER__: String(legacy) },
      plugins: legacy ? [{ name: "legacy-one-sided-clock", setup(builder) {
        builder.onLoad({ filter: /arbiter-substitution\.ts$/ }, async ({ path }) => ({
          contents: (await readFile(path, "utf8")).replace("const anchor = oneSidedPrincipalAnchor(state);",
            "const anchor = oneSidedReleaseAnchor(state)?.releaseVoteAt ?? null;"), loader: "ts" }));
      } }] : [] });
    await import(pathToFileURL(outfile).href);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
