import { LiveTradeSurface } from '../../src/ui/screens/LiveTradeSurface';
import { AssistedCanvas, type AssistedCanvasResume } from '../../src/ui/screens/AssistedCanvas';
import { tradeDetailReturnsHome } from '../../src/ui/decisions';
import { EscrowStatus, type EscrowState } from '../../src/escrow-engine/types';
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LangProvider} from '../../src/i18n';
import {T,applyThemeMode} from '../../src/ui/theme';
import {PagerPills} from '../../src/ui/screens/tradedetail/PagerPills';
import {AtomicFundingModal} from '../../src/ui/panels/AtomicFundingModal';
import {ClaimPayoutModal} from '../../src/ui/panels/ClaimPayoutModal';
import {ChamaLoader} from '../../src/ui/components/ChamaLoader';
import {Primary} from '../../src/ui/screens/AssistedCanvas';
const params=new URLSearchParams(location.search), theme=params.get('theme')==='light'?'light':'dark';
applyThemeMode(theme);document.head.insertAdjacentHTML('beforeend','<style>.chama-loader-static{display:none}@media(prefers-reduced-motion:reduce){.chama-loader-motion{display:none}.chama-loader-static{display:block}}</style>');document.body.style.background=T.bg;document.body.style.color=T.text;
const noop=()=>{};
function NavigationFixture(){
 const [status,setStatus]=useState(EscrowStatus.CREATED);
 const [inTrade,setInTrade]=useState(true);
 const [resume]=useState<{current:AssistedCanvasResume|null}>(()=>({current:{at:Date.now(),surface:'matches',bring:'cash',want:'sats',detail:'100',detailMax:'',terms:'',paymentRails:['strike'],matches:[],goodsMatches:[],matchWhy:null,premiumBps:0,premiumMode:'preset',premiumInput:''}}));
 const seller='a'.repeat(64),buyer='b'.repeat(64),arbiter='c'.repeat(64);
 const trade={provenance:'chain',id:'navigation',category:'p2p-trade',status,amountMsats:1000000,description:'Navigation test',createdAt:Date.now()/1000,expiresAt:Date.now()/1000+86400,participants:{buyer,seller,arbiter},initiator:{pubkey:seller,role:'seller'},lock:{notesHash:status===EscrowStatus.CREATED?null:'locked',lockedAt:null},votes:{},eventChain:[],chatMessages:[],communityArbiters:[arbiter]} as unknown as EscrowState;
 (window as any).navigationStatus=setStatus;
 if(!inTrade)return <AssistedCanvas listings={[]} browseCommunity="us" viewerPubkey={buyer} listingsLoading={false} resumeRef={resume} onBrowse={noop} onCreate={noop} onMoreOptions={noop} onOpenTrade={noop}/>;
 const home=tradeDetailReturnsHome(trade,false);
 return <LiveTradeSurface state={trade} pubkey={buyer} backLabel={home?'Home':'Offers'}
  onBack={()=>{if(home)resume.current=null;(window as any).navigationReset=resume.current===null;setInTrade(false);}}
  onOpenFullView={noop} onVote={async()=>{}} onSendChat={async()=>{}}/>;
}
function Fixture(){
 const [active,setActive]=useState(0);
 if(params.has('compare'))return <div style={{display:'flex'}}>{['pager','funding','claim'].map(panel=><section key={panel} style={{width:390,flexShrink:0}}><h3 style={{fontFamily:T.sans,textAlign:'center'}}>{panel}</h3><iframe title={panel} src={`?panel=${panel}&theme=${theme}`} style={{width:390,height:720,border:0}}/></section>)}</div>;
 const panel=params.get('panel');
 if(panel==='navigation')return <NavigationFixture/>;
 if(panel==='funding')return <AtomicFundingModal escrowId="fixture" amountMsats={2000000} ctaLabel="Test" supportsOnchain
  getOnchainInfo={async()=>({pegInFeeSats:100,minimumDepositSats:101,finalityDelay:3} as any)} getLightningGatewayCount={async()=>1}
  fundAndLock={async()=>new Promise(()=>{})} lockAndPublish={async()=>{}} onClose={noop}/>;
 if(panel==='claim')return <ClaimPayoutModal escrowId="fixture" payoutMsats={2000000} homeCommunity="us" fiatCurrency="USD"
  getLightningGatewayCount={async()=>params.has('zero')?0:1} savedDestinations={[{id:'strike',address:'saved@strike.me',createdAt:1} as any]}
  claimAndPayout={async(_id,args)=>{(window as any).claimKind=args.payoutKind;return new Promise(()=>{});}}
  confirmClaimEcashExport={async()=>{}} probeFederation={async()=>({ok:true})} onClose={noop}/>;
 return <div style={{padding:16,marginTop:210}}><PagerPills tabs={['Parties','Chat','Details']} icons={['👥','💬','📄']} active={active} onSelect={setActive}/>
  <Primary disabled onClick={noop}><span style={{display:'inline-flex',alignItems:'center',gap:8}}><ChamaLoader size={20}/>Checking live offers…</span></Primary></div>;
}
createRoot(document.getElementById('root')!).render(<LangProvider><Fixture/></LangProvider>);
