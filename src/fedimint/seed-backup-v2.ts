/** Protected seed envelope. No relay, signer, storage or platform wallet access. */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, hex } from '@scure/base';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const utf8 = new TextEncoder();
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SEED_V2_D_PREFIX = 'chama-wallet-seed-v2:';
export const SEED_V2_BROWSER_D_TAG = `${SEED_V2_D_PREFIX}browser`;
export type SeedBackupScope = 'browser' | `native:${string}`;
export interface SeedBackupV2 {
  v: 2;
  scope: SeedBackupScope;
  codeCheck: string;
  nonce: string;
  box: string;
}
export class InvalidRecoveryCode extends Error {
  constructor() { super('Wrong wallet recovery code. Check it and try again.'); }
}
function checkScope(scope: string): asserts scope is SeedBackupScope {
  if (scope !== 'browser' && !/^native:[a-f0-9]{64}$/.test(scope)) {
    throw new Error('Invalid wallet backup scope.');
  }
}
/** A 128-bit integer encoded as 26 digits, with two leading zero bits. */
export function formatRecoveryCode(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('Recovery code must contain 128 bits.');
  let n = BigInt(`0x${hex.encode(bytes)}`), text = '';
  for (let i = 0; i < 26; i++) { text = alphabet[Number(n & 31n)] + text; n >>= 5n; }
  return [text.slice(0, 5), text.slice(5, 10), text.slice(10, 14), text.slice(14, 18), text.slice(18, 22), text.slice(22)].join('-');
}
export function parseRecoveryCode(input: string): Uint8Array {
  const text = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (text.length !== 26) throw new InvalidRecoveryCode();
  let n = 0n;
  for (const char of text) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new InvalidRecoveryCode();
    n = (n << 5n) | BigInt(digit);
  }
  if (n >= (1n << 128n)) throw new InvalidRecoveryCode();
  return hex.decode(n.toString(16).padStart(32, '0'));
}
export function generateRecoveryCode(): string {
  return formatRecoveryCode(crypto.getRandomValues(new Uint8Array(16)));
}
export function deriveSeedWrapKey(code: Uint8Array, scope: SeedBackupScope): Uint8Array {
  checkScope(scope);
  if (code.length !== 16) throw new InvalidRecoveryCode();
  return hkdf(sha256, code, utf8.encode('chama-seed-backup-v2'), utf8.encode(scope), 32);
}
export function recoveryCodeCheck(code: Uint8Array): string {
  return hex.encode(sha256(new Uint8Array([...utf8.encode('chama-code-check'), ...code])).slice(0, 4));
}
/** Explicit nonce enables cross-implementation vectors; this PR never publishes envelopes. */
export function wrapSeedBackup(mnemonic: string, code: Uint8Array, scope: SeedBackupScope, nonce: Uint8Array): SeedBackupV2 {
  if (nonce.length !== 24 || !validateMnemonic(mnemonic, wordlist)) throw new Error('Invalid wallet backup input.');
  const key = deriveSeedWrapKey(code, scope);
  try {
    return { v: 2, scope, codeCheck: recoveryCodeCheck(code), nonce: base64.encode(nonce),
      box: base64.encode(xchacha20poly1305(key, nonce, utf8.encode(scope)).encrypt(utf8.encode(mnemonic))) };
  } finally { key.fill(0); }
}
export function parseSeedBackupV2(json: string, expectedScope: SeedBackupScope): SeedBackupV2 {
  checkScope(expectedScope);
  let value: any;
  try { value = JSON.parse(json); } catch { throw new Error('Invalid protected wallet backup.'); }
  try {
    if (value?.v !== 2 || value.scope !== expectedScope || !/^[a-f0-9]{8}$/.test(value.codeCheck)
      || typeof value.nonce !== 'string' || typeof value.box !== 'string'
      || base64.decode(value.nonce).length !== 24 || base64.decode(value.box).length < 16) throw new Error();
  } catch { throw new Error('Invalid protected wallet backup.'); }
  return value;
}
export function unwrapSeedBackup(payload: SeedBackupV2, codeText: string, expectedScope: SeedBackupScope): string {
  const safe = parseSeedBackupV2(JSON.stringify(payload), expectedScope);
  const code = parseRecoveryCode(codeText);
  const key = deriveSeedWrapKey(code, expectedScope);
  try {
    if (recoveryCodeCheck(code) !== safe.codeCheck) throw new InvalidRecoveryCode();
    const clear = xchacha20poly1305(key, base64.decode(safe.nonce), utf8.encode(expectedScope)).decrypt(base64.decode(safe.box));
    try {
      const mnemonic = new TextDecoder('utf-8', { fatal: true }).decode(clear);
      if (!validateMnemonic(mnemonic, wordlist)) throw new InvalidRecoveryCode();
      return mnemonic;
    } finally { clear.fill(0); }
  } catch { throw new InvalidRecoveryCode(); }
  finally { code.fill(0); key.fill(0); }
}
