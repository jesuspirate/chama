import type { EscrowState, MenuItem } from "../escrow-engine/types.js";

export type MarketMatchReason =
  | "close-name"
  | "related-words"
  | "within-budget"
  | "near-budget"
  | "available-alternative";

export interface MarketMatch {
  listing: EscrowState;
  amountSats: number;
  matchedItem?: MenuItem;
  nameScore: number;
  amountScore: number;
  score: number;
  overBudgetSats: number;
  reasons: MarketMatchReason[];
}

export interface MarketMatchOptions {
  query: string;
  budgetSats: number;
  limit?: number;
}

const STOP_WORDS = new Set([
  "a", "am", "an", "and", "buy", "find", "for", "get", "i", "im", "looking",
  "me", "need", "of", "please", "some", "the", "to", "want", "would",
]);

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stem(value: string): string {
  if (value.length > 4 && value.endsWith("es")) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function words(value: string, removeStops = false): string[] {
  return normalize(value)
    .split(" ")
    .filter(Boolean)
    .filter(word => !removeStops || !STOP_WORDS.has(word))
    .map(stem);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length]!;
}

function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return 0.92;
  const distance = editDistance(a, b);
  return Math.max(0, 1 - distance / Math.max(a.length, b.length, 1));
}

export function marketNameScore(query: string, candidate: string): number {
  const queryWords = words(query, true);
  const candidateWords = words(candidate);
  if (queryWords.length === 0 || candidateWords.length === 0) return 0;
  const phraseQuery = queryWords.join(" ");
  const phraseCandidate = candidateWords.join(" ");
  if (phraseCandidate.includes(phraseQuery) || phraseQuery.includes(phraseCandidate)) return 1;
  const perWord = queryWords.map(queryWord =>
    Math.max(...candidateWords.map(candidateWord => wordSimilarity(queryWord, candidateWord))),
  );
  return perWord.reduce((sum, score) => sum + score, 0) / perWord.length;
}

function variants(listing: EscrowState): Array<{ text: string; amountSats: number; item?: MenuItem }> {
  const base = [{
    text: listing.description,
    amountSats: Math.max(1, Math.floor(listing.amountMsats / 1000)),
  }];
  return [
    ...base,
    ...(listing.items ?? []).map(item => ({
      text: `${item.label} ${item.description ?? ""} ${listing.description}`,
      amountSats: Math.max(1, Math.floor(item.amountMsats / 1000)),
      item,
    })),
  ];
}

/** Recall-first Market matching. Availability and self-listing exclusion happen
 * before this function. Every available listing remains discoverable; text and
 * price affect order and explanations, never create an exact-spelling trap. */
export function matchMarketListings(
  listings: readonly EscrowState[],
  options: MarketMatchOptions,
): MarketMatch[] {
  const budget = Math.max(1, Math.floor(options.budgetSats));
  const limit = Math.max(1, Math.min(options.limit ?? 12, 30));
  const matches = listings.map(listing => {
    const candidates = variants(listing).map(candidate => {
      const nameScore = marketNameScore(options.query, candidate.text);
      const difference = Math.abs(candidate.amountSats - budget);
      const amountScore = 1 / (1 + difference / Math.max(10, budget * 0.2));
      const overBudgetSats = Math.max(0, candidate.amountSats - budget);
      const reasons: MarketMatchReason[] = [];
      if (nameScore >= 0.82) reasons.push("close-name");
      else if (nameScore >= 0.48) reasons.push("related-words");
      if (candidate.amountSats <= budget) reasons.push("within-budget");
      else if (overBudgetSats <= Math.max(10, Math.ceil(budget * 0.15))) reasons.push("near-budget");
      if (reasons.length === 0) reasons.push("available-alternative");
      return {
        listing,
        amountSats: candidate.amountSats,
        ...(candidate.item ? { matchedItem: candidate.item } : {}),
        nameScore,
        amountScore,
        // Amount leads, as promised; forgiving text similarity breaks close
        // price ties and rescues ordinary spelling mistakes.
        score: amountScore * 0.55 + nameScore * 0.45,
        overBudgetSats,
        reasons,
      } satisfies MarketMatch;
    });
    return candidates.sort((a, b) => b.score - a.score || a.amountSats - b.amountSats)[0]!;
  });
  return matches
    .sort((a, b) =>
      b.score - a.score
      || a.overBudgetSats - b.overBudgetSats
      || a.amountSats - b.amountSats
      || a.listing.id.localeCompare(b.listing.id)
    )
    .slice(0, limit);
}
