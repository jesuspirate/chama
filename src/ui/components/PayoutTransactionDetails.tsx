import type { BtcNetwork } from '../../bond-multisig/multisig.js';
import { esploraTransactionUrl } from '../../bond-multisig/esplora-config.js';
import { shortOnchainId } from '../../escrow-engine/onchain-payout-text.js';
import { CopyButton } from './CopyButton.js';
import { openExternalUrl } from '../open-url.js';
import { T } from '../theme.js';

/** Same transaction identity in the guided room, full room and trade history. */
export function PayoutTransactionDetails({txid, depositTxid, network}: {
  txid?: string | null; depositTxid?: string | null; network: BtcNetwork;
}) {
  const link = (id: string, label: string) => <a href={esploraTransactionUrl(network,id)} title={id}
    target="_blank" rel="noreferrer noopener" style={{color:T.muted}}
    onClick={event => {event.preventDefault(); event.stopPropagation(); void openExternalUrl(esploraTransactionUrl(network,id));}}>{label} ↗</a>;
  return <div style={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:8,fontSize:12}} onClick={event => event.stopPropagation()}>
    {txid && <>
      <span title={txid} style={{fontFamily:T.mono,userSelect:'text'}}>Transaction {shortOnchainId(txid)}</span>
      <CopyButton value={txid} label="Copy" style={{fontSize:11,color:T.text,background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:'5px 8px'}} />
      {link(txid,'See it on-chain')}
    </>}
    {depositTxid && <small>{link(depositTxid,`Deposit ${shortOnchainId(depositTxid)}`)}</small>}
  </div>;
}
