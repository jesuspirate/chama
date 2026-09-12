# Sat Sovereignty Lab

A first design and executable failure model for community-run Bitcoin payments
where each user retains an independent path back to the chain.

**Status: design exploration and accounting simulation.** This is not a wallet,
mint, Lightning implementation, or working Bitcoin protocol. It generates no keys
or transactions and accepts no funds. The model demonstrates the proposed rules;
it cannot establish cryptographic security or real-world recoverability.

## The idea

Keep Fedimint's community-operated experience. Move the operators' responsibility
from custody to providing useful services: channel liquidity, routing, chain data,
monitoring, and encrypted backup storage. Users keep signing authority and current
channel recovery state. The initial settlement rail is ordinary Lightning.

The product innovation is an approachable community node app plus a wallet that
makes independence testable. It is not a new consensus algorithm or an invented
ecash scheme. If federated custody is actually the desired compromise, improving
Fedimint's onboarding is a more direct alternative; see [DESIGN.md](DESIGN.md).

## Run

Python 3.10 or newer; standard library only. From this directory:

```sh
python3 demo.py
python3 -m unittest -v
python3 demo.py --json
```

The scenario starts Alice with 100,000 simulated sats across two already funded
channels. She pays Bob 3,000, loses both operators, waits 144 synthetic blocks,
and recovers 96,000 after 1,000 of assumed total exit fees. Bob's channel claims
remain accounted for. A separate illustrative federation cannot redeem without
its guardian quorum.

The 144-block delay and 500-sat per-channel fee are scenario inputs, not quotes,
universal Lightning parameters, or a promise about time to recovery. Confirmation
latency, fee spikes, reorgs and in-flight payments are not modeled.

## Files

- [DESIGN.md](DESIGN.md): proposal, trust boundaries, alternatives, product flows,
  and the next milestone with real Bitcoin transactions.
- [model.py](model.py): liquidity accounting, completed payments, retries,
  operator outages, synthetic exits and value conservation.
- [test_model.py](test_model.py): failure cases and randomized payment sequences.
- [demo.py](demo.py): reproducible story and JSON trace.

## What the simulation assumes

Funding is injected as an explicit test fixture. A payment is one atomic operation
representing completed settlement; there is no HTLC handshake. Updating a version
counter stands in for safely persisting recovery state. The stale-state check
has omniscient access to the model and is not a real wallet recovery algorithm.
Closing assumes immediate commitment inclusion and charges one simplified fee.
Operator proceeds are credited alongside the user's matured claim for accounting
convenience. Every balance and payment is visible to the process: no privacy is
implemented.

The test suite checks accounting and application policy only. It does not test
signatures, punishment of revoked commitments, dust, channel reserves, backups,
concurrency, crashes, networking, Bitcoin consensus, or Lightning interoperability.
