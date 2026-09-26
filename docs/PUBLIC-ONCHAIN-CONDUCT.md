# Public on-chain conduct proofs

New on-chain CREATEs advertise `onchainPublicConduct`. Their signed VOTE,
RESOLVE, SETTLEMENT and SETTLEMENT_STALLED events carry a `conduct` tag with
the minimal public protocol payload. Votes disclose outcome, role, timestamp
and the payout proposal/signature, not share envelopes, reasons or chat.
Bitcoin payout destinations and signatures become publicly linked to these
trade identities. The funding screen states this before funding.

Existing encrypted trades are not republished or decrypted for outsiders.
Their missing public history is unknown, not zero and not an accusation.

Public records use a separate relay read and public replay. They never use the
viewer's decrypted trade cache or ratings. Nostr signatures are verified afresh;
a cached verification flag on a JavaScript object is not authority. A mark
requires the other principal's signed RELEASE, a winner-authored payout for
the same transaction, and a confirmed chain spend whose actual input witnesses
use the recomputed dispute script. A signed dispute PSBT or COMPLETE alone
cannot create a mark. Marks have no time-based expiration.

Discovery is bounded at 100 trades and 500 events per read. Timeouts, truncated
reads, missing public history and unknown chain reads are reported as incomplete.
A positive verified mark is still shown as “at least N” when other history is
unknown. Incomplete history never becomes a zero count or an endorsement.

Standing uses this same public replay. Seller speed is the median from a buyer's
signed RELEASE to the seller's valid Bitcoin signature; arbiter speed is the
median from the second disagreeing principal vote to the arbiter's signed vote.
Responses must reference the earlier event directly or through the signed
chain. These are event-timestamp measurements, not a trusted relay receipt
clock. Fewer than three samples or incomplete history suppresses the median.

Bond amounts come from verified active deposits, deduplicated by address. Age
uses the confirmed funding transaction's block time and the explorer tip's block
time. Missing timestamps suppress the age. Settled counts require confirmed
cooperative/dispute spends. A completed, empty public discovery with no bond
history says “New here”; failed or private history says “Public history
unavailable.” No ratings or local observed-trade counts enter these facts.
