import { Capacitor, registerPlugin } from '@capacitor/core';
const device = registerPlugin<{ payment(options: {uri: string; share: boolean}): Promise<void> }>('ChamaDevice');
export function walletUri(value: string, rail: 'lightning' | 'onchain'): string {
  const clean = value.trim();
  const scheme = rail === 'lightning' ? 'lightning:' : 'bitcoin:';
  return clean.toLowerCase().startsWith(scheme) ? scheme + clean.slice(scheme.length) : scheme + clean;
}
export function nativeWalletLinks(): boolean { return Capacitor.getPlatform() === 'android'; }
export async function openWalletLink(uri: string, share = false): Promise<void> {
  if (!/^(lightning|bitcoin):\S+$/i.test(uri)) throw Error('Invalid payment link');
  await device.payment({ uri, share });
}
