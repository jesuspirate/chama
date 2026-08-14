#!/usr/bin/env node
// scripts/dependency-audit.mjs
//
// Dependency security gate for CI and `npm run audit:deps`.
//
// Layers:
//   1. Denylist — exact package names that must never appear in the
//      dependency tree (known-compromised, malicious typosquats, or
//      packages Chama has explicitly ruled out). Scanning the lockfile's
//      `packages` keys catches these even if a future npm changes how
//      `npm ls` reports extraneous/optional nodes.
//   2. Advisory audit — `npm audit --omit=dev --audit-level=high` fails the
//      gate on any high/critical advisory that can reach shipped code.
//      Dev-only advisories (vite/postcss/nanoid/ws class) do not fail the
//      gate here; the esbuild override note in package.json documents why.
//
// Exit 0 = pass, 1 = fail. Output is written for humans first.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockfilePath = join(root, "package-lock.json");

// ---------------------------------------------------------------------------
// Denylist
//
// Each entry needs a reason and a reference so the next reviewer can tell why
// the name is here without re-deriving it. Keep names exact and lowercase.
// ---------------------------------------------------------------------------
const DENYLIST = [
  {
    name: "crypto-js",
    reason:
      "Unmaintained (no real release since 2021); CVE-2023-46233 (1-iteration PBKDF2 default) and the Aug 2026 WordArray.random weak-PRNG advisory (CVE-2026-71851 / GHSA-rg76-677x-56q9). Chama's crypto is the @noble/@scure stack — crypto-js has no legitimate reason to appear here, direct or transitive.",
    reference: "https://github.com/advisories/GHSA-rg76-677x-56q9",
  },
  {
    name: "plain-crypto-js",
    reason:
      "Malicious typosquat of crypto-js, planted by the Mar 31 2026 axios supply-chain compromise (axios@1.14.1 / axios@0.30.4). Pure malware — no legitimate use anywhere.",
    reference:
      "https://cloud.google.com/blog/topics/threat-intelligence/north-korea-threat-actor-targets-axios-npm-package",
  },
  {
    name: "axios",
    reason:
      "The Mar 31 2026 compromise shipped a poisoned release. Chama does not use axios (HTTP goes through @tauri-apps/plugin-http and fetch); if a future legitimate need appears, remove this entry in the same PR that adds the pinned, reviewed dependency.",
    reference:
      "https://www.microsoft.com/en-us/security/blog/2026/04/01/mitigating-the-axios-npm-supply-chain-compromise/",
  },
];

let failed = false;

// ---------------------------------------------------------------------------
// Layer 1: denylist scan of the lockfile
// ---------------------------------------------------------------------------
let lock;
try {
  lock = JSON.parse(readFileSync(lockfilePath, "utf8"));
} catch (err) {
  console.error(`❌ dependency-audit: cannot read ${lockfilePath}: ${err.message}`);
  process.exit(1);
}

if (!lock.packages || typeof lock.packages !== "object") {
  console.error("❌ dependency-audit: lockfile has no `packages` map — unexpected lockfile format.");
  process.exit(1);
}

const present = new Set();
for (const key of Object.keys(lock.packages)) {
  // Keys look like "node_modules/<name>" or "node_modules/a/node_modules/b".
  const segments = key.split("node_modules/");
  const last = segments[segments.length - 1];
  if (last) present.add(last);
}

for (const entry of DENYLIST) {
  if (present.has(entry.name)) {
    failed = true;
    console.error(`❌ DENYLISTED PACKAGE PRESENT: ${entry.name}`);
    console.error(`   why it's banned: ${entry.reason}`);
    console.error(`   reference: ${entry.reference}`);
    console.error("");
  }
}
if (!failed) {
  console.log(`✔ denylist: none of [${DENYLIST.map((d) => d.name).join(", ")}] in dependency tree`);
}

// ---------------------------------------------------------------------------
// Layer 2: npm audit on production deps (high and above)
// ---------------------------------------------------------------------------
try {
  execFileSync("npm", ["audit", "--omit=dev", "--audit-level=high"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log("✔ audit: no high/critical advisories in production dependencies");
} catch (err) {
  failed = true;
  console.error("❌ npm audit (--omit=dev, high+) found reachable vulnerabilities:\n");
  const out = (err.stdout || "").toString().trimEnd();
  console.error(out || "(npm audit produced no stdout)");
  console.error(`
Gate rule: production-reachable advisories at high/critical fail the build.
If an advisory is a false positive for Chama (e.g. build-time-only consumer),
document the analysis in the PR and prefer an \`overrides\` pin to a patched
release over silencing this gate.`);
}

if (failed) {
  console.error("\n⛔ dependency-audit: FAILED");
  process.exit(1);
}
console.log("\n✅ dependency-audit: passed");
