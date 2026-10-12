# Fresh-identity liveness — section N

Captured on 2026-10-04 UTC (2026-10-03 on the Mac). The desktop and Pixel
captures below were saved **before changing liveness code**, as the brief
requires. The sampled community was `us-blf`.

## What actually happened

| Capture | Cache before reading | Generation | Duration | Active bonded arbiters |
|---|---|---|---|---|
| Disposable desktop Brave | none | verified | 3,081 ms | 0 |
| Pixel 8, Vanadium, isolated USB preview origin | none | verified | 2,523 ms | 0 |

Sources: [desktop diagnostics](liveness-desktop-before.json),
[Pixel diagnostics](liveness-pixel-before.json). Both used a new random
public identity whose signer refuses signing and decryption. The actual
`useEscrow().getChamaLiveness` and `loadCoordinatedLiveness` paths ran.
Neither device initialized or joined a federation wallet. Existing accounts,
wallets, notes and browser profiles were not cleared or replaced.

A separate complete public relay reading and chain check explains the zero:
[public bond reading](liveness-desktop-bond-reading.json). Two raw events
reduce to one latest valid announcement. Its bond still contains 100,000 sats,
but `lockUntil` is **969,517**, below the observed chain tip **969,785**.
It is funded but no longer active, so zero active bonded arbiters is correct
for this community at this observation. Expiry does not prove those sats were
withdrawn. The veteran's existing browser was not sampled; its positive
reading's exact cause is not established by this evidence.

Some desktop explorer requests were aborted. This alone does not prove a
failed verification: the explorer reader aborts losing hedged requests when
another endpoint succeeds. A later Pixel drill did encounter an explorer
availability error; that attempt did not establish a new bond count. There
was no demonstrated fresh-identity-specific timeout in the original captures.

## Real holes found in the old implementation

- The UI rendered `liveness?.score ?? 0`, including when no reading existed.
- Bond-verification exceptions were converted to null, silently omitting those
  bonds from a result then labelled verified.
- `queryOnce` returned partial events on timeout, without a completeness fact.
- An unreadable deposit/transaction response could become an empty bond reading.

## Changes

Liveness now requires a completed public relay reading and successful chain
verification of every relevant latest announcement. Invalid-domain bonds are
still rejected. Failed, timed-out or unreadable evidence rejects the generation;
it does not produce zero. Verification stays within the existing 12-second
budget with at most six bond checks running at once. The display reader is
separate from funding, refund and bond-spending operations.

Me, the country detail and the dashboard show checking while a fresh reading
runs, then “couldn't check yet” with retry if it cannot finish. There is no
numeric meter or thin-coverage invitation for an unknown result. A failed
refresh also stops displaying the cached score. A completed, genuinely empty
active-bond reading can still show zero. Background refresh and one-generation
request deduplication remain intact; failed generations cancel sibling reads.

The verified cache uses a new version because the old reader could store
incomplete evidence as verified zero. Old entries are left on disk; no wallet
state is reset. New entries retain the five-minute TTL. A warm entry may paint
before refresh, but a failed refresh is visibly unknown.

## Verification and limits

Regression coverage includes incomplete relay reads, explorer failures,
malformed chain responses, sync/async loader rejection, an honest completed
zero, failed-refresh display, and retry producing exactly one fresh generation.
Phone-width browser checks cover all four languages and both themes. A final
fresh desktop read again completed with zero and no wallet initialization:
[after diagnostics](liveness-desktop-after.json).

The Pixel evidence is from its browser, not a new release APK. It locked again
while a post-change capture was pending; that attempt was stopped rather than
represented as a completed device check. The required pre-change Pixel evidence
above was captured successfully. No funded trade was exercised for this task.
