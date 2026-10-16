# Read-only federation preview — 6.4.22

On the connected Mac, the newly compiled native bridge was started on loopback
port 18792 with `/tmp/chama-public-preview-6422` as its unused data directory,
without an invite/startup join. POST `/federation-preview` received the public BLF
invite using the existing camelCase request schema (`inviteCode`).

Observed response:

- Federation: `888b70ec351c67dcbb0ae655d7b8b6fb26c0fc9e865ee5918af11dc6f53e2b9e`.
- Four guardian endpoints; consensus metadata read succeeded, revision 12.
- `fedi:max_invoice_msats`: `2000000000`.
- `fedi:max_balance_msats`: `10000000000`.
- With five seats this computes a maximum of **2,000,000 sats per share**.
  This is that federation's advertised ceiling at this observation, not a
  recommendation or a universal Chama risk limit. The UI default is 1,000 sats.
- After the request, the temporary wallet directory **did not exist**. No
  mnemonic, database, join, invoice, payment or spend was involved.

Browser regression coverage verifies that inspecting the active federation reads
its configuration and consensus metadata, while inspecting a different invite
only previews public configuration. Missing dynamic metadata is not replaced
with a guessed limit. A native-adapter test verifies the request schema and that
inspection leaves the wallet closed.

Curated naming, custom-federation warning, guardian count, same hostname/domain,
IP literals, public/private suffixes, host key membership, and distinct/repeated
iroh identity handling are tested. A shared iroh relay alone does not establish
common guardian ownership. Advisory warnings do not block a member's Lock.
