import assert from 'node:assert/strict';
import { browserWalletStorageError } from './browser-capabilities.js';
import { useFederationCommands, type FederationCommandsDeps } from '../ui/hooks/useFederationCommands.js';
const safari = { secure: true, opfs: true, wasm: true, userAgent: 'Version/18.0 Mobile/15E148 Safari/604.1' };
assert.equal(browserWalletStorageError(safari), null);
for (const unavailable of [{ opfs: false }, { wasm: false }, { opfs: false, wasm: false }]) {
  assert.match(browserWalletStorageError({ ...safari, ...unavailable })!, /Lockdown Mode.*getchama.app.*Lightning \/ on-chain/);
}
assert.match(browserWalletStorageError({ ...safari, secure: false, opfs: false })!, /secure connection/);
assert.doesNotMatch(browserWalletStorageError({ ...safari, opfs: false, userAgent: 'Chrome/120 Safari/604.1' })!, /Lockdown/);
const calls: string[] = [];
const commands = useFederationCommands({
  walletAvailable: false, activeCommitmentCount: 1, fedimint: {},
  actions: {
    setCommunity: (slug: string) => calls.push(`home:${slug}`),
    setCustomInvite: () => {},
    initFedimint: () => { throw Error('wallet must not start'); },
    switchFederation: () => { throw Error('wallet must not switch'); },
  },
  setBrowseCommunity: (slug: string) => calls.push(`browse:${slug}`),
  setToast: () => { throw Error('wallet error must not interrupt a community choice'); },
} as unknown as FederationCommandsDeps);
await commands.handleSelectCommunity('kenya');
assert.deepEqual(calls, ['home:kenya', 'browse:kenya']);
console.log('PASS missing Safari wallet capabilities and wallet-independent community selection');
