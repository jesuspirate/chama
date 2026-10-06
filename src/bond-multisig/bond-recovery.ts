import { bytesToHex } from '@noble/hashes/utils.js';
import * as btc from '@scure/btc-signer';
import { buildCommitmentBond, deriveBondSigningKey, validateBitcoinAddressForNetwork } from './commitment-bond.js';
import { reconstructBondRecord, type CommitmentRecord } from './commitment-store.js';
import type { ParsedBondAnnouncement, VerifiedBond } from './bond-announcement.js';
import type { BondUtxo, BtcNetwork } from './multisig.js';

export interface BondRecoveryIssue { address?: string; reason: string; code?: string }
export interface BondRecoveryReport { recovered: number; issues: BondRecoveryIssue[] }
export interface BondRecoveryDeps {
  network: BtcNetwork; seed: () => Promise<string[]>;
  readUtxos: (address: string) => Promise<BondUtxo[]>;
  save: (record: CommitmentRecord) => void;
}

/** Failed reads are reasons to retry, never proof that the owner has no bonds. */
export async function recoverOwnedBonds(announcements: readonly ParsedBondAnnouncement[], existing: readonly CommitmentRecord[], deps: BondRecoveryDeps): Promise<BondRecoveryReport> {
  const report: BondRecoveryReport = { recovered: 0, issues: [] };
  const have = new Set(existing.map(b => b.bond.address));
  const candidates = announcements.filter(a => !have.has(a.address));
  if (!candidates.length) return report;
  let words: string[];
  try { words = await deps.seed(); }
  catch (error) { report.issues.push({ reason: (error as Error).message, code: (error as { code?: string }).code }); return report; }
  for (const a of candidates) {
    try {
      const key = Uint8Array.from(a.ownerXonly.match(/../g)!.map(x => parseInt(x, 16)));
      const bond = buildCommitmentBond(key, a.lockUntil, deps.network);
      if (bond.address !== a.address) throw new Error('This bond address does not match its key, unlock block or Bitcoin network.');
      if (have.has(bond.address)) continue;
      const [bondUtxos, bondKeyUtxos] = await Promise.all([
        deps.readUtxos(bond.address), deps.readUtxos(btc.p2tr(key, undefined, deps.network).address!),
      ]);
      const record = reconstructBondRecord({ ownerXonlyHex: a.ownerXonly, lockUntil: a.lockUntil,
        claimedSats: a.claimedSats, announcedAddress: bond.address, seedWords: words.join(' '),
        network: deps.network, bondUtxos, bondKeyUtxos, maxIndex: 200, createdAt: a.createdAt });
      if (!record) throw Object.assign(new Error(bondUtxos.length || bondKeyUtxos.length
        ? 'The bond key was not found in this wallet seed (indices 0–200). Restore the original seed, then Retry.'
        : 'No confirmed funds were found at this bond or its return address. Retry after confirmation.'), { code: bondUtxos.length || bondKeyUtxos.length ? 'key-not-found' : 'funds-not-confirmed' });
      deps.save(record); have.add(record.bond.address); report.recovered++;
    } catch (error) { report.issues.push({ address: a.address, reason: (error as Error).message, code: (error as { code?: string }).code }); }
  }
  return report;
}

/** Explicit, one-time lookup for a bond whose old announcement was replaced. */
export async function findOwnedBond(address: string, lockUntil: number, existing: readonly CommitmentRecord[], deps: BondRecoveryDeps, maxIndex = 200): Promise<CommitmentRecord> {
  if (!validateBitcoinAddressForNetwork(address.trim(), deps.network).ok) throw new Error('Enter a valid bond address for this Bitcoin network.');
  const found = existing.find(b => b.bond.address === address.trim());
  if (found) { if (found.bond.lockUntil !== lockUntil) throw new Error('The unlock block does not match this bond.'); return found; }
  if (!Number.isSafeInteger(lockUntil) || lockUntil <= 0 || lockUntil >= 500_000_000) throw new Error('Enter the bond’s unlock block.');
  const words = (await deps.seed()).join(' ');
  for (let index = 0; index <= maxIndex; index++) {
    const key = deriveBondSigningKey(words, { network: deps.network, index });
    const bond = buildCommitmentBond(key.xonly, lockUntil, deps.network);
    if (bond.address !== address.trim()) continue;
    const [bondUtxos, bondKeyUtxos] = await Promise.all([
      deps.readUtxos(bond.address), deps.readUtxos(btc.p2tr(key.xonly, undefined, deps.network).address!),
    ]);
    const record = reconstructBondRecord({ ownerXonlyHex: bytesToHex(key.xonly), lockUntil,
      claimedSats: 0n, announcedAddress: bond.address, seedWords: words, network: deps.network,
      bondUtxos, bondKeyUtxos, maxIndex });
    if (!record) throw Object.assign(new Error('This address belongs to your seed, but no confirmed funds were found. Retry after confirmation.'), { code: 'funds-not-confirmed' });
    deps.save(record); return record;
  }
  throw Object.assign(new Error(`This address and unlock block were not found in your wallet seed (indices 0–${maxIndex}). Check them or restore the original seed, then Retry.`), { code: 'key-not-found' });
}

export interface ManageBond { address: string; local?: CommitmentRecord; announced?: VerifiedBond }
export function mergeManageBonds(local: readonly CommitmentRecord[], verified: readonly VerifiedBond[]): ManageBond[] {
  const rows = new Map<string, ManageBond>();
  for (const rec of local) if (!rows.has(rec.bond.address)) rows.set(rec.bond.address, { address: rec.bond.address, local: rec });
  for (const bond of verified) {
    const row = rows.get(bond.address) ?? { address: bond.address };
    // Never hide an expired or withdrawn but verified announcement from Manage.
    rows.set(bond.address, { ...row, announced: bond });
  }
  return [...rows.values()];
}
