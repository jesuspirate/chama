// #43 writer: the funder's durable copy of the two shares a withheld-shares
// LOCK holds back, plus which of RELEASE or WITHDRAW this device chose.
//
// Written BEFORE the LOCK is published and read back to prove it persisted.
// If it cannot be saved the bridge writes today's all-shares LOCK instead, so
// a funder can never publish a LOCK it is unable to release. The choice of
// step is recorded before that step is signed, and never changes afterwards:
// one LOCK gets a RELEASE or a WITHDRAW from this device, never both.
//
// The plaintexts are kept after release or withdraw. They reveal nothing the
// funder does not already hold (the funder holds the whole notes until the
// trade ends), and keeping them means a crash between choosing and publishing
// can always finish the same step.

import {
  readStrictScopedStorageItem,
  setStrictScopedStorageItem,
} from "../storage/user-scope.js";

export const WITHHELD_SHARES_KEY = "chama_withheld_shares_v1";

export type WithheldStep = "release" | "withdraw";

export interface WithheldShareRecord {
  escrowId: string;
  notesHash: string;
  /** The two withheld shares, exactly as committed in the LOCK. */
  shares: { shareIndex: number; plaintext: string }[];
  /** Set once, before the chosen step is signed. */
  step?: WithheldStep;
  savedAt: number;
  /** When `step` was recorded. */
  settledAt?: number;
}

export interface WithheldShareStore {
  /** Persist and read back. False ⇒ not durable; do not withhold. */
  save(record: WithheldShareRecord): boolean;
  load(escrowId: string, notesHash: string): WithheldShareRecord | null;
  /** Record `step` for this LOCK. True when this step is (now, or already)
   *  the chosen one; false when the other step was chosen or it can't be saved. */
  choose(escrowId: string, notesHash: string, step: WithheldStep): boolean;
  /** These notes came back (withdraw or refusal): never release them from this
   *  device, even with no saved shares here. No effect once a release was chosen. */
  retire(escrowId: string, notesHash: string): boolean;
}

/** Finished releases older than this are dropped on the next save. */
const SETTLED_RECORD_TTL_MS = 60 * 24 * 60 * 60 * 1000;

const keyOf = (escrowId: string, notesHash: string) => `${escrowId}:${notesHash}`;

/** Shared logic over any string map with read-back. */
export function createWithheldShareStore(io: {
  read(): string | null;
  write(value: string): void;
}): WithheldShareStore {
  const loadAll = (): Record<string, WithheldShareRecord> | null => {
    try {
      const raw = io.read();
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch { return null; }
  };
  const writeAll = (all: Record<string, WithheldShareRecord>, check: (back: Record<string, WithheldShareRecord>) => boolean): boolean => {
    try {
      io.write(JSON.stringify(all));
      const back = loadAll();
      return !!back && check(back);
    } catch { return false; }
  };
  return {
    save(record) {
      const all = loadAll();
      if (!all) return false;
      const key = keyOf(record.escrowId, record.notesHash);
      // Never replace a saved split for these notes: a LOCK committing to it
      // may already be on a relay, and only that split can release it.
      if (all[key]) return JSON.stringify(all[key].shares) === JSON.stringify(record.shares) && !all[key].step;
      const now = Date.now();
      // Only finished releases are pruned. A "withdraw" record is the tombstone
      // that keeps notes that came back from ever being released here.
      for (const [k, r] of Object.entries(all)) {
        if (r.step === "release" && now - (r.settledAt ?? r.savedAt) > SETTLED_RECORD_TTL_MS) delete all[k];
        else if (r.step === "withdraw" && r.shares.length) all[k] = { ...r, shares: [] };
      }
      all[key] = { ...record, shares: record.shares.map(s => ({ ...s })), step: undefined };
      return writeAll(all, back => JSON.stringify(back[key]?.shares) === JSON.stringify(all[key].shares));
    },
    load(escrowId, notesHash) {
      const record = loadAll()?.[keyOf(escrowId, notesHash)];
      return record ? { ...record, shares: record.shares.map(s => ({ ...s })) } : null;
    },
    choose(escrowId, notesHash, step) {
      const all = loadAll();
      const key = keyOf(escrowId, notesHash);
      const record = all?.[key];
      if (!all || !record) return false;
      if (record.step) return record.step === step;
      all[key] = { ...record, step, settledAt: Date.now() };
      const ok = writeAll(all, back => back[key]?.step === step);
      if (!ok) console.warn(`[chama] #43 ${escrowId}: could not save the ${step} choice; trying again later`);
      return ok;
    },
    retire(escrowId, notesHash) {
      const all = loadAll();
      if (!all) return false;
      const key = keyOf(escrowId, notesHash);
      const record = all[key];
      if (record?.step) return record.step === "withdraw";
      all[key] = { escrowId, notesHash, shares: record?.shares ?? [], savedAt: record?.savedAt ?? Date.now(), step: "withdraw", settledAt: Date.now() };
      return writeAll(all, back => back[key]?.step === "withdraw");
    },
  };
}

/** The device store: the signed-in identity's own key, never a legacy one. */
export function defaultWithheldShareStore(): WithheldShareStore {
  return createWithheldShareStore({
    // Throws on a storage error (and with nobody signed in), so a read
    // failure is never mistaken for an empty store and overwritten.
    read: () => readStrictScopedStorageItem(WITHHELD_SHARES_KEY),
    write: value => setStrictScopedStorageItem(WITHHELD_SHARES_KEY, value),
  });
}

/** In-memory store for tests and for environments without storage. */
export function memoryWithheldShareStore(): WithheldShareStore {
  let value: string | null = null;
  return createWithheldShareStore({ read: () => value, write: next => { value = next; } });
}
