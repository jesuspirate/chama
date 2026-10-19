import assert from "node:assert/strict";
import { RAIL_REGISTRY, getRailByKey } from "./rail-registry.js";
import {
  getPhoneNumberDisplayParts,
  getPhoneNumberSaveError,
  phonePlaceholderForCountryIso,
  railPlaceholderForCountry,
} from "./saved-handles.js";

// Calling codes for every country a phone rail lists or a phone example
// names. Kept here, apart from the app's tables, so a typo in either shows.
const CALLING_CODE: Record<string, string> = {
  AO: "244", AR: "54", BD: "880", BF: "226", BI: "257", BJ: "229", BR: "55",
  BW: "267", CD: "243", CF: "236", CG: "242", CI: "225", CL: "56", CM: "237",
  CO: "57", CR: "506", CV: "238", DJ: "253", EG: "20", ER: "291", ET: "251",
  GA: "241", GH: "233", GM: "220", GN: "224", GQ: "240", GW: "245", ID: "62",
  IN: "91", KE: "254", KH: "855", KM: "269", LR: "231", LS: "266", MG: "261",
  ML: "223", MM: "95", MR: "222", MU: "230", MW: "265", MX: "52", MY: "60",
  MZ: "258", NE: "227", NG: "234", PE: "51", PH: "63", PK: "92", RW: "250",
  SC: "248", SG: "65", SL: "232", SN: "221", SO: "252", SS: "211", ST: "239",
  SV: "503", SZ: "268", TD: "235", TG: "228", TH: "66", TZ: "255", UG: "256",
  US: "1", UY: "598", VN: "84", ZA: "27", ZM: "260", ZW: "263",
};

const isPurePhone = (value: string | undefined) => !!value && /^\+[\d ]+$/.test(value);
const digits = (value: string) => value.replace(/\D/g, "");

// The reported bug: M-Pesa in Kenya showed Tanzania's +255.
assert.equal(railPlaceholderForCountry(getRailByKey("m-pesa"), "KE"), "+254 712 345 678");
assert.equal(railPlaceholderForCountry(getRailByKey("m-pesa"), "TZ"), "+255 74 123 4567", "Vodacom, not Tigo");
assert.equal(railPlaceholderForCountry(getRailByKey("airtel-money"), "KE"), "+254 733 123 456");
assert.equal(railPlaceholderForCountry(getRailByKey("phone-number"), "SN"), "+221 77 123 4567");
// A rail that doesn't work in the viewer's country keeps its own country.
assert.equal(railPlaceholderForCountry(getRailByKey("wave"), "KE"), "+221 77 123 4567");
// Mixed examples are prose, not a number to localise.
assert.equal(railPlaceholderForCountry(getRailByKey("zelle"), "KE"), "you@example.com or +1 555 555 5555");
assert.equal(railPlaceholderForCountry(getRailByKey("m-pesa"), null), "+254 712 345 678");

let checked = 0;
for (const rail of RAIL_REGISTRY) {
  // Each listed country's example carries that country's calling code and,
  // where Chama checks lengths, would be accepted if typed.
  for (const iso of rail.countries ?? []) {
    const example = railPlaceholderForCountry(rail, iso);
    if (!isPurePhone(example) || !isPurePhone(rail.placeholder)) continue;
    const code = CALLING_CODE[iso];
    assert.ok(code, `${iso} needs a calling code in this test`);
    if (!phonePlaceholderForCountryIso(iso) && !rail.placeholdersByCountry?.[iso]) continue;
    assert.ok(digits(example!).startsWith(code), `${rail.key} in ${iso} shows ${example}, expected +${code}`);
    assert.equal(getPhoneNumberSaveError(example!), null, `${rail.key} in ${iso}: ${example} is refused on save`);
    checked += 1;
  }
  // The rail's own example belongs to its first country.
  const home = rail.countries?.[0];
  if (home && isPurePhone(rail.placeholder)) {
    assert.ok(digits(rail.placeholder!).startsWith(CALLING_CODE[home]), `${rail.key} default ${rail.placeholder} is not from ${home}`);
  }
}
assert.ok(checked > 80, `checked ${checked} rail/country examples`);

// Every country example carries its own calling code.
for (const [iso, code] of Object.entries(CALLING_CODE)) {
  const example = phonePlaceholderForCountryIso(iso);
  if (!example) continue;
  assert.ok(digits(example).startsWith(code), `${iso} example ${example} is not +${code}`);
  // The phone field splits the example into code + local part; it must find
  // the whole code, or Costa Rica's +506 shows as "+50 6…".
  assert.equal(getPhoneNumberDisplayParts(example).countryCode, code, `${iso} example ${example} splits at the wrong code`);
}

// Benin's 10-digit numbers (since Nov 2024) save; the old 8 still do.
assert.equal(getPhoneNumberSaveError("+229 01 97 12 34 56"), null);
assert.equal(getPhoneNumberSaveError("+229 97 12 34 56"), null);

console.log(`Phone examples: ${checked} rail/country pairs show the viewer's own calling code`);
