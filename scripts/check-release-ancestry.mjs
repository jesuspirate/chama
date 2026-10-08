#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function checkReleaseAncestry(cwd, candidate = 'HEAD', base = 'main') {
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const head = git('rev-parse', '--verify', `${candidate}^{commit}`);
  const main = git('rev-parse', '--verify', `${base}^{commit}`);
  try { git('merge-base', '--is-ancestor', main, head); }
  catch { throw Error(`Release blocked: ${base} is not an ancestor of ${candidate}. Merge ${base} into the release branch before releasing.`); }
  return { head, main };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const cwd = process.cwd(), args = process.argv.slice(2);
    if (args[0] === '--release-only') {
      const branch = execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim();
      if (branch !== 'main' && !branch.startsWith('release/')) process.exit(0);
      args.shift();
    }
    if (args.length > 2) throw Error('Usage: check-release-ancestry.mjs [--release-only] [candidate] [base]');
    checkReleaseAncestry(cwd, args[0] ?? 'HEAD', args[1] ?? 'main');
    console.log('Release ancestry: main is included.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
