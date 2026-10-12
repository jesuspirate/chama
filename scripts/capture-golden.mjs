import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../',import.meta.url));
const tests = ['src/escrow-engine/tests.ts','src/escrow-engine/two-truths.tests.ts','src/escrow-engine/partial-relay.tests.ts',
  'src/escrow-engine/onchain-safety.tests.ts','src/escrow-engine/chama-gate.tests.ts',
  'src/fedimint/rejected-lock-recovery.tests.tsx','src/ui/brief-6418.tests.tsx'];
const output=path.join(root,'tests/golden/replay.jsonl');
writeFileSync(output,'');
for(const test of tests) {
  console.log(`Capture: ${test}`);
  const run=spawnSync(process.execPath,['--import','tsx','--import',path.join(root,'scripts/golden-capture-clock.mjs'),test],
    {cwd:root,env:{...process.env,CHAMA_CAPTURE_GOLDEN:'1'},stdio:'inherit'});
  if(run.status !== 0) {console.error(`Capture failed: ${test}`);process.exit(run.status ?? 1);}
}
const contents=readFileSync(output,'utf8');
if(/nsec1[a-z0-9]{20,}/i.test(contents) || /"(?:privateKey|secretKey|mnemonic|seedPhrase)"\s*:/i.test(contents)) throw new Error('Possible private-key material in golden artifact');
console.log(`Captured ${contents.trim().split('\n').length} records, ${Buffer.byteLength(contents)} bytes; no nsec or private-key/seed fields. Raw event signatures are classified in each record.`);
