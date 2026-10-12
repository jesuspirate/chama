# Zailo: circle share return

Work branch: `codex/circle-share-returns`, from `codex/per-bond-announcements`
at `dc5f7bfc`. No push, live vote, wallet operation or VPS deployment.

## Read-only diagnosis

Queried `relay.chama.community` to EOSE and verified the public CREATE/LOCK
signatures through the actual parser/reducer. Parent:
`sm_mus5u6ow_xio9639d`. Share:
`5848964a5c73422fa6e17a2688774fb0b39b320317745be53a7c0963ea718f12`.

| Seat | Public key |
| --- | --- |
| Member / buyer | `22f7161f76e075b9e0a250a447884ac09b04b636effd7c703a92394ed3fb39e8` |
| Host / seller | `925bc20265caa6b7166aad176b6c4d80bac1afa0135a4c55b134132692f6dea9` |
| Assigned arbiter | `59f0660b34dd48f9dfac5d973b77774a75af057ea3a261214ac5cdccd5d24440` |

The public CREATE → LOCK replay is **LOCKED**. Its fixed fill deadline is
October 6, 08:57:36 UTC (04:57:36 EDT), with round end October 10 at the same
time. A member-authored VOTE is present at 08:58:35 UTC, 59 seconds after fill
failure. Host VOTE, arbiter VOTE and RESOLVE are absent from this relay's
returned share chain. This is one relay's observed chain, not a claim that
no other device has unpublished or privately cached state.

The VOTE is encrypted for the host and arbiter; no identity key was accessed
to decrypt it. REFUND is the only lawful share-v1 outcome, but its ciphertext
is not a directly observed plaintext vote tally. The original device's
`Vote suppressed:` console line was requested and is still unavailable; USB
debugging was not connected and no new device session was requested.

Reproduced the duplicate gate against the publicly verified LOCK state plus
the existing signed member VOTE's author/id metadata. `canVote` returns
`Already voted`, so `EscrowClient.vote` throws:

```text
Cannot vote: Already voted
```

This is the reproduced **originalMessage candidate**, not a fabricated capture
of the device log. The old adapter's lowercase `already voted` substring misses
capitalized `Already voted`; its broader `Cannot vote` arm replaces that useful
reason with “This vote can no longer be cast.” The grace-period button then
invites the already-signed member to send a second vote, while the missing work
belongs to the host or assigned arbiter.

## Change and safety boundary

Online clients with a signer that can sign silently evaluate mechanical returns
on reconnect and every 15 seconds. The member and host use the existing lawful
REFUND path, with committed votes suppressing duplicates. The assigned arbiter
waits for the **existing** lone-vote escalation window, derived by
`oneSidedEscalationAt` from the member's committed REFUND. `canVote` owns the
eligibility decision; neither `canVote` nor `handleVote` gains a new exception.
Pool substitutes retain their existing priority and grace rules. A failed round with a member offline can still receive the
host's first vote; the assigned arbiter does not manufacture member consent.

Failed-fill automation requires a fresh child query completed to EOSE and all
discovered children successfully replayed. Timeout, failed replay or stale
completeness cannot stand in for missing seats. The historical fill latch stays
in force: a successfully filled, mid-round circle is never auto-refunded.
One failed circle read does not prevent an independent circle's return pass.
Permission-bound extension signers cannot receive background approval prompts;
their existing explicit signing paths remain available. Closed native wake
processing remains read-only and never signs a refund itself.

The manual grace button is removed. The member sees the named host plus the assigned arbiter's window-opening time
(in their local timezone). After that time the line names either signer, then
**Collect** appears after committed APPROVED.
Quorum awaiting resolution says confirmation is pending; missing signature
metadata says it is being checked. A pending vote cannot offer Collect. Real
vote failures preserve `originalMessage` in the displayed error, and diagnostic
logs include share id, status, votes and seats, with no bearer notes or keys.
All new surface and notification strings have en/es/fr/sw translations.

The member's tagged VOTE uses the existing opaque watcher route to the other
seats. Host/arbiter notification copy is “A circle share needs your return
signature.” Native encrypted replay resolves the validated public parent before
parsing the share, including a cold missing-root/parent fetch, and retains
notification deduplication. No provider delivery success is claimed here.

Reader compatibility: the early-arbiter exception from the first review was
removed. The reducer and circle policy are unchanged from the base branch.
The compatibility regression extracts the actual released 6.4.20 source tree
at `f0ff4c57bc5b7a7abc5d2a808c2785f467f04faa` into a temporary directory,
loads its reducer/parser and historical source dependencies, and replays the
SDK-produced member, host and arbiter VOTE chains (including automatic RESOLVE)
under both readers. It asserts identical complete reducer results, plus the
SDK's committed status, votes and resolved outcome. It checks that the arbiter
publishes nothing before its existing window; the test removes the temporary
archive afterwards. Installed third-party libraries are shared. CI test jobs
fetch full history so the pinned released source is available in their checkouts.

## Verification

The dedicated signed-event test exercises the actual EscrowClient signer,
publisher and positive acknowledgement with no network or wallet: one member,
immediate host and eligible assigned-arbiter REFUND each; no vote from any of them on a filled
mid-round circle. Tests also cover the escalation boundary, fill deadline,
incomplete child reads, stale completeness invalidation, named wait/Collect,
original error preservation, encrypted read-only native wake, missing parent
discovery and deduplication. Existing circle/rotation and general escrow suites
remain registered alongside the new test.

Amendment checks: the dedicated signed-return/6.4.20 compatibility test,
existing circle gate test, typecheck, build and repository hygiene pass.
Browser verification at 390px passes in light/dark themes and en/es/fr/sw:
named host plus the arbiter's local opening time, open-window copy, committed
APPROVED → Collect dispatch, no horizontal overflow and no page errors.
Temporary UI fixtures and their preview server were removed after the check.

The first amendment full run found a legacy test fixture with absent vote
metadata; the adapter now leaves that timestamp unknown rather than dereferencing
it. The existing circle suite passes. Full release-branch integration results
are recorded in `docs/v6.4.22-integration.md` after the merge.

The physical notification/online-return check belongs in the single combined
acceptance pass; this task does not request another phone session.
