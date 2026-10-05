import { translate, getCurrentLang } from "../i18n/index.js";

/** A refusal is an action failure, never a malformed ciphertext or a reason to
 * create another wallet. Raw provider details belong only in the console. */
export class SignerApprovalError extends Error {
  readonly code = "SIGNER_APPROVAL_REJECTED";
  constructor(readonly action: "signIn" | "openTrade" | "sendMessage" | "wallet" | "action" | "listing" | "vote" | "lock" | "claim" | "cancel" | "profile" = "action") {
    super(["listing", "vote", "lock", "claim", "cancel", "profile"].includes(action)
      ? translate(getCurrentLang(), "signer.namedRefused", { action: translate(getCurrentLang(), `signer.${action}Action`) })
      : translate(getCurrentLang(), `signer.${action}Refused`));
    this.name = "SignerApprovalError";
  }
}
export function isSignerApprovalError(error: unknown): error is SignerApprovalError {
  return !!error && (error as any).code === "SIGNER_APPROVAL_REJECTED";
}
export async function signerAction<T>(action: SignerApprovalError["action"], run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { if (isSignerApprovalError(error)) throw new SignerApprovalError(action); throw error; }
}
