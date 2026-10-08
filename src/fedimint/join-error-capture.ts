import { recordFundingDiagnostic } from "../payments/funding-diagnostics.js";

type ConsoleLogger = Pick<Console, "debug" | "info" | "warn" | "error">;

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


/** Error-reporting-only backport of .22's capture. No preview or wallet lifecycle decisions. */
export function createJoinErrorCapture(secrets: string[] = [], sink: ConsoleLogger = console) {
  let lastJoinError: string | null = null;
  let joinAttempt = 0;
  return {
    logger: {
      debug: (...args: unknown[]) => sink.debug(...args),
      info: (...args: unknown[]) => sink.info(...args),
      warn: (...args: unknown[]) => sink.warn(...args),
      error: (message: unknown, ...args: unknown[]) => {
        const label = joinErrorDetail(message, secrets);
        const detail = args.map(arg => joinErrorDetail(arg, secrets)).filter(Boolean).join("; ");
        if (label.includes("Error joining federation")) lastJoinError = detail || label;
        sink.error(label, detail);
      },
    },
    reset() { lastJoinError = null; joinAttempt++; },
    failure(fallback: string, cause?: unknown): Error {
      if (cause !== undefined) lastJoinError = joinErrorDetail(cause, secrets) || lastJoinError;
      const message = `${fallback}${lastJoinError ? `: ${lastJoinError}` : " (SDK supplied no error detail)"}`;
      recordFundingDiagnostic({ issue: "fedimint_join_failed", at: Date.now(), joinAttempt,
        sdkError: lastJoinError, error: message });
      return new Error(message);
    },
  };
}
export type JoinErrorCapture = ReturnType<typeof createJoinErrorCapture>;
