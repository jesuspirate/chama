import { WalletBalance } from '../../src/ui/screens/MeScreen';
import { TradeCustody } from '../../src/ui/components/MoneyCustody';
import { FundWalletModal } from '../../src/ui/panels/FundWalletModal';
import { AtomicFundingModal } from '../../src/ui/panels/AtomicFundingModal';
import { HelpScreen } from '../../src/ui/screens/HelpScreen';
import { useLiveness, LivenessSignal } from '../../src/ui/components/LivenessSignal';
import { computeChamaLiveness } from '../../src/arbiters/live-chama';
import {AssistedCanvas} from "../../src/ui/screens/AssistedCanvas";
import {resolveJoiningCommunitySlug} from "../../src/communities/joining-default";
import {SavedHandlesPanel} from "../../src/ui/panels/SavedHandlesPanel";
import {PayoutDestinationsPanel} from "../../src/ui/panels/PayoutDestinationsPanel";
import {MeScreen} from "../../src/ui/screens/MeScreen";
import {ConnectScreen} from "../../src/ui/screens/ConnectScreen";
import {useEscrow} from "../../src/hooks/useEscrow";
import { FederationInfoProvider, FederationDisclosure } from '../../src/ui/components/FederationDisclosure';
import { CircleCanvas } from '../../src/ui/screens/CircleCanvas';
import { circleFromEscrow } from '../../src/chama/policy';
import { CURATED_PRESETS } from '../../src/fedimint/federation-config';
import type { FederationInspection } from '../../src/fedimint/federation-inspection';
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LangProvider} from '../../src/i18n';
import {T,applyThemeMode} from '../../src/ui/theme';
import {NsecLogin} from '../../src/ui/panels/NsecLogin';
import {SignOutConfirmModal} from '../../src/ui/panels/SignOutConfirmModal';
import {RecoveryKeyRow,RecoveryKeyReminder} from '../../src/ui/components/RecoveryKey';
import {TradeCard} from '../../src/ui/components/TradeCard';
import {BrowseView} from '../../src/ui/screens/BrowseView';
import {listing,circleFixture,viewer,testNsec} from './fixtures';
const params=new URLSearchParams(location.search);
applyThemeMode(params.get('theme')==='light'?'light':'dark');
const mode=params.get('mode')??'cards';
if(params.has('lang')) localStorage.setItem('chama_lang',params.get('lang')!);
const publicInfo: FederationInspection = { federationId:'a'.repeat(64), metaStatus: 'ready', consensusMeta:{revision:1,value:{'fedi:max_invoice_msats':'100000000','fedi:max_balance_msats':'250000000'}}, config:{global:{meta:{federation_name:'Friends federation'},api_endpoints:Object.fromEntries(['alpha.com','beta.org','gamma.net','delta.co.uk'].map((host,i)=>[i,{url:`wss://${host}`}]))}} };
const loadFederation = async (invite:string) => {
 if (params.has('unknown')) throw new Error('test unavailable');
 const info=structuredClone(publicInfo);
 if(params.has('one')) delete (info.config as any).global.api_endpoints[3];
 return info;
};
const mintUrl=params.has('curated')?CURATED_PRESETS[0].inviteCode:'fed1testcustom';
const w=window as any;
w.joiningCardSlug=resolveJoiningCommunitySlug();w.testNsec=testNsec;w.viewer=viewer;w.submissions=[];w.subscriptions=[];w.closedSubscriptions=[];
const loadKey=async()=>{
 if(params.has("timeout")) await new Promise<void>(()=>{});
 if(w.deferKeyLoad) await new Promise<void>(resolve=>{w.finishKeyLoad=resolve;});
 return params.has("external")?null:params.has("wrong")?"01".repeat(32):testNsec;
};
function Fixture(){
 const [walletOverlay,setWalletOverlay]=useState<null|"payment-methods"|"lightning">(null);
 const [rows,setRows]=useState([listing('first'),listing('second'),listing('store','marketplace'),listing('mine','p2p-trade',viewer)]);
 const [category,setCategory]=useState('all');
 w.addListing=(id:string,cat='p2p-trade')=>setRows(old=>[listing(id,cat),...old]);
 w.repeatListing=()=>setRows(old=>[old[0],...old]);
 const [signInError,setSignInError]=useState<string|null>(null);
 const [show,setShow]=useState(true);w.unmountBrowse=()=>setShow(false);
 return <main style={{height:'100dvh',overflow:'auto',color:T.text,background:T.bg}}>
 {mode.startsWith('custody-')?<CustodyFixture/>:
 mode==='liveness-test'?<LivenessFixture/>:
 mode==='federation'?<div style={{padding:16}}><FederationDisclosure circle={{...circleFromEscrow(circleFixture('held').parent)!,mintUrl}} /></div>:
 mode.startsWith('community')?<CommunityNavigationFixture/>:
 mode==='canvas'?<CircleCanvas viewerPubkey={viewer} mintUrl={mintUrl} community="us-usd" onBack={()=>{}} onPublish={async round=>{w.submissions.push(round);}} />:
 mode==='me'?<MeScreen pubkey={viewer} myTrades={[]} ratings={null} balanceMsats={0} balanceKnown={false} hasActiveCommitment={false} loadActiveRecoveryKey={loadKey} onOpenTrade={()=>{}} onOpenSavedHandles={()=>setWalletOverlay("payment-methods")} onOpenPayoutDestinations={()=>setWalletOverlay("lightning")} onWithdrawEcash={()=>{}} onOpenAdvanced={()=>{}} onOpenHelp={()=>{}} onRecoverSats={()=>{}} onSignOut={()=>{}} onUseWallet={()=>{w.walletUses=(w.walletUses??0)+1;}} />:
 mode==='connect'?<ConnectScreen loading={false} error={signInError} onConnect={()=>{w.extensionAttempts=(w.extensionAttempts??0)+1;setSignInError("nos2x: user denied RAW SECRET ERROR");}} onConnectNsec={(...args)=>{w.submissions.push(args);}} />:
 mode==='startup'?<Startup/>:
 mode==='login'?<div style={{padding:16}}><NsecLogin friendly onSubmit={(...args)=>{w.submissions.push(args);}} /></div>:
 mode==='paste'?<NsecLogin defaultOpen allowCreate={false} minimalPaste onSubmit={(...args)=>{w.submissions.push(args);}} />:
 mode==='signout'?<SignOutConfirmModal pubkey={viewer} loadActiveRecoveryKey={loadKey} onCancel={()=>{}} onConfirm={()=>{w.signedOut=true;}} />:
 mode==='recovery'?<><RecoveryKeyReminder pubkey={viewer} loadKey={loadKey}/><RecoveryKeyRow pubkey={viewer} loadKey={loadKey}/></>:
 mode==='browse'?show&&<><div style={{height:params.has('below')?950:0}}/><BrowseView browseCategory={category} setBrowseCategory={setCategory} browseCommunity="us-usd" amountDisplayMode="sats" matchingListings={rows} nonMatchingListings={[]} pubkey={viewer} fedimintJoined listingsLoading={false} isFirstTime={false} onPasteCustomInvite={()=>{}} onOpenEscrow={()=>{}} onLoadById={()=>{}} onCreate={()=>{}} onApplyAsArbiter={async()=>{}} subscribeListings={scope=>{const id=w.subscriptions.push(scope);return()=>w.closedSubscriptions.push(id);}} /><div style={{height:1200}} /></>:
 <div style={{padding:12,display:'grid',gap:12}}>{(['held','locked','collect','claimed'] as const).map(seat=>{const {parent,share}=circleFixture(seat);return <TradeCard key={seat} state={parent} allEscrows={[parent,share]} pubkey={viewer} onSelect={()=>{}} />;})}</div>}
 {walletOverlay==="payment-methods"&&<SavedHandlesPanel communitySlug="us-usd" onClose={()=>setWalletOverlay(null)}/>}
 {walletOverlay==="lightning"&&<PayoutDestinationsPanel onClose={()=>setWalletOverlay(null)}/>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<LangProvider><FederationInfoProvider load={loadFederation} activeId={publicInfo.federationId}><Fixture/></FederationInfoProvider></LangProvider>);

function Startup() {
 const [state,actions]=useEscrow({ relays: [] });
 (window as any).startupState=state;
 return <ConnectScreen loading={state.loading} error={state.error} onConnect={()=>void actions.connect()}
   onConnectNsec={(...args)=>{w.submissions.push(args);}} />;
}

function CommunityNavigationFixture(){
 const [me,setMe]=useState(false),[country,setCountry]=useState<string|undefined>();
 const [community,setCommunity]=useState(params.get('community')??'us-blf');
 w.communitySelections??=[];w.communityNavigation??=[];
 const open=(suggested?:string)=>{w.communityNavigation.push(suggested??null);setCountry(suggested);setMe(true);};
 if(me)return <MeScreen pubkey={viewer} myTrades={[]} ratings={null} balanceMsats={0}
  hasActiveCommitment={params.has('locked')} communitySlug={community} requestTab={{tab:'community',n:1,country}}
  onSelectCommunity={slug=>{w.communitySelections.push(slug);setCommunity(slug);}}
  onOpenTrade={()=>{}} onOpenSavedHandles={()=>{}} onOpenPayoutDestinations={()=>{}}
  onOpenAdvanced={()=>{}} onOpenHelp={()=>{}} onRecoverSats={()=>{}} onSignOut={()=>{}}/>;
 if(mode==='community-canvas')return <CircleCanvas viewerPubkey={viewer} community={community} mintUrl={mintUrl}
  onOpenCommunity={()=>open()} onBack={()=>{}} onPublish={async()=>{}}/>;
 if(mode==='community-guided')return <AssistedCanvas listings={[]} browseCommunity={community} viewerPubkey={viewer}
  listingsLoading={false} onOpenCommunity={()=>open()} onBrowse={()=>{}} onCreate={()=>{}} onMoreOptions={()=>{}} onOpenTrade={()=>{}}/>;
 return <BrowseView browseCategory="all" setBrowseCategory={()=>{}} browseCommunity={community} amountDisplayMode="sats"
  matchingListings={[]} nonMatchingListings={[]} pubkey={viewer} fedimintJoined listingsLoading={false} isFirstTime={false}
  onOpenCommunity={open} suppressCommunityNudge={params.has('explicit')} onPasteCustomInvite={()=>{}}
  onOpenEscrow={()=>{}} onLoadById={()=>{}} onCreate={()=>{}} onApplyAsArbiter={async()=>{}}/>;
}

function CustodyFixture(){
 const state={...listing('custody'),mintUrl,tradeTimeoutSeconds:params.has('long')?30*86400:86400};
 const work=async()=>{w.moneyCalls=(w.moneyCalls??0)+1;return '';};
 if(mode==='custody-wallet')return <div style={{padding:16}}><WalletBalance balanceMsats={100000000} invite={mintUrl}/></div>;
 if(mode==='custody-lock')return <div style={{padding:16}}><TradeCustody state={params.has('bitcoin')?{...state,escrowMode:'onchain',onchainFundingTerms:{refundLockUntil:970000} as any}:state} warn /></div>;
 if(mode==='custody-faq')return <HelpScreen onBack={()=>{}}/>;
 const circle=params.has('circle')?{...circleFromEscrow(circleFixture('held').parent)!,mintUrl}:undefined;
 if(mode==='custody-atomic')return <AtomicFundingModal circleCustody={circle} escrowId={state.id} custodyState={circle?{...state,parent:circle.id,chamaPolicy:'share-v1',expiresAt:circle.roundEndSec}:state} amountMsats={1000000} ctaLabel="Lock trade" spendableMsats={100000000} supportsOnchain={false} getOnchainInfo={async()=>{throw Error('unused');}} fundAndLock={async()=>{await work();return {kind:'cancelled'};}} lockAndPublish={work} onClose={()=>{}}/>;
 return <FundWalletModal mintUrl={mintUrl} balanceMsats={100000000} onClose={()=>{}} onCreateInvoice={work} onPayInvoice={async()=>{await work();}} onSpendNotes={work} onRedeemEcash={async()=>{await work();}}/>;
}
function LivenessFixture(){
 w.livenessCalls??=0;w.livenessNext??='error';
 const result=useLiveness('controlled-evidence',async()=>{w.livenessCalls++;if(w.livenessNext==='error')throw Error('controlled network failure');return computeChamaLiveness('controlled-evidence',[],new Map(),900000);});
 return <LivenessSignal {...result} onRetry={result.retry}/>;
}
