# BLF federation migration plan

Status: proposed, 2026-11-05 (#115: landing page invite and QR only).
2026-11-10 update: the app change is in "Moving to the v2 federations" at the
end of this file.

## Identity and scope

The supplied invite has a valid Bech32m checksum and contains federation ID
`30a2771d22c79a4d08bda6fd469db3ef2b586fbf789647ba161171a9a877128f`.
The currently configured BLF ID is
`888b70ec351c67dcbb0ae655d7b8b6fb26c0fc9e865ee5918af11dc6f53e2b9e`.
These are different federations. Lowercase naming does not make their notes,
wallets, balances, or obligations interchangeable.

New invitation:

```text
fed11qgqyj3mfwfhksw309ajngvf4v5ur2ef5xdnxve3ex93nqdtxxe3nwcenxp3rjv3nx56kzvfnvsurzwrzvc6rye3cvycnyvpcxa3x2wtyv33nzefexquxgvekqqqjqv9zwuwj93u6f5ytmfhag6wm8mettphm77ykg7apvyt34x58wy50rk9sj8
```

The new invite joins BLF only. The English and French Chama space links stay
unchanged and are separate choices; the new invite does not auto-join them.
Local decoding verifies the federation identity, not server metadata or
Fedi's join behavior. Those need a Fedi device check.

## 1. Verify the destination before changing app routing

- Read the new federation's configuration: confirm ID, name, guardians,
  transport, modules, gateway availability and fees. Record live evidence;
  do not inherit compatibility claims from the old BLF.
- Open the landing link and scan the displayed QR in Fedi. Confirm the
  intended federation joins. Check the unchanged English and French space
  links independently. Also check a
  device already joined to old BLF, without deleting its wallet.
- With explicit test-funding authorization, verify small receive, send,
  restart/recovery and claim operations on browser/PWA, Android and desktop.
  Keep device-local browser state separate from native bridge state and
  Fedi's wallet. A saved Nostr key alone is not an ecash backup.

## 2. Add a separate route and preserve the old route

- Keep the old ID and invite as an explicit legacy route. Add the new ID and
  invite separately; never overwrite the old ID with the new invite.
- Review `src/fedimint/federation-invites.ts`, `federation-config.ts`,
  `src/communities/registry.ts` and native bridge defaults together. The current
  `us-blf` route and universal fallback refer to old BLF. Prefer a distinct
  community slug for new BLF so historical community-only routing retains its
  original meaning. Audit historical CREATE compatibility before deciding.
- Route signed trades and claims by their committed federation facts. Never
  rewrite old listings, escrow shares, votes or claims onto the new route.
  Finish or cancel old unfunded listings explicitly, then recreate on new BLF.
- Reuse and verify browser wallet parking in `federation-parking.ts` and
  `useEscrow.ts`, and native `switchFederationPreserving` / `/switch`.
  Save the way back before closing a wallet. Refuse unreadable destinations,
  storage collisions and switches during funding or claims. Unknown balance
  is not zero. Do not wipe or rotate a possibly funded wallet to join.
- Give people clear labels such as “BLF (previous)” and “blf” during the
  transition, with identity determined by ID rather than capitalization.
  Show who holds each balance; changing selection does not transfer it.

## 3. Move balances only as an explicit transfer

Old BLF notes cannot be deposited as new BLF notes. A possible route is a
Lightning payment from old BLF to a receive invoice from new BLF, subject to
verified gateway support, liquidity, fees and minimums. This is a separate
feature or a supported manual withdrawal/deposit flow, not part of switching.

Trace every caller through invoice creation, preflight, confirmation, payment,
mint, publish, retry and recovery before implementing a transfer. Confirm the
destination and maximum cost before the old wallet pays. Persist both route
identities and operation handles before payment. After payment, retain the
funded operation and resume mint/recovery if interrupted; never pay again just
because a response timed out. Report an unknown outcome honestly.

Keep old wallets available for outstanding trades, claims, pending receives,
unspent/exported notes, recovery and small residual balances. Never delete
them automatically after an apparent zero balance. Ask the BLF operator for
the old federation's withdrawal window and shutdown plan before promising a
deadline. If the old federation becomes unavailable, preserve state and the
recovery path; a new invitation cannot recover old notes.

## 4. Acceptance and rollout

Before changing app defaults, add and mechanically verify test wiring for:

- Both invites resolve to distinct IDs and storage; same-name federations
  never merge. Old trades and claims still resolve to old BLF after rollout.
- Funded, zero-balance, unknown-balance and untracked existing browser wallets
  survive first launch, switch away/back and restart; repeat for native state.
- Offline destination, refused switch, repeated taps, pending payment and
  interrupted recovery preserve funds and restore usable retry controls.
- Optional metadata disappears before payment (no spend if preflight refuses)
  and after payment (funded state remains recoverable). Retries with saved
  funds do not spend twice. Assert balances, retained notes and published
  events, not just error messages.

Run `npm run typecheck`, `npm test`, `npm run build` and the repository hygiene
gate. Record local, CI and device evidence separately. Roll out the new route
to fresh wallets first, then offer existing users an explicit transition with
old-wallet access. Rollback restores defaults while retaining both wallets
and routes. Merging, deployment and app release require a release instruction.

## Moving to the v2 federations (2026-11-10)

Jet confirmed the new BLF invite above in Fedi, and reported the shutdown
notices each federation shows in Fedi. All of these close on 2026-12-15:

| Federation | ID | Successor named in Fedi | Chama routes its people to |
|---|---|---|---|
| Bitcoin Life Federation (first) | `888b70ec…` | the new BLF | new BLF |
| Global Bitcoin Federation | `1bcb64e6…` | none (going private) | new BLF |
| Bitcoin Principles | `b21068c8…` | none | new BLF |
| Orange Club Africa | `718e421b…` | none | new BLF |
| LatNet | `7c1edc0c…` | Freedom Money `63bfb99b…` | Freedom Money |

Liberty Tree (closing 2026-12-04) is a test federation and is not in the app.
Afribit Kibera and Bitsacco have announced nothing and are unchanged. The
other public Fedi routes (Victoria BTC, Marigold, E-Cash Club, Bitcoinomad,
BTC Brasil, Freedom One) are unchanged until their status is known.

What the app does (one release, Jet's decision 2026-11-10):

- **New use goes to the v2 routes.** Every community whose federation is
  closing now points at its successor (`federationInvite`), and keeps the
  closing federation as `historicalFederationInvite`. The universal fallback
  is the new BLF. Pickers offer no closing federation.
- **Signed trades never move.** `effectiveCreateFederationId` and listing
  resolution read a community slug through `communityWireInvite`, which
  returns the historical invite. An unstamped `us-blf` listing still means the
  first BLF, as it does on 6.4.34, so two versions never disagree about where
  a trade's sats are. New listings stamp `fed` and `mintUrl`, which win.
- **No new sats on a closing federation.** Creating a listing while the
  wallet is on one is refused (no sats move at create). `preflightLock` refuses
  new funding on a trade or wallet on one, before any invoice, spend or Fedi
  generate. After sats have moved (a paid invoice, a resumed lock), the lock
  goes ahead so the sats reach escrow and settle rather than sit in a wallet.
- **People move with their community.** On next start, a person whose home
  community now points elsewhere goes through the existing reconcile guard: an
  empty wallet switches; a balance, or an unknown one, stops and asks, and the
  old wallet is kept. Country shells the picker saved on a device are read the
  same way; a community someone added by hand is never repointed.
- **Every place sats sit says until when.** Home and Me show "This federation
  closes on 15 December 2026. Send these sats out before then." beside a
  balance or kept wallet on a closing federation (en, es, fr, sw).

Not in this change: an in-app transfer of balances between federations, a
notice inside an open trade on a closing federation, and anything for sats
still locked on the old BLF in the Sep 17 / Oct 3 trades that could not be
loaded (see project notes). Older app versions show a new-BLF listing as "not
on Chama's list" and ask before joining; they route it correctly by its `fed`.
