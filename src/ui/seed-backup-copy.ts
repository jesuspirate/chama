// ══════════════════════════════════════════════════════════════════════════
// Chama — the on-chain key backup refusal, in the reader's language
// ══════════════════════════════════════════════════════════════════════════
//
// useEscrow refuses an on-chain CREATE, JOIN or funding step with
// SEED_BACKUP_UNCONFIRMED (English message) when no relay confirms the
// backup its trade key comes from. Every screen shows `error.message`, so the
// refusal is re-thrown here with translated copy and the same code/problem.

import { SEED_BACKUP_UNCONFIRMED, type SeedBackupProblem } from "../fedimint/seed-manager.js";
import { translate, getCurrentLang, type Lang } from "../i18n/index.js";

export function seedBackupMessage(problem: SeedBackupProblem | undefined, lang: Lang = getCurrentLang()): string {
  return translate(lang, problem === "different-seed-on-relays"
    ? "onchain.seedBackupDifferent"
    : "onchain.seedBackupUnconfirmed");
}

/** The same error with translated copy; any other error passes through. */
export function localizeSeedBackupError(error: unknown, lang?: Lang): unknown {
  const e = error as { code?: unknown; problem?: SeedBackupProblem } | null;
  if (!e || e.code !== SEED_BACKUP_UNCONFIRMED) return error;
  const out = new Error(seedBackupMessage(e.problem, lang)) as Error & { code: string; problem?: SeedBackupProblem; cause?: unknown };
  out.code = SEED_BACKUP_UNCONFIRMED;
  out.problem = e.problem;
  out.cause = error;
  return out;
}

/** Wrap an async action so its refusal reaches the screen translated. */
export function withSeedBackupCopy<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try { return await fn(...args); }
    catch (error) { throw localizeSeedBackupError(error); }
  };
}
