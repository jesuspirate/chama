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
assert.match(row, /^<div class="canvas-top-row"><button type="button" data-chama-shortcut="back" class="canvas-back">← Back<\/button><b data-chip="true">USA<\/b><\/div>$/, "back left, chip right, one row");
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
console.log("PASS canvas back: one top row on Browse and Circles — \"← Back\" left, country chip right");
