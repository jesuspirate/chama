# BRIEF — LOCK durability (runway 32, round two)

Written 2026-09-20, after the six-relay matrix. Hand this to Codex as a
self-contained unit. Source discussion: `docs/v6.4-runway.md` § "Runway 32 —
the LOCK durability gap, and what to build". House rules from
`docs/v6.5-brief.md` apply unchanged — pure units first, four languages,
money paths strict, tests that fail against today's code.

## What is established

A real settled trade, `sm_mtnxzb5y_zpepqcpj`, has no LOCK on any of the four
relays that answered a read-only probe, while every other event of its chain
survives on all four. The community relay's own storage is ruled out as the
cause by Jet's VPS audit (Khatru + Badger, no age pruning, no size cap, kinds
38100–38199 allowed, 10 MB used of ~5 GB).

Reading the publish path against that:

1. `lockEscrow` (`src/escrow-engine/escrow-client.ts:1866`) awaits
   `relayManager.publish(signed)` BEFORE `applyLocally`, and `publish` rejects
   on zero accepts. So this LOCK was accepted somewhere when it was written —
   a total publish failure would have left the trade CREATED with a
   `publish-attempted` entry in the native-lock stash.
2. `publishOnce` resolves on the FIRST accept from ANY relay. The preferred
   relay gets `PREFERRED_RELAY_ACK_GRACE_MS`, never a requirement; on its
   rejection or timeout the event lands in `preferredRepublishQueue`, an
   in-memory `Map` with a 24 h TTL and a 200-entry cap, lost on reload.
3. All **19** `relayManager.publish(...)` call sites in `escrow-client.ts`
   discard the returned `{ accepted, rejected, errors }`.
4. LOCK-specific rejection is documented, not hypothetical:
   `src/escrow-engine/selected-menu-items.ts` exists because inline
   `imageDataUrl` could turn a small order into "a 90KB LOCK event … rejected
   by every relay".

## What is NOT established

Whether this particular LOCK was published and later lost, or never became
durable at all. `scripts/inspect-trade-relays.ts` pass 2 answers that: if a
VOTE signed by someone other than the locker names the missing id as its
predecessor, that author read it from a relay. Do not write copy, a migration
or a recovery that assumes either answer before the script has run.

---

## 1. Money-bearing publishes must report their durability

**Pure unit:** `classifyPublishDurability(result, { preferredUrl })` →
`"durable" | "public-only" | "none"`, tested in isolation.

Add `RelayManager.publishDurable(event)` returning
`{ durable: boolean; accepted: number; rejected: number; errors: string[] }`,
where `durable` means the PREFERRED relay ACKed this event id
(`wasAcceptedByPreferred` already exists). Use it for `EscrowEventKind.LOCK`,
`CLAIM`, `SUBSCRIBE` and `PERIOD_RELEASE`. Leave the other 15 call sites on
`publish` — this brief does not rewrite advisory paths.

**Do not hard-fail a lock on `durable: false`.** By the time `lockEscrow`
publishes, the ecash is already spent out of the wallet; throwing there
strands bearer notes to buy a cleaner error message. Instead: apply locally as
today, record the LOCK's durability on the trade, and say so.

**Acceptance**

- `lockEscrow` records `custodyDurability: "confirmed" | "unconfirmed"` on the
  resulting state, derived from the publish result, not from a guess.
- A test locks with a stub relay manager whose preferred relay rejects and one
  public relay accepts: the lock SUCCEEDS, state is LOCKED, and
  `custodyDurability` is `"unconfirmed"`. This test fails against today's code.
- A second test, preferred relay accepts: `"confirmed"`.
- The trade surface shows the unconfirmed state in four languages, honestly and
  without alarm: the sats ARE locked on this device; what is missing is the
  durable copy of the custody record. Suggested en string — *"Your sats are
  locked. Chama's relay hasn't confirmed the custody record yet — we'll keep
  trying."* It clears the moment the ACK lands; it never says "lost".
- Nothing in this item changes event kinds, tag shapes or query filters.

## 2. Persist the preferred-relay republish queue

`preferredRepublishQueue` becomes a user-scoped persisted store (same lane and
discipline as `pending-native-locks.ts`), flushed on boot as well as on the
preferred relay's connect.

**Acceptance**

- Advisory events keep today's behaviour: 24 h TTL, 200 cap, oldest evicted.
- A money-bearing event NEVER ages out and NEVER falls off the cap. Only a
  positive ACK from the preferred relay retires it. If the cap is reached with
  only money-bearing entries left, the store grows rather than dropping one —
  and that condition is logged.
- A test writes a money-bearing entry, simulates a reload (fresh manager over
  the same storage), connects the preferred relay, and asserts the event is
  re-offered and then retired on ACK. Fails against today's code.
- The store is provably writable before it is relied upon — the
  `assertNativeLockStashWritable` pattern, not a silent `try/catch`.

## 3. Refuse an oversized money event before signing it

**Pure unit:** `assertMoneyEventWithinWireLimit(kind, content)`.

Measure `content.length` at the wire boundary in `lockEscrow` and the claim
path. Over the ceiling, throw a NAMED error the UI can render, before signing.
Pick the ceiling from measured data, not folklore: run
`scripts/inspect-trade-relays.ts` against live trades and use the size column.
State the chosen number and its evidence in the code comment.

**Acceptance**

- A test builds a LOCK payload over the ceiling and asserts the named error,
  and that no event was signed and nothing was published.
- Every money-bearing publish logs its byte size at debug level.
- `compactSelectedMenuItems` stays exactly where it is. This is the second
  line of defence, not a replacement for it.

## 4. Surface relay rejection text on money publishes

`errors[]` is collected today and thrown away at every call site. On a
money-bearing publish that ends `public-only` or `none`, the rejection strings
reach the user once, where a human sees them — a relay saying `event too
large` or `blocked: pubkey not allowed` should not cost a two-day
investigation.

**Acceptance**

- Rejection text appears in the trade's own diagnostics surface, not only in
  the console.
- It is never shown as the primary message on a successful lock; it is
  secondary detail under the honest headline from item 1.
- No relay string is interpolated into a translated sentence as if it were
  copy — it is quoted, verbatim, as machine output.

---

## Out of scope for this brief

The addressable-collision migration (`d = escrowId` means repeated events by
one author in one trade replace each other on every public relay that performs
replacement — measured on primal, nos.lol and nostr.mom) stays in
`docs/escrow-retention-migration-brief.md`. Note there, though, that tranche
funding makes this money-bearing: a second LOCK by the same author on the same
trade destroys the first on those relays.

Recovery of `sm_mtnxzb5y_zpepqcpj` itself is not in this brief either. It needs
an authenticated LOCK from a participant's retained history plus a replay on
the buyer's device. Do not invent a LOCK, change custody, or describe funds as
recovered.
