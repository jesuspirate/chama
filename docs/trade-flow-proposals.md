# Trade-flow protocol proposals — 2026-10-06

These are proposals only. This fixes branch retains the existing seat deadlines and bond scripts.

## Mutual cancel and eject before funding

Give each seated buyer and seller two explicit pre-funding actions: leave their own seat, or eject the other party. Each action would publish a signed event naming the current seat's JOIN event, so delayed events cannot eject a replacement participant. A seller's open offer can remain available for a new buyer; a new buyer must choose an amount and agree to the terms.

This needs a versioned protocol decision: who may eject whom, what replaces automatic abandonment expiry, and how old clients behave. Once an invoice or deposit has been prepared, an unknown or arriving payment must block seat replacement until that funding attempt is resolved. After LOCK, neither action may delete a participant or unwind custody: the existing refund and settlement rules still apply. Test two devices, simultaneous ejections, delayed events, and payment arriving after cancellation before considering adoption.

## Add more to an existing bond

Keep “Post an additional bond” as the available action now. It creates a separately identifiable bond and does not extend or replace the current bond. Renew remains a separate action after the existing term ends.

A live-bond top-up requires a separate specification. Sending another output to the same existing script preserves its original unlock height; extending that height requires spending into a new script and rebuilding the announcement and lineage. These are materially different choices. A future flow must state the amount and unlock height before signing, prove the live inputs on-chain, preserve the original bond on failure, and reconcile a broadcast whose acknowledgement is lost. Do not silently renew an active bond while labeling it “add more.”
