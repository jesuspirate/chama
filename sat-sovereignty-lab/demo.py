"""Run with `python3 demo.py` or `python3 demo.py --json`. No dependencies."""
import argparse
import json

from model import FederationReference, Network, Rejected


def scenario():
    n = Network()
    events = []

    def record(action, operation):
        try:
            outcome = str(operation())
            status = "ok"
        except Rejected as exc:
            outcome = str(exc)
            status = "rejected"
        events.append({"action": action, "status": status, "outcome": outcome})

    for operator in ("maple", "cedar"):
        n.add_operator(operator)
        n.fund("alice", operator, 50_000, 10_000)
        n.fund("bob", operator, 10_000, 50_000)

    record("Alice pays Bob 2,000 sats through Maple",
           lambda: n.pay("coffee", "alice", "bob", "maple", 2_000))
    record("Retry the same completed payment",
           lambda: n.pay("coffee", "alice", "bob", "maple", 2_000))
    n.set_online("maple", False)
    record("Attempt payment through offline Maple",
           lambda: n.pay("offline", "alice", "bob", "maple", 1_000))
    record("Pay using separate, already funded Cedar channels",
           lambda: n.pay("backup-route", "alice", "bob", "cedar", 1_000))
    n.set_online("cedar", False)
    record("Attempt payment with every operator offline",
           lambda: n.pay("total-outage", "alice", "bob", "cedar", 1_000))
    f = FederationReference()
    f.online = 0
    record("Reference federation: redeem without guardians", f.redeem)
    for operator in n.operators:
        record(f"Alice starts independent exit from {operator}",
               lambda op=operator: n.force_close("alice", op))
    record("Try to claim before the modeled delay",
           lambda: n.claim("alice", "maple"))
    n.mine(144)
    for operator in n.operators:
        record(f"Alice claims after 144 synthetic blocks: {operator}",
               lambda op=operator: n.claim("alice", op))
    n.check()
    return {"notice": "SIMULATION ONLY: no bitcoin, signatures, HTLCs or real chain",
            "events": events, "final_state": n.snapshot()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Print reproducible trace")
    args = parser.parse_args()
    report = scenario()
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("SAT SOVEREIGNTY LAB\n" + report["notice"] + "\n")
        for i, event in enumerate(report["events"], 1):
            print(f"{i:2}. {event['action']}\n    {event['status']}: {event['outcome']}")
        state = report["final_state"]
        print(f"\nAlice recovered: {state['user_onchain_sats']['alice']:,} sats")
        print(f"Modeled exit fees: {state['modeled_exit_fees_sats']:,} sats")
        print("All operators remain offline. Accounting invariant holds.")
