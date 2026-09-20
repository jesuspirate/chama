import assert from 'node:assert/strict';
import { parseListingBody, safeListingHref } from './body.js';
for (const url of ['javascript:alert(1)', 'data:text/html,bad', '//evil.example', 'https://user:pass@evil.example', 'https://a.example/\n']) assert.equal(safeListingHref(url), null);
for (const text of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert)', '[x](data:text/html,bad)', '![pixel](https://evil.example/pixel)']) {
  assert.ok(parseListingBody(text).every(block => block.children.every(node => node.type !== 'link')));
}
const text = 'A'.repeat(3000) + '\nSecond paragraph';
assert.equal(parseListingBody(JSON.parse(JSON.stringify({ body: text })).body).flatMap(b => b.children.map(n => n.text)).join('\n'), text);
assert.equal(parseListingBody('[label](https://example.com/path)')[0].children[0].type, 'link');
assert.equal(parseListingBody('- **bold** and *italic*')[0].type, 'item');
assert.doesNotThrow(() => parseListingBody('**[nested](javascript:x)** <b onclick=x>test</b>'));
console.log('Listing body: safe grammar and long-text round trip passed');
