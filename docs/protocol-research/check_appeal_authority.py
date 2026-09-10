"""Abstract authorization model, NOT a Bitcoin interpreter or wallet.

Model full transaction signatures as exact (key, transaction) authorizations.
Show the difference between panel-only authority and pre-signed fixed payouts.
All keys and transactions are symbolic strings. No real signatures are made.
"""

import unittest


def signatures_cover(required, transaction, live_keys, presigned):
    return all(key in live_keys or (key, transaction) in presigned
               for key in required)


def appeal_paths(transaction, age, delay, live_keys, presigned, constrained):
    paths = set()
    if age >= delay and "winner" in live_keys:
        paths.add("winner")
    if signatures_cover({"A", "B"}, ("cooperative", transaction), live_keys, presigned):
        paths.add("cooperative")
    panel_required = {"A", "B", "P"} if constrained else {"P"}
    if signatures_cover(panel_required, ("panel", transaction), live_keys, presigned):
        paths.add("panel")
    return paths


class AppealAuthority(unittest.TestCase):
    def setUp(self):
        self.templates = {("A", ("panel", "pay-A")), ("B", ("panel", "pay-A")),
                          ("A", ("panel", "pay-B")), ("B", ("panel", "pay-B"))}

    def test_original_panel_can_redirect_without_principals(self):
        paths = appeal_paths("pay-attacker", 0, 144, {"P"}, set(), False)
        self.assertIn("panel", paths)

    def test_panel_path_does_not_expire_when_winner_path_opens(self):
        for constrained in (False, True):
            paths = appeal_paths("pay-B", 200, 144, {"P", "winner"},
                                 self.templates, constrained)
            self.assertIn("winner", paths)
            self.assertIn("panel", paths)

    def test_constrained_panel_can_complete_either_fixed_outcome(self):
        for transaction in ("pay-A", "pay-B"):
            paths = appeal_paths(transaction, 0, 144, {"P"}, self.templates, True)
            self.assertEqual(paths, {"panel"})

    def test_panel_with_one_principal_cannot_redirect(self):
        for live_keys in ({"P"}, {"A", "P"}, {"B", "P"}):
            paths = appeal_paths("pay-attacker", 0, 144, live_keys,
                                 self.templates, True)
            self.assertEqual(paths, set())

    def test_signature_scope_must_include_parent_and_leaf(self):
        signed = {("A", ("parent-A", "appeal", "pay-B")),
                  ("B", ("parent-A", "appeal", "pay-B"))}
        self.assertTrue(signatures_cover({"A", "B", "P"},
                        ("parent-A", "appeal", "pay-B"), {"P"}, signed))
        for different in (("parent-B", "appeal", "pay-B"),
                          ("parent-A", "coop", "pay-B"),
                          ("parent-A", "appeal", "pay-attacker")):
            self.assertFalse(signatures_cover({"A", "B", "P"},
                             different, {"P"}, signed))

    def test_winner_needs_maturity_but_panel_does_not(self):
        self.assertEqual(appeal_paths("pay-A", 100, 144, {"winner"}, set(), True), set())
        self.assertEqual(appeal_paths("pay-A", 200, 144, {"winner"}, set(), True), {"winner"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
