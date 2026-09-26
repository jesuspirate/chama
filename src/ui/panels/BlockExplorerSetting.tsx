import { useEffect, useRef, useState } from 'react';
import { ESCROW_NETWORK, ESCROW_NETWORK_LABEL } from '../../bond-multisig/onchain-escrow.js';
import { clearEsploraOverride, normalizeEsploraBase, probeEsplora, resolveEsploraBase, setEsploraOverride } from '../../bond-multisig/esplora-config.js';
import { T, inputStyle } from '../theme.js';

/** Verify the selected chain before replacing a working explorer. */
export function BlockExplorerSetting({focus = false}: {focus?: boolean}) {
  const ref = useRef<HTMLElement>(null);
  const [base, setBase] = useState(() => resolveEsploraBase(ESCROW_NETWORK));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { if (focus) ref.current?.scrollIntoView({block:'center'}); }, [focus]);
  const save = async () => {
    const normalized = normalizeEsploraBase(base);
    if (!normalized) { setMessage('Enter the block explorer’s API address, starting with https://.'); return; }
    setBusy(true); setMessage('Checking the block explorer…');
    try {
      const result = await probeEsplora(ESCROW_NETWORK, async path => {
        const response = await fetch(normalized + path, {signal:AbortSignal.timeout(20_000)});
        if (!response.ok) throw Error('Block explorer did not answer');
        const text = await response.text();
        try { return JSON.parse(text); } catch { return text; }
      });
      if (result.verdict !== 'ok') {
        setMessage(result.verdict === 'wrong-network' ? 'That explorer uses a different Bitcoin network. Your current setting is unchanged.' : 'Could not verify this block explorer. Your current setting is unchanged.');
      } else if (setEsploraOverride(ESCROW_NETWORK, normalized)) {
        setBase(normalized); setMessage('Block explorer saved. Reopen your trade to retry.');
      } else setMessage('Could not save this setting. Try again.');
    } finally { setBusy(false); }
  };
  return <section ref={ref} id="block-explorer" style={{padding:16,marginBottom:20,border:`1px solid ${T.border}`,borderRadius:T.r}}>
    <h3 style={{marginTop:0}}>Block explorer</h3>
    <p style={{color:T.muted,fontSize:13}}>Choose who checks Bitcoin deposits and payouts for you ({ESCROW_NETWORK_LABEL}).</p>
    <label htmlFor="block-explorer-base">Explorer API address</label>
    <input id="block-explorer-base" type="url" value={base} disabled={busy} onChange={e=>setBase(e.target.value)} style={{...inputStyle,width:'100%',margin:'8px 0'}} placeholder="https://your-explorer.example/api" />
    <div style={{display:'flex',gap:12}}>
      <button type="button" disabled={busy || !base.trim()} onClick={()=>void save()}>Check and save</button>
      <button type="button" disabled={busy} onClick={()=>{clearEsploraOverride(ESCROW_NETWORK);setBase(resolveEsploraBase(ESCROW_NETWORK));setMessage('Default block explorers restored.');}}>Use defaults</button>
    </div>
    {message && <p role="status">{message}</p>}
  </section>;
}
