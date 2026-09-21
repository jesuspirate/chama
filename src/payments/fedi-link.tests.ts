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
assert.equal(fediEcashLink("not a token"), null, "spaces are not note shape");
assert.equal(fediEcashLink("javascript:alert(1)"), null, "anything but note shape is refused");
assert.equal(fediEcashLink("<script>"), null);

console.log("Fedi ecash link: fragment-only, shape-checked, refuses what it should");
