import fs from "node:fs";
import path from "node:path";
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
