// ══════════════════════════════════════════════════════════════════════════
// Chama — Federation Configuration
// ══════════════════════════════════════════════════════════════════════════
//
// Default Fedimint federation for new users. Advanced users can override
// this at runtime by pasting a custom invite code in the federation
// onboarding screen.
//
// If you don't already have a Fedimint wallet, the easiest way to manage
// your ecash balance on mobile is the Fedi app: https://www.fedi.xyz/

/**
 * Bitcoin Life Federation — the default community federation for Chama.
 * Beginner users join this federation automatically on first launch.
 */
export const DEFAULT_FEDERATION_NAME = "Bitcoin Life Federation";

export const DEFAULT_FEDERATION_INVITE =
  "fed11qgqyj3mfwfhksw309ajrwvmxvenxgvpkvyursenxxvur2c3sv4jkxdfcxf3kgdmyvs6nzcehvc6xzctzxumrxdmr89jnwdtpv5enqwtpxqmrsvfh89skxv34qqqjpzytwrkr28r8mjas4ej467utd7excr7fapj7ukgc4ugacm6nu2u73k7ram";

/**
 * localStorage key for a user-supplied custom invite code.
 * If present, takes precedence over DEFAULT_FEDERATION_INVITE.
 */
export const CUSTOM_INVITE_STORAGE_KEY = "chama_federation_invite";

/**
 * Resolve the federation invite code to use at runtime.
 * Custom user invite wins, otherwise fall back to the BLF default.
 */
export function getFederationInvite(): string {
  try {
    if (typeof localStorage !== "undefined") {
      const custom = localStorage.getItem(CUSTOM_INVITE_STORAGE_KEY);
      if (custom && custom.trim().startsWith("fed1")) {
        return custom.trim();
      }
    }
  } catch {
    // localStorage unavailable (SSR, etc.) — fall through to default
  }
  return DEFAULT_FEDERATION_INVITE;
}

/**
 * Save a custom federation invite code. Pass empty string to clear
 * and revert to the default.
 */
export function setCustomFederationInvite(inviteCode: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const trimmed = inviteCode.trim();
    if (!trimmed) {
      localStorage.removeItem(CUSTOM_INVITE_STORAGE_KEY);
      return;
    }
    if (!trimmed.startsWith("fed1")) {
      throw new Error("Invite code must start with 'fed1'");
    }
    localStorage.setItem(CUSTOM_INVITE_STORAGE_KEY, trimmed);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Whether the user is currently overriding the default federation */
export function hasCustomFederation(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return !!localStorage.getItem(CUSTOM_INVITE_STORAGE_KEY);
  } catch {
    return false;
  }
}
