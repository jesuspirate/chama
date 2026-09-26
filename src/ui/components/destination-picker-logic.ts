// ══════════════════════════════════════════════════════════════════════════
// Chama — DestinationPicker pure logic (testable without a DOM)
// ══════════════════════════════════════════════════════════════════════════
//
// The DestinationPicker component (DestinationPicker.tsx) is the canonical
// "user provides a destination to receive sats" surface. Its render is a
// React shell, but its decision logic is here so the test suite can pin
// the contract without a DOM environment.
//
// Surfaces that consume the picker:
//   - Claim flow (item 2): user receives trade winnings
//   - Recovery banner (item 5): user sweeps stranded sats
//   - Destroy modal (item 6): user recovers sats before federation switch
//
// Three input tiers, in priority order:
//   Tier 1 — saved payout destination rows (one-tap)
//   Tier 2 — Lightning Address text input
//   Tier 3 — BOLT11 or NWC paste (under "More options")

import type { PayoutDestination } from "../../payments/payout-destinations.js";
import { isLightningAddress, isRawLnurl } from "../../payments/lnurl.js";
import { isNwcConnectionString } from "../../payments/nwc.js";
import { translate, getCurrentLang } from "../../i18n/index.js";

/** A saved payout destination row decorated with the "default" badge flag.
 *  The first entry (most-recent-used) is the default, rendered with a
 *  visual emphasis in the picker. */
export interface PickerPayoutDestination {
  destination: PayoutDestination;
  isDefault: boolean;
}

/** Sort + decorate saved payout destinations for the picker:
 *   - input is whatever listPayoutDestinations() returned (already
 *     sorted by lastUsedAt desc, but we re-sort defensively)
 *   - first entry gets isDefault: true; others false
 *   - empty list returns []
 *
 *  Stable in face of equal lastUsedAt — preserves input order for ties.
 *  No cap — per Q3, sort by most-recent-used and lean on the default
 *  badge to keep the list usable. */
export function decoratePayoutDestinationsForPicker(
  destinations: PayoutDestination[],
): PickerPayoutDestination[] {
  if (destinations.length === 0) return [];
  const sorted = [...destinations].sort((a, b) => {
    const aTime = a.lastUsedAt ?? a.createdAt;
    const bTime = b.lastUsedAt ?? b.createdAt;
    return bTime - aTime;
  });
  return sorted.map((destination, i) => ({ destination, isDefault: i === 0 }));
}

/** Synchronous classification of free-form input the user typed (or
 *  pasted) into the picker. Distinguishes Lightning Address from BOLT11
 *  invoice from invalid, so the UI can route to the right resolver path
 *  AND surface a useful error instantly without a network round-trip. */
export type InputClassification =
  | { kind: "lightning-address"; address: string }
  | { kind: "lnurl"; lnurl: string }
  | { kind: "bolt11"; bolt11: string }
  | { kind: "nwc"; connectionString: string }
  | { kind: "empty" }
  | { kind: "invalid"; reason: string };

/** Classify the user's free-form destination input. The picker's primary
 *  input field accepts Lightning Addresses; the "More options" expander
 *  has a separate BOLT11-only field. classifyDestinationInput is shape-
 *  detector — it doesn't care WHICH field the input came from, just
 *  reports what it looks like. The component decides whether to honor
 *  cross-tier matches (e.g. user pasted a BOLT11 into the LN-address
 *  field — the picker should accept and dispatch as bolt11). */
export function classifyDestinationInput(raw: string): InputClassification {
  if (typeof raw !== "string") {
    return { kind: "invalid", reason: translate(getCurrentLang(), "claim.errDestinationMustBeText") };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  const payment = /^lightning:/i.test(trimmed)
    ? trimmed.slice("lightning:".length).trim()
    : trimmed;
  if (isNwcConnectionString(payment)) {
    return { kind: "nwc", connectionString: payment };
  }
  if (isRawLnurl(payment)) {
    return { kind: "lnurl", lnurl: payment.toLowerCase() };
  }
  // BOLT11 starts with "ln" + bech32 hrp prefix (lnbc, lntb, lnbcrt, etc.)
  // The leading prefix is enough to disambiguate from an email-style
  // Lightning Address; full BOLT11 validation is the responsibility of
  // the Lightning sender downstream.
  if (/^ln(?!url)[a-z0-9]/i.test(payment) && !payment.includes("@")) {
    return { kind: "bolt11", bolt11: payment };
  }
  if (isLightningAddress(trimmed)) {
    return { kind: "lightning-address", address: trimmed.toLowerCase() };
  }
  return {
    kind: "invalid",
    reason: translate(getCurrentLang(), "claim.errEnterDestination"),
  };
}

/** Tier of action the picker is dispatching. Consumers of onResolve use
 *  this (indirectly, via `addressUsed` being set) to decide whether to
 *  call addOrTouchPayoutDestination for save/touch. */
export type DispatchTier =
  | "saved-row"          // Tier 1: tapped a saved row
  | "typed-address"      // Tier 2: typed an address into the picker
  | "pasted-bolt11"      // Tier 3: pasted a BOLT11 in More Options
  | "pasted-nwc";        // Tier 3/cross-tier: pasted a NWC connection

/** What the picker will pass to onResolve once the BOLT11 has been
 *  obtained (either resolved from an address or pasted directly).
 *  Pure data — does not include the BOLT11 itself, since for Tier 1/2
 *  that comes from the LNURL resolver (async) and the picker assembles
 *  the final shape just before calling onResolve. */
export interface DispatchDecision {
  tier: DispatchTier;
  /** Lightning Address that should be saved/touched on success. Set for
   *  Tier 1 (saved row tapped — bumps lastUsedAt) and Tier 2 (typed
   *  address — creates new entry on first use, bumps thereafter). Unset
   *  for Tier 3 (BOLT11 paste — no address to save). */
  addressUsed?: string;
  /** Whether the consumer should call addOrTouchPayoutDestination.
   *  - Tier 1: always true (touching a saved row bumps default badge).
   *  - Tier 2: true iff the "Save for next time" toggle is on.
   *  - Tier 3: always false. */
  saveAfter: boolean;
}

/** Decide what the picker will dispatch when the user commits. Pure
 *  logic — no side effects, no resolution. The component does the
 *  invoice/NWC resolution separately, then calls onResolve with the BOLT11
 *  plus the data this function returned.
 *
 *  Inputs:
 *   - tappedSavedDestination: the saved-row destination the user tapped
 *   - typedInput: classifyDestinationInput result for the LN-address field
 *   - bolt11PasteInput: classifyDestinationInput result for the BOLT11
 *     paste field (unset/empty if user is using Tier 1 or Tier 2)
 *   - saveToggleOn: state of the Tier 2 "Save for next time" toggle */
export type DispatchInputs = {
  tappedSavedDestination?: PayoutDestination | null;
  typedInput?: InputClassification;
  bolt11PasteInput?: InputClassification;
  saveToggleOn: boolean;
};

export type DispatchResult =
  | { ok: true; decision: DispatchDecision }
  | { ok: false; reason: string };

export function decideDispatch(inputs: DispatchInputs): DispatchResult {
  // Tier 1 wins: tapping a saved row is the strongest signal of intent.
  if (inputs.tappedSavedDestination) {
    return {
      ok: true,
      decision: {
        tier: "saved-row",
        addressUsed: inputs.tappedSavedDestination.address,
        saveAfter: true,
      },
    };
  }
  // Tier 3 next: an explicitly-pasted BOLT11 in More Options is also a
  // strong signal — the user expanded the disclosure. Note: we accept
  // BOLT11 from the typed field too (cross-tier paste tolerance), but
  // explicit Tier 3 takes priority when both fields have content.
  if (inputs.bolt11PasteInput?.kind === "bolt11") {
    return {
      ok: true,
      decision: {
        tier: "pasted-bolt11",
        saveAfter: false,
      },
    };
  }
  if (inputs.bolt11PasteInput?.kind === "nwc") {
    return {
      ok: true,
      decision: {
        tier: "pasted-nwc",
        saveAfter: false,
      },
    };
  }
  if (inputs.bolt11PasteInput?.kind === "lnurl") {
    return {
      ok: true,
      decision: { tier: "typed-address", addressUsed: inputs.bolt11PasteInput.lnurl, saveAfter: inputs.saveToggleOn },
    };
  }
  // Tier 2: typed input. Accept either kind detected.
  if (inputs.typedInput) {
    if (inputs.typedInput.kind === "lightning-address" || inputs.typedInput.kind === "lnurl") {
      return {
        ok: true,
        decision: {
          tier: "typed-address",
          addressUsed: inputs.typedInput.kind === "lnurl" ? inputs.typedInput.lnurl : inputs.typedInput.address,
          saveAfter: inputs.saveToggleOn,
        },
      };
    }
    if (inputs.typedInput.kind === "bolt11") {
      // User pasted a BOLT11 into the LN-address field. Accept it,
      // route as Tier 3 (no save — there's no address to save).
      return {
        ok: true,
        decision: {
          tier: "pasted-bolt11",
          saveAfter: false,
        },
      };
    }
    if (inputs.typedInput.kind === "nwc") {
      return {
        ok: true,
        decision: {
          tier: "pasted-nwc",
          saveAfter: false,
        },
      };
    }
    if (inputs.typedInput.kind === "invalid") {
      return { ok: false, reason: inputs.typedInput.reason };
    }
  }
  // Nothing usable.
  return { ok: false, reason: translate(getCurrentLang(), "claim.errChooseSavedOrEnter") };
}
