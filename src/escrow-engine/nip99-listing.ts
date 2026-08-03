import { nip19 } from "nostr-tools";
import type { CreatePayload } from "./types.js";

export const NIP99_CLASSIFIED_LISTING_KIND = 30402;

/**
 * NIP-99 is Chama's public storefront layer. The escrow protocol remains on
 * kind 38100+, but marketplace listings are mirrored as standard classified
 * listings so clients which know nothing about Chama can still discover and
 * render them.
 */
export function isNip99StoreListing(payload: Pick<CreatePayload, "category" | "parent">): boolean {
  return payload.category === "marketplace" && !payload.parent;
}

export function chamaEscrowCoordinate(pubkey: string, escrowId: string): string {
  return `38100:${pubkey}:${escrowId}`;
}

export function nip99ListingCoordinate(pubkey: string, escrowId: string): string {
  return `${NIP99_CLASSIFIED_LISTING_KIND}:${pubkey}:${escrowId}`;
}

export function nip99ListingNaddr(pubkey: string, escrowId: string, relays: string[] = []): string {
  return nip19.naddrEncode({
    kind: NIP99_CLASSIFIED_LISTING_KIND,
    pubkey,
    identifier: escrowId,
    relays,
  });
}

export function nip99ListingUri(pubkey: string, escrowId: string, relays: string[] = []): string {
  return `nostr:${nip99ListingNaddr(pubkey, escrowId, relays)}`;
}

function listingTitle(payload: CreatePayload): string {
  const firstItem = payload.items?.[0]?.label?.trim();
  if (payload.items?.length === 1 && firstItem) return firstItem.slice(0, 120);
  const firstLine = payload.description.trim().split(/\r?\n/, 1)[0]?.trim();
  return (firstLine || firstItem || "Chama Store listing").slice(0, 120);
}

function priceTag(payload: CreatePayload): string[] {
  if (payload.fiatAmount !== undefined && payload.fiatCurrency) {
    return ["price", String(payload.fiatAmount), payload.fiatCurrency.toUpperCase()];
  }
  return ["price", String(payload.amountMsats / 1000), "SAT"];
}

function publicImageUrls(payload: CreatePayload): string[] {
  const urls = payload.imageUrls ?? [];
  return [...new Set(urls.filter(url => /^https?:\/\//i.test(url)))];
}

export function buildNip99ListingEvent(args: {
  payload: CreatePayload;
  pubkey: string;
  escrowId: string;
  createdAt: number;
}): { kind: number; created_at: number; content: string; tags: string[][] } | null {
  const { payload, pubkey, escrowId, createdAt } = args;
  if (!isNip99StoreListing(payload)) return null;

  const title = listingTitle(payload);
  const isWork = payload.listingKind === "work" || payload.listingKind === "work-request";
  const tags: string[][] = [
    ["d", escrowId],
    ["title", title],
    ["summary", payload.description.trim().slice(0, 240) || title],
    ["published_at", String(payload.createdAt || createdAt)],
    ["expiration", String((payload.createdAt || createdAt) + payload.expirySeconds)],
    priceTag(payload),
    ["status", "active"],
    ["t", isWork ? "work" : "marketplace"],
    ["t", "chama"],
    ["t", isWork ? "service" : (payload.fulfillment ?? "physical")],
    ["a", chamaEscrowCoordinate(pubkey, escrowId)],
    ...(payload.community ? [["t", `chama-${payload.community}`]] : []),
    ...(payload.country ? [["location", payload.country.toUpperCase()]] : []),
    ...publicImageUrls(payload).map(url => ["image", url]),
  ];

  return {
    kind: NIP99_CLASSIFIED_LISTING_KIND,
    created_at: createdAt,
    content: payload.description.trim(),
    tags,
  };
}
