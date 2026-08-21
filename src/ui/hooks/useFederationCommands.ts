// ══════════════════════════════════════════════════════════════════════════
// useFederationCommands — community-tap + custom-invite-paste handlers
// ══════════════════════════════════════════════════════════════════════════
//
// The shell's two federation-mutating dispatchers, factored out of
// App.tsx so the orchestrator stays an orchestrator. Both handlers
// route through the same data-layer primitives (initFedimint /
// switchFederation), but each has its own routing/revert/error UX:
//
//   - handleSelectCommunity: a tap on a community pill. Decision logic
//     is the pure decideCommunityTapEffect; this dispatches the side
//     effects (setCommunity, switchFederation/initFedimint) and
//     handles failure-revert so a flaky federation can't strand the
//     user with no working client.
//
//   - handlePasteCustomInvite: BrowseView's first-time "advanced:
//     paste custom invite" affordance. Sandbox mode is the canonical
//     home for this; the inline affordance just makes it discoverable
//     for first-timers who'd otherwise be stuck on a federation that
//     doesn't have a registry community.
//
// The hook takes the shell's actions + state + setters and returns the
// two handlers. Pure plumbing — all decisions live in the pure helpers
// in src/ui/decisions.ts.

import { createElement, Fragment, type ReactNode } from "react";
import type { FedimintState, UseEscrowActions } from "../../hooks/useEscrow.js";
import { getCommunityBySlug, DEFAULT_COMMUNITY_SLUG } from "../../communities/registry.js";
import { getUserCommunitySlugRaw } from "../../communities/storage.js";
import { getActiveInvite } from "../../fedimint/index.js";
import { decideCommunityTapEffect } from "../decisions.js";

export interface FederationCommandsDeps {
  fedimint: FedimintState;
  actions: UseEscrowActions;
  /** V3 #72: live buyer/seller commitments — a manual switch is blocked
   *  while any are open (balance alone is blind during LOCKED). */
  activeCommitmentCount: number;
  /** A locked arbiter bond enables per-federation preserved storage, so an
   *  earnings balance is not a reason to force a Lightning withdrawal. */
  preservesFederationBalances?: boolean;
  setToast: (t: {
    message: ReactNode; type: "success" | "error" | "info"; sticky?: boolean;
  }) => void;
  setBrowseCommunity: (slug: string) => void;
  setPendingDestroyConfirm: (
    p: {
      invite: string;
      label: string;
      balanceMsats: number;
      activeInvite: string;
      restoreCommunitySlug?: string | null;
    } | null,
  ) => void;
}

export interface FederationCommands {
  handleSelectCommunity: (slug: string) => Promise<void>;
  handlePasteCustomInvite: (invite: string) => Promise<void>;
}

export function useFederationCommands(deps: FederationCommandsDeps): FederationCommands {
  const {
    fedimint, actions, activeCommitmentCount, preservesFederationBalances = false,
    setToast, setBrowseCommunity, setPendingDestroyConfirm,
  } = deps;

  const handleSelectCommunity: (slug: string) => Promise<void> = async (slug) => {
    // Capture previous state BEFORE any mutation so we can revert on
    // switch failure. We track the RAW community (null for first-timers)
    // separately from the resolution-flavored fallback — without that
    // distinction, the revert path would write the default Global USD
    // route to localStorage for a first-timer whose first switch failed,
    // permanently parking them on a community they never picked
    // (Bug A regression seen in v0.1.85 smoke testing).
    const previousInvite = getActiveInvite();
    const previousCommunityRaw = getUserCommunitySlugRaw();
    const previousCommunityName = previousCommunityRaw
      ? (getCommunityBySlug(previousCommunityRaw)?.displayName ?? previousCommunityRaw)
      : "your previous community";

    const effect = decideCommunityTapEffect({
      slug,
      currentInvite: previousInvite,
      balanceMsats: preservesFederationBalances ? 0 : (fedimint.balanceMsats ?? 0),
      activeCommitmentCount,
    });

    // V3 #72: live trades anchor the user to their current fed. Block BEFORE
    // any identity/filter mutation — a blocked tap must leave zero trace.
    if (effect.kind === "blocked-active-commitment") {
      const n = effect.activeCommitmentCount;
      setToast({
        message: n === 1
          ? "⚡ A live trade needs you on this Chama. Finish or resolve it, then switch."
          : `⚡ ${n} live trades need you on this Chama. Finish or resolve them, then switch.`,
        type: "error",
      });
      return;
    }

    // Every tap is an identity choice (v0.1.87: filter-only kind retired
    // along with the "All communities" pill). Update community + Browse
    // filter, and clear any earlier custom-invite override so future
    // resolutions honor the community's pinned invite.
    actions.setCommunity(effect.slug);
    setBrowseCommunity(effect.slug);
    actions.setCustomInvite("");

    if (effect.kind === "identity-only") return;

    if (effect.kind === "switch-silent") {
      try {
        setToast({ message: `Switching to ${effect.displayName}…`, type: "info" });
        if (fedimint.federationId) {
          await actions.switchFederation(effect.targetInvite, { persistCustom: false });
        } else {
          await actions.initFedimint(effect.targetInvite, { persistCustom: false });
        }
        setToast({ message: `On ${effect.displayName}.`, type: "success" });
      } catch (e: any) {
        if (e?.code === "RECONCILE_REFUSED_NONZERO_BALANCE"
          || e?.code === "SWITCH_REFUSED_NONZERO_BALANCE") {
          // Race: balance was zero at decision time, became non-zero
          // before the switch landed. Surface the modal anyway.
          setPendingDestroyConfirm({
            invite: effect.targetInvite,
            label: effect.displayName,
            balanceMsats: e.balanceMsats || 0,
            activeInvite: e.previousActiveInvite || previousInvite || "",
          });
          return;
        }

        // A REFUSED RUNTIME LEASE IS NOT A REACHABILITY PROBLEM. The
        // community is fine; this browser already has the wallet open
        // somewhere else — or a tab that never closed cleanly is still
        // holding the slot until the lease TTL expires. Reverting here is
        // what bounced a first-timer out of Browse and back to the picker
        // seconds after landing, under a message ("Couldn't reach X") that
        // sent them looking for a network fault that was never there.
        // Keep the pick, say what actually happened, and offer the takeover.
        if (e?.code === "FEDIMINT_RUNTIME_IN_OTHER_TAB") {
          console.warn("[chama] runtime lease refused for", effect.displayName, e);
          setToast({
            type: "error",
            sticky: true,
            message: createElement(
              Fragment,
              null,
              "Your wallet is open in another Chama tab. ",
              createElement(
                "button",
                {
                  type: "button",
                  onClick: () => {
                    void (async () => {
                      const { armBrowserRuntimeTakeover } = await import(
                        "../../fedimint/browser-runtime-lease.js"
                      );
                      armBrowserRuntimeTakeover();
                      await handleSelectCommunity(slug);
                    })();
                  },
                  style: {
                    background: "none", border: "none", padding: 0,
                    color: "inherit", font: "inherit", fontWeight: 800,
                    textDecoration: "underline", cursor: "pointer",
                  },
                },
                "Use it here",
              ),
            ),
          });
          return;
        }

        // Switch failed for a non-balance reason (iroh unreachable,
        // timeout, etc.). Revert identity AND attempt to re-join the
        // previous federation so we don't strand the user. If revert
        // also fails, surface a retry CTA — the FedimintBar Reconnect
        // button is the recovery path.
        //
        // For first-timers (previousCommunityRaw === null) we revert by
        // CLEARING the chama_community localStorage entry (so they
        // stay uncommitted) while reverting the visual filter to
        // DEFAULT_COMMUNITY_SLUG (the same default a fresh first-time
        // user sees). They land back in the same state they started in
        // and can try a different pill. v0.1.87 retired the "all" pill,
        // so the visual default is a real slug.
        console.warn("[chama] community-tap switch failed, reverting:", e);
        if (previousCommunityRaw) {
          actions.setCommunity(previousCommunityRaw);
          setBrowseCommunity(previousCommunityRaw);
        } else {
          actions.setCommunity("");
          setBrowseCommunity(DEFAULT_COMMUNITY_SLUG);
        }

        if (!previousInvite) {
          // First-time user with a failed init — nothing to revert to.
          setToast({
            message: `Couldn't reach ${effect.displayName}. Try another community.`,
            type: "error",
          });
          return;
        }
        try {
          await actions.switchFederation(previousInvite);
          setToast({
            message: `Couldn't reach ${effect.displayName}. Stayed on ${previousCommunityName}.`,
            type: "error",
          });
        } catch (revertErr: any) {
          console.error("[chama] revert also failed:", revertErr);
          // Both switch and revert failed — restore the previous invite
          // as the custom override so the FedimintBar Reconnect button
          // (which calls initFedimint() with no args) attempts the right
          // fed instead of falling through to the BP default.
          actions.setCustomInvite(previousInvite);
          setToast({
            message: `Couldn't reach ${effect.displayName}. Tap Reconnect in the Chama bar to retry ${previousCommunityName}.`,
            type: "error",
          });
        }
      }
      return;
    }

    // effect.kind === "destroy-confirm" — funds at risk, surface modal.
    setPendingDestroyConfirm({
      invite: effect.targetInvite,
      label: effect.displayName,
      balanceMsats: effect.balanceMsats,
      activeInvite: effect.currentInvite,
      restoreCommunitySlug: previousCommunityRaw,
    });
  };

  const handlePasteCustomInvite = async (invite: string) => {
    const trimmed = invite.trim();
    if (!trimmed.startsWith("fed1")) {
      setToast({ message: "Invite must start with fed1...", type: "error" });
      return;
    }
    try {
      actions.setCustomInvite(trimmed);
      setToast({ message: "Joining custom Chama...", type: "info" });
      if (fedimint.federationId) {
        await actions.switchFederation(trimmed);
      } else {
        await actions.initFedimint(trimmed);
      }
      setToast({ message: "Joined custom Chama!", type: "success" });
    } catch (e: any) {
      if (e?.code === "RECONCILE_REFUSED_NONZERO_BALANCE") {
        setPendingDestroyConfirm({
          invite: trimmed,
          label: `custom Chama (${trimmed.slice(4, 12)}…)`,
          balanceMsats: e.balanceMsats || 0,
          activeInvite: e.previousActiveInvite || "",
        });
      } else {
        setToast({ message: e?.message || "Join failed", type: "error" });
      }
    }
  };

  return { handleSelectCommunity, handlePasteCustomInvite };
}
