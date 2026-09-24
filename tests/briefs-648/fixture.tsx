import { createSimWallet } from "../../src/sim/sim-wallet";
import { AtomicFundingModal } from "../../src/ui/panels/AtomicFundingModal";
import { lockFromBalance } from "../../src/payments/lock-from-balance";
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistedCanvas, type AssistedCanvasResume } from '../../src/ui/screens/AssistedCanvas';
import { LiveTradeSurface } from '../../src/ui/screens/LiveTradeSurface';
import { LangProvider } from '../../src/i18n';
import { T } from '../../src/ui/theme';
import { EscrowStatus, Role, type EscrowState } from '../../src/escrow-engine/types';
const now=Math.floor(Date.now()/1000), seller='a'.repeat(64), buyer='b'.repeat(64), arbiter='c'.repeat(64);
const listing={provenance:'chain',id:'one',category:'p2p-trade',description:'Strike range',title:'Strike range',amountMsats:21_000,
 status:EscrowStatus.CREATED,createdAt:now,expiresAt:now+86400,community:'us',mintUrl:'test',paymentMethods:['strike'],fiatCurrency:'USD',premiumBps:0,
 participants:{buyer:null,seller,arbiter},initiator:{pubkey:seller,role:Role.SELLER},lock:{lockedAt:null,notesHash:null},
 items:[{id:'range',label:'Range',kind:'exchange-bracket',amountMsats:21_000,minAmountMsats:21_000,maxAmountMsats:500_000}],
 chatMessages:[],eventChain:[],votes:{},communityArbiters:[arbiter],joinHolds:{},platformFeeBps:50,arbiterFeeMsats:0} as unknown as EscrowState;
const listings=[listing,{...listing,id:'two',description:'Second offer',title:'Second offer'}];
const candidate=(listing:EscrowState,amountSats:number)=>({listing,sellerPubkey:seller,amountSats,paymentRail:'strike',fiatQuote:{amount:amountSats*.001,currency:'USD'},advertisedFeesMsats:{platform:0,arbiter:0,total:0},reasons:[],score:{availability:1,amountFit:1,paymentRail:1,community:1,federation:1,price:1,reputation:0,total:6}});
function BalanceFixture() {
 const [wallet] = useState(() => createSimWallet({npub:'balance-rehearsal',onchainMode:'instant'}));
 const [ready,setReady]=useState(false);
 useEffect(()=>{void (async()=>{
  await wallet.open();await wallet.joinFederation('sim');
  const deposit=await wallet.onchain.createDepositAddress({chama_amount_msats:500000});
  await wallet.onchain.awaitDeposit(deposit.operationId);setReady(true);
 })();return()=>{void wallet.cleanup();};},[wallet]);
 if(!ready)return <p>Preparing simulated balance</p>;
 return <AtomicFundingModal escrowId="balance-new-trade" amountMsats={100000} spendableMsats={500000} ctaLabel="Test"
  getOnchainInfo={()=>wallet.onchain.getInfo()} lockAndPublish={async()=>{}} onClose={()=>{}}
  fundAndLock={async(_id,opts)=>{
   if(opts.fundingMethod!=='balance')throw Error('Balance rehearsal must not create an invoice');
   return lockFromBalance({amountMsats:100000,readSpendable:()=>wallet.balance.getBalance(),getTrade:()=>({...listing,amountMsats:100000,items:[]}),
    actualAmount:()=>100000,signal:opts.signal,onPhase:opts.onPhase,lock:async()=>{
     await wallet.mint.spendNotes(100000);
     (window as any).remainingBalance=await wallet.balance.getBalance();
     return {...listing,status:EscrowStatus.LOCKED,lock:{...listing.lock,notesHash:'sim-confirmed'}};
    }});
  }}/>;
}
function Fixture(){
 const params=new URLSearchParams(location.search);
 const [room,setRoom]=useState<EscrowState|null>(params.has('lapsed') ? {...listing,participants:{buyer,seller,arbiter},joinHolds:{buyer:{role:Role.BUYER,eventId:'joined',pubkey:buyer,joinedAt:now-1000,expiresAt:now-500}}}:null);
 const resume=useRef<AssistedCanvasResume>({at:Date.now(),surface:'matches',bring:'cash',want:'sats',detail:'1',detailMax:'',terms:'',paymentRails:['strike'],matches:[candidate(listings[0],21),candidate(listings[0],500),candidate(listings[1],21)],goodsMatches:[],matchWhy:null,premiumBps:0,premiumMode:'preset',premiumInput:''});
 (window as any).search=()=>resume.current;
 if(room)return <div style={{height:'100dvh',display:'flex',flexDirection:'column'}}><LiveTradeSurface state={room} pubkey={params.get('viewer')==='seller'?seller:buyer}
  onBack={()=>setRoom(null)} backLabel="Offres" onHome={()=>setRoom(null)} onOpenFullView={()=>{}} onVote={async()=>{}} onSendChat={async()=>{}}
  onLock={async()=>{(window as any).locked=true;}} onRepost={async()=>{(window as any).reposted=true;}}
  onJoin={async role=>{(window as any).joined=role;setRoom({...room,participants:{...room.participants,[role]:buyer},joinHolds:{[role]:{role,eventId:'fresh',pubkey:buyer,joinedAt:now,expiresAt:now+600}}});}} /></div>;
 return <AssistedCanvas listings={listings} allEscrows={listings} browseCommunity="us" activeMintUrl="test" viewerPubkey={buyer} listingsLoading={false}
  fetchRatingSummary={async()=>({positive:0,negative:0,count:0})} onBrowse={()=>{}} onCreate={()=>{}} onMoreOptions={()=>{}}
  resumeRef={resume} onOpenTrade={id=>{(window as any).opened=id;setRoom(listings.find(l=>l.id===id)!);}}/>;
}
document.body.style.background=T.bg;document.body.style.color=T.text;
createRoot(document.getElementById('root')!).render(<LangProvider>{new URLSearchParams(location.search).has("balance")?<BalanceFixture/>:<Fixture/>}</LangProvider>);
