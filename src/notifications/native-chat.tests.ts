import assert from 'node:assert/strict';
import type { EscrowState, ChatPayload, ParsedEscrowEvent } from '../escrow-engine/types.js';

// Exercise the actual Capacitor dispatch through its native-promise boundary.
const calls:{plugin:string;method:string;options:any}[] = [];
let verdict = 'shown', rejectPoster = false;
const values = new Map<string,string>();
Object.assign(globalThis,{androidBridge:{},localStorage:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v)}});
Object.assign(globalThis,{Capacitor:{PluginHeaders:[
 {name:'ChamaPush',methods:[{name:'postChat',rtype:'promise'}]},
 {name:'LocalNotifications',methods:[{name:'checkPermissions',rtype:'promise'},{name:'schedule',rtype:'promise'}]},
],nativePromise:async(plugin:string,method:string,options:any)=>{
 calls.push({plugin,method,options});
 if(method === 'checkPermissions') return {display:'granted'};
 if(method === 'postChat') {if(rejectPoster) throw Error('poster failed'); return {verdict};}
 throw Error(`Unexpected notification path ${plugin}.${method}`);
}}});
const {postNativeChat} = await import('./native-push.js');
const {maybeNotifyChatMessage,setDmNotifyPref,setNotificationsEnabled} = await import('./notify-service.js');
const {Role,EscrowStatus} = await import('../escrow-engine/types.js');
setDmNotifyPref('on');
const seller = 'a'.repeat(64), buyer = 'b'.repeat(64), arbiter = 'c'.repeat(64);
const state = {id:'sm_shared_chat',status:EscrowStatus.LOCKED,category:'marketplace',amountMsats:3_000_000,
 participants:{seller,buyer,arbiter},joinHolds:{}} as EscrowState;
const message = {raw:{id:'event'},pubkey:buyer,timestamp:Date.now()/1000,
 payload:{type:'escrow:chat',message:'Hello',senderRole:Role.BUYER}} as ParsedEscrowEvent<ChatPayload>;
for(const status of ['shown','duplicate','failed']) {
 verdict = status; rejectPoster = status === 'failed'; calls.length = 0;
 maybeNotifyChatMessage(state,message,seller,0);
 for(let i=0;i<20 && !calls.some(c=>c.method === 'postChat');i++) await new Promise(resolve=>setTimeout(resolve,5));
 await new Promise(resolve=>setImmediate(resolve));
 const posts = calls.filter(c=>c.method === 'postChat');
 assert.equal(posts.length,1);
 const note = JSON.parse(posts[0].options.note);
 assert.equal(note.tag,'sm_shared_chat:chat:event');
 assert.equal(note.message,'Hello');
 assert.ok(!calls.some(c=>c.method === 'schedule'),'shared poster failure never falls through to a generic second card');
}
calls.length = 0; setNotificationsEnabled(false);
maybeNotifyChatMessage(state,message,seller,0);
await new Promise(resolve=>setImmediate(resolve));
assert.equal(calls.length,0,'master mute gates native foreground chat');
rejectPoster = false; verdict = 'duplicate';
assert.equal(await postNativeChat({escrowId:state.id,tag:'sm_shared_chat:chat:event',title:'Chat',body:'Fallback'}),true,'native duplicate is successful delivery');
console.log('PASS native foreground chat: shared poster, message/tag payload, duplicate success, mute and no second-card fallback on failure');
