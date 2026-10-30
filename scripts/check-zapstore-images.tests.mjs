import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkZapstoreImages, listingImages } from './check-zapstore-images.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fixture(files, yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-images-'));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  writeFileSync(join(dir, 'zapstore.yaml'), yaml);
  return join(dir, 'zapstore.yaml');
}

test('reads the icon and every listed image, and nothing after the list', () => {
  const yaml = 'icon: icon.png\nimages:\n  - a.png\n  - b.png\ntags:\n  - bitcoin\n';
  assert.deepEqual(listingImages(yaml), ['icon.png', 'a.png', 'b.png']);
});

test('images under the limit pass', () => {
  const config = fixture({ 'icon.png': PNG, 'a.png': Buffer.concat([PNG, Buffer.alloc(100)]) },
    'icon: icon.png\nimages:\n  - a.png\n');
  assert.deepEqual(checkZapstoreImages(config, 200), []);
});

test('an oversized image fails before upload and is named', () => {
  const config = fixture({ 'icon.png': PNG, 'big.png': Buffer.concat([PNG, Buffer.alloc(500)]) },
    'icon: icon.png\nimages:\n  - big.png\n');
  const problems = checkZapstoreImages(config, 200);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^big\.png: 508 bytes, over the 200-byte limit$/);
});

test('a missing or non-image file fails', () => {
  const config = fixture({ 'icon.png': PNG, 'notes.png': Buffer.from('not an image') },
    'icon: icon.png\nimages:\n  - notes.png\n  - gone.png\n');
  const problems = checkZapstoreImages(config, 1000);
  assert.deepEqual(problems, ['notes.png: not a PNG or JPEG', 'gone.png: file not found']);
});

test("the repository's own zapstore.yaml images fit", () => {
  assert.deepEqual(checkZapstoreImages(new URL('../zapstore.yaml', import.meta.url).pathname), []);
});
