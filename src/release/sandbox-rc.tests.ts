// Jet (6.4.25): the sandbox should say which release candidate it runs. With
// --rc N, `--only sandbox` carries the same transient X.Y.Z-rc.N version as
// `--only prerelease --rc N`; without it, the committed version, as before.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url).pathname;
const run = (...args: string[]) => spawnSync("bash", ["scripts/publish.sh", "--only", ...args, "--dry-run"], { cwd: root, encoding: "utf8" });
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
const [a, b, c] = version.split("-")[0].split(".").map(Number);

const rc = run("sandbox", "--rc", "11");
assert.equal(rc.status, 0, rc.stderr);
assert.match(rc.stdout, new RegExp(`SANDBOX only \\(v${a}\\.${b}\\.${c + 1}-rc\\.11\\)`), "next patch, rc.11");
const minor = run("sandbox", "--rc", "2", "--next", "minor");
assert.match(minor.stdout, new RegExp(`\\(v${a}\\.${b + 1}\\.0-rc\\.2\\)`));
const plain = run("sandbox");
assert.equal(plain.status, 0, plain.stderr);
assert.match(plain.stdout, new RegExp(`SANDBOX only \\(v${version.replace(/\./g, "\\.")}\\)`), "no --rc: the committed version");
assert.notEqual(run("sandbox", "--rc", "0").status, 0, "a bad rc is refused");
assert.notEqual(run("sandbox", "--next", "huge").status, 0, "a bad --next is refused");
// The sandbox and the prerelease APK agree on the label.
const apk = run("prerelease", "--rc", "11");
assert.match(apk.stdout, new RegExp(`transient ${a}\\.${b}\\.${c + 1}-rc\\.11`));
// The transient version is restored on exit and never committed.
const script = readFileSync(new URL("../../scripts/deploy-sandbox.sh", import.meta.url), "utf8");
assert.match(script, /trap restore_version EXIT/);
assert.match(script, /refusing to layer a transient version on top/);
console.log("PASS sandbox --rc: labelled like the prerelease APK, restored on exit; plain sandbox unchanged");
