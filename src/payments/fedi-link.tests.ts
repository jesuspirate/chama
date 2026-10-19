import assert from "node:assert/strict";
import { fediEcashLink, FEDI_LINK_MAX_TOKEN_CHARS } from "./fedi-link.js";

const token = "AwEEExampleNotePayloadForTests_-09";
const link = fediEcashLink(token);
assert.equal(link, `https://app.fedi.xyz/link#screen=ecash&id=${token}`);

// Bearer value never leaves the fragment.
assert.ok(link!.indexOf("#") < link!.indexOf(token), "the note rides after the hash, not in a query");
assert.ok(!link!.includes("?"), "no query string at all");

// Null is a normal answer — the caller keeps the QR and copy button.
assert.equal(fediEcashLink(""), null);
assert.equal(fediEcashLink(null), null);
assert.equal(fediEcashLink("   "), null);
assert.equal(fediEcashLink("A".repeat(FEDI_LINK_MAX_TOKEN_CHARS + 1)), null, "too long to hand to a handler");
// 6.4.28: a real withdraw spends dozens of notes (~107 chars each); the old
// 2,000 cap hid the button on every one Jet tried. 40 notes must still link.
const realistic = "A".repeat(40 * 107);
assert.ok(fediEcashLink(realistic)?.endsWith(realistic), "a 40-note withdraw still gets Open in Fedi");
assert.ok(FEDI_LINK_MAX_TOKEN_CHARS >= 8_000, "the cap leaves room for a full wallet of notes");
assert.equal(fediEcashLink("not a token"), null, "spaces are not note shape");
assert.equal(fediEcashLink("javascript:alert(1)"), null, "anything but note shape is refused");
assert.equal(fediEcashLink("<script>"), null);

console.log("Fedi ecash link: fragment-only, shape-checked, refuses what it should");
