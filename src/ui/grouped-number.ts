// ══════════════════════════════════════════════════════════════════════════
// Chama — grouped number typing (v7 converter)
// ══════════════════════════════════════════════════════════════════════════
//
// Shows "1,250,000" while the user types "1250000", in the viewer's own
// separators (en "1,250,000.5", fr "1 250 000,5", es "1.250.000,5"). The
// value the app computes with is always the canonical raw string: ASCII
// digits with an optional "." decimal ("1250000.5"). Display only: nothing
// here is used for a money path, only for the price converter.

export interface Separators { group: string; decimal: string }

export function separatorsFor(lang: string): Separators {
  try {
    const parts = new Intl.NumberFormat(lang).formatToParts(1234567.5);
    return {
      group: parts.find(p => p.type === "group")?.value ?? ",",
      decimal: parts.find(p => p.type === "decimal")?.value ?? ".",
    };
  } catch {
    return { group: ",", decimal: "." };
  }
}

const MAX_INT_DIGITS = 15;

/** True when `ch` typed by the user means "decimal point" in this locale. A
 *  "." or "," counts as a decimal unless it is the locale's group separator,
 *  so French users can type either, and English users' commas are ignored. */
function isDecimalKey(ch: string, sep: Separators): boolean {
  if (ch === sep.decimal) return true;
  return (ch === "." || ch === ",") && ch !== sep.group;
}

/** Reads whatever is in the field (typed, pasted, or our own formatting) into
 *  the canonical raw string. Keeps a trailing "." while typing ("12."). */
export function parseTyped(text: string, sep: Separators, maxDecimals: number): string {
  let int = "";
  let frac: string | null = null;
  for (const ch of text) {
    if (ch >= "0" && ch <= "9") {
      if (frac === null) { if (int.length < MAX_INT_DIGITS) int += ch; }
      else if (frac.length < maxDecimals) frac += ch;
    } else if (maxDecimals > 0 && frac === null && isDecimalKey(ch, sep)) {
      frac = "";
    }
  }
  int = int.replace(/^0+(?=\d)/, "");
  if (frac !== null && int === "") int = "0";
  return frac === null ? int : `${int}.${frac}`;
}

/** Canonical raw string → what the field shows. */
export function formatRaw(raw: string, sep: Separators): string {
  if (!raw) return "";
  const [int, frac] = raw.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep.group);
  return frac === undefined ? grouped : `${grouped}${sep.decimal}${frac}`;
}

/** Number of digits and decimal points in `text` before `caret`. A caret is
 *  "after the Nth meaningful character", which survives regrouping. */
export function meaningfulBefore(text: string, caret: number, sep: Separators): number {
  let n = 0;
  for (const ch of text.slice(0, caret)) {
    if ((ch >= "0" && ch <= "9") || isDecimalKey(ch, sep)) n += 1;
  }
  return n;
}

/** Caret index in `formatted` just after `count` meaningful characters. */
export function caretAfter(formatted: string, count: number, sep: Separators): number {
  if (count <= 0) return 0;
  let n = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    const ch = formatted[i];
    if ((ch >= "0" && ch <= "9") || ch === sep.decimal) n += 1;
    if (n >= count) return i + 1;
  }
  return formatted.length;
}
