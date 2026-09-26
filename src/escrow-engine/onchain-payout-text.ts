export const shortOnchainId = (value: string): string => value.length > 10 ? `${value.slice(0,6)}…${value.slice(-4)}` : value;
export function payoutStatusText(payout: {confirmed:boolean;sats:string;destination:string;txid:string}, includeTransaction = true): string {
  const status = payout.confirmed
    ? `Payout confirmed · ${Number(payout.sats).toLocaleString('en-US')} sats to ${shortOnchainId(payout.destination)}`
    : 'Payout sent · waiting for confirmation';
  return includeTransaction ? `${status} · Transaction ${shortOnchainId(payout.txid)}` : status;
}
