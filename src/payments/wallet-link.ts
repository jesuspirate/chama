import { Capacitor } from '@capacitor/core';
import { nativeDevice } from '../native/device.js';
export function walletUri(value: string, rail: 'lightning' | 'onchain'): string {
  const clean = value.trim();
  const scheme = rail === 'lightning' ? 'lightning:' : 'bitcoin:';
  return clean.toLowerCase().startsWith(scheme) ? scheme + clean.slice(scheme.length) : scheme + clean;
}
export function nativeWalletLinks(): boolean { return Capacitor.getPlatform() === 'android'; }
/** Include iPadOS desktop browsing, which identifies itself as a touch Mac. */
export function iosWalletLinks(env: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return !!env && (/iPad|iPhone|iPod/.test(env.userAgent)
    || /Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
}
export async function openWalletLink(uri: string, share = false): Promise<void> {
  if (!/^(lightning|bitcoin):\S+$/i.test(uri)) throw Error('Invalid payment link');
  await nativeDevice.payment({ uri, share });
}

export async function openWalletOrCopy(uri: string, copy: () => Promise<boolean>, open = openWalletLink): Promise<string | null> {
  try { await open(uri); return null; }
  catch {
    const rail = uri.toLowerCase().startsWith('lightning:') ? 'Lightning' : 'Bitcoin';
    return await copy()
      ? `Copied — no wallet on this phone opens ${rail} links`
      : `No wallet on this phone opens ${rail} links. Copy the payment details manually.`;
  }
}
