/** A capability check only: never opens, changes or replaces wallet storage. */
export function browserWalletStorageError(env = {
  secure: typeof window === 'undefined' || window.isSecureContext !== false,
  opfs: typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function',
  wasm: typeof WebAssembly !== 'undefined',
  userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
}): string | null {
  if (!env.secure) return "This address isn't a secure connection (https or localhost), so the wallet can't store data here. Browsing and trades are viewable; wallet features need a secure address.";
  if (env.opfs && env.wasm) return null;
  const safari = /Safari\//.test(env.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(env.userAgent);
  if (safari) return "Safari's Lockdown Mode blocks the wallet's storage. Turn Lockdown off for getchama.app, or use Lightning / on-chain instead.";
  return "This browser does not support the wallet's storage (OPFS) or WebAssembly. Use a browser with wallet storage support.";
}
