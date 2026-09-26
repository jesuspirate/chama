import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { buildSettlementPsbt, coSignSettlement } from '../bond-multisig/onchain-escrow-settle.js';
import { SIGNET } from '../bond-multisig/multisig.js';
import { EscrowEventKind as Kind, EscrowStatus, Outcome, Role, type EscrowState, type SettlementPayload, type ParsedEscrowEvent } from './types.js';
import { winnerSettlementChoice, assertWinnerMayChoose } from './onchain-settlement-choice.js';
const buyer=new Uint8Array(32).fill(11),seller=new Uint8Array(32).fill(12),arbiter=new Uint8Array(32).fill(13);
const f=safetyFixture({buyer:btc.utils.pubSchnorr(buyer),seller:btc.utils.pubSchnorr(seller),arbiter:btc.utils.pubSchnorr(arbiter)},2_000_000);
const destination=btc.p2tr(btc.utils.pubSchnorr(buyer),undefined,SIGNET).address!;
const alternate=btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(15)),undefined,SIGNET).address!;
const utxos=[{txid:'11'.repeat(32),index:0,amountSats:100_000n}];
const base:EscrowState={...f.state,status:EscrowStatus.APPROVED,resolvedOutcome:Outcome.RELEASE,resolvedMajority:[Role.BUYER,Role.SELLER],
 participants:{...f.state.participants,arbiter:f.pks.arbiter},
 lock:{...f.state.lock,lockedAt:Date.now()/1000,onchain:{...f.terms,amountSats:'100000',fundingTxid:utxos[0].txid,fundingVout:0}}};
for(const leaf of ['coop','dispute'] as const){
 const state:EscrowState={...base,resolvedMajority:leaf==='coop'?[Role.BUYER,Role.SELLER]:[Role.BUYER,Role.ARBITER]};
 const psbt=(address:string)=>buildSettlementPsbt({escrow:f.escrow,utxos,destination:address,feeSats:500n,leaf,fundingHeight:1,tipHeight:1000});
 const event=(role:'buyer'|'seller'|'arbiter',p:string,address?:string)=>f.event(Kind.SETTLEMENT,role,{type:'escrow:settlement',psbt:p,role:role as Role,leaf:leaf==='coop'?'coop':'arbiter',...(address?{payoutAddress:address}:{})}) as ParsedEscrowEvent<SettlementPayload>;
 const first=event('buyer',psbt(destination),destination), second=event('buyer',psbt(alternate),alternate);
 const stranger=event('seller',psbt(alternate),alternate);
 assert.equal(winnerSettlementChoice({...state,settlements:[stranger]}),null,'non-winner cannot nominate a destination');
 assert.equal(winnerSettlementChoice({...state,settlements:[first,second]})?.destination,alternate,'winner may change before another signer signs');
 assert.throws(()=>assertWinnerMayChoose({...state,settlements:[first]},f.pks.seller,alternate),/Only the winner/);
 const signature=event(leaf==='coop'?'seller':'arbiter',coSignSettlement(first.payload.psbt,leaf==='coop'?seller:arbiter));
 const frozen={...state,settlements:[first,signature,second]};
 assert.equal(winnerSettlementChoice(frozen)?.destination,destination,'new proposal cannot replace another signer’s authorized transaction');
 assert.equal(winnerSettlementChoice(frozen)?.locked,true);
 assert.throws(()=>assertWinnerMayChoose(frozen,f.pks.buyer,alternate),/already signed/);
 assert.doesNotThrow(()=>assertWinnerMayChoose(frozen,f.pks.buyer,destination));
 const own=event('buyer',coSignSettlement(first.payload.psbt,buyer));
 assert.equal(winnerSettlementChoice({...state,settlements:[first,own,second]})?.destination,alternate,'winner’s own signature alone does not freeze the choice');
 const falseClaim=event(leaf==='coop'?'seller':'arbiter',first.payload.psbt);
 assert.equal(winnerSettlementChoice({...state,settlements:[first,falseClaim,second]})?.destination,alternate,'metadata without a real signature cannot freeze');
 const malformed={...second,payload:{...second.payload,psbt:'invalid'}};
 assert.equal(winnerSettlementChoice({...state,settlements:[first,malformed]})?.destination,destination,'bad later traffic cannot mask a valid proposal');
 assert.equal(winnerSettlementChoice({...state,settlements:[first,first]})?.id,winnerSettlementChoice({...state,settlements:[first]})?.id);
}
console.log('PASS winner settlement choice: cooperative and dispute authorization, destination changes, real signatures freeze, forged/invalid traffic and duplicates');
