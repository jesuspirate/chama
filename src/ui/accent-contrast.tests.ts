// Jet (6.4.26-rc.4, light mode): "Switch route", "Generate Lightning
// invoice" and the Receive tab were black with black text. T.accent is the
// ink colour in both themes (near-black in light, near-white in dark), so a
// hard-coded "#000" or "#fff" on it disappears in one of the two. Text on
// T.accent uses T.onInk. This scan fails on any accent background whose
// style sets a literal black or white text colour.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("./", import.meta.url).pathname;
const files: string[] = [];
const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(name) && !/tests\.tsx?$/.test(name)) files.push(p); } };
walk(root);
const offenders: string[] = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!/background:\s*[^,}]*\bT\.accent\b(?!Dim)/.test(line)) return;
    const window = lines.slice(Math.max(0, i - 3), i + 9).join("\n");
    for (const m of window.matchAll(/\bcolor:\s*([^,}\n]+)/g)) {
      // A literal on the accent branch of a ternary, or a plain literal.
      const value = m[1];
      const accentBranch = /\?\s*("#(?:000|000000|fff|ffffff|111)"|'#(?:000|fff)')\s*:/i.test(value) || /^("#(?:000|000000|fff|ffffff|111)")$/i.test(value.trim());
      if (accentBranch && !/T\.red|T\.amber|T\.green/.test(line)) offenders.push(`${file.replace(root, "src/ui/")}:${i + 1} ${value.trim()}`);
    }
  });
}
assert.deepEqual(offenders, [], `text on T.accent must use T.onInk:\n${offenders.join("\n")}`);
const theme = readFileSync(new URL("./theme.ts", import.meta.url), "utf8");
assert.match(theme, /ink: "#F2F1EC"[^\n]*onInk: "#0B0B0F"/, "dark: ink is light, onInk is dark");
assert.match(theme, /ink: "#15141B"[^\n]*onInk: "#FFFFFF"/, "light: ink is dark, onInk is white");
console.log(`PASS accent contrast: ${files.length} UI files, no black or white text on the accent colour`);

{
  // Jet (Oct 17): Manual fund is the most-used tool in Advanced, so it comes
  // first, above the wallet balance. Its gate is unchanged: power-user mode,
  // a dev build or sim mode.
  const adv = readFileSync(new URL("./screens/SettingsAdvanced.tsx", import.meta.url), "utf8");
  const ret = adv.indexOf("  return (");
  const fund = adv.indexOf("⚡ Open manual fund", ret);
  assert.ok(fund > ret && fund < adv.indexOf("LOCAL WALLET BALANCE", ret), "manual fund is the first card");
  assert.match(adv, /\{onSandboxFund && \(powerUserOn \|\| isDev \|\| simOn\) && \(/, "still gated");
  assert.equal(adv.split("⚡ Open manual fund").length - 1, 1, "shown once");
  console.log("PASS Advanced: manual fund first, same gate");
}
