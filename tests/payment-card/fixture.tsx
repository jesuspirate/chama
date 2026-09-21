import React, { useState } from 'react';
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
import { EscrowEventKind, EscrowStatus, Outcome } from '../../src/escrow-engine/types';
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
function Fixture() {
  const { t } = useT();
  const [phase, setPhase] = useState('waiting');
  (window as any).setPhase = setPhase;
  const [balance, setBalance] = useState(0);
  (window as any).credit = () => setBalance(10000000);
  (window as any).expected = {summary:t('trade.historyUnverified'),outcome:t('trade.nsRefundedSatsBack'),claim:t('trade.claimSats')};
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
  if (new URLSearchParams(location.search).has('atomic')) return <AtomicFundingModal escrowId="TEST-ONLY" amountMsats={2000000}
    ctaLabel="Test" getOnchainInfo={async () => ({ pegInFeeSats: 100, minimumDepositSats: 1, finalityDelay: 1 } as any)}
    lockAndPublish={async () => {}} onClose={() => {}} fundAndLock={async (_id, opts) => {
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
