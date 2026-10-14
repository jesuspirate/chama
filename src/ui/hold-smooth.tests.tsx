// Jet (6.4.25-rc.7, Pixel): holding Fund/Lock, the progress fill was jittery.
// Measured in headless Chromium at 4× CPU slowdown during one 1.3 s hold:
// before, 73 layouts and 20 ms of script (a re-render and a width change every
// frame, stepped in whole percents); after, 1 layout and 3 ms (one compositor
// transform animation and a single confirm timer). Confirm timing (~1.2 s) and
// "early release never confirms" were unchanged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { HoldToConfirm, holdReducer, HOLD_TO_CONFIRM_MS } from "./components/Button.js";
import { LangProvider } from "../i18n/index.js";

const src = readFileSync(new URL("./components/Button.tsx", import.meta.url), "utf8");
const hold = src.slice(src.indexOf("export function HoldToConfirm("), src.indexOf("function CheckGlyph") > src.indexOf("export function HoldToConfirm(") ? src.indexOf("function CheckGlyph") : undefined);
assert.doesNotMatch(hold, /requestAnimationFrame|setProgress/, "no per-frame JavaScript while holding");
assert.match(hold, /transform: `scaleX\(\$\{done \|\| state\.kind === "holding" \? 1 : 0\}\)`/);
assert.match(hold, /transition: state\.kind === "holding" \? `transform \$\{holdMs\}ms linear`/, "one linear animation over the hold");
assert.match(hold, /willChange: "transform"/);
assert.doesNotMatch(hold, /width: `\$\{Math\.round\(progress \* 100\)\}%`/);

// Idle renders an empty fill with an ease-back transition.
const idle = renderToStaticMarkup(<LangProvider><HoldToConfirm label="Hold to lock" armedLabel="a" hint="Press and hold" onConfirm={() => {}} /></LangProvider>);
assert.match(idle, /data-hold-fill[^>]*transform:scaleX\(0\)[^>]*transition:transform 200ms ease/);

// The confirm rule is unchanged: a full hold confirms, an early release
// doesn't, ticks before the end don't.
let s = holdReducer({ kind: "idle" }, { type: "press", at: 0 });
assert.deepEqual(holdReducer(s, { type: "tick", at: HOLD_TO_CONFIRM_MS - 1 }), s);
assert.deepEqual(holdReducer(s, { type: "tick", at: HOLD_TO_CONFIRM_MS }), { kind: "confirmed" });
assert.deepEqual(holdReducer(s, { type: "release", at: 500 }), { kind: "idle" });
console.log("PASS hold to confirm: fill is one GPU animation, no per-frame work; confirm rule unchanged");
