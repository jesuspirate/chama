import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectBoundary } from './check-protocol-boundary.mjs';
const root=mkdtempSync(path.join(tmpdir(),'chama-boundary-'));
try {
  for(const folder of ['docs','src/escrow-engine','src/ui']) mkdirSync(path.join(root,folder),{recursive:true});
  writeFileSync(path.join(root,'docs/protocol-boundary.md'),'<!-- protocol-core-entry: src/escrow-engine/state-machine.ts -->');
  writeFileSync(path.join(root,'src/escrow-engine/state-machine.ts'),`
// localStorage fetch('comment') Math.random() Date.now()
const prose = 'window.location new Date() navigator.userAgent';
export { value } from '../ui/mixed.js';
import React from 'react';
import { Capacitor } from '@capacitor/core';
import { invoke } from '@tauri-apps/api/core';
import { SimplePool } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
localStorage.getItem('x'); sessionStorage.clear(); indexedDB.open('x');
window.location; document.body; navigator.userAgent;
fetch('/'); new WebSocket('wss://example'); Date.now(); new Date(); Math.random();
new Date(123);
`);
  writeFileSync(path.join(root,'src/ui/mixed.ts'),"export const value = Date.now(); export { value as alias } from '../escrow-engine/state-machine.js';");
  const report=inspectBoundary(root);
  assert.equal(report.files.length,2,'walk reexports, .js resolution and cycles');
  for(const rule of ['localStorage','sessionStorage','indexedDB','window.','document.','navigator.','fetch(','WebSocket','Date.now(','new Date()','Math.random(','platform-import','relay-import','app-import']) assert(report.findings.some(f=>f.rule===rule),rule);
  assert.equal(report.findings.filter(f=>f.rule==='Date.now(').length,2,'comments excluded, transitive file scanned');
  assert.equal(report.findings.filter(f=>f.rule==='new Date()').length,1,'explicit dates excluded');
  assert.equal(report.findings.filter(f=>f.rule==='platform-import').length,3);
  assert.equal(spawnSync(process.execPath,['scripts/check-protocol-boundary.mjs',root],{cwd:process.cwd()}).status,0,'crossings never fail the check');
  writeFileSync(path.join(root,'docs/protocol-boundary.md'),'missing markers');
  const invalid=spawnSync(process.execPath,['scripts/check-protocol-boundary.mjs',root],{cwd:process.cwd(),encoding:'utf8'});
  assert.equal(invalid.status,0);assert.match(invalid.stdout,/inspection error/,'inspection failures are visible but report-only');
  console.log('PASS protocol boundary: all rules, syntax-aware exclusions, transitive .js imports/reexports, cycles and always-zero exit');
} finally {rmSync(root,{recursive:true,force:true});}
