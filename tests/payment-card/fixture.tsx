import { createSimWallet } from "../../src/sim/sim-wallet";
import { simOnchainMode } from "../../src/sim/simMode";
import { TradeCard } from "../../src/ui/components/TradeCard";
import { createFundingInvoiceJournal, fundingStorageFailure } from '../../src/payments/abandoned-invoices';
import { MeScreen } from '../../src/ui/screens/MeScreen';
import { ChatPanel } from '../../src/ui/panels/ChatPanel';
import { stashPendingRedemption, markPoisoned } from '../../src/fedimint/pending-redemptions';
import { setLocalStorageUserScope } from '../../src/storage/user-scope';
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PaymentCard } from '../../src/ui/components/PaymentCard';
import { AtomicFundingModal } from '../../src/ui/panels/AtomicFundingModal';
import { FundWalletModal } from '../../src/ui/panels/FundWalletModal';
import { EcashExportModal } from '../../src/ui/panels/EcashExportModal';
import { QRCode } from '../../src/ui/QRCode';
import { LangProvider, useT } from '../../src/i18n';
import { T, applyThemeMode } from '../../src/ui/theme';
import { TradeDetail } from '../../src/ui/screens/TradeDetail';
import { applyEvent } from '../../src/escrow-engine/state-machine';
import { EscrowEventKind, EscrowStatus, Outcome, Role } from '../../src/escrow-engine/types';
import jsQR from 'jsqr';
const payload = 'lightning:CHAMA-TEST-ONLY-DO-NOT-PAY-' + '0123456789ABCDEF'.repeat(12);
(window as any).jsQR = jsQR;
(window as any).payload = payload;
let emit: ((p: any) => void) | undefined;
(window as any).phase = (kind: string) => emit?.({ kind });
const seller = 'a'.repeat(64), buyer = 'b'.repeat(64), arbiter = 'c'.repeat(64);
const created = applyEvent(null, { kind: EscrowEventKind.CREATE, escrowId: 'sm_summary_test', pubkey: seller,
  timestamp: 1800000000, prevEventId:null, raw:{id:'test',pubkey:seller,kind:EscrowEventKind.CREATE,created_at:1800000000,tags:[],content:'',sig:''},
  payload:{type:'escrow:create',description:'TEST ONLY',amountMsats:2000000,category:'marketplace',mintUrl:'test',
    platformFeeBps:50,platformFeePubkey:'d'.repeat(64),arbiterFeeMsats:1000,expirySeconds:86400,createdAt:1800000000} } as any);
if (!created.ok) throw new Error(created.error.message);
const summary = {...created.state, provenance:'summary' as const, status:EscrowStatus.APPROVED, resolvedOutcome:Outcome.REFUND,
  participants:{seller,buyer,arbiter}, eventChain:[]};
if(new URLSearchParams(location.search).has('attention')) {
 setLocalStorageUserScope('attention-fixture');
 for(const [id,amount] of [['one',2000000],['two',1000000]] as const) {
  stashPendingRedemption({escrowId:id,oobNotes:`TEST-${id}`,notesHash:'test',amountMsats:amount});markPoisoned(id,'Test-only retry exhaustion');
 }
}
const tapped: string[]=[];
(window as any).tapped=tapped;
const tap=(id:string)=>{tapped.push(id);};
const noop=()=>{};
function SimOnchainFixture() {
 const [wallet] = useState(() => createSimWallet({npub:null,onchainMode:simOnchainMode()}));
 useEffect(() => () => { void wallet.cleanup(); },[wallet]);
 return <AtomicFundingModal escrowId="SIM-ONCHAIN-FIXTURE" amountMsats={2000000} ctaLabel="Test"
  getOnchainInfo={()=>wallet.onchain.getInfo()} lockAndPublish={async()=>{}} onClose={()=>{(window as any).simClosed=true;}}
  fundAndLock={async (_id,opts)=>{
   await wallet.open(); await wallet.joinFederation('sim');
   const info=await wallet.onchain.getInfo();
   const deposit=await wallet.onchain.createDepositAddress({chama_amount_msats:2000000});
   const phase={address:deposit.address,operationId:deposit.operationId,finalityDelay:info.finalityDelay,pegInFeeSats:info.pegInFeeSats,depositAmountSats:2000+info.pegInFeeSats,minimumDepositSats:info.minimumDepositSats};
   opts.onPhase({kind:'onchain-address-created',...phase});
   (window as any).depositStates=[];
   wallet.onchain.subscribeDeposit(deposit.operationId,p=>{
    (window as any).depositStates.push(p);
    if(p.status!=='pending') opts.onPhase({kind:'awaiting-onchain-confirmations',...phase});
   });
   opts.signal?.addEventListener('abort',()=>{void wallet.cleanup();},{once:true});
   await wallet.onchain.awaitDeposit(deposit.operationId);
   opts.onPhase({kind:'onchain-deposit-confirmed'});
   opts.onPhase({kind:'locking'});
   // Test boundary: real sim net credit and spend; no relay event is published.
   (window as any).simLockedNotes=await wallet.mint.spendNotes(2000000);
   return {kind:'locked', amountMsats:2000000} as any;
  }}/>
}
function Fixture() {
  const { t } = useT();
  const [relay,setRelay]=useState(false);
  (window as any).setRelay=setRelay;
  const [phase, setPhase] = useState('waiting');
  (window as any).setPhase = setPhase;
  const [balance, setBalance] = useState(0);
  (window as any).credit = () => setBalance(10000000);
  (window as any).storageCopy={title:t('fund.notStartedTitle'),body:t('fund.notStartedBody'),blocked:t('fund.storageUnavailable'),corrupt:t('fund.historyUnreadable'),failed:t('fund.lockFailed')};
  (window as any).expected = {summary:t('trade.historyUnverified'),outcome:t('trade.nsRefundedSatsBack'),claim:t('trade.claimSats')};
  if (new URLSearchParams(location.search).has('simchain')) return <SimOnchainFixture/>;
  if (new URLSearchParams(location.search).has('market')) return <main style={{padding:24,background:T.bg,minHeight:'100vh'}}><TradeCard state={{...created.state,description:'uga – 1KG',expiresAt: new URLSearchParams(location.search).has('persistent') ? Number.MAX_SAFE_INTEGER : created.state.expiresAt,participants:{seller},provenance:'chain'}} pubkey={seller} onSelect={()=>{}}/></main>;
  if (new URLSearchParams(location.search).has('attention')) return <MeScreen pubkey={seller} myTrades={[]} ratings={null}
    needsYouTrades={[created.state]} suppressAttentionCount balanceMsats={3000000} hasActiveCommitment={false}
    onOpenTrade={id=>tap(`trade:${id}`)} onOpenSavedHandles={noop} onOpenPayoutDestinations={noop} onOpenAdvanced={noop} onOpenHelp={noop}
    onRecoverSats={()=>tap('recover')} onWithdrawEcash={()=>tap('export')} onSignOut={noop} onExportStrandedClaim={e=>tap(`claim:${e.escrowId}`)}
    stuckNativeLocks={[{escrowId:'stuck',amountMsats:1500000,createdAt:1,lastError:'test'} as any]}/>;
  if (new URLSearchParams(location.search).has('chat')) return <ChatPanel state={created.state} myRole={Role.SELLER} onSend={noop} preferredRelayConnected={relay}/>;
  if (new URLSearchParams(location.search).has('summary')) return <TradeDetail state={summary} pubkey={buyer} homeCommunity={null}
    bootProbeFailed={false} receiveUnavailable={false} fundingInProgress={false} onBack={()=>{}} onVote={async()=>{}}
    onClaim={async()=>{throw new Error('summary must not claim')}} onJoin={async()=>{}} onLock={async()=>{}}
    onSendChat={async()=>{}} onReleasePeriod={async()=>{}} onOpenSettings={()=>{}} onRebroadcast={async()=>({published:0,total:0})} />;
  if (new URLSearchParams(location.search).has('wallet')) return <FundWalletModal balanceMsats={balance}
    onClose={() => {}} onCreateInvoice={async () => payload.slice(10)} onPayInvoice={async () => {}}
    onSpendNotes={async () => ''} onRedeemEcash={async () => {}} />;
  if (new URLSearchParams(location.search).has('ecash')) return <EcashExportModal balanceMsats={2000000} federationLabel="TEST ONLY"
    spendNotes={async () => ''} onClose={() => {}} preset={{ notes: 'fedimint' + 'a1b2c3d4'.repeat(30), amountMsats: 2000000,
      headline: 'TEST ONLY', body: t('recovery.exportReadyBody', {federation:'TEST ONLY'}), onConfirmCleared: () => {} }} />;
  if (new URLSearchParams(location.search).has('storage') || new URLSearchParams(location.search).has('atomic')) return <AtomicFundingModal escrowId="TEST-ONLY" amountMsats={2000000}
    ctaLabel="Test" getOnchainInfo={async () => ({ pegInFeeSats: 100, minimumDepositSats: 1, finalityDelay: 1 } as any)}
    lockAndPublish={async () => {}} onClose={() => {(window as any).fundingClosed=true;}} fundAndLock={async (_id, opts) => {
      if (new URLSearchParams(location.search).has('storage')) {
        setLocalStorageUserScope('funding-storage-fixture');
        (window as any).invoiceCalls=0;
        const cause=new URLSearchParams(location.search).get('storage');
        if(cause==='corrupt') window.localStorage.setItem('chama_abandoned_invoices_v1:funding-storage-fixture','{broken');
        else Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('blocked','SecurityError');}});
        try {
          createFundingInvoiceJournal({escrowId:_id,amountMsats:2000000,federationId:'test-only'});
          (window as any).invoiceCalls++;
          throw Error('Storage preflight must refuse before reaching invoice creation');
        } catch(error) {
          if(new URLSearchParams(location.search).has('mapped')) {
            const failure=fundingStorageFailure(error);
            if(failure) {opts.onPhase(failure);return failure;}
          }
          throw error;
        }
      }
      emit = opts.onPhase;
      if (opts.fundingMethod === 'onchain') opts.onPhase({kind:'onchain-address-created', address:'tb1q-test-only-do-not-send-funds-000000', depositAmountSats:2100, pegInFeeSats:100, finalityDelay:3, minimumDepositSats:1, operationId:'test'} as any);
      else opts.onPhase({ kind: 'invoice-created', bolt11: payload.slice(10), expiresAt: Date.now() + 600000 } as any);
      return new Promise(() => {});
    }} />;
  return <main style={{ padding: 16, background: T.bg, minHeight: '100vh' }}>
    <PaymentCard amountMsats={2000000} rail="lightning" rails={['lightning','onchain','ecash']} data={payload} copyValue={payload.slice(10)}
      motion={phase !== 'waiting'} status={phase === 'waiting' ? t('fund.waitingForPayment', {time: '5:00'}) : t('fund.confirmingFederation')}
      helper={t('fund.scanOrCopyToPay')} details={t('payment.details')} />
    <div id="bond"><QRCode data={payload} size={180} /></div>
  </main>;
}
applyThemeMode(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark');
createRoot(document.getElementById('root')!).render(<LangProvider><Fixture /></LangProvider>);
