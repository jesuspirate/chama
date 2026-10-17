import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { decideChamaBarLabel } from './decisions.js';
import { ChamaBar } from './panels/ChamaBar.js';
import { LangProvider } from '../i18n/index.js';
import { MAIN_SURFACE_RECOVERY_MIN_SATS } from './decisions.js';
const base={balanceMsats:0,hasActiveBuyerSellerCommitment:false,myTradesLoading:true};
assert.equal(decideChamaBarLabel(base).kind,'syncing');
assert.equal(decideChamaBarLabel({...base,myTradesLoading:false}).kind,'ready');
const trade={...base,activeCommittedMsats:50_000_000};
const stranded={...trade,balanceMsats:MAIN_SURFACE_RECOVERY_MIN_SATS*1000};
const attention={...stranded,needsYouCount:1};
assert.equal(decideChamaBarLabel(trade).kind,'in-trade');
assert.equal(decideChamaBarLabel(stranded).kind,'stranded');
assert.equal(decideChamaBarLabel(attention).kind,'needs-you');
assert.equal(decideChamaBarLabel({...attention,bootProbeState:'failed'}).kind,'unreachable');
for(const joined of [true,false]) {
 const html=renderToStaticMarkup(<LangProvider><ChamaBar fedimint={{joined} as any} chamaLabel={decideChamaBarLabel(base)} onTapStranded={()=>{}} onInit={()=>{}} showReconnect={false}/></LangProvider>);
 assert.match(html,/Syncing…/);assert.match(html,/chama-loader-vector/);assert.doesNotMatch(html,/color-cycle|Chama: ready/);
 const needs=renderToStaticMarkup(<LangProvider><ChamaBar fedimint={{joined} as any} chamaLabel={{kind:'needs-you',count:1}} onTapStranded={()=>{}} onInit={()=>{}} showReconnect={false}/></LangProvider>);
 assert.match(needs,/<button/);assert.doesNotMatch(needs,/chama-loader-vector/);
}
// Jet (6.4.26-rc.6): with Bitcoin Life as home, an unlisted federation's wallet was labelled Bitcoin Life.
{
 const { getCommunityBySlug } = await import('../communities/registry.js');
 const { BLF_FEDERATION_ID } = await import('../fedimint/federation-invites.js');
 const { publishedFederationName } = await import('../fedimint/federation-inspection.js');
 const blf = getCommunityBySlug('us-blf')!;
 const blfLabel = blf.pickerLabel ?? blf.disambiguator ?? blf.displayName;
 const liberty = 'fed11qgqrcwnhwden5te0v9cxjtnpd3cxscfwd35kyetjw3uj6arjv4jj6mn9w3mk7unt95erqv34xqurzdpwvch8vctfx9nzummjvuhsqqfqx62tpp4l84l4ue8ze0jym60xcsj8umya983a83rztfuhnr6l35uqv7daky';
 const bar = (federationId: string) => renderToStaticMarkup(<LangProvider><ChamaBar fedimint={{joined:true,federationId,federationName:'External route'} as any} communitySlug="us-blf" activeInvite={liberty} chamaLabel={decideChamaBarLabel({...base,myTradesLoading:false})} onTapStranded={()=>{}} onInit={()=>{}} showReconnect={false}/></LangProvider>);
 const escaped = (s: string) => s.replace(/&/g,'&amp;');
 assert.ok(bar(BLF_FEDERATION_ID).includes(escaped(blfLabel)), 'home community label on its own federation');
 const other = bar('3694b086bf3d7f5e64e2cbe44de9e6c4247e6c9d29e3d3c4625a79798f5f8d38');
 assert.ok(!other.includes(escaped(blfLabel)), 'an unlisted federation never borrows the home community label');
 assert.match(other, /External route/);
 const info = { federationId: 'x', config: { global: { meta: { federation_name: '  Liberty   Tree Network ' } } }, metaStatus: 'ready' as const };
 assert.equal(publishedFederationName(info), 'Liberty Tree Network');
 assert.equal(publishedFederationName({ ...info, config: {} }), null);
 assert.equal(publishedFederationName(null), null);
}
// Jet (6.4.26-rc.7): the withdraw sheet said the note works on Bitcoin Life while the open wallet was another federation.
{
 const { EcashExportModal } = await import('./panels/EcashExportModal.js');
 const { BP_FEDERATION_INVITE, BP_FEDERATION_NAME } = await import('../fedimint/federation-invites.js');
 const sheet = (invite?: string) => renderToStaticMarkup(<LangProvider><EcashExportModal balanceMsats={121000} federationLabel="Bitcoin Life Federation" invite={invite} spendNotes={async()=>''} onClose={()=>{}}/></LangProvider>);
 const onBp = sheet(BP_FEDERATION_INVITE);
 assert.ok(onBp.includes(BP_FEDERATION_NAME) && !onBp.includes('Bitcoin Life'), 'the sheet names the open wallet federation');
 const { readFileSync } = await import('node:fs');
 const hook = readFileSync(new URL('../hooks/useEscrow.ts', import.meta.url), 'utf8');
 const preserved = hook.slice(hook.indexOf('switchFederationPreserving(trimmed)'), hook.indexOf('switchFederationPreserving(trimmed)') + 900);
 assert.match(preserved, /federationName: federationNameForInvite\(trimmed\)/, 'a preserved switch renames the open wallet');
}
console.log('PASS bar priority: unreachable > needs-you > stranded > in-trade > syncing > ready; vector loader and attention without federation membership');
