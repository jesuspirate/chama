#!/usr/bin/env npx tsx
/** Test coins only. Uses the shipping tree, reducer, strict deposit reader,
 * signing-key selection and PSBT checklist. Never selects the mainnet network.
 * Commands: init | status | run coop|dispute|refund|attack | early-refund.
 * Seed/descriptor persist before any address is printed. Re-running is safe. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as btc from '@scure/btc-signer';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { safetyFixture } from './lib/escrow-safety-fixture.js';
import { SIGNET } from '../src/bond-multisig/multisig.js';
import { deriveEscrowSigningKey, deriveCommittedBondKey, findEscrowFundingUtxos } from '../src/bond-multisig/onchain-escrow-funding.js';
import { deriveBondSigningKey } from '../src/bond-multisig/commitment-bond.js';
import { buildOnchainEscrow } from '../src/bond-multisig/onchain-escrow.js';
import { buildSettlementPsbt, coSignSettlement, finalizeSettlement, verifySettlementPsbt } from '../src/bond-multisig/onchain-escrow-settle.js';
import { hasValidSettlementSignatureForRole } from '../src/escrow-engine/onchain-settlement-transport.js';
import { applyEvent } from '../src/escrow-engine/state-machine.js';
import { EscrowEventKind as Kind, Role } from '../src/escrow-engine/types.js';

const API = process.env.MUTINYNET_API ?? 'https://mutinynet.com/api';
const directory = path.dirname(fileURLToPath(import.meta.url));
const run = process.env.MUTINYNET_ESCROW_RUN ?? 'default';
if (!/^[a-z0-9-]+$/.test(run)) throw new Error('Run name must contain lowercase letters, digits or hyphens');
// Keep the original default filenames so an existing test run never changes keys.
const suffix = run === 'default' ? '' : `-${run}`;
const keyfile = path.join(directory, `.mutinynet-escrow-keys${suffix}.json`);
const journalFile = path.join(directory, `.mutinynet-escrow-results${suffix}.json`);
const cases = ['coop', 'dispute', 'refund', 'attack'] as const;
type Case = typeof cases[number];
type Keys = { buyer: string; seller: string; arbiter: string; refundHeight: number; createdTip: number };
type Result = { fundingTxids: string[]; address: string; psbt?: string; rawTx?: string; txid?: string; rejected?: boolean; confirmed?: boolean };
async function request(p: string, init?: RequestInit) {
  const response = await fetch(`${API}${p}`, { ...init, signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${body}`);
  return body;
}
const fetchJson = async (p: string) => JSON.parse(await request(p));
const tip = async () => Number(await request('/blocks/tip/height'));
const [command = 'status', name] = process.argv.slice(2);
if (!['init', 'status', 'run', 'early-refund'].includes(command)) throw new Error('Use init | status | run coop|dispute|refund|attack | early-refund');
if (command === 'run' && !cases.includes(name as Case)) throw new Error('Choose coop, dispute, refund or attack');
let keys: Keys;
if (fs.existsSync(keyfile)) keys = JSON.parse(fs.readFileSync(keyfile, 'utf8'));
else {
  if (command !== 'init') throw new Error('Run init first; existing keys are never silently replaced');
  const height = await tip();
  keys = { buyer: generateMnemonic(wordlist), seller: generateMnemonic(wordlist), arbiter: generateMnemonic(wordlist),
    createdTip: height, refundHeight: height + 20 };
  fs.writeFileSync(keyfile, JSON.stringify(keys), { mode: 0o600, flag: 'wx' });
}
const results: Partial<Record<Case, Result>> = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : {};
const save = () => fs.writeFileSync(journalFile, JSON.stringify(results, null, 2), { mode: 0o600 });
const currentTip = await tip();
console.log(`Mutinynet tip ${currentTip}; refund height ${keys.refundHeight}; DISPUTE requires 144 confirmations. Test coins only.`);
for (const which of cases) {
  if ((command === 'run' && which !== name) || (command === 'early-refund' && which !== 'refund')) continue;
  const id = `mutinynet-649-${which}`;
  const buyer = deriveEscrowSigningKey(keys.buyer, id, { network: SIGNET });
  const seller = deriveEscrowSigningKey(keys.seller, id, { network: SIGNET });
  const arbiter = deriveBondSigningKey(keys.arbiter, { network: SIGNET, index: 7 });
  const secondSeller = deriveEscrowSigningKey(keys.seller, `${id}-attack`, { network: SIGNET });
  const fixture = safetyFixture({ buyer: buyer.xonly, seller: seller.xonly, arbiter: arbiter.xonly }, keys.refundHeight, id);
  fixture.apply(fixture.event(Kind.JOIN, 'seller', { type: 'escrow:join', role: Role.SELLER,
    joinedAt: Math.floor(Date.now() / 1000), fundingTerms: fixture.terms }));
  const escrow = which === 'attack' ? buildOnchainEscrow({ ...fixture.escrow.params, buyerXonly: secondSeller.xonly }) : fixture.escrow;
  console.log(`${which}: ${escrow.address}`);
  if (command === 'init') continue;
  if (results[which]?.txid) {
    let status;
    try { status = await fetchJson(`/tx/${results[which]!.txid}/status`); }
    catch (error) {
      if (command !== 'run' || !String(error).includes('404:') || !results[which]!.rawTx) throw error;
      // A prior attempt may have failed after journaling but before broadcast.
      // Retry the identical transaction; never generate new keys or terms.
      await request('/tx', { method: 'POST', body: results[which]!.rawTx });
      status = await fetchJson(`/tx/${results[which]!.txid}/status`);
    }
    results[which]!.confirmed = status.confirmed === true; save();
    console.log(`${which}: settlement ${results[which]!.txid}, confirmed=${status.confirmed}`);
    continue;
  }
  const found = await findEscrowFundingUtxos({ address: escrow.address, network: SIGNET, fetchJson, minConfs: 1 });
  const utxos = found.map(f => f.utxo);
  console.log(`${which}: ${utxos.reduce((sum, u) => sum + u.amountSats, 0n)} confirmed sats`);
  if (command === 'status') continue;
  if (utxos.reduce((sum, u) => sum + u.amountSats, 0n) < 100000n) throw new Error(`Fund ${which} with at least 100,000 test sats at https://faucet.mutinynet.com/ and retry after confirmation`);
  results[which] = { address: escrow.address, fundingTxids: [...new Set(utxos.map(u => u.txid))] };
  save();
  if (which === 'attack') {
    const event = fixture.event(Kind.LOCK, 'seller', { type: 'escrow:lock', notesHash: '', shares: [],
      buyerPubkey: fixture.pks.buyer, arbiterPubkey: fixture.pks.arbiter, sellerReceivesMsats: 100000000, arbiterFeeMsats: 0,
      lockedAt: Math.floor(Date.now() / 1000), onchain: { ...fixture.terms,
        address: escrow.address, buyerXonly: bytesToHex(secondSeller.xonly), fundingTxid: utxos[0].txid,
        fundingVout: utxos[0].index, amountSats: utxos.reduce((s, u) => s + u.amountSats, 0n).toString() } });
    if (applyEvent(fixture.state, event).ok) throw new Error('SECURITY FAILURE: malicious funded LOCK accepted');
    results.attack!.rejected = true; save();
    console.log('Malicious LOCK rejected against a real confirmed deposit. Recovering test coins with attacker-owned keys.');
  }
  const leaf = which === 'attack' ? 'coop' : which;
  const destination = btc.p2tr(which === 'refund' ? seller.xonly : buyer.xonly, undefined, SIGNET).address!;
  const estimates = await fetchJson('/fee-estimates');
  const rate = Number(estimates['6'] ?? estimates['1']);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Live fee estimate unavailable; retry');
  const feeSats = BigInt(Math.ceil((200 + Math.max(0, utxos.length - 1) * 150) * rate));
  const expectation = { escrow, utxos, destination, maxFeeSats: feeSats, leaf,
    tipHeight: command === 'early-refund' ? keys.refundHeight : currentTip, network: SIGNET };
  const psbt = buildSettlementPsbt({ ...expectation, feeSats,
    fundingHeight: Math.max(...found.map(f => f.blockHeight!)),
    ...(leaf === 'refund' ? { lockTime: keys.refundHeight } : {}) });
  const check = verifySettlementPsbt(psbt, expectation);
  if (!check.ok) throw new Error(check.failures.join('; '));
  const autoArbiter = deriveCommittedBondKey(keys.arbiter, bytesToHex(arbiter.xonly), [{ bondId: 'test',
    bond: fixture.bond, keyIndex: 7, amountSats: 100000n, phase: 'locked', createdAt: 1 }], SIGNET);
  const signers = which === 'attack' ? [secondSeller.priv, seller.priv] : leaf === 'coop' ? [buyer.priv, seller.priv]
    : leaf === 'dispute' ? [buyer.priv, autoArbiter.priv] : [seller.priv];
  const signed = signers.reduce((p, key) => coSignSettlement(p, key), psbt);
  if (leaf === 'dispute' && !hasValidSettlementSignatureForRole(signed, escrow, Role.ARBITER, 'dispute')) throw new Error('Auto-arbiter signature missing');
  const rawTx = finalizeSettlement([signed], { escrow, leaf });
  if (command === 'early-refund') {
    if (currentTip >= keys.refundHeight) throw new Error('Refund already mature; early rejection must be tested with a fresh fixture');
    try { await request('/tx', { method: 'POST', body: rawTx }); }
    catch (error) {
      if (!/non-final|non-BIP68-final|Locktime requirement/i.test(String(error))) throw error;
      console.log(`Consensus rejected the early refund: ${error}`); process.exit(0);
    }
    throw new Error('SECURITY FAILURE: early refund was accepted');
  }
  results[which] = { ...results[which]!, psbt: signed, rawTx,
    txid: btc.Transaction.fromRaw(Buffer.from(rawTx, 'hex'), { allowUnknown: true, allowUnknownOutputs: true }).id };
  save(); // retain exact bytes/txid through broadcast or network failures
  const broadcastId = await request('/tx', { method: 'POST', body: rawTx });
  if (broadcastId.trim() !== results[which]!.txid) throw new Error('Broadcast returned a different transaction id');
  console.log(`${which}: broadcast ${broadcastId}`);
}
if (command === 'init') console.log('Fund each address with at least 100,000 TEST sats using https://faucet.mutinynet.com/. Keep the key file; never use it for mainnet.');
