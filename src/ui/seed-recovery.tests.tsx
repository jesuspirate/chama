import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { SeedRecoveryPanel } from './panels/SeedRecoveryPanel.js';
import { LangProvider, translate, LANGS } from '../i18n/index.js';
const html = renderToStaticMarkup(<LangProvider><SeedRecoveryPanel needsCode requireRestoreConfirmation onClose={() => {}} onRestore={async () => {}} /></LangProvider>);
assert.ok(html.includes('type="password"'));
assert.ok(html.includes('autoComplete="off"'));
assert.ok(html.includes('Two devices using one wallet can lose money.'));
assert.ok(html.includes('type="checkbox"'));
assert.ok(html.includes('disabled=""'));
const confirmOnly = renderToStaticMarkup(<LangProvider><SeedRecoveryPanel needsCode={false} requireRestoreConfirmation onClose={() => {}} onRestore={async () => {}} /></LangProvider>);
assert.ok(!confirmOnly.includes('type="password"'));
assert.ok(confirmOnly.includes('Stop using it on your old device.'));
for (const lang of LANGS) for (const key of ['restoreWarning', 'restoreConfirm', 'wrongCode', 'codeTitle']) {
  assert.notEqual(translate(lang, `recovery.seed.${key}`), `recovery.seed.${key}`);
}
const hook = readFileSync(new URL('../hooks/useEscrow.ts', import.meta.url), 'utf8');
// All ten existing reader sites go through the typed refusal handler.
assert.equal((hook.match(/await readSeed\(/g) ?? []).length, 10);
assert.equal((hook.match(/await getOrCreateSeed\(/g) ?? []).length, 2, 'Only handler and explicit unlock call underlying reader');
const keyOnly = renderToStaticMarkup(<LangProvider><SeedRecoveryPanel needsCode requireRestoreConfirmation={false} onClose={() => {}} onRestore={async () => {}} /></LangProvider>);
assert.ok(keyOnly.includes('type="password"'));
assert.ok(!keyOnly.includes('type="checkbox"'));
assert.ok(!keyOnly.includes('Two devices using one wallet'));
assert.ok(hook.includes('signer: Signer, requireRestoreConfirmation = false'));
const walletInit = hook.slice(hook.indexOf('const mnemonic = skipSeedFetch'), hook.indexOf('await runtimeWarmup;'));
assert.equal((walletInit.match(/await readSeed\(clientRef.current!, signerRef.current!, true\)/g) ?? []).length, 2);
assert.equal((hook.match(/await readSeed\(clientRef.current!, signerRef.current!, true\)/g) ?? []).length, 2,
  'Only mnemonic reads for Fedimint client init require confirmation');
console.log('PASS seed recovery UI: code privacy, explicit restore acknowledgement, four languages and all 10 reader call sites');
