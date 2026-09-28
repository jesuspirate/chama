import assert from 'node:assert/strict';
import { walletUri, openWalletLink, nativeWalletLinks } from './wallet-link.js';
assert.equal(walletUri('LNBC123','lightning'),'lightning:LNBC123');
assert.equal(walletUri('LIGHTNING:LNBC123','lightning'),'lightning:LNBC123');
assert.equal(walletUri('bitcoin:bc1qexample?amount=0.001','onchain'),'bitcoin:bc1qexample?amount=0.001');
assert.equal(walletUri('bc1qexample','onchain'),'bitcoin:bc1qexample');
assert.equal(nativeWalletLinks(), false, 'web keeps copy behavior');
await assert.rejects(openWalletLink('https://example.com'), /Invalid payment link/);
console.log('PASS native wallet URI boundary and web fallback');
