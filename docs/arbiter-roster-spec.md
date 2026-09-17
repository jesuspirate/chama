# The Arbiter Roster — public, vouched, chosen (spec, for design review)

Status: SPEC ONLY. Post-6.5 work. No money-path change: arbitration
mechanics (2-of-3, escalation windows, chama mechanical healing) are
untouched — this spec is about how arbiters are FOUND, TRUSTED, and
CHOSEN.

## The trust insight (Jet, 2026-09-16)

People feel safe with an arbiter they can recognize or that someone they
know can vouch for. A history-less, swappable npub inspires none of that
— and no protocol can fix it by grabbing identity. The principle:

  CODE VERIFIES CONDUCT; ONLY HUMANS VOUCH FOR CHARACTER.
  The protocol carries the human layer faithfully; it never fakes it.

The bootstrap of the vouch graph is real-life contact — community
leaders, public faces, people who volunteer to do the right thing where
everyone can see them. That recruitment is human work, done in person.
The spec's job is to make sure that when such a person raises their hand,
the raising is public, the record is unfakeable, and choosing them is
easy.

## The ladder (how reputation exists before arbitration does)

The cold-start dilemma — "how do you earn arbitration reputation without
arbitrating?" — dissolves on the rungs Chama already built:

1. THE BOND. Reputation you cannot yet perform, collateralized instead.
   Visible commitment, already shipped.
2. CIRCLE HEALING. The chama arbiter cannot steal, cannot judge, cannot
   block — so serving circles is arbitration work with zero trust
   required. Every healing vote is on the chain: count, latency,
   communities served. A liveness résumé anyone can recompute.
3. SMALL TRADES. Pool arbitration on modest amounts, building a resolved-
   disputes record.
4. MUTUAL SELECTION. Buyer and seller agree on a named arbiter for the
   trades that matter. The top of the ladder is being ASKED FOR.

## The roster (a derived view, never a server)

- APPLICATION = a replaceable Nostr event ("arbiter-offer"): pubkey,
  communities served, bond reference, languages, a short statement.
  Publishing it IS applying; deleting it is withdrawing. Philosophy rule
  3 satisfied: the community can staff itself from nothing secret.
- VOUCH = an event signed by someone staking their own standing:
  "I know this person." Vouches display by the voucher's NAME and their
  own record. A vouch from a bonded, high-standing member weighs what its
  author weighs — the graph is the vet, exactly as in real life.
- THE ROSTER = every client's local render of offers + chain facts. Per
  arbiter it shows a RECORD, not a rating: bond size and age, healings
  served and median latency, disputes resolved, cycles served, vouches by
  name, external identity when present (nip-05 etc. — DISPLAYED, never
  law).
- NO STAR RATINGS. Stars are buyable, brigadable, and anonymous; records
  are none of those. Circles already replaced 👍 with standing; the
  roster is the same doctrine. You shop by reading history, not reviews.

## Mutual selection (almost free in the protocol)

A trade created with a single-entry arbiter pool IS the offer of that
arbiter; the counterparty locking IS the agreement. Deltas: the create
flow gains "choose your arbiter" (roster picker, guided one question);
the trade card shows the named arbiter up front — who is watching the
money, philosophy rule 4. Fallback unchanged: no choice → community pool,
deterministic pick, exactly today.

## Easy is the law of the arbiter surface (Jet: "easy for anyone")

The arbiter experience follows the guided doctrine — simple questions,
best options, move along:

- A dispute PINGS the arbiter with one screen: what each side says, what
  the evidence shows, two buttons. Chat if they need more. Vote. Done.
- Mechanical duties (circle healings, expiry refunds) are one tap or
  fully automatic with consent — the watcher already does the work; the
  arbiter's client just needs their key present.
- Identical surface whatever the rail — ecash, Lightning, on-chain: the
  vote is the vote. The rail is plumbing, never vocabulary (rule 2).
- Becoming an arbiter is a guided flow too: three questions (who are
  you, which communities, how much bond), publish, appear on the roster.

## Decisions (Jet, 2026-09-17 — all four sealed)

1. VOUCH LIFECYCLE: BOTH mechanisms. An explicit un-vouch event for
   changed minds — loud, dated, and the "vouched March, revoked
   September" history is itself roster information. Decay for absent
   vouchers — weight fades with age unless re-signed, so a living
   relationship stays heavy and a stale one thins out on its own.
2. THE BOND STAYS, even for mutually chosen arbiters. Both principals
   evaluate the whole record: bond, conduct, and the arbiter's own
   standing as a circle member where applicable. And to be explicit:
   arbiters are RECORDED, never rated. Trade 👍 is buyer↔seller by
   construction, and no third rating box is added — a losing party would
   one-star every honest ruling. The arbiter's reputation = healings
   served (count + median latency), escalations answered vs slept
   through, disputes resolved, bond size and age, own circle standing,
   vouches by name. Conduct record + vouch graph, zero stars.
3. FEES: PUBLISHED IN THE OFFER — the roster is a MARKETPLACE. "Come for
   the sats, stay for the people" is the literal community recruiting
   pitch. Fee is paid ON DISPUTE ONLY: the happy path costs nothing, the
   arbiter earns exactly when they work. Rails: ecash/LN ride the
   existing arbiterFeeMsats + PREMIUM settlement machinery (chama shares
   stay pinned to zero forever). On-chain direction to explore: an
   outcome-dependent fee output present in the dispute taproot leaf and
   absent from the cooperative leaf (Jet's instinct, and exactly how
   taproot wants outcome-based costs expressed).
4. THE ROSTER LIVES IN BOTH PLACES: in-app, and as a public page on
   getchama.app — the recruiting surface for real-life conversations
   ("look yourself up").

Addenda (Jet, 2026-09-17):
- CONSENT SURFACING: vouch weights, decay, and revocation history must be
  presented simply at every decision point — a user choosing an arbiter
  makes a consensual, informed choice every time, for as long as they are
  live in the app. Never a buried tooltip.
- PREMIUM DOCTRINE: the arbiter is sold as INSURANCE, priced as a
  deductible — premiums on DISPUTES ONLY. Today's protocol carries both
  "ambient" (happy-path, paid at settlement) and "dispute" premium kinds;
  when roster fees land, ambient premiums retire for roster-priced trades
  and the dispute premium becomes the fee vehicle. Chama circle shares
  stay zero-fee forever; ordinary trade DISPUTE fees are live machinery
  today (arbiterFeeMsats + PREMIUM kind "dispute"), not something to
  enable.
