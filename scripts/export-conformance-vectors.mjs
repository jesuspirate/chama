#!/usr/bin/env node
// Builds the public conformance vectors (docs/conformance/) from the golden
// replay corpus (tests/golden/replay.jsonl). The corpus stays the one source
// of truth; this file is a pure, deterministic projection of it.
//
//   node scripts/export-conformance-vectors.mjs          write the vectors
//   node scripts/export-conformance-vectors.mjs --check  exit 1 if they are stale
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const corpusPath = resolve(root, 'tests/golden/replay.jsonl');
const vectorsPath = resolve(root, 'docs/conformance/escrow-replay.jsonl');
const manifestPath = resolve(root, 'docs/conformance/manifest.json');

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  }
  return value;
}

export function buildVectors(corpusText) {
  const records = corpusText.trim().split('\n').map(line => JSON.parse(line));
  const lines = records.map(record => {
    // Replay input is the parsed event list, with the corpus's few deliberate
    // fixture overrides applied (they model evidence the raw parser cannot
    // reconstruct). The raw signed event stays on each input as `raw`.
    const input = record.parsedEvents.map((event, index) => record.replayOverrides?.[String(index)] ?? event);
    const expect = record.result.ok
      ? { ok: true, state: record.state }
      : { ok: false, error: record.result.error };
    return JSON.stringify(sorted({
      name: record.name,
      nowSec: record.nowSec,
      options: record.options,
      signatures: record.authentication,
      events: input,
      expect,
    }));
  });
  const vectors = lines.join('\n') + '\n';
  const errorCodes = {};
  const kinds = {};
  let accepted = 0;
  for (const line of lines) {
    const vector = JSON.parse(line);
    if (vector.expect.ok) accepted++;
    else errorCodes[vector.expect.error.code] = (errorCodes[vector.expect.error.code] ?? 0) + 1;
    for (const event of vector.events) kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
  }
  const manifest = sorted({
    format: 'chama-escrow-replay-vectors',
    formatVersion: 1,
    spec: 'docs/nip-draft-escrow.md',
    source: 'tests/golden/replay.jsonl',
    vectors: lines.length,
    accepted,
    refused: lines.length - accepted,
    refusalCodes: errorCodes,
    eventKinds: kinds,
    sha256: createHash('sha256').update(vectors).digest('hex'),
  });
  return { vectors, manifest: JSON.stringify(manifest, null, 2) + '\n' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { vectors, manifest } = buildVectors(readFileSync(corpusPath, 'utf8'));
  if (process.argv.includes('--check')) {
    let current = { vectors: '', manifest: '' };
    try { current = { vectors: readFileSync(vectorsPath, 'utf8'), manifest: readFileSync(manifestPath, 'utf8') }; }
    catch {}
    if (current.vectors !== vectors || current.manifest !== manifest) {
      console.error('FAIL conformance vectors are stale: run node scripts/export-conformance-vectors.mjs');
      process.exit(1);
    }
    console.log(`PASS conformance vectors match the golden corpus (${JSON.parse(manifest).vectors} vectors)`);
  } else {
    writeFileSync(vectorsPath, vectors);
    writeFileSync(manifestPath, manifest);
    console.log(`wrote ${JSON.parse(manifest).vectors} vectors to docs/conformance/`);
  }
}
