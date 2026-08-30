import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const landingRoot = path.join(repoRoot, "landing");
const manifestPath = path.join(landingRoot, "deploy-files.txt");
const entries = fs.readFileSync(manifestPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const manifest = new Set(entries);

const missingFiles = entries.filter((entry) => !fs.existsSync(path.join(landingRoot, entry)));
if (missingFiles.length) {
  console.error(`Landing deploy manifest names missing files:\n${missingFiles.join("\n")}`);
  process.exit(1);
}

// Generated landing assets are ignored by default so local image iterations
// never dirty the repository. A file promoted into the VPS manifest must cross
// the opposite boundary explicitly: it must be tracked, so a clean checkout
// contains exactly what deploy-landing.sh expects to upload.
const tracked = new Set(
  execFileSync("git", ["ls-files", "--", "landing"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => path.relative("landing", file)),
);
const untrackedManifestFiles = entries.filter((entry) => !tracked.has(entry));
if (untrackedManifestFiles.length) {
  console.error(
    `Landing deploy manifest names files that are not tracked by Git:\n${untrackedManifestFiles.join("\n")}\n` +
      "Promote each reviewed asset with: git add -f landing/<file>",
  );
  process.exit(1);
}

const references = new Set();
for (const htmlFile of entries.filter((entry) => entry.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(landingRoot, htmlFile), "utf8");
  for (const match of html.matchAll(/(?:src|href|data-dark-src|data-light-src)="((?:img|icons)\/[^"?#]+)"/g)) {
    references.add(match[1]);
  }
  for (const match of html.matchAll(/https:\/\/chama\.community\/((?:img|icons)\/[^"?#]+)/g)) {
    references.add(match[1]);
  }
}

const omitted = [...references].filter((reference) => !manifest.has(reference)).sort();
if (omitted.length) {
  console.error(`Landing pages reference files omitted from deploy-files.txt:\n${omitted.join("\n")}`);
  process.exit(1);
}

console.log(`✅ Landing deploy manifest: ${entries.length} files, ${references.size} referenced assets covered`);
