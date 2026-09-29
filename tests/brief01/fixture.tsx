import React from 'react';
import {createRoot} from 'react-dom/client';
import {LangProvider} from '../../src/i18n';
import {ClaimPayoutModal} from '../../src/ui/panels/ClaimPayoutModal';
import {AtomicFundingModal} from '../../src/ui/panels/AtomicFundingModal';
import {T} from '../../src/ui/theme';
document.body.style.background=T.bg;
const w=window as any; w.calls=[]; w.cardCloses=0;
const close=()=>{w.cardCloses++;};
const funding=new URLSearchParams(location.search).has('funding');
createRoot(document.getElementById('root')!).render(<LangProvider>{funding ?
  <AtomicFundingModal escrowId="back-test" amountMsats={2000000} ctaLabel="Fund" supportsOnchain
    getLightningGatewayCount={async()=>1} getOnchainInfo={async()=>({pegInFeeSats:100,minimumDepositSats:101,finalityDelay:3} as any)}
    lockAndPublish={async()=>{}} onClose={close} fundAndLock={async(_id,opts)=>{
      w.calls.push(opts.fundingMethod);
      opts.signal?.addEventListener('abort',()=>{w.aborted=true;});
      opts.onPhase({kind:'invoice-created',bolt11:'CHAMA-TEST-ONLY-DO-NOT-PAY',expiresAt:Date.now()+600000});
      return new Promise(()=>{});
    }}/>
  : <ClaimPayoutModal escrowId="back-test" payoutMsats={2000000} savedDestinations={[]} homeCommunity="us" fiatCurrency="USD"
      claimAndPayout={async(_id,args)=>{w.calls.push(args.payoutKind);return {kind:'ecash-ready',notes:'TEST-ONLY-NOT-ECASH',amountMsats:2000000};}}
      confirmClaimEcashExport={async()=>{w.imported=true;}} probeFederation={async()=>({ok:true})} onClose={close}/>
}</LangProvider>);
