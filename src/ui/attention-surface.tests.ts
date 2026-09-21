import assert from 'node:assert/strict';
import { selectMoneySafetyFocus, decideChamaBarLabel, type MoneySafetyEntry } from './decisions.js';
const entries: MoneySafetyEntry[] = [
 {kind:'stranded-claim',key:'claim-a',amountMsats:200000,createdAt:2},
 {kind:'stranded-claim',key:'claim-b',amountMsats:200000,createdAt:1},
 {kind:'leftover',key:'wallet',amountMsats:10000000,createdAt:1},
 {kind:'lock-recovery',key:'lock',amountMsats:1000000,createdAt:1},
 {kind:'unresolved-credit',key:'credit',amountMsats:2000000,createdAt:1},
 {kind:'pending-ecash-export',key:'export',amountMsats:3000000,createdAt:1},
 {kind:'leftover',key:'dust',amountMsats:1,createdAt:1},
];
for(let mask=0;mask<1<<entries.length;mask++) {
 const input=entries.filter((_,i)=>mask & 1<<i);
 const before=[...input];
 const r=selectMoneySafetyFocus(input);
 const all=[...(r.focus?[r.focus]:[]),...r.quiet];
 assert.deepEqual(all.map(e=>e.key).sort(),input.map(e=>e.key).sort(),'focus plus quiet contains every money-safety entry exactly once');
 assert.equal(new Set(all).size,input.length,'no money-safety entry is duplicated');
 assert.equal(Number(Boolean(r.focus)),Number(input.length>0),'there is exactly zero or one loud money-safety card');
 assert.ok(!(r.focusTone==='amber' && String(r.quietTone)==='amber'),'focus and quiet group can never both be amber');
 assert.deepEqual(input,before,'selection never mutates the caller\'s entries');
}
assert.equal(selectMoneySafetyFocus(entries).focus?.key,'claim-b','risk beats larger leftovers; oldest breaks same-amount ties');
assert.equal(selectMoneySafetyFocus(entries.slice(2)).focus?.key,'wallet','material leftover precedes exhausted lock recovery');
const pill=decideChamaBarLabel({balanceMsats:10000000,hasActiveBuyerSellerCommitment:false});
assert.equal(pill.kind,'stranded');
assert.equal(selectMoneySafetyFocus(entries).focus?.kind,'stranded-claim','stranded pill and money-safety focus agree on stranded money');
console.log('Attention surface: exhaustive partition, single focus, neutral quiet group, priority and pill agreement passed.');
