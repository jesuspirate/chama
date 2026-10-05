import { recordFundingDiagnostic } from "../payments/funding-diagnostics.js";

type ConsoleLogger = Pick<Console, "debug" | "info" | "warn" | "error">;
export interface JoinPreviewDirector {
  parseInviteCode(invite: string): Promise<{ url: string; federation_id?: string }>;
  previewFederation(invite: string): Promise<unknown>;
}

/** Retain error fields, never arbitrary SDK response/config/credential objects. */
export function joinErrorDetail(value: unknown, secrets: string[] = [], depth = 0): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (value && typeof value === "object" && depth < 3) {
    const error = value as Record<string, unknown>;
    text = ["name", "message", "error", "reason", "code", "cause"]
      .map(key => joinErrorDetail(error[key], secrets, depth + 1)).filter(Boolean).join(": ");
  } else if (typeof value === "number") text = String(value);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[redacted]");
  return text
    .replace(/\b(?:fed1|nsec1|cashu[AB]|lnbc|lntb|lnbcrt)[a-zA-Z0-9]+/g, "[redacted token]")
    .replace(/\b[a-fA-F0-9]{64,}\b/g, "[redacted hex]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|secret|password|auth|key)=)[^\s&#]+/gi, "$1[redacted]")
    .slice(0, 2000);
}

function endpoint(value: string): string {
  try { const url = new URL(value); return `${url.protocol}//${url.host}`; }
  catch { return "unknown endpoint"; }
}

/** Instance-local capture: a retry cannot inherit another attempt's error. */
export function createJoinDiagnostics(secrets: string[] = [], sink: ConsoleLogger = console) {
  let lastJoinError: string | null = null;
  let openState: "not-attempted" | "opening" | "opened" | "failed" = "not-attempted";
  let openError: string | null = null;
  let joinAttempt = 0;
  const recordLifecycle = (phase: string, fields: Record<string, unknown> = {}) => {
    const entry = { issue: "fedimint_wallet_lifecycle", at: Date.now(), phase, openState, openError, joinAttempt, ...fields };
    recordFundingDiagnostic(entry);
    sink.info("[chama] Fedimint wallet lifecycle", entry);
  };
  const logger: ConsoleLogger = {
    debug: (...args) => sink.debug(...args),
    info: (...args) => sink.info(...args),
    warn: (...args) => sink.warn(...args),
    error: (message: unknown, ...args: unknown[]) => {
      const label = joinErrorDetail(message, secrets);
      const detail = args.map(arg => joinErrorDetail(arg, secrets)).filter(Boolean).join("; ");
      if (label.includes("Error joining federation")) lastJoinError = detail || label;
      // Keep the device console useful without serializing wallet state.
      sink.error(label, detail);
    },
  };
  return {
    logger,
    reset() { lastJoinError = null; joinAttempt++; },
    opening() { openState = "opening"; openError = null; recordLifecycle("open_client"); },
    opened(isOpen: boolean) { openState = "opened"; recordLifecycle("open_client_result", { isOpen }); },
    openFailed(cause: unknown) {
      openState = "failed";
      openError = joinErrorDetail(cause, secrets) || "SDK supplied no error detail";
      recordLifecycle("open_client_failed");
    },
    joining(isOpen: boolean, forceRecover: boolean) { recordLifecycle("join_federation", { isOpen, forceRecover }); },
    joined() { recordLifecycle("join_federation_succeeded"); },
    failure(fallback: string, preview?: { error?: string }, cause?: unknown): Error {
      // The SDK's already-open guard throws outside its catch/logger block.
      // Preserve that rejection too, without changing the join decision.
      if (cause !== undefined) lastJoinError = joinErrorDetail(cause, secrets) || lastJoinError;
      const message = `${fallback}${lastJoinError ? `: ${lastJoinError}` : " (SDK supplied no error detail)"}`
        + (preview?.error ? `. Federation preview: ${preview.error}` : "");
      recordFundingDiagnostic({ issue: "fedimint_join_failed", at: Date.now(),
        sdkError: lastJoinError, previewError: preview?.error ?? null, openState, openError, joinAttempt, error: message });
      return new Error(message);
    },
    async preview(director: JoinPreviewDirector, invite: string, timeoutMs = 5000): Promise<{ error?: string }> {
      let guardian = "invite endpoint";
      let stage = "parse_invite_code";
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            const parsed = await director.parseInviteCode(invite);
            if (finished) return; // a late parse must not start a new probe
            guardian = endpoint(parsed.url);
            stage = "preview_federation";
            await director.previewFederation(invite);
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${stage} timed out after ${timeoutMs} ms`)), timeoutMs);
          }),
        ]);
        recordFundingDiagnostic({ issue: "fedimint_join_preview", at: Date.now(), guardian, outcome: "ok" });
        return {};
      } catch (cause) {
        const detail = joinErrorDetail(cause, secrets) || "No error detail";
        const error = stage === "parse_invite_code"
          ? `Could not parse the federation invite: ${detail}`
          : `Could not fetch the federation configuration via ${guardian}: ${detail}`;
        recordFundingDiagnostic({ issue: "fedimint_join_preview", at: Date.now(), guardian, stage, error });
        // Diagnostic only: preview failure is NOT permission to change wallets,
        // and must not prevent a join that would otherwise succeed.
        return { error };
      } finally { finished = true; clearTimeout(timer); }
    },
  };
}

export type JoinDiagnostics = ReturnType<typeof createJoinDiagnostics>;
