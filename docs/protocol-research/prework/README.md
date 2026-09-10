# Chama / Hourglass design work

Start with [the security review](SECURITY-REVIEW.md) and [the proposed settlement redesign](CHAMA-SETTLEMENT-DESIGN.md).

Chama is now cloned at `/home/satoshi/Work/chama`. Read [the source-grounded code map](CHAMA-CODE-MAP.md) for the existing implementation, what can be reused, and the revised migration recommendation.

The original [Hourglass v0.1 draft](HOURGLASS-SPEC.md) is preserved as supplied. It contains critical security flaws and should not be implemented as written.

Run the illustrative counterexamples and algebra checks:

```sh
python3 check_constructions.py
```

These checks do not execute Bitcoin Script or establish production security. Chama source was unavailable for the initial review and was subsequently cloned and inspected as documented in the code map; no Chama integration or regtest validation is claimed.
