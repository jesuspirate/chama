# Protected wallet-seed backup readers

This is a reader-first format. No UI creates a protected backup, no v2 event
is published, and no v1 retirement or deletion event is published in this PR.
Existing legacy v1 creation remains unchanged. Trade rules and native bridge
routes are unchanged.

## Format

The recovery code represents a 128-bit unsigned big-endian integer as exactly
26 Crockford base32 digits (two leading zero bits). Display groups are
5-5-4-4-4-4; parsing ignores spaces, dashes and case, maps I/L to 1 and O to 0,
and rejects overflow, forbidden characters and incorrect lengths. It is not
an identity phrase.

HKDF-SHA256 uses the 16 code bytes as IKM, UTF-8 `chama-seed-backup-v2` as
salt, and the UTF-8 scope as info, producing a 32-byte key. Scopes are
`browser` or `native:<64 lowercase hex federation-id characters>`.

The NIP-44 self-encrypted event is kind 30078, with
`["d", "chama-wallet-seed-v2:<scope>"]` and `["client", "chama"]` tags.
The decrypted JSON contains `v: 2`, the exact scope, an 8-character lowercase
hex codeCheck, a base64 24-byte nonce, and a base64 ciphertext with its 16-byte
XChaCha20-Poly1305 tag. codeCheck is the first four SHA256 bytes of the UTF-8
string `chama-code-check` followed by the code bytes. The mnemonic is UTF-8;
AEAD additional data is the UTF-8 scope. Both the Nostr signer and code are
required to open the backup.

`src/fedimint/fixtures/seed-backup-v2-vectors.json` contains two public test
vectors, one per scope, including code bytes, display code, key, nonce,
mnemonic and box. These are disposable test inputs, not anyone's wallet.
Tests cross-check HKDF with Node's independent implementation.

## Reader safety

The reader first uses its signature-verified encrypted local cache. Otherwise
it queries this key's kind-30078 events without a small result cap, so other
app-data or native scopes cannot hide a browser backup. Protected events must
have valid signatures. Browser v2 takes priority over any legacy relay copy.
Any v2 scope blocks fresh generation when no browser/v1 seed is usable. Any
known v1 retirement blocks resurrection of another relay v1 copy.

A code is entered in a dismissible overlay. Only reads that seed a Fedimint
client (today the browser remote-bridge fallback) require acknowledgement of
the old-device warning, in English, Spanish, French or Swahili. Escrow and bond
key derivation require no restore confirmation for v1; v2 still requires its
code, but no Fedimint nonce-reuse warning for Bitcoin key derivation. Failed attempts
remain retryable. All ten existing hook reader calls use the typed refusal
handler. Unlocking does not resume a funding or signing action: the person
must retry it. Signed encrypted events and existence markers are stored
before requesting a code, so dismissal followed by relay loss cannot generate
a replacement seed. Neither the code nor the clear mnemonic is persisted or
logged. Decrypted mnemonics remain in the existing session-only memory cache.

Readers do not republish v2 and cannot re-encrypt an opened v2 seed into v1.
Legacy republishing refuses protected or retired backups and incomplete or
empty reads. The writer rollout will own as-is v2 republishing.

## Premise correction and rollout gates

Current main stopped using relay seeds for ordinary browser wallets in v6.1.
Those device-local wallets still reopen their own database; this PR does not
wire a recovered mnemonic into that startup path, overwrite a database or
claim it restores a browser balance. The seed reader is still used for
on-chain/bond keys and optional remote-bridge browser fallback. The research
file referenced by the brief is not present in this main checkout.

Claude reviews this reader PR before merge, after queue #30, #36, #31, #35 and
#34; merge main again when that queue lands. PR 2 is on hold pending Jet's
wallet-backup decision, and cannot proceed merely because readers exist.
The updated brief requests a separate dev-only native recovery-check tool;
that native proof does not establish WASM browser recovery. No funded recovery
proof has been run as part of this reader change.
