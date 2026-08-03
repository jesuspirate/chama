import { base64 } from "@scure/base";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as btc from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Role, type OnchainLockTerms, type ParsedEscrowEvent, type SettlementPayload } from "./types.js";
import { finalizeSettlement, verifySettlementPsbt, type SettlementExpectation } from "../bond-multisig/onchain-escrow-settle.js";
import { buildOnchainEscrow, LEAF_SPEND_VSIZE, type OnchainEscrow } from "../bond-multisig/onchain-escrow.js";
import { MAINNET, SIGNET } from "../bond-multisig/multisig.js";

/** Unsigned transaction identity: partial signatures never change it. */
export function settlementUnsignedId(psbt: string): string {
  return btc.Transaction.fromPSBT(base64.decode(psbt), {
    allowUnknown: true, allowUnknownOutputs: true,
  }).id;
}

/** Newest VERIFIED cooperative revision. Invalid wire traffic is ignored,
 *  never allowed to mask an earlier valid revision and freeze settlement. */
export function selectVerifiedCoopSettlement(
  messages: readonly ParsedEscrowEvent<SettlementPayload>[],
  expectation: SettlementExpectation,
): string | null {
  const seen = new Set<string>();
  for (const message of [...messages].reverse()) {
    if (message.payload.leaf !== "coop") continue;
    try {
      const id = settlementUnsignedId(message.payload.psbt);
      if (seen.has(id)) continue;
      seen.add(id);
      if (verifySettlementPsbt(message.payload.psbt, expectation).ok) {
        return message.payload.psbt;
      }
    } catch { /* malformed PSBT: fail closed and continue to older candidates */ }
  }
  return null;
}

/** All verified revisions for the newest valid cooperative transaction.
 *  Separate one-signature revisions are deliberately retained: two parties
 *  may sign the same unsigned transaction concurrently, and PSBTCombine is
 *  what makes those races converge. */
export function verifiedCoopSettlementGroup(
  messages: readonly ParsedEscrowEvent<SettlementPayload>[],
  expectation: SettlementExpectation,
): string[] {
  let selectedId: string | null = null;
  const revisions: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.payload.leaf !== "coop") continue;
    try {
      if (!verifySettlementPsbt(message.payload.psbt, expectation).ok) continue;
      const id = settlementUnsignedId(message.payload.psbt);
      if (selectedId === null) selectedId = id;
      if (id === selectedId) revisions.push(message.payload.psbt);
    } catch { /* malformed PSBT: fail closed and continue */ }
  }
  return revisions;
}

export function selectVerifiedArbiterSettlement(
  messages: readonly ParsedEscrowEvent<SettlementPayload>[],
  expectation: SettlementExpectation,
): string | null {
  for (const message of [...messages].reverse()) {
    if (message.payload.leaf !== "arbiter") continue;
    try {
      if (verifySettlementPsbt(message.payload.psbt, expectation).ok) return message.payload.psbt;
    } catch { /* malformed PSBT: fail closed and continue */ }
  }
  return null;
}

function verifiedSettlementGroup(
  messages: readonly ParsedEscrowEvent<SettlementPayload>[],
  expectation: SettlementExpectation,
  leaf: "coop" | "arbiter",
): string[] {
  let selectedId: string | null = null;
  const revisions: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.payload.leaf !== leaf) continue;
    try {
      if (!verifySettlementPsbt(message.payload.psbt, expectation).ok) continue;
      const id = settlementUnsignedId(message.payload.psbt);
      if (selectedId === null) selectedId = id;
      if (id === selectedId) revisions.push(message.payload.psbt);
    } catch { /* fail closed */ }
  }
  return revisions;
}

/** True only when every input carries a cryptographically valid signature for
 *  the requested committed role on the requested leaf. Metadata alone never
 *  disables another signer—the exact Taproot sighash is verified. */
export function hasValidSettlementSignatureForRole(
  psbt: string,
  escrow: OnchainEscrow,
  role: Role.BUYER | Role.SELLER | Role.ARBITER,
  leafName: "coop" | "dispute",
): boolean {
  try {
    const tx = btc.Transaction.fromPSBT(base64.decode(psbt), {
      allowUnknown: true, allowUnknownOutputs: true,
    });
    const prevouts = Array.from({ length: tx.inputsLength }, (_, index) => tx.getInput(index).witnessUtxo);
    if (prevouts.some(output => !output)) return false;
    const scripts = prevouts.map(output => output!.script);
    const amounts = prevouts.map(output => output!.amount);
    const pubkey = role === Role.BUYER ? escrow.params.buyerXonly
      : role === Role.SELLER ? escrow.params.sellerXonly
        : escrow.params.arbiterXonly;
    const leaf = escrow.leaves[leafName];
    const leafHash = tapLeafHash(leaf);
    for (let index = 0; index < tx.inputsLength; index++) {
      const entries = tx.getInput(index).tapScriptSig ?? [];
      const message = tx.preimageWitnessV1(
        index, scripts, 0, amounts, undefined, leaf, 0xc0,
      );
      const entry = entries.find(([meta, signature]) =>
        bytesToHex(meta.pubKey) === bytesToHex(pubkey)
        && bytesToHex(meta.leafHash) === bytesToHex(leafHash)
        && signature.length === 64);
      if (!entry || !schnorr.verify(entry[1], message, pubkey)) return false;
    }
    return true;
  } catch { return false; }
}

function hasValidDisputeSignatures(
  psbt: string,
  escrow: OnchainEscrow,
  winnerRole: Role.BUYER | Role.SELLER,
): boolean {
  return hasValidSettlementSignatureForRole(psbt, escrow, winnerRole, "dispute")
    && hasValidSettlementSignatureForRole(psbt, escrow, Role.ARBITER, "dispute");
}

/** Merge partial signatures without finalizing. The combined PSBT is safe to
 *  transport with final=true only after finalizeSettlement also succeeds. */
export function combineSettlementPsbts(psbts: readonly string[]): string {
  if (psbts.length === 0) throw new Error("No settlement PSBTs to combine");
  return base64.encode(btc.PSBTCombine(psbts.map(psbt => base64.decode(psbt))));
}

/** Adopt only a complete, coherent sweep. A partial or mixed spend is not the
 *  settlement transaction S7 built and must never be waved through as done. */
export function adoptedSettlementTxid(
  outspends: readonly { spent: boolean; txid?: string }[],
): string | null {
  if (outspends.length === 0 || outspends.some(out => !out.spent || !out.txid)) return null;
  const txid = outspends[0].txid!;
  return outspends.every(out => out.txid === txid) ? txid : null;
}

/** Recovery is not "some spend happened". It is adoption of the exact txid
 *  authorized by the final settlement journal, across every expected input. */
export function adoptedExpectedSettlementTxid(
  expectedTxid: string,
  outspends: readonly { spent: boolean; txid?: string }[],
): string | null {
  const observed = adoptedSettlementTxid(outspends);
  return observed === expectedTxid ? observed : null;
}

/** Find a broadcastable cooperative revision without letting one poisoned
 *  partial signature contaminate every other candidate. Singles are tried
 *  first, then pairs; a 2-of-2 leaf never needs more than two independent
 *  revisions to reach threshold. */
export function finalizableCoopSettlement(
  messages: readonly ParsedEscrowEvent<SettlementPayload>[],
  expectation: SettlementExpectation,
): { psbt: string; rawTx: string } | null {
  const group = verifiedCoopSettlementGroup(messages, expectation);
  const attempts: string[][] = group.map(psbt => [psbt]);
  for (let a = 0; a < group.length; a++) {
    for (let b = a + 1; b < group.length; b++) attempts.push([group[a], group[b]]);
  }
  for (const attempt of attempts) {
    try {
      const psbt = combineSettlementPsbts(attempt);
      return { psbt, rawTx: finalizeSettlement([psbt]) };
    } catch { /* below threshold or incompatible/poisoned revision */ }
  }
  return null;
}

export function finalizableArbiterSettlement(
  messages: readonly ParsedEscrowEvent<SettlementPayload>[],
  expectation: SettlementExpectation,
  escrow: OnchainEscrow,
  winnerRole: Role.BUYER | Role.SELLER,
): { psbt: string; rawTx: string } | null {
  const group = verifiedSettlementGroup(
    messages.filter(message => message.payload.role === winnerRole || message.payload.role === Role.ARBITER),
    expectation, "arbiter",
  );
  const attempts: string[][] = group.map(psbt => [psbt]);
  for (let a = 0; a < group.length; a++) {
    for (let b = a + 1; b < group.length; b++) attempts.push([group[a], group[b]]);
  }
  for (const attempt of attempts) {
    try {
      const psbt = combineSettlementPsbts(attempt);
      if (!hasValidDisputeSignatures(psbt, escrow, winnerRole)) {
        throw new Error("Dispute settlement requires valid winner and arbiter signatures");
      }
      return { psbt, rawTx: finalizeSettlement([psbt], { escrow, leaf: "dispute" }) };
    } catch { /* below threshold or poisoned */ }
  }
  return null;
}

/** Replay-verifiable authorization carried by a final cooperative journal.
 *  This does not claim the transaction was mined; it proves both keys committed
 *  in the escrow cooperatively signed the exact escrow-script spend to the
 *  resolved winner. COMPLETE links to this event id separately. */
export function finalCoopSettlementProof(
  message: ParsedEscrowEvent<SettlementPayload>,
  terms: OnchainLockTerms,
  winnerRole: Role.BUYER | Role.SELLER,
): { txid: string; inputs: Array<{ txid: string; index: number }> } | null {
  if (!message.payload.final || message.payload.leaf !== "coop") return null;
  try {
    const network = terms.network === "mainnet" ? MAINNET : SIGNET;
    const escrow = buildOnchainEscrow({
      buyerXonly: hexToBytes(terms.buyerXonly),
      sellerXonly: hexToBytes(terms.sellerXonly),
      arbiterXonly: hexToBytes(terms.arbiterXonly),
      funder: terms.funder,
      refundLockUntil: terms.refundLockUntil,
      disputeCsvBlocks: terms.disputeCsvBlocks,
      network,
    });
    if (escrow.address !== terms.address) return null;
    const tx = btc.Transaction.fromPSBT(base64.decode(message.payload.psbt), {
      allowUnknown: true, allowUnknownOutputs: true,
    });
    const utxos = Array.from({ length: tx.inputsLength }, (_, index) => {
      const input = tx.getInput(index);
      if (!input.txid || input.index === undefined || !input.witnessUtxo) throw new Error("incomplete input");
      return {
        txid: bytesToHex(input.txid), index: input.index,
        amountSats: input.witnessUtxo.amount,
      };
    });
    if (!utxos.some(utxo => utxo.txid === terms.fundingTxid
      && utxo.index === terms.fundingVout)) return null;
    const winnerXonly = winnerRole === Role.BUYER ? terms.buyerXonly : terms.sellerXonly;
    const destination = btc.p2tr(hexToBytes(winnerXonly), undefined, network).address!;
    const total = utxos.reduce((sum, utxo) => sum + utxo.amountSats, 0n);
    if (!verifySettlementPsbt(message.payload.psbt, {
      escrow, utxos, destination, maxFeeSats: total, network,
    }).ok) return null;
    finalizeSettlement([message.payload.psbt]);
    return {
      txid: settlementUnsignedId(message.payload.psbt),
      inputs: utxos.map(({ txid, index }) => ({ txid, index })),
    };
  } catch {
    return null;
  }
}

export function finalArbiterSettlementProof(
  message: ParsedEscrowEvent<SettlementPayload>,
  terms: OnchainLockTerms,
  winnerRole: Role.BUYER | Role.SELLER,
): { txid: string; inputs: Array<{ txid: string; index: number }> } | null {
  if (!message.payload.final || message.payload.leaf !== "arbiter") return null;
  try {
    const network = terms.network === "mainnet" ? MAINNET : SIGNET;
    const escrow = buildOnchainEscrow({
      buyerXonly: hexToBytes(terms.buyerXonly), sellerXonly: hexToBytes(terms.sellerXonly),
      arbiterXonly: hexToBytes(terms.arbiterXonly), funder: terms.funder,
      refundLockUntil: terms.refundLockUntil, disputeCsvBlocks: terms.disputeCsvBlocks, network,
    });
    if (escrow.address !== terms.address) return null;
    const tx = btc.Transaction.fromPSBT(base64.decode(message.payload.psbt), {
      allowUnknown: true, allowUnknownOutputs: true,
    });
    const utxos = Array.from({ length: tx.inputsLength }, (_, index) => {
      const input = tx.getInput(index);
      if (!input.txid || input.index === undefined || !input.witnessUtxo) throw new Error("incomplete input");
      return { txid: bytesToHex(input.txid), index: input.index, amountSats: input.witnessUtxo.amount };
    });
    if (!utxos.some(u => u.txid === terms.fundingTxid && u.index === terms.fundingVout)) return null;
    const winnerXonly = winnerRole === Role.BUYER ? terms.buyerXonly : terms.sellerXonly;
    const destination = btc.p2tr(hexToBytes(winnerXonly), undefined, network).address!;
    const total = utxos.reduce((sum, u) => sum + u.amountSats, 0n);
    if (!verifySettlementPsbt(message.payload.psbt, {
      escrow, utxos, destination, maxFeeSats: total, network, leaf: "dispute",
    }).ok) return null;
    if (!hasValidDisputeSignatures(message.payload.psbt, escrow, winnerRole)) return null;
    finalizeSettlement([message.payload.psbt], { escrow, leaf: "dispute" });
    return { txid: settlementUnsignedId(message.payload.psbt), inputs: utxos.map(({ txid, index }) => ({ txid, index })) };
  } catch { return null; }
}


/** Actual build fee for the measured leaf plus every additional P2TR input. */
export function settlementBuildFeeSats(
  feeRateSatsPerVb: bigint,
  numInputs: number,
  leaf: "coop" | "dispute" = "coop",
): bigint {
  if (numInputs < 1) throw new Error("Settlement requires at least one input");
  const extraInputs = BigInt(numInputs - 1) * 58n;
  return (BigInt(LEAF_SPEND_VSIZE[leaf]) + extraInputs) * feeRateSatsPerVb;
}

/** A recovered/changed seed must never emit a useless signature for a key
 *  different from the one committed in the funded Taproot tree. */
export function signingKeyMatchesRole(
  derivedXonly: Uint8Array,
  role: Role,
  terms: Pick<OnchainLockTerms, "buyerXonly" | "sellerXonly"> & { arbiterXonly?: string },
): boolean {
  const committed = role === Role.BUYER ? terms.buyerXonly
    : role === Role.SELLER ? terms.sellerXonly
      : role === Role.ARBITER ? (terms.arbiterXonly ?? null) : null;
  return committed !== null && bytesToHex(derivedXonly).toLowerCase() === committed.toLowerCase();
}
