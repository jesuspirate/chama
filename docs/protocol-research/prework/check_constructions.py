"""Executable design counterexamples; NOT a Bitcoin wallet or consensus test.

Uses abstract spend predicates and illustrative secp256k1 group arithmetic.
Fixed scalars are public test fixtures. No networking, keys, wallets, or funds.
Run: python3 check_constructions.py
"""

from hashlib import sha256
from itertools import combinations, permutations
import unittest

P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)


def add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    x, y = a
    u, v = b
    if x == u and (y + v) % P == 0:
        return None
    slope = ((3 * x * x) * pow(2 * y, -1, P) if a == b
             else (v - y) * pow(u - x, -1, P)) % P
    rx = (slope * slope - x - u) % P
    return rx, (slope * (x - rx) - y) % P


def mul(k, point=G):
    k %= N
    result = None
    while k:
        if k & 1:
            result = add(result, point)
        point = add(point, point)
        k >>= 1
    return result


def hash_point(message):
    # Generic try-and-increment fixture, not Cashu's wire hash-to-curve.
    x = int.from_bytes(sha256(message).digest(), "big") % P
    while True:
        y2 = (x**3 + 7) % P
        y = pow(y2, (P + 1) // 4, P)
        if y * y % P == y2:
            return x, y
        x = (x + 1) % P


def interpolate_at_zero(shares):
    result = 0
    for i, yi in shares:
        coefficient = 1
        for j, _ in shares:
            if j != i:
                coefficient = coefficient * (-j) * pow(i - j, -1, N) % N
        result = (result + yi * coefficient) % N
    return result


def challenge(rpoint, pubkey, message):
    tag = sha256(b"BIP0340/challenge").digest()
    data = rpoint[0].to_bytes(32, "big") + pubkey[0].to_bytes(32, "big") + message
    return int.from_bytes(sha256(tag + tag + data).digest(), "big") % N


class ConstructionChecks(unittest.TestCase):
    def test_group_fixture(self):
        self.assertIsNone(mul(N))
        self.assertEqual(add(G, G), mul(2))
        self.assertEqual(add(mul(11), mul(17)), mul(28))

    def test_mature_refund_can_win(self):
        # Abstract age model, deliberately well beyond the exact BIP68 boundary.
        deposit_height, delay, candidate_height = 100, 20, 130
        self.assertGreaterEqual(candidate_height - deposit_height, delay)
        winners = {ordering[0] for ordering in permutations(("payment", "old_refund"))}
        self.assertIn("old_refund", winners)
        print("COUNTEREXAMPLE: a matured old-owner refund can confirm before payment")

    def test_quorum_and_previous_owner_can_conflict_before_timeout(self):
        required = {"Alice", "quorum"}
        colluders = {"Alice", "quorum"}
        self.assertTrue(required <= colluders)
        self.assertNotIn("Bob", required)
        # Both spends can receive every required signature on the original input.
        for destination in ("Bob", "Alice"):
            self.assertTrue(required <= colluders, destination)
        print("COUNTEREXAMPLE: Alice + quorum can authorize two undelayed spends")

    def test_public_cashu_tweaks_allow_conversion(self):
        secret, low_tweak, high_tweak = 1234567, 19, 701
        ypoint = hash_point(b"public demonstration token secret")
        low_signature = mul(secret + low_tweak, ypoint)
        # Attacker calculation knows only low_signature, public tweaks and Y.
        forged_high = add(low_signature, mul(high_tweak - low_tweak, ypoint))
        self.assertEqual(forged_high, mul(secret + high_tweak, ypoint))
        print("COUNTEREXAMPLE: public additive denomination tweaks allow conversion")

    def test_refresh_keeps_old_quorum_authorized(self):
        secret, old_slope, refresh_slope = 1234567, 83, 991
        old = [(i, (secret + old_slope * i) % N) for i in (1, 2, 3)]
        new = [(i, (y + refresh_slope * i) % N) for i, y in old]
        for pair in combinations(old, 2):
            self.assertEqual(interpolate_at_zero(pair), secret)
        for pair in combinations(new, 2):
            self.assertEqual(interpolate_at_zero(pair), secret)
        print("COUNTEREXAMPLE: retained old threshold still reconstructs unchanged key")

    def test_reachability_is_not_spend_consensus(self):
        # Each 2-of-3 quorum can reach t-1 peers. Their intersection is Byzantine.
        q1, q2, malicious = {1, 2}, {2, 3}, {2}
        self.assertEqual(len(q1), 2)
        self.assertEqual(len(q2), 2)
        self.assertTrue(q1 & q2 <= malicious)
        print("COUNTEREXAMPLE: two reachable quorums can certify conflicting spends")

    def test_extra_exit_bypasses_contract_refund_deadline(self):
        age, exit_delay, height, refund_height = 25, 20, 130, 200
        self.assertTrue(age >= exit_delay)
        self.assertFalse(height >= refund_height)

    def test_whole_output_refund_to_each_contributor_races(self):
        payouts = {"Alice": {"Alice": 100, "Bob": 0},
                   "Bob": {"Alice": 0, "Bob": 100}}
        for first in payouts:
            other = "Bob" if first == "Alice" else "Alice"
            self.assertEqual(payouts[first][other], 0)

    def test_fixed_split_refund_has_same_outputs_for_either_broadcaster(self):
        # Abstract transaction commitment, not a signature or script verification.
        outputs = (("Alice", 49), ("Bob", 49))
        for broadcaster in ("Alice", "Bob", "watcher"):
            self.assertEqual(sum(value for _, value in outputs), 98, broadcaster)

    def test_confirmed_transfer_removes_old_outpoint(self):
        utxos = {"alice:0": {"Alice", "quorum"}}
        del utxos["alice:0"]
        utxos["bob:0"] = {"Bob"}
        self.assertNotIn("alice:0", utxos)
        self.assertFalse(utxos["bob:0"] <= {"Alice", "quorum"})

    def test_equivocation_extracts_dedicated_oracle_key(self):
        # Intentional repeated nonce ONLY to illustrate equivocation accountability.
        # Never use this code or these constants for operational signing.
        x, nonce = 987654321, 1122334455
        pubkey, rpoint = mul(x), mul(nonce)
        if pubkey[1] % 2:
            x, pubkey = N - x, mul(N - x)
        if rpoint[1] % 2:
            nonce, rpoint = N - nonce, mul(N - nonce)
        e1 = challenge(rpoint, pubkey, sha256(b"trade-1:release").digest())
        e2 = challenge(rpoint, pubkey, sha256(b"trade-1:refund").digest())
        s1, s2 = (nonce + e1 * x) % N, (nonce + e2 * x) % N
        self.assertEqual(mul(s1), add(rpoint, mul(e1, pubkey)))
        self.assertEqual(mul(s2), add(rpoint, mul(e2, pubkey)))
        extracted = (s1 - s2) * pow(e1 - e2, -1, N) % N
        self.assertEqual(mul(extracted), pubkey)
        self.assertEqual(extracted, x)
        print("CONSTRUCTION: conflicting same-nonce attestations expose dedicated key")

    def test_same_false_verdict_is_not_equivocation(self):
        signed_messages = {"trade-1:release"}
        self.assertEqual(len(signed_messages), 1)
        # The public transcript is identical whether the real-world delivery occurred.
        transcript_if_true = signed_messages.copy()
        transcript_if_false = signed_messages.copy()
        self.assertEqual(transcript_if_true, transcript_if_false)


if __name__ == "__main__":
    unittest.main(verbosity=2)
