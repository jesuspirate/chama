import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseAncestry } from './check-release-ancestry.mjs';
const cwd = mkdtempSync(join(tmpdir(), 'chama-ancestry-'));
const script = fileURLToPath(new URL('./check-release-ancestry.mjs', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
const commit = text => { writeFileSync(join(cwd,'history'),text);git('add','history');git('-c','commit.gpgsign=false','commit','-qm',text); };
try {
  git('init','-q','-b','main');git('config','user.name','Ancestry fixture');git('config','user.email','fixture@example.invalid');
  commit('base');git('branch','release/stale');commit('released behavior');
  assert.throws(()=>checkReleaseAncestry(cwd,'release/stale'),/main is not an ancestor/);
  git('switch','-q','release/stale');
  const blocked=spawnSync(process.execPath,[script,'--release-only'],{cwd,encoding:'utf8'});
  assert.equal(blocked.status,1);assert.match(blocked.stderr,/Release blocked/);
  git('merge','--ff-only','main');checkReleaseAncestry(cwd);commit('candidate');checkReleaseAncestry(cwd);
  git('switch','-q','main');commit('new release');
  assert.throws(()=>checkReleaseAncestry(cwd,'release/stale'),/main is not an ancestor/,'a later main advance makes an old candidate fail again');
  git('switch','-q','release/stale');git('-c','commit.gpgsign=false','merge','--no-ff','-m','include main','main','-s','ours');
  checkReleaseAncestry(cwd);
  // An ancestry check cannot prove conflict resolution; application regressions
  // separately protect the released behavior (do not equate ancestry with it).
  assert.equal(spawnSync(process.execPath,[script,'--release-only'],{cwd}).status,0);
} finally { rmSync(cwd,{recursive:true,force:true}); }
console.log('PASS release ancestry: stale candidate rejected; main included; subsequent advance rejected; merged ancestry accepted');
