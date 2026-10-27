// Jet (6.4.25-rc.14): Browse and Circles put "back" in different places with
// different words ("← Change the last answer" under the country chip, "← Back"
// above it). Every canvas screen now has one top row: "← Back" on the left,
// the country chip on the right.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasTopRow } from "./screens/AssistedCanvas.js";
import { LangProvider } from "../i18n/index.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const row = renderToStaticMarkup(<LangProvider><CanvasTopRow onBack={() => {}} chip={<b data-chip>USA</b>} /></LangProvider>);
assert.match(row, /^<div class="canvas-top-row"><style>[^<]*<\/style><button data-chama-shortcut="back" type="button" class="chama-back canvas-back" style="[^"]*"><svg[^>]*>.*?<\/svg><span>Back<\/span><\/button><b data-chip="true">USA<\/b><\/div>$/, "back left, chip right, one row");
assert.match(renderToStaticMarkup(<LangProvider><CanvasTopRow chip={<b>USA</b>} /></LangProvider>), /<span><\/span><b>USA<\/b>/, "first screen: the chip keeps its place");

const canvas = read("./screens/AssistedCanvas.tsx");
assert.match(canvas, /<CanvasTopRow onBack=\{back \? \(\) => back\.run\(\) : null\} chip=\{community \? <CommunityChip/, "Browse: the shell draws the row");
assert.match(canvas, /<CanvasBackSlot\.Provider value=\{setBack\}>\{children\}<\/CanvasBackSlot\.Provider>/);
const back = canvas.slice(canvas.indexOf("export function Back("), canvas.indexOf("export function Back(") + 800);
assert.match(back, /if \(slot\) return null;/, "inside a shell a screen's Back draws nothing itself");
assert.match(back, /slot\(\{ run: \(\) => latest\.current\(\) \}\);\s*return \(\) => slot\(null\);/, "it hands its action to the row and takes it back on leave");
assert.match(canvas, /\.canvas-top-row\{display:flex;align-items:center;justify-content:space-between/);
const circle = read("./screens/CircleCanvas.tsx");
assert.match(circle, /<CanvasTopRow onBack=\{step \? \(\) => setStep\(step - 1\) : onBack\} chip=\{<CommunityChip/, "Circles: the same row");
assert.doesNotMatch(circle, /<Back /);
console.log("PASS canvas back: one top row on Browse and Circles — Back left, country chip right");

// Jet (after 6.4.31-rc.2): "why do we have to squint to see them?" Every Back
// is the one shared button: ink outline, bold body-size label, drawn chevron,
// a full touch target. No screen draws its own thin grey arrow link.
{
  const { BackButton } = await import("./components/BackButton.js");
  const { translate } = await import("../i18n/index.js");
  const html = renderToStaticMarkup(<BackButton onClick={() => {}} label="Back" />);
  for (const rule of [/border:2px solid #/, /font-weight:700/, /font-size:var\(--chama-fs-body\)/, /min-height:var\(--chama-h-touch\)/, /\.chama-back:disabled\{/])
    assert.match(html, rule, `shared Back style has ${rule}`);
  assert.doesNotMatch(html.match(/\.chama-back\{[^}]*\}/)![0], /color:#8A899A/, "never the muted grey");
  const surfaces = ["./App.tsx", "./components/CardBack.tsx", "./components/CoachMarkTour.tsx", "./panels/AtomicFundingModal.tsx", "./panels/NsecLogin.tsx",
    "./screens/AssistedCanvas.tsx", "./screens/CircleSurface.tsx", "./screens/ConnectScreen.tsx", "./screens/CreateForm.tsx", "./screens/GlobeCountryPicker.tsx",
    "./screens/HelpScreen.tsx", "./screens/LiveTradeSurface.tsx", "./screens/SettingsAdvanced.tsx", "./screens/TradeDetail.tsx"];
  for (const file of surfaces) {
    const src = read(file);
    assert.match(src, /<(BackButton|SharedBackButton)\b/, `${file} uses the shared Back`);
    assert.doesNotMatch(src, /[←‹] ?(Back\b|\{t\("common\.back"\)\}|\{tr\("common\.back"\)\}|\{backLabel\}|\{children\})/, `${file} draws no hand-made arrow link`);
    assert.doesNotMatch(src, /aria-label=\{t\("(common|help)\.back"\)\}[^>]*>\s*←/, `${file} has no icon-only arrow`);
  }
  for (const lang of ["en", "es", "fr", "sw"] as const) for (const key of ["common.back", "lts.back", "help.back", "chat.back", "create.backButton", "fund.backToInvoice"]) {
    const text = translate(lang, key as any);
    assert.ok(text && text !== key, `${key} is written in ${lang}`);
    assert.doesNotMatch(text, /^[←‹<]/, `${key} (${lang}) carries no arrow; the button draws the chevron`);
  }
  console.log("PASS every Back is the shared bold button, in every language");
}
