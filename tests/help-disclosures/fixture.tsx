import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LangProvider } from '../../src/i18n';
import { T, applyThemeMode } from '../../src/ui/theme';
import { MeScreen } from '../../src/ui/screens/MeScreen';
import { ArbiterApplyForm } from '../../src/ui/components/ArbiterApplyForm';
import { InlineExplanation } from '../../src/ui/components/InlineExplanation';
import { HelpTip } from '../../src/ui/components/HelpTip';
import { OverlaySheet } from '../../src/ui/components/OverlaySheet';
import { FundingModalShell } from '../../src/ui/components/FundingModalShell';
import { FederationInfoProvider } from '../../src/ui/components/FederationDisclosure';
import { computeChamaLiveness } from '../../src/arbiters/live-chama';
import { viewer } from '../first-circle-phones/fixtures';
const params = new URLSearchParams(location.search);
applyThemeMode(params.get('theme') === 'light' ? 'light' : 'dark');
localStorage.setItem('chama_lang', params.get('lang') ?? 'en');
const w = window as any;
w.actions = 0;
const action = () => { w.actions++; };
const loadLiveness = async () => computeChamaLiveness('us-blf', [], new Map(), 900000);
const loadFederation = async () => ({ federationId: 'a'.repeat(64), metaStatus: 'ready' as const, config: {
  global: { meta: { federation_name: 'Friends federation' }, api_endpoints: Object.fromEntries(
    ['alpha.com', 'beta.org', 'gamma.net', 'delta.co.uk'].map((host, i) => [i, { url: `wss://${host}` }])) },
} });
function Fixture() {
  const [modal, setModal] = useState(false);
  const [sheet, setSheet] = useState(false);
  return <main style={{ maxWidth: 728, margin: 'auto', padding: 16, color: T.text }}>
    {params.get('mode') === 'edge' ? <div style={{ position: 'fixed', bottom: 8, right: 8, width: 48, height: 48, overflow: 'hidden', transform: 'translateZ(0)', padding: 14, boxSizing: 'border-box' }}><HelpTip title="A long contextual explanation">{'Read this without leaving the task. '.repeat(35)}</HelpTip></div> : params.get('mode') === 'me' ? <MeScreen pubkey={viewer} myTrades={[]} ratings={null}
      balanceMsats={100000000} walletInvite="fed1testcustom" hasActiveCommitment={false}
      requestTab={{ tab: 'sats', n: 1 }} communitySlug="us-blf" loadLiveness={loadLiveness}
      onSelectCommunity={action} onOpenTrade={action} onOpenSavedHandles={action}
      onOpenPayoutDestinations={action} onOpenAdvanced={action} onOpenHelp={action}
      onRecoverSats={action} onSignOut={action} /> : <>
      <ArbiterApplyForm communitySlug="us-blf" onApply={async () => action()} />
      <div data-parent onClick={action} style={{ marginTop: 16 }}>
        <InlineExplanation summary="Held here · until tomorrow" label="Test contextual help">
          <a href="#support" data-help-link>Supporting explanation</a>
        </InlineExplanation>
      </div>
      <button type="button" data-show-modal onClick={() => setModal(true)}>Open funding preview</button>
      <button type="button" data-show-sheet onClick={() => setSheet(true)}>Open settings preview</button>
      {sheet && <OverlaySheet title="Settings preview" onClose={() => setSheet(false)}><InlineExplanation summary="A visible setting"><span>Read without changing it</span></InlineExplanation><input aria-label="Draft setting" defaultValue="123" /></OverlaySheet>}
      {modal && <FundingModalShell onClose={() => setModal(false)} label="Funding preview">
        <div data-funding-task><InlineExplanation summary="Funds stay here"><span>Read without paying</span></InlineExplanation>
        <input aria-label="Draft amount" defaultValue="123" /></div>
      </FundingModalShell>}
    </>}
  </main>;
}
document.body.style.background = T.bg;
document.body.style.fontFamily = T.sans;
createRoot(document.getElementById('root')!).render(<LangProvider>
  <FederationInfoProvider load={loadFederation}><Fixture /></FederationInfoProvider>
</LangProvider>);
