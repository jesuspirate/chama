// ══════════════════════════════════════════════════════════════════════════
// Chama — Create wizard (v0.2.0 item 5 + items 7, 10)
// ══════════════════════════════════════════════════════════════════════════
//
// Three-step wizard for publishing a listing. Per the v0.2.0 brief:
//
//   Step 1 — Category + community context. Four large category cards
//     (Exchange / Community Bill Pay / Marketplace / Lending) above a read-only
//     "Listing in [home community]" line. Federation is never named
//     here — derived downstream from the community.
//
//     Item 10: arbiter attention warning surfaces here when the user
//     is arbiter on a LOCKED escrow (soft = no disagreement yet, hard
//     = vote-pending tiebreaker). Soft = informational; hard =
//     conflict-explicit with asymmetric CTA. Either way it's a warning,
//     not a block — Pillar 2.7 educational moment.
//
//     Save-draft surfacing: "Continue your last [vertical] listing"
//     cards for any drafts in localStorage, cap 3 visible (sorted by
//     savedAt desc), older drafts behind "Show more drafts" expander.
//
//   Step 2 — Vertical-specific form. Ships description + amount + fiat,
//     accepted payment rails, menu/bracket rows, marketplace fulfillment,
//     and the future graduated subscription surface.
//
//     Item 7: subscription toggle is invisible unless canOfferSubscription
//     === true. v0.2.0 universally false (no rating events yet) → toggle
//     hidden for everyone. When v0.2.1 wires the rating aggregator the
//     gate naturally opens for graduated sellers.
//
//   Step 3 — Review & publish. Preview card (left/top) + federation-
//     honesty info card (one-time-per-account, dismissed on first
//     publish). Save-draft button + Publish button.

import { useState, useEffect } from "react";
import { useT, translate, getCurrentLang } from "../../i18n/index.js";
import { type MenuItem } from "../../escrow-engine/types.js";
import { randomId } from "../../storage/random-id.js";
import { categoryAllowsFulfillmentChoice, type Fulfillment } from "../../labels/vote-labels.js";
import { getCommunityBySlug, communityForInvite, DEFAULT_COMMUNITY_SLUG } from "../../communities/registry.js";
import { billTypesForCountry, billTypeDisplay } from "../../communities/bill-types.js";
import { workCategoriesForCountry } from "../../communities/work-categories.js";
import { onchainEscrowAvailable, DEFAULT_ESCROW_MODE, ESCROW_NETWORK_LABEL } from "../../bond-multisig/onchain-escrow.js";
import {
  getUserCommunitySlug,
  getUserCommunitySlugRaw,
  setUserCommunitySlug,
} from "../../communities/storage.js";
import { defaultCurrencyForCommunity } from "../../communities/currency.js";
import { getTrustedArbiterPool } from "../../arbiters/pool.js";
import { ARBITER_FAULT_READS_ENABLED } from "../../arbiters/arbiter-fault.js";
import { assignableBondedArbiters } from "../../arbiters/exposure.js";
import { sellerIsBonded, resolveListingTenure } from "../../escrow-engine/listing-renewal.js";
import type { VerifiedBond } from "../../bond-multisig/bond-announcement.js";
import { type ArbiterWarning, displayCounterpartyName, resolveCreateMintUrl } from "../decisions.js";
import { T, inputStyle, fmtSats } from "../theme.js";
import {
  MIN_REAL_ATOMIC_FUNDING_SATS,
  minimumAtomicFundingMessage,
} from "../../payments/funding-limits.js";
import {
  type Rail,
  getRailByKey,
  railsForCommunity,
  searchableRailsForCommunity,
  categoryUsesPaymentRails,
  toRailKey,
} from "../../payments/rail-registry.js";
import { isTestnetMode } from "../../fedimint/index.js";
import { isSimModeOn } from "../../sim/simMode.js";
import {
  getScopedStorageItem,
  removeScopedStorageItem,
  setScopedStorageItem,
} from "../../storage/user-scope.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import {
  estimateFiatForMsats,
  estimateSatsForFiat,
  formatFiatAmount,
  type AmountDisplayMode,
} from "../amount-display.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { ensureRemoteListingImage, MAX_LISTING_IMAGE_REFS, type ListingImageUploadAuthorizer } from "../../media/listing-image-upload.js";
import { SwipeImageGallery } from "../components/SwipeImageGallery.js";

type Step = 1 | 2 | 3;

/** ⚰️ `lending` is RETIRED and unreachable for NEW listings: it is absent from
 *  VERTICALS, so it cannot be selected, and `readAllDrafts` only iterates that
 *  list so an old lending draft can never be restored either.
 *
 *  ⚠ The type and its render/reducer paths are KEPT ON PURPOSE, and must not be
 *  deleted or commented out. A `lending` escrow published by an older client
 *  still lives on relays, and replay is how Chama reads money history — code
 *  that a real trade's chain depends on is not dead code. Commenting it out
 *  would be the worst of both: the trade stops rendering AND the reason is
 *  buried. Retired means "no new ones", not "pretend the old ones never
 *  happened".
 *
 *  RULE: a retired vertical never gains new capabilities. */
type Vertical = "p2p-trade" | "bill-pay" | "marketplace" | "work" | "lending";
type ListingMode = "single" | "menu";

// Trade-type cards, mirroring the onboarding splash (INTRO_USE_CASES). The three
// Live verticals carry real `Vertical` ids; the coming-soon previews carry
// display-only ids (never reach setVertical — the click is guarded on !soon) so
// the wizard sells the same vision the splash does without promising a creatable
// flow that isn't wired. `id` is `string` for that reason. Lending retired here
// Work now reuses marketplace money semantics via listingKind; the "lending"
// Vertical + logic stay in code for back-compat.
// i18n: label/description are DICTIONARY KEYS, resolved with t() at render
// (module-level constants can't call hooks) — same pattern as INTRO_USE_CASES.
const VERTICALS: { id: string; labelKey: string; icon: string; descriptionKey: string; comingSoon?: boolean }[] = [
  { id: "p2p-trade", labelKey: "create.verticalExchange", icon: "⚡", descriptionKey: "create.verticalExchangeDesc" },
  { id: "bill-pay", labelKey: "create.verticalBillPay", icon: "🧾", descriptionKey: "create.verticalBillPayDesc" },
  { id: "marketplace", labelKey: "create.verticalMarketplace", icon: "🏪", descriptionKey: "create.verticalMarketplaceDesc" },
  { id: "work", labelKey: "create.verticalWork", icon: "🛠️", descriptionKey: "create.verticalWorkDesc" },
  { id: "chip-in", labelKey: "create.verticalChipIn", icon: "🤝", descriptionKey: "create.verticalChipInDesc", comingSoon: true },
  { id: "stack", labelKey: "create.verticalStack", icon: "🪙", descriptionKey: "create.verticalStackDesc", comingSoon: true },
];

interface FormState {
  listingMode: ListingMode;
  desc: string;
  /** Product cover for a single listing, or the one storefront cover/logo. */
  imageDataUrl: string;
  /** Ordered single-listing gallery, or a one-entry storefront cover. */
  imageUrls: string[];
  sats: string;
  fiat: string;
  cur: string;
  premium: string;
  /** v4.1 (#12): optional Community-Bill-Pay bill-type id (single listing). */
  billType?: string;
  workSide?: "work" | "work-request";
  workCategory?: string;
  escrowMode?: "ecash" | "onchain";
  /** Monthly CBP: owner marked this bill (bundle) as recurring — the client
   *  auto-re-posts it ~monthly to their home community. Bill-pay only. */
  recurringCbp?: boolean;
  fulfillment: Fulfillment;
  isSubscription: boolean;
  periods: string;
  intervalDays: string;
  paymentMethods: string[];
  menuItems: MenuDraftItem[];
  /** #7 multi-unit storefront: units in stock for a single-product marketplace
   *  listing. ">=2 makes it a multi-unit parent (buyers spawn child escrows);
   *  blank / 1 is a legacy single-unit listing. Stored as a string for the
   *  input; parsed at submit. Optional so older drafts load without it. */
  stock?: string;
}

interface SavedDraft {
  vertical: Vertical;
  formState: FormState;
  savedAt: number;
}

interface MenuDraftItem {
  id: string;
  label: string;
  sats: string;
  maxSats: string;
  fiat: string;
  description: string;
  fulfillment: Fulfillment;
  imageDataUrl: string;
  imageUrls: string[];
  dueDate: string;
  termDays: string;
  apr: string;
  trustTier: string;
  maxQty: string;
}

const DRAFT_KEY_PREFIX = "chama_create_draft_";
const FIRST_PUBLISH_KEY_PREFIX = "chama_first_publish_done_";
const MAX_MENU_ITEMS = 20;
const MAX_LISTING_IMAGES = MAX_LISTING_IMAGE_REFS;
const MAX_MENU_IMAGE_DATA_URL_CHARS = 500_000;
const MENU_IMAGE_MAX_EDGE_PX = 1280;
const MENU_IMAGE_ACCEPT = [
  "image/*",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
].join(",");
// i18n: labelKey resolved with translate(getCurrentLang()) at render.
const LENDING_TIER_LIMITS = [
  { tier: 1, maxSats: 50_000, labelKey: "create.tierStarter" },
  { tier: 2, maxSats: 200_000, labelKey: "create.tierProven" },
  { tier: 3, maxSats: 500_000, labelKey: "create.tierTrusted" },
  { tier: 4, maxSats: 1_000_000, labelKey: "create.tierPrime" },
  { tier: 5, maxSats: 2_000_000, labelKey: "create.tierOg" },
] as const;
const MAX_FEDIMINT_LENDING_SATS = LENDING_TIER_LIMITS[LENDING_TIER_LIMITS.length - 1].maxSats;

function newMenuDraftItem(): MenuDraftItem {
  return {
    id: `mi_${Date.now().toString(36)}_${randomId(6)}`,
    label: "",
    sats: "",
    maxSats: "",
    fiat: "",
    description: "",
    fulfillment: "service",
    imageDataUrl: "",
    imageUrls: [],
    dueDate: "",
    termDays: "",
    apr: "",
    trustTier: "",
    maxQty: "",
  };
}

function normalizeMenuDraftItem(raw: any): MenuDraftItem | null {
  if (!raw || typeof raw !== "object") return null;
  const legacyImage = typeof raw.imageDataUrl === "string" ? raw.imageDataUrl : "";
  return {
    id: typeof raw.id === "string" && raw.id.trim()
      ? raw.id
      : newMenuDraftItem().id,
    label: typeof raw.label === "string" ? raw.label : "",
    sats: typeof raw.sats === "string" || typeof raw.sats === "number" ? String(raw.sats) : "",
    maxSats: typeof raw.maxSats === "string" || typeof raw.maxSats === "number" ? String(raw.maxSats) : "",
    fiat: typeof raw.fiat === "string" || typeof raw.fiat === "number" ? String(raw.fiat) : "",
    description: typeof raw.description === "string" ? raw.description : "",
    fulfillment: raw.fulfillment === "physical" || raw.fulfillment === "digital" || raw.fulfillment === "service"
      ? raw.fulfillment
      : "service",
    imageDataUrl: legacyImage,
    imageUrls: Array.isArray(raw.imageUrls) ? raw.imageUrls.filter((v: unknown): v is string => typeof v === "string").slice(0, MAX_LISTING_IMAGES) : legacyImage ? [legacyImage] : [],
    dueDate: typeof raw.dueDate === "string" ? raw.dueDate : "",
    termDays: typeof raw.termDays === "string" || typeof raw.termDays === "number" ? String(raw.termDays) : "",
    apr: typeof raw.apr === "string" || typeof raw.apr === "number" ? String(raw.apr) : "",
    trustTier: typeof raw.trustTier === "string" || typeof raw.trustTier === "number" ? String(raw.trustTier) : "",
    maxQty: typeof raw.maxQty === "string" || typeof raw.maxQty === "number" ? String(raw.maxQty) : "",
  };
}

function inferImageMimeType(file: File): string | null {
  if (file.type.startsWith("image/")) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "avif") return "image/avif";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  if (ext === "bmp") return "image/bmp";
  return null;
}

function normalizeImageDataUrl(file: File, dataUrl: string): string | null {
  if (dataUrl.startsWith("data:image/")) return dataUrl;
  const mimeType = inferImageMimeType(file);
  if (!mimeType) return null;
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return null;
  return `data:${mimeType};base64,${dataUrl.slice(commaIndex + 1)}`;
}

function readImageFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Couldn't read image"));
    reader.readAsDataURL(file);
  });
}

function loadImageDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't preview image"));
    img.src = dataUrl;
  });
}

async function prepareMenuImageDataUrl(file: File): Promise<string> {
  const original = normalizeImageDataUrl(file, await readImageFileAsDataUrl(file));
  if (!original) {
    throw new Error("That file doesn't look like a supported photo.");
  }
  if (original.length <= MAX_MENU_IMAGE_DATA_URL_CHARS) return original;

  const img = await loadImageDataUrl(original);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  for (const maxEdge of [MENU_IMAGE_MAX_EDGE_PX, 1024, 820, 640, 500]) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image preview is not available in this browser.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    for (const quality of [0.82, 0.72, 0.62, 0.52, 0.42]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length <= MAX_MENU_IMAGE_DATA_URL_CHARS) return dataUrl;
    }
  }

  throw new Error("That screenshot is too large for this release. Try a tighter crop.");
}

async function prepareImagesSequentially(files: File[]): Promise<string[]> {
  const prepared: string[] = [];
  for (const file of files) prepared.push(await prepareMenuImageDataUrl(file));
  return prepared;
}

async function uploadImageRefsSequentially(
  refs: string[],
  filenameFor: (index: number) => string,
  authorize?: ListingImageUploadAuthorizer,
): Promise<string[]> {
  const uploaded: string[] = [];
  for (let index = 0; index < refs.length; index += 1) {
    uploaded.push(await ensureRemoteListingImage(refs[index], filenameFor(index), authorize));
  }
  return uploaded;
}

function normalizeFormState(raw: any, currency = "USD"): FormState {
  const fallback = emptyCreateFormState(currency);
  if (!raw || typeof raw !== "object") return fallback;
  const menuItems = Array.isArray(raw.menuItems)
    ? (raw.menuItems as unknown[])
        .map(normalizeMenuDraftItem)
        .filter((item): item is MenuDraftItem => item !== null)
        .slice(0, MAX_MENU_ITEMS)
    : [];
  const listingMode: ListingMode = raw.listingMode === "menu"
    ? "menu"
    : raw.listingMode === "single"
      ? "single"
      : menuItems.length > 0
        ? "menu"
        : fallback.listingMode;
  const legacyImage = typeof raw.imageDataUrl === "string" ? raw.imageDataUrl : "";
  return {
    ...fallback,
    ...raw,
    listingMode,
    imageDataUrl: legacyImage,
    imageUrls: Array.isArray(raw.imageUrls) ? raw.imageUrls.filter((v: unknown): v is string => typeof v === "string").slice(0, listingMode === "menu" ? 1 : MAX_LISTING_IMAGES) : legacyImage ? [legacyImage] : [],
    cur: fallback.cur,
    premium: typeof raw.premium === "string" || typeof raw.premium === "number" ? String(raw.premium) : fallback.premium,
    billType: typeof raw.billType === "string" ? raw.billType : "",
    workSide: raw.workSide === "work-request" ? "work-request" : "work",
    workCategory: typeof raw.workCategory === "string" ? raw.workCategory : "",
    escrowMode: raw.escrowMode === "onchain" || raw.escrowMode === "ecash" ? raw.escrowMode : DEFAULT_ESCROW_MODE,
    recurringCbp: raw.recurringCbp === true,
    paymentMethods: Array.isArray(raw.paymentMethods)
      ? raw.paymentMethods
          .map((method: unknown) => typeof method === "string" ? method.trim() : "")
          .filter(Boolean)
      : fallback.paymentMethods,
    fulfillment: raw.fulfillment === "physical" || raw.fulfillment === "digital" || raw.fulfillment === "service"
      ? raw.fulfillment
      : fallback.fulfillment,
    menuItems,
  };
}

function parseWholeSats(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseOptionalPositiveNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePremiumBps(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return undefined;
  const clamped = Math.max(-99, Math.min(1000, parsed));
  return Math.round(clamped * 100);
}

function satsWithPremium(baseSats: number, premiumBps: number | undefined): number {
  if (!Number.isFinite(baseSats) || baseSats <= 0) return 0;
  const multiplierBps = Math.max(1, 10_000 + (premiumBps ?? 0));
  return Math.max(1, Math.ceil((baseSats * multiplierBps) / 10_000));
}

function parseOptionalPositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function lendingTierForSats(sats: number): number | undefined {
  if (!Number.isFinite(sats) || sats <= 0) return undefined;
  return LENDING_TIER_LIMITS.find(limit => sats <= limit.maxSats)?.tier;
}

function lendingTierLimitForTier(tier: number | undefined): typeof LENDING_TIER_LIMITS[number] | undefined {
  return LENDING_TIER_LIMITS.find(limit => limit.tier === tier);
}

function lendingTierSummary(value: string) {
  const lang = getCurrentLang();
  const sats = parseWholeSats(value);
  const tier = lendingTierForSats(sats);
  const limit = lendingTierLimitForTier(tier);
  if (!sats) return translate(lang, "create.enterPrincipal");
  if (!tier || !limit) {
    return (
      <>
        {translate(lang, "create.aboveLendingCapBefore")} <BitcoinAmount sats={MAX_FEDIMINT_LENDING_SATS} size={11} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />{translate(lang, "create.aboveLendingCapAfter")}
      </>
    );
  }
  return (
    <>
      {translate(lang, "create.tierSummaryBefore", { tier, label: translate(lang, limit.labelKey) })} <BitcoinAmount sats={limit.maxSats} size={11} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
    </>
  );
}

function lendingAmountAboveCurrentCap(value: string): boolean {
  const sats = parseWholeSats(value);
  return sats > MAX_FEDIMINT_LENDING_SATS;
}

function parseDueDate(value: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value + "T23:59:59");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function menuKindForVertical(vertical: Vertical): NonNullable<MenuItem["kind"]> {
  if (vertical === "p2p-trade") return "exchange-bracket";
  if (vertical === "bill-pay") return "bill";
  if (vertical === "lending") return "loan";
  return "market-item";
}

function menuImagesAllowedForVertical(vertical: Vertical): boolean {
  return vertical === "marketplace" || vertical === "work";
}

function normalizeMenuItems(form: FormState, vertical: Vertical): MenuItem[] {
  if (form.listingMode !== "menu") return [];
  const premiumBps = vertical === "bill-pay" ? parsePremiumBps(form.premium) : undefined;
  return form.menuItems.flatMap((item, index) => {
    const label = item.label.trim();
    const minSats = parseWholeSats(item.sats);
    const itemSats = vertical === "bill-pay" ? satsWithPremium(minSats, premiumBps) : minSats;
    const maxSats = vertical === "p2p-trade"
      ? (parseWholeSats(item.maxSats) || minSats)
      : minSats;
    if (!label || minSats <= 0) return [];
    if (vertical === "p2p-trade" && maxSats < minSats) return [];
    const fiatAmount = vertical === "lending"
      ? undefined
      : item.fiat.trim()
        ? Number.parseFloat(item.fiat)
        : undefined;
    const kind = menuKindForVertical(vertical);
    return [{
      id: item.id || `item_${index + 1}`,
      label,
      kind,
      amountMsats: itemSats * 1000,
      minAmountMsats: vertical === "p2p-trade" ? minSats * 1000 : undefined,
      maxAmountMsats: vertical === "p2p-trade" ? maxSats * 1000 : undefined,
      description: item.description.trim() || undefined,
      fiatAmount: Number.isFinite(fiatAmount) ? fiatAmount : undefined,
      fiatCurrency: Number.isFinite(fiatAmount) ? form.cur : undefined,
      // A storefront has one delivery promise. Individual product rows inherit
      // it so buyers never see a Shipping store containing Service items (or
      // the reverse). Legacy drafts are normalized here at publish time too.
      fulfillment: vertical === "marketplace" ? form.fulfillment : undefined,
      imageDataUrl: menuImagesAllowedForVertical(vertical) && item.imageDataUrl ? item.imageDataUrl : undefined,
      imageUrls: menuImagesAllowedForVertical(vertical) && item.imageUrls.length ? item.imageUrls : undefined,
      dueAt: vertical === "bill-pay" ? parseDueDate(item.dueDate) : undefined,
      termDays: vertical === "lending" ? parseOptionalPositiveInt(item.termDays) : undefined,
      aprBps: vertical === "lending"
        ? (() => {
            const apr = parseOptionalPositiveNumber(item.apr);
            return apr === undefined ? undefined : Math.round(apr * 100);
          })()
        : undefined,
      trustTier: vertical === "lending" ? lendingTierForSats(minSats) : undefined,
      maxQuantity: vertical === "marketplace" ? parseOptionalPositiveInt(item.maxQty) : undefined,
    }];
  });
}

function hasLendingAmountAboveCurrentCap(form: FormState, vertical: Vertical): boolean {
  if (vertical !== "lending") return false;
  if (form.listingMode === "menu") {
    return form.menuItems.some(item => lendingAmountAboveCurrentCap(item.sats));
  }
  return lendingAmountAboveCurrentCap(form.sats);
}

function hasPartialMenuRows(form: FormState, vertical: Vertical): boolean {
  if (form.listingMode !== "menu") return false;
  return form.menuItems.some(item => {
    const touched = item.label.trim()
      || item.sats.trim()
      || item.maxSats.trim()
      || item.fiat.trim()
      || item.description.trim()
      || item.imageDataUrl
      || item.imageUrls.length > 0
      || item.dueDate.trim()
      || item.termDays.trim()
      || item.apr.trim()
      || item.trustTier.trim();
    if (!touched) return false;
    if (!item.label.trim() || parseWholeSats(item.sats) <= 0) return true;
    if (vertical === "p2p-trade") {
      const maxSats = parseWholeSats(item.maxSats);
      if (item.maxSats.trim() && maxSats <= 0) return true;
      return maxSats > 0 && maxSats < parseWholeSats(item.sats);
    }
    return false;
  });
}

function minimumMenuSats(items: MenuItem[]): number {
  if (items.length === 0) return 0;
  return Math.min(...items.map(item => Math.floor(item.amountMsats / 1000)));
}

function effectiveListingSats(form: FormState, vertical: Vertical): number {
  const menuItems = normalizeMenuItems(form, vertical);
  if (menuItems.length > 0) return minimumMenuSats(menuItems);
  const baseSats = vertical === "bill-pay"
    ? satsWithPremium(parseWholeSats(form.sats), parsePremiumBps(form.premium))
    : parseWholeSats(form.sats);
  return form.isSubscription
    ? baseSats * parseWholeSats(form.periods)
    : baseSats;
}

function hasDraftContent(form: FormState): boolean {
  return !!(
    form.desc.trim()
    || form.imageDataUrl
    || form.imageUrls.length > 0
    || form.sats.trim()
    || form.fiat.trim()
    || form.premium.trim()
    || form.paymentMethods.length > 0
    || form.menuItems.some(item =>
      item.label.trim()
      || item.sats.trim()
      || item.maxSats.trim()
      || item.fiat.trim()
      || item.description.trim()
      || item.imageDataUrl
      || item.imageUrls.length > 0
      || item.dueDate.trim()
      || item.termDays.trim()
      || item.apr.trim()
      || item.trustTier.trim()
    )
  );
}

function readDraft(vertical: Vertical): SavedDraft | null {
  try {
    const raw = getScopedStorageItem(DRAFT_KEY_PREFIX + vertical);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.vertical || !parsed?.formState) return null;
    return {
      vertical: parsed.vertical,
      formState: normalizeFormState(parsed.formState),
      savedAt: Number.isFinite(parsed.savedAt) ? parsed.savedAt : Date.now(),
    };
  } catch { return null; }
}

function writeDraft(draft: SavedDraft): void {
  try {
    setScopedStorageItem(DRAFT_KEY_PREFIX + draft.vertical, JSON.stringify(draft));
  } catch { /* no-op */ }
}

function clearDraft(vertical: Vertical): void {
  try {
    removeScopedStorageItem(DRAFT_KEY_PREFIX + vertical);
  } catch { /* no-op */ }
}

function readAllDrafts(): SavedDraft[] {
  return VERTICALS
    .filter(v => !v.comingSoon)
    .map(v => readDraft(v.id as Vertical))
    .filter((d): d is SavedDraft => d !== null)
    .sort((a, b) => b.savedAt - a.savedAt);
}

function hasFirstPublishedBefore(pubkey: string | null): boolean {
  if (!pubkey) return false;
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(FIRST_PUBLISH_KEY_PREFIX + pubkey) === "1";
  } catch { return false; }
}

function markFirstPublished(pubkey: string | null): void {
  if (!pubkey) return;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(FIRST_PUBLISH_KEY_PREFIX + pubkey, "1");
    }
  } catch { /* no-op */ }
}

function menuTitleForVertical(vertical: Vertical): string {
  const lang = getCurrentLang();
  if (vertical === "p2p-trade") return translate(lang, "create.menuTitleExchange");
  if (vertical === "bill-pay") return translate(lang, "create.menuTitleBillPay");
  if (vertical === "lending") return translate(lang, "create.menuTitleLending");
  return translate(lang, "create.menuTitleMarket");
}

function menuAddLabelForVertical(vertical: Vertical): string {
  const lang = getCurrentLang();
  if (vertical === "p2p-trade") return translate(lang, "create.menuAddExchange");
  if (vertical === "bill-pay") return translate(lang, "create.menuAddBillPay");
  if (vertical === "lending") return translate(lang, "create.menuAddLending");
  return translate(lang, "create.menuAddMarket");
}

function menuPlaceholderForVertical(vertical: Vertical, index: number): string {
  const lang = getCurrentLang();
  if (vertical === "p2p-trade") return translate(lang, "create.menuPlaceholderExchange", { n: index + 1 });
  if (vertical === "bill-pay") return translate(lang, "create.menuPlaceholderBillPay", { n: index + 1 });
  if (vertical === "lending") return translate(lang, "create.menuPlaceholderLending", { n: index + 1 });
  return translate(lang, "create.menuPlaceholderMarket", { n: index + 1 });
}

function menuHintForVertical(vertical: Vertical): string {
  const lang = getCurrentLang();
  if (vertical === "p2p-trade") return translate(lang, "create.menuHintExchange");
  if (vertical === "bill-pay") return translate(lang, "create.menuHintBillPay");
  if (vertical === "lending") return translate(lang, "create.menuHintLending");
  return translate(lang, "create.menuHintMarket");
}

function menuCurrencyHint(vertical: Vertical, currency: string): string {
  const lang = getCurrentLang();
  if (vertical === "p2p-trade") return translate(lang, "create.menuCurrencyExchange", { currency });
  if (vertical === "bill-pay") return translate(lang, "create.menuCurrencyBillPay", { currency });
  if (vertical === "lending") return translate(lang, "create.menuCurrencyLending", { currency });
  return translate(lang, "create.menuCurrencyMarket", { currency });
}

function singleModeLabel(vertical: Vertical): string {
  const lang = getCurrentLang();
  if (vertical === "work") return translate(lang, "create.singleModeWork");
  if (vertical === "bill-pay") return translate(lang, "create.singleModeBillPay");
  if (vertical === "marketplace") return translate(lang, "create.singleModeMarket");
  if (vertical === "lending") return translate(lang, "create.singleModeLending");
  return translate(lang, "create.singleModeExchange");
}

function menuModeLabel(vertical: Vertical): string {
  const lang = getCurrentLang();
  if (vertical === "p2p-trade") return translate(lang, "create.menuModeExchange");
  if (vertical === "bill-pay") return translate(lang, "create.menuModeBillPay");
  if (vertical === "lending") return translate(lang, "create.menuModeLending");
  return translate(lang, "create.menuModeMarket");
}

function singleModeDescription(vertical: Vertical): string {
  const lang = getCurrentLang();
  if (vertical === "work") return translate(lang, "create.singleModeDescWork");
  if (vertical === "bill-pay") return translate(lang, "create.singleModeDescBillPay");
  if (vertical === "marketplace") return translate(lang, "create.singleModeDescMarket");
  if (vertical === "lending") return translate(lang, "create.singleModeDescLending");
  return translate(lang, "create.singleModeDescExchange");
}

function menuModeDescription(vertical: Vertical): string {
  const lang = getCurrentLang();
  if (vertical === "p2p-trade") return translate(lang, "create.menuModeDescExchange");
  if (vertical === "bill-pay") return translate(lang, "create.menuModeDescBillPay");
  if (vertical === "lending") return translate(lang, "create.menuModeDescLending");
  return translate(lang, "create.menuModeDescMarket");
}

function descriptionLabel(vertical: Vertical, usingMenu: boolean): string {
  const lang = getCurrentLang();
  if (vertical === "work") return translate(lang, "create.descLabelWork");
  if (usingMenu) {
    if (vertical === "bill-pay") return translate(lang, "create.descLabelBundle");
    if (vertical === "marketplace") return translate(lang, "create.descLabelStore");
    if (vertical === "lending") return translate(lang, "create.descLabelLoanBook");
    return translate(lang, "create.descLabelName");
  }
  return translate(lang, "create.descLabelDescription");
}

function descriptionPlaceholder(vertical: Vertical, usingMenu: boolean): string {
  const lang = getCurrentLang();
  if (vertical === "work") return translate(lang, "create.descPlaceholderWork");
  if (usingMenu) {
    if (vertical === "bill-pay") return translate(lang, "create.descPlaceholderBillsMenu");
    if (vertical === "marketplace") return translate(lang, "create.descPlaceholderStoreMenu");
    if (vertical === "lending") return translate(lang, "create.descPlaceholderLendingMenu");
    return translate(lang, "create.descPlaceholderExchangeMenu");
  }
  if (vertical === "bill-pay") return translate(lang, "create.descPlaceholderBillPay");
  if (vertical === "marketplace") return translate(lang, "create.descPlaceholderMarket");
  if (vertical === "lending") return translate(lang, "create.descPlaceholderLending");
  return translate(lang, "create.descPlaceholderExchange");
}

function descriptionRequired(vertical: Vertical, usingMenu: boolean): boolean {
  // CBP needs no free-text description in EITHER mode: the bill-type chip + amount
  // (or, for the monthly bundle, the individual bills) already say what it is, and
  // it's a no-KYC private bill pay — a name just adds friction (and a place to leak
  // private detail). A bundle "name" is meaningless here — nobody names their pile
  // of monthly bills; the bills ARE the listing. The menu auto-titles as an
  // "N-bill bundle" when the desc is empty (fallbackMenuDescription). Mirrors
  // Exchange, which already skips it.
  if (vertical === "bill-pay") return false;
  return usingMenu || vertical !== "p2p-trade";
}

function fallbackMenuDescription(vertical: Vertical, menuItems: MenuItem[]): string {
  const lang = getCurrentLang();
  if (menuItems.length === 1) return menuItems[0]?.label ?? "";
  if (vertical === "p2p-trade") return translate(lang, "create.fallbackSatsOptions", { count: menuItems.length });
  if (vertical === "bill-pay") return translate(lang, "create.fallbackBillBundle", { count: menuItems.length });
  if (vertical === "lending") return translate(lang, "create.fallbackLoanOffers", { count: menuItems.length });
  return translate(lang, "create.fallbackItemStore", { count: menuItems.length });
}

function buildListingDescription(form: FormState, vertical: Vertical, menuItems: MenuItem[]): string {
  const desc = form.desc.trim();
  if (desc) return desc;
  if (menuItems.length > 0) return fallbackMenuDescription(vertical, menuItems);
  if (vertical === "p2p-trade") return translate(getCurrentLang(), "create.fallbackSatsForSale");
  // CBP (#12): the free-text description is retired for single bills — the
  // bill-type IS the identity. Fall back to its label so the listing always has
  // a title (and the publish gate's `listingDescription.length > 0` passes).
  if (vertical === "bill-pay") return billTypeDisplay(form.billType)?.label ?? translate(getCurrentLang(), "create.fallbackBillPayment");
  return "";
}

// i18n: the review screen used to derive its copy via
// `menuPartialMessage(v).replace("review", "publishing")` — a string edit that
// breaks under translation, so the stage is now an explicit parameter.
function menuPartialMessage(vertical: Vertical, stage: "review" | "publishing" = "review"): string {
  const lang = getCurrentLang();
  const stageWord = translate(lang, stage === "publishing" ? "create.stagePublishing" : "create.stageReview");
  if (vertical === "p2p-trade") return translate(lang, "create.menuPartialExchange", { stage: stageWord });
  if (vertical === "bill-pay") return translate(lang, "create.menuPartialBillPay", { stage: stageWord });
  if (vertical === "lending") return translate(lang, "create.menuPartialLending", { stage: stageWord });
  return translate(lang, "create.menuPartialMarket", { stage: stageWord });
}

function menuCountLabel(vertical: Vertical, count: number): string {
  const lang = getCurrentLang();
  const one = count === 1;
  if (vertical === "p2p-trade") return translate(lang, one ? "create.menuCountOptionOne" : "create.menuCountOptionMany", { count });
  if (vertical === "bill-pay") return translate(lang, one ? "create.menuCountBillOne" : "create.menuCountBillMany", { count });
  if (vertical === "lending") return translate(lang, one ? "create.menuCountOfferOne" : "create.menuCountOfferMany", { count });
  return translate(lang, one ? "create.menuCountItemOne" : "create.menuCountItemMany", { count });
}

function menuFiatFloor(items: MenuItem[]): { amount: number; currency: string } | null {
  const priced = items.filter((item) => item.fiatAmount !== undefined && item.fiatCurrency);
  if (priced.length === 0) return null;
  const currencies = new Set(priced.map((item) => item.fiatCurrency));
  if (currencies.size !== 1) return null;
  const amount = Math.min(...priced.map((item) => item.fiatAmount ?? Number.POSITIVE_INFINITY));
  const currency = priced[0]?.fiatCurrency;
  return Number.isFinite(amount) && currency ? { amount, currency } : null;
}

function estimatedMenuFiatFloor({
  menuItems,
  currency,
  usdPerBtc,
  usdFiatRates,
}: {
  menuItems: MenuItem[];
  currency: string;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}): { amount: number; currency: string } | null {
  if (menuItems.length === 0) return null;
  const floorMsats = Math.min(...menuItems.map(item => item.amountMsats));
  const amount = estimateFiatForMsats({
    amountMsats: floorMsats,
    currency,
    usdPerBtc,
    usdFiatRates,
  });
  return amount === null ? null : { amount, currency };
}

function formatMenuAmount(
  item: MenuItem,
  amountDisplayMode: AmountDisplayMode,
  estimate?: {
    currency: string;
    usdPerBtc: number | null;
    usdFiatRates: Record<string, number>;
  },
) {
  if (amountDisplayMode === "fiat" && item.fiatAmount !== undefined && item.fiatCurrency) {
    return <>{formatFiatAmount(item.fiatAmount, item.fiatCurrency)}</>;
  }
  if (amountDisplayMode === "fiat" && estimate) {
    if (item.minAmountMsats !== undefined && item.maxAmountMsats !== undefined) {
      const min = estimateFiatForMsats({
        amountMsats: item.minAmountMsats,
        currency: estimate.currency,
        usdPerBtc: estimate.usdPerBtc,
        usdFiatRates: estimate.usdFiatRates,
      });
      const max = estimateFiatForMsats({
        amountMsats: item.maxAmountMsats,
        currency: estimate.currency,
        usdPerBtc: estimate.usdPerBtc,
        usdFiatRates: estimate.usdFiatRates,
      });
      if (min !== null && max !== null) {
        const minLabel = formatFiatAmount(min, estimate.currency);
        const maxLabel = formatFiatAmount(max, estimate.currency);
        return <>{minLabel === maxLabel ? minLabel : `${minLabel}-${maxLabel.replace(`${estimate.currency} `, "")}`}</>;
      }
    }
    const amount = estimateFiatForMsats({
      amountMsats: item.amountMsats,
      currency: estimate.currency,
      usdPerBtc: estimate.usdPerBtc,
      usdFiatRates: estimate.usdFiatRates,
    });
    if (amount !== null) return <>{formatFiatAmount(amount, estimate.currency)}</>;
  }
  if (item.minAmountMsats !== undefined && item.maxAmountMsats !== undefined) {
    const min = fmtSats(item.minAmountMsats);
    const max = fmtSats(item.maxAmountMsats);
    return (
      <BitcoinAmount
        label={min === max ? min : `${min}-${max}`}
        size={12}
        gap={4}
        glyphScale={1.18}
      />
    );
  }
  return <BitcoinAmount msats={item.amountMsats} size={12} gap={4} glyphScale={1.18} />;
}

function supportsPremium(vertical: Vertical): boolean {
  return vertical === "p2p-trade" || vertical === "bill-pay" || vertical === "lending";
}

function premiumLabelForVertical(vertical: Vertical): string {
  const lang = getCurrentLang();
  if (vertical === "lending") return translate(lang, "create.premiumLabelLending");
  if (vertical === "bill-pay") return translate(lang, "create.premiumLabelBillPay");
  return translate(lang, "create.premiumLabel");
}

function premiumHintForVertical(vertical: Vertical, currency: string): string {
  const lang = getCurrentLang();
  if (vertical === "lending") return translate(lang, "create.premiumHintLending");
  if (vertical === "bill-pay") return translate(lang, "create.premiumHintBillPay", { currency });
  return translate(lang, "create.premiumHint", { currency });
}

function formatPremiumPercent(premiumBps: number): string {
  const pct = premiumBps / 100;
  // 3.5.1 #3: integers must NOT pass through the trailing-zero strip below —
  // `"20".replace(/\.?0+$/, "")` is "2", which rendered a 20% premium as
  // "+2%" (the amount was right; only this label was 10× off). The strip is
  // only for trimming a fractional tail, e.g. "12.50" → "12.5".
  if (Number.isInteger(pct)) return String(pct);
  return Math.abs(pct) < 10
    ? pct.toFixed(1)
    : pct.toFixed(2).replace(/\.?0+$/, "");
}

function premiumReviewLine(form: FormState, vertical: Vertical): string | null {
  if (!supportsPremium(vertical)) return null;
  const premiumBps = parsePremiumBps(form.premium);
  if (premiumBps === undefined) return null;
  const display = formatPremiumPercent(premiumBps);
  if (vertical === "lending") return translate(getCurrentLang(), "create.premiumReviewApr", { value: display });
  const signed = premiumBps > 0 ? `+${display}` : display;
  return translate(getCurrentLang(), "create.premiumReview", { value: signed });
}

function parseFiatAmount(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fiatInputValue(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const maximumFractionDigits = amount >= 1000 ? 0 : amount >= 100 ? 1 : 2;
  return amount.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits,
  });
}

function fiatInputForSats({
  satsValue,
  currency,
  usdPerBtc,
  usdFiatRates,
}: {
  satsValue: string;
  currency: string;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}): string | null {
  const trimmed = satsValue.trim();
  if (!trimmed) return "";
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return null;
  const sats = parseWholeSats(trimmed);
  if (sats <= 0) return "";
  const amount = estimateFiatForMsats({
    amountMsats: sats * 1000,
    currency,
    usdPerBtc,
    usdFiatRates,
  });
  return amount === null ? null : fiatInputValue(amount);
}

function satsInputForFiat({
  fiatValue,
  currency,
  usdPerBtc,
  usdFiatRates,
}: {
  fiatValue: string;
  currency: string;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}): string | null {
  if (!fiatValue.trim()) return "";
  const fiatAmount = parseFiatAmount(fiatValue);
  if (fiatAmount === null) return null;
  if (fiatAmount <= 0) return "";
  const sats = estimateSatsForFiat({
    fiatAmount,
    currency,
    usdPerBtc,
    usdFiatRates,
  });
  return sats === null ? null : String(sats);
}

function premiumCheckoutLine(form: FormState, vertical: Vertical): string | null {
  const lang = getCurrentLang();
  if (vertical === "lending" || !supportsPremium(vertical)) return null;
  const premiumBps = parsePremiumBps(form.premium);
  const baseFiat = parseFiatAmount(form.fiat);
  if (vertical === "bill-pay") {
    const baseSats = parseWholeSats(form.sats);
    if (premiumBps === undefined || baseSats <= 0) return null;
    const lockSats = satsWithPremium(baseSats, premiumBps);
    const billLabel = baseFiat !== null && baseFiat > 0
      ? translate(lang, "create.billLabelWithAmount", { amount: formatFiatAmount(baseFiat, form.cur) })
      : translate(lang, "create.billLabelPlain");
    const bonusNote = premiumBps > 0
      ? translate(lang, "create.volunteerBonusNote", { percent: formatPremiumPercent(premiumBps) })
      : "";
    return translate(lang, "create.volunteerLockLine", {
      sats: fmtSats(lockSats * 1000),
      bill: billLabel,
      bonus: bonusNote,
    });
  }
  if (premiumBps === undefined || baseFiat === null || baseFiat <= 0) return null;
  const checkoutFiat = baseFiat * (1 + premiumBps / 10_000);
  if (!Number.isFinite(checkoutFiat) || checkoutFiat < 0) return null;
  const signed = premiumBps > 0 ? `+${formatPremiumPercent(premiumBps)}%` : `${formatPremiumPercent(premiumBps)}%`;
  return translate(lang, "create.premiumCheckoutEquation", {
    base: formatFiatAmount(baseFiat, form.cur),
    signed,
    total: formatFiatAmount(checkoutFiat, form.cur),
  });
}

function railCreateSearchText(rail: Rail): string {
  return [
    rail.displayName,
    rail.key.replace(/-/g, " "),
    rail.placeholder ?? "",
    ...(rail.countries ?? []),
  ].join(" ").toLowerCase();
}

function filterCreateRails(rails: Rail[], query: string): Rail[] {
  const q = query.trim().toLowerCase();
  if (!q) return rails;
  return rails.filter(rail => railCreateSearchText(rail).includes(q));
}

function uniqueRailsByKey(rails: Rail[]): Rail[] {
  const seen = new Set<string>();
  const unique: Rail[] = [];
  for (const rail of rails) {
    if (seen.has(rail.key)) continue;
    seen.add(rail.key);
    unique.push(rail);
  }
  return unique;
}

export function emptyCreateFormState(currency = "USD"): FormState {
  return {
    listingMode: "single",
    desc: "",
    imageDataUrl: "",
    imageUrls: [],
    sats: "",
    fiat: "",
    cur: currency,
    premium: "",
    fulfillment: "physical",
    isSubscription: false,
    periods: "3",
    intervalDays: "30",
    paymentMethods: [],
    menuItems: [],
    billType: "",
    workSide: "work",
    workCategory: "",
    escrowMode: DEFAULT_ESCROW_MODE,
    recurringCbp: false,
  };
}

export function CreateForm({
  onCreate, onClose,
  arbiterWarning, onGoToArbiterTrade,
  canOfferSubscription, userPubkey, activeInvite,
  amountDisplayMode,
  communitySlug,
  fetchCommunityBonds,
  fetchFaultExcludedArbiters,
  authorizeImageUpload,
}: {
  onCreate: (params: any) => void;
  onClose: () => void;
  arbiterWarning: ArbiterWarning;
  onGoToArbiterTrade: (escrowId: string) => void;
  canOfferSubscription: boolean;
  userPubkey: string | null;
  activeInvite: string | null;
  amountDisplayMode: AmountDisplayMode;
  /** Bond → arbiter enrollment (S3): fetch a community's chain-verified 38135
   *  bonds so bonded arbiters whose commitment COVERS this trade get seated in
   *  its pool (alongside the always-present OG cabinet). Optional + fail-soft —
   *  absent/throwing just leaves the OG pool, never blocks publish. */
  fetchCommunityBonds?: (community: string) => Promise<VerifiedBond[]>;
  fetchFaultExcludedArbiters?: (candidates: readonly string[]) => Promise<string[]>;
  /** NIP-98 authorization from the active Chama signer for the photo host. */
  authorizeImageUpload?: ListingImageUploadAuthorizer;
  /** v2.1.1: the community the shell is currently presenting as the
   *  user's identity (the header/Browse pill). Create stamps THIS, so
   *  what the user sees is what they publish. Previously this read the
   *  persisted sign-in home directly, which only ConnectScreen ever
   *  writes — a user whose header said "South Africa · ZAR" could
   *  silently publish Tanzania·TZS listings with the Tanzania arbiter
   *  pool because their stored home was stale (the 06-05 field find).
   *  Optional: falls back to the stored home for any callsite that
   *  doesn't thread it. */
  communitySlug?: string | null;
}) {
  const { t } = useT();
  // Resolve community context for the listing. Read once at mount;
  // listing publishes into the community the user currently SEES as
  // theirs (Pillar 2.3 "current community" = the header identity, per
  // the v2.1.1 ruling), falling back to the persisted sign-in home.
  const community = (() => {
    if (communitySlug && getCommunityBySlug(communitySlug)) return communitySlug;
    const slug = getUserCommunitySlug();
    return getCommunityBySlug(slug) ? slug : DEFAULT_COMMUNITY_SLUG;
  })();
  const homeCommunity = getCommunityBySlug(community);
  const communityCurrency = defaultCurrencyForCommunity(community);
  // v2.2.0: the listing community now follows the header identity, but
  // the PERSISTED home (what boot-routing uses at sign-in) is only ever
  // written on the sign-in screen — so it can silently go stale (the
  // tz-tzs field find). Surface the mismatch right here and let one tap
  // make the displayed community the persisted home.
  const [persistedHome, setPersistedHome] = useState<string | null>(
    () => getUserCommunitySlugRaw(),
  );
  // Only nag when the persisted home genuinely differs from where you are —
  // NOT when it's simply unset yet, and NOT for a co-labeled sibling fed of the
  // same place (e.g. ke-kes "Kenya · KES" vs ke-kes-bitsacco "Kenya · KES").
  // A raw string compare wrongly flagged those as "not home" even though Me and
  // the FX pill read identically. The nag stays for a true cross-country /
  // cross-currency stale home (the tz-tzs repair case it was built for).
  const persistedHomeCommunity = persistedHome ? getCommunityBySlug(persistedHome) : null;
  const currentCommunity = getCommunityBySlug(community);
  const sameCommunityIdentity = !!persistedHomeCommunity && !!currentCommunity
    && persistedHomeCommunity.displayName === currentCommunity.displayName
    && persistedHomeCommunity.currency === currentCommunity.currency;
  const isHomeCommunity = !persistedHome || persistedHome === community || sameCommunityIdentity;
  const setAsHome = () => {
    try { setUserCommunitySlug(community); } catch {}
    setPersistedHome(community);
  };
  const [step, setStep] = useState<Step>(1);
  const [vertical, setVertical] = useState<Vertical>("p2p-trade");
  const [form, setForm] = useState<FormState>(() =>
    emptyCreateFormState(communityCurrency),
  );
  const [submitting, setSubmitting] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [arbiterDismissed, setArbiterDismissed] = useState(false);
  const [drafts, setDrafts] = useState<SavedDraft[]>(() => readAllDrafts());
  const [showAllDrafts, setShowAllDrafts] = useState(false);
  // v3.1 stage 5: listing-mode setter lifted to the parent so the "every seller is
  // a Store" segmented toggle can live in Step 1 (under the category pick). Same
  // behaviour as before — a menu/store seeds a draft item + turns subscription off.
  const setListingMode = (listingMode: ListingMode) => {
    setForm(prev => {
      const nextItems = listingMode === "menu" && prev.menuItems.length === 0
        ? [{ ...newMenuDraftItem(), fulfillment: prev.fulfillment }]
        : prev.menuItems;
      return {
        ...prev,
        listingMode,
        imageDataUrl: listingMode === "menu" ? (prev.imageUrls[0] ?? prev.imageDataUrl) : prev.imageDataUrl,
        imageUrls: listingMode === "menu" ? prev.imageUrls.slice(0, 1) : prev.imageUrls,
        isSubscription: listingMode === "menu" ? false : prev.isSubscription,
        menuItems: nextItems,
      };
    });
  };

  useEffect(() => {
    setForm(prev => prev.cur === communityCurrency ? prev : { ...prev, cur: communityCurrency });
  }, [communityCurrency]);

  // Store permanence (#49) Tier 3: gate this listing's TENURE on the seller's
  // bond — the exact chain-verified check (funded+active 38135 ≥ floor) already
  // used for arbiter seating. Bonded ⇒ the store AUTO-RENEWS while the seller
  // is online (a 7-day rolling storefront license); unbonded ⇒ the 24h default
  // with manual renew only. Pure display gate: it never changes the published
  // expiry (renewal keeps the short trade timeout — permanence via renewal, not
  // longer locks). Fail-soft: any fetch hiccup leaves the unbonded posture.
  const [storeBonded, setStoreBonded] = useState(false);
  useEffect(() => {
    if (!fetchCommunityBonds || !userPubkey) { setStoreBonded(false); return; }
    let cancelled = false;
    void (async () => {
      try {
        const bonds = await fetchCommunityBonds(community);
        if (!cancelled) setStoreBonded(sellerIsBonded(bonds, userPubkey));
      } catch { if (!cancelled) setStoreBonded(false); }
    })();
    return () => { cancelled = true; };
  }, [community, userPubkey]);
  const storeTenure = resolveListingTenure({ bonded: storeBonded });

  // Auto-save draft on field change (silent, debounced via the form
  // state's natural batching). Cleared on successful publish.
  useEffect(() => {
    // Don't save empty drafts.
    if (!hasDraftContent(form)) return;
    writeDraft({ vertical, formState: form, savedAt: Date.now() });
    setDrafts(readAllDrafts());
  }, [form, vertical]);

  const continueDraft = (draft: SavedDraft) => {
    setVertical(draft.vertical);
    setForm(normalizeFormState(draft.formState, communityCurrency));
    setStep(2);
  };

  const handlePublish = async () => {
    setPublishError(null);
    let menuItems = normalizeMenuItems(form, vertical);
    const hasMenu = menuItems.length > 0;
    const description = buildListingDescription(form, vertical, menuItems);
    const baseSats = hasMenu ? minimumMenuSats(menuItems) : parseWholeSats(form.sats);
    const totalSats = effectiveListingSats(form, vertical);
    if (
      (!description && descriptionRequired(vertical, hasMenu)) ||
      (!hasMenu && !form.sats.trim()) ||
      hasPartialMenuRows(form, vertical) ||
      hasLendingAmountAboveCurrentCap(form, vertical)
    ) return;
    if (
      !isSimModeOn() &&
      !isTestnetMode() &&
      totalSats < MIN_REAL_ATOMIC_FUNDING_SATS
    ) return;
    setSubmitting(true);
    try {
      // Old drafts may still contain inline data URLs. Upload them before CREATE
      // so the Nostr event stays small enough for normal relay frame limits.
      let listingImageRefs = form.imageUrls.length
        ? [...form.imageUrls]
        : form.imageDataUrl ? [form.imageDataUrl] : [];
      if ((vertical === "marketplace" || vertical === "work") && listingImageRefs.length) {
        listingImageRefs = await uploadImageRefsSequentially(
          listingImageRefs,
          index => `chama-listing-${index + 1}.jpg`,
          authorizeImageUpload,
        );
        setForm(previous => ({ ...previous, imageDataUrl: listingImageRefs[0] ?? "", imageUrls: listingImageRefs }));
      }
      if (vertical === "marketplace" && hasMenu) {
        for (let index = 0; index < menuItems.length; index += 1) {
          const item = menuItems[index];
          const refs = item.imageUrls?.length ? item.imageUrls : item.imageDataUrl ? [item.imageDataUrl] : [];
          const uploaded = await uploadImageRefsSequentially(
            refs,
            imageIndex => `chama-item-${index + 1}-${imageIndex + 1}.jpg`,
            authorizeImageUpload,
          );
          if (uploaded.length === 0) continue;
          const imageUrl = uploaded[0];
          menuItems = menuItems.map(candidate => candidate.id === item.id
            ? { ...candidate, imageDataUrl: imageUrl, imageUrls: uploaded }
            : candidate);
          setForm(previous => ({
            ...previous,
            menuItems: previous.menuItems.map(candidate => candidate.id === item.id
              ? { ...candidate, imageDataUrl: imageUrl, imageUrls: uploaded }
              : candidate),
          }));
        }
      }

      const singleLockSats = !hasMenu && vertical === "bill-pay"
        ? satsWithPremium(baseSats, parsePremiumBps(form.premium))
        : baseSats;
      const periodAmountMsats = singleLockSats * 1000;
      const amountMsats = hasMenu
        ? baseSats * 1000
        : form.isSubscription
          ? parseWholeSats(form.periods) * periodAmountMsats
          : periodAmountMsats;
      // #103: stamp the community LABEL honest with the fed this listing is
      // actually minted on. browseCommunity (the header pill) can drift from
      // the wallet's loaded fed during a foreign-listing visit; if it has,
      // re-resolve to the community backing the active fed so the Browse chip
      // and the off-route amber tint (which keys off the real fed) can never
      // disagree. No drift → browseCommunity is kept untouched.
      const effectiveCommunity =
        activeInvite && getCommunityBySlug(community)?.federationInvite !== activeInvite
          ? (communityForInvite(activeInvite)?.slug ?? community)
          : community;
      const mintUrl = resolveCreateMintUrl({ activeInvite, community: effectiveCommunity });
      // Bond → arbiter enrollment (S3): fold in chain-verified bonded arbiters
      // whose commitment COVERS this trade (per-trade cap; the OG cabinet stays
      // the always-present, unbounded fallback for anything above their bond).
      // Fail-soft — any fetch/verify hiccup just yields the OG pool.
      let bondedPool: string[] = [];
      /** ⭐ Tier 2.1: arbiters whose ESCROW KEY is knowable to everyone.
       *
       *  An on-chain escrow address is built from all three keys. Buyer and
       *  seller publish theirs (CREATE / JOIN), but the arbiter is seated
       *  DETERMINISTICALLY and never joins — so their key can only come from
       *  their bond announcement, which carries a chain-verified `ownerXonly`.
       *  An arbiter without one can never supply a key, and a trade seated on
       *  them can never be funded: a permanent deadlock that reads on screen as
       *  "waiting for the arbiter" forever.
       *
       *  Hence: an on-chain escrow requires a BONDED arbiter. Consistent with
       *  the bond's role everywhere else as the licence to arbitrate, and a
       *  reasonable bar at these sizes. */
      let onchainCapableArbiters: string[] = [];
      if (fetchCommunityBonds) {
        try {
          const bonds = (await fetchCommunityBonds(effectiveCommunity)).filter(b => b.funded && b.active);
          bondedPool = assignableBondedArbiters({ bonds, tradeMsats: amountMsats, allTrades: [] });
          const keyed = new Set(
            bonds.filter((b) => !!b.ownerXonly).map((b) => b.npub.toLowerCase()),
          );
          onchainCapableArbiters = bondedPool.filter((pk) => keyed.has(pk.toLowerCase()));
        } catch { /* leave bondedPool empty — OG pool carries it */ }
      }
      // Fault-attested arbiters (kind 38136) lose the seat — but only as a
      // PREFERENCE. getTrustedArbiterPool drops the soft exclusion entirely if
      // honouring it would leave nobody assignable, so an attestation can
      // never strand a trade. Fail-open: a fetch hiccup excludes nobody.
      const poolBeforeFaults = getTrustedArbiterPool({
        community: effectiveCommunity,
        excludePubkeys: [userPubkey],
        bondedPool,
      });
      let faultExcluded: string[] = [];
      if (ARBITER_FAULT_READS_ENABLED && fetchFaultExcludedArbiters && poolBeforeFaults.length > 0) {
        try {
          faultExcluded = await fetchFaultExcludedArbiters(poolBeforeFaults);
        } catch { /* leave empty — never invent an exclusion */ }
      }
      const openPool = getTrustedArbiterPool({
        community: effectiveCommunity,
        excludePubkeys: [userPubkey],
        bondedPool,
        softExcludePubkeys: faultExcluded,
      });
      // ⭐ On-chain narrows the pool to arbiters who can actually supply a key.
      // The OG cabinet is deliberately NOT folded in here: it is the unbounded
      // fallback for ecash, but an OG with no bond announcement has no escrow
      // key, and seating one would publish a listing nobody can ever fund.
      const wantsOnchain = (form.escrowMode ?? DEFAULT_ESCROW_MODE) === "onchain";
      const communityArbiters = wantsOnchain ? onchainCapableArbiters : openPool;
      // Refuse rather than publish a dead listing. The seller finds out here,
      // in one sentence, instead of after a buyer has reserved it.
      if (wantsOnchain && communityArbiters.length === 0) {
        setPublishError(t("onchain.noCapableArbiter"));
        setSubmitting(false);
        return;
      }
      // Only DIVISIBLE value can be tranched. A single physical item cannot
      // be delivered in quarters, so Stores are excluded — the honest answer
      // there is holding the value somewhere no single party can reach.
      const params: any = {
        description,
        amountMsats,
        fiatAmount: vertical !== "work" && !hasMenu && form.fiat ? parseFloat(form.fiat) : undefined,
        fiatCurrency: vertical !== "work" && !hasMenu && form.fiat ? form.cur : undefined,
        // v1.2.2 premium-display fix: when the seller leaves the
        // premium field blank on an Exchange / bill-pay listing,
        // persist an explicit 0 so the listing reads "0% premium"
        // instead of falling through to listing-metrics' implied-spot
        // calculation (which displays a moving "-X% premium" anchored
        // off the listed fiat amount vs current BTC spot, and reads
        // like a seller-chosen discount). Lending verticals stay on
        // undefined because they encode APR via the menu's aprBps and
        // we don't want to override that with a flat zero.
        premiumBps: (() => {
          const parsed = parsePremiumBps(form.premium);
          if (parsed !== undefined) return parsed;
          if (vertical === "p2p-trade" || vertical === "bill-pay") return 0;
          return undefined;
        })(),
        // Work deliberately keeps marketplace money semantics: the client is
        // BUYER/funder and the offer author is SELLER/worker. listingKind gives
        // it its own public identity without forking the escrow reducer.
        category: vertical === "work" ? "marketplace" : vertical,
        listingKind: vertical === "work" ? (form.workSide ?? "work") : undefined,
        imageDataUrl: vertical === "marketplace" || vertical === "work" ? listingImageRefs[0] : undefined,
        imageUrls: vertical === "marketplace" || vertical === "work" ? listingImageRefs : undefined,
        community: effectiveCommunity,
        // v3.1 (B3): stamp the community's ISO country so the listing self-describes
        // its flag + currency on devices that don't know this (custom) community.
        country: getCommunityBySlug(effectiveCommunity)?.country ?? undefined,
        // v4.1 (#12): CBP bill type (single listing) — informational metadata only.
        billType: vertical === "bill-pay" && form.billType ? form.billType : undefined,
        workCategory: vertical === "work" && form.workCategory ? form.workCategory : undefined,
        // Tier 2.1: stamp the substrate at CREATE so every client knows which
        // shape of LOCK to expect BEFORE anyone funds anything.
        ...((form.escrowMode ?? DEFAULT_ESCROW_MODE) === "onchain" ? { escrowMode: "onchain" as const } : {}),
        fulfillment: vertical === "work" ? "service" : vertical === "marketplace" ? form.fulfillment : undefined,
        mintUrl,
        communityArbiters: communityArbiters.length > 0 ? communityArbiters : undefined,
        // 2B prefer-bonded: stamp the funded bonded subset (∩ the final pool) into
        // CREATE so every client replays the SAME preferred seat (the reducer
        // can't fetch bonds). bondedPool is already capacity-fitting for this trade
        // (assignableBondedArbiters above); pickPreferredArbiter re-intersects with
        // the pool so this is belt-and-suspenders. Empty ⇒ undefined ⇒ legacy pick.
        bondedArbiters: (() => {
          if (bondedPool.length === 0 || communityArbiters.length === 0) return undefined;
          const poolSet = new Set(communityArbiters.map((pk: string) => pk.toLowerCase()));
          const stamped = bondedPool.filter((pk) => poolSet.has(pk.toLowerCase()));
          return stamped.length > 0 ? stamped : undefined;
        })(),
        // Marketplace is sats-only — never carry payment rails on it.
        paymentMethods: categoryUsesPaymentRails(vertical) && form.paymentMethods.length > 0 ? form.paymentMethods : undefined,
        items: hasMenu ? menuItems : undefined,
        // #7 multi-unit storefront: only a single-product marketplace listing
        // carries stock. >=2 makes it a parent buyers purchase via child
        // escrows; 1 / blank stays a legacy single-unit listing (undefined).
        stock: (() => {
          if (vertical !== "marketplace" || hasMenu) return undefined;
          const n = parseOptionalPositiveInt(form.stock ?? "");
          return n !== undefined && n >= 2 ? n : undefined;
        })(),
      };
      if (!hasMenu && form.isSubscription) {
        params.subscription = {
          totalPeriods: parseWholeSats(form.periods),
          periodAmountMsats,
          periodDurationSeconds: parseWholeSats(form.intervalDays) * 86400,
        };
      }
      // Monthly CBP: a CLIENT-ONLY recurrence intent (bill-pay only). App strips
      // it before createEscrow — it's NOT a consensus field — and registers the
      // recurring series locally on a successful publish.
      if (vertical === "bill-pay" && form.recurringCbp) {
        params.recurringCbp = true;
      }
      await onCreate(params);
      // Successful publish — clear this vertical's draft + mark
      // first-publish so the honesty card never re-shows.
      clearDraft(vertical);
      markFirstPublished(userPubkey);
      onClose();
    } catch (error: any) {
      setPublishError(error?.message || "Couldn't publish this listing. Your draft is still here.");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render: arbiter warning intercepts before the wizard renders ──
  if (arbiterWarning.kind !== "none" && !arbiterDismissed) {
    return (
      <ArbiterWarningCard
        warning={arbiterWarning}
        onContinue={() => setArbiterDismissed(true)}
        onCancel={onClose}
        onGoToArbiterTrade={onGoToArbiterTrade}
      />
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 14,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
          {t("create.newListing")}
        </span>
        <button onClick={onClose} style={{
          background: "none", border: "none", color: T.muted,
          fontSize: 20, cursor: "pointer",
        }}>×</button>
      </div>

      <StepProgress currentStep={step} />

      {step === 1 && (
        <Step1
          vertical={vertical}
          setVertical={setVertical}
          listingMode={form.listingMode}
          setListingMode={setListingMode}
          homeCommunity={homeCommunity}
          isHomeCommunity={isHomeCommunity}
          onSetHome={setAsHome}
          drafts={drafts}
          showAllDrafts={showAllDrafts}
          setShowAllDrafts={setShowAllDrafts}
          onContinueDraft={continueDraft}
          onNext={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <Step2
          vertical={vertical}
          form={form}
          setForm={setForm}
          homeCommunity={homeCommunity}
          canOfferSubscription={canOfferSubscription}
          amountDisplayMode={amountDisplayMode}
          authorizeImageUpload={authorizeImageUpload}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && vertical === "marketplace" && (
        <div style={{
          margin: "12px 16px 0",
          padding: "10px 12px",
          background: T.purpleDim,
          border: `1px solid ${T.purple}55`,
          borderRadius: T.r,
          fontFamily: T.sans, fontSize: 12, color: T.muted,
        }}>
          <span style={{ color: T.purple, fontWeight: 700 }}>
            {storeTenure.bonded ? t("create.tenureBondedTitle") : t("create.tenureUnbondedTitle")}
          </span>
          {" — "}
          {storeTenure.bonded ? t("create.tenureBondedBody") : t("create.tenureUnbondedBody")}
        </div>
      )}
      {step === 3 && (
        <>
        {publishError && (
          <div style={{ margin: "0 0 12px", padding: "10px 12px", borderRadius: T.rs, background: T.redDim, border: `1px solid ${T.red}55`, color: T.red, fontFamily: T.mono, fontSize: 11, lineHeight: 1.5 }}>
            ⚠ {publishError}
          </div>
        )}
        <Step3
          vertical={vertical}
          form={form}
          setForm={setForm}
          homeCommunity={homeCommunity}
          firstPublishDone={hasFirstPublishedBefore(userPubkey)}
          submitting={submitting}
          amountDisplayMode={amountDisplayMode}
          onBack={() => setStep(2)}
          onPublish={handlePublish}
          onSaveDraft={() => {
            writeDraft({ vertical, formState: form, savedAt: Date.now() });
            setDrafts(readAllDrafts());
            onClose();
          }}
        />
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Step progress indicator
// ══════════════════════════════════════════════════════════════════════════

function StepProgress({ currentStep }: { currentStep: Step }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      marginBottom: 20,
    }}>
      {[1, 2, 3].map((n) => {
        const active = n === currentStep;
        const done = n < currentStep;
        return (
          <div key={n} style={{ display: "flex", alignItems: "center", flex: 1, gap: 6 }}>
            <div style={{
              width: 22, height: 22, borderRadius: "50%",
              background: active ? T.accent : done ? T.green : T.surface,
              border: `1px solid ${active ? T.accent : done ? T.green : T.border}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              color: active || done ? T.bg : T.muted,
              flexShrink: 0,
            }}>
              {done ? "✓" : n}
            </div>
            {n < 3 && (
              <div style={{
                flex: 1, height: 1,
                background: done ? T.green : T.border,
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Arbiter warning card (item 10)
// ══════════════════════════════════════════════════════════════════════════

function ArbiterWarningCard({
  warning,
  onContinue,
  onCancel,
  onGoToArbiterTrade,
}: {
  warning: ArbiterWarning;
  onContinue: () => void;
  onCancel: () => void;
  onGoToArbiterTrade: (escrowId: string) => void;
}) {
  const { t } = useT();
  if (warning.kind === "none") return null;
  const isHard = warning.kind === "hard";
  const counterpartyA = displayCounterpartyName({
    npub: warning.counterpartyA,
    fetchKind0Enabled: false,
    kind0Name: null,
  });
  const counterpartyB = displayCounterpartyName({
    npub: warning.counterpartyB,
    fetchKind0Enabled: false,
    kind0Name: null,
  });

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <div style={{
        background: isHard ? T.redDim : T.amberDim,
        border: `1px solid ${isHard ? T.red + "66" : T.amber + "66"}`,
        borderRadius: T.r, padding: 20,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>
          {isHard ? "⚠️" : "⚖️"}
        </div>
        <div style={{
          fontSize: 11, fontWeight: 700, color: isHard ? T.red : T.amber,
          fontFamily: T.mono, letterSpacing: 1.5, textTransform: "uppercase",
          marginBottom: 12,
        }}>
          {isHard ? t("create.warnHardTitle") : t("create.warnSoftTitle")}
        </div>
        {isHard ? (
          <>
            <div style={{
              fontSize: 14, fontWeight: 700, color: T.text, fontFamily: T.sans,
              lineHeight: 1.4, marginBottom: 12,
            }}>
              {t("create.warnHardHeadline")}
            </div>
            {/* v0.3.0 Phase 6 (item 8): tightened from 4 sentences to
                3, dropping the "Your decision determines where their
                sats go" filler and shortening "splitting attention here
                can cost someone real money" → "could cost someone their
                sats". Same urgency, less verbiage. */}
            <div style={{
              fontSize: 13, color: T.text, fontFamily: T.sans,
              lineHeight: 1.55, marginBottom: 20,
            }}>
              <strong>{counterpartyA}</strong>{t("create.warnAnd")}<strong>{counterpartyB}</strong>{" "}
              {t("create.warnHardBody")}
            </div>
          </>
        ) : (
          <>
            <div style={{
              fontSize: 14, fontWeight: 700, color: T.text, fontFamily: T.sans,
              lineHeight: 1.4, marginBottom: 12,
            }}>
              {t("create.warnSoftHeadline")}
            </div>
            <div style={{
              fontSize: 13, color: T.text, fontFamily: T.sans,
              lineHeight: 1.55, marginBottom: 20,
            }}>
              <strong>{counterpartyA}</strong>{t("create.warnAnd")}<strong>{counterpartyB}</strong>{" "}
              {t("create.warnSoftBody")}
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 8, flexDirection: "column" }}>
          {isHard ? (
            <>
              <button
                onClick={() => onGoToArbiterTrade(warning.escrowId)}
                style={primaryButtonStyle(T.accent)}
              >
                {t("create.goToArbitrationTrade")}
              </button>
              <button
                onClick={onContinue}
                style={mutedSecondaryButtonStyle()}
              >
                {t("create.continueAnyway")}
              </button>
            </>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onCancel} style={equalButtonStyle()}>
                {t("common.cancel")}
              </button>
              <button onClick={onContinue} style={equalButtonStyle()}>
                {t("create.continueAnyway")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function primaryButtonStyle(color: string): React.CSSProperties {
  return {
    width: "100%", padding: "12px",
    background: color, border: "none", borderRadius: T.rs,
    color: T.bg, fontFamily: T.mono, fontSize: 13, fontWeight: 800,
    cursor: "pointer", letterSpacing: 0.3,
  };
}
function mutedSecondaryButtonStyle(): React.CSSProperties {
  return {
    width: "100%", padding: "12px",
    background: "transparent", border: `1px solid ${T.border}`, borderRadius: T.rs,
    color: T.muted, fontFamily: T.mono, fontSize: 12, fontWeight: 600,
    cursor: "pointer",
  };
}
function equalButtonStyle(): React.CSSProperties {
  return {
    flex: 1, padding: "12px",
    background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
    color: T.text, fontFamily: T.mono, fontSize: 12, fontWeight: 700,
    cursor: "pointer",
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Step 1 — Category + community + drafts
// ══════════════════════════════════════════════════════════════════════════

function Step1({
  vertical, setVertical,
  listingMode, setListingMode,
  homeCommunity,
  isHomeCommunity,
  onSetHome,
  drafts, showAllDrafts, setShowAllDrafts,
  onContinueDraft,
  onNext,
}: {
  vertical: Vertical;
  setVertical: (v: Vertical) => void;
  listingMode: ListingMode;
  setListingMode: (m: ListingMode) => void;
  homeCommunity: ReturnType<typeof getCommunityBySlug>;
  /** v2.2.0: whether the listing community matches the PERSISTED home
   *  (the sign-in boot-routing anchor). When false, the caption becomes
   *  a one-tap "Set as home" affordance — fixing a stale home at the
   *  exact moment the user can see the mismatch. */
  isHomeCommunity: boolean;
  onSetHome: () => void;
  drafts: SavedDraft[];
  showAllDrafts: boolean;
  setShowAllDrafts: (b: boolean) => void;
  onContinueDraft: (d: SavedDraft) => void;
  onNext: () => void;
}) {
  const { t } = useT();
  const visibleDrafts = showAllDrafts ? drafts : drafts.slice(0, 3);
  const hiddenDraftCount = Math.max(0, drafts.length - 3);

  return (
    <>
      {/* Save-draft cards (visible when any drafts exist) */}
      {drafts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{
            fontSize: 11, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            {t("create.continueADraft")}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleDrafts.map(d => {
              const v = VERTICALS.find(vert => vert.id === d.vertical)!;
              const ageMs = Date.now() - d.savedAt;
              const ageMin = Math.floor(ageMs / 60_000);
              const ageStr = ageMin < 1 ? t("create.ageJustNow")
                : ageMin < 60 ? t("create.ageMinutes", { count: ageMin })
                : ageMin < 1440 ? t("create.ageHours", { count: Math.floor(ageMin / 60) })
                : t("create.ageDays", { count: Math.floor(ageMin / 1440) });
              return (
                <button
                  key={d.vertical}
                  onClick={() => onContinueDraft(d)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "10px 12px",
                    background: T.surface, border: `1px solid ${T.border}`,
                    borderRadius: T.rs, cursor: "pointer",
                    textAlign: "left" as const,
                    color: T.text, fontFamily: T.sans,
                  }}
                >
                  <span style={{ fontSize: 18 }}>{v.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {t("create.continueDraftTitle", { vertical: t(v.labelKey) })}
                    </div>
                    <div style={{
                      fontSize: 10, color: T.muted, fontFamily: T.mono,
                      marginTop: 2,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                    }}>
                      {d.formState.desc || t("create.noDescriptionYet")} · {ageStr}
                    </div>
                  </div>
                  <span style={{ color: T.muted, fontSize: 16 }}>›</span>
                </button>
              );
            })}
            {!showAllDrafts && hiddenDraftCount > 0 && (
              <button
                onClick={() => setShowAllDrafts(true)}
                style={{
                  background: "none", border: "none",
                  color: T.muted, fontFamily: T.mono, fontSize: 11,
                  cursor: "pointer", padding: "8px",
                }}
              >
                {t(
                  hiddenDraftCount === 1 ? "create.showMoreDraftsOne" : "create.showMoreDraftsMany",
                  { count: hiddenDraftCount },
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Category cards */}
      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        letterSpacing: 1, marginBottom: 8,
      }}>
        {t("create.whatKindOfTrade")}
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10,
        marginBottom: 20,
      }}>
        {VERTICALS.map(v => {
          const active = vertical === v.id;
          const soon = !!v.comingSoon;
          return (
            <button
              key={v.id}
              type="button"
              disabled={soon}
              onClick={() => {
                if (soon) return;
                const next = v.id as Vertical;
                setVertical(next);
                if (next === "work") setListingMode("single");
              }}
              style={{
                display: "flex", flexDirection: "column", alignItems: "flex-start",
                gap: 6, padding: "16px 14px",
                background: active ? T.accentDim : T.surface,
                border: `1px solid ${active ? T.accent + "66" : T.border}`,
                borderRadius: T.r, cursor: soon ? "not-allowed" : "pointer",
                textAlign: "left" as const, transition: "all 0.15s",
                opacity: soon ? 0.6 : 1,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 7, width: "100%" }}>
                <span style={{ fontSize: 22 }}>{v.icon}</span>
                {soon && (
                  <span style={{
                    marginLeft: "auto", fontSize: 8, fontWeight: 800, letterSpacing: 0.5,
                    color: T.amber, background: `${T.amber}22`,
                    padding: "1px 5px", borderRadius: 999,
                  }}>{t("create.soonPill")}</span>
                )}
              </span>
              <span style={{
                fontSize: 13, fontWeight: 700, color: active ? T.accent : T.text,
                fontFamily: T.sans,
              }}>
                {t(v.labelKey)}
              </span>
              <span style={{
                fontSize: 10, color: T.muted, fontFamily: T.sans,
                lineHeight: 1.4,
              }}>
                {t(v.descriptionKey)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Stage 5 — "every seller is a Store": one light sub-step under the type
          pick. A sliding segmented control between a single listing and the
          vertical's multi/store mode, driving the same listingMode state. */}
      {vertical !== "work" && <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 8 }}>
          {t("create.listingStyle")}
        </div>
        <div style={{
          position: "relative", display: "grid", gridTemplateColumns: "1fr 1fr",
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 999, padding: 4,
        }}>
          <div aria-hidden="true" style={{
            position: "absolute", top: 4, bottom: 4, left: 4,
            width: "calc(50% - 4px)", borderRadius: 999,
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            transform: listingMode === "menu" ? "translateX(100%)" : "translateX(0)",
            transition: "transform .22s cubic-bezier(.4,0,.2,1)",
          }} />
          {([["single", singleModeLabel(vertical)], ["menu", menuModeLabel(vertical)]] as [ListingMode, string][]).map(([mode, label]) => {
            const disabled = false;
            const active = listingMode === mode && !disabled;
            return (
              <button
                key={mode}
                type="button"
                disabled={disabled}
                onClick={() => { if (!disabled) setListingMode(mode); }}
                style={{
                  position: "relative", zIndex: 1,
                  background: "transparent", border: "none",
                  padding: "9px 10px", borderRadius: 999,
                  cursor: disabled ? "not-allowed" : "pointer",
                  fontFamily: T.mono, fontSize: 12, fontWeight: 800,
                  color: disabled ? T.muted : active ? T.accent : T.muted,
                  transition: "color .2s",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}
              >
                {label}
                {disabled && (
                  <span style={{
                    fontSize: 8, fontWeight: 800, letterSpacing: 0.5,
                    color: T.amber, background: `${T.amber}22`,
                    padding: "1px 5px", borderRadius: 999,
                  }}>{t("create.soonPill")}</span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.sans, lineHeight: 1.4, marginTop: 7 }}>
          {listingMode === "menu"
            ? menuModeDescription(vertical)
            : singleModeDescription(vertical)}
        </div>
      </div>}

      {/* Community context. v2.2.0: the line reflects the header
          identity (what you see is what you publish). When that differs
          from the persisted home — the sign-in boot-routing anchor that
          only the sign-in screen used to be able to change — the caption
          becomes a one-tap "Set as home" so a stale home is fixable at
          the exact moment the mismatch is visible. */}
      {/* v5: this block used to always show "Listing in <your community>",
          which is pure redundancy when you're creating in your OWN home (you
          land in Browse, the header already names it, and you'd never
          deliberately list elsewhere). Reclaim that real estate: render ONLY on
          the drift case — you've navigated into a community that isn't your
          persisted home — where it both warns you AND one-taps to fix a stale
          home. Home never changes silently; it's only set on sign-in or here. */}
      {!isHomeCommunity && (
        <div style={{
          padding: "10px 12px", marginBottom: 24,
          background: T.surface, border: `1px solid ${T.amber}55`,
          borderRadius: T.rs,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>
              {homeCommunity?.flagEmoji ?? "🌐"}
            </span>
            <span style={{ flex: 1, fontSize: 12, color: T.text, fontFamily: T.sans }}>
              {t("create.listingInBefore")}<strong>{homeCommunity?.displayName ?? t("create.yourCommunityFallback")}</strong>
              {t("create.listingInAfter")}
            </span>
            <button
              onClick={onSetHome}
              style={{
                background: T.accentDim, border: `1px solid ${T.accent}66`,
                borderRadius: T.rs, padding: "4px 8px", cursor: "pointer",
                color: T.accent, fontFamily: T.mono, fontSize: 10,
                fontWeight: 800, letterSpacing: 0.5, flexShrink: 0,
              }}
            >
              {t("create.setAsHome")}
            </button>
          </div>
          <div style={{
            marginTop: 6, fontSize: 10, color: T.muted,
            fontFamily: T.sans, lineHeight: 1.4,
          }}>
            {t("create.homeExplains", {
              name: homeCommunity?.displayName ?? t("create.thisCommunityFallback"),
            })}
          </div>
        </div>
      )}

      <button onClick={onNext} style={{
        width: "100%", padding: "14px",
        background: T.accent, border: "none", borderRadius: T.rs,
        color: T.bg, fontFamily: T.mono, fontSize: 14, fontWeight: 800,
        cursor: "pointer", letterSpacing: 0.5,
      }}>
        {t("create.nextButton")}
      </button>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Step 2 — Vertical-specific form
// ══════════════════════════════════════════════════════════════════════════

function Step2({
  vertical, form, setForm,
  homeCommunity,
  canOfferSubscription,
  amountDisplayMode,
  authorizeImageUpload,
  onBack, onNext,
}: {
  vertical: Vertical;
  form: FormState;
  setForm: (updater: (f: FormState) => FormState) => void;
  homeCommunity: ReturnType<typeof getCommunityBySlug>;
  canOfferSubscription: boolean;
  amountDisplayMode: AmountDisplayMode;
  authorizeImageUpload?: ListingImageUploadAuthorizer;
  onBack: () => void;
  onNext: () => void;
}) {
  const { t } = useT();
  const btcPrice = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const [paymentRailQuery, setPaymentRailQuery] = useState("");
  // v2.5: inline photo-upload error. window.alert is a silent no-op in the
  // Tauri/Capacitor webview, so a rejected image used to fail invisibly.
  const [imageError, setImageError] = useState<string | null>(null);
  const [uploadingImageIds, setUploadingImageIds] = useState<Set<string>>(() => new Set());
  const menuItems = normalizeMenuItems(form, vertical);
  const hasMenu = menuItems.length > 0;
  const usingMenu = form.listingMode === "menu";
  const partialMenuRows = hasPartialMenuRows(form, vertical);
  const totalSats = effectiveListingSats(form, vertical);
  const amountTooSmall =
    !isSimModeOn() &&
    !isTestnetMode() &&
    totalSats > 0 &&
    totalSats < MIN_REAL_ATOMIC_FUNDING_SATS;
  const lendingCapExceeded = hasLendingAmountAboveCurrentCap(form, vertical);
  const showSubscriptionMode = false && canOfferSubscription;
  const descriptionOk = !descriptionRequired(vertical, usingMenu) || form.desc.trim().length > 0 || hasMenu;
  // CBP single listings now REQUIRE a bill-type — it's the listing identity since
  // the free-text description was retired, so no publishing a bare fallback title.
  const billTypeOk = vertical !== "bill-pay" || usingMenu || !!form.billType;
  // A4: a Work listing without a category can only match on the weak signals.
  const workCategoryOk = vertical !== "work" || usingMenu || !!form.workCategory;
  const ready =
    descriptionOk &&
    billTypeOk &&
    workCategoryOk &&
    (usingMenu ? hasMenu : form.sats.trim().length > 0) &&
    !partialMenuRows &&
    uploadingImageIds.size === 0 &&
    !amountTooSmall &&
    !lendingCapExceeded;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));
  const setStoreFulfillment = (fulfillment: Fulfillment) => {
    setForm(prev => ({
      ...prev,
      fulfillment,
      menuItems: prev.menuItems.map(item => ({ ...item, fulfillment })),
    }));
  };
  const syncSingleSats = (value: string) => {
    setForm(prev => {
      const next: FormState = { ...prev, sats: value };
      if (vertical !== "lending") {
        const fiat = fiatInputForSats({
          satsValue: value,
          currency: prev.cur,
          usdPerBtc: btcPrice.usd,
          usdFiatRates: fiatRates.rates,
        });
        if (fiat !== null) next.fiat = fiat;
      }
      return next;
    });
  };
  const syncSingleFiat = (value: string) => {
    setForm(prev => {
      const next: FormState = { ...prev, fiat: value };
      const sats = satsInputForFiat({
        fiatValue: value,
        currency: prev.cur,
        usdPerBtc: btcPrice.usd,
        usdFiatRates: fiatRates.rates,
      });
      if (sats !== null) next.sats = sats;
      return next;
    });
  };
  const updateMenuSats = (id: string, value: string) => {
    setForm(prev => ({
      ...prev,
      isSubscription: false,
      menuItems: prev.menuItems.map(item => {
        if (item.id !== id) return item;
        const patch: Partial<MenuDraftItem> = { sats: value };
        if (vertical !== "lending") {
          const fiat = fiatInputForSats({
            satsValue: value,
            currency: prev.cur,
            usdPerBtc: btcPrice.usd,
            usdFiatRates: fiatRates.rates,
          });
          if (fiat !== null) patch.fiat = fiat;
        }
        return { ...item, ...patch };
      }),
    }));
  };
  const updateMenuFiat = (id: string, value: string) => {
    setForm(prev => ({
      ...prev,
      isSubscription: false,
      menuItems: prev.menuItems.map(item => {
        if (item.id !== id) return item;
        const sats = satsInputForFiat({
          fiatValue: value,
          currency: prev.cur,
          usdPerBtc: btcPrice.usd,
          usdFiatRates: fiatRates.rates,
        });
        return {
          ...item,
          fiat: value,
          ...(sats !== null ? { sats } : {}),
        };
      }),
    }));
  };
  useEffect(() => {
    if (vertical === "lending" || !form.sats.trim() || form.fiat.trim()) return;
    const fiat = fiatInputForSats({
      satsValue: form.sats,
      currency: form.cur,
      usdPerBtc: btcPrice.usd,
      usdFiatRates: fiatRates.rates,
    });
    if (!fiat) return;
    setForm(prev => prev.fiat.trim() ? prev : { ...prev, fiat });
  }, [vertical, form.sats, form.fiat, form.cur, btcPrice.usd, fiatRates.rates, setForm]);

  useEffect(() => {
    if (vertical === "lending" || form.menuItems.length === 0) return;
    setForm(prev => {
      let changed = false;
      const menuItems = prev.menuItems.map(item => {
        if (!item.sats.trim() || item.fiat.trim()) return item;
        const fiat = fiatInputForSats({
          satsValue: item.sats,
          currency: prev.cur,
          usdPerBtc: btcPrice.usd,
          usdFiatRates: fiatRates.rates,
        });
        if (!fiat) return item;
        changed = true;
        return { ...item, fiat };
      });
      return changed ? { ...prev, menuItems } : prev;
    });
  }, [vertical, form.menuItems, btcPrice.usd, fiatRates.rates, setForm]);
  const selectedPaymentRails = form.paymentMethods
    .map(method => getRailByKey(toRailKey(method)))
    .filter((rail): rail is Rail => !!rail);
  const paymentMethodOptions = uniqueRailsByKey([
    ...railsForCommunity(homeCommunity?.slug),
    ...selectedPaymentRails,
  ]);
  const paymentSearchResults = paymentRailQuery.trim()
    ? filterCreateRails(searchableRailsForCommunity(homeCommunity?.slug), paymentRailQuery)
      .slice(0, 8)
    : [];
  const togglePaymentMethod = (method: string) => {
    setForm(prev => {
      const methodKey = toRailKey(method);
      const exists = prev.paymentMethods.some(value => toRailKey(value) === methodKey);
      return {
        ...prev,
        paymentMethods: exists
          ? prev.paymentMethods.filter(value => toRailKey(value) !== methodKey)
          : [...prev.paymentMethods, method],
      };
    });
  };
  // setListingMode lifted to the parent CreateForm (v3.1 stage 5 — the listing-style
  // toggle moved to Step 1, under the category pick).
  const menuTitle = menuTitleForVertical(vertical);
  const menuHint = menuHintForVertical(vertical);
  // CBP is intrinsically fiat-denominated (a bill IS a fiat amount — nobody thinks
  // of their electricity bill in sats), so lead with the fiat PRICE field there
  // regardless of the global sats/fiat display toggle. Other verticals still
  // follow the toggle. (Marketplace stays on the toggle — see the create-form UX
  // notes; a fiat-thinking seller already gets fiat-first via the toggle.)
  const fiatPrimary = (amountDisplayMode === "fiat" || vertical === "bill-pay") && vertical !== "lending";
  const menuFiatFloorValue = amountDisplayMode === "fiat" ? menuFiatFloor(menuItems) : null;
  const menuDisplayFiatFloorValue = amountDisplayMode === "fiat"
    ? menuFiatFloorValue ?? estimatedMenuFiatFloor({
        menuItems,
        currency: form.cur,
        usdPerBtc: btcPrice.usd,
        usdFiatRates: fiatRates.rates,
      })
    : null;
  const premiumCheckout = premiumCheckoutLine(form, vertical);
  const addMenuItem = () => {
    setForm(prev => ({
      ...prev,
      listingMode: "menu",
      isSubscription: false,
      menuItems: prev.menuItems.length >= MAX_MENU_ITEMS
        ? prev.menuItems
        : [...prev.menuItems, { ...newMenuDraftItem(), fulfillment: prev.fulfillment }],
    }));
  };
  const updateMenuItem = (id: string, patch: Partial<MenuDraftItem>) => {
    setForm(prev => ({
      ...prev,
      isSubscription: patch.sats || patch.label ? false : prev.isSubscription,
      menuItems: prev.menuItems.map(item => item.id === id ? { ...item, ...patch } : item),
    }));
  };
  const removeMenuItem = (id: string) => {
    setForm(prev => ({
      ...prev,
      menuItems: prev.menuItems.filter(item => item.id !== id),
    }));
  };
  const markImageUploading = (id: string, uploading: boolean) => {
    setUploadingImageIds(current => {
      const next = new Set(current);
      if (uploading) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const updateMenuImages = (id: string, files: File[]) => {
    if (files.length === 0) {
      updateMenuItem(id, { imageDataUrl: "", imageUrls: [] });
      return;
    }
    void (async () => {
      markImageUploading(id, true);
      try {
        const current = form.menuItems.find(item => item.id === id)?.imageUrls ?? [];
        const slots = Math.max(0, MAX_LISTING_IMAGES - current.length);
        const overflowed = files.length > slots;
        const chosen = files.slice(0, slots);
        const prepared = await prepareImagesSequentially(chosen);
        updateMenuItem(id, { imageDataUrl: current[0] ?? prepared[0] ?? "", imageUrls: [...current, ...prepared] });
        const uploaded = await uploadImageRefsSequentially(
          prepared,
          index => chosen[index]?.name || `chama-product-${index + 1}.jpg`,
          authorizeImageUpload,
        );
        const imageUrls = [...current, ...uploaded];
        setImageError(overflowed ? `Maximum ${MAX_LISTING_IMAGES} photos per product. Extra files were not added.` : null);
        updateMenuItem(id, { imageDataUrl: imageUrls[0] ?? "", imageUrls });
      } catch (e: any) {
        setImageError(e?.message || t("create.photoUploadFailed"));
      } finally {
        markImageUploading(id, false);
      }
    })();
  };

  const clearMenuImage = (id: string) => {
    setImageError(null);
    updateMenuItem(id, { imageDataUrl: "", imageUrls: [] });
  };

  const updateListingImages = (files: File[]) => {
    if (files.length === 0) {
      setForm(prev => ({ ...prev, imageDataUrl: "", imageUrls: [] }));
      return;
    }
    void (async () => {
      markImageUploading("single", true);
      try {
        const listingImageLimit = usingMenu ? 1 : MAX_LISTING_IMAGES;
        // A storefront has one hero image, so choosing a new file from the
        // "Change store photo" button is a replacement operation. Previously the
        // existing image consumed the only slot and the newly selected file was
        // sliced away, making the button appear inert until the user deleted the
        // old image manually.
        const currentImages = usingMenu ? [] : form.imageUrls;
        const slots = Math.max(0, listingImageLimit - currentImages.length);
        const overflowed = files.length > slots;
        const chosen = files.slice(0, slots);
        const prepared = await prepareImagesSequentially(chosen);
        const previewUrls = [...currentImages, ...prepared];
        setForm(prev => ({ ...prev, imageDataUrl: previewUrls[0] ?? "", imageUrls: previewUrls }));
        const uploaded = await uploadImageRefsSequentially(
          prepared,
          index => chosen[index]?.name || `chama-listing-${index + 1}.jpg`,
          authorizeImageUpload,
        );
        const imageUrls = [...currentImages, ...uploaded];
        setImageError(overflowed
          ? usingMenu
            ? "A storefront has one store photo. Extra files were not added."
            : `Maximum ${MAX_LISTING_IMAGES} photos. Extra files were not added.`
          : null);
        setForm(prev => ({ ...prev, imageDataUrl: imageUrls[0] ?? "", imageUrls }));
      } catch (e: any) {
        setImageError(e?.message || t("create.photoUploadFailed"));
      } finally {
        markImageUploading("single", false);
      }
    })();
  };

  return (
    <>
      {imageError && (
        <div
          onClick={() => setImageError(null)}
          style={{
            marginBottom: 16, padding: "10px 12px", borderRadius: T.rs,
            background: T.redDim, border: `1px solid ${T.red}55`,
            color: T.red, fontFamily: T.mono, fontSize: 11, lineHeight: 1.5,
            cursor: "pointer",
          }}
        >
          ⚠ {imageError} <span style={{ color: T.muted }}>{t("create.tapToDismiss")}</span>
        </div>
      )}
      {/* LISTING STYLE toggle relocated to Step 1 (v3.1 "every seller is a Store"). */}

      {categoryAllowsFulfillmentChoice(vertical) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>{t("create.fulfillmentLabel")}</div>
          <select value={form.fulfillment} onChange={e => setStoreFulfillment(e.target.value as Fulfillment)}
            style={{ ...inputStyle, color: T.text, background: T.surface }}>
            <option value="physical">{t("create.fulfillmentShipping")}</option>
            <option value="service">{t("create.fulfillmentService")}</option>
            <option value="digital">{t("create.fulfillmentDigital")}</option>
          </select>
        </div>
      )}

      {/* #7 multi-unit storefront: single-product marketplace listings can carry
          a stock count. 2+ makes it a parent buyers purchase via child escrows. */}
      {vertical === "marketplace" && !usingMenu && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>{t("create.unitsInStock")}</div>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={form.stock ?? ""}
            onChange={e => set("stock", e.target.value)}
            placeholder="1"
            style={{ ...inputStyle, color: T.text, background: T.surface }}
          />
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.sans, marginTop: 5, lineHeight: 1.4 }}>
            {t("create.stockHint")}
          </div>
        </div>
      )}

      {descriptionRequired(vertical, usingMenu) && (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
          {descriptionLabel(vertical, usingMenu)}
        </div>
        <input value={form.desc} onChange={e => set("desc", e.target.value)}
          placeholder={descriptionPlaceholder(vertical, usingMenu)}
          style={inputStyle} />
      </div>
      )}

      {(vertical === "marketplace" || vertical === "work") && (
        <div style={{ marginBottom: 16 }}>
          {usingMenu && <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>STORE PHOTO</div>}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <label style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            padding: "9px 10px", borderRadius: T.rs, border: `1px solid ${T.border}`,
            background: T.card, color: form.imageUrls.length ? T.accent : T.muted,
            fontFamily: T.mono, fontSize: 10, fontWeight: 800, cursor: "pointer",
          }}>
            {uploadingImageIds.has("single")
              ? t("create.uploadingPhoto")
              : usingMenu
                ? form.imageUrls.length ? "Change store photo" : "Add store photo"
                : "Add photos"}
            <input
              type="file"
              accept={MENU_IMAGE_ACCEPT}
              multiple={!usingMenu}
              disabled={uploadingImageIds.has("single")}
              onChange={e => {
                updateListingImages(Array.from(e.target.files ?? []));
                e.currentTarget.value = "";
              }}
              style={{ display: "none" }}
            />
          </label>
          {form.imageUrls.map((src, index) => (
            <span key={`${src}:${index}`} style={{ display: "contents" }}>
              <img
                src={src}
                alt=""
                style={{ width: 54, height: 42, objectFit: "cover", borderRadius: 8, border: `1px solid ${T.border}` }}
              />
              <button
                type="button"
                onClick={() => {
                  setImageError(null);
                  const imageUrls = form.imageUrls.filter((_, candidate) => candidate !== index);
                  setForm(prev => ({ ...prev, imageDataUrl: imageUrls[0] ?? "", imageUrls }));
                }}
                style={{ border: "none", background: "none", color: T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 800, cursor: "pointer" }}
              >
                ×
              </button>
            </span>
          ))}
          <span style={{ color: form.imageUrls.length >= (usingMenu ? 1 : MAX_LISTING_IMAGES) ? T.amber : T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 700 }}>
            {usingMenu ? `${form.imageUrls.length}/1 store photo` : `${form.imageUrls.length}/${MAX_LISTING_IMAGES} photos`}
          </span>
          </div>
        </div>
      )}

      {/* v4.1 (#12) CBP bill-type picker — optional, country-driven, informational
          metadata only (never gates posting, never touches escrow logic). */}
      {vertical === "bill-pay" && !usingMenu && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            {t("create.billTypeLabel")} <span style={{ color: T.amber, opacity: 0.9 }}>{t("create.billTypePickOne")}</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {billTypesForCountry(homeCommunity?.country).map(bt => {
              const on = form.billType === bt.id;
              return (
                <button
                  key={bt.id}
                  type="button"
                  onClick={() => set("billType", on ? "" : bt.id)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "7px 11px", borderRadius: 999, cursor: "pointer",
                    background: on ? `${T.accent}1f` : T.surface,
                    border: `1px solid ${on ? T.accent : T.border}`,
                    color: on ? T.accent : T.text,
                    fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                  }}
                >
                  <span aria-hidden="true">{bt.icon}</span>{bt.label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.sans, marginTop: 6, lineHeight: 1.4 }}>
            {t("create.billTypeHint")}
          </div>
        </div>
      )}

      {/* Tier 2.1 — where the sats sit. OPT-IN above the threshold (Jetty's
          call): people who want on-chain will choose it, people trading small
          amounts should not be pushed into a miner fee.

          ⚠ COPY RULE, and it is deliberate: state what each option DOES and do
          not editorialise. No "fast here, slow there" — that frames one choice
          as the mistake. Both lines say the same kinds of thing (speed, cost,
          privacy, who can take it back) and let the user weigh them. The
          ecash line names the funder-clawback plainly, because a user choosing
          between two escrows deserves to know the difference that matters. */}
      {onchainEscrowAvailable(BigInt(Math.max(0, Math.floor(totalSats)))) && !usingMenu && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            {t("onchain.modeLabel")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {([
              { id: "ecash", label: t("onchain.modeEcash"), body: t("onchain.modeEcashBody"), icon: "⚡" },
              { id: "onchain", label: t("onchain.modeOnchain"), body: t("onchain.modeOnchainBody"), icon: "⛓" },
            ] as const).map((opt) => {
              const on = (form.escrowMode ?? DEFAULT_ESCROW_MODE) === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => set("escrowMode", opt.id)}
                  style={{
                    textAlign: "left", padding: "11px 12px", borderRadius: T.rs, cursor: "pointer",
                    background: on ? `${T.accent}1f` : T.surface,
                    border: `1px solid ${on ? T.accent : T.border}`,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 800, color: on ? T.accent : T.text, fontFamily: T.sans }}>
                    <span aria-hidden="true">{opt.icon}</span> {opt.label}
                  </div>
                  <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.sans, marginTop: 3, lineHeight: 1.45 }}>
                    {opt.body}
                  </div>
                  {/* Name the network on the tile itself. A tester must be able
                      to see, at a glance, which chain a listing will use — not
                      discover it three screens later. */}
                  {opt.id === "onchain" && (
                    <div style={{
                      display: "inline-block", marginTop: 6, padding: "2px 7px", borderRadius: 999,
                      background: ESCROW_NETWORK_LABEL === "signet" ? `${T.amber}22` : `${T.green}22`,
                      border: `1px solid ${ESCROW_NETWORK_LABEL === "signet" ? T.amber : T.green}55`,
                      color: ESCROW_NETWORK_LABEL === "signet" ? T.amber : T.green,
                      fontFamily: T.mono, fontSize: 9, fontWeight: 800, letterSpacing: 0.5,
                    }}>
                      {ESCROW_NETWORK_LABEL === "signet" ? "SIGNET · TEST COINS" : "MAINNET"}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* A4 — Work, both sides.
          The SIDE picker comes first because it changes who the listing is
          addressed to, and the category second because that is the join key the
          matcher compares an offer against a request. Both are shown for Work
          only, and the category is REQUIRED — a Work listing without one can
          only ever match on the weak signals, which is the difference between
          "we found you a job" and "here is a wall of listings". */}
      {vertical === "work" && !usingMenu && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            {t("create.workSideLabel")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
            {([
              { id: "work", label: t("create.workSideOffer"), body: t("create.workSideOfferBody"), icon: "🛠️" },
              { id: "work-request", label: t("create.workSideRequest"), body: t("create.workSideRequestBody"), icon: "🙋" },
            ] as const).map(side => {
              const on = form.workSide === side.id;
              return (
                <button
                  key={side.id}
                  type="button"
                  onClick={() => set("workSide", side.id)}
                  style={{
                    textAlign: "left", padding: "11px 12px", borderRadius: T.rs,
                    cursor: "pointer",
                    background: on ? `${T.accent}1f` : T.surface,
                    border: `1px solid ${on ? T.accent : T.border}`,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 800, color: on ? T.accent : T.text, fontFamily: T.sans }}>
                    <span aria-hidden="true">{side.icon}</span> {side.label}
                  </div>
                  <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.sans, marginTop: 3, lineHeight: 1.4 }}>
                    {side.body}
                  </div>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            {t("create.workCategoryLabel")} <span style={{ color: T.amber, opacity: 0.9 }}>{t("create.billTypePickOne")}</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {workCategoriesForCountry(homeCommunity?.country).map(c => {
              const on = form.workCategory === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => set("workCategory", on ? "" : c.id)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "7px 11px", borderRadius: 999, cursor: "pointer",
                    background: on ? `${T.accent}1f` : T.surface,
                    border: `1px solid ${on ? T.accent : T.border}`,
                    color: on ? T.accent : T.text,
                    fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                  }}
                >
                  <span aria-hidden="true">{c.icon}</span>{c.label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.sans, marginTop: 6, lineHeight: 1.4 }}>
            {t("create.workCategoryHint")}
          </div>
        </div>
      )}

      {/* Monthly CBP: mark a bill (or a monthly-bills bundle) as recurring so the
          client auto-re-posts it ~monthly to the owner's home community. No bond,
          online-gated. Bill-pay only; applies to single AND menu mode. */}
      {vertical === "bill-pay" && (
        <button
          type="button"
          onClick={() => setForm(f => ({ ...f, recurringCbp: !f.recurringCbp }))}
          style={{
            display: "flex", alignItems: "flex-start", gap: 10, width: "100%",
            marginBottom: 16, padding: "12px 14px", textAlign: "left" as const,
            background: form.recurringCbp ? `${T.accent}1f` : T.surface,
            border: `1px solid ${form.recurringCbp ? T.accent : T.border}`,
            borderRadius: T.r, cursor: "pointer", fontFamily: T.sans,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1 }}>🔁</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{
              display: "block", fontSize: 13, fontWeight: 700,
              color: form.recurringCbp ? T.accent : T.text,
            }}>
              {t("create.recurringToggleLabel")}
            </span>
            <span style={{ display: "block", fontSize: 10.5, color: T.muted, marginTop: 3, lineHeight: 1.45 }}>
              {t("create.recurringToggleHint")}
            </span>
          </span>
          <span aria-hidden="true" style={{
            flexShrink: 0, width: 40, height: 22, borderRadius: 999, position: "relative",
            background: form.recurringCbp ? T.accent : T.border, transition: "background .2s",
          }}>
            <span style={{
              position: "absolute", top: 2, left: form.recurringCbp ? 20 : 2,
              width: 18, height: 18, borderRadius: "50%", background: "#fff",
              transition: "left .2s",
            }} />
          </span>
        </button>
      )}

      {!usingMenu ? (
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          {!fiatPrimary && (
          <div style={{ flex: vertical === "lending" ? 1.15 : 1 }}>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
              {vertical === "lending" ? t("create.loanPrincipalLabel") : t("create.priceLabel")}
            </div>
            <input
              type="number"
              value={form.sats}
              onChange={e => syncSingleSats(e.target.value)}
              placeholder="100000"
              style={inputStyle}
            />
          </div>
          )}
          {fiatPrimary && (
          <div style={{ flex: 1.15 }}>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>{t("create.priceLabel")}</div>
            <div style={{ display: "flex", gap: 6 }}>
              <div style={{
                width: 72,
                padding: "12px 6px",
                borderRadius: T.rs,
                border: `1px solid ${T.border}`,
                background: T.surface,
                color: T.text,
                fontFamily: T.mono,
                fontSize: 12,
                fontWeight: 900,
                textAlign: "center",
              }}>
                {form.cur}
              </div>
              <input type="number" value={form.fiat} onChange={e => syncSingleFiat(e.target.value)} placeholder="50" style={{ ...inputStyle, flex: 1 }} />
            </div>
            <div style={{ marginTop: 5, fontSize: 9, color: T.muted, fontFamily: T.mono }}>
              {t("create.localPriceNote")}
            </div>
          </div>
          )}
          {fiatPrimary && (
          <div style={{ flex: 0.85 }}>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
              {t("create.satsLabel")}
            </div>
            <input
              type="number"
              value={form.sats}
              onChange={e => syncSingleSats(e.target.value)}
              placeholder="100000"
              style={inputStyle}
            />
          </div>
          )}
          {vertical === "lending" ? (
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>{t("create.borrowerTier")}</div>
              <div style={{
                minHeight: 44,
                padding: "10px 12px",
                borderRadius: T.rs,
                border: `1px solid ${lendingCapExceeded ? T.red + "66" : T.border}`,
                background: lendingCapExceeded ? T.redDim : T.surface,
                color: lendingCapExceeded ? T.red : T.text,
                fontFamily: T.mono,
                fontSize: 11,
                lineHeight: 1.35,
                display: "flex",
                alignItems: "center",
              }}>
                {lendingTierSummary(form.sats)}
              </div>
            </div>
          ) : !fiatPrimary && (
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>{t("create.fiatLabel")}</div>
            <div style={{ display: "flex", gap: 6 }}>
              <div style={{
                width: 72,
                padding: "12px 6px",
                borderRadius: T.rs,
                border: `1px solid ${T.border}`,
                background: T.surface,
                color: T.text,
                fontFamily: T.mono,
                fontSize: 12,
                fontWeight: 900,
                textAlign: "center",
              }}>
                {form.cur}
              </div>
              <input type="number" value={form.fiat} onChange={e => syncSingleFiat(e.target.value)} placeholder="50" style={{ ...inputStyle, flex: 1 }} />
            </div>
            {/* 3.5.1 #4 belt-and-suspenders: when the live rate for this
                currency isn't available yet (fresh instance, forex feed not
                warm), say so instead of leaving the field silently un-filled.
                USD needs only the BTC price; other currencies also need the
                USD→local FX rate. */}
            {(() => {
              const liveRateReady = !!btcPrice.usd && btcPrice.usd > 0
                && (form.cur === "USD" || !!fiatRates.rates?.[form.cur]);
              return (
                <div style={{ marginTop: 5, fontSize: 9, color: liveRateReady ? T.muted : T.amber, fontFamily: T.mono }}>
                  {liveRateReady
                    ? t("create.autoFromChama", { flag: homeCommunity?.flagEmoji ?? "🌐" })
                    : t("create.rateLoading", { currency: form.cur })}
                </div>
              );
            })()}
          </div>
          )}
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            {t("create.menuCurrencyLabel")}
          </div>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 10,
            borderRadius: T.rs,
            border: `1px solid ${T.border}`,
            background: T.surface,
          }}>
            <div style={{
              padding: "10px 12px",
              borderRadius: T.rs,
              border: `1px solid ${T.border}`,
              background: T.card,
              color: T.text,
              fontFamily: T.mono,
              fontSize: 12,
              fontWeight: 900,
            }}>
              {form.cur}
            </div>
            <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10, lineHeight: 1.45 }}>
              {menuCurrencyHint(vertical, form.cur)}
              {" "}{t("create.autoFromChamaSentence", { flag: homeCommunity?.flagEmoji ?? "🌐" })}
            </div>
          </div>
        </div>
      )}

      {supportsPremium(vertical) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            {premiumLabelForVertical(vertical)}
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "minmax(112px, 0.45fr) 1fr",
            gap: 8,
            alignItems: "stretch",
          }}>
            <input
              type="number"
              value={form.premium}
              onChange={e => set("premium", e.target.value)}
              placeholder={vertical === "lending" ? "12" : "2.5"}
              style={inputStyle}
            />
            <div style={{
              minHeight: 44,
              padding: "9px 10px",
              borderRadius: T.rs,
              border: `1px solid ${T.border}`,
              background: T.surface,
              color: premiumCheckout ? T.accent : T.muted,
              fontFamily: T.mono,
              fontSize: 10,
              lineHeight: 1.35,
              display: "flex",
              alignItems: "center",
            }}>
              {premiumCheckout ?? premiumHintForVertical(vertical, form.cur)}
            </div>
          </div>
        </div>
      )}

      {categoryUsesPaymentRails(vertical) && paymentMethodOptions.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 6,
          }}>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
              {t("create.acceptedPayment")}
            </div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>
              {homeCommunity?.country ?? homeCommunity?.currency ?? t("create.localFallback")}
            </div>
          </div>
          <div className="payment-rail-scroll" style={{
            display: "flex",
            padding: 10,
            borderRadius: T.rs,
            background: T.surface,
            border: `1px solid ${T.border}`,
            overflowX: "auto",
            overflowY: "hidden",
            WebkitOverflowScrolling: "touch",
            scrollbarWidth: "none",
          }}>
            <div style={{
              display: "flex",
              gap: 7,
              minWidth: "100%",
              width: "max-content",
            }}>
              {paymentMethodOptions.map(rail => {
                const selected = form.paymentMethods.some(method =>
                  toRailKey(method) === rail.key
                );
                return (
                  <button
                    key={rail.key}
                    type="button"
                    onClick={() => togglePaymentMethod(rail.displayName)}
                    style={{
                      padding: "6px 9px",
                      borderRadius: 999,
                      border: `1px solid ${selected ? T.accent + "77" : T.border}`,
                      background: selected ? T.accentDim : T.card,
                      color: selected ? T.accent : T.muted,
                      fontFamily: T.mono,
                      fontSize: 10,
                      fontWeight: 800,
                      cursor: "pointer",
                      flex: "0 0 auto",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {selected ? "✓ " : ""}{rail.displayName}
                  </button>
                );
              })}
            </div>
          </div>
          <input
            value={paymentRailQuery}
            onChange={e => setPaymentRailQuery(e.target.value)}
            placeholder={t("create.searchPaymentPlaceholder")}
            style={{
              ...inputStyle,
              marginTop: 8,
              marginBottom: paymentRailQuery.trim() ? 8 : 0,
              padding: "9px 11px",
              fontSize: 11,
            }}
          />
          {paymentRailQuery.trim() && (
            <div style={{
              display: "grid",
              gap: 6,
              padding: 8,
              borderRadius: T.rs,
              background: T.surface,
              border: `1px solid ${T.border}`,
              animation: "fadeIn 0.18s ease",
            }}>
              {paymentSearchResults.length === 0 ? (
                <div style={{
                  color: T.muted,
                  fontFamily: T.mono,
                  fontSize: 10,
                  padding: "4px 2px",
                }}>
                  {t("create.noMatchingPayment")}
                </div>
              ) : paymentSearchResults.map((rail, i) => {
                const selected = form.paymentMethods.some(method =>
                  toRailKey(method) === rail.key
                );
                return (
                  <button
                    key={rail.key}
                    type="button"
                    onClick={() => togglePaymentMethod(rail.displayName)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      width: "100%",
                      padding: "8px 9px",
                      borderRadius: T.rs,
                      border: `1px solid ${selected ? T.accent + "77" : T.border}`,
                      background: selected ? T.accentDim : T.card,
                      color: selected ? T.accent : T.text,
                      fontFamily: T.mono,
                      fontSize: 10,
                      fontWeight: 800,
                      cursor: "pointer",
                      textAlign: "left" as const,
                      animation: `fadeIn 0.18s ease ${i * 0.025}s both`,
                    }}
                  >
                    <span style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {rail.displayName}
                    </span>
                    <span style={{ color: selected ? T.accent : T.muted, flexShrink: 0 }}>
                      {selected ? t("create.addedRail") : t("create.addRail")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {amountTooSmall && (
        <div style={{
          marginTop: -8, marginBottom: 16, padding: "8px 10px",
          borderRadius: T.rs, background: T.amberDim,
          border: `1px solid ${T.amber}44`,
          color: T.amber, fontFamily: T.mono, fontSize: 10, lineHeight: 1.45,
        }}>
          {minimumAtomicFundingMessage()}
        </div>
      )}
      {lendingCapExceeded && (
        <div style={{
          marginTop: -8, marginBottom: 16, padding: "8px 10px",
          borderRadius: T.rs, background: T.redDim,
          border: `1px solid ${T.red}44`,
          color: T.red, fontFamily: T.mono, fontSize: 10, lineHeight: 1.45,
        }}>
          {t("create.lendingCapBefore")}{" "}
          <BitcoinAmount
            sats={MAX_FEDIMINT_LENDING_SATS}
            size={10}
            gap={3}
            glyphScale={1.2}
            color="inherit"
            glyphColor="inherit"
          />{t("create.lendingCapAfterLater")}
        </div>
      )}
      {usingMenu && (
      <div style={{
        marginBottom: 20,
        padding: 14,
        background: usingMenu
          ? `linear-gradient(180deg, ${T.accentDim}, ${T.card} 62%)`
          : T.card,
        border: `1px solid ${usingMenu ? T.accent + "88" : T.border}`,
        borderRadius: T.r,
        boxShadow: usingMenu ? `0 0 0 1px ${T.accent}11, 0 18px 44px ${T.accent}12` : "none",
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: form.menuItems.length > 0 ? 12 : 0,
        }}>
          <div>
            <div style={{
              fontSize: 11,
              color: usingMenu ? T.accent : T.muted,
              fontFamily: T.mono,
              fontWeight: 900,
              letterSpacing: 1,
            }}>
              {menuTitle}
            </div>
            <div style={{ marginTop: 3, fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.45 }}>
              {menuHint}
            </div>
            {hasMenu && (
              <div style={{
                marginTop: 3,
                fontSize: 10,
                color: T.muted,
                fontFamily: T.mono,
                display: "inline-flex",
                alignItems: "baseline",
                gap: 4,
              }}>
                {t("create.fromPrefix")} {menuDisplayFiatFloorValue
                  ? formatFiatAmount(menuDisplayFiatFloorValue.amount, menuDisplayFiatFloorValue.currency)
                  : <BitcoinAmount msats={Math.min(...menuItems.map(item => item.amountMsats))} size={10} gap={3} glyphScale={1.2} color={T.muted} glyphColor={T.muted} />}
              </div>
            )}
          </div>
        </div>
        {form.menuItems.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {form.menuItems.map((item, index) => (
              <div key={item.id} style={{
                padding: 12,
                borderRadius: T.rs,
                border: `1px solid ${usingMenu ? T.accent + "33" : T.border}`,
                background: usingMenu ? T.bg : T.surface,
              }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <input
                    value={item.label}
                    onChange={e => updateMenuItem(item.id, { label: e.target.value })}
                    placeholder={menuPlaceholderForVertical(vertical, index)}
                    style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                  />
                  <input
                    type="number"
                    value={item.sats}
                    onChange={e => updateMenuSats(item.id, e.target.value)}
                    placeholder={vertical === "p2p-trade" ? t("create.minSatsPlaceholder") : vertical === "lending" ? t("create.principalPlaceholder") : "sats"}
                    style={{ ...inputStyle, width: 92 }}
                  />
                  {vertical === "p2p-trade" && (
                    <input
                      type="number"
                      value={item.maxSats}
                      onChange={e => updateMenuItem(item.id, { maxSats: e.target.value })}
                      placeholder={t("create.maxPlaceholder")}
                      style={{ ...inputStyle, width: 92 }}
                    />
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input
                    value={item.description}
                    onChange={e => updateMenuItem(item.id, { description: e.target.value })}
                    placeholder={t("create.notePlaceholder")}
                    style={{ ...inputStyle, flex: "1 1 140px", minWidth: 0, fontSize: 12 }}
                  />
                  {vertical !== "lending" && (
                    <input
                      type="number"
                      value={item.fiat}
                      onChange={e => updateMenuFiat(item.id, e.target.value)}
                      placeholder={form.cur}
                      style={{ ...inputStyle, width: 84, fontSize: 12 }}
                    />
                  )}
                  {vertical === "bill-pay" && (
                    <input
                      type="date"
                      value={item.dueDate}
                      onChange={e => updateMenuItem(item.id, { dueDate: e.target.value })}
                      style={{ ...inputStyle, width: 128, fontSize: 11 }}
                    />
                  )}
                  {vertical === "lending" && (
                    <>
                      <input
                        type="number"
                        value={item.termDays}
                        onChange={e => updateMenuItem(item.id, { termDays: e.target.value })}
                        placeholder={t("create.daysPlaceholder")}
                        style={{ ...inputStyle, width: 72, fontSize: 12 }}
                      />
                      <input
                        type="number"
                        value={item.apr}
                        onChange={e => updateMenuItem(item.id, { apr: e.target.value })}
                        placeholder={t("create.aprPlaceholder")}
                        style={{ ...inputStyle, width: 72, fontSize: 12 }}
                      />
                      <div style={{
                        minWidth: 110,
                        padding: "11px 10px",
                        borderRadius: T.rs,
                        border: `1px solid ${lendingAmountAboveCurrentCap(item.sats) ? T.red + "66" : T.border}`,
                        background: lendingAmountAboveCurrentCap(item.sats) ? T.redDim : T.card,
                        color: lendingAmountAboveCurrentCap(item.sats) ? T.red : T.accent,
                        fontFamily: T.mono,
                        fontSize: 10,
                        fontWeight: 800,
                        lineHeight: 1.35,
                      }}>
                        {lendingTierSummary(item.sats)}
                      </div>
                    </>
                  )}
                  {vertical === "marketplace" && (
                    <select
                      value={form.fulfillment}
                      disabled
                      aria-label="Inherited storefront fulfillment"
                      title="Inherited from the storefront fulfillment above"
                      style={{ ...inputStyle, width: 108, padding: "12px 6px", fontSize: 11, color: T.muted, background: T.card, opacity: 0.8 }}
                    >
                      <option value="physical">{t("create.fulfillmentShipping")}</option>
                      <option value="service">{t("create.fulfillmentService")}</option>
                      <option value="digital">{t("create.fulfillmentDigital")}</option>
                    </select>
                  )}
                  <button
                    onClick={() => removeMenuItem(item.id)}
                    style={{
                      width: 42,
                      borderRadius: T.rs,
                      border: `1px solid ${T.border}`,
                      background: T.card,
                      color: T.muted,
                      fontFamily: T.mono,
                      fontSize: 14,
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    ×
                  </button>
                </div>
                {menuImagesAllowedForVertical(vertical) && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 8,
                  }}>
                    <label style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "9px 10px",
                      borderRadius: T.rs,
                      border: `1px solid ${T.border}`,
                      background: T.card,
                      color: item.imageDataUrl ? T.accent : T.muted,
                      fontFamily: T.mono,
                      fontSize: 10,
                      fontWeight: 800,
                      cursor: "pointer",
                    }}>
                      {uploadingImageIds.has(item.id)
                        ? t("create.uploadingPhoto")
                        : "+ Photos"}
                      <input
                        type="file"
                        accept={MENU_IMAGE_ACCEPT}
                        multiple
                        disabled={uploadingImageIds.has(item.id)}
                        onChange={e => {
                          updateMenuImages(item.id, Array.from(e.target.files ?? []));
                          e.currentTarget.value = "";
                        }}
                        style={{ display: "none" }}
                      />
                    </label>
                    {item.imageUrls.length > 0 && (
                      <>
                        <img
                          src={item.imageUrls[0]}
                          alt=""
                          style={{
                            width: 54,
                            height: 42,
                            objectFit: "cover",
                            borderRadius: 8,
                            border: `1px solid ${T.border}`,
                          }}
                        />
                        <button
                          onClick={() => clearMenuImage(item.id)}
                          style={{
                            border: "none",
                            background: "none",
                            color: T.muted,
                            fontFamily: T.mono,
                            fontSize: 10,
                            fontWeight: 800,
                            cursor: "pointer",
                          }}
                        >
                          {t("create.removePhoto")}
                        </button>
                      </>
                    )}
                    <span style={{ color: item.imageUrls.length >= MAX_LISTING_IMAGES ? T.amber : T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 700 }}>
                      {item.imageUrls.length}/{MAX_LISTING_IMAGES} photos
                    </span>
                    {vertical === "marketplace" && (
                      <label
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          marginLeft: "auto",
                          fontFamily: T.mono,
                          fontSize: 10,
                          fontWeight: 800,
                          color: item.maxQty.trim() ? T.accent : T.muted,
                        }}
                        title={t("create.maxPerOrderTitle")}
                      >
                        {t("create.maxPerOrder")}
                        <input
                          type="number"
                          min={1}
                          inputMode="numeric"
                          placeholder="∞"
                          value={item.maxQty}
                          onChange={e => updateMenuItem(item.id, { maxQty: e.target.value })}
                          style={{
                            ...inputStyle,
                            width: 56,
                            padding: "8px 8px",
                            fontSize: 11,
                            textAlign: "center",
                            color: T.text,
                            background: T.card,
                          }}
                        />
                      </label>
                    )}
                  </div>
                )}
              </div>
            ))}
            {partialMenuRows && (
              <div style={{
                color: T.amber,
                fontFamily: T.mono,
                fontSize: 10,
                lineHeight: 1.45,
              }}>
                {menuPartialMessage(vertical)}
              </div>
            )}
          </div>
        )}
        {/* The single "+ add" now lives HERE — below the list, ALWAYS visible (even
            at 0 items, so an emptied menu can be refilled), following the user down
            as they build. Replaces the old header "+" (removed as redundant). */}
        <button
          type="button"
          onClick={addMenuItem}
          disabled={form.menuItems.length >= MAX_MENU_ITEMS}
          style={{
            width: "100%", padding: "11px 12px", borderRadius: T.rs, marginTop: 10,
            border: `1px dashed ${form.menuItems.length >= MAX_MENU_ITEMS ? T.border : T.accent + "66"}`,
            background: "none",
            color: form.menuItems.length >= MAX_MENU_ITEMS ? T.muted : T.accent,
            fontFamily: T.mono, fontSize: 12, fontWeight: 800,
            cursor: form.menuItems.length >= MAX_MENU_ITEMS ? "default" : "pointer",
          }}
        >
          {form.menuItems.length >= MAX_MENU_ITEMS ? t("create.maxItemsReached", { count: MAX_MENU_ITEMS }) : menuAddLabelForVertical(vertical)}
        </button>
      </div>
      )}

      {/* Subscription toggle — invisible unless graduated (item 7).
          v0.2.0 universally false (no rating events yet). */}
      {showSubscriptionMode && !usingMenu && (
        <div style={{
          marginBottom: 20, padding: 16,
          background: form.isSubscription ? T.purpleDim : T.surface,
          border: `1px solid ${form.isSubscription ? T.purple + "33" : T.border}`,
          borderRadius: T.r, transition: "all 0.3s",
        }}>
          <div
            onClick={() => set("isSubscription", !form.isSubscription)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              cursor: "pointer",
            }}
          >
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: form.isSubscription ? T.purple : T.muted, fontFamily: T.mono }}>
                {t("create.subscriptionMode")}
              </div>
              <div style={{ fontSize: 10, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
                {t("create.subscriptionModeDesc")}
              </div>
            </div>
            <div style={{
              width: 40, height: 22, borderRadius: 11,
              background: form.isSubscription ? T.purple : T.border,
              padding: 2, transition: "background 0.2s", cursor: "pointer",
            }}>
              <div style={{
                width: 18, height: 18, borderRadius: "50%",
                background: T.text, transition: "transform 0.2s",
                transform: form.isSubscription ? "translateX(18px)" : "translateX(0)",
              }} />
            </div>
          </div>

          {form.isSubscription && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: T.purple, fontFamily: T.mono, marginBottom: 4 }}>{t("create.periodsLabel")}</div>
                  <select value={form.periods} onChange={e => set("periods", e.target.value)}
                    style={{ ...inputStyle, fontSize: 12, color: T.text, background: T.surface }}>
                    {[2,3,4,5,6,7,8,9,10,11,12,24,36,52].map(n => (
                      <option key={n} value={n}>{t(n === 1 ? "create.periodOptionOne" : "create.periodOptionMany", { count: n })}</option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: T.purple, fontFamily: T.mono, marginBottom: 4 }}>{t("create.intervalLabel")}</div>
                  <select value={form.intervalDays} onChange={e => set("intervalDays", e.target.value)}
                    style={{ ...inputStyle, fontSize: 12, color: T.text, background: T.surface }}>
                    <option value="7">{t("create.intervalWeekly")}</option>
                    <option value="14">{t("create.intervalBiweekly")}</option>
                    <option value="30">{t("create.intervalMonthly")}</option>
                    <option value="90">{t("create.intervalQuarterly")}</option>
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onBack} style={{
          flex: 1, padding: "14px",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
          color: T.text, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
          cursor: "pointer",
        }}>
          {t("create.backButton")}
        </button>
        <button onClick={onNext} disabled={!ready} style={{
          flex: 2, padding: "14px",
          background: ready ? T.accent : T.surface,
          border: ready ? "none" : `1px solid ${T.border}`,
          borderRadius: T.rs,
          color: ready ? T.bg : T.muted,
          fontFamily: T.mono, fontSize: 14, fontWeight: 800,
          cursor: ready ? "pointer" : "default",
          letterSpacing: 0.5,
        }}>
          {t("create.reviewButton")}
        </button>
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Step 3 — Review & publish
// ══════════════════════════════════════════════════════════════════════════

function Step3({
  vertical, form, setForm,
  homeCommunity,
  firstPublishDone,
  submitting,
  amountDisplayMode,
  onBack, onPublish, onSaveDraft,
}: {
  vertical: Vertical;
  form: FormState;
  setForm: (updater: (f: FormState) => FormState) => void;
  homeCommunity: ReturnType<typeof getCommunityBySlug>;
  firstPublishDone: boolean;
  submitting: boolean;
  amountDisplayMode: AmountDisplayMode;
  onBack: () => void;
  onPublish: () => void;
  onSaveDraft: () => void;
}) {
  const { t } = useT();
  const btcPrice = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const v = VERTICALS.find(vert => vert.id === vertical)!;
  const menuItems = normalizeMenuItems(form, vertical);
  const hasMenu = menuItems.length > 0;
  const previewImages = vertical === "marketplace" || vertical === "work" ? [
    ...(form.imageUrls.length ? form.imageUrls : form.imageDataUrl ? [form.imageDataUrl] : []),
    ...(hasMenu ? menuItems.flatMap(item => {
      const leadImage = item.imageUrls?.[0] ?? item.imageDataUrl;
      return leadImage ? [leadImage] : [];
    }) : []),
  ] : [];
  const listingDescription = buildListingDescription(form, vertical, menuItems);
  const totalSats = effectiveListingSats(form, vertical);
  const partialMenuRows = hasPartialMenuRows(form, vertical);
  const amountTooSmall =
    !isSimModeOn() &&
    !isTestnetMode() &&
    totalSats > 0 &&
    totalSats < MIN_REAL_ATOMIC_FUNDING_SATS;
  const lendingCapExceeded = hasLendingAmountAboveCurrentCap(form, vertical);
  const billTypeOk = vertical !== "bill-pay" || hasMenu || !!form.billType;
  const workCategoryOk = vertical !== "work" || hasMenu || !!form.workCategory;
  const ready =
    listingDescription.length > 0 &&
    billTypeOk &&
    workCategoryOk &&
    (form.sats.trim().length > 0 || hasMenu) &&
    !partialMenuRows &&
    !amountTooSmall &&
    !lendingCapExceeded;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));
  const fiatFloor = menuFiatFloor(menuItems);
  const singleFiatAmount = parseFiatAmount(form.fiat);
  const singleFiatEstimateSats = vertical === "bill-pay" ? parseWholeSats(form.sats) : totalSats;
  const estimatedSingleFiatAmount = singleFiatAmount ?? estimateFiatForMsats({
    amountMsats: singleFiatEstimateSats * 1000,
    currency: form.cur,
    usdPerBtc: btcPrice.usd,
    usdFiatRates: fiatRates.rates,
  });
  const previewFiatFloor = fiatFloor ?? estimatedMenuFiatFloor({
    menuItems,
    currency: form.cur,
    usdPerBtc: btcPrice.usd,
    usdFiatRates: fiatRates.rates,
  });
  const previewPremium = premiumReviewLine(form, vertical);
  const previewPremiumCheckout = premiumCheckoutLine(form, vertical);
  const showFiatPrimary = amountDisplayMode === "fiat";
  const previewSingleSats = totalSats;

  return (
    <>
      {/* Honesty info card — one-time-per-account, dismissed on first
          successful publish (handled by handlePublish above). Not
          dismissable inline; just disappears after the user has
          published once. */}
      {!firstPublishDone && (
        <div style={{
          marginBottom: 16, padding: 14,
          background: T.accentDim, border: `1px solid ${T.accent}33`,
          borderRadius: T.r,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: T.accent, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            {t("create.firstListingHeadsUp")}
          </div>
          <div style={{ fontSize: 12, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
            {t("create.firstListingBody")}
          </div>
        </div>
      )}

      {/* Editable bits — small subset for the review screen */}
      {descriptionRequired(vertical, hasMenu) && (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
          {descriptionLabel(vertical, hasMenu)}
        </div>
        <input value={form.desc} onChange={e => set("desc", e.target.value)}
          placeholder={descriptionPlaceholder(vertical, hasMenu)}
          style={inputStyle} />
      </div>
      )}

      {/* Preview card */}
      <div style={{
        marginBottom: 20, padding: 16,
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 12,
        }}>
          {t("create.previewLabel")}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 16 }}>{v.icon}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
            {t(v.labelKey)}
          </span>
          {homeCommunity && (
            <span style={{
              fontSize: 9, color: T.muted, fontFamily: T.mono,
              padding: "2px 6px", borderRadius: 8,
              background: T.surface, border: `1px solid ${T.border}`,
            }}>
              {homeCommunity.flagEmoji} {homeCommunity.displayName}
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, color: T.text, fontFamily: T.sans, marginBottom: 8 }}>
          {listingDescription || <span style={{ color: T.muted, fontStyle: "italic" }}>{t("create.noDescription")}</span>}
        </div>
        {categoryUsesPaymentRails(vertical) && form.paymentMethods.length > 0 && (
          <div style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: 10,
          }}>
            {form.paymentMethods.slice(0, 5).map(method => (
              <span
                key={method}
                style={{
                  padding: "4px 7px",
                  borderRadius: 999,
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  color: T.muted,
                  fontFamily: T.mono,
                  fontSize: 9,
                  fontWeight: 800,
                }}
              >
                {method}
              </span>
            ))}
          </div>
        )}
        {previewImages.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <SwipeImageGallery images={previewImages} height={156} />
          </div>
        )}
        {hasMenu ? (
          <>
            <div style={{
              fontSize: 14,
              fontWeight: 800,
              color: T.accent,
              fontFamily: T.mono,
              marginBottom: 10,
              display: "flex",
              alignItems: "baseline",
              gap: 6,
            }}>
              <span style={{ color: T.muted, fontWeight: 700 }}>{t("create.fromPrefix")}</span>
              {showFiatPrimary && previewFiatFloor ? (
                <span>{formatFiatAmount(previewFiatFloor.amount, previewFiatFloor.currency)}</span>
              ) : (
                <BitcoinAmount msats={Math.min(...menuItems.map(item => item.amountMsats))} size={14} gap={4} glyphScale={1.18} />
              )}
              <span style={{ color: T.muted, marginLeft: 8, fontWeight: 500 }}>
                {showFiatPrimary && previewFiatFloor ? `₿ ${fmtSats(Math.min(...menuItems.map(item => item.amountMsats)))} · ` : ""}
                {menuCountLabel(vertical, menuItems.length)}
              </span>
            </div>
            {previewPremium && (
              <div style={{ marginTop: -4, marginBottom: 10, color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 800 }}>
                {previewPremium}
                {previewPremiumCheckout ? ` · ${previewPremiumCheckout}` : ""}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {menuItems.map(item => (
                <div key={item.id} style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: T.rs,
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                }}>
                  <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                    {item.imageDataUrl && (
                      <img
                        src={item.imageDataUrl}
                        alt=""
                        style={{ width: 34, height: 28, objectFit: "cover", borderRadius: 6, flexShrink: 0 }}
                      />
                    )}
                    <span style={{ minWidth: 0 }}>
                      <span style={{
                        display: "block",
                        color: T.text,
                        fontFamily: T.sans,
                        fontSize: 12,
                        fontWeight: 700,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap" as const,
                      }}>
                        {item.label}
                      </span>
                      {(item.dueAt || item.termDays || item.trustTier) && (
                        <span style={{
                          display: "block",
                          marginTop: 2,
                          color: T.muted,
                          fontFamily: T.mono,
                          fontSize: 9,
                          whiteSpace: "nowrap" as const,
                        }}>
                          {item.dueAt ? t("create.dueDate", { date: new Date(item.dueAt * 1000).toLocaleDateString() }) : ""}
                          {item.termDays ? t("create.termDaysShort", { days: item.termDays }) : ""}
                          {item.trustTier ? t("create.tierSuffix", { tier: item.trustTier }) : ""}
                        </span>
                      )}
                    </span>
                  </span>
                  <span style={{
                    color: T.accent,
                    fontFamily: T.mono,
                    fontSize: 12,
                    fontWeight: 800,
                    whiteSpace: "nowrap" as const,
                  }}>
                    {formatMenuAmount(item, amountDisplayMode, {
                      currency: form.cur,
                      usdPerBtc: btcPrice.usd,
                      usdFiatRates: fiatRates.rates,
                    })}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div style={{
              fontSize: 14,
              fontWeight: 700,
              color: T.accent,
              fontFamily: T.mono,
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              flexWrap: "wrap",
            }}>
              {showFiatPrimary && estimatedSingleFiatAmount !== null ? (
                <>
                  <span>{formatFiatAmount(estimatedSingleFiatAmount, form.cur)}</span>
                  <span style={{ color: T.muted, fontWeight: 400 }}>
                    ₿ {fmtSats(previewSingleSats * 1000)}
                  </span>
                </>
              ) : (
                <>
                  <BitcoinAmount
                    sats={previewSingleSats}
                    size={14}
                    gap={4}
                    glyphScale={1.18}
                  />
                  {singleFiatAmount !== null && (
                    <span style={{ color: T.muted, marginLeft: 8, fontWeight: 400 }}>
                      {formatFiatAmount(singleFiatAmount, form.cur)}
                    </span>
                  )}
                </>
              )}
              {form.isSubscription && <span style={{ color: T.muted, fontWeight: 500 }}>{t("create.totalSuffix")}</span>}
            </div>
            {previewPremium && (
              <div style={{ marginTop: 6, color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 800 }}>
                {previewPremium}
                {previewPremiumCheckout ? ` · ${previewPremiumCheckout}` : ""}
              </div>
            )}
          </>
        )}
        {partialMenuRows && (
          <div style={{ marginTop: 8, fontSize: 10, color: T.amber, fontFamily: T.mono }}>
            {menuPartialMessage(vertical, "publishing")}
          </div>
          )}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={onBack} style={{
          flex: 1, padding: "14px",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
          color: T.text, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
          cursor: "pointer",
        }}>
          {t("create.backButton")}
        </button>
        <button onClick={onSaveDraft} style={{
          flex: 1, padding: "14px",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
          color: T.text, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
          cursor: "pointer",
        }}>
          {t("create.saveDraft")}
        </button>
        <button
          onClick={onPublish}
          disabled={!ready || submitting}
          style={{
            flex: 2, padding: "14px",
            background: ready && !submitting ? T.accent : T.surface,
            border: ready && !submitting ? "none" : `1px solid ${T.border}`,
            borderRadius: T.rs,
            color: ready && !submitting ? T.bg : T.muted,
            fontFamily: T.mono, fontSize: 14, fontWeight: 800,
            cursor: ready && !submitting ? "pointer" : "default",
            letterSpacing: 0.5,
          }}
        >
          {submitting ? t("create.publishing") : t("create.publishToCommunity")}
        </button>
      </div>
      {amountTooSmall && (
        <div style={{
          textAlign: "center", marginTop: 6, fontSize: 10,
          color: T.amber, fontFamily: T.mono, lineHeight: 1.45,
        }}>
          {minimumAtomicFundingMessage()}
        </div>
      )}
      {lendingCapExceeded && (
        <div style={{
          textAlign: "center", marginTop: 6, fontSize: 10,
          color: T.red, fontFamily: T.mono, lineHeight: 1.45,
        }}>
          {t("create.lendingCapBefore")}{" "}
          <BitcoinAmount
            sats={MAX_FEDIMINT_LENDING_SATS}
            size={10}
            gap={3}
            glyphScale={1.2}
            color="inherit"
            glyphColor="inherit"
          />{t("create.lendingCapAfterDot")}
        </div>
      )}
      <div style={{ textAlign: "center", marginTop: 6, fontSize: 10, color: T.muted, fontFamily: T.mono }}>
        {t("create.protocolFooter")}
      </div>
    </>
  );
}
