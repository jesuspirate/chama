// Audit M8: the Content-Security-Policy every built page carries.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CONTENT_SECURITY_POLICY, contentPolicyMetaTag } from "./content-policy.js";

const directives = new Map(
  CONTENT_SECURITY_POLICY.split(";").map(part => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values] as const;
  }),
);

// Scripts: only files the app ships, plus WebAssembly for the Fedimint wallet.
assert.deepEqual(directives.get("script-src"), ["'self'", "'wasm-unsafe-eval'"]);
for (const [name, values] of directives) {
  assert.ok(!values.includes("'unsafe-eval'"), `${name} must not allow eval`);
  if (name !== "style-src") assert.ok(!values.includes("'unsafe-inline'"), `${name} must not allow inline code`);
  assert.ok(!values.includes("*"), `${name} must not be a bare wildcard`);
}
assert.deepEqual(directives.get("default-src"), ["'self'"]);
assert.deepEqual(directives.get("object-src"), ["'none'"]);
assert.deepEqual(directives.get("frame-src"), ["'none'"]);
assert.deepEqual(directives.get("base-uri"), ["'self'"]);
assert.deepEqual(directives.get("form-action"), ["'self'"]);
// Relays, the wallet bridge on this device (any port), a user's own http
// explorer, Tor addresses on any port and Tauri's IPC stay reachable.
const connect = directives.get("connect-src") ?? [];
for (const source of ["'self'", "https:", "wss:", "ws:", "http:", "ipc:", "http://ipc.localhost"]) {
  assert.ok(connect.includes(source), `connect-src keeps ${source}`);
}
assert.ok(!CONTENT_SECURITY_POLICY.includes('"'), "policy must not break out of the meta attribute");
assert.equal(
  contentPolicyMetaTag(),
  `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
);

// Source pages: no inline script, since the policy would refuse it and blank the page.
for (const page of ["index.html", "wake.html"]) {
  const html = readFileSync(page, "utf8");
  assert.match(html, /<head>/i, `${page} needs a plain <head> for the policy tag`);
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    assert.match(tag, /\bsrc=/, `${page}: inline <script> would be refused: ${tag}`);
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${page}: inline event handlers would be refused`);
}

// The Vite build plugin puts the tag first in <head>. Capacitor's fallback
// injection (old Android WebViews) also lands right after <head>, so the
// bridge script it adds runs before the policy applies.
const viteConfig = readFileSync("vite.config.ts", "utf8");
assert.match(viteConfig, /contentSecurityPolicy\(\)/, "vite.config.ts registers the policy plugin");
assert.match(viteConfig, /\$\{head\}\$\{contentPolicyMetaTag\(\)\}/, "policy tag goes straight after <head>");

// The plugin also checks each finished page, so a build that would ship an
// inline script (refused, blank app) fails instead.
const { checkBuiltPage } = await import("./content-policy.js");
const good = `<!doctype html><html><head>${contentPolicyMetaTag()}<meta charset="utf-8"><script type="module" src="/a.js"></script></head></html>`;
checkBuiltPage("good.html", good);
assert.throws(() => checkBuiltPage("x.html", good.replace('<script type="module" src="/a.js"></script>', "<script>1</script>")), /inline <script>/);
assert.throws(() => checkBuiltPage("x.html", good.replace(contentPolicyMetaTag(), "")), /no content policy/);
assert.throws(() => checkBuiltPage("x.html", good.replace('<meta charset="utf-8">', `<!--${"x".repeat(1100)}--><meta charset="utf-8">`)), /charset/);
assert.throws(() => checkBuiltPage("x.html", good.replace("<head>", '<head><base href="/"><script src="/a.js" onload="x()"></script>')), /event handler/);

// Desktop: no global Tauri API for injected code, and the page cannot spawn programs.
const tauriConf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
assert.equal(tauriConf.app?.withGlobalTauri, false);
const capability = readFileSync("src-tauri/capabilities/default.json", "utf8");
assert.doesNotMatch(capability, /shell:allow-(spawn|execute)/, "the page must not spawn processes");

console.log("PASS content policy (audit M8)");
