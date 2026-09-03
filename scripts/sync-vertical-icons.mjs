// Keep the app's vertical icons in lockstep with the authored landing logos.
// Source of truth: landing/icons/use-cases (where the SVGs are designed).
// The app expects `${id}-light.svg` / `${id}-dark.svg` under public/icons/verticals.
// Run via `npm run sync:icons` (and it's wired into prebuild so a build can't ship drift).
import { copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "landing/icons/use-cases");
const DST = join(root, "public/icons/verticals");
const ICONS = ["bill-pay", "stack", "store", "work"];

let synced = 0;
for (const id of ICONS) {
  for (const [from, to] of [[`${id}.svg`, `${id}-light.svg`], [`${id}-dark.svg`, `${id}-dark.svg`]]) {
    const s = join(SRC, from), d = join(DST, to);
    if (!existsSync(s)) { console.warn(`[sync-icons] source missing: ${from}`); continue; }
    copyFileSync(s, d);
    synced++;
  }
}
console.log(`[sync-icons] ${synced} files synced: landing/icons/use-cases → public/icons/verticals`);
