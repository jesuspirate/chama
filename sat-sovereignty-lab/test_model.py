import random
import unittest

from demo import scenario
from model import FederationReference, Network, Rejected


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.n = Network()
        self.n.add_operator("one")
        self.n.fund("alice", "one", 50_000, 50_000)
        self.n.fund("bob", "one", 50_000, 50_000)

    def pay(self, payment_id="p", sats=1_000):
        return self.n.pay(payment_id, "alice", "bob", "one", sats)

    def test_payment_conservation_and_idempotence(self):
        self.pay()
        state = self.n.snapshot()
        self.assertEqual(self.pay(), "already settled")
        self.assertEqual(state, self.n.snapshot())
        self.assertEqual(self.n.channel("alice", "one").local, 49_000)
        self.assertEqual(self.n.channel("bob", "one").local, 51_000)
        with self.assertRaises(Rejected):
            self.pay(sats=2_000)
        self.assertEqual(state, self.n.snapshot())

    def test_failure_does_not_mutate_balances(self):
        for amount in (-1, 0, True, 1.5, 50_001):
            with self.subTest(amount=amount):
                state = self.n.snapshot()
                with self.assertRaises(Rejected):
                    self.pay(sats=amount)
                self.assertEqual(state, self.n.snapshot())

    def test_recipient_liquidity_failure_is_atomic(self):
        self.n.fund("carol", "one", 20_000, 100)
        state = self.n.snapshot()
        with self.assertRaisesRegex(Rejected, "inbound"):
            self.n.pay("p", "alice", "carol", "one", 101)
        self.assertEqual(state, self.n.snapshot())

    def test_exit_without_operator_and_delay_and_double_claim(self):
        self.n.set_online("one", False)
        with self.assertRaises(Rejected):
            self.pay()
        self.n.force_close("alice", "one", fee=500, delay=144)
        self.n.mine(143)
        with self.assertRaises(Rejected):
            self.n.claim("alice", "one")
        self.n.mine(1)
        self.assertEqual(self.n.claim("alice", "one"), 49_500)
        state = self.n.snapshot()
        with self.assertRaises(Rejected):
            self.n.claim("alice", "one")
        self.assertEqual(state, self.n.snapshot())

    def test_closing_channel_cannot_pay_or_close_again(self):
        self.n.force_close("alice", "one")
        with self.assertRaises(Rejected):
            self.pay()
        with self.assertRaises(Rejected):
            self.n.force_close("alice", "one")

    def test_stale_recovery_state_blocks_unsafe_actions(self):
        self.pay()
        self.n.channel("alice", "one").recoverable_version = 0
        with self.assertRaisesRegex(Rejected, "stale"):
            self.n.force_close("alice", "one")
        with self.assertRaisesRegex(Rejected, "recovery"):
            self.pay("next")

    def test_exit_economics(self):
        state = self.n.snapshot()
        with self.assertRaisesRegex(Rejected, "uneconomic"):
            self.n.force_close("alice", "one", fee=50_000)
        self.assertEqual(state, self.n.snapshot())

    def test_randomized_payments_preserve_money(self):
        rng = random.Random(42)
        for i in range(1_000):
            sender, recipient = rng.sample(["alice", "bob"], 2)
            before = self.n.snapshot()
            try:
                self.n.pay(str(i), sender, recipient, "one", rng.randint(1, 60_000))
            except Rejected:
                self.assertEqual(before, self.n.snapshot())
            self.n.check()

    def test_federation_reference_needs_quorum(self):
        f = FederationReference()
        f.online = 2
        with self.assertRaises(Rejected):
            f.redeem()
        f.online = 3
        self.assertEqual(f.redeem(), 50_000)
        self.assertEqual(f.redeem(), 0)

    def test_demo_expected_outcome(self):
        report = scenario()
        self.assertEqual(report["final_state"]["user_onchain_sats"]["alice"], 96_000)
        self.assertEqual(report["final_state"]["modeled_exit_fees_sats"], 1_000)
        self.assertFalse(any(report["final_state"]["operators"].values()))
        self.assertEqual(sum(e["status"] == "rejected" for e in report["events"]), 4)


if __name__ == "__main__":
    unittest.main()
