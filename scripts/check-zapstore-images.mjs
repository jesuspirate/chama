#!/usr/bin/env node
// Fails before any Zapstore upload when a listing image is missing, is not
// a PNG/JPEG, or is larger than the Zapstore CDN accepts. The CDN does not
// publish its limit: on 2026-10-30 zsp 0.4.10 rejected 462-567 KB PNGs with
// "upload exceeds the size limit" while 119-199 KB images had gone through,
// so the default stays under the largest size known to upload.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_BYTES = 190_000;

/** The `icon:` and `images:` paths named in a zapstore.yaml. */
export function listingImages(yaml) {
  const paths = [];
  const icon = yaml.match(/^icon:\s*(\S+)\s*$/m);
  if (icon) paths.push(icon[1]);
  const block = yaml.match(/^images:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m);
  if (block) {
    for (const line of block[1].split("\n")) {
      const item = line.match(/^[ \t]+-\s*(\S+)\s*$/);
      if (item) paths.push(item[1]);
    }
  }
  return paths;
}

function imageKind(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/** Problems with the listing images in `configPath`; empty when all pass. */
export function checkZapstoreImages(configPath, maxBytes = DEFAULT_MAX_BYTES) {
  const root = dirname(resolve(configPath));
  const paths = listingImages(readFileSync(configPath, "utf8"));
  const problems = [];
  if (paths.length === 0) problems.push(`${configPath} lists no icon or images`);
  for (const path of paths) {
    const full = resolve(root, path);
    if (!existsSync(full)) { problems.push(`${path}: file not found`); continue; }
    const size = statSync(full).size;
    if (!imageKind(readFileSync(full))) problems.push(`${path}: not a PNG or JPEG`);
    if (size > maxBytes) problems.push(`${path}: ${size.toLocaleString("en-US")} bytes, over the ${maxBytes.toLocaleString("en-US")}-byte limit`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2] ?? "zapstore.yaml";
  const maxBytes = Number(process.env.CHAMA_ZAPSTORE_IMAGE_MAX_BYTES || DEFAULT_MAX_BYTES);
  const problems = checkZapstoreImages(configPath, maxBytes);
  if (problems.length) {
    console.error(`❌ Zapstore listing images would be refused (nothing was uploaded):`);
    for (const problem of problems) console.error(`   - ${problem}`);
    console.error(`   Shrink them (e.g. pngquant) and re-run.`);
    process.exit(1);
  }
  console.log(`✅ Zapstore listing images fit (${listingImages(readFileSync(configPath, "utf8")).length} files, each ≤ ${maxBytes.toLocaleString("en-US")} bytes)`);
}
